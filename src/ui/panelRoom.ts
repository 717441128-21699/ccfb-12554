// 房间搭建:尺寸、工作面高度、三面反射率、门窗洞口。
import { h, numberField } from './dom.ts';
import { uid } from '../core/store.ts';
import type { Opening } from '../core/types.ts';
import type { PanelContext } from './context.ts';
import { clamp } from '../core/math.ts';

const WALL_NAMES = ['北墙 (+Z)', '东墙 (+X)', '南墙 (-Z)', '西墙 (-X)'];

export function renderRoomPanel(ctx: PanelContext): HTMLElement {
  const { store } = ctx;
  const root = h('div');
  const openingList = h('div');

  const renderOpenings = (): void => {
    openingList.innerHTML = '';
    if (!store.state.room.openings.length) {
      openingList.append(h('div', { class: 'empty-tip' }, '暂无门窗,可在下方添加窗或门。'));
      return;
    }
    store.state.room.openings.forEach((o) => openingList.append(openingCard(ctx, o, renderOpenings)));
  };

  const dimSection = h('div', { class: 'section' }, h('h3', {}, '房间尺寸 (米)'));
  const r = store.state.room;
  dimSection.append(
    h('div', { class: 'row3' },
      numberField('宽 X', r.width, 0.1, 2, 60, (v) => mutateRoom(ctx, (rm) => { rm.width = v; })),
      numberField('深 Z', r.depth, 0.1, 2, 60, (v) => mutateRoom(ctx, (rm) => { rm.depth = v; })),
      numberField('高 Y', r.height, 0.1, 2.2, 12, (v) => mutateRoom(ctx, (rm) => { rm.height = v; })),
    ),
    numberField('工作面高度', r.workplaneHeight, 0.05, 0, 1.5,
      (v) => mutateRoom(ctx, (rm) => { rm.workplaneHeight = clamp(v, 0, rm.height); })),
  );

  const reflSection = h('div', { class: 'section' }, h('h3', {}, '表面反射率'));
  const refl = (key: 'floor' | 'wall' | 'ceiling', label: string): HTMLElement => {
    const value = h('span', { class: 'refl-value' }, store.state.room.reflectance[key].toFixed(2));
    const range = h('input', { type: 'range', min: '0', max: '0.9', step: '0.02', value: String(store.state.room.reflectance[key]) });
    range.addEventListener('input', () => {
      const v = parseFloat(range.value);
      store.mutate((s) => { s.room.reflectance[key] = v; });
      value.textContent = v.toFixed(2);
      ctx.scheduleCompute();
    });
    return h('label', { class: 'field' }, h('span', {}, label, value), range);
  };
  reflSection.append(refl('floor', '地面'), refl('wall', '墙面'), refl('ceiling', '顶面'));

  const addOpening = (kind: 'window' | 'door'): void => {
    const opening: Opening = {
      id: uid('op'),
      wall: 0,
      u: 0,
      bottom: kind === 'door' ? 0 : 1,
      width: kind === 'door' ? 1 : 1.8,
      height: kind === 'door' ? 2.1 : 1.4,
      kind,
      transmittance: kind === 'door' ? 1 : 0.6,
    };
    store.mutate((s) => s.room.openings.push(opening));
    renderOpenings();
    ctx.rebuildRoom();
    ctx.scheduleCompute();
  };

  const openSection = h('div', { class: 'section' },
    h('h3', {}, '门窗洞口'),
    openingList,
    h('div', { class: 'row2' },
      btn('添加窗户', () => addOpening('window')),
      btn('添加门', () => addOpening('door')),
    ),
  );

  root.append(
    h('h2', { class: 'panel-title' }, '房间搭建'),
    h('p', { class: 'panel-sub' }, '定义空间几何与材质,门窗参与光线遮挡。'),
    dimSection, reflSection, openSection,
  );
  renderOpenings();
  return root;
}

function openingCard(ctx: PanelContext, o: Opening, refresh: () => void): HTMLElement {
  const { store } = ctx;
  const wallLen = o.wall % 2 === 0 ? store.state.room.width : store.state.room.depth;
  const card = h('div', { class: 'opening-row' });
  const head = h('div', { class: 'head' },
    h('b', {}, o.kind === 'window' ? '🪟 窗户' : '🚪 门'),
    (() => {
      const d = h('button', { class: 'btn danger' }, '移除');
      d.addEventListener('click', () => {
        store.mutate((s) => { s.room.openings = s.room.openings.filter((x) => x.id !== o.id); });
        refresh();
        ctx.rebuildRoom();
        ctx.scheduleCompute();
      });
      return d;
    })(),
  );
  card.append(head);

  const wallSel = h('select');
  WALL_NAMES.forEach((name, i) => wallSel.append(h('option', { value: String(i), selected: i === o.wall }, name)));
  wallSel.addEventListener('change', () => {
    o.wall = Number(wallSel.value) as Opening['wall'];
    o.u = 0;
    store.emit();
    refresh();
    ctx.rebuildRoom();
  });

  const field = (label: string, value: number, step: number, min: number, max: number, fn: (v: number) => void): HTMLLabelElement =>
    numberField(label, value, step, min, max, (v) => { fn(v); store.emit(); refresh(); ctx.rebuildRoom(); ctx.scheduleCompute(); });

  const grid = h('div', { class: 'row2' },
    h('label', { class: 'field' }, h('span', {}, '所在墙'), wallSel),
    field('沿墙位置 u', o.u, 0.1, -wallLen / 2, wallLen / 2, (v) => { o.u = clamp(v, -wallLen / 2 + o.width / 2, wallLen / 2 - o.width / 2); }),
    field('宽度', o.width, 0.1, 0.4, wallLen, (v) => { o.width = v; }),
    field('高度', o.height, 0.1, 0.4, store.state.room.height, (v) => { o.height = v; }),
    field('底边高度', o.bottom, 0.05, 0, store.state.room.height - o.height, (v) => { o.bottom = v; }),
  );
  card.append(grid);

  if (o.kind === 'window') {
    const tVal = h('span', { class: 'refl-value' }, `透光 ${Math.round(o.transmittance * 100)}%`);
    const tr = h('input', { type: 'range', min: '0.1', max: '1', step: '0.05', value: String(o.transmittance) });
    tr.addEventListener('input', () => {
      o.transmittance = parseFloat(tr.value);
      tVal.textContent = `透光 ${Math.round(o.transmittance * 100)}%`;
      store.emit();
      ctx.scheduleCompute();
    });
    card.append(h('label', { class: 'field' }, h('span', {}, '玻璃透光率', tVal), tr));
  }
  return card;
}

function mutateRoom(ctx: PanelContext, fn: (rm: import('../core/types.ts').RoomConfig) => void): void {
  ctx.store.mutate((s) => fn(s.room));
  ctx.rebuildRoom();
  ctx.scheduleCompute();
}

function btn(label: string, onClick: () => void): HTMLButtonElement {
  const b = h('button', { class: 'btn ghost' }, label);
  b.addEventListener('click', onClick);
  return b;
}
