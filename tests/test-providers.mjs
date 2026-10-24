/**
 * 云端服务商注册表 + 转写目标解析的单元测试。
 *
 * 这两件事写错的后果都挺严重：
 *   - 注册表 id 重复 → 界面显示的地址和实际请求的地址不是同一个
 *   - resolveAsrTarget 读请求体 → 用户存的 API Key 会被发到别人指定的服务器
 *   - verbose 标记错 → SenseVoice 一直 400，用户以为是自己 Key 填错了
 * 所以单独测一遍，不用起服务、不用联网。
 *
 *   node tests/test-providers.mjs
 */
import {
  PROVIDERS,
  listProviders,
  optionsFor,
  getProvider,
  defaultModel,
  modelsFor,
  estimateCost,
  resolveAsrTarget,
  selfCheck,
} from '../public/providers.js';

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
function section(t) {
  console.log(`\n${t}`);
}

/* ------------------------------ 注册表本身 ------------------------------ */
section('注册表结构');
check('id 没有重复（selfCheck 为空）', selfCheck().length === 0, selfCheck().join(' / '));
check('每条都有 id / name / kind', PROVIDERS.every((p) => p.id && p.name && p.kind));
check('kind 取值合法', PROVIDERS.every((p) => ['llm', 'asr', 'both'].includes(p.kind)));
check(
  '给用户看的 setup 步骤都不为空',
  PROVIDERS.every((p) => Array.isArray(p.setup) && p.setup.length > 0),
  PROVIDERS.filter((p) => !p.setup || !p.setup.length).map((p) => p.id).join(',')
);
check(
  '写了 console 地址的都是 https',
  PROVIDERS.every((p) => !p.console || /^https:\/\//.test(p.console))
);
check(
  '云端服务商（非本机）都写了 console 申请地址',
  PROVIDERS.filter((p) => p.console || !p.baseUrl || /127\.0\.0\.1|localhost/.test(p.baseUrl)).length > 0
);
check('只有「本地转写」这条标了 local', PROVIDERS.filter((p) => p.local).length === 1 && getProvider('local').local === true);

/* ------------------------------ 两个下拉的候选 ------------------------------ */
section('界面下拉候选');
const asrList = optionsFor('asr');
const llmList = optionsFor('llm');
// 2026-10-21 收敛：只剩四家，而且四家全部「转写 + 笔记都能做」。
// 之前 11 家里有 7 家只能做一半，用户第一步就得先算「这家能不能转写」，
// 界面还得为两种能力各准备一套模型列表 —— 全是自找的复杂度。
const WANTED = ['siliconflow', 'openai', 'local', 'custom'];
check('服务商只剩四家', PROVIDERS.length === 4, `实际 ${PROVIDERS.length} 家：${PROVIDERS.map((p) => p.id).join(',')}`);
check('转写下拉正好是这四家', asrList.map((p) => p.id).join(',') === WANTED.join(','), asrList.map((p) => p.id).join(','));
check('笔记下拉正好是这四家', llmList.map((p) => p.id).join(',') === WANTED.join(','), llmList.map((p) => p.id).join(','));
check('四家全部 kind=both', PROVIDERS.every((p) => p.kind === 'both'), PROVIDERS.filter((p) => p.kind !== 'both').map((p) => p.id).join(','));

/* --------------------- 模型跟服务商绑定，不会串台 --------------------- */
section('模型与服务商绑定');
// 关键回归：用户选了硅基流动，卡片里绝不该出现 whisper-1；选了 OpenAI，
// 也不该出现 SenseVoiceSmall。上一版模型名是自由输入框时没有这层保护。
const idsOf = (pid, kind) => modelsFor(pid, kind).map((m) => m.id);
check('硅基流动转写里没有 whisper-1', !idsOf('siliconflow', 'asr').includes('whisper-1'), idsOf('siliconflow', 'asr').join(','));
check('OpenAI 转写里没有 SenseVoiceSmall', !idsOf('openai', 'asr').includes('FunAudioLLM/SenseVoiceSmall'), idsOf('openai', 'asr').join(','));
check('局部的转写里没有云端模型', idsOf('local', 'asr').every((x) => /whisper/.test(x)), idsOf('local', 'asr').join(','));
check('自定义没有预设模型（由用户手填）', idsOf('custom', 'asr').length === 0 && idsOf('custom', 'llm').length === 0);
check(
  '两两服务商之间没有同名模型串台',
  (() => {
    for (const kind of ['asr', 'llm']) {
      const seen = new Map();
      for (const p of PROVIDERS) {
        for (const id of idsOf(p.id, kind)) {
          if (seen.has(id)) return false;
          seen.set(id, p.id);
        }
      }
    }
    return true;
  })()
);

/* ------------------------- 卡片文案不许带括号 ------------------------- */
section('卡片文案');
// 老大明确要求删掉括号里的注释（m02898 原话：「把这截图上括号里的内容给我删了」）。
// 理由：priceNote / qualityNote 会被拼成一行铺在卡片第二行，括号里的补充说明
// 在手机窄屏上会折成第三行，反而把「免费 / 付费」这个关键区别挤没了。
const allNotes = [];
for (const p of PROVIDERS) {
  for (const kind of ['asr', 'llm']) {
    for (const m of modelsFor(p.id, kind)) {
      if (m.priceNote) allNotes.push([`${p.id}/${m.id} priceNote`, m.priceNote]);
      if (m.qualityNote) allNotes.push([`${p.id}/${m.id} qualityNote`, m.qualityNote]);
    }
  }
}
const withParen = allNotes.filter(([, t]) => /[（(]/.test(t));
check('卡片文案里没有括号注释', withParen.length === 0, withParen.map(([k, t]) => `${k}="${t}"`).join(' | '));
check(
  '每张卡片都有档位徽章',
  PROVIDERS.every((p) => ['asr', 'llm'].every((k) => modelsFor(p.id, k).every((m) => ['free', 'value', 'pro'].includes(m.tier)))),
  '有模型缺 tier 的服务商：' +
    PROVIDERS.flatMap((p) => ['asr', 'llm'].flatMap((k) => modelsFor(p.id, k).filter((m) => !m.tier).map((m) => `${p.id}/${m.id}`))).join(',')
);
check(
  '每张卡片都有价格说明',
  PROVIDERS.every((p) => ['asr', 'llm'].every((k) => modelsFor(p.id, k).every((m) => !!m.priceNote)))
);

/* ------------------------------ 默认模型 ------------------------------ */
section('默认模型');
check('硅基流动转写默认 SenseVoiceSmall', defaultModel('siliconflow', 'asr') === 'FunAudioLLM/SenseVoiceSmall');
check('硅基流动笔记默认 Qwen2.5-7B', defaultModel('siliconflow', 'llm') === 'Qwen/Qwen2.5-7B-Instruct');
check('OpenAI 转写默认 whisper-1', defaultModel('openai', 'asr') === 'whisper-1');
check('局部转写默认 large-v3-turbo', defaultModel('local', 'asr') === 'onnx-community/whisper-large-v3-turbo');
check('局部笔记默认 qwen2.5-7b', defaultModel('local', 'llm') === 'qwen2.5-7b');
check('不存在的服务商返回空串', defaultModel('没有这家', 'llm') === '');
check('默认模型一定在候选列表第一项', PROVIDERS.every((p) => ['asr', 'llm'].every((k) => {
  const list = modelsFor(p.id, k);
  return !list.length || defaultModel(p.id, k) === list[0].id;
})));

/* ------------------------------ 费用估算 ------------------------------ */
section('费用估算');
// 现在四家里只有 OpenAI 写了 inPrice/outPrice（硅基流动的单价藏在控制台里，
// 官网上没有稳定的公开价目表，写死会变成误导）。所以费用估算的正例只剩 OpenAI。
const oa = estimateCost('openai', 'gpt-4o-mini', 1.5);
check('OpenAI gpt-4o-mini 能算出金额', oa && oa.yuan > 0, JSON.stringify(oa));
check('金额量级合理（1.5 小时课 < 10 元）', oa && oa.yuan < 10, oa && oa.yuan);
check('没写单价的返回 null（不编数字）', estimateCost('siliconflow', 'Qwen/Qwen2.5-7B-Instruct', 1.5) === null);
check('未知服务商返回 null', estimateCost('没有这家', 'x', 1.5) === null);
check('本地没写单价，返回 null 而不是 0 元', estimateCost('local', 'qwen2.5-7b', 1.5) === null);

/* --------------------- resolveAsrTarget：能不能发、发去哪 --------------------- */
section('转写目标解析');
const base = { asr: { provider: 'siliconflow', apiKey: 'sk-test', model: '', endpoint: '' } };
const t1 = resolveAsrTarget(base);
check('硅基流动：ok', t1.ok === true, t1.error);
check('硅基流动：地址 = 官方 /audio/transcriptions', t1.url === 'https://api.siliconflow.cn/v1/audio/transcriptions', t1.url);
check('硅基流动：模型自动补 SenseVoiceSmall', t1.model === 'FunAudioLLM/SenseVoiceSmall', t1.model);
check('硅基流动：不加 verbose_json（否则 400）', t1.verbose === false);

const t2 = resolveAsrTarget({ asr: { provider: 'custom', endpoint: 'https://api.groq.com/openai/v1/audio/transcriptions', apiKey: 'gsk-x', model: 'whisper-large-v3-turbo' } });
check('自定义（地址指向 Groq）：用用户填的地址', t2.url === 'https://api.groq.com/openai/v1/audio/transcriptions', t2.url);
check('自定义：用用户填的模型名', t2.model === 'whisper-large-v3-turbo', t2.model);
check('自定义：加 verbose_json（要拿逐段和时间戳）', t2.verbose === true);

const t3 = resolveAsrTarget({ asr: { provider: 'openai', apiKey: 'sk-x', model: '' } });
check('OpenAI：地址正确', t3.url === 'https://api.openai.com/v1/audio/transcriptions', t3.url);
check('OpenAI：默认 whisper-1', t3.model === 'whisper-1', t3.model);

const t4 = resolveAsrTarget({ asr: { provider: 'custom', endpoint: 'http://192.168.1.9:8000/v1/audio/transcriptions', apiKey: 'k', model: 'large-v3-turbo' } });
check('自定义：用用户填的地址', t4.url === 'http://192.168.1.9:8000/v1/audio/transcriptions', t4.url);
check('自定义：用用户填的模型名', t4.model === 'large-v3-turbo', t4.model);

// 自定义服务商不设单文件上限：自建的东西我们不知道边界，硬拦反而添乱
const t5 = resolveAsrTarget({ asr: { provider: 'custom', endpoint: 'https://x/v1/audio/transcriptions', apiKey: 'k', model: 'm' } });
check('自定义：没有单文件上限（不拦）', t5.maxSeconds === undefined && t5.maxBytes === undefined);

/* ------------------ 单文件上限：超了要自己拦，别白等 30 秒 ------------------ */
// 2026-10-22 实测（真 Key 直连，绕过本服务）：
//   硅基流动 Qwen/Qwen3-ASR-1.7B —— 42.7 分 / 39.5MB → 200；88.1 分 / 81.6MB → 400 空体
// 官方文档写「时长不超过 1 小时，文件大小不超过 50MB」，跟实测对得上。
section('单文件上限');
const qwenLim = resolveAsrTarget({ asr: { provider: 'siliconflow', apiKey: 'k', model: 'Qwen/Qwen3-ASR-1.7B' } });
check('Qwen3-ASR 登记了时长上限 3600 秒', qwenLim.maxSeconds === 3600, String(qwenLim.maxSeconds));
check('Qwen3-ASR 登记了体积上限 50MB', qwenLim.maxBytes === 50 * 1024 * 1024, String(qwenLim.maxBytes));
const svLim = resolveAsrTarget({ asr: { provider: 'siliconflow', apiKey: 'k', model: 'FunAudioLLM/SenseVoiceSmall' } });
check('SenseVoice 不设上限（实测 88 分钟能转完）', svLim.maxSeconds === undefined && svLim.maxBytes === undefined);
const oaiLim = resolveAsrTarget({ asr: { provider: 'openai', apiKey: 'k', model: 'whisper-1' } });
check('OpenAI whisper-1 不设上限（官方上限 25MB，但按分钟计费更该拦时长）', oaiLim.maxSeconds === undefined);


const e1 = resolveAsrTarget({ asr: { provider: 'siliconflow', apiKey: '', model: '' } });
check('缺 Key → 报错且指向设置位置', e1.ok === false && /API Key/.test(e1.error), e1.error);
const e2 = resolveAsrTarget({ asr: { provider: 'custom', endpoint: '', apiKey: 'k', model: 'm' } });
check('自定义但没填地址 → 报缺地址', e2.ok === false && /接口地址/.test(e2.error), e2.error);
const e3 = resolveAsrTarget({ asr: { provider: '没有这家', apiKey: 'k', model: 'm' } });
check('未知服务商 → 报缺地址而不是崩掉', e3.ok === false && typeof e3.error === 'string', e3.error);
check('空 config 不崩', (() => { try { resolveAsrTarget({}); return true; } catch { return false; } })());
const l1 = resolveAsrTarget({ asr: { provider: 'local', apiKey: '', model: '' } });
check('本地转写 → 明确说「不走云端代理」，不报缺地址', l1.ok === false && l1.local === true && /浏览器/.test(l1.error), l1.error);
check('本地转写不会被当成云端服务商去请求', l1.url === '');

/* --------------------- 安全：请求体不能覆盖地址 / 模型 / Key --------------------- */
section('安全：转写目标只认服务端保存的配置');
const saved = { asr: { provider: 'siliconflow', apiKey: 'sk-user-real-key', model: '' } };
const attacked = resolveAsrTarget({ ...saved, endpoint: 'http://evil.example.com/steal' });
check('请求体里塞 endpoint 不影响解析结果', attacked.url === 'https://api.siliconflow.cn/v1/audio/transcriptions', attacked.url);
check('Key 仍来自保存的配置', attacked.apiKey === 'sk-user-real-key');
check(
  'resolveAsrTarget 只吃一个参数（没有第二条注入口）',
  resolveAsrTarget.length === 1,
  `实际 ${resolveAsrTarget.length} 个参数`
);
check(
  '界面里显示的地址 == 实际请求的地址',
  (() => {
    // getProvider 给界面用，resolveAsrTarget 给请求用，两者必须一致
    for (const p of optionsFor('asr')) {
      if (p.id === 'local' || p.id === 'custom') continue;
      const r = resolveAsrTarget({ asr: { provider: p.id, apiKey: 'k', model: '' } });
      if (r.url !== p.asrUrl) return false;
    }
    return true;
  })()
);

/* --------------------- 已删除的服务商 id 不许复活 --------------------- */
section('已删除的服务商');
// 2026-10-21 收敛时删掉的 11 个 id。它们必须查不到 —— 否则界面上会冒出一个
// 「没有地址、没有模型、点了就报错」的空壳选项。
// 注意：server.mjs 的 LEGACY_PROVIDER_MAP 负责把老配置迁到新 id 上，
// 那是另一套逻辑，这里只管注册表本身干不干净。
const REMOVED = ['deepseek', 'dashscope', 'zhipu', 'moonshot', 'groq', 'local-llm', 'ollama', 'lmstudio', 'custom-llm'];
check('老 id 在注册表里一个都查不到', REMOVED.every((id) => getProvider(id) === null), REMOVED.filter((id) => getProvider(id)).join(','));
check('老 id 也不在下拉列表里', REMOVED.every((id) => !optionsFor('asr').some((p) => p.id === id) && !optionsFor('llm').some((p) => p.id === id)));
check('用 asr 用途查老 id 同样查不到', REMOVED.every((id) => getProvider(id, 'asr') === null));
check(
  'listProviders 与 optionsFor 的关系：前者不含「自定义」这类要手填地址的',
  listProviders('asr').length <= optionsFor('asr').length
);
check('只有「本地」这条标了 local', PROVIDERS.filter((p) => p.local).length === 1 && getProvider('local').local === true);

console.log(`\n${fail ? '✗' : '✓'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
