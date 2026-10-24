/**
 * 零依赖 Markdown → Word (.docx) 生成器。
 *
 * docx 本质是一个 zip 包，里面装 OOXML；这里用 Node 内置 zlib 手写 zip，
 * 不引入任何 npm 依赖 —— 保持产品「双击就能跑」的承诺。
 *
 * 只支持本应用笔记用到的 Markdown 子集：
 * 标题、无序/有序列表、引用、分隔线、表格、粗体、行内代码、链接与时间戳。
 * 时间戳链接 [12:34](#t=754) 在 Word 里会落成纯文本 [12:34]。
 */
import zlib from 'node:zlib';

/* ---------- zip 打包（deflate + UTF-8 文件名） ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildZip(files) {
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const comp = zlib.deflateRawSync(data, { level: 6 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // 解压所需版本
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名标志
    local.writeUInt16LE(8, 8); // 压缩方式 deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt16LE(dosTime, 12);
    c.writeUInt16LE(dosDate, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt32LE(offset, 42); // 本文件 local header 的偏移
    centrals.push(c, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }
  const centralSize = centrals.reduce((a, b) => a + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

/* ---------- OOXML ---------- */

const xmlEsc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const FONT = '<w:rFonts w:ascii="Microsoft YaHei" w:hAnsi="Microsoft YaHei" w:eastAsia="微软雅黑"/>';
const H_SZ = { 1: 32, 2: 28, 3: 26, 4: 24, 5: 22, 6: 22 }; // 单位是半磅：16pt → 32

/** 行内解析：**粗体**、`代码`、[文字](#t=秒) 时间戳、[文字](url) 链接 */
function inlineRuns(text) {
  const runs = [];
  const re = /(\*\*[^*]+\*\*)|(`[^`]+`)|(\[[^\]]*\]\([^)]*\))/g;
  let last = 0;
  let m;
  const push = (t, bold = false, code = false) => runs.push({ t, bold, code });
  while ((m = re.exec(text))) {
    if (m.index > last) push(text.slice(last, m.index));
    if (m[1]) push(m[1].slice(2, -2), true);
    else if (m[2]) push(m[2].slice(1, -1), false, true);
    else if (m[3]) {
      const mm = m[3].match(/^\[([^\]]*)\]\(([^)]*)\)$/);
      push(mm ? mm[1] : m[3]);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) push(text.slice(last));
  return runs;
}

function runXml(r) {
  const props = [FONT];
  if (r.bold) props.push('<w:b/>');
  if (r.code) props.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="微软雅黑"/>', '<w:shd w:val="clear" w:fill="F2F2F2"/>');
  return `<w:r><w:rPr>${props.join('')}</w:rPr><w:t xml:space="preserve">${xmlEsc(r.t)}</w:t></w:r>`;
}

function para(runs, { sz = 0, bold = false, before = 60, after = 60, bullet = false, indent = 0 } = {}) {
  const rpr = [FONT];
  if (sz) rpr.push(`<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>`);
  if (bold) rpr.push('<w:b/>');
  const ppr = [];
  if (rpr.length) ppr.push(`<w:rPr>${rpr.join('')}</w:rPr>`);
  ppr.push(`<w:spacing w:before="${before}" w:after="${after}" w:line="360" w:lineRule="auto"/>`);
  if (bullet || indent) ppr.push(`<w:ind w:left="${indent || 420}" w:hanging="${bullet ? 210 : 0}"/>`);
  const rs = (runs && runs.length ? runs : [{ t: '' }]).map(runXml).join('');
  const mark = bullet ? `<w:r><w:rPr>${FONT}</w:rPr><w:t>• </w:t></w:r>` : '';
  return `<w:p><w:pPr>${ppr.join('')}</w:pPr>${mark}${rs}</w:p>`;
}

const HR = '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="CCCCCC"/></w:pBdr></w:pPr></w:p>';

const BORDERS =
  '<w:tblBorders>' +
  ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="BBBBBB"/>`)
    .join('') +
  '</w:tblBorders>';

function tableXml(rows) {
  const n = Math.max(...rows.map((r) => r.length));
  const grid = `<w:tblGrid>${Array.from({ length: n }, () => '<w:gridCol w:w="2200"/>').join('')}</w:tblGrid>`;
  const trs = rows
    .map(
      (row, ri) =>
        `<w:tr>${Array.from({ length: n }, (_, ci) => {
          const runs = inlineRuns(row[ci] || '');
          const rs = (runs.length ? runs : [{ t: '' }]).map((r) => runXml({ ...r, bold: ri === 0 || r.bold })).join('');
          return `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>${BORDERS}</w:tcPr><w:p><w:pPr><w:rPr>${FONT}</w:rPr></w:pPr>${rs}</w:p></w:tc>`;
        }).join('')}</w:tr>`
    )
    .join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${BORDERS}</w:tblPr>${grid}${trs}</w:tbl>`;
}

function cellsOf(line) {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());
}

/**
 * 把应用生成的笔记 Markdown 转成 .docx 的 Buffer。
 * <details> 里的逐字稿附录不写进 Word（那是给网页端折叠用的）。
 * @param {string} md
 * @param {string} title
 * @returns {Buffer}
 */
export function markdownToDocx(md, title = '课堂笔记') {
  const lines = String(md || '').replace(/\r/g, '').split('\n');
  const body = [];
  let i = 0;
  let inDetails = false;
  let quoteBuf = [];
  const flushQuote = () => {
    if (!quoteBuf.length) return;
    body.push(quoteBuf.map((l) => para(inlineRuns(l), { indent: 420, before: 40, after: 40 })).join(''));
    quoteBuf = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (inDetails) {
      if (/^<\/details>$/i.test(t)) inDetails = false;
      i++;
      continue;
    }
    if (/^<details>$/i.test(t)) {
      flushQuote();
      inDetails = true;
      i++;
      continue;
    }
    if (/^<\/?(details|summary)>$/i.test(t)) {
      i++;
      continue;
    }
    if (!t) {
      flushQuote();
      body.push('<w:p/>');
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(t)) {
      flushQuote();
      body.push(HR);
      i++;
      continue;
    }
    // 表格（下一行是 |---| 分隔行）
    if (/^\s*\|.*\|\s*$/.test(t) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flushQuote();
      const rows = [cellsOf(line)];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(cellsOf(lines[i]));
        i++;
      }
      body.push(tableXml(rows));
      continue;
    }
    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushQuote();
      const lv = h[1].length;
      body.push(para(inlineRuns(h[2]), { sz: H_SZ[lv] || 22, bold: true, before: lv <= 2 ? 220 : 140, after: 100 }));
      i++;
      continue;
    }
    if (/^\s*>\s?/.test(t)) {
      quoteBuf.push(t.replace(/^\s*>\s?/, ''));
      i++;
      continue;
    }
    const ul = t.match(/^[-*+]\s+(.*)$/);
    if (ul) {
      flushQuote();
      body.push(para(inlineRuns(ul[1]), { bullet: true, before: 40, after: 40 }));
      i++;
      continue;
    }
    if (/^\d+[.)]\s+.*$/.test(t)) {
      flushQuote();
      body.push(para(inlineRuns(t), { indent: 420, before: 40, after: 40 }));
      i++;
      continue;
    }
    flushQuote();
    body.push(para(inlineRuns(t)));
    i++;
  }
  flushQuote();

  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:body>' +
    body.join('') +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>' +
    '</w:body></w:document>';

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    '</Types>';

  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
    '</Relationships>';

  const nowIso = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const core =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${xmlEsc(title)}</dc:title><dc:creator>讲义笔记 LectureNotes</dc:creator>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${nowIso}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${nowIso}</dcterms:modified>` +
    '</cp:coreProperties>';

  const app =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">' +
    '<Application>讲义笔记 LectureNotes</Application><AppVersion>1.0</AppVersion>' +
    '</Properties>';

  return buildZip([
    ['[Content_Types].xml', Buffer.from(contentTypes, 'utf8')],
    ['_rels/.rels', Buffer.from(rels, 'utf8')],
    ['word/document.xml', Buffer.from(documentXml, 'utf8')],
    ['docProps/core.xml', Buffer.from(core, 'utf8')],
    ['docProps/app.xml', Buffer.from(app, 'utf8')],
  ]);
}
