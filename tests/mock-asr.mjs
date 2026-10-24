/**
 * 假的云端转写服务：只为测「两条云端转写真的并发」这条链路。
 *
 * 为什么需要它：真实的云端要 API Key、要花钱、一条要等几十秒，
 * 不适合放进自动化测试。但「并发」这件事只有在真发 HTTP、真等返回时才测得准，
 * 靠造假 job 档案只能证明显示逻辑，证明不了请求真的并行。
 *
 * 行为：收到 /v1/audio/transcriptions 就等 DELAY_MS 毫秒再回，
 * 返回里带上「这条请求是什么时候进来的、同时有几条在跑」，方便断言。
 *
 * 用法：node tests/mock-asr.mjs [port]
 */
import http from 'node:http';

const PORT = Number(process.argv[2] || 8799);
const DELAY_MS = Number(process.env.MOCK_ASR_DELAY_MS || 6000);

let seq = 0;
let concurrent = 0;
let peakConcurrent = 0;
const log = [];

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/stats') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, peakConcurrent, concurrent, log }));
    return;
  }
  if (req.method === 'POST' && req.url.startsWith('/v1/audio/transcriptions')) {
    const myId = ++seq;
    concurrent++;
    peakConcurrent = Math.max(peakConcurrent, concurrent);
    const enteredAt = Date.now();
    log.push({ id: myId, enteredAt, concurrentAtEnter: concurrent });

    // 把请求体读干净，不然 Node 不会释放这个连接
    req.resume();
    req.on('end', () => {
      setTimeout(() => {
        concurrent--;
        const text = `这是第 ${myId} 条测试录音的转写结果。它等了 ${Math.round((Date.now() - enteredAt) / 1000)} 秒才返回。`;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            text,
            // 故意不回 segments，走 server.mjs 里「按句切段」那条分支
            duration: 8,
            mock: { id: myId, concurrentAtEnter: log[myId - 1].concurrentAtEnter, peakConcurrent },
          })
        );
      }, DELAY_MS);
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock ASR 已启动：http://127.0.0.1:${PORT}/v1/audio/transcriptions（延迟 ${DELAY_MS}ms）`);
});

// 收到 Ctrl+C / 被 kill 时干净退出
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
