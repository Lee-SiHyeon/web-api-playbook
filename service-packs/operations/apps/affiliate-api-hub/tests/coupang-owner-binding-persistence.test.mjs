import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  issueCoupangLink,
  normalizeCoupangProductUrl,
  reconcileCoupangObservedResponse,
} from '../adapters/coupang-partners-link.mjs';

const ORIGIN = 'https://partners.coupang.com';
const EMAIL = 'offline-owner@example.test';
const AFFILIATE_CODE = 'offline-affiliate';
const TARGET_URL = 'https://www.coupang.com/vp/products/6247736560?itemId=12646874013&vendorItemId=79914317500';
const TARGET = normalizeCoupangProductUrl(TARGET_URL);
const SYNTHETIC_SHORT_URL = 'https://link.coupang.com/a/SyntheticOfflineLink';
const PLAYBOOK_ROOT = path.resolve(
  process.env.WEB_API_PLAYBOOK_ROOT
    || process.env.WEB_API_PLAYBOOK
    || 'C:/Users/User/Documents/GitHub/web-api-playbook',
);
const SCOPED_SESSION_SOURCE = path.join(PLAYBOOK_ROOT, 'lib', 'scoped-session.mjs');
const ATTESTED_SESSION_SOURCE = path.join(PLAYBOOK_ROOT, 'lib', 'web-auth', 'coupang-attested-session.mjs');
const REAL_HELPERS_AVAILABLE = existsSync(SCOPED_SESSION_SOURCE) && existsSync(ATTESTED_SESSION_SOURCE);
const integrationTest = REAL_HELPERS_AVAILABLE ? test : test.skip;

let ScopedSession;
let createCoupangOwnerBinding;
let assertCoupangOwnerBinding;
let createCoupangServiceFetch;
let verifyCoupangBoundOwner;
let COUPANG_AUTH_COOKIE_NAMES;
let COUPANG_ROUTING_COOKIE_NAMES;

if (REAL_HELPERS_AVAILABLE) {
  const [{ ScopedSession: importedScopedSession }, attested] = await Promise.all([
    import(pathToFileURL(SCOPED_SESSION_SOURCE).href),
    import(pathToFileURL(ATTESTED_SESSION_SOURCE).href),
  ]);
  ScopedSession = importedScopedSession;
  ({
    createCoupangOwnerBinding,
    assertCoupangOwnerBinding,
    createCoupangServiceFetch,
    verifyCoupangBoundOwner,
    COUPANG_AUTH_COOKIE_NAMES,
    COUPANG_ROUTING_COOKIE_NAMES,
  } = attested);
}

function syntheticCookieSeeds() {
  const auth = COUPANG_AUTH_COOKIE_NAMES.map((name, index) => ({
    name,
    value: `synthetic-auth-cookie-${index}`,
    domain: 'partners.coupang.com',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
  }));
  return [
    ...auth,
    {
      name: 'AWSALB',
      value: 'synthetic-routing-cookie-before',
      domain: 'partners.coupang.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
    },
  ];
}

function newSyntheticBoundState() {
  const identity = { email: EMAIL, affiliateCode: AFFILIATE_CODE };
  const session = new ScopedSession({
    allowedOrigins: [ORIGIN],
    cookieOrigins: [ORIGIN],
    cookies: syntheticCookieSeeds(),
    fetchImpl: async () => { throw new Error('unexpected network fallback'); },
  });
  const requestCookies = COUPANG_AUTH_COOKIE_NAMES.map((name, index) => ({
    name,
    value: `synthetic-auth-cookie-${index}`,
  }));
  const proof = {
    version: 1,
    origin: ORIGIN,
    path: '/api/v1/config',
    method: 'GET',
    httpStatus: 200,
    rCode: '0',
    capturedAt: Date.now(),
    member: { valid: true, email: EMAIL },
    affiliate: { affiliateCode: AFFILIATE_CODE },
    requestCookies,
  };
  return {
    version: 2,
    email: EMAIL,
    affiliateCode: AFFILIATE_CODE,
    ownerBinding: createCoupangOwnerBinding(session, identity, proof),
    session: session.toJSON(),
  };
}

function jsonResponse(body, setCookies = []) {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const cookie of setCookies) headers.append('set-cookie', cookie);
  return new Response(JSON.stringify(body), { status: 200, headers });
}

function removeHarnessDirectory(directory) {
  const resolvedRoot = path.resolve(os.tmpdir());
  const resolvedTarget = path.resolve(directory);
  const relativeTarget = path.relative(resolvedRoot, resolvedTarget);
  if (!relativeTarget || relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
    throw new Error('synthetic test cleanup target escaped the temporary root');
  }
  rmSync(resolvedTarget, { recursive: true, force: true });
}

function createHarness({
  initialState = newSyntheticBoundState(),
  rotateCookie = null,
  raceOnPersistenceSnapshot = false,
  stateFile = null,
} = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'coupang-owner-binding-offline-'));
  const cacheFile = path.join(directory, 'links.json');
  const journalFile = path.join(directory, 'link-operations.json');
  const calls = [];
  const writes = [];
  let storedState = JSON.stringify(initialState);
  let raceArmed = false;
  let insideBindingAssertion = false;

  async function syntheticFetch(rawUrl) {
    const url = new URL(rawUrl);
    if (url.origin !== ORIGIN) throw new Error('unexpected synthetic destination');
    calls.push(url.pathname);

    if (url.pathname === '/api/v1/dashboard') {
      return jsonResponse({
        rCode: '0',
        data: { categories: [], dailyTrend: {}, monthlyAggregation: {} },
      });
    }
    if (url.pathname === '/api/v1/url/any') {
      if (url.searchParams.get('coupangUrl') !== TARGET.productUrl) {
        throw new Error('unexpected synthetic link target');
      }
      const setCookies = [];
      if (rotateCookie === 'auth') {
        setCookies.push('AFATK=synthetic-auth-cookie-after-rotation; Domain=partners.coupang.com; Path=/; Secure; HttpOnly; SameSite=Lax');
      }
      if (rotateCookie === 'routing') {
        setCookies.push('AWSALB=synthetic-routing-cookie-after; Domain=partners.coupang.com; Path=/; Secure; HttpOnly; SameSite=Lax');
      }
      return jsonResponse({
        rCode: '0',
        data: { shortUrl: SYNTHETIC_SHORT_URL, landingUrl: `${TARGET.productUrl}&lptag=${AFFILIATE_CODE}` },
      }, setCookies);
    }
    throw new Error('unexpected synthetic route');
  }

  const dependencies = {
    store: {
      directory,
      read(name) {
        if (name !== 'coupang-web-state') throw new Error('unexpected synthetic store key');
        return storedState;
      },
      write(name, value) {
        if (name !== 'coupang-web-state') throw new Error('unexpected synthetic store key');
        writes.push(true);
        storedState = value;
        if (stateFile) writeFileSync(stateFile, value);
      },
    },
    sessionFromJSON(state) {
      const session = ScopedSession.fromJSON(state.session, {
        fetchImpl: createCoupangServiceFetch(syntheticFetch),
      });
      if (raceOnPersistenceSnapshot) {
        const toJSON = session.toJSON.bind(session);
        session.toJSON = () => {
          const snapshot = toJSON();
          if (raceArmed && !insideBindingAssertion) {
            const authCookie = snapshot.cookieJar.cookies.find(cookie => cookie.key === 'AFATK');
            if (authCookie) authCookie.value = 'synthetic-auth-cookie-after-snapshot-race';
          }
          return snapshot;
        };
      }
      return session;
    },
    withSessionLock: callback => callback(),
    coupangForbiddenCode: () => 'AUTH_FORBIDDEN',
    createCoupangServiceFetch,
    attestedCookieNames: [...COUPANG_AUTH_COOKIE_NAMES, ...COUPANG_ROUTING_COOKIE_NAMES],
    assertCoupangOwnerBinding(session, state) {
      insideBindingAssertion = true;
      try { return assertCoupangOwnerBinding(session, state); }
      finally { insideBindingAssertion = false; }
    },
    async verifyCoupangBoundOwner(session, state) {
      const result = await verifyCoupangBoundOwner(session, state);
      if (raceOnPersistenceSnapshot) raceArmed = true;
      return result;
    },
    now: () => '2026-10-04T10:00:00.000Z',
  };

  return {
    directory,
    cacheFile,
    journalFile,
    calls,
    writes,
    dependencies,
    getStoredState() { return storedState; },
    cleanup() { removeHarnessDirectory(directory); },
  };
}

function seedSyntheticIssuedCache(cacheFile, journalFile) {
  const issuedAt = '2026-10-04T09:00:00.000Z';
  const record = {
    shortUrl: SYNTHETIC_SHORT_URL,
    lptag: AFFILIATE_CODE,
    productUrl: TARGET.productUrl,
    expectedAffiliateCode: AFFILIATE_CODE,
    ownerVerified: true,
    verification: 'observed_provider_short_url',
    destinationVerified: true,
    destinationVerification: 'generation_response_only',
    attributionVerified: true,
    independentReadbackVerified: false,
    issuedAt,
  };
  const operation = {
    target: TARGET,
    expectedAffiliateCode: AFFILIATE_CODE,
    status: 'issued',
    startedAt: issuedAt,
    issuedAt,
    method: 'GET',
    origin: ORIGIN,
    path: '/api/v1/url/any',
    responseStatus: 200,
    ownerVerified: true,
    verification: 'observed_provider_short_url',
    destinationVerified: true,
    destinationVerification: 'generation_response_only',
    attributionVerified: true,
    independentReadbackVerified: false,
    shortUrl: SYNTHETIC_SHORT_URL,
    productUrl: TARGET.productUrl,
    lptag: AFFILIATE_CODE,
  };
  writeFileSync(cacheFile, JSON.stringify({ [TARGET.key]: record }));
  writeFileSync(journalFile, JSON.stringify({ schemaVersion: 1, operations: { [TARGET.key]: operation } }));
}

function seedSyntheticUnknownOutcome(journalFile) {
  const startedAt = '2026-10-04T09:00:00.000Z';
  writeFileSync(journalFile, JSON.stringify({
    schemaVersion: 1,
    operations: {
      [TARGET.key]: {
        target: TARGET,
        expectedAffiliateCode: AFFILIATE_CODE,
        status: 'outcome_unknown',
        startedAt,
        updatedAt: '2026-10-04T09:00:08.000Z',
        method: 'GET',
        origin: ORIGIN,
        path: '/api/v1/url/any',
        responseStatus: 200,
        ownerVerified: true,
        failure: 'success_response_unverified',
      },
    },
  }));
}

function syntheticObservedCapture() {
  return {
    version: 1,
    productUrl: TARGET.productUrl,
    observedAt: '2026-10-04T09:00:09.000Z',
    httpStatus: 200,
    body: {
      rCode: '0',
      data: {
        shortUrl: SYNTHETIC_SHORT_URL,
        landingUrl: `${TARGET.productUrl}&lptag=${AFFILIATE_CODE}`,
      },
    },
  };
}

function serializedBindingIsValid(stateText) {
  try {
    const state = JSON.parse(stateText);
    const session = ScopedSession.fromJSON(state.session, {
      fetchImpl: async () => { throw new Error('unexpected network fallback'); },
    });
    return assertCoupangOwnerBinding(session, state) === true;
  } catch {
    return false;
  }
}

function seedStaleOwnerBinding(state) {
  const stale = JSON.parse(JSON.stringify(state));
  const authCookie = stale.session.cookieJar.cookies.find(cookie => cookie.key === 'AFATK');
  authCookie.value = 'synthetic-auth-cookie-rotated-with-stale-binding';
  return stale;
}

async function runFreshProcessCacheChild() {
  const stateFixture = process.env.COUPANG_OFFLINE_STATE_FIXTURE;
  const cacheFile = process.env.COUPANG_OFFLINE_CACHE_FILE;
  const journalFile = process.env.COUPANG_OFFLINE_JOURNAL_FILE;
  if (!stateFixture || !cacheFile || !journalFile) {
    process.stdout.write(JSON.stringify({ ok: false, code: 'SYNTHETIC_FIXTURE_PATH_MISSING' }));
    process.exitCode = 1;
    return;
  }

  let harness;
  try {
    const syntheticState = JSON.parse(readFileSync(stateFixture, 'utf8'));
    harness = createHarness({ initialState: syntheticState, stateFile: stateFixture });
    const result = await issueCoupangLink(TARGET_URL, {
      cacheFile,
      journalFile,
      dependencies: harness.dependencies,
    });
    const receipt = {
      ok: true,
      cached: result.cached === true,
      linkIssueRequests: harness.calls.filter(route => route === '/api/v1/url/any').length,
      ownerChecks: harness.calls.filter(route => route === '/api/v1/dashboard').length,
      savedBindingValid: serializedBindingIsValid(harness.getStoredState()),
    };
    process.stdout.write(JSON.stringify(receipt));
  } catch (error) {
    process.stdout.write(JSON.stringify({
      ok: false,
      code: /^COUPANG_[A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : 'SYNTHETIC_CHILD_FAILED',
    }));
    process.exitCode = 1;
  } finally {
    harness?.cleanup();
  }
}

if (process.env.COUPANG_OWNER_BINDING_OFFLINE_CHILD === '1') {
  await runFreshProcessCacheChild();
} else {
  integrationTest('synthetic offline: auth-cookie rotation during link issuance is rejected without saving the changed session', async () => {
    const h = createHarness({ rotateCookie: 'auth' });
    try {
      await assert.rejects(issueCoupangLink(TARGET_URL, {
        cacheFile: h.cacheFile,
        journalFile: h.journalFile,
        dependencies: h.dependencies,
      }), { code: 'COUPANG_OWNER_BINDING_INVALID' });
      assert.equal(h.calls.filter(route => route === '/api/v1/url/any').length, 1);
      assert.equal(h.writes.length, 0);
      assert.ok(serializedBindingIsValid(h.getStoredState()));
    } finally {
      h.cleanup();
    }
  });

  integrationTest('synthetic offline: routing-cookie rotation is saved while the real owner binding remains valid', async () => {
    const h = createHarness({ rotateCookie: 'routing' });
    try {
      const result = await issueCoupangLink(TARGET_URL, {
        cacheFile: h.cacheFile,
        journalFile: h.journalFile,
        dependencies: h.dependencies,
      });
      const stored = JSON.parse(h.getStoredState());
      const routingCookie = stored.session.cookieJar.cookies.find(cookie => cookie.key === 'AWSALB');
      assert.ok(result.cached === false);
      assert.equal(h.writes.length, 1);
      assert.ok(routingCookie?.value === 'synthetic-routing-cookie-after');
      assert.ok(serializedBindingIsValid(h.getStoredState()));
    } finally {
      h.cleanup();
    }
  });

  integrationTest('synthetic offline: the exact persistence snapshot is rejected if an auth cookie changes after owner verification', async () => {
    const h = createHarness({ raceOnPersistenceSnapshot: true });
    try {
      await assert.rejects(issueCoupangLink(TARGET_URL, {
        cacheFile: h.cacheFile,
        journalFile: h.journalFile,
        dependencies: h.dependencies,
      }), { code: 'COUPANG_OWNER_BINDING_INVALID' });
      assert.equal(h.calls.filter(route => route === '/api/v1/url/any').length, 1);
      assert.equal(h.writes.length, 0);
      assert.ok(serializedBindingIsValid(h.getStoredState()));
    } finally {
      h.cleanup();
    }
  });

  integrationTest('synthetic offline: reconciliation rejects a changed auth-cookie snapshot before protected-state write', async () => {
    const h = createHarness({ raceOnPersistenceSnapshot: true });
    try {
      seedSyntheticUnknownOutcome(h.journalFile);
      await assert.rejects(reconcileCoupangObservedResponse(TARGET_URL, syntheticObservedCapture(), {
        cacheFile: h.cacheFile,
        journalFile: h.journalFile,
        dependencies: h.dependencies,
      }), { code: 'COUPANG_OWNER_BINDING_INVALID' });
      assert.equal(h.calls.filter(route => route === '/api/v1/url/any').length, 0);
      assert.equal(h.calls.filter(route => route === '/api/v1/dashboard').length, 1);
      assert.equal(h.writes.length, 0);
      assert.ok(serializedBindingIsValid(h.getStoredState()));
    } finally {
      h.cleanup();
    }
  });

  integrationTest('synthetic offline: stale owner binding rejects a cached result before any HTTP request', async () => {
    const h = createHarness({ initialState: seedStaleOwnerBinding(newSyntheticBoundState()) });
    try {
      seedSyntheticIssuedCache(h.cacheFile, h.journalFile);
      await assert.rejects(issueCoupangLink(TARGET_URL, {
        cacheFile: h.cacheFile,
        journalFile: h.journalFile,
        dependencies: h.dependencies,
      }), { code: 'COUPANG_OWNER_BINDING_INVALID' });
      assert.equal(h.calls.length, 0);
      assert.equal(h.writes.length, 0);
    } finally {
      h.cleanup();
    }
  });

  integrationTest('synthetic offline: a fresh Node process first issues the caller product, then a second process returns its validated cache', async () => {
    const h = createHarness();
    const stateFixture = path.join(h.directory, 'synthetic-state.json');
    try {
      writeFileSync(stateFixture, JSON.stringify(newSyntheticBoundState()));
      const testFile = fileURLToPath(import.meta.url);
      const childEnv = {
        COUPANG_OWNER_BINDING_OFFLINE_CHILD: '1',
        COUPANG_OFFLINE_STATE_FIXTURE: stateFixture,
        COUPANG_OFFLINE_CACHE_FILE: h.cacheFile,
        COUPANG_OFFLINE_JOURNAL_FILE: h.journalFile,
        WEB_API_PLAYBOOK_ROOT: PLAYBOOK_ROOT,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
        ...(process.env.PATH ? { PATH: process.env.PATH } : process.env.Path ? { PATH: process.env.Path } : {}),
        ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
        ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
      };
      const runChild = () => spawnSync(process.execPath, [testFile], {
        cwd: path.dirname(testFile),
        env: childEnv,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 16 * 1024,
      });
      const firstProcess = runChild();
      assert.equal(firstProcess.error, undefined);
      assert.equal(firstProcess.status, 0);
      const issuedReceipt = JSON.parse(firstProcess.stdout.trim());
      assert.ok(issuedReceipt.ok === true);
      assert.ok(issuedReceipt.cached === false);
      assert.equal(issuedReceipt.linkIssueRequests, 1);
      assert.equal(issuedReceipt.ownerChecks, 1);
      assert.ok(issuedReceipt.savedBindingValid === true);

      const secondProcess = runChild();
      assert.equal(secondProcess.error, undefined);
      assert.equal(secondProcess.status, 0);
      const cachedReceipt = JSON.parse(secondProcess.stdout.trim());
      assert.ok(cachedReceipt.ok === true);
      assert.ok(cachedReceipt.cached === true);
      assert.equal(cachedReceipt.linkIssueRequests, 0);
      assert.equal(cachedReceipt.ownerChecks, 1);
      assert.ok(cachedReceipt.savedBindingValid === true);
    } finally {
      h.cleanup();
    }
  });
}
