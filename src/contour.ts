// STEP 2: マスクの輪郭を取り出す（マーチングスクエア → 平滑化 → 間引き）
export type Pt = [number, number];
export interface Contour { pts: Pt[]; area: number } // area > 0 = 外周、< 0 = 穴

/** 0/1 グリッドの境界線をすべて閉じたポリラインとして返す（座標はセル単位） */
export function traceContours(g: Uint8Array, w: number, h: number): Contour[] {
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? g[y * w + x] : 0);
  // 前景セルの各辺のうち、隣が背景の辺を「向き付きの線分」として集める（前景を左手に見る向き）
  const next = new Map<string, Pt[]>();
  const key = (x: number, y: number) => x + ',' + y;
  const add = (ax: number, ay: number, bx: number, by: number) => {
    const k = key(ax, ay);
    const arr = next.get(k);
    if (arr) arr.push([bx, by]); else next.set(k, [[bx, by]]);
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!at(x, y)) continue;
    if (!at(x, y - 1)) add(x + 1, y, x, y);
    if (!at(x, y + 1)) add(x, y + 1, x + 1, y + 1);
    if (!at(x - 1, y)) add(x, y, x, y + 1);
    if (!at(x + 1, y)) add(x + 1, y + 1, x + 1, y);
  }
  const out: Contour[] = [];
  for (const [startKey] of next) {
    while ((next.get(startKey)?.length ?? 0) > 0) {
      const [sx, sy] = startKey.split(',').map(Number);
      const pts: Pt[] = [[sx, sy]];
      let cx = sx, cy = sy;
      for (let guard = 0; guard < w * h * 4; guard++) {
        const arr = next.get(key(cx, cy));
        if (!arr || !arr.length) break;
        const [nx, ny] = arr.pop()!;
        if (nx === sx && ny === sy) break;
        pts.push([nx, ny]);
        cx = nx; cy = ny;
      }
      if (pts.length >= 4) out.push({ pts, area: signedArea(pts) });
    }
  }
  return out;
}

export function signedArea(p: Pt[]): number {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j][0] + p[i][0]) * (p[j][1] - p[i][1]);
  return a / 2;
}

/** 段々（ギザギザ）をならす */
export function smooth(p: Pt[], iterations: number): Pt[] {
  let cur = p;
  for (let it = 0; it < iterations; it++) {
    const n = cur.length;
    cur = cur.map((_, i) => {
      const a = cur[(i - 1 + n) % n], b = cur[i], c = cur[(i + 1) % n];
      return [(a[0] + 2 * b[0] + c[0]) / 4, (a[1] + 2 * b[1] + c[1]) / 4] as Pt;
    });
  }
  return cur;
}

/** Douglas–Peucker で点を間引く（閉じた線） */
export function simplify(p: Pt[], tol: number): Pt[] {
  if (p.length < 8) return p;
  // 一番遠い2点で2本に分けて開いた線として処理
  let far = 0, best = 0;
  for (let i = 1; i < p.length; i++) {
    const d = (p[i][0] - p[0][0]) ** 2 + (p[i][1] - p[0][1]) ** 2;
    if (d > best) { best = d; far = i; }
  }
  const a = dp(p.slice(0, far + 1), tol), b = dp([...p.slice(far), p[0]], tol);
  const res = [...a.slice(0, -1), ...b.slice(0, -1)];
  return res.length >= 3 ? res : p;
}

function dp(p: Pt[], tol: number): Pt[] {
  if (p.length <= 2) return p;
  const [ax, ay] = p[0], [bx, by] = p[p.length - 1];
  const len = Math.hypot(bx - ax, by - ay) || 1;
  let idx = 0, max = 0;
  for (let i = 1; i < p.length - 1; i++) {
    const d = Math.abs((bx - ax) * (ay - p[i][1]) - (ax - p[i][0]) * (by - ay)) / len;
    if (d > max) { max = d; idx = i; }
  }
  if (max <= tol) return [p[0], p[p.length - 1]];
  return [...dp(p.slice(0, idx + 1), tol).slice(0, -1), ...dp(p.slice(idx), tol)];
}

export function pointInPolygon(pt: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export interface ShapeOutline { outer: Pt[]; holes: Pt[][] }

/** 外周ごとに、その中にある穴をまとめる */
export function groupOutlines(contours: Contour[]): ShapeOutline[] {
  // traceContours の向きでは、外周は area > 0、穴は area < 0 になる
  const outers = contours.filter(c => c.area > 0).sort((a, b) => b.area - a.area);
  const holes = contours.filter(c => c.area < 0);
  const shapes: ShapeOutline[] = outers.map(o => ({ outer: o.pts, holes: [] }));
  for (const hole of holes) {
    const s = shapes.find(sh => pointInPolygon(hole.pts[0], sh.outer));
    if (s) s.holes.push(hole.pts);
  }
  return shapes;
}
