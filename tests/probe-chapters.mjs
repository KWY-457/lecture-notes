/**
 * 章节质量探针：拿一条真实录音跑一遍 AI 笔记，只看「课堂脉络与重点」这一节。
 *
 * 动机：老大拿手机 App「听脑」的截图做对比，人家的章节标题是
 * 「乐观精神与诚信之星杨女士的励志故事」这种书面语概括，我们的是
 * 「获得 · 务实」「相继重病 · 课这上说了突」这种词频碎片，而且 9 分钟的课切了 26 章。
 *
 * 这个脚本**不写回应用**（不 PUT），只打印结果，方便反复调提示词。
 *
 * 运行：
 *   node tests/probe-chapters.mjs                        # 自动探测服务地址，用第一条已转写的录音
 *   node tests/probe-chapters.mjs http://127.0.0.1:25994 <id>
 */
import fs from 'node:fs';
import path from 'node:path';
import { generateAINote } from '../public/llm.js';
import { analyze } from '../public/summarize.js';

// 服务地址自动探测：启动器会把实际端口写进 data/runtime.json。
// 以前这里写死 8788，随机端口一上线就变成 ECONNREFUSED。
function defaultBase() {
  try {
    const rt = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'data', 'runtime.json'), 'utf8'));
    if (rt.port) return `http://127.0.0.1:${rt.port}`;
  } catch { /* 没在跑 */ }
  return 'http://127.0.0.1:8788';
}
const BASE = (process.argv[2] || defaultBase()).replace(/\/+$/, '');
const targetId = process.argv[3] || '';

const realFetch = globalThis.fetch;
globalThis.fetch = (u, o) => realFetch(String(u).startsWith('/') ? BASE + u : u, o);

const j = async (p) => {
  const r = await realFetch(BASE + p);
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.ok === false) throw new Error(`${p} -> ${d.error || r.status}`);
  return d;
};

let id = targetId;
if (!id) {
  const list = await j('/api/lectures');
  const cand = list.lectures.find((l) => l.status === 'transcribed') || list.lectures[0];
  if (!cand) throw new Error('没有已转写的录音');
  id = cand.id;
}
const { lecture: L, transcript } = await j('/api/lectures/' + id);
const segments = transcript.segments || [];
if (!segments.length) throw new Error('这条录音还没有逐字稿');

const chars = segments.reduce((n, s) => n + s.text.length, 0);
const hasTime = segments.some((s) => Number(s.end) > Number(s.start) || Number(s.start) > 0);
console.log(`录音: ${L.title}  ${segments.length} 段 / ${chars} 字 / 有时间戳=${hasTime}`);

const analysis = analyze({
  segments,
  meta: { title: L.title, course: L.course, duration: L.duration, createdAt: L.createdAt },
  options: { style: 'exam', maxPointsPerTopic: 6, topKeywords: 20 },
});
console.log(`离线切分: ${analysis.outline.length} 个主题（这数字就是模型容易照抄的那个数）`);
console.log(`离线标题样例: ${analysis.outline.slice(0, 5).map((t) => t.heading).join(' ｜ ')}`);

console.log('\n调用大模型…');
const t0 = Date.now();
// 自己套一层超时：服务端 llm.timeoutMs 默认 420 秒，而 run-all 给单个脚本的上限是
// 180 秒（tests/run-all.mjs 的 TIMEOUT_MS）。大模型挂住不返回时，这个探针根本走不到
// 下面的跳过分支，就先被 SIGKILL 判成「失败」了 —— 2026-10-26 全量测试里就是这样误红
// 了一次（180.0s 正正好等于上限）。探针的目的只是看章节质量，等 90 秒没动静就该让位。
const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 90000);
const probeAc = new AbortController();
let probeTimer = null;
const probeTimeout = new Promise((_, reject) => {
  probeTimer = setTimeout(() => {
    const e = new Error(`探针等了 ${Math.round(PROBE_TIMEOUT_MS / 1000)} 秒没等到大模型返回，主动放弃（ETIMEDOUT）`);
    e.code = 'PROBE_TIMEOUT';
    // 光靠 Promise.race 放弃等待是不够的 —— 底层那次 fetch 还在跑，
    // 事件循环被它挂着，进程根本不会退（实测还是卡满 90 秒才走）。
    // 必须真的 abort，让 generateAINote 内部抛错、连接断掉。
    try { probeAc.abort(); } catch {}
    reject(e);
  }, PROBE_TIMEOUT_MS);
});
// 这一步要真花钱、要真 Key。没配 Key 或 Key 失效的时候不该算「产品坏了」，
// 而是明确跳过 —— 这个脚本是调提示词用的探针，不是回归测试。
let out;
try {
  out = await Promise.race([
    generateAINote({
      segments,
      meta: { title: L.title, course: L.course, duration: L.duration, createdAt: L.createdAt },
      analysis,
      options: { style: 'exam', extraPrompt: '' },
      signal: probeAc.signal,
      onProgress: (m) => {
        if (process.env.VERBOSE) console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
      },
    }),
    probeTimeout,
  ]);
} catch (e) {
  const msg = String(e && e.message || e);
  // 两种情况都算「环境没准备好」，不算产品坏了：
  //   1. Key 缺失/失效（401/403/Token invalid）
  //   2. 大模型根本没起（ECONNREFUSED）
  if (/401|403|invalid|unauthor|Token|apiKey|API key|没有.*Key|未配置|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed/i.test(msg)) {
    console.log(`\n⏭  跳过：大模型调不通（${msg.slice(0, 140)}）。`);
    console.log('   这个脚本要真调大模型才能看章节质量，属于「需要环境」的探针。');
    console.log('   想跑的话：先在界面「设置」里配好大模型（或启动本地大模型），再执行本脚本。');
    process.exit(0);
  }
  throw e;
}
// 成功了就把护栏撤掉，否则那个 setTimeout 会让进程多活 90 秒才退。
clearTimeout(probeTimer);
console.log(`完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒，${out.markdown.length} 字符\n`);

const md = out.markdown;
const start = md.indexOf('## 课堂脉络与重点');
// 注意：必须从 start 之后开始找下一个二级标题，否则会命中前面的「## 一句话概要」
const next = start === -1 ? -1 : md.indexOf('\n## ', start + 5);
const section = start === -1 ? '（没有这一节）' : md.slice(start, next === -1 ? undefined : next);

const heads = [...section.matchAll(/^###\s+(.*)$/gm)].map((m) => m[1]);
console.log(`章节数: ${heads.length}`);
for (const h of heads) console.log('  · ' + h);

// 碎片判定：形如「甲 · 乙」且两侧都很短，是机器拼词而不是人写的标题
const frag = heads.filter((h) => /^.{1,7}\s*·\s*.{1,7}$/.test(h.replace(/^\d+\.\s*/, '').replace(/\s*\[[^\]]*\]\s*$/, '')));
console.log(`\n疑似词频碎片标题: ${frag.length} 个${frag.length ? ' → ' + frag.join(' ｜ ') : ''}`);

console.log('\n──────── 课堂脉络与重点 全文 ────────');
console.log(section);
