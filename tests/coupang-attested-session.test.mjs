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
  verifyCoupangBoundOwner,
} from '../lib/web-auth/coupang-attested-session.mjs';
import { createCoupangAuth } from '../lib/web-auth/coupang.mjs';

const origin = 'https://partners.coupang.com';
const identity = { email: 'owner@example.test', affiliateCode: 'fixture-affiliate' };

function cookies({ unknown = false, expirations = {} } = {}) {
  const ordinary = [...COUPANG_AUTH_COOKIE_NAMES, ...COUPANG_ROUTING_COOKIE_NAMES]
    .map((name, index) => ({ name, value: `fixture-${index}-${name}`, domain: '.coupang.com', path: '/', secure: false }));
  for (const [name, expirationDate] of Object.entries(expirations)) {
    const cookie = ordinary.find(value => value.name === name);
    if (cookie) cookie.expires = expirationDate;
  }
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
  return { auth: createCoupangAuth({ store, fetchImpl }), store, writes, directory, readStored: () => stored };
}

async function importBoundOwner(t, fetchImpl, inputCookies = cookies()) {
  const h = harness(t, fetchImpl);
  await h.auth.importAttestedSession({
    ...identity, userAgent: 'fixture-observed-agent', cookies: inputCookies, observedProof: proof(),
  });
  return h;
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

test('expired web-session evidence remains bound while health and business requests omit it', async t => {
  let now = Date.parse('2030-01-01T00:00:00.000Z');
  t.mock.method(Date, 'now', () => now);
  const webSessionExpires = (now + 60_000) / 1000;
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), method: init.method, body: init.body, headers: new Headers(init.headers) });
    return dashboardResponse();
  };
  const h = harness(t, fetchImpl);

  await h.auth.importAttestedSession({
    ...identity, userAgent: 'fixture-observed-agent',
    cookies: cookies({ expirations: { 'web-session-id': webSessionExpires } }), observedProof: proof(),
  });
  const original = JSON.parse(h.readStored());
  const cookieSnapshot = state => state.session.cookieJar.cookies
    .filter(cookie => COUPANG_AUTH_COOKIE_NAMES.includes(cookie.key))
    .sort((a, b) => a.key.localeCompare(b.key));
  assert.equal(cookieSnapshot(original).length, 13);
  assert.match(requests[0].headers.get('cookie') || '', /(?:^|;\s*)web-session-id=/);

  now += 120_000;
  assert.equal((await h.auth.health()).ownerVerified, true);
  assert.equal((await h.auth.health()).ownerVerified, true);

  const savedBeforeBusinessRequest = JSON.parse(h.readStored());
  const nativeSession = ScopedSession.fromJSON(savedBeforeBusinessRequest.session, {
    fetchImpl: createCoupangServiceFetch(fetchImpl),
  });
  const ownerCheck = await verifyCoupangBoundOwner(nativeSession, savedBeforeBusinessRequest);
  assert.equal(ownerCheck.ownerVerified, true);
  const productUrl = 'https://www.coupang.com/vp/products/1?itemId=2&vendorItemId=3';
  const businessUrl = new URL('/api/v1/url/any', origin);
  businessUrl.searchParams.set('coupangUrl', productUrl);
  const businessResponse = await nativeSession.request(businessUrl.href, {
    headers: { accept: 'application/json' },
  });
  assert.equal(businessResponse.status, 200);
  assert.equal(requests.at(-1).method, 'GET');
  assert.equal(requests.at(-1).body, undefined);
  assert.equal(new URL(requests.at(-1).url).searchParams.get('coupangUrl'), productUrl);

  const expiredRequests = requests.slice(1);
  assert.equal(expiredRequests.length, 4);
  for (const request of expiredRequests) {
    const sentCookies = request.headers.get('cookie') || '';
    assert.doesNotMatch(sentCookies, /(?:^|;\s*)web-session-id=/);
    assert.match(sentCookies, /(?:^|;\s*)AFATK=fixture-0-AFATK(?:;|$)/);
    assert.equal(request.headers.get('x-token'), 'fixture-0-AFATK');
  }

  const saved = JSON.parse(h.readStored());
  assert.deepEqual(cookieSnapshot(saved), cookieSnapshot(original));
  assert.equal(saved.ownerBinding.digest, original.ownerBinding.digest);
  assert.equal(saved.ownerBinding.hmacKey, original.ownerBinding.hmacKey);
});

test('expired AFATK is rejected before HTTP and does not overwrite protected state', async t => {
  let now = Date.parse('2030-01-01T00:00:00.000Z');
  t.mock.method(Date, 'now', () => now);
  const requests = [];
  const h = harness(t, async (url, init) => {
    requests.push({ url: String(url), headers: new Headers(init.headers) });
    return dashboardResponse();
  });
  await h.auth.importAttestedSession({
    ...identity, userAgent: 'fixture-observed-agent',
    cookies: cookies({ expirations: { AFATK: (now + 60_000) / 1000 } }), observedProof: proof(),
  });
  const before = h.readStored();
  const writesBefore = h.writes.length;
  const requestsBefore = requests.length;

  now += 120_000;
  await assert.rejects(h.auth.health(), { code: 'REAUTH_REQUIRED' });
  assert.equal(requests.length, requestsBefore);
  assert.equal(h.writes.length, writesBefore);
  assert.equal(h.readStored(), before);
});

test('dashboard revoking the same AFATK after HTTP 200 requires reauthentication without storage', async t => {
  const requests = [];
  const h = harness(t, async (url, init) => {
    requests.push({ url: String(url), headers: new Headers(init.headers) });
    if (requests.length === 2) {
      return dashboardResponse({ cookies: [
        'AFATK=fixture-0-AFATK; Domain=.coupang.com; Path=/; Max-Age=0; Secure; HttpOnly',
      ] });
    }
    return dashboardResponse();
  });
  await h.auth.importAttestedSession({
    ...identity, userAgent: 'fixture-observed-agent', cookies: cookies(), observedProof: proof(),
  });
  const before = h.readStored();
  const writesBefore = h.writes.length;

  await assert.rejects(h.auth.health(), { code: 'REAUTH_REQUIRED' });
  assert.equal(requests.length, 2);
  assert.match(requests[1].headers.get('cookie') || '', /(?:^|;\s*)AFATK=fixture-0-AFATK(?:;|$)/);
  assert.equal(requests[1].headers.get('x-token'), 'fixture-0-AFATK');
  assert.equal(h.writes.length, writesBefore);
  assert.equal(h.readStored(), before);
});

test('evidenced CT_AT and CT_JKTH rotation preserves owner identity and survives client reload', async t => {
  let requestCount = 0;
  const requests = [];
  const fetchImpl = async (url, init) => {
    requestCount += 1;
    requests.push({ url: String(url), headers: new Headers(init.headers) });
    if (requestCount === 2) return dashboardResponse({ cookies: [
      'CT_AT=rotated-ct-at-secret; Domain=.coupang.com; Path=/',
      'CT_JKTH=rotated-ct-jkth-secret; Domain=.coupang.com; Path=/',
    ] });
    return dashboardResponse();
  };
  const h = await importBoundOwner(t, fetchImpl);
  const before = JSON.parse(h.readStored());
  const result = await h.auth.health();
  const after = JSON.parse(h.readStored());

  assert.deepEqual(result.rotatedCookieNames, ['CT_AT', 'CT_JKTH']);
  assert.equal(requests[1].headers.get('x-token'), 'fixture-0-AFATK');
  assert.equal(after.email, before.email);
  assert.equal(after.affiliateCode, before.affiliateCode);
  assert.equal(after.ownerBinding.hmacKey, before.ownerBinding.hmacKey);
  assert.equal(after.ownerBinding.generationId, before.ownerBinding.generationId);
  assert.notEqual(after.ownerBinding.digest, before.ownerBinding.digest);
  const savedCookies = Object.fromEntries(after.session.cookieJar.cookies.map(cookie => [cookie.key, cookie.value]));
  assert.equal(savedCookies.CT_AT, 'rotated-ct-at-secret');
  assert.equal(savedCookies.CT_JKTH, 'rotated-ct-jkth-secret');
  assert.equal(JSON.stringify(result).includes('rotated-ct-at-secret'), false);
  assert.equal(JSON.stringify(result).includes('rotated-ct-jkth-secret'), false);
  assert.equal(JSON.stringify(result).includes(after.ownerBinding.hmacKey), false);

  const secondClient = createCoupangAuth({ store: h.store, fetchImpl });
  const reloadedResult = await secondClient.health();
  const reloaded = JSON.parse(h.readStored());
  assert.equal(reloadedResult.ownerVerified, true);
  assert.equal(reloaded.email, before.email);
  assert.equal(reloaded.affiliateCode, before.affiliateCode);
  assert.equal(reloaded.ownerBinding.hmacKey, before.ownerBinding.hmacKey);
  assert.equal(reloaded.ownerBinding.generationId, before.ownerBinding.generationId);
  assert.equal(reloaded.ownerBinding.digest, after.ownerBinding.digest);
  assert.equal(JSON.stringify(reloadedResult).includes('rotated-ct-at-secret'), false);
  assert.equal(JSON.stringify(reloadedResult).includes('rotated-ct-jkth-secret'), false);
  assert.equal(requestCount, 3);
});

test('unapproved cookie changes, missing response evidence, and invalid dashboard responses cannot persist', async t => {
  const rejectedResponses = [
    {
      name: 'CT_AT domain scope change', code: 'COUPANG_OWNER_BINDING_INVALID',
      response: () => dashboardResponse({ cookies: [
        'CT_AT=changed-ct-at; Domain=partners.coupang.com; Path=/',
      ] }),
    },
    {
      name: 'CT_AT security flag change', code: 'COUPANG_OWNER_BINDING_INVALID',
      response: () => dashboardResponse({ cookies: [
        'CT_AT=changed-ct-at; Domain=.coupang.com; Path=/; Secure',
      ] }),
    },
    {
      name: 'same-value CT_AT deletion', code: 'COUPANG_OWNER_BINDING_INVALID',
      response: () => dashboardResponse({ cookies: [
        'CT_AT=fixture-1-CT_AT; Domain=.coupang.com; Path=/; Max-Age=0',
      ] }),
    },
    {
      name: 'duplicate CT_AT response cookies', code: 'COUPANG_OWNER_BINDING_INVALID',
      response: () => dashboardResponse({ cookies: [
        'CT_AT=first-ct-at; Domain=.coupang.com; Path=/',
        'CT_AT=second-ct-at; Domain=.coupang.com; Path=/',
      ] }),
    },
    {
      name: 'AFATK owner anchor change', code: 'COUPANG_OWNER_BINDING_INVALID',
      response: () => dashboardResponse({ cookies: [
        'AFATK=changed-afatk; Domain=.coupang.com; Path=/',
      ] }),
    },
    {
      name: 'member identity cookie change', code: 'COUPANG_OWNER_BINDING_INVALID',
      response: () => dashboardResponse({ cookies: [
        'member_srl=changed-member; Domain=.coupang.com; Path=/',
      ] }),
    },
    {
      name: 'non-200 dashboard', code: 'AUTH_RESPONSE_INVALID',
      response: () => dashboardResponse({ status: 503 }),
    },
    {
      name: 'invalid dashboard schema', code: 'DASHBOARD_SCHEMA_INVALID',
      response: () => dashboardResponse({ data: { categories: [], dailyTrend: [], monthlyAggregation: {} } }),
    },
  ];

  for (const scenario of rejectedResponses) {
    await t.test(scenario.name, async st => {
      let requestCount = 0;
      const fetchImpl = async () => {
        requestCount += 1;
        return requestCount === 1 ? dashboardResponse() : scenario.response();
      };
      const h = await importBoundOwner(st, fetchImpl);
      const before = h.readStored();
      const writesBefore = h.writes.length;

      await assert.rejects(h.auth.health(), { code: scenario.code });
      assert.equal(requestCount, 2);
      assert.equal(h.writes.length, writesBefore);
      assert.equal(h.readStored(), before);
    });
  }
});

test('CT value change without the ScopedSession cookie-application receipt is rejected', async t => {
  const h = await importBoundOwner(t, async () => dashboardResponse());
  const state = JSON.parse(h.readStored());
  const before = h.readStored();
  const requests = [];
  const session = ScopedSession.fromJSON(state.session, { fetchImpl: createCoupangServiceFetch(async (url, init) => {
    requests.push({ url: String(url), headers: new Headers(init.headers) });
    return dashboardResponse({ cookies: [
      'CT_AT=unattested-ct-at; Domain=.coupang.com; Path=/',
    ] });
  }) });
  const scopedRequest = session.request.bind(session);
  session.request = (url, init) => scopedRequest(url, { ...init, onCookiesApplied: () => {} });

  await assert.rejects(verifyCoupangBoundOwner(session, state), { code: 'COUPANG_OWNER_BINDING_INVALID' });
  assert.equal(requests.length, 1);
  assert.equal(h.writes.length, 1);
  assert.equal(h.readStored(), before);
});

test('tampered serialized owner cookies fail the pre-request binding check', async t => {
  const h = await importBoundOwner(t, async () => dashboardResponse());
  const state = JSON.parse(h.readStored());
  const before = h.readStored();
  let requests = 0;
  const session = ScopedSession.fromJSON(state.session, { fetchImpl: async () => {
    requests += 1;
    return dashboardResponse();
  } });
  const originalToJSON = session.toJSON.bind(session);
  session.toJSON = () => {
    const serialized = originalToJSON();
    serialized.cookieJar.cookies.find(cookie => cookie.key === 'AFATK').value = 'tampered-afatk';
    return serialized;
  };

  await assert.rejects(verifyCoupangBoundOwner(session, state), { code: 'COUPANG_OWNER_BINDING_INVALID' });
  assert.equal(requests, 0);
  assert.equal(h.writes.length, 1);
  assert.equal(h.readStored(), before);
});

test('cookie-application evidence and cookie values stay out of public response headers', async () => {
  const rotatedValue = 'private-callback-cookie-value';
  const session = new ScopedSession({
    allowedOrigins: [origin], cookieOrigins: [origin], cookies: cookies(),
    fetchImpl: async () => dashboardResponse({ cookies: [
      `CT_AT=${rotatedValue}; Domain=.coupang.com; Path=/`,
    ] }),
  });
  let receipt;
  const response = await session.request(`${origin}/api/v1/dashboard`, {
    onCookiesApplied: event => { receipt = event; },
  });

  assert.equal(receipt.origin, origin);
  assert.equal(receipt.path, '/api/v1/dashboard');
  assert.equal(receipt.status, 200);
  assert.equal(receipt.cookies[0].value, rotatedValue);
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(response.headers['set-cookie2'], undefined);
  assert.equal(JSON.stringify(response).includes(rotatedValue), false);
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
