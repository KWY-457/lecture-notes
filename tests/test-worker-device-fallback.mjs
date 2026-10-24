/**
 * 转写 Worker 的「换源 / 降级」策略测试（不需要浏览器、不需要真模型）
 *
 * 起因：实测 WebGPU 初始化失败时，旧代码会把 3 个模型源各试一遍
 * （本地 /api/hf → hf-mirror → huggingface.co），每次都在同一个
 * 跟「源」毫无关系的设备错误上失败 —— 用户白等 3 倍时间，
 * 而且反复下载、反复编译。
 *
 * 正确策略：
 *   - 先用 config.json 探针挑出**第一个能用**的模型源；
 *   - 只在这个源上建管线；
 *   - 建不起来时，只有当错误确实是「设备/显存/WebGPU」类才降级到 WASM，
 *     且降级仍然用同一个源，不再轮询别的源；
 *   - 网络类错误直接抛，换 WASM 也救不回来。
 *
 * 用法：node tests/test-worker-device-fallback.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, '..', 'public', 'worker-asr.js'), 'utf8');

let pass = 0;
let fail = 0;
const check = (label, cond, extra) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${extra ? ' —— ' + extra : ''}`);
  }
};

/**
 * 把 worker 源码改造成可 import 的模块。
 * cfg.failFor: 'webgpu' | 'all' | null —— 控制假管线在哪个后端上抛错
 * cfg.failKind: 抛什么错（用来验证「只有设备类错误才降级」）
 */
function buildModule({ failFor = null, failKind = 'WebGPU device lost', probeOk = true } = {}) {
  const rec = { fetches: [], pipelines: [], posts: [] };
  globalThis.__rec = rec;

  const fakeBody = `
    const rec = globalThis.__rec;
    const cfg = ${JSON.stringify({ failFor, failKind, probeOk })};
    const fake = {
      env: { allowLocalModels: true, useBrowserCache: false, remoteHost: '', remotePathTemplate: '',
             backends: { onnx: { wasm: { wasmPaths: '' } } } },
      async pipeline(task, model, o) {
        rec.pipelines.push({ model, device: o.device, dtype: o.dtype, host: fake.env.remoteHost });
        if (cfg.failFor === 'all' || cfg.failFor === o.device) throw new Error(cfg.failKind);
        o.progress_callback && o.progress_callback({ status: 'ready' });
        return async (audio) => ({ text: 'x', chunks: [{ text: 'x', timestamp: [0, 1] }] });
      },
    };
    export const pipeline = fake.pipeline;
    export const env = fake.env;
  `;
  const fakeUrl = 'data:text/javascript;base64,' + Buffer.from(fakeBody, 'utf8').toString('base64');

  let src = SRC.replace(
    /await import\(\/\* webpackIgnore: true \*\/ base \+ '\/dist\/transformers\.min\.js'\)/,
    `await import(${JSON.stringify(fakeUrl)})`
  );
  if (src === SRC) throw new Error('没能替换动态 import，测试无效');

  src += `
    const rec = globalThis.__rec;
    self.postMessage = (m) => rec.posts.push(m);
    globalThis.fetch = async (u) => {
      rec.fetches.push(String(u));
      if (!${probeOk}) return { ok: false, status: 404 };
      return { ok: true, status: 200, json: async () => ({}) };
    };
    export async function run(msg) { await self.onmessage({ data: msg }); }
  `;

  globalThis.self = { location: { protocol: 'http:', origin: 'http://127.0.0.1:8788' } };
  return { url: 'data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64'), rec };
}

const RUN_MSG = () => ({
  type: 'run',
  audio: new Float32Array(16000 * 60),
  sampleRate: 16000,
  language: 'zh',
  cfg: {
    model: 'onnx-community/whisper-large-v3-turbo',
    device: 'webgpu',
    cdn: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3',
    modelHost: '', // 留空 → 候选顺序是 本地 /api/hf → hf-mirror → huggingface.co
  },
});

async function scenario(title, opts) {
  console.log('\n' + title);
  const { url, rec } = buildModule(opts);
  const mod = await import(url);
  await mod.run(RUN_MSG());
  return rec;
}

/* ---------- 场景 1：WebGPU 失败 → 只降级一次，不轮询模型源 ---------- */
{
  const rec = await scenario('场景 1：WebGPU 起不来（设备错误）', { failFor: 'webgpu' });
  const hosts = [...new Set(rec.pipelines.map((p) => p.host))];
  check('管线只建了 2 次（webgpu 失败 + wasm 成功）', rec.pipelines.length === 2, `实际 ${rec.pipelines.length} 次`);
  check('两次用的是同一个模型源（没有白轮询别的源）', hosts.length === 1, `用到 ${hosts.join(' / ')}`);
  check('降级后确实是 wasm', rec.pipelines[1]?.device === 'wasm', String(rec.pipelines[1]?.device));
  check('只探了一次 config.json 探针', rec.fetches.length === 1, `实际 ${rec.fetches.length} 次：${rec.fetches.join(', ')}`);
  const loaded = rec.posts.find((m) => m.type === 'loaded');
  check('最终报给界面的是 wasm', loaded?.device === 'wasm', String(loaded?.device));
  check(
    '降级时明确说了「会慢很多、急着出稿建议用云端」',
    rec.posts.some((m) => /WASM/.test(m.message || '') && /慢/.test(m.message || ''))
  );
}

/* ---------- 场景 2：网络错误 → 不许降级成 WASM ---------- */
{
  const rec = await scenario('场景 2：模型源报 404（网络类问题，不是设备问题）', { probeOk: false });
  check('没有建任何管线（源不通就不该建）', rec.pipelines.length === 0, `实际 ${rec.pipelines.length} 次`);
  check('没有假装成「设备问题」去降级', !rec.posts.some((m) => /WASM/.test(m.message || '')));
  check('报了错', rec.posts.some((m) => m.type === 'error'));
  check(
    '3 个候选源都探过了（源不通确实该换源）',
    rec.fetches.length === 3,
    `实际 ${rec.fetches.length} 次：${rec.fetches.join(', ')}`
  );
}

/* ---------- 场景 3：设备错误但连 wasm 也失败 → 如实抛错 ---------- */
{
  const rec = await scenario('场景 3：连 WASM 也建不起来', { failFor: 'all', failKind: 'WebGPU adapter error' });
  const err = rec.posts.find((m) => m.type === 'error');
  check('报了错而不是静默卡住', !!err, '没有 error 消息');
  check('错误原文带出来了', /adapter error/.test(err?.message || ''), err?.message);
}

/* ---------- 场景 4：正常的下载前心跳（缓存命中也要有话说） ---------- */
{
  const rec = await scenario('场景 4：模型缓存命中（progress_callback 什么都不报）', {});
  check('建管线之前就先说了一句「正在准备模型」', rec.posts.some((m) => /正在准备模型/.test(m.message || '')));
  check('结束时没有残留的心跳消息刷屏', rec.posts.filter((m) => m.heartbeat).length === 0, `心跳 ${rec.posts.filter((m) => m.heartbeat).length} 条`);
}

console.log('\n' + '='.repeat(70));
console.log(fail === 0 ? `全部通过（${pass} 项）` : `${pass} 通过 / ${fail} 失败`);
console.log('='.repeat(70));
process.exitCode = fail === 0 ? 0 : 1;
