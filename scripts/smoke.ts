// Node 冒烟测试：不依赖 DOM，手工构造 VeinFeatures 跑完整求解流程
// 运行：npx tsx scripts/smoke.ts （或 node --experimental-strip-types）
import { solveLayout } from '../src/solver';
import type { EdgeProfile, VeinFeatures } from '../src/vein';
import type { Slab, Surface } from '../src/types';

const W = 1200, H = 2400;

function makeStrip(seed: number, phaseShift = 0): Float32Array {
  const n = 128;
  const arr = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    arr[i] = 0.5 + 0.3 * Math.sin((i + seed * 9 + phaseShift) * 0.35)
      + 0.12 * Math.sin((i + seed * 3) * 0.9);
  }
  return arr;
}

function edge(side: string, seed: number, len: number): EdgeProfile {
  const strip = makeStrip(seed);
  const grad = new Float32Array(128);
  for (let i = 1; i < 127; i++) grad[i] = (strip[i + 1] - strip[i - 1]) / 2;
  return {
    side: side as EdgeProfile['side'],
    strip,
    grad,
    crossings: [
      { t: 0.2, angle: 0, strength: 0.4 },
      { t: 0.55, angle: 0, strength: 0.35 },
      { t: 0.8, angle: 0, strength: 0.3 }
    ],
    lengthMm: len
  };
}

function slab(id: string, block: string, idx: number, crack = false): Slab {
  return {
    id, code: `${block}-${String(idx).padStart(2, '0')}`, blockId: block, cutIndex: idx,
    widthMm: W, heightMm: H, imageW: 256, imageH: 512,
    frontDataUrl: '', cracks: crack ? [{ id: 'c1', points: [{ x: 2080, y: 1380 }, { x: 2180, y: 1500 }] }] : []
  };
}

const slabs: Slab[] = [];
['A', 'B'].forEach((b, bi) => {
  for (let i = 1; i <= 7; i++) slabs.push(slab(`s${bi}-${i}`, `BLK-${b}`, i, bi === 0 && i === 5));
});

// 同一荒料相邻板的 R/L 边描述子高度相似（模拟连纹），跨荒料不相似
const features = new Map<string, VeinFeatures>();
for (const s of slabs) {
  const seedBase = s.blockId === 'BLK-A' ? 1 : 30;
  features.set(s.id, {
    slabId: s.id,
    edges: {
      L: edge('L', seedBase + s.cutIndex, H),
      R: edge('R', seedBase + s.cutIndex + 1, H),
      T: edge('T', seedBase + s.cutIndex, W),
      B: edge('B', seedBase + s.cutIndex, W)
    }
  });
}

const surface: Surface = {
  id: 'wall1', kind: 'wall', name: '测试背景墙',
  widthMm: 4800, heightMm: 3000,
  openings: [
    { id: 'op1', type: 'door', label: '门洞', x: 3900, y: 0, width: 900, height: 2100 },
    { id: 'op2', type: 'socket', label: '插座', x: 2050, y: 1350, width: 300, height: 120 }
  ]
};

const result = solveLayout(surface, slabs, features, {
  mode: 'continue', rot90: false, beamWidth: 8, toleranceMm: 3
});

console.log('--- 求解结果 ---');
console.log('耗时(ms):', result.solveMs);
console.log('用板数:', result.usedSlabCount, '/ 批次', result.batchSlabCount);
console.log('出材率:', (result.utilization * 100).toFixed(2) + '%');
console.log('未覆盖格子:', result.uncoveredCells);
console.log('接缝数:', result.seams.length, '合格:', result.seams.filter((s) => s.withinTolerance).length);
console.log('最大错位(mm):', Math.max(0, ...result.seams.map((s) => s.meanDiff)).toFixed(2));
console.log('切割方案数:', result.cutPlans.length);
console.log('裂纹告警:', result.crackViolations);
console.log('板序:', result.placements.map((p) => slabs.find((s) => s.id === p.slabId)!.code).join(', '));

// 书本对开模式
const bm = solveLayout(surface, slabs, features, {
  mode: 'bookmatch', rot90: false, beamWidth: 8, toleranceMm: 3
});
const flips = bm.placements.map((p) => p.flip).join(',');
console.log('\n--- 书本对开 ---');
console.log('flip 序列（应为 0,1 交替）:', flips);
console.log('用板数:', bm.usedSlabCount);

// 断言
let fail = 0;
const check = (name: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${name}`);
  if (!cond) fail++;
};
check('10 秒内完成', result.solveMs < 10000);
check('覆盖全部需要的格子', result.uncoveredCells === 0);
check('出材率在合理区间 0.5-1', result.utilization > 0.5 && result.utilization <= 1);
check('生成了切割方案', result.cutPlans.length === result.usedSlabCount);
check('带开孔的板有开孔步骤', result.cutPlans.some((p) => p.openingCuts.length > 0));
check('书本对开 flip 交替', bm.placements.every((p, i) => p.flip === (i % 4 < 2 ? (i % 2) : (i % 2))));
check('同荒料相邻板被优先选用', (() => {
  const codes = result.placements.map((p) => slabs.find((s) => s.id === p.slabId)!);
  const firstRow = codes.slice(0, 4);
  return firstRow.every((s) => s.blockId === firstRow[0].blockId);
})());

// ---- 裂纹避让专项：所有候选板都在插座位置带裂纹 ----
const crackedSlabs: Slab[] = [];
for (let i = 1; i <= 10; i++) {
  crackedSlabs.push({
    ...slab(`c${i}`, 'BLK-C', i),
    // 插座在展开图 (2050,1350)，位于 col1 板（x 1200-2400）局部约 (850,1350)
    cracks: [{ id: `cr${i}`, points: [{ x: 800, y: 1250 }, { x: 900, y: 1450 }] }]
  });
}
const crackedFeatures = new Map(crackedSlabs.map((s, i) => {
  const f = features.get(slabs[0].id)!;
  return [s.id, { ...f, slabId: s.id }];
}));
const crackedResult = solveLayout(surface, crackedSlabs, crackedFeatures, {
  mode: 'continue', rot90: false, beamWidth: 8, toleranceMm: 3
});
check('带裂纹板排到插座格时产生冲突告警', crackedResult.crackViolations.length > 0);
check('裂纹告警包含插座标注', crackedResult.crackViolations.some((m) => m.includes('插座')));
console.log('裂纹告警样例:', crackedResult.crackViolations[0] ?? '无');

// ---- 板不够场景 ----
const shortResult = solveLayout(surface, slabs.slice(0, 3), features, {
  mode: 'continue', rot90: false, beamWidth: 8, toleranceMm: 3
});
check('板材不足时标记未覆盖格子', shortResult.uncoveredCells > 0 && shortResult.usedSlabCount === 3);
check('不足时出材率不超过 1', shortResult.utilization <= 1 && shortResult.utilization >= 0);

process.exit(fail ? 1 : 0);
