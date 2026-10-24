/**
 * 思维导图标签抽取的回归测试（纯逻辑，不联网、不读 data/）
 *
 * 为什么要有它：2026-10-24 老大发现「笔记 tab 的『课堂脉络与重点』和 🧠 思维导图
 * tab 的内容完全一致」—— 导图原来就是把要点句子原样搬一遍，等于同一份东西摆两遍。
 * 修法是把叶子换成 topicLabels() 抽的短标签。这里的用例钉住三条底线：
 *   1. 强信号（加粗 / 「X：说明」/ 实体名）必须优先命中；
 *   2. 抽不出来时**返回空数组**，绝不硬凑「工作」「方面」这种泛词；
 *   3. squeezeLabel() 宁空勿碎 —— 「作业是课后习题 6.」这种半点东西不许出。
 *
 * 用法：node tests/test-mindmap-labels.mjs [--verbose]
 */
import { topicLabels, squeezeLabel } from '../public/note.js';

const VERBOSE = process.argv.includes('--verbose');
let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`);
  }
};
const once = (topic, opt = {}) => {
  const hays = opt.hays || [(topic.points || []).map((p) => p.text || '').join(' ')];
  const got = topicLabels(topic, { ...opt, hays, used: opt.used || new Set() });
  if (VERBOSE) console.log(`       [${topic.heading}] → ${JSON.stringify(got)}`);
  return got;
};

console.log('\n=== 一、强信号优先 ===');
{
  const t = { heading: '内卷与躺平', points: [{ text: '**内卷本质**：所有人都更努力，但录取名额没变' }] };
  const got = once(t);
  check('加粗词被抽成标签', got.includes('内卷本质'), JSON.stringify(got));
  check('带冒号的长句没有被整句塞进来', !got.some((x) => x.includes('所有人都更努力')), JSON.stringify(got));
}
{
  const t = {
    heading: '请假与缺课',
    points: [{ text: '请假条：需要提前一天交给辅导员' }, { text: '迟到两次算一次缺课' }],
  };
  const got = once(t);
  check('「X：说明」里的 X 被抽出来', got.includes('请假条'), JSON.stringify(got));
}
{
  const t = { heading: '乐观精神', points: [{ text: '杨女士十年还清百万债务，培养两个孩子上大学' }] };
  const got = once(t);
  check('叙事类要点里的实体名被抽出来', got.includes('杨女士'), JSON.stringify(got));
}
{
  // 口头语开头的「X：」不能当标签（`先明确一个定义：所谓…` 的 X 是句子不是概念）
  const t = { heading: '二叉树的遍历', points: [{ text: '先明确一个定义：所谓遍历就是每个结点访问一次' }] };
  const got = once(t);
  check('剥掉口头语后不是标签就不收', !got.some((x) => x.includes('先明确')), JSON.stringify(got));
}

console.log('\n=== 二、泛词、量化词、标题重复一律不要 ===');
{
  const t = {
    heading: '积极人生态度',
    points: [{ text: '**认真** **坚持** 是基础' }, { text: '工作很重要，生活也很重要' }, { text: '第二种方式是务实' }],
  };
  const got = once(t);
  check('收下了真概念', got.includes('认真') && got.includes('坚持'), JSON.stringify(got));
  check('没收「工作」这种泛词', !got.includes('工作'), JSON.stringify(got));
  check('没收「第二种」这种序数', !got.some((x) => x.startsWith('第')), JSON.stringify(got));
}
{
  const t = { heading: '三面投影体系', points: [{ text: '**三面投影体系** 是本章重点' }] };
  const got = once(t);
  check('与主题标题相同的词不重复挂', !got.includes('三面投影体系'), JSON.stringify(got));
  check('标题里有的词也不挂', !got.includes('投影'), JSON.stringify(got));
}

console.log('\n=== 三、跨主题去重 ===');
{
  const used = new Set(['递归']);
  const t = { heading: '左孩子与递归', points: [{ text: '**递归** 调用时先处理左孩子' }] };
  const got = once(t, { used });
  check('别的主题已经用掉的词不再挂', !got.includes('递归'), JSON.stringify(got));
  check('去重不误伤同主题的其它词', got.length === 0 || !got.some((x) => used.has(x) && x !== '递归'), JSON.stringify(got));
}

console.log('\n=== 四、抽不出来就给空数组（宁空勿凑）===');
{
  const t = { heading: '外部舆论环境与青年责任', points: [{ text: '境外势力通过网红散播消极言论' }] };
  const got = once(t);
  check('没有强信号时返回空数组', Array.isArray(got) && got.length === 0, JSON.stringify(got));
}

console.log('\n=== 五、squeezeLabel 宁空勿碎 ===');
{
  check('整句短且无标点 → 直接当标签', squeezeLabel('递归') === '递归', squeezeLabel('递归'));
  check('只有半个数字的不收', squeezeLabel('作业是课后习题 6.3') === '', squeezeLabel('作业是课后习题 6.3'));
  check('开头的中文逗号被清掉', !squeezeLabel('，那今天就到这里，下课').startsWith('，'), squeezeLabel('，那今天就到这里，下课'));
  check('口语前缀被剥掉', squeezeLabel('那么时间复杂度是 O(n)') === '', squeezeLabel('那么时间复杂度是 O(n)'));
  check('长度上限默认 10', squeezeLabel('一二三四五六七八九十一二三').length <= 10, squeezeLabel('一二三四五六七八九十一二三'));
  check('空输入返回空串', squeezeLabel('') === '' && squeezeLabel(null) === '', '');
}

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
