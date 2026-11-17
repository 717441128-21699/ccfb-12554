// 全局数据模型 —— 尺寸单位统一为毫米，坐标原点在展开图左上角，y 轴向下

export interface Vec2 {
  x: number;
  y: number;
}

export interface Crack {
  id: string;
  /** 板面局部坐标（毫米）折线 */
  points: Vec2[];
}

export type SurfaceKind = 'wall' | 'floor' | 'countertop';

export type OpeningType = 'door' | 'window' | 'socket';

export interface Opening {
  id: string;
  type: OpeningType;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Surface {
  id: string;
  kind: SurfaceKind;
  name: string;
  widthMm: number;
  heightMm: number;
  openings: Opening[];
}

export interface Slab {
  id: string;
  /** 板号，如 A-03 */
  code: string;
  /** 荒料号 */
  blockId: string;
  /** 同一荒料内的切割顺序，从 1 开始 */
  cutIndex: number;
  widthMm: number;
  heightMm: number;
  imageW: number;
  imageH: number;
  frontDataUrl: string;
  backDataUrl?: string;
  cracks: Crack[];
  /** 运行时缓存，不持久化 */
  frontCanvas?: HTMLCanvasElement;
  frontImageData?: ImageData;
}

/**
 * 排版姿态。
 * rot90: 是否先在板坐标系顺时针旋转 90°
 * flip: 旋转之后的翻转序号
 *   0 = 原样  1 = 水平镜像（书本对开）  2 = 旋转180°  3 = 垂直镜像
 */
export interface Placement {
  slabId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rot90: boolean;
  flip: 0 | 1 | 2 | 3;
}

export interface GridCell {
  id: number;
  col: number;
  row: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 完全落在洞口中，不需要板覆盖 */
  skip: boolean;
  openingIds: string[];
}

export interface SeamReport {
  id: string;
  kind: 'vertical' | 'horizontal';
  /** 接缝在展开图中的固定坐标（竖缝 x / 横缝 y） */
  at: number;
  start: number;
  length: number;
  bestOffsetMm: number;
  meanDiff: number;
  withinTolerance: boolean;
  slabA: string;
  slabB: string;
}

export interface CutLine {
  from: Vec2;
  to: Vec2;
  reason: string;
}

export interface SlabCutPlan {
  slabId: string;
  code: string;
  globalOrder: number;
  /** 每一步的刀路，板面局部坐标 */
  steps: { order: number; action: string; lines: CutLine[] }[];
  openingCuts: { opening: Opening; localRect: { x: number; y: number; w: number; h: number } }[];
  crackWarnings: string[];
}

export type LayoutMode = 'continue' | 'bookmatch';

export interface LayoutSolution {
  surfaceId: string;
  mode: LayoutMode;
  rot90: boolean;
  placements: (Placement & { cellId: number })[];
  seams: SeamReport[];
  cutPlans: SlabCutPlan[];
  cells: GridCell[];
  /** 参与排版的板毛面积 mm² */
  slabAreaTotal: number;
  /** 墙面实际需要覆盖的面积 mm² */
  neededCoverage: number;
  /** 出材率 0..1 */
  utilization: number;
  batchSlabCount: number;
  usedSlabCount: number;
  remainingSlabIds: string[];
  crackViolations: string[];
  uncoveredCells: number;
  solveMs: number;
  beamWidth: number;
  toleranceMm: number;
}
