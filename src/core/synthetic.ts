import type { Crack, EdgeSignature, Slab, Vec2, VeinFeatures } from './types';
import { v } from './geometry';

export interface SyntheticOptions {
  /** 每片板上的纹路条数 */
  veinCount: number;
  /** 图像像素分辨率（最长边） */
  px: number;
  /** 边签名采样间距 mm */
  stepMm: number;
  /** 方向场网格 mm */
  cellMm: number;
  /** 随机种子 */
  seed: number;
}

const DEFAULT_SYNTH: SyntheticOptions = {
  veinCount: 7,
  px: 480,
  stepMm: 20,
  cellMm: 100,
  seed: 77,
};

interface VeinDef {
  baseY: number;
  amp: number;
  freq: number;
  phase: number;
  /** 相位抖动(mm)：同荒料一致、异块不同，决定接缝处纹路沿边位置差异 */
  phaseJitter: number;
}

interface VeinNetwork {
  veins: VeinDef[];
  blockWidth: number;
  height: number;
}

/**
 * 生成同一荒料切出的 n 块板。
 * 纹路在荒料全局系中生成，切片后相邻板天然对纹；
 * 偶数 seq 的片渲染时水平镜像，模拟书本式对开（现场翻板铺贴）。
 */
export function makeSyntheticBlock(
  blockId: string,
  count: number,
  slabW: number,
  slabH: number,
  partial?: Partial<SyntheticOptions>,
): Slab[] {
  const opts = { ...DEFAULT_SYNTH, ...partial };
  const network = generateNetwork(slabW * count, slabH, opts);
  const polylines = networkPolylines(network);
  const slabs: Slab[] = [];

  for (let seq = 0; seq < count; seq++) {
    const originX = seq * slabW;
    const local = polylines
      .map((line) => clipToSlice(line, originX, slabW, slabH))
      .filter((line) => line.length >= 2)
      .map((line) => line.map((p) => v(p.x - originX, p.y)));

    const flipForBookmatch = seq % 2 === 1;
    const renderLines = flipForBookmatch
      ? local.map((line) => line.map((p) => v(slabW - p.x, p.y)))
      : local;
    const url = renderMarble(renderLines, slabW, slabH, opts.px, opts.seed + seq);
    const veins = buildFeatures(network, seq, slabW, slabH, opts);
    const cracks = seq === 0 ? [sampleCrack(slabW, slabH, opts.seed)] : [];

    slabs.push({
      id: `${blockId}-s${seq}`,
      blockId,
      seq,
      width: slabW,
      height: slabH,
      images: { front: { url, width: opts.px, height: Math.round((opts.px * slabH) / slabW) } },
      cracks,
      veins,
      note: seq === 0 ? '检测到一条裂纹，排版需避让' : undefined,
    });
  }
  return slabs;
}

/**
 * 横向主纹：纹路沿板宽方向流动，在荒料的每个切片竖缝（板左右边）处连续。
 * 这对应背景墙大板竖排铺贴时最常见的“左右连纹”场景。
 * 纹路用参数方程定义，签名可解析计算，避免折线裁剪丢失深度。
 */
function generateNetwork(blockW: number, h: number, opts: SyntheticOptions): VeinNetwork {
  const rng = mulberry32(opts.seed);
  const veins: VeinDef[] = [];
  for (let k = 0; k < opts.veinCount; k++) {
    veins.push({
      baseY: (h * (k + 0.5)) / opts.veinCount + (rng() - 0.5) * h * 0.06,
      amp: 18 + rng() * 45,
      freq: 1.2 + rng() * 2.5,
      phase: rng() * Math.PI * 2,
      phaseJitter: rng() * 24,
    });
  }
  return { veins, blockWidth: blockW, height: h };
}

/** 纹路在全局 x 处的 y 坐标（含相位抖动） */
function veinY(vd: VeinDef, x: number, blockW: number): number {
  const t = x / blockW;
  return (
    vd.baseY +
    vd.phaseJitter +
    Math.sin(t * Math.PI * vd.freq + vd.phase) * vd.amp +
    Math.sin(t * Math.PI * vd.freq * 2.7 + vd.phase * 0.3) * vd.amp * 0.3
  );
}

/** 纹路切线角度（图像系，弧度） */
function veinAngle(vd: VeinDef, x: number, blockW: number): number {
  const t = x / blockW;
  const dy =
    (Math.PI * vd.freq * vd.amp / blockW) * Math.cos(t * Math.PI * vd.freq + vd.phase) +
    (Math.PI * vd.freq * 2.7 * vd.amp * 0.3 / blockW) *
      Math.cos(t * Math.PI * vd.freq * 2.7 + vd.phase * 0.3);
  return Math.atan2(dy, 1);
}

/** 把参数纹路离散为折线，供渲染与裂纹检测使用 */
function networkPolylines(network: VeinNetwork): Vec2[][] {
  const seg = 28;
  return network.veins.map((vd) => {
    const line: Vec2[] = [];
    for (let i = 0; i <= seg; i++) {
      const x = (i / seg) * network.blockWidth;
      line.push(v(x, veinY(vd, x, network.blockWidth)));
    }
    return line;
  });
}

/** 折线与矩形切片求交，保留内部段，并把边界交点吸附到切片边框 */
function clipToSlice(line: Vec2[], x0: number, w: number, h: number): Vec2[] {
  const x1 = x0 + w;
  const out: Vec2[] = [];
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    const seg = clipSegment(a, b, x0, x1, 0, h);
    if (seg) {
      const snapped = seg.map((p) => ({
        x: Math.abs(p.x - x0) < 1e-6 ? x0 : Math.abs(p.x - x1) < 1e-6 ? x1 : p.x,
        y: Math.abs(p.y) < 1e-6 ? 0 : Math.abs(p.y - h) < 1e-6 ? h : p.y,
      })) as [Vec2, Vec2];
      if (out.length === 0) out.push(snapped[0]);
      else if (dist(out[out.length - 1], snapped[0]) > 1e-6) out.push(snapped[0]);
      out.push(snapped[1]);
    }
  }
  return out;
}

function clipSegment(a: Vec2, b: Vec2, x0: number, x1: number, y0: number, y1: number): [Vec2, Vec2] | null {
  let { x: ax, y: ay } = a;
  let { x: bx, y: by } = b;
  const code = (x: number, y: number) =>
    (x < x0 ? 1 : 0) | (x > x1 ? 2 : 0) | (y < y0 ? 4 : 0) | (y > y1 ? 8 : 0);
  let ca = code(ax, ay);
  let cb = code(bx, by);
  for (let guard = 0; guard < 8 && (ca | cb) !== 0; guard++) {
    if ((ca & cb) !== 0) return null;
    const c = ca || cb;
    let x = 0;
    let y = 0;
    if (c & 8) {
      x = ax + ((bx - ax) * (y1 - ay)) / (by - ay);
      y = y1;
    } else if (c & 4) {
      x = ax + ((bx - ax) * (y0 - ay)) / (by - ay);
      y = y0;
    } else if (c & 2) {
      y = ay + ((by - ay) * (x1 - ax)) / (bx - ax);
      x = x1;
    } else {
      y = ay + ((by - ay) * (x0 - ax)) / (bx - ax);
      x = x0;
    }
    if (c === ca) {
      ax = x;
      ay = y;
      ca = code(ax, ay);
    } else {
      bx = x;
      by = y;
      cb = code(bx, by);
    }
  }
  return [v(ax, ay), v(bx, by)];
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 由参数纹路解析生成边签名与方向场（同荒料切片在接缝处严格对纹） */
function buildFeatures(
  network: VeinNetwork,
  seq: number,
  w: number,
  h: number,
  opts: SyntheticOptions,
): VeinFeatures {
  const blockW = network.blockWidth;
  const originX = seq * w;
  const verticalSide = (fromLeft: boolean): EdgeSignature => {
    const length = h;
    const n = Math.round(length / opts.stepMm) + 1;
    const crossings: (number | null)[] = new Array(n).fill(null);
    const angles: (number | null)[] = new Array(n).fill(null);
    const globalX = fromLeft ? originX : originX + w;
    // 沿纹路向内一个采样步长采样，与真实检测的边内扫描尺度一致，
    // 避免长距离探针把纹路斜率放大成假性错位
    const probeMm = opts.stepMm;
    for (const vd of network.veins) {
      const y = veinY(vd, globalX, blockW);
      if (y < 0 || y > h) continue;
      const idx = Math.round((y / length) * (n - 1));
      if (idx < 0 || idx >= n) continue;
      const inwardX = fromLeft ? globalX + probeMm : globalX - probeMm;
      const yInward = veinY(vd, inwardX, blockW);
      // crossing = 纹路在 probe 深度处相对边沿的法向偏移，
      // 同一条纹路在缝两侧的偏移量相同 → 对纹错位为 0
      const depth = Math.abs(yInward - y);
      if (crossings[idx] === null || depth < (crossings[idx] as number)) {
        crossings[idx] = Math.max(0.5, depth);
        angles[idx] = veinAngle(vd, globalX, blockW);
      }
    }
    interpolateNulls(crossings);
    interpolateNulls(angles);
    return { step: length / (n - 1), length, crossings, angles };
  };

  const horizontalSide = (fromTop: boolean): EdgeSignature => {
    const length = w;
    const n = Math.round(length / opts.stepMm) + 1;
    const crossings: (number | null)[] = new Array(n).fill(null);
    const angles: (number | null)[] = new Array(n).fill(null);
    const edgeY = fromTop ? 0 : h;
    for (let i = 0; i < n; i++) {
      const localX = (i / (n - 1)) * w;
      const globalX = originX + localX;
      // 找与该边相交的纹路
      for (const vd of network.veins) {
        const y = veinY(vd, globalX, blockW);
        const hits = fromTop ? y <= edgeY + 0.5 : y >= edgeY - 0.5;
        if (!hits) continue;
        const depth = fromTop ? y : h - y;
        if (crossings[i] === null || depth < (crossings[i] as number)) {
          crossings[i] = Math.max(0.5, depth);
          angles[i] = veinAngle(vd, globalX, blockW);
        }
      }
    }
    return { step: length / (n - 1), length, crossings, angles };
  };

  // 方向场：在每个格子中心取最近纹路的切线方向
  const field = buildField(network, originX, w, h, opts.cellMm);

  return {
    edges: {
      left: verticalSide(true),
      right: verticalSide(false),
      top: horizontalSide(true),
      bottom: horizontalSide(false),
    },
    field,
    version: 1,
  };
}

function interpolateNulls(arr: (number | null)[]): void {
  let i = 0;
  while (i < arr.length) {
    if (arr[i] !== null) {
      i++;
      continue;
    }
    const start = i - 1;
    while (i < arr.length && arr[i] === null) i++;
    const end = i;
    if (start >= 0 && end < arr.length) {
      const a = arr[start] as number;
      const b = arr[end] as number;
      for (let k = start + 1; k < end; k++) {
        arr[k] = a + ((b - a) * (k - start)) / (end - start);
      }
    }
  }
}

function buildField(
  network: VeinNetwork,
  originX: number,
  w: number,
  h: number,
  cellMm: number,
) {
  const cols = Math.max(1, Math.round(w / cellMm));
  const rows = Math.max(1, Math.round(h / cellMm));
  const vecs: (Vec2 | null)[] = new Array(cols * rows).fill(null);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const localX = ((c + 0.5) / cols) * w;
      const cy = ((r + 0.5) / rows) * h;
      const globalX = originX + localX;
      let nearest: VeinDef | null = null;
      let nearestD = Infinity;
      for (const vd of network.veins) {
        const d = Math.abs(veinY(vd, globalX, network.blockWidth) - cy);
        if (d < nearestD) {
          nearestD = d;
          nearest = vd;
        }
      }
      // 距最近纹路超过一个网格半宽视为无纹路区
      if (nearest && nearestD <= cellMm) {
        const a = veinAngle(nearest, globalX, network.blockWidth);
        vecs[r * cols + c] = v(Math.cos(a), Math.sin(a));
      }
    }
  }
  return { cols, rows, cellW: w / cols, cellH: h / rows, vecs };
}

function sampleCrack(w: number, h: number, seed: number): Crack {
  const rng = mulberry32(seed + 999);
  const x = w * (0.2 + rng() * 0.2);
  const y0 = h * (0.15 + rng() * 0.2);
  const y1 = y0 + h * (0.25 + rng() * 0.2);
  return {
    id: 'crack-synth-0',
    points: [v(x / w, y0 / h), v((x + 20) / w, (y0 + (y1 - y0) * 0.5) / h), v((x + 8) / w, y1 / h)],
  };
}

/** 离屏 canvas 渲染大理石质感底图 + 纹路 */
function renderMarble(lines: Vec2[][], w: number, h: number, px: number, seed: number): string {
  const ratio = Math.min(px / w, px / h);
  const cw = Math.round(w * ratio);
  const ch = Math.round(h * ratio);
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d')!;
  const rng = mulberry32(seed);

  const grad = ctx.createLinearGradient(0, 0, cw, ch);
  grad.addColorStop(0, '#f4f1ea');
  grad.addColorStop(0.5, '#e9e4d8');
  grad.addColorStop(1, '#f6f3ec');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, cw, ch);

  // 云雾底噪
  for (let i = 0; i < 900; i++) {
    const x = rng() * cw;
    const y = rng() * ch;
    const r = 4 + rng() * 22;
    ctx.fillStyle = `rgba(180,170,155,${0.02 + rng() * 0.04})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const line of lines) {
    ctx.beginPath();
    line.forEach((p, i) => {
      const x = p.x * ratio;
      const y = p.y * ratio;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = 'rgba(90,86,80,0.55)';
    ctx.lineWidth = 2.2;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(140,134,124,0.35)';
    ctx.lineWidth = 5;
    ctx.stroke();
  }
  return canvas.toDataURL('image/png');
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
