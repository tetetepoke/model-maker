// Element 118 Standard Base Mesh V1
//
// 全キャラ共通の「型」となる人体メッシュ。決まった手順だけで作るので、何度作っても
// 頂点番号・頂点数・面の並び・UV・ボーン構造が完全に同じになる（＝固定トポロジー）。
// Phase 3 ではキャラごとに「頂点の位置」だけを動かし、トポロジーは絶対に作り直さない。
//
// 作り方：
//   1. 低ポリの四角形ケージ（箱モデリング）。関節ごとにエッジループを置く
//   2. ケージを Catmull–Clark で2回細分化（全面四角形・閉じた1枚のメッシュ）
//   3. UV はケージの段階で部位ごとに展開し、細分化に合わせて補間（継ぎ目は固定）
//   4. SHEET 2 の17関節＝17ボーン。ウェイトは関節位置からの滑らかな配分
//
// 座標：身長 1.0、足裏 y=0、正面 +Z、キャラの左 +X、上 +Y、T ポーズ、左右対称。

import * as THREE from 'three';
import type { JointId } from './sheetSpec';

export const BASE_MESH_VERSION = 'E118-BASE-V1';

type V3 = [number, number, number];

export type Part =
  | 'head' | 'neck' | 'torso' | 'torsoCap'
  | 'armL' | 'armR' | 'handL' | 'handR' | 'handTipL' | 'handTipR'
  | 'legL' | 'legR' | 'footL' | 'footR' | 'soleL' | 'soleR';

// ---------------------------------------------------------------- ボーン（固定の対応表）
/** ボーン番号＝この配列の順番（GLB の joints 順もこれと同じ。変更禁止） */
export const BONES_V1: { name: string; joint: JointId; parent: number }[] = [
  { name: 'Hips', joint: 'HIPS', parent: -1 },
  { name: 'Spine', joint: 'SPINE', parent: 0 },
  { name: 'Chest', joint: 'CHEST', parent: 1 },
  { name: 'Neck', joint: 'NECK', parent: 2 },
  { name: 'Head', joint: 'HEAD', parent: 3 },
  { name: 'UpperArm_L', joint: 'SHOULDER_L', parent: 2 },
  { name: 'LowerArm_L', joint: 'ELBOW_L', parent: 5 },
  { name: 'Hand_L', joint: 'WRIST_L', parent: 6 },
  { name: 'UpperArm_R', joint: 'SHOULDER_R', parent: 2 },
  { name: 'LowerArm_R', joint: 'ELBOW_R', parent: 8 },
  { name: 'Hand_R', joint: 'WRIST_R', parent: 9 },
  { name: 'UpperLeg_L', joint: 'HIP_L', parent: 0 },
  { name: 'LowerLeg_L', joint: 'KNEE_L', parent: 11 },
  { name: 'Foot_L', joint: 'ANKLE_L', parent: 12 },
  { name: 'UpperLeg_R', joint: 'HIP_R', parent: 0 },
  { name: 'LowerLeg_R', joint: 'KNEE_R', parent: 14 },
  { name: 'Foot_R', joint: 'ANKLE_R', parent: 15 },
];
const B = Object.fromEntries(BONES_V1.map((b, i) => [b.name, i])) as Record<string, number>;

// ---------------------------------------------------------------- 寸法（ケージ単位。最後に身長1へ正規化）
/** 胴体の輪：y, 半幅, 半奥行き */
const TORSO: [number, number, number][] = [
  [0.285, 0.09, 0.062], // 0 股
  [0.32, 0.099, 0.068], // 1 腰
  [0.375, 0.093, 0.064], // 2 ウエスト
  [0.43, 0.098, 0.066], // 3 胸
  [0.465, 0.1, 0.066], // 4 脇の下
  [0.505, 0.102, 0.064], // 5 腕の付け根の中心
  [0.54, 0.099, 0.061], // 6 肩
  [0.56, 0.082, 0.054], // 7 胴の上面
];
const ARM_Y = 0.505;

/** ケージ単位の関節位置（ボーンの原点） */
const JOINTS_CAGE: Record<JointId, V3> = {
  HIPS: [0, 0.3, 0], SPINE: [0, 0.375, 0], CHEST: [0, 0.455, 0], NECK: [0, 0.585, 0], HEAD: [0, 0.79, 0],
  SHOULDER_L: [0.117, ARM_Y, 0], ELBOW_L: [0.237, ARM_Y, 0], WRIST_L: [0.328, ARM_Y, 0],
  SHOULDER_R: [-0.117, ARM_Y, 0], ELBOW_R: [-0.237, ARM_Y, 0], WRIST_R: [-0.328, ARM_Y, 0],
  HIP_L: [0.045, 0.272, 0], KNEE_L: [0.045, 0.16, 0], ANKLE_L: [0.045, 0.062, 0],
  HIP_R: [-0.045, 0.272, 0], KNEE_R: [-0.045, 0.16, 0], ANKLE_R: [-0.045, 0.062, 0],
};
const SHX = JOINTS_CAGE.SHOULDER_L[0], ELX = JOINTS_CAGE.ELBOW_L[0], WRX = JOINTS_CAGE.WRIST_L[0];
const KNY = JOINTS_CAGE.KNEE_L[1], ANY = JOINTS_CAGE.ANKLE_L[1];
const ARM_X0 = 0.08, HAND_X0 = 0.326, HAND_X1 = 0.41; // UV の範囲（腕の付け根・手首・指先）
const FOOT_Z = 0.016;

// ---------------------------------------------------------------- ケージ
class Cage {
  v: V3[] = [];
  f: number[][] = [];
  part: Part[] = [];
  add(p: V3) { this.v.push(p); return this.v.length - 1; }
  quad(q: number[], part: Part) { this.f.push(q); this.part.push(part); }
}

/** 胴体の輪の頂点の並び（格子 ix 0..4, iz 0..2 の外周。後ろの左端から時計回りではなく、x+ → 前 → x- の順） */
const RING_GRID: [number, number][] = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [4, 1], [4, 2], [3, 2], [2, 2], [1, 2], [0, 2], [0, 1]];
const ringIndexOf = (ix: number, iz: number) => RING_GRID.findIndex(g => g[0] === ix && g[1] === iz);

interface RingSpec { c: V3; ru: number; rv: number; part: Part }

/**
 * 2×2 の面（外周8頂点）から筒を押し出す。u,v は筒の断面の軸。
 * 外周の各頂点の角度を45°刻みに丸めて、輪の頂点と1対1に対応させる。
 */
function extrude(cage: Cage, boundary: number[], u: V3, v: V3, rings: RingSpec[], capCenter: V3, capPart: Part) {
  const pc: V3 = [0, 0, 0];
  for (const i of boundary) for (let k = 0; k < 3; k++) pc[k] += cage.v[i][k] / boundary.length;
  const ang = boundary.map(i => {
    const d = [0, 1, 2].map(k => cage.v[i][k] - pc[k]);
    const a = Math.atan2(d[0] * v[0] + d[1] * v[1] + d[2] * v[2], d[0] * u[0] + d[1] * u[1] + d[2] * u[2]);
    return Math.round(a / (Math.PI / 4));
  });
  if (new Set(ang.map(a => ((a % 8) + 8) % 8)).size !== 8) throw new Error('extrude: boundary angles not unique');
  let prev = boundary;
  for (const r of rings) {
    const cur = ang.map(a => {
      const t = a * Math.PI / 4, cu = Math.cos(t) * r.ru, cv = Math.sin(t) * r.rv;
      return cage.add([0, 1, 2].map(k => r.c[k] + u[k] * cu + v[k] * cv) as V3);
    });
    for (let k = 0; k < 8; k++) cage.quad([prev[k], prev[(k + 1) % 8], cur[(k + 1) % 8], cur[k]], r.part);
    prev = cur;
  }
  const c = cage.add(capCenter);
  for (let j = 0; j < 4; j++) cage.quad([prev[(2 * j + 7) % 8], prev[2 * j], prev[(2 * j + 1) % 8], c], capPart);
}

function buildCage(): Cage {
  const cage = new Cage();
  // --- 胴体の輪
  const rings: number[][] = TORSO.map(([y, w, d]) => RING_GRID.map(([ix, iz]) => {
    const gx = ix / 2 - 1, gz = iz - 1;
    const corner = Math.abs(gx) === 1 && Math.abs(gz) === 1 ? 0.82 : 1;
    return cage.add([gx * w * corner, y, gz * d * corner]);
  }));
  // 腕の付け根（脇の下〜肩の2段 × 側面2列）は押し出し用に空ける
  const armHole = (l: number, i: number) => (l === 4 || l === 5) && (i === 4 || i === 5 || i === 10 || i === 11);
  for (let l = 0; l < TORSO.length - 1; l++) for (let i = 0; i < 12; i++) {
    if (armHole(l, i)) continue;
    cage.quad([rings[l][i], rings[l][(i + 1) % 12], rings[l + 1][(i + 1) % 12], rings[l + 1][i]], 'torso');
  }
  // --- 上面（肩の上）と底面（股）の格子
  const capGrid = (l: number, dy: number) => {
    const [y, w] = TORSO[l];
    const g: number[][] = [];
    for (let ix = 0; ix <= 4; ix++) {
      g[ix] = [];
      for (let iz = 0; iz <= 2; iz++) {
        const ri = ringIndexOf(ix, iz);
        g[ix][iz] = ri >= 0 ? rings[l][ri] : cage.add([(ix / 2 - 1) * w, y + dy, 0]);
      }
    }
    return g;
  };
  const top = capGrid(7, 0.006);
  for (let ix = 0; ix < 4; ix++) for (let iz = 0; iz < 2; iz++) {
    if (ix === 1 || ix === 2) continue; // 首の押し出し用
    cage.quad([top[ix][iz], top[ix + 1][iz], top[ix + 1][iz + 1], top[ix][iz + 1]], 'torsoCap');
  }
  const bot = capGrid(0, -0.004);
  const loop = (g: number[][], x0: number) => [g[x0][0], g[x0 + 1][0], g[x0 + 2][0], g[x0 + 2][1], g[x0 + 2][2], g[x0 + 1][2], g[x0][2], g[x0][1]];

  const X: V3 = [1, 0, 0], Y: V3 = [0, 1, 0], Z: V3 = [0, 0, 1];
  // --- 首と頭（頭は身長の約4割：ちびキャラ）
  extrude(cage, loop(top, 1), X, Z, [
    { c: [0, 0.585, 0], ru: 0.04, rv: 0.038, part: 'neck' },
    { c: [0, 0.612, 0], ru: 0.042, rv: 0.04, part: 'neck' },
    { c: [0, 0.64, 0.004], ru: 0.1, rv: 0.09, part: 'head' }, // あごの下
    { c: [0, 0.69, 0.004], ru: 0.175, rv: 0.155, part: 'head' },
    { c: [0, 0.765, 0], ru: 0.205, rv: 0.18, part: 'head' },
    { c: [0, 0.85, 0], ru: 0.205, rv: 0.18, part: 'head' },
    { c: [0, 0.925, 0], ru: 0.17, rv: 0.15, part: 'head' },
    { c: [0, 0.97, 0], ru: 0.1, rv: 0.09, part: 'head' },
  ], [0, 0.99, 0], 'head');

  // --- 腕（肩・肘・手首にループ。手はミトン）
  for (const s of [1, -1]) {
    const L = s > 0;
    const ring = (l: number, i: number) => rings[l][i];
    const a = L ? [4, 5, 6] : [0, 11, 10];
    const boundary = [ring(4, a[0]), ring(4, a[1]), ring(4, a[2]), ring(5, a[2]), ring(6, a[2]), ring(6, a[1]), ring(6, a[0]), ring(5, a[0])];
    const arm = (L ? 'armL' : 'armR') as Part, hand = (L ? 'handL' : 'handR') as Part;
    const R = (x: number, ry: number, rz: number, part: Part): RingSpec => ({ c: [s * x, ARM_Y, 0], ru: ry, rv: rz, part });
    extrude(cage, boundary, Y, Z, [
      R(0.13, 0.045, 0.047, arm), // 肩
      R(0.21, 0.036, 0.037, arm), // 肘の手前
      R(0.262, 0.033, 0.034, arm), // 肘の先
      R(0.325, 0.027, 0.03, arm), // 手首
      R(0.357, 0.025, 0.044, hand), // 手のひら（上下に平たい）
      R(0.385, 0.025, 0.044, hand),
      R(0.403, 0.018, 0.033, hand),
    ], [s * HAND_X1, ARM_Y, 0], (L ? 'handTipL' : 'handTipR') as Part);
  }

  // --- 脚（股関節・膝・足首にループ。足はブーツ状で平らな足裏）
  for (const s of [1, -1]) {
    const L = s > 0;
    const cx = s * TORSO[0][1] / 2;
    const leg = (L ? 'legL' : 'legR') as Part, foot = (L ? 'footL' : 'footR') as Part;
    const R = (y: number, rx: number, rz: number, part: Part, zc = 0): RingSpec => ({ c: [cx, y, zc], ru: rx, rv: rz, part });
    extrude(cage, loop(bot, L ? 2 : 0), X, Z, [
      R(0.25, 0.042, 0.047, leg), // 太もも
      R(0.18, 0.036, 0.039, leg), // 膝の上
      R(0.14, 0.034, 0.036, leg), // 膝の下
      R(0.062, 0.029, 0.031, leg), // 足首
      R(0.032, 0.038, 0.056, foot, FOOT_Z), // 足の甲
      R(0.004, 0.039, 0.058, foot, FOOT_Z), // 足裏の縁
    ], [cx, 0, FOOT_Z], (L ? 'soleL' : 'soleR') as Part);
  }
  return compact(cage);
}

/** 押し出しで使われなくなった頂点（空けた面の中心）を取り除いて番号を詰める */
function compact(c: Cage): Cage {
  const used = new Int32Array(c.v.length).fill(-1);
  const out = new Cage();
  for (const f of c.f) for (const i of f) if (used[i] < 0) used[i] = -2;
  for (let i = 0; i < c.v.length; i++) if (used[i] === -2) used[i] = out.add(c.v[i]);
  c.f.forEach((f, k) => out.quad(f.map(i => used[i]), c.part[k]));
  return out;
}

/** 面の向きを隣どうしで揃え、全体が外向き（体積が正）になるようにする */
function orient(c: Cage) {
  const edgeFaces = new Map<number, number[]>();
  c.f.forEach((f, k) => f.forEach((a, j) => {
    const b = f[(j + 1) % 4], kk = Math.min(a, b) * 1e6 + Math.max(a, b);
    (edgeFaces.get(kk) ?? edgeFaces.set(kk, []).get(kk)!).push(k);
  }));
  const done = new Uint8Array(c.f.length);
  const stack = [0]; done[0] = 1;
  while (stack.length) {
    const k = stack.pop()!;
    const f = c.f[k];
    for (let j = 0; j < 4; j++) {
      const a = f[j], b = f[(j + 1) % 4];
      for (const n of edgeFaces.get(Math.min(a, b) * 1e6 + Math.max(a, b))!) {
        if (n === k || done[n]) continue;
        const g = c.f[n];
        const same = g.some((x, i) => x === a && g[(i + 1) % 4] === b);
        if (same) g.reverse();
        done[n] = 1; stack.push(n);
      }
    }
  }
  let vol = 0;
  for (const f of c.f) for (const [i, j, k] of [[f[0], f[1], f[2]], [f[0], f[2], f[3]]]) {
    const a = c.v[i], b = c.v[j], d = c.v[k];
    vol += (a[0] * (b[1] * d[2] - b[2] * d[1]) - a[1] * (b[0] * d[2] - b[2] * d[0]) + a[2] * (b[0] * d[1] - b[1] * d[0])) / 6;
  }
  if (vol < 0) c.f.forEach(f => f.reverse());
}

// ---------------------------------------------------------------- UV（ケージの面の角ごと）
type Rect = [number, number, number, number]; // u0, v0, u1, v1
/** UV アトラス（固定）。顔は頭の島の中央に大きく取る */
export const UV_LAYOUT: Record<Part, Rect> = {
  head: [0.0, 0.4, 0.6, 1.0],
  torso: [0.6, 0.55, 1.0, 1.0],
  neck: [0.6, 0.47, 1.0, 0.55],
  torsoCap: [0.62, 0.405, 0.98, 0.465],
  armL: [0.0, 0.3, 0.3, 0.4], armR: [0.3, 0.3, 0.6, 0.4],
  handL: [0.0, 0.2, 0.15, 0.3], handR: [0.15, 0.2, 0.3, 0.3],
  handTipL: [0.3, 0.215, 0.38, 0.295], handTipR: [0.38, 0.215, 0.46, 0.295],
  legL: [0.6, 0.04, 0.8, 0.4], legR: [0.8, 0.04, 1.0, 0.4],
  footL: [0.0, 0.04, 0.2, 0.19], footR: [0.2, 0.04, 0.4, 0.19],
  soleL: [0.4, 0.02, 0.5, 0.19], soleR: [0.5, 0.02, 0.6, 0.19],
};
const PAD = 0.012;
const toRect = (p: Part, s: number, t: number): [number, number] => {
  const [u0, v0, u1, v1] = UV_LAYOUT[p];
  const cl = (x: number) => Math.min(1, Math.max(0, x));
  return [u0 + PAD + cl(s) * (u1 - u0 - 2 * PAD), v0 + PAD + cl(t) * (v1 - v0 - 2 * PAD)];
};
/** 頭の横方向：正面側（±90°）に島の幅の70%を使う */
const headWarp = (th: number) => {
  const h = Math.PI / 2;
  if (th < -h) return 0.15 * (th + Math.PI) / h;
  if (th > h) return 0.85 + 0.15 * (th - h) / h;
  return 0.15 + 0.7 * (th + h) / Math.PI;
};
const EPS = 1e-9;

/**
 * 面 f の各角の UV。継ぎ目は「背中側の中心線」（頭・首・胴・脚・足）と「腕の下側」に固定。
 * 継ぎ目上の頂点は、面の重心がどちら側かで u=0 / u=1 を選ぶ。
 */
function faceUV(c: Cage, f: number[], part: Part): [number, number][] {
  const P = f.map(i => c.v[i]);
  const cen = [0, 1, 2].map(k => P.reduce((a, p) => a + p[k], 0) / 4);
  const around = (dx: number, dz: number, cdx: number) => {
    if (Math.abs(dx) < EPS && dz < 0) return cdx > 0 ? Math.PI : -Math.PI; // 背中の継ぎ目
    return Math.atan2(dx, dz);
  };
  const L = part.endsWith('L');
  switch (part) {
    case 'head': {
      const cz = 0.002, hy = 0.79;
      const cth = Math.atan2(cen[0], cen[2] - cz);
      return P.map(p => {
        const dx = p[0], dz = p[2] - cz, r = Math.hypot(dx / 0.205, dz / 0.18);
        const th = r < 1e-6 ? cth : around(dx, dz, cen[0]);
        const ph = Math.atan2((p[1] - hy) / 0.2, r);
        return toRect(part, headWarp(th), 0.5 + ph / Math.PI);
      });
    }
    case 'neck': case 'torso': case 'legL': case 'legR': case 'footL': case 'footR': {
      const cx = part.startsWith('leg') || part.startsWith('foot') ? (L ? 1 : -1) * TORSO[0][1] / 2 : 0;
      const cz = part.startsWith('foot') ? FOOT_Z : 0;
      const [y0, y1] = part === 'neck' ? [0.56, 0.612] : part === 'torso' ? [0.285, 0.56] : part.startsWith('leg') ? [0.062, 0.285] : [0.0, 0.062];
      return P.map(p => {
        const th = around(p[0] - cx, p[2] - cz, cen[0] - cx);
        return toRect(part, 0.5 + th / (2 * Math.PI), (p[1] - y0) / (y1 - y0));
      });
    }
    case 'armL': case 'armR': case 'handL': case 'handR': {
      const [x0, x1] = part.startsWith('arm') ? [ARM_X0, HAND_X0] : [HAND_X0, HAND_X1];
      return P.map(p => {
        const dy = p[1] - ARM_Y, dz = p[2];
        let th: number;
        if (Math.abs(dz) < EPS && dy < 0) th = cen[2] > 0 ? Math.PI : -Math.PI; // 腕の下側の継ぎ目
        else th = Math.atan2(dz, dy);
        return toRect(part, (Math.abs(p[0]) - x0) / (x1 - x0), 0.5 + th / (2 * Math.PI));
      });
    }
    case 'handTipL': case 'handTipR':
      return P.map(p => toRect(part, 0.5 + p[2] / 0.07, 0.5 + (p[1] - ARM_Y) / 0.07));
    case 'soleL': case 'soleR': {
      const cx = (L ? 1 : -1) * TORSO[0][1] / 2;
      return P.map(p => toRect(part, 0.5 + (p[0] - cx) / 0.082, 0.5 + (p[2] - FOOT_Z) / 0.12));
    }
    case 'torsoCap': {
      const [, w, d] = TORSO[7];
      return P.map(p => toRect(part, 0.5 + p[0] / (2 * w), 0.5 + p[2] / (2 * d)));
    }
  }
}

// ---------------------------------------------------------------- Catmull–Clark
interface QuadMesh { v: V3[]; f: number[][]; part: Part[]; uv: [number, number][][] }

function catmullClark(m: QuadMesh): QuadMesh {
  const nv = m.v.length;
  const edgeId = new Map<number, number>();
  const edges: [number, number][] = [];
  const edgeFaces: number[][] = [];
  const fe: number[][] = m.f.map((f, k) => f.map((a, j) => {
    const b = f[(j + 1) % 4], key = Math.min(a, b) * 1e7 + Math.max(a, b);
    let e = edgeId.get(key);
    if (e === undefined) { e = edges.length; edgeId.set(key, e); edges.push([a, b]); edgeFaces.push([]); }
    edgeFaces[e].push(k);
    return e;
  }));
  const fp: V3[] = m.f.map(f => [0, 1, 2].map(k => f.reduce((s, i) => s + m.v[i][k], 0) / 4) as V3);
  const ep: V3[] = edges.map(([a, b], e) => {
    const [f0, f1] = edgeFaces[e];
    if (edgeFaces[e].length !== 2) throw new Error('mesh not closed');
    return [0, 1, 2].map(k => (m.v[a][k] + m.v[b][k] + fp[f0][k] + fp[f1][k]) / 4) as V3;
  });
  const fSum = Array.from({ length: nv }, () => [0, 0, 0, 0]);
  const rSum = Array.from({ length: nv }, () => [0, 0, 0, 0]);
  m.f.forEach((f, k) => f.forEach(i => { for (let c = 0; c < 3; c++) fSum[i][c] += fp[k][c]; fSum[i][3]++; }));
  edges.forEach(([a, b]) => {
    for (const i of [a, b]) { for (let c = 0; c < 3; c++) rSum[i][c] += (m.v[a][c] + m.v[b][c]) / 2; rSum[i][3]++; }
  });
  const vp: V3[] = m.v.map((p, i) => {
    const n = rSum[i][3];
    return [0, 1, 2].map(c => (fSum[i][c] / fSum[i][3] + 2 * rSum[i][c] / n + (n - 3) * p[c]) / n) as V3;
  });
  const v = [...vp, ...ep, ...fp];
  const f: number[][] = [], part: Part[] = [], uv: [number, number][][] = [];
  m.f.forEach((q, k) => {
    const U = m.uv[k];
    const uF: [number, number] = [(U[0][0] + U[1][0] + U[2][0] + U[3][0]) / 4, (U[0][1] + U[1][1] + U[2][1] + U[3][1]) / 4];
    const mid = (a: number, b: number): [number, number] => [(U[a][0] + U[b][0]) / 2, (U[a][1] + U[b][1]) / 2];
    for (let j = 0; j < 4; j++) {
      const jp = (j + 3) % 4;
      f.push([q[j], nv + fe[k][j], nv + edges.length + k, nv + fe[k][jp]]);
      uv.push([U[j], mid(j, (j + 1) % 4), uF, mid(jp, j)]);
      part.push(m.part[k]);
    }
  });
  return { v, f, part, uv };
}

// ---------------------------------------------------------------- スキンウェイト
const ss = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** 1頂点のウェイト（ケージ単位の位置と、属する部位から計算） */
function weightsAt(p: V3, parts: Set<Part>): Map<number, number> {
  const w = new Map<number, number>();
  const add = (b: number, x: number) => { if (x > 1e-4) w.set(b, (w.get(b) ?? 0) + x); };
  const [x, y] = p, ax = Math.abs(x);
  const isTorso = parts.has('torso') || parts.has('torsoCap');
  const has = (s: string) => [...parts].some(q => q.startsWith(s));
  const sideL = x > 0;
  // 腕
  let arm = 0;
  if (has('arm') || has('hand')) arm = isTorso ? ss(SHX - 0.03, SHX + 0.01, ax) * ss(0.462, 0.5, y) : ss(SHX - 0.04, SHX + 0.002, ax);
  else if (isTorso) arm = ss(SHX - 0.03, SHX + 0.01, ax) * ss(0.462, 0.5, y);
  if (arm > 0) {
    const te = ss(ELX - 0.02, ELX + 0.02, ax), tw = ss(WRX - 0.012, WRX + 0.012, ax);
    const s = sideL ? '_L' : '_R';
    add(B['UpperArm' + s], arm * (1 - te));
    add(B['LowerArm' + s], arm * te * (1 - tw));
    add(B['Hand' + s], arm * te * tw);
  }
  // 脚
  const isLeg = has('leg') || has('foot') || has('sole');
  const leg = isLeg || isTorso ? 1 - ss(0.26, 0.335, y) : 0;
  if (leg > 0) {
    const tk = 1 - ss(KNY - 0.025, KNY + 0.025, y), ta = 1 - ss(ANY - 0.014, ANY + 0.014, y);
    let sl: number;
    if (isLeg && !isTorso) sl = parts.has('legL') || parts.has('footL') || parts.has('soleL') ? 1 : 0;
    else sl = ss(-0.012, 0.012, x);
    for (const [s, amt] of [['_L', sl], ['_R', 1 - sl]] as [string, number][]) {
      if (amt <= 0) continue;
      add(B['UpperLeg' + s], leg * amt * (1 - tk));
      add(B['LowerLeg' + s], leg * amt * tk * (1 - ta));
      add(B['Foot' + s], leg * amt * tk * ta);
    }
  }
  // 体の中心（残り）
  const rest = Math.max(0, 1 - arm - leg);
  if (rest > 0) {
    const a = ss(0.335, 0.4, y), b = ss(0.42, 0.48, y), c = ss(0.556, 0.596, y), d = ss(0.6, 0.628, y);
    add(B.Hips, rest * (1 - a));
    add(B.Spine, rest * a * (1 - b));
    add(B.Chest, rest * b * (1 - c));
    add(B.Neck, rest * c * (1 - d));
    add(B.Head, rest * c * d);
  }
  return w;
}

// ---------------------------------------------------------------- 本体
export interface BaseMeshData {
  /** 頂点（UV の継ぎ目で分割済み）＝ GLB の頂点と同じ並び */
  positions: Float32Array; normals: Float32Array; uvs: Float32Array;
  skinIndex: Uint16Array; skinWeight: Float32Array;
  /** 三角形（四角形を (a,b,c)(a,c,d) に分割） */
  index: Uint32Array;
  /** 四角形（継ぎ目分割前の「形の頂点」番号）。ワイヤーフレーム・フィッティング用 */
  quads: Uint32Array;
  /** 各 GLB 頂点 → 形の頂点番号 */
  shapeIndex: Uint32Array;
  shapeCount: number;
  /** 各四角形の部位 */
  quadPart: Part[];
  /** 関節（＝ボーン原点）。身長1に正規化済み */
  joints: Record<JointId, V3>;
  stats: { vertices: number; shapeVertices: number; triangles: number; quads: number; bones: number; closed: boolean; euler: number; manifold: boolean; cageQuads: number };
}

let cache: BaseMeshData | null = null;

export function buildBaseMeshData(): BaseMeshData {
  if (cache) return cache;
  const cage = buildCage();
  orient(cage);
  let m: QuadMesh = { v: cage.v, f: cage.f, part: cage.part, uv: cage.f.map((f, k) => faceUV(cage, f, cage.part[k])) };
  m = catmullClark(m);
  m = catmullClark(m);

  // 位置・関節を身長1・足裏 y=0 に正規化
  let minY = Infinity, maxY = -Infinity;
  for (const p of m.v) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
  const sc = 1 / (maxY - minY);
  const norm = (p: V3): V3 => [p[0] * sc, (p[1] - minY) * sc, p[2] * sc];

  // 形の頂点ごとのウェイト（ケージ単位の位置で計算）
  const vParts: Set<Part>[] = m.v.map(() => new Set());
  m.f.forEach((f, k) => f.forEach(i => vParts[i].add(m.part[k])));
  const shapeW = m.v.map((p, i) => {
    const w = [...weightsAt(p, vParts[i]).entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 4);
    const s = w.reduce((a, e) => a + e[1], 0) || 1;
    return w.map(([b, x]) => [b, x / s] as [number, number]);
  });

  // 法線（形の頂点で平均＝継ぎ目でも滑らか）
  const P = m.v.map(norm);
  const nrm = P.map(() => [0, 0, 0]);
  for (const f of m.f) for (const [a, b, c] of [[f[0], f[1], f[2]], [f[0], f[2], f[3]]]) {
    const e1 = [0, 1, 2].map(k => P[b][k] - P[a][k]), e2 = [0, 1, 2].map(k => P[c][k] - P[a][k]);
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    for (const i of [a, b, c]) for (let k = 0; k < 3; k++) nrm[i][k] += n[k];
  }
  nrm.forEach(n => { const l = Math.hypot(n[0], n[1], n[2]) || 1; n[0] /= l; n[1] /= l; n[2] /= l; });

  // UV の継ぎ目で頂点を分割（面の順・角の順に番号を振る＝毎回同じ）
  const key = new Map<string, number>();
  const shapeIndex: number[] = [], uvList: number[] = [];
  const qv = m.f.map((f, k) => f.map((i, j) => {
    const uv = m.uv[k][j];
    const kk = i + ':' + Math.round(uv[0] * 1e6) + ':' + Math.round(uv[1] * 1e6);
    let id = key.get(kk);
    if (id === undefined) { id = shapeIndex.length; key.set(kk, id); shapeIndex.push(i); uvList.push(uv[0], uv[1]); }
    return id;
  }));
  const n = shapeIndex.length;
  const positions = new Float32Array(n * 3), normals = new Float32Array(n * 3);
  const skinIndex = new Uint16Array(n * 4), skinWeight = new Float32Array(n * 4);
  shapeIndex.forEach((s, i) => {
    positions.set(P[s], i * 3); normals.set(nrm[s], i * 3);
    shapeW[s].forEach(([b, x], j) => { skinIndex[i * 4 + j] = b; skinWeight[i * 4 + j] = x; });
  });
  const index = new Uint32Array(m.f.length * 6);
  qv.forEach((q, k) => index.set([q[0], q[1], q[2], q[0], q[2], q[3]], k * 6));
  const quads = new Uint32Array(m.f.length * 4);
  m.f.forEach((f, k) => quads.set(f, k * 4));

  const joints = Object.fromEntries(Object.entries(JOINTS_CAGE).map(([k, p]) => [k, norm(p)])) as Record<JointId, V3>;
  const topo = checkTopology(m.f, m.v.length);
  cache = {
    positions, normals, uvs: new Float32Array(uvList), skinIndex, skinWeight, index, quads,
    shapeIndex: new Uint32Array(shapeIndex), shapeCount: m.v.length, quadPart: m.part, joints,
    stats: { vertices: n, shapeVertices: m.v.length, triangles: m.f.length * 2, quads: m.f.length, bones: BONES_V1.length, ...topo, cageQuads: cage.f.length },
  };
  return cache;
}

/** 閉じているか（全辺がちょうど2面）、向きが揃っているか、オイラー数（穴なし＝2） */
function checkTopology(f: number[][], nv: number) {
  const und = new Map<number, number>(), dir = new Set<number>();
  let manifold = true;
  for (const q of f) for (let j = 0; j < 4; j++) {
    const a = q[j], b = q[(j + 1) % 4];
    const d = a * 1e7 + b;
    if (dir.has(d)) manifold = false; // 同じ向きの辺が2回＝向きが揃っていない
    dir.add(d);
    const k = Math.min(a, b) * 1e7 + Math.max(a, b);
    und.set(k, (und.get(k) ?? 0) + 1);
  }
  let closed = true;
  for (const c of und.values()) if (c !== 2) closed = false;
  return { closed, manifold, euler: nv - und.size + f.length };
}

/** 形状の指紋（頂点数・面・UV・ウェイトから。V1 が変わっていないことの確認用） */
export function topologyHash(d: BaseMeshData): string {
  let h = 0x811c9dc5;
  const mix = (x: number) => { h ^= x & 0xffff; h = Math.imul(h, 0x01000193) >>> 0; h ^= x >>> 16; h = Math.imul(h, 0x01000193) >>> 0; };
  mix(d.positions.length / 3);
  d.index.forEach(mix);
  d.uvs.forEach(u => mix(Math.round(u * 1e4)));
  d.skinIndex.forEach(mix);
  return h.toString(16).padStart(8, '0').toUpperCase();
}

// ---------------------------------------------------------------- three.js オブジェクト
export function makeBaseGeometry(d = buildBaseMeshData()): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(d.positions.slice(), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(d.normals.slice(), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(d.uvs.slice(), 2));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(d.skinIndex.slice(), 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(d.skinWeight.slice(), 4));
  g.setIndex(new THREE.BufferAttribute(d.index.slice(), 1));
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}

export function makeSkeleton(d = buildBaseMeshData()) {
  const bones = BONES_V1.map(b => { const o = new THREE.Bone(); o.name = b.name; return o; });
  BONES_V1.forEach((b, i) => {
    const p = d.joints[b.joint];
    if (b.parent < 0) bones[i].position.set(...p);
    else {
      const q = d.joints[BONES_V1[b.parent].joint];
      bones[i].position.set(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      bones[b.parent].add(bones[i]);
    }
  });
  return { bones, skeleton: new THREE.Skeleton(bones) };
}

/** 単体の Standard Base Mesh V1（SkinnedMesh＋骨格＋マテリアル） */
export function makeBaseMesh(material?: THREE.Material) {
  const d = buildBaseMeshData();
  const geo = makeBaseGeometry(d);
  const mat = material ?? new THREE.MeshStandardMaterial({ color: 0xc9d3dd, roughness: 0.75, metalness: 0 });
  if (!material) mat.name = 'E118_Base_V1';
  const mesh = new THREE.SkinnedMesh(geo, mat);
  mesh.name = 'E118_BaseMesh_V1';
  const { bones, skeleton } = makeSkeleton(d);
  mesh.add(bones[0]);
  mesh.bind(skeleton);
  mesh.userData.baseMesh = BASE_MESH_VERSION;
  return { mesh, bones, skeleton, data: d };
}

// ---------------------------------------------------------------- テストポーズ
export type PoseId = 'tpose' | 'armsDown' | 'elbow90' | 'knee90' | 'hipBend' | 'headTurn';
const deg = Math.PI / 180;
/** ボーン名 → オイラー角 [x,y,z]（度）。T ポーズからの回転 */
export const POSES: Record<PoseId, Record<string, [number, number, number]>> = {
  tpose: {},
  armsDown: { UpperArm_L: [0, 0, -70], UpperArm_R: [0, 0, 70] },
  elbow90: { LowerArm_L: [0, -90, 0], LowerArm_R: [0, 90, 0] },
  knee90: { LowerLeg_L: [90, 0, 0], LowerLeg_R: [90, 0, 0] },
  hipBend: { UpperLeg_L: [-90, 0, 0], UpperLeg_R: [-90, 0, 0] },
  headTurn: { Head: [0, 45, 0], Neck: [0, 15, 0] },
};
export function applyPose(bones: THREE.Bone[], pose: Record<string, [number, number, number]>, t = 1) {
  for (const b of bones) {
    const e = pose[b.name] ?? [0, 0, 0];
    b.rotation.set(e[0] * deg * t, e[1] * deg * t, e[2] * deg * t);
  }
}
