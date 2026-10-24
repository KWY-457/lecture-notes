/**
 * 离线引擎自测：用一段模拟的中文课堂转写内容跑通全流程。
 * 运行： node tests/test-summarize.mjs
 */
import { analyze, toSentences, extractKeywords, splitSentences } from '../public/summarize.js';

const raw = [
  [0, 32, '好，那我们今天接着讲二叉树的遍历。上节课我们讲了树的基本概念，大家还记得吧，树是由 n 个结点组成的有限集合。'],
  [32, 78, '先明确一个定义：所谓二叉树的遍历，是指按照某种规则依次访问树中每个结点，并且每个结点只访问一次的过程。这个是今天的重点，考试一定会考。'],
  [78, 140, '那么遍历主要有四种方式，第一种是先序遍历，顺序是根、左、右；第二种是中序遍历，顺序是左、根、右；第三种是后序遍历，顺序是左、右、根；第四种是层序遍历，也就是一层一层从左到右访问。'],
  [140, 196, '这里特别要注意的是，中序遍历在二叉搜索树上的结果一定是一个递增序列，这个性质非常关键，经常用来判断一棵树是不是二叉搜索树，大家一定要记住。'],
  [196, 250, '举个例子，假设根节点是 5，左子树是 3，右子树是 8，那么中序遍历的结果就是 3, 5, 8，可以看到它确实是递增的。'],
  [250, 310, '接下来我们看遍历的实现。因为树本身是递归定义的，所以递归实现是最自然的，先序遍历的代码就是先访问根节点，然后递归遍历左子树，再递归遍历右子树，三行代码就写完了。'],
  [310, 372, '但是递归有一个问题，就是当树很深的时候会导致栈溢出，所以实际工程中我们往往用非递归的方式，也就是借助栈来模拟递归过程，把递归改成迭代。'],
  [372, 430, '非递归的先序遍历思路是：第一，把根节点入栈；第二，弹出栈顶元素并访问；第三，如果右孩子不为空就入栈；第四，如果左孩子不为空就入栈。注意顺序不能反，因为栈是后进先出。'],
  [430, 490, '那么为什么先入右孩子再入左孩子呢？因为栈是后进先出，我们希望左孩子先被访问，所以左孩子要后入栈，这样它就在栈顶。这个地方很容易搞错，考试的时候很多同学都在这里丢分。'],
  [490, 545, '我们再来看看时间复杂度。不管哪种遍历方式，每个结点都恰好被访问一次，所以时间复杂度都是 O(n)，空间复杂度取决于树的高度，最坏情况下是 O(n)，平均是 O(log n)。'],
  [545, 600, '最后总结一下今天的重点：第一，四种遍历方式的访问顺序必须背下来；第二，中序遍历二叉搜索树得到递增序列这个性质要会用；第三，递归和非递归两种实现都要会写。'],
  [600, 650, '作业是课后习题 6.3 到 6.8，下周三之前提交到学习通，另外预习一下线索二叉树的内容，下次课我们讲。'],
  [650, 690, '好，那今天就到这里，下课。'],
];

const segments = raw.map(([start, end, text]) => ({ start, end, text }));

console.log('=== 分句自检 ===');
const sents = splitSentences('先明确一个定义：所谓二叉树的遍历，是指按照某种规则依次访问树中每个结点，并且每个结点只访问一次的过程。这个是今天的重点，考试一定会考。');
console.log(sents.map((s) => '  · ' + s).join('\n'));

console.log('\n=== 时间轴映射自检 ===');
const { sentences, hasTime } = toSentences(segments);
console.log(`句子数=${sentences.length} hasTime=${hasTime}`);
console.log(sentences.slice(0, 3).map((s) => `  [${s.start}-${s.end}] ${s.text}`).join('\n'));

console.log('\n=== 关键词自检 ===');
console.log('  ' + extractKeywords(sentences, 14).map((k) => `${k.term}(${k.count})`).join(' · '));

console.log('\n=== 完整流程 ===');
const note = analyze({
  segments,
  meta: { title: '数据结构 · 二叉树的遍历', course: '数据结构', duration: 690, engine: 'demo' },
  options: { style: 'exam', maxPointsPerTopic: 5, topKeywords: 16 },
});

console.log('stats:', JSON.stringify(note.stats));
console.log('summary:', note.summary);
console.log('\n--- 主题大纲 ---');
for (const t of note.outline) {
  console.log(`  ${t.index}. ${t.heading}  [${t.start}-${t.end}s] ${t.points.length} 个重点`);
  for (const p of t.points) console.log(`       - ${p.text.slice(0, 60)}`);
}
console.log('\n--- 定义 ---');
for (const d of note.definitions) console.log(`  ${d.term} => ${d.definition.slice(0, 50)}`);
console.log('\n--- 线索分组 ---');
for (const g of note.cueGroups) console.log(`  ${g.label}: ${g.items.length} 条`);
console.log('\n--- 自测题 ---');
note.questions.forEach((q, i) => console.log(`  ${i + 1}. ${q.q}`));

console.log('\n=== Markdown 长度 ===', note.markdown.length, '字符');
console.log('\n=== Markdown 预览（前 60 行）===');
console.log(note.markdown.split('\n').slice(0, 60).join('\n'));
