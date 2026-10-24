/**
 * 本地 Whisper 转写 Worker
 * 在 Web Worker 里跑 transformers.js，避免卡住界面。
 * 模型与依赖库都从 CDN / 模型源按需下载，之后浏览器会缓存。
 */

let transcriber = null;
let loadedKey = '';
let usedBase = ''; // 实际加载成功的 CDN 基址（wasm 文件也从这里取）
let deviceUsed = ''; // 实际跑起来的后端：webgpu | wasm
let heartbeat = null; // 「有心跳」定时器：保证界面永远有东西在动

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

/**
 * 心跳：模型从浏览器缓存读、ONNX 编译图、以及每一段推理，
 * 这几个阶段 transformers.js 的 progress_callback **一条都不报**。
 * 实测表现就是界面上「正在下载或计算」这句一直不动，用户以为卡死。
 * 所以这里自己按秒报，并且越等越把丑话说前面（不会假装很快）。
 */
function beat(from, stage) {
  stopBeat();
  const t0 = Date.now();
  const say = () => {
    const sec = Math.round((Date.now() - t0) / 1000);
    const msg =
      sec < 20
        ? `${from}（已 ${sec} 秒）`
        : sec < 60
          ? `${from}（已 ${sec} 秒，这一阶段没有细进度，不是卡死）`
          : `${from}（已 ${sec} 秒，真的没卡死，但慢就是慢；嫌慢可以换更小的模型或改用云端接口）`;
    post({ type: 'progress', stage, message: msg, heartbeat: sec > 0 });
  };
  say(); // 立刻说一句：别让界面从第一秒就是「没有任何反应」
  heartbeat = setInterval(say, 1000);
}

function stopBeat() {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
}

/**
 * 选精度（dtype）。
 *
 * 默认 q8：8bit 量化，质量接近 fp16、体积减半，磁盘缓存一份两用。
 *
 * **但 WebGPU 上不能配 q8**：实测 `whisper-large-v3-turbo` 的 `*_quantized.onnx`
 * 走 WebGPU 会输出成段的乱码（英文/俄文/日文混着蹦），而且比 CPU 还慢
 * （120 秒音频 526.8 秒 / GPU 占用只有 13–22%），是 ONNX Runtime WebGPU 的
 * 量化算子后端不成熟，不是参数没调对。
 *
 * 所以：设备是 webgpu → fp16（要给 WebGPU 用就必须这份，约 3.1GB）；
 *       设备是 wasm   → q8（同一条音频实测 0.40× 实时，中文可读，胜出）。
 *
 * cfg.dtype 可以显式覆盖，用于验证（比如强制 q8 走 WebGPU 复现上面那个坑）。
 */
function pickDtype(model, device, override) {
  void model;
  if (override) return override;
  return device === 'webgpu' ? 'fp16' : 'q8';
}

/**
 * 依赖库候选地址。
 *
 * 必须优先 v3：transformers.js v4 的 dist 里**不再带 ONNX 运行时的 wasm**
 * （只有一个 46KB 的加载器 ort-wasm-simd-threaded.jsep.mjs），
 * 而 v3 的 dist 里带着 21.6MB 的 ort-wasm-simd-threaded.jsep.wasm，
 * 配合 wasmPaths 指向同一个 dist 目录就能稳定跑起来。
 */
function cdnCandidates(configured) {
  const list = [];
  const add = (u) => {
    const v = String(u || '').replace(/\/+$/, '');
    if (v && !list.includes(v)) list.push(v);
  };
  add(configured);
  add('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3');
  add('https://unpkg.com/@huggingface/transformers@3');
  add('https://cdn.npmmirror.com/npm/@huggingface/transformers/3.7.5/files');
  add('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4');
  return list;
}

/**
 * 模型下载源的候选。
 *
 * 第一优先是「本机服务中转」：hf-mirror 的 /resolve/ 端点只允许自家域名跨域，
 * 浏览器直连会被 CORS 拦成 "Failed to fetch"，所以改走同源的
 * /api/hf/... 由本地服务转发（服务端是 Node，不受 CORS 约束），
 * 而且服务端会顺手在 D 盘缓存一份模型文件。
 *
 * 后面几个直连地址是兜底：万一页面不是从本地服务打开的。
 */
function hostCandidates(configured) {
  const list = [];
  const add = (u) => {
    let v = String(u || '').trim();
    if (!v) return;
    if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
    if (!v.endsWith('/')) v += '/';
    if (!list.includes(v)) list.push(v);
  };
  try {
    if (self.location && /^https?:$/.test(self.location.protocol)) add(self.location.origin + '/api/hf');
  } catch {}
  add(configured);
  add('https://hf-mirror.com');
  add('https://huggingface.co');
  return list;
}

async function importTransformers(cdnList) {
  let lastErr = null;
  for (const base of cdnList) {
    try {
      post({ type: 'progress', stage: 'lib', message: '正在加载转写库…' });
      const mod = await import(/* webpackIgnore: true */ base + '/dist/transformers.min.js');
      if (!mod || !mod.pipeline) throw new Error('模块内容不完整');
      usedBase = base;
      return mod;
    } catch (e) {
      lastErr = e;
      post({ type: 'progress', stage: 'lib', message: `这个源不通，换下一个…（${base.replace(/^https?:\/\//, '').slice(0, 40)}）` });
    }
  }
  throw new Error('所有依赖库地址都下载失败，请检查网络，或在设置里更换「依赖库 CDN」。最后一个错误：' + (lastErr && lastErr.message));
}

/**
 * 第一步：探模型源，挑出第一个能用的。
 * 单独拆出来是为了别把「源不通」和「设备跑不起来」混在一起重试 ——
 * 之前 WebGPU 初始化失败会把 3 个模型源各试一遍，白等 3 倍时间。
 */
async function probeHosts(cfg) {
  let lastErr = null;
  const list = hostCandidates(cfg.modelHost);
  for (let i = 0; i < list.length; i++) {
    const host = list[i];
    if (i > 0) post({ type: 'progress', stage: 'model', message: `换用模型源 ${host.replace(/^https?:\/\//, '')} 重试…` });
    const probeUrl = host + cfg.model + '/resolve/main/config.json';
    let probe;
    try {
      probe = await fetch(probeUrl, { method: 'GET' });
    } catch (e) {
      lastErr = new Error(`连不上模型源（${probeUrl}）：${e.message}`);
      post({ type: 'progress', stage: 'model', message: `模型源不通：${host.replace(/^https?:\/\//, '')}` });
      continue;
    }
    if (!probe.ok) {
      lastErr = new Error(`模型源返回 HTTP ${probe.status}（${probeUrl}）`);
      post({ type: 'progress', stage: 'model', message: `模型源返回 HTTP ${probe.status}：${host.replace(/^https?:\/\//, '')}` });
      continue;
    }
    post({ type: 'progress', stage: 'model', message: `模型源可用：${host.replace(/^https?:\/\//, '')}`, pct: 1 });
    return host;
  }
  throw lastErr || new Error('没有可用的模型源');
}

/**
 * 第二步：在**指定**的模型源上用指定后端把管线建起来。
 * 只试一次，失败原样抛出 —— 重试策略由调用方按失败原因决定。
 */
async function buildOnce(mod, cfg, dev, host) {
  mod.env.remoteHost = host;
  mod.env.remotePathTemplate = '{model}/resolve/{revision}/';
  // 缓存命中时 progress_callback 什么都不报（transformers.js 只在真正走网络时才报）。
  // 所以这里自己起心跳，界面才不会看起来像死机。
  beat('正在准备模型（浏览器缓存命中的话不会有下载进度）', 'model');
  try {
    return await mod.pipeline('automatic-speech-recognition', cfg.model, {
      device: dev,
      dtype: pickDtype(cfg.model, dev, cfg.dtype),
      progress_callback: (p) => {
        if (p && p.status === 'progress' && p.file) {
          const pct = p.total ? Math.round((p.loaded / p.total) * 100) : 0;
          startDownloadBeat(p.file, pct);
          post({ type: 'progress', stage: 'model', message: `下载模型 ${p.file} ${pct}%`, pct, file: p.file });
        } else if (p && p.status) {
          post({ type: 'progress', stage: 'model', message: `模型 ${p.status}` });
        }
      },
    });
  } finally {
    stopBeat();
  }
}

/** 边下载边报：下载途中也要有「已等多久」，不然大文件看着也像卡死 */
function startDownloadBeat(file, pct) {
  if (heartbeat) return; // 下载进度本身在动，不需要心跳文案
  post({ type: 'progress', stage: 'model', message: `开始下载模型 ${file}`, pct });
}

/**
 * 设备相关的失败（WebGPU 建不起来、显存不够）**跟模型源没关系**，
 * 换源重试纯属浪费时间，直接降级到 WASM。
 */
function isDeviceFailure(e) {
  const s = String((e && e.message) || e);
  return /webgpu|gpu|device|adapter|shader|vram|out of memory|memory access|buffer/i.test(s);
}

async function loadPipeline(cfg) {
  const key = [cfg.cdn, cfg.model, cfg.device, cfg.dtype, cfg.modelHost].join('|');
  if (transcriber && loadedKey === key) return;

  const mod = await importTransformers(cdnCandidates(cfg.cdn));
  mod.env.allowLocalModels = false;
  mod.env.useBrowserCache = true;
  try {
    if (mod.env.backends && mod.env.backends.onnx && mod.env.backends.onnx.wasm) {
      mod.env.backends.onnx.wasm.wasmPaths = usedBase + '/dist/';
    }
  } catch {}

  // 默认要显卡加速：设备没写、或者写了 auto，都按 webgpu 试。
  // 踩过的坑：配置里没有 device 这个键时（老配置就是这样），原来会直接把 undefined 传给
  // transformers —— 它就老老实实用 CPU 跑，速度从约 4× 掉到 0.4×，而且界面上一句提示都没有。
  // 现在是「先要 GPU，失败再降级 WASM，并且把降级原因说出来」。
  const requested = !cfg.device || cfg.device === 'auto' ? 'webgpu' : cfg.device;
  const host = await probeHosts(cfg);
  let device = requested;
  try {
    transcriber = await buildOnce(mod, cfg, device, host);
  } catch (e) {
    // 只在「确实是 WebGPU 建不起来」时才降级。
    // 其它错（网络断了、模型名写错、磁盘缓存坏）换 WASM 也救不回来，原样抛出去更好排查。
    if (requested !== 'wasm' && isDeviceFailure(e)) {
      post({
        type: 'progress',
        stage: 'model',
        message: `WebGPU 起不来（${(e && e.message) || e}），改用 CPU(WASM) 模式。这个模式会慢很多，急着出稿建议改用云端接口。`,
      });
      transcriber = await buildOnce(mod, cfg, 'wasm', host);
      device = 'wasm';
    } else {
      throw e;
    }
  }
  deviceUsed = device;
  loadedKey = key;
  post({ type: 'loaded', device, model: cfg.model, cdn: usedBase });
}

function normalize(raw, offset) {
  const out = [];
  const chunks = (raw && raw.chunks) || [];
  if (chunks.length) {
    for (const c of chunks) {
      const text = String(c.text || '').trim();
      if (!text) continue;
      const ts = c.timestamp || [null, null];
      const start = (Number(ts[0]) || 0) + offset;
      const end = (Number(ts[1]) != null ? Number(ts[1]) : (Number(ts[0]) || 0) + 4) + offset;
      out.push({ start: +start.toFixed(2), end: +end.toFixed(2), text });
    }
  } else if (raw && raw.text) {
    out.push({ start: offset, end: offset + Math.max(3, raw.text.length / 4.2), text: String(raw.text).trim() });
  }
  return out;
}

/** 合并相邻碎片，让逐字稿更像句子 */
function mergeFragments(segs, maxGap = 0.6, maxLen = 90) {
  const out = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && s.start - last.end <= maxGap && (last.text + s.text).length <= maxLen && !/[。！？!?]$/.test(last.text)) {
      last.text = (last.text + s.text).replace(/\s+/g, ' ').trim();
      last.end = s.end;
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

let cancelled = false;

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  try {
    if (msg.type === 'cancel') {
      cancelled = true;
      return;
    }
    if (msg.type === 'load') {
      await loadPipeline(msg.cfg);
      post({ type: 'ready' });
      return;
    }
    if (msg.type === 'run') {
      cancelled = false;
      await loadPipeline(msg.cfg);
      const { audio, sampleRate = 16000, language, windowSec = 300 } = msg;
      const totalSec = audio.length / sampleRate;
      const win = Math.max(60, Number(windowSec) || 300);
      const step = win * sampleRate;
      const all = [];
      let processed = 0;
      const startedAt = Date.now();
      const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
      // 第一段切成不超过 2 分钟：模型加载完要等「第一段推理」才可能看到第一个字，
      // 实测这一段在大模型上要几分钟，用户会以为死机。切成 2 分钟能把首个结果
      // 提前到 1/2.5 的时间；后面再回到正常窗长，避免上下文重置次数变多影响质量。
      // 代价：第一段短一点，时间戳相对位置不受影响（都是按 offsetSec 累加的）。
      const FIRST_SLICE_SEC = Math.min(120, win);
      let firstStep = FIRST_SLICE_SEC * sampleRate;
      let sliceCount = Math.max(1, 1 + Math.ceil(Math.max(0, audio.length - firstStep) / step));

      let offset = 0;
      let sliceNo = 0;
      while (offset < audio.length) {
        if (cancelled) {
          post({ type: 'cancelled' });
          return;
        }
        const thisStep = sliceNo === 0 ? firstStep : step;
        sliceNo += 1;
        const slice = audio.subarray(offset, Math.min(audio.length, offset + thisStep));
        const offsetSec = offset / sampleRate;
        const sliceTotal = sliceCount;
        const doneSec = processed / sampleRate;
        const elapsed = (Date.now() - startedAt) / 1000;
        // 用「已经算完的音频秒数」反推速度，给一个粗略剩余时间。
        // 第一段还没算完时没有依据，就只报心跳，绝不编数字。
        const speed = doneSec > 0 ? elapsed / doneSec : 0;
        const eta = speed > 0 ? `，按目前速度大约还要 ${fmt(Math.max(0, (totalSec - doneSec) * speed))}` : '';
        const head =
          `第 ${sliceNo}/${sliceTotal} 段（音频 ${fmt(offsetSec)} 起）` +
          (doneSec > 0 ? `，已完成 ${fmt(doneSec)}，用时 ${fmt(elapsed)}${eta}` : '');
        beat(head, 'transcribe');
        post({
          type: 'progress',
          stage: 'transcribe',
          message: `${head}；正在转写这一段…`,
          pct: Math.round((offsetSec / totalSec) * 100),
          slices: sliceTotal,
        });
        const opts = {
          chunk_length_s: 30,
          stride_length_s: 5,
          return_timestamps: true,
          task: 'transcribe',
          // 关键：关掉「拿上一段的结果当上下文」。
          // 开着时只要有一小段听不清开始瞎编，幻觉会顺着上下文一路污染
          // 后面全部内容 —— 88 分钟的课有 9 个窗口，崩一个整条就毁了。
          condition_on_previous_text: false,
          // 抑制重复 n-gram，专治「形形形形」「这个地方，这个地方…」
          no_repeat_ngram_size: 3,
          repetition_penalty: 1.15,
        };
        if (language && language !== 'auto') opts.language = language;
        let raw;
        try {
          raw = await transcriber(slice, opts);
        } catch (e) {
          if (/unknown|unexpected|not a valid|invalid/i.test(String((e && e.message) || ''))) {
            post({ type: 'progress', stage: 'transcribe', message: '当前版本不支持抗幻觉参数，退回基础参数…' });
            const basic = { chunk_length_s: 30, stride_length_s: 5, return_timestamps: true, task: 'transcribe' };
            if (language && language !== 'auto') basic.language = language;
            raw = await transcriber(slice, basic);
          } else {
            throw e;
          }
        }
        const segs = normalize(raw, offsetSec);
        all.push(...segs);
        processed += slice.length;
        post({ type: 'partial', segments: mergeFragments(all), pct: Math.round((processed / audio.length) * 100), slices: sliceTotal, stage: 'transcribe' });
        post({
          type: 'progress',
          stage: 'transcribe',
          message: `${head}；这一段完成，已完成 ${fmt(processed / sampleRate)} / ${fmt(totalSec)}，用时 ${fmt((Date.now() - startedAt) / 1000)}`,
          pct: Math.round((processed / audio.length) * 100),
          slices: sliceTotal,
        });
        offset += thisStep;
      }
      stopBeat();
      const merged = mergeFragments(all);
      post({
        type: 'done',
        segments: merged,
        text: merged.map((s) => s.text).join('\n'),
      });
      return;
    }
  } catch (e) {
    stopBeat();
    post({ type: 'error', message: (e && (e.message || String(e))) || '未知错误' });
  }
};
