/**
 * 极简 Markdown 渲染器（零依赖）
 * 只支持我们生成笔记时用到的语法子集，但做了完整转义，避免 XSS。
 * 额外支持：
 *   - 时间戳链接 [12:34](#t=754) 会被标记成可点击的跳转锚点
 *   - LaTeX 公式：行内 `\( ... \)`、`$...$`，独立 `\[ ... \]`、`$$...$$`
 *     （交给 public/tex.js，见那里的设计说明）
 */

import { renderTex, hasTex } from './tex.js';
import { findBareMath } from './math.js';

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * 删掉模型误抄进正文的提示词写作要求。
 * 提示词里给模型的写作要求用的是全角方括号「［…］」，业务正文不会用这对符号；
 * 模型偶尔会把它们连同要求文字一起抄进输出（如「［40 字以内，说清这节课的主线。］」）。
 * 这里把「［」到「］」的整段（允许跨行）删掉。
 */
/**
 * 拆掉「把整篇笔记包进一个代码块」的外壳。
 *
 * 起因（2026-10-29 老大报的）：DeepSeek-V3 润色高数那篇时，输出成了
 *   ```markdown
 *   # 高数
 *   ## 一句话概要
 *   ...
 * （而且**结尾没有闭合的 ```**）。渲染器于是把整篇当成代码，套进 <pre><code>，
 * 页面上就出现「# 高数」「## 一句话概要」这种原文 —— 看起来像「风格变了」，
 * 其实一个字都没变，只是不再解析 Markdown 了。
 *
 * 判定要保守，别把正常的代码块也拆了：
 *   ① 文件开头就是 ``` 围栏；
 *   ② 围栏里面出现过 Markdown 标题（# / ##）—— 纯代码片段里不会有；
 *   ③ 闭合围栏之后的尾巴要么是空的，要么是我们自己追加的逐字稿附录
 *      （`---` + `<details>`）。别的正文跟在后面就不动，那是「代码块 + 正文」。
 * 三条都成立才认定「整篇被包住」，去掉围栏、保留附录。
 */
function stripOuterFence(s) {
  const lines = s.split('\n');
  let start = 0;
  while (start < lines.length && !lines[start].trim()) start++;
  if (start >= lines.length || !/^\s*```/.test(lines[start])) return s;

  // 第二个 ``` 就是闭合（没有就当成「一直到文末都在围栏里」）
  let closed = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*```\s*$/.test(lines[i])) { closed = i; break; }
  }
  const inner = closed > 0 ? lines.slice(start + 1, closed) : lines.slice(start + 1);
  // 里面必须有 Markdown 标题才算「整篇被包住」；纯代码片段里不会有 `# ` 标题
  if (!inner.some((l) => /^#{1,6}[ \t]+\S/.test(l))) return s;

  let tail = [];
  if (closed > 0) {
    const rest = lines.slice(closed + 1);
    const restText = rest.join('\n');
    const hasReal = rest.filter((l) => l.trim()).length > 0;
    // 实测 cc9c9d21 就是这种形状：围栏在第 82 行闭合，后面紧跟
    // `---` + `<details>…逐字稿…</details>` —— 那是我们自己追加的附录，不是模型正文。
    // 只有「尾巴为空」或「尾巴是我们的附录」才拆栏，否则原样返回。
    const isOurAppendix = !hasReal || (/<details/i.test(restText) && !/<details/i.test(inner.join('\n')));
    if (!isOurAppendix) return s;
    tail = rest;
  }
  return [...inner, ...tail].join('\n').replace(/^\n+/, '').replace(/\s+$/, '');
}

export function stripPromptLeaks(md) {
  const s = stripOuterFence(String(md || ''));
  // 「硬性要求：1. ……」是我们的提示词原文，模型偶尔会连编号带内容整段抄进正文。
  // 它不像 ［…］ 那样有全角括号可认，只能按标题认：从「硬性要求：」这一行开始，
  // 一直丢到下一个一二级标题（或文末）。实测 1305e386 / bbf8cc40 两篇都抄了 9 条。
  //
  // 为什么按行扫而不是一条正则：正则里「到文末」要写 `(?![^])` 这种绕的东西，
  // 而且「下一个 ## 标题」和「文末」是两个出口，一个前瞻写不清就漏（第一版就漏了，
  // `(?=^#{1,2}[ \t]|(?![\s\S]))` 在文末那一篇上匹配失败）。
  const lines = s.replace(/［[\s\S]*?］/g, '').split('\n');
  const out = [];
  let dropping = false;
  for (const line of lines) {
    if (/^[ \t]*\*{0,2}硬性要求\*{0,2}[:：]/.test(line)) {
      dropping = true;
      continue;
    }
    // 出口有三个，缺一不可：
    //   ① 下一个一二级标题（把标题本身留下）
    //   ② 分隔线 `---`（提示词抄完之后紧跟着就是 `---` + 逐字稿附录）
    //   ③ `<details>`（附录本身）
    // 只认标题是不够的 —— 这两篇抄进来的位置都在文末那一节里，后面再没有 `##` 标题，
    // 于是「丢到下一个标题」等于「丢到文末」，把整份逐字稿附录一起吃了
    // （实测 1305e386 从 14284 字削到 1825 字，附录全没了）。
    if (dropping && (/^#{1,2}[ \t]/.test(line) || /^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/.test(line) || /^[ \t]*<details/i.test(line))) {
      dropping = false;
    }
    if (!dropping) out.push(line);
  }
  // 连续换行压成两个，避免删完留下大段空白
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 去掉「需要回听核对的地方」整节。
 *
 * 这一节是给我们自己看的：程序核对出来的「这个数字逐字稿里没有」，
 * 以及模型标出的「这几处转写含糊」。老大 2026-10-28 定的口径：
 * **导出（Word / Markdown / PDF）不带你这一段** —— 导出去是给人复习用的，
 * 不该夹带一堆「可能不准」的括号，让人读笔记时一直分心。
 * 网页上仍然照常显示，不删。
 */
export function stripCheckSection(md) {
  const s = String(md || '');
  const HEAD = /^##[ \t]*需要回听核对的地方[ \t]*\n/m;
  if (!HEAD.test(s)) return s.trim(); // 没有这一节就一个字都别动
  // 出口和 stripPromptLeaks 一样有三个，只认 `## ` 会一路删到文末：
  // 「需要回听核对的地方」通常就是笔记正文的最后一节，它后面紧跟 `---` + `<details>`
  // 逐字稿附录，**再没有 `##` 标题**。第一版只写了 `(?=^##[ \t]|(?![\s\S]))`，
  // 于是「到下一个标题」= 「到文末」，整份附录被当成这一节删掉
  // （实测 1305e386 从 14284 字削到 1825 字）。
  const out = s.replace(
    /^##[ \t]*需要回听核对的地方[ \t]*\n[\s\S]*?(?=^#{1,2}[ \t]|^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$|^[ \t]*<details|(?![\s\S]))/m,
    ''
  );
  return out
    .replace(/\n{3,}/g, '\n\n')
    // 这一节若正好在文末，删完会剩下一条孤零零的分隔线。**只在字符串结尾清**：
    // 上面的 `<details>` 出口前面本来就有一条 `---` 是笔记与附录之间的正常分隔，
    // 早先这里写的是 `/m` 全篇替换，把那条也一起删了（附录就和正文黏在一起）。
    .replace(/\n+[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*\s*$/, '')
    .trim();
}

/**
 * 公式定界符。四种写法都认：
 *   `\( ... \)` 行内   `\[ ... \]` 独立   `$$ ... $$` 独立   `$ ... $` 行内
 * `$...$` 排在最后，`$$` 才不会被它先吃掉。
 */
const TEX_RE = /\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]|\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;

/** `$5 块钱` 这种不能当公式。只认带反斜杠命令或上下标/花括号的 */
const looksMath = (s) => /[\\^_{}]/.test(s);

/** 不含公式的纯文本行内处理（原来的逻辑，原样搬过来） */
function inlineMd(text) {
  let s = esc(text);
  // 行内代码
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  // 粗体 / 斜体
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  // 链接（含时间戳锚点）
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
    if (/^#t=/.test(href)) {
      const t = href.slice(3);
      return `<a class="ts" href="${href}" data-t="${t}">${label}</a>`;
    }
    const safe = /^(https?:|mailto:|#)/i.test(href) ? href : '#';
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  return s;
}

/**
 * 纯文本行内处理，外加「裸文本公式」识别。
 *
 * 模型（本地 14B、云端都算）写公式时经常不用 LaTeX，直接写 `y = x^2 + 1`、
 * `x^2/16 + y^2/9 - 1 = 0` —— 老笔记里这种写法占绝大多数（8 份笔记里 LaTeX 定界符命中 0）。
 * 这里把这种片段挑出来交给 tex.js 排成分数、上标，剩下照原样走 Markdown。
 * 识别规则在 public/math.js，原则是「宁可不认，不能认错」。
 */
function inlinePlain(text) {
  const src = String(text ?? '');
  if (!/[/^]/.test(src)) return inlineMd(src); // 快路径：连斜杠和 ^ 都没有
  const hits = findBareMath(src);
  if (!hits.length) return inlineMd(src);
  let out = '';
  let last = 0;
  for (const h of hits) {
    if (h.start > last) out += inlineMd(src.slice(last, h.start));
    out += renderTex(h.tex);
    last = h.end;
  }
  if (last < src.length) out += inlineMd(src.slice(last));
  return out;
}

function inline(text) {
  const src = String(text ?? '');
  if (!hasTex(src) && !src.includes('$')) return inlinePlain(src);

  // 公式必须在 **转义之前** 切出来：esc() 会把 `\text{a<b}` 里的 < 变成 &lt;，
  // 再交给 tex.js 就变成双重转义，页面上显示 &lt;
  let out = '';
  let last = 0;
  TEX_RE.lastIndex = 0;
  let m;
  while ((m = TEX_RE.exec(src))) {
    const body = m[1] ?? m[2] ?? m[3] ?? m[4] ?? '';
    const display = m[2] !== undefined || m[3] !== undefined;
    // 第四种（单 $）要先排除货币写法，否则「$5 和 $6」之间那段会被当公式
    if (m[4] !== undefined && !looksMath(body)) continue;
    if (m.index > last) out += inlinePlain(src.slice(last, m.index));
    out += renderTex(body, { display });
    last = m.index + m[0].length;
  }
  if (last === 0) return inlinePlain(src); // 一个公式都没匹配上
  if (last < src.length) out += inlinePlain(src.slice(last));
  return out;
}

export function renderMarkdown(src) {
  // 旧笔记文件里可能还残留模型误抄的提示词要求，渲染入口再滤一遍（幂等）
  const lines = stripPromptLeaks(src).replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  let listStack = []; // 'ul' | 'ol'
  let inCode = false;
  let codeBuf = [];
  let para = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
    }
  };
  const closeLists = (toDepth = 0) => {
    while (listStack.length > toDepth) out.push(`</${listStack.pop()}>`);
  };

  while (i < lines.length) {
    const line = lines[i];

    // 代码块
    if (/^```/.test(line.trim())) {
      flushPara();
      closeLists();
      if (!inCode) {
        inCode = true;
        codeBuf = [];
      } else {
        out.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`);
        inCode = false;
      }
      i++;
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      i++;
      continue;
    }

    // 表格
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flushPara();
      closeLists();
      const cells = (l) =>
        l
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(cells(lines[i]));
        i++;
      }
      out.push('<table><thead><tr>' + head.map((h) => `<th>${inline(h)}</th>`).join('') + '</tr></thead><tbody>');
      for (const r of rows) out.push('<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>');
      out.push('</tbody></table>');
      continue;
    }

    // 空行
    if (!line.trim()) {
      flushPara();
      closeLists();
      i++;
      continue;
    }

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      closeLists();
      const lv = h[1].length;
      out.push(`<h${lv}>${inline(h[2])}</h${lv}>`);
      i++;
      continue;
    }

    // 分隔线
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flushPara();
      closeLists();
      out.push('<hr>');
      i++;
      continue;
    }

    // 引用（连续多行合并）
    if (/^\s*>\s?/.test(line)) {
      flushPara();
      closeLists();
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${buf.map((b) => inline(b)).join('<br>')}</blockquote>`);
      continue;
    }

    // details / summary 透传（我们自己生成的内容）
    const raw = line.trim();
    if (/^<\/?(details|summary)>$/i.test(raw)) {
      flushPara();
      closeLists();
      out.push(raw.toLowerCase());
      i++;
      continue;
    }

    // 列表
    const ul = line.match(/^\s*([-*+])\s+(.*)$/);
    const ol = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const depth = ul ? 1 : 1;
      if (!listStack.length) {
        out.push(ul ? '<ul>' : '<ol>');
        listStack.push(ul ? 'ul' : 'ol');
      } else if ((ul && listStack[listStack.length - 1] === 'ol') || (ol && listStack[listStack.length - 1] === 'ul')) {
        out.push(`</${listStack.pop()}>`);
        out.push(ul ? '<ul>' : '<ol>');
        listStack.push(ul ? 'ul' : 'ol');
      }
      out.push(`<li>${inline((ul || ol)[2])}</li>`);
      void depth;
      i++;
      continue;
    }

    para.push(line.trim());
    i++;
  }
  flushPara();
  closeLists();
  if (inCode && codeBuf.length) out.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`);
  return out.join('\n');
}

/** 从 Markdown 里粗略统计字数，用于界面显示 */
export function countChars(md) {
  return String(md || '').replace(/[\s#*`>\-|]/g, '').length;
}
