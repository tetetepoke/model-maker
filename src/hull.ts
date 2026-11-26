// Phase 2：5方向シルエット → Visual Hull（形状測定用の3D目標形状）
//
// 座標：身長 = 1、足底 y = 0、正面 +Z、キャラの左 +X。
//   FRONT … x, y（画面右 = +X）       BACK … −x, y（画面右 = −X）
//   RIGHT … z, y（画面右 = +Z）       LEFT … −z, y（画面右 = −Z）
//   TOP   … x, z（画面右 = +X、画面下 = +Z）。FRONT の横幅・RIGHT の奥行きに合わせて当てはめる
// 各ビューは体の範囲で切り抜いてあり、中心軸 = 切り抜きの左右中央とする（規格「中心軸統一」）。
import * as THREE from 'three';
import type { SourceImage } from './mask';
import type { ViewId } from './sheetParse';

export interface HullOptions { res: number; tolerance: number; use: Record<ViewId, boolean> }
export interface HullResult {
  geometry: THREE.BufferGeometry;
  W: number; D: number; // 体の横幅・奥行き（身長比）
  iou: Partial<Record<ViewId, number>>;
  voxels: number; ms: number;
}

/** マスクを半径 r px だけ太らせる（ビュー同士の小さなずれを許容） */
function dilate(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r < 1) return m;
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let run = -1e9;
    for (let x = 0; x < w; x++) { if (m[y * w + x]) run = x; if (x - run <= r) tmp[y * w + x] = 1; }
    run = 1e9;
    for (let x = w - 1; x >= 0; x--) { if (m[y * w + x]) run = x; if (run - x <= r) tmp[y * w + x] = 1; }
  }
  for (let x = 0; x < w; x++) {
    let run = -1e9;
    for (let y = 0; y < h; y++) { if (tmp[y * w + x]) run = y; if (y - run <= r) out[y * w + x] = 1; }
    run = 1e9;
    for (let y = h - 1; y >= 0; y--) { if (tmp[y * w + x]) run = y; if (run - y <= r) out[y * w + x] = 1; }
  }
  return out;
}

type Sampler = (a: number, b: number) => boolean;

/** 正規化座標 (u: 横, v: 高さ) → ビュー画像の画素 */
function sideSampler(src: SourceImage, mask: Uint8Array, mirror: boolean): Sampler {
  const { w, h } = src;
  return (u, v) => {
    const px = Math.floor((mirror ? -u : u) * h + w / 2), py = Math.floor((1 - v) * h);
    return px >= 0 && py >= 0 && px < w && py < h && mask[py * w + px] === 1;
  };
}
function topSampler(src: SourceImage, mask: Uint8Array, W: number, D: number): Sampler {
  const { w, h } = src;
  return (x, z) => {
    const px = Math.floor((x / W + 0.5) * w), py = Math.floor((z / D + 0.5) * h);
    return px >= 0 && py >= 0 && px < w && py < h && mask[py * w + px] === 1;
  };
}

export function buildHull(views: Partial<Record<ViewId, SourceImage>>, opt: HullOptions): HullResult {
  const t0 = performance.now();
  const front = views.front;
  const side = views.right ?? views.left;
  if (!front || !side) throw new Error('FRONT と RIGHT（または LEFT）が必要です');
  const W = front.w / front.h, D = side.w / side.h;
  const res = opt.res, vs = 1 / res;
  const pad = 2;
  const nx = Math.ceil(W / vs) + pad * 2, ny = res + pad * 2, nz = Math.ceil(D / vs) + pad * 2;
  const x0 = -W / 2 - pad * vs, y0 = -pad * vs, z0 = -D / 2 - pad * vs;
  const X = (i: number) => x0 + (i + 0.5) * vs, Y = (j: number) => y0 + (j + 0.5) * vs, Z = (k: number) => z0 + (k + 0.5) * vs;

  const tolPx = (src: SourceImage) => Math.round(opt.tolerance * src.h);
  const S: Partial<Record<ViewId, { loose: Sampler; exact: Sampler }>> = {};
  const mk = (id: ViewId, make: (m: Uint8Array) => Sampler) => {
    const src = views[id];
    if (!src || !opt.use[id]) return;
    S[id] = { loose: make(dilate(src.mask, src.w, src.h, tolPx(src))), exact: make(src.mask) };
  };
  mk('front', m => sideSampler(front, m, false));
  if (views.back) mk('back', m => sideSampler(views.back!, m, true));
  if (views.right) mk('right', m => sideSampler(views.right!, m, false));
  if (views.left) mk('left', m => sideSampler(views.left!, m, true));
  if (views.top) mk('top', m => topSampler(views.top!, m, W, D));

  // 削り出し：使うビューすべての（少し太らせた）シルエットの内側にある点だけを残す
  const occ = new Uint8Array(nx * ny * nz);
  const idx = (i: number, j: number, k: number) => (k * ny + j) * nx + i;
  let voxels = 0;
  for (let k = pad; k < nz - pad; k++) for (let j = pad; j < ny - pad; j++) for (let i = pad; i < nx - pad; i++) {
    const x = X(i), y = Y(j), z = Z(k);
    if (S.front && !S.front.loose(x, y)) continue;
    if (S.back && !S.back.loose(x, y)) continue;
    if (S.right && !S.right.loose(z, y)) continue;
    if (S.left && !S.left.loose(z, y)) continue;
    if (S.top && !S.top.loose(x, z)) continue;
    occ[idx(i, j, k)] = 1; voxels++;
  }

  // 一致度（IoU）：Visual Hull を各方向に投影した影と、元のシルエットの重なり
  const iou: HullResult['iou'] = {};
  const proj = (id: ViewId, A: number, B: number, hit: (a: number, b: number) => boolean, ref: Sampler | undefined, ua: (a: number) => number, vb: (b: number) => number) => {
    if (!ref) return;
    let inter = 0, uni = 0;
    for (let b = 0; b < B; b++) for (let a = 0; a < A; a++) {
      const p = hit(a, b), q = ref(ua(a), vb(b));
      if (p && q) inter++;
      if (p || q) uni++;
    }
    iou[id] = uni ? inter / uni : 0;
  };
  const anyZ = (i: number, j: number) => { for (let k = 0; k < nz; k++) if (occ[idx(i, j, k)]) return true; return false; };
  const anyX = (k: number, j: number) => { for (let i = 0; i < nx; i++) if (occ[idx(i, j, k)]) return true; return false; };
  const anyY = (i: number, k: number) => { for (let j = 0; j < ny; j++) if (occ[idx(i, j, k)]) return true; return false; };
  const ex = (id: ViewId) => (views[id] ? S[id]?.exact ?? (id === 'front' || id === 'back' || id === 'right' || id === 'left'
    ? sideSampler(views[id]!, views[id]!.mask, id === 'back' || id === 'left') : topSampler(views[id]!, views[id]!.mask, W, D)) : undefined);
  proj('front', nx, ny, anyZ, ex('front'), X, Y);
  proj('back', nx, ny, anyZ, ex('back'), X, Y);
  proj('right', nz, ny, anyX, ex('right'), Z, Y);
  proj('left', nz, ny, anyX, ex('left'), Z, Y);
  proj('top', nx, nz, anyY, ex('top'), X, Z);

  const geometry = surfaceNets(occ, nx, ny, nz, (i, j, k) => new THREE.Vector3(x0 + i * vs + vs / 2, y0 + j * vs + vs / 2, z0 + k * vs + vs / 2));
  return { geometry, W, D, iou, voxels, ms: performance.now() - t0 };
}

/** 0/1 のボリュームを少しぼかしてから Naive Surface Nets で表面を作る（閉じた連続メッシュ） */
function surfaceNets(occ: Uint8Array, nx: number, ny: number, nz: number, pos: (i: number, j: number, k: number) => THREE.Vector3): THREE.BufferGeometry {
  const idx = (i: number, j: number, k: number) => (k * ny + j) * nx + i;
  // 3×3×3 の平均でなめらかにする（段々を減らす）
  const f = new Float32Array(nx * ny * nz);
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    let s = 0;
    for (let dk = -1; dk <= 1; dk++) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) s += occ[idx(i + di, j + dj, k + dk)];
    f[idx(i, j, k)] = s / 27;
  }
  const iso = 0.5;
  const cx = nx - 1, cy = ny - 1, cz = nz - 1;
  const cell = new Int32Array(cx * cy * cz).fill(-1);
  const cidx = (i: number, j: number, k: number) => (k * cy + j) * cx + i;
  const P: number[] = [];
  const corners = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const val = new Float32Array(8);
  for (let k = 0; k < cz; k++) for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) {
    let mask = 0;
    for (let c = 0; c < 8; c++) {
      val[c] = f[idx(i + corners[c][0], j + corners[c][1], k + corners[c][2])];
      if (val[c] > iso) mask |= 1 << c;
    }
    if (mask === 0 || mask === 255) continue;
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const [a, b] of edges) {
      const ia = val[a] > iso, ib = val[b] > iso;
      if (ia === ib) continue;
      const t = (iso - val[a]) / (val[b] - val[a]);
      sx += corners[a][0] + t * (corners[b][0] - corners[a][0]);
      sy += corners[a][1] + t * (corners[b][1] - corners[a][1]);
      sz += corners[a][2] + t * (corners[b][2] - corners[a][2]);
      n++;
    }
    const p0 = pos(i, j, k), p1 = pos(i + 1, j + 1, k + 1);
    cell[cidx(i, j, k)] = P.length / 3;
    P.push(p0.x + (p1.x - p0.x) * sx / n, p0.y + (p1.y - p0.y) * sy / n, p0.z + (p1.z - p0.z) * sz / n);
  }
  const I: number[] = [];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) I.push(a, d, c, a, c, b); else I.push(a, b, c, a, c, d);
  };
  const inside = (i: number, j: number, k: number) => f[idx(i, j, k)] > iso;
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const s = inside(i, j, k);
    if (i < nx - 1 && s !== inside(i + 1, j, k) && j >= 1 && k >= 1 && j < cy && k < cz)
      quad(cell[cidx(i, j - 1, k - 1)], cell[cidx(i, j, k - 1)], cell[cidx(i, j, k)], cell[cidx(i, j - 1, k)], !s);
    if (j < ny - 1 && s !== inside(i, j + 1, k) && i >= 1 && k >= 1 && i < cx && k < cz)
      quad(cell[cidx(i - 1, j, k - 1)], cell[cidx(i - 1, j, k)], cell[cidx(i, j, k)], cell[cidx(i, j, k - 1)], !s);
    if (k < nz - 1 && s !== inside(i, j, k + 1) && i >= 1 && j >= 1 && i < cx && j < cy)
      quad(cell[cidx(i - 1, j - 1, k)], cell[cidx(i, j - 1, k)], cell[cidx(i, j, k)], cell[cidx(i - 1, j, k)], !s);
  }
  // 軽いラプラシアン平滑化（2回）
  const nv = P.length / 3;
  const nb: Set<number>[] = Array.from({ length: nv }, () => new Set());
  for (let t = 0; t < I.length; t += 3) {
    const [a, b, c] = [I[t], I[t + 1], I[t + 2]];
    nb[a].add(b); nb[a].add(c); nb[b].add(a); nb[b].add(c); nb[c].add(a); nb[c].add(b);
  }
  for (let it = 0; it < 2; it++) {
    const Q = P.slice();
    for (let v = 0; v < nv; v++) {
      if (!nb[v].size) continue;
      let ax = 0, ay = 0, az = 0;
      for (const u of nb[v]) { ax += P[u * 3]; ay += P[u * 3 + 1]; az += P[u * 3 + 2]; }
      const s = nb[v].size;
      Q[v * 3] = P[v * 3] * 0.5 + (ax / s) * 0.5; Q[v * 3 + 1] = P[v * 3 + 1] * 0.5 + (ay / s) * 0.5; Q[v * 3 + 2] = P[v * 3 + 2] * 0.5 + (az / s) * 0.5;
    }
    for (let q = 0; q < Q.length; q++) P[q] = Q[q];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setIndex(I);
  g.computeVertexNormals();
  return g;
}
