// Phase 4 画面：JOINT & RIG（全画面の作業画面）
// Phase 1〜3 は window.__sheet / window.__fit を読むだけ。3D画面もこの画面専用に持つ（メイン画面の操作と競合しない）。
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { JointId } from './sheetSpec';
import type { ViewId, Sheet1, Joints } from './sheetParse';
import type { HullResult } from './hull';
import type { FitResult } from './fit';
import { buildBaseMeshData, BONES_V1, BASE_MESH_VERSION } from './basemesh';
import { autoJoints, computeWeights, PRESETS, type PresetId, JOINT_ORDER, toRigJSON, type RigJSON, type RigWeights, type V3, type Joints3, RIG_VERSION } from './rig';

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const data = buildBaseMeshData();
const STORE_KEY = 'e118.rig.v1';
const deg = Math.PI / 180;
type SheetHook = { state: { s1: Sheet1 | null; joints: Joints | null; hull: HullResult | null } };
const sheet = () => (window as unknown as { __sheet?: SheetHook }).__sheet ?? null;
const fitRes = () => (window as unknown as { __fit?: { result?: FitResult } }).__fit?.result ?? null;

// ------------------------------------------------------------------ 状態
let positions = data.positions.slice();      // GLB の頂点の並び
let joints: Joints3 = structuredClone(data.joints) as Joints3;
let source = 'Standard Base Mesh V1';
let weights: RigWeights | null = null;
let symmetric = true, center = 0;
let mode: 'edit' | 'pose' = 'edit';
let selected: JointId = 'SHOULDER_L';
const rot: Record<string, [number, number, number]> = {};
let hipsDrop = 0;
let mirrorEdit = true;

// ------------------------------------------------------------------ 3D
let renderer: THREE.WebGLRenderer | null = null;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0e131a);
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -50, 50);
scene.add(new THREE.HemisphereLight(0xe6efff, 0x2a2018, 1.5));
const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(2, 3, 4); scene.add(key);
const rim = new THREE.DirectionalLight(0x9fc8ff, 0.6); rim.position.set(-3, 2, -3); scene.add(rim);
scene.add(new THREE.GridHelper(2, 20, 0x2b3a4a, 0x18212c));
let controls: OrbitControls;
let tcontrols: TransformControls | null = null;
const tcProxy = new THREE.Object3D(); scene.add(tcProxy);
const finePointer = matchMedia('(pointer: fine)').matches;

const matSolid = new THREE.MeshStandardMaterial({ color: 0xe8c9a8, roughness: 0.7, metalness: 0, transparent: true, opacity: 1 });
const matWeight = new THREE.MeshLambertMaterial({ vertexColors: true });
let mesh: THREE.Mesh | THREE.SkinnedMesh | null = null;
let bones: THREE.Bone[] = [];

// 骨格の表示：関節＝球、ボーン＝細い円柱
const skelGroup = new THREE.Group(); scene.add(skelGroup);
const jointGroup = new THREE.Group(); scene.add(jointGroup);
const linkGeo = new THREE.CylinderGeometry(0.006, 0.006, 1, 8); linkGeo.translate(0, 0.5, 0);
const linkMat = new THREE.MeshBasicMaterial({ color: 0x36e3c4, depthTest: false, transparent: true });
const links = BONES_V1.filter(b => b.parent >= 0).map(b => {
  const m = new THREE.Mesh(linkGeo, linkMat); m.renderOrder = 20; skelGroup.add(m);
  return { m, from: BONES_V1[b.parent].joint, to: b.joint };
});
const jointColor = (k: JointId) => k.endsWith('_L') ? 0xff6b9a : k.endsWith('_R') ? 0x5aa9ff : 0xffe066;
const dotGeo = new THREE.SphereGeometry(0.014, 16, 12);
const hitGeo = new THREE.SphereGeometry(0.038, 8, 6);
const hitMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });
const dots = Object.fromEntries(JOINT_ORDER.map(k => {
  const m = new THREE.Mesh(dotGeo, new THREE.MeshBasicMaterial({ color: jointColor(k), depthTest: false, depthWrite: false, transparent: true }));
  m.renderOrder = 21; m.userData.joint = k;
  const hit = new THREE.Mesh(hitGeo, hitMat); hit.userData.joint = k; m.add(hit);
  jointGroup.add(m);
  return [k, m];
})) as unknown as Record<JointId, THREE.Mesh>;

// Visual Hull・元の絵
let hullMesh: THREE.Mesh | null = null;
const sheetPlanes: Partial<Record<ViewId, THREE.Mesh>> = {};
let currentView: ViewId | 'free' = 'front';

// ------------------------------------------------------------------ メッシュ
function shapeNormals(pos: Float32Array): Float32Array {
  const P = new Float32Array(data.shapeCount * 3);
  data.shapeIndex.forEach((s, i) => { P[s * 3] = pos[i * 3]; P[s * 3 + 1] = pos[i * 3 + 1]; P[s * 3 + 2] = pos[i * 3 + 2]; });
  const N = new Float32Array(data.shapeCount * 3);
  const q = data.quads;
  for (let k = 0; k < q.length; k += 4) {
    const a = q[k], b = q[k + 1], c = q[k + 2], d = q[k + 3];
    const e1 = [P[c * 3] - P[a * 3], P[c * 3 + 1] - P[a * 3 + 1], P[c * 3 + 2] - P[a * 3 + 2]];
    const e2 = [P[d * 3] - P[b * 3], P[d * 3 + 1] - P[b * 3 + 1], P[d * 3 + 2] - P[b * 3 + 2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    for (const v of [a, b, c, d]) { N[v * 3] += n[0]; N[v * 3 + 1] += n[1]; N[v * 3 + 2] += n[2]; }
  }
  const out = new Float32Array(positions.length);
  data.shapeIndex.forEach((s, i) => {
    const x = N[s * 3], y = N[s * 3 + 1], z = N[s * 3 + 2], l = Math.hypot(x, y, z) || 1;
    out[i * 3] = x / l; out[i * 3 + 1] = y / l; out[i * 3 + 2] = z / l;
  });
  return out;
}
function makeGeometry(withSkin: boolean) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions.slice(), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(shapeNormals(positions), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(data.uvs.slice(), 2));
  if (withSkin && weights) {
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(weights.skinIndex.slice(), 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(weights.skinWeight.slice(), 4));
  }
  g.setIndex(new THREE.BufferAttribute(data.index.slice(), 1));
  g.computeBoundingSphere();
  return g;
}
function makeBones(J: Joints3) {
  const bs = BONES_V1.map(b => { const o = new THREE.Bone(); o.name = b.name; return o; });
  BONES_V1.forEach((b, i) => {
    const p = J[b.joint];
    if (b.parent < 0) bs[i].position.set(...p);
    else { const q = J[BONES_V1[b.parent].joint]; bs[i].position.set(p[0] - q[0], p[1] - q[1], p[2] - q[2]); bs[b.parent].add(bs[i]); }
  });
  return bs;
}
/** 骨格つき（AUTO RIG 後）か、形だけ（前）でメッシュを作り直す */
function rebuildMesh() {
  if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); }
  if (weights) {
    const m = new THREE.SkinnedMesh(makeGeometry(true), matSolid);
    bones = makeBones(joints);
    m.add(bones[0]);
    m.bind(new THREE.Skeleton(bones));
    mesh = m;
  } else {
    mesh = new THREE.Mesh(makeGeometry(false), matSolid);
    bones = [];
  }
  mesh.name = 'E118_Rigged_V1';
  scene.add(mesh);
  applyPose();
  applyView();
}

// ------------------------------------------------------------------ 表示更新
const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
function jointWorld(k: JointId, out: THREE.Vector3) {
  if (mode === 'pose' && bones.length) { mesh!.updateMatrixWorld(true); return bones[JOINT_ORDER.indexOf(k)].getWorldPosition(out); }
  return out.set(...joints[k]);
}
function updateSkeleton() {
  for (const k of JOINT_ORDER) {
    jointWorld(k, dots[k].position);
    const sel = k === selected;
    dots[k].scale.setScalar(sel ? 1.7 : 1);
    (dots[k].material as THREE.MeshBasicMaterial).color.setHex(sel ? 0xffffff : jointColor(k));
  }
  for (const l of links) {
    tmpA.copy(dots[l.from].position); tmpB.copy(dots[l.to].position);
    const d = tmpB.clone().sub(tmpA), L = d.length();
    l.m.position.copy(tmpA);
    l.m.scale.set(1, Math.max(L, 1e-4), 1);
    l.m.quaternion.setFromUnitVectors(up, d.normalize());
  }
  if (tcontrols && mode === 'edit') tcProxy.position.set(...joints[selected]);
}
function weightColors() {
  if (!mesh || !weights) return;
  const b = JOINT_ORDER.indexOf(selected);
  const n = positions.length / 3, col = new Float32Array(n * 3), c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    let w = 0;
    for (let j = 0; j < 4; j++) if (weights.skinIndex[i * 4 + j] === b) w += weights.skinWeight[i * 4 + j];
    c.setHSL(0.66 * (1 - w), 0.85, 0.24 + 0.26 * Math.sqrt(Math.min(1, w * 4)));
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  mesh.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
}
const chk = (id: string) => $<HTMLInputElement>(id).checked;
function applyView() {
  if (mesh) {
    mesh.visible = chk('#rvMesh');
    const wv = chk('#rvWeight') && !!weights;
    mesh.material = wv ? matWeight : matSolid;
    if (wv) weightColors();
    matSolid.opacity = chk('#rvSheets') || chk('#rvHull') ? 0.75 : 1;
    matSolid.depthWrite = matSolid.opacity === 1;
  }
  skelGroup.visible = chk('#rvSkel');
  jointGroup.visible = chk('#rvJoint');
  if (hullMesh) hullMesh.visible = chk('#rvHull');
  for (const [id, p] of Object.entries(sheetPlanes)) p!.visible = chk('#rvSheets') && currentView === id;
  $('#rvWeightNote').hidden = !chk('#rvWeight');
  $('#rvWeightNote').textContent = weights ? `WEIGHT VIEW：${BONES_V1[JOINT_ORDER.indexOf(selected)].name}（${selected}）　紺＝0 → 赤＝1` : 'AUTO RIG の後に表示できます';
}

// ------------------------------------------------------------------ 視点
let viewHalf = 0.62;
function resize() {
  if (!renderer) return;
  const st = $('#rigStage');
  const w = st.clientWidth, h = st.clientHeight;
  renderer.setSize(w, h, false);
  const a = w / Math.max(1, h);
  camera.left = -viewHalf * a; camera.right = viewHalf * a; camera.top = viewHalf; camera.bottom = -viewHalf;
  camera.updateProjectionMatrix();
}
const VIEW_DIR: Record<ViewId | 'free', [number, number, number]> = { front: [0, 0, 1], right: [-1, 0, 0], back: [0, 0, -1], left: [1, 0, 0], top: [0, 1, 0], free: [-0.7, 0.4, 1] };
function setView(v: ViewId | 'free') {
  currentView = v;
  const c = new THREE.Vector3(0, 0.5, 0);
  camera.up.set(0, 1, 0);
  if (v === 'top') camera.up.set(0, 0, -1);
  camera.position.copy(c).addScaledVector(new THREE.Vector3(...VIEW_DIR[v]).normalize(), 10);
  controls.target.copy(c);
  camera.zoom = 1;
  const st = $('#rigStage'), a = st.clientWidth / Math.max(1, st.clientHeight);
  viewHalf = v === 'front' || v === 'back' || v === 'top' ? Math.max(0.56, 0.46 / a) : 0.56;
  resize(); controls.update();
  document.querySelectorAll<HTMLButtonElement>('#rigViews button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  applyView();
}

// ------------------------------------------------------------------ 元の絵・Visual Hull
function buildSheetObjects() {
  for (const p of Object.values(sheetPlanes)) { scene.remove(p!); }
  if (hullMesh) { scene.remove(hullMesh); hullMesh = null; }
  const st = sheet()?.state;
  if (!st?.s1) return;
  const W = st.hull?.W ?? 0.9, D = st.hull?.D ?? 0.4;
  for (const id of ['front', 'right', 'back', 'left', 'top'] as ViewId[]) {
    const v = st.s1.views[id]; if (!v) continue;
    const s = v.src, tex = new THREE.CanvasTexture(s.canvas); tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide });
    let m: THREE.Mesh;
    if (id === 'top') {
      m = new THREE.Mesh(new THREE.PlaneGeometry(W, D), mat); m.rotation.x = -Math.PI / 2; m.position.set(0, -0.002, 0);
    } else {
      m = new THREE.Mesh(new THREE.PlaneGeometry(s.w / s.h, 1), mat);
      const r = { front: 0, back: Math.PI, right: -Math.PI / 2, left: Math.PI / 2 }[id];
      m.rotation.y = r;
      const back = 0.7;
      m.position.set(id === 'right' ? back : id === 'left' ? -back : 0, 0.5, id === 'front' ? -back : id === 'back' ? back : 0);
    }
    m.renderOrder = -1; m.visible = false;
    scene.add(m); sheetPlanes[id] = m;
  }
  if (st.hull) {
    hullMesh = new THREE.Mesh(st.hull.geometry, new THREE.MeshStandardMaterial({ color: 0x5aa9ff, transparent: true, opacity: 0.28, depthWrite: false, roughness: 0.6 }));
    hullMesh.renderOrder = 5; hullMesh.visible = false; scene.add(hullMesh);
  }
}

// ------------------------------------------------------------------ ポーズ
let poseFrom: Record<string, [number, number, number]> = {}, poseTo: Record<string, [number, number, number]> = {}, poseT = 1;
let dropFrom = 0, dropTo = 0;
function applyPose() {
  if (!bones.length) return;
  BONES_V1.forEach((b, i) => { const r = rot[b.name] ?? [0, 0, 0]; bones[i].rotation.set(r[0] * deg, r[1] * deg, r[2] * deg); });
  const thigh = Math.hypot(...joints.KNEE_L.map((v, i) => v - joints.HIP_L[i]) as V3);
  bones[0].position.set(joints.HIPS[0], joints.HIPS[1] - hipsDrop * thigh, joints.HIPS[2]);
}
function setPreset(p: PresetId | 'RESET') {
  poseFrom = structuredClone(rot); dropFrom = hipsDrop;
  const def = p === 'RESET' ? PRESETS.T : PRESETS[p];
  poseTo = {}; for (const b of BONES_V1) poseTo[b.name] = def.rot[b.name] ?? [0, 0, 0];
  dropTo = def.hipsDrop ?? 0;
  poseT = 0;
  document.querySelectorAll<HTMLButtonElement>('#rigPresets button').forEach(b => b.classList.toggle('on', b.dataset.p === p && p !== 'RESET'));
}
function tickPose(dt: number) {
  if (poseT >= 1) return;
  poseT = Math.min(1, poseT + dt / 0.35);
  const t = poseT * poseT * (3 - 2 * poseT);
  for (const b of BONES_V1) {
    const a = poseFrom[b.name] ?? [0, 0, 0], c = poseTo[b.name] ?? [0, 0, 0];
    rot[b.name] = [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t, a[2] + (c[2] - a[2]) * t];
  }
  hipsDrop = dropFrom + (dropTo - dropFrom) * t;
  applyPose(); syncRotUI();
}

// ------------------------------------------------------------------ 操作パネル
const AX = ['X', 'Y', 'Z'];
function syncJointUI() {
  $<HTMLSelectElement>('#rjSel').value = selected;
  const p = joints[selected];
  AX.forEach((_, i) => {
    $<HTMLInputElement>(`#rjR${i}`).value = String(p[i]);
    $(`#rjV${i}`).textContent = p[i].toFixed(3);
  });
  $('#rjNote').textContent = jointNotes[selected] ?? '';
}
function syncRotUI() {
  const b = BONES_V1[JOINT_ORDER.indexOf(selected)];
  $('#rpBone').textContent = `${selected} → ${b.name}`;
  const r = rot[b.name] ?? [0, 0, 0];
  AX.forEach((_, i) => { $<HTMLInputElement>(`#rpR${i}`).value = String(Math.round(r[i])); $(`#rpV${i}`).textContent = `${Math.round(r[i])}°`; });
}
const mirrorOf = (k: JointId): JointId | null => k.endsWith('_L') ? k.replace(/_L$/, '_R') as JointId : k.endsWith('_R') ? k.replace(/_R$/, '_L') as JointId : null;
function setJoint(k: JointId, p: V3, final: boolean) {
  joints[k] = p;
  if (mirrorEdit) {
    const m = mirrorOf(k);
    if (m) joints[m] = [2 * center - p[0], p[1], p[2]];
    else joints[k] = [center, p[1], p[2]];
  }
  syncJointUI();
  if (final && weights) autoRig(true);
}
function select(k: JointId) {
  selected = k;
  syncJointUI(); syncRotUI();
  if (tcontrols && mode === 'edit') { tcontrols.attach(tcProxy); }
  applyView();
}
function setMode(m: 'edit' | 'pose') {
  if (m === 'pose' && !weights) { toast('先に AUTO RIG を押してください'); return; }
  mode = m;
  if (m === 'edit') { for (const k in rot) delete rot[k]; hipsDrop = 0; applyPose(); }
  $('#rigMode').textContent = m === 'edit' ? 'JOINT EDIT' : 'POSE TEST';
  $<HTMLButtonElement>('#btnPose').classList.toggle('on', m === 'pose');
  $<HTMLButtonElement>('#btnPose').textContent = m === 'pose' ? 'POSE TEST を終了（関節の調整に戻る）' : 'POSE TEST';
  $('#rigEditBox').classList.toggle('disabled', m === 'pose');
  $('#rigPoseBox').hidden = m !== 'pose';
  if (tcontrols) { if (m === 'edit') tcontrols.attach(tcProxy); else tcontrols.detach(); }
  syncRotUI();
}

// ------------------------------------------------------------------ AUTO JOINT / AUTO RIG
let jointNotes: Partial<Record<JointId, string>> = {};
function runAutoJoint() {
  const st = sheet()?.state;
  if (!st?.joints || !st.s1 || !st.hull) {
    joints = structuredClone(fitRes()?.joints ?? data.joints) as Joints3;
    center = 0; symmetric = true; jointNotes = {};
    $('#rjStatus').textContent = 'SHEET の解析と Visual Hull がまだ無いため、Base Mesh V1 の関節位置を使いました。';
  } else {
    const use: Record<string, boolean> = {};
    document.querySelectorAll<HTMLInputElement>('#useViews input').forEach(i => { use[i.dataset.v!] = i.checked; });
    const views: Partial<Record<ViewId, import('./mask').SourceImage>> = {};
    for (const id of ['front', 'right', 'back', 'left', 'top'] as ViewId[]) if (st.s1.views[id] && use[id] !== false) views[id] = st.s1.views[id]!.src;
    const r = autoJoints({ sheetJoints: st.joints, views, W: st.hull.W, D: st.hull.D });
    joints = r.joints; symmetric = r.symmetric; center = r.center; jointNotes = r.notes;
    const fixed = Object.values(r.notes).filter(n => n.includes('補正')).length;
    $('#rjStatus').innerHTML = `17関節の3D位置を推定しました。左右対称：<b>${r.symmetric ? 'はい（中心面でそろえました）' : 'いいえ（左右別々）'}</b>　補正した関節：${fixed}`;
    mirrorEdit = r.symmetric; $<HTMLInputElement>('#rjMirror').checked = mirrorEdit;
  }
  syncJointUI();
  if (weights) autoRig(true);
}
function extras() {
  // 頭頂・指先（ボーンの先端）をメッシュから
  const parts = new Array<string>(data.shapeCount);
  for (let k = 0; k < data.quadPart.length; k++) for (let j = 0; j < 4; j++) parts[data.quads[k * 4 + j]] = data.quadPart[k];
  let top = -1, tl = -Infinity, tr = Infinity; let tipL: V3 = joints.WRIST_L, tipR: V3 = joints.WRIST_R;
  data.shapeIndex.forEach((s, i) => {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (parts[s] === 'head') top = Math.max(top, y);
    if (parts[s] === 'handTipL' && x > tl) { tl = x; tipL = [x, y, z]; }
    if (parts[s] === 'handTipR' && x < tr) { tr = x; tipR = [x, y, z]; }
  });
  return { headTop: [joints.HEAD[0], top, joints.HEAD[2]] as V3, tipL, tipR };
}
function autoRig(silent = false) {
  const t0 = performance.now();
  weights = computeWeights(data, positions, joints, extras(), center);
  rebuildMesh();
  const L = weights.leak;
  $('#rrStatus').innerHTML = [
    `<b class="ok">✓</b> SkinnedMesh を作り、17ボーンを Bind しました（${Math.round(performance.now() - t0)} ms）`,
    `<b class="ok">✓</b> 1頂点あたり最大4ボーン・合計 1.0`,
    `${L.armToOtherSide + L.legToOtherSide === 0 ? '<b class="ok">✓</b>' : '<b class="ng">!</b>'} 左右への漏れ：腕 ${L.armToOtherSide}・脚 ${L.legToOtherSide} 頂点`,
    `${L.armToHead === 0 ? '<b class="ok">✓</b>' : '<b class="ng">!</b>'} 腕のウェイトが頭・首に入った頂点：${L.armToHead}`,
  ].join('<br>');
  $<HTMLButtonElement>('#btnPose').disabled = false;
  if (!silent) toast('AUTO RIG 完了。POSE TEST で動かせます');
}

// ------------------------------------------------------------------ 保存・復元
function saveRig() {
  const shape = new Float32Array(data.shapeCount * 3);
  data.shapeIndex.forEach((s, i) => { shape[s * 3] = positions[i * 3]; shape[s * 3 + 1] = positions[i * 3 + 1]; shape[s * 3 + 2] = positions[i * 3 + 2]; });
  const j = toRigJSON({ joints, rotations: structuredClone(rot), hipsDrop, shape, skin: weights, symmetric, center });
  try { localStorage.setItem(STORE_KEY, JSON.stringify(j)); toast('Rig を保存しました（再読み込みしても復元できます）'); }
  catch (e) { toast('保存できません：' + (e as Error).message); }
  updateSavedNote();
  return j;
}
function loadSaved(): RigJSON | null {
  try { const s = localStorage.getItem(STORE_KEY); if (!s) return null; const j = JSON.parse(s) as RigJSON; return j.format === RIG_VERSION && j.baseMesh === BASE_MESH_VERSION ? j : null; } catch { return null; }
}
function restore(j: RigJSON) {
  positions = new Float32Array(data.positions.length);
  data.shapeIndex.forEach((s, i) => { positions[i * 3] = j.shape[s * 3]; positions[i * 3 + 1] = j.shape[s * 3 + 1]; positions[i * 3 + 2] = j.shape[s * 3 + 2]; });
  joints = structuredClone(j.joints) as Joints3;
  symmetric = j.symmetric; center = j.center;
  weights = j.skin ? { skinIndex: new Uint16Array(j.skin.index), skinWeight: new Float32Array(j.skin.weight), leak: { armToOtherSide: 0, legToOtherSide: 0, armToHead: 0 } } : null;
  for (const k in rot) delete rot[k];
  Object.assign(rot, j.rotations); hipsDrop = j.hipsDrop ?? 0;
  source = `保存した Rig（${new Date(j.savedAt).toLocaleString('ja-JP')}）`;
  $('#rigSource').textContent = source;
  rebuildMesh();
  if (weights) { $<HTMLButtonElement>('#btnPose').disabled = false; $('#rrStatus').innerHTML = '<b class="ok">✓</b> 保存した Rig（関節・ウェイト）を復元しました'; if (Object.keys(rot).length) setMode('pose'); }
  syncJointUI(); syncRotUI();
}
function updateSavedNote() {
  const j = loadSaved();
  const t = j ? `保存した Rig：${new Date(j.savedAt).toLocaleString('ja-JP')}` : '保存した Rig はありません';
  $('#rsNote').textContent = t; $('#rigSavedCard').textContent = j ? t : '';
  $<HTMLButtonElement>('#btnRestore').disabled = !j;
}
async function shareFile(buf: BlobPart, name: string, type: string) {
  const blob = new Blob([buf], { type });
  const file = new File([blob], name, { type });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (/iPhone|iPad|iPod/.test(navigator.userAgent) && nav.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if ((e as Error).name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
}
async function exportGlb() {
  if (!weights) { toast('先に AUTO RIG を押してください'); return; }
  const m = new THREE.SkinnedMesh(makeGeometry(true), new THREE.MeshStandardMaterial({ color: 0xe8c9a8, roughness: 0.7 }));
  (m.material as THREE.Material).name = 'E118_Rigged_V1'; m.name = 'E118_Rigged_V1';
  const bs = makeBones(joints); m.add(bs[0]); m.bind(new THREE.Skeleton(bs));
  const buf = await new GLTFExporter().parseAsync(m, { binary: true }) as ArrayBuffer;
  const g = await new GLTFLoader().parseAsync(buf.slice(0), './');
  let sk: THREE.SkinnedMesh | null = null;
  g.scene.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) sk = o as THREE.SkinnedMesh; });
  const s = sk as THREE.SkinnedMesh | null;
  const okk = !!s && s.skeleton.bones.length === 17 && !!s.geometry.attributes.skinWeight && !!s.geometry.attributes.uv;
  $('#rsGlb').innerHTML = okk ? `<b class="ok">✓</b> GLB を読み直して確認：SkinnedMesh・17ボーン・Skin Weight・UV（${(buf.byteLength / 1024).toFixed(0)} KB）` : '<b class="ng">✗</b> GLB の確認に失敗';
  lastGlb = buf;
  $<HTMLButtonElement>('#btnGlbSave').hidden = false;
}
let lastGlb: ArrayBuffer | null = null;

// ------------------------------------------------------------------ タップ・ドラッグ
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
let dragging: { k: JointId; plane: THREE.Plane; moved: boolean } | null = null;
let downAt: { x: number; y: number } | null = null;
function pick(e: PointerEvent): JointId | null {
  if (!jointGroup.visible) return null;
  const r = renderer!.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObjects(jointGroup.children, true);
  return hits.length ? hits[0].object.userData.joint as JointId : null;
}
function onDown(e: PointerEvent) {
  downAt = { x: e.clientX, y: e.clientY };
  const k = pick(e);
  if (!k) return;
  // 関節をつかんだら、その間はカメラ操作を止める
  controls.enabled = false;
  select(k);
  if (mode === 'edit' && !finePointer) {
    const n = new THREE.Vector3(); camera.getWorldDirection(n);
    dragging = { k, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(n, new THREE.Vector3(...joints[k])), moved: false };
    renderer!.domElement.setPointerCapture(e.pointerId);
  }
}
function onMove(e: PointerEvent) {
  if (!dragging) return;
  const r = renderer!.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const p = new THREE.Vector3();
  if (ray.ray.intersectPlane(dragging.plane, p)) { dragging.moved = true; setJoint(dragging.k, [p.x, p.y, p.z], false); }
}
function onUp() {
  if (dragging?.moved && weights) autoRig(true);
  dragging = null; downAt = null;
  controls.enabled = true; // 操作が終わったらカメラ操作を戻す
}

// ------------------------------------------------------------------ 起動
let started = false, last = performance.now();
function start() {
  if (started) return;
  started = true;
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  $('#rigStage').prepend(renderer.domElement);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.enablePan = false;
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_ROTATE };
  controls.minZoom = 0.5; controls.maxZoom = 8;
  controls.addEventListener('start', () => { if (currentView !== 'free') { currentView = 'free'; document.querySelectorAll<HTMLButtonElement>('#rigViews button').forEach(b => b.classList.toggle('on', b.dataset.v === 'free')); applyView(); } });
  const el = renderer.domElement;
  el.addEventListener('pointerdown', onDown, true);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp); el.addEventListener('pointercancel', onUp);
  if (finePointer) {
    // PC：TransformControls で関節を動かす
    tcontrols = new TransformControls(camera, el);
    tcontrols.setSize(0.7);
    tcontrols.addEventListener('dragging-changed', (ev) => { controls.enabled = !(ev as unknown as { value: boolean }).value; if (!(ev as unknown as { value: boolean }).value && weights) autoRig(true); });
    tcontrols.addEventListener('objectChange', () => { if (mode === 'edit') setJoint(selected, [tcProxy.position.x, tcProxy.position.y, tcProxy.position.z], false); });
    scene.add(tcontrols.getHelper());
    tcontrols.attach(tcProxy);
  }
  new ResizeObserver(resize).observe($('#rigStage'));
  renderer.setAnimationLoop(() => {
    const now = performance.now(), dt = (now - last) / 1000; last = now;
    tickPose(dt);
    updateSkeleton();
    controls.update();
    renderer!.render(scene, camera);
  });
}

function openApp() {
  $('#rigApp').hidden = false;
  document.body.classList.add('rigOpen');
  start();
  // 形の出どころ：Phase 3 の結果 → 保存した Rig → Base Mesh V1
  const fr = fitRes();
  const saved = loadSaved();
  if (fr) {
    if (!weights || source !== 'Phase 3 の Fitted Mesh') {
      positions = fr.positions.slice(); joints = structuredClone(fr.joints) as Joints3; weights = null; source = 'Phase 3 の Fitted Mesh';
      rebuildMesh(); runAutoJoint();
    }
  } else if (saved && !weights) restore(saved);
  else if (!mesh) { rebuildMesh(); }
  $('#rigSource').textContent = source;
  buildSheetObjects();
  setView(currentView === 'free' ? 'free' : 'front');
  syncJointUI(); syncRotUI(); updateSavedNote();
  resize();
}
function closeApp() {
  $('#rigApp').hidden = true;
  document.body.classList.remove('rigOpen');
}

function stepper(prefix: string, i: number) {
  return `<div class="rStep"><b>${AX[i]}</b><button data-s="-1" data-i="${i}" class="${prefix}m">−</button><input type="range" id="${prefix}R${i}"><span id="${prefix}V${i}">0</span><button data-s="1" data-i="${i}" class="${prefix}m">＋</button></div>`;
}
let toastTimer = 0;
function toast(m: string) {
  const t = $('#rigToast'); t.textContent = m; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = window.setTimeout(() => { t.hidden = true; }, 3000);
}

function init() {
  // 関節の選択肢・スライダー
  $<HTMLSelectElement>('#rjSel').innerHTML = JOINT_ORDER.map(k => `<option value="${k}">${k}</option>`).join('');
  $('#rjRows').innerHTML = [0, 1, 2].map(i => stepper('rj', i)).join('');
  $('#rpRows').innerHTML = [0, 1, 2].map(i => stepper('rp', i)).join('');
  const range = [[-0.6, 0.6], [0, 1.05], [-0.35, 0.35]];
  [0, 1, 2].forEach(i => {
    const r = $<HTMLInputElement>(`#rjR${i}`); r.min = String(range[i][0]); r.max = String(range[i][1]); r.step = '0.001';
    r.oninput = () => { const p = [...joints[selected]] as V3; p[i] = parseFloat(r.value); setJoint(selected, p, false); };
    r.onchange = () => { if (weights) autoRig(true); };
    const q = $<HTMLInputElement>(`#rpR${i}`); q.min = '-180'; q.max = '180'; q.step = '1';
    q.oninput = () => { const b = BONES_V1[JOINT_ORDER.indexOf(selected)].name; const v = [...(rot[b] ?? [0, 0, 0])] as V3; v[i] = parseFloat(q.value); rot[b] = v; poseT = 1; applyPose(); syncRotUI(); };
  });
  document.querySelectorAll<HTMLButtonElement>('.rjm').forEach(b => {
    b.onclick = () => { const i = +b.dataset.i!, p = [...joints[selected]] as V3; p[i] += 0.005 * +b.dataset.s!; setJoint(selected, p, true); };
  });
  document.querySelectorAll<HTMLButtonElement>('.rpm').forEach(b => {
    b.onclick = () => { const i = +b.dataset.i!, n = BONES_V1[JOINT_ORDER.indexOf(selected)].name; const v = [...(rot[n] ?? [0, 0, 0])] as V3; v[i] = Math.max(-180, Math.min(180, v[i] + 5 * +b.dataset.s!)); rot[n] = v; poseT = 1; applyPose(); syncRotUI(); };
  });
  $<HTMLSelectElement>('#rjSel').onchange = () => select($<HTMLSelectElement>('#rjSel').value as JointId);
  $<HTMLInputElement>('#rjMirror').onchange = () => { mirrorEdit = $<HTMLInputElement>('#rjMirror').checked; };
  $('#btnAutoJoint').onclick = runAutoJoint;
  $('#btnAutoRig').onclick = () => autoRig();
  $('#btnPose').onclick = () => setMode(mode === 'pose' ? 'edit' : 'pose');
  $('#rigPresets').innerHTML = (Object.keys(PRESETS) as PresetId[]).map(p => `<button data-p="${p}">${PRESETS[p].label}</button>`).join('') + '<button data-p="RESET" class="reset">RESET（T-POSE）</button>';
  document.querySelectorAll<HTMLButtonElement>('#rigPresets button').forEach(b => { b.onclick = () => setPreset(b.dataset.p as PresetId | 'RESET'); });
  ['#rvMesh', '#rvSkel', '#rvJoint', '#rvSheets', '#rvHull', '#rvWeight'].forEach(id => { $(id).onchange = applyView; });
  document.querySelectorAll<HTMLButtonElement>('#rigViews button').forEach(b => { b.onclick = () => setView(b.dataset.v as ViewId | 'free'); });
  $('#btnSaveRig').onclick = () => saveRig();
  $('#btnRestore').onclick = () => { const j = loadSaved(); if (j) { restore(j); toast('保存した Rig を復元しました'); } };
  $('#btnRigJson').onclick = () => { const j = saveRig(); shareFile(JSON.stringify(j), 'e118_rig.json', 'application/json'); };
  $('#btnRigGlb').onclick = () => { exportGlb().catch(e => toast('GLB を書き出せません：' + (e as Error).message)); };
  $('#btnGlbSave').onclick = () => { if (lastGlb) shareFile(lastGlb, 'e118_rigged_body.glb', 'model/gltf-binary'); };
  $('#btnRigOpen').onclick = openApp;
  $('#rigClose').onclick = closeApp;
  updateSavedNote();
  (window as unknown as { __rig: unknown }).__rig = {
    openApp, closeApp, runAutoJoint, autoRig, setMode, setPreset, select, setView, saveRig, restore, loadSaved,
    get joints() { return joints; }, get weights() { return weights; }, get bones() { return bones; }, get mesh() { return mesh; }, rot,
    setRot: (n: string, v: V3) => { rot[n] = v; poseT = 1; applyPose(); },
    camera, scene,
  };
}
init();
