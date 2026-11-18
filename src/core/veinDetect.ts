import type { Crack, DirectionField, EdgeSignature, Slab, Vec2, VeinFeatures } from './types';
import { v } from './geometry';

export interface DetectOptions {
  /** 最长边降采样到该像素数，控制检测耗时 */
  maxPx: number;
  /** 采样间距(mm) */
  sampleStepMm: number;
  /** 方向场网格间距(mm) */
  fieldCellMm: number;
  /** 裂纹判定：暗色连通脊线的最小长度，占板短边比例 */
  crackMinRatio: number;
}

export const DEFAULT_DETECT_OPTIONS: DetectOptions = {
  maxPx: 512,
  sampleStepMm: 20,
  fieldCellMm: 100,
  crackMinRatio: 0.12,
};

/**
 * 从一张正面照片提取纹路特征。
 * 图片在离屏 canvas 上降采样后做局部脊线检测（Hessian 近似），
 * 再投影到四条边生成接缝签名，并生成稀疏方向场。
 * 返回的几何量全部换算为毫米。
 */
export async function detectVeins(
  url: string,
  slabW: number,
  slabH: number,
  partial?: Partial<DetectOptions>,
): Promise<{ veins: VeinFeatures; cracks: Crack[]; pxW: number; pxH: number }> {
  const opts = { ...DEFAULT_DETECT_OPTIONS, ...partial };
  const img = await loadImage(url);
  const scale = Math.min(1, opts.maxPx / Math.max(img.width, img.height));
  const pxW = Math.max(8, Math.round(img.width * scale));
  const pxH = Math.max(8, Math.round(img.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = pxW;
  canvas.height = pxH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, pxW, pxH);
  const data = ctx.getImageData(0, 0, pxW, pxH).data;

  const gray = toGray(data, pxW, pxH);
  const { ridge, angle } = ridgeField(gray, pxW, pxH);
  const mmPerPxX = slabW / pxW;
  const mmPerPxY = slabH / pxH;

  const edges = {
    left: edgeSignature(ridge, angle, pxW, pxH, 'left', opts.sampleStepMm, mmPerPxX, mmPerPxY),
    right: edgeSignature(ridge, angle, pxW, pxH, 'right', opts.sampleStepMm, mmPerPxX, mmPerPxY),
    top: edgeSignature(ridge, angle, pxW, pxH, 'top', opts.sampleStepMm, mmPerPxX, mmPerPxY),
    bottom: edgeSignature(ridge, angle, pxW, pxH, 'bottom', opts.sampleStepMm, mmPerPxX, mmPerPxY),
  };
  const field = directionField(angle, ridge, pxW, pxH, slabW, slabH, opts.fieldCellMm);
  const cracks = detectCracks(ridge, pxW, pxH, opts.crackMinRatio);

  return {
    veins: { edges, field, version: 1 },
    cracks,
    pxW,
    pxH,
  };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

function toGray(data: Uint8ClampedArray, w: number, h: number): Float32Array {
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  return gray;
}

/**
 * 脊线强度与方向。大理石纹路为暗于底色的条带，
 * 用 3x3 Sobel 求二阶结构：对梯度做结构张量，主特征方向即纹路走向，
 * 横向二阶差分的负值作为脊线强度。
 */
function ridgeField(
  gray: Float32Array,
  w: number,
  h: number,
): { ridge: Float32Array; angle: Float32Array } {
  const ridge = new Float32Array(w * h);
  const angle = new Float32Array(w * h);
  const at = (x: number, y: number) => gray[y * w + x];

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const gx = (at(x + 1, y) - at(x - 1, y)) / 2;
      const gy = (at(x, y + 1) - at(x, y - 1)) / 2;
      // 结构张量
      const jxx = gx * gx;
      const jyy = gy * gy;
      const jxy = gx * gy;
      // 主方向（特征向量）
      const theta = 0.5 * Math.atan2(2 * jxy, jxx - jyy);
      angle[y * w + x] = theta;
      // 沿纹路垂直方向的二阶差分（暗纹 => 正的曲率）
      const nx = -Math.sin(theta);
      const ny = Math.cos(theta);
      const d2 =
        at(x + Math.round(nx), y + Math.round(ny)) -
        2 * at(x, y) +
        at(x - Math.round(nx), y - Math.round(ny));
      ridge[y * w + x] = -d2;
    }
  }
  // 自适应阈值：均值 + 1 倍标准差
  const valid = ridge.slice(w + 1, w * (h - 1) - 1);
  const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
  const sd = Math.sqrt(valid.reduce((a, b) => a + (b - mean) ** 2, 0) / valid.length);
  const threshold = mean + sd;
  for (let i = 0; i < ridge.length; i++) {
    ridge[i] = ridge[i] > threshold ? ridge[i] : 0;
  }
  return { ridge, angle };
}

function edgeSignature(
  ridge: Float32Array,
  angle: Float32Array,
  w: number,
  h: number,
  side: 'left' | 'right' | 'top' | 'bottom',
  stepMm: number,
  mmPerPxX: number,
  mmPerPxY: number,
): EdgeSignature {
  const horizontal = side === 'top' || side === 'bottom';
  const lengthPx = horizontal ? w : h;
  const lengthMm = horizontal ? w * mmPerPxX : h * mmPerPxY;
  const n = Math.max(4, Math.round(lengthMm / stepMm) + 1);
  const crossings: (number | null)[] = new Array(n).fill(null);
  const angles: (number | null)[] = new Array(n).fill(null);
  // 向板内扫描的最大深度（像素），取短边 15%
  const depthPx = Math.max(2, Math.round(Math.min(w, h) * 0.15));

  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const along = Math.min(lengthPx - 1, Math.round(t * (lengthPx - 1)));
    let bestDepth = -1;
    let bestStrength = 0;
    let bestAngle: number | null = null;

    for (let d = 1; d <= depthPx; d++) {
      let x = 0;
      let y = 0;
      if (side === 'left') {
        x = d;
        y = along;
      } else if (side === 'right') {
        x = w - 1 - d;
        y = along;
      } else if (side === 'top') {
        x = along;
        y = d;
      } else {
        x = along;
        y = h - 1 - d;
      }
      if (x < 0 || x >= w || y < 0 || y >= h) break;
      const strength = ridge[y * w + x];
      if (strength > bestStrength) {
        bestStrength = strength;
        bestDepth = d;
        bestAngle = angle[y * w + x];
      }
    }
    if (bestDepth > 0) {
      crossings[i] = bestDepth * (horizontal ? mmPerPxY : mmPerPxX);
      angles[i] = bestAngle;
    }
  }
  return { step: lengthMm / (n - 1), length: lengthMm, crossings, angles };
}

function directionField(
  angle: Float32Array,
  ridge: Float32Array,
  pxW: number,
  pxH: number,
  slabW: number,
  slabH: number,
  cellMm: number,
): DirectionField {
  const cols = Math.max(1, Math.round(slabW / cellMm));
  const rows = Math.max(1, Math.round(slabH / cellMm));
  const vecs: (Vec2 | null)[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = Math.floor((c / cols) * pxW);
      const x1 = Math.floor(((c + 1) / cols) * pxW);
      const y0 = Math.floor((r / rows) * pxH);
      const y1 = Math.floor(((r + 1) / rows) * pxH);
      let sumX = 0;
      let sumY = 0;
      let count = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          if (ridge[y * pxW + x] > 0) {
            const a = angle[y * pxW + x];
            sumX += Math.cos(a);
            sumY += Math.sin(a);
            count++;
          }
        }
      }
      vecs.push(count > 0 ? v(sumX / count, sumY / count) : null);
    }
  }
  return { cols, rows, cellW: slabW / cols, cellH: slabH / rows, vecs };
}

/**
 * 裂纹初判：在脊线图上找细长、高对比、近直线的连通段。
 * 这是给师傅的提示性结果，UI 允许人工增删；返回归一化折线。
 */
function detectCracks(
  ridge: Float32Array,
  w: number,
  h: number,
  minRatio: number,
): Crack[] {
  const visited = new Uint8Array(w * h);
  const minLen = minRatio * Math.min(w, h);
  const cracks: Crack[] = [];
  let crackId = 0;

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      if (ridge[idx] === 0 || visited[idx]) continue;
      // 8 邻域连通域
      const stack = [[x, y]];
      const pts: Vec2[] = [];
      visited[idx] = 1;
      while (stack.length) {
        const [cx, cy] = stack.pop()!;
        pts.push(v(cx, cy));
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const ni = ny * w + nx;
            if (!visited[ni] && ridge[ni] > 0) {
              visited[ni] = 1;
              stack.push([nx, ny]);
            }
          }
        }
      }
      if (pts.length < minLen) continue;
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      const span = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      // 细长比：包围盒跨度 / 等效半径，裂纹应细长
      const thinness = span / Math.sqrt(pts.length);
      if (thinness < 3) continue;
      const endpoints = farthestPair(pts);
      cracks.push({
        id: `crack-${crackId++}`,
        points: endpoints.map((p) => ({ x: p.x / w, y: p.y / h })),
      });
    }
  }
  return cracks;
}

function farthestPair(pts: Vec2[]): Vec2[] {
  let best = 0;
  let pair: Vec2[] = [pts[0], pts[0]];
  // 连通域点数已被 minLen 约束，O(n²) 可接受
  for (let i = 0; i < pts.length; i += 3) {
    for (let j = i + 1; j < pts.length; j += 3) {
      const d = (pts[i].x - pts[j].x) ** 2 + (pts[i].y - pts[j].y) ** 2;
      if (d > best) {
        best = d;
        pair = [pts[i], pts[j]];
      }
    }
  }
  return pair;
}

/** 人工修正裂纹后，可只重建裂纹而不动纹路特征 */
export function withCracks(slab: Slab, cracks: Crack[]): Slab {
  return { ...slab, cracks };
}
