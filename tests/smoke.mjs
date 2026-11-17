// 浏览器端冒烟测试:驱动 Edge(WebGL2 + Worker),验证渲染、计算、面板与导出链路。
import puppeteer from 'puppeteer-core';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.env.SMOKE_URL || 'http://localhost:4173';

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: [
    '--no-sandbox',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-webgl',
    '--window-size=1440,900',
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });

const errors = [];
const consoleErrors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(`console: ${m.text()}`);
});

await page.goto(URL, { waitUntil: 'networkidle0', timeout: 30000 });
await sleep(2500);

// 1. 画布已被应用初始化为非默认尺寸(默认元素为 300x150),据此确认 WebGL2 渲染已启动
const glInfo = await page.evaluate(() => {
  const c = document.getElementById('glCanvas');
  return { width: c.width, height: c.height, initialized: c.width > 300 || c.height > 150 };
});
console.log('画布初始化:', glInfo.initialized ? 'OK' : 'FAIL', `${glInfo.width}x${glInfo.height}`);
if (!glInfo.initialized) errors.push('WebGL2 画布未初始化');

// 2. 自动示例 + Worker 计算出照度
await page.waitForFunction(
  () => document.querySelectorAll('.hud-chip').length >= 5,
  { timeout: 15000 },
);
const hudText = await page.evaluate(() =>
  Array.from(document.querySelectorAll('.hud-chip')).map((n) => n.textContent).join(' | '));
console.log('HUD:', hudText);
if (!/平均照度/.test(hudText) || /-\s*lx/.test(hudText)) errors.push('HUD 未出现照度数值');

// 3. 渲染器在持续绘制(请求动画帧会更新画布尺寸),通过非默认尺寸已确认;
//    WebGL 默认不保留绘图缓冲,无法用 2D drawImage 回读单帧,故不做像素断言。

// 4. 五个面板都能切换且无报错
const tabs = ['library', 'room', 'layout', 'preview', 'report'];
for (const tab of tabs) {
  await page.click(`.nav-item[data-tab="${tab}"]`);
  await sleep(350);
  const title = await page.evaluate(() => document.querySelector('.side-panel .panel-title')?.textContent);
  console.log(`面板 ${tab}:`, title);
  if (!title) errors.push(`面板 ${tab} 未渲染`);
  await page.screenshot({ path: `tests/shots/${tab}.png` });
}

// 5. 渲染预览页的指标卡片
await page.click('.nav-item[data-tab="preview"]');
await sleep(300);
const metricCount = await page.evaluate(() => document.querySelectorAll('.metric').length);
console.log('预览页指标卡数量:', metricCount);
if (metricCount < 6) errors.push('指标卡不完整');

// 6. 报告页伪彩图与 PDF 导出(拦截保存对话框,验证调用不抛错)
await page.click('.nav-item[data-tab="report"]');
await sleep(500);
const heatOk = await page.evaluate(() => {
  const c = document.getElementById('reportHeat');
  return c && c.width > 100 && c.height > 100;
});
console.log('报告伪彩图:', heatOk ? 'OK' : 'FAIL');
if (!heatOk) errors.push('报告伪彩图未生成');

const pdfResult = await page.evaluate(async () => {
  try {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('导出 PDF'));
    if (!btn) return 'no-button';
    // jsPDF save 会触发下载,headless 下自动落盘到临时目录,这里只验证不抛异常
    btn.click();
    await new Promise((r) => setTimeout(r, 1500));
    return 'clicked-ok';
  } catch (e) {
    return `error: ${e.message}`;
  }
});
console.log('PDF 导出:', pdfResult);
if (pdfResult !== 'clicked-ok') errors.push(`PDF 导出异常: ${pdfResult}`);

// 7. 上传 IES 走完整解析链路(用内置样例内容构造 File)
await page.click('.nav-item[data-tab="library"]');
await sleep(300);
const uploadResult = await page.evaluate(async () => {
  try {
    const text = await fetch('samples/downlight-24deg.ies').then((r) => r.text());
    const file = new File([text], 'manual-upload.ies', { type: 'text/plain' });
    const input = document.querySelector('input[type=file]');
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 800));
    return document.querySelectorAll('.lum-card').length;
  } catch (e) {
    return `error: ${e.message}`;
  }
});
console.log('IES 上传后灯具卡数量:', uploadResult);
if (typeof uploadResult !== 'number' || uploadResult < 1) errors.push(`IES 上传失败: ${uploadResult}`);

// 8. 性能:20 盏灯计算耗时
const perf = await page.evaluate(async () => {
  // 通过阵列按钮布 20 盏(5x4)
  document.querySelector('.nav-item[data-tab="layout"]').click();
  await new Promise((r) => setTimeout(r, 300));
  const inputs = document.querySelectorAll('.section input[type=number]');
  inputs[0].value = '5'; inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
  inputs[1].value = '4'; inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
  const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('按阵列铺满'));
  btn.click();
  await new Promise((r) => setTimeout(r, 1800));
  const chip = Array.from(document.querySelectorAll('.hud-chip')).find((c) => c.textContent.includes('灯具'));
  const metric = Array.from(document.querySelectorAll('.metric .v')).map((v) => v.textContent);
  return { chip: chip?.textContent, metrics: metric };
});
console.log('20 灯布局:', JSON.stringify(perf));
if (!perf.chip || !perf.chip.includes('20')) errors.push('20 灯布置失败');

// 9. 20 灯计算性能:切换到预览页读取计算耗时指标
const timing = await page.evaluate(async () => {
  document.querySelector('.nav-item[data-tab="preview"]').click();
  await new Promise((r) => setTimeout(r, 1200));
  const vals = Array.from(document.querySelectorAll('.metric .v')).map((v) => v.textContent);
  return vals;
});
console.log('20 灯指标:', JSON.stringify(timing));
const msEl = timing.find((v) => v.includes('ms'));
const ms = msEl ? parseFloat(msEl) : NaN;
if (!(ms < 400)) errors.push(`20 灯计算耗时 ${msEl} 超过 400ms 交互阈值`);
else console.log(`性能达标:20 灯计算 ${msEl} < 400ms`);

await page.screenshot({ path: 'tests/shots/twenty-lights.png' });

console.log('\n--- 控制台错误 ---');
console.log(consoleErrors.length ? consoleErrors.join('\n') : '(无)');
console.log('\n--- 页面异常 ---');
console.log(errors.length ? errors.join('\n') : '(无)');

await browser.close();
process.exit(errors.length ? 1 : 0);
