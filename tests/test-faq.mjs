/**
 * 常见问题弹窗的内容回归测试（纯逻辑，不联网、不起浏览器）
 *
 * 为什么要有它：常见问题是「用户已经出问题之后」唯一的自助出口。
 * 老大原话（m35743）：「一般报错都是一堆乱码，让用户可对应找到报错问题」——
 * 也就是说，这张表的价值全在「q 是不是屏幕上真能看到的原文」。
 * 钉住四件事：
 *   ① 每条报错的 q，必须真能在源码里找到（否则用户照抄屏幕找不到，等于白写）；
 *   ② 条数不许悄悄变少（删内容是有意的，删到只剩几条就该有人问一句）；
 *   ③ 搜索只匹配问答、不匹配分组标题（搜 401 不该整组留下）；
 *   ④ 服务商教程不在这里复制一份，必须复用 onboard.js 的 TUTORIALS。
 *
 * 用法：node tests/test-faq.mjs [--verbose]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERRORS, USAGE, sections, filterFaq, faqCount } from '../public/faq.js';
import { TUTORIALS } from '../public/onboard.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');
let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? `　→　${detail}` : ''}`);
  }
};
const section = (t) => console.log(`\n=== ${t} ===`);

/* ---------- 一、条数与形状 ---------- */
section('一、条数与形状');
check('报错对照不少于 18 条', ERRORS.length >= 18, String(ERRORS.length));
check('用法问答不少于 10 条', USAGE.length >= 10, String(USAGE.length));
check('faqCount 与实际条数一致', faqCount() === ERRORS.length + USAGE.length, String(faqCount()));
{
  const bad = [...ERRORS, ...USAGE].filter((it) => !it.q || !it.a || it.q.length > 24);
  check('每条的标题都不超过 24 字（长了折成两行认不出来）', bad.length === 0, bad.map((b) => b.q).join(' | '));
}

/* ---------- 二、报错原文必须在源码里真的存在 ---------- */
section('二、报错原文对得上代码');
{
  /* 用户看到的是界面上那串字，所以 q 必须能在产品源码里找到原文。
     这里按「去掉尾部冒号后的核心片段」比对，因为代码里是
     `转写服务返回 ${status}: ` 这种拼接，用户看到的才是 `转写服务返回 401: `。 */
  const files = ['server.mjs', 'pdf.mjs', 'public/providers.js', 'public/asr-local.js', 'public/worker-asr.js', 'public/app.js'];
  let hay = '';
  for (const f of files) {
    try {
      hay += fs.readFileSync(path.join(ROOT, f), 'utf8') + '\n';
    } catch {
      /* 少一个文件就让下面的 MISS 报出来，不在这里吞 */
    }
  }
  // 这两条是「用户现象」不是程序报错原文，没有对应源码字串
  const NOT_CODE = /^(刚转完是一堆乱码)/;
  /* 代码里是 `转写服务返回 ${status}: `，用户看到的是 `转写服务返回 401: `。
     所以带数字结尾的标题，按数字前面的那截前缀去对源码。 */
  const found = (core) => {
    if (hay.includes(core)) return true;
    const m = /^(.*?)\s*\d+$/.exec(core);
    return m ? hay.includes(m[1].trim()) : false;
  };
  const miss = [];
  for (const it of ERRORS) {
    if (NOT_CODE.test(it.q)) continue;
    const core = it.q.replace(/[:：]\s*$/, '').trim();
    if (!found(core)) miss.push(core);
  }
  check('每条报错的原文都能在源码里找到', miss.length === 0, miss.join(' | '));
}

/* ---------- 三、答案里不写内部术语、不承诺做不到的事 ---------- */
section('三、答案的写作口径');
{
  const all = [...ERRORS, ...USAGE];
  // 「言简意赅」：最长的答案也不该超过 320 字，超了就是又开始讲原理了
  const long = all.filter((it) => it.a.length > 320);
  check('没有一条答案超过 320 字', long.length === 0, long.map((l) => `${l.q}(${l.a.length})`).join(' | '));
  // 内部术语：这些词对用户没有意义，写进 FAQ 只会让人更困惑
  const jargon = /token|embedding|chunk|endpoint|HTTP 头|prompt|推理框架|推理栈/i;
  const dirty = all.filter((it) => jargon.test(it.a));
  check('答案里不出现内部术语', dirty.length === 0, dirty.map((d) => d.q).join(' | '));
  // 每条都要给出「怎么办」，不能只解释现象
  const noAction = all.filter((it) => !/点|改|换|打开|设置|选|填|删|装|导|重|切|等|看|听|复制|上传|保存|关闭|关掉|勾|连|放|用/.test(it.a));
  check('每条都说了怎么办', noAction.length === 0, noAction.map((n) => n.q).join(' | '));
}

/* ---------- 四、搜索过滤 ---------- */
section('四、搜索过滤');
check('空关键词返回全部', filterFaq('').errors.length === ERRORS.length && filterFaq('').usage.length === USAGE.length, '');
check('只给空格也当空关键词', filterFaq('   ').errors.length === ERRORS.length, '');
{
  const r = filterFaq('401');
  check('搜 401 命中一条', r.errors.length === 1 && r.errors[0].q.includes('401'), `${r.errors.length} 条`);
  check('搜 401 不因分组标题而整组留下', r.usage.length === 0, `${r.usage.length} 条`);
}
{
  const r = filterFaq('备份');
  check('搜中文关键词能命中用法', r.usage.length === 1 && /备份/.test(r.usage[0].q), `${r.usage.length} 条`);
}
{
  const r = filterFaq('Headers Timeout');
  check('搜英文报错片段命中（大小写无关）', r.errors.length === 1, `${r.errors.length} 条`);
  check('大小写都行', filterFaq('headers timeout').errors.length === 1, '');
}
{
  const r = filterFaq('zzzz-不存在的东西');
  check('搜不到时两边都是空', r.errors.length === 0 && r.usage.length === 0, '');
}

/* ---------- 五、分组结构 ---------- */
section('五、分组结构');
{
  const g = sections();
  check('正好三组', g.length === 3, String(g.length));
  check('第一组是 API（复用教程，不写死文案）', g[0].id === 'api' && g[0].items === undefined, '');
  check('第二组是报错对照', g[1].id === 'errors' && g[1].items === ERRORS, '');
  check('第三组是用法与设置', g[2].id === 'usage' && g[2].items === USAGE, '');
}

/* ---------- 六、服务商教程复用首次引导 ---------- */
section('六、服务商教程复用首次引导');
{
  const ids = Object.keys(TUTORIALS);
  check('三家服务商教程都在', ids.length === 3, ids.join(','));
  check('至少包含硅基流动与自定义', ids.includes('siliconflow') && ids.includes('custom'), ids.join(','));
  const bad = ids.filter((id) => {
    const t = TUTORIALS[id];
    return !t.title || !t.tagline || !Array.isArray(t.steps) || t.steps.length < 3;
  });
  check('每家的标题/一句话/步骤都完整', bad.length === 0, bad.join(','));
  // FAQ 里不许再抄一份步骤文案 —— 抄一份就有一天会跟引导里说不一样
  const dup = Object.keys(TUTORIALS).filter((id) => ERRORS.concat(USAGE).some((it) => it.a.includes(TUTORIALS[id].steps[0])));
  check('FAQ 正文没有把教程步骤抄第二份', dup.length === 0, dup.join(','));
}

if (VERBOSE) {
  console.log('\n--- 报错标题一览 ---');
  ERRORS.forEach((e, i) => console.log(`  ${String(i + 1).padStart(2)}. ${e.q}`));
  console.log('\n--- 用法标题一览 ---');
  USAGE.forEach((u, i) => console.log(`  ${String(i + 1).padStart(2)}. ${u.q}`));
}

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
