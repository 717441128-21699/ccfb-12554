// 工作面网格照度引擎:遍历采样点累加各灯直射与一次反射,并汇总统计指标。
import type {
  GridConfig,
  IllumMetrics,
  IllumPoint,
  IllumResult,
  Luminaire,
  PlacedLight,
  RoomConfig,
} from './types.ts';
import { directIlluminance } from './photometry.ts';
import { buildPatches, computeUGR, indirectIlluminance, DEFAULT_PATCH_OPTIONS } from './indirect.ts';

export interface EngineOptions {
  grid: GridConfig;
  includeIndirect: boolean;
}

export const DEFAULT_GRID: GridConfig = { nx: 32, nz: 32 };

export function computeIllumination(
  room: RoomConfig,
  lights: PlacedLight[],
  luminaires: Map<string, Luminaire>,
  options: EngineOptions = { grid: DEFAULT_GRID, includeIndirect: true },
): IllumResult {
  const t0 = performance.now();
  const { nx, nz } = options.grid;
  const { width: w, depth: d, workplaneHeight: wh } = room;

  const patches = options.includeIndirect
    ? buildPatches(room, lights, luminaires, DEFAULT_PATCH_OPTIONS)
    : [];

  const points: IllumPoint[] = new Array(nx * nz);
  let sum = 0;
  let min = Infinity;
  let max = 0;
  let idx = 0;
  const up: [number, number, number] = [0, 1, 0];

  for (let iz = 0; iz < nz; iz++) {
    const z = -d / 2 + ((iz + 0.5) / nz) * d;
    for (let ix = 0; ix < nx; ix++) {
      const x = -w / 2 + ((ix + 0.5) / nx) * w;
      let direct = 0;
      for (const light of lights) {
        const lum = luminaires.get(light.luminaireId);
        if (!lum) continue;
        direct += directIlluminance(light, lum, x, wh, z, room).lux;
      }
      const indirect = options.includeIndirect
        ? indirectIlluminance(patches, [x, wh, z], up)
        : 0;
      const total = direct + indirect;
      points[idx++] = { x, z, direct, indirect, total };
      sum += total;
      if (total < min) min = total;
      if (total > max) max = total;
    }
  }
  if (!Number.isFinite(min)) min = 0;

  const average = sum / points.length;
  const ugrResult = computeUGR(room, lights, luminaires, patches);

  const metrics: IllumMetrics = {
    average,
    min,
    max,
    uniformityMin: average > 0 ? min / average : 0,
    uniformityAvg: max > 0 ? average / max : 0,
    ugr: ugrResult.ugr,
    observer: ugrResult.observer,
    pointCount: points.length,
  };

  return {
    points,
    nx,
    nz,
    metrics,
    elapsedMs: performance.now() - t0,
  };
}

/** 伪彩色映射:蓝→青→绿→黄→红,输入为归一化 0..1 */
export function falseColor(t: number): [number, number, number] {  const stops: Array<[number, [number, number, number]]> = [
    [0.0, [40, 48, 140]],
    [0.25, [30, 140, 210]],
    [0.5, [60, 190, 90]],
    [0.75, [240, 200, 40]],
    [1.0, [220, 50, 40]],
  ];
  const x = Math.max(0, Math.min(1, t));
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    if (x <= t1) {
      const k = (x - t0) / (t1 - t0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * k),
        Math.round(c0[1] + (c1[1] - c0[1]) * k),
        Math.round(c0[2] + (c1[2] - c0[2]) * k),
      ];
    }
  }
  return stops[stops.length - 1][1];
}

/** 照度数组的分位数(0..1),用于自动色标,避免被局部峰值压扁整体色阶 */
export function percentileLux(result: IllumResult, q: number): number {
  const values = result.points.map((p) => p.total).sort((a, b) => a - b);
  if (!values.length) return 1;
  const idx = Math.min(values.length - 1, Math.max(0, Math.round(q * (values.length - 1))));
  return Math.max(1, values[idx]);
}
