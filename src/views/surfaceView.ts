import type { Opening, OpeningType, Surface } from '../types';
import { uid } from '../store';
import { Renderer } from '../gl';

interface AppLike {
  state: import('../store').AppState;
  currentSurface: Surface | undefined;
  addSurface(kind: Surface['kind']): void;
  selectSurface(id: string): void;
  updateSurface(s: Surface): void;
  toast(m: string, k?: 'ok' | 'error' | ''): void;
}

const TYPE_LABEL: Record<OpeningType, string> = { door: '门洞', window: '窗洞', socket: '插座' };

export function renderSurfaceView(root: HTMLElement, app: AppLike): () => void {
  root.innerHTML = `
    <div class="surface-page">
      <aside class="surface-sidebar">
        <div class="panel">
          <h3>展开图列表</h3>
          <div id="surface-list" style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px"></div>
          <div class="row">
            <button class="btn secondary" data-add="wall">+ 墙面</button>
            <button class="btn secondary" data-add="floor">+ 地面</button>
            <button class="btn secondary" data-add="countertop">+ 台面</button>
          </div>
        </div>
        <div class="panel" style="margin-top:14px" id="surface-editor"></div>
      </aside>
      <div class="canvas-host" id="host"><canvas class="gl" id="gl-canvas"></canvas></div>
    </div>`;

  const listEl = root.querySelector('#surface-list')!;
  const editorEl = root.querySelector('#surface-editor')!;
  const host = root.querySelector<HTMLDivElement>('#host')!;
  const canvas = root.querySelector<HTMLCanvasElement>('#gl-canvas')!;

  let renderer: Renderer | null = null;
  try {
    renderer = new Renderer(canvas);
  } catch (e) {
    host.innerHTML = `<div class="empty"><div class="big">⚠</div><div>${(e as Error).message}</div></div>`;
  }

  const renderList = () => {
    listEl.innerHTML = '';
    for (const s of app.state.surfaces) {
      const b = document.createElement('button');
      b.className = 'btn secondary' + (s.id === app.state.currentSurfaceId ? ' active' : '');
      b.style.textAlign = 'left';
      b.innerHTML = `<b>${s.name}</b><br><span class="hint">${s.widthMm}×${s.heightMm}mm · ${s.openings.length} 个洞口</span>`;
      b.onclick = () => app.selectSurface(s.id);
      listEl.appendChild(b);
    }
    root.querySelectorAll<HTMLButtonElement>('[data-add]').forEach((btn) => {
      btn.onclick = () => app.addSurface(btn.dataset.add as Surface['kind']);
    });
  };

  const drawPreview = () => {
    const s = app.currentSurface;
    if (!renderer || !s) return;
    renderer.setWorldSize(s.widthMm, s.heightMm);
    renderer.drawScene(s.widthMm, s.heightMm, [], new Map(), { openings: s.openings });
    renderer.invalidate();
  };

  const renderEditor = () => {
    const s = app.currentSurface;
    if (!s) {
      editorEl.innerHTML = `<p class="hint">选择或新建一张展开图</p>`;
      return;
    }
    editorEl.innerHTML = `
      <h3>${s.name}</h3>
      <label class="field">名称<input type="text" id="sf-name" value="${s.name}" /></label>
      <div class="row">
        <label class="field">宽 mm<input type="number" id="sf-w" value="${s.widthMm}" min="100" step="50" /></label>
        <label class="field">高 mm<input type="number" id="sf-h" value="${s.heightMm}" min="100" step="50" /></label>
      </div>
      <h4>添加洞口 / 插座</h4>
      <div class="row" style="margin-bottom:8px">
        <select id="op-type">
          <option value="door">门洞</option>
          <option value="window">窗洞</option>
          <option value="socket">插座</option>
        </select>
        <button class="btn" id="add-op">添加</button>
      </div>
      <div id="op-list"></div>`;

    const sync = () => {
      s.name = editorEl.querySelector<HTMLInputElement>('#sf-name')!.value;
      s.widthMm = Number(editorEl.querySelector<HTMLInputElement>('#sf-w')!.value);
      s.heightMm = Number(editorEl.querySelector<HTMLInputElement>('#sf-h')!.value);
      app.updateSurface(s);
      drawPreview();
    };
    (['#sf-name', '#sf-w', '#sf-h'] as const).forEach((sel) =>
      editorEl.querySelector(sel)!.addEventListener('change', sync)
    );

    (editorEl.querySelector('#add-op') as HTMLElement).onclick = () => {
      const type = editorEl.querySelector<HTMLSelectElement>('#op-type')!.value as OpeningType;
      const size = type === 'socket' ? { w: 200, h: 120 } : type === 'door' ? { w: 900, h: 2100 } : { w: 1500, h: 1200 };
      s.openings.push({
        id: uid('op'),
        type,
        label: TYPE_LABEL[type] + (s.openings.filter((o) => o.type === type).length + 1),
        x: Math.round(s.widthMm * 0.2),
        y: type === 'door' ? 0 : Math.round(s.heightMm * 0.4),
        width: size.w,
        height: size.h
      });
      app.updateSurface(s);
      renderEditor();
      drawPreview();
    };

    const opList = editorEl.querySelector('#op-list')!;
    const renderOps = () => {
      opList.innerHTML = '';
      s.openings.forEach((op: Opening, idx: number) => {
        const item = document.createElement('div');
        item.className = 'opening-item';
        item.innerHTML = `
          <div class="oi-head">
            <span class="tag ${op.type}">${TYPE_LABEL[op.type]}</span>
            <button class="btn danger" style="padding:3px 10px">删除</button>
          </div>
          <label class="field">标注<input data-f="label" value="${op.label}" /></label>
          <div class="row">
            <label class="field">X mm<input data-f="x" type="number" value="${op.x}" step="10" /></label>
            <label class="field">Y mm<input data-f="y" type="number" value="${op.y}" step="10" /></label>
          </div>
          <div class="row">
            <label class="field">宽 mm<input data-f="width" type="number" value="${op.width}" step="10" /></label>
            <label class="field">高 mm<input data-f="height" type="number" value="${op.height}" step="10" /></label>
          </div>`;
        item.querySelector('button')!.onclick = () => {
          s.openings.splice(idx, 1);
          app.updateSurface(s);
          renderEditor();
          drawPreview();
        };
        item.querySelectorAll<HTMLInputElement>('[data-f]').forEach((inp) => {
          inp.onchange = () => {
            const f = inp.dataset.f as keyof Opening;
            if (f === 'label') (op[f] as string) = inp.value;
            else (op[f] as number) = Number(inp.value);
            app.updateSurface(s);
            drawPreview();
          };
        });
        opList.appendChild(item);
      });
    };
    renderOps();
  };

  renderList();
  renderEditor();
  // 等待布局完成后再初始化画布尺寸
  requestAnimationFrame(() => {
    renderer?.resize();
    drawPreview();
    if (renderer) renderer.startLoop(drawPreview);
  });
  return () => renderer?.dispose();
}
