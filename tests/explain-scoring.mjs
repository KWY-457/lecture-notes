/**
 * 演示「重点是怎么挑出来的」：对几句话打印打分明细。
 * 运行： node tests/explain-scoring.mjs
 */
import { explainCue, analyze, extractKeywords, toSentences } from '../public/summarize.js';

const SAMPLES = [
  '好，那我们今天接着讲二叉树的遍历。',
  '先明确一个定义：所谓二叉树的遍历，是指按照某种规则依次访问树中每个结点，并且每个结点只访问一次的过程。这个是今天的重点，考试一定会考。',
  '那么遍历主要有四种方式，第一种是先序遍历，顺序是根、左、右；第二种是中序遍历。',
  '举个例子，假设根节点是 5，左子树是 3，右子树是 8。',
  '我们再来看看时间复杂度。不管哪种遍历方式，每个结点都恰好被访问一次，所以时间复杂度都是 O(n)。',
  '作业是课后习题 6.3 到 6.8，下周三之前提交到学习通。',
  '嗯，那个，对吧，好不好。',
];

console.log('\n=== 一、线索词打分（cue 分：决定「像不像重点」）===\n');
for (const s of SAMPLES) {
  const r = explainCue(s);
  const tags = r.hits.map((h) => `${h.label}${h.w > 0 ? '+' : ''}${h.w}`).join('  ');
  console.log(`  ${String(r.score).padStart(6)}  ${s.slice(0, 46)}${s.length > 46 ? '…' : ''}`);
  console.log(`          ${tags || '（没有任何线索词）'}`);
}

console.log('\n=== 二、关键词凭什么算「词」===\n');
const segs = [
  [0, 40, '好，那我们今天接着讲二叉树的遍历。上节课我们讲了树的基本概念，树是由 n 个结点组成的有限集合。'],
  [40, 90, '先明确一个定义：所谓二叉树的遍历，是指按照某种规则依次访问树中每个结点，并且每个结点只访问一次的过程。这个是今天的重点，考试一定会考。'],
  [90, 150, '那么遍历主要有四种方式，第一种是先序遍历，顺序是根、左、右；第二种是中序遍历，顺序是左、根、右；第三种是后序遍历，顺序是左、右、根；第四种是层序遍历。'],
  [150, 210, '这里特别要注意的是，中序遍历在二叉搜索树上的结果一定是一个递增序列，这个性质非常关键，大家一定要记住。'],
  [210, 260, '接下来我们看遍历的实现。因为树本身是递归定义的，所以递归实现是最自然的，先序遍历的代码就是先访问根节点，然后递归遍历左右子树。'],
  [260, 320, '但是递归有一个问题，就是当树很深的时候会导致栈溢出，所以实际工程中我们往往用非递归的方式，借助栈来模拟递归过程。'],
  [320, 380, '非递归的先序遍历思路是：第一，把根节点入栈；第二，弹出栈顶元素并访问；第三，如果右孩子不为空就入栈；第四，如果左孩子不为空就入栈。'],
  [380, 440, '我们再来看看时间复杂度。不管哪种遍历方式，每个结点都恰好被访问一次，所以时间复杂度都是 O(n)，空间复杂度取决于树的高度。'],
  [440, 500, '最后总结一下今天的重点：第一，四种遍历方式的访问顺序必须背下来；第二，中序遍历二叉搜索树得到递增序列这个性质要会用。'],
].map(([start, end, text]) => ({ start, end, text }));

const { sentences } = toSentences(segs);
console.log('  最终选出的关键词（按分数排序）：');
extractKeywords(sentences, 14).forEach((k, i) => {
  console.log(`    ${String(i + 1).padStart(2)}. ${k.term.padEnd(8)} 出现 ${k.count} 次`);
});
console.log('\n  对比：如果用「所有 2-4 字组合」的朴素做法，会混进');
console.log('    「叉树的」「树的遍」「代码就」「间复杂」这类切错边界的碎片 ——');
console.log('    边界熵 + 独立成词率这两个统计量就是专门用来干掉它们的。');

console.log('\n=== 三、完整打分公式（每个主题内选重点句）===\n');
console.log('  score = ( ln(TextRank) × 1.5  +  cue分  +  命中关键词数 × 0.55 )');
console.log('          × 长度权重（>120字 ×0.75，>90字 ×0.9）');
console.log('          × 位置权重（段首 ×1.12，线性衰减到段尾 ×1.0）');
console.log('  约束：短于 8 字丢弃；与已选句词汇重叠 > 0.52 丢弃（去重）；每个主题最多 6 条');

console.log('\n=== 四、跑一遍真实流程，看每个主题挑出了什么 ===\n');
const note = analyze({ segments: segs, meta: { title: '演示课', duration: 500 }, options: { style: 'exam', maxPointsPerTopic: 5 } });
for (const t of note.outline) {
  console.log(`  主题 ${t.index}：${t.heading}   [${Math.round(t.start)}s 起]`);
  for (const p of t.points) {
    const c = explainCue(p.text);
    console.log(`      · ${p.text.slice(0, 52)}${p.text.length > 52 ? '…' : ''}   cue=${c.score}`);
  }
  console.log('');
}
console.log(`  一句话概要：${note.summary}`);
console.log(`  自测题 ${note.questions.length} 条，定义 ${note.definitions.length} 条，分条列举 ${note.enumerations.length} 条`);
