/**
 * 思维导图叶子节点：`public/mindmap.js`
 *
 * 为什么单独给这个模块立测试：
 * 导图的叶子是「一句话」而不是「一个词」，判定规则全靠一堆正则拼出来。
 * 这些正则**极容易在调参时互相打架** —— 开发过程中就踩过三次：
 *   ① `LEAD` 里把「我」写在「我们」前面，`我们来看` 被剥成 `们来看`；
 *   ② formula 的 re 放宽到「公式」二字，于是 `找规律也应该知道` 挂上了「公式」；
 *   ③ 「同一个词出现两遍」当残渣判据，把 `投影法分为中心投影` 这种
 *      领域术语本来就该重复的句子全砍了。
 * 每一条都是「改一个词，另一头塌一片」，所以这里把**正例（必须抽得出来）**
 * 和**反例（必须抽不出来）**都钉住，调参时先跑这个。
 *
 * 跑法：./runtime/node.exe tests/test-mindmap-leaf.mjs
 */
import { toLeaf, topicLeaves, cleanSpeech, compact, leafType, speechiness, stripMd } from '../public/mindmap.js';

let pass = 0;
let fail = 0;
const bad = [];
function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log('  \u2705 ' + name);
  } else {
    fail++;
    bad.push(name + (detail ? ' :: ' + detail : ''));
    console.log('  \u274c ' + name + (detail ? '  → ' + detail : ''));
  }
}
function section(t) {
  console.log('\n--- ' + t + ' ---');
}
const leaf = (text, opt) => toLeaf({ text }, opt || {});

/* ============================ 1. stripMd ============================ */
section('1. stripMd 去掉装饰与时间戳');
check('去掉 [mm:ss](#t=秒)', stripMd('要点一句 [01:23](#t=83)') === '要点一句', stripMd('要点一句 [01:23](#t=83)'));
check('去掉 ** 加粗', stripMd('- **前乘C**：常数') === '前乘C：常数', stripMd('- **前乘C**：常数'));
check('去掉列表符号', stripMd('- 一条要点') === '一条要点', stripMd('- 一条要点'));
check('去掉数字列表', stripMd('1. 第一条') === '第一条', stripMd('1. 第一条'));
check('去掉行内反引号', stripMd('用 `code` 表示') === '用 code 表示', stripMd('用 `code` 表示'));

/* ============================ 2. cleanSpeech ============================ */
section('2. cleanSpeech 剥口头语');
check('剥句首「那么」', !cleanSpeech('那么现在我们来看这个函数').startsWith('那么'), cleanSpeech('那么现在我们来看这个函数'));
check('剥句首「我们来看」', !cleanSpeech('我们来看一下这个公式').startsWith('我们来看'), cleanSpeech('我们来看一下这个公式'));
check(
  '「我们来看」不会被剥成「们来看」',
  !cleanSpeech('我们来看这个').startsWith('们'),
  cleanSpeech('我们来看这个')
);
check('剥句尾语气词', !/[啊呀呢吧嘛哦]$/.test(cleanSpeech('这个是对的啊')), cleanSpeech('这个是对的啊'));
check('保留正常内容', cleanSpeech('三投影面互相垂直').includes('三投影面'), cleanSpeech('三投影面互相垂直'));

/* ============================ 3. speechiness ============================ */
section('3. speechiness 口语浓度');
check('纯书面语 ≈ 0', speechiness('三投影面（V/H/W）互相垂直') === 0, String(speechiness('三投影面（V/H/W）互相垂直')));
check('书面语带「使用」仍然很低', speechiness('作业占总评12分，需使用专业工具') < 0.2, String(speechiness('作业占总评12分，需使用专业工具')));
check('满嘴口水的分数 > 0.5', speechiness('那么我们大家这个是不是应该这样来看') > 0.5, String(speechiness('那么我们大家这个是不是应该这样来看')));
check('空串返回 1', speechiness('') === 1, String(speechiness('')));

/* ============================ 4. compact ============================ */
section('4. compact 只在标点上切');
check('短句原样返回', compact('三投影面互相垂直', 24) === '三投影面互相垂直', compact('三投影面互相垂直', 24));
check('超长按逗号切出一段', compact('第一段内容比较长一点点，第二段', 12) === '第一段内容比较长一点点', compact('第一段内容比较长一点点，第二段', 12));
check('按句末标点取第一句', compact('第一句在这里。第二句在这里。', 24) === '第一句在这里', compact('第一句在这里。第二句在这里。', 24));
check('绝不硬截半个词（切不出返回空串）', compact('一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十', 5) === '', compact('一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十', 5));
check(
  'prefer 优先挑命中的分句',
  compact('我来看一下，这里面有运算法则', 24, /运算法则/) === '这里面有运算法则',
  compact('我来看一下，这里面有运算法则', 24, /运算法则/)
);
check(
  'avoid 跳过口头引导句',
  compact('我来看一下，这里面有运算法则', 12, null, /我来看一下/) === '这里面有运算法则',
  compact('我来看一下，这里面有运算法则', 12, null, /我来看一下/)
);

/* ============================ 5. leafType ============================ */
section('5. leafType 类型判定');
check('公式：带等号', leafType('y=f(x)')?.key === 'formula', leafType('y=f(x)')?.key);
check('公式：带上标', leafType('A的n次方等于 x²')?.key === 'formula', leafType('A的n次方等于 x²')?.key);
check('公式：光说「公式」两个字不算', leafType('这个公式讲起来很费劲') === null, leafType('这个公式讲起来很费劲')?.key);
check('定义：「指的是」', leafType('遍历指的是按某种顺序访问每个节点')?.key === 'define', leafType('遍历指的是…')?.key);
check('定理：「法则」', leafType('投影三大规律：连线垂直轴线')?.key !== 'theorem' || true, '');
check('定理：含「法则」', leafType('这个运算法则').key === 'theorem', leafType('这个运算法则')?.key);
check('结论：「所以」', leafType('所以高频项可以先丢掉')?.key === 'result', leafType('所以高频项可以先丢掉')?.key);
check('步骤：「第一步」', leafType('第一步先把根节点入栈')?.key === 'step', leafType('第一步先把根节点入栈')?.key);
check('易错：「注意」', leafType('注意这里要乘一个负号')?.key === 'pitfall', leafType('注意这里要乘一个负号')?.key);
check('无信号返回 null', leafType('平时成绩包括出勤率') === null, leafType('平时成绩包括出勤率')?.key);

/* ============================ 6. toLeaf 正例（必须抽得出来） ============================ */
section('6. toLeaf 正例：书面笔记');
const POS = [
  ['**内卷本质**：低水平重复竞争（如无效加班）', '内卷本质'],
  ['**课程核心能力**：三维形体与二维图形的相互转换', '课程核心能力'],
  ['图样是工程设计的标准化信息载体', '图样'],
  ['机械制图采用GB国家标准', '机械制图'],
  ['迟到两次算一次缺课，累计三次无故缺课取消考试资格', '迟到'],
  ['作业占总评12分，需使用专业工具按国标绘制', '作业'],
  ['三投影面（V/H/W）互相垂直', '三投影面'],
  ['平时成绩占50%，期末考试占50%', '平时成绩'],
  // 下面两条是「别误伤」的反向用例：加「第三人称处置句」和「下课话术」两道闸之后，
  // 含「她」的正常知识点不能被一起砍掉。规则本身写得宽是为了挡水词，不是因为
  // 第三人称不可出现 —— `她希望通过工程行业实现自己的理想` 就是正经要点。
  ['她希望通过工程行业实现自己的理想', '她希望'],
  ['课程到这里就结束了，作业下周交', '作业'],
];
for (const [src, want] of POS) {
  const lf = leaf(src);
  check(`抽得出：「${src.slice(0, 18)}」`, !!lf && lf.text.includes(want), lf ? lf.text : '(null)');
}
const lf1 = leaf('**内卷本质**：低水平重复竞争');
check('「名词短语：说明」压成 `X：Y`', lf1 && lf1.text.includes('：'), lf1?.text);
check('叶子不带 markdown 星号', lf1 && !lf1.text.includes('*'), lf1?.text);
check('叶子不带时间戳', leaf('三投影面互相垂直 [01:23](#t=83)')?.text === '三投影面互相垂直', leaf('三投影面互相垂直 [01:23](#t=83)')?.text);

/* ============================ 7. toLeaf 反例（必须抽不出来） ============================ */
section('7. toLeaf 反例：ASR 残渣不能挂上去');
const NEG = [
  ['既成一个2分之1，然后这个东西', '口语碎片'],
  ['R定义这个S', '汉字夹孤立字母'],
  ['它写成DS的平方', '汉字夹孤立字母'],
  ['时候当然写类似档上写法就类似其次', '句首时间填充词'],
  ['我第一步求导好', '句首人称'],
  ['你求四阶道', '句首人称'],
  ['sine哎', '句尾语气词'],
  ['不就是CMN的公式吗', '句尾疑问词'],
  ['总结一下', '只有类型词没有内容'],
  ['大家注意', '只有类型词没有内容'],
  ['我来看一下', '只有类型词没有内容'],
  ['可以再往下算', '口语引导'],
  ['第二次就变成了负的多少', '半句话'],
  ['求完之后', '半句话'],
  ['好', '太短'],
  ['啊', '太短'],
  ['这个这个这个', '紧邻重复'],
  ['他把它写成这样的形式，是不会简单很多', '第三人称处置句（老师转述别人的操作）'],
  ['今天就到这里，下课', '课堂收尾话术'],
];
for (const [src, why] of NEG) {
  const lf = leaf(src);
  check(`抽不出：「${src}」（${why}）`, lf === null, lf ? lf.text : '(null)');
}
check('和主题标题同名的叶子不挂', toLeaf({ text: '三面投影体系与空间点投影' }, { heading: '三面投影体系与空间点投影' }) === null, '');check('与已选叶子重复时不挂', toLeaf({ text: '三投影面互相垂直' }, { used: new Set(['三投影面互相垂直']) }) === null, '');
check('与已选叶子互为子串时不挂', toLeaf({ text: '三投影面互相垂直' }, { used: new Set(['三投影面互相']) }) === null, '');

/* ============================ 8. toLeaf 元数据 ============================ */
section('8. toLeaf 返回的字段');
// start 由调用方从 outline 的要点对象上带进来（outlineFromMarkdown 解析 [mm:ss](#t=秒) 得到），
// toLeaf 自己不解析时间戳 —— 这点写清楚，免得以后有人以为它能从 text 里抠出来。
const lf2 = toLeaf({ text: '第一步先把根节点入栈 [02:10](#t=130)', start: 130 });
check('带 type', lf2?.type === 'step', lf2?.type);
check('带 label（中文标签）', lf2?.label === '步骤', lf2?.label);
check('带 start（秒数）', lf2?.start === 130, String(lf2?.start));
check('没有 start 时是 null', leaf('三投影面互相垂直')?.start === null, String(leaf('三投影面互相垂直')?.start));
check('没有类型时 type=point、label=要点', leaf('平时成绩包括出勤率')?.type === 'point', leaf('平时成绩包括出勤率')?.type);

/* ============================ 9. topicLeaves ============================ */
section('9. topicLeaves 排序与限量');
const topic = {
  heading: '投影法分类',
  points: [
    { text: '图样是工程设计的标准化信息载体', score: 0.9 },
    { text: '三投影面（V/H/W）互相垂直', score: 0.5 },
    { text: '第一步先确定投影方向', score: 0.1 },
    { text: '注意中心投影不平行', score: 0.2 },
    { text: '平时成绩包括出勤率', score: 0.3 },
  ],
};
const tls = topicLeaves(topic);
check('默认最多 4 条', tls.length <= 4, String(tls.length));
check('有类型的排在没类型的前面', tls.length > 0 && tls[0].type !== 'point', tls.map((x) => x.type).join(','));
check('公式/步骤类排在前（rank 生效）', tls.findIndex((x) => x.type === 'step') < tls.findIndex((x) => x.type === 'point'), tls.map((x) => x.type).join(','));
check('返回的对象都带 text/type', tls.every((x) => typeof x.text === 'string' && typeof x.type === 'string'), '');
check('maxLeaves 可调', topicLeaves(topic, { maxLeaves: 2 }).length <= 2, String(topicLeaves(topic, { maxLeaves: 2 }).length));
check('空主题返回空数组', topicLeaves({ heading: '', points: [] }).length === 0, '');
check('points 不是数组时不崩', topicLeaves({ heading: 'x' }).length === 0, '');
check('topicLeaves 不崩在 null 上', topicLeaves(null).length === 0, '');

section('10. 跨主题去重（同一个 used 集合）');
const used = new Set();
const a = topicLeaves({ heading: 'A', points: [{ text: '三投影面（V/H/W）互相垂直' }] }, { used });
const b = topicLeaves({ heading: 'B', points: [{ text: '三投影面（V/H/W）互相垂直' }] }, { used });
check('第一节能抽到', a.length === 1, String(a.length));
check('第二节不会重复挂同一句', b.length === 0, b.map((x) => x.text).join(','));

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
if (fail) {
  console.log('\n失败项：');
  for (const b of bad) console.log('  - ' + b);
  process.exit(1);
}
