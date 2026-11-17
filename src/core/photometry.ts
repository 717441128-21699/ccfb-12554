// 配光查询与单点直射照度。所有灯默认竖直向下安装(商业吸顶/嵌入灯),
// yaw 仅决定非轴对称灯具绕 Y 轴的朝向。
import type { IESData, Luminaire, PlacedLight, RoomConfig } from './types.ts';
import { clamp, interp1, rad2deg } from './math.ts';

/** 把世界方位角(度,0=+Z,顺时针到 +X)折叠进 IES 水平角表的覆盖范围 */
function foldHoriz(ies: IESData, worldAzimuthDeg: number, yawDeg: number): number {
  let h = ((worldAzimuthDeg - yawDeg) % 360 + 360) % 360;
  if (ies.nHoriz === 1) return ies.horizAngles[0];
  const span = ies.horizAngles[ies.nHoriz - 1] - ies.horizAngles[0];
  const start = ies.horizAngles[0];
  if (span >= 359.999) return clamp(h, start, start + span);
  if (span <= 90.001) {
    // 四分之一对称:折叠到 [0,90]
    h = h % 90;
    if (h < 0) h += 90;
    return clamp(h, start, start + span);
  }
  if (span <= 180.001) {
    // 半平面对称:折叠到 [0,180]
    if (h > 180) h = 360 - h;
    return clamp(h, start, start + span);
  }
  return clamp(h, start, start + span);
}

/** 查指定方向的光强(cd),theta 为与灯具向下轴的夹角(度) */
export function candelaAt(
  ies: IESData,
  thetaDeg: number,
  worldAzimuthDeg: number,
  yawDeg = 0,
): number {
  const theta = clamp(thetaDeg, ies.vertAngles[0], ies.vertAngles[ies.nVert - 1]);
  if (ies.nHoriz === 1) return interp1(ies.vertAngles, ies.candela[0], theta);
  const h = foldHoriz(ies, worldAzimuthDeg, yawDeg);
  // 在水平角之间选两行做线性插值
  const ha = ies.horizAngles;
  if (h <= ha[0]) return interp1(ies.vertAngles, ies.candela[0], theta);
  if (h >= ha[ha.length - 1]) {
    return interp1(ies.vertAngles, ies.candela[ha.length - 1], theta);
  }
  let lo = 0;
  let hi = ha.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ha[mid] <= h) lo = mid;
    else hi = mid;
  }
  const t = (h - ha[lo]) / (ha[hi] - ha[lo]);
  const a = interp1(ies.vertAngles, ies.candela[lo], theta);
  const b = interp1(ies.vertAngles, ies.candela[hi], theta);
  return a + (b - a) * t;
}

/** 灯具按额定流明相对配光测试流明的缩放系数 */
export function lumenScale(lum: Luminaire): number {
  return lum.integratedLumens > 1 ? lum.ratedLumens / lum.integratedLumens : 1;
}

export interface SurfaceHit {
  wall: 0 | 1 | 2 | 3;
  u: number; // 沿墙坐标(米)
  y: number; // 高度(米)
  t: number; // 射线参数 0..1
}

/** 求线段与房间四面墙的交点(最多一个,凸空间) */
export function hitWall(
  room: RoomConfig,
  from: [number, number, number],
  to: [number, number, number],
): SurfaceHit | null {
  const { width: w, depth: d, height: H } = room;
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const planes: Array<{ wall: 0 | 1 | 2 | 3; t: number; u: number; y: number }> = [];
  const tryPlane = (axis: 0 | 1, sign: 1 | -1, wall: 0 | 1 | 2 | 3) => {
    const coord = axis === 0 ? (sign * w) / 2 : (sign * d) / 2;
    const delta = axis === 0 ? dx : dz;
    const start = axis === 0 ? from[0] : from[2];
    if (Math.abs(delta) < 1e-12) return;
    const t = (coord - start) / delta;
    if (t <= 1e-6 || t >= 1 - 1e-6) return;
    const y = from[1] + dy * t;
    if (y < 0 || y > H) return;
    const u = axis === 0 ? from[2] + dz * t : from[0] + dx * t;
    planes.push({ wall, t, u, y });
  };
  tryPlane(0, 1, 1);
  tryPlane(0, -1, 3);
  tryPlane(1, 1, 0);
  tryPlane(1, -1, 2);
  if (!planes.length) return null;
  planes.sort((a, b) => a.t - b.t);
  return planes[0];
}

/** 交点是否落在门窗洞口内;返回透光率(0=未命中洞口) */
function openingTransmittance(room: RoomConfig, hit: SurfaceHit): number {
  for (const o of room.openings) {
    if (o.wall !== hit.wall) continue;
    if (
      Math.abs(hit.u - o.u) <= o.width / 2 &&
      hit.y >= o.bottom &&
      hit.y <= o.bottom + o.height
    ) {
      return o.transmittance;
    }
  }
  return 0;
}

export interface DirectResult {
  lux: number;
  candela: number;
  thetaDeg: number;
  distance: number;
  blocked: boolean;
}

/** 单盏灯对单个水平面点的直射照度(勒克斯)。
 *  E = I(θ,φ)·cosθ / r²,射线穿门窗时按 (1-透光率) 折减。 */
export function directIlluminance(
  light: PlacedLight,
  lum: Luminaire,
  px: number,
  py: number,
  pz: number,
  room: RoomConfig,
): DirectResult {
  const [lx, ly, lz] = light.position;
  const dx = px - lx;
  const dy = py - ly;
  const dz = pz - lz;
  const r2 = dx * dx + dy * dy + dz * dz;
  const r = Math.sqrt(r2);
  const cosInc = -dy / r; // 水平面法线朝上,光从上方来
  if (cosInc <= 0) {
    return { lux: 0, candela: 0, thetaDeg: 0, distance: r, blocked: true };
  }
  const thetaDeg = rad2deg(Math.acos(clamp(cosInc, -1, 1)));
  const azimuth = rad2deg(Math.atan2(dx, dz)); // 0=+Z
  const I =
    candelaAt(lum.ies, thetaDeg, azimuth, light.yawDeg) *
    lumenScale(lum) *
    light.dimmer;

  let factor = 1;
  let blocked = false;
  const hit = hitWall(room, light.position, [px, py, pz]);
  if (hit) {
    const T = openingTransmittance(room, hit);
    if (T > 0) {
      factor = 1 - T; // 透出室外的部分不参与室内直射
      blocked = T >= 0.999;
    } else {
      // 打到墙面上:灯与工作面点之间存在实墙遮挡(异常布局)
      factor = 0;
      blocked = true;
    }
  }
  return {
    lux: (I * cosInc / r2) * factor,
    candela: I,
    thetaDeg,
    distance: r,
    blocked,
  };
}

/** 供 3D 渲染/墙面照度复用:任意朝向接收点的直射照度 */
export function directIlluminanceNormal(
  light: PlacedLight,
  lum: Luminaire,
  p: [number, number, number],
  normal: [number, number, number],
  room: RoomConfig,
): number {
  const [lx, ly, lz] = light.position;
  const dx = p[0] - lx;
  const dy = p[1] - ly;
  const dz = p[2] - lz;
  const r2 = dx * dx + dy * dy + dz * dz;
  const r = Math.sqrt(r2);
  const nx = dx / r, ny = dy / r, nz = dz / r;
  const cosInc = -(nx * normal[0] + ny * normal[1] + nz * normal[2]);
  if (cosInc <= 0) return 0;
  // 配光查询用灯具向下轴的夹角(可能 >90°,如顶面受光)
  const thetaDeg = rad2deg(Math.acos(clamp(-ny, -1, 1)));
  const azimuth = rad2deg(Math.atan2(dx, dz));
  const I =
    candelaAt(lum.ies, thetaDeg, azimuth, light.yawDeg) *
    lumenScale(lum) *
    light.dimmer;
  const hit = hitWall(room, light.position, p);
  let factor = 1;
  if (hit) {
    const T = openingTransmittance(room, hit);
    factor = T > 0 ? 1 - T : 0;
  }
  // E = I·cos(入射角)/r²,入射角按接收面真实法线计算
  return (I * cosInc / r2) * factor;
}

/** IES 开口尺寸(米),unitsType=1 时原始单位为英尺 */
export function luminousArea(lum: Luminaire): number {
  const m = lum.ies.unitsType === 1 ? 0.3048 : 1;
  const w = lum.ies.openingWidth * m;
  const l = lum.ies.openingLength * m;
  if (w > 0.005 && l > 0.005) return w * l;
  // 缺尺寸时按通量估算等效发光面(参考亮度 30000 cd/m²)
  return Math.max(0.008, lum.ratedLumens / (Math.PI * 30000));
}

export function azElFromObserver(
  observer: [number, number, number],
  target: [number, number, number],
  viewDir: [number, number, number],
): { hDeg: number; vDeg: number; r: number } {
  const dx = target[0] - observer[0];
  const dy = target[1] - observer[1];
  const dz = target[2] - observer[2];
  const r = Math.hypot(dx, dy, dz);
  // 水平分量与视线方向的夹角
  const hl = Math.hypot(dx, dz) || 1e-9;
  const dotH = (dx * viewDir[0] + dz * viewDir[2]) / hl;
  const hDeg = rad2deg(Math.acos(clamp(dotH, -1, 1)));
  const vDeg = rad2deg(Math.asin(clamp(dy / r, -1, 1)));
  return { hDeg, vDeg, r };
}
