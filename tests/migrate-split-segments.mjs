#!/usr/bin/env node
/**
 * 一次性数据迁移：把「整篇挤成一段」的旧逐字稿重新切成逐句 segments。
 *
 * 背景
 * ----
 * 早于 2026-10-15 落地的按句切段逻辑（server.mjs 的 splitFallback）之前，
 * 有些云端录音（服务商只回一整段文字、不给 segments）被存成了
 * `segments: [{ start: 0, end: 0, text: <整篇 2 万多字> }]`。
 * 这种数据在界面上就是一整块读不通的墙，时间戳全是 00:00、点不动。
 *
 * 关键约束（踩过的坑，别改）
 * --------------------------
 * 切句必须用 public/summarize.js 的 toSentences()，不能用
 * `text.split(/(?<=[。！？；!?;…])/u)` 那种简单正则：
 *   - 简单正则切出 2247 段，其中 563 段（25%）是「嗯。」这类碎块；
 *   - toSentences() 切出 2095 句（段长 3/8/80，中位 8 字），
 *     且时间轴按「4.2 字/秒」估算 —— 这正是当初生成 note.json 时用的算法。
 * 实测：用 toSentences() 重放得到的 2095 句，其 start/end 与 note.json 里存的
 * 391 条 outline 的 start/end **逐条精确命中（391/391，差 0）**，sentenceCount
 * 也全对。换任何别的切法，逐字稿和笔记的时间轴就会错位（最大 41 秒）。
 *
 * 不丢字
 * ------
 * splitSentences() 末尾会过滤掉「有效字 < 2」的碎块（157 个「嗯。」共 314 字）。
 * 迁移时**保留原 `text` 字段不动**（导出 txt 仍拿到全文），只替换 `segments`。
 *
 * 用法
 * ----
 *   ./runtime/node.exe tests/migrate-split-segments.mjs            # 只体检，不写
 *   ./runtime/node.exe tests/migrate-split-segments.mjs --apply    # 真写（先备份）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toSentences } from '../public/summarize.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const LECT_DIR = path.join(ROOT, 'data', 'lectures');

const APPLY = process.argv.includes('--apply');
/** 段数少于等于这个值、且总字数超过 MIN_CHARS，就认定是「该切没切」的旧数据 */
const MAX_SEGS = 3;
const MIN_CHARS = 2000;

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

const report = { scanned: 0, skipped: 0, candidates: [], applied: [], errors: [] };

const ids = fs.readdirSync(LECT_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();

for (const id of ids) {
  const tp = path.join(LECT_DIR, id, 'transcript.json');
  if (!fs.existsSync(tp)) {
    report.skipped++;
    continue;
  }
  report.scanned++;
  let tr;
  try {
    tr = readJson(tp);
  } catch (e) {
    report.errors.push(`${id}: 读不了 transcript.json（${e.message}）`);
    continue;
  }
  const segs = Array.isArray(tr.segments) ? tr.segments : [];
  const chars = String(tr.text || '').length;
  const segChars = segs.reduce((n, s) => n + String(s.text || '').length, 0);

  if (segs.length > MAX_SEGS || Math.max(chars, segChars) <= MIN_CHARS) {
    report.skipped++;
    continue;
  }

  // —— 命中：算一下重切后的样子 ——
  const srcText = segChars >= chars ? segs.map((s) => s.text).join('') : String(tr.text);
  const { sentences, hasTime } = toSentences([{ start: 0, end: 0, text: srcText }]);
  const newSegs = sentences.map((s) => ({ start: s.start, end: s.end, text: s.text }));
  const newChars = newSegs.reduce((n, s) => n + s.text.length, 0);

  const item = {
    id,
    title: (() => {
      try {
        return readJson(path.join(LECT_DIR, id, 'meta.json')).title || '';
      } catch {
        return '';
      }
    })(),
    before: { segs: segs.length, chars: Math.max(chars, segChars) },
    after: { segs: newSegs.length, chars: newChars },
    droppedChars: Math.max(chars, segChars) - newChars,
    unchangedTimes: hasTime,
  };

  // —— 自检：note.json 的 outline 必须能被新 segments 精确命中 ——
  const np = path.join(LECT_DIR, id, 'note.json');
  if (fs.existsSync(np)) {
    try {
      const note = readJson(np);
      const outline = note?.data?.outline || [];
      if (outline.length) {
        const starts = new Set(newSegs.map((s) => s.start));
        const ends = new Set(newSegs.map((s) => s.end));
        const missStart = outline.filter((o) => !starts.has(o.start)).length;
        const missEnd = outline.filter((o) => !ends.has(o.end)).length;
        item.noteCheck = { outline: outline.length, missStart, missEnd };
        if (missStart || missEnd) {
          report.errors.push(`${id}: 重切后 note.json 的 outline 命中不上（start 缺 ${missStart}、end 缺 ${missEnd}），已跳过这条`);
          continue;
        }
      }
    } catch (e) {
      report.errors.push(`${id}: note.json 读不了（${e.message}），已跳过这条`);
      continue;
    }
  }

  if (!APPLY) {
    report.candidates.push(item);
    continue;
  }

  // —— 真写：先备份原文件 ——
  const bak = `${tp}.bak-${stamp()}`;
  fs.copyFileSync(tp, bak);
  const next = { ...tr, segments: newSegs };
  // 注意：text 字段**原样保留**，见文件头「不丢字」一节。
  fs.writeFileSync(tp, JSON.stringify(next, null, 2), 'utf8');
  item.backup = path.basename(bak);
  report.applied.push(item);
}

/* ------------------------------- 输出 ------------------------------- */
const pad = (s, n) => String(s).padEnd(n);
const line = (s) => process.stdout.write(s + '\n');

line(`模式：${APPLY ? '⚠ 真写（--apply）' : '体检（dry-run，不写任何文件）'}`);
line(`扫描 ${report.scanned} 条 transcript，跳过 ${report.skipped} 条`);
line('');

const list = APPLY ? report.applied : report.candidates;
if (!list.length) {
  line('✓ 没有需要迁移的录音：逐字稿的分段都正常。');
} else {
  line(APPLY ? '已迁移：' : '待迁移：');
  for (const it of list) {
    line(`  · ${it.id.slice(0, 8)}  「${it.title || '未命名'}」`);
    line(`      ${pad(it.before.segs + ' 段', 8)} → ${it.after.segs} 段    ` +
      `字数 ${it.before.chars} → ${it.after.chars}（切句过滤掉 ${it.droppedChars} 字的「嗯。」类碎块，原 text 字段保留全文）`);
    if (it.noteCheck) {
      const ok = it.noteCheck.missStart === 0 && it.noteCheck.missEnd === 0;
      line(`      笔记对齐：outline ${it.noteCheck.outline} 条 ${ok ? '✓ 全部精确命中' : '✗ 有错位'}`);
    }
    if (it.backup) line(`      备份：${it.backup}`);
  }
}

if (report.errors.length) {
  line('');
  line('遇到问题：');
  for (const e of report.errors) line('  ✗ ' + e);
}

line('');
if (!APPLY && list.length) {
  line('确认无误后加 --apply 真写：');
  line('  ./runtime/node.exe tests/migrate-split-segments.mjs --apply');
}
process.exit(report.errors.length ? 1 : 0);
