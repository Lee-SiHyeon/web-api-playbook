import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ELEVENLABS_STORE,
  elevenLabsSessionStatus,
  importElevenLabsSession,
  loadElevenLabsSession,
} from '../lib/elevenlabs-session.mjs';

const SYNTHETIC_AUTH = 'TEST_ONLY_SYNTHETIC_BEARER_VALUE';
const SYNTHETIC_COOKIE = 'TEST_ONLY_SYNTHETIC_COOKIE_VALUE';

class EphemeralTestStore {
  constructor(directory) { this.directory = directory; this.value = null; this.writes = 0; }
  write(name, value) {
    assert.equal(name, ELEVENLABS_STORE);
    this.writes += 1;
    this.value = value;
    return { stored: true, provider: 'synthetic-test-memory', persistent: false };
  }
  read(name) { assert.equal(name, ELEVENLABS_STORE); return this.value; }
  status(name) {
    assert.equal(name, ELEVENLABS_STORE);
    return { available: this.value !== null, provider: 'synthetic-test-memory', persistent: false };
  }
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'elevenlabs-session-validation-'));
  const store = new EphemeralTestStore(directory);
  t.after(async () => {
    store.value = null;
    await rm(directory, { recursive: true, force: true });
  });
  return store;
}

function capture(overrides = {}) {
  return {
    capturedAt: new Date().toISOString(),
    observedOrigins: [{
      origin: 'https://elevenlabs.io',
      responseStatus: 200,
      authHeaders: { authorization: `Bearer ${SYNTHETIC_AUTH}` },
      cookies: [{ name: 'session-test', value: SYNTHETIC_COOKIE, domain: '.elevenlabs.io', path: '/',
        secure: true, httpOnly: true, expires: (Date.now() + 60_000) / 1000 }],
    }],
    ...overrides,
  };
}

async function rejectedWithoutWrite(t, envelope, code, sentinels = []) {
  const store = await fixture(t);
  await assert.rejects(importElevenLabsSession(envelope, { store }), error => {
    assert.equal(error.code, code);
    for (const value of sentinels) assert.equal(JSON.stringify(error).includes(value), false);
    return true;
  });
  assert.equal(store.writes, 0);
}

test('accepts fresh synthetic capture into only the injected ephemeral store and reports no live authentication', async t => {
  const store = await fixture(t);
  const receipt = await importElevenLabsSession(capture(), { store });
  assert.deepEqual(receipt, { stored: true, provider: 'synthetic-test-memory', persistent: false });
  assert.equal(store.writes, 1);
  assert.equal(JSON.stringify(receipt).includes(SYNTHETIC_AUTH), false);
  assert.equal(JSON.stringify(receipt).includes(SYNTHETIC_COOKIE), false);

  const state = JSON.parse(store.value);
  assert.deepEqual(state.session.allowedOrigins, ['https://elevenlabs.io']);
  assert.deepEqual(state.session.cookieOrigins, ['https://elevenlabs.io']);
  assert.deepEqual(Object.keys(state.session.defaultHeaders), []);
  assert.equal(state.session.maxRedirects, 0);

  const status = await elevenLabsSessionStatus({ store });
  assert.equal(status.stored, true);
  assert.equal(status.liveCheckPerformed, false);
  assert.equal(status.authenticatedOwnerVerified, false);
  assert.equal(JSON.stringify(status).includes(SYNTHETIC_AUTH), false);
  assert.equal(JSON.stringify(status).includes(SYNTHETIC_COOKIE), false);

  const session = loadElevenLabsSession({ store });
  assert.deepEqual(session.toJSON().allowedOrigins, ['https://elevenlabs.io']);
});

test('rejects malformed or stale capture envelopes before storage', async t => {
  await rejectedWithoutWrite(t, { ...capture(), secret: SYNTHETIC_AUTH }, 'ELEVENLABS_IMPORT_SCHEMA_INVALID', [SYNTHETIC_AUTH]);
  await rejectedWithoutWrite(t, capture({ capturedAt: new Date(Date.now() - 6 * 60_000).toISOString() }),
    'ELEVENLABS_IMPORT_STALE_OR_INVALID', [SYNTHETIC_AUTH]);
});

test('rejects origins outside the ElevenLabs HTTPS origin boundary', async t => {
  await rejectedWithoutWrite(t, capture({ observedOrigins: [{
    origin: 'https://attacker.invalid', responseStatus: 200,
    authHeaders: { authorization: `Bearer ${SYNTHETIC_AUTH}` },
  }] }), 'ELEVENLABS_ORIGIN_SCOPE', [SYNTHETIC_AUTH]);
  await rejectedWithoutWrite(t, capture({ observedOrigins: [{
    origin: 'http://elevenlabs.io', responseStatus: 200,
    authHeaders: { authorization: `Bearer ${SYNTHETIC_AUTH}` },
  }] }), 'ELEVENLABS_ORIGIN_SCOPE', [SYNTHETIC_AUTH]);
});

test('rejects non-auth headers and case-colliding authorization header names', async t => {
  await rejectedWithoutWrite(t, capture({ observedOrigins: [{
    origin: 'https://elevenlabs.io', responseStatus: 200,
    authHeaders: { accept: `Bearer ${SYNTHETIC_AUTH}` },
  }] }), 'ELEVENLABS_IMPORT_HEADERS_INVALID', [SYNTHETIC_AUTH]);
  await rejectedWithoutWrite(t, capture({ observedOrigins: [{
    origin: 'https://elevenlabs.io', responseStatus: 200,
    authHeaders: { authorization: SYNTHETIC_AUTH, Authorization: `Bearer ${SYNTHETIC_AUTH}` },
  }] }), 'ELEVENLABS_IMPORT_HEADERS_INVALID', [SYNTHETIC_AUTH]);
});

test('rejects cookie injection, expired cookies, foreign domains, and unrecognized cookie fields', async t => {
  const base = capture().observedOrigins[0];
  await rejectedWithoutWrite(t, capture({ observedOrigins: [{ ...base, cookies: [{
    name: 'session-test', value: `${SYNTHETIC_COOKIE}\r\nAuthorization: ${SYNTHETIC_AUTH}`,
    domain: '.elevenlabs.io', path: '/', secure: true,
  }] }] }), 'SCOPED_SESSION_COOKIES_INVALID', [SYNTHETIC_AUTH, SYNTHETIC_COOKIE]);
  await rejectedWithoutWrite(t, capture({ observedOrigins: [{ ...base, cookies: [{
    name: 'session-test', value: SYNTHETIC_COOKIE, domain: '.evil-elevenlabs.io', path: '/', secure: true,
  }] }] }), 'ELEVENLABS_IMPORT_COOKIES_INVALID', [SYNTHETIC_COOKIE]);
  await rejectedWithoutWrite(t, capture({ observedOrigins: [{ ...base, cookies: [{
    name: 'session-test', value: SYNTHETIC_COOKIE, domain: '.elevenlabs.io', path: '/', secure: true,
    expires: (Date.now() - 60_000) / 1000,
  }] }] }), 'ELEVENLABS_IMPORT_COOKIES_INVALID', [SYNTHETIC_COOKIE]);
  await rejectedWithoutWrite(t, capture({ observedOrigins: [{ ...base, cookies: [{
    name: 'session-test', value: SYNTHETIC_COOKIE, domain: '.elevenlabs.io', path: '/', secure: true,
    authorization: SYNTHETIC_AUTH,
  }] }] }), 'ELEVENLABS_IMPORT_COOKIES_INVALID', [SYNTHETIC_AUTH, SYNTHETIC_COOKIE]);
});

test('rejects responses that are not successful observed captures', async t => {
  await rejectedWithoutWrite(t, capture({ observedOrigins: [{
    origin: 'https://elevenlabs.io', responseStatus: 403,
    authHeaders: { authorization: `Bearer ${SYNTHETIC_AUTH}` },
  }] }), 'ELEVENLABS_IMPORT_EVIDENCE_REQUIRED', [SYNTHETIC_AUTH]);
});
