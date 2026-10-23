import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, publicEncrypt, randomBytes } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { receiveOneEncryptedSession } from '../src/bootstrap-receive.mjs';

test('bootstrap decrypts only a fresh service-scoped encrypted bundle and never echoes cookies', async () => {
  const input = new PassThrough();
  let outputText = '';
  let announce;
  const announced = new Promise((resolve) => { announce = resolve; });
  const output = new Writable({ write(chunk, _encoding, callback) {
    outputText += chunk.toString('utf8');
    if (outputText.includes('\n')) announce(JSON.parse(outputText.split('\n')[0]));
    callback();
  } });
  const errorOutput = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  let stored = null;
  const pending = receiveOneEncryptedSession({ input, output, errorOutput,
    write: async (name, value) => { stored = { name, value }; return { stored: true }; } });
  const handshake = await announced;
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('chatgpt-web-xhr-client:v1'));
  const bundle = {
    version: 1, service: 'chatgpt-web', origin: 'https://chatgpt.com', capturedAt: new Date().toISOString(),
    cookies: [{ name: 'ordinary_session', value: 'never-print-this-unit-secret', domain: 'chatgpt.com', path: '/', secure: true }],
  };
  const plaintext = Buffer.from(JSON.stringify(bundle));
  const encryptedBody = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  const wrappedKey = publicEncrypt({ key: Buffer.from(handshake.publicKey, 'base64'), format: 'der', type: 'spki', oaepHash: 'sha256' }, key);
  input.end(`${JSON.stringify({ version: 1, runId: handshake.runId, wrappedKey: wrappedKey.toString('base64'),
    iv: iv.toString('base64'), ciphertext: encryptedBody.toString('base64') })}\n`);
  const result = await pending;
  assert.equal(result.stored, true);
  assert.equal(stored.name, 'chatgpt-web-session-v1');
  assert.equal(JSON.parse(stored.value).cookies.length, 1);
  assert.equal(outputText.includes('never-print-this-unit-secret'), false);
  assert.equal(outputText.includes('chatgpt.com'), true);
  stored = null;
  key.fill(0);
  plaintext.fill(0);
});
