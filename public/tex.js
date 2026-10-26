/**
 * 极简 LaTeX 子集渲染器（零依赖）
 *
 * 为什么要有这个文件：模型写数学课（高数、线代、物理、化学）的笔记时，
 * 公式一律写成 `\( y = f(x) \)`、`\( \frac{d^2y}{dx^2} \)` 这种 LaTeX。
 * 原来的 `public/md.js` 不认识这对定界符，把整串原样当文字输出，
 * 界面上就是一堆 `\frac{d^2y}{dx^2}` —— 高数课几乎没法看。
 *
 * 设计取舍：
 *   - **不用 KaTeX / MathJax**。它们各 200KB~1MB，我们是零依赖单页应用，
 *     为 13 种命令引入一个比自己整个前端还大的库不划算。
 *   - **不用 MathML**。Chrome 111 才正式支持，而且不同浏览器字形差异很大。
 *   - 输出**纯 HTML + CSS**（`<sup>` / `<sub>` / 用 flex 做分数），
 *     任何浏览器、任何字号下都能正确显示，排版也够看。
 *
 * 支持的子集（覆盖真实笔记里出现的全部 13 种命令 + 常见补充）：
 *   `\frac \dfrac \tfrac` `\sqrt[n]{}` `\binom` `\left \right` `\mathrm \text \mathbf`
 *   `^` `_` 上下标、希腊字母、运算符（`\cdot \pm \sum \int` …）、函数名（`\sin \ln` …）
 *
 * 不支持（遇到就原样显示命令名，不会崩）：矩阵、多行对齐、`\over`、自定义宏。
 */

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 希腊字母。大写只列常用的几个 —— 数学笔记里几乎不出现大写希腊字母。 */
const GREEK = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', varpi: 'ϖ',
  rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'ϕ',
  chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};

/** 运算符 / 关系符 / 箭头。big 那些在显示模式下要放大。 */
const SYMBOL = {
  cdot: '·', times: '×', div: '÷', ast: '∗', star: '⋆', bullet: '•',
  pm: '±', mp: '∓', leq: '≤', le: '≤', geq: '≥', ge: '≥',
  neq: '≠', ne: '≠', approx: '≈', equiv: '≡', sim: '∼', simeq: '≃',
  ll: '≪', gg: '≫', propto: '∝', infty: '∞',
  sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', oint: '∮',
  partial: '∂', nabla: '∇', emptyset: '∅', varnothing: '∅',
  to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒', Leftarrow: '⇐',
  leftrightarrow: '↔', Leftrightarrow: '⇔', mapsto: '↦',
  cdots: '⋯', ldots: '…', dots: '…', vdots: '⋮', ddots: '⋱',
  prime: '′', circ: '∘', degree: '°', deg: '°',
  angle: '∠', perp: '⊥', parallel: '∥',
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', supset: '⊃', subseteq: '⊆', supseteq: '⊇',
  cup: '∪', cap: '∩', setminus: '∖',
  forall: '∀', exists: '∃', nexists: '∄', neg: '¬', land: '∧', lor: '∨',
  therefore: '∴', because: '∵',
  lbrace: '{', rbrace: '}', langle: '⟨', rangle: '⟩',
  lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉',
  lvert: '|', rvert: '|', vert: '|', Vert: '‖',
  quad: '\u2003', qquad: '\u2003\u2003', ' ': '\u2009', ',': '\u2009', ';': '\u2005', ':': '\u2005',
};

/** 放大显示的运算符（和上下标组合才有意义） */
const BIGOP = new Set(['sum', 'prod', 'coprod', 'int', 'iint', 'oint']);

/**
 * 正体函数名。LaTeX 里 `\sin` 是正体、`sin` 是斜体变量乘积，这个区别对数学课很重要
 * （`sin x` 和 `s·i·n·x` 不是一回事）。
 */
const FUNC = new Set([
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc',
  'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'coth',
  'ln', 'lg', 'log', 'exp',
  'lim', 'limsup', 'liminf', 'max', 'min', 'sup', 'inf',
  'det', 'gcd', 'lcm', 'dim', 'ker', 'deg', 'arg', 'mod', 'bmod', 'pmod',
]);

/** 上标里能直接用 Unicode 上标字符的，用它比 `<sup>` 更紧凑 */
const SUP_CHAR = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ' };
const SUB_CHAR = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉', '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎', a: 'ₐ', e: 'ₑ', o: 'ₒ', x: 'ₓ', k: 'ₖ', n: 'ₙ', i: 'ᵢ', j: 'ⱼ' };

/** 有没有公式 —— 给调用方做快速路径，避免每段都跑一遍正则 */
export function hasTex(s) {
  const t = String(s || '');
  return t.includes('\\(') || t.includes('\\[') || t.includes('$$');
}

/**
 * 把一段 LaTeX 渲染成 HTML。
 * @param {string} src   公式正文（不含 `\(` `\)` 定界符）
 * @param {{display?: boolean}} [opts] display=true 时按独立公式排版（居中、整体放大）
 */
export function renderTex(src, opts = {}) {
  const raw = String(src || '').trim();
  let html;
  try {
    html = texToHtml(raw);
  } catch {
    // 解析器有 bug 也不能让整篇笔记白屏 —— 退回原样显示
    html = `<span class="tex-raw">${esc(raw)}</span>`;
  }
  const cls = opts.display ? 'tex tex-display' : 'tex';
  return `<span class="${cls}">${html}</span>`;
}

function texToHtml(s) {
  let i = 0;

  /** 取一个参数：`{...}` 整组，或单个命令，或单个字符 */
  function arg() {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s[i] === '{') {
      i++;
      let depth = 1;
      const start = i;
      while (i < s.length) {
        if (s[i] === '\\') { i += 2; continue; }
        if (s[i] === '{') depth++;
        else if (s[i] === '}') { depth--; if (!depth) break; }
        i++;
      }
      const body = s.slice(start, i);
      i++; // 吃掉 }
      return body;
    }
    if (s[i] === '\\') {
      const m = /^\\([a-zA-Z]+|.)/.exec(s.slice(i));
      if (m) { i += m[0].length; return m[0]; }
    }
    const ch = s[i] || '';
    i++;
    return ch;
  }

  /** 取可选的 `[...]` 参数（`\sqrt[3]{x}` 的 3） */
  function optArg() {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s[i] !== '[') return null;
    const j = s.indexOf(']', i);
    if (j < 0) return null;
    const body = s.slice(i + 1, j);
    i = j + 1;
    return body;
  }

  /** `\left` / `\right` 后面的那个定界符 */
  function delim() {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s[i] === '\\') {
      const m = /^\\([a-zA-Z]+|.)/.exec(s.slice(i));
      if (!m) { i++; return ''; }
      i += m[0].length;
      const n = m[1];
      if (n === '{' || n === 'lbrace') return '{';
      if (n === '}' || n === 'rbrace') return '}';
      return SYMBOL[n] || '';
    }
    const ch = s[i] || '';
    i++;
    return ch === '.' ? '' : ch; // `\left.` 是「不画这一侧的括号」
  }

  function sup(inner) {
    const plain = inner.replace(/\s/g, '');
    if (plain.length && [...plain].every((c) => SUP_CHAR[c])) {
      return `<span class="tex-sup">${[...plain].map((c) => SUP_CHAR[c]).join('')}</span>`;
    }
    return `<sup>${texToHtml(inner)}</sup>`;
  }
  function sub(inner) {
    const plain = inner.replace(/\s/g, '');
    if (plain.length && [...plain].every((c) => SUB_CHAR[c])) {
      return `<span class="tex-sub">${[...plain].map((c) => SUB_CHAR[c]).join('')}</span>`;
    }
    return `<sub>${texToHtml(inner)}</sub>`;
  }

  function frac(num, den, bar = true) {
    return (
      '<span class="tex-frac' + (bar ? '' : ' tex-frac-nobar') + '">' +
      `<span class="tex-num">${texToHtml(num)}</span>` +
      `<span class="tex-den">${texToHtml(den)}</span>` +
      '</span>'
    );
  }

  let out = '';
  while (i < s.length) {
    const c = s[i];

    if (c === '^') { i++; out += sup(arg()); continue; }
    if (c === '_') { i++; out += sub(arg()); continue; }
    if (c === '{') { out += texToHtml(arg()); continue; }
    if (c === '}') { i++; continue; } // 落单的右括号，忽略

    if (c === '\\') {
      const m = /^\\([a-zA-Z]+|.)/.exec(s.slice(i));
      if (!m) { i++; continue; }
      const name = m[1];
      i += m[0].length;

      if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
        const a = arg();
        const b = arg();
        out += frac(a, b);
        continue;
      }
      if (name === 'sqrt') {
        const idx = optArg();
        const a = arg();
        out +=
          '<span class="tex-sqrt">' +
          (idx ? `<span class="tex-idx">${texToHtml(idx)}</span>` : '') +
          '<span class="tex-radical">√</span>' +
          `<span class="tex-radicand">${texToHtml(a)}</span>` +
          '</span>';
        continue;
      }
      if (name === 'binom' || name === 'dbinom' || name === 'tbinom') {
        const n = arg();
        const k = arg();
        out +=
          '<span class="tex-bin">' +
          '<span class="tex-delim">(</span>' +
          frac(n, k, false) +
          '<span class="tex-delim">)</span>' +
          '</span>';
        continue;
      }
      if (name === 'left' || name === 'right' || name === 'middle') {
        const d = delim();
        out += d ? `<span class="tex-delim">${esc(d)}</span>` : '';
        continue;
      }
      if (name === 'mathrm' || name === 'text' || name === 'mathbf' || name === 'mathit' || name === 'operatorname' || name === 'mathsf') {
        const a = arg();
        // 这里面是文字，不该再当公式解析（`\text{若 x>0}` 的 x 要原样）
        const cls = name === 'mathbf' ? 'tex-rm tex-bold' : 'tex-rm';
        out += `<span class="${cls}">${esc(stripCommands(a))}</span>`;
        continue;
      }
      if (name === '\\') { out += '<br>'; continue; } // 换行
      if (name === '!' || name === 'displaystyle' || name === 'limits' || name === 'nolimits') continue;
      if (GREEK[name]) { out += `<span class="tex-greek">${GREEK[name]}</span>`; continue; }
      if (SYMBOL[name] !== undefined) {
        const v = SYMBOL[name];
        if (BIGOP.has(name)) out += `<span class="tex-bigop">${v}</span>`;
        else if (/[\u2000-\u200f]/.test(v)) out += `<span class="tex-sp">${v}</span>`;
        else out += `<span class="tex-sym">${v}</span>`;
        continue;
      }
      if (FUNC.has(name)) { out += `<span class="tex-fn">${name}</span>`; continue; }
      // 不认识的命令：把命令名原样显示，比默默吞掉好 —— 用户能看出「这里没渲染」
      out += `<span class="tex-unknown">${esc(name)}</span>`;
      continue;
    }

    if (/\s/.test(c)) { out += ' '; i++; continue; }
    // 单引号在数学里是导数符号，用撇号排版（y'' → y″）
    if (c === "'") { out += '<span class="tex-prime">′</span>'; i++; continue; }
    out += esc(c);
    i++;
  }
  return out;
}

/** `\text{...}` 里可能还带简单命令，去掉反斜杠让文字能读 */
function stripCommands(a) {
  return String(a || '')
    .replace(/\\([a-zA-Z]+)/g, (m, n) => GREEK[n] || (SYMBOL[n] !== undefined && !BIGOP.has(n) ? SYMBOL[n] : n))
    .replace(/\\(.)/g, '$1');
}

/**
 * 公式 → 纯文本。给 Word 导出用（Word 的 OMML 太复杂，这里退一步给可读的 Unicode）。
 * 例：`\frac{d^2y}{dx^2}` → `(d²y)/(dx²)`，`\sin\left(x+\frac{\pi}{2}\right)` → `sin(x+π/2)`
 */
export function texToText(src) {
  const t = String(src || '').trim();

  /**
   * 内部递归解析一段字符串。**每次调用都独立持有一个游标**：
   * 一开始写成共享外层 `i` + 进出时 save/restore，结果 `dx^2` 解析成 `dx⁼` ——
   * 因为 arg() 在读参数时改的是全局游标，restore 把「读到哪了」一起还原了。
   */
  function parse(s) {
    let k = 0;

    function arg() {
      while (k < s.length && /\s/.test(s[k])) k++;
      if (s[k] === '{') {
        k++;
        let depth = 1;
        const start = k;
        while (k < s.length) {
          if (s[k] === '\\') { k += 2; continue; }
          if (s[k] === '{') depth++;
          else if (s[k] === '}') { depth--; if (!depth) break; }
          k++;
        }
        const body = s.slice(start, k);
        k++;
        return body;
      }
      if (s[k] === '\\') {
        const m = /^\\([a-zA-Z]+|.)/.exec(s.slice(k));
        if (m) { k += m[0].length; return m[0]; }
      }
      const ch = s[k] || '';
      k++;
      return ch;
    }

    const toSup = (x) => {
      const p = x.replace(/\s/g, '');
      if (!(p.length && [...p].every((c) => SUP_CHAR[c]))) {
        // 拼不出 Unicode 上标时退回 `^n` 这种紧凑写法；只有多字符才加括号。
        // 单词加引号没必要（`u^n` 这种一眼就懂，还能省掉满屏的括号）。
        // 本身已经带一层括号的（`^{(n-k)}`）就不再套第二层，否则成 `^((n-k))`。
        const body = parse(x);
        if ([...body].length <= 1) return '^' + body;
        return /^\(.*\)$/.test(body) ? '^' + body : '^(' + body + ')';
      }
      return [...p].map((c) => SUP_CHAR[c]).join('');
    };
    const toSub = (x) => {
      const p = x.replace(/\s/g, '');
      if (!(p.length && [...p].every((c) => SUB_CHAR[c]))) {
        const body = parse(x);
        if ([...body].length <= 1) return '_' + body;
        return /^\(.*\)$/.test(body) ? '_' + body : '_(' + body + ')';
      }
      return [...p].map((c) => SUB_CHAR[c]).join('');
    };

    let out = '';
    while (k < s.length) {
      const c = s[k];
      if (c === '^') { k++; out += toSup(arg()); continue; }
      if (c === '_') { k++; out += toSub(arg()); continue; }
      if (c === '{') { const a = arg(); out += parse(a); continue; }
      if (c === '}') { k++; continue; }
      if (c === '\\') {
        const m = /^\\([a-zA-Z]+|.)/.exec(s.slice(k));
        if (!m) { k++; continue; }
        const n = m[1];
        k += m[0].length;
        if (n === 'frac' || n === 'dfrac' || n === 'tfrac') { const a = arg(); const b = arg(); out += '(' + parse(a) + ')/(' + parse(b) + ')'; continue; }
        if (n === 'sqrt') {
          if (s[k] === '[') { const j = s.indexOf(']', k); k = j < 0 ? k : j + 1; }
          const a = arg();
          out += '√(' + parse(a) + ')';
          continue;
        }
        if (n === 'binom') { const a = arg(); const b = arg(); out += 'C(' + parse(a) + ',' + parse(b) + ')'; continue; }
        if (n === 'left' || n === 'right' || n === 'middle') {
          while (k < s.length && /\s/.test(s[k])) k++;
          if (s[k] === '\\') {
            const mm = /^\\([a-zA-Z]+|.)/.exec(s.slice(k));
            if (mm) { k += mm[0].length; out += SYMBOL[mm[1]] || ''; } else k++;
          } else {
            const ch = s[k] || '';
            k++;
            out += ch === '.' ? '' : ch;
          }
          continue;
        }
        if (n === 'mathrm' || n === 'text' || n === 'mathbf' || n === 'mathit' || n === 'operatorname') { out += stripCommands(arg()); continue; }
        if (GREEK[n]) { out += GREEK[n]; continue; }
        if (SYMBOL[n] !== undefined && n !== 'quad' && n !== 'qquad') { out += SYMBOL[n]; continue; }
        if (FUNC.has(n)) { out += n; continue; }
        if (n === 'quad' || n === 'qquad' || n === ' ') { out += ' '; continue; }
        out += n;
        continue;
      }
      if (c === "'") { out += '′'; k++; continue; }
      out += c;
      k++;
    }
    return out;
  }

  return parse(t);
}
