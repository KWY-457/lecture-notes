#!/usr/bin/env node
/**
 * 数据完整性体检 —— 扫描 data/lectures 下全部录音，检查逐字稿与笔记的
 * 「不变量」，把每一类畸形都归类统计。目的不是修某一条，而是找出
 * 底层到底缺哪些保证，好一次性补上规范化层。
 *
 *   node tests/audit-data-integrity.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toSentences, splitSentences } from '../public/summarize.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LECT = path.join(ROOT, 'data', 'lectures');

const parse = (t) => JSON.parse(String(t).replace(/^\uFEFF/, ''));
const readJson = (p) => {
  try {
    return parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

const problems = new Map(); // 类别 -> 命中列表
const hit = (kind, id, detail) => {
  if (!problems.has(kind)) problems.set(kind, []);
  problems.get(kind).push({ id, detail });
};

const dirs = fs
  .readdirSync(LECT, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

const rows = [];
for (const id of dirs) {
  const meta = readJson(path.join(LECT, id, 'meta.json'));
  const tr = readJson(path.join(LECT, id, 'transcript.json'));
  const note = readJson(path.join(LECT, id, 'note.json'));
  if (!meta) {
    hit('meta.json 读不出来', id, '(缺失或坏 JSON)');
    continue;
  }
  const title = meta.title || '(无标题)';
  const segs = Array.isArray(tr?.segments) ? tr.segments : [];
  const text = String(tr?.text || '');
  const segChars = segs.reduce((n, s) => n + String(s.text || '').length, 0);
  const dur = Number(meta.duration) || 0;

  // ---- 逐字稿不变量 ----
  if (!tr) hit('transcript.json 不存在', id, title);
  else {
    if (!segs.length && text) hit('有全文但 segments 为空', id, `${title} · ${text.length} 字`);
    if (segs.length && segChars === 0) hit('segments 全空文本', id, title);
    if (segs.length === 1 && segChars > 2000) hit('整篇挤成 1 段', id, `${title} · ${segChars} 字`);
    if (segs.length && segs.length <= 3 && segChars > 2000)
      hit('段数过少且字数很多', id, `${title} · ${segs.length} 段 / ${segChars} 字`);

    // 时间戳
    const hasReal = segs.some((s) => Number(s.end) > Number(s.start) || Number(s.start) > 0);
    if (segs.length && !hasReal) hit('时间戳全 0（无可用时间轴）', id, `${title} · ${segs.length} 段`);
    // 单调
    let nonMono = 0;
    for (let i = 1; i < segs.length; i++) {
      if (Number(segs[i].start) < Number(segs[i - 1].start) - 0.01) nonMono++;
    }
    if (nonMono) hit('时间轴非单调', id, `${title} · ${nonMono} 处`);
    // 单段过长
    const over = segs.filter((s) => String(s.text || '').length > 200);
    if (over.length) hit('存在超长段（>200 字）', id, `${title} · ${over.length} 段，最长 ${Math.max(...over.map((s) => String(s.text).length))} 字`);
    // 重叠
    let overlap = 0;
    for (let i = 1; i < segs.length; i++) {
      if (Number(segs[i].start) < Number(segs[i - 1].end) - 0.5) overlap++;
    }
    if (overlap) hit('相邻段重叠', id, `${title} · ${overlap} 处`);
    // 覆盖率
    if (hasReal && dur > 0) {
      const last = Math.max(...segs.map((s) => Number(s.end) || 0));
      const cov = last / dur;
      if (cov < 0.9) hit('时间覆盖率不足 90%', id, `${title} · 末段 ${last.toFixed(1)}s / 时长 ${dur.toFixed(1)}s = ${(cov * 100).toFixed(1)}%`);
      if (cov > 1.05) hit('末段超出音频时长', id, `${title} · ${last.toFixed(1)}s > ${dur.toFixed(1)}s`);
    }
    // 极短碎段占比
    const tiny = segs.filter((s) => String(s.text || '').replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '').length < 2);
    if (segs.length > 20 && tiny.length / segs.length > 0.15)
      hit('碎段占比过高（>15%）', id, `${title} · ${tiny.length}/${segs.length}`);
    // 全文与段文本不一致（不是硬错误，记录差值）
    if (text && segChars && Math.abs(text.replace(/\s/g, '').length - segChars) / Math.max(1, segChars) > 0.05) {
      hit('全文与分段字数差 >5%', id, `${title} · text ${text.replace(/\s/g, '').length} vs segs ${segChars}`);
    }
  }

  // ---- 笔记不变量 ----
  if (note) {
    const d = note.data;
    const outline = Array.isArray(d?.outline) ? d.outline : [];
    const sens = Array.isArray(d?.sentences) ? d.sentences : [];
    if (note.mode === 'offline' && d && !sens.length) hit('笔记缺 sentences 数组', id, title);
    // outline 主题数是否合理
    if (outline.length > 40) hit('笔记主题数过多（>40，疑似旧算法每5句一刀）', id, `${title} · ${outline.length} 个主题`);
    // outline 句子数总和
    const sum = outline.reduce((n, o) => n + (Number(o.sentenceCount) || 0), 0);
    if (outline.length && d?.stats?.sentences && Math.abs(sum - d.stats.sentences) > 2)
      hit('outline 句数总和对不上 stats.sentences', id, `${title} · ${sum} vs ${d.stats.sentences}`);
    // hasTime 与 markdown 里的时间戳链接
    const links = (String(note.markdown || '').match(/\[[^\]]*\]\(#t=/g) || []).length;
    if (d && d.hasTime === false && links === 0 && Array.isArray(tr?.segments) && tr.segments.some((s) => Number(s.end) > Number(s.start)))
      hit('笔记标注无时间轴但逐字稿其实有时间戳', id, `${title} · 逐字稿 ${tr.segments.length} 段真时间戳，笔记 0 个时间链接`);
    // 主题标题质量：过短或含重复拼接
    const badHead = outline.filter((o) => {
      const h = String(o.heading || '');
      return h.length < 4 || /(.)\1{2,}/.test(h) || (h.match(/·/g) || []).length >= 1;
    });
    if (outline.length > 10 && badHead.length / outline.length > 0.5)
      hit('主题标题质量差（过半是碎片拼接）', id, `${title} · ${badHead.length}/${outline.length}，例：${JSON.stringify(badHead[0]?.heading)}`);
  }

  rows.push({ id: id.slice(0, 8), title: title.slice(0, 18), segs: segs.length, chars: segChars, dur: Math.round(dur), note: note ? note.mode : '-' });
}

console.log('=== 全部录音概览 ===');
console.log('id        标题                段数   字数   时长s  笔记');
for (const r of rows) {
  console.log(`${r.id}  ${r.title.padEnd(18)} ${String(r.segs).padStart(4)} ${String(r.chars).padStart(6)} ${String(r.dur).padStart(6)}  ${r.note}`);
}

console.log('\n=== 畸形分类 ===');
if (!problems.size) console.log('（无）');
for (const [kind, list] of problems) {
  console.log(`\n✗ ${kind} —— ${list.length} 条`);
  for (const x of list) console.log(`    ${x.id}  ${x.detail}`);
}

// ---- 用「应有的规范化」重算一次，看修完还剩多少问题 ----
console.log('\n=== 若统一走 toSentences() 规范化，各条会有多少段 ===');
for (const id of dirs) {
  const tr = readJson(path.join(LECT, id, 'transcript.json'));
  if (!tr) continue;
  const segs = Array.isArray(tr.segments) ? tr.segments : [];
  const text = String(tr.text || '');
  const src = text || segs.map((s) => s.text).join('');
  if (!src.trim()) continue;
  const real = toSentences(segs.length ? segs : [{ start: 0, end: 0, text: src }]);
  const direct = splitSentences(src);
  console.log(
    `  ${id.slice(0, 8)}  现状 ${String(segs.length).padStart(4)} 段 → toSentences(现有段) ${String(real.sentences.length).padStart(4)} 句 (hasTime=${real.hasTime})  |  纯文本重切 ${String(direct.length).padStart(4)} 句`
  );
}
