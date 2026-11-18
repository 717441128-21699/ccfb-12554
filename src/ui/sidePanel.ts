import type { AppState } from '../state/store';
import type { Opening, OpeningType, Surface } from '../core/types';
import { makeOpening } from './app';
import { showToast } from './toast';

interface SideHandlers {
  onAddOpening: (o: Opening) => void;
  onRemoveOpening: (id: string) => void;
  onHighlightSeam: (key: string | undefined) => void;
  onUpdateSurface: (s: Surface) => void;
}

export function renderSidePanel(state: AppState, handlers: SideHandlers): void {
  const root = document.getElementById('side-panel')!;
  const surface = state.surfaces.find((s) => s.id === state.activeSurfaceId)!;
  const plan = state.plans[state.activeSurfaceId];
  const cut = state.cutPlans[state.activeSurfaceId];

  root.innerHTML = `
    ${renderSurfaceEditor(surface)}
    <div class="divider"></div>
    ${plan ? renderStats(plan) : '<div class="hint">尚未生成方案，点击「自动连纹排版」开始。</div>'}
    ${plan ? renderSeams(plan) : ''}
    ${renderOpenings(surface)}
    ${state.view === 'cuts' && cut ? renderCuts(cut) : ''}
  `;

  bindOpeningForm(surface, handlers);
  bindSurfaceSize(surface, handlers);
  bindSeamItems(handlers);
}

function renderSurfaceEditor(surface: Surface): string {
  return `
    <label class="field"><span>安装面名称</span>
      <input id="sf-name" value="${surface.name}" />
    </label>
    <div class="row">
      <label class="field"><span>宽 mm</span><input id="sf-w" type="number" value="${surface.width}" /></label>
      <label class="field"><span>高 mm</span><input id="sf-h" type="number" value="${surface.height}" /></label>
    </div>
    <div class="muted">类型：${typeLabel(surface.kind)}</div>
  `;
}

function bindSurfaceSize(surface: Surface, h: SideHandlers): void {
  const apply = () => {
    const name = (document.getElementById('sf-name') as HTMLInputElement).value;
    const w = Number((document.getElementById('sf-w') as HTMLInputElement).value);
    const hh = Number((document.getElementById('sf-h') as HTMLInputElement).value);
    if (w > 0 && hh > 0) h.onUpdateSurface({ ...surface, name, width: w, height: hh });
  };
  ['sf-name', 'sf-w', 'sf-h'].forEach((id) =>
    document.getElementById(id)!.addEventListener('change', apply),
  );
}

function renderStats(plan: AppState['plans'][string]): string {
  const s = plan.score;
  const utilPct = (s.utilization * 100).toFixed(1);
  const contPct = (s.continuity * 100).toFixed(0);
  return `
    <div class="stat-grid">
      <div class="stat"><div class="k">出材率</div><div class="val">${utilPct}%</div></div>
      <div class="stat"><div class="k">用板 / 剩余</div><div class="val">${s.slabCount} / ${plan.unusedSlabIds.length}</div></div>
      <div class="stat"><div class="k">接缝平均错位</div><div class="val ${s.avgSeamOffset <= 3 ? 'ok' : 'bad'}">${s.avgSeamOffset.toFixed(2)}<small>mm</small></div></div>
      <div class="stat"><div class="k">接缝最大错位</div><div class="val ${s.maxSeamOffset <= 3 ? 'ok' : 'bad'}">${s.maxSeamOffset.toFixed(2)}<small>mm</small></div></div>
      <div class="stat"><div class="k">纹路连续性</div><div class="val">${contPct}%</div></div>
      <div class="stat"><div class="k">弃料面积</div><div class="val">${(s.wasteArea / 1e6).toFixed(2)}<small>m²</small></div></div>
    </div>
    ${plan.violations.length > 0
      ? `<div class="hint" style="border-color:#e3b7b1;background:#fbe3e0;color:var(--danger);">
           开孔避让违规 ${plan.violations.length} 处：有裂纹进入开口安全区，请调整。
         </div>`
      : '<div class="hint" style="border-color:#bcd6c4;background:#e7f4eb;color:var(--ok);">所有裂纹均避开开口安全区 ✓</div>'}
  `;
}

function renderSeams(plan: AppState['plans'][string]): string {
  if (plan.seamReports.length === 0) return '';
  return `
    <div class="divider"></div>
    <div class="muted" style="margin-bottom:6px;">接缝对纹明细（点击在画布高亮）</div>
    ${plan.seamReports
      .map((sm, i) => {
        const key = `${sm.placements[0]}|${sm.placements[1]}`;
        return `
        <div class="seam-item ${sm.pass ? 'pass' : 'fail'}" data-seam="${key}">
          <div class="head">
            <span>${sm.axis === 'vertical' ? '竖缝' : '横缝'} #${i + 1} · ${sm.placements.join(' / ')}</span>
            <span class="tag ${sm.pass ? '' : 'crack'}">${sm.pass ? '合格' : '超差'}</span>
          </div>
          <div class="muted">平均 ${sm.avgOffset.toFixed(2)}mm · 最大 ${sm.maxOffset.toFixed(2)}mm · 角度差 ${(sm.avgAngleDelta * 180 / Math.PI).toFixed(1)}°</div>
        </div>`;
      })
      .join('')}
  `;
}

function renderOpenings(surface: Surface): string {
  const typeName: Record<OpeningType, string> = { door: '门洞', window: '窗洞', socket: '插座' };
  return `
    <div class="divider"></div>
    <div class="muted" style="margin-bottom:6px;">开口与避让（坐标相对安装面左上角）</div>
    ${surface.openings
      .map(
        (o) => `
      <div class="opening-item">
        <div class="head">
          <span>${typeName[o.type]} ${o.id.slice(-4)}</span>
          <button class="small danger" data-remove-op="${o.id}">删除</button>
        </div>
        <div>位置 (${o.x}, ${o.y}) · 尺寸 ${o.width}×${o.height} · 避让 ${o.margin}mm</div>
      </div>`,
      )
      .join('')}
    <div class="opts" style="margin-top:8px;border-top:1px dashed var(--line);padding-top:8px;">
      <div class="muted" style="margin-bottom:6px;">新增开口</div>
      <label class="field"><span>类型</span>
        <select id="op-type">
          <option value="socket">插座</option>
          <option value="window">窗洞</option>
          <option value="door">门洞</option>
        </select>
      </label>
      <div class="row">
        <label class="field"><span>X mm</span><input id="op-x" type="number" value="500" /></label>
        <label class="field"><span>Y mm</span><input id="op-y" type="number" value="500" /></label>
      </div>
      <div class="row">
        <label class="field"><span>宽 mm</span><input id="op-w" type="number" value="120" /></label>
        <label class="field"><span>高 mm</span><input id="op-h" type="number" value="120" /></label>
      </div>
      <button class="small" id="op-add" style="width:100%;">＋ 添加开口</button>
    </div>
  `;
}

function renderCuts(cut: AppState['cutPlans'][string]): string {
  if (!cut) return '';
  return `
    <div class="divider"></div>
    <div class="muted" style="margin-bottom:6px;">切割图 · 共 ${cut.steps.length} 刀 · 利用率 ${(cut.utilization * 100).toFixed(1)}%</div>
    ${cut.steps
      .map(
        (st) => `
      <div class="cut-step">
        <div><span class="order">第 ${st.order} 刀</span> · 板 ${st.slabId}（${st.placementId}）</div>
        <div class="muted">(${st.from.x.toFixed(0)}, ${st.from.y.toFixed(0)}) → (${st.to.x.toFixed(0)}, ${st.to.y.toFixed(0)}) mm · 弃料 ${(st.wasteArea / 1e6).toFixed(3)} m²</div>
      </div>`,
      )
      .join('')}
  `;
}

function bindOpeningForm(surface: Surface, h: SideHandlers): void {
  const addBtn = document.getElementById('op-add');
  if (!addBtn) return;
  addBtn.addEventListener('click', () => {
    const type = (document.getElementById('op-type') as HTMLSelectElement).value as OpeningType;
    const x = Number((document.getElementById('op-x') as HTMLInputElement).value);
    const y = Number((document.getElementById('op-y') as HTMLInputElement).value);
    const w = Number((document.getElementById('op-w') as HTMLInputElement).value);
    const hh = Number((document.getElementById('op-h') as HTMLInputElement).value);
    if ([x, y, w, hh].some((n) => Number.isNaN(n) || n < 0)) {
      showToast('开口参数不合法', 'warn');
      return;
    }
    if (x + w > surface.width || y + hh > surface.height) {
      showToast('开口超出安装面范围', 'warn');
      return;
    }
    h.onAddOpening(makeOpening(type, x, y, w, hh));
  });
  document.querySelectorAll<HTMLElement>('[data-remove-op]').forEach((el) =>
    el.addEventListener('click', () => h.onRemoveOpening(el.dataset.removeOp!)),
  );
}

function bindSeamItems(h: SideHandlers): void {
  document.querySelectorAll<HTMLElement>('[data-seam]').forEach((el) =>
    el.addEventListener('click', () => h.onHighlightSeam(el.dataset.seam)),
  );
}

function typeLabel(kind: Surface['kind']): string {
  return kind === 'wall' ? '墙面' : kind === 'floor' ? '地面' : '台面';
}
