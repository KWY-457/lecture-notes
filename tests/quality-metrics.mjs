/**
 * 转写质量指标 —— 纯计算，不打印。
 *
 * 抽出来的原因：同一套数字要喂给两个消费者
 *   ① tests/report-quality.mjs        人看的报告（摊原文、给建议）
 *   ② tests/check-quality-baseline.mjs 机看的回归（对着基线卡阈值）
 * 两边各算一遍迟早会算出两套数，所以只留这一份。
 *
 * 「像不像人话」怎么量 —— 说明清楚，免得以后有人想当然。
 *
 * 先说两条**走不通**的路，都试过了：
 *   ✗ 拿 Whisper 词表当汉语词典。whisper-large-v3-turbo 缓存里的 vocab.json
 *     只有 50257 条，键是字符串下标的数字、值是整数 —— 那是 BPE 的 merge
 *     rank 表，不是 token 表。里面一个汉字都没有。拿它查「我们」是不是词，
 *     结果永远是「不是」。
 *   ✗ 用 hallucinationScore 当崩坏判据。它只抓「重复、语速异常、无标点」，
 *     抓不住「整段汉语不通」：62b4f73d 开头「今天我们来开了新的三個电腦像是
 *     新的摩托车放鬆起来」不重复、语速正常、标点齐全，它给 0 分。
 *
 * 真正能站住的两条：
 *   ① 段内自发重复率 —— 一段话里 4 字块自己重复自己。正常口语接近 0，
 *      Whisper 卡住时会整句吐两遍。这是幻觉最硬的指纹。
 *   ② 杂符率 —— 落在「正文码位之外」的字符占比。第③项修的就是这个。
 * 这两条都单调可比：模型越好、清洗越到位，数字越低。
 * 至于「语义通不通」，只能靠人读或大模型判 —— 不在这份自动报告的能力范围内。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from '../public/summarize.js';
import { hallucinationScore, cleanSegments, emptyStats, describeStats } from '../public/cleanup.js';
// 注意：T2S_RE 由 t2s-table.js 导出，cleanup.js 不转出它（cleanup 只导出函数）。
import { T2S_RE } from '../public/t2s-table.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LECTURES = path.join(HERE, '..', 'data', 'lectures');

/** 统计一段文字里的繁体形个数（第③项的核心指标） */
export function countTraditional(s) {
  T2S_RE.lastIndex = 0;
  return (String(s).match(T2S_RE) || []).length;
}

export function selfRepeat(text) {
  const t = String(text).replace(/[^\u4e00-\u9fff]/g, '');
  if (t.length < 16) return 0;
  const blocks = [];
  for (let i = 0; i + 4 <= t.length; i += 4) blocks.push(t.slice(i, i + 4));
  if (blocks.length < 4) return 0;
  const seen = new Set();
  let dup = 0;
  for (const b of blocks) {
    if (seen.has(b)) dup++;
    else seen.add(b);
  }
  return dup / blocks.length;
}

/** 杂符率：正文码位之外的字符占全文字符的比例（第③项的直接指标） */
export function junkRatio(text) {
  const s = String(text);
  if (!s.length) return { ratio: 0, junk: [] };
  let bad = 0;
  const sample = [];
  for (const ch of s) {
    const c = ch.codePointAt(0);
    const ok =
      (c >= 0x20 && c <= 0x7e) ||
      (c >= 0x3400 && c <= 0x4dbf) ||
      (c >= 0x4e00 && c <= 0x9fff) ||
      (c >= 0x3000 && c <= 0x303f) ||
      (c >= 0xff01 && c <= 0xff5e) ||
      (c >= 0x2010 && c <= 0x201f) ||
      c === 0x2026 ||
      c === 0x00b7 ||
      c === 0x0a ||
      c === 0x0d;
    if (!ok) {
      bad++;
      if (sample.length < 10) sample.push(`U+${c.toString(16).toUpperCase().padStart(4, '0')}(${ch})`);
    }
  }
  return { ratio: bad / [...s].length, junk: sample };
}

/** 标点密度：每百个汉字的标点数（本地 Whisper 的直接短板，实测 0.47 vs 云端 12~15） */
export function punctuationDensity(text) {
  const s = String(text);
  const han = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const marks = (s.match(/[，。、？！；：,.?!;:]/g) || []).length;
  if (!han) return { han: 0, marks: 0, per100: 0 };
  return { han, marks, per100: +((marks / han) * 100).toFixed(2) };
}

/** 找高频重复短语：4~12 字、出现 ≥4 次的片段（Whisper 幻觉的典型指纹） */
export function repeatPhrases(text, minLen = 4, maxLen = 12, minCount = 4) {
  const t = String(text).replace(/[\s，。、？！；：""''（）]/g, '');
  const counter = new Map();
  for (let len = minLen; len <= maxLen; len += 2) {
    for (let i = 0; i + len <= t.length; i += 2) {
      const g = t.slice(i, i + len);
      counter.set(g, (counter.get(g) || 0) + 1);
    }
  }
  return [...counter.entries()]
    .filter(([, n]) => n >= minCount)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, 6)
    .map(([g, n]) => `${g}×${n}`);
}

/** 单条记录的体检 */
export function inspect(dirName, filter) {
  const dir = path.join(LECTURES, dirName);
  const tp = path.join(dir, 'transcript.json');
  const mp = path.join(dir, 'meta.json');
  if (!fs.existsSync(tp)) return null;
  if (filter && !dirName.startsWith(filter)) return null;

  const j = JSON.parse(fs.readFileSync(tp, 'utf8'));
  const meta = fs.existsSync(mp) ? JSON.parse(fs.readFileSync(mp, 'utf8')) : {};
  const segs = j.segments || [];
  const rawText = segs.map((s) => s.text || '').join('');
  const dur = Number(meta.duration) || Number(segs[segs.length - 1]?.end) || 0;

  // 现成记录跑一遍清洗（幂等：已经是清洗过的就几乎不变）
  const stats = emptyStats();
  const cleaned = cleanSegments(segs, stats);
  const cleanText = cleaned.map((s) => s.text || '').join('');

  const suspectRaw = segs.filter((s) => hallucinationScore(s.text || '', Number(s.end) - Number(s.start)) >= 0.5).length;
  const suspectClean = cleaned.filter((s) => hallucinationScore(s.text || '', Number(s.end) - Number(s.start)) >= 0.5).length;

  // 「像不像人话」两条判据：段内自发重复率 + 杂符率
  const repPerSeg = segs.map((s) => selfRepeat(s.text || ''));
  const repSegCount = repPerSeg.filter((r) => r > 0.25).length;
  const repMax = repPerSeg.reduce((a, b) => Math.max(a, b), 0);
  const junk = junkRatio(cleanText);
  const junkRaw = junkRatio(rawText);

  // 空段与超长段（>200 字 = 一个段吞了太久，模型在硬撑）
  const emptySeg = segs.filter((s) => !String(s.text || '').trim()).length;
  const longSeg = segs.filter((s) => String(s.text || '').length > 200).length;

  // 标点密度（本地 Whisper 的硬伤：实测每百字 0.47 个标点，云端 SenseVoice 约 12~15）
  const punctRaw = punctuationDensity(rawText);
  const punctClean = punctuationDensity(cleanText);

  // 结构指标：主题数与标题质量（反应「这份逐字稿能不能撑起一份笔记」）
  let topicCountActual = 0;
  let headings = [];
  let oneWordHeadings = 0;
  try {
    const note = analyze({ segments: segs, meta: { title: meta.title || '', course: meta.course || '', duration: dur }, options: {} });
    headings = (note.outline || []).map((o) => String(o.heading || ''));
    topicCountActual = headings.length;
    oneWordHeadings = headings.filter((h) => h && !h.includes('与') && !/^第.+部分$/.test(h)).length;
  } catch {
    // summarize.js 起不来就不影响主报告，结构指标留空
  }

  return {
    dirName,
    id: dirName.slice(0, 8),
    title: meta.title || '',
    model: j.model || '(无)',
    cleanedBy: j.cleanedBy || '(无)',
    engine: j.engine || '',
    durationSec: Math.round(dur),
    durationMin: (dur / 60).toFixed(1),
    segments: segs.length,
    chars: rawText.length,
    charsPerSec: dur ? +(rawText.length / dur).toFixed(2) : 0,
    traditionalRaw: countTraditional(rawText),
    traditionalClean: countTraditional(cleanText),
    suspectRaw,
    suspectClean,
    emptySeg,
    longSeg,
    punctRaw,
    punctClean,
    topicCountActual,
    headings,
    oneWordHeadings,
    cleanLenDelta: rawText.length - cleanText.length,
    cleanStatsText: (describeStats(stats) || '（无需清洗）').replace(/\n/g, ' '),
    junkRatio: junk.ratio,
    junkRawRatio: junkRaw.ratio,
    junkSample: junk.junk,
    repSegCount,
    repMax,
    // 段内重复最高、字数够长的前 5 段 —— 摊给"人"看，自动指标到此为止
    worstSegs: repPerSeg
      .map((r, i) => ({ r, i }))
      .filter((x) => String(segs[x.i].text || '').replace(/[^\u4e00-\u9fff]/g, '').length >= 20)
      .sort((a, b) => b.r - a.r)
      .slice(0, 5)
      .map((x) => ({
        rep: +x.r.toFixed(2),
        start: +Number(segs[x.i].start).toFixed(1),
        text: String(segs[x.i].text || '').slice(0, 110),
      })),
    repeats: repeatPhrases(rawText),
    head: segs.slice(0, 3).map((s) => String(s.text || '').slice(0, 70)),
    worst: segs
      .map((s) => ({ s, sc: hallucinationScore(s.text || '', Number(s.end) - Number(s.start)) }))
      .sort((a, b) => b.sc - a.sc)
      .slice(0, 3)
      .map(({ s, sc }) => ({ sc: +sc.toFixed(2), start: +Number(s.start).toFixed(1), text: String(s.text || '').slice(0, 90) })),
  };
}

/** 把 data/lectures 全扫一遍（filter 是 id 前缀，空则全要） */
export function inspectAll(filter = '') {
  return fs
    .readdirSync(LECTURES)
    .map((d) => inspect(d, filter))
    .filter(Boolean);
}
