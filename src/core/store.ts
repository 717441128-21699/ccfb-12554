// 全局应用状态(轻量发布订阅),UI 与渲染器、计算 Worker 都围绕它协作。
import type { Luminaire, PlacedLight, RoomConfig, IllumResult, GridConfig } from './types.ts';

export interface AppState {
  luminaires: Luminaire[];
  lights: PlacedLight[];
  room: RoomConfig;
  grid: GridConfig;
  includeIndirect: boolean;
  selectedLightId: string | null;
  /** 灯具库中当前选中、用于布置的灯具 */
  activeLuminaireId: string | null;
  result: IllumResult | null;
  computing: boolean;
  /** 伪彩色显示开关(关=实体材质预览) */
  falseColor: boolean;
  /** 照度色标上限(lx),0=自动 */
  colorScaleMax: number;
}

type Listener = (state: AppState) => void;

export const DEFAULT_ROOM: RoomConfig = {
  width: 8,
  depth: 6,
  height: 3,
  workplaneHeight: 0.75,
  reflectance: { floor: 0.2, ceiling: 0.7, wall: 0.5 },
  openings: [],
};

export function createStore() {
  const state: AppState = {
    luminaires: [],
    lights: [],
    room: structuredClone(DEFAULT_ROOM),
    grid: { nx: 32, nz: 32 },
    includeIndirect: true,
    selectedLightId: null,
    activeLuminaireId: null,
    result: null,
    computing: false,
    falseColor: true,
    colorScaleMax: 0,
  };
  const listeners = new Set<Listener>();
  const emit = (): void => {
    for (const l of listeners) l(state);
  };
  return {
    state,
    subscribe(fn: Listener): () => void {
      listeners.add(fn);
      fn(state);
      return () => listeners.delete(fn);
    },
    /** 局部更新并通知 */
    update(patch: Partial<AppState>): void {
      Object.assign(state, patch);
      emit();
    },
    mutate(fn: (draft: AppState) => void): void {
      fn(state);
      emit();
    },
    emit,
  };
}

export type Store = ReturnType<typeof createStore>;

let idCounter = 0;
export function uid(prefix = 'id'): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}
