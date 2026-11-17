// 照度报告 PDF 导出。中文用 Canvas 渲染为图片再嵌入(避开 jspdf 内置字体不含 CJK 的问题),
// 数值表格由 jspdf 排版,整体 A4 纵向。
import { jsPDF } from 'jspdf';
import type { IllumResult, Luminaire, PlacedLight, RoomConfig } from '../core/types.ts';
import { drawHeatmap } from './heatmap.ts';
import { percentileLux } from '../core/engine.ts';

export interface ReportInput {
  room: RoomConfig;
  lights: PlacedLight[];
  luminaires: Luminaire[];
  result: IllumResult;
  scaleMax: number;
  projectName: string;
}

function canvasToPng(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL('image/png');
}

/** 画一张中文信息表(Canvas),作为图片嵌入 PDF */
function infoTableCanvas(input: ReportInput): HTMLCanvasElement {
  const W = 760;
  const rows = [
    ['项目名称', input.projectName],
    ['房间尺寸 (m)', `${input.room.width} × ${input.room.depth} × ${input.room.height}`],
    ['工作面高度 (m)', String(input.room.workplaneHeight)],
    ['反射率 地/墙/顶', `${input.room.reflectance.floor} / ${input.room.reflectance.wall} / ${input.room.reflectance.ceiling}`],
    ['门窗数量', String(input.room.openings.length)],
    ['灯具总数', String(input.lights.length)],
    ['计算网格', `${input.result.nx} × ${input.result.nz} = ${input.result.metrics.pointCount} 点`],
    ['平均照度 (lx)', input.result.metrics.average.toFixed(1)],
    ['最小 / 最大照度 (lx)', `${input.result.metrics.min.toFixed(1)} / ${input.result.metrics.max.toFixed(1)}`],
    ['均匀度 U0 (最小/平均)', input.result.metrics.uniformityMin.toFixed(3)],
    ['均匀度 U1 (平均/最大)', input.result.metrics.uniformityAvg.toFixed(3)],
    ['统一眩光值 UGR', input.result.metrics.ugr.toFixed(1)],
    ['计算耗时 (ms)', input.result.elapsedMs.toFixed(1)],
  ];
  const rowH = 30;
  const H = rows.length * rowH + 20;
  const canvas = document.createElement('canvas');
  canvas.width = W * 2;
  canvas.height = H * 2;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(2, 2);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.font = '14px "Microsoft YaHei", "PingFang SC", sans-serif';
  rows.forEach(([k, v], i) => {
    const y = 22 + i * rowH;
    if (i % 2 === 0) {
      ctx.fillStyle = '#f2f4f8';
      ctx.fillRect(0, y - 18, W, rowH);
    }
    ctx.fillStyle = '#333';
    ctx.textAlign = 'left';
    ctx.fillText(k, 16, y);
    ctx.fillStyle = '#111';
    ctx.fillText(v, 250, y);
  });
  return canvas;
}

function lumTableCanvas(input: ReportInput): HTMLCanvasElement {
  const W = 760;
  const rowH = 28;
  const header = ['编号', '灯具型号', '位置 X/Y/Z (m)', '朝向°', '调光', '额定流明 lm'];
  const H = (input.lights.length + 1) * rowH + 16;
  const canvas = document.createElement('canvas');
  canvas.width = W * 2;
  canvas.height = H * 2;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(2, 2);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.font = '13px "Microsoft YaHei", "PingFang SC", sans-serif';
  ctx.fillStyle = '#1f3a5f';
  ctx.fillRect(0, 0, W, rowH);
  ctx.fillStyle = '#fff';
  header.forEach((h, i) => ctx.fillText(h, 12 + i * 125, 19));
  input.lights.forEach((light, i) => {
    const lum = input.luminaires.find((l) => l.id === light.luminaireId);
    const y = 19 + (i + 1) * rowH;
    if (i % 2 === 0) {
      ctx.fillStyle = '#f2f4f8';
      ctx.fillRect(0, y - 18, W, rowH);
    }
    ctx.fillStyle = '#222';
    const cells = [
      String(i + 1),
      lum?.ies.catalogNumber || lum?.ies.label || '-',
      light.position.map((v) => v.toFixed(2)).join(' / '),
      light.yawDeg.toFixed(0),
      `${Math.round(light.dimmer * 100)}%`,
      lum ? String(lum.ratedLumens) : '-',
    ];
    cells.forEach((c, ci) => ctx.fillText(c, 12 + ci * 125, y));
  });
  return canvas;
}

export function exportReportPDF(input: ReportInput): void {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  const pageW = 210;
  const margin = 14;
  const contentW = pageW - margin * 2;
  let y = margin;

  // 标题(图片形式,保证中文显示)
  const titleCanvas = document.createElement('canvas');
  titleCanvas.width = 1400;
  titleCanvas.height = 120;
  const tctx = titleCanvas.getContext('2d')!;
  tctx.fillStyle = '#fff';
  tctx.fillRect(0, 0, 1400, 120);
  tctx.fillStyle = '#16324f';
  tctx.font = 'bold 44px "Microsoft YaHei", "PingFang SC", sans-serif';
  tctx.fillText('商业照明配光预览 · 照度计算报告', 20, 60);
  tctx.fillStyle = '#666';
  tctx.font = '22px "Microsoft YaHei", sans-serif';
  tctx.fillText(new Date().toLocaleString('zh-CN'), 20, 100);
  doc.addImage(canvasToPng(titleCanvas), 'PNG', margin, y, contentW, 120 / 1400 * contentW);
  y += 26;

  // 信息表
  const info = infoTableCanvas(input);
  const infoH = (info.height / info.width) * contentW;
  doc.addImage(canvasToPng(info), 'PNG', margin, y, contentW, infoH);
  y += infoH + 8;

  // 伪彩热力图
  const heat = document.createElement('canvas');
  drawHeatmap(heat, input.result, input.room.width, input.room.depth, {
    width: 720,
    height: 560,
    scaleMax: input.scaleMax || percentileLux(input.result, 0.95),
    showContours: true,
  });
  const heatH = (heat.height / heat.width) * contentW;
  if (y + heatH > 285) {
    doc.addPage();
    y = margin;
  }
  doc.addImage(canvasToPng(heat), 'PNG', margin, y, contentW, heatH);
  y += heatH + 8;

  // 灯具清单
  if (y + 60 > 285) {
    doc.addPage();
    y = margin;
  }
  const lum = lumTableCanvas(input);
  const lumH = (lum.height / lum.width) * contentW;
  doc.addImage(canvasToPng(lum), 'PNG', margin, y, contentW, lumH);
  y += lumH + 6;

  // 方法说明
  if (y + 40 > 285) {
    doc.addPage();
    y = margin;
  }
  const note = document.createElement('canvas');
  note.width = 1400;
  note.height = 170;
  const nctx = note.getContext('2d')!;
  nctx.fillStyle = '#fff';
  nctx.fillRect(0, 0, 1400, 170);
  nctx.fillStyle = '#444';
  nctx.font = '20px "Microsoft YaHei", sans-serif';
  const lines = [
    '计算依据:直射 E=I(θ,φ)·cosθ/r²(IES LM-63 配光插值),一次间接反射采用墙面/顶面朗伯面片辐射度法。',
    'UGR 按 CIE 117 Guth 位置指数简化计算,观察者站位见页面数据;本结果用于方案阶段预览,不替代正式照明设计软件。',
  ];
  lines.forEach((l, i) => nctx.fillText(l, 10, 36 + i * 34));
  doc.addImage(canvasToPng(note), 'PNG', margin, y, contentW, (170 / 1400) * contentW);

  const safeName = input.projectName.replace(/[\\/:*?"<>|]/g, '_');
  doc.save(`${safeName}_照度报告.pdf`);
}
