// キャラクターモード（アイテム用の「ふくらませる／押し出す」とは完全に別の処理）
//
// 1. 画像から「1体だけ」の人物シルエットを取り出す（設定画に複数の絵があっても1体に限定）
// 2. シルエットの行ごとの幅から、頭・首・胴体・腕・脚の比率を推定
// 3. 頭＝Sphere、胴体・腰・足＝RoundedBox、首・腕・脚＝Capsule で人体パーツを組み、
//    関節で重ねて1体につながったモデルにする
// 4. 元画像は形にせず、正面から投影したテクスチャとして貼る
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
  headW: 0.2, headH: 0.2, headDepth: 0.85, neckLen: 0.03, shoulderW: 0.3, torsoW: 0.26, torsoLen: 0.3, bodyDepth: 0.55,
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
  const headW = clamp(headWpx / H, 0.1, 0.5);

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
    headW, headH, headDepth: 0.85, neckLen, shoulderW: Math.max(torsoW * 1.05, torsoW + armThick * 0.3), torsoW, torsoLen,
    bodyDepth: 0.55, armLen, armThick, armAngle, legLen, legThick, legGap,
  };
}

// ------------------------------------------------------------------ 組み立て
function capsuleBetween(a: THREE.Vector3, b: THREE.Vector3, r: number): THREE.BufferGeometry {
  const len = Math.max(a.distanceTo(b), 0.0001);
  const g = new THREE.CapsuleGeometry(r, len, 6, 14);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  g.applyQuaternion(q);
  const m = a.clone().add(b).multiplyScalar(0.5);
  g.translate(m.x, m.y, m.z);
  return g;
}

/**
 * 1体のキャラクター（Root Group 1個、子は名前付きのパーツ Mesh）を作る。
 * 座標は身長 1（足裏 y=0）。UV は元画像を正面から投影。
 */
export function buildCharacter(p: CharParams, fig: Figure, material: THREE.Material): THREE.Group {
  const parts: [string, THREE.BufferGeometry][] = [];
  const add = (name: string, g: THREE.BufferGeometry) => parts.push([name, g]);

  const legR = p.legThick / 2, armR = p.armThick / 2;
  const footH = Math.min(0.045, p.legLen * 0.12);
  const hipY = p.legLen;
  const torsoTop = hipY + p.torsoLen;
  const neckTop = torsoTop + p.neckLen;
  const torsoD = p.torsoW * p.bodyDepth;

  // 胴体（胸）と腰。腰は脚の付け根を覆う
  // 胸と腰は大きく重ねて、くびれ（段差）が出ないようにする
  const chestH = p.torsoLen * 0.7, waistH = p.torsoLen * 0.58;
  const chest = new RoundedBoxGeometry(p.shoulderW, chestH, torsoD, 4, Math.min(torsoD, p.shoulderW, chestH) * 0.45);
  chest.translate(0, torsoTop - chestH / 2, 0);
  add('torso', chest);
  const pelvisW = Math.max(p.torsoW, p.legGap + p.legThick, p.shoulderW * 0.92);
  const pelvis = new RoundedBoxGeometry(pelvisW, waistH, torsoD * 0.97, 4, Math.min(torsoD, pelvisW, waistH) * 0.38);
  pelvis.translate(0, hipY + waistH * 0.32, 0);
  add('pelvis', pelvis);

  // 首と頭
  const neckR = Math.min(p.headW, p.torsoW) * 0.22;
  add('neck', capsuleBetween(new THREE.Vector3(0, torsoTop - neckR, 0), new THREE.Vector3(0, neckTop + p.headH * 0.15, 0), neckR));
  const head = new THREE.SphereGeometry(0.5, 32, 24);
  head.scale(p.headW, p.headH, p.headW * p.headDepth);
  head.translate(0, neckTop + p.headH / 2, 0);
  add('head', head);

  // 腕（左右）。キャラの左 = 画面の右（+X）
  for (const [side, label] of [[1, 'left'], [-1, 'right']] as const) {
    const a = THREE.MathUtils.degToRad(p.armAngle);
    const dir = new THREE.Vector3(Math.sin(a) * side, -Math.cos(a), 0).normalize();
    const shoulder = new THREE.Vector3(side * (p.shoulderW / 2 - armR * 0.6), torsoTop - armR * 1.1, 0);
    const handR = armR * 1.25;
    const upper = p.armLen * 0.46, fore = p.armLen * 0.42;
    const elbow = shoulder.clone().addScaledVector(dir, upper);
    const wrist = elbow.clone().addScaledVector(dir, fore);
    add(`${label}_upper_arm`, capsuleBetween(shoulder, elbow, armR));
    add(`${label}_forearm`, capsuleBetween(elbow, wrist, armR * 0.9));
    const hand = new THREE.SphereGeometry(1, 16, 12);
    hand.scale(handR, handR * 1.15, handR * 0.8);
    const hc = wrist.clone().addScaledVector(dir, handR * 0.9);
    hand.translate(hc.x, hc.y, hc.z);
    add(`${label}_hand`, hand);
  }

  // 脚（左右）
  for (const [side, label] of [[1, 'left'], [-1, 'right']] as const) {
    const x = side * p.legGap / 2;
    const hipJ = new THREE.Vector3(x, hipY, 0);
    const ankle = new THREE.Vector3(x, footH + legR * 0.4, 0);
    const knee = hipJ.clone().lerp(ankle, 0.5);
    add(`${label}_thigh`, capsuleBetween(hipJ, knee, legR));
    add(`${label}_shin`, capsuleBetween(knee, ankle, legR * 0.88));
    const fw = p.legThick * 1.05, fl = p.legThick * 1.9;
    const foot = new RoundedBoxGeometry(fw, footH * 2, fl, 3, Math.min(fw, footH * 2, fl) * 0.45);
    foot.translate(x, footH, fl * 0.22);
    add(`${label}_foot`, foot);
  }

  // UV：元画像を正面から投影（画像の1ピクセル = 身長 1/H）
  const { w, h } = fig.src;
  const H = fig.bottom - fig.top + 1;
  const root = new THREE.Group();
  root.name = 'character';
  for (const [name, g] of parts) {
    const geo = g.index ? g : g;
    const pos = geo.attributes.position;
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i) * H + fig.cx, py = fig.bottom - pos.getY(i) * H;
      uv[i * 2] = clamp((px + 0.5) / w, 0, 1);
      uv[i * 2 + 1] = clamp(1 - (py + 0.5) / h, 0, 1);
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = name;
    root.add(mesh);
  }
  return root;
}
