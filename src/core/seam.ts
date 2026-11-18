import type { EdgeSignature, Placement, VeinFeatures } from './types';
import type { EdgeName } from './geometry';
import { edgeOnPlacedSide, orientVector, v } from './geometry';

/** 取一条边在指定朝向、指定摆放侧上的签名（沿 placed 侧方向重采样） */
export function placedEdgeSignature(
  veins: VeinFeatures,
  slabW: number,
  slabH: number,
  rot: Placement['rot'],
  flipX: boolean,
  side: EdgeName,
  targetStep: number,
): EdgeSignature {
  const map = edgeOnPlacedSide(slabW, slabH, { rot, flipX }, side);
  const src = veins.edges[map.edge];
  const n = Math.max(2, Math.round(src.length / targetStep) + 1);
  const crossings: (number | null)[] = new Array(n);
  const angles: (number | null)[] = new Array(n);

  for (let i = 0; i < n; i++) {
    const tPlaced = i / (n - 1);
    const tSrc = map.reversed ? 1 - tPlaced : tPlaced;
    crossings[i] = sampleAt(src.crossings, tSrc);
    const a = sampleAt(src.angles, tSrc);
    if (a === null) {
      angles[i] = null;
    } else {
      const d = orientVector(v(Math.cos(a), Math.sin(a)), { rot, flipX });
      angles[i] = Math.atan2(d.y, d.x);
    }
  }
  return { step: src.length / (n - 1), length: src.length, crossings, angles };
}

function sampleAt(arr: (number | null)[], t: number): number | null {
  const pos = t * (arr.length - 1);
  const i = Math.floor(pos);
  if (i < 0 || i >= arr.length) return null;
  if (i === arr.length - 1) return arr[i];
  const f = pos - i;
  const a = arr[i];
  const b = arr[i + 1];
  if (a === null || b === null) return null;
  return a + (b - a) * f;
}

/** 沿一条边签名按归一化位置 [0,1] 取最近采样点，null 段（真正无纹路）保持 null */
export function sampleAlong(arr: (number | null)[], t: number): number | null {
  if (arr.length === 0) return null;
  const idx = Math.round(t * (arr.length - 1));
  const i = Math.min(arr.length - 1, Math.max(0, idx));
  return arr[i];
}

export interface SeamInfo {
  axis: 'vertical' | 'horizontal';
  /** 接缝在安装面中的固定坐标 */
  at: number;
  length: number;
  placements: [string, string];
  /** 逐采样点错位 mm，null = 至少一侧无纹路 */
  offsets: (number | null)[];
  angleDeltas: (number | null)[];
  avgOffset: number;
  maxOffset: number;
  avgAngleDelta: number;
  /** 有效对纹点占比 */
  coverage: number;
  pass: boolean;
  /** 加权代价，越小越好 */
  cost: number;
}

export interface SeamTolerance {
  maxOffsetMm: number;
}

/**
 * 评估两个相邻摆放之间的接缝。
 * 竖缝：左板 right 边 vs 右板 left 边；横缝：上板 bottom 边 vs 下板 top 边。
 * crossing 存的是纹路交点沿边法线深入板内的距离，
 * 同一条纹路在缝两侧深度应一致 → 深度差即视觉错位量。
 */
export function scoreSeam(
  left: { placement: Placement; veins: VeinFeatures; slabW: number; slabH: number },
  right: { placement: Placement; veins: VeinFeatures; slabW: number; slabH: number },
  axis: 'vertical' | 'horizontal',
  tol: SeamTolerance,
  stepMm: number,
): SeamInfo {
  const sideA: EdgeName = axis === 'vertical' ? 'right' : 'bottom';
  const sideB: EdgeName = axis === 'vertical' ? 'left' : 'top';
  const sigA = placedEdgeSignature(
    left.veins,
    left.slabW,
    left.slabH,
    left.placement.rot,
    left.placement.flipX,
    sideA,
    stepMm,
  );
  const sigB = placedEdgeSignature(
    right.veins,
    right.slabW,
    right.slabH,
    right.placement.rot,
    right.placement.flipX,
    sideB,
    stepMm,
  );

  const length = Math.min(sigA.length, sigB.length);
  // 两侧按同一物理间距、同一起点取相同数量的采样点，
  // 使同索引对应同一物理位置，消除旋转后网格错位造成的假性错位
  const n = Math.max(4, Math.floor(length / stepMm) + 1);
  const offsets: (number | null)[] = new Array(n).fill(null);
  const angleDeltas: (number | null)[] = new Array(n).fill(null);
  let sum = 0;
  let max = 0;
  let angleSum = 0;
  let valid = 0;
  let mismatch = 0;
  // 错配惩罚：一侧有纹路另一侧没有，按半个采样间距计错位
  const mismatchPenalty = stepMm * 0.5;

  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const a = sampleAlong(sigA.crossings, t);
    const b = sampleAlong(sigB.crossings, t);
    const aa = sampleAlong(sigA.angles, t);
    const ab = sampleAlong(sigB.angles, t);
    if (a !== null && b !== null) {
      const off = Math.abs(a - b);
      offsets[i] = off;
      sum += off;
      max = Math.max(max, off);
      valid++;
      if (aa !== null && ab !== null) {
        let d = Math.abs(aa - ab) % Math.PI;
        if (d > Math.PI / 2) d = Math.PI - d;
        angleDeltas[i] = d;
        angleSum += d;
      }
    } else if (a !== null || b !== null) {
      // 单侧无值：仅当另一侧纹路“很厚”（非边缘过渡）才算错配，
      // 纹路起止处的 null 边界不重罚
      const present = a ?? b;
      if (present !== null && present > stepMm * 0.4) {
        mismatch++;
        max = Math.max(max, mismatchPenalty);
      }
    }
  }

  const avgOffset = valid ? sum / valid : 0;
  const avgAngleDelta = valid ? angleSum / valid : 0;
  const coverage = n ? valid / n : 0;
  const at =
    axis === 'vertical'
      ? left.placement.x + left.placement.width
      : left.placement.y + left.placement.height;

  // 硬约束不满足时代价急剧上升，但保留相对排序，供求解器优先选择“最不差”的
  const hardPenalty = max > tol.maxOffsetMm ? 1000 + (max - tol.maxOffsetMm) * 50 : 0;
  const cost =
    avgOffset * 30 +
    max * 12 +
    avgAngleDelta * 40 +
    (1 - coverage) * 10 +
    mismatch * 8 +
    hardPenalty;

  return {
    axis,
    at,
    length,
    placements: [left.placement.id, right.placement.id],
    offsets,
    angleDeltas,
    avgOffset,
    maxOffset: max,
    avgAngleDelta,
    coverage,
    pass: max <= tol.maxOffsetMm,
    cost,
  };
}
