/**
 * 在真实浏览器里逐个测试 URL 能不能取到，并给出失败原因。
 * 用来回答「为什么浏览器下不了模型，但命令行 curl 可以」这类问题。
 *
 * 运行： node tests/net-check.mjs [originBase]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = (process.argv[2] || 'http://127.0.0.1:8788').replace(/\/+$/, '');
const CDP_PORT = Number(process.env.CDP_PORT || 9225);

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('找不到浏览器'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = path.join(__dirname, '_net_profile');
fs.rmSync(profile, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });

let version = null;
for (let i = 0; i < 60; i++) {
  try { version = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((r) => r.json()); break; }
  catch { await sleep(500); }
}
if (!version) { console.error('Chrome 起不来'); chrome.kill(); process.exit(2); }

const tab = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${ORIGIN}/selftest.html`, { method: 'PUT' }).then((r) => r.json());
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
let msgId = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined) {
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++msgId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' 超时')); } }, 90000);
});
const evalJs = async (expr, awaitPromise = true) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  return r.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
await sleep(2000);

const targets = [
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4/package.json',
  'https://hf-mirror.com/Xenova/whisper-tiny/resolve/main/config.json',
  'https://hf-mirror.com/api/models/Xenova/whisper-tiny',
  'https://huggingface.co/Xenova/whisper-tiny/resolve/main/config.json',
  'https://cdn.npmmirror.com/npm/@huggingface/transformers/4.3.0/files/package.json',
];

console.log(`\n=== 浏览器内网络诊断（页面来源 ${ORIGIN}）===\n`);
console.log(`  浏览器: ${version.Browser}\n`);

for (const url of targets) {
  const expr = `(async () => {
    const t0 = performance.now();
    try {
      const r = await fetch(${JSON.stringify(url)}, { method: 'GET' });
      const txt = await r.text();
      return JSON.stringify({ ok: r.ok, status: r.status, type: r.type,
        cors: r.headers.get('access-control-allow-origin'), len: txt.length,
        ms: Math.round(performance.now() - t0) });
    } catch (e) {
      return JSON.stringify({ err: e.name + ': ' + e.message, cause: String(e.cause || ''), ms: Math.round(performance.now() - t0) });
    }
  })()`;
  let out;
  try { out = await evalJs(expr); } catch (e) { out = JSON.stringify({ err: 'CDP: ' + e.message }); }
  const r = JSON.parse(out);
  const short = url.replace(/^https:\/\//, '');
  if (r.err) console.log(`  ❌ ${short}\n       ${r.err}${r.cause && r.cause !== 'undefined' ? '  ← ' + r.cause : ''}`);
  else console.log(`  ${r.ok ? '✅' : '⚠️ '} ${short}\n       HTTP ${r.status}  CORS=${r.cors || '(无)'}  ${r.len} 字节  ${r.ms}ms`);
}

ws.close();
chrome.kill();
await sleep(300);
fs.rmSync(profile, { recursive: true, force: true });
// chrome.kill() 在 Windows 上只杀父进程，子进程（渲染进程）还挂着 WebSocket，
// node 的事件循环就不会空，脚本明明跑完了却永远不退出。
// 显式退出，别让调用方（run-all / CI）以为卡死了。
process.exit(0);
