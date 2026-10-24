#!/usr/bin/env node
/**
 * 存储位置（录音目录 / 模型缓存目录）自测。
 *
 * 为什么要有这个测试
 * ------------------
 * 这两个接口的破坏力在整份代码里排前列：它们决定用户的数据往哪个盘写，
 * `/storage/move` 还会真的复制几 GB 文件。写错一个判断的后果不是「界面不对」，
 * 而是**用户的录音没了**（这类数据没法重录，也没法从服务商那儿再拉一遍）。
 * 而它的正常路径又太安静了 —— 复制成功、配置写对了，现场一切看起来都正常，
 * 只有边界写错的时候才炸，炸的还偏偏是用户数据。所以每条边界都要有用例盯着。
 *
 * 验什么
 * ------
 *   1) 拒绝：坏盘符 / 相对路径 / 参数缺失 → 400，且**配置文件一个字节都不动**
 *   2) 检查：空串回默认、合法路径能过、能算出目标位置已有多少内容
 *   3) 迁移：真的复制过去、源目录**不被删**、配置写进去了、/system 跟着变
 *   4) 复位：改回默认位置能把配置清空、custom 变回 false
 *   5) 权限：非本机（用局域网 IP 连）一律 403
 *
 * 不验什么
 * --------
 * 不碰 models（3.5 GB，跑一次太慢）。models 和 lectures 走的是同一段代码，
 * 分支只有 `which === 'models'` 那几处三元，用 lectures 验逻辑就够。
 *
 * 用法
 * ----
 *   node tests/test-storage.mjs [baseUrl]
 * 需要服务在跑，且**服务使用的数据目录里得有至少一条录音**（迁移才有东西可搬）。
 * 跑完会把配置和文件系统恢复原状：目标目录整个删掉，配置改回跑之前的值。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const BASE = (process.argv[2] || process.env.LN_BASE || 'http://127.0.0.1:25994').replace(/\/+$/, '');
let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  → ' + detail}`);
};

const health = await fetch(BASE + '/api/health').then((r) => r.json()).catch(() => null);
if (!health?.ok) {
  console.error(`拿不到 ${BASE}/api/health，服务没在跑？`);
  process.exit(1);
}
const CONFIG_FILE = path.join(health.dataDir, 'config.json');
const originalConfig = fs.readFileSync(CONFIG_FILE, 'utf8');

/**
 * 打接口。secret 走 query —— 和界面上的 api() 用同一套（见 public/app.js 的 api 函数），
 * 这里不做特殊处理，免得「测试能过、真实请求过不去」。
 */
const api = async (p, body, base = BASE) => {
  const opt =
    body === undefined
      ? {}
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const r = await fetch(`${base}/api${p}`, opt);
  let data = null;
  try {
    data = await r.json();
  } catch {}
  return { status: r.status, data };
};

/** 指定 HTTP 方法打接口（测「只认 POST」这类用） */
const apiWith = async (p, body, method, base = BASE) => {
  const opt = { method };
  // GET/HEAD 不能带 body，Node 的 fetch 会直接抛
  // TypeError: Request with GET/HEAD method cannot have body.
  if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
    opt.headers = { 'Content-Type': 'application/json' };
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(`${base}/api${p}`, opt);
  let data = null;
  try {
    data = await r.json();
  } catch {}
  return { status: r.status, data };
};

/** 递归数文件个数 + 总字节，用来判断「复制完整」和「源目录还在」 */
const treeStat = async (root) => {
  let files = 0;
  let bytes = 0;
  const walk = async (d) => {
    let ents;
    try {
      ents = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        files++;
        bytes += (await fsp.stat(p).catch(() => ({ size: 0 }))).size;
      }
    }
  };
  await walk(root);
  return { files, bytes };
};

const cfgNow = () => JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const storageOf = (c) => ({ lecturesDir: c.storage?.lecturesDir || '', modelsDir: c.storage?.modelsDir || '' });

const sysBefore = await api('/system');
const storageBefore = storageOf(originalConfig ? JSON.parse(originalConfig) : {});
const lecDirNow = sysBefore.data.storage.lectures.dir;

// 临时目标目录：放系统临时区，跑完删。
// 用 pid 和随机串隔开，两次测试并行也不会互相踩。
const TMP = path.join(os.tmpdir(), `ln-storage-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
await fsp.rm(TMP, { recursive: true, force: true });

console.log(`\n服务：${BASE}`);
console.log(`数据目录：${health.dataDir}`);
console.log(`当前录音目录：${lecDirNow}`);
console.log(`临时目标：${TMP}`);

/* ============ 1. 拒绝路径：验不过就绝不能动配置 ============ */
console.log('\n=== 1. 拒绝不合法的路径（配置文件必须原封不动） ===');
{
  const before = fs.readFileSync(CONFIG_FILE, 'utf8');

  // 不存在的盘符。用 Z: 是因为 Windows 上通常没有；真有了也只是「能过检查」，
  // 下面的断言会失败并提示原因，不会误判成 bug。
  const badDrive = await api('/storage/check', { which: 'lectures', dir: 'Z:' + path.sep + 'ln-no-such-dir' });
  check('坏盘符被拒（400）', badDrive.status === 400, `HTTP ${badDrive.status}`);
  check('坏盘符的报错说人话', /用不了|不存在/.test(badDrive.data?.error || ''), badDrive.data?.error);

  const rel = await api('/storage/check', { which: 'lectures', dir: 'relative/path/dir' });
  check('相对路径被拒（400）', rel.status === 400, `HTTP ${rel.status}`);
  check('相对路径的报错提示要完整路径', /完整路径/.test(rel.data?.error || ''), rel.data?.error);

  const moveBad = await api('/storage/move', { which: 'lectures', dir: 'Z:' + path.sep + 'ln-no-such-dir' });
  check('move 到坏路径被拒（400）', moveBad.status === 400, `HTTP ${moveBad.status}`);

  check('三次被拒之后配置文件一字节没变', fs.readFileSync(CONFIG_FILE, 'utf8') === before);
}

/* ============ 2. check：空串 / 合法路径 / 目标已有内容 ============ */
console.log('\n=== 2. /storage/check ===');
{
  const empty = await api('/storage/check', { which: 'lectures', dir: '' });
  // /storage/check 只回 currentDir，不回 defaultDir（defaultDir 在 /system 里）。
  // 空串的含义是「用默认位置」，所以 dir 应该和 /system 报的 defaultDir 一致。
  const defaultLec = sysBefore.data.storage.lectures.defaultDir;
  check('空串 → 200 且指向默认位置', empty.status === 200 && empty.data.dir === defaultLec, JSON.stringify(empty.data));
  check('空串 → custom 为 false', empty.data.custom === false);

  // 先往目标目录里放一个已知大小的文件，验「能算出目标已有多少内容」
  await fsp.mkdir(TMP, { recursive: true });
  await fsp.writeFile(path.join(TMP, 'marker.bin'), Buffer.alloc(1024));

  const ok = await api('/storage/check', { which: 'lectures', dir: TMP });
  check('合法路径 → 200', ok.status === 200, `HTTP ${ok.status} ${JSON.stringify(ok.data)}`);
  check('合法路径 → custom 为 true', ok.data.custom === true);
  check('报出了目标位置已有的大小', typeof ok.data.sizeGB === 'number', String(ok.data.sizeGB));
  check('currentDir 是迁移前的源目录', ok.data.currentDir === lecDirNow, ok.data.currentDir);
}

/* ============ 3. 迁移：复制完整、源目录不删、配置生效 ============ */
console.log('\n=== 3. /storage/move（真搬一次） ===');
{
  const before = await treeStat(lecDirNow);
  check('源目录里有东西可搬（否则这条测试没意义）', before.files > 0, `${before.files} 个文件`);

  const r = await api('/storage/move', { which: 'lectures', dir: TMP });
  check('迁移返回 200', r.status === 200, `HTTP ${r.status} ${JSON.stringify(r.data)}`);

  const after = await treeStat(TMP);
  const srcAfter = await treeStat(lecDirNow);

  // 目标目录里有先前放的 marker.bin，所以文件数要 +1、字节 +1024。
  // 用「不少于」而不是「等于」，是为了让这条断言不会因为源目录里
  // 多了个隐藏文件（比如 .DS_Store）就假红。
  check('文件真的复制过去了', after.files >= before.files, `${before.files} → ${after.files}`);
  check('字节数对得上（源数量级）', after.bytes >= before.bytes, `${before.bytes} → ${after.bytes}`);
  check('⚠ 源目录没被删（这条最不可协商）', srcAfter.files === before.files, `${before.files} → ${srcAfter.files}`);
  check('响应里的 oldKept 说明旧目录还留着', r.data.oldKept === true, String(r.data.oldKept));
  check('响应里的 fromDir 是原位置', r.data.fromDir === lecDirNow, r.data.fromDir);

  const c = cfgNow();
  check('配置里写进了新路径', c.storage?.lecturesDir === TMP, JSON.stringify(c.storage));

  const sys = await api('/system');
  check('/system 的 dir 跟着变了', sys.data.storage.lectures.dir === TMP, sys.data.storage.lectures.dir);
  check('/system 的 custom 是 true', sys.data.storage.lectures.custom === true);
  check('/system 的 sizeGB 大于 0', sys.data.storage.lectures.sizeGB > 0, String(sys.data.storage.lectures.sizeGB));
}

/* ============ 4. 改回默认 ============ */
console.log('\n=== 4. 改回默认位置 ===');
{
  // 空串 = 默认。这条路走的也是 /storage/move，
  // 它内部会先算 target（默认位置）、发现和当前不同，于是复制一遍 ——
  // 但文件本来就在默认位置，全都「同名同大小」跳过，等于什么都没做。
  const r = await api('/storage/move', { which: 'lectures', dir: '' });
  check('改回默认返回 200', r.status === 200, `HTTP ${r.status} ${JSON.stringify(r.data)}`);

  const c = cfgNow();
  check('配置里的路径被清空', (c.storage?.lecturesDir || '') === '', JSON.stringify(c.storage));

  const sys = await api('/system');
  check('custom 变回 false', sys.data.storage.lectures.custom === false);
  check('dir 回到默认位置', sys.data.storage.lectures.dir === sys.data.storage.lectures.defaultDir, sys.data.storage.lectures.dir);
}

/* ============ 4.5 配置里写着一个用不了的路径（拔盘场景） ============ */
console.log('\n=== 4.5 盘拔掉了：服务不能因此起不来 ===');
{
  // 这是这个功能最现实的坏结局：用户把录音迁到移动硬盘，然后拔了盘再开机。
  // 要求：服务照常起来、退回默认位置能继续存录音、但必须把这件事报出来 ——
  // 悄悄退回默认是最坏的做法，用户会以为录音还在移动硬盘上。
  // 关键是**整块盘都不见了**，不能只写一个当前盘上的目录 ——
  // resolveStorageDir 会 mkdir(recursive)，在存在的盘上永远建得出来，测不到这个分支。
  // 所以先找一个真的不存在的盘符。
  const missingDrive = ['Z', 'Y', 'X', 'W', 'V', 'U'].map((d) => `${d}:\\`).find((root) => !fs.existsSync(root));
  check('找到了一个不存在的盘符（否则这条测试没意义）', !!missingDrive, '这台机器 Z: ~ U: 全都存在');
  const broken = JSON.parse(originalConfig);
  broken.storage = { ...(broken.storage || {}), lecturesDir: path.join(missingDrive || 'Z:\\', 'ln-unplugged') };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(broken, null, 2), 'utf8');
  const reload = await api('/config/reload', {});
  check('配置里有坏路径时重载也不报错', reload.status === 200, `HTTP ${reload.status} ${JSON.stringify(reload.data)}`);

  const sys = await api('/system');
  const lec = sys.data.storage.lectures;
  check('退回默认位置继续能用', lec.dir === lec.defaultDir, lec.dir);
  check('custom 是 false（实际没在用自定义位置）', lec.custom === false);
  check('error 字段把事情说清了', !!lec.error, 'error 是空的 —— 用户不会知道录音其实没存在他填的地方');
  // 坏路径**不从配置里抹掉**：盘插回来重启就该自动恢复，不该让用户重填一遍。
  const after = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  check('坏路径仍留在配置里（等盘插回来）', after.storage.lecturesDir.includes('ln-unplugged'), JSON.stringify(after.storage));
}

/* ============ 5. 非本机访问一律 403 ============ */
console.log('\n=== 5. 局域网 / 手机不能改（403） ===');
{
  const lanIp = (health.urls || []).map((u) => new URL(u).hostname).find((h) => h !== '127.0.0.1' && h !== 'localhost');
  if (!lanIp) {
    console.log('  ⏭  服务没开 --host 0.0.0.0，拿不到局域网 IP，这 3 项跳过');
  } else {
    const lanBase = `http://${lanIp}:${new URL(BASE).port}`;
    // 局域网要带 secret，和手机浏览器一样走路径前缀
    const secret = health.urls.find((u) => u.includes(lanIp))?.split('/').filter(Boolean).pop() || '';
    const lanApi = (p, body) =>
      api(`${p}`, body, secret ? `${lanBase}/${secret}` : lanBase).catch((e) => ({ status: 0, data: { error: String(e) } }));

    const r1 = await lanApi('/storage/check', { which: 'lectures', dir: TMP });
    check('局域网调 /storage/check 被拒（403）', r1.status === 403, `HTTP ${r1.status} ${JSON.stringify(r1.data)}`);

    const r2 = await lanApi('/storage/move', { which: 'lectures', dir: TMP });
    check('局域网调 /storage/move 被拒（403）', r2.status === 403, `HTTP ${r2.status} ${JSON.stringify(r2.data)}`);

    const r3 = await lanApi('/system');
    check('局域网能看 /system，且 local 为 false', r3.status === 200 && r3.data?.local === false, `local=${r3.data?.local}`);

    // /storage/open 会让**服务所在的那台机器**弹一个资源管理器窗口。
    // 手机上点一下就在别人电脑上弹窗，是最不能接受的行为，必须 403。
    const r4 = await lanApi('/storage/open', { which: 'lectures' });
    check('局域网调 /storage/open 被拒（403）', r4.status === 403, `HTTP ${r4.status} ${JSON.stringify(r4.data)}`);
  }
}

/* ============ 4.6 /storage/open：只认 which，不认用户传的路径 ============ */
console.log('\n=== 4.6 打开文件夹接口 ===');
{
  const sys = await api('/system');
  const wantLect = sys.data.storage.lectures.dir;
  const o1 = await api('/storage/open', { which: 'lectures' });
  check('/storage/open 返回了录音目录', o1.status === 200 && o1.data?.dir === wantLect, `dir=${o1.data?.dir}`);

  // 关键安全断言：不管 which 传什么乱七八糟的值，都只会开到那两个目录之一，
  // 绝不能变成「随便传个路径就打开」—— 这个接口能让本机弹窗口。
  const o2 = await api('/storage/open', { which: '../../windows' });
  check(
    '/storage/open 不认乱传的 which（回落到录音目录）',
    o2.status === 200 && o2.data?.dir === wantLect,
    `dir=${o2.data?.dir}`,
  );
  const o3 = await api('/storage/open', { which: 'models', dir: 'C:\\Windows' });
  check(
    '/storage/open 忽略请求体里的 dir',
    o3.status === 200 && o3.data?.dir !== 'C:\\Windows',
    `dir=${o3.data?.dir}`,
  );
  const o4 = await apiWith('/storage/open', { which: 'lectures' }, 'GET');
  check('/storage/open 只认 POST', o4.status === 405, `HTTP ${o4.status}`);
}

/* ============ 收尾：恢复现场 ============ */
console.log('\n=== 收尾 ===');
{
  // 配置恢复成跑测试之前的样子（不是「改成空」，而是真的原样还回去 ——
  // 用户可能本来就有自定义路径，测试不该把它抹掉）
  fs.writeFileSync(CONFIG_FILE, originalConfig, 'utf8');
  // 让服务重新读一遍配置，否则内存里还指着临时目录
  const reload = await api('/config/reload', {});
  check('配置已还原并让服务重读', reload.status === 200, `HTTP ${reload.status} ${JSON.stringify(reload.data)}`);

  await fsp.rm(TMP, { recursive: true, force: true });
  check('临时目标目录已删除', !fs.existsSync(TMP), TMP);

  const sys = await api('/system');
  check(
    '服务回到测试前的存储位置',
    sys.data.storage.lectures.dir === sysBefore.data.storage.lectures.dir,
    `${sys.data.storage.lectures.dir} ≠ ${sysBefore.data.storage.lectures.dir}`,
  );
  check('配置内容与测试前逐字节一致', fs.readFileSync(CONFIG_FILE, 'utf8') === originalConfig);
}

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
