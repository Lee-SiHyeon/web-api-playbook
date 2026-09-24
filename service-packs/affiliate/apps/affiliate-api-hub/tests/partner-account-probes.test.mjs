import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ACCOUNT_OPERATIONS, PartnerProbeError, brandconnectCookieHeader,
  probeMyrealtripAccount, probeBrandconnectAccount, probePartnerEnvelope } from '../adapters/partner-account-probes.mjs';
import { runPartnerProbe } from '../tools/discovery/partner-session-handoff.mjs';

const now = Date.now();
const cookies = () => ['NID_AUT', 'NID_SES'].map(name => ({ name, value: 'synthetic-value', domain: '.naver.com', path: '/', expires: -1 }));
const mrt = { token: 'synthetic-token', expectedPartnerId: 123, expectedEmail: 'fixture@example.com' };
const bc = () => ({ cookies: cookies(), expectedLoginId: 'fixture' });
const json = (body, options = {}) => Response.json(body, options);
const mrtBody = () => ({ data: { id: 123, email: 'fixture@example.com', sensitiveExtra: 'synthetic-private-record' }, result: { status: 200 } });
const bcBody = () => ({ loginId: 'fixture', accountId: null, partner: false, creator: false, groupAccount: false });
const fails = code => error => error instanceof PartnerProbeError && error.code === code;
const envelope = services => ({ schemaVersion: 1, acquiredAt: new Date(now).toISOString(), services });

test('MRT sends only the observed token header to its account endpoint and returns no account record', async () => {
  const result = await probeMyrealtripAccount(mrt, { fetchImpl: async (url, options) => {
    assert.equal(url, ACCOUNT_OPERATIONS.myrealtrip.origin + ACCOUNT_OPERATIONS.myrealtrip.path);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.deepEqual(options.headers, { accept: 'application/json', 'partner-access-token': mrt.token });
    return json(mrtBody());
  } });
  assert.equal(result.identityVerified, true);
  assert.doesNotMatch(JSON.stringify(result), /synthetic|fixture@example|sensitiveExtra/);
});

test('Naver cookies obey exact domain/path/expiry scope and unrelated cookies are excluded', () => {
  const input = [...cookies(), { name: 'OTHER', value: 'private-unrelated' },
    { ...cookies()[0], domain: '.naver.com.attacker.example', value: 'wrong-host' },
    { ...cookies()[0], path: '/brand-connect/query/me-other', value: 'wrong-path' },
    { ...cookies()[0], expires: now / 1000 - 1, value: 'expired' }];
  assert.equal(brandconnectCookieHeader(input, now), 'NID_AUT=synthetic-value; NID_SES=synthetic-value');
  assert.throws(() => brandconnectCookieHeader([{ ...cookies()[0], expires: now / 1000 - 1 }, cookies()[1]], now), fails('AUTH_MISSING'));
  assert.throws(() => brandconnectCookieHeader(cookies().map(cookie => ({ ...cookie, domain: 'naver.com' })), now), fails('AUTH_MISSING'));
});

test('duplicate credentials and header injection fail before sending a request', async () => {
  assert.throws(() => brandconnectCookieHeader([...cookies(), cookies()[0]], now), fails('COOKIE_AMBIGUOUS'));
  assert.throws(() => brandconnectCookieHeader([{ ...cookies()[0], value: 'x;OTHER=secret' }, cookies()[1]], now), fails('COOKIE_VALUE'));
  assert.throws(() => brandconnectCookieHeader([{ ...cookies()[0], value: 'x\r\nx:y' }, cookies()[1]], now), fails('COOKIE_VALUE'));
  await assert.rejects(probeMyrealtripAccount({ ...mrt, token: 'x\r\ny' }, { fetchImpl: () => assert.fail() }), fails('AUTH_MISSING'));
});

test('HTTP 200 anonymous identity is not authentication; a login need not have partner entitlement', async () => {
  await assert.rejects(probeBrandconnectAccount(bc(), { fetchImpl: async () => json({ ...bcBody(), loginId: null }) }), fails('REAUTH_REQUIRED'));
  const result = await probeBrandconnectAccount(bc(), { fetchImpl: async (url, options) => {
    assert.equal(url, ACCOUNT_OPERATIONS.brandconnect.origin + ACCOUNT_OPERATIONS.brandconnect.path);
    assert.deepEqual(Object.keys(options.headers).sort(), ['accept', 'cookie']);
    return json(bcBody());
  } });
  assert.equal(result.authenticated, true);
  assert.deepEqual(result.entitlement, { partner: false, creator: false, accountAssigned: false });
  assert.doesNotMatch(JSON.stringify(result), /fixture|synthetic-value/);
});

test('wrong account and service-level failure are rejected independently of HTTP 200', async () => {
  await assert.rejects(probeMyrealtripAccount(mrt, { fetchImpl: async () => json({ ...mrtBody(), data: { id: 456, email: mrt.expectedEmail } }) }), fails('ACCOUNT_MISMATCH'));
  await assert.rejects(probeBrandconnectAccount(bc(), { fetchImpl: async () => json({ ...bcBody(), loginId: 'someone-else' }) }), fails('ACCOUNT_MISMATCH'));
  await assert.rejects(probeMyrealtripAccount(mrt, { fetchImpl: async () => json({ result: { status: 401 }, data: null }) }), fails('REAUTH_REQUIRED'));
  await assert.rejects(probeMyrealtripAccount(mrt, { fetchImpl: async () => json({ result: { status: 503 }, data: null }) }), fails('SERVICE_STATUS'));
});

test('redirects, login HTML, forbidden responses and unexpected schemas stay failures', async () => {
  const responses = [
    [() => new Response(null, { status: 302, headers: { location: 'https://attacker.example/' } }), 'REDIRECT'],
    [() => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }), 'MIME'],
    [() => new Response(null, { status: 403 }), 'FORBIDDEN'],
    [() => json({ data: {}, result: { status: 200 } }), 'SCHEMA'],
    [() => new Response('{', { headers: { 'content-type': 'application/json' } }), 'JSON'],
  ];
  for (const [response, code] of responses) {
    let calls = 0;
    await assert.rejects(probeMyrealtripAccount(mrt, { fetchImpl: async () => { calls++; return response(); } }), fails(code));
    assert.equal(calls, 1);
  }
});

test('stream size is enforced without a content-length header; transport errors redact raw detail', async () => {
  await assert.rejects(probeMyrealtripAccount(mrt, { fetchImpl: async () => new Response(' '.repeat(1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } }) }), fails('SIZE'));
  const result = await probePartnerEnvelope(envelope({ myrealtrip: mrt }), { now: () => now, fetchImpl: async () => { throw new Error('synthetic-token private-account'); } });
  assert.equal(result.services.myrealtrip.code, 'TRANSPORT');
  assert.doesNotMatch(JSON.stringify(result), /synthetic-token|private-account/);
});

test('freshness and operation allowlist are checked before HTTP; per-site results stay separate', async () => {
  await assert.rejects(probePartnerEnvelope({ ...envelope({ myrealtrip: mrt }), acquiredAt: new Date(now - 300001).toISOString() }, { now: () => now, fetchImpl: () => assert.fail() }), fails('HANDOFF_EXPIRED'));
  await assert.rejects(probePartnerEnvelope(envelope({ settlementWrite: {} }), { now: () => now }), fails('SCOPE'));
  const result = await probePartnerEnvelope(envelope({ myrealtrip: mrt, brandconnect: bc() }), { now: () => now,
    fetchImpl: async url => url.includes('myrealtrip.com') ? json(mrtBody()) : json({ ...bcBody(), loginId: null }) });
  assert.equal(result.ok, false);
  assert.equal(result.services.myrealtrip.ok, true);
  assert.equal(result.services.brandconnect.ok, false);
});

test('the actual stdin child rejects an expired envelope without returning its secrets', async () => {
  const result = await runPartnerProbe({ ...envelope({ myrealtrip: mrt }), acquiredAt: '2000-01-01T00:00:00.000Z' });
  assert.deepEqual(result, { ok: false, code: 'HANDOFF_EXPIRED' });
});

function fakeChild(output, inspect = () => {}) {
  return (executable, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdin = new EventEmitter();
    child.kill = () => queueMicrotask(() => child.emit('close', null));
    child.stdin.end = input => {
      inspect({ executable, args, options, input });
      queueMicrotask(() => { child.stdout.emit('data', Buffer.from(output)); child.emit('close', 0); });
    };
    return child;
  };
}

test('handoff gives the child stdin credentials and excludes unrelated environment values', async () => {
  const input = envelope({ myrealtrip: mrt });
  const result = await runPartnerProbe(input, {
    nodeExecutable: '/fixture/node', environment: { SystemRoot: 'fixture-root', UNRELATED_SECRET: 'synthetic-private' },
    spawnImpl: fakeChild('{"ok":true}', ({ executable, args, options, input: stdin }) => {
      assert.equal(executable, '/fixture/node');
      assert.deepEqual(JSON.parse(stdin), input);
      assert.deepEqual(options.env, { SystemRoot: 'fixture-root' });
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      assert.doesNotMatch(JSON.stringify(args), /synthetic-token|fixture@example/);
    }),
  });
  assert.equal(result.ok, true);
});

test('a faulty child cannot return an echoed credential or unbounded output', async () => {
  await assert.rejects(runPartnerProbe(envelope({ myrealtrip: mrt }), {
    spawnImpl: fakeChild(JSON.stringify({ ok: true, accidental: mrt.token })),
  }), fails('RUNNER_OUTPUT_REDACTED'));
  await assert.rejects(runPartnerProbe(envelope({ myrealtrip: mrt }), {
    spawnImpl: fakeChild('x'.repeat(65537)),
  }), fails('RUNNER_OUTPUT_SIZE'));
});
