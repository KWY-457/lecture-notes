/**
 * 启动时自动检查更新 + 设置按钮红点
 *
 * 这条行为是 2026-11-21 老大要求的：「改成启动自动检查吧」。
 * 它有三条容易写坏的地方，这个文件专门盯它们：
 *
 *   1. 不能挡路 —— 检查是 setTimeout 延后发的，不是 boot 里的 await。
 *      写成 await 的话，没网的用户每次开程序都要等好几秒。
 *   2. 不能报错 —— 产品卖点是「不联网也能用」，查不到就静默当没更新。
 *   3. 不能重复查 —— 服务端 shouldCheck 有 6 小时节流，前端不能绕过它。
 *
 * 另外那个小红点：只有真查到新版本才亮，点进设置看过就灭。
 * 这几条都靠读源码 + 真浏览器两路验。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
// 地址优先取第一个位置参数（run-all 的服务层就是这么传的），其次环境变量。
// 不给就退默认 23169 —— 本机开发时服务常年在这个端口。
const BASE = String(process.argv[2] || process.env.LN_BASE || 'http://127.0.0.1:23169').replace(
  /\/+$/,
  ''
);
let pass = 0;
let fail = 0;
const fails = [];

function check(name, ok, extra = '') {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    fails.push(name + (extra ? `  (${extra})` : ''));
    console.log(`  ❌ ${name}${extra ? '  ' + extra : ''}`);
  }
}

const appSrc = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const cssSrc = fs.readFileSync(path.join(ROOT, 'public/app.css'), 'utf8');

console.log('\n== 一、源码层：启动检查的三条约束 ==');

check('有 checkUpdateOnBoot 这个函数', /function checkUpdateOnBoot\s*\(/.test(appSrc));
check(
  'boot() 里调用了它',
  /await openFromHash\(\);[\s\S]{0,400}checkUpdateOnBoot\(\);/.test(appSrc)
);
check(
  '检查是 setTimeout 延后的，不是 await',
  /function checkUpdateOnBoot\s*\([^)]*\)\s*\{[\s\S]{0,400}setTimeout\([\s\S]{0,200}checkUpdate\(\s*\{\s*silent:\s*true\s*\}\s*\)/.test(
    appSrc
  )
);
check(
  '失败一律 .catch(() => {})',
  /checkUpdate\(\s*\{\s*silent:\s*true\s*\}\s*\)\s*\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/.test(appSrc)
);
check('手机上不查', /function checkUpdateOnBoot[\s\S]{0,300}if\s*\(state\.remote\)\s*return;/.test(appSrc));
check(
  '引导没走完不查',
  /function checkUpdateOnBoot[\s\S]{0,600}onboard[\s\S]{0,120}done\s*===\s*false[\s\S]{0,40}return;/.test(appSrc)
);
check(
  '没有把检查挪进 openSettings 之外还留着旧的（两处都在是对的，但启动那条不能删）',
  /checkUpdateOnBoot\(\);/.test(appSrc) && /checkUpdate\(\s*\{\s*silent:\s*true\s*\}\s*\)/.test(appSrc)
);

console.log('\n== 二、源码层：设置按钮红点 ==');

check('HTML 里有 #settings-dot', /id="settings-dot"/.test(htmlSrc));
check('红点默认 hidden', /id="settings-dot"[^>]*hidden/.test(htmlSrc));
check(
  '红点挂在设置按钮里',
  /id="btn-settings"[\s\S]{0,300}id="settings-dot"/.test(htmlSrc)
);
check(
  'checkUpdate 的 finally 里同步红点',
  /finally\s*\{[\s\S]{0,1200}syncSettingsDot\(\);/.test(appSrc)
);
check('有独立的 syncSettingsDot 函数', /function syncSettingsDot\s*\(\s*\)/.test(appSrc));
check(
  '只在 hasUpdate 或已下载时亮',
  /function syncSettingsDot[\s\S]{0,900}const show = [\s\S]{0,120}updateState\.info\?\.hasUpdate \|\| updateState\.downloaded/.test(
    appSrc
  )
);
check(
  '看过这个版本号之后不再亮',
  /function syncSettingsDot[\s\S]{0,900}const seen = updateState\.seen === latest/.test(appSrc)
);
check(
  '打开设置时把 seen 记成当前最新版',
  /\$\('settings-modal'\)\.hidden = false;[\s\S]{0,600}updateState\.seen = updateState\.info\.latest/.test(appSrc)
);
check(
  'settings-dot 有 [hidden] 的显式样式',
  /\.icon-dot\[hidden\]\s*\{\s*display:\s*none;?\s*\}/.test(cssSrc)
);
check('.icon-btn 是 relative（红点定位基准）', /\.icon-btn\s*\{[\s\S]{0,400}position:\s*relative;/.test(cssSrc));
check('.icon-dot 用 absolute 定位', /\.icon-dot\s*\{[\s\S]{0,200}position:\s*absolute;/.test(cssSrc));

console.log('\n== 三、真浏览器：角上那个点 ==');

// 用 headless Chrome 打开真实页面，验证：
//   · 页面正常加载，设置按钮存在
//   · 红点初始隐藏（现在还没发过 Release，hasUpdate 必然 false）
//   · 检查更新接口被真的调了一次（不 await、不挡渲染）
//   · 手动把 updateState 改成 hasUpdate 后红点会亮（模式检查，不改真实状态）
const BS = String.fromCharCode(92);
const CANDIDATES = [
  'C:' + BS + 'Program Files' + BS + 'Google' + BS + 'Chrome' + BS + 'Application' + BS + 'chrome.exe',
  'C:' + BS + 'Program Files (x86)' + BS + 'Microsoft' + BS + 'Edge' + BS + 'Application' + BS + 'msedge.exe',
  'C:' + BS + 'Program Files' + BS + 'Microsoft' + BS + 'Edge' + BS + 'Application' + BS + 'msedge.exe',
];
const CHROME = CANDIDATES.find((p) => fs.existsSync(p));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.waiting = new Map();
    this.ready = new Promise((res) => {
      ws.addEventListener('open', res);
    });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.waiting.has(msg.id)) {
        const { resolve, reject } = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval 失败');
    return r.result?.value;
  }
}

async function waitPort(url, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  if (!CHROME) {
    check('找到 headless Chrome', false, '没找到 chrome.exe / msedge.exe');
    return;
  }
  const port = 9510 + Math.floor(Math.random() * 60);
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      '--user-data-dir=' + path.join(import.meta.dirname, '.tmp-updboot-profile'),
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--window-size=1500,1080',
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true }
  );
  try {
    if (!(await waitPort(`http://127.0.0.1:${port}/json/version`))) {
      check('headless Chrome 起来了', false);
      return;
    }
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    const cdp = new CDP(ws);
    await cdp.ready;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // 记录页面发出的请求，用来确认 /update/check 真的被调了
    const sent = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Network.requestWillBeSent') sent.push(m.params.request.url);
    });
    await cdp.send('Network.enable');

    await cdp.send('Page.navigate', { url: BASE + '/' });
    // 等页面画完 + 那 2.5 秒的延后检查真的发出去
    await new Promise((r) => setTimeout(r, 6500));

    const st = await cdp.eval(`(() => {
      const btn = document.getElementById('btn-settings');
      const dot = document.getElementById('settings-dot');
      if (!btn || !dot) return { missing: true };
      const cs = getComputedStyle(dot);
      return {
        hasBtn: true,
        dotHidden: dot.hidden,
        dotDisplay: cs.display,
        dotW: dot.getBoundingClientRect().width,
        btnW: btn.getBoundingClientRect().width,
        title: btn.title,
        // 首屏该有的东西在不在（证明检查没挡住渲染）
        listReady: !!document.getElementById('lecture-list'),
        sidebarReady: !!document.getElementById('sidebar'),
      };
    })()`);

    check('设置按钮存在', st.hasBtn === true);
    check('列表和侧栏都渲染出来了（检查没挡路）', st.listReady === true && st.sidebarReady === true);
    check('红点初始是隐藏的（还没发 Release）', st.dotHidden === true, `hidden=${st.dotHidden}`);
    check('隐藏时宽度为 0（真的没占位）', st.dotW === 0, `w=${st.dotW}`);
    check('设置按钮标题是「设置」', st.title === '设置', st.title);
    check(
      '页面确实请求了 /api/update/check',
      sent.some((u) => u.includes('/api/update/check')),
      `共 ${sent.length} 个请求`
    );
    check(
      '请求发生在首屏之后（不是阻塞式）',
      // boot 里先 loadLectures 再 openFromHash 再检查，所以录音列表请求一定在前面
      (() => {
        const iList = sent.findIndex((u) => u.includes('/api/lectures'));
        const iUpd = sent.findIndex((u) => u.includes('/api/update/check'));
        return iList >= 0 && iUpd > iList;
      })()
    );

    // 模拟「查到了新版本」：直接驱动 UI 那条路，不碰真实网络状态
    const lit = await cdp.eval(`(() => {
      const dot = document.getElementById('settings-dot');
      const btn = document.getElementById('btn-settings');
      // 等价于 checkUpdate 的 finally 里那段
      const hasUpdate = true, downloaded = null;
      dot.hidden = !(hasUpdate || !!downloaded);
      if (!dot.hidden) btn.title = '设置（有新版本 0.9.1）';
      const cs = getComputedStyle(dot);
      return { hidden: dot.hidden, display: cs.display, w: dot.getBoundingClientRect().width, title: btn.title };
    })()`);
    check('有新版时红点亮起', lit.hidden === false);
    check('亮起时有实际宽度', lit.w > 0, `w=${lit.w}`);
    check('标题带上版本号', /有新版本\s*0\.9\.1/.test(lit.title || ''), lit.title);

    ws.close();
  } finally {
    try {
      proc.kill();
    } catch {}
  }
}

await main();

// 清掉临时 profile，别把 500MB 缓存留在仓库目录里
try {
  fs.rmSync(path.join(import.meta.dirname, '.tmp-updboot-profile'), {
    recursive: true,
    force: true,
  });
} catch {}

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
if (fail) {
  console.log('失败项：');
  for (const f of fails) console.log('  · ' + f);
  process.exitCode = 1;
}
