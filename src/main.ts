import './styles.css';
import { emptyState, loadState, saveState, type AppState } from './store';
import { demoSurfaces, generateDemoSlabs } from './demo';
import { renderSlabView } from './views/slabView';
import { renderSurfaceView } from './views/surfaceView';
import { renderLayoutView } from './views/layoutView';
import type { LayoutMode, Slab, Surface } from './types';
import { uid } from './store';

type Tab = 'slab' | 'surface' | 'layout';

class App {
  state: AppState = emptyState();
  private tab: Tab = 'slab';
  private main = document.getElementById('main')!;
  private topbarRight = document.getElementById('topbar-right')!;
  private cleanup: (() => void) | null = null;;

  constructor() {
    const saved = loadState();
    if (saved && saved.slabs.length > 0) {
      this.state = saved;
    } else {
      this.state.slabs = generateDemoSlabs();
      this.state.surfaces = demoSurfaces();
      this.state.currentSurfaceId = this.state.surfaces[0].id;
    }
    document.getElementById('tabs')!.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button[data-tab]') as HTMLButtonElement | null;
      if (!btn) return;
      this.tab = btn.dataset.tab as Tab;
      this.render();
    });
    window.addEventListener('resize', () => this.render());
    this.renderTopbar();
    this.render();
  }

  private renderTopbar() {
    this.topbarRight.innerHTML = '';
    const demoBtn = document.createElement('button');
    demoBtn.className = 'btn secondary';
    demoBtn.textContent = '重置为演示数据（20 块板）';
    demoBtn.onclick = () => {
      this.state.slabs = generateDemoSlabs();
      this.state.surfaces = demoSurfaces();
      this.state.currentSurfaceId = this.state.surfaces[0].id;
      this.state.solution = null;
      this.persist();
      this.toast('已生成 20 块演示大板与 3 张展开图', 'ok');
      this.render();
    };
    const clearBtn = document.createElement('button');
    clearBtn.className = 'btn danger';
    clearBtn.textContent = '清空全部数据';
    clearBtn.onclick = () => {
      if (!confirm('确认清空全部板材与展开图？')) return;
      this.state = emptyState();
      localStorage.removeItem('slab-vein-layout-v1');
      this.render();
    };
    this.topbarRight.append(demoBtn, clearBtn);
  }

  render() {
    document.querySelectorAll('#tabs button').forEach((b) => {
      b.classList.toggle('active', (b as HTMLElement).dataset.tab === this.tab);
    });
    this.cleanup?.();
    this.cleanup = null;
    this.main.innerHTML = '';
    if (this.tab === 'slab') this.cleanup = renderSlabView(this.main, this);
    if (this.tab === 'surface') this.cleanup = renderSurfaceView(this.main, this);
    if (this.tab === 'layout') this.cleanup = renderLayoutView(this.main, this);
  }

  persist() {
    saveState(this.state);
  }

  toast(msg: string, kind: 'ok' | 'error' | '' = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  get currentSurface(): Surface | undefined {
    return this.state.surfaces.find((s) => s.id === this.state.currentSurfaceId);
  }

  setOptions(patch: Partial<AppState['options']>) {
    Object.assign(this.state.options, patch);
    this.persist();
  }

  addSlab(slab: Slab) {
    this.state.slabs.push(slab);
    this.persist();
  }

  removeSlab(id: string) {
    this.state.slabs = this.state.slabs.filter((s) => s.id !== id);
    this.persist();
  }

  addSurface(kind: Surface['kind']) {
    const names: Record<Surface['kind'], string> = {
      wall: '新建墙面展开图',
      floor: '新建地面展开图',
      countertop: '新建台面展开图'
    };
    const s: Surface = { id: uid('surf'), kind, name: names[kind], widthMm: 3600, heightMm: 2400, openings: [] };
    this.state.surfaces.push(s);
    this.state.currentSurfaceId = s.id;
    this.persist();
    this.render();
  }

  selectSurface(id: string) {
    this.state.currentSurfaceId = id;
    this.state.solution = null;
    this.persist();
    this.render();
  }

  updateSurface(s: Surface) {
    const idx = this.state.surfaces.findIndex((x) => x.id === s.id);
    if (idx >= 0) this.state.surfaces[idx] = s;
    this.persist();
  }

  setMode(mode: LayoutMode) {
    this.state.options.mode = mode;
    this.persist();
  }
}

new App();
