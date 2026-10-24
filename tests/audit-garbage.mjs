/**
 * 只读审计：到底哪些字符是「不明字符」？
 *
 * 在动手改 public/cleanup.js 之前，先用真实转写记录量出结论，不靠猜。
 * 跑法：node tests/audit-garbage.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.join(import.meta.dirname, '..');
const { T2S_MAP } = await import(pathToFileURL(path.join(ROOT, 'public', 't2s-table.js')).href);

// 旧手写表的 key 集合（从 public/cleanup.js 的 T2S 抄出来，只为对照）
const OLD_T2S_SRC = `們說或這個那個嗎麼呢過來時對學習會還為見點國開關聽講課問題書圖讀寫記讓應該錯誤認識師傳體現東萬華馬鳥魚貝車門電風飛飯飲紅綠藍黃黑數據結構樹遍曆遞歸棧隊列針組織網絡層轉換變實際證論設計預複雜簡單義樣種類辦處務稱員資裝載運算釋語法則於與無經過幾視覺難題讓進壓縮擴展導航級別標準確誤較併聯獨立離散詳細精節章冊錄音當豐懸掛處內沒衝擊敗勝負損益缺陷繞構誘導滿補斷繼續確穩概念資産業規律質量誤差纍積觸發現隱藏儲裏裡臺颱乾淨佈併`;
const OLD_T2S = new Set([...OLD_T2S_SRC]);

const dirs = fs.readdirSync(path.join(ROOT, 'data', 'lectures'))
  .map((d) => path.join(ROOT, 'data', 'lectures', d))
  .filter((d) => fs.existsSync(path.join(d, 'transcript.json')));

const sum = { nonText: 0, tradOld: 0, tradNew: 0, tradNewOnly: 0, runs: 0, runChars: 0 };
const catTotals = new Map();
const missedTop = new Map();
const runSamples = [];

for (const dir of dirs) {
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'transcript.json'), 'utf8'));
  const segs = j.segments || [];
  const text = segs.map((s) => s.text || '').join('\n');
  console.log(`\n===== ${path.basename(dir).slice(0, 8)}  ${j.model || '?'}  段数 ${segs.length}  字数 ${text.length} =====`);

  // ---- 1) 繁简覆盖对照 ----
  let oldHit = 0, newHit = 0, newOnlyHit = 0;
  const newOnlyChars = new Map();
  for (const ch of text) {
    if (OLD_T2S.has(ch)) oldHit++;
    if (T2S_MAP.has(ch)) {
      newHit++;
      if (!OLD_T2S.has(ch)) {
        newOnlyHit++;
        newOnlyChars.set(ch, (newOnlyChars.get(ch) || 0) + 1);
      }
    }
  }
  sum.tradOld += oldHit; sum.tradNew += newHit; sum.tradNewOnly += newOnlyHit;
  const top = [...newOnlyChars.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24);
  console.log(`  繁体字数：旧表认得 ${oldHit} 个，新表认得 ${newHit} 个，其中新表多认 ${newOnlyHit} 个`);
  console.log(`  新表多认的高频字（繁->简）：${top.map(([c, n]) => `${T2S_MAP.get(c)}<-${c}×${n}`).join('  ')}`);
  for (const [c, n] of newOnlyChars) missedTop.set(c, (missedTop.get(c) || 0) + n);

  // ---- 2) 非正文字符分类 ----
  const CATS = [
    ['半角片假名', (p) => p >= 0xff61 && p <= 0xff9f],
    ['平假名/片假名', (p) => p >= 0x3040 && p <= 0x30ff],
    ['谚文(韩)', (p) => (p >= 0xac00 && p <= 0xd7af) || (p >= 0x1100 && p <= 0x11ff)],
    ['注音符号', (p) => p >= 0x3100 && p <= 0x312f],
    ['CJK部首', (p) => p >= 0x2e80 && p <= 0x2eff],
    ['CJK兼容汉字', (p) => p >= 0xf900 && p <= 0xfaff],
    ['CJK扩展A', (p) => p >= 0x3400 && p <= 0x4dbf],
    ['CJK扩展B+', (p) => p >= 0x20000 && p <= 0x3ffff],
    ['emoji', (p) => p >= 0x1f000 && p <= 0x1faff],
    ['杂符号2600-27BF', (p) => p >= 0x2600 && p <= 0x27bf],
    ['杂符号2B00-2BFF', (p) => p >= 0x2b00 && p <= 0x2bff],
    ['私有区', (p) => p >= 0xe000 && p <= 0xf8ff],
    ['零宽/变体选择符', (p) => p === 0x200b || p === 0x200c || p === 0x200d || p === 0xfeff || (p >= 0xfe00 && p <= 0xfe0f) || (p >= 0xfff0 && p <= 0xffff)],
    ['希腊/西里尔', (p) => (p >= 0x0370 && p <= 0x03ff) || (p >= 0x0400 && p <= 0x04ff)],
    ['Latin扩展', (p) => p >= 0x00c0 && p <= 0x024f],
    ['全角字母数字', (p) => (p >= 0xff10 && p <= 0xff19) || (p >= 0xff21 && p <= 0xff3a) || (p >= 0xff41 && p <= 0xff5a)],
    ['其他CJK标点/竖排', (p) => (p >= 0x3000 && p <= 0x303f) || (p >= 0xfe10 && p <= 0xfe6f)],
    ['控制字符', (p) => p < 0x20 ? false : p === 0x7f],
  ];
  const isNormal = (p) =>
    (p >= 0x20 && p <= 0x7e) ||                       // ASCII
    (p >= 0x4e00 && p <= 0x9fff) ||                   // CJK 基本区
    p === 0x3001 || p === 0x3002 || p === 0x300a || p === 0x300b ||
    p === 0xff0c || p === 0xff01 || p === 0xff1f || p === 0xff1a || p === 0xff1b ||
    p === 0x2018 || p === 0x2019 || p === 0x201c || p === 0x201d ||
    p === 0x2014 || p === 0x2013 || p === 0x2026;

  const catCount = new Map();
  const catChars = new Map();
  for (const ch of text) {
    const p = ch.codePointAt(0);
    if (isNormal(p)) continue;
    const hit = CATS.find(([, t]) => t(p));
    const name = hit ? hit[0] : `未分类 U+${p.toString(16).toUpperCase()}`;
    catCount.set(name, (catCount.get(name) || 0) + 1);
    if (!catChars.has(name)) catChars.set(name, new Map());
    const m = catChars.get(name);
    m.set(ch, (m.get(ch) || 0) + 1);
    catTotals.set(name, (catTotals.get(name) || 0) + 1);
    sum.nonText++;
  }
  console.log(catCount.size
    ? `  非正文字符：${[...catCount.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}×${c} ${[...catChars.get(n).keys()].slice(0, 8).map((x) => JSON.stringify(x)).join('')}`).join('  |  ')}`
    : '  非正文字符：0');

  // ---- 3) 连续不可读段（讲义里真正丑的东西）----
  const runs = [];
  for (const s of segs) {
    const t = String(s.text || '');
    let i = 0;
    while (i < t.length) {
      if (!isNormal(t.codePointAt(i))) {
        let k = i;
        while (k < t.length && !isNormal(t.codePointAt(k))) k++;
        runs.push({ start: s.start, len: k - i, text: t.slice(Math.max(0, i - 10), Math.min(t.length, k + 10)) });
        i = k;
      } else i++;
    }
  }
  if (runs.length) {
    sum.runs += runs.length;
    sum.runChars += runs.reduce((a, r) => a + r.len, 0);
    console.log(`  连续不可读段：${runs.length} 处，合计 ${runs.reduce((a, r) => a + r.len, 0)} 字符`);
    for (const r of runs.slice(0, 5)) console.log(`    @${r.start}s 长${r.len}: …${r.text}…`);
    if (runSamples.length < 8) runSamples.push({ file: path.basename(dir).slice(0, 8), run: runs[0] });
  } else {
    console.log('  连续不可读段：0（Whisper 没有成串吐垃圾）');
  }
}

console.log(`\n===== 汇总 =====`);
console.log(`  非正文字符总数：${sum.nonText}${catTotals.size ? '（' + [...catTotals.entries()].map(([n, c]) => `${n}×${c}`).join('，') + '）' : ''}`);
console.log(`  繁体字：旧表认得 ${sum.tradOld} 个，新表认得 ${sum.tradNew} 个（新表多认 ${sum.tradNewOnly} 个，覆盖率提升 ${sum.tradOld ? (sum.tradNew / sum.tradOld).toFixed(2) : '∞'} 倍）`);
console.log(`  新表多认的最高频字（简<-繁）：${[...missedTop.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([c, n]) => `${T2S_MAP.get(c)}<-${c}×${n}`).join(' ')}`);
console.log(`  连续不可读段：${sum.runs} 处 / ${sum.runChars} 字符`);
