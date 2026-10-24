/**
 * 新表（public/t2s-table.js）的换表前自检：
 *   1. 是不是严格逐字 —— 有没有 key/value 长度不是 1 的（长度变了会破坏字符位置/时间轴对齐）
 *   2. 有没有「繁->繁」这种没意义的条目
 *   3. 有几个候选字的（OpenCC 对一个繁体给多个简体形，如 乾->干/乾）被选成了什么
 *   4. 旧表 169 条真转换条目是否被新表完全覆盖
 *
 * 跑法：node tests/check-t2s-table.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.join(import.meta.dirname, '..');
const { T2S_MAP } = await import(pathToFileURL(path.join(ROOT, 'public', 't2s-table.js')).href);

console.log(`T2S_MAP 条目数 ${T2S_MAP.size}`);

let badLen = 0, selfMap = 0, nonCjkKey = 0, nonCjkVal = 0;
const badLenSamples = [];
for (const [k, v] of T2S_MAP) {
  if ([...k].length !== 1 || [...v].length !== 1) { badLen++; if (badLenSamples.length < 10) badLenSamples.push(`${k}(${[...k].length})->${v}(${[...v].length})`); }
  if (k === v) selfMap++;
  if (!/[\u3400-\u9fff]/.test(k)) nonCjkKey++;
  if (!/[\u3400-\u9fff]/.test(v)) nonCjkVal++;
}
console.log(`  非逐字条目：${badLen}${badLen ? ' -> ' + badLenSamples.join(' ') : ' ✓'}`);
console.log(`  自己映射自己：${selfMap}${selfMap ? ' -> ' + [...T2S_MAP].filter(([k, v]) => k === v).map(([k]) => k).join(' ') : ' ✓'}`);
console.log(`  key 不是汉字：${nonCjkKey}；value 不是汉字：${nonCjkVal}`);

// 需要上下文的字：OpenCC 单字表里给了多候选取第一项，这里列出来给人看
const AMBIG = ['乾', '著', '於', '佈', '飢', '儘', '檯', '歷', '鐘', '锺', '複', '覆', '裏', '裏', '衹', '祇', '彆', '鈎', '鉤', '矇', '懞', '瀰', '祕', '讎', '鹼', '鹼', '茲', '彌', '兇', '慾', '佔', '蹟', '牠', '祂'];
console.log('\n需要上下文的繁体字（新表的选择）：');
const line = [];
for (const c of AMBIG) if (T2S_MAP.has(c)) line.push(`${c}->${T2S_MAP.get(c)}`);
console.log('  ' + line.join(' '));

// 常用繁体字必须收录 —— 早先手写的 200 来条表在真实记录上漏掉了 90% 的繁体字
// （這/時/過/連 全漏），所以这里挑一批只要出现就必须认识的字硬性卡住。
// 注意两个陷阱：
//   1. 不能用「旧表覆盖」来检查 —— 旧表是内联在 cleanup.js 里的手写表，早已删除，
//      它的水平正是被换掉的原因，拿它当基准只会把新表往回拉。
//   2. 繁简同形字（案/行/除/定/言/音/始/束/度/晰 这类）在表里**本来就不该有**，
//      因为生成时 key === value 的「不转换」条目被剔除了。要求它们出现等于要求表出错。
const MUST_HAVE = [
  // 最常用的功能字
  '這', '時', '過', '連', '學', '國', '會', '來', '對', '開', '關', '說', '讓', '從', '們', '個',
  // 转写稿里高频的名词/动词
  '發', '現', '實', '際', '樣', '麼', '為', '與', '隻', '塊', '條', '點', '數', '據', '網',
  '頁', '軟', '體', '檔', '資', '訊', '執', '錯', '誤', '選', '擇', '確', '認', '閉',
  '刪', '設', '語', '轉', '換', '錄', '筆', '標', '題', '質', '雜', '課', '師', '講',
  '圖', '線', '構', '層', '節', '麵', '結', '長', '間', '應', '該', '問', '題', '辦',
];
const missing = MUST_HAVE.filter((c) => {
  const v = T2S_MAP.get(c);
  return v === undefined || v === c;
});
console.log(`\n常用繁体字必须收录（${MUST_HAVE.length} 个）：${missing.length ? '✗ 缺 ' + missing.length + ' 个 -> ' + missing.join(' ') : '✓ 全在'}`);

// 反向抽查：简体字不该被这张表改写（它只做繁->简，简->简 是空转）
// 抽一批简体常用字，命中就说明表里混进了反方向条目。
const MUST_NOT = ['这', '时', '过', '连', '学', '国', '会', '来', '对', '开', '关', '说', '让', '从', '们', '个'];
const reversed = MUST_NOT.filter((c) => { const v = T2S_MAP.get(c); return v !== undefined && v !== c; });
console.log(`简体字不该被改写（${MUST_NOT.length} 个）：${reversed.length ? '✗ 有 ' + reversed.length + ' 个被转了 -> ' + reversed.map((c) => `${c}->${T2S_MAP.get(c)}`).join(' ') : '✓ 都是空转'}`);

// 逐字长度守恒的实证：拿真实记录跑一遍
console.log('\n长度守恒实证（真实记录，逐字符替换后长度必须完全不变）：');
const dirs = fs.readdirSync(path.join(ROOT, 'data', 'lectures'))
  .map((d) => path.join(ROOT, 'data', 'lectures', d, 'transcript.json')).filter((f) => fs.existsSync(f));
for (const f of dirs) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  let bad = 0, changed = 0, total = 0;
  for (const s of j.segments || []) {
    const t = String(s.text || '');
    const out = [...t].map((c) => T2S_MAP.get(c) ?? c).join('');
    total += [...t].length;
    if ([...out].length !== [...t].length) bad++;
    if (out !== t) changed++;
  }
  console.log(`  ${path.basename(path.dirname(f)).slice(0, 8)} 段数 ${(j.segments || []).length}，长度变化段数 ${bad}${bad === 0 ? ' ✓' : ' ✗'}，发生替换的段数 ${changed}，总字 ${total}`);
}
