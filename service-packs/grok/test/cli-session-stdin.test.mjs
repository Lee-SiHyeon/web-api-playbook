import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_PATH = path.join(REPO_ROOT, 'src', 'cli.mjs');

function sessionPacket(input, { cookieValue = 'synthetic-private-cookie-value', email = 'private-test@example.invalid' } = {}) {
  return {
    sessionBundle: {
      schemaVersion: 1,
      serviceId: 'grok-web',
      origin: 'https://grok.com',
      capturedAt: new Date().toISOString(),
      sourceObservationId: 'test-session-stdin',
      origins: [{
        origin: 'https://grok.com',
        cookies: [{ name: 'sso', value: cookieValue, origin: 'https://grok.com', domain: 'grok.com', path: '/', secure: true, httpOnly: true }],
        headers: [],
      }],
    },
    expectedIdentity: email,
    input,
  };
}

function runCli(args, { input, env, cwd = REPO_ROOT }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
    child.stdin.end(JSON.stringify(input));
  });
}

test('Linux session-stdin read uses an in-memory session and never prints credentials or owner identity', async t => {
  const scratchRoot = process.env.TMPDIR || path.join(os.homedir(), '.nad-scratch', 'tmp');
  await mkdir(scratchRoot, { recursive: true });
  const directory = await mkdtemp(path.join(scratchRoot, 'grok-cli-session-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pythonShim = path.join(directory, 'python');
  const shim = `#!${process.execPath}
let text = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => text += chunk);
process.stdin.on('end', () => {
  const packet = JSON.parse(text);
  const identity = packet.url === 'https://grok.com/api/auth/session';
  const body = identity ? { status: 'ok', session: { email: 'private-test@example.invalid' } }
    : packet.url.includes('/load-responses')
      ? { responses: [{ responseId: 'private-response-id', message: 'Hello from Grok.', sender: 'assistant', url: 'https://private.example.invalid/share' }] }
      : { conversations: [] };
  process.stdout.write(JSON.stringify({
    status: 200,
    contentType: 'application/json',
    httpVersion: 'h2',
    bodyBase64: Buffer.from(JSON.stringify(body)).toString('base64'),
    setCookies: [],
    requestHeaderNames: ['cookie'],
    requestMeta: { cookieNames: packet.cookies.map(cookie => cookie.name) },
  }));
});
`;
  await writeFile(pythonShim, shim, { mode: 0o700 });
  await chmod(pythonShim, 0o700);

  const cookieValue = 'synthetic-private-cookie-value';
  const email = 'private-test@example.invalid';
  const input = sessionPacket({ pageSize: 24 }, { cookieValue, email });
  const pathPrefix = path.dirname(process.execPath);
  const result = await runCli(['read', 'conversation.list.read', '--session-stdin', '--python', pythonShim], {
    input,
    env: { ...process.env, PATH: `${pathPrefix}${path.delimiter}${process.env.PATH ?? ''}` },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.deepEqual(result.stderr, '');
  assert.equal(result.stdout.includes(cookieValue), false);
  assert.equal(result.stdout.includes(email), false);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.operationId, 'conversation.list.read');
  assert.equal(receipt.ownerVerified, true);
  assert.equal(receipt.status, 200);
  assert.equal(receipt.responseBytes > 0, true);

  const history = await runCli(['read', 'history.load-responses', '--session-stdin', '--python', pythonShim, '--output=json'], {
    input: sessionPacket({ conversationId: 'private-conversation-id', responseIds: ['private-response-id'] }, { cookieValue, email }),
    env: { ...process.env, PATH: `${pathPrefix}${path.delimiter}${process.env.PATH ?? ''}` },
  });
  assert.equal(history.code, 0, history.stderr);
  const historyReceipt = JSON.parse(history.stdout);
  assert.equal(historyReceipt.ownerVerified, true);
  assert.equal(historyReceipt.data.responses[0].message, 'Hello from Grok.');
  assert.equal(history.stdout.includes(cookieValue), false);
  assert.equal(history.stdout.includes(email), false);
  assert.equal(historyReceipt.data.responses[0].responseId, 'private-response-id');
  assert.equal(history.stdout.includes('private-conversation-id'), false);
  assert.equal(history.stdout.includes('private.example.invalid'), false);
});
