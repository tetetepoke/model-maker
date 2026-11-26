// 3D MODEL MAKER（ELEMENT 3D Studio 内の単体アプリ。完全クライアントサイド。GPU生成AI・外部API不使用）
// 画像 → 輪郭 → 立体 → 調整 → 360°確認 → GLB
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { KNOWN_ITEMS as ITEMS } from './items';
import { buildGeometry, luminance, previewOutlines, type Lum, type ShapeMode } from './build';
import { buildMask, loadImage, makeNormalMap, makeTexture, toCanvas, type SourceImage } from './mask';
import { CATEGORIES, LOOKS, toId, type Category } from './presets';

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
  mode: 'inflate' as ShapeMode,
  full: null as HTMLCanvasElement | null,
  src: null as SourceImage | null,
  tex: null as THREE.CanvasTexture | null,
  normal: null as THREE.CanvasTexture | null,
  lum: null as Lum | null,
  fileBase: '',
};

// ------------------------------------------------------------------ 3D プレビュー
const stage = $('#stage');
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
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
const pivot = new THREE.Group(); // 回転・位置の調整用
const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
pivot.add(mesh);
scene.add(pivot);
let wire: THREE.LineSegments | null = null;

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
function setView(name: string) {
  const box = new THREE.Box3().setFromObject(pivot);
  if (box.isEmpty()) return;
  const c = box.getCenter(new THREE.Vector3());
  viewR = box.getSize(new THREE.Vector3()).length() * 0.5 || 1;
  const d = viewR / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.05;
  const dir: Record<string, [number, number, number]> = {
    front: [0, 0.12, 1], right: [1, 0.12, 0], back: [0, 0.12, -1], left: [-1, 0.12, 0], top: [0, 1, 0.0001], home: [0.6, 0.35, 1],
  };
  const v = new THREE.Vector3(...(dir[name] ?? dir.home)).normalize().multiplyScalar(d);
  camera.position.copy(c).add(v);
  camera.near = d / 100; camera.far = d * 50; camera.updateProjectionMatrix();
  controls.target.copy(c);
  controls.minDistance = viewR * 0.4; controls.maxDistance = d * 5;
  controls.update();
}
document.querySelectorAll<HTMLButtonElement>('#views [data-view]').forEach(b => { b.onclick = () => setView(b.dataset.view!); });
$('#btnWire').onclick = () => {
  if (wire) { pivot.remove(wire); wire.geometry.dispose(); wire = null; $('#btnWire').classList.remove('on'); return; }
  wire = new THREE.LineSegments(new THREE.WireframeGeometry(mesh.geometry), new THREE.LineBasicMaterial({ color: 0x36e3c4, transparent: true, opacity: 0.35 }));
  wire.scale.copy(mesh.scale); wire.position.copy(mesh.position);
  pivot.add(wire);
  $('#btnWire').classList.add('on');
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
    setMode(c.mode, false);
    setVal('thickness', c.thickness);
    setVal('roundness', c.roundness);
    setVal('detail', c.detail);
    if (!ITEMS[toId(($('#itemId') as HTMLInputElement).value)]) setVal('heightM', c.heightM);
    rebuild(true);
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
    if (l.roundness !== undefined) setVal('roundness', l.roundness);
    if (l.bump !== undefined) setVal('bump', l.bump);
    rebuild(false);
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
    if (!idInput.value && state.fileBase && !/^img_\d+$|^image$/.test(state.fileBase)) idInput.value = state.fileBase;
    remask();
    ['#secContour', '#secShape', '#secAdjust', '#secExport'].forEach(s => { $(s).hidden = false; });
    $('#empty').hidden = true;
  } catch (err) {
    toast('画像を読み込めませんでした: ' + (err as Error).message);
  }
});

// ------------------------------------------------------------------ STEP 2: 輪郭
function remask() {
  if (!state.full) return;
  const src = buildMask(state.full, { tolerance: num('tolerance'), alphaCut: 100 });
  if (!src) { toast('物体が見つかりません。背景の切り抜きを調整してください'); return; }
  state.src = src;
  $('#tolRow').hidden = src.hadAlpha; // 透明PNGなら背景の切り抜きは不要
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
  state.tex.flipY = true;
  state.tex.anisotropy = 4;
  state.normal = new THREE.CanvasTexture(makeNormalMap(texCanvas));
  state.lum = luminance(texCanvas);
  material.map = state.tex;
  material.normalMap = state.normal;
  material.needsUpdate = true;
}

// ------------------------------------------------------------------ STEP 3–4: 立体と調整
document.querySelectorAll<HTMLButtonElement>('#mode button').forEach(b => { b.onclick = () => setMode(b.dataset.v as ShapeMode, true); });
function setMode(m: ShapeMode, doRebuild: boolean) {
  state.mode = m;
  document.querySelectorAll<HTMLButtonElement>('#mode button').forEach(b => b.classList.toggle('on', b.dataset.v === m));
  if (doRebuild) rebuild(true);
}

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
  const src = state.src; if (!src) return;
  if (geometry) {
    const geo = buildGeometry(src, {
      mode: state.mode, detail: num('detail'), thickness: num('thickness'), roundness: num('roundness'),
      bump: num('bump'), smoothing: num('smoothing'),
    }, state.lum);
    mesh.geometry.dispose();
    mesh.geometry = geo;
    if (wire) { $('#btnWire').click(); $('#btnWire').click(); }
  }
  // 大きさ（高さ1のジオメトリを実寸へ）
  const h = num('heightM');
  mesh.scale.set(h * num('scaleX'), h, h * num('scaleZ'));
  if (wire) wire.scale.copy(mesh.scale);
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
  if (firstView) { setView('home'); firstView = false; } else if (geometry) setViewKeep();
  updateInfo();
}

function updateInfo() {
  const geo = mesh.geometry;
  const tris = geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3;
  const size = new THREE.Box3().setFromObject(pivot).getSize(new THREE.Vector3());
  $('#info').textContent = `${Math.round(tris).toLocaleString()} tris · ${size.x.toFixed(2)}×${size.y.toFixed(2)}×${size.z.toFixed(2)} m`;
  const ready = $('#ready');
  const issues: string[] = [];
  if (tris > state.cat.maxTris) issues.push(`ポリゴンが多め（${Math.round(tris).toLocaleString()} / 目安 ${state.cat.maxTris.toLocaleString()}）→「細かさ」を下げる`);
  if (num('opacity') < 1) issues.push('半透明は重なり順で見え方が変わることがあります');
  ready.innerHTML = issues.length ? issues.map(s => `<div class="warn">${s}</div>`).join('') : '<div class="ok">iPhone向けの目安内です</div>';
}

// 形が大きく変わったときだけ、カメラの向きを保ったまま距離を合わせる
function setViewKeep() {
  const box = new THREE.Box3().setFromObject(pivot);
  const c = box.getCenter(new THREE.Vector3());
  const r = box.getSize(new THREE.Vector3()).length() * 0.5 || 1;
  const dirv = camera.position.clone().sub(controls.target).normalize();
  const d = r / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.05;
  if (Math.abs(r - viewR) / viewR > 0.25 || controls.target.distanceTo(c) > r * 0.3) {
    camera.position.copy(c).add(dirv.multiplyScalar(d));
    controls.target.copy(c);
    camera.near = d / 100; camera.far = d * 50; camera.updateProjectionMatrix();
    controls.minDistance = r * 0.4; controls.maxDistance = d * 5;
    viewR = r;
  }
}

const geoInputs = ['thickness', 'roundness', 'bump', 'detail', 'smoothing'];
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
function remaskDebounced() { clearTimeout(remaskTimer); remaskTimer = window.setTimeout(remask, 180); }

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

/** 調整を焼き込んだ書き出し用オブジェクト（底辺中心が原点、正面 +Z） */
function exportObject(): THREE.Object3D {
  pivot.updateMatrixWorld(true);
  const geo = mesh.geometry.clone();
  geo.applyMatrix4(mesh.matrixWorld);
  geo.computeVertexNormals();
  const box = new THREE.Box3().setFromBufferAttribute(geo.attributes.position as THREE.BufferAttribute);
  geo.translate(-(box.min.x + box.max.x) / 2, -box.min.y + num('posY') * num('heightM'), -(box.min.z + box.max.z) / 2);
  const mat = material.clone();
  mat.name = currentId() + '_mat';
  const m = new THREE.Mesh(geo, mat);
  m.name = currentId();
  const root = new THREE.Group();
  root.name = currentId();
  root.add(m);
  return root;
}

$('#btnExport').onclick = async () => {
  if (!state.src) return;
  const btn = $('#btnExport') as HTMLButtonElement;
  btn.disabled = true; btn.textContent = '書き出し中…';
  try {
    const obj = exportObject();
    const res = await new GLTFExporter().parseAsync(obj, { binary: true, onlyVisible: true, maxTextureSize: parseInt(($('#texSize') as HTMLSelectElement).value, 10) });
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

function toast(msg: string, ok = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (ok ? ' ok' : ''); t.hidden = false;
  clearTimeout((toast as unknown as { t: number }).t);
  (toast as unknown as { t: number }).t = window.setTimeout(() => { t.hidden = true; }, 3500);
}

// 初期状態
selectCategory(CATEGORIES[0], true);
looksBox.querySelector('button')?.classList.add('on');
updateExportInfo();
