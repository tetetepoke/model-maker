// Phase 3：Visual Hull → Standard Base Mesh V1 フィッティング
//
// Standard Base Mesh V1 の「頂点の位置」だけを動かす。頂点数・頂点番号・面・UV・ボーン構造・
// ウェイトは V1 のまま（ここでは配列を一切作り直さない）。
//
// 順番：
//   1. Joint alignment      … SHEET 2 の17関節に合わせて、ボーンごとの移動・回転・伸縮をウェイトで混ぜる
//   2. Body proportion      … 部位ごとに「太さ」を1つの倍率で合わせる（前後・左右それぞれ）
//   3. Local body-part      … 部位を輪切りにして、高さ（長さ）ごとに太さを合わせる
//   4. Visual Hull surface  … 法線方向にだけ動かす。Visual Hull は「体の外側の上限」として使う
//                             （はみ出した頂点は内側へ戻す。外側へは少しだけ寄せる＝装備で太らせない）
//   5. Smoothing            … 移動量をなめらかにならす（形のディテールは残す）
//
// Visual Hull は目標形状（測定用）であり、完成モデルとしては使わない。
// 単純な「最も近い点への吸着」はしない。
import type { SourceImage } from './mask';
import type { ViewId } from './sheetParse';
import type { JointId } from './sheetSpec';
import { buildBaseMeshData, BONES_V1, type BaseMeshData } from './basemesh';

type V3 = [number, number, number];
export type FitJoints = Record<JointId, { x: number; y: number; z: number }>;
export interface FitInput { joints: FitJoints; views: Partial<Record<ViewId, SourceImage>>; W: number; D: number }
export interface FitStage { id: string; label: string; pos: Float32Array }
export interface FitResult {
  stages: FitStage[];
  /** 完成した形（GLB の頂点の並び） */
  positions: Float32Array;
  normals: Float32Array;
  joints: Record<JointId, V3>;
  iou: Partial<Record<ViewId, number>>;
  stats: { ms: number; outsideBefore: number; outsideAfter: number; flipped: number; maxMove: number; clamped: string[]; detail: { flipped: Record<string, number>; outside: Record<string, number> } };
}

// ------------------------------------------------------------------ 小さなベクトル関数
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
type M3 = number[]; // 行優先 3×3
const mv = (m: M3, v: V3): V3 => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
const mm = (a: M3, b: M3): M3 => {
  const r = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
};
/** a を b に向ける回転 */
function rotBetween(a: V3, b: V3): M3 {
  const v = cross(a, b), c = dot(a, b), s = len(v);
  if (s < 1e-9) return c > 0 ? [1, 0, 0, 0, 1, 0, 0, 0, 1] : [-1, 0, 0, 0, 1, 0, 0, 0, -1];
  const k = norm(v), [x, y, z] = k, C = 1 - c;
  return [c + x * x * C, x * y * C - z * s, x * z * C + y * s, y * x * C + z * s, c + y * y * C, y * z * C - x * s, z * x * C - y * s, z * y * C + x * s, c + z * z * C];
}
/** 方向 d に沿って k 倍する行列 */
const stretch = (d: V3, k: number): M3 => [0, 1, 2].flatMap(i => [0, 1, 2].map(j => (i === j ? 1 : 0) + (k - 1) * d[i] * d[j]));

// ------------------------------------------------------------------ シルエット（Visual Hull と同じ座標の決め方）
export class Silhouettes {
  constructor(private v: Partial<Record<ViewId, SourceImage>>, private W: number, private D: number) {}
  private sideHit(s: SourceImage, mirror: boolean, u: number, v: number) {
    const px = Math.floor((mirror ? -u : u) * s.h + s.w / 2), py = Math.floor((1 - v) * s.h);
    return px >= 0 && py >= 0 && px < s.w && py < s.h && s.mask[py * s.w + px] === 1;
  }
  private topHit(x: number, z: number) {
    const s = this.v.top!;
    const px = Math.floor((x / this.W + 0.5) * s.w), py = Math.floor((z / this.D + 0.5) * s.h);
    return px >= 0 && py >= 0 && px < s.w && py < s.h && s.mask[py * s.w + px] === 1;
  }
  /** Visual Hull の内側か（＝使うすべてのシルエットの内側） */
  inside(p: V3) {
    const { front, back, right, left, top } = this.v;
    if (front && !this.sideHit(front, false, p[0], p[1])) return false;
    if (back && !this.sideHit(back, true, p[0], p[1])) return false;
    if (right && !this.sideHit(right, false, p[2], p[1])) return false;
    if (left && !this.sideHit(left, true, p[2], p[1])) return false;
    if (top && !this.topHit(p[0], p[2])) return false;
    return true;
  }
  /** 1本の線に沿って、点 a を含む（または a に最も近い）シルエットの区間 [lo, hi] を返す（世界座標） */
  private run(hit: (t: number) => boolean, a: number, step: number, search: number): [number, number] | null {
    let s = a;
    if (!hit(s)) {
      let found = false;
      for (let d = step; d <= search; d += step) {
        if (hit(a - d)) { s = a - d; found = true; break; }
        if (hit(a + d)) { s = a + d; found = true; break; }
      }
      if (!found) return null;
    }
    let lo = s, hi = s;
    while (hit(lo - step) && lo - a > -1) lo -= step;
    while (hit(hi + step) && hi - a < 1) hi += step;
    return [lo - step / 2, hi + step / 2];
  }
  /** 横方向（x）の区間：FRONT の行（無ければ BACK） */
  spanX(y: number, x: number, search = 0.02): [number, number] | null {
    const f = this.v.front, b = this.v.back;
    if (f) return this.run(t => this.sideHit(f, false, t, y), x, 1 / f.h, search);
    if (b) return this.run(t => this.sideHit(b, true, t, y), x, 1 / b.h, search);
    return null;
  }
  /** 奥行き（z）の区間：RIGHT と LEFT の共通部分 */
  spanZ(y: number, z: number, search = 0.02): [number, number] | null {
    const r = this.v.right, l = this.v.left;
    const a = r ? this.run(t => this.sideHit(r, false, t, y), z, 1 / r.h, search) : null;
    const b = l ? this.run(t => this.sideHit(l, true, t, y), z, 1 / l.h, search) : null;
    if (a && b) { const lo = Math.max(a[0], b[0]), hi = Math.min(a[1], b[1]); return hi > lo ? [lo, hi] : a; }
    return a ?? b;
  }
  /** 縦方向（y）の区間：FRONT の列（腕の太さ） */
  spanY(x: number, y: number, search = 0.02): [number, number] | null {
    const f = this.v.front, b = this.v.back;
    if (f) return this.run(t => this.sideHit(f, false, x, t), y, 1 / f.h, search);
    if (b) return this.run(t => this.sideHit(b, true, x, t), y, 1 / b.h, search);
    return null;
  }
  /** 上から見た奥行き（z）の区間：TOP の列（腕の前後の太さ） */
  spanTopZ(x: number, z: number, search = 0.02): [number, number] | null {
    const t = this.v.top;
    if (!t) return null;
    return this.run(q => this.topHit(x, q), z, this.D / t.h, search);
  }
  hitFront(x: number, y: number) { const f = this.v.front; return f ? this.sideHit(f, false, x, y) : false; }
}

// ------------------------------------------------------------------ 部位（ボーン）と軸
type Pt = JointId | 'HEAD_TOP' | 'TIP_L' | 'TIP_R' | 'SOLE_L' | 'SOLE_R';
/** ボーン番号 → 軸の始点・終点 */
const SEG: [Pt, Pt][] = [
  ['HIPS', 'SPINE'], ['SPINE', 'CHEST'], ['CHEST', 'NECK'], ['NECK', 'HEAD'], ['HEAD', 'HEAD_TOP'],
  ['SHOULDER_L', 'ELBOW_L'], ['ELBOW_L', 'WRIST_L'], ['WRIST_L', 'TIP_L'],
  ['SHOULDER_R', 'ELBOW_R'], ['ELBOW_R', 'WRIST_R'], ['WRIST_R', 'TIP_R'],
  ['HIP_L', 'KNEE_L'], ['KNEE_L', 'ANKLE_L'], ['ANKLE_L', 'SOLE_L'],
  ['HIP_R', 'KNEE_R'], ['KNEE_R', 'ANKLE_R'], ['ANKLE_R', 'SOLE_R'],
];
const isArm = (b: number) => b >= 5 && b <= 10;
const isLeg = (b: number) => b >= 11;
const isTorso = (b: number) => b <= 2;
const SLICES = [6, 6, 6, 4, 10, 8, 8, 5, 8, 8, 5, 8, 8, 5, 8, 8, 5];

interface Mesh { n: number; P: V3[]; quads: Uint32Array; nb: number[][]; wi: Uint16Array; ww: Float32Array; dom: Uint8Array }

function shapeMesh(d: BaseMeshData): Mesh {
  const n = d.shapeCount;
  const P: V3[] = new Array(n);
  const wi = new Uint16Array(n * 4), ww = new Float32Array(n * 4), dom = new Uint8Array(n);
  const seen = new Uint8Array(n);
  d.shapeIndex.forEach((s, i) => {
    if (seen[s]) return; seen[s] = 1;
    P[s] = [d.positions[i * 3], d.positions[i * 3 + 1], d.positions[i * 3 + 2]];
    let best = 0;
    for (let j = 0; j < 4; j++) {
      wi[s * 4 + j] = d.skinIndex[i * 4 + j]; ww[s * 4 + j] = d.skinWeight[i * 4 + j];
      if (ww[s * 4 + j] > ww[s * 4 + best]) best = j;
    }
    dom[s] = wi[s * 4 + best];
  });
  const nbs: Set<number>[] = Array.from({ length: n }, () => new Set());
  for (let k = 0; k < d.quads.length; k += 4) for (let j = 0; j < 4; j++) {
    const a = d.quads[k + j], b = d.quads[k + (j + 1) % 4];
    nbs[a].add(b); nbs[b].add(a);
  }
  return { n, P, quads: d.quads, nb: nbs.map(s => [...s]), wi, ww, dom };
}

function quadNormals(P: V3[], quads: Uint32Array): V3[] {
  const N: V3[] = P.map(() => [0, 0, 0]);
  for (let k = 0; k < quads.length; k += 4) {
    const a = P[quads[k]], b = P[quads[k + 1]], c = P[quads[k + 2]], d = P[quads[k + 3]];
    const n = cross(sub(c, a), sub(d, b));
    for (let j = 0; j < 4; j++) { const v = N[quads[k + j]]; v[0] += n[0]; v[1] += n[1]; v[2] += n[2]; }
  }
  return N.map(norm);
}
function faceNormals(P: V3[], quads: Uint32Array): V3[] {
  const out: V3[] = [];
  for (let k = 0; k < quads.length; k += 4) out.push(norm(cross(sub(P[quads[k + 2]], P[quads[k]]), sub(P[quads[k + 3]], P[quads[k + 1]]))));
  return out;
}

/** 点の集合（ベース or 目標）。足りない点（頭頂・指先・足裏）を補う */
function basePoints(d: BaseMeshData, m: Mesh): Record<Pt, V3> {
  const J = d.joints;
  let top = 0, tipL = 0;
  for (let i = 0; i < m.n; i++) {
    if (m.dom[i] === 4) top = Math.max(top, m.P[i][1]);
    if (m.dom[i] === 7) tipL = Math.max(tipL, m.P[i][0]);
  }
  return {
    ...J,
    HEAD_TOP: [J.HEAD[0], top, J.HEAD[2]],
    TIP_L: [tipL, J.WRIST_L[1], J.WRIST_L[2]], TIP_R: [-tipL, J.WRIST_R[1], J.WRIST_R[2]],
    SOLE_L: [J.ANKLE_L[0], 0, J.ANKLE_L[2]], SOLE_R: [J.ANKLE_R[0], 0, J.ANKLE_R[2]],
  } as Record<Pt, V3>;
}
function targetPoints(inp: FitInput, base: Record<Pt, V3>, sil: Silhouettes): Record<Pt, V3> {
  const J = Object.fromEntries(Object.entries(inp.joints).map(([k, j]) => [k, [j.x, j.y, j.z] as V3])) as Record<JointId, V3>;
  // 頭頂：首→頭の中心の長さから推定（髪・帽子の高さに引っぱられないよう、シルエットの上端は上限としてだけ使う）
  const k = (J.HEAD[1] - J.NECK[1]) / Math.max(1e-3, base.HEAD[1] - base.NECK[1]);
  let silTop = 1;
  const col = sil.spanY(J.HEAD[0], J.HEAD[1], 0.05);
  if (col) silTop = Math.min(1, col[1]);
  const headTop: V3 = [J.HEAD[0], Math.min(silTop, J.HEAD[1] + (base.HEAD_TOP[1] - base.HEAD[1]) * clamp(k, 0.6, 1.6)), J.HEAD[2]];
  // 指先：手首から前腕の向きに、FRONT のシルエットが終わるところまで
  const tip = (s: 'L' | 'R'): V3 => {
    const w = J[`WRIST_${s}` as JointId], e = J[`ELBOW_${s}` as JointId];
    const dir = norm(sub(w, e));
    const baseLen = Math.abs(base[`TIP_${s}` as Pt][0] - base[`WRIST_${s}` as JointId][0]);
    const fore = len(sub(w, e)) / Math.max(1e-3, len(sub(base[`WRIST_${s}` as JointId], base[`ELBOW_${s}` as JointId])));
    let L = baseLen * fore;
    if (sil.hitFront(w[0], w[1])) {
      let t = 0;
      while (t < 0.2 && sil.hitFront(w[0] + dir[0] * (t + 0.002), w[1] + dir[1] * (t + 0.002))) t += 0.002;
      L = clamp(t, baseLen * fore * 0.5, baseLen * fore * 2);
    }
    return add(w, mul(dir, L));
  };
  return {
    ...J,
    HEAD_TOP: headTop, TIP_L: tip('L'), TIP_R: tip('R'),
    SOLE_L: [J.ANKLE_L[0], 0, J.ANKLE_L[2]], SOLE_R: [J.ANKLE_R[0], 0, J.ANKLE_R[2]],
  } as Record<Pt, V3>;
}

// ------------------------------------------------------------------ 1. Joint alignment
function jointAlign(m: Mesh, B: Record<Pt, V3>, T: Record<Pt, V3>): V3[] {
  const X: V3 = [1, 0, 0];
  const sx = {
    hips: Math.abs(T.HIP_L[0] - T.HIP_R[0]) / Math.abs(B.HIP_L[0] - B.HIP_R[0]),
    chest: Math.abs(T.SHOULDER_L[0] - T.SHOULDER_R[0]) / Math.abs(B.SHOULDER_L[0] - B.SHOULDER_R[0]),
  };
  const xf = SEG.map(([s, e], b) => {
    const a0 = norm(sub(B[e], B[s])), a1 = norm(sub(T[e], T[s]));
    const k = clamp(len(sub(T[e], T[s])) / Math.max(1e-4, len(sub(B[e], B[s]))), 0.25, 4);
    let S = stretch(a0, k);
    if (isTorso(b)) {
      const lat = clamp(b === 0 ? sx.hips : b === 2 ? sx.chest : (sx.hips + sx.chest) / 2, 0.5, 2);
      const e0 = norm(sub(X, mul(a0, dot(X, a0))));
      S = mm(stretch(e0, lat), S);
    } else if (b === 4) S = stretch(a0, 1).map((_, i) => (i % 4 === 0 ? k : 0)); // 頭：大きさごと
    else if (b === 7 || b === 10) { const r = Math.sqrt(k); S = mm(stretch(a0, r), [r, 0, 0, 0, r, 0, 0, 0, r]); } // 手：長さ k、太さ √k
    return { M: mm(rotBetween(a0, a1), S), s0: B[s], s1: T[s] };
  });
  return m.P.map((p, i) => {
    let o: V3 = [0, 0, 0];
    for (let j = 0; j < 4; j++) {
      const w = m.ww[i * 4 + j]; if (!w) continue;
      const t = xf[m.wi[i * 4 + j]];
      o = add(o, mul(add(t.s1, mv(t.M, sub(p, t.s0))), w));
    }
    return o;
  });
}

// ------------------------------------------------------------------ 2・3. 太さ合わせ（部位ごと → 輪切りごと）
interface Frame { s: V3; a: V3; L: number; d: [V3, V3]; vertical: boolean }
function frames(T: Record<Pt, V3>): Frame[] {
  return SEG.map(([s, e], b) => {
    const a = norm(sub(T[e], T[s])), L = len(sub(T[e], T[s]));
    const vertical = !isArm(b);
    const ref1: V3 = vertical ? [1, 0, 0] : [0, 1, 0], ref2: V3 = [0, 0, 1];
    const d1 = norm(sub(ref1, mul(a, dot(ref1, a))));
    let d2 = norm(sub(ref2, mul(a, dot(ref2, a))));
    d2 = norm(sub(d2, mul(d1, dot(d2, d1))));
    return { s: T[s], a, L: Math.max(L, 1e-3), d: [d1, d2], vertical };
  });
}

/** 倍率表：bone → 方向(0,1) → 側(0=マイナス,1=プラス) → 輪切り */
type Factors = number[][][][];

function measure(m: Mesh, P: V3[], F: Frame[], T: Record<Pt, V3>, sil: Silhouettes, clampedLog: Set<string>): Factors {
  const shoulderHalf = Math.abs(T.SHOULDER_L[0] - T.SHOULDER_R[0]) / 2;
  const hipHalf = Math.abs(T.HIP_L[0] - T.HIP_R[0]) / 2;
  return F.map((f, b) => {
    const N = SLICES[b];
    // メッシュ側：このボーンが主の頂点の、輪切りごとの最小・最大
    const mn = [0, 1].map(() => new Array(N).fill(0)), mx = [0, 1].map(() => new Array(N).fill(0));
    for (let i = 0; i < m.n; i++) {
      if (m.dom[i] !== b) continue;
      const r = sub(P[i], f.s), t = dot(r, f.a) / f.L;
      const k = clamp(Math.floor(t * N), 0, N - 1);
      const c = add(f.s, mul(f.a, dot(r, f.a)));
      for (let q = 0; q < 2; q++) {
        const o = dot(sub(P[i], c), f.d[q]);
        if (o < mn[q][k]) mn[q][k] = o;
        if (o > mx[q][k]) mx[q][k] = o;
      }
    }
    const out: number[][][] = [0, 1].map(() => [0, 1].map(() => new Array(N).fill(NaN)));
    for (let k = 0; k < N; k++) {
      const c = add(f.s, mul(f.a, f.L * (k + 0.5) / N));
      for (let q = 0; q < 2; q++) {
        let span: [number, number] | null;
        let center: number;
        if (f.vertical) {
          if (q === 0) { span = sil.spanX(c[1], c[0]); center = c[0]; }
          else { span = sil.spanZ(c[1], c[2]); center = c[2]; }
        } else {
          if (q === 0) { span = sil.spanY(c[0], c[1]); center = c[1]; }
          else { span = sil.spanTopZ(c[0], c[2]); center = c[2]; }
        }
        if (!span) continue;
        let lo = span[0] - center, hi = span[1] - center;
        // 体だけを測るための上限（腕がつながった胴の行、くっついた脚、など）
        if (isTorso(b) && q === 0) {
          const cap = b === 0 ? Math.max(hipHalf * 2, shoulderHalf * 0.8) : shoulderHalf * 0.92;
          if (-lo > cap || hi > cap) clampedLog.add('胴の横幅（腕・装備の影を除外）');
          lo = Math.max(lo, -cap); hi = Math.min(hi, cap);
        }
        if (isLeg(b) && q === 0) {
          const inner = Math.abs(c[0]) * 0.95;
          if (c[0] > 0) { if (-lo > inner) clampedLog.add('脚の内側（左右の脚の重なりを除外）'); lo = Math.max(lo, -inner); }
          else { if (hi > inner) clampedLog.add('脚の内側（左右の脚の重なりを除外）'); hi = Math.min(hi, inner); }
        }
        for (const [side, tv, mvv] of [[0, lo, mn[q][k]], [1, hi, mx[q][k]]] as [number, number, number][]) {
          if (Math.abs(mvv) < 2e-3) continue;
          const r = tv / mvv;
          if (!(r > 0.35 && r < 1.8)) { clampedLog.add(b === 4 ? '頭（髪・帽子の可能性）' : isArm(b) ? '腕（胴・装備との重なり）' : '装備・重なりの可能性がある部分'); continue; }
          out[q][side][k] = clamp(r, 0.55, b === 4 ? 1.35 : 1.5);
        }
      }
    }
    return out;
  });
}
const median = (a: number[]) => { const v = a.filter(x => !isNaN(x)).sort((p, q) => p - q); return v.length ? v[v.length >> 1] : 1; };
function fillSmooth(a: number[], passes: number): number[] {
  const N = a.length, v = a.slice();
  const valid = v.map(x => !isNaN(x));
  if (!valid.some(Boolean)) return v.map(() => 1);
  for (let i = 0; i < N; i++) if (!valid[i]) {
    let l = i - 1, r = i + 1;
    while (l >= 0 && !valid[l]) l--;
    while (r < N && !valid[r]) r++;
    v[i] = l < 0 ? a[r] : r >= N ? a[l] : a[l] + (a[r] - a[l]) * (i - l) / (r - l);
  }
  let cur = v;
  for (let p = 0; p < passes; p++) cur = cur.map((x, i) => 0.25 * cur[Math.max(0, i - 1)] + 0.5 * x + 0.25 * cur[Math.min(N - 1, i + 1)]);
  return cur;
}
function applyFactors(m: Mesh, P: V3[], F: Frame[], fac: Factors): V3[] {
  return P.map((p, i) => {
    let out: V3 = [0, 0, 0], wsum = 0;
    for (let j = 0; j < 4; j++) {
      const w = m.ww[i * 4 + j]; if (!w) continue;
      const b = m.wi[i * 4 + j], f = F[b], N = SLICES[b];
      const r = sub(p, f.s), along = dot(r, f.a);
      const t = clamp(along / f.L * N - 0.5, 0, N - 1);
      const k0 = Math.floor(t), k1 = Math.min(N - 1, k0 + 1), u = t - k0;
      const c = add(f.s, mul(f.a, along));
      let q3 = p;
      for (let q = 0; q < 2; q++) {
        const o = dot(sub(p, c), f.d[q]);
        const side = o < 0 ? 0 : 1;
        let s = fac[b][q][side][k0] * (1 - u) + fac[b][q][side][k1] * u;
        // 腕・脚の付け根は胴とつながっているので、付け根に近いほど倍率を弱める（脇・股の面が潰れて裏返らないように）
        if (b === 5 || b === 8 || b === 11 || b === 14) { const tt = along / f.L; const r = clamp((tt + 0.15) / 0.5, 0, 1); s = 1 + (s - 1) * r * r * (3 - 2 * r); }
        q3 = add(q3, mul(f.d[q], o * (s - 1)));
      }
      out = add(out, mul(q3, w)); wsum += w;
    }
    return mul(out, 1 / (wsum || 1));
  });
}

// ------------------------------------------------------------------ 4. Visual Hull 表面
function surfaceFit(m: Mesh, P: V3[], sil: Silhouettes, iters: number): V3[] {
  let cur = P;
  for (let it = 0; it < iters; it++) {
    const N = quadNormals(cur, m.quads);
    const disp: V3[] = cur.map((p, i) => {
      const n = N[i];
      if (!sil.inside(p)) {
        // はみ出し：内側へ戻す（最大 0.05）
        for (let t = 0.002; t <= 0.05; t += 0.002) { const q = add(p, mul(n, -t)); if (sil.inside(q)) return mul(n, -t); }
        return [0, 0, 0];
      }
      // 内側：外側の境界が近いときだけ少し寄せる（装備で太らせないため上限 0.012）
      for (let t = 0.002; t <= 0.012; t += 0.002) { if (!sil.inside(add(p, mul(n, t)))) return mul(n, (t - 0.002) * 0.7); }
      return [0, 0, 0];
    });
    // 移動量をならす（隣とのつながりを保つ）
    let D = disp;
    for (let s = 0; s < 2; s++) D = D.map((d, i) => {
      const nb = m.nb[i]; let a: V3 = [0, 0, 0];
      for (const j of nb) a = add(a, D[j]);
      return add(mul(d, 0.5), mul(a, 0.5 / nb.length));
    });
    cur = cur.map((p, i) => add(p, D[i]));
  }
  return cur;
}

// ------------------------------------------------------------------ 5. Smoothing / regularization
/** 裏返った面（refN と逆向き）の頂点だけを、隣の平均へ寄せてほどく */
function untangle(m: Mesh, P: V3[], refN: V3[]): V3[] {
  let cur = P;
  for (let it = 0; it < 20; it++) {
    const fn = faceNormals(cur, m.quads);
    const bad = new Set<number>();
    for (let k = 0; k < fn.length; k++) if (dot(fn[k], refN[k]) < 0.2) for (let j = 0; j < 4; j++) { const v = m.quads[k * 4 + j]; bad.add(v); for (const u of m.nb[v]) bad.add(u); }
    if (!bad.size) break;
    const prev = cur;
    cur = prev.map((p, i) => {
      if (!bad.has(i)) return p;
      let a: V3 = [0, 0, 0]; for (const j of m.nb[i]) a = add(a, prev[j]);
      return add(mul(p, 0.5), mul(a, 0.5 / m.nb[i].length));
    });
  }
  return cur;
}

function regularize(m: Mesh, P: V3[], ref: V3[], sil: Silhouettes, orientRef: V3[]): V3[] {
  // ref（太さ合わせ後）の形の細かさを残したまま、移動量だけをならす
  let D: V3[] = P.map((p, i) => sub(p, ref[i]));
  for (let s = 0; s < 3; s++) D = D.map((d, i) => {
    const nb = m.nb[i]; let a: V3 = [0, 0, 0];
    for (const j of nb) a = add(a, D[j]);
    return add(mul(d, 0.6), mul(a, 0.4 / nb.length));
  });
  let out = ref.map((p, i) => add(p, D[i]));
  const refN = faceNormals(orientRef, m.quads);
  // 仕上げ：裏返りをほどき、まだはみ出している頂点だけ法線の内側へ戻す
  for (let it = 0; it < 6; it++) {
    out = untangle(m, out, refN);
    const N = quadNormals(out, m.quads);
    out = out.map((p, i) => {
      if (sil.inside(p)) return p;
      for (let t = 0.002; t <= 0.05; t += 0.002) { const q = add(p, mul(N[i], -t)); if (sil.inside(q)) return q; }
      return p;
    });
  }
  return out;
}

// ------------------------------------------------------------------ 一致度（各方向の影 vs 元のシルエット）
export function silhouetteIoU(P: ArrayLike<number>, index: ArrayLike<number>, views: Partial<Record<ViewId, SourceImage>>, W: number, D: number) {
  const out: Partial<Record<ViewId, number>> = {};
  for (const id of ['front', 'right', 'back', 'left', 'top'] as ViewId[]) {
    const s = views[id]; if (!s) continue;
    const img = new Uint8Array(s.w * s.h);
    const proj = (i: number): [number, number] => {
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      if (id === 'top') return [(x / W + 0.5) * s.w, (z / D + 0.5) * s.h];
      const u = id === 'front' ? x : id === 'back' ? -x : id === 'right' ? z : -z;
      return [u * s.h + s.w / 2, (1 - y) * s.h];
    };
    for (let t = 0; t < index.length; t += 3) {
      const a = proj(index[t]), b = proj(index[t + 1]), c = proj(index[t + 2]);
      const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), y1 = Math.min(s.h - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
      for (let y = y0; y <= y1; y++) {
        const yc = y + 0.5;
        let xl = Infinity, xr = -Infinity;
        for (const [p, q] of [[a, b], [b, c], [c, a]]) {
          if ((p[1] <= yc && q[1] > yc) || (q[1] <= yc && p[1] > yc)) {
            const x = p[0] + (yc - p[1]) / (q[1] - p[1]) * (q[0] - p[0]);
            xl = Math.min(xl, x); xr = Math.max(xr, x);
          }
        }
        if (xl > xr) continue;
        const x0 = Math.max(0, Math.ceil(xl - 0.5)), x1 = Math.min(s.w - 1, Math.floor(xr - 0.5));
        for (let x = x0; x <= x1; x++) img[y * s.w + x] = 1;
      }
    }
    let inter = 0, uni = 0;
    for (let i = 0; i < img.length; i++) { const p = img[i], q = s.mask[i]; if (p && q) inter++; if (p || q) uni++; }
    out[id] = uni ? inter / uni : 0;
  }
  return out;
}

// ------------------------------------------------------------------ 本体
export function fitBaseMesh(inp: FitInput): FitResult {
  const t0 = performance.now();
  const d = buildBaseMeshData();
  const m = shapeMesh(d);
  const sil = new Silhouettes(inp.views, inp.W, inp.D);
  const B = basePoints(d, m), T = targetPoints(inp, B, sil);
  const clampedLog = new Set<string>();
  const stages: FitStage[] = [];
  const snap = (id: string, label: string, P: V3[]) => { const a = new Float32Array(m.n * 3); P.forEach((p, i) => a.set(p, i * 3)); stages.push({ id, label, pos: a }); };
  snap('base', '0. Base Mesh V1（そのまま）', m.P);

  // 1
  let P = jointAlign(m, B, T);
  const afterJoint = P;
  snap('joint', '1. Joint alignment', P);
  const F = frames(T);
  // 2：部位ごとに1つの倍率
  const raw = measure(m, P, F, T, sil, clampedLog);
  const prop: Factors = raw.map((bq, b) => bq.map(sides => sides.map(sl => new Array(SLICES[b]).fill(median(sl)))));
  P = applyFactors(m, P, F, prop);
  snap('proportion', '2. Body proportion', P);
  // 3：輪切りごと（なめらかにつなぐ）
  const loc = measure(m, P, F, T, sil, clampedLog).map(bq => bq.map(sides => sides.map(sl => fillSmooth(sl, 2))));
  P = applyFactors(m, P, F, loc);
  const afterLocal = P;
  snap('local', '3. Local body-part', P);
  // 4
  const outsideBefore = P.filter(p => !sil.inside(p)).length;
  P = surfaceFit(m, P, sil, 4);
  snap('surface', '4. Visual Hull surface', P);
  // 5
  P = regularize(m, P, afterLocal, sil, afterJoint);
  snap('final', '5. Smoothing / regularization（完成）', P);
  const outsideAfter = P.filter(p => !sil.inside(p)).length;

  // 裏返った面（関節合わせ直後との比較）
  const fa = faceNormals(stages[1].pos.length ? toV3(stages[1].pos) : m.P, m.quads), fb = faceNormals(P, m.quads);
  let flipped = 0; const detail = { flipped: {} as Record<string, number>, outside: {} as Record<string, number> };
  for (let k = 0; k < fa.length; k++) if (dot(fa[k], fb[k]) < 0) { flipped++; const pn = d.quadPart[k]; detail.flipped[pn] = (detail.flipped[pn] ?? 0) + 1; }
  P.forEach((p, i) => { if (!sil.inside(p)) { const bn = BONES_V1[m.dom[i]].name; detail.outside[bn] = (detail.outside[bn] ?? 0) + 1; } });
  let maxMove = 0; P.forEach((p, i) => { maxMove = Math.max(maxMove, len(sub(p, m.P[i]))); });

  // GLB の頂点の並びへ（UV の継ぎ目で分かれた頂点は同じ位置）
  const positions = new Float32Array(d.positions.length), normals = new Float32Array(d.normals.length);
  const Nv = quadNormals(P, m.quads);
  d.shapeIndex.forEach((s, i) => { positions.set(P[s], i * 3); normals.set(Nv[s], i * 3); });
  const joints = Object.fromEntries(Object.keys(d.joints).map(k => [k, T[k as JointId]])) as Record<JointId, V3>;
  const iou = silhouetteIoU(positions, d.index, inp.views, inp.W, inp.D);
  return { stages, positions, normals, joints, iou, stats: { ms: performance.now() - t0, outsideBefore, outsideAfter, flipped, maxMove, clamped: [...clampedLog], detail } };
}
const toV3 = (a: Float32Array): V3[] => { const o: V3[] = []; for (let i = 0; i < a.length; i += 3) o.push([a[i], a[i + 1], a[i + 2]]); return o; };

export { BONES_V1 };
