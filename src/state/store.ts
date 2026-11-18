import type { CutPlan, LayoutPlan, Opening, Slab, Surface } from '../core/types';

export interface AppState {
  slabs: Slab[];
  surfaces: Surface[];
  activeSurfaceId: string;
  plans: Record<string, LayoutPlan>;
  cutPlans: Record<string, CutPlan>;
  selectedSlabId: string | null;
  view: 'layout' | 'cuts';
}

const KEY = 'slab-vein-layout-state-v1';

type Listener = (s: AppState) => void;

/** 极简响应式 store：单一不可变状态 + 订阅通知 + localStorage 持久化 */
class Store {
  private state: AppState;
  private listeners = new Set<Listener>();

  constructor() {
    this.state = this.load() ?? this.freshState();
  }

  private freshState(): AppState {
    return {
      slabs: [],
      surfaces: [
        {
          id: 'wall-1',
          kind: 'wall',
          name: '客厅背景墙',
          width: 6400,
          height: 2400,
          openings: [],
        },
      ],
      activeSurfaceId: 'wall-1',
      plans: {},
      cutPlans: {},
      selectedSlabId: null,
      view: 'layout',
    };
  }

  private load(): AppState | null {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as AppState;
      // 纹理 URL（dataURL/objectURL）不持久化，载入后标记需要重新导入
      return parsed;
    } catch {
      return null;
    }
  }

  private persist(): void {
    try {
      // 图片 dataURL 可能很大，持久化时剥离，仅保留几何与特征
      const slim: AppState = {
        ...this.state,
        slabs: this.state.slabs.map((s) => ({
          ...s,
          images: { front: { ...s.images.front, url: '' } },
        })),
      };
      localStorage.setItem(KEY, JSON.stringify(slim));
    } catch {
      // 配额超限时静默降级，本次会话状态仍可用
    }
  }

  getState(): AppState {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private update(mut: (draft: AppState) => void): void {
    const draft: AppState = structuredClone(this.state);
    mut(draft);
    this.state = draft;
    this.persist();
    this.listeners.forEach((fn) => fn(this.state));
  }

  setSlabs(slabs: Slab[]): void {
    this.update((d) => {
      d.slabs = slabs;
      d.selectedSlabId = slabs[0]?.id ?? null;
    });
  }

  addSlabs(extra: Slab[]): void {
    this.update((d) => {
      d.slabs.push(...extra);
      if (!d.selectedSlabId && extra[0]) d.selectedSlabId = extra[0].id;
    });
  }

  removeSlab(id: string): void {
    this.update((d) => {
      d.slabs = d.slabs.filter((s) => s.id !== id);
      if (d.selectedSlabId === id) d.selectedSlabId = d.slabs[0]?.id ?? null;
    });
  }

  setActiveSurface(id: string): void {
    this.update((d) => {
      d.activeSurfaceId = id;
    });
  }

  updateSurface(surface: Surface): void {
    this.update((d) => {
      const i = d.surfaces.findIndex((s) => s.id === surface.id);
      if (i >= 0) d.surfaces[i] = surface;
    });
  }

  addOpening(surfaceId: string, opening: Opening): void {
    this.update((d) => {
      const s = d.surfaces.find((x) => x.id === surfaceId);
      s?.openings.push(opening);
    });
  }

  removeOpening(surfaceId: string, openingId: string): void {
    this.update((d) => {
      const s = d.surfaces.find((x) => x.id === surfaceId);
      if (s) s.openings = s.openings.filter((o) => o.id !== openingId);
    });
  }

  setPlan(surfaceId: string, plan: LayoutPlan): void {
    this.update((d) => {
      d.plans[surfaceId] = plan;
    });
  }

  setCutPlan(surfaceId: string, cut: CutPlan): void {
    this.update((d) => {
      d.cutPlans[surfaceId] = cut;
    });
  }

  setView(view: AppState['view']): void {
    this.update((d) => {
      d.view = view;
    });
  }

  selectSlab(id: string | null): void {
    this.update((d) => {
      d.selectedSlabId = id;
    });
  }
}

export const store = new Store();
