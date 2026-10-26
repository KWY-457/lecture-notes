import fs from 'node:fs';

const css = fs.readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail !== '' ? ' → ' + JSON.stringify(detail) : '')); }
};

// 把某条选择器的声明块抠出来（只处理最扁的一层，够用）
// 必须按行首锚定：`.tex-sqrt` 在 :313 那个逗号组里也出现过，
// 直接 indexOf('.tex-sqrt') 会抓到那一段，测试就查错了地方。
function block(sel) {
  const want = String(sel).replace(/\s*\{$/, '').trim();
  const lines = css.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t.startsWith(want) || !t.includes('{')) continue;
    // 选择器必须就是这一个（不能是逗号组里的一段）
    const head = t.slice(0, t.indexOf('{')).trim();
    if (head !== want) continue;
    let body = t.slice(t.indexOf('{') + 1);
    if (body.includes('}')) return body.slice(0, body.indexOf('}'));
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].includes('}')) return body + '\n' + lines[j].slice(0, lines[j].indexOf('}'));
      body += '\n' + lines[j];
    }
    return body;
  }
  return null;
}

console.log('=== 1. 分数对齐数学轴 ===');
{
  const b = block('.tex-frac');
  check('找到 .tex-frac 规则', !!b, b === null);
  check('分数用 vertical-align: middle', !!b && /vertical-align\s*:\s*middle/.test(b), b && b.match(/vertical-align[^;]*/)?.[0]);
  // 负 em 是把底部往下挪，分数有 2 行多高，一挪就沉到基线底下 —— 2026-10-26 就是 -.46em 出的问题
  check('不再用负 em 对齐', !!b && !/vertical-align\s*:\s*-?\.?\d*\.?\d+em/.test(b), b && b.match(/vertical-align[^;]*/)?.[0]);
  check('上下叠用 flex column', !!b && /flex-direction\s*:\s*column/.test(b), b && b.match(/flex-direction[^;]*/)?.[0]);
}

console.log('\n=== 2. 根号对齐 ===');
{
  const b = block('.tex-sqrt {');
  check('找到 .tex-sqrt 规则', !!b, b === null);
  check('根号用 vertical-align: middle', !!b && /vertical-align\s*:\s*middle/.test(b), b && b.match(/vertical-align[^;]*/)?.[0]);
}

console.log('\n=== 3. 括号跟着内容长高 ===');
{
  check('有 :has(.tex-frac) 的弹性括号规则', css.includes(':has(.tex-frac)'), '');
  check('有 :has(.tex-sqrt) 的弹性括号规则', css.includes(':has(.tex-sqrt)'), '');
  const i = css.indexOf('.tex:has(.tex-frac)');
  const seg = i < 0 ? '' : css.slice(i, i + 600);
  const m = seg.match(/scaleY\(([\d.]+)\)/);
  check('括号纵向拉伸 1.4~1.8 倍（实测 1.6 最好）', !!m && Number(m[1]) >= 1.4 && Number(m[1]) <= 1.8, m && m[0]);
  check('拉伸用 inline-block（否则 transform 不生效）', /display\s*:\s*inline-block/.test(seg), '');
  check('transform-origin 是 center', /transform-origin\s*:\s*center/.test(seg), '');
}

console.log('\n=== 4. 数学字体与显示公式 ===');
{
  const b = block('.tex {');
  check('公式用衬线数学字体', !!b && /Cambria Math|Times New Roman/.test(b), '');
  check('公式默认斜体', !!b && /font-style\s*:\s*italic/.test(b), '');
  const d = block('.tex-display');
  check('显示公式居中独占一行', !!d && /display\s*:\s*block/.test(d) && /text-align\s*:\s*center/.test(d), '');
}

console.log('\n=== 5. 兜底不能白屏 ===');
{
  check('有 .tex-raw 兜底样式', css.includes('.tex-raw'), '');
  check('有 .tex-unknown 样式', css.includes('.tex-unknown'), '');
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
