// Phase 4：関節の3D位置 → 骨格 → Auto Rig（スキンウェイト）→ テストポーズ
// 計算だけを置く（画面は rigUI.ts）。Phase 1〜3 のコードは読むだけで変更しない。
import type { JointId } from './sheetSpec';
import type { SourceImage } from './mask';
import type { ViewId } from './sheetParse';
import { Silhouettes } from './fit';
import { BONES_V1, BASE_MESH_VERSION, type BaseMeshData, type Part } from './basemesh';

export type V3 = [number, number, number];
export type Joints3 = Record<JointId, V3>;
export const RIG_VERSION = 'E118-RIG-V1';
export const JOINT_ORDER: JointId[] = BONES_V1.map(b => b.joint);
const PAIRS: [JointId, JointId][] = [['SHOULDER_L', 'SHOULDER_R'], ['ELBOW_L', 'ELBOW_R'], ['WRIST_L', 'WRIST_R'], ['HIP_L', 'HIP_R'], ['KNEE_L', 'KNEE_R'], ['ANKLE_L', 'ANKLE_R']];
const CENTER: JointId[] = ['HIPS', 'SPINE', 'CHEST', 'NECK', 'HEAD'];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const ss = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ------------------------------------------------------------------ 1. 関節の3D位置
export interface AutoJointInput {
  sheetJoints: Record<JointId, { x: number; y: number; z: number }>;
  views: Partial<Record<ViewId, SourceImage>>;
  W: number; D: number;
}
export interface AutoJointResult { joints: Joints3; symmetric: boolean; center: number; notes: Record<JointId, string> }

/**
 * FRONT → x,y（SHEET 2 正面のマーカー）、SIDE → z,y（SHEET 2 側面のマーカー＋SHEET 1 の側面シルエット）、
 * TOP → x,z（腕の前後位置）。左右対称なら体の中心面で左右をそろえる。体の外に出た関節は断面の中心へ戻す。
 */
export function autoJoints(inp: AutoJointInput): AutoJointResult {
  const sil = new Silhouettes(inp.views, inp.W, inp.D);
  const J = Object.fromEntries(Object.entries(inp.sheetJoints).map(([k, j]) => [k, [j.x, j.y, j.z] as V3])) as Joints3;
  const notes = Object.fromEntries(JOINT_ORDER.map(k => [k, 'SHEET 2'])) as Record<JointId, string>;
  const mid = (s: [number, number] | null) => s ? (s[0] + s[1]) / 2 : null;

  // 体の中心面（左右ペアの中点の平均）
  const center = PAIRS.reduce((a, [l, r]) => a + (J[l][0] + J[r][0]) / 2, 0) / PAIRS.length;
  // 左右対称か（ペアの高さ・中心からの距離・奥行きの差が小さい）
  const asym = PAIRS.reduce((a, [l, r]) => a + Math.abs((J[l][0] - center) + (J[r][0] - center)) + Math.abs(J[l][1] - J[r][1]), 0) / PAIRS.length;
  const symmetric = asym < 0.02;

  // 奥行き z
  for (const k of CENTER) {
    const s = sil.spanZ(J[k][1], J[k][2]);
    const m = mid(s);
    if (s && m !== null) {
      const inner = 0.15 * (s[1] - s[0]);
      if (J[k][2] < s[0] + inner || J[k][2] > s[1] - inner) { J[k][2] = m; notes[k] = 'SHEET 2 ＋ 側面シルエットで補正'; }
      else notes[k] = 'SHEET 2（正面＋側面マーカー）';
    }
  }
  for (const s of ['L', 'R']) {
    // 腕：肘・手首の前後位置は TOP（上から見た腕の断面の中心）。肩は SHEET 2 側面のマーカー
    for (const k of [`ELBOW_${s}`, `WRIST_${s}`] as JointId[]) {
      const tz = mid(sil.spanTopZ(J[k][0], J[k][2]));
      if (tz !== null) { J[k][2] = tz; notes[k] = 'SHEET 2 正面 ＋ TOP（前後位置）'; }
      const ty = mid(sil.spanY(J[k][0], J[k][1]));
      if (ty !== null) J[k][1] = J[k][1] * 0.5 + ty * 0.5; // 腕の太さの中心へ寄せる
    }
    // 脚：膝・足首は脚の断面の中心へ寄せる（x は正面、z は側面）
    for (const k of [`KNEE_${s}`, `ANKLE_${s}`] as JointId[]) {
      const tx = mid(sil.spanX(J[k][1], J[k][0], 0.01));
      if (tx !== null) J[k][0] = J[k][0] * 0.5 + tx * 0.5;
      const sz = sil.spanZ(J[k][1], J[k][2]);
      const tz = mid(sz);
      if (sz && tz !== null && (k.startsWith('KNEE') || J[k][2] < sz[0] || J[k][2] > sz[1])) { J[k][2] = J[k][2] * 0.4 + tz * 0.6; }
      notes[k] = 'SHEET 2 ＋ 脚の断面の中心';
    }
  }

  // 左右対称：中心面で鏡に映した位置と平均
  if (symmetric) {
    for (const [l, r] of PAIRS) {
      const L = J[l], R = J[r];
      const ax = ((L[0] - center) - (R[0] - center)) / 2;
      const y = (L[1] + R[1]) / 2, z = (L[2] + R[2]) / 2;
      J[l] = [center + ax, y, z]; J[r] = [center - ax, y, z];
    }
    for (const k of CENTER) J[k][0] = center;
  }

  // 体の外に出た関節は、断面の中心へ。それでも外なら親の関節の方へ少しずつ戻す
  const parentOf = Object.fromEntries(BONES_V1.map(b => [b.joint, b.parent >= 0 ? BONES_V1[b.parent].joint : null])) as Record<JointId, JointId | null>;
  for (const k of JOINT_ORDER) {
    if (sil.inside(J[k])) continue;
    const arm = /^(ELBOW|WRIST)/.test(k);
    const p = J[k];
    if (arm) {
      const y = mid(sil.spanY(p[0], p[1])), z = mid(sil.spanTopZ(p[0], p[2]));
      if (y !== null) p[1] = y; if (z !== null) p[2] = z;
    } else {
      const x = mid(sil.spanX(p[1], p[0], 0.02)), z = mid(sil.spanZ(p[1], p[2]));
      if (x !== null && !CENTER.includes(k)) p[0] = x; if (z !== null) p[2] = z;
    }
    notes[k] = '体の外 → 断面の中心へ補正';
    const par = parentOf[k];
    for (let i = 0; i < 20 && par && !sil.inside(J[k]); i++) J[k] = add(mul(J[k], 0.9), mul(J[par], 0.1));
  }
  return { joints: J, symmetric, center, notes };
}

// ------------------------------------------------------------------ 2. Auto Rig（スキンウェイト）
const B = Object.fromEntries(BONES_V1.map((b, i) => [b.name, i])) as Record<string, number>;

/** 部位ごとに使ってよいボーン（左右の漏れを防ぐ） */
function allowed(parts: Set<Part>, sideL: boolean): Set<number> {
  const s = new Set<number>();
  const col = [B.Hips, B.Spine, B.Chest, B.Neck, B.Head];
  const arm = (L: boolean) => [B[L ? 'UpperArm_L' : 'UpperArm_R'], B[L ? 'LowerArm_L' : 'LowerArm_R'], B[L ? 'Hand_L' : 'Hand_R']];
  const leg = (L: boolean) => [B[L ? 'UpperLeg_L' : 'UpperLeg_R'], B[L ? 'LowerLeg_L' : 'LowerLeg_R'], B[L ? 'Foot_L' : 'Foot_R']];
  for (const p of parts) {
    if (p === 'head') { s.add(B.Head); s.add(B.Neck); }
    else if (p === 'neck') { s.add(B.Neck); s.add(B.Head); s.add(B.Chest); }
    else if (p === 'torso' || p === 'torsoCap') { col.slice(0, 4).forEach(b => s.add(b)); s.add(arm(sideL)[0]); s.add(leg(sideL)[0]); leg(!sideL).slice(0, 1).forEach(b => s.add(b)); }
    else if (p.startsWith('arm') || p.startsWith('hand')) { const L = p.endsWith('L'); s.add(B.Chest); arm(L).forEach(b => s.add(b)); }
    else { const L = p.endsWith('L'); s.add(B.Hips); leg(L).forEach(b => s.add(b)); }
  }
  return s;
}

export interface RigWeights { skinIndex: Uint16Array; skinWeight: Float32Array; leak: { armToOtherSide: number; legToOtherSide: number; armToHead: number } }

/**
 * 頂点ごとのウェイト。関節を結ぶ鎖（胴：腰→背骨→胸→首→頭、腕：肩→肘→手首→指先、脚：股→膝→足首→足裏）に
 * 頂点を投影し、関節の前後でなめらかに受け渡す。どのボーンを使えるかは体の部位（V1 の面の部位）と、
 * 体の中心面のどちら側かで決める（左腕のウェイトが右腕・頭に漏れない）。最大4ボーン、合計1。
 */
export function computeWeights(d: BaseMeshData, positions: Float32Array, J: Joints3, extra: { headTop: V3; tipL: V3; tipR: V3 }, center: number): RigWeights {
  const n = positions.length / 3;
  // GLB の頂点 → 部位（形の頂点に接する面の部位）
  const vParts: Set<Part>[] = Array.from({ length: d.shapeCount }, () => new Set());
  for (let k = 0; k < d.quadPart.length; k++) for (let j = 0; j < 4; j++) vParts[d.quads[k * 4 + j]].add(d.quadPart[k]);
  const skinIndex = new Uint16Array(n * 4), skinWeight = new Float32Array(n * 4);

  /** 鎖の上の位置：鎖の何番目の区間の、どのくらいの所か → 区間ごとのボーンへ配分 */
  const chain = (p: V3, pts: V3[], bones: number[], blend: number[]): Map<number, number> => {
    // 最も近い区間を探す
    let best = 0, bestT = 0, bestD = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], ab = sub(pts[i + 1], a), L2 = Math.max(1e-8, dot(ab, ab));
      const t = Math.min(1, Math.max(0, dot(sub(p, a), ab) / L2));
      const dd = len(sub(p, add(a, mul(ab, t))));
      if (dd < bestD - 1e-9) { bestD = dd; best = i; bestT = t; }
    }
    // 鎖に沿った距離（始点から）。関節 k の前後 ±blend[k-1] で、ボーン k-1 → k へなめらかに受け渡す
    const out = new Map<number, number>();
    const cum = [0];
    for (let i = 0; i < pts.length - 1; i++) cum.push(cum[i] + len(sub(pts[i + 1], pts[i])));
    const a = cum[best] + bestT * (cum[best + 1] - cum[best]);
    const f = bones.map((_, k) => (k === 0 ? 1 : ss(cum[k] - blend[k - 1], cum[k] + blend[k - 1], a)));
    bones.forEach((b, k) => {
      const x = f[k] * (k + 1 < bones.length ? 1 - f[k + 1] : 1);
      if (x > 1e-4) out.set(b, (out.get(b) ?? 0) + x);
    });
    return out;
  };

  const lenUA = { L: len(sub(J.ELBOW_L, J.SHOULDER_L)), R: len(sub(J.ELBOW_R, J.SHOULDER_R)) };
  const lenTh = { L: len(sub(J.KNEE_L, J.HIP_L)), R: len(sub(J.KNEE_R, J.HIP_R)) };
  const colPts: V3[] = [J.HIPS, J.SPINE, J.CHEST, J.NECK, J.HEAD, extra.headTop];
  const colBones = [B.Hips, B.Spine, B.Chest, B.Neck, B.Head];
  const colBlend = [0.035, 0.035, 0.025, 0.02];

  let leakArm = 0, leakLeg = 0, armHead = 0;
  for (let i = 0; i < n; i++) {
    const p: V3 = [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
    const parts = vParts[d.shapeIndex[i]];
    const sideL = p[0] >= center;
    const S = sideL ? 'L' : 'R';
    const ok = allowed(parts, sideL);
    const isTorso = parts.has('torso') || parts.has('torsoCap');
    const isArmP = [...parts].some(q => q.startsWith('arm') || q.startsWith('hand'));
    const isLegP = [...parts].some(q => q.startsWith('leg') || q.startsWith('foot') || q.startsWith('sole'));
    const isHeadP = parts.has('head') || parts.has('neck');
    const w = new Map<number, number>();
    const put = (m: Map<number, number>, f: number) => { for (const [b, x] of m) if (ok.has(b) && x * f > 1e-4) w.set(b, (w.get(b) ?? 0) + x * f); };

    // 腕の割合
    let arm = 0;
    let armSide = S;
    if (isArmP) armSide = [...parts].find(q => q.startsWith('arm') || q.startsWith('hand'))!.endsWith('L') ? 'L' : 'R';
    if ((isArmP || isTorso) && !isHeadP) {
      const sh = J[`SHOULDER_${armSide}` as JointId], el = J[`ELBOW_${armSide}` as JointId];
      const dir = norm(sub(el, sh)), L = armSide === 'L' ? lenUA.L : lenUA.R;
      const t = dot(sub(p, sh), dir);
      if (isArmP && !isTorso) arm = ss(-0.45 * L, -0.05 * L, t);
      else {
        // 胴：肩の外側・脇より上だけ少し腕へ（肩の丸み）。脇の下の胴は胴のまま
        const up = ss(sh[1] - 0.22 * L, sh[1] + 0.05 * L, p[1]);
        arm = ss(-0.3 * L, 0.08 * L, t) * up;
        if (isArmP) arm = Math.max(arm, ss(-0.3 * L, 0.0, t)); // 腕と胴の境目の頂点
      }
    }
    if (arm > 0) {
      const s = armSide;
      const pts: V3[] = [J[`SHOULDER_${s}` as JointId], J[`ELBOW_${s}` as JointId], J[`WRIST_${s}` as JointId], s === 'L' ? extra.tipL : extra.tipR];
      const L = s === 'L' ? lenUA.L : lenUA.R;
      put(chain(p, pts, [B[`UpperArm_${s}`], B[`LowerArm_${s}`], B[`Hand_${s}`]], [0.16 * L, 0.09 * L]), arm);
    }
    // 脚の割合
    let leg = 0;
    if ((isLegP || isTorso) && !isHeadP && !isArmP) {
      const legs: ('L' | 'R')[] = isLegP ? [[...parts].find(q => q.startsWith('leg') || q.startsWith('foot') || q.startsWith('sole'))!.endsWith('L') ? 'L' : 'R'] : ['L', 'R'];
      for (const s of legs) {
        const hip = J[`HIP_${s}` as JointId], kn = J[`KNEE_${s}` as JointId];
        const dir = norm(sub(kn, hip)), L = s === 'L' ? lenTh.L : lenTh.R;
        const t = dot(sub(p, hip), dir);
        let f = isLegP && !isTorso ? 1 : ss(-0.3 * L, 0.12 * L, t);
        if (!isLegP) f *= s === 'L' ? ss(center - 0.012, center + 0.012, p[0]) : 1 - ss(center - 0.012, center + 0.012, p[0]);
        if (f <= 0) continue;
        leg += f;
        const pts: V3[] = [hip, kn, J[`ANKLE_${s}` as JointId], [J[`ANKLE_${s}` as JointId][0], 0, J[`ANKLE_${s}` as JointId][2]]];
        put(chain(p, pts, [B[`UpperLeg_${s}`], B[`LowerLeg_${s}`], B[`Foot_${s}`]], [0.16 * L, 0.08 * L]), f);
      }
    }
    // 残りは胴・首・頭の鎖。頭は丸ごと Head、首は胸→首→頭へなめらかに（頭を回しても首の付け根がちぎれない）
    const rest = Math.max(0, 1 - arm - leg);
    const neckTop = J.NECK[1] + 0.35 * (J.HEAD[1] - J.NECK[1]);
    if (rest > 0 && parts.has('head')) {
      const h = 0.5 + 0.5 * ss(neckTop - 0.005, neckTop + 0.025, p[1]);
      w.set(B.Head, h * rest); if (h < 1) w.set(B.Neck, (1 - h) * rest);
    } else if (rest > 0 && parts.has('neck') && !isTorso) {
      const h = 0.5 * ss(J.NECK[1], neckTop, p[1]), c = 1 - ss(J.NECK[1] - 0.03, J.NECK[1], p[1]);
      w.set(B.Head, h * rest); w.set(B.Chest, c * (1 - h) * rest); w.set(B.Neck, (1 - c) * (1 - h) * rest);
    } else if (rest > 0) put(chain(p, colPts, colBones, colBlend), rest);
    if (!w.size) w.set(isHeadP ? B.Head : isArmP ? B[`UpperArm_${armSide}`] : B.Hips, 1);

    const top = [...w.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 4);
    const sum = top.reduce((a, e) => a + e[1], 0) || 1;
    top.forEach(([b, x], j) => { skinIndex[i * 4 + j] = b; skinWeight[i * 4 + j] = x / sum; });
    // 漏れの確認
    for (const [b] of top) {
      const name = BONES_V1[b].name;
      if (/_(L|R)$/.test(name)) {
        const bs = name.endsWith('_L') ? 'L' : 'R';
        const otherSide = (bs === 'L' && p[0] < center - 0.03) || (bs === 'R' && p[0] > center + 0.03);
        if (otherSide && /Arm|Hand/.test(name)) leakArm++;
        if (otherSide && /Leg|Foot/.test(name)) leakLeg++;
        if (isHeadP && /Arm|Hand/.test(name)) armHead++;
      }
    }
  }
  return { skinIndex, skinWeight, leak: { armToOtherSide: leakArm, legToOtherSide: leakLeg, armToHead: armHead } };
}

// ------------------------------------------------------------------ 3. テストポーズ（Rig の確認用。アニメーションではない）
export type PresetId = 'T' | 'A' | 'ARM_UP' | 'ELBOW' | 'WALK' | 'SQUAT';
/** ボーン名 → [x,y,z]（度）。T ポーズからの回転 */
export const PRESETS: Record<PresetId, { label: string; rot: Record<string, [number, number, number]>; hipsDrop?: number }> = {
  T: { label: 'T', rot: {} },
  A: { label: 'A', rot: { UpperArm_L: [0, 0, -45], UpperArm_R: [0, 0, 45] } },
  ARM_UP: { label: 'ARM UP', rot: { UpperArm_L: [0, 0, 75], UpperArm_R: [0, 0, -75] } },
  ELBOW: { label: 'ELBOW', rot: { UpperArm_L: [0, 0, -20], UpperArm_R: [0, 0, 20], LowerArm_L: [0, -90, 0], LowerArm_R: [0, 90, 0] } },
  WALK: {
    label: 'WALK', rot: {
      UpperLeg_L: [-30, 0, 0], LowerLeg_L: [10, 0, 0], Foot_L: [-10, 0, 0],
      UpperLeg_R: [22, 0, 0], LowerLeg_R: [38, 0, 0], Foot_R: [5, 0, 0],
      UpperArm_L: [25, 0, -70], LowerArm_L: [0, -15, 0], UpperArm_R: [-25, 0, 70], LowerArm_R: [0, 15, 0],
      Spine: [0, 6, 0], Head: [0, -4, 0],
    },
  },
  SQUAT: {
    label: 'SQUAT', hipsDrop: 0.75, rot: {
      UpperLeg_L: [-85, 0, -8], UpperLeg_R: [-85, 0, 8], LowerLeg_L: [95, 0, 0], LowerLeg_R: [95, 0, 0], Foot_L: [-10, 0, 0], Foot_R: [-10, 0, 0],
      Spine: [20, 0, 0], UpperArm_L: [-60, 0, -40], UpperArm_R: [-60, 0, 40],
    },
  },
};

// ------------------------------------------------------------------ 4. 保存
export interface RigJSON {
  format: typeof RIG_VERSION; baseMesh: typeof BASE_MESH_VERSION; savedAt: string;
  joints: Record<JointId, V3>;
  bones: { name: string; joint: JointId; parent: string | null }[];
  rotations: Record<string, [number, number, number]>;
  hipsDrop: number;
  /** 形の頂点の位置（Phase 3 の結果。V1 と同じ並び） */
  shape: number[];
  skin: { index: number[]; weight: number[] } | null;
  symmetric: boolean; center: number;
}
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
export function toRigJSON(o: { joints: Joints3; rotations: Record<string, [number, number, number]>; hipsDrop: number; shape: Float32Array; skin: RigWeights | null; symmetric: boolean; center: number }): RigJSON {
  return {
    format: RIG_VERSION, baseMesh: BASE_MESH_VERSION, savedAt: new Date().toISOString(),
    joints: Object.fromEntries(JOINT_ORDER.map(k => [k, o.joints[k].map(r4)])) as Record<JointId, V3>,
    bones: BONES_V1.map(b => ({ name: b.name, joint: b.joint, parent: b.parent >= 0 ? BONES_V1[b.parent].name : null })),
    rotations: o.rotations, hipsDrop: o.hipsDrop,
    shape: Array.from(o.shape, r4),
    skin: o.skin ? { index: Array.from(o.skin.skinIndex), weight: Array.from(o.skin.skinWeight, r4) } : null,
    symmetric: o.symmetric, center: r4(o.center),
  };
}
