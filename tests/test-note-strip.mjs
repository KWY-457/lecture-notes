#!/usr/bin/env node
/**
 * 笔记正文的两道清洗：stripPromptLeaks() 与 stripCheckSection()
 *
 * 为什么要单独立一个测试：2026-10-28 这两个函数各写错一次，而两次都是
 * **「删太多」** —— 它们都用了「一直删到下一个 `##` 标题」这种出口，
 * 可实际上被删的那两段经常就是正文最后一节，后面再没有标题，
 * 于是「到下一个标题」= 「到文末」，把整份逐字稿附录（`---` + `<details>`）
 * 一起吃了。实测 1305e386 从 14284 字削到 1825 字，附录一个字不剩。
 *
 * 所以这个测试的重点不是「该删的删掉了吗」，而是
 * **「不该删的一个字都没少」** —— 每条用例都同时验两头。
 */

import { stripPromptLeaks, stripCheckSection } from '../public/md.js';

let pass = 0;
let fail = 0;
const fails = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    fails.push(name);
    console.log(`  ✗ ${name}` + (detail ? ` ${detail}` : ''));
  }
}

function section(t) {
  console.log(`\n【${t}】`);
}

/** 一份仿真笔记：正文 + 核对节 + 分隔线 + 逐字稿附录（结构和真实 note.json 一致） */
const APPENDIX = [
  '---',
  '',
  '<details>',
  '<summary>📄 展开完整逐字稿（按时间轴）</summary>',
  '',
  '**[00:00](#t=0.00)** 好，我们讲这个高阶导数啊有点变化。',
  '',
  '**[00:23](#t=23.80)** 大家物理高中都学过加速度，加速度是什么呀。',
  '',
  '</details>',
].join('\n');

const LEAK = [
  '硬性要求：',
  '1. 所有时间标记必须写成 [mm:ss] 或 [时:分:秒] 的方括号形式，位置紧跟在对应内容后面，**不要**改写成链接或其他格式；',
  '2. 主题标题要具体（如"非递归遍历的实现"），不要写"第一部分"；',
  '3. 合并同类项，去掉重复内容；语言精炼，不要车轱辘话；',
  '4. **不许整句照抄逐字稿**：除了专业术语、公式、专有名词和数字，其余一律用你自己的话重写。',
  '9. 不许把上面结构说明里的字（包括方括号里的要求）抄进正文。',
].join('\n');

const NOTE_HEAD = [
  '# 高数',
  '> 日期：2026-10-28 ｜ 时长：52:14',
  '',
  '## 一句话概要',
  '',
  '这节课讲高阶导数的定义与算法。',
  '',
  '## 课堂脉络与重点',
  '',
  '1. **高阶导数的定义** `00:00`',
  '- 二阶导数是导数的导数。',
].join('\n');

/* ------------------------------------------------------------------ */
section('stripPromptLeaks：抄进来的「硬性要求」要删，附录要留');

{
  // 真实里最常见的样子：硬性要求抄在正文最后，后面紧跟 --- 和 <details>
  const md = `${NOTE_HEAD}\n\n${LEAK}\n\n${APPENDIX}`;
  const out = stripPromptLeaks(md);
  check('硬性要求那一段没了', !out.includes('硬性要求'), JSON.stringify(out.slice(-80)));
  check('附录还在（<details> 没被吃）', out.includes('<details>'));
  check('附录最后一行还在', out.trim().endsWith('</details>'));
  check('附录里的逐字稿没丢', out.includes('[00:23](#t=23.80)'));
  check('正文开头一字未动', out.startsWith('# 高数'));
  check('正文那一节还在', out.includes('二阶导数是导数的导数。'));
}

{
  // 硬性要求抄在中间，后面是本该保留的下一节
  const md = `${NOTE_HEAD}\n\n${LEAK}\n\n## 易错与易混\n\n- 别把二阶导写成一次导。\n`;
  const out = stripPromptLeaks(md);
  check('中间那段硬性要求没了', !out.includes('硬性要求'));
  check('它后面的下一节保住了', out.includes('## 易错与易混'));
  check('下一节的正文保住了', out.includes('别把二阶导写成一次导。'));
}

{
  // 硬性要求就在文末，后面什么都没有 —— 出口只有「文末」这一个
  const md = `${NOTE_HEAD}\n\n${LEAK}`;
  const out = stripPromptLeaks(md);
  check('文末那段硬性要求没了', !out.includes('硬性要求'));
  check('正文没被连坐', out.includes('二阶导数是导数的导数。'));
  check('末尾没有留下大段空白', !/\n{3,}/.test(out), JSON.stringify(out.slice(-40)));
}

{
  // 全角方括号里的写作要求（另一类泄漏）
  const md = '# 标题\n\n一句话概要。［40 字以内，说清这节课的主线。］\n\n## 关键词\n\n导数 · 加速度';
  const out = stripPromptLeaks(md);
  check('［…］里的要求没了', !out.includes('40 字以内'));
  check('括号外的正文还在', out.includes('一句话概要。'));
  check('后面的小节还在', out.includes('导数 · 加速度'));
}

{
  // 没有泄漏的笔记，一个字都不该变
  const md = `${NOTE_HEAD}\n\n${APPENDIX}`;
  check('干净的笔记原样返回', stripPromptLeaks(md) === md.trim());
}

{
  check('空输入不崩', stripPromptLeaks('') === '');
  check('undefined 不崩', stripPromptLeaks(undefined) === '');
}

/* ------------------------------------------------------------------ */
section('stripCheckSection：核对节要删，附录要留');

{
  const md = `${NOTE_HEAD}\n\n## 需要回听核对的地方\n\n- [05:56](#t=356) 请假条格式和要求。\n- [11:05](#t=665) 小组展示的具体要求。\n\n${APPENDIX}`;
  const out = stripCheckSection(md);
  check('核对节没了', !out.includes('需要回听核对的地方'));
  check('核对节里的条目也没了', !out.includes('请假条格式和要求。'));
  check('附录还在（这正是第一版的 bug）', out.includes('<details>'));
  check('附录里有时间戳的逐字稿还在', out.includes('[00:00](#t=0.00)'));
  check('收尾是 </details>', out.trim().endsWith('</details>'), JSON.stringify(out.slice(-30)));
  check('没有留下连续三个换行', !/\n{3,}/.test(out));
}

{
  // 核对节后面还有别的正文小节 —— 不能把后面那节删掉
  const md = `${NOTE_HEAD}\n\n## 需要回听核对的地方\n\n- 某处含糊。\n\n## 自测题\n\n1. 二阶导数是什么？\n`;
  const out = stripCheckSection(md);
  check('核对节没了（中间位置）', !out.includes('需要回听核对的地方'));
  check('它后面的「自测题」节保住了', out.includes('## 自测题'));
  check('自测题正文保住了', out.includes('1. 二阶导数是什么？'));
}

{
  // 核对节是最后一节，后面只有一条分隔线，没有附录
  const md = `${NOTE_HEAD}\n\n## 需要回听核对的地方\n\n- 某处含糊。\n\n---\n`;
  const out = stripCheckSection(md);
  check('核对节没了（文末）', !out.includes('需要回听核对的地方'));
  check('孤零零的分隔线也清掉了', !/^---$/m.test(out), JSON.stringify(out.slice(-40)));
  check('正文没被连坐', out.includes('二阶导数是导数的导数。'));
}

{
  // 没有核对节就该原样返回
  const md = `${NOTE_HEAD}\n\n${APPENDIX}`;
  check('没有核对节时原样返回', stripCheckSection(md) === md.trim());
}

{
  check('空输入不崩', stripCheckSection('') === '');
  check('undefined 不崩', stripCheckSection(undefined) === '');
}

/* ------------------------------------------------------------------ */
section('两道清洗串起来用（导出时的真实调用顺序）');

{
  const md = `${NOTE_HEAD}\n\n## 需要回听核对的地方\n\n- 某处含糊。\n\n${LEAK}\n\n${APPENDIX}`;
  const out = stripCheckSection(stripPromptLeaks(md));
  check('核对节没了', !out.includes('需要回听核对的地方'));
  check('硬性要求没了', !out.includes('硬性要求'));
  check('附录还在', out.includes('<details>') && out.trim().endsWith('</details>'));
  check('正文摘要还在', out.includes('这节课讲高阶导数的定义与算法。'));
  check('笔记正文明显短于原文', out.length < md.length * 0.85, `${out.length} / ${md.length}`);
  check('但附录一个字都没少', out.includes('[00:23](#t=23.80)'));
}

/* ------------------------------------------------------------------ */
console.log('');
if (fail) {
  console.log(`❌ ${pass} 通过 / ${fail} 失败`);
  for (const f of fails) console.log(`   - ${f}`);
  process.exit(1);
} else {
  console.log(`✅ 笔记清洗：${pass} 通过 / 0 失败`);
}
