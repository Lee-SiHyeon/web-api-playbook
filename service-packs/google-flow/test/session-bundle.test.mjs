import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFlowSessionBundle } from '../src/session-bundle.mjs';

const FLOW_ORIGIN = 'https://flow.google.com';
const PROJECT_ID = '123e4567-e89b-42d3-a456-426614174000';
const NOW_SECONDS = 1_800_000_000;
const NOW = NOW_SECONDS * 1000;
const PROJECT_PATH = `/project/${PROJECT_ID}`;

function validCookie(overrides = {}) {
  return {
    name: 'flow_cookie',
    value: 'synthetic-value',
    domain: '.google.com',
    hostOnly: false,
    path: '/',
    expires: NOW_SECONDS + 3600,
    session: false,
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    ...overrides,
  };
}

function scopedBundle(cookies, overrides = {}) {
  return {
    origin: FLOW_ORIGIN,
    projectId: PROJECT_ID,
    cookies,
    ...overrides,
  };
}

function assertCode(callback, code) {
  assert.throws(callback, error => error instanceof Error && error.message === code);
}

test('preserves 21 scoped cookies including host-only Flow cookies without a name allowlist', () => {
  const cookies = Array.from({ length: 21 }, (_, index) => {
    if (index === 0) {
      const cookie = validCookie({
        name: 'OSID', domain: 'flow.google.com', hostOnly: true, expirationDate: NOW_SECONDS + 3600,
      });
      delete cookie.expires;
      return cookie;
    }
    if (index === 1) {
      const cookie = validCookie({
        name: '__Secure-OSID', domain: 'flow.google.com', hostOnly: true, path: '/project',
        session: true, expires: -1,
      });
      return cookie;
    }
    return validCookie({ name: `flow_cookie_${index}` });
  });

  const result = validateFlowSessionBundle(scopedBundle(cookies), { now: NOW });

  assert.equal(result.origin, FLOW_ORIGIN);
  assert.equal(result.projectId, PROJECT_ID);
  assert.equal(result.cookieCount, 21);
  assert.equal(result.cookies.length, 21);
  assert.deepEqual(result.cookies[0], {
    name: 'OSID', value: 'synthetic-value', domain: 'flow.google.com', hostOnly: true,
    path: '/', secure: true, expirationDate: NOW_SECONDS + 3600, session: false,
    httpOnly: true, sameSite: 'lax',
  });
  assert.deepEqual(result.cookies[1], {
    name: '__Secure-OSID', value: 'synthetic-value', domain: 'flow.google.com', hostOnly: true,
    path: '/project', secure: true, session: true, httpOnly: true, sameSite: 'lax',
  });
});

test('preserves same-name cookies with distinct paths and domain scopes', () => {
  const result = validateFlowSessionBundle(scopedBundle([
    validCookie({ name: 'SID', domain: '.google.com', hostOnly: false, path: '/' }),
    validCookie({ name: 'SID', domain: 'flow.google.com', hostOnly: true, path: '/project' }),
  ]), { now: NOW });

  assert.deepEqual(result.cookies.map(cookie => [cookie.name, cookie.domain, cookie.hostOnly, cookie.path]), [
    ['SID', '.google.com', false, '/'],
    ['SID', 'flow.google.com', true, '/project'],
  ]);
});

test('normalizes a Chrome CDP session cookie and allows omitted sameSite metadata', () => {
  const cdpCookie = validCookie({
    name: 'OSID',
    domain: 'flow.google.com',
    hostOnly: true,
    expires: -1,
    session: true,
    sameSite: 'None',
  });
  const cdpResult = validateFlowSessionBundle(scopedBundle([cdpCookie]), { now: NOW });
  assert.deepEqual(cdpResult.cookies[0], {
    name: 'OSID', value: 'synthetic-value', domain: 'flow.google.com', hostOnly: true,
    path: '/', secure: true, session: true, httpOnly: true, sameSite: 'no_restriction',
  });

  const withoutSameSite = validCookie({
    name: '__Secure-OSID', domain: 'flow.google.com', hostOnly: true,
  });
  delete withoutSameSite.sameSite;
  const result = validateFlowSessionBundle(scopedBundle([withoutSameSite]), { now: NOW });
  assert.equal(Object.hasOwn(result.cookies[0], 'sameSite'), false);
});

test('rejects an exact duplicate cookie scope even when the domain spelling differs', () => {
  assertCode(() => validateFlowSessionBundle(scopedBundle([
    validCookie({ name: 'SID', domain: '.google.com', hostOnly: false, path: '/' }),
    validCookie({ name: 'SID', domain: 'google.com', hostOnly: false, path: '/' }),
  ]), { now: NOW }), 'FLOW_COOKIE_DUPLICATE_SCOPE');
});

test('rejects wrong origins, invalid projects, and ambiguous cookie representations', () => {
  assertCode(() => validateFlowSessionBundle(scopedBundle([validCookie()], {
    origin: 'https://accounts.google.com',
  }), { now: NOW }), 'FLOW_BOOTSTRAP_INVALID');
  assertCode(() => validateFlowSessionBundle(scopedBundle([validCookie()], {
    projectId: '../not-a-project',
  }), { now: NOW }), 'FLOW_BOOTSTRAP_INVALID');
  assertCode(() => validateFlowSessionBundle(scopedBundle([validCookie()], {
    cookieHeader: 'SID=synthetic; __Secure-1PSID=synthetic',
  }), { now: NOW }), 'FLOW_BOOTSTRAP_INVALID');
});

test('rejects cookies outside the Flow request domain or project path', () => {
  const wrongDomain = validCookie({ name: 'wrong_domain', domain: '.accounts.google.com' });
  const hostOnlyGoogle = validCookie({ name: 'host_only_google', domain: 'google.com', hostOnly: true });
  const wrongPath = validCookie({ name: 'wrong_path', path: '/private' });
  for (const cookie of [wrongDomain, hostOnlyGoogle, wrongPath]) {
    assertCode(() => validateFlowSessionBundle(scopedBundle([cookie]), { now: NOW }), 'FLOW_COOKIE_SCOPE_INVALID');
  }
});

test('rejects expired cookies and inconsistent expiry metadata', () => {
  assertCode(() => validateFlowSessionBundle(scopedBundle([
    validCookie({ expires: NOW_SECONDS - 1 }),
  ]), { now: NOW }), 'FLOW_COOKIE_EXPIRED');
  assertCode(() => validateFlowSessionBundle(scopedBundle([
    validCookie({ expirationDate: NOW_SECONDS + 1800 }),
  ]), { now: NOW }), 'FLOW_COOKIE_INVALID');
  assertCode(() => validateFlowSessionBundle(scopedBundle([
    validCookie({ session: true }),
  ]), { now: NOW }), 'FLOW_COOKIE_INVALID');
  assertCode(() => validateFlowSessionBundle(scopedBundle([
    validCookie({ expires: -2, session: true }),
  ]), { now: NOW }), 'FLOW_COOKIE_INVALID');
  assertCode(() => validateFlowSessionBundle(scopedBundle([
    validCookie({ expires: -1, session: false }),
  ]), { now: NOW }), 'FLOW_COOKIE_INVALID');
  assertCode(() => validateFlowSessionBundle(scopedBundle([
    validCookie({ expires: NOW_SECONDS + 3600, session: true }),
  ]), { now: NOW }), 'FLOW_COOKIE_INVALID');
});

test('requires a recognized Flow authentication cookie in both bundle formats', () => {
  assertCode(() => validateFlowSessionBundle(scopedBundle([
    validCookie({ name: 'ordinary_cookie' }),
  ]), { now: NOW }), 'FLOW_AUTH_COOKIE_MISSING');
  assertCode(() => validateFlowSessionBundle({
    origin: FLOW_ORIGIN,
    projectId: PROJECT_ID,
    cookieHeader: 'ordinary_cookie=one; second_cookie=two',
  }, { now: NOW }), 'FLOW_AUTH_COOKIE_MISSING');

  const hostAuth = validateFlowSessionBundle(scopedBundle([
    validCookie({ name: 'OSID', domain: 'flow.google.com', hostOnly: true }),
  ]), { now: NOW });
  assert.equal(hostAuth.cookieCount, 1);
});

test('rejects malformed cookie metadata, controls, and unsupported partition context', () => {
  assertCode(() => validateFlowSessionBundle(scopedBundle([
    validCookie({ secure: 'true' }),
  ]), { now: NOW }), 'FLOW_COOKIE_INVALID');
  assertCode(() => validateFlowSessionBundle(scopedBundle([
    validCookie({ value: 'value; injected=1' }),
  ]), { now: NOW }), 'FLOW_COOKIE_INVALID');
  assertCode(() => validateFlowSessionBundle(scopedBundle([
    validCookie({ partitionKey: { topLevelSite: 'https://example.com' } }),
  ]), { now: NOW }), 'FLOW_COOKIE_PARTITIONED_UNSUPPORTED');
  assertCode(() => validateFlowSessionBundle(scopedBundle([
    validCookie({ sameSite: 'STRICT' }),
  ]), { now: NOW }), 'FLOW_COOKIE_INVALID');
});

test('keeps the legacy flat-header handoff compatible', () => {
  const cookieHeader = 'SID=synthetic; __Secure-1PSID=synthetic-secure';
  const result = validateFlowSessionBundle({
    origin: FLOW_ORIGIN,
    projectId: PROJECT_ID.toUpperCase(),
    cookieHeader,
  }, { now: NOW });

  assert.equal(result.projectId, PROJECT_ID);
  assert.equal(result.cookieHeader, cookieHeader);
  assert.equal(result.cookieCount, 2);
  assert.equal(Object.hasOwn(result, 'cookies'), false);

  const hostCookieResult = validateFlowSessionBundle({
    origin: FLOW_ORIGIN,
    projectId: PROJECT_ID,
    cookieHeader: 'OSID=synthetic; __Secure-OSID=synthetic-secure',
  }, { now: NOW });
  assert.equal(hostCookieResult.cookieHeader, 'OSID=synthetic; __Secure-OSID=synthetic-secure');
});
