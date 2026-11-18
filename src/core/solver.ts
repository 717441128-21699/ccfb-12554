import type {
  Crack,
  CutPlan,
  CutStep,
  LayoutPlan,
  LayoutScore,
  OpeningViolation,
  Placement,
  Rect,
  SeamReport,
  Slab,
  SolveOptions,
  Surface,
  Vec2,
} from './types';
import { DEFAULT_SOLVE_OPTIONS } from './types';
import {
  ALL_ORIENTATIONS,
  makeRng,
  orientPoint,
  orientedSize,
  rectsOverlap,
  unorientPoint,
  v,
} from './geometry';
import { scoreSeam, type SeamInfo } from './seam';
import {
  checkCrackClearance,
  coverageArea,
  unionArea,
} from './constraints';
export { checkNoOverlap } from './constraints';

interface SearchState {
  placements: Placement[];
  usedSlabIds: Set<string>;
  seamCost: number;
  seams: SeamInfo[];
  violations: OpeningViolation[];
}

/**
 * 在安装面上做连纹排版。
 * 策略：beam search。每步取当前版面最左下的可填充锚点，
 * 枚举“未用板 × 8 朝向”，用接缝对纹代价 + 连纹先验排序，保留 beamWidth 个状态。
 * 时间预算内拿不到全合格方案时，返回违规最少、代价最低的兜底方案并标注。
 */
export function solveLayout(
  surface: Surface,
  slabs: Slab[],
  partial?: Partial<SolveOptions>,
): LayoutPlan {
  const opts: SolveOptions = { ...DEFAULT_SOLVE_OPTIONS, ...partial };
  const t0 = performance.now();
  const deadline = t0 + opts.timeBudgetMs;
  const rng = makeRng(opts.seed);
  const root: SearchState = {
    placements: [],
    usedSlabIds: new Set(),
    seamCost: 0,
    seams: [],
    violations: [],
  };
  let beam: SearchState[] = [root];
  let bestEffort: SearchState | null = null;

  const maxIters = slabs.length;
  for (let iter = 0; iter < maxIters; iter++) {
    if (performance.now() > deadline) break;
    const candidates: { state: SearchState; cost: number }[] = [];

    for (const st of beam) {
      const anchor = nextAnchor(surface, st.placements);
      if (!anchor) continue;
      for (const slab of slabs) {
        if (st.usedSlabIds.has(slab.id)) continue;
        for (const o of ALL_ORIENTATIONS) {
          const size = orientedSize(slab.width, slab.height, o);
          // 放进去会越过安装面边界的朝向直接淘汰
          if (anchor.x + size.x > surface.width + 1e-6 || anchor.y + size.y > surface.height + 1e-6) {
            continue;
          }
          const placement: Placement = {
            id: `p${st.placements.length + 1}`,
            slabId: slab.id,
            x: anchor.x,
            y: anchor.y,
            width: size.x,
            height: size.y,
            rot: o.rot,
            flipX: o.flipX,
          };
          const rejected = rejectReason(surface, st, placement, slab, opts.gapMm);
          if (rejected === 'overlap' || rejected === 'out-of-bounds') continue;
          if (!leavesFillableSpace(surface, st, placement, slabs)) continue;

          const { cost, seamInfos, newViolations } = evaluate(
            surface,
            st,
            placement,
            slab,
            slabs,
            opts,
          );
          const jitter = rng() * 0.001; // 同分时保持确定性但避免死序
          candidates.push({
            cost: cost + jitter,
            state: {
              placements: [...st.placements, placement],
              usedSlabIds: new Set(st.usedSlabIds).add(slab.id),
              seamCost: st.seamCost + seamInfos.reduce((s, x) => s + x.cost, 0),
              seams: [...st.seams, ...seamInfos],
              violations: [...st.violations, ...newViolations],
            },
          });
        }
      }
    }

    if (candidates.length === 0) break;
    candidates.sort((a, b) => a.cost - b.cost);
    // 去重：同锚点轮廓只保留代价最低的一条路径，给不同摆法留出 beam 名额
    const seen = new Set<string>();
    const pruned: { state: SearchState; cost: number }[] = [];
    for (const c of candidates) {
      const sig = stateSignature(c.state);
      if (seen.has(sig)) continue;
      seen.add(sig);
      pruned.push(c);
      if (pruned.length >= opts.beamWidth * 2) break;
    }
    beam = pruned.slice(0, opts.beamWidth).map((c) => c.state);
    bestEffort = pickBestEffort(bestEffort, beam, surface);

    // 所有 beam 状态都已无锚点可填（覆盖完成或只剩不可填缝隙）才收尾
    const anyAnchorLeft = beam.some((st) => nextAnchor(surface, st.placements) !== null);
    if (!anyAnchorLeft) break;
  }

  const finalState = chooseFinal(bestEffort, beam, surface);
  return buildPlan(surface, slabs, finalState, opts, t0);
}

function pickBestEffort(prev: SearchState | null, beam: SearchState[], surface: Surface): SearchState {
  let best = prev ?? beam[0];
  for (const st of beam) {
    if (rankState(st, surface) < rankState(best, surface)) best = st;
  }
  return best;
}

function chooseFinal(
  bestEffort: SearchState | null,
  beam: SearchState[],
  surface: Surface,
): SearchState {
  const all = [...beam];
  if (bestEffort) all.push(bestEffort);
  return all.reduce((a, b) => (rankState(b, surface) < rankState(a, surface) ? b : a));
}

/**
 * 可填充性启发：放下 candidate 后，下一个锚点处的空白矩形必须还能容纳
 * 至少一块未用板的某种朝向，否则该候选只会制造死缝，直接淘汰。
 * 这是矩形条带排版里防止“旋转板切碎版面”的关键剪枝。
 */
function leavesFillableSpace(
  surface: Surface,
  st: SearchState,
  candidate: Placement,
  slabs: Slab[],
): boolean {
  const next: SearchState = { ...st, placements: [...st.placements, candidate] };
  const anchor = nextAnchor(surface, next.placements);
  if (!anchor) return true;
  const remaining = slabs.filter((s) => !next.usedSlabIds.has(s.id));
  if (remaining.length === 0) return true;

  // 锚点向右、向下的连续可用空间（用已占位矩形求约束）
  let right = surface.width - anchor.x;
  let down = surface.height - anchor.y;
  for (const p of next.placements) {
    const verticallyOverlaps = anchor.y >= p.y - 1e-6 && anchor.y < p.y + p.height - 1e-6;
    const horizontallyOverlaps = anchor.x >= p.x - 1e-6 && anchor.x < p.x + p.width - 1e-6;
    if (verticallyOverlaps && p.x > anchor.x) right = Math.min(right, p.x - anchor.x);
    if (horizontallyOverlaps && p.y > anchor.y) down = Math.min(down, p.y - anchor.y);
  }
  return remaining.some((s) =>
    ALL_ORIENTATIONS.some((o) => {
      const size = orientedSize(s.width, s.height, o);
      return size.x <= right + 1e-6 && size.y <= down + 1e-6;
    }),
  );
}

/** 状态排序：先无违规，再覆盖率，再接缝代价 */
function rankState(st: SearchState, surface: Surface): number {
  const covered = unionArea(
    st.placements.map((p) => ({ x: p.x, y: p.y, width: p.width, height: p.height })),
    surface.width,
    surface.height,
  );
  const openArea = surface.openings.reduce((s, o) => s + o.width * o.height, 0);
  const coverRatio = covered / (surface.width * surface.height - openArea);
  return (
    st.violations.length * 1e9 -
    coverRatio * 1e6 +
    st.seamCost +
    st.placements.length * 0.01
  );
}

function rejectReason(
  surface: Surface,
  st: SearchState,
  p: Placement,
  _slab: Slab,
  gapMm: number,
): 'overlap' | 'out-of-bounds' | null {
  if (p.x < -1e-6 || p.y < -1e-6 || p.x + p.width > surface.width + 1e-6 || p.y + p.height > surface.height + 1e-6) {
    return 'out-of-bounds';
  }
  const g = gapMm / 2;
  const shrunk: Rect = { x: p.x + g, y: p.y + g, width: p.width - gapMm, height: p.height - gapMm };
  for (const q of st.placements) {
    const qr: Rect = { x: q.x + g, y: q.y + g, width: q.width - gapMm, height: q.height - gapMm };
    if (rectsOverlap(shrunk, qr)) return 'overlap';
  }
  return null;
}

/** 计算新板与所有已放板的接缝代价与开口违规 */
function evaluate(
  surface: Surface,
  st: SearchState,
  placement: Placement,
  slab: Slab,
  slabs: Slab[],
  opts: SolveOptions,
): { cost: number; seamInfos: SeamInfo[]; newViolations: OpeningViolation[] } {
  const seamInfos: SeamInfo[] = [];
  let cost = 0;

  for (const q of st.placements) {
    const other = slabs.find((s) => s.id === q.slabId)!;
    const vertical = touchingVertical(q, placement);
    const horizontal = touchingHorizontal(q, placement);
    if (!vertical && !horizontal) continue;
    const axis = vertical ? 'vertical' : 'horizontal';
    const [a, b] = axis === 'vertical' && q.x + q.width <= placement.x + 1e-6
      ? [{ placement: q, veins: other.veins, slabW: other.width, slabH: other.height },
         { placement, veins: slab.veins, slabW: slab.width, slabH: slab.height }]
      : axis === 'vertical'
        ? [{ placement, veins: slab.veins, slabW: slab.width, slabH: slab.height },
           { placement: q, veins: other.veins, slabW: other.width, slabH: other.height }]
        : q.y + q.height <= placement.y + 1e-6
          ? [{ placement: q, veins: other.veins, slabW: other.width, slabH: other.height },
             { placement, veins: slab.veins, slabW: slab.width, slabH: slab.height }]
          : [{ placement, veins: slab.veins, slabW: slab.width, slabH: slab.height },
             { placement: q, veins: other.veins, slabW: other.width, slabH: other.height }];

    const info = scoreSeam(a, b, axis, { maxOffsetMm: opts.seamToleranceMm }, opts.sampleStepMm);
    seamInfos.push(info);
    cost += info.cost;
    cost += adjacencyPrior(other, slab, opts.preferAdjacentSeq);
  }

  // 邻板越少说明越孤立，给一点连接性引导，避免碎摆
  if (seamInfos.length === 0 && st.placements.length > 0) cost += 5;

  const newViolations = checkCrackClearance(slab, placement, surface);
  cost += newViolations.length * 1e7;
  return { cost, seamInfos, newViolations };
}

/** 同荒料相邻 seq 连纹先验；书本对开（flipX 不同）再奖励 */
function adjacencyPrior(a: Slab, b: Slab, enabled: boolean): number {
  if (!enabled || a.blockId !== b.blockId) return 0;
  if (Math.abs(a.seq - b.seq) !== 1) return 0;
  return -60;
}

function touchingVertical(a: Placement, b: Placement): boolean {
  const touchX =
    Math.abs(a.x + a.width - b.x) < 1e-6 || Math.abs(b.x + b.width - a.x) < 1e-6;
  const overlapY = a.y < b.y + b.height - 1e-6 && a.y + a.height > b.y + 1e-6;
  return touchX && overlapY;
}

function touchingHorizontal(a: Placement, b: Placement): boolean {
  const touchY =
    Math.abs(a.y + a.height - b.y) < 1e-6 || Math.abs(b.y + b.height - a.y) < 1e-6;
  const overlapX = a.x < b.x + b.width - 1e-6 && a.x + a.width > b.x + 1e-6;
  return touchY && overlapX;
}

/**
 * 最左下锚点：先找最低的未覆盖水平线，再取该线上最左的未覆盖点。
 * 用板边与开口边构成的候选坐标网格求交，避免浮点漏点。
 */
function nextAnchor(surface: Surface, placements: Placement[]): Vec2 | null {
  const ys = [0, ...placements.map((p) => p.y + p.height)];
  const xs = [0, ...placements.map((p) => p.x + p.width)];
  const candidates: Vec2[] = [];
  for (const y of ys) {
    if (y < -1e-6 || y >= surface.height - 1e-6) continue;
    for (const x of xs) {
      if (x < -1e-6 || x >= surface.width - 1e-6) continue;
      candidates.push(v(x, y));
    }
  }
  candidates.sort((a, b) => a.y - b.y || a.x - b.x);
  for (const c of candidates) {
    if (!isCovered(c, placements)) return c;
  }
  return null;
}

function isCovered(p: Vec2, placements: Placement[]): boolean {
  return placements.some(
    (q) => p.x >= q.x - 1e-6 && p.x < q.x + q.width - 1e-6 && p.y >= q.y - 1e-6 && p.y < q.y + q.height - 1e-6,
  );
}

/** 版面轮廓签名：占地矩形集合相同即视为同构状态（用了哪些板不参与签名） */
function stateSignature(st: SearchState): string {
  return st.placements
    .map((p) => `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.width)},${Math.round(p.height)}`)
    .sort()
    .join('|');
}

function buildPlan(
  surface: Surface,
  slabs: Slab[],
  st: SearchState,
  opts: SolveOptions,
  t0: number,
): LayoutPlan {
  const { coveredNet, grossSlab, waste } = coverageArea(surface, st.placements);
  const utilization = grossSlab > 0 ? coveredNet / grossSlab : 0;

  const seamReports: SeamReport[] = st.seams.map((info) => ({
    placements: info.placements,
    axis: info.axis,
    at: info.at,
    length: info.length,
    offsets: info.offsets,
    avgOffset: info.avgOffset,
    maxOffset: info.maxOffset,
    avgAngleDelta: info.avgAngleDelta,
    pass: info.pass,
  }));

  const validOffsets = st.seams.flatMap((s) => s.offsets).filter((x): x is number => x !== null);
  const avgSeamOffset = validOffsets.length
    ? validOffsets.reduce((a, b) => a + b, 0) / validOffsets.length
    : 0;
  const maxSeamOffset = validOffsets.length ? Math.max(...validOffsets) : 0;
  const continuity = seamReports.length
    ? seamReports.reduce((s, r) => {
        const anglePart = 1 - Math.min(1, r.avgAngleDelta / (Math.PI / 2));
        const offPart = 1 - Math.min(1, r.avgOffset / Math.max(1, opts.seamToleranceMm * 2));
        return s + anglePart * 0.4 + offPart * 0.6;
      }, 0) / seamReports.length
    : 1;

  const score: LayoutScore = {
    total: st.seamCost,
    avgSeamOffset,
    maxSeamOffset,
    continuity,
    utilization,
    slabCount: st.placements.length,
    wasteArea: waste,
  };

  return {
    id: `plan-${surface.id}`,
    surfaceId: surface.id,
    placements: st.placements,
    unusedSlabIds: slabs.filter((s) => !st.usedSlabIds.has(s.id)).map((s) => s.id),
    score,
    seamReports,
    violations: st.violations,
    createdAt: Date.now(),
    solveMs: performance.now() - t0,
  };
}

// ---------- 切割图 ----------

/**
 * 由摆放反推每块原板的切割步骤。
 * 变换后所需的包围盒（placement 占地）映回原板坐标得到保留矩形 keepRect；
 * 当占地小于原板时，按“先长条、再截头”的车间习惯生成 1~2 刀。
 */
export function buildCutPlan(surface: Surface, plan: LayoutPlan, slabs: Slab[]): CutPlan {
  const steps: CutStep[] = [];
  let order = 1;
  let totalWaste = 0;

  for (const p of plan.placements) {
    const slab = slabs.find((s) => s.id === p.slabId);
    if (!slab) continue;
    const keep = keptRectInSlab(slab, p);
    const slabArea = slab.width * slab.height;
    const keepArea = keep.width * keep.height;
    const wasteHere = Math.max(0, slabArea - keepArea);
    totalWaste += wasteHere;

    // 第一刀：沿保留矩形较长方向的多余边切通
    const cuts = cutsForKeep(slab, keep);
    for (const cut of cuts) {
      steps.push({
        order: order++,
        placementId: p.id,
        slabId: slab.id,
        from: cut.from,
        to: cut.to,
        keepRect: keep,
        wasteArea: cut.wasteShare,
      });
    }
  }

  const gross = plan.placements.reduce((s, p) => s + p.width * p.height, 0);
  return {
    surfaceId: surface.id,
    steps,
    totalWasteArea: totalWaste,
    utilization: gross > 0 ? (gross - totalWaste) / gross : 0,
  };
}

/** 把摆放占地的四角反变换到原板坐标，取包围盒即保留矩形 */
function keptRectInSlab(slab: Slab, p: Placement): Rect {
  const local = [v(0, 0), v(p.width, 0), v(p.width, p.height), v(0, p.height)];
  const back = local.map((c) =>
    unorientPoint(c, slab.width, slab.height, { rot: p.rot, flipX: p.flipX }),
  );
  const xs = back.map((q) => q.x);
  const ys = back.map((q) => q.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x,
    y,
    width: Math.max(...xs) - x,
    height: Math.max(...ys) - y,
  };
}

function cutsForKeep(
  slab: Slab,
  keep: Rect,
): { from: Vec2; to: Vec2; wasteShare: number }[] {
  const out: { from: Vec2; to: Vec2; wasteShare: number }[] = [];
  const eps = 1e-6;
  const wasteRight = slab.width - (keep.x + keep.width);
  const wasteBottom = slab.height - (keep.y + keep.height);

  if (wasteRight > eps) {
    out.push({
      from: v(keep.x + keep.width, 0),
      to: v(keep.x + keep.width, slab.height),
      wasteShare: wasteRight * slab.height,
    });
  }
  if (wasteBottom > eps) {
    out.push({
      from: v(0, keep.y + keep.height),
      to: v(keep.x + keep.width, keep.y + keep.height),
      wasteShare: keep.width * wasteBottom,
    });
  }
  if (keep.x > eps) {
    out.push({
      from: v(keep.x, 0),
      to: v(keep.x, keep.height),
      wasteShare: keep.x * slab.height,
    });
  }
  if (keep.y > eps) {
    out.push({
      from: v(0, keep.y),
      to: v(keep.width, keep.y),
      wasteShare: slab.width * keep.y,
    });
  }
  return out;
}

// 供测试与 UI 使用的工具：板上裂纹在安装面的坐标
export function crackToWorld(crack: Crack, slab: Slab, p: Placement): Vec2[] {
  return crack.points
    .map((q) => v(q.x * slab.width, q.y * slab.height))
    .map((q) => orientPoint(q, slab.width, slab.height, { rot: p.rot, flipX: p.flipX }))
    .map((q) => v(q.x + p.x, q.y + p.y));
}
