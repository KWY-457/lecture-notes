#!/usr/bin/env node
/**
 * 自动更新的单元测试（纯离线，不联网、不碰文件）。
 *
 * 测的是 update.mjs 里的纯函数 + 两个接口的防呆行为。
 * 这些函数一旦算错，后果是「明明有新版本却不提示」或者更糟
 * 「提示了、点下载、把用户 25MB 流量白烧掉」。所以每条都要能说出
 * 为什么这么断，而不是只求通过。
 *
 *   node tests/test-update.mjs                      只跑离线部分
 *   node tests/test-update.mjs http://127.0.0.1:25994  额外验接口鉴权
 */
import assert from 'node:assert/strict';
import {
  parseVersion, compareVersion, versionFromFileName,
  pickInstaller, normalizeRelease, parseFeed, feedUrls, mirrorUrls,
  shouldCheck, shouldOffer, formatBytes,
} from '../update.mjs';

const BASE = process.argv[2] || '';
let pass = 0;
let fail = 0;

function ok(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    console.log('  ✗ ' + name + '\n      ' + String(e.message).split('\n')[0]);
  }
}

async function okAsync(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    console.log('  ✗ ' + name + '\n      ' + String(e.message).split('\n')[0]);
  }
}

console.log('\n=== 版本号比较 ===');

ok('0.10.0 比 0.9.0 新（字符串比较会判反）', () => {
  assert.equal(compareVersion('0.10.0', '0.9.0'), 1);
});
ok('v 前缀不影响', () => {
  assert.equal(compareVersion('v1.2.3', '1.2.3'), 0);
  assert.equal(compareVersion('1.2.3', 'v1.2.4'), -1);
});
ok('位数不同按缺位补 0（1.0 == 1.0.0）', () => {
  assert.equal(compareVersion('1.0', '1.0.0'), 0);
  assert.equal(compareVersion('1.0.1', '1.0'), 1);
});
ok('正式版比同号预发布新', () => {
  assert.equal(compareVersion('1.0.0', '1.0.0-beta.1'), 1);
  assert.equal(compareVersion('1.0.0-beta.1', '1.0.0'), -1);
});
ok('解析不出来一律当「一样」，绝不谎报有更新', () => {
  assert.equal(compareVersion('', '1.0.0'), 0);
  assert.equal(compareVersion('1.0.0', 'latest'), 0);
  assert.equal(compareVersion(null, undefined), 0);
  assert.equal(parseVersion('abc'), null);
});
ok('parseVersion 拆出数字段', () => {
  assert.deepEqual(parseVersion('v0.10.2')?.nums, [0, 10, 2]);
  assert.equal(parseVersion('0.10.2-beta.1')?.pre, 'beta.1');
  assert.equal(parseVersion('0.10.2')?.pre, '');
});

console.log('\n=== 从文件名认版本 ===');
ok('LectureNotes-0.9.0-setup.exe → 0.9.0', () => {
  assert.equal(versionFromFileName('LectureNotes-0.9.0-setup.exe'), '0.9.0');
});
ok('带 v 前缀、下划线、四位版本都认', () => {
  assert.equal(versionFromFileName('LectureNotes-v1.0.2-setup.exe'), '1.0.2');
  assert.equal(versionFromFileName('lecture_notes_1.2.3.exe'), '1.2.3');
  assert.equal(versionFromFileName('LN-0.9.0.1-setup.exe'), '0.9.0.1');
});
ok('认不出来返回空串（不返回 undefined 让调用方崩）', () => {
  assert.equal(versionFromFileName('setup.exe'), '');
  assert.equal(versionFromFileName(''), '');
});

console.log('\n=== 挑安装包 ===');
ok('多个附件时挑 setup.exe，不挑 .zip / .txt', () => {
  const got = pickInstaller([
    { name: 'LectureNotes-1.0.0.zip', url: 'https://x/a.zip', size: 99999999 },
    { name: 'LectureNotes-1.0.0-setup.exe', url: 'https://x/a.exe', size: 25000000 },
    { name: 'checksums.txt', url: 'https://x/c.txt', size: 100 },
  ]);
  assert.equal(got.name, 'LectureNotes-1.0.0-setup.exe');
});
ok('都像安装包时挑最大的（真正的安装包一定比调试符号大）', () => {
  const got = pickInstaller([
    { name: 'a-setup.exe', url: 'https://x/a.exe', size: 100 },
    { name: 'b-setup.exe', url: 'https://x/b.exe', size: 900 },
  ]);
  assert.equal(got.name, 'b-setup.exe');
});
ok('没有名字像安装包的，就挑最大的那个附件', () => {
  const got = pickInstaller([
    { name: 'build.tmp', url: 'https://x/1', size: 10 },
    { name: 'build.bin', url: 'https://x/2', size: 20 },
  ]);
  assert.equal(got.name, 'build.bin');
});
ok('过滤掉非 http(s) 的地址（javascript: / file: 不许进下载器）', () => {
  const got = pickInstaller([
    { name: 'evil-setup.exe', url: 'javascript:alert(1)', size: 999 },
    { name: 'ok-setup.exe', url: 'https://x/ok.exe', size: 1 },
  ]);
  assert.equal(got.name, 'ok-setup.exe');
});
ok('一个都没有返回 null（调用方要能优雅地不提示）', () => {
  assert.equal(pickInstaller([]), null);
  assert.equal(pickInstaller(null), null);
  assert.equal(pickInstaller([{ name: 'x.exe' }]), null);
});

console.log('\n=== 解析 GitHub Releases ===');
const GH = {
  tag_name: 'v1.2.0',
  body: '## 修了什么\n- 转写不再卡住',
  published_at: '2026-11-12T07:00:00Z',
  html_url: 'https://github.com/o/r/releases/tag/v1.2.0',
  assets: [
    { name: 'LectureNotes-1.2.0-setup.exe', browser_download_url: 'https://github.com/o/r/releases/download/v1.2.0/x.exe', size: 25000000 },
    { name: 'source.zip', browser_download_url: 'https://github.com/o/r/archive/v1.2.0.zip', size: 1000 },
  ],
};
ok('版本从 tag_name 里认出来', () => {
  assert.equal(normalizeRelease(GH).version, '1.2.0');
});
ok('安装包与说明都留下来', () => {
  const r = normalizeRelease(GH);
  assert.equal(r.installer.name, 'LectureNotes-1.2.0-setup.exe');
  assert.equal(r.installer.size, 25000000);
  assert.match(r.notes, /转写不再卡住/);
  assert.equal(r.publishedAt, '2026-11-12T07:00:00Z');
});
ok('body 超长要截断（有些 Release 写几千行日志，塞进 DOM 会卡）', () => {
  const r = normalizeRelease({ ...GH, body: 'x'.repeat(9000) });
  assert.equal(r.notes.length, 4000);
});
ok('没有附件的 Release 返回 null（宁可不提示，也不给个点不动的按钮）', () => {
  assert.equal(normalizeRelease({ ...GH, assets: [] }), null);
  assert.equal(normalizeRelease(null), null);
  assert.equal(normalizeRelease({ body: 'x' }), null);
});

console.log('\n=== 解析自家 latest.json ===');
ok('简写形式 {version,url,size}', () => {
  const r = parseFeed({ version: '0.10.0', url: 'https://cdn.example.com/LN-setup.exe', size: 26000000, notes: 'hello' });
  assert.equal(r.version, '0.10.0');
  assert.equal(r.installer.size, 26000000);
  assert.equal(r.notes, 'hello');
});
ok('files 列表形式', () => {
  const r = parseFeed({ version: '0.10.0', files: [
    { name: 'a.zip', url: 'https://c/a.zip', size: 10 },
    { name: 'LectureNotes-0.10.0-setup.exe', url: 'https://c/b.exe', size: 20 },
  ] });
  assert.equal(r.installer.name, 'LectureNotes-0.10.0-setup.exe');
});
ok('没有 version 字段时用文件名里的版本兜底', () => {
  const r = parseFeed({ url: 'https://c/LectureNotes-0.11.0-setup.exe', size: 1 });
  assert.equal(r.version, '0.11.0');
});

console.log('\n=== 更新源与镜像 ===');
ok('默认走 api.github.com，第二源是 gh-proxy', () => {
  const urls = feedUrls({ repo: 'o/r' });
  assert.equal(urls[0], 'https://api.github.com/repos/o/r/releases/latest');
  assert.match(urls[1], /^https:\/\/gh-proxy\.com\/https:\/\/api\.github\.com\/repos\/o\/r\//);
});
ok('repo 带首尾斜杠也认', () => {
  assert.equal(feedUrls({ repo: '/o/r/' })[0], 'https://api.github.com/repos/o/r/releases/latest');
});
ok('自定义 feedUrl 优先，且只试它一个（不再打 GitHub）', () => {
  const urls = feedUrls({ repo: 'o/r', feedUrl: 'https://mysite/latest.json' });
  assert.deepEqual(urls, ['https://mysite/latest.json']);
});
ok('既没 repo 也没 feedUrl → 空数组，不去撞一个必然 404 的地址', () => {
  assert.deepEqual(feedUrls({}), []);
});
ok('github 的下载地址补镜像，第三方地址不补', () => {
  const gh = mirrorUrls('https://github.com/o/r/releases/download/v1/x.exe');
  assert.equal(gh.length, 2);
  assert.equal(gh[1], 'https://gh-proxy.com/https://github.com/o/r/releases/download/v1/x.exe');
  assert.deepEqual(mirrorUrls('https://cdn.example.com/x.exe'), ['https://cdn.example.com/x.exe']);
  assert.deepEqual(mirrorUrls(''), []);
});

console.log('\n=== 该不该查 / 该不该提示 ===');
ok('从没查过 → 该查', () => {
  assert.equal(shouldCheck(''), true);
  assert.equal(shouldCheck(undefined), true);
  assert.equal(shouldCheck('不是时间'), true);
});
ok('6 小时内查过 → 不查；超过 6 小时 → 查', () => {
  const now = Date.parse('2026-11-12T12:00:00Z');
  assert.equal(shouldCheck('2026-11-12T08:00:00Z', now), false);
  assert.equal(shouldCheck('2026-11-12T05:59:00Z', now), true);
});
ok('远端不比当前新 → 不提示（回滚场景）', () => {
  assert.equal(shouldOffer('0.9.0', '0.9.0'), false);
  assert.equal(shouldOffer('0.8.0', '0.9.0'), false);
});
ok('远端更新 → 提示', () => {
  assert.equal(shouldOffer('1.0.0', '0.9.0'), true);
});
ok('跳过过的版本 → 不提示；再出新版照常提示', () => {
  assert.equal(shouldOffer('1.0.0', '0.9.0', '1.0.0'), false);
  assert.equal(shouldOffer('1.1.0', '0.9.0', '1.0.0'), true);
});
ok('没有远端版本号 → 不提示', () => {
  assert.equal(shouldOffer('', '0.9.0'), false);
});

console.log('\n=== 大小显示 ===');
ok('分段与小数位', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '2 KB');
  assert.equal(formatBytes(25797177), '24.6 MB');
  assert.equal(formatBytes(2 * 1024 ** 3), '2.00 GB');
});
ok('负数 / 非数字都当 0（不能显示 NaN B）', () => {
  assert.equal(formatBytes(-1), '0 B');
  assert.equal(formatBytes('abc'), '0 B');
  assert.equal(formatBytes(undefined), '0 B');
});

if (BASE) {
  console.log('\n=== 接口防呆（需要服务在跑）===');
  const j = async (p, opt) => {
    const r = await fetch(BASE + p, opt);
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  await okAsync('GET /api/update/check 返回结构完整', async () => {
    const r = await j('/api/update/check');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.ok('current' in r.body, '缺 current 字段');
  });
  await okAsync('GET /api/update/check?force=1 会真的去查（可能报 error，但结构仍在）', async () => {
    const r = await j('/api/update/check?force=1');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.ok('latest' in r.body || 'error' in r.body);
  });
  await okAsync('/api/update/download 不接受外部地址（checkOnly 只报清单里的地址，不真下）', async () => {
    const r = await j('/api/update/download', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // checkOnly：服务端只回「会下哪个文件」，不真拖 25MB 安装包。
      // 这条测试验的是「不认前端传来的外部地址」，不需要真下载。
      body: JSON.stringify({ url: 'https://example.com/evil.exe', checkOnly: true }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.checkOnly, true);
    // 关键：回包里的 url 必须是服务端现拉清单得到的那个，绝不是前端塞进来的 evil.exe
    assert.ok(r.body.url, '没回清单里的地址');
    assert.ok(!String(r.body.url).includes('example.com'), `回包竟然用了外部地址：${r.body.url}`);
    // 不能出现「下载成功/已安装」这种回话
    assert.ok(!('reused' in r.body), 'checkOnly 不该回报下载结果');
  });
  await okAsync('/api/update/ignore 需要 version', async () => {
    const before = await j('/api/update/check');
    const r = await j('/api/update/ignore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: '' }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.ignoredVersion, '');
    // 收尾：把忽略值清回去，别污染后面的测试
    await j('/api/update/ignore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: before.body.ignoredVersion || '' }),
    });
  });
}

console.log(`\n合计 ${pass + fail} 项：${pass} 通过 · ${fail} 失败`);
process.exit(fail ? 1 : 0);
