/**
 * 转写 Worker 的消息演练台（不需要浏览器、不需要真模型）
 *
 * 目的：把 public/worker-asr.js 的「报告链路」单独拿出来跑一遍，看 UI 到底能收到哪些消息、
 * 每条的 pct 是多少。用它复现两种让老大以为「卡死了」的场景：
 *   ① 模型在下载（progress_callback 一直报 progress）
 *   ② 模型已缓存（progress_callback 一条都不报，直接进入推理）
 * 这两种情况在旧代码里 UI 收到的都是「pct≈1」，用户分不清「在下模型」和「在算」。
 *
 * 做法：
 *   - 读 worker-asr.js 源码 → 正则改写成可以 import 的模块（导出 handle 函数 + 消息记录）
 *   - 用自制的 `self` 假环境接住 postMessage
 *   - 用 stub 的 fetch 假装模型源（可以控制耗时/是否报进度）
 *   - 把 `import(base + '/dist/transformers.min.js')` 换成 data: URL 的假 transformers，
 *     那个假 pipeline 会按脚本吐出 progress_callback 事件
 *
 * 用法：node tests/probe-worker-progress.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATH = path.join(HERE, '..', 'public', 'worker-asr.js');
const SRC = readFileSync(SRC_PATH, 'utf8');

// ---------- 假 transformers：pipeline() 会按 scenario 吐进度 ----------

function makeFakeTransformers(scenario, log) {
  const fake = {
    env: {
      allowLocalModels: true,
      useBrowserCache: false,
      remoteHost: '',
      remotePathTemplate: '',
      backends: { onnx: { wasm: { wasmPaths: '' } } },
    },
    async pipeline(_task, model, opts) {
      log.push({ kind: 'pipeline', model, device: opts.device, dtype: opts.dtype });
      const cb = opts.progress_callback;
      if (scenario === 'downloading') {
        // 模拟：一个大文件下载中，报 5 次进度
        for (let i = 1; i <= 5; i++) {
          cb?.({ status: 'progress', file: 'onnx/encoder_model_quantized.onnx', loaded: i * 1000, total: 5000 });
          await new Promise((r) => setTimeout(r, 1));
        }
        cb?.({ status: 'done', file: 'onnx/encoder_model_quantized.onnx' });
      } else if (scenario === 'cached') {
        // 模拟：全部命中缓存，一条 progress 都不报
        cb?.({ status: 'ready', file: 'onnx/encoder_model_quantized.onnx' });
      } else if (scenario === 'fail-webgpu') {
        if (opts.device === 'webgpu') throw new Error('WebGPU device lost');
        cb?.({ status: 'ready' });
      }
      // 假转写器：每个 30 秒 chunk 给一段结果
      return async (audio, o) => {
        log.push({ kind: 'infer', seconds: Math.round(audio.length / 16000), opts: { ...o, language: o.language } });
        await new Promise((r) => setTimeout(r, 2));
        return {
          text: '这是假的一段话',
          chunks: [
            { text: '这是假的一段话', timestamp: [0, 4] },
            { text: '第二段', timestamp: [4, 8] },
          ],
        };
      };
    },
  };
  return fake;
}

// ---------- 假 fetch：只服务工程探测探针 ----------

function makeFakeFetch(scenario, log) {
  return async (url) => {
    const u = String(url);
    log.push({ kind: 'fetch', url: u.length > 90 ? u.slice(0, 90) + '…' : u });
    if (/\/api\/hf\//.test(u) || /resolve\/main\/config\.json/.test(u)) {
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return { ok: true, status: 200 };
  };
}

// ---------- 把 worker 源码改造成可 import 的模块 ----------

function buildModuleSource(scenario, log) {
  let src = SRC;

  // 1) 换掉动态 import 的库地址 → 指向一个 data: URL 的假模块
  const fakeUrl =
    'data:text/javascript;base64,' +
    Buffer.from(
      `const fake = (${makeFakeTransformers.toString()})(${JSON.stringify(scenario)}, globalThis.__log);
       export const pipeline = fake.pipeline;
       export const env = fake.env;`,
      'utf8'
    ).toString('base64');
  src = src.replace(
    /await import\(\/\* webpackIgnore: true \*\/ base \+ '\/dist\/transformers\.min\.js'\)/,
    `await import(${JSON.stringify(fakeUrl)})`
  );
  if (!src.includes('data:text/javascript;base64')) throw new Error('没能替换掉动态 import，演练无效');

  // 2) 给 self / location / fetch 准备一个假环境，并把 post / onmessage 暴露出来
  const tail = `
globalThis.__log = globalThis.__log || [];
const __msgs = [];
globalThis.__msgs = __msgs;
self.postMessage = (m) => { __msgs.push(m); };
globalThis.fetch = globalThis.__fakeFetch;

export const messages = __msgs;
export async function run(msg) {
  await self.onmessage({ data: msg });
  return __msgs;
}
`;
  return { src: src + tail, fakeModuleUrl: fakeUrl };
}

// ---------- 跑一个场景，把消息打印出来 ----------

async function runScenario(name, scenario, msg) {
  const log = [];
  globalThis.__log = log;
  const { src } = buildModuleSource(scenario, log);
  globalThis.__fakeFetch = makeFakeFetch(scenario, log);

  // 假 self：worker 源码里用到 self.postMessage / self.onmessage / self.location
  const fakeSelf = { location: { protocol: 'http:', origin: 'http://127.0.0.1:8788' } };
  globalThis.self = fakeSelf;

  const url = 'data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64');
  const mod = await import(url);

  const msgs = await mod.run(msg);
  return { msgs, log };
}

function describe(msgs) {
  return msgs.map((m) => {
    if (m.type === 'progress') {
      const stage = m.stage ? `[${m.stage}]` : '';
      const pct = m.pct === undefined ? 'pct=—' : `pct=${m.pct}`;
      return `progress ${stage} ${pct}  ${m.message || ''}`;
    }
    if (m.type === 'partial') return `partial pct=${m.pct} segments=${m.segments?.length}`;
    if (m.type === 'done') return `done segments=${m.segments?.length}`;
    return `${m.type} ${JSON.stringify({ ...m, segments: undefined }).slice(0, 120)}`;
  });
}

// ---------- 主流程 ----------

const AUDIO_SEC = 600; // 10 分钟，刚好一个窗口
const audio = new Float32Array(16000 * AUDIO_SEC);
for (let i = 0; i < audio.length; i++) audio[i] = Math.sin(i / 20) * 0.2;

const runMsg = {
  type: 'run',
  audio,
  sampleRate: 16000,
  language: 'zh',
  windowSec: 600,
  cfg: {
    model: 'onnx-community/whisper-large-v3-turbo',
    device: 'webgpu',
    cdn: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3',
    modelHost: 'http://127.0.0.1:8788/api/hf',
  },
};

const cases = [
  ['场景 A：模型正在下载（progress_callback 一直报）', 'downloading'],
  ['场景 B：模型已缓存（一条 progress 都不报）', 'cached'],
  ['场景 C：WebGPU 失败 → 回退 WASM', 'fail-webgpu'],
];

let failures = 0;
const check = (label, cond, extra) => {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${extra ? ' —— ' + extra : ''}`);
  }
};

for (const [title, scenario] of cases) {
  console.log('\n' + '='.repeat(78));
  console.log(title);
  console.log('='.repeat(78));
  const { msgs } = await runScenario(title, scenario, runMsg);
  for (const line of describe(msgs)) console.log('  ' + line);

  console.log('  --- 断言 ---');
  const pcts = msgs.filter((m) => m.type === 'progress').map((m) => m.pct);
  const stages = new Set(msgs.filter((m) => m.type === 'progress').map((m) => m.stage));
  const maxPct = Math.max(...pcts.filter((n) => typeof n === 'number'), 0);

  if (scenario === 'downloading') {
    check('下载阶段能看到百分比在涨', maxPct > 50, `最大 pct=${maxPct}`);
    check('下载阶段有带子阶段的说明', stages.has('model'), `stage 集合=${[...stages].join(',')}`);
  }
  if (scenario === 'cached') {
    const tPcts = msgs.filter((m) => m.type === 'progress' && m.stage === 'transcribe' && typeof m.pct === 'number').map((m) => m.pct);
    const rising = tPcts.some((v, i) => i > 0 && v > tPcts[i - 1]);
    check('转写阶段百分比只增不减（不会先冲 100% 再跌回来）', tPcts.every((v, i) => i === 0 || v >= tPcts[i - 1]), tPcts.join(' → '));
    check('转写阶段确实在往前走（有递增）', rising, tPcts.join(' → '));
    check(
      '每段开始前都有一句「正在算，不是卡死」的心跳',
      msgs.some((m) => m.stage === 'transcribe' && /已 \d+ 秒/.test(m.message || '')),
      '没看到带秒数的转写心跳'
    );
    check(
      '缓存命中时确实一条下载进度都没有（所以旧界面只能干等）',
      !msgs.some((m) => /下载模型/.test(m.message || '')),
      '如出现下载进度反而说明场景没生效'
    );
    check(
      '但模型阶段必须有话说（否则用户以为死机）',
      msgs.some((m) => m.stage === 'model' && /准备模型/.test(m.message || '')),
      '没有「正在准备模型」这句话'
    );
  }
  if (scenario === 'fail-webgpu') {
    check('回退 WASM 会明说', msgs.some((m) => /WASM/.test(m.message || '') && /慢/.test(m.message || '')));
  }
  check('结束时一定有 done 或 error', msgs.some((m) => m.type === 'done' || m.type === 'error'));
}

console.log('\n' + '='.repeat(78));
console.log(failures === 0 ? '全部通过' : `${failures} 项失败`);
console.log('='.repeat(78));
process.exitCode = failures === 0 ? 0 : 1;
