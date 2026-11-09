/**
 * 界面自检：public/app.js 里 $('xxx') 引用的每个 id，都必须在 public/index.html 里存在。
 *
 * 为什么需要这个：整套界面是原生 JS 直接取 DOM，写错一个 id 只在浏览器控制台抛
 * "Cannot set properties of null"，测试和语法检查都抓不到。改界面之前先跑这个。
 *
 *   node tests/check-ui-ids.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
/**
 * 除了 app.js，还要扫 public/ 下别的模块 —— 2026-11-09 加的 public/onboard.js
 * （新手引导）会拿 #onboard-modal、#ob-key、#ob-agree-check 这些 id，
 * 只扫 app.js 会把它们全报成「引用了但 HTML 里没有」的假错。
 */
const SRC_FILES = fs
  .readdirSync(path.join(ROOT, 'public'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => path.join(ROOT, 'public', f));
const app = SRC_FILES.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

/** HTML 里定义的 id */
const defined = new Set();
for (const m of html.matchAll(/\bid="([^"]+)"/g)) defined.add(m[1]);
/**
 * 还有一类 id 不在 index.html 里：**由 JS 现场创建的**。
 * 新手引导（public/onboard.js）整块内容都是 createElement 造出来的，
 * 里面的 #ob-key / #ob-agree-check 自然搜不到 HTML。
 *
 * 只认 el(...) 调用里那个 `id: 'xxx'`，别把 providers.js 里的 `id: 'Qwen/Qwen2.5-7B-Instruct'`
 * 这类模型标识也吃进来 —— 那些不是 DOM id，混进来会把「未引用清单」冲成噪音。
 */
for (const m of app.matchAll(/\bel\(\s*'[a-z0-9]+',\s*\{([^}]*)\}/gi)) {
  for (const k of m[1].matchAll(/\bid:\s*'([^']+)'/g)) defined.add(k[1]);
}

/** app.js 里引用到的 id：$('x') 以及 document.getElementById('x') */
const used = new Map(); // id -> 出现次数
for (const m of app.matchAll(/\$\('([^']+)'\)/g)) used.set(m[1], (used.get(m[1]) || 0) + 1);
for (const m of app.matchAll(/getElementById\('([^']+)'\)/g)) used.set(m[1], (used.get(m[1]) || 0) + 1);

/**
 * 被 HTML 自己引用的 id 也算「活着」：
 *   <input list="model-presets"> 指向 <datalist id="model-presets">
 * 这种由浏览器消费，app.js 里当然搜不到，不该报成没人用。
 *
 * 注意别把 data-for="cloud" 这种自定义属性算进来 —— 它的值是个语义标签，不是元素 id。
 * 所以下面每个属性名前面都加了 (?<![\w-]) ，保证匹配的是完整属性名。
 */
for (const m of html.matchAll(/(?<![\w-])(?:list|form|for|aria-labelledby|aria-describedby|aria-controls)="([^"]+)"/g)) {
  for (const id of m[1].split(/\s+/).filter(Boolean)) used.set(id, (used.get(id) || 0) + 1);
}

const missing = [...used.keys()].filter((id) => !defined.has(id)).sort();
const unused = [...defined].filter((id) => !used.has(id)).sort();

console.log(`HTML 里定义的 id：${defined.size} 个`);
console.log(`app.js 引用的 id：${used.size} 个`);
console.log('');

if (missing.length) {
  console.log(`✗ app.js 引用了但 HTML 里没有的 id（${missing.length} 个）—— 这几处一点就会报错：`);
  for (const id of missing) console.log(`    ${id}   （引用了 ${used.get(id)} 次）`);
} else {
  console.log('✓ app.js 引用的 id 全部存在');
}

if (unused.length) {
  // 不算错：有些 id 只给 CSS 或外部脚本用
  console.log('');
  console.log(`i HTML 里定义但 app.js 没引用（${unused.length} 个，可能只给样式用）：`);
  console.log('    ' + unused.join(' '));
}

process.exit(missing.length ? 1 : 0);
