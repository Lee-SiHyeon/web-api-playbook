import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SessionClient, selectCookieHeader, PROTECTED_ROOT } from '../scripts/session-client.mjs';

// Every credential and response in this file is synthetic; no external requests.
const cookie = (name, value, extra = {}) => ({ name, value, domain: '.naver.com', path: '/', secure: true, expires: -1, ...extra });
const cookies = () => [cookie('NID_AUT', 'synthetic-aut'), cookie('NID_SES', 'synthetic-session')];
const input = { operation: 'daily/cv', query: { timeDimension: 'fixture', startDate: 'fixture', exclude: '', _: 'fixture' } };
const success = () => Response.json({ statusCode: 200, result: { statDataList: [] } });
const rootHTML = '<a href="/4053103/config/bloginfo">settings</a><a href="/4053103/stat/today">statistics</a>';
const ownerHTML = '<div id="lnbMenu">블로그 관리</div><a href="/aicandoanything/config/bloginfo">settings</a>';
const html = (body = rootHTML, headers = {}) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const responseCookies = values => {
  const headers = new Headers();
  for (const value of values) headers.append('set-cookie', value);
  return { headers };
};

test('pure HTTP session has no browser dependency and is not JSON-serializable as credentials', async () => {
  const source = await readFile(new URL('../scripts/session-client.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(?:import\s*\(|from\s*)['"]playwright|connectOverCDP|chromium\.launch/);
  const session = new SessionClient({ cookies: cookies(), fetchImpl: async () => assert.fail('No network expected') });
  assert.equal(JSON.stringify(session), '{}');
  session.clear();
  assert.throws(() => session.cookieFor(PROTECTED_ROOT), { code: 'AUTH_MISSING' });
});

test('missing and expired credentials fail before transport, including expires zero', async () => {
  let calls = 0;
  for (const jar of [[], [cookie('NID_AUT', 'synthetic')], cookies().map(c => ({ ...c, expires: 0 })), cookies().map(c => ({ ...c, value: '' }))]) {
    const session = new SessionClient({ cookies: jar, fetchImpl: async () => { calls++; return success(); } });
    await assert.rejects(session.api(input), { code: 'AUTH_MISSING' });
  }
  assert.equal(calls, 0);
});

test('session validates TLS, ports, URL credentials, method and body before transport', async () => {
  let calls = 0;
  const session = new SessionClient({ cookies: cookies(), fetchImpl: async () => { calls++; return success(); } });
  for (const url of ['http://blog.naver.com/4053103', 'https://blog.naver.com:9999/4053103', 'https://blog.naver.com.invalid.test/', 'https://user@blog.naver.com/', 'https://blog.naver.com/#private']) {
    await assert.rejects(session.fetch(url), { code: 'SCOPE' });
  }
  await assert.rejects(session.fetch(PROTECTED_ROOT, { method: 'POST' }), { code: 'READ_ONLY' });
  await assert.rejects(session.fetch(PROTECTED_ROOT, { body: 'synthetic' }), { code: 'READ_ONLY' });
  await assert.rejects(session.fetch(PROTECTED_ROOT, { redirect: 'follow' }), { code: 'READ_ONLY' });
  await assert.rejects(session.fetch(PROTECTED_ROOT, { headers: { authorization: 'synthetic' } }), { code: 'INPUT' });
  await assert.rejects(session.api({ url: 'https://blog.stat.naver.com/api/blog/not-observed' }), { code: 'UNOBSERVED' });
  assert.equal(calls, 0);
});

test('browser identity headers are bounded, applied, and never replace the scoped cookie', async () => {
  const session = new SessionClient({ cookies: cookies(), defaultHeaders: {
    'user-agent': 'SyntheticBrowser/1.0', 'accept-language': 'ko-KR,ko',
    referer: 'https://blog.naver.com/4053103',
  }, fetchImpl: async (_url, init) => {
    const headers = new Headers(init.headers);
    assert.equal(headers.get('user-agent'), 'SyntheticBrowser/1.0');
    assert.equal(headers.get('accept-language'), 'ko-KR,ko');
    assert.match(headers.get('cookie'), /NID_SES=synthetic-session/);
    assert.doesNotMatch(headers.get('cookie'), /caller-cookie/);
    return success();
  } });
  await session.fetch(PROTECTED_ROOT, { headers: { cookie: 'caller-cookie=x' } });
  assert.throws(() => new SessionClient({ cookies: cookies(), defaultHeaders: { authorization: 'x' } }), { code: 'INPUT' });
  assert.throws(() => new SessionClient({ cookies: cookies(), defaultHeaders: { 'user-agent': 'x\r\ny' } }), { code: 'INPUT' });
});

test('cookie filtering rejects malformed metadata, sibling hosts and path prefix confusion', () => {
  const jar = [...cookies(), cookie('only', 'synthetic-only', { domain: 'blog.naver.com' }),
    cookie('scoped', 'synthetic-path', { path: '/4053103' }), cookie('bad', 'synthetic\r\nvalue'),
    cookie('foreign', 'synthetic', { domain: '.com' }), { name: 'incomplete', value: 'synthetic' }];
  assert.ok(selectCookieHeader(jar, PROTECTED_ROOT).startsWith('scoped=synthetic-path;'));
  assert.doesNotMatch(selectCookieHeader(jar, PROTECTED_ROOT), /only=|bad=|foreign=|incomplete=/);
  assert.doesNotMatch(selectCookieHeader(jar, 'https://blog.naver.com/40531030'), /scoped=/);
  assert.match(selectCookieHeader(jar, 'https://blog.naver.com/4053103'), /only=synthetic-only/);
});

test('Set-Cookie updates the in-memory credential used by the next independent API request', async () => {
  const sent = [];
  const session = new SessionClient({ cookies: cookies(), fetchImpl: async (url, init) => {
    sent.push(new Headers(init.headers).get('cookie'));
    assert.equal(init.redirect, 'manual'); assert.equal(init.method, 'GET');
    const response = success();
    if (sent.length === 1) response.headers.append('set-cookie', 'NID_SES=synthetic-rotated; Domain=.naver.com; Path=/; Secure');
    return response;
  } });
  await session.api(input); const result = await session.api(input);
  assert.match(sent[0], /synthetic-session/); assert.match(sent[1], /synthetic-rotated/);
  assert.doesNotMatch(JSON.stringify(result.evidence), /synthetic/);
});

test('Set-Cookie Domain and default Path cannot escape the response origin or directory', () => {
  const session = new SessionClient({ cookies: cookies() });
  session.acceptResponse(responseCookies(['foreign=x; Domain=invalid.test', 'suffix=x; Domain=com', 'sibling=x; Domain=blog.stat.naver.com', 'local=x']), 'https://admin.blog.naver.com/4053103/config');
  assert.doesNotMatch(session.cookieFor(PROTECTED_ROOT), /foreign=|suffix=|sibling=/);
  assert.match(session.cookieFor(PROTECTED_ROOT), /local=x/);
  assert.doesNotMatch(session.cookieFor('https://admin.blog.naver.com/40531030'), /local=x/);
  assert.doesNotMatch(session.cookieFor('https://blog.stat.naver.com/'), /local=x/);
});

test('Max-Age deletion overrides future Expires irrespective of attribute order', () => {
  for (const attributes of ['Max-Age=0; Expires=Tue, 01 Jan 2030 00:00:00 GMT', 'Expires=Tue, 01 Jan 2030 00:00:00 GMT; Max-Age=0']) {
    const session = new SessionClient({ cookies: cookies(), now: () => 100000 });
    session.acceptResponse(responseCookies([`NID_SES=deleted; Domain=.naver.com; Path=/; ${attributes}`]), PROTECTED_ROOT);
    assert.throws(() => session.cookieFor(PROTECTED_ROOT), { code: 'AUTH_MISSING' });
  }
});

test('cookie prefix requirements and expiry are enforced on refreshed cookies', () => {
  let now = 100000;
  const session = new SessionClient({ cookies: cookies(), now: () => now });
  session.acceptResponse(responseCookies(['__Host-bad=x; Domain=.naver.com; Path=/; Secure', '__Secure-bad=x; Path=/', 'NID_SES=synthetic-short; Domain=.naver.com; Path=/; Max-Age=1']), PROTECTED_ROOT);
  assert.doesNotMatch(session.cookieFor(PROTECTED_ROOT), /__Host-bad|__Secure-bad/);
  now += 1001;
  assert.throws(() => session.cookieFor(PROTECTED_ROOT), { code: 'AUTH_MISSING' });
});

test('protected root verifies actor-scoped HTML but rejects login and fallback documents', async () => {
  for (const [body, expected] of [[rootHTML, true], ['<html>public shell</html>', false], [rootHTML + '<form action="https://nid.naver.com/nidlogin.login"></form>', false]]) {
    const session = new SessionClient({ cookies: cookies(), fetchImpl: async () => html(body) });
    const result = await session.verifyRoot();
    assert.equal(result.verified, expected); assert.equal(result.browserUsedForHTTPRequest, false);
    assert.doesNotMatch(JSON.stringify(result), /synthetic/);
  }
});

test('protected root accepts a substantial authenticated admin shell after menu links move', async () => {
  const body = `<html><body><div id="lnbMenu">블로그 관리</div>${'x'.repeat(1500)}</body></html>`;
  const session = new SessionClient({ cookies: cookies(), fetchImpl: async () => html(body) });
  const result = await session.verifyRoot();
  assert.equal(result.verified, true);
  assert.equal(result.actorMatched, false);
  assert.equal(result.adminShell, true);
  assert.equal(result.substantialAdminDocument, true);
});

test('fresh private owner proof is reused once for persistence without another request', async () => {
  let now = 200000;
  let calls = 0;
  const session = new SessionClient({ cookies: cookies(), ownerBlogId: 'aicandoanything', now: () => now,
    persistRotation: false, fetchImpl: async () => { calls++; return html(ownerHTML); } });
  const verification = await session.verifyRoot();
  assert.equal(verification.verified, true);
  assert.equal(calls, 1);
  const saved = await session.persistVerifiedSession({ reuseFreshOwnerVerification: true });
  assert.equal(saved.stored, true);
  assert.equal(saved.verification.actor, 'aicandoanything');
  assert.equal(calls, 1);
  await session.persistVerifiedSession({ reuseFreshOwnerVerification: true });
  assert.equal(calls, 2);
});

test('owner proof is isolated from caller mutation and caller-supplied proof is ignored', async () => {
  let calls = 0;
  const session = new SessionClient({ cookies: cookies(), ownerBlogId: 'aicandoanything', persistRotation: false,
    fetchImpl: async () => { calls++; return html(ownerHTML); } });
  const first = await session.verifyRoot();
  first.actor = 'attacker'; first.verified = false;
  const persisted = await session.persistVerifiedSession({ reuseFreshOwnerVerification: true,
    verification: { verified: true, actorMatched: true, adminShell: true } });
  assert.equal(persisted.stored, true);
  assert.equal(persisted.verification.actor, 'aicandoanything');
  assert.equal(calls, 1);

  let forgedCalls = 0;
  const forged = new SessionClient({ cookies: cookies(), ownerBlogId: 'aicandoanything', persistRotation: false,
    fetchImpl: async () => { forgedCalls++; return html('<div id="lnbMenu">블로그 관리</div><a href="/other/config/bloginfo">settings</a>'); } });
  await assert.rejects(forged.persistVerifiedSession({ reuseFreshOwnerVerification: true,
    verification: { verified: true, actorMatched: true, adminShell: true } }), { code: 'AUTH_UNVERIFIED' });
  assert.equal(forgedCalls, 1);

  let privateCookieCalls = 0;
  const privateCookies = new SessionClient({ cookies: cookies(), ownerBlogId: 'aicandoanything', persistRotation: false,
    fetchImpl: async () => { privateCookieCalls++; return html(ownerHTML); } });
  privateCookies.cookieFor = () => { throw new Error('caller-controlled cookie checker'); };
  await privateCookies.verifyRoot();
  await privateCookies.persistVerifiedSession({ reuseFreshOwnerVerification: true });
  assert.equal(privateCookieCalls, 1);
});

test('owner proof snapshots the completed jar after an observed in-verification rotation', async () => {
  let ownerCalls = 0;
  const laterHeaders = [];
  const session = new SessionClient({ cookies: cookies(), ownerBlogId: 'aicandoanything', persistRotation: false,
    fetchImpl: async (url, init) => {
      if (url.startsWith('https://admin.blog.naver.com/')) {
        ownerCalls++;
        return html(ownerHTML, { 'set-cookie': 'NID_SES=synthetic-owner-rotated; Domain=.naver.com; Path=/; Secure' });
      }
      laterHeaders.push(new Headers(init.headers).get('cookie'));
      return success();
    } });
  await session.verifyRoot();
  await session.persistVerifiedSession({ reuseFreshOwnerVerification: true });
  assert.equal(ownerCalls, 1);
  await session.fetch('https://blog.naver.com/aicandoanything');
  assert.equal(laterHeaders.length, 1);
  assert.match(laterHeaders[0], /NID_SES=synthetic-owner-rotated/);
});

test('proof reuse expires locally and falls back to a new owner read', async () => {
  let now = 200000;
  let calls = 0;
  const session = new SessionClient({ cookies: cookies(), ownerBlogId: 'aicandoanything', now: () => now,
    persistRotation: false, fetchImpl: async () => { calls++; return html(ownerHTML); } });
  await session.verifyRoot();
  now += 30_001;
  const persisted = await session.persistVerifiedSession({ reuseFreshOwnerVerification: true });
  assert.equal(persisted.stored, true);
  assert.equal(calls, 2);
});

test('any later request or cookie mutation invalidates the owner proof', async () => {
  let calls = 0;
  const afterFetch = new SessionClient({ cookies: cookies(), ownerBlogId: 'aicandoanything', persistRotation: false,
    fetchImpl: async url => {
      if (url.startsWith('https://admin.blog.naver.com/')) { calls++; return html(ownerHTML); }
      return success();
    } });
  await afterFetch.verifyRoot();
  await afterFetch.fetch('https://blog.naver.com/aicandoanything');
  await afterFetch.persistVerifiedSession({ reuseFreshOwnerVerification: true });
  assert.equal(calls, 2);

  let rotatedCalls = 0;
  const afterRotation = new SessionClient({ cookies: cookies(), ownerBlogId: 'aicandoanything', persistRotation: false,
    fetchImpl: async () => { rotatedCalls++; return html(ownerHTML); } });
  await afterRotation.verifyRoot();
  afterRotation.acceptResponse(responseCookies(['NID_SES=synthetic-rotated; Domain=.naver.com; Path=/; Secure']), PROTECTED_ROOT);
  await afterRotation.persistVerifiedSession({ reuseFreshOwnerVerification: true });
  assert.equal(rotatedCalls, 2);
});

test('an earlier pending request blocks owner verification until its rotation is merged', async () => {
  const pendingResponse = deferred();
  const sent = [];
  const session = new SessionClient({ cookies: cookies(), ownerBlogId: 'aicandoanything', persistRotation: false,
    fetchImpl: async (url, init) => {
      if (url === 'https://blog.naver.com/rotate') {
        sent.push(new Headers(init.headers).get('cookie'));
        return pendingResponse.promise;
      }
      sent.push(new Headers(init.headers).get('cookie'));
      return html(ownerHTML);
    } });
  const pending = session.fetch('https://blog.naver.com/rotate');
  await assert.rejects(session.verifyRoot(), { code: 'SESSION_BUSY' });
  await assert.rejects(session.persistVerifiedSession({ reuseFreshOwnerVerification: true }), { code: 'SESSION_BUSY' });
  assert.throws(() => session.acceptResponse(responseCookies(['NID_SES=synthetic-forged; Domain=.naver.com; Path=/; Secure']), PROTECTED_ROOT),
    { code: 'SESSION_BUSY' });
  assert.throws(() => session.clear(), { code: 'SESSION_BUSY' });

  pendingResponse.resolve(new Response('rotation observed', { headers: {
    'set-cookie': 'NID_SES=synthetic-rotated; Domain=.naver.com; Path=/; Secure',
  } }));
  await pending;
  const persisted = await session.persistVerifiedSession({ reuseFreshOwnerVerification: true });
  assert.equal(persisted.stored, true);
  assert.equal(sent.length, 2);
  assert.match(sent[1], /NID_SES=synthetic-rotated/);
});

test('persistence owns the session from fresh proof mint through vault continuation', async () => {
  let nowCalls = 0;
  let attemptBetweenProofAndContinuation;
  let session;
  let ownerCalls = 0;
  const now = () => {
    nowCalls++;
    // Constructor checks both cookies first. The fifth verification-time clock
    // read is the private proof timestamp, immediately before it is stamped.
    if (nowCalls === 7) {
      queueMicrotask(() => {
        attemptBetweenProofAndContinuation = session.fetch('https://blog.naver.com/interleave')
          .then(() => 'unexpected-success', error => error.code);
      });
    }
    return 200000;
  };
  session = new SessionClient({ cookies: cookies(), ownerBlogId: 'aicandoanything', now, persistRotation: false,
    fetchImpl: async url => {
      if (url.startsWith('https://admin.blog.naver.com/')) ownerCalls++;
      return html(ownerHTML);
    } });
  const stored = await session.persistVerifiedSession();
  assert.equal(stored.stored, true);
  assert.equal(await attemptBetweenProofAndContinuation, 'SESSION_BUSY');
  assert.equal(ownerCalls, 1);

  await session.verifyRoot();
  const secondSave = session.persistVerifiedSession({ reuseFreshOwnerVerification: true });
  const requestDuringSave = session.fetch('https://blog.naver.com/during-vault-write')
    .then(() => 'unexpected-success', error => error.code);
  assert.throws(() => session.acceptResponse(responseCookies([]), PROTECTED_ROOT), { code: 'SESSION_BUSY' });
  assert.throws(() => session.clear(), { code: 'SESSION_BUSY' });
  assert.equal(await requestDuringSave, 'SESSION_BUSY');
  assert.equal((await secondSave).stored, true);
});

test('api retry backoff retains its operation token and failure releases it', async () => {
  let fetchCalls = 0;
  let retryReadyResolve;
  const retryReady = new Promise(resolve => { retryReadyResolve = resolve; });
  const session = new SessionClient({ cookies: cookies(), persistRotation: false, fetchImpl: async () => {
    fetchCalls++;
    if (fetchCalls > 1) return success();
    const body = new ReadableStream({ cancel() { retryReadyResolve(); } });
    return new Response(body, { status: 429, headers: { 'retry-after': '0.1' } });
  } });
  const pendingApi = session.api(input);
  await retryReady;
  assert.equal(fetchCalls, 1);
  await assert.rejects(session.verifyRoot(), { code: 'SESSION_BUSY' });
  await assert.rejects(session.persistVerifiedSession(), { code: 'SESSION_BUSY' });
  assert.equal((await pendingApi).evidence.attempts, 2);
  assert.equal(fetchCalls, 2);

  const failed = new SessionClient({ cookies: cookies(), fetchImpl: async () => { throw Error('synthetic-secret'); } });
  await assert.rejects(failed.fetch(PROTECTED_ROOT), { code: 'TRANSPORT' });
  await assert.rejects(failed.verifyRoot(), { code: 'TRANSPORT' });
  failed.clear();
  assert.equal(failed.status().active, false);
});

test('a failed owner validation is never cached, and default persistence always verifies again', async () => {
  let calls = 0;
  const invalid = new SessionClient({ cookies: cookies(), ownerBlogId: 'aicandoanything', persistRotation: false,
    fetchImpl: async () => { calls++; return html('<div id="lnbMenu">블로그 관리</div><a href="/other/config/bloginfo">settings</a>'); } });
  const verification = await invalid.verifyRoot();
  assert.equal(verification.actorMatched, false);
  await assert.rejects(invalid.persistVerifiedSession({ reuseFreshOwnerVerification: true }), { code: 'AUTH_UNVERIFIED' });
  assert.equal(calls, 2);

  const injected = new SessionClient({ cookies: cookies(), ownerBlogId: 'aicandoanything', persistRotation: false,
    fetchImpl: async () => { calls++; return html('<div id="lnbMenu">블로그 관리</div><a href="/other/config/bloginfo">settings</a>'); } });
  injected.verifyRoot = async () => ({ verified: true, actorMatched: true, adminShell: true });
  await assert.rejects(injected.persistVerifiedSession(), { code: 'AUTH_UNVERIFIED' });
  assert.equal(calls, 3);

  let validCalls = 0;
  const valid = new SessionClient({ cookies: cookies(), ownerBlogId: 'aicandoanything', persistRotation: false,
    fetchImpl: async () => { validCalls++; return html(ownerHTML); } });
  await valid.verifyRoot();
  await valid.persistVerifiedSession();
  assert.equal(validCalls, 2);
  await valid.persistVerifiedSession({ reuseFreshOwnerVerification: true });
  assert.equal(validCalls, 3);
});

test('proof reuse requires an intact live NID pair and clearing removes it', async () => {
  let now = 200000;
  let calls = 0;
  const nearExpiry = cookies().map(item => ({ ...item, expires: 205 }));
  const expiring = new SessionClient({ cookies: nearExpiry, ownerBlogId: 'aicandoanything', now: () => now,
    persistRotation: false, fetchImpl: async () => { calls++; return html(ownerHTML); } });
  await expiring.verifyRoot();
  now += 6_000;
  await assert.rejects(expiring.persistVerifiedSession({ reuseFreshOwnerVerification: true }), { code: 'AUTH_MISSING' });
  assert.equal(calls, 1);

  const cleared = new SessionClient({ cookies: cookies(), ownerBlogId: 'aicandoanything', persistRotation: false,
    fetchImpl: async () => { calls++; return html(ownerHTML); } });
  await cleared.verifyRoot();
  cleared.clear();
  await assert.rejects(cleared.persistVerifiedSession({ reuseFreshOwnerVerification: true }), { code: 'AUTH_MISSING' });
  assert.equal(calls, 2);
});

test('actor-scoped admin shell is not rejected by dormant embedded login markup', async () => {
  const body = `<html><body><div id="lnbMenu">블로그 관리</div>
    <a href="/4053103/config/bloginfo">settings</a>
    <template><form action="https://nid.naver.com/nidlogin.login"><input type="password"></form></template>
    ${'x'.repeat(1500)}</body></html>`;
  const session = new SessionClient({ cookies: cookies(), fetchImpl: async () => html(body) });
  const result = await session.verifyRoot();
  assert.equal(result.verified, true);
  assert.equal(result.actorMatched, true);
  assert.equal(result.adminShell, true);
  assert.equal(result.strongAdminEvidence, true);
  assert.equal(result.loginHTML, false);
});

test('redirects are not followed and deletion during root verification cannot pass', async () => {
  let calls = 0;
  const session = new SessionClient({ cookies: cookies(), fetchImpl: async () => { calls++; return new Response('', { status: 302, headers: { location: 'https://invalid.test/' } }); } });
  await assert.rejects(session.verifyRoot(), { code: 'AUTH_UNVERIFIED' }); assert.equal(calls, 1);
  const deleted = new SessionClient({ cookies: cookies(), fetchImpl: async () => html(rootHTML, { 'set-cookie': 'NID_SES=; Domain=.naver.com; Path=/; Max-Age=0' }) });
  await assert.rejects(deleted.verifyRoot(), { code: 'AUTH_MISSING' });
});

test('protected root follows only bounded redirects inside approved Blog origins', async () => {
  const calls = [];
  const session = new SessionClient({ cookies: cookies(), fetchImpl: async url => {
    calls.push(url);
    if (calls.length === 1) return new Response('', { status: 302, headers: { location: '/4053103/config/bloginfo' } });
    return html(rootHTML);
  } });
  const result = await session.verifyRoot();
  assert.equal(result.verified, true);
  assert.equal(result.redirectCount, 1);
  assert.equal(result.finalPath, 'https://admin.blog.naver.com/4053103/config/bloginfo');
  assert.equal(calls.length, 2);
});

test('transport exceptions never expose secret values', async () => {
  const session = new SessionClient({ cookies: cookies(), fetchImpl: async () => { throw Error('synthetic-secret-in-error'); } });
  await assert.rejects(session.fetch(PROTECTED_ROOT), error => error.code === 'TRANSPORT' && !error.message.includes('synthetic'));
});
