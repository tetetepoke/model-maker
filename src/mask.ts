// STEP 1–2: 画像を読み込み、透明領域（なければ背景色の差）から「物体のマスク」を作る。
export interface SourceImage {
  canvas: HTMLCanvasElement; // 物体の範囲で切り抜いた画像（RGBA、元解像度の上限 1024px）
  mask: Uint8Array; // canvas と同じサイズ、1 = 物体
  w: number;
  h: number;
  hadAlpha: boolean;
}

export interface MaskOptions {
  tolerance: number; // 背景色との差（0–255）。透明PNGでは無視
  alphaCut: number; // 透明PNGでの不透明とみなす値（0–255）
}

const MAX_SIDE = 1024;

export async function loadImage(file: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/** 画像全体をキャンバスへ（長辺 1024px まで縮小） */
export function toCanvas(img: HTMLImageElement): HTMLCanvasElement {
  const s = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.naturalWidth * s));
  c.height = Math.max(1, Math.round(img.naturalHeight * s));
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

export function buildMask(full: HTMLCanvasElement, opt: MaskOptions): SourceImage | null {
  const { width: W, height: H } = full;
  const data = full.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, W, H).data;
  const n = W * H;
  let transparent = 0;
  for (let i = 0; i < n; i++) if (data[i * 4 + 3] < 250) transparent++;
  const hadAlpha = transparent > n * 0.01;
  const m = new Uint8Array(n);

  if (hadAlpha) {
    for (let i = 0; i < n; i++) m[i] = data[i * 4 + 3] >= opt.alphaCut ? 1 : 0;
  } else {
    // 外周のピクセルの中央値を背景色とみなす（白背景・単色背景の設定画向け）
    const rs: number[] = [], gs: number[] = [], bs: number[] = [];
    const push = (x: number, y: number) => { const k = (y * W + x) * 4; rs.push(data[k]); gs.push(data[k + 1]); bs.push(data[k + 2]); };
    for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); }
    for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y); }
    const med = (a: number[]) => a.sort((p, q) => p - q)[a.length >> 1];
    const br = med(rs), bg = med(gs), bb = med(bs);
    const t2 = opt.tolerance * opt.tolerance;
    for (let i = 0; i < n; i++) {
      const dr = data[i * 4] - br, dg = data[i * 4 + 1] - bg, db = data[i * 4 + 2] - bb;
      m[i] = dr * dr + dg * dg + db * db > t2 ? 1 : 0;
    }
    // 外周とつながった背景だけを背景にする（物体の中の白い部分を消さない）
    floodBackground(m, W, H);
  }
  removeSpecks(m, W, H);

  // 物体の範囲で切り抜き
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (m[y * W + x]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return null;
  const pad = 2;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d')!.drawImage(full, x0, y0, w, h, 0, 0, w, h);
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) mask[y * w + x] = m[(y + y0) * W + x + x0];
  return { canvas, mask, w, h, hadAlpha };
}

/** m: 1=前景候補。外周から連結した 0 だけを背景として残し、閉じた穴の中の 0 は前景にする */
function floodBackground(m: Uint8Array, W: number, H: number) {
  const bg = new Uint8Array(W * H);
  const stack: number[] = [];
  const seed = (i: number) => { if (!m[i] && !bg[i]) { bg[i] = 1; stack.push(i); } };
  for (let x = 0; x < W; x++) { seed(x); seed((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { seed(y * W); seed(y * W + W - 1); }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % W, y = (i / W) | 0;
    if (x > 0) seed(i - 1); if (x < W - 1) seed(i + 1);
    if (y > 0) seed(i - W); if (y < H - 1) seed(i + W);
  }
  for (let i = 0; i < m.length; i++) m[i] = bg[i] ? 0 : 1;
}

/** 小さなゴミ（全体の 0.2% 未満の島）を消す */
function removeSpecks(m: Uint8Array, W: number, H: number) {
  const label = new Int32Array(W * H).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let i = 0; i < m.length; i++) {
    if (!m[i] || label[i] >= 0) continue;
    const id = sizes.length;
    let size = 0;
    label[i] = id; stack.push(i);
    while (stack.length) {
      const j = stack.pop()!;
      size++;
      const x = j % W, y = (j / W) | 0;
      const nb = [x > 0 ? j - 1 : -1, x < W - 1 ? j + 1 : -1, y > 0 ? j - W : -1, y < H - 1 ? j + W : -1];
      for (const k of nb) if (k >= 0 && m[k] && label[k] < 0) { label[k] = id; stack.push(k); }
    }
    sizes.push(size);
  }
  const total = sizes.reduce((a, b) => a + b, 0);
  const keep = sizes.map(s => s >= total * 0.002);
  for (let i = 0; i < m.length; i++) if (m[i] && !keep[label[i]]) m[i] = 0;
}

/** 低解像度グリッドへ縮小（各セルの過半数が前景なら 1） */
export function downsample(src: SourceImage, longSide: number): { g: Uint8Array; gw: number; gh: number } {
  const s = longSide / Math.max(src.w, src.h);
  const gw = Math.max(2, Math.round(src.w * s)), gh = Math.max(2, Math.round(src.h * s));
  const g = new Uint8Array(gw * gh);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const sx0 = Math.floor(x / gw * src.w), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) / gw * src.w));
    const sy0 = Math.floor(y / gh * src.h), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) / gh * src.h));
    let on = 0, all = 0;
    for (let yy = sy0; yy < sy1; yy++) for (let xx = sx0; xx < sx1; xx++) { on += src.mask[yy * src.w + xx]; all++; }
    g[y * gw + x] = on * 2 >= all ? 1 : 0;
  }
  return { g, gw, gh };
}

/** ゲーム用テクスチャ：物体の外側へ色をにじませ（側面が背景色にならないように）、正方形に収める */
export function makeTexture(src: SourceImage, size: number): HTMLCanvasElement {
  const s = size / Math.max(src.w, src.h);
  const tw = Math.max(1, Math.round(src.w * s)), th = Math.max(1, Math.round(src.h * s));
  const c = document.createElement('canvas');
  c.width = tw; c.height = th;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(src.canvas, 0, 0, tw, th);
  const img = ctx.getImageData(0, 0, tw, th);
  const d = img.data;
  const inside = new Uint8Array(tw * th);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    const mx = Math.min(src.w - 1, Math.floor(x / s)), my = Math.min(src.h - 1, Math.floor(y / s));
    inside[y * tw + x] = src.mask[my * src.w + mx];
  }
  // 輪郭のすぐ内側の数ピクセル（透明との境目で暗く混ざった色）は使わない。
  // 側面は輪郭の色が奥へ伸びるので、ここが暗いとフチに模様が出る
  const fringe = Math.max(2, Math.round(Math.max(tw, th) / 128));
  for (let pass = 0; pass < fringe; pass++) {
    const next = inside.slice();
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const i = y * tw + x;
      if (!inside[i]) continue;
      if (x === 0 || y === 0 || x === tw - 1 || y === th - 1 || !inside[i - 1] || !inside[i + 1] || !inside[i - tw] || !inside[i + tw]) next[i] = 0;
    }
    inside.set(next);
  }
  // 外側のピクセルを、隣の内側ピクセルの平均色で数回にじませる
  for (let pass = 0; pass < 12 + fringe; pass++) {
    const next = inside.slice();
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const i = y * tw + x;
      if (inside[i]) continue;
      let r = 0, g = 0, b = 0, cnt = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= tw || yy >= th) continue;
        const j = yy * tw + xx;
        if (inside[j]) { r += d[j * 4]; g += d[j * 4 + 1]; b += d[j * 4 + 2]; cnt++; }
      }
      if (cnt) { d[i * 4] = r / cnt; d[i * 4 + 1] = g / cnt; d[i * 4 + 2] = b / cnt; next[i] = 1; }
    }
    inside.set(next);
  }
  for (let i = 0; i < tw * th; i++) d[i * 4 + 3] = 255;
  ctx.putImageData(img, 0, 0);
  return c;
}

/** 明るさから法線マップを作る（凹凸。GLB に埋め込まれる） */
export function makeNormalMap(tex: HTMLCanvasElement): HTMLCanvasElement {
  const { width: w, height: h } = tex;
  const src = tex.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
  const L = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) L[i] = (src[i * 4] * 0.299 + src[i * 4 + 1] * 0.587 + src[i * 4 + 2] * 0.114) / 255;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  const out = ctx.createImageData(w, h);
  const at = (x: number, y: number) => L[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  const k = 2.0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
    const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
    let nx = -dx * k, ny = dy * k, nz = 1;
    const len = Math.hypot(nx, ny, nz);
    nx /= len; ny /= len; nz /= len;
    const i = (y * w + x) * 4;
    out.data[i] = (nx * 0.5 + 0.5) * 255; out.data[i + 1] = (ny * 0.5 + 0.5) * 255; out.data[i + 2] = (nz * 0.5 + 0.5) * 255; out.data[i + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  return c;
}
