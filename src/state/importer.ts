import { detectVeins } from '../core/veinDetect';
import type { Slab } from '../core/types';

export interface ImportMeta {
  blockId: string;
  seq: number;
  widthMm: number;
  heightMm: number;
}

export interface ImportResult {
  slab: Slab;
  warnings: string[];
}

/**
 * 导入一块板的正面照片并跑纹路检测。
 * 文件名约定：`荒料号_序号_宽x高.jpg`（序号即切割顺序），
 * 也可由调用方显式传入 meta。背面照片暂仅存档，不参与检测。
 */
export async function importSlab(
  frontFile: File,
  meta: ImportMeta,
  backFile?: File,
): Promise<ImportResult> {
  const warnings: string[] = [];
  const frontUrl = await toObjectUrl(frontFile);
  const dims = await imageSize(frontUrl);
  const back = backFile
    ? { url: await toObjectUrl(backFile), width: 0, height: 0 }
    : undefined;
  if (back) {
    const bd = await imageSize(back.url).catch(() => null);
    if (bd) Object.assign(back, bd);
  }

  const { veins, cracks } = await detectVeins(frontUrl, meta.widthMm, meta.heightMm);
  if (cracks.length > 0) {
    warnings.push(`检测到 ${cracks.length} 条疑似裂纹，请在板库中人工复核`);
  }
  const hasVein = Object.values(veins.edges).some(
    (e) => e.crossings.filter((c) => c !== null).length >= 3,
  );
  if (!hasVein) warnings.push('纹路特征较弱，对纹结果可能不稳定，建议重拍正面照');

  const slab: Slab = {
    id: `${meta.blockId}-s${meta.seq}-${Date.now().toString(36)}`,
    blockId: meta.blockId,
    seq: meta.seq,
    width: meta.widthMm,
    height: meta.heightMm,
    images: {
      front: { url: frontUrl, width: dims.width, height: dims.height },
      ...(back ? { back } : {}),
    },
    cracks,
    veins,
  };
  return { slab, warnings };
}

/** 从文件名解析 `B12_3_1600x2400` 形式的元数据，失败返回 null */
export function parseFileName(name: string): ImportMeta | null {
  const m = name.match(/^([A-Za-z0-9]+)[_\-](\d+)[_\-](\d+)\s*[x×]\s*(\d+)/i);
  if (!m) return null;
  return {
    blockId: m[1],
    seq: Number(m[2]),
    widthMm: Number(m[3]),
    heightMm: Number(m[4]),
  };
}

function toObjectUrl(file: File): Promise<string> {
  return Promise.resolve(URL.createObjectURL(file));
}

function imageSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = reject;
    img.src = url;
  });
}
