/**
 * 提示词前缀实验台
 *
 * 动机：probe-note-scaling.mjs 测出「理解脉络」的字数与材料长度无关（六档材料上都是 191~221 字），
 *       而提示词里写的是「正文不少于 300 字」。指令被无视 → 需要试几种更硬的写法，用数字挑出有效的那个。
 *       实测结论：三种更硬的写法里最好的一种只把 248 字提到 297 字（+20%），
 *       真正的瓶颈是模型在小节级写作上有「写不长」的天花板，不是提示词措辞。
 *
 * 做法：读 public/llm.js 源码 → 在提示词模板最前面插一段「前言」→ 用 data: URL 动态 import。
 *       **不写临时文件**：node 子进程在默认沙箱下写 dev\lecture-notes\* 会 EPERM。
 *       data: URL 里的相对 import 会失败，所以把 './x.js' 改写成绝对 file URL。
 *
 * 用法：
 *   node tests/probe-prompt-variants.mjs 60 base short guide strict
 *   node tests/probe-prompt-variants.mjs 60 base short --show
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { markers, overlapRatio, sectionBody } from './note-metrics.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LLM_URL = process.env.LLM_URL || 'http://127.0.0.1:8080/v1/chat/completions';

const argv = process.argv.slice(2);
const SHOW = argv.includes('--show');
const nums = argv.filter((a) => /^\d+$/.test(a));
const MAX_SEG = nums.length ? Number(nums[0]) : 60;
const VARIANTS = argv.filter((a) => !/^\d+$/.test(a) && !a.startsWith('--'));

/* ------------------------------------------------------------------ *
 * 变体定义：前言会被插到 REDUCE_PROMPT / DIRECT_PROMPT 的模板最前面。
 * 每段都必须是「给模型的指令」，且**不能用圆括号**写说明 ——
 * 小模型会把圆括号里的要求当正文抄出来（这个教训已经付过学费了）。
 * ------------------------------------------------------------------ */
const PREFIXES = {
  base: '',
  // 变体 1：把字数要求前置，并给一个自检动作
  short: [
    '写作前先记住三条硬指标：',
    '- 「理解脉络」的正文不得少于 300 字，写成 2-4 段连贯文字。',
    '- 「易错与易混」的正文不得少于 100 字，写成 3-6 条完整句子。',
    '- 写完这两节后，自己数字数；如果不够，就继续写，直到够为止。绝对不许用"以下省略"或空白糊弄。',
    '',
  ].join('\n'),
  // 变体 2：把「理解脉络」抬成整篇的主要交付物
  guide: [
    '这份笔记最重要的部分是「理解脉络」这一节。',
    '老师说过的话是次要的；真正值钱的是把知识串成一条因果链：要解决什么问题、前人的做法卡在哪里、这节课怎么绕过去、概念与概念之间是什么关系。',
    '「理解脉络」要占全篇正文的五分之一以上，写成 3-4 段连贯文字，每一段都要有明确的因果关系。',
    '如果这一节只有干巴巴几句话，整份笔记就算不合格。',
    '',
  ].join('\n'),
  // 变体 3：字数下限写死 + 反敷衍
  strict: [
    '硬性字数要求：',
    '「理解脉络」正文至少 500 字，「易错与易混」正文至少 150 字，两个小节都不许空着。',
    '不许用"本段主要讲了…"这类空话凑字数；每句话都要给出具体知识内容。',
    '如果材料不足以支撑这个篇幅，就把材料里出现过的每一个知识点都摊开讲清楚，而不是少写。',
    '',
  ].join('\n'),
};

/* ---------- fetch 垫片 ---------- */
// 必须先存下真 fetch 再覆盖，否则 realFetch 会指向垫片自己 → 无限递归
const realFetch = globalThis.fetch.bind(globalThis);
let calls = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.includes('/api/llm')) throw new Error('测试环境只代理 /api/llm，收到：' + u);
  const body = JSON.parse(init.body || '{}');
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
  // 关键：必须包成 server.mjs 的形状，否则 public/llm.js 检查 data.ok 时会误报失败
  return new Response(
    JSON.stringify({ ok: true, content: data?.choices?.[0]?.message?.content ?? '', usage: data?.usage, model: 'qwen2.5-7b' }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
};

/* ---------- 生成打过补丁的模块 ---------- */
const llmPath = path.join(ROOT, 'public', 'llm.js');
const src = fs.readFileSync(llmPath, 'utf8');

/**
 * 把前言插到提示词模板里。
 * 落点：REDUCE_PROMPT 与 DIRECT_PROMPT 两个模板的开头。
 * 这两个都是箭头函数（const X = (args) => 反引号模板），不是 function 声明 ——
 * 第一版正则按 function 写，直接报「找不到 REDUCE_PROMPT 的模板起点」。
 * 两处都要补，否则短课走的 DIRECT 分支拿不到前言。
 */
function patchedUrl(prefix) {
  if (!prefix) return pathToFileURL(llmPath).href;
  let out = src;
  let n = 0;
  for (const name of ['REDUCE_PROMPT', 'DIRECT_PROMPT']) {
    const re = new RegExp(`(const\\s+${name}\\s*=\\s*\\([\\s\\S]*?\\)\\s*=>\\s*\`)([\\s\\S]*?)(\`;)`);
    if (!re.test(out)) throw new Error(`找不到 ${name} 的模板起点，补丁无效`);
    out = out.replace(re, (m, head, body, tail) => {
      n++;
      return head + prefix + body + tail;
    });
  }
  if (n < 2) throw new Error(`只补到 ${n} 个模板，对照无效`);
  // data: URL 里相对 import 会解析失败 → 改写成绝对 file URL
  out = out.replace(/from\s+'\.\/([\w.-]+)'/g, (m, f) => `from '${pathToFileURL(path.join(ROOT, 'public', f)).href}'`);
  return 'data:text/javascript;base64,' + Buffer.from(out, 'utf8').toString('base64');
}

/* ---------- 载入样本 ---------- */
const lecturesDir = path.join(ROOT, 'data', 'lectures');
const dirs = fs
  .readdirSync(lecturesDir)
  .filter((d) => fs.existsSync(path.join(lecturesDir, d, 'transcript.json')));
const LECTURE = dirs.find((d) => d.startsWith('1305e386')) || dirs[0];
const raw = JSON.parse(fs.readFileSync(path.join(lecturesDir, LECTURE, 'transcript.json'), 'utf8'));
const metaPath = path.join(lecturesDir, LECTURE, 'meta.json');
const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};
const segments = (raw.segments || []).slice(0, MAX_SEG);
const body = segments.map((s) => s.text || '').join('');
const srcChars = body.replace(/\s/g, '').length;

const wanted = VARIANTS.length ? VARIANTS : Object.keys(PREFIXES);
for (const v of wanted) if (!(v in PREFIXES)) throw new Error(`未知变体：${v}（可选：${Object.keys(PREFIXES).join(' / ')}）`);

console.log(`记录：${LECTURE}  取前 ${segments.length} 段，逐字稿 ${srcChars} 字（不超过 14000 就走 DIRECT 单趟）`);
console.log(`变体：${wanted.join(' / ')}\n`);

const rows = [];
for (const v of wanted) {
  const mod = await import(patchedUrl(PREFIXES[v]));
  calls = 0;
  const t0 = Date.now();
  const r = await mod.generateAINote({
    segments,
    meta,
    analysis: { keywords: [], outline: [] },
    options: { style: 'exam' },
    onProgress: () => {},
  });
  const ms = Date.now() - t0;
  const m = markers(r.markdown);
  const ov = overlapRatio(r.markdown, body);
  rows.push({ v, ...m, overlap: ov, calls, ms, markdown: r.markdown });
  console.log(
    v.padEnd(8) +
      '笔记 ' + String(m.chars).padStart(6) +
      ' | 理解脉络 ' + String(m.logicChars).padStart(5) +
      ' | 易错易混 ' + String(m.trapsChars).padStart(4) +
      ' | 重合率 ' + `${(ov * 100).toFixed(1)}%`.padStart(6) +
      ' | 自测 ' + String(m.selfTest).padStart(2) +
      ' | 调用 ' + calls + ' | ' + `${(ms / 1000).toFixed(1)}s`
  );
}

console.log('\n变体对比（理解脉络字数 / 占全篇比例）：');
for (const r of rows) {
  const ratio = r.chars ? ((r.logicChars / r.chars) * 100).toFixed(1) : '0.0';
  console.log(`  ${r.v.padEnd(8)} ${String(r.logicChars).padStart(4)} 字   ${ratio}%   易错易混 ${r.trapsChars} 字`);
}
const best = rows.slice().sort((a, b) => b.logicChars - a.logicChars)[0];
console.log(`\n最长「理解脉络」：${best.v}（${best.logicChars} 字）`);
console.log('提醒：改提示词措辞对此项收益有限，别指望靠"再写狠一点"突破 —— 实测多轮，收益都在 5% 以内');

if (SHOW) {
  for (const r of rows) {
    console.log(`\n=========== ${r.v} 的「理解脉络」 ===========`);
    console.log(sectionBody(r.markdown, '理解脉络') || '(空)');
  }
}
