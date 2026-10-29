/**
 * AI 笔记：调用 OpenAI 兼容的 chat/completions（服务端代理，避免跨域并保护 Key）
 *
 * 长录音走「分段讲解+摘录 → 汇总成稿」两趟：
 *   1. map：把逐字稿按 ~6000 字切块，逐块输出 (A) 讲解 + (B) 摘录；
 *      「讲解」负责补上老师省略的"为什么"（自己补的必须带「（补充）」标记），
 *      「摘录」负责忠实记下老师讲的重点、例子、考点；
 *   2. reduce：把所有块 + 离线引擎给出的关键词/主题骨架，合成一份最终笔记，
 *      其中「理解脉络」「易错与易混」两节就是拿 map 的讲解内容合成的。
 * 这样即使 90 分钟的课也能稳定产出，不会超出模型上下文。
 *
 * 短课（≤ DIRECT_LIMIT）不切块，直接整理 —— 但走的是独立的 DIRECT_PROMPT/DIRECT_SYSTEM，
 * 因为那种输入是原始口语、没有 map 的讲解层，必须显式授权模型去解释、并强制标记「（补充）」。
 */
import { fmtTime, extractKeywords, splitSentences } from './summarize.js';
import { cleanSegments, diffCount } from './cleanup.js';
import { stripPromptLeaks } from './md.js';

const CHUNK_CHARS = 6000;
const DIRECT_LIMIT = 14000;
/** 校对分块的首选字号，以及失败时逐级降级用的字号（见 cleanTranscriptViaLLM 注释） */
const PROOF_CHUNK = 5000;
const PROOF_SIZES = [5000, 2500, 1250, 800];

async function callLLM(messages, { signal, temperature = 0.25, maxTokens = 0, timeoutMs = 0 } = {}) {
  const resp = await fetch('/api/llm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages,
      temperature,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    }),
    signal,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.ok) throw new Error(data.error || `大模型调用失败（HTTP ${resp.status}）`);
  return data.content || '';
}

/** 把逐字稿按字数切块，尽量在句子边界切 */
export function chunkTranscript(segments, maxChars = CHUNK_CHARS) {
  const chunks = [];
  let cur = [];
  let len = 0;
  for (const s of segments) {
    const line = s.text || '';
    if (len + line.length > maxChars && cur.length) {
      chunks.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(s);
    len += line.length + 1;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** 给每句标上时间，方便模型引用 */
function withTimestamps(segments) {
  return segments
    .map((s) => (s.end > s.start || s.start > 0 ? `[${fmtTime(s.start)}] ${String(s.text || '').trim()}` : String(s.text || '').trim()))
    .join('\n');
}

const MAP_SYSTEM =
  '你是一名严谨又会讲课的大学课堂笔记助理。你的任务分两层：' +
  '**讲明白**（把老师省略掉的"为什么"补上，让学生真正理解）和**摘录**（记下老师实际讲的内容）。' +
  '讲明白时可以补充理解所必需的背景知识，但每一处都必须带「（补充）」标记；' +
  '绝不允许编造老师没说过的结论、数字、例题。' +
  '转写可能有同音字错误，遇到明显的识别错误请按上下文改正。';

const MAP_PROMPT = (body, idx, total, course) => `下面是一节大学课程${course ? `（${course}）` : ''}录音转写的第 ${idx}/${total} 段。
请先读懂这一段，再输出两部分：**(A) 讲解**（把老师讲的东西讲明白）和 **(B) 摘录**（值得记进笔记的内容）。
用紧凑的 Markdown 输出，没有内容的小节直接省略。

**注意：下面每个小节后面带了「（）说明」的，那是给你的写作要求，不是要你写的内容。绝对不要把说明里的字照抄进输出。**

## A. 讲解

### 这段在讲什么
　　（2-3 句，说清这段内容与它在整节课里的位置。）
### 概念是怎么来的
　　（把本段出现的术语/公式/方法，按"为什么要它 → 它怎么定义 → 它解决什么"讲清楚。
　　  允许补充本段没有、但理解所必需的背景知识，写的时候用「（补充）」标出来；
　　  不允许编造老师没说过的结论、数字、例题。）
### 推导与推理链
　　（本段有推导/证明/算法步骤的，把每一步和它的依据写出来。没有这一小节就整段省略。）
### 容易混的地方
　　（本段里学生最容易搞错、最容易和别的东西混淆的点，写成"A 和 B 的区别在于…"的形式。
　　  没有这一小节就整段省略。）

## B. 摘录

### 重点与结论
- 每条一个要点，保留老师的关键表述

### 概念与定义
- **术语**：定义

### 例子 / 案例
- 

### 老师强调 / 与考试相关
- （老师说的"这个是重点""会考""注意""容易错"等）

### 作业与安排
- （作业、截止时间、下节课安排等）

要求：
1. 每条尽量带上原文中的时间标记，格式为 [分:秒] 或 [时:分:秒]；
2. 去掉口头语、重复和与知识无关的闲聊；
3. 不要输出"这段讲了…"之类的元描述，直接给内容；
4. 「讲解」部分要把知识讲透，不要只是把老师的话换个说法 —— 那是摘录该干的事；
5. 凡是你自己补的背景知识，都必须带「（补充）」标记，方便读者分辨哪些是老师原话。

转写正文：
"""
${body}
"""`;

/**
 * 给模型的「时间分界点」提示。
 *
 * 2026-10 修（老大拿听脑 App 的截图做对比）：
 * 以前这里直接把离线引擎的 topic 骨架喂给模型，标题是「获得 · 务实」这种
 * 按词频拼出来的碎片。模型最省力的做法就是**照抄**，于是笔记里 26 个章节标题
 * 全是碎片（「相继重病 · 课这上说了突」「美国 · 亿美金」），而且 26 个主题
 * 平均 21 秒一个 —— 相当于根本没分段。
 *
 * 现在只喂**时间分界点**这一个信息（分成几段、每段从哪秒开始），
 * 明确告诉模型：这些只是"大致在哪切"，标题和分几段由你自己按内容判断。
 * 这样既保留了离线切分的锚点（保证时间戳落在合理位置），又不会被劣质标题带跑。
 */
function timeHints(topics) {
  const list = (topics || []).filter((t) => t && t.start != null);
  if (!list.length) return '';
  return `【时间分界点】离线算法按话题衔接度切出来的大致位置，**仅供参考**。
这些切点只能告诉你「大概在哪一秒换话题」，**不要照抄它们当标题** ——
标题请按你对内容的理解自己起。分几段也由你自己定（全篇 3-8 个），
不必和下面这些切点一一对应；时间戳从下面这些秒数里挑最接近的：
${list.map((t, i) => `${i + 1}. ${fmtTime(t.start)}`).join(' ｜ ')}
`;
}

function reduceSystem(style) {
  const styleHint =
    {
      exam: '风格：应试复习版。重点是"考什么、怎么考、易错点"，考点要突出。',
      outline: '风格：层级提纲版。用多级列表把知识结构梳理清楚，方便快速回顾。',
      cornell: '风格：康奈尔笔记版。左侧线索/关键词，右侧笔记要点，末尾有总结。',
    }[style] || '';
  return `你是一名资深的大学课程笔记整理专家，擅长把口语化的课堂录音整理成**能当教材读**的复习笔记。${styleHint}

你的工作分两层：
1. **讲明白**：把知识的内在逻辑讲透 —— 概念为什么需要、怎么定义、推导每一步依据什么、和相邻概念什么关系。学生读完应该能自己复述出推理过程，而不是只背结论。
2. **忠于课堂**：笔记的骨架、重点、例子、考点必须以老师实际讲的内容为准。

材料里带「（补充）」标记的内容是分段整理时补的背景知识，你**只能**把它用在「概念与定义」「理解脉络」里，
写的时候保留「（补充）」标记；「课堂脉络与重点」「考点提示」里**不许**出现老师没讲过的结论、数字、例题。
如果某处转写明显残缺，就写"（此处录音不清）"，不要用想象把它补圆。`;
}

/**
 * 「课堂脉络与重点」里每个主题写几条要点 —— 两个提示词共用的那一行要求。
 *
 * maxPoints 来自「新建录音」弹窗 / 详情页「笔记设置」里的「重点条数」：
 *   0  = 自适应：让模型按主题篇幅自己定（长主题多写、短主题少写）；
 *   >0 = 用户指定的固定条数。
 *
 * 这里只生成那行文字，REDUCE_PROMPT 和 DIRECT_PROMPT 都调它 ——
 * 以前两处各写死一句「3-7 条」，改一处忘另一处就会前后不一致。
 * （离线笔记走的是 public/summarize.js 的 autoPoints()，与这里无关。）
 */
function pointsRule(maxPoints) {
  const n = Number(maxPoints) || 0;
  if (n > 0) {
    return `- 要点（**每个主题正好 ${n} 条**，不多不少；保留关键数字、公式、术语。这个主题的内容撑不满 ${n} 条时，把相邻的小点合并成一条，不要为了凑数把一句话拆成两条，更不许编造）`;
  }
  return `- 要点（**每个主题 2-8 条，按这个主题的篇幅自己定**：只讲了两三句的短主题写 2-3 条，讲了很久的长主题写 6-8 条，不要每个主题都写一样多；保留关键数字、公式、术语）`;
}

const REDUCE_PROMPT = ({ title, course, date, duration, keywords, topics, maps, extra, style, nouns, maxPoints }) => `请把下面这些「分段要点」合并成**一份完整、连贯、可直接复习的课堂笔记**，用 Markdown 输出。

严格使用这个结构（没有内容的小节可以省略，但顺序不要变）。
**方括号里的话是给你的写作要求，不是要写的内容 —— 绝对不要把它们抄进输出。**

# ${title}
${noteMetaLine({ course, date, duration })}

## 一句话概要
［40 字以内，说清这节课的主线。］

## 关键词
\`词\` · \`词\` · \`词\`［8-15 个，来自下面的材料，不要自己发明。］

## 课堂脉络与重点
［第一步：先划分章节。按内容自然分段，**全篇 3-8 个主题**（15 分钟以内的短课 3-6 个），
  每个主题至少覆盖 1.5~3 分钟的讲话内容。十几秒一个主题等于没分段，必须把讲同一件事的相邻内容合并。
  第二步：给每个主题起名。「### 主题名」必须是**概括性短语**，12-22 字，只看标题就知道这段讲了什么，
  要能说清"讲的谁、做了什么、观点是什么"，例如「二叉树非递归遍历的三种实现」「考勤扣分为什么要设上限」。
  **禁止**以下写法：机器按词频拼出来的碎片（两个名词直接加「·」拼起来，如「概念甲 · 概念乙」）、
  「第一部分」「内容一」「这一段」这类空话、以及从下面【时间分界点】直接搬词。］
### 1. 主题名  [mm:ss]
${pointsRule(maxPoints)}
### 2. 主题名  [mm:ss]
- ……

## 理解脉络
［这是整份笔记的核心，也是它比逐字稿多出来的东西，不能只写两三句。
  用 3-8 条把知识连成一条线：这个主题要解决什么问题 → 直接做法卡在哪 →
  这节课的办法怎么绕过去 → 各个概念之间是什么关系。
  要求：
  ① 用 2-4 段连贯的文字（不要写成一句一条的流水账）；
  ② **不要复述"有什么规定/有什么结论"，要讲"为什么这样、它想让什么变好、代价是什么"**。
     每写一条都要能接上"因为…"或"如果不这样就…"，接不上的就不要写；
     举两个合格的句式（**句式是范例，不是要你照抄，也不许把"A""B"这两个字母写进输出**）：
     　　"平时成绩占 50 分，是为了让学生在学期中持续投入，而不是把全部压力押在期末一次考试上。"
     　　"考勤扣分设上限，是为了避免学生因为一次迟到就彻底放弃这门课。"
  ③ 推导/证明/算法类的内容，把关键几步的依据写出来；
  ④ 材料里没有、但读者理解所必需的背景知识，补上去并带「（补充）」标记。
  ⑤ 篇幅硬要求：「理解脉络」的正文不少于全篇字数的四分之一，且不少于 300 字。］

## 概念与定义
- 每条写成「概念名 —— 它的定义」的形式  [mm:ss]
- 补背景知识的地方带「（补充）」

## 考点提示
- ［老师明确说要考、或反复强调、或提醒容易错的点。］

## 易错与易混
- ［把材料里"容易混的地方"汇总起来，写 3-6 条。每条都要写成完整句子，把"区别在哪、为什么会错"说清楚。
   句式范例（**范例是给你看格式的，不是要你照抄，更不许把「概念甲」「概念乙」这几个字写进输出**）：
   　　"「概念甲」和「概念乙」的区别在于…，因为…"
   　　"这里容易错在…，正确做法是…"
   不能只丢一句结论。总长至少 100 字。］

## 例子与案例
- 

## 作业与安排
- 

## 自测题
1. ［5-8 题，**必须是疑问句**，只出题、不给答案，用来遮住笔记自测。］

## 需要回听核对的地方
- ［转写含糊、逻辑跳跃、疑似识别错误的地方，标注 [mm:ss]。］

硬性要求：
1. 所有时间标记必须写成 [mm:ss] 或 [时:分:秒] 的方括号形式，位置紧跟在对应内容后面，**不要**改写成链接或其他格式；
2. 主题标题要具体（如"非递归遍历的实现"），不要写"第一部分"；
3. 合并同类项，去掉重复内容；语言精炼，不要车轱辘话；
4. **不许整句照抄分段要点**：除了专业术语、公式、专有名词和数字，其余一律用你自己的话重写，
   "课堂脉络与重点"里的每条要点概括成 20-40 字；
5. 自测题只写问句，绝对不要把答案写在题目里；
6. 不要输出你的思考过程，直接输出 Markdown 正文；**不要用代码块把整篇包起来**（不要用三个反引号开头、结尾也不要加）—— 第一行直接就是 # 标题；
7. 「理解脉络」和「易错与易混」不许留空、也不许只写两三个字 —— 就算材料很零碎，也要把能看出来的逻辑关系写出来；
8. 不许把上面结构说明里的字（包括方括号里的要求）抄进正文。
9. 材料里带「（补充）」的内容是你的分段整理补的背景知识，用的时候保留标记；不许编造老师没说过的结论、数字、例题。
10. **具体的数字、奖项、论文数、职务、成绩，只能来自材料**。材料里没有的，一律不许补 ——
    实测过的反面例子：材料里只写了「自学完成学业」，模型却写成「3 年后发表 4 篇高水平论文」，
    老师根本没提过论文。宁可少写一条，也不许为了让段落好看而编造事实。
${extra ? `\n额外要求（用户指定，优先级最高）：${extra}\n` : ''}
【离线引擎抽出的关键词，供参考】${keywords.join('、') || '（无）'}
${timeHints(topics)}${nouns ? '\n' + nouns : ''}
【分段要点】
${maps.map((m, i) => `──────── 第 ${i + 1} 段 ────────\n${m}`).join('\n\n')}`;

/**
 * 短课直接整理用的提示词（不经过 map 分段）。
 *
 * 为什么不复用 REDUCE_PROMPT：REDUCE 的输入是「分段要点」，里面已经有讲解内容；
 * 而这里的输入是**原始逐字稿**，老师通常只讲了"是什么"、没讲"为什么"。
 * 所以必须换一套要求：明确授权模型去解释和补背景，同时把「（补充）」标记义务写死，
 * 否则模型要么照抄口语（总结太浅），要么毫无标记地放飞（幻觉）。
 */
const DIRECT_SYSTEM = (style) => {
  const styleHint =
    {
      exam: '风格：应试复习版。重点是"考什么、怎么考、易错点"，考点要突出。',
      outline: '风格：层级提纲版。用多级列表把知识结构梳理清楚，方便快速回顾。',
      cornell: '风格：康奈尔笔记版。左侧线索/关键词，右侧笔记要点，末尾有总结。',
    }[style] || '';
  return `你是一名资深的大学课程笔记整理专家。现在给你一节短课的**完整逐字稿**（口语、有重复、有同音字错误），
请把它整理成**能当教材读**的复习笔记 —— 不是把口语压缩一遍，而是把知识讲明白。${styleHint}

**第一步：先把逐字稿翻译成书面语。** 逐字稿是语音识别「一个个听出来」的，带着大量口语渣滓，笔记里一个字都不许原样保留，必须整体重写：
- 删掉所有语气词和口头语：就、呢、吧、啊、哦、嘛、那、那么、咱们、这个、那个、然后、就是、对不对、是不是、你们知道吗……
- 删掉重复、结巴、自我纠正（「就是就是」「这个这个」「我们我们」只留一遍）；
- 把「大家刚上大学」「下面我们来讲」这类招呼语和过渡废话，压缩成笔记正文或直接丢掉；
- 把残缺、错位的半句话，按上下文还原成完整、通顺的书面句；
- 逐字稿里的同音字/拼音首字母错字（如「期朴考诗」→「期末考试」、「BJR」→「闭卷」、「回伙」→「回复」）必须按上下文改正，拿不准的写进「需要回听核对的地方」。

写完书面语之后，再进入下面的讲明白环节。

请注意：课堂口语通常是"老师知道自己在讲什么，所以省略了为什么"。你的核心价值就是把这些省略补回来：
- 这个概念**为什么**需要？没有它会怎样？
- 它的定义里每个限定词是干什么的？
- 推导/算法每一步依赖什么前提？
- 它和相邻概念的区别在哪？

允许你补充**理解所必需**的背景知识和学科常识，但必须用「（补充）」标出来。
不允许编造老师没说过的结论、数字、例题；转写残缺处写"（此处录音不清）"，不要用想象补圆。
讲不明白的地方宁可留白，也不要编。`;
};

const DIRECT_PROMPT = ({ title, course, date, duration, body, extra, keywords, topics, style, nouns, maxPoints }) => `请把下面这节短课的逐字稿整理成一份**能直接拿来复习的课堂笔记**，用 Markdown 输出。

严格使用这个结构（没有内容的小节可以省略，但顺序不要变）。
**方括号里的话是给你的写作要求，不是要写的内容 —— 绝对不要把它们抄进输出。**

# ${title}
${noteMetaLine({ course, date, duration })}

## 一句话概要
［40 字以内，说清这节课的主线。］

## 关键词
\`词\` · \`词\` · \`词\`［8-15 个，来自逐字稿，不要自己发明。］

## 课堂脉络与重点
［第一步：先划分章节。按内容自然分段，**全篇 3-8 个主题**（15 分钟以内的短课 3-6 个），
  每个主题至少覆盖 1.5~3 分钟的讲话内容。十几秒一个主题等于没分段，必须把讲同一件事的相邻内容合并。
  第二步：给每个主题起名。「### 主题名」必须是**概括性短语**，12-22 字，只看标题就知道这段讲了什么，
  要能说清"讲的谁、做了什么、观点是什么"，例如「二叉树非递归遍历的三种实现」「考勤扣分为什么要设上限」。
  **禁止**以下写法：机器按词频拼出来的碎片（两个名词直接加「·」拼起来，如「概念甲 · 概念乙」）、
  「第一部分」「内容一」「这一段」这类空话、以及从下面【时间分界点】直接搬词。］
### 1. 主题名  [mm:ss]
${pointsRule(maxPoints)}
### 2. 主题名  [mm:ss]
- ……

## 理解脉络
［这是整份笔记的核心，不能只写两三句。用 3-8 条把知识连成一条线：
  这个主题要解决什么问题 → 直接做法卡在哪 → 这节课的办法怎么绕过去 → 各概念之间什么关系。
  要求：
  ① 用 2-4 段连贯的文字（不要写成一句一条的流水账）；
  ② **不要复述"有什么规定/有什么结论"，要讲"为什么这样、它想让什么变好、代价是什么"**。
     每写一条都要能接上"因为…"或"如果不这样就…"，接不上的就不要写；
     举两个合格的句式（**句式是范例，不是要你照抄，也不许把"A""B"这两个字母写进输出**）：
     　　"平时成绩占 50 分，是为了让学生在学期中持续投入，而不是把全部压力押在期末一次考试上。"
     　　"考勤扣分设上限，是为了避免学生因为一次迟到就彻底放弃这门课。"
  ③ 推导/证明/算法类的内容，把关键步骤和每一步的依据写出来；
  ④ 逐字稿里没讲、但读者理解所必需的，补上去并带「（补充）」标记。
  ⑤ 篇幅硬要求：正文不少于 300 字，且不少于全篇字数的四分之一。］

## 概念与定义
- 每条写成「概念名 —— 它的定义」的形式  [mm:ss]

## 考点提示
- ［老师明确说要考、或反复强调、或提醒容易错的点；别把你自己觉得重要的当成老师说的。］

## 易错与易混
- ［写 3-6 条。每条都要写成完整句子，把"区别在哪、为什么会错"说清楚。
   句式范例（**范例是给你看格式的，不是要你照抄，更不许把「概念甲」「概念乙」这几个字写进输出**）：
   　　"「概念甲」和「概念乙」的区别在于…，因为…"
   　　"这里容易错在…，正确做法是…"
   不能只丢一句结论。总长至少 100 字。既可来自老师提醒，也可来自你对这个学科的判断，
   后者请带「（补充）」标记。］

## 例子与案例
- 

## 作业与安排
- 

## 自测题
1. ［5-8 题，**必须是疑问句**，只出题、不给答案，用来遮住笔记自测。］

## 需要回听核对的地方
- ［转写含糊、逻辑跳跃、疑似识别错误的地方，标注 [mm:ss]。］

硬性要求：
1. 所有时间标记必须写成 [mm:ss] 或 [时:分:秒] 的方括号形式，位置紧跟在对应内容后面，**不要**改写成链接或其他格式；
2. 主题标题要具体（如"非递归遍历的实现"），不要写"第一部分"；
3. 合并同类项，去掉重复内容；语言精炼，不要车轱辘话；
4. **逐字稿必须整体翻译成书面语，一个字都不许原样照搬**：除了专业术语、公式、专有名词和数字，其余一律用你自己的话重写成干净利落的书面句。
   "一句话概要"要是一句通顺完整的书面语（不是把老师半句话拼起来），
   "课堂脉络与重点"里每条要点是书面语、概括成 20-40 字，绝不能把老师那句带「就、呢、吧、那么、咱们、这个、那个」的口语原样搬过来；
5. 自测题只写问句，绝对不要把答案写在题目里；
6. 不要输出你的思考过程，直接输出 Markdown 正文；**不要用代码块把整篇包起来**（不要用三个反引号开头、结尾也不要加）—— 第一行直接就是 # 标题；
7. 「理解脉络」和「易错与易混」不许留空、也不许只写两三个字；
8. 逐字稿有同音字错误或拼音首字母误识（如「BJR」→「闭卷」），按上下文改正；拿不准的写进「需要回听核对的地方」，不要硬猜；
9. 不许把上面结构说明里的字（包括方括号里的要求）抄进正文。
10. **具体的数字、奖项、论文数、职务、成绩，只能来自逐字稿**。逐字稿里没有的，一律不许补 ——
    实测过的反面例子：逐字稿只说了「自学完成学业」，模型却写成「3 年后发表 4 篇高水平论文」，
    老师根本没提过论文。宁可少写一条，也不许为了让段落好看而编造事实。
${extra ? `\n额外要求（用户指定，优先级最高）：${extra}\n` : ''}
【离线引擎抽出的关键词，供参考】${keywords.join('、') || '（无）'}
${timeHints(topics)}${nouns ? '\n' + nouns : ''}
【逐字稿】
${body}`;

/**
 * 生成 AI 笔记
 * @param {object} p
 * @param {Array}  p.segments   转写片段
 * @param {object} p.meta
 * @param {object} p.analysis   离线分析结果（提供关键词与主题骨架）
 * @param {object} p.options    {style, extraPrompt, maxPointsPerTopic, title, course}
 *                              maxPointsPerTopic: 0=自适应，>0=每个主题固定几条要点
 * @param {(msg:string, pct:number)=>void} p.onProgress
 * @param {AbortSignal} p.signal
 * @returns {Promise<{markdown:string, model:string, steps:number}>}
 */
export async function generateAINote({ segments, meta = {}, analysis = {}, options = {}, onProgress = () => {}, signal }) {
  if (!segments || !segments.length) throw new Error('还没有转写内容，先生成逐字稿。');
  const style = options.style || 'exam';
  const fullText = segments.map((s) => s.text).join('');
  const keywords = (analysis.keywords || []).slice(0, 16).map((k) => k.term);
  const topics = analysis.outline || [];
  let steps = 0; // 只统计真实的模型调用次数
  const base = {
    title: options.title || meta.title || '课堂笔记',
    course: options.course || meta.course || '',
    date: String(meta.date || meta.createdAt || '').slice(0, 10),
    // 时长优先取逐字稿最后一段的结束时间：云端转写（SenseVoice）不返回时间戳、
    // 上传时又没量过时长时 meta.duration 是 0，但本地转写的 segments 里有真时间。
    duration: Number(meta.duration) || Number(segments[segments.length - 1]?.end) || 0,
    keywords,
    topics,
    nouns: '',
    extra: options.extraPrompt || '',
    style,
    // 「重点条数」：0 = 自适应（由提示词让模型按主题篇幅自己定），>0 = 固定条数。
    // 以前这个选项只喂了离线引擎，AI 笔记完全没读它 —— 用户在弹窗里选 3 条、选 8 条，
    // 出来的笔记都是一个样。现在真的传进提示词了（见 pointsRule()）。
    maxPoints: Number(options.maxPointsPerTopic) || 0,
  };

  let maps = [];
  if (fullText.length <= DIRECT_LIMIT) {
    onProgress('正在整理笔记…', 10);
    maps = [withTimestamps(segments)];
  } else {
    const chunks = chunkTranscript(segments);
    onProgress(`逐字稿较长，分 ${chunks.length} 段整理…`, 5);
    for (let i = 0; i < chunks.length; i++) {
      if (signal?.aborted) throw new Error('已取消');
      onProgress(`正在整理第 ${i + 1}/${chunks.length} 段…`, 5 + Math.round((i / chunks.length) * 65));
      const body = withTimestamps(chunks[i]);
      const out = await callLLM(
        [
          { role: 'system', content: MAP_SYSTEM },
          { role: 'user', content: MAP_PROMPT(body, i + 1, chunks.length, base.course) },
        ],
        { signal }
      );
      maps.push(out.trim());
      steps++;
    }
  }

  onProgress('正在汇总成稿…', 78);
  const isDirect = fullText.length <= DIRECT_LIMIT;
  const prompt = isDirect ? DIRECT_PROMPT({ ...base, body: maps[0] }) : REDUCE_PROMPT({ ...base, maps });
  const markdown = await callLLM(
    [
      { role: 'system', content: isDirect ? DIRECT_SYSTEM(style) : reduceSystem(style) },
      { role: 'user', content: prompt },
    ],
    { signal, temperature: 0.3 }
  );
  steps++;
  onProgress('完成', 100);
  // 模型偶尔会把提示词里的写作要求（全角方括号）抄进正文 —— 保存前先滤掉。
  // 再用地道的真实元数据盖掉头部那行「课程 / 日期 / 时长」：模型写这行只会照抄
  // 模板里的「（未填）」「未知」，而这三个值我们本来就知道。
  let body = linkifyTimestamps(applyNoteHeader(stripPromptLeaks(markdown), base));

  // 出稿后两道核对，都是「先对齐原文，对不上的才问」：
  //   ① 原子片段（数字 / 英文词）逐一对齐逐字稿，对不上或右邻字不一致 → 报；
  //   ② 笔记里反复出现、逐字稿里找不到原样写法的中文片段 → 交模型自己判：
  //      是识别错误被改对了（不报，这是它该做的），还是凭空编的（报）。
  // 都不自动删句子（可能删掉真结论），只写进「需要回听核对的地方」。
  const unverified = findUnverifiedFacts(body, fullText);
  let invented = [];
  let fixes = [];
  const terms = findSuspiciousTerms(body, fullText);
  if (terms.length || body.replace(/[^\u4e00-\u9fa5]/g, '').length >= 200) {
    onProgress('正在核对可疑片段…', 92);
    // 两条路一起跑，互不依赖：
    //   ① 给候选逐条打勾（crossCheckTerms）—— 精确，但只能看抽到的词；
    //   ② 整篇通读自己找（openEndedFixes）—— 召回高得多，补上「候选里根本没这个
    //      词」的漏网（实测「成因性」排在候选池第 51 位，压根没进 24 条里）。
    // 并发跑，总耗时由慢的那条决定，不多花一次往返。
    const [chk, open] = await Promise.all([
      terms.length ? crossCheckTerms(terms, { signal, sourceText: fullText }) : null,
      openEndedFixes(body, { signal, sourceText: fullText }),
    ]);
    if (chk) {
      steps++;
      invented = chk.invented;
      fixes = chk.fixes;
    }
    if (open && open.length) {
      steps++;
      // 两条路可能挑到同一个错写法，按 text 去重（逐条核对那条带上下文，优先留）
      const seen = new Set(fixes.map((f) => f.text));
      for (const f of open) if (!seen.has(f.text)) { fixes.push(f); seen.add(f.text); }
    }
  }
  // 能确定写错了的（专名同音误识这类），直接改对再报告。
  // 只改「笔记里确实是这个错写法」的，改完在核对小节里写明改了哪个 ——
  // 不默默改，用户得能一眼看到模型动过什么。
  const applied = [];
  // 长的先改。同一个错名常同时以「林俊泽」和「林俊泽院士」两种形态进候选，
  // 先改短的那条，「林俊泽院士」就会变成「林俊德院士」后又被打一次；
  // 先改长的，短的再扫一遍剩下的位置，两边都干净。
  const fixQueue = fixes.slice().sort((a, b) => b.text.length - a.text.length);
  for (const f of fixQueue) {
    if (!f.to || f.to === f.text) continue;
    if (!body.includes(f.text)) continue;
    // 建议写法里包含了原写法 → 这不是「改错字」，是模型把原文的一截当成错词、
    // 想给它补个前缀/后缀。真按字面替换会把正文改坏：实测把「主动放弃」里的
    // 「动放弃」替换成「主动放弃」，结果变成「主主动放弃」。
    if (f.to.includes(f.text)) continue;
    // 反过来也一样：建议写法是原写法的一截（纯删除）也不是改错字。
    // 实测模型把「300天坚守岗位」里的「天坚守岗位」判成 fix → 「坚守岗位」，
    // 真按字面替换会变成「300坚守岗位」，把量词吃掉。
    // 同音误识改的是字，不是删字。
    if (f.text.includes(f.to)) continue;
    body = body.split(f.text).join(f.to);
    applied.push(f);
  }
  // 同一个误识术语往往在正文里出现好几次，候选只抽出其中一种形态：
  // 「斗争性与成因性」被判出来了，可关键词行里还单独躺着「成因性」，
  // 结果是同一段笔记里「同一性」5 处、「成因性」3 处，前后打架。
  // 解决办法是取两条写法的「差异核心」（去掉公共前后缀剩下的那截），
  // 核心够长（>=2 字）才做全文对齐 —— 单字差异一律不动，
  // 「林俊泽→林俊德」的核心只是「泽/德」，全局替换一个「泽」字太危险。
  const coreFixes = [];
  for (const f of applied) {
    const d = coreDiff(f.text, f.to);
    if (!d) continue;
    if (!body.includes(d.wrong)) continue;
    const r = alignByCore(body, d);
    if (!r.hits) continue;
    body = r.body;
    coreFixes.push({ ...f, coreFrom: d.wrong, coreTo: d.right, count: r.hits });
  }
  // 同一条编造常被拆成好几条报（「放弃物质利益」「国家使命」「核项目」
  // 其实指向同一句「…放弃物质利益追求国家使命」）。按 claim 去重，
  // 一条编造只报一次。
  const seenClaim = new Set();
  invented = invented.filter((x) => {
    const k = String(x.claim || '').replace(/\s/g, '');
    if (!k || seenClaim.has(k)) return false;
    seenClaim.add(k);
    return true;
  });
  // 已经是「改正目标」的词，别在「找不到依据」里再报一遍 —— 那句话通常就是
  // 我们刚改对的那个名字的宾语（模型拿常识补了「放弃物质利益」这种修饰）。
  const fixedTo = new Set(applied.map((f) => f.to));
  invented = invented.filter((x) => {
    const claim = String(x.claim || '');
    // claim 里提到的是我们刚改对的名字，且这条本来就是从那个名字派生的 → 只留改正记录
    for (const to of fixedTo) {
      if (claim.includes(to) && String(x.text || '').includes(to)) return false;
    }
    return true;
  });
  const warnings = [];
  if (unverified.length) {
    warnings.push(`- ⚠ 下列数字在逐字稿里对不上，可能是模型补的，请谨慎采信：${unverified.join('、')}`);
  }
  if (applied.length) {
    warnings.push(
      `- ✎ 已按专名知识改正（如与老师原话不符请改回）：` +
        applied.map((x) => `${x.text} → ${x.to}`).join('、')
    );
  }
  if (coreFixes.length) {
    // 只报「核心也一起改了」的那几条，且写明改了几处 ——
    // 用户得能知道模型除了动那一处，还在别处动过同样的词。
    warnings.push(
      `- ✎ 同一处误识在正文里另有写法，已一并改成一致：` +
        coreFixes.map((x) => `${x.coreFrom} → ${x.coreTo}（${x.count} 处）`).join('、')
    );
  }
  if (invented.length) {
    warnings.push(
      `- ⚠ 下列说法在逐字稿里找不到依据，可能是模型补的背景知识，请核对后再采信：\n` +
        invented.map((x) => `  · 「${x.claim}」`).join('\n')
    );
  }
  if (warnings.length) {
    const note = warnings.join('\n');
    const sec = /^##\s*需要回听核对的地方\s*$/m;
    if (sec.test(body)) {
      const at = body.indexOf('## 需要回听核对的地方');
      const lineEnd = body.indexOf('\n', at);
      body = body.slice(0, lineEnd + 1) + note + '\n' + body.slice(lineEnd + 1);
    } else {
      body += `\n\n## 需要回听核对的地方\n${note}\n`;
    }
  }

  const withAppendix = body.includes('<summary>')
    ? body
    : `${body}\n\n${buildTranscriptDetails(segments)}\n`;
  return { markdown: withAppendix, model: 'llm', steps, unverified, invented, fixes: applied, terms };
}

/**
 * 逐字稿附录：让「AI 笔记」导出后也是自包含的。
 * 离线引擎生成的笔记本来就带这一段，AI 版以前没有，导出到
 * Obsidian / Notion 后就查不到原话了，所以统一补上。
 */
function buildTranscriptDetails(segments) {
  const hasTime = segments.some((s) => Number(s.end) > Number(s.start) || Number(s.start) > 0);
  const L = ['---', '', '<details>', '<summary>📄 展开完整逐字稿（按时间轴）</summary>', ''];
  for (const s of segments) {
    const text = String(s.text || '').trim();
    if (!text) continue;
    L.push(hasTime ? `**[${fmtTime(s.start)}](#t=${Number(s.start).toFixed(2)})** ${text}` : text);
    L.push('');
  }
  L.push('</details>');
  return L.join('\n');
}

/**
 * 笔记头部那行「> 课程：… ｜ 日期：… ｜ 时长：…」。
 *
 * 2026-10 修：以前这行是写进提示词模板、让大模型自己填的，结果它把模板里的
 * 「（未填）」「未知」原样抄进正文 —— 用户看到的就是「课程： （未填） ｜ 日期： ｜ 时长： 未知」。
 * 这三个都是程序完全知道的确定值，根本不该交给模型去写。
 * 现在改成：模型可以不管这行，出稿后由 applyNoteHeader() 用真实元数据覆盖掉。
 */
function noteMetaLine(meta = {}) {
  const bits = [];
  const course = String(meta.course || '').trim();
  if (course) bits.push(`课程：${course}`);
  const date = String(meta.date || meta.createdAt || '').slice(0, 10);
  if (date) bits.push(`日期：${date}`);
  const dur = Number(meta.duration) || 0;
  if (dur > 0) bits.push(`时长：${fmtTime(dur)}`);
  return bits.length ? '> ' + bits.join(' ｜ ') : '';
}

/**
 * 用真实元数据重写笔记头部的「课程 / 日期 / 时长」。
 * 空字段直接不写（不写「（未填）」「未知」这种占位词），全都空就整行不要。
 *
 * 注意是**逐字段改写**、不是整行替换：离线引擎生成的笔记这一行还带
 * 「风格：应试重点版」，整行盖掉会把风格弄丢。不认识的字段原样留在原位。
 */
export function applyNoteHeader(md, meta = {}) {
  const owned = new Set(['课程', '日期', '时长']);
  const empty = (v) => !v || /^[（(]?\s*(未填|未知|无)\s*[)）]?$/.test(String(v).trim());
  const course = String(meta.course || '').trim();
  const date = String(meta.date || meta.createdAt || '').slice(0, 10);
  const dur = Number(meta.duration) || 0;
  const fresh = [];
  if (!empty(course)) fresh.push(`课程：${course}`);
  if (!empty(date)) fresh.push(`日期：${date}`);
  if (dur > 0) fresh.push(`时长：${fmtTime(dur)}`);

  const lines = String(md || '').split('\n');
  const idx = lines.findIndex((l) => /^\s*>/.test(l) && /课程：|日期：|时长：/.test(l));

  if (idx >= 0) {
    // 按「｜」切字段，认识的三项丢掉换成新的，其余（风格：…之类）原样保留
    const kept = lines[idx]
      .replace(/^\s*>\s?/, '')
      .split(/\s*｜\s*/)
      .map((f) => f.trim())
      .filter((f) => {
        if (!f) return false;
        const m = f.match(/^([^：:]+)[：:]/);
        return !(m && owned.has(m[1].trim()));
      });
    const merged = [...kept, ...fresh];
    if (merged.length) lines[idx] = '> ' + merged.join(' ｜ ');
    else lines.splice(idx, 1);
    return lines.join('\n');
  }

  if (!fresh.length) return lines.join('\n');
  // 模型漏写这行时，插在第一个标题后面
  const h = lines.findIndex((l) => /^#\s+/.test(l));
  const at = h >= 0 ? h + 1 : 0;
  lines.splice(at, 0, '> ' + fresh.join(' ｜ '));
  if (at + 1 < lines.length && lines[at + 1].trim()) lines.splice(at + 1, 0, '');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * 出稿后「对不上原文」的检查（2026-10 重写）
 * ------------------------------------------------------------------ */

/**
 * 这一节的旧实现是三道「先枚举再查」：量词表（篇|次|亿|岁…约 50 个）、
 * 姓氏表（王李张…100 个）、称谓表（院士|教授|先生…）。它们只管用中文课：
 * 换成高数（公式、推导）、英语（中英混排）、化学（分子式）、物理（单位）
 * 就全部失效 —— 而词表永远列不完，也不该靠列。
 *
 * 重写后的原则：**不预设要检查什么，只预设什么叫「对不上」**。
 *   ① 原子片段（数字串 / 英文词 / 代号）逐一对齐原文。这类片段在任何学科里
 *      都是「不可改写」的单位，而判定它只需要字符类（有没有数字、有没有字母），
 *      这是语言层的事实，与考什么科目无关。
 *   ② 数字后面紧跟的那一个字，与原文同一位置的那个字比对 —— 这就是旧版
 *      「4 篇 vs 4 天」那道判据的一般化：**不需要知道「篇」是量词**，
 *      原文写什么就比什么。数学课的「x 的平方」、化学课的「2 摩尔」同样适用。
 *   ③ 专名不再猜（姓氏 + 称谓）。凡是**笔记里反复出现、原文里找不到原样写法**
 *      的中文片段都算可疑片段，连同它在笔记里的上下文一次性交给模型自己判断：
 *      它见过的专名比任何词表都多。模型说是识别错误就照它改并记账，说是编的
 *      就写进核对清单。这一步完全不知道「人名」长什么样，也不需要有这张表。
 *
 * 已知边界（故意不做，宁可漏判也不制造噪声）：公式里的符号（= ∫ ∑ ² H₂SO₄）
 * 不参与比对 —— 语音转写里根本不会出现符号，比了全是误报。数学课真正被兜住的
 * 是**数字**，公式外形由模型按板书常识重建，这一点写在报告里，不吹成"全学科通吃"。
 */

/** 把 segments / 纯字符串 / 字符串数组都摊平成无空白纯文本 */
function flatText(segments) {
  const list = typeof segments === 'string' ? [segments] : segments || [];
  return list
    .map((s) => String(typeof s === 'string' ? s : s.text || ''))
    .join('')
    .replace(/\s/g, '');
}

/** 全角数字/字母转半角，便于逐字比对（不动汉字） */
function normAlnum(s) {
  return String(s || '')
    .replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\uFF21-\uFF3A\uFF41-\uFF5A]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\uFF0E/g, '.');
}

/**
 * 中文数字 → 阿拉伯数字（语言层换算，不是学科词表）。
 *
 * 为什么必须有：老师嘴里说「零点五摩尔」「九十八」「三百天」，笔记里写成
 * 「0.5 mol」「98」「300 天」是完全正确的改写。不做这层换算，
 * 每一个用中文读出来的数字都会被判成「原文没有」—— 实测化学课那条
 * 「0.5」就是被这么误报的。
 */
const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNIT = { 十: 10, 百: 100, 千: 1000 };
/** 候选串：必须含至少一个数字字或单位字，且不能以「点」开头（「重点」不许被当成小数） */
const CN_NUM_RUN = /[零〇一二两三四五六七八九十百千万][零〇一二两三四五六七八九十百千万点]*/g;

function cnRunToArabic(run) {
  const dot = run.indexOf('点');
  // 「三点建议」里的「点」不是小数点：后面没跟数字就原样留着，
  // 否则「三点」会变成「3.0」，笔记里的「3 点」反而对不上。
  if (dot > 0 && !/[零〇一二两三四五六七八九]/.test(run.slice(dot + 1))) {
    return `${cnRunToArabic(run.slice(0, dot))}点`;
  }
  if (dot > 0) {
    const a = cnRunToArabic(run.slice(0, dot)) || '0';
    const b = run
      .slice(dot + 1)
      .replace(/[零〇一二两三四五六七八九]/g, (c) => String(CN_DIGIT[c]))
      .replace(/[^0-9]/g, '');
    return `${a}.${b || '0'}`;
  }
  if (/^[零〇一二两三四五六七八九]+$/.test(run)) {
    // 「九八」这种逐位读法
    return run.replace(/[零〇一二两三四五六七八九]/g, (c) => String(CN_DIGIT[c])).replace(/^0+(?=\d)/, '');
  }
  let total = 0;
  let section = 0;
  let num = 0;
  for (const ch of run) {
    if (CN_DIGIT[ch] !== undefined) num = CN_DIGIT[ch];
    else if (ch === '万') {
      total += (section + num) * 10000;
      section = 0;
      num = 0;
    } else if (CN_UNIT[ch]) {
      section += (num || 1) * CN_UNIT[ch];
      num = 0;
    } else if (ch === '点') {
      // 上面的 if 已经处理了带小数的情形；走到这里说明「点」在末尾或不成小数
      break;
    }
  }
  return String(total + section + num);
}

/** 把一段文字里所有中文数字串换成阿拉伯数字，前后留空格隔开 */
function cnNumeralsToArabic(text) {
  return String(text || '').replace(CN_NUM_RUN, (run) => ` ${cnRunToArabic(run)} `);
}

/**
 * 去掉 Markdown 结构，只留正文。
 * 必须去掉 <details> 里的逐字稿附录 —— 那是原文本身，拿它自查等于自己证明自己。
 */
function stripForCheck(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<details[\s\S]*?<\/details>/gi, ' ')
    // 公式整段去掉：语音转写里根本不会出现符号和公式外形，
    // 拿 LaTeX 里的 \frac、\lim 去对逐字稿，每一条都是误报。
    // 四种定界符都要覆盖 —— 只删 $…$ 会漏掉 \( … \) / \[ … \]，
    // 那样 `\frac`、`\left`、`\sqrt` 会被当成英文单词拿去对逐字稿
    // （实测高数那篇就是这样报出「frac 逐字稿里没有这个数」）。
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/\\\[[\s\S]*?\\\]/g, ' ')
    .replace(/\\\([\s\S]*?\\\)/g, ' ')
    .replace(/\$[^$\n]*\$/g, ' ')
    // 「- ⚠ …」是上一次生成时我们自己写进去的警告，里面全是数字和人名。
    // 不删掉就会自己查自己：警告里提到「4 篇」，下一次生成又因为这条警告报一次。
    .replace(/^[-*]\s*⚠.*$/gm, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    // 头部那行「课程 / 日期 / 时长」是我们用真实元数据写的（applyNoteHeader），
    // 数字来自 meta 而不是模型，拿它去对逐字稿只会得到「2026 原文没有」这种噪声。
    .replace(/^>.*$/gm, ' ')
    // [00:00] / [01:28:04] 这类时间戳，以及正文里的 mm:ss 时分秒
    .replace(/\[?\b\d{1,2}:\d{2}(?::\d{2})?\b\]?/g, ' ')
    .replace(/^#{1,6}\s*/gm, ' ')
    // 有序列表的序号（「1. 」「2、」）不是正文里的数字
    .replace(/^\s*\d+\s*[.、)）]\s+/gm, ' ')
    // Markdown 强调符号换成空格而不是删掉：删掉会把「2024~2027」粘成「20242027」，
    // 变成一个原文里根本不存在的大数，凭空造出一条误报。
    .replace(/[*_`~]/g, ' ');
}

/**
 * 剥掉「我们自己写进去的东西」——不是老师讲的、也不是模型写的内容。
 *
 * 这些字串的共同点是：它们由产品代码生成，却长得像正文，于是被核对逻辑
 * 当成模型编的。实测过的三类：
 *   ① 离线引擎的关键词行 `递归 (11) · 左孩子 (4)`，括号里的数字是词频统计；
 *   ② 页脚 `*由「讲义笔记 LectureNotes」自动整理生成…*`，`LectureNotes` 是产品名；
 *   ③ 上一轮自己写的 `- ⚠ …` 警告行（下面 stripForCheck 里另有处理）。
 * 核对逻辑不认识这三样，就会报「11 逐字稿里没有这个数」「LectureNotes 原文没有」
 * —— 离线笔记（不接大模型）每一篇都会中招。
 */
function stripNoteChrome(md) {
  return String(md || '')
    // 关键词行里的词频标注：只在它后面紧跟分隔符「·」「|」「｜」或行尾时才删，
    // 这样正文里的 `f(3)`、`O(n²)`、`第 (3) 点` 都不会被误伤。
    .replace(/[（(]\s*\d+\s*[)）](?=\s*[·|｜]|\s*$)/gm, ' ')
    // 离线引擎页脚（整行都是产品自己写的）
    .replace(/由「?讲义笔记[^\n]*/g, ' ');
}

const CJK_CHAR = /[\u4e00-\u9fa5]/;


/**
 * 数字后面「紧贴着」的那个汉字。
 *
 * 为什么只认汉字、只跳空格：
 *   ① 「4 篇」和「4 天」的差别就发生在紧邻的那个字上，中间没有标点；
 *   ② 一旦中间隔了逗号句号（「分子量是 98，配成 0.5 摩尔」），这个数字就是
 *      独立成分，后面那个字跟它没有关系，比了必然误报；
 *   ③ 英文词后面跟的永远是另一个英文词（「opportunity cost」），
 *      拿邻居去比同样必然误报 —— 汉字这个条件顺便把英文词全挡在外面。
 */
function unitAfter(str, i) {
  const s = String(str || '');
  let j = i;
  while (j < s.length && /\s/.test(s[j])) j++;
  const ch = s[j] || '';
  return CJK_CHAR.test(ch) ? ch : '';
}

/** 大小写无关地找出全部出现位置 */
function findAllCI(hay, needle) {
  const out = [];
  if (!needle) return out;
  const h = String(hay).toLowerCase();
  const n = String(needle).toLowerCase();
  let i = h.indexOf(n);
  while (i !== -1) {
    out.push(i);
    i = h.indexOf(n, i + 1);
    if (out.length >= 40) break;
  }
  return out;
}

/**
 * 原子片段：一段连续数字（带小数点/千分位），或一个 3 字符以上的英文/代号词。
 * 少了这两类，就等于「什么具体事实都不查」；多了（比如单个汉字、单个符号）
 * 全是噪声。字符类本身就是中性的，物理课的「9.8 m/s²」、化学课的「pH=7」、
 * 英语课的「opportunity」都会落进来。
 */
const ATOM_RE = /\d+(?:[.,]\d+)*|[A-Za-z][A-Za-z0-9#'+\-]{2,}/g;

/**
 * 这个数字是不是长在一段「式子」里，而不是叙述里。
 *
 * 为什么需要：高数/物理/化学课的笔记里，题目条件是用 Unicode 上标写的纯文本公式
 * （`9x²+4y²=36在(1,3√3/2)处的切线`），它们不经过 `\(...\)` 这类定界符，
 * stripForCheck 剥不掉，于是 `36`、`1,3` 这些数逐个被拿去对逐字稿 ——
 * 老师口头只会说「二分之三倍的根号三」，不会念出 `3√3/2`，这就是必然误报。
 * 实测 cc9c9d21（高数）一篇 5 条警告全是这类，真该报的（283 本、2000 名）反而被淹了。
 *
 * 判据只看**紧邻的字符**，不动「数字在原文里到底有没有」这条主判据：
 *   - 旁边是运算符/上下标/根号/字母变量 → 是式子
 *   - 本身是逗号分隔的坐标列表且被括号包着（`(1,3√3/2)`、`（15,20,25）`）→ 是式子
 * 保守起见「度」（`45°辅助线`）不算式子 —— 老师没说过这个角度，那就是真编的，要报。
 */
const MATH_NEIGHBOR = /[=+\-×÷·^_<>≤≥≈≠±√∑∏∫∞]/;
const SUP_SUB = /[\u00B2\u00B3\u00B9\u2070-\u209F]/;
const BRACKET = /[()（）[\]]/;
function inMathExpr(s, i, atom) {
  const isNum = /^\d/.test(atom);
  // 数字要跳过空格再看邻字符：`= 1在(2,3√3/2)` 里的空格不该让 `1` 逃掉。
  // 英文词反过来 —— **不许跳空格**：`发表 4 篇 SCI 论文` 里 SCI 两边都是空格，
  // 一跳就把它当成「贴着公式」，真该核对的词就漏了。
  // `siny` 前面紧贴着 `5`（`0.5siny`）、`cosy` 前面紧贴着 `-`（`2-cosy`），
  // 这种才是变量名。
  let b = i - 1;
  let a = i + atom.length;
  if (isNum) {
    while (b >= 0 && /\s/.test(s[b])) b--;
    while (a < s.length && /\s/.test(s[a])) a++;
  }
  const before = s[b] || '';
  const after = s[a] || '';
  if (MATH_NEIGHBOR.test(before) || MATH_NEIGHBOR.test(after)) return true;
  // 公式里的变量名直接粘在数字/变量上（`0.5siny`、`4y²`）
  if (/[A-Za-z]/.test(before) || /[A-Za-z]/.test(after)) return true;
  if (SUP_SUB.test(before) || SUP_SUB.test(after)) return true;
  // 英文词**紧贴**着数字（`0.5siny`）—— 中间没有空格，那就是系数 × 函数，
  // 不是正文里的英文单词。`发表 4 篇 SCI 论文` 中间有空格，不受这条影响。
  if (!isNum && /\d/.test(before)) return true;
  // 坐标/取值列表：`(1,3√3/2)`、`（15,20,25）`、`(1,1)`
  if (atom.includes(',') && BRACKET.test(before) && BRACKET.test(after)) return true;
  // 「两侧是纯数字」只对数字成立（`4y²` 与 `36` 之间只剩数字）。
  // 英文词不许用这条：`发表 4 篇 SCI 论文` 里 SCI 前面就是数字，它照样是真词。
  if (isNum && (/\d/.test(before) || /\d/.test(after))) return true;
  return false;
}

/**
 * 笔记里有没有「原文对不上的具体事实」。
 *
 * 返回一句一句的人话（直接拼进「需要回听核对的地方」），没有就返回空数组。
 *
 * 判定两道：
 *   ① 这个数字/英文词在原文里根本没有 → 可疑（单个数字太吵，要求 ≥2 位或带小数）；
 *   ② 原文里有，但紧跟它后面那个字跟原文同位置的**不是同一个字** → 可疑。
 *      例：笔记写「4 篇」，原文是「发表 4 天高水平」→ 报「4（原文后面是「天」）」。
 *
 * 第二道是重写旧版时保留下来的真正有效判据，只是不再依赖量词表：
 * 原文那个位置是什么字，就拿什么字比。
 */
export function findUnverifiedFacts(markdown, sourceText) {
  const md = normAlnum(stripForCheck(stripNoteChrome(markdown)));
  const src = normAlnum(flatText(sourceText));
  if (!src) return [];
  // 第二份原文：中文数字换成阿拉伯数字。
  // 老师嘴里读「零点五」「九十八」「三百天」，笔记里写「0.5」「98」「300 天」
  // 是完全正确的改写，不换算就会一条条判成「原文没有」（实测化学课那样误报）。
  const srcCn = normAlnum(cnNumeralsToArabic(flatText(sourceText)));
  const hits = [];
  const seen = new Set();
  for (const m of md.matchAll(ATOM_RE)) {
    const atom = m[0].replace(/[.,]+$/, '');
    if (!atom || seen.has(atom.toLowerCase())) continue;
    seen.add(atom.toLowerCase());
    const isNum = /^\d/.test(atom);
    // 式子里的数字/变量不参与核对（见 inMathExpr 的说明）：
    // 高数题的 `36`、坐标 `(1,3√3/2)`、`0.5siny` 老师不会念出来，报了全是噪声。
    if (inMathExpr(md, m.index, atom)) continue;
    let occ = findAllCI(src, atom).map((p) => ({ p, hay: src }));
    if (!occ.length) occ = findAllCI(srcCn, atom).map((p) => ({ p, hay: srcCn }));
    if (!occ.length) {
      // 单个数字（「第一」「3 个」）在口语里太常见，缺了不算证据；英文词同理要够长。
      // 化学式（H2SO4）这种「字母+数字」混合体不算 —— 语音转写里根本不会出现，
      // 拿它去对逐字稿是必然漏，报了只会让用户以为程序在乱叫。
      const worthReporting = isNum ? atom.length >= 2 || atom.includes('.') : atom.length >= 4 && !/\d/.test(atom);
      if (worthReporting) {
        // 只报一个孤零零的「500」，用户根本不知道说的是哪句话
        //（实测那是一次作业要求「撰写…500字短文」，模型自己编的作业量）。
        // 带上笔记里的原句，才能一眼判断要不要删。
        const around = noteContext(md, atom, 14);
        hits.push(around ? `${atom}（逐字稿里没有这个数；笔记：「${around}」）` : atom);
      }
      if (hits.length >= 12) break;
      continue;
    }
    // 英文词只查「原文里有没有」，不查右邻：英文词后面跟的永远是别的英文词，
    // 「opportunity cost」拿去比邻居必然误报。
    if (!isNum) continue;
    const want = unitAfter(md, m.index + m[0].length);
    if (!want) continue; // 后面不是汉字（句号/换行/标点/数字），比不了
    // 「2024-2027」「3~5 年」这种区间：区间的量词属于整个区间，不属于最后一个数。
    // 不管写「到」「至」还是「-」「~」，一律不比右邻，否则每一条时间跨度都是误报。
    if (/[-–—~～到至]/.test(md[m.index + m[0].length] || '')) continue;
    if (/[-–—~～到至]/.test(md[m.index - 1] || '')) continue;
    const ok = occ.some(({ p, hay }) => unitAfter(hay, p + atom.length) === want);
    if (ok) continue;
    // 量词对不上，未必是编造：老师口述「只有 9 个人」，笔记写「仅 9 人获此殊荣」
    // 是完全正确的书面化，只是把「个」换成了同义的「人」。所以光看「这一个量词
    // 不一样」不够，还得看**这个量词字在整段逐字稿里到底出现过没有** ——
    // 老师说「发表 4 天高水平…」，笔记写成「4 篇论文」，而整篇逐字稿里连一个
    // 「篇」字都没有，那才说明这个量词是笔记自己加的、原文根本支撑不住。
    // 这条判据不含任何量词表：只问「这个字老师说过没有」，任何学科都成立
    // （化学课的「摩尔」、高数课的「阶」、英语课的「分」都是同一套逻辑）。
    if (src.includes(want) || srcCn.includes(want)) continue;
    // 报警要带「数字+量词」这个整体，不能只报一个孤零零的数字。
    // 实测旧文案 `4（原文后面跟的是「天」，不是「篇」）` 用户根本看不懂在说什么；
    // 写成 `4篇（原文那里是「4天」…）` 一眼就知道是笔记把数用错了地方。
    // 再附一句笔记里的上下文，用户才能判断要不要真的回去听。
    const got = occ.map(({ p, hay }) => unitAfter(hay, p + atom.length)).filter(Boolean)[0] || '';
    const phrase = `${atom}${want}`;
    const around = noteContext(md, phrase, 12);
    const tail = around ? `；笔记：「${around}」` : '';
    hits.push(got && got !== want ? `${phrase}（原文那里是「${atom}${got}」${tail}）` : `${phrase}（原文有这个数，但后面的字对不上${tail}）`);
    if (hits.length >= 12) break;
  }
  return hits;
}

/**
 * 两条写法看上去像不像「同一个东西被听错了」。
 *
 * 同音误识落到字面上就是「改动很小」：林俊泽/林俊德差一个字，
 * 「斗争性与成因性」/「斗争性与同一性」差两个字且长度一样。
 * 「杨女士」/「林俊德」三个字里三个都不同，那就不是听错，是另一个人。
 * 距离判据与学科无关，也不需要任何词表。
 */
export function looksLikeTypo(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (!x || !y || x === y) return false;
  if (Math.abs(x.length - y.length) > 2) return false;
  // 太短的（两个字的词）编辑距离判不出一致性，一律放行给字数检查管
  if (x.length <= 2 && y.length <= 2) return true;
  return editDistance(x, y) <= Math.max(2, Math.floor(Math.max(x.length, y.length) / 3));
}

/** 标准编辑距离（插入/删除/替换各算 1），两个短字符串足够快 */
export function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

/**
 * 取两条写法的「差异核心」：砍掉公共前缀和公共后缀，剩下不同的那截。
 * 返回 null 表示差异太小（只剩一个字），全局替换太危险，不做。
 *
 * 为什么需要：模型判出来的是「斗争性与成因性 → 斗争性与同一性」，
 * 可同一份笔记的别处还单独写着一个「成因性」。不把核心对齐掉，
 * 正文里就会「同一性」5 处、「成因性」3 处，自己跟自己打架。
 *
 * 同时带回核心两边的那两个字（`左` / `右`），替换时要用它们把关，
 * 免得把「成因分析」里的「成因」也一起改掉。
 */
export function coreDiff(wrong, right) {
  const a = String(wrong || '');
  const b = String(right || '');
  if (!a || !b || a === b) return null;
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const wa = a.slice(p, a.length - s);
  const rb = b.slice(p, b.length - s);
  if (wa.length < 2 || rb.length < 2) return null;
  return {
    wrong: wa,
    right: rb,
    left: a[p - 1] || '',
    rightChar: a[a.length - s] || '',
  };
}

/**
 * 按「差异核心」在正文里做一遍对齐替换，带邻字把关。
 *
 * 只看核心是不够的：「成因」在「成因分析」里是正常用法，不能一概改掉。
 * 所以要求候选位置至少有一侧紧邻的字符，和它原来所在那个词里的邻字一致 ——
 * 「成因性」的右边是「性」，和「斗争性与成因性」的右边一样，改；
 * 「成因分析」的右边是「分」，对不上，放过。
 * 这条判据纯字符层，任何学科都成立，不依赖任何词表。
 */
export function alignByCore(body, d) {
  if (!d) return { body, hits: 0 };
  let out = '';
  let rest = String(body || '');
  let hits = 0;
  let guard = 0;
  while (guard++ < 200) {
    const i = rest.indexOf(d.wrong);
    if (i < 0) break;
    const lb = i > 0 ? rest[i - 1] : '';
    const rb = rest[i + d.wrong.length] || '';
    const okLeft = !!d.left && lb === d.left;
    const okRight = !!d.rightChar && rb === d.rightChar;
    out += rest.slice(0, i) + (okLeft || okRight ? d.right : d.wrong);
    if (okLeft || okRight) hits++;
    rest = rest.slice(i + d.wrong.length);
  }
  out += rest;
  return { body: out, hits };
}

/** 取出片段在笔记里第一次出现处的上下文（前后各 n 字），喂给模型判断 / 拼进警告 */
function noteContext(md, span, n = 18) {
  const i = md.indexOf(span);
  if (i < 0) return '';
  return (
    md
      .slice(Math.max(0, i - n), i + span.length + n)
      .replace(/\s+/g, ' ')
      // 上下文里的公式换成「公式」两个字：这段话最终会进「- ⚠ …」警告行，
      // 而警告行是当正文渲染的。留半个 `\(` 没有配对的 `\)`，
      // 渲染时就会跨过「」一直吞到下一个公式的结尾（实测高数那篇吞掉了两行）。
      .replace(/\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$[^$\n]*\$/g, '公式')
      .trim()
  );
}

/**
 * 去掉口语里的「的/了/着/过/地/得」和语气词，只留骨架。
 *
 * 老师嘴上说「乐观的精神」，笔记里写「乐观精神」，这是正确的书面化改写，
 * 不该被当成可疑。这两者在骨架上是同一串字 —— 这一步纯语言层，
 * 与学科无关：高数、英语、化学课的口语都是这么变成书面语的。
 */
const SPEECH_FILLER = /[的了着过地得啊呢吧嘛呀哦噢呗啦么]/g;
function skeleton(s) {
  return String(s || '').replace(SPEECH_FILLER, '');
}

/**
 * 片段两端的「虚字」：语言层的功能字，与考什么科目无关。
 * 「的/了/是/这/如/二」开头的片段一定是半句话或虚词组合，不是值得核对的实体。
 * 这不是学科词表 —— 高数、英语、化学课的中文正文里，这些字同样不会做词头词尾。
 */
const EDGE_STOP = new Set(
  ('的了着过很都也还就才而又再并且或者但如果因为所以虽然只是不是可以这样那样这个那个' +
    '什么怎么如何为何哪里时候是对在把被让给从向来去上说讲想要会能没不有我你他她它们' +
    '一二三四五六七八九十第两几每各些点许更加最太非常比较稍微可能应该必须需要进行具有' +
    '于以及之其此然者').split('')
);

/**
 * 多字的虚词/口头禅：**整词**比对，绝对不能拆成单字塞进 EDGE_STOP。
 *
 * 真实踩过的坑：EDGE_STOP 原来是把这一串整串 `.split('')` 的，于是「成为」
 * 贡献了一个「成」、「同时」贡献了一个「同」、「人们」贡献了一个「人」。
 * 结果「成因性」被当成以虚字「成」开头直接扔掉、「同一性」被「同」扔掉 ——
 * 而这两个恰恰是哲学课最该被核对的术语（逐字稿把「同一性」听成了「成因性」）。
 * 一条候选都进不了模型，后面所有判据都是白搭。
 *
 * 所以：单字虚字归 EDGE_STOP，多字虚词归这里，只在整词相等时生效。
 */
const EDGE_STOP_WORDS = new Set([
  '存在', '包括', '属于', '成为', '作为', '通过', '根据', '按照', '同时', '以及',
  '等等', '人们', '大家', '我们', '你们', '他们', '同学', '老师', '今天', '明天',
  '现在', '以后', '之前', '之后', '当然', '其实', '因此', '然后', '接着', '首先',
  '其次', '最后', '另外', '此外', '例如', '比如', '还有', '而且', '不过', '于是',
  '一并', '二者', '两者',
]);

/**
 * 这个片段是不是「以虚字打头/收尾」或者整个就是个虚词。
 * 只做单字端点检查 + 整词比对，认字不认学科。
 */
function isEdgeStop(term) {
  const s = String(term || '');
  if (!s) return true;
  if (EDGE_STOP_WORDS.has(s)) return true;
  return EDGE_STOP.has(s[0]) || EDGE_STOP.has(s[s.length - 1]);
}

/**
 * 片段里是否存在「长度 ≥ n、且在原文里原样出现」的一段。
 *
 * 用途：判断一个复合词是「凭空引进的新词」还是「原文的词拼上了一个称谓/修饰」。
 * 后者不算可疑 —— 那是正常的书面化组合，不是编造。
 *   「林俊泽院士」：子段「林俊泽」在原文有 → 不算可疑
 *   「偏导数」：原文一个字都不连着出现 → 可疑，交给模型判
 * 只依赖这篇稿子自己的字串，不认学科、不用词表。
 */
function hasQuotedChunk(term, hay, n = 3) {
  if (!hay || term.length <= n) return false;
  for (let i = 0; i + n <= term.length; i++) {
    if (hay.includes(term.slice(i, i + n))) return true;
  }
  return false;
}

/**
 * 这个片段是不是「某个更长的词被切掉首尾」剩下的部分。
 *
 * 用途：剔掉词提取产生的伪片段。实测过的一大把：
 *   债务危机 → `务危机`、矛盾观中 → `盾观中`、马克思主义矛盾 → `主义矛`、
 *   林俊泽院士 → `俊泽院`、杨女士的案例 → `女士案`、社会发展 → `社会发`
 * 它们的共同特征：**两侧紧贴着的实字都各只有一个**（左「债」右「，」不算 /
 * 左「矛」右「的」）。
 *
 * 判据只看这篇文字自己的邻居，不认学科、不用词表。
 * 逐次出现记录左右邻居，然后看两件事：
 *
 *   ① 左边每一次都挨着汉字，而且**永远是同一个汉字** —— 这个片段
 *      从来没有在句首、标点后、换行处露过头，它一辈子长在那个字后面。
 *      「矛盾观中」永远跟在「矛」后面、「心理学中」永远跟在「心」后面、
 *      「主动放弃」里的「动放弃」永远跟在「主」后面。
 *      真词不会这样：它总得有某一次能当个句子的开头。
 *   ② 右边每一次都挨着汉字、永远是同一个汉字，而且左边也确实挨过汉字
 *      （不是那种「总是单独出现在行首」的东西）。
 *      「女士的案例」里的「士的案」右边永远是「例」，左边是「女」或「院」；
 *      「亿美元」就不是 —— 它右边接过「资」「支」，左边还常在句首。
 *
 * 为什么「左边永远在边界上」必须排除在①之外：
 *   `林俊泽` 右边永远钉在「院」（院士），左边却永远是空格/标点/句首 ——
 *   它每次都能当名字的开头，是完整的人名，只是后面跟了称谓。
 *   这类必须留着，正是最该被核对的东西。
 *
 * 剩下的漏网碎片不在这里穷举，交给模型判：提示词里有 `skip` 一档，
 * 专门用来丢弃「本身就不是一个完整词」的片段。
 */
function neverStandsAlone(term, text) {
  const isHan = (ch) => !!ch && /[\u4e00-\u9fa5]/.test(ch);
  if (text.split(term).length - 1 < 2) return false;
  const L = new Set();
  const R = new Set();
  let allHanL = true;
  let allHanR = true;
  let i = text.indexOf(term);
  let n = 0;
  while (i >= 0 && n < 40) {
    n++;
    const l = text[i - 1] || '';
    const r = text[i + term.length] || '';
    if (isHan(l)) L.add(l);
    else allHanL = false;
    if (isHan(r)) R.add(r);
    else allHanR = false;
    i = text.indexOf(term, i + term.length);
  }
  if (allHanL && L.size === 1) return true;
  if (allHanR && R.size === 1 && L.size >= 1) return true;
  return false;
}

/**
 * 从一个片段里找出「在原文中原样出现的最长一段」。
 *
 * 用途：笔记里写「林俊泽院士的事迹」，原文里其实只有「林俊泽」——
 * 整串在原文找不到，但里面的「林俊泽」是原样出现的。
 * 把它抠出来单独交给模型，模型才有机会说「这个写法是错的，应为林俊德」。
 * 不抠出来的话，模型看到的是一整个短语，只会当它是在讲故事，不会想到去改错名。
 */
function longestSourceChunk(term, hay, minLen = 3) {
  for (let len = term.length - 1; len >= minLen; len--) {
    for (let s = 0; s + len <= term.length; s++) {
      const sub = term.slice(s, s + len);
      if (hay.includes(sub) && !isEdgeStop(sub)) return sub;
    }
  }
  return '';
}

/**
 * 从笔记里挑出「反复出现、值得核对」的中文片段。
 *
 * 不问「这是不是人名/机构/术语」—— 那需要词表，换个学科就废。
 * 只用**这篇笔记自己**的词汇分布来判断：一个片段在这份正文里反复出现、
 * 左右邻居变化很多（边界熵高），说明它是被当作一个实体在用的词。
 *
 * 然后分两类交给模型：
 *   · 逐字稿里找不到原样写法的 —— 要么是模型把识别错误改对了，要么是它自己编的；
 *   · 逐字稿里原样就有的 —— 笔记只是照抄，但如果逐字稿本身就听错了（专名同音误识），
 *     抄下来的也是错的，这一类只有模型自己的知识能看出来。
 *
 * 词提取直接复用离线引擎的 extractKeywords（频次^0.62 × 逆句频 × 长度权重 ×
 * 边界熵 × 独立成词度）：它本来就是「无词典新词发现」，不认学科，
 * 高数课会抽出「偏导数」「洛必达」，英语课会抽出专有名词，化学课会抽出化合物名。
 *
 * @returns {{text:string, count:number, ctx:string, inSource:boolean}[]}
 */
export function findSuspiciousTerms(markdown, sourceText, opts = {}) {
  const minCount = opts.minCount || 2;
  const minLen = opts.minLen || 3;
  const limit = opts.limit || 24;
  // 去掉小节标题、头部元数据行、逐字稿附录、上一次生成的警告行 —— 都不是「讲的内容」
  let bodyText = String(markdown || '')
    .replace(/<details[\s\S]*?<\/details>/gi, ' ')
    .replace(/^[-*]\s*⚠.*$/gm, ' ');
  // 离线引擎自己写进去的词频标注和页脚也不是「讲的内容」
  //（`递归 (11) · 左孩子 (4)` 会抽出 `左孩子`，页脚会抽出产品名）。
  bodyText = stripNoteChrome(bodyText);
  // 「需要回听核对的地方」整节删掉：那一节是上一次核对写进去的清单
  // （「"国安部…"应为"国家安全部…"」「…疑似识别错误」），里面的词
  // 会被当成笔记正文再抽一遍，自己查自己，越查越乱。
  // 「自测题」同理要删：那是**问题**不是**陈述**，本来就该由我们自己造
  //（离线引擎写「请分条列举」「举个例子」，AI 写「乐观精神在应对人生困境中
  // 起到什么作用？」），拿它去核对逐字稿只会得到一串永远对不上的套话。
  for (const pat of [/^##\s*需要回听核对的地方\s*$/m, /^##[^\n]*自测题[^\n]*$/m]) {
    const at = bodyText.search(pat);
    if (at < 0) continue;
    const rest = bodyText.slice(at + 1);
    const nextH = rest.search(/^##\s/m);
    bodyText = bodyText.slice(0, at) + (nextH >= 0 ? rest.slice(nextH) : '');
  }
  bodyText = bodyText
    .split('\n')
    .filter((line) => !/^\s*#{1,6}\s/.test(line) && !/^\s*>/.test(line))
    .join('\n');
  const src = flatText(sourceText);
  const srcSk = skeleton(src);
  const cjkLen = bodyText.replace(/[^\u4e00-\u9fa5]/g, '').length;
  if (cjkLen < 60 || src.length < 60) return [];

  const sents = splitSentences(bodyText).map((text) => ({ text }));
  // 候选池要开得比 limit 大很多：词提取的结果是按分数排的，专名往往只出现
  // 3-4 次、分数不高，池子一小就被挤出去。实测 48 条时「林俊泽」排在第 60 多位，
  // 永远进不了候选 —— 而它恰恰是这份笔记里最该被核对的东西。
  // 多取不花钱（纯本地计算，几毫秒），后面的过滤与 limit 会把它压回去。
  const kws = extractKeywords(sents, Math.max(120, limit * 6), { minFreq: minCount, maxLen: 8 });
  const picked = [];
  for (const k of kws) {
    const term = String(k.term || '');
    // 英文/术语交给 findUnverifiedFacts 逐字比对；这里只处理中文片段
    if (term.length < minLen || !CJK_CHAR.test(term)) continue;
    // 两端是虚字的，是半句话或虚词组合，不可能是专名/术语
    if (isEdgeStop(term)) continue;
    // 逐字稿里原样有 → 不是「新引进的词」，但仍可能是「照抄了识别错误」，
    // 所以照收，只在标签上区分。比的时候两边都去掉「的/了/着/过」这类
    // 口语虚字：「乐观的精神」→「乐观精神」是正常的书面化改写。
    const inSource = src.includes(term) || srcSk.includes(skeleton(term));
    // 左邻右邻都只有一个字 → 它是长词里被切掉首尾的一截，不是独立的词。
    if (neverStandsAlone(term, bodyText)) continue;
    // 片段里只要有一段（3 个字以上）在逐字稿里原样出现过，它就是拼出来的复合词，
    // 不是凭空引进的新实体 —— 「林俊泽」原样有，「林俊泽院士」只是加了个称谓。
    // 这类只在「照抄」分支里进（inSource=true），不当成新词报警。
    if (!inSource && hasQuotedChunk(term, srcSk, 3)) {
      picked.push({ text: term, count: k.count || 0, ctx: noteContext(bodyText, term), inSource: true });
      // 顺手把它里面「原样出现在逐字稿里的那一段」单独列一条。
      // 「林俊泽院士的事迹」→ 额外喂「林俊泽」这一条，模型才有机会发现
      // 这是个写错的人名（应为林俊德）；只给长串它只会当成描述性短语。
      const core = longestSourceChunk(term, src, 3);
      if (core && core !== term && !picked.some((p) => p.text === core)) {
        const cnt = bodyText.split(core).length - 1;
        if (cnt >= minCount) {
          picked.push({ text: core, count: cnt, ctx: noteContext(bodyText, core), inSource: true, core: true });
        }
      }
    } else {
      picked.push({ text: term, count: k.count || 0, ctx: noteContext(bodyText, term), inSource });
    }
    if (picked.length >= limit) break;
  }
  return picked;
}

/**
 * 问模型一句：这些「笔记里有、原文没有」的片段，哪些是识别错误改对了、
 * 哪些是编的、哪些只是正常改写？
 *
 * 为什么拆成一次独立调用：实测把同一道题塞进主提示词里，模型**不敢判**
 * ——它只会两边都写上去。单独问它「这一条你凭什么这么写」，它答得又快又准
 * （旧版实测：「入伍52年、参与全部45次核试验的中国工程院院士是林俊德」）。
 * 任何异常都返回 null，这一步失败不影响出稿。
 */
export async function crossCheckTerms(terms, { signal, sourceText = '' } = {}) {
  const list = (terms || []).slice(0, 24);
  if (!list.length) return null;
  /**
   * 一次问太多条，模型会把整张表「稀释」掉。
   *
   * 实测（同一份 24 条候选、同一个模型、温度 0.1）：
   *   · 24 条一起问 → 23 条 ok，`成因性`（原文把「同一性」听错）一个字没改；
   *   · 只问 3 条     → `成因性 → 同一性`、`华舆论 → 对华舆论战` 全判对。
   * 也就是说「判得出/判不出」主要取决于**同时要看多少条**，不是提示词写得不够狠。
   * 分批（每批 6-8 条）并发跑，命中率明显回升；批次之间的耗时会被网络摊平。
   *
   * 批大小取 8：再小会让一次记笔记多出七八个请求（每次 60-180 秒），
   * 再大又会退回「一条都不改」。8 条是实测下来命中率和耗时都还能接受的点。
   */
  const BATCH = 8;
  if (list.length > BATCH) {
    const groups = [];
    for (let i = 0; i < list.length; i += BATCH) groups.push(list.slice(i, i + BATCH));
    const rs = await Promise.all(
      groups.map((g) =>
        crossCheckTerms(g, { signal, sourceText }).catch(() => null)
      )
    );
    const acc = { asr: [], fixes: [], invented: [], skipped: [], total: 0, raw: [] };
    rs.forEach((r) => {
      if (!r) return;
      acc.asr.push(...r.asr);
      acc.fixes.push(...r.fixes);
      acc.invented.push(...r.invented);
      acc.skipped.push(...r.skipped);
      acc.total += r.total || 0;
      acc.raw.push(...(r.raw || []));
    });
    // 全都失败时返回 null，让调用方知道这一步没做成（而不是「查过了没问题」）
    if (!rs.some(Boolean)) return null;
    return acc;
  }
  const src = flatText(sourceText);
  /**
   * 在逐字稿里找这个片段的上下文。
   *
   * 片段本身可能整段找不到（「乐观精神」原文是「乐观的精神」，
   * 「林俊泽院士的事迹」原文只有「林俊泽」），所以不能直接 indexOf，
   * 否则明明标了「原文有」，却给不出任何原文 —— 模型只能靠猜。
   * 做法：从长到短试片段的每一段，取第一段能在原文里找到的当锚点。
   */
  const ctxInSource = (term) => {
    for (let len = term.length; len >= 2; len--) {
      for (let s = 0; s + len <= term.length; s++) {
        const anchor = term.slice(s, s + len);
        const i = src.indexOf(anchor);
        if (i < 0) continue;
        // 上下文要给得足够宽：判「这个词是不是听错了」得看老师到底在讲什么。
        // 实测 18 字时，模型只看到「有位中国工程院院士叫林俊泽」，于是把
        // 人名改成了一位歌手；给到 100 字后才看得到后面「入伍52年、参与了
        // 我国全部45次的核试验」，才认得出这是林俊德。宽一点不心疼 token ——
        // 24 条候选取满也才几千字。
        const before = src.slice(Math.max(0, i - 100), i);
        const after = src.slice(i + anchor.length, i + anchor.length + 100);
        return `${before}${term}${after}`;
      }
    }
    return '';
  };
  const lines = list
    .map((t, i) => {
      const head = `${i + 1}. 「${t.text}」（这篇笔记里出现 ${t.count} 次）`;
      const srcCtx = t.inSource ? ctxInSource(t.text) : '';
      const parts = [head];
      if (srcCtx) parts.push(`   逐字稿里对应的原文：…${srcCtx}…`);
      else if (!t.inSource) parts.push('   逐字稿里找不到这个写法');
      if (t.ctx) parts.push(`   它在笔记里的上下文：…${t.ctx}…`);
      return parts.join('\n');
    })
    .join('\n');
  const prompt = `下面是一份课堂笔记里**反复出现**的中文片段。
每条都标了它在原始逐字稿里找不找得到。逐字稿是语音识别出来的，
可能有同音字错误、拼音首字母错误、连读吞音 —— 这些错误会被笔记原样继承下来。

   ok      写法没问题。包括正常的口语→书面语改写、加称谓、缩略、概括。
           这一类占绝大多数，不要误伤。
  asr     逐字稿那边是识别错误，笔记已经改对了 —— 笔记的写法是对的，不需要动。
  fix     这个写法本身就是错的。**笔记老老实实照抄了逐字稿的错写法，也算 fix** ——
           逐字稿把专名/术语听错了，抄下来照样是错的，用户拿着错名字去查是查不到的。
           （asr 是「笔记已经改对了」，fix 是「笔记还没改、还错着」，别混。）
           你如果确定正确写法，用 to 填出来；不确定就填 unclear，不要猜。
  invent  笔记里写了一个**具体、可核对的事实**（一个数字、一个英文术语或公式、
           一条带具体出处的结论），但逐字稿里根本没有依据 —— 必须标出来。
  skip    这压根不是一个词 —— 是机器从长句里切出来的一截（把「债务危机」切成
          「务危机」、把「社会发展」切成「社会发」）。它不是笔误、不是编造，
          没有任何可核对的内容，直接丢掉。
  unclear 你也不确定。

${lines}

请逐条判断。可以动用你自己的知识（某个专名指向谁、哪个学科术语的正确写法、某个结论是否成立）。
判断 invent 要严格：只有「这句话把一件具体的事说成老师讲过的，但老师没讲过」才算；
只是措辞更书面、更概括、把零散的话合成一句、把「两个孩子」压缩成「双胞胎」—— 都算 ok。

判断 fix 的门槛要高：只有你**确实知道**正确写法才行 —— 这个人/机构/定理/化合物/地名
指向一个明确的对象，而你确定现在这个写法是错的。
只是「听起来有点怪」「可能是别的词」不算，那种情况填 unclear。
to 必须和原写法字数相近、只改错的那几个字，不许换成一个完全不同的东西。
课堂里最常见的一类：人名、机构名、术语被语音识别听成了同音字。
如果你靠常识能确定它指的是谁/什么（比如某个头衔 + 事迹能对上一位真实存在的院士），
那就该填 fix 并给出正确写法，而不是放过它 —— 用户拿着错名字是查不到任何东西的。

**改之前先做一次「事迹对账」，对不上就不许改**：
把你想到的那个正确写法，拿去和「逐字稿里对应的原文」里描述的这个人的事迹比对
（出生年代、职务、干过什么事、哪一年、什么单位）。事迹对不上，说明你想的是另一个人，
只是名字听起来像 —— 这时候**必须**填 unclear，绝不能把一个真实存在的人物硬塞进来。
反面例子（真实踩过）：把「中国工程院院士林俊泽，入伍52年、参与全部45次核试验」
里的名字改成「林俊杰」—— 那是歌手，和核试验院士是两个人。正确写法是「林俊德」。
也不要跨领域硬凑（把化学术语改成数学术语、把学校名改成公司名）。


判断 skip 只看一件事：把它单独拿出来，中文里有没有这个词、这个实体。
「务危机」「社会发」「士的案」单独拿出来什么都不是 → skip。
「偏导数」「洛必达法则」「二氯甲烷」「马克思主义」单独拿出来是完整术语 → 不能 skip。

填 invent 的时候，必须再用 claim 字段写出**那句被编造的话本身**（一句完整的陈述，至少 10 个字，
要能独立看懂说的是谁做了什么、或者什么数字属于什么）。写不出完整的一句话，说明你要标的东西
只是一个词的改写，那就填 ok。下面这些都不是 invent：
  · 只是造了个新词、新搭配（「制造虚假」「双胞胎重病」）
  · 把原文的说法换了种说法、压缩了字数
  · 给一个原文里的名字补上称谓（「林俊泽」→「林俊泽院士」）
  · 对原文内容的概括、归纳、评价

只输出 JSON，不要解释性的废话：
{"items":[{"i":序号,"verdict":"ok","to":"","claim":"","why":"一句话依据"}]}
verdict 只能取上面六个值之一；
to 在 asr 和 fix 时填正确写法，其余留空；
claim 只在 invent 时填那句被编造的话，其余留空。
拿不准一律填 ok —— 宁可放过，不要误伤。`;
  try {
    const out = await callLLM(
      [
        { role: 'system', content: '你是中文课堂笔记的校对助手，只输出 JSON。' },
        { role: 'user', content: prompt },
      ],
      { signal, temperature: 0.1, maxTokens: 1400 }
    );
    const j = extractJsonObject(out);
    const items = Array.isArray(j?.items) ? j.items : [];
    const byIdx = new Map(list.map((t, i) => [i + 1, t]));
    const asr = []; // 判定为「逐字稿那边听错了，笔记是对的」—— 这是好事，只记账不报警
    const fixes = []; // 判定为「笔记这个写法就是错的」—— 要报警，并给出建议写法
    const invented = []; // 判定为「逐字稿没依据」—— 要报警
    const skipped = []; // 判定为「这压根不是一个词」—— 机器切出来的碎片，丢掉
    for (const it of items) {
      const t = byIdx.get(Number(it?.i));
      if (!t) continue;
      const verdict = String(it?.verdict || '').toLowerCase();
      const to = String(it?.to || '').trim();
      const why = String(it?.why || '').trim();
      const claim = String(it?.claim || '').replace(/\s+/g, ' ').trim();
      if (verdict === 'asr') asr.push({ text: t.text, to, why });
      else if (verdict === 'skip') skipped.push({ text: t.text, why });
      else if (verdict === 'fix') {
        // 改错也要求「给得出建议写法」，否则它就是在瞎猜。
        // 另外字数差不能太大：从「林俊泽」改成「林俊德」是改错字，
        // 改成另外一个长词则多半是模型在硬凑，一律不收。
        if (!to || to === t.text) continue;
        if (Math.abs(to.length - t.text.length) > 2) continue;
        // 光看字数不够 —— 实测模型把「杨女士」判成 fix → 「林俊德」，
        // 两个都是三个字，字数检查一路放行，结果是要拿一个人的名字去顶替
        // 另一个毫不相干的人。同音误识的本质是「听起来像」，落到字面上就是
        // **改不了几个字**：林俊泽→林俊德差 1 个字，斗争性与成因性→…同一性差 2 个。
        // 所以再要求编辑距离足够小。这条判据纯字符层，和学科、语种都无关。
        if (!looksLikeTypo(t.text, to)) continue;
        fixes.push({ text: t.text, to, why });
      } else if (verdict === 'invent') {
        // invent 要过两道，缺一不可。
        //
        // 第一道：能写出「那句被编造的话」。实测过的误报是把「双胞胎重病」
        // 「制造虚假」判成编造 —— 那不是一句话，只是把原文压短了。
        //
        // 第二道（关键）：那句话自己得带着一个**能被机械核对**的锚点
        // （阿拉伯数字、英文词/公式），而且这个锚点在逐字稿里对不上。
        //
        // 为什么必须有第二道：模型把「概括」当「编造」是本性问题，不是提示词
        // 能说清的。实测四条误报全是概括句 —— 「该策略本质是意识形态渗透」
        // 「需平衡个体选择与集体利益」「本节课通过杨女士的案例阐述…」，
        // 它们一个字都核不了，永远不该出现在「请核对后再采信」里。
        // 真正编造的东西一定能落到一个具体数字或术语上
        // （「主持了32次核试验」「发表4篇高水平论文」），这类一个都跑不掉。
        //
        // 这个判据和学科无关：高数课的「n=3」「∇×F」、英语课的「GDPR」、
        // 化学课的「0.5 摩尔」，只要逐字稿里没有，一样会被揪出来。
        if (claim.length < 10) continue;
        const anchors = findUnverifiedFacts(claim, sourceText);
        if (!anchors.length) continue;
        invented.push({ text: t.text, claim, anchors, why });
      }
    }
    // raw 保留模型的原话判决，只给排查用（GenerateAINote 不会把它放进笔记）
    return { asr, fixes, invented, skipped, total: items.length, raw: items };
  } catch {
    return null;
  }
}

/**
 * 开放式找错：把整篇笔记交给模型通读，让它自己挑「写法肯定不对的地方」。
 *
 * 为什么要多这一步 —— `crossCheckTerms` 是**给候选逐条打勾**，
 * 而候选是由 `findSuspiciousTerms` 用词频抽的，抽不到就永远没机会被看。
 * 实测：`成因性`（原文把「同一性」听错，正文里出现 4 次）在 144 条候选池里
 * 排第 51 位，被 24 条的 limit 挤掉，24 条一次喂的批次里模型 23 条判 ok。
 * 换句话说，问题不在模型判不出来，而在它根本没看到那一条。
 *
 * 通读就不一样了：整篇正文摊开摆在它面前，`斗争性和成因性同时存在` 这种
 * 马克思主义的固定搭配一眼就刺出来。实测同一份笔记连跑三次，
 * **三次都抓到了 `成因性 → 同一性`**，而逐条打勾那条路是 0/5。
 * 两种问法的成本都是「一次调用」，通读的输入还更小（不用塞候选和上下文）。
 *
 * 这条路径的判据和学科无关：模型靠的是「这个词在这个领域里有没有这个讲法」
 * （高数、英语、化学、法学都一样），代码这边只做与学科无关的文本校验。
 * 任何异常返回 null，不影响出稿。
 */
export async function openEndedFixes(markdown, { signal, sourceText = '' } = {}) {
  // 正文只留「<details> 附录」之前的部分：附录里是原始逐字稿，
  // 里面全是识别错误的原文，让它通读会让它去改逐字稿（不是这次要做的事）。
  let body = String(markdown || '').split('<details')[0];
  const src = flatText(sourceText);
  // 去掉上一轮写进去的核对清单 + 附录，否则模型会对着自己上次的结论抄
  const chk = body.search(/^##\s*需要回听核对的地方\s*$/m);
  if (chk >= 0) body = body.slice(0, chk);
  // 太短的稿子不值得多花一次调用（一句话没几个词可错）
  if (body.replace(/[^\u4e00-\u9fa5]/g, '').length < 200) return null;

  const prompt = `下面是一份课堂笔记。它是从**语音识别**出来的逐字稿整理的，
语音识别会**把同音字听错**，这些错写法会被笔记原样继承下来。

请你通读一遍，找出**用词本身就不对**的地方 —— 专有名词（人名、地名、机构名、
课程名）、学科术语（公式名、定理名、专业概念）、固定搭配。这类错误最典型的样子是：
一个词放在这句话里，这个领域的人一看就知道没这么个讲法
（比如讲马克思主义矛盾观时出现「斗争性和成因性」，正确说法是「斗争性和同一性」）。

只找这一类。数字、日期、口语改写、概括、加称谓都**不要管**，那些另有专门核对。

要求：
- 只挑你**确实知道正确写法**的。判断要能对上「事迹」：如果想到的正确答案和
  上下文描述的事迹（年代、职务、做过什么事、什么单位）对不上，说明你想的是
  另一个人/另一件事，**不要改**。实测过的反面例子：把「入伍52年、参与全部
  45次核试验的中国工程院院士」里的名字改成某位歌手 —— 那是两个人。
- 只改**错的那几个字**，改完字数要相近（同音误识只改一两个字）。

只输出 JSON，不要别的：
{"items":[{"wrong":"笔记里原样的错写法","right":"正确写法","why":"一句话依据"}]}
没找到就输出 {"items":[]}。

【笔记】
${body}`;

  try {
    const out = await callLLM(
      [{ role: 'user', content: prompt }],
      { signal, temperature: 0.1, maxTokens: 1200 }
    );
    const json = extractJsonObject(out);
    const items = Array.isArray(json?.items) ? json.items : [];
    const fixes = [];
    for (const it of items) {
      const wrong = String(it?.wrong || '').trim();
      const right = String(it?.right || '').trim();
      const why = String(it?.why || '').trim();
      if (!wrong || !right || wrong === right) continue;
      // 只有笔记里确实是这个错写法才收（防模型记错原文/自己发挥）
      if (!body.includes(wrong)) continue;
      // 和逐条核对同一套护栏：字数相近 + 编辑距离足够小。
      // 「同音误识」落到字面上就是改不了几个字；差得远的必然是模型在硬凑。
      if (Math.abs(right.length - wrong.length) > 2) continue;
      if (!looksLikeTypo(wrong, right)) continue;
      // 前缀/后缀增删不是改错字（真替换会把正文改坏，实测「主动放弃」→「主主动放弃」）
      if (right.includes(wrong) || wrong.includes(right)) continue;
      // 只留**错的那几个字**：全角/半角、空白差异会让 split/join 换不干净
      const d = coreDiff(wrong, right);
      fixes.push({ text: wrong, to: right, why, core: d || undefined, open: true });
    }
    // 同一个错写法可能被报两次（「诚信之性」和「全国诚信之性奖项」），留短的
    const seen = new Set();
    return fixes.filter((f) => {
      const k = f.text + '\u0000' + f.to;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  } catch {
    return null;
  }
}

/**
 * 只要**对象**的 JSON 解析。
 *
 * 为什么不直接用 extractJson：那个函数的 [] 分支写在 {} 前面，
 * 而 `{"aliases": ["林进德","林俊泽"], "person": "林俊德"}`
 * 里第一个 `[` 在 `{` 之后、最后一个 `]` 也在 `}` 之前 —— 于是它切出
 * 的是内层数组，对象字段永远读不到，这一步会一直静默返回 null。
 */
function extractJsonObject(text) {
  const s = String(text || '').trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : s;
  const i = body.indexOf('{');
  const j = body.lastIndexOf('}');
  if (i !== -1 && j > i) {
    try {
      return JSON.parse(body.slice(i, j + 1));
    } catch {}
  }
  const v = extractJson(body);
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}


/** 把模型输出的 [12:34] 变成可点击的跳转链接 */
export function linkifyTimestamps(md) {
  return String(md || '')
    .replace(/\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]\((?!https?:)[^)]*\)/g, (m, a, b, c) => {
      const sec = c ? +a * 3600 + +b * 60 + +c : +a * 60 + +b;
      return `[${m.match(/^\[([^\]]+)\]/)[1]}](#t=${sec})`;
    })
    .replace(/(?<!\])\[(\d{1,2}):(\d{2})(?::(\d{2}))?\](?!\()/g, (m, a, b, c) => {
      const sec = c ? +a * 3600 + +b * 60 + +c : +a * 60 + +b;
      return `[${m.slice(1, -1)}](#t=${sec})`;
    });
}

/** 从大模型输出里抠出第一个 JSON 数组/对象，容错常见的前后废话 */
export function extractJson(text) {
  const s = String(text || '').trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : s;
  for (const [open, close] of [['[', ']'], ['{', '}']]) {
    const i = body.indexOf(open);
    const j = body.lastIndexOf(close);
    if (i !== -1 && j > i) {
      try {
        return JSON.parse(body.slice(i, j + 1));
      } catch {}
    }
  }
  return null;
}

/**
 * 从**被截断**的 JSON 数组里，尽量把已经完整写出来的元素捞回来。
 *
 * 为什么需要它：校对任务要求模型逐条回抄原文，输出很长；一旦 max_tokens 不够或超时，
 * 拿到的就是 `[{"start":1,"end":2,"text":"…"},{"start":3,"end":` 这种半截文本，
 * JSON.parse 直接抛异常，一整块（可能几千字）校对成果全废。
 * 这里按"顶层大括号配对"把完整的元素扫出来，能救多少救多少。
 *
 * @returns {Array} 捞到的对象数组（可能为空）
 */
export function salvageJsonArray(text) {
  const s = String(text || '');
  const start = s.indexOf('[');
  if (start === -1) return [];
  const out = [];
  let depth = 0;
  let objStart = -1;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && objStart !== -1) {
        try {
          out.push(JSON.parse(s.slice(objStart, i + 1)));
        } catch {
          /* 这一个是坏的，跳过继续扫 */
        }
        objStart = -1;
      }
    } else if (ch === ']' && depth === 0) break;
  }
  return out;
}

/** 把捞回来的条目按 start 匹配回原块（匹配不上就丢，宁可漏改不可错位） */
function adoptItems(items, chunk) {
  const out = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const seg = chunk.find((s) => Math.abs(Number(s.start) - Number(item.start)) < 0.01);
    if (!seg) continue;
    const text = String(item.text ?? '').trim();
    if (!text) continue; // 空文本一律不采纳，防止把整段抹掉
    out.push({ start: seg.start, end: seg.end, text });
  }
  return out;
}

/** 对一块调用大模型。maxTokens 给足 —— 复核要求逐条回抄原文，输出长度和输入同量级 */
async function proofreadOnce(chunk, { signal }) {
  const compact = chunk.map((s) => ({ start: s.start, end: s.end, text: s.text }));
  const body = JSON.stringify(compact);
  const content = await callLLM(
    [
      {
        role: 'system',
        content:
          '你是中文语音识别的校对员。下面是一段课堂录音的识别结果（JSON 数组），带时间戳。请逐条处理：' +
          '1) 繁体字改简体字；2) 按上下文纠正音近错别字（如「变力」→「遍历」、「鸡疫」→「基因」）；' +
          '3) 删除乱码符号、重复标点、无意义的口头语碎片；4) 保留原意，不要增删内容，不要把口语改成书面语；' +
          '5) 把误识成拼音首字母或英文字母的片段按上下文还原成中文（如「BJR考试」→「闭卷考试」、「B末成绩」→「期末成绩」、「BJ」→「闭卷」），拿不准的保留原样、不要瞎猜。' +
          '输出一个 JSON 数组，元素个数和顺序必须与输入**完全一致**，每个元素 {"start":数字,"end":数字,"text":"校对后的文字"}。' +
          'start/end 必须和输入一模一样，text 必须是校对后的完整文字，不许留空、不许合并、不许省略。只输出 JSON，不要任何解释。',
      },
      { role: 'user', content: body },
    ],
    {
      signal,
      temperature: 0.1,
      // 关键：。llama-server 默认 -n_predict 512，输出会被截成半截 JSON。
      // 这里按"输入字符数 × 1.6 + 512"给配额。中文一个字约 1 token，留足余量。
      maxTokens: Math.min(8192, Math.ceil(body.length * 1.6) + 512),
      timeoutMs: 600000,
    }
  );
  const arr = extractJson(content);
  return { content, items: Array.isArray(arr) ? arr : salvageJsonArray(content), strict: Array.isArray(arr) };
}

/**
 * 逐字稿校对（你点「开始转写」后跑的那道自检）。
 * 分块让大模型：繁转简、按上下文纠正音近错字、删多余符号和口头语碎片，
 * 保留原意和时间戳。大模型不可用/没配时，调用方退回纯确定性清洗。
 *
 * 分块策略（2026-10 改）：原来固定 5000 字一块，实测 88 分钟的课跑到第 5 块会
 * 「大模型校对输出不是合法 JSON」—— 块太大，模型回抄原文时输出被截断成半截 JSON。
 * 现在改成"先大后小逐级降级 + 抢救半截 JSON + 逐条兜底"：
 *   5000 字 → 失败 → 2500 → 1250 → 800
 *   任何一级只要捞回至少一半的条目就采纳，捞不回来的条目**原样保留**（绝不删段）；
 *   全都失败才用确定性清洗的结果（行为等同"这轮没跑大模型校对"）。
 *
 * @returns {Promise<{segments:Array, changed:number, repaired:number[]}>}
 *          repaired = 靠降级/兜底才过关的块序号（从 1 开始），供调用方提示用户
 */
export async function cleanTranscriptViaLLM(segments, { onProgress = () => {}, signal } = {}) {
  const src = cleanSegments(segments); // 先做确定性清洗，减少大模型的负担
  const chunks = chunkTranscript(src, PROOF_CHUNK);
  const out = [];
  const repaired = [];

  for (let i = 0; i < chunks.length; i++) {
    if (signal?.aborted) throw new Error('已取消');
    const chunk = chunks[i];
    let done = null;

    for (const size of PROOF_SIZES) {
      const parts = chunk.length > size ? chunkTranscript(chunk, size) : [chunk];
      const got = [];
      let ok = true;
      for (const part of parts) {
        if (signal?.aborted) throw new Error('已取消');
        let r;
        try {
          r = await proofreadOnce(part, { signal });
        } catch (e) {
          if (signal?.aborted) throw e;
          ok = false;
          break;
        }
        const items = adoptItems(r.items, part);
        // 采纳条件：**条目数必须和输入完全相等**。
        // 这里不能用"回抄一半也行" —— 少一条就是丢一段逐字稿，用户看到的是缺字的笔记。
        // 条目数对不上说明模型偷懒或输出被截断，这一级作废、换更小的块重试。
        if (items.length !== part.length) {
          ok = false;
          break;
        }
        // 长度护栏（2026-10 加）：云端转写可能整篇只有 1 段，模型回抄同一条数的
        // JSON 却只吐一句话（实测：2295 字进、303 字出）。条目数对得上 ≠ 没丢字，
        // 必须再看总字数 —— 校对不会把话删到一半以下，少了就说明被偷懒/截断了。
        const srcLen = part.reduce((n, s) => n + String(s.text || '').length, 0);
        const gotLen = items.reduce((n, s) => n + String(s.text || '').length, 0);
        if (srcLen > 40 && gotLen < srcLen * 0.6) {
          ok = false;
          break;
        }
        got.push(...items);
      }
      // 必须**所有 part 都过**才采纳。只过了一部分就采纳的话，后面的 part 会被静默丢掉，
      // 逐字稿就缺段了 —— 宁可整块退回确定性清洗，也不能少字。
      if (ok && got.length) {
        done = got;
        if (size < PROOF_CHUNK) repaired.push(i + 1);
        break;
      }
    }

    if (done) {
      out.push(...done);
    } else {
      // 兜底：这一块整块用确定性清洗的结果 —— 宁可"没校对"，也不能缺段
      out.push(...chunk.map((s) => ({ start: s.start, end: s.end, text: s.text })));
      if (!repaired.includes(i + 1)) repaired.push(i + 1);
    }
    onProgress(
      `正在校对逐字稿 ${i + 1}/${chunks.length} 段…`,
      10 + Math.round(((i + 1) / chunks.length) * 60)
    );
  }
  onProgress('校对完成', 80);
  const changed = diffCount(segments, out);
  return { segments: out, changed, repaired };
}

/** 把离线引擎的提纲渲染成 Mermaid mindmap（可在支持 Mermaid 的地方粘贴） */
export function outlineToMermaid(outline, rootTitle = '课堂笔记') {
  const esc = (s) => String(s || '').replace(/[{}<>"[\]]/g, '').trim() || '要点';
  const L = ['mindmap', `  root((${esc(rootTitle)}))`];
  for (const t of outline || []) {
    L.push(`    ${esc(t.heading)}`);
    for (const p of t.points || []) {
      L.push(`      ${esc(p.text).slice(0, 24)}`);
    }
  }
  return L.join('\n');
}

/** 把离线引擎的提纲渲染成 OPML（可导入 XMind / 幕布 / MindManager） */
export function outlineToOpml(outline, rootTitle = '课堂笔记') {
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const L = ['<?xml version="1.0" encoding="UTF-8"?>', '<opml version="2.0"><head><title>' + esc(rootTitle) + '</title></head><body>'];
  L.push(`<outline text="${esc(rootTitle)}">`);
  for (const t of outline || []) {
    L.push(`  <outline text="${esc(t.heading)}">`);
    for (const p of t.points || []) L.push(`    <outline text="${esc(p.text)}"/>`);
    L.push('  </outline>');
  }
  L.push('</outline></body></opml>');
  return L.join('\n');
}
