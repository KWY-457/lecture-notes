/**
 * 测量录音的实际电平，判断「是不是音频太轻导致 Whisper 幻觉」。
 * 在真实浏览器里用与转写完全相同的解码路径跑。
 *
 * 运行：
 *   node tests/audio-level-check.mjs <lectureId>                        # 服务在 8788
 *   node tests/audio-level-check.mjs <lectureId> http://127.0.0.1:25994
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 第一个位置参数是录音 id，第二个才是服务地址 —— 别把两者搞反。
// 服务地址可以省略：优先用 data/runtime.json 里启动器写的那份，退回 8788。
function defaultApp() {
  try {
    const rt = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'runtime.json'), 'utf8'));
    if (rt.port) return `http://127.0.0.1:${rt.port}`;
  } catch { /* 没在跑 */ }
  return 'http://127.0.0.1:8788';
}
const LECTURE = process.argv[2];
if (!LECTURE || /^https?:/.test(LECTURE)) {
  console.error('用法: node tests/audio-level-check.mjs <lectureId> [服务地址]');
  process.exit(2);
}
const APP = (process.argv[3] || defaultApp()).replace(/\/+$/, '');
const CDP_PORT = 9226;

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = path.join(__dirname, '_lvl_profile');
fs.rmSync(profile, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });

let ver = null;
for (let i = 0; i < 60; i++) { try { ver = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((r) => r.json()); break; } catch { await sleep(500); } }
if (!ver) { console.error('浏览器起不来'); chrome.kill(); process.exit(2); }

const tab = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${APP}/`, { method: 'PUT' }).then((r) => r.json());
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
let id = 0; const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const i = ++id; pending.set(i, { resolve, reject });
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error(method + ' 超时')); } }, 600000);
});
await send('Runtime.enable');
await sleep(1500);

console.log(`\n=== 音频电平测量（${ver.Browser}）===\n`);
const expr = `(async () => {
  const resp = await fetch('/api/lectures/${LECTURE}/audio');
  const buf = await resp.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC({ sampleRate: 16000 });
  const audio = await ctx.decodeAudioData(buf);
  const ch = [];
  for (let c = 0; c < audio.numberOfChannels; c++) ch.push(audio.getChannelData(c));
  const n = audio.length;
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const d of ch) s += d[i];
    mono[i] = s / ch.length;
  }
  await ctx.close();
  // 全局 RMS / 峰值
  let sum = 0, peak = 0, silent = 0;
  const win = 1600;           // 0.1 秒一窗
  const wins = [];
  for (let i = 0; i < n; i += win) {
    let ws2 = 0, wp = 0, cnt = 0;
    for (let j = i; j < Math.min(n, i + win); j++) { const v = mono[j]; ws2 += v * v; wp = Math.max(wp, Math.abs(v)); cnt++; }
    const r = Math.sqrt(ws2 / Math.max(1, cnt));
    wins.push(r);
    sum += ws2; peak = Math.max(peak, wp);
  }
  const rms = Math.sqrt(sum / Math.max(1, n));
  const db = (x) => x > 0 ? (20 * Math.log10(x)).toFixed(1) : '-inf';
  wins.sort((a, b) => a - b);
  const pct = (p) => wins[Math.min(wins.length - 1, Math.floor(wins.length * p))];
  // 判定阈值：-50dBFS 以下算静音
  const silentWins = wins.filter((r) => 20 * Math.log10(Math.max(r, 1e-9)) < -50).length;
  return JSON.stringify({
    duration: audio.duration, rate: audio.sampleRate, channels: audio.numberOfChannels, bytes: buf.byteLength,
    rmsDb: db(rms), peakDb: db(peak),
    p10: db(pct(0.1)), p50: db(pct(0.5)), p90: db(pct(0.9)),
    silentRatio: (silentWins / wins.length * 100).toFixed(1),
    windows: wins.length
  });
})()`;
let out;
try { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); out = r.result?.value; }
catch (e) { console.error('求值失败:', e.message); }
ws.close(); chrome.kill(); await sleep(300); fs.rmSync(profile, { recursive: true, force: true });

if (!out) process.exit(1);
const d = JSON.parse(out);
console.log(`  时长 ${Math.round(d.duration / 60)} 分 ${Math.round(d.duration % 60)} 秒   采样率 ${d.rate} Hz   声道 ${d.channels}   文件 ${(d.bytes / 1048576).toFixed(1)} MB`);
console.log(`\n  整体 RMS   ${d.rmsDb} dBFS   （正常讲课录音应在 -30 ~ -18）`);
console.log(`  峰值       ${d.peakDb} dBFS   （应接近 -3 ~ -1，太低说明录得很轻）`);
console.log(`  分位数     P10 ${d.p10} / P50 ${d.p50} / P90 ${d.p90} dBFS`);
console.log(`  静音占比   ${d.silentRatio}%   （低于 -50dBFS 的时间比例，>40% 说明大部分听不清）`);
const rms = Number(d.rmsDb);
console.log('\n  --- 判定 ---');
let verdict = 'ok';
if (rms < -38) {
  verdict = 'too-low';
  console.log('  ❌ 录音电平过低：模型基本是在听噪声，必然大量幻觉。需要在转写前做增益归一化。');
} else if (rms < -30) {
  verdict = 'low';
  console.log('  ⚠️ 偏轻：能识别但错误率会明显偏高，建议归一化后再转写。');
} else {
  console.log('  ✅ 电平正常，问题更可能出在模型能力或口音/专业术语上。');
}
// 正常跑完要以 0 退出（run-all 靠退出码判成败）。
// 电平本身不合心意是「诊断结论」，不是「脚本坏了」—— 电平过低才值得让流水线注意，
// 这里仍返回 0，把判断留给看输出的人。
process.exit(0);
