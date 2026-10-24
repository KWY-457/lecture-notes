/**
 * 分析会话日志，算出时间都花在哪了。
 * 运行： node tests/analyze-session.mjs "<session.jsonl.zstd 路径>"
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2];

/** 会话日志是多段 zstd frame 追加写的，必须流式解压才能拿到全部内容 */
async function readAll(path) {
  const chunks = [];
  await new Promise((resolve, reject) => {
    const src = fs.createReadStream(path);
    const dec = zlib.createZstdDecompress();
    src.pipe(dec);
    dec.on('data', (c) => chunks.push(c));
    dec.on('end', resolve);
    dec.on('error', (e) => {
      // 尾部半截 frame 会报错，但前面的内容已经拿到了，接受
      if (chunks.length) resolve();
      else reject(e);
    });
    src.on('error', reject);
  });
  return Buffer.concat(chunks);
}

const raw = await readAll(file);
const lines = raw.toString('utf8').split('\n').filter(Boolean);
console.log(`解压后 ${(raw.length / 1048576).toFixed(2)} MB，共 ${lines.length} 行`);

const entries = [];
for (const line of lines) {
  try {
    entries.push(JSON.parse(line));
  } catch {}
}
console.log('\n=== 字段结构（前 3 条的键）===');
for (const e of entries.slice(0, 3)) console.log('  ' + Object.keys(e).join(', '));

const tsOf = (e) =>
  e.timestamp || e.time || e.ts || e.createdAt || e.created_at || (e.message && e.message.timestamp) || null;

const withTs = entries.filter((e) => tsOf(e));
console.log(`\n带时间戳的条目: ${withTs.length}`);

if (!withTs.length) {
  console.log('\n前 3 条原文片段：');
  for (const e of entries.slice(0, 3)) console.log(JSON.stringify(e).slice(0, 300));
  process.exit(0);
}

const t = (e) => new Date(tsOf(e)).getTime();
const first = t(withTs[0]);
const last = t(withTs[withTs.length - 1]);
console.log(`时间跨度: ${((last - first) / 60000).toFixed(1)} 分钟`);

/* 找出所有 >45 秒的空档，并说明空档前最后发生了什么 */
const gaps = [];
for (let i = 1; i < withTs.length; i++) {
  const d = t(withTs[i]) - t(withTs[i - 1]);
  if (d > 45000) gaps.push({ d, prev: withTs[i - 1], next: withTs[i] });
}
gaps.sort((a, b) => b.d - a.d);

const label = (e) => {
  const s = JSON.stringify(e);
  const type = e.type || e.kind || e.role || '?';
  const tool = e.toolName || e.name || e.tool || (e.toolCall && e.toolCall.name) || '';
  let hint = '';
  const m = s.match(/"(?:command|description|query|file_path|path)"\s*:\s*"((?:[^"\\]|\\.){0,110})/);
  if (m) hint = m[1].replace(/\\n/g, ' ').slice(0, 100);
  return `[${type}${tool ? '/' + tool : ''}] ${hint}`;
};

console.log(`\n=== 超过 45 秒的空档（共 ${gaps.length} 处，合计 ${(gaps.reduce((n, g) => n + g.d, 0) / 60000).toFixed(1)} 分钟）===`);
for (const g of gaps.slice(0, 18)) {
  const at = new Date(t(g.prev)).toTimeString().slice(0, 8);
  console.log(`  ${(g.d / 1000).toFixed(0).padStart(5)} 秒  @${at}`);
  console.log(`        之前: ${label(g.prev).slice(0, 130)}`);
  console.log(`        之后: ${label(g.next).slice(0, 130)}`);
}
