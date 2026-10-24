/**
 * 抗噪验证用的合成夹具与指标（测试与参数扫描共用）
 * ==================================================================
 * 为什么用合成语音而不是仓库里的真实录音：
 * data/lectures/0e0eafc7…/audio.wav 实测是 **-80dB 的全静音**（8bit PCM 全是 128），
 * 拿它验证等于验证空气。合成夹具的好处是「干净信号」已知，
 * 于是「噪声降了多少」「语音伤了多少」两个数都能算准，而不是靠感觉。
 *
 * 合成信号结构（模拟一节课）：
 *   浊音段（元音，带 4 个共振峰 + 基频起伏）→ 清音段（擦音，宽带噪声）→ 停顿
 * 掺入三类噪声：白噪（空调/底噪）、50Hz 工频嗡（投影仪/电源）、周期性敲击（键盘/翻书）
 */

export const SR = 16000;

/** 可复现随机数（xorshift32） */
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return (s / 4294967296) * 2 - 1;
  };
}

/** 元音的共振峰参数（粗略但够用） */
const VOWELS = [
  { f: [730, 1090, 2440], a: [1.0, 0.5, 0.25] }, // /a/
  { f: [530, 1840, 2480], a: [1.0, 0.4, 0.2] },  // /e/
  { f: [270, 2290, 3010], a: [1.0, 0.35, 0.2] }, // /i/
  { f: [570, 840, 2410], a: [1.0, 0.6, 0.25] },  // /o/
  { f: [300, 870, 2240], a: [1.0, 0.5, 0.2] },   // /u/
];

/**
 * 生成一段「像课堂讲话」的合成音频。
 * @returns {{data:Float32Array, mask:Uint8Array, pauses:Array<[number,number]>}}
 */
export function makeSpeech({ seconds = 60, uttSec = 1.6, pauseSec = 0.75, amp = 0.25, seed = 7 } = {}) {
  const n = Math.round(seconds * SR);
  const data = new Float32Array(n);
  const mask = new Uint8Array(n);
  const pauses = [];
  const rnd = rng(seed);

  const period = uttSec + pauseSec;
  const uttCount = Math.floor(seconds / period);
  const phase = 0;

  for (let u = 0; u < uttCount; u++) {
    const start = Math.round(u * period * SR);
    const len = Math.round(uttSec * SR);
    const vowel = VOWELS[u % VOWELS.length];
    const f0base = 100 + ((u * 37) % 60); // 基频在 100~160Hz 之间，像真人语调
    let f0 = f0base;
    const voicedLen = Math.round(len * 0.7);

    for (let i = 0; i < len; i++) {
      const s = start + i;
      if (s >= n) break;
      mask[s] = 1;
      let v = 0;
      if (i < voicedLen) {
        // 浊音：谐波叠加共振峰包络
        f0 = f0base * (1 + 0.12 * Math.sin((2 * Math.PI * i) / (len * 0.8)));
        for (let h = 1; h <= 40; h++) {
          const f = h * f0;
          if (f > 7500) break;
          let g = 0;
          for (let k = 0; k < vowel.f.length; k++) g += vowel.a[k] / (1 + Math.pow((f - vowel.f[k]) / 180, 2));
          g += 0.02 / (1 + Math.pow(f / 700, 2)); // 声门谱衰减
          v += (g / h) * Math.sin(2 * Math.PI * f * (i / SR) + phase);
        }
        v = v * 0.8 + 0.03 * rnd(); // 一点气声，避免过于纯净
      } else {
        // 清音：宽带噪声、高频抬升（/s/ /sh/ 那种）
        v = rnd() * 0.35 + (rnd() - rnd()) * 0.25;
      }
      data[s] = Math.max(-1, Math.min(1, v * amp));
    }
    // 淡入淡出，避免爆音
    const fade = Math.round(0.01 * SR);
    for (let i = 0; i < fade; i++) {
      const env = i / fade;
      const a = start + i, b = start + len - 1 - i;
      if (a < n) data[a] *= env;
      if (b >= 0 && b < n) data[b] *= env;
    }
    const pStart = start + len;
    const pEnd = Math.min(n, Math.round((u + 1) * period * SR));
    if (pEnd > pStart) pauses.push([pStart, pEnd]);
  }
  return { data, mask, pauses };
}

/** 说话几乎不带停顿的极端情况（真实课堂不会这样，用来验证「别把整条压扁」） */
export function makeDense({ seconds = 24, uttSec = 2.0, pauseSec = 0.15, amp = 0.25, seed = 11 } = {}) {
  return makeSpeech({ seconds, uttSec, pauseSec, amp, seed });
}

/** 掺入白噪 + 工频嗡 + 敲击声 */
export function addNoise(src, { white = 0.015, hum = 0.012, humHz = 50, clicks = 0.2, clickEvery = 3.7, seed = 99 } = {}) {
  const rnd = rng(seed);
  const out = new Float32Array(src.length);
  const clickGap = Math.round(clickEvery * SR);
  for (let i = 0; i < src.length; i++) {
    const t = i / SR;
    let v = src[i] + white * rnd() + hum * Math.sin(2 * Math.PI * humHz * t);
    const k = i % clickGap;
    if (k < 300) v += clicks * Math.exp(-k / 45) * rnd();
    out[i] = Math.max(-1, Math.min(1, v));
  }
  return out;
}

/* ================================================================== *
 * 指标
 * ================================================================== */
export const rms = (a, from = 0, to = a.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, to - from));
};
export const db = (x) => 20 * Math.log10(Math.max(1e-12, x));

/** 停顿段的平均 RMS —— 这是「底噪」最干净的度量（那里真的没人说话） */
export function pauseRms(a, pauses) {
  let sum = 0, cnt = 0;
  for (const [s, e] of pauses) {
    const from = s + Math.round(0.1 * SR);
    const to = e - Math.round(0.1 * SR);
    if (to <= from) continue;
    sum += rms(a, from, to) ** 2;
    cnt++;
  }
  return cnt ? Math.sqrt(sum / cnt) : 0;
}

/** 语音段平均 RMS */
export function speechRms(a, mask) {
  let sum = 0, cnt = 0;
  for (let i = 0; i < a.length; i += 160) {
    if (!mask[i]) continue;
    const to = Math.min(a.length, i + 160);
    let s = 0;
    for (let j = i; j < to; j++) s += a[j] * a[j];
    sum += s / (to - i);
    cnt++;
  }
  return cnt ? Math.sqrt(sum / cnt) : 0;
}

/**
 * 单频幅度（窗长 0.5 秒的加窗 DFT）。
 * 注意别用「跳步采样 + Goertzel」那种省事写法：跳步会把宽带噪声折叠进来，
 * 量出来的数会反过来骗人（踩过这个坑）。
 */
export function toneMag(a, hz, from = 0, len = 8192) {
  const N = Math.min(len, a.length - from);
  if (N < 64) return 0;
  let re = 0, im = 0;
  for (let i = 0; i < N; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    const x = a[from + i] * w;
    re += x * Math.cos((2 * Math.PI * hz * i) / SR);
    im -= x * Math.sin((2 * Math.PI * hz * i) / SR);
  }
  return (2 * Math.sqrt(re * re + im * im)) / N;
}

/** 256 点幅度谱 */
export function spectrum(a, from, N = 256) {
  const re = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    re[i] = (a[from + i] || 0) * w;
  }
  const mag = new Float64Array(N / 2);
  for (let k = 0; k < N / 2; k++) {
    let sr = 0, si = 0;
    for (let i = 0; i < N; i++) {
      const ang = (-2 * Math.PI * k * i) / N;
      sr += re[i] * Math.cos(ang);
      si += re[i] * Math.sin(ang);
    }
    mag[k] = Math.sqrt(sr * sr + si * si) / N;
  }
  return mag;
}

/**
 * 对数谱失真（dB）：衡量降噪对语音频谱的破坏程度。
 *
 * 两个口径一起给：
 *   - 原始 LSD：全部频点一视同仁。问题是对「干净信号本来就 -70dB 以下」的频点
 *     同样计入，那些地方本来就是数值零，任何改动都会算出很大的对数差，
 *     数字会被这些听不见的频点主导。
 *   - 加权 LSD：只统计干净信号里**真正有能量**的频点（高于该帧峰值 -50dB）。
 *     这才是「语音有没有被削变形」的实际听感口径。
 */
export function logSpectralDistortion(clean, test, mask, opts = {}) {
  const relFloorDb = opts.relFloorDb ?? -50;
  let sum = 0, cnt = 0, wsum = 0, wcnt = 0;
  for (let i = 0; i + 256 < clean.length; i += 256) {
    if (!mask[i]) continue;
    const A = spectrum(clean, i), B = spectrum(test, i);
    let peak = 0;
    for (let k = 2; k < 100; k++) if (A[k] > peak) peak = A[k];
    const gate = peak * Math.pow(10, relFloorDb / 20);
    for (let k = 2; k < 100; k++) {
      const la = Math.log10(A[k] + 1e-9), lb = Math.log10(B[k] + 1e-9);
      const d2 = (la - lb) ** 2;
      sum += d2; cnt++;
      if (A[k] >= gate) { wsum += d2; wcnt++; }
    }
  }
  return {
    lsdDb: cnt ? Math.sqrt(sum / cnt) * 20 : 0,
    weightedDb: wcnt ? Math.sqrt(wsum / wcnt) * 20 : 0,
    counted: wcnt,
  };
}

/** 一次跑完所有场景，返回指标表（参数扫描用） */
export function measure(denoiseInPlace, opt = {}, fx = {}) {
  const clean = fx.clean || makeSpeech({ seconds: 54 });
  const NOISE = fx.noise || { white: 0.02, hum: 0.015, clicks: 0.2 };
  const noisy = addNoise(clean.data, NOISE);

  const work = Float32Array.from(noisy);
  const info = denoiseInPlace(work, SR, opt);
  const lsd = logSpectralDistortion(clean.data, work, clean.mask);
  // 基线对照：**根本不降噪**，直接拿掺噪音频跟干净信号比。
  // 这个数就是「宽带噪声本身的随机起伏」在同一个指标上的表现 ——
  // 降噪后的 LSD 只要贴近或低于它，就说明没有额外引入失真。
  const baseLsd = logSpectralDistortion(clean.data, noisy, clean.mask);
  const out = {
    pauseDropDb: db(pauseRms(noisy, clean.pauses)) - db(pauseRms(work, clean.pauses)),
    speechLossDb: db(speechRms(noisy, clean.mask)) - db(speechRms(work, clean.mask)),
    lsdDb: lsd.lsdDb,
    lsdWeightedDb: lsd.weightedDb,
    lsdBaselineDb: baseLsd.lsdDb,
    lsdBaselineWeightedDb: baseLsd.weightedDb,
    rmsDropDb: db(rms(noisy)) - db(rms(work)),
    ms: info.ms,
    overSubUsed: info.overSubUsed,
    rescueDb: info.appliedRescueDb,
    humHz: info.humHz,
    peak: info.peak ?? info.peakBefore,
  };

  // 纯噪声段（20~35 秒整段换成噪声）
  {
    const mixed = Float32Array.from(noisy);
    const a = 20 * SR, b = 35 * SR;
    const rnd = rng(4242);
    for (let i = a; i < b; i++) mixed[i] = 0.05 * rnd();
    const w = Float32Array.from(mixed);
    const i2 = denoiseInPlace(w, SR, opt);
    out.silenceDropDb = db(rms(mixed, a + SR, b - SR)) - db(rms(w, a + SR, b - SR));
    out.silenceVad = i2.vadEnabled;
  }

  // 工频嗡：只留 50Hz，用加窗 DFT 量
  {
    const humOnly = addNoise(clean.data, { white: 0.001, hum: 0.06, clicks: 0 });
    const w = Float32Array.from(humOnly);
    denoiseInPlace(w, SR, opt);
    out.humDropDb = db(toneMag(humOnly, 50, 8 * SR)) - db(toneMag(w, 50, 8 * SR));
    out.humTones = opt.hum === false ? [] : denoiseInPlace(Float32Array.from(humOnly), SR, opt).humHz;
  }

  // 满语音（几乎没停顿）
  {
    const dense = makeDense({});
    const noisyDense = addNoise(dense.data, { white: 0.02, hum: 0.015, clicks: 0.1 });
    const w = Float32Array.from(noisyDense);
    const i3 = denoiseInPlace(w, SR, opt);
    out.denseRmsDropDb = db(rms(noisyDense)) - db(rms(w));
    out.denseLossDb = db(speechRms(noisyDense, dense.mask)) - db(speechRms(w, dense.mask));
    out.denseRescueDb = i3.appliedRescueDb;
    out.denseVad = i3.vadEnabled;
  }
  return out;
}
