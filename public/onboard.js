/**
 * 新手引导 —— 首次启动时把「用哪个转写引擎、Key 从哪来、模型选哪个」一次问清。
 *
 * 老大原话（2026-11-09）：
 *   「软件首次启动时加上一段新手引导，用户自行选择本地或云端API转写，云端下一级
 *    选择服务商，推荐首选国内，还有其他及自定义，如果选硅基流动的话展示出二维码
 *    及这个链接 https://cloud.siliconflow.cn/i/4S2KXTfV，并且给出教程引导用户注册、
 *    创建API并填入，直接同步到设置，接下来选择转写及润色模型完成，就可以引导导入
 *    录音开始转写了，选其他服务商或自定义也给出类似的教程，如果选择本地转写，则列出
 *    转写及润色模型，让用户根据配置自行选择，选择之后自动下载，对于电脑不熟悉的用户
 *    也可以再加一个自动检测，自动选择，用户只需点确认就能自动下载，无论选哪个最后
 *    一个让用户阅读用户协议与隐私政策，必须进度条拉到底同意选项才能点，如果选不同意，
 *    则执行退出关闭页面及后台」
 *
 * 几个刻意的设计决定：
 *
 * 1. **不能让用户跳过**。这是唯一一个没有 ✕ 的弹窗：转写引擎没定，进来也是空面板。
 *    但「不同意协议」是明确出口 —— 那是老大要的，点了就真的退出服务。
 *
 * 2. **不另存一份配置**。用户选的每一项都落进既有的 asr.* / llm.* 字段，
 *    引导本身只记一个 onboard.done。否则「引导里选的」和「设置里改的」会打成两份真相，
 *    下次打开不知道该信谁。
 *
 * 3. **自动检测只在本地分支出现，且永远给用户看的见理由**。
 *    「我帮你选了 large-v3-turbo，因为检测到独立显卡」比默默选一个好的多 ——
 *    选错了用户至少知道该去怪谁（以及去哪儿改）。
 *
 * 4. **下载不是引导的一部分**。选完模型立刻写配置、关掉弹窗、把「转写第一段录音」
 *    的按钮留到主界面。引导里等 2GB 下载会让人以为卡死了。
 */
import { getProvider, modelsFor, sortedModels, modelSpec, defaultModel, TIERS } from './providers.js';

/* ------------------------------ 小工具 ------------------------------ */

const $ = (id) => document.getElementById(id);

const icon = (name, cls = '') => `<svg class="i${cls ? ' ' + cls : ''}"><use href="#i-${name}"/></svg>`;

/** 造元素。attrs 里的 onclick / className / dataset 都按普通属性处理 */
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    // 不写 `kid instanceof Node`、也不调 `document.createTextNode`：
    // tests/dom-app-test.mjs 用的是自己做的影子 DOM，那里既没有全局 Node、
    // 也没有 createTextNode，两样都会把整个 boot() 打断。
    // 真 DOM 的 append() 本来就收字符串（自动包成文本节点），影子层的 append()
    // 也收字符串，所以统一交给它就行 —— 两边都不用特殊照顾。
    const isNode = kid && typeof kid === 'object' && typeof kid.nodeType === 'number';
    n.append(isNode ? kid : String(kid));
  }
  return n;
}

/** 和 app.js 里那个 api() 同构，但本模块不依赖 app.js（它是被 app.js 引入的） */
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

/* ---------------------------- 各服务商教程 ---------------------------- */

/**
 * 云端服务商的「去哪儿拿 Key」教程。
 *
 * 为什么写死在代码里而不是从 providers.js 读：这是**操作步骤**不是服务商元数据，
 * 步骤会随对方网站改版变，而元数据（地址/模型/价格）不该被这些文案污染。
 * 每个 links 里的二维码是可选的 —— 只有硅基流动有推广二维码。
 */
const TUTORIALS = {
  siliconflow: {
    title: '硅基流动 SiliconFlow',
    tagline: '国内直连、注册就送额度，中文课堂录音首选',
    qr: './onboard/siliconflow-qr.png',
    link: 'https://cloud.siliconflow.cn/i/4S2KXTfV',
    linkLabel: 'https://cloud.siliconflow.cn/i/4S2KXTfV',
    steps: [
      '用手机扫左边的二维码，或在电脑浏览器打开下面这个链接（这是邀请链接，注册后你我各得一点额度）。',
      '用手机号注册并登录。不需要绑卡，注册送的额度够跑几十节课。',
      '进去后点左侧「API 密钥」→「新建 API 密钥」，名字随便写（比如「讲义笔记」）。',
      '点复制，把那串 sk- 开头的字符粘到下面的框里。它只显示一次，先粘再关页面。',
    ],
    keyHint: '在「API 密钥」页面新建并复制，形如 sk-xxxxxxxx',
    docs: 'https://docs.siliconflow.cn/cn/userguide/quickstart',
  },
  openai: {
    title: 'OpenAI 官方',
    tagline: '识别质量稳定，但需要能访问外网，而且要绑卡付费',
    qr: '',
    link: 'https://platform.openai.com/api-keys',
    linkLabel: 'https://platform.openai.com/api-keys',
    steps: [
      '打开 platform.openai.com 并登录（需要先注册账号，注册要能收国际短信）。',
      '左侧「API keys」→「Create new secret key」，名字随便写。',
      '复制那串 sk- 开头的字符粘到下面。它只显示一次。',
      '注意：OpenAI 的接口在国内直连不了。如果你没有稳定的外网环境，建议回去选硅基流动。',
    ],
    keyHint: '在 platform.openai.com/api-keys 新建，形如 sk-proj-xxxxxxxx',
    docs: 'https://platform.openai.com/docs/quickstart',
  },
  custom: {
    title: '自定义 / 自建 / 中转站',
    tagline: '任何兼容 OpenAI 接口的服务都能接：DeepSeek、通义、Kimi、Ollama、自建 faster-whisper…',
    qr: '',
    link: '',
    linkLabel: '',
    steps: [
      '转写地址要填到 /audio/transcriptions 结尾，例如 https://api.deepseek.com/v1/audio/transcriptions。',
      '笔记地址填到 /v1 结尾（不带 /chat/completions），例如 https://api.deepseek.com/v1。',
      '两处可以填同一个域名下的不同路径，也可以完全填两家。',
      '模型名照抄服务商文档里的写法，填错会报「模型不存在」。',
    ],
    keyHint: '粘贴服务商给你的 Key',
    docs: '',
  },
};

/* ------------------------------ 主流程 ------------------------------ */

const STEPS = ['choose', 'provider', 'connect', 'models', 'agree'];

export function createOnboard({ state, onDone, onQuit }) {
  const root = $('onboard-modal');
  if (!root) return null;

  const ui = {
    step: 'choose',
    /** 'local' | 'cloud' */
    mode: '',
    /** 云端：'siliconflow' | 'openai' | 'custom' */
    provider: '',
    /** 用户填的 Key（还没写进配置） */
    key: '',
    /** 用户填的接口地址（只有 custom 用） */
    asrEndpoint: '',
    llmBase: '',
    /** 选中的模型 id */
    asrModel: '',
    llmModel: '',
    /** 本地：选的档位；'auto' 表示让程序挑 */
    localPick: '',
    /** 自动检测的结论，用来在界面上解释「为什么给你选了这档」 */
    auto: null,
    /** 协议：滚到底了没有 / 勾了没有 */
    agreeScrolled: false,
    agreeChecked: false,
    busy: '',
    error: '',
  };

  /* ---------- 自动检测 ---------- */

  /**
   * 猜这台机器适合哪一档。
   *
   * 判据只有三样，都是能真拿到的：内存总量、有没有 WebGPU、CPU 核数。
   * **不猜「显卡型号」** —— 浏览器拿不到可靠的显卡名，猜错比不猜更糟。
   *
   * 规则（跟 providers.js 里那张实测表对齐）：
   *   · 有 WebGPU → large-v3-turbo（它有 fp16 且实测 7.73× 可用）
   *   · 内存 ≥ 8GB → base（WASM/q8 下 2.97×，一小时课约 20 分钟）
   *   · 否则 → tiny
   * 润色模型同理：有 WebGPU → 7B，否则 3B。
   */
  async function detect() {
    let totalGB = 0;
    try {
      const s = await api('/system');
      totalGB = Number(s.totalMemGB) || 0;
    } catch {}
    let hasGpu = false;
    try {
      if (navigator.gpu && navigator.gpu.requestAdapter) {
        const a = await navigator.gpu.requestAdapter();
        hasGpu = !!a;
      }
    } catch {}
    const cores = navigator.hardwareConcurrency || 4;
    const asr = hasGpu ? 'onnx-community/whisper-large-v3-turbo' : totalGB >= 8 ? 'onnx-community/whisper-base' : 'onnx-community/whisper-tiny';
    const llm = hasGpu ? 'qwen2.5-7b' : 'qwen2.5-3b';
    const why = hasGpu
      ? `检测到可用的显卡加速（WebGPU），内存 ${totalGB} GB、${cores} 核。用 turbo 档转写最快、字也最准。`
      : `没检测到可用的显卡加速，内存 ${totalGB} GB、${cores} 核。用 base 档纯靠 CPU 跑，一小时课约 20 分钟。`;
    return { totalGB, hasGpu, cores, asr, llm, why };
  }

  /* ---------- 渲染 ---------- */

  function render() {
    root.hidden = false;
    root.innerHTML = '';
    const card = el('div', { class: 'modal-card onboard-card' });
    card.append(head());
    card.append(el('div', { class: 'onboard-body' }, body()));
    card.append(foot());
    root.append(card);
    // 每次重画都从顶部开始看，别沿用上一个步骤的滚动位置
    const b = card.querySelector('.onboard-body');
    if (b) b.scrollTop = 0;
  }

  function head() {
    const idx = STEPS.indexOf(ui.step);
    const dots = el('div', { class: 'onboard-dots' });
    for (let i = 0; i < STEPS.length; i++) {
      dots.append(el('span', { class: 'onboard-dot' + (i < idx ? ' done' : i === idx ? ' now' : '') }));
    }
    return el(
      'div',
      { class: 'modal-head onboard-head' },
      el('h3', {}, el('span', { html: icon('sparkle') }), 'Hi'),
      dots
    );
  }

  function body() {
    if (ui.step === 'choose') return stepChoose();
    if (ui.step === 'provider') return stepProvider();
    if (ui.step === 'connect') return stepConnect();
    if (ui.step === 'models') return stepModels();
    if (ui.step === 'agree') return stepAgree();
    return [];
  }

  function foot() {
    const wrap = el('div', { class: 'modal-foot onboard-foot' });
    const hint = el('span', { class: 'hint' });
    if (ui.error) hint.append(el('span', { class: 'onboard-err', text: ui.error }));
    const btns = el('div', {});

    // 第一步不给「上一步」：没有前一步可回，摆一个灰按钮只会让人以为点错了。
    const back = el('button', { class: 'btn ghost', type: 'button', text: '上一步', onclick: () => go(-1) });
    if (STEPS.indexOf(ui.step) === 0) back.hidden = true;

    if (ui.step === 'agree') {
      wrap.append(hint);
      const no = el('button', {
        class: 'btn ghost',
        type: 'button',
        text: '拒绝',
        onclick: () => quit(),
      });
      const yes = el('button', {
        class: 'btn primary',
        type: 'button',
        text: '开始使用',
        onclick: () => finish(),
      });
      yes.disabled = !(ui.agreeScrolled && ui.agreeChecked) || !!ui.busy;
      // 协议页也留「上一步」：让人能退回去改前面选的引擎/模型。
      // 顾虑过「退回去能绕过授权」，但配置是在 finish() 才落盘的，
      // 没点「开始使用」就什么都没存，所以不存在绕过。
      btns.append(back, no, yes);
      wrap.append(btns);
      return wrap;
    }

    const next = el('button', {
      class: 'btn primary',
      type: 'button',
      text: ui.busy ? ui.busy : nextLabel(),
      onclick: () => go(1),
    });
    next.disabled = !!ui.busy || !canGoNext();
    btns.append(back, next);
    wrap.append(hint, btns);
    return wrap;
  }

  function nextLabel() {
    // 统一成「下一步」：之前每步写不同的字（选模型 / 填 Key / 下一步：选模型），
    // 一行里三四种说法，看着像四种操作。真正要干什么下一步自然会说。
    return '下一步';
  }

  function canGoNext() {
    if (ui.step === 'choose') return !!ui.mode;
    if (ui.step === 'provider') return !!ui.provider;
    if (ui.step === 'connect') {
      if (!ui.key.trim()) return false;
      if (ui.provider === 'custom' && !ui.asrEndpoint.trim()) return false;
      return true;
    }
    if (ui.step === 'models') return !!ui.asrModel && !!ui.llmModel;
    return true;
  }

  /* ---------- 第 1 步：本地还是云端 ---------- */

  function stepChoose() {
    // 选中只改高亮，**不自动翻页**：点卡片就跳走会让人来不及看清自己选了什么，
    // 而且「选完就走」和「选完点下一步」两种节奏混在一起，后面几步会点乱。
    const pick = (mode) => {
      ui.mode = mode;
      ui.error = '';
      ui.provider = mode === 'local' ? 'local' : 'siliconflow';
      render();
    };

    const cards = el('div', { class: 'onboard-choices' });
    cards.append(
      el(
        'button',
        { class: 'onboard-choice' + (ui.mode === 'local' ? ' on' : ''), type: 'button', onclick: () => pick('local') },
        el('span', { class: 'oc-icon', html: icon('box', 'lg') }),
        el('span', { class: 'oc-main' },
          el('span', { class: 'oc-title', text: '本地转写（不用联网、不花钱）' }),
          el('span', { class: 'oc-sub', text: '首次使用需下载模型。' })
        ),
        el('span', { class: 'oc-tag', text: '隐私优先' })
      ),
      el(
        'button',
        { class: 'onboard-choice' + (ui.mode === 'cloud' ? ' on' : ''), type: 'button', onclick: () => pick('cloud') },
        el('span', { class: 'oc-icon', html: icon('wifi', 'lg') }),
        el('span', { class: 'oc-main' },
          el('span', { class: 'oc-title', text: '云端 API（快，推荐）' }),
          el('span', { class: 'oc-sub', text: '录音上传到服务商转成文字。' })
        ),
        el('span', { class: 'oc-tag', text: '快' })
      )
    );

    return [cards, el('p', { class: 'hint onboard-note', text: '可在【设置】中随时更改。' })];
  }

  /* ---------- 第 2 步：选服务商 ---------- */

  function stepProvider() {
    const cards = el('div', { class: 'onboard-choices' });
    const rows = [
      ['siliconflow', '硅基流动 SiliconFlow', '国内直连，注册就送额度，中文课堂首选', '推荐'],
      ['openai', 'OpenAI 官方', '识别稳，但需要能访问外网并且绑卡', ''],
      ['custom', '其他 / 自定义', 'DeepSeek、通义、Kimi、Ollama、自建 faster-whisper…', ''],
    ];
    for (const [id, name, sub, tag] of rows) {
      const p = getProvider(id);
      cards.append(
        el(
          'button',
          {
            class: 'onboard-choice' + (ui.provider === id ? ' on' : ''),
            type: 'button',
            onclick: () => {
              ui.provider = id;
              ui.error = '';
              render();
            },
          },
          el('span', { class: 'oc-icon', html: icon(id === 'custom' ? 'key' : 'wifi', 'lg') }),
          el('span', { class: 'oc-main' },
            el('span', { class: 'oc-title', text: name }),
            el('span', { class: 'oc-sub', text: sub })
          ),
          tag ? el('span', { class: 'oc-tag', text: tag }) : null
        )
      );
      void p;
    }
    return [cards];
  }

  /* ---------- 第 3 步：填 Key ---------- */

  function stepConnect() {
    const t = TUTORIALS[ui.provider];
    const box = el('div', { class: 'onboard-connect' });

    // 左：二维码 + 链接（只有硅基流动有码）
    if (t.qr) {
      box.append(
        el(
          'div',
          { class: 'oc-qr' },
          el('img', { src: t.qr, alt: '注册二维码', width: '180', height: '180' }),
          el('a', { class: 'oc-link', href: t.link, target: '_blank', rel: 'noopener noreferrer', text: t.linkLabel }),
          el('span', { class: 'hint', text: '手机扫码，或把这行链接复制到浏览器' })
        )
      );
    }

    // 右：步骤 + 输入框
    const right = el('div', { class: 'oc-right' });
    right.append(el('h4', { text: t.title }));
    right.append(el('p', { class: 'hint', text: t.tagline }));
    const ol = el('ol', { class: 'onboard-steps' });
    for (const s of t.steps) ol.append(el('li', { text: s }));
    right.append(ol);

    if (ui.provider === 'custom') {
      const asr = el('input', {
        id: 'ob-endpoint',
        type: 'text',
        spellcheck: 'false',
        placeholder: 'https://api.deepseek.com/v1/audio/transcriptions',
        value: ui.asrEndpoint,
      });
      asr.addEventListener('input', () => (ui.asrEndpoint = asr.value));
      right.append(
        el('div', { class: 'field wide' }, el('label', { text: '转写接口地址' }), asr),
        el('div', { class: 'field wide' },
          el('label', { text: '笔记接口地址（可留空，留空则跟转写同一个域名下的 /v1）' }),
          (() => {
            const b = el('input', { id: 'ob-base', type: 'text', spellcheck: 'false', placeholder: 'https://api.deepseek.com/v1', value: ui.llmBase });
            b.addEventListener('input', () => (ui.llmBase = b.value));
            return b;
          })()
        )
      );
    }

    const key = el('input', {
      id: 'ob-key',
      type: 'password',
      spellcheck: 'false',
      autocomplete: 'off',
      placeholder: t.keyHint,
      value: ui.key,
    });
    key.addEventListener('input', () => {
      ui.key = key.value;
      // 只有 Key 这一项会影响「下一步」能不能点，改一个字就重算按钮状态，
      // 不整页重画（重画会把光标顶掉，粘贴时特别难受）。
      const btn = root.querySelector('.onboard-foot .btn.primary');
      if (btn) btn.disabled = !!ui.busy || !canGoNext();
    });
    right.append(el('div', { class: 'field wide' }, el('label', { text: 'API Key' }), key));

    if (t.docs) {
      right.append(
        el('p', { class: 'hint' },
          '看不懂哪一步？',
          el('a', { href: t.docs, target: '_blank', rel: 'noopener noreferrer', text: '看官方图文教程', class: 'oc-link' })
        )
      );
    }

    box.append(right);
    return [box];
  }

  /* ---------- 第 4 步：选模型 ---------- */

  function stepModels() {
    const parts = [];

    if (ui.mode === 'local') {
      // 本地：先给「自动检测」这张卡，再给四档
      const detectBox = el('div', { class: 'onboard-auto' });
      const autoBtn = el('button', {
        class: 'btn ghost',
        type: 'button',
        text: ui.auto ? '重新检测' : '自动检测',
        onclick: async () => {
          ui.busy = '检测中…';
          render();
          ui.auto = await detect();
          ui.busy = '';
          ui.localPick = 'auto';
          ui.asrModel = ui.auto.asr;
          ui.llmModel = ui.auto.llm;
          render();
        },
      });
      detectBox.append(autoBtn);
      if (ui.auto) {
        detectBox.append(
          el('p', { class: 'onboard-auto-why' },
            el('b', { text: '按你的机器推荐：' }), ui.auto.why
          )
        );
      } else {
        detectBox.append(
          el('p', { class: 'hint', text: '根据配置自动选择' })
        );
      }
      parts.push(detectBox);
    }

    // 转写模型
    const asrProvider = ui.mode === 'local' ? 'local' : ui.provider;
    const asrKind = ui.mode === 'local' ? 'asr' : 'asr';
    let asrList = sortedModels(asrProvider, asrKind);
    if (!asrList.length) asrList = modelsFor(asrProvider, asrKind);
    parts.push(
      el('div', { class: 'onboard-models' },
        el('h4', { text: '转写模型' }),
        el('div', { class: 'model-list' }, ...asrList.map((m) => modelCard(m, asrProvider, 'asr', () => {
          ui.asrModel = m.id;
          ui.localPick = '';
          ui.error = '';
          render();
        })))
      )
    );

    // 润色模型（= 生成 AI 笔记用的）
    let llmList = sortedModels(asrProvider, 'llm');
    if (!llmList.length) llmList = modelsFor(asrProvider, 'llm');
    parts.push(
      el('div', { class: 'onboard-models' },
        el('h4', { text: 'AI 润色模型' },
          el('span', { class: 'hint', text: '（把逐字稿整理成笔记，可留空以后再说）' })
        ),
        el('div', { class: 'model-list' }, ...llmList.map((m) => modelCard(m, asrProvider, 'llm', () => {
          ui.llmModel = m.id;
          ui.localPick = '';
          ui.error = '';
          render();
        })))
      )
    );

    if (ui.mode === 'local' && ui.asrModel) {
      const spec = modelSpec('local', 'asr', ui.asrModel);
      const size = spec?.priceNote || '';
      parts.push(
        el('p', { class: 'hint onboard-note' },
          `点「下一步」之后会开始下载${size ? '（' + size + '）' : ''}，下完自动开始转写。下载期间可以先去导入录音。`
        )
      );
    }

    return parts;
  }

  /** 和设置面板同款的模型卡片（复用 .model-item 那套 CSS） */
  function modelCard(spec, providerId, kind, onPick) {
    const on = (kind === 'asr' ? ui.asrModel : ui.llmModel) === spec.id;
    const plain = providerId === 'local';
    const nameRow = el('span', { class: 'model-name', text: spec.label || spec.id });
    if (spec.tier && !plain && TIERS[spec.tier]) nameRow.append(el('span', { class: 'tier tier-' + spec.tier, text: TIERS[spec.tier].label }));
    const main = el('span', { class: 'model-main' }, nameRow);
    const sub = [spec.priceNote, spec.qualityNote].filter(Boolean);
    if (sub.length) main.append(el('span', { class: 'model-sub', text: sub.join(' · ') }));
    if (spec.reqNote) main.append(el('span', { class: 'model-speed', text: spec.reqNote }));
    return el(
      'button',
      { class: 'model-item' + (on ? ' on' : ''), type: 'button', dataset: { modelId: spec.id }, onclick: onPick },
      el('span', { class: 'model-dot' }),
      main
    );
  }

  /* ---------- 第 5 步：协议 ---------- */

  function stepAgree() {
    const a = state.agreement || {};
    const text = a.text || {};
    const wrap = el('div', { class: 'onboard-agree' });

    const tabs = el('div', { class: 'tabs agree-tabs' });
    const pre = el('pre', { class: 'agree-text onboard-agree-text' });
    let which = 'license';
    const show = (w) => {
      which = w;
      tabs.querySelectorAll('.tab').forEach((t, i) => t.classList.toggle('active', (i === 0) === (w === 'license')));
      pre.textContent = text[w] || '（没读到正文，安装目录里的 LICENSE.txt / PRIVACY.txt 可以直接打开看）';
      pre.scrollTop = 0;
      ui.agreeScrolled = false;
      syncAgree();
    };
    tabs.append(
      el('button', { class: 'tab active', type: 'button', text: '用户协议', onclick: () => show('license') }),
      el('button', { class: 'tab', type: 'button', text: '隐私政策', onclick: () => show('privacy') })
    );

    const bar = el('div', { class: 'onboard-bar' }, el('i', {}));
    const pct = el('span', { class: 'hint', text: '0%' });

    const check = el('input', { type: 'checkbox', id: 'ob-agree-check' });
    // 初始就锁上。不能等 syncAgree() 去设：那会儿 wrap 还没挂进 document，
    // $('ob-agree-check') 拿不到元素（本步是在 body() 里构造的，root.append 发生在之后），
    // 结果复选框一出生就是可用状态 —— 协议一个字没看就能勾。
    check.disabled = true;
    check.addEventListener('change', () => {
      ui.agreeChecked = check.checked;
      syncAgree();
    });
    const checkRow = el('label', { class: 'check onboard-check' }, check, '我已阅读并同意《用户协议》与《隐私政策》');

    pre.addEventListener('scroll', () => {
      const max = pre.scrollHeight - pre.clientHeight;
      const p = max <= 0 ? 100 : Math.min(100, Math.round((pre.scrollTop / max) * 100));
      // 差 2% 也算到底：有些系统的滚动条到不了整 100
      if (p >= 98) ui.agreeScrolled = true;
      bar.querySelector('i').style.width = p + '%';
      pct.textContent = p + '%';
      if (ui.agreeScrolled) pct.textContent = '已到底';
      check.disabled = !ui.agreeScrolled;
      syncAgree();
    });

    wrap.append(tabs, pre, el('div', { class: 'onboard-progress' }, bar, pct), checkRow);
    show('license');
    // 内容短到不用滚时直接算读完。
    // 必须等两帧 + 确认 clientHeight > 0：弹窗刚 unhide 的那一刻 <pre> 还没布局，
    // clientHeight / scrollHeight 都是 0，会误判成「内容比框还短」直接放行 ——
    // 那样协议一个字没看就能勾同意，等于这个闸门白设。
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (pre.clientHeight > 0 && pre.scrollHeight <= pre.clientHeight + 4) {
          ui.agreeScrolled = true;
          bar.querySelector('i').style.width = '100%';
          pct.textContent = '已到底';
          check.disabled = false;
          syncAgree();
        }
      })
    );
    return [wrap];
  }

  function syncAgree() {
    const c = $('ob-agree-check');
    if (c) c.disabled = !ui.agreeScrolled;
    const btns = root.querySelectorAll('.onboard-foot .btn');
    for (const b of btns) {
      if (b.textContent.includes('开始使用')) b.disabled = !(ui.agreeScrolled && ui.agreeChecked) || !!ui.busy;
    }
  }

  /* ---------- 导航 ---------- */

  function go(dir) {
    ui.error = '';
    const i = STEPS.indexOf(ui.step);
    if (dir > 0) {
      if (ui.step === 'choose' && ui.mode === 'local') {
        // 本地跳过「选服务商」和「填 Key」
        ui.step = 'models';
        render();
        return;
      }
      if (ui.step === 'choose' || ui.step === 'provider' || ui.step === 'connect') {
        if (ui.step === 'choose') {
          ui.step = 'provider';
          render();
          return;
        }
        if (ui.step === 'provider') {
          ui.step = 'connect';
          if (!ui.asrEndpoint && ui.provider === 'custom') {
            ui.asrEndpoint = '';
          }
          render();
          return;
        }
        if (ui.step === 'connect') {
          // 填完 Key 才去选模型 —— 这里要预置默认模型，不然下一步两边都是空
          primeModels();
          ui.step = 'models';
          render();
          return;
        }
      }
      if (ui.step === 'models') {
        ui.step = 'agree';
        render();
        return;
      }
      void i;
      return;
    }
    // 上一步
    if (ui.step === 'agree') {
      // 协议页能退回：配置要等 finish() 才落盘，没点「开始使用」就什么都没存。
      // 但状态必须清干净 —— 勾过同意再退回来，复选框是新建的（没勾），
      // 若 ui.agreeChecked 还留着 true，滚到底就能直接点「开始使用」，等于绕过勾选。
      ui.agreeScrolled = false;
      ui.agreeChecked = false;
      ui.step = 'models';
      render();
      return;
    }
    if (ui.step === 'models' && ui.mode === 'local') {
      ui.step = 'choose';
      render();
      return;
    }
    const idx = STEPS.indexOf(ui.step);
    if (idx > 0) {
      ui.step = STEPS[idx - 1];
      render();
    }
  }

  /** 云端分支：把「这家服务商的默认转写/笔记模型」预选上 */
  function primeModels() {
    const p = ui.provider;
    if (!ui.asrModel) ui.asrModel = defaultModel(p, 'asr') || '';
    if (!ui.llmModel) ui.llmModel = defaultModel(p, 'llm') || '';
  }

  /* ---------- 收尾 ---------- */

  async function finish() {
    ui.busy = '正在保存…';
    ui.error = '';
    render();
    try {
      const patch = {};
      if (ui.mode === 'local') {
        patch.asr = {
          provider: 'local',
          localModel: ui.asrModel,
          localDevice: 'auto',
        };
        patch.llm = { provider: 'local', model: ui.llmModel, enabled: true };
      } else {
        const p = ui.provider;
        const asrPatch = { provider: p, cloudProvider: p, apiKey: ui.key.trim(), model: ui.asrModel };
        const llmPatch = { provider: p, apiKey: ui.key.trim(), model: ui.llmModel, enabled: true };
        if (p === 'custom') {
          asrPatch.endpoint = ui.asrEndpoint.trim();
          // 笔记地址留空时，从转写地址里退一层：/v1/audio/transcriptions → /v1
          llmPatch.baseUrl = (ui.llmBase || '').trim() || guessBase(ui.asrEndpoint);
        }
        patch.asr = asrPatch;
        patch.llm = llmPatch;
      }
      patch.onboard = { done: true };
      await api('/config', { method: 'PUT', body: patch });

      // 协议单独走 /agreement：那条接口还要处理「版本对不对」，
      // 混在 /config 里会让两个校验互相盖掉。
      await api('/agreement', {
        method: 'POST',
        body: { version: state.agreement?.version || '', accepted: true },
      });
      state.agreement = { ...(state.agreement || {}), accepted: true };
      state.config = { ...(state.config || {}), ...patch, onboard: { done: true } };

      ui.busy = '';
      root.hidden = true;
      root.innerHTML = '';
      if (onDone) onDone(patch);
    } catch (e) {
      ui.busy = '';
      ui.error = '保存失败：' + e.message;
      render();
    }
  }

  function guessBase(endpoint) {
    const s = String(endpoint || '').trim().replace(/\/+$/, '');
    const m = s.match(/^(.*)\/audio\/transcriptions$/i);
    return m ? m[1] : s;
  }

  /**
   * 不同意 → 真的退出：后台停掉，窗口也关掉。
   *
   * 老大原话：「如果选不同意，则执行退出关闭页面及后台」。
   *
   * 「关掉窗口」这一步之前漏了 —— 只调了 `/api/shutdown`（后台确实退了，
   * 实测进程没了），但浏览器窗口还留在那儿显示「没有同意协议，程序已退出」，
   * 得用户自己点 ✕。老大反馈的正是这个。
   *
   * 能不能关窗取决于浏览器：启动器是用 `--app=<url>` 开的窗口，那种窗口
   * 只有一个历史条目，Chrome / Edge 都允许脚本 `window.close()` 真的关掉它。
   * 普通标签页（用户自己把地址粘到浏览器里）会被拦，那就退回去显示提示 —— 
   * 拦得住关窗，拦不住我告诉他该点哪儿。
   */
  async function quit() {
    try {
      await api('/shutdown', { method: 'POST' });
    } catch {}
    // 先尝试自己关窗。成功的话下面这个定时器永远不会跑（页面已经销毁）。
    let closed = false;
    try {
      window.close();
      closed = true;
    } catch {}
    void closed;
    setTimeout(() => {
      // 走到这里说明 close() 没生效（普通标签页，或者浏览器策略拦了）
      document.body.innerHTML =
        '<div style="display:grid;place-items:center;height:100vh;font:15px/1.7 system-ui,sans-serif;color:#7c766a;text-align:center">' +
        '<div><div style="width:46px;height:46px;margin:0 auto 14px;border-radius:13px;background:#e7ebf2;display:grid;place-items:center;color:#33507a">' +
        '<svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>' +
        '</div><p>没有同意协议，后台已经退出。</p>' +
        '<p style="font-size:13px">这个窗口你可以直接点右上角的 ✕ 关掉。<br>想重新开始，双击桌面上的「讲义笔记」就行。</p></div></div>';
    }, 260);
    if (onQuit) onQuit();
  }

  function runAuto() {
    ui.busy = '检测中…';
    render();
    detect()
      .then((r) => {
        ui.auto = r;
        ui.localPick = 'auto';
        ui.asrModel = r.asr;
        ui.llmModel = r.llm;
      })
      .catch(() => {})
      .finally(() => {
        ui.busy = '';
        render();
      });
  }

  /* ---------- 对外 ---------- */

  return {
    open() {
      ui.step = 'choose';
      ui.error = '';
      render();
    },
    /** 测试用：直接跳到某一步，省得探针点六次 */
    _jump(step) {
      if (STEPS.includes(step)) {
        ui.step = step;
        render();
      }
    },
    _ui: ui,
  };
}

/**
 * 决定「现在要不要弹引导」。
 *
 * 三件事都得成立：不是手机、配置读到了、引导没走完。
 * 协议没同意不算必须弹引导的理由 —— 老用户升级上来协议会变版本，
 * 那种情况走老的「协议弹窗」，不该让一个已经用了半个月的人重走新手引导。
 */
export function shouldOnboard({ state, remote }) {
  if (remote) return false;
  if (!state.config) return false;
  return state.config.onboard && state.config.onboard.done === false;
}

export { TUTORIALS };
