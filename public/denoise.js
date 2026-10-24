/**
 * 抗噪前端处理（纯 JS、零依赖、原地处理）
 * ==================================================================
 * 课录场景的噪声和「听不清」是两种不同的病，要分开治：
 *
 *   A. 宽带稳态噪声 —— 空调、投影仪风扇、电脑嗡嗡声、远处人声底噪。
 *      高通滤波治不了它们（能量就落在人声频段里），必须做**谱减**。
 *   B. 低频音调噪声 —— 电源 / 投影仪 / 灯整流带来的 50Hz、100Hz、150Hz 嗡声。
 *      这些在语音频段**以下**，谱减管不到，得单独**陷波**。
 *   C. 纯噪声段 —— 翻书、挪椅子、咳嗽、键盘、以及大段没人说话的空白。
 *      Whisper 遇到这类片段**不会保持沉默，它会编**（"谢谢观看""请订阅"
 *      这类幻觉就是这么来的）。所以要看**是不是语音**，不是就压下去。
 *
 * 本文件提供两个东西：
 *   1. denoiseInPlace()   —— 陷波 + 谱减 + VAD 门限，直接把 Float32Array 改掉
 *   2. analyzeRecording() —— 只分析不改，报告底噪 / 语音占比 / 可信度
 *
 * 设计约束（很重要，别随手改）：
 *   - **不改变样本数量**。整条音频的时间轴一动不动，
 *     所有 [mm:ss] 时间戳、音频跳转、SRT 字幕全都还对得上。
 *   - **非语音段是「压低」不是「删掉」**。留 -22dB 的底，
 *     让 Whisper 的 chunk 边界仍然落在自然停顿上，不制造突兀的静音切点。
 *   - 不用第三方库、不用 WASM，保证离线双击就能跑。
 *
 * 经验教训（这些坑都踩过，别再踩）：
 *   - 噪声底**不能**拿开头几帧初始化：开头正好是讲课声时，整个噪声底会被抬高，
 *     后面真正的安静段反被当成「低于噪声底」而遭殃。这里改成先收集一批帧，
 *     每个频点取分位数。
 *   - VAD 判定**不能**用全局 p10/p90 分位数：遇到「中段有一段特别吵的噪声」
 *     的录音，p90 会被拉到别处，门限直接算飞。这里改用 Otsu 直方图判阈。
 *   - 削得太狠要能自检：整段能量掉超过 9dB 就说明多半削错了，按增益整体回抬。
 */

const FFT_N = 512;          // STFT 帧长（32ms @16kHz）
const HOP = 128;            // 帧移（75% 重叠，够平滑，也不算太慢）
const BINS = FFT_N / 2 + 1;

/** 语音频段（Hz）：谱减与 VAD 只在这个范围里做判断 */
const SPEECH_LO_HZ = 120;
const SPEECH_HI_HZ = 3800;

/** 防止 log10(0) 变 -Infinity 的地板值 */
const GAMMA_MIN = 1e-8;

/** 低频音调噪声（工频嗡及其谐波）的检测范围 */
const HUM_LO_HZ = 30;
const HUM_HI_HZ = 155;

/** 自检：语音频段能量掉超过这么多 dB 就认为削过头了，整体回抬（上限 12dB） */
const RESCUE_DROP_DB = 6;
const RESCUE_MAX_DB = 12;

/* ------------------------------------------------------------------ *
 * 1. FFT（迭代式 radix-2，原地复数运算）
 * ------------------------------------------------------------------ */

const RE = new Float32Array(FFT_N);
const IM = new Float32Array(FFT_N);
const COS = new Float32Array(FFT_N / 2);
const SIN = new Float32Array(FFT_N / 2);
const REV = new Uint16Array(FFT_N);

(function initTables() {
  const half = FFT_N / 2;
  for (let i = 0; i < half; i++) {
    const a = (-2 * Math.PI * i) / FFT_N;
    COS[i] = Math.cos(a);
    SIN[i] = Math.sin(a);
  }
  let bits = 0;
  while (1 << bits < FFT_N) bits++;
  for (let i = 0; i < FFT_N; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    REV[i] = r;
  }
})();

/** 原地 FFT：re/im 长度必须是 FFT_N */
function fft(re, im) {
  for (let i = 0; i < FFT_N; i++) {
    const j = REV[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= FFT_N; size <<= 1) {
    const half = size >> 1;
    const step = FFT_N / size;
    for (let i = 0; i < FFT_N; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const l = i + j;
        const r = l + half;
        const tre = re[r] * COS[k] - im[r] * SIN[k];
        const tim = re[r] * SIN[k] + im[r] * COS[k];
        re[r] = re[l] - tre;
        im[r] = im[l] - tim;
        re[l] += tre;
        im[l] += tim;
      }
    }
  }
}

/** 原地 IFFT（共轭法，省一张反变换表） */
function ifft(re, im) {
  for (let i = 0; i < FFT_N; i++) im[i] = -im[i];
  fft(re, im);
  const inv = 1 / FFT_N;
  for (let i = 0; i < FFT_N; i++) {
    re[i] *= inv;
    im[i] = -im[i] * inv;
  }
}

/** 汉宁窗（分析窗与合成窗相同，75% 重叠时 COLA 和约等于 1.5） */
const WIN = new Float32Array(FFT_N);
(function initWindow() {
  for (let i = 0; i < FFT_N; i++) WIN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_N);
})();

/* ------------------------------------------------------------------ *
 * 2. 低频音调陷波（工频嗡）
 * ------------------------------------------------------------------ */

function hzToBin(hz, sampleRate) {
  return Math.max(1, Math.min(BINS - 1, Math.round((hz * FFT_N) / sampleRate)));
}

/**
 * 平均功率谱（抽帧算，够统计又便宜）。
 *
 * @param {Uint8Array|null} frameMask 逐帧掩码；给了就只累加掩码为 1 的帧
 * @param {number} maxSeconds 最多分析开头多少秒
 */
function averageSpectrum(data, sampleRate, frameMask = null, maxSeconds = 20) {
  const n = data.length;
  const acc = new Float64Array(BINS);
  const re = new Float32Array(FFT_N);
  const im = new Float32Array(FFT_N);
  let frames = 0;
  const limit = Math.min(n - FFT_N, Math.max(FFT_N, sampleRate * maxSeconds));
  for (let start = 0; start + FFT_N <= limit; start += HOP) {
    if (frameMask && !frameMask[start / HOP | 0]) continue;
    for (let i = 0; i < FFT_N; i++) { re[i] = data[start + i] * WIN[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < BINS; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
    frames++;
  }
  if (frames) for (let k = 0; k < BINS; k++) acc[k] /= frames;
  return { spec: acc, frames };
}

/**
 * 在语音频段以下找「又窄又高」的音调峰 —— 工频嗡的典型特征。
 *
 * 三个坑必须避开：
 *   1. 50Hz 在 512 点 FFT（16kHz）里落在 bin 1 和 bin 2 之间，能量被劈成两半，
 *      拿「比左右相邻一个点高 8 倍」去判是永远判不出来的。这里改成滑窗判据：
 *      本点比 +-2 邻点都高即可。
 *   2. 宽带噪声（白噪 / 风扇）在低频也会有起伏，不能一律陷波。
 *      所以先看频谱平坦度：整条都是宽带噪声就直接放弃陷波。
 *   3. **必须在「安静的帧」上量，不能在整条平均谱上量**：老师讲课的基频就在
 *      90~160Hz，正好压在 HUM 段里。整条平均下来这些谐波会把工频嗡淹掉，
 *      结果就是「明明有嗡声却检不出来」。只在最安静的那批帧上算，嗡声（一直存在）
 *      立刻就突出来了，而语音（断断续续）被排除在外。
 *
 * @param {Uint8Array|null} quietMask 安静帧掩码，由调用方按逐帧能量挑出来
 * @param {Array} out 可选：把每个候选音调的诊断数据塞进去（给测试看）
 * @returns {number[]} 需要陷波的频率（Hz），最多 3 个
 */
function detectHumTones(data, sampleRate, quietMask = null, out = null) {
  const loBin = hzToBin(HUM_LO_HZ, sampleRate);
  const hiBin = hzToBin(HUM_HI_HZ, sampleRate);
  const lo = Math.max(1, loBin - 2);
  const hi = Math.min(BINS - 2, hiBin + 2);
  const { spec, frames } = averageSpectrum(data, sampleRate, quietMask);
  if (frames < 4) return [];

  // 安静帧的起点列表：跨帧稳定性判据要用
  const quietStarts = [];
  if (quietMask) {
    const maxStart = Math.min(data.length - FFT_N, sampleRate * 20);
    for (let start = 0; start + FFT_N <= maxStart; start += HOP) {
      if (quietMask[start / HOP | 0]) quietStarts.push(start);
    }
  }

  // 平坦度闸门：低频段最强点跟该段中位数比。音调噪声会高出一大截，
  // 宽带噪声只是缓慢起伏，比值很小。阈值不能定太高（12 倍太严，
  // 白噪底下的 50Hz 嗡会被漏掉），5 倍配上「只在安静帧上算」已经够可靠。
  const seg = [];
  for (let k = lo; k <= hi; k++) seg.push(spec[k]);
  const segMax = Math.max(...seg);
  const segSorted = seg.slice().sort((a, b) => a - b);
  const segMed = segSorted[segSorted.length >> 1];
  if (!(segMax > segMed * 5)) return [];

  const peaks = [];
  for (let k = loBin; k <= hiBin; k++) {
    const c = spec[k];
    if (c <= spec[k - 1] || c < spec[k + 1]) continue;           // 必须是局部峰
    if (c <= spec[k - 2] * 1.12 || c <= spec[k + 2] * 1.12) continue; // 且明显突出
    if (c < segMax * 0.15) continue;                              // 太弱的不要
    // 抛物线插值求真实峰位：50Hz 在 512 点 FFT 里落在 bin 1.6，
    // 能量会偏向 bin 2，直接取 bin 中心会陷波到 62.5Hz 去（偏了 12.5Hz）。
    const d = spec[k - 1] - spec[k + 1];
    const den = spec[k - 1] - 2 * c + spec[k + 1];
    let off = den !== 0 ? (0.5 * d) / den : 0;
    if (!(off > -1 && off < 1)) off = 0;
    const hz = ((k + off) * sampleRate) / FFT_N;
    if (hz < HUM_LO_HZ || hz > HUM_HI_HZ) continue;
    peaks.push({ hz, v: c });
  }
  peaks.sort((a, b) => b.v - a.v);
  const keep = [];
  for (const p of peaks) {
    if (keep.some((q) => Math.abs(q - p.hz) < 25)) continue;

    // 跨帧稳定性：拿安静帧逐帧量这个频率的幅度，真嗡声几乎不动。
    if (quietStarts.length >= 4) {
      const mags = toneMagnitudes(data, quietStarts, p.hz, sampleRate);
      const sortedMag = Array.from(mags).sort((a, b) => a - b);
      const med = sortedMag[sortedMag.length >> 1];
      const loMag = sortedMag[Math.floor(sortedMag.length * 0.1)];
      const spreadDb = 20 * Math.log10(Math.max(1e-12, med) / Math.max(1e-12, loMag));

      // 还得够响亮：安静帧本身的电平大约是多少
      let qPow = 0;
      for (let f = 0; f < quietStarts.length; f++) {
        const s = quietStarts[f];
        let e = 0;
        for (let i = 0; i < FFT_N; i++) { const x = data[s + i] * WIN[i]; e += x * x; }
        qPow += e;
      }
      qPow = Math.sqrt(qPow / quietStarts.length);
      const relDb = 20 * Math.log10(Math.max(1e-12, med) / Math.max(1e-12, qPow));

      // 两道闸门：忽大忽小 → 不是稳态音调；弱到比整段电平低 40dB 以上 → 是泄漏旁瓣，不是噪声
      if (out) out.push({ hz: p.hz, med, spreadDb, relDb });
      if (spreadDb > 6) continue;
      if (relDb < -40) continue;
    }

    keep.push(Math.round(p.hz * 10) / 10);
    if (keep.length >= 3) break;
  }
  return keep;
}

/**
 * 量「静音区」的时域 RMS，单位 dB（满刻度 1.0 = 0dB）。
 *
 * 这是给用户看的底噪数字，所以必须跟人耳朵对得上：
 * 拿逐帧能量最低的那批帧当静音区，直接在时域上算均方根。
 * 帧长 512、帧移 128，重叠部分会被重复计入 —— 对「平均值」这种统计量无所谓。
 *
 * @param {number[]} idx   静音帧的帧号（按**处理前**的能量排出来的）
 * @param {Float32Array} data  就地改过的数据；before 要在处理前调、after 在处理后调
 * @returns {number} dB，最大值 0
 */
function floorRmsDb(idx, data, n) {
  if (!idx.length) return -120;
  let acc = 0;
  let cnt = 0;
  for (const fi of idx) {
    const start = fi * HOP;
    if (start + FFT_N > n) continue;
    for (let i = 0; i < FFT_N; i++) {
      const v = data[start + i];
      acc += v * v;
      cnt++;
    }
  }
  if (!cnt) return -120;
  return 20 * Math.log10(Math.sqrt(acc / cnt) + GAMMA_MIN);
}

/**
 * 双二阶陷波器（RBJ cookbook 的 notch）。
 * Q 越高陷波越窄 —— 20 对 50Hz 只削掉 2.5Hz 宽，语音几乎不受影响。
 */
function makeNotch(hz, q, sampleRate) {
  const w0 = (2 * Math.PI * hz) / sampleRate;
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: 1 / a0, b1: (-2 * Math.cos(w0)) / a0, b2: 1 / a0,
    a1: (-2 * Math.cos(w0)) / a0, a2: (1 - alpha) / a0,
  };
}

/** 原地二阶 IIR 滤波（直接 I 型） */
function applyBiquad(data, c) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < data.length; i++) {
    const x = data[i];
    const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = x;
    y2 = y1; y1 = y;
    data[i] = y;
  }
}

/**
 * 语音频段里「最大的那个频点」占了该频段多少能量（0~1）。
 *
 * 判据的直觉：真人语音的能量会摊在基频的一大串谐波和好几个共振峰上，
 * 单个频点最多也就占三四成；如果一个频点就占了过半，那它不是语音，
 * 是稳态音调 —— 这时候做谱减只会把它（连同它附近的信号）一起削掉。
 */
function dominantToneRatio(data, sampleRate, frameDb, loBin, hiBin) {
  const n = data.length;
  const span = hiBin - loBin + 1;
  if (!span) return 0;
  const acc = new Float64Array(BINS);
  let frames = 0;
  const re = new Float32Array(FFT_N);
  const im = new Float32Array(FFT_N);
  const limit = Math.min(n - FFT_N, sampleRate * 20);
  for (let start = 0; start + FFT_N <= limit; start += HOP * 2) {
    for (let i = 0; i < FFT_N; i++) { re[i] = data[start + i] * WIN[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < BINS; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
    frames++;
  }
  if (!frames) return 0;
  for (let k = 0; k < BINS; k++) acc[k] /= frames;

  let maxE = 0, sumE = 0;
  for (let k = loBin; k <= hiBin; k++) {
    const e = acc[k];
    sumE += e;
    if (e > maxE) maxE = e;
  }
  return sumE > 0 ? maxE / sumE : 0;
}

/**
 * 单频幅度（逐帧算，用于「这个音调稳不稳」的判据）。
 *
 * 为什么需要它：频谱上的「尖峰」不一定是噪声。1kHz 纯音经汉宁窗后，
 * 远端泄漏在 30~155Hz 那一带也能冒出个假尖峰（实测 32.9Hz），
 * 只看单帧平均谱分不出来。但**真嗡声每一帧都在、幅度几乎不变**，
 * 泄漏和语音则是忽大忽小的 —— 用「跨帧稳定性」判，一判一个准。
 */
function toneMagnitudes(data, starts, hz, sampleRate) {
  const out = new Float64Array(starts.length);
  const w = (2 * Math.PI * hz) / sampleRate;
  for (let f = 0; f < starts.length; f++) {
    const s = starts[f];
    let re = 0, im = 0;
    for (let i = 0; i < FFT_N; i++) {
      const x = data[s + i] * WIN[i];
      re += x * Math.cos(w * i);
      im -= x * Math.sin(w * i);
    }
    out[f] = (2 * Math.sqrt(re * re + im * im)) / FFT_N;
  }
  return out;
}

/** @returns {number[]} 实际施加了陷波的频率 */
function notchHum(data, sampleRate, quietMask = null, out = null) {
  const tones = detectHumTones(data, sampleRate, quietMask, out);
  if (!tones.length) return [];
  for (let pass = 0; pass < 2; pass++) {
    for (const hz of tones) {
      if (hz <= 0 || hz >= sampleRate / 2 - 100) continue;
      applyBiquad(data, makeNotch(hz, 20, sampleRate));
    }
  }
  return tones;
}

/* ------------------------------------------------------------------ *
 * 3. 噪声估计器：对每个频点追踪「长期最小值」
 * ------------------------------------------------------------------ */

/** 每个频点一份对数直方图，用来在正式追踪前求出稳健的初始噪声底 */
class BinHistogram {
  constructor(bins, loDb = -160, hiDb = -20, nb = 48) {
    this.lo = loDb;
    this.scale = nb / (hiDb - loDb);
    this.nb = nb;
    this.h = new Uint16Array(bins * nb);
  }

  add(power) {
    const bins = power.length;
    for (let k = 0; k < bins; k++) {
      const d = 10 * Math.log10(power[k] + GAMMA_MIN);
      let i = Math.round((d - this.lo) * this.scale);
      if (i < 0) i = 0; else if (i >= this.nb) i = this.nb - 1;
      this.h[k * this.nb + i]++;
    }
  }

  /** 取每频点的 q 分位数（默认 0.6：偏保守一点，宁可多减一点宽带底噪） */
  pick(out, q = 0.6) {
    const bins = out.length;
    let total = 0;
    for (let i = 0; i < this.nb; i++) total += this.h[i];
    const target = total * q;
    for (let k = 0; k < bins; k++) {
      let c = 0, idx = this.nb - 1;
      for (let i = 0; i < this.nb; i++) {
        c += this.h[k * this.nb + i];
        if (c >= target) { idx = i; break; }
      }
      const d = this.lo + (idx + 0.5) / this.scale;
      out[k] = Math.pow(10, d / 10);
    }
    return out;
  }
}

/**
 * 录音里大部分时间某个频点的能量就代表那个频点的噪声底。
 * 所以对每个频点维护一个「快速下降、缓慢上升」的包络：
 *   - 能量低于估计值 → 立刻跟下去（真的安静了）
 *   - 能量高于估计值 → 慢慢爬上来（大概率是有人在说话，别把语音当噪声学进去）
 * 这个不对称是关键：对称追踪会把老师讲课的谐波当成噪声底学走，人声就被削没了。
 */
class NoiseTracker {
  constructor(bins, init, { down = 0.6, up = 0.0025, forget = 0.003 } = {}) {
    this.p = Float32Array.from(init);
    this.min = Float32Array.from(init);
    this.down = down;
    this.up = up;
    this.forget = forget;
  }

  update(power) {
    const n = this.p.length;
    for (let k = 0; k < n; k++) {
      const x = power[k];
      const cur = this.p[k];
      const a = x < cur ? this.down : this.up;
      const next = cur + a * (x - cur);
      this.p[k] = next;
      if (next < this.min[k]) this.min[k] = next;
      else this.min[k] += this.forget * (next - this.min[k]); // 最小值缓慢遗忘，适应噪声变化
    }
  }

  /** 取一个略偏保守的噪声底：当前估计与历史最小值的较大者 */
  snapshot(out) {
    for (let k = 0; k < this.p.length; k++) out[k] = Math.max(this.p[k], this.min[k] * 1.1);
    return out;
  }
}

/* ------------------------------------------------------------------ *
 * 4. 分帧能量 + Otsu 判阈（替代失真的全局分位数）
 * ------------------------------------------------------------------ */

/**
 * 逐帧算语音频段能量（dB）。VAD 判阈、信噪比探测、体检报告都用这一份口径，
 * 免得三处各算一套、互相对不上。
 *
 * @returns {{frameDb:Float64Array, frames:number}}
 */
function analyzeFrames(data, sampleRate, loBin, hiBin) {
  const n = data.length;
  const frames = n >= FFT_N ? Math.floor((n - FFT_N) / HOP) + 1 : 0;
  const frameDb = new Float64Array(Math.max(0, frames));
  const re = new Float32Array(FFT_N);
  const im = new Float32Array(FFT_N);
  const span = hiBin - loBin + 1;
  for (let fi = 0; fi < frames; fi++) {
    const start = fi * HOP;
    for (let i = 0; i < FFT_N; i++) { re[i] = data[start + i] * WIN[i]; im[i] = 0; }
    fft(re, im);
    let e = 0;
    for (let k = loBin; k <= hiBin; k++) e += re[k] * re[k] + im[k] * im[k];
    frameDb[fi] = 10 * Math.log10(e / span + GAMMA_MIN);
  }
  return { frameDb, frames };
}

/**
 * 用 Otsu 最大类间方差在「帧能量直方图」上找一条分界线。
 * 好处：不假设噪声和语音各占多少比例 —— 遇到「中段特别吵」的录音也不会算飞。
 *
 * @returns {{threshold:number, separation:number}} separation 是两类的可分性（0~1）
 */
function otsuThreshold(values) {
  let lo = Infinity, hi = -Infinity;
  for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const NB = 96;
  if (!(hi > lo)) return { threshold: lo, separation: 0 };
  const scale = NB / (hi - lo);
  const hist = new Float64Array(NB);
  for (const v of values) {
    let i = Math.round((v - lo) * scale);
    if (i < 0) i = 0; else if (i >= NB) i = NB - 1;
    hist[i]++;
  }
  const total = values.length;
  let sumAll = 0;
  for (let i = 0; i < NB; i++) sumAll += i * hist[i];

  let wB = 0, sumB = 0, best = 0, bestIdx = 0;
  for (let i = 0; i < NB; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; bestIdx = i; }
  }
  const totalVar = (() => {
    let m = sumAll / total, s = 0;
    for (let i = 0; i < NB; i++) s += hist[i] * (i - m) * (i - m);
    return s;
  })();
  const separation = totalVar > 0 ? best / totalVar : 0;
  return { threshold: lo + (bestIdx + 0.5) / scale, separation };
}

/* ------------------------------------------------------------------ *
 * 5. 主流程
 * ------------------------------------------------------------------ */

/**
 * 对整段音频做陷波 + 谱减 + VAD 门限（原地修改 data）。
 *
 * @param {Float32Array} data     16kHz 单声道
 * @param {number} sampleRate     采样率，默认 16000
 * @param {object} opt
 *   @param {number}  opt.overSub      过减系数上限，越大越干净但可能伤语音（默认 1.3）
 *   @param {number}  opt.floorGain    语音段的增益下限（默认 0.25，约 -12dB）
 *   @param {number}  opt.silenceGain  非语音段的增益（默认 0.08，约 -22dB）
 *   @param {number}  opt.vadMarginDb  VAD 判定余量，比噪声底高多少 dB 算语音（默认 4）
 *   @param {boolean} opt.vad          是否启用 VAD 门限（默认 true）
 *   @param {boolean} opt.hum          是否做低频音调陷波（默认 true）
 * @returns {object} 诊断指标（见返回值）
 */
export function denoiseInPlace(data, sampleRate = 16000, opt = {}) {
  const {
    overSub = 1.3,
    floorGain = 0.25,
    silenceGain = 0.08,
    vadMarginDb = 4,
    vad = true,
    hum = true,
  } = opt;

  const n = data.length;
  const out = {
    frames: 0, speechFrames: 0, speechRatio: 0, speechRatioRaw: 0,
    noiseFloorDbBefore: 0, noiseFloorDbAfter: 0, peakBefore: 0, peak: 0,
    ms: 0, vadEnabled: false, thresholdDb: -Infinity, humHz: [], overSubUsed: overSub,
    appliedRescueDb: 0, humDebug: [],
  };
  if (!n || n < FFT_N * 4) return out;

  const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

  const loBin = hzToBin(SPEECH_LO_HZ, sampleRate);
  const hiBin = hzToBin(SPEECH_HI_HZ, sampleRate);

  /* ---- 第 0 步：粗看信噪比 + 挑出「安静的帧」，两个用途 ---- */
  const { frameDb } = analyzeFrames(data, sampleRate, loBin, hiBin);
  const frameCount = frameDb.length;

  // 安静帧 = 逐帧能量最低的 30%。工频嗡的检测只在它们身上做（理由见 detectHumTones）。
  const quietMask = new Uint8Array(frameCount);
  if (frameCount) {
    const order = Array.from({ length: frameCount }, (_, i) => i)
      .sort((a, b) => frameDb[a] - frameDb[b]);
    const quietCount = Math.max(8, Math.floor(frameCount * 0.3));
    for (let i = 0; i < Math.min(quietCount, frameCount); i++) quietMask[order[i]] = 1;
  }

  // 量底噪用的「静音区」：能量最低的 20% 帧。
  // 必须在任何处理之前先量一次 —— 下面所有步骤都是**原地**改 data 的，
  // 等到结尾再去量「处理前」，量到的已经是处理后的数据了。
  const quietIdx = [];
  {
    const order = Array.from({ length: frameCount }, (_, i) => i)
      .sort((a, b) => frameDb[a] - frameDb[b]);
    const k = Math.max(1, Math.floor(frameCount * 0.2));
    for (let i = 0; i < k; i++) quietIdx.push(order[i]);
  }
  const noiseFloorBeforeDb = floorRmsDb(quietIdx, data, n);

  /* ---- 第 1 步：低频音调陷波（谱减管不到语音频段以下的嗡声） ---- */
  if (hum) out.humHz = notchHum(data, sampleRate, quietMask, out.humDebug);

  /* ---- 第 1.5 步：按信噪比定过减的狠劲 ----
   * 语音比底噪高很多（干净录音）时可以削狠一点，反正伤不到；
   * 语音和底噪差不多（很吵的录音）时削狠了就是连人声一起削，必须收着点。 */
  let overSubUsed = overSub;
  if (frameCount >= 16) {
    const s = Float64Array.from(frameDb).sort();
    const snr = s[Math.floor(s.length * 0.9)] - s[Math.floor(s.length * 0.1)];
    overSubUsed = Math.max(1.0, Math.min(overSub, overSub * (0.75 + snr / 45)));
  }
  out.overSubUsed = overSubUsed;

  /* ---- 第 1.6 步：退化信号保护 ----
   * 有一条必须承认的极限：如果一个频点**从头到尾**都是同一个稳态音调，
   * 那么「它算噪声还是算信号」在数学上就是不可判的 —— 噪声底追踪器慢慢爬上去，
   * 最后把它当噪声削掉（实测能掉 18dB）。真人讲课不会这样（语音一定断断续续），
   * 但测试音、设备自检音、以及某些工频谐波会。
   * 处理办法：先看语音频段里有没有「一直存在、且占了总能量很大一头」的单音；
   * 如果有，就说明这条音频不适合做谱减，直接只做陷波、跳过谱减，绝不误伤。 */
  const toneDominance = dominantToneRatio(data, sampleRate, frameDb, loBin, hiBin);
  const spectralSubtraction = toneDominance < 0.5;
  out.toneDominance = toneDominance;
  out.spectralSubtraction = spectralSubtraction;

  /* ---- 第 2 步：分帧、噪声底初始化、逐帧谱减与叠加 ---- */
  const windowSum = new Float32Array(n);

  const hist = new BinHistogram(BINS);
  const pow = new Float32Array(BINS);
  const noise = new Float32Array(BINS);
  const gainCurve = new Float32Array(BINS);
  const prevClean = new Float32Array(BINS);
  let tracker = null;

  const re = new Float32Array(FFT_N);
  const im = new Float32Array(FFT_N);
  const acc = new Float32Array(n + FFT_N);

  const INIT_FRAMES = 40;
  const DD_ALPHA = 0.94; // 先验信噪比的平滑系数（Ephraim-Malah 的决策指向法）

  let peakBefore = 0;
  for (let i = 0; i < n; i++) { const a = Math.abs(data[i]); if (a > peakBefore) peakBefore = a; }

  // 逐帧累计「输入能量 / 谱减后能量（未乘 gainScale）」，都在语音频段内算。
  // 这是判断「有没有削过头」唯一靠谱的口径 —— 早先用「语音频点平均增益(dB)」
  // 是个陷阱：能量只落在少数谐波频点上，其余上百个空频点增益接近 0，
  // 平均下来永远是个大负数，于是干净录音也会被误判成「削狠了」而整体抬 12dB。
  let inPow = 0, subPow = 0;
  for (let fi = 0; fi < frameCount; fi++) {
    const start = fi * HOP;
    const usable = Math.min(FFT_N, n - start);
    for (let i = 0; i < usable; i++) { re[i] = data[start + i] * WIN[i]; im[i] = 0; }
    for (let i = usable; i < FFT_N; i++) { re[i] = 0; im[i] = 0; }
    fft(re, im);

    for (let k = 0; k < BINS; k++) pow[k] = re[k] * re[k] + im[k] * im[k];

    // 噪声前的初始化阶段：先攒直方图，不急着减
    if (fi < INIT_FRAMES) {
      hist.add(pow);
      if (fi === INIT_FRAMES - 1) {
        // 取 0.2 分位而不是中位数附近的 0.6 分位。
        // **这一步是干净录音能不能被保住的关键**：整条都在说话时（课录基本都是），
        // 开头这几十帧里也全是语音，取 0.6 分位等于把「语音比较弱的那些时刻」
        // 当成噪声底，于是后面每一帧的正常语音都被判成「超出噪声底」而被削掉，
        // 表现就是谱失真一大片、纯音也掉电平。取低分位后噪声底落在真正的安静处，
        // 干净录音几乎不动，吵的录音照样减得掉（噪声真的存在，低分位也能量到）。
        hist.pick(noise, 0.2);
        tracker = new NoiseTracker(BINS, noise);
        tracker.snapshot(noise);
      }
    } else {
      tracker.update(pow);
      tracker.snapshot(noise);
    }

    for (let k = 0; k < BINS; k++) {
      const nk = Math.max(noise[k], GAMMA_MIN);
      // 后验信噪比 - 1，即「超出噪声底的部分」
      const post = Math.max(0, pow[k] / (overSubUsed * nk) - 1);
      // 决策指向法：用上一帧估计的干净功率做平滑，抑制音乐噪声（musical noise）
      const prior = DD_ALPHA * (prevClean[k] / nk) + (1 - DD_ALPHA) * post;
      // 维纳增益
      let g = prior / (1 + prior);
      if (!(g > 0)) g = 0;
      // 增益下限：语音段里不让谱减把某个频点彻底掐死。
      // 掐死会在频谱上留下一个个洞，听感是「水声 / 音乐噪声」，
      // Whisper 也更容易听错词 —— 留一点底比削干净更划算。
      if (g < floorGain) g = floorGain;
      // 退化信号（整条都是稳态音调）不做谱减，增益直接给 1
      if (!spectralSubtraction) g = 1;
      gainCurve[k] = g;
      prevClean[k] = g * g * pow[k];
    }

    if (fi >= INIT_FRAMES) {
      for (let k = loBin; k <= hiBin; k++) {
        inPow += pow[k];
        subPow += pow[k] * gainCurve[k] * gainCurve[k];
      }
    }

    // 对称谱一起缩放：只改前一半会破坏共轭对称，IFFT 出来就废了
    for (let k = 0; k < BINS; k++) {
      const g = gainCurve[k];
      re[k] *= g; im[k] *= g;
      if (k > 0 && k < FFT_N / 2) { re[FFT_N - k] *= g; im[FFT_N - k] *= g; }
    }
    ifft(re, im);

    for (let i = 0; i < FFT_N; i++) {
      const s = start + i;
      if (s >= acc.length) break;
      acc[s] += re[i];
      windowSum[s] += WIN[i];
    }
  }

  out.frames = frameCount;

  /* ---- 第 4 步：整体削太狠就整体回抬 ----
   * 语音频段的能量掉太多，说明噪声底被当成语音学进去了（多半是整条都在说话、
   * 找不到真正安静的帧）。这时候再削就是纯破坏，按 dB 数把增益整体抬回来。
   * 注意这里的量纲是真的能量，不是「频点平均增益」—— 后者恒为大负数，会误触发。 */
  const energyDropDb = inPow > 0 && subPow > 0 ? 10 * Math.log10(inPow / subPow) : 0;
  let gainShift = 0;
  if (energyDropDb > RESCUE_DROP_DB) {
    gainShift = Math.min(RESCUE_MAX_DB, energyDropDb - RESCUE_DROP_DB);
    out.appliedRescueDb = gainShift;
  }
  const gainScale = Math.pow(10, gainShift / 20);

  /* ---- 第 3 步：Otsu 判阈 + 前后延展 ---- */
  const { threshold: otsuDb, separation } = otsuThreshold(frameDb);
  const sortedDb = Float64Array.from(frameDb).sort();
  const p05 = sortedDb[Math.floor(frameDb.length * 0.05)];
  const p95 = sortedDb[Math.floor(frameDb.length * 0.95)];
  const dynamicDb = p95 - p05;

  let speechRatioRaw = 1;
  let isSpeech = new Uint8Array(frameCount).fill(1);
  let thresholdDb = -Infinity;
  let usableVad = false;

  if (vad && dynamicDb >= 8 && separation >= 0.35) {
    // 门限至少要比噪声底高 vadMarginDb，免得把噪声自身的抖动算成语音
    thresholdDb = Math.max(otsuDb, p05 + vadMarginDb);
    for (let i = 0; i < frameCount; i++) isSpeech[i] = frameDb[i] >= thresholdDb ? 1 : 0;
    // 前后各延展 2 帧（约 64ms），避免把词头词尾削掉
    const HANG = 2;
    const expanded = Uint8Array.from(isSpeech);
    for (let i = 0; i < frameCount; i++) {
      if (!isSpeech[i]) continue;
      for (let j = Math.max(0, i - HANG); j <= Math.min(frameCount - 1, i + HANG); j++) expanded[j] = 1;
    }
    isSpeech = expanded;
    let on = 0;
    for (let i = 0; i < frameCount; i++) on += isSpeech[i];
    speechRatioRaw = on / frameCount;
    // 判定太极端（几乎全是语音 / 几乎没语音）说明这条录音没有可用的对比，
    // 门限只会误伤，退回「只做谱减」。
    usableVad = speechRatioRaw <= 0.92 && speechRatioRaw >= 0.06;
    if (!usableVad) { isSpeech.fill(1); speechRatioRaw = 1; }
  } else {
    isSpeech.fill(1);
  }

  /* ---- 第 4 步：逐步重建：起音快（保留语音）→ 释放慢（保住词尾） ---- */
  const ATTACK = 0.5;   // 进入语音：约 2 帧内放开（~32ms）
  const RELEASE = 0.12; // 离开语音：约 8 帧内合上（~128ms 回落）
  let env = 1;

  for (let fi = 0; fi < frameCount; fi++) {
    const start = fi * HOP;
    const target = isSpeech[fi] ? 1 : silenceGain;
    const a = target < env ? RELEASE : ATTACK;
    const step = Math.min(HOP, n - start);
    for (let j = 0; j < step; j++) {
      env += a * (target - env);
      const s = start + j;
      const w = windowSum[s];
      let v = w > 1e-6 ? acc[s] / w : data[s];
      v *= env * gainScale;
      data[s] = v > 1 ? 1 : v < -1 ? -1 : v;
    }
  }

  let peak = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(data[i]);
    if (a > peak) peak = a;
  }

  // 重叠相加的归一化是否正常（正常时窗口和 ≈ 1.5）
  let winSumMin = Infinity, winSumMax = 0;
  for (let i = 0; i < n; i++) {
    const w = windowSum[i];
    if (w < winSumMin) winSumMin = w;
    if (w > winSumMax) winSumMax = w;
  }

  out.speechFrames = isSpeech.reduce((s, v) => s + v, 0);
  out.speechRatio = out.speechFrames / frameCount;
  out.speechRatioRaw = speechRatioRaw;
  out.vadEnabled = usableVad;
  out.thresholdDb = thresholdDb;
  out.otsuSeparation = separation;
  out.dynamicDb = dynamicDb;
  out.peak = peak;
  // 诊断字段（给测试与体检报告用，不影响处理结果）
  out.winSumMin = winSumMin;
  out.winSumMax = winSumMax;
  out.energyDropDb = energyDropDb;
  out.gainScaleDb = gainShift;

  // 底噪与语音电平指标：p10 当作底噪，p90 当作语音
  const p10 = sortedDb[Math.floor(frameDb.length * 0.1)];
  const p90 = sortedDb[Math.floor(frameDb.length * 0.9)];
  out.speechDbBefore = p90;
  out.speechDbAfter = p90 + 20 * Math.log10(gainScale === 0 ? 1 : gainScale);
  // 底噪：拿「逐帧能量最低的那 20% 帧」当静音区，量它们的时域 RMS。
  // 不用 p10 直接当底噪 —— p10 是频段平均能量，跟 RMS 不是一个量纲，
  // 报给用户会得到「底噪 -9 → -4dB、降了 -5dB」这种反直觉的数。
  out.noiseFloorDbBefore = noiseFloorBeforeDb;
  out.noiseFloorDbAfter = floorRmsDb(quietIdx, data, n);
  out.peakBefore = peakBefore;  out.ms = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;
  return out;
}

/* ------------------------------------------------------------------ *
 * 6. 只分析、不改动：给界面显示「这条录音值不值得花钱转写」
 * ------------------------------------------------------------------ */

/**
 * 快速体检：不做谱减，只算底噪、语音占比和「可信度」评分。
 * 用来在转写之前就告诉用户：这条录音是清晰的、还是基本没法听。
 *
 * @returns {{noiseFloorDb:number, speechDb:number, snrDb:number, speechRatio:number,
 *            score:number, verdict:string, advice:string}}
 */
export function analyzeRecording(data, sampleRate = 16000) {
  const n = data.length;
  const empty = {
    noiseFloorDb: -120, speechDb: -120, snrDb: 0, speechRatio: 0,
    score: 0, verdict: '无音频', advice: '没有可分析的音频数据。',
  };
  if (!n || n < FFT_N * 8) return empty;

  const loBin = hzToBin(SPEECH_LO_HZ, sampleRate);
  const hiBin = hzToBin(SPEECH_HI_HZ, sampleRate);
  const { frameDb: db } = analyzeFrames(data, sampleRate, loBin, hiBin);
  if (!db.length) return empty;

  const sorted = Float64Array.from(db).sort();
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * q)))];
  const noiseFloorDb = pick(0.1);
  const speechDb = pick(0.9);
  const snrDb = Math.max(0, speechDb - noiseFloorDb);

  // 语音占比：高于「底噪 + 4dB」的帧算语音
  let speechFrames = 0;
  for (const v of db) if (v >= noiseFloorDb + 4) speechFrames++;
  const speechRatio = speechFrames / db.length;

  // 评分：信噪比为主（权重 70），录音里「有人在说话」的比例为辅（权重 30）
  const snrScore = Math.max(0, Math.min(1, (snrDb - 4) / 26));       // 4dB→0 分，30dB→满分
  const ratioScore = Math.max(0, Math.min(1, (speechRatio - 0.15) / 0.5)); // 15%→0 分，65%→满分
  let score = Math.round((snrScore * 0.7 + ratioScore * 0.3) * 100);
  // 全静音 / 近乎全静音：即使噪声底很低也不能算「清晰」
  if (pick(0.99) < -70) score = Math.min(score, 5);

  let verdict, advice;
  if (score >= 70) {
    verdict = '清晰';
    advice = '录音条件不错，本地转写就够了。';
  } else if (score >= 45) {
    verdict = '一般';
    advice = '有点底噪，建议开启抗噪处理；用 large-v3-turbo 会更稳。';
  } else if (score >= 25) {
    verdict = '偏吵';
    advice = '噪声明显、人声偏弱。建议开启抗噪，并务必用 large-v3-turbo（小模型在这种录音上会大量瞎编）。';
  } else if (pick(0.99) < -70) {
    verdict = '几乎无声';
    advice = '这条录音里几乎没有声音信号。先确认录音设备有没有真的录上，再考虑转写。';
  } else {
    verdict = '很差';
    advice = '信噪比太低，转写结果会很不可靠。建议把手机/录音笔放得离讲台更近重录，或改用带降噪的麦克风。';
  }
  return { noiseFloorDb, speechDb, snrDb, speechRatio, score, verdict, advice };
}
