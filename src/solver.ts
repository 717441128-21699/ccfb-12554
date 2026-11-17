// 连纹排版求解器
// 按阅读顺序对网格格子做束搜索（beam search）：
// 每格枚举 未使用板 × 允许姿态，用左邻竖缝 + 上邻横缝的纹路匹配代价打分，保留前 K 条路径。

import { buildGrid, localToWorld, placedSize, polylineIntersectsRect, rectArea, worldToLocal } from './geometry';
import type {
  GridCell, LayoutMode, LayoutSolution, Opening, Placement, SeamReport,
  Slab, SlabCutPlan, Surface, Vec2
} from './types';
import { getEdge, matchEdges, TOLERANCE, type VeinFeatures } from './vein';

interface SolverOptions {
  mode: LayoutMode;
  rot90: boolean;
  beamWidth: number;
  toleranceMm: number;
}

interface PartialState {
  assignment: Map<number, Placement & { cellId: number }>;
  used: Set<string>;
  cost: number;
  seamCosts: number[];
  crackRelaxed: boolean;
}

const CRACK_MARGIN_MM: Record<Opening['type'], number> = {
  socket: 20,
  door: 10,
  window: 10
};

function emptySolution(
  surface: Surface,
  opts: SolverOptions,
  cells: GridCell[],
  activeCount: number,
  slabs: Slab[],
  t0: number
): LayoutSolution {
  return {
    surfaceId: surface.id,
    mode: opts.mode,
    rot90: opts.rot90,
    placements: [],
    seams: [],
    cutPlans: [],
    cells,
    slabAreaTotal: 0,
    neededCoverage: 1,
    utilization: 0,
    batchSlabCount: slabs.length,
    usedSlabCount: 0,
    remainingSlabIds: slabs.map((s) => s.id),
    crackViolations: [],
    uncoveredCells: activeCount,
    solveMs: Math.round(performance.now() - t0),
    beamWidth: opts.beamWidth,
    toleranceMm: opts.toleranceMm
  };
}

export function solveLayout(
  surface: Surface,
  slabs: Slab[],
  features: Map<string, VeinFeatures>,
  opts: SolverOptions
): LayoutSolution {
  const t0 = performance.now();
  const refSlab = slabs[0];
  // 网格按基准板尺寸划分；尺寸不同的板不参与自动排版（避免格子与板错位）
  const usableSlabs = slabs.filter(
    (s) => s.widthMm === refSlab.widthMm && s.heightMm === refSlab.heightMm
  );
  const cells = buildGrid(surface, refSlab.widthMm, refSlab.heightMm, opts.rot90);
  const active = cells.filter((c) => !c.skip);

  const flipsFor = (cell: GridCell): number[] => {
    if (opts.mode === 'bookmatch') return [cell.col % 2 === 0 ? 0 : 1];
    return [0];
  };

  const placementFor = (cell: GridCell, slab: Slab, flip: number): Placement & { cellId: number } => {
    const ps = placedSize(slab, opts.rot90);
    return {
      cellId: cell.id,
      slabId: slab.id,
      x: cell.x,
      y: cell.y,
      width: ps.w,
      height: ps.h,
      rot90: opts.rot90,
      flip: flip as 0 | 1 | 2 | 3
    };
  };

  const slabById = new Map(slabs.map((s) => [s.id, s]));

  /** 裂纹是否与任何洞口冲突（带安全边距） */
  const crackConflict = (cell: GridCell, p: Placement): string[] => {
    const slab = slabById.get(p.slabId)!;
    if (slab.cracks.length === 0) return [];
    const conflicts: string[] = [];
    for (const op of surface.openings) {
      if (!cell.openingIds.includes(op.id)) continue;
      const m = CRACK_MARGIN_MM[op.type];
      for (const crack of slab.cracks) {
        const worldPts = crack.points.map((pt) => localToWorld(pt, slab, p));
        if (polylineIntersectsRect(worldPts, op.x - m, op.y - m, op.width + 2 * m, op.height + 2 * m)) {
          conflicts.push(`${slab.code} 的裂纹与${op.label}（安全边距 ${m}mm）冲突`);
        }
      }
    }
    return conflicts;
  };

  /** 计算新放入格子与左邻、上邻之间的接缝代价 */
  const seamDelta = (cell: GridCell, p: Placement & { cellId: number }, state: PartialState) => {
    const slab = slabById.get(p.slabId)!;
    const f = features.get(slab.id);
    if (!f) return { cost: 0, reports: [] as SeamReport[] };
    const reports: SeamReport[] = [];
    let cost = 0;

    const left = active.find((c) => c.row === cell.row && Math.abs(c.x + c.width - cell.x) < 1e-6);
    const up = active.find((c) => c.col === cell.col && Math.abs(c.y + c.height - cell.y) < 1e-6);

    if (left) {
      const lp = state.assignment.get(left.id);
      if (lp) {
        const lSlab = slabById.get(lp.slabId)!;
        const lf = features.get(lp.slabId)!;
        const edgeA = getEdge(lf, lp.rot90, lp.flip, 'R');
        const edgeB = getEdge(f, p.rot90, p.flip, 'L');
        const m = matchEdges(edgeA, edgeB);
        cost += m.cost + blockPenalty(lSlab, slab);
        reports.push(makeSeam('vertical', cell.x, cell.y, Math.min(left.height, cell.height), m, lSlab, slab));
      }
    }
    if (up) {
      const upP = state.assignment.get(up.id);
      if (upP) {
        const upSlab = slabById.get(upP.slabId)!;
        const uf = features.get(upP.slabId)!;
        const edgeA = getEdge(uf, upP.rot90, upP.flip, 'B');
        const edgeB = getEdge(f, p.rot90, p.flip, 'T');
        const m = matchEdges(edgeA, edgeB);
        cost += m.cost * 0.8 + blockPenalty(upSlab, slab) * 0.8;
        reports.push(makeSeam('horizontal', cell.y, cell.x, Math.min(up.width, cell.width), m, upSlab, slab));
      }
    }
    return { cost, reports };
  };

  const blockPenalty = (a: Slab, b: Slab): number => {
    if (a.blockId === b.blockId && Math.abs(a.cutIndex - b.cutIndex) === 1) return -0.35;
    if (a.blockId === b.blockId) return -0.12;
    return 0.25; // 不同荒料硬拼，纹路体系不同，强惩罚
  };

  // ---- 束搜索 ----
  let beam: PartialState[] = [{ assignment: new Map(), used: new Set(), cost: 0, seamCosts: [], crackRelaxed: false }];

  if (usableSlabs.length === 0) {
    return emptySolution(surface, opts, cells, active.length, slabs, t0);
  }

  for (const cell of active) {
    const candidates: { state: PartialState; cell: GridCell; p: Placement & { cellId: number }; addCost: number; reports: SeamReport[]; crackMsgs: string[] }[] = [];

    for (const state of beam) {
      for (const slab of usableSlabs) {
        if (state.used.has(slab.id)) continue;
        for (const flip of flipsFor(cell)) {
          const p = placementFor(cell, slab, flip);
          const crackMsgs = crackConflict(cell, p);
          if (crackMsgs.length > 0 && !state.crackRelaxed) continue; // 硬约束：优先保证躲开裂纹
          const { cost, reports } = seamDelta(cell, p, state);
          const next: PartialState = {
            assignment: new Map(state.assignment).set(cell.id, p),
            used: new Set(state.used).add(slab.id),
            cost: state.cost + cost,
            seamCosts: [...state.seamCosts, cost],
            crackRelaxed: state.crackRelaxed || crackMsgs.length > 0
          };
          candidates.push({ state: next, cell, p, addCost: cost, reports, crackMsgs });
        }
      }
    }

    if (candidates.length === 0) {
      // 板不够或裂纹约束无解：放宽裂纹约束重试一次
      const relaxedBeam = beam.map((s) => ({ ...s, crackRelaxed: true }));
      beam = relaxedBeam;
      const retry: PartialState[] = [];
      for (const state of relaxedBeam) {
        for (const slab of usableSlabs) {
          if (state.used.has(slab.id)) continue;
          for (const flip of flipsFor(cell)) {
            const p = placementFor(cell, slab, flip);
            const { cost } = seamDelta(cell, p, state);
            retry.push({
              assignment: new Map(state.assignment).set(cell.id, p),
              used: new Set(state.used).add(slab.id),
              cost: state.cost + cost,
              seamCosts: [...state.seamCosts, cost],
              crackRelaxed: true
            });
          }
        }
      }
      if (retry.length === 0) break; // 板材数量不足，剩余格子留空
      retry.sort((a, b) => a.cost - b.cost);
      beam = retry.slice(0, opts.beamWidth);
      continue;
    }

    candidates.sort((a, b) => a.state.cost - b.state.cost);
    // 同一格去重（不同前缀可能收敛到同一组已用板组合，保留代价最低的）
    const seen = new Set<string>();
    const picked: PartialState[] = [];
    for (const c of candidates) {
      const key = [...c.state.used].sort().join('|') + '#' + c.cell.id;
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push(c.state);
      if (picked.length >= opts.beamWidth) break;
    }
    beam = picked;
  }

  const best = beam[0];
  const placements = best ? [...best.assignment.values()].sort((a, b) => a.cellId - b.cellId) : [];
  const uncoveredCells = active.length - placements.length;

  // ---- 重建接缝报告（每条物理接缝只统计一次） ----
  const tempState: PartialState = {
    assignment: new Map(placements.map((p) => [p.cellId, p])),
    used: new Set(placements.map((p) => p.slabId)),
    cost: 0, seamCosts: [], crackRelaxed: best?.crackRelaxed ?? false
  };
  const seams: SeamReport[] = [];
  const seamSeen = new Set<string>();
  for (const cell of active) {
    const p = tempState.assignment.get(cell.id);
    if (!p) continue;
    const { reports } = seamDelta(cell, p, tempState);
    for (const rep of reports) {
      // 竖缝用 x+起止，横缝用 y+起止，作为唯一键
      const key = `${rep.kind}:${rep.at.toFixed(1)}:${rep.start.toFixed(1)}:${rep.length.toFixed(1)}`;
      if (seamSeen.has(key)) continue;
      seamSeen.add(key);
      seams.push(rep);
    }
  }
  for (const s of seams) {
    s.withinTolerance = Math.abs(s.bestOffsetMm) <= opts.toleranceMm && s.meanDiff <= opts.toleranceMm;
  }

  // ---- 裂纹复核 ----
  const crackViolations: string[] = [];
  for (const p of placements) {
    const cell = cells.find((c) => c.id === p.cellId)!;
    crackViolations.push(...crackConflict(cell, p));
  }

  // ---- 出材率 ----
  // 口径（石材行业）：出材率 = 实铺净面积 ÷ 投板毛面积
  // 实铺净面积 = 已投板覆盖区域内，扣除洞口后的面积
  const openingsArea = surface.openings.reduce((sum, o) => sum + rectArea(o.width, o.height), 0);
  const wallGross = rectArea(surface.widthMm, surface.heightMm);
  const neededCoverage = Math.max(1, wallGross - openingsArea);
  const slabAreaTotal = placements.reduce((sum, p) => {
    const s = slabById.get(p.slabId)!;
    return sum + rectArea(s.widthMm, s.heightMm);
  }, 0);
  // 未铺满时（板不够），缺口面积不能算进有效产出
  const coveredGross = placements.reduce((sum, p) => {
    const cell = cells.find((c) => c.id === p.cellId)!;
    return sum + rectArea(cell.width, cell.height);
  }, 0);
  const missingGross = wallGross - coveredGross;
  const effectiveNet = Math.max(0, neededCoverage - missingGross);
  const utilization = effectiveNet / Math.max(1, slabAreaTotal);

  const cutPlans = buildCutPlans(surface, cells, placements, slabById);
  const usedIds = new Set(placements.map((p) => p.slabId));

  return {
    surfaceId: surface.id,
    mode: opts.mode,
    rot90: opts.rot90,
    placements,
    seams,
    cutPlans,
    cells,
    slabAreaTotal,
    neededCoverage,
    utilization,
    batchSlabCount: slabs.length,
    usedSlabCount: usedIds.size,
    remainingSlabIds: usableSlabs.filter((s) => !usedIds.has(s.id)).map((s) => s.id),
    crackViolations,
    uncoveredCells,
    solveMs: Math.round(performance.now() - t0),
    beamWidth: opts.beamWidth,
    toleranceMm: opts.toleranceMm
  };
}

function makeSeam(
  kind: SeamReport['kind'], at: number, start: number, length: number,
  m: ReturnType<typeof matchEdges>, a: Slab, b: Slab
): SeamReport {
  return {
    id: `${kind}-${at.toFixed(1)}-${start.toFixed(1)}`,
    kind,
    at,
    start,
    length,
    bestOffsetMm: m.offsetMm,
    meanDiff: m.meanDiffMm,
    withinTolerance: m.withinTolerance,
    slabA: a.code,
    slabB: b.code
  };
}

// ---- 切割方案：每块板的修边刀路 + 洞口开孔刀路，板面局部坐标 ----
function buildCutPlans(
  surface: Surface,
  cells: GridCell[],
  placements: (Placement & { cellId: number })[],
  slabById: Map<string, Slab>
): SlabCutPlan[] {
  const plans: SlabCutPlan[] = [];
  let globalOrder = 1;

  for (const p of placements) {
    const slab = slabById.get(p.slabId)!;
    const cell = cells.find((c) => c.id === p.cellId)!;
    const steps: SlabCutPlan['steps'] = [];
    let order = 1;

    // 1. 收边修切：格子比板小的方向
    const trimLines: { from: Vec2; to: Vec2; reason: string }[] = [];
    const local = (wx: number, wy: number): Vec2 =>
      worldToLocal({ x: wx, y: wy }, slab, p);

    if (cell.width < p.width - 1) {
      const a = local(cell.x + cell.width, cell.y);
      const b = local(cell.x + cell.width, cell.y + cell.height);
      trimLines.push({ from: a, to: b, reason: `右/左收边，保留宽 ${cell.width.toFixed(0)}mm` });
    }
    if (cell.height < p.height - 1) {
      const a = local(cell.x, cell.y + cell.height);
      const b = local(cell.x + cell.width, cell.y + cell.height);
      trimLines.push({ from: a, to: b, reason: `上/下收边，保留高 ${cell.height.toFixed(0)}mm` });
    }
    if (trimLines.length > 0) {
      steps.push({ order: order++, action: '修边裁切', lines: trimLines });
    }

    // 2. 洞口开孔
    const openingCuts: SlabCutPlan['openingCuts'] = [];
    const holeLines: { from: Vec2; to: Vec2; reason: string }[] = [];
    for (const op of surface.openings) {
      if (!cell.openingIds.includes(op.id)) continue;
      const c0 = local(op.x, op.y);
      const c1 = local(op.x + op.width, op.y);
      const c2 = local(op.x + op.width, op.y + op.height);
      const c3 = local(op.x, op.y + op.height);
      const rectPts = [c0, c1, c2, c3];
      const xs = rectPts.map((q) => q.x);
      const ys = rectPts.map((q) => q.y);
      const localRect = {
        x: Math.min(...xs),
        y: Math.min(...ys),
        w: Math.max(...xs) - Math.min(...xs),
        h: Math.max(...ys) - Math.min(...ys)
      };
      openingCuts.push({ opening: op, localRect });
      const loop = [c0, c1, c2, c3, c0];
      for (let i = 0; i < 4; i++) {
        holeLines.push({ from: loop[i], to: loop[i + 1], reason: `${op.label}开孔` });
      }
    }
    if (holeLines.length > 0) {
      steps.push({ order: order++, action: '洞口开孔（先钻工艺孔再沿线切割）', lines: holeLines });
    }

    // 3. 裂纹预警
    const crackWarnings: string[] = [];
    for (const crack of slab.cracks) {
      const worldPts = crack.points.map((pt) => localToWorld(pt, slab, p));
      for (const op of surface.openings) {
        if (!cell.openingIds.includes(op.id)) continue;
        if (polylineIntersectsRect(worldPts, op.x, op.y, op.width, op.height)) {
          crackWarnings.push(`裂纹 ${crack.id} 穿过 ${op.label}，禁止直接开孔，需换板或加固`);
        }
      }
    }

    plans.push({
      slabId: slab.id,
      code: slab.code,
      globalOrder: globalOrder++,
      steps,
      openingCuts,
      crackWarnings
    });
  }
  return plans;
}
