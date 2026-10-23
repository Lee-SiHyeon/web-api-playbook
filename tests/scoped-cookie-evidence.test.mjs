import test from 'node:test';
import assert from 'node:assert/strict';
import { ScopedSession } from '../lib/scoped-session.mjs';

const origin = 'https://service.example.test';

test('browser handoff preserves valid quoted cookie values through serialization and HTTP', async () => {
  let sent;
  const first = new ScopedSession({ allowedOrigins: [origin], cookieOrigins: [origin],
    cookies: [{ name: 'preference', value: '"SYNTHETIC:KR"', domain: 'service.example.test', path: '/' }] });
  const restored = ScopedSession.fromJSON(first.toJSON(), { fetchImpl: async (_url, init) => {
    sent = new Headers(init.headers).get('cookie'); return new Response('ok');
  } });
  await restored.request(`${origin}/read`);
  assert.equal(sent, 'preference="SYNTHETIC:KR"');
  for (const value of ['"unterminated', 'a"b', '"a;b"', '"a,b"', '"a\\b"', '"a b"', '"a\r\nb"']) {
    assert.throws(() => new ScopedSession({ allowedOrigins: [origin], cookieOrigins: [origin],
      cookies: [{ name: 'bad', value, domain: 'service.example.test', path: '/' }] }),
    { code: 'SCOPED_SESSION_COOKIES_INVALID' });
  }
});

function session(fetchImpl, extra = {}) {
  return new ScopedSession({ allowedOrigins: [origin], cookieOrigins: [origin], fetchImpl, ...extra });
}

function futureCookie(name, value, expires) {
  return { name, value, domain: 'service.example.test', path: '/', hostOnly: true, expires };
}

test('default mode prunes an expired cookie on lookup', async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const seeded = new ScopedSession({
    allowedOrigins: [origin], cookieOrigins: [origin],
    cookies: [futureCookie('EXPIRED', 'fixture', now / 1000 + 2)],
    fetchImpl: async () => new Response('ok'),
  });
  const state = seeded.toJSON();
  const restored = ScopedSession.fromJSON(state, { fetchImpl: async (_url, init) => {
    assert.equal(new Headers(init.headers).has('cookie'), false);
    return new Response('ok');
  } });
  now += 3_000;

  await restored.request(`${origin}/read`);
  assert.equal(restored.toJSON().cookieJar.cookies.some(cookie => cookie.key === 'EXPIRED'), false);
});

test('opt-in preserves expired cookie evidence across serialization while never sending it', async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const seeded = new ScopedSession({
    allowedOrigins: [origin], cookieOrigins: [origin],
    cookies: [futureCookie('AFATK', 'expired-fixture', now / 1000 + 2)],
    fetchImpl: async () => new Response('ok'),
  });
  const state = seeded.toJSON();
  now += 3_000;
  let sentCookie;
  const restored = ScopedSession.fromJSON(state, { fetchImpl: async (_url, init) => {
    sentCookie = new Headers(init.headers).get('cookie');
    return new Response('ok');
  } }).retainExpiredCookieEvidence();

  await restored.request(`${origin}/api/v1/dashboard`);
  assert.equal(sentCookie, null);
  assert.equal(restored.toJSON().cookieJar.cookies.find(cookie => cookie.key === 'AFATK')?.value, 'expired-fixture');
});

test('cookies remain limited to configured cookie origins and host scope', async () => {
  const secondOrigin = 'https://other.example.test';
  let sentCookie;
  const client = new ScopedSession({
    allowedOrigins: [origin, secondOrigin], cookieOrigins: [origin],
    cookies: [futureCookie('SCOPED', 'fixture', Date.now() / 1000 + 60)],
    fetchImpl: async (_url, init) => {
      sentCookie = new Headers(init.headers).get('cookie');
      return new Response('ok');
    },
  });
  await client.request(`${secondOrigin}/read`);
  assert.equal(sentCookie, null);
  assert.throws(() => new ScopedSession({
    allowedOrigins: [origin], cookieOrigins: [origin],
    cookies: [{ ...futureCookie('OUT', 'fixture', Date.now() / 1000 + 60), domain: 'other.test' }],
    fetchImpl: async () => new Response('ok'),
  }), { code: 'SCOPED_SESSION_COOKIE_SCOPE_INVALID' });
});

test('response cookies update the jar and expose raw evidence only through the transient callback', async () => {
  const rotated = 'rotated-secret-fixture';
  let requestHeaders;
  const client = session(async (_url, init) => {
    requestHeaders = new Headers(init.headers);
    const headers = new Headers({ 'set-cookie': `ROTATED=${rotated}; Path=/; Secure` });
    return new Response('ok', { status: 202, headers });
  });
  let receipt;
  const response = await client.request(`${origin}/api/v1/read`, {
    onCookiesApplied: event => { receipt = event; },
  });

  assert.deepEqual({ origin: receipt.origin, path: receipt.path, status: receipt.status }, {
    origin, path: '/api/v1/read', status: 202,
  });
  assert.equal(receipt.cookies[0].value, rotated);
  assert.equal(client.toJSON().cookieJar.cookies.find(cookie => cookie.key === 'ROTATED')?.value, rotated);
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(JSON.stringify(response).includes(rotated), false);
  assert.equal([...requestHeaders].some(([name, value]) => /set-cookie/i.test(name) || value.includes(rotated)), false);
  assert.equal(Object.hasOwn(client.toJSON(), 'onCookiesApplied'), false);
});

test('invalid cookie callback is rejected before HTTP', async () => {
  let requests = 0;
  const client = session(async () => { requests += 1; return new Response('unexpected'); });
  await assert.rejects(client.request(`${origin}/read`, { onCookiesApplied: 'invalid' }), {
    code: 'SCOPED_SESSION_REQUEST_INVALID',
  });
  assert.equal(requests, 0);
});

test('a successful server deletion prevents the expired AFATK from being sent again', async () => {
  const seen = [];
  const client = session(async (_url, init) => {
    seen.push(new Headers(init.headers).get('cookie'));
    if (seen.length === 1) {
      return new Response('deleted', { status: 200, headers: {
        'set-cookie': 'AFATK=; Max-Age=0; Path=/; Secure',
      } });
    }
    return new Response('ok', { status: 200 });
  }, { cookies: [futureCookie('AFATK', 'active-fixture', Date.now() / 1000 + 60)] });

  await client.request(`${origin}/api/v1/delete`, { onCookiesApplied() {} });
  await client.request(`${origin}/api/v1/next`);
  assert.match(seen[0] ?? '', /AFATK=active-fixture/);
  assert.doesNotMatch(seen[1] ?? '', /AFATK=/);
});
