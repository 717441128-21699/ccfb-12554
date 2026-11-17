// 全局共享类型定义。坐标约定:Y 向上,单位米;房间地面中心在 XZ 原点。
import type { Vec3 } from './math.ts';

/** 解析后的 IES 配光文件 */
export interface IESData {
  fileName: string;
  label: string;
  manufacturer: string;
  catalogNumber: string;
  lamp: string;
  nLamps: number;
  lumensPerLamp: number;
  multiplier: number;
  nVert: number;
  nHoriz: number;
  photometricType: number; // 1=C 型(室内最常见),2=B 型,3=A 型
  unitsType: number; // 1=英尺 2=米
  openingWidth: number;
  openingLength: number;
  openingHeight: number;
  ballastFactor: number;
  inputWatts: number;
  vertAngles: number[]; // 垂直角 θ,度(0=灯具正下方)
  horizAngles: number[]; // 水平角 φ,度
  /** candela[horizIndex][vertIndex],已乘 multiplier */
  candela: number[][];
}

/** 灯具库条目 = IES 数据 + 业务字段 */
export interface Luminaire {
  id: string;
  ies: IESData;
  /** 额定输入光通量(流明),用于按灯具实际功率缩放配光 */
  ratedLumens: number;
  /** 积分得到的配光总通量(基于 candela 表) */
  integratedLumens: number;
  peakCandela: number;
}

/** 房间内的一次反射面材质 */
export interface SurfaceMaterials {
  floor: number; // 反射率 0..1
  ceiling: number;
  wall: number;
}

/** 门窗洞口(开在墙上,参与遮挡;玻璃按透光率处理) */
export interface Opening {
  id: string;
  wall: 0 | 1 | 2 | 3; // 0=+Z 北,1=+X 东,2=-Z 南,3=-X 西
  /** 沿墙方向的中心坐标(米) */
  u: number;
  /** 洞口底边高度(米) */
  bottom: number;
  width: number;
  height: number;
  kind: 'window' | 'door';
  /** 玻璃透光率(门=1 视为全开洞口) */
  transmittance: number;
}

export interface RoomConfig {
  width: number; // X 方向,米
  depth: number; // Z 方向,米
  height: number; // Y 方向,米
  workplaneHeight: number; // 工作面高度,米
  reflectance: SurfaceMaterials;
  openings: Opening[];
}

/** 布放在房间里的一盏灯 */
export interface PlacedLight {
  id: string;
  luminaireId: string;
  position: Vec3;
  /** 绕 Y 轴朝向(度),仅对非轴对称灯具有意义 */
  yawDeg: number;
  /** 0..1 的调光系数 */
  dimmer: number;
}

export interface GridConfig {
  nx: number; // X 方向采样格数
  nz: number; // Z 方向采样格数
}

/** 单点照度计算结果(勒克斯) */
export interface IllumPoint {
  x: number;
  z: number;
  direct: number;
  indirect: number;
  total: number;
}

export interface IllumMetrics {
  average: number; // 平均照度 lx
  min: number;
  max: number;
  uniformityMin: number; // 最小照度/平均照度 (U0)
  uniformityAvg: number; // 平均/最大,辅助参考
  /** 统一眩光值 UGR(GB 50034 简化计算) */
  ugr: number;
  /** 眩光计算的观察位置 */
  observer: Vec3;
  pointCount: number;
}

export interface IllumResult {
  points: IllumPoint[];
  nx: number;
  nz: number;
  metrics: IllumMetrics;
  elapsedMs: number;
}
