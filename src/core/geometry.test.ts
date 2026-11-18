import { describe, expect, it } from 'vitest';
import {
  ALL_ORIENTATIONS,
  edgeOnPlacedSide,
  orientPoint,
  orientedSize,
  polylineRectDistance,
  unorientPoint,
  v,
} from './geometry';

const W = 1200;
const H = 800;

describe('orientPoint / unorientPoint 互逆', () => {
  it('8 种朝向下正反变换闭合', () => {
    const p = v(320, 540);
    for (const o of ALL_ORIENTATIONS) {
      const q = orientPoint(p, W, H, o);
      const back = unorientPoint(q, W, H, o);
      expect(back.x).toBeCloseTo(p.x, 6);
      expect(back.y).toBeCloseTo(p.y, 6);
    }
  });

  it('90° 旋转交换宽高', () => {
    expect(orientedSize(W, H, { rot: 90, flipX: false })).toEqual({ x: H, y: W });
    expect(orientedSize(W, H, { rot: 0, flipX: true })).toEqual({ x: W, y: H });
  });

  it('水平镜像后左右互换', () => {
    const q = orientPoint(v(10, 20), W, H, { rot: 0, flipX: true });
    expect(q).toEqual({ x: W - 10, y: 20 });
  });
});

describe('edgeOnPlacedSide 边映射', () => {
  it('无变换时恒等映射', () => {
    const m = edgeOnPlacedSide(W, H, { rot: 0, flipX: false }, 'right');
    expect(m.edge).toBe('right');
    expect(m.reversed).toBe(false);
  });

  it('180° 旋转后 placed right 对应原 left 且反向', () => {
    const m = edgeOnPlacedSide(W, H, { rot: 180, flipX: false }, 'right');
    expect(m.edge).toBe('left');
    expect(m.reversed).toBe(true);
  });

  it('水平镜像后 placed left 对应原 right 边', () => {
    const m = edgeOnPlacedSide(W, H, { rot: 0, flipX: true }, 'left');
    expect(m.edge).toBe('right');
    const r = edgeOnPlacedSide(W, H, { rot: 0, flipX: true }, 'right');
    expect(r.edge).toBe('left');
  });

  it('每种朝向四角映射都落在合法边上', () => {
    for (const o of ALL_ORIENTATIONS) {
      for (const side of ['left', 'right', 'top', 'bottom'] as const) {
        const m = edgeOnPlacedSide(W, H, o, side);
        expect(['left', 'right', 'top', 'bottom']).toContain(m.edge);
      }
    }
  });
});

describe('polylineRectDistance', () => {
  it('穿过矩形返回 0', () => {
    const d = polylineRectDistance([v(0, 50), v(200, 50)], { x: 80, y: 0, width: 40, height: 100 });
    expect(d).toBe(0);
  });

  it('外部折线取最近距离', () => {
    const d = polylineRectDistance([v(0, -30), v(200, -30)], { x: 80, y: 0, width: 40, height: 100 });
    expect(d).toBeCloseTo(30, 6);
  });
});
