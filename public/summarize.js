/**
 * 离线重点提取引擎 summarize.js
 * ------------------------------------------------------------------
 * 不依赖任何外部库、不联网、可在浏览器与 Node 中直接运行。
 * 输入：带时间戳的转写片段  ->  输出：结构化的课堂笔记 + Markdown
 *
 * 中文场景的关键设计：
 *   1. 无分词器，统一用「字 bigram + 英文单词」作为语义单位，
 *      对中文（未分词）和英文混排都稳定；
 *   2. 句子相似度用倒排索引加速，2000 句也能秒级跑完；
 *   3. 主题切分 = 相邻句子词汇衔接度低谷 + 教师口语中的结构性提示词；
 *   4. 重点句 = TextRank 全局重要性 × 关键词密度 × 线索词加权 × 位置先验，
 *      再用冗余惩罚（MMR 思路）去重。
 * ------------------------------------------------------------------
 */

/* ============================ 词表 ============================ */

const ZH_STOP = new Set(
  (
    '的 了 是 在 我 有 和 就 不 人 都 一 一个 上 也 很 到 说 要 去 你 会 着 没有 看 好 自己 这 那 这个 那个 我们 你们 他们 它们 什么 怎么 为什么 因为 所以 但是 可是 而且 然后 这样 那样 时候 现在 可以 应该 需要 如果 虽然 由于 于是 还是 或者 以及 并且 只是 就是 还是 一样 一些 这些 那些 之 与 及 或 等 等等 被 把 让 使 对 对于 关于 从 向 往 给 跟 和 而 则 又 再 才 更 最 太 挺 蛮 非常 特别 十分 比较 稍微 有点 可能 也许 大概 差不多 其实 当然 显然 确实 一定 必须 能够 不能 不会 不要 别 没 无 非 未 曾 已 已经 正在 将 将要 马上 立刻 刚刚 刚才 一直 总是 经常 有时 偶尔 从来 曾经 之后 之前 之后 以后 以前 之间 之中 里面 外面 上面 下面 前面 后面 左边 右边 中间 这里 那里 哪里 谁 哪 多少 几 个 位 次 种 些 点 部分 情况 问题 东西 事情 方面 地方 时间 过程 结果 原因 方法 方式 样子 内容 大家 咱们 同学 老师 上课 下课 今天 明天 昨天 下次 这次 那么 这么 那么 嗯 啊 呢 吧 吗 呀 哦 噢 唉 哎 哈 嘿 好 行 对 是啊 是的 没错 对不对 是不是 好不好 对吧 好吧 行了 得了 就是说 也就是说 也就是说 那么说 这个呢 那个呢 我们看 看一下 来看 看到 知道 觉得 认为 发现 出现 进行 具有 存在 包括 包含 属于 成为 作为 通过 根据 按照 针对 除了 除非 无论 不管 即使 哪怕 只要 只有 凡是 所有 任何 每个 各个 整个 全部 有的 有些 某个 某个 某些 主要 基本 一般 通常 往往 常常 普遍 具体 实际 事实上 基本上 一般来说 相对 相当 极其 尤其 甚至 简直 几乎 差不多 反正 到底 究竟 居然 竟然 果然 难道 何必 不如 宁可 与其 与其说 不仅 不但 不光 不只 而是 而是说 因而 从而 以致 以至 乃至'
  ).split(/\s+/)
);
const EN_STOP = new Set(
  (
    'the a an and or but if then than that this these those of to in on at by for with from as is are was were be been being it its it\'s we you they he she i not no do does did done have has had will would can could should shall may might must so such very more most much many some any all both each other another there here what which who whom whose when where why how about into over under again further once only own same too also just now new one two get got make made take taken go going say said see seen know known think thought use used using thing things well ok okay yeah right good really actually basically kind sort lot lots'
  ).split(/\s+/)
);

/** 教师口语线索词：加权（正数=更像重点，负数=口头语噪声） */
const CUE_RULES = [
  { label: '考点/考试', w: 3.2, re: /(考点|考点|必考|考试会|会考|考这个|重点掌握|重点内容|重点在于|核心考点|记下来|记一下|划重点|这是重点|这个是重点)/ },
  { label: '老师强调', w: 2.6, re: /(重点是|关键是|核心是|最重要的是|主要在于|重点讲|着重|强调一下|特别注意|一定要注意|必须记住|务必|千万)/ },
  { label: '定义/结论', w: 2.2, re: /(定义|概念|定理|公式|原理|定律|法则|模型|假设|推论|结论是|由此可见|综上|总之|总结一下|归纳起来)/ },
  { label: '因果推理', w: 1.9, re: /(因此|所以|所以说|可见|说明|意味着|导致|原因是|其结果是|从而|进而)/ },
  { label: '举例', w: 1.4, re: /(例如|比如|举例|举个例子|比方说|以.{1,12}为例|比如说|实例|案例)/ },
  { label: '作业安排', w: 2.0, re: /(作业|提交|截止|deadline|下节课|下次课|预习|复习|小组|报告|论文|实验|考试时间|考试范围|期末|期中|平时分|签到)/ },
  { label: '分条列举', w: 1.6, re: /(第一|第二|第三|第四|其一|其二|其三|首先|其次|再次|最后|一方面|另一方面|一是|二是|三是)/ },
  { label: '对比关系', w: 1.2, re: /(区别|不同|对比|相比|联系|关系|影响|作用|意义|优点|缺点|优势|局限|适用|条件)/ },
  { label: '口头语噪声', w: -1.6, re: /^(嗯|啊|呃|额|那个|这个|然后呢|就是说|对不对|是不是|好吧|行吧|我们来看一下|大家看一下)/ },
  { label: '确认式口头语', w: -1.2, re: /(对吧|好不好|是不是啊|OK啊|那么我们|那么接下来我们)/ },
];

/** 结构性提示词：出现时视为新主题起点 */
const TOPIC_MARKERS =
  /^(好[，,]?)?(那么|接下来|下面|下一个|第二个|第三个|第三部分|最后|另外一个|再说|再来看|我们再来|换一个话题|转入|讲到|说到|关于.{1,10}(问题|部分)|第[一二三四五六七八九十]+(部分|章|节|讲|个问题))/;

const EN_SENT_END = /([.!?]+)(\s|$)/;

/** 分条列举的「续接标记」：出现在句首说明它属于上一项，不该在这里切主题 */
const CONTINUATION_RE =
  /^(第[一二三四五六七八九十]+[，,、:：]|其[一二三四五六七八九十][，,、:：]?|其次|再次|然后|接着|一是[，,、:：]|二是[，,、:：]|三是[，,、:：]|四是[，,、:：]|五是[，,、:：]|最后[，,：:]|另一方面|再一个|另外[，,：:])/;

/* ======================== 基础文本工具 ======================== */

const isCJK = (ch) => ch >= '\u4e00' && ch <= '\u9fff';

/** 规范化：去掉多余空白、统一标点 */
export function normalizeText(s) {
  return String(s || '')
    .replace(/\r/g, '')
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * 把一个转写片段切成句子。
 * 中文按 。！？；… 切，英文按 .!? 切；超长句在逗号处二次切分。
 *
 * @param {string} text
 * @param {{keepShort?:boolean}} [opts]
 *   keepShort=true 保留「嗯。」「啊。」这类只有一两个字的短句。
 *   逐字稿要保真（用户会搜「嗯」，SRT 导出也不该少内容），必须留着；
 *   生成笔记要提纯，这些语气词不是要点，默认丢掉。
 *   同一个函数兼顾两种用途，靠这个开关区分 —— 不要让调用方各切一套。
 */
export function splitSentences(text, opts = {}) {
  const keepShort = opts && opts.keepShort === true;
  const t = normalizeText(text);
  if (!t) return [];
  const out = [];
  let buf = '';
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    buf += ch;
    const isCnEnd = '。！？!?；;…'.includes(ch);
    // 英文句点只在「前一字符是字母 且 后一字符是空白或结尾」时才算句末，
    // 免得把「习题 6.3 到 6.8」这类编号和小数切开
    const isEnEnd = ch === '.' && /[A-Za-z]["')\]]?$/.test(buf.slice(0, -1)) && (i + 1 >= t.length || /\s/.test(t[i + 1]));
    const isNewline = ch === '\n';
    if (isCnEnd || isEnEnd || isNewline) {
      const s = buf.trim();
      if (s) out.push(...splitLong(s));
      buf = '';
    }
  }
  if (buf.trim()) out.push(...splitLong(buf.trim()));
  if (keepShort) {
    // 保真模式：只要含至少一个有效字符就留下。
    // 丢掉「嗯。」对笔记无害，对逐字稿是丢内容 —— 用户搜「嗯」搜不到、
    // 导出的 SRT 比录音少一段。两种用途必须分开。
    return out.filter((s) => s.replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '').length >= 1);
  }
  return out.filter((s) => s.replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '').length >= 2);
}

/** 过长的句子（无句号的连续口语）在逗号处切开 */
function splitLong(s, max = 80) {
  if (s.length <= max) return [s];
  const parts = s.split(/(?<=[，,、])/);
  const out = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + p).length > max && cur) {
      out.push(cur.trim());
      cur = p;
    } else cur += p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * 虚词字符表：作为 n-gram 的**首尾**字符出现时，几乎一定是切错的碎片
 * （如「叉树的」「代码就」「间复杂」）。只用于边界过滤，不做分词。
 */
const FUNC_CHARS = new Set(
  '的了是在和就都也很到说要会着把被对从而则又再才更最个这那有些们好呢吧吗啊呀哦嗯我你他它与及等为于其之该每各全只但却并且或因所不没将让使给跟里外上下什怎么'.split('')
);

/** 中间夹着这些字的多半是「半句话」，不是术语 */
const KW_REJECT_RE = /[是有就不为没]/;

/** 语义单位：中文取字 bigram，英文/数字取小写单词 */
export function tokens(s) {
  const str = String(s || '');
  const set = new Set();
  const lower = str.toLowerCase();
  // 英文与数字
  for (const m of lower.matchAll(/[a-z][a-z0-9]{1,}|[0-9]+(?:\.[0-9]+)?/g)) {
    const w = m[0];
    if (w.length > 1 && !EN_STOP.has(w)) set.add(w);
  }
  // 中文字 bigram（跨越标点，但要求两端都是汉字）
  const cjk = [];
  for (const ch of str) cjk.push(isCJK(ch) ? ch : '\u0000');
  for (let i = 0; i < cjk.length - 1; i++) {
    if (cjk[i] !== '\u0000' && cjk[i + 1] !== '\u0000') set.add(cjk[i] + cjk[i + 1]);
  }
  return set;
}

const overlap = (a, b) => {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const t of small) if (big.has(t)) hit++;
  return hit / Math.sqrt(a.size * b.size);
};

/* ==================== 转写 -> 带时间的句子 ==================== */

/**
 * 把 {segments:[{start,end,text}]} 摊平成带时间戳的句子列表。
 * 时间按字符数比例插值，保证每个句子都能跳回音频位置。
 */
export function toSentences(segments) {
  const segs = (segments || [])
    .map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: normalizeText(s.text) }))
    .filter((s) => s.text);
  const sentences = [];
  let hasTime = segs.some((s) => s.end > s.start || s.start > 0);
  let fallbackClock = 0;
  for (const seg of segs) {
    const parts = splitSentences(seg.text);
    if (!parts.length) continue;
    let s0 = seg.start;
    let e0 = seg.end;
    if (!hasTime || e0 <= s0) {
      // 云端接口只返回整段文字时，用字数估算一个可用时间轴（约 4.2 字/秒）
      s0 = fallbackClock;
      e0 = s0 + Math.max(2, parts.join('').length / 4.2);
    }
    fallbackClock = e0;
    const total = parts.reduce((n, p) => n + p.length, 0) || 1;
    let cursor = s0;
    for (const p of parts) {
      const dur = ((e0 - s0) * p.length) / total;
      sentences.push({ text: p, start: +cursor.toFixed(2), end: +(cursor + dur).toFixed(2), tokens: null });
      cursor += dur;
    }
  }
  for (const s of sentences) s.tokens = tokens(s.text);
  return { sentences, hasTime };
}

/* ====================== 全局重要性 TextRank ====================== */

function textRank(sentences, { damping = 0.85, iterations = 40, tol = 1e-4 } = {}) {
  const n = sentences.length;
  const scores = new Array(n).fill(1);
  if (n < 2) return scores;

  // 倒排索引：token -> 句子下标，避免 O(n^2) 的全量两两比较
  const index = new Map();
  sentences.forEach((s, i) => {
    for (const t of s.tokens) {
      if (!index.has(t)) index.set(t, []);
      index.get(t).push(i);
    }
  });
  const sim = new Map(); // "i,j" -> overlap
  for (const [, ids] of index) {
    if (ids.length < 2 || ids.length > 400) continue; // 太常见的词无区分度
    for (let a = 0; a < ids.length; a++) {
      for (let b = a + 1; b < ids.length; b++) {
        const i = ids[a];
        const j = ids[b];
        const key = i < j ? i * n + j : j * n + i;
        const sc = 1 / Math.sqrt(sentences[i].tokens.size * sentences[j].tokens.size);
        sim.set(key, (sim.get(key) || 0) + sc);
      }
    }
  }
  const adj = Array.from({ length: n }, () => []);
  for (const [key, w] of sim) {
    const i = Math.floor(key / n);
    const j = key % n;
    if (w <= 0) continue;
    adj[i].push([j, w]);
    adj[j].push([i, w]);
  }
  const outSum = adj.map((list) => list.reduce((s, [, w]) => s + w, 0));
  let cur = new Array(n).fill(1);
  for (let it = 0; it < iterations; it++) {
    const next = new Array(n).fill(1 - damping);
    for (let i = 0; i < n; i++) {
      if (!outSum[i]) continue;
      const share = (damping * cur[i]) / outSum[i];
      for (const [j, w] of adj[i]) next[j] += share * w;
    }
    let diff = 0;
    for (let i = 0; i < n; i++) diff += Math.abs(next[i] - cur[i]);
    cur = next;
    if (diff < tol) break;
  }
  return cur;
}

/* ========================= 关键词抽取 ========================= */
/**
 * 无词典的关键短语抽取（「新词发现」思路）：
 *   score = freq^0.62 × 逆句频 × 长度权重 × 边界自由度
 * 边界自由度 = 该候选词左右两侧出现过多少种不同字（熵）。
 * 真正的词左右邻居千变万化，而切错的碎片邻居高度固定，
 * 这一项能干净地滤掉「叉树的 / 代码就 / 间复杂」这类噪声。
 */
export function extractKeywords(sentences, topK = 20, opt = {}) {
  const minFreq = opt.minFreq ?? 2;
  const useEntropy = opt.useEntropy ?? true;
  const maxLen = opt.maxLen ?? 6;
  const N = Math.max(1, sentences.length);
  const stats = new Map();
  const ensure = (t) => {
    let st = stats.get(t);
    if (!st) {
      st = { freq: 0, df: 0, left: new Map(), right: new Map(), firstAt: 0 };
      stats.set(t, st);
    }
    return st;
  };

  sentences.forEach((s, si) => {
    const text = s.text;
    const seen = new Set();
    for (const m of text.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
      const run = m[0];
      for (let len = 2; len <= maxLen; len++) {
        for (let i = 0; i + len <= run.length; i++) {
          const term = run.slice(i, i + len);
          const st = ensure(term);
          st.freq++;
          if (!st.firstAt && si) st.firstAt = si;
          st.left.set(i > 0 ? run[i - 1] : '^', (st.left.get(i > 0 ? run[i - 1] : '^') || 0) + 1);
          const r = i + len < run.length ? run[i + len] : '$';
          st.right.set(r, (st.right.get(r) || 0) + 1);
          if (!seen.has(term)) {
            seen.add(term);
            st.df++;
          }
        }
      }
    }
    for (const m of text.toLowerCase().matchAll(/[a-z][a-z0-9-]{2,}/g)) {
      const w = m[0];
      if (EN_STOP.has(w)) continue;
      const st = ensure(w);
      st.freq++;
      if (!seen.has(w)) {
        seen.add(w);
        st.df++;
      }
    }
  });

  const entropy = (map) => {
    let tot = 0;
    for (const v of map.values()) tot += v;
    let h = 0;
    for (const v of map.values()) {
      const p = v / tot;
      h -= p * Math.log(p);
    }
    return h;
  };

  // 「能否独立成词」：若某个候选的绝大多数出现都是在更长词的一段里，
  // 它多半是被切碎的片段（如「间复杂度」其实属于「时间复杂度/空间复杂度」）。
  // rightMax[T] = max freq(T + 任意一字)，leftMax[T] 同理。
  const rightMax = new Map();
  const leftMax = new Map();
  for (const [term, st] of stats) {
    if (term.length < 3 || !isCJK(term[0])) continue;
    const p = term.slice(0, -1);
    const s = term.slice(1);
    if ((rightMax.get(p) || 0) < st.freq) rightMax.set(p, st.freq);
    if ((leftMax.get(s) || 0) < st.freq) leftMax.set(s, st.freq);
  }

  const scored = [];
  for (const [term, st] of stats) {
    if (st.freq < minFreq) continue;
    const cjk = isCJK(term[0]);
    if (cjk) {
      if (term.length > maxLen) continue;
      if (FUNC_CHARS.has(term[0]) || FUNC_CHARS.has(term[term.length - 1])) continue;
      // 中间夹着谓词/虚词的多半是半句话而不是术语，如「顺序是左」「子不为空就入」
      if (KW_REJECT_RE.test(term)) continue;
      if (ZH_STOP.has(term)) continue;
    }
    const isf = Math.log(1 + N / st.df);
    const lenW = term.length === 2 ? 0.9 : term.length === 3 ? 1.18 : term.length <= 5 ? 1.08 : 1.0;
    let bFactor = 1;
    let sFactor = 1;
    if (cjk) {
      if (useEntropy) {
        const minH = Math.min(entropy(st.left), entropy(st.right));
        bFactor = 0.28 + 0.72 * Math.min(1, minH / 1.15);
      }
      if (term.length < maxLen) {
        const ext = Math.max(rightMax.get(term) || 0, leftMax.get(term) || 0);
        const ratio = Math.max(0, 1 - ext / st.freq);
        sFactor = 0.15 + 0.85 * Math.pow(ratio, 1.2);
      }
    }
    scored.push({
      term,
      score: Math.pow(st.freq, 0.62) * isf * lenW * bFactor * sFactor,
      count: st.freq,
      firstAt: st.firstAt,
    });
  }
  scored.sort((a, b) => b.score - a.score);

  // 冗余过滤：已选词与候选词互为子串时，保留分数更高的那个
  const picked = [];
  for (const c of scored) {
    if (picked.length >= topK) break;
    if (picked.some((p) => p.term.includes(c.term) || c.term.includes(p.term))) continue;
    picked.push(c);
  }
  return picked;
}

/* ========================= 主题分段 ========================= */

/**
 * 主题标题的黑名单。
 *
 * 为什么必须要有：旧版 topicHeading() 取块内词频最高的两个词，用「 · 」拼起来，
 * 一旦块内没有「出现 2 次以上」的词，就会退到 minFreq:1，把「课这上说了突」
 * 「挑两孩子」「品他的一个乐」这类被切碎的语音片段当标题 —— 实测 9 分钟的课
 * 能切出 26 个这种标题。下面这些词是实测中反复冒出来的话语标记和空泛词，
 * 命中就直接不作为标题候选。
 */
const HEADING_STOP = new Set(
  (
    '一方面 另一方面 同时 时候 这样 那样 那么 这么 什么 怎么 起来 出来 一点 一些 事情 东西 地方 问题 情况 内容 结果 原因 方法 方式 感觉 ' +
    '意思 就是说 也就是说 大家 我们 你们 他们 同学 老师 今天 明天 现在 以后 之前 之后 当然 其实 所以 但是 可是 而且 然后 因为 如果 ' +
    '虽然 只是 就是 还是 或者 以及 并且 这些 那些 有点 真的 非常 特别 十分 比较 稍微 可能 也许 大概 差不多 一定 必须 能够 不能 不会 ' +
    '不要 已经 正在 马上 立刻 一直 总是 经常 有时 偶尔 从来 曾经 里面 外面 上面 下面 前面 后面 左边 右边 中间 这里 那里 哪里 多少 ' +
    '过程 方面 样子 整个 全部 主要 基本 一般 通常 往往 常常 普遍 具体 实际 相对 相当 极其 尤其 甚至 简直 几乎 反正 到底 究竟 居然 ' +
    '竟然 果然 难道 宁可 不仅 不但 而是 因而 从而 以至 乃至 大学 人生 工作 生活 国家 社会 精神 一个 两个 这个 那个 的话 看看 知道 ' +
    '觉得 认为 发现 出现 进行 具有 存在 包括 包含 属于 成为 作为 通过 根据 按照 针对 简单 当时 当中 值得 咱们 人家 一样 部分 应该 ' +
    '需要 来说 而言 多么 如何 是否 仍然 依然 继续 开始 结束 第一 第二 第三 第四 最后 首先 其次 此外 另外 例如 比如 由于 因此 于是 ' +
    '后来 昨天 目前 太多 理学 课我们讲 种遍历方式 的时候 这种 那种 哪些 为什么 怎么办 怎么样 大家一 来一 可以看 先看 直接 表示为 ' +
    '时至今日 后边 前边 旁边 里边 外边 做一 搞一 弄一 说一下 讲一下 我们看 大家看 你想想 确定 一次 一项 一下子 是不是 对不对 有没有 几个 很多 一些 下来 上去 过来 过去 没事 有意思 不过 也是 都是'
  )
    .split(/\s+/)
    .filter(Boolean)
);

/** 单字 / 介词开头 / 虚词密集的片段，几乎一定是切碎的 n-gram，不当标题 */
const HEADING_BAD_START = /^[一二三四五六七八九十百千万亿两几很多半这那什么怎么]/;
const HEADING_BAD_CHAR = /[的了是在和就都也很到说要会着把被对从而则又再才更最个这那有些们好呢吧吗啊呀哦嗯我你他它与及等为于其之但是而且因为所以如果就是还是或者]/;

/**
 * 目标主题数：按总时长定，夹在 [3, 10]。
 *
 * 用平方根而不是线性（旧版按「每 110 秒一个」）：线性会让 9 分钟课出 5 段、
 * 11 分钟出 6 段，太碎；平方根在短课上收敛得快、长课上慢慢涨：
 *   9 分钟 → 4 段，11.5 分钟 → 4 段，39 分钟 → 10 段，88 分钟 → 10 段。
 */
export function topicCount(durationSec) {
  const dur = Math.max(0, Number(durationSec) || 0);
  return Math.min(10, Math.max(3, Math.round(1.5 + Math.sqrt(dur / 90))));
}

/**
 * 用动态规划把句子序列切成 K 段，而不是逐句判断「这里像不像断点」。
 *
 * 为什么换掉旧算法：旧版 `if (i - last < 5) continue;` 意味着每 5 句就有机会
 * 切一刀，逐字稿一碎（云端 ASR 不返回标点、句子被切得很短）就会切出几十段，
 * 每段 3-8 句语义根本不连贯，后面任何起标题的算法都救不回来。
 *
 * 切点代价 = 衔接度低谷分 + 结构性提示词调整：
 *   - 和前两句重合度越低，越像新话题（0.5 - cohesion）
 *   - 重合度极低（<0.12）再加一点，鼓励在明显断开处切
 *   - 句首出现「接下来 / 下面 / 关于…问题」加 0.22（TOPIC_MARKERS）
 *   - 句首出现「第二，」「其次」这类分条续接词减 0.30，别把列举切开
 * 段长方面：过短的段重罚，明显短于平均段的轻罚，再给一个「块数均匀」的先验。
 */
export function segmentTopics(sentences, globalKeywords) {
  const n = sentences.length;
  if (!n) return [];
  if (n <= 4) return [{ startIdx: 0, endIdx: n - 1 }];

  const cohesion = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    let back = 0;
    for (let k = Math.max(0, i - 2); k < i; k++) back = Math.max(back, overlap(sentences[i].tokens, sentences[k].tokens));
    cohesion[i] = back;
  }

  const K = topicCount(sentences[n - 1].end - sentences[0].start);
  if (n < K * 3) return [{ startIdx: 0, endIdx: n - 1 }];

  const cut = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    cut[i] = Math.max(0, 0.5 - cohesion[i]) + (cohesion[i] < 0.12 ? 0.16 : 0);
    if (TOPIC_MARKERS.test(sentences[i].text)) cut[i] += 0.22;
    if (CONTINUATION_RE.test(sentences[i].text)) cut[i] -= 0.3;
  }

  const dur = sentences[n - 1].end - sentences[0].start;
  const idealSec = dur / K;
  const minSent = Math.max(2, Math.floor(n / (K * 2.5)));
  const maxSent = Math.max(minSent + 1, Math.ceil((n / K) * 2.5));
  const minSec = Math.max(20, idealSec * 0.4);
  const NEG = -1e9;
  const best = Array.from({ length: K }, () => new Array(n).fill(NEG));
  const from = Array.from({ length: K }, () => new Array(n).fill(-1));
  best[0][0] = 0;
  for (let k = 1; k < K; k++) {
    const ideal = Math.round((n * k) / K);
    for (let i = 1; i < n; i++) {
      const lo = Math.max(k - 1, i - maxSent);
      for (let j = lo; j <= i - minSent; j++) {
        if (best[k - 1][j] === NEG) continue;
        const sec = sentences[i - 1].end - sentences[j].start;
        let pen = (0.1 * Math.abs(i - ideal)) / n;
        if (sec < minSec) pen += 2.0;
        else if (sec < idealSec * 0.55) pen += 0.5;
        const v = best[k - 1][j] + cut[i] - pen;
        if (v > best[k][i]) {
          best[k][i] = v;
          from[k][i] = j;
        }
      }
    }
  }
  let bv = NEG;
  let bi = -1;
  for (let i = K - 1; i < n; i++) {
    if (n - i < minSent) continue;
    if (sentences[n - 1].end - sentences[i].start < minSec) continue;
    if (best[K - 1][i] > bv) {
      bv = best[K - 1][i];
      bi = i;
    }
  }
  if (bi < 0) return [{ startIdx: 0, endIdx: n - 1 }];

  const cuts = [];
  let k = K - 1;
  let i = bi;
  while (k > 0) {
    cuts.push(i);
    i = from[k][i];
    k--;
  }
  cuts.sort((a, b) => a - b);
  const bounds = [0, ...cuts];
  const out = [];
  for (let x = 0; x < bounds.length; x++) {
    const s = bounds[x];
    const e = x + 1 < bounds.length ? bounds[x + 1] - 1 : n - 1;
    out.push({ startIdx: s, endIdx: e });
  }
  return out;
}

/**
 * 给一个主题起标题：从全局关键词里挑「在这个块里覆盖得又多又密」的两个词。
 *
 * 关键取舍：宁可返回空串（由调用方退成「第 N 部分」），也不吐碎片。
 * 实测过：拿块内 minFreq:1 的局部词兜底，会产出「需要进一步证」
 * 「网民地步与身体死亡」这种明显是切碎语音的标题。
 */
function topicHeading(blockSentences, globalKeywords, used) {
  if (!blockSentences || !blockSentences.length) return '';
  const sents = blockSentences.map((s) => s.text);
  const text = sents.join('');
  const textLen = Math.max(1, text.length);
  const candidates = [];
  for (const k of globalKeywords || []) {
    const t = k.term;
    if (!t || t.length < 2 || t.length > 6) continue;
    if (HEADING_STOP.has(t)) continue;
    // 首字是数字/指示词的两字词几乎一定是碎片（第一、一点、这样、几遍）。
    // 但三字以上通常是真名词 —— 实测「三角形」在工程制图里 cov=9、打分全场第一，
    // 却被这条正则当成分条序号挡掉，导致连续两块都起不出标题。所以只对两字词生效。
    if ((t.length <= 2 && HEADING_BAD_START.test(t)) || HEADING_BAD_CHAR.test(t)) continue;
    let cov = 0;
    for (const s of sents) if (s.includes(t)) cov++;
    if (!cov) continue;
    const covRatio = cov / sents.length;
    const density = ((text.split(t).length - 1) * Math.max(1, t.length)) / textLen;
    let v = Math.pow(covRatio, 0.7) * Math.log(1 + (k.score || 1)) * (0.6 + 0.7 * density);
    v *= t.length >= 3 ? 1.3 : 0.85;
    if (used && used.has(t)) v *= 0.25;
    candidates.push({ t, cov, v });
  }
  candidates.sort((a, b) => b.v - a.v);
  // 两个门槛一起用：
  //   绝对量 cov>=2（至少在两句话里出现），和
  //   相对量 covRatio>=3%（长块里只出现两次的词基本是噪声，如「后边」「做一」）
  // 块本身只有两三句时，「至少两句」就等于「到处都是」，起不出标题 ——
  // 实测「作业是课后习题 6.3 到 6.8…」那一段就只有 2 句，结果落成「第 4 部分」。
  // 这种短块把绝对门槛降到 1：宁可标题里有点噪声，也比「第 N 部分」强。
  const minCov = blockSentences.length >= 6 ? 2 : 1;
  const need = Math.max(minCov, Math.round(blockSentences.length * 0.03));
  let enough = candidates.filter((c) => c.cov >= need && c.cov >= minCov);
  if (!enough.length) {
    // 全局词表里一个都没命中。短块上这很常见：结尾那段「作业是课后习题 6.3
    // 到 6.8……下次课我们讲」里，真正有信息量的词（作业、提交、预习）全篇
    // 只出现这一次，进不了全局词表，于是起不出标题、掉回「第 N 部分」。
    //
    // 块内重新抽词救不了它：句数太少，n-gram 打分全是任意切出来的碎片
    // （实测给出「预习一下线索」「习一下线索二」「前提交到学习」），
    // 拼成标题比「第 N 部分」更难看。这里改用**线索类别**当标题 ——
    // 这类短段本来就是「作业安排 / 考点提示」这种功能性收尾。
    const label = cueLabelFor(blockSentences);
    if (label) {
      if (used) used.add(label);
      return label;
    }
  }
  if (!enough.length) return '';
  // 优先用没在前几段出现过的词，否则连着几段都叫「垂直」
  let fresh = enough.filter((c) => !used || !used.has(c.t));
  if (!fresh.length) {
    // 全用过了：把相对门槛降回最短要求，尽量找出新词，
    // 实在没有才允许重复（重复总比「第 9 部分」有信息量）
    enough = candidates.filter((c) => c.cov >= minCov);
    fresh = enough.filter((c) => !used || !used.has(c.t));
    if (!fresh.length) fresh = enough;
  }
  const ok = fresh;
  const picked = [];
  for (const c of ok) {
    if (picked.length >= 2) break;
    if (picked.some((p) => p.t.includes(c.t) || c.t.includes(p.t))) continue;
    // 第二个词明显比第一个弱就只要一个，别硬凑「A与B」
    if (picked.length === 1 && c.v < picked[0].v * 0.6) break;
    if (picked.length === 1 && picked[0].t.length + c.t.length > 10) break;
    picked.push(c);
  }
  if (!picked.length) return '';
  for (const p of picked) if (used) used.add(p.t);
  return picked.map((p) => p.t).join('与');
}

/* ====================== 重点句打分与挑选 ====================== */

/**
 * 起不出标题的短段，按它属于哪类功能性内容给个通用名字。
 *
 * 为什么这么做：课程结尾那两句话（作业是什么、下次讲什么、下课）里没有
 * 反复出现的关键词，任何词频算法都只能给出碎片。但它**是什么性质的段落**
 * 是一眼就能认的 —— 与其硬凑「预习一下线索」，不如老老实实叫「作业与下节预告」。
 * 只在关键词彻底起不出名字时才走这条路，不影响正常段落。
 */
const CUE_LABELS = [
  { label: '作业与下节预告', re: /(作业|提交|截止|deadline|预习|下次课|下节课|下周三|下周|交到|学习通|报告|实验)/ },
  { label: '考试与复习提示', re: /(考点|考试|必考|复习|重点掌握|背下来|会考|期末|期中|平时分|分数)/ },
  { label: '课堂小结', re: /(总结|综上|总之|今天就到这里|下课|回顾一下|我们讲了)/ },
  { label: '课堂提问与互动', re: /(提问|请同学|谁来回答|想一想|大家想|讨论一下|举手)/ },
];

function cueLabelFor(blockSentences) {
  const text = blockSentences.map((s) => s.text).join('');
  for (const c of CUE_LABELS) if (c.re.test(text)) return c.label;
  return '';
}

function cueScore(text) {
  let s = 0;
  for (const r of CUE_RULES) if (r.re.test(text)) s += r.w;
  return s;
}

/**
 * 解释一句话为什么被（或没被）当成重点：命中了哪些线索词规则、各加多少分。
 * 用来排查「为什么这句没被选中」，也可以在前端做调试视图。
 */
export function explainCue(text) {
  const hits = [];
  for (const r of CUE_RULES) {
    if (r.re.test(text)) hits.push({ label: r.label, w: r.w });
  }
  return { score: +cueScore(text).toFixed(2), hits };
}

function pickKeyPoints(sentences, idxRange, rankScores, keywords, maxPoints) {
  const kwTerms = keywords.map((k) => k.term);
  const { startIdx, endIdx } = idxRange;
  const span = endIdx - startIdx + 1;
  const cands = [];
  for (let i = startIdx; i <= endIdx; i++) {
    const s = sentences[i];
    const len = s.text.replace(/\s/g, '').length;
    if (len < 8) continue; // 太短的口语碎片
    const rank = rankScores[i] || 0;
    const cue = cueScore(s.text);
    let kwHit = 0;
    for (const t of kwTerms) if (t && s.text.includes(t)) kwHit += t.length >= 3 ? 1.2 : 1;
    const lenW = len > 120 ? 0.75 : len > 90 ? 0.9 : 1;
    const posW = 1 + 0.12 * (1 - (i - startIdx) / Math.max(1, span - 1)); // 略偏好段首
    const score = (Math.log1p(rank) * 1.5 + cue + kwHit * 0.55) * lenW * posW;
    cands.push({ i, score, text: s.text, start: s.start, end: s.end });
  }
  cands.sort((a, b) => b.score - a.score);
  const chosen = [];
  for (const c of cands) {
    if (chosen.length >= maxPoints) break;
    // 冗余惩罚：与已选句子太像就跳过
    if (chosen.some((p) => overlap(tokens(p.text), tokens(c.text)) > 0.52)) continue;
    chosen.push(c);
  }
  chosen.sort((a, b) => a.i - b.i); // 还原时间顺序
  return chosen;
}

/* ========================= 结构化信息抽取 ========================= */

const TERM_BODY = '[\u4e00-\u9fffA-Za-z][\u4e00-\u9fffA-Za-z0-9]{1,11}';
const DEF_PATTERNS = [
  // 「所谓 X，是指 Y」/「X 是指 Y」/「X 称为 Y」
  new RegExp(`(?:所谓|那么|这里)?[「“"]?(${TERM_BODY})[」”"]?\\s*[，,]?\\s*(?:是指|指的是|定义为|被定义为|称为|叫做|又叫|又称|简称|是一种|是一个|属于|即为)([^。！？!?]{6,160})`),
  // 「所谓 X，Y」
  new RegExp(`(?:所谓|那么)[「“"]?(${TERM_BODY})[」”"]?\\s*[，,：:]\\s*([^。！？!?]{8,160})`),
  // 「X 的定义/概念/含义 是 Y」
  /([\u4e00-\u9fffA-Za-z][\u4e00-\u9fffA-Za-z0-9]{1,11})(?:的)?(?:定义|概念|含义)(?:是|就是|为|：|:)([^。！？!?]{6,160})/,
  // 英文
  /([A-Za-z][A-Za-z0-9 \-]{2,40})\s+(?:is|are|refers to|means|is defined as)\s+([^.!?]{10,160})/i,
];

/** 谓词/虚词字符：出现在术语中间，说明这压根不是一个概念名，而是半句话 */
const PREDICATE_CHARS = new Set('有是会要能可应很都也就才把被让使给又再更最不没来去说想做觉得'.split(''));

/** 术语是否像「一个概念」而不是半个句子 */
function looksLikeTerm(term) {
  if (!term || term.length < 2 || term.length > 14) return false;
  if (/[。！？!?，,、；;：:（）()「」“”"'\s]/.test(term)) return false;
  if (FUNC_CHARS.has(term[0])) return false;
  if (ZH_STOP.has(term)) return false;
  for (const ch of term) if (PREDICATE_CHARS.has(ch)) return false;
  if (/^(这个|那个|我们|大家|老师|同学|今天|下面|接下来|首先|然后|最后|所以|因此|其中)/.test(term)) return false;
  return true;
}

export function extractDefinitions(sentences) {
  const out = [];
  const seen = new Set();
  for (const s of sentences) {
    for (const re of DEF_PATTERNS) {
      const m = s.text.match(re);
      if (!m) continue;
      const term = m[1].replace(/^[的地得了]/, '').trim();
      if (!looksLikeTerm(term)) continue;
      if (seen.has(term)) break;
      seen.add(term);
      out.push({
        term,
        definition: m[2].trim().replace(/^[，,：:、\s]+/, ''),
        start: s.start,
        text: s.text,
      });
      break;
    }
  }
  return out.slice(0, 40);
}

const CUE_GROUPS = [
  { key: 'exam', label: '考点 / 考试相关', re: /(考点|必考|考试|会考|考这个|期末|期中|平时分|分数|重点掌握|重点内容|划重点|记住了|记下来|记一下)/ },
  { key: 'emphasis', label: '老师强调', re: /(重点是|关键是|核心是|最重要的是|主要在于|强调|注意|千万|务必|一定要|不要忘|容易错|易错|区别在于)/ },
  { key: 'summary', label: '总结 / 结论', re: /(综上|总之|总结一下|归纳|因此|所以|由此可见|结论是|可见|说明)/ },
  { key: 'example', label: '例子 / 案例', re: /(例如|比如|举例|举个例子|比方说|以.{1,12}为例|案例|实例)/ },
  { key: 'task', label: '作业 / 任务 / 安排', re: /(作业|提交|截止|deadline|下节课|下次课|预习|复习|小组|报告|论文|实验|阅读|练习|考试时间|答疑)/ },
];

export function extractCueLines(sentences) {
  const buckets = Object.fromEntries(CUE_GROUPS.map((g) => [g.key, { label: g.label, items: [] }]));
  for (const s of sentences) {
    const len = s.text.replace(/\s/g, '').length;
    if (len < 6 || len > 200) continue;
    for (const g of CUE_GROUPS) {
      if (!g.re.test(s.text)) continue;
      const b = buckets[g.key];
      if (b.items.length >= 12) break;
      if (b.items.some((it) => overlap(tokens(it.text), tokens(s.text)) > 0.5)) break;
      b.items.push({ text: s.text, start: s.start, end: s.end });
      break; // 一句只归一类，避免刷屏
    }
  }
  return CUE_GROUPS.map((g) => buckets[g.key]).filter((b) => b.items.length);
}

const ENUM_SPLIT = /(?=(?:第[一二三四五六七八九十]+[，,、:：]|其[一二三四五六七八九十][，,、:：]?|首先|其次|再次|然后|接着|最后[，,：:]|一是|二是|三是|四是|五是|一方面|另一方面|①|②|③|④|\d+[.、)）]\s))/;

export function extractEnumerations(sentences) {
  const out = [];
  for (const s of sentences) {
    const parts = s.text
      .split(ENUM_SPLIT)
      .map((p) => p.trim())
      .filter((p) => p.replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '').length >= 4);
    const markers = parts.filter((p) => /^(第[一二三四五六七八九十]+|其[一二三四五六七八九十]|首先|其次|再次|然后|接着|最后|一是|二是|三是|四是|五是|一方面|另一方面|[①②③④]|\d+[.、)）])/.test(p));
    if (markers.length >= 2) {
      out.push({ text: s.text, items: markers.map((m) => m.replace(/^[，,、:：\s]+/, '')), start: s.start });
    }
    if (out.length >= 15) break;
  }
  return out;
}

/* ======================= 复习问题生成 ======================= */

export function generateQuestions(keyPoints, definitions, keywords) {
  const qs = [];
  const push = (q, start) => {
    if (q.length < 6 || qs.some((x) => x.q === q)) return;
    qs.push({ q, start });
  };
  for (const d of definitions.slice(0, 8)) push(`「${d.term}」的定义或含义是什么？`, d.start);
  // 只从「像重点」的句子里出题：要有线索词、或命中高频关键词、且不能是纯过渡句
  const good = keyPoints.filter((p) => {
    const len = p.text.replace(/\s/g, '').length;
    if (len < 12) return false;
    if (/^(好|那么|接下来|下面|我们|大家|今天|上节课|最后)/.test(p.text) && len < 26) return false;
    const kwHit = keywords.slice(0, 14).some((k) => p.text.includes(k.term));
    return cueScore(p.text) > 0.8 || kwHit;
  });
  for (const p of good.slice(0, 12)) {
    const t = p.text;
    const m = t.match(/([\u4e00-\u9fffA-Za-z][\u4e00-\u9fffA-Za-z0-9]{1,10}?)(?:是指|指的是|定义为|称为|叫做)/);
    if (m && looksLikeTerm(m[1])) {
      push(`什么是「${m[1]}」？`, p.start);
      continue;
    }
    const kw = keywords.find((k) => t.includes(k.term) && k.count >= 2);
    if (/(第一|第二|首先|其次|一是|二是|包括|分为|主要有)/.test(t)) {
      push(`${kw ? `「${kw.term}」` : '这一段'}包含哪几个要点？请分条列举。`, p.start);
      continue;
    }
    if (/(因为|由于|导致|所以|因此|原因|机制)/.test(t)) {
      push(`${kw ? `「${kw.term}」` : '该内容'}的原因或机制是什么？`, p.start);
      continue;
    }
    if (/(区别|不同|相比|对比)/.test(t)) {
      push(`${kw ? `「${kw.term}」` : '两者'}之间的区别是什么？`, p.start);
      continue;
    }
    if (kw) {
      const brief = t.length > 40 ? t.slice(0, 40) + '…' : t;
      push(`关于「${kw.term}」，老师讲了什么？（提示：${brief}）`, p.start);
    }
  }
  return qs.slice(0, 14);
}

/* ========================= 摘要与统计 ========================= */

function oneLineSummary(sentences, rankScores, keywords) {
  if (!sentences.length) return '';
  const scored = sentences.map((s, i) => {
    const len = s.text.replace(/\s/g, '').length;
    // 概要句：偏好 16~70 字、含高频词、且靠前的句子
    const lenPref = len < 16 ? 0.5 : len <= 70 ? 1.2 : len <= 110 ? 0.9 : 0.55;
    const kwHit = keywords.slice(0, 12).reduce((n, k) => n + (s.text.includes(k.term) ? 1 : 0), 0);
    const posPref = 1 + 0.35 * (1 - i / Math.max(1, sentences.length - 1));
    return { i, s, v: (rankScores[i] || 0) * lenPref * posPref + kwHit * 0.45 + cueScore(s.text) * 0.15 };
  });
  scored.sort((a, b) => b.v - a.v);
  const top = scored.slice(0, 2).sort((a, b) => a.i - b.i);
  return top.map((x) => x.s.text.replace(/[。；;，,]$/, '')).join('；') + '。';
}

/* ============================ 主入口 ============================ */

/**
 * @param {object} opts
 * @param {Array}  opts.segments  转写片段 [{start,end,text}]
 * @param {object} opts.meta      {title, course, date, duration, engine, model, language}
 * @param {object} opts.options   {style, maxPointsPerTopic, topKeywords, title, course}
 * @returns {object} note
 */
/**
 * 「自适应」的重点条数：一个主题里取几条重点，由这个主题有多少句决定。
 *
 * 为什么不是固定条数：一段 226 句的大块只挑 6 条，等于每 38 句留一条，
 * 中间全丢了；一段 8 句的小块挑 6 条，又几乎整段抄下来，重点就不算重点了。
 * 用对数是因为「信息量」跟不上句子数线性增长 —— 翻倍的篇幅不需要翻倍的重点。
 *   n=4 → 2 条    n=10 → 4 条    n=20 → 5 条    n=50 → 7 条    n≥100 → 8 条
 * 上下夹在 [2, 8]：1 条不像提纲，9 条以上不如直接看逐字稿。
 */
function autoPoints(sentenceCount) {
  const n = Math.max(1, Number(sentenceCount) || 0);
  return Math.min(8, Math.max(2, Math.round(Math.log2(n) * 1.2)));
}

export function analyze({ segments, meta = {}, options = {} } = {}) {
  const opt = { style: 'exam', maxPointsPerTopic: 6, topKeywords: 20, ...options };
  const { sentences, hasTime } = toSentences(segments);
  if (!sentences.length) {
    return { ok: false, error: '转写内容为空，无法生成笔记。', markdown: '', outline: [], keywords: [] };
  }
  const rankScores = textRank(sentences);
  const keywords = extractKeywords(sentences, opt.topKeywords);
  // 起标题用的候选池要比关键词表宽：20 个词给 10 个主题分，必然重名。
  // 多抽一批只用于标题，不影响「关键词」小节的展示数量。
  const headingPool = opt.topKeywords >= 40 ? keywords : extractKeywords(sentences, Math.max(40, opt.topKeywords * 2));
  const blocks = segmentTopics(sentences, keywords);
  const globalRankTop = sentences
    .map((s, i) => ({ i, v: rankScores[i] }))
    .sort((a, b) => b.v - a.v)
    .slice(0, Math.max(1, Math.round(sentences.length * 0.15)))
    .map((x) => x.i);
  const globalKey = pickKeyPoints(sentences, { startIdx: 0, endIdx: sentences.length - 1 }, rankScores, keywords, 8);

  // 跨块共用一个 used，避免连续几段都叫「美国」「乐观」
  const usedHeadings = new Set();
  const outline = blocks.map((b, bi) => {
    const blockSents = sentences.slice(b.startIdx, b.endIdx + 1);
    // maxPointsPerTopic = 0 表示「自适应」（界面上的「自适应」那一档）：
    // 让条数跟着块的大小走，而不是所有块都挤成同样的几条。
    const wantPoints = opt.maxPointsPerTopic > 0 ? opt.maxPointsPerTopic : autoPoints(blockSents.length);
    const points = pickKeyPoints(sentences, b, rankScores, keywords, wantPoints);
    return {
      index: bi + 1,
      heading: topicHeading(blockSents, headingPool, usedHeadings) || `第 ${bi + 1} 部分`,
      start: blockSents[0]?.start ?? 0,
      end: blockSents[blockSents.length - 1]?.end ?? 0,
      sentenceCount: blockSents.length,
      points,
      maxPoints: wantPoints,
      localKeywords: extractKeywords(blockSents, 8).map((k) => k.term),
      gist: blockSents[0]?.text || '',
    };
  });

  const definitions = extractDefinitions(sentences);
  const cueGroups = extractCueLines(sentences);
  const enumerations = extractEnumerations(sentences);
  const questions = generateQuestions(globalKey, definitions, keywords);
  const summary = oneLineSummary(sentences, rankScores, keywords);

  const duration = meta.duration || sentences[sentences.length - 1]?.end || 0;
  const note = {
    ok: true,
    generator: 'offline',
    style: opt.style,
    title: opt.title || meta.title || '课堂笔记',
    course: opt.course || meta.course || '',
    date: meta.date || new Date().toISOString().slice(0, 10),
    duration,
    hasTime,
    stats: {
      chars: sentences.reduce((n, s) => n + s.text.length, 0),
      sentences: sentences.length,
      topics: outline.length,
      keywords: keywords.length,
      definitions: definitions.length,
      questions: questions.length,
    },
    summary,
    outline,
    keywords,
    definitions,
    cueGroups,
    enumerations,
    questions,
    globalKeyPoints: globalKey,
    sentences,
    transcriptText: (segments || []).map((s) => s.text).join('\n'),
  };
  note.markdown = renderMarkdown(note);
  return note;
}

/* ========================= Markdown 渲染 ========================= */

export function fmtTime(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return (h ? String(h).padStart(2, '0') + ':' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

const anchor = (t) => `[${fmtTime(t)}](#t=${Number(t).toFixed(2)})`;

export function renderMarkdown(note) {
  if (!note || !note.ok) return note?.markdown || '';
  const L = [];
  const styleName = { exam: '应试重点版', outline: '提纲版', cornell: '康奈尔版' }[note.style] || '课堂笔记';
  L.push(`# ${note.title}`);
  L.push('');
  const metaBits = [];
  if (note.course) metaBits.push(`课程：${note.course}`);
  if (note.date) metaBits.push(`日期：${note.date}`);
  if (note.duration) metaBits.push(`时长：${fmtTime(note.duration)}`);
  metaBits.push(`风格：${styleName}`);
  L.push('> ' + metaBits.join(' ｜ '));
  L.push('');
  L.push(`> **一句话概要**：${note.summary}`);
  L.push('');
  L.push(
    `> 转写 ${note.stats.chars.toLocaleString('zh-CN')} 字 / ${note.stats.sentences} 句 ｜ 自动切分 ${note.stats.topics} 个主题 ｜ 提取关键词 ${note.stats.keywords} 个`
  );
  L.push('');
  L.push('---');
  L.push('');

  // 关键词
  if (note.keywords.length) {
    L.push('## 🏷️ 关键词');
    L.push('');
    L.push(note.keywords.map((k) => `\`${k.term}\`(${k.count})`).join(' · '));
    L.push('');
  }

  // 大纲 + 重点
  L.push('## 🧭 课堂脉络与重点');
  L.push('');
  if (note.style === 'cornell') {
    L.push('| 提示 / 线索 | 笔记要点 |');
    L.push('| --- | --- |');
    for (const t of note.outline) {
      const cues = t.localKeywords.slice(0, 3).join('、') || t.heading;
      const pts = t.points.map((p) => `${p.text}${note.hasTime ? ' ' + anchor(p.start) : ''}`).join('<br>');
      L.push(`| **${cues}** | **${t.heading}**<br>${pts} |`);
    }
    L.push('');
  } else {
    for (const t of note.outline) {
      L.push(`### ${t.index}. ${t.heading}${note.hasTime ? '  ' + anchor(t.start) : ''}`);
      L.push('');
      for (const p of t.points) {
        L.push(`- ${p.text}${note.hasTime ? '  ' + anchor(p.start) : ''}`);
      }
      L.push('');
    }
  }

  // 定义
  if (note.definitions.length) {
    L.push('## 📖 概念与定义');
    L.push('');
    for (const d of note.definitions) {
      L.push(`- **${d.term}**：${d.definition}${note.hasTime ? '  ' + anchor(d.start) : ''}`);
    }
    L.push('');
  }

  // 列举要点
  if (note.enumerations.length) {
    L.push('## 🔢 分条列举的内容');
    L.push('');
    for (const e of note.enumerations) {
      L.push(`- ${e.items.length > 1 ? '要点：' : ''}${e.items.map((i) => i.trim()).join(' ／ ')}${note.hasTime ? '  ' + anchor(e.start) : ''}`);
    }
    L.push('');
  }

  // 线索分组
  for (const g of note.cueGroups) {
    const icon = { exam: '🎯', emphasis: '❗', summary: '🧩', example: '💡', task: '📌' }[g.key] || '•';
    L.push(`## ${icon} ${g.label}`);
    L.push('');
    for (const it of g.items) {
      L.push(`- ${it.text}${note.hasTime ? '  ' + anchor(it.start) : ''}`);
    }
    L.push('');
  }

  // 复习问题
  if (note.questions.length) {
    L.push('## ❓ 自测题（遮住上面，试着回答）');
    L.push('');
    note.questions.forEach((q, i) => {
      L.push(`${i + 1}. ${q.q}${note.hasTime ? '  ' + anchor(q.start) : ''}`);
    });
    L.push('');
  }

  // 逐字稿
  if (note.sentences.length) {
    L.push('---');
    L.push('');
    L.push('<details>');
    L.push('<summary>📄 展开完整逐字稿（按时间轴）</summary>');
    L.push('');
    for (const s of note.sentences) {
      L.push(`${note.hasTime ? `**${anchor(s.start)}** ` : ''}${s.text}`);
      L.push('');
    }
    L.push('</details>');
    L.push('');
  }

  L.push('---');
  L.push('');
  L.push(`*由「讲义笔记 LectureNotes」自动整理生成（离线引擎）。自动提取可能有遗漏，请对照逐字稿校核。*`);
  L.push('');
  return L.join('\n');
}

export default { analyze, renderMarkdown, toSentences, extractKeywords, segmentTopics, fmtTime, splitSentences, tokens };
