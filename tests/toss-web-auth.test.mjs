import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createTossAuth, summarizeCuration } from '../lib/web-auth/toss.mjs';
import { loginHttp } from '../lib/web-auth/toss/login-http.mjs';
import { STORE_NAME } from '../lib/web-auth/toss/client.mjs';
import * as tossClientCore from '../lib/web-auth/toss/client-core.mjs';
import { stdinJsonNoEcho } from '../lib/cli.mjs';

const ORIGIN = 'https://sharelink.toss.im';
const MEMBER = `${ORIGIN}/api-public/v3/shopping-growth/sharelink/member`;
const CURATION = `${ORIGIN}/api-public/v3/shopping/sharelink/curation-sections?surface=home&size=20`;
const owner = { publisherId: 17, userNo: 29, bizUserNo: 41 };
const bundle = (expectedOwner = owner) => ({ version: 1, service: 'toss-sharelink', allowedOrigin: ORIGIN, capturedAt: 1700000000000,
  cookies: [{ name: 'TBIZAUTH', value: 'fixture-session', domain: '.toss.im', path: '/', secure: true, httpOnly: true, expires: -1 }],
  expectedOwner: { ...expectedOwner }, readRequests: { member: { method: 'GET', url: MEMBER },
    'shopping-curation-sections': { method: 'GET', url: CURATION } } });
const curationData = () => ({ resultType: 'SUCCESS', success: { sections: [
  { items: [{ todayDeal: { startAt: '2026-10-07T00:00:00+09:00' }, taca: { productView: { isSoldOut: false } } },
    { todayDeal: null, taca: { productView: { isSoldOut: true } } }] },
  { items: [{ todayDeal: { startAt: '2026-10-06T00:00:00+09:00' }, taca: { productView: {} } }] },
] } });

class MemoryStore {
  values = new Map();
  writes = 0;
  read(name) { return this.values.get(name) ?? null; }
  write(name, value) { this.writes++; this.values.set(name, value); return { stored: true, provider: 'process-memory', persistent: false }; }
  status(name) { return { available: this.values.has(name), provider: 'process-memory', persistent: false }; }
}

function seed(store, value = bundle()) { store.values.set(STORE_NAME, JSON.stringify(value)); }
function memberResponse(value = owner, status = 200) {
  return Response.json({ resultType: 'SUCCESS', success: value }, { status });
}
function authenticatedFetch({ member = owner, curation = curationData(), reject = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url); calls.push({ method: init.method || 'GET', origin: u.origin, path: u.pathname });
    if (u.pathname.endsWith('/member')) return memberResponse(member);
    if (u.pathname.endsWith('/curation-sections')) return Response.json(curation);
    if (init.method === 'POST' && u.pathname === '/v1/sign-in') {
      return new Response(null, { status: 302, headers: { location: reject
        ? 'https://business.toss.im/account/sign-in?error=INVALID_ACCOUNT'
        : `${ORIGIN}/signup-start`, 'set-cookie': 'TBIZAUTH=fresh-session; Domain=toss.im; Path=/; Secure; HttpOnly' } });
    }
    if (u.pathname === '/account/sign-in') return new Response('sign in page', { status: 200 });
    if (u.pathname === '/signup-start') return new Response('continue', { status: 200 });
    throw new Error('unexpected fake request');
  };
  return { calls, fetchImpl };
}

test('public exports and curation summary expose counts only', () => {
  assert.equal(typeof createTossAuth, 'function');
  assert.equal(typeof loginHttp, 'function');
  assert.equal(tossClientCore.issueLinkWithDependencies, undefined);
  assert.deepEqual(summarizeCuration(curationData()), {
    sectionCount: 2, itemCount: 3, todayDealEntryCount: 2,
  });
  assert.throws(() => summarizeCuration({ success: { sections: [{ items: null }] } }), /TOSS_CURATION_SCHEMA_INVALID/);
});

test('publisherId is mandatory in a protected owner baseline', async () => {
  const store = new MemoryStore(); seed(store, bundle({ userNo: 29, bizUserNo: 41 }));
  const mock = authenticatedFetch();
  const auth = createTossAuth({ store, fetchImpl: mock.fetchImpl });
  await assert.rejects(auth.health(), /TOSS_STATE_INVALID/);
  assert.equal(mock.calls.length, 0);
});

test('status and ensure do not attempt login when no protected session exists', async () => {
  const store = new MemoryStore(); const mock = authenticatedFetch();
  const auth = createTossAuth({ store, fetchImpl: mock.fetchImpl });
  assert.equal(auth.status().available, false);
  await assert.rejects(auth.ensure(), /TOSS_REAUTH_REQUIRED/);
  assert.equal(mock.calls.length, 0);
  assert.equal(store.writes, 0);
});

test('login requires a protected owner baseline before sending credentials', async () => {
  const store = new MemoryStore(); const mock = authenticatedFetch();
  const auth = createTossAuth({ store, fetchImpl: mock.fetchImpl });
  const identity = { email: 'fixture@example.invalid', password: 'fixture-password' };
  await assert.rejects(auth.login(identity), /TOSS_LOGIN_OWNER_BASELINE_REQUIRED/);
  assert.equal(mock.calls.length, 0);
  assert.equal(identity.email, '');
  assert.equal(identity.password, '');
  assert.equal(store.writes, 0);
});

test('health checks the named owner before curation and emits only safe counts', async () => {
  const store = new MemoryStore(); seed(store); const mock = authenticatedFetch();
  const auth = createTossAuth({ store, fetchImpl: mock.fetchImpl, now: () => new Date('2026-10-07T00:00:00Z') });
  const result = await auth.health();
  assert.equal(result.authenticated, true);
  assert.equal(result.ownerMatched, true);
  assert.equal(result.sectionCount, 2);
  assert.equal(result.itemCount, 3);
  assert.equal(result.todayDealEntryCount, 2);
  assert.equal('publisherId' in result, false);
  assert.equal('email' in result, false);
  assert.equal('inStockCount' in result, false);
  assert.equal('soldOutCount' in result, false);
  assert.deepEqual(mock.calls.map(({ path }) => path), [
    '/api-public/v3/shopping-growth/sharelink/member', '/api-public/v3/shopping/sharelink/curation-sections',
  ]);
});

test('member health compares optional owner fields only when the baseline saved them', async () => {
  const publisherOnlyStore = new MemoryStore(); seed(publisherOnlyStore, bundle({ publisherId: 17 }));
  const publisherOnlyMock = authenticatedFetch();
  const publisherOnlyAuth = createTossAuth({ store: publisherOnlyStore, fetchImpl: publisherOnlyMock.fetchImpl });
  const accepted = await publisherOnlyAuth.health();
  assert.equal(accepted.ownerMatched, true);
  assert.equal(accepted.sectionCount, 2);

  const savedOptionalStore = new MemoryStore(); seed(savedOptionalStore, bundle({ publisherId: 17, userNo: 29 }));
  const original = savedOptionalStore.read(STORE_NAME);
  const savedOptionalMock = authenticatedFetch({ member: { publisherId: 17 } });
  const savedOptionalAuth = createTossAuth({ store: savedOptionalStore, fetchImpl: savedOptionalMock.fetchImpl });
  await assert.rejects(savedOptionalAuth.health(), /TOSS_OWNER_MISMATCH/);
  assert.equal(savedOptionalMock.calls.length, 1);
  assert.equal(savedOptionalStore.read(STORE_NAME), original);
  assert.equal(savedOptionalStore.writes, 0);
});

test('wrong owner blocks curation and preserves protected state', async () => {
  const store = new MemoryStore(); seed(store); const original = store.read(STORE_NAME); const mock = authenticatedFetch({ member: { ...owner, userNo: 999 } });
  const auth = createTossAuth({ store, fetchImpl: mock.fetchImpl });
  await assert.rejects(auth.health(), /TOSS_OWNER_MISMATCH/);
  assert.equal(mock.calls.length, 1);
  assert.equal(store.read(STORE_NAME), original);
  assert.equal(store.writes, 0);
});

test('ensure is health-only after a rejected member read and never resends login', async () => {
  const store = new MemoryStore(); seed(store);
  const calls = [];
  const auth = createTossAuth({ store, fetchImpl: async (url, init = {}) => {
    calls.push({ method: init.method || 'GET', path: new URL(url).pathname });
    return new Response(null, { status: 401 });
  } });
  await assert.rejects(auth.ensure(), /TOSS_REAUTH_REQUIRED/);
  assert.deepEqual(calls, [{ method: 'GET', path: '/api-public/v3/shopping-growth/sharelink/member' }]);
  assert.equal(store.writes, 0);
});

test('one successful login verifies same owner, stores only session material and reads curation', async () => {
  const store = new MemoryStore(); seed(store); const mock = authenticatedFetch();
  const auth = createTossAuth({ store, fetchImpl: mock.fetchImpl }); const identity = { email: 'fixture@example.invalid', password: 'fixture-password' };
  const result = await auth.login(identity);
  assert.equal(result.authenticated, true);
  assert.equal(result.ownerMatched, true);
  assert.equal(result.loginPostCount, 1);
  assert.equal(result.sectionCount, 2);
  assert.equal(result.itemCount, 3);
  assert.equal(result.passwordPersisted, false);
  assert.equal(identity.password, '');
  assert.equal(mock.calls.filter(call => call.method === 'POST').length, 1);
  const stored = JSON.parse(store.read(STORE_NAME));
  assert.deepEqual(stored.expectedOwner, owner);
  assert.equal('password' in stored, false);
  assert.equal(stored.cookies[0].value, 'fresh-session');
  assert.equal(JSON.stringify(result).includes('fixture-session'), false);
  assert.equal(JSON.stringify(result).includes('fixture-password'), false);
});

test('login accepts a publisher-only baseline and still rejects a missing saved optional owner field', async () => {
  const publisherOnlyStore = new MemoryStore(); seed(publisherOnlyStore, bundle({ publisherId: 17 }));
  const publisherOnlyMock = authenticatedFetch();
  const publisherOnlyAuth = createTossAuth({ store: publisherOnlyStore, fetchImpl: publisherOnlyMock.fetchImpl });
  const accepted = await publisherOnlyAuth.login({ email: 'fixture@example.invalid', password: 'fixture-password' });
  assert.equal(accepted.authenticated, true);
  assert.equal(accepted.loginPostCount, 1);
  assert.equal(publisherOnlyMock.calls.filter(call => call.method === 'POST').length, 1);

  const savedOptionalStore = new MemoryStore(); seed(savedOptionalStore, bundle({ publisherId: 17, userNo: 29 }));
  const original = savedOptionalStore.read(STORE_NAME);
  const savedOptionalMock = authenticatedFetch({ member: { publisherId: 17 } });
  const savedOptionalAuth = createTossAuth({ store: savedOptionalStore, fetchImpl: savedOptionalMock.fetchImpl });
  await assert.rejects(savedOptionalAuth.login({ email: 'fixture@example.invalid', password: 'fixture-password' }), /TOSS_OWNER_MISMATCH/);
  assert.equal(savedOptionalMock.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(savedOptionalStore.read(STORE_NAME), original);
  assert.equal(savedOptionalStore.writes, 0);
});

test('wrong owner after sign-in never overwrites the protected baseline', async () => {
  const store = new MemoryStore(); seed(store); const original = store.read(STORE_NAME);
  const mock = authenticatedFetch({ member: { ...owner, publisherId: 101 } });
  const auth = createTossAuth({ store, fetchImpl: mock.fetchImpl });
  await assert.rejects(auth.login({ email: 'fixture@example.invalid', password: 'fixture-password' }), /TOSS_OWNER_MISMATCH/);
  assert.equal(mock.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(store.read(STORE_NAME), original);
  assert.equal(store.writes, 0);
});

test('known login rejection returns a bounded error after one POST and does not persist', async () => {
  const store = new MemoryStore(); seed(store); const original = store.read(STORE_NAME); const mock = authenticatedFetch({ reject: true });
  const auth = createTossAuth({ store, fetchImpl: mock.fetchImpl });
  await assert.rejects(auth.login({ email: 'fixture@example.invalid', password: 'fixture-password' }), error => {
    assert.equal(error.code, 'TOSS_LOGIN_REJECTED');
    assert.equal(error.receipt.providerErrorCode, 'INVALID_ACCOUNT');
    return true;
  });
  assert.equal(mock.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(store.read(STORE_NAME), original);
  assert.equal(store.writes, 0);
});

test('login never forwards a password across an observed-origin boundary', async () => {
  const store = new MemoryStore(); seed(store); const calls = [];
  const auth = createTossAuth({ store, fetchImpl: async (url, init = {}) => {
    calls.push({ origin: new URL(url).origin, method: init.method || 'GET' });
    if (init.method === 'POST') return new Response(null, { status: 302, headers: { location: 'https://untrusted.example/continue' } });
    return new Response('page');
  } });
  await assert.rejects(auth.login({ email: 'fixture@example.invalid', password: 'fixture-password' }), /TOSS_LOGIN_ORIGIN_REJECTED/);
  assert.equal(calls.length, 2);
  assert.equal(calls.some(call => call.origin === 'https://untrusted.example'), false);
});

test('direct login validates the stored member contract before any fetch or persistence', async () => {
  const cases = [
    ['wrong member path', value => { value.readRequests.member.url = `${ORIGIN}/api-public/v3/shopping/sharelink/not-member`; }, 'TOSS_OWNER_REQUEST_INVALID'],
    ['wrong origin', value => { value.readRequests.member.url = 'https://untrusted.example/api-public/v3/shopping-growth/sharelink/member'; }, 'TOSS_REQUEST_SCOPE_REJECTED'],
    ['non-GET member method', value => { value.readRequests.member.method = 'POST'; }, 'TOSS_OPERATION_REJECTED'],
    ['missing required publisherId', value => { value.expectedOwner = { userNo: 29 }; }, 'TOSS_STATE_INVALID'],
  ];
  for (const [label, corrupt, expectedCode] of cases) {
    const saved = bundle();
    corrupt(saved);
    let fetchCalls = 0;
    let postCalls = 0;
    let writes = 0;
    await assert.rejects(loginHttp({ email: 'fixture@example.invalid', password: 'fixture-password' }, {
      loadBaseline: () => saved,
      fetchImpl: async (_url, init = {}) => {
        fetchCalls++;
        if (init.method === 'POST') postCalls++;
        throw new Error('must not fetch');
      },
      persistSession: () => { writes++; return { stored: true }; },
    }), error => {
      assert.equal(error.code, expectedCode, label);
      return true;
    });
    assert.equal(fetchCalls, 0, label);
    assert.equal(postCalls, 0, label);
    assert.equal(writes, 0, label);
  }
});

test('hidden stdin helper reads TTY JSON without echo and restores terminal mode', async () => {
  const input = new EventEmitter(); input.isTTY = true; input.modes = [];
  input.setRawMode = value => input.modes.push(value); input.resume = () => {}; input.pause = () => {};
  const pending = stdinJsonNoEcho(4096, { input, timeoutMs: 5000, prompt: '' });
  input.emit('data', Buffer.from('{"email":"fixture@example.invalid","password":"secret-value"}\r'));
  const result = await pending;
  assert.equal(result.email, 'fixture@example.invalid');
  assert.equal(result.password, 'secret-value');
  assert.deepEqual(input.modes, [true, false]);
});

test('hidden stdin helper reads bounded piped JSON and clears input buffers', async () => {
  const input = new PassThrough();
  const pending = stdinJsonNoEcho(4096, { input, timeoutMs: 5000, prompt: '' });
  input.end(Buffer.from('{"email":"fixture@example.invalid","password":"secret-value"}'));
  const result = await pending;
  assert.equal(result.email, 'fixture@example.invalid');
  assert.equal(result.password, 'secret-value');
});

test('hidden stdin cancellation preserves an existing raw terminal mode', async () => {
  const input = new EventEmitter(); input.isTTY = true; input.isRaw = true; input.modes = [];
  input.setRawMode = value => input.modes.push(value); input.resume = () => {}; input.pause = () => {};
  const pending = stdinJsonNoEcho(4096, { input, timeoutMs: 5000, prompt: '' });
  input.emit('data', Buffer.from([0x03]));
  await assert.rejects(pending, { code: 'INPUT_CANCELLED' });
  assert.deepEqual(input.modes, [true, true]);
  assert.equal(input.listenerCount('data'), 0);
  assert.equal(input.listenerCount('end'), 0);
});
