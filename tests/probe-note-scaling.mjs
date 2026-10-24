/**
 * 材料长度扫描：笔记深度随逐字稿长度怎么变？
 *
 * 动机：test-ainote-depth.mjs 在 2408 字的短稿上跑得很好（理解脉络 328 字），
 *       在 7079 字的长稿上塌了（理解脉络 228 字，重合率 74%）。
 *       这个脚本把「多长会塌」量成一条曲线，用数字说话，而不是凭印象猜。
 *
 * 用法：
 *   node tests/probe-note-scaling.mjs 40 80 120 200 413
 *   node tests/probe-note-scaling.mjs --lecture 62b4f73d
 *
 * 它不依赖浏览器、也不需要 server.mjs：用 globalThis.fetch 垫片把 /api/llm
 * 转发到本地 llama-server，并把返回体包成 server.mjs 的形状 { ok, content, usage, model }。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { markers, overlapRatio } from './note-metrics.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LLM_URL = process.env.LLM_URL || 'http://127.0.0.1:8080/v1/chat/completions';

const argv = process.argv.slice(2);
const lecIdx = argv.indexOf('--lecture');
const WANT = lecIdx === -1 ? '1305e386' : argv[lecIdx + 1];
const SIZES = argv.filter((a) => /^\d+$/.test(a)).map(Number);
if (!SIZES.length) SIZES.push(40, 80, 120, 200, 413);

/* ---------- fetch 垫片 ---------- */
// 必须先存下真 fetch 再覆盖，否则 realFetch 会指向垫片自己 → 无限递归
const realFetch = globalThis.fetch.bind(globalThis);
let calls = 0;
let promptChars = 0;
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
  return new Response(JSON.stringify({ ok: true, content, usage: data?.usage, model: 'qwen2.5-7b' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

/* ---------- 载入样本 ---------- */
const lecturesDir = path.join(ROOT, 'data', 'lectures');
const dirs = fs.readdirSync(lecturesDir).filter((d) => fs.existsSync(path.join(lecturesDir, d, 'transcript.json')));
const LECTURE = dirs.find((d) => d.startsWith(WANT)) || dirs[0];
const raw = JSON.parse(fs.readFileSync(path.join(lecturesDir, LECTURE, 'transcript.json'), 'utf8'));
const metaPath = path.join(lecturesDir, LECTURE, 'meta.json');
const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};
const all = raw.segments || [];
if (!all.length) throw new Error('这条记录没有 segments');

console.log(`记录：${LECTURE}（共 ${all.length} 段）`);
console.log(`模型：${LLM_URL}\n`);

const { generateAINote } = await import(pathToFileURL(path.join(ROOT, 'public', 'llm.js')).href);

console.log('段数   逐字稿字数  笔记字数  理解脉络  易错易混  自测题  重合率  二级节  调用  耗时');
console.log('-----  ----------  --------  --------  --------  ------  ------  ------  ----  ------');

const rows = [];
for (const n of SIZES) {
  const segments = all.slice(0, Math.min(n, all.length));
  const srcChars = segments.reduce((k, s) => k + String(s.text || '').replace(/\s/g, '').length, 0);
  calls = 0;
  promptChars = 0;
  const t0 = Date.now();
  const r = await generateAINote({
    segments,
    meta,
    analysis: { keywords: [], outline: [] },
    options: { style: 'exam' },
    onProgress: (msg) => process.stdout.write(`\r  ${msg}                    `),
  });
  const ms = Date.now() - t0;
  process.stdout.write('\r' + ' '.repeat(64) + '\r');
  const m = markers(r.markdown);
  const ov = overlapRatio(r.markdown, segments.map((s) => s.text || '').join(''));
  rows.push({ n: segments.length, srcChars, ...m, overlap: ov, calls, ms });
  console.log(
    String(segments.length).padEnd(5) +
      '  ' +
      String(srcChars).padStart(10) +
      '  ' +
      String(m.chars).padStart(8) +
      '  ' +
      String(m.logicChars).padStart(8) +
      '  ' +
      String(m.trapsChars).padStart(8) +
      '  ' +
      String(m.selfTest).padStart(6) +
      '  ' +
      `${(ov * 100).toFixed(1)}%`.padStart(6) +
      '  ' +
      String(m.sections).padStart(6) +
      '  ' +
      String(calls).padStart(4) +
      '  ' +
      `${(ms / 1000).toFixed(1)}s`.padStart(6)
  );
}

/* ---------- 结论：深度塌陷的拐点 ---------- */
const deep = rows.filter((r) => r.logicChars >= 300);
const shallow = rows.filter((r) => r.logicChars < 300);
console.log('\n「理解脉络 ≥300 字」的样本：' + (deep.length ? deep.map((r) => `${r.srcChars} 字稿`).join('、') : '（无）'));
console.log('「理解脉络 <300 字」的样本：' + (shallow.length ? shallow.map((r) => `${r.srcChars} 字稿→${r.logicChars} 字`).join('、') : '（无）'));
if (deep.length && shallow.length) {
  const maxOk = Math.max(...deep.map((r) => r.srcChars));
  const minBad = Math.min(...shallow.map((r) => r.srcChars));
  console.log(`拐点：逐字稿 ${maxOk} 字还能写厚，到 ${minBad} 字就塌了。`);
}
