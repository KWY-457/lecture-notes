/**
 * 配置保护：测试脚本会真的改服务端的 data/config.json（塞假 Key、假地址），
 * 跑完必须原样还原 —— 否则用户自己的 Key 被清空、服务商被改成测试用的假地址，
 * 表现为「设置里 Key 又没了」「转写一直失败」。
 *
 * 为什么不用「测试里别改配置」这种办法：这些测试的意义就是验证改配置后的行为，
 * 不给它改就等于没测。所以做法是「改前备份、无论如何都还原」。
 *
 * 用法：
 *   import { guardConfig } from './config-guard.mjs';
 *   const restoreConfig = await guardConfig(BASE);   // 脚本一开始就调
 *   // …随便改配置…
 *   await restoreConfig();                            // 正常结束时
 *
 * 就算脚本中途崩了、被 Ctrl+C、被 run-all 的 120 秒超时 SIGKILL，也会尽力还原：
 * 我们在进程退出钩子里再写一次（同步写，因为 exit 里不能 await）。
 * SIGKILL 拦不住 —— 那种情况只能靠下一次启动的自愈，所以下面的 restore 是幂等的。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 读服务端 /api/health 拿真实数据目录（测试可能是 --data 起的临时目录） */
export async function guardConfig(base) {
  let file = null;
  let backup = null;

  try {
    const health = await fetch(base + '/api/health').then((r) => r.json());
    if (health?.dataDir) file = path.join(health.dataDir, 'config.json');
  } catch {
    // 服务没起来，没什么可保护的
    return async () => {};
  }
  if (!file) return async () => {};

  backup = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  let restored = false;

  const write = () => {
    if (restored) return;
    restored = true;
    try {
      if (backup === null) fs.rmSync(file, { force: true });
      else fs.writeFileSync(file, backup, 'utf8');
    } catch {
      // 写不进去也不能让退出流程炸掉
    }
  };

  /**
   * 还原分两步，少一步都不算还原：
   *   1. 把文件写回原样（磁盘）
   *   2. 让服务把内存里的配置也丢掉重读（POST /config/reload）
   *
   * 只做第 1 步会留下一个隐蔽的坑：磁盘上是干净的，服务内存里还是测试塞的
   * 假地址和假 Key。之后只要服务自己 saveConfig 一次（例如 rememberKeys()
   * 在下次改设置时自动收录 Key），脏配置就又写回磁盘 —— 表现为「明明还原了，
   * 过一会儿 Key 又变成测试用的那把」。这个坑我们真的踩过一次。
   */
  const restore = async () => {
    write();
    try {
      await fetch(base + '/api/config/reload', { method: 'POST' });
    } catch {
      // 老版本服务没有这个接口，忽略
    }
  };

  // 兜底：被 SIGINT / 未捕获异常 / process.exit 干掉时，同步再写一次。
  // SIGKILL（run-all 的超时就是这么杀的）拦不住，所以还留了 /config/reload 这条自愈路径。
  process.on('exit', write);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      write();
      process.exit(1);
    });
  }

  return restore;
}

/**
 * 判断「现在的配置是不是一份测试留下的假配置」。
 * 给服务端启动时用不上（服务端不该猜用户意图），但测试脚本自己可以用来
 * 在上一轮被 SIGKILL 之后把明显是假的配置清掉。
 */
export function looksLikeTestConfig(cfg) {
  const asr = cfg?.asr || {};
  const llm = cfg?.llm || {};
  const endpoint = String(asr.endpoint || '');
  const baseUrl = String(llm.baseUrl || '');
  const fakeHosts = /^http:\/\/(127\.0\.0\.1|localhost):\d+\/(v1|v1\/audio)/;
  return (
    (asr.provider === 'custom' && fakeHosts.test(endpoint)) ||
    (fakeHosts.test(baseUrl) && /fake|mock/i.test(String(llm.model || asr.model || '')))
  );
}
