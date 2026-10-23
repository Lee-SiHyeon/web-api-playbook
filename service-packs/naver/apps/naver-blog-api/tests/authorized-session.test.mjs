import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizedSession } from '../tools/discovery/authorized-session.mjs';
import { loadNaverCookies } from '../scripts/session-vault.mjs';
import { resetTestCredentialStore } from '../scripts/secure-credential-store.mjs';

test.beforeEach(resetTestCredentialStore);

const synthetic = 'NID_AUT=synthetic-aut; NID_SES=synthetic-session';
const failsWith = code => error => error.code === code;
const cookie = (name, value, domain = '.naver.com', path = '/', expires = -1) => ({ name, value, domain, path, expires, secure: true });
function fakeChrome({ cookies = [cookie('NID_AUT', 'a'), cookie('NID_SES', 's')], contexts = 1, disconnectError = false } = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      env: { LOCALAPPDATA: 'C:/synthetic/AppData/Local' }, now: () => 200000,
      readText: async () => '9222\n/devtools/browser/00000000-0000-0000-0000-000000000001',
      connect: async (_endpoint, options) => {
        calls.push({ action: 'connect', options });
        return {
          contexts: () => Array.from({ length: contexts }, () => ({
            pages: () => [{ url: () => 'https://blog.naver.com/4053103' }],
            cookies: async origins => { calls.push({ action: 'cookies', origins }); return cookies; },
          })),
          close: async () => { calls.push({ action: 'disconnect' }); if (disconnectError) throw Error('synthetic secret'); },
        };
      },
    },
  };
}

test('session environment path never reads a profile or imports a browser; clearing invalidates it', async () => {
  const forbidden = () => { assert.fail('Browser or file access was not requested'); };
  const session = await authorizedSession({}, { env: { NAVER_COOKIE: synthetic }, connect: forbidden, readText: forbidden });
  assert.equal(session.provider, 'runtime_environment');
  assert.equal(session.cookieFor('https://blog.naver.com/4053103'), synthetic);
  assert.ok(!JSON.stringify(session).includes('synthetic-session'));
  const saved = await loadNaverCookies({ env: {} });
  assert.equal(saved.provider, null);
  assert.equal(saved.persisted, false);
  session.clear();
  assert.throws(() => session.cookieFor('https://blog.naver.com/4053103'), failsWith('AUTH_MISSING'));
});

test('session fails before browser access without explicit handoff or valid input', async () => {
  await assert.rejects(authorizedSession({}, { env: {} }), failsWith('AUTH_MISSING'));
  await assert.rejects(authorizedSession({ timeoutMs: 0 }, { env: {} }), failsWith('INPUT'));
  await assert.rejects(authorizedSession({}, { env: { NAVER_COOKIE: 'NID_AUT=a\r\nInjected: x' } }), failsWith('INPUT'));
  await assert.rejects(authorizedSession({}, { env: { NAVER_COOKIE: 'unrelated=a' } }), failsWith('AUTH_MISSING'));
});

test('session never forwards credentials to other hosts, HTTP, ports or URL userinfo', async () => {
  const session = await authorizedSession({}, { env: { NAVER_COOKIE: synthetic } });
  for (const url of ['https://ssl.pstatic.net/a.js', 'http://blog.naver.com/', 'https://blog.naver.com:8443/', 'https://blog.naver.com.evil.invalid/', 'https://user@blog.naver.com/', 'not a URL']) {
    assert.throws(() => session.cookieFor(url), failsWith('SCOPE'));
  }
  session.clear();
});

test('Chrome handoff reuses a single context, avoids defaults and disconnects before HTTP', async () => {
  const fake = fakeChrome();
  const session = await authorizedSession({ fromChrome: true }, fake.deps);
  assert.deepEqual(fake.calls.map(c => c.action), ['connect', 'cookies', 'disconnect']);
  assert.equal(fake.calls[0].options.noDefaults, true);
  assert.equal(session.cookieFor('https://blog.naver.com/4053103'), 'NID_AUT=a; NID_SES=s');
  session.clear();
});

test('Chrome cookie scope preserves host-only, path boundaries and expiry', async () => {
  const fake = fakeChrome({ cookies: [
    cookie('NID_AUT', 'a'), cookie('NID_SES', 's'),
    cookie('expired', 'x', '.naver.com', '/', 100),
    cookie('hostOnly', 'h', 'blog.naver.com'),
    cookie('restricted', 'p', '.naver.com', '/4053103'),
    cookie('foreign', 'f', '.invalid.test'),
  ] });
  const session = await authorizedSession({ fromChrome: true }, fake.deps);
  assert.ok(session.cookieFor('https://blog.naver.com/4053103/post').startsWith('restricted=p;'));
  assert.ok(!session.cookieFor('https://blog.naver.com/40531030').includes('restricted'));
  assert.ok(!session.cookieFor('https://admin.blog.naver.com/4053103').includes('hostOnly'));
  assert.ok(!session.cookieFor('https://blog.naver.com/4053103').includes('expired'));
  assert.ok(!session.cookieFor('https://blog.naver.com/4053103').includes('foreign'));
  session.clear();
});

test('ambiguous browser accounts and missing cookies always disconnect without exporting credentials', async () => {
  for (const options of [{ contexts: 0 }, { contexts: 2 }, { cookies: [] }]) {
    const fake = fakeChrome(options);
    await assert.rejects(authorizedSession({ fromChrome: true }, fake.deps));
    assert.equal(fake.calls.at(-1).action, 'disconnect');
  }
  const fake = fakeChrome({ disconnectError: true });
  await assert.rejects(authorizedSession({ fromChrome: true }, fake.deps), failsWith('CDP_DISCONNECT'));
});

test('a different debug endpoint is not tried and transport exceptions are sanitized', async () => {
  const fake = fakeChrome();
  await assert.rejects(authorizedSession({ fromChrome: true }, { ...fake.deps, readText: async () => '9333\n/devtools/browser/other' }), failsWith('CDP_SCOPE'));
  assert.equal(fake.calls.length, 0);
  await assert.rejects(authorizedSession({ fromChrome: true }, { ...fake.deps, connect: async () => { throw Error('Timeout ws://127.0.0.1:9222/private-secret'); } }), error => {
    assert.equal(error.details.failureKind, 'connection_timeout');
    assert.ok(!JSON.stringify(error).includes('private-secret'));
    return error.code === 'CDP_UNAVAILABLE';
  });
});
