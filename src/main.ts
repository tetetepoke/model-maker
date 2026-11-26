// 3D MODEL MAKER（単体アプリ。完全クライアントサイド。GPU生成AI・外部API不使用）
// 画像 → 輪郭 → 立体 → 調整 → 360°確認 → GLB
//
// 生成アルゴリズムは2系統に完全に分けている：
//   キャラクター（人型）… character.ts：人体パーツを組み立て、画像はテクスチャとして貼る
//   アイテム … build.ts：ふくらませる／押し出す
// シーンに置く完成モデルの Root は常に1個（current）。作り直すたびに前のものは破棄する。
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { KNOWN_ITEMS as ITEMS } from './items';
import { buildGeometry, luminance, previewOutlines, type Lum } from './build';
import { buildCharacter, estimate, isolateFigure, type CharParams, type Figure } from './character';
import { buildMask, loadImage, makeNormalMap, makeTexture, toCanvas, type SourceImage } from './mask';
import { CATEGORIES, LOOKS, toId, type Category, type Mode } from './presets';

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const num = (id: string) => parseFloat(($('#' + id) as HTMLInputElement).value);
const setVal = (id: string, v: number | string) => {
  const el = $('#' + id) as HTMLInputElement;
  el.value = String(v);
  showOut(el);
};
function showOut(el: HTMLInputElement) {
  const out = el.parentElement?.querySelector('output');
  if (!out) return;
  const v = parseFloat(el.value);
  out.textContent = el.step && parseFloat(el.step) < 1 ? v.toFixed(2) : String(Math.round(v));
}

const state = {
  cat: CATEGORIES[0] as Category,
  mode: 'inflate' as Mode,
  full: null as HTMLCanvasElement | null,
  src: null as SourceImage | null, // アイテム用（切り抜き済みの画像とマスク）
  fig: null as Figure | null, // キャラクター用（1体だけ取り出したもの）
  tex: null as THREE.CanvasTexture | null,
  normal: null as THREE.CanvasTexture | null,
  lum: null as Lum | null,
  fileBase: '',
  crop: null as { x: number; y: number; w: number; h: number } | null,
  warnedPieces: false,
};

// ------------------------------------------------------------------ 3D プレビュー
const stage = $('#stage');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
stage.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0e131a);
const camera = new THREE.PerspectiveCamera(35, 1, 0.005, 200);
scene.add(new THREE.HemisphereLight(0xe6efff, 0x2a2018, 1.3));
const key = new THREE.DirectionalLight(0xffffff, 2.4); key.position.set(2, 3, 4); scene.add(key);
const rim = new THREE.DirectionalLight(0x8fd0ff, 1.1); rim.position.set(-3, 1.5, -3); scene.add(rim);
const grid = new THREE.GridHelper(2, 20, 0x2b3a4a, 0x18212c);
scene.add(grid);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.enablePan = false; // 1本指＝回転、ピンチ＝ズーム
controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_ROTATE };

const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75, metalness: 0 });
const pivot = new THREE.Group(); // 回転・位置の調整用（中身は current 1個だけ）
scene.add(pivot);
let current: THREE.Object3D | null = null;

function setCurrent(obj: THREE.Object3D) {
  if (current) {
    pivot.remove(current);
    current.traverse(o => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose(); });
  }
  current = obj;
  pivot.add(obj);
}

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);
resize();
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });

let viewR = 1;
function frameAt(dirv: THREE.Vector3) {
  const box = new THREE.Box3().setFromObject(pivot);
  if (box.isEmpty()) return;
  const c = box.getCenter(new THREE.Vector3());
  viewR = box.getSize(new THREE.Vector3()).length() * 0.5 || 1;
  const d = viewR / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.05;
  camera.position.copy(c).add(dirv.normalize().multiplyScalar(d));
  camera.near = d / 100; camera.far = d * 50; camera.updateProjectionMatrix();
  controls.target.copy(c);
  controls.minDistance = viewR * 0.4; controls.maxDistance = d * 5;
  controls.update();
}
const VIEWS: Record<string, [number, number, number]> = {
  front: [0, 0.12, 1], right: [1, 0.12, 0], back: [0, 0.12, -1], left: [-1, 0.12, 0], top: [0, 1, 0.0001], home: [0.6, 0.35, 1],
};
function setView(name: string) { frameAt(new THREE.Vector3(...(VIEWS[name] ?? VIEWS.home))); }
/** 形が大きく変わったときだけ、カメラの向きを保ったまま距離を合わせる */
function refit() {
  const box = new THREE.Box3().setFromObject(pivot);
  const r = box.getSize(new THREE.Vector3()).length() * 0.5 || 1;
  const c = box.getCenter(new THREE.Vector3());
  if (Math.abs(r - viewR) / viewR > 0.25 || controls.target.distanceTo(c) > r * 0.3) frameAt(camera.position.clone().sub(controls.target));
}
document.querySelectorAll<HTMLButtonElement>('#views [data-view]').forEach(b => { b.onclick = () => setView(b.dataset.view!); });
$('#btnWire').onclick = () => {
  material.wireframe = !material.wireframe;
  $('#btnWire').classList.toggle('on', material.wireframe);
};

// ------------------------------------------------------------------ STEP 1: 種類と画像
const catBox = $('#cats');
CATEGORIES.forEach(c => {
  const b = document.createElement('button');
  b.textContent = c.label;
  b.onclick = () => selectCategory(c, true);
  catBox.appendChild(b);
});
function selectCategory(c: Category, applyDefaults: boolean) {
  state.cat = c;
  catBox.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', CATEGORIES[i] === c));
  if (applyDefaults) {
    setVal('thickness', c.thickness);
    setVal('roundness', c.roundness);
    setVal('detail', c.detail);
    if (!ITEMS[toId(($('#itemId') as HTMLInputElement).value)]) setVal('heightM', c.heightM);
    setMode(c.mode);
  }
  updateExportInfo();
}

const looksBox = $('#looks');
LOOKS.forEach(l => {
  const b = document.createElement('button');
  b.textContent = l.label;
  b.onclick = () => {
    looksBox.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    setVal('metalness', l.metalness); setVal('roughness', l.roughness); setVal('opacity', l.opacity);
    ($('#tint') as HTMLInputElement).value = l.tint;
    if (state.mode !== 'humanoid') {
      if (l.roundness !== undefined) setVal('roundness', l.roundness);
      if (l.bump !== undefined) setVal('bump', l.bump);
    }
    rebuild(state.mode !== 'humanoid');
  };
  looksBox.appendChild(b);
});

$('#file').addEventListener('change', async e => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  try {
    const img = await loadImage(f);
    state.full = toCanvas(img);
    state.fileBase = toId(f.name.replace(/\.[^.]+$/, ''));
    ($('#srcPreview') as HTMLImageElement).src = state.full.toDataURL();
    $('#drop').classList.add('has');
    $('#dropText').textContent = 'タップで画像を変更';
    const idInput = $('#itemId') as HTMLInputElement;
    if (!idInput.value && state.fileBase && !/^img_\d+$|^image$|^[0-9a-f_]{20,}$/.test(state.fileBase)) idInput.value = state.fileBase;
    state.crop = null; state.warnedPieces = false;
    $('#cropBox').hidden = false;
    drawCrop();
    firstView = true;
    remask();
    ['#secContour', '#secShape', '#secAdjust', '#secExport'].forEach(s => { $(s).hidden = false; });
    $('#bodyCard').hidden = state.mode !== 'humanoid';
    $('#empty').hidden = true;
  } catch (err) {
    toast('画像を読み込めませんでした: ' + (err as Error).message);
  }
});

// ------------------------------------------------------------------ STEP 2: 輪郭
function workingCanvas(): HTMLCanvasElement | null {
  const full = state.full; if (!full) return null;
  const c = state.crop;
  if (!c || c.w < 8 || c.h < 8) return full;
  const out = document.createElement('canvas');
  out.width = Math.round(c.w); out.height = Math.round(c.h);
  out.getContext('2d')!.drawImage(full, c.x, c.y, c.w, c.h, 0, 0, out.width, out.height);
  return out;
}

/** 画像 → マスク。キャラクターならさらに「1体だけ」に絞り、体の比率を推定し直す */
function remask(reestimate = true) {
  const work = workingCanvas();
  if (!work) return;
  const src = buildMask(work, { tolerance: num('tolerance'), alphaCut: 100 });
  if (!src) { toast('物体が見つかりません。範囲か背景の切り抜きを調整してください'); return; }
  $('#tolRow').hidden = src.hadAlpha;
  if (state.mode === 'humanoid') {
    state.fig = isolateFigure(src);
    state.src = state.fig.src;
    if (src.pieces >= 3 && !state.warnedPieces) {
      state.warnedPieces = true;
      toast('複数の絵があったので、全身が写っている1体だけを使いました。違う場合は「使う範囲」で囲んでください', true);
    }
    if (reestimate) applyCharParams(estimate(state.fig));
  } else {
    state.fig = null;
    state.src = src;
    if (src.pieces >= 4 && !state.warnedPieces) {
      state.warnedPieces = true;
      toast(`絵が${src.pieces}つに分かれています。設定画なら「使う範囲」で1つだけ囲んでください`);
    }
  }
  makeTextures();
  drawContour();
  rebuild(true);
}

function drawContour() {
  const src = state.src; if (!src) return;
  const cv = $('#contourCanvas') as HTMLCanvasElement;
  const s = Math.min(1, 640 / Math.max(src.w, src.h));
  cv.width = Math.round(src.w * s); cv.height = Math.round(src.h * s);
  const ctx = cv.getContext('2d')!;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.globalAlpha = 0.85;
  ctx.drawImage(src.canvas, 0, 0, cv.width, cv.height);
  ctx.globalAlpha = 1;
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = '#36e3c4';
  ctx.shadowColor = '#000'; ctx.shadowBlur = 3;
  for (const poly of previewOutlines(src, num('smoothing'))) {
    ctx.beginPath();
    poly.forEach(([x, y], i) => (i ? ctx.lineTo(x * s, y * s) : ctx.moveTo(x * s, y * s)));
    ctx.closePath();
    ctx.stroke();
  }
}

function makeTextures() {
  const src = state.src; if (!src) return;
  const size = parseInt(($('#texSize') as HTMLSelectElement).value, 10);
  const texCanvas = makeTexture(src, size);
  state.tex?.dispose(); state.normal?.dispose();
  state.tex = new THREE.CanvasTexture(texCanvas);
  state.tex.colorSpace = THREE.SRGBColorSpace;
  state.tex.anisotropy = 4;
  material.map = state.tex;
  if (state.mode === 'humanoid') {
    // キャラクターは色を形にしない：法線マップ（凹凸）も使わない
    state.normal = null; state.lum = null;
    material.normalMap = null;
  } else {
    state.normal = new THREE.CanvasTexture(makeNormalMap(texCanvas));
    state.lum = luminance(texCanvas);
    material.normalMap = state.normal;
  }
  material.needsUpdate = true;
}

// ------------------------------------------------------------------ 範囲選択（設定画から1つだけ使う）
const cropCv = $('#cropCanvas') as HTMLCanvasElement;
let cropScale = 1;
function drawCrop(drag?: { x0: number; y0: number; x1: number; y1: number }) {
  const full = state.full; if (!full) return;
  cropScale = Math.min(1, 900 / full.width);
  cropCv.width = Math.round(full.width * cropScale); cropCv.height = Math.round(full.height * cropScale);
  const ctx = cropCv.getContext('2d')!;
  ctx.drawImage(full, 0, 0, cropCv.width, cropCv.height);
  const r = drag
    ? { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) }
    : state.crop && { x: state.crop.x * cropScale, y: state.crop.y * cropScale, w: state.crop.w * cropScale, h: state.crop.h * cropScale };
  if (!r) return;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.beginPath(); ctx.rect(0, 0, cropCv.width, cropCv.height); ctx.rect(r.x, r.y, r.w, r.h); ctx.fill('evenodd');
  ctx.strokeStyle = '#36e3c4'; ctx.lineWidth = 3; ctx.strokeRect(r.x, r.y, r.w, r.h);
}
function cvPoint(e: PointerEvent) {
  const b = cropCv.getBoundingClientRect();
  return { x: Math.min(Math.max(e.clientX - b.left, 0), b.width) * (cropCv.width / b.width), y: Math.min(Math.max(e.clientY - b.top, 0), b.height) * (cropCv.height / b.height) };
}
let dragRect: { x0: number; y0: number; x1: number; y1: number } | null = null;
cropCv.addEventListener('pointerdown', e => { const p = cvPoint(e); dragRect = { x0: p.x, y0: p.y, x1: p.x, y1: p.y }; cropCv.setPointerCapture(e.pointerId); e.preventDefault(); });
cropCv.addEventListener('pointermove', e => { if (!dragRect) return; const p = cvPoint(e); dragRect.x1 = p.x; dragRect.y1 = p.y; drawCrop(dragRect); });
cropCv.addEventListener('pointerup', () => {
  if (!dragRect) return;
  const r = dragRect; dragRect = null;
  const w = Math.abs(r.x1 - r.x0) / cropScale, h = Math.abs(r.y1 - r.y0) / cropScale;
  if (w < 12 || h < 12) { drawCrop(); return; } // ただのタップは無視
  state.crop = { x: Math.min(r.x0, r.x1) / cropScale, y: Math.min(r.y0, r.y1) / cropScale, w, h };
  drawCrop();
  firstView = true;
  remask();
});
$('#btnCropReset').onclick = () => { state.crop = null; drawCrop(); firstView = true; remask(); };

// ------------------------------------------------------------------ STEP 3: 作り方
document.querySelectorAll<HTMLButtonElement>('#mode button').forEach(b => { b.onclick = () => setMode(b.dataset.v as Mode); });
function setMode(m: Mode) {
  const changedKind = (m === 'humanoid') !== (state.mode === 'humanoid');
  state.mode = m;
  document.querySelectorAll<HTMLButtonElement>('#mode button').forEach(b => b.classList.toggle('on', b.dataset.v === m));
  const human = m === 'humanoid';
  $('#bodyCard').hidden = !human || !state.full;
  document.querySelectorAll<HTMLElement>('.item-only').forEach(el => { el.hidden = human; });
  $('#modeHint').textContent = human
    ? '人体パーツ（頭・首・胴体・腕・脚）を組み立てて1体にします。画像は表面の色として貼ります。'
    : m === 'inflate' ? '輪郭の中央をふくらませて立体にします（石・鉱石・丸いアイテム向け）。' : '輪郭を押し出して面取りします（武器・道具・板状の物向け）。';
  if (!state.full) return;
  firstView = true;
  if (changedKind) remask(); else rebuild(true);
}

// ------------------------------------------------------------------ STEP 4: 調整
const BODY_IDS: (keyof CharParams)[] = ['headW', 'headH', 'headDepth', 'shoulderW', 'torsoW', 'torsoLen', 'bodyDepth', 'armLen', 'armThick', 'armAngle', 'legLen', 'legThick', 'legGap'];
let neckLen = 0.025;
function applyCharParams(p: CharParams) {
  neckLen = p.neckLen;
  for (const k of BODY_IDS) setVal('b_' + k, +p[k].toFixed(3));
}
function readCharParams(): CharParams {
  const p = { neckLen } as CharParams;
  for (const k of BODY_IDS) p[k] = num('b_' + k);
  return p;
}
$('#btnReestimate').onclick = () => { if (state.fig) { applyCharParams(estimate(state.fig)); rebuild(true); toast('シルエットから推定し直しました', true); } };

let pending = 0, pendingGeo = false;
function rebuild(geometry: boolean) {
  pendingGeo = pendingGeo || geometry;
  if (pending) return;
  pending = requestAnimationFrame(() => {
    pending = 0;
    const g = pendingGeo; pendingGeo = false;
    apply(g);
  });
}

let firstView = true;
function apply(geometry: boolean) {
  if (!state.src) return;
  if (geometry || !current) {
    if (state.mode === 'humanoid' && state.fig) {
      setCurrent(buildCharacter(readCharParams(), state.fig, material));
    } else {
      const geo = buildGeometry(state.src, {
        mode: state.mode === 'extrude' ? 'extrude' : 'inflate', detail: num('detail'), thickness: num('thickness'),
        roundness: num('roundness'), bump: num('bump'), smoothing: num('smoothing'),
      }, state.lum);
      const root = new THREE.Group();
      root.name = 'item';
      const mesh = new THREE.Mesh(geo, material);
      mesh.name = 'body';
      root.add(mesh);
      setCurrent(root);
    }
  }
  // 大きさ（高さ1のモデルを実寸へ）
  const h = num('heightM');
  current!.scale.set(h * num('scaleX'), h, h * num('scaleZ'));
  pivot.rotation.set(THREE.MathUtils.degToRad(num('rotX')), THREE.MathUtils.degToRad(num('rotY')), 0);
  pivot.position.y = num('posY') * h;
  material.color.set(($('#tint') as HTMLInputElement).value);
  material.metalness = num('metalness');
  material.roughness = num('roughness');
  material.opacity = num('opacity');
  const transparent = material.opacity < 0.999;
  if (material.transparent !== transparent) { material.transparent = transparent; material.needsUpdate = true; }
  material.depthWrite = !transparent;
  material.normalScale.setScalar(num('bump') * 1.2);
  grid.scale.setScalar(Math.max(h, 0.2));
  if (firstView) { setView(state.mode === 'humanoid' ? 'front' : 'home'); firstView = false; } else if (geometry) refit();
  updateInfo();
}

function countTris(o: THREE.Object3D) {
  let t = 0;
  o.traverse(c => {
    const m = c as THREE.Mesh;
    if (m.isMesh) t += m.geometry.index ? m.geometry.index.count / 3 : m.geometry.attributes.position.count / 3;
  });
  return Math.round(t);
}

function updateInfo() {
  if (!current) return;
  const tris = countTris(current);
  const size = new THREE.Box3().setFromObject(pivot).getSize(new THREE.Vector3());
  $('#info').textContent = `${tris.toLocaleString()} tris · ${size.x.toFixed(2)}×${size.y.toFixed(2)}×${size.z.toFixed(2)} m`;
  const issues: string[] = [];
  if (tris > state.cat.maxTris) issues.push(`ポリゴンが多め（${tris.toLocaleString()} / 目安 ${state.cat.maxTris.toLocaleString()}）${state.mode === 'humanoid' ? '' : '→「細かさ」を下げる'}`);
  if (num('opacity') < 1) issues.push('半透明は重なり順で見え方が変わることがあります');
  $('#ready').innerHTML = issues.length ? issues.map(s => `<div class="warn">${s}</div>`).join('') : '<div class="ok">iPhone向けの目安内です</div>';
}

const geoInputs = ['thickness', 'roundness', 'bump', 'detail', 'smoothing', ...BODY_IDS.map(k => 'b_' + k)];
const lookInputs = ['heightM', 'scaleX', 'scaleZ', 'rotY', 'rotX', 'posY', 'metalness', 'roughness', 'opacity'];
document.querySelectorAll<HTMLInputElement>('input[type=range]').forEach(el => {
  showOut(el);
  el.addEventListener('input', () => {
    showOut(el);
    if (el.id === 'tolerance') { remaskDebounced(); return; }
    if (el.id === 'smoothing') drawContour();
    rebuild(geoInputs.includes(el.id));
    if (lookInputs.includes(el.id)) updateExportInfo();
  });
});
$('#tint').addEventListener('input', () => rebuild(false));
$('#texSize').addEventListener('change', () => { makeTextures(); rebuild(true); });
let remaskTimer = 0;
function remaskDebounced() { clearTimeout(remaskTimer); remaskTimer = window.setTimeout(() => remask(), 180); }

// ------------------------------------------------------------------ STEP 6: GLB
const known = $('#knownIds');
Object.values(ITEMS).forEach(it => {
  const o = document.createElement('option');
  o.value = it.id; o.label = `${it.nameJa}（${it.length}m）`;
  known.appendChild(o);
});
$('#itemId').addEventListener('change', () => {
  const it = ITEMS[toId(($('#itemId') as HTMLInputElement).value)];
  if (it) { setVal('heightM', it.length); rebuild(false); toast(`「${it.nameJa}」の長さ ${it.length}m に合わせました`); }
  updateExportInfo();
});
$('#itemId').addEventListener('input', updateExportInfo);

function currentId() { return toId(($('#itemId') as HTMLInputElement).value || state.fileBase || 'model'); }
function updateExportInfo() {
  const id = currentId();
  const dir = state.cat.dir;
  $('#fileName').textContent = `${id}.glb`;
  $('#dirName').textContent = `public/${dir}`;
  $('#snippet').textContent = `visual: { model: '/element118/${dir}${id}.glb' },`;
}

/** 書き出し用：調整（大きさ・回転・位置）を各パーツに焼き込み、Root Group 1個にまとめる。足元が y=0、正面 +Z */
function exportObject(): THREE.Object3D {
  pivot.updateMatrixWorld(true);
  const root = new THREE.Group();
  root.name = currentId();
  const mat = material.clone();
  mat.wireframe = false;
  mat.name = currentId() + '_mat';
  const meshes: THREE.Mesh[] = [];
  current!.traverse(o => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const geo = m.geometry.clone();
    geo.applyMatrix4(m.matrixWorld);
    geo.computeVertexNormals();
    const out = new THREE.Mesh(geo, mat);
    out.name = m.name;
    meshes.push(out);
  });
  const box = new THREE.Box3();
  meshes.forEach(m => { m.geometry.computeBoundingBox(); box.union(m.geometry.boundingBox!); });
  const dx = -(box.min.x + box.max.x) / 2, dy = -box.min.y + num('posY') * num('heightM'), dz = -(box.min.z + box.max.z) / 2;
  meshes.forEach(m => { m.geometry.translate(dx, dy, dz); root.add(m); });
  return root;
}

$('#btnExport').onclick = async () => {
  if (!current) return;
  const btn = $('#btnExport') as HTMLButtonElement;
  btn.disabled = true; btn.textContent = '書き出し中…';
  try {
    const obj = exportObject();
    const res = await new GLTFExporter().parseAsync(obj, { binary: true, onlyVisible: true, maxTextureSize: parseInt(($('#texSize') as HTMLSelectElement).value, 10) });
    obj.traverse(o => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose(); });
    const blob = new Blob([res as ArrayBuffer], { type: 'model/gltf-binary' });
    const name = `${currentId()}.glb`;
    await saveFile(blob, name);
    toast(`${name}（${(blob.size / 1024).toFixed(0)} KB）`, true);
  } catch (err) {
    toast('書き出しに失敗しました: ' + (err as Error).message);
  } finally {
    btn.disabled = false; btn.textContent = 'GLB を書き出す';
  }
};

async function saveFile(blob: Blob, name: string) {
  const file = new File([blob], name, { type: 'model/gltf-binary' });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (/iPhone|iPad|iPod/.test(navigator.userAgent) && nav.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if ((e as Error).name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

$('#btnCopy').onclick = async () => {
  try { await navigator.clipboard.writeText($('#snippet').textContent || ''); toast('コピーしました', true); } catch { toast('コピーできませんでした'); }
};

let toastTimer = 0;
function toast(msg: string, ok = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (ok ? ' ok' : ''); t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { t.hidden = true; }, 4500);
}

// デバッグ・確認用（シーン内の完成モデルの数を数える）
(window as unknown as { __mm: unknown }).__mm = { rootCount: () => pivot.children.length, scene };

// 初期状態
selectCategory(CATEGORIES[0], true);
looksBox.querySelector('button')?.classList.add('on');
updateExportInfo();
