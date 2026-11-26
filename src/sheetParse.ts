// Element 118 Sheet V1 の読み込み・解析（Phase 1）
//
// 固定ピクセル座標には頼らない。
//   1. シート全体の前景（透過PNGならアルファ）を取り出す
//   2. 細い線（文字・ガイド線・枠・寸法線）を「オープニング」で消し、残った塊を領域として検出
//   3. 塊の形と並びから FRONT / RIGHT / BACK / LEFT / TOP / PARTS（SHEET 2 は JOINT FRONT / RIGHT）を判定
//   4. 各ビューを「足底・頭頂・中心軸」で正規化（身長 = 1）
// 関節の正式な入力元は SHEET 2 だけ（SHEET 1 は形・シルエット・色・パーツ専用）。
import { estimate, type CharParams } from './character';
import type { SourceImage } from './mask';
import { ALL_JOINTS, MARKER_DIAMETER, MARKERS, PARTS_SLOTS, PART_IDS_ALL, type JointId } from './sheetSpec';

export type ViewId = 'front' | 'right' | 'back' | 'left' | 'top';
export type PartId = (typeof PART_IDS_ALL)[number];
export interface Box { x0: number; y0: number; x1: number; y1: number }
/** 検出したビュー。src は体の範囲（足底〜頭頂）で切り抜いたもの。box はシート上の位置（デバッグ表示用） */
export interface View { id: string; src: SourceImage; box: Box; raw: HTMLCanvasElement }

export interface Sheet1 { views: Partial<Record<ViewId, View>>; parts: Partial<Record<PartId, View>>; warnings: string[]; regions: { label: string; box: Box }[] }

export interface Joint { x: number; y: number; z: number; source: 'marker' | 'estimate' | 'manual'; zSource: 'marker' | 'estimate' | 'manual' }
export type Joints = Record<JointId, Joint>;
export interface Sheet2 { front?: View; right?: View; joints: Partial<Joints>; found: number; warnings: string[]; regions: { label: string; box: Box }[] }

// ------------------------------------------------------------------ 前景と領域
interface Fg { mask: Uint8Array; w: number; h: number; hadAlpha: boolean; data: Uint8ClampedArray }

function foreground(sheet: HTMLCanvasElement): Fg {
  const w = sheet.width, h = sheet.height;
  const data = sheet.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
  const n = w * h;
  let transparent = 0;
  for (let i = 0; i < n; i++) if (data[i * 4 + 3] < 250) transparent++;
  const hadAlpha = transparent > n * 0.05;
  const mask = new Uint8Array(n);
  if (hadAlpha) {
    // 透過PNG：アルファを最優先
    for (let i = 0; i < n; i++) mask[i] = data[i * 4 + 3] >= 100 ? 1 : 0;
  } else {
    // 不透明：外周の色（背景）との差。外周とつながった背景だけを背景にする
    const rs: number[] = [], gs: number[] = [], bs: number[] = [];
    const push = (i: number) => { rs.push(data[i * 4]); gs.push(data[i * 4 + 1]); bs.push(data[i * 4 + 2]); };
    for (let x = 0; x < w; x += 2) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y += 2) { push(y * w); push(y * w + w - 1); }
    const med = (a: number[]) => a.sort((p, q) => p - q)[a.length >> 1];
    const br = med(rs), bg = med(gs), bb = med(bs);
    const isBg = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const dr = data[i * 4] - br, dg = data[i * 4 + 1] - bg, db = data[i * 4 + 2] - bb;
      isBg[i] = dr * dr + dg * dg + db * db <= 40 * 40 ? 1 : 0;
    }
    const seen = new Uint8Array(n);
    const st: number[] = [];
    const seed = (i: number) => { if (isBg[i] && !seen[i]) { seen[i] = 1; st.push(i); } };
    for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
    while (st.length) {
      const i = st.pop()!, x = i % w, y = (i / w) | 0;
      if (x > 0) seed(i - 1); if (x < w - 1) seed(i + 1); if (y > 0) seed(i - w); if (y < h - 1) seed(i + w);
    }
    for (let i = 0; i < n; i++) mask[i] = seen[i] ? 0 : 1;
  }
  return { mask, w, h, hadAlpha, data };
}

/** 正方形の最小/最大フィルタ（分離可能）で収縮・膨張 */
function morph(m: Uint8Array, w: number, h: number, r: number, grow: boolean): Uint8Array {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  const want = grow ? 1 : 0; // 膨張：近くに1があれば1 / 収縮：近くに0があれば0
  const dist = new Int32Array(Math.max(w, h));
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let last = -1e9;
    for (let x = 0; x < w; x++) { if (m[row + x] === want) last = x; dist[x] = x - last; }
    last = 1e9;
    for (let x = w - 1; x >= 0; x--) { if (m[row + x] === want) last = x; tmp[row + x] = Math.min(dist[x], last - x) <= r ? want : 1 - want; }
  }
  for (let x = 0; x < w; x++) {
    let last = -1e9;
    for (let y = 0; y < h; y++) { if (tmp[y * w + x] === want) last = y; dist[y] = y - last; }
    last = 1e9;
    for (let y = h - 1; y >= 0; y--) { if (tmp[y * w + x] === want) last = y; out[y * w + x] = Math.min(dist[y], last - y) <= r ? want : 1 - want; }
  }
  return out;
}

interface Comp { id: number; area: number; box: Box }
function components(m: Uint8Array, w: number, h: number): { label: Int32Array; comps: Comp[] } {
  const label = new Int32Array(w * h).fill(-1);
  const comps: Comp[] = [];
  const st: number[] = [];
  for (let i = 0; i < m.length; i++) {
    if (!m[i] || label[i] >= 0) continue;
    const c: Comp = { id: comps.length, area: 0, box: { x0: w, y0: h, x1: 0, y1: 0 } };
    label[i] = c.id; st.push(i);
    while (st.length) {
      const j = st.pop()!, x = j % w, y = (j / w) | 0;
      c.area++;
      if (x < c.box.x0) c.box.x0 = x; if (x > c.box.x1) c.box.x1 = x; if (y < c.box.y0) c.box.y0 = y; if (y > c.box.y1) c.box.y1 = y;
      if (x > 0 && m[j - 1] && label[j - 1] < 0) { label[j - 1] = c.id; st.push(j - 1); }
      if (x < w - 1 && m[j + 1] && label[j + 1] < 0) { label[j + 1] = c.id; st.push(j + 1); }
      if (y > 0 && m[j - w] && label[j - w] < 0) { label[j - w] = c.id; st.push(j - w); }
      if (y < h - 1 && m[j + w] && label[j + w] < 0) { label[j + w] = c.id; st.push(j + w); }
    }
    comps.push(c);
  }
  return { label, comps };
}

const bw = (b: Box) => b.x1 - b.x0 + 1, bh = (b: Box) => b.y1 - b.y0 + 1;
const cxOf = (b: Box) => (b.x0 + b.x1) / 2, cyOf = (b: Box) => (b.y0 + b.y1) / 2;
const union = (a: Box, b: Box): Box => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
const inside = (b: Box, outer: Box, pad: number) => cxOf(b) >= outer.x0 - pad && cxOf(b) <= outer.x1 + pad && cyOf(b) >= outer.y0 - pad && cyOf(b) <= outer.y1 + pad;

/** 文字・線を除いた「絵の塊」。大きさ・塗りの密度で枠や文字を除外 */
interface Blob { comps: Comp[]; box: Box; area: number }
/** セルの枠（細い線で描かれた長方形）を探す。中がほぼ空で、塗りの密度が低い大きめの塊 */
function detectFrames(fg: Fg): Box[] {
  const { w, h, mask } = fg;
  const { comps } = components(mask, w, h);
  const minSide = Math.min(w, h) * 0.05;
  return comps.filter(c => bw(c.box) > minSide && bh(c.box) > minSide && c.area / (bw(c.box) * bh(c.box)) < 0.12
    && c.area > (bw(c.box) + bh(c.box)) * 1.5).map(c => c.box);
}

function detectBlobs(fg: Fg): { blobs: Blob[]; openedLabel: Int32Array } {
  const { w, h, mask } = fg;
  const r = Math.max(2, Math.round(Math.min(w, h) * 0.004)); // これより細い線（文字・枠・ガイド線）は消える
  const opened = morph(morph(mask, w, h, r, false), w, h, r, true);
  const { label, comps } = components(opened, w, h);
  const minArea = w * h * 0.0012;
  const good = comps.filter(c => c.area >= minArea && c.area / (bw(c.box) * bh(c.box)) >= 0.1);
  // 近い塊（離れて描かれた手先・髪の毛先など）は、大きい塊の範囲内ならまとめる
  good.sort((a, b) => b.area - a.area);
  const blobs: Blob[] = [];
  for (const c of good) {
    const host = blobs.find(b => inside(c.box, b.box, Math.max(bw(b.box), bh(b.box)) * 0.03) && c.area < b.area * 0.5);
    if (host) { host.comps.push(c); host.box = union(host.box, c.box); host.area += c.area; }
    else blobs.push({ comps: [c], box: { ...c.box }, area: c.area });
  }
  return { blobs, openedLabel: label };
}

/** 塊の範囲を元画像から切り出してビューにする。マスクは元の前景のうち、塊につながる部分だけ（文字や枠は入らない） */
function makeView(id: string, sheet: HTMLCanvasElement, fg: Fg, blob: Blob, openedLabel: Int32Array): View {
  const { w, mask } = fg;
  const pad = Math.round(Math.max(bw(blob.box), bh(blob.box)) * 0.02);
  const b0: Box = { x0: Math.max(0, blob.box.x0 - pad), y0: Math.max(0, blob.box.y0 - pad), x1: Math.min(fg.w - 1, blob.box.x1 + pad), y1: Math.min(fg.h - 1, blob.box.y1 + pad) };
  const ids = new Set(blob.comps.map(c => c.id));
  const cw = bw(b0), ch = bh(b0);
  // 元の前景を領域内で連結成分に分け、オープニング後の塊に触れている成分だけ残す
  const local = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) local[y * cw + x] = mask[(y + b0.y0) * w + x + b0.x0];
  const { label, comps } = components(local, cw, ch);
  const keep = new Uint8Array(comps.length);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const l = label[y * cw + x];
    if (l >= 0 && !keep[l] && ids.has(openedLabel[(y + b0.y0) * w + x + b0.x0])) keep[l] = 1;
  }
  let x0 = cw, y0 = ch, x1 = -1, y1 = -1;
  for (let i = 0; i < local.length; i++) {
    const l = label[i];
    local[i] = l >= 0 && keep[l] ? 1 : 0;
    if (local[i]) { const x = i % cw, y = (i / cw) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) { x0 = 0; y0 = 0; x1 = cw - 1; y1 = ch - 1; }
  // 元画像（領域そのまま）：デバッグ表示用
  const raw = document.createElement('canvas');
  raw.width = cw; raw.height = ch;
  raw.getContext('2d')!.drawImage(sheet, b0.x0, b0.y0, cw, ch, 0, 0, cw, ch);
  // 足底＝下端、頭頂＝上端、中心軸＝左右中央で切り抜き（＝正規化の基準）
  const fw = x1 - x0 + 1, fh = y1 - y0 + 1;
  const canvas = document.createElement('canvas');
  canvas.width = fw; canvas.height = fh;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(sheet, b0.x0 + x0, b0.y0 + y0, fw, fh, 0, 0, fw, fh);
  const m = new Uint8Array(fw * fh);
  for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) m[y * fw + x] = local[(y + y0) * cw + x + x0];
  // シルエット外（背景・文字・枠）は透明にしておく（重ね合わせ表示・色の取得で混ざらないように）
  const img = ctx.getImageData(0, 0, fw, fh);
  for (let i = 0; i < fw * fh; i++) if (!m[i]) img.data[i * 4 + 3] = 0;
  ctx.putImageData(img, 0, 0);
  return { id, src: { canvas, mask: m, w: fw, h: fh, hadAlpha: fg.hadAlpha, pieces: 1 }, box: { x0: b0.x0 + x0, y0: b0.y0 + y0, x1: b0.x0 + x1, y1: b0.y0 + y1 }, raw };
}

// ------------------------------------------------------------------ SHEET 1
export function parseSheet1(sheet: HTMLCanvasElement): Sheet1 {
  const warnings: string[] = [];
  const fg = foreground(sheet);
  const { blobs, openedLabel } = detectBlobs(fg);
  const views: Sheet1['views'] = {};
  const parts: Sheet1['parts'] = {};
  const regions: Sheet1['regions'] = [];
  if (!blobs.length) return { views, parts, warnings: ['絵が見つかりません'], regions };

  // 全身ビュー：背の高い塊のうち、同じ段（足元の高さが近い）に並んでいるもの
  const maxH = Math.max(...blobs.map(b => bh(b.box)));
  const tall = blobs.filter(b => bh(b.box) >= maxH * 0.6);
  const rowY = [...tall].map(b => b.box.y1).sort((a, b) => a - b)[Math.floor(tall.length / 2)];
  let row = tall.filter(b => Math.abs(b.box.y1 - rowY) < maxH * 0.35).sort((a, b) => a.box.x0 - b.box.x0);
  if (row.length > 4) row = [...row].sort((a, b) => b.area - a.area).slice(0, 4).sort((a, b) => a.box.x0 - b.box.x0);
  const order: ViewId[] = ['front', 'right', 'back', 'left'];
  if (row.length === 4) {
    // 並び順の確認：FRONT/BACK は腕が横に伸びて幅広、RIGHT/LEFT は細い
    const wide = row.map(b => bw(b.box) / bh(b.box));
    if (!(wide[0] > wide[1] && wide[2] > wide[1] && wide[2] > wide[3] && wide[0] > wide[3]))
      warnings.push('全身ビューの並び（幅広・細い・幅広・細い）が規格と違います。FRONT / RIGHT / BACK / LEFT の順番を確認してください');
  } else {
    warnings.push(`全身ビューが ${row.length} 個しか見つかりません（4個必要：FRONT / RIGHT / BACK / LEFT）`);
  }
  row.slice(0, 4).forEach((b, i) => {
    views[order[i]] = makeView(order[i], sheet, fg, b, openedLabel);
    regions.push({ label: order[i].toUpperCase(), box: views[order[i]]!.box });
  });

  // 下段：TOP（FRONT と同じくらいの横幅の、いちばん左の塊）と PARTS
  const rowBottom = row.length ? Math.max(...row.map(b => b.box.y1)) : 0;
  const lower = blobs.filter(b => !row.includes(b) && cyOf(b.box) > rowBottom - maxH * 0.05);
  const fw = views.front ? bw(views.front.box) : maxH;
  const topCand = lower.filter(b => bw(b.box) > fw * 0.6 && bw(b.box) < fw * 1.6 && bh(b.box) < maxH * 0.6).sort((a, b) => a.box.x0 - b.box.x0)[0];
  if (topCand) {
    views.top = makeView('top', sheet, fg, topCand, openedLabel);
    regions.push({ label: 'TOP', box: views.top.box });
  } else warnings.push('TOP が見つかりません（FRONT と同じくらいの横幅の上面図）');

  // PARTS：
  //   ① 下段に PARTS のセル枠が規格の数（6）以上あれば、枠を左から順に HAIR, HAT, BACKPACK… とする
  //   ② 枠が足りなければ、TOP のセル枠（なければ TOP の絵）の右端〜シートの右端を6等分する
  //   どちらも誤る可能性があるので、解析後に画面でパーツIDを付け替えられる
  const partBlobs = lower.filter(b => b !== topCand);
  if (partBlobs.length) {
    const frames = detectFrames(fg).filter(f => cyOf(f) > rowBottom - maxH * 0.05);
    const topFrame = topCand ? frames.find(f => inside(topCand.box, f, 0)) : undefined;
    const partFrames = frames.filter(f => f !== topFrame && (!topCand || f.x0 >= cxOf(topCand.box))).sort((a, b) => a.x0 - b.x0);
    const useFrames = partFrames.length >= PARTS_SLOTS.length;
    const ax0 = topFrame ? topFrame.x1 : topCand ? topCand.box.x1 : fg.w * 0.25;
    const slotW = (fg.w - ax0) / PARTS_SLOTS.length;
    for (const b of partBlobs) {
      let k: number;
      if (useFrames) {
        const fi = partFrames.findIndex(f => inside(b.box, f, 0));
        if (fi < 0) continue;
        k = Math.min(PARTS_SLOTS.length - 1, fi);
      } else k = Math.min(PARTS_SLOTS.length - 1, Math.max(0, Math.floor((cxOf(b.box) - ax0) / slotW)));
      const id = PARTS_SLOTS[k] as PartId;
      if (parts[id]) continue; // 同じスロットに複数ある場合は大きい方（blobs は面積順）
      parts[id] = makeView(id, sheet, fg, b, openedLabel);
      regions.push({ label: 'PARTS:' + id.toUpperCase(), box: parts[id]!.box });
    }
  }

  // 身長のそろい具合（正規化で吸収するが、大きくずれていれば知らせる）
  const hs = order.filter(k => views[k]).map(k => views[k]!.src.h);
  if (hs.length >= 2) {
    const mx = Math.max(...hs), mn = Math.min(...hs);
    if ((mx - mn) / mx > 0.15) warnings.push(`ビューごとの身長が ${Math.round((mx - mn) / mx * 100)}% 違います（身長を1にそろえて解析します）`);
  }
  return { views, parts, warnings, regions };
}

// ------------------------------------------------------------------ 関節マーカー（色相＋予想位置＋形）
export const MARKER_HUE_TOL = 14; // 色相の許容（度）。マーカー色の色相は30度間隔
export const MARKER_MIN_CHROMA2 = 90; // 鮮やかさ（最大−最小）の下限
export const MARKER_MIN_VALUE = 110; // 明るさ（最大値）の下限

function hueOf(r: number, g: number, b: number): number {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn;
  if (c === 0) return 0;
  let h = mx === r ? ((g - b) / c) % 6 : mx === g ? (b - r) / c + 2 : (r - g) / c + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}
const MARKER_HUES = MARKERS.map(m => hueOf(m.rgb[0], m.rgb[1], m.rgb[2]));
/** 画素がどのマーカー色か（-1 = マーカーではない）。完全一致ではなく色相の近さ＋鮮やかさで判定 */
export function classifyMarker(r: number, g: number, b: number): number {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx - mn < MARKER_MIN_CHROMA2 || mx < MARKER_MIN_VALUE) return -1;
  const h = hueOf(r, g, b);
  let best = -1, bd = MARKER_HUE_TOL;
  MARKER_HUES.forEach((mh, k) => { const d = Math.min(Math.abs(h - mh), 360 - Math.abs(h - mh)); if (d <= bd) { bd = d; best = k; } });
  return best;
}

interface MBlob { key: string; n: number; sx: number; sy: number; box: Box }
function findMarkerBlobs(src: SourceImage): MBlob[] {
  const { w, h, canvas } = src;
  const d = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
  const lab = new Int8Array(w * h).fill(-1);
  for (let i = 0; i < w * h; i++) if (d[i * 4 + 3] >= 120) lab[i] = classifyMarker(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
  const seen = new Uint8Array(w * h);
  const out: MBlob[] = [];
  const st: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (lab[i] < 0 || seen[i]) continue;
    const k = lab[i];
    const b: MBlob = { key: MARKERS[k].key, n: 0, sx: 0, sy: 0, box: { x0: w, y0: h, x1: 0, y1: 0 } };
    seen[i] = 1; st.push(i);
    while (st.length) {
      const j = st.pop()!, x = j % w, y = (j / w) | 0;
      b.n++; b.sx += x; b.sy += y;
      if (x < b.box.x0) b.box.x0 = x; if (x > b.box.x1) b.box.x1 = x; if (y < b.box.y0) b.box.y0 = y; if (y > b.box.y1) b.box.y1 = y;
      for (const q of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, y > 0 ? j - w : -1, y < h - 1 ? j + w : -1]) if (q >= 0 && !seen[q] && lab[q] === k) { seen[q] = 1; st.push(q); }
    }
    out.push(b);
  }
  // 形の判定：ほぼ円（縦横比 0.5〜2、塗りの密度 45%以上）、大きさは規格（直径＝身長の3%）の 0.12〜6倍の面積
  const expect = Math.PI * (MARKER_DIAMETER * h / 2) ** 2;
  return out.filter(b => {
    const ar = bw(b.box) / bh(b.box), fill = b.n / (bw(b.box) * bh(b.box));
    return b.n >= expect * 0.12 && b.n <= expect * 6 && ar > 0.5 && ar < 2 && fill > 0.45;
  });
}

/** 正規化：u = (px − 中心軸) / 身長、v = (足底 − py) / 身長 */
const norm = (src: SourceImage, px: number, py: number) => ({ u: (px - src.w / 2) / src.h, v: (src.h - 1 - py) / src.h });
export const denorm = (src: SourceImage, u: number, v: number) => ({ px: u * src.h + src.w / 2, py: src.h - 1 - v * src.h });

function countMarkerPixels(fg: Fg, b: Box): number {
  let n = 0;
  for (let y = b.y0; y <= b.y1; y += 2) for (let x = b.x0; x <= b.x1; x += 2) {
    const i = (y * fg.w + x) * 4;
    if (fg.data[i + 3] >= 120 && classifyMarker(fg.data[i], fg.data[i + 1], fg.data[i + 2]) >= 0) n++;
  }
  return n;
}

// ------------------------------------------------------------------ SHEET 2
export function parseSheet2(sheet: HTMLCanvasElement): Sheet2 {
  const warnings: string[] = [];
  const regions: Sheet2['regions'] = [];
  const fg = foreground(sheet);
  const { blobs, openedLabel } = detectBlobs(fg);
  // マーカーを多く含む背の高い塊が JOINT MARKERS の図。幅広が FRONT、細い方が RIGHT
  const maxH = Math.max(0, ...blobs.map(b => bh(b.box)));
  const cands = blobs.filter(b => bh(b.box) >= maxH * 0.5).map(b => ({ b, m: countMarkerPixels(fg, b.box) })).filter(c => c.m > 0);
  const frontC = cands.filter(c => bw(c.b.box) / bh(c.b.box) > 0.6).sort((a, b) => b.m - a.m)[0];
  const rightC = cands.filter(c => c !== frontC && bw(c.b.box) / bh(c.b.box) <= 0.6).sort((a, b) => b.m - a.m)[0];
  const front = frontC ? makeView('jointFront', sheet, fg, frontC.b, openedLabel) : undefined;
  const right = rightC ? makeView('jointRight', sheet, fg, rightC.b, openedLabel) : undefined;
  if (front) regions.push({ label: 'JOINT FRONT', box: front.box }); else warnings.push('SHEET 2 で T-POSE / JOINT MARKERS FRONT（マーカー付きの正面図）が見つかりません');
  if (right) regions.push({ label: 'JOINT RIGHT', box: right.box }); else warnings.push('SHEET 2 で JOINT MARKERS RIGHT（マーカー付きの右側面図）が見つかりません。奥行きは0として扱います');

  const joints: Partial<Joints> = {};
  if (front) {
    const blobsF = findMarkerBlobs(front.src);
    for (const m of MARKERS) {
      const center = m.ids.length === 1;
      const cand = blobsF.filter(b => b.key === m.key).map(b => ({ ...norm(front.src, b.sx / b.n, b.sy / b.n), n: b.n }))
        // 解剖学的な予想範囲：高さ＋（中心線上の関節は中央付近、左右の関節は中心から離れた位置）
        .filter(c => c.v >= m.yRange[0] && c.v <= m.yRange[1] && (center ? Math.abs(c.u) < 0.12 : Math.abs(c.u) > 0.01))
        .sort((a, b) => b.n - a.n);
      if (center) {
        if (cand[0]) joints[m.ids[0]] = { x: cand[0].u, y: cand[0].v, z: 0, source: 'marker', zSource: 'estimate' };
      } else {
        // 画面の右（u > 0）がキャラの左 = _L
        const L = cand.filter(c => c.u > 0)[0], R = cand.filter(c => c.u < 0)[0];
        if (L) joints[m.ids[0]] = { x: L.u, y: L.v, z: 0, source: 'marker', zSource: 'estimate' };
        if (R) joints[m.ids[1]] = { x: R.u, y: R.v, z: 0, source: 'marker', zSource: 'estimate' };
      }
    }
  }
  if (right && front) {
    const blobsR = findMarkerBlobs(right.src);
    for (const m of MARKERS) {
      const cand = blobsR.filter(b => b.key === m.key).map(b => ({ ...norm(right.src, b.sx / b.n, b.sy / b.n), n: b.n }));
      for (const id of m.ids) {
        const j = joints[id];
        if (!j) continue;
        const best = [...cand].sort((a, b) => Math.abs(a.v - j.y) - Math.abs(b.v - j.y))[0];
        if (best && Math.abs(best.v - j.y) < 0.08) { j.z = best.u; j.zSource = 'marker'; }
      }
    }
    // 右側面図では腕は SHOULDER だけ描く規格：肘・手首の奥行きは肩から引き継ぐ
    for (const L of ['L', 'R'] as const) {
      const sh = joints[`SHOULDER_${L}`];
      if (!sh || sh.zSource !== 'marker') continue;
      for (const id of [`ELBOW_${L}`, `WRIST_${L}`] as JointId[]) { const j = joints[id]; if (j && j.zSource !== 'marker') { j.z = sh.z; j.zSource = 'marker'; } }
    }
  }
  const found = Object.keys(joints).length;
  const missing = ALL_JOINTS.filter(id => !joints[id]);
  if (front && missing.length) warnings.push(`マーカーが見つからない関節：${missing.join(', ')}（SHEET 2 のシルエットから推定。指で修正できます）`);
  return { front, right, joints, found, warnings, regions };
}

/** マーカーが無い関節を、SHEET 2 の正面シルエットから推定した体型で埋める（SHEET 1 からは探さない） */
export function fillMissingJoints(joints: Partial<Joints>, sheet2Front: SourceImage | undefined): Joints {
  let p: CharParams | null = null;
  if (sheet2Front) p = estimate({ src: sheet2Front, cx: Math.round(sheet2Front.w / 2), top: 0, bottom: sheet2Front.h - 1 });
  const P = p ?? { headH: 0.22, headW: 0.22, torsoLen: 0.33, legLen: 0.4, shoulderW: 0.3, armLen: 0.4, armThick: 0.07, legGap: 0.12, armAngle: 85 } as CharParams;
  const hipY = P.legLen, torsoTop = hipY + P.torsoLen;
  const sw = P.shoulderW / 2;
  const a = (P.armAngle * Math.PI) / 180;
  const ax = Math.sin(a), ay = -Math.cos(a);
  const sy = torsoTop - P.armThick * 0.6;
  const est: Record<JointId, [number, number]> = {
    HEAD: [0, 1 - P.headH / 2], NECK: [0, torsoTop + 0.01], CHEST: [0, hipY + P.torsoLen * 0.72], SPINE: [0, hipY + P.torsoLen * 0.4], HIPS: [0, hipY + 0.02],
    SHOULDER_L: [sw, sy], SHOULDER_R: [-sw, sy],
    ELBOW_L: [sw + ax * P.armLen * 0.48, sy + ay * P.armLen * 0.48], ELBOW_R: [-sw - ax * P.armLen * 0.48, sy + ay * P.armLen * 0.48],
    WRIST_L: [sw + ax * P.armLen * 0.9, sy + ay * P.armLen * 0.9], WRIST_R: [-sw - ax * P.armLen * 0.9, sy + ay * P.armLen * 0.9],
    HIP_L: [P.legGap / 2, hipY], HIP_R: [-P.legGap / 2, hipY],
    KNEE_L: [P.legGap / 2, hipY * 0.5], KNEE_R: [-P.legGap / 2, hipY * 0.5],
    ANKLE_L: [P.legGap / 2, 0.05], ANKLE_R: [-P.legGap / 2, 0.05],
  };
  const out = {} as Joints;
  for (const id of ALL_JOINTS) out[id] = joints[id] ? { ...joints[id]! } : { x: est[id][0], y: est[id][1], z: 0, source: 'estimate', zSource: 'estimate' };
  return out;
}
