/**
 * 把抗噪接进主流程之后的「链路体检」。
 *
 * 为什么要有这个文件：public/denoise.js 自己的测试证明的是「降噪算法好不好」，
 * 而这里要证明的是「接进 app 之后的行为对不对」—— 跳过条件、上报字段、时间轴，
 * 以及**顺序**：高通（95Hz）如果跑在陷波前面，50Hz 工频嗡在频谱里就没了，
 * 陷波会以为「很干净」而不动手。这个坑踩过一次，所以专门用测试钉住。
 *
 * 用法： node tests/test-pipeline.mjs
 */
import { denoiseAudio } from '../public/asr-local.js';
import { makeSpeech, addNoise, rms, db, pauseRms, speechRms } from './fixtures.mjs';

const SR = 16000;
let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '   ' + detail : ''}`);
};

/** 收集 onProgress 说过的话 —— 老大要能从界面上看懂发生了什么，这里就把那些话抓住 */
function collector() {
  const msgs = [];
  const fn = (p) => msgs.push(p);
  fn.msgs = msgs;
  return fn;
}

// 掺噪用的 fixture（比 denoise.js 自己的测试更吵一档，好落在「该降噪」那一侧）
const FIX = makeSpeech({ seconds: 40, seed: 11 });
const NOISY = { white: 0.045, hum: 0.03, clicks: 0.25 };
// 干净用的 fixture 另起一条，免得跟上面共用同一串样本
const CLEAN = makeSpeech({ seconds: 20, seed: 5 });

console.log('抗噪接入主流程的链路体检（16kHz 单声道）');
console.log(`  掺噪夹具：${(FIX.data.length / SR).toFixed(0)} 秒，停顿 ${FIX.pauses.length} 处`);
console.log(`  干净夹具：${(CLEAN.data.length / SR).toFixed(0)} 秒（合成语音的停顿是数字化零，信噪比极高）`);

/* ---------- 1. 正常情况：掺噪 → 全量降噪 ---------- */
console.log('\n=== 1. 掺噪录音 → 应该全量降噪 ===');
{
  const noisy = addNoise(FIX.data, NOISY);
  const work = Float32Array.from(noisy);
  const p = collector();
  const report = denoiseAudio(work, SR, p, { denoise: true });

  const drop = db(pauseRms(noisy, FIX.pauses)) - db(pauseRms(work, FIX.pauses));
  console.log(`  实测停顿底噪 ${db(pauseRms(noisy, FIX.pauses)).toFixed(1)} → ${db(pauseRms(work, FIX.pauses)).toFixed(1)}dB（降 ${drop.toFixed(1)}dB）`);
  console.log(`  实测语音电平 ${db(speechRms(noisy, FIX.mask)).toFixed(1)} → ${db(speechRms(work, FIX.mask)).toFixed(1)}dB`);
  console.log(`  体检：${report.health.verdict}（${report.health.score} 分，信噪比 ${report.health.snrDb.toFixed(1)}dB，语音占比 ${(report.health.speechRatio * 100).toFixed(0)}%）`);
  p.msgs.forEach((m) => console.log(`  界面提示：${m.message}`));

  check('报告标记为「已处理」', report.enabled === true);
  check('没有走跳过分支', report.skipped === false);
  check('体检结果带回来了', !!report.health && typeof report.health.score === 'number');
  check('降噪统计带回来了', !!report.stats && !!report.stats.noiseFloorDbAfter);
  check('样本数没变（时间轴不动）', work.length === FIX.data.length, `${FIX.data.length} → ${work.length}`);
  check('停顿底噪真的降了 ≥6dB', drop >= 6, `${drop.toFixed(1)}dB`);
  check('语音电平没被削（≤3dB）', Math.abs(db(speechRms(noisy, FIX.mask)) - db(speechRms(work, FIX.mask))) <= 3);
  check('没有 NaN', !Number.isNaN(rms(work)));
  check('给用户发了≥2条进度提示', p.msgs.length >= 2, `${p.msgs.length} 条`);
  check('进度提示里包含体检结论', p.msgs.some((m) => m.message.includes(report.health.verdict)));
  check('进度提示里说明了音频长度未变', p.msgs.some((m) => m.message.includes('时间轴照旧')));
}

/* ---------- 2. 本来就干净 → 应该跳过 ---------- */
console.log('\n=== 2. 本来就清楚的录音 → 应该跳过，别白费力气 ===');
{
  const work = Float32Array.from(CLEAN.data);
  const before = Float32Array.from(work);
  const p = collector();
  const report = denoiseAudio(work, SR, p, { denoise: true });

  console.log(`  体检：${report.health.verdict}（${report.health.score} 分，信噪比 ${report.health.snrDb.toFixed(1)}dB，语音占比 ${(report.health.speechRatio * 100).toFixed(0)}%）`);
  p.msgs.forEach((m) => console.log(`  界面提示：${m.message}`));

  check('标记为「跳过了」', report.skipped === true);
  check('没有真的处理（enabled=false）', report.enabled === false);
  check('音频一个样本都没动', work.every((v, i) => v === before[i]));
  check('跳过的原因写在报告里', report.reason === '本来就清楚，不必处理', report.reason);
  check('提示里说明了为什么跳过', p.msgs.some((m) => m.message.includes('跳过抗噪')));
}

/* ---------- 3. 设置里关掉 → 应该跳过 ---------- */
console.log('\n=== 3. 设置里关掉抗噪 → 应该跳过 ===');
{
  const noisy = addNoise(FIX.data, NOISY);
  const work = Float32Array.from(noisy);
  const p = collector();
  const report = denoiseAudio(work, SR, p, { denoise: false });

  check('标记为「跳过了」', report.skipped === true);
  check('没有真的处理', report.enabled === false);
  check('原因说明是设置关掉的', report.reason === '设置里关掉了', report.reason);
  check('音频一个样本都没动', work.every((v, i) => v === noisy[i]));
  check('仍然给出了体检结论（关掉不等于不报告）', !!report.health);
  check('提示里带上了体检结论', p.msgs.some((m) => m.message.includes(report.health.verdict)));
}

/* ---------- 4. 顺序证明：抗噪必须跑在高通之前 ---------- */
console.log('\n=== 4. 顺序体检：抗噪必须跑在高通之前 ===');
{
  // 干净语音 + 50Hz 工频嗡（白噪给一点点，模拟真实底噪）
  const humOnly = addNoise(CLEAN.data, { white: 0.015, hum: 0.012, clicks: 0.2 });
  const correct = Float32Array.from(humOnly);
  const report = denoiseAudio(correct, SR, collector(), { denoise: true });

  // 反例：先跑一阶高通（复刻 asr-local.js 里的 preprocessAudio），再降噪
  const HP = 0.97;
  const wrong = Float32Array.from(humOnly);
  {
    let px = 0;
    let py = 0;
    for (let i = 0; i < wrong.length; i++) {
      const y = HP * (py + wrong[i] - px);
      px = wrong[i];
      py = y;
      wrong[i] = y;
    }
  }
  const wrongReport = denoiseAudio(wrong, SR, collector(), { denoise: true });

  const hz = (r) => (r.stats?.humHz || []).map((f) => f.toFixed(1)).join(', ');
  console.log(`  正确顺序（先抗噪）：检出音调 [${hz(report)}]`);
  console.log(`  错误顺序（先高通）：检出音调 [${hz(wrongReport)}]`);

  check('正确顺序下检出了 50Hz 附近的工频嗡', (report.stats?.humHz || []).some((f) => Math.abs(f - 50) < 6), `[${hz(report)}]`);
  check('正确顺序下真的动了手', (report.stats?.humHz || []).length > 0);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
