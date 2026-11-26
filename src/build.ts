// STEP 3–4: 輪郭・マスクから立体を作る。
//   inflate … マスクの距離場で中央をふくらませる（石・鉱石・キャラ向け。丸み・凹凸が自然）
//   extrude … 輪郭を押し出して面取り（武器・道具・板状の物向け。エッジがシャープ）
// どちらも「板に絵を貼っただけ」にならないよう、側面・裏面まで閉じた立体にする。
import * as THREE from 'three';
import { groupOutlines, simplify, smooth, traceContours, type Pt } from './contour';
import { downsample, type SourceImage } from './mask';

export type ShapeMode = 'inflate' | 'extrude';

export interface ShapeParams {
  mode: ShapeMode;
  detail: number; // inflate: グリッドの長辺セル数 / extrude: 輪郭用グリッドの長辺
  thickness: number; // 高さに対する厚みの比（0.05–1.0）
  roundness: number; // 0–1
  bump: number; // 0–1 凹凸
  smoothing: number; // 輪郭の平滑化回数
}

/** 高さ 1、底辺中心が原点、正面 = +Z のジオメトリを返す（UV は画像の正面投影） */
export interface Lum { data: Float32Array; w: number; h: number }

export function buildGeometry(src: SourceImage, p: ShapeParams, lum: Lum | null): THREE.BufferGeometry {
  return p.mode === 'extrude' ? buildExtrude(src, p) : buildInflate(src, p, lum);
}

// ---------------------------------------------------------------- inflate
function buildInflate(src: SourceImage, p: ShapeParams, lum: Lum | null): THREE.BufferGeometry {
  const { g, gw, gh } = downsample(src, p.detail);
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < gw && y < gh && g[y * gw + x] === 1;

  // 距離場（chamfer 3-4）：各セルの「輪郭からの距離」
  const INF = 1e9;
  const d = new Float32Array(gw * gh);
  for (let i = 0; i < d.length; i++) d[i] = g[i] ? INF : 0;
  const relax = (i: number, j: number, c: number) => { if (d[j] + c < d[i]) d[i] = d[j] + c; };
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const i = y * gw + x; if (!g[i]) continue;
    if (x === 0 || y === 0) { d[i] = Math.min(d[i], 3); }
    if (x > 0) relax(i, i - 1, 3); else d[i] = Math.min(d[i], 3);
    if (y > 0) { relax(i, i - gw, 3); if (x > 0) relax(i, i - gw - 1, 4); if (x < gw - 1) relax(i, i - gw + 1, 4); } else d[i] = Math.min(d[i], 3);
  }
  for (let y = gh - 1; y >= 0; y--) for (let x = gw - 1; x >= 0; x--) {
    const i = y * gw + x; if (!g[i]) continue;
    if (x < gw - 1) relax(i, i + 1, 3); else d[i] = Math.min(d[i], 3);
    if (y < gh - 1) { relax(i, i + gw, 3); if (x < gw - 1) relax(i, i + gw + 1, 4); if (x > 0) relax(i, i + gw - 1, 4); } else d[i] = Math.min(d[i], 3);
  }
  let dmax = 1;
  for (let i = 0; i < d.length; i++) if (g[i] && d[i] > dmax) dmax = d[i];

  // セルごとの半分の厚み（高さ1 = gh セル）
  const cell = 1 / gh;
  const half = (p.thickness / 2);
  const edge = 0.22; // 輪郭での厚みの割合（0 にすると刃物のように薄くなる）
  const R = Math.max(p.roundness, 0.02) * dmax;
  const zc = new Float32Array(gw * gh);
  for (let i = 0; i < zc.length; i++) {
    if (!g[i]) continue;
    const t = Math.min(1, d[i] / R);
    const circle = Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t)));
    zc[i] = half * (p.roundness < 0.02 ? 1 : edge + (1 - edge) * circle);
  }

  // セルの角（頂点）。角に接する前景セルの値を平均する
  const cw = gw + 1, chh = gh + 1;
  const vid = new Int32Array(cw * chh).fill(-1);
  const vx: number[] = [], vy: number[] = [], vz: number[] = [], vu: number[] = [], vv: number[] = [];
  for (let y = 0; y < chh; y++) for (let x = 0; x < cw; x++) {
    let s = 0, c = 0;
    for (const [dx, dy] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) {
      if (inside(x + dx, y + dy)) { s += zc[(y + dy) * gw + x + dx]; c++; }
    }
    if (!c) continue;
    // 輪郭上の角は、丸みが強いほど薄くする → 表と裏が丸いフチでつながる（石ころの形）
    const rimZ = half * (1 - 0.92 * Math.min(1, p.roundness * 1.15));
    const z = c === 4 ? s / c : Math.min(s / c, rimZ);
    vid[y * cw + x] = vx.length;
    vx.push(x); vy.push(y); vz.push(z);
    vu.push(x / gw); vv.push(1 - y / gh);
  }
  const nv = vx.length;

  // 境界の角を見つけ、輪郭に沿って段々をならす
  const nbr: number[][] = Array.from({ length: nv }, () => []);
  const walls: [number, number][] = [];
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    if (!inside(x, y)) continue;
    const c00 = vid[y * cw + x], c10 = vid[y * cw + x + 1], c01 = vid[(y + 1) * cw + x], c11 = vid[(y + 1) * cw + x + 1];
    if (!inside(x, y - 1)) walls.push([c10, c00]);
    if (!inside(x, y + 1)) walls.push([c01, c11]);
    if (!inside(x - 1, y)) walls.push([c00, c01]);
    if (!inside(x + 1, y)) walls.push([c11, c10]);
  }
  for (const [a, b] of walls) { nbr[a].push(b); nbr[b].push(a); }
  for (let it = 0; it < p.smoothing + 4; it++) {
    const nx = vx.slice(), ny = vy.slice();
    for (let i = 0; i < nv; i++) {
      const n = nbr[i];
      if (n.length !== 2) continue;
      nx[i] = (vx[i] * 2 + vx[n[0]] + vx[n[1]]) / 4;
      ny[i] = (vy[i] * 2 + vy[n[0]] + vy[n[1]]) / 4;
    }
    for (let i = 0; i < nv; i++) { vx[i] = nx[i]; vy[i] = ny[i]; }
  }
  // 面の厚みを少しなめらかに
  const adj: number[][] = Array.from({ length: nv }, () => []);
  for (let y = 0; y < chh; y++) for (let x = 0; x < cw; x++) {
    const a = vid[y * cw + x]; if (a < 0) continue;
    if (x + 1 < cw && vid[y * cw + x + 1] >= 0) { const b = vid[y * cw + x + 1]; adj[a].push(b); adj[b].push(a); }
    if (y + 1 < chh && vid[(y + 1) * cw + x] >= 0) { const b = vid[(y + 1) * cw + x]; adj[a].push(b); adj[b].push(a); }
  }
  // 内側の頂点も輪郭に合わせて少し寄せる（フチ付近に段々の模様が出ないように）
  for (let it = 0; it < 4; it++) {
    const nx = vx.slice(), ny = vy.slice();
    for (let i = 0; i < nv; i++) {
      if (nbr[i].length) continue;
      const n = adj[i]; if (n.length < 4) continue;
      let sx = 0, sy = 0;
      for (const j of n) { sx += vx[j]; sy += vy[j]; }
      nx[i] = (vx[i] + sx / n.length) / 2; ny[i] = (vy[i] + sy / n.length) / 2;
    }
    for (let i = 0; i < nv; i++) { vx[i] = nx[i]; vy[i] = ny[i]; }
  }
  for (let it = 0; it < 3; it++) {
    const nz = vz.slice();
    for (let i = 0; i < nv; i++) {
      if (nbr[i].length) continue; // 輪郭のフチの薄さは保つ
      const n = adj[i]; if (n.length) nz[i] = (vz[i] + n.reduce((s, j) => s + vz[j], 0) / n.length) / 2;
    }
    for (let i = 0; i < nv; i++) vz[i] = nz[i];
  }

  // 凹凸：画像の明るさで表面を押し出す（明るい所が出っ張る）
  const bumpZ = (i: number) => {
    if (!lum || p.bump <= 0) return 0;
    const lw = lum.w, lh = lum.h;
    const x = Math.min(lw - 1, Math.max(0, Math.floor(vu[i] * lw)));
    const y = Math.min(lh - 1, Math.max(0, Math.floor((1 - vv[i]) * lh)));
    return (lum.data[y * lw + x] - 0.5) * p.bump * half * 0.6;
  };

  // 丸みが強いときは、輪郭上で表と裏を同じ頂点にして縫い合わせる（側面の帯ができず、なめらかなフチになる）
  const weld = p.roundness >= 0.6;
  const isRim = (i: number) => nbr[i].length > 0;
  const back = (i: number) => (weld && isRim(i) ? i : nv + i);

  // 頂点：前面 [0, nv)、背面 [nv, 2nv)
  const pos = new Float32Array(nv * 2 * 3), uv = new Float32Array(nv * 2 * 2);
  for (let i = 0; i < nv; i++) {
    const X = (vx[i] - gw / 2) * cell, Y = (gh - vy[i]) * cell;
    const b = bumpZ(i) * (nbr[i].length ? 0 : 1); // 輪郭は動かさない
    let zf = Math.max(vz[i] + b, 0.002), zb = Math.max(vz[i] + b * 0.6, 0.002);
    if (weld && isRim(i)) { zf = 0; zb = 0; }
    pos.set([X, Y, zf], i * 3);
    pos.set([X, Y, -zb], (nv + i) * 3);
    uv.set([vu[i], vv[i]], i * 2);
    uv.set([vu[i], vv[i]], (nv + i) * 2);
  }
  const idx: number[] = [];
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    if (!inside(x, y)) continue;
    const a = vid[y * cw + x], b = vid[y * cw + x + 1], c = vid[(y + 1) * cw + x], e = vid[(y + 1) * cw + x + 1];
    idx.push(a, c, b, b, c, e); // 前面（+Z 向き）
    idx.push(back(a), back(b), back(c), back(b), back(e), back(c)); // 背面
  }
  if (!weld) for (const [a, b] of walls) idx.push(a, nv + a, b, b, nv + a, nv + b); // 側面

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// ---------------------------------------------------------------- extrude
function buildExtrude(src: SourceImage, p: ShapeParams): THREE.BufferGeometry {
  const { g, gw, gh } = downsample(src, Math.max(p.detail * 2, 96));
  const outlines = groupOutlines(traceContours(g, gw, gh));
  const toV = ([x, y]: Pt) => new THREE.Vector2((x - gw / 2) / gh, (gh - y) / gh);
  const prep = (pts: Pt[]) => simplify(smooth(pts, p.smoothing + 1), 0.6);
  const shapes: THREE.Shape[] = [];
  for (const o of outlines) {
    const outer = prep(o.outer).map(toV);
    if (outer.length < 3) continue;
    if (THREE.ShapeUtils.isClockWise(outer)) outer.reverse();
    const shape = new THREE.Shape(outer);
    for (const h of o.holes) {
      const hp = prep(h).map(toV);
      if (hp.length < 3) continue;
      if (!THREE.ShapeUtils.isClockWise(hp)) hp.reverse();
      shape.holes.push(new THREE.Path(hp));
    }
    shapes.push(shape);
  }
  const T = p.thickness;
  const bevel = Math.min(T * 0.45, 0.06) * p.roundness;
  const geo = new THREE.ExtrudeGeometry(shapes, {
    depth: Math.max(T - bevel * 2, 0.001),
    bevelEnabled: bevel > 0.0005,
    bevelThickness: bevel,
    bevelSize: bevel * 0.8,
    bevelOffset: -bevel * 0.8, // 面取りしても輪郭が太らないように
    bevelSegments: Math.max(1, Math.round(1 + p.roundness * 5)),
    curveSegments: 1,
  });
  geo.translate(0, 0, -T / 2 + bevel);
  // 全頂点に正面投影の UV（側面は輪郭の色が奥へ伸びる）
  const pos = geo.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  const xmin = -gw / 2 / gh, xspan = gw / gh;
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = (pos.getX(i) - xmin) / xspan;
    uv[i * 2 + 1] = pos.getY(i);
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.deleteAttribute('normal');
  const merged = mergeVerticesSafe(geo);
  merged.computeVertexNormals();
  return merged;
}

function mergeVerticesSafe(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  // ExtrudeGeometry は非インデックス。そのまま法線を計算するとフラットになるので、
  // 面取り部分を滑らかに見せるため位置＋UV が同じ頂点だけまとめる
  const pos = geo.attributes.position, uv = geo.attributes.uv;
  const map = new Map<string, number>();
  const P: number[] = [], U: number[] = [], I: number[] = [];
  const q = (v: number) => Math.round(v * 1e4);
  for (let i = 0; i < pos.count; i++) {
    const k = `${q(pos.getX(i))},${q(pos.getY(i))},${q(pos.getZ(i))},${q(uv.getX(i))},${q(uv.getY(i))}`;
    let id = map.get(k);
    if (id === undefined) { id = P.length / 3; map.set(k, id); P.push(pos.getX(i), pos.getY(i), pos.getZ(i)); U.push(uv.getX(i), uv.getY(i)); }
    I.push(id);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  out.setIndex(I);
  return out;
}

/** テクスチャの明るさ（凹凸用）を小さい配列で */
export function luminance(tex: HTMLCanvasElement, longSide = 128): Lum {
  const s = longSide / Math.max(tex.width, tex.height);
  const w = Math.max(1, Math.round(tex.width * s)), h = Math.max(1, Math.round(tex.height * s));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(tex, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const L = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) L[i] = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) / 255;
  return { data: L, w, h };
}

/** 輪郭のプレビュー用（STEP 2 の表示） */
export function previewOutlines(src: SourceImage, smoothing: number): Pt[][] {
  const { g, gw, gh } = downsample(src, 160);
  const sx = src.w / gw, sy = src.h / gh;
  return traceContours(g, gw, gh).map(c => simplify(smooth(c.pts, smoothing + 1), 0.6).map(([x, y]) => [x * sx, y * sy] as Pt));
}
