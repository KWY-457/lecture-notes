/**
 * 转写质量对照报告 —— 第④项（换 turbo 重转写）的验收工具。
 *
 * 用法：
 *   node tests/report-quality.mjs              # 全部记录
 *   node tests/report-quality.mjs 62b4f73d     # 只查某一条
 *
 * 它只读不写。每换一次模型/清洗规则，跑一遍这个就能看出「到底好了没有」。
 *
 * 指标的定义和「为什么这么量」都在 tests/quality-metrics.mjs 里，
 * 那个文件同时被 tests/check-quality-baseline.mjs 用 —— 保证报告和回归
 * 用的是同一套数，不会各算各的。
 *
 * 为什么需要它：讲义笔记的价值全在逐字稿准不准，而准确率不能靠眼睛扫。
 * 这里把「能自动量的」全部量出来：
 *   · 繁体形残留（第③项）
 *   · 幻觉/崩坏段比例（hallucinationScore，cleanup.js 里同一套判据）
 *   · 语速异常（字/秒 > 9 基本是模型在编）
 *   · 标点密度（本地 Whisper 不吐标点，这是引擎差异）
 *   · 高频重复短语（同一句反复出现 = 典型 Whisper 幻觉）
 *   · 主题标题（长块是不是只能起出单词标题）
 */
import { inspectAll } from './quality-metrics.mjs';

// ── 主流程 ──────────────────────────────────────────────────────────
const filter = process.argv[2] || '';
const rows = inspectAll(filter);

if (!rows.length) {
  console.log('没找到匹配的记录' + (filter ? `（过滤：${filter}）` : ''));
  process.exit(0);
}

console.log('转写质量对照报告');
console.log('生成时间：' + new Date().toISOString().replace('T', ' ').slice(0, 19));
console.log('记录数：' + rows.length);
console.log('');

console.log('【一】总表');
console.log(['id', '时长', '段数', '字数', '字/秒', '标点/百字', '主题', '单词标题', '繁体残留', '可疑段', '重复段', '杂符率', 'model'].join(' | '));
for (const r of rows) {
  console.log(
    [
      r.id,
      r.durationMin + '分',
      r.segments,
      r.chars,
      r.charsPerSec,
      r.punctRaw.per100 + '→' + r.punctClean.per100,
      r.topicCountActual,
      r.oneWordHeadings,
      r.traditionalRaw + '→' + r.traditionalClean,
      r.suspectRaw + '→' + r.suspectClean,
      r.repSegCount,
      (r.junkRawRatio * 100).toFixed(3) + '%→' + (r.junkRatio * 100).toFixed(3) + '%',
      r.model,
    ].join(' | ')
  );
}
console.log('');
console.log('判定参考：');
console.log('  字/秒    中文正常语速 3~6；>9 说明模型在编');
console.log('  标点/百字 每百个汉字带多少标点。云端 SenseVoice 12~16；');
console.log('             本地 Whisper 只有 0.5 左右（它不吐标点），这是引擎差异不是清洗把标点吃掉了');
console.log('  主题      离线引擎切出来的主题数（按总时长定，夹在 3~10）');
console.log('  单词标题  标题只有两个字、没有「A与B」结构的个数（长块起不出摘要的信号）');
console.log('  繁体残留 第③项：清洗前 → 清洗后');
console.log('  杂符率   正文码位之外的字符占比，正常 0.000%');
console.log('  重复段   段内 4 字块自己重复自己 >25% 的段数，正常接近 0');
console.log('  可疑段   hallucinationScore ≥ 0.5（只抓重复/语速/无标点，抓不住「整段不通」）');
console.log('  注意：语义通不通自动指标判不了，报告会摊出最可疑的几段原文，请人眼过一遍。');
console.log('');

for (const r of rows) {
  console.log(`【二】${r.id} · ${r.title || '(无标题)'}`);
  console.log(`  模型：${r.model}  引擎：${r.engine}  清洗方式：${r.cleanedBy}`);
  console.log(`  时长：${r.durationSec}秒（${r.durationMin}分）  段数：${r.segments}  字数：${r.chars}`);
  console.log(`  清洗：${r.cleanStatsText}  净变化 ${r.cleanLenDelta > 0 ? '−' : '+'}${Math.abs(r.cleanLenDelta)} 字`);
  console.log(`  可疑段：${r.suspectRaw} → ${r.suspectClean}（占 ${((r.suspectRaw / r.segments) * 100).toFixed(1)}%）`);
  console.log(
    `  段内自发重复：>25% 的段 ${r.repSegCount} 个（占 ${((r.repSegCount / r.segments) * 100).toFixed(1)}%，最高 ${(r.repMax * 100).toFixed(0)}%）` +
      `　杂符率：${(r.junkRawRatio * 100).toFixed(3)}% → ${(r.junkRatio * 100).toFixed(3)}%`
  );
  if (r.junkSample.length) console.log(`  杂符样本：${r.junkSample.join(' ')}`);
  console.log(`  标点密度：${r.punctRaw.per100} → ${r.punctClean.per100}（每百个汉字）　汉字 ${r.punctRaw.han} 个`);
  if (r.headings.length) {
    console.log(`  主题标题（${r.topicCountActual} 个，其中单词标题 ${r.oneWordHeadings} 个）：`);
    r.headings.forEach((h, i) => console.log(`    ${i + 1}. ${h || '(空 → 退成第 N 部分)'}`));
  }
  console.log(`  高频重复短语：${r.repeats.length ? r.repeats.join('、') : '（无）'}`);
  console.log('  开头三段：');
  r.head.forEach((t, i) => console.log(`    [${i}] ${t}`));
  console.log('  最可疑的三段：');
  r.worst.forEach((w) => console.log(`    ${w.sc} @${w.start}s  ${w.text}`));
  console.log('  段内重复最高的五段（请人眼判断是不是在编）：');
  r.worstSegs.forEach((w) => console.log(`    重复${(w.rep * 100).toFixed(0)}% @${w.start}s  ${w.text}`));
  console.log('');
}

console.log('【三】结论');
const bad = rows.filter(
  (r) => r.charsPerSec > 9 || r.suspectRaw / r.segments > 0.2 || r.repSegCount / r.segments > 0.03 || r.junkRatio > 0.001
);
if (!bad.length) {
  console.log('  自动指标（语速、可疑段、段内重复、杂符率）全部在正常范围。');
  console.log('  ⚠ 但这不等于「读得通」—— 语义正确性只能人眼或大模型判。下面摊原文请过目。');
} else {
  for (const r of bad) {
    const why = [];
    if (r.charsPerSec > 9) why.push(`语速 ${r.charsPerSec} 字/秒（正常 3~6）`);
    if (r.suspectRaw / r.segments > 0.2) why.push(`可疑段 ${((r.suspectRaw / r.segments) * 100).toFixed(0)}%`);
    if (r.repSegCount / r.segments > 0.03) why.push(`段内自发重复 ${r.repSegCount} 段（占 ${((r.repSegCount / r.segments) * 100).toFixed(0)}%）`);
    if (r.junkRatio > 0.001) why.push(`杂符率 ${(r.junkRatio * 100).toFixed(3)}%`);
    console.log(`  ${r.id} 质量不达标：${why.join('，')}`);
    console.log(`     现用模型 ${r.model} —— 建议换更大的模型重转（设置里选 large-v3-turbo）。`);
    const w = r.worstSegs[0];
    if (w) console.log(`     重复最高的段：@${w.start}s「${w.text}」`);
  }
}
// 标点密度单独一节：它不是「质量不达标」，而是「引擎能力差异」，判据和上面四条不一样
const lowPunct = rows.filter((r) => r.punctRaw.per100 < 3 && r.punctRaw.han > 500);
if (lowPunct.length) {
  console.log('');
  console.log('  标点密度偏低的记录（每百字 < 3 个标点）：');
  for (const r of lowPunct) {
    console.log(`    ${r.id} ${r.punctRaw.per100} 个/百字 · 引擎 ${r.engine || '(未知)'} · 模型 ${r.model}`);
  }
  console.log('    这是本地 Whisper 不吐标点的固有限制，不是清洗规则吃掉的；云端 SenseVoice 正常 12~16。');
}
console.log('');
console.log('【四】换 turbo 之后怎么用这份报告');
console.log('  1) 界面里对同一条录音点「重新转写」，模型选 large-v3-turbo');
console.log('  2) 再跑一次 node tests/report-quality.mjs');
console.log('  3) 重点看三处变化：开头几段读不读得通、段内自发重复降到几个、杂符率是否归零');
console.log('  4) 语速/段数/字数应该在同一量级 —— 若字数暴涨（如 ×2）多半是模型开始复读了');
