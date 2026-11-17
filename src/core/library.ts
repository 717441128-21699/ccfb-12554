// 灯具库构建:解析 IES → 积分通量 → 业务灯具对象。
import type { IESData, Luminaire } from './types.ts';
import { integrateLumens } from './ies.ts';
import { uid } from './store.ts';

export function createLuminaire(ies: IESData): Luminaire {
  const integratedLumens = integrateLumens(ies);
  const ratedLumens =
    ies.lumensPerLamp > 0 ? ies.lumensPerLamp * Math.max(1, ies.nLamps) : integratedLumens;
  let peakCandela = 0;
  for (const row of ies.candela) for (const v of row) peakCandela = Math.max(peakCandela, v);
  return {
    id: uid('lum'),
    ies,
    ratedLumens: Math.round(ratedLumens),
    integratedLumens,
    peakCandela,
  };
}

/** 内置示例灯具(public/samples) */
export async function loadBuiltinSamples(fetchText: (url: string) => Promise<string>): Promise<IESData[]> {
  const { parseIES } = await import('./ies.ts');
  const files = ['downlight-24deg.ies', 'panel-90deg.ies', 'track-spot-36deg.ies'];
  const out: IESData[] = [];
  for (const f of files) {
    try {
      const text = await fetchText(`samples/${f}`);
      out.push(parseIES(text, f));
    } catch {
      // 示例缺失时跳过
    }
  }
  return out;
}
