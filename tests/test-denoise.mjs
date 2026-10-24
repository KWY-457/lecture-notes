/**
 * 抗噪模块验证（纯 Node，无浏览器 / 无 ffmpeg / 无第三方库）
 *
 * 夹具与指标见 ./fixtures.mjs（合成语音 = ground truth，理由写在那里）。
 * 运行：node tests/test-denoise.mjs
 */

import { denoiseInPlace, analyzeRecording } from '../public/denoise.js';
import {
  SR, rms, db, makeSpeech, makeDense, addNoise,
  pauseRms, speechRms, toneMag, logSpectralDistortion, rng,
} from './fixtures.mjs';

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${extra ? '   ' + extra : ''}`);
  ok ? pass++ : fail++;
};

const FIX = { seconds: 54 };
const clean = makeSpeech(FIX);

console.log('\n抗噪模块验证（合成语音夹具，16kHz 单声道）\n');
console.log(`  夹具：${FIX.seconds} 秒，${Math.round(FIX.seconds / 2.35)} 句发言，停顿 ${clean.pauses.length} 处`);
console.log(`  干净语音 RMS  ${db(speechRms(clean.data, clean.mask)).toFixed(1)}dB`);
console.log(`  干净停顿 RMS  ${db(pauseRms(clean.data, clean.pauses)).toFixed(1)}dB\n`);

console.log('=== 1. analyzeRecording：录音体检（不改音频）===');
{
  const rClean = analyzeRecording(clean.data, SR);
  console.log(`  干净夹具：信噪比 ${rClean.snrDb.toFixed(1)}dB  语音占比 ${(rClean.speechRatio * 100).toFixed(0)}%  评分 ${rClean.score}「${rClean.verdict}」`);
  check('干净录音被判为清晰（评分 ≥70）', rClean.score >= 70, `score=${rClean.score}`);

  const noisy = addNoise(clean.data, { white: 0.06, hum: 0.05, clicks: 0.3 });
  const rNoisy = analyzeRecording(noisy, SR);
  console.log(`  掺噪夹具：信噪比 ${rNoisy.snrDb.toFixed(1)}dB  语音占比 ${(rNoisy.speechRatio * 100).toFixed(0)}%  评分 ${rNoisy.score}「${rNoisy.verdict}」`);
  console.log(`  建议：${rNoisy.advice}`);
  check('掺噪录音的评分明显低于干净录音', rNoisy.score < rClean.score - 20, `${rNoisy.score} < ${rClean.score - 20}`);
  check('掺噪录音给出可操作的提示', /抗噪|turbo|重录/.test(rNoisy.advice));

  const silent = new Float32Array(SR * 5);
  const rSilent = analyzeRecording(silent, SR);
  check('全静音输入不崩且如实报告', rSilent.score === 0, `「${rSilent.verdict}」`);

  const realSilent = new Float32Array(SR * 30);
  const rReal = analyzeRecording(realSilent, SR);
  check('30 秒全静音不会被评为清晰', rReal.score <= 5, `「${rReal.verdict}」score=${rReal.score}`);
}

console.log('\n=== 2. 谱减：底噪降多少 / 语音伤多少 ===');
{
  const NOISE = { white: 0.02, hum: 0.015, clicks: 0.2 };
  const noisy = addNoise(clean.data, NOISE);
  const work = Float32Array.from(noisy);
  const info = denoiseInPlace(work, SR);

  const pauseBefore = pauseRms(noisy, clean.pauses);
  const pauseAfter = pauseRms(work, clean.pauses);
  const speechBefore = speechRms(noisy, clean.mask);
  const speechAfter = speechRms(work, clean.mask);
  const lsd = logSpectralDistortion(clean.data, work, clean.mask);
  // 基线：完全不降噪，直接拿掺噪音频跟干净信号比。
  // 它代表「宽带噪声本身的随机起伏」在这个指标上的水平 —— 降噪后只要不高于它太多，
  // 就说明处理没有额外破坏语音（LSD 这个指标对「噪声本来就在那儿」是不敏感的）。
  const baseLsd = logSpectralDistortion(clean.data, noisy, clean.mask);

  console.log(`  停顿段底噪  ${db(pauseBefore).toFixed(1)}dB → ${db(pauseAfter).toFixed(1)}dB   降 ${(db(pauseBefore) - db(pauseAfter)).toFixed(1)}dB`);
  console.log(`  语音段电平  ${db(speechBefore).toFixed(1)}dB → ${db(speechAfter).toFixed(1)}dB   变化 ${(db(speechBefore) - db(speechAfter)).toFixed(1)}dB`);
  console.log(`  对数谱失真 ${lsd.lsdDb.toFixed(1)}dB（全频点） / ${lsd.weightedDb.toFixed(1)}dB（听感口径）`);
  console.log(`  基线（完全不降噪）：${baseLsd.lsdDb.toFixed(1)}dB / ${baseLsd.weightedDb.toFixed(1)}dB（听感口径）`);
  console.log(`  VAD ${info.vadEnabled ? '已启用' : '未启用'}   语音帧占比 ${(info.speechRatio * 100).toFixed(0)}%   过减 ${info.overSubUsed.toFixed(2)}   回抬 ${info.appliedRescueDb.toFixed(1)}dB   耗时 ${info.ms.toFixed(0)}ms / 音频 ${FIX.seconds}s`);

  check('样本数不变（时间轴不动）', work.length === clean.data.length, `in=${clean.data.length} out=${work.length}`);
  check('停顿段底噪下降 ≥6dB', db(pauseBefore) - db(pauseAfter) >= 6, `${(db(pauseBefore) - db(pauseAfter)).toFixed(1)}dB`);
  check('语音电平损失 ≤3dB', db(speechBefore) - db(speechAfter) <= 3, `${(db(speechBefore) - db(speechAfter)).toFixed(1)}dB`);
  check('语音谱失真不高于「不降噪」基线（听感口径）', lsd.weightedDb <= baseLsd.weightedDb + 1.5,
    `${lsd.weightedDb.toFixed(1)}dB vs 基线 ${baseLsd.weightedDb.toFixed(1)}dB`);
  check('处理速度 ≥10 倍实时', info.ms < (FIX.seconds * 1000) / 10, `${info.ms.toFixed(0)}ms`);
  check('没有 NaN / 削顶', !Number.isNaN(rms(work)) && rms(work) < 1, `rms=${rms(work).toFixed(4)}`);
}

console.log('\n=== 3. 50Hz 工频嗡（投影仪 / 电源）===');
{
  const noisy = addNoise(clean.data, { white: 0.001, hum: 0.06, clicks: 0 });
  const work = Float32Array.from(noisy);
  const info = denoiseInPlace(work, SR);
  const before = db(toneMag(noisy, 50, 8 * SR));
  const after = db(toneMag(work, 50, 8 * SR));
  console.log(`  50Hz 分量  ${before.toFixed(1)}dB → ${after.toFixed(1)}dB   降 ${(before - after).toFixed(1)}dB   检出音调 [${info.humHz.join(', ')}]Hz`);
  check('工频嗡被检出', info.humHz.length > 0, `[${info.humHz.join(', ')}]`);
  check('工频嗡被压掉 ≥12dB', before - after >= 12, `${(before - after).toFixed(1)}dB`);

  // 语音频段内的音调不能被动
  const tone = new Float32Array(SR * 8);
  for (let i = 0; i < tone.length; i++) tone[i] = 0.3 * Math.sin((2 * Math.PI * 1000 * i) / SR);
  const toneOut = Float32Array.from(tone);
  const tInfo = denoiseInPlace(toneOut, SR);
  const toneLoss = db(toneMag(tone, 1000, 2 * SR)) - db(toneMag(toneOut, 1000, 2 * SR));
  console.log(`  1kHz 纯音（语音频段内）损失 ${toneLoss.toFixed(1)}dB   检出音调 [${tInfo.humHz.join(', ')}]`);
  for (const d of tInfo.humDebug) {
    console.log(`    候选 ${d.hz.toFixed(1)}Hz：相对整段电平 ${d.relDb.toFixed(1)}dB，跨帧抖动 ${d.spreadDb.toFixed(1)}dB`);
  }
  check('语音频段内的纯音不陷波（损失 ≤6dB）', toneLoss <= 6, `${toneLoss.toFixed(1)}dB`);

  // 宽带白噪不该被当成工频嗡
  const white = new Float32Array(SR * 8);
  const r = rng(77);
  for (let i = 0; i < white.length; i++) white[i] = 0.2 * r();
  const wInfo = denoiseInPlace(Float32Array.from(white), SR);
  check('宽带白噪不会被误判成工频嗡', wInfo.humHz.length === 0, `[${wInfo.humHz.join(', ')}]`);
}

console.log('\n=== 4. 纯噪声段（整段没人说话）—— Whisper 幻觉的源头 ===');
{
  const noisy = addNoise(clean.data, { white: 0.02, hum: 0.015 });
  const mixed = Float32Array.from(noisy);
  const a = 20 * SR, b = 35 * SR;
  const rnd = rng(4242);
  for (let i = a; i < b; i++) mixed[i] = 0.05 * rnd();

  const work = Float32Array.from(mixed);
  const info = denoiseInPlace(work, SR);
  const before = db(rms(mixed, a + SR, b - SR));
  const after = db(rms(work, a + SR, b - SR));
  console.log(`  纯噪声段 RMS  ${before.toFixed(1)}dB → ${after.toFixed(1)}dB   降 ${(before - after).toFixed(1)}dB`);
  console.log(`  VAD 判定：语音帧占比 ${(info.speechRatio * 100).toFixed(0)}%（门限 ${info.thresholdDb.toFixed(1)}dB，Otsu 可分性 ${info.otsuSeparation.toFixed(2)}）`);
  check('纯噪声段被压 ≥12dB', before - after >= 12, `${(before - after).toFixed(1)}dB`);

  const preA = rms(mixed, (20 - 3) * SR, (20 - 0.5) * SR), preB = rms(work, (20 - 3) * SR, (20 - 0.5) * SR);
  const postA = rms(mixed, (35 + 0.5) * SR, (35 + 3) * SR), postB = rms(work, (35 + 0.5) * SR, (35 + 3) * SR);
  console.log(`  噪声段前语音 变化 ${(db(preA) - db(preB)).toFixed(1)}dB，段后 ${(db(postA) - db(postB)).toFixed(1)}dB`);
  check('噪声段前后的语音没被连带削掉（各 ≤3dB）', db(preA) - db(preB) <= 3 && db(postA) - db(postB) <= 3);
  check('边界处没有突然静音（起音快、释放慢生效）', rms(work, 20 * SR, (20 + 0.05) * SR) < rms(work, (20 - 0.2) * SR, 20 * SR));
}

console.log('\n=== 5. 边界与异常输入 ===');
{
  const tiny = new Float32Array(100);
  const r1 = denoiseInPlace(tiny, SR);
  check('超短音频不崩', r1.frames === 0 && tiny.length === 100);

  const silence = new Float32Array(SR * 3);
  denoiseInPlace(silence, SR);
  check('全静音不崩、不产生 NaN', !Number.isNaN(rms(silence)));

  const dc = new Float32Array(SR * 3);
  dc.fill(0.3);
  denoiseInPlace(dc, SR);
  check('纯直流不崩', !Number.isNaN(rms(dc)));

  // 全程都在说话（几乎没有停顿）→ 不该把整条压扁
  const dense = makeDense({});
  const noisyDense = addNoise(dense.data, { white: 0.02, hum: 0.015, clicks: 0.1 });
  const work = Float32Array.from(noisyDense);
  const r5 = denoiseInPlace(work, SR);
  const loss = db(speechRms(noisyDense, dense.mask)) - db(speechRms(work, dense.mask));
  console.log(`  满语音夹具（${dense.pauses.length} 处短停顿）：VAD ${r5.vadEnabled ? '启用' : '停用'}，回抬 ${r5.appliedRescueDb.toFixed(1)}dB，语音电平变化 ${loss.toFixed(1)}dB`);
  check('没有停顿的录音不会被整体压扁（语音损失 ≤6dB）', loss <= 6, `${loss.toFixed(1)}dB`);

  // 干净录音不该被降噪折腾坏
  const cleanup = Float32Array.from(clean.data);
  const r6 = denoiseInPlace(cleanup, SR);
  const cleanLoss = db(speechRms(clean.data, clean.mask)) - db(speechRms(cleanup, clean.mask));
  const cleanLsd = logSpectralDistortion(clean.data, cleanup, clean.mask);
  console.log(`  本来就干净的录音：语音变化 ${cleanLoss.toFixed(1)}dB，谱失真 ${cleanLsd.lsdDb.toFixed(1)}dB / ${cleanLsd.weightedDb.toFixed(1)}dB（听感口径），回抬 ${r6.appliedRescueDb.toFixed(1)}dB`);
  check('干净录音不被明显破坏（听感口径 <6dB）', cleanLsd.weightedDb < 6, `${cleanLsd.weightedDb.toFixed(1)}dB`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
