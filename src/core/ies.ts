// IESNA LM-63-1995/2002 文本格式解析。
// 格式要点:TILT 行之前是方括号标签;TILT 行之后先是 10~13 个标量参数,
// 再依次是垂直角数组、水平角数组、光强(坎德拉)二维表。
import type { IESData } from './types.ts';

export class IESParseError extends Error {}

/** 把剩余 token 全部拆成数字流,后续按顺序消费 */
function tokenize(lines: string[], startLine: number): { tokens: number[]; consume: () => number } {
  const raw: string[] = [];
  for (let i = startLine; i < lines.length; i++) raw.push(...lines[i].trim().split(/\s+/));
  const tokens = raw.filter((t) => t.length > 0).map(Number);
  if (tokens.some((n) => Number.isNaN(n))) {
    throw new IESParseError('数据段存在无法解析为数字的字段');
  }
  let pos = 0;
  const consume = (): number => {
    if (pos >= tokens.length) throw new IESParseError('数据长度不足,文件可能被截断');
    return tokens[pos++];
  };
  return { tokens, consume };
}

/** 从标签行里提取 [KEY] VALUE 形式的字段 */
function extractTag(labels: string[], key: string): string {
  const re = new RegExp(`^\\[${key}\\]\\s*(.*)$`, 'i');
  for (const line of labels) {
    const m = line.match(re);
    if (m) return m[1].trim();
  }
  return '';
}

export function parseIES(text: string, fileName = 'upload.ies'): IESData {
  const lines = text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (!lines.length) throw new IESParseError('文件为空');

  // 1. 找 TILT 行,前面的是标签
  let tiltLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^TILT\s*=/i.test(lines[i])) {
      tiltLine = i;
      break;
    }
  }
  if (tiltLine < 0) throw new IESParseError('找不到 TILT= 行,不是合法的 IESNA LM-63 文件');

  const labels = lines.slice(0, tiltLine).filter((l) => l.startsWith('['));
  const tiltSpec = lines[tiltLine].split('=')[1]?.trim().toUpperCase() ?? '';
  if (tiltSpec !== 'NONE') {
    // TILT=<文件名> 形式需要再读一张倾斜修正表,商用灯具文件几乎都用 NONE
    throw new IESParseError(`暂不支持 TILT=${tiltSpec}(仅支持 TILT=NONE 的灯具文件)`);
  }

  const { consume } = tokenize(lines, tiltLine + 1);
  const nLamps = consume();
  const lumensPerLamp = consume();
  const multiplier = consume();
  const nVert = Math.round(consume());
  const nHoriz = Math.round(consume());
  const photometricType = Math.round(consume());
  const unitsType = Math.round(consume());
  const openingWidth = consume();
  const openingLength = consume();
  const openingHeight = consume();
  const ballastFactor = consume();
  const futureUse = consume();
  const inputWatts = consume();
  void futureUse;

  if (nVert <= 0 || nHoriz <= 0) throw new IESParseError('垂直/水平角数量非法');
  if (nVert > 4096 || nHoriz > 4096) throw new IESParseError('角度采样数量异常,文件可能损坏');

  const vertAngles: number[] = [];
  for (let i = 0; i < nVert; i++) vertAngles.push(consume());
  const horizAngles: number[] = [];
  for (let i = 0; i < nHoriz; i++) horizAngles.push(consume());

  // candela 表按水平角逐行排列,每行 nVert 个垂直角
  const candela: number[][] = [];
  for (let h = 0; h < nHoriz; h++) {
    const row: number[] = [];
    for (let v = 0; v < nVert; v++) row.push(consume() * multiplier);
    candela.push(row);
  }

  // 角度合法性:垂直角应单调递增且在 0..180
  for (let i = 1; i < nVert; i++) {
    if (vertAngles[i] <= vertAngles[i - 1]) {
      throw new IESParseError('垂直角不是严格递增序列');
    }
  }
  for (let i = 1; i < nHoriz; i++) {
    if (horizAngles[i] < horizAngles[i - 1]) {
      throw new IESParseError('水平角不是递增序列');
    }
  }

  const manufacturer = extractTag(labels, 'MANUFAC');
  const catalogNumber = extractTag(labels, 'CATALOG') || extractTag(labels, 'LUMCAT');
  const lamp = extractTag(labels, 'LAMP') || extractTag(labels, 'LAMPCAT');
  const label =
    extractTag(labels, 'TESTLAB') ||
    catalogNumber ||
    fileName.replace(/\.ies$/i, '');

  return {
    fileName,
    label,
    manufacturer,
    catalogNumber,
    lamp,
    nLamps,
    lumensPerLamp,
    multiplier,
    nVert,
    nHoriz,
    photometricType,
    unitsType,
    openingWidth,
    openingLength,
    openingHeight,
    ballastFactor,
    inputWatts,
    vertAngles,
    horizAngles,
    candela,
  };
}

/** 对光强表做球面积分求总光通量(lm)。
 *  Φ = ∫₀²π ∫₀^π I(θ,φ)·sinθ dθ dφ,垂直方向梯形积分,水平方向取平面均值。 */
export function integrateLumens(ies: IESData): number {
  const { vertAngles: va, horizAngles: ha, candela } = ies;

  // 每个水平平面的垂直积分 P(h) = ∫ I(h,θ) sinθ dθ
  const planes: number[] = [];
  for (let h = 0; h < ha.length; h++) {
    let plane = 0;
    for (let v = 0; v < va.length - 1; v++) {
      const t0 = (va[v] * Math.PI) / 180;
      const t1 = (va[v + 1] * Math.PI) / 180;
      const sinInt = Math.cos(t0) - Math.cos(t1); // ∫sinθ dθ
      plane += 0.5 * (candela[h][v] + candela[h][v + 1]) * sinInt;
    }
    planes.push(plane);
  }

  if (ha.length === 1) {
    // 轴对称:单个平面代表整圈
    return planes[0] * 2 * Math.PI;
  }

  const span = ha[ha.length - 1] - ha[0];
  const fullCircle = span >= 359.999;
  // 全圆数据的首尾平面在物理上是同一方向,用梯形法并闭合;
  // 90/180 度等对称数据则在给定跨度上梯形积分后按对称倍数扩展到 2π。
  let hIntegral = 0;
  const dPhi = (d: number): number => (d * Math.PI) / 180;
  if (fullCircle) {
    for (let h = 0; h < ha.length - 1; h++) {
      hIntegral += 0.5 * (planes[h] + planes[h + 1]) * dPhi(ha[h + 1] - ha[h]);
    }
    return hIntegral;
  }
  for (let h = 0; h < ha.length - 1; h++) {
    hIntegral += 0.5 * (planes[h] + planes[h + 1]) * dPhi(ha[h + 1] - ha[h]);
  }
  const symmetryFactor = (2 * Math.PI) / dPhi(span);
  return hIntegral * symmetryFactor;
}
