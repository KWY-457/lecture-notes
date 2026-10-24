/**
 * 逐字稿规范化层 —— 整个应用**唯一**的逐字稿出入口。
 *
 * 为什么要有这一层：
 *   以前转写结果的落盘逻辑散在 server.mjs 的 transcribeViaApi 里，只在
 *   「服务商没回 segments」时才兜底切段；服务商回了 segments 但形状古怪
 *   （超长段、时间轴非单调、相邻段重叠、零长段）就原样存下，永不自愈。
 *   于是旧版代码写进去什么样，界面读出来就什么样，换一条录音进来又是新问题。
 *
 * 现在规矩是：
 *   - 任何来源的逐字稿（云端 API / 本地 Whisper / 前端 PUT / 旧数据）落盘前
 *     都要过 normalizeTranscript()，形状统一。
 *   - 读出来也要过一遍（幂等），存量脏数据不用迁移脚本也能自愈。
 *
 * 设计原则：
 *   1. **保真优先**：口语语气词（「嗯。」「啊。」）在逐字稿里是内容，不能丢。
 *      所以切句时带 keepShort，与「生成笔记」用的提纯切句分开。
 *   2. **幂等**：规范化两次的结果必须完全相同，否则每次读取都会改文件。
 *   3. **不猜内容**：只修时间轴和分段粒度，不改写文字本身。
 */
import { splitSentences } from './summarize.js';

/** 逐字稿结构版本号。改规范化规则时+1，前端据此提示「可重建」。 */
export const TRANSCRIPT_SCHEMA_VERSION = 2;

/** 单段超过这么多字就按句子重新切（再长就没法当一行显示，也没法定位） */
const MAX_SEG_CHARS = 120;
/** 单段超过这么多秒也切（长静音被算进一段会导致时间戳很粗） */
const MAX_SEG_SEC = 30;
/** 零长段（start==end）给个最小可视时长，否则播放器跳转落不到任何位置 */
const MIN_SEG_SEC = 0.3;
/** 口语语速估计，与 summarize.js 的 toSentences 保持一致 */
const CHARS_PER_SEC = 4.2;
/**
 * 允许全文比分段多出的字数比例。
 * 只容忍标点/空白这类对齐误差，不容忍整句丢失：
 * 逐字稿丢一句就是内容缺失（搜不到、SRT 导出少一段），必须视为「需要重切」。
 * 曾经的 0.9 阈值让 1.4% 的缺口（314 字）静默通过，就是这个洞。
 */
const MAX_CHAR_GAP_RATIO = 0.005;
/** 缺口再小也要到这个字数才重切，避免一两个标点就触发全文重排 */
const MIN_CHAR_GAP = 8;
/**
 * 重切时沿用原时间戳的最低覆盖门槛。
 * 原分段覆盖不到全文 80% 说明它是被截断的（尾部整段没有），
 * 锚点会把后半篇全压到同一个时间点，还不如老老实实按字数摊。
 */
const ANCHOR_MIN_COVERAGE = 0.8;

const charsOf = (s) => String(s || '').replace(/\s/g, '').length;
const estimateSec = (text) => Math.max(MIN_SEG_SEC, charsOf(text) / CHARS_PER_SEC);

/**
 * 把「重切后的新段」映射回原分段的时间轴。
 *
 * 为什么需要：重切是为了补回被吞掉的句子，但原分段可能带服务商给的精确时间戳。
 * 直接扔掉会让一条时间精确的录音退化成按字数估算 —— 用内容换精度，不划算。
 *
 * 做法：原分段拼成一条去掉空白、带「字符 → 时间」索引的字符流；
 * 再拿新段去上面做双指针走位 —— 新段的字在原流里找到就前进一格，
 * 找不到就说明这个字原分段里本来没有（正是被吞掉的那半句），跳过它。
 * 这样中间零散丢句不会让时间轴漂移。
 *
 * 只适用于「原分段覆盖了几乎全部文字」的情况（缺口是零散的）。
 * 如果是尾部截断（原分段只覆盖前面一部分），锚点会把后面所有段压到同一点，
 * 那种情况交给「按字数摊到录音时长」，由调用方用 coverage 判断。
 */
function buildTimeAnchors(segs) {
  const hasReal = segs.some((s) => s.end > s.start + 0.01 || s.start > 0);
  if (!hasReal) return null;
  let oldStr = '';
  const spans = [];
  for (const s of segs) {
    const t = String(s.text || '').replace(/\s/g, '');
    spans.push({ from: oldStr.length, to: oldStr.length + t.length, start: s.start, end: s.end > s.start ? s.end : s.start });
    oldStr += t;
  }
  if (!oldStr) return null;
  return { oldStr, spans, end: spans[spans.length - 1].end };
}

/** 字符流位置 → 时间（落在哪个原始段里，就按段内比例插值） */
function timeAtOffset(anchors, offset) {
  const { spans } = anchors;
  if (offset <= 0) return spans[0].start;
  if (offset >= spans[spans.length - 1].to) return spans[spans.length - 1].end;
  for (const sp of spans) {
    if (offset < sp.to) {
      const len = sp.to - sp.from;
      if (len <= 0) return sp.end;
      return Math.max(0, +(sp.start + (sp.end - sp.start) * ((offset - sp.from) / len)).toFixed(2));
    }
  }
  return spans[spans.length - 1].end;
}

/**
 * 沿原字符流走位，给每个新段算出 [start, end]。
 *
 * 用纯双指针而不是 indexOf 找位置：parts 是从全文切出来的，oldStr 是从原分段
 * 拼出来的，两者**顺序完全一致**，只差被吞掉的那几个语气词。所以逐字符比较
 * 就够了 —— 相同就推进老游标，不同就说明这个字原分段里本来没有，跳过。
 * 想用 indexOf 找句首会在「这段整段都是额外内容」时失灵并连带后面全部走偏。
 *
 * 返回与 parts 等长的数组，元素为 {start, end} 或 null。
 * 整段都是额外内容的会得到 start === end（零时长），由调用方并入相邻段。
 */
function mapPartsToAnchors(anchors, parts) {
  const { oldStr } = anchors;
  const out = [];
  let pi = 0;
  for (const part of parts) {
    const ps = String(part || '').replace(/\s/g, '');
    if (!ps) {
      out.push(null);
      continue;
    }
    const start = pi;
    for (const ch of ps) {
      if (pi < oldStr.length && oldStr[pi] === ch) pi++;
    }
    out.push({ start: timeAtOffset(anchors, start), end: timeAtOffset(anchors, pi) });
  }
  return out;
}

/**
 * 把零时长的段（原分段里没有那几个字）并入相邻段。
 * 文字一个字都不能丢，但也不能让它占一段时间 —— 占了会挤走后面所有段，
 * 造成整条时间轴向后漂移。宁可让一句话显示在同一秒里，也不能让观众点空。
 */
function absorbZeroSpan(segs) {
  const out = [];
  const pending = []; // 开头连续配不上的，等第一个有时间的段一起收
  for (const s of segs) {
    const zero = !(s.end > s.start + 0.01);
    if (zero && out.length) {
      out[out.length - 1].text += s.text;
      continue;
    }
    if (zero) {
      pending.push(s.text);
      continue;
    }
    out.push({ start: s.start, end: s.end, text: pending.join('') + s.text });
    pending.length = 0;
  }
  if (pending.length) {
    // 通篇都没配上时间：交给后面的「按字数摊到录音时长」，不能丢字
    out.push({ start: 0, end: 0, text: pending.join('') });
  }
  return out;
}
/**
 * 逐字稿的 text 是原文保真副本，segments 是它的可点击切分；
 * 两者字数出现可见缺口就说明切分吞掉了句子（典型是「嗯。」被过滤），
 * 这时必须放弃现有分段、按全文重切 —— 分段的时间戳再准也没用，
 * 因为观众点不到丢掉的那些话。
 */
function hasCharGap(rawChars, segChars) {
  if (rawChars <= 0) return false;
  const gap = rawChars - segChars;
  return gap > MIN_CHAR_GAP && gap / rawChars > MAX_CHAR_GAP_RATIO;
}

/**
 * 规范化逐字稿。
 *
 * @param {{text?:string, segments?:Array}} doc 原始逐字稿（可为空对象）
 * @param {{duration?:number}} [opts] 录音时长（秒），用于给没有时间戳的段摊时间轴
 * @returns {{doc:object, repairs:string[]}} 规范化后的文档 + 做了哪些修复
 */
export function normalizeTranscript(doc, opts = {}) {
  const src = doc && typeof doc === 'object' ? doc : {};
  const duration = Math.max(0, Number(opts.duration ?? src.duration) || 0);
  const repairs = [];

  // ---- 1. 收拢原始段 ----
  let segs = [];
  if (Array.isArray(src.segments)) {
    for (const s of src.segments) {
      if (!s || typeof s !== 'object') continue;
      const text = String(s.text ?? '').trim();
      if (!text) continue;
      segs.push({ start: Number(s.start) || 0, end: Number(s.end) || 0, text });
    }
  }
  const rawText = String(src.text ?? '').trim();
  const rawChars = charsOf(rawText);
  const segChars = segs.reduce((n, s) => n + charsOf(s.text), 0);

  // segments 空 / 把全文弄丢了 → 以全文为准重新切
  // 注意：重切会打散原有分段，但如果原分段带真时间戳，就用它当锚点把
  // 新段映射回原时间轴（mapPartsToAnchors），不白扔精度。
  // 前提是原分段基本覆盖全文（缺口是零散丢句）；尾部截断那种压不准，宁可不锚。
  const needResplit = !segs.length || hasCharGap(rawChars, segChars);
  if (needResplit) {
    const coverage = rawChars > 0 ? segChars / rawChars : 0;
    const anchors = coverage >= ANCHOR_MIN_COVERAGE ? buildTimeAnchors(segs) : null;
    const basis = rawText || segs.map((s) => s.text).join('');
    if (basis) {
      const parts = splitSentences(basis, { keepShort: true });
      if (parts.length) {
        const before = segs.length;
        const placed = anchors ? mapPartsToAnchors(anchors, parts) : null;
        let mapped = parts.map((text, i) => {
          const hit = placed ? placed[i] : null;
          if (!hit) return { start: 0, end: 0, text };
          return { start: hit.start, end: hit.end > hit.start ? hit.end : hit.start, text };
        });
        if (anchors) mapped = absorbZeroSpan(mapped);
        segs = mapped;
        if (before !== segs.length) repairs.push(`按全文重切为 ${segs.length} 段（原 ${before} 段漏字）`);
        else repairs.push(`按全文重切为 ${segs.length} 段`);
        if (anchors) repairs.push('重切后沿用原分段的时间戳');
      }
    }
  }
  if (!segs.length) {
    return { doc: { ...src, segments: [], text: rawText, schemaVersion: TRANSCRIPT_SCHEMA_VERSION }, repairs };
  }

  // ---- 2. 切掉超长段（按句切，时间按字数比例分）----
  let overCount = 0;
  const split = [];
  for (const s of segs) {
    const needByChars = charsOf(s.text) > MAX_SEG_CHARS;
    const span = Math.max(0, s.end - s.start);
    const needByTime = span > MAX_SEG_SEC && charsOf(s.text) > 8;
    if (!needByChars && !needByTime) {
      split.push(s);
      continue;
    }
    const parts = splitSentences(s.text, { keepShort: true });
    if (parts.length <= 1) {
      split.push(s);
      continue;
    }
    overCount++;
    const total = parts.reduce((n, p) => n + p.length, 0) || 1;
    let cursor = s.start;
    for (const p of parts) {
      const dur = span > 0 ? (span * p.length) / total : 0;
      split.push({ start: cursor, end: span > 0 ? cursor + dur : 0, text: p });
      cursor += dur;
    }
  }
  if (overCount) repairs.push(`切开 ${overCount} 个超长段`);

  // ---- 3. 修时间轴 ----
  const hasReal = split.some((s) => s.end > s.start + 0.01 || s.start > 0);
  if (!hasReal) {
    // 全没时间戳：按字数比例摊到录音时长上（和 server.mjs 的老做法一致，但这里是唯一实现）
    const total = split.reduce((n, s) => n + charsOf(s.text), 0) || 1;
    let cursor = 0;
    for (const s of split) {
      const span = duration > 0 ? (duration * charsOf(s.text)) / total : 0;
      s.start = duration > 0 ? +cursor.toFixed(2) : 0;
      s.end = duration > 0 ? +Math.min(duration, cursor + span).toFixed(2) : 0;
      cursor += span;
    }
    if (duration > 0) repairs.push(`按字数把 ${Math.round(duration)} 秒摊到 ${split.length} 段`);
    else repairs.push('没有录音时长，时间轴保持全 0');
  } else {
    // 有时间戳：修零长、修倒序、修重叠
    let prevEnd = 0;
    let fixedZero = 0;
    let fixedOrder = 0;
    let fixedOverlap = 0;
    for (const s of split) {
      let { start, end } = s;
      if (start < prevEnd - 0.01) {
        start = prevEnd; // 倒序 / 重叠：推到上一段结束处
        fixedOrder++;
      } else if (start > prevEnd + 0.01) {
        // 中间有空档是正常的（停顿），保留
      }
      if (!(end > start)) {
        end = start + estimateSec(s.text); // 零长段给个估计
        fixedZero++;
      }
      if (start < prevEnd - 0.01) {
        start = prevEnd;
        fixedOrder++;
      }
      s.start = +start.toFixed(2);
      s.end = +end.toFixed(2);
      prevEnd = s.end;
    }
    if (fixedZero) repairs.push(`补 ${fixedZero} 个零长段`);
    if (fixedOrder) repairs.push(`修 ${fixedOrder} 处时间轴倒序/重叠`);

    // 超出录音时长：只在其明显越界时裁，正常的末段短一点不算错
    if (duration > 0) {
      const last = split[split.length - 1];
      if (last.end > duration * 1.02) {
        const ratio = duration / last.end;
        for (const s of split) {
          s.start = +(s.start * ratio).toFixed(2);
          s.end = +(s.end * ratio).toFixed(2);
        }
        repairs.push(`时间轴整体超出录音 ${(last.end - duration).toFixed(1)} 秒，按比例缩回`);
      }
    }
  }

  // ---- 4. 全文与分段对齐 ----
  // 保真原则：原文非空就保留原文（它可能含分段里被合并掉的语气词）。
  // 只有原文为空时才用分段重建，保证 text 字段永远不是空壳。
  let text = rawText;
  if (!text) {
    text = split.map((s) => s.text).join('\n');
    repairs.push('全文字段为空，用分段重建');
  }

  const out = {
    ...src,
    text,
    segments: split.map((s) => ({ start: s.start, end: s.end, text: s.text })),
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
  };
  return { doc: out, repairs: repairs.filter(Boolean) };
}

/**
 * 只判断「要不要修」，不真的改。给读取路径做快速短路用。
 * 判定宁宽勿窄：假阳性只是多重跑一次规范化（幂等，无害），
 * 假阴性会让脏数据永远躺在磁盘上。
 */
export function needsNormalize(doc, opts = {}) {
  const d = doc && typeof doc === 'object' ? doc : {};
  if (Number(d.schemaVersion) !== TRANSCRIPT_SCHEMA_VERSION) return true;
  const segs = Array.isArray(d.segments) ? d.segments : [];
  const text = String(d.text || '');
  if (!segs.length) return !!text.trim();
  const chars = segs.reduce((n, s) => n + charsOf(s.text), 0);
  if (hasCharGap(charsOf(text), chars)) return true;
  if (segs.some((s) => charsOf(s.text) > MAX_SEG_CHARS)) return true;
  const hasReal = segs.some((s) => Number(s.end) > Number(s.start) + 0.01 || Number(s.start) > 0);
  if (!hasReal) return true;
  let prevEnd = 0;
  for (const s of segs) {
    const start = Number(s.start) || 0;
    const end = Number(s.end) || 0;
    if (start < prevEnd - 0.02) return true;
    if (!(end > start)) return true;
    prevEnd = end;
  }
  return false;
}

export default { normalizeTranscript, needsNormalize, TRANSCRIPT_SCHEMA_VERSION };
