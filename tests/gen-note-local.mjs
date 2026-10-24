/**
 * 用「本地模型」给某条录音重新生成 AI 笔记，并统计耗时。
 *
 * 走的是应用自己的 /api/llm 代理 —— 跟界面里点「AI 润色」完全同一条路径，
 * 所以这个脚本跑出来的速度就是你实际使用时的速度。
 *
 * 运行： node tests/gen-note-local.mjs [appBase] [lectureId]
 */
import { generateAINote } from '../public/llm.js';
import { analyze } from '../public/summarize.js';

const BASE = (process.argv[2] || 'http://127.0.0.1:8788').replace(/\/+$/, '');
let targetId = process.argv[3] || '';

const realFetch = globalThis.fetch;
globalThis.fetch = (u, o) => realFetch(String(u).startsWith('/') ? BASE + u : u, o);

const j = async (p, opts = {}) => {
  const r = await realFetch(BASE + p, {
    ...opts,
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.ok === false) throw new Error(`${p} -> ${d.error || r.status}`);
  return d;
};

console.log(`目标应用: ${BASE}`);

/* 1. 挑一条有逐字稿的录音 */
const list = await j('/api/lectures');
if (!targetId) {
  const cand = list.lectures.find((l) => l.status === 'transcribed') || list.lectures[0];
  if (!cand) throw new Error('没有可用的录音，先跑 tests/seed-demo.mjs');
  targetId = cand.id;
}
const detail = await j('/api/lectures/' + targetId);
const L = detail.lecture;
const segments = detail.transcript.segments || [];
if (!segments.length) throw new Error('这条录音还没有逐字稿');
const chars = segments.reduce((n, s) => n + s.text.length, 0);
console.log(`录音: ${L.title}  (${segments.length} 段 / ${chars} 字)`);

/* 2. 先跑离线引擎（提供关键词与主题骨架） */
const tOff = Date.now();
const analysis = analyze({
  segments,
  meta: { title: L.title, course: L.course, duration: L.duration },
  options: { style: 'exam', maxPointsPerTopic: 6, topKeywords: 20 },
});
const offMs = Date.now() - tOff;
console.log(`离线引擎: ${offMs} ms，切出 ${analysis.outline.length} 个主题、${analysis.keywords.length} 个关键词`);

/* 3. 调用本地模型生成笔记（经应用的 /api/llm 代理） */
console.log('\n开始调用大模型…');
const t0 = Date.now();
let lastMsg = '';
const out = await generateAINote({
  segments,
  meta: { title: L.title, course: L.course, duration: L.duration, createdAt: L.createdAt },
  analysis,
  options: { style: 'exam', extraPrompt: '' },
  onProgress: (m) => {
    if (m !== lastMsg) {
      lastMsg = m;
      console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
    }
  },
});
const llmMs = Date.now() - t0;
const outChars = out.markdown.replace(/\s/g, '').length;

console.log(`\n模型调用: ${(llmMs / 1000).toFixed(1)} 秒，模型调用次数 ${out.steps}，产出 ${out.markdown.length} 字符`);
if (chars > 0) {
  console.log(`速度换算: 输入 ${chars} 字 → 约 ${(chars / (llmMs / 1000)).toFixed(0)} 字/秒（含提示处理）`);
}

/* 4. 存回应用，界面上立刻能看到 */
await j(`/api/lectures/${targetId}/note`, {
  method: 'PUT',
  body: { markdown: out.markdown, data: null, mode: 'llm', model: 'qwen2.5-7b (本地)' },
});
console.log('\n笔记已存回应用。打开地址:');
console.log(`  ${BASE}/#/l/${targetId}`);

console.log('\n──────── 生成结果（前 1800 字）────────');
console.log(out.markdown.slice(0, 1800));
