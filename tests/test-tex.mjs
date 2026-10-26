/**
 * tex.js 的离线测试：LaTeX → HTML / 纯文本。
 *
 * LaTeX 渲染是纯函数，不需要浏览器也不需要服务，所以放离线层。
 * 重点测「课上真会遇到什么」：分数、上下标、希腊字母、函数名正体、
 * 括号自动长高、以及「认不出的命令不能把整篇笔记弄成空白」。
 */
import { hasTex, renderTex, texToText } from '../public/tex.js';

let pass = 0,
  fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name + (detail !== '' ? ' → ' + JSON.stringify(detail) : ''));
  }
};
const BT = String.fromCharCode(92);
const R = (s) => renderTex(s);
const T = (s) => texToText(s);

console.log('\n=== 1. hasTex 快速判定 ===');
check('识别 \\(', hasTex('看 ' + BT + '( x^2 ' + BT + ')'));
check('识别 $$', hasTex('$$ x $$'));
check('识别 \\[', hasTex(BT + '[ x ' + BT + ']'));
check('纯中文不误判', !hasTex('今天讲高阶导数'));

console.log('\n=== 2. 上下标 ===');
check('x^2 → ²', R('x^2').includes('²'), R('x^2'));
check('x_1 → ₁', R('x_1').includes('₁'), R('x_1'));
check('a^{n+1} → ⁿ⁺¹', R('a^{n+1}').includes('ⁿ⁺¹'), R('a^{n+1}'));
check('u^{(n-k)} 有 sup 标签或 Unicode', /tex-sup|⁽/.test(R('u^{(n)}')), R('u^{(n)}'));

console.log('\n=== 3. 分数 ===');
check('\frac 出 tex-frac', R(BT + 'frac{a}{b}').includes('tex-frac'), '');
check('分子分母都在', R(BT + 'frac{a}{b}').includes('>a<') && R(BT + 'frac{a}{b}').includes('>b<'), R(BT + 'frac{a}{b}'));
check('嵌套分数不崩', R(BT + 'frac{' + BT + 'frac{1}{2}}{3}').includes('tex-frac'), '');

console.log('\n=== 4. 希腊字母与运算符 ===');
check('\pi → π', R(BT + 'pi').includes('π'), R(BT + 'pi'));
check('\alpha → α', R(BT + 'alpha').includes('α'), '');
check('\sum → ∑', R(BT + 'sum_{k=0}^n').includes('∑'), R(BT + 'sum_{k=0}^n'));
check('\cdot → ·', R('a ' + BT + 'cdot b').includes('·'), '');
check('\times → ×', R('a ' + BT + 'times b').includes('×'), '');

console.log('\n=== 5. 函数名正体 ===');
check('\sin 走 tex-fn', R(BT + 'sin x').includes('tex-fn'), R(BT + 'sin x'));
check('\ln 走 tex-fn', R(BT + 'ln x').includes('tex-fn'), '');
check('\lim 走 tex-fn', R(BT + 'lim_{x ' + BT + 'to 0}').includes('tex-fn'), '');

console.log('\n=== 6. 括号与杂项 ===');
check(BT + 'left/right 不产生未识别命令', !R(BT + 'left( x ' + BT + 'right)').includes('tex-unknown'), R(BT + 'left( x ' + BT + 'right)'));
check('\sqrt 出根号', R(BT + 'sqrt{x}').includes('√'), R(BT + 'sqrt{x}'));
check(BT + 'binom 转成 C(n,k)', T(BT + 'binom{n}{k}').includes('C(n,k)'), T(BT + 'binom{n}{k}'));

console.log('\n=== 7. 认不出的命令不能白屏 ===');
check('未识别命令仍返回内容', R(BT + 'foobar x').length > 0, R(BT + 'foobar x'));
check('未识别命令有标记', R(BT + 'foobar x').includes('tex-unknown'), R(BT + 'foobar x'));
check('空输入不崩', R('').length > 0, R(''));

console.log('\n=== 8. texToText 纯文本（导出 Word 用）===');
check('分数 → (a)/(b)', T(BT + 'frac{a}{b}') === '(a)/(b)', T(BT + 'frac{a}{b}'));
check('上标单词不加括号', T('u^{(n)}') === 'u⁽ⁿ⁾', T('u^{(n)}'));
check('上标多字符带括号', T('e^{2x}') === 'e^(2x)', T('e^{2x}'));
check('本身带括号不再套一层', T('u^{(n-k)}') === 'u^(n-k)', T('u^{(n-k)}'));
check('下标一样处理', T('x_1') === 'x₁', T('x_1'));
check('sin 出来是 sin', T(BT + 'sin x').replace(/\s/g, '') === 'sinx', T(BT + 'sin x'));
check('输出里没有反斜杠', !T(BT + 'frac{1}{2}' + BT + 'cdot ' + BT + 'sqrt{3}').includes(BT), T(BT + 'frac{1}{2}' + BT + 'cdot ' + BT + 'sqrt{3}'));
check('输出里没有花括号', !T('a^{n+1}').includes('{'), T('a^{n+1}'));
check('输出里没有 ^ _', !/[\^_]/.test(T('x^2 + y_1')), T('x^2 + y_1'));

console.log('\n=== 9. 极端输入不崩 ===');
for (const bad of ['{', '}', BT, BT + 'frac', BT + 'frac{', '{{{{', '^^^', '___', BT + 'sqrt[', '$']) {
  let ok = true;
  try {
    R(bad);
    T(bad);
  } catch {
    ok = false;
  }
  check('不崩：' + JSON.stringify(bad), ok, bad);
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
