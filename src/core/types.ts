/**
 * 全局领域模型 —— 尺寸单位统一为毫米(mm)，图像坐标归一化到 [0,1]。
 */

// ---------- 板 ----------

/** 板的正反面照片（dataURL 或对象URL，由导入层负责生成与回收） */
export interface SlabImages {
  /** 正面（饰面）整板照片 */
  front: ImageRef;
  /** 背面照片，用于辅助识别，可选 */
  back?: ImageRef;
}

export interface ImageRef {
  url: string;
  width: number; // 像素
  height: number;
}

/**
 * 一块大板。同一荒料切出的板共用 blockId，并按切割顺序 seq 编号；
 * 相邻 seq 的两片在切缝两侧天然对纹（镜像关系，即书本对开）。
 */
export interface Slab {
  id: string;
  /** 荒料/料号 */
  blockId: string;
  /** 同荒料内的切割顺序，从 0 开始 */
  seq: number;
  /** 成品尺寸，mm */
  width: number;
  height: number;
  images: SlabImages;
  /** 正面照上检测到的裂纹（归一化坐标，原点在板左上角） */
  cracks: Crack[];
  /** 正面照上采样得到的纹路特征（四条边 + 内部流向） */
  veins: VeinFeatures;
  /** 备注，如“有色胆需避” */
  note?: string;
}

/** 裂纹：折线，单位归一化 [0,1]（相对板宽/高） */
export interface Crack {
  id: string;
  points: Vec2[];
}

// ---------- 纹路特征 ----------

/**
 * 板的纹路特征。边签名是沿边等间距采样的“纹路横切位置”序列，
 * 用于接缝匹配；内部方向场用于渲染与流向评估。
 */
export interface VeinFeatures {
  /** 四条边的签名，采样点坐标已换算为 mm，沿边方向等间距 */
  edges: {
    left: EdgeSignature;
    right: EdgeSignature;
    top: EdgeSignature;
    bottom: EdgeSignature;
  };
  /**
   * 内部方向场，稀疏网格；vec 为纹路走向（单位向量，图像系 x→右 y→下）。
   * cellW/cellH 为网格间距(mm)。
   */
  field: DirectionField;
  /** 检测时的参数版本，便于后续失效重算 */
  version: number;
}

export interface EdgeSignature {
  /** 采样间距 mm */
  step: number;
  /** 该边长度 mm */
  length: number;
  /**
   * 每个采样点处纹路与边的交点：值为交点沿法线方向深入板内的距离(mm)。
   * 无纹路穿过记为 null。
   */
  crossings: (number | null)[];
  /** 交点处纹路切线方向（弧度，图像系），与 crossings 等长 */
  angles: (number | null)[];
}

export interface DirectionField {
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  /** 长度 cols*rows，每个格子一个单位方向；无纹路为 null */
  vecs: (Vec2 | null)[];
}

export interface Vec2 {
  x: number;
  y: number;
}

// ---------- 墙面 / 展开图 ----------

export type SurfaceKind = 'wall' | 'floor' | 'counter';

/** 矩形安装面（墙面、地面、台面的一块展开区域） */
export interface Surface {
  id: string;
  kind: SurfaceKind;
  name: string;
  width: number;
  height: number;
  /** 开口（门洞/窗洞）与插座，坐标相对安装面左上角，mm */
  openings: Opening[];
}

export type OpeningType = 'door' | 'window' | 'socket';

export interface Opening {
  id: string;
  type: OpeningType;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 安全避让距离 mm：板上裂纹进入该范围即判不合格（插座默认加大） */
  margin: number;
}

// ---------- 排版方案 ----------

/**
 * 板在安装面上的摆放。
 * 变换约定：先在板自身坐标系按 flipX 镜像，再旋转 rot（仅 0/90/180/270），
 * 最后平移到 (x,y)。x/y 为变换后板包围盒左上角在安装面中的位置。
 */
export interface Placement {
  id: string;
  slabId: string;
  x: number;
  y: number;
  width: number; // 变换后的占地尺寸
  height: number;
  rot: 0 | 90 | 180 | 270;
  flipX: boolean;
}

export interface LayoutPlan {
  id: string;
  surfaceId: string;
  placements: Placement[];
  /** 未被用上的板 id（库存剩余） */
  unusedSlabIds: string[];
  score: LayoutScore;
  /** 每条接缝的对纹明细，供 UI 高亮与报告使用 */
  seamReports: SeamReport[];
  /** 开孔避让违规（合格方案应为空） */
  violations: OpeningViolation[];
  createdAt: number;
  solveMs: number;
}

export interface LayoutScore {
  /** 综合得分，越小越好（加权代价） */
  total: number;
  /** 接缝纹路平均错位 mm */
  avgSeamOffset: number;
  /** 接缝纹路最大错位 mm */
  maxSeamOffset: number;
  /** 对纹连续性 0~1（角度+位置综合），越大越好，仅用于展示 */
  continuity: number;
  /** 出材率 0~1：安装面覆盖净面积 / 实际用板毛面积 */
  utilization: number;
  /** 用板数 */
  slabCount: number;
  /** 裁切弃料面积 mm² */
  wasteArea: number;
}

export interface SeamReport {
  /** 接缝两侧的 placement id，[a, b] */
  placements: [string, string];
  /** 接缝方向：竖直缝（左右相邻）或水平缝（上下相邻） */
  axis: 'vertical' | 'horizontal';
  /** 接缝在安装面中的固定坐标（x 或 y，mm） */
  at: number;
  /** 接缝长度 mm */
  length: number;
  /** 逐采样点错位量 mm（null = 该点一侧无纹路） */
  offsets: (number | null)[];
  avgOffset: number;
  maxOffset: number;
  /** 角度差均值（弧度） */
  avgAngleDelta: number;
  /** 是否满足 ≤ 阈值 */
  pass: boolean;
}

export interface OpeningViolation {
  openingId: string;
  placementId: string;
  /** 裂纹距开口避让区的最近距离 mm（负值表示侵入） */
  distance: number;
}

// ---------- 切割清单 ----------

/** 切割图中的一刀 */
export interface CutStep {
  order: number;
  placementId: string;
  slabId: string;
  /** 切割线段，坐标相对原始大板左上角，mm */
  from: Vec2;
  to: Vec2;
  /** 保留侧：切完后留下的矩形区域（相对原板） */
  keepRect: Rect;
  /** 本刀弃料面积 mm² */
  wasteArea: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CutPlan {
  surfaceId: string;
  steps: CutStep[];
  totalWasteArea: number;
  utilization: number;
}

// ---------- 求解参数 ----------

export interface SolveOptions {
  /** 接缝错位上限 mm，默认 3 */
  seamToleranceMm: number;
  /** 纹路采样间距 mm，默认 20 */
  sampleStepMm: number;
  /** 接缝留缝宽度 mm（排版时间距），默认 0（密拼） */
  gapMm: number;
  /** 仅使用同荒料相邻 seq 优先连纹，默认 true */
  preferAdjacentSeq: boolean;
  /** 每格保留的候选摆放数量，默认 4 */
  beamWidth: number;
  /** 求解超时 ms，默认 10000 */
  timeBudgetMs: number;
  /** 随机种子（候选剪枝抖动），默认固定保证可复现 */
  seed: number;
}

export const DEFAULT_SOLVE_OPTIONS: SolveOptions = {
  seamToleranceMm: 3,
  sampleStepMm: 20,
  gapMm: 0,
  preferAdjacentSeq: true,
  beamWidth: 4,
  timeBudgetMs: 10000,
  seed: 20261119,
};
