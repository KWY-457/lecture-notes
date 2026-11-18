/**
 * 「裸文本公式」识别（零依赖）
 *
 * 为什么要有这个文件：
 * 老大 2026-11-18 反馈：笔记里的公式全是 `y = x^2 + 1`、`y^5/2 - y - x^3 = 0`、
 * `x^2/16 + y^2/9 - 1 = 0` 这种纯文本，分数和指数看着费劲。
 *
 * 查过 8 份真实笔记：**带 LaTeX 定界符（`\(` `\[` `$$`）的命中数是 0** ——
 * 模型从来没按 LaTeX 输出过，所以 `public/tex.js` 那套排版一次都没被用上，
 * 全走 `md.js` 的 `inlinePlain()` 原样吐文字。
 *
 * 两条路可以修：① 提示词要求模型写 LaTeX；② 渲染时把裸文本认出来。
 * 这里选 ②，理由：
 *   - 老笔记已经在磁盘上了，改提示词救不回来，用户点开还是那样；
 *   - 14B 本地模型（还有豆包/DeepSeek 这类）对 `\frac` 的服从度不稳，
 *     写错了反而多一层解析风险；
 *   - 纯文本里的 `^` 和 `/` 是**确定的**，识别得准就不会翻车。
 *
 * 设计原则：**宁可不认，也不能认错**。真实笔记里混着大量长得很像公式但不是的东西：
 *   - 工程制图的铅笔型号 `B/2B`、`H/HB`
 *   - 投影面代号 `V/H/W`、点的标记 `a/a'/a"`
 *   - 日期 `2026/11/17`、中文连词 `和/或`
 *   - markdown 链接锚点 `[14:01](#t=841)` 里的 `t=841`
 * 所以规则定得很窄（见 `findBareMath` 的注释）。
 */

/** 能出现在公式里的字符。中文、逗号、引号一律不认，靠它们自然切开公式与正文。 */
const MCHAR = /[A-Za-z0-9.^(){}+\-*/=√²³ⁿπ'\s]/;
const MCHAR_G = /[A-Za-z0-9.^(){}+\-*/=√²³ⁿπ'\s]+/g;

/** 单个「原子」：一串字母数字（可带小数、²³ⁿπ），可再挂一个 `^{...}`；也认整段 `^{...}` */
const ATOM = '(?:[A-Za-z0-9²³ⁿπ√]+(?:\\.[0-9]+)?|\\^\\{[^}]*\\})+';
const GROUP = '\\([^()]*\\)';
const NUM_RE = new RegExp(`(?<![\\w/])(${ATOM})\\s*\\/\\s*(${GROUP}|${ATOM})(?![\\w/])`, 'g');
const SUP_RE = /\^(\{[^}]*\}|\([^()]*\)|[A-Za-z0-9])/g;

/**
 * 括号配平：多出来的右括号从尾部剪，多出来的左括号从头部剪。
 * 剪不平就返回 null（这个片段不认）。
 */
function balance(s) {
  const count = (t) => {
    let n = 0;
    for (const c of t) {
      if (c === '(') n++;
      else if (c === ')') n--;
    }
    return n;
  };
  let t = s.trim().replace(/^[.,;:]+|[.,;:]+$/g, '').trim();
  let n = count(t);
  while (n < 0 && t.endsWith(')')) {
    t = t.slice(0, -1).trimEnd();
    n++;
  }
  while (n > 0 && t.startsWith('(')) {
    t = t.slice(1).trimStart();
    n--;
  }
  return n === 0 ? t : null;
}

/**
 * 把一个裸文本片段翻译成 LaTeX 子集，交给 `public/tex.js` 渲染。
 * 翻译不了（或没变化）就返回空串，调用方保持原样。
 */
export function bareToTex(run) {
  let t = run.trim();
  if (!t || !/[\/^]/.test(t)) return '';
  if (!/[A-Za-z0-9]/.test(t)) return ''; // 纯符号不算
  if (t.length > 60) return ''; // 太长的一定是句子，不是公式
  // 必须有「公式特征」：变量、指数、等号或根号。
  // 只靠 `/` 的话「大概 1/2 的学生」「2026/11/17」都会被当成分数——
  // 前者不是公式，后者是日期，排成分数反而更糟。
  if (!/[A-Za-z^=√²³]/.test(t)) return '';

  // 1) 上下标：^2 → ^{2}，^(-3/2) → ^{-3/2}
  let s = t.replace(SUP_RE, (_, a) => `^{${a.replace(/^\{|\}$/g, '').replace(/^\(|\)$/g, '')}}`);

  // 2) 分数。只认「至少一边带数字」的，且长度不能离谱。
  s = s.replace(NUM_RE, (m, num, den) => {
    const body = den.startsWith('(') && den.endsWith(')') ? den.slice(1, -1) : den;
    // 至少一边要有数字（含 Unicode 上标 ²³）—— `V/H`、`a/a'`、`y/dx` 这种没数字的不认。
    // `d²y/dx²` 要认：那是二阶导数的标准写法，排成分数比斜杠好看。
    if (!/\d/.test(num + body) && !/[²³]/.test(num + body)) return m;
    if (num.length > 10 || body.length > 10) return m;
    // `8.2/9.1 MB` 是比值，不是分数；`3/2` 才是。判据：两边都是小数的多半是比值。
    if (/^\d+\.\d+$/.test(num) && /^\d+\.\d+$/.test(body)) return m;
    if (/^\d+[A-Z]$/.test(body)) return m; // 铅笔型号 B/2B、H/2H
    if (/^[A-Z]\d+$/.test(num)) return m; // 2H/B
    return `\\frac{${num}}{${body}}`;
  });

  // 3) 乘号：` * ` 在公式里就是 ·，别留个星号
  s = s.replace(/\s\*\s/g, '\\cdot ');

  if (s === t) return '';
  return s;
}

/**
 * 找出文本里可以当公式渲染的片段。
 * @param {string} text 已转义、但还没做粗体/斜体/链接的纯文本（可以跨行，但片段不会跨行）
 * @returns {{start:number,end:number,tex:string}[]} 按位置升序、互不重叠
 */
export function findBareMath(text) {
  const src = String(text ?? '');
  const out = [];
  MCHAR_G.lastIndex = 0;
  let m;
  while ((m = MCHAR_G.exec(src))) {
    let raw = m[0];
    let start = m.index;
    // 首尾的空白与句读不属于公式（正则把空格也算进来了，方便 ` * ` 这种中间有空的写法）
    const lead = raw.length - raw.trimStart().length;
    raw = raw.trim();
    start += lead;
    if (!raw) continue;
    if (!/[\/^]/.test(raw)) continue;
    const t = balance(raw);
    if (!t) continue;
    // 剪掉的尾巴要从 end 里扣掉，免得把后面的括号也吃掉
    const end = start + t.length;
    const tex = bareToTex(t);
    if (!tex) continue;
    out.push({ start, end, tex });
  }
  return out;
}

export { MCHAR };
