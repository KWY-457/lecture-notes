/**
 * 逐字稿面板「收起 / 展开」的静态断言（不联网、不开浏览器）
 *
 * 浏览器里的真实交互由 `_scratch/shot-txcollapse.mjs`（27 项）覆盖，
 * 这里守的是「改代码时别把这些关键约定删掉」——
 * 尤其「收起后必须有个回程入口」这条：少了它就等于让用户把面板关死。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const html = read('public/index.html');
const js = read('public/app.js');
const css = read('public/app.css');

let pass = 0;
const fails = [];
function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fails.push(name);
    console.log('  ✗ ' + name + (detail === undefined ? '' : ' → ' + JSON.stringify(detail)));
  }
}

console.log('\n=== 1. 结构：两个按钮 + 一个回程入口 ===');
check('逐字稿面板有 tx-pane 类', /class="pane tx-pane"/.test(html), '');
check('头里有「收起」按钮', /id="btn-tx-collapse"/.test(html), '');
check('笔记面板头里有「展开」按钮', /id="btn-tx-expand"/.test(html), '');
check('展开入口包在 #tx-reopen 里且默认 hidden', /id="tx-reopen" hidden/.test(html), '');
check('收起按钮带 title（说清它会让笔记占满）', /id="btn-tx-collapse" title="[^"]*笔记占满/.test(html), '');
check('展开按钮带 title', /id="btn-tx-expand" title="[^"]+"/.test(html), '');
check('搜索框还在原来的位置（没被搬走）', /id="tx-search"/.test(html), '');
check('逐字稿容器还在', /id="transcript-view"/.test(html), '');

console.log('\n=== 2. JS：切换函数 + 持久化 + 启动时恢复 ===');
check('有 setTranscriptCollapsed 函数', /function setTranscriptCollapsed\(/.test(js), '');
check('有 restoreTranscriptCollapsed 函数', /function restoreTranscriptCollapsed\(/.test(js), '');
check('收起按钮绑到 setTranscriptCollapsed(true)', /\$\('btn-tx-collapse'\)\.onclick\s*=\s*\(\)\s*=>\s*setTranscriptCollapsed\(true\)/.test(js), '');
check('展开按钮绑到 setTranscriptCollapsed(false)', /\$\('btn-tx-expand'\)\.onclick\s*=\s*\(\)\s*=>\s*setTranscriptCollapsed\(false\)/.test(js), '');
check('启动时会恢复上次的选择', /bind\(\);\s*[\s\S]{0,300}restoreTranscriptCollapsed\(\)/.test(js), '');
check('偏好存 localStorage 而不是服务端配置', /localStorage\.setItem\(TX_COLLAPSED_KEY/.test(js), '');
check('localStorage 读写都有 try/catch（隐私模式不能崩）', (js.match(/localStorage\.(get|set)Item\(TX_COLLAPSED_KEY/g) || []).length === 2 && /catch\s*\{[\s\S]{0,200}\}/.test(js), '');
check('切换时同时控制 tx-collapsed 类和 tx-reopen 的 hidden', /classList\.toggle\('tx-collapsed'/.test(js) && /\$\('tx-reopen'\)\.hidden\s*=\s*!collapsed/.test(js), '');
check('恢复时不再回写一次（save:false）', /setTranscriptCollapsed\(want,\s*\{\s*save:\s*false\s*\}\)/.test(js), '');

console.log('\n=== 3. CSS：收起真的把那一列压掉、正文真的占满 ===');
const blockOf = (sel) => {
  // 取 CSS 规则体的正确姿势：把整份 CSS 的空格/换行压成单空格，
  // 再按「选择器完全相等 + 后面紧跟 {」去找，最后按花括号配对取出规则体。
  // 踩过两次：① 只认 `{` 结尾的行 → 一行写完的规则取不到；
  //          ② 只按单行选择器比 → 跨行的逗号组（`.a .markdown,\n.a .mm {`）也取不到。
  const flat = css.replace(/\s+/g, ' ');
  const want = sel.replace(/\s+/g, ' ').trim();
  let from = 0;
  while (true) {
    const i = flat.indexOf(want, from);
    if (i < 0) return '';
    from = i + want.length;
    // 选择器左边必须是规则开头（行首 / } 之后 / ; 之后），右边紧跟 {
    const prev = i === 0 ? '' : flat[i - 1];
    if (prev && !'};'.includes(prev) && flat.slice(i - 20, i).trim() !== '') {
      // 允许前面还有别的选择器（逗号组），此时要求左边是 , 或空白起点
      if (prev !== ',' && prev !== ' ') continue;
    }
    const after = flat.slice(i + want.length).match(/^\s*\{/);
    if (!after) continue;
    const open = i + want.length + after[0].length - 1;
    let depth = 0;
    for (let j = open; j < flat.length; j++) {
      if (flat[j] === '{') depth++;
      else if (flat[j] === '}') {
        depth--;
        if (depth === 0) return flat.slice(open + 1, j) + '\n';
      }
    }
    return '';
  }
};
const collapsedPanes = blockOf('.panes.tx-collapsed');
check('.panes.tx-collapsed 存在且变成一列', /grid-template-columns:\s*1fr/.test(collapsedPanes), collapsedPanes.slice(0, 80));
const hiddenTx = blockOf('.panes.tx-collapsed .tx-pane');
check('收起时 .tx-pane 是 display:none（真藏起来，不是透明度）', /display:\s*none/.test(hiddenTx), hiddenTx.trim());
const bodyW = blockOf('.panes.tx-collapsed .markdown,\n.panes.tx-collapsed .mm');
check('收起后正文有宽度上限（防带鱼屏长行）', /max-width:/.test(bodyW), bodyW.slice(0, 100));
check('那个上限不小于 900px —— 小了就白收（踩过 74ch 的坑）', (() => {
  const m = bodyW.match(/max-width:\s*(\d+)px/);
  return !!m && Number(m[1]) >= 900;
})(), bodyW.slice(0, 120));
check('收起后正文不再写 margin:auto 居中（那样看着像没收起）', !/margin:\s*0\s+auto/.test(bodyW), bodyW.slice(0, 120));
check('手机端收起不破坏布局（.tx-pane 的隐藏与宽度无关）', !/@media/.test(hiddenTx), '');

console.log('\n=== 4. 不影响别的功能 ===');
check('没删掉既有 id（transcript-view / tx-search / tx-note 都在）',
  ['transcript-view', 'tx-search', 'tx-note'].every((id) => new RegExp(`id="${id}"`).test(html)), '');
check('逐字稿面板只在 .panes 内部收起，没有全局隐藏 .pane', !/^\.pane\s*\{[^}]*display:\s*none/m.test(css), '');
check('笔记面板本身（第一个 .pane）没有被隐藏规则波及', !/\.panes\.tx-collapsed\s+\.pane\s*\{[^}]*display:\s*none/.test(css), '');
check('导航/工具栏（.tb-group）没被改动', /\$\('btn-export-pdf'\)\.onclick/.test(js), '');

console.log(`\n=== ${pass} 通过 / ${fails.length} 失败 ===`);
if (fails.length) {
  console.log('失败项：');
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
