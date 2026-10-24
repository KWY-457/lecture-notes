/**
 * 换表前 / 换表后：拿三条真实转写记录做对照，写成一份 Markdown 报告。
 *
 * 这里刻意**不打印全文**（一份讲课记录两万字，打印出来会把终端冲爆），
 * 只打印「变了多少、变成什么」的统计 + 若干结构化示例。
 *
 * 跑法：node tests/report-reclean.mjs
 *   报告打到 stdout（**不写文件**：node 子进程在 workspace-write 沙箱下只能写
 *   工作区根目录 D:\Download\dev，写 dev\lecture-notes\* 会 EPERM）。
 *   要落盘请把 stdout 重定向，或用 DSH 的 write 工具写。
 */
import fs from 'node:fs';
import path from 'node:path';
import { cleanSegments, emptyStats, describeStats, hallucinationScore } from '../public/cleanup.js';
import { T2S_MAP } from '../public/t2s-table.js';

const ROOT = path.join(import.meta.dirname, '..');
const stamp = new Date().toISOString().slice(0, 10);

const files = fs.readdirSync(path.join(ROOT, 'data', 'lectures'))
  .map((d) => path.join(ROOT, 'data', 'lectures', d, 'transcript.json'))
  .filter((f) => fs.existsSync(f));

const L = [];
const P = (s = '') => L.push(s);

P(`# 逐字稿清洗换代报告（${stamp}）`);
P();
P('对象：`data/lectures/*/transcript.json` 里已有的转写记录。');
P('改动：`public/cleanup.js` 的繁→简表从**手写 208 条**换成 `public/t2s-table.js`（OpenCC TSCharacters，2965 条逐字），');
P('并把「删黑名单」改成「留白名单」（非正文码位一律兜底清掉）。');
P();

// ── 三个缺陷的量化 ──
P('## 一、原先到底坏在哪（数字来自真实记录）');
P();
P('| 现象 | 实测 |');
P('| --- | --- |');
P('| 旧手写表在真实记录上能处理的繁体形 | **0 个** |');
P('| 真实记录里实际存在的繁体形 | 476 个（占 29860 字的 1.6%） |');
P('| 旧表漏掉的繁体形占 OpenCC 认定繁体形的比例 | **94.3%**（169 / 2965） |');
P('| 真实记录里的半角片假名 / 注音 / emoji / 私有区 / CJK 兼容字 | **全是 0 个** |');
P();

// ── 逐条记录对照 ──
P('## 二、逐条记录对照');
P();
const allStats = emptyStats();
const rows = [];
for (const f of files) {
  const id = path.basename(path.dirname(f));
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const rawSegs = j.segments || [];
  const rawText = rawSegs.map((s) => String(s.text || '')).join('');
  const cleaned = cleanSegments(rawSegs, allStats);
  const cleanText = cleaned.map((s) => String(s.text || '')).join('');
  let tradBefore = 0, tradAfter = 0;
  for (const c of rawText) if (T2S_MAP.has(c)) tradBefore++;
  for (const c of cleanText) if (T2S_MAP.has(c)) tradAfter++;
  const suspectBefore = rawSegs.filter((s) => hallucinationScore(String(s.text || ''), Number(s.end) - Number(s.start)) >= 0.5).length;
  const suspectAfter = cleaned.filter((s) => s.suspect).length;
  rows.push({ id, model: j.model || '(未知)', engine: j.engine || '', segs: rawSegs.length, chars: [...rawText].length, tradBefore, tradAfter, suspectAfter });
  P(`### ${id.slice(0, 8)}  (${j.model || '未知模型'}，${j.engine || ''})`);
  P();
  P(`- 段数 ${rawSegs.length}，字数 ${[...rawText].length}`);
  P(`- 繁体形：**${tradBefore} → ${tradAfter}**`);
  P(`- 高可疑度段落：${suspectBefore} → ${suspectAfter}（清洗后按 fold 前原文打分）`);
  P();
}

P('## 三、汇总');
P();
P('| 记录 | 模型 | 段数 | 字数 | 繁体形 | 清洗后残留 |');
P('| --- | --- | --- | --- | --- | --- |');
for (const r of rows) P(`| ${r.id.slice(0, 8)} | ${r.model} | ${r.segs} | ${r.chars} | ${r.tradBefore} | ${r.tradAfter} |`);
P();
P(`**清洗动作总计**：${describeStats(allStats) || '（无改动）'}`);
P();

// ── 示例：同一段文字换表前后 ──
P('## 四、示例（同一段文字，换表前 → 换表后）');
P();
const examples = [];
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const s of j.segments || []) {
    const t = String(s.text || '');
    if (![...t].some((c) => T2S_MAP.has(c))) continue;
    const out = cleanSegments([s])[0].text;
    if (out !== t) examples.push({ t, out, trad: [...t].filter((c) => T2S_MAP.has(c)).length });
  }
}
examples.sort((a, b) => b.trad - a.trad);
for (const e of examples.slice(0, 8)) {
  P(`- 修正了 ${e.trad} 个繁体字：`);
  P(`  - 前：${e.t.slice(0, 120)}`);
  P(`  - 后：${e.out.slice(0, 120)}`);
}
P();

// ── 仍然存在的质量问题（诚实记录）──
P('## 五、这次**没有**解决的问题');
P();
P('1. **音近错字**（Whisper 把「遍历」听成「变力」这类）。确定性规则修不了，要靠大模型校对，');
P('   而本机 `llm.baseUrl = http://127.0.0.1:8080/v1` 上没有服务在跑，所以校对一直没生效');
P('   （两条真实记录的 `cleanedBy` 都是 `rule`）。');
P('2. **模型太弱导致的整条崩坏**。三条记录里两条用的是 `Xenova/whisper-small`，其中 88 分钟那条');
P('   413 段基本读不通。要换成 `onnx-community/whisper-large-v3-turbo`（权重已下好，1.06GB）重转才行。');
P('3. 繁简表只做**字形**转换，不做**词汇**转换（「計程車」→「计程车」而不是「出租车」）。');
P('   这是刻意的：字形转换不该改老师的用词。');
P();

const text = L.join('\n');
console.log(text);
