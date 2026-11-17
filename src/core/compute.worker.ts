// 照度计算 Worker:主线程只负责交互与渲染,重计算在这里进行。
import { computeIllumination } from './engine.ts';
import type { GridConfig, IllumResult, Luminaire, PlacedLight, RoomConfig } from './types.ts';

export interface ComputeRequest {
  seq: number;
  room: RoomConfig;
  lights: PlacedLight[];
  luminaires: Luminaire[];
  grid: GridConfig;
  includeIndirect: boolean;
}
export interface ComputeResponse {
  seq: number;
  result: IllumResult;
}

self.onmessage = (ev: MessageEvent<ComputeRequest>): void => {
  const req = ev.data;
  const map = new Map(req.luminaires.map((l) => [l.id, l]));
  const result = computeIllumination(req.room, req.lights, map, {
    grid: req.grid,
    includeIndirect: req.includeIndirect,
  });
  const res: ComputeResponse = { seq: req.seq, result };
  (self as unknown as Worker).postMessage(res);
};
