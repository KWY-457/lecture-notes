/**
 * 逐字稿清洗（确定性部分，不依赖大模型，永远先跑一遍）
 * ------------------------------------------------------------------
 * Whisper 的中文输出有四个老毛病：
 *   1. 繁简混排（一句话里简体里蹦出繁体字，读起来像乱码）  ← 本文件第 5 步
 *   2. 音近错字（"遍历"写成"变力"这类，确定性规则修不了，交给大模型）
 *   3. 标点半角全角混用、重复标点、奇怪的占位符
 *   4. 偶尔漏出 <|...|> 之类的特殊 token、emoji、私有区字符
 * 本文件负责 1/3/4，2 由 llm.js 的校对步骤负责。
 *
 * ── 设计原则（改这个文件之前请先读）────────────────────────────────
 * 【原则一】繁→简用权威表，不用手写表。
 *   旧版这里是一张手写的 208 条 T2S，实测在三条真实记录上「能处理的繁体形 =
 *   0 个」—— 因为它把「回覆、高興、輕鬆」当**词**去查，可表里那三条多字词是
 *   「這個/那個/錄音」，覆/興/鬆 从来不是 key，于是原样放过。现在换成
 *   public/t2s-table.js（OpenCC TSCharacters，Apache-2.0，2965 条逐字）。
 *   那张表**全部是单字符→单字符**，所以替换后字符位置/长度严格不变，
 *   逐段的时间轴不会被破坏。
 *
 * 【原则二】不清洗 UTF-8 意义上的「乱码」，而是把非正文码位收窄到白名单。
 *   对三条真实记录做过逐码位审计：半角片假名 0 个、注音 0 个、
 *   CJK 兼容汉字 0 个、日文假名 0 个、谚文 0 个、emoji 0 个、私有区 0 个。
 *   也就是说**真实数据里根本没有编码垃圾**，用户说的「不明字符」实际是
 *   「繁简混排 + Whisper 幻觉用词」。
 *   结论：与其继续拉长「删什么」的黑名单（总有漏网），不如反过来定
 *   白名单（什么能留），其余一律兜底清掉 —— 见第 6 步。这样以后遇到
 *   任何没见过的杂符都不会漏，也不会误删正文汉字。
 *   注意：白名单**刻意保留** CJK 扩展 A（\u3400-\u4DBF），因为人名地名会用。
 *
 * 【原则三】全角 ASCII 是「能救回来的内容」，不是垃圾。
 *   全角 "ＡＢＣ１２３" 先转半角，再进白名单。直接删会把老师说的英文单词
 *   和数字抹掉。顺序必须在白名单之前。
 *
 * 【原则四】括号注释保留。
 *   记录里有 21 个全角括号，是 Whisper 自己加的注释（如「（放入冰箱）」
 *   「（字幕君）」），成对、有意义，属于「Whisper 听到的非语音声」，留着比删掉好。
 */

import { T2S_MAP } from './t2s-table.js';

/**
 * 正文白名单 —— 只有落在这个字符类里的字符才允许留在成品里。
 * 组成：
 *   \x20-\x7E  ASCII 可打印（字母数字标点空格）
 *   \u3400-\u4DBF CJK 扩展 A（少见但真实的人名地名用字，例如 㛃 㵘）
 *   \u4E00-\u9FFF CJK 基本区（正文主力）
 *   \u3000-\u303F CJK 标点（　、。〈〉《》「」『』【】〔〕）
 *   \uFF01-\uFF5E 全角 ASCII（！＂＃…～）
 *   \u2010-\u201F 破折号/弯引号（‐ – — ― ‘’“”）
 *   \u2026 省略号 …、\u00B7 间隔号 ·
 * 明确**不在**白名单里（会被兜底清掉）：
 *   半角片假名 U+FF61-FF9F、注音 U+3100-312F、CJK 兼容汉字 U+F900-FAFF、
 *   康熙部首 U+2E80-2EFF、CJK 部首补充 U+2F00-2FDF、谚文 U+AC00-D7AF、
 *   日文假名 U+3040-30FF、emoji 各区、箭头/数学/几何/杂符 U+2190-2BFF、
 *   私用区 U+E000-F8FF/U+F0000-FFFFD/U+100000-10FFFD、变体选择符 U+FE00-FE0F。
 */
const KEEP_RE = /[\x20-\x7E\u3400-\u4DBF\u4E00-\u9FFF\u3000-\u303F\uFF01-\uFF5E\u2010-\u201F\u2026\u00B7]/;

/**
 * 真正零宽的不可见字符：它们不占字宽、不显示，删掉不影响任何位置计算。
 * 注意**不要把变体选择符 U+FE00-FE0F 放进来** —— 那个交给白名单兜底，
 * 这样它会被计入 stats.dropped，调试时看得见。
 */
const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;

/**
 * CJK 部首补充 / 康熙部首 / CJK 兼容汉字 / CJK 兼容形式 —— 这些区的码位
 * 在视觉上和正常汉字几乎一样，字体不支持时显示成豆腐块，是「不明字符」的典型来源。
 * 优先尝试用 Unicode NFKC 归一到正常汉字（如 康熙部首 ⾔ -> 言、兼容汉字 神 -> 神），
 * 归一失败的才交给白名单兜底清掉。
 */
const NORMALIZE_RE = /[\u2E80-\u2FDF\uF900-\uFAFF\uFE30-\uFE4F]/;

/** 半角标点 → 全角（中文习惯） */
const HALF_TO_FULL = {
  ',': '，', '!': '！', '?': '？', ';': '；', ':': '：', '(': '（', ')': '）',
};

/** 清洗统计，每次 cleanLine 用 stats 参数传入就累加，不传就不记 */
export function emptyStats() {
  return {
    simplified: 0,     // 繁→简替换字数
    normalized: 0,     // 部首/兼容汉字归一化字数
    dropped: 0,        // 被白名单兜底清掉的字符数
    droppedChars: {},  // 去掉的字符 -> 次数（看看到底删了什么，别再靠猜）
    punctuation: 0,    // 半角标点转全角次数
    collapsed: 0,      // 折叠重复循环删掉的字数
  };
}

/**
 * 确定性清洗一行文字：繁→简、非正文收窄、半角标点转全角、合并重复标点、规范空格。
 * 不改变语义，也不纠正音近错字（那是大模型的活）。
 * @param {string} text
 * @param {object} [stats] 传入 emptyStats() 的结果就会累加统计（可选）
 */
export function cleanLine(text, stats) {
  let s = String(text || '');

  // 1. 去掉 Whisper 可能漏出的特殊 token 和占位符
  s = s.replace(/<\|[^>]*\|>/g, '');
  s = s.replace(/\[(BLANK_AUDIO|INAUDIBLE|MUSIC|APPLAUSE|LAUGHTER)\]/gi, '');

  // 2. 零宽字符与变体选择符：删掉不影响任何位置计算（它们本来就不该占字宽）
  s = s.replace(ZERO_WIDTH_RE, '');

  // 3. 部首/兼容汉字先做 NFKC 归一化，能救回正文的救回正文
  //    （康熙部首 ⾔ -> 言、CJK 兼容汉字 神 -> 神）
  if (NORMALIZE_RE.test(s)) {
    s = s.replace(/[\u2E80-\u2FDF\uF900-\uFAFF\uFE30-\uFE4F]/gu, (ch) => {
      const n = ch.normalize('NFKC');
      if (n !== ch) { if (stats) stats.normalized++; return n; }
      return ch; // 归不了的交下一步白名单兜底
    });
  }

  // 4. 全角 ASCII 转半角（救回英文单词与数字，必须在白名单之前）
  if (/[\uFF01-\uFF5E]/.test(s)) {
    s = s.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  }

  // 5. 繁→简（权威表，逐字 1:1，长度严格不变）
  s = s.replace(/[\u3400-\u9FFF]/g, (ch) => {
    const v = T2S_MAP.get(ch);
    if (v === undefined || v === ch) return ch;
    if (stats) stats.simplified++;
    return v;
  });

  // 6. 半角标点转全角（数字间的小数点先保护起来）
  const beforePunct = s;
  s = s.replace(/(\d)[.,](\d)/g, '$1\u00B7$2');
  s = s.replace(/[,!?;:()]/g, (m) => HALF_TO_FULL[m] || m);
  s = s.replace(/(?<![\d])\.(?!\d)/g, '。'); // 单独的小数点才转句号
  s = s.replace(/(\d)\u00B7(\d)/g, '$1.$2');
  if (stats && s !== beforePunct) stats.punctuation++;

  // 7. 白名单兜底：非正文码位清掉。
  //    用「替换成空」而不是「替换成空格」，避免把一个词劈成两半后又留下空格；
  //    空格问题交给第 9 步统一处理。
  s = s.replace(/./gu, (ch) => {
    if (KEEP_RE.test(ch)) return ch;
    if (ch === '\n' || ch === '\r' || ch === '\t') return ' ';
    if (stats) {
      stats.dropped++;
      stats.droppedChars[ch] = (stats.droppedChars[ch] || 0) + 1;
    }
    return '';
  });

  // 8. 合并重复标点；去句首杂标点；句尾只去非终止标点，保留 。！？ 作为句子结尾
  s = s.replace(/([，。！？；：、])[，。！？；：、]+/g, '$1');
  s = s.replace(/^[，。、；：！？\s]+/, '');
  s = s.replace(/[，、；：]+$/, '');

  // 9. 去掉中文字之间的空格、多余空格
  s = s.replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '$1');
  s = s.replace(/\s{2,}/g, ' ');

  // 10. 省略号统一
  s = s.replace(/…{2,}|\.{3,}/g, '…');

  // 11. 折叠重复循环（幻觉治理的关键一步）
  const beforeCollapse = s;
  s = collapseRepetition(s);
  if (stats) stats.collapsed += Math.max(0, beforeCollapse.length - s.length);

  return s.trim();
}

/**
 * 折叠重复循环 —— Whisper 幻觉最典型的形态。
 * 「这个地方，这个地方，这个地方…」→「这个地方」
 * 「形形形形形形」→「形」
 * 「还有一个还有一个还有一个」→「还有一个」
 */
export function collapseRepetition(text) {
  let s = String(text || '');
  let prev = null;
  let guard = 0;
  while (prev !== s && guard++ < 8) {
    prev = s;
    // a) 单字连续重复：「形形形形形」→「形」
    s = s.replace(/([\s\S])\1{2,}/g, '$1');
    // b) 短语连续重复，允许中间夹着标点：
    //    「这个地方，这个地方，这个地方。」→「这个地方。」
    s = s.replace(/([\s\S]{2,24}?)(?:[，,、；;]?\1){2,}/g, '$1');
  }
  s = s.replace(/([，。、；：！？])\1+/g, '$1');
  return s;
}

/**
 * 幻觉/不可信程度打分（0~1）：用于标记「这段很可能不是老师真说的话」。
 * 依据：内部重复率、语速是否离谱、是否超长无句读、单字占比是否异常。
 * 注意：要拿**原始识别结果**来算 —— 折叠之后就看不出幻觉了。
 */
export function hallucinationScore(text, durationSec) {
  const t = String(text || '');
  if (!t) return 0;
  let score = 0;
  const grams = new Map();
  for (let i = 0; i + 3 <= t.length; i++) {
    const g = t.slice(i, i + 3);
    grams.set(g, (grams.get(g) || 0) + 1);
  }
  const dup = [...grams.values()].filter((c) => c > 1).reduce((a, c) => a + c, 0) / Math.max(1, t.length - 2);
  if (dup > 0.35) score += Math.min(0.6, dup);
  const rate = t.length / Math.max(0.5, durationSec || 0);
  if (rate > 9) score += 0.25;   // 偏快
  if (rate > 14) score += 0.35;  // 人类说话到不了这个速度，基本是在编
  if (t.length > 180 && !/[。！？]/.test(t)) score += 0.2;
  const counts = new Map();
  for (const ch of t) counts.set(ch, (counts.get(ch) || 0) + 1);
  if (Math.max(...counts.values()) / t.length > 0.35) score += 0.3;
  return Math.min(1, score);
}

/**
 * 清洗整个逐字稿的片段数组（返回新数组，不修改原对象）。
 * 顺带标出「很可能是幻觉」的段落，让界面能提醒用户回听核对。
 * @param {Array} segments
 * @param {object} [stats] 传入 emptyStats() 的结果就会累加统计（可选）
 */
export function cleanSegments(segments, stats) {
  return (segments || []).map((s) => {
    const raw = String(s.text || '');
    // 可疑度基于「原始识别结果」判断 —— 折叠之后就看不出幻觉了
    const score = hallucinationScore(raw, Number(s.end) - Number(s.start));
    return { ...s, text: cleanLine(raw, stats), suspect: score >= 0.5 ? 1 : 0 };
  });
}

/**
 * 统计清洗前后有多少字发生变化，用于给用户一个交代。
 *
 * 2026-11 改：原来是「按位置逐字比」，只要中间插进一个字，后面整串都会算成「改了」。
 * 补标点上线后这个问题被放大到离谱 —— 400 段 4800 字的稿子报「修正 4488 处」，
 * 其实只是多了标点。现在按段算编辑距离，插入标点只算插入的那几个。
 */
export function diffCount(rawSegments, cleanSegs) {
  const a = rawSegments || [];
  const b = cleanSegs || [];
  if (!a.length) return 0;
  if (a.length === b.length) {
    let n = 0;
    for (let i = 0; i < a.length; i++) n += editDistance(String(a[i].text || ''), String(b[i].text || ''));
    return n;
  }
  // 段数对不上（理论上不该发生）时退回原来的粗算法
  const s1 = a.map((s) => s.text || '').join('');
  const s2 = b.map((s) => s.text || '').join('');
  let n = 0;
  const len = Math.min(s1.length, s2.length);
  for (let i = 0; i < len; i++) if (s1[i] !== s2[i]) n++;
  return n + Math.abs(s1.length - s2.length);
}

/** 两句话的编辑距离（Levenshtein，句子很短，滚动数组即可） */
function editDistance(x, y) {
  if (x === y) return 0;
  if (!x.length) return y.length;
  if (!y.length) return x.length;
  let prev = new Array(y.length + 1);
  let cur = new Array(y.length + 1);
  for (let j = 0; j <= y.length; j++) prev[j] = j;
  for (let i = 1; i <= x.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const t = prev;
    prev = cur;
    cur = t;
  }
  return prev[y.length];
}

/**
 * 把统计对象整理成人类可读的一行，给界面/日志用。
 * 返回 null 表示「什么都没改」。
 */
export function describeStats(stats) {
  if (!stats) return null;
  const parts = [];
  if (stats.simplified) parts.push(`繁→简 ${stats.simplified} 字`);
  if (stats.normalized) parts.push(`部首/兼容字归一 ${stats.normalized} 字`);
  if (stats.punctuation) parts.push(`标点 ${stats.punctuation} 处`);
  if (stats.collapsed) parts.push(`折叠重复 ${stats.collapsed} 字`);
  if (stats.dropped) parts.push(`清掉非正文 ${stats.dropped} 字`);
  if (!parts.length) return null;
  const top = Object.entries(stats.droppedChars || {})
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([c, n]) => `${c}(U+${c.codePointAt(0).toString(16).toUpperCase()})×${n}`)
    .join(' ');
  return parts.join('、') + (top ? `；清掉的是：${top}` : '');
}
