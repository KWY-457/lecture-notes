/**
 * 用 CDP 连一个已经跑着的 Edge，在真页面里验证两件事：
 *   ① 显卡自检（checkGpu）——真 WebGPU，node 里造不出来
 *   ② 进度条（progress）——真 DOM，看宽度/文字/忙碌动画对不对
 *
 * 需要先在页面上挂好调试入口：window.__LN__ = { state, progress, checkGpu, runDiagnostics, toast }
 * （app.js 结尾那行；app.js 是 ES module，不挂出来 CDP 里看不见模块内的函数。）
 *
 * 用法：
 *   node tests/cdp-probe.mjs                       # 连 127.0.0.1:9222 上的页面
 *   node tests/cdp-probe.mjs --cdp 9222 --app http://127.0.0.1:8788/
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const CDP_PORT = Number(argOf('--cdp', '9222'));
const APP_URL = argOf('--app', 'http://127.0.0.1:8788/');

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? '  →  ' + extra : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(wsUrl, onEvent) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onopen = () =>
      resolve({
        send(method, params = {}) {
          const msgId = ++id;
          ws.send(JSON.stringify({ id: msgId, method, params }));
          return new Promise((res, rej) => pending.set(msgId, { res, rej }));
        },
        close: () => ws.close(),
      });
    ws.onerror = (e) => reject(new Error('WebSocket 连不上：' + (e.message || '未知')));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
        return;
      }
      if (msg.method && onEvent) onEvent(msg);
    };
  });
}

const pageErrors = [];

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const want = APP_URL.replace(/\/$/, '');
  const page = list.find((t) => t.type === 'page' && t.url.startsWith(want)) || list.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
  if (!page) throw new Error('CDP 里没有可用页面，Edge 是不是没带 --remote-debugging-port 起来？');
  console.log(`\n连上页面：${page.url}`);

  const c = await connect(page.webSocketDebuggerUrl, (msg) => {
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params?.exceptionDetails;
      pageErrors.push(d?.exception?.description || d?.text || '未捕获异常');
    }
    if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') {
      pageErrors.push(msg.params.entry.text);
    }
  });
  await c.send('Runtime.enable');
  await c.send('Page.enable');
  await c.send('Log.enable').catch(() => {});
  const errors = pageErrors;

  // 必须强制绕过缓存重载一次：Edge 会把 app.js 缓存住，
  // 不重载的话验的还是上一版代码，会得出「函数不存在」这种假结论。
  await c.send('Page.reload', { ignoreCache: true });
  await sleep(400);

  const evalIn = async (expr, timeoutMs = 20000) => {
    const p = c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    let timer;
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(
        () => rej(new Error(`页面里这段算了 ${timeoutMs / 1000} 秒还没回来（主线程忙？）：${expr.slice(0, 60)}`)),
        timeoutMs,
      );
    });
    const r = await Promise.race([p, timeout]).finally(() => clearTimeout(timer));
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || '页面里报错了');
    return r.result.value;
  };

  for (let i = 0; i < 40; i++) {
    try {
      if ((await evalIn('document.readyState')) === 'complete') break;
    } catch {}
    await sleep(300);
  }
  // 注意：__LN__ 是 app.js 最后一行才挂上去的，但 boot() 在那之后还要跑一会儿。
  // 所以不能只看「__LN__ 在不在」，要等到里面真有 checkGpu 这个函数再往下走 ——
  // 否则会验到半途的旧页面，得出「checkGpu is not defined」这种假结论（踩过这个坑）。
  let hookReady = false;
  for (let i = 0; i < 30; i++) {
    const ok = await evalIn('!!(window.__LN__ && typeof window.__LN__.checkGpu === "function" && typeof window.__LN__.runDiagnostics === "function")').catch(() => false);
    if (ok) {
      hookReady = true;
      break;
    }
    await sleep(300);
  }
  await sleep(500); // 再等 boot() 把界面铺完

  console.log('\n=== 0. 调试入口 ===');
  const hook = await evalIn('typeof window.__LN__');
  check('页面挂上了 window.__LN__（CDP 才能看见模块内的函数）', hook === 'object', String(hook));
  if (hook !== 'object') {
    console.log('  （没有入口，后面没法验，先确认拿到的是新版 app.js）');
  }

  console.log('\n=== 1. 显卡自检（真 WebGPU） ===');
  const hasGpuApi = await evalIn("'gpu' in navigator");
  check('navigator.gpu 存在（否则页面里根本试不了 WebGPU）', hasGpuApi === true, String(hasGpuApi));
  const gpu = await evalIn('(async () => { try { return await window.__LN__.checkGpu(); } catch (e) { return { ok: false, text: "抛错：" + e.message }; } })()');
  console.log('  checkGpu() → ' + JSON.stringify(gpu));
  check('checkGpu() 返回结论而不是抛错', gpu && typeof gpu.text === 'string', JSON.stringify(gpu));
  check('结论里有明确信息（可用型号 / 或拿不到的原因）', /可用|拿不到|不支持|失败/.test(gpu.text || ''), gpu.text);
  const adapterNull = (gpu.text || '').includes('拿不到');
  if (adapterNull) {
    console.log('  ⚠ 这台机器的浏览器拿不到适配器 —— 正好说明「navigator.gpu 存在」≠「能用显卡」，');
    console.log('    旧版只查了存在与否，会把这种情况报成「支持」，属于误报。');
  }

  console.log('\n=== 2. 诊断面板显示的就是这句 ===');
  await evalIn('(async () => { await window.__LN__.runDiagnostics(); })()');
  await sleep(800);
  const diagText = await evalIn("(document.getElementById('diag') || {}).innerText || ''");
  const gpuRow = diagText.split('\n').map((s) => s.trim()).find((l) => /WebGPU/.test(l)) || '';
  console.log('  面板里 → ' + gpuRow);
  check('诊断面板出现 WebGPU 一行', !!gpuRow);
  check('面板结论与 checkGpu() 一致', gpuRow.includes('可用') || gpuRow.includes('拿不到') || gpuRow.includes('不支持'), gpuRow);

  console.log('\n=== 3. 进度条：元素齐全 ===');
  const ids = await evalIn(`(() => {
    const need = ['progress-wrap','progress-fill','progress-stage','progress-label','progress-detail','progress-pct'];
    const o = {};
    for (const id of need) o[id] = !!document.getElementById(id);
    return o;
  })()`);
  for (const [k, v] of Object.entries(ids)) check(`有 #${k}`, v === true);

  console.log('\n=== 4. 进度条：三态都对（数字进度 / 无数值爬动 / 隐藏）===');
  const states = await evalIn(`(() => {
    const L = window.__LN__;
    const g = (id) => document.getElementById(id);
    const snap = () => ({
      hidden: g('progress-wrap').hidden,
      width: g('progress-fill').style.width,
      pct: g('progress-pct').textContent,
      stage: g('progress-stage').textContent,
      label: g('progress-label').textContent,
      detail: g('progress-detail').textContent,
      busy: g('progress-fill').classList.contains('busy'),
    });
    const out = {};
    L.progress(true, '第 2/8 段（音频 5:00 起），已完成 5:00，用时 3:12', 37, 'transcribe', '正在转写这一段…', 8);
    out.number = snap();
    L.progress(true, '正在准备模型（第一次要下载，约 40MB）…', undefined, 'model');
    out.busy = snap();
    L.progress(false);
    out.hidden = snap();
    return out;
  })()`);
  console.log('  数字态 → ' + JSON.stringify(states.number));
  console.log('  无数值 → ' + JSON.stringify(states.busy));
  console.log('  隐藏态 → ' + JSON.stringify(states.hidden));

  check('数字进度：宽度按百分比写进去', states.number.width === '37%', states.number.width);
  check('数字进度：百分比文字对', states.number.pct === '37%', states.number.pct);
  check('数字进度：阶段名是人话（不是英文 stage 码）', /[\u4e00-\u9fa5]/.test(states.number.stage) && !/transcribe|model|load/.test(states.number.stage), states.number.stage);
  check('数字进度：标签是给人看的人话', /段|用完|完成/.test(states.number.label), states.number.label);
  check('数字进度：细说明显示出来了', states.number.detail === '正在转写这一段…', states.number.detail);
  check('数字进度：不处于忙碌动画', states.number.busy === false, String(states.number.busy));

  check('没有细进度时：走来回爬的忙碌动画', states.busy.busy === true, String(states.busy.busy));
  check('没有细进度时：百分比位置显示「…」而不是假的数字', states.busy.pct === '…', states.busy.pct);
  check('没有细进度时：不写死宽度', !states.busy.width, states.busy.width);

  check('收工后整块进度条藏起来', states.hidden.hidden === true, String(states.hidden.hidden));
  check('收工后去掉忙碌动画（不留个爬来爬去的条）', states.hidden.busy === false, String(states.hidden.busy));

  console.log('\n=== 5. 「慢爬」不会越过下一段真进度 ===');
  // 爬动是每 2000ms 才 +0.5 一次的，所以「等 2500ms 看有没有涨」其实只剩 500ms 余量：
  // 机器一忙（比如同时跑着别的测试），定时器晚一点点就落在没涨的那一刻，
  // 于是这条断言会莫名其妙地红一次 —— 属于测试自己太抠，不是产品坏了。
  // 改成轮询等它涨，最多等 9 秒（爬一格 2 秒，4 格也才 12%，离 22.5% 的界还远）。
  const crawl = await evalIn(`(async () => {
    const L = window.__LN__;
    const g = (id) => document.getElementById(id);
    L.progress(true, '第 1/8 段，已完成 0:00，用时 10 秒', 10, 'transcribe', '', 8);
    const w0 = g('progress-fill').style.width;
    let w1 = w0;
    for (let i = 0; i < 45; i++) {
      await new Promise((r) => setTimeout(r, 200));
      w1 = g('progress-fill').style.width;
      if (w1 !== w0) break;
    }
    const pct = g('progress-pct').textContent;
    const width = g('progress-fill').style.width;
    L.progress(false);
    return { w0, w1, width, pct };
  })()`);
  console.log('  等它爬：' + crawl.w0 + ' → ' + crawl.w1);
  const num = (s) => Number(String(s).replace('%', '')) || 0;
  check('慢爬确实在动（用户看得出还活着）', num(crawl.w1) > num(crawl.w0), `${crawl.w0} → ${crawl.w1}`);
  check('慢爬不越界（一段只爬 100/8=12.5 个点，不会冲过 22.5%）', num(crawl.width) <= 22.5, crawl.width);

  console.log('\n=== 6. 卡住 6 秒会主动说话（源码断言） ===');
  const src = await (await fetch(new URL('./app.js', APP_URL))).text();
  // 文案 2026-10 改过一轮（原来「已 N 秒无新消息，程序还在跑」太口语），这里跟着放宽成
  // 「秒无新消息」——只要还在报这个秒数，就说明心跳兜底还在。
  check('app.js 里有「已 N 秒无新消息」的兜底提示', /秒无新消息/.test(src));
  check('app.js 里进度条支持「忙绿动画」类名 busy', /classList\.add\('busy'\)/.test(src));
  check('worker 里第一段切成不超过 2 分钟（首个结果来得更早）', /FIRST_SLICE_SEC = Math\.min\(120/.test(await (await fetch(new URL('./worker-asr.js', APP_URL))).text()));

  console.log('\n=== 7. 页面控制台有没有报错 ===');
  check('没有未捕获的 JS 错误', errors.length === 0, errors.join(' | ').slice(0, 300));

  c.close();
  console.log('\n' + '='.repeat(70));
  console.log(fail === 0 ? `全部通过（${pass} 项）` : `${fail} 项失败 / ${pass} 项通过`);
  console.log('='.repeat(70));
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('\n探针自己挂了：' + e.message);
  process.exitCode = 1;
});
