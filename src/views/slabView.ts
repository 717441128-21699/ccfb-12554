import type { Slab } from '../types';
import { makeCrack, uid } from '../store';
import { localToWorld } from '../geometry';
import { SLAB_W, SLAB_H } from '../demo';

type App = unknown;
// App 类没有默认导出，这里用结构化最小接口
interface AppLike {
  state: import('../store').AppState;
  addSlab(s: Slab): void;
  removeSlab(id: string): void;
  persist(): void;
  toast(m: string, k?: 'ok' | 'error' | ''): void;
  render(): void;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function imageSize(dataUrl: string): Promise<{ w: number; h: number }> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  return { w: img.naturalWidth, h: img.naturalHeight };
}

export function renderSlabView(root: HTMLElement, app: AppLike): () => void {
  root.innerHTML = `
    <div class="slab-page">
      <aside class="slab-sidebar">
        <div class="panel">
          <h3>板材入库</h3>
          <p class="hint">师傅现场对大板正反面拍照导入；尺寸按毫米录入；同一荒料按切割顺序编号。</p>
          <label class="field">正面照片（可多选）
            <input type="file" id="front-files" accept="image/*" multiple />
          </label>
          <label class="field">背面照片（可选，与正面同名自动配对）
            <input type="file" id="back-files" accept="image/*" multiple />
          </label>
          <div class="row">
            <label class="field">板宽 mm<input type="number" id="slab-w" value="${SLAB_W}" min="100" step="10" /></label>
            <label class="field">板高 mm<input type="number" id="slab-h" value="${SLAB_H}" min="100" step="10" /></label>
          </div>
          <label class="field">荒料号<input type="text" id="block-id" value="BLK-D" /></label>
          <label class="field">起始切割序号<input type="number" id="cut-from" value="1" min="1" /></label>
          <button class="btn" id="import-btn" style="width:100%">导入板材</button>
        </div>
        <div class="panel" style="margin-top:14px">
          <h3>批次统计</h3>
          <div id="batch-stats"></div>
        </div>
      </aside>
      <div class="slab-grid-wrap" id="grid-wrap"></div>
    </div>`;

  const gridWrap = root.querySelector('#grid-wrap')!;
  const stats = root.querySelector('#batch-stats')!;

  const renderStats = () => {
    const slabs = app.state.slabs;
    const blocks = new Map<string, Slab[]>();
    for (const s of slabs) {
      const arr = blocks.get(s.blockId) ?? [];
      arr.push(s);
      blocks.set(s.blockId, arr);
    }
    stats.innerHTML = `
      <div class="stat-line"><span>板材总数</span><b>${slabs.length} 块</b></div>
      <div class="stat-line"><span>荒料批次</span><b>${blocks.size} 个</b></div>
      <div class="stat-line"><span>标注裂纹</span><b>${slabs.reduce((n, s) => n + s.cracks.length, 0)} 处</b></div>`;
  };

  const renderGrid = (selectedId?: string) => {
    const slabs = [...app.state.slabs].sort((a, b) =>
      a.blockId.localeCompare(b.blockId) || a.cutIndex - b.cutIndex
    );
    const groups = new Map<string, Slab[]>();
    for (const s of slabs) {
      const arr = groups.get(s.blockId) ?? [];
      arr.push(s);
      groups.set(s.blockId, arr);
    }
    gridWrap.innerHTML = '';
    if (slabs.length === 0) {
      gridWrap.innerHTML = `<div class="empty"><div class="big">▱</div><div>还没有板材，可在左侧导入照片，或点右上角生成 20 块演示板</div></div>`;
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'slab-grid';
    for (const [blockId, arr] of groups) {
      const title = document.createElement('div');
      title.className = 'block-group-title';
      title.textContent = `荒料 ${blockId} · ${arr.length} 块（切割顺序 ${arr[0].cutIndex}–${arr[arr.length - 1].cutIndex}，相邻板纹路相连）`;
      grid.appendChild(title);
      for (const slab of arr) {
        const card = document.createElement('div');
        card.className = 'slab-card' + (slab.id === selectedId ? ' selected' : '');
        card.innerHTML = `
          <img class="thumb" src="${slab.frontDataUrl}" alt="${slab.code}" />
          ${slab.cracks.length ? `<span class="crack-badge">裂纹 ×${slab.cracks.length}</span>` : ''}
          <div class="meta">
            <b>${slab.code}</b>
            <span>${slab.widthMm} × ${slab.heightMm} mm · 序号 ${slab.cutIndex}</span>
          </div>`;
        card.onclick = () => openDetail(slab);
        grid.appendChild(card);
      }
    }
    gridWrap.appendChild(grid);
  };

  const openDetail = (slab: Slab) => {
    renderGrid(slab.id);
    const host = document.createElement('div');
    host.style.cssText = 'margin-top:16px;display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:16px;';
    host.innerHTML = `
      <div class="panel">
        <h3>${slab.code} · 裂纹标注（在图上点击添加折线点，双击结束；点错可撤销）</h3>
        <canvas class="slab-detail-canvas" id="detail-canvas"></canvas>
        <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn secondary" id="undo-pt">撤销上一点</button>
          <button class="btn secondary" id="finish-crack">完成裂纹</button>
          <button class="btn secondary" id="clear-cracks">清除全部裂纹</button>
          <button class="btn danger" id="delete-slab">删除该板</button>
        </div>
      </div>
      <div class="panel">
        <h3>板材信息</h3>
        <div class="stat-line"><span>板号</span><b>${slab.code}</b></div>
        <div class="stat-line"><span>荒料</span><b>${slab.blockId}</b></div>
        <div class="stat-line"><span>切割序号</span><b>${slab.cutIndex}</b></div>
        <div class="stat-line"><span>尺寸</span><b>${slab.widthMm}×${slab.heightMm}</b></div>
        <div class="stat-line"><span>裂纹数</span><b>${slab.cracks.length}</b></div>
        ${slab.backDataUrl ? `<h4>背面照片（存档核对）</h4><img src="${slab.backDataUrl}" style="width:100%;border-radius:8px;border:1px solid var(--border);opacity:.85" />` : ''}
        <h4>姿态预览（旋转 / 书本对开）</h4>
        <canvas id="pose-canvas" style="width:100%;background:#0b0e12;border-radius:8px;border:1px solid var(--border)"></canvas>
        <div class="seg" style="margin-top:8px">
          <button data-pose="0" class="active">原样</button>
          <button data-pose="1">水平镜像</button>
          <button data-pose="2">180°</button>
          <button data-pose="3">垂直镜像</button>
        </div>
        <label class="toggle-row"><input type="checkbox" id="pose-rot" /> 顺时针旋转 90°</label>
      </div>`;
    gridWrap.appendChild(host);

    const canvas = host.querySelector<HTMLCanvasElement>('#detail-canvas')!;
    const ctx = canvas.getContext('2d')!;
    const img = new Image();
    img.src = slab.frontDataUrl;
    img.onload = () => {
      const maxW0 = host.querySelector('.panel')!.clientWidth - 36;
      const scale0 = Math.min(maxW0 / img.width, 520 / img.height);
      canvas.width = img.width * scale0;
      canvas.height = img.height * scale0;
      redraw();
      drawPose();
    };

    let draft: { x: number; y: number }[] = [];
    const redraw = () => {
      const scale = canvas.width / img.width;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const drawCrack = (pts: { x: number; y: number }[], color: string) => {
        ctx.strokeStyle = color; ctx.lineWidth = 2;
        ctx.beginPath();
        pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x * scale, p.y * scale) : ctx.lineTo(p.x * scale, p.y * scale));
        ctx.stroke();
        pts.forEach((p) => {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(p.x * scale, p.y * scale, 3.5, 0, Math.PI * 2);
          ctx.fill();
        });
      };
      slab.cracks.forEach((c) => drawCrack(c.points, 'rgba(255,70,70,.95)'));
      if (draft.length) drawCrack(draft, '#ffd24d');
    };

    canvas.onclick = (e) => {
      const r = canvas.getBoundingClientRect();
      // css 像素 → 画布像素 → 板面毫米
      const px = (e.clientX - r.left) * (canvas.width / r.width);
      const py = (e.clientY - r.top) * (canvas.height / r.height);
      draft.push({
        x: px / (canvas.width / slab.widthMm),
        y: py / (canvas.height / slab.heightMm)
      });
      redraw();
    };
    canvas.ondblclick = () => {
      if (draft.length >= 2) {
        slab.cracks.push(makeCrack(uid('crack'), draft.splice(0)));
        app.persist();
        app.toast('裂纹已保存，排版时会自动避让洞口', 'ok');
        redraw();
        renderStats();
        renderGrid(slab.id);
      }
    };
    (host.querySelector('#undo-pt') as HTMLElement).onclick = () => { draft.pop(); redraw(); };
    (host.querySelector('#finish-crack') as HTMLElement).onclick = () => {
      if (draft.length >= 2) {
        slab.cracks.push(makeCrack(uid('crack'), draft.splice(0)));
        app.persist(); redraw(); renderStats(); renderGrid(slab.id);
      }
    };
    (host.querySelector('#clear-cracks') as HTMLElement).onclick = () => {
      slab.cracks = []; app.persist(); redraw(); renderStats(); renderGrid(slab.id);
    };
    (host.querySelector('#delete-slab') as HTMLElement).onclick = () => {
      if (!confirm(`删除 ${slab.code}？`)) return;
      app.removeSlab(slab.id);
      app.render();
    };

    // 姿态预览
    const poseCanvas = host.querySelector<HTMLCanvasElement>('#pose-canvas')!;
    const pctx = poseCanvas.getContext('2d')!;
    let flip = 0;
    let rot90 = false;
    const drawPose = () => {
      const maxW = 260;
      const pw = rot90 ? img.height : img.width;
      const ph = rot90 ? img.width : img.height;
      const sc = Math.min(maxW / pw, 300 / ph);
      poseCanvas.width = pw * sc;
      poseCanvas.height = ph * sc;
      pctx.save();
      pctx.translate(poseCanvas.width / 2, poseCanvas.height / 2);
      pctx.scale(sc, sc);
      pctx.translate(-pw / 2, -ph / 2);
      pctx.save();
      if (rot90) {
        pctx.translate(img.height, 0);
        pctx.rotate(Math.PI / 2);
      }
      if (flip === 1) { pctx.translate(img.width, 0); pctx.scale(-1, 1); }
      if (flip === 2) { pctx.translate(img.width, img.height); pctx.scale(-1, -1); }
      if (flip === 3) { pctx.translate(0, img.height); pctx.scale(1, -1); }
      pctx.drawImage(img, 0, 0);
      pctx.restore();
      pctx.restore();
    };
    host.querySelectorAll<HTMLButtonElement>('.seg button').forEach((b) => {
      b.onclick = () => {
        host.querySelectorAll('.seg button').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        flip = Number(b.dataset.pose);
        drawPose();
      };
    });
    host.querySelector<HTMLInputElement>('#pose-rot')!.onchange = (e) => {
      rot90 = (e.target as HTMLInputElement).checked;
      drawPose();
    };
    // 防止 onload 早于监听
    if (img.complete) { redraw(); drawPose(); }
  };

  // 导入
  root.querySelector('#import-btn')!.addEventListener('click', async () => {
    const frontInput = root.querySelector<HTMLInputElement>('#front-files')!;
    const backInput = root.querySelector<HTMLInputElement>('#back-files')!;
    const files = Array.from(frontInput.files ?? []);
    if (files.length === 0) {
      app.toast('请先选择至少一张正面照片', 'error');
      return;
    }
    const w = Number(root.querySelector<HTMLInputElement>('#slab-w')!.value);
    const h = Number(root.querySelector<HTMLInputElement>('#slab-h')!.value);
    const blockId = (root.querySelector<HTMLInputElement>('#block-id')!.value || 'BLK-X').trim();
    const cutFrom0 = Number(root.querySelector<HTMLInputElement>('#cut-from')!.value) || 1;
    let nextCut = cutFrom0;
    const backMap = new Map<string, string>();
    for (const f of Array.from(backInput.files ?? [])) {
      backMap.set(f.name.replace(/\.[^.]+$/, ''), await readFileAsDataUrl(f));
    }
    for (const f of files) {
      const dataUrl = await readFileAsDataUrl(f);
      const size = await imageSize(dataUrl);
      const key = f.name.replace(/\.[^.]+$/, '');
      app.addSlab({
        id: uid('slab'),
        code: `${blockId}-${String(nextCut).padStart(2, '0')}`,
        blockId,
        cutIndex: nextCut++,
        widthMm: w,
        heightMm: h,
        imageW: size.w,
        imageH: size.h,
        frontDataUrl: dataUrl,
        backDataUrl: backMap.get(key),
        cracks: []
      });
    }
    app.toast(`已导入 ${files.length} 块板到荒料 ${blockId}`, 'ok');
    app.render();
  });

  renderStats();
  renderGrid();
  return () => { /* 纯 2D 视图，无外部资源 */ };
}
