// 渲染预览:伪彩/实体切换、一次反射开关、网格精度、色标范围,以及实时指标。
import { h } from './dom.ts';
import type { PanelContext } from './context.ts';

export function renderPreviewPanel(ctx: PanelContext): HTMLElement {
  const { store } = ctx;
  const root = h('div');

  const toggle = (label: string, checked: boolean, fn: (v: boolean) => void): HTMLElement => {
    const input = h('input', { type: 'checkbox', checked });
    input.addEventListener('change', () => fn(input.checked));
    const sw = h('label', { class: 'switch' }, input, h('span', { class: 'track' }));
    return h('div', { class: 'toggle-row' }, h('span', {}, label), sw);
  };

  const displaySection = h('div', { class: 'section' }, h('h3', {}, '显示选项'),
    toggle('工作面伪彩色', store.state.falseColor, (v) => store.update({ falseColor: v })),
    toggle('计入一次间接反射', store.state.includeIndirect, (v) => {
      store.update({ includeIndirect: v });
      ctx.scheduleCompute();
    }),
  );

  const gridSel = h('select');
  [['16', '16 × 16(快)'], ['32', '32 × 32(标准)'], ['48', '48 × 48(精细)']].forEach(([v, label]) =>
    gridSel.append(h('option', { value: v, selected: store.state.grid.nx === Number(v) }, label)));
  gridSel.addEventListener('change', () => {
    const n = Number(gridSel.value);
    store.update({ grid: { nx: n, nz: n } });
    ctx.scheduleCompute();
  });

  const scaleInput = h('input', { type: 'number', min: '0', step: '10', value: String(store.state.colorScaleMax) });
  scaleInput.addEventListener('change', () => store.update({ colorScaleMax: Math.max(0, Number(scaleInput.value) || 0) }));
  const autoBtn = h('button', { class: 'btn ghost small' }, '自动色标');
  autoBtn.addEventListener('click', () => {
    store.update({ colorScaleMax: 0 });
    scaleInput.value = '0';
  });

  const calcSection = h('div', { class: 'section' }, h('h3', {}, '计算设置'),
    h('label', { class: 'field' }, h('span', {}, '照度采样网格'), gridSel),
    h('label', { class: 'field' }, h('span', {}, '色标上限 lx(0=自动)'), scaleInput),
    autoBtn,
  );

  const metricsBox = h('div', { class: 'section' }, h('h3', {}, '实时指标'));
  const metric = (v: string, k: string): HTMLElement =>
    h('div', { class: 'metric' }, h('div', { class: 'v' }, v), h('div', { class: 'k' }, k));
  const grid2 = h('div', { class: 'metric-grid' });
  metricsBox.append(grid2);

  const renderMetrics = (): void => {
    const m = store.state.result?.metrics;
    grid2.innerHTML = '';
    if (!m) {
      grid2.append(h('div', { class: 'empty-tip', style: 'grid-column:1/-1' }, '布置灯具后自动计算…'));
      return;
    }
    grid2.append(
      metric(`${m.average.toFixed(0)} lx`, '平均照度'),
      metric(`${m.min.toFixed(0)} lx`, '最小照度'),
      metric(`${m.max.toFixed(0)} lx`, '最大照度'),
      metric(m.uniformityMin.toFixed(2), '均匀度 U0(最小/平均)'),
      metric(m.ugr.toFixed(1), '统一眩光值 UGR'),
      metric(`${store.state.result?.elapsedMs.toFixed(0) ?? '-'} ms`, '计算耗时'),
    );
  };
  store.subscribe(renderMetrics);

  const hint = h('div', { class: 'section' },
    h('h3', {}, '操作说明'),
    h('div', { class: 'empty-tip' },
      '左键拖拽:旋转视角\nShift+拖拽:平移\n滚轮:缩放\n点击灯具:选中\n选中后拖动:移动灯具'));

  root.append(
    h('h2', { class: 'panel-title' }, '渲染预览'),
    h('p', { class: 'panel-sub' }, 'WebGL2 实时渲染,阴影与伪彩随布灯即时更新。'),
    displaySection, calcSection, metricsBox, hint,
  );
  renderMetrics();
  return root;
}
