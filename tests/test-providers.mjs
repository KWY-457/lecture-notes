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
  modelSpec,
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

/* ------------------- 思考型模型要标出来（不然会超时） ------------------- */
section('思考型模型');
// 2026-10-28：GLM-5.3-Flash 的「AI 润色」一直失败，根因是它要先想几百字，
// 一份 21316 字的逐字稿在不限制时要跑 810~822 秒 —— 而 Node 内置 fetch
// 有 300 秒 headersTimeout 硬墙，界面只会看到「LLM 请求失败: Headers Timeout Error」。
// 服务端靠这个 thinking 标记去自动加 reasoning_effort:'low'（实测压到 160 秒、
// 思考 0 字、产出质量不掉），所以标记本身必须有测试守着。
// 反过来也要守住：不思考的模型不许乱标，标错等于平白改了用户选的行为。
const glmSpec = modelSpec('siliconflow', 'llm', 'zai-org/GLM-5.3-Flash');
check('GLM-5.3-Flash 标了 thinking', glmSpec && glmSpec.thinking === true, JSON.stringify(glmSpec));
const notThinking = ['Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen3-30B-A3B-Instruct-2507', 'deepseek-ai/DeepSeek-V3'];
check(
  '不思考的模型没有 thinking 标记',
  notThinking.every((id) => modelSpec('siliconflow', 'llm', id)?.thinking !== true),
  notThinking.filter((id) => modelSpec('siliconflow', 'llm', id)?.thinking === true).join(',')
);
check(
  'thinking 只标在 GLM 一家（asr 模型一律不标）',
  PROVIDERS.every((p) => ['asr', 'llm'].every((k) => modelsFor(p.id, k).every((m) => k === 'llm' || m.thinking !== true))),
  'asr 侧出现了 thinking 标记'
);
check('没登记的模型名查不到 thinking（服务端据此不加参数）', modelSpec('custom', 'llm', 'whatever') === null);

/* ------------------------- 卡片文案不许带括号 ------------------------- */
section('卡片文案');// 老大明确要求删掉括号里的注释（m02898 原话：「把这截图上括号里的内容给我删了」）。
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
  PROVIDERS.every((p) => ['asr', 'llm'].every((k) => modelsFor(p.id, k).every((m) => ['free', 'budget', 'value', 'pro'].includes(m.tier)))),
  '有模型缺 tier 的服务商：' +
    PROVIDERS.flatMap((p) => ['asr', 'llm'].flatMap((k) => modelsFor(p.id, k).filter((m) => !m.tier).map((m) => `${p.id}/${m.id}`))).join(',')
);
check(
  '每张卡片都有质量说明',
  PROVIDERS.every((p) => ['asr', 'llm'].every((k) => modelsFor(p.id, k).every((m) => !!m.qualityNote))),
  '缺 qualityNote 的：' +
    PROVIDERS.flatMap((p) => ['asr', 'llm'].flatMap((k) => modelsFor(p.id, k).filter((m) => !m.qualityNote).map((m) => `${p.id}/${m.id}`))).join(',')
);
// 2026-10-29 老大定：卡片第二行只讲生成质量，不讲价格（收费与否已经由档位徽章说完了）。
// priceNote 只剩「模型多大」这类硬事实（本地 Whisper 那三张），没有就留空。
const priceWords = /免费|收费|元|¥|\$|价|便宜|贵|花/;
const priced = allNotes.filter(([k, t]) => k.endsWith('priceNote') && priceWords.test(t));
check('priceNote 里不再讲价格', priced.length === 0, priced.map(([k, t]) => `${k}="${t}"`).join(' | '));
// 既然档位已经说了贵不贵，质量说明就不该再写缺点（老大原话：「别写会成片听错这种」）。
const badWords = /听错|错字|不准|变多|略降|代价|不吐标点|吃显卡|会卡/;
const withBad = allNotes.filter(([k, t]) => k.endsWith('qualityNote') && badWords.test(t));
check('质量说明不写缺点', withBad.length === 0, withBad.map(([k, t]) => `${k}="${t}"`).join(' | '));

// 2026-10-29 老大嫌小字「AI 味重」：像「不思考直接答，一份笔记几十秒就出来」这种
// 是把技术细节当卖点讲，读着像机器写的。约束两点：
//   ① 一句话不超过 14 个字（一行放得下，别折行）
//   ② 不许出现内部术语 / 过程描述（思考、token、MoE 讲得再准，普通人也看不懂）
const withJargon = allNotes.filter(([, t]) => /不思考|思考过程|token|几十秒|同样不|直接答|推理/.test(t));
check('质量说明不出现内部术语', withJargon.length === 0, withJargon.map(([k, t]) => `${k}="${t}"`).join(' | '));
const tooLong = allNotes.filter(([, t]) => [...t].length > 14);
check('卡片小字一句话不超过 14 字', tooLong.length === 0, tooLong.map(([k, t]) => `${k}="${t}"（${[...t].length} 字）`).join(' | '));

/* ------------------------------ 作者推荐 ------------------------------ */
section('作者推荐');
// 推荐不是档位，是背书，所以是独立字段（一个模型可以既是 pro 又被推荐）。
check('DeepSeek-V3 标了作者推荐', modelsFor('siliconflow', 'llm').some((m) => m.id === 'deepseek-ai/DeepSeek-V3' && m.recommended === true));
check('推荐的模型必须同时有档位', modelsFor('siliconflow', 'llm').filter((m) => m.recommended).every((m) => !!m.tier));
// 2026-11-03 起本地转写那四档也撤掉了推荐标签（老大 m29061：「这个就不用打标签了
// 去掉标签」）。所以现在全项目只剩云端笔记里的推荐，且只在硅基流动那一家。
check('推荐只出现在云端笔记里', PROVIDERS.every((p) => ['asr', 'llm'].every((k) => modelsFor(p.id, k).every((m) => !m.recommended || (p.id === 'siliconflow' && k === 'llm')))));

/* --------------------- 本地转写模型的配置推荐 --------------------- */
section('本地转写模型的配置推荐');
// 老大 2026-11-03 原话：「对于本地转写的模型，可以多弄几个，对应电脑性能从低到高
// 都有适配，在不同模型后面标注性能参考，方便用户选择」。
// 当天晚上他又改了口径（m29061）：「底下的小字就不要标速度了，标出配置推荐，
// 什么GPU，内存多少，这个就不用打标签了去掉标签」。
// 所以现在每个本地转写模型带的是 reqNote（推荐配置），不再是 speedNote（实测耗时）。
// 耗时数据没删，留在 providers.js 里每档上方那段实测表注释中。
const localAsr = modelsFor('local', 'asr');
check('本地转写有 4 档可选', localAsr.length === 4, localAsr.map((m) => m.label).join(','));
check('每档都标了推荐配置', localAsr.every((m) => !!m.reqNote), '缺 reqNote 的：' + localAsr.filter((m) => !m.reqNote).map((m) => m.label).join(','));
check('每档都写清了模型多大', localAsr.every((m) => !!m.priceNote), '缺 priceNote 的：' + localAsr.filter((m) => !m.priceNote).map((m) => m.label).join(','));
// 配置推荐得真的说到显卡和内存，否则「什么GPU，内存多少」这句要求就没满足。
check('配置推荐里提到了显卡', localAsr.every((m) => /显卡|GPU/.test(m.reqNote)), localAsr.map((m) => m.reqNote).join(' | '));
check('配置推荐里提到了内存', localAsr.every((m) => /内存/.test(m.reqNote)), localAsr.map((m) => m.reqNote).join(' | '));
// 本地转写不再打「零成本」档位徽章和「作者推荐」标签（老大 m29061：「这个就不用打标签了去掉标签」）。
// 但 tier 字段不能删 —— 排序（sortedModels）还靠它。只要求别标 recommended。
check('本地转写不再标作者推荐', localAsr.every((m) => !m.recommended), localAsr.filter((m) => m.recommended).map((m) => m.label).join(','));
// medium 在 CPU 与 GPU 上都跑不起来（CPU 报 Error 1267168960 内存不足、GPU 报错），
// 留着就是给用户埋坑，所以整条删掉。
check('跑不起来的 medium 已剔除', !localAsr.some((m) => /medium/.test(m.id)), localAsr.map((m) => m.id).join(','));
check('转写模型全是 whisper 系（不能是别的任务）', localAsr.every((m) => /whisper/.test(m.id)));
// 显卡上跑不出正确结果的模型（base / small 的 fp16 是乱码或空输出）必须显式标 null，
// 让 worker 直接走 CPU —— 否则用户会「2 秒转完」拿到一屏乱码。
const forcedCpu = localAsr.filter((m) => m.gpuDtype === null).map((m) => m.label);
check('知道自己在显卡上跑不了的两个模型标了 null', forcedCpu.length === 2 && /base/.test(forcedCpu.join()) && /small/.test(forcedCpu.join()), forcedCpu.join(','));
const gpuOk = localAsr.filter((m) => m.gpuDtype && m.gpuDtype !== null).map((m) => m.label);
check('能用显卡的两个模型给了 fp16', gpuOk.length === 2 && /tiny/.test(gpuOk.join()) && /turbo/.test(gpuOk.join()), gpuOk.join(','));
check('每个本地转写模型都声明了 CPU 精度', localAsr.every((m) => !!m.cpuDtype));
// reqNote 是给买家看的，不能出现「相对实时倍数」这种只有作者看得懂的写法
check('配置推荐写成人话（不出现倍数/术语）', localAsr.every((m) => !/[×x]\s*实时|RTF|rtf|\d+\s*倍/.test(m.reqNote)), localAsr.map((m) => m.reqNote).join(' | '));

/* ------------------------------ 默认模型 ------------------------------ */
section('默认模型');
check('硅基流动转写默认 SenseVoiceSmall', defaultModel('siliconflow', 'asr') === 'FunAudioLLM/SenseVoiceSmall');
check('硅基流动笔记默认 Qwen2.5-7B', defaultModel('siliconflow', 'llm') === 'Qwen/Qwen2.5-7B-Instruct');
check('OpenAI 转写默认 whisper-1', defaultModel('openai', 'asr') === 'whisper-1');
// 2026-11-03 起默认改成 base：四档里它是最稳的折中 ——
// turbo 在纯 CPU 上只有 0.30×（一小时课要三小时多），拿它当默认等于默认坑没显卡的机器。
check('局部转写默认 base（没显卡也能在 20 分钟内出稿）', defaultModel('local', 'asr') === 'onnx-community/whisper-base');
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
