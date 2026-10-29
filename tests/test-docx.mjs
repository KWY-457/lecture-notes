// docx.mjs 零依赖 Markdown→Word 的结构化验证：
// 不打开 Word，直接解析 zip（EOCD + 中央目录），解压 document.xml 检查内容。
import { markdownToDocx } from '../docx.mjs';
import zlib from 'node:zlib';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
}

const md = [
  '# 课堂笔记：二叉树的遍历',
  '',
  '## 一句话概要',
  '本课讲解二叉树四种遍历方式的访问顺序。',
  '',
  '## 课堂脉络与重点',
  '### 四种遍历',
  '- **先序**：根、左、右 [01:18](#t=78)',
  '- 中序：左、根、右',
  '',
  '## 考点',
  '',
  '| 遍历 | 顺序 |',
  '| --- | --- |',
  '| 先序 | 根左右 |',
  '',
  '> 注意：中序遍历在二叉搜索树上结果递增。',
  '',
  '1. 第一步',
  '2. 第二步',
  '',
  '<details>',
  '<summary>展开完整逐字稿（按时间轴）</summary>',
  '',
  '[00:00](#t=0) 附录正文，不该出现在 Word 里。',
  '</details>',
].join('\n');

const buf = markdownToDocx(md, '二叉树的遍历');
check('返回 Buffer', Buffer.isBuffer(buf));
check('PK 魔数', buf.length > 2000 && buf[0] === 0x50 && buf[1] === 0x4B, 'size=' + buf.length);

// ---- 最小 zip 解析：EOCD + 中央目录 ----
function entriesOf(b) {
  const findEocd = () => {
    const min = Math.max(0, b.length - 65557);
    for (let i = b.length - 22; i >= min; i--) {
      if (b.readUInt32LE(i) === 0x06054b50) return i;
    }
    return -1;
  };
  const e = findEocd();
  if (e < 0) return null;
  const count = b.readUInt16LE(e + 10);
  let off = b.readUInt32LE(e + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (b.readUInt32LE(off) !== 0x02014b50) return null;
    const csize = b.readUInt32LE(off + 20);
    const nlen = b.readUInt16LE(off + 28);
    const elen = b.readUInt16LE(off + 30);
    const clen = b.readUInt16LE(off + 32);
    const lho = b.readUInt32LE(off + 42);
    const name = b.toString('utf8', off + 46, off + 46 + nlen);
    out.push({ name, csize, lho });
    off += 46 + nlen + elen + clen;
  }
  return out;
}

const entries = entriesOf(buf);
check('zip 中央目录可解析', Array.isArray(entries) && entries.length >= 4, entries ? `entries=${entries.length}` : 'null');
const names = new Set((entries || []).map((x) => x.name));
check('含 word/document.xml', names.has('word/document.xml'), [...names].join(','));
check('含 [Content_Types].xml', names.has('[Content_Types].xml'));

function inflateEntry(name) {
  const it = (entries || []).find((x) => x.name === name);
  if (!it) return null;
  const lh = it.lho;
  const nlen = buf.readUInt16LE(lh + 26);
  const elen = buf.readUInt16LE(lh + 28);
  const start = lh + 30 + nlen + elen;
  try {
    return zlib.inflateRawSync(buf.subarray(start, start + it.csize)).toString('utf8');
  } catch { return null; }
}

const docXml = inflateEntry('word/document.xml');
check('document.xml 可解压', !!docXml && docXml.length > 500, docXml ? `len=${docXml.length}` : 'null');
check('正文含标题文字', !!docXml && docXml.includes('二叉树'));
check('正文含列表要点', !!docXml && docXml.includes('根、左、右'));
check('正文含表格', !!docXml && docXml.includes('<w:tbl>'));
check('附录 details 被跳过', !!docXml && !docXml.includes('附录'));
check('正文无裸 &（XML 转义到位）', !!docXml && !/&(?!amp;|lt;|gt;|quot;|apos;|#)/.test(docXml));

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
