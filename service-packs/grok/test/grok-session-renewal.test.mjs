import test from 'node:test';
import assert from 'node:assert/strict';
import { GrokWebClient } from '../src/client.mjs';
import { ProtectedJsonStore } from '../src/protected-json-store.mjs';
import { OperationJournal } from '../src/journal.mjs';

const OWNER = 'owner@example.test';
const operation = {
  id: 'auth.owner.read', kind: 'read', role: 'identity', identityJsonPointer: '/session/email',
  method: 'GET', urlTemplate: 'https://grok.com/api/auth/session', authMode: 'session',
  request: { credentialBindings: { cookies: ['sso'], headers: [] }, inputSchema: { properties: {}, required: [] } },
  response: { mode: 'json', statuses: [200], contentTypes: ['application/json'], maxBytes: 4096 },
  evidence: { source: 'browser_network_capture', capturedAt: '2026-10-06', requestMethod: 'GET',
    requestPath: '/api/auth/session', httpStatus: 200, responseContentType: 'application/json',
    securityBoundary: 'normal_observed_xhr', securitySignals: [] },
};
const registry = { schemaVersion: 1, serviceId: 'grok-web', serviceOrigin: 'https://grok.com',
  allowedOrigins: ['https://grok.com'], identityOperationId: operation.id, operations: [operation] };

function bundle(value) {
  return { schemaVersion: 1, serviceId: 'grok-web', origin: 'https://grok.com',
    capturedAt: new Date().toISOString(), sourceObservationId: 'renewal-test',
    origins: [{ origin: 'https://grok.com', headers: [], cookies: [{ name: 'sso', value,
      domain: '.grok.com', path: '/', secure: true, httpOnly: true,
      expiresAt: new Date(Date.now() + 60_000).toISOString() }] }] };
}

async function setup(fetchOverride) {
  const sessionPersistence = new ProtectedJsonStore({ provider: 'memory' });
  const journal = new OperationJournal({ store: new ProtectedJsonStore({ provider: 'memory' }) });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ path: new URL(url).pathname, method: init.method, cookie: init.headers.get('cookie') });
    if (fetchOverride) return fetchOverride(url, init);
    return new Response(JSON.stringify({ session: { email: init.headers.get('cookie').includes('test-other') ? 'other@example.test' : OWNER } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  const client = new GrokWebClient({ registry, sessionPersistence, journal, fetchImpl });
  await client.importSession(bundle('test-original'));
  await client.verifyOwner(OWNER);
  return { client, sessionPersistence, journal, calls };
}

test('an expired client credential is replaced only after a direct owner read; no mutation is retried', async () => {
  const { client, sessionPersistence, journal, calls } = await setup();
  const state = await sessionPersistence.read();
  state.session.origins[0].cookies[0].expiresAt = new Date(Date.now() - 1000).toISOString();
  await sessionPersistence.write(state);
  await assert.rejects(client.read(operation.id), { code: 'SESSION_EXPIRED' });
  assert.equal(calls.length, 1);
  const journalBefore = await journal.list();
  const result = await client.renewSession({ expectedIdentity: OWNER, acquireSession: async () => bundle('test-fresh') });
  assert.equal(result.renewed, true);
  assert.equal(result.ownerVerified, true);
  assert.equal(result.credentialChanged, true);
  assert.equal(result.providerCookieRotationVerified, false);
  assert.equal(result.expiredProviderSessionRecoveryVerified, false);
  assert.equal(result.mutationRetried, false);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => [call.path, call.method]), [['/api/auth/session', 'GET'], ['/api/auth/session', 'GET']]);
  await client.read(operation.id);
  assert.equal(calls[2].cookie, 'sso=test-fresh');
  assert.deepEqual(await journal.list(), journalBefore);
  assert.equal(JSON.stringify(result).includes('test-fresh'), false);
});

test('a same-owner fresh handoff is not mislabeled as provider cookie rotation or expired-session recovery', async () => {
  const { client, sessionPersistence, calls } = await setup();
  const ownerDigest = (await sessionPersistence.read()).session.ownerBinding.identityDigest;
  const result = await client.renewSession({
    expectedIdentity: OWNER,
    acquireSession: async () => bundle('test-original'),
  });
  assert.equal(result.renewed, true);
  assert.equal(result.ownerVerified, true);
  assert.equal(result.mechanism, 'fresh_session_handoff_and_direct_owner_verification');
  assert.equal(result.credentialChanged, false);
  assert.equal(result.providerCookieRotationVerified, false);
  assert.equal(result.expiredProviderSessionRecoveryVerified, false);
  assert.equal(result.mutationRetried, false);
  assert.deepEqual(calls.map(call => [call.path, call.method]), [
    ['/api/auth/session', 'GET'], ['/api/auth/session', 'GET'],
  ]);
  const status = await client.status();
  assert.equal(status.session.ownerVerified, true);
  assert.equal(status.session.expiredCookieCount, 0);
  assert.equal((await sessionPersistence.read()).session.ownerBinding.identityDigest, ownerDigest);
});

test('a wrong-account handoff is rejected without changing the active account or credential', async () => {
  const { client, calls } = await setup();
  await assert.rejects(client.renewSession({ expectedIdentity: OWNER, acquireSession: async () => bundle('test-other') }), { code: 'IDENTITY_MISMATCH' });
  assert.equal((await client.status()).session.ownerVerified, true);
  await client.read(operation.id);
  assert.equal(calls.at(-1).cookie, 'sso=test-original');
});

test('a session replaced during acquisition cannot be overwritten by an older verified refresh', async () => {
  const { client, calls } = await setup();
  let started, release;
  const providerStarted = new Promise(resolve => { started = resolve; });
  const providerResult = new Promise(resolve => { release = resolve; });
  const refresh = client.renewSession({ expectedIdentity: OWNER, acquireSession: () => { started(); return providerResult; } });
  await providerStarted;
  await client.importSession(bundle('test-newer'));
  await client.verifyOwner(OWNER);
  release(bundle('test-stale-refresh'));
  await assert.rejects(refresh, { code: 'SESSION_REFRESH_CONCURRENT_CHANGE' });
  await client.read(operation.id);
  assert.equal(calls.at(-1).cookie, 'sso=test-newer');
});

test('concurrent refreshes cannot invoke two credential providers', async () => {
  const { client } = await setup();
  let started, release, providerCalls = 0;
  const providerStarted = new Promise(resolve => { started = resolve; });
  const providerResult = new Promise(resolve => { release = resolve; });
  const refresh = client.renewSession({ expectedIdentity: OWNER, acquireSession: () => { providerCalls++; started(); return providerResult; } });
  await providerStarted;
  await assert.rejects(client.renewSession({ expectedIdentity: OWNER, acquireSession: async () => { providerCalls++; return bundle('test-second'); } }), { code: 'SESSION_RENEWAL_IN_PROGRESS' });
  release(bundle('test-fresh'));
  await refresh;
  assert.equal(providerCalls, 1);
});

test('an old owner response cannot authorize a newly imported session generation', async () => {
  let pause = false, started, release;
  const responseStarted = new Promise(resolve => { started = resolve; });
  const responseResult = new Promise(resolve => { release = resolve; });
  const { client } = await setup(async () => {
    if (pause) { started(); await responseResult; }
    return new Response(JSON.stringify({ session: { email: OWNER } }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  pause = true;
  const oldOwnerRead = client.verifyOwner(OWNER);
  await responseStarted;
  await client.importSession(bundle('test-other'));
  release();
  await assert.rejects(oldOwnerRead, { code: 'SESSION_REFRESH_CONCURRENT_CHANGE' });
  assert.equal((await client.status()).session.ownerVerified, false);
});
