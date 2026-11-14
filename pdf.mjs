/**
 * PDF 导出（零第三方依赖）
 *
 * 做法：把笔记渲染成一份独立的 HTML，交给本机浏览器的打印引擎
 * （Chrome / Edge 的 `--headless --print-to-pdf`）出 PDF。
 *
 * 为什么不自己写 PDF 写入器：
 *   1. 中文 PDF 必须嵌入字体，还得是子集 —— 不子集就是 13~19 MB 一个文件。
 *   2. 更要命的是字体回退：实测 simhei.ttf / Deng.ttf **完全没有 Unicode 上下标字符**
 *      （⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻ⁿⁱ 一个都没有），而 texToText() 正是靠这些字符输出 x²、xⁿ。
 *      自己写就得逐字符挑字体、同时子集化两三个字体，出错概率远大于收益。
 *   3. 浏览器打印引擎本来就会做字体子集嵌入（实测 56 KB 的 PDF 里三个字体全是子集），
 *      而且排版跟屏幕上完全一致 —— 我们前端本来就是网页，等于同一套 CSS 出两种产物。
 *
 * 找不到浏览器的机器上会明确报错，不会悄悄导出一个没有中文的空白 PDF。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { renderMarkdown, stripCheckSection } from './public/md.js';
import { applyNoteHeader } from './public/llm.js';
import { collapseDisplayMath } from './docx.mjs';

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * 找本机浏览器。返回可执行文件绝对路径，找不到返回 ''。
 *
 * 顺序：Chrome 稳定版 → Edge 稳定版 → 环境变量兜底。
 * 都找不到时调用方要给出「装一个 Chrome/Edge 就行」的提示，别糊一层假成功。
 */
export function findBrowser() {
  const env = process.env;
  const windir = env.SystemRoot || env.windir || 'C:\\Windows';
  const pf = env.ProgramFiles || 'C:\\Program Files';
  const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = env.LOCALAPPDATA || '';
  const cands = [
    // 可以用环境变量指定，方便装在绿色目录或换别的 Chromium 内核浏览器
    env.LECTURE_BROWSER || '',
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    local ? path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(windir, 'System32', 'MicrosoftEdge.exe'),
    // 非 Windows 上跑（开发机、容器里调试）时也认一下常见的可执行名
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const p of cands) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* 权限问题之类，跳过去看下一个 */
    }
  }
  return '';
}

/**
 * PDF 专用样式。
 *
 * 跟 public/app.css 的 .tex 那套有意重复一份，不共用：
 *  - 网页样式是「屏幕上的阅读密度」，PDF 是「打印的版面」：A4 页边、段距、字号、
 *    分页规则都不一样，强行共用会让两边都不舒服。
 *  - app.css 里有大量交互态（hover / focus / dark）对 PDF 毫无意义。
 * 但 **.tex 的几何必须一致**（分数用 middle 对齐数学轴等），所以那几条照抄并注明来源。
 */
const PDF_CSS = `
@page { size: A4; margin: 17mm 15mm 16mm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body {
  margin: 0;
  font-family: "Microsoft YaHei", "微软雅黑", "PingFang SC", "Noto Sans CJK SC", "Segoe UI", sans-serif;
  font-size: 10.9pt; line-height: 1.72; color: #1f2328; background: #fff;
  word-wrap: break-word;
}
h1, h2, h3, h4 { line-height: 1.35; page-break-after: avoid; break-after: avoid; }
h1 { font-size: 19pt; margin: 0 0 10pt; padding-bottom: 6pt; border-bottom: 2px solid #d0d7de; }
h2 { font-size: 14.5pt; margin: 16pt 0 8pt; padding-left: 8pt; border-left: 4px solid #4a6cf7; }
h3 { font-size: 12.5pt; margin: 12pt 0 6pt; }
h4 { font-size: 11pt; margin: 10pt 0 5pt; color: #3a4250; }
p { margin: 0 0 7pt; }
ul, ol { margin: 0 0 7pt; padding-left: 20pt; }
li { margin: 2pt 0; }
li > ul, li > ol { margin: 2pt 0; }
strong { font-weight: 700; }
hr { border: 0; border-top: 1px solid #d8dee4; margin: 12pt 0; }
a { color: #2f5fe0; text-decoration: none; }
blockquote {
  margin: 8pt 0; padding: 6pt 10pt; border-left: 3px solid #c9d1d9;
  background: #f6f8fa; color: #57606a;
}
code {
  font-family: "Cascadia Mono", Consolas, "Courier New", monospace;
  font-size: .92em; background: #f2f4f7; padding: 1pt 3pt; border-radius: 3pt;
}
pre { background: #f2f4f7; padding: 8pt 10pt; border-radius: 5pt; overflow: hidden; white-space: pre-wrap; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; margin: 8pt 0; font-size: 10.2pt; page-break-inside: avoid; }
th, td { border: 1px solid #d8dee4; padding: 4pt 7pt; text-align: left; vertical-align: top; }
th { background: #f2f4f7; font-weight: 700; }
img { max-width: 100%; }
/* 时间戳锚点在纸上点不了，只要字面 */
a.ts { color: #6a737d; font-family: Consolas, monospace; font-size: .92em; }

/* ---- 公式：几何与 public/app.css 里的 .tex 那套保持一致 ---- */
.tex {
  font-family: "Cambria Math", "Latin Modern Math", "Times New Roman", serif;
  font-style: italic; white-space: nowrap;
}
.tex-display { display: block; text-align: center; font-size: 1.12em; margin: 8pt 0; white-space: normal; }
.tex .tex-fn, .tex .tex-rm, .tex .tex-sqrt { font-style: normal; }
.tex-frac {
  display: inline-flex; flex-direction: column; align-items: center;
  /* 与 app.css 一致：分数中心要对齐数学轴（基线以上约 .25em）。
     写成负 em 是拿块底部在挪，分数越高沉得越深。 */
  vertical-align: middle; margin: 0 .18em; line-height: 1.16; font-size: .96em;
}
.tex-frac > .tex-den { border-top: 1px solid currentColor; }
.tex-frac-mixed > .tex-den { border-top: 1px solid currentColor; }
.tex-sqrt { display: inline-flex; align-items: flex-start; vertical-align: middle; }
.tex-sqrt > .tex-radicand { border-top: 1px solid currentColor; padding: .05em .12em 0; }
.tex-sqrt > .tex-idx { font-size: .62em; vertical-align: super; margin-right: -.2em; }
.tex-sqrt > .tex-radical { font-size: 1.15em; transform: scaleY(1.25); transform-origin: bottom; }
.tex-sup, .tex-sub { font-size: .74em; }
.tex-sup { vertical-align: super; }
.tex-sub { vertical-align: sub; }
.tex-bigop { font-size: 1.35em; vertical-align: -.12em; }
.tex-bold { font-weight: 700; }
.tex-delim { font-style: normal; }
/* 括号跟着内容长高（真实 LaTeX 里 \left \right 是弹性的） */
.tex:has(.tex-frac) > .tex-delim,
.tex:has(.tex-sqrt) > .tex-delim {
  display: inline-block; transform: scaleY(1.6); transform-origin: center; font-weight: 300;
}
.tex-raw { font-family: Consolas, monospace; font-style: normal; font-size: .92em; color: #6a737d; }

/* 打印时才需要的分页规则 */
.keep { page-break-inside: avoid; break-inside: avoid; }
`.trim();

/**
 * 把笔记 markdown 变成一份可打印的独立 HTML。
 *
 * @param {object} opt
 * @param {string} opt.markdown 笔记 markdown（应已过 applyNoteHeader）
 * @param {string} [opt.title]  标题（缺省用 markdown 里的一级标题）
 * @param {object} [opt.meta]   { course, createdAt, duration }
 * @returns {{ html: string, title: string }}
 */
export function buildNoteHtml({ markdown, title = '', meta = {} } = {}) {
  const raw = String(markdown || '');
  // 「需要回听核对的地方」不进 PDF（老大 2026-10-28 定的：导出不带这一段）。
  // **顺序很重要：先洗核对节，再剥 `<details>`**。`stripCheckSection` 认三个出口
  // （下一个标题 / 分隔线 `---` / `<details>`），先把附录剥掉就等于把最后一个出口
  // 抽走了，核对节若恰好在正文最后一节，它就只能一路删到文末。
  // server.mjs 调 buildNoteHtml 之前已经洗过一次，这里再洗是给直接调用本函数的地方
  // 兜底（tests/test-pdf-export.mjs 就是直接调的）。
  const noCheck = stripCheckSection(raw);
  // 去掉 <details> 里的逐字稿附录 —— 那是给网页端折叠看的（一份 52 分钟的课能有两万字），
  // 纸上折叠不了，印出来就是几十页原文，把笔记正文挤到看不见。
  // docx.mjs 里也是同样的取舍（见那里的注释），两条导出路线保持一致。
  const bodyOnly = noCheck.replace(/<details[\s\S]*?<\/details>/gi, '\n');
  // 显示公式跨三行写的时候，逐行解析会漏掉定界符 —— 先并成一行再渲染。
  // 跟 docx 导出用的是同一个函数，两条导出路线不会各有一套「显示公式」处理。
  const merged = collapseDisplayMath(bodyOnly.split(/\r?\n/)).join('\n');
  const body = renderMarkdown(merged);

  // 标题：优先调用方给的（meta.title），否则取正文第一个 <h1>，再不行给个通用名
  let docTitle = String(title || '').trim();
  if (!docTitle) {
    const m = merged.match(/^#\s+(.+)$/m);
    docTitle = m ? m[1].trim() : '课堂笔记';
  }

  // 页脚那行「课程 · 日期 · 时长」由 applyNoteHeader 保障，这里不再拼；
  // 但 PDF 页面上加一条来源说明，让纸面文件自己说得清是哪门课。
  const bits = [];
  if (meta.course) bits.push(esc(meta.course));
  const date = String(meta.date || meta.createdAt || '').slice(0, 10);
  if (date) bits.push(esc(date));

  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>${esc(docTitle)}</title>
<style>${PDF_CSS}</style>
</head><body>
${bits.length ? `<div style="font-size:9.5pt;color:#6a737d;margin:0 0 6pt">${bits.join(' · ')}</div>` : ''}
${body}
</body></html>`;
  return { html, title: docTitle };
}

/**
 * 调浏览器把 HTML 打成 PDF，返回 Buffer。
 *
 * 几个必须这么写的点：
 *  - 输出路径用**绝对路径**：Chromium 拿相对路径会报「系统找不到指定的路径」。
 *  - `--no-pdf-header-footer` 去掉浏览器自己加的页眉页脚（日期、网址那一行），
 *    那行带本地文件路径，印出来很难看。
 *  - `--disable-gpu`：headless 下没有显卡也能跑，且避免某些机器上 GPU 进程崩了卡住。
 *  - 临时目录放在 os.tmpdir()，用完整个删掉；文件在临时目录里，不会污染数据目录。
 */
export async function htmlToPdf(html, { browser = '', timeoutMs = 60000 } = {}) {
  const exe = browser || findBrowser();
  if (!exe) {
    const err = new Error('这台电脑上没找到 Chrome 或 Edge，导不了 PDF。装一个 Chrome（或 Edge）再试就行 —— 只有浏览器能嵌入中文字体。');
    err.code = 'NO_BROWSER';
    throw err;
  }
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ln-pdf-'));
  const htmlPath = path.join(dir, 'note.html');
  const pdfPath = path.join(dir, 'note.pdf');
  try {
    await fsp.writeFile(htmlPath, html, 'utf8');
    const args = [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--virtual-time-budget=5000',
      '--no-pdf-header-footer',
      `--print-to-pdf=${pdfPath}`,
      pathToFileURL(htmlPath).href,
    ];
    await new Promise((resolve, reject) => {
      const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let stderr = '';
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* 已经退了 */
        }
        reject(new Error(`导出 PDF 超时（${Math.round(timeoutMs / 1000)} 秒）。第一次启动浏览器会比较慢，再点一次试试。`));
      }, timeoutMs);
      child.stderr.on('data', (d) => {
        stderr += String(d);
        if (stderr.length > 8000) stderr = stderr.slice(-8000);
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        // 指定的浏览器不存在 / 启动不了。ENOENT 这种原文对用户毫无意义，
        // 换成「去装一个」的指引；真要找原因，原始信息附在后面。
        const err = new Error(
          '这台电脑上没找到能用的 Chrome 或 Edge，导不了 PDF。装一个 Chrome（或 Edge）再试就行。' +
            '（原始错误：' +
            e.message +
            '）'
        );
        err.code = e.code === 'ENOENT' ? 'NO_BROWSER' : 'BROWSER_FAIL';
        reject(err);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`浏览器打印失败（退出码 ${code}）。${stderr.trim().slice(-300)}`));
      });
    });
    const buf = await fsp.readFile(pdfPath);
    if (!buf.length) throw new Error('浏览器没生成 PDF 文件');
    // PDF 头必须是 %PDF-，否则说明浏览器把报错页打成了文件
    if (buf.slice(0, 5).toString('latin1') !== '%PDF-') {
      throw new Error('浏览器输出的不是 PDF（可能是弹了对话框或权限提示）');
    }
    return buf;
  } finally {
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 一步到位：笔记 markdown → PDF 字节。
 * 导出路由直接调这个，别在外面重复上面的拼装步骤。
 */
export async function noteToPdf({ markdown, title, meta, browser, timeoutMs } = {}) {
  const { html, title: docTitle } = buildNoteHtml({ markdown, title, meta });
  const buf = await htmlToPdf(html, { browser, timeoutMs });
  return { buf, title: docTitle };
}
