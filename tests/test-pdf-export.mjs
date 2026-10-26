/**
 * PDF 导出的测试。
 *
 * 分两层：
 *  1. 纯逻辑（不联网、不开浏览器）：buildNoteHtml 的取舍、标题、公式、逐字稿剔除。
 *  2. 真出 PDF（需要本机有 Chrome/Edge）：能跑就跑，跑不了就跳过并说明原因 ——
 *     别人的机器上没装浏览器不该让整套测试变红。
 *
 * 这一层不测「PDF 里长什么样」（那是 _scratch/shot-pdf.mjs 的事），
 * 只测试「产出的字节是不是一个语法正确、字体嵌进去了的 PDF」。
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildNoteHtml, findBrowser, htmlToPdf, noteToPdf } from '../pdf.mjs';

const ROOT = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail !== undefined ? ' → ' + JSON.stringify(detail) : ''}`);
  }
};
const section = (t) => console.log(`\n=== ${t} ===`);

// ---------------------------------------------------------------------------
section('一、HTML 组装');

const md = [
  '# 高等数学 · 第二讲',
  '',
  '## 一句话概要',
  '',
  '讲二阶导数的定义。',
  '',
  '## 课堂脉络与重点',
  '',
  '1. 数学表达：若 y = f(x)，二阶导数为 y′′ = \\( \\frac{d^2y}{dx^2} \\)。',
  '- 要点：**莱布尼茨公式** \\( (uv)^{(n)} = \\sum_{k=0}^{n} \\binom{n}{k} u^{(n-k)}v^{(k)} \\)',
  '',
  '<details>',
  '<summary>📄 展开完整逐字稿（按时间轴）</summary>',
  '',
  '[00:00](#t=0.00) 好，我们讲这个高阶导数。',
  '[00:04](#t=4.28) 这是一个很长的逐字稿正文。',
  '',
  '</details>',
].join('\n');

const r = buildNoteHtml({ markdown: md, title: '高数', meta: { course: '高等数学', createdAt: '2026-10-26' } });

check('返回 html 字符串', typeof r.html === 'string' && r.html.length > 1000, r.html.length);
check('是完整文档（有 doctype 与 lang）', /^<!doctype html>/i.test(r.html) && r.html.includes('lang="zh-CN"'));
check('标题用了传入的 title', r.html.includes('<title>高数</title>'), r.title);
check('页面上有一行「课程 · 日期」', r.html.includes('高等数学') && r.html.includes('2026-10-26'));
check('正文标题渲染成 h1', r.html.includes('<h1>') && r.html.includes('高等数学 · 第二讲'));
check('二级标题渲染成 h2', (r.html.match(/<h2/g) || []).length === 2);
check('公式渲染成 .tex 而不是裸 LaTeX', r.html.includes('class="tex') && !/\\frac\{d\^2y\}/.test(r.html));
check('分数用 .tex-frac', r.html.includes('tex-frac'));
check('求和号在 .tex-bigop 里', r.html.includes('tex-bigop'));

// 这一条是「导出范围」的硬要求：笔记类导出只导正文
check('逐字稿附录不进 HTML', !r.html.includes('逐字稿') && !r.html.includes('展开完整'));
check('逐字稿的时间戳行没漏出来', !r.html.includes('class="ts"') && !/\[00:0\d\]/.test(r.html));
check('笔记正文要点还在', r.html.includes('二阶导数的定义'));

// 没有 title、也没有一级标题时不能崩
const noTitle = buildNoteHtml({ markdown: '## 只有二级标题\n\n正文' });
check('缺标题时给通用名', noTitle.title === '课堂笔记' || noTitle.title.length > 0, noTitle.title);
check('空 markdown 不崩', /<body>/.test(buildNoteHtml({ markdown: '' }).html));
check('undefined markdown 不崩', buildNoteHtml({}).html.includes('<body>'));

// 显示公式跨三行：要能并成一行，否则 \(\[ \] \) 那对定界符会漏成裸文本
const multiline = buildNoteHtml({
  markdown: ['# T', '', '公式：', '', '\\[', '(uv)^{(n)} = \\sum_{k=0}^{n} \\binom{n}{k}', '\\]', ''].join('\n'),
});
check('三行的显示公式被并成一行渲染', multiline.html.includes('tex') && !multiline.html.includes('\\sum'), {
  hasTex: multiline.html.includes('tex'),
  rawSum: multiline.html.includes('\\sum'),
});

// ---------------------------------------------------------------------------
section('二、找浏览器');

const browser = findBrowser();
check('返回字符串', typeof browser === 'string', browser);
if (browser) {
  check('找到的可执行文件真实存在', fs.existsSync(browser), browser);
  check('是 chrome / msedge 之一', /chrome\.exe$|msedge\.exe$|chrome$|chromium/i.test(browser), browser);
} else {
  console.log('  (这台机器没装 Chrome/Edge，后面对 PDF 字节的检查会全部跳过)');
}
check('环境变量 LECTURE_BROWSER 能被识别', (() => {
  const old = process.env.LECTURE_BROWSER;
  const target = browser || 'C:/definitely-not-here.exe';
  process.env.LECTURE_BROWSER = target;
  let got = '';
  try {
    got = findBrowser();
  } finally {
    // 还原：不还原会污染后面「真的出一份 PDF」那一段
    if (old === undefined) delete process.env.LECTURE_BROWSER;
    else process.env.LECTURE_BROWSER = old;
  }
  return got === target;
})(), browser);

// ---------------------------------------------------------------------------
section('三、不出 PDF 时的错误');

const noBrowser = await htmlToPdf('<p>x</p>', { browser: path.join(ROOT, 'no-such-browser.exe') }).then(
  () => null,
  (e) => e
);
check('指定不存在的浏览器会抛错', !!noBrowser, noBrowser && noBrowser.message);
check('错误码是 NO_BROWSER', noBrowser && noBrowser.code === 'NO_BROWSER', noBrowser && noBrowser.code);
check('错误信息告诉用户该怎么办', !!noBrowser && /装一个|没找到/.test(noBrowser.message), noBrowser && noBrowser.message);

// ---------------------------------------------------------------------------
section('四、真的出一份 PDF');

if (!browser) {
  console.log('  - 跳过：本机没有 Chrome/Edge');
} else {
  const t0 = Date.now();
  const { buf, title } = await noteToPdf({
    markdown: md,
    title: '高数',
    meta: { course: '高等数学', createdAt: '2026-10-26' },
  }).catch((e) => ({ err: e }));

  if (buf) {
    console.log(`  (耗时 ${Date.now() - t0} ms，${(buf.length / 1024).toFixed(1)} KB)`);
    check('返回 Buffer', Buffer.isBuffer(buf));
    check('PDF 头是 %PDF-', buf.slice(0, 5).toString('latin1') === '%PDF-', buf.slice(0, 8).toString('latin1'));
    check('PDF 尾有 EOF', buf.slice(-1024).toString('latin1').includes('%%EOF'));
    check('体积合理（> 20 KB，说明中文排进去了）', buf.length > 20 * 1024, buf.length);
    check('体积合理（< 40 MB，说明字体是子集不是整包）', buf.length < 40 * 1024 * 1024, buf.length);
    check('标题回传正确', title === '高数', title);

    const s = buf.toString('latin1');
    // 页面树里必须有 /Pages 与 /Page
    check('有页面树 /Pages', s.includes('/Pages'));
    check('至少 1 页', /\/Type\s*\/Page[^s]/.test(s) || /\/Count\s+[1-9]/.test(s));
    // 字体：中文必须嵌入，否则别的机器打开是方框
    const fonts = [...new Set((s.match(/\/BaseFont\s*\/([A-Za-z0-9+\-]+)/g) || []).map((x) => x.replace(/.*\//, '')))];
    check('内嵌了字体', fonts.length > 0, fonts);
    check('有 TrueType 字体流（FontFile2）', (s.match(/\/FontFile2/g) || []).length > 0);
    check('字体名带子集前缀（AAAAAA+ 这种）', fonts.some((f) => /^[A-Z]{6}\+/.test(f)), fonts);
    check('没有把整包中文字体塞进来（单流 < 8 MB）', (() => {
      const lens = [...s.matchAll(/\/Length\s+(\d+)/g)].map((m) => +m[1]);
      return lens.every((n) => n < 8 * 1024 * 1024);
    })(), [...s.matchAll(/\/Length\s+(\d+)/g)].map((m) => +m[1]).sort((a, b) => b - a).slice(0, 3));

    // 文字层：能抽出中文，说明不是把内容画成图片
    const textChunks = [];
    const re = /stream\r?\n/g;
    let m;
    while ((m = re.exec(s))) {
      const start = m.index + m[0].length;
      const end = s.indexOf('endstream', start);
      if (end < 0) continue;
      try {
        const out = zlib.inflateSync(buf.slice(start, end)).toString('latin1');
        // PDF 里的文字是十六进制字形码，抽不出明文中文；
        // 有内容流且含 TJ / Tj 操作符就够了，说明是文字不是图片。
        if (/\bT[Jj]\b/.test(out)) textChunks.push(out);
      } catch {
        /* 不是 Flate 流，跳过 */
      }
    }
    check('有文字绘制操作符（不是纯图片）', textChunks.length > 0, textChunks.length);
  } else {
    check('出 PDF 时不报错', false, String(buf.err && buf.err.message));
  }
}

// ---------------------------------------------------------------------------
console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
