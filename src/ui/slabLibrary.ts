import type { AppState } from '../state/store';
import { store } from '../state/store';

export function renderSlabLibrary(state: AppState): void {
  const root = document.getElementById('slab-library')!;
  if (state.slabs.length === 0) {
    root.innerHTML = `
      <div class="hint">
        板库为空。<br>
        ① 拍照师傅对每块板的正面（饰面）和背面各拍一张；<br>
        ② 文件名按 <b>荒料号_序号_宽x高</b> 命名，如 <code>B1_0_1600x2400.jpg</code>；<br>
        ③ 同荒料板按切割顺序编号，相邻序号天然对纹。
      </div>
      <button id="btn-import" class="primary" style="width:100%;">导入大板照片</button>
    `;
    document.getElementById('btn-import')!.addEventListener('click', triggerImport);
    return;
  }

  const groups = new Map<string, AppState['slabs']>();
  for (const slab of state.slabs) {
    const list = groups.get(slab.blockId) ?? [];
    list.push(slab);
    groups.set(slab.blockId, list);
  }

  root.innerHTML = `
    <button id="btn-import" class="small" style="width:100%;margin-bottom:10px;">＋ 追加导入照片</button>
    ${[...groups.entries()]
      .map(([blockId, list]) => {
        const sorted = [...list].sort((a, b) => a.seq - b.seq);
        return `
          <div class="muted" style="margin:6px 0 4px;">荒料 ${blockId} · ${list.length} 片</div>
          ${sorted
            .map((s) => {
              const selected = state.selectedSlabId === s.id;
              return `
                <div class="slab-card ${selected ? 'selected' : ''}" data-slab="${s.id}">
                  <img class="thumb" src="${s.images.front.url}" alt="${s.id}" />
                  <div class="name">#${s.seq} 板 ${s.width}×${s.height} mm</div>
                  <div class="meta">
                    <span>${s.id}</span>
                    ${s.cracks.length > 0 ? `<span class="tag crack">裂纹×${s.cracks.length}</span>` : '<span class="tag">正常</span>'}
                  </div>
                  ${s.note ? `<div class="muted" style="margin-top:3px;">${s.note}</div>` : ''}
                </div>`;
            })
            .join('')}`;
      })
      .join('')}
  `;

  root.querySelectorAll<HTMLElement>('.slab-card').forEach((el) => {
    el.addEventListener('click', () => store.selectSlab(el.dataset.slab!));
  });
  document.getElementById('btn-import')!.addEventListener('click', triggerImport);
}

function triggerImport(): void {
  const input = document.getElementById('file-input') as HTMLInputElement;
  input.click();
}
