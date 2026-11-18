import type { Crack, Opening, Placement, Rect, Slab, Surface, Vec2 } from './types';
import {
  denormPolyline,
  expandRect,
  orientPoint,
  polylineRectDistance,
  rectsOverlap,
  v,
} from './geometry';

export interface OpeningViolation {
  openingId: string;
  placementId: string;
  distance: number;
}

/**
 * 校验一块板上的裂纹是否侵入任何开口的安全避让区。
 * 裂纹折线先从板自身坐标变换到安装面坐标，再与开口扩边矩形求距。
 */
export function checkCrackClearance(
  slab: Slab,
  placement: Placement,
  surface: Surface,
): OpeningViolation[] {
  if (slab.cracks.length === 0) return [];
  const w = slab.width;
  const h = slab.height;
  const out: OpeningViolation[] = [];

  for (const crack of slab.cracks) {
    const local = denormPolyline(crack.points, w, h).map((p) =>
      orientPoint(p, w, h, { rot: placement.rot, flipX: placement.flipX }),
    );
    const world = local.map((p) => v(p.x + placement.x, p.y + placement.y));
    for (const op of surface.openings) {
      const zone = expandRect(openingRect(op), op.margin);
      const dist = polylineRectDistance(world, zone);
      if (dist <= 0) {
        out.push({ openingId: op.id, placementId: placement.id, distance: dist });
      }
    }
  }
  return out;
}

export function openingRect(o: Opening): Rect {
  return { x: o.x, y: o.y, width: o.width, height: o.height };
}

/** 板之间不得重叠（留缝 gap 已在定位时计入，这里做硬校验） */
export function checkNoOverlap(placements: Placement[]): boolean {
  for (let i = 0; i < placements.length; i++) {
    for (let j = i + 1; j < placements.length; j++) {
      if (rectsOverlap(toRect(placements[i]), toRect(placements[j]))) return false;
    }
  }
  return true;
}

function toRect(p: Placement): Rect {
  return { x: p.x, y: p.y, width: p.width, height: p.height };
}

/**
 * 安装面被板覆盖的净面积（扣除开口），按扫描条带法精确计算。
 * 同时返回用板毛面积，供出材率统计。
 */
export function coverageArea(
  surface: Surface,
  placements: Placement[],
): { coveredNet: number; grossSlab: number; waste: number } {
  const grossSlab = placements.reduce((s, p) => s + p.width * p.height, 0);
  const covered = unionArea(placements.map(toRect), surface.width, surface.height);
  // 板覆盖区与开口重叠的部分不计入有效铺装
  const coveredOverOpenings = surface.openings.reduce(
    (s, o) => s + rectsIntersectArea(placements.map(toRect), o),
    0,
  );
  const coveredNet = Math.max(0, covered - coveredOverOpenings);
  return {
    coveredNet,
    grossSlab,
    waste: Math.max(0, grossSlab - coveredNet),
  };
}

function rectsIntersectArea(rects: Rect[], r: Rect): number {
  // 小数据量，直接对交集矩形再求并集
  const parts: Rect[] = [];
  for (const q of rects) {
    const x = Math.max(q.x, r.x);
    const y = Math.max(q.y, r.y);
    const rx = Math.min(q.x + q.width, r.x + r.width);
    const ry = Math.min(q.y + r.height, r.y + r.height);
    if (rx > x && ry > y) parts.push({ x, y, width: rx - x, height: ry - y });
  }
  return unionArea(parts, r.x + r.width, r.y + r.height);
}

/** 一组轴对齐矩形的并集面积（坐标裁剪到 [0,maxW]×[0,maxH]） */
export function unionArea(rects: Rect[], maxW: number, maxH: number): number {
  if (rects.length === 0) return 0;
  const xs = [0, maxW];
  const ys = [0, maxH];
  for (const r of rects) {
    xs.push(clamp(r.x, 0, maxW), clamp(r.x + r.width, 0, maxW));
    ys.push(clamp(r.y, 0, maxH), clamp(r.y + r.height, 0, maxH));
  }
  const ux = [...new Set(xs)].sort((a, b) => a - b);
  const uy = [...new Set(ys)].sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i < ux.length - 1; i++) {
    for (let j = 0; j < uy.length - 1; j++) {
      const cx = (ux[i] + ux[i + 1]) / 2;
      const cy = (uy[j] + uy[j + 1]) / 2;
      if (rects.some((r) => cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y + r.height)) {
        area += (ux[i + 1] - ux[i]) * (uy[j + 1] - uy[j]);
      }
    }
  }
  return area;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** 安装面需要铺装的净面积（扣除开口） */
export function surfaceNetArea(surface: Surface): number {
  const open = surface.openings.reduce((s, o) => s + o.width * o.height, 0);
  return surface.width * surface.height - open;
}

/** 把裂纹归一化坐标转安装面坐标，供渲染使用 */
export function crackWorldPolyline(
  crack: Crack,
  slab: Slab,
  placement: Placement,
): Vec2[] {
  return denormPolyline(crack.points, slab.width, slab.height)
    .map((p) => orientPoint(p, slab.width, slab.height, { rot: placement.rot, flipX: placement.flipX }))
    .map((p) => v(p.x + placement.x, p.y + p.y));
}
