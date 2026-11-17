// 配光曲线极坐标图(Canvas 2D):0° 在底部(灯具正下方),左右镜像成完整曲线。
import type { IESData } from '../core/types.ts';
import { candelaAt } from '../core/photometry.ts';

export interface PolarOptions {
  width: number;
  height: number;
  /** 标注的参考水平角(度),用于展示非轴对称灯具 */
  planes?: number[];
}

const PLANE_COLORS = ['#e8503a', '#2f7ed8', '#28a26a', '#f0a020'];

export function drawPolarCurve(
  canvas: HTMLCanvasElement,
  ies: IESData,
  opts: PolarOptions = { width: 320, height: 320 },
): void {
  const dpr = window.devicePixelRatio || 1;
  const W = opts.width;
  const H = opts.height;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const cx = W / 2;
  const cy = H / 2 + 6;
  const R = Math.min(W, H) / 2 - 34;

  // 背景
  ctx.fillStyle = '#10141c';
  ctx.fillRect(0, 0, W, H);

  // 角度网格(每 15°)与径向环
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 1;
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';

  for (let deg = 0; deg <= 180; deg += 15) {
    const a = (deg * Math.PI) / 180;
    const x = cx + Math.sin(a) * R;
    const y = cy + Math.cos(a) * R;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(x, y);
    ctx.stroke();
    // 角度标注只在右侧
    if (deg > 0 && deg < 180) {
      ctx.fillText(`${deg}°`, cx + Math.sin(a) * (R + 14), cy + Math.cos(a) * (R + 14) + 3);
    }
  }
  ctx.fillText('0°', cx, cy + R + 16);
  ctx.fillText('180°', cx, cy - R - 6);

  // 峰值归一化
  let peak = 0;
  for (const row of ies.candela) for (const v of row) peak = Math.max(peak, v);
  if (peak <= 0) peak = 1;

  for (let ring = 1; ring <= 4; ring++) {
    const rr = (R * ring) / 4;
    ctx.beginPath();
    ctx.arc(cx, cy, rr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.textAlign = 'left';
    ctx.fillText(`${Math.round((peak * ring) / 4)}`, cx + 3, cy - rr - 2);
  }

  const planes = opts.planes ?? (ies.nHoriz === 1 ? [0] : pickPlanes(ies));

  planes.forEach((phi, pi) => {
    ctx.strokeStyle = PLANE_COLORS[pi % PLANE_COLORS.length];
    ctx.lineWidth = 2;
    ctx.beginPath();
    const N = 180;
    for (let i = 0; i <= N; i++) {
      const theta = (180 * i) / N;
      const I = candelaAt(ies, theta, phi, 0);
      const rr = (Math.max(0, I) / peak) * R;
      const a = (theta * Math.PI) / 180;
      const x = cx + Math.sin(a) * rr;
      const y = cy + Math.cos(a) * rr;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    // 左半镜像
    for (let i = N; i >= 0; i--) {
      const theta = (180 * i) / N;
      const I = candelaAt(ies, theta, phi, 0);
      const rr = (Math.max(0, I) / peak) * R;
      const a = (theta * Math.PI) / 180;
      const x = cx - Math.sin(a) * rr;
      const y = cy + Math.cos(a) * rr;
      ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
  });

  // 灯具符号
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.fill();

  // 图例
  ctx.textAlign = 'left';
  ctx.font = '11px system-ui, sans-serif';
  planes.forEach((phi, pi) => {
    const y = 16 + pi * 16;
    ctx.fillStyle = PLANE_COLORS[pi % PLANE_COLORS.length];
    ctx.fillRect(10, y - 8, 14, 4);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(`C${phi}° 平面 (峰值 ${Math.round(peak)} cd)`, 30, y - 3);
  });
}

function pickPlanes(ies: IESData): number[] {
  if (ies.nHoriz <= 2) return [ies.horizAngles[0]];
  const out: number[] = [];
  const span = ies.horizAngles[ies.nHoriz - 1];
  for (const target of [0, 45, 90]) {
    if (target <= span) {
      // 找最近的已测平面
      let best = ies.horizAngles[0];
      for (const h of ies.horizAngles) if (Math.abs(h - target) < Math.abs(best - target)) best = h;
      if (!out.includes(best)) out.push(best);
    }
  }
  return out.slice(0, 4);
}
