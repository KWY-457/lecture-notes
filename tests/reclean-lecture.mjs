/**
 * 对已有逐字稿「重新清洗」：不用重新转写，直接把新的清洗规则应用上去。
 * 对治理重复循环（幻觉）特别有效。
 *
 * 运行： node tests/reclean-lecture.mjs <lectureId|all> [--llm]
 *   --llm  额外跑一遍大模型校对（需要本地模型在跑）
 */
import { cleanSegments, hallucinationScore } from '../public/cleanup.js';

const BASE = 'http://127.0.0.1:8788';
const arg = process.argv[2] || 'all';
const useLLM = process.argv.includes('--llm');

const realFetch = globalThis.fetch;
globalThis.fetch = (u, o) => realFetch(String(u).startsWith('/') ? BASE + u : u, o);

const j = async (p, opts = {}) => {
  const r = await realFetch(BASE + p, {
    ...opts,
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.ok === false) throw new Error(`${p} -> ${d.error || r.status}`);
  return d;
};

const list = await j('/api/lectures');
const targets = arg === 'all' ? list.lectures : list.lectures.filter((l) => l.id === arg);
if (!targets.length) { console.error('没找到目标录音'); process.exit(1); }

let genLLM = null;
if (useLLM) ({ cleanTranscriptViaLLM: genLLM } = await import('../public/llm.js'));

for (const L of targets) {
  const detail = await j('/api/lectures/' + L.id);
  const segs = detail.transcript.segments || [];
  if (!segs.length) { console.log(`\n跳过「${L.title}」：没有逐字稿`); continue; }

  const before = segs.map((s) => s.text || '').join('');
  const cleaned = cleanSegments(segs);
  const after0 = cleaned.map((s) => s.text || '').join('');
  const suspectBefore = segs.filter((s) => hallucinationScore(s.text || '', s.end - s.start) >= 0.5).length;
  const suspectAfter = cleaned.filter((s) => s.suspect).length;

  console.log(`\n=== ${L.title} （${segs.length} 段 / ${before.length} 字）===`);
  console.log(`  清洗前：可疑段落 ${suspectBefore} 段，字数 ${before.length}`);
  console.log(`  规则清洗后：可疑段落 ${suspectAfter} 段，字数 ${after0.length}（砍掉 ${before.length - after0.length} 字重复内容）`);

  // 保留 suspect 标记，服务端会把整个 segments 原样存下来，界面据此标黄
  let final = cleaned;
  if (useLLM && genLLM) {
    try {
      console.log('  正在跑大模型校对…');
      const r = await genLLM(final, { onProgress: (m) => process.stdout.write(`\r    ${m}          `) });
      console.log(`\r    校对完成，修正 ${r.changed} 处          `);
      final = r.segments;
    } catch (e) {
      console.log(`\n    大模型校对失败，保留规则清洗结果：${e.message}`);
    }
  }

  await j(`/api/lectures/${L.id}/transcript`, {
    method: 'PUT',
    body: {
      language: detail.transcript.language || 'zh',
      engine: detail.transcript.engine || 'local',
      model: detail.transcript.model || '',
      device: detail.transcript.device || '',
      cleanedBy: useLLM && genLLM ? 'llm' : 'rule',
      text: final.map((s) => s.text).join('\n'),
      segments: final,
      duration: L.duration || 0,
    },
  });
  const got = (await j('/api/lectures/' + L.id)).transcript;
  console.log(`  已保存：${got.segments.length} 段，可疑段落 ${got.segments.filter((s) => s.suspect).length} 段`);
  const worst = got.segments.filter((s) => s.suspect).slice(0, 3);
  for (const w of worst) console.log(`     ⚠ [${Math.floor(w.start)}s] ${(w.text || '').slice(0, 70)}`);
}

console.log('\n完成。刷新页面即可看到新的逐字稿。\n');
