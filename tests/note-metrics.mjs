/**
 * AI 笔记的「深度指标」共享模块
 *
 * 抽出来的动机：test-ainote-depth.mjs（新旧提示词对照）和 probe-note-scaling.mjs
 * （材料长度扫描）要量同一批东西，各写一份迟早会量出两个口径。
 *
 * 这里只放纯函数，不碰磁盘、不碰网络，也不 import public/ 里的任何模块。
 */

/** 取出某个二级小节（## 名字）的正文，到下一个 ## 或文末为止 */
export function sectionBody(md, name) {
  const lines = String(md).split('\n');
  const head = new RegExp(`^##\\s*${name}`);
  const start = lines.findIndex((l) => head.test(l));
  if (start === -1) return '';
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}

/** 某个二级小节的正文长度（去掉空白） */
export function sectionLen(md, name) {
  return sectionBody(md, name).replace(/\s/g, '').length;
}

/** 一份笔记的结构与深度指标 */
export function markers(md) {
  return {
    chars: md.length,
    sections: (md.match(/^##\s+/gm) || []).length,
    headings3: (md.match(/^###\s+/gm) || []).length,
    bullets: (md.match(/^\s*[-*]\s+/gm) || []).length,
    timestamps: (md.match(/\[\d{1,2}:\d{2}(?::\d{2})?\]/g) || []).length,
    supplement: (md.match(/（补充）/g) || []).length,
    hasLogic: /##\s*理解脉络/.test(md),
    hasTraps: /##\s*易错与易混/.test(md),
    logicChars: sectionLen(md, '理解脉络'),
    trapsChars: sectionLen(md, '易错与易混'),
    selfTest: sectionLen(md, '自测题') ? (md.match(/^\s*\d+\.\s+/gm) || []).length : 0,
  };
}

/**
 * 与原始逐字稿的「逐字重合率」：越高说明越像「压缩版逐字稿」。
 *
 * 口径说明：按字频多重集求交集（Bag of characters），不是最长公共子串。
 * 好处是能反映"整篇有多少字是原文搬来的"，坏处是短句重叠会被算进去 ——
 * 所以它是一个**相对**指标：只适合拿新旧两版互相比，不适合当绝对质量分。
 */
export function overlapRatio(md, body) {
  const strip = (s) => s.replace(/[\s\p{P}]/gu, '');
  const a = strip(md);
  const src = strip(body);
  const set = new Map();
  for (const ch of src) set.set(ch, (set.get(ch) || 0) + 1);
  let hit = 0;
  for (const ch of a) {
    const n = set.get(ch) || 0;
    if (n > 0) {
      hit++;
      set.set(ch, n - 1);
    }
  }
  return a.length ? hit / a.length : 0;
}
