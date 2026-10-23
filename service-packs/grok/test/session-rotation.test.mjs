import test from 'node:test';
import assert from 'node:assert/strict';
import { GrokSessionStore, boundCredentials, GROK_WEB_ORIGIN } from '../src/session.mjs';
import { ProtectedJsonStore } from '../src/protected-json-store.mjs';

async function session() {
  const store = new GrokSessionStore({ store: new ProtectedJsonStore({ provider: 'memory' }) });
  await store.importBundle({
    schemaVersion: 1, serviceId: 'grok-web', origin: GROK_WEB_ORIGIN,
    capturedAt: new Date().toISOString(), sourceObservationId: 'rotation-test',
    origins: [{ origin: GROK_WEB_ORIGIN, headers: [], cookies: [{
      name: 'sso', value: 'test-original', domain: '.grok.com', path: '/', secure: true, httpOnly: true,
    }] }],
  });
  return store;
}

test('a dotted cookie domain rotates the existing credential without duplicates', async () => {
  const store = await session();
  const receipt = await store.rotateCookies(GROK_WEB_ORIGIN, ['sso'], ['sso=test-next; Domain=.grok.com; Path=/; Secure; HttpOnly']);
  const state = await store.load();
  assert.equal(receipt.changed, true);
  assert.equal(state.origins[0].cookies.length, 1);
  assert.equal(boundCredentials(state, GROK_WEB_ORIGIN, '/api/auth/session', { cookieNames: ['sso'] }).cookieHeader, 'sso=test-next');
});

test('positive Max-Age takes precedence over a stale Expires attribute', async () => {
  const store = await session();
  const now = Date.now();
  await store.rotateCookies(GROK_WEB_ORIGIN, ['sso'], ['sso=test-next; Max-Age=3600; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Secure'], { now });
  const cookie = (await store.load()).origins[0].cookies[0];
  assert.equal(cookie.value, 'test-next');
  assert.equal(Date.parse(cookie.expiresAt), now + 3_600_000);
});

test('zero Max-Age removes the credential even with a future Expires value', async () => {
  const store = await session();
  await store.rotateCookies(GROK_WEB_ORIGIN, ['sso'], ['sso=test-next; Domain=.grok.com; Max-Age=0; Expires=Fri, 01 Jan 2100 00:00:00 GMT; Path=/']);
  assert.equal((await store.load()).origins[0].cookies.length, 0);
});

test('rotation rejects other domains and preserves changed security attributes', async () => {
  const store = await session();
  assert.equal((await store.rotateCookies(GROK_WEB_ORIGIN, ['sso'], ['sso=test-foreign; Domain=example.com; Path=/'])).changed, false);
  assert.equal((await store.rotateCookies(GROK_WEB_ORIGIN, ['sso'], ['sso=test-original; Domain=grok.com; Path=/'])).changed, true);
  const cookie = (await store.load()).origins[0].cookies[0];
  assert.equal(cookie.secure, false);
  assert.equal(cookie.httpOnly, false);
});

test('an expired required credential is rejected before sending and reported without its value', async () => {
  const store = await session();
  await store.rotateCookies(GROK_WEB_ORIGIN, ['sso'], ['sso=test-next; Max-Age=1; Path=/'], { now: Date.now() - 2000 });
  const state = await store.load();
  assert.throws(() => boundCredentials(state, GROK_WEB_ORIGIN, '/api/auth/session', { cookieNames: ['sso'] }), { code: 'SESSION_EXPIRED' });
  const status = await store.status();
  assert.equal(status.expiredCookieCount, 1);
  assert.equal(JSON.stringify(status).includes('test-next'), false);
});
