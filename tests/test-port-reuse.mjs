// 端口撞车时的「先认人，再决定」逻辑（server.mjs 的 probeSelf / startServer）。
//
// 为什么值得单独测：这段代码只在「用户点了两次启动」或者「端口被别的软件占了」
// 的时候才跑，平时开发根本碰不到。写错的两头都很糟：
//   · 该复用却换了端口 → 浏览器 Cache Storage 按 origin(含端口) 隔离，1.6GB 的
//     本地转写模型缓存立刻变孤儿，用户以为「每次都要重新下模型」；
//   · 不该复用却复用了 → 用户以为自己启动成功了，实际连的是别人的服务。
//
// 三个场景：
//   1) 端口上坐着的是我自己（另一个实例）→ 不再启动，退出码 0，instance.json 一个字不改
//   2) 端口上坐着的是别的程序 → 换端口，并把新端口写进 instance.json
//   3) 端口上坐着的是我自己的「老版本」（版本号不同但同一个程序）→ 仍然认，退出
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ✅ ${name}${detail ? '   ' + detail : ''}`); }
  else { fail++; console.log(`  ❌ ${name}   ${detail}`); }
};
const section = (t) => console.log(`\n── ${t} ──`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => res(p));
    });
  });
}

/** 起一个 server.mjs，等它真的能连上（或提前退出）。返回 {proc, log, code} */
function boot(dataDir, extraArgs = []) {
  const proc = spawn(NODE, ['server.mjs', '--host', '127.0.0.1', '--data', dataDir, ...extraArgs], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const 状态 = { proc, log: '', code: null };
  proc.stdout.on('data', (d) => (状态.log += d.toString()));
  proc.stderr.on('data', (d) => (状态.log += d.toString()));
  proc.on('exit', (c) => { 状态.code = c; });
  return 状态;
}

async function waitUp(port, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return true;
    } catch {}
    await sleep(150);
  }
  return false;
}

const kill = (proc) => { try { process.kill(proc.pid, 'SIGKILL'); } catch {} };

/* ── 场景 1：端口上坐着我自己 → 不该再起第二个 ─────────────────────── */
section('场景 1：端口上已经是本程序 → 这次不再启动，退出码 0，instance.json 不动');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ln-port-'));
  const port = await freePort();
  // 先把 instance.json 写成「这台机器用 port」，模拟第二次启动会读到的状态
  const inst = { secret: 'abcdefghjk', port, createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, 'instance.json'), JSON.stringify(inst, null, 2), 'utf8');

  const a = boot(dir, ['--port', String(port)]);   // 第一个：显式钉死端口
  const up = await waitUp(port);
  check('第一个实例起来了', up, up ? `端口 ${port}` : a.log.slice(-300));

  const before = fs.readFileSync(path.join(dir, 'instance.json'), 'utf8');
  const b = boot(dir);                              // 第二个：不给 --port，走 instance.json
  let code = null;
  for (let i = 0; i < 100 && code === null; i++) { await sleep(150); code = b.code; }

  check('第二个实例自己退出了（没有抢端口）', code === 0, `退出码 ${code}`);
  check('提示说清楚了「已经在跑」与地址',
    /已经有本程序在|跑着了|已经在跑/.test(b.log) && b.log.includes(String(port)),
    b.log.trim().split('\n').filter(Boolean).slice(0, 3).join(' / ').slice(0, 160));
  check('没有出现「自动换成」那种换端口的话', !/自动换成/.test(b.log), '');
  const after = fs.readFileSync(path.join(dir, 'instance.json'), 'utf8');
  check('instance.json 一个字没改', before === after, before === after ? '' : `${before.trim()} → ${after.trim()}`);

  kill(a.proc);
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ── 场景 2：端口上是别的程序 → 必须换，并记住新端口 ───────────────── */
section('场景 2：端口上是别的程序 → 换一个新端口，并写进 instance.json');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ln-port-'));
  const port = await freePort();
  // 冒充「别的软件」：一个只会回 {"hello":1} 的 HTTP 服务
  const other = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"hello":1}');
  });
  await new Promise((r) => other.listen(port, '127.0.0.1', r));

  const inst = { secret: 'abcdefghjk', port, createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, 'instance.json'), JSON.stringify(inst, null, 2), 'utf8');

  const s = boot(dir);
  // 它会挑一个 20000-39999 的随机端口，得从 instance.json 里读出来等
  let newPort = 0;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, 'instance.json'), 'utf8'));
      if (j.port && j.port !== port) { newPort = j.port; break; }
    } catch {}
    await sleep(150);
  }
  const up = newPort ? await waitUp(newPort) : false;

  check('换了端口（不再用被占的那个）', newPort > 0 && newPort !== port, `旧 ${port} → 新 ${newPort}`);
  check('新端口真的起来了', up, up ? '' : s.log.slice(-300));
  check('日志说了是被别的软件占了', /被别的软件占用了/.test(s.log), '');
  check('冒充的那个服务还活着（没被误杀）', other.listening === true, '');

  kill(s.proc);
  await new Promise((r) => other.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ── 场景 3：认人的判据要严，别把「像」当成「是」 ──────────────────── */
section('场景 3：只认 ok + version + 端口三者齐全，缺一个都不算自己');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ln-port-'));
  const port = await freePort();
  // 一个「长得有点像」的服务：有 ok，但没有 version；端口也不回
  const impostor = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true,"app":"LectureNotes"}');
  });
  await new Promise((r) => impostor.listen(port, '127.0.0.1', r));

  const inst = { secret: 'abcdefghjk', port, createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, 'instance.json'), JSON.stringify(inst, null, 2), 'utf8');

  const s = boot(dir);
  let newPort = 0;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, 'instance.json'), 'utf8'));
      if (j.port && j.port !== port) { newPort = j.port; break; }
    } catch {}
    await sleep(150);
  }
  check('只有 ok 没有 version 的服务不会被当成自己', newPort > 0 && newPort !== port, `新端口 ${newPort}`);

  kill(s.proc);
  await new Promise((r) => impostor.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ── 场景 4：端口上坐着本程序，但数据目录不是这个 → 也不算自己 ─────── */
section('场景 4：端口上是「另一份安装」的本程序（数据目录不同）→ 换端口，不复用');
{
  // A 用 dirA，B 用 dirB。A 先占住某个端口，B 的 instance.json 也指向那个端口。
  // B 启动时如果只看版本号就复用，用户会以为自己在用 dirB 的录音 —— 其实看到的是 dirA 的。
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'ln-portA-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'ln-portB-'));
  const port = await freePort();
  fs.writeFileSync(path.join(dirB, 'instance.json'),
    JSON.stringify({ secret: 'abcdefghjk', port, createdAt: new Date().toISOString() }, null, 2), 'utf8');

  const a = boot(dirA, ['--port', String(port)]);
  check('A（另一份安装）起来了', await waitUp(port), `端口 ${port}`);

  const b = boot(dirB);
  let newPort = 0;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dirB, 'instance.json'), 'utf8'));
      if (j.port && j.port !== port) { newPort = j.port; break; }
    } catch {}
    await sleep(150);
  }
  check('数据目录不同就不复用，另起一个端口', newPort > 0 && newPort !== port, `新端口 ${newPort}`);
  const upB = newPort ? await waitUp(newPort) : false;
  check('B 自己也起来了', upB, upB ? '' : b.log.slice(-300));

  kill(a.proc); kill(b.proc);
  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
}

/* ── 场景 5：instance.json 的端口和真正在跑的端口不是一个 → 也要认出来 ── */
section('场景 5：instance.json 写的是旧端口（漂移遗留）→ 靠 runtime.json 认出已在跑');
{
  // 这正是本机真实发生过的事：instance.json 被改成 23455，而真正在跑的进程
  // 占着 23169。光靠 EADDRINUSE 发现不了（23455 空着），就会起第二个实例。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ln-port-'));
  const realPort = await freePort();
  const stalePort = await freePort();

  const a = boot(dir, ['--port', String(realPort)]);
  check('第一个实例起来了', await waitUp(realPort), `端口 ${realPort}`);
  // A 已经把自己写进 runtime.json；现在故意把 instance.json 改成「另一个端口」
  // 模拟历史上被自动避让改坏的状态。
  fs.writeFileSync(path.join(dir, 'instance.json'),
    JSON.stringify({ secret: 'abcdefghjk', port: stalePort, createdAt: new Date().toISOString() }, null, 2), 'utf8');

  const b = boot(dir);
  let code = null;
  for (let i = 0; i < 100 && code === null; i++) { await sleep(150); code = b.code; }

  check('第二个实例让路了（没去占那个空端口）', code === 0, `退出码 ${code}`);
  check('它报出的是真在跑的那个端口', b.log.includes(String(realPort)), (b.log.match(/在 \d+ 端口/) || [''])[0]);
  const stillStale = JSON.parse(fs.readFileSync(path.join(dir, 'instance.json'), 'utf8')).port;
  check('instance.json 没被这次启动改掉', stillStale === stalePort, `还是 ${stillStale}`);
  const occupied = await new Promise((res) => {
    const s = net.createServer();
    s.once('error', () => res(true));
    s.listen(stalePort, '127.0.0.1', () => s.close(() => res(false)));
  });
  check('那个空端口没被占（确实没起第二个）', occupied === false, '');

  kill(a.proc);
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ── 场景 6：runtime.json 不在，只有 instance.json → 也要认出来 ────── */
section('场景 6：runtime.json 丢了、只剩 instance.json → 靠端口探活认出已在跑');
{
  // 本机真实发生过：第二个实例退出时把 runtime.json 删了（exit 钩子没验 pid），
  // 于是下一次启动没有第一条线索。这条测第二条线索单独也够用。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ln-port-'));
  const port = await freePort();
  fs.writeFileSync(path.join(dir, 'instance.json'),
    JSON.stringify({ secret: 'abcdefghjk', port, createdAt: new Date().toISOString() }, null, 2), 'utf8');

  const a = boot(dir, ['--port', String(port)]);
  check('第一个实例起来了', await waitUp(port), `端口 ${port}`);
  fs.rmSync(path.join(dir, 'runtime.json'), { force: true });

  const b = boot(dir);
  let code = null;
  for (let i = 0; i < 100 && code === null; i++) { await sleep(150); code = b.code; }
  check('没有 runtime.json 也能认出已在跑', code === 0, `退出码 ${code}`);
  check('报出的端口是对的', b.log.includes(String(port)), (b.log.match(/在 \d+ 端口/) || [''])[0]);

  kill(a.proc);
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ── 场景 7：第二个实例退出，不能删掉第一个实例的 runtime.json ─────── */
section('场景 7：后来者退出时不许删先来者的 runtime.json');
{
  // 这是让场景 6 变成现实的那个 bug：exit 钩子原来无条件 rmSync。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ln-port-'));
  const port = await freePort();
  fs.writeFileSync(path.join(dir, 'instance.json'),
    JSON.stringify({ secret: 'abcdefghjk', port, createdAt: new Date().toISOString() }, null, 2), 'utf8');

  const a = boot(dir, ['--port', String(port)]);
  check('第一个实例起来了', await waitUp(port), `端口 ${port}`);
  const rtPath = path.join(dir, 'runtime.json');
  const pidA = JSON.parse(fs.readFileSync(rtPath, 'utf8')).pid;

  // 起第二个（用另一个端口，走 --port 所以不会让路），等它起来再退出
  const port2 = await freePort();
  const b = boot(dir, ['--port', String(port2)]);
  check('第二个实例起来了', await waitUp(port2), `端口 ${port2}`);
  // 第二个启动时会把 runtime.json 覆盖成自己吗？不该 —— 先来的还活着。
  const pidAfterB = JSON.parse(fs.readFileSync(rtPath, 'utf8')).pid;
  check('runtime.json 仍然指向先来的那个', pidAfterB === pidA, `${pidAfterB} vs ${pidA}`);

  kill(b.proc);
  for (let i = 0; i < 60 && b.code === null; i++) await sleep(100);
  const exists = fs.existsSync(rtPath);
  check('第二个退出后 runtime.json 还在（是第一个的）', exists && JSON.parse(fs.readFileSync(rtPath, 'utf8')).pid === pidA, exists ? '' : '被删了');

  kill(a.proc);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 端口撞车：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
