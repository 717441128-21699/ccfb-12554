// 照度报告:俯视伪彩图、指标汇总、灯具清单,一键导出 PDF。
import { h, toast } from './dom.ts';
import { drawHeatmap } from './heatmap.ts';
import { exportReportPDF } from './report.ts';
import { percentileLux } from '../core/engine.ts';
import type { PanelContext } from './context.ts';

const PROJECT_KEY = 'lightstudio.projectName';

export function renderReportPanel(ctx: PanelContext): HTMLElement {
  const { store } = ctx;
  const root = h('div');

  const nameInput = h('input', { type: 'text', value: localStorage.getItem(PROJECT_KEY) || '某商业店铺照明方案' });
  nameInput.addEventListener('input', () => localStorage.setItem(PROJECT_KEY, nameInput.value));

  const heatCanvas = h('canvas', { id: 'reportHeat' });
  const summary = h('div', { class: 'metric-grid' });

  const draw = (): void => {
    const result = store.state.result;
    summary.innerHTML = '';
    if (!result) {
      summary.append(h('div', { class: 'empty-tip', style: 'grid-column:1/-1' }, '暂无计算结果,请先布置灯具。'));
      return;
    }
    drawHeatmap(heatCanvas, result, store.state.room.width, store.state.room.depth, {
      width: 318, height: 250,
      scaleMax: store.state.colorScaleMax || percentileLux(result, 0.95),
      showContours: true,
    });
    const m = result.metrics;
    const item = (v: string, k: string): HTMLElement =>
      h('div', { class: 'metric' }, h('div', { class: 'v' }, v), h('div', { class: 'k' }, k));
    summary.append(
      item(`${m.average.toFixed(1)} lx`, '平均照度'),
      item(m.uniformityMin.toFixed(3), '均匀度 U0'),
      item(m.ugr.toFixed(1), '眩光 UGR'),
      item(`${m.pointCount} 点`, '采样数量'),
    );
  };

  const exportBtn = h('button', { class: 'btn' }, '导出 PDF 报告');
  exportBtn.addEventListener('click', () => {
    const result = store.state.result;
    if (!result) return toast('暂无可导出的计算结果', true);
    try {
      exportReportPDF({
        room: structuredClone(store.state.room),
        lights: structuredClone(store.state.lights),
        luminaires: structuredClone(store.state.luminaires),
        result,
        scaleMax: store.state.colorScaleMax || result.metrics.max,
        projectName: nameInput.value || '未命名项目',
      });
      toast('PDF 已生成并开始下载');
    } catch (err) {
      toast(`导出失败:${(err as Error).message}`, true);
    }
  });

  store.subscribe(draw);

  root.append(
    h('h2', { class: 'panel-title' }, '照度报告'),
    h('p', { class: 'panel-sub' }, '工作面照度伪彩与评价指标,可导出为 PDF 交付客户。'),
    h('div', { class: 'section' },
      h('label', { class: 'field' }, h('span', {}, '项目名称'), nameInput),
      summary,
      heatCanvas,
    ),
    h('div', { class: 'section' }, exportBtn),
  );
  draw();
  return root;
}
