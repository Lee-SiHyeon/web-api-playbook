import test from 'node:test';
import assert from 'node:assert/strict';
import {
  constants,
  createCipheriv,
  createPublicKey,
  generateKeyPairSync,
  publicEncrypt,
  randomBytes,
} from 'node:crypto';
import { PassThrough } from 'node:stream';
import {
  HANDOFF_AAD_LABEL,
  MAX_HANDOFF_LINE_BYTES,
  handoffAssociatedData,
  receiveOneEncryptedSession,
} from '../src/bootstrap-receive.mjs';
import { loadContractRegistry } from '../src/client.mjs';
import { GROK_WEB_ORIGIN } from '../src/session.mjs';

function privateReadRegistry({ cookieName = 'sid', securityBoundary = 'normal_observed_xhr', securitySignals = [] } = {}) {
  return {
    schemaVersion: 1,
    serviceId: 'grok-web',
    serviceOrigin: GROK_WEB_ORIGIN,
    allowedOrigins: [GROK_WEB_ORIGIN],
    identityOperationId: 'identity.read',
    operations: [{
      id: 'identity.read',
      kind: 'read',
      role: 'identity',
      identityJsonPointer: '/handle',
      method: 'GET',
      urlTemplate: `${GROK_WEB_ORIGIN}/rest/account/me`,
      authMode: 'session',
      request: {
        credentialBindings: { cookies: [cookieName], headers: ['x-observed-session'] },
        inputSchema: { properties: {}, required: [] },
      },
      response: { mode: 'json', statuses: [200], contentTypes: ['application/json'], maxBytes: 4096 },
      evidence: {
        source: 'browser_network_capture',
        capturedAt: '2026-10-04',
        requestMethod: 'GET',
        requestPath: '/rest/account/me',
        httpStatus: 200,
        responseContentType: 'application/json',
        securityBoundary,
        securitySignals,
      },
    }],
  };
}

function sessionBundle({ cookieName = 'sid', cookieDomain = 'grok.com', capturedAt = new Date().toISOString() } = {}) {
  return {
    schemaVersion: 1,
    serviceId: 'grok-web',
    origin: GROK_WEB_ORIGIN,
    capturedAt,
    sourceObservationId: 'synthetic-browser-read-1',
    origins: [{
      origin: GROK_WEB_ORIGIN,
      cookies: [{ name: cookieName, value: 'synthetic-cookie-value', domain: cookieDomain, path: '/', secure: true, httpOnly: true }],
      headers: [{ name: 'x-observed-session', value: 'synthetic-header-value' }],
    }],
  };
}

function fakeDpapiStore() {
  const stored = [];
  return {
    provider: 'Windows DPAPI CurrentUser',
    stored,
    async importBundle(bundle) {
      stored.push(structuredClone(bundle));
      return { stored: true, provider: this.provider, persistent: true,
        cookieCount: bundle.origins[0].cookies.length, headerCount: bundle.origins[0].headers.length };
    },
  };
}

function startReceiver({ registry, store = fakeDpapiStore(), maxWaitMs = 30_000, now = () => Date.now() } = {}) {
  const input = new PassThrough();
  const outputLines = [];
  let resolveWaiting;
  const waiting = new Promise(resolve => { resolveWaiting = resolve; });
  const output = {
    write(value) {
      const line = String(value).trim();
      outputLines.push(line);
      if (outputLines.length === 1) resolveWaiting(JSON.parse(line));
      return true;
    },
  };
  const pending = receiveOneEncryptedSession({
    input,
    output,
    registryLoader: async () => registry,
    sessionStore: store,
    now,
    maxWaitMs,
  });
  return { input, outputLines, waiting, pending, store };
}

function sealBundle(waiting, bundle, { aad = handoffAssociatedData(waiting.runId),
  serviceId = 'grok-web', origin = GROK_WEB_ORIGIN, runId = waiting.runId } = {}) {
  const contentKey = randomBytes(32);
  const iv = randomBytes(12);
  const plaintext = Buffer.from(JSON.stringify(bundle), 'utf8');
  const publicKey = Buffer.from(waiting.publicKey, 'base64');
  let wrappedKey;
  let ciphertext;
  try {
    wrappedKey = publicEncrypt({
      key: createPublicKey({ key: publicKey, format: 'der', type: 'spki' }),
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    }, contentKey);
    const cipher = createCipheriv('aes-256-gcm', contentKey, iv);
    cipher.setAAD(aad);
    ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    return JSON.stringify({
      version: 1,
      serviceId,
      origin,
      runId,
      wrappedKey: wrappedKey.toString('base64'),
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    });
  } finally {
    contentKey.fill(0);
    iv.fill(0);
    plaintext.fill(0);
    publicKey.fill(0);
    wrappedKey?.fill(0);
    ciphertext?.fill(0);
    if (Buffer.isBuffer(aad)) aad.fill(0);
  }
}

async function sendAndExpectCode(receiver, envelope, code) {
  receiver.input.end(envelope);
  await assert.rejects(receiver.pending, error => error?.code === code);
  assert.equal(receiver.store.stored.length, 0);
}

test('bootstrap fails closed before creating a key while only public models are captured', async () => {
  const loaded = await loadContractRegistry();
  const registry = { ...loaded, identityOperationId: null, operations: loaded.operations.filter(operation => operation.id === 'public.models') };
  const receiver = startReceiver({ registry });
  await assert.rejects(receiver.pending, { code: 'SESSION_CONTRACT_NOT_READY' });
  assert.deepEqual(receiver.outputLines, []);
  assert.equal(receiver.store.stored.length, 0);
});

test('one fresh encrypted handoff stores only credentials named by a ready captured private operation', async () => {
  const receiver = startReceiver({ registry: privateReadRegistry() });
  const waiting = await receiver.waiting;
  assert.equal(waiting.state, 'waiting_for_encrypted_handoff');
  assert.equal(waiting.serviceId, 'grok-web');
  assert.equal(waiting.origin, GROK_WEB_ORIGIN);
  assert.equal(waiting.encryption, 'RSA-OAEP-SHA256+AES-256-GCM');
  assert.equal(waiting.aad, HANDOFF_AAD_LABEL);

  const envelope = sealBundle(waiting, sessionBundle());
  receiver.input.end(`${envelope}\n`);
  const receipt = await receiver.pending;
  assert.equal(receipt.stored, true);
  assert.equal(receipt.persistent, true);
  assert.equal(receipt.ownerVerified, false);
  assert.equal(receiver.store.stored.length, 1);
  assert.deepEqual(receiver.store.stored[0].origins[0].cookies.map(cookie => cookie.name), ['sid']);
  assert.deepEqual(receiver.store.stored[0].origins[0].headers.map(header => header.name), ['x-observed-session']);
  assert.equal(receiver.outputLines.join('\n').includes('synthetic-cookie-value'), false);
  assert.equal(receiver.outputLines.join('\n').includes('synthetic-header-value'), false);
});

test('bootstrap rejects credentials outside the captured operation allowlist', async () => {
  const receiver = startReceiver({ registry: privateReadRegistry() });
  const waiting = await receiver.waiting;
  const envelope = sealBundle(waiting, sessionBundle({ cookieName: 'other-session-cookie' }));
  await sendAndExpectCode(receiver, envelope, 'SESSION_CREDENTIAL_NOT_OBSERVED');
});

test('bootstrap refuses unresolved security boundaries even if their credential names are present', async () => {
  const receiver = startReceiver({ registry: privateReadRegistry({
    securityBoundary: 'security_boundary', securitySignals: ['captcha_detected'],
  }) });
  await assert.rejects(receiver.pending, { code: 'SESSION_CONTRACT_NOT_READY' });
  assert.deepEqual(receiver.outputLines, []);
  assert.equal(receiver.store.stored.length, 0);
});

test('bootstrap rejects challenge cookies even when a captured contract names them', async () => {
  const receiver = startReceiver({ registry: privateReadRegistry({ cookieName: '__cf_bm' }) });
  const waiting = await receiver.waiting;
  const envelope = sealBundle(waiting, sessionBundle({ cookieName: '__cf_bm' }));
  await sendAndExpectCode(receiver, envelope, 'SESSION_COOKIE_CHALLENGE_REJECTED');
});

test('bootstrap rejects overly broad cookie domains accepted by the generic store schema', async () => {
  const receiver = startReceiver({ registry: privateReadRegistry() });
  const waiting = await receiver.waiting;
  const envelope = sealBundle(waiting, sessionBundle({ cookieDomain: 'com' }));
  await sendAndExpectCode(receiver, envelope, 'SESSION_COOKIE_DOMAIN_SCOPE');
});

test('authenticated AAD binds the envelope to its run, service and origin', async () => {
  const receiver = startReceiver({ registry: privateReadRegistry() });
  const waiting = await receiver.waiting;
  const envelope = sealBundle(waiting, sessionBundle(), { aad: Buffer.from('incorrect associated data') });
  await sendAndExpectCode(receiver, envelope, 'HANDOFF_DECRYPT_FAILED');
});

test('a stale bundle is rejected before any protected-store write', async () => {
  const receiver = startReceiver({ registry: privateReadRegistry() });
  const waiting = await receiver.waiting;
  const staleTime = new Date(Date.now() - 11 * 60_000).toISOString();
  const envelope = sealBundle(waiting, sessionBundle({ capturedAt: staleTime }));
  await sendAndExpectCode(receiver, envelope, 'SESSION_BUNDLE_INVALID');
});

test('an envelope replayed into a new run cannot be imported', async () => {
  const first = startReceiver({ registry: privateReadRegistry() });
  const firstWaiting = await first.waiting;
  const replay = sealBundle(firstWaiting, sessionBundle());
  first.input.end(`${replay}\n`);
  await first.pending;
  assert.equal(first.store.stored.length, 1);

  const second = startReceiver({ registry: privateReadRegistry() });
  await second.waiting;
  await sendAndExpectCode(second, replay, 'HANDOFF_INVALID');
});

test('oversized lines and expired receive windows are bounded without importing anything', async () => {
  const oversized = startReceiver({ registry: privateReadRegistry() });
  await oversized.waiting;
  oversized.input.end(Buffer.alloc(MAX_HANDOFF_LINE_BYTES + 1, 0x41));
  await assert.rejects(oversized.pending, { code: 'HANDOFF_TOO_LARGE' });
  assert.equal(oversized.store.stored.length, 0);

  const expiredAt = Date.now() - 100;
  const timedOut = startReceiver({ registry: privateReadRegistry(), maxWaitMs: 10, now: () => expiredAt });
  await timedOut.waiting;
  await assert.rejects(timedOut.pending, { code: 'HANDOFF_EXPIRED' });
  assert.equal(timedOut.store.stored.length, 0);
});
