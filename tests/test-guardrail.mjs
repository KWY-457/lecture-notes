/**
 * 通用核对机制自测（2026-10 重写）。
 *
 * 背景：旧版这里是「姓氏表 + 称谓表 + 量词表」三张枚举表，
 * 换个学科就失效 —— 高数课的公式、英语课的单词、化学课的分子式全在表外。
 * 老大当时的原话：「如果换一个高数课的录音……你要怎么做？一个个试？穷举法？」
 *
 * 现在测的是**不依赖词表**的机制：
 *   findUnverifiedFacts  —— 原子片段（数字/英文词）逐一对齐原文，不做量词白名单；
 *   findSuspiciousTerms  —— 用笔记自身的词汇分布（extractKeywords 边界熵）挑可疑片段。
 *
 * 重点全在**误报**：宁可漏，不可吵。所有用例都是离线的，不联网。
 */
import { findUnverifiedFacts, findSuspiciousTerms, coreDiff, alignByCore, looksLikeTypo, editDistance } from '../public/llm.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${extra}`);
  }
}
const seg = (text) => ({ start: 0, end: 1, text });
const src = (...lines) => lines.join('');

// ─────────────────────────────────────────────────────────
console.log('【1】中文量词对不上要报（不靠量词表，靠比对原文那个位置的字）');
{
  const text = src('他3年的时间交出量眼，实验室发表4天高水平ICI。');
  const md = '### 1. 成就\n- 3 年后发表 4 篇高水平论文。';
  const hits = findUnverifiedFacts(md, text);
  check('抓到「4 篇」（原文是「4 天」）', hits.some((h) => h.startsWith('4')), JSON.stringify(hits));
  check('「3 年」不误报（原文就是 3 年）', !hits.some((h) => h.startsWith('3')), JSON.stringify(hits));
}

console.log('【1b】量词换成同义说法（9 个 → 9 人）不许报');
{
  // 老师口述「只有 9 个人获得」，笔记写「仅 9 人获此殊荣」—— 这是正常书面化，
  // 量词从「个」换成「人」，但「人」这个字老师确实说过，不算编造。
  // 判据不是量词表，而是「这个量词字在逐字稿里出现过没有」。
  const text = src('只有9个人获得的这个评家，接受过他帮助的人多达3.7万人。');
  const md = '- 5 年获得全国诚信表彰，仅 9 人获此殊荣';
  const hits = findUnverifiedFacts(md, text);
  check('「9 人」不误报', hits.length === 0, JSON.stringify(hits));
  // 但换成原文里根本没出现过的量词，仍然要报
  const hits2 = findUnverifiedFacts('- 仅 9 项获此殊荣', text);
  check('「9 项」（全文无此字）要报', hits2.length === 1, JSON.stringify(hits2));
}

console.log('【2】原文根本没有的数字要报');
{
  const hits = findUnverifiedFacts('- 他获得了 27 项专利。', '他做了很多研究，很厉害。');
  check('抓到「27」', hits.some((h) => h.startsWith('27')), JSON.stringify(hits));
}

console.log('【3】原文有的数字、量词也对 → 不许报');
{
  const text = src('入伍52年，参与了我国全部45次的核试验，接受过他帮助的人多达3.7万人。');
  const md = '- 入伍 52 年\n- 参与全部 45 次核试验\n- 帮助过 3.7 万人';
  check('无误报', findUnverifiedFacts(md, text).length === 0, JSON.stringify(findUnverifiedFacts(md, text)));
}

console.log('【4】时间戳 / 日期 / 序号 / 区间 —— 四类噪声一个都不许报');
{
  // 笔记头部那行是我们用真实元数据写的，不是模型编的
  const md = [
    '> 课程：思想道德与法治 ｜ 日期：2026-10-15 ｜ 时长：09:05',
    '',
    '### 1. 乐观精神 [00:00](#t=0)',
    '- 要点一 [02:56](#t=176)',
    '- 要点二 [01:28:04](#t=5284)',
    '',
    '1. 第一条',
    '2. 第二条',
    '',
    '- 时间跨度（2024-2027）是关键',
    '- 也写作 2024~2027',
  ].join('\n');
  const text = src('2024到2027年4年之间要花费16亿美金。');
  const hits = findUnverifiedFacts(md, text);
  check('无误报', hits.length === 0, JSON.stringify(hits));
}

console.log('【5】上一轮自己写进「需要回听核对的地方」的警告不许自己查自己');
{
  const md = [
    '## 课堂脉络',
    '- 正常内容。',
    '',
    '## 需要回听核对的地方',
    '- ⚠ 下列数字在逐字稿里对不上，可能是模型补的，请谨慎采信：99、888',
  ].join('\n');
  check('警告行被排除', findUnverifiedFacts(md, '这里什么都没说。').length === 0);
}

console.log('【6】逐字稿附录（<details>）里的数字不算依据，也不算可疑');
{
  const md = [
    '- 正文没数字。',
    '',
    '<details><summary>逐字稿</summary>',
    '',
    '[00:00] 这里有一堆 123 456 789 的数字。',
    '',
    '</details>',
  ].join('\n');
  check('附录内容被排除', findUnverifiedFacts(md, '正文只有这句话。').length === 0);
}

// ─────────────────────────────────────────────────────────
console.log('【7】英文词：原文没有的才报，大小写不敏感');
{
  const text = '今天我们讲 opportunity cost，也就是机会成本。';
  check('原文有的英文不报', findUnverifiedFacts('- Opportunity 是这个概念的核心', text).length === 0);
  check(
    '原文没有的英文要报',
    findUnverifiedFacts('- 这就是 sunk cost fallacy 的典型例子', text).some((h) => /sunk/i.test(h))
  );
}

console.log('【8】高数课：公式符号本来就不会出现在语音转写里，不许拿它报错');
{
  const text = '这个极限等于三，根据洛必达法则，上下同时求导。';
  const md = '### 1. 洛必达法则\n- $\\lim_{x\\to 0} \\frac{\\sin x}{x} = 1$\n- 上下同时求导即可。';
  // 公式写在 $…$ 里，不含数字时不该产生任何告警；
  // 这条用例锁的是「不许因为符号对不上就报错」这个行为。
  const hits = findUnverifiedFacts(md, text);
  check('公式里的符号不产生误报', hits.length === 0, JSON.stringify(hits));
}

console.log('【9】化学课：数字必须对得上，下标不算');
{
  const text = '硫酸的分子量是98，我们配成零点五摩尔每升的溶液。';
  const md = '- H2SO4 的分子量是 98，配成 0.5 mol/L 的溶液。';
  const hits = findUnverifiedFacts(md, text);
  check('98 与 0.5 都不误报', hits.length === 0, JSON.stringify(hits));
  check(
    '改成 108 就要报',
    findUnverifiedFacts('- 分子量是 108。', text).some((h) => h.startsWith('108'))
  );
}

// ─────────────────────────────────────────────────────────
console.log('【10】可疑片段：笔记里反复出现、逐字稿里找不到的才进候选');
{
  const text =
    '这个林俊泽院士啊，他讲了自己入伍五十二年的经历。那个乐观的精神很重要。' +
    '他还说了自己在实验室里做研究的事情，条件很艰苦，但是他一直坚持下来了，这一点特别值得学习。' +
    '同学们听完以后都很有感触，觉得应该像他那样对待自己的专业和工作。';
  const md = [
    '## 课堂脉络与重点',
    '### 1. 林俊德院士的奉献',
    '- 林俊德院士隐姓埋名五十二年，退休后仍坚守岗位。',
    '- 林俊德院士代表了老一辈科研工作者的奉献精神。',
    '- 奉献精神是他一生的底色，也是这门课最想讲清楚的东西。',
    '### 2. 乐观精神',
    '- 乐观精神帮助个体在困境中突破自我，这一点在案例里体现得很清楚。',
    '- 乐观精神不是盲目的自信，而是建立在对现实清醒认识之上的态度。',
  ].join('\n');
  const all = findSuspiciousTerms(md, text);
  const terms = all.map((t) => t.text);
  check('抓到「林俊德」（逐字稿里是「林俊泽」）', terms.some((t) => t.includes('林俊德')), JSON.stringify(terms));
  // 「乐观精神」在原文里是「乐观的精神」—— 去掉口语虚字后能对上，
  // 所以它照样进候选（专名同音误识要靠模型的知识才看得出来，不能提前筛掉），
  // 但必须被标成「原文有」，这样提示词里会喂原文上下文，模型才好判断。
  const optimistic = all.find((t) => t.text === '乐观精神');
  check('「乐观精神」照进候选，但标成「原文有」', !!optimistic && optimistic.inSource === true, JSON.stringify(all));
  check('每条都带上下文', all.every((t) => typeof t.ctx === 'string'));
}

console.log('【11】可疑片段不许是半句话 / 跨句拼接');
{
  const text = '完全无关的一段话，什么都没有。';
  const md = [
    '## 课堂脉络',
    '- 这个结论的本质是意识形态的渗透。',
    '- 它的本质是意识形态的渗透。',
    '- 所以我们说本质是意识形态的渗透。',
  ].join('\n');
  const terms = findSuspiciousTerms(md, text).map((t) => t.text);
  // 这类词在原文里确实没有，但它们是**正常行文**，不是专名。
  // 允许进候选（交给模型判 ok），但绝不许出现跨句拼接的垃圾。
  check(
    '没有跨句拼接的碎片',
    terms.every((t) => !/。|，|、|的$|^的/.test(t)),
    JSON.stringify(terms)
  );
  check('每条长度 >= 3', terms.every((t) => t.length >= 3), JSON.stringify(terms));
}

console.log('【12】空输入不崩');
{
  check('空 markdown', findUnverifiedFacts('', '有内容') .length === 0);
  check('null markdown', findUnverifiedFacts(null, '有内容').length === 0);
  check('空原文', findUnverifiedFacts('- 有 123 个', '').length === 0);
  check('空 segments 不崩', findSuspiciousTerms('', []).length === 0);
  check('null 不崩', findSuspiciousTerms(null, null).length === 0);
  check('纯英文不崩', findSuspiciousTerms('# Title\n- hello world hello world', 'x').length === 0);
}

console.log('【13】字符串数组形式的 segments 也认');
{
  check(
    '字符串数组',
    findUnverifiedFacts('- 提到 42 次', ['一共', '提了 42 次']).length === 0
  );
}

console.log('【14】同一处误识在正文别处也要对齐（差异核心 + 邻字把关）');
{
  // 实测出来的场景：模型判「斗争性与成因性 → 斗争性与同一性」，
  // 可关键词行里还孤零零躺着一个「成因性」，改完正文自相矛盾。
  const d = coreDiff('斗争性与成因性', '斗争性与同一性');
  check('取到差异核心', !!d && d.wrong === '成因' && d.right === '同一', JSON.stringify(d));
  check('核心带回左邻字', !!d && d.left === '与', JSON.stringify(d));
  check('核心带回右邻字', !!d && d.rightChar === '性', JSON.stringify(d));

  const md = '- 关键词：矛盾 · 斗争性 · 成因性\n- 矛盾的斗争性与成因性同时存在。';
  const r = alignByCore(md, d);
  check('两处都改了', r.hits === 2, String(r.hits));
  check('正文里不剩「成因性」', !r.body.includes('成因性'), r.body);
  check('改成了「同一性」', r.body.split('同一性').length - 1 === 2, r.body);

  // 邻字把关：正常词里的同一个核心不许动
  const keep = alignByCore('这是成因分析，而矛盾的斗争性与成因性同时存在。', d);
  check('「成因分析」保留', keep.body.includes('成因分析'), keep.body);
  check('只改了该改的那处', keep.hits === 1, String(keep.hits));

  // 单字差异不做全文对齐 —— 全局替换一个「泽」字太危险
  check('林俊泽→林俊德 不产生核心', coreDiff('林俊泽', '林俊德') === null);
  check('只差一个字也不做', coreDiff('斗争性', '斗争性与同一性') === null);
  check('完全相同不做', coreDiff('乐观精神', '乐观精神') === null);
  check('空值不崩', coreDiff('', 'x') === null && coreDiff(null, null) === null);
  check('alignByCore 空 core 不崩', alignByCore('abc', null).body === 'abc');
}


console.log('【15】改错必须「改动很小」，不许拿甲的名字顶替乙');
{
  check('林俊泽→林俊德 算错字', looksLikeTypo('林俊泽', '林俊德') === true);
  check('斗争性与成因性→斗争性与同一性 算错字', looksLikeTypo('斗争性与成因性', '斗争性与同一性') === true);
  check('白童失马→塞翁失马 算错字', looksLikeTypo('白童失马', '塞翁失马') === true);
  check('杨女士→林俊德 不算（三个字全不同）', looksLikeTypo('杨女士', '林俊德') === false);
  check('乐观精神→林俊德 不算', looksLikeTypo('乐观精神', '林俊德') === false);
  check('长串替短词 不算', looksLikeTypo('林俊泽院士的事迹', '林俊德') === false);
  check('亿美金→16亿美金用于对华舆论战 不算', looksLikeTypo('亿美金', '16亿美金用于对华舆论战') === false);
  check('相同不算', looksLikeTypo('乐观精神', '乐观精神') === false);
  check('空值不崩', looksLikeTypo('', 'x') === false && looksLikeTypo(null, null) === false);
  check('编辑距离正确', editDistance('kitten', 'sitting') === 3 && editDistance('abc', 'abc') === 0);
}

console.log('【16】离线笔记自己生成的词频标注 / 页脚 / 自测题，不算「模型编的」');
{
  const text = src('递归就是把问题变成同样的小问题，左孩子和右孩子分别处理。二叉树的遍历有四种方式。');
  // 离线引擎的关键词行：`递归 (11) · 左孩子 (4)`
  const md = '## 关键词\n\n递归 (11) · 左孩子 (4) · 右孩子 (3)\n\n- 递归调用自己。';
  const hits = findUnverifiedFacts(md, text);
  check('词频里的数字不报（11 / 4 / 3）', hits.length === 0, JSON.stringify(hits));

  // 正文里的函数调用、次方不许被当成词频删掉（用两位数，个位数本来就不报）
  const hits2 = findUnverifiedFacts('- 复杂度是 O(n^2)，调用 f(19) 一次。', text);
  check('正文里的 f(19) 照常核对', hits2.some((x) => x.includes('19')), JSON.stringify(hits2));

  // 离线引擎页脚：产品名不是老师讲的
  const foot = '\n\n---\n\n*由「讲义笔记 LectureNotes」自动整理生成（离线引擎）。自动提取可能有遗漏，请对照逐字稿校核。*';
  const hits3 = findUnverifiedFacts(`- 递归调用自己。${foot}`, text);
  check('页脚产品名不报', hits3.length === 0, JSON.stringify(hits3));

  // 自测题是「问题」不是「陈述」，不该进候选（离线引擎会写「请分条列举」「举个例子」）
  const withQ = '- 递归调用自己。\n\n## 自测题（遮住上面，试着回答）\n\n1. 「递归」包含哪几个要点？请分条列举。\n2. 举个例子说明左孩子。\n';
  const terms = findSuspiciousTerms(withQ, text, { limit: 100 }).map((t) => t.text);
  check('自测题的套话不进候选', !terms.some((t) => t.includes('分条列举') || t.includes('举个例子')), JSON.stringify(terms));
}

console.log('');
console.log('【末】公式里的数字不核对（老大 2026-10-28 定的：治高数这类误报）');
{
  // 老师的口头语「二分之三倍的根号三」，逐字稿里只有这句，不会出现 `3√3/2`
  const text = src(
    '就相当于前面是十六分之四，加上什么呢？这是二分之三倍的根号三，我们给它平个方。',
    '这一下呢，你把那个 x 等于一代进去，就能算出来这个斜率是负的。'
  );
  // 实测 cc9c9d21 那一篇的原句（以前这 4 行一共报 5 条，全是误报）
  const md = [
    '- 例题2：椭圆x²/16 + y²/9 = 1在(2,3√3/2)处的切线',
    '- 求椭圆9x²+4y²=36在(1,3√3/2)处的切线斜率',
    '7. x³+y³-3xy=0在(1,1)处的dy/dx值是多少？',
    '- 示例：x - y + 0.5siny = 0的二阶导含(2-cosy)³分母',
  ].join('\n');
  const hits = findUnverifiedFacts(md, text);
  check('坐标列表 (2,3√3/2) 不报', !hits.some((h) => h.startsWith('2,3')), JSON.stringify(hits));
  check('坐标列表 (1,1) 不报', !hits.some((h) => h.startsWith('1,1')), JSON.stringify(hits));
  check('带字母的系数 0.5siny 不报', !hits.some((h) => h.startsWith('0.5')), JSON.stringify(hits));
  check('等式里的 36 不报', !hits.some((h) => h.startsWith('36')), JSON.stringify(hits));
  check('整篇一条都不报（实测这 5 条以前全是误报）', hits.length === 0, JSON.stringify(hits));

  // 别把主判据一起放掉：叙述里的数字照旧要报
  const md2 = '- 他扎根基层 30 年，记下 283 本工作笔记，化解 2500 余起纠纷。';
  const text2 = src('他在基层干了三十年，记录了工作笔记，也化解了很多矛盾。');
  const hits2 = findUnverifiedFacts(md2, text2);
  check('叙述里的「283 本」照旧报（这才是这个功能的价值）', hits2.some((h) => h.startsWith('283')), JSON.stringify(hits2));

  // 「45°辅助线」老师没说过这个角度 → 度数不是式子，必须报
  const md3 = '- 需要把坐标通过45°辅助线转换到侧面投影。';
  const text3 = src('你需要把那个点转到侧面去，用一个辅助线就行。');
  const hits3 = findUnverifiedFacts(md3, text3);
  check('「45°」属于事实不是式子，照旧报', hits3.some((h) => h.startsWith('45')), JSON.stringify(hits3));
}

console.log('');
console.log(fail === 0 ? `✅ 通用核对：${pass} 通过 / 0 失败` : `❌ ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
