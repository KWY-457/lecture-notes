/**
 * 用 CDP 连真页面，验证「按录音独立的任务表」是否真的把两条录音分开了。
 *
 * 要验证的正是老大提的那个场景：
 *   在「测试」里转写，切到「思想道德法治」，进度栏**不应该**还挂着测试的进度。
 *
 * 做法：直接操作 window.__LN__.jobs 造出假的转写任务，然后切录音看进度栏跟不跟着换。
 * 不真的跑转写（那要好几分钟，还得联网），只验证「状态归属」这套逻辑。
 *
 * 用法：
 *   node tests/cdp-jobs.mjs                 # 连 127.0.0.1:9222
 *   node tests/cdp-jobs.mjs --cdp 9222 --app http://127.0.0.1:8788/
 */
import path from 'node:path';

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const CDP_PORT = Number(argOf('--cdp', '9222'));
const APP_URL = argOf('--app', 'http://127.0.0.1:8788/');

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

function connect(wsUrl, onEvent) {
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
    ws.onerror = () => reject(new Error('WebSocket 连不上：Edge 是不是没带 --remote-debugging-port 起来？'));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
        return;
      }
      if (msg.method && onEvent) onEvent(msg);
    };
  });
}

/** 把一段要跑在页面里的代码包成 IIFE，避免顶层 const 在全局重复声明 */
const J = (body) => `(() => { ${body} })()`;
/** 需要等异步的版本 */
const JA = (body) => `(async () => { ${body} })()`;

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const want = APP_URL.replace(/\/$/, '');
  const page =
    list.find((t) => t.type === 'page' && t.url.startsWith(want)) ||
    list.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
  if (!page) throw new Error('CDP 里没有可用页面，Edge 是不是没带 --remote-debugging-port 起来？');
  console.log(`\n连上页面：${page.url}`);

  const pageErrors = [];
  const c = await connect(page.webSocketDebuggerUrl, (msg) => {
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params?.exceptionDetails;
      pageErrors.push(d?.exception?.description || d?.text || '未捕获异常');
    }
  });
  await c.send('Runtime.enable');
  await c.send('Page.enable');

  // 必须绕缓存重载：Edge 会把 app.js 缓存住，不重载验的就是上一版代码
  await c.send('Page.reload', { ignoreCache: true });
  await sleep(1200);

  const evalIn = async (expr, timeoutMs = 15000) => {
    const p = c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    let timer;
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(`页面 ${timeoutMs / 1000} 秒没回来`)), timeoutMs);
    });
    const r = await Promise.race([p, timeout]).finally(() => clearTimeout(timer));
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || '页面里报错了');
    }
    return r.result.value;
  };

  // 等页面把 __LN__ 挂出来
  let ok = false;
  for (let i = 0; i < 60; i++) {
    ok = await evalIn('!!(window.__LN__ && window.__LN__.jobs && window.__LN__.state && window.__LN__.state.config)').catch(
      () => false
    );
    if (ok) break;
    await sleep(250);
  }
  if (!ok) throw new Error('页面 15 秒内没就绪：window.__LN__.jobs 不存在');

  const ids = await evalIn(J('return window.__LN__.state.lectures.map(l => l.id);'));
  if (ids.length < 2) throw new Error(`至少要两条录音才能测，现在只有 ${ids.length} 条`);
  const [idA, idB] = ids;
  console.log(`录音 A = ${idA}\n录音 B = ${idB}\n`);

  /** 用 URL hash 切录音（和用户点侧栏走的是同一条路） */
  const goto = async (id, waitMs = 900) => {
    await evalIn(J(`window.location.hash = '#/l/' + ${JSON.stringify(id)}; return 1;`));
    await sleep(waitMs);
  };

  /** 造一个假任务塞进任务表（注意：返回的是待求值的表达式串，要用 evalIn 跑） */
  const fakeJob = (id, over) =>
    evalIn(
      J(`
      const st = window.__LN__;
      st.jobs.set(${JSON.stringify(id)}, Object.assign({
        id: ${JSON.stringify(id)}, kind: 'transcribe', cloud: true,
        title: '占位', label: '占位', pct: 0, stage: 'cloud',
        detail: '', crawl: 0, cancelled: false,
        abort: new AbortController(), tick: null, stoppedLLM: false,
      }, ${JSON.stringify(over || {})}));
      st.renderJobProgress(); st.renderList(); st.syncToolbar();
      return st.jobs.size;
    `)
    );

  const readBar = () =>
    evalIn(
      J(`
        const g = (i) => document.getElementById(i);
        return {
          hidden: g('progress-wrap').hidden,
          label: g('progress-label').textContent,
          pct: g('progress-pct').textContent,
          stage: g('progress-stage').textContent,
          detail: g('progress-detail').textContent,
          current: window.__LN__.state.current?.lecture?.id || null,
        };
      `)
    );

  const readToolbar = () =>
    evalIn(
      J(`
        const g = (i) => document.getElementById(i);
        const tb = g('btn-transcribe');
        const h = g('transcribe-hint');
        return {
          disabled: tb.disabled, text: tb.textContent.trim(), title: tb.title,
          hint: h ? h.textContent : '(无 hint 元素)',
          hintClass: h ? h.className : '',
          liJobs: document.querySelectorAll('.li-job').length,
          busy: window.__LN__.state.busy,
          jobs: window.__LN__.jobs.size,
        };
      `)
    );

  // ---------- 起点：清干净 ----------
  await evalIn(J(`const st = window.__LN__; for (const k of [...st.jobs.keys()]) st.jobs.delete(k); st.renderJobProgress(); st.renderList(); st.syncToolbar(); return 1;`));
  await goto(idA);

  console.log('=== 1. 打开 A，A 有转写任务 → 进度栏显示 A 的 ===');
  await fakeJob(idA, { title: 'A 录音', label: 'A 的云端转写中', pct: 42, detail: 'A 的细说明' });
  const b1 = await readBar();
  check('进度栏显示出来', b1.hidden === false, JSON.stringify(b1));
  check('标签是 A 的', b1.label.includes('A 的云端转写中'), b1.label);
  check('百分比是 A 的 42%', b1.pct === '42%', b1.pct);
  check('细说明是 A 的', b1.detail.includes('A 的细说明'), b1.detail);

  console.log('\n=== 2. 切到 B（没任务）→ 进度栏必须是空的 ===');
  await goto(idB);
  const b2 = await readBar();
  check('确实切到了 B', b2.current === idB, String(b2.current));
  check('B 上没有 A 的残留进度栏', b2.hidden === true, JSON.stringify(b2));

  console.log('\n=== 3. A 在后台继续 → 任务档案还在，没被切走时误删 ===');
  const j3 = await evalIn(J(`const j = window.__LN__.jobs.get(${JSON.stringify(idA)}); return j ? { kind: j.kind, label: j.label, pct: j.pct } : null;`));
  check('切走后 A 的任务还在', !!j3, JSON.stringify(j3));
  check('A 的任务仍是 transcribe', j3?.kind === 'transcribe', String(j3?.kind));
  check('A 的进度没丢（还是 42）', j3?.pct === 42, String(j3?.pct));

  console.log('\n=== 4. 切回 A → 进度栏立刻复原 ===');
  await goto(idA);
  const b4 = await readBar();
  check('切回了 A', b4.current === idA, String(b4.current));
  check('进度栏重新显示', b4.hidden === false, JSON.stringify(b4));
  check('进度没被清零（还是 42%）', b4.pct === '42%', b4.pct);
  check('标签还是 A 的', b4.label.includes('A 的云端转写中'), b4.label);

  console.log('\n=== 5. 两条同时云端转写 → 各自独立，互不串台 ===');
  await fakeJob(idB, { title: 'B 录音', label: 'B 的云端转写中', pct: 77 });
  const b5 = await readBar();
  const t5 = await readToolbar();
  check('任务表里有两条', t5.jobs === 2, String(t5.jobs));
  check('当前打开 A → 进度栏显示 A 的 42%（不是 B 的 77%）', b5.pct === '42%', b5.pct);
  check('标签仍是 A 的', b5.label.includes('A 的云端转写中'), b5.label);
  check('侧栏两条都有「转写中」小字', t5.liJobs === 2, String(t5.liJobs));
  check('云端并发：A 自己在转 → 按钮灰', t5.disabled === true, JSON.stringify(t5));
  check('按钮文案说明在转', t5.text.includes('转写中'), t5.text);

  console.log('\n=== 6. 切到 B（也在云端转）→ 显示 B 自己的进度 ===');
  await goto(idB);
  const b6 = await readBar();
  check('现在打开的是 B', b6.current === idB, String(b6.current));
  check('进度栏显示 B 的 77%', b6.pct === '77%', b6.pct);
  check('标签是 B 的', b6.label.includes('B 的云端转写中'), b6.label);

  console.log('\n=== 7. 本地转写独占 → 别的录音按钮置灰并说明被谁占着 ===');
  // 先把 B 自己的任务拿掉，才能测「B 没在跑、但被 A 的本地转写锁住」这个场景
  await evalIn(J(`const st = window.__LN__; st.jobs.delete(${JSON.stringify(idB)}); st.renderList(); return 1;`));
  await evalIn(J(`const st = window.__LN__; const a = st.jobs.get(${JSON.stringify(idA)}); a.cloud = false; st.renderJobProgress(); st.renderList(); st.syncToolbar(); return 1;`));
  const t7 = await readToolbar();
  check('B 的转写按钮被置灰（本地独占）', t7.disabled === true, JSON.stringify(t7));
  check('按钮 title 说明被 A 占着', t7.title.includes('A 录音') || t7.title.includes('本地转写'), t7.title);
  check('旁边提示文字说明被占用', t7.hint.includes('A 录音') || t7.hint.includes('本地转写'), t7.hint);
  check('提示用了警示色', t7.hintClass.includes('warn'), t7.hintClass);
  check('B 上没有 A 的进度栏（进度不串台）', (await readBar()).hidden === true, 'B 没任务');

  console.log('\n=== 7b. B 自己在云端转时，提示语应该说的是「这条在转」而不是「被 A 占用」===');
  await fakeJob(idB, { title: 'B 录音', label: 'B 的云端转写中', pct: 55 });
  const t7b = await readToolbar();
  check('B 自己在转 → 提示语是「这条正在云端转写」', t7b.hint.includes('这条录音正在云端转写'), t7b.hint);
  check('不会误报成「被 A 占用」', !t7b.hint.includes('A 录音'), t7b.hint);
  check('自己转的时候不加警示色', !t7b.hintClass.includes('warn'), t7b.hintClass);
  await evalIn(J(`const st = window.__LN__; st.jobs.delete(${JSON.stringify(idB)}); st.renderList(); st.syncToolbar(); return 1;`));

  console.log('\n=== 8. 切到一条没任务的录音（若有第三条）→ 按钮被锁 + 无进度栏 ===');
  const idC = ids[2] || null;
  if (idC) {
    await goto(idC);
    const b8 = await readBar();
    const t8 = await readToolbar();
    check('切到 C', b8.current === idC, String(b8.current));
    check('C 上没有进度栏（进度不串台）', b8.hidden === true, JSON.stringify(b8));
    check('C 的转写按钮被 A 的本地转写锁住', t8.disabled === true, JSON.stringify(t8));
    check('C 的提示说明被 A 占用', t8.hint.includes('A 录音') || t8.hint.includes('本地转写'), t8.hint);
  } else {
    console.log('  （只有两条录音，跳过）');
  }

  console.log('\n=== 9. 全部结束 → 按钮恢复、侧栏小字消失、state.busy 归 false ===');
  await goto(idA);
  await evalIn(J(`const st = window.__LN__; for (const k of [...st.jobs.keys()]) st.jobs.delete(k); st.renderJobProgress(); st.renderList(); st.syncToolbar(); return 1;`));
  const b9 = await readBar();
  const t9 = await readToolbar();
  check('按钮解禁', t9.disabled === false, JSON.stringify(t9));
  check('文案恢复「开始转写」', t9.text.includes('开始转写'), t9.text);
  check('提示文字清空', t9.hint === '', t9.hint);
  check('进度栏收起', b9.hidden === true, String(b9.hidden));
  check('侧栏小字全消失', t9.liJobs === 0, String(t9.liJobs));
  check('state.busy 归 false（兼容旧脚本）', t9.busy === false, String(t9.busy));

  console.log('\n=== 10. 旧接口没被破坏（progress 6 参语义 / __LN__ 形状）===');
  const legacy = await evalIn(
    J(`
      const st = window.__LN__;
      st.progress(true, '第 2/8 段（音频 5:00 起），已完成 5:00，用时 3:12', 37, 'transcribe', '正在转写这一段…', 8);
      const g = (i) => document.getElementById(i);
      const a = {
        width: g('progress-fill').style.width, pct: g('progress-pct').textContent,
        stage: g('progress-stage').textContent, label: g('progress-label').textContent,
        detail: g('progress-detail').textContent,
        busy: g('progress-fill').classList.contains('busy'),
        hidden: g('progress-wrap').hidden,
      };
      st.progress(false);
      const b = { hidden: g('progress-wrap').hidden, busy: g('progress-fill').classList.contains('busy') };
      return {
        a, b,
        hasFns: ['state','progress','checkGpu','runDiagnostics','toast','jobs'].every((k) => k in st),
      };
    `)
  );
  check('progress 数字态：宽度 37%', legacy.a.width === '37%', legacy.a.width);
  check('progress 数字态：百分比 37%', legacy.a.pct === '37%', legacy.a.pct);
  check('progress 数字态：detail 原样', legacy.a.detail === '正在转写这一段…', legacy.a.detail);
  check('progress 数字态：不处于 busy 动画', legacy.a.busy === false, String(legacy.a.busy));
  check('progress(false)：收起', legacy.b.hidden === true, String(legacy.b.hidden));
  check('progress(false)：去掉 busy', legacy.b.busy === false, String(legacy.b.busy));
  check('__LN__ 老键名全在（含新加的 jobs）', legacy.hasFns === true, String(legacy.hasFns));

  console.log('\n=== 11. 页面控制台有没有未捕获异常 ===');
  check('没有未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

  c.close();
  console.log('\n' + '='.repeat(70));
  if (fail) {
    console.log(`❌ ${fail} 项失败 / ${pass} 项通过`);
    process.exit(1);
  }
  console.log(`✅ 全部通过（${pass} 项）`);
  process.exit(0);
}

main().catch((e) => {
  console.error('\n[探针出错]', e.message);
  process.exit(1);
});
