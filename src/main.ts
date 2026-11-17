// 应用入口:装配渲染器、计算调度、五个功能页与视口交互。
import './ui/styles.css';
import { createStore, type Store } from './core/store.ts';
import { SceneRenderer } from './render/scene.ts';
import { ComputeScheduler } from './core/scheduler.ts';
import type { PanelContext } from './ui/context.ts';
import { renderLibraryPanel } from './ui/panelLibrary.ts';
import { renderRoomPanel } from './ui/panelRoom.ts';
import { renderLayoutPanel } from './ui/panelLayout.ts';
import { renderPreviewPanel } from './ui/panelPreview.ts';
import { renderReportPanel } from './ui/panelReport.ts';
import { h, toast } from './ui/dom.ts';
import { clamp } from './core/math.ts';
import { percentileLux } from './core/engine.ts';
import type { Vec3 } from './core/math.ts';
import type { PlacedLight } from './core/types.ts';

const TABS = [
  { key: 'library', icon: '💡', label: '灯具库' },
  { key: 'room', icon: '🏠', label: '房间搭建' },
  { key: 'layout', icon: '✥', label: '布灯' },
  { key: 'preview', icon: '🎬', label: '渲染预览' },
  { key: 'report', icon: '📄', label: '照度报告' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

function bootstrap(): void {
  const store = createStore();
  const canvas = document.getElementById('glCanvas') as HTMLCanvasElement;
  let renderer: SceneRenderer;
  try {
    renderer = new SceneRenderer(canvas);
  } catch (err) {
    const msg = (err as Error).message || String(err);
    toast(msg, true);
    const fatal = document.createElement('div');
    fatal.style.cssText =
      'position:fixed;inset:20%;background:#1d2532;border:1px solid #ef4444;border-radius:10px;padding:24px;color:#fca5a5;font:13px sans-serif;z-index:999;white-space:pre-wrap;overflow:auto;';
    fatal.textContent = `WebGL 初始化失败:\n${msg}`;
    document.body.append(fatal);
    return;
  }
  renderer.buildRoom(store.state.room);

  const scheduler = new ComputeScheduler(
    (result) => {
      store.update({ result, computing: false });
      renderer.uploadHeatmap(result.points, result.nx, result.nz);
    },
    (busy) => store.update({ computing: busy }),
  );

  const ctx: PanelContext = {
    store,
    renderer,
    scheduler,
    scheduleCompute: () => schedule(store, scheduler),
    rebuildRoom: () => renderer.buildRoom(store.state.room),
  };

  // ---------- 导航 ----------
  const navRail = document.getElementById('navRail')!;
  const sidePanel = document.getElementById('sidePanel')!;
  const panelBuilders: Record<TabKey, (c: PanelContext) => HTMLElement> = {
    library: renderLibraryPanel,
    room: renderRoomPanel,
    layout: renderLayoutPanel,
    preview: renderPreviewPanel,
    report: renderReportPanel,
  };
  const switchTab = (key: TabKey): void => {
    sidePanel.innerHTML = '';
    sidePanel.append(panelBuilders[key](ctx));
    navRail.querySelectorAll<HTMLElement>('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.tab === key));
  };
  for (const tab of TABS) {
    const btn = h('button', { class: 'nav-item' }, h('span', { class: 'ico' }, tab.icon), h('span', {}, tab.label));
    btn.dataset.tab = tab.key;
    btn.addEventListener('click', () => switchTab(tab.key));
    navRail.append(btn);
  }

  // ---------- 视口 HUD ----------
  const hud = document.getElementById('hud')!;
  const busyDot = document.getElementById('busyDot')!;
  const hudChips: HTMLElement[] = [];
  const renderHud = (): void => {
    const s = store.state;
    busyDot.classList.toggle('busy', s.computing);
    const m = s.result?.metrics;
    const chips: Array<[string, string]> = [
      ['房间', `${s.room.width}×${s.room.depth}×${s.room.height} m`],
      ['灯具', `${s.lights.length} 盏`],
      ['平均照度', m ? `${m.average.toFixed(0)} lx` : '-'],
      ['均匀度 U0', m ? m.uniformityMin.toFixed(2) : '-'],
      ['UGR', m ? m.ugr.toFixed(1) : '-'],
    ];
    if (hudChips.length !== chips.length) {
      hud.innerHTML = '';
      hudChips.length = 0;
      for (const [k, v] of chips) {
        const chip = h('div', { class: 'hud-chip' }, `${k} `, h('b', {}, v));
        hudChips.push(chip);
        hud.append(chip);
      }
    }
    chips.forEach(([k, v], i) => { hudChips[i].innerHTML = ''; hudChips[i].append(`${k} `, h('b', {}, v)); });
  };
  store.subscribe(renderHud);

  // ---------- 视口交互:放灯 / 选灯 / 拖灯 ----------
  renderer.attachControls(
    canvas,
    (world) => onPick(ctx, world),
    (world) => onDragLight(store, world, () => schedule(store, scheduler)),
  );

  store.subscribe((s) => {
    renderer.setLightPositions(s.lights.map((l) => l.position));
  });

  // ---------- 渲染循环 ---------- 每帧重画,保证拖拽实时
  const frame = (): void => {
    const s = store.state;
    const powers = s.lights.map((l) => {
      const lum = s.luminaires.find((x) => x.id === l.luminaireId);
      return (lum?.ratedLumens ?? 1000) * l.dimmer * 0.02;
    });
    renderer.render(s.room, s.lights, powers, {
      falseColor: s.falseColor,
      scaleMax: s.colorScaleMax || (s.result ? percentileLux(s.result, 0.95) : 500),
      selectedId: s.selectedLightId,
      showHeat: !!s.result,
    });
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  switchTab('library');
  // 首屏自动加载示例并放一组灯,便于立即看到效果
  void autoSeed(ctx, () => schedule(store, scheduler));
}

function schedule(store: Store, scheduler: ComputeScheduler): void {
  if (!store.state.lights.length) {
    store.update({ result: null });
    return;
  }
  scheduler.request({
    room: structuredClone(store.state.room),
    lights: structuredClone(store.state.lights),
    luminaires: structuredClone(store.state.luminaires),
    grid: store.state.grid,
    includeIndirect: store.state.includeIndirect,
  }, 70);
}

function onPick(ctx: PanelContext, world: Vec3): void {
  const { store } = ctx;
  // 命中灯具 → 选中并进入拖拽;否则在落点放灯
  const hitLight = store.state.lights.find((l) => {
    const p = l.position;
    return Math.hypot(p[0] - world[0], p[1] - world[1], p[2] - world[2]) < 0.3;
  });
  if (hitLight) {
    store.update({ selectedLightId: hitLight.id });
    ctx.renderer.beginLightDrag(hitLight.position[1]);
    return;
  }
  const lumId = store.state.activeLuminaireId;
  if (!lumId) {
    toast('请先在灯具库选用灯具', true);
    return;
  }
  if (store.state.lights.length >= 24) {
    toast('已达 24 盏上限', true);
    return;
  }
  const light: PlacedLight = {
    id: `light_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`,
    luminaireId: lumId,
    position: [
      clamp(world[0], -store.state.room.width / 2 + 0.1, store.state.room.width / 2 - 0.1),
      store.state.room.height - 0.2,
      clamp(world[2], -store.state.room.depth / 2 + 0.1, store.state.room.depth / 2 - 0.1),
    ],
    yawDeg: 0,
    dimmer: 1,
  };
  store.mutate((s) => { s.lights.push(light); s.selectedLightId = light.id; });
  schedule(store, ctx.scheduler);
}

function onDragLight(store: Store, world: Vec3, onDone: () => void): void {
  const id = store.state.selectedLightId;
  if (!id) return;
  const light = store.state.lights.find((l) => l.id === id);
  if (!light) return;
  light.position[0] = clamp(world[0], -store.state.room.width / 2 + 0.1, store.state.room.width / 2 - 0.1);
  light.position[2] = clamp(world[2], -store.state.room.depth / 2 + 0.1, store.state.room.depth / 2 - 0.1);
  store.emit();
  onDone();
}

async function autoSeed(ctx: PanelContext, compute: () => void): Promise<void> {
  const { loadBuiltinSamples } = await import('./core/library.ts');
  const { createLuminaire } = await import('./core/library.ts');
  const samples = await loadBuiltinSamples((u) => fetch(u).then((r) => r.text()));
  if (!samples.length) return;
  const luminaires = samples.map(createLuminaire);
  const panel = luminaires.find((l) => l.ies.fileName === 'panel-90deg.ies') ?? luminaires[0];
  const { room } = ctx.store.state;
  const lights: PlacedLight[] = [];
  const nx = 3, nz = 2;
  for (let i = 0; i < nx; i++) {
    for (let k = 0; k < nz; k++) {
      lights.push({
        id: `light_seed_${i}_${k}`,
        luminaireId: panel.id,
        position: [
          (i - (nx - 1) / 2) * 2.2,
          room.height - 0.2,
          (k - (nz - 1) / 2) * 2,
        ],
        yawDeg: 0,
        dimmer: 1,
      });
    }
  }
  ctx.store.mutate((s) => {
    s.luminaires = luminaires;
    s.lights = lights;
    s.activeLuminaireId = panel.id;
  });
  compute();
}

bootstrap();
