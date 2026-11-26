// STANDARD BASE MESH V1 確認画面
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  makeBaseMesh, POSES, type PoseId, BONES_V1, UV_LAYOUT, type Part, topologyHash, BASE_MESH_VERSION, buildBaseMeshData,
} from './basemesh';

const $ = (s: string) => document.querySelector(s) as HTMLElement;
const data = buildBaseMeshData();
const HASH = topologyHash(data);

// ------------------------------------------------------------------ 3D
const stage = $('#stage');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
stage.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0e131a);
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -50, 50);
scene.add(new THREE.HemisphereLight(0xe6efff, 0x2a2018, 1.5));
const key = new THREE.DirectionalLight(0xffffff, 1.7); key.position.set(2, 3, 4); scene.add(key);
const rim = new THREE.DirectionalLight(0x9fc8ff, 0.6); rim.position.set(-3, 2, -3); scene.add(rim);
scene.add(new THREE.GridHelper(2, 20, 0x2b3a4a, 0x18212c));
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.enablePan = false;
controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_ROTATE };
controls.minZoom = 0.5; controls.maxZoom = 8;

// ------------------------------------------------------------------ マテリアル
function checkerTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 1024;
  const g = c.getContext('2d')!;
  const n = 16, s = 1024 / n;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const hue = (x / n) * 300;
    g.fillStyle = (x + y) % 2 ? `hsl(${hue},55%,62%)` : `hsl(${hue},30%,90%)`;
    g.fillRect(x * s, y * s, s, s);
    g.fillStyle = 'rgba(0,0,0,.55)'; g.font = `bold ${s * 0.32}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String.fromCharCode(65 + x) + (n - y), x * s + s / 2, y * s + s / 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
const matSolid = new THREE.MeshStandardMaterial({ color: 0xc9d3dd, roughness: 0.75, metalness: 0, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
const matUV = new THREE.MeshStandardMaterial({ map: checkerTexture(), roughness: 0.85, metalness: 0, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
const matWeight = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });

const { mesh, bones } = makeBaseMesh(matSolid);
scene.add(mesh);
const boneColor = BONES_V1.map((_, i) => new THREE.Color().setHSL(((i * 7) % 17) / 17, 0.75, 0.55));

// ワイヤーフレーム：四角形の辺だけ（三角形の対角線は出さない）。ポーズ時は CPU でスキニング
const edgePairs: number[] = [];
{
  const seen = new Set<number>();
  for (let k = 0; k < data.quads.length; k += 4) for (let j = 0; j < 4; j++) {
    const a = data.quads[k + j], b = data.quads[k + (j + 1) % 4];
    const key = Math.min(a, b) * 1e7 + Math.max(a, b);
    if (!seen.has(key)) { seen.add(key); edgePairs.push(a, b); }
  }
}
const repOf = new Int32Array(data.shapeCount).fill(-1); // 形の頂点 → 代表の GLB 頂点
data.shapeIndex.forEach((s, i) => { if (repOf[s] < 0) repOf[s] = i; });
const wireGeo = new THREE.BufferGeometry();
const wirePos = new Float32Array(data.shapeCount * 3);
wireGeo.setAttribute('position', new THREE.BufferAttribute(wirePos, 3));
wireGeo.setIndex(edgePairs);
const wire = new THREE.LineSegments(wireGeo, new THREE.LineBasicMaterial({ color: 0x0b1118, transparent: true, opacity: 0.55 }));
wire.visible = false;
scene.add(wire);
const tmp = new THREE.Vector3();
function updateWire() {
  mesh.updateMatrixWorld(true);
  for (let s = 0; s < data.shapeCount; s++) {
    mesh.getVertexPosition(repOf[s], tmp);
    wirePos[s * 3] = tmp.x; wirePos[s * 3 + 1] = tmp.y; wirePos[s * 3 + 2] = tmp.z;
  }
  wireGeo.attributes.position.needsUpdate = true;
  wireGeo.computeBoundingSphere();
}

// 骨格表示
const skelHelper = new THREE.SkeletonHelper(mesh);
(skelHelper.material as THREE.LineBasicMaterial).depthTest = false;
(skelHelper.material as THREE.LineBasicMaterial).linewidth = 2;
skelHelper.renderOrder = 10;
scene.add(skelHelper);
const jointDots: THREE.Mesh[] = [];
const dotGeo = new THREE.SphereGeometry(0.011, 12, 8);
bones.forEach((b, i) => {
  const m = new THREE.Mesh(dotGeo, new THREE.MeshBasicMaterial({ color: boneColor[i], depthTest: false }));
  m.renderOrder = 11;
  scene.add(m); jointDots.push(m);
});
function updateDots() {
  bones.forEach((b, i) => b.getWorldPosition(jointDots[i].position));
}

// ------------------------------------------------------------------ 表示モード
let shade: 'solid' | 'uv' | 'weight' = 'solid';
const wsel = $('#weightBone') as HTMLSelectElement;
wsel.innerHTML = `<option value="-1">全ボーン（色分け）</option>` + BONES_V1.map((b, i) => `<option value="${i}">${b.name}</option>`).join('');
function weightColors() {
  const sel = parseInt(wsel.value, 10);
  const n = data.positions.length / 3;
  const col = new Float32Array(n * 3);
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    let r = 0, g = 0, b = 0;
    if (sel < 0) {
      for (let j = 0; j < 4; j++) { const w = data.skinWeight[i * 4 + j]; if (!w) continue; const bc = boneColor[data.skinIndex[i * 4 + j]]; r += bc.r * w; g += bc.g * w; b += bc.b * w; }
    } else {
      let w = 0;
      for (let j = 0; j < 4; j++) if (data.skinIndex[i * 4 + j] === sel) w += data.skinWeight[i * 4 + j];
      // 0＝紺 → 0.5＝緑 → 1＝赤
      c.setHSL(0.66 * (1 - w), 0.85, 0.24 + 0.26 * Math.sqrt(Math.min(1, w * 4))); r = c.r; g = c.g; b = c.b;
    }
    col[i * 3] = r; col[i * 3 + 1] = g; col[i * 3 + 2] = b;
  }
  mesh.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
}
function applyShade() {
  mesh.material = shade === 'uv' ? matUV : shade === 'weight' ? matWeight : matSolid;
  wsel.hidden = shade !== 'weight';
  if (shade === 'weight') weightColors();
  document.querySelectorAll<HTMLButtonElement>('#shade button').forEach(b => b.classList.toggle('on', b.dataset.v === shade));
}
document.querySelectorAll<HTMLButtonElement>('#shade button').forEach(b => { b.onclick = () => { shade = b.dataset.v as typeof shade; applyShade(); }; });
wsel.onchange = () => weightColors();
const tWire = $('#tWire') as HTMLInputElement, tBone = $('#tBone') as HTMLInputElement;
tWire.onchange = () => { wire.visible = tWire.checked; if (wire.visible) updateWire(); };
tBone.onchange = () => { skelHelper.visible = tBone.checked; jointDots.forEach(d => { d.visible = tBone.checked; }); };

// ------------------------------------------------------------------ ポーズ（なめらかに切り替え）
let poseFrom: THREE.Euler[] = bones.map(b => b.rotation.clone());
let poseTo: THREE.Euler[] = poseFrom.map(e => e.clone());
let poseT = 1;
function setPose(p: PoseId) {
  poseFrom = bones.map(b => b.rotation.clone());
  const def = POSES[p];
  poseTo = bones.map(b => { const e = def[b.name] ?? [0, 0, 0]; return new THREE.Euler(...e.map(x => x * Math.PI / 180) as [number, number, number]); });
  poseT = 0;
  document.querySelectorAll<HTMLButtonElement>('#poses button').forEach(b => b.classList.toggle('on', b.dataset.p === p));
}
document.querySelectorAll<HTMLButtonElement>('#poses button').forEach(b => { b.onclick = () => setPose(b.dataset.p as PoseId); });

let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now(), dt = (now - last) / 1000; last = now;
  if (poseT < 1) {
    poseT = Math.min(1, poseT + dt / 0.45);
    const t = poseT * poseT * (3 - 2 * poseT);
    bones.forEach((b, i) => b.rotation.set(
      poseFrom[i].x + (poseTo[i].x - poseFrom[i].x) * t,
      poseFrom[i].y + (poseTo[i].y - poseFrom[i].y) * t,
      poseFrom[i].z + (poseTo[i].z - poseFrom[i].z) * t));
    mesh.updateMatrixWorld(true);
    if (wire.visible) updateWire();
  }
  updateDots();
  controls.update();
  renderer.render(scene, camera);
});

// ------------------------------------------------------------------ 視点
let viewHalf = 0.62;
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false);
  const a = w / h;
  camera.left = -viewHalf * a; camera.right = viewHalf * a; camera.top = viewHalf; camera.bottom = -viewHalf;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);
resize();
type View = 'front' | 'right' | 'back' | 'left' | 'top' | 'free';
const VIEW_DIR: Record<View, [number, number, number]> = {
  front: [0, 0, 1], right: [-1, 0, 0], back: [0, 0, -1], left: [1, 0, 0], top: [0, 1, 0], free: [-0.7, 0.4, 1],
};
function setView(v: View) {
  const center = new THREE.Vector3(0, 0.5, 0);
  camera.up.set(0, 1, 0);
  if (v === 'top') camera.up.set(0, 0, -1); // 上面図は「正面が画面の下」
  camera.position.copy(center).addScaledVector(new THREE.Vector3(...VIEW_DIR[v]).normalize(), 10);
  controls.target.copy(center);
  const a = stage.clientWidth / Math.max(1, stage.clientHeight);
  viewHalf = v === 'front' || v === 'back' || v === 'top' ? Math.max(0.58, 0.46 / a) : 0.58;
  camera.zoom = 1;
  resize();
  controls.update();
  document.querySelectorAll<HTMLButtonElement>('#views button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
}
document.querySelectorAll<HTMLButtonElement>('#views button').forEach(b => { b.onclick = () => setView(b.dataset.view as View); });
controls.addEventListener('start', () => {
  document.querySelectorAll<HTMLButtonElement>('#views button').forEach(b => b.classList.toggle('on', b.dataset.view === 'free'));
});

// ------------------------------------------------------------------ 情報
const ok = (b: boolean) => b ? '<b class="ok">✓</b>' : '<b class="ng">✗</b>';
const fmt = (n: number) => n.toLocaleString('en-US');
function renderStats(fixed: string) {
  const s = data.stats;
  $('#stats').innerHTML = [
    ['バージョン', BASE_MESH_VERSION],
    ['頂点数（GLB）', `${fmt(s.vertices)} <small>（形の頂点 ${fmt(s.shapeVertices)}、UV の継ぎ目で分割）</small>`],
    ['三角形数', `${fmt(s.triangles)} <small>（四角形 ${fmt(s.quads)}）</small>`],
    ['ボーン数', String(s.bones)],
    ['UV', ok(true) + ' あり'],
    ['スキンウェイト', ok(true) + ' あり（1頂点あたり最大4ボーン）'],
    ['閉じた1枚のメッシュ', `${ok(s.closed && s.euler === 2)} 穴なし（オイラー数 ${s.euler}）`],
    ['面の向き', `${ok(s.manifold)} すべて外向きに揃っている`],
    ['形の指紋', `<code>${HASH}</code>`],
    ['固定データとの一致', fixed],
  ].map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('');
  $('#info').textContent = `${BASE_MESH_VERSION}  ${fmt(s.vertices)} verts / ${fmt(s.triangles)} tris / ${s.bones} bones`;
}
renderStats('確認中…');

// 固定データ（samples/e118_base_mesh_v1.glb）と、この場で作った V1 が完全に同じかを確認
async function checkFixed() {
  try {
    const res = await fetch('./samples/e118_base_mesh_v1.glb', { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const glb = await res.arrayBuffer();
    const g = await new GLTFLoader().parseAsync(glb, './');
    let sk: THREE.SkinnedMesh | null = null;
    g.scene.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) sk = o as THREE.SkinnedMesh; });
    if (!sk) throw new Error('SkinnedMesh なし');
    const geo = (sk as THREE.SkinnedMesh).geometry;
    const idx = geo.index!.array, pos = geo.attributes.position.array as Float32Array, uv = geo.attributes.uv.array as Float32Array;
    const si = geo.attributes.skinIndex.array;
    let same = idx.length === data.index.length && pos.length === data.positions.length && si.length === data.skinIndex.length;
    if (same) for (let i = 0; i < idx.length; i++) if (idx[i] !== data.index[i]) { same = false; break; }
    if (same) for (let i = 0; i < si.length; i++) if (si[i] !== data.skinIndex[i]) { same = false; break; }
    let dp = 0, du = 0;
    if (same) {
      for (let i = 0; i < pos.length; i++) dp = Math.max(dp, Math.abs(pos[i] - data.positions[i]));
      for (let i = 0; i < uv.length; i++) du = Math.max(du, Math.abs(uv[i] - data.uvs[i]));
    }
    const match = same && dp < 1e-5 && du < 1e-6;
    renderStats(match ? `${ok(true)} 頂点番号・面・UV・ボーンが完全一致` : `${ok(false)} 不一致（${same ? `位置のずれ ${dp.toExponential(1)}` : '番号・面が違う'}）`);
    $('#fixedNote').textContent = 'Phase 3 のフィッティングは、この固定データの「頂点の位置」だけを動かします。頂点数・頂点番号・面・UV・ボーンは全キャラで共通です。';
  } catch (e) {
    renderStats(`${ok(false)} 固定データを読めません（${(e as Error).message}）`);
  }
}
checkFixed();

// ボーン対応表
$('#boneTable').innerHTML = '<tr><th>#</th><th>ボーン</th><th>SHEET 2 関節</th><th>親</th></tr>' + BONES_V1.map((b, i) =>
  `<tr><td>${i}</td><td><i class="dot" style="background:#${boneColor[i].getHexString()}"></i>${b.name}</td><td>${b.joint}</td><td>${b.parent < 0 ? '—' : BONES_V1[b.parent].name}</td></tr>`).join('');

// UV 展開図
{
  const cv = $('#uvCanvas') as HTMLCanvasElement, g = cv.getContext('2d')!;
  const S = cv.width;
  g.fillStyle = '#0b0f14'; g.fillRect(0, 0, S, S);
  const partColor: Partial<Record<Part, string>> = {};
  (Object.keys(UV_LAYOUT) as Part[]).forEach((p, i) => { partColor[p] = `hsl(${(i * 47) % 360},60%,55%)`; });
  // 四角形を部位の色で塗り、辺を描く
  const uv = data.uvs;
  const tri = data.index;
  g.lineWidth = 0.6;
  for (let k = 0; k < data.quadPart.length; k++) {
    const p = data.quadPart[k];
    const a = tri[k * 6], b = tri[k * 6 + 1], c = tri[k * 6 + 2], d = tri[k * 6 + 5];
    g.beginPath();
    for (const [j, v] of [a, b, c, d].entries()) { const x = uv[v * 2] * S, y = (1 - uv[v * 2 + 1]) * S; if (j) g.lineTo(x, y); else g.moveTo(x, y); }
    g.closePath();
    g.fillStyle = partColor[p]!; g.globalAlpha = 0.28; g.fill();
    g.globalAlpha = 0.85; g.strokeStyle = partColor[p]!; g.stroke();
  }
  g.globalAlpha = 1;
  g.fillStyle = '#fff'; g.font = 'bold 22px sans-serif'; g.textAlign = 'center';
  const label: Partial<Record<Part, string>> = { head: 'HEAD（中央＝顔）', torso: 'TORSO', neck: 'NECK', torsoCap: 'SHOULDER TOP', armL: 'ARM L', armR: 'ARM R', handL: 'HAND L', handR: 'HAND R', handTipL: 'TIP L', handTipR: 'TIP R', legL: 'LEG L', legR: 'LEG R', footL: 'FOOT L', footR: 'FOOT R', soleL: 'SOLE L', soleR: 'SOLE R' };
  for (const [p, r] of Object.entries(UV_LAYOUT) as [Part, number[]][]) {
    g.font = `bold ${p.startsWith('hand') || p.startsWith('sole') ? 15 : 22}px sans-serif`;
    g.fillText(label[p] ?? p, (r[0] + r[2]) / 2 * S, (1 - r[3]) * S + 22);
  }
}

// ------------------------------------------------------------------ GLB 書き出し＋検証
let lastGlb: ArrayBuffer | null = null;
async function exportGlb(): Promise<ArrayBuffer> {
  const { mesh: m } = makeBaseMesh(); // 表示用とは別の、T ポーズのままの新しい V1
  return await new GLTFExporter().parseAsync(m, { binary: true }) as ArrayBuffer;
}
function glbJson(buf: ArrayBuffer) {
  const dv = new DataView(buf);
  const len = dv.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, len)));
}
async function verifyGlb(buf: ArrayBuffer) {
  const j = glbJson(buf);
  const prim = j.meshes?.[0]?.primitives?.[0] ?? {};
  const at = prim.attributes ?? {};
  const g = await new GLTFLoader().parseAsync(buf.slice(0), './');
  let sk: THREE.SkinnedMesh | null = null;
  g.scene.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) sk = o as THREE.SkinnedMesh; });
  const s = sk as THREE.SkinnedMesh | null;
  const geo = s?.geometry;
  const vcount = geo?.attributes.position.count ?? 0;
  const tcount = geo?.index ? geo.index.count / 3 : 0;
  const nb = s?.skeleton.bones.length ?? 0;
  const names = s ? s.skeleton.bones.map(b => b.name).join(',') === BONES_V1.map(b => b.name).join(',') : false;
  const rows: [string, boolean, string][] = [
    ['Mesh', !!s, s ? `SkinnedMesh「${s.name}」` : 'なし'],
    ['頂点数', vcount === data.stats.vertices, fmt(vcount)],
    ['三角形数', tcount === data.stats.triangles, fmt(tcount)],
    ['UV（TEXCOORD_0）', at.TEXCOORD_0 !== undefined, at.TEXCOORD_0 !== undefined ? 'あり' : 'なし'],
    ['法線（NORMAL）', at.NORMAL !== undefined, at.NORMAL !== undefined ? 'あり' : 'なし'],
    ['Material', (j.materials?.length ?? 0) > 0 && prim.material !== undefined, j.materials?.[0]?.name ?? 'なし'],
    ['Skeleton', (j.skins?.[0]?.joints?.length ?? 0) === 17 && nb === 17, `${nb} ボーン${names ? '（名前・順番も一致）' : ''}`],
    ['Skin Weight', at.JOINTS_0 !== undefined && at.WEIGHTS_0 !== undefined, at.JOINTS_0 !== undefined && at.WEIGHTS_0 !== undefined ? 'JOINTS_0 / WEIGHTS_0 あり' : 'なし'],
    ['ファイルサイズ', true, `${(buf.byteLength / 1024).toFixed(0)} KB`],
  ];
  return { rows, pass: rows.every(r => r[1]) };
}
$('#btnExport').onclick = async () => {
  const btn = $('#btnExport') as HTMLButtonElement;
  btn.disabled = true; btn.textContent = '書き出し中…';
  try {
    lastGlb = await exportGlb();
    const v = await verifyGlb(lastGlb);
    const t = $('#glbCheck');
    t.hidden = false;
    t.innerHTML = v.rows.map(([k, b, d]) => `<tr><th>${k}</th><td>${ok(b)} ${d}</td></tr>`).join('') +
      `<tr><th>判定</th><td>${v.pass ? '<b class="ok">合格：書き出した GLB を読み直して、すべて入っていることを確認しました</b>' : '<b class="ng">不合格</b>'}</td></tr>`;
    $('#btnSave').hidden = false;
  } catch (e) {
    toast('書き出しに失敗しました：' + (e as Error).message);
  } finally {
    btn.disabled = false; btn.textContent = 'GLB を書き出して検証';
  }
};
$('#btnSave').onclick = async () => {
  if (!lastGlb) return;
  const blob = new Blob([lastGlb], { type: 'model/gltf-binary' });
  const file = new File([blob], 'e118_base_mesh_v1.glb', { type: 'model/gltf-binary' });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (/iPhone|iPad|iPod/.test(navigator.userAgent) && nav.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if ((e as Error).name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'e118_base_mesh_v1.glb'; a.click();
};

let toastTimer = 0;
function toast(msg: string) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast'; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = window.setTimeout(() => { t.hidden = true; }, 4500);
}

// テスト用フック
(window as unknown as { __base: unknown }).__base = {
  data, HASH, setPose, setView, scene, mesh, bones, camera, controls,
  setShade: (s: typeof shade, bone = -1) => { shade = s; wsel.value = String(bone); applyShade(); },
  setWire: (v: boolean) => { tWire.checked = v; tWire.onchange?.(new Event('change')); },
  exportGlb, verifyGlb,
  glbBase64: async () => { const b = new Uint8Array(await exportGlb()); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); },
};
setView('free');
