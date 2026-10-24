/**
 * 转写质量回归 —— 对着基线卡阈值（第⑨项 ②）。
 *
 * 用法：
 *   node tests/check-quality-baseline.mjs            # 校验
 *   node tests/check-quality-baseline.mjs --update   # 重建基线
 *
 * 基线文件：tests/quality-baseline.json
 *
 * 设计上的两条取舍，先说清楚：
 *
 * ① **基线按「录音 id」对齐，不按「第几条」。** 用户随时会新增/删除讲次，
 *    按下标对齐只要多一条录音就全体错位，比不测还糟。
 *
 * ② **基线不是「绝对分数线」，是「这条录音上次的实测值」。** 阈值就是
 *    基线值本身加一点容差。因为 data/lectures 里的 transcript.json 是
 *    已经转好的静态文件，同一份输入重跑指标必须得出同一个数 —— 任何漂移
 *    都意味着指标函数被改坏了（或者有人改了清洗规则）。这正是要抓的东西。
 *
 *    如果这条录音被**重新转写**过（模型换了、段数变了），旧基线自动作废：
 *    脚本会报「记录已变，需要 --update」，而不是报一堆假的回归失败。
 *
 * 哪些指标进基线、为什么不进：
 *   ✅ 段数 / 字数 / 字每秒      —— 硬事实，变了就是内容变了
 *   ✅ 繁体残留 / 杂符率        —— 第③项，必须单调不升
 *   ✅ 段内自发重复段数         —— 幻觉最硬的指纹
 *   ✅ 标点密度                 —— 引擎差异，同一条录音不许掉
 *   ✅ 主题数 / 单词标题数      —— 标题质量的直接指标（长块单词标题是老毛病）
 *   ❌ 可疑段数                 —— hallucinationScore 只抓重复/语速/无标点，
 *                                  抓不住「整段不通」，且清洗前后会自然变化，
 *                                  卡死它会逼着以后不敢改清洗规则
 */
import fs from 'node:fs';
import path from 'node:path';
import { inspectAll } from './quality-metrics.mjs';

const HERE = path.dirname(import.meta.dirname);
const BASELINE = path.join(HERE, 'tests', 'quality-baseline.json');
const UPDATE = process.argv.includes('--update');

let pass = 0;
let fail = 0;
const check = (n, c, d = '') => {
  c ? pass++ : fail++;
  console.log(`  ${c ? '✅' : '❌'} ${n}${c ? '' : '  → ' + d}`);
};

/** 从一条记录里抽出要进基线的字段（别的字段只给人看，不进基线） */
function snapshot(r) {
  return {
    model: r.model,
    engine: r.engine,
    segments: r.segments,
    chars: r.chars,
    charsPerSec: r.charsPerSec,
    traditionalClean: r.traditionalClean,
    junkRatio: +r.junkRatio.toFixed(6),
    repSegCount: r.repSegCount,
    punctPer100: r.punctRaw.per100,
    topicCount: r.topicCountActual,
    oneWordHeadings: r.oneWordHeadings,
    // 判「记录有没有被重新转过」的指纹：段数 + 字数 + 模型，三者一起才够严
    fingerprint: `${r.segments}:${r.chars}:${r.model}`,
  };
}

const rows = inspectAll();
if (!rows.length) {
  console.log('data/lectures 里没有可查的记录，跳过。');
  process.exit(0);
}

// ── 重建基线 ────────────────────────────────────────────────────────
if (UPDATE) {
  const doc = {
    generatedAt: new Date().toISOString(),
    note: '由 tests/check-quality-baseline.mjs --update 生成。指标定义见 tests/quality-metrics.mjs。',
    records: Object.fromEntries(rows.map((r) => [r.dirName, snapshot(r)])),
  };
  fs.writeFileSync(BASELINE, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  console.log(`已重建基线：${path.relative(HERE, BASELINE)}（${rows.length} 条记录）`);
  for (const r of rows) console.log(`  ${r.id} · ${r.segments} 段 / ${r.chars} 字 / 标点 ${r.punctRaw.per100} / 单词标题 ${r.oneWordHeadings}`);
  process.exit(0);
}

// ── 校验 ────────────────────────────────────────────────────────────
console.log('\n=== 转写质量回归（对着基线卡）===\n');

if (!fs.existsSync(BASELINE)) {
  console.log(`  ⏭  基线文件不存在：${path.relative(HERE, BASELINE)}`);
  console.log('     先跑一次 node tests/check-quality-baseline.mjs --update 建立基线。');
  process.exit(0);
}

const doc = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
const base = doc.records || {};
const nowIds = new Set(rows.map((r) => r.dirName));

// 新增的录音：不失败，只是没基线可比。要求它们进基线时人得看一眼 —— 用 --update。
const missing = rows.filter((r) => !base[r.dirName]);
if (missing.length) {
  console.log(`  ⏭  ${missing.length} 条录音没有基线（新导入的），不参与比对：`);
  for (const r of missing) console.log(`       ${r.id} · ${r.title || '(无标题)'}`);
  console.log('     确认它们质量没问题后跑 --update 纳入基线。\n');
}

// 基线里有、但 recordings 里没了的：也不失败（用户删了讲次是正常操作），提醒一下。
const gone = Object.keys(base).filter((k) => !nowIds.has(k));
if (gone.length) {
  console.log(`  ⏭  ${gone.length} 条基线对应的录音已不在 data/lectures（用户删了），忽略：`);
  for (const k of gone) console.log(`       ${k.slice(0, 8)}`);
  console.log('');
}

let compared = 0;
for (const r of rows) {
  const b = base[r.dirName];
  if (!b) continue;
  compared++;
  const now = snapshot(r);
  console.log(`  ${r.id} · ${r.title || '(无标题)'}`);

  // 先判记录本身有没有变。变了就整条跳过，免得「换了模型重转」被误报成回归失败。
  if (b.fingerprint !== now.fingerprint) {
    const [bs, bc, bm] = String(b.fingerprint).split(':');
    const [ns, nc, nm] = String(now.fingerprint).split(':');
    const why = [];
    if (bs !== ns) why.push(`段数 ${bs}→${ns}`);
    if (bc !== nc) why.push(`字数 ${bc}→${nc}`);
    if (bm !== nm) why.push(`模型 ${bm}→${nm}`);
    console.log(`     ⏭  这条录音被重新转过/改过（${why.join('，')}），旧基线作废`);
    console.log(`        确认新版本质量没问题后跑 node tests/check-quality-baseline.mjs --update`);
    continue;
  }

  // 记录没变 → 指标必须**一模一样**。容差留给浮点，其余一律不许漂。
  check(`${r.id} 段数/字数未变`, now.segments === b.segments && now.chars === b.chars, `${b.segments}/${b.chars} vs ${now.segments}/${now.chars}`);
  check(`${r.id} 语速未漂`, Math.abs(now.charsPerSec - b.charsPerSec) <= 0.01, `基线 ${b.charsPerSec} 现 ${now.charsPerSec}`);
  check(`${r.id} 繁体残留未升`, now.traditionalClean <= b.traditionalClean, `基线 ${b.traditionalClean} 现 ${now.traditionalClean}`);
  check(`${r.id} 杂符率未升`, now.junkRatio <= b.junkRatio + 1e-6, `基线 ${b.junkRatio} 现 ${now.junkRatio}`);
  check(`${r.id} 段内重复段数未升`, now.repSegCount <= b.repSegCount, `基线 ${b.repSegCount} 现 ${now.repSegCount}`);
  check(`${r.id} 标点密度未降`, now.punctPer100 >= b.punctPer100 - 0.01, `基线 ${b.punctPer100} 现 ${now.punctPer100}`);
  check(`${r.id} 主题数未减`, now.topicCount >= b.topicCount, `基线 ${b.topicCount} 现 ${now.topicCount}`);
  check(`${r.id} 单词标题未增`, now.oneWordHeadings <= b.oneWordHeadings, `基线 ${b.oneWordHeadings} 现 ${now.oneWordHeadings}`);
}

if (!compared) {
  console.log('\n没有一条录音能和基线对上（可能全被重转过）。');
  console.log('若确认无误，跑 node tests/check-quality-baseline.mjs --update 重建基线。');
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('失败多半意味着指标函数或清洗规则被改了。');
  console.log('确认新行为更好之后，跑 node tests/check-quality-baseline.mjs --update 更新基线，并在提交说明里写清为什么。');
  process.exit(1);
}
