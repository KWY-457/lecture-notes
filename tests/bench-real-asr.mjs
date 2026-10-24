/**
 * 真实速度基准：在真浏览器里、用真的录音、跑真的 WebGPU 转写。
 *
 * 为什么要跑真的：
 *   · 「首个结果要等多久」只有真跑才知道（模型编译 + 第一段推理是最大的黑盒）
 *   · worker 的设备选择（webgpu 还是 CPU）也只有真跑才知道
 *   · 假 worker 测试只能验「消息格式对不对」，验不了「到底多快」
 *
 * 它做什么：连上跑着的页面，抓一段已有录音，直接调 transcribeLocal 跑一遍，
 * 把「每段完成时刻 / 用时 / 设备 / 是否降级」打成时间线。
 * 不碰页面上的进度条，也不写服务端任何文件。
 *
 * 用法：
 *   node tests/bench-real-asr.mjs --lecture 1305e386-34c7-45e9-a6e1-a24ccc8ef080
 *   node tests/bench-real-asr.mjs --secs 300        # 只取前 5 分钟（快速验证，不做完整基准）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const CDP_PORT = Number(argOf('--cdp', '9222'));
const APP_URL = argOf('--app', 'http://127.0.0.1:8788/');
const LECTURE = argOf('--lecture', '');
const MAX_SECS = Number(argOf('--secs', '0'));
const DTYPE = argOf('--dtype', ''); // 留空 = 按设备自动选（webgpu→fp16，wasm→q8）
const DEVICE = argOf('--device', ''); // 留空 = 用配置里的 localDevice

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 这个脚本在 pwsh 里被管道接住时，输出会被缓冲到进程结束才出来 ——
   一旦中途卡住，就完全看不到它走到哪一步了。所以每过一个关键节点，
   直接追加写一行到 _scratch/bench-steps.log，另开一个窗口就能实时看。 */
const STEPS_LOG = 'D:/Download/dev/_scratch/bench-steps.log';
function step(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}\n`;
  try {
    fs.appendFileSync(STEPS_LOG, line);
  } catch {}
  console.log('· ' + msg);
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onopen = () =>
      resolve({
        send(method, params = {}) {
          const i = ++id;
          ws.send(JSON.stringify({ id: i, method, params }));
          return new Promise((res, rej) => pending.set(i, { res, rej }));
        },
        close: () => ws.close(),
      });
    ws.onerror = (e) => reject(new Error('WebSocket 连不上：' + (e.message || '未知')));
    ws.onmessage = (ev) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) rej(new Error(m.error.message));
        else res(m.result);
      }
    };
  });
}

async function main() {
  try {
    fs.writeFileSync(STEPS_LOG, `=== 本轮基准 ${new Date().toISOString()} device=${DEVICE || '(配置)'} dtype=${DTYPE || '(自动)'} ===\n`);
  } catch {}
  step('启动，去连 CDP');
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && t.url.startsWith(APP_URL.replace(/\/$/, '')));
  if (!page) throw new Error(`CDP 里没找到 ${APP_URL} 的页面`);
  step(`找到页面 ${page.id}，连 CDP`);
  const c = await connect(page.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  step('CDP 已连接');

  const evalIn = async (expr, timeoutMs = 20000) => {
    // 加超时：页面里如果抛未捕获的异常，awaitPromise 的这个 Promise 可能永远不 settle，
    // 整个基准就会无声挂死（踩过）。宁可超时报错，也不许装死。
    // 注意：主表达式要跑模型，必须显式传个大 timeout，别用这个 20 秒的默认值。
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`页面求值超时（${Math.round(timeoutMs / 1000)} 秒没回应）`)), timeoutMs); });
    try {
      const r = await Promise.race([c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }), timeout]);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || '页面里报错');
      return r.result.value;
    } finally {
      clearTimeout(timer);
    }
  };

  const info = await evalIn(`(() => {
    const L = window.__LN__;
    const c = L.state.config;
    return { model: c.asr.localModel, host: c.asr.modelHost, device: c.asr.localDevice || c.asr.device, language: c.asr.language, denoise: c.asr.denoise };
  })()`);
  // 注意：配置里这个键叫 asr.localDevice（不是 asr.device）。
  // 读错键名会拿到 undefined，然后整轮基准悄悄跑在 CPU 上 —— 数字会难看十倍（踩过这个坑）。
  const devPref = DEVICE || info.device || 'webgpu';
  console.log('\n页面里的转写配置：' + JSON.stringify(info) + `　（本次跑：device=${devPref} dtype=${DTYPE || '(按设备自动)'}）`);
  step(`读到配置：model=${info.model} host=${info.host}`);

  const lec = await evalIn(`(async () => {
    const r = await fetch('/api/lectures');
    const d = await r.json();
    const list = (d.lectures || []).map((x) => ({ id: x.id, title: x.title, duration: x.duration }));
    return list;
  })()`);
  step(`取到录音列表：${lec.length} 条`);
  console.log('录音列表：');
  for (const l of lec) console.log(`  ${l.id}  ${Math.round(l.duration)}s  ${l.title}`);

  let target = LECTURE ? lec.find((l) => l.id === LECTURE) : lec.filter((l) => l.duration > 60).sort((a, b) => a.duration - b.duration)[0];
  if (!target) throw new Error('没有可用来跑基准的录音');
  console.log(`\n选中：${target.id}  约 ${Math.round(target.duration)} 秒  ${target.title}`);
  console.log('（不写服务端任何文件，纯跑一遍看速度）\n');

  const t0 = Date.now();
  // 注意：这段字符串是在**浏览器里**跑的，Node 侧的常量必须用 ${...} 插进去。
  // 直接写 devPref / DTYPE 会变成「浏览器里没这个变量」，而且页面会抛
  // ReferenceError 导致这个 Promise 永远不 settle（踩过：整轮基准无声挂死）。
  const expr = `(async () => {
    const mod = await import('/asr-local.js');
    const L = window.__LN__;
    const conf = L.state.config.asr;
    const res = await fetch('/api/lectures/${target.id}/audio');
    if (!res.ok) throw new Error('取音频失败 HTTP ' + res.status);
    const buf = await res.arrayBuffer();
    const events = [];
    const t0 = performance.now();

    /* --secs N：只取前 N 秒，用来自测「第一个结果要等多久」。
       做法：先用 asr-local.js 自己的解码器解成 16k 单声道，截前 N 秒，
       再拼成一个内存里的 WAV Blob 丢回 transcribeLocal —— 这样跑的还是同一条真实链路。 */
    const MAX_SECS = ${MAX_SECS};
    let input = buf;
    let usedSecs = 0;
    let decodeMs = 0;
    if (MAX_SECS > 0) {
      const td = performance.now();
      const dec = await mod.decodeToMono16k(buf);
      decodeMs = Math.round(performance.now() - td);
      const n = Math.min(dec.data.length, Math.round(MAX_SECS * 16000));
      const pcm = dec.data.subarray(0, n);
      const hdr = new ArrayBuffer(44);
      const dv = new DataView(hdr);
      const wr = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
      wr(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); wr(8, 'WAVEfmt ');
      dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
      dv.setUint32(24, 16000, true); dv.setUint32(28, 32000, true);
      dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
      wr(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
      const p16 = new Int16Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) {
        const v = Math.max(-1, Math.min(1, pcm[i]));
        p16[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }
      input = new Blob([hdr, p16.buffer], { type: 'audio/wav' });
      usedSecs = n / 16000;
    }

    const out = await mod.transcribeLocal(input, {
      model: conf.localModel, device: ${JSON.stringify(devPref)}, dtype: ${JSON.stringify(DTYPE || null)} || undefined, modelHost: conf.modelHost,
      language: conf.language, denoise: conf.denoise,
    }, (p) => {
      events.push({ ms: Math.round(performance.now() - t0), stage: p.stage || '', pct: p.pct, device: p.device || '', msg: String(p.message || '').slice(0, 160) });
    });
    return { events, totalMs: Math.round(performance.now() - t0), usedSecs, decodeMs, segCount: (out.segments || []).length, chars: (out.text || '').length, sample: (out.text || '').slice(0, 200) };
  })()`;

  const timeoutMs = Number(argOf('--timeout', '1500000'));
  const usedSecsArg = MAX_SECS > 0 ? MAX_SECS : target.duration;
  const run = evalIn(expr, timeoutMs + 60000);
  run.catch(() => {}); // 主表达式超时/抛错时，这个 Promise 可能没人接；先挂个空的 catch，真正报错靠 await
  step(`已把转写任务丢进页面（${Math.round(usedSecsArg)} 秒音频，等结果）`);
  const started = Date.now();
  let done = false;
  const beat = setInterval(async () => {
    if (done) return;
    try {
      // 顺手看一眼页面上的进度条真的在不在动 —— 基准是绕过界面直接调 worker 的，
      // 只有真看一眼才知道「用户看到的那条」有没有活起来。
      const p = await evalIn(`(() => {
        const g = (id) => document.getElementById(id) || {};
        return (g('progress-stage').textContent || '') + ' | ' + (g('progress-label').textContent || '') + ' | ' + (g('progress-pct').textContent || '');
      })()`);
      console.log(`  …已跑 ${Math.round((Date.now() - started) / 1000)}s（本轮基准不经过界面，进度条这句是旁证：${p}）`);
      step(`进行中 ${Math.round((Date.now() - started) / 1000)}s：${p}`);
    } catch {}
  }, 60000);
  const guard = setTimeout(() => {
    if (!done) console.log(`\n⚠ 超过 ${Math.round(timeoutMs / 1000)} 秒还没跑完，直接看已有结果`);
  }, timeoutMs);

  let r;
  try {
    r = await run;
    done = true;
  } finally {
    clearInterval(beat);
    clearTimeout(guard);
  }

  const audioSecs = r.usedSecs > 0 ? r.usedSecs : target.duration;
  const inferMs = r.decodeMs > 0 ? r.totalMs - r.decodeMs : r.totalMs;
  console.log(`\n总耗时 ${(r.totalMs / 1000).toFixed(1)} 秒，得到 ${r.segCount} 段 / ${r.chars} 字${r.usedSecs > 0 ? `（只跑了前 ${r.usedSecs.toFixed(0)} 秒音频）` : ''}`);
  if (r.decodeMs > 0) {
    console.log(`  其中：整条音频解码 ${(r.decodeMs / 1000).toFixed(1)} 秒（为了截前 ${r.usedSecs.toFixed(0)} 秒，白解了后面那一大段），`);
    console.log(`        转写本体 ${(inferMs / 1000).toFixed(1)} 秒`);
  }
  console.log(`按「音频时长 ÷ 转写本体」算：约 ${(audioSecs / (inferMs / 1000)).toFixed(2)}× 实时`);
  console.log(`按「音频时长 ÷ 总耗时」算（含解码，偏保守）：约 ${(audioSecs / (r.totalMs / 1000)).toFixed(2)}× 实时\n`);
  console.log('时间线（只挑关键节点）：');
  const dev = r.events.find((e) => e.device);
  if (dev) console.log(`  [${(dev.ms / 1000).toFixed(1)}s] 设备 = ${dev.device}  ${dev.msg}`);
  else console.log('  ⚠ 整轮都没报出设备 —— 注意：这很可能意味着它跑在 CPU 上（见下）');
  const fallback = r.events.find((e) => /改用 CPU\(WASM\)|WebGPU 起不来/.test(e.msg));
  if (fallback) console.log(`  [${(fallback.ms / 1000).toFixed(1)}s] ⚠ 降级了：${fallback.msg}`);
  const firstSeg = r.events.find((e) => /已得到 \\d+ 段|partial/.test(e.msg));
  if (firstSeg) console.log(`  [${(firstSeg.ms / 1000).toFixed(1)}s] 第一段结果出现：${firstSeg.msg}`);
  for (const e of r.events) {
    if (/这一段完成|正在转写这一段/.test(e.msg)) console.log(`  [${(e.ms / 1000).toFixed(1)}s] ${e.msg}`);
  }
  console.log('\n转写文本开头 200 字：\n  ' + (r.sample || '(空)').replace(/\n/g, ' '));
  c.close();
}

main().catch((e) => {
  console.error('\n基准脚本挂了：' + e.message);
  process.exitCode = 1;
});
