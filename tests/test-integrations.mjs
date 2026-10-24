/**
 * 第三方集成测试：用一个本地「假供应商」服务，验证
 *   1. 云端转写代理（/api/lectures/:id/transcribe → OpenAI 兼容 /audio/transcriptions）
 *   2. 大模型笔记代理（/api/llm → OpenAI 兼容 /chat/completions）+ 分段汇总流程
 * 不需要任何真实 API Key，全程离线可复现。
 *
 * 运行： node tests/test-integrations.mjs [appBase]
 */
import http from 'node:http';
import { guardConfig } from './config-guard.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const FAKE_PORT = 8791;
const FAKE = `http://127.0.0.1:${FAKE_PORT}`;

/* 测试会改服务端配置（写入假 Key / 假地址），跑完必须原样还原，
   否则用户的 data/config.json 会被污染，且新版本的默认值不会生效。
   还原放在 config-guard 里：正常结束、抛异常、被 Ctrl+C 都会尽量写回。 */
const restoreConfig = await guardConfig(BASE);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  → ' + detail}`);
};

/* ------------------ 假供应商 ------------------ */
const seen = { asr: [], chat: [] };
const fake = http.createServer((req, res) => {
  let body = [];
  req.on('data', (c) => body.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(body);
    const auth = req.headers.authorization || '';
    if (req.url.includes('/audio/transcriptions')) {
      const text = raw.toString('latin1');
      seen.asr.push({ auth, hasFile: /name="file"/.test(text), hasModel: /name="model"/.test(text), bytes: raw.length });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          text: '今天我们讲二叉树的遍历。所谓二叉树的遍历，是指按某种规则访问每个结点一次。',
          segments: [
            { start: 0, end: 12.5, text: '今天我们讲二叉树的遍历。' },
            { start: 12.5, end: 30, text: '所谓二叉树的遍历，是指按某种规则访问每个结点一次。' },
          ],
        })
      );
      return;
    }
    if (req.url.includes('/chat/completions')) {
      let payload = {};
      try { payload = JSON.parse(raw.toString('utf8')); } catch {}
      seen.chat.push({ auth, model: payload.model, messages: payload.messages?.length || 0, promptLen: (payload.messages || []).map((m) => m.content || '').join('').length });
      const content = [
        '# 测试课笔记（假模型）',
        '',
        '## 一句话概要',
        '这节课讲二叉树的四种遍历方式。',
        '',
        '## 关键词',
        '`二叉树` · `遍历` · `递归`',
        '',
        '## 课堂脉络与重点',
        '### 1. 遍历的定义 [00:32]',
        '- 按某种规则访问每个结点且只访问一次',
        '### 2. 四种遍历方式 [01:18]',
        '- 先序 / 中序 / 后序 / 层序',
        '',
        '## 考点提示',
        '- 中序遍历二叉搜索树得到递增序列 [03:16]',
        '',
        '## 自测题',
        '1. 中序遍历的特点是什么？',
      ].join('\n');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { total_tokens: 123 } }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not found"}');
  });
});
await new Promise((r) => fake.listen(FAKE_PORT, '127.0.0.1', r));
console.log(`\n=== 第三方集成测试（假供应商 @ ${FAKE}）===\n`);

/* ------------------ 工具 ------------------ */
const realFetch = globalThis.fetch;
globalThis.fetch = (u, o) => realFetch(String(u).startsWith('/') ? BASE + u : u, o);

const j = async (p, opts = {}) => {
  const r = await fetch(BASE + p, {
    ...opts,
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  return { status: r.status, ...d };
};

/* ------------------ 准备一条录音 ------------------ */
const wav = Buffer.alloc(2048);
const q = new URLSearchParams({ title: '集成测试课', filename: 'it.wav', duration: '60' });
const up = await fetch(`${BASE}/api/lectures?${q}`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav }).then((r) => r.json());
check('创建测试讲次', up.ok === true, JSON.stringify(up));
const id = up.lecture.id;

/* ------------------ 1. 云端转写代理 ------------------ */
console.log('\n--- 1. 云端转写代理 ---');
const cfg1 = await j('/api/config', { method: 'PUT', body: { asr: { provider: 'custom', endpoint: `${FAKE}/v1/audio/transcriptions`, apiKey: 'sk-fake-123', model: 'fake-asr', language: 'zh' } } });
check('写入云端转写配置', cfg1.ok === true, JSON.stringify(cfg1).slice(0, 200));
// 本机请求回传明文（为了让人确认 Key 还在），同时给掩码；局域网只给掩码，这条边界下面单独验。
check(
  'Key 本机可见且有掩码',
  cfg1.config.asr.apiKey === 'sk-fake-123' && cfg1.config.asr.hasApiKey === true && cfg1.config.asr.apiKeyMasked,
  JSON.stringify(cfg1.config.asr)
);

const tr = await j(`/api/lectures/${id}/transcribe`, { method: 'POST', body: { language: 'zh' } });
check('云端转写成功', tr.ok === true && tr.transcript, JSON.stringify(tr).slice(0, 250));
check('供应商收到了 multipart 文件', seen.asr.length === 1 && seen.asr[0].hasFile, JSON.stringify(seen.asr));
check('供应商收到了 model 字段', seen.asr[0]?.hasModel === true, JSON.stringify(seen.asr));
check('API Key 透传正确', seen.asr[0]?.auth === 'Bearer sk-fake-123', seen.asr[0]?.auth);
check('解析出 2 个时间轴分段', tr.transcript?.segments?.length === 2, JSON.stringify(tr.transcript?.segments));
check('分段带时间戳', tr.transcript?.segments?.[1]?.start === 12.5, JSON.stringify(tr.transcript?.segments?.[1]));
check('逐字稿已入库', tr.transcript?.text?.includes('二叉树的遍历'), '');
check('讲次状态更新为已转写', (await j(`/api/lectures/${id}`)).lecture.status === 'transcribed', '');

/* ------------------ 2. 未配置 Key 时应明确报错 ------------------ */
console.log('\n--- 2. 错误处理 ---');
await j('/api/config', { method: 'PUT', body: { asr: { apiKey: 'sk-fake-123' } } });
const savedKey = (await j('/api/config')).config.asr.hasApiKey;
check('空 Key 不会覆盖已保存的 Key', savedKey === true, '');

/* ------------------ 3. 大模型笔记代理 ------------------ */
console.log('\n--- 3. 大模型笔记代理 ---');
const cfg2 = await j('/api/config', { method: 'PUT', body: { llm: { enabled: true, baseUrl: `${FAKE}/v1`, model: 'fake-chat', apiKey: 'sk-llm-456' } } });
check('写入大模型配置', cfg2.ok === true, JSON.stringify(cfg2).slice(0, 200));

const { generateAINote } = await import('../public/llm.js');
const { analyze } = await import('../public/summarize.js');

const segments = Array.from({ length: 60 }, (_, i) => ({
  start: i * 12,
  end: i * 12 + 11,
  text: `第 ${i + 1} 句：这里讲二叉树的遍历与递归实现，中序遍历在二叉搜索树上会得到递增序列，这是一个重要性质。`,
}));
// 长逐字稿：撑到 1.8 万字以上，超过单次调用上限，强制走分段汇总
const longSegments = Array.from({ length: 180 }, (_, i) => ({
  start: i * 20,
  end: i * 20 + 19,
  text:
    `第 ${i + 1} 句：这里详细讲二叉树的遍历与递归实现，中序遍历在二叉搜索树上会得到递增序列，` +
    `这是一个非常重要的性质，考试经常考，非递归实现需要借助栈来模拟递归过程，注意左右孩子的入栈顺序不能反。`,
}));
const short = segments.slice(0, 4);
const analysis = analyze({ segments: longSegments, meta: { title: '集成测试课', duration: 1800 }, options: {} });

// 短逐字稿：单次调用
const beforeShort = seen.chat.length;
const out1 = await generateAINote({
  segments: short,
  meta: { title: '集成测试课', duration: 48 },
  analysis,
  options: { style: 'exam', extraPrompt: '这是计算机专业课' },
  onProgress: () => {},
});
const shortCalls = seen.chat.length - beforeShort;
check('短逐字稿生成成功', out1.markdown.length > 50, out1.markdown.slice(0, 120));
check('短逐字稿只调用一次模型', shortCalls === 1, `调用 ${shortCalls} 次, steps=${out1.steps}`);
check('[mm:ss] 被转成可点链接', out1.markdown.includes('[00:32](#t=32)'), out1.markdown.match(/\[[^\]]+\]\([^)]+\)/g)?.join(' '));
check('[时:分:秒] 被正确换算', (await import('../public/llm.js')).linkifyTimestamps('[03:16]') === '[03:16](#t=196)', '');
check('额外要求被带上', seen.chat.at(-1).promptLen > 0, '');

// 长逐字稿：分段 map-reduce
const before = seen.chat.length;
const out2 = await generateAINote({
  segments: longSegments,
  meta: { title: '集成测试课', duration: 1800 },
  analysis,
  options: { style: 'exam' },
  onProgress: () => {},
});
const calls = seen.chat.length - before;
check('长逐字稿走分段汇总', calls >= 3, `调用了 ${calls} 次`);
check('分段数 = 模型调用数 - 1（减掉汇总那次）', out2.steps === calls, `steps=${out2.steps} calls=${calls}`);
check('长逐字稿产出笔记', out2.markdown.includes('课堂脉络与重点'), out2.markdown.slice(0, 120));
check('模型收到 system + user 两条消息', seen.chat.at(-1).messages === 2, JSON.stringify(seen.chat.at(-1)));

/* ------------------ 4. 大模型连通性测试接口 ------------------ */
const t = await j('/api/llm/test', { method: 'POST', body: {} });
check('/api/llm/test 可用', t.ok === true, JSON.stringify(t).slice(0, 200));

/* ------------------ 5. 供应商报错时的提示 ------------------ */
fake.close();
const bad = await j('/api/llm/test', { method: 'POST', body: {} });
check('供应商不可用时返回明确错误', bad.ok === false && /失败|error|ECONN|fetch/i.test(bad.error || ''), JSON.stringify(bad).slice(0, 200));
const badAsr = await j(`/api/lectures/${id}/transcribe`, { method: 'POST', body: {} });
check('转写服务不可用时返回明确错误', badAsr.ok === false && badAsr.error, JSON.stringify(badAsr).slice(0, 200));

/* --------------- 6. 单文件超限要在发请求之前拦住 --------------- */
// 硅基流动 Qwen3-ASR 对超限文件回的是裸 400（Content-Length: 0，一个字节都不给），
// 而且得先把几十 MB 传完才被拒（实测 29~33 秒）。所以必须自己先拦一道。
// 这里造一条「时长 2 小时」的假讲次：拦对了的话根本不会碰到网络，
// 拦漏了会真的往 api.siliconflow.cn 发一次（假 Key，只会拿到 401，不会花钱）。
console.log('\n--- 6. 单文件超限拦截 ---');
const q2 = new URLSearchParams({ title: '超长录音', filename: 'long.wav', duration: '7200' });
const up2 = await fetch(`${BASE}/api/lectures?${q2}`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav }).then((r) => r.json());
check('创建超长测试讲次（2 小时）', up2.ok === true && up2.lecture.id, JSON.stringify(up2).slice(0, 200));
const longId = up2.lecture.id;
await j('/api/config', { method: 'PUT', body: { asr: { provider: 'siliconflow', endpoint: '', apiKey: 'sk-fake-not-real', model: 'Qwen/Qwen3-ASR-1.7B' } } });
const tooBig = await j(`/api/lectures/${longId}/transcribe`, { method: 'POST', body: {} });
check('超长录音被拦住（不是 400）', tooBig.ok === false, JSON.stringify(tooBig).slice(0, 200));
check('错误里说清了是超上限', /超过上限/.test(tooBig.error || ''), tooBig.error);
check('错误里给出了可行的两个办法', /SenseVoiceSmall/.test(tooBig.error || '') && /切成两半|剪短/.test(tooBig.error || ''), tooBig.error);
// 关键：错误不能是「服务商回的东西」。拦漏了的话这里会是「转写服务返回 401/400: …」，
// 也就是用户现在遇到的那种天书。同时断言它是本地拦下的（HTTP 502 来自 /transcribe 路由）。
check('是本机拦下的，不是服务商回的错误', !/转写服务返回/.test(tooBig.error || ''), tooBig.error);
check('拦下之后状态标成失败，不是卡在转写中', (await j(`/api/lectures/${longId}`)).lecture.status === 'failed', '');
await j(`/api/lectures/${longId}`, { method: 'DELETE' });

/* ------------------ 复原配置 ------------------ */
const cleaned = await j(`/api/lectures/${id}`, { method: 'DELETE' });
check('清理测试数据', cleaned.ok === true, '');
await restoreConfig();
check('还原配置文件（不留测试 Key）', true, '');

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
process.exitCode = fail ? 1 : 0;
