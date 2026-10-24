/**
 * 浏览器本地转写：把音频解码成 16kHz 单声道，交给 Worker 里的 Whisper。
 * 全程在本机完成，音频不上传。
 */
import { denoiseInPlace, analyzeRecording } from './denoise.js';

const TARGET_RATE = 16000;

/**
 * 抗噪预处理（就地修改 Float32Array，不产生额外大对象）：
 *   1. 去直流分量
 *   2. 一阶高通滤波（截止约 95Hz）—— 滤掉风扇、投影仪、空调的低频隆隆声
 *   3. 峰值归一化到 0.95，但最多放大 10 倍（20dB），避免把噪声也抬上天
 * 都是常规语音前处理，不会伤到人声基频（人声 80Hz 以上）。
 */
function preprocessAudio(data) {
  const HP = 0.97;
  let prevX = 0;
  let prevY = 0;
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const x = data[i];
    const y = HP * (prevY + x - prevX);
    prevX = x;
    prevY = y;
    data[i] = y;
    const a = Math.abs(y);
    if (a > peak) peak = a;
  }
  if (peak > 1e-6) {
    const g = Math.min(10, 0.95 / peak);
    if (Math.abs(g - 1) > 0.02) {
      for (let i = 0; i < data.length; i++) data[i] *= g;
    }
  }
}

/**
 * 预估解码要吃掉多少内存。
 *
 * decodeAudioData 会把结果**重采样到 AudioContext 的采样率**，
 * 所以我们直接把 context 建成 16kHz —— 96 分钟的立体声录音，
 * 解码结果是 16k×2×4×5760s ≈ 736MB，而不是按 48kHz 解出来的 2.2GB。
 */
export function estimateDecodeMemory(durationSec, channels = 2) {
  const rate = TARGET_RATE;
  const decoded = durationSec * rate * channels * 4; // 解码结果（16kHz，仍为立体声）
  const mono = durationSec * rate * 4;               // 最终交给 Whisper 的单声道
  return { decodedBytes: decoded, monoBytes: mono, peakBytes: decoded + mono };
}

/**
 * 抗噪处理：谱减 + 噪声底追踪 + VAD 门限 + 稳态音调陷波。
 * 就地修改 data，**不改变样本数量**（时间轴一动不动，所有时间戳仍然准）。
 * 已导出：方便离线用 Node 直接验（见 tests/test-pipeline.mjs），不必开浏览器。
 *
 * 体检（analyzeRecording）先跑：它比谱减自己算的那份更早，
 * 于是「该不该降噪」有据可依 ——
 *   · 底噪很低（评分 ≥70）→ 跳过，省掉一次全量处理
 *   · 很吵 → 全量降噪，并调小过减，避免连人声一起削
 */
export function denoiseAudio(data, sampleRate, onProgress, cfg = {}) {  const report = { enabled: false, skipped: false, reason: '', health: null, stats: null };

  const t0 = Date.now();
  report.health = analyzeRecording(data, sampleRate);
  const h = report.health;

  if (!cfg.denoise) {
    report.skipped = true;
    report.reason = '设置里关掉了';
    onProgress({ message: `录音体检：${h.verdict}（信噪比 ${h.snrDb.toFixed(0)}dB，语音占比 ${(h.speechRatio * 100).toFixed(0)}%），已跳过抗噪。`, pct: 3 });
    return report;
  }

  if (h.score >= 70 && h.snrDb >= 25) {
    report.skipped = true;
    report.reason = '本来就清楚，不必处理';
    onProgress({
      message: `录音体检：${h.verdict}（信噪比 ${h.snrDb.toFixed(0)}dB）—— 底噪很低，跳过抗噪，保持原声。`,
      pct: 3,
    });
    return report;
  }

  onProgress({
    message: `录音体检：${h.verdict}（信噪比 ${h.snrDb.toFixed(0)}dB，语音占比 ${(h.speechRatio * 100).toFixed(0)}%）。${h.advice}`,
    pct: 3,
  });

  const stats = denoiseInPlace(data, sampleRate, { vad: true, hum: true });
  report.enabled = true;
  report.stats = stats;
  report.ms = Date.now() - t0;

  const hum = (stats.humHz || []).map((f) => f.toFixed(0)).join('/');
  const humText = hum ? `，压掉 ${hum}Hz 的稳态嗡声` : '';
  const drop = stats.noiseFloorDbBefore - stats.noiseFloorDbAfter;
  onProgress({
    message:
      `抗噪完成（${report.ms}ms）：底噪 ${stats.noiseFloorDbBefore.toFixed(0)} → ${stats.noiseFloorDbAfter.toFixed(0)}dB（降 ${drop.toFixed(0)}dB），` +
      `说话段占比 ${(stats.speechRatio * 100).toFixed(0)}%${humText}。音频长度未变，时间轴照旧。`,
    pct: 4,
  });
  return report;
}

/**
 * 解码任意音频/视频文件 → 16kHz 单声道 Float32Array
 * @returns {Promise<{data: Float32Array, duration: number, channels: number, sourceRate: number}>}
 */
export async function decodeToMono16k(arrayBuffer, onProgress = () => {}) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new Error('当前浏览器不支持 Web Audio，无法在本地转写');
  onProgress('正在解码音频（这一步很吃内存，请耐心等）…');

  // 关键：直接用 16kHz 的 context 解码，解码结果就是 16kHz，省掉 2/3 内存
  let ctx;
  try {
    ctx = new AC({ sampleRate: TARGET_RATE });
  } catch {
    ctx = new AC();
  }
  let decoded;
  try {
    // 不要再 slice(0) —— 那会多复制一整份压缩数据；decodeAudioData 会接管这个 buffer
    decoded = await ctx.decodeAudioData(arrayBuffer);
  } catch (e) {
    await ctx.close().catch(() => {});
    throw new Error('这个音频格式浏览器解不开（' + (e.message || e) + '）。建议转换成 mp3 / m4a / wav 再试。');
  }
  onProgress('正在降为单声道…');
  const duration = decoded.duration;
  const frames = Math.ceil(duration * TARGET_RATE);
  const off = new OfflineAudioContext(1, frames, TARGET_RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  const gain = off.createGain();
  try {
    gain.channelCount = 1;
    gain.channelCountMode = 'explicit';
    gain.channelInterpretation = 'speakers';
  } catch {}
  src.connect(gain);
  gain.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  // 这里**不做**去直流 / 高通 / 归一化 —— 那三步会抹掉工频嗡（高通截止 95Hz，
  // 而嗡声常在 50/60Hz），陷波就再也找不到它要压的东西。
  // 顺序固定为：解码 → 抗噪（先看原始频谱）→ 高通 + 归一化 → 交给 Whisper。
  const data = rendered.getChannelData(0);
  const info = { duration, channels: decoded.numberOfChannels, sourceRate: decoded.sampleRate };
  // 尽快释放大对象
  try {
    src.buffer = null;
    decoded = null;
  } catch {}
  await ctx.close().catch(() => {});
  return { data, ...info };
}

/**
 * 主入口：本地转写整段音频
 * @param {Blob|ArrayBuffer} input
 * @param {object} cfg {model, device, cdn, modelHost, language, denoise}
 * @param {(p:{message:string, pct:number}) => void} onProgress
 * @param {() => boolean} isCancelled
 */
export async function transcribeLocal(input, cfg, onProgress = () => {}, isCancelled = () => false) {
  const buf = input instanceof Blob ? await input.arrayBuffer() : input;
  const mb = buf.byteLength / 1048576;
  if (mb > 260) {
    throw new Error(`文件约 ${mb.toFixed(0)}MB，浏览器本地解码很可能爆内存。建议改用云端转写，或把录音切成几段。`);
  }
  const { data, duration } = await decodeToMono16k(buf, (m) => onProgress({ message: m, pct: 2, stage: 'decode' }));

  // 抗噪要在高通之前：高通截止 95Hz，会先抹掉工频嗡，陷波就找不着目标了
  const denoise = denoiseAudio(data, TARGET_RATE, (p) => onProgress({ ...p, stage: 'decode' }), cfg);
  preprocessAudio(data); // 收尾：去直流 + 高通 + 峰值归一化（最多放大 10 倍）
  onProgress({ message: '音频准备完毕，正在载入转写模型…', pct: 5, stage: 'model' });

  const worker = new Worker(new URL('./worker-asr.js', import.meta.url), { type: 'module' });
  const cleanup = () => {
    try {
      worker.terminate();
    } catch {}
  };

  try {
    const result = await new Promise((resolve, reject) => {
      let segments = [];
      let device = '';
      const checkCancel = setInterval(() => {
        if (isCancelled()) {
          worker.postMessage({ type: 'cancel' });
          clearInterval(checkCancel);
          cleanup();
          reject(new Error('已取消'));
        }
      }, 400);

      worker.onerror = (e) => {
        clearInterval(checkCancel);
        reject(new Error('转写 Worker 出错：' + (e.message || '未知')));
      };
      worker.onmessage = (ev) => {
        const m = ev.data || {};
        if (m.type === 'progress') onProgress({ message: m.message || '处理中…', pct: m.pct ?? 1, stage: m.stage, heartbeat: m.heartbeat, slices: m.slices });
        else if (m.type === 'loaded') {
          device = m.device;
          onProgress({
            message: `模型已就绪（${m.device === 'webgpu' ? '显卡加速' : 'CPU —— 会很慢，建议先释放显存或改用小模型'}）`,
            pct: 1,
            stage: 'model',
            device: m.device,
          });
        }
        else if (m.type === 'partial') {
          segments = m.segments;
          onProgress({ message: `转写中… 已得到 ${segments.length} 段`, pct: Math.max(2, m.pct || 0), stage: 'transcribe', heartbeat: m.heartbeat, slices: m.slices, partial: segments });
        } else if (m.type === 'done') {
          clearInterval(checkCancel);
          resolve({ segments: m.segments, text: m.text, device });
        } else if (m.type === 'cancelled') {
          clearInterval(checkCancel);
          reject(new Error('已取消'));
        } else if (m.type === 'error') {
          clearInterval(checkCancel);
          reject(new Error(m.message));
        }
      };

      worker.postMessage(
        {
          type: 'run',
          audio: data,
          sampleRate: TARGET_RATE,
          language: cfg.language,
          windowSec: 600,
          cfg: { model: cfg.model, device: cfg.device, dtype: cfg.dtype, cdn: cfg.cdn, modelHost: cfg.modelHost },
        },
        [data.buffer]
      );
    });
    return { ...result, duration, engine: 'local', model: cfg.model, denoise };
  } finally {
    cleanup();
  }
}
