// Element 118 Sheet V1 の読み込み・解析（Phase 1）
//   SHEET 1 → FRONT / RIGHT / BACK / LEFT / TOP のシルエット ＋ PARTS
//   SHEET 2 → 関節マーカー（色＋固定ID＋位置）→ 3D の関節座標
// シルエット座標は「身長 = 1、足底 y = 0、中心軸 x(z) = 0」に正規化して扱う。
import { estimate, type CharParams } from './character';
import { buildMask, type SourceImage } from './mask';
import {
  ALL_JOINTS, LABEL_BAND, MARKER_DIAMETER, MARKER_MIN_CHROMA, MARKER_TOLERANCE, MARKERS, PARTS_SLOTS, partsCells,
  SHEET1_CELLS, SHEET2_CELLS, type Cell, type JointId,
} from './sheetSpec';

export type ViewId = 'front' | 'right' | 'back' | 'left' | 'top';
export interface View { id: string; src: SourceImage } // src は体の範囲で切り抜いたもの（w×h）

export interface Sheet1 { views: Partial<Record<ViewId, View>>; parts: Partial<Record<(typeof PARTS_SLOTS)[number], View>>; warnings: string[] }

export interface Joint { x: number; y: number; z: number; source: 'marker' | 'estimate' | 'manual'; zSource: 'marker' | 'estimate' | 'manual' }
export type Joints = Record<JointId, Joint>;
export interface Sheet2 { front?: View; right?: View; joints: Partial<Joints>; found: number; warnings: string[] }

function cellCanvas(sheet: HTMLCanvasElement, c: Cell): HTMLCanvasElement {
  const W = sheet.width, H = sheet.height;
  const x0 = Math.round(c.x0 * W), x1 = Math.round(c.x1 * W);
  const y0 = Math.round((c.y0 + (c.y1 - c.y0) * LABEL_BAND) * H), y1 = Math.round(c.y1 * H);
  const out = document.createElement('canvas');
  out.width = Math.max(1, x1 - x0); out.height = Math.max(1, y1 - y0);
  out.getContext('2d')!.drawImage(sheet, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

function extract(sheet: HTMLCanvasElement, c: Cell, minFrac = 0.004): View | null {
  const cv = cellCanvas(sheet, c);
  const src = buildMask(cv, { tolerance: 40, alphaCut: 100 });
  if (!src) return null;
  let on = 0;
  for (let i = 0; i < src.mask.length; i++) on += src.mask[i];
  if (on < cv.width * cv.height * minFrac) return null; // ほぼ空のセル
  return { id: c.id, src };
}

export function parseSheet1(sheet: HTMLCanvasElement): Sheet1 {
  const warnings: string[] = [];
  const views: Sheet1['views'] = {};
  for (const c of SHEET1_CELLS) {
    const v = extract(sheet, c);
    if (v) views[c.id as ViewId] = v;
    else warnings.push(`SHEET 1 の ${c.label} が見つかりません`);
  }
  const aspect = sheet.width / sheet.height;
  if (Math.abs(aspect - 16 / 9) > 0.08) warnings.push(`SHEET 1 の縦横比が16:9ではありません（${aspect.toFixed(2)}）。配置がずれている可能性があります`);
  // 同一縮尺のチェック：FRONT / RIGHT / BACK / LEFT の身長（px）がそろっているか
  const hs = (['front', 'right', 'back', 'left'] as ViewId[]).filter(k => views[k]).map(k => views[k]!.src.h);
  if (hs.length >= 2) {
    const mx = Math.max(...hs), mn = Math.min(...hs);
    if ((mx - mn) / mx > 0.06) warnings.push(`ビューごとの身長が ${Math.round((mx - mn) / mx * 100)}% ずれています（同一縮尺でない可能性）`);
  }
  const parts: Sheet1['parts'] = {};
  for (const c of partsCells()) {
    const v = extract(sheet, c, 0.01);
    if (v) parts[c.id as (typeof PARTS_SLOTS)[number]] = v;
  }
  return { views, parts, warnings };
}

// ------------------------------------------------------------------ 関節マーカー
interface Blob { key: string; n: number; sx: number; sy: number }

/** 切り抜き画像の中からマーカー色の塊を探す（色距離の許容値＋彩度の下限） */
function findBlobs(src: SourceImage): Blob[] {
  const { w, h, canvas } = src;
  const d = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
  const lab = new Int8Array(w * h).fill(-1);
  const tol2 = MARKER_TOLERANCE * MARKER_TOLERANCE;
  for (let i = 0; i < w * h; i++) {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2], a = d[i * 4 + 3];
    if (a < 160) continue;
    if (Math.max(r, g, b) - Math.min(r, g, b) < MARKER_MIN_CHROMA) continue;
    let best = -1, bd = tol2;
    MARKERS.forEach((m, k) => {
      const dd = (r - m.rgb[0]) ** 2 + (g - m.rgb[1]) ** 2 + (b - m.rgb[2]) ** 2;
      if (dd <= bd) { bd = dd; best = k; }
    });
    lab[i] = best;
  }
  const seen = new Uint8Array(w * h);
  const blobs: Blob[] = [];
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (lab[i] < 0 || seen[i]) continue;
    const k = lab[i];
    const b: Blob = { key: MARKERS[k].key, n: 0, sx: 0, sy: 0 };
    seen[i] = 1; stack.push(i);
    while (stack.length) {
      const j = stack.pop()!;
      const x = j % w, y = (j / w) | 0;
      b.n++; b.sx += x; b.sy += y;
      for (const q of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, y > 0 ? j - w : -1, y < h - 1 ? j + w : -1]) {
        if (q >= 0 && !seen[q] && lab[q] === k) { seen[q] = 1; stack.push(q); }
      }
    }
    blobs.push(b);
  }
  // 小さすぎる塊（ノイズ）を除外：直径 3% の円の面積の 15% 未満
  const expect = Math.PI * (MARKER_DIAMETER * h / 2) ** 2;
  return blobs.filter(b => b.n >= expect * 0.15);
}

/** 正規化：x（z）= (px − 中心) / 身長、y = (足底 − py) / 身長 */
const norm = (src: SourceImage, px: number, py: number) => ({ u: (px - src.w / 2) / src.h, v: (src.h - 1 - py) / src.h });
export const denorm = (src: SourceImage, u: number, v: number) => ({ px: u * src.h + src.w / 2, py: src.h - 1 - v * src.h });

export function parseSheet2(sheet: HTMLCanvasElement): Sheet2 {
  const warnings: string[] = [];
  const front = extract(sheet, SHEET2_CELLS.find(c => c.id === 'jointFront')!) ?? undefined;
  const right = extract(sheet, SHEET2_CELLS.find(c => c.id === 'jointRight')!) ?? undefined;
  const joints: Partial<Joints> = {};
  if (!front) warnings.push('SHEET 2 の JOINT MARKERS FRONT が見つかりません');
  if (!right) warnings.push('SHEET 2 の JOINT MARKERS RIGHT が見つかりません（奥行きはシルエットから推定）');
  if (front) {
    const blobs = findBlobs(front.src);
    for (const m of MARKERS) {
      const cand = blobs.filter(b => b.key === m.key).map(b => ({ ...norm(front.src, b.sx / b.n, b.sy / b.n), n: b.n }))
        .filter(c => c.v >= m.yRange[0] && c.v <= m.yRange[1]).sort((a, b) => b.n - a.n);
      if (m.ids.length === 1) {
        if (cand[0]) joints[m.ids[0]] = { x: cand[0].u, y: cand[0].v, z: 0, source: 'marker', zSource: 'estimate' };
      } else {
        // 左右：画面の右（u が大きい方）がキャラの左 = _L
        const two = cand.slice(0, 2);
        const sorted = [...two].sort((a, b) => b.u - a.u);
        if (two.length === 2) {
          joints[m.ids[0]] = { x: sorted[0].u, y: sorted[0].v, z: 0, source: 'marker', zSource: 'estimate' };
          joints[m.ids[1]] = { x: sorted[1].u, y: sorted[1].v, z: 0, source: 'marker', zSource: 'estimate' };
        } else if (two.length === 1) {
          const id = two[0].u >= 0 ? m.ids[0] : m.ids[1];
          joints[id] = { x: two[0].u, y: two[0].v, z: 0, source: 'marker', zSource: 'estimate' };
        }
      }
    }
  }
  if (right && front) {
    const blobs = findBlobs(right.src);
    for (const m of MARKERS) {
      const cand = blobs.filter(b => b.key === m.key).map(b => ({ ...norm(right.src, b.sx / b.n, b.sy / b.n), n: b.n }))
        .filter(c => c.v >= m.yRange[0] - 0.05 && c.v <= m.yRange[1] + 0.05);
      for (const id of m.ids) {
        const j = joints[id];
        if (!j) continue;
        // 高さが最も近い塊を採用（右側面図では左右の対が重なって1個）
        const best = cand.sort((a, b) => Math.abs(a.v - j.y) - Math.abs(b.v - j.y))[0];
        if (best && Math.abs(best.v - j.y) < 0.08) { j.z = best.u; j.zSource = 'marker'; }
      }
    }
  }
  // T ポーズの右側面図では肩・肘・手首が重なるので SHOULDER だけ描く規格。肘・手首の奥行きは肩から引き継ぐ
  for (const L of ['L', 'R'] as const) {
    const sh = joints[`SHOULDER_${L}`];
    if (!sh || sh.zSource !== 'marker') continue;
    for (const id of [`ELBOW_${L}`, `WRIST_${L}`] as JointId[]) {
      const j = joints[id];
      if (j && j.zSource !== 'marker') { j.z = sh.z; j.zSource = 'marker'; }
    }
  }
  const found = Object.keys(joints).length;
  const missing = ALL_JOINTS.filter(id => !joints[id]);
  if (front && missing.length) warnings.push(`見つからない関節：${missing.join(', ')}（シルエットから推定。指で修正できます）`);
  return { front, right, joints, found, warnings };
}

/** マーカーが無い関節を、FRONT のシルエットから推定した体型で埋める */
export function fillMissingJoints(joints: Partial<Joints>, frontSil: SourceImage | undefined): Joints {
  let p: CharParams | null = null;
  if (frontSil) p = estimate({ src: frontSil, cx: Math.round(frontSil.w / 2), top: 0, bottom: frontSil.h - 1 });
  const P = p ?? { headH: 0.22, headW: 0.22, torsoLen: 0.33, legLen: 0.4, shoulderW: 0.3, armLen: 0.4, armThick: 0.07, legGap: 0.12, armAngle: 85 } as CharParams;
  const hipY = P.legLen, torsoTop = hipY + P.torsoLen;
  const sw = P.shoulderW / 2;
  const a = (P.armAngle * Math.PI) / 180;
  const ax = Math.sin(a), ay = -Math.cos(a);
  const est: Record<JointId, [number, number]> = {
    HEAD: [0, 1 - P.headH / 2], NECK: [0, torsoTop + 0.01], CHEST: [0, hipY + P.torsoLen * 0.72], SPINE: [0, hipY + P.torsoLen * 0.4], HIPS: [0, hipY + 0.02],
    SHOULDER_L: [sw, torsoTop - P.armThick * 0.6], SHOULDER_R: [-sw, torsoTop - P.armThick * 0.6],
    ELBOW_L: [sw + ax * P.armLen * 0.48, torsoTop - P.armThick * 0.6 + ay * P.armLen * 0.48],
    ELBOW_R: [-sw - ax * P.armLen * 0.48, torsoTop - P.armThick * 0.6 + ay * P.armLen * 0.48],
    WRIST_L: [sw + ax * P.armLen * 0.9, torsoTop - P.armThick * 0.6 + ay * P.armLen * 0.9],
    WRIST_R: [-sw - ax * P.armLen * 0.9, torsoTop - P.armThick * 0.6 + ay * P.armLen * 0.9],
    HIP_L: [P.legGap / 2, hipY], HIP_R: [-P.legGap / 2, hipY],
    KNEE_L: [P.legGap / 2, hipY * 0.5], KNEE_R: [-P.legGap / 2, hipY * 0.5],
    ANKLE_L: [P.legGap / 2, 0.05], ANKLE_R: [-P.legGap / 2, 0.05],
  };
  const out = {} as Joints;
  for (const id of ALL_JOINTS) out[id] = joints[id] ? { ...joints[id]! } : { x: est[id][0], y: est[id][1], z: 0, source: 'estimate', zSource: 'estimate' };
  return out;
}
