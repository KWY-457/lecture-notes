/**
 * 讲义笔记 LectureNotes —— 主应用
 */
import { renderMarkdown } from './md.js';
import { analyze, fmtTime } from './summarize.js';
import { transcribeLocal, estimateDecodeMemory } from './asr-local.js';
import { generateAINote, cleanTranscriptViaLLM, applyNoteHeader } from './llm.js';
import { cleanSegments } from './cleanup.js';
import { outlineFromMarkdown as noteOutlineFromMarkdown } from './note.js';
import { topicLeaves } from './mindmap.js';
import { optionsFor, getProvider, modelsFor, defaultModel, estimateCost, PROVIDER_VERSION, sortedModels, TIERS, modelSpec } from './providers.js';
import { createOnboard, shouldOnboard } from './onboard.js';

/* ============================ 全局状态 ============================ */
const state = {
  config: null,
  defaults: null,
  lectures: [],
  current: null, // {lecture, transcript, note}
  // busy / cancelled 是旧版「整个页面同时只能干一件事」的全局开关。现在改由下面的
  // jobs 表按录音分别管，字段留着只为兼容外部脚本（tests 里的探针会读 state）。
  busy: false,
  cancelled: false,
  filter: '',
  audioUrl: null,
  view: 'note', // note | mindmap
  keyVault: [], // 已保存的 API Key 清单（本机才有明文，局域网只有掩码）
  // 用户协议状态：{version, accepted, acceptedAt, text:{license, privacy}}
  // 正文只在打开弹窗时才拉，不在启动时占带宽
  agreement: null,
  // 打赏提醒：{hideOnStartup, bootId}。bootId 用来判断「这次打开是不是新一次启动」
  donate: null,
  // /system 的一次快照：{lan, modelCache, storage:{lectures,models,dataDir}, ...}
  // 存储位置那一段（现在存哪、是不是默认、占多大）靠它渲染。
  sys: null,
  // 存储位置的状态缓存，moveStorage 里判断「是不是已经改回默认」要用。
  // 和 sys.storage 是同一份数据，单独留一个引用只为少写几层可选链。
  storage: null,
  // 这个页面是不是「手机 / 另一台设备通过局域网打开」的。true 时只留上传，
  // 其余功能全藏掉。由 applyRemoteMode() 按 /health 的 local 字段定。
  remote: false,
};

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * 生成一个图标。
 *   icon('trash')            → <svg class="i"><use href="#i-trash"/></svg>
 *   icon('trash', 'sm')      → 小一号
 *
 * 图标本体在 index.html 顶部的 <svg class="sprite"> 里定义一次，这里只负责引用。
 * 以前这里到处是 emoji（📌 🗑 ⚠️ ✅），问题是同一个字符在 Windows 上是彩色
 * 塑料块、在 Linux 上是黑白线条，字号和基线都跟正文对不齐 —— 一屏十几个彩色
 * 小块就是「AI 生成界面」最典型的观感。改成单色描边图标后颜色由 CSS 的
 * color 继承，深浅色主题都不用手动管。
 */
const icon = (name, cls = '') => `<svg class="i${cls ? ' ' + cls : ''}"><use href="#i-${name}"/></svg>`;
/** 要真 DOM 节点（不是字符串）时用这个。
 *  注意不能 document.createElement('svg') —— 那样造出来的是 HTML 未知元素，
 *  里面的 <use> 也不会进 SVG 命名空间，图标不显示。走 HTML 解析器才正确。 */
const iconNode = (name, cls = '') => {
  const wrap = document.createElement('span');
  wrap.innerHTML = icon(name, cls);
  return wrap.firstElementChild;
};

let toastTimer = null;
function toast(msg, kind = '', ms = 3200) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast ' + kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

/* ============================ 接口封装 ============================ */
async function api(path, opts = {}) {
  const resp = await fetch('/api' + path, {
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.ok === false) throw new Error(data.error || `请求失败（HTTP ${resp.status}）`);
  return data;
}

/**
 * 全局进度条。
 *
 * 老大的原话：「转写进度给个进度条更加清晰明确的，还有一直在等待是怎么回事」。
 * 实测根因有两个，都不是「慢」，而是「没有任何反馈」：
 *   1. 模型命中浏览器缓存时，transformers.js 的 progress_callback 一条都不报，
 *      界面从第 1 秒到第 456 秒都是同一句「正在下载或计算」，看起来就是死机；
 *   2. 每个转写窗口只在**开始**时报一次（10 分钟音频 = 3 分钟没动静）。
 * 所以这里把「阶段 + 百分比 + 细节 + 秒表」四样都摆出来，
 * 没有细进度的阶段就走来回爬的 indeterminate 动画，绝不假装有进度。
 */
const STAGE_WEIGHT = { load: [0, 25], note: [25, 100] };

function stageName(stage) {
  if (stage === 'decode') return '① 解码音频';
  if (stage === 'lib') return '② 加载转写库';
  if (stage === 'model') return '③ 加载模型';
  if (stage === 'transcribe') return '④ 转写中';
  if (stage === 'cloud') return '④ 云端转写';
  if (stage === 'notes') return '② 分析逐字稿';
  if (stage === 'wait') return '等待中';
  return '处理中';
}

// 「慢爬」动画的计时器。进度栏只有一个，新的一次 progress 必须先把上一次的爬动掐掉，
// 否则切录音、恢复快照时会有好几个 setInterval 抢着改同一个宽度。
let crawlTimer = null;

function progress(show, label = '', pct, stage = '', detail = '', crawl = 0) {
  const wrap = $('progress-wrap');
  if (crawlTimer) {
    clearInterval(crawlTimer);
    crawlTimer = null;
  }
  wrap.hidden = !show;
  if (!show) {
    $('progress-fill').classList.remove('busy');
    return;
  }
  $('progress-stage').textContent = stageName(stage);
  $('progress-label').textContent = label || '处理中…';
  const d = $('progress-detail');
  d.textContent = detail || '';
  d.hidden = !detail;
  const fill = $('progress-fill');
  if (typeof pct === 'number') {
    fill.classList.remove('busy');
    const v = Math.max(0, Math.min(100, pct));
    fill.style.width = v + '%';
    $('progress-pct').textContent = Math.round(v) + '%';
  } else {
    // 没有细进度的阶段（读缓存里的模型 / ONNX 编译 / 等第一段推理结果）：
    // 走来回爬的 indeterminate 动画，用户一眼能看出「还活着」。
    fill.classList.add('busy');
    fill.style.width = '';
    $('progress-pct').textContent = '…';
    return;
  }
  // 转写阶段是唯一「能凭音频长度估出来」的阶段：一整段 5 分钟起步，
  // 等结果这几分钟里让进度条慢慢爬，但只爬向本段结束，不越过下一段真进度。
  if (crawl > 0) {
    let target = pct;
    const limit = Math.min(100, pct + Math.max(1, 100 / Math.max(1, crawl)));
    crawlTimer = setInterval(() => {
      if (target >= limit - 0.6) {
        clearInterval(crawlTimer);
        crawlTimer = null;
        return;
      }
      target += 0.5;
      fill.style.width = target + '%';
      $('progress-pct').textContent = Math.round(target) + '%';
    }, 2000);
    setTimeout(() => {
      if (crawlTimer) clearInterval(crawlTimer);
      crawlTimer = null;
    }, 600000);
  }
}

/**
 * 把「子阶段自己的百分比」换算成「整件活儿的百分比」，
 * 免得模型下载到 100% 时进度条先冲到 100% 再跌回 0%（老大看了一定骂人）。
 */
function overallPct(stage, pct) {
  const w = STAGE_WEIGHT[stage.startsWith('lib') || stage === 'model' || stage === 'cloud' ? 'load' : 'note'];
  if (typeof pct !== 'number') return undefined;
  return Math.round(w[0] + ((w[1] - w[0]) * Math.max(0, Math.min(100, pct))) / 100);
}

/* ====================== 按录音独立的任务表 ======================
 * 老大的问题：在「测试」里转写，切到「思想道德法治」还挂着一模一样的
 * 「④ 云端转写 · 已等待 0 分 23 秒」，分不清到底是哪条在转。
 * 根因不是文案，是**进度栏全局只有一个、且谁也不属于**：openLecture 根本不碰它，
 * 于是 A 的进度就留在了 B 的界面上。
 *
 * 现在每条录音各有一份任务档案（jobs），进度栏只画「当前打开这一条」的那一份：
 *   · 切到没有任务的录音 → 进度栏是空的；
 *   · 切回正在转的那条 → 进度栏立刻复原，已等待时间也不会丢。
 *
 * 并发规则按能力分，不一刀切：
 *   · 云端转写：服务端 POST /transcribe 没有锁也没有队列，一次请求一次 fetch，
 *     多项目并行互不影响 → 允许同时开，各自独立进度；
 *   · 本地 Whisper：每次都要 new Worker 抢同一块 WebGPU，两条一起跑只会互相拖死
 *     → 全局独占。此时其他录音的「转写」按钮置灰（.btn[disabled] 就是浅色），
 *       并在按钮旁边写清被哪条录音占着。
 */
const jobs = new Map(); // lectureId -> { kind, cloud, title, label, pct, stage, detail, crawl, ... }

/** 当前唯一在独占显卡的本地转写任务（没有就 null） */
function exclusiveTranscribeJob() {
  for (const j of jobs.values()) if (j.kind === 'transcribe' && !j.cloud) return j;
  return null;
}

function jobText(j) {
  if (!j) return '';
  if (j.kind === 'notes') return '写笔记中';
  if (typeof j.pct === 'number') return '转写中 ' + Math.round(j.pct) + '%';
  return '转写中';
}

/** 把任务状态画到进度栏；没有当前录音或当前录音没任务就收起进度栏 */
function renderJobProgress() {
  const id = state.current?.lecture?.id;
  const j = id ? jobs.get(id) : null;
  if (!j) {
    progress(false);
    return;
  }
  progress(true, j.label || '处理中…', j.pct, j.stage || '', j.detail || '', j.crawl || 0);
}

/**
 * 让「转写 / 笔记」按钮和旁边的提示语跟着任务表走。
 * 三种状态：本录音在跑（灰 + 「转写中」）、被别的本地转写占着（灰 + 说明）、可以开跑。
 */
function syncToolbar() {
  const id = state.current?.lecture?.id || null;
  const mine = id ? jobs.get(id) : null;
  const running = mine && mine.kind === 'transcribe' ? mine : null;
  const lock = exclusiveTranscribeJob();
  const blocked = lock && lock.id !== id ? lock : null;

  const tb = $('btn-transcribe');
  // 已经转过的录音，按钮不能还喊「① 开始转写」—— 那是在催人再转一遍，
  // 而转写是最贵的一步（本地几分钟、云端按分钟计费）。改成「重新转写」，
  // 并且去掉 primary 蓝底：蓝底是「下一步该点我」的信号，
  // 转写完成之后该被看见的是「重新生成笔记」，不是「再转一遍」。
  const done = state.current?.lecture?.status === 'transcribed';
  tb.disabled = !id || !!running || !!blocked;
  if (running) {
    tb.textContent = running.cloud ? '⏳ 云端转写中…' : '⏳ 本地转写中…';
    tb.title = running.cloud
      ? '这条录音正在云端转写，进度见上方进度栏'
      : '这条录音正在本地转写，显卡被它独占，进度见上方进度栏';
  } else if (blocked) {
    tb.textContent = done ? '重新转写' : '① 开始转写';
    tb.title = '「' + (blocked.title || '另一条录音') + '」正在本地转写，显卡同一时间只能转一条';
  } else if (done) {
    tb.textContent = '重新转写';
    tb.title = '这条录音已经转写过了；点这里是重转一遍（会在原逐字稿上覆盖）';
  } else {
    tb.textContent = '① 开始转写';
    tb.title = '把这条录音转成逐字稿';
  }
  // 没转过的才配蓝底；转过的用普通按钮，避免「再转一遍」抢走注意力
  tb.classList.toggle('primary', !!id && !done && !running && !blocked);

  // 提示语：自己这条在跑最要紧，其次是「被别人的本地转写占着」，再次是「后台还有几条在云端转」
  const hint = $('transcribe-hint');
  if (hint) {
    const others = [...jobs.values()].filter((j) => j.kind === 'transcribe' && j.id !== id);
    if (running) {
      hint.textContent = running.cloud
        ? '这条录音正在云端转写（可切到别的录音，进度不会串）'
        : '这条录音正在本地转写，显卡被它独占';
      hint.className = 'tb-hint';
    } else if (blocked) {
      hint.textContent = '「' + (blocked.title || '另一条录音') + '」正在本地转写，暂不可同时进行';
      hint.className = 'tb-hint warn';
    } else if (others.length) {
      hint.textContent = '另有 ' + others.length + ' 条录音正在转写（侧栏可见）';
      hint.className = 'tb-hint';
    } else {
      hint.textContent = '';
      hint.className = 'tb-hint';
    }
  }

  // 笔记按钮只在「这条录音正在写笔记」时禁用。
  // 没有逐字稿时不禁用：原来点一下会 toast「请先完成转写」，
  // 比一个不知为何变灰、还不说原因的按钮好懂。
  const nb = mine && mine.kind === 'notes' ? mine : null;
  $('btn-notes').disabled = !!nb;
  $('btn-notes-ai').disabled = !!nb;
  // 原来这里还有个「笔记设置」按钮的启用判断，2026-10-23 晚那个按钮删了：
  // 入口只在侧栏每行的「⋯」上，不跟着当前录音变灰。
  if (nb) {
    $('btn-notes').title = '正在写笔记…';
    $('btn-notes-ai').title = '正在写笔记…';
  } else {
    // 这两个 title 得跟 index.html 里写的一致：syncToolbar 每次状态变化都会把 title
    // 覆写一遍，index.html 里那句只是首帧用的，两边不同步就会出现「鼠标移上去
    // 一会儿是旧文案、一会儿是新文案」的精神分裂。
    $('btn-notes').title = '转写完成后笔记会自动生成；想按新设置重做时点这里';
    $('btn-notes-ai').title = '用大模型把口语润色成书面笔记';
  }

  // 旧字段跟着任务表同步，外部脚本读 state.busy 时不会看到假的「忙」
  state.busy = jobs.size > 0;
}

function startJob(id, kind, patch = {}) {
  const j = {
    id,
    kind,
    cloud: false,
    title: '',
    label: '',
    pct: undefined,
    stage: '',
    detail: '',
    crawl: 0,
    startedAt: Date.now(),
    cancelled: false,
    abort: new AbortController(),
    tick: null,
    stoppedLLM: false,
    ...patch,
  };
  jobs.set(id, j);
  renderJobProgress();
  renderList();
  syncToolbar();
  return j;
}

function updateJob(id, patch) {
  const j = jobs.get(id);
  if (!j) return;
  Object.assign(j, patch);
  if (state.current?.lecture?.id === id) renderJobProgress();
  updateListJob(id);
}

function endJob(id) {
  const j = jobs.get(id);
  if (j?.tick) clearInterval(j.tick);
  jobs.delete(id);
  renderJobProgress();
  renderList();
  syncToolbar();
}

/** 侧栏里那条「转写中 42%」的小字：只改文字，不重排整个列表（免得 hover 状态被重置） */
function updateListJob(id) {
  const node = document.querySelector('[data-job="' + id + '"]');
  if (node) node.textContent = jobText(jobs.get(id));
}

/**
 * 写进度时统一走这里：有任务档案就写档案（只有当前打开的那条会显示），
 * 没有任务档案（上传、示例、诊断这些一次性动作）就直接画进度栏。
 */
function reportProgress(jobId, patch) {
  if (jobId && jobs.has(jobId)) updateJob(jobId, patch);
  else progress(true, patch.label || '', patch.pct, patch.stage || '', patch.detail || '', patch.crawl || 0);
}

/**
 * 大模型这一侧是「一台机器上的一份服务」，两条云端录音同时跑到校对/写笔记时
 * 会一起去打同一个接口。用一条串行队列排队，谁先到谁先用，不并发打。
 */
let llmLock = Promise.resolve();
function runSerial(fn) {
  const run = llmLock.then(fn, fn);
  llmLock = run.then(
    () => {},
    () => {}
  );
  return run;
}

/* ============================ 课程列表 ============================ */
async function loadLectures() {
  const { lectures } = await api('/lectures');
  state.lectures = lectures;
  renderList();
}

/* 列表多选状态：多选模式下点条目是勾选，不是打开 */
const batch = { on: false, selected: new Set() };

function renderList() {
  const ul = $('lecture-list');
  ul.innerHTML = '';
  const q = state.filter.trim().toLowerCase();
  // 置顶优先，其余按导入时间倒序
  const sorted = [...state.lectures].sort(
    (a, b) =>
      (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) ||
      String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
  );
  const items = sorted.filter(
    (l) => !q || (l.title || '').toLowerCase().includes(q) || (l.course || '').toLowerCase().includes(q)
  );
  if (!items.length) {
    ul.appendChild(el('li', 'hint', state.lectures.length ? '没有匹配的录音' : '还没有录音，点右上角「导入录音」开始。'));
    return;
  }
  for (const l of items) {
    const li = el(
      'li',
      'lecture-item' +
        (state.current?.lecture?.id === l.id ? ' active' : '') +
        (batch.on && batch.selected.has(l.id) ? ' selected' : '')
    );
    const date = (l.createdAt || '').slice(5, 16).replace('T', ' ');
    const dur = l.duration ? fmtTime(l.duration) : '';
    const size = l.size ? (l.size / 1048576).toFixed(1) + 'MB' : '';
    // 正在跑任务的录音才多一行「转写中 42%」；没任务的什么都不加。
    // 这一行是老大区分「哪条真在转」最直接的地方：侧栏里一眼看得到，不用点进去。
    const job = jobs.get(l.id);
    li.innerHTML =
      (batch.on ? `<span class="li-check">${icon(batch.selected.has(l.id) ? 'check-square' : 'square')}</span>` : '') +
      `<div class="li-main">
        <div class="li-title">${l.pinned ? `<span class="pin-tag" title="已置顶">${icon('pin')}</span>` : ''}<span class="dot ${esc(l.status || 'uploaded')}"></span><span>${esc(l.title || '未命名')}</span></div>
        <div class="li-meta">${l.course ? `<span>${esc(l.course)}</span>` : ''}<span>${esc(date)}</span>${dur ? `<span>${dur}</span>` : ''}${size ? `<span>${size}</span>` : ''}</div>
        ${job ? `<div class="li-job" data-job="${esc(l.id)}">${esc(jobText(job))}</div>` : ''}
      </div>`;
    // 操作按钮用真实节点：hover 时才显示，且必须 stopPropagation，否则会误触「打开」
    const acts = el('span', 'li-actions');
    const pb = el('button', 'li-btn' + (l.pinned ? ' on' : ''), icon('pin'));
    pb.title = l.pinned ? '取消置顶' : '置顶';
    pb.onclick = (e) => {
      if (e?.stopPropagation) e.stopPropagation();
      togglePin(l.id);
    };
    const db = el('button', 'li-btn danger', icon('trash'));
    db.title = '删除';
    db.onclick = (e) => {
      if (e?.stopPropagation) e.stopPropagation();
      deleteLecture(l.id);
    };
    acts.appendChild(pb);
    acts.appendChild(db);
    li.appendChild(acts);
    // 「⋯」：这条录音的笔记设置（用哪套风格、几条重点、有没有专门提示词）。
    // 平时是三个点，鼠标悬浮才显出「编辑」两个字 —— 每一行常驻一个「编辑」
    // 太吵，可只放个图标又没人知道是干嘛的，所以让它自己说话。
    //
    // 位置在置顶/删除的**右边**：那两只是整行悬浮才出现的，如果把 ⋯ 放它们
    // 左边，一悬浮它们冒出来就会把 ⋯ 往左推 —— 鼠标旁边的按钮忽然换位置
    // 最容易点错。放右边则 ⋯ 一直钉在最右，置顶/删除从它左边滑进来。
    const eb = el('button', 'li-edit');
    eb.title = '笔记设置（现在是「' + notePrefsLabel(l) + '」）';
    eb.appendChild(el('span', 'dots', '<svg class="i sm"><use href="#i-more"/></svg>'));
    eb.appendChild(el('span', 'word', '编辑'));
    eb.onclick = (e) => {
      if (e?.stopPropagation) e.stopPropagation();
      editNotePrefs(l.id);
    };
    li.appendChild(eb);
    li.onclick = () => {
      if (batch.on) {
        toggleSelect(l.id);
        return;
      }
      openLecture(l.id);
      $('sidebar').classList.remove('open');
    };
    ul.appendChild(li);
  }
}

/** 置顶 / 取消置顶：服务端 PATCH 已支持任意字段，pinned 布尔直接写入 meta.json */
async function togglePin(id) {
  const L = state.lectures.find((l) => l.id === id);
  if (!L) return;
  try {
    await api('/lectures/' + id, { method: 'PATCH', body: { pinned: !L.pinned } });
    await loadLectures();
    toast(L.pinned ? '已取消置顶' : '已置顶', 'ok');
  } catch (e) {
    toast('操作失败：' + e.message, 'err');
  }
}

/** 删除单条录音（列表小按钮 / 主界面删除按钮共用） */
async function deleteLecture(id) {
  const L = state.lectures.find((l) => l.id === id);
  if (!confirm(`确定删除「${L?.title || '未命名'}」？音频、逐字稿与笔记将一并删除，无法恢复。`)) return;
  await api('/lectures/' + id, { method: 'DELETE' });
  if (state.current?.lecture?.id === id) {
    state.current = null;
    $('detail').hidden = true;
    $('empty-state').hidden = false;
    setDetailOpen(false);
    $('audio').removeAttribute('src');
    try {
      history.replaceState(null, '', location.pathname);
    } catch {}
  }
  await loadLectures();
  toast('已删除', 'ok');
}

function toggleSelect(id) {
  if (batch.selected.has(id)) batch.selected.delete(id);
  else batch.selected.add(id);
  renderList();
  updateBatchBar();
}

function updateBatchBar() {
  $('batch-count').textContent = batch.on ? `已选 ${batch.selected.size} 条` : '';
  $('btn-batch-delete').disabled = !batch.selected.size;
}

function setBatchMode(on) {
  batch.on = on;
  batch.selected.clear();
  $('batch-bar').hidden = !on;
  $('btn-batch').textContent = on ? '退出多选' : '多选';
  renderList();
  updateBatchBar();
}

/* ============================ 打开一条录音 ============================ */

/**
 * 详情页是「应用外壳」还是「长文档」？
 *
 * 以前两者混在一起：详情页六层（返回 / 标题 / 元信息 / 播放器 / 工具栏 / 双栏）
 * 全铺在 .content 这一个滚动区里。实测 1280×800 下正文第一个标题要滚到 y=538
 * 才出现 —— 一屏 800px，前 242px 被头三层吃掉，剩下的还在往下滚。
 * 更糟的是音频播放器跟着滚走：边听边看笔记得手动往回滚。
 *
 * 现在桌面端打开录音时给 .content 挂 detail-open，把它变成定高外壳：
 * 上面几层定高，双栏吃掉剩余高度、各自内部滚动。关掉详情页立刻还原成
 * 普通长文档（引导页仍要能正常滚）。
 * 窄屏不启用：那里双栏本来就是上下单栏，逐字稿在下面，保持原样更顺。
 */
function setDetailOpen(on) {
  const c = $('content') || document.querySelector('.content');
  if (c) c.classList.toggle('detail-open', !!on);
}

async function openLecture(id) {
  // 手机模式没有详情页（转写/笔记/导出全在电脑上做），从任何入口点进来都拦住。
  // 不拦的话点一下会白屏 —— 详情那块 DOM 还在，但里面的按钮全被 CSS 藏了。
  if (state.remote) {
    toast('这条已经传到电脑上了。转写和生成笔记请在电脑上打开「讲义笔记」。', '', 6000);
    return;
  }
  const data = await api('/lectures/' + id);
  state.current = data;
  $('empty-state').hidden = true;
  $('detail').hidden = false;
  setDetailOpen(true);
  try {
    history.replaceState(null, '', '#/l/' + id);
  } catch {}
  const L = data.lecture;
  $('d-title').textContent = L.title || '未命名';
  $('d-course').value = L.course || '';
  const st = { uploaded: '已导入', transcribing: '转写中', transcribed: '已转写', failed: '转写失败' }[L.status] || L.status;
  const badge = $('d-status');
  badge.textContent = st;
  badge.className =
    'badge ' + (L.status === 'transcribed' ? 'ok' : L.status === 'failed' ? 'err' : L.status === 'transcribing' ? 'warn' : '');
  renderMetaRow(L);

  if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
  state.current.src = '/api/lectures/' + id + '/audio';
  $('audio').src = state.current.src;

  renderEngineTag();
  renderTranscript();
  renderNote();
  renderList();
  // 进度栏与工具栏都只画「当前这条录音」的任务：
  // 切到没在转的录音就是空的，切回正在转的那条会立刻复原（含已等待时间）。
  renderJobProgress();
  syncToolbar();
  // 点开一条录音后，主界面直接回到顶部：旧录音的内容可能滚在半截，
  // 新录音一打开却还停在那个位置，容易误以为没切换。
  const content = $('content') || document.querySelector('.content');
  if (content) content.scrollTop = 0;
}

function renderMetaRow(L) {
  const bits = [];
  if (L.createdAt) bits.push({ t: '导入于 ' + L.createdAt.slice(0, 16).replace('T', ' ') });
  if (L.size) bits.push({ t: (L.size / 1048576).toFixed(1) + ' MB' });
  if (L.duration) bits.push({ t: '时长 ' + fmtTime(L.duration) });
  if (L.textbook) bits.push({ t: '教材《' + esc(L.textbook) + '》' });
  if (L.chapter) bits.push({ t: '章节 ' + esc(L.chapter) });
  // 文件名单独标一类：它常常跟标题几乎一样（思想道德法治 / 思想道德法治.m4a），
  // 是这一行里最长又最没用的一项。窄屏上直接藏掉，见 app.css 的 .mi-file。
  if (L.originalName) bits.push({ t: esc(L.originalName), cls: 'mi-file' });
  // 用 flex + gap 排这些碎信息，分隔点交给 CSS 的 ::before 画。
  // 原来是把 ' · ' 当文本节点拼进去 —— 窄屏下 .meta-row 会换行，那些
  // 「·」自己变成 flex 项，落在行首或行尾，看着像标点掉了（手机截图实测）。
  $('d-info').innerHTML = bits
    .map((b) => `<span${b.cls ? ` class="${b.cls}"` : ''}>${b.t}</span>`)
    .join('');
}

function currentTranscript() {
  return state.current?.transcript || { segments: [], text: '' };
}

function renderEngineTag() {
  const t = currentTranscript();
  const tag = $('engine-tag');
  if (!t.segments?.length) {
    tag.textContent = '';
    return;
  }
  const engine = { local: '浏览器本地 Whisper', siliconflow: '硅基流动 SenseVoice', groq: 'Groq Whisper', openai: 'OpenAI Whisper', custom: '自定义接口', demo: '示例数据' }[t.engine] || t.engine || '';
  const dev = t.device ? (t.device === 'webgpu' ? ' · 显卡加速' : ' · CPU（慢）') : '';
  // 抗噪状态也标出来：同样的模型，降没降噪结果差很多，得让人一眼看见
  const dn = t.denoise;
  let dnText = '';
  if (dn && dn.applied && dn.stats) {
    const drop = dn.stats.noiseFloorDbBefore - dn.stats.noiseFloorDbAfter;
    dnText = ` · 已抗噪（底噪降 ${drop.toFixed(0)}dB${dn.stats.humHz?.length ? '，压掉 ' + dn.stats.humHz.map((f) => f.toFixed(0)).join('/') + 'Hz 嗡声' : ''}）`;
  } else if (dn && dn.skipped) {
    dnText = ' · 未抗噪（本来够清楚）';
  }
  // 示例录音的 engine 和 model 都叫「示例数据」，拼出来是「示例数据 · 示例数据 · 28 段」。
  // 同一个词连说两遍不像话，占位相同时就只留一个。
  const modelText = t.model && t.model !== engine ? ' · ' + t.model : '';
  tag.textContent = `${engine}${modelText}${dev} · ${t.segments.length} 段${dnText}`;
  tag.style.color = t.device === 'wasm' ? 'var(--warn)' : '';
}

/* ============================ 逐字稿 ============================ */

/* 收起 / 展开逐字稿面板。
   收起后整列压掉（.panes.tx-collapsed 里 .tx-pane display:none），笔记占满宽度；
   同时笔记面板头右侧冒出「展开逐字稿」按钮，否则就再也点不回来了。
   偏好存 localStorage（不存服务端）：这是「这个屏幕怎么看舒服」的纯显示偏好，
   换台电脑不该被同步过去，也不该占配置、不该走 /api/config 往返。 */
const TX_COLLAPSED_KEY = 'ln-tx-collapsed';

function setTranscriptCollapsed(collapsed, { save = true } = {}) {
  $('panes').classList.toggle('tx-collapsed', !!collapsed);
  $('tx-reopen').hidden = !collapsed;
  if (save) {
    try {
      localStorage.setItem(TX_COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch {
      // 隐私模式 / 存储被禁 —— 记不住就记不住，这次照样能收起，不该崩。
    }
  }
  // 收起/展开会改变笔记面板的宽度，导图里的节点会跟着重新换行 ——
  // 连线是量出来的，得等布局稳定后再量一遍（下一帧）。
  if (state.view === 'mindmap') requestAnimationFrame(() => drawMindMapEdges($('note-view')));
}

function restoreTranscriptCollapsed() {
  let want = false;
  try {
    want = localStorage.getItem(TX_COLLAPSED_KEY) === '1';
  } catch {}
  setTranscriptCollapsed(want, { save: false });
}

function renderTranscript() {
  const host = $('transcript-view');
  const segs = currentTranscript().segments || [];
  host.innerHTML = '';
  if (!segs.length) {
    $('tx-note').hidden = true;
    host.appendChild(el('p', 'placeholder', '还没有转写内容。点上面的「① 开始转写」。'));
    return;
  }
  // 云端服务商（SenseVoice 这类）只回整段文字、不给逐句时间戳，于是每一行都显示
  // 00:00、点时间戳也跳不动。这不是 bug 但用户会以为是坏的 —— 明确说清楚，
  // 并给出可行的补救办法（换本地 Whisper 或换支持时间戳的服务商）。
  const hasTime = segs.some((s) => Number(s.end) > Number(s.start) || Number(s.start) > 0);
  const note = $('tx-note');
  if (hasTime) {
    note.hidden = true;
  } else {
    note.hidden = false;
    note.textContent =
      '本次转写由云端服务商提供，它只返回整段文字、不提供逐句时间戳，所以左侧时间一律显示 00:00，点击无法定位回听。需要按时间回听，请改用本地模型（large-v3-turbo）重新转写。';
  }
  const q = ($('tx-search').value || '').trim();
  segs.forEach((s, i) => {
    const row = el('div', 'seg' + (s.suspect ? ' suspect' : ''));
    row.dataset.i = i;
    row.dataset.start = s.start;
    row.dataset.end = s.end;
    let text = esc(s.text);
    if (q) {
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      text = text.replace(re, (m) => `<mark>${m}</mark>`);
    }
    const warn = s.suspect ? `<span class="x-warn" title="这段很可能是识别幻觉，建议回听核对">${icon('alert', 'sm')}</span>` : '';
    row.innerHTML = hasTime
      ? `<span class="t">${fmtTime(s.start)}</span><span class="x">${warn}${text}</span>`
      : `<span class="x">${warn}${text}</span>`;
    // 没有时间戳就别给假的点击反馈：点了也只会跳回 0 秒，反倒像坏了。
    if (hasTime) row.onclick = () => seek(s.start, true);
    else row.classList.add('notime');
    host.appendChild(row);
  });
}

function seek(t, play = false) {
  const a = $('audio');
  a.currentTime = Number(t) || 0;
  if (play) a.play().catch(() => {});
}

function highlightAt(time) {
  const rows = $('transcript-view').querySelectorAll('.seg');
  let target = null;
  for (const r of rows) {
    if (Number(r.dataset.start) <= time && time < Number(r.dataset.end)) {
      target = r;
      break;
    }
  }
  rows.forEach((r) => r.classList.toggle('active', r === target));
  if (target && !target.dataset.scrolled) {
    target.dataset.scrolled = '1';
    const host = $('transcript-view');
    const top = target.offsetTop - host.offsetTop;
    if (Math.abs(host.scrollTop - top) > host.clientHeight * 0.6) host.scrollTop = top - host.clientHeight / 3;
  }
}

/* ============================ 笔记 ============================ */
/** 从笔记 Markdown 的 ### 标题与 - 列表反推提纲（AI 笔记没有离线分析数据时用）
 *
 * 实现在 note.js 里：服务端读笔记时要用同一份（两边各写一套迟早解析出两个结果，
 * 表现为「界面上的思维导图」和「导出/体检看到的提纲」不一样）。
 */
const outlineFromMarkdown = noteOutlineFromMarkdown;

/**
 * 从笔记渲染一份「骨架式」思维导图。
 *
 * 老版本这里是原样输出每个主题下的要点句子，结果跟左边「课堂脉络与重点」
 * 逐字相同 —— 同一份内容摆两遍，导图 tab 就白占了。
 * 后来改成「抽关键词当叶子」（topicLabels + squeezeLabel），解决了复读，
 * 但词没有命题性：实测一份高数笔记抽出 `看一` `阶档` `道题` `冷记记一下` ——
 * 那些是 ASR 把口语切碎后的残渣，不是知识点。老大原话：「最重要的是什么，公式，结论」。
 *
 * 现在叶子 = **一句压缩过的命题 + 类型标签**（公式/定义/定理/结论/步骤/例题/易错），
 * 抽取与判定全在 public/mindmap.js，这里只管拼 DOM。
 * 时间戳点一下就跳过去 —— 以前 CSS 里给了 cursor:pointer 却没绑事件，是个假按钮。
 */
function renderMindMapView(note) {
  // AI 笔记优先：从正文「## 课堂脉络与重点」的 ### 主题 + - 要点生成（这是书面语版）；
  // 离线笔记的 markdown 没有这种结构，才回退到离线提纲。
  let outline = outlineFromMarkdown(note?.markdown);
  if (!outline.length) outline = note?.data?.outline || [];
  if (!outline.length) return '<p class="placeholder">还没有提纲。先点「重新生成笔记」。</p>';
  // outlineFromMarkdown() 是重新解析出来的对象，**不带 data.outline 里的
  // localKeywords**（那是离线引擎逐主题算的专有名词，是导图最好的标签来源之一）。
  // 按标题把两边对起来补回去；标题对不上就当成没有，不影响其它字段。
  const stored = Array.isArray(note?.data?.outline) ? note.data.outline : [];
  if (stored.length) {
    for (const t of outline) {
      if (Array.isArray(t.localKeywords) && t.localKeywords.length) continue;
      const hit = stored.find((s) => s && s.heading === t.heading && Array.isArray(s.localKeywords));
      if (hit) t.localKeywords = hit.localKeywords;
    }
  }
  const title = note?.data?.title || state.current?.lecture?.title || '课堂笔记';
  const esc2 = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // 跨主题去重：同一句话被两节都抽出来时只挂一次，否则树里出现两遍一样的叶子
  const used = new Set();
  // 树形结构：根 → 主题 → 标签。连线不用 CSS 画（直角肘太死板），
  // 渲染完由 drawMindMapEdges() 量位置、用 SVG 画三条贝塞尔 —— 见下面那个函数。
  // 外面套一层 .mm-wrap 是为了窄屏能横向滚动：树天然要宽度，
  // 手机 390px 放不下一条长主题，挤到换行反而看不出层级。
  let h = '<div class="mm-wrap"><div class="mm"><div class="mm-node mm-root"><div class="mm-label">' + esc2(title) + '</div><div class="mm-kids">';
  // 「这段没提炼出知识点」整篇只写一次（见下面 else 分支的理由）
  let saidEmpty = false;
  outline.forEach((t, ti) => {
    const ts =
      t.start != null ? `<button class="mm-t" data-t="${Number(t.start)}" title="从 ${fmtTime(t.start)} 开始播放">${fmtTime(t.start)}</button>` : '';
    // 叶子是一句压缩过的**命题**（带类型标签），不是关键词。
    // 理由见 public/mindmap.js 开头的注释：词没有命题性，
    // `看一` `阶档` `道题` 这种 ASR 残渣挂上去等于没提炼。
    const leaves = topicLeaves(t, { used });
    // 一条都抽不出来就明说「这段没提炼出知识点」，**不再退回「摘半句」**。
    // 原来这里有一层 `squeezeLabel(p.text, 10)` 兜底，产出的是
    // 「为什么是这样的」「当于三阶导的时候」「他考试」「所以要乘一个负的」——
    // 全是口语长句被硬切十来个字，比空着更像坏了。
    // 老大原话「实在不会不要瞎编」，摘半句就是瞎编的一种。
    // 每条一级分支一个颜色（.mm-b0 ~ .mm-b5），换个话题换种颜色，扫起来能分段。
    // 连线统一一种灰蓝，跟分支色叠在一起会花 —— 老大说过「颜色觉得绕就一个色」。
    h += `<div class="mm-node mm-b${ti % 6}"><div class="mm-label mm-topic"><span class="mm-text">${esc2(t.heading)}</span>`;
    // 圆圈数字 = 这节抽出了几个知识点，一眼看出这块有多少内容（AI好记 也是这个位置）。
    if (leaves.length) h += `<span class="mm-count">${leaves.length}</span>`;
    // 时间徽标放在最后：它在手机上会被挤出去，所以 CSS 里窄屏单独处理。
    h += ts + '</div>';
    if (leaves.length) {
      h += '<div class="mm-kids">';
      for (const l of leaves) {
        // 类型标签只在明确判出来时才有（公式/定义/定理/结论/步骤/例题/易错），
        // 判不出来就只挂一行字，不写「要点」—— 满屏「要点」等于没有分类。
        const badge = l.label && l.type !== 'point' ? `<span class="mm-badge">${esc2(l.label)}</span>` : '';
        h += `<div class="mm-node"><div class="mm-label mm-point">${badge}${esc2(l.text)}</div></div>`;
      }
      h += '</div>';
    } else {
      // 抽不出知识点就明说，别留一段空白 —— 空着看起来像没加载出来。
      // 同一份笔记里空主题一多，这句话会重复七八遍，看着像报错、反而更乱；
      // 所以只在**第一个**空主题下面写一次，后面的空主题就留空（圆点数字本来就没有）。
      if (!saidEmpty) {
        saidEmpty = true;
        h += '<div class="mm-kids"><div class="mm-node"><div class="mm-label mm-none">这段没提炼出知识点</div></div></div>';
      }
    }
    h += '</div>';
  });
  return h + '</div></div></div></div>';
}

/**
 * 给思维导图画曲线连线。
 *
 * 为什么不在 CSS 里画：纯 CSS 只能画直角肘（border-left + border-bottom），
 * 一多就像组织架构图。要「从父节点右侧中点弯到子节点左侧中点」的柔和曲线，
 * 只能用 SVG 的 path，而且必须先量出每个节点在页面上的真实位置。
 *
 * 量的是收起的（相对 .mm 容器）：label 右边界 → 子 label 左边界，
 * 控制点取两者横坐标的中点，纵向各留一半 —— 三次贝塞尔画出来就是标准的树杈。
 *
 * 每次渲染/窗口尺寸变化都要重画（换行会让整棵树高度变），所以单独抽出来。
 */
function drawMindMapEdges(host) {
  const wrap = host.querySelector('.mm');
  if (!wrap) return;
  const old = wrap.querySelector('.mm-lines');
  if (old) old.remove();
  const base = wrap.getBoundingClientRect();
  if (!base.width || !base.height) return; // 面板藏着（宽度 0）时量不出东西，别画一堆 0 长度线
  const paths = [];
  for (const node of wrap.querySelectorAll('.mm-node')) {
    const kids = node.querySelector(':scope > .mm-kids');
    if (!kids) continue;
    const pl = node.querySelector(':scope > .mm-label');
    if (!pl) continue;
    const pr = pl.getBoundingClientRect();
    const x1 = pr.right - base.left;
    const y1 = pr.top + pr.height / 2 - base.top;
    for (const kid of kids.children) {
      const kl = kid.querySelector(':scope > .mm-label');
      if (!kl) continue;
      const kr = kl.getBoundingClientRect();
      const x2 = kr.left - base.left;
      const y2 = kr.top + kr.height / 2 - base.top;
      const mx = Math.round(((x1 + x2) / 2) * 10) / 10;
      paths.push(
        `<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${mx} ${y1.toFixed(1)}, ${mx} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}" />`
      );
    }
  }
  if (!paths.length) return;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'mm-lines');
  svg.setAttribute('width', String(Math.round(base.width)));
  svg.setAttribute('height', String(Math.round(base.height)));
  svg.setAttribute('viewBox', `0 0 ${Math.round(base.width)} ${Math.round(base.height)}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = paths.join('');
  wrap.insertBefore(svg, wrap.firstChild);
}

/** 窗口变窄变宽会让树重新换行，连线得跟着重画（防抖 150ms，别每像素都算一遍）。 */
let mmResizeTimer = null;
function scheduleMindMapRedraw() {
  clearTimeout(mmResizeTimer);
  mmResizeTimer = setTimeout(() => {
    if (state.view === 'mindmap') drawMindMapEdges($('note-view'));
  }, 150);
}

function renderNote() {
  const host = $('note-view');
  const note = state.current?.note;
  if (!note?.markdown) {
    host.innerHTML = '<p class="placeholder">还没有笔记。先点「① 开始转写」，转写完成后笔记会自动生成。</p>';
    $('note-source').textContent = '';
    return;
  }
  const mode = note.mode === 'llm' ? `AI 生成${note.model && note.model !== 'llm' ? ' · ' + note.model : ''}` : '离线引擎';
  // 服务端会告诉你这份笔记跟不跟得上当前的逐字稿与算法（见 public/note.js）。
  // 离线笔记服务端已经自动重建过了，走到这里的 stale 一定是 AI 笔记 ——
  // 那种笔记重算要花用户的 Key 钱，不能替用户决定，只提示一句「可以重建」。
  const ns = state.current?.noteStatus;
  let staleHint = '';
  if (ns?.stale) {
    // 提示要写清「为什么过时」和「按哪个按钮」，只说「可重建」等于没说
    staleHint = ` · ${ns.reason || '已过时'}，点「AI 润色」可重新生成`;
  }
  if (state.view === 'mindmap') {
    host.innerHTML = renderMindMapView(note);
    $('note-source').textContent = '思维导图（主题 + 关键词，点时间可跳转）';
    // 导图里的时间徽标点一下就跳过去（以前只写了 cursor:pointer，没绑事件）
    host.querySelectorAll('.mm-t').forEach((b) => {
      b.onclick = (e) => {
        e.preventDefault();
        seek(b.dataset.t, true);
      };
    });
    // 曲线连线要等节点排版完才量得到位置 —— 这里 innerHTML 已生效，同步量即可。
    drawMindMapEdges(host);
    return;
  }
  // 旧笔记里可能还留着模型抄的「课程：（未填）｜日期：｜时长：未知」。
  // 渲染时用当前录音的真实元数据覆盖一遍 —— 不用重新生成，打开就是对的。
  const L = state.current?.lecture || {};
  const md = applyNoteHeader(note.markdown, {
    course: L.course,
    createdAt: L.createdAt,
    duration: Number(L.duration) || Number($('audio').duration) || 0,
  });
  host.innerHTML = renderMarkdown(md);
  $('note-source').textContent = mode + staleHint + (note.createdAt ? ' · ' + note.createdAt.slice(5, 16).replace('T', ' ') : '');
  host.querySelectorAll('a.ts').forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      seek(a.dataset.t, true);
    };
  });
}

/** 保证本地大模型在跑（用于校对/写笔记前），就绪返回 true */
async function ensureLocalLLM(jobId, quiet = false) {
  const isLocal = /127\.0\.0\.1|localhost/i.test(state.config.llm.baseUrl || '');
  if (!isLocal) return true; // 云端端点不用管
  const info = await api('/local-llm').catch(() => null);
  if (!info || !info.configured) return false;
  if (info.running) return true;
  // quiet：转写收尾时「悄悄把大模型拉回来」不需要进度栏（那时候进度栏已经收起来了，
  // 再画一条没人收的就永远挂在界面上了）。
  if (!quiet) reportProgress(jobId, { label: '本地大模型未运行，正在启动（约 10 秒）…', pct: 8, stage: '', detail: '' });
  await api('/local-llm', { method: 'POST', body: { action: 'start' } }).catch(() => {});
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const t = await api('/llm/test', { method: 'POST', body: {} }).catch(() => null);
    if (t && t.ok) return true;
  }
  return false;
}

/**
 * 转写前给 WebGPU 腾显存：本地大模型（Qwen2.5-7B，常驻约 6GB）和转写抢同一块显存，
 * 显存不够时浏览器会**悄悄退回 CPU 模式**——慢十几倍、还很吃内存，表现就是「一直在等待」。
 *
 * 所以这里不问、不弹框，直接自动停掉本地大模型腾地方；转写结束后再自动拉回来
 * （见 transcribe 的 finally 与 rest? 逻辑）。
 *
 * @param {{totalMB:number,freeMB:number}} gpu 停下之前的读数，只用来算文案
 * @returns {Promise<boolean>} 真的腾出显存返回 true（调用方据此决定要不要写完再拉回来）
 */
const VRAM_NEED_MB = 2500; // 能稳稳跑起 whisper-large-v3-turbo 的余量，实测 2.1GB 已用 / 5.8GB 空闲时正常

async function freeVramForTranscribe(gpu, jobId) {
  const before = gpu.freeMB / 1024;
  reportProgress(jobId, {
    label: `显存仅剩 ${before.toFixed(1)}GB，正在自动停止本地大模型以释放显存…`,
    pct: 2,
    stage: '',
    detail: '',
  });
  toast(`显存不足，已自动停止本地大模型（转写完成后自动恢复）`, 'ok', 4000);
  await api('/local-llm', { method: 'POST', body: { action: 'stop' } }).catch(() => {});
  // taskkill 之后显存是慢慢放的，等它涨上来；每 500ms 看一次，最多 15 秒
  let after = gpu;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const now = await api('/gpu').catch(() => null);
    if (!now || !now.available) break;
    after = now;
    if (now.freeMB >= VRAM_NEED_MB) break;
  }
  if (after.freeMB >= VRAM_NEED_MB) {
    toast(`显存已释放：空闲 ${before.toFixed(1)}GB → ${(after.freeMB / 1024).toFixed(1)}GB`, 'ok', 4000);
    return true;
  }
  // 没腾够（比如还有动态壁纸/Steam 占着）也照样往下走，但得说清楚
  toast(`释放后空闲仍仅 ${(after.freeMB / 1024).toFixed(1)}GB，转写可能退回 CPU 模式`, '', 6000);
  return false;
}

/* ============================ 转写流程 ============================ */
async function doTranscribe() {
  const L = state.current?.lecture;
  if (!L) return;
  const id = L.id;
  const cfg = state.config.asr;
  const isCloud = cfg.provider !== 'local';

  // 本录音已经在跑任务（转写或笔记）→ 不重复开第二条。
  // jobs 是「一条录音一个任务槽」，同一条录音不允许并行两件事（会互相覆盖档案）。
  const mine = jobs.get(id);
  if (mine) {
    return toast(mine.kind === 'transcribe' ? '这条录音正在转写，请等它完成' : '这条录音正在生成笔记，请等它完成', '', 4000);
  }

  // 已有一条本地转写在跑 → 谁都不许再开新转写。
  // 这里**不能**写成 `if (!isCloud)`：那样判定用的是「我这条录音配的是哪个服务商」，
  // 于是 A 在跑本地 Whisper（占着显卡）、B 配的是云端时，B 仍能照常开跑 ——
  // 界面明明已经把按钮置灰了，代码却不拦，两边规则对不上。
  // 换成看「当前有没有本地转写在跑」，与 syncToolbar 的 blocked 判定同源。
  //
  // 为什么本地在跑时云端也不让开：云端 ASR 确实不占本机显卡，但它回来后要接本地大模型
  // 做错别字校对，而那个大模型已经被 freeVramForTranscribe 停掉给 Whisper 腾显存了，
  // 中途拉回来又会和 Whisper 抢显存。所以统一等它跑完。
  // 反过来，云端之间照旧可以并发：服务端一次请求一次 fetch，互不影响。
  const lock = exclusiveTranscribeJob();
  if (lock) {
    return toast(
      `「${lock.title || '另一条录音'}」正在本地转写，显卡同一时间只能转一条，请等它完成`,
      'err',
      6000
    );
  }

  const job = startJob(id, 'transcribe', { cloud: isCloud, title: L.title || '未命名', label: '准备中…', pct: 1 });
  job.stoppedLLM = false; // 每次转写重新判断，别把上一轮的残留算进来
  // 转写成功且真出东西时置 true，finally 里据此补一篇离线笔记（详见 finally 的注释）
  let autoNote = false;

  // 本地转写开跑前先说清楚两件事：
  //   1) 显存够不够 —— 本地大模型 + 动态壁纸之类的常驻程序会把 8GB 显存吃到只剩几百 MB，
  //      而显存不足时浏览器会**悄悄退回 CPU 模式**（慢十几倍，还很吃内存）
  //   2) 解码要吃多少内存
  if (cfg.provider === 'local') {
    const dur = Number($('audio').duration) || Number(L.duration) || 0;
    const mins = Math.round(dur / 60);
    const est = estimateDecodeMemory(dur || 60 * 60, 2);
    const memGB = (est.peakBytes / 1024 ** 3).toFixed(1);
    const [gpu, llm] = await Promise.all([api('/gpu').catch(() => null), api('/local-llm').catch(() => null)]);

    // 显存紧张时自动把本地大模型停掉腾地方 —— 转写和写笔记本来就不需要同时跑。
    // 以前这里弹确认框问「要不要停」，老大明确要求别问：自动腾，腾完再拉回来。
    if (gpu && gpu.available && gpu.freeMB < VRAM_NEED_MB && llm && llm.running) {
      const freed = await freeVramForTranscribe(gpu, id);
      if (freed) job.stoppedLLM = true;
    } else if (gpu && gpu.available && gpu.freeMB < 2500) {
      const go = confirm(
        `显卡显存仅剩 ${(gpu.freeMB / 1024).toFixed(1)}GB（总 ${(gpu.totalMB / 1024).toFixed(1)}GB）。\n\n` +
          `显存不足时浏览器将退回 CPU 模式，速度慢约十余倍。占用显存的常驻程序通常是动态壁纸、Steam、微信、浏览器等。\n` +
          `建议先关闭部分程序再转写。\n\n是否继续？`
      );
      if (!go) {
        endJob(id);
        return;
      }
    }

    if (dur > 45 * 60 || est.peakBytes > 1.2 * 1024 ** 3) {
      const go = confirm(
        `这条录音约 ${mins} 分钟。\n\n` +
          `当前本地模型 ${cfg.localModel}，长录音会转很久（纯 CPU 上一小时课要几十分钟到几小时，` +
          `取决于你选的模型和机器）。转写期间请保持本窗口开启。\n\n` +
          `解码阶段将额外占用约 ${memGB}GB 内存，页面可能短暂卡顿。\n\n` +
          `嫌慢可以先在设置里换成 base 或 tiny，或者用云端转写（几十秒出稿）。\n\n` +
          `是否继续？`
      );
      if (!go) {
        endJob(id);
        return;
      }
    }
  }

  // 心跳：Worker 自己每秒会报一次（beat()），所以这里只兜底
  // 「读音频 / 停顿 / 收尾」这些 Worker 不管的空档，超过 6 秒没新消息才补一句。
  let lastMsg = '准备中…';
  let lastAt = Date.now();
  // 云端转写走的是「上传 → 等服务商一次性返回」，中间没有任何进度回调。
  // 以前这里只会说「已 N 秒无新消息」，看着像卡死；现在把阶段和已用时间说清楚。
  job.tick = setInterval(() => {
    const s = Math.round((Date.now() - lastAt) / 1000);
    if (s < 6) return;
    const mmss = `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒`;
    if (isCloud) {
      updateJob(id, {
        label: `云端转写中，已等待 ${mmss}`,
        pct: undefined,
        stage: 'cloud',
        detail: '服务商要等整段音频处理完才一次性返回，中途没有进度可显示。整节课通常需要音频时长的 0.1-0.3 倍。',
        crawl: 0,
      });
    } else {
      updateJob(id, { label: `已 ${s} 秒无新消息，任务仍在运行（请勿关闭窗口）`, pct: undefined, stage: 'wait', detail: lastMsg });
    }
  }, 1000);

  try {
    let result;
    if (cfg.provider === 'local') {
      const resp = await fetch('/api/lectures/' + L.id + '/audio');
      if (!resp.ok) throw new Error('读取音频失败');
      const blob = await resp.blob();
      toast('本地转写已开始。首次使用需下载转写模型（几十 MB 至几百 MB），请稍候…', '', 5000);
      result = await transcribeLocal(
        blob,
        {
          model: cfg.localModel,
          device: cfg.localDevice,
          // 模型自己的精度声明（cpuDtype / gpuDtype）要一起送进 Worker：
          // base/small 在显卡上跑不出正确结果（见 providers.js 里那张实测表），
          // Worker 靠 spec.gpuDtype === null 判定「这个模型别用显卡」。
          spec: modelSpec('local', 'asr', cfg.localModel),
          cdn: cfg.cdn,
          modelHost: cfg.modelHost,
          language: cfg.language === 'auto' ? undefined : cfg.language,
          denoise: cfg.denoise !== false,
        },
        (p) => {
          lastMsg = p.message || '转写中…';
          lastAt = Date.now();
          // Worker 报的 stage 决定阶段徽章：lib/model 合起来是「加载」，transcribe 是「转写中」。
          const phase = p.stage === 'transcribe' ? 'job' : 'load';
          updateJob(id, {
            label: lastMsg,
            pct: overallPct(p.stage || '', p.pct),
            stage: phase,
            detail: p.heartbeat ? '这一阶段没有更细的进度，别急' : '',
            crawl: p.stage === 'transcribe' ? p.slices || 6 : 0,
          });
          // 部分结果只在「这条录音还开着」时才往界面上贴，
          // 切到别的录音去转写时不能把 A 的逐字稿画进 B 的页面里。
          if (p.partial && state.current?.lecture?.id === id) {
            state.current.transcript = { ...currentTranscript(), segments: p.partial };
            renderTranscript();
          }
        },
        () => !!jobs.get(id)?.cancelled
      );
    } else {
      updateJob(id, { label: '正在上传音频并等待云端转写结果…', pct: overallPct('', 10), stage: 'cloud', detail: '' });
      lastMsg = '云端转写中…';
      lastAt = Date.now();
      const t0 = Date.now();
      const data = await api(`/lectures/${L.id}/transcribe`, {
        method: 'POST',
        body: { language: cfg.language === 'auto' ? '' : cfg.language },
      });
      result = { ...data.transcript };
      const usedS = Math.round((Date.now() - t0) / 1000);
      updateJob(id, {
        label: `云端转写返回，用时 ${Math.floor(usedS / 60)} 分 ${String(usedS % 60).padStart(2, '0')} 秒`,
        pct: overallPct('', 72),
        stage: 'cloud',
      });
      lastAt = Date.now();
    }

    // 逐字稿自检：先做确定性清洗（繁转简、删符号、规范标点），
    // 再用大模型按上下文纠正音近错字 —— 你要求的「生成完做一遍自检」
    let cleaned = cleanSegments(result.segments || []);
    let cleanedBy = 'rule';
    if (state.config.llm.enabled && cleaned.length) {
      try {
        await ensureLocalLLM(id);
        updateJob(id, { label: '正在用大模型校对错别字…', pct: overallPct('', 78), stage: 'notes' });
        // 注意：要送**清洗后**的 cleaned 进去，不能送 result.segments（原始）。
        // 送原始的会让大模型自己去处理繁体字，实测它会顺手改出
        // 「及時」「回覆」这种繁体来（模型见过大量繁体语料），
        // 而确定性清洗是逐字 1:1、100% 可预期的，交给它更稳。
        const ac = jobs.get(id)?.abort;
        // 大模型只有一份服务：两条云端录音同时跑完、同时来校对会互相排队等死。
        // 这里走串行队列，第二条等第一条校对完再上（各自进度栏照样独立）。
        const r = await runSerial(() =>
          cleanTranscriptViaLLM(cleaned, {
            onProgress: (m, p) => updateJob(id, { label: m, pct: overallPct('', p), stage: 'notes' }),
            signal: ac?.signal,
          })
        );
        if (r.segments.length) {
          cleaned = r.segments;
          cleanedBy = 'llm';
          // 降级块 = 大模型这一块没交出干净结果（输出被截断/条目数对不上），
          // 已经逐级重试并兜底成「保留基础清洗结果」。必须告诉用户哪几块没校对到，
          // 否则用户会以为整条都校对过了。
          // 两条录音可能同时在云端转，toast 必须点名是哪一条，否则分不清。
          if (r.repaired?.length) {
            toast(
              `「${L.title || '未命名'}」校对完成，修正 ${r.changed} 处。第 ${r.repaired.join('、')} 块模型返回不完整，该块已按基础清洗保留（未校对）`,
              '',
              7000
            );
          } else {
            toast(`「${L.title || '未命名'}」校对完成，修正 ${r.changed} 处（错别字 / 繁体 / 符号）`, 'ok', 4000);
          }
        }
      } catch (e) {
        if (!String(e.message).includes('取消'))
          toast(`「${L.title || '未命名'}」大模型校对未成功，已按基础清洗保存：` + e.message, '', 5000);
      }
    }

    updateJob(id, { label: '正在保存转写结果…', pct: 96, stage: '' });
    // 抗噪记录一起存下来：以后想知道「这条为什么转得好 / 不好」时有据可查
    const dn = result.denoise || null;
    const denoiseInfo = dn
      ? {
          applied: !!dn.enabled,
          skipped: !!dn.skipped,
          reason: dn.reason || '',
          ms: dn.ms || 0,
          health: dn.health
            ? {
                score: dn.health.score,
                verdict: dn.health.verdict,
                snrDb: Math.round(dn.health.snrDb * 10) / 10,
                speechRatio: Math.round(dn.health.speechRatio * 100) / 100,
              }
            : null,
          stats: dn.stats
            ? {
                noiseFloorDbBefore: Math.round(dn.stats.noiseFloorDbBefore * 10) / 10,
                noiseFloorDbAfter: Math.round(dn.stats.noiseFloorDbAfter * 10) / 10,
                speechRatio: Math.round(dn.stats.speechRatio * 100) / 100,
                humHz: (dn.stats.humHz || []).map((f) => Math.round(f * 10) / 10),
                overSubUsed: Math.round(dn.stats.overSubUsed * 100) / 100,
                appliedRescueDb: Math.round(dn.stats.appliedRescueDb * 10) / 10,
              }
            : null,
        }
      : null;
    const doc = await api(`/lectures/${L.id}/transcript`, {
      method: 'PUT',
      body: {
        language: cfg.language,
        engine: result.engine || cfg.provider,
        device: result.device || '',
        model: result.model || '',
        text: cleaned.map((s) => s.text).join('\n'),
        segments: cleaned,
        duration: result.duration || L.duration || 0,
        cleanedBy,
        denoise: denoiseInfo,
      },
    });
    // 写回只在「还开着这条录音」时动手：人家可能在 A 转写期间切到 B 看别的东西，
    // 这时候把 A 的结果画进 B 的页面就是张冠李戴。
    if (state.current?.lecture?.id === id) {
      state.current.transcript = doc.transcript;
      state.current.lecture.status = 'transcribed';
      state.current.lecture.model = result.model;
      renderTranscript();
      renderEngineTag();
    }
    await loadLectures();
    // 转写完了直接把笔记也写出来 —— 以前这里只是把「② 生成笔记」按钮点亮、
    // 弹一句「可点击…」，等于把最后一步又推给用户。转写要等好几分钟，
    // 人早走开了，回来还得记得再点一下，纯属多余。
    // 自动跑的固定是**离线引擎**：0.2 秒出结果、不花 Key 的钱、不占显存，
    // 想要更通顺的再点「AI 润色」（那个要钱或要等大模型，不能替用户决定）。
    // 用函数内的局部变量记这件事，不用模块级标志位：云端转写允许多条同时跑，
    // 模块级变量会被后开的一条覆盖掉，先完成的那条笔记就丢了。
    autoNote = doc.transcript.segments.length > 0;
  } catch (e) {
    toast(`「${L.title || '未命名'}」转写失败：` + e.message, 'err', 7000);
  } finally {
    endJob(id);
    // 先把任务槽让出来再写笔记：jobs 是「一条录音一个任务槽」，
    // 不等 endJob 就调 doNotes，doNotes 会撞上自己这条转写任务、
    // 直接弹「这条录音正在转写」然后什么都不做 —— 自动生成就静默失败了。
    if (autoNote) {
      // 不 await：让收尾流程先跑完（转写的 toast、按钮状态、进度栏都要收），
      // 笔记生成自己往后排队。doNotes 内部有 try/catch，不会出现未捕获的 rejection。
      // 传 L 过去是有意的：doNotes 靠它知道「写的是哪条录音的笔记」，
      // 不能靠 state.current —— 人可能早就切走了。
      doNotes(false, { auto: true, lecture: { ...L, status: 'transcribed' }, id });
    }
    // 转写前是人家自动把本地大模型停掉腾的显存 —— 这会儿转写完了，悄悄拉回来。
    // 不拉回来的话老大想点「AI 润色」还得自己等它重启。
    if (job.stoppedLLM) {
      ensureLocalLLM(null, true)
        .then((up) => {
          if (up) toast('本地大模型已自动恢复运行（生成笔记需使用）', 'ok', 3600);
        })
        .catch(() => {});
    }
  }
}

/* ============================ 笔记生成 ============================ */
/**
 * 这条录音的笔记设置：风格 + 每个主题几条重点。
 *
 * 从 2026-10-23 起这两个值是**每条录音自己的**（新建录音时问一遍，存在
 * meta.notePrefs 里），不再从设置面板读。之所以还留着 config.notes 这条路：
 * ① 老版本装过的人 config 里已经有值，直接丢了会让他们的笔记风格突变；
 * ② 没填过 notePrefs 的录音（比如示例、老录音）总得有个默认。
 */
function noteOptions(lecture = state.current?.lecture) {
  const c = state.config;
  const p = lecture?.notePrefs || {};
  const globalMax = Number(c.notes.maxPointsPerTopic) || 6;
  // 注意用 != null 判断：0 是「自适应」这个合法的约定值，不能被 || 吃掉。
  const mpt = p.maxPointsPerTopic != null ? Number(p.maxPointsPerTopic) : globalMax;
  return {
    style: p.style || c.notes.style,
    maxPointsPerTopic: Number.isFinite(mpt) ? mpt : 6,
    topKeywords: 20,
    title: lecture?.title,
    course: lecture?.course,
  };
}

/**
 * 这条录音自己的提示词。留空就退回设置里的通用要求 ——
 * 留空表示「跟全局一样」，不表示「什么要求都不要」，这样老用户
 * 在设置里写的「重点用【】标出」不会因为新建录音时没填就失效。
 */
function lectureExtraPrompt(lecture = state.current?.lecture) {
  const p = lecture?.notePrefs || {};
  const own = typeof p.extraPrompt === 'string' ? p.extraPrompt.trim() : '';
  return own || state.config.llm.extraPrompt || '';
}

/** 去掉体积巨大的中间字段，避免把 tokens 写进磁盘 */
function slimAnalysis(note) {
  const { sentences, transcriptText, markdown, ...rest } = note;
  return rest;
}

/**
 * 生成笔记。
 *
 * @param {boolean} useAI true = 走大模型（「AI 润色」），false = 离线引擎
 * @param {{auto?: boolean}} [opts] auto：转写完自动补的那一次。
 *   区别只有三点：① 这条录音没被打开也照跑（人可能早切走了，笔记照样得存下来）；
 *   ② 不抢「手动点了才该有」的反应（失败不当成大错误喊）；
 *   ③ 成功时换一句「笔记已自动生成」的文案，让人知道刚才那步不用自己点。
 */
async function doNotes(useAI = false, opts = {}) {
  const auto = !!opts.auto;
  // 自动生成时**不能**只认 state.current：转写要跑好几分钟，人很可能已经切去别的录音，
  // 这时候 state.current 和 currentTranscript() 全都是别人家的数据 ——
  // 拿它们去写这条录音的笔记，等于把 B 的逐字稿写进 A 的档案里。
  // 所以自动模式下按 id 把逐字稿重新读一遍，后面全程只用这份。
  let L = state.current?.lecture;
  let t = state.current?.transcript;
  if (auto) {
    L = opts.lecture || state.lectures.find((x) => x.id === opts.id) || null;
    if (!L) return; // 录音在转写期间被删了，没什么可写的
    const fresh = await api(`/lectures/${L.id}/transcript`).catch(() => null);
    t = fresh?.transcript || null;
  }
  const segs = t?.segments || [];
  if (!L || !segs.length) {
    if (!auto) toast('请先完成转写', 'err');
    return;
  }
  const id = L.id;
  const mine = jobs.get(id);
  if (mine) {
    // 自动那一次撞上任务槽是正常的（比如刚转写完又立刻点了手动生成），
    // 静默让位即可，不用弹「正在转写，请等它完成」—— 用户什么都没点，弹了只会莫名其妙。
    if (auto) return;
    return toast(mine.kind === 'transcribe' ? '这条录音正在转写，请等它完成' : '这条录音正在生成笔记', '', 4000);
  }
  if (useAI && !state.config.llm.enabled) {
    toast('尚未启用大模型笔记，请在设置中填写接口与 Key', 'err', 5000);
    openSettings();
    return;
  }
  const job = startJob(id, 'notes', { title: L.title || '未命名', label: '正在分析逐字稿…', pct: overallPct('', 8), stage: 'notes' });
  try {
    await new Promise((r) => setTimeout(r, 30));
    const meta = {
      title: L.title,
      course: L.course,
      // createdAt 以前漏传：llm.js 拿 meta.createdAt 当日期，漏了就只能空着，
      // 笔记顶部于是出现「日期： ｜ 时长： 未知」这种破相。
      createdAt: L.createdAt,
      // 时长三级兜底：录音列表里的 duration → 播放器实测 → 逐字稿最后一段的时间
      // （云端 SenseVoice 不给时间戳，这条只能靠前两级）。
      // 播放器实测那条只在「正开着这条录音」时才可信，自动模式下人可能已经切走，
      // 播放器里放的是别人的音频，量出来的时长也是别人的。
      duration:
        Number(L.duration) || (state.current?.lecture?.id === id ? Number($('audio').duration) : 0) || 0,
      engine: t?.engine,
      language: t?.language,
    };
    const note = analyze({ segments: segs, meta, options: noteOptions(L) });
    if (!note.ok) throw new Error(note.error || '分析失败');

    let markdown = note.markdown;
    let mode = 'offline';
    let model = '';

    if (useAI) {
      // 写笔记要用大模型，而转写时可能刚把它停掉去腾显存 —— 这里自动拉起来
      const ready = await ensureLocalLLM(id);
      if (!ready) toast('本地大模型未就绪，AI 润色可能生成失败', 'err', 5000);
      updateJob(id, { label: '正在调用大模型…', pct: overallPct('', 20), stage: 'notes' });
      const ac = jobs.get(id)?.abort || new AbortController();
      // 大模型只有一个：多条录音同时写笔记会把队列打满、还会互相抢上下文。
      // 这里排个队，后点的等前面写完再开始（进度栏仍然显示在各自录音上）。
      const out = await runSerial(() =>
        generateAINote({
          segments: segs,
          meta,
          analysis: note,
          options: { ...noteOptions(L), extraPrompt: lectureExtraPrompt(L) },
          onProgress: (m, p) => updateJob(id, { label: m, pct: overallPct('', p), stage: 'notes' }),
          signal: ac.signal,
        })
      );
      markdown = out.markdown;
      mode = 'llm';
      model = state.config.llm.model;
    } else {
      updateJob(id, { label: '正在整理成 Markdown…', pct: overallPct('', 80), stage: 'notes' });
    }

    const saved = await api(`/lectures/${L.id}/note`, {
      method: 'PUT',
      body: { markdown, data: slimAnalysis(note), mode, model },
    });
    if (state.current?.lecture?.id === id) {
      state.current.note = saved.note;
      if (saved.noteStatus) state.current.noteStatus = saved.noteStatus;
      renderNote();
    }
    await loadLectures();
    // 自动那一次换个说法：不让人以为「我刚才没点，怎么冒出笔记了」
    toast(
      `「${L.title || '未命名'}」` + (useAI ? 'AI 润色已生成' : auto ? '笔记已自动生成' : '笔记已生成'),
      'ok'
    );
  } catch (e) {
    // 自动那一次失败不喊得太凶（用户根本没触发它），但也不能装作成功 —— 提示还是要给
    const ttl = auto ? 4000 : 7000;
    if (String(e.message).includes('取消')) toast(`「${L.title || '未命名'}」已取消`, '');
    else toast(`「${L.title || '未命名'}」` + (auto ? '自动生成笔记失败：' : '生成笔记失败：') + e.message, 'err', ttl);
  } finally {
    endJob(id);
    if (state.current?.lecture?.id === id) $('btn-notes').classList.remove('primary');
  }
}

/* ============================ 上传 ============================ */
function uploadBlob(blob, filename, extra, onProgress) {
  return new Promise((resolve, reject) => {
    const q = new URLSearchParams({ title: extra.title || filename, filename, course: extra.course || '', duration: extra.duration || 0 });
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/lectures?' + q.toString());
    xhr.setRequestHeader('content-type', blob.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      try {
        const d = JSON.parse(xhr.responseText);
        d.ok ? resolve(d.lecture) : reject(new Error(d.error || '上传失败'));
      } catch {
        reject(new Error('上传返回异常'));
      }
    };
    xhr.onerror = () => reject(new Error('网络错误，上传失败'));
    xhr.send(blob);
  });
}

/** 用一个临时 <audio> 量出音频真实时长（秒），失败返回 0 */
function probeAudioDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const a = document.createElement('audio');
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(v) && v > 0 ? v : 0);
    };
    a.preload = 'metadata';
    a.onloadedmetadata = () => finish(a.duration);
    a.onerror = () => finish(0);
    setTimeout(() => finish(0), 8000);
    a.src = url;
  });
}

/* ======================= 新建录音（每条录音自己的笔记设置） ======================= */
/**
 * 三种笔记风格的名字与一句话说明。
 *
 * 名字只写短的（「提纲版」），说明单独放一行 —— 三条说明塞进 <option> 会让
 * 下拉变很宽，桌面端直接被截断成「提纲版 —— 层级提纲，」。
 * 这两个表在弹窗和侧栏那个「⋯」的提示语里共用，所以提到模块级。
 */
const STYLE_LABEL = { exam: '应试重点版', outline: '提纲版', cornell: '康奈尔版' };
const STYLE_DESC = {
  exam: '应试重点版：主题 + 重点 + 考点 + 自测题，考前突击用。',
  outline: '提纲版：层级提纲，方便快速回顾和背框架。',
  cornell: '康奈尔版：线索栏 / 笔记栏表格，适合课后整理。',
};

/**
 * 弹一次「新建录音」，让用户给这一条起名字、定笔记怎么写。
 *
 * 为什么不在设置里：这些设置**每条录音都不一样**。一门法学课要「法条编号写全」，
 * 一门高数课要「公式推导别跳步」，放在全局设置里就只能二选一。做成每条录音
 * 自己的，才能同一台电脑上两门课各用各的。
 *
 * 约定：用户取消就返回 null，调用方应当放弃这次上传（不要偷偷用默认值继续传，
 * 那样用户会以为「点了取消但还是传上去了」）。
 *
 * @param {{title?:string, subtitle?:string, showName?:boolean, prefs?:object}} opts
 *   showName=false 时藏掉名字框（示例录音的名字是写死的，不用问）
 *   prefs 只在「改已有录音」时给，用来把上次的选择填回去
 * @returns {Promise<{title:string, notePrefs:object}|null>}
 */
function openNewLecture(opts = {}) {
  const { title = '', subtitle = '', showName = true, prefs = null } = opts;
  const modal = $('new-lecture-modal');
  const nameIn = $('nl-title');
  const subEl = $('new-lecture-sub');

  nameIn.value = title;
  subEl.textContent = subtitle || '给这条录音起个名字，顺便定一下笔记怎么写。只有这一条录音会用到这些设置。';
  nameIn.closest('.field').hidden = !showName;
  $('new-lecture-title').textContent = prefs ? '笔记设置' : '新建录音';
  $('btn-nl-create').textContent = prefs ? '保存' : '创建';
  $('nl-hint').textContent = prefs
    ? '改完点保存。已经生成过的笔记不会自动重写 —— 想按新风格重做，保存后再点一次「重新生成笔记」或者「AI 润色」。'
    : '风格、重点条数、提示词都只对这条录音生效。以后想改，打开它点「笔记设置」。';

  // 改已有录音时把上次的选择填回去；新建时一律重置成「跟全局一样」，
  // 而不是记住上一条录音的选择 —— 上一门课要 10 条重点，这门课多半不需要。
  const p = prefs || {};
  $('nl-extra').value = typeof p.extraPrompt === 'string' ? p.extraPrompt : '';
  $('nl-style').value = p.style || state.config?.notes?.style || 'exam';
  $('nl-maxpoints').value = String(p.maxPointsPerTopic != null ? p.maxPointsPerTopic : 0);
  // 存的条数不在下拉列表里（比如老配置存的 6，列表里有；但用户手改过 config
  // 存了 7 就没有对应 option），select 会自动变成空值 —— 补一个临时项，
  // 否则用户一打开就发现自己的设置「变成自适应」了。
  const mSel = $('nl-maxpoints');
  if (mSel.value === '' && p.maxPointsPerTopic != null) {
    const o = document.createElement('option');
    o.value = String(p.maxPointsPerTopic);
    o.textContent = `${p.maxPointsPerTopic} 条 — 当前设置`;
    mSel.appendChild(o);
    mSel.value = String(p.maxPointsPerTopic);
  }

  // 风格下拉只写短标签（「提纲版」），说明放下面那行 —— 理由见 STYLE_DESC 的注释。
  const descEl = $('nl-style-desc');
  const syncDesc = () => (descEl.textContent = STYLE_DESC[$('nl-style').value] || '');
  $('nl-style').onchange = syncDesc;
  syncDesc();

  modal.hidden = false;
  // 名字框自动聚焦并全选：用户多半要改「课堂录音-20261023」这种自动名，
  // 全选之后直接打字就替换掉了，不用先按一遍退格。
  if (showName) {
    nameIn.focus();
    nameIn.select();
  } else {
    $('nl-extra').focus();
  }

  return new Promise((resolve) => {
    const onKey = (e) => {
      // 焦点在输入框里时全局的 Escape 处理器会直接 return（不抢输入框的键），
      // 所以这里自己接一个。不接的话用户按 Esc 会「什么都不发生」，
      // 而这个 promise 就永远悬着，上传流程卡在那儿。
      if (e.key === 'Escape') {
        e.stopPropagation();
        done(null);
      }
    };
    const done = (val) => {
      modal.hidden = true;
      $('btn-nl-cancel').onclick = null;
      $('btn-nl-create').onclick = null;
      nameIn.onkeydown = null;
      $('nl-style').onchange = null;
      modal.removeEventListener('keydown', onKey);
      resolve(val);
    };
    modal.addEventListener('keydown', onKey);
    $('btn-nl-cancel').onclick = () => done(null);
    $('btn-nl-create').onclick = () => {
      const name = nameIn.value.trim() || title || '未命名录音';
      done({
        title: name,
        notePrefs: {
          // 空串要存成空串（不是 undefined）：语义是「这条录音没自己的要求，
          // 用设置里的通用要求」，见 lectureExtraPrompt()。
          extraPrompt: $('nl-extra').value.trim(),
          style: $('nl-style').value,
          // 0 = 自适应，是个合法值，必须原样存下去，不能被 || 变成 6。
          maxPointsPerTopic: Number($('nl-maxpoints').value) || 0,
        },
      });
    };
    // 名字框里敲回车 = 点创建（这个框只有一行，回车没有别的含义）
    nameIn.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        $('btn-nl-create').click();
      }
    };
  });
}

/**
 * 手机模式（局域网打开）—— 只留上传。
 *
 * 老大的原话：「手机只负责上传录音，只保留上传功能，其他的也没什么用吧，
 * 其他功能在电脑上弄，那就去掉」。
 *
 * 判据是「这个请求是不是本机发出来的」，不是屏幕宽度：把桌面窗口拉窄
 * 也还是本机，转写/导出/设置全都打通，不该被削掉。而手机上不管横屏竖屏
 * 一律精简。
 *
 * 服务端 /health 的 local 字段是唯一的真相来源（手机访问时那边恒为 false）。
 * 万一 /health 没拿到（离线、启动早期），退回「宽度 + 看不到本机地址」两条
 * 都成立才认定，宁可少砍不要多砍 —— 判错了顶多是手机上多几个用不了的按钮，
 * 反过来则是电脑上莫名其妙少一半功能。
 */
function applyRemoteMode(health) {
  let remote = false;
  if (health && typeof health.local === 'boolean') {
    remote = !health.local;
  } else {
    const narrow = window.matchMedia?.('(max-width: 860px)')?.matches === true;
    const noLocalUrl = !window.location.hostname || window.location.hostname !== '127.0.0.1';
    remote = narrow && noLocalUrl;
  }
  state.remote = remote;
  document.body.classList.toggle('remote', remote);
  if (remote) document.title = '上传课堂录音 · 讲义笔记';
  return remote;
}

/** 手机上传完只提示一句、刷新列表，不跳详情 —— 详情里全是手机上干不了的事 */
function toastUploadedOnPhone(title) {
  toast(`已上传：${title}。去电脑上打开「讲义笔记」就能转写和生成笔记了。`, 'ok', 6000);
}

/** 把 notePrefs 写进这条录音的 meta（服务端 PATCH 允许任意字段） */
async function saveNotePrefs(id, notePrefs) {
  if (!notePrefs) return;
  try {
    const d = await api(`/lectures/${id}`, { method: 'PATCH', body: { notePrefs } });
    // 如果是当前这条，顺手把内存里的也换掉，免得紧接着点「生成笔记」
    // 还用着旧的风格（要等下次 openLecture 才刷新就太晚了）。
    if (state.current?.lecture?.id === id && d?.lecture) state.current.lecture = d.lecture;
  } catch (e) {
    // 偏好存不上不该让整条录音变成「导入失败」：音频已经在盘上了，
    // 顶多是笔记按默认风格生成。所以只提示，不中断。
    toast('录音已保存，但笔记设置没存上（' + e.message + '），这条会用默认风格', 'err', 6000);
  }
}

/**
 * 改某条录音的笔记设置（风格 / 重点条数 / 提示词 / 名字）。
 *
 * 两个入口共用：详情页工具栏那个「笔记设置」，和侧栏每一行的「⋯（编辑）」。
 * 不传 id 就改当前打开的那条。只改偏好，不动已有笔记 —— 用户可能只是想
 * 先把设置调对，等下次再重新生成。
 */
async function editNotePrefs(id) {
  const L = id ? state.lectures.find((l) => l.id === id) : state.current?.lecture;
  if (!L) return toast('先打开一条录音', 'err');
  const isCurrent = state.current?.lecture?.id === L.id;
  const pick = await openNewLecture({
    title: L.title || '未命名',
    subtitle: isCurrent
      ? '这条录音自己的笔记设置。名字也能在这里改。'
      : `「${L.title || '未命名'}」的笔记设置。名字也能在这里改。`,
    prefs: L.notePrefs || {},
  });
  if (!pick) return;
  try {
    const d = await api(`/lectures/${L.id}`, { method: 'PATCH', body: { notePrefs: pick.notePrefs, title: pick.title } });
    if (isCurrent) {
      if (d?.lecture) state.current.lecture = d.lecture;
      $('d-title').textContent = pick.title;
    }
    await loadLectures();
    renderList();
    // 只改偏好不动已有笔记，所以得告诉人下一步该按哪个按钮 ——
    // 否则改完风格回来看笔记没变，会以为没保存成功。
    toast((isCurrent ? '笔记设置已保存' : `「${pick.title}」的笔记设置已保存`) + '，点「重新生成笔记」按新设置重做', 'ok', 6000);
  } catch (e) {
    toast('保存失败：' + e.message, 'err');
  }
}

/**
 * 把「这条录音的笔记设置」写成一句话，给侧栏那个 ⋯ 按钮的 title 用。
 *
 * 光写「笔记设置」四个字，用户还是不知道笔记是按哪套规矩生成的 ——
 * 而「为什么我的笔记长得跟我同学的不一样」正是最常被问的问题。
 * 所以悬停时直接把当前风格和重点密度说出来。
 */
function notePrefsLabel(l) {
  const p = l?.notePrefs || {};
  const g = state.config?.notes || {};
  const style = p.style || g.style || 'exam';
  const name = STYLE_LABEL[style] || style;
  // 0 = 自适应，是合法值，不能被 || 吃掉。
  const mpt = p.maxPointsPerTopic != null ? Number(p.maxPointsPerTopic) : Number(g.maxPointsPerTopic) || 6;
  return `${name} · ${mpt > 0 ? mpt + ' 条重点' : '自适应'}`;
}

async function handleFiles(files) {
  const list = [...files];
  if (!list.length) return;

  // 先问一遍再上传。多个文件时只问一次（一个个问太烦），名字按各自的文件名走，
  // 笔记设置套用到这一批全部 —— 同一批拖进来的通常就是同一门课。
  const firstTitle = list[0].name.replace(/\.[^.]+$/, '').slice(0, 80);
  const pick = await openNewLecture({
    title: firstTitle,
    // 手机上只问名字，不问笔记设置（那几项在手机弹窗里是藏起来的，见 .phone-hide）
    subtitle: state.remote
      ? list.length > 1
        ? `把这 ${list.length} 个文件传到电脑上。起个名字就行，笔记怎么写在电脑上定。`
        : '把这条录音传到电脑上。起个名字就行，笔记怎么写在电脑上定。'
      : list.length > 1
        ? `这次要导入 ${list.length} 个文件。笔记风格和提示词会套用到这一批全部；录音名仍按各文件名走。`
        : '',
  });
  if (!pick) return; // 用户点了取消 → 一个都不传

  let last = null;
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    try {
      progress(true, `正在上传 ${f.name}（${i + 1}/${list.length}）…`, 0);
      // 单文件用用户起的名字；批量时按各自文件名，否则 N 条录音会撞成同一个名字。
      const title = list.length === 1 ? pick.title : f.name.replace(/\.[^.]+$/, '').slice(0, 80);
      // 上传时就把真实时长量出来一起存：以前传 0，导致详情页不显示时长、
      // 笔记顶部写「时长： 未知」、云端转写也摊不出时间戳。
      const duration = await probeAudioDuration(f);
      const meta = await uploadBlob(f, f.name, { title, duration }, (p) =>
        progress(true, `正在上传 ${f.name}… ${Math.round(p * 100)}%`, p * 100)
      );
      // 手机上没弹那两项设置（弹窗里是藏起来的），存回去的会是默认值 ——
      // 这会覆盖用户在电脑上给这条录音设过的偏好。所以只在非手机模式存。
      if (!state.remote) await saveNotePrefs(meta.id, pick.notePrefs);
      last = meta;
      if (state.remote) toastUploadedOnPhone(title);
      else toast(`已导入：${title}`, 'ok');
    } catch (e) {
      toast(`导入失败（${f.name}）：${e.message}`, 'err', 6000);
    }
  }
  progress(false);
  // 上传是「一次性动作」，用完就把进度栏还给当前录音自己的任务
  // （不能因为刚上传完就把正在转写的那条的进度栏一起关掉）。
  renderJobProgress();
  await loadLectures();
  // 手机上不跳详情：那边只有一条录音的转写/笔记/导出，全都要在电脑上做，
  // 跳过去等于把人引到一个只有灰按钮的页面。留在首屏继续传下一个更合理。
  if (last && !state.remote) openLecture(last.id);
}

/** 生成一段静音 WAV，用于示例（让播放器和时间轴能真实工作） */
function makeSilentWav(seconds, rate = 8000) {
  const n = Math.floor(seconds * rate);
  const buf = new ArrayBuffer(44 + n);
  const dv = new DataView(buf);
  const wr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  wr(0, 'RIFF'); dv.setUint32(4, 36 + n, true); wr(8, 'WAVE'); wr(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true);
  wr(36, 'data'); dv.setUint32(40, n, true);
  for (let i = 0; i < n; i++) dv.setUint8(44 + i, 128);
  return new Blob([buf], { type: 'audio/wav' });
}

const DEMO = [
  [0, 32, '好，那我们今天接着讲二叉树的遍历。上节课我们讲了树的基本概念，大家还记得吧，树是由 n 个结点组成的有限集合。'],
  [32, 78, '先明确一个定义：所谓二叉树的遍历，是指按照某种规则依次访问树中每个结点，并且每个结点只访问一次的过程。这个是今天的重点，考试一定会考。'],
  [78, 140, '那么遍历主要有四种方式，第一种是先序遍历，顺序是根、左、右；第二种是中序遍历，顺序是左、根、右；第三种是后序遍历，顺序是左、右、根；第四种是层序遍历，也就是一层一层从左到右访问。'],
  [140, 196, '这里特别要注意的是，中序遍历在二叉搜索树上的结果一定是一个递增序列，这个性质非常关键，经常用来判断一棵树是不是二叉搜索树，大家一定要记住。'],
  [196, 250, '举个例子，假设根节点是 5，左子树是 3，右子树是 8，那么中序遍历的结果就是 3, 5, 8，可以看到它确实是递增的。'],
  [250, 310, '接下来我们看遍历的实现。因为树本身是递归定义的，所以递归实现是最自然的，先序遍历的代码就是先访问根节点，然后递归遍历左子树，再递归遍历右子树，三行代码就写完了。'],
  [310, 372, '但是递归有一个问题，就是当树很深的时候会导致栈溢出，所以实际工程中我们往往用非递归的方式，也就是借助栈来模拟递归过程，把递归改成迭代。'],
  [372, 430, '非递归的先序遍历思路是：第一，把根节点入栈；第二，弹出栈顶元素并访问；第三，如果右孩子不为空就入栈；第四，如果左孩子不为空就入栈。注意顺序不能反，因为栈是后进先出。'],
  [430, 490, '那么为什么先入右孩子再入左孩子呢？因为栈是后进先出，我们希望左孩子先被访问，所以左孩子要后入栈，这样它就在栈顶。这个地方很容易搞错，考试的时候很多同学都在这里丢分。'],
  [490, 545, '我们再来看看时间复杂度。不管哪种遍历方式，每个结点都恰好被访问一次，所以时间复杂度都是 O(n)，空间复杂度取决于树的高度，最坏情况下是 O(n)，平均是 O(log n)。'],
  [545, 600, '最后总结一下今天的重点：第一，四种遍历方式的访问顺序必须背下来；第二，中序遍历二叉搜索树得到递增序列这个性质要会用；第三，递归和非递归两种实现都要会写。'],
  [600, 650, '作业是课后习题 6.3 到 6.8，下周三之前提交到学习通，另外预习一下线索二叉树的内容，下次课我们讲。'],
  [650, 690, '好，那今天就到这里，下课。'],
];

async function loadDemo() {
  try {
    progress(true, '正在创建示例…', 20);
    const blob = makeSilentWav(690);
    const meta = await uploadBlob(blob, '示例-数据结构-二叉树的遍历.wav', { title: '示例 · 数据结构 · 二叉树的遍历', course: '数据结构', duration: 690 }, () => {});
    const segments = DEMO.map(([start, end, text]) => ({ start, end, text }));
    await api(`/lectures/${meta.id}/transcript`, {
      method: 'PUT',
      body: { language: 'zh', engine: 'demo', model: '示例数据', text: segments.map((s) => s.text).join('\n'), segments, duration: 690 },
    });
    await loadLectures();
    await openLecture(meta.id);
    progress(false);
    await doNotes(false);
    toast('示例已就绪：可点击笔记中的时间戳回放核对', 'ok', 5000);
  } catch (e) {
    progress(false);
    renderJobProgress();
    toast('创建示例失败：' + e.message, 'err');
  }
}

/* ============================ 录音 ============================ */
const rec = { mr: null, chunks: [], startedAt: 0, timer: null, stream: null, ctx: null, raf: 0, cancelled: false };

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true, channelCount: 1 },
    });
    rec.stream = stream;
    rec.chunks = [];
    rec.cancelled = false;
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((m) => MediaRecorder.isTypeSupported?.(m)) || '';
    rec.mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    rec.mr.ondataavailable = (e) => e.data.size && rec.chunks.push(e.data);
    rec.mr.start(1000);
    rec.startedAt = Date.now();
    $('record-modal').hidden = false;
    rec.timer = setInterval(() => {
      const s = Math.floor((Date.now() - rec.startedAt) / 1000);
      $('rec-timer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    }, 500);
    drawWave(stream);
    toast('开始录音', 'ok', 1500);
  } catch (e) {
    toast('无法访问麦克风：' + e.message + '（http 页面或权限被拒绝时会出现此情况，可改用手机录音后导入）', 'err', 7000);
  }
}

function drawWave(stream) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  rec.ctx = ctx;
  const src = ctx.createMediaStreamSource(stream);
  const an = ctx.createAnalyser();
  an.fftSize = 1024;
  src.connect(an);
  const data = new Uint8Array(an.frequencyBinCount);
  const cv = $('rec-wave');
  const g = cv.getContext('2d');
  const draw = () => {
    rec.raf = requestAnimationFrame(draw);
    an.getByteTimeDomainData(data);
    const w = cv.width, h = cv.height;
    g.clearRect(0, 0, w, h);
    g.strokeStyle = getComputedStyle(document.body).color || '#3b6ef6';
    g.globalAlpha = 0.85;
    g.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = (i / data.length) * w;
      const y = h / 2 + ((data[i] - 128) / 128) * (h / 2 - 4);
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
  };
  draw();
}

function stopRecording(save) {
  if (!rec.mr) return;
  rec.cancelled = !save;
  const mr = rec.mr;
  mr.onstop = async () => {
    clearInterval(rec.timer);
    cancelAnimationFrame(rec.raf);
    try { rec.ctx?.close(); } catch {}
    rec.stream?.getTracks().forEach((t) => t.stop());
    $('record-modal').hidden = true;
    rec.mr = null;
    if (rec.cancelled || !rec.chunks.length) return;
    const type = rec.chunks[0].type || 'audio/webm';
    const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
    const blob = new Blob(rec.chunks, { type });
    const secs = Math.round((Date.now() - rec.startedAt) / 1000);
    const name = `课堂录音-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.${ext}`;
    // 录音已经录完了，但还没传到盘上：这时候问名字和笔记设置最合适（不用先传
    // 一遍再改名）。点取消就整条丢掉 —— 名字都给了「丢弃」的暗示了，
    // 用户刚点的也是「停止并保存」，取消在这里的语义是「这条不要了」。
    const pick = await openNewLecture({
      title: name.replace(/\.[^.]+$/, ''),
      subtitle: `录了 ${Math.floor(secs / 60)} 分 ${secs % 60} 秒。接下来要传到电脑上，先给这条起个名字。`,
    });
    if (!pick) {
      toast('这条录音已丢弃', 'err');
      return;
    }
    try {
      progress(true, '正在保存录音…', 10);
      const meta = await uploadBlob(blob, name, { title: pick.title, duration: secs }, (p) => progress(true, `保存中 ${Math.round(p * 100)}%`, p * 100));
      await saveNotePrefs(meta.id, pick.notePrefs);
      await loadLectures();
      await openLecture(meta.id);
      toast('录音已保存，可开始转写', 'ok');
    } catch (e) {
      toast('保存失败：' + e.message, 'err');
    } finally {
      // 收尾时把进度栏交还给「当前录音自己的任务」，
      // 否则保存录音会把一条正在云端转写的进度栏一起关掉。
      progress(false);
      renderJobProgress();
    }
  };
  mr.stop();
}

/* ============================ 设置 ============================ */
/**
 * 把服务商注册表铺进设置界面。
 * 目标：低配电脑的同学只要「选一个服务商 → 粘一个 Key」，不用自己查地址、抄模型名。
 */
function fillProviderOptions() {
  const sel = $('s-provider');
  if (!sel || sel.dataset.filled) return;
  sel.dataset.filled = '1';
  // 现在四家全部是「转写 + 笔记都能做」，所以不再需要标「仅转写 / 仅笔记」——
  // 那行小字本来是帮用户判断「这家能不能干这个活」，四家都能干之后
  // 就只剩干扰。HTML 里第一条「本地」是写死的，这里从第二条开始补。
  for (const p of allProviderEntries()) {
    if (p.id === 'local') continue; // 本地项 HTML 里已经写好
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.tag ? `${p.name} · ${p.tag}` : p.name;
    sel.appendChild(opt);
  }
}

/** 合并下拉要用到的全部服务商（asr + both + llm，去重） */
function allProviderEntries() {
  const seen = new Set();
  const out = [];
  for (const p of [...optionsFor('asr'), ...optionsFor('llm')]) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

/** 「整理一节课大概花多少钱」的粗略提示；没写单价的返回空串 */
function costHintFor(id) {
  try {
    const e = estimateCost(id, defaultModel(id, 'llm'), 1.5);
    if (!e) return '';
    const y = e.yuan;
    return `整理 1.5 小时的课约 ${y < 0.01 ? '不到 1 分钱' : y.toFixed(2) + ' 元'}（按 ${e.model} 估算，仅量级参考）`;
  } catch {
    return '';
  }
}

/**
 * 合并下拉（老大要求：转写和 AI 笔记用同一家服务商，一把 Key 两处都用）。
 *
 * 2026-10-21 起四家服务商全部「两样都能做」，所以不再有「这家只做转写」
 * 「这家只做笔记」的分支 —— 但 local 仍然特殊：它的转写不走服务端代理
 * （在浏览器里跑），地址和 Key 都没有，所以 asrP 特意置空。
 *
 * - asr.provider：照抄下拉。本地就是 local，云端四家都是同一家
 * - llm.provider：同一家。local 也有本地大模型那一档，所以不再留空
 * - 提示拆两处：s-provider-hint 讲转写侧，s-llm-hint 讲笔记侧
 * - force：用户手动切换下拉时，把预设地址/模型摊进输入框，别留上一家的残留
 */
function applyProvider(id, { force = false } = {}) {
  const isLocal = id === 'local';
  // 本地转写没有地址、不需要 Key，所以对「转写侧」按没有服务商处理
  const asrP = isLocal ? null : getProvider(id, 'asr');
  const llmP = getProvider(id, 'llm');
  const hint = $('s-provider-hint');
  const llmHint = $('s-llm-hint');

  // —— 转写侧 ——
  const asrBits = [];
  if (isLocal) {
    asrBits.push(
      '转写走本地 Whisper（在浏览器里跑）：免费、录音不出本机。代价：首次要下几百 MB 到 1.3GB 模型，转写时吃内存和显卡；电脑配置一般会明显卡顿。'
    );
  } else if (asrP) {
    if (asrP.note) asrBits.push(asrP.note);
    if (asrP.free) asrBits.push('新用户通常有免费额度。');
    // 自定义服务商的地址是用户手填的，不在这里再说一次（下面就有输入框）
    if (id !== 'custom') {
      const url = asrP.asrUrl || asrP.baseUrl || '';
      if (url) asrBits.push(`转写接口：${url}`);
    }
    // 模型不在这里重复列 —— 下面就是卡片选择器，同一句话说两遍反而看不清重点。
  } else {
    asrBits.push('这家没有语音转写接口：转写会自动退回「本地」');
  }
  if (hint) hint.textContent = asrBits.join(' ');

  // —— 笔记侧 ——
  if (llmHint) {
    if (isLocal) {
      llmHint.textContent =
        '笔记用本机大模型 qwen2.5-7b：不联网、不花钱，但常驻要 6GB 左右显存。需要先在 ⑥ 环境自检里部署本地模型（共约 4.4GB）；没部署时「AI 润色」会自动退回离线引擎挑重点。';
    } else if (llmP) {
      const bits = [];
      if (llmP.free) bits.push('新用户通常有免费额度。');
      const cost = costHintFor(id);
      if (cost) bits.push(cost);
      if (llmP.console) bits.push(`申请地址：${llmP.console}`);
      bits.push('申请步骤看上面①的「怎么申请服务商」。');
      llmHint.textContent = bits.join(' ');
    } else {
      llmHint.textContent = '这家不支持大模型笔记；「AI 润色」会退回本机离线引擎。';
    }
  }

  // —— 输入框自动填充 ——
  const base = $('s-llm-base');
  if (base && (force || !base.value.trim() || base.dataset.auto)) {
    base.value = llmP ? llmP.baseUrl || '' : '';
    base.dataset.auto = '1';
  }

  // 手动切换服务商时，模型必须跟着换成新这家的预设 ——
  // 否则会把上一家的模型名带到新服务商上（硅基流动收到 whisper-1 只会 400）。
  // 用户自己填过的（dataset.auto 不是 '1'）不动，那是他的选择。
  if (force) {
    const ep = $('s-asr-endpoint');
    if (ep) ep.value = isLocal || id === 'custom' ? '' : asrP ? asrP.asrUrl || asrP.baseUrl || '' : '';
    const asrIn = $('s-asr-model');
    if (asrIn) {
      asrIn.value = isLocal || id === 'custom' ? '' : defaultModel(id, 'asr') || '';
      asrIn.dataset.auto = '1';
    }
    const llmIn = $('s-llm-model');
    if (llmIn) {
      llmIn.value = llmP ? defaultModel(id, 'llm') || '' : '';
      llmIn.dataset.auto = '1';
    }
  }

  // 转写模型：本地走「本地模型」那组卡片（值存在 asr.localModel），
  // 云端走「转写模型」那组（值存在 asr.model）。两组卡片互斥显示。
  if (isLocal) renderModelPicker('local-whisper');
  else renderModelPicker('asr');
  renderModelPicker('llm');
}

/* ---------------------- 模型选择器（免费 / 性价比 / 更强） ---------------------- */

/**
 * 三组卡片的统一描述。
 *
 * 为什么把三组写成一个表：三处的行为一模一样（铺卡片、同步选中态、切到手填框），
 * 只是数据来源和存的地方不同。写成三份迟早会漏掉某一处的同步 —— 之前
 * 「asr 换了模型但提示没更新」就是这么来的。
 *
 *   kind    'asr' | 'llm' | 'local-whisper'
 *   listId  卡片容器的 id
 *   customId 手填框容器的 id
 *   inputId 手填输入框的 id（真正的值从这读）
 *   nowId   标题右边那行「现在用：xxx」的 id
 */
const MODEL_PICKERS = [
  { kind: 'asr', listId: 'asr-model-list', customId: 'asr-model-custom', inputId: 's-asr-model', nowId: 'asr-model-now', label: '转写模型' },
  { kind: 'llm', listId: 'llm-model-list', customId: 'llm-model-custom', inputId: 's-llm-model', nowId: 'llm-model-now', label: '笔记模型' },
  { kind: 'local-whisper', listId: 'local-model-list', customId: 'local-model-custom', inputId: 's-local-model', nowId: 'local-model-now', label: '本地模型' },
];

/** 某个选择器当前该显示哪些候选、当前选的是哪个 */
function pickerSource(kind) {
  if (kind === 'local-whisper') {
    // 本地的候选列表在 HTML 里没有第二份，统一从注册表的 local 项取，
    // 免得 datalist 和注册表两处写着写着就分叉。
    return { providerId: 'local', models: sortedModels('local', 'asr'), current: $('s-local-model').value.trim() };
  }
  const pid = $('s-provider').value;
  return { providerId: pid, models: sortedModels(pid, kind), current: $(kind === 'asr' ? 's-asr-model' : 's-llm-model').value.trim() };
}

/**
 * 铺一个模型选择器。
 *
 * 两个必须做到的事：
 *   1) 当前用的那个要**一眼看出来**（否则用户填完 Key 还是不知道自己调的什么）
 *   2) 用户填的是预设之外的模型名时，不能假装认识它，也不能把它悄悄改掉 ——
 *      中转站/自建服务常见自定义模型名，改掉就等于把用户的配置吃掉了。
 */
function renderModelPicker(kind) {
  const conf = MODEL_PICKERS.find((c) => c.kind === kind);
  if (!conf) return;
  const listEl = $(conf.listId);
  const inputEl = $(conf.inputId);
  if (!listEl || !inputEl) return;
  const { providerId, models, current } = pickerSource(kind);
  const nowEl = $(conf.nowId);
  const customBox = $(conf.customId);

  const known = models.find((m) => m.id === current) || null;
  const isCustom = !!current && !known;

  // 标题右边：现在用的是什么。空值时别写「未选择」这种吓人的话 ——
  // 留空在 asr 侧是合法状态（服务端会补预设默认值）。
  if (nowEl) {
    if (current) nowEl.textContent = known ? `现在用：${known.label}` : `现在用：${current}（自定义）`;
    else nowEl.textContent = models.length ? `现在用：${models[0].label}（默认）` : '';
  }

  listEl.innerHTML = '';
  if (!models.length) {
    // 「自定义」服务商没有预设模型：直接把手填框摊开，别给空列表
    if (customBox) customBox.hidden = false;
    return;
  }

  const makeCard = (spec) => {
    const tier = spec.tier && TIERS[spec.tier] ? TIERS[spec.tier] : null;
    // 本地这家的卡片不贴标签（老大 2026-11-03：「这个就不用打标签了去掉标签」）。
    // 理由：本地转写四档、本地笔记两档，标签全是同一个「零成本」，
    // 重复几遍等于没说；它们真正的差别 ——要不要显卡/显存多少/内存多大
    // ——已经由下面那行配置推荐讲清了。
    // 云端的档位徽章保留：那里 free / 便宜·够用 / 便宜·好用 / 偏贵·更好
    // 确实在区分真实的钱和质量，撤掉等于把当初为「能比价」加的东西又拆了。
    const plainCard = kind === 'local-whisper' || providerId === 'local';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'model-item' + (spec.id === current ? ' on' : '');
    btn.dataset.modelId = spec.id;

    const dot = document.createElement('span');
    dot.className = 'model-dot';

    const main = document.createElement('span');
    main.className = 'model-main';
    const nameRow = document.createElement('span');
    nameRow.className = 'model-name';
    nameRow.textContent = spec.label || spec.id;
    if (tier && !plainCard) {
      const badge = document.createElement('span');
      badge.className = 'tier tier-' + spec.tier;
      badge.textContent = tier.label;
      nameRow.appendChild(badge);
    }
    // 「作者推荐」是背书，不是档位，所以单独一个小标签跟在档位后面。
    // 老大 2026-10-29 点名要的（当时推荐的是 DeepSeek-V3）。本地这家不贴。
    if (spec.recommended && !plainCard) {
      const rec = document.createElement('span');
      rec.className = 'rec';
      rec.textContent = '作者推荐';
      nameRow.appendChild(rec);
    }
    main.appendChild(nameRow);

    // 第二行：只放一句质量说明（价格由档位徽章负责，具体金额在教程第七章）。
    // priceNote 现在只剩「模型多大」这类硬事实，本地 Whisper 那几张才有。
    // paramNote 是 2026-11-11 给本地 Whisper 补的参数量（74M / 244M / 809M）——
    // Qwen 那边的型号名自带「3b/7b」，Whisper 的名字（tiny/base/small）一个
    // 数字都没有，光看体积还是不知道它多小。
    const subBits = [spec.priceNote, spec.paramNote, spec.qualityNote].filter(Boolean);
    if (subBits.length) {
      const sub = document.createElement('span');
      sub.className = 'model-sub';
      sub.textContent = subBits.join(' · ');
      main.appendChild(sub);
    }

    // 第三行：推荐配置（要不要显卡、显存内存多大）。
    // 为什么不并进上一行：那一行限 14 字、只讲质量（老大定的），
    // 而「独立显卡 6GB+ · 内存 16GB」是另一维的信息，两者挤一起谁都读不清。
    // 老大 2026-11-03 把这一行从「实测耗时」改成「配置推荐」，原话：
    // 「底下的小字就不要标速度了，标出配置推荐，什么GPU，内存多少」。
    // 耗时数据没丢，留在 providers.js 里每档上方那段实测表注释中。
    const noteRow = spec.reqNote || spec.speedNote;
    if (noteRow) {
      const spd = document.createElement('span');
      spd.className = 'model-speed';
      spd.textContent = noteRow;
      main.appendChild(spd);
    }

    btn.append(dot, main);
    btn.addEventListener('click', () => {
      inputEl.value = spec.id;
      inputEl.dataset.auto = '1';
      if (customBox) customBox.hidden = true;
      renderModelPicker(kind);
      if (kind !== 'local-whisper') applyProvider($('s-provider').value);
    });
    return btn;
  };

  for (const m of models) listEl.appendChild(makeCard(m));

  // 「其他」卡：手填。只在当前值确实不在预设里时才默认展开，
  // 否则用户会以为必须自己填。
  const other = document.createElement('button');
  other.type = 'button';
  other.className = 'model-item' + (isCustom ? ' on' : '');
  const odot = document.createElement('span');
  odot.className = 'model-dot';
  const omain = document.createElement('span');
  omain.className = 'model-main';
  const oname = document.createElement('span');
  oname.className = 'model-name';
  oname.textContent = '其他（自己填）';
  // 本地那组连「其他」卡也不贴徽章，否则四张光卡后面挂一个有徽章的，
  // 反而像「这张才是正品」。名字里已经写了「自己填」，不缺这个提示。
  if (kind !== 'local-whisper') {
    const obadge = document.createElement('span');
    obadge.className = 'tier tier-custom';
    obadge.textContent = '自定义';
    oname.appendChild(obadge);
  }
  omain.appendChild(oname);
  const osub = document.createElement('span');
  osub.className = 'model-sub';
  osub.textContent = '服务商文档里写了别的型号，或用的是自建/中转站接口';
  omain.appendChild(osub);
  other.append(odot, omain);
  other.addEventListener('click', () => {
    if (customBox) {
      customBox.hidden = false;
      inputEl.focus();
    }
  });
  listEl.appendChild(other);

  if (customBox) customBox.hidden = !isCustom;
}

/**
 * 云端 API 接入教程弹窗。
 *
 * 教程正文放在 public/api-tutorial.md（跟着服务端一起发出去，不打包进 JS），
 * 这样改文案不用动代码。kind='asr' 时只显示「转写」那一段，kind='llm' 只显示
 * 「笔记」那一段 —— 一次只谈正在做的那一件事，别让用户在一屏十家里找自己那家。
 */
async function showApiTutorial(kind = 'llm') {
  const box = $('api-body');
  $('api-modal').hidden = false;
  const title = kind === 'asr' ? '转写服务商怎么申请' : kind === 'llm' ? 'AI 笔记服务商怎么申请' : '服务商怎么申请（转写 + AI 笔记）';
  box.innerHTML = `<p class="hint">正在读取教程…</p>`;
  let md = '';
  try {
    const r = await fetch('./api-tutorial.md', { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    md = await r.text();
  } catch (e) {
    box.innerHTML =
      `<p class="hint">教程文件没读出来（${e.message}）。文件在 <code>lecture-notes/public/api-tutorial.md</code>，` +
      `完整版在 <code>lecture-notes/docs/API接入教程.md</code>，直接用记事本也能看。</p>`;
    return;
  }
  // kind='all'（合并下拉的教程按钮）：转写和笔记是同一家，全文都给，别挑段
  const picked = kind === 'all' ? md : pickTutorialSection(md, kind);
  box.innerHTML =
    `<h4>${title}</h4>` +
    renderMarkdown(picked) +
    `<hr><p class="hint">教程跟着软件走，不会自己更新。价格和免费额度以服务商官网为准（本教程核对日期：${PROVIDER_VERSION}）。</p>`;
}

/**
 * 从教程 markdown 里挑出与 kind 相关的那部分。
 * 教程用「## 」分节，约定：出现「转写」字样的节给 asr 看，出现「笔记」的给 llm 看，
 * 「通用」「三步」「选择」「常见问题」两类都保留。挑不出来就把全文给出去，
 * 宁可多给也别给一片空白。
 */
function pickTutorialSection(md, kind) {
  const lines = md.split('\n');
  const blocks = [];
  let cur = [];
  for (const line of lines) {
    if (/^#{1,2}\s/.test(line) && cur.length) {
      blocks.push(cur);
      cur = [];
    }
    cur.push(line);
  }
  if (cur.length) blocks.push(cur);

  const keep = blocks.filter((b) => {
    const head = b.find((l) => /^#{1,2}\s/.test(l));
    if (!head) return true; // 开头的说明段落，保留
    const h = head.replace(/^#{1,2}\s*/, '');
    const isAsr = /转写|语音|录音/.test(h);
    const isLlm = /笔记|大模型|文本/.test(h);
    if (isAsr && !isLlm) return kind === 'asr';
    if (isLlm && !isAsr) return kind === 'llm';
    return true; // 两家都相关的（选择指南、通用步骤、常见问题）
  });
  if (keep.length < 2) return md;
  return keep.map((b) => b.join('\n')).join('\n\n');
}

/**
 * 渲染「已保存的 Key」清单。
 *
 * 布局跟老大的草图一致：上面一行是当前正在用的那把（输入框 + 眼睛 + 对勾），
 * 下面每一行是一把存过的 Key，点那一行就把它填进输入框（再点保存才真正切过去），
 * 这样用户不用重新粘贴，也不用先把正在用的换掉再换回来。
 *
 * 局域网/手机上服务端不回明文，那种情况点一行只会提示「在本机操作」。
 * 当前用的那条靠 .is-current 加竖条和底色区分。
 */
function renderKeyVault(list) {
  const box = $('key-list');
  const hint = $('key-hint');
  state.keyVault = list || [];
  if (!box) return;

  const cur = ($('s-key').value || '').trim();

  box.innerHTML = '';
  if (!state.keyVault.length) {
    box.hidden = true;
    if (hint) hint.textContent = '还没有存过 Key。粘贴一把点对勾，以后换服务商可以直接从下面选回来。';
    return;
  }
  box.hidden = false;
  for (const v of state.keyVault) {
    const isCur = !!(v.key && cur && v.key === cur);
    const row = document.createElement('div');
    row.className = 'key-item' + (isCur ? ' is-current' : '');

    const mask = document.createElement('span');
    mask.className = 'ki-mask';
    // 真的 Key 只显示前 6 位 + 后 4 位，中间全用圆点 —— 就算被人瞄一眼屏幕也拿不走。
    mask.textContent = v.masked || (v.key ? v.key.slice(0, 6) + '••••' + v.key.slice(-4) : '••••••');
    if (isCur) mask.title = '当前正在用这把';

    const nm = document.createElement('span');
    nm.className = 'ki-name';
    nm.textContent = v.label || '（未命名）';

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'linklike danger ki-del';
    del.textContent = '删除';
    del.onclick = (e) => {
      e.stopPropagation(); // 别让点删除顺带把这一行当成「切换」
      deleteKeyFromVault(v.id);
    };

    // 用 appendChild 而不是 append：tests/dom-app-test.mjs 的 DOM 影子层
    // 只实现了 appendChild，用 append 会让「打开设置」那一步在测试里抛异常。
    row.appendChild(mask);
    row.appendChild(nm);
    row.appendChild(del);
    row.onclick = () => pickVaultKey(v);
    box.appendChild(row);
  }
  if (hint) hint.textContent = `已存 ${state.keyVault.length} 把。点下面任意一把可以切过去，删掉的那把不影响正在用的。`;
}

/** 点清单里的某一行 → 填进输入框（真正切换要再点「保存设置」） */
function pickVaultKey(item) {
  if (!item) return;
  if (!item.key) {
    // 局域网/手机：服务端只回掩码，没明文可填
    toast('这台设备看不到 Key 原文，请在本机操作', 'err');
    return;
  }
  $('s-key').value = item.key;
  renderKeyVault(state.keyVault); // 重画一次，让竖条跟着挪过去
  toast('已选好，点「保存」才会切过去', 'ok');
}

/** 从清单里删掉一把（只删清单，不动正在用的那把） */
async function deleteKeyFromVault(id) {
  const item = (state.keyVault || []).find((v) => v.id === id);
  if (!confirm(`从清单里删掉这把 Key？\n\n${item?.label || ''}\n\n只是不再出现在下拉里，正在用的那把不受影响。`)) return;
  try {
    const data = await api('/keys?id=' + encodeURIComponent(id), { method: 'DELETE', body: {} });
    state.keyVault = data.keys || [];
    renderKeyVault(state.keyVault);
    toast('已从清单移除', 'ok');
  } catch (e) {
    toast('删除失败：' + e.message, 'err');
  }
}

async function openSettings() {
  const c = state.config;
  fillProviderOptions();
  $('s-provider').value = c.asr.provider || 'local';
  $('s-local-model').value = c.asr.localModel;
  $('s-local-device').value = c.asr.localDevice;
  $('s-cdn').value = c.asr.cdn || '';
  $('s-model-host').value = c.asr.modelHost === 'https://hf-mirror.com' ? 'https://hf-mirror.com' : 'https://huggingface.co';
  $('s-asr-endpoint').value = c.asr.endpoint || '';
  $('s-asr-model').value = c.asr.model || '';
  // Key 输入框直接填上正在用的那把 —— 老大原话：「为什么设置里输入key保存后再打开就消失了，
  // 虽然能正常调用API但我感觉还是一直有比较好」。本机请求时服务端会回传明文，
  // 局域网/手机上回的是空串 + masked，那种情况才退回「已保存」的提示。
  const shownKey = c.asr.apiKey || c.llm.apiKey || '';
  $('s-key').value = shownKey;
  $('s-key').type = 'password';
  $('s-key').placeholder = c.asr.hasApiKey || c.llm.hasApiKey ? '已保存（可直接修改）' : '粘贴你的 API Key';
  renderKeyVault(c.keyVault || []);
  $('s-language').value = c.asr.language;
  $('s-llm-enabled').checked = !!c.llm.enabled;
  $('s-llm-base').value = c.llm.baseUrl || '';
  $('s-llm-model').value = c.llm.model || '';
  // 笔记风格 / 每个主题几条重点 / 额外要求 已经不在这里了：从 2026-10-23 起
  // 它们是「每条录音自己的」，在新建录音弹窗里问（见 openNewLecture）。
  // config.notes.* 和 config.llm.extraPrompt 仍然保留，作为没单独设过的
  // 录音的默认值，所以设置面板不再读写它们。
  // 存储位置：输入框不填配置值，交给 renderStorage / refreshStorage 填
  // **当前实际位置**（配置里默认是空串，填空串的话用户看不出录音存哪）。
  // touched 标记要清掉：上次开面板时改了一半没保存，这次重新打开应该回到
  // 「显示实际位置」的状态。
  for (const id of ['s-lect-dir', 's-models-dir']) {
    const n = $(id);
    if (n) {
      n.dataset.touched = '';
      n.value = '';
    }
  }
  renderStorage(state.sys);
  refreshStorage();
  applyProvider($('s-provider').value);
  syncSettingsVisibility();
  refreshLan();
  renderAbout();
  $('settings-modal').hidden = false;
  runDiagnostics();
  // 顺手查一次（silent）：服务端 6 小时节流，多数时候只是把上次结果取回来，
  // 一个请求都不发。失败也不打扰 —— 打开设置是为了改设置，不是来看报错的。
  checkUpdate({ silent: true }).catch(() => {});
}

/* ---------------------- 用户协议 / 隐私政策 ---------------------- */


/**
 * 自动更新：查 / 下 / 装，全在设置面板的「⑤ 关于与协议」里。
 *
 * 为什么不用一个独立的「有新版本！」弹窗：
 *   软件是给人上课用的，弹窗只会打断人。查到新版在「关于」里挂一行，
 *   用户什么时候想更就更。真正装的时候才必须打断 —— 因为要退出程序。
 *
 * 三步顺序是物理约束，不是风格：node.exe 跑着时安装包写不进去，
 * 所以「下载 → 退出 → 装」这个顺序不能换（见 server.mjs 的 applyUpdate 注释）。
 */
const updateState = {
  busy: '',          // '' | 'checking' | 'downloading' | 'installing'
  info: null,        // 最后一次 /update/check 的结果
  downloaded: null,  // { name, sizeText, version }
};

/** 把跑着的任务画到按钮和状态行上。界面永远能看出「现在在干嘛」。 */
function renderUpdateBox() {
  const box = $('update-box');
  if (!box) return;
  const info = updateState.info;
  const show = !!info && (info.hasUpdate || !!updateState.downloaded || updateState.busy === 'installing');
  box.hidden = !show;
  if (!show) return;

  const title = $('update-title');
  const sub = $('update-sub');
  const notes = $('update-notes');
  const status = $('update-status');
  const btnInstall = $('btn-update-install');
  const btnIgnore = $('btn-update-ignore');
  const btnPage = $('btn-update-page');

  const latest = info.latest || updateState.downloaded?.version || '';
  title.textContent = latest ? `新版本 ${latest}` : '有新版本';

  const bits = [];
  if (info.publishedAt) {
    const d = info.publishedAt.slice(0, 10);
    if (d) bits.push(`${d} 发布`);
  }
  if (info.installer?.sizeText) bits.push(`安装包 ${info.installer.sizeText}`);
  sub.textContent = bits.join(' · ');

  // 更新说明是 Markdown（作者在 Releases 里怎么写就怎么显示）。
  // 直接塞 <pre> 会把 `## 这一版改了什么` 原样露给用户看，所以过一遍渲染器。
  if (info.notes) {
    notes.innerHTML = renderMarkdown(info.notes);
    notes.hidden = false;
  } else {
    notes.textContent = '';
    notes.hidden = true;
  }

  // 「能不能一键装」是服务端判的：绿色版的数据在程序目录里，没有安装位置可覆盖
  const canInstall = info.canInstall !== false;
  btnInstall.hidden = !canInstall;
  btnIgnore.hidden = !canInstall;
  // 绿色版 / 没有更新脚本时，只能给一个下载页链接
  btnPage.hidden = canInstall && !!info.installer;

  const downloading = updateState.busy === 'downloading';
  const installing = updateState.busy === 'installing';
  btnInstall.disabled = downloading || installing;
  btnIgnore.disabled = downloading || installing;
  if (installing) btnInstall.textContent = '正在退出并安装…';
  else if (downloading) btnInstall.textContent = '正在下载…';
  else if (updateState.downloaded) btnInstall.textContent = '立即安装';
  else btnInstall.textContent = '下载并安装';

  if (updateState.busy === 'installing') status.textContent = '装完会自动打开，别急着点。';
  else if (downloading) status.textContent = '下载中可以关掉设置，装好会提示。';
  else if (updateState.downloaded) status.textContent = '安装包已就绪，点「立即安装」会先退出再装。';
  else status.textContent = canInstall ? '' : '这一份是绿色版，请到下载页手动替换。';
}

/**
 * 检查更新。`silent` = 打开设置时顺手查一次，失败不打扰人。
 *
 * 每次打开设置都查会有两个坏处：网慢时设置面板要转半天、频繁打同一个源。
 * 服务端已经有 6 小时节流（shouldCheck），所以这里放心地每次都问 ——
 * 绝大多数时候它只是把上次的结果回给我们，一个字节都没发出去。
 */
async function checkUpdate({ silent = false, force = false } = {}) {
  if (updateState.busy) return;
  updateState.busy = 'checking';
  if (!silent) $('btn-check-update').textContent = '检查中…';
  try {
    const r = await api(`/update/check${force ? '?force=1' : ''}`, { method: 'POST', body: {} });
    updateState.info = r;
    if (!silent) {
      if (r.error) toast('检查更新失败：' + r.error);
      else if (!r.hasUpdate) toast('已经是最新版本');
    }
  } catch (e) {
    if (!silent) toast('检查更新失败：' + e.message);
  } finally {
    updateState.busy = '';
    $('btn-check-update').textContent = '检查更新';
    renderUpdateBox();
  }
}

/** 下载 + 装。分两步是给「下载失败但已下过」留余地：重试只补没做到的那步。 */
async function runUpdate() {
  if (updateState.busy) return;
  // 第一次点：下载。下载好了再点才真的装（装要退出程序，必须让用户明确再点一次）
  if (!updateState.downloaded) {
    updateState.busy = 'downloading';
    renderUpdateBox();
    try {
      const r = await api('/update/download', { method: 'POST', body: {} });
      updateState.downloaded = { name: r.name, sizeText: r.sizeText, version: r.version };
      if (updateState.info) updateState.info.canInstall = r.canInstall !== false;
      toast(r.reused ? '安装包已经下好了' : `下载完成（${r.sizeText}）`, 4000);
    } catch (e) {
      toast('下载失败：' + e.message, 7000);
    } finally {
      updateState.busy = '';
      renderUpdateBox();
    }
    return;
  }

  // 第二次点：装。服务会先回一句「正在退出」，然后自己退出、脚本接手。
  updateState.busy = 'installing';
  renderUpdateBox();
  try {
    await api('/update/install', { method: 'POST', body: {} });
    // 到这里服务已经在退出路上了，界面大概率马上就断 —— 不用再做什么
  } catch (e) {
    updateState.busy = '';
    renderUpdateBox();
    toast('安装失败：' + e.message, 8000);
  }
}

/** 「跳过这个版本」：之后同一版号不再提示，出了更新的一版照常提示。 */
async function ignoreUpdate() {
  const v = updateState.info?.latest;
  if (!v) return;
  try {
    await api('/update/ignore', { method: 'POST', body: { version: v } });
    updateState.info = { ...updateState.info, hasUpdate: false };
    renderUpdateBox();
    toast(`不再提示 ${v}`);
  } catch (e) {
    toast('没保存成功：' + e.message);
  }
}

/** 协议版本 + 同意状态 + 两个入口按钮的状态，都在这一处维护 */
function renderAbout() {
  const a = state.agreement;
  $('about-version').textContent = state.appVersion ? `版本 ${state.appVersion}` : '版本 —';
  renderUpdateBox();
  if (!a) {
    $('about-agree').textContent = '';
    return;
  }
  if (a.accepted) {
    const when = a.acceptedAt ? a.acceptedAt.slice(0, 10) : '';
    $('about-agree').textContent = when ? `已于 ${when} 同意` : '已同意';
  } else {
    $('about-agree').textContent = '尚未同意（点左边的链接查看）';
  }
}

/**
 * 打开展示协议全文的弹窗。
 *
 * 正文不写进 JS：服务端从安装目录里的 LICENSE.txt / PRIVACY.txt 读出来，
 * 一处维护，改条款不用动代码。
 * `mode` 只有两种：
 *   'read'  —— 从设置里点进来，纯阅读，底部换成「知道了」
 *   'ask'   —— 首次启动，需要表态，保留「同意 / 以后再说」
 */
async function showAgreement(mode = 'read', which = 'license') {
  const modal = $('agree-modal');
  modal.hidden = false;
  modal.dataset.mode = mode;
  const asking = mode === 'ask';
  $('btn-agree-ok').hidden = !asking;
  $('btn-agree-later').hidden = !asking;
  $('btn-agree-later').textContent = '以后再说';
  $('btn-agree-close').hidden = asking;
  $('agree-foot').textContent = asking
    ? '继续使用需要同意以上条款。点「以后再说」可以先看看，这个窗口关掉之前不会再打扰你。'
    : '';
  switchAgreementTab(which);
  // 已经拿过正文就不重复请求
  if (!state.agreement?.text?.license && !state.agreement?.text?.privacy) {
    $('agree-text').textContent = '正在读取…';
    try {
      const r = await api('/agreement');
      if (r.ok) {
        state.agreement = { ...(state.agreement || {}), ...r, text: r.text || state.agreement?.text || {} };
      }
    } catch (e) {
      $('agree-text').textContent = '协议正文读取失败：' + e.message + '\n\n安装目录里的 LICENSE.txt / PRIVACY.txt 可以直接打开看。';
      return;
    }
  }
  renderAgreementText();
}

function switchAgreementTab(which) {
  $('tab-license').classList.toggle('active', which !== 'privacy');
  $('tab-privacy').classList.toggle('active', which === 'privacy');
  // 标题里那只文档图标在 index.html 里，不能直接 textContent（会把图标抹掉），
  // 只改文字部分。
  const t = $('agree-title');
  const span = t.querySelector('.t');
  const label = which === 'privacy' ? '隐私政策' : '用户协议';
  if (span) span.textContent = label;
  else t.textContent = label;
  $('agree-modal').dataset.which = which === 'privacy' ? 'privacy' : 'license';
  renderAgreementText();
}

/** 「以后再说」：只在本次浏览里不再打扰，不写进 config —— 没同意就是没同意 */
function snoozeAgreement() {
  try {
    sessionStorage.setItem('ln-agree-snoozed', state.agreement?.version || '1');
  } catch {}
  $('agree-modal').hidden = true;
}

function renderAgreementText() {
  const which = $('agree-modal').dataset.which === 'privacy' ? 'privacy' : 'license';
  const text = state.agreement?.text?.[which];
  if (text) $('agree-text').textContent = text;
}

async function acceptAgreement() {
  try {
    const r = await api('/agreement', { method: 'POST', body: { version: state.agreement?.version || '', accepted: true } });
    state.agreement = { ...(state.agreement || {}), ...r, accepted: true };
    $('agree-modal').hidden = true;
    renderAbout();
    toast('谢谢，开始用吧', 'ok');
  } catch (e) {
    toast('没能记下同意状态：' + e.message, 'err');
  }
}

/* ---------------------- 打赏 ---------------------- */

/**
 * 收款码是图片文件，放在 public/donate/ 下。
 *
 * 为什么要先探测再显示：图片没放的时候 <img> 会显示一个破图图标，
 * 比「什么都没放」更难看。用 Image() 探一下 onload 再决定插不插。
 * 一个码都没有时给一句说明，而不是留一块空白 —— 至少让人知道是没配，
 * 不是网页坏了。
 *
 * 每种码按扩展名依次试：.png 优先（截图工具默认存这个），再 .jpg/.jpeg/.webp
 * —— 从手机上收来的收款码常常是 .jpg，硬要求转成 png 只会让放码的人卡住。
 */
const DONATE_CODES = [
  { name: 'wechat', label: '微信' },
  { name: 'alipay', label: '支付宝' },
];
const DONATE_EXTS = ['png', 'jpg', 'jpeg', 'webp'];

function probeImage(src) {
  return new Promise((resolve) => {
    // tests/dom-app-test.mjs 的 DOM 影子层没有 Image 构造函数，
    // 直接 new 会在测试里抛 ReferenceError。探测失败当「没这张图」处理即可 ——
    // 最坏结果只是打赏窗里少一张收款码，不该让整个设置面板打不开。
    if (typeof Image !== 'function') {
      resolve(false);
      return;
    }
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = src;
  });
}

/** 找到第一个真能加载的扩展名，找不到返回 '' */
async function findDonateImage(name) {
  for (const ext of DONATE_EXTS) {
    const src = `./donate/${name}.${ext}`;
    // eslint-disable-next-line no-await-in-loop
    if (await probeImage(src)) return src;
  }
  return '';
}

/**
 * 打开打赏窗。
 * @param {'auto'|'manual'} mode auto = 启动时自动弹，manual = 用户点进来的。
 *
 * 两者区别只在「下次再说」那一行：自动弹时它是「先看看别处」，
 * 手动打开时用户本来就想要这个窗，再挂一句「下次再说」很奇怪。
 */
async function openDonate(mode = 'manual') {
  const host = $('donate-codes');
  $('donate-modal').hidden = false;
  $('donate-modal').dataset.mode = mode;
  const later = $('btn-donate-later');
  if (later) later.textContent = mode === 'auto' ? '以后再说' : '关闭';

  // 勾选框回显当前设置（用户勾过就一直是勾着的）
  const never = $('donate-never');
  if (never) never.checked = !!state.donate?.hideOnStartup;

  // 自动弹的那次，告诉服务端「已经弹过了」——十分钟内不再弹第二次，
  // 免得启动器崩溃重启把用户连弹三遍。
  if (mode === 'auto') {
    api('/donate', { method: 'POST', body: { shown: true } }).catch(() => {});
  }

  if (host.dataset.ready === '1') return; // 探测过一次就够了，不用每次点都重新试
  host.textContent = '';
  host.dataset.ready = '1';

  const found = [];
  for (const c of DONATE_CODES) {
    // eslint-disable-next-line no-await-in-loop
    const src = await findDonateImage(c.name);
    if (src) found.push({ ...c, src });
  }

  if (!found.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = '还没放收款码。把微信/支付宝的收款码图片存成 public/donate/wechat.png 或 alipay.png 就会显示在这里。';
    host.appendChild(p);
    return;
  }
  for (const c of found) {
    const box = document.createElement('div');
    box.className = 'donate-code';
    const img = document.createElement('img');
    img.src = c.src;
    img.alt = `${c.label}收款码`;
    img.loading = 'lazy';
    const cap = document.createElement('div');
    cap.className = 'donate-label';
    cap.textContent = c.label;
    box.appendChild(img);
    box.appendChild(cap);
    host.appendChild(box);
  }
}

function syncSettingsVisibility() {
  const p = $('s-provider').value;
  const isLocal = p === 'local';
  // 四家服务商现在全部「两样都能做」，所以「有没有转写」这件事已经不用判了 ——
  // 只有本地特殊：它的转写没有接口地址、不需要 Key，走的是 data-for="local" 那组。
  const hasAsr = !isLocal && !!getProvider(p, 'asr');
  document.querySelectorAll('[data-for="local"]').forEach((n) => (n.hidden = !isLocal));
  document.querySelectorAll('[data-for="cloud"]').forEach((n) => (n.hidden = !hasAsr));
  const kf = $('key-field');
  if (kf) kf.hidden = isLocal;
}

/* ---------------------- 存储位置（录音 / 模型缓存） ---------------------- */

/**
 * 把 /system 拿到的存储状态画进设置面板。
 *
 * 三件事必须一眼可见：
 *   1) 现在**实际**存哪（不是用户填了什么 —— 填了用不了会退回默认）
 *   2) 是不是默认位置（不是的话要能看懂自己改过）
 *   3) 填的位置用不了时，原因是什么
 *
 * 为什么第 3 点单独强调：退回默认是静默发生的（不能让服务起不来），
 * 如果界面上不说，用户会以为录音存在 D 盘，其实在 C 盘 ——
 * 等到某天发现「录音不见了」才炸。所以这里用 err 样式顶出来。
 */
/**
 * 「④ 手机访问」那一节的渲染 + 开关。
 *
 * 设计上服务端 socket 一直绑 0.0.0.0（否则开关要重启进程才生效），
 * 真正拦人的是 config.lan.enabled —— 关着时非本机请求全 403。
 * 所以这里只要改配置，不用重启。
 *
 * 地址为什么从 /lan 拿而不是自己拼：那串密钥（8gvqzxe4nv 那种）只有服务端
 * 知道，前端拼出来的地址是残缺的，手机打开只会 404。所以 urls 一律用
 * 服务端返回的完整串。
 */
async function refreshLan() {
  try {
    state.lanInfo = await api('/lan');
  } catch {
    state.lanInfo = null;
  }
  renderLan();
}

function renderLan() {
  const info = state.lanInfo;
  const on = !!info?.enabled;
  const hostOnLan = !!info?.hostOnLan;
  const cb = $('s-lan-enabled');
  const url = $('lan-url');
  const status = $('lan-status');
  const warn = $('lan-warn');
  const copy = $('btn-lan-copy');
  const remote = (state.lanInfo || state.sys)?.local === false;
  // 还没拿到 /lan（网络慢）时不要拿默认值去吓人，先按住。
  const unknown = !info;

  if (cb) {
    cb.checked = on;
    // 服务根本没绑局域网时，开关是个空按钮 —— 禁掉并说明，别让人以为点了没反应。
    cb.disabled = unknown || remote || !hostOnLan;
  }

  if (url) {
    const first = on && info?.urls?.length ? info.urls[0] : '';
    url.value = first;
    url.placeholder = unknown
      ? '读取中…'
      : on && !info?.urls?.length
        ? '这台电脑没有可用的局域网地址'
        : '打开开关后显示';
  }
  if (copy) copy.disabled = unknown || remote || !on;

  if (status) {
    if (unknown) {
      status.textContent = '';
      status.className = 'hint';
    } else if (!hostOnLan) {
      status.textContent = '这个服务启动时只绑了本机，手机连不上。用启动器重新启动后再开这里。';
      status.className = 'hint err';
    } else if (remote) {
      status.textContent = on ? '已开启（手机能连过来）。' : '现在是关着的。';
      status.className = on ? 'hint ok' : 'hint';
    } else if (on) {
      status.textContent = '已开启 —— 手机连同一个 Wi-Fi，浏览器里打开上面这个地址（后面那串字母别漏）。';
      status.className = 'hint ok';
    } else {
      status.textContent = '现在是关着的。手机连上来只会看到 403，不会读到任何东西。';
      status.className = 'hint';
    }
  }

  if (warn) {
    if (hostOnLan && !on && !unknown) {
      warn.textContent = '开着的时候，同一个 Wi-Fi 下的任何设备只要知道那串地址就能打开你的页面。传完录音记得回来关掉。';
      warn.hidden = false;
    } else {
      warn.hidden = true;
    }
  }
}

/** 开关的写入。成功之后不重拉整个 /system —— 那个接口要算目录大小，慢。 */
async function toggleLan(on) {
  const cb = $('s-lan-enabled');
  if (cb) cb.disabled = true;
  try {
    const r = await api('/lan', { method: 'POST', body: { enabled: on } });
    state.lanInfo = r;
    toast(on ? '手机访问已开启' : '手机访问已关闭', 'ok', 2400);
  } catch (e) {
    if (cb) cb.checked = !on;
    toast(`改不了：${e.message}`, 'err', 5000);
  } finally {
    renderLan();
    // 开关一改，⑥ 环境自检里那行「局域网地址」就过期了 —— 那一行是打开设置
    // 面板时算的。不重跑的话用户会看到「已开启」和「未开启 —— 在 ④ 手机访问
    // 里打开」同时出现在同一屏上，非常容易被当成没生效。
    runDiagnostics();
  }
}

function renderStorage(sys) {
  const s = sys?.storage;
  if (!s) return;
  state.storage = s;

  // 局域网 / 手机：这一段只给看，不给改。
  // 服务端 /storage/check 和 /storage/move 都只认 loopback（会回 403），
  // 所以这里把输入框和按钮都禁掉、并把引导文案换掉 ——
  // 不然用户会以为「填了没反应」是坏了。
  const remote = sys.local === false;
  const intro = $('storage-intro');
  if (intro) {
    intro.innerHTML = remote
      ? '录音和模型缓存放在哪。这一项<b>只能在跑这个服务的那台电脑上改</b> —— 手机改不了别人电脑上的存盘位置。下面显示的是那台电脑现在的实际位置。'
      : '录音和模型缓存放在哪。默认就在安装目录下面；想换到别的盘，把路径改一下再点「迁移」，现有文件会复制过去（<b>旧目录不会删</b>）。';
  }
  for (const [inId, btnId] of [
    ['s-lect-dir', 'btn-lect-dir-move'],
    ['s-models-dir', 'btn-models-dir-move'],
  ]) {
    const inp = $(inId);
    const b = $(btnId);
    if (inp) inp.disabled = remote;
    if (b) b.disabled = remote;
  }

  // 两组元素显式写出来，不做成循环：tests/check-ui-ids.mjs 靠正则扫
  // 形如「美元符号 + 圆括号 + 引号字面量」的取值来核对 id 有没有被引用，
  // 拼接出来的（或塞进对象字段里的）它看不见，会把 s-lect-dir-now 这类
  // id 误报成「没人引用」。多写几行，换工具不误报。
  const stL = s.lectures;
  const stM = s.models;

  if (stL) {
    const now = $('s-lect-dir-now');
    const hint = $('s-lect-dir-hint');
    const input = $('s-lect-dir');
    if (now) {
      now.textContent = stL.custom ? `（自定义，${stL.sizeGB} GB）` : `（默认，${stL.sizeGB} GB）`;
      now.className = 'hint' + (stL.custom ? ' ok' : '');
    }
    if (hint) {
      if (stL.error) {
        hint.textContent = `${stL.error}　现在用的是：${stL.dir}`;
        hint.className = 'hint err';
      } else {
        hint.textContent = '';
        hint.className = 'hint';
      }
    }
    // 输入框：用户没动手时，显示**当前实际位置**（不是配置值）。
    // 为什么显示实际位置而不是配置值：默认状态下配置里是空串，
    // 输入框空着的话用户根本看不出录音在哪儿，只能去看下面那行小字。
    // 参考图那种「框里就是真路径」更直接。用户一动键盘就切到编辑模式，
    // 输入框里就是他要填的东西，不再被覆盖（见 dataset.touched）。
    if (input && !input.dataset.touched) input.value = stL.dir || '';
    // 路径不存在时「打开」按钮没意义，直接禁掉并说明原因。
    for (const id of ['btn-lect-dir-copy', 'btn-lect-dir-open', 'btn-lect-dir-reset']) {
      const b = $(id);
      if (b) b.disabled = remote || !stL.dir;
    }
  }

  if (stM) {
    const now = $('s-models-dir-now');
    const hint = $('s-models-dir-hint');
    const input = $('s-models-dir');
    if (now) {
      now.textContent = stM.custom ? `（自定义，${stM.sizeGB} GB）` : `（默认，${stM.sizeGB} GB）`;
      now.className = 'hint' + (stM.custom ? ' ok' : '');
    }
    if (hint) {
      // 退回默认是静默发生的（不能让服务因为一个坏路径起不来），
      // 所以「你填的用不了」这件事必须在这儿顶出来，否则用户会以为
      // 录音存在 D 盘，其实躺在 C 盘 —— 等到某天发现「录音不见了」才炸。
      if (stM.error) {
        hint.textContent = `${stM.error}　现在用的是：${stM.dir}`;
        hint.className = 'hint err';
      } else {
        hint.textContent = '';
        hint.className = 'hint';
      }
    }
    if (input && !input.dataset.touched) input.value = stM.dir || '';
    for (const id of ['btn-models-dir-copy', 'btn-models-dir-open', 'btn-models-dir-reset']) {
      const b = $(id);
      if (b) b.disabled = remote || !stM.dir;
    }
  }
}

/**
 * 迁移一个存储目录到用户填的新位置。
 *
 * 流程刻意做成「先验证 → 再确认 → 才复制」：
 * 几 GB 的文件复制是不可轻率启动的操作，盘符打错一个字就可能在山一样的
 * 目录树里拷，或者把数据混进一个有别的东西的目录。所以先让服务验一遍
 * （/storage/check 会建目录、试写、算已有大小），把结果给用户看清楚再动手。
 *
 * 复制期间锁住按钮：重复点会起两个复制流，同一个目标文件被两路写，
 * 结果是文件损坏 —— 而且这属于「用户数据」，坏了没法重来。
 */
async function moveStorage(which) {
  const isModels = which === 'models';
  const input = $(isModels ? 's-models-dir' : 's-lect-dir');
  const btn = $(isModels ? 'btn-models-dir-move' : 'btn-lect-dir-move');
  const hint = $(isModels ? 's-models-dir-hint' : 's-lect-dir-hint');
  const raw = input.value.trim();
  const label = isModels ? '模型缓存' : '录音';

  // 手机上不给点：服务端那两个接口本来就只有本机能调（403），
  // 与其让人填完路径再吃一个 403，不如在这儿就拦住并把原因说清。
  if (state.sys && state.sys.local === false) {
    toast('存储位置只能在跑这个服务的那台电脑上改', 'err');
    return;
  }
  if (btn.disabled) return;
  // 输入框现在默认显示的是「当前实际位置」，所以空着不再等于「改回默认」——
  // 改成一句话说清该点哪里，别让用户对着空框猜。
  if (!raw) {
    toast('路径不能为空。想用回默认位置请点右边的「重置」', 'err');
    return;
  }

  btn.disabled = true;
  const oldText = btn.textContent;
  btn.textContent = '检查…';
  try {
    const chk = await api('/storage/check', { method: 'POST', body: { which, dir: raw } });
    if (chk.dir === chk.currentDir) {
      toast(`已经在这个位置了`, '');
      return;
    }
    const empty = chk.sizeGB < 0.01;
    const ask =
      `把${label}迁移到：\n${chk.dir}\n\n` +
      (empty
        ? '这个位置是空的，会复制现有的全部文件过去。'
        : `注意：这个位置已经有 ${chk.sizeGB} GB 文件，会和现有内容合并（同名同大小的会跳过）。`) +
      `\n\n源目录：${chk.currentDir}\n\n` +
      '只复制、不删除。迁移完成并确认新位置没问题后，旧目录需要你自己清理。' +
      (chk.sizeGB > 0.01 ? '\n\n如果那是别的程序的数据，请换个目录。' : '');
    if (!confirm(ask)) return;

    btn.textContent = '复制中…';
    hint.textContent = '正在复制，期间请不要关闭窗口…';
    hint.className = 'hint';
    const r = await api('/storage/move', { method: 'POST', body: { which, dir: raw } });
    // oldKept 由服务端判断「源目录和新位置是不是同一个」。同一个就说明
    // 这次其实没搬东西（比如改回默认位置、而文件本来就在那儿），
    // 这时候再喊「旧目录还留着」会让用户去删一个根本不存在的重复目录。
    hint.textContent = r.oldKept
      ? `完成：${r.message}。旧目录 ${r.fromDir} 还留着，确认无误后可以自己删。`
      : `完成：${r.message}。`;
    hint.className = 'hint ok';
    toast(`${label}已迁移到新位置`, 'ok');
    // 迁移完必须重拉 /system：界面上的「当前实际位置」和占用大小都变了，
    // 不刷新的话用户看到的还是旧目录，会以为迁移没生效。
    await refreshStorage();
  } catch (e) {
    hint.textContent = e.message;
    hint.className = 'hint err';
    toast('迁移失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

/**
 * 把某个存储目录改回默认位置。
 *
 * 只改配置、不搬文件。界面的 confirm 里说清了这一点：默认位置可能已经有
 * 一份旧数据，也可能空着 —— 服务端不去猜，让用户自己决定要不要手动复制。
 * 之所以不做自动搬回：搬回的方向通常是「从移动硬盘回到 C 盘」，
 * 万一 C 盘空间不够，自动搬会写到一半失败，比不搬更糟。
 */
async function resetStorage(which) {
  const isModels = which === 'models';
  const label = isModels ? '模型缓存' : '录音';
  const st = state.storage?.[which];
  if (state.sys && state.sys.local === false) {
    toast('存储位置只能在跑这个服务的那台电脑上改', 'err');
    return;
  }
  if (!st) return;
  if (!st.custom) {
    toast(`${label}已经在默认位置了`, '');
    return;
  }
  if (!confirm(
    `把${label}改回默认位置？\n\n默认位置：${st.defaultDir}\n\n` +
    '注意：现有文件不会自动搬回去。如果默认位置是空的，录音列表会看起来「空了」——' +
    '文件其实还在你原来设的那个目录里，随时可以再设回去。',
  )) return;
  try {
    await api('/config', { method: 'PUT', body: { storage: { [isModels ? 'modelsDir' : 'lecturesDir']: '' } } });
    const input = $(isModels ? 's-models-dir' : 's-lect-dir');
    if (input) input.dataset.touched = '';  // 清掉编辑态，让框回归「显示实际位置」
    toast(`${label}已改回默认位置`, 'ok');
    await refreshStorage();
  } catch (e) {
    toast('修改失败：' + e.message, 'err');
  }
}

/** 复制一个路径到剪贴板。剪贴板 API 在非 https 下也可能不可用，所以留了退路。 */
async function copyStoragePath(which) {
  const dir = state.storage?.[which]?.dir;
  if (!dir) {
    toast('还没有路径可复制', 'err');
    return;
  }
  try {
    await navigator.clipboard.writeText(dir);
    toast('路径已复制', 'ok');
  } catch (e) {
    // 退路：把输入框选中，让用户自己按 Ctrl+C。
    // 不用 document.execCommand('copy') —— 它已废弃，而且在这种
    // 只读输入框上行为不一致，不如老老实实提示。
    const input = $(which === 'models' ? 's-models-dir' : 's-lect-dir');
    if (input) {
      input.focus();
      input.select();
      toast('浏览器不允许自动复制，已帮你选中，按 Ctrl+C', '');
    } else {
      toast('复制失败：' + e.message, 'err');
    }
  }
}

/** 在文件管理器里打开存储目录（服务端用 explorer.exe 弹窗口）。 */
async function openStorageDir(which) {
  const label = which === 'models' ? '模型缓存' : '录音';
  if (state.sys && state.sys.local === false) {
    toast('只能在跑这个服务的那台电脑上打开文件夹', 'err');
    return;
  }
  const btn = $(which === 'models' ? 'btn-models-dir-open' : 'btn-lect-dir-open');
  if (btn && btn.disabled) return;
  if (btn) btn.disabled = true;
  try {
    await api('/storage/open', { method: 'POST', body: { which } });
  } catch (e) {
    toast(`打不开${label}目录：` + e.message, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/** 重新拉一次存储状态并重画（迁移、改回默认之后都要调） */
async function refreshStorage() {
  try {
    const sys = await api('/system');
    state.sys = sys;
    renderStorage(sys);
  } catch (e) {
    // 拉不到不是致命错误：设置面板其它部分还能用，
    // 只是存储那一段留着上一次的数字。不弹 toast 打扰用户。
  }
}

/* ---------------------- 存储位置结束 ---------------------- */

async function saveSettings() {
  const id = $('s-provider').value;
  // 四家服务商全部「两样都能做」，local 也一样（转写浏览器 Whisper / 笔记本机 llama-server），
  // 所以这里不再有「这家不支持 → 退回 local / 留空」的分支。
  const patch = {
    asr: {
      provider: id,
      localModel: $('s-local-model').value,
      localDevice: $('s-local-device').value,
      cdn: $('s-cdn').value.trim(),
      modelHost: $('s-model-host').value,
      endpoint: $('s-asr-endpoint').value.trim(),
      model: $('s-asr-model').value.trim(),
      language: $('s-language').value,
    },
    llm: {
      enabled: $('s-llm-enabled').checked,
      provider: id,
      baseUrl: $('s-llm-base').value.trim(),
      model: $('s-llm-model').value.trim(),
    },
    // notes / extraPrompt 不再由设置面板写：它们是每条录音自己的（在新建录音
    // 弹窗里设，存进 meta.notePrefs）。留在这里的 config 值只是「没设过的录音」
    // 的默认值，设置面板没有输入框能改它。
  };
  // 存储位置要单独判断：输入框里现在显示的是「当前实际位置」（不是配置值），
  // 直接提交的话会把默认位置的绝对路径当成自定义路径写进配置，
  // 于是 custom 从 false 变 true —— 明明用户什么都没改。
  // 所以只有用户真的动过输入框（dataset.touched）才提交这两项；
  // 想改回默认走「重置」按钮，那条路是 PUT 空串。
  const touchL = $('s-lect-dir').dataset.touched;
  const touchM = $('s-models-dir').dataset.touched;
  if (touchL || touchM) {
    patch.storage = {};
    // 只提交动过的那一项。没动的那项不带 key，服务端 saveConfig 的 deepMerge
    // 就不会碰它，配置里的原值保持不变。
    //
    // 另一层：用户可能只是点进去、把路径末尾一个字符删了又补回来，结果
    // 提交上去的正好等于默认路径。这时要当成「用默认」存空串，否则
    // custom 会从 false 翻成 true，界面显示「自定义」而路径和默认一模一样。
    // Windows 路径大小写不敏感，所以用 toLowerCase 比。
    const same = (a, b) => String(a || '').replace(/[\\/]+$/, '').toLowerCase() === String(b || '').replace(/[\\/]+$/, '').toLowerCase();
    if (touchL) {
      const v = $('s-lect-dir').value.trim();
      patch.storage.lecturesDir = same(v, state.storage?.lectures?.defaultDir) ? '' : v;
    }
    if (touchM) {
      const v = $('s-models-dir').value.trim();
      patch.storage.modelsDir = same(v, state.storage?.models?.defaultDir) ? '' : v;
    }
  }
  // 一把 Key 两处用
  const k = $('s-key').value.trim();
  if (k) {
    patch.asr.apiKey = k;
    patch.llm.apiKey = k;
  }
  try {
    // 换本地笔记模型要重启 llama-server（一次只能装一个 gguf，而且它压根
    // 不校验请求里的 model 字段 —— 实测随便写个名字也回 200，永远给启动时
    // 加载的那个）。所以保存之后如果发现「本地 + 模型变了」，顺手调一次切换。
    // 放在保存成功之后：配置没存上的话，重启成新模型反而跟界面不一致。
    const wasLocalModel = String(state.config?.llm?.model || '');
    const nowLocalModel = patch.llm.model;
    const isLocalNow = id === 'local';
    const data = await api('/config', { method: 'PUT', body: patch });
    state.config = data.config;
    $('settings-modal').hidden = true;
    toast('设置已保存', 'ok');
    renderEngineTag();
    if (isLocalNow && nowLocalModel && nowLocalModel !== wasLocalModel) {
      await switchLocalLlm(nowLocalModel);
    }
    return true;
  } catch (e) {
    toast('保存失败：' + e.message, 'err');
    return false;
  }
}

/**
 * 换本地大模型：告诉服务端「加载这个 gguf」，它会停掉旧的、用新的拉起来。
 *
 * 为什么要单独一次请求、而不是塞进保存配置里：换模型可能失败（那个档还没
 * 下载），而配置该存还是要存 —— 不能因为模型没下就让用户的其它设置也丢。
 * 失败只提示、不抛，跟上面对 saveNotePrefs 的态度一致。
 */
async function switchLocalLlm(modelId) {
  const spec = modelSpec('local', 'llm', modelId);
  const gguf = spec?.gguf || '';
  if (!gguf) {
    // 用户手填了别的模型名（不是预设那两档）：指针文件不管，也重启不了。
    // 这时候说清楚就行 —— llama-server 其实不在意 model 名，真正加载的
    // 还是上一次那个 gguf，所以功能上不算坏，只是界面和实际对不上。
    toast('本地模型名不是预设的那两档，没法自动切换加载的文件。要换档请直接点卡片选。', '', 7000);
    return;
  }
  try {
    const r = await api('/local-llm', { method: 'POST', body: { action: 'model', gguf } });
    if (r?.switched) toast(`正在用 ${spec.label} 重新启动本地模型，约 3 秒`, 'ok', 5000);
    else if (r?.running === false) toast(`已记下用 ${spec.label}，下次启动本地模型时生效`, 'ok', 5000);
  } catch (e) {
    toast('切换本地模型失败：' + e.message, 'err', 8000);
  }
}

// 真去要一个 WebGPU 设备，而不是只看 navigator.gpu 在不在。
// 不支持的常见原因：浏览器/驱动没开、显卡被浏览器拉黑、显存不够。
async function checkGpu() {
  if (!('gpu' in navigator)) {
    return { ok: false, text: '不支持（本地转写只能用 CPU，慢很多；或改用云端转写）' };
  }
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) {
      return { ok: false, text: '接口在、但拿不到显卡（驱动被禁或显卡被拉黑）→ 实际会回退 CPU 慢跑' };
    }
    let device = null;
    try {
      device = await adapter.requestDevice();
    } catch {}
    let info = adapter.info || null;
    if (!info && typeof adapter.requestAdapterInfo === 'function') {
      try {
        info = await adapter.requestAdapterInfo();
      } catch {}
    }
    const name = info ? [info.vendor, info.architecture, info.description].filter(Boolean).join(' ') : '';
    const cap = typeof adapter.limits?.maxBufferSize === 'number' ? `，单次显存上限约 ${(adapter.limits.maxBufferSize / 1024 / 1024 / 1024).toFixed(1)}GB` : '';
    const who = name || '（这个浏览器不给显卡型号，但设备能用）';
    return {
      ok: !!device,
      text: device ? `可用：${who}${cap}` : `拿到了显卡（${who}）但建不出设备，可能回退 CPU`,
    };
  } catch (e) {
    return { ok: false, text: '自检失败：' + (e && e.message ? e.message : String(e)) };
  }
}

async function runDiagnostics() {
  const box = $('diag');
  box.innerHTML = '<div class="hint">检测中…</div>';
  const rows = [];
  const add = (k, v, ok) => rows.push({ k, v, ok });
  try {
    const h = await api('/health');
    add('服务端', `Node ${h.node} · ${h.platform}/${h.arch}`);
    add('本机地址', h.urls.join('  '));
  } catch (e) {
    add('服务端', '不可用：' + e.message, false);
  }
  // WebGPU 光看 'gpu' in navigator 是不够的：驱动被禁、显卡被浏览器拉黑、
  // 显存不够时 navigator.gpu 照样存在，但 requestAdapter 会返回 null。
  // 实测「一直等待」的锅十有八九在这里，所以自检必须真去要一个设备。
  const gpu = await checkGpu();
  add('WebGPU', gpu.text, gpu.ok);
  add('内存', (navigator.deviceMemory || 8) + ' GB（估算）');
  const mem = navigator.deviceMemory;
  if (mem && mem < 8) add('提示', '内存偏小，长录音建议用云端转写', false);
  try {
    const sys = await api('/system');
    // 「手机访问」关着时地址虽然算得出来但连不上，别让用户照着抄。
    if (!sys.lanOn) {
      add('局域网地址', '未开启 —— 在 ④ 手机访问 里打开', false);
    } else if (!sys.lan.length) {
      add('局域网地址', '未开放（启动时加了 --host 127.0.0.1）', false);
    } else {
      add('局域网地址', sys.lan.map((i) => `http://${i}:${location.port || 8788}`).join('  '));
    }
  } catch {}
  const c = state.config;
  if (c.asr.provider === 'local') {
    add('本地模型', `${c.asr.localModel} · 来源 ${c.asr.modelHost}`);
  } else {
    add('云端转写', `${c.asr.provider}${c.asr.hasApiKey ? ' · Key 已配置' : ' · 缺少 API Key'}`, c.asr.hasApiKey);
  }
  add('大模型笔记', c.llm.enabled ? `${c.llm.model || '未填模型'}${c.llm.hasApiKey ? '' : ' · 缺少 API Key'}` : '未启用（用离线引擎）', !c.llm.enabled || c.llm.hasApiKey);

  // 显存与本地大模型：两者抢资源，直接决定本地转写能不能吃上显卡
  let llm = null;
  try {
    llm = await api('/local-llm');
    if (llm.available) {
      add(
        '显卡显存',
        `${(llm.usedMB / 1024).toFixed(1)} / ${(llm.totalMB / 1024).toFixed(1)} GB 已用，空闲 ${(llm.freeMB / 1024).toFixed(1)} GB`,
        llm.freeMB > 2500
      );
    }
  } catch {}

  box.innerHTML = '';
  for (const r of rows) {
    box.appendChild(el('div', 'diag-row', `<span class="k">${esc(r.k)}</span><span>${r.ok === false ? icon('alert', 'sm') + ' ' : ''}${esc(r.v)}</span>`));
  }
  // 本地大模型这一行把「状态 + 操作 + 装在哪」并在一起。
  //
  // 以前没部署过就整行不显示，用户根本不知道有这个功能，只会以为
  // 「AI 润色就是用不了」。现在永远显示：没装给「部署」按钮，
  // 装了给「启动/停掉」按钮，装了一半（partial）说清楚要重新装。
  if (llm) {
    const row = el('div', 'diag-row');
    row.appendChild(el('span', 'k', '本地大模型'));
    let status = '未部署';
    if (llm.configured) {
      status = llm.running ? `运行中（占着 ${(llm.usedMB / 1024).toFixed(1)}GB 显存，本地转写可能吃不到显卡）` : '已部署，未运行';
    } else if (llm.partial) {
      status = '装了一半（缺运行时）';
    }
    row.appendChild(el('span', '', status));
    if (!llm.configured) {
      const label = `${icon('box', 'sm')}部署本地模型（约 4.4GB）`;
      const b = el('button', 'btn tiny ghost', label);
      b.onclick = async () => {
        b.disabled = true;
        b.textContent = '正在准备…';
        try {
          const r = await api('/local-llm/setup', { method: 'POST', body: {} });
          toast(r.message || '已开始部署，请稍候…', 'ok', 6000);
        } catch (e) {
          toast('部署失败：' + e.message, 'err', 8000);
        }
        b.disabled = false;
        b.innerHTML = label;
        setTimeout(runDiagnostics, 3000);
      };
      row.appendChild(b);
      // partial：目录在那儿但缺 llama-server.exe —— 部署中途失败留下的残骸。
      // 这种要说清楚「装了一半」，不然用户以为自己装过、点哪儿都不对。
      const hint = el(
        'span',
        'diag-hint',
        llm.partial
          ? ` 上次没装完（${llm.home}），重新点一次会接着装。`
          : ' 不装也能用：AI 润色会自动退回离线引擎。'
      );
      row.appendChild(hint);
    } else {
      const b = el(
        'button',
        'btn tiny ' + (llm.running ? 'danger' : 'ghost'),
        llm.running ? '⏻ 停掉，释放显存' : '▶ 启动本地大模型'
      );
      b.onclick = async () => {
        b.disabled = true;
        b.textContent = llm.running ? '正在释放…' : '正在启动（约 8 秒）…';
        try {
          await api('/local-llm', { method: 'POST', body: { action: llm.running ? 'stop' : 'start' } });
          toast(llm.running ? '已释放显存' : '本地大模型启动中', 'ok');
        } catch (e) {
          toast('操作失败：' + e.message, 'err', 8000);
        }
        setTimeout(runDiagnostics, 1500);
      };
      row.appendChild(b);
      // 装在哪也说出来：用户换机器、想删掉腾空间时得知道去哪找
      if (llm.home) row.appendChild(el('span', 'diag-hint', ' 装在 ' + llm.home));
    }
    box.appendChild(row);
  }
}

/* ============================ 事件绑定 ============================ */
function bind() {
  $('btn-import').onclick = () => $('file-input').click();
  $('btn-import-2').onclick = () => $('file-input').click();
  $('file-input').onchange = (e) => {
    handleFiles(e.target.files);
    e.target.value = '';
  };
  $('btn-demo').onclick = loadDemo;
  $('btn-record').onclick = startRecording;
  $('btn-rec-stop').onclick = () => stopRecording(true);
  $('btn-rec-cancel').onclick = () => stopRecording(false);
  $('btn-settings').onclick = openSettings;
  $('btn-settings-close').onclick = $('btn-settings-cancel').onclick = () => ($('settings-modal').hidden = true);
  $('btn-settings-save').onclick = saveSettings;
  $('btn-lect-dir-move').onclick = () => moveStorage('lectures');
  $('btn-models-dir-move').onclick = () => moveStorage('models');
  $('btn-lect-dir-reset').onclick = () => resetStorage('lectures');
  $('btn-models-dir-reset').onclick = () => resetStorage('models');
  $('btn-lect-dir-copy').onclick = () => copyStoragePath('lectures');
  $('btn-models-dir-copy').onclick = () => copyStoragePath('models');
  $('btn-lect-dir-open').onclick = () => openStorageDir('lectures');
  $('btn-models-dir-open').onclick = () => openStorageDir('models');
  // 「④ 手机访问」开关。onchange 而不是 onclick：checkbox 的 onclick 里读
  // checked 在部分浏览器上还是旧值，onchange 一定已经翻过来了。
  $('s-lan-enabled').onchange = (e) => toggleLan(e.target.checked);
  $('btn-lan-copy').onclick = async () => {
    const v = $('lan-url').value.trim();
    if (!v) return;
    try {
      await navigator.clipboard.writeText(v);
      toast('地址已复制', 'ok', 2000);
    } catch {
      // 浏览器不给复制权限时退回到「帮你选中」，别直接失败。
      const n = $('lan-url');
      n.focus();
      n.select();
      toast('浏览器不允许自动复制，已帮你选中，按 Ctrl+C', 'err', 4000);
    }
  };
  // 用户开始打字就标记 touched。renderStorage 靠它决定要不要把输入框
  // 覆盖成「当前实际位置」—— 不标记的话，设置面板重开或迁移后刷新时，
  // 用户打了一半的路径会被悄悄冲掉。
  for (const id of ['s-lect-dir', 's-models-dir']) {
    const n = $(id);
    if (n) n.addEventListener('input', () => (n.dataset.touched = '1'));
  }
  $('btn-shutdown').onclick = async () => {
    if (!confirm('确定关闭「讲义笔记」的后台服务？\n\n关闭后双击「启动.vbs」可重新打开，数据不会丢失。')) return;
    try {
      await api('/shutdown', { method: 'POST' });
      $('settings-modal').hidden = true;
      document.body.innerHTML =
        '<div style="display:grid;place-items:center;height:100vh;font:16px/1.8 system-ui,sans-serif;text-align:center">' +
        `<div><div style="width:46px;height:46px;margin:0 auto 14px;display:grid;place-items:center;border-radius:13px;background:#e7ebf2;color:#33507a"><svg class="i" style="width:23px;height:23px"><use href="#i-check"/></svg></div><h2>后台服务已关闭</h2>` +
        '<p style="color:#7c766a">这个窗口可以直接关掉了。<br>下次要记笔记，双击项目里的「启动.vbs」。</p></div></div>';
    } catch (e) {
      toast('退出失败：' + e.message, 'err');
    }
  };
  $('s-provider').onchange = () => {
    syncSettingsVisibility();
    // 用户主动换服务商：地址和模型一律跟着换，不要留上一家的残留
    applyProvider($('s-provider').value, { force: true });
  };
  $('btn-help-api').onclick = () => showApiTutorial('all');
  $('btn-help-api-llm').onclick = () => showApiTutorial('llm');
  $('btn-api-close').onclick = () => ($('api-modal').hidden = true);
  // 协议：设置里「用户协议 / 隐私政策」两个链接 + 弹窗里的标签页
  $('btn-show-license').onclick = () => showAgreement('read', 'license');
  $('btn-show-privacy').onclick = () => showAgreement('read', 'privacy');

  // 自动更新：手动检查 / 下载并安装 / 跳过这一版 / 打开下载页
  $('btn-check-update').onclick = () => checkUpdate({ force: true });
  $('btn-update-install').onclick = runUpdate;
  $('btn-update-ignore').onclick = ignoreUpdate;
  $('btn-update-page').onclick = () => {
    const u = updateState.info?.pageUrl;
    // 下载页可能为空（自定义清单没写），那时候就别开一个空白标签页
    if (u) window.open(u, '_blank', 'noopener');
  };
  $('tab-license').onclick = () => switchAgreementTab('license');
  $('tab-privacy').onclick = () => switchAgreementTab('privacy');
  $('btn-agree-ok').onclick = acceptAgreement;

  $('btn-agree-close').onclick = () => ($('agree-modal').hidden = true);
  $('btn-agree-later').onclick = snoozeAgreement;

  // 打赏：设置底部一个入口（想看才点），另外每次启动程序自动弹一次，
  // 勾了「以后不要再提示我」就不再自动弹。
  $('btn-show-donate').onclick = () => openDonate('manual');
  $('btn-donate-close').onclick = () => ($('donate-modal').hidden = true);
  $('btn-donate-later').onclick = () => ($('donate-modal').hidden = true);
  $('donate-never').onchange = async (e) => {
    const hide = e.target.checked;
    try {
      const r = await api('/donate', { method: 'POST', body: { hideOnStartup: hide } });
      state.donate = { ...(state.donate || {}), hideOnStartup: !!r.hideOnStartup };
      toast(hide ? '好，以后不再自动弹了（设置里还能找到）' : '好，下次启动还会念一遍', 'ok');
    } catch (err) {
      e.target.checked = !hide; // 没存成功就别骗人
      toast('没能保存这个选择：' + err.message, 'err');
    }
  };
  $('btn-help').onclick = () => ($('help-modal').hidden = false);
  $('btn-help-close').onclick = () => ($('help-modal').hidden = true);
  $('btn-health').onclick = () => {
    $('settings-modal').hidden = false;
    $('diag-sect').scrollIntoView();
    runDiagnostics();
  };

  $('btn-transcribe').onclick = doTranscribe;
  $('btn-notes').onclick = () => doNotes(false);
  $('btn-notes-ai').onclick = () => doNotes(true);
  // 「笔记设置」有两个入口：侧栏每行的「⋯」（renderList() 里的 li-edit），
  // 和笔记面板头上这个按钮。后者是给「已经进到这条录音里」的人用的 ——
  // 想改风格还得先退回列表实在太绕，而这块面板正是被那些设置决定的东西。
  // 录完之后才发现风格选错也不怕：不用重录，只改偏好、不动已有笔记。
  $('btn-pane-prefs').onclick = () => editNotePrefs(state.current?.lecture?.id);
  $('tab-note').onclick = () => {
    state.view = 'note';
    $('tab-note').classList.add('active');
    $('tab-mindmap').classList.remove('active');
    renderNote();
  };
  $('tab-mindmap').onclick = () => {
    state.view = 'mindmap';
    $('tab-mindmap').classList.add('active');
    $('tab-note').classList.remove('active');
    renderNote();
  };
  $('btn-export-docx').onclick = () => exportAs('docx');
  $('btn-export-pdf').onclick = () => exportAs('pdf');
  $('btn-copy').onclick = async () => {
    const md = state.current?.note?.markdown;
    if (!md) return toast('尚未生成笔记', 'err');
    try {
      await navigator.clipboard.writeText(md);
      toast('笔记已复制到剪贴板', 'ok');
    } catch {
      toast('复制失败，请手动选择文本', 'err');
    }
  };
  $('btn-cancel-job').onclick = () => {
    // 取消只作用于「当前打开这条录音」的任务。
    // 以前是全局 state.cancelled，A 在转写时切到 B 按取消，取消的其实是 A —— 更糟的是
    // 界面上根本看不出来取消了谁。现在按项目取档案，取消谁一目了然。
    const id = state.current?.lecture?.id;
    const job = id ? jobs.get(id) : null;
    if (!job) return;
    if (job.kind === 'notes' && !job.cancelled) {
      job.cancelled = true;
      job.abort?.abort();
      toast(`正在取消「${job.title || '未命名'}」的笔记生成…`);
      return;
    }
    job.cancelled = true;
    job.abort?.abort();
    toast(`正在取消「${job.title || '未命名'}」的转写…`);
  };
  $('btn-delete').onclick = async () => {
    const L = state.current?.lecture;
    if (!L) return;
    await deleteLecture(L.id);
  };

  $('d-title').addEventListener('blur', async () => {
    const L = state.current?.lecture;
    if (!L) return;
    const t = $('d-title').textContent.trim() || '未命名';
    if (t === L.title) return;
    L.title = t;
    await api('/lectures/' + L.id, { method: 'PATCH', body: { title: t } });
    await loadLectures();
  });
  $('d-title').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('d-title').blur();
    }
  });
  $('d-course').addEventListener('change', async () => {
    const L = state.current?.lecture;
    if (!L) return;
    L.course = $('d-course').value.trim();
    await api('/lectures/' + L.id, { method: 'PATCH', body: { course: L.course } });
    await loadLectures();
  });

  $('search').oninput = (e) => {
    state.filter = e.target.value;
    renderList();
  };

  // 列表多选：多选模式下点条目=勾选；批量删除走服务端逐条 DELETE
  $('btn-batch').onclick = () => setBatchMode(!batch.on);
  $('btn-batch-exit').onclick = () => setBatchMode(false);
  $('btn-batch-all').onclick = () => {
    const q = state.filter.trim().toLowerCase();
    state.lectures
      .filter((l) => !q || (l.title || '').toLowerCase().includes(q) || (l.course || '').toLowerCase().includes(q))
      .forEach((l) => batch.selected.add(l.id));
    renderList();
    updateBatchBar();
  };
  $('btn-batch-none').onclick = () => {
    batch.selected.clear();
    renderList();
    updateBatchBar();
  };
  $('btn-batch-delete').onclick = async () => {
    const ids = [...batch.selected];
    if (!ids.length) return;
    if (!confirm(`确定删除所选 ${ids.length} 条录音？音频、逐字稿与笔记将一并删除，无法恢复。`)) return;
    $('btn-batch-delete').disabled = true;
    let fail = 0;
    for (const id of ids) {
      try {
        await api('/lectures/' + id, { method: 'DELETE' });
      } catch {
        fail++;
      }
    }
    if (state.current?.lecture && ids.includes(state.current.lecture.id)) {
      state.current = null;
      $('detail').hidden = true;
      $('empty-state').hidden = false;
      setDetailOpen(false);
      $('audio').removeAttribute('src');
      try {
        history.replaceState(null, '', location.pathname);
      } catch {}
    }
    setBatchMode(false);
    await loadLectures();
    toast(fail ? `已删除 ${ids.length - fail} 条，${fail} 条删除失败` : `已删除 ${ids.length} 条录音`, fail ? 'err' : 'ok');
  };

  $('tx-search').oninput = () => renderTranscript();
  // 收起 / 展开逐字稿面板（老大 m09768：「收起后左侧笔记可占满，这样看起来更加方便」）
  $('btn-tx-collapse').onclick = () => setTranscriptCollapsed(true);
  $('btn-tx-expand').onclick = () => setTranscriptCollapsed(false);

  $('audio').addEventListener('timeupdate', (e) => highlightAt(e.target.currentTime));
  // 时长兜底：上传时浏览器还没解析元数据，meta.duration 常是 0，于是
  // 详情页不显示时长、笔记顶部也只能写「时长： 未知」。
  // 播放器一旦拿到真实时长就补写回 meta.json，下次打开就有值了。
  $('audio').addEventListener('loadedmetadata', async (e) => {
    const L = state.current?.lecture;
    const d = Number(e.target.duration);
    if (!L || !(d > 0) || Number(L.duration) > 0) return;
    L.duration = d;
    renderMetaRow(L);
    await api('/lectures/' + L.id, { method: 'PATCH', body: { duration: d } }).catch(() => {});
    await loadLectures().catch(() => {});
  });
  document.querySelectorAll('[data-jump]').forEach((b) => {
    b.onclick = () => {
      const a = $('audio');
      a.currentTime = Math.max(0, a.currentTime + Number(b.dataset.jump));
    };
  });

  $('btn-menu').onclick = () => $('sidebar').classList.add('open');
  $('btn-close-menu').onclick = () => $('sidebar').classList.remove('open');
  // 详情页的「← 返回列表」：收起详情、回到首页引导页。
  $('btn-back').onclick = () => closeDetail();
  // 收起/展开左侧录音列表：宽屏直接压掉那一列；窄屏还是走原来的抽屉。
  $('btn-sidebar').onclick = () => {
    const layout = $('layout');
    const collapsed = layout.classList.toggle('collapsed');
    $('btn-sidebar').innerHTML = `<svg class="i"><use href="#i-chevron-${collapsed ? 'right' : 'left'}"/></svg>`;
    $('btn-sidebar').title = collapsed ? '展开录音列表' : '收起录音列表';
    $('btn-sidebar').setAttribute('aria-label', collapsed ? '展开录音列表' : '收起录音列表');
  };
  // 「检查云端转写配置」：只查地址/模型/Key 齐不齐，不发音频、不花钱。
  // 用户在上传一小时的录音之前，至少能先知道配置有没有填对。
  $('btn-test-asr').onclick = async () => {
    const out = $('asr-test-result');
    out.textContent = '检查中…';
    out.style.color = '';
    const L = state.current?.lecture || state.lectures[0];
    if (!L) {
      out.innerHTML = `<span class="res-bad">${icon('x', 'sm')}还没有任何录音：先导入一段（哪怕很短）再检查</span>`;
      return;
    }
    try {
      const r = await api(`/lectures/${L.id}/transcribe`, {
        method: 'POST',
        body: { checkOnly: true, language: $('s-language').value === 'auto' ? '' : $('s-language').value },
      });
      out.innerHTML = `<span class="res-ok">${icon('check', 'sm')}配置齐了：${esc(r.name || r.provider)} → ${esc(r.url)}（模型 ${esc(r.model)}${r.verbose ? '' : '，该服务商不支持逐段时间戳'}）</span>`;
    } catch (e) {
      out.innerHTML = `<span class="res-bad">${icon('x', 'sm')}${esc(e.message)}</span>`;
    }
  };
  $('btn-test-llm').onclick = async () => {
    const out = $('llm-test-result');
    out.textContent = '测试中…';
    try {
      const body = { baseUrl: $('s-llm-base').value.trim(), model: $('s-llm-model').value.trim() };
      const k = $('s-key').value.trim();
      if (k) body.apiKey = k;
      const r = await api('/llm/test', { method: 'POST', body });
      out.innerHTML = `<span class="res-ok">${icon('check', 'sm')}可用（模型回复：${esc(r.reply || '空')}）</span>`;
    } catch (e) {
      out.innerHTML = `<span class="res-bad">${icon('x', 'sm')}${esc(e.message)}</span>`;
    }
  };

  // 从清单里点一把 → 填进输入框（已经由 pickVaultKey 处理，这里不再绑下拉）

  // 眼睛：显示 / 隐藏 Key
  $('btn-reveal-key').onclick = () => {
    const inp = $('s-key');
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    $('btn-reveal-key').innerHTML = `<svg class="i"><use href="#i-${show ? 'eye-off' : 'eye'}"/></svg>`;
    $('btn-reveal-key').title = show ? '隐藏 Key' : '显示 Key';
  };

  // 对勾：把这把 Key 记进清单，并在清单里把它标成「正在用」。
  // 只动清单不动配置 —— 真要写进 config.json 还得点右下角「保存」。
  // 好处是可以先把备用 Key 存起来，不用把正在用的那把换掉再换回来。
  $('btn-save-key').onclick = async () => {
    const k = $('s-key').value.trim();
    if (!k) {
      toast('输入框里还没有 Key', 'err');
      return;
    }
    try {
      const data = await api('/keys', { method: 'POST', body: { key: k, provider: $('s-provider').value } });
      state.keyVault = data.keys || [];
      renderKeyVault(state.keyVault);
      toast(data.duplicate ? '这把 Key 已经在清单里了' : '已存好，别忘了点右下角「保存」', 'ok');
    } catch (e) {
      toast('保存失败：' + e.message, 'err');
    }
  };


  // 清掉「当前正在用」的 Key。空字符串在服务端表示「不修改」，所以要显式发 clearApiKey，
  // 否则用户根本没有办法把自己粘错的 Key 删掉。合并下拉后转写和笔记共用一把 Key，一次清两处。
  // 注意：这不影响「已保存的 Key」清单 —— 清单里的其它几把还留着，随时能选回来。
  $('btn-clear-key').onclick = async () => {
    if (!confirm('确定清掉当前正在用的 API Key？\n\n清掉之后云端转写和 AI 笔记会立刻不能用，需要重新申请或重新粘贴。\n（已保存的 Key 清单不受影响）')) return;
    try {
      const data = await api('/config', { method: 'PUT', body: { asr: { clearApiKey: true }, llm: { clearApiKey: true } } });
      state.config = data.config;
      state.keyVault = data.config.keyVault || [];
      $('s-key').value = '';
      $('s-key').placeholder = '粘贴你的 API Key';
      renderKeyVault(state.keyVault);
      $('asr-test-result').textContent = '已清掉当前用的 Key';
      $('llm-test-result').textContent = '已清掉当前用的 Key';
      toast('已清掉当前用的 Key', 'ok');
    } catch (e) {
      toast('清除失败：' + e.message, 'err');
    }
  };

  // 拖拽导入
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (++dragDepth === 1) document.body.classList.add('dragging');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      document.body.classList.remove('dragging');
    }
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
  });

  // 快捷键
  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input,textarea,[contenteditable]')) return;
    if (e.code === 'Space' && state.current) {
      e.preventDefault();
      const a = $('audio');
      a.paused ? a.play() : a.pause();
    }
    if (e.key === 'Escape') {
      $('settings-modal').hidden = true;
      $('help-modal').hidden = true;
    }
  });
}

function exportAs(kind) {
  const L = state.current?.lecture;
  if (!L) return;
  const has = state.current?.note?.markdown;
  if (!has) return toast('尚未生成笔记', 'err');
  if (kind !== 'pdf') {
    location.href = `/api/lectures/${L.id}/export?kind=${kind}`;
    return;
  }
  // PDF 走 fetch 而不是 location.href：要两秒左右，而且失败原因是**能说清**的
  // （多半是这台机器没装 Chrome/Edge），得让用户看到那句话。
  // 直接跳转会变成一个「下载了一页 JSON」的哑巴体验。
  downloadPdf(L);
}

async function downloadPdf(L) {
  const btn = $('btn-export-pdf');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '导出中…';
  try {
    const resp = await fetch(`/api/lectures/${L.id}/export?kind=pdf`);
    if (!resp.ok) {
      let msg = `导出失败（HTTP ${resp.status}）`;
      try {
        const j = await resp.json();
        if (j?.error) msg = j.error;
      } catch {
        /* 不是 JSON 就用默认文案 */
      }
      throw new Error(msg);
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${L.title || 'notes'}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 立刻 revoke 有些浏览器还没开始读，给一秒
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('PDF 已导出（字体已嵌入，手机上也能正常显示）', 'ok');
  } catch (e) {
    toast(e.message || '导出 PDF 失败', 'err', 8000);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/**
 * 回到首屏（首页引导页），把详情整块收起来。
 * 详情与首页是同一块主区域的两态：显示详情就必须藏首页，反之亦然。
 * 地址栏的 hash 一并清掉，这样刷新/后退都不会又弹回刚才那条录音。
 */
function closeDetail() {
  state.current = null;
  $('detail').hidden = true;
  $('empty-state').hidden = false;
  setDetailOpen(false);
  const a = $('audio');
  a.pause();
  a.removeAttribute('src');
  try {
    history.replaceState(null, '', location.pathname);
  } catch {}
  renderList();
}

/** 从地址栏 hash 打开对应录音；hash 为空则回到首屏 */
async function openFromHash() {
  // 手机上不打开详情页：那边只有转写 / 笔记 / 导出，全都要在电脑上做。
  // 连地址带过来也一样（比如电脑上复制了链接发到手机看），一律回上传页。
  if (state.remote) {
    closeDetail();
    return false;
  }
  const m = location.hash.match(/^#\/l\/([A-Za-z0-9_-]{6,64})$/);
  if (m) {
    try {
      await openLecture(m[1]);
      return true;
    } catch {
      try {
        history.replaceState(null, '', location.pathname);
      } catch {}
    }
  }
  closeDetail();
  return false;
}

/* ============================ 启动 ============================ */
async function boot() {
  // 把页面里的异常直接显示出来，出问题时不用翻控制台
  window.addEventListener('error', (e) => {
    if (e && e.message) toast('页面出错：' + e.message, 'err', 9000);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const m = e?.reason?.message || e?.reason;
    if (m && !String(m).includes('取消')) toast('操作出错：' + m, 'err', 9000);
  });
  // 浏览器前进/后退、手改地址栏、粘贴链接进来都要能切换
  window.addEventListener('hashchange', () => {
    openFromHash().catch((e) => toast('打开失败：' + e.message, 'err'));
  });

  bind();
  // 逐字稿收起的偏好跟着这台机器走：上次收起了，这次打开还是收起。
  // 放在 bind() 之后、拉数据之前 —— 早点应用，免得先画一遍双栏再跳成单栏。
  restoreTranscriptCollapsed();
  try {
    const [cfg, health, agreement] = await Promise.all([
      api('/config'),
      api('/health').catch(() => null),
      api('/agreement').catch(() => null),
          ]);
    state.config = cfg.config;
    if (agreement?.ok) state.agreement = agreement;
    // 先定「是不是手机」再动界面：后面所有渲染分支都看这个。
    applyRemoteMode(health);
    if (health) {
      state.appVersion = health.version || '';
      const lan = health.urls.filter((u) => !u.includes('127.0.0.1'));
      // 列表头那条提示和帮助页里的地址，都要跟着「手机访问」开关走。
      // 开关关着时地址是算得出来的，但手机连上去只有 403 —— 照抄过去只会
      // 白折腾一趟，所以这里只说「去 ④ 打开」，不给地址。
      let lanOn = false;
      try {
        lanOn = (await api('/lan')).enabled === true;
      } catch {}
      if (!lan.length) {
        $('lan-hint').textContent =
          '想用手机直接上传录音？这个服务启动时只绑了本机，用启动器重新启动后才能开「手机访问」。';
        $('help-lan').textContent = '（这个服务只绑了本机，手机连不上）';
      } else if (!lanOn) {
        $('lan-hint').textContent =
          '想用手机上传录音？先到 设置 → ④ 手机访问 把开关打开，地址就会出现在这里。';
        $('help-lan').textContent = '（先到 设置 → ④ 手机访问 打开开关，地址会显示在这里）';
      } else {
        $('lan-hint').textContent = `手机上传地址（连同一个 Wi-Fi）：${lan.join('  ')}`;
        $('help-lan').textContent = lan.join('   ');
      }
    }
  } catch (e) {
    toast('无法连接本地服务：' + e.message, 'err', 8000);
  }
  await loadLectures().catch((e) => toast('读取列表失败：' + e.message, 'err'));

  await openFromHash();

  // ── 新手引导 ──
  // 第一次装的人先走一遍：选引擎 → 填 Key 或选模型 → 看协议。
  // 放在协议弹窗之前，并且走引导时**跳过**后面那两个弹窗：
  //   · 协议 —— 引导最后一步就是它，再弹一次等于让人连读两遍
  //   · 打赏 —— 刚装完还没转过一节课就被要钱，观感很差
  // 引导走完（或不同意退出）之前，下面的东西一个都不弹。
  const onboard = createOnboard({
    state,
    onDone: async () => {
      // 引导把 asr / llm / onboard 三处都写进服务端了，这里重新拉一份，
      // 免得界面还拿着引导前的旧配置去渲染模型卡片。
      try {
        const cfg = await api('/config');
        state.config = cfg.config;
      } catch {}
      try {
        const health = await api('/health');
        applyRemoteMode(health);
      } catch {}
      toast('设置好了，导入一段录音就能开始');
    },
    onQuit: () => {},
  });
  if (onboard && shouldOnboard({ state, remote: state.remote })) {
    onboard.open();
    return;
  }

  // 还没同意过协议就先问一次。
  // 放在最后、并且不 await 阻塞其他初始化：录音列表已经能看了，协议弹窗盖在上面而已。
  // 局域网（手机）上服务端不会给正文，也就不该在这边弹 —— accepted 由服务端算，那边会是 false，
  // 但手机用户点不了「同意」（接口只允许本机），弹出来只会让人卡住，所以按 host 排除。
  // 协议弹窗：手机上不弹（服务端不给正文，点了「同意」也是 403）。
  // 手机上唯一能做的事是上传，让一个点了没反应的协议窗挡在中间没有意义；
  // 协议是电脑那边签的，手机上不签也不影响上传。
  let agreementShown = false;
  if (!state.remote && state.agreement && state.agreement.text && !state.agreement.accepted) {
    let snoozed = '';
    try {
      snoozed = sessionStorage.getItem('ln-agree-snoozed') || '';
    } catch {}
    if (snoozed !== state.agreement.version) {
      showAgreement('ask', 'license');
      agreementShown = true;
    }
  }

  // 打赏提示：每次启动程序弹一次。
  // 协议弹窗已经在前面的话就跳过这次 —— 一次只弹一个窗，别一开程序糊两层。
  // 刷页面、切标签不算新启动：靠服务端给的 bootId 判断（服务重启才会变）。
  if (!agreementShown) maybeShowDonate();
}

/**
 * 启动时要不要弹打赏窗。
 *
 * 判断全在服务端（设置存在 config.json，手机和电脑看到的是同一份）。
 * 前端只负责把「上次见到的那次启动编号」报上去：
 *   · 存在 localStorage 里 —— 关浏览器、关电脑都还在，下次启动对不上就该弹
 *   · 弹过之后把新的 bootId 写回去 —— 再刷新页面就变成「见过」，不会重复弹
 */
async function maybeShowDonate() {
  // 手机（局域网）上不弹打赏：那是给电脑用户看的，手机上弹出来只会挡着上传按钮。
  if (state.remote) return;
  try {
    let seen = '';
    try {
      seen = localStorage.getItem('ln-boot-id') || '';
    } catch {}
    const r = await api(`/donate?bootId=${encodeURIComponent(seen)}`);
    state.donate = { ...(state.donate || {}), ...r };
    // 只给已经看过协议的人弹 —— 一开程序先弹协议再弹打赏，太吵。
    if (!r.show || !state.agreement?.accepted) return;
    openDonate('auto');
    try {
      localStorage.setItem('ln-boot-id', String(r.bootId));
    } catch {}
  } catch {
    // 打赏提示弹不出来不影响用，静默失败
  }
}

// 给浏览器自检留一个入口（tests/cdp-probe.mjs 用 CDP 连真页面时用）。
// app.js 是 ES module，模块里的函数从控制台看不见，所以显式挂出来；
// 全是纯函数/渲染函数，不暴露任何密钥或服务端能力。
// jobs 是「按录音独立的任务表」，探针要能查「这条在转、那条没转」才有意义；
// renderList / startJob / updateJob / endJob 挂出来是为了让探针能造任务再验证渲染，
// 不然只能真跑一次几分钟的转写才能测。
window.__LN__ = {
  state,
  progress,
  checkGpu,
  runDiagnostics,
  toast,
  jobs,
  startJob,
  updateJob,
  endJob,
  syncToolbar,
  renderJobProgress,
  renderList,
  openLecture,
};

boot();
