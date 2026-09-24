import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidence = path.join(root, 'evidence');
const port = 48765;
const maxBytes = 12 * 1024 * 1024;

await mkdir(evidence, { recursive: true });

const server = http.createServer((request, response) => {
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  response.setHeader('access-control-allow-headers', 'content-type');
  if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
  if (request.method === 'GET' && request.url === '/health') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (request.method !== 'POST' || request.url !== '/result') {
    response.writeHead(404); response.end(); return;
  }
  const chunks = [];
  let size = 0;
  request.on('data', chunk => {
    size += chunk.length;
    if (size > maxBytes) request.destroy();
    else chunks.push(chunk);
  });
  request.on('end', async () => {
    try {
      const record = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const stamp = new Date().toISOString().replace(/[-:.]/g, '').replace('Z', 'Z');
      const filename = `coupang-partners-browser-capture-${stamp}.json`;
      const destination = path.join(evidence, filename);
      await writeFile(destination, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, filename }));
      console.log(JSON.stringify({ saved: destination, bytes: size, completed: record.completed !== false }));
      setTimeout(() => server.close(), 500);
    } catch {
      response.writeHead(400); response.end(JSON.stringify({ error: 'invalid_payload' }));
    }
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ listening: `http://127.0.0.1:${port}`, evidence }));
});
