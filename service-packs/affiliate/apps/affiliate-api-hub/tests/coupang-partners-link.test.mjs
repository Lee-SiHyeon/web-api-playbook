import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  issueCoupangLink,
  normalizeCoupangProductUrl,
  reconcileCoupangObservedResponse,
  safeCoupangLinkReceipt,
} from '../adapters/coupang-partners-link.mjs';

const targetUrl = 'https://www.coupang.com/vp/products/9729376015?itemId=19909213114&vendorItemId=71804982776';
const targetKey = '9729376015:19909213114:71804982776';
const shortUrl = 'https://link.coupang.com/a/TestLink7';
const landingUrl = `${targetUrl}&lptag=fixture-affiliate`;
const owner = {
  rCode: '0',
  data: { member: { valid: true, email: 'owner@example.test' }, affiliate: { affiliateCode: 'fixture-affiliate' } },
};
const issued = { rCode: '0', data: { shortUrl, landingUrl } };

function sdpLandingUrl({
  lptag = 'fixture-affiliate', pageKey = '9729376015', itemId = '19909213114',
  vendorItemId = '71804982776', traceid = 'Tr_1234567890-abcdefghij', extra = [],
} = {}) {
  const url = new URL('https://link.coupang.com/re/AFFSDP');
  for (const [key, value] of [
    ['lptag', lptag], ['pageKey', pageKey], ['itemId', itemId],
    ['vendorItemId', vendorItemId], ['traceid', traceid], ...extra,
  ]) url.searchParams.append(key, value);
  return url.href;
}

function sdpBody(overrides = {}) {
  return {
    rCode: '0',
    data: {
      type: 'sdp',
      landingUrl: sdpLandingUrl(),
      shortUrl,
      title: 'fixture title',
      description: 'fixture description',
      imageUrl: 'https://image.example.test/fixture.jpg',
      ...overrides,
    },
  };
}

function response(status, body, contentType = 'application/json') {
  return { status, headers: { 'content-type': contentType }, raw: Buffer.from(JSON.stringify(body)) };
}

function responseText(status, body, contentType = 'text/html; charset=utf-8', fixtureForbiddenCode = 'AUTH_FORBIDDEN') {
  return { status, headers: { 'content-type': contentType }, raw: Buffer.from(body), fixtureForbiddenCode };
}

function fixtureForbiddenClassifier(response) {
  return response.fixtureForbiddenCode ?? 'AUTH_FORBIDDEN';
}

function makeLock() {
  let previous = Promise.resolve();
  return async callback => {
    const before = previous;
    let release;
    previous = new Promise(resolve => { release = resolve; });
    await before;
    try { return await callback(); } finally { release(); }
  };
}

function harness({ linkResponse = response(200, issued), ownerResponse = response(200, owner), failLink = false, onLinkDispatch } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'coupang-link-test-'));
  const cacheFile = path.join(dir, 'links.json');
  const journalFile = path.join(dir, 'link-operations.json');
  const calls = [];
  const sessionState = {
    allowedOrigins: ['https://partners.coupang.com', 'https://login.coupang.com'],
    cookieOrigins: ['https://partners.coupang.com', 'https://login.coupang.com'],
    cookieJar: { cookies: [{ key: 'AFATK', value: 'fixture-token', domain: 'partners.coupang.com', path: '/' }] },
  };
  const state = {
    version: 1,
    email: 'owner@example.test',
    affiliateCode: 'fixture-affiliate',
    session: sessionState,
  };
  let storedState = JSON.stringify(state);
  let currentOwnerResponse = ownerResponse;
  let bindingFailureAt = null;
  let dashboardResponse = response(200, { rCode: '0', data: { categories: [], dailyTrend: {}, monthlyAggregation: {} } });
  const storeWrites = [];
  const session = {
    async request(url, options = {}) {
      calls.push({ url: String(url), method: options.method ?? 'GET' });
      if (String(url).includes('/api/v1/config')) return currentOwnerResponse;
      if (String(url).includes('/api/v1/dashboard')) return dashboardResponse;
      if (String(url).includes('/api/v1/url/any?')) {
        onLinkDispatch?.({ journalFile, url: String(url), options, sessionState });
        if (failLink) throw new Error('fixture transport failure');
        return linkResponse;
      }
      throw new Error('unexpected request route');
    },
    toJSON: () => sessionState,
  };
  const store = {
    directory: dir,
    read(name) { assert.equal(name, 'coupang-web-state'); return storedState; },
    write(name, value) { assert.equal(name, 'coupang-web-state'); storeWrites.push(value); storedState = value; },
  };
  const binding = { version: 1, source: 'authorized_browser_config_session_binding', generationId: 'fixture-generation' };
  let bindingChecks = 0;
  let attestedOwnerChecks = 0;
  const dependencies = {
    store,
    sessionFromJSON(value) { assert.deepEqual(value.session, sessionState); return session; },
    withSessionLock: makeLock(),
    coupangForbiddenCode: fixtureForbiddenClassifier,
    createCoupangServiceFetch: fetchImpl => fetchImpl,
    attestedCookieNames: ['AFATK', 'AWSALB'],
    assertCoupangOwnerBinding(_session, authState) {
      bindingChecks++;
      assert.equal(authState.version, 2);
      if (!authState.ownerBinding || bindingFailureAt === bindingChecks) {
        throw Object.assign(new Error('fixture binding failure'), { code: 'COUPANG_OWNER_BINDING_INVALID' });
      }
      return true;
    },
    async verifyCoupangBoundOwner(activeSession, authState) {
      attestedOwnerChecks++;
      assert.equal(authState.version, 2);
      const dashboard = await activeSession.request('https://partners.coupang.com/api/v1/dashboard');
      if (dashboard.status !== 200) throw Object.assign(new Error('fixture dashboard failed'), { code: 'REAUTH_REQUIRED' });
      return {
        authenticated: true,
        ownerVerified: true,
        browserUsed: false,
        ownerVerificationSource: 'authorized_browser_config_session_binding',
        freshHttpIdentityRead: false,
      };
    },
    now: (() => { let n = 0; return () => `2026-10-03T00:00:0${n++}.000Z`; })(),
  };
  return {
    dir, cacheFile, journalFile, calls, dependencies, storeWrites,
    setAffiliateCode(value) { storedState = JSON.stringify({ ...JSON.parse(storedState), affiliateCode: value }); },
    setOwnerResponse(value) { currentOwnerResponse = value; },
    setDashboardResponse(value) { dashboardResponse = value; },
    setBindingFailureAt(value) { bindingFailureAt = value; },
    setVersion2() {
      sessionState.allowedOrigins = ['https://partners.coupang.com'];
      sessionState.cookieOrigins = ['https://partners.coupang.com'];
      storedState = JSON.stringify({ ...JSON.parse(storedState), version: 2, session: sessionState, ownerBinding: binding });
    },
    getStoredState() { return storedState; },
    getBindingChecks() { return bindingChecks; },
    getAttestedOwnerChecks() { return attestedOwnerChecks; },
    cleanup() { rmSync(dir, { recursive: true, force: true }); },
  };
}

function seedUnknownOutcome(h, { targetUrl: productUrl = targetUrl, expectedAffiliateCode = 'fixture-affiliate' } = {}) {
  const target = normalizeCoupangProductUrl(productUrl);
  const operation = {
    target,
    expectedAffiliateCode,
    status: 'outcome_unknown',
    startedAt: '2026-10-03T00:00:00.000Z',
    updatedAt: '2026-10-03T00:00:08.000Z',
    method: 'GET',
    origin: 'https://partners.coupang.com',
    path: '/api/v1/url/any',
    responseStatus: 200,
    ownerVerified: true,
    failure: 'success_response_unverified',
  };
  writeFileSync(h.journalFile, JSON.stringify({
    schemaVersion: 1,
    operations: {
      [target.key]: operation,
      '7000000000:20000000000:70000000000': {
        status: 'outcome_unknown',
        target: { productUrl: 'held-unreconciled-target' },
        marker: 'preserve-this-unknown-entry',
      },
    },
  }));
  return operation;
}

function protectedObservedCapture(overrides = {}) {
  return {
    version: 1,
    productUrl: targetUrl,
    observedAt: '2026-10-03T00:00:09.000Z',
    httpStatus: 200,
    body: sdpBody(),
    ...overrides,
  };
}

test('requires one exact Coupang product, item, and vendor item identity', () => {
  assert.deepEqual(normalizeCoupangProductUrl(targetUrl), {
    productId: '9729376015', itemId: '19909213114', vendorItemId: '71804982776',
    key: targetKey, productUrl: targetUrl,
  });
  for (const invalid of [
    'https://www.coupang.com/vp/products/9729376015',
    'https://www.coupang.com/vp/products/9729376015?itemId=1',
    `${targetUrl}&unknown=1`,
    targetUrl.replace('19909213114', '19909213114&itemId=2'),
    targetUrl.replace('https://www.coupang.com', 'http://www.coupang.com'),
    targetUrl.replace('www.coupang.com', 'evil.example'),
  ]) assert.throws(() => normalizeCoupangProductUrl(invalid), error => /^COUPANG_URL_/.test(error.code));
});

test('normal and promotion URLs for one exact SKU share the canonical journal entry', async () => {
  const promotionalUrl = 'https://www.coupang.com/vp/products/9729376015?vendorItemId=71804982776&itemId=19909213114';
  assert.deepEqual(normalizeCoupangProductUrl(promotionalUrl), normalizeCoupangProductUrl(targetUrl));
  const h = harness();
  try {
    const normal = await issueCoupangLink(targetUrl, { cacheFile: h.cacheFile, journalFile: h.journalFile, dependencies: h.dependencies });
    const promotion = await issueCoupangLink(promotionalUrl, { cacheFile: h.cacheFile, journalFile: h.journalFile, dependencies: h.dependencies });
    assert.equal(normal.cached, false);
    assert.equal(promotion.cached, true);
    assert.equal(promotion.productUrl, targetUrl);
    assert.equal(h.calls.filter(call => call.url.includes('/api/v1/url/any?')).length, 1);
  } finally { h.cleanup(); }
});

test('formats a CLI-safe receipt without protected affiliate identifiers', () => {
  const receipt = safeCoupangLinkReceipt({
    shortUrl,
    productUrl: targetUrl,
    cached: false,
    ownerVerified: true,
    verification: 'observed_provider_short_url',
    destinationVerified: true,
    destinationVerification: 'generation_response_only',
    attributionVerified: true,
    independentReadbackVerified: false,
    expectedAffiliateCode: 'private-affiliate-code',
    lptag: 'private-affiliate-code',
    reconciliationSource: 'protected_operator_capture',
  });
  assert.deepEqual(receipt, {
    ok: true,
    shortUrl,
    productUrl: targetUrl,
    cached: false,
    ownerVerified: true,
    verification: 'observed_provider_short_url',
    destinationVerified: true,
    destinationVerification: 'generation_response_only',
    attributionVerified: true,
    independentReadbackVerified: false,
  });
  assert.equal(JSON.stringify(receipt).includes('private-affiliate-code'), false);
});

test('writes through the injected cache and journal once, then returns the validated exact link', async () => {
  const h = harness({
    onLinkDispatch: ({ journalFile }) => {
      const journal = JSON.parse(readFileSync(journalFile, 'utf8'));
      assert.equal(journal.operations[targetKey].status, 'write_started');
    },
  });
  try {
    const first = await issueCoupangLink(targetUrl, {
      cacheFile: h.cacheFile, journalFile: h.journalFile, dependencies: h.dependencies,
    });
    assert.deepEqual(first, {
      shortUrl,
      productUrl: targetUrl,
      lptag: 'fixture-affiliate',
      expectedAffiliateCode: 'fixture-affiliate',
      verification: 'observed_provider_short_url',
      ownerVerified: true,
      destinationVerified: true,
      destinationVerification: 'generation_response_only',
      attributionVerified: true,
      cached: false,
      independentReadbackVerified: false,
    });
    const second = await issueCoupangLink(targetUrl, {
      cacheFile: h.cacheFile, journalFile: h.journalFile, dependencies: h.dependencies,
    });
    assert.equal(second.shortUrl, shortUrl);
    assert.equal(second.cached, true);
    assert.equal(h.calls.filter(call => call.url.includes('/api/v1/url/any?')).length, 1);
    assert.equal(h.calls.filter(call => call.url.includes('/api/v1/config')).length, 2);
    assert.deepEqual(h.calls.map(call => call.method), ['GET', 'GET', 'GET']);

    const cache = JSON.parse(readFileSync(h.cacheFile, 'utf8'));
    assert.equal(cache[targetKey].shortUrl, shortUrl);
    assert.equal(cache[targetKey].productUrl, targetUrl);
    assert.equal(cache[targetKey].expectedAffiliateCode, 'fixture-affiliate');
    assert.equal(cache[targetKey].verification, 'observed_provider_short_url');
    assert.equal(cache[targetKey].ownerVerified, true);
    assert.equal(cache[targetKey].attributionVerified, true);
    assert.equal(cache[targetKey].independentReadbackVerified, false);
    const journal = JSON.parse(readFileSync(h.journalFile, 'utf8'));
    assert.equal(journal.operations[targetKey].status, 'issued');
    assert.equal(journal.operations[targetKey].expectedAffiliateCode, 'fixture-affiliate');
    assert.equal(journal.operations[targetKey].verification, 'observed_provider_short_url');
    assert.equal(journal.operations[targetKey].ownerVerified, true);
    assert.equal(journal.operations[targetKey].destinationVerified, true);
    assert.equal(journal.operations[targetKey].destinationVerification, 'generation_response_only');
    assert.equal(journal.operations[targetKey].independentReadbackVerified, false);
    assert.equal(journal.operations[targetKey].attributionVerified, true);
    assert.equal(journal.operations[targetKey].path, '/api/v1/url/any');

    rmSync(h.journalFile);
    await assert.rejects(issueCoupangLink(targetUrl, {
      cacheFile: h.cacheFile, journalFile: h.journalFile, dependencies: h.dependencies,
    }), { code: 'COUPANG_LINK_CACHE_UNVERIFIED' });
    assert.equal(h.calls.filter(call => call.url.includes('/api/v1/url/any?')).length, 1);
  } finally { h.cleanup(); }
});

test('accepts an observed provider short URL without landing metadata and preserves weak proof on cache reuse', async () => {
  const providerShortUrlOnly = response(200, {
    rCode: '0', data: { type: 'tracking', shortUrl, title: 'fixture title' },
  });
  const h = harness({ linkResponse: providerShortUrlOnly });
  try {
    const options = { cacheFile: h.cacheFile, journalFile: h.journalFile, dependencies: h.dependencies };
    const first = await issueCoupangLink(targetUrl, options);
    assert.deepEqual(first, {
      shortUrl,
      productUrl: targetUrl,
      lptag: null,
      expectedAffiliateCode: 'fixture-affiliate',
      verification: 'observed_provider_short_url',
      destinationVerified: false,
      destinationVerification: 'observed_provider_short_url',
      attributionVerified: false,
      ownerVerified: true,
      cached: false,
      independentReadbackVerified: false,
    });
    assert.equal(Object.hasOwn(first, 'attributionMismatch'), false);

    const second = await issueCoupangLink(targetUrl, options);
    assert.deepEqual(second, { ...first, cached: true });
    assert.equal(h.calls.filter(call => call.url.includes('/api/v1/url/any?')).length, 1);
    assert.equal(h.calls.filter(call => call.url.includes('/api/v1/config')).length, 2);

    const cache = JSON.parse(readFileSync(h.cacheFile, 'utf8'))[targetKey];
    assert.equal(cache.productUrl, targetUrl);
    assert.equal(cache.expectedAffiliateCode, 'fixture-affiliate');
    assert.equal(cache.ownerVerified, true);
    assert.equal(cache.verification, 'observed_provider_short_url');
    assert.equal(cache.lptag, null);
    assert.equal(cache.destinationVerified, false);
    assert.equal(cache.attributionVerified, false);
    assert.equal(cache.independentReadbackVerified, false);

    const operation = JSON.parse(readFileSync(h.journalFile, 'utf8')).operations[targetKey];
    assert.equal(operation.status, 'issued');
    assert.equal(operation.target.productUrl, targetUrl);
    assert.equal(operation.productUrl, targetUrl);
    assert.equal(operation.expectedAffiliateCode, 'fixture-affiliate');
    assert.equal(operation.ownerVerified, true);
    assert.equal(operation.verification, 'observed_provider_short_url');
    assert.equal(operation.lptag, null);
    assert.equal(operation.destinationVerified, false);
    assert.equal(operation.attributionVerified, false);
    assert.equal(operation.independentReadbackVerified, false);
  } finally { h.cleanup(); }
});

test('accepts an exact echoed landing identity without claiming tag attribution when no lptag is echoed', async () => {
  const withoutTag = response(200, { rCode: '0', data: { shortUrl, landingUrl: targetUrl } });
  const h = harness({ linkResponse: withoutTag });
  try {
    const result = await issueCoupangLink(targetUrl, {
      cacheFile: h.cacheFile, journalFile: h.journalFile, dependencies: h.dependencies,
    });
    assert.equal(result.shortUrl, shortUrl);
    assert.equal(result.destinationVerified, true);
    assert.equal(result.destinationVerification, 'generation_response_only');
    assert.equal(result.lptag, null);
    assert.equal(result.attributionVerified, false);
    assert.equal(result.independentReadbackVerified, false);
    const operation = JSON.parse(readFileSync(h.journalFile, 'utf8')).operations[targetKey];
    assert.equal(operation.verification, 'observed_provider_short_url');
    assert.equal(operation.destinationVerified, true);
    assert.equal(operation.attributionVerified, false);
  } finally { h.cleanup(); }
});

test('accepts the observed AFFSDP redirect only when all five unique query values match the target', async () => {
  const h = harness({ linkResponse: response(200, sdpBody()) });
  try {
    const result = await issueCoupangLink(targetUrl, {
      cacheFile: h.cacheFile, journalFile: h.journalFile, dependencies: h.dependencies,
    });
    assert.equal(result.shortUrl, shortUrl);
    assert.equal(result.lptag, 'fixture-affiliate');
    assert.equal(result.destinationVerified, true);
    assert.equal(result.destinationVerification, 'generation_response_only');
    assert.equal(result.attributionVerified, true);
    assert.equal(result.independentReadbackVerified, false);
    const operation = JSON.parse(readFileSync(h.journalFile, 'utf8')).operations[targetKey];
    assert.equal(operation.verification, 'observed_provider_short_url');
    assert.equal(operation.destinationVerification, 'generation_response_only');
    assert.equal(operation.independentReadbackVerified, false);
  } finally { h.cleanup(); }
});

test('holds AFFSDP redirects with a target mismatch, duplicate or unknown query, or invalid traceid', async () => {
  const invalidLandings = [
    sdpLandingUrl({ pageKey: '9729376016' }),
    sdpLandingUrl({ itemId: '19909213115' }),
    sdpLandingUrl({ vendorItemId: '71804982777' }),
    sdpLandingUrl({ extra: [['campaign', 'unobserved']] }),
    sdpLandingUrl({ extra: [['traceid', 'duplicate']] }),
    sdpLandingUrl({ traceid: 'unsafe%2Ftrace' }),
  ];
  for (const invalidLanding of invalidLandings) {
    const h = harness({ linkResponse: response(200, sdpBody({ landingUrl: invalidLanding })) });
    try {
      const options = { cacheFile: h.cacheFile, journalFile: h.journalFile, dependencies: h.dependencies };
      await assert.rejects(issueCoupangLink(targetUrl, options), { code: 'COUPANG_LINK_OUTCOME_UNCERTAIN' });
      const journal = JSON.parse(readFileSync(h.journalFile, 'utf8'));
      assert.equal(journal.operations[targetKey].status, 'outcome_unknown');
      await assert.rejects(issueCoupangLink(targetUrl, options), { code: 'COUPANG_LINK_OUTCOME_UNCERTAIN' });
      assert.equal(h.calls.filter(call => call.url.includes('/api/v1/url/any?')).length, 1);
    } finally { h.cleanup(); }
  }

  const wrongTypeBodies = [
    sdpBody({ type: 'tracking' }),
    { rCode: '0', data: { ...sdpBody().data, type: undefined } },
  ];
  for (const body of wrongTypeBodies) {
    const h = harness({ linkResponse: response(200, body) });
    try {
      const options = { cacheFile: h.cacheFile, journalFile: h.journalFile, dependencies: h.dependencies };
      await assert.rejects(issueCoupangLink(targetUrl, options), { code: 'COUPANG_LINK_OUTCOME_UNCERTAIN' });
      assert.equal(JSON.parse(readFileSync(h.journalFile, 'utf8')).operations[targetKey].status, 'outcome_unknown');
      await assert.rejects(issueCoupangLink(targetUrl, options), { code: 'COUPANG_LINK_OUTCOME_UNCERTAIN' });
      assert.equal(h.calls.filter(call => call.url.includes('/api/v1/url/any?')).length, 1);
    } finally { h.cleanup(); }
  }
});

test('rejects provider cache reuse after owner-code, target, owner-verification, or provenance drift', async () => {
  const mutations = [
    record => { record.expectedAffiliateCode = 'different-affiliate'; },
    record => { record.productUrl = 'https://www.coupang.com/vp/products/9729376015?vendorItemId=71804982776&itemId=19909213114'; },
    record => { record.ownerVerified = false; },
    record => { record.verification = 'unrecognized-provider-record'; },
  ];
  for (const mutate of mutations) {
    const h = harness({ linkResponse: response(200, { rCode: '0', data: { shortUrl } }) });
    try {
      const options = { cacheFile: h.cacheFile, journalFile: h.journalFile, dependencies: h.dependencies };
      await issueCoupangLink(targetUrl, options);
      const cache = JSON.parse(readFileSync(h.cacheFile, 'utf8'));
      mutate(cache[targetKey]);
      writeFileSync(h.cacheFile, JSON.stringify(cache));
      await assert.rejects(issueCoupangLink(targetUrl, options), { code: 'COUPANG_LINK_CACHE_CONFLICT' });
      assert.equal(h.calls.filter(call => call.url.includes('/api/v1/url/any?')).length, 1);
      assert.equal(h.calls.filter(call => call.url.includes('/api/v1/config')).length, 1);
    } finally { h.cleanup(); }
  }
});

test('serializes concurrent requests so the exact variant is issued only once', async () => {
  const h = harness();
  try {
    const options = { cacheFile: h.cacheFile, journalFile: h.journalFile, dependencies: h.dependencies };
    const results = await Promise.all([issueCoupangLink(targetUrl, options), issueCoupangLink(targetUrl, options)]);
    assert.equal(results.filter(result => !result.cached).length, 1);
    assert.equal(results.filter(result => result.cached).length, 1);
    assert.equal(h.calls.filter(call => call.url.includes('/api/v1/url/any?')).length, 1);
  } finally { h.cleanup(); }
});

test('holds an uncertain dispatched request and never automatically issues it again', async () => {
  const h = harness({ failLink: true });
  try {
    const options = { cacheFile: h.cacheFile, journalFile: h.journalFile, dependencies: h.dependencies };
    await assert.rejects(issueCoupangLink(targetUrl, options), { code: 'COUPANG_LINK_OUTCOME_UNCERTAIN' });
    const journal = JSON.parse(readFileSync(h.journalFile, 'utf8'));
    assert.equal(journal.operations[targetKey].status, 'outcome_unknown');
    await assert.rejects(issueCoupangLink(targetUrl, options), { code: 'COUPANG_LINK_OUTCOME_UNCERTAIN' });
    assert.equal(h.calls.filter(call => call.url.includes('/api/v1/url/any?')).length, 1);
  } finally { h.cleanup(); }
});

test('holds a pre-existing outcome-unknown journal even when the exact target is requested again', async () => {
  const h = harness();
  try {
    const journal = {
      schemaVersion: 1,
      operations: {
        [targetKey]: {
          target: normalizeCoupangProductUrl(targetUrl),
          expectedAffiliateCode: 'fixture-affiliate',
          status: 'outcome_unknown',
          startedAt: '2026-10-03T00:00:00.000Z',
          ownerVerified: true,
          method: 'GET',
          path: '/api/v1/url/any',
        },
      },
    };
    writeFileSync(h.journalFile, JSON.stringify(journal));
    await assert.rejects(issueCoupangLink(targetUrl, {
      cacheFile: h.cacheFile, journalFile: h.journalFile, dependencies: h.dependencies,
    }), { code: 'COUPANG_LINK_OUTCOME_UNCERTAIN' });
    assert.equal(h.calls.length, 0);
    assert.deepEqual(JSON.parse(readFileSync(h.journalFile, 'utf8')), journal);
  } finally { h.cleanup(); }
});

test('holds a successful response whose landing URL selects a different variant', async () => {
  const wrong = response(200, {
    rCode: '0',
    data: { shortUrl, landingUrl: landingUrl.replace('vendorItemId=71804982776', 'vendorItemId=95516024175') },
  });
  const h = harness({ linkResponse: wrong });
  try {
    const options = { cacheFile: h.cacheFile, journalFile: h.journalFile, dependencies: h.dependencies };
    await assert.rejects(issueCoupangLink(targetUrl, options), { code: 'COUPANG_LINK_OUTCOME_UNCERTAIN' });
    await assert.rejects(issueCoupangLink(targetUrl, options), { code: 'COUPANG_LINK_OUTCOME_UNCERTAIN' });
    assert.equal(h.calls.filter(call => call.url.includes('/api/v1/url/any?')).length, 1);
  } finally { h.cleanup(); }
});

test('rejects an owner mismatch before writing the link journal or requesting a link', async () => {
  const wrongOwner = response(200, {
    ...owner,
    data: { ...owner.data, member: { ...owner.data.member, email: 'other@example.test' } },
  });
  const h = harness({ ownerResponse: wrongOwner });
  try {
    await assert.rejects(issueCoupangLink(targetUrl, {
      cacheFile: h.cacheFile, journalFile: h.journalFile, dependencies: h.dependencies,
    }), { code: 'COUPANG_OWNER_MISMATCH' });
    assert.equal(h.calls.filter(call => call.url.includes('/api/v1/url/any?')).length, 0);
    assert.equal(h.calls.length, 1);
  } finally { h.cleanup(); }
});

test('classifies an HTML Access Denied owner response honestly and keeps 403s out of issuance', async () => {
  const deniedPage = responseText(403, '<!doctype html><html><head><title>Access Denied</title></head><body>withheld</body></html>', 'text/html', 'COUPANG_HTTP_ACCESS_DENIED');
  const genericJson403 = response(403, { rCode: '403', message: 'forbidden' });
  for (const [ownerResponse, expectedCode] of [
    [deniedPage, 'COUPANG_HTTP_ACCESS_DENIED'],
    [genericJson403, 'COUPANG_AUTH_FORBIDDEN'],
  ]) {
    const h = harness({ ownerResponse });
    try {
      const error = await issueCoupangLink(targetUrl, {
        cacheFile: h.cacheFile, journalFile: h.journalFile, dependencies: h.dependencies,
      }).then(() => null, value => value);
      assert.equal(error?.code, expectedCode);
      assert.deepEqual(error?.receipt, { operation: 'owner-health', httpStatus: 403 });
      assert.equal(error?.message.includes('withheld'), false);
      assert.equal(h.calls.filter(call => call.url.includes('/api/v1/config')).length, 1);
      assert.equal(h.calls.filter(call => call.url.includes('/api/v1/url/any?')).length, 0);
      assert.equal(existsSync(h.journalFile), false);
    } finally { h.cleanup(); }
  }
});

test('keeps an existing verified cache and journal unchanged when owner health returns HTML Access Denied', async () => {
  const h = harness();
  try {
    const options = { cacheFile: h.cacheFile, journalFile: h.journalFile, dependencies: h.dependencies };
    await issueCoupangLink(targetUrl, options);
    const cacheBefore = readFileSync(h.cacheFile, 'utf8');
    const journalBefore = readFileSync(h.journalFile, 'utf8');
    h.setOwnerResponse(responseText(403, '<html><title>Access Denied</title><body>private detail</body></html>', 'text/html', 'COUPANG_HTTP_ACCESS_DENIED'));
    const error = await issueCoupangLink(targetUrl, options).then(() => null, value => value);
    assert.equal(error?.code, 'COUPANG_HTTP_ACCESS_DENIED');
    assert.deepEqual(error?.receipt, { operation: 'owner-health', httpStatus: 403 });
    assert.equal(readFileSync(h.cacheFile, 'utf8'), cacheBefore);
    assert.equal(readFileSync(h.journalFile, 'utf8'), journalBefore);
    assert.equal(h.calls.filter(call => call.url.includes('/api/v1/url/any?')).length, 1);
    assert.equal(h.calls.filter(call => call.url.includes('/api/v1/config')).length, 2);
  } finally { h.cleanup(); }
});

test('uses bound dashboard authentication for v2 state and preserves the legacy config path for v1', async () => {
  const v2 = harness();
  try {
    v2.setVersion2();
    const result = await issueCoupangLink(targetUrl, {
      cacheFile: v2.cacheFile, journalFile: v2.journalFile, dependencies: v2.dependencies,
    });
    assert.equal(result.ownerVerified, true);
    assert.equal(v2.calls.filter(call => call.url.includes('/api/v1/config')).length, 0);
    assert.equal(v2.calls.filter(call => call.url.includes('/api/v1/dashboard')).length, 1);
    assert.equal(v2.calls.filter(call => call.url.includes('/api/v1/url/any?')).length, 1);
    assert.equal(v2.getBindingChecks(), 3);
    assert.equal(v2.getAttestedOwnerChecks(), 1);
    assert.equal(v2.storeWrites.length, 1);
    assert.equal(JSON.parse(v2.getStoredState()).version, 2);
  } finally { v2.cleanup(); }

  const v1 = harness();
  try {
    await issueCoupangLink(targetUrl, {
      cacheFile: v1.cacheFile, journalFile: v1.journalFile, dependencies: v1.dependencies,
    });
    assert.equal(v1.calls.filter(call => call.url.includes('/api/v1/config')).length, 1);
    assert.equal(v1.calls.filter(call => call.url.includes('/api/v1/dashboard')).length, 0);
    assert.equal(v1.getAttestedOwnerChecks(), 0);
  } finally { v1.cleanup(); }
});

test('filters unexpected cookies from the v2 protected-state save after a provider response', async () => {
  const h = harness({
    onLinkDispatch({ sessionState }) {
      sessionState.cookieJar.cookies.push({ key: 'bm_sz', value: 'fixture-challenge-cookie', domain: 'partners.coupang.com', path: '/' });
    },
  });
  try {
    h.setVersion2();
    await issueCoupangLink(targetUrl, {
      cacheFile: h.cacheFile, journalFile: h.journalFile, dependencies: h.dependencies,
    });
    const savedCookies = JSON.parse(h.getStoredState()).session.cookieJar.cookies;
    assert.deepEqual(savedCookies.map(cookie => cookie.key), ['AFATK']);
    assert.equal(JSON.stringify(savedCookies).includes('fixture-challenge-cookie'), false);
  } finally { h.cleanup(); }
});

test('reconciles only a protected local capture for the matching unknown response and leaves other unknowns held', async () => {
  const h = harness();
  try {
    h.setVersion2();
    seedUnknownOutcome(h);
    h.dependencies.now = () => '2026-10-03T00:00:11.000Z';
    const result = await reconcileCoupangObservedResponse(targetUrl, protectedObservedCapture(), {
      cacheFile: h.cacheFile, journalFile: h.journalFile, dependencies: h.dependencies,
    });
    assert.equal(result.shortUrl, shortUrl);
    assert.equal(result.ownerVerified, true);
    assert.equal(result.lptag, 'fixture-affiliate');
    assert.equal(result.destinationVerified, true);
    assert.equal(result.destinationVerification, 'generation_response_only');
    assert.equal(result.attributionVerified, true);
    assert.equal(result.independentReadbackVerified, false);
    assert.equal(result.reconciliationSource, 'protected_operator_capture');
    assert.equal(h.calls.filter(call => call.url.includes('/api/v1/dashboard')).length, 1);
    assert.equal(h.calls.filter(call => call.url.includes('/api/v1/config')).length, 0);
    assert.equal(h.calls.filter(call => call.url.includes('/api/v1/url/any?')).length, 0);

    const journal = JSON.parse(readFileSync(h.journalFile, 'utf8'));
    const operation = journal.operations[targetKey];
    assert.equal(operation.status, 'issued');
    assert.equal(operation.failure, undefined);
    assert.equal(operation.reconciliationSource, 'protected_operator_capture');
    assert.equal(operation.destinationVerification, 'generation_response_only');
    assert.equal(operation.independentReadbackVerified, false);
    assert.deepEqual(journal.operations['7000000000:20000000000:70000000000'], {
      status: 'outcome_unknown',
      target: { productUrl: 'held-unreconciled-target' },
      marker: 'preserve-this-unknown-entry',
    });
    assert.equal(JSON.stringify(journal).includes('fixture description'), false);
    assert.equal(JSON.stringify(journal).includes('Trace_'), false);

    const cache = JSON.parse(readFileSync(h.cacheFile, 'utf8'))[targetKey];
    assert.equal(cache.shortUrl, shortUrl);
    assert.equal(cache.expectedAffiliateCode, 'fixture-affiliate');
    assert.equal(cache.verification, 'observed_provider_short_url');
    assert.equal(cache.destinationVerification, 'generation_response_only');
    assert.equal(cache.independentReadbackVerified, false);
    assert.equal(cache.reconciliationSource, 'protected_operator_capture');

    const issuedAgain = await issueCoupangLink(targetUrl, {
      cacheFile: h.cacheFile, journalFile: h.journalFile, dependencies: h.dependencies,
    });
    assert.equal(issuedAgain.cached, true);
    assert.equal(issuedAgain.shortUrl, shortUrl);
    assert.equal(h.calls.filter(call => call.url.includes('/api/v1/url/any?')).length, 0);
    await assert.rejects(reconcileCoupangObservedResponse(targetUrl, protectedObservedCapture(), {
      cacheFile: h.cacheFile, journalFile: h.journalFile, dependencies: h.dependencies,
    }), { code: 'COUPANG_LINK_RECONCILIATION_NOT_APPLICABLE' });
    assert.equal(h.calls.filter(call => call.url.includes('/api/v1/url/any?')).length, 0);
  } finally { h.cleanup(); }
});

test('preserves an unknown journal and cache when reconciliation capture or returned identity does not match', async () => {
  const mismatches = [
    [protectedObservedCapture({ productUrl: 'https://www.coupang.com/vp/products/9729376016?itemId=19909213114&vendorItemId=71804982776' }), 'COUPANG_LINK_RECONCILIATION_CAPTURE_INVALID'],
    [protectedObservedCapture({ observedAt: '2026-10-03T00:00:18.001Z' }), 'COUPANG_LINK_RECONCILIATION_TIME_MISMATCH'],
    [protectedObservedCapture({ body: sdpBody({ landingUrl: sdpLandingUrl({ pageKey: '9729376016' }) }) }), 'COUPANG_LINK_OUTCOME_UNCERTAIN'],
    [protectedObservedCapture({ body: sdpBody({ landingUrl: sdpLandingUrl({ extra: [['unobserved', 'value']] }) }) }), 'COUPANG_LINK_OUTCOME_UNCERTAIN'],
    [protectedObservedCapture({ body: sdpBody({ landingUrl: sdpLandingUrl({ lptag: 'other-affiliate' }) }) }), 'COUPANG_LINK_ATTRIBUTION_UNVERIFIED'],
  ];
  for (const [capture, expectedCode] of mismatches) {
    const h = harness();
    try {
      h.setVersion2();
      seedUnknownOutcome(h);
      h.dependencies.now = () => '2026-10-03T00:00:11.000Z';
      const journalBefore = readFileSync(h.journalFile, 'utf8');
      const error = await reconcileCoupangObservedResponse(targetUrl, capture, {
        cacheFile: h.cacheFile, journalFile: h.journalFile, dependencies: h.dependencies,
      }).then(() => null, value => value);
      assert.equal(error?.code, expectedCode);
      assert.equal(readFileSync(h.journalFile, 'utf8'), journalBefore);
      assert.equal(existsSync(h.cacheFile), false);
      assert.equal(h.calls.filter(call => call.url.includes('/api/v1/url/any?')).length, 0);
      assert.equal(h.storeWrites.length, 0);
    } finally { h.cleanup(); }
  }
});

test('rejects reconciliation for a different owner, route, prior failure, cache, or legacy state', async () => {
  const h = harness();
  try {
    h.setVersion2();
    const operation = seedUnknownOutcome(h);
    h.dependencies.now = () => '2026-10-03T00:00:11.000Z';
    const journal = JSON.parse(readFileSync(h.journalFile, 'utf8'));
    journal.operations[targetKey].expectedAffiliateCode = 'other-affiliate';
    writeFileSync(h.journalFile, JSON.stringify(journal));
    const mismatchBefore = readFileSync(h.journalFile, 'utf8');
    await assert.rejects(reconcileCoupangObservedResponse(targetUrl, protectedObservedCapture(), {
      cacheFile: h.cacheFile, journalFile: h.journalFile, dependencies: h.dependencies,
    }), { code: 'COUPANG_LINK_RECONCILIATION_NOT_APPLICABLE' });
    assert.equal(readFileSync(h.journalFile, 'utf8'), mismatchBefore);

    journal.operations[targetKey] = { ...operation, path: '/api/v1/not-url-any' };
    writeFileSync(h.journalFile, JSON.stringify(journal));
    await assert.rejects(reconcileCoupangObservedResponse(targetUrl, protectedObservedCapture(), {
      cacheFile: h.cacheFile, journalFile: h.journalFile, dependencies: h.dependencies,
    }), { code: 'COUPANG_LINK_RECONCILIATION_NOT_APPLICABLE' });

    journal.operations[targetKey] = { ...operation, failure: 'transport_after_dispatch' };
    writeFileSync(h.journalFile, JSON.stringify(journal));
    await assert.rejects(reconcileCoupangObservedResponse(targetUrl, protectedObservedCapture(), {
      cacheFile: h.cacheFile, journalFile: h.journalFile, dependencies: h.dependencies,
    }), { code: 'COUPANG_LINK_RECONCILIATION_NOT_APPLICABLE' });

    journal.operations[targetKey] = operation;
    writeFileSync(h.journalFile, JSON.stringify(journal));
    writeFileSync(h.cacheFile, JSON.stringify({ [targetKey]: { shortUrl } }));
    await assert.rejects(reconcileCoupangObservedResponse(targetUrl, protectedObservedCapture(), {
      cacheFile: h.cacheFile, journalFile: h.journalFile, dependencies: h.dependencies,
    }), { code: 'COUPANG_LINK_CACHE_CONFLICT' });
    assert.equal(h.calls.filter(call => call.url.includes('/api/v1/dashboard')).length, 0);
    assert.equal(h.calls.filter(call => call.url.includes('/api/v1/url/any?')).length, 0);
  } finally { h.cleanup(); }

  const legacy = harness();
  try {
    seedUnknownOutcome(legacy);
    await assert.rejects(reconcileCoupangObservedResponse(targetUrl, protectedObservedCapture(), {
      cacheFile: legacy.cacheFile, journalFile: legacy.journalFile, dependencies: legacy.dependencies,
    }), { code: 'COUPANG_LINK_RECONCILIATION_REQUIRES_ATTESTED_STATE' });
    assert.equal(legacy.calls.length, 0);
  } finally { legacy.cleanup(); }
});

test('does not issue, journal, or persist v2 state when owner binding is wrong or rotates during dashboard proof', async () => {
  for (const [bindingFailureAt, dashboardCalls] of [[1, 0], [2, 1]]) {
    const h = harness();
    try {
      h.setVersion2();
      h.setBindingFailureAt(bindingFailureAt);
      const before = h.getStoredState();
      const error = await issueCoupangLink(targetUrl, {
        cacheFile: h.cacheFile, journalFile: h.journalFile, dependencies: h.dependencies,
      }).then(() => null, value => value);
      assert.equal(error?.code, 'COUPANG_OWNER_BINDING_INVALID');
      assert.equal(h.calls.filter(call => call.url.includes('/api/v1/config')).length, 0);
      assert.equal(h.calls.filter(call => call.url.includes('/api/v1/dashboard')).length, dashboardCalls);
      assert.equal(h.calls.filter(call => call.url.includes('/api/v1/url/any?')).length, 0);
      assert.equal(existsSync(h.journalFile), false);
      assert.equal(existsSync(h.cacheFile), false);
      assert.equal(h.storeWrites.length, 0);
      assert.equal(h.getStoredState(), before);
    } finally { h.cleanup(); }
  }
});

test('does not persist v2 state when dashboard authentication is rejected', async () => {
  const h = harness();
  try {
    h.setVersion2();
    h.setDashboardResponse(response(401, { rCode: '401' }));
    const before = h.getStoredState();
    const error = await issueCoupangLink(targetUrl, {
      cacheFile: h.cacheFile, journalFile: h.journalFile, dependencies: h.dependencies,
    }).then(() => null, value => value);
    assert.equal(error?.code, 'COUPANG_REAUTH_REQUIRED');
    assert.equal(h.calls.filter(call => call.url.includes('/api/v1/config')).length, 0);
    assert.equal(h.calls.filter(call => call.url.includes('/api/v1/dashboard')).length, 1);
    assert.equal(h.calls.filter(call => call.url.includes('/api/v1/url/any?')).length, 0);
    assert.equal(existsSync(h.journalFile), false);
    assert.equal(h.storeWrites.length, 0);
    assert.equal(h.getStoredState(), before);
  } finally { h.cleanup(); }
});

test('does not reuse a cached short link with a foreign host or different variant', async () => {
  const h = harness();
  try {
    mkdirSync(path.dirname(h.cacheFile), { recursive: true });
    writeFileSync(h.cacheFile, JSON.stringify({
      [targetKey]: {
        shortUrl: 'https://example.com/a/foreign',
        productUrl: targetUrl.replace('vendorItemId=71804982776', 'vendorItemId=95516024175'),
        issuedAt: '2026-10-02T00:00:00.000Z',
      },
    }));
    await assert.rejects(issueCoupangLink(targetUrl, {
      cacheFile: h.cacheFile, journalFile: h.journalFile, dependencies: h.dependencies,
    }), { code: 'COUPANG_LINK_CACHE_UNVERIFIED' });
    assert.equal(h.calls.length, 0);
  } finally { h.cleanup(); }
});

test('rejects an issued journal link after the protected affiliate account changes', async () => {
  const h = harness({ linkResponse: response(200, { rCode: '0', data: { shortUrl } }) });
  try {
    const options = { cacheFile: h.cacheFile, journalFile: h.journalFile, dependencies: h.dependencies };
    await issueCoupangLink(targetUrl, options);
    h.setAffiliateCode('changed-affiliate');
    await assert.rejects(issueCoupangLink(targetUrl, options), { code: 'COUPANG_LINK_ATTRIBUTION_MISMATCH' });
    assert.equal(h.calls.filter(call => call.url.includes('/api/v1/url/any?')).length, 1);
  } finally { h.cleanup(); }
});

test('rechecks live owner identity before returning an issued journal link', async () => {
  const h = harness({ linkResponse: response(200, { rCode: '0', data: { shortUrl } }) });
  const remoteOwnerChanged = response(200, {
    ...owner,
    data: { ...owner.data, affiliate: { affiliateCode: 'remote-owner-changed' } },
  });
  try {
    const options = { cacheFile: h.cacheFile, journalFile: h.journalFile, dependencies: h.dependencies };
    await issueCoupangLink(targetUrl, options);
    h.setOwnerResponse(remoteOwnerChanged);
    await assert.rejects(issueCoupangLink(targetUrl, options), { code: 'COUPANG_OWNER_MISMATCH' });
    assert.equal(h.calls.filter(call => call.url.includes('/api/v1/url/any?')).length, 1);
    assert.equal(h.calls.filter(call => call.url.includes('/api/v1/config')).length, 2);
  } finally { h.cleanup(); }
});

test('rejects a cached link when its recorded attribution belongs to a different protected account', async () => {
  const h = harness();
  try {
    writeFileSync(h.cacheFile, JSON.stringify({
      [targetKey]: {
        shortUrl,
        lptag: 'fixture-affiliate',
        productUrl: targetUrl,
        expectedAffiliateCode: 'fixture-affiliate',
        issuedAt: '2026-10-02T00:00:00.000Z',
      },
    }));
    h.setAffiliateCode('changed-affiliate');
    await assert.rejects(issueCoupangLink(targetUrl, {
      cacheFile: h.cacheFile, journalFile: h.journalFile, dependencies: h.dependencies,
    }), { code: 'COUPANG_LINK_ATTRIBUTION_MISMATCH' });
    assert.equal(h.calls.length, 0);
    assert.equal(readFileSync(h.cacheFile, 'utf8').includes('changed-affiliate'), false);
  } finally { h.cleanup(); }
});

test('holds a legacy cache without a current-account lptag instead of promoting it', async () => {
  const h = harness();
  try {
    writeFileSync(h.cacheFile, JSON.stringify({
      [targetKey]: { shortUrl, productUrl: targetUrl, issuedAt: '2026-10-02T00:00:00.000Z' },
    }));
    await assert.rejects(issueCoupangLink(targetUrl, {
      cacheFile: h.cacheFile, journalFile: h.journalFile, dependencies: h.dependencies,
    }), { code: 'COUPANG_LINK_ATTRIBUTION_UNVERIFIED' });
    assert.equal(h.calls.length, 0);
    assert.equal(existsSync(h.journalFile), false);
  } finally { h.cleanup(); }
});

test('reuses a legacy cache only with exact account attribution and labels destination scope narrowly', async () => {
  const h = harness();
  try {
    writeFileSync(h.cacheFile, JSON.stringify({
      [targetKey]: {
        shortUrl,
        lptag: 'fixture-affiliate',
        productUrl: targetUrl,
        issuedAt: '2026-10-02T00:00:00.000Z',
      },
    }));
    const result = await issueCoupangLink(targetUrl, {
      cacheFile: h.cacheFile, journalFile: h.journalFile, dependencies: h.dependencies,
    });
    assert.deepEqual(result, {
      shortUrl,
      lptag: 'fixture-affiliate',
      productUrl: targetUrl,
      expectedAffiliateCode: 'fixture-affiliate',
      attributionVerified: true,
      destinationVerified: false,
      destinationVerification: 'recorded_target_only',
      independentReadbackVerified: false,
      cached: true,
    });
    assert.equal(h.calls.length, 1);
    assert.match(h.calls[0].url, /\/api\/v1\/config$/);
    const operation = JSON.parse(readFileSync(h.journalFile, 'utf8')).operations[targetKey];
    assert.equal(operation.status, 'cached_legacy');
    assert.equal(operation.verification, 'legacy-cache-attribution-and-recorded-target');
    assert.equal(operation.destinationVerified, false);
    assert.equal(operation.attributionVerified, true);
  } finally { h.cleanup(); }
});

test('does not promote or return a legacy cache when the live portal owner differs', async () => {
  const remoteOwnerChanged = response(200, {
    ...owner,
    data: { ...owner.data, affiliate: { affiliateCode: 'remote-owner-changed' } },
  });
  const h = harness({ ownerResponse: remoteOwnerChanged });
  try {
    const originalCache = {
      [targetKey]: {
        shortUrl,
        lptag: 'fixture-affiliate',
        productUrl: targetUrl,
        issuedAt: '2026-10-02T00:00:00.000Z',
      },
    };
    writeFileSync(h.cacheFile, JSON.stringify(originalCache));
    await assert.rejects(issueCoupangLink(targetUrl, {
      cacheFile: h.cacheFile, journalFile: h.journalFile, dependencies: h.dependencies,
    }), { code: 'COUPANG_OWNER_MISMATCH' });
    assert.equal(h.calls.length, 1);
    assert.match(h.calls[0].url, /\/api\/v1\/config$/);
    assert.equal(h.calls.filter(call => call.url.includes('/api/v1/url/any?')).length, 0);
    assert.equal(existsSync(h.journalFile), false);
    assert.deepEqual(JSON.parse(readFileSync(h.cacheFile, 'utf8')), originalCache);
  } finally { h.cleanup(); }
});

test('fails closed on cached journal and legacy results when the live owner check is unavailable', async () => {
  const unavailable = response(401, { rCode: '401' });
  const issuedHarness = harness();
  try {
    const options = {
      cacheFile: issuedHarness.cacheFile,
      journalFile: issuedHarness.journalFile,
      dependencies: issuedHarness.dependencies,
    };
    await issueCoupangLink(targetUrl, options);
    issuedHarness.setOwnerResponse(unavailable);
    await assert.rejects(issueCoupangLink(targetUrl, options), { code: 'COUPANG_REAUTH_REQUIRED' });
    assert.equal(issuedHarness.calls.filter(call => call.url.includes('/api/v1/url/any?')).length, 1);
    assert.equal(issuedHarness.calls.filter(call => call.url.includes('/api/v1/config')).length, 2);
  } finally { issuedHarness.cleanup(); }

  const legacyHarness = harness({ ownerResponse: unavailable });
  try {
    const originalCache = {
      [targetKey]: {
        shortUrl,
        lptag: 'fixture-affiliate',
        productUrl: targetUrl,
        issuedAt: '2026-10-02T00:00:00.000Z',
      },
    };
    writeFileSync(legacyHarness.cacheFile, JSON.stringify(originalCache));
    await assert.rejects(issueCoupangLink(targetUrl, {
      cacheFile: legacyHarness.cacheFile,
      journalFile: legacyHarness.journalFile,
      dependencies: legacyHarness.dependencies,
    }), { code: 'COUPANG_REAUTH_REQUIRED' });
    assert.equal(legacyHarness.calls.length, 1);
    assert.equal(existsSync(legacyHarness.journalFile), false);
    assert.deepEqual(JSON.parse(readFileSync(legacyHarness.cacheFile, 'utf8')), originalCache);
  } finally { legacyHarness.cleanup(); }
});

test('does not return or reissue a generated link whose observed lptag differs from the protected account', async () => {
  const mismatched = response(200, {
    rCode: '0', data: { shortUrl, landingUrl: landingUrl.replace('fixture-affiliate', 'other-affiliate') },
  });
  const h = harness({ linkResponse: mismatched });
  try {
    const options = { cacheFile: h.cacheFile, journalFile: h.journalFile, dependencies: h.dependencies };
    await assert.rejects(issueCoupangLink(targetUrl, options), {
      code: 'COUPANG_LINK_ATTRIBUTION_UNVERIFIED',
      receipt: { operation: 'link-issue', httpStatus: 200, destinationVerified: true, attributionVerified: false },
    });
    const operation = JSON.parse(readFileSync(h.journalFile, 'utf8')).operations[targetKey];
    assert.equal(operation.status, 'issued');
    assert.equal(operation.ownerVerified, true);
    assert.equal(operation.verification, 'observed_provider_attribution_mismatch');
    assert.equal(operation.destinationVerification, 'generation_response_only');
    assert.equal(operation.attributionVerified, false);
    await assert.rejects(issueCoupangLink(targetUrl, options), { code: 'COUPANG_LINK_ATTRIBUTION_UNVERIFIED' });
    assert.equal(h.calls.filter(call => call.url.includes('/api/v1/url/any?')).length, 1);
  } finally { h.cleanup(); }
});

test('holds generated landing URLs containing unobserved query keys or fragments', async () => {
  for (const unobserved of [`${landingUrl}&campaign=1`, `${landingUrl}#fragment`]) {
    const h = harness({ linkResponse: response(200, { rCode: '0', data: { shortUrl, landingUrl: unobserved } }) });
    try {
      const options = { cacheFile: h.cacheFile, journalFile: h.journalFile, dependencies: h.dependencies };
      await assert.rejects(issueCoupangLink(targetUrl, options), { code: 'COUPANG_LINK_OUTCOME_UNCERTAIN' });
      await assert.rejects(issueCoupangLink(targetUrl, options), { code: 'COUPANG_LINK_OUTCOME_UNCERTAIN' });
      assert.equal(h.calls.filter(call => call.url.includes('/api/v1/url/any?')).length, 1);
    } finally { h.cleanup(); }
  }
});
