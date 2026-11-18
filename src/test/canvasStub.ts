/**
 * Node 测试环境的最小 Canvas 桩：
 * 合成数据的几何/签名不依赖渲染像素，仅 toDataURL 需要一个可调用对象。
 */
class StubGradient {
  addColorStop(): void {}
}

class StubCtx {
  canvas: { width: number; height: number };
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 1;
  lineCap = 'butt';
  lineJoin = 'miter';

  constructor(canvas: { width: number; height: number }) {
    this.canvas = canvas;
  }
  createLinearGradient(): StubGradient {
    return new StubGradient();
  }
  fillRect(): void {}
  beginPath(): void {}
  arc(): void {}
  fill(): void {}
  moveTo(): void {}
  lineTo(): void {}
  stroke(): void {}
}

function installCanvasStub(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if (g.document) return;
  g.document = {
    createElement: (tag: string) => {
      if (tag !== 'canvas') throw new Error(`stub only supports canvas, got ${tag}`);
      const el = {
        width: 0,
        height: 0,
        getContext: () => new StubCtx(el),
        toDataURL: () => 'data:image/png;base64,stub',
      };
      return el;
    },
  };
}

installCanvasStub();
