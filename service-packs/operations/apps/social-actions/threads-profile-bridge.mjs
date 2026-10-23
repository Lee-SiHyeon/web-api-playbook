import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { stageThreadsProfileEnvelope } from './threads-profile.mjs';

const [kind, key] = process.argv.slice(2);
if (!['write', 'bio-write', 'profile-read', 'links-read'].includes(kind) || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(key || '')) {
  process.stderr.write(JSON.stringify({ ok: false, code: 'THREADS_PROFILE_BRIDGE_ARGUMENTS_INVALID' }) + '\n');
  process.exit(2);
}

const route = '/' + randomBytes(24).toString('hex');
const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  const corsHeaders = origin === 'https://www.threads.com' ? {
    'access-control-allow-origin': origin,
    'access-control-allow-private-network': 'true',
    vary: 'Origin',
  } : {};
  if (req.method === 'OPTIONS' && req.url === route
    && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
    && origin === 'https://www.threads.com') {
    res.writeHead(204, { ...corsHeaders, 'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type', 'cache-control': 'no-store' });
    res.end();
    return;
  }
  if (req.method !== 'POST' || req.url !== route
    || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
    || origin !== 'https://www.threads.com') {
    res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end('{"ok":false}');
    return;
  }
  let size = 0;
  const chunks = [];
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1_000_000) throw Object.assign(new Error(), { code: 'THREADS_PROFILE_INPUT_LIMIT' });
      chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const receipt = await stageThreadsProfileEnvelope({ kind, key, envelope: input });
    res.writeHead(200, { ...corsHeaders, 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, ...receipt }));
  } catch (error) {
    const code = /^THREADS_PROFILE_[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'THREADS_PROFILE_BRIDGE_FAILED';
    res.writeHead(400, { ...corsHeaders, 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: false, code }));
  } finally {
    server.close();
  }
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  process.stdout.write(JSON.stringify({ ready: true, port: address.port, route }) + '\n');
});
