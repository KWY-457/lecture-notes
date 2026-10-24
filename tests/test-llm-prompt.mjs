/**
 * AI 笔记提示词的回归测试（不联网、不调真模型）
 *
 * 用 globalThis.fetch 垫片截住 public/llm.js 发出的请求，只检查**提示词内容**，
 * 让模型返回一句假 markdown 就够了。所以这个测试跑起来只要几十毫秒。
 *
 * 为什么要有它：2026-10-23 老大问「重点自适应是真的自适应还是摆设」，
 * 查出来 AI 笔记那条路根本没读 maxPointsPerTopic —— 两处提示词里各写死了一句
 * 「- 要点（3-7 条…）」，用户在弹窗里选 3 条、选 8 条、选自适应，出来的笔记一模一样。
 * 这个测试就是钉住这件事：
 *   1. 选固定条数时，提示词里必须出现那个数字（而且不再出现 3-7 这种写死的区间）；
 *   2. 选自适应（0）时，提示词里必须出现「2-8 条」这种让模型自己定的说法；
 *   3. 两条路（短课 DIRECT / 长课 REDUCE）都要覆盖 —— 只修一条的话，
 *      用户换个长度的课就又会退回老行为。
 *
 * 用法：
 *   node tests/test-llm-prompt.mjs            全部用例
 *   node tests/test-llm-prompt.mjs --verbose  额外打印抓到的提示词片段
 */
import { generateAINote } from '../public/llm.js';

const VERBOSE = process.argv.includes('--verbose');
let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? `　→　${detail}` : ''}`);
  }
};
const section = (t) => console.log(`\n=== ${t} ===`);

/* ---------- fetch 垫片：截住提示词，回一个假笔记 ---------- */
const realFetch = globalThis.fetch.bind(globalThis);
let captured = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.includes('/api/llm')) throw new Error('这个测试只代理 /api/llm，却收到：' + u);
  const body = JSON.parse(init.body || '{}');
  captured.push((body.messages || []).map((m) => m.content || '').join('\n'));
  return new Response(JSON.stringify({ ok: true, content: '### 1. 假主题  [00:00]\n- 假要点' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

/* ---------- 造两套输入：短课（走 DIRECT）/ 长课（走 REDUCE）---------- */
// DIRECT_LIMIT = 14000 字，CHUNK_CHARS = 6000（见 public/llm.js:19-20）
function makeSegments(chars) {
  const segs = [];
  const unit = '二叉树的中序遍历是先走左子树再访问根节点，这个顺序决定了输出是有序的。';
  let n = 0;
  let t = 0;
  while (n < chars) {
    segs.push({ i: segs.length, start: t, end: t + 4, text: unit });
    n += unit.length;
    t += 4;
  }
  return segs;
}
const SHORT = makeSegments(2000); // 走 DIRECT
const LONG = makeSegments(40000); // 走 REDUCE（分段）
const ANALYSIS = { keywords: [{ term: '二叉树' }, { term: '中序遍历' }], outline: [] };
const META = { title: '测试课', course: '数据结构', duration: 600 };

async function promptOf(segments, maxPointsPerTopic) {
  captured = [];
  await generateAINote({
    segments,
    meta: META,
    analysis: ANALYSIS,
    options: { style: 'exam', title: META.title, course: META.course, maxPointsPerTopic },
  }).catch((e) => console.log('  （生成中途抛错，提示词已经抓到了）:', e.message));
  return { calls: captured.slice(), last: captured[captured.length - 1] || '' };
}

/** 从提示词里找「- 要点（…」那一行 */
function pointsLine(prompt) {
  return (prompt.split('\n').find((l) => l.includes('要点（')) || '').trim();
}

/* ---------- 1. 短课（DIRECT_PROMPT）---------- */
section('短课：提示词跟「重点条数」走');
{
  const r3 = await promptOf(SHORT, 3);
  const line3 = pointsLine(r3.last);
  check('抓到了提示词（只调一次模型）', r3.calls.length === 1, `${r3.calls.length} 次`);
  check('选了 3 条，提示词里有「正好 3 条」', /正好\s*3\s*条/.test(line3), line3.slice(0, 120));
  check('选了 3 条时不再出现老的「3-7 条」', !/3-7\s*条/.test(line3), line3.slice(0, 120));
  if (VERBOSE) console.log('    ' + line3);

  const r8 = await promptOf(SHORT, 8);
  const line8 = pointsLine(r8.last);
  check('选了 8 条，提示词里有「正好 8 条」', /正好\s*8\s*条/.test(line8), line8.slice(0, 120));
  check('3 条和 8 条发出去的提示词不一样', pointsLine(r3.last) !== line8, '');

  const rAuto = await promptOf(SHORT, 0);
  const lineAuto = pointsLine(rAuto.last);
  check('自适应时提示词写「2-8 条」并让模型自己定', /2-8\s*条/.test(lineAuto) && /自己定/.test(lineAuto), lineAuto.slice(0, 160));
  check('自适应时提示词里没有写死某一个数字条数', !/正好\s*\d+\s*条/.test(lineAuto), lineAuto.slice(0, 160));
  if (VERBOSE) console.log('    ' + lineAuto);
}

/* ---------- 2. 长课（REDUCE_PROMPT）---------- */
section('长课（分段后合并）：同一个条数也要生效');
{
  const r5 = await promptOf(LONG, 5);
  check('长课真的走了分段（调了不止一次模型）', r5.calls.length > 1, `${r5.calls.length} 次`);
  const line5 = pointsLine(r5.last);
  check('最后一次调用是「合并」，里面有「正好 5 条」', /正好\s*5\s*条/.test(line5), line5.slice(0, 120));
  check('长课里也不再出现老的「3-7 条」', !/3-7\s*条/.test(line5), line5.slice(0, 120));

  const rAuto = await promptOf(LONG, 0);
  const lineAuto = pointsLine(rAuto.last);
  check('长课自适应同样写「2-8 条」', /2-8\s*条/.test(lineAuto) && /自己定/.test(lineAuto), lineAuto.slice(0, 160));
  check('长课自适应没有写死数字条数', !/正好\s*\d+\s*条/.test(lineAuto), lineAuto.slice(0, 160));
}

/* ---------- 3. 不传这个选项时的兜底 ---------- */
section('没传 / 传了非法值时按自适应处理');
{
  const rMiss = await promptOf(SHORT, undefined);
  check('不传 maxPointsPerTopic → 走自适应文案', /2-8\s*条/.test(pointsLine(rMiss.last)), pointsLine(rMiss.last).slice(0, 120));

  const rBad = await promptOf(SHORT, 'abc');
  check('传了非数字 → 走自适应文案', /2-8\s*条/.test(pointsLine(rBad.last)), pointsLine(rBad.last).slice(0, 120));

  const rNeg = await promptOf(SHORT, -3);
  check('传了负数 → 走自适应文案', /2-8\s*条/.test(pointsLine(rNeg.last)), pointsLine(rNeg.last).slice(0, 120));
}

/* ---------- 4. 其它选项没被这次改动带坏 ---------- */
section('顺带确认：风格 / 额外要求仍然进提示词');
{
  captured = [];
  await generateAINote({
    segments: SHORT,
    meta: META,
    analysis: ANALYSIS,
    options: { style: 'cornell', title: META.title, extraPrompt: '这是法学课，请把法条编号写全' },
  }).catch(() => {});
  const p = captured.join('\n');
  check('换了额外要求，提示词里带着它', p.includes('这是法学课，请把法条编号写全'), '');
  check('提示词里仍有课堂脉络那一节', p.includes('课堂脉络与重点'), '');
}

globalThis.fetch = realFetch;

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
