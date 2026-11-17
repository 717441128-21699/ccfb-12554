// 演示数据：程序化生成同一荒料切出的 20 块大板，纹路在相邻板之间连续
import { makeCrack, uid } from './store';
import type { Slab, Surface } from './types';

export const SLAB_W = 1200;
export const SLAB_H = 2400;

// 可复现的伪随机
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface BlockDef {
  blockId: string;
  count: number;
  seed: number;
  baseHue: number;
}

const BLOCKS: BlockDef[] = [
  { blockId: 'BLK-A', count: 7, seed: 101, baseHue: 32 },
  { blockId: 'BLK-B', count: 7, seed: 202, baseHue: 28 },
  { blockId: 'BLK-C', count: 6, seed: 303, baseHue: 36 }
];

function renderBlockCanvas(def: BlockDef): HTMLCanvasElement {
  const rnd = mulberry32(def.seed);
  const perW = 256;
  const perH = 512;
  const canvas = document.createElement('canvas');
  canvas.width = perW * def.count;
  canvas.height = perH;
  const ctx = canvas.getContext('2d')!;

  // 底纹：暖色大理石基底 + 云雾
  const grad = ctx.createLinearGradient(0, 0, 0, perH);
  grad.addColorStop(0, `hsl(${def.baseHue}, 28%, 92%)`);
  grad.addColorStop(0.5, `hsl(${def.baseHue + 4}, 22%, 86%)`);
  grad.addColorStop(1, `hsl(${def.baseHue - 3}, 26%, 90%)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 云雾斑块
  for (let i = 0; i < 90; i++) {
    const x = rnd() * canvas.width;
    const y = rnd() * perH;
    const r = 30 + rnd() * 90;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const dark = rnd() > 0.5;
    g.addColorStop(0, dark ? 'rgba(120,100,80,0.10)' : 'rgba(255,255,255,0.16)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // 主纹路：横向流动的竖向贯穿纹，沿荒料宽度方向连续，
  // 相邻板在左右接缝处纹路直接对上（大理石背景墙常见的横向连纹）
  const veinCount = 12;
  for (let v = 0; v < veinCount; v++) {
    const baseX = (v + 0.5) / veinCount * canvas.width + (rnd() - 0.5) * 26;
    const amp = 10 + rnd() * 26;
    const freq = 1.0 + rnd() * 1.8;
    const phase = rnd() * Math.PI * 2;
    const width = 0.8 + rnd() * 2.4;
    const alpha = 0.22 + rnd() * 0.38;
    const shade = 58 + rnd() * 40;

    const trace = (lineWidth: number, a: number, xOffset: number, phaseOffset: number) => {
      ctx.strokeStyle = `hsla(${def.baseHue - 10}, 30%, ${shade}%, ${a})`;
      ctx.lineWidth = lineWidth;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (let y = 0; y <= perH; y += 4) {
        const ny = y / perH;
        const x = baseX + xOffset
          + Math.sin(ny * Math.PI * 2 * freq + phase + phaseOffset) * amp
          + Math.sin(ny * Math.PI * 2 * freq * 2.3 + phase * 1.4) * amp * 0.25;
        if (y === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
    trace(width, alpha, 0, 0);
    // 主纹路旁的细支纹
    if (rnd() > 0.35) {
      trace(Math.max(0.5, width * 0.45), alpha * 0.55, 5 + rnd() * 9, 0.3);
    }
  }

  // 颗粒噪声
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rnd() - 0.5) * 10;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

export function generateDemoSlabs(): Slab[] {
  const slabs: Slab[] = [];
  for (const def of BLOCKS) {
    const blockCanvas = renderBlockCanvas(def);
    const perW = blockCanvas.width / def.count;
    for (let i = 0; i < def.count; i++) {
      const c = document.createElement('canvas');
      c.width = perW;
      c.height = blockCanvas.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(blockCanvas, i * perW, 0, perW, blockCanvas.height, 0, 0, perW, blockCanvas.height);

      // 板号水印，方便人工核对
      const code = `${def.blockId}-${String(i + 1).padStart(2, '0')}`;
      ctx.fillStyle = 'rgba(40,30,20,0.35)';
      ctx.font = 'bold 22px sans-serif';
      ctx.fillText(code, 10, 30);

      const slab: Slab = {
        id: uid('slab'),
        code,
        blockId: def.blockId,
        cutIndex: i + 1,
        widthMm: SLAB_W,
        heightMm: SLAB_H,
        imageW: c.width,
        imageH: c.height,
        frontDataUrl: c.toDataURL('image/jpeg', 0.82),
        cracks: []
      };
      slabs.push(slab);
    }
  }

  // 给 3 块板加裂纹（其中一块故意靠近插座区域，用于演示避让）
  const rnd = mulberry32(777);
  const crackTargets = [4, 11, 17];
  for (const idx of crackTargets) {
    const slab = slabs[idx];
    const sx = slab.widthMm * (0.2 + rnd() * 0.5);
    const sy = slab.heightMm * (0.25 + rnd() * 0.2);
    slab.cracks.push(makeCrack(uid('crack'), [
      { x: sx, y: sy },
      { x: sx + 60 + rnd() * 80, y: sy + 140 + rnd() * 120 },
      { x: sx + 20 + rnd() * 60, y: sy + 320 + rnd() * 160 }
    ]));
  }
  return slabs;
}

export function demoSurfaces(): Surface[] {
  // 别墅客厅背景墙：4800 × 3000，带门洞、窗洞、插座
  const wall: Surface = {
    id: uid('surf'),
    kind: 'wall',
    name: '客厅大理石背景墙',
    widthMm: 4800,
    heightMm: 3000,
    openings: [
      { id: uid('op'), type: 'door', label: '右侧门洞', x: 3900, y: 0, width: 900, height: 2100 },
      { id: uid('op'), type: 'socket', label: '电视插座组', x: 2050, y: 1350, width: 300, height: 120 },
      { id: uid('op'), type: 'socket', label: '低位插座', x: 600, y: 2650, width: 150, height: 100 }
    ]
  };
  const floor: Surface = {
    id: uid('surf'),
    kind: 'floor',
    name: '客厅地面展开图',
    widthMm: 6000,
    heightMm: 4800,
    openings: []
  };
  const counter: Surface = {
    id: uid('surf'),
    kind: 'countertop',
    name: '岛台台面展开图',
    widthMm: 3600,
    heightMm: 900,
    openings: [
      { id: uid('op'), type: 'socket', label: '台面走线孔', x: 1700, y: 380, width: 80, height: 80 }
    ]
  };
  return [wall, floor, counter];
}
