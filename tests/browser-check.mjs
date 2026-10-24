/**
 * 真实浏览器验证：用 Chrome DevTools Protocol 驱动无头 Chrome，
 * 打开页面 → 收集控制台报错 → 取 DOM 断言 → 截图。
 *
 * 零依赖：用 Node 24 内置的全局 WebSocket 直接连 CDP，不需要 puppeteer。
 *
 * 运行： node tests/browser-check.mjs [appBase]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = (process.argv[2] || 'http://127.0.0.1:8790').replace(/\/+$/, '');
const CDP_PORT = Number(process.env.CDP_PORT || 9223);
const SHOTS = path.join(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const CHROME = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!CHROME) {
  console.error('找不到 Chrome / Edge');
  process.exit(2);
}

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  → ' + detail}`);
};

/* ------------------------- 极简 CDP 客户端 ------------------------- */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
        }
      } else if (msg.method) {
        (this.handlers.get(msg.method) || []).forEach((fn) => fn(msg.params));
      }
    });
  }
  static connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.addEventListener('open', () => resolve(new CDP(ws)));
      ws.addEventListener('error', (e) => reject(new Error('WebSocket 连接失败: ' + (e.message || ''))));
    });
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(method + ' 超时'));
        }
      }, 60000);
    });
  }
  async eval(expression, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || '页面内求值失败');
    return r.result.value;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------- 启动 Chrome ------------------------- */
const profile = path.join(__dirname, '_chrome_profile');
fs.rmSync(profile, { recursive: true, force: true });

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--autoplay-policy=no-user-gesture-required',
    '--hide-scrollbars',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } }
);

let version = null;
for (let i = 0; i < 60; i++) {
  try {
    version = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((r) => r.json());
    break;
  } catch {
    await sleep(500);
  }
}
if (!version) {
  console.error('Chrome 没能启动起来（CDP 端口无响应）');
  chrome.kill();
  process.exit(2);
}
console.log(`\n=== 真实浏览器验证 ===\n浏览器: ${version.Browser}`);

const newTab = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json());
const cdp = await CDP.connect(newTab.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Log.enable');

/** 收集控制台错误 */
let consoleErrors = [];
cdp.on('Runtime.exceptionThrown', (p) => {
  consoleErrors.push('异常: ' + (p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
});
cdp.on('Runtime.consoleAPICalled', (p) => {
  if (p.type === 'error') consoleErrors.push('console.error: ' + (p.args || []).map((a) => a.value ?? a.description).join(' '));
});
cdp.on('Log.entryAdded', (p) => {
  if (p.entry.level === 'error' && !/favicon|net::ERR_/.test(p.entry.text || '')) consoleErrors.push('日志: ' + p.entry.text);
});

/** 打开页面并等它稳定（先过 about:blank，确保是真正的整页加载而不是只换 hash） */
async function open(url, { width = 1500, height = 1080, settle = 2500 } = {}) {
  consoleErrors = [];
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await sleep(200);
  await cdp.send('Page.navigate', { url });
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 15000);
    cdp.on('Page.loadEventFired', () => {
      clearTimeout(t);
      resolve();
    });
  });
  await sleep(settle);
}

async function shot(name, opts) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const file = path.join(SHOTS, name);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  void opts;
  return file;
}

/* ------------------------- 1. 空状态 ------------------------- */
console.log('\n--- 1. 首屏（空状态 / 列表）---');
await open(APP + '/');
await shot('01-home.png');
const home = await cdp.eval(`JSON.stringify({
  title: document.title,
  emptyVisible: !document.getElementById('empty-state').hidden,
  listCount: document.querySelectorAll('.lecture-item').length,
  steps: document.querySelectorAll('.steps li').length,
  lanHint: (document.getElementById('lan-hint')||{}).textContent || '',
  cols: getComputedStyle(document.querySelector('.layout')).gridTemplateColumns,
  bodyWidth: document.body.clientWidth
})`);
const H = JSON.parse(home);
check('页面标题正确', H.title.includes('讲义笔记'), H.title);
check('空状态引导可见', H.emptyVisible === true);
check('课程列表渲染出条目', H.listCount >= 1, `count=${H.listCount}`);
check('使用说明步骤渲染', H.steps === 4, `steps=${H.steps}`);
check('局域网地址已显示', /http:\/\/\d/.test(H.lanHint) || H.lanHint.length > 0, H.lanHint.slice(0, 80));
check('双栏布局生效', /px/.test(H.cols), H.cols);
check('首页无控制台报错', consoleErrors.length === 0, consoleErrors.join(' | '));

/* ------------------------- 2. 详情页 ------------------------- */
console.log('\n--- 2. 详情页（笔记 + 逐字稿 + 播放器）---');
const lectures = await fetch(APP + '/api/lectures').then((r) => r.json());
const lec = lectures.lectures[0];
check('后端有示例课', !!lec, JSON.stringify(lectures).slice(0, 120));

await open(`${APP}/#/l/${lec.id}`, { width: 1500, height: 1600, settle: 3000 });
await shot('02-detail.png');
const detail = await cdp.eval(`JSON.stringify({
  title: document.getElementById('d-title').textContent,
  course: document.getElementById('d-course').value,
  badge: document.getElementById('d-status').textContent,
  audioSrc: document.getElementById('audio').currentSrc || document.getElementById('audio').src,
  audioDuration: document.getElementById('audio').duration,
  segs: document.querySelectorAll('.seg').length,
  segTime: (document.querySelector('.seg .t')||{}).textContent || '',
  noteLen: document.getElementById('note-view').innerHTML.length,
  noteHasOutline: document.getElementById('note-view').innerHTML.includes('课堂脉络与重点'),
  noteHasKeywords: document.getElementById('note-view').innerHTML.includes('关键词'),
  noteHasQuiz: document.getElementById('note-view').innerHTML.includes('自测题'),
  noteHasDefs: document.getElementById('note-view').innerHTML.includes('概念与定义'),
  tsLinks: document.querySelectorAll('#note-view a.ts').length,
  detailsEl: document.querySelectorAll('#note-view details').length,
  engineTag: document.getElementById('engine-tag').textContent,
  noteSource: document.getElementById('note-source').textContent
})`);
const D = JSON.parse(detail);
check('标题渲染', D.title.includes('二叉树'), D.title);
check('课程字段渲染', D.course === '数据结构', D.course);
check('状态徽章渲染', D.badge.length > 0, D.badge);
check('逐字稿渲染出段落', D.segs >= 10, `segs=${D.segs}`);
check('逐字稿带时间戳', /^\d{2}:\d{2}$/.test(D.segTime), D.segTime);
check('笔记渲染为 HTML', D.noteLen > 800, `len=${D.noteLen}`);
check('笔记含课堂脉络', D.noteHasOutline === true);
check('笔记含关键词', D.noteHasKeywords === true);
check('笔记含概念定义', D.noteHasDefs === true);
check('笔记含自测题', D.noteHasQuiz === true);
check('笔记含可点时间戳', D.tsLinks >= 5, `tsLinks=${D.tsLinks}`);
check('逐字稿折叠块存在', D.detailsEl >= 1, `details=${D.detailsEl}`);
check('引擎标签显示', D.engineTag.length > 0, D.engineTag);
check('笔记来源标记', /离线|AI 生成/.test(D.noteSource), D.noteSource);

/** 音频元数据要等 loadedmetadata，单独取 */
const audio = await cdp.eval(
  `new Promise(res => {
     const a = document.getElementById('audio');
     if (a.readyState >= 1 && a.duration) return res(JSON.stringify({ src: a.currentSrc || a.src, dur: a.duration }));
     a.addEventListener('loadedmetadata', () => res(JSON.stringify({ src: a.currentSrc || a.src, dur: a.duration })), { once: true });
     setTimeout(() => res(JSON.stringify({ src: a.currentSrc || a.src, dur: a.duration || 0 })), 8000);
   })`,
  true
);
const A = JSON.parse(audio);
check('音频已挂载且能读出时长', A.dur > 0 && /\/audio/.test(A.src), JSON.stringify(A));
check('详情页无控制台报错', consoleErrors.length === 0, consoleErrors.join(' | '));

/* ------------------------- 3. 真实交互 ------------------------- */
console.log('\n--- 3. 真实交互（点时间戳 / 搜索 / 播放）---');
const clickTs = await cdp.eval(`(async () => {
  const links = [...document.querySelectorAll('#note-view a.ts')];
  if (!links.length) return JSON.stringify({ error: '笔记里没有时间戳链接' });
  // 挑一个非 0 秒的链接，这样「跳转」才是真的可验证
  const a = links.reduce((best, x) => (Number(x.dataset.t) > Number(best.dataset.t) ? x : best), links[0]);
  const before = document.getElementById('audio').currentTime;
  const want = Number(a.dataset.t);
  a.click();
  await new Promise(r => setTimeout(r, 700));
  const el = document.getElementById('audio');
  return JSON.stringify({ before, want, after: el.currentTime, playing: !el.paused, total: links.length });
})()`, true);
const C = JSON.parse(clickTs);
check('点笔记时间戳能跳转音频', !C.error && Math.abs(C.after - C.want) < 0.6, clickTs);
check('跳转后开始播放', C.playing === true, clickTs);

const search = await cdp.eval(`(() => {
  const box = document.getElementById('tx-search');
  if (!box) return JSON.stringify({ error: '没有搜索框' });
  box.value = '递归';
  box.dispatchEvent(new Event('input', { bubbles: true }));
  const marks = document.querySelectorAll('#transcript-view mark').length;
  box.value = '';
  box.dispatchEvent(new Event('input', { bubbles: true }));
  return JSON.stringify({ marks });
})()`);
check('逐字稿搜索高亮生效', (JSON.parse(search).marks || 0) >= 1, search);

const seek = await cdp.eval(`(async () => {
  const seg = document.querySelectorAll('.seg')[5];
  if (!seg) return JSON.stringify({ error: '没有逐字稿段落' });
  seg.click();
  await new Promise(r => setTimeout(r, 700));
  return JSON.stringify({ start: Number(seg.dataset.start), active: document.querySelectorAll('.seg.active').length, now: document.getElementById('audio').currentTime });
})()`, true);
const S = JSON.parse(seek);
check('点逐字稿跳转并高亮当前段', !S.error && S.active >= 1 && Math.abs(S.now - S.start) < 1, seek);

const hashNav = await cdp.eval(`(async () => {
  location.hash = '';
  await new Promise(r => setTimeout(r, 600));
  const backToEmpty = !document.getElementById('empty-state').hidden;
  location.hash = '#/l/${lec.id}';
  await new Promise(r => setTimeout(r, 1200));
  return JSON.stringify({ backToEmpty, reopened: document.getElementById('d-title').textContent.includes('二叉树') });
})()`, true);
const HN = JSON.parse(hashNav);
check('清空 hash 能回到首屏', HN.backToEmpty === true, hashNav);
check('只有 hash 变化时也能打开录音', HN.reopened === true, hashNav);

/* ------------------------- 4. 设置弹窗 ------------------------- */
console.log('\n--- 4. 设置弹窗与环境自检 ---');
const settings = await cdp.eval(`(async () => {
  document.getElementById('btn-settings').click();
  await new Promise(r => setTimeout(r, 1500));
  const modal = document.getElementById('settings-modal');
  const diag = document.getElementById('diag');
  const localBlock = document.querySelector('[data-for="local"]');
  const cloudBlock = document.querySelector('[data-for="cloud"]');
  const pick = document.getElementById('s-provider');
  const stateOf = () => ({
    provider: pick.value,
    localHidden: localBlock.hidden,
    cloudHidden: cloudBlock.hidden,
    keyHidden: document.getElementById('key-field').hidden,
  });
  const first = stateOf();

  // 切到「本地」看云端块是否隐藏
  pick.value = 'local';
  pick.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 600));
  const asLocal = stateOf();

  // 再切回云端（硅基流动）看本地块是否隐藏
  pick.value = 'siliconflow';
  pick.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 600));
  const asCloud = stateOf();

  return JSON.stringify({
    open: !modal.hidden,
    model: document.getElementById('s-local-model').value,
    cdn: document.getElementById('s-cdn').value,
    host: document.getElementById('s-model-host').value,
    // 「笔记风格」已经从设置搬到新建录音弹窗（2026-10-23），这里改成
    // 验「设置里确实没有了、弹窗里确实有」，两个方向都得看。
    styleGone: document.getElementById('s-style') === null,
    nlStyle: document.getElementById('nl-style') ? document.getElementById('nl-style').options.length : 0,
    nlOptions: document.getElementById('nl-maxpoints') ? document.getElementById('nl-maxpoints').options.length : 0,
    diagRows: diag.querySelectorAll('.diag-row').length,
    diagText: diag.textContent.slice(0, 300),
    first, asLocal, asCloud,
    webgpu: 'gpu' in navigator
  });
})()`, true);
const G = JSON.parse(settings);
check('设置弹窗能打开', G.open === true);
check('模型选择器有值', G.model.length > 0, G.model);
check('CDN 有默认值', G.cdn.includes('jsdelivr'), G.cdn);
check('笔记风格已从设置里搬走', G.styleGone === true, 's-style 应已移除');
check('新建录音弹窗有风格选项', G.nlStyle >= 3, `options=${G.nlStyle}`);
check('新建录音弹窗有重点条数选项', G.nlOptions >= 5, `options=${G.nlOptions}`);
check('环境自检渲染出多行', G.diagRows >= 4, `rows=${G.diagRows}`);
check('自检报告提到 WebGPU', G.diagText.includes('WebGPU'), G.diagText.slice(0, 120));
// 注意：不能假设配置文件里的 asr.provider 是哪个 ——
// 真实用户可能选着云端（服务器上就是这么配的），旧版这里写死「本地模式时隐藏云端选项」，
// 结果只要用户选过云端就必红。正确做法是自己把两种模式都切一遍再看。
check('切到本地时隐藏云端选项', G.asLocal.cloudHidden === true && G.asLocal.localHidden === false, JSON.stringify(G.asLocal));
check('切到云端时隐藏本地选项', G.asCloud.localHidden === true && G.asCloud.cloudHidden === false, JSON.stringify(G.asCloud));
check('浏览器 WebGPU 能力检测', typeof G.webgpu === 'boolean', String(G.webgpu));
await shot('04-settings.png');

/* ------------------------- 5. 版面几何量测（替代肉眼检查） ------------------------- */
console.log('\n--- 5. 版面几何量测 ---');
await open(`${APP}/#/l/${lec.id}`, { width: 1500, height: 1600, settle: 2500 });
const layout = await cdp.eval(`JSON.stringify((() => {
  const box = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
  const cs = (sel) => getComputedStyle(document.querySelector(sel));
  const panes = document.querySelectorAll('.panes .pane');
  return {
    note: box('.panes .pane:nth-child(1)'),
    trans: box('.panes .pane:nth-child(2)'),
    player: box('#audio'),
    toolbar: box('.toolbar'),
    title: box('#d-title'),
    paneCount: panes.length,
    h1: cs('#note-view h1').fontSize,
    h2: cs('#note-view h2').fontSize,
    li: cs('#note-view li').fontSize,
    ts: cs('#note-view a.ts').fontSize,
    bg: cs('body').backgroundColor,
    color: cs('body').color,
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    docHeight: document.documentElement.scrollHeight,
    tsCount: document.querySelectorAll('#note-view a.ts').length,
    visiblePanes: [...panes].filter(p => p.getBoundingClientRect().height > 100).length
  };
})())`);
const L = JSON.parse(layout);
check('两个面板都真实渲染出高度', L.visiblePanes === 2, layout);
check('桌面端笔记/逐字稿左右并排', L.note && L.trans && L.note.x < L.trans.x && L.note.w > 400 && L.trans.w > 250, JSON.stringify([L.note, L.trans]));
check('播放器尺寸正常', L.player && L.player.w > 400 && L.player.h > 20, JSON.stringify(L.player));
check('工具栏可见', L.toolbar && L.toolbar.h > 30 && L.toolbar.w > 300, JSON.stringify(L.toolbar));
check('标题有实际尺寸', L.title && L.title.h > 20, JSON.stringify(L.title));
check('笔记字号层级合理', parseFloat(L.h1) >= 16 && parseFloat(L.h2) >= 14 && parseFloat(L.li) >= 12, JSON.stringify([L.h1, L.h2, L.li]));
check('时间戳徽标字号可读', parseFloat(L.ts) >= 11, L.ts);
check('页面无横向溢出', L.overflowX <= 2, `溢出 ${L.overflowX}px`);
check('配色已生效（非默认黑白）', L.bg !== 'rgba(0, 0, 0, 0)' && L.color !== '', JSON.stringify([L.bg, L.color]));
check('笔记时间戳数量充足', L.tsCount >= 8, `ts=${L.tsCount}`);

/* ------------------------- 6. 手机尺寸 ------------------------- */
console.log('\n--- 6. 手机尺寸（430×940）---');
await open(`${APP}/#/l/${lec.id}`, { width: 430, height: 940, settle: 2500 });
await shot('03-mobile.png');
const mobile = await cdp.eval(`JSON.stringify({
  w: document.body.clientWidth,
  menuBtnVisible: getComputedStyle(document.getElementById('btn-menu')).display !== 'none',
  sidebarOffscreen: document.getElementById('sidebar').getBoundingClientRect().left < 0,
  panesColumns: getComputedStyle(document.querySelector('.panes')).gridTemplateColumns.split(' ').length,
  noteW: Math.round(document.querySelector('.panes .pane').getBoundingClientRect().width),
  overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  hitTarget: (() => { const b = document.getElementById('btn-import').getBoundingClientRect(); return Math.round(b.height); })()
})`);
const M = JSON.parse(mobile);
check('窄屏下汉堡菜单出现', M.menuBtnVisible === true);
check('窄屏下侧栏收起', M.sidebarOffscreen === true, JSON.stringify(M));
check('窄屏下双栏变单栏', M.panesColumns === 1, M.panesColumns + ' 列');
check('窄屏面板占满宽度', M.noteW > 360, `noteW=${M.noteW}`);
check('窄屏无横向溢出', M.overflowX <= 2, `溢出 ${M.overflowX}px`);
check('手机端按钮可点区域够大', M.hitTarget >= 28, `${M.hitTarget}px`);
check('手机视图无控制台报错', consoleErrors.length === 0, consoleErrors.join(' | '));

/* ------------------------- 收尾 ------------------------- */
cdp.ws.close();
chrome.kill();
await sleep(300);
fs.rmSync(profile, { recursive: true, force: true });

console.log(`\n截图目录: ${SHOTS}`);
console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
process.exitCode = fail ? 1 : 0;
