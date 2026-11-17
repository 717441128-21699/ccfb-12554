// 极简 DOM 构造辅助,避免引入框架。
type Props<K extends keyof HTMLElementTagNameMap> = Partial<Omit<HTMLElementTagNameMap[K], 'style' | 'dataset'>> & {
  class?: string;
  style?: string;
  dataset?: Record<string, string>;
};

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props<K> = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = String(v);
    else if (k === 'style') el.setAttribute('style', String(v));
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else (el as unknown as Record<string, unknown>)[k] = v;
  }
  for (const c of children) {
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export function numberField(label: string, value: number, step: number, min: number, max: number,
  onChange: (v: number) => void): HTMLLabelElement {
  const wrap = h('label', { class: 'field' }, h('span', {}, label));
  const input = h('input', { type: 'number', step: String(step), min: String(min), max: String(max), value: String(value) });
  input.addEventListener('change', () => {
    const v = parseFloat(input.value);
    if (Number.isFinite(v)) onChange(v);
  });
  wrap.append(input);
  return wrap;
}

let toastTimer: number | undefined;
export function toast(msg: string, isError = false): void {
  document.querySelectorAll('.toast').forEach((n) => n.remove());
  const el = h('div', { class: `toast${isError ? ' err' : ''}` }, msg);
  document.body.append(el);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.remove(), 3200);
}
