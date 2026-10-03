import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScopedSession } from '../lib/scoped-session.mjs';
import {
  COUPANG_AUTH_COOKIE_NAMES,
  COUPANG_ROUTING_COOKIE_NAMES,
  createCoupangServiceFetch,
} from '../lib/web-auth/coupang-attested-session.mjs';
import { createCoupangAuth } from '../lib/web-auth/coupang.mjs';

const origin = 'https://partners.coupang.com';
const identity = { email: 'owner@example.test', affiliateCode: 'fixture-affiliate' };

function cookies({ unknown = false } = {}) {
  const ordinary = [...COUPANG_AUTH_COOKIE_NAMES, ...COUPANG_ROUTING_COOKIE_NAMES]
    .map((name, index) => ({ name, value: `fixture-${index}-${name}`, domain: '.coupang.com', path: '/', secure: false }));
  if (unknown) ordinary.push(
    { name: '_abck', value: 'challenge-fixture', domain: '.coupang.com', path: '/', secure: true },
    { name: 'analytics_id', value: 'analytics-fixture', domain: '.coupang.com', path: '/', secure: false },
  );
  return ordinary;
}

function proof({ capturedAt = Date.now(), email = identity.email, affiliateCode = identity.affiliateCode,
  requestCookies = cookies().filter(cookie => COUPANG_AUTH_COOKIE_NAMES.includes(cookie.name)) } = {}) {
  return {
    version: 1,
    origin,
    path: '/api/v1/config',
    method: 'GET',
    httpStatus: 200,
    rCode: '0',
    capturedAt,
    member: { valid: true, email },
    affiliate: { affiliateCode },
    requestCookies: requestCookies.map(({ name, value }) => ({ name, value })),
  };
}

function dashboardResponse({ status = 200, data, cookies: setCookies = [] } = {}) {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const value of setCookies) headers.append('set-cookie', value);
  return new Response(JSON.stringify({ rCode: '0', data: data ?? {
    categories: [], dailyTrend: {}, monthlyAggregation: {},
  } }), { status, headers });
}

function harness(t, fetchImpl) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'coupang-attested-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const previousSession = new ScopedSession({
    allowedOrigins: [origin, 'https://login.coupang.com'],
    cookieOrigins: [origin, 'https://login.coupang.com'],
  }).toJSON();
  const previousState = JSON.stringify({ version: 1, ...identity, session: previousSession });
  let stored = previousState;
  const writes = [];
  const store = {
    directory,
    read: () => stored,
    write: (name, value) => { writes.push({ name, value }); stored = value; return { stored: true }; },
  };
  return { auth: createCoupangAuth({ store, fetchImpl }), writes, directory, readStored: () => stored };
}

test('service fetch derives x-token only from actual AFATK for partner business APIs', async () => {
  const seen = [];
  const fetch = createCoupangServiceFetch(async (url, init) => {
    seen.push({ url: String(url), headers: new Headers(init.headers) });
    return new Response('ok', { status: 200 });
  });
  const sentCookie = 'AFATK=observed-afatk; CT_AT=session-marker';
  await fetch(`${origin}/api/v1/dashboard`, { headers: { cookie: sentCookie, 'x-token': 'caller-token', 'x-de-token': 'challenge' } });
  await fetch(`${origin}/api/v1/config`, { headers: { cookie: sentCookie, 'x-token': 'caller-token' } });
  await fetch(`${origin}/api/v1/prelogin`, { headers: { cookie: sentCookie } });
  await fetch('https://login.coupang.com/api/v1/dashboard', {
    headers: { cookie: sentCookie, authorization: 'private', 'x-token': 'caller-token', 'x-csrf-token': 'challenge' },
  });
  assert.equal(seen[0].headers.get('x-token'), 'observed-afatk');
  assert.equal(seen[0].headers.get('x-de-token'), null);
  assert.equal(seen[1].headers.get('x-token'), null);
  assert.equal(seen[2].headers.get('x-token'), null);
  assert.equal(seen[3].headers.get('cookie'), null);
  assert.equal(seen[3].headers.get('authorization'), null);
  assert.equal(seen[3].headers.get('x-token'), null);
  assert.equal(seen[3].headers.get('x-csrf-token'), null);
});

test('attested import verifies the protected owner through dashboard HTTP and persists only allowlisted cookies', async t => {
  const requests = [];
  const h = harness(t, async (url, init) => {
    requests.push({ url: String(url), headers: new Headers(init.headers) });
    return dashboardResponse({ cookies: [
      '_abck=challenge-response; Domain=.coupang.com; Path=/; Secure',
      'AWSALB=rotated-routing; Domain=.coupang.com; Path=/',
      'member_srl=fixture-6-member_srl; Domain=.coupang.com; Path=/; Expires=Thu, 01 Jan 2032 00:00:00 GMT; Max-Age=7200',
      'sid=fixture-4-sid; Domain=.coupang.com; Path=/; Expires=Fri, 01 Jan 2038 00:00:00 GMT',
    ] });
  });
  const result = await h.auth.importAttestedSession({
    ...identity, userAgent: 'fixture-observed-agent', cookies: cookies({ unknown: true }), observedProof: proof(),
  });
  assert.deepEqual(result, {
    authenticated: true,
    ownerVerified: true,
    browserUsed: false,
    ownerVerificationSource: 'authorized_browser_config_session_binding',
    freshHttpIdentityRead: false,
    stored: true,
  });
  assert.deepEqual(requests.map(request => request.url), [`${origin}/api/v1/dashboard`]);
  assert.equal(requests[0].headers.get('x-token'), 'fixture-0-AFATK');
  const saved = JSON.parse(h.readStored());
  assert.equal(saved.version, 2);
  assert.equal(saved.ownerBinding.source, 'authorized_browser_config_session_binding');
  assert.equal(saved.ownerBinding.derivationVersion, 'AFATK_v1');
  assert.deepEqual(saved.session.allowedOrigins, [origin]);
  assert.deepEqual(saved.session.cookieOrigins, [origin]);
  const savedNames = saved.session.cookieJar.cookies.map(cookie => cookie.key).sort();
  assert.deepEqual(savedNames, [...COUPANG_AUTH_COOKIE_NAMES, ...COUPANG_ROUTING_COOKIE_NAMES].sort());
  assert.equal(JSON.stringify(saved).includes('challenge-fixture'), false);
  assert.equal(JSON.stringify(saved).includes('analytics-fixture'), false);
  assert.equal(JSON.stringify(saved).includes('challenge-response'), false);
  assert.equal(JSON.stringify(result).includes('hmacKey'), false);
  assert.equal(JSON.stringify(result).includes('fixture-0-AFATK'), false);
  assert.equal(h.writes.length, 1);
  const savedMember = saved.session.cookieJar.cookies.find(cookie => cookie.key === 'member_srl');
  const savedSid = saved.session.cookieJar.cookies.find(cookie => cookie.key === 'sid');
  assert.equal(savedMember.value, 'fixture-6-member_srl');
  assert.equal(savedMember.maxAge, 7200);
  assert.ok(savedSid.expires);
});

test('new protected v2 state replays through a separate client without the config or profile routes', async t => {
  const paths = [];
  const h = harness(t, async url => {
    paths.push(new URL(String(url)).pathname);
    return dashboardResponse();
  });
  await h.auth.importAttestedSession({
    ...identity, userAgent: 'fixture-observed-agent', cookies: cookies(), observedProof: proof(),
  });
  const reloaded = createCoupangAuth({ store: {
    directory: h.directory,
    read: h.readStored,
    write: (name, value) => { h.writes.push({ name, value }); },
  }, fetchImpl: async url => {
    paths.push(new URL(String(url)).pathname);
    return dashboardResponse();
  } });
  const result = await reloaded.health();
  assert.equal(result.ownerVerified, true);
  assert.equal(result.freshHttpIdentityRead, false);
  assert.deepEqual(paths, ['/api/v1/dashboard', '/api/v1/dashboard']);
});

test('stale or identity-mismatched browser proof cannot issue an HTTP request or overwrite protected state', async t => {
  const h = harness(t, async () => { throw new Error('unexpected request'); });
  const before = h.readStored();
  await assert.rejects(h.auth.importAttestedSession({
    ...identity, userAgent: 'fixture-observed-agent', cookies: cookies(),
    observedProof: proof({ capturedAt: Date.now() - 5 * 60 * 1000 - 1 }),
  }), { code: 'COUPANG_ATTESTATION_INVALID' });
  await assert.rejects(h.auth.importAttestedSession({
    ...identity, userAgent: 'fixture-observed-agent', cookies: cookies(),
    observedProof: proof({ email: 'different@example.test' }),
  }), { code: 'COUPANG_ATTESTATION_INVALID' });
  assert.equal(h.writes.length, 0);
  assert.equal(h.readStored(), before);
});

test('attested import is pinned to the pre-existing protected owner identity', async t => {
  const h = harness(t, async () => { throw new Error('unexpected request'); });
  const before = h.readStored();
  await assert.rejects(h.auth.importAttestedSession({
    email: 'different@example.test', affiliateCode: 'other-affiliate', userAgent: 'fixture-observed-agent',
    cookies: cookies(), observedProof: proof({ email: 'different@example.test', affiliateCode: 'other-affiliate' }),
  }), { code: 'OWNER_MISMATCH' });
  assert.equal(h.writes.length, 0);
  assert.equal(h.readStored(), before);
});

test('observed auth cookie mismatch and dashboard auth rotation both prevent storage', async t => {
  const h = harness(t, async () => dashboardResponse({ cookies: [
    'AFATK=rotated-auth; Domain=.coupang.com; Path=/; Secure; HttpOnly',
  ] }));
  const before = h.readStored();
  const changedProof = proof({ requestCookies: cookies().filter(cookie => COUPANG_AUTH_COOKIE_NAMES.includes(cookie.name))
    .map(cookie => cookie.name === 'AFATK' ? { ...cookie, value: 'different-afatk' } : cookie) });
  await assert.rejects(h.auth.importAttestedSession({
    ...identity, userAgent: 'fixture-observed-agent', cookies: cookies(), observedProof: changedProof,
  }), { code: 'COUPANG_ATTESTATION_INVALID' });
  await assert.rejects(h.auth.importAttestedSession({
    ...identity, userAgent: 'fixture-observed-agent', cookies: cookies(), observedProof: proof(),
  }), { code: 'COUPANG_OWNER_BINDING_INVALID' });
  assert.equal(h.writes.length, 0);
  assert.equal(h.readStored(), before);
});

test('attested import rejects anonymous dashboard JSON and preserves prior state', async t => {
  const h = harness(t, async () => dashboardResponse({ status: 401 }));
  const before = h.readStored();
  await assert.rejects(h.auth.importAttestedSession({
    ...identity, userAgent: 'fixture-observed-agent', cookies: cookies(), observedProof: proof(),
  }), { code: 'REAUTH_REQUIRED' });
  assert.equal(h.writes.length, 0);
  assert.equal(h.readStored(), before);
});

test('attested import requires the captured final auth-cookie scope to reach the exact config origin', async t => {
  const h = harness(t, async () => { throw new Error('unexpected request'); });
  const invalid = cookies().map(cookie => cookie.name === 'AFATK' ? { ...cookie, domain: '.unrelated.test' } : cookie);
  await assert.rejects(h.auth.importAttestedSession({
    ...identity, userAgent: 'fixture-observed-agent', cookies: invalid, observedProof: proof(),
  }));
  assert.equal(h.writes.length, 0);
});
