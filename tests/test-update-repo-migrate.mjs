// 老用户配置里的「占位仓库地址」必须被迁移掉（server.mjs 的 migrateUpdateRepo）。
//
// 为什么单独写一个文件：2026-11-21 真机踩出来的 bug。
// 开发期 DEFAULT_CONFIG.update.repo 一直是占位字符串 'lecture-notes/lecture-notes'
// （那时 GitHub 仓库还没建）。仓库建好之后默认值改成了真实地址，但
// deepMerge(DEFAULT_CONFIG, 文件内容) 只补**缺失**的键、不覆盖已有值 —— 于是
// 凡是这个字段写进过 config.json 的机器（也就是所有装过旧版本的机器），永远拿
// 占位值去查 api.github.com/repos/lecture-notes/lecture-notes/releases/latest
// → 404 → 自动更新对全体老用户静默失效，界面上连个错都不显示。
//
// 这个测试起一个真服务（临时数据目录），把 config.json 预置成占位值，看启动之后
// 文件里是不是被改成了真实地址。不能只测源码正则 —— 那只能证明「写了这行」，
// 证明不了「真的会跑、真的会落盘」。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
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

function boot(dataDir, port) {
  const proc = spawn(NODE, ['server.mjs', '--host', '127.0.0.1', '--data', dataDir, '--port', String(port)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const st = { proc, log: '', code: null };
  proc.stdout.on('data', (d) => (st.log += d.toString()));
  proc.stderr.on('data', (d) => (st.log += d.toString()));
  proc.on('exit', (c) => { st.code = c; });
  return st;
}

async function waitUp(port, ms = 20000) {
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
const readCfg = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));

section('占位仓库地址在启动时被迁移成真实地址');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ln-upr-'));
  const port = await freePort();

  // 预置一份「老用户」配置：update.repo 是占位值，另外塞两个不该被碰的字段，
  // 用来验证迁移只动那一个字段。
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify(
      {
        update: { enabled: true, repo: 'lecture-notes/lecture-notes', feedUrl: '', ignoredVersion: '0.8.0' },
        asr: { provider: 'local', language: 'zh' },
      },
      null,
      2
    ),
    'utf8'
  );

  const st = boot(dir, port);
  const up = await waitUp(port);
  check('服务起得来', up, up ? `127.0.0.1:${port}` : st.log.slice(-400));

  if (up) {
    // 迁移是 loadConfig 里同步跑的，服务能起来说明已经写完了；再等一拍保险
    await sleep(400);
    const cfg = readCfg(dir);
    check('update.repo 已从占位值改成真实地址', cfg.update.repo === 'KWY-457/lecture-notes', String(cfg.update.repo));
    check('启动日志里有一行迁移记录', /\[配置迁移\]\s*update\.repo: lecture-notes\/lecture-notes → /.test(st.log), '');
    check('同一段里的其他字段没被动', cfg.update.ignoredVersion === '0.8.0' && cfg.update.enabled === true, JSON.stringify(cfg.update));
    check('别的配置段没被动', cfg.asr?.provider === 'local' && cfg.asr?.language === 'zh', JSON.stringify(cfg.asr));

    // 顺手确认真能用：查到的是真实 release。这一段要联网，所以放宽：
    // 断网时只要求「没有再去查占位仓库」，不要求查到版本号。
    const r = await fetch(`http://127.0.0.1:${port}/api/update/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true }),
      signal: AbortSignal.timeout(9000),
    }).then((x) => x.json()).catch((e) => ({ error: String(e.message || e) }));
    const blob = JSON.stringify(r);
    check('更新检查没有再去查占位仓库', !/repos\/lecture-notes\/lecture-notes/.test(blob), blob.slice(0, 200));
  }
  kill(st.proc);
  await sleep(300);
  fs.rmSync(dir, { recursive: true, force: true });
}

section('用户自己填的仓库地址不会被迁移逻辑改掉');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ln-upr2-'));
  const port = await freePort();
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ update: { enabled: true, repo: 'someone/mirror', feedUrl: '' } }, null, 2),
    'utf8'
  );
  const st = boot(dir, port);
  const up = await waitUp(port);
  check('服务起得来', up, up ? `127.0.0.1:${port}` : st.log.slice(-400));
  if (up) {
    await sleep(400);
    check('自定义 repo 保持原样', readCfg(dir).update.repo === 'someone/mirror', String(readCfg(dir).update.repo));
    check('日志里没有迁移记录', !/update\.repo: /.test(st.log), '');
  }
  kill(st.proc);
  await sleep(300);
  fs.rmSync(dir, { recursive: true, force: true });
}

section('新装（没有 config.json）直接就是真实地址');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ln-upr3-'));
  const port = await freePort();
  const st = boot(dir, port);
  const up = await waitUp(port);
  check('服务起得来', up, up ? `127.0.0.1:${port}` : st.log.slice(-400));
  if (up) {
    await sleep(400);
    check('新装配置里是真实地址', readCfg(dir).update.repo === 'KWY-457/lecture-notes', String(readCfg(dir).update.repo));
  }
  kill(st.proc);
  await sleep(300);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 共 ${pass + fail} 项，通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
