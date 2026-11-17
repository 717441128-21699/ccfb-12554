// 灯具库:上传 IES、解析校验、展示极坐标配光曲线、选用灯具。
import { h, toast } from './dom.ts';
import { drawPolarCurve } from './polarPlot.ts';
import { parseIES } from '../core/ies.ts';
import { createLuminaire } from '../core/library.ts';
import type { Luminaire } from '../core/types.ts';
import type { PanelContext } from './context.ts';

export function renderLibraryPanel(ctx: PanelContext): HTMLElement {
  const { store } = ctx;
  const root = h('div');
  const list = h('div');

  const refresh = (): void => {
    list.innerHTML = '';
    if (!store.state.luminaires.length) {
      list.append(h('div', { class: 'empty-tip' }, '点击下方按钮上传 IES 文件,或加载内置示例灯具。'));
      return;
    }
    for (const lum of store.state.luminaires) list.append(lumCard(ctx, lum));
  };

  const onFile = async (file: File): Promise<void> => {
    try {
      const text = await file.text();
      const ies = parseIES(text, file.name);
      const lum = createLuminaire(ies);
      store.mutate((s) => {
        s.luminaires.push(lum);
        s.activeLuminaireId = lum.id;
      });
      toast(`已导入 ${file.name}(积分通量 ${Math.round(lum.integratedLumens)} lm)`);
      refresh();
    } catch (err) {
      toast(`IES 解析失败:${(err as Error).message}`, true);
    }
  };

  const fileInput = h('input', { type: 'file', accept: '.ies,text/plain', hidden: true });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) void onFile(f);
    fileInput.value = '';
  });

  const uploadBtn = h('button', { class: 'btn' }, '上传 IES 灯具文件');
  uploadBtn.addEventListener('click', () => fileInput.click());

  const sampleBtn = h('button', { class: 'btn ghost' }, '加载内置示例灯具');
  sampleBtn.addEventListener('click', async () => {
    const { loadBuiltinSamples } = await import('../core/library.ts');
    const samples = await loadBuiltinSamples((u) => fetch(u).then((r) => r.text()));
    store.mutate((s) => {
      for (const ies of samples) {
        if (s.luminaires.some((l) => l.ies.fileName === ies.fileName)) continue;
        const lum = createLuminaire(ies);
        s.luminaires.push(lum);
        if (!s.activeLuminaireId) s.activeLuminaireId = lum.id;
      }
    });
    toast(`已加载 ${samples.length} 个示例灯具`);
    refresh();
  });

  root.append(
    h('h2', { class: 'panel-title' }, '灯具库'),
    h('p', { class: 'panel-sub' }, '解析 IESNA LM-63,按极坐标查看配光;选中后可在“布灯”页放置。'),
    h('div', { class: 'section' }, uploadBtn, fileInput, h('div', { style: 'height:8px' }), sampleBtn),
    h('div', { class: 'section' }, h('h3', {}, `已入库 (${store.state.luminaires.length})`), list),
  );
  refresh();
  return root;
}

function lumCard(ctx: PanelContext, lum: Luminaire): HTMLElement {
  const { store } = ctx;
  const card = h('div', { class: 'lum-card' });
  if (store.state.activeLuminaireId === lum.id) card.classList.add('selected');

  const canvas = h('canvas');
  requestAnimationFrame(() => drawPolarCurve(canvas, lum.ies, { width: 300, height: 250 }));

  const halfAngle = beamAngle(lum);
  card.append(
    h('div', { class: 'name' }, lum.ies.label),
    h('div', { class: 'meta' },
      `型号 ${lum.ies.catalogNumber || '-'} · 峰值 ${Math.round(lum.peakCandela)} cd`,
      h('br'),
      `额定 ${lum.ratedLumens} lm · 功率 ${lum.ies.inputWatts} W · 半光强角≈${halfAngle}°`,
      h('br'),
      `采样 垂直${lum.ies.nVert}×水平${lum.ies.nHoriz}`),
    canvas,
  );

  const useBtn = h('button', { class: 'btn small' }, store.state.activeLuminaireId === lum.id ? '✓ 当前选用' : '选用此灯');
  useBtn.addEventListener('click', () => {
    store.update({ activeLuminaireId: lum.id });
    document.querySelectorAll('.lum-card').forEach((n) => n.classList.remove('selected'));
    card.classList.add('selected');
    useBtn.textContent = '✓ 当前选用';
  });

  const delBtn = h('button', { class: 'btn danger' }, '删除');
  delBtn.addEventListener('click', () => {
    store.mutate((s) => {
      s.luminaires = s.luminaires.filter((l) => l.id !== lum.id);
      s.lights = s.lights.filter((l) => l.luminaireId !== lum.id);
      if (s.activeLuminaireId === lum.id) s.activeLuminaireId = s.luminaires[0]?.id ?? null;
    });
    ctx.scheduleCompute();
    card.remove();
  });

  card.append(h('div', { class: 'actions' }, useBtn, delBtn));
  return card;
}

/** 由配光表估算半光强角(轴向峰值 50% 处的 θ) */
function beamAngle(lum: Luminaire): number {
  const row = lum.ies.candela[0];
  const va = lum.ies.vertAngles;
  let peak = 0;
  for (const v of row) peak = Math.max(peak, v);
  const half = peak * 0.5;
  for (let i = 0; i < row.length - 1; i++) {
    if (row[i] >= half && row[i + 1] <= half) {
      const t = (half - row[i]) / (row[i + 1] - row[i] || 1);
      return Math.round(va[i] + t * (va[i + 1] - va[i]));
    }
  }
  return va[va.length - 1];
}
