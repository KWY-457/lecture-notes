/**
 * 逐字稿清洗 + 思维导图导出的自测
 * 运行： node tests/test-cleanup.mjs
 *
 * 本文件在「换掉手写繁简表 + 改用白名单收窄」之后扩写过，
 * 新增的重点是三件：①真实记录的繁体形必须清零 ②白名单不能误删正文
 * ③全角 ASCII 是救回内容而不是删掉。
 */
import fs from 'node:fs';
import path from 'node:path';
import { cleanLine, cleanSegments, diffCount, collapseRepetition, hallucinationScore, emptyStats, describeStats } from '../public/cleanup.js';
import { T2S_MAP } from '../public/t2s-table.js';
import { outlineToMermaid, outlineToOpml, extractJson } from '../public/llm.js';

let pass = 0, fail = 0;
const check = (n, c, d = '') => { c ? pass++ : fail++; console.log(`  ${c ? '✅' : '❌'} ${n}${c ? '' : '  → ' + d}`); };
const ROOT = path.join(import.meta.dirname, '..');

console.log('\n=== 清洗（确定性部分）===\n');
const cases = [
  ['繁转简', '我們說這個問題要記住', '我们说这个问题要记住'],
  ['繁转简(多字词)', '錄音裏面的內容', '录音里面的内容'],
  ['半角标点转全角', '这个,那个.对吗?', '这个，那个。对吗？'],
  ['去掉特殊token', '今天讲<|notimestamps|>了二叉树', '今天讲了二叉树'],
  ['去掉emoji', '重点是 🎯 这个', '重点是这个'],
  ['合并重复标点', '很好。。。是的，，，', '很好。是的'],
  ['去中文字间空格', '这 个 是 重点', '这个是重点'],
  ['小数不误伤', '复杂度是 0.5 到 1.5', '复杂度是 0.5 到 1.5'],
];
for (const [name, input, want] of cases) {
  const got = cleanLine(input);
  check(name, got === want, JSON.stringify(got) + ' ≠ ' + JSON.stringify(want));
}
const segs = cleanSegments([{ start: 0, end: 5, text: '我們說這個問題<|x|> 🎯' }]);
check('cleanSegments 保留时间戳', segs[0].start === 0 && segs[0].end === 5, JSON.stringify(segs));

console.log('\n=== 繁→简换代（旧手写表在真实记录上能处理 0 个，必须全补上）===\n');
const t2sCases = ['回覆', '高興', '輕鬆', '一隻', '這裡', '剩餘', '關於', '頭髮', '發送', '這一遍'];
for (const s of t2sCases) {
  const out = cleanLine(s);
  const noTrad = [...out].every((c) => !T2S_MAP.has(c));
  check(`${s} → ${out}`, noTrad && out.length === s.length, out);
}

console.log('\n=== 真实记录：繁体形清零 + 字符数不增长 ===\n');
const tfiles = fs.readdirSync(path.join(ROOT, 'data', 'lectures'))
  .map((d) => path.join(ROOT, 'data', 'lectures', d, 'transcript.json')).filter((f) => fs.existsSync(f));
let tradBeforeAll = 0, tradAfterAll = 0, grew = 0;
const stats = emptyStats();
for (const f of tfiles) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const rawSegs = j.segments || [];
  let tradBefore = 0, nBefore = 0;
  for (const s of rawSegs) { const t = String(s.text || ''); nBefore += [...t].length; for (const c of t) if (T2S_MAP.has(c)) tradBefore++; }
  const cleaned = cleanSegments(rawSegs, stats);
  let tradAfter = 0, nAfter = 0;
  for (const s of cleaned) { const t = String(s.text || ''); nAfter += [...t].length; for (const c of t) if (T2S_MAP.has(c)) tradAfter++; }
  tradBeforeAll += tradBefore; tradAfterAll += tradAfter;
  if (nAfter > nBefore) grew++;
  console.log(`  ${path.basename(path.dirname(f)).slice(0, 8)}  段 ${rawSegs.length}  繁体形 ${tradBefore} → ${tradAfter}  字符 ${nBefore} → ${nAfter}`);
}
check(`真实记录繁体形清零（${tradBeforeAll} → ${tradAfterAll}）`, tradAfterAll === 0, `残留 ${tradAfterAll}`);
check('真实记录清理后字符数不增长', grew === 0, `${grew} 条记录变长`);
console.log(`  统计：${describeStats(stats) || '（无改动）'}`);

console.log('\n=== 白名单收窄（「不明字符」的真实来源）===\n');
const junk = [
  ['半角片假名 U+FF61-FF9F', 'ｱｲｳｴｵ', '老师说'],
  ['注音符号 U+3100-312F', 'ㄅㄆㄇㄈ', '老师说'],
  ['谚文 U+AC00-D7AF', '안녕', '老师说'],
  ['日文假名 U+3040-30FF', 'こん', '老师说'],
  ['CJK 兼容汉字 U+F900-FAFF（归一化救回）', '神都', '老师神都说'],
  ['康熙部首 U+2F00-2FDF（归一化救回）', '⾔⾷', '老师言食说'],
  ['私用区 U+E000-F8FF', '\uE000\uE001', '老师说'],
  ['私用区补充平面 U+F0000+', '\u{F0000}', '老师说'],
  ['箭头 U+2190-21FF', '←→', '老师说'],
  ['数学运算符 U+2200-22FF', '∀∂', '老师说'],
  ['几何图形 U+25A0-25FF', '■▲', '老师说'],
  ['零宽字符 U+200B-200F', '前\u200B后\u200D', '老师前后说'],
  ['变体选择符 U+FE00-FE0F', '字\uFE0F', '老师字说'],
  ['BOM U+FEFF', '\uFEFF', '老师说'],
];
for (const [name, s, want] of junk) {
  const got = cleanLine(`老师${s}说`);
  check(`清掉 ${name}`, got === want, `${JSON.stringify(got)} ≠ ${JSON.stringify(want)}  [in=${[...s].map((c) => c.codePointAt(0).toString(16)).join(',')} out=${[...got].map((c) => c.codePointAt(0).toString(16)).join(',')}]`);
}

console.log('\n=== 白名单不能误伤 ===\n');
check('生僻人名（扩展 A 㛃㵘）保留', cleanLine('她叫㛃㵘') === '她叫㛃㵘', cleanLine('她叫㛃㵘'));
check('常用汉字保留', cleanLine('今天讲第三章第五节。') === '今天讲第三章第五节。', cleanLine('今天讲第三章第五节。'));
check('全角括号注释保留', cleanLine('（放入冰箱）然后关门') === '（放入冰箱）然后关门', cleanLine('（放入冰箱）然后关门'));
check('破折号与间隔号保留', cleanLine('甲—乙·丙') === '甲—乙·丙', cleanLine('甲—乙·丙'));

console.log('\n=== 全角 ASCII 转半角（救回内容，不是删掉）===\n');
check('全角字母', cleanLine('这是ＡＢＣ测试') === '这是ABC测试', cleanLine('这是ＡＢＣ测试'));
check('全角数字', cleanLine('共１２３人') === '共123人', cleanLine('共１２３人'));
check('全角混排', cleanLine('ＧＰＴ４很强') === 'GPT4很强', cleanLine('ＧＰＴ４很强'));

console.log('\n=== 统计出口 ===\n');
const st = emptyStats();
cleanLine('我們說這個問題ｱｲｳ', st);
check('stats 记到繁→简 6 字', st.simplified === 6, JSON.stringify(st));
check('stats 记到清掉 3 个非正文', st.dropped === 3, JSON.stringify(st));
check('describeStats 能描述', typeof describeStats(st) === 'string' && describeStats(st).includes('繁→简'), String(describeStats(st)));

console.log('\n=== 幻觉治理（重复循环折叠）===\n');
const repCases = [
  ['短语连续重复', '这个地方，这个地方，这个地方，这个地方，好', '这个地方，好'],
  ['单字连续重复', '和三角形臂全面就说形形形形形形形形形形', '和三角形臂全面就说形'],
  ['短句连续重复', '还有一个还有一个还有一个还有一个', '还有一个'],
  ['正常句子不受影响', '先序遍历是根左右，中序遍历是左根右', '先序遍历是根左右，中序遍历是左根右'],
  ['叠词不该被吃掉', '大家好好听讲，慢慢来', '大家好好听讲，慢慢来'],
];
for (const [name, input, want] of repCases) {
  const got = collapseRepetition(input);
  check(name, got === want, JSON.stringify(got) + ' ≠ ' + JSON.stringify(want));
}
check('cleanLine 会自动折叠重复', cleanLine('这个地方，这个地方，这个地方。') === '这个地方。', cleanLine('这个地方，这个地方，这个地方。'));

console.log('\n=== 幻觉可疑度打分 ===\n');
const hallCases = [
  ['正常讲课句', '先明确一个定义：所谓二叉树的遍历，是指按照某种规则依次访问树中每个结点。', 8, false],
  ['疯狂重复', '形形形形形形形形形形形形形形形形形形形形形形形形形形形形形形', 5, true],
  ['语速离谱', '这是完全不可能在两秒内说完的超级无敌长的内容我要一直说下去不停下来继续说说说说说说说', 2, true],
];
for (const [name, text, dur, wantSuspect] of hallCases) {
  const sc = hallucinationScore(text, dur);
  check(`${name}（得分 ${sc.toFixed(2)}）`, (sc >= 0.5) === wantSuspect, `期望${wantSuspect ? '可疑' : '正常'}，实得 ${sc.toFixed(2)}`);
}
const flagged = cleanSegments([{ start: 0, end: 5, text: '形形形形形形形形形形形形形形形形形形形形' }]);
check('cleanSegments 会打上 suspect 标记（按原文判断）', flagged[0].suspect === 1, JSON.stringify(flagged[0]));
check('cleanSegments 同时把重复折掉了', flagged[0].text === '形', JSON.stringify(flagged[0].text));
check('diffCount 能统计变化', diffCount([{ text: '我們說' }], [{ text: '我们说' }]) >= 1, '');

console.log('\n=== 思维导图 / 课程定位的输出结构 ===\n');
const outline = [
  { heading: '遍历方式', start: 0, points: [{ text: '先序：根左右' }, { text: '中序：左根右' }] },
  { heading: '时间复杂度', start: 100, points: [{ text: 'O(n)' }] },
];
const md = outlineToMermaid(outline, '二叉树的遍历');
check('Mermaid mindmap 头', md.startsWith('mindmap') && md.includes('root(('), md.split('\n')[0]);
check('Mermaid 含主题', md.includes('遍历方式') && md.includes('时间复杂度'), '');
const opml = outlineToOpml(outline, '二叉树的遍历');
check('OPML 是合法 xml', opml.startsWith('<?xml') && opml.includes('<opml version="2.0">'), '');
check('OPML 含主题与要点', opml.includes('遍历方式') && opml.includes('先序：根左右'), '');
check('OPML 转义', outlineToOpml([{ heading: 'a<b', points: [] }]).includes('a&lt;b'), '');

console.log('\n=== extractJson 容错 ===\n');
check('裸数组', Array.isArray(extractJson('[{"a":1}]')), '');
check('带围栏', Array.isArray(extractJson('```json\n[{"a":1}]\n```')), '');
check('前后有废话', Array.isArray(extractJson('好的，结果如下：[{"a":1}] 完毕')), '');
check('对象', extractJson('{"course":"数据结构"}').course === '数据结构', '');
check('坏输入返回 null', extractJson('没有 json') === null, '');

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
process.exitCode = fail ? 1 : 0;
