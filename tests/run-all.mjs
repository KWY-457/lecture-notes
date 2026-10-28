/**
 * 测试总入口
 *
 * 为什么要有这个：tests/ 下有 50 多个脚本，分四种性质（纯离线、要服务端、
 * 要 CDP 浏览器、要真实大模型）。以前要么全手敲，要么挑着跑，结果「哪些
 * 该绿、哪些本来就跑不了」全靠记忆 —— 这正是环境性失败能藏几个月的原因。
 *
 * 三层，按依赖从少到多：
 *   1. 离线层：纯逻辑，不联网不起服务，永远应该全绿。默认就跑这一层。
 *   2. 服务层：要一个活着的小程序（默认找本机在跑的实例，也可以自己指定 URL）。
 *   3. 浏览器层：要 CDP 浏览器的真界面测试（要 --cdp）。
 *   需要真实大模型/第三方付费服务的，一律不算失败，只报「跳过」并说明缺什么。
 *
 * 跑法：
 *   node tests/run-all.mjs                          只跑离线层
 *   node tests/run-all.mjs --with-server            离线 + 服务层（自动找在用实例）
 *   node tests/run-all.mjs --server http://127.0.0.1:25994
 *   node tests/run-all.mjs --all --cdp 9222         全跑（浏览器层要自己先起 Edge）
 *   node tests/run-all.mjs --list                   只列出分组，不执行
 *
 * 退出码：有任何失败 -> 1，全绿或全跳过 -> 0。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const NODE = process.execPath;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const TIMEOUT_MS = Number(val('--timeout', '180000'));

/* ---------------- 分组 ---------------- */

// 离线层：不联网、不起服务、不读外部模型，纯逻辑 + 文件解析。
// 这些挂了就是真挂了，没有任何借口。
const OFFLINE = [
  ['syntax-check.mjs', '全部源文件语法 + 结构自检'],
  ['check-ui-ids.mjs', 'index.html 与 app.js 的 id 对得上'],
  ['check-dead-ids.mjs', '没有指向不存在元素的死 id'],
  ['check-t2s-table.mjs', '繁简表逐字守恒、常用字全覆盖'],
  ['check-vram-truth.mjs', '显存判断逻辑与实际一致'],
  ['test-cleanup.mjs', '文本清洗'],
  ['check-quality-baseline.mjs', '转写质量对着基线不漂（第⑨项回归）'],
  ['test-data-pipeline.mjs', '脏数据进、干净数据出（规范化的核心回归）'],
  ['test-denoise.mjs', '降噪'],
  ['test-docx.mjs', 'Word 导出'],
  ['test-guardrail.mjs', 'AI 笔记不许编造（防幻觉核对）'],
  ['test-note-strip.mjs', '笔记清洗：提示词泄漏与核对节要删干净，逐字稿附录一个字都不能少'],
  ['test-note-header.mjs', '笔记页眉用真实元数据覆盖'],
  ['test-pipeline.mjs', '笔记生成流水线'],
  ['test-llm-prompt.mjs', 'AI 笔记提示词：重点条数真的生效（自适应/固定都验）'],
  ['test-mindmap-labels.mjs', '思维导图标签：强信号优先、泛词不要、抽不出就空着'],
  ['test-tex.mjs', 'LaTeX 公式渲染：分数/上下标/希腊字母/极端输入不崩'],
  ['test-tex-style.mjs', 'LaTeX 对齐：分数贴数学轴、根号不沉底、括号跟着长高'],
  ['test-tx-collapse.mjs', '逐字稿面板收起/展开：必须留回程入口、收起后正文真占满'],
  ['test-pdf-export.mjs', 'PDF 导出：只导正文、公式不裸奔、字体真的嵌进去（没装浏览器会跳过出 PDF 那几步）'],
  ['test-providers.mjs', '各家转写/大模型服务商的参数拼装'],
  ['test-worker-device-fallback.mjs', '显卡不可用时的回退'],
  ['test-vram-autofree.mjs', '转写前自动腾显存'],
];

// 服务层：要一个活着的后端。
// 大多数脚本的第一个位置参数就是服务地址；但这两个不是 ——
//   · audio-level-check / diagnose-transcript：第一个是录音 id，第二个才是地址。
//     地址传错位置会被当成 id 拼进 data/lectures/<url>/meta.json，报 ENOENT。
//   · browser-check 的第一个参数确实是地址（不给就退默认 8790，那个端口通常没服务）。
const SERVER = [
  ['asr-check.mjs', '转写服务配置连通性'],
  ['audio-level-check.mjs', '音频电平与响度', 'lecture-then-url'],
  ['browser-check.mjs', '浏览器能力（WebGPU 等）'],
  ['diagnose-transcript.mjs', '逐字稿体检', 'lecture-then-url'],
  ['dom-app-test.mjs', '用影子 DOM 把 app.js 整个跑起来点一遍'],
  ['net-check.mjs', '网络与端口'],
  // probe-chapters 是「要真调大模型」的探针：脚本自己套了 90 秒护栏，超时就打印跳过并 exit 0。
  // 别把它的超时调到 180 秒以上 —— run-all 单个脚本上限就是 180 秒，先到先杀会变成假红（2026-10-26 踩过）。
  ['probe-chapters.mjs', '笔记章节结构'],
  ['test-agreement.mjs', '用户协议 / 隐私政策（会真的点一次同意，别指着正式数据跑）'],
  ['test-config-guard.mjs', '测试跑完必须把 data/config.json 原样还回去'],
  ['test-donate.mjs', '打赏弹窗（自起临时服务，不碰正式数据）'],
  ['test-keyvault.mjs', 'API Key 清单：落盘、重启、本机明文 / 局域网掩码、删除'],
  ['test-storage.mjs', '存储位置：拒绝坏路径、迁移只复制不删源、改回默认、局域网 403'],
  ['test-lan.mjs', '手机访问开关：默认关、关着时局域网 403、开了放行、外机关不了'],
  ['test-provider-migration.mjs', '老配置迁移：收掉的服务商并进 custom / local，Key 和自填项不动'],
  ['test-integrations.mjs', '对外集成'],
];

// 浏览器层：真浏览器 + CDP。要 --cdp 且自己先起 Edge（见 README / 交接书）。
const BROWSER = [
  ['cdp-probe.mjs', '进度条 / 诊断面板等真界面断言'],
  ['cdp-jobs.mjs', '多任务的独立性（转写栏按项目分开）'],
  ['cdp-guard.mjs', 'AI 笔记防幻觉在真界面上的表现'],
  ['cdp-concurrent.mjs', '两条录音真并发转写（需要 mock-asr）'],
];

// 需要真实外部依赖的：跑不了不算失败，说明缺什么就行。
// [文件名, 说明, 缺什么]
const ENV_GATED = [
  ['test-ainote-depth.mjs', 'AI 笔记深度对照', '本地大模型（127.0.0.1:8080）'],
  ['test-cloud-e2e.mjs', '云端转写端到端', '真实服务商 Key + 联网'],
  ['test-proofread-llm.mjs', '大模型校对', '真实大模型'],
  ['bench-real-asr.mjs', '真实录音转写基准', '真实模型 + 显卡'],
];

/* ---------------- 执行 ---------------- */

const results = []; // {name, desc, state: pass|fail|skip, ms, detail}

function runOne(file, args, extraEnv) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(NODE, [path.join(HERE, file), ...args], {
      cwd: ROOT,
      env: { ...process.env, ...(extraEnv || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = out + err;
      // 脚本自己说「跳过」就直接算跳过，不管退出码
      const skipped = /⏭|跳过：|SKIP/i.test(text) && code === 0;
      resolve({
        code: killed ? 'timeout' : code,
        ms: Date.now() - t0,
        out: text,
        skipped,
      });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 'spawn-error', ms: Date.now() - t0, out: String(e), skipped: false });
    });
  });
}

function summarize(text) {
  // 从脚本输出里抽出「N 通过 / M 失败」「✅ 全部通过」这类收尾行，做成一行的摘要
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const L = lines[i];
    if (/(通过|失败|passed|failed|全部通过|OK|✓ 全)/i.test(L) && L.length < 100) return L;
  }
  return lines[lines.length - 1] || '';
}

function firstError(text) {
  const lines = text.split(/\r?\n/);
  const bad = lines.find((L) => /✗|✘|❌|Error:|错误|失败[:：]|not ok/i.test(L));
  if (bad) return bad.trim().slice(0, 200);
  return lines.filter(Boolean).slice(-3).join(' | ').slice(0, 200);
}

async function runGroup(title, list, argsFor, envFor) {
  console.log(`\n${'─'.repeat(72)}\n${title}\n${'─'.repeat(72)}`);
  for (const [file, desc] of list) {
    const full = path.join(HERE, file);
    if (!fs.existsSync(full)) {
      console.log(`   ⏭  ${file.padEnd(34)} ${desc}  （文件不存在）`);
      results.push({ name: file, desc, state: 'skip', ms: 0, detail: '文件不存在' });
      continue;
    }
    process.stdout.write(`   …  ${file.padEnd(34)} `);
    const r = await runOne(file, argsFor ? argsFor(file) : [], envFor ? envFor(file) : null);
    let state;
    if (r.code === 0) state = r.skipped ? 'skip' : 'pass';
    else state = 'fail';
    const mark = state === 'pass' ? '✅' : state === 'skip' ? '⏭ ' : '❌';
    const secs = (r.ms / 1000).toFixed(1) + 's';
    const note = state === 'pass' ? summarize(r.out) : state === 'skip' ? (r.out.match(/跳过：.*/) || [''])[0].slice(0, 90) : firstError(r.out);
    console.log(`${mark} ${secs.padStart(7)}  ${note}`);
    results.push({ name: file, desc, state, ms: r.ms, detail: note });
    if (state === 'fail' && has('--verbose')) {
      console.log('\n' + '-'.repeat(72) + '\n' + r.out.slice(-4000) + '\n' + '-'.repeat(72) + '\n');
    }
  }
}

/* ---------------- 主流程 ---------------- */

// 自动找本机在跑的实例：优先用 data/runtime.json（启动器写的那份）
function findRunningServer() {
  const explicit = val('--server', '');
  if (explicit) return explicit.replace(/\/+$/, '');
  try {
    const rt = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'runtime.json'), 'utf8'));
    if (rt.port) return `http://127.0.0.1:${rt.port}`;
  } catch { /* 没在跑 */ }
  return '';
}

async function serverAlive(base) {
  if (!base) return false;
  try {
    const r = await fetch(base + '/api/health', { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch { return false; }
}

if (has('--list')) {
  const show = (t, l) => {
    console.log(`\n${t}（${l.length}）`);
    for (const [f, d] of l) console.log(`  ${f.padEnd(34)} ${d}`);
  };
  show('离线层（默认跑）', OFFLINE);
  show('服务层（--with-server）', SERVER);
  show('浏览器层（--all --cdp <端口>）', BROWSER);
  console.log('\n需要外部依赖（永远只报跳过）');
  for (const [f, d, need] of ENV_GATED) console.log(`  ${f.padEnd(34)} ${d}  ← 需要 ${need}`);
  process.exit(0);
}

const t0 = Date.now();
console.log(`测试总入口  node ${process.version}  ${new Date().toLocaleString('zh-CN')}`);
console.log(`工作目录 ${ROOT}`);

await runGroup('第一层 · 离线（纯逻辑，永远该全绿）', OFFLINE);

// 服务层
const wantServer = has('--with-server') || has('--all') || has('--server');
if (wantServer) {
  const base = findRunningServer();
  const alive = await serverAlive(base);
  if (!alive) {
    console.log(`\n${'─'.repeat(72)}\n第二层 · 服务端\n${'─'.repeat(72)}`);
    console.log(`   ⏭  服务没在跑${base ? `（试过 ${base}）` : ''}，整层跳过。`);
    console.log(`      先起服务：启动.vbs    或    node server.mjs`);
    for (const [file, desc] of SERVER) results.push({ name: file, desc, state: 'skip', ms: 0, detail: '服务没在跑' });
  } else {
    console.log(`\n（服务地址 ${base}）`);
    // 有几个脚本的地址在第二个位置参数，第一个要录音 id。
    // 这里先问服务要一条真实存在的录音，问不到就给空、让脚本自己挑。
    let someId = '';
    try {
      const r = await fetch(base.replace(/\/+$/, '') + '/api/lectures');
      const j = await r.json();
      const cand = (j.lectures || []).find((l) => l.transcriptPresent !== false) || (j.lectures || [])[0];
      someId = cand?.id || '';
    } catch { /* 拿不到就让脚本自己挑 */ }
    const argsFor = (file) => {
      const spec = SERVER.find((s) => s[0] === file);
      const mode = spec?.[2];
      if (mode === 'lecture-then-url') return someId ? [someId, base] : [];
      return [base];
    };
    await runGroup('第二层 · 服务端（需要一个活着的后端）', SERVER, argsFor);
  }
}

// 浏览器层
const cdp = val('--cdp', '');
if (has('--all') || cdp) {
  if (!cdp) {
    console.log(`\n${'─'.repeat(72)}\n第三层 · 真浏览器\n${'─'.repeat(72)}`);
    console.log('   ⏭  没给 --cdp <端口>，整层跳过。');
    console.log('      起浏览器：msedge --headless=new --remote-debugging-port=9222 --user-data-dir=...');
    for (const [file, desc] of BROWSER) results.push({ name: file, desc, state: 'skip', ms: 0, detail: '没给 --cdp' });
  } else {
    const base = findRunningServer();
    if (!(await serverAlive(base))) {
      console.log(`\n${'─'.repeat(72)}\n第三层 · 真浏览器\n${'─'.repeat(72)}`);
      console.log('   ⏭  浏览器层要服务先跑起来，现在服务没在跑，整层跳过。');
      for (const [file, desc] of BROWSER) results.push({ name: file, desc, state: 'skip', ms: 0, detail: '服务没在跑' });
    } else {
      // cdp-probe 要 --cdp/--app；其余几个连同一个 CDP 端口自己找页面
      const argsFor = (file) => (file === 'cdp-probe.mjs' ? ['--cdp', cdp, '--app', base + '/'] : ['--cdp', cdp]);
      await runGroup('第三层 · 真浏览器（CDP）', BROWSER, argsFor);
    }
  }
}

// 外部依赖层：只报跳过，不执行（执行了也是连不上等 3 分钟）
if (has('--all')) {
  console.log(`\n${'─'.repeat(72)}\n附 · 需要外部依赖（不执行，只提示）\n${'─'.repeat(72)}`);
  for (const [file, desc, need] of ENV_GATED) {
    console.log(`   ⏭  ${file.padEnd(34)} ${desc}  ← 需要 ${need}`);
    results.push({ name: file, desc, state: 'skip', ms: 0, detail: '需要 ' + need });
  }
}

/* ---------------- 汇总 ---------------- */

const pass = results.filter((r) => r.state === 'pass');
const fail = results.filter((r) => r.state === 'fail');
const skip = results.filter((r) => r.state === 'skip');

console.log(`\n${'='.repeat(72)}`);
console.log(`合计 ${results.length} 项：✅ ${pass.length} 通过 · ❌ ${fail.length} 失败 · ⏭  ${skip.length} 跳过`);
if (fail.length) {
  console.log('\n失败的：');
  for (const r of fail) console.log(`  ❌ ${r.name.padEnd(34)} ${r.detail}`);
  console.log('\n看完整输出：node tests/run-all.mjs --verbose' + (has('--all') ? ' --all' : ''));
}
if (skip.length && (has('--verbose') || has('--all'))) {
  console.log('\n跳过的原因：');
  for (const r of skip) console.log(`  ⏭  ${r.name.padEnd(34)} ${r.detail}`);
}
console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
console.log('='.repeat(72));

process.exit(fail.length ? 1 : 0);
