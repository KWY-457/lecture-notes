/**
 * 大模型校对（public/llm.js 的 cleanTranscriptViaLLM）实测。
 *
 * 背景：项目里 `llm.baseUrl = http://127.0.0.1:8080/v1`，而 llama-server 一直
 * 没在跑，所以两条真实记录的 `cleanedBy` 都是 `rule` —— 大模型校对从来没生效过。
 * 音近错字（「遍历」听成「变力」这类）只有它能修，所以这一环是质量的关键。
 *
 * 前置：本地模型服务要在跑
 *   D:\Download\AI\runtime\cuda\llama-server.exe -m ...Qwen2.5-7B-Instruct-Q4_K_M.gguf
 *   -c 16384 -ngl 99 --flash-attn on -ctk q8_0 -ctv q8_0 --host 127.0.0.1 --port 8080
 *   （或双击 D:\Download\AI\start-llm.vbs）
 *
 * 跑法：node tests/test-proofread-llm.mjs [段数|all] [录音id前8位]
 *   默认只取前 40 段，避免一次跑太久；传 all 跑整条；第二参数可选指定哪条录音。
 */
import fs from 'node:fs';
import path from 'node:path';
import { cleanTranscriptViaLLM } from '../public/llm.js';
import { cleanSegments, hallucinationScore } from '../public/cleanup.js';
import { T2S_MAP } from '../public/t2s-table.js';

const ROOT = path.join(import.meta.dirname, '..');
const all = String(process.argv[2] || '').toLowerCase() === 'all';
const LIMIT = all ? Infinity : (Number(process.argv[2]) || 40);
const wantId = String(process.argv[3] || '');
const BASE = 'http://127.0.0.1:8080/v1';

// 浏览器里 callLLM 打的是同源 /api/llm，由 server.mjs 代理到 baseUrl。
// 在 node 里没有那个 server，所以直接把 /api/llm 接到本地模型服务上。
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith('/api/llm')) {
    const body = JSON.parse(init.body);
    const r = await realFetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen2.5-7b', temperature: body.temperature ?? 0.2, messages: body.messages, stream: false }),
      signal: init.signal,
    });
    const data = await r.json();
    // server.mjs 的 /api/llm 返回的是 { ok, content, usage, model }，
    // 直接透传 llama-server 的原始体会让 callLLM 里 `!data.ok` 判定失败（HTTP 200 也报错）。
    return new Response(JSON.stringify({
      ok: true,
      content: data?.choices?.[0]?.message?.content ?? '',
      usage: data?.usage || null,
      model: 'qwen2.5-7b',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, init);
};

async function healthy() {
  try {
    const r = await realFetch(`${BASE.replace('/v1', '')}/health`, { signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch { return false; }
}

const ok = await healthy();
console.log(`本地模型服务 ${BASE}：${ok ? '在线 ✓' : '不在线 ✗'}`);
if (!ok) {
  console.log('先把服务拉起来：D:\\Download\\AI\\start-llm.vbs（或在终端跑 llama-server 那条命令）');
  process.exit(2);
}

// ── 挑一条真实记录 ──
const files = fs.readdirSync(path.join(ROOT, 'data', 'lectures'))
  .map((d) => path.join(ROOT, 'data', 'lectures', d, 'transcript.json')).filter((f) => fs.existsSync(f));
let target = null;
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const id = path.basename(path.dirname(f)).slice(0, 8);
  if (wantId && !id.startsWith(wantId)) continue;
  if (Number.isFinite(LIMIT) && (j.segments || []).length < LIMIT) continue;
  target = { f, j };
  break;
}
if (!target) { console.log('没有合适的记录'); process.exit(1); }
const recId = path.basename(path.dirname(target.f)).slice(0, 8);
const raw = (target.j.segments || []).slice(0, Number.isFinite(LIMIT) ? LIMIT : undefined);
console.log(`样本：${recId}（原 ${target.j.model}），取前 ${raw.length} 段，共 ${raw.map((s) => s.text || '').join('').length} 字\n`);

// 先做确定性清洗（这就是送进大模型的输入）
const beforeClean = cleanSegments(raw);
const tradInInput = beforeClean.reduce((n, s) => n + [...String(s.text || '')].filter((c) => T2S_MAP.has(c)).length, 0);
console.log(`送进大模型前：繁体形残留 ${tradInInput} 个（确定性清洗已跑过）`);

const t0 = Date.now();
let lastMsg = '';
const { segments: after, changed, repaired = [] } = await cleanTranscriptViaLLM(beforeClean, {
  onProgress: (msg) => { if (msg !== lastMsg) { lastMsg = msg; console.log(`  · ${msg}`); } },
});
const ms = Date.now() - t0;
console.log(`\n校对完成：${(ms / 1000).toFixed(1)}s（${(ms / Math.max(1, beforeClean.length)).toFixed(0)}ms/段），diffCount = ${changed}`);
if (repaired.length) {
  console.log(`⚠ 降级块（大模型没交出完整结果，已保留基础清洗）：第 ${repaired.join('、')} 块`);
} else {
  console.log('✓ 没有降级块：每一块都由大模型完整校对');
}

// ── 校验：结构必须守恒 ──
let pass = 0, fail = 0;
const ck = (n, c, d = '') => { c ? pass++ : fail++; console.log(`  ${c ? '✅' : '❌'} ${n}${c ? '' : '  → ' + d}`); };
console.log('\n=== 结构守恒 ===');
ck('段数一致', after.length === beforeClean.length, `${beforeClean.length} -> ${after.length}`);
let tsBad = 0, empty = 0;
for (let i = 0; i < Math.min(after.length, beforeClean.length); i++) {
  if (Math.abs(Number(after[i].start) - Number(beforeClean[i].start)) > 0.01) tsBad++;
  if (!String(after[i].text || '').trim()) empty++;
}
ck('时间戳未变', tsBad === 0, `${tsBad} 段时间戳漂移`);
ck('没有空文本', empty === 0, `${empty} 段变空`);

// ── 质量：繁体形必须清零，且不该出现新繁体 ──
const tradAfter = after.reduce((n, s) => n + [...String(s.text || '')].filter((c) => T2S_MAP.has(c)).length, 0);
console.log('\n=== 质量 ===');
ck(`校对后无繁体形（${tradAfter} 个）`, tradAfter === 0, `残留 ${tradAfter}`);

// 逐段差异
const diffs = [];
for (let i = 0; i < Math.min(after.length, beforeClean.length); i++) {
  const a = String(beforeClean[i].text || ''), b = String(after[i].text || '');
  if (a !== b) diffs.push({ i, start: beforeClean[i].start, a, b });
}
console.log(`\n=== 改动明细：${diffs.length}/${beforeClean.length} 段被校对过 ===`);
// 跑整条（all）时只打汇总：413 段的逐段前后对照会把输出撑到几万字，
// 报告里也用不上；要细节就传具体段数跑。
const SHOW = all ? 0 : 25;
for (const d of diffs.slice(0, SHOW)) {
  const t = `${String(Math.floor(d.start / 60)).padStart(2, '0')}:${String(Math.floor(d.start % 60)).padStart(2, '0')}`;
  console.log(`  [${t}] 前：${d.a.slice(0, 70)}`);
  console.log(`        后：${d.b.slice(0, 70)}`);
}
if (SHOW && diffs.length > SHOW) console.log(`  …另有 ${diffs.length - SHOW} 段`);
if (all) {
  let chIn = 0, chOut = 0;
  for (let i = 0; i < Math.min(after.length, beforeClean.length); i++) {
    const a = [...String(beforeClean[i].text || '')];
    const b = [...String(after[i].text || '')];
    let same = 0;
    for (let k = 0; k < Math.min(a.length, b.length); k++) if (a[k] === b[k]) same++;
    chIn += a.length; chOut += b.length;
    void same;
  }
  console.log(`  （逐段对照已省略：整条跑只打汇总。字数 ${chIn} -> ${chOut}）`);
}

// 可疑段（幻觉风险）在原文 / 校对后的数量对比
const susBefore = beforeClean.filter((s) => hallucinationScore(String(s.text || ''), (s.end || 0) - (s.start || 0)) >= 0.5).length;
const susAfter = after.filter((s) => hallucinationScore(String(s.text || ''), (s.end || 0) - (s.start || 0)) >= 0.5).length;
const tradBeforeAll = beforeClean.reduce((n, s) => n + [...String(s.text || '')].filter((c) => T2S_MAP.has(c)).length, 0);
console.log('\n=== 汇总 ===');
console.log(`  段数 ${beforeClean.length} -> ${after.length}`);
console.log(`  繁体形 ${tradBeforeAll} -> ${tradAfter}`);
console.log(`  高可疑度段（幻觉风险）${susBefore} -> ${susAfter}`);
console.log(`  字数 ${beforeClean.reduce((n, s) => n + [...String(s.text || '')].length, 0)} -> ${after.reduce((n, s) => n + [...String(s.text || '')].length, 0)}`);
console.log(`  耗时 ${(ms / 1000).toFixed(1)}s（${(ms / Math.max(1, beforeClean.length)).toFixed(0)}ms/段）`);


// 修正了的常见音近错字（人工对照表里挑的）
const PAIRS = [['变力', '遍历'], ['鸡疫', '基因'], ['设夺', '设备'], ['及時', '及时'], ['回覆', '回复'],
  ['乙权', '二叉树'], ['先续', '先序'], ['中续', '中序'], ['后续', '后序'], ['接点', '节点']];
console.log('\n=== 常见音近错字命中情况 ===');
const joined = after.map((s) => s.text).join('');
for (const [wrong, right] of PAIRS) {
  const nWrong = (joined.match(new RegExp(wrong, 'g')) || []).length;
  const nRight = (joined.match(new RegExp(right, 'g')) || []).length;
  if (nWrong || nRight) console.log(`  ${wrong} -> ${right}：校对后「${wrong}」${nWrong} 次，「${right}」${nRight} 次`);
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exitCode = fail ? 1 : 0;
