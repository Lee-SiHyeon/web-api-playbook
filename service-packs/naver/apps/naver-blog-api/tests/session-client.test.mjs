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
const html = (body = rootHTML, headers = {}) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
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
