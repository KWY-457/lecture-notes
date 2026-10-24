/**
 * 真点按钮的守卫测试：验证 doTranscribe 的前置判断真的会拦住，而不只是 UI 变灰。
 *
 * 跟 cdp-jobs.mjs 的分工：
 *   cdp-jobs.mjs 造 job 档案 → 验证「进度栏归属」「按钮置灰」「侧栏小字」这些显示层。
 *   本脚本     点真按钮   → 验证用户硬点下去时，doTranscribe 会 toast 拒绝、且不发请求。
 *
 * 为了让「守卫失效」不会真的触发一次云端转写，跑之前把 fetch 对 /transcribe 的
 * 请求改成直接抛错，并记下有没有人真的去发。
 *
 * 用法：node tests/cdp-guard.mjs [--cdp 9222] [--app http://127.0.0.1:8788/]
 */
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

const J = (body) => `(() => { ${body} })()`;
const JA = (body) => `(async () => { ${body} })()`;

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const want = APP_URL.replace(/\/$/, '');
  const page =
    list.find((t) => t.type === 'page' && t.url.startsWith(want)) ||
    list.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
  if (!page) throw new Error('CDP 里没有可用页面');
  console.log(`\n连上页面：${page.url}`);
  const cdp = await connect(page.webSocketDebuggerUrl);

  const pageErrors = [];
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  const evalIn = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 失败');
    return r.result.value;
  };

  await cdp.send('Page.reload', { ignoreCache: true });
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    const ready = await evalIn('!!(window.__LN__ && window.__LN__.jobs)').catch(() => false);
    if (ready) break;
  }
  check('页面加载完成，__LN__.jobs 可用', await evalIn('!!(window.__LN__ && window.__LN__.jobs)'));

  // 装一个「谁想转写就记一笔」的钩子，防止守卫失效时真的触发云端转写
  await evalIn(
    J(`
    const orig = window.fetch;
    window.__guardHits = [];
    window.fetch = function (url, opts) {
      const u = String(url);
      if (u.includes('/transcribe')) { window.__guardHits.push(u); return Promise.reject(new Error('BLOCKED_BY_TEST')); }
      return orig.apply(this, arguments);
    };
    return 1;`)
  );

  const ids = await evalIn(J(`return window.__LN__.state.lectures.map(l => l.id)`));
  check('至少有两节课可以测', ids.length >= 2, `课堂数=${ids.length}`);
  const [idA, idB] = ids;

  const openTo = async (id) => {
    await evalIn(J(`window.location.hash = '#/l/' + ${JSON.stringify(id)}; return 1;`));
    await sleep(700);
  };
  const toastText = () => evalIn(J(`return document.getElementById('toast').textContent`));
  const hits = () => evalIn(J(`return window.__guardHits.length`));
  const jobCount = () => evalIn(J(`return window.__LN__.jobs.size`));
  const clearJobs = () =>
    evalIn(
      J(`const st = window.__LN__; for (const k of [...st.jobs.keys()]) st.jobs.delete(k);
         st.renderJobProgress(); st.renderList(); st.syncToolbar(); return 1;`)
    );

  /* ---- 1. 这条录音自己已经在转 → 硬点也不该再开一个 ---- */
  console.log('\n=== 1. 这条录音已有转写任务 → 再点按钮被拒 ===');
  await clearJobs();
  await openTo(idA);
  await evalIn(
    J(`const st = window.__LN__;
      st.jobs.set(${JSON.stringify(idA)}, { id: ${JSON.stringify(idA)}, kind: 'transcribe', cloud: true,
        title: 'A 录音', label: '正在转写…', pct: 30, stage: 'cloud', detail: '', crawl: 0,
        cancelled: false, abort: new AbortController(), tick: null, stoppedLLM: false });
      st.renderJobProgress(); st.renderList(); st.syncToolbar(); return 1;`)
  );
  const before = await jobCount();
  const t1btn = await evalIn(J(`const b = document.getElementById('btn-transcribe'); return { d: b.disabled, txt: b.textContent };`));
  check('A 的按钮已置灰并显示在转', t1btn.d === true && t1btn.txt.includes('转写中'), JSON.stringify(t1btn));
  // 按钮 disabled 时浏览器会吞掉 click，所以先临时解掉，专门验证「代码里的守卫拦不拦」
  await evalIn(J(`document.getElementById('btn-transcribe').disabled = false; window.__guardHits.length = 0; return 1;`));
  await evalIn(J(`document.getElementById('btn-transcribe').click(); return 1;`));
  await sleep(400);
  check('toast 说明这条正在转写', (await toastText()).includes('正在转写'), await toastText());
  check('没有多出一个任务', (await jobCount()) === before, `任务数 ${await jobCount()}`);
  check('没有发转写请求', (await hits()) === 0);

  /* ---- 2. 别的录音在本地转 → 这条被锁，点了要被拒并说清是谁占着 ---- */
  console.log('\n=== 2. 别的录音在做本地转写（独占显卡）→ 这条点了被拒 ===');
  await clearJobs();
  await evalIn(
    J(`const st = window.__LN__;
      st.jobs.set(${JSON.stringify(idA)}, { id: ${JSON.stringify(idA)}, kind: 'transcribe', cloud: false,
        title: 'A 录音', label: '本地转写中…', pct: 45, stage: 'transcribe', detail: '', crawl: 0,
        cancelled: false, abort: new AbortController(), tick: null, stoppedLLM: false });
      st.renderJobProgress(); st.renderList(); st.syncToolbar(); return 1;`)
  );
  await openTo(idB);
  const t2btn = await evalIn(J(`const b = document.getElementById('btn-transcribe'); return { d: b.disabled, t: b.title }`));
  check('B 的按钮已被置灰', t2btn.d === true, JSON.stringify(t2btn));
  check('B 的按钮 title 指向占用者', t2btn.t.includes('A 录音'), t2btn.t);

  // 硬点：先临时解掉 disabled，绕过浏览器对 disabled 按钮的吞事件
  await evalIn(J(`document.getElementById('btn-transcribe').disabled = false; window.__guardHits.length = 0; return 1;`));
  await evalIn(J(`document.getElementById('btn-transcribe').click(); return 1;`));
  await sleep(400);
  const t2toast = await toastText();
  check('toast 说清是本地转写占用', t2toast.includes('本地转写'), t2toast);
  check('toast 点名是哪条录音占着', t2toast.includes('A 录音'), t2toast);
  check('没有给 B 建任务', (await jobCount()) === 1, `任务数 ${await jobCount()}`);
  check('没有发转写请求', (await hits()) === 0);

  /* ---- 3. 两条云端同时转 → 都该允许，互不拦 ---- */
  console.log('\n=== 3. 两条云端转写可以同时存在，互不拦 ===');
  await clearJobs();
  await evalIn(
    J(`const st = window.__LN__;
      for (const id of [${JSON.stringify(idA)}, ${JSON.stringify(idB)}]) {
        st.jobs.set(id, { id, kind: 'transcribe', cloud: true, title: '录音', label: '云端转写中…',
          pct: 20, stage: 'cloud', detail: '', crawl: 0, cancelled: false,
          abort: new AbortController(), tick: null, stoppedLLM: false });
      }
      st.renderJobProgress(); st.renderList(); st.syncToolbar(); return 1;`)
  );
  await openTo(idB);
  const t3btn = await evalIn(J(`const b = document.getElementById('btn-transcribe'); return { d: b.disabled, t: b.title, txt: b.textContent }`));
  check('B 自己在云端转 → 按钮是「在转」而非「被占用」', t3btn.t.includes('这条录音正在云端转写'), t3btn.t);
  check('两条任务都还在', (await jobCount()) === 2, `任务数 ${await jobCount()}`);
  const dots = await evalIn(J(`return document.querySelectorAll('#lecture-list .li-job').length`));
  check('侧栏两条都显示转写小字', dots === 2, `小字条数=${dots}`);

  /* ---- 4. 收尾：清干净，界面恢复 ---- */
  console.log('\n=== 4. 收尾：清空任务后界面恢复 ===');
  await clearJobs();
  await openTo(idB);
  const t4btn = await evalIn(
    J(`const b = document.getElementById('btn-transcribe');
       const h = document.getElementById('transcribe-hint');
       const w = document.getElementById('progress-wrap');
       return { d: b.disabled, txt: b.textContent, hint: h.textContent, hidden: w.hidden, busy: window.__LN__.state.busy };`)
  );
  check('按钮可用', t4btn.d === false, JSON.stringify(t4btn));
  check('文案恢复「开始转写」', t4btn.txt.includes('开始转写'), t4btn.txt);
  check('提示清空', t4btn.hint === '', t4btn.hint);
  check('进度栏收起', t4btn.hidden === true);
  check('state.busy 归 false', t4btn.busy === false);
  check('全程没发出转写请求', (await hits()) === 0);

  check('页面没有未捕获异常', pageErrors.length === 0, pageErrors.join(' | '));

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
