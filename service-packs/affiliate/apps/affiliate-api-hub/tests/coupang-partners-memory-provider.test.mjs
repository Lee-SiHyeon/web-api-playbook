import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  checkCoupangPartnersFreshProcess,
  createCoupangLinkDependencies,
  readCoupangProtectedStateFromStdin,
  validateCoupangProtectedStateRecord,
} from '../scripts/coupang-partners-check.mjs';
import { ScopedSession } from '../../../../../lib/scoped-session.mjs';
import { ProtectedStore } from '../../../../../lib/protected-store.mjs';
import {
  COUPANG_AUTH_COOKIE_NAMES,
  COUPANG_PARTNERS_ORIGIN,
  createCoupangOwnerBinding,
} from '../../../../../lib/web-auth/coupang-attested-session.mjs';

const email = 'owner@example.test';
const affiliateCode = 'fixture-affiliate-code';
const origins = ['https://partners.coupang.com'];
const productUrl = 'https://www.coupang.com/vp/products/9536051541?itemId=28441863454&vendorItemId=95393217933';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function ownerBody() {
  return { rCode: '0', data: { member: { valid: true, email }, affiliate: { affiliateCode } } };
}

function session(cookies, allowedOrigins = origins, cookieOrigins = origins) {
  return new ScopedSession({ allowedOrigins, cookieOrigins, cookies });
}

function versionOneState() {
  const allowedOrigins = ['https://partners.coupang.com', 'https://login.coupang.com'];
  const savedSession = session([{
    name: 'AFATK', value: 'fixture-only-cookie-value', domain: 'partners.coupang.com',
    path: '/', secure: true, httpOnly: true,
  }], allowedOrigins, allowedOrigins).toJSON();
  return { version: 1, email, affiliateCode, session: savedSession, updatedAt: new Date().toISOString() };
}

function versionTwoState() {
  const cookies = COUPANG_AUTH_COOKIE_NAMES.map((name, index) => ({
    name, value: `fixture-cookie-${index}`, domain: 'partners.coupang.com', path: '/',
    hostOnly: true, secure: true, httpOnly: true, sameSite: 'lax',
  }));
  const savedSession = session(cookies).toJSON();
  const observedProof = {
    version: 1,
    origin: COUPANG_PARTNERS_ORIGIN,
    path: '/api/v1/config',
    method: 'GET',
    httpStatus: 200,
    rCode: '0',
    capturedAt: Date.now(),
    member: { valid: true, email },
    affiliate: { affiliateCode },
    requestCookies: cookies.map(({ name, value }) => ({ name, value })),
  };
  const expectedIdentity = { email, affiliateCode };
  const sessionObject = session(cookies);
  const ownerBinding = createCoupangOwnerBinding(sessionObject, expectedIdentity, observedProof);
  return { version: 2, email, affiliateCode, session: savedSession, ownerBinding, updatedAt: new Date().toISOString() };
}

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(child) : [child];
  });
}

test('memory provider without a state reports SESSION_MISSING and HTTP 0, never a synthetic 403', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'coupang-memory-missing-'));
  try {
    const store = new ProtectedStore({ provider: 'memory', directory });
    let networkCalls = 0;
    const result = await checkCoupangPartnersFreshProcess(null, {
      provider: 'memory', store,
      fetchImpl: async () => { networkCalls += 1; return jsonResponse(ownerBody()); },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SESSION_MISSING', `status=${result.authenticationStatus}; http=${result.httpStatus}; stage=${result.failureStage}`);
    assert.equal(result.authenticationStatus, 'session_missing');
    assert.equal(result.credentialProvider, 'process-memory');
    assert.equal(result.sessionStatePersisted, false);
    assert.equal(result.httpStatus, 0);
    assert.deepEqual(result.requests, []);
    assert.equal(networkCalls, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('bounded piped state is structurally checked and never written to disk or echoed', async () => {
  const trusted = versionOneState();
  const parsed = await readCoupangProtectedStateFromStdin(Readable.from([Buffer.from(JSON.stringify(trusted))]));
  assert.equal(parsed.email, email);
  assert.equal(validateCoupangProtectedStateRecord(parsed).version, 1);
  await assert.rejects(readCoupangProtectedStateFromStdin(Readable.from([Buffer.alloc(1024 * 1024 + 1)])),
    (error) => error.code === 'COUPANG_STATE_STDIN_TOO_LARGE');
  assert.throws(() => validateCoupangProtectedStateRecord({ ...trusted, version: 3 }),
    (error) => error.code === 'COUPANG_STATE_RECORD_INVALID');

  const directory = mkdtempSync(path.join(os.tmpdir(), 'coupang-memory-state-'));
  try {
    const storeDirectory = path.join(directory, 'protected-store');
    const store = new ProtectedStore({ provider: 'memory', directory: storeDirectory });
    const calls = [];
    const result = await checkCoupangPartnersFreshProcess(null, {
      provider: 'memory', store, stateInput: trusted,
      fetchImpl: async (input) => {
        const url = new URL(input);
        calls.push(url.pathname);
        return url.pathname === '/api/v1/config'
          ? jsonResponse(ownerBody())
          : jsonResponse({ rCode: '0', data: {} }, 404);
      },
    });
    assert.equal(result.ok, true, `code=${result.code}; status=${result.authenticationStatus}; http=${result.httpStatus}; stage=${result.failureStage}`);
    assert.equal(result.authenticated, true);
    assert.equal(result.ownerVerified, true);
    assert.equal(result.authenticationStatus, 'authenticated');
    assert.equal(result.httpStatus, 200);
    assert.deepEqual(calls, ['/api/v1/config']);
    assert.equal(store.status('coupang-web-state').provider, 'process-memory');
    assert.equal(store.status('coupang-web-state').persistent, false);
    assert.deepEqual(listFiles(directory), [], 'session state and cookies must remain in process memory');
    assert.equal(JSON.stringify(result).includes('fixture-only-cookie-value'), false);
    assert.equal(JSON.stringify(result).includes(affiliateCode), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('attested memory state runs owner health and the original link adapter in one process with safe output', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'coupang-memory-link-'));
  try {
    const store = new ProtectedStore({ provider: 'memory', directory: path.join(directory, 'protected-store') });
    const calls = [];
    const fixtureShortUrl = 'https://link.coupang.com/a/FixtureOnly';
    const fetchImpl = async (input) => {
      const url = new URL(input);
      calls.push({ origin: url.origin, path: url.pathname });
      if (url.pathname === '/api/v1/dashboard') {
        return jsonResponse({ rCode: '0', data: { categories: [], dailyTrend: {}, monthlyAggregation: {} } });
      }
      if (url.pathname === '/api/v1/url/any') {
        return jsonResponse({ rCode: '0', data: {
          shortUrl: fixtureShortUrl,
          landingUrl: `${productUrl}&lptag=${affiliateCode}`,
        } });
      }
      return jsonResponse({}, 404);
    };
    const linkDependencies = createCoupangLinkDependencies(store, fetchImpl);
    linkDependencies.withSessionLock = async callback => callback();
    const result = await checkCoupangPartnersFreshProcess(productUrl, {
      provider: 'memory', store, stateInput: versionTwoState(),
      stateDirectory: path.join(directory, 'link-state'), fetchImpl, linkDependencies,
    });
    assert.equal(result.ok, true, `code=${result.code}; status=${result.authenticationStatus}; http=${result.httpStatus}; stage=${result.failureStage}`);
    assert.equal(result.authenticated, true);
    assert.equal(result.ownerVerified, true);
    assert.equal(result.credentialProvider, 'process-memory');
    assert.equal(result.sessionStatePersisted, false);
    assert.equal(result.destinationVerified, true);
    assert.equal(result.attributionVerified, true);
    assert.equal(result.shortUrlPresent, true);
    assert.equal(result.productUrlMatched, true);
    assert.equal(Object.hasOwn(result, 'shortUrl'), false);
    assert.equal(Object.hasOwn(result, 'productUrl'), false);
    assert.equal(JSON.stringify(result).includes(fixtureShortUrl), false);
    assert.equal(JSON.stringify(result).includes(productUrl), false);
    assert.equal(calls.filter(call => call.path === '/api/v1/dashboard').length, 2,
      'health and source issue each run the owner-bound auth client');
    assert.equal(calls.filter(call => call.path === '/api/v1/url/any').length, 1);
    assert.equal(calls.some(call => call.origin === 'https://link.coupang.com'), false,
      'the issued short URL is never opened');
    const cache = path.join(directory, 'link-state', 'links.json');
    const journal = path.join(directory, 'link-state', 'link-operations.json');
    assert.equal(statSync(cache).mode & 0o077, 0);
    assert.equal(statSync(journal).mode & 0o077, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
