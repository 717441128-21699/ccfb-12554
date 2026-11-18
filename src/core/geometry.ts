import type { Rect, Vec2 } from './types';
import type { Placement } from './types';

// ---------- 基础向量 ----------

export const v = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const norm = (a: Vec2): Vec2 => {
  const l = Math.hypot(a.x, a.y) || 1;
  return { x: a.x / l, y: a.y / l };
};
export const clamp = (x: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, x));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** mulberry32 —— 求解过程可复现 */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 8 种朝向（镜像 + 90° 倍数旋转） ----------

export interface Orientation {
  rot: 0 | 90 | 180 | 270;
  flipX: boolean;
}

export const ALL_ORIENTATIONS: Orientation[] = [
  { rot: 0, flipX: false },
  { rot: 90, flipX: false },
  { rot: 180, flipX: false },
  { rot: 270, flipX: false },
  { rot: 0, flipX: true },
  { rot: 90, flipX: true },
  { rot: 180, flipX: true },
  { rot: 270, flipX: true },
];

/** 朝向变换后板的占地尺寸 */
export function orientedSize(w: number, h: number, o: Orientation): Vec2 {
  return o.rot === 90 || o.rot === 270 ? { x: h, y: w } : { x: w, y: h };
}

/** 板自身坐标 -> 该朝向下的局部坐标（包围盒左上角归零） */
export function orientPoint(p: Vec2, w: number, h: number, o: Orientation): Vec2 {
  const mx = o.flipX ? w - p.x : p.x;
  const my = p.y;
  switch (o.rot) {
    case 0:
      return { x: mx, y: my };
    case 90:
      return { x: my, y: w - mx };
    case 180:
      return { x: w - mx, y: h - my };
    case 270:
      return { x: h - my, y: mx };
  }
}

/** 朝向局部坐标 -> 板自身坐标（orientPoint 的逆） */
export function unorientPoint(p: Vec2, w: number, h: number, o: Orientation): Vec2 {
  let mx: number;
  let my: number;
  switch (o.rot) {
    case 0:
      mx = p.x;
      my = p.y;
      break;
    case 90:
      my = p.x;
      mx = w - p.y;
      break;
    case 180:
      mx = w - p.x;
      my = h - p.y;
      break;
    case 270:
      my = h - p.x;
      mx = p.y;
      break;
  }
  return { x: o.flipX ? w - mx : mx, y: my };
}

/** 纹路切线方向（板自身坐标）-> 朝向局部坐标下的方向 */
export function orientVector(d: Vec2, o: Orientation): Vec2 {
  const mx = o.flipX ? -d.x : d.x;
  const my = d.y;
  switch (o.rot) {
    case 0:
      return { x: mx, y: my };
    case 90:
      return { x: my, y: -mx };
    case 180:
      return { x: -mx, y: -my };
    case 270:
      return { x: -my, y: mx };
  }
}

export type EdgeName = 'left' | 'right' | 'top' | 'bottom';

/**
 * 摆放后某一侧（placed 空间）对应板自身的哪条边，以及沿边参数是否反向。
 * 通过四个角点的逆变换数值推导，避免硬编码映射表出错。
 */
export function edgeOnPlacedSide(
  w: number,
  h: number,
  o: Orientation,
  side: EdgeName,
): { edge: EdgeName; reversed: boolean } {
  const size = orientedSize(w, h, o);
  const corners: Record<EdgeName, [Vec2, Vec2]> = {
    left: [v(0, 0), v(0, size.y)],
    right: [v(size.x, 0), v(size.x, size.y)],
    top: [v(0, 0), v(size.x, 0)],
    bottom: [v(0, size.y), v(size.x, size.y)],
  };
  const [a, b] = corners[side].map((p) => unorientPoint(p, w, h, o));
  const eps = 1e-6;
  const classify = (p: Vec2): EdgeName => {
    if (Math.abs(p.x) <= eps) return 'left';
    if (Math.abs(p.x - w) <= eps) return 'right';
    if (Math.abs(p.y) <= eps) return 'top';
    return 'bottom';
  };
  const edge = classify(a);
  // 沿 placed 侧从起点走到终点，若在原边上参数递减则 reversed
  const param = (p: Vec2): number =>
    edge === 'left' || edge === 'right' ? p.y : p.x;
  return { edge, reversed: param(b) < param(a) };
}

// ---------- 摆放实例 ----------

export function placementRect(p: Placement): Rect {
  return { x: p.x, y: p.y, width: p.width, height: p.height };
}

export function rectsOverlap(a: Rect, b: Rect, eps = 1e-6): boolean {
  return (
    a.x < b.x + b.width - eps &&
    a.x + a.width > b.x + eps &&
    a.y < b.y + b.height - eps &&
    a.y + a.height > b.y + eps
  );
}

export function rectContains(r: Rect, p: Vec2, eps = 1e-6): boolean {
  return (
    p.x >= r.x - eps &&
    p.x <= r.x + r.width + eps &&
    p.y >= r.y - eps &&
    p.y <= r.y + r.height + eps
  );
}

export function expandRect(r: Rect, m: number): Rect {
  return { x: r.x - m, y: r.y - m, width: r.width + 2 * m, height: r.height + 2 * m };
}

export function rectArea(r: Rect): number {
  return Math.max(0, r.width) * Math.max(0, r.height);
}

export function intersectRects(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

/** 点到矩形的最近距离（点在矩形内返回 0） */
export function pointRectDistance(p: Vec2, r: Rect): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.width));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.height));
  return Math.hypot(dx, dy);
}

function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const l2 = abx * abx + aby * aby;
  if (l2 === 0) return len(sub(p, a));
  const t = clamp(((p.x - a.x) * abx + (p.y - a.y) * aby) / l2, 0, 1);
  return len(sub(p, v(a.x + abx * t, a.y + aby * t)));
}

/**
 * 线段到矩形的距离：相交返回 0，否则取端点到矩形、矩形角点到线段的最小值。
 * 对凸矩形这是精确值。
 */
export function segmentRectDistance(a: Vec2, b: Vec2, r: Rect): number {
  if (rectContains(r, a) || rectContains(r, b)) return 0;
  const corners = [
    v(r.x, r.y),
    v(r.x + r.width, r.y),
    v(r.x + r.width, r.y + r.height),
    v(r.x, r.y + r.height),
  ];
  // 线段与四条边相交判定
  for (let i = 0; i < 4; i++) {
    if (segmentsIntersect(a, b, corners[i], corners[(i + 1) % 4])) return 0;
  }
  let best = Math.min(pointRectDistance(a, r), pointRectDistance(b, r));
  for (const c of corners) best = Math.min(best, pointSegmentDistance(c, a, b));
  return best;
}

/** 折线段到矩形的最近距离 */
export function polylineRectDistance(points: Vec2[], r: Rect): number {
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    best = Math.min(best, segmentRectDistance(points[i], points[i + 1], r));
  }
  if (points.length === 1) best = pointRectDistance(points[0], r);
  return best;
}

function segmentsIntersect(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): boolean {
  const d = (a: Vec2, b: Vec2, c: Vec2) =>
    (c.x - a.x) * (b.y - a.y) - (b.x - a.x) * (c.y - a.y);
  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);
  return (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  );
}

/** 将一条归一化 [0,1] 折线换算为指定宽高的毫米坐标 */
export function denormPolyline(points: Vec2[], w: number, h: number): Vec2[] {
  return points.map((p) => v(p.x * w, p.y * h));
}
