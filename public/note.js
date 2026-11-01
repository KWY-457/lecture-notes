/**
 * 笔记规范化层 —— 整个应用**唯一**的笔记出入口，与 transcript.js 对称。
 *
 * 为什么要有这一层：
 *   笔记是「逐字稿 + 算法」的产物。算法会改、结构会变、旧版本还会写出
 *   每 5 句一刀的碎片主题（「朋友在这康康 · 友在这康康重」）。
 *   以前这些笔记原样躺在磁盘上，界面读出来就是旧算法最难看的样子，
 *   而且用户完全没有办法知道「这条笔记已经过时了」。
 *
 * 现在的规矩：
 *   1. 每条笔记都记下**它是用哪版算法、对哪份逐字稿**算出来的（noteVersion
 *      + sourceHash）。版本或原文一变，就说明笔记过时了。
 *   2. 离线笔记（mode !== 'llm'）过时后可以**自动重建** —— 它本来就是
 *      逐字稿的确定性函数，重算不需要联网、不花钱、不改一个字的原文。
 *   3. AI 笔记（mode === 'llm'）过时后**不自动重建** —— 那是模型读过原文写的，
 *      重算会花用户的钱，也可能丢掉模型改对的专名。只在界面上提示「可重建」。
 *   4. **正文里的提示词残留必须在入口就洗掉**（stripPromptLeaks）。
 *      以前只在渲染时滤，磁盘上一直是脏的：导出 Word、导出 md、
 *      复制笔记、思维导图全都会把「［40 字以内，说清这节课的主线。］」带出去。
 *
 * 设计原则：
 *   - 只判「过时/不过时」，不猜内容好不好；
 *   - 重建必须幂等：同样的逐字稿 + 同样的算法版本 → 同样的笔记，不会反复重写；
 *   - 清洗也必须幂等：洗过和没洗过的，过一遍结果一样。
 *
 * 注意：本文件同时在浏览器（public/ 静态资源）和 Node（server.mjs）里被加载，
 * 所以不能用 node:crypto，下面自带一个纯 JS 哈希。
 */
import { stripPromptLeaks } from './md.js';

/** 笔记结构/算法版本。**改了 summarize.js 的分主题或渲染规则就要 +1。** */
export const NOTE_SCHEMA_VERSION = 2;

/**
 * 纯 JS 的 64 位字符串哈希（FNV-1a 变体，用两个 32 位累加器避免精度问题）。
 * 用途只是「判断两份逐字稿是否相同」，不是加密，不需要抗碰撞的强度。
 */
function hash64(str) {
  let h1 = 0x811c9dc5;
  let h2 = 0x1b873593;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c + i;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/**
 * 逐字稿的指纹：用来判断「这份笔记还是不是这份逐字稿算出来的」。
 * 用全文 + 段数 + 末段结束时间，任何一项变了都算换了原文。
 * 全文可能上万字，hash 一下只有 16 个字符，存进 note.json 不心疼。
 */
export function transcriptFingerprint(transcript) {
  const t = transcript && typeof transcript === 'object' ? transcript : {};
  const text = String(t.text || '');
  const segs = Array.isArray(t.segments) ? t.segments : [];
  const last = segs.length ? Number(segs[segs.length - 1].end) || 0 : 0;
  return hash64(text + '\u0000' + segs.length + '\u0000' + last.toFixed(2));
}

/**
 * 判断一条笔记是不是过时了。
 *
 * @param {object|null} note 读出来的 note.json
 * @param {{fingerprint?:string}} ctx 当前逐字稿的指纹
 * @returns {{stale:boolean, reason:string, canAutoRebuild:boolean}}
 *   stale            —— 需要重建
 *   reason           —— 人话说明为什么（写进界面提示）
 *   canAutoRebuild   —— 离线笔记才能自动重建；AI 笔记要问用户
 */
export function noteStatus(note, ctx = {}) {
  const n = note && typeof note === 'object' ? note : null;
  if (!n || !n.markdown) {
    return { stale: true, reason: '还没有笔记', canAutoRebuild: true, missing: true };
  }
  const canAutoRebuild = n.mode !== 'llm';
  const ver = Number(n.noteVersion) || 0;
  const want = ctx.fingerprint || '';
  const got = String(n.sourceHash || '');

  // 逐字稿换了（重新转写过、或补回了漏掉的句子）→ 笔记里的时间戳会指错地方
  if (want && got && got !== want) {
    return { stale: true, reason: '逐字稿已更新', canAutoRebuild };
  }
  // 算法升级过 → 旧笔记可能是碎片主题。
  // 对用户只说「整理方式升级了」，不暴露 v1/v2 这种内部版本号。
  if (ver < NOTE_SCHEMA_VERSION) {
    return { stale: true, reason: '整理方式已升级', canAutoRebuild };
  }
  // 老笔记没存指纹：只要不是 AI 写的，就重建一次把指纹补上
  if (!got && canAutoRebuild) {
    return { stale: true, reason: '补一下原文校验', canAutoRebuild };
  }
  return { stale: false, reason: '', canAutoRebuild };
}

/**
 * 给即将落盘的笔记补上「血统信息」。
 * 写入方（前端 doNotes / 服务端自动重建）都要过这一步，
 * 保证磁盘上每条笔记都能被 noteStatus() 判断。
 *
 * 顺带把正文洗一遍（stripPromptLeaks）：脏东西不该有机会落到磁盘上。
 * 以前只在渲染时滤，结果「导出 Word」「导出 md」「复制笔记」三条路
 * 绕开了渲染层，提示词残留照样跑到用户眼前。
 */
export function stampNote(note, { fingerprint, mode } = {}) {
  const n = note && typeof note === 'object' ? { ...note } : {};
  n.noteVersion = NOTE_SCHEMA_VERSION;
  if (fingerprint) n.sourceHash = String(fingerprint);
  if (mode) n.mode = mode;
  return normalizeNote(n).note;
}

/**
 * 从笔记 Markdown 的「## 课堂脉络与重点」小节反推提纲。
 *
 * 为什么需要它：AI 笔记的 `data` 字段里塞的是**离线引擎**算出来的提纲
 * （每 5 句一刀的 24 个碎片：「一下这门课 · 能记」「bjr · 一部分」），
 * 而正文 `markdown` 是模型重新组织的 4 个连贯主题。两套结构并存时，
 * 只要哪一处读 `data.outline`（思维导图、数据体检、导出），用户看到的就是碎片。
 *
 * 规矩：AI 笔记的正文才是唯一事实来源，`data.outline` 只是它的派生缓存。
 * 这个函数把正文解析成和离线提纲同构的形状，两边就能对上了。
 */
export function outlineFromMarkdown(md) {
  const outline = [];
  let cur = null;
  for (const line of String(md || '').split('\n')) {

    const h = line.match(/^###\s+(.*)$/);
    if (h) {
      // 「### 1. 成绩构成 [01:32](#t=92)」→ heading「成绩构成」、start 92
      const anchor = h[1].match(/\[[^\]]*\]\(#t=([\d.]+)\)\s*$/);
      const heading = h[1]
        .replace(/\s*\[[^\]]*\]\(#t=[\d.]+\)\s*$/, '')
        .replace(/^\d+[.、]\s*/, '')
        .trim();
      cur = { heading, points: [] };
      if (anchor) cur.start = Number(anchor[1]);
      outline.push(cur);
    } else if (/^##\s+/.test(line)) {
      // 出了「课堂脉络与重点」，后面的列表（易错、自测等）不算这个主题的要点
      cur = null;
    } else if (cur && /^-\s+/.test(line)) {
      const t = line
        .replace(/^-\s+/, '')
        .replace(/\s*\[[^\]]*\]\(#t=[\d.]+\)\s*$/, '')
        .trim();
      if (t) cur.points.push({ text: t });
    } else if (cur && /^\s+\d+\s*[.、)]\s+/.test(line)) {
      /**
       * 「- 操作步骤：」下面那几条 `  1. …` `  2. …` 缩进编号子项。
       *
       * 2026-11-01 之前只认 `- ` 开头，编号子项全丢 —— 于是要点里只剩一个
       * 空壳 `操作步骤：`（冒号后面什么都没了），而真正的三条步骤
       * （`对F(x,y)=0两边求导，右端得0` …）一条都没进提纲，导图上自然也就没有。
       * 实测这一处单独就让高数笔记少挂 3~6 条叶子。
       *
       * 只收**缩进的**编号行：顶格的 `1. xxx` 是另一个列表的开始，
       * 不该并进上一条要点。
       */
      const t = line
        .replace(/^\s+\d+\s*[.、)]\s+/, '')
        .replace(/\s*\[[^\]]*\]\(#t=[\d.]+\)\s*$/, '')
        .trim();
      if (t) cur.points.push({ text: t });
    }
  }
  return outline.filter((t) => t.heading);
}

/**
 * 笔记规范化：洗正文 + 修正「两套结构打架」。
 *
 * 为什么单独一个函数而不是塞进 stampNote：
 *   stampNote 是「写入时盖章」，normalizeNote 是「任何时候都可以过一遍」。
 *   读取路径要用后者 —— 磁盘上的老笔记没人给它盖过章，
 *   但它的正文照样可能是脏的，读出来就得洗、就得修。
 *
 * @returns {{note: object, repairs: string[]}} repairs 非空表示真的改了什么
 */
export function normalizeNote(note) {
  const n = note && typeof note === 'object' ? { ...note } : {};
  const repairs = [];

  if (typeof n.markdown === 'string' && n.markdown) {
    const cleaned = stripPromptLeaks(n.markdown);
    if (cleaned !== n.markdown) {
      // 不能洗成空：万一整篇都是方括号内容（不该发生，但真发生就宁可留着脏的）
      if (cleaned.trim()) {
        n.markdown = cleaned;
        repairs.push('清掉正文里的提示词残留');
      }
    }
  }

  // AI 笔记：data.outline 跟正文对不上就按正文重算。
  // 只在正文真的解析出主题时才动手 —— 解析不出说明这是别的版式，宁可不动。
  //
  // 注意 data 可能是 null（导入的示例录音就没有离线分析数据）。
  // 这不是「没有 data 就跳过」的理由：正文有主题、data 是空的，
  // 恰恰是最该补的时候 —— 思维导图读 data.outline，空数组就是「一片空白」。
  if (n.mode === 'llm' && typeof n.markdown === 'string' && n.markdown) {
    const derived = outlineFromMarkdown(n.markdown);
    if (derived.length) {
      const base = n.data && typeof n.data === 'object' && !Array.isArray(n.data) ? n.data : null;
      const cur = Array.isArray(base?.outline) ? base.outline : [];
      const same =
        cur.length === derived.length &&
        cur.every((t, i) => t && t.heading === derived[i].heading);
      if (!same) {
        n.data = { ...(base || {}), outline: derived };
        repairs.push(base ? '提纲按正文重算' : '补上按正文算的提纲');
      }
    }
  }

  return { note: n, repairs };
}

/* ========================= 思维导图的标签 ========================= */

/**
 * 从正文的「## 关键词」一节取全局关键词。
 *
 * 为什么优先用它：这一节是写笔记那一步专门挑出来的**术语表**，
 * 全都已经是干净短词（`内卷` `三面投影` `乐观精神`），
 * 比从要点句子里现算 n-gram 可靠一个量级 —— 现算的会冒出
 * 「归遍」「影面」「准化信息载体」这种被切碎的片段。
 *
 * 两种写法都要吃：AI 笔记爱写成 `` `内卷` · `躺平` ``，离线笔记
 * （和早期版本）写成「成绩 · 平时成绩 · 期末考试」。
 */
export function globalKeywords(md) {
  const lines = String(md || '').split('\n');
  // 找到下一次出现的 ## 标题下标；越过它这一节就结束了。
  // 只认 ## 不认 ###：关键词表后面紧跟的可能是 ### 主题，那是下一节的内容。
  const start = lines.findIndex((l) => /^##\s/.test(l) && /关键词/.test(l));
  if (start === -1) return [];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return parseKeywordSeg(lines.slice(start + 1, end).join('\n'));
}

function parseKeywordSeg(seg) {
  const ticks = [...String(seg).matchAll(/`([^`]{2,12})`/g)].map((m) => m[1]);
  if (ticks.length) return dedupe(ticks).slice(0, 24);
  return dedupe(
    String(seg)
      .split(/[·、,，\n]+/)
      .map((s) => s.replace(/^[-*\s>]+|[-\s]+$/g, '').trim())
      .filter((s) => clen(s) >= 2 && clen(s) <= 12)
  ).slice(0, 24);
}

const dedupe = (a) => [...new Set(a)];
const clen = (s) => [...String(s || '')].length;

/** 标签黑名单：空泛词、量词、虚词、语气词。命中的候选直接不要。 */
const LBL_BAD = /[的了是在和就都也很到说要会着把被对从而则又再才更最这那有些们好呢吧吗啊呀哦嗯我你他它与及等为于其之但是因为如果所以]/;
const LBL_EQUAL =
  /^(?:工作|生活|学习|国家|社会|发展|时间|问题|事情|东西|地方|方面|过程|结果|原因|方法|方式|内容|部分|情况|时候|一个|一下|这些|那些|这样|那样|什么|怎么|可以|应该|还有|没有|就是|然后|所以|但是|如果|因为|比如|例如|起来|出来|大家|我们|你们|他们|这个|那个|第一|第二|第三|第四|实现|看看|来看|讲|说|今天|重点|内容|定义|注意|顺序|步骤|特点|作用|意义|思路|做法|要求|规则|含义|概念|知识|部分|关系|变化|影响|时候|地方)$/;
const LBL_QUANT = /^[一二三四五六七八九十百千万几两多半]/;
const LBL_CLS = /^[种层个条些件次遍趟双群批套组份张支根块片页行列节段项步]/;
/**
 * 以量词结尾、但其实是名词的词。
 *
 * 2026-10-24 实测抓到：「请假条」被下面那条「量词结尾一律不要」误杀，于是
 * 「请假与缺课」这个主题一个标签都抽不出来。这类词不多，直接列白名单比
 * 猜规则可靠 —— 规则一旦写成「长度≥4 才放行」，「事件」「零件」又会被误杀。
 */
const LBL_MEASURE_NOUN =
  /^(?:条件|条款|条理|条约|请假条|病假条|便条|字条|纸条|文件|文档|事件|案件|案件|零件|部件|组件|构件|课件|软件|硬件|试卷|答卷|张量|分量|年份|月份|省份|县城|条目)$/;
const LBL_PUNCT = /[，,；;。！？!?、：:（）()「」“”"·《》/\\]/;
/** 要点常见的开头小词，冒号前缀抽取时要剥掉 */
const LBL_FILLER =
  /^(?:那么|所以|但是|然后|接下来|下面|我们来看|我们再看|举个例子|先明确一个定义|其实|也就是说|就是说|首先|其次|再次|另外|而且|可见|因此|好|最后|第一|第二|第三|第四|同时|比如|比如说)/;
/** 「杨女士」「林俊德院士」「外卖员」这类人物实体，是叙事类要点的骨架 */
const LBL_ENTITY =
  /^([\u4e00-\u9fff]{1,4}(?:女士|先生|院士|教授|同学|女生|男生|干部|专家|医生|老师|姐姐|弟弟|母亲|父亲|工人|司机|外卖员|企业家|书记|院长))/;

const cleanLabel = (s) =>
  String(s || '')
    .replace(/\*\*/g, '')
    .replace(/\[[^\]]*\]\(#t=[\d.]+\)/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .trim();

/**
 * 候选词是不是「自由出现的」。
 *
 * 用来剔除被切碎的片段：`归遍` 在原文里只以「递归遍历」的一段出现，
 * 前后都紧贴着别的汉字，从来不会自己单独出现 —— 这种放进导图就是乱码。
 * `访问` 则常常前后是标点或句首，自由出现率高。
 *
 * @returns {number} 0~1，自由出现次数 / 总出现次数
 */
export function freeStandingRatio(term, hay) {
  const t = String(term || '');
  const s = String(hay || '');
  if (!t) return 0;
  const CJK = /[\u4e00-\u9fff]/;
  let total = 0;
  let free = 0;
  for (let i = s.indexOf(t); i !== -1; i = s.indexOf(t, i + 1)) {
    total++;
    const before = i > 0 ? s[i - 1] : '';
    const after = s[i + t.length] || '';
    if (!CJK.test(before) && !CJK.test(after)) free++;
  }
  return total ? free / total : 0;
}

/**
 * 把一串要点压成一个短标签（只在前面几层都抽不出东西时才用）。
 *
 * **只在标点上切，绝不按字数硬截。** 硬截出来的是「作业是课后习题 6.」
 * 「，那今天就到这里，下」这种半个数字、半个词的东西，比空着难看得多。
 * 所以宁可返回空串 —— 调用方看到空就少挂一个标签，导图不会因此变难看。
 */
export function squeezeLabel(text, max = 10) {
  const t0 = (cleanLabel(text).split('\n')[0] || '')
    .replace(
      /^(?:那么|所以|但是|然后|因为|其实|首先|其次|再次|另外|而且|可见|因此|同时|还有|也就是说|就是说|举个例子|比如说|比如|我们来看|我们再看|接下来|下面|最后|好|对|嗯)[，,、\s]*/,
      ''
    )
    .replace(/^[，,、；;：:。！？!?…\s]+/, '')
    .replace(/[。！？!?；;，,、\s]+$/, '');
  if (!t0) return '';
  /**
   * 片段像不像一个标签。
   *
   * 这一组判断 2026-10-24 之前只写在下面那个 for 循环里 —— 于是「整句短到
   * 可以直接当标签」那条早退完全绕过了它们：`那么时间复杂度是 O(n)` 被
   * cleanLabel 削掉 `(n)` 后剩下 `时间复杂度是 O`，8 个字、没标点，就原样
   * 当标签输出去了（半个公式）。现在两条路共用同一套判断。
   */
  const goodSeg = (s, min) => {
    if (clen(s) < min || clen(s) > max) return false;
    // 两字的「下课」「好了」基本都是句子残渣，除非整串正好是它（min=2 那条路）
    // 「那今天就到这里」这种以指代/虚词开头的片段没有信息量
    if (/^(?:那|这|就|也|还|再|又|才|会|要|把|被|给|让|叫|是|有|没|从|向|对)/.test(s)) return false;
    // 带数字、字母的是习题号/章节号/公式（`课后习题 6.3` `时间复杂度是 O`），不是概念
    if (/[0-9A-Za-z]/.test(s)) return false;
    // 「下次课我们讲」「下周三之前提交到学习通」—— 含人称或时间词的是句子，不是标签
    if (/(?:我们|你们|他们|大家|同学)/.test(s)) return false;
    if (/(?:今天|明天|后天|下周|下次|上次|下节|本节|这周|上周|之前|以后|然后|最后)/.test(s)) return false;
    // 结尾是动作的（`预习一下线索二叉树的内容` 之外，`提交到学习通` 也在此列）
    if (/(?:讲|说|看|做|去|来|走|开始|结束|提交|预习|复习|布置|提醒|学完|完成)$/.test(s)) return false;
    if (/(?:提交|预习|复习|布置|提醒|记住|注意)/.test(s)) return false;
    return true;
  };
  // 整句短到可以直接当标签（`递归` `时间复杂度`）
  if (clen(t0) <= max && !/[，,、；;：:]/.test(t0) && goodSeg(t0, 2)) return t0;
  // 否则按标点切，取第一个「长度合适、像名词短语」的片段
  for (const seg of t0.split(/[，,、；;：:]/)) {
    const s = seg.replace(/^[的地得]\s*/, '').trim();
    // 兜底只收 3 字以上：两字的「下课」「好了」基本都是句子残渣，
    // 而真正的两字概念（`递归` `内卷`）在前面几层早就被抽走了，轮不到这里。
    if (goodSeg(s, 3)) return s;
  }
  return '';
}

/**
 * 一个关键词最多出现在几个主题里，超过就当它「到处都有」而不敢用。
 *
 * 实测（6 份真实笔记）：`工作` `生活` `国家` `学习` 这类泛词会横跨
 * 三四个主题，挑出来当标签等于没挑；而 `平时成绩` `正投影` `栈顶`
 * 这种真术语通常只落在 1~2 个主题里。所以按主题数卡，比按出现次数卡准。
 */
const labelSpread = (kw, hays) => hays.reduce((n, h) => n + (h.includes(kw) ? 1 : 0), 0);

/**
 * 领域术语的常见词尾。
 *
 * 逐字稿里最值钱的骨架词往往长得很有规律：`线索二叉树` `二叉搜索树`
 * `三面投影` `时间复杂度`。这类词 n-gram 抽不准（会被切成「归遍」「影面」），
 * 但只要在要点里按词尾前后各截几个字，命中率就很高，而且是真术语。
 *
 * 只收**两字以上**的词尾：单字尾（`栈` `树` `图`）会把「把根节点弹出栈」
 * 切成「弹出栈」这种动宾碎片，而且和 localKeywords 里的「栈顶」重复。
 */
const LBL_TERM_TAIL =
  /(?:二叉树|搜索树|平衡树|哈希表|链表|队列|遍历|排序|查找|算法|函数|公式|定理|定律|矩阵|向量|积分|导数|方程|概率|分布|投影|视图|剖视|断面|公差|配合|材料|应力|弯矩|转矩|功率|转速|电路|电压|电流|阻抗|细胞|组织|器官|蛋白|基因|代谢|免疫|病理|宪法|法律|法规|条例|制度|主义|精神|战略|政策|市场|货币|通胀|供给|需求|价格|成本|利润|绩效|折现|现值|收益|伦理|道德|价值|权利|义务|责任|契约|正义|公平)/;

/**
 * 一个主题能用的标签。顺序＝可靠性从高到低，凑够 4 个就停：
 *   ① 作者自己加粗的词（AI 笔记的 `**内卷本质**：…`，最强信号）
 *   ② 「X：说明」里的 X
 *   ③ 人物/机构等实体名（叙事类要点的骨架）
 *   ④ 主题自带 localKeywords（离线引擎逐主题算过，专有名词质量不错）
 *   ⑤ 按词尾捞到的领域术语（`线索二叉树` `时间复杂度`）
 *   ⑥ 笔记「## 关键词」里落在本主题、且不横跨太多主题的术语
 * 全都抽不出时**就不给标签** —— 调用方可以退回 squeezeLabel() 摘一句短语，
 * 千万别为了凑数塞个「工作」「方面」上去，那种标签比没有更费解。
 *
 * @param {{heading?:string, points?:{text:string}[], localKeywords?:string[]}} topic
 * @param {{markdown?:string, used?:Set<string>, hays?:string[]}} opt
 *        used 跨主题共享，避免两个主题挂同一个标签；
 *        hays 全部主题的要点文本，用来判关键词的「主题散布度」
 */
export function topicLabels(topic, opt = {}) {
  const pts = (topic?.points || []).map((p) => cleanLabel(p.text));
  const hay = pts.join(' ');
  const heading = String(topic?.heading || '');
  const used = opt.used instanceof Set ? opt.used : new Set();
  const kwCache = opt.markdown != null ? globalKeywords(opt.markdown) : [];
  const hays = Array.isArray(opt.hays) && opt.hays.length ? opt.hays : [hay];
  const maxSpread = Math.max(2, Math.ceil(hays.length * 0.6));
  const out = [];

  const acceptable = (t) => {
    if (!t) return false;
    const n = clen(t);
    if (n < 2 || n > 8) return false;
    if (LBL_EQUAL.test(t) || LBL_QUANT.test(t) || LBL_CLS.test(t)) return false;
    // 名词白名单放行：`请假条` `零件` `课件` 结尾虽是量词字，却是实词
    if (!LBL_MEASURE_NOUN.test(t) && /[种个条层次遍项步骤件份张]$/.test(t)) return false;
    if (LBL_BAD.test(t) || LBL_PUNCT.test(t)) return false;
    if (/^[a-z]{1,2}$/i.test(t)) return false;
    // 序数词和「X 种/个/条」：`第二种` `第四种` 是计数不是概念
    if (/^(?:第|其|该|此|每|各|另|前|后)/.test(t)) return false;
    // 和主题标题重复的不要：导图上「主题 → 主题」是纯噪音
    // 主题标题里已经有的词不要：导图上「主题 → 主题」是纯噪音。
    // 用「包含」而不是「相等」——标题「请假与缺课」里再挂个「缺课」没意义。
    // 但短标题（≤3 字，如「中序遍历」）例外：那种标题本身是术语，
    // 挂「访问」「子树」这类词是正常的层级关系，不是重复。
    if (clen(heading) > 3 && (heading.includes(t) || t.includes(heading))) return false;
    // 与已选标签互为子串的不要（「零件」和「零件图」同时出现很吵）
    if (out.some((o) => o.includes(t) || t.includes(o))) return false;
    // 与**别的主题**已经用掉的标签互为子串的也不要：主题甲挂了「二叉树」，
    // 主题乙就别再挂「二叉搜索树」。这比只查重更狠，但实测正是想要的效果 ——
    // 骨架词每样只出现一次，读者才知道该往哪看。
    for (const u of used) {
      if (u.includes(t) || t.includes(u)) return false;
    }
    return true;
  };
  const add = (w) => {
    const t = cleanLabel(w).replace(/^[-—·\s]+|[-—·\s]+$/g, '');
    if (!acceptable(t) || used.has(t)) return false;
    out.push(t);
    used.add(t);
    return true;
  };
  const full = () => out.length >= 4;
  const countIn = (w) => hay.split(w).length - 1;

  // ① 加粗
  for (const p of topic?.points || []) {
    for (const m of String(p.text || '').matchAll(/\*\*(.+?)\*\*/g)) {
      if (full()) break;
      add(m[1]);
    }
  }
  // ①-b 要点开头后紧跟冒号的（`作业：随堂测验` `请假：需提交请假条`）
  if (!full()) {
    for (const p of pts) {
      if (full()) break;
      const m = p.match(/^([^：:，,。；;]{2,8})[：:]/);
      if (!m) continue;
      const pre = m[1].replace(LBL_FILLER, '').trim();
      if (pre !== m[1].trim()) continue; // 剥掉了口头语 ⇒ 原本就是个句子，不是标签
      add(pre);
    }
  }
  // ② 实体名（叙事类笔记的骨架：「杨女士」「林俊德院士」「山西农村女生」）。
  // 排在规则切词前面 —— 实体名是硬信号，先捞走就不必再猜。
  if (!full()) {
    for (const p of pts) {
      if (full()) break;
      const e = p.match(LBL_ENTITY);
      if (e) {
        add(e[1]);
        continue;
      }
      const bk = p.match(/《([^》]{2,10})》/);
      if (bk) add(bk[1]);
    }
  }
  // ④ 主题自带 localKeywords（离线引擎逐主题算的，专有名词质量最好）
  if (!full()) {
    const local = Array.isArray(topic?.localKeywords) ? topic.localKeywords.filter((x) => typeof x === 'string') : [];
    for (const t of local) {
      if (full()) break;
      if (hay.includes(t)) add(t);
    }
  }
  // ⑤ 按词尾捞领域术语。向左扩到不超 6 字，扩出来的必须是「自由出现」的
  // —— `然后递归遍历` 这种挂在动词后面的一律不要（见 freeStandingRatio）。
  if (!full()) {
    const cand = new Map();
    for (const m of hay.matchAll(new RegExp(LBL_TERM_TAIL.source, 'g'))) {
      const tail = m[0];
      const at = m.index + tail.length;
      for (let w = 3; w <= 6; w++) {
        const s = Math.max(0, at - w);
        const word = hay.slice(s, at);
        if (clen(word) < 3 || !/^[\u4e00-\u9fff]+$/.test(word)) continue;
        if (countIn(word) === countIn(tail)) cand.set(word, (cand.get(word) || 0) + 1);
      }
    }
    const ranked = [...cand.entries()]
      .filter(([w]) => freeStandingRatio(w, hay) >= 0.5)
      .sort((a, b) => b[1] - a[1] || clen(b[0]) - clen(a[0]))
      .map(([w]) => w);
    for (const w of ranked) {
      if (full()) break;
      add(w);
    }
  }
  // ⑥ 笔记「## 关键词」里落在这个主题、且没横跨太多主题的术语。
  // 按「在这段里出现的次数」排，先挑这段真正的重点，而不是术语表的顺序。
  if (!full()) {
    const cand = kwCache
      .filter((k) => hay.includes(k))
      .filter((k) => labelSpread(k, hays) <= maxSpread)
      .map((k) => [k, countIn(k)])
      .sort((a, b) => b[1] - a[1] || clen(b[0]) - clen(a[0]));
    for (const [k] of cand) {
      if (full()) break;
      add(k);
    }
  }
  return out;
}

/** 快速判定要不要 normalize（宁宽勿窄：多洗一遍无害） */
export function needsNormalize(note) {
  if (!note || typeof note !== 'object') return false;
  if (typeof note.markdown !== 'string' || !note.markdown) return false;
  if (/［[\s\S]*?］/.test(note.markdown)) return true;
  // AI 笔记还可能「正文与 data.outline 打架」或「data 里根本没有 outline」
  if (note.mode === 'llm') {
    const derived = outlineFromMarkdown(note.markdown);
    if (!derived.length) return false;
    const cur = Array.isArray(note.data?.outline) ? note.data.outline : [];
    if (cur.length !== derived.length) return true;
    return cur.some((t, i) => !t || t.heading !== derived[i].heading);
  }
  return false;
}

export default {
  NOTE_SCHEMA_VERSION,
  transcriptFingerprint,
  noteStatus,
  stampNote,
  normalizeNote,
  needsNormalize,
  outlineFromMarkdown,
  globalKeywords,
  topicLabels,
  squeezeLabel,
};
