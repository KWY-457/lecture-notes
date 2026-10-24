// 老配置迁移（migrateLegacyProviders）的自动化回归。
//
// 为什么值得单独一个测试文件：这段代码只在「升级」时跑一次，平时开发根本碰不到。
// 一旦写错，老用户升级后 Key 还在但地址被清空，界面上看起来是「配置丢了」，
// 而他们根本不会想到去报告 —— 属于那种「坏了也没人喊」的 bug。
//
// 做法：起一次性的临时服务（自己的数据目录，不碰真 data/），
// 每次往里写一份「旧版本会存在的样子」的 config.json，
// 启动后读回来，看 provider 是不是被改对、地址和模型有没有补上、Key 有没有被动。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ✅ ${name}${detail ? '   ' + detail : ''}`); }
  else { fail++; console.log(`  ❌ ${name}   ${detail}`); }
};
const section = (t) => console.log(`\n── ${t} ──`);

/** 找一个空闲端口（测试自己起服务，不能撞上 25994 那个真服务） */
function freePort() {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => res(p));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 起一次临时服务，等它把配置读/迁移完，然后把最终 config.json 读回来。
 * @param {object} legacyConfig 写进临时数据目录的「旧配置」
 * @returns {Promise<{cfg:object, log:string}>}
 */
async function bootOnce(legacyConfig) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ln-mig-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(legacyConfig, null, 2), 'utf8');
  const port = await freePort();
  const proc = spawn(NODE, ['server.mjs', '--port', String(port), '--data', dir], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (d) => (log += d.toString()));
  proc.stderr.on('data', (d) => (log += d.toString()));

  // 等到端口真的能连上（最多 15 秒），再多给 400ms 让 saveConfig 落完盘
  const deadline = Date.now() + 15000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1200) });
      if (r.ok) { up = true; break; }
    } catch {}
    await sleep(200);
  }
  await sleep(400);
  if (proc.pid) {
    try { process.kill(proc.pid, 'SIGKILL'); } catch {}
  }
  const raw = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  return { cfg: JSON.parse(raw), log, up };
}

/* ======================= 场景 1：云端服务商被收掉 ======================= */
section('场景 1：groq（转写）+ zhipu（笔记）→ 都变 custom，地址和模型补上，Key 不动');
{
  const { cfg, log, up } = await bootOnce({
    asr: { provider: 'groq', model: '', endpoint: '', apiKey: 'sk-asr-legacy' },
    llm: { enabled: true, provider: 'zhipu', baseUrl: '', apiKey: 'sk-llm-legacy', model: '', temperature: 0.3, timeoutMs: 180000, extraPrompt: '' },
    keyVault: [],
    storage: { lecturesDir: '', modelsDir: '' },
  });
  check('服务起得来', up === true, log.match(/端口.*占用/)?.[0] || '');
  check('asr.provider: groq → custom', cfg.asr?.provider === 'custom', cfg.asr?.provider);
  check('asr.endpoint 补上 Groq 官方地址',
    cfg.asr?.endpoint === 'https://api.groq.com/openai/v1/audio/transcriptions', cfg.asr?.endpoint);
  check('asr.model 补上 whisper-large-v3-turbo',
    cfg.asr?.model === 'whisper-large-v3-turbo', cfg.asr?.model);
  check('asr 的 Key 一字未改', cfg.asr?.apiKey === 'sk-asr-legacy', cfg.asr?.apiKey);
  check('llm.provider: zhipu → custom', cfg.llm?.provider === 'custom', cfg.llm?.provider);
  check('llm.baseUrl 补上智谱官方地址',
    cfg.llm?.baseUrl === 'https://open.bigmodel.cn/api/paas/v4', cfg.llm?.baseUrl);
  check('llm.model 补上 glm-4-flash', cfg.llm?.model === 'glm-4-flash', cfg.llm?.model);
  check('llm 的 Key 一字未改', cfg.llm?.apiKey === 'sk-llm-legacy', cfg.llm?.apiKey);
  check('日志里说了迁移了什么', /\[配置迁移\] asr\.provider: groq → custom/.test(log), '');
  check('日志里说了补了什么', /\[配置迁移\] llm\.model 补上 glm-4-flash/.test(log), '');
  // 已经落盘了（不是只在内存里改了）
  check('迁移结果写回了 config.json（读回来就是 custom）', cfg.asr?.provider === 'custom', '');
}

/* ======================= 场景 2：本机类 → local ======================= */
section('场景 2：ollama / lmstudio / local-llm → 都并进 local，地址保留');
for (const legacy of ['ollama', 'lmstudio', 'local-llm']) {
  const { cfg } = await bootOnce({
    asr: { provider: 'local' },
    llm: { enabled: true, provider: legacy, baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'qwen2.5:3b' },
    keyVault: [],
    storage: { lecturesDir: '', modelsDir: '' },
  });
  check(`llm.provider: ${legacy} → local`, cfg.llm?.provider === 'local', cfg.llm?.provider);
  check(`${legacy} 的 baseUrl 保留（用户可能改过端口）`,
    cfg.llm?.baseUrl === 'http://127.0.0.1:11434/v1', cfg.llm?.baseUrl);
}

/* ======================= 场景 3：用户自己填过的不许覆盖 ======================= */
section('场景 3：用户填过地址或模型时，迁移只改 provider，不覆盖用户填的');
{
  const { cfg } = await bootOnce({
    asr: { provider: 'groq', model: 'my-custom-asr', endpoint: 'https://my-proxy.example.com/v1/audio/transcriptions', apiKey: 'sk-a' },
    llm: { enabled: true, provider: 'deepseek', baseUrl: 'https://my-proxy.example.com/v1', apiKey: 'sk-b', model: 'my-model' },
    keyVault: [],
    storage: { lecturesDir: '', modelsDir: '' },
  });
  check('asr.provider 还是被改成 custom', cfg.asr?.provider === 'custom', cfg.asr?.provider);
  check('用户填的 asr.endpoint 没被覆盖',
    cfg.asr?.endpoint === 'https://my-proxy.example.com/v1/audio/transcriptions', cfg.asr?.endpoint);
  check('用户填的 asr.model 没被覆盖', cfg.asr?.model === 'my-custom-asr', cfg.asr?.model);
  check('用户填的 llm.baseUrl 没被覆盖',
    cfg.llm?.baseUrl === 'https://my-proxy.example.com/v1', cfg.llm?.baseUrl);
  check('用户填的 llm.model 没被覆盖', cfg.llm?.model === 'my-model', cfg.llm?.model);
}

/* ======================= 场景 4：四家新配置原样不动 ======================= */
section('场景 4：已经用新四家的配置，启动后一个字都不改');
for (const pid of ['siliconflow', 'openai', 'local', 'custom']) {
  const before = {
    asr: { provider: pid, model: 'm1', endpoint: 'https://e/x', apiKey: 'sk-1' },
    llm: { enabled: true, provider: pid, baseUrl: 'https://b/v1', apiKey: 'sk-2', model: 'm2' },
    keyVault: [],
    storage: { lecturesDir: '', modelsDir: '' },
  };
  const { cfg, log } = await bootOnce(before);
  check(`${pid}：provider 保持原样`, cfg.asr?.provider === pid && cfg.llm?.provider === pid, `${cfg.asr?.provider}/${cfg.llm?.provider}`);
  check(`${pid}：地址模型没被动过`, cfg.asr?.model === 'm1' && cfg.asr?.endpoint === 'https://e/x' && cfg.llm?.model === 'm2', '');
  check(`${pid}：日志里没有迁移记录`, !/配置迁移/.test(log), '');
}

/* ======================= 场景 5：迁移只跑一次，第二次启动不再动 ======================= */
section('场景 5：迁移是幂等的（跑过的配置再启动不会重复改）');
{
  // 注意 asr 侧只能用 groq —— dashscope / zhipu 这些本来就没有转写接口，
  // 不在 asr 的迁移表里（它们是「仅笔记」的服务商，带过来的 asr.provider
  // 只可能是用户手改过，那种情况不该替用户猜）。
  const once = await bootOnce({
    asr: { provider: 'groq', model: '', endpoint: '', apiKey: 'sk-x' },
    llm: { enabled: true, provider: 'moonshot', baseUrl: '', apiKey: 'sk-y', model: '' },
    keyVault: [],
    storage: { lecturesDir: '', modelsDir: '' },
  });
  check('第一遍：groq → custom', once.cfg.asr?.provider === 'custom', once.cfg.asr?.provider);
  check('第一遍：moonshot → custom', once.cfg.llm?.provider === 'custom', once.cfg.llm?.provider);
  // 拿第一遍的结果再启动一次
  const twice = await bootOnce(once.cfg);
  check('第二遍：provider 仍是 custom', twice.cfg.asr?.provider === 'custom', twice.cfg.asr?.provider);
  check('第二遍：地址没被重复补', twice.cfg.asr?.endpoint === once.cfg.asr?.endpoint, twice.cfg.asr?.endpoint);
  check('第二遍：模型没被重复补', twice.cfg.llm?.model === once.cfg.llm?.model, twice.cfg.llm?.model);
  check('第二遍：日志里没有迁移记录', !/配置迁移/.test(twice.log), '');
}

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail === 0 ? 0 : 1);
