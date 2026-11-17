// 浏览器端到端冒烟（CDP，无第三方依赖）：切页 → 求解 → 抓 KPI / 控制台错误 / 截图
const BASE = 'http://127.0.0.1:5173/';

async function cdpFetch(path, method = 'GET') {
  const r = await fetch(`http://127.0.0.1:9222${path}`, { method });
  if (!r.ok) throw new Error(`CDP ${path} -> ${r.status}`);
  return r.json();
}

const target = await cdpFetch(`/json/new?${encodeURIComponent(BASE)}`, 'PUT').catch(async () =>
  cdpFetch(`/json/new?${encodeURIComponent(BASE)}`)
);
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res) => (ws.onopen = res));

let msgId = 0;
const pending = new Map();
const events = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  } else if (m.method) {
    events.push(m);
  }
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const id = ++msgId;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });

await send('Runtime.enable');
await send('Page.enable');
await send('Log.enable');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) {
    console.error('页面异常:', JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text));
  }
  return r.result?.result?.value;
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '.tmp-check');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), Buffer.from(r.result.data, 'base64'));
  console.log('截图已保存:', path.join(dir, name));
};

await sleep(2500); // 等演示数据生成与首屏渲染

// 1. 板材库首屏
const slabCount = await evalJs(`document.querySelectorAll('.slab-card').length`);
console.log('板材卡片数:', slabCount);

// 2. 展开图页
await evalJs(`document.querySelector('[data-tab="surface"]').click()`);
await sleep(800);
const surfaceName = await evalJs(`document.querySelector('#sf-name')?.value`);
console.log('当前展开图:', surfaceName);
await shot('tab2-surface.png');

// 3. 排版页并求解
await evalJs(`document.querySelector('[data-tab="layout"]').click()`);
await sleep(800);
await evalJs(`document.querySelector('#solve-btn').click()`);
// 轮询等待 KPI 出现
for (let i = 0; i < 60; i++) {
  await sleep(250);
  const done = await evalJs(`!!document.querySelector('.kpi .v')`);
  if (done) break;
}
await sleep(500);
const summary = await evalJs(`JSON.stringify({
  kpis: [...document.querySelectorAll('.kpi')].map(k => k.innerText.replace(/\\n/g, ' ')),
  seamRows: document.querySelectorAll('.seam-row').length,
  warnRows: document.querySelectorAll('.warn-row').length,
  cutBlocks: document.querySelectorAll('.cut-row').length,
  solveInfo: document.querySelector('#solve-info')?.textContent,
  toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent)
})`);
console.log('排版结果:', summary);
await shot('tab3-layout.png');

// 4. 打开刀路图层再截一张
await evalJs(`document.querySelector('[data-layer="cuts"]').click()`);
await sleep(400);
await shot('tab3-cuts.png');

// 5. 书本对开模式
await evalJs(`document.querySelector('[data-mode="bookmatch"]').click()`);
await sleep(200);
await evalJs(`document.querySelector('#solve-btn').click()`);
for (let i = 0; i < 60; i++) {
  await sleep(250);
  const busy = await evalJs(`document.querySelector('#solve-btn').disabled`);
  if (!busy) break;
}
await sleep(400);
const bm = await evalJs(`JSON.stringify({
  kpis: [...document.querySelectorAll('.kpi')].map(k => k.innerText.replace(/\\n/g, ' ')).slice(0, 2),
  seamOk: document.querySelectorAll('.seam-row .dot.green').length,
  seamBad: document.querySelectorAll('.seam-row .dot.red').length
})`);
console.log('书本对开:', bm);
await shot('tab3-bookmatch.png');

// 控制台错误汇总
const errors = events
  .filter((e) => e.method === 'Runtime.exceptionThrown' || e.method === 'Log.entryAdded')
  .filter((e) => !e.params?.entry || e.params.entry.level === 'error')
  .map((e) => e.params?.exceptionDetails?.text ?? e.params?.entry?.text ?? JSON.stringify(e.params));
console.log('控制台错误数:', errors.length);
errors.forEach((m) => console.log(' -', m));

ws.close();
process.exit(errors.length ? 1 : 0);
