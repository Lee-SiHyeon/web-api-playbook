import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, generateKeyPairSync, publicEncrypt, randomBytes } from 'node:crypto';
import { decryptHandoffEnvelope } from '../src/bootstrap-receive.mjs';
import { SERVICE_ID, SERVICE_ORIGIN } from '../src/constants.mjs';
import { contract } from './helpers.mjs';

function encryptedEnvelope(runId, publicKey, bundle) {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('gemini-web-xhr-client:v1', 'utf8'));
  const plaintext = Buffer.from(JSON.stringify(bundle), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  const wrappedKey = publicEncrypt({ key: publicKey, oaepHash: 'sha256' }, key);
  key.fill(0);
  plaintext.fill(0);
  return {
    version: 1,
    service: SERVICE_ID,
    origin: SERVICE_ORIGIN,
    runId,
    wrappedKey: wrappedKey.toString('base64'),
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

test('accepts only a matching encrypted Gemini session handoff', () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const runId = 'local-bootstrap-run';
  const observed = contract({
    auth: { origins: [SERVICE_ORIGIN], cookieNames: ['AUTH_COOKIE'], headerNames: [] },
  });
  const bundle = {
    version: 1,
    service: SERVICE_ID,
    origin: SERVICE_ORIGIN,
    capturedAt: '2026-10-03T00:00:00.000Z',
    cookies: [{ name: 'AUTH_COOKIE', value: 'synthetic-secret-cookie' }],
    headers: {},
    password: 'must-not-be-returned',
  };
  const envelope = encryptedEnvelope(runId, pair.publicKey, bundle);
  const decoded = decryptHandoffEnvelope(envelope, pair.privateKey, runId, observed);
  assert.deepEqual(Object.keys(decoded).sort(), ['capturedAt', 'cookies', 'headers', 'origin', 'requestHeaders', 'service', 'version']);
  assert.equal(decoded.cookies[0].name, 'AUTH_COOKIE');
  assert.throws(() => decryptHandoffEnvelope(envelope, pair.privateKey, 'another-run', observed), { code: 'HANDOFF_INVALID' });
});

test('rejects an encrypted session from the Google Flow origin', () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const envelope = encryptedEnvelope('run', pair.publicKey, {
    version: 1,
    service: SERVICE_ID,
    origin: 'https://flow.google.com',
    capturedAt: '2026-10-03T00:00:00.000Z',
    cookies: [],
    headers: {},
  });
  assert.throws(() => decryptHandoffEnvelope(envelope, pair.privateKey, 'run', contract()), { code: 'SESSION_SCOPE_INVALID' });
});
