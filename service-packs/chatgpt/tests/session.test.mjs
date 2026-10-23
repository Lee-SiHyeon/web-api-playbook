import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatGPTSessionProvider, CREDENTIAL_NAME, validateSessionBundle } from '../src/session.mjs';
import { PRIMARY_ORIGIN } from '../src/contracts.mjs';

function freshBundle(overrides = {}) {
  return { version: 1, service: 'chatgpt-web', origin: PRIMARY_ORIGIN,
    capturedAt: new Date().toISOString(), cookies: [{ name: 'ordinary_session', value: 'unit-test-only',
      domain: 'chatgpt.com', path: '/', secure: true, httpOnly: true }], ...overrides };
}

test('session cookies are constrained to the ChatGPT origin, domain, and path', async () => {
  const values = new Map();
  const store = {
    credentialStoreReady: () => true,
    credentialExists: (name) => values.has(name),
    readCredential: (name) => values.get(name) || null,
    writeCredential: (name, value) => { values.set(name, value); return { stored: true }; },
  };
  const provider = new ChatGPTSessionProvider({ store });
  await provider.saveObserved(freshBundle({ cookies: [
    { name: 'root_cookie', value: 'root', domain: 'chatgpt.com', path: '/' },
    { name: 'scoped_cookie', value: 'scoped', domain: '.chatgpt.com', path: '/api' },
  ] }));
  assert.equal(values.has(CREDENTIAL_NAME), true);
  assert.equal(await provider.cookieHeaderFor('https://chatgpt.com/api/v1/read'), 'root_cookie=root; scoped_cookie=scoped');
  assert.equal(await provider.cookieHeaderFor('https://chatgpt.com/other'), 'root_cookie=root');
  await assert.rejects(provider.cookieHeaderFor('https://upload.example.test/file'), (error) => error.code === 'SESSION_ORIGIN_REJECTED');
  const status = await provider.status();
  assert.equal(status.authenticated, false);
});

test('handoff rejects stale, cross-service, malformed, and challenge cookies', () => {
  assert.throws(() => validateSessionBundle(freshBundle({ capturedAt: '2020-01-01T00:00:00.000Z' })),
    (error) => error.code === 'SESSION_HANDOFF_STALE');
  assert.throws(() => validateSessionBundle(freshBundle({ origin: 'https://openai.com' })),
    (error) => error.code === 'SESSION_BUNDLE_INVALID');
  assert.throws(() => validateSessionBundle(freshBundle({ cookies: [{ name: 'cf_clearance', value: 'x', domain: 'chatgpt.com', path: '/' }] })),
    (error) => error.code === 'SESSION_CHALLENGE_COOKIE_REJECTED');
  assert.throws(() => validateSessionBundle(freshBundle({ cookies: [{ name: 'ordinary', value: 'x', domain: '.openai.com', path: '/' }] })),
    (error) => error.code === 'SESSION_COOKIE_INVALID');
});
