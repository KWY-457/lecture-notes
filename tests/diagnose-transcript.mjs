/**
 * 逐字稿质量诊断：量化「重复循环」「幻觉段落」「时间轴异常」等问题。
 * 运行：
 *   node tests/diagnose-transcript.mjs                  # 自动挑一条，服务地址自动探测
 *   node tests/diagnose-transcript.mjs <lectureId>
 *   node tests/diagnose-transcript.mjs <lectureId> http://127.0.0.1:25994
 */
import fs from 'node:fs';
import path from 'node:path';

const DATA = path.join(import.meta.dirname, '..', 'data', 'lectures');

// 服务地址：优先命令行第三个参数，其次启动器写的 runtime.json，最后退回 8788。
// 以前这里写死 8788，服务一换随机端口就整个脚本 fetch failed —— 看着像产品坏了，
// 其实只是找不到门。
function defaultBase() {
  try {
    const rt = JSON.parse(fs.readFileSync(path.join(DATA, '..', 'runtime.json'), 'utf8'));
    if (rt.port) return `http://127.0.0.1:${rt.port}`;
  } catch { /* 没在跑 */ }
  return 'http://127.0.0.1:8788';
}
const BASE = (process.argv[3] || defaultBase()).replace(/\/+$/, '');

const list = await fetch(BASE + '/api/lectures').then((r) => r.json());
let id = process.argv[2];
if (!id) {
  const cand = list.lectures.find((l) => (l.title || '').includes('新录音')) || list.lectures[0];
  id = cand.id;
}
const meta = JSON.parse(fs.readFileSync(path.join(DATA, id, 'meta.json'), 'utf8'));
const tr = JSON.parse(fs.readFileSync(path.join(DATA, id, 'transcript.json'), 'utf8'));
const segs = tr.segments || [];
const note = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA, id, 'note.json'), 'utf8')); } catch { return null; } })();

const text = segs.map((s) => s.text).join('');
console.log(`\n=== 逐字稿诊断：${meta.title} ===\n`);
console.log(`  段数 ${segs.length}   总字数 ${text.length}   时长 ${Math.round((meta.duration || segs.at(-1)?.end || 0) / 60)} 分钟`);
console.log(`  引擎 ${tr.engine}   模型 ${tr.model}   设备 ${tr.device || '(旧数据)'}   清洗方式 ${tr.cleanedBy || '(未清洗)'}`);
console.log(`  笔记 ${note ? `mode=${note.mode} 长度=${(note.markdown || '').length}` : '无'}`);

/* 1. 时间轴是否连续 */
console.log('\n=== 1. 时间轴 ===');
let gaps = 0, overlaps = 0, backwards = 0;
for (let i = 1; i < segs.length; i++) {
  const d = segs[i].start - segs[i - 1].end;
  if (d > 3) gaps++;
  else if (d < -1) overlaps++;
  if (segs[i].start < segs[i - 1].start) backwards++;
}
console.log(`  空隙(>3s) ${gaps} 处   重叠 ${overlaps} 处   时间倒流 ${backwards} 处`);
const covered = segs.reduce((n, s) => n + Math.max(0, s.end - s.start), 0);
console.log(`  语音覆盖 ${Math.round(covered)} 秒 / 音频 ${Math.round(meta.duration || 0)} 秒 = ${Math.round((covered / (meta.duration || 1)) * 100)}%`);

/* 2. 重复循环检测（幻觉最典型的特征） */
console.log('\n=== 2. 重复循环检测 ===');
const ngram = (s, n) => { const m = new Map(); for (let i = 0; i + n <= s.length; i++) { const g = s.slice(i, i + n); m.set(g, (m.get(g) || 0) + 1); } return m; };
for (const n of [2, 3, 4]) {
  const m = ngram(text, n);
  const top = [...m.entries()].filter(([g]) => /[\u4e00-\u9fff]/.test(g)).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const totalTokens = Math.max(1, text.length - n + 1);
  const dupRatio = [...m.values()].filter((c) => c > 1).reduce((a, c) => a + c, 0) / totalTokens;
  console.log(`  ${n}-gram 重复率 ${(dupRatio * 100).toFixed(1)}%   最高频: ${top.map(([g, c]) => `${g}×${c}`).join('  ')}`);
}

/* 3. 逐段可疑度打分 */
console.log('\n=== 3. 最可疑的段落（重复/碎片/异常）===');
const suspicion = segs.map((s, i) => {
  const t = s.text || '';
  let score = 0;
  const reasons = [];
  // 内部重复
  const m = ngram(t, 3);
  const rep = [...m.values()].filter((c) => c > 1).reduce((a, c) => a + c, 0) / Math.max(1, t.length - 2);
  if (rep > 0.25) { score += rep * 4; reasons.push(`内部重复${(rep * 100).toFixed(0)}%`); }
  // 与相邻段高度重合
  if (i > 0) {
    const prev = segs[i - 1].text || '';
    const shorter = t.length < prev.length ? t : prev;
    const longer = t.length < prev.length ? prev : t;
    if (shorter.length > 8 && longer.includes(shorter)) { score += 2; reasons.push('与上一段重复'); }
  }
  // 过长且无标点（一口气几百字）
  if (t.length > 200 && !/[。！？]/.test(t)) { score += 1; reasons.push('超长无标点'); }
  // 长度异常
  if (t.length > 300) { score += 1; reasons.push('异常长'); }
  return { i, score, t, reasons, dur: s.end - s.start };
}).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);

console.log(`  可疑段落 ${suspicion.length} / ${segs.length} 段`);
for (const s of suspicion.slice(0, 8)) {
  console.log(`\n  [${Math.floor(s.dur)}s 时长, 可疑度 ${s.score.toFixed(1)}, ${s.reasons.join('/')}]`);
  console.log(`  ${s.t.slice(0, 110)}${s.t.length > 110 ? '…' : ''}`);
}

/* 4. 语速异常：正常中文讲课约 4-6 字/秒 */
console.log('\n=== 4. 语速（字/秒）===');
const rates = segs.map((s) => ({ r: (s.text || '').length / Math.max(0.5, s.end - s.start), t: s.text, d: s.end - s.start }));
const fast = rates.filter((x) => x.r > 9).length;
const slow = rates.filter((x) => x.r < 1.5).length;
const avg = rates.reduce((a, x) => a + x.r, 0) / Math.max(1, rates.length);
console.log(`  平均 ${avg.toFixed(1)} 字/秒   （正常讲课 4~6）`);
console.log(`  过快(>9，多半在编) ${fast} 段   过慢(<1.5，多半是噪声) ${slow} 段`);
const fastSample = rates.filter((x) => x.r > 9).slice(0, 3);
for (const f of fastSample) console.log(`     ${f.r.toFixed(1)} 字/秒: ${f.t.slice(0, 70)}…`);

/* 5. 用词丰富度：幻觉文本的用词高度重复 */
const chars = new Set([...text]);
const used = [...chars].filter((c) => /[\u4e00-\u9fff]/.test(c));
console.log('\n=== 5. 用词丰富度 ===');
console.log(`  不同汉字 ${used.length} 个 / 总汉字 ${[...text].filter((c) => /[\u4e00-\u9fff]/.test(c)).length} 个 = ${((used.length / Math.max(1, [...text].filter((c) => /[\u4e00-\u9fff]/.test(c)).length)) * 100).toFixed(1)}%`);
console.log(`  （正常一节课 3~5%，低于 2% 说明内容高度重复）`);

console.log('\n=== 6. 开头 12 段原文 ===');
for (const s of segs.slice(0, 12)) console.log(`  [${Math.round(s.start)}s] ${(s.text || '').slice(0, 90)}`);
