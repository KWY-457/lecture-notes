/**
 * 更新公告弹窗测试。
 *
 * 验的是「只在更新后弹一次」这套规则：
 *   - 新装：seenVersion 初始化成当前版本 → 不打扰
 *   - 老用户升级：seenVersion 是旧版 / 空 → 弹一次，展示 CHANGELOG.md
 *   - 点「知道了」写回当前版本 → 刷新、重启都不再弹
 *   - 设置里的手动入口随时能看，且不会改「已读」记忆
 *
 * 为什么要自己起一个临时服务：要验「升级态」必须改 config 再重启，
 * 拿正式服务折腾会搅乱老大的真实配置，所以这里用 LECTURE_DATA 起一份
 * 隔离的临时数据目录，跑完整个删掉。
 *
 * 用法：
 *   node tests/test-whatsnew.mjs               （自动起临时服务）
 *   node tests/test-whatsnew.mjs --port 8961   （换端口）
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
const PORT = Number(argVal('port', 8961));
const CDP_PORT = Number(argVal('cdp', 9257));
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(ROOT, '_scratch', `whatsnew-test-${PORT}`);
const PROFILE = path.join(ROOT, '_scratch', `whatsnew-profile-${PORT}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
function check(name, ok, extra = '') {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? ' → ' + extra : ''}`);
}

const chromePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));

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
  try { server.kill(); } catch {}
  server = null;
  await sleep(400);
}
function cfg() {
  const f = path.join(DATA, 'config.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
}
function setSeen(val) {
  const f = path.join(DATA, 'config.json');
  const c = JSON.parse(fs.readFileSync(f, 'utf8'));
  c.whatsNew = { seenVersion: val };
  fs.writeFileSync(f, JSON.stringify(c, null, 2));
}
async function getState() {
  return await fetch(`${BASE}/api/whats-new`).then((r) => r.json());
}
async function markAgreed() {
  await fetch(`${BASE}/api/agreement`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accepted: true }),
  });
}
async function markOnboarded() {
  await fetch(`${BASE}/api/config`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ onboard: { done: true } }),
  });
}
/** 模拟「关程序再开，而且这次是升级」：改 seenVersion + 重启 + 清前端记忆。 */
async function restartAsUpgrade(seen) {
  await stopServer();
  setSeen(seen);
  await startServer();
  await markAgreed();
  await markOnboarded();
  await goto(BASE);
  await sleep(700);
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
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        ws.onmessage = (ev) => {
          const m = JSON.parse(ev.data);
          if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
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
  return new Promise((res) => { pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
}
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', {
    expression: `(function(){const g=(i)=>document.getElementById(i); return (${expr});})()`,
    returnByValue: true, awaitPromise: true, userGesture: true,
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

async function main() {
  if (!chromePath) {
    console.log('⏭ 跳过：这台机器上找不到 Chrome 或 Edge');
    return;
  }
  console.log('\n【0】启动临时服务（新装）');
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const health = await startServer();
  check('临时服务就绪', true, BASE);

  console.log('\n【1】新装：seenVersion 初始化成当前版本，不弹');
  const initCfg = cfg();
  check('新装自动写入 seenVersion', initCfg.whatsNew?.seenVersion === health.version, String(initCfg.whatsNew?.seenVersion));
  const s1 = await getState();
  check('新装 show=false', s1.show === false);
  check('GET 带回正文', (s1.markdown || '').includes('更新记录') && s1.markdown.length > 100, s1.markdown.length + ' 字');
  await markAgreed();
  await markOnboarded();

  chrome = spawn(chromePath, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1440,1000', 'about:blank',
  ], { stdio: 'ignore' });
  await connect();
  await send('Page.enable');
  await send('Runtime.enable');

  await goto(BASE);
  await sleep(600);
  const dom1 = await evaluate(`({
    open: !g('whatsnew-modal').hidden,
    hasBtn: !!g('btn-show-changelog'),
    foot: (g('whatsnew-modal').querySelector('.modal-foot')?.textContent || '').includes('设置'),
  })`);
  check('新装页面不弹公告', dom1.open === false);
  check('设置里手动入口按钮在', dom1.hasBtn === true);
  check('弹窗脚注指向设置入口', dom1.foot === true);

  console.log('\n【2】模拟升级：seenVersion 是旧版 → 弹一次');
  await restartAsUpgrade('0.8.0');
  const s2 = await getState();
  check('升级态 show=true', s2.show === true);
  const dom2 = await evaluate(`({
    open: !g('whatsnew-modal').hidden,
    mode: g('whatsnew-modal').dataset.mode || '',
    ver: g('whatsnew-version').textContent.trim(),
    body: g('whatsnew-body').textContent,
    h1: !!g('whatsnew-body').querySelector('h1,h2'),
    li: g('whatsnew-body').querySelectorAll('li').length,
  })`);
  check('升级后自动弹出', dom2.open === true);
  check('标记为自动弹出', dom2.mode === 'auto');
  check('标题带版本号', dom2.ver.includes('0.9.0'), dom2.ver);
  check('正文渲染成标题+列表', dom2.h1 === true && dom2.li >= 5, dom2.li + ' 条');
  check('正文含本次改动', dom2.body.includes('重新润色') && dom2.body.includes('常见问题'), dom2.body.slice(0, 40));

  console.log('\n【3】点「知道了」写回 → 刷新不再弹');
  await evaluate(`(g('btn-whatsnew-ok').click(), true)`);
  await sleep(600);
  const s3 = await getState();
  check('POST 后 show=false', s3.show === false);
  check('seenVersion 写回当前版', s3.seenVersion === health.version, s3.seenVersion);
  check('config 落盘', cfg().whatsNew?.seenVersion === health.version);
  const closed = await evaluate(`g('whatsnew-modal').hidden`);
  check('点完窗口关掉', closed === true);
  await send('Page.reload', { ignoreCache: false });
  await sleep(2200);
  check('刷新后不再弹', (await evaluate(`g('whatsnew-modal').hidden`)) === true);

  console.log('\n【4】设置里的手动入口：随时能看，但不改已读记忆');
  const beforeManual = cfg().whatsNew?.seenVersion;
  await evaluate(`(g('btn-show-changelog').click(), true)`);
  await sleep(500);
  const dom4 = await evaluate(`({
    open: !g('whatsnew-modal').hidden,
    mode: g('whatsnew-modal').dataset.mode || '',
  })`);
  check('手动入口能打开', dom4.open === true);
  check('标记为手动打开', dom4.mode === 'manual');
  check('手动看不改 seenVersion', cfg().whatsNew?.seenVersion === beforeManual);
  await evaluate(`(g('btn-whatsnew-close').click(), true)`);
  await sleep(300);
  check('关闭按钮生效', (await evaluate(`g('whatsnew-modal').hidden`)) === true);

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
}

main()
  .catch((e) => { console.error('测试出错：', e); fail++; })
  .finally(async () => {
    try { ws?.close(); } catch {}
    try { chrome?.kill(); } catch {}
    await stopServer();
    await sleep(400);
    fs.rmSync(DATA, { recursive: true, force: true });
    fs.rmSync(PROFILE, { recursive: true, force: true });
    process.exit(fail === 0 ? 0 : 1);
  });
