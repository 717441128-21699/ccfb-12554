// 纹路特征提取与接缝匹配
// 思路：对每张板的四条边分别取一条窄带，得到沿边的亮度条带描述子 + 纹路穿越点，
// 两条对缝边在不同纵向偏移下做对齐，求最优偏移与错位量（毫米）。

import type { Slab } from './types';

export type SideName = 'L' | 'R' | 'T' | 'B';

export interface Crossing {
  /** 沿边方向的归一化位置 0..1 */
  t: number;
  /** 纹路方向（弧度，相对边的法线方向参考系） */
  angle: number;
  strength: number;
}

export interface EdgeProfile {
  side: SideName;
  /** 沿边长度方向的归一化亮度条带（已做对比度拉伸），长度固定 N */
  strip: Float32Array;
  /** 条带每个采样点的梯度幅值 */
  grad: Float32Array;
  crossings: Crossing[];
  /** 该边对应的物理长度（毫米） */
  lengthMm: number;
}

export interface VeinFeatures {
  slabId: string;
  edges: Record<SideName, EdgeProfile>;
}

const STRIP_N = 128;
const SEARCH_RANGE_MM = 40;
const TOLERANCE_MM = 3;

const featureCache = new Map<string, VeinFeatures>();
const imageCache = new Map<string, HTMLCanvasElement>();

export async function loadSlabImage(slab: Slab): Promise<HTMLCanvasElement> {
  const hit = imageCache.get(slab.id);
  if (hit) return hit;
  const img = new Image();
  img.src = slab.frontDataUrl;
  await img.decode();
  const maxSide = 512;
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const cw = Math.max(1, Math.round(img.width * scale));
  const ch = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, cw, ch);
  imageCache.set(slab.id, canvas);
  slab.imageW = cw;
  slab.imageH = ch;
  return canvas;
}

function toGrayscale(canvas: HTMLCanvasElement): Float32Array {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const n = canvas.width * canvas.height;
  const gray = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  // 百分位对比度拉伸，消除拍照曝光差异
  const sorted = Float32Array.from(gray).sort();
  const lo = sorted[Math.floor(n * 0.02)];
  const hi = sorted[Math.floor(n * 0.98)];
  const span = Math.max(1, hi - lo);
  for (let i = 0; i < n; i++) gray[i] = Math.min(1, Math.max(0, (gray[i] - lo) / span));
  return gray;
}

function sampleStrip(
  gray: Float32Array, w: number, h: number, side: SideName
): { strip: Float32Array; grad: Float32Array; crossings: Crossing[]; lengthMm: number } {
  const band = Math.max(3, Math.round(Math.min(w, h) * 0.06));
  const strip = new Float32Array(STRIP_N);
  const vertical = side === 'L' || side === 'R';
  const edgeLen = vertical ? h : w;

  for (let i = 0; i < STRIP_N; i++) {
    const pos = (i + 0.5) / STRIP_N * edgeLen;
    let sum = 0;
    let cnt = 0;
    for (let b = 0; b < band; b++) {
      let x: number, y: number;
      if (side === 'L') { x = b; y = pos; }
      else if (side === 'R') { x = w - 1 - b; y = pos; }
      else if (side === 'T') { x = pos; y = b; }
      else { x = pos; y = h - 1 - b; }
      x = Math.min(w - 1, Math.max(0, Math.floor(x)));
      y = Math.min(h - 1, Math.max(0, Math.floor(y)));
      sum += gray[y * w + x];
      cnt++;
    }
    strip[i] = sum / cnt;
  }

  // 沿边梯度
  const grad = new Float32Array(STRIP_N);
  for (let i = 1; i < STRIP_N - 1; i++) {
    grad[i] = (strip[i + 1] - strip[i - 1]) * 0.5;
  }
  grad[0] = strip[1] - strip[0];
  grad[STRIP_N - 1] = strip[STRIP_N - 1] - strip[STRIP_N - 2];

  // 强梯度局部峰值 = 纹路穿越边的位置
  const crossings: Crossing[] = [];
  const threshold = 0.12;
  for (let i = 2; i < STRIP_N - 2; i++) {
    const g = Math.abs(grad[i]);
    if (g < threshold) continue;
    if (g >= Math.abs(grad[i - 1]) && g >= Math.abs(grad[i + 1]) &&
        g >= Math.abs(grad[i - 2]) && g >= Math.abs(grad[i + 2])) {
      crossings.push({ t: (i + 0.5) / STRIP_N, angle: 0, strength: g });
    }
  }
  // 限制数量，避免噪声
  crossings.sort((a, b) => b.strength - a.strength);
  const kept = crossings.slice(0, 12);
  kept.sort((a, b) => a.t - b.t);

  return { strip, grad, crossings: kept, lengthMm: edgeLen };
}

export async function extractFeatures(slab: Slab): Promise<VeinFeatures> {
  const cached = featureCache.get(slab.id);
  if (cached) return cached;
  const canvas = await loadSlabImage(slab);
  const gray = toGrayscale(canvas);
  const build = (side: SideName): EdgeProfile => {
    const r = sampleStrip(gray, canvas.width, canvas.height, side);
    // 像素长度换算毫米（图像等比缩放，x/y 的 mm/px 相同）
    const mmPerPx = slab.widthMm / canvas.width;
    return {
      side,
      strip: r.strip,
      grad: r.grad,
      crossings: r.crossings,
      lengthMm: r.lengthMm * mmPerPx
    };
  };
  const features: VeinFeatures = {
    slabId: slab.id,
    edges: { L: build('L'), R: build('R'), T: build('T'), B: build('B') }
  };
  featureCache.set(slab.id, features);
  return features;
}

/** 排版姿态下，指定朝向的边对应板原始哪条边，以及采样方向是否反转 */
export function facingSide(
  rot90: boolean, flip: number, wanted: SideName
): { side: SideName; reversed: boolean } {
  // 先做顺时针 90°
  let map: Record<SideName, SideName>;
  if (rot90) map = { L: 'B', R: 'T', T: 'L', B: 'R' };
  else map = { L: 'L', R: 'R', T: 'T', B: 'B' };
  let rev: Record<SideName, boolean>;
  if (rot90) rev = { L: false, R: false, T: true, B: true };
  else rev = { L: false, R: false, T: false, B: false };

  const afterRot = map[wanted];
  const revRot = rev[wanted];

  // 再做 flip
  let side = afterRot;
  let reversed = revRot;
  switch (flip) {
    case 1: // 水平镜像：左右互换，上下边方向反转
      if (wanted === 'L') side = map.R;
      else if (wanted === 'R') side = map.L;
      else reversed = !revRot;
      break;
    case 2: // 180°
      if (wanted === 'L') side = map.R;
      else if (wanted === 'R') side = map.L;
      else if (wanted === 'T') side = map.B;
      else side = map.T;
      reversed = !revRot;
      break;
    case 3: // 垂直镜像：上下互换，左右边方向反转
      if (wanted === 'T') side = map.B;
      else if (wanted === 'B') side = map.T;
      else reversed = !revRot;
      break;
    default: break;
  }
  return { side, reversed };
}

export interface SeamMatch {
  /** B 相对 A 沿接缝方向的最佳偏移（毫米），绝对值即纹路错动量 */
  offsetMm: number;
  /** 综合代价 0..1，越小越顺 */
  cost: number;
  stripCost: number;
  /** 纹路穿越点平均错位（毫米） */
  meanDiffMm: number;
  maxDiffMm: number;
  pairedCrossings: number;
  withinTolerance: boolean;
}

/**
 * 评估两条对缝边的匹配度。
 * edgeA / edgeB 已经是姿态变换后面向接缝的边（reversed 已处理）。
 */
export function matchEdges(edgeA: EdgeProfile, edgeB: EdgeProfile): SeamMatch {
  const lenMm = Math.min(edgeA.lengthMm, edgeB.lengthMm);
  const mmPerSample = lenMm / STRIP_N;
  const maxShiftSamples = Math.round(SEARCH_RANGE_MM / mmPerSample);

  let best: SeamMatch | null = null;

  for (let s = -maxShiftSamples; s <= maxShiftSamples; s++) {
    let mad = 0;
    let cnt = 0;
    for (let i = 0; i < STRIP_N; i++) {
      const j = i + s;
      if (j < 0 || j >= STRIP_N) continue;
      mad += Math.abs(edgeA.strip[i] - edgeB.strip[j]);
      cnt++;
    }
    if (cnt === 0) continue;
    const stripCost = mad / cnt;

    // 穿越点配对
    let diffSum = 0;
    let maxDiff = 0;
    let paired = 0;
    const usedB = new Set<number>();
    const shiftMm = s * mmPerSample;
    for (const ca of edgeA.crossings) {
      let bestJ = -1;
      let bestD = Infinity;
      for (let k = 0; k < edgeB.crossings.length; k++) {
        if (usedB.has(k)) continue;
        const cb = edgeB.crossings[k];
        const d = Math.abs((ca.t - cb.t) * lenMm + shiftMm);
        if (d < bestD) { bestD = d; bestJ = k; }
      }
      if (bestJ >= 0 && bestD <= 15) {
        usedB.add(bestJ);
        diffSum += bestD;
        maxDiff = Math.max(maxDiff, bestD);
        paired++;
      }
    }
    const meanDiff = paired > 0 ? diffSum / paired : 0;
    const unpairedPenalty = (edgeA.crossings.length + edgeB.crossings.length - 2 * paired) * 0.08;
    const crossingCost = paired > 0 ? meanDiff / 15 : 0.2;
    const shiftReg = Math.abs(shiftMm) / SEARCH_RANGE_MM * 0.1;
    const cost = Math.min(1, 0.45 * stripCost + 0.45 * crossingCost + unpairedPenalty + shiftReg);

    if (!best || cost < best.cost) {
      best = {
        offsetMm: shiftMm,
        cost,
        stripCost,
        meanDiffMm: meanDiff,
        maxDiffMm: maxDiff,
        pairedCrossings: paired,
        withinTolerance: false
      };
    }
  }

  const result = best ?? {
    offsetMm: 0, cost: 1, stripCost: 1, meanDiffMm: 0, maxDiffMm: 0,
    pairedCrossings: 0, withinTolerance: false
  };
  // 容忍规则：最佳偏移与穿越点错位均不超过 3mm；无明显纹路时按条带判定
  if (result.pairedCrossings > 0) {
    result.withinTolerance = Math.abs(result.offsetMm) <= TOLERANCE_MM && result.meanDiffMm <= TOLERANCE_MM;
  } else {
    result.withinTolerance = Math.abs(result.offsetMm) <= TOLERANCE_MM && result.stripCost <= 0.25;
  }
  return result;
}

export function getEdge(features: VeinFeatures, rot90: boolean, flip: number, wanted: SideName): EdgeProfile {
  const { side, reversed } = facingSide(rot90, flip, wanted);
  const src = features.edges[side];
  if (!reversed) return src;
  return {
    side: src.side,
    strip: Float32Array.from(src.strip).reverse(),
    grad: Float32Array.from(src.grad).reverse(),
    crossings: src.crossings.map((c) => ({ ...c, t: 1 - c.t })).sort((a, b) => a.t - b.t),
    lengthMm: src.lengthMm
  };
}

export const TOLERANCE = TOLERANCE_MM;
