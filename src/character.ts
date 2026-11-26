// キャラクターモード（アイテム用の「ふくらませる／押し出す」とは完全に別の処理）
//
// 1. 画像から「1体だけ」の人物シルエットを取り出す（設定画に複数の絵があっても1体に限定）
// 2. シルエットの行ごとの幅から、頭・首・胴体・腕・脚の比率を推定
// 3. 頭＝Sphere、胴体・腰・足＝RoundedBox、首・腕・脚＝Capsule で人体パーツを組み、
//    関節で重ねて1体につながったモデルにする
// 4. 元画像は形にもUVにも使わない。体の部分ごとに代表色を取り出してマテリアルにする（顔だけ頭の前面に限定して貼る）
// ※ AI による推定ではなく「画像解析＋プロシージャル生成」
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { SourceImage } from './mask';

/** すべて「キャラの身長 = 1」に対する比率 */
export interface CharParams {
  headW: number; // 頭の幅
  headH: number; // 頭の高さ
  headDepth: number; // 頭の奥行き（頭幅に対する比）
  neckLen: number;
  shoulderW: number; // 肩幅
  torsoW: number; // 胴体の幅
  torsoLen: number; // 胴体の長さ
  bodyDepth: number; // 胴体の奥行き（胴体幅に対する比）
  armLen: number; // 腕の長さ
  armThick: number; // 腕の太さ（直径）
  armAngle: number; // 腕の角度（0 = 真下、90 = 真横のTポーズ）
  legLen: number; // 脚の長さ（股〜足裏）
  legThick: number; // 脚の太さ（直径）
  legGap: number; // 左右の脚の中心の間隔
}

export interface Figure {
  src: SourceImage; // 1体だけに切り抜いた画像とマスク
  cx: number; // 体の中心の x（ピクセル）
  top: number; // 頭のてっぺんの y（ピクセル）
  bottom: number; // 足の裏の y（ピクセル）
}

// ------------------------------------------------------------------ 1体だけ取り出す
export function isolateFigure(src: SourceImage): Figure {
  const { w, h, mask } = src;
  const label = new Int32Array(w * h).fill(-1);
  const boxes: { size: number; x0: number; y0: number; x1: number; y1: number }[] = [];
  const stack: number[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || label[i] >= 0) continue;
    const id = boxes.length;
    const b = { size: 0, x0: w, y0: h, x1: 0, y1: 0 };
    label[i] = id; stack.push(i);
    while (stack.length) {
      const j = stack.pop()!;
      const x = j % w, y = (j / w) | 0;
      b.size++;
      if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x; if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y;
      if (x > 0 && mask[j - 1] && label[j - 1] < 0) { label[j - 1] = id; stack.push(j - 1); }
      if (x < w - 1 && mask[j + 1] && label[j + 1] < 0) { label[j + 1] = id; stack.push(j + 1); }
      if (y > 0 && mask[j - w] && label[j - w] < 0) { label[j - w] = id; stack.push(j - w); }
      if (y < h - 1 && mask[j + w] && label[j + w] < 0) { label[j + w] = id; stack.push(j + w); }
    }
    boxes.push(b);
  }
  // 全身像を選ぶ：いちばん背の高い島（同じくらいなら左＝正面図が多い）。顔のアップの四角い枠は除外
  const maxSize = Math.max(...boxes.map(b => b.size));
  const cands = boxes.map((b, id) => ({ ...b, id, bh: b.y1 - b.y0 + 1, bw: b.x1 - b.x0 + 1 }))
    .filter(b => b.size >= maxSize * 0.05)
    .filter(b => b.size < b.bw * b.bh * 0.85); // ほぼ長方形に塗りつぶされた島（枠付きの絵）は人物ではない
  const pool = cands.length ? cands : boxes.map((b, id) => ({ ...b, id, bh: b.y1 - b.y0 + 1, bw: b.x1 - b.x0 + 1 }));
  const tallest = Math.max(...pool.map(b => b.bh));
  const main = pool.filter(b => b.bh >= tallest * 0.9).sort((a, b) => a.x0 - b.x0)[0];
  // 離れて写った手先・足先など（主な島の範囲の中にある小さな島）は同じ1体に含める
  const pad = Math.round(Math.max(main.bw, main.bh) * 0.03);
  const keep = new Set<number>([main.id]);
  boxes.forEach((b, id) => {
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    if (cx >= main.x0 - pad && cx <= main.x1 + pad && cy >= main.y0 - pad && cy <= main.y1 + pad && b.size < main.size * 0.3) keep.add(id);
  });
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] && keep.has(label[i])) {
    const x = i % w, y = (i / w) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const fw = x1 - x0 + 1, fh = y1 - y0 + 1;
  const canvas = document.createElement('canvas');
  canvas.width = fw; canvas.height = fh;
  canvas.getContext('2d')!.drawImage(src.canvas, x0, y0, fw, fh, 0, 0, fw, fh);
  const m = new Uint8Array(fw * fh);
  for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) {
    const i = (y + y0) * w + x + x0;
    m[y * fw + x] = mask[i] && keep.has(label[i]) ? 1 : 0;
  }
  const fig: SourceImage = { canvas, mask: m, w: fw, h: fh, hadAlpha: src.hadAlpha, pieces: 1 };
  // 体の中心：上半身の各列の塗りの量が最大の列
  const col = new Float32Array(fw);
  for (let y = 0; y < Math.round(fh * 0.6); y++) for (let x = 0; x < fw; x++) col[x] += m[y * fw + x];
  // 最大値に近い列が続く帯の「真ん中」を中心にする（帯の端だと脚の上に乗ってしまう）
  let bv = 0;
  for (let x = Math.round(fw * 0.25); x < Math.round(fw * 0.75); x++) bv = Math.max(bv, col[x]);
  let sum = 0, cnt = 0;
  for (let x = Math.round(fw * 0.25); x < Math.round(fw * 0.75); x++) if (col[x] >= bv * 0.97) { sum += x; cnt++; }
  const best = cnt ? Math.round(sum / cnt) : Math.round(fw / 2);
  return { src: fig, cx: best, top: 0, bottom: fh - 1 };
}

// ------------------------------------------------------------------ 比率の推定
export const DEFAULT_PARAMS: CharParams = {
  headW: 0.2, headH: 0.2, headDepth: 0.92, neckLen: 0.03, shoulderW: 0.3, torsoW: 0.26, torsoLen: 0.3, bodyDepth: 0.55,
  armLen: 0.36, armThick: 0.07, armAngle: 12, legLen: 0.42, legThick: 0.09, legGap: 0.11,
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const median = (a: number[]) => (a.length ? [...a].sort((p, q) => p - q)[a.length >> 1] : 0);

export function estimate(fig: Figure): CharParams {
  const { w, h, mask } = fig.src;
  const H = fig.bottom - fig.top + 1;
  const cx = fig.cx;
  const runs = (y: number) => {
    const out: [number, number][] = [];
    let s = -1;
    for (let x = 0; x <= w; x++) {
      const on = x < w && mask[y * w + x] === 1;
      if (on && s < 0) s = x;
      if (!on && s >= 0) { out.push([s, x - 1]); s = -1; }
    }
    return out;
  };
  const rowRuns = Array.from({ length: h }, (_, y) => runs(y));
  const centerRun = (y: number) => {
    const r = rowRuns[y];
    if (!r.length) return 0;
    const hit = r.find(([a, b]) => a <= cx && cx <= b);
    if (hit) return hit[1] - hit[0] + 1;
    return 0;
  };
  const span = (y: number) => { const r = rowRuns[y]; return r.length ? r[r.length - 1][1] - r[0][0] + 1 : 0; };
  const Y = (f: number) => clamp(Math.round(fig.top + f * H), 0, h - 1);

  // 股：下から見て、中心列が空いていて左右に脚がある行が続く範囲のいちばん上
  let crotch = -1;
  for (let y = fig.bottom; y > Y(0.35); y--) {
    const r = rowRuns[y];
    const gap = !mask[y * w + cx] && r.some(([, b]) => b < cx) && r.some(([a]) => a > cx);
    if (gap) crotch = y; else if (crotch >= 0 && y < crotch - 2) break;
  }
  const legLen = crotch > 0 ? clamp((fig.bottom - crotch) / H, 0.15, 0.6) : DEFAULT_PARAMS.legLen;

  // 首：上部（10〜45%）で中心の塗り幅が最も細い行。頭幅はそれより上の最大幅
  let neck = Y(0.25), minW = Infinity;
  for (let y = Y(0.1); y <= Y(0.45); y++) { const cw = centerRun(y); if (cw > 0 && cw < minW) { minW = cw; neck = y; } }
  let headWpx = 0;
  for (let y = fig.top; y < neck; y++) headWpx = Math.max(headWpx, centerRun(y));
  const headH = clamp((neck - fig.top) / H, 0.12, 0.45);
  // 頭の幅はハネた髪などで広がりやすいので、高さの 0.8〜1.15 倍に収める（横長の巨大な楕円にしない）
  const headW = clamp(headWpx / H, headH * 0.8, headH * 1.15);

  // 腕：首〜股の間で左右に最も広がった幅。腕のない行の中心幅を胴体幅にする
  const hip = crotch > 0 ? crotch : Y(1 - legLen);
  let maxSpan = 0, armRow = neck;
  for (let y = neck; y < hip; y++) { const s = span(y); if (s > maxSpan) { maxSpan = s; armRow = y; } }
  const bodyRows: number[] = [];
  for (let y = neck + 2; y < hip; y++) { const s = span(y); if (s < maxSpan * 0.7) bodyRows.push(centerRun(y)); }
  let torsoWpx = median(bodyRows.filter(v => v > 0));
  if (!torsoWpx) torsoWpx = headWpx * 0.9;
  const torsoW = clamp(torsoWpx / H, 0.1, 0.5);
  const tpose = maxSpan > torsoWpx * 1.7;
  let armLen = DEFAULT_PARAMS.armLen, armThick = torsoW * 0.28, armAngle = 12;
  if (tpose) {
    armLen = clamp((maxSpan - torsoWpx) / 2 / H, 0.15, 0.6);
    // 腕の太さ：腕の中ほどの列で、腕の行の上下に続く塗りの高さ
    const ax = clamp(Math.round(cx + torsoWpx / 2 + (maxSpan - torsoWpx) / 4), 0, w - 1);
    let t = 0;
    for (let y = armRow; y >= 0 && mask[y * w + ax]; y--) t++;
    for (let y = armRow + 1; y < h && mask[y * w + ax]; y++) t++;
    if (t > 0) armThick = clamp(t / H, 0.03, 0.18);
    armAngle = 85;
  }
  // 脚の太さ・間隔
  const legW: number[] = [], legC: number[] = [];
  if (crotch > 0) for (let y = crotch + 2; y < fig.bottom - Math.round(H * 0.05); y++) {
    for (const [a, b] of rowRuns[y]) { legW.push(b - a + 1); legC.push(Math.abs((a + b) / 2 - cx)); }
  }
  const legThick = legW.length ? clamp(median(legW) / H, 0.04, 0.2) : torsoW * 0.36;
  const legGap = legC.length ? clamp(median(legC) * 2 / H, legThick * 0.8, torsoW) : torsoW * 0.45;

  const neckLen = 0.025;
  const torsoLen = clamp(1 - legLen - headH - neckLen, 0.12, 0.6);
  return {
    headW, headH, headDepth: 0.92, neckLen, shoulderW: Math.max(torsoW * 1.05, torsoW + armThick * 0.3), torsoW, torsoLen,
    bodyDepth: 0.55, armLen, armThick, armAngle, legLen, legThick, legGap,
  };
}

// ------------------------------------------------------------------ 色の解析
// 画像は形にもUVにも使わない。体の各部分の範囲から「代表色」を取り出してパーツのマテリアルにする。
export interface PartColors {
  hair: string; skin: string; torso: string; pelvis: string;
  upperArm: string; foreArm: string; hand: string; thigh: string; shin: string; foot: string;
}
export const COLOR_KEYS: (keyof PartColors)[] = ['hair', 'skin', 'torso', 'pelvis', 'upperArm', 'foreArm', 'hand', 'thigh', 'shin', 'foot'];

interface Geo { H: number; cx: number; neckY: number; hipY: number; headWpx: number; torsoWpx: number; armRowY: number }

function figGeo(fig: Figure, p: CharParams): Geo {
  const H = fig.bottom - fig.top + 1;
  const neckY = fig.top + p.headH * H;
  const hipY = fig.bottom - p.legLen * H;
  const armRowY = fig.top + (p.headH + p.neckLen) * H + p.armThick * H * 0.6;
  return { H, cx: fig.cx, neckY, hipY, headWpx: p.headW * H, torsoWpx: p.torsoW * H, armRowY };
}

/** 矩形範囲の中で、線画の黒い線を避けて最も多い色を返す（輪郭から2px以上内側だけを見る） */
function dominant(fig: Figure, x0: number, y0: number, x1: number, y1: number, fallback: string): string {
  const { w, h, mask, canvas } = fig.src;
  const X0 = Math.max(0, Math.floor(Math.min(x0, x1))), X1 = Math.min(w - 1, Math.ceil(Math.max(x0, x1)));
  const Y0 = Math.max(0, Math.floor(Math.min(y0, y1))), Y1 = Math.min(h - 1, Math.ceil(Math.max(y0, y1)));
  if (X1 <= X0 || Y1 <= Y0) return fallback;
  const data = getPixels(canvas);
  const buckets = new Map<number, { n: number; r: number; g: number; b: number; lum: number }>();
  const inner = (x: number, y: number) => x > 1 && y > 1 && x < w - 2 && y < h - 2 && mask[y * w + x] && mask[y * w + x - 2] && mask[y * w + x + 2] && mask[(y - 2) * w + x] && mask[(y + 2) * w + x];
  const step = Math.max(1, Math.floor(Math.sqrt(((X1 - X0) * (Y1 - Y0)) / 4000)));
  for (let y = Y0; y <= Y1; y += step) for (let x = X0; x <= X1; x += step) {
    if (!inner(x, y)) continue;
    const k = (y * w + x) * 4;
    const r = data[k], g = data[k + 1], b = data[k + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const e = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0, lum: (r * 0.299 + g * 0.587 + b * 0.114) / 255 };
    e.n++; e.r += r; e.g += g; e.b += b;
    buckets.set(key, e);
  }
  const list = [...buckets.values()].sort((a, b) => b.n - a.n);
  if (!list.length) return fallback;
  let pick = list[0];
  // いちばん多いのが線画の黒で、2番目もそれなりに多ければ2番目（塗りの色）を使う
  if (pick.lum < 0.13 && list[1] && list[1].n > pick.n * 0.3) pick = list[1];
  const hex = (v: number) => Math.round(v / pick.n).toString(16).padStart(2, '0');
  return `#${hex(pick.r)}${hex(pick.g)}${hex(pick.b)}`;
}

const pixelCache = new WeakMap<HTMLCanvasElement, Uint8ClampedArray>();
function getPixels(c: HTMLCanvasElement) {
  let d = pixelCache.get(c);
  if (!d) { d = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height).data; pixelCache.set(c, d); }
  return d;
}

export function analyzeColors(fig: Figure, p: CharParams): PartColors {
  const g = figGeo(fig, p);
  const { H, cx } = g;
  const headTop = fig.top, headH = g.neckY - headTop;
  const hw = g.headWpx / 2, tw = g.torsoWpx / 2;
  const hair = dominant(fig, cx - hw, headTop, cx + hw, headTop + headH * 0.3, '#d8d8e0');
  const skin = dominant(fig, cx - hw * 0.35, headTop + headH * 0.6, cx + hw * 0.35, headTop + headH * 0.9, '#f0d6c0');
  const torso = dominant(fig, cx - tw * 0.8, g.neckY + (g.hipY - g.neckY) * 0.15, cx + tw * 0.8, g.neckY + (g.hipY - g.neckY) * 0.7, '#a08060');
  const pelvis = dominant(fig, cx - tw * 0.8, g.hipY - H * 0.06, cx + tw * 0.8, g.hipY, torso);
  let upperArm = torso, foreArm = torso, hand = skin;
  const armLenPx = p.armLen * H, ath = Math.max(p.armThick * H * 0.35, 2);
  if (p.armAngle > 45) { // Tポーズ：腕は体の横に水平
    const s = cx + tw; // 右側（画面右）の腕を見る
    upperArm = dominant(fig, s + armLenPx * 0.08, g.armRowY - ath, s + armLenPx * 0.42, g.armRowY + ath, torso);
    foreArm = dominant(fig, s + armLenPx * 0.52, g.armRowY - ath, s + armLenPx * 0.85, g.armRowY + ath, upperArm);
    hand = dominant(fig, s + armLenPx * 0.9, g.armRowY - ath * 1.4, s + armLenPx * 1.08, g.armRowY + ath * 1.4, skin);
  } else { // 腕を下ろしている：胴体の外側の帯を見る
    const ax = cx + tw + ath * 0.8;
    const y0 = g.neckY + H * 0.03;
    upperArm = dominant(fig, ax - ath, y0, ax + ath, y0 + armLenPx * 0.45, torso);
    foreArm = dominant(fig, ax - ath, y0 + armLenPx * 0.5, ax + ath, y0 + armLenPx * 0.85, upperArm);
    hand = dominant(fig, ax - ath * 1.3, y0 + armLenPx * 0.88, ax + ath * 1.3, y0 + armLenPx * 1.05, skin);
  }
  const legL = p.legLen * H, lx = cx + (p.legGap / 2) * H, lt = Math.max(p.legThick * H * 0.35, 2);
  const thigh = dominant(fig, lx - lt, g.hipY + legL * 0.05, lx + lt, g.hipY + legL * 0.45, pelvis);
  const shin = dominant(fig, lx - lt, g.hipY + legL * 0.5, lx + lt, g.hipY + legL * 0.85, thigh);
  const foot = dominant(fig, cx - tw, fig.bottom - H * 0.035, cx + tw, fig.bottom, shin);
  return { hair, skin, torso, pelvis, upperArm, foreArm, hand, thigh, shin, foot };
}

/**
 * 顔だけのテクスチャ。頭の正面の部分（顔まわり）だけを切り出し、縁を肌色・髪色へなじませる。
 * 頭の前面に貼る小さな曲面（face パーツ）だけに使い、頭全体や体には貼らない。
 */
export function makeFaceCanvas(fig: Figure, p: CharParams, colors: PartColors): HTMLCanvasElement {
  const g = figGeo(fig, p);
  const headH = g.neckY - fig.top;
  const x0 = g.cx - g.headWpx * FACE_HALF_W, x1 = g.cx + g.headWpx * FACE_HALF_W;
  const y0 = fig.top + headH * FACE_TOP, y1 = fig.top + headH * FACE_BOTTOM;
  const S = 256;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = colors.skin;
  ctx.fillRect(0, 0, S, S);
  ctx.drawImage(fig.src.canvas, x0, y0, x1 - x0, y1 - y0, 0, 0, S, S);
  // 縁のなじませ：左右・下は肌色へ、上は髪色へ
  const fade = (x: number, y: number, w: number, h: number, col: string, dir: 'l' | 'r' | 't' | 'b') => {
    const grad = dir === 'l' ? ctx.createLinearGradient(x, 0, x + w, 0) : dir === 'r' ? ctx.createLinearGradient(x + w, 0, x, 0)
      : dir === 't' ? ctx.createLinearGradient(0, y, 0, y + h) : ctx.createLinearGradient(0, y + h, 0, y);
    grad.addColorStop(0, col); grad.addColorStop(1, col + '00');
    ctx.fillStyle = grad; ctx.fillRect(x, y, w, h);
  };
  const f = S * 0.16;
  fade(0, 0, f, S, colors.skin, 'l');
  fade(S - f, 0, f, S, colors.skin, 'r');
  fade(0, S - f, S, f, colors.skin, 'b');
  fade(0, 0, S, f, colors.hair, 't');
  return c;
}
// 顔パーツが覆う範囲（頭の幅・高さに対する割合）。face パーツの曲面の範囲と対応させている
const FACE_HALF_W = 0.3, FACE_TOP = 0.15, FACE_BOTTOM = 0.9;

// ------------------------------------------------------------------ 組み立て
export type Quality = 'low' | 'standard' | 'high';
const SEG: Record<Quality, { sphere: [number, number]; cap: [number, number]; box: number }> = {
  low: { sphere: [20, 14], cap: [4, 10], box: 2 },
  standard: { sphere: [32, 22], cap: [6, 14], box: 4 },
  high: { sphere: [48, 32], cap: [10, 20], box: 6 },
};

function capsuleBetween(a: THREE.Vector3, b: THREE.Vector3, r: number, q: Quality): THREE.BufferGeometry {
  const len = Math.max(a.distanceTo(b), 0.0001);
  const g = new THREE.CapsuleGeometry(r, len, SEG[q].cap[0], SEG[q].cap[1]);
  const rot = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  g.applyQuaternion(rot);
  const m = a.clone().add(b).multiplyScalar(0.5);
  g.translate(m.x, m.y, m.z);
  return g;
}

export interface LookParams { metalness: number; roughness: number; opacity: number; wireframe: boolean }

/**
 * 1体のキャラクター（Root Group 1個、子は名前付きのパーツ Mesh）を作る。
 * 座標は身長 1（足裏 y=0）、正面 = +Z。各パーツは解析した色の単色マテリアル。
 * テクスチャは face パーツ（頭の前面の曲面）だけ。
 */
export function buildCharacter(p: CharParams, colors: PartColors, face: HTMLCanvasElement | null, look: LookParams, quality: Quality = 'standard'): THREE.Group {
  const q = quality, seg = SEG[q];
  const mats = new Map<string, THREE.MeshStandardMaterial>();
  const mat = (key: keyof PartColors) => {
    let m = mats.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color: colors[key], metalness: look.metalness, roughness: look.roughness, wireframe: look.wireframe });
      if (look.opacity < 0.999) { m.transparent = true; m.opacity = look.opacity; }
      m.name = key;
      mats.set(key, m);
    }
    return m;
  };
  const parts: [string, THREE.BufferGeometry, THREE.Material][] = [];
  const add = (name: string, g: THREE.BufferGeometry, m: THREE.Material) => parts.push([name, g, m]);

  const legR = p.legThick / 2, armR = p.armThick / 2;
  const footH = Math.min(0.045, p.legLen * 0.12);
  const hipY = p.legLen;
  const torsoTop = hipY + p.torsoLen;
  const neckTop = torsoTop + p.neckLen;
  const torsoD = p.torsoW * p.bodyDepth;

  // 胴体（胸）と腰。大きく重ねてくびれの段差を出さない
  const chestH = p.torsoLen * 0.7, waistH = p.torsoLen * 0.58;
  const chest = new RoundedBoxGeometry(p.shoulderW, chestH, torsoD, seg.box, Math.min(torsoD, p.shoulderW, chestH) * 0.45);
  chest.translate(0, torsoTop - chestH / 2, 0);
  add('chest', chest, mat('torso'));
  const pelvisW = Math.max(p.torsoW, p.legGap + p.legThick, p.shoulderW * 0.92);
  const pelvis = new RoundedBoxGeometry(pelvisW, waistH, torsoD * 0.97, seg.box, Math.min(torsoD, pelvisW, waistH) * 0.38);
  pelvis.translate(0, hipY + waistH * 0.32, 0);
  add('hips', pelvis, mat('pelvis'));

  // 首・頭（肌）・髪（頭の上と後ろを覆う）・顔（頭の前面だけ）
  const neckR = Math.min(p.headW, p.torsoW) * 0.2;
  add('neck', capsuleBetween(new THREE.Vector3(0, torsoTop - neckR, 0), new THREE.Vector3(0, neckTop + p.headH * 0.15, 0), neckR, q), mat('skin'));
  const hx = p.headW, hy = p.headH, hz = p.headW * p.headDepth;
  const hc = new THREE.Vector3(0, neckTop + p.headH / 2, 0);
  const head = new THREE.SphereGeometry(0.5, seg.sphere[0], seg.sphere[1]);
  head.scale(hx, hy, hz); head.translate(hc.x, hc.y, hc.z);
  add('head', head, mat('skin'));
  // 髪：上から目の高さあたりまで、後ろは首まで（後ろ側だけ thetaLength を長くするため2枚）
  const hairTop = new THREE.SphereGeometry(0.5, seg.sphere[0], Math.round(seg.sphere[1] * 0.6), 0, Math.PI * 2, 0, Math.PI * 0.42);
  hairTop.scale(hx * 1.05, hy * 1.05, hz * 1.05); hairTop.translate(hc.x, hc.y, hc.z);
  add('hair', hairTop, mat('hair'));
  const hairBack = new THREE.SphereGeometry(0.5, Math.round(seg.sphere[0] / 2), Math.round(seg.sphere[1] * 0.5), Math.PI * 1.1, Math.PI * 0.8, Math.PI * 0.35, Math.PI * 0.45);
  hairBack.scale(hx * 1.05, hy * 1.05, hz * 1.05); hairBack.translate(hc.x, hc.y, hc.z);
  add('hair_back', hairBack, mat('hair'));
  if (face) {
    // +Z（正面）を中心にした曲面。範囲は makeFaceCanvas の切り出し範囲に対応
    const phiHalf = Math.asin(Math.min(0.95, FACE_HALF_W * 2)), t0 = Math.acos(1 - FACE_TOP * 2), t1 = Math.acos(1 - FACE_BOTTOM * 2);
    const fg = new THREE.SphereGeometry(0.5, Math.round(seg.sphere[0] * 0.6), Math.round(seg.sphere[1] * 0.6), Math.PI / 2 - phiHalf, phiHalf * 2, t0, t1 - t0);
    fg.scale(hx * 1.065, hy * 1.065, hz * 1.065); fg.translate(hc.x, hc.y, hc.z);
    const tex = new THREE.CanvasTexture(face);
    tex.colorSpace = THREE.SRGBColorSpace;
    const fm = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8, metalness: 0, wireframe: look.wireframe });
    fm.name = 'face';
    add('face', fg, fm);
  }

  // 腕（左右）。キャラの左 = 画面の右（+X）。Tポーズは真横
  for (const [side, label] of [[1, 'L'], [-1, 'R']] as const) {
    const a = THREE.MathUtils.degToRad(p.armAngle);
    const dir = new THREE.Vector3(Math.sin(a) * side, -Math.cos(a), 0).normalize();
    const shoulder = new THREE.Vector3(side * (p.shoulderW / 2 - armR * 0.6), torsoTop - armR * 1.1, 0);
    const handR = armR * 1.25;
    const elbow = shoulder.clone().addScaledVector(dir, p.armLen * 0.46);
    const wrist = elbow.clone().addScaledVector(dir, p.armLen * 0.42);
    add(`upperArm_${label}`, capsuleBetween(shoulder, elbow, armR, q), mat('upperArm'));
    add(`lowerArm_${label}`, capsuleBetween(elbow, wrist, armR * 0.9, q), mat('foreArm'));
    const hand = new THREE.SphereGeometry(1, Math.round(seg.sphere[0] / 2), Math.round(seg.sphere[1] / 2));
    hand.scale(handR, handR * 1.15, handR * 0.8);
    const hp = wrist.clone().addScaledVector(dir, handR * 0.9);
    hand.translate(hp.x, hp.y, hp.z);
    add(`hand_${label}`, hand, mat('hand'));
  }

  // 脚（左右）
  for (const [side, label] of [[1, 'L'], [-1, 'R']] as const) {
    const x = side * p.legGap / 2;
    const hipJ = new THREE.Vector3(x, hipY, 0);
    const ankle = new THREE.Vector3(x, footH + legR * 0.4, 0);
    const knee = hipJ.clone().lerp(ankle, 0.5);
    add(`upperLeg_${label}`, capsuleBetween(hipJ, knee, legR, q), mat('thigh'));
    add(`lowerLeg_${label}`, capsuleBetween(knee, ankle, legR * 0.88, q), mat('shin'));
    const fw = p.legThick * 1.05, fl = p.legThick * 1.9;
    const foot = new RoundedBoxGeometry(fw, footH * 2, fl, Math.max(2, seg.box - 1), Math.min(fw, footH * 2, fl) * 0.45);
    foot.translate(x, footH, fl * 0.22);
    add(`foot_${label}`, foot, mat('foot'));
  }

  const root = new THREE.Group();
  root.name = 'character';
  for (const [name, g, m] of parts) {
    // UV は face 以外では使わない（GLB の互換性のため、各ジオメトリ標準の UV は残す）
    g.computeVertexNormals(); // スムーズシェーディング
    const mesh = new THREE.Mesh(g, m);
    mesh.name = name;
    root.add(mesh);
  }
  return root;
}
