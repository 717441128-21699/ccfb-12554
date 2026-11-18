let timer: number | undefined;
export function showToast(msg: string, kind: 'info' | 'error' | 'warn' = 'info'): void {
  const el = document.createElement('div');
  el.className = `toast ${kind === 'info' ? '' : kind}`;
  el.textContent = msg;
  document.body.appendChild(el);
  window.clearTimeout(timer);
  timer = window.setTimeout(() => el.remove(), 4200);
}
