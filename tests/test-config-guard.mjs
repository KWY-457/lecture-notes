/**
 * 配置保护模块自测：确保「测试跑完把 data/config.json 原样还回去」真的成立。
 *
 * 这个测试存在的理由：config-guard 本身错了，后果是所有测试都在悄悄毁用户配置，
 * 而且现场看起来一切正常 —— 最坏的一类 bug，必须有测试盯着。
 *
 * 运行： node tests/test-config-guard.mjs [appBase]
 * 需要服务在跑（读 /api/health 拿 dataDir；用 --data 起的临时服务也行）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { guardConfig, looksLikeTestConfig } from './config-guard.mjs';

const BASE = process.argv[2] || process.env.LN_BASE || 'http://127.0.0.1:8788';
let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  → ' + detail}`);
};

const health = await fetch(BASE + '/api/health').then((r) => r.json());
const FILE = path.join(health.dataDir, 'config.json');

console.log('\n=== 1. 备份与还原 ===');
const original = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : null;
check('拿得到 config.json 路径', !!FILE, FILE);

{
  const restore = await guardConfig(BASE);
  check('guardConfig 返回可调用的还原函数', typeof restore === 'function');

  // 模拟测试脚本乱改配置
  fs.writeFileSync(FILE, JSON.stringify({ asr: { provider: 'custom', apiKey: 'sk-test-garbage' } }), 'utf8');
  check('暴力改写成功（前提）', fs.readFileSync(FILE, 'utf8').includes('sk-test-garbage'));

  await restore();
  const after = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : null;
  check('还原后与备份逐字节相同', after === original, `${String(after).length} vs ${String(original).length}`);
}

console.log('\n=== 2. 没有 config.json 时不能凭空造一个 ===');
{
  // 造一个「服务端其实没有配置文件」的场景：先把文件挪走
  let moved = null;
  if (fs.existsSync(FILE)) {
    moved = fs.readFileSync(FILE, 'utf8');
    fs.rmSync(FILE, { force: true });
  }
  const restore = await guardConfig(BASE);
  fs.writeFileSync(FILE, '{"asr":{"provider":"custom"}}', 'utf8');
  await restore();
  check('原本没有配置文件的，还原后仍然没有', !fs.existsSync(FILE), '文件被凭空创建了');
  if (moved !== null) fs.writeFileSync(FILE, moved, 'utf8');
}

console.log('\n=== 3. 重复调用还原是幂等的 ===');
{
  const restore = await guardConfig(BASE);
  const before = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : null;
  await restore();
  await restore();
  await restore();
  const after = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : null;
  check('连调三次仍是同一份配置', after === before, '');
}

console.log('\n=== 4. 服务连不上时不炸 ===');
{
  const restore = await guardConfig('http://127.0.0.1:59999');
  check('连不上也返回函数而不是抛异常', typeof restore === 'function');
  await restore();
  check('空的还原函数可以安全调用', true);
}

console.log('\n=== 5. 假配置识别 ===');
{
  check('自定义服务商 + 本机地址 → 判定为测试配置',
    looksLikeTestConfig({ asr: { provider: 'custom', endpoint: 'http://127.0.0.1:8791/v1/audio/transcriptions' } }) === true);
  check('自定义服务商 + 正常地址 → 不是测试配置',
    looksLikeTestConfig({ asr: { provider: 'custom', endpoint: 'http://192.168.1.50:8080/v1/audio/transcriptions' } }) === false);
  check('硅基流动 + 真地址 → 不是测试配置',
    looksLikeTestConfig({ asr: { provider: 'siliconflow', endpoint: 'https://api.siliconflow.cn/v1/audio/transcriptions' } }) === false);
  check('假模型名 + 本机 baseUrl → 判定为测试配置',
    looksLikeTestConfig({ llm: { baseUrl: 'http://127.0.0.1:8791/v1', model: 'fake-chat' } }) === true);
  check('空的配置对象不报错',
    looksLikeTestConfig({}) === false);
  check('null 不报错',
    looksLikeTestConfig(null) === false);
}

// 收尾自检：不管前面怎么折腾，最终必须和进脚本时一致
const final = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : null;
check('最终磁盘上的配置与测试开始时一致', final === original, `${String(final).length} vs ${String(original).length}`);

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
process.exitCode = fail ? 1 : 0;
