import { describe, expect, it } from 'vitest';
import { makeSyntheticBlock } from './synthetic';
import { buildCutPlan, solveLayout } from './solver';
import type { Opening, Slab, Surface } from './types';
import { checkCrackClearance, coverageArea, surfaceNetArea } from './constraints';
import { scoreSeam } from './seam';

const SLAB_W = 1600;
const SLAB_H = 2400;

function wallSurface(openings: Opening[] = []): Surface {
  return {
    id: 'wall-1',
    kind: 'wall',
    name: '客厅背景墙',
    width: SLAB_W * 4,
    height: SLAB_H,
    openings,
  };
}

describe('连纹排版求解器', () => {
  it('四块板铺满 4×1 背景墙，无重叠且全部用上', () => {
    const slabs = makeSyntheticBlock('B1', 4, SLAB_W, SLAB_H);
    const surface = wallSurface();
    const plan = solveLayout(surface, slabs, { beamWidth: 4 });

    expect(plan.placements).toHaveLength(4);
    expect(plan.unusedSlabIds).toHaveLength(0);
    const { coveredNet } = coverageArea(surface, plan.placements);
    expect(coveredNet).toBeCloseTo(surfaceNetArea(surface), 3);
    // 板之间不重叠
    for (let i = 0; i < plan.placements.length; i++) {
      for (let j = i + 1; j < plan.placements.length; j++) {
        const a = plan.placements[i];
        const b = plan.placements[j];
        const overlap =
          Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
          Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
        expect(overlap).toBe(0);
      }
    }
  });

  it('同荒料相邻 seq 的接缝错位小于 3mm', () => {
    const slabs = makeSyntheticBlock('B1', 4, SLAB_W, SLAB_H);
    const surface = wallSurface();
    const plan = solveLayout(surface, slabs);
    expect(plan.seamReports.length).toBeGreaterThan(0);
    for (const seam of plan.seamReports) {
      expect(seam.maxOffset).toBeLessThanOrEqual(3);
      expect(seam.pass).toBe(true);
    }
    expect(plan.score.maxSeamOffset).toBeLessThanOrEqual(3);
  });

  it('10 秒预算内完成一面墙（实测应远低于该值）', () => {
    const slabs = makeSyntheticBlock('B1', 8, SLAB_W, SLAB_H);
    const surface: Surface = {
      ...wallSurface(),
      width: SLAB_W * 4,
      height: SLAB_H * 2,
    };
    const plan = solveLayout(surface, slabs, { timeBudgetMs: 10000 });
    expect(plan.solveMs).toBeLessThan(10000);
    expect(plan.placements.length).toBeGreaterThan(0);
  });

  it('插座开口的避让区不会压住裂纹板', () => {
    const slabs = makeSyntheticBlock('B1', 4, SLAB_W, SLAB_H);
    // seq 0 的板带裂纹；把插座放在该板初始位置附近，迫使求解器换板或转向
    const opening: Opening = {
      id: 'socket-1',
      type: 'socket',
      x: SLAB_W * 0.25,
      y: SLAB_H * 0.4,
      width: 120,
      height: 120,
      margin: 100,
    };
    const surface = wallSurface([opening]);
    const plan = solveLayout(surface, slabs);
    expect(plan.violations).toHaveLength(0);

    // 逐块复核裂纹与避让区距离
    for (const p of plan.placements) {
      const slab = slabs.find((s) => s.id === p.slabId)!;
      const v = checkCrackClearance(slab, p, surface);
      expect(v).toHaveLength(0);
    }
  });

  it('门洞占据区域不计入所需覆盖，板不越界', () => {
    const slabs = makeSyntheticBlock('B1', 6, SLAB_W, SLAB_H);
    const surface: Surface = {
      ...wallSurface(),
      width: SLAB_W * 4,
      height: SLAB_H,
      openings: [
        { id: 'door', type: 'door', x: SLAB_W * 3, y: SLAB_H * 0.5, width: SLAB_W, height: SLAB_H * 0.5, margin: 0 },
      ],
    };
    const plan = solveLayout(surface, slabs);
    for (const p of plan.placements) {
      expect(p.x).toBeGreaterThanOrEqual(-1e-6);
      expect(p.y).toBeGreaterThanOrEqual(-1e-6);
      expect(p.x + p.width).toBeLessThanOrEqual(surface.width + 1e-6);
      expect(p.y + p.height).toBeLessThanOrEqual(surface.height + 1e-6);
    }
  });

  it('出材率与切割图：利用率 = 净覆盖 / 毛用板，切割步骤有序', () => {
    const slabs = makeSyntheticBlock('B1', 4, SLAB_W, SLAB_H);
    const surface = wallSurface();
    const plan = solveLayout(surface, slabs);
    const cut = buildCutPlan(surface, plan, slabs);
    expect(plan.score.utilization).toBeGreaterThan(0.9);
    expect(plan.score.utilization).toBeLessThanOrEqual(1);
    cut.steps.forEach((s, i) => expect(s.order).toBe(i + 1));
    expect(cut.utilization).toBeGreaterThan(0);
  });
});

describe('接缝评分', () => {
  it('同一条纹路在镜像对开的两片板上评分通过', () => {
    const slabs = makeSyntheticBlock('B2', 2, SLAB_W, SLAB_H);
    const [a, b] = slabs;
    const seam = scoreSeam(
      {
        placement: { id: 'p1', slabId: a.id, x: 0, y: 0, width: SLAB_W, height: SLAB_H, rot: 0, flipX: false },
        veins: a.veins,
        slabW: a.width,
        slabH: a.height,
      },
      {
        placement: { id: 'p2', slabId: b.id, x: SLAB_W, y: 0, width: SLAB_W, height: SLAB_H, rot: 0, flipX: false },
        veins: b.veins,
        slabW: b.width,
        slabH: b.height,
      },
      'vertical',
      { maxOffsetMm: 3 },
      20,
    );
    // 合成纹路在切片处连续，错位应在采样精度量级
    expect(seam.maxOffset).toBeLessThanOrEqual(3);
    expect(seam.pass).toBe(true);
  });

  it('无关板（不同纹路）接缝代价更高', () => {
    const groupA = makeSyntheticBlock('GA', 2, SLAB_W, SLAB_H, { seed: 1 });
    const groupB: Slab[] = makeSyntheticBlock('GB', 2, SLAB_W, SLAB_H, { seed: 9999 });
    const mk = (slab: Slab, id: string, x: number) => ({
      placement: { id, slabId: slab.id, x, y: 0, width: SLAB_W, height: SLAB_H, rot: 0 as const, flipX: false },
      veins: slab.veins,
      slabW: SLAB_W,
      slabH: SLAB_H,
    });
    // 良好：同荒料对切的两片
    const good = scoreSeam(mk(groupA[0], 'p1', 0), mk(groupA[1], 'p2', SLAB_W), 'vertical', { maxOffsetMm: 3 }, 20);
    // 不良：两片来自不同荒料、不同随机纹路，接缝处纹路位置系统性错开
    const bad = scoreSeam(mk(groupA[0], 'p1', 0), mk(groupB[0], 'p3', SLAB_W), 'vertical', { maxOffsetMm: 3 }, 20);
    expect(bad.cost).toBeGreaterThan(good.cost);
    expect(bad.avgOffset).toBeGreaterThan(good.avgOffset);
  });
});
