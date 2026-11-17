// 工作面照度伪彩俯视热力图(Canvas 2D),供报告与侧栏复用。
import type { IllumResult } from '../core/types.ts';
import { falseColor } from '../core/engine.ts';

export interface HeatmapOptions {
  width: number;
  height: number;
  scaleMax: number; // 0=自动取 max
  showContours?: boolean;
}

export function drawHeatmap(
  canvas: HTMLCanvasElement,
  result: IllumResult,
  roomW: number,
  roomD: number,
  opts: HeatmapOptions,
): number {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = opts.width * dpr;
  canvas.height = opts.height * dpr;
  canvas.style.width = `${opts.width}px`;
  canvas.style.height = `${opts.height}px`;
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0c0f16';
  ctx.fillRect(0, 0, opts.width, opts.height);

  const pad = 26;
  const cw = opts.width - pad * 2;
  const ch = opts.height - pad * 2;
  const { nx, nz, points } = result;
  const max = opts.scaleMax > 0 ? opts.scaleMax : Math.max(...points.map((p) => p.total), 1);

  const cellW = cw / nx;
  const cellH = ch / nz;
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const p = points[iz * nx + ix];
      const [r, g, b] = falseColor(p.total / max);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(pad + ix * cellW, pad + iz * cellH, Math.ceil(cellW) + 1, Math.ceil(cellH) + 1);
    }
  }

  // 房间边框
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(pad, pad, cw, ch);

  // 尺寸标注
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`${roomW.toFixed(1)} m`, opts.width / 2, opts.height - 6);
  ctx.save();
  ctx.translate(10, opts.height / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(`${roomD.toFixed(1)} m`, 0, 0);
  ctx.restore();

  // 色标
  const barW = 12;
  const barX = opts.width - pad + 8;
  const grad = ctx.createLinearGradient(0, pad, 0, pad + ch);
  for (let i = 0; i <= 10; i++) {
    const t = 1 - i / 10;
    const [r, g, b] = falseColor(t);
    grad.addColorStop(i / 10, `rgb(${r},${g},${b})`);
  }
  ctx.fillStyle = grad;
  ctx.fillRect(barX, pad, barW, ch);
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.textAlign = 'left';
  for (let i = 0; i <= 4; i++) {
    const t = 1 - i / 4;
    const y = pad + (i / 4) * ch;
    ctx.fillText(`${Math.round(t * max)}`, barX + barW + 3, y + 3);
  }
  ctx.save();
  ctx.translate(barX + barW + 3, pad - 8);
  ctx.fillText('lx', 0, 0);
  ctx.restore();

  if (opts.showContours) drawContours(ctx, result, pad, pad, cw, ch, max);
  return max;
}

function drawContours(
  ctx: CanvasRenderingContext2D,
  result: IllumResult,
  ox: number,
  oy: number,
  cw: number,
  ch: number,
  max: number,
): void {
  const { nx, nz, points } = result;
  const levels = [0.25, 0.5, 0.75];
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  for (const lv of levels) {
    const target = lv * max;
    ctx.beginPath();
    for (let iz = 0; iz < nz - 1; iz++) {
      for (let ix = 0; ix < nx - 1; ix++) {
        const a = points[iz * nx + ix].total;
        const b = points[iz * nx + ix + 1].total;
        const c = points[(iz + 1) * nx + ix + 1].total;
        const d = points[(iz + 1) * nx + ix].total;
        const corners = [a, b, c, d];
        // marching squares 简化:只画跨越等值线的边
        const code = corners.reduce((acc, v, i) => acc | (v > target ? 1 << i : 0), 0);
        if (code === 0 || code === 15) continue;
        const x = ox + (ix / nx) * cw;
        const y = oy + (iz / nz) * ch;
        const w = cw / nx, h = ch / nz;
        ctx.moveTo(x + w / 2, y);
        ctx.lineTo(x + w, y + h / 2);
        ctx.moveTo(x + w / 2, y + h);
        ctx.lineTo(x, y + h / 2);
      }
    }
    ctx.stroke();
  }
}
