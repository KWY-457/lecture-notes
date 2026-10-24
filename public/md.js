/**
 * 极简 Markdown 渲染器（零依赖）
 * 只支持我们生成笔记时用到的语法子集，但做了完整转义，避免 XSS。
 * 额外支持：时间戳链接 [12:34](#t=754) 会被标记成可点击的跳转锚点。
 */

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * 删掉模型误抄进正文的提示词写作要求。
 * 提示词里给模型的写作要求用的是全角方括号「［…］」，业务正文不会用这对符号；
 * 模型偶尔会把它们连同要求文字一起抄进输出（如「［40 字以内，说清这节课的主线。］」）。
 * 这里把「［」到「］」的整段（允许跨行）删掉。
 */
export function stripPromptLeaks(md) {
  const s = String(md || '');
  const cleaned = s.replace(/［[\s\S]*?］/g, '');
  // 连续换行压成两个，避免删完留下大段空白
  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}

function inline(text) {
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
