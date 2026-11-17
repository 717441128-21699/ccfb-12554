// 生成典型商业灯具的合成 IES 文件(IESNA LM-63-2002 格式),
// 光强按解析余弦幂分布生成,便于核对计算。输出到 public/samples/。
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Spec {
  file: string;
  label: string;
  catalog: string;
  lumens: number;
  watts: number;
  openingW: number; // 米
  openingL: number;
  nVert: number;
  nHoriz: number;
  /** 光强函数 I(theta 度, phi 度),返回归一化系数,内部再标定到通量 */
  shape: (thetaDeg: number, phiDeg: number) => number;
}

const d2r = (d: number) => (d * Math.PI) / 180;

function calibratePeak(spec: Spec): { peak: number; vert: number[]; horiz: number[]; table: number[][] } {
  const vert: number[] = [];
  for (let i = 0; i < spec.nVert; i++) vert.push((180 * i) / (spec.nVert - 1));
  const horiz: number[] = [];
  for (let i = 0; i < spec.nHoriz; i++) {
    const last = spec.nHoriz === 1 ? 0 : 90; // 四分之一对称到 90°
    horiz.push((last * i) / Math.max(1, spec.nHoriz - 1));
  }
  const table: number[][] = horiz.map((phi) => vert.map((theta) => spec.shape(theta, phi)));

  // 球面积分求归一化通量(四分之一对称 ×4)
  let flux = 0;
  for (let h = 0; h < horiz.length; h++) {
    let plane = 0;
    for (let v = 0; v < vert.length - 1; v++) {
      const t0 = d2r(vert[v]);
      const t1 = d2r(vert[v + 1]);
      plane += 0.5 * (table[h][v] + table[h][v + 1]) * (Math.cos(t0) - Math.cos(t1));
    }
    flux += plane;
  }
  const dPhi = horiz.length > 1 ? d2r(horiz[1] - horiz[0]) : 0;
  const hMean = flux / horiz.length;
  const normFlux = spec.nHoriz === 1 ? hMean * 2 * Math.PI : hMean * dPhi * 4;
  const peak = spec.lumens / normFlux;
  return { peak, vert, horiz, table: table.map((row) => row.map((v) => v * peak)) };
}

function serialize(spec: Spec): string {
  const { vert, horiz, table } = calibratePeak(spec);
  const lines: string[] = [];
  lines.push('IESNA:LM-63-2002');
  lines.push('[MANUFAC] LightStudio 合成示例(非实测,供软件验证)');
  lines.push(`[LUMCAT] ${spec.catalog}`);
  lines.push(`[LUMINAIRE] ${spec.label}`);
  lines.push('[LAMP] LED 合成模块');
  lines.push('[TEST] 解析分布生成');
  lines.push('TILT=NONE');
  // 13 个标量
  lines.push(
    [
      1, // 灯数
      spec.lumens, // 每灯光通量
      1, // 乘数
      spec.nVert,
      spec.nHoriz,
      1, // C 型
      2, // 米
      spec.openingW,
      spec.openingL,
      0, // 开口高度
      1, // 镇流器系数
      1, // 保留
      spec.watts,
    ].join(' '),
  );
  lines.push(vert.map((v) => v.toFixed(3)).join(' '));
  lines.push(horiz.map((v) => v.toFixed(3)).join(' '));
  for (const row of table) lines.push(row.map((v) => v.toFixed(4)).join(' '));
  return lines.join('\n') + '\n';
}

const specs: Spec[] = [
  {
    file: 'downlight-24deg.ies',
    label: 'LED 筒灯 24° 窄光束 2000lm',
    catalog: 'LS-DL-2000-24',
    lumens: 2000,
    watts: 18,
    openingW: 0.1,
    openingL: 0.1,
    nVert: 91,
    nHoriz: 1,
    shape: (t) => (t <= 90 ? Math.cos(d2r(t)) ** 32 : 0),
  },
  {
    file: 'panel-90deg.ies',
    label: 'LED 面板灯 宽配光 3600lm',
    catalog: 'LS-PNL-3600',
    lumens: 3600,
    watts: 32,
    openingW: 0.6,
    openingL: 0.6,
    nVert: 91,
    nHoriz: 1,
    shape: (t) => (t <= 90 ? Math.cos(d2r(t)) ** 1.2 : 0),
  },
  {
    file: 'track-spot-36deg.ies',
    label: '导轨射灯 36° 3000lm',
    catalog: 'LS-TRK-3000-36',
    lumens: 3000,
    watts: 28,
    openingW: 0.09,
    openingL: 0.09,
    nVert: 91,
    nHoriz: 4, // 0/30/60/90,轻微非轴对称
    shape: (t, phi) =>
      t <= 90 ? Math.cos(d2r(t)) ** 14 * (1 + 0.12 * Math.cos(d2r(phi) * 2)) : 0,
  },
];

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'public', 'samples');
mkdirSync(outDir, { recursive: true });
for (const spec of specs) {
  writeFileSync(resolve(outDir, spec.file), serialize(spec), 'utf8');
  console.log('written', spec.file);
}
