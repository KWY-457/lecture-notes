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
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const css = fs.existsSync(path.join(ROOT, 'public', 'style.css'))
  ? fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8')
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

const dead = [];
for (const id of defined) {
  if (refCount(id)) continue;
  // 给 CSS 用的（#id 选择器）不算死
  if (new RegExp(`#${id}\\b`).test(css)) continue;
  // HTML 内部互相引用也不算死：<input list="x"> 指向 <datalist id="x">，
  // <label for="x">、aria-describedby="x" 同理
  if (new RegExp(`(?:list|for|aria-describedby|aria-labelledby|form)="${id}"`).test(html)) continue;
  dead.push(id);
}

console.log(`HTML 定义 ${defined.length} 个 id，其中 ${dead.length} 个没人引用（app.js 和 style.css 都没提到）`);
if (!dead.length) {
  console.log('✓ 没有死元素');
  process.exit(0);
}
console.log('');
for (const id of dead) console.log(`  ${id.padEnd(18)} ${snippet(id)}`);
console.log('');
console.log('这些元素改了界面之后没人用：要么接上逻辑，要么删掉，别留着让人误会。');
