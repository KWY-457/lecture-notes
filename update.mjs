/**
 * 自动更新 —— 纯计算部分（不碰网络、不碰文件），服务端和测试共用一份。
 *
 * 为什么单独一个文件而不是塞进 server.mjs：
 *   版本比较、挑安装包、拼下载地址这几件事全是「给输入出输出」，
 *   只要有一个字节的环境差异就会算错（`v` 前缀、`0.10` 比 `0.9` 大、
 *   文件名里带空格、GitHub 的 asset 顺序不保证）。它们必须能被单独测，
 *   不能被「起一个服务 + 打一次真网络」这种慢测法绑住。
 *
 * ── 更新策略（看了 PCL 启动器之后定的，取舍见交接书 §3.45）──────────────
 *   抄的：
 *     1. 清单只有一个文件，里面写清「最新版本号 + 安装包地址 + 大小」；
 *     2. 多个下载源按顺序试，第一个超时就换下一个，不弹窗烦人；
 *     3. 先下到临时文件，完整了再改名字（半截文件永远不叫正式名）；
 *     4. 更新由「新装好的程序」自己收尾，不额外发一个 updater.exe。
 *   不抄的：
 *     1. 二进制差分补丁（PCL 5.98MB → 1/32；我们整包 25.8MB 里 89% 是
 *        runtime\node.exe，每次发版都不变，gzip 后才 335KB —— 差分省不了多少，
 *        却要多养一套补丁生成/校验/回滚，还得给每个旧版本留一份补丁）；
 *     2. 匿名数据上报（和 PRIVACY.txt「没有埋点、没有统计」直接冲突）；
 *     3. 后台静默强更（用户正在转写两小时的课，不能替他决定什么时候重启）。
 *
 * ── 一条硬约束 ─────────────────────────────────────────────────────
 *   `runtime\node.exe` 在服务跑着的时候**删不掉、也不能被直接覆盖**
 *   （Windows 文件锁；实测能改名腾位，但改名对安装包没用）。
 *   所以「先退出、再安装」不是体验选择，是物理约束：
 *   下载 → 把安装包交给一个独立的小脚本 → 服务自己退出 → 脚本等进程真死了
 *   → 才启动安装包。顺序错一步，安装程序就会卡在「无法写入 node.exe」。
 */

/** 一个版本号拆成数字段。`v0.10.2` / `0.10.2-beta.1` / `0.10.2` 都认。 */
export function parseVersion(input) {
  const raw = String(input == null ? '' : input).trim().replace(/^v/i, '');
  const m = /^(\d+(?:\.\d+)*)(?:[-+._]?(.*))?$/.exec(raw);
  if (!m) return null;
  return {
    nums: m[1].split('.').map((n) => Number(n) || 0),
    // 预发布标记：有它的一律比同号正式版旧（1.0.0-beta < 1.0.0）
    pre: (m[2] || '').trim(),
  };
}

/**
 * 比大小：a 比 b 新返回 1，一样返回 0，旧返回 -1。
 * 任一边解析不出来返回 0 —— 宁可「当作没更新」，也不能因为对方写了个
 * 奇怪的 tag 就判定「有新版」，然后让用户反复看到一个点不动的红点。
 */
export function compareVersion(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  const n = Math.max(x.nums.length, y.nums.length);
  for (let i = 0; i < n; i++) {
    const p = x.nums[i] || 0;
    const q = y.nums[i] || 0;
    if (p !== q) return p > q ? 1 : -1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1; // 正式版比预发布新
  if (!y.pre) return -1;
  return x.pre > y.pre ? 1 : -1;
}

/**
 * 从「安装包文件名」里认出版本号。
 * 我们的命名是 `LectureNotes-0.9.0-setup.exe`；认不出来返回 ''。
 * 为什么要从文件名认：自定义清单（feedUrl）可能只给一个下载地址，
 * 不写 version 字段 —— 那时候文件名是唯一的线索。
 */
export function versionFromFileName(name) {
  const m = /(\d+\.\d+(?:\.\d+)*)/.exec(String(name || ''));
  return m ? m[1] : '';
}

const INSTALLER_RE = /(setup|installer|install)\.exe$/i;

/**
 * 从一组资源里挑安装包。
 * 优先挑名字像安装包的；都像就挑最大的（我们的安装包一定比任何附件大）。
 * 挑不到返回 null —— 调用方要能优雅地说「这次发的版没有安装包，请手动下载」。
 */
export function pickInstaller(assets) {
  const list = (Array.isArray(assets) ? assets : []).filter(
    (a) => a && typeof a.url === 'string' && /^https?:\/\//i.test(a.url)
  );
  if (!list.length) return null;
  const named = list.filter((a) => INSTALLER_RE.test(String(a.name || '').split('?')[0]));
  const pool = named.length ? named : list;
  return pool.slice().sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0))[0];
}

/**
 * 把 GitHub Releases 的 `/releases/latest` 响应整理成我们自己的一份清单。
 *
 * 只留用得上的字段：界面上要显示的就是「新版本号、发布日期、这一版改了什么、
 * 安装包多大」，其余（uploader、reactions、几十个 URL 变量）一概不留。
 */
export function normalizeRelease(json, opts = {}) {
  if (!json || typeof json !== 'object') return null;
  const tag = json.tag_name || json.name || '';
  const version = String(json.version || versionFromFileName(tag) || '').trim();
  if (!version) return null;
  const assets = (Array.isArray(json.assets) ? json.assets : [])
    .map((a) => ({
      name: String(a.name || ''),
      url: String(a.browser_download_url || a.url || ''),
      size: Number(a.size) || 0,
      sha256: String(a.sha256 || a.digest || ''),
    }))
    .filter((a) => a.url);
  const installer = pickInstaller(assets);
  if (!installer) return null;
  return {
    version,
    notes: String(json.body || '').slice(0, 4000),
    publishedAt: String(json.published_at || json.pubDate || json.publishedAt || ''),
    pageUrl: String(json.html_url || json.pageUrl || (opts.repo ? `https://github.com/${opts.repo}/releases` : '')),
    assets,
    installer,
  };
}

/**
 * 同一个清单可能有好几种写法（GitHub 的 Releases 接口、我们自己放的 latest.json）。
 * 认三种：
 *   1. GitHub：`{ tag_name, assets:[{name,browser_download_url,size}] }`
 *   2. 简写：`{ version, url, size, sha256, notes }` —— 一个安装包，最省事
 *   3. 列表：`{ version, files:[...] }`
 */
export function parseFeed(json, opts = {}) {
  if (!json || typeof json !== 'object') return null;
  if (Array.isArray(json.assets) || json.tag_name) return normalizeRelease(json, opts);
  const files = Array.isArray(json.files) ? json.files : [];
  const assets = (files.length ? files : [json]).map((f) => ({
    name: String(f.name || versionFromFileName(f.url || '') || ''),
    url: String(f.url || f.browser_download_url || ''),
    size: Number(f.size) || 0,
    sha256: String(f.sha256 || f.digest || ''),
  })).filter((a) => a.url);
  // 没有 version 字段时从文件名兜底 —— 自己托管最新版时，人往往只改文件名，
  // 忘了改 JSON 里的版本号；认不出就老实返回 null，不去猜一个版本号出来。
  const version = String(json.version || '').trim()
    || versionFromFileName(assets.map((a) => a.name).join(' '));
  if (!version) return null;
  const installer = pickInstaller(assets);
  if (!installer) return null;
  return {
    version,
    notes: String(json.notes || json.body || '').slice(0, 4000),
    publishedAt: String(json.publishedAt || json.published_at || ''),
    pageUrl: String(json.pageUrl || ''),
    assets,
    installer,
  };
}

/**
 * 检查更新的地址清单，按顺序试。
 *
 * `feedUrl` 优先（自己放一份 latest.json 到任何静态托管都能用，不用开仓库）。
 * 否则走 GitHub Releases。
 *
 * 为什么带镜像：GitHub 的 api.github.com 在国内经常连不上，而
 * `gh-proxy.com` 这类前缀代理对 **下载** 是有效的。把它排在第二位而不是
 * 第一位，是因为镜像本身也可能挂 —— 直连能通时不该绕远路。
 * 注意：这里只镜像「清单」，安装包下载地址由清单里给，另行处理（见 mirrorUrls）。
 */
export function feedUrls({ repo = '', feedUrl = '' } = {}) {
  const out = [];
  const custom = String(feedUrl || '').trim();
  if (custom) {
    out.push(custom);
    return out;
  }
  const slug = String(repo || '').trim().replace(/^\/+|\/+$/g, '');
  if (!slug) return out;
  out.push(`https://api.github.com/repos/${slug}/releases/latest`);
  out.push(`https://gh-proxy.com/https://api.github.com/repos/${slug}/releases/latest`);
  return out;
}

/**
 * 一个下载地址的备选写法（直连 + 镜像）。
 *
 * 只对 github.com / githubusercontent 的地址加镜像 —— 把一个第三方站的
 * 地址塞进 gh-proxy 前缀只会 404，白等 15 秒超时。
 */
export function mirrorUrls(url) {
  const s = String(url || '').trim();
  if (!s) return [];
  if (!/^https:\/\/(github\.com|objects\.githubusercontent\.com|raw\.githubusercontent\.com)\//i.test(s)) return [s];
  return [s, `https://gh-proxy.com/${s}`];
}

/** 该不该自动检查了。lastCheckAt 为空（从没查过）返回 true。 */
export function shouldCheck(lastCheckAt, now = Date.now(), minMs = 6 * 3600 * 1000) {
  const t = Date.parse(String(lastCheckAt || ''));
  if (!Number.isFinite(t)) return true;
  return now - t >= minMs;
}

/**
 * 这次检查出来的版本要不要提示用户。
 *   · 不比当前版本新 → 不提示（包含「远端更旧」这种回滚场景）
 *   · 用户点过「跳过这个版本」→ 不提示
 */
export function shouldOffer(latestVersion, currentVersion, ignoredVersion = '') {
  if (!latestVersion) return false;
  if (compareVersion(latestVersion, currentVersion) <= 0) return false;
  if (ignoredVersion && compareVersion(latestVersion, ignoredVersion) === 0) return false;
  return true;
}

/** 1536 → `1.5 KB`。界面上只显示这个，不显示字节数。 */
export function formatBytes(n) {
  // 负数与 NaN 一律当 0：界面上出现「-1 B」「NaN B」比不显示还糟
  const raw = Number(n);
  const v = Number.isFinite(raw) && raw > 0 ? raw : 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(0)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
