#!/usr/bin/env node
/**
 * 讲义笔记 LectureNotes —— 零依赖本地服务
 *
 * 只使用 Node 内置模块，无需 npm install / Python / ffmpeg / Docker。
 *
 *   node server.mjs                 # 仅本机访问  http://127.0.0.1:8788
 *   node server.mjs --host 0.0.0.0  # 局域网访问（手机上传录音用）
 *   node server.mjs --port 9000
 *
 * 数据全部存放在 ./data 目录，可整目录备份或拷走。
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
// 云端服务商注册表：前端 public/providers.js 用的是同一个文件，
// 这样「界面里显示的服务商」和「代理真正请求的地址」永远不会各写各的。
import { PROVIDERS, PRICING_CHECKED_AT, listProviders, getProvider, defaultModel, estimateCost, resolveAsrTarget, modelSpec, selfCheck as checkProviders } from './public/providers.js';
import { markdownToDocx } from './docx.mjs';
// PDF 导出：把笔记渲染成独立 HTML，再交给本机浏览器的打印引擎出 PDF。
// 为什么不自己写 PDF 写入器，见 pdf.mjs 开头的说明（中文字体子集 + 上下标字体回退）。
import { noteToPdf } from './pdf.mjs';
// 笔记头部「课程 / 日期 / 时长」的修正逻辑前后端共用一份：
// 界面上渲染时修一次（旧笔记不用重生成也变正常），导出时再修一次
// （导出的 Word 直接落盘，不经过界面）。两处若各写一套迟早会走样。
import { applyNoteHeader } from './public/llm.js';
// 导出时要去掉「需要回听核对的地方」那一节（老大 2026-10-28 定的：导出不带它）。
// 逻辑放在 md.js 里，因为 pdf.mjs 组装 HTML 时也要用同一份规则。
import { stripCheckSection } from './public/md.js';
// 逐字稿的规范化（补时间轴、切超长段、修倒序重叠、保真切句）只写一份，
// 前后端共用。server.mjs 是唯一落盘出口，前端是唯一显示出口，两边规则必须同一套。
import { normalizeTranscript } from './public/transcript.js';
// 确定性清洗（繁→简、非正文码位收窄、半角标点转全角、折叠重复）。
// 前后端共用同一份实现，落盘时服务端再洗一遍 —— 见 writeDoc 里的注释。
import { cleanSegments } from './public/cleanup.js';
// 笔记的血统判断（哪版算法、对哪份逐字稿算的）也只写一份。
// 2026-11-13 起服务端不再重建离线笔记，所以这里也不再需要 analyze()。
import { noteStatus, stampNote, normalizeNote, transcriptFingerprint } from './public/note.js';
// 自动更新：版本比较 / 清单解析 / 下载源排序只写一份，前端与测试共用同一套判断。
// 这里面一个网络请求、一次文件操作都没有 —— 纯函数才好测。
import {
  compareVersion, feedUrls, mirrorUrls, parseFeed, shouldCheck, shouldOffer, formatBytes, versionFromFileName,
} from './update.mjs';
const execFileAsync = promisify(execFile);

/** 读真实显存占用：本地大模型和 WebGPU 转写会抢显存，前端需要据此预警 */
async function readGpu() {
  const exes = ['C:\\Windows\\System32\\nvidia-smi.exe', 'nvidia-smi'];
  for (const exe of exes) {
    try {
      const { stdout } = await execFileAsync(
        exe,
        ['--query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu', '--format=csv,noheader,nounits'],
        { timeout: 8000, windowsHide: true }
      );
      const line = String(stdout).trim().split('\n')[0];
      const [name, total, used, free, util] = line.split(',').map((s) => s.trim());
      return { available: true, name, totalMB: +total, usedMB: +used, freeMB: +free, utilPercent: +util };
    } catch {}
  }
  return { available: false };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ---------------------------------- 参数 ---------------------------------- */
const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes('--' + f);
const argVal = (f, d) => {
  const i = argv.indexOf('--' + f);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const PUBLIC_DIR = path.join(__dirname, 'public');
/**
 * 数据目录：录音、逐字稿、笔记、Key、模型缓存都放这里。
 *
 * 优先级：
 *   1) --data 参数 / LECTURE_DATA 环境变量 —— 测试和排障要能钉死一个目录
 *   2) 程序旁边**已经有** data/ —— 绿色版：整个文件夹连数据一起拷走就是备份
 *   3) %LOCALAPPDATA%\LectureNotes\data —— 默认位置，跟其它 Windows 软件一样放 C 盘
 *
 * 第 2 条为什么要求「已经有」而不是「能写就新建」：
 * 以前是「程序目录能写就在旁边新建 data」，结果解压到 D 盘的绿色版会在 D 盘
 * 凭空长出一个 data 目录 —— 买家没有 D 盘、或者 D 盘是移动硬盘/只读盘时就会
 * 出问题，而这本来只是他解压时随手选的一个位置。现在改成「看到 data 才用」：
 * 想便携就自己建一个（或从旧机器连数据一起拷过来），否则一律按普通软件装到 C 盘。
 *
 * 第 2 条仍要检查可写性：data 目录可能是安装包建的空的，也可能是从只读介质
 * 拷过来的，只判断存在就会选中一个写不进去的地方。
 */
function pickDataDir() {
  if (process.env.LECTURE_DATA) return path.resolve(process.env.LECTURE_DATA);
  const explicit = argVal('data', null);
  if (explicit) return path.resolve(explicit);

  const beside = path.join(__dirname, 'data');
  if (fs.existsSync(beside)) {
    try {
      fs.accessSync(beside, fs.constants.W_OK);
      return beside;
    } catch {
      // 只读目录（典型：C:\Program Files\LectureNotes\data，或只读介质）—— 往下走
    }
  }
  const home = process.env.LOCALAPPDATA || process.env.USERPROFILE || os.homedir();
  return path.join(home, 'LectureNotes', 'data');
}

const DATA_DIR = pickDataDir();
/**
 * 两个「大件」的实际位置 —— 录音（含逐字稿、笔记）和模型缓存。
 *
 * 为什么不写成 const：老大要求「录音存储、缓存这些路径能自由更改，不改就用默认」。
 * 数据目录本身（配置文件所在）没法这样改 —— 配置就存在数据目录里，
 * 想改它得先读配置，是先有鸡还是先有蛋的问题。所以数据目录仍然走
 * --data / LECTURE_DATA（只有排障和测试才需要动）。
 *
 * 而这两个目录加起来是整个程序里最占地方的部分（实测模型缓存 3.5G、
 * 录音 187M），用户想挪动的动机也几乎只有「C 盘满了」。所以它们单独可配。
 */
const LECT_DIR_DEFAULT = path.join(DATA_DIR, 'lectures');
const MODELS_DIR_DEFAULT = path.join(DATA_DIR, 'models');
let LECT_DIR = LECT_DIR_DEFAULT;
let HF_CACHE = MODELS_DIR_DEFAULT;
/**
 * 当前实际生效的存储位置 + 有没有从自定义退回默认。
 *
 * 要记录 error 的原因：用户填了 D:\录音 但那个盘没插，我们不能让整个程序起不来
 * （起不来 = 连界面都进不去 = 没法去改回来，死锁）。所以退回默认位置继续跑，
 * 但必须在界面上说清楚「你填的那个用不了，现在用的是默认位置」。
 * 悄悄退回是最坏的做法 —— 用户会以为录音存到 D 盘了，其实在 C 盘，
 * 等到某天「录音不见了」才发现。
 */
const storageState = {
  lectures: { dir: LECT_DIR_DEFAULT, custom: false, error: '' },
  models: { dir: MODELS_DIR_DEFAULT, custom: false, error: '' },
};
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
// 试用/授权记录单独一个文件：mix 进 config.json 的话，用户「还原设置」一次
// 就把试用期重置了；分开存，语义清楚，用户真想重装也不会被我们为难。
const STATE_FILE = path.join(DATA_DIR, 'state.json');
// 数据目录不在程序旁边时，界面上要能说清楚东西存哪了（用户找不到录音会来问）
const DATA_DIR_PORTABLE = DATA_DIR === path.join(__dirname, 'data');
// 版本号必须和 packaging\lecture-notes.iss 里的 AppVersion 一致，
// 否则安装包显示的版本和界面显示的版本对不上（打包脚本会核对这一条）。
const VERSION = '0.9.0';
/**
 * 用户协议 / 隐私政策的版本号。
 *
 * 不用手写「v1」「v2」这种数字 —— 手写的迟早会忘记改：改了条款没改版本号，
 * 老用户就永远不会被重新问一次，这在合规上是硬伤。
 * 这里改成「两个文件内容各算一个短哈希拼起来」，条款动一个字版本就变，
 * 动不了字就一模一样，不会因为重新打包、换行符而误伤老用户。
 *
 * 2026-11-17 起 key 叫 agreement 不叫 license：LICENSE.txt 那份专有 EULA
 * 拆成了 AGREEMENT.txt（本协议，还要用户点同意）+ LICENSE（AGPL-3.0 全文，
 * 不用点同意，开源协议不是「你签的合同」）。key 名字不改的话，界面上
 * 「用户协议」那个标签页读到的会是一整篇 AGPL 英文原文。
 */
const AGREE_FILES = { agreement: 'AGREEMENT.txt', privacy: 'PRIVACY.txt' };
const AGREE_VERSION = (() => {
  const h = createHash('sha256');
  for (const name of Object.values(AGREE_FILES)) {
    try {
      // 统一换行符：Windows 检出成 CRLF、Linux 成 LF 时不应算两个版本
      h.update(fs.readFileSync(path.join(__dirname, name), 'utf8').replace(/\r\n/g, '\n'));
    } catch {
      h.update('\u0000missing:' + name);
    }
  }
  return 'r' + h.digest('hex').slice(0, 12);
})();

/** 读两个协议的正文；文件缺失时给个可读的占位，不让接口 500 */
async function readAgreementText() {
  const out = {};
  for (const [key, name] of Object.entries(AGREE_FILES)) {
    try {
      out[key] = (await fsp.readFile(path.join(__dirname, name), 'utf8')).replace(/\r\n/g, '\n');
    } catch {
      out[key] = `（没找到 ${name}，可能安装不完整，请重新安装或从官网下载完整安装包）`;
    }
  }
  return out;
}

/**
 * 安装向导里已经点过「我接受」的话，首启就别再弹一遍。
 *
 * 安装程序（packaging/lecture-notes.iss 的 CurStepChanged）在安装完成时往
 * `data\install-agreed.txt` 写一行安装时间；这里把它读进来当成一次同意。
 * 读不到、或者 config 里已经有同意记录，就什么也不做（幂等）。
 * 为什么不在安装时直接写 config.json：那时候 node 还没跑过，config.json
 * 不存在，安装脚本没法保证字段结构和 DEFAULT_CONFIG 一致 —— 宁可让服务
 * 自己合并，也不要安装器拼一份可能过时的 JSON 出来。
 */
let installerAgreementChecked = false;
async function adoptInstallerAgreement() {
  if (installerAgreementChecked) return;
  installerAgreementChecked = true;
  if ((config.agreement?.version || '') === AGREE_VERSION) return;
  try {
    const raw = (await fsp.readFile(path.join(DATA_DIR, 'install-agreed.txt'), 'utf8')).trim();
    if (!raw) return;
    // 安装程序写的是本地时间 `2026-10-20 13:45:02`，转成 ISO 存
    const at = new Date(raw.replace(' ', 'T'));
    const acceptedAt = Number.isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString();
    await saveConfig({ agreement: { version: AGREE_VERSION, acceptedAt } });
  } catch {
    // 文件不存在是正常情况（绿色版、开发环境都没有）
  }
}

/* ------------------------------ 打赏提醒 ------------------------------ */
/**
 * 这一次「启动」的编号。
 *
 * 前端传上来的 bootId 跟它对不上，就说明浏览器还记着上一次启动的页面
 * （用户关了浏览器没关服务、或者服务崩溃后被启动器重新拉起来但页面没刷），
 * 这时候不算「新的一次打开」。
 */
const BOOT_ID = Math.floor(Date.now() / 1000);

/** 服务启动时间，用来做「十分钟内不重复弹」的第二道保险 */
const BOOT_AT = Date.now();

/**
 * 该不该自动弹打赏窗。
 *
 * 老大的要求：「每次开机时以弹窗形式出现…叉掉后不再提示，如果没勾选就每次启动时弹出」。
 * 翻译成判断：
 *   1. 用户勾过「不再提示」→ 永不自动弹（设置里那个入口还在）
 *   2. 浏览器报上来的 bootId 等于当前这一次启动 → 这次已经弹过了
 *      （刷新页面、切标签、前进后退都还在同一次启动里，不该重复弹）
 *   3. 距上次弹不到 2 分钟 → 不弹（防止启动器崩溃后被自动拉起，把用户连弹好几遍）
 *
 * @param seenBootId 前端上次见到的那次启动编号（存在 localStorage 里，关浏览器也在）
 */
function shouldShowDonate(seenBootId) {
  if (config.donate?.hideOnStartup) return false;
  if (Number(seenBootId) === BOOT_ID) return false;
  const last = Date.parse(config.donate?.lastShownAt || '');
  if (Number.isFinite(last) && Date.now() - last < 2 * 60 * 1000) return false;
  return true;
}

/**
 * 更新公告该不该弹：记忆里看过的版本跟当前版本对不上就弹。
 * 新装时 loadConfig() 会把 seenVersion 初始化成当前版本，所以第一次打开不打扰。
 * 弹过之后前端 POST 写回当前版本，刷新、重启都不再弹，直到下次真的升级。
 */
function shouldShowWhatsNew() {
  return (config.whatsNew?.seenVersion || '') !== VERSION;
}

/** 更新公告正文：安装目录里的 CHANGELOG.md（跟程序一起发，改文案不用动代码）。 */
async function readChangelog() {
  try {
    return await fsp.readFile(path.join(__dirname, 'CHANGELOG.md'), 'utf8');
  } catch {
    return '';
  }
}

/** 收款码有没有放。放的是 .jpg 还是 .png 都认，界面自己会按同名字找。 */
function donateCodesPresent() {
  const dir = path.join(__dirname, 'public', 'donate');
  const out = {};
  for (const name of ['wechat', 'alipay']) {
    out[name] = ['png', 'jpg', 'jpeg', 'webp'].some((ext) => {
      try {
        return fs.statSync(path.join(dir, `${name}.${ext}`)).size > 0;
      } catch {
        return false;
      }
    });
  }
  return out;
}

// 端口：命令行/环境变量显式指定就用指定的（测试和排障要能钉死一个端口）。
// 没指定时走「这台机器自己的端口」——首次启动随机挑一个存进 data/instance.json，
// 以后每次都用它。这样两台电脑上装同一份程序，地址天然不一样，不会互相串台。
const PORT_FIXED = !!(process.env.PORT || argVal('port', null));
let PORT = Number(process.env.PORT || argVal('port', 8788));
const HOST = process.env.HOST || argVal('host', '127.0.0.1');
const MAX_UPLOAD = Number(argVal('max-upload-mb', 800)) * 1024 * 1024;

/* -------------------------------- 默认配置 -------------------------------- */
const DEFAULT_CONFIG = {
  asr: {
    // local = 浏览器内本地 Whisper；否则走服务端代理调用云 API
    // 可选 id 见 public/providers.js（local / siliconflow / openai / custom）
    provider: 'local', // local | siliconflow | openai | custom
    /** 云端转写用哪一家（与 provider 同义，留在配置里方便界面回显；provider=local 时忽略） */
    cloudProvider: 'siliconflow',
    language: 'zh', // zh | en | auto
    localModel: 'onnx-community/whisper-base',
    localDevice: 'auto', // auto | webgpu | wasm
    cdn: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3',
    modelHost: 'https://hf-mirror.com', // 国内推荐；官方源 https://huggingface.co
    endpoint: '', // provider=custom 时的 OpenAI 兼容 /audio/transcriptions 地址
    apiKey: '',
    model: '', // 云端模型名，留空用预设
    denoise: true, // 转写前跑抗噪（谱减 + 噪声底追踪 + VAD 门限 + 工频陷波）
  },
  llm: {
    // 默认就打开。离线引擎出的笔记老大原话「一般都不能看」，把开关默认关着，
    // 等于默认给人一份不能看的笔记，还得自己去设置里发现「原来还有个开关」。
    // 打开不等于真的会用：没填 Key / 没装本地模型时前端 llmUsable() 会拦住，
    // 不会每转写一条就白等一轮再报错。
    enabled: true,
    /** 服务商 id（public/providers.js 里的 id），界面下拉选中后会自动填 baseUrl 与 model */
    provider: 'local',
    baseUrl: 'http://127.0.0.1:8080/v1',
    apiKey: '',
    model: 'qwen2.5-7b',
    temperature: 0.3,
    timeoutMs: 180000,
    extraPrompt: '',
  },
  notes: {
    title: '',
    course: '',
    style: 'exam', // exam 应试 | outline 提纲 | cornell 康奈尔
    maxPointsPerTopic: 6,
    topKeywords: 20,
  },
  /**
   * 存储位置。
   *
   * 老大要求：「录音存储、缓存这些路径改成可自由更改，不改的话有默认路径」。
   * 空串 = 用默认位置（数据目录下的 lectures / models），这样界面上能显示
   * 真实的默认路径，用户也能一键改回默认，而不是留一个看不懂的占位符。
   *
   * 注意这里**只存路径字符串**，真正的目录在启动时由 applyStorageConfig()
   * 决定能不能用。填错了不会让程序起不来，只会退回默认 + 界面上报错。
   */
  storage: {
    /** 录音（音频 + 逐字稿 + 笔记）存哪；空 = 数据目录\lectures */
    lecturesDir: '',
    /** 模型缓存（HuggingFace 那些 onnx）存哪；空 = 数据目录\models */
    modelsDir: '',
  },
  /**
   * 手机访问（局域网）。
   *
   * 2026-10-24 加：以前启动器无条件 `--host 0.0.0.0`，用户双击一下就在
   * 校园网 / 咖啡厅 Wi-Fi 上把服务和全部课堂录音敞开了，自己毫不知情，
   * 唯一屏障是 URL 里那串密钥 —— 而 URL 会进浏览器历史、截图、聊天记录。
   *
   * 现在改成显式开关：默认 false，非本机请求一律 403（连 404 都不给，
   * 不告诉外人这里有个服务）。要传手机录音时在界面上点一下开，
   * 关掉就立刻收紧。socket 仍然绑 0.0.0.0（不然开关要重启进程才生效，
   * 体验太差），但没开开关时数据一个字节都出不去。
   */
  lan: {
    /** 是否允许局域网（手机、平板、另一台电脑）访问 */
    enabled: false,
  },
  /**
   * 保存过的 API Key 清单。
   *
   * 为什么不直接读 asr.apiKey / llm.apiKey：
   * 那两处只是「当前正在用哪一把」，换一家服务商就被覆盖，用户之前填的 Key 就没了。
   * 老大原话：「如果有多个key的话，弄个下拉菜单，只要保存后就可以下拉选择」。
   * 所以另存一份清单，保存过的都留着，界面上做成下拉，换回来不用重新粘贴。
   *
   * 每项的 key 只在「本机浏览器」请求时才回传给界面（见 publicConfig）：
   * 局域网里别人拿到入口地址也读不到明文。
   */
  keyVault: [],
  /**
   * 用户协议 / 隐私政策的同意记录。
   *
   * 为什么存在服务端而不是 localStorage：
   * 用户可能换浏览器、用手机打开同一个服务，localStorage 是各浏览器各一份，
   * 会反复弹。存在数据目录里才是「这台机器上同意过」。
   * 但也不该藏得太深：界面上「设置 → 关于」永远能重新看到全文。
   */
  agreement: {
    /** 同意时生效的协议版本；协议改版后要重新征求同意 */
    version: '',
    /** 同意时间（ISO），空表示还没同意过 */
    acceptedAt: '',
  },
  /**
   * 打赏弹窗的记忆。
   *
   * 老大要求：「每次开机时以弹窗形式出现，并且下面给出自由勾选框，叉掉后不再提示，
   * 如果没勾选就每次启动时弹出」。
   *
   * 所以只有两个字段，且都只由用户主动点/勾时写：
   *   hideOnStartup —— 勾了「以后不再提示」才为 true，之后永不自动弹
   *   lastShownAt   —— 上次自动弹的时间。用它是为了同一台机器上「刷新页面」不重复弹，
   *                    真正的判断是「这次启动算不算新的一次开机」（见 server 里的 shouldShowDonate）。
   *
   * 为什么放服务端而不是 localStorage：手机和电脑打开的是同一个本地服务，
   * 用户在电脑上勾了「不再提示」，拿手机打开又弹一遍就很蠢。
   */
  donate: {
    hideOnStartup: false,
    lastShownAt: '',
  },
  /**
   * 新手引导走完了没有。
   *
   * 老大要求：「软件首次启动时加上一段新手引导」。
   * 为什么放服务端而不是 localStorage：手机和电脑打开的是同一个本地服务，
   * 而且用户清一次浏览器缓存不该被重新问一遍「你想用本地还是云端」——
   * 那是配置问题，不是浏览器状态。
   *
   * 只记「走完了」这一个事实，不记用户在哪一步选了什么：选的东西会落到
   * asr.provider / asr.localModel / llm.model 那几个既有字段里，不要第二份真相。
   */
  onboard: {
    done: false,
  },
  /**
   * 自动更新。
   *
   * 老大问「所以学习他可以做到自动更新吗」，答「能」之后定下的两条：
   * 装到用户目录（免 UAC，更新包才写得进去）、文件放 GitHub Releases。
   *
   * 字段都只记「用户的选择」和「多久查一次」：
   *   enabled        —— 用户可以在设置里关掉。关掉就是一次网络都不发。
   *   lastCheckAt    —— 上次真正发出检查请求的时间，用来节流（不是每次开界面都打）。
   *   lastVersion    —— 上次检查看到的最新版本，界面不用重新请求就能显示。
   *   ignoredVersion —— 用户点了「跳过这个版本」，之后这个名字不再提示。
   *
   * repo / feedUrl 是「更新源」，默认指向发布仓库。为什么允许改：
   *   ① 作者自己换仓库时不用重新发版；
   *   ② 别人 fork 后想用同一套更新机制，改一行配置就行；
   *   ③ 内网/镜像部署时可以直接指向一份静态 latest.json。
   * 两者只用一个：feedUrl 有值就完全以它为准。
   */
  update: {
    enabled: true,
    repo: 'KWY-457/lecture-notes',
    feedUrl: '',
    lastCheckAt: '',
    lastVersion: '',
    ignoredVersion: '',
  },
  /**
   * 更新公告弹窗的记忆。
   *
   * 老大要求：「只在更新后弹一次，展示更新内容或 bug 修复，让用户直观看到变化」。
   * 做法：记下「用户已经看过哪一版」的公告，跟当前 VERSION 对不上就弹。
   *   - 新装：初始化时就写成当前版本 → 第一次打开不打扰（那时有新手引导）
   *   - 老用户升级：config 里没有这个字段，deepMerge 补成空串 → 弹一次
   *   - 弹过之后 POST 一次写回当前版本 → 刷新、重启都不再弹，直到下次真更新
   * 为什么存服务端不存 localStorage：跟协议/打赏一个道理，同一台机器多个浏览器
   * 打开的是同一个服务，不该每个浏览器各弹一遍。
   */
  whatsNew: {
    seenVersion: '',
  },
};

/** 「整理 1.5 小时的课大概多少钱」——只对写了单价的模型给结果，其余返回 null */
function estimateNoteCost(id, modelId, hours = 1.5) {
  try {
    return estimateCost(id, modelId, hours);
  } catch {
    return null;
  }
}

// 启动时自查服务商注册表：id 重复会让「界面显示的地址」和「代理请求的地址」不一致，
// 与其以后莫名其妙报 404，不如现在就在控制台说清楚。
{
  const problems = checkProviders();
  if (problems.length) {
    console.error('[配置自查] public/providers.js 有问题：');
    for (const p of problems) console.error('  - ' + p);
  }
}


/* --------------------------------- 工具 ---------------------------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.webm': 'audio/webm',
  '.flac': 'audio/flac',
  '.amr': 'audio/amr',
  '.3gp': 'audio/3gpp',
  '.wma': 'audio/x-ms-wma',
};

const json = (res, code, obj) => {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
};
const fail = (res, code, message, extra) => json(res, code, { ok: false, error: message, ...(extra || {}) });
const safeId = (s) => (/^[a-zA-Z0-9_-]{6,64}$/.test(String(s || '')) ? String(s) : null);
const readBody = (req, limit = 8 * 1024 * 1024) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
const readJsonBody = async (req, limit) => {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new Error('JSON 解析失败');
  }
};
const deepMerge = (base, patch) => {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(base) || typeof base !== 'object' || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = { ...base };
  for (const k of Object.keys(patch)) out[k] = deepMerge(base[k], patch[k]);
  return out;
};
/**
 * 去掉文件开头的 BOM 再解析。
 * 为什么必须这么做：Windows 记事本、PowerShell 的 Out-File / Set-Content 存 UTF-8 时
 * 默认会加 BOM，而 JSON.parse 见到 U+FEFF 直接抛 "Unexpected token"。
 * 曾经的后果：一条录音的 meta.json 被加过 BOM，readMeta 返回 null，
 * listLectures 就把它静默跳过 —— 文件还在硬盘上，界面里却整条消失了。
 */
const parseJsonText = (text) => JSON.parse(String(text).replace(/^\uFEFF/, ''));

/* ------------------------------ 本机身份 --------------------------------- */
/**
 * 每份安装的「门牌号」：随机端口 + 随机入口密钥。
 *
 * 目的很实际：这个服务能读用户的全部录音、能用用户的 API Key 花钱。
 * 只靠端口区分是不够的——端口是公开信息，同一 Wi-Fi 下随便扫一下就能撞见。
 * 所以第一次启动时随机生成一串 128 位密钥，藏在地址路径里：
 *
 *     http://192.168.1.4:24873/k7q2m9x1f4h8p3v6/
 *
 * 别人就算扫到了端口，不知道这串密钥，请求会直接 404（不是 403 ——
 * 连「这里有个服务」都不告诉外人）。密钥只存在本机 data/instance.json，
 * 不上报、不联网，拷走整个文件夹一起备份。
 *
 * 同一台机器上重装、重启，密钥不变（否则手机上的书签就废了）。
 * 想换一个？删掉 data/instance.json 重启即可。
 */
const INSTANCE_FILE = path.join(DATA_DIR, 'instance.json');
let instance = null;

function newSecret(len = 10) {
  // 去掉容易看错/念错的字符（0 O o 1 l I），方便用户手动敲或口述
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

async function loadInstance() {
  try {
    const raw = await fsp.readFile(INSTANCE_FILE, 'utf8');
    const it = parseJsonText(raw);
    if (it && typeof it.secret === 'string' && /^[a-z0-9]{6,32}$/.test(it.secret)) {
      instance = it;
      return instance;
    }
  } catch {}
  // 第一次运行：生成一个，落到数据目录里
  const it = {
    secret: newSecret(10),
    port: 20000 + (randomBytes(2).readUInt16BE(0) % 20000), // 20000-39999
    createdAt: new Date().toISOString(),
  };
  instance = it;
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await fsp.writeFile(INSTANCE_FILE, JSON.stringify(it, null, 2), 'utf8');
  } catch {
    // 写不进去（只读目录）也不致命：本次运行照样有密钥，只是下次会变。
  }
  return instance;
}

/** 入口路径前缀，带首尾斜杠：/k7q2m9x1f4h8p3v6/ */
const entryPrefix = () => `/${instance?.secret || ''}/`;

/** 请求是不是来自本机（用户自己电脑上的浏览器） */
function isLoopback(req) {
  const ip = String(req.socket?.remoteAddress || '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/**
 * 把请求路径里的入口密钥剥掉。
 * 返回 null 表示「这个路径没有带正确的密钥」——调用方负责回 404。
 *
 * 放行三种情况：
 *   1) /api/health —— 启动器靠它识别「这个端口上是不是本程序」。
 *      它只回版本号和端口，不含任何用户数据。
 *   2) 本机回环地址（127.0.0.1 / ::1）—— 用户自己电脑上开着的程序，
 *      再让他敲一串密钥纯属折磨。
 *   3) 带着正确 ln_entry cookie 的请求 —— 手机第一次用带密钥的地址打开后，
 *      服务器种下这个 cookie 并跳转到根路径，之后就和自己电脑上一样好用了。
 *
 * 其余一律 null（回 404，不说「你没权限」，连「这里有个服务」都不告诉外人）。
 */
function stripEntry(pathname, req) {
  const secret = instance?.secret || '';
  const loopback = isLoopback(req);
  // 局域网开关关着时，非本机请求一律拒。放在最前面：连密钥都不验了，
  // 因为「关着」的语义是「这台机器不对外提供服务」，不是「密钥错了」。
  if (!loopback && !lanAllowed()) return { path: pathname, granted: false, lanOff: true };
  if (!secret) return { path: pathname, granted: true };
  // 带密钥的路径：/<secret>/... 或 /<secret>
  if (pathname === '/' + secret || pathname.startsWith('/' + secret + '/')) {
    const rest = pathname.slice(secret.length + 1);
    return { path: rest || '/', granted: true, bare: true };
  }
  if (loopback) return { path: pathname, granted: true };
  if (cookieHasEntry(req)) return { path: pathname, granted: true };
  if (pathname === '/api/health' || pathname === '/health') return { path: pathname, granted: true };
  return { path: pathname, granted: false };
}

/** 局域网开关（config.lan.enabled）。读不到配置就当关着 —— 失败要往安全那边倒。 */
function lanAllowed() {
  try {
    return config?.lan?.enabled === true;
  } catch {
    return false;
  }
}

/** 请求带的 cookie 里有没有本机密钥（局域网首次用带密钥的地址打开后就会种上） */
function cookieHasEntry(req) {
  const raw = String(req.headers.cookie || '');
  if (!raw || !instance?.secret) return false;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === 'ln_entry' && part.slice(i + 1).trim() === instance.secret) return true;
  }
  return false;
}

/* ------------------------------ 运行期状态文件 ---------------------------- */
/**
 * 服务真正监听成功后，把自己「在哪」写给启动器看：端口、入口密钥、PID。
 * 启动器（启动.vbs）不会算端口，它只负责读这个文件然后开浏览器。
 * 进程退出时删掉，这样「服务还在不在」一目了然。
 */
const RUNTIME_FILE = path.join(DATA_DIR, 'runtime.json');
async function clearRuntime() {
  try {
    const cur = parseJsonText(await fsp.readFile(RUNTIME_FILE, 'utf8'));
    // 只删自己的，别把刚启动的新进程的文件删了
    if (cur && cur.pid === process.pid) await fsp.rm(RUNTIME_FILE, { force: true });
  } catch {}
}

/**
 * 这个文件是「启动器该打开哪个地址」的唯一真相，所以**不能随便覆盖**。
 *
 * 踩过的坑：用户在已经有一个实例（23169）跑着的时候又双击了一次启动，
 * 新进程把自己算出来的 23455 写进去，于是 runtime.json 指向 23455；那个
 * 新进程随后退出了，文件却留了下来（它退出时只删「pid 是自己」的文件，
 * 而文件里的 pid 这时已经不是它了）。下一次启动照着 23455 去问，问不到，
 * 就当成「没人在跑」又起一个 —— 用户于是有两套浏览器缓存。
 *
 * 所以：文件里那个人还活着、还确实是本程序（probeSelf 认过），就不动它。
 * 返回 { conflict: 端口 } 让调用方决定要不要提示。
 */
async function writeRuntime() {
  let prev = null;
  try {
    prev = parseJsonText(await fsp.readFile(RUNTIME_FILE, 'utf8'));
  } catch {
    /* 第一次启动，没有这个文件 */
  }
  if (prev && Number(prev.pid) > 0 && Number(prev.pid) !== process.pid) {
    let alive = false;
    try {
      process.kill(Number(prev.pid), 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive && (await probeSelf(Number(prev.port)))) {
      return { conflict: Number(prev.port) };
    }
  }
  const info = {
    pid: process.pid,
    port: PORT,
    secret: instance.secret,
    url: `http://127.0.0.1:${PORT}${entryPrefix()}`,
    lanUrls: HOST === '0.0.0.0' || HOST === '::'
      ? lanAddresses().map((ip) => `http://${ip}:${PORT}${entryPrefix()}`)
      : [],
    // 数据目录也写进来：helpers\setup-local-llm.ps1 靠它决定本地模型装到哪 ——
    // 装 Program Files 时数据在 %LOCALAPPDATA%，模型也必须跟着去那儿，否则写不进去。
    dataDir: DATA_DIR,
    startedAt: new Date().toISOString(),
  };
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(RUNTIME_FILE, JSON.stringify(info, null, 2), 'utf8');
  return info;
}

/* --------------------------------- 配置 ---------------------------------- */
let config = structuredClone(DEFAULT_CONFIG);
async function loadConfig() {
  await readConfigFile();
  migrateLegacyProviders();
  migrateUpdateRepo();
}
async function readConfigFile() {
  let raw = null;
  try {
    raw = await fsp.readFile(CONFIG_FILE, 'utf8');
    config = deepMerge(structuredClone(DEFAULT_CONFIG), parseJsonText(raw));
    return;
  } catch (e) {
    // 文件不存在 = 第一次运行，安静地用默认值即可。
    if (!raw) {
      config = structuredClone(DEFAULT_CONFIG);
      // 新装：更新公告记成「已看过当前版」，第一次打开不弹（那时有新手引导）。
      // 老用户升级时 config.json 已存在、没有这个字段，deepMerge 补成空串 → 会弹一次。
      config.whatsNew.seenVersion = VERSION;
      await saveConfig({}).catch(() => {});
      return;
    }
    // 文件在但读不出来（被手动编辑坏、断电写一半、存成了别的编码）：
    // 不能默默丢掉用户的 Key 和设置。先留一份原样备份，再报一句人话。
    const backup = CONFIG_FILE + '.broken-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    await fsp.writeFile(backup, raw, 'utf8').catch(() => {});
    console.warn('');
    console.warn('  [提示] 配置文件读不出来，已按默认设置启动。');
    console.warn('         原文件备份在： ' + backup);
    console.warn('         原因： ' + (e.message || e));
    console.warn('         如果里面有 API Key，可以从备份里找回来，在设置里重新填一次即可。');
    console.warn('');
    config = structuredClone(DEFAULT_CONFIG);
  }
}
/**
 * 把老版本配置里的服务商 id 挪到新的一批 id 上。
 *
 * 2026-10-21 把服务商从 11 家收敛成 4 家（硅基流动 / OpenAI / 本地 / 自定义），
 * 删掉的 id 有：deepseek、dashscope（百炼）、zhipu、moonshot、groq、
 * local-llm、ollama、lmstudio、custom-llm。
 *
 * 不能直接让它们变成「未知服务商」：老用户存着 Key、配好了地址，升级完一开
 * 就发现转写/笔记不工作了，还得自己猜该改成什么。所以按「还能不能继续用」分两类：
 *
 *   A) 那家本来就是 OpenAI 兼容的独立服务商（DeepSeek / 百炼 / 智谱 / Kimi / Groq）
 *      → 地址和模型名原样保留，只把 provider 改成 'custom'。
 *        独立服务商和「自定义」发的是同一种请求，改个 id 就能继续用，
 *        用户的 Key 不用重填。界面会显示「自定义」，并在模型卡片里标成手填模型。
 *
 *   B) 本机那几条（local-llm / ollama / lmstudio / custom-llm）
 *      → 全归到 'local'。它们的 baseUrl 都是 127.0.0.1，功能上就是「本地」，
 *        合并之后用户不用再区分「本机大模型」和「本机 Ollama」。
 *
 * 只改内存里的 config 并落盘一次，不再每轮都跑。
 */
const LEGACY_PROVIDER_MAP = {
  asr: {
    // 只有云端那几家有明确的替代（本机转写只有 local 一条）
    groq: 'custom',
    'custom-llm': 'custom',
  },
  llm: {
    deepseek: 'custom',
    dashscope: 'custom',
    zhipu: 'custom',
    moonshot: 'custom',
    'custom-llm': 'custom',
    // 本机那三条全部归到 local
    'local-llm': 'local',
    ollama: 'local',
    lmstudio: 'local',
  },
};

/**
 * 老 id 对应的接口地址 / 默认模型 —— 只在「用户配置里那格是空的」时才兜底。
 *
 * 为什么需要这张表：改成 'custom' 之后，custom 的服务商注册表里**没有预设地址**
 * （地址必须用户自己填）。老用户的 config 里 endpoint 可能是空串（早期版本
 * 选服务商时不会把地址写进配置，只有界面输入框里回填了）。升级后一保存就变成
 * 「缺接口地址」——明明昨天还能用。所以这里把已知的老地址补进去。
 *
 * 这些 URL 写死在代码里是**故意**的：它们已经不在注册表里了，只用于迁移，
 * 将来服务商改域名也不会影响已经迁移过来的用户（他们可以自己改）。
 */
const LEGACY_ENDPOINTS = {
  asr: {
    groq: 'https://api.groq.com/openai/v1/audio/transcriptions',
  },
  llm: {
    deepseek: 'https://api.deepseek.com/v1',
    dashscope: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    zhipu: 'https://open.bigmodel.cn/api/paas/v4',
    moonshot: 'https://api.moonshot.cn/v1',
  },
};
/** 老 id 的默认模型：只为让迁移后「模型名那一格」不是空的 */
const LEGACY_MODELS = {
  asr: { groq: 'whisper-large-v3-turbo' },
  llm: {
    deepseek: 'deepseek-chat',
    dashscope: 'qwen-plus',
    zhipu: 'glm-4-flash',
    moonshot: 'moonshot-v1-32k',
  },
};
function migrateLegacyProviders() {
  let touched = false;
  for (const kind of ['asr', 'llm']) {
    const map = LEGACY_PROVIDER_MAP[kind];
    const seg = config[kind];
    if (!seg || !seg.provider) continue;
    const was = seg.provider;
    const next = map[was];
    if (!next || next === was) continue;
    seg.provider = next;
    touched = true;
    console.log(`  [配置迁移] ${kind}.provider: ${was} → ${next}`);

    // 地址：转写存 endpoint，笔记存 baseUrl。只在空的时候补，用户填过的不动。
    const urlField = kind === 'asr' ? 'endpoint' : 'baseUrl';
    const legacyUrl = (LEGACY_ENDPOINTS[kind] || {})[was];
    if (next === 'custom' && !String(seg[urlField] || '').trim() && legacyUrl) {
      seg[urlField] = legacyUrl;
      console.log(`  [配置迁移] ${kind}.${urlField} 补上 ${legacyUrl}`);
    }
    const legacyModel = (LEGACY_MODELS[kind] || {})[was];
    if (!String(seg.model || '').trim() && legacyModel) {
      seg.model = legacyModel;
      console.log(`  [配置迁移] ${kind}.model 补上 ${legacyModel}`);
    }
  }
  if (touched) {
    // 落盘的事交给调用方（启动时 readConfigFile 之后调一次；
    // 这里直接写，失败了也只是下次启动再迁移一遍，不影响使用）
    saveConfig({}).catch(() => {});
  }
}

/**
 * 把「检查更新」用的仓库地址从占位值迁到真实值。
 *
 * 2026-11-21 真机踩出来的 bug：开发期的默认值一直是占位字符串
 * `lecture-notes/lecture-notes`（那时仓库还没建）。仓库建好之后
 * `DEFAULT_CONFIG.update.repo` 改成了真实地址，但 `deepMerge` 只补**缺失**的键、
 * **不覆盖已有值** —— 于是凡是这个字段写进过 config.json 的机器（也就是所有
 * 装过旧版本的机器），永远拿占位值去查 `api.github.com/repos/lecture-notes/lecture-notes`
 * → 404 → 自动更新对**全体老用户**静默失效，界面上什么错都不显示。
 *
 * 所以必须有一条显式迁移。只改这一个已知的旧值，用户自己填过别的一律不动
 * （有人会填镜像仓库，那是合理需求）。
 */
const LEGACY_UPDATE_REPOS = new Set(['lecture-notes/lecture-notes']);
function migrateUpdateRepo() {
  const cur = String(config.update?.repo || '').trim();
  if (!cur || !LEGACY_UPDATE_REPOS.has(cur)) return;
  const next = DEFAULT_CONFIG.update.repo;
  if (!next || next === cur) return;
  config.update.repo = next;
  console.log(`  [配置迁移] update.repo: ${cur} → ${next}`);
  saveConfig({}).catch(() => {});
}

async function saveConfig(patch) {
  // 先落盘再改内存：写盘失败（磁盘满、只读、权限不足）时，内存里也不能变 ——
  // 否则界面显示「已保存」，重启后又变回去，用户完全不知道发生了什么。
  const next = deepMerge(config, patch || {});
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  config = next;
  return config;
}

/**
 * 把一个用户填的路径整理成可用的绝对路径。
 *
 * 返回 { dir } 或 { error }。检查顺序是有讲究的：
 *   1) 空 → 用默认（这不是错误，是「不改」的表示法）
 *   2) 展开 %VAR% 和开头的 ~ —— 用户从别处复制路径时带着环境变量很常见
 *   3) 必须是绝对路径 —— 相对路径的含义取决于「从哪启动的」，
 *      双击 启动.vbs 和从命令行起，工作目录不一样，存到两个地方就找不到了
 *   4) 不能是盘符根目录（D:\ 这种）—— 下面要在里面建 lectures/models 子目录，
 *      把用户的整个 D 盘当成数据目录太危险，删录音时会波及别的东西
 *   5) 真去建一次并试写 —— 路径合法不代表能写：盘没插、只读、权限不足，
 *      都要在这一步暴露出来，而不是等到用户录完一节课保存时才炸
 */
function resolveStorageDir(raw, fallback) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { dir: fallback, custom: false, error: '' };

  const expanded = text
    .replace(/%([^%]+)%/g, (m, name) => process.env[name] || process.env[name.toUpperCase()] || m)
    .replace(/^~(?=$|[\\/])/, process.env.USERPROFILE || os.homedir());
  const dir = path.resolve(expanded);

  if (!path.isAbsolute(expanded)) {
    return { dir: fallback, custom: false, error: `「${text}」不是完整路径，请填成 D:\\某个文件夹 这样的形式` };
  }
  if (path.parse(dir).root === dir) {
    return { dir: fallback, custom: false, error: `不能直接用盘符根目录（${dir}），请在后面加一个文件夹名` };
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    // 只试写一个小文件，写完删掉。不写下去的话，「目录能 stat 到」会被
    // 当成「能用」，而 Program Files 下的目录恰好是能读不能写。
    const probe = path.join(dir, '.write-test-' + process.pid);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
  } catch (e) {
    const why =
      e.code === 'ENOENT'
        ? '所在磁盘不存在（盘符写错，或者移动硬盘没插）'
        : e.code === 'EPERM' || e.code === 'EACCES'
          ? '这个位置不允许写入（可能需要管理员权限）'
          : e.code === 'ENOSPC'
            ? '磁盘空间不足'
            : e.code === 'EROFS'
              ? '这个位置是只读的'
              : e.message || String(e);
    return { dir: fallback, custom: false, error: `${dir} 用不了：${why}` };
  }
  return { dir, custom: true, error: '' };
}

/**
 * 按配置里的 storage 段，把 LECT_DIR / HF_CACHE 指过去。
 *
 * 为什么单独一个函数、而且在启动和保存设置时都调一次：
 * 两处必须走同一套判断，否则「启动时能用、保存后不能用」这种不一致
 * 会让用户看到的路径和实际存的位置对不上。
 *
 * 关键点：**任何一边失败都退回默认位置，绝不抛异常**。
 * 这个程序的价值是「双击就能跑」，配置填错不该让人连界面都打不开 ——
 * 打不开就没法进去把错的路径改回来，直接死锁。
 */
function applyStorageConfig() {
  const s = config.storage || {};
  const lec = resolveStorageDir(s.lecturesDir, LECT_DIR_DEFAULT);
  const mod = resolveStorageDir(s.modelsDir, MODELS_DIR_DEFAULT);
  LECT_DIR = lec.dir;
  HF_CACHE = mod.dir;
  storageState.lectures = { dir: lec.dir, custom: lec.custom, error: lec.error };
  storageState.models = { dir: mod.dir, custom: mod.custom, error: mod.error };
  return storageState;
}

/**
 * 给前端用的配置。
 *
 * 密钥的处理分两种请求来源：
 *   · 本机浏览器（127.0.0.1）—— 回传真实 Key。用户自己电脑上的程序，
 *     再藏着不让看，只会让人怀疑「是不是没保存成功」。老大原话：
 *     「为什么设置里输入key保存后再打开就消失了，虽然能正常调用API但我感觉还是一直有比较好」。
 *   · 局域网 / 手机 —— 一律只回 hasApiKey 和掩码（sk-cik…zdij），
 *     拿到入口地址也读不到明文。
 */
function publicConfig(local = false) {
  const c = structuredClone(config);
  for (const k of ['asr', 'llm']) {
    if (c[k] && 'apiKey' in c[k]) {
      c[k].hasApiKey = !!c[k].apiKey;
      c[k].apiKeyMasked = c[k].apiKey ? maskKey(c[k].apiKey) : '';
      if (!local) c[k].apiKey = '';
      if (c[k].clearApiKey) delete c[k].clearApiKey;
    }
  }
  c.keyVault = (Array.isArray(c.keyVault) ? c.keyVault : []).map((v) => ({
    ...v,
    key: local ? v.key : maskKey(v.key),
    masked: maskKey(v.key),
  }));
  return c;
}

/** sk-cikvkpszfxwjrq...yaatz → sk-cik…yaatz（保留头尾，中间打点） */
function maskKey(key) {
  const s = String(key || '');
  if (!s) return '';
  if (s.length <= 12) return s.slice(0, 2) + '…' + s.slice(-2);
  return s.slice(0, 6) + '…' + s.slice(-4);
}

/**
 * 把当前配置里的 Key 收进清单，供下拉选择。
 *
 * 为什么不要求界面显式「保存到清单」：用户填完 Key 点保存就完事了，
 * 再多一个按钮只会让人漏点。这里在每次保存配置后自动跑一遍，幂等。
 *
 * 去重按「Key 本身」算，不看 provider —— 同一把 Key 换一家服务商也是同一把，
 * 不该在清单里冒出两条一模一样的。label 只在第一次收进来时生成，之后不覆盖。
 */
function rememberKeys() {
  const vault = Array.isArray(config.keyVault) ? config.keyVault.slice() : [];
  const seen = new Set(vault.map((v) => v.key));
  let changed = false;
  for (const kind of ['asr', 'llm']) {
    const key = config[kind]?.apiKey;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const provider = (kind === 'asr' ? config.asr.provider : config.llm.provider) || '';
    vault.push({
      id: randomBytes(6).toString('hex'),
      key,
      provider,
      label: describeKey(key, provider),
      savedAt: new Date().toISOString(),
    });
    changed = true;
  }
  if (changed) config.keyVault = vault;
  return changed;
}

/** 给清单条目的默认显示名：只给服务商名，比如「硅基流动 SiliconFlow」 */
function describeKey(key, provider) {
  const reg = getProvider(provider);
  // 注册表里的 name 是给下拉选项用的长句（「硅基流动 SiliconFlow（转写 + 笔记都能用…）」），
  // 放进清单条目会撑爆一行，这里只取括号前的主名。
  // 注意：这里**只给服务商名，不带 Key 尾巴**。清单那一行左边已经单独渲染了掩码
  //（sk-cik…aatz），标签里再拼一次就成了「sk-cik…aatz 硅基流动 SiliconFlow · …aatz」的重复。
  const full = reg ? reg.name : provider || '';
  return String(full).replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '').trim() || '未知服务商';
}

/**
 * 把清单里旧格式的 label（带「· …xxxx」尾巴的）统一刷成新格式。
 *
 * 早期版本把 Key 尾号拼进了 label，界面上就成了「sk-cik…aatz 硅基流动 · …aatz」。
 * 现在掩码单独渲染，label 只留服务商名。老用户升级上来时顺手刷一遍，
 * 不指望他们自己删掉重存。返回值表示有没有改动（需要落盘）。
 */
function refreshKeyLabels() {
  const vault = Array.isArray(config.keyVault) ? config.keyVault : [];
  let changed = false;
  for (const v of vault) {
    const want = describeKey(v.key, v.provider);
    if (v.label !== want) {
      v.label = want;
      changed = true;
    }
  }
  return changed;
}

/* ------------------------------- 讲次存储 -------------------------------- */
const lectDir = (id) => path.join(LECT_DIR, id);
const metaPath = (id) => path.join(lectDir(id), 'meta.json');
const audioPathOf = (meta) => path.join(lectDir(meta.id), meta.audioFile || 'audio.bin');

async function readMeta(id) {
  try {
    return parseJsonText(await fsp.readFile(metaPath(id), 'utf8'));
  } catch {
    return null;
  }
}
async function writeMeta(meta) {
  meta.updatedAt = new Date().toISOString();
  await fsp.mkdir(lectDir(meta.id), { recursive: true });
  await fsp.writeFile(metaPath(meta.id), JSON.stringify(meta, null, 2), 'utf8');
  return meta;
}
async function listLectures() {
  await fsp.mkdir(LECT_DIR, { recursive: true });
  const dirs = await fsp.readdir(LECT_DIR, { withFileTypes: true }).catch(() => []);
  const out = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const meta = await readMeta(d.name);
    if (meta) out.push(meta);
  }
  out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return out;
}
const emptyDoc = () => ({ language: '', engine: '', model: '', device: '', cleanedBy: '', denoise: null, text: '', segments: [], createdAt: null });

/**
 * 读取文档。transcript 会顺手过一遍规范化（幂等）：
 * 存量脏数据（旧版写进去的单段全文、零长段、非单调时间轴）读出来就是修好的样子，
 * 不需要用户手动跑迁移脚本。真的修了才回写，避免每次读取都碰磁盘。
 */
async function readDoc(id, kind) {
  let doc;
  try {
    doc = parseJsonText(await fsp.readFile(path.join(lectDir(id), kind + '.json'), 'utf8'));
  } catch {
    return kind === 'transcript' ? emptyDoc() : null;
  }
  if (kind !== 'transcript' || !doc) return doc;
  try {
    const meta = await readMeta(id);
    const before = JSON.stringify(doc.segments || []);
    const { doc: fixed, repairs } = normalizeTranscript(doc, { duration: meta?.duration });
    if (repairs.length || JSON.stringify(fixed.segments) !== before) {
      // 后台静默回写：读路径不该因为修数据而变慢或抛错，失败了下次读还会再修
      writeDoc(id, 'transcript', fixed).catch(() => {});
    }
    return fixed;
  } catch {
    return doc; // 规范化本身出问题就原样返回，绝不因为修数据而让录音打不开
  }
}

/**
 * 写文档。transcript 落盘前必须规范化 —— 这是整个应用唯一的逐字稿出口，
 * 不管数据来自云端 API、本地 Whisper、前端 PUT 还是旧数据导入，
 * 存下来的形状都一致。脏数据进不来，就不会有「某条录音长歪了」。
 */
async function writeDoc(id, kind, data) {
  await fsp.mkdir(lectDir(id), { recursive: true });
  let out = data;
  if (kind === 'transcript') {
    const meta = await readMeta(id).catch(() => null);
    out = normalizeTranscript(data, { duration: meta?.duration }).doc;
    // 落盘前再做一遍确定性清洗（繁→简、非正文码位收窄、半角标点转全角、
    // 折叠重复）。浏览器里点按钮转写时，app.js 已经洗过一次再 PUT 回来；
    // 但直接 POST /api/lectures/:id/transcribe 这条路（脚本、以后可能的
    // 命令行/API 用法）没有前端，不在这里洗就会留下日文假名和 emoji ——
    // 实测灌进 62b4f73d 的 88 分钟录音时多了 64 个杂符（な/か/し/も/🎼）。
    // 清洗是幂等的：洗过的再洗一遍不会变，所以两条路都走一遍没关系。
    if (Array.isArray(out.segments) && out.segments.length) {
      const cleaned = cleanSegments(out.segments);
      out = { ...out, segments: cleaned, text: cleaned.map((s) => s.text).join('\n') };
    }
  }
  out.updatedAt = new Date().toISOString();
  await fsp.writeFile(path.join(lectDir(id), kind + '.json'), JSON.stringify(out, null, 2), 'utf8');
  return out;
}

/**
 * 读笔记，顺手判断「这份笔记还配不配当前的逐字稿和算法」。
 *
 * 2026-11-13 起这里**不再自动重建任何笔记**。以前离线笔记过时会在读的时候重算一份
 * （逐字稿的确定性函数，不花钱），但离线引擎已经退出产品了 —— 它产出的稿子老大原话
 * 「一般都不能看」。现在过时就只把状态回给前端，让用户点「重新润色」走大模型。
 *
 * 为什么要留状态判断：算法升级、逐字稿自愈补回漏掉的句子 —— 这些事发生时根本没有
 * 「写笔记」这个动作，只有读的时候才可能发现「这条笔记已经跟不上原文了」。
 */
async function readNote(id, preloaded) {
  const [rawNote, transcript, meta] = await Promise.all([
    readDoc(id, 'note'),
    preloaded ? Promise.resolve(preloaded.transcript) : readDoc(id, 'transcript'),
    preloaded ? Promise.resolve(preloaded.meta) : readMeta(id),
  ]);
  // 先洗正文再判过时：磁盘上的老 AI 笔记没人给它盖过章，
  // 但正文里可能带着模型抄进去的提示词（「［40 字以内…］」）。
  // 在入口洗，导出 Word / 导出 md / 复制笔记就都不会带出去。
  const { note, repairs } = normalizeNote(rawNote);
  if (repairs.length) writeDoc(id, 'note', note).catch(() => {});

  const status = noteStatus(note, { fingerprint: transcriptFingerprint(transcript) });
  void meta; // 以前重建离线笔记要用它，现在不重建了，留着参数是为了调用方不用改
  return { note: status.missing ? null : note, status };
}

/* --------------------------------- 静态 ---------------------------------- */
async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) return fail(res, 403, '禁止访问');
  let st;
  try {
    st = await fsp.stat(filePath);
  } catch {
    // 单页回退
    if (!path.extname(rel)) return serveFile(req, res, path.join(PUBLIC_DIR, 'index.html'));
    return fail(res, 404, '文件不存在: ' + rel);
  }
  if (st.isDirectory()) return serveFile(req, res, path.join(filePath, 'index.html'));
  return serveFile(req, res, filePath, st);
}
async function serveFile(req, res, filePath, st) {
  try {
    st = st || (await fsp.stat(filePath));
    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': st.size,
      // 本地应用，缓存只会带来「改了代码但浏览器还是旧的」这类麻烦
      'cache-control': 'no-store',
      'accept-ranges': 'bytes',
    };
    const range = req.headers.range;
    if (range && /^bytes=\d*-\d*$/.test(range)) {
      const [s, e] = range.replace('bytes=', '').split('-');
      const start = s === '' ? Math.max(0, st.size - Number(e)) : Number(s);
      const end = s === '' || e === '' ? st.size - 1 : Math.min(Number(e), st.size - 1);
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'content-range': `bytes */${st.size}` });
        return res.end();
      }
      res.writeHead(206, { ...headers, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${st.size}` });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    return fail(res, 500, '读取文件失败: ' + e.message);
  }
}

/* --------------------------------- 转写代理 ------------------------------- */
/** 云端转写最短超时：一小时录音上传就要几十秒，180 秒根本不够 */
const ASR_MIN_TIMEOUT_MS = 600000;

/** 秒数 → 「88.1 分」/「1 小时 2 分」。只给定死的上限和实测时长用，别的地方别拿来凑数。 */
function fmtDuration(sec) {
  const s = Number(sec) || 0;
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.round((s - h * 3600) / 60);
    return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
  }
  return `${(s / 60).toFixed(1)} 分`;
}

/** 字节 → 「81.6 MB」 */
function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

/* ------------------------------ 思考型模型 ------------------------------ */
/**
 * thinking: true 的模型（providers.js 里标的）要先想几百字才出正文，
 * 服务端拿不到「响应头」之前只能干等 —— 而 Node 内置 fetch（undici）
 * 有一条 300 秒的 headersTimeout 硬墙，比项目自己配的 llm.timeoutMs 更早触发。
 *
 * 2026-10-28 实测 GLM-5.3-Flash 整理 21316 字逐字稿：
 *   不加参数   → 810~822 秒（思考 50157 字），**必然撞 300 秒墙 → 界面只看到
 *                「LLM 请求失败: Headers Timeout Error」，用户以为模型挂了**；
 *   reasoning_effort:'low' → 160 秒，思考 0 字，产出 6995 字 / 69 条要点 /
 *                21 个标题（对照 69 条 / 22 个标题，质量没掉）。
 *
 * 试过但**无效**的六种写法（都在 _scratch/probe-glm-thinking.mjs 里验过，
 * 小输入 8.7 秒基线、思考 1182 字，六种全都没把思考压下去）：
 *   enable_thinking:false / thinking:{type:'disabled'} / reasoning_effort:'none' /
 *   chat_template_kwargs:{enable_thinking:false} / thinking_budget:0（直接 400）/
 *   以及 reasoning_effort:'minimal'（被忽略，退化成默认思考，900 秒都没回来）。
 * 只有 'low' 真生效 —— 所以别「优化」成别的值。
 */
function thinkingHint(model) {
  const spec = modelSpec(config.llm.provider, 'llm', model);
  // 自定义服务商没有注册表条目（modelSpec 返回 null）—— 不猜，不加参数。
  if (!spec || spec.thinking !== true) return {};
  return { reasoning_effort: 'low' };
}


async function transcribeViaApi(id, meta, opts = {}) {
  // 决定往哪发、用哪个模型、要不要 verbose_json —— 逻辑在 public/providers.js
  // 里（可单测），并且只读服务端保存的 config，不看请求体。
  const t = resolveAsrTarget(config);
  // 只做配置检查、不真的发请求：给界面上的「测试配置」用。
  // 让用户在上传一小时的录音之前就知道「地址/模型/Key 到底对不对」。
  if (opts.checkOnly) return { ok: t.ok, ...t, checkedOnly: true, error: t.ok ? undefined : t.error };
  if (!t.ok) return { ok: false, error: t.error };
  const { url, model, verbose, apiKey } = t;
  const filePath = audioPathOf(meta);

  // 发之前先看这条录音会不会超服务商的单文件上限。
  //
  // 为什么必须自己拦：硅基流动 Qwen3-ASR 对超限文件回的是裸 400 ——
  // Content-Length: 0，响应体一个字节都没有，连原因都不给。用户界面上只会看到
  // 「转写服务返回 400: 」（冒号后面空着），既不知道该剪短还是该换模型。
  // 更糟的是上传得先把 80MB 传完才被拒（实测 29~33 秒），白等。
  // 实测 2026-10-22 真 Key 直连：88.1 分 / 81.6MB → 400 空体；
  // 42.7 分 / 39.5MB → 200。官方文档写「时长不超过 1 小时，文件大小不超过 50MB」。
  const over = [];
  if (t.maxSeconds && Number(meta.duration) > t.maxSeconds) {
    over.push(`时长 ${fmtDuration(meta.duration)}，超过上限 ${fmtDuration(t.maxSeconds)}`);
  }
  if (t.maxBytes) {
    let bytes = 0;
    try {
      bytes = (await fsp.stat(filePath)).size;
    } catch {
      // 拿不到大小就算了，别因为拦超限这件事反而把转写卡死
    }
    if (bytes > t.maxBytes) {
      over.push(`文件 ${fmtSize(bytes)}，超过上限 ${fmtSize(t.maxBytes)}`);
    }
  }
  if (over.length) {
    return {
      ok: false,
      tooBig: true,
      error:
        `这条录音${over.join('；')}。${t.who}的 ${model} 转不了这么长的，` +
        `超了它会直接拒收（还不说原因）。两个办法：` +
        `① 转写模型换成 SenseVoiceSmall（同一个 Key，免费，实测 88 分钟能一次转完）；` +
        `② 把录音切成两半分别转。`,
    };
  }

  let blob;
  try {
    blob = await fs.openAsBlob(filePath, { type: meta.mime || 'audio/mpeg' });
  } catch (e) {
    return { ok: false, error: '读取音频失败: ' + e.message };
  }
  const form = new FormData();
  form.append('file', blob, meta.audioFile || 'audio.bin');
  form.append('model', model);
  // 有的服务商（如硅基流动 SenseVoice）不支持 verbose_json，加了会直接 400。
  // 用注册表里的 verbose 标记判断，别把服务商名字写死在代码里。
  if (verbose) form.append('response_format', 'verbose_json');
  if (opts.language && opts.language !== 'auto') form.append('language', opts.language);

  const ac = new AbortController();
  const waitMs = Math.max(ASR_MIN_TIMEOUT_MS, Number(config.llm.timeoutMs) || 0);
  const timer = setTimeout(() => ac.abort(), waitMs);
  let resp;
  try {
    resp = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer ' + apiKey }, body: form, signal: ac.signal });
  } catch (e) {
    clearTimeout(timer);
    if (ac.signal.aborted) {
      return { ok: false, error: `云端转写等太久（超过 ${Math.round(waitMs / 1000)} 秒）还没返回，已中断。录音很长的话可以先切成两半分别转。` };
    }
    return { ok: false, error: '请求转写服务失败: ' + (e.cause?.message || e.message) };
  }
  clearTimeout(timer);
  const raw = await resp.text();
  if (!resp.ok) {
    return { ok: false, error: `转写服务返回 ${resp.status}: ` + raw.slice(0, 400) };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = { text: raw };
  }
  const segments = [];
  if (Array.isArray(data.segments)) {
    for (const s of data.segments) {
      const start = Number(s.start) || 0;
      const end = Number(s.end) || 0;
      const t2 = String(s.text || '').trim();
      if (t2) segments.push({ start, end, text: t2 });
    }
  }
  const text = String(data.text || data.result || '').trim();
  // 切段与补时间轴的规则不再写在这里 —— 统一交给 public/transcript.js 的
  // normalizeTranscript（writeDoc 落盘时还会再走一遍，这里先规范一次是为了
  // 让「校对」「导出」这些中间环节拿到的就已经是干净段落）。
  //
  // 为什么以前会有问题：硅基流动 SenseVoice 这类接口不回 segments，只回整篇 text，
  // 整篇当 1 段会让大模型校对被截断成一句话（「云端转写只出一句话」）；
  // 而各家切句规则又和 generate note 用的 splitSentences 不一致，逐字稿与笔记
  // 对不上号。现在两边共用同一套切句 + 同一套时间轴，换了服务商也不会走样。
  const { doc: normalized } = normalizeTranscript(
    { text, segments, createdAt: new Date().toISOString() },
    { duration: meta.duration }
  );
  return { ok: true, text: normalized.text, segments: normalized.segments, model, engine: t.provider };
}

/* ---------------------------- 模型文件中转 ----------------------------
 * 浏览器的 CORS 会拦掉 hf-mirror 的 /resolve/ 端点（它只允许自家域名跨域），
 * 所以模型文件不让浏览器直连，改由本服务中转：
 *   浏览器 → http://127.0.0.1:PORT/api/hf/<owner>/<model>/resolve/... （同源，没有 CORS）
 *   服务端 → https://<modelHost>/<owner>/<model>/resolve/...         （Node 侧不受 CORS 约束）
 * 顺便在数据目录的 models 下留一份磁盘缓存：下过一次就永远不用再下。
 * 缓存位置可以在设置里改（见上面的 storageState），默认还是数据目录里。
 * ------------------------------------------------------------------ */
/**
 * 指向本地大模型启动脚本的指针文件（内容为纯 ASCII 路径）。
 *
 * 这个文件由 helpers\setup-local-llm.ps1 写出来，内容形如 `D:\AI\start-llm.vbs`。
 * 早期版本把它固定成「项目目录下的 helpers\local-llm-path.txt」，
 * 装到 Program Files 时那条路径是只读的 —— 用户点「部署本地模型」会失败，
 * 而且报错只说「没有找到启动脚本」，看不出是权限问题。
 * 现在改成「数据目录优先」：数据目录一定是可写的（不然服务都起不来），
 * 旧位置也还读，老用户的部署不会因为升级而失效。
 */
const LLM_POINTER_CANDIDATES = [
  path.join(DATA_DIR, 'local-llm-path.txt'),
  path.join(__dirname, 'helpers', 'local-llm-path.txt'),
];
/**
 * 本地大模型可能装在哪些地方。用户点「启动」时按顺序找，
 * 找到哪个用哪个 —— 这样「自己动手装到 D:\AI」和「用一键脚本装到默认位置」都能用。
 *
 * 判定标准是「这个目录里有 start-llm.vbs」，不是「这个目录存在」：
 * 空目录什么也说明不了，认错了反而会让用户点了没反应。
 */
function llmSearchRoots() {
  const home = process.env.USERPROFILE || os.homedir();
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const roots = [
    path.join(DATA_DIR, 'local-llm'),
    path.join(__dirname, 'local-llm'),
    path.join(local, 'LectureNotes', 'local-llm'),
    path.join(home, 'LectureNotes', 'local-llm'),
  ];
  // 常见的「自己建了个 AI 目录」的位置。D 盘放第一是因为模型 4.4GB，
  // 多数人不会放系统盘（这几个只是候选，不存在就跳过，不会乱建目录）。
  for (const drive of ['D:', 'E:', 'C:']) {
    roots.push(path.join(drive + path.sep, 'AI'));
    roots.push(path.join(drive + path.sep, 'Download', 'AI'));
    roots.push(path.join(drive + path.sep, 'Download', 'llm'));
  }
  return roots;
}
/**
 * 扫一遍候选目录，找本地大模型的部署。
 *
 * 返回两样东西：
 *   ok    —— 第一个**真能跑**的（有 start-llm.vbs 且有 llama-server.exe）
 *   seen  —— 第一个只是有 vbs 的（半成品，用户重装/中途失败留下的残骸）
 *
 * 为什么分开：半成品目录如果排在前面，直接返回它就会把后面那份好的挡掉，
 * 用户明明能用却一直看到「装了一半」。所以先扫完、优先认能跑的。
 */
async function findLocalLlmHome() {
  const exists = (p) => fsp.access(p, fs.constants.F_OK).then(() => true, () => false);
  let seen = '';
  for (const root of llmSearchRoots()) {
    const launcher = path.join(root, 'start-llm.vbs');
    if (!(await exists(launcher))) continue;
    if (await localLlmDeployOk(root)) return { launcher, home: root, ok: true };
    if (!seen) seen = root; // 记下第一个半成品，最后没找到好的就用它报「装了一半」
  }
  return { launcher: '', home: seen, ok: false };
}
/**
 * 这份部署到底能不能真的跑起来。
 *
 * 只看 start-llm.vbs 在不在是不够的：部署脚本可能中途失败（zip 没下全、
 * 解压一半被杀），留下一个孤零零的 vbs，用户点「启动」只会弹出
 * 「找不到 llama-server.exe」的框，还以为是软件坏了。
 * 这里连运行时一起看：cuda 版优先，vulkan 兜底，跟 model-start-src.vbs 的判断顺序一致。
 */
async function localLlmDeployOk(home) {
  if (!home) return false;
  const exists = (p) => fsp.access(p, fs.constants.F_OK).then(() => true, () => false);
  if (!(await exists(path.join(home, 'start-llm.vbs')))) return false;
  const cuda = path.join(home, 'runtime', 'cuda', 'llama-server.exe');
  const vulkan = path.join(home, 'runtime', 'vulkan', 'llama-server.exe');
  return (await exists(cuda)) || (await exists(vulkan));
}
/**
 * 让部署位置里的 start-llm.vbs 跟当前版本的源头脚本一致。
 *
 * 为什么需要这个：`helpers/setup-local-llm.ps1` 只在「点部署」那一次把
 * `helpers/model-start-src.vbs` 转成 UTF-16LE 写到 `<home>\start-llm.vbs`。
 * 之后软件升级、源头脚本改了（比如 2026-11-05 加了「读 active-model.txt
 * 决定加载哪个 gguf」），用户机器上那份**不会自己更新** —— 于是界面能切
 * 模型、指针文件也写了，vbs 却还在加载写死的那个 7B。
 *
 * 这就是典型的「升级一次就少一个功能，而且不报错」。所以在每次要启动
 * llama-server 之前顺手对一遍，不一致就重写一份。
 *
 * 写不进去不报错（Program Files、只读盘）：老 vbs 还能用，只是换不了模型，
 * 比整个启动失败强。
 */
async function ensureLlmLauncher(home) {
  if (!home) return;
  const src = path.join(__dirname, 'helpers', 'model-start-src.vbs');
  const dst = path.join(home, 'start-llm.vbs');
  const body = await fsp.readFile(src, 'utf8').catch(() => '');
  if (!body) return;
  const old = await fsp.readFile(dst, 'utf8').catch(() => '');
  if (old === body) return;
  // setup-local-llm.ps1 用的是 [Text.UnicodeEncoding]::new(false, true)：
  // 小端 + BOM。这里照做 —— vbs 里有中文提示框，不按 UTF-16LE 存会乱码。
  await fsp.writeFile(dst, '\uFEFF' + body, 'utf16le').catch(() => {});
}
/**
 * 本地大模型当前该加载哪个 gguf。
 *
 * 一次只能装一个模型，所以「用哪档」记在 `models\active-model.txt` 里
 * （一行文件名，相对 models\ 目录）。这个文件是 start-llm.vbs 唯一的输入，
 * 也就是说：改文件 + 重启 llama-server = 换模型，不用给 wscript 传参，
 * 用户双击那个 vbs 也照样能起。
 *
 * 文件不存在 / 读不出来 / 写的那个 gguf 不在了 → 返回 ''，让 vbs 自己
 * 退回默认的 7B。老部署（升级上来，models 目录里只有 7B）走的正是这条路。
 */
async function activeLlmModelFile(home) {
  const p = path.join(home || '', 'models', 'active-model.txt');
  const raw = await fsp.readFile(p, 'utf8').catch(() => '');
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const full = path.join(home, 'models', t);
    if (await fsp.access(full, fs.constants.F_OK).then(() => true, () => false)) return t;
    return '';
  }
  return '';
}
/**
 * 记下本地大模型当前该加载哪一档（只是写个指针文件，不做重启）。
 * 真正的重启在下面 /local-llm/model 那个接口里做。
 *
 * ⚠ 这个文件**只能写纯 ASCII**（文件名 + 注释都用英文），原因记在这里免得
 * 以后有人「顺手加句中文注释」：
 * start-llm.vbs 用 `fso.OpenTextFile(p, 1)` 读它，不带 BOM 的 UTF-8 会被
 * 按 ANSI 解码 —— 中文的字节里会出现被当成换行符的值，整个文件读成一行，
 * 而且这行以 # 开头，于是被当注释跳过，指针白写、静默退回 7B。
 * 换成 ADODB.Stream 指定 UTF-8 也能解决，但那样 vbs 要多二十行，
 * 而这里本来只需要一个文件名。
 */
async function setActiveLlmModel(home, file) {
  const dir = path.join(home, 'models');
  await fsp.mkdir(dir, { recursive: true }).catch(() => {});
  const body =
    '# Which gguf the local LLM loads. One bare file name, relative to this\n' +
    '# folder. Edit it and restart the local model to switch.\n' +
    '# ASCII only -- see setActiveLlmModel() in server.mjs before adding text.\n' +
    file +
    '\n';
  await fsp.writeFile(path.join(dir, 'active-model.txt'), body, 'ascii');
}
/**
 * 记下本地大模型的安装位置，下次直接读，不用再扫一遍盘。
 * 写失败不报错（数据目录不可写的极端情况下，扫描逻辑本来也能兜住）。
 */
async function rememberLocalLlmHome(home) {
  const target = LLM_POINTER_CANDIDATES[0];
  const launcher = path.join(home, 'start-llm.vbs');
  await fsp.mkdir(DATA_DIR, { recursive: true }).catch(() => {});
  await fsp.writeFile(target, launcher, 'ascii').catch(() => {});
}
/** 读指针文件；指向的脚本已经不在了（用户删了/换机器）就当没有 */
async function readLocalLlmLauncher() {
  for (const file of LLM_POINTER_CANDIDATES) {
    const p = (await fsp.readFile(file, 'utf8').catch(() => '')).trim();
    if (!p) continue;
    if (await fsp.access(p, fs.constants.F_OK).then(() => true, () => false)) return p;
  }
  return '';
}
/**
 * 「一键部署本地大模型」的进程状态。
 * 只是防止重复点：两个部署脚本同时解压同一个目录会把文件写坏。
 * 子进程退出了就把标记放掉，所以这里不需要留句柄去 kill。
 */
const localLlmSetup = { running: false, startedAt: '' };
const HF_ALLOWED_HOSTS = new Set(['hf-mirror.com', 'huggingface.co', 'www.huggingface.co', 'hf.co']);
const HF_PATH_OK = /^[\w.\-]+\/[\w.\-]+\/resolve\/[\w.\-/]+$/;

async function dirSize(dir) {
  let total = 0;
  try {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) total += await dirSize(p);
      else if (e.isFile()) total += (await fsp.stat(p)).size;
    }
  } catch {}
  return total;
}

async function handleHfProxy(req, res, u) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, '方法不支持');
  const rest = decodeURIComponent(u.pathname.replace(/^\/api\/hf\/?/, ''));
  if (!rest || rest.includes('..') || !HF_PATH_OK.test(rest)) {
    return fail(res, 400, '只允许 /api/hf/<owner>/<model>/resolve/<路径> 形式');
  }
  const base = String(config.asr.modelHost || 'https://hf-mirror.com/').replace(/\/+$/, '');
  let up;
  try {
    up = new URL(`${base}/${rest}`);
  } catch {
    return fail(res, 400, '模型源地址不合法');
  }
  if (up.protocol !== 'https:' || !HF_ALLOWED_HOSTS.has(up.hostname)) {
    return fail(res, 403, `不允许的模型源：${up.hostname}`);
  }

  const cachePath = path.join(HF_CACHE, up.hostname, ...rest.split('/'));
  const type = /\.json$|\.txt$/.test(rest) ? 'application/json; charset=utf-8' : 'application/octet-stream';

  // 命中磁盘缓存直接发
  try {
    const st = await fsp.stat(cachePath);
    if (st.size > 0) {
      res.writeHead(200, {
        'content-type': type,
        'content-length': st.size,
        'x-hf-cache': 'hit',
        'cache-control': 'public, max-age=86400',
      });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(cachePath).pipe(res);
    }
  } catch {}

  let resp;
  try {
    resp = await fetch(up.href, { redirect: 'follow' });
  } catch (e) {
    return fail(res, 502, `下载失败（${up.hostname}）：${e.cause?.message || e.message}`);
  }
  if (!resp.ok) return fail(res, resp.status, `模型源返回 HTTP ${resp.status}（${up.href}）`);

  if (req.method === 'HEAD') {
    res.writeHead(200, { 'content-type': type, 'x-hf-cache': 'miss' });
    return res.end();
  }

  await fsp.mkdir(path.dirname(cachePath), { recursive: true });
  const tmpPath = `${cachePath}.part`;
  await fsp.rm(tmpPath, { force: true }).catch(() => {});
  const fd = await fsp.open(tmpPath, 'w');

  const len = resp.headers.get('content-length');
  res.writeHead(200, {
    'content-type': type,
    ...(len ? { 'content-length': len } : {}),
    'x-hf-cache': 'miss',
    'cache-control': 'public, max-age=86400',
  });

  let clientGone = false;
  res.on('close', () => {
    if (!res.writableEnded) clientGone = true;
  });

  try {
    const reader = resp.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      await fd.write(buf); // 先落盘：即使浏览器断开，下次也走缓存
      if (!clientGone) {
        if (!res.write(buf)) await new Promise((r) => res.once('drain', r));
      }
    }
    await fd.close();
    await fsp.rename(tmpPath, cachePath);
    if (!clientGone) res.end();
  } catch (e) {
    try {
      await fd.close();
    } catch {}
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    if (!res.headersSent) return fail(res, 502, '中转模型文件失败：' + e.message);
    try {
      res.end();
    } catch {}
  }
}

/* ------------------------------- 自动更新 -------------------------------- */
/**
 * 这一节只做三件事：查、下、装。
 *
 * 三层顺序不能换：
 *   ① `GET /api/update/check`  —— 拉清单，算出「有没有新版」。一次网络请求，几 KB。
 *   ② `POST /api/update/download` —— 把安装包下到数据目录的 `update\` 里。
 *      先写 `.part`，完整了再 `rename` —— 断网/关窗口留下的半截文件永远不会被当成安装包。
 *   ③ `POST /api/update/install` —— 起一个小 VBS，然后服务自己退出。
 *      VBS 等进程真死（不是 sleep 几秒），才把安装包拉起来。
 *
 * 为什么不自己直接 spawn 安装包：node.exe 还开着的时候安装程序写不进去
 * （实测：运行中的 exe 删不掉、也不能被覆盖）。先退再装是唯一顺序。
 */

/** 安装包落在哪儿：数据目录下的 update\，卸载不删（那目录本来就不清理）。 */
function updateDir() {
  return path.join(DATA_DIR, 'update');
}

/** 下到一半的临时名。刻意不用 `.exe` 结尾 —— 双击不会误执行半截文件。 */
function partPathFor(file) {
  return path.join(updateDir(), file + '.part');
}

/**
 * 现在正在跑的这一份是「安装版的」还是「绿色版/开发版的」。
 *
 * 判据是「程序目录旁边有没有 data 目录」——和 pickDataDir() 同一套逻辑：
 * 安装版的数据在 %LOCALAPPDATA%，程序目录里没有 data；
 * 绿色版/开发版的数据就在程序旁边。
 *
 * 为什么非要分：绿色版根本没有「安装包」这个位置，自动更新装到哪里去？
 * 那种情况只提示「有新版本，去下载」，不提供一键装。
 */
function isInstalledBuild() {
  return !DATA_DIR_PORTABLE;
}

/** 一个安全的文件名（清单是外部数据，不能直接拼进路径）。 */
function safeFileName(name, fallback = 'LectureNotes-setup.exe') {
  const base = path.basename(String(name || '').replace(/\\/g, '/')).replace(/[<>:"|?*\u0000-\u001f]/g, '');
  const trimmed = base.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') return fallback;
  return trimmed.toLowerCase().endsWith('.exe') ? trimmed : fallback;
}

/**
 * 长请求的 POST（走 node:http，绕开 undici 的 300 秒 headersTimeout）。
 *
 * 为什么不用 fetch：Node 内置 fetch（undici）有两条默认硬墙 —— headersTimeout 300 秒、
 * bodyTimeout 300 秒。本地 14B 跑校对要「逐条回抄原文」，2000 字的块在纯 CPU 上
 * 就要跑 350~390 秒，**必然撞墙**，于是整块被判失败、悄悄降级成「没校对」的原文 ——
 * 用户看到的就是「本地转写的逐字稿一整个没标点、错字也没改」。
 *
 * 这里用 node:http 手写，超时完全由调用方给的 timeoutMs 决定。
 * 只支持 http（本地 llama-server 就是 http）；https 继续走 fetch。
 */
function postJsonLong(url, { body, headers = {}, timeoutMs = 0, signal } = {}) {
  const u = new URL(url);
  if (u.protocol !== 'http:') return null; // 交给调用方退回 fetch
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 80,
        path: (u.pathname || '/') + (u.search || ''),
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers },
        timeout: 0,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      }
    );
    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`超过 ${Math.round(timeoutMs / 1000)} 秒没有返回`));
      });
    }
    if (signal) {
      const onAbort = () => req.destroy(new Error('已取消'));
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => signal.removeEventListener('abort', onAbort));
    }
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/** 带超时的 fetch。服务器上所有对外请求都该有上限，否则一个卡住的源会拖死整个界面。 */
async function fetchWithTimeout(url, { timeoutMs = 8000, headers = {}, method = 'GET' } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method,
      signal: ac.signal,
      redirect: 'follow',
      headers: { 'user-agent': `LectureNotes/${VERSION}`, ...headers },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 拉清单。多源按顺序试，第一个成功的就用。
 *
 * 失败不抛异常而是回 { error }——检查更新失败是常态（没网、被墙、镜像挂了），
 * 界面要能安稳地说一句「检查不了」，而不是弹一个红框。
 */
async function fetchFeed(cfg) {
  const urls = feedUrls({ repo: cfg.repo, feedUrl: cfg.feedUrl });
  if (!urls.length) return { error: '还没有配置更新源' };
  const tried = [];
  for (const url of urls) {
    try {
      const resp = await fetchWithTimeout(url, { timeoutMs: 8000, headers: { accept: 'application/json' } });
      if (!resp.ok) {
        tried.push(`${new URL(url).host} 返回 ${resp.status}`);
        continue;
      }
      const text = await resp.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        tried.push(`${new URL(url).host} 返回的不是 JSON`);
        continue;
      }
      const feed = parseFeed(json, { repo: cfg.repo });
      if (!feed) {
        tried.push(`${new URL(url).host} 的清单里没有安装包`);
        continue;
      }
      return { feed, url };
    } catch (e) {
      const host = (() => {
        try {
          return new URL(url).host;
        } catch {
          return url;
        }
      })();
      tried.push(`${host}：${e.name === 'AbortError' ? '超时' : e.message}`);
    }
  }
  return { error: tried.join('；') || '连接不上更新源' };
}

/**
 * 检查 + 落盘「上次查过什么」。
 * 为什么把结果写进 config：界面每次打开设置都要显示「当前最新版」，不该为了
 * 一个字符串再打一次网络。
 */
async function checkUpdate({ force = false } = {}) {
  const cfg = config.update || DEFAULT_CONFIG.update;
  if (!cfg.enabled) return { enabled: false, reason: '用户关掉了自动更新' };
  if (!force && !shouldCheck(cfg.lastCheckAt)) {
    return {
      enabled: true,
      cached: true,
      current: VERSION,
      latest: cfg.lastVersion || '',
      hasUpdate: shouldOffer(cfg.lastVersion, VERSION, cfg.ignoredVersion),
      // 「这一版是不是用户自己点过跳过」也要回：界面靠它决定要不要显示「取消跳过」
      ignored: !!cfg.ignoredVersion && compareVersion(cfg.lastVersion, cfg.ignoredVersion) === 0,
      // 走缓存也必须回答「能不能一键装」—— 前端拿它决定显示哪几个按钮，
      // 缺了这个字段就会被当成「能装」，绿色版用户会看到一个点了会报错的按钮。
      canInstall: isInstalledBuild(),
      checkedAt: cfg.lastCheckAt || '',
    };
  }
  const { feed, url, error } = await fetchFeed(cfg);
  if (error) {
    // 查失败也要记时间，否则界面每刷新一次都会重撞一遍同一个死源
    await saveConfig({ update: { lastCheckAt: new Date().toISOString() } }).catch(() => {});
    return { enabled: true, current: VERSION, error };
  }
  await saveConfig({
    update: { lastCheckAt: new Date().toISOString(), lastVersion: feed.version },
  }).catch(() => {});
  const latestCfg = config.update || {};
  return {
    enabled: true,
    current: VERSION,
    latest: feed.version,
    hasUpdate: shouldOffer(feed.version, VERSION, latestCfg.ignoredVersion),
    ignored: !!latestCfg.ignoredVersion && compareVersion(feed.version, latestCfg.ignoredVersion) === 0,
    notes: feed.notes,
    publishedAt: feed.publishedAt,
    pageUrl: feed.pageUrl,
    installer: {
      name: feed.installer.name,
      size: feed.installer.size,
      sizeText: formatBytes(feed.installer.size),
      sha256: feed.installer.sha256,
    },
    // 「能不能一键装」和「有没有新版」是两件事：绿色版有新版但装不了
    canInstall: isInstalledBuild(),
    source: url,
    checkedAt: config.update?.lastCheckAt || '',
  };
}

/** 已经下好的安装包（校验过大小才算数）。没有返回 null。 */
async function findDownloadedInstaller() {
  const dir = updateDir();
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return null;
  }
  const exe = names.filter((n) => /\.exe$/i.test(n));
  if (!exe.length) return null;
  let best = null;
  for (const n of exe) {
    const full = path.join(dir, n);
    const st = await fsp.stat(full).catch(() => null);
    if (!st || !st.size) continue;
    if (!best || st.size > best.size) best = { file: n, path: full, size: st.size, mtime: st.mtimeMs };
  }
  return best;
}

/**
 * 下载安装包。
 *
 * 关键几点（都是踩过的坑）：
 *   · 先写 `.part`，`Content-Length` 对得上才 `rename` —— 否则断电留下的半截 exe
 *     会被下次启动当成「已下好」，一装就报「文件损坏」；
 *   · 每个源都试，成功立刻停 —— 首源超时 15 秒不能白等，PCL 的做法就是
 *     15 秒超时后立刻换下一个；
 *   · 已经下过同一份（大小一致）就直接复用，不重复下 25MB。
 */
async function downloadInstaller(feed) {
  const dir = updateDir();
  await fsp.mkdir(dir, { recursive: true });
  const name = safeFileName(feed.installer.name);
  const finalPath = path.join(dir, name);
  const wantSize = Number(feed.installer.size) || 0;

  const existing = await fsp.stat(finalPath).catch(() => null);
  if (existing && existing.size && (!wantSize || existing.size === wantSize)) {
    return { ok: true, path: finalPath, name, size: existing.size, reused: true };
  }

  const urls = mirrorUrls(feed.installer.url);
  const tried = [];
  for (const url of urls) {
    const part = partPathFor(name);
    let handle = null;
    try {
      const resp = await fetchWithTimeout(url, { timeoutMs: 15000 });
      if (!resp.ok) {
        tried.push(`${new URL(url).host} 返回 ${resp.status}`);
        continue;
      }
      const total = Number(resp.headers.get('content-length')) || 0;
      handle = await fsp.open(part, 'w');
      let written = 0;
      for await (const chunk of resp.body) {
        await handle.write(chunk);
        written += chunk.length;
      }
      await handle.close();
      handle = null;
      if (wantSize && written !== wantSize) {
        tried.push(`${new URL(url).host} 大小对不上（${formatBytes(written)} / 应为 ${formatBytes(wantSize)}）`);
        await fsp.rm(part, { force: true }).catch(() => {});
        continue;
      }
      if (total && written !== total) {
        tried.push(`${new URL(url).host} 没下完（${formatBytes(written)} / ${formatBytes(total)}）`);
        await fsp.rm(part, { force: true }).catch(() => {});
        continue;
      }
      await fsp.rename(part, finalPath);
      return { ok: true, path: finalPath, name, size: written, reused: false };
    } catch (e) {
      if (handle) await handle.close().catch(() => {});
      await fsp.rm(partPathFor(name), { force: true }).catch(() => {});
      const host = (() => {
        try {
          return new URL(url).host;
        } catch {
          return url;
        }
      })();
      tried.push(`${host}：${e.name === 'AbortError' ? '超时' : e.message}`);
    }
  }
  return { ok: false, error: tried.join('；') || '没有可用的下载地址' };
}

/**
 * 把「装」这件事交给一个独立进程，然后自己退出。
 *
 * 为什么用 VBS 而不是 powershell：VBS 由 wscript 拉起，不需要控制台窗口，
 * 也不会因为 PowerShell 执行策略被拦（那是买家机器上最常见的失败原因之一）。
 * 脚本内容是 helpers/update-src.vbs（打包时转成 UTF-16LE 放到程序目录）。
 *
 * 注意顺序：先起脚本、再回响应、最后退出。脚本自己会等 pid 死掉，
 * 所以这里 `setTimeout` 里的退出是「走个形式让 HTTP 响应发出去」。
 */
async function applyUpdate(installerPath) {
  const scriptPath = path.join(__dirname, '更新.vbs');
  // 开发环境（没跑过打包）没有这个文件 —— 那就直接给路径，让用户自己双击。
  if (!fs.existsSync(scriptPath)) {
    return { ok: false, error: '这个版本里没有更新脚本，请手动运行下载好的安装包', manual: installerPath };
  }
  const child = spawn('wscript.exe', [scriptPath, String(process.pid), installerPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', (e) => console.warn('[自动更新] 拉起更新脚本失败：', e.message));
  child.unref();
  console.log(`[自动更新] 已交接给更新脚本（pid ${process.pid}），安装包：${installerPath}`);
  // 400ms 给 HTTP 响应留出写回浏览器的时间；脚本那边只认「pid 真的没了」
  setTimeout(() => process.exit(0), 600);
  return { ok: true, restarting: true };
}

/* --------------------------------- 路由 ---------------------------------- */
async function handleApi(req, res, u) {
  const p = u.pathname.replace(/^\/api/, '') || '/';
  const seg = p.split('/').filter(Boolean);

  // 模型文件中转（同源，绕开浏览器 CORS）
  if (p === '/hf' || p.startsWith('/hf/')) return handleHfProxy(req, res, u);

  if (p === '/health') {
    // 这个接口对局域网放行（启动器靠它认人），所以里面不能有用户的隐私：
    // 数据目录的绝对路径会暴露用户名和盘符结构，只回给本机。
    const local = isLoopback(req);
    return json(res, 200, {
      ok: true,
      version: VERSION,
      agreementVersion: AGREE_VERSION,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      host: HOST,
      port: PORT,
      // 这个请求是不是本机发出来的。手机（局域网）那边靠它决定「只留上传」：
      // 用 urls 长度也能推出来，但那是副作用式的推断 —— 哪天 urls 的语义变了
      // （比如给局域网也回地址），手机就会突然变回完整界面。直接说清楚更稳。
      local,
      ...(local ? { dataDir: DATA_DIR } : {}),
      urls: local ? localUrls() : [],
    });
  }
  if (p === '/config') {
    if (req.method === 'GET') return json(res, 200, { ok: true, config: publicConfig(isLoopback(req)), defaults: DEFAULT_CONFIG });
    if (req.method === 'PUT' || req.method === 'POST') {
      const patch = await readJsonBody(req);
      let storageTouched = false;
      for (const k of ['asr', 'llm']) {
        if (!patch[k]) continue;
        // KeyVault 是服务端自己维护的清单，不能被请求体直接覆盖
        delete patch[k].keyVault;
        // 空字符串的 apiKey 表示「不修改」（界面上的输入框留空就是这个意思）。
        // 真的要删掉已保存的 Key，用 clearApiKey: true —— 否则用户没有任何办法清掉它。
        if (patch[k].clearApiKey) {
          patch[k].apiKey = '';
          delete patch[k].clearApiKey;
        } else if (patch[k].apiKey === '' || patch[k].apiKey === undefined) {
          delete patch[k].apiKey;
        }
      }
      // 清单也只能走专门的接口改（增 / 删），不能靠这个 patch 整体替换
      delete patch.keyVault;
      // 存储位置也一样：这里只做「改回默认」和「沿用已验证过的路径」，
      // 真正的新路径必须走过 /storage/check 验证，否则一个打错的盘符
      // 会让服务下次启动直接 mkdir 失败。
      // 界面上改路径走 /storage/move（验过 + 复制完才写），这里只处理清空。
      if (patch.storage) {
        const clean = {};
        for (const k of ['lecturesDir', 'modelsDir']) {
          if (!(k in patch.storage)) continue;
          const r = resolveStorageDir(patch.storage[k], k === 'modelsDir' ? MODELS_DIR_DEFAULT : LECT_DIR_DEFAULT);
          if (r.error) return fail(res, 400, r.error);
          clean[k] = r.custom ? r.dir : '';
        }
        patch.storage = clean;
        storageTouched = true;
      }
      try {
        await saveConfig(patch);
        // 设置里刚填的 Key 顺手收进清单，下次能直接从下面选。
        // 注意要再落一次盘：rememberKeys 只改内存，不写文件的话重启就没了。
        if (rememberKeys() || refreshKeyLabels()) await saveConfig({});
        // 存储位置可能刚被改回默认 → 立刻让新位置生效，
        // 否则界面显示「已保存」，这次的录音还是存到老地方。
        if (storageTouched) applyStorageConfig();
      } catch (e) {
        // 写盘失败要说出来（磁盘满 / 只读 / 权限），不能让界面以为存成功了
        return fail(res, 500, `设置没保存成功：${e.code || e.message}。文件：${CONFIG_FILE}`);
      }
      return json(res, 200, { ok: true, config: publicConfig(isLoopback(req)) });
    }
    return fail(res, 405, '方法不支持');
  }

  // 「手机访问」开关。只给本机开 —— 手机自己被关在外面的时候当然不能
  // 反过来给自己开门，那开关就没意义了。
  if (p === '/lan') {
    // GET 和 POST 回同一份结构 —— 前端拿到 POST 的返回会直接当成最新的
    // lanInfo 用。少一个字段，界面上就会莫名其妙退回「只绑了本机」那句话。
    const lanState = (req) => ({
      ok: true,
      enabled: lanAllowed(),
      hostOnLan: HOST === '0.0.0.0' || HOST === '::',
      // 界面用这个判断「是不是在这台电脑上」，跟 /system 的 local 同一个含义。
      // 单独给一份是因为设置面板打开时只拉 /lan（/system 要算目录大小，慢）。
      local: isLoopback(req),
      urls: HOST === '0.0.0.0' || HOST === '::'
        ? lanAddresses().map((ip) => 'http://' + ip + ':' + PORT + entryPrefix())
        : [],
    });
    if (req.method === 'GET') return json(res, 200, lanState(req));
    if (req.method !== 'POST') return fail(res, 405, '方法不支持');
    if (!isLoopback(req)) return fail(res, 403, '只允许在本机开关手机访问');
    const body = await readJsonBody(req).catch(() => ({}));
    const on = body?.enabled === true;
    if (on && !(HOST === '0.0.0.0' || HOST === '::')) {
      // 服务只绑了 127.0.0.1，开开关也没用。如实说，别让用户以为坏了。
      return fail(res, 409, '这个服务启动时只绑了本机（--host 127.0.0.1），手机连不上。请用启动器重新启动。');
    }
    await saveConfig({ lan: { enabled: on } });
    console.log('  [手机访问] ' + (on ? '已开启' : '已关闭'));
    return json(res, 200, lanState(req));
  }

  // 把内存里的配置丢掉、重新从磁盘读。
  // 只有本机能调 —— 这是「测试脚本改了配置、跑完把文件还原了，但服务内存里还是脏的」
  // 那个坑的补丁：文件还原之后必须让服务也忘记旧值，否则下一次 saveConfig
  // （比如自动收录 Key）会把脏配置重新写回磁盘，用户看到 Key 又变回去了。
  if (p === '/config/reload') {
    if (req.method !== 'POST') return fail(res, 405, '方法不支持');
    if (!isLoopback(req)) return fail(res, 403, '只允许在本机重载配置');
    if (!fs.existsSync(CONFIG_FILE)) return fail(res, 404, '还没有配置文件');
    try {
      await loadConfig();
      // 重新读进来的配置里可能有新的存储路径（或者原来那个盘现在拔了），
      // 必须跟着重算一遍 LECT_DIR / HF_CACHE，不然「重载」只重载了一半：
      // 配置是新的，实际写文件还是老目录，而且 storageState.error 也不会更新。
      applyStorageConfig();
    } catch (e) {
      return fail(res, 500, `重载失败：${e.code || e.message}`);
    }
    return json(res, 200, { ok: true, config: publicConfig(true) });
  }

  // 存储位置的校验与迁移。
  //
  // 为什么单独一个接口而不是让 /config 顺手存：
  // 用户填的路径必须先验证能用，验证不过就绝对不能写进配置 ——
  // 否则下次启动会拿着一个坏路径去 mkdir 失败，用户看到的是一段英文堆栈。
  // 所以这里「先验后存」，验不过当场把原因回给界面，配置文件一个字节都不动。
  //
  // 只允许本机调：这个接口能决定用户的数据存到哪个盘、还能触发几 GB 的文件复制，
  // 手机端没有这个场景，也不该有。
  if (p === '/storage/check') {
    if (req.method !== 'POST') return fail(res, 405, '方法不支持');
    if (!isLoopback(req)) return fail(res, 403, '只允许在本机修改存储位置');
    const body = await readJsonBody(req);
    const which = body.which === 'models' ? 'models' : 'lectures';
    const fallback = which === 'models' ? MODELS_DIR_DEFAULT : LECT_DIR_DEFAULT;
    const r = resolveStorageDir(body.dir, fallback);
    if (r.error) return fail(res, 400, r.error);
    return json(res, 200, {
      ok: true,
      which,
      dir: r.dir,
      custom: r.custom,
      // 目标目录里现在有多少东西 —— 界面上要提示「这个位置已经有 N GB 录音」，
      // 免得用户把两次的数据混到同一个目录里。
      sizeGB: +((await dirSize(r.dir)) / 1024 ** 3).toFixed(2),
      currentDir: which === 'models' ? HF_CACHE : LECT_DIR,
    });
  }

  if (p === '/storage/move') {
    if (req.method !== 'POST') return fail(res, 405, '方法不支持');
    if (!isLoopback(req)) return fail(res, 403, '只允许在本机修改存储位置');
    const body = await readJsonBody(req);
    const which = body.which === 'models' ? 'models' : 'lectures';
    const from = which === 'models' ? HF_CACHE : LECT_DIR;
    const fallback = which === 'models' ? MODELS_DIR_DEFAULT : LECT_DIR_DEFAULT;
    const target = resolveStorageDir(body.dir, fallback);
    if (target.error) return fail(res, 400, target.error);
    if (target.dir === from) return json(res, 200, { ok: true, moved: 0, dir: from, message: '已经在这个位置了' });

    // 只复制、不删除源目录。
    //
    // 这一条是刻意的、不可协商的：机器休眠、断电、U 盘拔掉、用户中途关窗口，
    // 任何一种都可能让复制只做了一半。如果先删源目录，那半截数据就永远没了 ——
    // 而用户的录音是没法重录的。宁可留着一份占地方，也不能冒这个险。
    // 界面上会明确告诉用户「旧目录还在，确认没问题后自己删」。
    let copied = 0;
    let failed = [];
    const copyTree = async (src, dst) => {
      await fsp.mkdir(dst, { recursive: true });
      for (const e of await fsp.readdir(src, { withFileTypes: true })) {
        const s = path.join(src, e.name);
        const d = path.join(dst, e.name);
        if (e.isDirectory()) {
          await copyTree(s, d);
        } else if (e.isFile()) {
          // 已经在目标里的同名文件、大小也一致 → 跳过。
          // 迁移大目录时中途失败重来，不用把几十 GB 重新抄一遍。
          const st = await fsp.stat(s).catch(() => null);
          const dt = await fsp.stat(d).catch(() => null);
          if (st && dt && st.size === dt.size) continue;
          try {
            await fsp.copyFile(s, d);
            copied++;
          } catch (err) {
            failed.push(`${e.name}: ${err.code || err.message}`);
          }
        }
      }
    };
    try {
      if (await fsp.stat(from).then(() => true, () => false)) await copyTree(from, target.dir);
    } catch (e) {
      return fail(res, 500, `复制失败（源目录没动过，数据还在）：${e.code || e.message}`);
    }
    if (failed.length) {
      return fail(res, 500, `有 ${failed.length} 个文件没复制成功（源目录没动过）：${failed.slice(0, 3).join('；')}`);
    }

    // 复制成功了才改配置。顺序很重要：先存盘、再切内存，
    // 存盘失败就当没发生过，服务继续用老目录，不会出现「内存里换了、重启又变回去」。
    await saveConfig({ storage: { [which === 'models' ? 'modelsDir' : 'lecturesDir']: target.custom ? target.dir : '' } });
    applyStorageConfig();
    return json(res, 200, {
      ok: true,
      moved: copied,
      dir: which === 'models' ? HF_CACHE : LECT_DIR,
      fromDir: from,
      // 「旧目录还占着地方吗」——拿**刚刚生效的**新位置跟 from 比。
      // 这里以前写成跟 *默认* 位置比，结果是：从默认位置迁到自定义目录时
      // 回 false（明明源目录一个字节没删、文件都还在），界面上就会漏掉
      // 「旧目录需要你自己清」这句最该说的话。
      oldKept: from !== (which === 'models' ? HF_CACHE : LECT_DIR),
      message: copied ? `已复制 ${copied} 个文件` : '目标位置已经有这些文件，无需复制',
    });
  }

  // 在资源管理器里打开存储目录。
  //
  // 只认 which、不认用户传的 dir —— 这是一个「能让本机弹窗口」的接口，
  // 绝不能变成「随便传个路径就打开」。用户想看的只有两个地方：
  // 录音现在存哪、模型缓存在哪，这两个都是服务端自己算出来的。
  //
  // 用 spawn + detached + ignore：explorer.exe 打开文件夹后进程不退出，
  // 用 execFile 会一直挂在那儿等，还得靠 timeout 兜底。detached 之后
  // 父进程立刻返回，窗口是用户自己关的，跟服务没有关系。
  if (p === '/storage/open') {
    if (req.method !== 'POST') return fail(res, 405, '方法不支持');
    if (!isLoopback(req)) return fail(res, 403, '只允许在本机打开文件夹');
    const body = await readJsonBody(req);
    const which = body.which === 'models' ? 'models' : 'lectures';
    const dir = which === 'models' ? HF_CACHE : LECT_DIR;
    if (!fs.existsSync(dir)) return fail(res, 404, `这个目录还不存在：${dir}`);
    try {
      spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    } catch (e) {
      return fail(res, 500, `打不开文件夹：${e.message}`);
    }
    return json(res, 200, { ok: true, dir });
  }

  // 用户协议 / 隐私政策。
  // 正文就是安装目录里那两个 .txt —— 不复制一份到代码里，
  // 免得改条款要改两个地方、最后两边不一致（这在合规上是要命的）。
  // 只在「本机」回传全文：局域网里的人能看「读没读过」的状态，
  // 但协议全文属于这台机器的软件许可，没必要发给手机。
  // 打赏弹窗：该不该自动弹、以及用户点了「不再提示」。
  //
  // 判定「算不算新的一次开机」不需要真去监视开机事件，用一个简单可靠的办法：
  //   服务进程自己有个 BOOT_ID（启动时刻的秒级时间戳），前端把「上次见到的那次」
  //   存在浏览器 localStorage 里带上来看。对不上 = 服务重启过 = 新的一次打开。
  // 而刷新页面、切标签、前进后退都还是同一个 BOOT_ID，所以不会重复弹。
  //
  // lastShownAt 是第二道保险：万一启动器被杀了又立刻重启（崩溃自动拉起），
  // 两分钟内不重复弹，免得用户被连弹三次。
  if (p === '/donate') {
    const local = isLoopback(req);
    if (req.method === 'GET') {
      return json(res, 200, {
        ok: true,
        show: shouldShowDonate(u.searchParams.get('bootId')),
        hideOnStartup: !!config.donate?.hideOnStartup,
        bootId: BOOT_ID,
        // 只有本机才告诉它收款码在不在 —— 局域网用户看不到码也没用
        ...(local ? { codesPresent: donateCodesPresent() } : {}),
      });
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      if (!local) return fail(res, 403, '只允许在本机设置打赏提醒');
      const body = await readJsonBody(req);
      const patch = {};
      if (body.hideOnStartup !== undefined) patch.hideOnStartup = !!body.hideOnStartup;
      if (body.shown) patch.lastShownAt = new Date().toISOString();
      try {
        await saveConfig({ donate: { ...(config.donate || {}), ...patch } });
      } catch (e) {
        return fail(res, 500, `没保存成功：${e.code || e.message}`);
      }
      return json(res, 200, {
        ok: true,
        hideOnStartup: !!config.donate?.hideOnStartup,
        lastShownAt: config.donate?.lastShownAt || '',
      });
    }
    return fail(res, 405, '方法不支持');
  }

  // 更新公告弹窗：更新后才弹一次，展示 CHANGELOG.md 里这次改了什么。
  // GET 问「该不该弹 + 正文」，POST 在用户关窗后把当前版本写回 seenVersion。
  // 手机上不弹（跟打赏一个道理，那是给电脑用户看的），但 GET 照常给数据，
  // 免得以后想在手机上看更新记录时还要另开接口。
  if (p === '/whats-new') {
    if (req.method === 'GET') {
      return json(res, 200, {
        ok: true,
        show: shouldShowWhatsNew() && isLoopback(req),
        version: VERSION,
        seenVersion: config.whatsNew?.seenVersion || '',
        markdown: await readChangelog(),
      });
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      if (!isLoopback(req)) return fail(res, 403, '只允许在本机标记更新公告已读');
      await saveConfig({ whatsNew: { seenVersion: VERSION } });
      return json(res, 200, { ok: true, seenVersion: VERSION });
    }
    return fail(res, 405, '方法不支持');
  }

  if (p === '/agreement') {
    const local = isLoopback(req);
    // 安装向导里点过「我接受」的话，这里就别再问第二遍。
    // 安装程序写的是 data\install-agreed.txt（一行时间），读到就等同于
    // 「这台机器在安装时同意了当前版本的协议」，时间用安装那一刻的。
    await adoptInstallerAgreement();
    const state = {
      version: AGREE_VERSION,
      acceptedVersion: config.agreement?.version || '',
      acceptedAt: config.agreement?.acceptedAt || '',
      accepted: (config.agreement?.version || '') === AGREE_VERSION,
    };
    if (req.method === 'GET') {
      let text = { license: '', privacy: '' };
      if (local) text = await readAgreementText();
      return json(res, 200, { ok: true, ...state, text });
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      // 同意是「这台机器的用户」表态，不接受局域网里的远端代答 ——
      // 否则同一个入口地址被转发出去，别人点一下就替你同意了。
      if (!local) return fail(res, 403, '只允许在本机同意用户协议');
      const body = await readJsonBody(req);
      const version = String(body.version || AGREE_VERSION);
      const accepted = body.accepted !== false;
      try {
        await saveConfig({
          agreement: accepted
            ? { version, acceptedAt: new Date().toISOString() }
            : { version: '', acceptedAt: '' },
        });
      } catch (e) {
        return fail(res, 500, `没保存成功：${e.code || e.message}`);
      }
      return json(res, 200, {
        ok: true,
        version: AGREE_VERSION,
        acceptedVersion: config.agreement?.version || '',
        acceptedAt: config.agreement?.acceptedAt || '',
        accepted: (config.agreement?.version || '') === AGREE_VERSION,
      });
    }
    return fail(res, 405, '方法不支持');
  }

  // 已保存的 Key 清单：下拉选择、单独增删。
  // 注意这里只允许本机操作 —— 局域网里的人不该能翻别人的 Key 列表，
  // 更不该能往里塞一把自己的 Key（那样代理就会用他的 Key 花他的钱）。
  if (p === '/keys') {
    if (!isLoopback(req)) return fail(res, 403, '只允许在本机管理 API Key');
    if (req.method === 'GET') {
      return json(res, 200, {
        ok: true,
        keys: (config.keyVault || []).map((v) => ({ ...v, key: v.key, masked: maskKey(v.key) })),
      });
    }
    if (req.method === 'POST') {
      // 只把这个 Key 记进清单，不改变「当前正在用哪一把」。
      // 对应界面上的「存进清单」：先把备用 Key 存下来，以后换服务商再用。
      const body = await readJsonBody(req);
      const key = String(body.key || '').trim();
      if (!key) return fail(res, 400, '没有收到 Key');
      const vault = Array.isArray(config.keyVault) ? config.keyVault.slice() : [];
      if (vault.some((v) => v.key === key)) return json(res, 200, { ok: true, keys: vault, duplicate: true });
      const provider = String(body.provider || config.asr.provider || '');
      vault.push({
        id: randomBytes(6).toString('hex'),
        key,
        provider,
        label: describeKey(key, provider),
        savedAt: new Date().toISOString(),
      });
      try {
        await saveConfig({ keyVault: vault });
      } catch (e) {
        return fail(res, 500, `保存失败：${e.code || e.message}`);
      }
      return json(res, 200, {
        ok: true,
        keys: config.keyVault.map((v) => ({ ...v, key: v.key, masked: maskKey(v.key) })),
      });
    }
    if (req.method === 'DELETE') {
      const id = u.searchParams.get('id') || '';
      const before = (config.keyVault || []).length;
      const vault = (config.keyVault || []).filter((v) => v.id !== id);
      if (vault.length === before) return fail(res, 404, '没有找到这把 Key');
      try {
        await saveConfig({ keyVault: vault });
      } catch (e) {
        return fail(res, 500, `删除失败：${e.code || e.message}`);
      }
      return json(res, 200, { ok: true, keys: config.keyVault.map((v) => ({ ...v, masked: maskKey(v.key) })) });
    }
    return fail(res, 405, '方法不支持');
  }

  // 云端服务商清单：地址、推荐模型、价格、怎么申请。
  // 数据源就是仓库里的 public/providers.js —— 前端其实可以直接 import 那份文件，
  // 这里多给一个接口是为了「配置校验」和将来给手机端复用。
  if (p === '/providers') {
    const kind = u.searchParams.get('kind');
    const items = (kind ? listProviders(kind) : PROVIDERS).map((x) => ({
      id: x.id,
      kind: x.kind,
      name: x.name,
      tag: x.tag || '',
      baseUrl: x.baseUrl || '',
      asrUrl: x.asrUrl || '',
      models: x.models || [],
      asrModel: x.asrModel || '',
      asrModels: x.asrModels || [],
      free: !!x.free,
      local: !!x.local,
      manual: !!x.manual,
      note: x.note || '',
      console: x.console || '',
      docs: x.docs || '',
      setup: x.setup || [],
      apiKeyHint: x.apiKeyHint || '',
      // 默认模型要按这条记录自己的用途取：之前写成 kind==='asr' ? 'asr' : 'llm'，
      // 不传 kind 查全部时，转写那几家会被当成 llm，默认模型全空。
      defaultModel: defaultModel(x.id, x.kind === 'asr' ? 'asr' : 'llm'),
      costHint: (() => {
        const e = estimateNoteCost(x.id);
        return e ? `整理 1.5 小时的课约 ${e.yuan < 0.01 ? '不到 1 分' : e.yuan.toFixed(2) + ' 元'}（按 ${e.model} 估算）` : '';
      })(),
    }));
    return json(res, 200, { ok: true, checkedAt: PRICING_CHECKED_AT, providers: items });
  }
  if (p === '/gpu') {
    return json(res, 200, { ok: true, ...(await readGpu()) });
  }

  // 本地大模型的启停与状态。
  // 它常驻要占 6GB 显存，而浏览器做 WebGPU 转写也要显存 —— 抢不到就会悄悄退回 CPU，
  // 所以必须让用户能从界面上把它停掉释放显存。
  if (p === '/local-llm') {
    // 先读指针（快），指针没有或指向的文件没了再扫一遍候选目录（慢但兜底）
    let launcherPath = await readLocalLlmLauncher();
    let llmHome = launcherPath ? path.dirname(launcherPath) : '';
    // 指针指向的那份部署半途坏了（只剩 vbs、没有 llama-server.exe）→ 当作没部署，
    // 否则界面会显示「启动本地大模型」，点下去只会弹框报错。
    if (llmHome && !(await localLlmDeployOk(llmHome))) {
      launcherPath = '';
      llmHome = '';
    }
    if (!launcherPath) {
      const found = await findLocalLlmHome();
      if (found.ok) {
        launcherPath = found.launcher;
        llmHome = found.home;
        // 扫到了就记下来，下次不再扫盘
        await rememberLocalLlmHome(llmHome);
      } else if (found.home) {
        // 半成品：不认它，但把位置告诉前端，好提示「装了一半，重新部署」
        llmHome = found.home;
        launcherPath = '';
      }
    }
    const isRunning = async () => {
      try {
        const { stdout } = await execFileAsync('tasklist', ['/FI', 'IMAGENAME eq llama-server.exe', '/NH'], {
          timeout: 8000,
          windowsHide: true,
        });
        return /llama-server\.exe/i.test(String(stdout));
      } catch {
        return false;
      }
    };
    if (req.method === 'GET') {
      const [running, gpu, activeModel] = await Promise.all([isRunning(), readGpu(), activeLlmModelFile(llmHome)]);
      // home 给前端显示「装在哪」，用户找不到模型时能自己去看。
      // partial = 目录里有 start-llm.vbs 但缺运行时，是「装了一半」，
      // 界面要提示重新部署，而不是显示一个点了会报错的启动按钮。
      const partial = !!llmHome && !launcherPath;
      return json(res, 200, {
        ok: true,
        running,
        configured: !!launcherPath,
        partial,
        home: llmHome,
        // 当前装的是哪个 gguf。空串 = 还没设过（老部署），vbs 会退回 7B。
        activeModel,
        ...gpu,
      });
    }
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      if (body.action === 'stop') {
        await execFileAsync('taskkill', ['/IM', 'llama-server.exe', '/F'], { timeout: 10000, windowsHide: true }).catch(() => {});
        await new Promise((r) => setTimeout(r, 800));
        return json(res, 200, { ok: true, running: await isRunning(), ...(await readGpu()) });
      }
      /**
       * 换本地大模型：写指针 → 停旧的 → 用新模型重新拉起。
       *
       * 为什么必须重启：llama-server 一次只装一个 gguf，而且它压根不校验
       * 请求里的 model 字段（实测：随便写个名字也回 200，永远给启动时
       * -m 那个）。所以「换模型」在物理上就等于「换进程」。
       *
       * 停机→启动之间有 2~5 秒空档（取决于模型多大），期间润色会连不上。
       * 这比悄悄失败强：前端拿到 starting:true 就提示「正在重启」，
       * 而不是让用户点一次润色、等 30 秒、然后看见「连接被拒绝」。
       */
      if (body.action === 'model') {
        if (!llmHome) {
          return fail(res, 400, '还没有部署本地大模型，先在设置里点「部署本地模型」。');
        }
        const want = String(body.gguf || '').trim();
        if (!want) return fail(res, 400, '缺少 gguf 文件名');
        // 只收 models 目录里的文件名，别让人传 ..\..\ 去覆盖别处的文件
        if (/[\\/]/.test(want) || want.includes('..')) {
          return fail(res, 400, '模型文件名不合法');
        }
        const full = path.join(llmHome, 'models', want);
        if (!(await fsp.access(full, fs.constants.F_OK).then(() => true, () => false))) {
          return fail(
            res,
            404,
            `没有这个模型文件：${want}\n` +
              `去 ${path.join(llmHome, 'models')} 里看看 —— 这个档还没下载。`
          );
        }
        const changed = (await activeLlmModelFile(llmHome)) !== want;
        await setActiveLlmModel(llmHome, want);
        // 没在跑就别自作主张拉起来 —— 用户可能压根没开本地笔记。
        // 指针已经写好了，下次点「启动」自然读到新的。
        const wasRunning = await isRunning();
        if (!wasRunning) {
          return json(res, 200, { ok: true, switched: false, running: false, model: want });
        }
        if (!changed) {
          return json(res, 200, { ok: true, switched: false, running: true, model: want });
        }
        await execFileAsync('taskkill', ['/IM', 'llama-server.exe', '/F'], { timeout: 10000, windowsHide: true }).catch(() => {});
        // 等进程真的死掉 —— taskkill 返回不代表端口已释放，立刻拉起会 bind 失败
        for (let i = 0; i < 40; i++) {
          if (!(await isRunning())) break;
          await new Promise((r) => setTimeout(r, 150));
        }
        // 启动前先把启动器对一遍：老部署里的 start-llm.vbs 是旧版，
        // 里面写死了 7B，不改的话刚写进去的 active-model.txt 等于白写。
        await ensureLlmLauncher(llmHome);
        await execFileAsync('wscript.exe', [launcherPath], { timeout: 10000, windowsHide: true }).catch(() => {});
        return json(res, 200, { ok: true, switched: true, starting: true, model: want, home: llmHome });
      }
      if (body.action === 'start') {
        if (!launcherPath) {
          // 报错里带上「找过哪些地方」，用户能一眼看出自己装到别处了
          const looked = llmSearchRoots().slice(0, 4).map((r) => '  ' + r).join('\n');
          return fail(
            res,
            400,
            '还没有部署本地大模型。\n' +
              '可以在设置里点「部署本地模型」，或者手动运行一次：\n' +
              '  helpers\\setup-local-llm.ps1\n' +
              `（已经找过这些位置：\n${looked}\n  …）`
          );
        }
        // 同上：老部署里的 start-llm.vbs 是旧版（写死 7B、不读 active-model.txt），
        // 在这条「手动点启动」的路上也要对一遍，否则用户切了档点启动还是老模型。
        await ensureLlmLauncher(llmHome);
        await execFileAsync('wscript.exe', [launcherPath], { timeout: 10000, windowsHide: true }).catch(() => {});
        return json(res, 200, { ok: true, starting: true, home: llmHome });
      }
      return fail(res, 400, 'action 只能是 start 或 stop');
    }
    return fail(res, 405, '方法不支持');
  }
  /**
   * 一键部署本地大模型：把 helpers\setup-local-llm.ps1 跑起来。
   *
   * 为什么让服务端代跑、而不是让用户自己去文件管理器找脚本：
   * 「笔记润色要额外装个东西」这件事本身就够劝退了，
   * 再让他打开 PowerShell 敲路径，十个人里有九个会放弃。
   *
   * 部署脚本会下载约 4.4GB，所以要立刻返回、别把请求挂住；
   * 进度靠前端轮询 /local-llm 的 configured 字段。
   */
  if (p === '/local-llm/setup') {
    if (req.method !== 'POST') return fail(res, 405, '方法不支持');
    if (!isLoopback(req)) return fail(res, 403, '只允许在本机部署本地模型');
    const script = path.join(__dirname, 'helpers', 'setup-local-llm.ps1');
    if (!fs.existsSync(script)) {
      return fail(res, 400, '安装不完整：找不到 helpers\\setup-local-llm.ps1，请重新安装');
    }
    // 已经在装了就别开第二个 —— 两个进程同时解压同一个目录会把文件写坏
    if (localLlmSetup.running) {
      return json(res, 200, { ok: true, running: true, message: '已经在部署了，请稍候' });
    }
    localLlmSetup.running = true;
    localLlmSetup.startedAt = new Date().toISOString();
    spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', script,
        // 装到数据目录旁边：一定可写，用户也能在「环境自检」里看到路径
        '-AiHome', path.join(DATA_DIR, 'local-llm'),
      ],
      { detached: true, stdio: 'ignore', windowsHide: true }
    ).on('error', (e) => {
      console.warn('[本地模型] 部署脚本启动失败：', e.message);
      localLlmSetup.running = false;
    }).on('exit', () => {
      localLlmSetup.running = false;
    });
    return json(res, 200, {
      ok: true,
      running: true,
      message: '已开始部署，会下载约 4.4GB，装完这里会显示「启动本地大模型」',
    });
  }

  if (p === '/system') {
    return json(res, 200, {
      ok: true,
      cpus: os.cpus().length,
      totalMemGB: +(os.totalmem() / 1e9).toFixed(1),
      freeMemGB: +(os.freemem() / 1e9).toFixed(1),
      // 界面靠这个决定「存储位置」能不能操作。
      // 那段的两个接口都是本机限定（403），与其让手机端填完路径再挨一个 403，
      // 不如一开始就把按钮禁掉、说清楚为什么 —— 手机会看到一段只读的说明。
      local: isLoopback(req),
      lan: lanAddresses(),
      // 「手机访问」开关状态。lanOn 是配置里的开关，hostOnLan 是 socket 有没有
      // 真的绑在 0.0.0.0 上 —— 两者都为 true 手机才连得上，界面要分开显示，
      // 否则用户开了开关却发现没反应，不知道该怪谁。
      lanOn: lanAllowed(),
      hostOnLan: HOST === '0.0.0.0' || HOST === '::',
      modelCache: {
        dir: HF_CACHE,
        sizeGB: +((await dirSize(HF_CACHE)) / 1024 ** 3).toFixed(2),
        upstream: config.asr.modelHost,
      },
      // 录音和模型缓存的真实位置 + 默认位置 + 有没有退回默认。
      // 界面要能同时显示「现在存哪」和「改回默认是多少」，所以两个都给。
      // sizeGB 现场算 —— 用户挪过目录之后，界面上的数字必须跟着变，
      // 不能还显示老位置的大小。
      storage: {
        lectures: {
          dir: LECT_DIR,
          defaultDir: LECT_DIR_DEFAULT,
          custom: storageState.lectures.custom,
          error: storageState.lectures.error,
          sizeGB: +((await dirSize(LECT_DIR)) / 1024 ** 3).toFixed(2),
        },
        models: {
          dir: HF_CACHE,
          defaultDir: MODELS_DIR_DEFAULT,
          custom: storageState.models.custom,
          error: storageState.models.error,
          sizeGB: +((await dirSize(HF_CACHE)) / 1024 ** 3).toFixed(2),
        },
        dataDir: DATA_DIR,
      },
    });
  }

  if (p === '/lectures') {
    if (req.method === 'GET') return json(res, 200, { ok: true, lectures: await listLectures() });
    if (req.method === 'POST') {
      const title = (u.searchParams.get('title') || '').trim() || '未命名录音';
      const filename = (u.searchParams.get('filename') || 'audio.bin').trim();
      const course = (u.searchParams.get('course') || '').trim();
      const duration = Number(u.searchParams.get('duration') || 0) || 0;
      const ext = (path.extname(filename) || '.bin').toLowerCase();
      const id = randomUUID();
      const dir = lectDir(id);
      await fsp.mkdir(dir, { recursive: true });
      const audioFile = 'audio' + ext;
      const dest = path.join(dir, audioFile);
      const size = await new Promise((resolve, reject) => {
        let n = 0;
        const ws = fs.createWriteStream(dest);
        req.on('data', (c) => {
          n += c.length;
          if (n > MAX_UPLOAD) {
            ws.destroy();
            req.destroy();
            reject(new Error('文件超过上限'));
          }
        });
        req.on('error', reject);
        ws.on('error', reject);
        ws.on('finish', () => resolve(n));
        req.pipe(ws);
      }).catch(async (e) => {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
        throw e;
      });
      if (!size) {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
        return fail(res, 400, '上传内容为空');
      }
      const meta = await writeMeta({
        id,
        title,
        course,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        audioFile,
        originalName: filename,
        mime: MIME[ext] || 'application/octet-stream',
        size,
        duration,
        status: 'uploaded', // uploaded | transcribing | transcribed | failed
        engine: '',
      });
      await writeDoc(id, 'transcript', emptyDoc());
      return json(res, 201, { ok: true, lecture: meta });
    }
    return fail(res, 405, '方法不支持');
  }

  if (seg[0] === 'lectures' && seg[1]) {
    const id = safeId(seg[1]);
    if (!id) return fail(res, 400, '非法 id');
    const meta = await readMeta(id);
    if (!meta) return fail(res, 404, '讲次不存在');
    const sub = seg[2] || '';

    if (!sub && req.method === 'GET') {
      // 笔记走 readNote：过时的离线笔记会在这里被重算成最新算法版本，
      // 界面刷新一下就能看到，不用用户手动点「重新生成」。
      // 逐字稿只读一次（readNote 内部要用它算指纹，返回体里也要原样带回去）。
      const transcript = await readDoc(id, 'transcript');
      const { note, status } = await readNote(id, { transcript, meta });
      return json(res, 200, {
        ok: true,
        lecture: meta,
        transcript,
        note,
        noteStatus: status,
      });
    }
    if (!sub && req.method === 'PATCH') {
      const patch = await readJsonBody(req);
      for (const k of ['id', 'audioFile', 'createdAt']) delete patch[k];
      Object.assign(meta, patch);
      const saved = await writeMeta(meta);
      return json(res, 200, { ok: true, lecture: saved });
    }
    if (!sub && req.method === 'DELETE') {
      await fsp.rm(lectDir(id), { recursive: true, force: true });
      return json(res, 200, { ok: true });
    }
    if (sub === 'audio') {
      const target = audioPathOf(meta);
      let st;
      try {
        st = await fsp.stat(target);
      } catch {
        return fail(res, 404, '音频文件丢失');
      }
      const ext = path.extname(target).toLowerCase();
      const range = req.headers.range;
      const headers = {
        'content-type': MIME[ext] || meta.mime || 'application/octet-stream',
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
      };
      if (range && /^bytes=\d*-\d*$/.test(range)) {
        const [s, e] = range.replace('bytes=', '').split('-');
        const start = s === '' ? 0 : Number(s);
        const end = s === '' || e === '' ? st.size - 1 : Math.min(Number(e), st.size - 1);
        if (start > end || start >= st.size) {
          res.writeHead(416, { 'content-range': `bytes */${st.size}` });
          return res.end();
        }
        res.writeHead(206, { ...headers, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${st.size}` });
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(target, { start, end }).pipe(res);
      }
      res.writeHead(200, { ...headers, 'content-length': st.size });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(target).pipe(res);
    }
    if (sub === 'transcript') {
      if (req.method === 'GET') return json(res, 200, { ok: true, transcript: await readDoc(id, 'transcript') });
      if (req.method === 'PUT') {
        const body = await readJsonBody(req, 64 * 1024 * 1024);
        const doc = {
          language: body.language || '',
          engine: body.engine || '',
          model: body.model || '',
          device: String(body.device || ''),
          cleanedBy: String(body.cleanedBy || ''),
          denoise: body.denoise || null,
          text: String(body.text || ''),
          segments: Array.isArray(body.segments) ? body.segments : [],
          createdAt: body.createdAt || new Date().toISOString(),
        };
        await writeDoc(id, 'transcript', doc);
        meta.status = 'transcribed';
        meta.engine = doc.engine || meta.engine;
        meta.duration = Number(body.duration) || meta.duration;
        await writeMeta(meta);
        return json(res, 200, { ok: true, transcript: doc });
      }
      return fail(res, 405, '方法不支持');
    }
    if (sub === 'note') {
      if (req.method === 'GET') {
        const { note, status } = await readNote(id);
        return json(res, 200, { ok: true, note, noteStatus: status });
      }
      if (req.method === 'PUT') {
        const body = await readJsonBody(req, 32 * 1024 * 1024);
        // 写入前盖章：记下「这是哪版算法、对哪份逐字稿算的」。
        // 没有这行，以后算法升级时就分不清哪些笔记已经过时了。
        const tr = await readDoc(id, 'transcript');
        // mode 默认值从 'offline' 改成 'llm'：2026-11-13 起界面只有大模型润色这一条路，
        // 没带 mode 的写入（老脚本、手工 POST）不该被当成离线笔记 —— 那会让它在界面上
        // 显示成「旧版离线笔记」，而 0.9 之后根本不会再产生离线笔记。
        const mode = body.mode || 'llm';
        const doc = stampNote(
          {
            markdown: String(body.markdown || ''),
            data: body.data || null,
            mode,
            model: body.model || '',
            createdAt: body.createdAt || new Date().toISOString(),
          },
          { fingerprint: transcriptFingerprint(tr), mode }
        );
        await writeDoc(id, 'note', doc);
        // 连状态一起回：前端拿 note 却不更新 noteStatus，会继续显示「还没有笔记」，
        // 明明刚生成完却提示用户去生成一次。
        // 指纹用刚落盘时那份逐字稿（tr），不要拿 doc.sourceHash 跟自己比 —— 那样永远都算最新。
        const status = noteStatus(doc, { fingerprint: transcriptFingerprint(tr) });
        return json(res, 200, { ok: true, note: doc, noteStatus: status });
      }
      return fail(res, 405, '方法不支持');
    }
    if (sub === 'transcribe' && req.method === 'POST') {
      const body = await readJsonBody(req);
      // checkOnly：只检查「配置齐不齐」，不写状态、不碰音频、不发请求
      if (body.checkOnly) {
        const t = await transcribeViaApi(id, meta, { checkOnly: true });
        return json(res, 200, {
          ok: t.ok,
          checkOnly: true,
          provider: t.provider,
          name: t.who,
          url: t.url,
          model: t.model,
          verbose: t.verbose,
          error: t.error || null,
        });
      }
      // 试用到期后不再接受新的转写任务。已有的录音、逐字稿、笔记全都能看能导出，
      // 只是不能让软件再干活 —— 这是试用期唯一的门槛。
      meta.status = 'transcribing';
      await writeMeta(meta);
      const r = await transcribeViaApi(id, meta, body);
      meta.status = r.ok ? 'transcribed' : 'failed';
      meta.engine = r.ok ? r.engine : meta.engine;
      await writeMeta(meta);
      if (!r.ok) return fail(res, 502, r.error);
      const doc = { language: body.language || config.asr.language, engine: r.engine, model: r.model, text: r.text, segments: r.segments, createdAt: new Date().toISOString() };
      // 返回 writeDoc 的返回值而不是 doc：writeDoc 里会再走一遍 normalizeTranscript
      // 和 cleanSegments，回给前端的必须是「磁盘上真正存下的那一份」，
      // 否则界面显示的和文件里存的会差几个字（杂符没洗掉的那几个）。
      const saved = await writeDoc(id, 'transcript', doc);
      return json(res, 200, { ok: true, transcript: saved });
    }
    if (sub === 'export') {
      const kind = u.searchParams.get('kind') || 'docx';
      // 走 readNote：过时的离线笔记会在导出前被重算，导出的不会是旧算法的碎片主题
      const doc = (await readNote(id)).note;
      const tr = await readDoc(id, 'transcript');
      // 导出的是磁盘上的老 Markdown，里面可能还留着模型抄的
      // 「课程：（未填）｜日期：｜时长：未知」。这里用 meta 的真实值改一遍再生成文件，
      // 不然导出的 Word 和界面上看到的两副样子。
      const fixedMd = doc && doc.markdown
        ? applyNoteHeader(doc.markdown, {
            course: meta.course,
            createdAt: meta.createdAt,
            duration: Number(meta.duration) || 0,
          })
        : '';
      // 笔记类导出（Word / Markdown / PDF）只导正文，不带 <details> 里那份逐字稿。
      // 理由：那份附录是给网页端折叠看的（一节 52 分钟的课两万多字），
      // 导到 Word/PDF 里纸上折叠不了，几十页原文把笔记挤到最后；
      // 真要逐字稿有单独的 txt / srt 导出，本来就更合适。
      const noteOnlyMd = stripCheckSection(
        fixedMd.replace(/<details[\s\S]*?<\/details>/gi, '').replace(/\n{3,}/g, '\n\n').trim()
      );
      let buf;
      let name = '';
      let contentType = '';
      if (kind === 'docx') {
        const md = noteOnlyMd;
        if (!md) return fail(res, 404, '还没有可导出的内容');
        buf = markdownToDocx(md, meta.title || '课堂笔记');
        name = `${meta.title || 'notes'}.docx`;
        contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      } else if (kind === 'note') {
        const text = noteOnlyMd;
        if (!text) return fail(res, 404, '还没有可导出的内容');
        buf = Buffer.from(text, 'utf8');
        name = `${meta.title || 'notes'}.md`;
        contentType = 'text/markdown; charset=utf-8';
      } else if (kind === 'pdf') {
        const md = noteOnlyMd;
        if (!md) return fail(res, 404, '还没有可导出的内容');
        try {
          const r = await noteToPdf({
            markdown: md,
            title: meta.title || '',
            meta: { course: meta.course, createdAt: meta.createdAt, duration: Number(meta.duration) || 0 },
          });
          buf = r.buf;
        } catch (e) {
          // 找不到浏览器之类的问题要说清楚怎么办，别让用户对着「500」猜
          return fail(res, e.code === 'NO_BROWSER' ? 501 : 502, e.message || String(e));
        }
        name = `${meta.title || 'notes'}.pdf`;
        contentType = 'application/pdf';
      } else if (kind === 'txt') {
        const text = tr.text || tr.segments.map((s) => s.text).join('\n');
        if (!text) return fail(res, 404, '还没有可导出的内容');
        buf = Buffer.from(text, 'utf8');
        name = `${meta.title || 'transcript'}.txt`;
        contentType = 'text/plain; charset=utf-8';
      } else {
        const text = toSrt(tr.segments);
        if (!text) return fail(res, 404, '还没有可导出的内容');
        buf = Buffer.from(text, 'utf8');
        name = `${meta.title || 'transcript'}.srt`;
        contentType = 'application/x-subrip; charset=utf-8';
      }
      res.writeHead(200, {
        'content-type': contentType,
        'content-length': buf.length,
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      });
      return res.end(buf);
    }
  }

  /* ------ 自动更新 ------ */
  // 三个接口都只给本机。
  // 为什么：更新会替换程序文件、还会让服务退出 —— 这两件事都不该让
  // 局域网里拿着入口地址的人做（那等于给了对方一个「远程把软件弄坏」的按钮）。
  if (p === '/update/check') {
    if (req.method !== 'GET' && req.method !== 'POST') return fail(res, 405, '方法不支持');
    if (!isLoopback(req)) return fail(res, 403, '只允许在本机检查更新');
    const body = req.method === 'POST' ? await readJsonBody(req).catch(() => ({})) : {};
    const force = body?.force === true || u.searchParams.get('force') === '1';
    try {
      return json(res, 200, { ok: true, ...(await checkUpdate({ force })) });
    } catch (e) {
      return json(res, 200, { ok: true, enabled: true, current: VERSION, error: e.message });
    }
  }

  if (p === '/update/download') {
    if (req.method !== 'POST') return fail(res, 405, '方法不支持');
    if (!isLoopback(req)) return fail(res, 403, '只允许在本机下载更新');
    const body = await readJsonBody(req).catch(() => ({}));
    const cfg = config.update || DEFAULT_CONFIG.update;
    if (!cfg.enabled) return fail(res, 400, '自动更新已关闭');
    // 现拉一次清单，不信任前端传来的地址 —— 否则这个接口就成了
    // 「让本机下载任意 URL 并执行」的入口。
    const { feed, error } = await fetchFeed(cfg);
    if (error) return fail(res, 502, `下载不了：${error}`);
    // 只报「会下哪个文件」而不真下。给测试和界面预检用 —— 这个接口真跑起来是
    // 25MB 的下载，防御性测试不该为了验一句「不认外部地址」去拖整个安装包。
    // 2026-11-21 才发现这一点：以前仓库还没发过 Release，fetchFeed 直接报错、
    // 接口秒回 502，所以测试侥幸 0.0 秒通过；发完第一个 Release 之后它开始真的
    // 下载，跑满 180 秒超时。
    if (body.checkOnly || body.dryRun) {
      return json(res, 200, {
        ok: true,
        checkOnly: true,
        name: safeFileName(feed.installer.name),
        size: Number(feed.installer.size) || 0,
        sizeText: formatBytes(Number(feed.installer.size) || 0),
        url: feed.installer.url,
        version: feed.version,
        canInstall: isInstalledBuild(),
      });
    }
    const got = await downloadInstaller(feed);
    if (!got.ok) return fail(res, 502, `下载失败：${got.error}`);
    return json(res, 200, {
      ok: true,
      name: got.name,
      size: got.size,
      sizeText: formatBytes(got.size),
      reused: got.reused,
      version: feed.version,
      canInstall: isInstalledBuild(),
    });
  }

  if (p === '/update/install') {
    if (req.method !== 'POST') return fail(res, 405, '方法不支持');
    if (!isLoopback(req)) return fail(res, 403, '只允许在本机安装更新');
    if (!isInstalledBuild()) {
      return fail(res, 400, '这一份是绿色版（数据在程序目录里），不能自动安装。请到下载页手动换新版本。');
    }
    const got = await findDownloadedInstaller();
    if (!got) return fail(res, 400, '还没下载好安装包');
    const r = await applyUpdate(got.path);
    if (!r.ok) return fail(res, 400, r.error, { manual: r.manual });
    return json(res, 200, { ok: true, message: '正在退出并安装，装完会自动打开' });
  }

  if (p === '/update/ignore') {
    if (req.method !== 'POST') return fail(res, 405, '方法不支持');
    if (!isLoopback(req)) return fail(res, 403, '只允许在本机设置');
    const body = await readJsonBody(req);
    const version = String(body.version || '').trim();
    try {
      await saveConfig({ update: { ignoredVersion: version } });
    } catch (e) {
      return fail(res, 500, `没保存成功：${e.code || e.message}`);
    }
    return json(res, 200, { ok: true, ignoredVersion: config.update.ignoredVersion });
  }

  if (p === '/shutdown' && req.method === 'POST') {
    // 只允许本机（127.0.0.1）退出，避免局域网里有人把服务关掉
    const ip = String(req.socket.remoteAddress || '');
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!isLocal) return fail(res, 403, '只允许在本机退出服务');
    json(res, 200, { ok: true, message: '服务正在退出' });
    setTimeout(() => process.exit(0), 400);
    return;
  }

  if (p === '/llm' && req.method === 'POST') {
    const body = await readJsonBody(req, 16 * 1024 * 1024);
    const l = config.llm;
    const baseUrl = (body.baseUrl || l.baseUrl || '').replace(/\/+$/, '');
    const apiKey = body.apiKey || l.apiKey;
    const model = body.model || l.model;
    if (!baseUrl) return fail(res, 400, '未配置 LLM 地址');
    // 校对整节课可能要求模型逐条回抄原文，180 秒不够；但上限也要有，否则模型卡住会一直挂着
    const timeoutMs = Number(body.timeoutMs) || Number(l.timeoutMs) || 180000;
    const payload = {
      model,
      temperature: Number(body.temperature ?? l.temperature ?? 0.3),
      messages: body.messages,
      stream: false,
      // 不传 max_tokens 时用服务端默认值；llama-server 默认 -n_predict 512，
      // 会把输出硬截断成半截 JSON —— 所以"要求逐条回抄原文"的任务必须显式给足配额
      ...(body.max_tokens ? { max_tokens: Number(body.max_tokens) } : {}),
      // 思考型模型压住推理，否则请求会撞 fetch 的 300 秒 headersTimeout（见 thinkingHint）
      ...thinkingHint(model),
    };
    const headers = { ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}) };

    // 优先走 node:http：undici 的 300 秒 headersTimeout 会在长校对任务上提前掐断，
    // 而 llm.timeoutMs 配的是 420 秒 —— 掐断后整块被判失败、悄悄退回未校对原文。
    let status;
    let txt;
    const longCall = postJsonLong(baseUrl + '/chat/completions', {
      body: payload,
      headers,
      timeoutMs,
    });
    if (longCall) {
      try {
        const r = await longCall;
        status = r.status;
        txt = r.text;
      } catch (e) {
        return fail(res, 502, 'LLM 请求失败: ' + (e.cause?.message || e.message));
      }
    } else {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      let resp;
      try {
        resp = await fetch(baseUrl + '/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(payload),
          signal: ac.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        return fail(res, 502, 'LLM 请求失败: ' + (e.cause?.message || e.message));
      }
      clearTimeout(timer);
      status = resp.status;
      txt = await resp.text();
    }
    if (status < 200 || status >= 300) return fail(res, status, `LLM 返回 ${status}: ` + String(txt).slice(0, 500));
    let data;
    try {
      data = JSON.parse(txt);
    } catch {
      return fail(res, 502, 'LLM 返回非 JSON');
    }
    const content = data?.choices?.[0]?.message?.content ?? '';
    const finish = data?.choices?.[0]?.finish_reason ?? null;
    return json(res, 200, { ok: true, content, usage: data.usage || null, model, finishReason: finish });
  }

  if (p === '/llm/test' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const l = config.llm;
    const baseUrl = (body.baseUrl || l.baseUrl || '').replace(/\/+$/, '');
    const apiKey = body.apiKey || l.apiKey;
    const model = body.model || l.model;
    if (!baseUrl) return fail(res, 400, '未配置 LLM 地址');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30000);
    try {
      const resp = await fetch(baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}) },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: '回复两个字：可用' }], max_tokens: 16, ...thinkingHint(model) }),
        signal: ac.signal,
      });
      clearTimeout(timer);
      const txt = await resp.text();
      if (!resp.ok) return fail(res, resp.status, `连通失败 ${resp.status}: ` + txt.slice(0, 300));
      const data = JSON.parse(txt);
      return json(res, 200, { ok: true, reply: data?.choices?.[0]?.message?.content ?? '', model });
    } catch (e) {
      clearTimeout(timer);
      return fail(res, 502, '连通失败: ' + (e.cause?.message || e.message));
    }
  }

  return fail(res, 404, '未知接口: ' + p);
}

function toSrt(segments) {
  const fmt = (t) => {
    t = Math.max(0, Number(t) || 0);
    const h = String(Math.floor(t / 3600)).padStart(2, '0');
    const m = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
    const s = String(Math.floor(t % 60)).padStart(2, '0');
    const ms = String(Math.round((t % 1) * 1000)).padStart(3, '0');
    return `${h}:${m}:${s},${ms}`;
  };
  return (segments || [])
    .map((s, i) => `${i + 1}\n${fmt(s.start)} --> ${fmt(s.end)}\n${String(s.text || '').trim()}\n`)
    .join('\n');
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}
function localUrls() {
  const urls = [`http://127.0.0.1:${PORT}`];
  // 局域网地址必须带上入口密钥 —— 手机要用的就是这一串，不带密钥的地址在手机上会被拒。
  if (HOST === '0.0.0.0' || HOST === '::') for (const ip of lanAddresses()) urls.push(`http://${ip}:${PORT}${entryPrefix()}`);
  return urls;
}

/* --------------------------------- 主循环 -------------------------------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  res.setHeader('x-content-type-options', 'nosniff');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'access-control-allow-headers': 'content-type,authorization',
      'access-control-max-age': '600',
    });
    return res.end();
  }

  // 入口密钥校验。局域网来的请求没有密钥就到这里为止 ——
  // 回 404 而不是 403：连「这里有个服务」都不告诉外人。
  const grant = stripEntry(u.pathname, req);
  if (!grant.granted) {
    // 局域网开关关着时给一句人话：端口本来就绑在 0.0.0.0 上，扫描器看得见
    // 端口开着，藏也藏不住；而「手机打开说页面不存在」是最容易让人以为程序坏了
    // 的坑。数据仍然一个字节都出不去，这里只透露「有这么个软件」。
    if (grant.lanOff) {
      return fail(res, 403, '这台电脑关着「手机访问」。请在电脑上打开 设置 → 手机访问 再试。');
    }
    return fail(res, 404, '页面不存在');
  }
  // 第一次用带密钥的地址打开（手机）：种 cookie 并跳转到干净根路径，
  // 之后浏览器带着 cookie，地址栏就不会一直挂着那串密钥。
  if (grant.bare && req.method === 'GET' && !req.headers['sec-fetch-dest']?.includes('image')) {
    const keep = grant.path + (u.search || '');
    if (grant.path === '/' || grant.path === '/index.html') {
      res.writeHead(302, {
        'set-cookie': `ln_entry=${instance.secret}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`,
        location: keep,
        'cache-control': 'no-store',
      });
      return res.end();
    }
  }

  try {
    if (grant.path.startsWith('/api/')) {
      // handleApi 内部按 /api 前缀解析，这里把剥掉密钥后的路径写回去
      const orig = req.url;
      req.url = grant.path + (u.search || '');
      try {
        return await handleApi(req, res, new URL(req.url, `http://${req.headers.host || 'localhost'}`));
      } finally {
        req.url = orig;
      }
    }
    return await serveStatic(req, res, grant.path);
  } catch (e) {
    if (!res.headersSent) return fail(res, 500, e.message || '服务器内部错误');
    try {
      res.end();
    } catch {}
  }
});

// 注意：这里不装全局 error 处理。端口撞车由下面的 startServer 逐个 try 掉，
// 装了全局监听会抢先 process.exit，把「自动换端口」直接掐死。


// 配置要在检查目录之前读：录音和模型缓存的位置写在配置里，
// 先读配置、把 LECT_DIR / HF_CACHE 指过去，下面才检查得到真正的目标目录。
await loadInstance();
await loadConfig();
const appliedStorage = applyStorageConfig();

// 数据目录建不出来时，别甩一段 EPERM 堆栈给用户。
// 最常见的情况是把整个程序解压到 C:\Program Files（普通用户没有写权限），
// 那时用户只看到英文报错，完全不知道该怎么办。
try {
  await fsp.mkdir(LECT_DIR, { recursive: true });
} catch (e) {
  const reason =
    e.code === 'EPERM' || e.code === 'EACCES'
      ? '这个位置不允许写入。多半是把程序放在了 C:\\Program Files 这类需要管理员权限的目录。'
      : e.code === 'ENOSPC'
        ? '磁盘空间不足。'
        : e.code === 'EROFS'
          ? '这个位置是只读的。'
          : e.message;
  console.error('');
  console.error('  ┌────────────────────────────────────────────────┐');
  console.error('  │  讲义笔记 LectureNotes  —— 无法启动            │');
  console.error('  └────────────────────────────────────────────────┘');
  console.error('');
  console.error('  数据目录： ' + DATA_DIR);
  console.error('  录音目录： ' + LECT_DIR);
  console.error('  原因：     ' + reason);
  console.error('');
  console.error('  怎么办（任选一种）：');
  console.error('    1) 把整个程序文件夹挪到自己的用户目录，比如');
  console.error('         C:\\Users\\你的用户名\\Documents\\讲义笔记');
  console.error('       然后再双击 启动.vbs');
  console.error('    2) 换一个可写的数据目录（录音会存在那里）：');
  console.error('         set LECTURE_DATA=D:\\讲义笔记数据');
  console.error('         启动.vbs');
  console.error('    3) 如果一定要放在 Program Files，请右键以管理员身份运行一次。');
  console.error('');
  process.exit(1);
}
// 存储位置有问题的（填了但用不了 → 已退回默认），启动时就说清楚。
// 这种提示不能只在界面上做：服务是后台起的，用户可能根本不看那个窗口。
for (const [label, st] of [['录音', appliedStorage.lectures], ['模型缓存', appliedStorage.models]]) {
  if (!st.error) continue;
  console.warn('');
  console.warn(`  [提示] 设置里的${label}目录用不了，已临时改用默认位置。`);
  console.warn('         ' + st.error);
  console.warn('         现在用的是： ' + st.dir);
  console.warn('         可以打开界面 → 设置 → 存储位置 改回来。');
  console.warn('');
}
// Electron 运行时（当 Node 用时）启动时会在当前目录丢一个 crashpad 的 debug.log，
// 与本项目无关，顺手清掉，别让它躺在项目目录里
try {
  fs.rmSync(path.join(process.cwd(), 'debug.log'), { force: true });
} catch {}

// 老版本存下来的 Key 只在 asr.apiKey / llm.apiKey 里，清单是空的。
// 启动时补收一次，老用户打开设置就能在下拉里看到自己原来那把，不用重填。
// refreshKeyLabels 顺手把旧格式的「硅基流动 · …aatz」刷成纯服务商名（掩码现在单独显示）。
const vaultChanged = rememberKeys();
const labelsChanged = refreshKeyLabels();
if (vaultChanged || labelsChanged) await saveConfig({}).catch(() => {});
// 没显式指定端口时，用这台机器自己的随机端口（首次启动生成，之后固定）。
// 这样两台电脑上装同一份程序，端口天然不一样，不会互相串台。
if (!PORT_FIXED) PORT = instance.port;

/**
 * 问一句「这个端口上是不是我自己」。
 *
 * 2026-11-16 之前的做法是：撞 EADDRINUSE 就随机换一个端口，并把新端口**写回
 * instance.json**。这条「自动避让」看起来贴心，实际是个坑：
 *
 *   ① 浏览器把本地转写模型缓存在 Cache Storage 里，而 Cache Storage 是**按 origin
 *      （协议 + 主机 + 端口）隔离**的。端口一变，1.6 GB 的模型缓存立刻变孤儿，
 *      用户看到的就是「我明明下过模型，怎么每次转写都要重新下」。
 *   ② 连点两次 start.cmd 就会起两个进程，第二个把自己改成新端口 —— 而第一个
 *      还好好活着。于是同一台机器上出现两个实例，各占一个端口、各有一份浏览器
 *      缓存，用户完全不知道自己在用哪一个。
 *   ③ 地址变了，手机上存的局域网书签也失效。
 *
 * 所以改成：先问那个端口上是不是我自己的服务。`/api/health` 对局域网和本机都
 * 放行（启动器也是靠它认人的），里面只回版本号和端口，不含任何用户数据 ——
 * 拿它做身份确认正合适。是我就干脆不再监听（等同复用那个实例），直接退出让
 * 用户去连已经在跑的那个；不是我（版本号对不上 / 不是这个程序）才换端口。
 */
function probeSelf(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/health', method: 'GET', timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            // 认人三件套：ok + 版本号 + 端口号，三个都对才认。
            if (!(j && j.ok === true && typeof j.version === 'string' && Number(j.port) === Number(port))) {
              return resolve(false);
            }
            // 还要看数据目录 —— /api/health 只对回环地址吐 dataDir。
            // 端口上坐着的可能是「同一台机器上的另一份安装」，数据不在一起；
            // 那种情况不能复用（用户会以为自己打开的是这份拷贝的录音）。
            if (typeof j.dataDir === 'string' && j.dataDir && path.resolve(j.dataDir) !== path.resolve(DATA_DIR)) {
              return resolve(false);
            }
            resolve(true);
          } catch {
            resolve(false);
          }
        });
        res.on('error', () => resolve(false));
      }
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

// 随机端口也可能撞上别的软件。撞了先看是不是自己的另一个实例（见 probeSelf 的注释），
// 不是自己才换一个再试，并把新端口记进 instance.json。
function listenOnce(port) {  return new Promise((resolve, reject) => {
    const onErr = (e) => {
      server.removeListener('listening', onOk);
      reject(e);
    };
    const onOk = () => {
      server.removeListener('error', onErr);
      resolve();
    };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(port, HOST);
  });
}

/**
 * 数据目录里已经有本程序在跑了吗？是的话返回它的端口，否则 0。
 *
 * 这一步必须在「挑端口」之前做，因为 instance.json 里的端口和真正在跑的端口
 * 可能早就不是一个了（历史遗留的自动避让把 instance 改成过新端口，而老进程
 * 还占着原来的）。那种情况下光靠 EADDRINUSE 是发现不了的：新端口空着，服务
 * 就高高兴兴起来了 —— 于是同一份数据目录上跑着两个实例，各有一份浏览器缓存，
 * 用户完全不知道自己连的是哪个。
 *
 * 两条线索都试：
 *   1) runtime.json —— 服务每次启动成功都会写，进程退出会删；
 *   2) instance.json 里记的端口 —— 启动成功时也会同步成实际端口（见下方
 *      「记住这次真正用的端口」），所以它通常也是准的。runtime.json 被后来的
 *      进程覆盖掉、或者干脆丢了的时候，这条就是唯一的线索。
 */
async function findRunningSelf() {
  // 先按 runtime.json 找（最准，还带 pid）
  let rt = null;
  try {
    rt = parseJsonText(await fsp.readFile(RUNTIME_FILE, 'utf8'));
  } catch {
    /* 没在跑，或者被删了 */
  }
  const rtPort = Number(rt?.port) || 0;
  if (rtPort && Number(rt?.pid) > 0) {
    let alive = false;
    try {
      process.kill(Number(rt.pid), 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive && (await probeSelf(rtPort))) return rtPort;
  }
  // 退一步：instance.json 记的端口上是不是我自己
  const instPort = Number(instance?.port) || 0;
  if (instPort && instPort !== rtPort && (await probeSelf(instPort))) return instPort;
  return 0;
}

async function startServer() {
  // 先问「是不是已经有一个我在跑了」。找到了就直接让路，不抢端口、不改任何文件。
  if (!PORT_FIXED) {
    const running = await findRunningSelf();
    if (running) {
      console.log('');
      console.log(`   已经有本程序在 ${running} 端口跑着了（数据目录：${DATA_DIR}）。`);
      console.log(`   直接打开： http://127.0.0.1:${running}${entryPrefix()}`);
      console.log('   （确实要再起一个，用 --port 指定另一个端口，或换 --data。）');
      console.log('');
      process.exit(0);
    }
  }
  let port = PORT;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await listenOnce(port);
      PORT = port;
      return;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
      if (PORT_FIXED) {
        console.error(`\n[错误] 端口 ${port} 已被占用。换一个端口：  node server.mjs --port ${port + 1}\n`);
        process.exit(1);
      }
      // 占着这个端口的是不是我自己？（同一台机器上点了两次启动、或者上一个
      // 进程还没退干净）。是的话就不要再起第二个：两个实例各占一个端口，
      // 浏览器缓存会按 origin 分裂，用户会以为是「每次都要重新下模型」。
      if (await probeSelf(port)) {
        console.log('');
        console.log(`   已经有本程序在 ${port} 端口跑着了，这次不再重复启动。`);
        console.log(`   直接打开： http://127.0.0.1:${port}${entryPrefix()}`);
        console.log('   （想强制再起一个，用 --port 指定另一个端口。）');
        console.log('');
        process.exit(0);
      }
      // 换个没人用的端口，并把它变成这台电脑以后固定的端口
      port = 20000 + (randomBytes(2).readUInt16BE(0) % 20000);
      if (instance) {
        instance.port = port;
        await fsp.writeFile(INSTANCE_FILE, JSON.stringify(instance, null, 2), 'utf8').catch(() => {});
      }
      console.warn(`   （端口被别的软件占用了，自动换成 ${port}）`);
    }
  }
  throw new Error('找不到可用端口');
}

await startServer();

// 启动成功后再挂运行时错误处理：这之后 server 不该再报 EADDRINUSE，
// 真出别的错就照实说，不要闷着。
server.on('error', (e) => {
  console.error('\n[错误] 服务运行中出错：', e.message, '\n');
  process.exit(1);
});

const urls = localUrls();
console.log('');
console.log('  ┌────────────────────────────────────────────────┐');
console.log('  │   讲义笔记 LectureNotes  —— 本地服务已启动      │');
console.log('  └────────────────────────────────────────────────┘');
console.log('');
for (const u of urls) console.log('   ▸ 在浏览器打开： ' + u);
if (HOST === '0.0.0.0') {
  console.log('');
  console.log('   同一 Wi-Fi 下用手机浏览器打开上面的局域网地址，');
  console.log('   即可把手机里的录音直接上传到电脑处理。');
  console.log('   （地址里那串字母是这台电脑的专属钥匙，别发给不相关的人 ——');
  console.log('     谁拿到它就能访问这里的录音。）');
} else {
  console.log('');
  console.log('   需要手机上传录音？改用：  node server.mjs --host 0.0.0.0');
}
console.log('');
console.log('   数据目录： ' + DATA_DIR);
console.log('   停止服务： Ctrl + C');
console.log('');
// 告诉启动器「我在哪个端口、钥匙是什么」，它照着开浏览器就行。
// 如果返回 conflict，说明数据目录里另外那个实例还活着 —— 文件不动它，
// 免得把启动器指到「已经退出的端口」上去（见 writeRuntime 的注释）。
const rt = await writeRuntime().catch(() => null);
if (rt && rt.conflict) {
  console.log('');
  console.log(`   [注意] 数据目录里已经有本程序在 ${rt.conflict} 端口跑着，runtime.json 没动。`);
  console.log('   这个新实例用的是别的端口，浏览器缓存不会共享 ——');
  console.log('   建议关掉这个，直接用已经在跑的那个。');
  console.log('');
}

// 退出时清掉 runtime.json，这样启动器一眼就知道服务还在不在
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, async () => {
    await clearRuntime();
    process.exit(0);
  });
}
// 这条路是「没走上面三个信号、直接退出」的兜底（未捕获异常、process.exit(0) 等）。
// 必须验一下 pid：曾经见过同一份数据上跑着两个实例，后来那个把自己起不来的进程
// 一退出就把先来那个的 runtime.json 删了，于是启动器以为服务没了、又拉一个起来。
// exit 钩子里不能 await，所以这里同步读一次，只删自己的。
process.on('exit', () => {
  try {
    const cur = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
    if (cur && Number(cur.pid) === process.pid) fs.rmSync(RUNTIME_FILE, { force: true });
  } catch {}
});
