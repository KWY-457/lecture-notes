/**
 * 思维导图的叶子节点：从「要点句」压出一句能独立成立的知识点。
 *
 * ## 为什么要重做
 *
 * 老版本（2026-10-24 之前）直接把要点句子当叶子，跟左边笔记正文逐字相同，
 * 导图等于把正文抄一遍。
 * 2026-10-24 改成「抽关键词当叶子」（topicLabels + squeezeLabel），解决了复读，
 * 但引入了新问题：**词没有命题性**。实测一份高数笔记，抽出来是
 * `看一` `阶档` `道题` `冷记记一下` `写成` —— 这些是 ASR 把口语切碎后的残渣，
 * 不是知识点。老大原话：「最重要的是什么，公式，结论」。
 *
 * ## 现在怎么做
 *
 * 叶子 = **一句压缩过的命题** + **类型标签**，而不是一个词：
 *
 *   [公式] 高阶导数写成 y 的三撇
 *   [定义] 显函数：能表示为 y=f(x)
 *   [结论] n 次求导等于 A 的 n 次方
 *
 * 调研依据（2026-11-01）：
 *   - 通义听悟的导图节点是「短句式论断」，不是词（阿里云百炼 tingwu 文档）。
 *   - Notta 把 AI Notes 的标题层级投影成树，叶子是正文要点句。
 *   - 没有一家把 n-gram 词当叶子 —— 词承载不了「公式/结论」这类信息。
 *
 * 类型标签只在这几类信号明确时才挂：公式 / 定义 / 定理 / 结论 / 步骤 / 例题 / 易错。
 * 判不出来就挂「要点」，不猜。
 */

/* ------------------------------ 文本清洗 ------------------------------ */

/** 句首的口头连接词。反复剥，因为「那么其实我们看」会叠三层。
 *
 * **顺序必须长词在前**：正则的 alternation 是从左往右取第一个能匹配的，
 * 把「我」写在「我们」前面，`我们来看` 会被剥成 `们来看` —— 实测踩过这个坑。
 */
const LEAD =
  /^(?:我们来看|我们再看|我们看一下|也就是说|就是说|举个例子|比如说|那么|那|所以|但是|但|然后|因为|其实|首先|其次|再次|另外|而且|可见|因此|同时|还有|比如|接下来|下面|最后|我们|咱们|你们|大家|这个|那个|就是|这是|好|对|嗯|呃|额|啊|哎)+[，,、\s]*/;

/** 句中/句尾的语气词与确认语。注意「啊」在「阿尔法」里是构词成分，所以按独立出现处理。 */
const FILLER = /(?:是不是啊?|对不对啊?|好不好|是吧|对吧|知道吧|明白吧|啊|呀|呢|吧|嘛|哦|嗯|呃|额|哈|啦|咯)/g;

/** 整句都是废话。 */
const JUNK =
  /^(?:好|行|嗯|啊|对|是|这个|那个|然后呢?|那个什么|我们看?一下|大家看?一下|是不是|怎么样|可以|没问题)[。？?！!，,\s]*$/;

/** 口语残留：这些词频繁出现说明这句还是「在说话」而不是「在陈述知识」。
 *
 * `可以 / 应该 / 需要 / 这就 / 那就` 也在这个表里 —— 它们本身不算语气词，
 * 但在讲课录音里几乎只出现在口头引导句（`可以再往下算`、`应该知道`），
 * 而且书面笔记里这些字眼通常伴随具体宾语（`可以表示为 y=f(x)`），
 * 数一下命中比例仍然压得住。 */
const SPEECHY =
  /(?:我们|咱们|大家|你们|你看|我说|是不是|对不对|这个|那个|什么|怎么|然后|就是说|比如说|可以|应该|需要|这就|那就)/g;

/**
 * ASR 把英文/符号念成单个字母夹在汉字里：`R定义这个S`、`ST球对T`、`既成个2分之1`。
 * 中文里正常不会出现「汉字紧贴单个大写字母」这种形态（`X的平方` 是有意保留的写法），
 * 但**缩写词两侧带空格或者全大写连续**是正常的（`GB 国家标准`、`SCI 论文`），
 * 所以这里只抓「一个孤零零的字母」。
 */
const LONE_LATIN = /[\u4e00-\u9fff][A-Za-z](?![A-Za-z])|(?<![A-Za-z])[A-Za-z][\u4e00-\u9fff]/;

/**
 * 这句里有没有数学符号。
 *
 * 为什么需要它（2026-11-01）：`LONE_LATIN` 原来是一票否决，结果把**所有真带公式的句子**
 * 全判死了 —— `显函数：能明确表示为y=f(x)的形式`、`将y视为x的函数y=f(x)`、`如y=x^(sin x)`
 * 里都有「汉字紧贴单个字母」，全被当 ASR 残渣扔掉。实测高数 A 课 7 个主题只出 5 个叶子、
 * 覆盖 9%，用户看到的那张全是「看一」「道题」「阶档」的导图就是这么来的。
 *
 * 判据：一句话里只要出现 `= ( ) ^ / ²` 这类符号，里面的字母就是公式的一部分，
 * 不是 ASR 把英文念碎成单个字母。真正的残渣（`R定义这个S`、`它写成DS的平方`）
 * 一个符号都没有。
 */
const MATHY = /[=＝+\-×÷*/^²³⁴⁵⁶⁷⁸⁹⁰¹√∂∫∑±≈≤≥<>()（）[\]{}|]/;

/**
 * 连续 2~3 个字母夹在汉字里，且不是已知缩写 —— `它写成DS的平方`。
 *
 * 正常中文段落里的拉丁字母基本都成段（`GB 国家标准`、`y=f(x)` 有符号包着），
 * 而 ASR 残渣是「汉字+两个字母+汉字」这种形态。白名单是产品里真实会出现的缩写。
 */
const LAZY_ACRONYM = new Set(['GB', 'SCI', 'APP', 'PDF', 'API', 'PPT', 'URL', 'CPU', 'GPU']);
const NOISE_LATIN = /[\u4e00-\u9fff]([A-Za-z]{2,3})[\u4e00-\u9fff]/g;

/** 汉字里夹着的非缩写字母串 —— 有就说明这句是 ASR 拼出来的。 */
function hasNoiseLatin(s) {
  const t = String(s || '');
  NOISE_LATIN.lastIndex = 0;
  let m;
  while ((m = NOISE_LATIN.exec(t))) {
    if (!LAZY_ACRONYM.has(m[1].toUpperCase())) return true;
  }
  return false;
}

/** 结尾挂着的连接词/助词 —— 说明这句话被切断在半路上，念出来是半截。 */
const DANGLING =
  /(?:所以|但是|然后|就是|这个|那个|我们|你们|大家|因为|而且|还有|就是说|比如说|来|地|得|把|被|在|和|与|的)[，,、。！？\s]*$/;

/** 口语动作词：出现就说明这句是「老师在讲台上说话」，不是「一行知识点」。
 *
 * `比如`/`例如` 也在这里 —— 它们本身只是「我要举个例子」的引子，
 * 算进 ORAL_MARK 之后「例题」这一类只由真正的「例题 / 题目 / 求解 / 答案」触发，
 * 不会再因为一句「比如说他出一个很简单的一个函数」就挂上「例题」标签。 */
const ORAL_MARK =
  /(?:知道|看一下|看一遍|记一下|记不住|说一下|想一下|算一下|我来看|你来看|来说|对吧|是吧|比如说|比如|例如|举个例子)/;

/** 除了类型词本身什么都没有的叶子：`总结一下` `大家注意` `我来看一下`。 */
const EMPTY_LEAF =
  /^(?:总结一下|总结一下今天|我来看一下|我们来看一下|大家注意|冷记一下|记一下|看一下|注意一下|关键是这个三?|第一步|第二步|第三步)[，,。！？、\s]*$/;

/**
 * 「这句话能独立成立吗」—— 没有类型信号时用它兜底。
 *
 * 中文里一句陈述句总得有个谓语：是 / 有 / 为 / 叫 / 表示 / 包括 / 分为 / 等于 ……
 * `我之前也` `sine哎` `第二次就变成了负的多少` 这类全都没有，只是半句话，
 * 挂到导图上比不挂更让人困惑（老大：「实在不会不要瞎编」）。
 */
const STANDALONE = /(?:是|有|为|叫|称|等于|表示|包括|分为|包含|属于|指的是|需要|必须|可以|不能|不要|应该|采用|使用|得到|写成|变成|求导|计算)/;

/** 结尾这些词说明句子没说完。`负的多少` `我之前也` `求完之后` 都栽在这。 */
const TAIL_WEAK = /(?:多少|也|都|之后|之前|的话|时候|什么|怎样|如何)[，,。！？、\s]*$/;

/** 第三人称 + 处置式：`他把它写成这样的形式，是不会简单很多`。
 *
 * 只看 `他/她` 太宽 —— `她希望通过工程行业实现自己的理想` 是正经知识点，
 * 该留。加上「把/被」之后剩下的全是「老师转述某人的操作」，课堂上那句
 * 本来就是指代前文的半句话，单拎出来谁也看不懂。 */
const THIRD_PERSON_BA = /[他她]把|[他她]被/;

/** 下课话术：`今天就到这里，下课` `我们这节课就上到这里`。
 *
 * 这类句子有完整主谓、没有一处口语标记，靠通用闸门拦不住，
 * 但它是课堂收尾不是知识 —— 挂到导图上像是笔记漏了最后一节。 */
const CLASS_OVER = /到这里[，,]?\s*(?:下课|休息)|下课了|今天(?:就)?(?:上|讲)?到这里|这节课(?:就)?(?:上|讲)?到这里/;

/** 句首还挂着「我 / 你 / 咱们」的，本质是讲课时的口头语，不是陈述句。
 *  `我第一步求导好` `你求四阶道` `你解化公式` 都被这条挡住。 */
const LEAD_PERSONAL = /^(?:我|你|您|咱|咱们|我们|你们|大家|下面|接下来)/;

/** 句首是时间/方位填充词，说明这句是从长句中间截出来的：`时候当然写类似档上写法`。
 *  正常的一句知识点不会以「时候」「当时」「上面」开头。 */
const LEAD_FILLER = /^(?:时候|当时|现在|前面|后面|上面|下面|这里|那里|其中|然后|接着|再|又)/;

/** 结尾是语气词或疑问词 —— `sine哎`、`不就是CMN的公式吗`。
 *  知识点是陈述句，疑问词结尾说明这句本来是在问/反问。 */
const TAIL_PARTICLE = /(?:哎|啊|呀|呢|吧|嘛|哦|嗯|呃|哈|啦|咯|喔|诶|吗|么)[，,。！？、\s]*$/;

/**
 * 紧邻重复的双字词 —— `这个这个`、`我们我们`。ASR 拼句的典型症状。
 *
 * **只能查紧邻**：一开始写成「同一句里出现两遍同一个词」，结果把
 * `投影法分为中心投影`（领域术语本来就该重复）和 `三投影面互相垂直` 全砍了。
 * 中间隔几个字的重复在中文里太常见，不可作为判据。
 */
function repeatedWord(s) {
  return /([\u4e00-\u9fff]{2})\1/.test(String(s || ''));
}

const CJK = /[\u4e00-\u9fff]/;
const clen = (s) => [...String(s || '')].length;

/** 去掉 markdown 装饰与时间戳锚点，只留文字。 */
export function stripMd(s) {
  return String(s || '')
    .replace(/\s*\[[^\]]*\]\(#t=[\d.]+\)\s*/g, ' ')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*\d+[.、]\s+/, '')
    .trim();
}

/**
 * 把一句口语洗成可以读的短语。
 *
 * 只做「确定不会改变意思」的动作：剥句首连接词、删语气词、去叠字
 * （`记记一下` → `记一下`，ASR 常见的口吃）、收标点。
 * **不做同音纠错** —— `修导案`（求导）这种只能靠猜，猜错比留着原文更糟。
 */
export function cleanSpeech(raw) {
  let s = stripMd(raw).replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 4; i++) {
    const t = s.replace(LEAD, '');
    if (t === s) break;
    s = t;
  }
  s = s.replace(FILLER, '');
  s = s.replace(/([\u4e00-\u9fff])\1(?=[\u4e00-\u9fff])/g, '$1');
  s = s.replace(/^[，,、；;：:。！？!?…\s]+/, '').replace(/[，,、；;：:。！？!?…\s]+$/, '');
  return s.replace(/\s+/g, ' ').trim();
}

/** 这句话有多「口语」。0 = 像书面笔记，1 = 纯口水。 */
export function speechiness(s) {
  const t = String(s || '');
  if (!t) return 1;
  const hits = (t.match(SPEECHY) || []).length;
  const len = Math.max(1, clen(t));
  // 每 10 个字出现一个口语词就算满格
  return Math.min(1, (hits * 10) / len / 2);
}

/* ------------------------------ 类型判定 ------------------------------ */

/**
 * 知识点类型。顺序即优先级 —— 一条要点同时像「公式」和「结论」时，
 * 公式信息量更大（结论往往是公式的解释）。
 *
 * `strong: true` 的类型要求在**压缩后的短语**里也命中，光原句命中不够 ——
 * 否则「这个公式我们考试也不好考」会被挂成「公式」。
 */
export const LEAF_TYPES = [
  // formula 的 re 故意放宽（原句里提到「公式」「次方」也算线索，用来决定压缩时挑哪个分句），
  // 但 hard 卡住最终叶子：压缩完的这句里必须有**数学符号、上下标、或字母**，
  // 光有「二分之一」这种裸数字不算 —— `既成一个2分之1`、`负的2分之3了`
  // 都是 ASR 把「再乘一个二分之一」听碎的残片，不是知识点。
  {
    key: 'formula',
    label: '公式',
    re: /[=＝]|[²³⁴⁵⁶⁷⁸⁹√∂∫∑±≈≤≥×÷]|\^\s*\d|\d+\s*分\s*之|[A-Za-z]\s*的?\s*(?:平方|立方|次方)|\bN\s*次|n\s*次方|公式/,
    hard: /[=＝²³⁴⁵⁶⁷⁸⁹⁰¹√∂∫∑±≈≤≥×÷]|\^\s*\d|[A-Za-z\u03b1-\u03c9\u0391-\u03a9]/,
  },
  { key: 'define', label: '定义', re: /(?:定义|概念是|概念：|指的是|称为|叫作|叫做|含义是|表示为|是指)/ },
  { key: 'theorem', label: '定理', re: /(?:定理|定律|法则|推论|引理|性质|公理)/ },
  { key: 'result', label: '结论', re: /(?:结论|所以|因此|由此可见|综上|总之|归纳|总结|说明|意味着|可见)/ },
  { key: 'step', label: '步骤', re: /(?:步骤|第一步|第二步|第三步|首先|然后|接着|再对|最后一步|做法是|方法是)/ },
  { key: 'example', label: '例题', re: /(?:例题|题目|求解|算出|答案|例如|比如|这道题|那道题|习题)/ },
  { key: 'pitfall', label: '易错', re: /(?:易错|容易错|注意|别忘|千万不要|小心|关键是|记住|必须|一定要)/ },
];

/**
 * 判定类型。`text` 用来判，`hint` 是原句（书面笔记里「X：说明」的说明部分也一起看）。
 *
 * 带 `hard` 的类型必须让 `hard` 在 **`text` 自己** 上命中（不看 hint）：
 * 光原句里出现「公式」两个字不够，压缩后的短语里也得真有数学符号。
 */
export function leafType(text, hint = '') {
  const own = String(text || '');
  const hay = own + ' ' + String(hint || '');
  if (!hay.trim()) return null;
  for (const t of LEAF_TYPES) {
    if (t.hard && !t.hard.test(own)) continue;
    if (t.re.test(hay)) return t;
  }
  return null;
}

/* ------------------------------ 压缩成叶子 ------------------------------ */

/**
 * 按分隔符切串，但**括号里面的分隔符不算**。
 *
 * 为什么必须有这个：`椭圆方程x²/16 + y²/9=1在点(2, 3√3/2)处的切线求法` 里
 * `(2, 3√3/2)` 中间那个逗号，朴素的 `split(',')` 会把坐标切成两半，
 * 于是切出 `3√3/2)处的切线求法` 这种从半个括号开始的垃圾叶子（实测量到过）。
 * 圆括号、方括号、全角括号一律按深度算。
 */
function splitTop(s, sep) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of String(s || '')) {
    if (ch === '（' || ch === '(' || ch === '[' || ch === '【') depth++;
    else if (ch === '）' || ch === ')' || ch === ']' || ch === '】') depth = Math.max(0, depth - 1);
    if (depth === 0 && sep.test(ch)) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** 去掉结尾成对的括号补充说明（`…的形式（如y=√(x-1)）` → `…的形式`）。 */
function dropTrailParen(s) {
  let t = String(s || '').trim();
  for (;;) {
    const next = t.replace(/[（(][^（）()]*[）)]\s*$/, '').replace(/[，,、；;：:]\s*$/, '').trim();
    if (next === t || !next) return t;
    t = next;
  }
}

/**
 * 把一段话压到 `max` 字以内，**只在标点上切，绝不硬截半个词**。
 * 切不出来就返回空串（调用方少挂一个叶子，比挂半个词好）。
 *
 * @param {string} text
 * @param {number} max
 * @param {RegExp} [prefer] 给了就优先挑命中的片段 ——
 *        这样「最重要的是公式」这件事才能落到叶子上：一句口语里
 *        真正带公式的往往只是其中一个分句，先切出那一句再判类型，
 *        标签才不会挂在无关的半句上（实测 `找规律也应该知道` 被挂成「公式」）。
 * @param {RegExp} [avoid] 命中就不当候选 —— 用来躲开「我来看一下」这种口头引导句，
 *        否则一句「我来看一下，这里面有一些所谓的运算运算法则」永远只能压出前半句。
 */
export function compact(text, max = 24, prefer = null, avoid = null) {
  const s = String(text || '').trim();
  if (!s) return '';
  const fit = (x) => x && clen(x) >= 3 && clen(x) <= max;
  const ok = (x) => fit(x) && !(avoid && avoid.test(x));
  // 切分一律走括号感知的版本：坐标里的逗号不能当分隔符
  const segs = splitTop(s, /[，,、；;]/);
  // ① 有偏好：先把命中的片段挑出来（按长度取最短的那个，信息密度最高）
  if (prefer) {
    const hit = segs.filter((x) => prefer.test(x) && ok(x)).sort((a, b) => clen(a) - clen(b));
    if (hit.length) return hit[0];
  }
  // ② 按句末标点切，取第一句
  const first = splitTop(s, /[。！？!?]/)[0];
  if (ok(first)) return first;
  if (ok(s)) return s;
  // ③ 超长：按逗号切，取第一个长度够的片段
  for (const p of segs) if (ok(p)) return p;
  // ④ 还是太长：剥掉结尾的括号补充说明再看一眼（`…的形式（如y=√(x-1)）`）
  const bare = dropTrailParen(s);
  if (bare !== s && ok(bare)) return bare;
  for (const p of segs) {
    const b = dropTrailParen(p);
    if (b !== p && ok(b)) return b;
  }
  // ⑤ 仍然太长：在介宾短语前切断（`椭圆方程x²/16+y²/9=1` **在** `点(2,3√3/2)处的切线求法`）
  //    中文长句的尾巴常是「在…处 / 对…求 / 把…代入」这类状语，切掉尾巴反而是干净的主干。
  //    要求切点前至少 6 个字，否则会把「对数」这种词腰斩。
  for (const p of [s, ...segs]) {
    for (let i = 6; i < clen(p); i++) {
      const head = [...p].slice(0, i).join('');
      if (!/[在对把将被将于用从向由]/.test([...p][i])) continue;
      if (clen(head) > max) break;
      if (ok(head.trim()) && !DANGLING.test(head)) return head.trim();
    }
  }
  // ⑥ 还在太长：在**全角开括号前**切断。括号里通常是举例/补充
  //    （`低水平重复竞争（如无效加班、机械学习）导致资源浪费` → `低水平重复竞争`）。
  //    **只认全角 `（`**：半角 `(` 多半是函数调用 `y=f(x)`、`F(x,y)=0`，
  //    在它前面切会切出 `能明确表示为y=f` 这种半截公式（实测踩过）。
  for (const p of [s, ...segs]) {
    for (let i = 6; i < clen(p); i++) {
      if ([...p][i] !== '（') continue;
      const head = [...p].slice(0, i).join('').trim();
      if (ok(head) && !DANGLING.test(head) && !/[=＝+\-*/^（(]$/.test(head)) return head;
    }
  }
  // ⑦ 最后手段：**不做硬截字**。
  //    试过「截到 max 再去掉结尾半个词」，结果 `57岁外卖员王继平出版诗集《低空飞行》获鲁`
  //    `习近平总书记知青经历证明苦难与价值目标结` 这种半截词挂在导图上，
  //    比不挂更难看 —— 老大说的「实在不会不要瞎编」也包括不硬凑。
  //    真需要多挂几条时，把 max 放宽（调用方传 32）比硬截安全。
  return '';
}

/**
 * 一条要点 → 一个叶子。
 *
 * @param {{text:string, start?:number}} point
 * @param {{max?:number, used?:Set<string>, heading?:string}} opt
 * @returns {{text:string, type:string, label:string, start:number|null}|null}
 */export function toLeaf(point, opt = {}) {
  const max = opt.max || 24;
  const used = opt.used instanceof Set ? opt.used : new Set();
  const heading = String(opt.heading || '');
  const raw = String(point?.text || '');
  if (!raw.trim()) return null;

  const start = Number.isFinite(point?.start) ? point.start : null;
  let plain = stripMd(raw);

  /**
   * 以冒号结尾的「引导行」：`- 操作步骤：` —— 后面本该跟着子项。
   *
   * 子项已经被 outlineFromMarkdown 展开成独立要点了，这一行本身只剩个标题，
   * 挂到导图上就是一条「步骤 | 操作步骤」，等于什么都没说。
   * 而它又确实带类型信号（含「步骤」），能绕过所有口语闸门 —— 所以只能在这里挡。
   *
   * 但**不能见到冒号结尾就丢**：`椭圆方程x²/16+y²/9=1在点(2,3√3/2)处的切线求法：`
   * 这种冒号前是真内容（28 字），前面挂了「求法」两个字而已。判据看冒号前有多长。
   */
  if (/[：:]\s*$/.test(plain)) {
    const head = plain.replace(/[：:]\s*$/, '').trim();
    if (clen(head) <= 6) return null;
    plain = head;
  }

  /* --- ① 书面形态：「**X**：说明」或「X：说明」 --- */
  let core = '';
  let detail = '';
  const bold = plain.match(/^\*\*(.+?)\*\*[：:]\s*(.+)$/) || raw.match(/\*\*(.+?)\*\*\s*[：:]\s*([\s\S]+)/);
  if (bold) {
    core = bold[1].trim();
    detail = bold[2].trim();
  } else {
    const colon = plain.match(/^([^：:，,。；;！？!?]{2,14})[：:]\s*(.+)$/);
    if (colon) {
      core = colon[1].trim();
      detail = colon[2].trim();
    }
  }
  // 「显函数 —— 能表示为…」这种破折号形态（离线引擎的「概念与定义」节就这么写）
  if (!core) {
    const dash = plain.match(/^([^—–-]{2,14})\s*[—–]{1,2}\s*(.+)$/);
    if (dash) {
      core = dash[1].trim();
      detail = dash[2].trim();
    }
  }

  let text = '';
  // 有没有「名词短语：说明」这种书面结构 —— 后面的语闸门要按它分岔
  const structured = !!core;
  if (core && clen(core) >= 2 && clen(core) <= 14) {
    // 名词短语当主干，说明压缩一句接在后面 —— 比只留名词有信息量，
    // 比留整句短。`显函数：能表示为y=f(x)` 正好是读者想要的形态。
    const tail = compact(cleanSpeech(detail), Math.max(6, max - clen(core) - 1));
    // 空壳：`操作步骤：` 后面什么都没了（子项已被拆成独立要点），挂上去等于挂个标题；
    // 断了：`方程两边对x求导得(2x)/16 +` 切在符号上，看着像加载到一半。
    if (!tail && /[：:]\s*$/.test(plain)) return null;
    if (tail && /[=＝+\-*/^（(、，,]$/.test(tail)) return null;
    text = tail ? `${core}：${tail}` : core;
  }

  /* --- ② 口语句：洗一遍再压 --- */
  if (!text) {
    const cleaned = cleanSpeech(plain);
    if (!cleaned || JUNK.test(cleaned)) return null;
    // 先看整句像哪一类，再让 compact 优先挑出**命中的那个分句**。
    // 不这么做的话「…找规律也应该知道，这个公式是…」会压成前半句「找规律也应该知道」，
    // 然后被挂成「公式」—— 标签和内容对不上，这就是老大那张图上最刺眼的地方。
    let compacted = '';
    for (const t of LEAF_TYPES) {
      if (!t.re.test(cleaned)) continue;
      const pick = compact(cleaned, max, t.re, ORAL_MARK);
      if (!pick) continue;
      if (t.hard && !t.hard.test(pick)) continue;
      compacted = pick;
      break;
    }
    if (!compacted) compacted = compact(cleaned, max, null, ORAL_MARK);
    if (!compacted) return null;
    text = compacted;
  }

  /* --- ③ 质量闸门 --- */
  text = text.replace(/^[，,、；;：:。！？!?…\s]+/, '').replace(/[，,、；;：:。！？!?…\s]+$/, '').trim();
  if (clen(text) < 4) return null;
  // ASR 残渣：`R定义这个S`、`它写成DS的平方` —— 汉字夹孤零零字母，念出来根本不成话。
  // 但如果这句里有 `= ( ) ^` 这类符号，那些字母就是公式的一部分（`y=f(x)` `F(x,y)=0`），
  // 不能杀 —— 这一条曾经把高数课所有公式句子全砍了，覆盖率只剩 9%。
  if (LONE_LATIN.test(text) && !MATHY.test(text)) return null;
  if (hasNoiseLatin(text) && !MATHY.test(text)) return null;
  // 半截话：`所以这地方是后面一项` 结尾挂「的」，念到一半被切了
  if (DANGLING.test(text)) return null;
  if (!CJK.test(text) && clen(text) < 8) return null;
  if (JUNK.test(text)) return null;
  // 「总结一下」「大家注意」「我来看一下」—— 有类型词但本身不含任何知识点
  if (EMPTY_LEAF.test(text)) return null;
  // 口语动作词：`看我们无论是从概念上还是到计算上` `第一步大家都知道cosine加求导`
  // 这类句子压缩之后还留着「看/知道/说一下」，说明它原本是讲课的口头引导，不是结论
  if (ORAL_MARK.test(text)) return null;
  // 结尾是「多少 / 也 / 之后 / 的时候」—— 半句话，念出来让人等下半句
  if (TAIL_WEAK.test(text)) return null;
  // 句首还是「我第一步…」「你求四阶道」—— 这是讲课的口头语，不是一行知识点
  if (LEAD_PERSONAL.test(text)) return null;
  // 句首是「时候/上面/然后」—— 从长句中间截出来的半句
  if (LEAD_FILLER.test(text)) return null;
  // 结尾挂着语气词 —— `sine哎` `就是这个三啊`
  if (TAIL_PARTICLE.test(text)) return null;
  // 同一个双字词重复 —— `写类似档上写法就类似其次`，ASR 拼句的典型症状
  if (repeatedWord(text)) return null;
  // 第三人称处置句 —— `他把它写成这样的形式，是不会简单很多`
  if (THIRD_PERSON_BA.test(text)) return null;
  // 下课话术 —— `今天就到这里，下课`
  if (CLASS_OVER.test(text)) return null;
  // 与主题标题一样：导图上「主题 → 同名叶子」是纯噪音
  if (heading && clen(heading) >= 3 && (text === heading || text.includes(heading))) return null;
  // 与已选叶子重复 / 互为子串
  for (const u of used) if (u === text || u.includes(text) || text.includes(u)) return null;

  /* --- ④ 类型 ---
     只看**压缩后的这句**，不看原句。
     一开始把原句当 hint 传进来，结果原句里随口一句「比如」「所以」就让
     `找规律也应该知道` 被判成「结论」、`三阶导就是三阶导` 被判成「例题」——
     标签比不挂还误导人。叶子既然已经压缩了，类型就该由它的实际内容决定。 */
  const t = leafType(text);
  const sp = speechiness(text);
  // 没类型信号：必须是**书面语**的短句（speechiness 接近 0），否则就是口水。
  // 实测 `找规律也应该知道` 的口语浓度 0.33、「可以再往下算」0.5 —— 这类一律不挂。
  if (!t && sp > 0) return null;
  // 「名词短语：说明」这种结构本身就成立（`内卷本质：低水平重复竞争`），
  // 剩下的口语闸门只针对**从口语里硬压出来**的句子，别把书面笔记一起砍了。
  if (structured) return { text, type: t ? t.key : 'point', label: t ? t.label : '要点', start };

  /* --- ⑤ 整体口语闸门 ---
     洗完还是满嘴「我们」「大家」「是不是」，这句就没提炼价值。
     注意这道闸**对带类型信号的也生效** —— 一开始只卡「没类型」的，
     结果「这其实我说一下个光环这个概念」因为含「概念」被挂成「定义」，
     反而比不挂更糟。老大说的「实在不会不要瞎编」就是这个意思：
     宁可这一节空着，也别把口水伪装成知识点。 */
  if (sp >= 0.5 && clen(text) >= 8) return null;

  return { text, type: t ? t.key : 'point', label: t ? t.label : '要点', start };
}

/**
 * 一个主题能挂哪些叶子。
 *
 * 排序不是按原顺序，而是**先按「像不像知识点」**：
 * 有类型的排前面（公式 > 定义 > 定理 > 结论 > 步骤 > 例题 > 易错 > 无类型），
 * 同类型里再按原来的分数/顺序。这样一节里如果有公式，公式一定在最上面 ——
 * 老大说的「最重要的是公式、结论」就是这个意思。
 */
const TYPE_RANK = { formula: 0, define: 1, theorem: 2, result: 3, step: 4, example: 5, pitfall: 6, point: 9 };

export function topicLeaves(topic, opt = {}) {
  const maxLeaves = opt.maxLeaves || 4;
  const max = opt.max || 24;
  const used = opt.used instanceof Set ? opt.used : new Set();
  const heading = String(topic?.heading || '');
  const points = Array.isArray(topic?.points) ? topic.points : [];

  const cands = [];
  points.forEach((p, i) => {
    // 传 `used` 进去让 toLeaf 自己排掉跨主题重复的句子，本主题内的重复由下面那段兜。
    const lf = toLeaf(p, { max, used, heading });
    if (!lf) return;
    // 分数越高越靠前；同分按原顺序（分数是离线引擎算的，越靠前越重要）
    const score = Number(p?.score);
    cands.push({ ...lf, rank: TYPE_RANK[lf.type] ?? 9, score: Number.isFinite(score) ? score : 0, i });
  });
  cands.sort((a, b) => a.rank - b.rank || b.score - a.score || a.i - b.i);

  const out = [];
  for (const c of cands) {
    if (out.length >= maxLeaves) break;
    // 跨主题也去重：同一句话被两节都抽出来时只挂一次，否则树里出现两遍一样的叶子。
    // 这里的 `used` 是调用方跨主题共用的同一个 Set。
    let dup = false;
    for (const u of used) {
      if (u === c.text || u.includes(c.text) || c.text.includes(u)) { dup = true; break; }
    }
    if (dup) continue;
    if (out.some((o) => o.text.includes(c.text) || c.text.includes(o.text))) continue;
    used.add(c.text);
    out.push({ text: c.text, type: c.type, label: c.label, start: c.start });
  }
  return out;
}

export default { toLeaf, topicLeaves, cleanSpeech, compact, leafType, stripMd, speechiness, LEAF_TYPES };
