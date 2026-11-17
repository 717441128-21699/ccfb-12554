import type { LayoutSolution, Slab, Surface } from '../types';
import { extractFeatures } from '../vein';
import { solveLayout } from '../solver';
import { Renderer } from '../gl';

interface AppLike {
  state: import('../store').AppState;
  currentSurface: Surface | undefined;
  setOptions(patch: Partial<import('../store').AppState['options']>): void;
  persist?(): void;
  toast(m: string, k?: 'ok' | 'error' | ''): void;
}

export function renderLayoutView(root: HTMLElement, app: AppLike): () => void {
  root.innerHTML = `
    <div class="layout-page">
      <aside class="layout-sidebar" id="sidebar"></aside>
      <div class="canvas-host" id="host"><canvas class="gl" id="gl-canvas"></canvas></div>
    </div>`;

  const sidebar = root.querySelector('#sidebar')!;
  const host = root.querySelector<HTMLDivElement>('#host')!;
  const canvas = root.querySelector<HTMLCanvasElement>('#gl-canvas')!;

  let renderer: Renderer;
  try {
    renderer = new Renderer(canvas);
  } catch (e) {
    host.innerHTML = `<div class="empty"><div class="big">⚠</div><div>${(e as Error).message}</div></div>`;
    return () => { /* 无渲染器 */ };
  }

  const surface = app.currentSurface;
  const slabsById = new Map(app.state.slabs.map((s) => [s.id, s]));
  let solution: LayoutSolution | null = app.state.solution;
  let solving = false;

  const layerState = { seams: true, cracks: true, cuts: false, texture: true };

  const draw = () => {
    if (!surface) return;
    renderer.setWorldSize(surface.widthMm, surface.heightMm);
    const placements = solution?.placements ?? [];
    renderer.drawScene(surface.widthMm, surface.heightMm, placements, slabsById, {
      cells: solution?.cells,
      openings: surface.openings,
      seams: solution?.seams,
      cutPlans: solution?.cutPlans,
      showSeams: layerState.seams,
      showCracks: layerState.cracks,
      showCutLines: layerState.cuts,
      showTexture: layerState.texture
    });
  };

  const renderSidebar = () => {
    const opt = app.state.options;
    sidebar.innerHTML = `
      <div class="panel">
        <h3>连纹排版求解</h3>
        <p class="hint">当前展开图：<b>${surface?.name ?? '未选择'}</b></p>
        <h4>排版模式</h4>
        <div class="seg" id="mode-seg">
          <button data-mode="continue" class="${opt.mode === 'continue' ? 'active' : ''}">顺纹连铺</button>
          <button data-mode="bookmatch" class="${opt.mode === 'bookmatch' ? 'active' : ''}">书本对开</button>
        </div>
        <label class="toggle-row" style="margin-top:10px">
          <input type="checkbox" id="rot90" ${opt.rot90 ? 'checked' : ''} /> 整面旋转 90°（板竖铺）
        </label>
        <div class="row" style="margin-top:8px">
          <label class="field">束宽（候选路径数）<input type="number" id="beam" min="1" max="32" value="${opt.beamWidth}" /></label>
          <label class="field">接缝容忍 mm<input type="number" id="tol" min="0.5" step="0.5" value="${opt.toleranceMm}" /></label>
        </div>
        <button class="btn" id="solve-btn" style="width:100%" ${solving ? 'disabled' : ''}>
          ${solving ? '求解中…' : '⚡ 生成最优排版方案（10 秒内）'}
        </button>
        <p class="hint" id="solve-info"></p>
      </div>

      <div class="panel" style="margin-top:14px">
        <h3>图层</h3>
        <label class="toggle-row"><input type="checkbox" data-layer="texture" ${layerState.texture ? 'checked' : ''}/> 大板纹理（业主预览）</label>
        <label class="toggle-row"><input type="checkbox" data-layer="seams" ${layerState.seams ? 'checked' : ''}/> 接缝连纹质检</label>
        <label class="toggle-row"><input type="checkbox" data-layer="cracks" ${layerState.cracks ? 'checked' : ''}/> 裂纹标注</label>
        <label class="toggle-row"><input type="checkbox" data-layer="cuts" ${layerState.cuts ? 'checked' : ''}/> 切割刀路</label>
        <button class="btn secondary" id="fit-btn" style="width:100%;margin-top:8px">视图自适应</button>
        <button class="btn secondary" id="shot-btn" style="width:100%;margin-top:8px">导出整墙效果图 PNG（给业主）</button>
      </div>

      <div id="result-area"></div>`;

    sidebar.querySelectorAll<HTMLButtonElement>('#mode-seg button').forEach((b) => {
      b.onclick = () => {
        app.setOptions({ mode: b.dataset.mode as LayoutSolution['mode'] });
        renderSidebar();
      };
    });
    sidebar.querySelector<HTMLInputElement>('#rot90')!.onchange = (e) => {
      app.setOptions({ rot90: (e.target as HTMLInputElement).checked });
    };
    sidebar.querySelector<HTMLInputElement>('#beam')!.onchange = (e) => {
      app.setOptions({ beamWidth: Math.max(1, Math.min(32, Number((e.target as HTMLInputElement).value))) });
    };
    sidebar.querySelector<HTMLInputElement>('#tol')!.onchange = (e) => {
      app.setOptions({ toleranceMm: Number((e.target as HTMLInputElement).value) });
    };
    (sidebar.querySelector('#solve-btn') as HTMLElement).onclick = runSolve;
    (sidebar.querySelector('#fit-btn') as HTMLElement).onclick = () => renderer.fit();
    (sidebar.querySelector('#shot-btn') as HTMLElement).onclick = exportPng;
    sidebar.querySelectorAll<HTMLInputElement>('[data-layer]').forEach((cb) => {
      cb.onchange = () => {
        const k = cb.dataset.layer as keyof typeof layerState;
        layerState[k] = cb.checked;
        renderer.invalidate();
      };
    });

    renderResult();
  };

  const renderResult = () => {
    const area = sidebar.querySelector('#result-area')!;
    if (!solution) {
      area.innerHTML = `<div class="panel" style="margin-top:14px"><p class="hint">设置参数后点击「生成最优排版方案」。系统会枚举每块板的旋转/对开姿态，按接缝纹路连续性做束搜索，自动选最优摆法。</p></div>`;
      return;
    }
    const r = solution;
    const pct = (v: number) => (v * 100).toFixed(1) + '%';
    const seamOk = r.seams.filter((s) => s.withinTolerance).length;
    const maxDiff = r.seams.reduce((m, s) => Math.max(m, s.meanDiff), 0);

    area.innerHTML = `
      <div class="panel" style="margin-top:14px">
        <h3>出材率与用量（老板视角）</h3>
        <div class="kpi-grid">
          <div class="kpi"><div class="v good">${pct(r.utilization)}</div><div class="l">出材率</div></div>
          <div class="kpi"><div class="v">${r.usedSlabCount}<span style="font-size:13px;color:var(--muted)">/${r.batchSlabCount}</span></div><div class="l">用板 / 批次总量</div></div>
          <div class="kpi"><div class="v">${(r.slabAreaTotal / 1e6).toFixed(2)}㎡</div><div class="l">投板毛面积</div></div>
          <div class="kpi"><div class="v">${(r.neededCoverage / 1e6).toFixed(2)}㎡</div><div class="l">实际覆盖面积</div></div>
        </div>
        <div class="stat-line"><span>求解耗时</span><b>${r.solveMs} ms</b></div>
        <div class="stat-line"><span>剩余可用板</span><b>${r.remainingSlabIds.length} 块</b></div>
        ${r.uncoveredCells ? `<div class="warn-row"><span class="dot red"></span>板材不足，${r.uncoveredCells} 个格子未覆盖</div>` : ''}
      </div>

      <div class="panel" style="margin-top:14px">
        <h3>接缝连纹质检（≤ ${r.toleranceMm}mm 合格）</h3>
        <div class="kpi-grid">
          <div class="kpi"><div class="v ${seamOk === r.seams.length ? 'good' : 'bad'}">${seamOk}/${r.seams.length}</div><div class="l">合格接缝</div></div>
          <div class="kpi"><div class="v ${maxDiff <= r.toleranceMm ? 'good' : 'bad'}">${maxDiff.toFixed(1)}mm</div><div class="l">最大纹路错位</div></div>
        </div>
        <div class="check-list">
          ${r.seams.map((s) => `
            <div class="seam-row">
              <span class="dot ${s.withinTolerance ? 'green' : 'red'}"></span>
              <span style="flex:1">${s.kind === 'vertical' ? '竖缝' : '横缝'} ${s.slabA} ↔ ${s.slabB}</span>
              <b style="color:${s.withinTolerance ? 'var(--green)' : 'var(--red)'}">${s.meanDiff.toFixed(1)}mm</b>
            </div>`).join('')}
        </div>
      </div>

      <div class="panel" style="margin-top:14px">
        <h3>裂纹避让</h3>
        ${r.crackViolations.length === 0
          ? `<div class="seam-row"><span class="dot green"></span>所有裂纹均已避开洞口与插座</div>`
          : r.crackViolations.map((m) => `<div class="warn-row"><span class="dot amber"></span>${m}</div>`).join('')}
      </div>

      <div class="panel" style="margin-top:14px">
        <h3>切割图（刀路与先后顺序）</h3>
        ${r.cutPlans.map((p) => `
          <div class="cut-row" style="display:block">
            <div style="display:flex;justify-content:space-between">
              <b>${p.code}</b><span class="hint">总刀序 #${p.globalOrder}</span>
            </div>
            ${p.steps.length === 0 ? '<div class="hint" style="margin-top:4px">整板使用，无需裁切</div>' : ''}
            ${p.steps.map((st) => `
              <div class="cut-step">
                <b>第 ${st.order} 刀 · ${st.action}</b>
                <div class="lines">${st.lines.map((l) =>
                  `(${l.from.x.toFixed(0)},${l.from.y.toFixed(0)})→(${l.to.x.toFixed(0)},${l.to.y.toFixed(0)}) ${l.reason}`
                ).join('<br>')}</div>
              </div>`).join('')}
            ${p.openingCuts.map((o) => `<div class="hint">开孔 ${o.opening.label}：板面局部 (${o.localRect.x.toFixed(0)}, ${o.localRect.y.toFixed(0)}) ${o.localRect.w.toFixed(0)}×${o.localRect.h.toFixed(0)}mm</div>`).join('')}
            ${p.crackWarnings.map((w) => `<div class="warn-row" style="margin-top:6px"><span class="dot amber"></span>${w}</div>`).join('')}
          </div>`).join('')}
      </div>`;
  };

  const runSolve = async () => {
    if (!surface) {
      app.toast('请先在第 ② 步选择一张展开图', 'error');
      return;
    }
    if (app.state.slabs.length === 0) {
      app.toast('板材库为空，请先导入或生成演示板', 'error');
      return;
    }
    solving = true;
    renderSidebar();
    const info = sidebar.querySelector('#solve-info')!;
    info.textContent = '正在提取四张板边纹路特征…';

    try {
      const t0 = performance.now();
      const features = new Map();
      for (const slab of app.state.slabs) {
        const f = await extractFeatures(slab);
        features.set(slab.id, f);
        await renderer.uploadTexture(slab);
      }
      info.textContent = '束搜索枚举姿态与接缝组合…';
      await new Promise((r) => setTimeout(r, 30)); // 让 UI 刷新

      const result = solveLayout(surface, app.state.slabs, features, {
        mode: app.state.options.mode,
        rot90: app.state.options.rot90,
        beamWidth: app.state.options.beamWidth,
        toleranceMm: app.state.options.toleranceMm
      });
      const total = Math.round(performance.now() - t0);
      solution = result;
      app.state.solution = result;
      app.persist?.();
      solving = false;
      renderSidebar();
      renderer.invalidate();
      app.toast(`方案生成完成，总耗时 ${total}ms，出材率 ${(result.utilization * 100).toFixed(1)}%`, 'ok');
    } catch (e) {
      solving = false;
      renderSidebar();
      app.toast('求解失败：' + (e as Error).message, 'error');
    }
  };

  const exportPng = () => {
    renderer.fit();
    renderer.invalidate();
    setTimeout(() => {
      const merged = document.createElement('canvas');
      merged.width = canvas.width;
      merged.height = canvas.height;
      const ctx = merged.getContext('2d')!;
      ctx.drawImage(canvas, 0, 0);
      const overlay = host.querySelector('canvas:not(.gl)') as HTMLCanvasElement;
      if (overlay) ctx.drawImage(overlay, 0, 0);
      const a = document.createElement('a');
      a.download = `${surface?.name ?? 'layout'}-整墙效果图.png`;
      a.href = merged.toDataURL('image/png');
      a.click();
      app.toast('效果图已导出', 'ok');
    }, 120);
  };

  renderSidebar();
  requestAnimationFrame(() => {
    renderer.resize();
    draw();
    renderer.startLoop(draw);
  });

  if (solution) {
    // 已有方案时补传纹理
    (async () => {
      for (const s of app.state.slabs) await renderer.uploadTexture(s);
      renderer.invalidate();
    })();
  }

  return () => renderer.dispose();
}
