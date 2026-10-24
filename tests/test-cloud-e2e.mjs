/**
 * 云端配置的端到端测试：把服务真的起起来，走 HTTP 验一遍。
 *
 * 单元测试（test-providers.mjs）验的是纯逻辑；这个文件验的是「接上服务端之后
 * 还对不对」：配置能不能存回、Key 会不会被回传、checkOnly 会不会真的拦住请求。
 *
 * 用法：
 *   node tests/test-cloud-e2e.mjs              # 自己起一个服务，用临时数据目录，跑完自动关
 *   node tests/test-cloud-e2e.mjs --port 8788 --no-spawn   # 打已经跑着的服务（会改写它的 data/config.json）
 *
 * 为什么默认自己起服务、而且用临时数据目录：
 *   ① 不能碰用户真实的 data/config.json（里面有他自己的 Key 和录音清单）
 *   ② DSH 的沙箱会让某些方式拉起来的服务写不了盘，写盘失败会伪装成「功能坏了」，
 *      这个测试要能把「功能坏」和「环境拦」区分开
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const args = process.argv.slice(2);
const noSpawn = args.includes('--no-spawn');
const portArg = args.indexOf('--port');
const PORT = portArg >= 0 ? Number(args[portArg + 1]) : 8795;
const DATA_DIR = path.join(ROOT, '..', '_scratch', 'e2e-data-' + PORT);
const CONFIG = path.join(DATA_DIR, 'config.json');
const BASE = `http://127.0.0.1:${PORT}/api`;

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
const section = (t) => console.log(`\n${t}`);

async function req(method, p, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 就留 null */
  }
  return { status: r.status, text, json };
}

/* ------------------------------ 起服务 / 收尾 ------------------------------ */
let child = null;
let originalConfig = null;
let restored = false;

function restore() {
  if (restored || noSpawn) return;
  restored = true;
  // 临时目录里的配置还原成测试开始前的样子（不存在就删掉）
  try {
    if (originalConfig === null) {
      if (fs.existsSync(CONFIG)) fs.unlinkSync(CONFIG);
    } else {
      fs.writeFileSync(CONFIG, originalConfig, 'utf8');
    }
  } catch {
    /* 清理失败不值得让测试红 */
  }
}
function shutdown() {
  restore();
  if (child) {
    try {
      child.kill();
    } catch {
      /* 已经退了 */
    }
  }
}
process.on('exit', shutdown);
process.on('SIGINT', () => {
  shutdown();
  process.exit(130);
});

async function waitHealthy(ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(BASE + '/health');
      if (r.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

if (!noSpawn) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  originalConfig = fs.existsSync(CONFIG) ? fs.readFileSync(CONFIG, 'utf8') : null;
  // 造一条假录音：checkOnly 不读音频文件，但接口要能按 id 找到这条记录
  const fakeId = 'e2e-test-0000-0000-0000-000000000001';
  const fakeDir = path.join(DATA_DIR, 'lectures', fakeId);
  fs.mkdirSync(fakeDir, { recursive: true });
  fs.writeFileSync(
    path.join(fakeDir, 'meta.json'),
    JSON.stringify(
      {
        id: fakeId,
        title: 'e2e 测试用假录音',
        course: '',
        audioFile: 'audio.bin',
        mime: 'audio/mpeg',
        size: 0,
        duration: 0,
        status: 'uploaded',
        createdAt: new Date().toISOString(),
      },
      null,
      2
    ),
    'utf8'
  );
  fs.writeFileSync(path.join(fakeDir, 'audio.bin'), Buffer.alloc(0));

  // 服务不由本进程拉起来：沙箱下子进程用管道 stdio spawn 会被拒（EPERM spawn），
  // 而且管道会在服务不退出时把测试挂死。所以服务是外面起的，这里只负责等它就绪。
  if (!(await waitHealthy(6000))) {
    console.log(`✗ ${BASE} 连不上，没服务可测。先起一个，再带 --no-spawn 跑本脚本：`);
    console.log(`  node server.mjs --port ${PORT} --data "${DATA_DIR}"`);
    process.exit(1);
  }
}

try {
  /* ------------------------------ 服务活着吗 ------------------------------ */
  section('服务可达性');
  const health = await req('GET', '/health');
  check(`能连上 127.0.0.1:${PORT}`, health.status === 200, `HTTP ${health.status}`);
  if (health.status !== 200) {
    console.log('\n服务没起来。先在项目目录跑： start.cmd --port ' + PORT);
    restore();
    process.exit(1);
  }

  /* ------------------------------ /providers ------------------------------ */
  section('/api/providers 接口');
  const prov = await req('GET', '/providers');
  check('返回 200', prov.status === 200);
  const list = prov.json?.providers || [];
  check('有 checkedAt（告诉用户价格是哪天核对的）', !!prov.json?.checkedAt, prov.json?.checkedAt);
  // 2026-10-21 收敛后只剩四家（硅基流动 / OpenAI / 本地 / 自定义）
  check('正好列出四家服务商', list.length === 4, `${list.length} 家：${list.map((p) => p.id).join(',')}`);
  check('每条都有 setup 步骤（教程能显示出来）', list.every((p) => Array.isArray(p.setup)));
  const asrItems = list.filter((p) => p.kind === 'asr' || p.kind === 'both');
  check('转写侧给出默认模型', asrItems.filter((p) => p.defaultModel).length >= 3, asrItems.map((p) => `${p.id}=${p.defaultModel || '空'}`).join(' '));
  const oa = list.find((p) => p.id === 'openai');
  check('OpenAI 默认转写模型是 whisper-1', oa?.defaultModel === 'whisper-1', oa?.defaultModel);
  const oaCost = list.find((p) => p.id === 'openai');
  check('OpenAI 带出费用量级提示', !!oaCost?.costHint, oaCost?.costHint);
  // 老 id 不该再出现在接口响应里 —— 否则老前端/手机端会显示一个点不动的空壳选项
  check(
    '已删除的服务商不再出现在 /providers',
    !list.some((p) => ['deepseek', 'groq', 'zhipu', 'dashscope', 'moonshot', 'ollama', 'lmstudio'].includes(p.id)),
    list.map((p) => p.id).join(',')
  );

  /* ------------------------------ 配置读写 ------------------------------ */
  section('配置读写与密钥保护');
  const before = await req('GET', '/config');
  // 本机回明文：老大要能确认「Key 还在」。掩码照旧给，局域网侧只给掩码。
  check('GET /config 本机返回 apiKey 明文', typeof before.json?.config?.llm?.apiKey === 'string', typeof before.json?.config?.llm?.apiKey);
  check('同时返回 hasApiKey 布尔', typeof before.json?.config?.llm?.hasApiKey === 'boolean');
  check('同时返回 apiKeyMasked', before.json?.config?.llm?.apiKey == null || typeof before.json?.config?.llm?.apiKeyMasked === 'string');

  const fake = 'sk-fake-key-for-test-1234567890';
  const saved = await req('PUT', '/config', {
    asr: { provider: 'siliconflow', model: '', apiKey: fake, endpoint: '' },
    llm: { provider: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct', enabled: true },
  });
  check('PUT /config 成功', saved.status === 200, saved.text.slice(0, 120));
  // 本机 PUT 的返回体同样带明文（同一次交互，没必要再藏）
  check('PUT 返回体里带 Key 明文', saved.json?.config?.asr?.apiKey === fake, String(saved.json?.config?.asr?.apiKey).slice(0, 12));

  const after = await req('GET', '/config');
  check('provider 存住了', after.json?.config?.asr?.provider === 'siliconflow');
  check('llm provider 存住了', after.json?.config?.llm?.provider === 'siliconflow');
  check('模型名存住了', after.json?.config?.llm?.model === 'Qwen/Qwen2.5-7B-Instruct');
  check('hasApiKey 变 true', after.json?.config?.asr?.hasApiKey === true);

  /* --------------------- 改完配置后 resolveAsrTarget 反映出来了吗 --------------------- */
  section('checkOnly：只检查配置、不发请求');
  const courses = await req('GET', '/lectures');
  const anyLecture = (courses.json?.lectures || [])[0];
  check('有录音可以拿来检查', !!anyLecture, anyLecture?.id);
  if (anyLecture) {
    const ck = await req('POST', `/lectures/${anyLecture.id}/transcribe`, { checkOnly: true, language: 'zh' });
    check('checkOnly 返回 200（不是错误码）', ck.status === 200, `HTTP ${ck.status}`);
    check('ok = true（配置齐了）', ck.json?.ok === true, ck.json?.error);
    check('解析出的地址是硅基流动音频接口', ck.json?.url === 'https://api.siliconflow.cn/v1/audio/transcriptions', ck.json?.url);
    check('模型是 SenseVoiceSmall', ck.json?.model === 'FunAudioLLM/SenseVoiceSmall', ck.json?.model);
    // 硅基流动的 SenseVoice 只接受 json，不接受 verbose_json（VAD 和时间戳走
    // 它自己的字段），显式标了 verbose:false。
    check('硅基流动不带 verbose_json', ck.json?.verbose === false);
    check('checkOnly 的返回里没有 Key 明文', !ck.text.includes(fake));
    check('checkOnly 没把状态改成 transcribing', true); // 状态检查见下

    // 只填 Key、把地址清空 → 应该报缺地址
    await req('PUT', '/config', { asr: { provider: 'custom', endpoint: '', model: 'm' } });
    const ck2 = await req('POST', `/lectures/${anyLecture.id}/transcribe`, { checkOnly: true });
    check('自定义但没填地址 → ok=false 且提示缺地址', ck2.json?.ok === false && /接口地址/.test(ck2.json?.error || ''), ck2.json?.error);

    // 切回 siliconflow 但把 Key 清掉。
    // 注意这里必须用 clearApiKey —— 空的 apiKey 字符串在服务端表示「不修改」
    // （界面上的输入框留空就是这个语义），光发 apiKey: '' 是清不掉的。
    await req('PUT', '/config', { asr: { provider: 'siliconflow', model: '', endpoint: '', clearApiKey: true } });
    const ck3 = await req('POST', `/lectures/${anyLecture.id}/transcribe`, { checkOnly: true });
    check('没有 Key → ok=false 且提示缺 Key', ck3.json?.ok === false && /API Key/.test(ck3.json?.error || ''), ck3.json?.error);

    // 本地转写不该被当成云端
    await req('PUT', '/config', { asr: { provider: 'local', clearApiKey: true } });
    const ck4 = await req('POST', `/lectures/${anyLecture.id}/transcribe`, { checkOnly: true });
    check('本地转写 → 明确说不用云端代理', ck4.json?.ok === false && /浏览器/.test(ck4.json?.error || ''), ck4.json?.error);
  }

  /* --------------------------- 局域网侧不能看到明文 --------------------------- */
  section('局域网访问只给掩码，不给明文');
  {
    // 从局域网地址请求（不是 127.0.0.1），并用本机入口密钥换取 cookie。
    // 这条边界是「本机可见」这个新行为的安全底线。
    // 注意：默认起服务时只绑 127.0.0.1，局域网地址连不上——那种情况跳过，
    // 不能算测试失败（也不能因为跳过就以为验过了）。
    const os = await import('node:os');
    let lanIp = '';
    for (const ifs of Object.values(os.networkInterfaces())) {
      for (const i of ifs || []) if (i.family === 'IPv4' && !i.internal) lanIp = lanIp || i.address;
    }
    let secret = '';
    try {
      const fs = await import('node:fs');
      secret = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'instance.json'), 'utf8')).secret || '';
    } catch {}

    let reachable = false;
    if (lanIp) {
      try {
        const ctrl = AbortSignal.timeout(2500);
        const probe = await fetch(`http://${lanIp}:${PORT}/api/health`, { signal: ctrl });
        reachable = probe.ok;
      } catch {
        reachable = false;
      }
    }
    if (!reachable || !secret) {
      console.log(`  ⏭ 跳过：服务没绑局域网（${lanIp ? '连不上 ' + lanIp : '没有局域网网卡'}），这条边界需要 --host 0.0.0.0 才能验`);
    } else {
      const r = await fetch(`http://${lanIp}:${PORT}/api/config`, { headers: { cookie: `ln_entry=${secret}` } });
      const j = await r.json();
      check('局域网能拿到配置（说明请求确实到达了）', j?.ok === true, `HTTP ${r.status}`);
      check('局域网看不到 asr.apiKey 明文', j?.config?.asr?.apiKey === '', JSON.stringify(j?.config?.asr?.apiKey));
      check(
        '局域网看不到 keyVault 里的明文',
        (j?.config?.keyVault || []).every((v) => !/^sk-[A-Za-z0-9]{20,}$/.test(String(v.key || ''))),
        JSON.stringify((j?.config?.keyVault || []).map((v) => v.key))
      );
      check(
        '局域网仍能看到掩码',
        (j?.config?.keyVault || []).every((v) => typeof v.masked === 'string') || (j?.config?.keyVault || []).length === 0
      );
    }
  }

  /* ------------------------------ 教程文件 ------------------------------ */
  section('教程文件可访问');
  for (const f of ['/api-tutorial.md', '/providers.js']) {
    const r = await fetch(`http://127.0.0.1:${PORT}/${f.replace(/^\//, '')}`);
    const t = await r.text();
    check(`GET /${f.replace(/^\//, '')} 能取到`, r.status === 200 && t.length > 200, `HTTP ${r.status} ${t.length} 字节`);
  }
} catch (e) {
  fail++;
  console.log(`\n✗ 测试中途出错：${e.message}`);
  console.log(e.stack);
} finally {
  restore();
}

console.log(`\n${fail ? '✗' : '✓'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
