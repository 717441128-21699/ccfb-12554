// 手算核对:单灯点照度 E = I(θ)·cosθ / r²,要求与引擎结果误差 < 5%。
// 同时核对:配光积分通量、极坐标查询、门窗遮挡、反射方向余弦等基础不变量。
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIES, integrateLumens } from '../src/core/ies.ts';
import { candelaAt, directIlluminance, hitWall } from '../src/core/photometry.ts';
import { computeIllumination } from '../src/core/engine.ts';
import type { Luminaire, PlacedLight, RoomConfig } from '../src/core/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const samples = resolve(here, '..', 'public', 'samples');

let failures = 0;
function check(name: string, got: number, expect: number, tolPct = 5): void {
  const err = Math.abs(got - expect) / Math.max(1e-9, Math.abs(expect));
  const ok = err * 100 <= tolPct;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(42)} got=${got.toFixed(4)} expect=${expect.toFixed(4)} err=${(err * 100).toFixed(3)}%`,
  );
  if (!ok) failures++;
}

const room: RoomConfig = {
  width: 8,
  depth: 6,
  height: 3,
  workplaneHeight: 0.75,
  reflectance: { floor: 0.2, ceiling: 0.7, wall: 0.5 },
  openings: [],
};

const ies = parseIES(readFileSync(resolve(samples, 'downlight-24deg.ies'), 'utf8'), 'downlight-24deg.ies');
const integrated = integrateLumens(ies);
const lum: Luminaire = {
  id: 'L1',
  ies,
  ratedLumens: ies.lumensPerLamp,
  integratedLumens: integrated,
  peakCandela: 0,
};
// 标定后积分通量应等于额定通量(误差来自角度离散)
check('配光积分通量 vs 额定 2000lm', integrated, 2000, 2);

const light: PlacedLight = {
  id: 'P1',
  luminaireId: 'L1',
  position: [0, 2.8, 0],
  yawDeg: 0,
  dimmer: 1,
};
const lums = new Map([['L1', lum]]);

// 1. 正下方点:手算 E = I(0)/r²
{
  const py = room.workplaneHeight;
  const r = light.position[1] - py;
  const I0 = candelaAt(ies, 0, 0, 0); // 标定表给出的轴向 cd
  const expect = I0 / (r * r);
  const got = directIlluminance(light, lum, 0, py, 0, room).lux;
  check('正下方直射照度(平方反比)', got, expect, 1e-6);
}

// 2. 水平偏移 1.5m 的点:完整公式手算
{
  const px = 1.5, pz = 0.0;
  const py = room.workplaneHeight;
  const dy = py - light.position[1];
  const dx = px - light.position[0];
  const dz = pz - light.position[2];
  const r2 = dx * dx + dy * dy + dz * dz;
  const r = Math.sqrt(r2);
  const cosT = -dy / r;
  const theta = (Math.acos(cosT) * 180) / Math.PI;
  const I = candelaAt(ies, theta, (Math.atan2(dx, dz) * 180) / Math.PI, 0);
  const expect = (I * cosT) / r2;
  const got = directIlluminance(light, lum, px, py, pz, room).lux;
  check('偏移点直射照度(角度+平方反比)', got, expect, 1e-6);
}

// 3. 距离加倍 → 照度约 1/4(角度随之变化,只验证平方反比主导项)
{
  const py = room.workplaneHeight;
  const e1 = directIlluminance(light, lum, 0, py, 0, room).lux;
  const light2: PlacedLight = { ...light, position: [0, 2.8 + 2.05, 0] };
  const r1 = light.position[1] - py;
  const r2 = light2.position[1] - py;
  const I0 = candelaAt(ies, 0, 0, 0);
  const expect = I0 / (r2 * r2);
  const got = directIlluminance(light2, lum, 0, py, 0, room).lux;
  check('抬高后轴向照度按 r² 衰减', got, expect, 1e-6);
  check('r² 衰减比例约 1/4', e1 / got, (r2 * r2) / (r1 * r1), 1e-6);
}

// 4. 两灯照度线性叠加
{
  const py = room.workplaneHeight;
  const a = directIlluminance(light, lum, 1, py, 1, room).lux;
  const lightB: PlacedLight = { ...light, id: 'P2', position: [2, 2.8, 1] };
  const b = directIlluminance(lightB, lum, 1, py, 1, room).lux;
  const result = computeIllumination(
    room,
    [light, lightB],
    lums,
    { grid: { nx: 12, nz: 12 }, includeIndirect: true },
  );
  const cell = result.points.find(
    (p) => Math.abs(p.x - 1) < room.width / 12 && Math.abs(p.z - 1) < room.depth / 12,
  );
  if (cell) check('网格引擎直射分量 = 单灯之和(网格离散)', cell.direct, a + b, 5);
  else {
    failures++;
    console.log('FAIL  未找到对应网格单元');
  }
}

// 5. 门窗遮挡:窗洞横在灯与测点之间时直射应折减
{
  const roomWin: RoomConfig = {
    ...room,
    width: 8,
    openings: [
      { id: 'w1', wall: 1, u: 0, bottom: 0.5, width: 2, height: 2, kind: 'window', transmittance: 0.8 },
    ],
  };
  // 用宽配光面板灯(大角度仍有光),灯在室内西侧,测点越过东墙
  const iesWin = parseIES(readFileSync(resolve(samples, 'panel-90deg.ies'), 'utf8'), 'panel.ies');
  const lumWin: Luminaire = {
    id: 'LW', ies: iesWin, ratedLumens: 3600,
    integratedLumens: integrateLumens(iesWin), peakCandela: 0,
  };
  const wallX = roomWin.width / 2;
  const winU = 0, winY = 1.5;
  const near: PlacedLight = { id: 'wlight', luminaireId: 'LW', position: [wallX - 4, winY + 0.6, winU], yawDeg: 0, dimmer: 1 };
  const tWall = 4 / 4.2;
  const targetY = (winY - (1 - tWall) * near.position[1]) / tWall;
  const target: [number, number, number] = [wallX + 0.2, targetY, winU];
  const hit = hitWall(roomWin, near.position, target);
  console.log(hit ? `INFO  射线击墙 wall=${hit.wall} u=${hit.u.toFixed(2)} y=${hit.y.toFixed(2)}` : 'INFO  未击墙');
  if (hit) {
    // 手算无遮挡时该点的入射照度,窗洞应使其折减为 (1-T)=0.2 倍
    const dy = target[1] - near.position[1];
    const r = Math.hypot(target[0] - near.position[0], dy, target[2] - near.position[2]);
    const cosT = -dy / r;
    const theta = (Math.acos(cosT) * 180) / Math.PI;
    const I = candelaAt(iesWin, theta, 0, 0);
    const freeLux = (I * cosT) / (r * r);
    const blocked = directIlluminance(near, lumWin, target[0], target[1], target[2], roomWin).lux;
    check('窗洞折减系数 1-T=0.2', blocked / freeLux, 0.2, 2);
  } else {
    failures++;
    console.log('FAIL  几何未穿过窗洞');
  }
}

// 6. 反射率为零时间接照度应为 0
{
  const black: RoomConfig = {
    ...room,
    reflectance: { floor: 0, ceiling: 0, wall: 0 },
  };
  const result = computeIllumination(black, [light], lums, {
    grid: { nx: 16, nz: 16 },
    includeIndirect: true,
  });
  const maxIndirect = Math.max(...result.points.map((p) => p.indirect));
  check('全黑房间间接照度≈0', maxIndirect, 0, 1e-6);
}

// 7. 宽配光灯具的一次反射贡献应显著为正;零反射房间已在第 6 项验证基线
{
  const iesPanel = parseIES(
    readFileSync(resolve(samples, 'panel-90deg.ies'), 'utf8'),
    'panel-90deg.ies',
  );
  const panel: Luminaire = {
    id: 'LP',
    ies: iesPanel,
    ratedLumens: 3600,
    integratedLumens: integrateLumens(iesPanel),
    peakCandela: 0,
  };
  const panelLight: PlacedLight = { id: 'PP', luminaireId: 'LP', position: [0, 2.8, 0], yawDeg: 0, dimmer: 1 };
  const result = computeIllumination(room, [panelLight], new Map([['LP', panel]]), {
    grid: { nx: 16, nz: 16 },
    includeIndirect: true,
  });
  const totalIndirect = result.points.reduce((s, p) => s + p.indirect, 0);
  const totalDirect = result.points.reduce((s, p) => s + p.direct, 0);
  const ratio = totalIndirect / totalDirect;
  console.log(`INFO  面板灯间接/直射=${(ratio * 100).toFixed(1)}% 平均照度=${result.metrics.average.toFixed(1)}lx UGR=${result.metrics.ugr.toFixed(1)}`);
  check('一次反射贡献占比为正且量级合理(2%~25%)', ratio, 0.05, 60);
  if (!(ratio > 0.02 && ratio < 0.25)) failures++;

  // UGR:相同总光通量下,分散到多盏小功率灯的眩光低于单盏大灯
  const single = computeIllumination(room, [panelLight], new Map([['LP', panel]]), {
    grid: { nx: 10, nz: 10 }, includeIndirect: true,
  }).metrics.ugr;
  const panelQuarter: Luminaire = { ...panel, ratedLumens: panel.ratedLumens / 4 };
  const grid: PlacedLight[] = [];
  for (const gx of [-2, 2]) for (const gz of [-1.5, 1.5]) {
    grid.push({ ...panelLight, id: `g${gx}${gz}`, luminaireId: 'LP', position: [gx, 2.8, gz] });
  }
  const multi = computeIllumination(room, grid, new Map([['LP', panelQuarter]]), {
    grid: { nx: 10, nz: 10 }, includeIndirect: true,
  }).metrics.ugr;
  console.log(`INFO  UGR 单灯3600lm=${single.toFixed(1)} 四灯各900lm=${multi.toFixed(1)}`);
  if (multi < single) console.log('PASS  同通量分散布灯 UGR 低于集中单灯');
  else {
    failures++;
    console.log('FAIL  UGR 单调性异常');
  }
}

// 8. 调光系数线性生效
{
  const py = room.workplaneHeight;
  const full = directIlluminance(light, lum, 0.5, py, 0.5, room).lux;
  const half = directIlluminance({ ...light, dimmer: 0.5 }, lum, 0.5, py, 0.5, room).lux;
  check('50% 调光 → 照度减半', half / full, 0.5, 1e-6);
}

console.log(failures === 0 ? '\n全部通过 ✔' : `\n${failures} 项失败 ✘`);
process.exit(failures === 0 ? 0 : 1);
