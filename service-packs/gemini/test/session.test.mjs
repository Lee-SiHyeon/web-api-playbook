import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { makeCookieHeader, readLifecycleReadEnvelopeFromStdin, validateSessionBundle } from '../src/session.mjs';
import { contract, operation, rawContract, session } from './helpers.mjs';

test('projects only credential fields explicitly named by the observed contract', () => {
  const observed = contract({
    auth: { origins: ['https://gemini.google.com'], cookieNames: ['AUTH_COOKIE'], headerNames: ['x-observed-token'] },
  });
  const input = {
    ...session({ cookieNames: ['AUTH_COOKIE'], headerNames: ['x-observed-token'] }),
    password: 'never-persist-this',
    sessionId: 'private-session-id',
    ignoredCookie: 'tracking-cookie',
  };
  const safe = validateSessionBundle(input, observed);
  assert.deepEqual(Object.keys(safe).sort(), ['capturedAt', 'cookies', 'headers', 'origin', 'requestHeaders', 'service', 'version']);
  assert.equal(safe.cookies[0].name, 'AUTH_COOKIE');
  assert.equal(Object.hasOwn(safe, 'password'), false);
  assert.equal(Object.hasOwn(safe, 'sessionId'), false);
});

test('validates one-shot batch context and per-operation captured headers in memory', () => {
  const observed = contract({
    auth: { origins: ['https://gemini.google.com'], cookieNames: ['AUTH_COOKIE'], headerNames: [] },
    operations: {
      history_list: operation({
        method: 'POST', path: '/captured/history', queryKeys: ['rpcids', 'f.sid'],
        headerNames: ['content-type', 'x-observed-browser-header'],
        contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
        framing: 'batchexecute', rpcId: 'observed-rpc',
      }),
    },
  });
  const safe = validateSessionBundle({
    ...session({ cookieNames: ['AUTH_COOKIE'] }),
    requestHeaders: { history_list: { 'x-observed-browser-header': 'memory-only-header' } },
    batchContext: {
      at: 'memory-only-csrf', fSid: 'memory-only-session', buildLabel: 'build_1', locale: 'ko',
      requestType: 'c', sourcePath: '/app', requestId: '1234', historyListArgs: [28, null, [0, null, 1]],
    },
  }, observed);
  assert.equal(safe.batchContext.requestId, '1234');
  assert.equal(safe.requestHeaders.history_list['x-observed-browser-header'], 'memory-only-header');
  assert.equal(Object.hasOwn(safe, 'password'), false);
});

test('rejects session context and request headers outside captured operations', () => {
  const observed = contract({
    operations: { history_list: operation({ method: 'POST', headerNames: ['content-type'], contentType: 'application/x-www-form-urlencoded' }) },
  });
  assert.throws(() => validateSessionBundle({
    ...session(), requestHeaders: { history_list: { cookie: 'should-not-be-a-header' } },
  }, observed), { code: 'SESSION_FIELD_UNOBSERVED' });
  assert.throws(() => validateSessionBundle({ ...session(), batchContext: { at: 'a' } }, contract()), { code: 'SESSION_FIELD_UNOBSERVED' });
});

test('rejects unobserved or incomplete credential fields', () => {
  const observed = contract({
    auth: { origins: ['https://gemini.google.com'], cookieNames: ['AUTH_COOKIE'], headerNames: [] },
  });
  assert.throws(() => validateSessionBundle({
    ...session({ cookieNames: ['AUTH_COOKIE'] }),
    cookies: [{ name: 'TRACKING', value: 'value' }],
  }, observed), { code: 'SESSION_FIELD_UNOBSERVED' });
  assert.throws(() => validateSessionBundle(session(), observed), { code: 'SESSION_INCOMPLETE' });
});

test('blocks credentials from any origin other than Gemini web', () => {
  const observed = contract({
    auth: { origins: ['https://gemini.google.com'], cookieNames: ['AUTH_COOKIE'], headerNames: [] },
  });
  const safe = validateSessionBundle(session({ cookieNames: ['AUTH_COOKIE'] }), observed);
  assert.throws(() => makeCookieHeader(safe, 'https://flow.google.com/'), { code: 'CREDENTIAL_ORIGIN_BLOCKED' });
  assert.equal(makeCookieHeader(safe, 'https://gemini.google.com/'), 'AUTH_COOKIE=test-cookie-value');
});

test('rejects a Flow-scoped session even if its shape otherwise matches', () => {
  const observed = contract();
  assert.throws(() => validateSessionBundle({
    ...session(),
    origin: 'https://flow.google.com',
  }, observed), { code: 'SESSION_SCOPE_INVALID' });
  assert.equal(rawContract().origin, 'https://gemini.google.com');
});

test('reads only bounded lifecycle search and allowlisted settings inputs from stdin', async () => {
  const observed = contract({
    auth: { origins: ['https://gemini.google.com'], cookieNames: ['AUTH_COOKIE'], headerNames: [] },
    operations: {
      history_list: operation({ method: 'POST', headerNames: ['content-type'], contentType: 'application/x-www-form-urlencoded;charset=UTF-8' }),
    },
  });
  const baseSession = session({ cookieNames: ['AUTH_COOKIE'] });
  const search = await readLifecycleReadEnvelopeFromStdin(observed, {
    action: 'history-search',
    input: Readable.from([JSON.stringify({ session: baseSession, query: 'safe query' })]),
  });
  assert.equal(search.query, 'safe query');
  assert.equal(search.session.cookies.length, 1);

  const settings = await readLifecycleReadEnvelopeFromStdin(observed, {
    action: 'settings',
    input: Readable.from([JSON.stringify({ session: baseSession, preferenceKeys: ['enable_memory'] })]),
  });
  assert.deepEqual(settings.preferenceKeys, ['enable_memory']);

  await assert.rejects(readLifecycleReadEnvelopeFromStdin(observed, {
    action: 'history-search',
    input: Readable.from([JSON.stringify({ session: baseSession, query: 'x'.repeat(257) })]),
  }), { code: 'LIFECYCLE_ENVELOPE_INVALID' });
  await assert.rejects(readLifecycleReadEnvelopeFromStdin(observed, {
    action: 'settings',
    input: Readable.from([JSON.stringify({ session: baseSession, preferenceKeys: Array(8).fill('enable_memory') })]),
  }), { code: 'LIFECYCLE_ENVELOPE_INVALID' });
});
