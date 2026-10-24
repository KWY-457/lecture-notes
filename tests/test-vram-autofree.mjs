/**
 * 「转写前自动腾显存」的单元测试。
 *
 * 背景（老大 2026-10-15 提的）：本地大模型常驻占 5～6GB 显存，本地转写也要显存，
 * 两个抢同一块 8GB 卡。抢不到时浏览器会**悄悄退回 CPU 模式**，慢十几倍，
 * 表现就是老大看到的「0:00 / 38:59，已等待 456 秒」。
 *
 * 以前是弹确认框问「要不要停」，老大明确要求：别问，自动腾，腾完再拉回来。
 * 这个脚本就盯这套逻辑，不需要浏览器、不需要真显卡：把 app.js 里那段代码抠出来，
 * 在 vm 里配上假的 api / progress / toast 跑。
 *
 * 运行： node tests/test-vram-autofree.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? '  →  ' + extra : ''}`);
  }
}

/** 从 app.js 里抠出「腾显存」那三段（失败时报出原因，别静默跳过） */
// 注意 1：只抠函数体 —— 函数头由外壳自己拼，不然会拼出两层 `async function { async function {`。
// 注意 2：**函数签名会变**（后来加了 jobId 参数用来把进度写进对应录音的档案）。
//        所以这里按「async function freeVramForTranscribe(任意参数) {」匹配，
//        把参数原样带上，别写死成 (gpu) —— 否则签名一改测试就假红。
const VRAM_SIG = SRC.match(/async function freeVramForTranscribe\(([^)]*)\) \{/);
if (!VRAM_SIG) throw new Error('app.js 里找不到 freeVramForTranscribe 的声明');
const VRAM_PARAMS = VRAM_SIG[1];
const VRAM_BODY = sliceBetween(VRAM_SIG[0], '\n/* ============================ 转写流程')
  .replace(/^async function freeVramForTranscribe\([^)]*\) \{/, '')
  .replace(/\}\s*$/, '');
const VRAM_CODE = `const VRAM_NEED_MB = 2500;\n\nasync function freeVramForTranscribe(${VRAM_PARAMS}) {\n${VRAM_BODY}\n}\n`;
const STOP_BRANCH = sliceBetween('    if (gpu && gpu.available && gpu.freeMB < VRAM_NEED_MB', '    } else if (gpu && gpu.available && gpu.freeMB < 2500) {');
// 转写结束后的「拉回来」：以前挂在 state.transcribeStoppedLLM 上，改造后变成每个任务
// 自己的 job.stoppedLLM（多项目并发时不能互相踩），所以按现在的写法找。
const RESTART_CODE = sliceBetween('    if (job.stoppedLLM) {', '\n  }\n}');
function sliceBetween(from, to) {
  const i = SRC.indexOf(from);
  if (i < 0) throw new Error(`app.js 里找不到起点：${from.slice(0, 50)}`);
  const j = SRC.indexOf(to, i);
  if (j < 0) throw new Error(`app.js 里找不到终点：${to.slice(0, 50)}`);
  return SRC.slice(i, j);
}

console.log('\n=== ⓪ 先从源码里把要测的三段抠出来 ===');
check('抠到了 freeVramForTranscribe 全文', VRAM_CODE.length > 400, `${VRAM_CODE.length} 字符`);
check('抠到了「该不该自动停」的判断分支', STOP_BRANCH.includes('freeVramForTranscribe'), STOP_BRANCH.slice(0, 80));
check('抠到了转写结束后的「拉回来」', RESTART_CODE.includes('ensureLocalLLM'), RESTART_CODE.slice(0, 80));

/* ======================= 迷你沙箱 ======================= */

/**
 * @param {{freeSeries:number[], running?:boolean, stopOk?:boolean, withGpu?:boolean}} opt
 *   freeSeries：每次调 /gpu 依次返回的空闲显存（MB），最后一个值会一直重复
 */
function makeSandbox(opt) {
  const calls = { api: [], progress: [], toast: [], ensure: 0 };
  let gpuIdx = 0;
  const freeSeries = opt.freeSeries;
  const api = async (p, o) => {
    calls.api.push({ p, body: o?.body });
    if (p === '/gpu') {
      if (opt.withGpu === false) return { available: false };
      const freeMB = freeSeries[Math.min(gpuIdx++, freeSeries.length - 1)];
      return { available: true, totalMB: 8151, freeMB, usedMB: 8151 - freeMB };
    }
    if (p === '/local-llm') return { ok: true, running: opt.running ?? true };
    return {};
  };
  const state = { transcribeStoppedLLM: false };
  // reportProgress 是 freeVramForTranscribe 现在写进度的入口（多项目并发改造后新增）。
  // 沙箱里给它一个假的，把调用记下来 —— 顺便验证「进度写的是这条录音的档案」。
  const reportProgress = (jobId, patch) => calls.progress.push({ jobId, ...patch });
  const sandbox = {
    api,
    state,
    reportProgress,
    progress: (show, label, pct) => calls.progress.push({ show, label, pct }),
    toast: (msg, kind, ms) => calls.toast.push({ msg, kind, ms }),
    ensureLocalLLM: async () => {
      calls.ensure++;
      return true;
    },
    console: { log: () => {} },
    Math,
    Promise,
    Number,
    setTimeout,
    clearTimeout,
  };
  vm.createContext(sandbox);
  // 把「转写结束 → 拉回大模型」那一段包成一个函数（代码原样搬，只多一层壳），
  // 这样测试可以 await 到 ensureLocalLLM 的结算，不会读到半截状态。
  // 注意：`^ {4}` 只对首行生效（tail 首行没带 \n）。末尾那个 `}` 是闭合最外层 if 的，**必须留着**；
  // 外壳 `async function __restartTail() {` 的 `}` 由模板自己在最后补。
  const tail = RESTART_CODE.replace(/^ {4}/, '').replace(/\n {4}/g, '\n');
  const code = `${VRAM_CODE}\nasync function __restartTail() {\n${tail}\nawait new Promise((r) => setTimeout(r, 0));\n}\n`;
  try {
    new vm.Script(code, { filename: 'app-vram-slice.js' }).runInContext(sandbox);
  } catch (e) {
    console.log('\n[沙箱代码编译失败，原文如下，方便定位]\n' + code.split('\n').map((l, i) => String(i + 1).padStart(3) + ' | ' + l).join('\n'));
    throw e;
  }
  sandbox.__restartTail = new vm.Script('__restartTail').runInContext(sandbox);
  return { sandbox, calls, state };
}

/* ======================= 场景 ======================= */

console.log('\n=== ① 显存不够 + 大模型在跑：自动停、等到腾够、返回 true ===');
{
  // 第一次读数 1.0GB，之后 5.9GB
  const { sandbox, calls } = makeSandbox({ freeSeries: [1024, 6045, 6045] });
  const freed = await sandbox.freeVramForTranscribe({ totalMB: 8151, freeMB: 1024 });
  check('返回 true（调用方据此决定写完要拉回来）', freed === true, String(freed));
  const stop = calls.api.find((c) => c.p === '/local-llm');
  check('真的发了 stop 指令', stop && stop.body?.action === 'stop', JSON.stringify(stop));
  check('stop 只发一次（不许连环杀）', calls.api.filter((c) => c.p === '/local-llm').length === 1);
  check('轮询 /gpu 至少两次（等显存释放）', calls.api.filter((c) => c.p === '/gpu').length >= 2);
  check('过程中说了「正在自动停止本地大模型」', calls.progress.some((x) => /自动停止本地大模型/.test(x.label || '')), JSON.stringify(calls.progress));
  check('腾好后报出了前后对比（1.0GB → 5.9GB）', calls.toast.some((t) => /1\.0GB.*5\.9GB/.test(t.msg)), JSON.stringify(calls.toast.map((t) => t.msg)));
}

console.log('\n=== ② 停了但显存还是不够：照样往下走，但必须说清楚 ===');
{
  const { sandbox, calls } = makeSandbox({ freeSeries: [900, 1100] }); // 一直涨不上去
  const freed = await sandbox.freeVramForTranscribe({ totalMB: 8151, freeMB: 900 });
  check('返回 false（没真腾够，不谎报）', freed === false, String(freed));
  check('轮询到达上限才放弃（30 次 × 500ms）', calls.api.filter((c) => c.p === '/gpu').length === 30, String(calls.api.filter((c) => c.p === '/gpu').length));
  check('明确警告可能退回 CPU 模式', calls.toast.some((t) => /可能退回 CPU/.test(t.msg)), JSON.stringify(calls.toast.map((t) => t.msg)));
  check('没有编造「已释放显存」这种好消息', !calls.toast.some((t) => /腾好了/.test(t.msg)));
}

console.log('\n=== ③ 一次就腾够：不磨蹭，早点返回 ===');
{
  const { sandbox, calls } = makeSandbox({ freeSeries: [6029, 6029] });
  const freed = await sandbox.freeVramForTranscribe({ totalMB: 8151, freeMB: 800 });
  check('返回 true', freed === true);
  check('只看了 1 次 /gpu 就收工', calls.api.filter((c) => c.p === '/gpu').length === 1, String(calls.api.filter((c) => c.p === '/gpu').length));
}

console.log('\n=== ④ /gpu 读不到时不许卡死 ===');
{
  const { sandbox, calls } = makeSandbox({ freeSeries: [500], withGpu: false });
  const t0 = Date.now();
  const freed = await sandbox.freeVramForTranscribe({ totalMB: 8151, freeMB: 500 });
  check('返回 false 而不是抛异常', freed === false);
  check('立刻退出，没有空转 15 秒', Date.now() - t0 < 3000, `${Date.now() - t0}ms`);
  check('还是发了 stop（能停就先停，不吃亏）', calls.api.some((c) => c.p === '/local-llm' && c.body?.action === 'stop'));
}

console.log('\n=== ⑤ /local-llm 接口挂了也不许把转写带崩 ===');
{
  const calls = { progress: [], toast: [] };
  const sandbox = {
    state: {},
    api: async (p) => {
      if (p === '/local-llm') throw new Error('服务没响应');
      return { available: true, totalMB: 8151, freeMB: 6045 };
    },
    // freeVramForTranscribe 现在通过 reportProgress 写进度（多项目并发改造后新增），
    // 沙箱里必须提供它，否则 ReferenceError 会被误当成「把异常抛出去了」。
    reportProgress: (jobId, patch) => calls.progress.push({ jobId, ...patch }),
    progress: (s, l, p) => calls.progress.push({ l, p }),
    toast: (m) => calls.toast.push(m),
    Math,
    Promise,
    Number,
    setTimeout,
    clearTimeout,
    console: { log: () => {} },
  };
  vm.createContext(sandbox);
  new vm.Script(VRAM_CODE, { filename: 'app-vram-slice.js' }).runInContext(sandbox);
  let threw = '';
  let freed = null;
  try {
    freed = await sandbox.freeVramForTranscribe({ totalMB: 8151, freeMB: 600 });
  } catch (e) {
    threw = e.message;
  }
  check('没有把异常抛出去（转写该继续继续）', threw === '', threw);
  check('停不掉也照常返回结果', freed === true || freed === false, String(freed));
}
console.log('\n=== ⑥ 判断分支：什么时候不该动它 ===');
{
  // 这段分支里有 await，vm.Script 不支持顶层 await，所以包一层 async 外壳。
  // 抠出来的片段是「从 if 开头切到 else-if 之前」，所以它自己带一个 `{` 没有对应的 `}`：
  // 外壳要补**两个** —— 一个收那个 if，一个收 async function（这里踩过坑，见文件末尾注释）。
  //
  // 这段代码后来改成了「多项目并发」版：不再是 state.transcribeStoppedLLM 一个全局开关，
  // 而是每个任务自己的 job.stoppedLLM —— 并发时互不干扰。所以要给它 id / job / endJob / confirm。
  const mkCtx = (extra) => ({
    id: 'test-job',
    job: {},
    endJob: () => {},
    confirm: () => true,
    VRAM_NEED_MB: 2500,
    ...extra,
  });
  const runBranch = async (ctx) => {
    vm.createContext(ctx);
    const code = `async function __b() {\n${STOP_BRANCH}\n}\n}\n__b()`;
    try {
      new vm.Script(code, { filename: 'branch.js' }).runInContext(ctx);
    } catch (e) {
      console.log('[分支代码编译失败]\n' + code.split('\n').map((l, i) => String(i + 1).padStart(3) + ' | ' + l).join('\n'));
      throw e;
    }
    await new Promise((r) => setTimeout(r, 0));
  };

  // 显存充足 → 不该自动停
  const ctx1 = mkCtx({ gpu: { available: true, freeMB: 6029 }, llm: { running: true }, freeVramForTranscribe: async () => true });
  await runBranch(ctx1);
  check('显存充足时不碰本地大模型', !ctx1.job.stoppedLLM);

  // 显存不够但大模型没跑 → 没有可停的，也不该发 stop
  let called = 0;
  const ctx2 = mkCtx({
    gpu: { available: true, freeMB: 1000 },
    llm: { running: false },
    freeVramForTranscribe: async () => {
      called++;
      return true;
    },
  });
  await runBranch(ctx2);
  check('大模型没在跑时不做无用的 stop', called === 0, `被调用 ${called} 次`);

  // 显存不够 + 大模型在跑 → 必须自动腾，并且记在**这个任务**的档案上
  const ctx3 = mkCtx({
    gpu: { available: true, freeMB: 1024 },
    llm: { running: true },
    freeVramForTranscribe: async () => true,
  });
  await runBranch(ctx3);
  check('显存不够且大模型在跑 → 标记「这次是人家停的」（记在任务档案上）', ctx3.job.stoppedLLM === true, JSON.stringify(ctx3.job));

  // /gpu 读不到（available:false）→ 不该去停
  let called4 = 0;
  const ctx4 = mkCtx({
    gpu: { available: false },
    llm: { running: true },
    freeVramForTranscribe: async () => {
      called4++;
      return true;
    },
  });
  await runBranch(ctx4);
  check('读不到显存读数时不乱停大模型', called4 === 0, `被调用 ${called4} 次`);
}

console.log('\n=== ⑦ 转写结束后把大模型拉回来 ===');
{
  // 「是不是我停的」现在记在 job 上，不再是 state 上的全局布尔。
  const { sandbox, calls } = makeSandbox({ freeSeries: [6045] });
  sandbox.job = { stoppedLLM: true };
  await sandbox.__restartTail();
  check('调了 ensureLocalLLM', calls.ensure === 1, String(calls.ensure));
  check('告诉老大「已恢复运行」', calls.toast.some((t) => /自动恢复/.test(t.msg)), JSON.stringify(calls.toast.map((t) => t.msg)));

  const b = makeSandbox({ freeSeries: [6045] });
  b.sandbox.job = { stoppedLLM: false };
  await b.sandbox.__restartTail();
  check('不是人家停的 → 不去乱拉大模型', b.calls.ensure === 0, String(b.calls.ensure));
}

console.log('\n' + '='.repeat(70));
console.log(fail === 0 ? `全部通过（${pass} 项）` : `${fail} 项失败 / ${pass} 项通过`);
console.log('='.repeat(70));
process.exitCode = fail === 0 ? 0 : 1;
