/**
 * 语法体检：只解析、不执行。
 * 用 vm.SourceTextModule 按 ESM 语法解析每个文件 —— 这样 import/export
 * 都能过，又不会真的跑起来（app.js 一跑就要摸 DOM）。
 *
 * 用法： node tests/syntax-check.mjs
 *
 * 注意：vm.SourceTextModule 需要 --experimental-vm-modules。以前这里靠人记着带这个
 * 参数，忘了就会看到 13 个「语法错误」—— 其实是假的，纯属没开开关。现在脚本自己
 * 检测，没开就带着参数把自己重启一遍，调用方不用管。
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (typeof vm.SourceTextModule !== 'function') {
  const r = spawnSync(
    process.execPath,
    ['--experimental-vm-modules', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit' }
  );
  process.exit(r.status ?? 1);
}

const ROOT = path.resolve(import.meta.dirname, '..');
const FILES = [
  'public/app.js',
  'public/asr-local.js',
  'public/denoise.js',
  'public/cleanup.js',
  'public/llm.js',
  'public/md.js',
  'public/providers.js',
  'public/t2s-table.js',
  'public/transcript.js',
  'public/note.js',
  'public/tex.js',
  'public/worker-asr.js',
  'docx.mjs',
  'server.mjs',
];

let bad = 0;
for (const rel of FILES) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) {
    console.log(`跳过（不存在）  ${rel}`);
    continue;
  }
  const src = fs.readFileSync(file, 'utf8');
  try {
    new vm.SourceTextModule(src, { identifier: file });
    console.log(`OK    ${rel}`);
  } catch (e) {
    bad++;
    console.log(`FAIL  ${rel}  ::  ${e.message}`);
  }
}
console.log(bad ? `\n${bad} 个文件有语法错误` : '\n全部通过');
process.exit(bad ? 1 : 0);
