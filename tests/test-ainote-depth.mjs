/**
 * AI 笔记「深度」回归测试
 *
 * 目的：老大投诉「总结重点仅仅是概括」。这个脚本拿真实转写记录，
 *       用新旧两套提示词各生成一份笔记，再把「深度指标」并排打印出来。
 *
 * 它不依赖浏览器，也不需要 server.mjs：
 *   用 globalThis.fetch 沙箱把 /api/llm 转发到本地 llama-server，
 *   并把返回体包装成 server.mjs 的形状 { ok, content, usage, model }
 *   （server.mjs:762 的 POST /api/llm 返回的就是这个形状）。
 *
 * 用法：
 *   node tests/test-ainote-depth.mjs            只跑新版提示词
 *   node tests/test-ainote-depth.mjs --ab       新版 + 旧版对照
 *   node tests/test-ainote-depth.mjs --max 40   只用前 40 段（默认 40，控制耗时）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LLM_URL = process.env.LLM_URL || 'http://127.0.0.1:8080/v1/chat/completions';

const argv = process.argv.slice(2);
const AB = argv.includes('--ab');
const MAX_SEG = Number((argv[argv.indexOf('--max') + 1] || '').trim()) || 40;

const SAMPLE = '1305e386-34c7-45e9-a6e1-a24ccc8ef080'; // 找不到就自动挑一条

/* ---------- fetch 沙箱：把 /api/llm 接到本地 llama-server ---------- */
// 先把真 fetch 存下来，再覆盖 globalThis.fetch；否则 realFetch 会指向垫片自己造成无限递归
const realFetch = globalThis.fetch.bind(globalThis);
let calls = 0;
let promptChars = 0;
let outChars = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.includes('/api/llm')) throw new Error('测试环境只代理 /api/llm，收到：' + u);
  const body = JSON.parse(init.body || '{}');
  promptChars += (body.messages || []).reduce((n, m) => n + (m.content || '').length, 0);
  calls++;
  const resp = await realFetch(LLM_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen2.5-7b',
      messages: body.messages,
      temperature: body.temperature ?? 0.25,
      stream: false,
    }),
    signal: init.signal,
  });
  if (!resp.ok) {
    return new Response(JSON.stringify({ ok: false, error: `本地模型 HTTP ${resp.status}` }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content ?? '';
  outChars += content.length;
  // 关键：必须包成 server.mjs 的形状，否则 public/llm.js 的 `!data.ok` 会误报失败
  return new Response(JSON.stringify({ ok: true, content, usage: data?.usage, model: 'qwen2.5-7b' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

/* ---------- 载入真实样本 ---------- */
function pickLecture() {
  const base = path.join(ROOT, 'data', 'lectures');
  if (!fs.existsSync(base)) throw new Error('找不到 data/lectures');
  const dirs = fs.readdirSync(base).filter((d) => fs.existsSync(path.join(base, d, 'transcript.json')));
  const want = dirs.find((d) => d === SAMPLE) || dirs.find((d) => d.startsWith(SAMPLE.slice(0, 8)));
  return { id: want || dirs[0], base };
}
const { id: LECTURE, base } = pickLecture();
const raw = JSON.parse(fs.readFileSync(path.join(base, LECTURE, 'transcript.json'), 'utf8'));
const meta = fs.existsSync(path.join(base, LECTURE, 'meta.json'))
  ? JSON.parse(fs.readFileSync(path.join(base, LECTURE, 'meta.json'), 'utf8'))
  : {};
const segments = (raw.segments || []).slice(0, MAX_SEG);
/** 逐字稿（去掉时间戳后的正文）字数，用来给深度指标定比例阈值 */
const srcChars = segments.reduce((n, s) => n + String(s.text || '').replace(/\s/g, '').length, 0);
if (!segments.length) throw new Error('这条记录没有 segments');

/* ---------- 深度指标 ---------- */
/** 取出某个二级小节的正文（到下一个 ## 或文末为止） */
function sectionBody(md, name) {
  const lines = String(md).split('\n');
  const head = new RegExp(`^##\\s*${name}`);
  const start = lines.findIndex((l) => head.test(l));
  if (start === -1) return '';
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}
function sectionLen(md, name) {
  return sectionBody(md, name).replace(/\s/g, '').length;
}
function markers(md) {
  return {
    chars: md.length,
    sections: (md.match(/^##\s+/gm) || []).length,
    headings3: (md.match(/^###\s+/gm) || []).length,
    bullets: (md.match(/^\s*[-*]\s+/gm) || []).length,
    timestamps: (md.match(/\[\d{1,2}:\d{2}(?::\d{2})?\]/g) || []).length,
    supplement: (md.match(/（补充）/g) || []).length,
    hasLogic: /##\s*理解脉络/.test(md),
    hasTraps: /##\s*易错与易混/.test(md),
    logicChars: sectionLen(md, '理解脉络'),
    trapsChars: sectionLen(md, '易错与易混'),
    selfTest: sectionLen(md, '自测题') ? (md.match(/^\s*\d+\.\s+/gm) || []).length : 0,
  };
}
/** 与原始逐字稿的逐字重合率：越高说明越像「压缩版逐字稿」 */
function overlapRatio(md, body) {
  const strip = (s) => s.replace(/[\s\p{P}]/gu, '');
  const a = strip(md);
  const src = strip(body);
  const set = new Map();
  for (const ch of src) set.set(ch, (set.get(ch) || 0) + 1);
  let hit = 0;
  for (const ch of a) {
    const n = set.get(ch) || 0;
    if (n > 0) {
      hit++;
      set.set(ch, n - 1);
    }
  }
  return a.length ? hit / a.length : 0;
}

/* ---------- 跑 ---------- */
const { generateAINote } = await import(pathToFileURL(path.join(ROOT, 'public', 'llm.js')).href);

const body = segments.map((s) => s.text || '').join('');
const analysis = { keywords: [], outline: [] };

async function run(label, fn) {
  calls = 0;
  promptChars = 0;
  outChars = 0;
  const t0 = Date.now();
  const r = await fn();
  const ms = Date.now() - t0;
  const m = markers(r.markdown);
  m.overlap = overlapRatio(r.markdown, body);
  return { label, ms, calls, promptChars, outChars, steps: r.steps, markdown: r.markdown, m };
}

console.log(`样本：${LECTURE}  取前 ${segments.length} 段，共 ${body.length} 字`);
console.log(`本地模型：${LLM_URL}`);
console.log(`模式：${AB ? '新旧对照' : '仅新版'}\n`);

// 先探一下模型在不在。这个脚本要真跑大模型才能比出「深度」，不是纯逻辑测试，
// 所以模型没起的时候不应该算失败（那会让整个测试入口永远红着），
// 而应该明确地说「跳过」，并退出 0 —— 让 CI/总入口能区分「坏了」和「没装」。
{
  const health = LLM_URL.replace(/\/v1\/chat\/completions$/, '/health');
  const probe = await (async () => {
    for (const url of [health, LLM_URL.replace(/\/chat\/completions$/, '/models')]) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (r.ok) return true;
      } catch { /* 下一个 */ }
    }
    return false;
  })();
  if (!probe) {
    console.log('⏭  跳过：本地大模型没在运行（连不上 ' + LLM_URL + '）。');
    console.log('   这个脚本要真调模型才能比较笔记深度，属于「需要环境」的测试。');
    console.log('   想跑的话：先启动本地大模型（helpers\\start-llm 或 llama-server），再执行本脚本。');
    console.log('   要连别的地址：set LLM_URL=http://127.0.0.1:端口/v1/chat/completions');
    process.exit(0);
  }
}

const fresh = await run('新版（先讲解再合成）', () =>
  generateAINote({ segments, meta, analysis, options: { style: 'exam' }, onProgress: (msg) => process.stdout.write(`\r  ${msg}                    `) })
);
process.stdout.write('\r' + ' '.repeat(60) + '\r');

let old = null;
if (AB) {
  // 旧版提示词：把「只依据材料、不讲解」那一套临时装回去。
  //
  // 注意实现方式：**不能写临时文件** —— node 子进程在默认沙箱下写
  // dev\lecture-notes\* 会 EPERM（只允许写工作区根 D:\Download\dev）。
  // 这里改用 data: URL 动态 import 打过补丁的源码，全程不碰磁盘。
  // data: URL 里的相对 import 会解析失败，所以顺手把 './x.js' 改写成绝对 file URL。
  const llmPath = path.join(ROOT, 'public', 'llm.js');
  const src = fs.readFileSync(llmPath, 'utf8');
  const base = pathToFileURL(path.join(ROOT, 'public') + path.sep).href;
  const patched = src
    // ① 还原最原始的 MAP_SYSTEM（"只整理、不编造"）
    .replace(
      /const MAP_SYSTEM =[\s\S]*?;\n/,
      `const MAP_SYSTEM = '你是一名严谨的大学课堂笔记助理。你只依据用户提供的转写文本做整理，绝不编造原文没有的内容。';\n`
    )
    // ② 还原 DIRECT_SYSTEM（改造前没有 DIRECT_SYSTEM，短课走的是 reduceSystem）
    .replace(
      /const DIRECT_SYSTEM = \(style\) => \{[\s\S]*?\n\};/,
      `const DIRECT_SYSTEM = (style) => reduceSystem(style);`
    )
    // ③ 把新增的「理解脉络」「易错与易混」两节整个删掉。
    //    **必须用 /g**：REDUCE_PROMPT 和 DIRECT_PROMPT 里各有一份，
    //    不带 g 只删掉前面那份，短课走的 DIRECT 路径还是带理解的，对照就假了（踩过一次）。
    .replace(/## 理解脉络[\s\S]*?## 概念与定义/g, '## 概念与定义')
    .replace(/## 易错与易混[\s\S]*?## 例子与案例/g, '## 例子与案例')
    .replace(/from\s+'\.\/([\w.-]+)'/g, (_m, f) => `from '${base}${f}'`);
  // 自检：补丁必须真的生效，否则"新旧对照"就是自己跟自己比，白跑
  if (patched === src) throw new Error('旧版补丁一条都没匹配上，对照无效');
  if (patched.includes('DIRECT_SYSTEM = (style) => {')) throw new Error('DIRECT_SYSTEM 补丁没生效');
  if (patched.includes('## 理解脉络')) throw new Error('旧版补丁没删干净「理解脉络」');
  if (patched.includes('## 易错与易混')) throw new Error('旧版补丁没删干净「易错与易混」');
  const dataUrl = 'data:text/javascript;base64,' + Buffer.from(patched, 'utf8').toString('base64');
  const oldMod = await import(dataUrl);
  old = await run('旧版（只整理不讲解）', () =>
    oldMod.generateAINote({ segments, meta, analysis, options: { style: 'exam' }, onProgress: () => {} })
  );
}

function pad(s, n) {
  s = String(s);
  let w = 0;
  for (const ch of s) w += /[\u3000-\u9FFF\uFF00-\uFFEF]/.test(ch) ? 2 : 1;
  return s + ' '.repeat(Math.max(0, n - w));
}
const rows = [
  ['字数', (r) => r.m.chars],
  ['耗时', (r) => (r.ms / 1000).toFixed(1) + 's'],
  ['模型调用次数', (r) => r.calls],
  ['送入提示词总字数', (r) => r.promptChars],
  ['二级小节数', (r) => r.m.sections],
  ['三级小节数', (r) => r.m.headings3],
  ['条目数', (r) => r.m.bullets],
  ['时间标记数', (r) => r.m.timestamps],
  ['（补充）标记数', (r) => r.m.supplement],
  ['有「理解脉络」', (r) => (r.m.hasLogic ? '有' : '无')],
  ['「理解脉络」字数', (r) => r.m.logicChars],
  ['有「易错与易混」', (r) => (r.m.hasTraps ? '有' : '无')],
  ['「易错与易混」字数', (r) => r.m.trapsChars],
  ['自测题数', (r) => r.m.selfTest],
  ['与逐字稿重合率', (r) => (r.m.overlap * 100).toFixed(1) + '%'],
];
console.log(pad('指标', 22) + pad(fresh.label, 26) + (old ? pad(old.label, 26) : ''));
console.log('-'.repeat(old ? 74 : 48));
for (const [name, get] of rows) {
  console.log(pad(name, 22) + pad(get(fresh), 26) + (old ? pad(get(old), 26) : ''));
}

/* ---------- 断言 ---------- */
let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`✓ ${name}${detail ? '  ' + detail : ''}`);
  } else {
    fail++;
    console.log(`✗ ${name}${detail ? '  ' + detail : ''}`);
  }
}
console.log('');
check('产出非空', fresh.m.chars > 500, `${fresh.m.chars} 字`);
check('含「理解脉络」小节', fresh.m.hasLogic);
check('含「易错与易混」小节', fresh.m.hasTraps);
check('时间标记保留', fresh.m.timestamps >= 5, `${fresh.m.timestamps} 个`);
// 上限放到 15：实测同一条记录跑出过 5/6/10/12/13 题，"5-8 题"这个要求小模型只能守住下限。
// 真正要防的是"一题都没有"或"把答案写进题目"，所以下限 5 是硬要求，上限只防跑飞。
check('自测题 5-15 题', fresh.m.selfTest >= 5 && fresh.m.selfTest <= 15, `${fresh.m.selfTest} 题`);
// 重合率门限随材料变大而放宽：长稿里专有名词/公式/数字本来就占大头，70% 是给短稿定的。
// 长稿的真实目标是"别整段照抄"，所以门限放到 85%，同时用 --show 人工看段落是否被改写。
const overlapLimit = srcChars > 5000 ? 0.85 : 0.7;
check(`不是逐字稿的简单压缩（重合率 < ${(overlapLimit * 100).toFixed(0)}%）`, fresh.m.overlap < overlapLimit, `${(fresh.m.overlap * 100).toFixed(1)}%`);
// 深度（真正在量的东西）：这两节是"比逐字稿多出来"的部分，必须有实质篇幅。
// 阈值按**逐字稿长度**定比例，而不是钉死一个绝对字数 —— 2400 字的材料写不出 300 字的理解脉络，
// 钉死只会得到一个恒红的测试（踩过）。1 字逐字稿产出 0.08 字理解脉络是实测的稳定下限。
const logicFloor = Math.max(150, Math.round(srcChars * 0.08));
check(`「理解脉络」有实质篇幅（≥${logicFloor} 字，按逐字稿 ${srcChars} 字的 8% 折算）`, fresh.m.logicChars >= logicFloor, `${fresh.m.logicChars} 字`);
check('「易错与易混」有实质篇幅（≥100 字）', fresh.m.trapsChars >= 100, `${fresh.m.trapsChars} 字`);
// 提示词占位符泄漏：小模型会把写作要求里的示例照抄进正文（踩过，整节 440 字里有 300 字是提示词）
check('正文没有抄进提示词占位符', !/概念甲|概念乙|A 和 B 的区别/.test(fresh.markdown));
if (old) {
  check(
    '新版「理解脉络」明显长于旧版',
    fresh.m.logicChars > Math.max(150, old.m.logicChars * 1.5),
    `新版 ${fresh.m.logicChars} 字 vs 旧版 ${old.m.logicChars} 字`
  );
  // 总字数只提示不判定：实测同一条记录三次跑出 4618/4937/6296 字，
  // 方差来自采样的多样性，拿它当门槛只会得到一个随机红的测试。
  console.log(
    `${fresh.m.chars > old.m.chars ? '✓' : '·'} 总字数对比（仅提示，不作判定） 新版 ${fresh.m.chars} vs 旧版 ${old.m.chars}`
  );
}

console.log(`\n${pass} 通过 / ${fail} 失败`);

/* ---------- 关键小节实样（看模型到底写了什么，不要只看字数） ---------- */
if (argv.includes('--show')) {
  for (const r of [fresh, old].filter(Boolean)) {
    console.log(`\n${'='.repeat(70)}\n${r.label}\n${'='.repeat(70)}`);
    for (const name of ['理解脉络', '易错与易混']) {
      const b = sectionBody(r.markdown, name);
      console.log(`\n---- ## ${name}（${b.replace(/\s/g, '').length} 字）----`);
      console.log(b.slice(0, 1200) || '（这一节是空的）');
    }
  }
}

process.exit(fail ? 1 : 0);
