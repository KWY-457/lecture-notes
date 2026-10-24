/**
 * 在真实浏览器里验证「本地 Whisper 转写」这条链路。
 *
 * 这是之前唯一没能验证、而且真的出过 bug（remoteHost 少斜杠导致
 * Failed to fetch）的地方，所以单独做成一个可重复运行的检查。
 *
 * 运行： node tests/asr-check.mjs [appBase]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = (process.argv[2] || 'http://127.0.0.1:8788').replace(/\/+$/, '');
const CDP_PORT = Number(process.env.CDP_PORT || 9224);

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));
if (!CHROME) {
  console.error('找不到 Chrome / Edge');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = path.join(__dirname, '_asr_profile');
fs.rmSync(profile, { recursive: true, force: true });

const chrome = spawn(
  CHROME,
  [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, 'about:blank',
  ],
  { stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } }
);

let version = null;
for (let i = 0; i < 60; i++) {
  try {
    version = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((r) => r.json());
    break;
  } catch { await sleep(500); }
}
if (!version) { console.error('Chrome 起不来'); chrome.kill(); process.exit(2); }
console.log(`\n=== 本地转写链路自检 ===\n浏览器: ${version.Browser}`);

const tab = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json());
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });

let msgId = 0;
const pending = new Map();
const consoleErrors = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined) {
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  } else if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push('异常: ' + (m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text));
  } else if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
    consoleErrors.push('console.error: ' + (m.params.args || []).map((a) => a.value ?? a.description).join(' '));
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' 超时')); } }, 60000);
  });
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  return r.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
const query = process.argv[3] || '';
await send('Page.navigate', { url: `${APP}/asr-selftest.html${query ? '?' + query : ''}` });

const DEADLINE = Date.now() + 7 * 60 * 1000;
let title = '';
while (Date.now() < DEADLINE) {
  await sleep(3000);
  title = (await evalJs('document.title')) || '';
  const summary = (await evalJs("(document.getElementById('summary')||{}).textContent")) || '';
  process.stdout.write(`\r  ${summary.slice(0, 110).padEnd(112)}`);
  if (/ASR-SELFTEST-(OK|FAIL)/.test(title)) break;
}
process.stdout.write('\n\n');

const log = (await evalJs("(document.getElementById('log')||{}).innerText")) || '';
const ok = title === 'ASR-SELFTEST-OK';

console.log('  --- 自检页日志（完整）---');
for (const line of log.split('\n')) if (line.trim()) console.log('  ' + line.trim());

console.log('\n  --- 判定 ---');
console.log(`  ${ok ? '✅ 通过' : '❌ 失败'}：本地 Whisper 转写链路`);
const bad = /Failed to fetch/i.test(log);
if (bad) console.log('  ⚠ 日志里仍有 Failed to fetch');
if (consoleErrors.length) {
  console.log('  页面上报的异常：');
  consoleErrors.slice(0, 5).forEach((e) => console.log('    ' + e.slice(0, 200)));
}

ws.close();
chrome.kill();
await sleep(300);
fs.rmSync(profile, { recursive: true, force: true });
process.exitCode = ok ? 0 : 1;
