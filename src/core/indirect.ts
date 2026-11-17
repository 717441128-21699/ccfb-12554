// 一次间接反射:把墙面/顶面离散成朗伯面片,先求各面片的直射入射,
// 再把面片出射度叠加到接收点。只计一次反弹(室内照明工程通用近似)。
// 地面反射对水平工作面的一次反弹为零(几何上 cos 项为 0),故不参与;
// 地面反射率仍用于 3D 渲染与报告展示。
import type { Luminaire, PlacedLight, RoomConfig } from './types.ts';
import { clamp, rad2deg } from './math.ts';
import {
  candelaAt,
  directIlluminanceNormal,
  lumenScale,
  luminousArea as lumArea,
} from './photometry.ts';

export interface SurfacePatch {
  center: [number, number, number];
  normal: [number, number, number];
  area: number;
  reflectance: number;
  wall: 0 | 1 | 2 | 3 | 4; // 4=顶面
  /** 一次反弹出射度 lm/m² */
  exitance: number;
}

export interface PatchOptions {
  segmentsU: number; // 每面墙沿墙分段
  segmentsY: number; // 墙面竖向分段
  ceilingDiv: number; // 顶面每边分段
}

export const DEFAULT_PATCH_OPTIONS: PatchOptions = {
  segmentsU: 8,
  segmentsY: 4,
  ceilingDiv: 6,
};

function centerInOpening(room: RoomConfig, wall: number, u: number, y: number): boolean {
  // 顶面(wall=4)不开洞,直接放行
  if (wall === 4) return false;
  for (const o of room.openings) {
    if (o.wall !== wall) continue;
    if (Math.abs(u - o.u) <= o.width / 2 && y >= o.bottom && y <= o.bottom + o.height) return true;
  }
  return false;
}

/** 生成面片并计算每片的直射入射 → 出射度 */
export function buildPatches(
  room: RoomConfig,
  lights: PlacedLight[],
  luminaires: Map<string, Luminaire>,
  opts: PatchOptions = DEFAULT_PATCH_OPTIONS,
): SurfacePatch[] {
  const { width: w, depth: d, height: H } = room;
  const patches: SurfacePatch[] = [];

  // 四面墙:wall 0=+Z 北,1=+X 东,2=-Z 南,3=-X 西
  const wallDefs: Array<{
    wall: 0 | 1 | 2 | 3;
    length: number;
    point: (u: number, y: number) => [number, number, number];
    normal: [number, number, number];
  }> = [
    {
      wall: 0, length: w,
      point: (u, y) => [u, y, d / 2],
      normal: [0, 0, -1],
    },
    {
      wall: 1, length: d,
      point: (u, y) => [w / 2, y, -u],
      normal: [-1, 0, 0],
    },
    {
      wall: 2, length: w,
      point: (u, y) => [-u, y, -d / 2],
      normal: [0, 0, 1],
    },
    {
      wall: 3, length: d,
      point: (u, y) => [-w / 2, y, u],
      normal: [1, 0, 0],
    },
  ];

  for (const def of wallDefs) {
    const du = def.length / opts.segmentsU;
    const dy = H / opts.segmentsY;
    const area = du * dy;
    for (let i = 0; i < opts.segmentsU; i++) {
      for (let j = 0; j < opts.segmentsY; j++) {
        const u = -def.length / 2 + (i + 0.5) * du;
        const y = (j + 0.5) * dy;
        if (centerInOpening(room, def.wall, u, y)) continue;
        const center = def.point(u, y);
        let E = 0;
        for (const light of lights) {
          const lum = luminaires.get(light.luminaireId);
          if (!lum) continue;
          E += directIlluminanceNormal(light, lum, center, def.normal, room);
        }
        patches.push({
          center,
          normal: def.normal,
          area,
          reflectance: room.reflectance.wall,
          wall: def.wall,
          exitance: E * room.reflectance.wall,
        });
      }
    }
  }

  // 顶面:直射几乎为零(灯具向下),主要接收墙面反弹光后再反射到工作面,
  // 补上「墙→顶」这一路径以还原窄光束筒灯的主要间接贡献。
  const cw = w / opts.ceilingDiv;
  const cd = d / opts.ceilingDiv;
  const cArea = cw * cd;
  for (let i = 0; i < opts.ceilingDiv; i++) {
    for (let k = 0; k < opts.ceilingDiv; k++) {
      const center: [number, number, number] = [
        -w / 2 + (i + 0.5) * cw,
        H,
        -d / 2 + (k + 0.5) * cd,
      ];
      // 顶面法线朝室内(向下);接收墙面入射时用朝上法线 [0,1,0]
      const recvNormal: [number, number, number] = [0, 1, 0];
      let E = 0;
      for (const light of lights) {
        const lum = luminaires.get(light.luminaireId);
        if (!lum) continue;
        E += directIlluminanceNormal(light, lum, center, recvNormal, room);
      }
      E += indirectIlluminance(patches, center, recvNormal);
      patches.push({
        center,
        normal: [0, -1, 0],
        area: cArea,
        reflectance: room.reflectance.ceiling,
        wall: 4,
        exitance: E * room.reflectance.ceiling,
      });
    }
  }
  return patches;
}

/** 朗伯面片对接收点的入射照度(供面片之间互反射复用) */
function patchToPoint(
  q: SurfacePatch,
  p: [number, number, number],
  normal: [number, number, number],
): number {
  if (q.exitance <= 1e-6) return 0;
  const dx = p[0] - q.center[0];
  const dy = p[1] - q.center[1];
  const dz = p[2] - q.center[2];
  const r2 = dx * dx + dy * dy + dz * dz;
  if (r2 < 1e-8) return 0;
  const r = Math.sqrt(r2);
  const cosPatch = (dx * q.normal[0] + dy * q.normal[1] + dz * q.normal[2]) / r;
  const cosRec = (dx * normal[0] + dy * normal[1] + dz * normal[2]) / r;
  if (cosPatch <= 0 || cosRec <= 0) return 0;
  return (q.exitance * cosPatch * cosRec * q.area) / (Math.PI * r2);
}

/** 面片对任意接收点的一次反射照度(勒克斯)。
 * 面片法线朝室内;接收点法线按自身朝向传入(工作面朝上)。 */
export function indirectIlluminance(
  patches: SurfacePatch[],
  p: [number, number, number],
  normal: [number, number, number],
): number {
  let sum = 0;
  for (const q of patches) sum += patchToPoint(q, p, normal);
  return sum;
}

// ---------------- UGR 统一眩光值(CIE 117 / GB 50034 简化) ----------------

// Guth 位置指数查表:行=水平角 H(0..90),列=竖直角 V(0..90),步长 10°
const GUTH_H = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90];
const GUTH_V = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90];
const GUTH_P: number[][] = [
  [NaN, 5.50, 3.50, 2.50, 2.00, 1.70, 1.45, 1.30, 1.20, 1.15],
  [6.50, 5.00, 3.20, 2.40, 1.90, 1.62, 1.40, 1.26, 1.18, 1.12],
  [7.50, 5.50, 3.50, 2.50, 2.00, 1.70, 1.45, 1.30, 1.20, 1.13],
  [8.50, 6.00, 3.80, 2.70, 2.10, 1.75, 1.50, 1.33, 1.22, 1.15],
  [9.50, 6.50, 4.20, 2.90, 2.25, 1.85, 1.56, 1.37, 1.25, 1.17],
  [10.5, 7.00, 4.60, 3.10, 2.40, 1.95, 1.62, 1.41, 1.28, 1.18],
  [11.5, 7.50, 5.00, 3.30, 2.55, 2.05, 1.68, 1.45, 1.31, 1.20],
  [12.5, 8.00, 5.40, 3.50, 2.70, 2.15, 1.75, 1.50, 1.34, 1.22],
  [13.5, 8.50, 5.80, 3.70, 2.85, 2.25, 1.82, 1.55, 1.37, 1.24],
  [14.5, 9.00, 6.20, 3.90, 3.00, 2.35, 1.90, 1.60, 1.40, 1.25],
];

function guthPositionIndex(hDeg: number, vDeg: number): number {
  const h = clamp(hDeg, 0, 90);
  const v = clamp(vDeg, 0, 90);
  // 双线性插值;H=0 行 V=0 无定义,退到 V=10 列
  const hi = (x: number, xs: number[]): [number, number, number] => {
    if (x <= xs[0]) return [0, 0, 0];
    if (x >= xs[xs.length - 1]) return [xs.length - 2, xs.length - 1, 1];
    let lo = 0;
    let hi2 = xs.length - 1;
    while (hi2 - lo > 1) {
      const mid = (lo + hi2) >> 1;
      if (xs[mid] <= x) lo = mid;
      else hi2 = mid;
    }
    return [lo, hi2, (x - xs[lo]) / (xs[hi2] - xs[lo])];
  };
  const [r0, r1, tr] = hi(h, GUTH_H);
  const [c0, c1, tc] = hi(v, GUTH_V);
  const cell = (r: number, c: number): number => {
    const val = GUTH_P[r][c];
    return Number.isNaN(val) ? GUTH_P[r][1] : val;
  };
  const a = cell(r0, c0) + (cell(r0, c1) - cell(r0, c0)) * tc;
  const b = cell(r1, c0) + (cell(r1, c1) - cell(r1, c0)) * tc;
  return a + (b - a) * tr;
}

export interface UGROptions {
  eyeHeight: number;
  viewDir: [number, number, number]; // 水平视线方向(单位向量)
}

/** 统一眩光值。观察者默认位于房间纵向 1/4 处、视线朝 +Z 墙 */
export function computeUGR(
  room: RoomConfig,
  lights: PlacedLight[],
  luminaires: Map<string, Luminaire>,
  patches: SurfacePatch[],
  opts: UGROptions = { eyeHeight: 1.2, viewDir: [0, 0, 1] },
): { ugr: number; observer: [number, number, number]; terms: number } {
  const observer: [number, number, number] = [0, opts.eyeHeight, -room.depth / 4];

  // 背景亮度:观察者眼睛处垂直面总照度 / π
  let Evert = indirectIlluminance(patches, observer, opts.viewDir);
  for (const light of lights) {
    const lum = luminaires.get(light.luminaireId);
    if (!lum) continue;
    Evert += directIlluminanceNormal(light, lum, observer, opts.viewDir, room);
  }
  const Lb = Evert / Math.PI;
  if (Lb <= 1e-4) return { ugr: 0, observer, terms: 0 };

  let sum = 0;
  let terms = 0;
  for (const light of lights) {
    const lum = luminaires.get(light.luminaireId);
    if (!lum) continue;
    const [lx, ly, lz] = light.position;
    const dx = lx - observer[0];
    const dy = ly - observer[1];
    const dz = lz - observer[2];
    const r = Math.hypot(dx, dy, dz);
    if (r < 0.3) continue;
    const hLen = Math.hypot(dx, dz);
    const hDot = hLen < 1e-6 ? 1 : (dx * opts.viewDir[0] + dz * opts.viewDir[2]) / hLen;
    if (hDot < -1e-6) continue; // 身后灯具不计入视野
    const hDeg = hLen < 1e-6 ? 0 : rad2deg(Math.acos(clamp(hDot, -1, 1)));
    const vDeg = rad2deg(Math.asin(clamp(dy / r, -1, 1)));
    if (vDeg <= 0.5) continue;

    // 灯具朝观察者方向的光强:从灯具向下轴量 θ(观察者在灯下方 → 小角度)
    const theta = rad2deg(Math.acos(clamp(dy / r, -1, 1)));
    const azimuth = rad2deg(Math.atan2(-dx, -dz));
    const Iv = candelaAt(lum.ies, theta, azimuth, light.yawDeg) * lumenScale(lum);
    // 发光面投影面积(按视线仰角投影)
    const area = lumArea(lum);
    const proj = area * clamp(dy / r, 0, 1);
    if (proj <= 1e-6) continue;
    const Ls = Iv / proj;
    const P = guthPositionIndex(hDeg, vDeg);
    sum += (Ls * Ls) / (P * P);
    terms++;
  }
  if (sum <= 0) return { ugr: 0, observer, terms: 0 };
  const ugr = 8 * Math.log10((0.25 / Lb) * sum);
  return { ugr, observer, terms };
}
