/**
 * 界面自检：public/index.html 里定义的每个 id，看有没有被 app.js 引用。
 *
 * check-ui-ids.mjs 查的是「引用了但不存在」（会报错的那半边）；
 * 这个文件查的是反方向：「定义了但没人用」（多半是改界面时留下的死元素）。
 * 死元素本身不报错，但会让人以为功能还在。
 *
 *   node tests/check-dead-ids.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
/**
 * 「谁引用了这个 id」不能只看 app.js。
 *
 * 2026-11-09 加了 public/onboard.js（新手引导），它的容器 `#onboard-modal` 就定义在
 * index.html 里、只被 onboard.js 引用 —— 只扫 app.js 会把一个活得好好的元素报成死元素。
 * 所以把 public/ 下所有前端模块都当成引用来源；worker / 老式脚本一起扫没有副作用，
 * 反正它们引用的 id 一定也在 HTML 里。
 */
const SRC_FILES = fs
  .readdirSync(path.join(ROOT, 'public'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => path.join(ROOT, 'public', f));
const app = SRC_FILES.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
// 注意文件名是 app.css，不是 style.css。这里原来读的是 style.css（这个文件
// 从来不存在），于是 css 恒为空串、下面「给 CSS 用的不算死」那条豁免永远
// 不生效 —— 靠 CSS 选择器活着的元素会一直被报死。
const css = fs.existsSync(path.join(ROOT, 'public', 'app.css'))
  ? fs.readFileSync(path.join(ROOT, 'public', 'app.css'), 'utf8')
  : '';

const defined = [];
for (const m of html.matchAll(/\bid="([^"]+)"/g)) defined.push(m[1]);

/** 把这个 id 在 HTML 里那一行的片段取出来，方便判断它是什么 */
function snippet(id) {
  const i = html.indexOf(`id="${id}"`);
  if (i < 0) return '';
  const start = html.lastIndexOf('\n', i) + 1;
  const end = html.indexOf('\n', i);
  return html.slice(start, end < 0 ? i + 80 : end).trim().slice(0, 110);
}

function refCount(id) {
  const patterns = [
    new RegExp(`\\$\\('${id}'\\)`, 'g'),
    new RegExp(`getElementById\\('${id}'\\)`, 'g'),
    new RegExp(`'${id}'`, 'g'),
    new RegExp(`"${id}"`, 'g'),
  ];
  let n = 0;
  for (const re of patterns) n += (app.match(re) || []).length;
  // 只算「真被引用」：上面几个模式可能互相重叠，够用即可
  return n > 0 ? 1 : 0;
}

/**
 * SVG sprite 里的 <symbol id="i-xxx">不是普通元素 —— 没有人会 getElementById
 * 拿到它，页面里写的是 <use href="#i-xxx"/>，app.js 里写的是 icon('xxx')。
 * 所以它们要从「死元素」判定里摘出来，单独按引用名核对（见文件末尾）。
 *
 * app.js 里既有写死的 `#i-trash`，也有拼出来的 `#i-${name}`。拼的那种只能去
 * 认 icon('trash') / iconNode('trash') 的实参。两个来源都收。
 */
const spriteIds = defined.filter((id) => id.startsWith('i-'));
const plainIds = defined.filter((id) => !id.startsWith('i-'));

function iconRefs() {
  const used = new Set();
  const prefixes = new Set(); // 拼名字的：'#i-chevron-' + ... 这种
  const scan = (src) => {
    // 写死的 <use href="#i-xxx"/>
    for (const m of src.matchAll(/#i-([a-z0-9-]+)/g)) {
      used.add(m[1]);
      if (m[1].endsWith('-')) prefixes.add(m[1]);
    }
    // icon('xxx') / iconNode('xxx')：把整段调用抠出来，再收里面的字符串字面量。
    // 不能只匹配紧跟左括号的那一个 —— 里面常有 icon(x ? 'a' : 'b') 这种三目。
    for (const m of src.matchAll(/\bicon(?:Node)?\(/g)) {
      let i = m.index + m[0].length;
      let depth = 1;
      while (i < src.length && depth > 0) {
        if (src[i] === '(') depth++;
        else if (src[i] === ')') depth--;
        i++;
      }
      const call = src.slice(m.index, i);
      for (const s of call.matchAll(/'([a-z0-9-]+)'/g)) used.add(s[1]);
    }
  };
  scan(html);
  scan(app);
  // '#i-chevron-${...}' 这种前缀：只要 sprite 里有以它开头的图标，就算被用到。
  // 严格说不知道拼出来的是 left 还是 right，但两个都定义着才算安全 —— 所以
  // 前缀只豁免「确实存在该前缀兄弟」的那几个，不做全量放过。
  return { used, prefixes };
}

const dead = [];
for (const id of plainIds) {
  if (refCount(id)) continue;
  // 给 CSS 用的（#id 选择器）不算死
  if (new RegExp(`#${id}\\b`).test(css)) continue;
  // HTML 内部互相引用也不算死：<input list="x"> 指向 <datalist id="x">，
  // <label for="x">、aria-describedby="x" 同理
  if (new RegExp(`(?:list|for|aria-describedby|aria-labelledby|form)="${id}"`).test(html)) continue;
  dead.push(id);
}

// 图标单独核对：sprite 里定义了一堆符号，页面/app.js 里没有一处引用它们
// 就是白占体积（而且改图标时容易留着旧的不敢删）。这里只做提示，不算失败 ——
// 有些图标是给下一步用的，删了反而要重加。
const { used: usedIcons, prefixes: iconPrefixes } = iconRefs();
const unusedIcons = spriteIds.filter((id) => {
  const name = id.slice(2);
  if (usedIcons.has(name)) return false;
  // '#i-chevron-${x}' 这种动态拼的：只要前缀对得上，兄弟图标就算用到了。
  for (const p of iconPrefixes) if (name.startsWith(p)) return false;
  return true;
});

console.log(`HTML 定义 ${defined.length} 个 id（其中 ${spriteIds.length} 个是 SVG 图标），${dead.length} 个元素没人引用`);
if (unusedIcons.length) console.log(`图标 ${spriteIds.length} 个，${unusedIcons.length} 个暂时没用到：${unusedIcons.join(' ')}`);
if (!dead.length) {
  console.log('✓ 没有死元素');
  process.exit(0);
}
console.log('');
for (const id of dead) console.log(`  ${id.padEnd(18)} ${snippet(id)}`);
console.log('');
console.log('这些元素改了界面之后没人用：要么接上逻辑，要么删掉，别留着让人误会。');
process.exit(1);
