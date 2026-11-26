// ELEMENT 118 SHEET → 3D（Phase 1：規格シートの読み込み・解析／Phase 2：Visual Hull と重ね合わせ比較）
// 画像解析＋幾何計算のみ（AI・外部API・GPUサーバー不使用）。
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { buildHull, type HullResult } from './hull';
import { loadImage, type SourceImage } from './mask';
import { denorm, fillMissingJoints, parseSheet1, parseSheet2, RIGHT_MARKER_KEYS, SHEET2_ROI, type DebugItem, type DebugMarker, type Joints, type PartId, type Sheet1, type Sheet2, type ViewId } from './sheetParse';
import { ALL_JOINTS, BONES, MARKERS, markerOf, PART_IDS_ALL, rgbHex, SHEET1_CELLS, type JointId } from './sheetSpec';

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const VIEW_IDS: ViewId[] = ['front', 'right', 'back', 'left', 'top'];
const VIEW_LABEL: Record<ViewId, string> = { front: 'FRONT', right: 'RIGHT', back: 'BACK', left: 'LEFT', top: 'TOP' };

const state = {
  img1: null as HTMLCanvasElement | null,
  img2: null as HTMLCanvasElement | null,
  src1: '', src2: '', // 入力画像の識別（ファイル名・サイズ）
  sameInput: false,
  s1: null as Sheet1 | null,
  s2: null as Sheet2 | null,
  joints: null as Joints | null,
  detected: null as Joints | null,
  hull: null as HullResult | null,
};

// ------------------------------------------------------------------ 3D
const stage = $('#stage');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
stage.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0e131a);
// 設計図との比較が目的なので正投影カメラ（遠近感なし）
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -50, 50);
scene.add(new THREE.HemisphereLight(0xe6efff, 0x2a2018, 1.6));
const key = new THREE.DirectionalLight(0xffffff, 1.8); key.position.set(2, 3, 4); scene.add(key);
const grid = new THREE.GridHelper(2, 20, 0x2b3a4a, 0x18212c);
scene.add(grid);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.enablePan = false;
controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_ROTATE };

const root = new THREE.Group(); // 表示物はすべてこの中（作り直すたびに中身を入れ替える）
scene.add(root);
const hullMat = new THREE.MeshStandardMaterial({ color: 0x9fb4c8, roughness: 0.8, metalness: 0, side: THREE.FrontSide });
let hullMesh: THREE.Mesh | null = null;
const jointGroup = new THREE.Group(); root.add(jointGroup);
const boneGroup = new THREE.Group(); root.add(boneGroup);
const overlays: Partial<Record<ViewId, THREE.Mesh>> = {};
let activeView: ViewId | null = null;

let viewHalf = 0.7; // 正投影の表示範囲（半分の高さ）
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false);
  const a = w / h;
  camera.left = -viewHalf * a; camera.right = viewHalf * a; camera.top = viewHalf; camera.bottom = -viewHalf;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);
resize();
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });

const VIEW_DIR: Record<ViewId | 'home', [number, number, number]> = {
  front: [0, 0, 1], right: [-1, 0, 0], back: [0, 0, -1], left: [1, 0, 0], top: [0, 1, 0], home: [-0.6, 0.35, 1],
};
function setView(v: ViewId | 'home') {
  const W = state.hull?.W ?? 1, D = state.hull?.D ?? 0.5;
  const center = new THREE.Vector3(0, v === 'top' ? 0.5 : 0.5, 0);
  const dir = new THREE.Vector3(...VIEW_DIR[v]).normalize();
  camera.up.set(0, 1, 0);
  if (v === 'top') camera.up.set(0, 0, -1); // 上面図は「正面が画面の下」
  camera.position.copy(center).addScaledVector(dir, 10);
  controls.target.copy(center);
  const span = v === 'top' ? Math.max(W, D * stage.clientWidth / stage.clientHeight) : v === 'front' || v === 'back' ? Math.max(1, W * stage.clientHeight / stage.clientWidth) : 1;
  viewHalf = span * 0.56;
  camera.zoom = 1;
  resize();
  controls.update();
  activeView = v === 'home' ? null : v;
  document.querySelectorAll<HTMLButtonElement>('#views button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  updateOverlay();
}
document.querySelectorAll<HTMLButtonElement>('#views button').forEach(b => { b.onclick = () => setView(b.dataset.view as ViewId); });
// 指で回したら重ね合わせは消す（正面などの比較はボタンで）
controls.addEventListener('start', () => {
  if (!activeView) return;
  activeView = null;
  document.querySelectorAll<HTMLButtonElement>('#views button').forEach(b => b.classList.remove('on'));
  updateOverlay();
});

function updateOverlay() {
  const show = ($('#tOverlay') as HTMLInputElement).checked;
  const op = parseFloat(($('#overlayOpacity') as HTMLInputElement).value);
  for (const id of VIEW_IDS) {
    const o = overlays[id];
    if (!o) continue;
    o.visible = show && activeView === id;
    (o.material as THREE.MeshBasicMaterial).opacity = op;
  }
  const iouEl = $('#iou');
  const v = activeView ? state.hull?.iou[activeView] : undefined;
  iouEl.hidden = !(activeView && v !== undefined);
  if (activeView && v !== undefined && v !== null) iouEl.textContent = `${VIEW_LABEL[activeView]} 一致度 ${(v * 100).toFixed(1)}%`;
}
['#tOverlay', '#overlayOpacity'].forEach(s => $(s).addEventListener('input', updateOverlay));
$('#tMesh').addEventListener('change', () => { if (hullMesh) hullMesh.visible = ($('#tMesh') as HTMLInputElement).checked; });
$('#tWire').addEventListener('change', () => { hullMat.wireframe = ($('#tWire') as HTMLInputElement).checked; });
$('#tJoint').addEventListener('change', () => { jointGroup.visible = ($('#tJoint') as HTMLInputElement).checked; });
$('#tBone').addEventListener('change', () => { boneGroup.visible = ($('#tBone') as HTMLInputElement).checked; });

/** 元のシルエット画像を、そのビューの位置に半透明の板として置く（比較用） */
function buildOverlays() {
  for (const id of VIEW_IDS) { const o = overlays[id]; if (o) { root.remove(o); (o.material as THREE.MeshBasicMaterial).map?.dispose(); o.geometry.dispose(); delete overlays[id]; } }
  const v = state.s1?.views; if (!v || !state.hull) return;
  const { W, D } = state.hull;
  const far = 2;
  const mk = (id: ViewId, src: SourceImage, w: number, h: number, place: (m: THREE.Mesh) => void) => {
    const tex = new THREE.CanvasTexture(src.canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.45, depthTest: false, depthWrite: false }));
    m.renderOrder = 10;
    place(m);
    m.visible = false;
    root.add(m);
    overlays[id] = m;
  };
  if (v.front) mk('front', v.front.src, v.front.src.w / v.front.src.h, 1, m => { m.position.set(0, 0.5, far); });
  if (v.back) mk('back', v.back.src, v.back.src.w / v.back.src.h, 1, m => { m.rotation.y = Math.PI; m.position.set(0, 0.5, -far); });
  if (v.right) mk('right', v.right.src, v.right.src.w / v.right.src.h, 1, m => { m.rotation.y = -Math.PI / 2; m.position.set(-far, 0.5, 0); });
  if (v.left) mk('left', v.left.src, v.left.src.w / v.left.src.h, 1, m => { m.rotation.y = Math.PI / 2; m.position.set(far, 0.5, 0); });
  if (v.top) mk('top', v.top.src, W, D, m => { m.rotation.x = -Math.PI / 2; m.position.set(0, far, 0); });
}

function buildJoints3D() {
  for (const g of [jointGroup, boneGroup]) while (g.children.length) {
    const c = g.children.pop() as THREE.Mesh;
    c.geometry.dispose(); (c.material as THREE.Material).dispose();
  }
  const J = state.joints; if (!J) return;
  const sphere = new THREE.SphereGeometry(0.014, 12, 8);
  for (const id of ALL_JOINTS) {
    const j = J[id];
    const m = new THREE.Mesh(sphere.clone(), new THREE.MeshBasicMaterial({ color: rgbHex(markerOf(id).rgb), depthTest: false }));
    m.renderOrder = 20;
    m.position.set(j.x, j.y, j.z);
    m.name = id;
    jointGroup.add(m);
  }
  sphere.dispose();
  const pts: number[] = [];
  for (const [a, b] of BONES) { const p = J[a], q = J[b]; pts.push(p.x, p.y, p.z, q.x, q.y, q.z); }
  const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.8 }));
  lines.renderOrder = 19;
  boneGroup.add(lines as unknown as THREE.Mesh);
}

// ------------------------------------------------------------------ 1. シートを選ぶ
async function fileToCanvas(f: Blob): Promise<HTMLCanvasElement> {
  const img = await loadImage(f);
  const c = document.createElement('canvas');
  // 解析には長辺 2400px あれば十分（iPhone のメモリ節約）
  const s = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
  c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return c;
}
async function setSheet(n: 1 | 2, blob: Blob) {
  const c = await fileToCanvas(blob);
  const name = (blob as File).name || (n === 1 ? 'sample_sheet1.png' : 'sample_sheet2.png');
  c.dataset.source = `SHEET ${n}`;
  if (n === 1) { state.img1 = c; state.src1 = `${name}（${c.width}×${c.height}）`; }
  else { state.img2 = c; state.src2 = `${name}（${c.width}×${c.height}）`; }
  ($('#prev' + n) as HTMLImageElement).src = URL.createObjectURL(blob);
  $('#drop' + n).classList.add('has');
  ($('#btnAnalyze') as HTMLButtonElement).disabled = !state.img1;
}
for (const n of [1, 2] as const) {
  $('#file' + n).addEventListener('change', async e => {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    if (f) { try { await setSheet(n, f); } catch (err) { toast('画像を読み込めません: ' + (err as Error).message); } }
    // 選択欄を空に戻す：同じ画像を選び直したときや、別ページから「戻る」で帰ったときも change が必ず起きるように
    input.value = '';
  });
}
$('#btnSample').onclick = async () => {
  try {
    const [a, b] = await Promise.all(['samples/e118_sheet1_sample.png', 'samples/e118_sheet2_sample.png'].map(u => fetch(u).then(r => { if (!r.ok) throw new Error(u); return r.blob(); })));
    await setSheet(1, a); await setSheet(2, b);
    analyze();
  } catch (err) { toast('サンプルを読み込めません: ' + (err as Error).message); }
};

// ------------------------------------------------------------------ 2. 解析
$('#btnAnalyze').onclick = analyze;
function analyze() {
  if (!state.img1) return;
  // 入力の取り違え防止：それぞれの解析には、それぞれの入力画像だけを渡す
  const in1 = state.img1, in2 = state.img2;
  state.sameInput = !!in2 && (in1 === in2 || fingerprint(in1) === fingerprint(in2));
  console.info('[sheet] SHEET1 source =', in1.dataset.source, state.src1, '/ SHEET2 source =', in2?.dataset.source, state.src2);
  state.s1 = parseSheet1(in1, 'SHEET 1');
  state.s2 = in2 ? parseSheet2(in2, 'SHEET 2') : null;
  // 関節の入力元は SHEET 2 だけ（SHEET 1 からは探さない）
  state.detected = state.s2 ? fillMissingJoints(state.s2.joints, state.s2.front?.src) : null;
  state.joints = state.detected ? structuredClone(state.detected) : null;
  renderResult();
  ['#secResult', '#secHull'].forEach(s => { $(s).hidden = false; });
  $('#secJoints').hidden = !state.joints;
  drawJointEditors();
  buildJoints3D();
  generateHull();
}

let previewMode: 'raw' | 'mask' | 'norm' = 'mask';
document.querySelectorAll<HTMLButtonElement>('#previewMode button').forEach(b => {
  b.onclick = () => {
    previewMode = b.dataset.v as typeof previewMode;
    document.querySelectorAll<HTMLButtonElement>('#previewMode button').forEach(x => x.classList.toggle('on', x === b));
    renderResult();
  };
});

/**
 * 解析デバッグ表示：シート全体に、見つけた塊すべての枠・中心点・判定を重ねる。
 *   緑系 = 採用（FRONT など）／赤 = 不採用（理由つき）／赤の点線 = 見つからなかったビュー（規格上の位置）
 *   ○ = 検出したマーカー（緑=採用・赤=不採用）／✕ = マーカーが見つからなかった関節（推定位置）
 */
function drawDebug(cv: HTMLCanvasElement, list: HTMLElement, sheet: HTMLCanvasElement | null, debug: DebugItem[], markers: DebugMarker[], missingViews: string[], missingJoints: { id: string; x: number; y: number }[], roiLines = false) {
  list.innerHTML = '';
  if (!sheet) { cv.width = 1; cv.height = 1; return; }
  const s = Math.min(1, 900 / sheet.width);
  cv.width = Math.round(sheet.width * s); cv.height = Math.round(sheet.height * s);
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#1a2230'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.globalAlpha = 0.7; ctx.drawImage(sheet, 0, 0, cv.width, cv.height); ctx.globalAlpha = 1;
  const fs = Math.max(10, Math.round(cv.width / 55));
  ctx.font = `bold ${fs}px sans-serif`;
  const tag = (x: number, y: number, t: string, col: string) => {
    const w = ctx.measureText(t).width + 6;
    ctx.fillStyle = 'rgba(0,0,0,0.8)'; ctx.fillRect(x, y - fs, w, fs + 4);
    ctx.fillStyle = col; ctx.fillText(t, x + 3, y);
  };
  if (roiLines) {
    // SHEET 2 の固定ROIの境界（40% / 60%）
    ctx.setLineDash([6, 4]); ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    for (const f of [SHEET2_ROI.front[1], SHEET2_ROI.right[1]]) { ctx.beginPath(); ctx.moveTo(f * cv.width, 0); ctx.lineTo(f * cv.width, cv.height); ctx.stroke(); }
    ctx.setLineDash([]);
    tag(4, cv.height - 6, 'JOINT FRONT ROI', '#fff'); tag(SHEET2_ROI.right[0] * cv.width + 4, cv.height - 6, 'JOINT RIGHT ROI', '#fff'); tag(SHEET2_ROI.ref[0] * cv.width + 4, cv.height - 6, 'REFERENCE（解析しない）', '#aaa');
  }
  for (const id of missingViews) {
    const c = SHEET1_CELLS.find(x => x.id === id);
    if (!c) continue;
    const x = c.x0 * cv.width, y = c.y0 * cv.height, w = (c.x1 - c.x0) * cv.width, h = (c.y1 - c.y0) * cv.height;
    ctx.setLineDash([8, 5]); ctx.lineWidth = 2.5; ctx.strokeStyle = '#ff2d3c'; ctx.strokeRect(x + 4, y + 4, w - 8, h - 8); ctx.setLineDash([]);
    tag(x + 8, y + fs + 8, `${id.toUpperCase()} 未検出（規格上の位置）`, '#ff2d3c');
  }
  for (const d of debug) {
    const col = !d.ok ? '#ff5d6c' : d.label.startsWith('PARTS') ? '#ffb547' : d.label.startsWith('JOINT') ? '#ff5dd6' : '#36e3c4';
    const x = d.box.x0 * s, y = d.box.y0 * s, w = (d.box.x1 - d.box.x0) * s, h = (d.box.y1 - d.box.y0) * s;
    ctx.setLineDash(d.ok ? [] : [4, 3]); ctx.lineWidth = d.ok ? 2.5 : 1.5; ctx.strokeStyle = col; ctx.strokeRect(x, y, w, h); ctx.setLineDash([]);
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x + w / 2, y + h / 2, 3, 0, Math.PI * 2); ctx.fill(); // 中心点
    if (d.ok) tag(x, y + fs, d.label.replace('PARTS:', ''), col);
  }
  for (const m of markers) {
    ctx.lineWidth = 2; ctx.strokeStyle = m.ok ? '#36e3c4' : '#ff5d6c';
    ctx.beginPath(); ctx.arc(m.x * s, m.y * s, Math.max(4, m.r * s + 2), 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle; ctx.beginPath(); ctx.arc(m.x * s, m.y * s, 1.5, 0, Math.PI * 2); ctx.fill();
    if (m.ok) { ctx.font = `bold ${Math.round(fs * 0.75)}px sans-serif`; ctx.fillStyle = '#fff'; ctx.fillText(m.label, m.x * s + m.r * s + 4, m.y * s + 3); ctx.font = `bold ${fs}px sans-serif`; }
  }
  for (const j of missingJoints) {
    const x = j.x * s, y = j.y * s, r = 6;
    ctx.lineWidth = 2.5; ctx.strokeStyle = '#ff2d3c';
    ctx.beginPath(); ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); ctx.stroke();
    ctx.font = `bold ${Math.round(fs * 0.75)}px sans-serif`; ctx.fillStyle = '#ff2d3c'; ctx.fillText(j.id, x + r + 2, y + 3); ctx.font = `bold ${fs}px sans-serif`;
  }
  // 判定の一覧（文字）
  const add = (ok: boolean, t: string) => { const d = document.createElement('div'); d.className = ok ? 'dok' : 'dng'; d.textContent = (ok ? '✓ ' : '✕ ') + t; list.appendChild(d); };
  for (const id of missingViews) add(false, `${id.toUpperCase()}：見つかりません`);
  for (const d of debug.filter(x => x.ok)) add(true, `${d.label}：${d.reason ?? ''}`);
  for (const j of missingJoints) add(false, `${j.id}：マーカーが見つかりません（✕は推定位置）`);
  for (const m of markers.filter(x => !x.ok)) add(false, `マーカー候補 ${m.label}：${m.reason}`);
  for (const d of debug.filter(x => !x.ok)) add(false, `候補（${Math.round(d.box.x0)},${Math.round(d.box.y0)} 幅${Math.round(d.box.x1 - d.box.x0)} 高${Math.round(d.box.y1 - d.box.y0)}px）：${d.reason ?? ''}`);
}

/** 画像の簡易指紋（縮小した画素の並び）。SHEET 1 と SHEET 2 に同じ画像を選んでいないかの確認用 */
function fingerprint(c: HTMLCanvasElement): string {
  const t = document.createElement('canvas'); t.width = 32; t.height = 18;
  const x = t.getContext('2d', { willReadFrequently: true })!;
  x.drawImage(c, 0, 0, 32, 18);
  const d = x.getImageData(0, 0, 32, 18).data;
  let h = 0;
  for (let i = 0; i < d.length; i += 4) h = (h * 31 + (d[i] >> 3) * 7 + (d[i + 1] >> 3) * 3 + (d[i + 2] >> 3) + (d[i + 3] >> 6)) | 0;
  return `${c.width}x${c.height}:${h}`;
}

/** 入力の確認：元画像2枚と、各ROI（どの入力から切り出したか）を並べる */
function renderInputs() {
  const box = $('#inputs'); box.innerHTML = '';
  const thumb = (src: HTMLCanvasElement | null | undefined, label: string, sub: string, cls = '') => {
    const fig = document.createElement('figure'); if (cls) fig.className = cls;
    const cv = document.createElement('canvas');
    if (src) {
      const k = Math.min(1, 320 / Math.max(src.width, src.height));
      cv.width = Math.max(1, Math.round(src.width * k)); cv.height = Math.max(1, Math.round(src.height * k));
      const ctx = cv.getContext('2d')!;
      ctx.fillStyle = '#26303d'; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(src, 0, 0, cv.width, cv.height);
    } else { cv.width = 1; cv.height = 1; fig.classList.add('miss'); }
    const cap = document.createElement('figcaption');
    cap.innerHTML = `<b>${label}</b><br>${sub}`;
    fig.append(cv, cap); return fig;
  };
  const row1 = document.createElement('div'); row1.className = 'inputRow';
  row1.append(thumb(state.img1, 'INPUT SHEET 1', state.src1 || '（未選択）'), thumb(state.img2, 'INPUT SHEET 2', state.src2 || '（未選択）'));
  box.appendChild(row1);
  if (state.sameInput) { const w = document.createElement('div'); w.className = 'bad'; w.textContent = '⚠ SHEET 1 と SHEET 2 に同じ画像が選ばれています。SHEET 2 を選び直してください'; box.appendChild(w); }
  const grid = document.createElement('div'); grid.className = 'viewGrid';
  for (const id of VIEW_IDS) grid.appendChild(thumb(state.s1?.views[id]?.raw, `SHEET 1 ${VIEW_LABEL[id]} ROI`, '元：INPUT SHEET 1', state.s1?.views[id] ? '' : 'miss'));
  // SHEET 2 は固定ROI（左40%・中央20%）の帯そのものと、そこから見つけた体
  const strip = (r: readonly [number, number]) => {
    if (!state.img2) return null;
    const c = document.createElement('canvas');
    const x0 = Math.round(r[0] * state.img2.width), x1 = Math.round(r[1] * state.img2.width);
    c.width = x1 - x0; c.height = state.img2.height;
    c.getContext('2d')!.drawImage(state.img2, x0, 0, c.width, c.height, 0, 0, c.width, c.height);
    return c;
  };
  grid.appendChild(thumb(strip(SHEET2_ROI.front), 'SHEET 2 JOINT FRONT ROI', '元：INPUT SHEET 2（左40%）', state.s2?.front ? '' : 'miss'));
  grid.appendChild(thumb(strip(SHEET2_ROI.right), 'SHEET 2 JOINT RIGHT ROI', '元：INPUT SHEET 2（中央20%）', state.s2?.right ? '' : 'miss'));
  box.appendChild(grid);
}

function renderResult() {
  renderInputs();
  const missingViews = VIEW_IDS.filter(id => !state.s1?.views[id]);
  drawDebug($('#reg1') as HTMLCanvasElement, $('#dbg1'), state.img1, state.s1?.debug ?? [], [], missingViews, []);
  const s2 = state.s2;
  const missingJ = s2 && s2.front && state.detected
    ? ALL_JOINTS.filter(id => !s2.joints[id]).map(id => { const d = denorm(s2.front!.src, state.detected![id].x, state.detected![id].y); return { id, x: s2.front!.box.x0 + d.px, y: s2.front!.box.y0 + d.py }; })
    : [];
  drawDebug($('#reg2') as HTMLCanvasElement, $('#dbg2'), state.img2, s2?.debug ?? [], s2?.markers ?? [], [], missingJ, true);
  const g = $('#viewGrid'); g.innerHTML = '';
  const W = state.s1?.views.front ? state.s1.views.front.src.w / state.s1.views.front.src.h : 1;
  const add = (label: string, view: { src: SourceImage; raw: HTMLCanvasElement } | undefined, kind: 'side' | 'top' | 'part' = 'side', partId?: PartId) => {
    const fig = document.createElement('figure');
    const cv = document.createElement('canvas');
    const src = view?.src;
    if (view && previewMode === 'raw') {
      const r = view.raw, s = Math.min(1, 240 / Math.max(r.width, r.height));
      cv.width = Math.max(1, Math.round(r.width * s)); cv.height = Math.max(1, Math.round(r.height * s));
      cv.getContext('2d')!.drawImage(r, 0, 0, cv.width, cv.height);
    } else if (src && previewMode === 'mask') {
      cv.width = src.w; cv.height = src.h;
      const ctx = cv.getContext('2d')!;
      const img = ctx.createImageData(src.w, src.h);
      for (let i = 0; i < src.w * src.h; i++) { const v = src.mask[i] ? 235 : 0; img.data[i * 4] = src.mask[i] ? 54 : 0; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = src.mask[i] ? 196 : 0; img.data[i * 4 + 3] = src.mask[i] ? 255 : 0; }
      ctx.putImageData(img, 0, 0);
    } else if (src && previewMode === 'norm') {
      // 正規化後：身長 = 100px にそろえ、足底線と中心軸を描く（どのビューも同じ尺度）
      const U = 110;
      cv.width = 170; cv.height = 136;
      const ctx = cv.getContext('2d')!;
      const dw = kind === 'top' ? W * U : (src.w / src.h) * U, dh = kind === 'top' ? (src.h / src.w) * W * U : U;
      const x = (cv.width - dw) / 2, y = kind === 'top' ? (cv.height - dh) / 2 : cv.height - 12 - dh;
      ctx.globalAlpha = 0.9; ctx.drawImage(src.canvas, x, y, dw, dh); ctx.globalAlpha = 1;
      ctx.strokeStyle = '#36e3c4'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cv.width / 2, 0); ctx.lineTo(cv.width / 2, cv.height); ctx.stroke();
      if (kind !== 'top') {
        ctx.strokeStyle = '#ffb547';
        ctx.beginPath(); ctx.moveTo(0, cv.height - 12); ctx.lineTo(cv.width, cv.height - 12); ctx.moveTo(0, cv.height - 12 - U); ctx.lineTo(cv.width, cv.height - 12 - U); ctx.stroke();
      }
    }
    if (!view) fig.classList.add('miss');
    const cap = document.createElement('figcaption');
    if (kind === 'part' && partId) {
      // パーツIDは自動判定が外れることがあるので、ここで付け替えられる
      const sel = document.createElement('select');
      sel.className = 'partSel';
      for (const id of PART_IDS_ALL) { const o = document.createElement('option'); o.value = id; o.textContent = id.toUpperCase(); sel.appendChild(o); }
      sel.value = partId;
      sel.onchange = () => {
        const parts = state.s1!.parts;
        const to = sel.value as PartId, me = parts[partId]!;
        const other = parts[to];
        delete parts[partId];
        if (other) parts[partId] = other; // 付け替え先にすでにあれば入れ替え
        parts[to] = me;
        for (const r of state.s1!.regions) {
          if (r.box === me.box) r.label = 'PARTS:' + to.toUpperCase();
          else if (other && r.box === other.box) r.label = 'PARTS:' + partId.toUpperCase();
        }
        renderResult();
      };
      cap.append('PARTS ', sel);
    } else cap.textContent = label + (view ? '' : '（なし）');
    fig.append(cv, cap);
    g.appendChild(fig);
  };
  for (const id of VIEW_IDS) add('認識した' + VIEW_LABEL[id], state.s1!.views[id], id === 'top' ? 'top' : 'side');
  if (state.s2) { add('SHEET2 FRONT', state.s2.front); add('SHEET2 RIGHT', state.s2.right); }
  for (const [k, v] of Object.entries(state.s1!.parts)) add('PARTS', v, 'part', k as PartId);
  renderWarnings();
}

function renderWarnings() {
  const w = $('#warnings'); w.innerHTML = '';
  const msgs = [...state.s1!.warnings, ...(state.s2?.warnings ?? ['SHEET 2 が未選択のため、関節・骨格は作りません（関節の入力元は SHEET 2 だけです）'])];
  if (!msgs.length) w.innerHTML = '<div class="ok">規格どおりに読み取れました</div>';
  msgs.forEach(m => { const d = document.createElement('div'); d.textContent = '⚠ ' + m; w.appendChild(d); });
  if (state.joints) {
    const found = state.s2?.found ?? 0;
    $('#jointSummary').textContent = `FRONT marker = ${found}/${ALL_JOINTS.length}、RIGHT marker = ${state.s2?.foundRight ?? 0}/${RIGHT_MARKER_KEYS.length}（点線の丸は推定。指で修正できます）。奥行き（z）をマーカーで決めた関節：${ALL_JOINTS.filter(id => state.joints![id].zSource === 'marker').length}`;
  }
  const lg = $('#legend'); lg.innerHTML = '';
  for (const m of MARKERS) { const sp = document.createElement('span'); sp.innerHTML = `<i style="background:${rgbHex(m.rgb)}"></i>${m.key}`; lg.appendChild(sp); }
}

// ------------------------------------------------------------------ 3. 関節の修正（ドラッグ）
interface Editor { cv: HTMLCanvasElement; src: SourceImage; side: boolean; scale: number }
const editors: Editor[] = [];
function editorSource(side: boolean): SourceImage | undefined {
  return side ? state.s2?.right?.src : state.s2?.front?.src;
}
function drawJointEditors() {
  editors.length = 0;
  for (const side of [false, true]) {
    const src = editorSource(side);
    const cv = $(side ? '#jRight' : '#jFront') as HTMLCanvasElement;
    if (!src) { cv.width = 1; cv.height = 1; continue; }
    const scale = Math.min(1, (side ? 360 : 720) / src.w, 900 / src.h);
    cv.width = Math.round(src.w * scale); cv.height = Math.round(src.h * scale);
    editors.push({ cv, src, side, scale });
  }
  redrawEditors();
}
function redrawEditors() {
  const J = state.joints; if (!J) return;
  for (const e of editors) {
    const ctx = e.cv.getContext('2d')!;
    ctx.clearRect(0, 0, e.cv.width, e.cv.height);
    ctx.globalAlpha = 0.75; ctx.drawImage(e.src.canvas, 0, 0, e.cv.width, e.cv.height); ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1.5;
    for (const [a, b] of BONES) {
      const p = toPx(e, J[a]), q = toPx(e, J[b]);
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
    }
    const r = Math.max(5, e.cv.height * 0.014);
    const drawn = new Set<string>();
    for (const id of ALL_JOINTS) {
      const j = J[id];
      if (e.side && id.endsWith('_R')) continue; // 右側面図では左右の対は1個（_L と同じ位置）
      const p = toPx(e, j);
      const key = `${Math.round(p.x)},${Math.round(p.y)}`;
      if (drawn.has(key)) continue; drawn.add(key);
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = rgbHex(markerOf(id).rgb); ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = j.source === 'marker' ? '#000' : '#fff';
      if (j.source === 'estimate') ctx.setLineDash([3, 2]); else ctx.setLineDash([]);
      ctx.stroke(); ctx.setLineDash([]);
    }
  }
}
function toPx(e: Editor, j: { x: number; y: number; z: number }) {
  const d = denorm(e.src, e.side ? j.z : j.x, j.y);
  return { x: d.px * e.scale, y: d.py * e.scale };
}
let drag: { e: Editor; ids: JointId[] } | null = null;
function pointerPos(e: Editor, ev: PointerEvent) {
  const b = e.cv.getBoundingClientRect();
  return { x: (ev.clientX - b.left) * (e.cv.width / b.width), y: (ev.clientY - b.top) * (e.cv.height / b.height) };
}
for (const sel of ['#jFront', '#jRight']) {
  const cv = $(sel) as HTMLCanvasElement;
  cv.addEventListener('pointerdown', ev => {
    const e = editors.find(x => x.cv === cv); if (!e || !state.joints) return;
    const p = pointerPos(e, ev);
    let best: JointId | null = null, bd = (e.cv.height * 0.05) ** 2;
    for (const id of ALL_JOINTS) {
      if (e.side && id.endsWith('_R')) continue;
      const q = toPx(e, state.joints[id]);
      const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
      if (d < bd) { bd = d; best = id; }
    }
    if (!best) return;
    // 右側面図で対の関節をつかんだら、左右両方の奥行きを動かす
    // 右側面図では重なっている関節（肩・肘・手首など）をまとめて動かし、左右の対も一緒に動かす
    let ids: JointId[] = [best];
    if (e.side) {
      const bp = toPx(e, state.joints[best]);
      const near = ALL_JOINTS.filter(id => !id.endsWith('_R') && Math.hypot(toPx(e, state.joints![id]).x - bp.x, toPx(e, state.joints![id]).y - bp.y) < 4);
      ids = near.flatMap(id => (id.endsWith('_L') ? [id, id.replace(/_L$/, '_R') as JointId] : [id]));
    }
    drag = { e, ids };
    cv.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });
  cv.addEventListener('pointermove', ev => {
    if (!drag || drag.e.cv !== cv || !state.joints) return;
    const p = pointerPos(drag.e, ev);
    const src = drag.e.src;
    const u = (p.x / drag.e.scale - src.w / 2) / src.h, v = (src.h - 1 - p.y / drag.e.scale) / src.h;
    for (const id of drag.ids) {
      const j = state.joints[id];
      if (drag.e.side) { j.z = u; j.zSource = 'manual'; } else { j.x = u; j.source = 'manual'; }
      j.y = v;
    }
    redrawEditors();
    buildJoints3D();
  });
  cv.addEventListener('pointerup', () => { drag = null; });
}
$('#btnJointReset').onclick = () => { if (state.detected) { state.joints = structuredClone(state.detected); redrawEditors(); buildJoints3D(); } };

// ------------------------------------------------------------------ 4. Visual Hull
const tolEl = $('#tolerance') as HTMLInputElement;
const showTol = () => { tolEl.parentElement!.querySelector('output')!.textContent = (parseFloat(tolEl.value) * 100).toFixed(1) + '%'; };
tolEl.addEventListener('input', showTol); showTol();
$('#btnHull').onclick = generateHull;

function generateHull() {
  const v = state.s1?.views; if (!v) return;
  const use = {} as Record<ViewId, boolean>;
  document.querySelectorAll<HTMLInputElement>('#useViews input').forEach(i => { use[i.dataset.v as ViewId] = i.checked; });
  const srcs: Partial<Record<ViewId, SourceImage>> = {};
  for (const id of VIEW_IDS) if (v[id]) srcs[id] = v[id]!.src;
  try {
    const res = buildHull(srcs, { res: parseInt(($('#quality') as HTMLSelectElement).value, 10), tolerance: parseFloat(tolEl.value), use });
    state.hull = res;
    if (hullMesh) { root.remove(hullMesh); hullMesh.geometry.dispose(); }
    hullMesh = new THREE.Mesh(res.geometry, hullMat);
    hullMesh.name = 'visual_hull';
    hullMesh.visible = ($('#tMesh') as HTMLInputElement).checked;
    root.add(hullMesh);
    buildOverlays();
    $('#empty').hidden = true;
    const tris = (res.geometry.index?.count ?? 0) / 3;
    $('#info').textContent = `Visual Hull · ${Math.round(tris).toLocaleString()} tris · 幅${res.W.toFixed(2)} 奥行${res.D.toFixed(2)}（身長比）· ${Math.round(res.ms)}ms`;
    renderIou(res);
    $('#btnHullGlb').hidden = false;
    setView('front');
  } catch (err) {
    toast('3D生成できません: ' + (err as Error).message);
  }
}

function renderIou(res: HullResult) {
  const t = $('#iouTable');
  const rows = VIEW_IDS.filter(id => res.iou[id] !== undefined).map(id => {
    const p = res.iou[id]! * 100;
    return `<tr class="${p < 90 ? 'low' : ''}"><td>${VIEW_LABEL[id]}</td><td style="width:50%"><div class="bar"><i style="width:${p.toFixed(0)}%"></i></div></td><td>${p.toFixed(1)}%</td></tr>`;
  }).join('');
  const vals = VIEW_IDS.map(id => res.iou[id]).filter((v): v is number => v !== undefined);
  const avg = vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length) * 100 : 0;
  t.innerHTML = `<div class="cap">元シルエットとの一致度（IoU）。90%未満は、ビュー同士の形・縮尺・中心がずれている可能性があります</div><table>${rows}<tr class="${avg < 90 ? 'low' : ''}"><td class="iouAvg">平均</td><td><div class="bar"><i style="width:${avg.toFixed(0)}%"></i></div></td><td class="iouAvg">${avg.toFixed(1)}%</td></tr></table>`;
}

$('#btnHullGlb').onclick = async () => {
  if (!hullMesh) return;
  const m = new THREE.Mesh(hullMesh.geometry, new THREE.MeshStandardMaterial({ color: 0x9fb4c8 }));
  m.name = 'visual_hull';
  const res = await new GLTFExporter().parseAsync(m, { binary: true });
  const blob = new Blob([res as ArrayBuffer], { type: 'model/gltf-binary' });
  const file = new File([blob], 'visual_hull.glb', { type: 'model/gltf-binary' });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (/iPhone|iPad|iPod/.test(navigator.userAgent) && nav.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if ((e as Error).name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'visual_hull.glb'; a.click();
};

let toastTimer = 0;
function toast(msg: string, ok = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (ok ? ' ok' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = window.setTimeout(() => { t.hidden = true; }, 4500);
}

(window as unknown as { __sheet: unknown }).__sheet = { state, setView, scene };
setView('home');
