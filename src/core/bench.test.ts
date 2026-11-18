import { describe, expect, it } from 'vitest';
import { makeSyntheticBlock } from './synthetic';
import { solveLayout } from './solver';

const W = 1600;
const H = 2400;

describe('性能基准', () => {
  it('20 块板排一面 5×4 背景墙，10 秒预算内出方案', () => {
    // 5 列 × 4 行的背景墙，共 20 个板位
    const slabs = makeSyntheticBlock('B20', 20, W, H, { seed: 4242 });
    const surface = {
      id: 'wall-big',
      kind: 'wall' as const,
      name: '整墙 20 板',
      width: W * 5,
      height: H * 4,
      openings: [
        { id: 's1', type: 'socket' as const, x: W * 4 + 200, y: H * 1 + 400, width: 120, height: 120, margin: 100 },
        { id: 'd1', type: 'door' as const, x: 0, y: H * 3, width: W * 1.5, height: H, margin: 0 },
      ],
    };
    const plan = solveLayout(surface, slabs, { timeBudgetMs: 10000, beamWidth: 4 });

    console.log(`[bench] 20 板求解用时 ${plan.solveMs.toFixed(1)} ms，用板 ${plan.placements.length}，` +
      `最大错位 ${plan.score.maxSeamOffset.toFixed(2)} mm，出材率 ${(plan.score.utilization * 100).toFixed(1)}%`);

    expect(plan.solveMs).toBeLessThan(10000);
    expect(plan.placements.length).toBeGreaterThan(0);
    expect(plan.placements.length).toBeLessThanOrEqual(20);
  });

  it('纯铺满场景（无开口）20 板全部用上且接缝合格', () => {
    const slabs = makeSyntheticBlock('B20b', 20, W, H, { seed: 777 });
    const surface = {
      id: 'wall-flat',
      kind: 'wall' as const,
      name: '无开口整墙',
      width: W * 5,
      height: H * 4,
      openings: [],
    };
    const plan = solveLayout(surface, slabs, { timeBudgetMs: 10000 });
    console.log(`[bench] 无开口 20 板用时 ${plan.solveMs.toFixed(1)} ms，用板 ${plan.placements.length}`);
    expect(plan.solveMs).toBeLessThan(10000);
    expect(plan.placements).toHaveLength(20);
    for (const seam of plan.seamReports) {
      expect(seam.maxOffset).toBeLessThanOrEqual(3);
    }
  });
});
