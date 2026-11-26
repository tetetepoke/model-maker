// Sheet V1 のサンプル（見本）シートを作る開発用ページ（sample.html）。
// 既知の体型の3Dキャラを規格どおりのビューで描き、関節マーカーを正解位置に打つ。
// → 解析・Visual Hull の検証と、ChatGPT に見せる「規格の見本」に使う。
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { buildCharacter, DEFAULT_PARAMS, type CharParams, type PartColors } from './character';
import { BONES, LABEL_BAND, MARKER_DIAMETER, markerOf, partsCells, rgbHex, SHEET1_CELLS, SHEET2_CELLS, type Cell, type JointId } from './sheetSpec';

const SW = 2400, SH = 1350;
const P: CharParams = { ...DEFAULT_PARAMS, headW: 0.27, headH: 0.27, headDepth: 0.95, neckLen: 0.02, shoulderW: 0.24, torsoW: 0.22, torsoLen: 0.3, bodyDepth: 0.62, armLen: 0.3, armThick: 0.075, armAngle: 90, legLen: 0.4, legThick: 0.095, legGap: 0.11 };
const COLORS: PartColors = { hair: '#e8e8f0', skin: '#f2d9c4', torso: '#a8784e', pelvis: '#6e4a30', upperArm: '#a8784e', foreArm: '#f4f4f4', hand: '#f2d9c4', thigh: '#3a3a48', shin: '#3a3a48', foot: '#5a3a26' };

function makeCharacter(gray: boolean) {
  const g = buildCharacter(P, COLORS, null, { metalness: 0, roughness: 0.9, opacity: 1, wireframe: false }, 'high');
  // 背中のバッグ（別パーツ）
  const torsoTop = P.legLen + P.torsoLen;
  const bag = new THREE.Mesh(new RoundedBoxGeometry(0.17, 0.2, 0.08, 4, 0.03), new THREE.MeshStandardMaterial({ color: '#4a6a8a', roughness: 0.9 }));
  bag.position.set(0, torsoTop - 0.13, -(P.torsoW * P.bodyDepth) / 2 - 0.035);
  bag.name = 'backpack';
  g.add(bag);
  if (gray) g.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) m.material = new THREE.MeshBasicMaterial({ color: '#dcdcdc' }); });
  return g;
}

/** 正解の関節位置（buildCharacter と同じ式） */
function joints(): Record<JointId, THREE.Vector3> {
  const armR = P.armThick / 2, hipY = P.legLen, torsoTop = hipY + P.torsoLen, neckTop = torsoTop + P.neckLen;
  const sh = P.shoulderW / 2 - armR * 0.6, shy = torsoTop - armR * 1.1;
  const footH = Math.min(0.045, P.legLen * 0.12), legR = P.legThick / 2;
  const J = {} as Record<JointId, THREE.Vector3>;
  J.HEAD = new THREE.Vector3(0, neckTop + P.headH / 2, 0);
  J.NECK = new THREE.Vector3(0, torsoTop + 0.005, 0);
  J.CHEST = new THREE.Vector3(0, hipY + P.torsoLen * 0.72, 0);
  J.SPINE = new THREE.Vector3(0, hipY + P.torsoLen * 0.42, 0);
  J.HIPS = new THREE.Vector3(0, hipY + 0.03, 0);
  for (const [s, L] of [[1, 'L'], [-1, 'R']] as const) {
    J[`SHOULDER_${L}`] = new THREE.Vector3(s * sh, shy, 0);
    J[`ELBOW_${L}`] = new THREE.Vector3(s * (sh + P.armLen * 0.46), shy, 0);
    J[`WRIST_${L}`] = new THREE.Vector3(s * (sh + P.armLen * 0.88), shy, 0);
    J[`HIP_${L}`] = new THREE.Vector3(s * P.legGap / 2, hipY, 0);
    J[`KNEE_${L}`] = new THREE.Vector3(s * P.legGap / 2, (hipY + footH + legR * 0.4) / 2, 0);
    J[`ANKLE_${L}`] = new THREE.Vector3(s * P.legGap / 2, footH + legR * 0.4, 0);
  }
  return J;
}

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0x000000, 0);

type Dir = 'front' | 'right' | 'back' | 'left' | 'top';
/** obj を、セル内の規格位置（足底＝セル下端から5%上、中心軸＝セル中央、身長＝figPx）に正投影で描く */
function renderInto(ctx: CanvasRenderingContext2D, obj: THREE.Object3D, cell: Cell, dir: Dir, figPx: number) {
  const cx0 = cell.x0 * SW, cx1 = cell.x1 * SW, cy0 = cell.y0 * SH, cy1 = cell.y1 * SH;
  const w = Math.round(cx1 - cx0), h = Math.round(cy1 - cy0);
  renderer.setSize(w, h, false);
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const dl = new THREE.DirectionalLight(0xffffff, 1.2);
  scene.add(dl);
  scene.add(obj);
  const u = figPx; // px per unit
  const cam = new THREE.OrthographicCamera(-w / 2 / u, w / 2 / u, h / 2 / u, -h / 2 / u, -10, 10);
  const baseline = h * 0.95; // 足底の位置（セル内 px、上から）
  const centerY = (baseline - h / 2) / u; // カメラ中心の高さ（y）：足底が baseline に来るように
  if (dir === 'top') {
    cam.up.set(0, 0, -1); cam.position.set(0, 5, 0); cam.lookAt(0, 0, 0);
  } else {
    const d = { front: [0, 0, 1], right: [-1, 0, 0], back: [0, 0, -1], left: [1, 0, 0] }[dir];
    cam.position.set(d[0] * 5, centerY, d[2] * 5); cam.lookAt(0, centerY, 0);
  }
  dl.position.copy(cam.position).add(new THREE.Vector3(1, 2, 0));
  renderer.render(scene, cam);
  ctx.drawImage(renderer.domElement, cx0, cy0, w, h);
  scene.remove(obj);
}

function label(ctx: CanvasRenderingContext2D, cell: Cell) {
  const x = cell.x0 * SW, y = cell.y0 * SH, h = (cell.y1 - cell.y0) * SH;
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  const cw = (cell.x1 - cell.x0) * SW;
  ctx.font = `bold ${Math.round(Math.min(h * LABEL_BAND * 0.5, cw / (cell.label.length * 0.7)))}px sans-serif`;
  ctx.fillText(cell.label, x + 12, y + h * LABEL_BAND * 0.7);
  ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 2;
  ctx.strokeRect(x + 2, y + 2, (cell.x1 - cell.x0) * SW - 4, h - 4);
}
function title(ctx: CanvasRenderingContext2D, t: string) {
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.font = `bold ${Math.round(SH * 0.03)}px sans-serif`;
  ctx.fillText(t, 16, SH * 0.042);
}

function sheet1(): HTMLCanvasElement {
  const c = document.createElement('canvas'); c.width = SW; c.height = SH;
  const ctx = c.getContext('2d')!;
  title(ctx, 'ELEMENT 118  SHEET V1  APPEARANCE / SHAPE  —  SAMPLE');
  const cellH = (0.72 - 0.06) * SH, figPx = cellH * 0.6;
  for (const cell of SHEET1_CELLS) {
    label(ctx, cell);
    renderInto(ctx, makeCharacter(false), cell, cell.id as Dir, figPx);
  }
  // PARTS：髪とバッグだけ（ほかは空欄）
  for (const cell of partsCells()) {
    label(ctx, cell);
    const ch = makeCharacter(false);
    const keep = cell.id === 'hair' ? ['hair', 'hair_back'] : cell.id === 'backpack' ? ['backpack'] : [];
    if (!keep.length) continue;
    const g = new THREE.Group();
    ch.traverse(o => { if (keep.includes(o.name)) g.add(o.clone()); });
    const box = new THREE.Box3().setFromObject(g);
    g.position.y = -box.min.y; g.position.x = -(box.min.x + box.max.x) / 2;
    const sz = box.getSize(new THREE.Vector3());
    renderInto(ctx, g, cell, cell.id === 'backpack' ? 'back' : 'front', ((cell.y1 - cell.y0) * SH * 0.6) / Math.max(sz.y, sz.x * 0.8));
  }
  return c;
}

function sheet2(): HTMLCanvasElement {
  const c = document.createElement('canvas'); c.width = SW; c.height = SH;
  const ctx = c.getContext('2d')!;
  title(ctx, 'ELEMENT 118  SHEET V1  STRUCTURE / RIG  —  SAMPLE');
  const J = joints();
  for (const cell of SHEET2_CELLS) label(ctx, cell);
  for (const id of ['jointFront', 'jointRight'] as const) {
    const cell = SHEET2_CELLS.find(x => x.id === id)!;
    const cellH = (cell.y1 - cell.y0) * SH, figPx = cellH * 0.6;
    renderInto(ctx, makeCharacter(true), cell, id === 'jointFront' ? 'front' : 'right', figPx);
    // マーカー（規格：直径 = 身長の3%）
    const cx = (cell.x0 + cell.x1) / 2 * SW, base = cell.y0 * SH + cellH * 0.95;
    const r = (MARKER_DIAMETER * figPx) / 2;
    const done = new Set<string>();
    for (const [jid, p] of Object.entries(J) as [JointId, THREE.Vector3][]) {
      if (id === 'jointRight' && jid.endsWith('_R')) continue; // 右側面図では対は1個
      const x = id === 'jointFront' ? cx + p.x * figPx : cx + p.z * figPx;
      const y = base - p.y * figPx;
      const k = `${Math.round(x)},${Math.round(y)}`; if (done.has(k)) continue; done.add(k);
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = rgbHex(markerOf(jid).rgb); ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = '#000'; ctx.stroke();
    }
  }
  // 参考図（解析では使わない）
  const bone = SHEET2_CELLS.find(x => x.id === 'bone')!;
  const bh = (bone.y1 - bone.y0) * SH, bpx = bh * 0.6, bcx = (bone.x0 + bone.x1) / 2 * SW, bb = bone.y0 * SH + bh * 0.95;
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
  for (const [a, b] of BONES) { ctx.beginPath(); ctx.moveTo(bcx + J[a].x * bpx, bb - J[a].y * bpx); ctx.lineTo(bcx + J[b].x * bpx, bb - J[b].y * bpx); ctx.stroke(); }
  const mesh = SHEET2_CELLS.find(x => x.id === 'mesh')!;
  const wire = makeCharacter(false);
  wire.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) m.material = new THREE.MeshBasicMaterial({ color: '#9fd8ff', wireframe: true }); });
  renderInto(ctx, wire, mesh, 'front', (mesh.y1 - mesh.y0) * SH * 0.6);
  const uv = SHEET2_CELLS.find(x => x.id === 'uv')!;
  ctx.strokeStyle = 'rgba(160,200,255,0.5)'; ctx.lineWidth = 1;
  const ux = uv.x0 * SW + 40, uy = uv.y0 * SH + 70, us = (uv.y1 - uv.y0) * SH - 110;
  for (let i = 0; i <= 8; i++) { ctx.beginPath(); ctx.moveTo(ux + i * us / 8, uy); ctx.lineTo(ux + i * us / 8, uy + us); ctx.moveTo(ux, uy + i * us / 8); ctx.lineTo(ux + us, uy + i * us / 8); ctx.stroke(); }
  return c;
}

const s1 = sheet1(), s2 = sheet2();
for (const [cv, id] of [[s1, 'out1'], [s2, 'out2']] as const) {
  const img = document.getElementById(id) as HTMLImageElement;
  img.src = cv.toDataURL('image/png');
}
(window as unknown as { __sample: unknown }).__sample = { s1: s1.toDataURL('image/png'), s2: s2.toDataURL('image/png'), joints: Object.fromEntries(Object.entries(joints()).map(([k, v]) => [k, v.toArray()])) };
