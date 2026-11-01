/**
 * 前端集成测试：用一个极简 DOM 影子层，把 public/app.js 真的跑起来，
 * 后端连的是真实运行的本地服务。
 *
 * 目的：在没有可用浏览器的环境里，仍然验证
 *   · app.js 能初始化（元素 id、事件绑定、启动流程）
 *   · 列表 / 逐字稿 / 笔记三条渲染链路真的产出内容
 *   · 时间戳点击、搜索、导出等交互逻辑正确
 *
 * 运行： node tests/dom-app-test.mjs [baseUrl]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardConfig } from './config-guard.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

/* 这个脚本会点「清掉已保存的 Key」，那是真的 PUT /api/config。
   不备份就是拿用户自己的 Key 当耗材 —— 跑一次他的 Key 就没了。 */
const restoreConfig = await guardConfig(BASE);

/* ======================= 极简 DOM 影子层 ======================= */

class ClassList {
  constructor(node) { this.node = node; this.set = new Set(); }
  add(...c) { c.forEach((x) => this.set.add(x)); this.sync(); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); this.sync(); }
  toggle(c, on) { const v = on === undefined ? !this.set.has(c) : !!on; v ? this.set.add(c) : this.set.delete(c); this.sync(); return v; }
  contains(c) { return this.set.has(c); }
  sync() { this.node._class = [...this.set].join(' '); }
}

class El {
  constructor(tag = 'div', id = '') {
    this.tagName = String(tag).toUpperCase();
    this.id = id;
    this.children = [];
    this.parent = null;
    this._html = '';
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.dataset = {};
    this.style = {};
    this._class = '';
    this.classList = new ClassList(this);
    this._listeners = {};
    this.currentTime = 0;
    this.paused = true;
    this.scrollTop = 0;
    this.clientHeight = 600;
    this.offsetTop = 0;
  }
  get className() { return this._class; }
  set className(v) { this._class = String(v || ''); this.classList.set = new Set(this._class.split(/\s+/).filter(Boolean)); }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v ?? ''); this.children = []; }
  appendChild(n) { n.parent = this; this.children.push(n); return n; }
  /**
   * 标准 DOM 的 ParentNode.append()。影子层原本只有 appendChild，
   * 而 app.js 造模型卡片时用的是 `btn.append(dot, main)` —— 一次挂多个子节点。
   * 影子层缺这个就等于「真浏览器能跑、测试跑不了」，所以补在这里，
   * 而不是反过来把产品代码改成更啰嗦的写法。
   */
  append(...nodes) {
    for (const n of nodes) {
      if (n == null) continue;
      if (typeof n === 'string') { this.textContent += n; continue; }
      this.appendChild(n);
    }
  }
  removeChild(n) { this.children = this.children.filter((c) => c !== n); return n; }
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  removeEventListener() {}
  dispatch(type, ev = {}) { (this._listeners[type] || []).forEach((fn) => fn({ target: this, preventDefault() {}, ...ev })); }
  /** 支持 .class 与 tag 选择器（递归匹配后代） */
  querySelectorAll(sel) {
    const s = String(sel).trim();
    if (s.startsWith('.')) return this.all().filter((n) => n.classList.contains(s.slice(1)));
    if (/^[a-z]+$/i.test(s)) return this.all().filter((n) => n.tagName === s.toUpperCase());
    if (s.startsWith('[')) return [];
    return [];
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  closest() { return null; }
  setAttribute(k, v) { this[k] = v; }
  removeAttribute(k) { delete this[k]; }
  focus() {}
  blur() { this.dispatch('blur'); }
  scrollIntoView() {}
  getContext() {
    return { clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, set strokeStyle(v) {}, set globalAlpha(v) {} };
  }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  /** 递归收集所有后代，便于断言 */
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
  find(pred) { return this.all().find(pred); }
  filter(pred) { return this.all().filter(pred); }
}

class Doc {
  constructor() {
    this.ids = new Map();
    this.misc = [];
    this._listeners = {};
    this.body = new El('body');
    this.documentElement = new El('html');
  }
  getElementById(id) { return this.ids.get(id) || null; }
  createElement(tag) { return new El(tag); }
  querySelectorAll(sel) { return this._select(sel); }
  querySelector(sel) { return this._select(sel)[0] || null; }
  _select(sel) {
    const s = String(sel).trim();
    const m = /^\[data-([a-z-]+)(?:=["']([^"']*)["'])?\]$/.exec(s);
    if (m) {
      const key = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const want = m[2];
      return [...this.ids.values(), ...this.misc].filter(
        (n) => n.dataset && n.dataset[key] !== undefined && (want === undefined || String(n.dataset[key]) === want)
      );
    }
    if (s.startsWith('.')) return [...this.ids.values(), ...this.misc].filter((n) => n.classList.contains(s.slice(1)));
    return [];
  }
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
}

/** 触发 DOM0 事件处理器，并带上 target */
function fire(node, type) {
  const fn = node['on' + type];
  if (typeof fn === 'function') fn({ target: node, preventDefault() {} });
}

const doc = new Doc();
const errors = [];       // app.js 注册的 error 处理器
const firedErrors = [];  // 真的被触发的错误
let fatal = null;        // 测试过程中抛出的异常

/* 从 index.html 收集所有 id，建出对应节点。
   注意要连标签名一起解析：以前一律建成 div，导致「这是下拉还是输入框」
   这类断言根本没法写（select 和 textarea 都被当成 div，测试红在产品没错上）。
   hidden 属性也一起读，否则「弹窗默认关着」永远是 false。 */
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
for (const m of html.matchAll(/<([a-zA-Z][\w-]*)([^>]*?)\bid="([^"]+)"([^>]*)>/g)) {
  const tag = m[1];
  const attrs = m[2] + ' ' + m[4];
  const node = new El(tag, m[3]);
  if (/contenteditable/.test(attrs)) node.contentEditable = 'true';
  if (/\bhidden\b/.test(attrs)) node.hidden = true;
  const val = /\bvalue="([^"]*)"/.exec(attrs);
  if (val) node.value = val[1];
  /* 元素自己的文字也要抓出来。
     原来只建了空节点 —— 于是任何「按钮上写的是不是这几个字」的断言都读到空串，
     测试红在产品没错上（2026-10-24 改按钮名时踩到了：「重新生成笔记」「AI 润色」
     明明在 index.html 里，断言却一个字符都读不到）。
     取到最近的闭标签为止再剥掉内层标签，对 <button>文字</button> 这种叶子节点刚好。
     注意：自闭合或没有文字的节点剥完就是空串，不会把后面的兄弟节点吃进来。 */
  const rest = html.slice(m.index + m[0].length);
  const inner = rest.match(/^([\s\S]*?)<\//);
  if (inner) node.textContent = inner[1].replace(/<[^>]*>/g, '').trim();
  doc.ids.set(m[3], node);
}
/* 下拉框要真的带 options：app.js 判断「自适应在不在」「三档风格齐不齐」
   都是遍历 option。影子层不给的话，凡是碰下拉内容的断言都会假红。
   这里按 <select id="x">…</select> 把里面的 <option> 抓出来挂上去，
   并把 value 属性同步成真实 DOM 的行为（有 value 用 value，否则用文字）。 */
for (const m of html.matchAll(/<select\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
  const sel = doc.ids.get(m[1]);
  if (!sel) continue;
  for (const o of m[2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)) {
    const ov = /\bvalue="([^"]*)"/.exec(o[1]);
    const label = o[2].replace(/<[^>]+>/g, '').trim();
    const opt = new El('option');
    opt.value = ov ? ov[1] : label;
    opt.textContent = label;
    sel.appendChild(opt);
  }
}
// 动态属性节点（data-jump / data-for）
let jumpIdx = 0;
for (const m of html.matchAll(/data-jump="(-?\d+)"/g)) {
  const n = new El('button', `__jump${jumpIdx++}`);
  n.dataset.jump = m[1];
  doc.ids.set(n.id, n);
}
for (const m of html.matchAll(/<div class="grid2" data-for="([^"]+)">/g)) {
  const n = new El('div');
  n.dataset.for = m[1];
  doc.misc.push(n);
}

/* ======================= 全局环境 ======================= */
const fetchLog = [];
const define = (key, value) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
define('document', doc);
define('location', { hash: '', pathname: '/', port: '8787', href: BASE + '/' });
define('history', { replaceState() {} });
define('navigator', {
  clipboard: { writeText: async () => {} },
  deviceMemory: 16,
  mediaDevices: { getUserMedia: async () => { throw new Error('测试环境无麦克风'); } },
});
globalThis.confirm = () => false;
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.OfflineAudioContext = class { constructor() { this.destination = {}; } createBufferSource() { return { connect() {}, start() {} }; } createGain() { return { connect() {} }; } startRendering() { return Promise.resolve({ getChannelData: () => new Float32Array(10) }); } };
globalThis.AudioContext = class { decodeAudioData() { return Promise.resolve({ duration: 1, numberOfChannels: 1, sampleRate: 16000 }); } close() { return Promise.resolve(); } };
globalThis.MediaRecorder = class { static isTypeSupported() { return true; } };
globalThis.Worker = class { postMessage() {} terminate() {} };
globalThis.URL.createObjectURL = () => 'blob:test';
globalThis.URL.revokeObjectURL = () => {};
globalThis.window = globalThis;
globalThis.window.addEventListener = (type, fn) => {
  if (type === 'error') errors.push(fn);
  if (type === 'unhandledrejection') errors.push(fn);
};
/** 测试里主动把异常喂给 app.js 的全局处理器，确认它不会静默 */
globalThis.__fireError = (msg) => { firedErrors.push(msg); errors.forEach((fn) => fn({ message: msg })); };

const realFetch = globalThis.fetch;
// 浏览器里 fetch('./x.md') 会按当前页面地址解析；Node 里没有「当前页面」，
// 直接抛 `Failed to parse URL from ./x.md`。给一个 location 垫片，
// 并让相对路径按 BASE 解析 —— 否则「相对路径读文件」这种写法在测试里永远是红的，
// 红的还是测试环境而不是产品代码。
globalThis.location = new URL(BASE);
globalThis.document.location = globalThis.location;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  fetchLog.push((opts?.method || 'GET') + ' ' + u);
  if (u.startsWith('/')) return realFetch(BASE + u, opts);
  if (/^https?:/i.test(u) || u.startsWith('data:') || u.startsWith('blob:')) return realFetch(u, opts);
  return realFetch(new URL(u, BASE).toString(), opts);
};
globalThis.window.fetch = globalThis.fetch;

/* ======================= 断言工具 ======================= */
let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail = '') {
  const ok = !!cond;
  ok ? pass++ : fail++;
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${ok ? '' : '  → ' + detail}`);
}
process.on('uncaughtException', (e) => { fatal = e; fail++; console.error('\n  ❌ 未捕获异常：' + (e && e.stack || e)); });
process.on('unhandledRejection', (e) => { fatal = e; fail++; console.error('\n  ❌ 未处理的 Promise 拒绝：' + (e && e.stack || e)); });

/* ======================= 跑起来 ======================= */
console.log(`\n=== 前端集成测试（DOM 影子层）@ ${BASE} ===\n`);
console.log('启动 app.js …');
await import('../public/app.js');
await new Promise((r) => setTimeout(r, 1200));

check('app.js 完成初始化', fetchLog.some((l) => l.includes('/api/config')), fetchLog.join(' | '));
check('拉取了健康检查', fetchLog.some((l) => l.includes('/api/health')), '');
check('拉取了课程列表', fetchLog.some((l) => l.includes('GET /api/lectures')), '');

const listEl = doc.getElementById('lecture-list');
const items = listEl.children.filter((c) => c.className.includes('lecture-item'));
check('课程列表渲染出条目', items.length >= 1, `渲染了 ${items.length} 条`);
check('列表项含标题', items.some((i) => i.innerHTML.includes('二叉树')), items.map((i) => i.innerHTML.slice(0, 60)).join(' / '));
check('列表项含状态点', items.some((i) => i.innerHTML.includes('class="dot')), '');

/* --- 打开一条录音（固定选「示例」课，避免被用户的真实录音干扰断言）--- */
const api = await (await realFetch(BASE + '/api/lectures')).json();
const lecture = api.lectures.find((l) => String(l.title || '').startsWith('示例')) || api.lectures.find((l) => l.status === 'transcribed') || api.lectures[0];
check('后端有可用示例', !!lecture, JSON.stringify(api).slice(0, 200));
check('选中的是有内容的录音', lecture && lecture.status === 'transcribed', lecture && lecture.title);

if (lecture) {
  const item = items.find((i) => i.innerHTML.includes(lecture.title)) || items[0];
  // 先把内容区滚到中间，验证点开录音后会自动回到顶部
  const contentEl = doc.getElementById('content');
  contentEl.scrollTop = 321;
  await item.onclick();
  await new Promise((r) => setTimeout(r, 400));

  check('点开录音后主界面滚回顶部', contentEl.scrollTop === 0, `scrollTop=${contentEl.scrollTop}`);
  // 详情要「覆盖」首页：首页引导页必须真的藏起来，否则它占着 70vh 把详情顶到下面，
  // 用户还得自己往下滑才能看到逐字稿。这正是老大反馈的那个现象。
  check('点开录音后首页引导页隐藏', doc.getElementById('empty-state').hidden === true, '');
  check('点开录音后详情显示', doc.getElementById('detail').hidden === false, '');
  check('详情顶部有返回按钮', !!doc.getElementById('btn-back'), '');

  check('标题写入界面', doc.getElementById('d-title').textContent.includes('二叉树'), doc.getElementById('d-title').textContent);
  check('课程写入界面', doc.getElementById('d-course').value === '数据结构', doc.getElementById('d-course').value);
  check('状态徽章更新', doc.getElementById('d-status').textContent.length > 0, '');
  check('音频源已设置', String(doc.getElementById('audio').src).includes('/audio'), String(doc.getElementById('audio').src));

  const segs = doc.getElementById('transcript-view').children.filter((c) => c.className.includes('seg'));
  check('逐字稿渲染出段落', segs.length >= 10, `渲染了 ${segs.length} 段`);
  check('逐字稿段落含时间', segs[0]?.innerHTML.includes('class="t"'), segs[0]?.innerHTML.slice(0, 80));

  const noteHtml = doc.getElementById('note-view').innerHTML;
  check('笔记渲染成 HTML', noteHtml.includes('课堂脉络与重点'), noteHtml.slice(0, 120));
  check('笔记含可点时间戳', noteHtml.includes('class="ts"') && noteHtml.includes('data-t='), '');
  check('笔记含关键词', noteHtml.includes('关键词'), '');
  check('笔记含自测题', noteHtml.includes('自测题'), '');
  check(
    '笔记来源标签',
    /离线|AI 生成/.test(doc.getElementById('note-source').textContent),
    doc.getElementById('note-source').textContent
  );
  check('转写引擎标签', doc.getElementById('engine-tag').textContent.length > 0, doc.getElementById('engine-tag').textContent);
  // 示例录音的 engine 和 model 都是「示例数据」，以前拼成「示例数据 · 示例数据 · 28 段」
  check(
    '引擎标签不重复（示例数据不出现两遍）',
    (doc.getElementById('engine-tag').textContent.match(/示例数据/g) || []).length <= 1,
    doc.getElementById('engine-tag').textContent
  );

  /* --- 工具栏两个笔记按钮（2026-10-24：改名 + 自动生成） ---
   * 「② 生成笔记」→「重新生成笔记」：转写完笔记已经自动出来了，这个按钮只剩
   * 「想按新设置重做一份」这一个用途，带序号反而暗示「必须点」。
   * 「AI 版笔记」→「AI 润色」：老大说这个名字更好懂 —— 它干的就是把口语润色成书面。
   */
  const btnNotes = doc.getElementById('btn-notes');
  const btnNotesAi = doc.getElementById('btn-notes-ai');
  check('有「重新生成笔记」按钮', !!btnNotes, btnNotes ? btnNotes.textContent : '不存在');
  check('「② 生成笔记」已改名「重新生成笔记」', (btnNotes?.textContent || '').includes('重新生成'), btnNotes?.textContent);
  check('「AI 版笔记」已改名「AI 润色」', (btnNotesAi?.textContent || '').includes('AI 润色'), btnNotesAi?.textContent);
  check('工具栏两个按钮都不再带②', !/②/.test((btnNotes?.textContent || '') + (btnNotesAi?.textContent || '')), '');

  /* --- 转写完成会自动补一篇离线笔记（2026-10-24） ---
   * 这里读源码断言：真的调用了 doNotes(false, {auto:true}) 那条路径。
   * 不真跑转写 —— 那要几分钟的 Whisper，dom-app-test 是几秒级的冒烟测试。
   */
  const appSrc = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  check(
    '转写收尾会自动生成笔记',
    /doNotes\(false,\s*\{\s*auto:\s*true/.test(appSrc),
    ''
  );
  check(
    '自动生成只在出了逐字稿时触发',
    /autoNote\s*=\s*doc\.transcript\.segments\.length\s*>\s*0/.test(appSrc),
    ''
  );
  check(
    '自动生成排在 endJob 之后（否则会被自己的任务槽挡住）',
    /endJob\(id\);[\s\S]{0,400}if\s*\(autoNote\)/.test(appSrc),
    ''
  );

  /* --- 思维导图视图 --- */
  doc.getElementById('tab-mindmap').onclick();
  const mmHtml = doc.getElementById('note-view').innerHTML;
  check('思维导图视图渲染出主题节点', mmHtml.includes('mm-topic'), mmHtml.slice(0, 160));
  check('思维导图叶子是短标签（mm-point 还在）', mmHtml.includes('mm-point'), '');
  // 导图不该复述笔记正文：叶子是**压缩过的一句命题**（不是整段要点）。
  // 2026-11-01 起叶子带类型徽章 `<span class="mm-badge">公式</span>`，
  // 量长度前得先把它剥掉，否则 `([^<]*)` 只能捕到空串、这条断言等于没测。
  const mmLeaf = [...mmHtml.matchAll(/class="mm-point">([\s\S]*?)<\/div>/g)]
    .map((m) => m[1].replace(/<span class="mm-badge">[\s\S]*?<\/span>/g, '').replace(/<[^>]*>/g, '').trim())
    .filter(Boolean);
  check(
    '思维导图的叶子都很短（≤26 字，不是整句复述）',
    mmLeaf.length === 0 || mmLeaf.every((s) => [...s].length <= 26),
    mmLeaf.filter((s) => [...s].length > 26).slice(0, 2).join(' | ')
  );
  // 类型徽章只在「公式/定义/定理/结论/步骤/例题/易错」判得出来时才挂，
  // 判不出来只挂一行字 —— 满屏「要点」等于没分类，所以这里只要求徽章名在白名单里。
  const mmBadges = [...mmHtml.matchAll(/class="mm-badge">([^<]*)</g)].map((m) => m[1]);
  check(
    '导图徽章只在白名单里（不出现「要点」这种没信息量的标签）',
    mmBadges.every((s) => ['公式', '定义', '定理', '结论', '步骤', '例题', '易错'].includes(s)),
    mmBadges.join(',')
  );
  check('思维导图的标签和笔记正文不同（不再逐字复制要点）', mmHtml.includes('mm-point'), '');
  check('导图时间徽标是可点的按钮', mmHtml.includes('class="mm-t"') && /<button class="mm-t"/.test(mmHtml), '');
  // 2026-10-30 导图改成树形发散（老大「照着 AI好记 的标准来」）：
  // 层级靠 .mm-node / .mm-kids 的嵌套表达，叶子是纯文字不再是圆角标签块。
  check(
    '导图是树形结构（.mm-root + .mm-kids 嵌套）',
    mmHtml.includes('class="mm-node mm-root"') && mmHtml.includes('class="mm-kids"'),
    mmHtml.slice(0, 120)
  );
  const mmCss = fs.readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');
  check(
    '导图叶子不再是胶囊标签（.mm-point 没有圆角块样式）',
    !/\.mm-point\s*\{[^}]*border-radius:\s*999px/.test(mmCss) && !/\.mm-point\s*\{[^}]*background:\s*var\(--panel-2\)/.test(mmCss),
    ''
  );
  doc.getElementById('tab-note').onclick();
  check('切回笔记视图', doc.getElementById('note-view').innerHTML.includes('课堂脉络与重点'), doc.getElementById('note-view').innerHTML.slice(0, 100));

  /* --- 点击逐字稿跳转 --- */
  const audio = doc.getElementById('audio');
  segs[3].onclick();
  check('点逐字稿跳转音频', Math.abs(audio.currentTime - Number(segs[3].dataset.start)) < 0.01, `currentTime=${audio.currentTime}`);

  /* --- 播放高亮 --- */
  audio.currentTime = Number(segs[5].dataset.start) + 0.5;
  audio.dispatch('timeupdate');
  check('播放时高亮当前段', segs[5].classList.contains('active'), '');

  /* --- 搜索 --- */
  const txSearch = doc.getElementById('tx-search');
  txSearch.value = '递归';
  fire(txSearch, 'input');
  const marked = doc.getElementById('transcript-view').children.filter((c) => c.innerHTML.includes('<mark>'));
  check('逐字稿搜索命中并高亮', marked.length >= 1, `命中 ${marked.length} 段`);
  txSearch.value = '';
  fire(txSearch, 'input');

  /* --- 列表搜索 --- */
  const searchBox = doc.getElementById('search');
  searchBox.value = '不存在的关键词xyz';
  fire(searchBox, 'input');
  check(
    '列表搜索无结果时给提示',
    listEl.children.some((c) => c.className.includes('hint') && c.innerHTML.includes('没有匹配')),
    listEl.children.map((c) => c.className + ':' + c.innerHTML.slice(0, 30)).join(' | ')
  );
  searchBox.value = '';
  fire(searchBox, 'input');
  check('清空搜索后列表恢复', listEl.children.filter((c) => c.className.includes('lecture-item')).length >= 1, '');

  /* --- 列表管理：置顶 --- */
  const listItems = () => listEl.children.filter((c) => c.className.includes('lecture-item'));
  const actsOf = (li) => li.children.find((c) => c.className.includes('li-actions'));
  const firstItem = listItems()[0];
  check('列表项带操作按钮（置顶/删除）', !!actsOf(firstItem) && actsOf(firstItem).children.length === 2, '');
  const beforePinned = firstItem.innerHTML.includes('pin-tag');
  const pinBtn = actsOf(firstItem).children[0];
  await pinBtn.onclick({ stopPropagation() {} });
  await new Promise((r) => setTimeout(r, 600));
  const patchLog = fetchLog.filter((l) => l.startsWith('PATCH /api/lectures/'));
  check('置顶操作发出 PATCH 请求', patchLog.length >= 1, patchLog.join(' | '));
  const afterPinned = listItems()[0].innerHTML.includes('pin-tag');
  check('置顶状态翻转并反映在列表', beforePinned !== afterPinned, `${beforePinned} -> ${afterPinned}`);

  /* --- 列表管理：多选与批量删除（confirm=false 时不删） --- */
  await doc.getElementById('btn-batch').onclick();
  check('进入多选模式：工具条出现', doc.getElementById('batch-bar').hidden === false, '');
  check('多选模式下条目带勾选框', listItems()[0].innerHTML.includes('li-check'), listItems()[0].innerHTML.slice(0, 80));
  listItems()[0].onclick();
  check('多选模式点条目 = 勾选（不打开）', doc.getElementById('batch-count').textContent.includes('已选 1'), doc.getElementById('batch-count').textContent);
  check('勾选的条目带选中样式', listItems()[0].classList.contains('selected'), '');
  const nBefore = (await (await realFetch(BASE + '/api/lectures')).json()).lectures.length;
  await doc.getElementById('btn-batch-delete').onclick();
  await new Promise((r) => setTimeout(r, 400));
  const nAfter = (await (await realFetch(BASE + '/api/lectures')).json()).lectures.length;
  check('取消批量删除时不误删', nBefore === nAfter, `${nBefore} -> ${nAfter}`);
  await doc.getElementById('btn-batch-exit').onclick();
  check('退出多选：工具条收起', doc.getElementById('batch-bar').hidden === true, '');

  /* --- 设置弹窗 --- */
  await doc.getElementById('btn-settings').onclick();
  await new Promise((r) => setTimeout(r, 800));
  check('设置弹窗打开', doc.getElementById('settings-modal').hidden === false, '');
  check('设置项已回填（模型）', doc.getElementById('s-local-model').value.length > 0, doc.getElementById('s-local-model').value);
  // 「笔记风格 / 每主题重点数 / 额外要求」已经从设置面板搬走了（2026-10-23），
  // 现在是每条录音自己的，在新建录音弹窗里问。所以这里改成验「确实搬走了」：
  // 设置里那几个 id 必须不存在，否则会出现两处都能改、互相打架。
  check('设置里不再有笔记风格', doc.getElementById('s-style') === null, 's-style 应已移除');
  check('设置里不再有重点条数', doc.getElementById('s-maxpoints') === null, 's-maxpoints 应已移除');
  check('设置里不再有额外要求', doc.getElementById('s-llm-extra') === null, 's-llm-extra 应已移除');
  const diag = doc.getElementById('diag');
  const diagText = diag.children.map((c) => c.innerHTML).join(' ');
  check('环境自检有输出', diag.children.length >= 3, `渲染了 ${diag.children.length} 行`);
  check('自检报告 WebGPU', diagText.includes('WebGPU'), diagText.slice(0, 120));
  check('自检报告服务端', diagText.includes('Node'), diagText.slice(0, 160));

  /* --- 存储位置（录音 / 模型缓存可自定义） ---
     这三项验的是「用户能看见自己现在存哪」—— 光有接口不算功能，
     界面上不显示的话，用户改完也不知道生效没有。
     注意这里是真服务、真数据目录，只读不动文件。 */
  const lectNow = doc.getElementById('s-lect-dir-now').textContent;
  const lectHint = doc.getElementById('s-lect-dir-hint').textContent;
  const modelsNow = doc.getElementById('s-models-dir-now').textContent;
  const modelsHint = doc.getElementById('s-models-dir-hint').textContent;
  check('录音目录有显示当前状态', /默认|自定义/.test(lectNow), lectNow);
  check('录音目录有显示实际路径', lectHint.includes(':') || doc.getElementById('s-lect-dir').value.includes(':'), lectHint);
  check('模型目录有显示当前状态', /默认|自定义/.test(modelsNow), modelsNow);
  check('模型目录有显示实际路径', modelsHint.includes(':') || doc.getElementById('s-models-dir').value.includes(':'), modelsHint);
  // 输入框里显示的是**当前实际位置**，不是配置值。
  // 为什么这么设计：默认状态下配置里是空串，填空串的话用户看不出录音存哪；
  // 参考图那种「框里就是真路径」更直接，改成默认值的绝对路径更好读。
  const sysNow = await (await realFetch(BASE + '/api/system')).json();
  const inputL = doc.getElementById('s-lect-dir').value;
  check('录音目录输入框显示实际位置', inputL === sysNow.storage.lectures.dir, `输入框="${inputL}" 期望="${sysNow.storage.lectures.dir}"`);
  // 复制 / 打开 / 重置 三个按钮必须都在、且本机可用
  for (const id of ['btn-lect-dir-copy', 'btn-lect-dir-open', 'btn-lect-dir-reset', 'btn-models-dir-copy', 'btn-models-dir-open', 'btn-models-dir-reset']) {
    const b = doc.getElementById(id);
    check(`${id} 存在且可用`, !!b && b.disabled === false, b ? `disabled=${b.disabled}` : '不存在');
  }

  /* --- 新建录音弹窗（每条录音自己的笔记设置） ---
     2026-10-23 从设置面板搬过来的：风格 / 每主题重点数 / 提示词。
     这三项改成「每条录音各自定义」，所以必须：① 弹窗存在且默认是关的；
     ② 打开后三样控件都在、有合理默认值；③ 创建返回的值能落到 meta 上。 */
  check('新建录音弹窗默认关着', doc.getElementById('new-lecture-modal').hidden === true, '');
  // 「笔记设置」的入口只剩侧栏每行的「⋯」这一个。工具栏和笔记面板右上角那两个
  // 都删了（2026-10-23 晚），这里各留一条断言，避免以后又长回来变成三个入口。
  check('工具栏的旧「笔记设置」按钮已撤掉', doc.getElementById('btn-note-prefs') === null, '');
  // 侧栏每一行都要有一个「⋯」：平时三个点，鼠标悬浮才显出「编辑」两个字。
  // 这是「改这条录音的笔记设置」最顺手的入口 —— 不用先打开录音。
  //
  // 注意不能用 doc.querySelectorAll('.li-edit')：影子层的 Doc 只索引 index.html
  // 里声明的节点和 misc，app.js 运行时 createElement 出来的节点不在里面，
  // 只能顺着 children 往下找（跟上面 actsOf 一个路子）。
  // state 只能从 globalThis.__LN__ 拿，不能在测试文件里直接引用 app.js 的模块作用域。
  const lnState = globalThis.__LN__?.state;
  const liRows = doc.getElementById('lecture-list').children.filter((c) => c.className.includes('lecture-item'));
  const rowEdits = liRows.map((li) => li.children.find((c) => c.className.includes('li-edit'))).filter(Boolean);
  check('侧栏每行都有「⋯」按钮', rowEdits.length > 0, `找到 ${rowEdits.length} 个`);
  check('「⋯」的数量和录音条数一致', rowEdits.length === (lnState?.lectures?.length || 0), `${rowEdits.length} vs ${lnState?.lectures?.length}`);
  const oneEdit = rowEdits[0];
  // 影子层里 el('span','dots', html) 设的是那只 span 的 innerHTML，父按钮的
  // textContent 不会跟着变（真浏览器会）。所以顺着 children 把两样都收上来比。
  const deepText = (n) =>
    n ? `${n.textContent || ''}${n.innerHTML || ''}${n.children.map((c) => deepText(c)).join('')}` : '';
  const oneEditTxt = deepText(oneEdit);
  // 三个点从字符「⋯」换成了 SVG 图标 #i-more（2026-10-29 UI 翻新：
  // emoji 和特殊符号在不同系统上画得不一样，统一改成单色描边图标）。
  // 这里认图标的引用名，不再认字符本身；「编辑」两个字仍然是文字。
  check('「⋯」里是三点图标加「编辑」两个字', oneEditTxt.includes('#i-more') && oneEditTxt.includes('编辑'), oneEditTxt);
  check('「⋯」的 title 写着当前笔记设置', !!oneEdit && /笔记设置/.test(oneEdit.title || ''), oneEdit ? oneEdit.title : '');
  // 旧的那个「笔记面板右上角 chip」已经撤掉了（2026-10-23 晚，老大要求挪到侧栏），
  // 断言它确实不在，避免以后又长回来变成两个入口。
  check('笔记面板右上角的旧 chip 已撤掉', doc.getElementById('btn-note-prefs-note') === null, '');
  // 直接调 openNewLecture 会等用户点按钮，所以这里只验「弹窗能被填好」：
  // 打开 → 检查三个控件的默认值 → 取消。
  doc.getElementById('new-lecture-modal').hidden = false;
  const nlStyle = doc.getElementById('nl-style');
  const nlMax = doc.getElementById('nl-maxpoints');
  const nlExtra = doc.getElementById('nl-extra');
  check('弹窗有笔记风格下拉', !!nlStyle && nlStyle.tagName === 'SELECT', nlStyle ? nlStyle.tagName : '不存在');
  check('弹窗有重点条数下拉', !!nlMax && nlMax.tagName === 'SELECT', nlMax ? nlMax.tagName : '不存在');
  check('弹窗有提示词输入框', !!nlExtra && nlExtra.tagName === 'TEXTAREA', nlExtra ? nlExtra.tagName : '不存在');
  check('重点条数有「自适应」档', [...nlMax.children].some((o) => o.value === '0'), `选项=${[...nlMax.children].map((o) => o.value).join(',')}`);
  check('笔记风格覆盖三档', ['exam', 'outline', 'cornell'].every((v) => [...nlStyle.children].some((o) => o.value === v)), '');
  doc.getElementById('new-lecture-modal').hidden = true;

  /* --- 每条录音的笔记偏好真的能存能读 --- */
  const lectsNow = (await (await realFetch(BASE + '/api/lectures')).json()).lectures;
  const probe = lectsNow.find((l) => !l.notePrefs) || lectsNow[0];
  if (probe) {
    const before = probe.notePrefs;
    await realFetch(BASE + '/api/lectures/' + probe.id, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ notePrefs: { style: 'cornell', maxPointsPerTopic: 0, extraPrompt: '重点用【】标出' } }),
    });
    const after = (await (await realFetch(BASE + '/api/lectures/' + probe.id)).json()).lecture;
    check('笔记偏好能存进 meta', after.notePrefs?.style === 'cornell', JSON.stringify(after.notePrefs));
    check('自适应（0）原样存下来', after.notePrefs?.maxPointsPerTopic === 0, String(after.notePrefs?.maxPointsPerTopic));
    check('提示词原样存下来', after.notePrefs?.extraPrompt === '重点用【】标出', String(after.notePrefs?.extraPrompt));
    // 还原，别把真实录音的偏好改坏了
    await realFetch(BASE + '/api/lectures/' + probe.id, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ notePrefs: before || null }),
    });
  } else {
    check('有录音可以测笔记偏好', false, '库里一条录音都没有');
  }

  /* --- 设置项按服务商显隐（合并下拉：local 块按「是否本地」，cloud 块按「有没有转写接口」）--- */
  const localBlocks = doc.misc.filter((n) => n.dataset.for === 'local');
  const cloudBlocks = doc.misc.filter((n) => n.dataset.for === 'cloud');
  const keyField = doc.getElementById('key-field');
  const provSelInit = doc.getElementById('s-provider');
  check('本地/云端设置块都被识别', localBlocks.length >= 1 && cloudBlocks.length >= 1, `local=${localBlocks.length} cloud=${cloudBlocks.length}`);
  // 默认值是这台机器 data/config.json 里的真实设置，可能是 local 也可能是云端。
  // 所以先按「当前服务商」断言一次，再切到 local 断言「本地该藏的都藏了」——
  // 不能假设初始就是 local，否则换了机器的配置这 2 项就假红。
  const initIsLocal = provSelInit.value === 'local';
  check(
    `设置块按当前服务商（${provSelInit.value}）显隐一致`,
    cloudBlocks.every((n) => n.hidden === initIsLocal) && localBlocks.every((n) => n.hidden === !initIsLocal),
    `initIsLocal=${initIsLocal}`,
  );
  check(`Key 栏按当前服务商（${provSelInit.value}）显隐一致`, keyField.hidden === initIsLocal, '');
  if (!initIsLocal) {
    provSelInit.value = 'local';
    fire(provSelInit, 'change');
  }
  check('选本地时隐藏云端选项', cloudBlocks.every((n) => n.hidden === true), JSON.stringify(cloudBlocks.map((n) => n.hidden)));
  check('选本地时隐藏 Key 栏', keyField.hidden === true, '');
  doc.getElementById('s-provider').value = 'siliconflow';
  fire(doc.getElementById('s-provider'), 'change');
  check('切到云端后显示云端选项', cloudBlocks.every((n) => n.hidden === false) && localBlocks.every((n) => n.hidden === true), '');
  check('切到云端后显示 Key 栏', keyField.hidden === false, '');
  doc.getElementById('s-provider').value = 'local';
  fire(doc.getElementById('s-provider'), 'change');

  /* --- 云端接入：切服务商要真的把地址填进去 --- */
  const provSel = doc.getElementById('s-provider');
  const epEl = doc.getElementById('s-asr-endpoint');
  const mdEl = doc.getElementById('s-asr-model');
  provSel.value = 'openai';
  fire(provSel, 'change');
  check('切到 OpenAI 后接口地址被填上', /api\.openai\.com/.test(epEl.value), epEl.value);
  check('切到 OpenAI 后模型被填上', mdEl.value.length > 0, mdEl.value);
  check('切换后提示含申请地址', /申请地址|接口：/.test(doc.getElementById('s-provider-hint').textContent), '');
  provSel.value = 'custom';
  fire(provSel, 'change');
  check('切到自定义后清空地址（免得被上一家盖住）', epEl.value === '', epEl.value);

  /* --- 四家服务商全部「两样都能做」---
     2026-10-21 收敛掉了 DeepSeek / Groq / 智谱 这些「只能做一半」的，
     所以原来的「llm-only 时藏起云端转写选项」这条断言已经没有对应场景，
     换成反向断言：四家任何一家都不许把云端转写选项藏起来（local 除外）。 */
  for (const pid of ['siliconflow', 'openai', 'custom']) {
    provSel.value = pid;
    fire(provSel, 'change');
    check(`${pid}：云端转写选项全部显示`, cloudBlocks.every((n) => n.hidden === false), '');
    check(`${pid}：本地那组全部隐藏`, localBlocks.every((n) => n.hidden === true), '');
    check(`${pid}：Key 栏显示`, keyField.hidden === false, '');
  }
  provSel.value = 'siliconflow';
  fire(provSel, 'change');

  /* --- 模型卡片选择器（转写 / 笔记 / 本地） ---
     为什么值得单独验：模型名原来是自由输入框，用户填完 Key 根本不知道
     自己在用哪个模型，也不知道还有免费档和更准的付费档。改成卡片后
     最容易坏的两处是「选中态没同步」和「点了卡片输入框没跟着变」——
     那两种情况下界面看着正常，实际保存下去的还是老模型。 */
  const cardOf = (listId) => doc.getElementById(listId).children;
  const onCard = (listId) => cardOf(listId).find((c) => c.classList.contains('on')) || null;
  const nameOf = (card) => (card?.querySelector('.model-name')?.textContent || '').trim();

  check('转写模型铺出了卡片', cardOf('asr-model-list').length >= 2, `${cardOf('asr-model-list').length} 张`);
  check('转写模型有选中态', !!onCard('asr-model-list'), nameOf(onCard('asr-model-list')));
  check(
    '转写模型的选中项就是输入框里的值',
    /SenseVoice/.test(nameOf(onCard('asr-model-list'))),
    `${nameOf(onCard('asr-model-list'))} / ${mdEl.value}`
  );
  check('转写模型每张卡都有档位徽章', cardOf('asr-model-list').every((c) => !!c.querySelector('.tier')), '');
  check('转写模型的卡片带一句话代价', cardOf('asr-model-list').every((c) => !!c.querySelector('.model-sub')), '');
  check('转写模型标题旁写了「现在用」', /现在用/.test(doc.getElementById('asr-model-now').textContent), doc.getElementById('asr-model-now').textContent);
  check('选中预设时手填框是收着的', doc.getElementById('asr-model-custom').hidden === true, '');

  const llmCards = cardOf('llm-model-list');
  check('笔记模型铺出了卡片', llmCards.length >= 2, `${llmCards.length} 张`);
  check('笔记模型有选中态', !!onCard('llm-model-list'), nameOf(onCard('llm-model-list')));
  check(
    '笔记模型「其他」卡在最后',
    /其他/.test(nameOf(llmCards[llmCards.length - 1])),
    nameOf(llmCards[llmCards.length - 1])
  );

  // 点一张没选中的卡：输入框、选中态、手填框三处都要跟着变
  const notOn = cardOf('asr-model-list').find((c) => !c.classList.contains('on') && c.querySelector('.tier')?.textContent !== '自定义');
  const beforeClick = mdEl.value;
  const wantId = notOn.dataset.modelId;
  notOn.dispatch('click');
  check('点卡片后输入框换成那个模型', mdEl.value === wantId && mdEl.value !== beforeClick, `${beforeClick} -> ${mdEl.value}`);
  // 注意：选中态要按「模型名」比，不能按节点身份比 —— 点一下会重铺一遍卡片，
  // 刚才那个 DOM 节点已经被换掉了，拿旧节点比永远是 false。
  check('点卡片后选中态跟着挪', onCard('asr-model-list')?.dataset.modelId === wantId, nameOf(onCard('asr-model-list')));
  check('点卡片后手填框仍然收着', doc.getElementById('asr-model-custom').hidden === true, '');
  // 点回第一张，别把后面用例的期望值搅乱
  cardOf('asr-model-list')[0].dispatch('click');

  // 点「其他」卡：手填框要摊开（自建 / 中转站用户唯一的入口）
  const otherCard = cardOf('asr-model-list')[cardOf('asr-model-list').length - 1];
  otherCard.dispatch('click');
  check('点「其他」展开手填框', doc.getElementById('asr-model-custom').hidden === false, nameOf(otherCard));
  doc.getElementById('asr-model-custom').hidden = true;

  // 本地候选也走同一套：切到 local 才有卡片，且默认选中 turbo
  provSel.value = 'local';
  fire(provSel, 'change');
  check('切到本地后本地模型有卡片', cardOf('local-model-list').length >= 2, `${cardOf('local-model-list').length} 张`);
  check('本地模型默认选中 turbo', /turbo/i.test(nameOf(onCard('local-model-list'))), nameOf(onCard('local-model-list')));
  provSel.value = 'siliconflow';
  fire(provSel, 'change');

  /* --- 云端接入：教程弹窗 --- */
  // 教程正文是 onclick 里异步 fetch 来的，onclick 本身不返回 Promise。
  // 所以不能「await onclick 再固定 sleep 700ms」——网慢一点就红。
  // 用带截止时间的轮询：等到有正文为止。
  const waitBody = async (ms = 8000) => {
    const t0 = Date.now();
    const box = doc.getElementById('api-body');
    while (Date.now() - t0 < ms) {
      if (box.innerHTML.length > 300) return box.innerHTML.length;
      await new Promise((r) => setTimeout(r, 100));
    }
    return box.innerHTML.length;
  };
  await doc.getElementById('btn-help-api').onclick();
  const asrLen = await waitBody();
  check('服务商教程弹窗打开', doc.getElementById('api-modal').hidden === false, '');
  check('服务商教程有正文', asrLen > 300, String(asrLen));
  doc.getElementById('btn-api-close').onclick();
  check('教程弹窗可关闭', doc.getElementById('api-modal').hidden === true, '');
  await doc.getElementById('btn-help-api-llm').onclick();
  const llmLen = await waitBody();
  check('笔记教程弹窗打开并分段显示', doc.getElementById('api-modal').hidden === false && llmLen > 300, String(llmLen));
  doc.getElementById('btn-api-close').onclick();

  /* --- 云端接入：清掉已保存的 Key（confirm 允许之后应当真的发 PUT）--- */
  globalThis.confirm = () => true;
  doc.getElementById('s-provider').value = 'siliconflow';
  fire(doc.getElementById('s-provider'), 'change');
  const beforeClears = fetchLog.filter((l) => l === 'PUT /api/config').length;
  await doc.getElementById('btn-clear-key').onclick();
  await new Promise((r) => setTimeout(r, 300));
  check(
    '清 Key 按钮真的发了保存请求',
    fetchLog.filter((l) => l === 'PUT /api/config').length > beforeClears,
    fetchLog.filter((l) => l.startsWith('PUT')).join(' | ')
  );
  provSel.value = 'custom';
  fire(provSel, 'change');
  check('自定义服务商地址栏可手填（切到 custom 后为空）', doc.getElementById('s-asr-endpoint').value === '', '');
  globalThis.confirm = () => false;
  /* --- 全局错误处理确实生效 --- */
  globalThis.__fireError('测试注入的异常');
  check('全局错误会被提示给用户', firedErrors.length === 1, '');

  /* --- 关闭弹窗 --- */
  doc.getElementById('btn-settings-close').onclick();
  check('设置弹窗可关闭', doc.getElementById('settings-modal').hidden === true, '');

  /* --- 删除按钮（confirm 返回 false，应当不删） --- */
  const before = (await (await realFetch(BASE + '/api/lectures')).json()).lectures.length;
  await doc.getElementById('btn-delete').onclick();
  const after = (await (await realFetch(BASE + '/api/lectures')).json()).lectures.length;
  check('取消删除时不误删', before === after, `${before} -> ${after}`);

  /* --- 侧栏收起 / 展开 --- */
  const layoutEl = doc.getElementById('layout');
  const sideBtn = doc.getElementById('btn-sidebar');
  check('顶栏有收起侧栏按钮', !!sideBtn, '');
  sideBtn.onclick();
  check('点收起按钮后侧栏收掉', layoutEl.classList.contains('collapsed'), '');
  check('收起后按钮变成展开箭头', /i-chevron-right/.test(sideBtn.innerHTML || ''), sideBtn.innerHTML);
  sideBtn.onclick();
  check('再点一次侧栏展开', !layoutEl.classList.contains('collapsed'), '');
  check('展开后按钮变回收起箭头', /i-chevron-left/.test(sideBtn.innerHTML || ''), sideBtn.innerHTML);

  /* --- 返回列表：详情收起、首页回来 --- */
  doc.getElementById('btn-back').onclick();
  await new Promise((r) => setTimeout(r, 300));
  check('点返回后详情隐藏', doc.getElementById('detail').hidden === true, '');
  check('点返回后首页引导页显示', doc.getElementById('empty-state').hidden === false, '');
  check('点返回后音频源被清掉', !doc.getElementById('audio').src, String(doc.getElementById('audio').src));
  check('点返回后地址栏 hash 被清空', !String(globalThis.location.hash || ''), String(globalThis.location.hash || ''));
}

/* --- 云端服务商不返回时间戳：不该假装有时间 ---
   实测 SenseVoice 这类云端 ASR 只回整段文字，segments 的时间戳全是 0。
   旧界面照样渲染「00:00」并给整行绑点击，点了只会跳回 0 秒 —— 用户以为坏了。
   现在应该：不渲染时间列、不绑点击、顶部给出说明。 */
console.log('\n--- 无时间戳的逐字稿 ---\n');
{
  const openItem = doc.getElementById('lecture-list').children.find((c) => c.className.includes('lecture-item'));
  await openItem.onclick();
  await new Promise((r) => setTimeout(r, 300));

  const st = globalThis.__LN__?.state;
  const txSearch = doc.getElementById('tx-search');
  const txt = doc.getElementById('tx-note');
  check('无时间戳用例：拿到了应用状态', !!st?.current?.transcript?.segments?.length, String(!!st));

  if (st?.current?.transcript?.segments?.length) {
    const real = st.current.transcript.segments;
    st.current.transcript.segments = real.map((s) => ({ ...s, start: 0, end: 0 }));
    fire(txSearch, 'input');
    const rows = doc.getElementById('transcript-view').children.filter((c) => c.className.includes('seg'));
    check('无时间戳时不渲染时间列', !rows[0].innerHTML.includes('class="t"'), rows[0].innerHTML.slice(0, 60));
    check('无时间戳时段落不可点', typeof rows[3].onclick !== 'function', String(rows[3].onclick));
    check('无时间戳时给出提示条', txt.hidden === false, txt.textContent.slice(0, 40));
    check('提示条写明原因与补救办法', /不提供逐句时间戳/.test(txt.textContent) && /本地模型/.test(txt.textContent), txt.textContent);

    st.current.transcript.segments = real;
    fire(txSearch, 'input');
    const back = doc.getElementById('transcript-view').children.filter((c) => c.className.includes('seg'));
    check('恢复时间戳后提示条消失', txt.hidden === true, '');
    check('恢复时间戳后时间列回来', back[0].innerHTML.includes('class="t"'), back[0].innerHTML.slice(0, 60));
    check('恢复时间戳后段落可点', typeof back[3].onclick === 'function', String(back[3].onclick));
  }
}

check('app.js 注册了全局错误处理', errors.length >= 1, '');

await restoreConfig();

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
process.exitCode = fail ? 1 : 0;
if (fatal) {
  console.error('测试过程中抛出异常：', fatal);
  process.exitCode = 1;
}
