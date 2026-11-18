/**
 * 裸文本公式识别（public/math.js）的回归测试。
 *
 * 背景：老大 2026-11-18 反馈笔记里的公式全是 `y = x^2 + 1`、`x^2/16 + y^2/9 - 1 = 0`
 * 这种纯文本，分数和指数看着费劲。查过 8 份真实笔记，**带 LaTeX 定界符的命中数是 0** ——
 * 模型从来没按 LaTeX 输出过，所以 tex.js 那套排版一次都没被用上。
 *
 * 这个测试守两件事：
 *   1. 该认的认出来（`^` 变上标、`a/b` 变分数、`√`/`π` 保留）；
 *   2. **不该认的一个都不许认** —— 真实笔记里混着大量长得很像公式的东西：
 *      铅笔型号 `B/2B`、投影面 `V/H/W`、点的标记 `a/a'`、日期 `2026/11/17`、
 *      比值 `8.2/9.1`、中文连词 `和/或`、markdown 锚点 `[14:01](#t=841)`。
 *      认错了比不认更糟：用户看到的是被排错的公式。
 */
import { findBareMath, bareToTex } from '../public/math.js';
import { renderMarkdown } from '../public/md.js';
import { renderTex } from '../public/tex.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ' → ' + detail : ''}`);
  }
};

console.log('\n=== 1. 该认的公式 ===');
const SHOULD = [
  ['y = x^2 + 1', 'x^{2}'],
  ['y^5/2 - y - x^3 = 0', '\\frac{y^{5}}{2}'],
  ["5/2 * y^(3/2) * y' - y' - 3x^2 = 0", '\\cdot'],
  ['椭圆x^2/16 + y^2/9 - 1 = 0在点(2, 3/2)处', '\\frac{x^{2}}{16}'],
  ["y' = -9x / (16y)", '\\frac{9x}{16y}'],
  ['√(2x-x²)的二阶导数为(2x-x²)^(-3/2)', '^{-\\frac{3}{2}}'],
  ['面积是 x^2', 'x^{2}'],
  ['- 切线方程为y - 3/2 = -3/4 * (x - 2)', '\\frac{3}{4}'],
  ['二阶导数可表示为d²y/dx²', '\\frac{d²y}{dx²}'],
];
for (const [src, must] of SHOULD) {
  const hits = findBareMath(src);
  const tex = hits.map((h) => h.tex).join(' ');
  ok(`认出「${src.slice(0, 26)}」`, hits.length > 0 && tex.includes(must), `tex=${JSON.stringify(tex)}`);
}

console.log('\n=== 2. 不该认的一个都不许认 ===');
const SHOULD_NOT = [
  'B/2B画粗线',
  'H型画细线，HB写字',
  '- 准备H/HB/B三种型号铅笔及圆规、三角板 [17:52](#t=1072)',
  '三投影面（V/H/W）互相垂直',
  '点的标记规则（a/a\'/a"）',
  '2026/11/17 更新',
  '和/或',
  '大概 1/2 的学生',
  '文件约 8.2/9.1 MB',
  '比值是 3/4，不是 4/3',
  '接口地址：https://api.siliconflow.cn/v1/audio/transcriptions',
  '## 2. 隐函数求导方法 [01:08 - 06:00]',
  '看 https://www.gnu.org/licenses/agpl-3.0.html 这一页',
];
for (const src of SHOULD_NOT) {
  const hits = findBareMath(src);
  ok(`不认「${src.slice(0, 26)}」`, hits.length === 0, `认了 ${hits.length} 段：${hits.map((h) => h.tex).join(' | ')}`);
}

console.log('\n=== 3. 渲染出来必须能兜住，不许抛 ===');
const RISKY = ['x^', 'y^962009329', '/2', 'a//b', '((((x^2))))', '^^^^', 'x^2/', 'x^2/()', '\\\\frac{', 'y^(', 'y^)'];
for (const src of RISKY) {
  let threw = null;
  try {
    const hits = findBareMath(src);
    for (const h of hits) renderTex(h.tex);
  } catch (e) {
    threw = e.message;
  }
  ok(`不崩：「${src}」`, !threw, threw || '');
}

console.log('\n=== 4. 行内 Markdown 与公式共存 ===');
{
  const h = renderMarkdown('**粗体 x^2 里嵌公式**');
  ok('粗体里的公式也排了', h.includes('tex-sup'), h);
}
{
  const h = renderMarkdown('- 切线方程为y - 3/2 = -3/4 * (x - 2) [06:30](#t=390)');
  ok('时间戳链接没被公式吃掉', h.includes('class="ts"') && h.includes('data-t="390"'), h);
  ok('同一行里的分数排出来了', h.split('tex-frac').length - 1 >= 2, h);
}
{
  const h = renderMarkdown('文档在 `public/api-tutorial.md` 里');
  ok('行内代码保持原样', h.includes('<code>public/api-tutorial.md</code>'), h);
}
{
  const h = renderMarkdown('`a/b` 是路径，3x/4 是分数');
  ok('代码里的 a/b 不动', h.includes('<code>a/b</code>'), h);
  ok('同一行的 3x/4 被认出来', h.includes('\\frac') || h.includes('tex-frac'), h);
  // 裸 `3/4`（没有变量、没有 ^ = √）刻意不认 —— 中文正文里「比值是 3/4」远比公式常见，
  // 认错了会把它排成竖式分数，反而更难看懂。真正是公式的时候它总挨着变量，
  // 例如「切线方程为y - 3/2 = -3/4 * (x - 2)」那一段整段就带 y 和 =，会被认出来。
  const h2 = renderMarkdown('比值是 3/4，不是 4/3');
  ok('裸比值 3/4 不排成竖式分数', !h2.includes('tex-frac'), h2);
}
{
  const h = renderMarkdown('y = x^2 + 1 与 y = x^3 两式');
  ok('一行里两段公式都排了', h.split('class="tex"').length - 1 === 2, h);
}

console.log('\n=== 5. 快路径：没有 / 和 ^ 的文本一个字都不许变 ===');
{
  const src = '这是一段普通的中文，没有任何公式，也没有斜杠和上标。';
  const h = renderMarkdown(src);
  ok('普通中文原样输出', h === `<p>${src}</p>`, h);
}

console.log('\n=== 6. bareToTex 的边界 ===');
ok('空串返回空', bareToTex('') === '');
ok('没有斜杠上标返回空', bareToTex('普通句子') === '');
ok('太长的片段不认', bareToTex('a'.repeat(80) + '/b') === '');
ok('纯符号不认', bareToTex('///^^^') === '');

console.log(`\n${fail ? '❌' : '✅'} 裸文本公式：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
