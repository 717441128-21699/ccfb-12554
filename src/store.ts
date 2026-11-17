import type { Slab, Surface, LayoutSolution, LayoutMode, Crack } from './types';

const KEY = 'slab-vein-layout-v1';

export interface AppState {
  slabs: Slab[];
  surfaces: Surface[];
  currentSurfaceId: string;
  solution: LayoutSolution | null;
  options: { mode: LayoutMode; rot90: boolean; beamWidth: number; toleranceMm: number };
}

export function emptyState(): AppState {
  return {
    slabs: [],
    surfaces: [],
    currentSurfaceId: '',
    solution: null,
    options: { mode: 'continue', rot90: false, beamWidth: 8, toleranceMm: 3 }
  };
}

export function saveState(state: AppState): void {
  try {
    const slim = {
      ...state,
      slabs: state.slabs.map((s) => ({ ...s, frontCanvas: undefined, frontImageData: undefined }))
    };
    localStorage.setItem(KEY, JSON.stringify(slim));
  } catch (e) {
    console.warn('状态持久化失败（可能超出 localStorage 容量）', e);
  }
}

export function loadState(): AppState | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AppState;
    if (!Array.isArray(parsed.slabs) || !Array.isArray(parsed.surfaces)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function uid(prefix = 'id'): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

export function makeCrack(id: string, points: { x: number; y: number }[]): Crack {
  return { id, points };
}
