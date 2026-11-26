// ELEMENT 118 SHEET → 3D（Phase 1：規格シートの読み込み・解析／Phase 2：Visual Hull と重ね合わせ比較）
// 画像解析＋幾何計算のみ（AI・外部API・GPUサーバー不使用）。
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { buildHull, type HullResult } from './hull';
import { loadImage, type SourceImage } from './mask';
import { denorm, fillMissingJoints, parseSheet1, parseSheet2, type Joints, type Sheet1, type Sheet2, type ViewId } from './sheetParse';
import { ALL_JOINTS, BONES, MARKERS, markerOf, PARTS_LABELS, rgbHex, SHEET1_CELLS, type JointId } from './sheetSpec';

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const VIEW_IDS: ViewId[] = ['front', 'right', 'back', 'left', 'top'];
const VIEW_LABEL: Record<ViewId, string> = { front: 'FRONT', right: 'RIGHT', back: 'BACK', left: 'LEFT', top: 'TOP' };

const state = {
  img1: null as HTMLCanvasElement | null,
  img2: null as HTMLCanvasElement | null,
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
  if (n === 1) state.img1 = c; else state.img2 = c;
  ($('#prev' + n) as HTMLImageElement).src = URL.createObjectURL(blob);
  $('#drop' + n).classList.add('has');
  ($('#btnAnalyze') as HTMLButtonElement).disabled = !state.img1;
}
for (const n of [1, 2] as const) {
  $('#file' + n).addEventListener('change', async e => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) { try { await setSheet(n, f); } catch (err) { toast('画像を読み込めません: ' + (err as Error).message); } }
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
  state.s1 = parseSheet1(state.img1);
  state.s2 = state.img2 ? parseSheet2(state.img2) : null;
  const frontForEst = state.s1.views.front?.src;
  state.detected = fillMissingJoints(state.s2?.joints ?? {}, frontForEst);
  state.joints = structuredClone(state.detected);
  renderResult();
  ['#secResult', '#secJoints', '#secHull'].forEach(s => { $(s).hidden = false; });
  drawJointEditors();
  buildJoints3D();
  generateHull();
}

function renderResult() {
  const g = $('#viewGrid'); g.innerHTML = '';
  const add = (label: string, src: SourceImage | undefined) => {
    const fig = document.createElement('figure');
    const cv = document.createElement('canvas');
    if (src) {
      const s = Math.min(1, 240 / Math.max(src.w, src.h));
      cv.width = Math.max(1, Math.round(src.w * s)); cv.height = Math.max(1, Math.round(src.h * s));
      const ctx = cv.getContext('2d')!;
      ctx.drawImage(src.canvas, 0, 0, cv.width, cv.height);
      // シルエット（マスク）の縁を水色で表示
      const md = ctx.createImageData(cv.width, cv.height);
      for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) {
        const mx = Math.floor(x / s), my = Math.floor(y / s);
        const on = src.mask[my * src.w + mx];
        const edge = on && (!src.mask[my * src.w + Math.min(src.w - 1, mx + Math.ceil(1 / s))] || !src.mask[Math.min(src.h - 1, my + Math.ceil(1 / s)) * src.w + mx] || !src.mask[my * src.w + Math.max(0, mx - Math.ceil(1 / s))] || !src.mask[Math.max(0, my - Math.ceil(1 / s)) * src.w + mx]);
        if (edge) { const i = (y * cv.width + x) * 4; md.data[i] = 54; md.data[i + 1] = 227; md.data[i + 2] = 196; md.data[i + 3] = 255; }
      }
      const tmp = document.createElement('canvas'); tmp.width = cv.width; tmp.height = cv.height;
      tmp.getContext('2d')!.putImageData(md, 0, 0);
      ctx.drawImage(tmp, 0, 0);
    } else fig.classList.add('miss');
    const cap = document.createElement('figcaption');
    cap.textContent = label + (src ? '' : '（なし）');
    fig.append(cv, cap);
    g.appendChild(fig);
  };
  for (const c of SHEET1_CELLS) add(c.label, state.s1!.views[c.id as ViewId]?.src);
  for (const [k, v] of Object.entries(state.s1!.parts)) add('PARTS: ' + PARTS_LABELS[k as keyof typeof PARTS_LABELS], v?.src);
  const w = $('#warnings'); w.innerHTML = '';
  const msgs = [...state.s1!.warnings, ...(state.s2?.warnings ?? (state.img2 ? [] : ['SHEET 2 が未選択のため、関節はすべてシルエットから推定しています']))];
  if (!msgs.length) w.innerHTML = '<div class="ok">規格どおりに読み取れました</div>';
  msgs.forEach(m => { const d = document.createElement('div'); d.textContent = '⚠ ' + m; w.appendChild(d); });
  const found = state.s2?.found ?? 0;
  $('#jointSummary').textContent = `マーカーから検出：${found} / ${ALL_JOINTS.length}（残りはシルエットから推定）。奥行き（z）をマーカーで決めた関節：${ALL_JOINTS.filter(id => state.joints![id].zSource === 'marker').length}`;
  const lg = $('#legend'); lg.innerHTML = '';
  for (const m of MARKERS) { const s = document.createElement('span'); s.innerHTML = `<i style="background:${rgbHex(m.rgb)}"></i>${m.key}`; lg.appendChild(s); }
}

// ------------------------------------------------------------------ 3. 関節の修正（ドラッグ）
interface Editor { cv: HTMLCanvasElement; src: SourceImage; side: boolean; scale: number }
const editors: Editor[] = [];
function editorSource(side: boolean): SourceImage | undefined {
  return side ? (state.s2?.right?.src ?? state.s1?.views.right?.src) : (state.s2?.front?.src ?? state.s1?.views.front?.src);
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
    return `<tr class="${p < 85 ? 'low' : ''}"><td>${VIEW_LABEL[id]}</td><td style="width:50%"><div class="bar"><i style="width:${p.toFixed(0)}%"></i></div></td><td>${p.toFixed(1)}%</td></tr>`;
  }).join('');
  t.innerHTML = `<div class="cap">元シルエットとの一致度（IoU）。85%未満は、ビュー同士の形・縮尺・中心がずれている可能性があります</div><table>${rows}</table>`;
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
