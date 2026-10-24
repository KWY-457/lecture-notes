/**
 * 从 OpenCC 的 TSCharacters.txt 生成 public/t2s-table.js
 *
 * 用法：
 *   node tests/gen-t2s.mjs <TSCharacters.txt>
 *
 * 为什么不用手写表：手写只能覆盖脑子里想得起来的字。实测手写表只有 200 来个 key，
 * 而真实转写记录里每 100 个繁体字有 90+ 个它认不出来（這/時/過/連 全漏）。
 *
 * 收表规则（每条都是刻意的）：
 *   - 只收**单字 1:1** 映射；key === value 的「不转换」条目剔除（转了等于没转）。
 *   - 多候选行（如 `乾  干 乾`）取第一候选，这是 OpenCC 自己的默认选择。
 *   - 只收基本平面（BMP）：补充平面字（U+20000+）很多字体显示成豆腐块，
 *     收进来只会让「不明字符」更多。
 *   - 生成后**自检键序**：FLAT 里偶数位必须是繁体、奇数位必须是简体。
 *     早先一版把键值写反了（存成简->繁），查「過」返回 undefined，
 *     于是覆盖率提升看起来是 6.84 倍、实际一次都没转成功 —— 这个自检就是防它。
 */

import fs from 'node:fs';
import path from 'node:path';

const SRC = process.argv[2];
const OUT = path.join(import.meta.dirname, '..', 'public', 't2s-table.js');

if (!SRC) {
  console.error('用法: node tests/gen-t2s.mjs <TSCharacters.txt>');
  process.exit(1);
}

const raw = fs.readFileSync(SRC, 'utf8');
const lines = raw.split(/\r?\n/);

/** @type {Map<string, string>} 繁 -> 简 */
const map = new Map();
const skipped = { selfMap: 0, notSingle: 0, supplement: 0, header: 0 };

for (const line of lines) {
  if (!line || line.startsWith('#')) { skipped.header++; continue; }
  const tab = line.indexOf('\t');
  if (tab < 0) { skipped.header++; continue; }

  // 第一列 = 繁体字（OpenCC 的 key），第二列 = 简体候选（空格分隔，第一个是默认答案）
  const trad = line.slice(0, tab).trim();
  const cands = line.slice(tab + 1).trim().split(/\s+/).filter(Boolean);
  const simp = cands[0] || '';

  if ([...trad].length !== 1 || [...simp].length !== 1) { skipped.notSingle++; continue; }
  if (trad === simp) { skipped.selfMap++; continue; }
  if (trad.codePointAt(0) > 0xffff || simp.codePointAt(0) > 0xffff) { skipped.supplement++; continue; }
  if (map.has(trad)) continue; // 同 key 只留第一条
  map.set(trad, simp);
}

// 按繁体字码位排序，保证生成结果稳定可 diff
const uniq = [...map.entries()].sort((a, b) => a[0].codePointAt(0) - b[0].codePointAt(0));

// 自检 1：方向。抽查几个只会是繁体、且简体写法不同的字
const DIRECTION_PROBE = ['這', '時', '過', '連', '們', '還', '說', '課', '後', '裡'];
const badDir = DIRECTION_PROBE.filter((c) => {
  const v = map.get(c);
  return !v || v.codePointAt(0) === c.codePointAt(0);
});
if (badDir.length) {
  console.error(`✗ 方向自检失败：这些繁体字查不到不同的简体写法 -> ${badDir.join(' ')}`);
  console.error('  说明表被写反了（存成了简->繁）。已中止，没有写出文件。');
  process.exit(1);
}
// 自检 2：反向。简体字不应该成为 key（少数同形字除外），抽查几个纯简体字
const REVERSE_PROBE = ['们', '这', '时', '过', '连', '还', '说'];
const badRev = REVERSE_PROBE.filter((c) => map.has(c));
if (badRev.length) {
  console.error(`✗ 反向自检失败：简体字出现在 key 里 -> ${badRev.join(' ')}`);
  process.exit(1);
}

// 紧凑编码：每对正好 2 个 BMP 字符，拼成一条字符串，运行时两两切片。
// 比对象字面量小一半以上，也不用担心转义。
const FLAT = uniq.map(([t, s]) => t + s).join('');

// 自检 3：FLAT 的奇偶位必须与 map 完全一致（防止拼接错位）
let mismatch = 0;
for (let i = 0, n = 0; i < FLAT.length; i += 2, n++) {
  if (FLAT[i] !== uniq[n][0] || FLAT[i + 1] !== uniq[n][1]) mismatch++;
}
if (mismatch) {
  console.error(`✗ 拼装自检失败：FLAT 有 ${mismatch} 处错位`);
  process.exit(1);
}

const out = `/**
 * 繁 -> 简 单字对照表（自动生成，请勿手改）
 *
 * 来源：OpenCC TSCharacters.txt（Apache-2.0，https://github.com/ByVoid/OpenCC）
 * 生成：node tests/gen-t2s.mjs <TSCharacters.txt>
 * 条数：${uniq.length}
 *
 * 收录规则：单字 1:1；key === value 的「不转换」条目剔除；只收基本平面。
 * 生成时带三道自检（方向 / 反向 / 拼装错位），任何一道不过就不写文件。
 *
 * 术语说明：本表做的是「繁体字 -> 简体字」的**字形**转换，
 * 不是台湾用词 -> 大陆用词的**词汇**转换（如 軟體/軟件、螢幕/屏幕），
 * 后者要另一张词表，本表不涉及，所以「計程車」会变成「计程车」而不是「出租车」，
 * 这是刻意的：字形转换不该改动老师的用词。
 */

// 每两个字符为一组：[繁, 简]，偶数位是繁体、奇数位是简体
const FLAT = '${FLAT}';

/** 繁体字 -> 简体字 */
export const T2S_MAP = (() => {
  const m = new Map();
  for (let i = 0; i < FLAT.length; i += 2) m.set(FLAT[i], FLAT[i + 1]);
  return m;
})();

/** 包含任意繁体字的字符类正则，用于快速判断一段文本要不要走清理 */
export const T2S_RE = new RegExp('[' + [...T2S_MAP.keys()].join('') + ']');

export const T2S_COUNT = ${uniq.length};
`;

fs.writeFileSync(OUT, out, 'utf8');

// 写完之后再 import 回来验一遍「文件里真实生效的行为」，不信内存里的对象
const mod = await import(new URL(`file:///${OUT.replace(/\\/g, '/')}`).href);
const live = mod.T2S_MAP;
const liveBad = DIRECTION_PROBE.filter((c) => live.get(c) !== map.get(c));
console.log(`已生成 ${OUT}`);
console.log(`  映射 ${uniq.length} 条，FLAT 长度 ${FLAT.length}，文件 ${fs.statSync(OUT).size} 字节`);
console.log(`  跳过：自映射 ${skipped.selfMap}，非单字 ${skipped.notSingle}，补充平面 ${skipped.supplement}，注释/表头 ${skipped.header}`);
console.log(`  回读校验：T2S_MAP.size=${live.size}，方向抽查 ${DIRECTION_PROBE.length} 个${liveBad.length ? ' 有 ' + liveBad.length + ' 个不一致 -> ' + liveBad.join(' ') : '全部一致'}`);
console.log(`  样例：${DIRECTION_PROBE.slice(0, 6).map((c) => `${c}->${live.get(c)}`).join('  ')}`);
