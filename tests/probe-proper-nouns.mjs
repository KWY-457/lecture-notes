/**
 * 真跑一条录音的 AI 笔记，检查「专名核对」是否真的生效。
 *
 * 不依赖浏览器：用 globalThis.fetch 沙箱把 `/api/llm` 转发到真服务
 * （8788 的 POST /api/llm，server.mjs:914，它会再转发到硅基流动）。
 * 只打印，不写回服务端。
 *
 * 用法：node tests/probe-proper-nouns.mjs [lectureId]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BASE = process.env.BASE || 'http://127.0.0.1:8788';
const ID = process.argv[2] || '67916f92-87c1-4cf5-94aa-65e06a65dc9d';

const realFetch = globalThis.fetch.bind(globalThis);
let calls = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.includes('/api/llm')) throw new Error('测试环境只代理 /api/llm，收到：' + u);
  calls++;
  return realFetch(BASE + '/api/llm', init);
};

const { generateAINote } = await import(pathToFileURL(path.join(ROOT, 'public', 'llm.js')).href);
const summarize = await import(pathToFileURL(path.join(ROOT, 'public', 'summarize.js')).href);

const dir = path.join(ROOT, 'data', 'lectures', ID);
const raw = JSON.parse(fs.readFileSync(path.join(dir, 'transcript.json'), 'utf8'));
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
const segments = raw.segments || raw;
const analysis = summarize.analyze({ segments, meta });

const t0 = Date.now();
const out = await generateAINote({
  segments,
  analysis,
  meta: {
    title: meta.title,
    course: meta.course,
    createdAt: meta.createdAt,
    duration: Number(meta.duration) || 0,
  },
  options: { style: 'exam' },
  onProgress: (msg) => process.env.VERBOSE && console.log('  ·', msg),
});
const ms = Date.now() - t0;

const md = out.markdown || '';
console.log(`\n用时 ${(ms / 1000).toFixed(1)}s，LLM 调用 ${calls} 次，${md.length} 字符`);
console.log(`unverified = ${JSON.stringify(out.unverified)}`);
console.log(`fixes      = ${JSON.stringify(out.fixes || [])}`);
console.log(`invented   = ${JSON.stringify((out.invented || []).map((x) => `${x.text}：${x.claim}`))}`);
console.log(`terms      = ${JSON.stringify((out.terms || []).map((x) => `${x.text}(${x.count})`))}`);

console.log('\n--- 章节标题 ---');
for (const m of md.matchAll(/^###\s+(.+)$/gm)) console.log('  ' + m[1]);

console.log('\n--- 人名出现（带称谓）---');
const names = new Map();
for (const m of md.matchAll(/[\u4e00-\u9fa5]{2,3}(?=院士|先生|女士|教授|老师)/g)) {
  names.set(m[0], (names.get(m[0]) || 0) + 1);
}
for (const [n, c] of [...names].sort((a, b) => b[1] - a[1])) console.log(`  ${n} × ${c}`);

console.log('\n--- 需要回听核对的地方 ---');
const i = md.indexOf('## 需要回听核对');
if (i < 0) console.log('  （无这一节）');
else {
  const j = md.indexOf('\n## ', i + 5);
  console.log(md.slice(i, j < 0 ? undefined : j).trim());
}

const srcFlat = segments.map((s) => String(s.text || '')).join('').replace(/\s/g, '');
console.log('\n--- 逐字稿里到底有没有「林俊德」---');
console.log(`  「林俊德」出现 ${(srcFlat.match(/林俊德/g) || []).length} 次；「林俊泽」${(srcFlat.match(/林俊泽/g) || []).length} 次；「林进德」${(srcFlat.match(/林进德/g) || []).length} 次`);
