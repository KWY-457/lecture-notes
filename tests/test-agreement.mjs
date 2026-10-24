// 用户协议 / 隐私政策：接口 + 首启弹窗 + 「以后再说」/「同意」两条路径。
//
// 为什么不并进 dom-app-test：这个要验的是「弹不弹」「点了之后写没写」，
// 属于跨请求的有状态行为，用真浏览器跑才靠得住（dom-app-test 的影子 DOM
// 没有真的 sessionStorage 语义）。
//
// 用法：
//   node tests/test-agreement.mjs                      # 用 data/runtime.json 里记的地址
//   node tests/test-agreement.mjs http://127.0.0.1:8931
//   node tests/test-agreement.mjs --headless           # 不弹浏览器窗口
//
// 注意：脚本会**真的点一次「我已阅读并同意」**，也就是会改写那台服务的
// data/config.json 里的 agreement 字段。如果你在测的是自己平时用的那份数据，
// 建议先起一个临时服务：
//   set LECTURE_DATA=D:\temp\agree-test
//   runtime\node.exe server.mjs --port 8931

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(__dirname);

const args = process.argv.slice(2);
const headless = !args.includes('--headed');
const APP = args.find((a) => /^https?:\/\//.test(a)) || defaultApp();

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' · ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' · ' + extra : ''}`); }
};

function defaultApp() {
  try {
    const rt = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'runtime.json'), 'utf8'));
    if (rt.port) return `http://127.0.0.1:${rt.port}/`;
  } catch {}
  return 'http://127.0.0.1:8788/';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  return [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    (process.env.LOCALAPPDATA || '') + '/Google/Chrome/Application/chrome.exe',
  ].find((p) => p && fs.existsSync(p));
}

/* ---------------- 1. 接口 ---------------- */
console.log('\n1) /api/agreement 接口');
const base = APP.replace(/\/+$/, '');
// 带入口钥匙的地址要保留路径前缀：http://ip:port/<secret>/
const apiUrl = (p) => new URL(p, APP).toString();

let r1;
try {
  const res = await fetch(apiUrl('api/agreement'), { signal: AbortSignal.timeout(5000) });
  r1 = await res.json();
} catch (e) {
  console.log(`  ✗ 取不到 /api/agreement：${e.message}`);
  console.log('  （服务没起来？先开一份，或用参数指定地址）');
  process.exit(1);
}
ok('接口可用', r1.ok === true);
ok('带协议版本号', typeof r1.version === 'string' && r1.version.length >= 8, `version=${r1.version}`);
ok('本机能看到协议全文', typeof r1.text?.license === 'string' && r1.text.license.length > 500);
ok('本机能看到隐私政策全文', typeof r1.text?.privacy === 'string' && r1.text.privacy.length > 500);
ok('正文里有「讲义笔记」', /\u8bb2\u4e49\u7b14\u8bb0/.test(r1.text.license));

/* ---------------- 2. 开启浏览器 ---------------- */
const CHROME = findChrome();
if (!CHROME) {
  console.log('\n  ⏭ 跳过浏览器部分：这台机器上没找到 Chrome / Edge');
  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
}

const CDP = 9321 + (process.pid % 200);
const profile = path.join(ROOT, '_scratch', `agree-${process.pid}`);
const chrome = spawn(
  CHROME,
  [
    ...(headless ? ['--headless=new'] : []),
    `--remote-debugging-port=${CDP}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--disable-gpu',
    '--window-size=1440,1000',
  ],
  { stdio: 'ignore' }
);

async function cdpTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const l = await fetch(`http://127.0.0.1:${CDP}/json/list`).then((r) => r.json());
      const p = l.find((t) => t.type === 'page');
      if (p) return p.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('浏览器没起来（CDP 连不上）');
}

async function conn(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let n = 0;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const q = pending.get(m.id);
      pending.delete(m.id);
      m.error ? q.rej(new Error(JSON.stringify(m.error))) : q.res(m.result);
    }
  };
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('CDP WebSocket 打不开'));
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++n;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: `(function(){const g=(i)=>document.getElementById(i);return (${expr});})()`,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) return { __exc: r.exceptionDetails.exception?.description };
    return r.result.value;
  };
  await send('Page.enable');
  await send('Runtime.enable');
  return { send, ev, close: () => ws.close() };
}

async function load(c) {
  await c.send('Page.navigate', { url: APP });
  for (let i = 0; i < 100; i++) {
    await sleep(250);
    if (await c.ev('!!window.__LN__')) break;
  }
  await sleep(1200);
  return c.ev(
    `({ accepted: window.__LN__.state.agreement?.accepted,
        at: window.__LN__.state.agreement?.acceptedAt,
        modalHidden: g('agree-modal') ? g('agree-modal').hidden : null })`
  );
}

try {
  const c1 = await conn(await cdpTarget());

  /* ---------------- 3. 首启 ---------------- */
  console.log('\n2) 首启弹窗');
  const wasAccepted = !!(await (await fetch(apiUrl('api/agreement'))).json()).accepted;
  let s = await load(c1);
  ok('页面起来了', await c1.ev('!!window.__LN__'));
  if (wasAccepted) {
    ok('已经同意过的不再弹', s.modalHidden === true);
  } else {
    ok('还没同意 → 首启弹出协议', s.modalHidden === false);

    console.log('\n3) 点「以后再说」');
    await c1.ev(`g('btn-agree-later').click()`);
    await sleep(700);
    s = await c1.ev(
      `({ hidden: g('agree-modal').hidden, accepted: window.__LN__.state.agreement?.accepted })`
    );
    ok('弹窗关掉了', s.hidden === true);
    ok('但没有写同意（没同意就是没同意）', s.accepted === false);
    const after = await (await fetch(apiUrl('api/agreement'))).json();
    ok('服务端也没记成已同意', after.accepted === false);

    s = await load(c1);
    ok('同一个标签页刷新不再打扰', s.modalHidden === true);

    // 新标签页 = 关掉再开。sessionStorage 是各标签页一份，应当再问。
    let c2 = null;
    try {
      const nt = await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json());
      if (nt?.webSocketDebuggerUrl) c2 = await conn(nt.webSocketDebuggerUrl);
    } catch {}
    if (c2) {
      s = await load(c2);
      ok('关掉再开（新标签页）会再问一次', s.modalHidden === false);
      c2.close();
    } else {
      console.log('  - 跳过新标签页检查（/json/new 不可用）');
    }

    console.log('\n4) 点「我已阅读并同意」');
    await c1.ev(`g('btn-agree-ok').click()`);
    await sleep(1200);
    s = await c1.ev(
      `({ hidden: g('agree-modal').hidden,
          accepted: window.__LN__.state.agreement?.accepted,
          at: window.__LN__.state.agreement?.acceptedAt })`
    );
    ok('弹窗关掉了', s.hidden === true);
    ok('前端状态变成已同意', s.accepted === true);
    ok('记下了同意时间', !!s.at, s.at || '');

    const saved = await (await fetch(apiUrl('api/agreement'))).json();
    ok('服务端落盘了', saved.accepted === true && !!saved.acceptedAt);
    ok('落盘的版本就是当前版本', saved.acceptedVersion === saved.version);

    s = await load(c1);
    ok('刷新后不再问', s.modalHidden === true);
  }

  /* ---------------- 5. 设置里的入口 ---------------- */
  console.log('\n5) 设置里的协议入口');
  await c1.ev(`g('btn-settings').click()`);
  await sleep(600);
  const links = await c1.ev(
    `({ lic: g('btn-show-license')?.textContent, pri: g('btn-show-privacy')?.textContent,
        ver: g('about-version')?.textContent, agree: g('about-agree')?.textContent })`
  );
  ok('有「用户协议」链接', links.lic === '用户协议');
  ok('有「隐私政策」链接', links.pri === '隐私政策');
  ok('看得到版本号', /0\.\d+\.\d+/.test(links.ver || ''), links.ver || '');
  if (wasAccepted === false) ok('看得到同意时间', /已于 .+ 同意/.test(links.agree || ''), links.agree || '');

  await c1.ev(`g('btn-show-license').click()`);
  await sleep(800);
  const rd = await c1.ev(
    `({ hidden: g('agree-modal').hidden, mode: g('agree-modal').dataset.mode,
        okBtn: g('btn-agree-ok').hidden, laterBtn: g('btn-agree-later').hidden,
        closeBtn: g('btn-agree-close').hidden,
        title: g('agree-title').textContent, text: (g('agree-text').textContent || '').slice(0, 40) })`
  );
  ok('阅读模式会打开弹窗', rd.hidden === false);
  ok('阅读模式是 read（不是还没表态的 ask）', rd.mode === 'read');
  ok('阅读模式没有「同意 / 以后再说」两个按钮', rd.okBtn === true && rd.laterBtn === true);
  ok('阅读模式有「知道了」', rd.closeBtn === false);
  ok('标题是用户协议', /用户协议/.test(rd.title));
  ok('正文真的渲染出来了', rd.text.length > 10, JSON.stringify(rd.text.slice(0, 24)));

  await c1.ev(`g('tab-privacy').click()`);
  await sleep(500);
  const pv = await c1.ev(`({ title: g('agree-title').textContent, text: (g('agree-text').textContent || '').slice(0, 60) })`);
  ok('能切到隐私政策', /隐私政策/.test(pv.title));
  ok('隐私政策有内容', pv.text.length > 10);

  // 阅读模式不能改状态
  const beforeRead = await (await fetch(apiUrl('api/agreement'))).json();
  await c1.ev(`g('btn-agree-close').click()`);
  await sleep(400);
  const afterRead = await (await fetch(apiUrl('api/agreement'))).json();
  ok('看一眼不会改变同意状态', beforeRead.accepted === afterRead.accepted);

  c1.close();
} finally {
  chrome.kill();
  await sleep(500);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
