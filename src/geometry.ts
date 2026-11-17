import type { GridCell, Opening, Placement, Slab, Surface, Vec2 } from './types';

export function rectsOverlap(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number
): boolean {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

export function rectArea(w: number, h: number): number {
  return Math.max(0, w) * Math.max(0, h);
}

/** 点是否在矩形内（含边界） */
export function pointInRect(p: Vec2, x: number, y: number, w: number, h: number): boolean {
  return p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h;
}

/** 折线段是否与矩形相交（含端点在矩形内） */
export function polylineIntersectsRect(points: Vec2[], x: number, y: number, w: number, h: number): boolean {
  if (points.some((p) => pointInRect(p, x, y, w, h))) return true;
  for (let i = 0; i < points.length - 1; i++) {
    if (segIntersectsRect(points[i], points[i + 1], x, y, w, h)) return true;
  }
  return false;
}

function segIntersectsRect(a: Vec2, b: Vec2, x: number, y: number, w: number, h: number): boolean {
  // 线段与矩形四条边做相交测试
  const corners: [Vec2, Vec2][] = [
    [{ x, y }, { x: x + w, y }],
    [{ x: x + w, y }, { x: x + w, y: y + h }],
    [{ x: x + w, y: y + h }, { x, y: y + h }],
    [{ x, y: y + h }, { x, y }]
  ];
  return corners.some(([c, d]) => segSegIntersect(a, b, c, d));
}

function segSegIntersect(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): boolean {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-12) return false;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/**
 * 把展开图按标准大板尺寸划分网格。
 * 最后一列/行不足整板时生成收边小板（现场裁切）。
 */
export function buildGrid(surface: Surface, slabW: number, slabH: number, rot90: boolean): GridCell[] {
  const cellW = rot90 ? slabH : slabW;
  const cellH = rot90 ? slabW : slabH;
  const cols = Math.ceil(surface.widthMm / cellW);
  const rows = Math.ceil(surface.heightMm / cellH);
  const cells: GridCell[] = [];
  let id = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * cellW;
      const y = r * cellH;
      const w = Math.min(cellW, surface.widthMm - x);
      const h = Math.min(cellH, surface.heightMm - y);
      const openingIds: string[] = [];
      let skip = true;
      if (rectArea(w, h) > 1) {
        for (const op of surface.openings) {
          if (rectsOverlap(x, y, w, h, op.x, op.y, op.width, op.height)) {
            openingIds.push(op.id);
            skip = false; // 与洞口相交的格子仍需覆盖，板上开孔
          }
        }
        // 格子完全落在某个洞口内才跳过
        const fullyInside = surface.openings.some(
          (op) => x >= op.x && y >= op.y && x + w <= op.x + op.width && y + h <= op.y + op.height
        );
        if (!fullyInside && rectArea(w, h) > 1) skip = false;
      }
      cells.push({ id: id++, col: c, row: r, x, y, width: w, height: h, skip, openingIds });
    }
  }
  return cells;
}

/**
 * 板的局部坐标（毫米，原点左上）经过排版姿态变换到展开图坐标。
 * 先可选旋转 90°，再按 flip 镜像。
 */
export function localToWorld(
  p: Vec2,
  slab: Slab,
  placement: Pick<Placement, 'x' | 'y' | 'rot90' | 'flip'>
): Vec2 {
  const w = slab.widthMm;
  const h = slab.heightMm;
  let { x, y } = p;
  if (placement.rot90) {
    // 顺时针 90°
    const nx = h - y;
    const ny = x;
    x = nx;
    y = ny;
  }
  const W = placement.rot90 ? h : w;
  const H = placement.rot90 ? w : h;
  switch (placement.flip) {
    case 1: x = W - x; break;          // 水平镜像
    case 2: x = W - x; y = H - y; break; // 180°
    case 3: y = H - y; break;          // 垂直镜像
    default: break;
  }
  return { x: placement.x + x, y: placement.y + y };
}

/** 展开图坐标反算到板局部坐标 */
export function worldToLocal(
  p: Vec2,
  slab: Slab,
  placement: Pick<Placement, 'x' | 'y' | 'rot90' | 'flip'>
): Vec2 {
  const w = slab.widthMm;
  const h = slab.heightMm;
  const W = placement.rot90 ? h : w;
  const H = placement.rot90 ? w : h;
  let x = p.x - placement.x;
  let y = p.y - placement.y;
  switch (placement.flip) {
    case 1: x = W - x; break;
    case 2: x = W - x; y = H - y; break;
    case 3: y = H - y; break;
    default: break;
  }
  if (placement.rot90) {
    // 顺时针 90° 的逆变换
    const nx = y;
    const ny = h - x;
    x = nx;
    y = ny;
  }
  return { x, y };
}

/** 排版后板在展开图中的外接尺寸 */
export function placedSize(slab: Slab, rot90: boolean): { w: number; h: number } {
  return rot90 ? { w: slab.heightMm, h: slab.widthMm } : { w: slab.widthMm, h: slab.heightMm };
}

/** 两个格子之间的接缝方向与邻接关系，按阅读顺序返回 */
export function cellNeighborKey(a: GridCell, b: GridCell): { kind: 'vertical' | 'horizontal'; at: number } | null {
  // 竖直缝：左右相邻
  if (a.row === b.row && Math.abs(a.x + a.width - b.x) < 1e-6) {
    return { kind: 'vertical', at: b.x };
  }
  if (a.row === b.row && Math.abs(b.x + b.width - a.x) < 1e-6) {
    return { kind: 'vertical', at: a.x };
  }
  // 水平缝：上下相邻
  if (a.col === b.col && Math.abs(a.y + a.height - b.y) < 1e-6) {
    return { kind: 'horizontal', at: b.y };
  }
  if (a.col === b.col && Math.abs(b.y + b.height - a.y) < 1e-6) {
    return { kind: 'horizontal', at: a.y };
  }
  return null;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
