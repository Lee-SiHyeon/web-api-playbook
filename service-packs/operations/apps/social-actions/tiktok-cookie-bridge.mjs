import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { persistTikTokSessionFromCookies } from './lib/tiktok-auth-session.mjs';

const route = '/' + randomBytes(24).toString('hex');
const server = createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== route
    || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"ok":false}');
    return;
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1_000_000) throw new Error('BODY_LIMIT');
      chunks.push(chunk);
    }
    const cookies = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const receipt = await persistTikTokSessionFromCookies(cookies);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, ...receipt }));
  } catch (error) {
    res.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: false, code: error?.code || 'TIKTOK_CAPTURE_BRIDGE_FAILED' }));
  } finally {
    server.close();
  }
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  console.log(JSON.stringify({ ready: true, host: '127.0.0.1', port: address.port, route }));
});
