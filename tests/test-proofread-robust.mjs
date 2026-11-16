/**
 * 校对链路鲁棒性回归测试（不需要大模型、不需要网络）
 *
 * 背景：实测 88 分钟的课跑到「正在校对逐字稿 5/5 段」时抛
 *   Error: 大模型校对输出不是合法 JSON，请重试
 * 原因是模型要求逐条回抄原文，输出被 max_tokens / 超时截断，JSON 只剩半截。
 *
 * 这个脚本用**伪造的 /api/llm**（返回被截断的 JSON、返回带前后废话的 JSON、
 * 返回彻底不是 JSON 的垃圾）来验证降级链路：绝不允许抛异常，绝不允许丢段。
 *
 * 用法：node tests/test-proofread-robust.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

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

const realFetch = globalThis.fetch.bind(globalThis);

/** 装一个假的 /api/llm：mode 决定它怎么坏 */
let mode = 'ok';
let calls = 0;
globalThis.fetch = async (url, init = {}) => {
  if (!String(url).includes('/api/llm')) return realFetch(url, init);
  calls++;
  const body = JSON.parse(init.body || '{}');
  const userMsg = (body.messages || []).find((m) => m.role === 'user')?.content || '';
  let incoming = [];
  try {
    incoming = JSON.parse(userMsg);
  } catch {}
  const good = incoming.map((s) => ({ start: s.start, end: s.end, text: String(s.text).replace(/变力/g, '遍历') }));
  const full = JSON.stringify(good);
  let content;
  if (mode === 'ok') {
    content = full;
  } else if (mode === 'truncated') {
    // 模拟 max_tokens 截断：砍掉尾部，保留前 60% 的完整元素
    content = full.slice(0, Math.floor(full.length * 0.6));
  } else if (mode === 'fenced') {
    content = '好的，这是校对结果：\n```json\n' + full + '\n```\n希望有帮助！';
  } else if (mode === 'garbage') {
    content = '抱歉，我无法完成这个任务。';
  } else if (mode === 'throws') {
    return new Response(JSON.stringify({ ok: false, error: '假装模型挂了' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  } else if (mode === 'half') {
    // 只回一半条目（每条都在，但数量对不上）
    content = JSON.stringify(good.slice(0, Math.max(1, Math.ceil(good.length / 2))));
  } else if (mode === 'shrink') {
    // 条目数对得上、每条 text 却缩成两个字：模拟云端模型「偷懒回一句」——
    // 正是 67916f92 丢字 bug 的模式（2295 字进去、303 字出来、条目数 1===1 恒过）。
    // 长度护栏（srcLen > 40 && gotLen < srcLen * 0.6）必须拦下这种结果。
    content = JSON.stringify(good.map((s) => ({ ...s, text: '短' })));
  } else if (mode === 'merge') {
    // 模型补标点时把相邻两条合成一条（2026-11 实测：2000 字样本 60 条只回 59 条）。
    // 旧版「条目数必须相等」会让整块白跑、降级重试；新版按时间区间铺回、按时长切分。
    const merged = [];
    for (let i = 0; i < good.length; i += 2) {
      const a = good[i];
      const b = good[i + 1];
      merged.push({
        start: a.start,
        end: b ? b.end : a.end,
        text: b ? a.text + '，' + b.text : a.text,
      });
    }
    content = JSON.stringify(merged);
  }
  return new Response(JSON.stringify({ ok: true, content, usage: null, model: 'fake' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

const { cleanTranscriptViaLLM, salvageJsonArray, extractJson } = await import(
  pathToFileURL(path.join(ROOT, 'public', 'llm.js')).href
);

/* ---------- 1. salvageJsonArray 单元测试 ---------- */
console.log('— salvageJsonArray（抢救被截断的 JSON）—');
const trunc = '[{"start":0,"end":1,"text":"甲"},{"start":1,"end":2,"text":"乙"},{"start":2,"end":';
const saved = salvageJsonArray(trunc);
check('半截 JSON 能捞回完整元素', saved.length === 2, `捞回 ${saved.length} 条`);
check('捞回的内容正确', saved[0]?.text === '甲' && saved[1]?.text === '乙');
check('text 里带转义引号不会打乱配对', salvageJsonArray('[{"text":"他说\\"你好\\""},{"text":"x"}]').length === 2);
check('text 里带右花括号不会误判', salvageJsonArray('[{"text":"用 } 收尾"},{"text":"y"}]').length === 2);
check('完全不是 JSON 时返回空数组', salvageJsonArray('抱歉我做不到').length === 0);
check('extractJson 仍能处理带前后废话的正常 JSON', Array.isArray(extractJson('前言\n[{"a":1}]\n后记')));

/* ---------- 2. 降级链路 ---------- */
// charsPer 要小到"一块装得下很多段"，这样"模型只回一半条目"才表现为
// 「条目数对不上」而不是「块变小了」—— 前者才是真正要拦的失败模式。
const mkSegs = (n, charsPer = 12) =>
  Array.from({ length: n }, (_, i) => ({
    start: i * 2,
    end: i * 2 + 1.8,
    text: '变力零散口语'.repeat(Math.ceil(charsPer / 6)).slice(0, charsPer),
  }));

const segs = mkSegs(400, 12); // ≈4800 字，单块恰好装下；坏模式下条目数会对不上
const totalChars = segs.reduce((n, s) => n + s.text.length, 0);
console.log(`\n— 降级链路（${segs.length} 段 / ${totalChars} 字）—`);

async function runCase(label, m, expectRepaired) {
  mode = m;
  calls = 0;
  let res;
  let err = null;
  try {
    res = await cleanTranscriptViaLLM(segs, { onProgress: () => {} });
  } catch (e) {
    err = e;
  }
  const okNoThrow = !err;
  const segCount = res?.segments?.length ?? 0;
  const charCount = (res?.segments || []).reduce((n, s) => n + s.text.length, 0);
  check(`${label}：不抛异常`, okNoThrow, err ? err.message : '');
  check(`${label}：段数守恒 ${segs.length}`, segCount === segs.length, `得到 ${segCount}`);
  check(`${label}：没有空段`, (res?.segments || []).every((s) => s.text && s.text.length));
  check(`${label}：时间戳原样保留`, (res?.segments || []).every((s, i) => s.start === segs[i].start && s.end === segs[i].end));
  if (expectRepaired !== undefined) {
    const rep = res?.repaired?.length ?? 0;
    check(`${label}：repaired 标记${expectRepaired ? '非空' : '为空'}`, expectRepaired ? rep > 0 : rep === 0, `repaired=${rep}`);
  }
  console.log(
    `   块数调用=${calls}  改动前字数=${totalChars}  校对后字数=${charCount}  修正处数=${res?.changed ?? '?'}  降级块=${JSON.stringify(res?.repaired ?? [])}`
  );
  return res;
}

const r1 = await runCase('正常返回', 'ok', false);
check('正常返回时真的改了音近错字', !r1.segments.some((s) => s.text.includes('变力')));

await runCase('输出被截断', 'truncated', true);
await runCase('带 markdown 围栏和废话', 'fenced', false);
await runCase('彻底不是 JSON', 'garbage', true);
await runCase('模型返回错误', 'throws', true);
await runCase('只回一半条目', 'half', true);
await runCase('条目数对但字数被吞', 'shrink', true);

// 相邻两条被合并：2026-11 加了补标点示范之后模型的常见行为。
// 必须**不降级**地收下（旧版按条目数相等否决，整块白跑、长录音慢好几倍），
// 而且段数、时间戳、字数都得守恒。
const rm = await runCase('相邻两条被合并', 'merge', false);
const mergedChars = (rm?.segments || []).reduce((n, s) => n + s.text.length, 0);
check('合并被切回原段数后字数不丢', mergedChars >= totalChars * 0.95, `得到 ${mergedChars} / ${totalChars}`);
const punctSegs = (rm?.segments || []).filter((s) => /[，。]/.test(s.text)).length;
check('合并切回来的段里补的标点还在', punctSegs > 0, `带标点的段 ${punctSegs}/${rm?.segments?.length ?? 0}`);

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
