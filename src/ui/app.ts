import { store } from '../state/store';
import { importSlab, parseFileName, type ImportMeta } from '../state/importer';
import { makeSyntheticBlock } from '../core/synthetic';
import { solveLayout, buildCutPlan } from '../core/solver';
import { crackWorldPolyline } from '../core/constraints';
import { orientPoint } from '../core/geometry';
import { WebGLRenderer } from '../render/webglRenderer';
import { DEFAULT_SOLVE_OPTIONS, type Opening, type OpeningType, type Surface, type Vec2 } from '../core/types';
import { renderSlabLibrary } from './slabLibrary';
import { renderSidePanel } from './sidePanel';
import { showToast } from './toast';

let renderer: WebGLRenderer | null = null;
let showCracks = true;
let showOpenings = true;
let highlightSeam: string | undefined;

export function initApp(): void {
  const app = document.getElementById('app')!;
  app.innerHTML = `
    <header class="app-header">
      <h1>大板连纹排版工具</h1>
      <span class="sub">接缝错位 ≤ 3mm · 开孔避让 · 出材率与切割图 · WebGL2</span>
    </header>
    <div class="layout">
      <section class="panel" id="panel-left">
        <div class="panel-title">
          <span>板库</span>
          <span class="muted" id="slab-count"></span>
        </div>
        <div class="panel-body" id="slab-library"></div>
      </section>

      <section class="panel">
        <div class="panel-title">
          <span id="surface-name">版面</span>
          <span class="badge-solve-time" id="solve-time"></span>
        </div>
        <div class="panel-body" style="display:flex;flex-direction:column;min-height:0;">
          <div class="canvas-wrap">
            <div class="canvas-toolbar">
              <button id="btn-cracks" class="active">裂纹</button>
              <button id="btn-openings" class="active">开口/避让</button>
              <button id="btn-view-layout">排版图</button>
              <button id="btn-view-cuts">切割图</button>
            </div>
            <canvas id="gl-canvas"></canvas>
            <div class="overlay-msg" id="canvas-msg">导入大板照片，或点击下方“载入演示数据”</div>
          </div>
          <div class="solve-bar" style="margin-top:10px;">
            <button class="primary" id="btn-solve">自动连纹排版</button>
            <button id="btn-demo">载入演示数据</button>
          </div>
          <div class="hint">
            求解器在 10 秒预算内用 beam search 枚举板的 8 种朝向（旋转 + 书本对开），
            以接缝纹路错位、角度连续性和同荒料相邻序号为先验选最优摆法。
          </div>
        </div>
      </section>

      <section class="panel" id="panel-right">
        <div class="panel-title"><span>工程面板</span></div>
        <div class="panel-body" id="side-panel"></div>
      </section>
    </div>
    <input type="file" id="file-input" accept="image/*" multiple hidden />
  `;

  bindEvents();
  store.subscribe(render);
  render(store.getState());
}

function bindEvents(): void {
  document.getElementById('btn-demo')!.addEventListener('click', loadDemo);
  document.getElementById('btn-solve')!.addEventListener('click', runSolve);
  document.getElementById('btn-cracks')!.addEventListener('click', () => {
    showCracks = !showCracks;
    document.getElementById('btn-cracks')!.classList.toggle('active', showCracks);
    render(store.getState());
  });
  document.getElementById('btn-openings')!.addEventListener('click', () => {
    showOpenings = !showOpenings;
    document.getElementById('btn-openings')!.classList.toggle('active', showOpenings);
    render(store.getState());
  });
  document.getElementById('btn-view-layout')!.addEventListener('click', () => store.setView('layout'));
  document.getElementById('btn-view-cuts')!.addEventListener('click', () => store.setView('cuts'));

  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  fileInput.addEventListener('change', () => void handleFiles(fileInput));
}

async function handleFiles(input: HTMLInputElement): Promise<void> {
  const files = Array.from(input.files ?? []);
  input.value = '';
  if (files.length === 0) return;
  const imported = [];
  for (const f of files) {
    const parsed = parseFileName(f.name);
    const meta: ImportMeta = parsed ?? {
      blockId: promptMeta('荒料号', 'B1') ?? 'B1',
      seq: Number(promptMeta('切割序号(从0开始)', '0')) || 0,
      widthMm: Number(promptMeta('板宽 mm', '1600')) || 1600,
      heightMm: Number(promptMeta('板高 mm', '2400')) || 2400,
    };
    try {
      const { slab, warnings } = await importSlab(f, meta);
      imported.push(slab);
      warnings.forEach((w) => showToast(w, 'warn'));
    } catch (e) {
      showToast(`导入 ${f.name} 失败：${(e as Error).message}`, 'error');
    }
  }
  if (imported.length) {
    store.addSlabs(imported);
    showToast(`已导入 ${imported.length} 块板，纹路检测完成`);
  }
}

function promptMeta(label: string, fallback: string): string | null {
  return window.prompt(label, fallback);
}

function loadDemo(): void {
  const slabs = makeSyntheticBlock('B1', 8, 1600, 2400, { seed: 2026 });
  store.setSlabs(slabs);
  const surface: Surface = {
    id: 'wall-1',
    kind: 'wall',
    name: '客厅背景墙（演示）',
    width: 6400,
    height: 2400,
    openings: [
      { id: 'op-socket', type: 'socket', x: 5200, y: 900, width: 120, height: 120, margin: 100 },
      { id: 'op-window', type: 'window', x: 200, y: 200, width: 900, height: 700, margin: 20 },
    ],
  };
  store.updateSurface(surface);
  showToast('已载入 8 块同荒料演示板（含 1 条裂纹、1 个插座、1 个窗洞）');
}

function runSolve(): void {
  const s = store.getState();
  if (s.slabs.length === 0) {
    showToast('请先导入大板或载入演示数据', 'warn');
    return;
  }
  const surface = s.surfaces.find((x) => x.id === s.activeSurfaceId)!;
  const t0 = performance.now();
  try {
    const plan = solveLayout(surface, s.slabs, { ...DEFAULT_SOLVE_OPTIONS });
    store.setPlan(surface.id, plan);
    const cut = buildCutPlan(surface, plan, s.slabs);
    store.setCutPlan(surface.id, cut);
    const elapsed = (performance.now() - t0).toFixed(0);
    if (plan.violations.length > 0) {
      showToast(`排版完成但有 ${plan.violations.length} 处开孔避让违规，请调整开口或换板`, 'warn');
    } else {
      showToast(`排版完成，用时 ${elapsed}ms，接缝最大错位 ${plan.score.maxSeamOffset.toFixed(2)}mm`);
    }
  } catch (e) {
    showToast('求解失败：' + (e as Error).message, 'error');
  }
}

function render(state: ReturnType<typeof store.getState>): void {
  renderSlabLibrary(state);
  renderSidePanel(state, {
    onAddOpening: (o: Opening) => store.addOpening(state.activeSurfaceId, o),
    onRemoveOpening: (id: string) => store.removeOpening(state.activeSurfaceId, id),
    onHighlightSeam: (key) => {
      highlightSeam = key;
      renderCanvas(state);
    },
    onUpdateSurface: (surface: Surface) => store.updateSurface(surface),
  });
  renderCanvas(state);
  document.getElementById('slab-count')!.textContent = `${state.slabs.length} 块`;
  const surface = state.surfaces.find((x) => x.id === state.activeSurfaceId);
  document.getElementById('surface-name')!.textContent = surface?.name ?? '版面';
  document.getElementById('btn-view-layout')!.classList.toggle('active', state.view === 'layout');
  document.getElementById('btn-view-cuts')!.classList.toggle('active', state.view === 'cuts');
  const plan = state.plans[state.activeSurfaceId];
  document.getElementById('solve-time')!.textContent = plan
    ? `求解 ${plan.solveMs.toFixed(0)} ms`
    : '';
}

function renderCanvas(state: ReturnType<typeof store.getState>): void {
  const canvas = document.getElementById('gl-canvas') as HTMLCanvasElement;
  const surface = state.surfaces.find((x) => x.id === state.activeSurfaceId)!;
  const plan = state.plans[state.activeSurfaceId];
  const msg = document.getElementById('canvas-msg')!;
  msg.style.display = plan && plan.placements.length > 0 ? 'none' : 'flex';

  if (!renderer) {
    try {
      renderer = new WebGLRenderer(canvas, {
        onDirty: () => renderCanvas(store.getState()),
      });
    } catch (e) {
      msg.textContent = (e as Error).message;
      return;
    }
  }

  const placements = plan?.placements ?? [];
  const slabById = new Map(state.slabs.map((s) => [s.id, s]));
  const placementById = new Map(placements.map((p) => [p.id, p]));
  const crackPolylines = placements.flatMap((p) => {
    const slab = slabById.get(p.slabId);
    if (!slab) return [];
    return slab.cracks.map((crack) => ({
      placement: p,
      points: crackWorldPolyline(crack, slab, p),
    }));
  });

  // 切割视图：把每刀的原板坐标端点变换到安装面坐标
  let cutLines: Vec2[] | undefined;
  if (state.view === 'cuts') {
    const cut = state.cutPlans[state.activeSurfaceId];
    if (cut) {
      cutLines = [];
      for (const step of cut.steps) {
        const p = placementById.get(step.placementId);
        const slab = slabById.get(step.slabId);
        if (!p || !slab) continue;
        for (const local of [step.from, step.to]) {
          const oriented = orientPoint(local, slab.width, slab.height, {
            rot: p.rot,
            flipX: p.flipX,
          });
          cutLines.push({ x: oriented.x + p.x, y: oriented.y + p.y });
        }
      }
    }
  }

  renderer.render(surface, placements, slabById, {
    highlightSeam,
    showCracks: state.view === 'layout' && showCracks,
    showOpenings,
    crackPolylines,
    cutLines,
  });
}

export function makeOpening(type: OpeningType, x: number, y: number, w: number, h: number): Opening {
  const margin = type === 'socket' ? 100 : 20;
  return {
    id: `op-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`,
    type,
    x,
    y,
    width: w,
    height: h,
    margin,
  };
}
