/**
 * 底层数据流的闭环测试：不测某个函数，而是测「任何脏数据进来，出去都是干净的」。
 *
 * 这是给 m01506「修底层而不是修单条录音」立的护栏：
 *   ① 各家云端服务商的返回形状千奇百怪（有的给 segments，有的只给 text，
 *      有的给的时间戳全是 0），规范化后必须都能用；
 *   ② 逐字稿一旦变了，笔记必须自己知道过时了；
 *   ③ 整个流程必须幂等 —— 同一份数据过两遍和过一遍一模一样。
 *
 * 用法： node tests/test-data-pipeline.mjs
 */
import { normalizeTranscript, needsNormalize as needsTranscriptNormalize } from '../public/transcript.js';
import { noteStatus, stampNote, normalizeNote, needsNormalize, transcriptFingerprint, NOTE_SCHEMA_VERSION } from '../public/note.js';
import { analyze } from '../public/summarize.js';

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  →  ' + extra : ''}`); }
};
const chars = (s) => String(s || '').replace(/\s/g, '').length;
const segChars = (segs) => (segs || []).reduce((n, s) => n + chars(s.text), 0);

const SAMPLE_TEXT =
  '好，那我们今天接着讲二叉树的遍历。上节课我们讲了树的基本概念，大家还记得吧，树是由 n 个结点组成的有限集合。' +
  '先明确一个定义：所谓二叉树的遍历，是指按照某种规则依次访问树中每个结点，并且每个结点只访问一次的过程。' +
  '那么遍历主要有四种方式，第一种是先序遍历，顺序是根、左、右；第二种是中序遍历，顺序是左、根、右；' +
  '第三种是后序遍历，顺序是左、右、根；第四种是层序遍历，也就是一层一层从左到右访问。' +
  '这里特别要注意的是，中序遍历在二叉搜索树上的结果一定是一个递增序列，这个性质非常重要，考试经常考。' +
  '嗯。对。是的。好。';
const DURATION = 690;

console.log('\n=== 1. 各种服务商返回形状都能落成干净数据 ===');

// 形状 A：硅基流动 SenseVoice —— 只回整篇 text，没有 segments
{
  const { doc, repairs } = normalizeTranscript({ text: SAMPLE_TEXT, segments: [] }, { duration: DURATION });
  check('只回 text（0 段）也能切出多段', doc.segments.length > 5, `${doc.segments.length} 段`);
  check('字数一字不丢（含「嗯。」这种单字语气词）', segChars(doc.segments) === chars(SAMPLE_TEXT), `${segChars(doc.segments)}/${chars(SAMPLE_TEXT)}`);
  check('时间轴从 0 铺到录音结束', doc.segments[0].start === 0 && Math.abs(doc.segments.at(-1).end - DURATION) < 1, `${doc.segments[0].start}→${doc.segments.at(-1).end}`);
  check('时间轴严格单调不重叠', doc.segments.every((s, i, a) => i === 0 || s.start >= a[i - 1].end - 0.01));
  check('每段都有实际时长（没有零长段）', doc.segments.every((s) => s.end > s.start));
  check('报了修补原因，方便排查', repairs.length > 0, repairs.join(' | '));
}

// 形状 B：OpenAI Whisper —— 给 segments 但时间戳全是 0
{
  const segs = SAMPLE_TEXT.split('。').filter(Boolean).map((t) => ({ start: 0, end: 0, text: t + '。' }));
  const { doc } = normalizeTranscript({ text: SAMPLE_TEXT, segments: segs }, { duration: DURATION });
  check('时间戳全 0 的 segments 会按字数摊开', doc.segments.at(-1).end > DURATION * 0.9, String(doc.segments.at(-1).end));
  check('时间戳全 0 时文字不丢', segChars(doc.segments) === chars(SAMPLE_TEXT));
}

// 形状 C：某家用毫秒当秒（数值大 1000 倍）
{
  const segs = [
    { start: 0, end: 2000, text: '第一句。' },
    { start: 2000, end: 5000, text: '第二句。' },
  ];
  const { doc } = normalizeTranscript({ text: '第一句。第二句。', segments: segs }, { duration: 5 });
  check('时间轴远超录音时长时会缩回范围内', doc.segments.at(-1).end <= 5 * 1.02, String(doc.segments.at(-1).end));
}

// 形状 D：倒序 / 重叠
{
  const segs = [
    { start: 10, end: 20, text: '第一句。' },
    { start: 5, end: 12, text: '第二句。' },
    { start: 0, end: 3, text: '第三句。' },
  ];
  const { doc } = normalizeTranscript({ text: '第一句。第二句。第三句。', segments: segs }, { duration: 30 });
  check('倒序/重叠的时间轴被拉直', doc.segments.every((s, i, a) => i === 0 || s.start >= a[i - 1].start), JSON.stringify(doc.segments.map((s) => s.start)));
}

// 形状 E：单段巨长（旧版代码的产物，22367 字一段）
{
  const long = SAMPLE_TEXT.repeat(30);
  const { doc } = normalizeTranscript({ text: long, segments: [{ start: 0, end: 0, text: long }] }, { duration: DURATION });
  check('单段巨长会被切成多段', doc.segments.length > 20, `${doc.segments.length} 段`);
  check('单段巨长切完不丢字', segChars(doc.segments) === chars(long), `${segChars(doc.segments)}/${chars(long)}`);
  check('切开后每段不超过上限（120 字 / 30 秒）', doc.segments.every((s) => chars(s.text) <= 200));
}

console.log('\n=== 2. 幂等：同一份数据过两遍和过一遍一样 ===');
{
  const first = normalizeTranscript({ text: SAMPLE_TEXT, segments: [] }, { duration: DURATION }).doc;
  const second = normalizeTranscript(first, { duration: DURATION });
  check('第二遍不再产生修改', second.repairs.length === 0, second.repairs.join(' | '));
  check('第二遍段数不变', second.doc.segments.length === first.segments.length);
  check('第二遍内容完全一致', JSON.stringify(second.doc.segments) === JSON.stringify(first.segments));
  check('needsNormalize 判为「不需要」', needsTranscriptNormalize(first, { duration: DURATION }) === false);
}

console.log('\n=== 3. 笔记能判断自己是否过时 ===');
{
  const transcript = normalizeTranscript({ text: SAMPLE_TEXT, segments: [] }, { duration: DURATION }).doc;
  const fp = transcriptFingerprint(transcript);
  const analysis = analyze({ segments: transcript.segments, meta: { duration: DURATION } });
  const fresh = stampNote({ markdown: analysis.markdown, data: analysis, mode: 'offline' }, { fingerprint: fp, mode: 'offline' });

  const s1 = noteStatus(fresh, { fingerprint: fp });
  check('刚生成的笔记判为最新', s1.stale === false, s1.reason);
  check('笔记里记下了算法版本', fresh.noteVersion === NOTE_SCHEMA_VERSION);

  const s2 = noteStatus(fresh, { fingerprint: 'changed-forever' });
  check('逐字稿变了 → 判为过时', s2.stale === true);
  // 2026-11-13 起没有任何笔记能自动重建（离线引擎退出产品，重建一律走大模型要花钱），
  // 所以 canAutoRebuild 字段整个删掉了。这里反过来断言它不存在 ——
  // 万一哪天有人手滑加回来，服务端又会偷偷替用户烧 Key。
  check('不再提供「自动重建」这个许可位', s2.canAutoRebuild === undefined, String(s2.canAutoRebuild));
  check('过时原因照旧给人话', s2.reason === '逐字稿已更新', s2.reason);

  const old = { ...fresh, noteVersion: NOTE_SCHEMA_VERSION - 1 };
  check('低版本笔记 → 判为过时', noteStatus(old, { fingerprint: fp }).stale === true);

  check('笔记指纹稳定', transcriptFingerprint(transcript) === fp);
  check('逐字稿改一个字指纹就变', transcriptFingerprint({ ...transcript, text: transcript.text + '啊' }) !== fp);
}

console.log('\n=== 4. 笔记入口把两类脏东西洗干净 ===');
{
  // ① 提示词残留：模型偶尔把「［40 字以内，说清这节课的主线。］」连同要求一起抄进正文。
  //    以前只在渲染时滤，磁盘上一直是脏的 → 导出 Word / 导出 md / 复制笔记全带出去。
  const dirty = {
    mode: 'llm',
    markdown: '# 标题\n\n## 一句话概要\n\n［40 字以内，说清这节课的主线。］\n\n这节课讲了二叉树。\n\n## 课堂脉络与重点\n\n### 1. 遍历 [00:10](#t=10)\n- 先序遍历是根左右。\n',
    data: { outline: [] },
  };
  const r1 = normalizeNote(dirty);
  check('正文里的提示词残留被清掉', !/［/.test(r1.note.markdown), r1.note.markdown.slice(0, 60));
  check('清理行为被记下来', r1.repairs.some((x) => x.includes('提示词')));
  check('正文其余内容原样保留', r1.note.markdown.includes('这节课讲了二叉树') && r1.note.markdown.includes('先序遍历是根左右'));

  // ② 两套结构打架：AI 笔记的 data.outline 是离线引擎的碎片主题，
  //    正文却是模型重新组织的。读 data.outline 的地方（思维导图）就会显示碎片。
  //    规矩：AI 笔记的正文才是唯一事实来源，outline 只是它的派生缓存。
  const conflict = {
    mode: 'llm',
    markdown: '# 笔记\n\n## 课堂脉络与重点\n\n### 1. 成绩构成 [01:32](#t=92)\n- 平时成绩占 50%。\n\n### 2. 请假与缺课 [04:33](#t=273)\n- 请假要交正规请假条。\n',
    data: { outline: [{ heading: '一下这门课 · 能记' }, { heading: 'bjr · 一部分' }, { heading: '加分 · 表现' }] },
  };
  const r2 = normalizeNote(conflict);
  check('AI 笔记的提纲按正文重算', r2.note.data.outline.length === 2 && r2.note.data.outline[0].heading === '成绩构成',
    JSON.stringify(r2.note.data.outline.map((t) => t.heading)));
  check('重算的提纲保留了时间戳', r2.note.data.outline[0].start === 92, String(r2.note.data.outline[0].start));
  check('重算的提纲带上了要点', r2.note.data.outline[0].points.length === 1, JSON.stringify(r2.note.data.outline[0].points));

  // 幂等：洗过的再过一遍不该有任何变化
  const r3 = normalizeNote(r2.note);
  check('规范化是幂等的', r3.repairs.length === 0, JSON.stringify(r3.repairs));
  check('needsNormalize 对已洗过的笔记判 false', needsNormalize(r2.note) === false);

  // 离线笔记不动它的 outline：那是逐字稿算出来的，不该被正文反推覆盖
  const offline = { mode: 'offline', markdown: conflict.markdown, data: { outline: [{ heading: 'A' }] } };
  check('离线笔记的提纲不被正文覆盖', normalizeNote(offline).note.data.outline[0].heading === 'A');
}

console.log('\n=== 5. 从脏数据到笔记，整条链走得通 ===');
{
  // 模拟：服务商只回 text → 规范化 → 生成笔记 → 笔记里有时间戳链接
  const { doc } = normalizeTranscript({ text: SAMPLE_TEXT, segments: [] }, { duration: DURATION });
  const note = analyze({ segments: doc.segments, meta: { duration: DURATION, title: '二叉树遍历' } });
  check('脏数据也能生成笔记', !!note.markdown && note.markdown.length > 100);
  check('笔记里的主题数合理（不是每 5 句一刀）', note.outline.length >= 1 && note.outline.length <= 10, `${note.outline.length} 个主题`);
  check('笔记里有可点击的时间戳', /\(#t=\d/.test(note.markdown));
  check('笔记引用的句子都来自逐字稿', note.stats.sentences > 0 && note.stats.chars > 0, JSON.stringify(note.stats));
}

console.log(`\n${'='.repeat(60)}`);
console.log(fail === 0 ? `✅ 全部通过（${pass} 项）` : `❌ ${fail} 项失败 / ${pass} 项通过`);
console.log('='.repeat(60));
process.exit(fail ? 1 : 0);
