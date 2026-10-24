/**
 * 把调试用的 Edge 页面重新加载一次，并确认页面真的初始化好了。
 *
 * 什么时候需要它：改了 `public/` 下的前端代码之后。静态文件是 `Cache-Control: no-store`，
 * 所以刷新一下就生效，不用清缓存、不用重启服务。但**跑基准/探针之前一定要刷**：
 * 页面里跑的还是旧代码，量出来的数字就是旧的（踩过这个坑）。
 *
 * 需要先用 `启动（可调试）.vbs` 起窗口（它带 `--remote-debugging-port=9222`）。
 *
 * 用法：
 *   node tests/reload-page.mjs
 *   node tests/reload-page.mjs --cdp 9222 --app http://127.0.0.1:8788/
 */
const args = process.argv.slice(2);
const argOf = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const CDP = Number(argOf('--cdp', '9222'));
const APP = argOf('--app', 'http://127.0.0.1:8788/').replace(/\/$/, '');

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onopen = () =>
      resolve({
        send(m, p = {}) {
          const i = ++id;
          ws.send(JSON.stringify({ id: i, method: m, params: p }));
          return new Promise((res, rej) => pending.set(i, { res, rej }));
        },
        close: () => ws.close(),
      });
    ws.onerror = () => reject(new Error('CDP 连不上（窗口是不是没用「启动（可调试）.vbs」起？）'));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    };
  });
}

const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.url.startsWith(APP));
if (!page) {
  console.error(`CDP 里没找到 ${APP} 的页面。现有目标：`);
  for (const t of list) console.error(`  [${t.type}] ${t.url}`);
  process.exitCode = 1;
} else {
  const c = await connect(page.webSocketDebuggerUrl);
  await c.send('Page.enable');
  await c.send('Page.reload', { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 4000));
  const r = await c.send('Runtime.evaluate', {
    expression: `!!(window.__LN__ && window.__LN__.state && window.__LN__.state.config)`,
    returnByValue: true,
  });
  console.log(`刷新完成，页面初始化好了 = ${r.result.value}`);
  if (!r.result.value) process.exitCode = 1;
  c.close();
}
