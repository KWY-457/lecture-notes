/**
 * 「手机访问」开关的回归测试。
 *
 * 只测服务端那一层：默认关着、关着时局域网 403、开了之后放行、
 * 非本机不能开开关、只绑 127.0.0.1 时开不了（409）。
 *
 * 界面那一层在 _scratch/shot-lan.mjs 里用真浏览器验（32 条断言）。
 *
 * 用法：node tests/test-lan.mjs [http://127.0.0.1:25994]
 * 需要服务已经在跑（或用 run-all.mjs --with-server）。
 *
 * ⚠️ 这个测试会临时改 config.lan.enabled，跑完必须还原 —— 用 try/finally
 * 保证，中途抛错也要还原。上一版 test-storage 就是没做到这点，留了个
 * Z:\ln-unplugged 在配置里。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = process.argv[2] || 'http://127.0.0.1:25994';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? '  → ' + detail : ''}`);
  }
};
const section = (t) => console.log(`\n=== ${t} ===`);

async function api(p, opts = {}) {
  const r = await fetch(BASE + '/api' + p, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let j = null;
  try {
    j = await r.json();
  } catch {}
  return { status: r.status, json: j };
}

/** 用局域网 IP 打自己，让服务端看到非回环对端 —— 这是验「外人能不能进」的唯一办法 */
let LAN_BASE = null;
async function detectLan() {
  const r = await api('/lan');
  if (r.json?.urls?.length) LAN_BASE = r.json.urls[0].replace(/\/$/, '');
  return r.json;
}
/** 从局域网地址取密钥段（http://ip:port/<secret>/） */
function lanSecret() {
  const m = String(LAN_BASE || '').match(/\/([a-z0-9]+)\/?$/);
  return m ? m[1] : '';
}

async function lanGet(p) {
  if (!LAN_BASE) return { status: 0, json: null };
  const u = LAN_BASE + p;
  try {
    // redirect: 'manual' —— 开了开关时根路径会 302 种 cookie，自动跟随会掩盖状态码
    const r = await fetch(u, { redirect: 'manual' });
    let j = null;
    try {
      j = await r.json();
    } catch {}
    return { status: r.status, json: j };
  } catch (e) {
    return { status: -1, json: { error: e.message } };
  }
}

// ---------------------------------------------------------------------------

const cfgFile = path.join(ROOT, 'data', 'config.json');
let original = null;
let mutating = false;

try {
  const health = await api('/health');
  if (!health.json?.ok) {
    console.error(`✗ 连不上 ${BASE}，先起服务再跑这个测试`);
    process.exit(1);
  }

  // 记下原值再动手，收到 finally 里还原
  if (fs.existsSync(cfgFile)) {
    original = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  }

  section('默认值与接口形状');
  const lan0 = await detectLan();
  check('GET /api/lan 可用', lan0?.ok === true, JSON.stringify(lan0));
  check('返回里有 enabled', typeof lan0?.enabled === 'boolean', typeof lan0?.enabled);
  check('返回里有 hostOnLan', typeof lan0?.hostOnLan === 'boolean', typeof lan0?.hostOnLan);
  check('返回里有 local', typeof lan0?.local === 'boolean', typeof lan0?.local);
  check('本机调到 /lan，local 是 true', lan0?.local === true, String(lan0?.local));
  check('服务开着时应该给得出 urls', !lan0?.enabled || (lan0?.urls || []).length > 0, JSON.stringify(lan0?.urls));
  const oriEnabled = lan0?.enabled === true;

  section('关着的时候，局域网进不来');
  await api('/lan', { method: 'POST', body: { enabled: false } });
  const offHome = await lanGet('/');
  const offApi = await lanGet('/api/lectures');
  if (lan0?.hostOnLan) {
    check('局域网带密钥访问首页被拒（403）', offHome.status === 403, `status=${offHome.status}`);
    check('拒绝理由说清了是「手机访问」关着', /手机访问/.test(offHome.json?.error || ''), offHome.json?.error);
    check('局域网调 API 也被拒（403）', offApi.status === 403, `status=${offApi.status}`);
  } else {
    console.log('  （服务只绑了本机，跳过局域网访问的检查）');
  }
  check('本机访问不受开关影响（200）', (await api('/lectures')).status === 200, '');

  section('非本机不能开关这个开关');
  if (lan0?.hostOnLan) {
    // 从局域网地址 POST —— 服务端看到的就不是回环
    const r = await fetch(LAN_BASE + '/api/lan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    }).catch(() => null);
    // 开关关着时连入口都过不去（403），这是更早的一道门，也算拒了
    check('从局域网开不了开关', !r || r.status === 403 || r.status === 404, `status=${r?.status}`);
  } else {
    console.log('  （服务只绑了本机，跳过）');
  }

  section('打开之后放行');
  if (lan0?.hostOnLan) {
    const on1 = await api('/lan', { method: 'POST', body: { enabled: true } });
    check('本机可以打开', on1.status === 200 && on1.json?.enabled === true, JSON.stringify(on1.json));
    check('POST 的返回也带 hostOnLan（否则界面会显示错乱）', typeof on1.json?.hostOnLan === 'boolean', String(on1.json?.hostOnLan));
    check('POST 的返回也带 local', typeof on1.json?.local === 'boolean', String(on1.json?.local));
    check('打开后给出了手机该访问的地址', (on1.json?.urls || []).length > 0, JSON.stringify(on1.json?.urls));
    check('地址里带密钥段（不然手机打开是 404）', new RegExp('/' + (lanSecret() || 'x') + '/?$').test((on1.json?.urls || [''])[0]), (on1.json?.urls || [''])[0]);

    const onHome = await lanGet('/');
    check('打开后局域网能进首页（302 种 cookie 跳转）', onHome.status === 302 || onHome.status === 200, `status=${onHome.status}`);
    const onApi = await lanGet('/api/lectures');
    check('打开后局域网能调 API（200）', onApi.status === 200, `status=${onApi.status}`);
    check('局域网拿到的是录音列表', Array.isArray(onApi.json?.items || onApi.json?.lectures), Object.keys(onApi.json || {}).join(','));

    section('关掉之后立刻失效（不用重启）');
    const off1 = await api('/lan', { method: 'POST', body: { enabled: false } });
    check('本机可以关掉', off1.status === 200 && off1.json?.enabled === false, JSON.stringify(off1.json));
    const offAgain = await lanGet('/api/lectures');
    check('关掉后局域网立刻又进不来（403）', offAgain.status === 403, `status=${offAgain.status}`);
  } else {
    console.log('  （服务只绑了本机，跳过）');
  }

  section('只绑本机时开不了（409）');
  if (!lan0?.hostOnLan) {
    const r = await api('/lan', { method: 'POST', body: { enabled: true } });
    check('返回 409 并说清要用启动器重启', r.status === 409 && /启动器/.test(r.json?.error || ''), JSON.stringify(r.json));
  } else {
    console.log('  （当前绑的是 0.0.0.0，构造不出这个场景，跳过）');
  }

  section('方法校验');
  const put = await fetch(BASE + '/api/lan', { method: 'PUT', body: '{}' });
  check('PUT 被拒（405）', put.status === 405, `status=${put.status}`);

  section('落盘');
  {
    const saved = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    check('config.json 里记着 lan.enabled', typeof saved?.lan?.enabled === 'boolean', JSON.stringify(saved?.lan));
    const nowLan = await api('/lan');
    check('磁盘上的值和接口回的一致', saved?.lan?.enabled === nowLan.json?.enabled, `${saved?.lan?.enabled} vs ${nowLan.json?.enabled}`);
  }
} finally {
  // 还原：把 lan.enabled 恢复成测试前的值
  if (original) {
    mutating = true;
    try {
      const want = original?.lan?.enabled === true;
      await api('/lan', { method: 'POST', body: { enabled: want } });
      const back = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
      const ok = back?.lan?.enabled === want;
      console.log(`\n=== 收尾 ===`);
      console.log(`  ${ok ? '✓' : '✗'} 配置已还原（lan.enabled=${want}）`);
      if (!ok) fail++;
      else pass++;
    } catch (e) {
      fail++;
      console.log(`  ✗ 还原失败：${e.message}`);
      console.log(`    → 手动改 ${cfgFile} 的 lan.enabled`);
    }
  }
}

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
