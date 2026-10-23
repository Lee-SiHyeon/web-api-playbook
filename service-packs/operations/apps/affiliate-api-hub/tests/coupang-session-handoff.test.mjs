import test from 'node:test';
import assert from 'node:assert/strict';
import { persistVerifiedCoupangHandoff, COUPANG_HANDOFF_MAX_AGE_MS } from '../adapters/coupang-session-handoff.mjs';

const now = 1_800_000_000_000;
const prior = { version: 1, email: 'owner@example.test', affiliateCode: 'affiliate-fixture', session: { secret: 'must-not-escape' } };
const bundle = (overrides = {}) => ({
  version: 1,
  sourceOrigin: 'https://partners.coupang.com',
  capturedAt: now,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0 Safari/537.36',
  cookies: [
    { name: 'AFATK', value: 'auth-fixture', domain: '.coupang.com', path: '/', secure: false, httpOnly: false, expires: now / 1000 + 3600 },
    { name: 'AWSALBCORS', value: 'route-fixture', domain: 'partners.coupang.com', path: '/', secure: false, httpOnly: true, expires: -1 },
  ],
  headers: { accept: 'application/json', lang: 'ko', 'x-untrusted': 'drop-me' },
  ...overrides,
});
const proof = (overrides = {}) => ({
  version: 1,
  origin: 'https://partners.coupang.com',
  path: '/api/v1/config',
  method: 'GET',
  httpStatus: 200,
  rCode: '0',
  capturedAt: now,
  member: { valid: true, email: prior.email },
  affiliate: { affiliateCode: prior.affiliateCode },
  requestCookies: [{ name: 'AFATK', value: 'auth-fixture' }],
  ...overrides,
});

function injected({
  priorState = prior,
  importResult = { stored: true, authenticated: true, ownerVerified: true, browserUsed: false },
  importAttestedResult = {
    stored: true, authenticated: true, ownerVerified: true, browserUsed: false,
    ownerVerificationSource: 'authorized_browser_config_session_binding', freshHttpIdentityRead: false,
  },
  importError,
} = {}) {
  const calls = { readPriorState: 0, createAuth: 0, importSession: [], importAttestedSession: [] };
  const deps = {
    now: () => now,
    async readPriorState() { calls.readPriorState++; return priorState; },
    async createAuth() {
      calls.createAuth++;
      return { async importSession(input) {
        calls.importSession.push(input);
        if (importError) throw importError;
        return importResult;
      }, async importAttestedSession(input) {
        calls.importAttestedSession.push(input);
        if (importError) throw importError;
        return importAttestedResult;
      } };
    },
  };
  return { calls, deps };
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, error => error?.code === code && error.message === code);
}

test('imports only fresh scoped auth cookies and returns a secret-free owner-verified receipt', async () => {
  const h = injected();
  const result = await persistVerifiedCoupangHandoff(bundle({
    cookies: [
      ...bundle().cookies,
      { name: '_abck', value: 'challenge-secret', domain: '.coupang.com', path: '/', secure: true },
      { name: 'bm_sz', value: 'bot-secret', domain: '.coupang.com', path: '/', secure: true },
      { name: 'analytics_id', value: 'tracking-secret', domain: '.coupang.com', path: '/', secure: true },
    ],
  }), h.deps);
  assert.deepEqual(result, { stored: true, authenticated: true, ownerVerified: true, browserUsed: false });
  assert.deepEqual(Object.keys(result).sort(), ['authenticated', 'browserUsed', 'ownerVerified', 'stored']);
  assert.equal(h.calls.readPriorState, 1);
  assert.equal(h.calls.createAuth, 1);
  assert.equal(h.calls.importSession.length, 1);
  const input = h.calls.importSession[0];
  assert.deepEqual(input.cookies.map(cookie => cookie.name), ['AFATK', 'AWSALBCORS']);
  assert.equal(input.cookies.some(cookie => /^(?:bm_|_abck|ak_bmsc|cf_clearance)/i.test(cookie.name)), false);
  assert.equal(input.email, prior.email);
  assert.equal(input.affiliateCode, prior.affiliateCode);
  assert.equal(input.userAgent, bundle().userAgent);
  assert.deepEqual(input.headers, { accept: 'application/json', lang: 'ko' });
  assert.equal(JSON.stringify(result).includes('auth-fixture'), false);
  assert.equal(JSON.stringify(result).includes(prior.email), false);
});

test('routes a strictly matched native owner proof through attested import and returns only safe proof metadata', async () => {
  const h = injected();
  const attestedProof = proof();
  const result = await persistVerifiedCoupangHandoff(bundle({ observedProof: attestedProof }), h.deps);
  assert.deepEqual(result, {
    stored: true,
    authenticated: true,
    ownerVerified: true,
    browserUsed: false,
    ownerVerificationSource: 'authorized_browser_config_session_binding',
    freshHttpIdentityRead: false,
  });
  assert.equal(h.calls.importSession.length, 0);
  assert.equal(h.calls.importAttestedSession.length, 1);
  assert.deepEqual(h.calls.importAttestedSession[0].observedProof, attestedProof);
  assert.equal(h.calls.importAttestedSession[0].email, prior.email);
  assert.equal(h.calls.importAttestedSession[0].affiliateCode, prior.affiliateCode);
  assert.equal(JSON.stringify(result).includes(prior.email), false);
  assert.equal(JSON.stringify(result).includes('auth-fixture'), false);
});

test('accepts v2 prior identity for attested refresh and rejects proof owner or request-cookie drift before import', async () => {
  const priorV2 = { ...prior, version: 2, ownerBinding: { version: 1, source: 'fixture' } };
  const h = injected({ priorState: priorV2 });
  const result = await persistVerifiedCoupangHandoff(bundle({ observedProof: proof() }), h.deps);
  assert.equal(result.ownerVerified, true);
  assert.equal(h.calls.importAttestedSession.length, 1);

  for (const [badProof, code] of [
    [proof({ member: { valid: true, email: 'other@example.test' } }), 'COUPANG_HANDOFF_PROOF_OWNER_MISMATCH'],
    [proof({ requestCookies: [{ name: 'AFATK', value: 'different-token' }] }), 'COUPANG_HANDOFF_PROOF_COOKIE_MISMATCH'],
    [proof({ requestCookies: [{ name: 'AWSALB', value: 'route-fixture' }] }), 'COUPANG_HANDOFF_PROOF_INVALID'],
    [proof({ affiliate: { affiliateCode: 'other-affiliate' } }), 'COUPANG_HANDOFF_PROOF_OWNER_MISMATCH'],
  ]) {
    const bad = injected();
    await rejectsCode(persistVerifiedCoupangHandoff(bundle({ observedProof: badProof }), bad.deps), code);
    assert.equal(bad.calls.importSession.length, 0);
    assert.equal(bad.calls.importAttestedSession.length, 0);
  }
});

test('rejects stale and future captures before reading protected identity or importing', async () => {
  for (const [capturedAt, code] of [
    [now - COUPANG_HANDOFF_MAX_AGE_MS - 1, 'COUPANG_HANDOFF_CAPTURE_STALE'],
    [now + 30_001, 'COUPANG_HANDOFF_CAPTURE_STALE'],
  ]) {
    const h = injected();
    await rejectsCode(persistVerifiedCoupangHandoff(bundle({ capturedAt }), h.deps), code);
    assert.equal(h.calls.readPriorState, 0);
    assert.equal(h.calls.importSession.length, 0);
  }
});

test('rejects a wrong origin, extra credential fields, and an invalid user agent', async () => {
  for (const [input, code] of [
    [bundle({ sourceOrigin: 'https://www.coupang.com' }), 'COUPANG_HANDOFF_ORIGIN_INVALID'],
    [bundle({ password: 'must-not-be-accepted' }), 'COUPANG_HANDOFF_BUNDLE_INVALID'],
    [bundle({ userAgent: 'browser\nInjected: yes' }), 'COUPANG_HANDOFF_USER_AGENT_INVALID'],
    [bundle({ userAgent: 'x'.repeat(513) }), 'COUPANG_HANDOFF_USER_AGENT_INVALID'],
  ]) {
    const h = injected();
    await rejectsCode(persistVerifiedCoupangHandoff(input, h.deps), code);
    assert.equal(h.calls.readPriorState, 0);
    assert.equal(h.calls.importSession.length, 0);
  }
});

test('rejects unsafe scope, invalid secure metadata, expired, and duplicate allowlisted cookies', async () => {
  const unsafe = [
    [{ name: 'AFATK', value: 'x', domain: '.evil.example', path: '/', secure: true }, 'COUPANG_HANDOFF_COOKIE_SCOPE_INVALID'],
    [{ name: 'AFATK', value: 'x', domain: '.coupang.com', path: '/account', secure: true }, 'COUPANG_HANDOFF_COOKIE_SCOPE_INVALID'],
    [{ name: 'AFATK', value: 'x', domain: '.coupang.com', path: '/', secure: 'false' }, 'COUPANG_HANDOFF_COOKIES_INVALID'],
    [{ name: 'AFATK', value: 'x', domain: '.coupang.com', path: '/', secure: true, expires: now / 1000 - 1 }, 'COUPANG_HANDOFF_COOKIE_EXPIRED'],
  ];
  for (const [cookie, code] of unsafe) {
    const h = injected();
    await rejectsCode(persistVerifiedCoupangHandoff(bundle({ cookies: [cookie] }), h.deps), code);
    assert.equal(h.calls.importSession.length, 0);
  }
  const h = injected();
  const duplicate = { name: 'AFATK', value: 'other', domain: '.coupang.com', path: '/', secure: true };
  await rejectsCode(persistVerifiedCoupangHandoff(bundle({ cookies: [bundle().cookies[0], duplicate] }), h.deps), 'COUPANG_HANDOFF_COOKIE_DUPLICATE');
  assert.equal(h.calls.importSession.length, 0);
});

test('requires an auth cookie even if an allowed load-balancer cookie is present', async () => {
  const h = injected();
  await rejectsCode(persistVerifiedCoupangHandoff(bundle({ cookies: [bundle().cookies[1]] }), h.deps), 'COUPANG_HANDOFF_AUTH_COOKIES_MISSING');
  assert.equal(h.calls.importSession.length, 0);
});

test('uses only protected owner identity and returns provider failures as safe codes', async () => {
  const secret = 'synthetic-cookie-secret';
  const h = injected({ importError: Object.assign(new Error(`details ${secret} owner@example.test`), { code: 'OWNER_MISMATCH' }) });
  let caught;
  try { await persistVerifiedCoupangHandoff(bundle(), h.deps); } catch (error) { caught = error; }
  assert.equal(caught?.code, 'OWNER_MISMATCH');
  assert.equal(caught?.message, 'OWNER_MISMATCH');
  assert.equal(caught?.message.includes(secret), false);
  assert.equal(caught?.message.includes(prior.email), false);
  const failed = injected({ importResult: { stored: true, authenticated: false, ownerVerified: false, browserUsed: false } });
  await rejectsCode(persistVerifiedCoupangHandoff(bundle(), failed.deps), 'COUPANG_HANDOFF_OWNER_VERIFY_FAILED');
});

test('rejects missing prior identity and maps unknown provider exceptions without message leakage', async () => {
  const missing = injected({ priorState: { version: 1, email: 'owner@example.test' } });
  await rejectsCode(persistVerifiedCoupangHandoff(bundle(), missing.deps), 'COUPANG_HANDOFF_PRIOR_IDENTITY_MISSING');
  assert.equal(missing.calls.importSession.length, 0);
  const unknown = injected({ importError: new Error('synthetic-secret-in-network-stack') });
  await rejectsCode(persistVerifiedCoupangHandoff(bundle(), unknown.deps), 'COUPANG_HANDOFF_IMPORT_FAILED');
  const accessDenied = injected({ importError: Object.assign(new Error('Access Denied HTML withheld'), { code: 'COUPANG_HTTP_ACCESS_DENIED' }) });
  await rejectsCode(persistVerifiedCoupangHandoff(bundle(), accessDenied.deps), 'COUPANG_HTTP_ACCESS_DENIED');
});
