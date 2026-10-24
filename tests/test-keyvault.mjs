/**
 * API Key 清单（keyVault）测试。
 *
 * 验的是这几条硬边界：
 *   1. 存进清单（POST /api/keys）之后，重启读出来还在 —— 老大说「保存后再打开就消失了」的那个 bug
 *   2. 重复存同一把 Key 不产生第二条
 *   3. GET /api/config 的本机视角给明文 + 掩码，局域网视角只给掩码
 *   4. DELETE 能删掉指定 id，删不存在的 id 回 404
 *   5. 局域网（非 loopback）打 /api/keys 一律 403，明文绝不下发
 *   6. PUT /api/config 里带 keyVault 不生效（清单只能走 /api/keys 维护）
 *
 * 为什么要自己起服务：这个测试要「重启后还在」的语义，拿正式服务重启会搅乱
 * 用户数据，而且明文 Key 也会被写进人家真实的 config.json。所以和 test-donate
 * 一样用 LECTURE_DATA 起一份隔离的临时服务，跑完整个目录删掉。
 *
 * 「局域网视角」怎么造：isLoopback 看的是 socket 的 remoteAddress。同一台机器
 * 从 127.0.0.1 连永远是回环，装不成手机。实测可行的办法是直接连本机的局域网
 * 地址（http://192.168.x.x:port）—— 连接走的是那块网卡,服务看到的
 * remoteAddress 就是 192.168.x.x，isLoopback 判 false，和手机一模一样
 * （/api/health 此时不回 urls，就是证据）。用 --lan-ip 指定，默认自动探测。
 * 局域网请求要带 ln_entry cookie，用 GET /api/health 拿到的 urls 里那把密钥。
 *
 * 用法：
 *   node tests/test-keyvault.mjs                 （自动起临时服务，端口 8953）
 *   node tests/test-keyvault.mjs --port 8960     （换端口）
 *   node tests/test-keyvault.mjs --lan-ip 192.168.1.4
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const NODE = path.join(ROOT, 'runtime', 'node.exe');

function argVal(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const PORT = Number(argVal('port', 8953));
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(ROOT, '_scratch', `keyvault-test-${PORT}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
function check(name, ok, extra = '') {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? ' → ' + extra : ''}`);
}

/** 找一张本机的局域网网卡地址，用来模拟「手机/别人的电脑」 */
function lanAddress() {
  const forced = argVal('lan-ip', '');
  if (forced) return forced;
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal && !ni.address.startsWith('169.254.')) return ni.address;
    }
  }
  return '';
}

/**
 * 走局域网地址发请求（服务看到的 remoteAddress 就是那块网卡的地址）。
 * 连不上（没有网卡 / 防火墙）就抛错，调用方负责降级成 skip。
 */
function fetchLan(localAddress, pathname, opts = {}) {
  return new Promise((resolve, reject) => {
    const payload = opts.body ? Buffer.from(JSON.stringify(opts.body)) : null;
    const req = http.request(
      {
        host: localAddress,
        port: PORT,
        path: pathname,
        method: opts.method || 'GET',
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          ...(opts.headers || {}),
        },
        timeout: 8000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body = {};
          try {
            body = JSON.parse(text);
          } catch {
            body = { raw: text };
          }
          resolve({ status: res.statusCode, body });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/* ---------- 临时服务 ---------- */
let server = null;
async function startServer() {
  server = spawn(NODE, [path.join(ROOT, 'server.mjs'), '--port', String(PORT), '--host', '0.0.0.0'], {
    env: { ...process.env, LECTURE_DATA: DATA },
    stdio: 'ignore',
    windowsHide: true,
  });
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`).then((x) => x.json());
      if (r.ok) return r;
    } catch {}
    await sleep(250);
  }
  throw new Error('临时服务没起来（端口被占？换 --port 试试）');
}
async function stopServer() {
  if (!server) return;
  await fetch(`${BASE}/api/shutdown`, { method: 'POST' }).catch(() => {});
  await sleep(600);
  try {
    server.kill();
  } catch {}
  server = null;
  await sleep(400);
}

async function j(pathname, opts = {}) {
  const r = await fetch(BASE + pathname, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  return { status: r.status, ...d };
}

function readCfg() {
  const f = path.join(DATA, 'config.json');
  if (!fs.existsSync(f)) return {};
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return {};
  }
}

/* ================================ 开始 ================================ */
console.log('API Key 清单（keyVault）测试');
console.log(`  服务目录：${DATA}`);
fs.rmSync(DATA, { recursive: true, force: true });

try {
  const health = await startServer();
  console.log(`  服务地址：${BASE}  (version ${health.version})\n`);

  const KEY_A = 'sk-testaaaabbbbccccddddeeee0000';
  const KEY_B = 'sk-testffffggggjjjjkkkkllll1111';

  /* ---------------- 1. 空清单起步 ---------------- */
  console.log('--- 1. 空清单 ---');
  const k0 = await j('/api/keys');
  check('GET /api/keys 正常返回', k0.status === 200 && k0.ok === true, `status=${k0.status}`);
  check('一开始清单是空的', Array.isArray(k0.keys) && k0.keys.length === 0, JSON.stringify(k0).slice(0, 120));

  /* ---------------- 2. 存一把 Key ---------------- */
  console.log('\n--- 2. 存进清单 ---');
  const k1 = await j('/api/keys', { method: 'POST', body: { key: KEY_A, provider: 'siliconflow' } });
  check('POST /api/keys 成功', k1.ok === true, JSON.stringify(k1).slice(0, 160));
  check('清单里多了一条', Array.isArray(k1.keys) && k1.keys.length === 1, `len=${k1.keys?.length}`);
  check('存的是明文（本机）', k1.keys?.[0]?.key === KEY_A, k1.keys?.[0]?.key);
  check('带上了 id', !!k1.keys?.[0]?.id, k1.keys?.[0]?.id || '(空)');
  check('带上了保存时间', !!k1.keys?.[0]?.savedAt, k1.keys?.[0]?.savedAt || '(空)');
  check('掩码格式正确', /^sk-tes…0000$/.test(k1.keys?.[0]?.masked || ''), k1.keys?.[0]?.masked);
  check('注记里没有重复拼掩码', !String(k1.keys?.[0]?.label || '').includes('…'), k1.keys?.[0]?.label);
  const idA = k1.keys?.[0]?.id;

  /* ---------------- 3. 重复存同一把 ---------------- */
  console.log('\n--- 3. 去重 ---');
  const k1dup = await j('/api/keys', { method: 'POST', body: { key: KEY_A, provider: 'siliconflow' } });
  check('重复存不报错', k1dup.ok === true, JSON.stringify(k1dup).slice(0, 120));
  check('重复存标记为 duplicate', k1dup.duplicate === true, String(k1dup.duplicate));
  check('重复存不增加条数', k1dup.keys?.length === 1, `len=${k1dup.keys?.length}`);

  /* ---------------- 4. 存第二把 + 落盘 ---------------- */
  console.log('\n--- 4. 落盘 ---');
  const k2 = await j('/api/keys', { method: 'POST', body: { key: KEY_B, provider: 'siliconflow' } });
  check('第二把存进去了', k2.keys?.length === 2, `len=${k2.keys?.length}`);
  const onDisk = readCfg();
  check('config.json 里真的有 keyVault', Array.isArray(onDisk.keyVault) && onDisk.keyVault.length === 2, `len=${onDisk.keyVault?.length}`);
  check('磁盘上是明文（服务端自己用）', onDisk.keyVault?.[0]?.key === KEY_A, onDisk.keyVault?.[0]?.key);

  /* ---------------- 5. 重启后还在（老大报的那个 bug） ---------------- */
  console.log('\n--- 5. 重启后还在 ---');
  await stopServer();
  await startServer();
  const k3 = await j('/api/keys');
  check('重启后清单没丢', k3.keys?.length === 2, `len=${k3.keys?.length}`);
  check('重启后还是明文（本机）', k3.keys?.[0]?.key === KEY_A, k3.keys?.[0]?.key);

  /* ---------------- 6. GET /api/config 两种视角 ---------------- */
  console.log('\n--- 6. /api/config 视角 ---');
  const c1 = await j('/api/config');
  check('本机视角有 keyVault', Array.isArray(c1.config?.keyVault) && c1.config.keyVault.length === 2, `len=${c1.config?.keyVault?.length}`);
  check('本机视角 keyVault 给明文', c1.config?.keyVault?.[0]?.key === KEY_A, c1.config?.keyVault?.[0]?.key);
  check('本机视角仍带掩码', !!c1.config?.keyVault?.[0]?.masked, c1.config?.keyVault?.[0]?.masked);

  /* ---------------- 7. 局域网视角 ---------------- */
  console.log('\n--- 7. 局域网视角 ---');
  // 先给 asr 写一把真 Key，否则「hasApiKey 仍为真」这条测不出东西
  await j('/api/config', { method: 'PUT', body: { asr: { provider: 'siliconflow', apiKey: 'sk-lanprobe1234567890abcdef' } } });
  const lan = lanAddress();
  if (!lan) {
    console.log('  ⏭ 跳过：这台机器没有可用的局域网网卡');
  } else {
    // 入口密钥在 /api/health 的 urls 里（本机视角才给）。测试数据目录是新的，
    // instance.json 是这轮服务自己生成的，所以这把密钥就是它的。
    let secret = '';
    try {
      const h = await j('/api/health');
      secret = (h.urls || []).map((u) => u.match(/\/([a-z0-9]{8,})\/?$/)).find(Boolean)?.[1] || '';
    } catch {}
    const cookie = secret ? { cookie: `ln_entry=${secret}` } : {};
    try {
      const lanH = await fetchLan(lan, '/api/health');
      check('局域网能连上（探针）', lanH.status === 200 && lanH.body.ok === true, `status=${lanH.status}`);
      check('局域网视角不回 urls（暴露面收窄）', Array.isArray(lanH.body.urls) && lanH.body.urls.length === 0, JSON.stringify(lanH.body.urls));

      const lanCfg = await fetchLan(lan, '/api/config', { headers: cookie });
      const got = lanCfg.body?.config?.keyVault?.[0];
      check('局域网能拿到配置（带入口 cookie）', lanCfg.status === 200, `status=${lanCfg.status} ${JSON.stringify(lanCfg.body).slice(0, 100)}`);
      check('局域网 keyVault 不下发明文', got?.key === undefined || String(got?.key).includes('…'), String(got?.key));
      check('局域网 keyVault 只有掩码', /…/.test(got?.masked || ''), got?.masked);
      const lanAsr = lanCfg.body?.config?.asr;
      check('局域网 asr.apiKey 是空的', lanAsr?.apiKey === '', JSON.stringify(lanAsr?.apiKey));
      check('局域网 asr.hasApiKey 仍为真', lanAsr?.hasApiKey === true, String(lanAsr?.hasApiKey));
      check('局域网 asr.apiKeyMasked 有值', /…/.test(lanAsr?.apiKeyMasked || ''), lanAsr?.apiKeyMasked);

      const lanKeys = await fetchLan(lan, '/api/keys', { headers: cookie });
      check('局域网打 /api/keys 被拒', lanKeys.status === 403, `status=${lanKeys.status}`);
      check('拒绝理由明确', /只允许在本机/.test(lanKeys.body?.error || lanKeys.body?.raw || ''), lanKeys.body?.error || lanKeys.body?.raw);

      // 不带 cookie 的局域网请求：连「这里有个服务」都不该知道
      const lanBare = await fetchLan(lan, '/api/config');
      check('局域网不带密钥 → 404', lanBare.status === 404, `status=${lanBare.status}`);
    } catch (e) {
      console.log(`  ⏭ 跳过局域网对照组：连 ${lan} 失败（${e.message}）`);
    }
  }

  /* ---------------- 8. 不能整替换 ---------------- */
  console.log('\n--- 8. 清单不能被 PUT 整替换 ---');
  // 第 7 步给 asr 写了 Key，服务端会把它收进清单（rememberKeys 的真实行为），
  // 所以这里先取一次当前基数，别再写死成 2。
  const beforePut = (await j('/api/keys')).keys || [];
  const baseline = beforePut.length;
  const put = await j('/api/config', { method: 'PUT', body: { keyVault: [{ id: 'evil', key: 'sk-evil', provider: 'x' }] } });
  check('PUT 请求本身成功', put.ok === true, JSON.stringify(put).slice(0, 120));
  const afterPut = await j('/api/keys');
  check('清单没被整替换', afterPut.keys?.length === baseline, `len=${afterPut.keys?.length} baseline=${baseline}`);
  check('没有混进假的 Key', !(afterPut.keys || []).some((v) => v.key === 'sk-evil'), JSON.stringify(afterPut.keys?.map((v) => v.id)));

  /* ---------------- 9. 删除 ---------------- */
  console.log('\n--- 9. 删除 ---');
  const delBad = await j('/api/keys?id=not-exist', { method: 'DELETE' });
  check('删不存在的 id 回 404', delBad.status === 404, `status=${delBad.status}`);
  const del = await j(`/api/keys?id=${encodeURIComponent(idA)}`, { method: 'DELETE' });
  check('删指定的那把成功', del.ok === true, JSON.stringify(del).slice(0, 120));
  check('删完少一条', del.keys?.length === baseline - 1, `len=${del.keys?.length} baseline=${baseline}`);
  check('删掉的那条真的没了', !(del.keys || []).some((v) => v.id === idA), JSON.stringify(del.keys?.map((v) => v.id)));
  check('另一把还在', (del.keys || []).some((v) => v.key === KEY_B), JSON.stringify(del.keys?.map((v) => v.id)));
  const afterDel = readCfg();
  check('删除也落盘了', afterDel.keyVault?.length === baseline - 1, `len=${afterDel.keyVault?.length}`);

  /* ---------------- 10. 空 Key 被拒 ---------------- */
  console.log('\n--- 10. 边界 ---');
  const empty = await j('/api/keys', { method: 'POST', body: { key: '   ' } });
  check('空白 Key 被拒', empty.status === 400, `status=${empty.status}`);
  const badMethod = await j('/api/keys', { method: 'PATCH', body: {} });
  check('不支持的方法回 405', badMethod.status === 405, `status=${badMethod.status}`);
} catch (e) {
  fail++;
  console.error('\n测试崩了：', e?.stack || e);
} finally {
  await stopServer();
  fs.rmSync(DATA, { recursive: true, force: true });
}

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail === 0 ? 0 : 1);
