/**
 * 真并发测试：两条**真的**云端转写同时跑，验证进度栏不会串。
 *
 * cdp-jobs.mjs / cdp-guard.mjs 都是造假 job 档案，只能证明「归属逻辑」对。
 * 本脚本要证明的是真链路：真发 POST /transcribe、真走 HTTP 到 ASR 服务、
 * 两个请求真的同时在飞。
 *
 * 为了不花钱、不需要真 Key，测试期间把 asr 配置临时指到 tests/mock-asr.mjs
 * 这个假服务（延迟 6 秒返回，顺便记录并发峰值），跑完**原样还原**配置。
 *
 * 流程：
 *   1. 备份当前 asr 配置 → 指向本地假 ASR；
 *   2. 造两条 8 秒测试录音；
 *   3. 开甲点转写，不等完成立刻切到乙点转写；
 *   4. 全程断言「当前打开哪条就只显示哪条进度」；
 *   5. 查假服务记录的并发峰值，必须 ≥ 2（证明确实同时在跑）；
 *   6. 删测试录音、还原配置。
 *
 * 用法：先起 mock（node tests/mock-asr.mjs），再跑本脚本。
 *   node tests/cdp-concurrent.mjs [--cdp 9222] [--app http://127.0.0.1:8788/] [--mock 8799]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardConfig } from './config-guard.mjs';

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const CDP_PORT = Number(argOf('--cdp', '9222'));
const APP_URL = argOf('--app', 'http://127.0.0.1:8788/');
const MOCK_PORT = Number(argOf('--mock', '8799'));
const API = APP_URL.replace(/\/$/, '');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? '  →  ' + extra : ''}`);
  }
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onopen = () =>
      resolve({
        send(method, params = {}) {
          const msgId = ++id;
          ws.send(JSON.stringify({ id: msgId, method, params }));
          return new Promise((res, rej) => pending.set(msgId, { res, rej }));
        },
        close: () => ws.close(),
      });
    ws.onerror = () => reject(new Error('WebSocket 连不上'));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
        return;
      }
    };
  });
}

const J = (body) => `(() => { ${body} })()`;

async function apiJson(p, opts = {}) {
  const r = await fetch(API + '/api' + p, {
    ...opts,
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.ok === false) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

/** 从示例音频里切一段 wav（保持原格式，只改长度字段） */
function sliceWav(srcPath, secStart, secLen, rate = 8000) {
  const b = fs.readFileSync(srcPath);
  const hdr = b.subarray(0, 44);
  const s = Math.floor(secStart * rate);
  const n = Math.floor(secLen * rate);
  const data = b.subarray(44 + s, 44 + s + n);
  const h = Buffer.from(hdr);
  h.writeUInt32LE(36 + data.length, 4);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

async function makeLecture(title, wavBuf) {
  const r = await fetch(API + '/api/lectures?filename=' + encodeURIComponent(title + '.wav'), {
    method: 'POST',
    headers: { 'content-type': 'audio/wav' },
    body: wavBuf,
  });
  const d = await r.json();
  if (!r.ok || d.ok === false) throw new Error(d.error || '导入失败');
  return d.lecture.id;
}

async function main() {
  // mock 必须活着，否则整轮测试都是在测「请求立刻失败」，没有意义
  let mockUp = false;
  try {
    const r = await fetch(`http://127.0.0.1:${MOCK_PORT}/stats`);
    mockUp = r.ok;
  } catch {}
  if (!mockUp) {
    console.error(`\n💥 假 ASR 服务没起来。先跑：node tests/mock-asr.mjs ${MOCK_PORT}`);
    process.exit(1);
  }

  // 配置兜底还原：finally 里那套字段级还原只管「正常跑完」，
  // 这个管「中途崩了 / 被 run-all 超时杀掉」—— 两种都要，缺一个就会把
  // 用户的服务商改成 127.0.0.1:8799 这个不存在的假地址。
  const restoreConfig = await guardConfig(API);

  const before = (await apiJson('/config')).config.asr;
  // 只备份要动的那几个字段，还原时逐字写回去
  const backup = {
    provider: before.provider,
    cloudProvider: before.cloudProvider,
    endpoint: before.endpoint,
    model: before.model,
  };
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const want = APP_URL.replace(/\/$/, '');
  const page =
    list.find((t) => t.type === 'page' && t.url.startsWith(want)) ||
    list.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
  if (!page) throw new Error('CDP 里没有可用页面');
  console.log(`\n连上页面：${page.url}`);
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  const evalIn = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 失败');
    return r.result.value;
  };

  let idA = null;
  let idB = null;
  try {
    /* ---- 0. 把转写指向假服务 ---- */
    console.log('\n=== 0. 把转写临时指向本地假 ASR（不花钱、不用真 Key） ===');
    await apiJson('/config', {
      method: 'PUT',
      body: {
        asr: {
          provider: 'custom',
          cloudProvider: 'custom',
          endpoint: `http://127.0.0.1:${MOCK_PORT}/v1/audio/transcriptions`,
          model: 'mock-whisper',
          apiKey: 'mock-key-for-test',
        },
      },
    });
    const now = (await apiJson('/config')).config.asr;
    check('转写已指向假服务', now.provider === 'custom' && now.endpoint.includes(String(MOCK_PORT)), JSON.stringify(now.endpoint));
    // 大模型校对会真的去外网，测试里关掉，只测转写链路
    await apiJson('/config', { method: 'PUT', body: { llm: { enabled: false } } });

    const srcWav = path.join(ROOT, 'data/lectures/0e0eafc7-7371-4fc4-8b37-3d28f6ea3c38/audio.wav');
    idA = await makeLecture('并发测试甲', sliceWav(srcWav, 20, 8));
    idB = await makeLecture('并发测试乙', sliceWav(srcWav, 120, 8));
    check('两条测试录音造好了', !!idA && !!idB);

    await cdp.send('Page.reload', { ignoreCache: true });
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      if (await evalIn('!!(window.__LN__ && window.__LN__.jobs)').catch(() => false)) break;
    }
    await sleep(800);

    const openTo = async (id) => {
      await evalIn(J(`window.location.hash = '#/l/' + ${JSON.stringify(id)}; return 1;`));
      await sleep(800);
    };
    const snap = () =>
      evalIn(
        J(`const st = window.__LN__;
        const w = document.getElementById('progress-wrap');
        return {
          cur: st.state.current?.lecture?.id || null,
          jobs: [...st.jobs.keys()],
          hidden: w.hidden,
          label: document.getElementById('progress-label').textContent,
          stage: document.getElementById('progress-stage').textContent,
          btn: document.getElementById('btn-transcribe').textContent,
          btnDisabled: document.getElementById('btn-transcribe').disabled,
          hint: document.getElementById('transcribe-hint').textContent,
          listJobs: document.querySelectorAll('#lecture-list .li-job').length,
        };`)
      );

    /* ---- 1. 甲开跑 ---- */
    console.log('\n=== 1. 打开甲，点转写（假服务要等 6 秒） ===');
    await openTo(idA);
    await evalIn(J(`document.getElementById('btn-transcribe').click(); return 1;`));
    await sleep(1500);
    const s1 = await snap();
    check('甲的任务建起来了', s1.jobs.includes(idA), JSON.stringify(s1.jobs));
    check('甲的进度栏展开', s1.hidden === false);
    check('甲显示云端阶段', s1.stage.includes('云端转写'), s1.stage);
    check('甲的按钮变成「在转」', s1.btn.includes('转写中'), s1.btn);

    /* ---- 2. 甲还在跑，切到乙（老大报的那个场景） ---- */
    console.log('\n=== 2. 甲还在跑，切到乙 ===');
    await openTo(idB);
    await sleep(400);
    const s2 = await snap();
    check('当前录音是乙', s2.cur === idB, s2.cur);
    check('★ 乙自己是干净的，没有进度栏', s2.hidden === true, `hidden=${s2.hidden} label=${s2.label}`);
    check('乙的按钮可点', s2.btnDisabled === false);
    check('乙的提示语说明另有录音在转', s2.hint.includes('另有'), s2.hint);
    check('甲的任务档案没被切走', s2.jobs.includes(idA), JSON.stringify(s2.jobs));

    /* ---- 3. 乙上也点转写，两条真并发 ---- */
    console.log('\n=== 3. 在乙上也点转写 → 两个 HTTP 请求同时在飞 ===');
    await evalIn(J(`document.getElementById('btn-transcribe').click(); return 1;`));
    await sleep(1500);
    const s3 = await snap();
    check('乙也建了任务', s3.jobs.includes(idB) && s3.jobs.includes(idA), JSON.stringify(s3.jobs));
    check('两条任务同时存在', s3.jobs.length === 2, `任务数=${s3.jobs.length}`);
    check('乙的进度栏显示的是乙自己', s3.hidden === false && s3.stage.includes('云端转写'), s3.stage);
    check('侧栏两条都有转写小字', s3.listJobs === 2, `小字=${s3.listJobs}`);

    const mid = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/stats`)).json();
    check('★ 假服务确认两条请求真的同时在跑', mid.peakConcurrent >= 2, `并发峰值=${mid.peakConcurrent}`);

    /* ---- 4. 来回切，进度栏各归各的 ---- */
    console.log('\n=== 4. 甲乙之间来回切 ===');
    await openTo(idA);
    await sleep(500);
    check('切回甲：进度栏展开', (await snap()).hidden === false);
    await openTo(idB);
    await sleep(500);
    check('切到乙：进度栏仍展开（乙也在转）', (await snap()).hidden === false);
    // 注意：跑到这里甲可能已经自己跑完了，任务数会自然减少，所以不能断言「一定是 2 条」。
    // 真正要防的是「切来切去凭空冒出一个谁都没点过的任务」。
    const s4 = await snap();
    check(
      '来回切不会凭空造出新任务',
      s4.jobs.every((x) => x === idA || x === idB),
      JSON.stringify(s4.jobs)
    );

    /* ---- 5. 等跑完 ---- */
    console.log('\n=== 5. 等两条跑完 ===');
    let done = false;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      if ((await snap()).jobs.length === 0) {
        done = true;
        break;
      }
    }
    check('两条任务都结束了', done);

    const final = await apiJson('/lectures');
    const la = final.lectures.find((l) => l.id === idA);
    const lb = final.lectures.find((l) => l.id === idB);
    check('甲状态是已转写', la?.status === 'transcribed', JSON.stringify(la && { s: la.status }));
    check('乙状态是已转写', lb?.status === 'transcribed', JSON.stringify(lb && { s: lb.status }));

    const ta = await apiJson(`/lectures/${idA}/transcript`);
    const tb = await apiJson(`/lectures/${idB}/transcript`);
    const segA = ta.transcript?.segments?.length || 0;
    const segB = tb.transcript?.segments?.length || 0;
    check('甲有真实逐字稿', segA > 0, `段数=${segA}`);
    check('乙有真实逐字稿', segB > 0, `段数=${segB}`);
    // 两条内容必须不同 —— 相同就说明串了
    check('两甲逐字稿内容不串（各自是自己的）', ta.transcript?.text !== tb.transcript?.text, '两条返回内容一样，可能是缓存串了');
    console.log(`  甲：${String(ta.transcript?.text || '').slice(0, 50)}…`);
    console.log(`  乙：${String(tb.transcript?.text || '').slice(0, 50)}…`);

    const st = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/stats`)).json();
    check('★ 并发峰值仍为 2（全程真并发）', st.peakConcurrent >= 2, `峰值=${st.peakConcurrent}`);

    /* ---- 6. 收尾状态 ---- */
    console.log('\n=== 6. 全部结束后界面恢复 ===');
    await openTo(idB);
    const end = await snap();
    check('按钮恢复「开始转写」', end.btn.includes('开始转写'), end.btn);
    check('按钮可点', end.btnDisabled === false);
    check('提示清空', end.hint === '', end.hint);
    check('侧栏小字消失', end.listJobs === 0, `小字=${end.listJobs}`);
  } finally {
    for (const id of [idA, idB]) {
      if (!id) continue;
      try {
        await fetch(API + '/api/lectures/' + id, { method: 'DELETE' });
      } catch {}
    }
    // 一定要把配置还原，否则用户下次转写会打到不存在的假服务上。
    // clearApiKey 是必须的：测试开头把 apiKey 设成了 mock-key-for-test，
    // 而 PUT 里 apiKey 留空表示「不修改」，不显式清除的话这个假 Key 会留在配置里。
    try {
      await apiJson('/config', { method: 'PUT', body: { asr: { ...backup, clearApiKey: true }, llm: { enabled: true } } });
      const back = (await apiJson('/config')).config.asr;
      console.log(`\n↩️  配置已还原：provider=${back.provider} endpoint=${back.endpoint || '(空)'}`);
    } catch (e) {
      console.error('\n⚠️  配置还原失败，请手动检查 data/config.json：' + e.message);
    }
    // 字段级还原之外再整份还原一次：万一上面那步漏了 keyVault 之类
    // 这次测试碰过的字段，兜底把整个文件写回测试前的样子。
    await restoreConfig().catch(() => {});
    console.log('🧹 测试录音已删除');
  }

  console.log('\n' + '='.repeat(70));
  if (fail === 0) console.log(`✅ 全部通过（${pass} 项）`);
  else console.log(`❌ ${pass} 通过 / ${fail} 失败`);
  console.log('='.repeat(70));
  cdp.close();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\n💥 测试脚本出错：', e.message);
  process.exit(1);
});
