/**
 * 打赏弹窗测试。
 *
 * 验的是「每次启动弹一次、勾了就不再弹」这套规则，以及收款码真的显示得出来。
 *
 * 为什么要自己起一个服务：要验「每次启动弹一次」就必须真的重启服务拿到新的
 * BOOT_ID。拿正式服务反复重启会搅乱用户数据，所以这里用 LECTURE_DATA 起一份
 * 隔离的临时服务，跑完整个目录删掉。
 *
 * 服务端「上次弹窗不到 2 分钟就不弹」是防启动器崩溃重启把用户连弹三遍的保护，
 * 属于故意设计。测的时候每轮之间直接把 config.json 里的 lastShownAt 抹掉，
 * 这是测试手段，不是产品逻辑。
 *
 * 用法：
 *   node tests/test-donate.mjs               （自动起临时服务，端口 8951）
 *   node tests/test-donate.mjs --port 8960   （换端口）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const NODE = path.join(ROOT, 'runtime', 'node.exe');
const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

function argVal(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const PORT = Number(argVal('port', 8951));
const CDP_PORT = Number(argVal('cdp', 9252));
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(ROOT, '_scratch', `donate-test-${PORT}`);
const PROFILE = path.join(ROOT, '_scratch', `donate-profile-${PORT}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
function check(name, ok, extra = '') {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? ' → ' + extra : ''}`);
}

const chromePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!chromePath) {
  console.log('⏭ 跳过：这台机器上找不到 Chrome 或 Edge');
  process.exit(0);
}

// ---------- 临时服务 ----------
let server = null;
async function startServer() {
  server = spawn(NODE, [path.join(ROOT, 'server.mjs'), '--port', String(PORT), '--host', '127.0.0.1'], {
    env: { ...process.env, LECTURE_DATA: DATA },
    stdio: 'ignore',
    windowsHide: true,
  });
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`).then((x) => x.json());
      if (r.ok) return r;
    } catch {}
    await sleep(250);
  }
  throw new Error('临时服务没起来（端口被占？换 --port 试试）');
}
async function stopServer() {
  if (!server) return;
  await fetch(`${BASE}/api/shutdown`, { method: 'POST' }).catch(() => {});
  await sleep(600);
  try {
    server.kill();
  } catch {}
  server = null;
  await sleep(400);
}
function readDonateCfg() {
  const f = path.join(DATA, 'config.json');
  if (!fs.existsSync(f)) return {};
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8')).donate || {};
  } catch {
    return {};
  }
}
/** 抹掉 lastShownAt，绕开「两分钟内不重复弹」的保护（测试手段）。 */
function clearLastShown() {
  const f = path.join(DATA, 'config.json');
  if (!fs.existsSync(f)) return;
  const c = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (c.donate) c.donate.lastShownAt = '';
  fs.writeFileSync(f, JSON.stringify(c, null, 2));
}
async function markAgreed() {
  await fetch(`${BASE}/api/agreement`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accepted: true }),
  });
}
/**
 * 把新手引导标成「已经走完」。
 *
 * 为什么必须这么做：引导是首次启动就盖在整页上的，而且它会 **return 掉后面的
 * 协议窗和打赏窗**（刚装完先读协议再被要钱，观感很差）。临时数据目录是全新的，
 * onboard.done 一定是 false → 打赏窗永远轮不到弹，这个测试的每一段都会红。
 * 打赏功能本身没问题，是测试环境缺一步「假装老用户」。
 */
async function markOnboarded() {
  await fetch(`${BASE}/api/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ onboard: { done: true } }),
  });
}

// ---------- 浏览器 ----------
let chrome = null;
let ws = null;
let msgId = 0;
const pending = new Map();

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());
      const page = list.find((t) => t.type === 'page');
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => {
          ws.onopen = res;
          ws.onerror = rej;
        });
        ws.onmessage = (ev) => {
          const m = JSON.parse(ev.data);
          if (m.id && pending.has(m.id)) {
            pending.get(m.id)(m);
            pending.delete(m.id);
          }
        };
        return;
      }
    } catch {}
    await sleep(250);
  }
  throw new Error('连不上浏览器调试端口');
}
function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((res) => {
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', {
    expression: `(function(){const g=(i)=>document.getElementById(i); return (${expr});})()`,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
}
async function goto(url) {
  await send('Page.navigate', { url });
  await sleep(1000);
  for (let i = 0; i < 60; i++) {
    if (await evaluate('!!(window.__LN__ && window.__LN__.state)')) return;
    await sleep(250);
  }
  throw new Error('页面没就绪（__LN__ 没挂上）');
}
async function forgetBoot() {
  await evaluate(`(() => { localStorage.removeItem('ln-boot-id'); return true; })()`);
}
/** 模拟「关掉程序再打开」：重启服务 + 抹掉上次弹窗时间 + 清掉前端的启动记忆。 */
async function restartAsNewLaunch() {
  await stopServer();
  clearLastShown();
  await startServer();
  await markAgreed();
  await markOnboarded();
  await forgetBoot();
  await goto(BASE);
  await sleep(700);
}

async function main() {
  console.log('\n【0】启动临时服务');
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(PROFILE, { recursive: true, force: true });
  await startServer();
  await markAgreed(); // 打赏只在协议同意后才自动弹
  await markOnboarded(); // 且引导走完之后才轮到打赏（引导会盖住它）
  check('临时服务就绪', true, BASE);

  chrome = spawn(
    chromePath,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--window-size=1440,1000',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );
  await connect();
  await send('Page.enable');
  await send('Runtime.enable');

  console.log('\n【1】启动自动弹 + 收款码显示');
  await goto(BASE);
  await sleep(600);
  const s1 = await evaluate(`({
    open: !g('donate-modal').hidden,
    mode: g('donate-modal').dataset.mode || '',
    never: g('donate-never').checked,
    imgs: [...g('donate-codes').querySelectorAll('img')].map(i => ({
      src: i.getAttribute('src'),
      w: Math.round(i.getBoundingClientRect().width),
      loaded: i.complete && i.naturalWidth > 0,
    })),
    headline: g('donate-modal').querySelector('h3').textContent.trim(),
  })`);
  check('启动就弹出来', s1.open === true);
  check('标记为自动弹出', s1.mode === 'auto');
  check('勾选框默认没勾', s1.never === false);
  check('两张收款码都在', s1.imgs.length === 2, s1.imgs.map((i) => i.src).join(', '));
  check('两张都真的加载出来了', s1.imgs.every((i) => i.loaded) === true);
  check('按 220px 显示（够扫）', s1.imgs.every((i) => i.w >= 200) === true, s1.imgs.map((i) => i.w + 'px').join(', '));
  check('标题是「请人家喝杯奶茶」', /奶茶/.test(s1.headline), s1.headline);

  console.log('\n【2】叉掉且不勾 → 重新启动还弹');
  check(
    '叉掉后关上',
    (await evaluate(`(() => { g('btn-donate-close').click(); return true; })()`)) === true &&
      (await sleep(300), (await evaluate(`g('donate-modal').hidden`)) === true)
  );
  await restartAsNewLaunch();
  check('重启后又弹出来了', (await evaluate(`!g('donate-modal').hidden`)) === true);
  check('服务端没记为「不再提示」', readDonateCfg().hideOnStartup !== true);

  console.log('\n【3】勾「以后不要再提示我」→ 永久不弹');
  await evaluate(
    `(() => { const c = g('donate-never'); c.checked = true; c.dispatchEvent(new Event('change')); return true; })()`
  );
  await sleep(800);
  check('服务端记下了', readDonateCfg().hideOnStartup === true);
  await evaluate(`(() => { g('btn-donate-close').click(); return true; })()`);
  await restartAsNewLaunch();
  check('重启后不弹了', (await evaluate(`g('donate-modal').hidden`)) === true);

  console.log('\n【4】设置里的入口在「退出服务」旁边且不需要滚动');
  await evaluate(`(() => { g('btn-settings').click(); return true; })()`);
  await sleep(500);
  const pos = await evaluate(`(() => {
    const d = g('btn-show-donate'), s = g('btn-shutdown');
    if (!d || !s) return { missing: true };
    const a = d.getBoundingClientRect(), b = s.getBoundingClientRect();
    return {
      sameRow: Math.abs(a.top - b.top) < 4,
      leftOfShutdown: a.left < b.left,
      visible: a.width > 0 && a.height > 0,
      inViewport: a.top >= 0 && a.bottom <= innerHeight,
    };
  })()`);
  check('和「退出服务」同一行', pos.sameRow === true, JSON.stringify(pos));
  check('在「退出服务」左边', pos.leftOfShutdown === true);
  check('真能看到（非零尺寸）', pos.visible === true);
  check('在视口内，不需要滚动', pos.inViewport === true);

  console.log('\n【5】手动打开时可以随时勾/取消');
  await evaluate(`(() => { g('btn-show-donate').click(); return true; })()`);
  await sleep(400);
  const manual = await evaluate(`({
    open: !g('donate-modal').hidden,
    mode: g('donate-modal').dataset.mode || '',
    checked: g('donate-never').checked,
    optVisible: g('donate-never').getBoundingClientRect().width > 0,
  })`);
  check('手动点也打开', manual.open === true);
  check('模式是 manual，不是 auto', manual.mode === 'manual', manual.mode);
  check('勾选框反映当前设置（之前勾过）', manual.checked === true);
  check('勾选框可见', manual.optVisible === true);

  console.log('\n【6】刷新页面不算新启动');
  await evaluate(
    `(() => { const c = g('donate-never'); c.checked = false; c.dispatchEvent(new Event('change')); g('btn-donate-close').click(); return true; })()`
  );
  await sleep(700);
  await forgetBoot();
  await goto(BASE);
  await sleep(700);
  check('新的这次启动弹了', (await evaluate(`!g('donate-modal').hidden`)) === true);
  await send('Page.reload', { ignoreCache: false });
  await sleep(2200);
  check('同一次启动里刷新不再弹', (await evaluate(`g('donate-modal').hidden`)) === true);

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
}

main()
  .catch((e) => {
    console.error('测试出错：', e);
    fail++;
  })
  .finally(async () => {
    try {
      ws?.close();
    } catch {}
    try {
      chrome?.kill();
    } catch {}
    await stopServer();
    await sleep(400);
    fs.rmSync(DATA, { recursive: true, force: true });
    fs.rmSync(PROFILE, { recursive: true, force: true });
    process.exit(fail === 0 ? 0 : 1);
  });
