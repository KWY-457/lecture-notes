/**
 * 笔记头部「课程 / 日期 / 时长」的回归测试
 * ------------------------------------------------------------------
 * 老大的原话：「转写完后再使用ai版笔记,课程，时间，与时长都无法正常显示」。
 *
 * 病根有两层：
 *   1. 提示词模板里直接写着「课程：（未填）｜日期：｜时长：未知」，模型只会照抄；
 *   2. app.js 组装 meta 时漏了 createdAt，且 duration 是 0（上传时没量）。
 * 所以修法是：模板不再给占位词，出稿后由 applyNoteHeader() 用真实元数据覆盖。
 *
 * 这个测试锁死三件事：
 *   - 有值时写得对（课程 / 日期 / 时长都来自 meta，不是模型编的）；
 *   - 没值时**不写占位词**（不许出现「（未填）」「未知」「日期： ｜」）；
 *   - 模型漏写这行时会补上，且不会把标题挤乱。
 */
import { applyNoteHeader } from '../public/llm.js';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}  ${detail}`);
  }
};

const PLACEHOLDERS = ['（未填）', '未知', '日期： ｜', '课程： ｜', '时长： '];

const noPlaceholder = (md, label) => {
  for (const p of PLACEHOLDERS) {
    check(`${label}：不含占位词「${p.trim() || p}」`, !md.includes(p), md.split('\n').slice(0, 4).join(' / '));
  }
};

console.log('\n=== 1. 三项都有值：写成真实数据 ===\n');
{
  const md = ['# 测试', '> 课程： （未填） ｜ 日期： ｜ 时长： 未知', '', '## 一句话概要', '', '正文'].join('\n');
  const out = applyNoteHeader(md, { course: '思想道德与法治', createdAt: '2026-10-15T10:02:15.364Z', duration: 2339 });
  check('课程写进去了', out.includes('课程：思想道德与法治'), out.split('\n')[1]);
  check('日期是 createdAt 的前 10 位', out.includes('日期：2026-10-15'), out.split('\n')[1]);
  check('时长换算成 38:59', out.includes('时长：38:59'), out.split('\n')[1]);
  noPlaceholder(out, '有值');
  check('只保留一行头部（没重复）', out.split('\n').filter((l) => /课程：|日期：/.test(l)).length === 1, out);
  check('正文结构没被破坏', out.includes('## 一句话概要') && out.includes('正文'), out);
}

console.log('\n=== 2. 三项都空：整行删掉，不留空壳 ===\n');
{
  const md = ['# 测试', '> 课程： （未填） ｜ 日期： ｜ 时长： 未知', '', '## 一句话概要'].join('\n');
  const out = applyNoteHeader(md, {});
  noPlaceholder(out, '全空');
  check('那一行彻底消失', !out.includes('课程：') && !out.includes('时长：'), out);
  check('标题还在', out.startsWith('# 测试'), out.slice(0, 40));
  check('没有留下连续空行', !/\n\n\n/.test(out), JSON.stringify(out));
}

console.log('\n=== 3. 只有课程：只写课程，不写空日期 ===\n');
{
  const md = ['# 测试', '> 课程： （未填） ｜ 日期： ｜ 时长： 未知', '', '正文'].join('\n');
  const out = applyNoteHeader(md, { course: '数据结构' });
  check('写了课程', out.includes('课程：数据结构'), out.split('\n')[1]);
  check('没写日期', !out.includes('日期'), out.split('\n')[1]);
  check('没写时长', !out.includes('时长'), out.split('\n')[1]);
  check('没有多余的分隔符', !out.includes('｜'), out.split('\n')[1]);
}

console.log('\n=== 4. 模型漏写这行：补在标题下面 ===\n');
{
  const md = ['# 测试', '', '## 一句话概要', '', '正文'].join('\n');
  const out = applyNoteHeader(md, { course: '工程制图', createdAt: '2026-10-18T12:00:00.000Z', duration: 5284 });
  const lines = out.split('\n');
  check('头部行被插到标题后', lines[0] === '# 测试' && lines[1].startsWith('> 课程：工程制图'), JSON.stringify(lines.slice(0, 3)));
  // fmtTime 超过一小时会输出 hh:mm:ss（88 分钟 = 01:28:04），这是既定行为，测试按它写
  check('时长 5284 秒 → 01:28:04', out.includes('时长：01:28:04'), lines[1]);
  check('插完仍有空行分隔正文', lines[2] === '', JSON.stringify(lines.slice(0, 3)));
}

console.log('\n=== 5. 已是对的头部：不重复、不改动 ===\n');
{
  const md = ['# 测试', '> 课程：数据结构 ｜ 日期：2026-10-10 ｜ 时长：10:00', '', '正文'].join('\n');
  const out = applyNoteHeader(md, { course: '数据结构', createdAt: '2026-10-10T00:00:00.000Z', duration: 600 });
  check('内容一致', out === md, out);
  check('头部只有一行', out.split('\n').filter((l) => l.startsWith('>')).length === 1, out);
}

console.log('\n=== 6. 空串 / 只有标题：不崩 ===\n');
{
  check('空串不抛异常', typeof applyNoteHeader('', {}) === 'string', '');
  check('空串 + 有值 → 生成一行', applyNoteHeader('', { course: 'X' }).trim() === '> 课程：X', JSON.stringify(applyNoteHeader('', { course: 'X' })));
  check('null 不抛异常', typeof applyNoteHeader(null, {}) === 'string', '');
}

console.log('\n=== 7. 离线笔记带「风格：」时不能把风格弄丢 ===\n');
{
  const md = ['# 测试', '> 课程：数据结构 ｜ 日期：2026-10-10 ｜ 时长：10:00 ｜ 风格：应试重点版', '', '正文'].join('\n');
  const out = applyNoteHeader(md, { course: '操作系统', createdAt: '2026-10-18T00:00:00.000Z', duration: 2339 });
  check('风格还在', out.includes('风格：应试重点版'), out.split('\n')[1]);
  check('课程被改成新的', out.includes('课程：操作系统'), out.split('\n')[1]);
  check('日期被改成新的', out.includes('日期：2026-10-18'), out.split('\n')[1]);
  check('时长被改成新的', out.includes('时长：38:59'), out.split('\n')[1]);
  check('三项都没重复', (out.match(/课程：/g) || []).length === 1 && (out.match(/时长：/g) || []).length === 1, out.split('\n')[1]);
}

console.log('\n=== 8. 模型把「未知」「（未填）」当正文写进去也要清掉 ===\n');
{
  const md = ['# 测试', '> 课程：（未填） ｜ 日期： ｜ 时长：未知 ｜ 风格：提纲版', '', '正文'].join('\n');
  const out = applyNoteHeader(md, {});
  check('（未填）清掉', !out.includes('（未填）'), out.split('\n')[1]);
  check('未知清掉', !out.includes('未知'), out.split('\n')[1]);
  check('空日期不留空壳', !/日期：\s*(｜|$)/m.test(out), out.split('\n')[1]);
  check('风格仍在', out.includes('风格：提纲版'), out.split('\n')[1]);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
