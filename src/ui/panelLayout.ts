// 布灯:在 3D 视口点击落点放灯、矩形阵列、逐灯编辑位置/朝向/调光、删除。
import { h, numberField, toast } from './dom.ts';
import { uid } from '../core/store.ts';
import type { PlacedLight } from '../core/types.ts';
import type { PanelContext } from './context.ts';
import { clamp } from '../core/math.ts';

export function renderLayoutPanel(ctx: PanelContext): HTMLElement {
  const { store } = ctx;
  const root = h('div');
  const lightList = h('div');

  const refreshList = (): void => {
    lightList.innerHTML = '';
    if (!store.state.lights.length) {
      lightList.append(h('div', { class: 'empty-tip' }, '还没有灯具。先在“灯具库”选用灯具,再点击下方按钮或在视口地面上点击放置。'));
    }
    store.state.lights.forEach((light, idx) => lightList.append(lightCard(ctx, light, idx, refreshList)));
  };

  const addAtCenter = (): void => {
    const lumId = store.state.activeLuminaireId;
    if (!lumId) {
      toast('请先在灯具库选用一个灯具', true);
      return;
    }
    const light: PlacedLight = {
      id: uid('light'),
      luminaireId: lumId,
      position: [0, store.state.room.height - 0.2, 0],
      yawDeg: 0,
      dimmer: 1,
    };
    store.mutate((s) => { s.lights.push(light); s.selectedLightId = light.id; });
    ctx.scheduleCompute();
    refreshList();
  };

  // 矩形阵列
  const arraySection = h('div', { class: 'section' }, h('h3', {}, '矩形阵列布置'));
  const nxInput = h('input', { type: 'number', value: '4', min: '1', max: '10' });
  const nzInput = h('input', { type: 'number', value: '3', min: '1', max: '10' });
  const marginInput = h('input', { type: 'number', value: '0.8', min: '0', step: '0.1' });
  const fillBtn = h('button', { class: 'btn' }, '按阵列铺满房间');
  fillBtn.addEventListener('click', () => {
    const lumId = store.state.activeLuminaireId;
    if (!lumId) return toast('请先在灯具库选用灯具', true);
    const nx = clamp(parseInt(nxInput.value, 10) || 1, 1, 10);
    const nz = clamp(parseInt(nzInput.value, 10) || 1, 1, 10);
    const margin = parseFloat(marginInput.value) || 0;
    const { room } = store.state;
    const lights: PlacedLight[] = [];
    for (let i = 0; i < nx; i++) {
      for (let k = 0; k < nz; k++) {
        const x = nx === 1 ? 0 : -room.width / 2 + margin + (i / (nx - 1)) * (room.width - 2 * margin);
        const z = nz === 1 ? 0 : -room.depth / 2 + margin + (k / (nz - 1)) * (room.depth - 2 * margin);
        lights.push({
          id: uid('light'), luminaireId: lumId,
          position: [x, room.height - 0.2, z], yawDeg: 0, dimmer: 1,
        });
      }
    }
    store.mutate((s) => { s.lights = lights; s.selectedLightId = lights[0]?.id ?? null; });
    ctx.scheduleCompute();
    refreshList();
    toast(`已布置 ${lights.length} 盏灯`);
  });
  arraySection.append(
    h('div', { class: 'row3' },
      h('label', { class: 'field' }, h('span', {}, 'X 向数量'), nxInput),
      h('label', { class: 'field' }, h('span', {}, 'Z 向数量'), nzInput),
      h('label', { class: 'field' }, h('span', {}, '边距 m'), marginInput),
    ),
    fillBtn,
  );

  const addBtn = h('button', { class: 'btn' }, '在房间中心放一盏');
  addBtn.addEventListener('click', addAtCenter);
  const clearBtn = h('button', { class: 'btn ghost' }, '清空全部灯具');
  clearBtn.addEventListener('click', () => {
    store.mutate((s) => { s.lights = []; s.selectedLightId = null; });
    ctx.scheduleCompute();
    refreshList();
  });

  root.append(
    h('h2', { class: 'panel-title' }, '布灯'),
    h('p', { class: 'panel-sub' }, `当前 ${store.state.lights.length} 盏 · 上限 24。视口中左键拖动灯具可移动。`),
    h('div', { class: 'section' }, addBtn, h('div', { style: 'height:8px' }), clearBtn),
    arraySection,
    h('div', { class: 'section' }, h('h3', {}, '灯具清单'), lightList),
  );

  refreshList();
  return root;
}

function lightCard(ctx: PanelContext, light: PlacedLight, idx: number, refresh: () => void): HTMLElement {
  const { store } = ctx;
  const lum = store.state.luminaires.find((l) => l.id === light.luminaireId);
  const card = h('div', { class: 'light-row' });
  if (store.state.selectedLightId === light.id) card.classList.add('selected');

  const select = (): void => store.update({ selectedLightId: light.id });
  card.addEventListener('click', select);

  const head = h('div', { class: 'top' },
    h('b', {}, `#${idx + 1} ${lum?.ies.catalogNumber || lum?.ies.label || '灯具'}`),
    (() => {
      const d = h('button', { class: 'btn danger' }, '删除');
      d.addEventListener('click', (e) => {
        e.stopPropagation();
        store.mutate((s) => {
          s.lights = s.lights.filter((x) => x.id !== light.id);
          if (s.selectedLightId === light.id) s.selectedLightId = s.lights[0]?.id ?? null;
        });
        ctx.scheduleCompute();
        refresh();
      });
      return d;
    })(),
  );
  const coords = h('div', { class: 'coords' },
    `(${light.position.map((v) => v.toFixed(2)).join(', ')}) m · 调光 ${Math.round(light.dimmer * 100)}%`);
  card.append(head, coords);

  const edit = h('div', { style: 'margin-top:8px' });
  const commit = (): void => {
    store.emit();
    coords.textContent = `(${light.position.map((v) => v.toFixed(2)).join(', ')}) m · 调光 ${Math.round(light.dimmer * 100)}%`;
    ctx.scheduleCompute();
  };
  const { room } = store.state;
  edit.append(
    h('div', { class: 'row3' },
      numberField('X', light.position[0], 0.1, -room.width / 2, room.width / 2, (v) => { light.position[0] = v; commit(); }),
      numberField('Y', light.position[1], 0.1, 0.1, room.height, (v) => { light.position[1] = v; commit(); }),
      numberField('Z', light.position[2], 0.1, -room.depth / 2, room.depth / 2, (v) => { light.position[2] = v; commit(); }),
    ),
    h('div', { class: 'row2' },
      numberField('朝向 °', light.yawDeg, 5, -180, 180, (v) => { light.yawDeg = v; commit(); }),
      numberField('调光 0-1', light.dimmer, 0.05, 0, 1, (v) => { light.dimmer = clamp(v, 0, 1); commit(); }),
    ),
  );
  card.append(edit);
  return card;
}
