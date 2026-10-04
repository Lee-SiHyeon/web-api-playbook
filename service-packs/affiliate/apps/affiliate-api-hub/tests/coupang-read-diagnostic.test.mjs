import test from 'node:test';
import assert from 'node:assert/strict';
import { runCoupangReadDiagnostic } from '../scripts/coupang-read-diagnostic.mjs';
import { projectCoupangReadProof } from '../lib/coupang-read-proof.mjs';

const target = 'https://www.coupang.com/vp/products/6247736560?itemId=12646874013&vendorItemId=79914317500';
const identity = { productId: '6247736560', itemId: '12646874013', vendorItemId: '79914317500' };

function receipt({ status = 200, ordinal = 1, transport = 'injected', requestIdentity = identity, extra = {} } = {}) {
  return {
    checkedAt: '2026-10-04T00:00:00.000Z',
    operation: 'offer_list',
    method: 'GET',
    origin: 'https://www.coupang.com',
    path: '/next-api/offer-list',
    query: { productId: requestIdentity.productId, itemId: requestIdentity.itemId, selectedVendorItemId: requestIdentity.vendorItemId },
    status,
    contentType: 'application/json',
    bodyComplete: true,
    execution: 'pure_http',
    transport,
    authenticationMode: 'visitor',
    credentialSent: false,
    credentialPropagated: false,
    authenticatedOwnerVerified: false,
    browserUsed: false,
    retry: false,
    redirectsFollowed: false,
    challengeConfirmed: false,
    visitorCookiesSent: true,
    visitorCookieNames: ['PCID', 'x-coupang-accept-language'],
    visitorCookieRotationApplied: false,
    visitorBootstrap: ordinal === 1 ? { status: 200, cookie: 'DO_NOT_EXPOSE_BOOTSTRAP_SECRET' } : null,
    requestHeaders: { cookie: 'DO_NOT_EXPOSE_COOKIE_SECRET', authorization: 'DO_NOT_EXPOSE_AUTH_SECRET' },
    rawBody: 'DO_NOT_EXPOSE_RESPONSE_SECRET',
    ...extra,
  };
}

function makeSuccess({ ordinal, price = 11200, shippingStatus = 'absent', shippingFee = null,
  transport = 'injected', requestIdentity = identity, liveReplay = false, priceKind = 'offer_list_general_sale_price', priceBasis = 'public_offer_list' } = {}) {
  return {
    receipt: receipt({ ordinal, transport, requestIdentity }),
    selectedOffer: {
      selected: true,
      ...requestIdentity,
      price: { amount: price, currency: 'KRW', priceKind, basis: priceBasis },
      shippingReadStatus: shippingStatus,
      shipping: shippingFee === null ? null : {
        sourceScope: 'consumer_public_offer_list',
        memberEligibilityVerified: false,
        fee: { amount: shippingFee, currency: 'KRW', priceKind: 'public_offer_list_shipping_fee', basis: 'public_offer_list' },
      },
    },
    states: { captured: true, client_exists: true, remnant_free: true, credential_propagated: false, live_replay: liveReplay },
  };
}

function makeHarness(outcomes, { contextLifetimeMs = 120_000, readDurationsMs = [] } = {}) {
  let now = 0;
  let contextCreations = 0;
  const context = Object.freeze({ testContext: true });
  const contextsSeen = [];
  const sleeps = [];
  const contextOptions = [];
  let reads = 0;
  const wallClock = () => 1_797_000_000_000;
  return {
    dependencies: {
      clock: () => now,
      wallClock,
      sleep: async milliseconds => { sleeps.push(milliseconds); now += milliseconds; },
      visitorContextMaxAgeMs: contextLifetimeMs,
      createVisitorContext: options => { contextCreations++; contextOptions.push(options); assert.equal(options.now(), wallClock()); return context; },
      readOfferList: async options => {
        contextsSeen.push(options.visitorContext);
        const readIndex = reads++;
        now += readDurationsMs[readIndex] ?? 0;
        const outcome = outcomes[readIndex];
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    },
    get contextCreations() { return contextCreations; },
    get contextsSeen() { return contextsSeen; },
    get sleeps() { return sleeps; },
    get contextOptions() { return contextOptions; },
    get readCount() { return reads; },
  };
}

test('four successful repeated reads share one no-rebootstrap visitor context', async () => {
  const harness = makeHarness([1, 2, 3, 4].map(ordinal => makeSuccess({ ordinal })));
  const result = await runCoupangReadDiagnostic({ targets: [target], repeat: 4, intervalMs: 0 }, harness.dependencies);

  assert.equal(result.passed, true);
  assert.deepEqual([result.plannedReads, result.attemptedReads, result.failedReads, result.unattemptedReads], [4, 4, 0, 0]);
  assert.deepEqual(result.reads.map(row => row.identity), [1, 2, 3, 4].map(() => identity));
  assert.equal(harness.contextCreations, 1);
  assert.equal(harness.contextOptions[0].allowRebootstrap, false);
  assert.equal(new Set(harness.contextsSeen).size, 1);
  assert.equal(result.reads[0].contextBootstrapStatus, 200);
  assert.deepEqual(result.reads.slice(1).map(row => row.contextBootstrapStatus), [null, null, null]);
  assert.equal(result.sameVisitorContextVerified, true);
  assert.equal(result.visitorBootstrapResponsesProjected, 1);
  assert.equal(result.fourthRequestPerCategoryHypothesis.assessment, 'not_assessed');
  assert.equal(result.fourthOrdinal403Observed, false);
  assert.equal(result.reads[0].shippingFeeKRW, null);
  assert.equal(result.reads[0].shippingReadStatus, 'absent');
});

test('fourth 403 is recorded and stops without retry or replacement context', async () => {
  const blocked = Object.assign(new Error('private server text must not escape'), {
    code: 'COUPANG_CONSUMER_OFFER_LIST_STATUS',
    receipt: receipt({ status: 403, ordinal: 4, transport: 'native_fetch' }),
  });
  const harness = makeHarness([
    makeSuccess({ ordinal: 1 }), makeSuccess({ ordinal: 2 }), makeSuccess({ ordinal: 3 }), blocked,
    makeSuccess({ ordinal: 4 }),
  ]);
  const result = await runCoupangReadDiagnostic({ targets: [target], repeat: 4, intervalMs: 0 }, harness.dependencies);

  assert.equal(result.stopReason, 'access_blocked_403');
  assert.deepEqual([result.plannedReads, result.attemptedReads, result.failedReads, result.unattemptedReads], [4, 4, 1, 0]);
  assert.equal(result.fourthInvoked, true);
  assert.equal(result.fourthOrdinal403Observed, true);
  assert.equal(harness.readCount, 4);
  assert.equal(harness.contextCreations, 1);
  assert.equal(result.reads[3].code, 'COUPANG_CONSUMER_OFFER_LIST_STATUS');
  assert.equal(JSON.stringify(result).includes('private server text'), false);
});

test('an early 403 stops before any later ordinal', async () => {
  const blocked = Object.assign(new Error('blocked'), { code: 'COUPANG_CONSUMER_OFFER_LIST_STATUS',
    receipt: receipt({ status: 403, ordinal: 1 }) });
  const harness = makeHarness([blocked, ...[2, 3, 4].map(ordinal => makeSuccess({ ordinal }))]);
  const result = await runCoupangReadDiagnostic({ targets: [target], repeat: 4, intervalMs: 0 }, harness.dependencies);

  assert.deepEqual([result.plannedReads, result.attemptedReads, result.failedReads, result.unattemptedReads], [4, 1, 1, 3]);
  assert.equal(harness.readCount, 1);
  assert.equal(result.fourthInvoked, false);
  assert.equal(result.states.live_replay, false);
});

test('fourth delay is measured from third completion and sleep is split into 30 second chunks', async () => {
  const harness = makeHarness([1, 2, 3, 4].map(ordinal => makeSuccess({ ordinal })),
    { contextLifetimeMs: 100_000, readDurationsMs: [110, 120, 130, 140] });
  const result = await runCoupangReadDiagnostic({ targets: [target], repeat: 4, intervalMs: 0, fourthDelaySeconds: 45 }, harness.dependencies);

  assert.equal(result.passed, true);
  assert.equal(result.actualFourthDelayMs, 45_000);
  assert.deepEqual(harness.sleeps, [30_000, 15_000]);
  assert.equal(result.reads[3].gapFromPriorCompletionMs, 45_000);
  assert.equal(harness.contextCreations, 1);
  assert.equal(harness.contextOptions[0].allowRebootstrap, false);
});

test('context lifetime guard leaves the fourth read unattempted', async () => {
  const harness = makeHarness([1, 2, 3, 4].map(ordinal => makeSuccess({ ordinal })), { contextLifetimeMs: 5000 });
  const result = await runCoupangReadDiagnostic({ targets: [target], repeat: 4, intervalMs: 0, fourthDelaySeconds: 10 }, harness.dependencies);

  assert.equal(result.stopReason, 'context_lifetime_guard');
  assert.deepEqual([result.plannedReads, result.attemptedReads, result.failedReads, result.unattemptedReads], [4, 3, 0, 1]);
  assert.equal(result.fourthInvoked, false);
  assert.equal(harness.readCount, 3);
  assert.deepEqual(harness.sleeps, []);
});

test('four distinct PDPs can use the bounded delay before ordinal four', async () => {
  const products = [
    { productId: '6247736560', itemId: '12646874013', vendorItemId: '79914317500' },
    { productId: '8245824385', itemId: '27239055720', vendorItemId: '94034890092' },
    { productId: '8837247802', itemId: '24983983526', vendorItemId: '95851464472' },
    { productId: '9354349642', itemId: '27981747687', vendorItemId: '94939514389' },
  ];
  const urls = products.map(row => `https://www.coupang.com/vp/products/${row.productId}?itemId=${row.itemId}&vendorItemId=${row.vendorItemId}`);
  const harness = makeHarness(products.map((requestIdentity, ordinal) => makeSuccess({ requestIdentity, ordinal: ordinal + 1 })),
    { contextLifetimeMs: 100_000 });
  const result = await runCoupangReadDiagnostic({ targets: urls, intervalMs: 0, fourthDelaySeconds: 30 }, harness.dependencies);

  assert.equal(result.passed, true);
  assert.deepEqual(result.reads.map(row => row.identity), products);
  assert.equal(result.actualFourthDelayMs, 30_000);
  assert.equal(harness.contextCreations, 1);
  assert.equal(new Set(harness.contextsSeen).size, 1);
});

test('native 403 response and native schema failure do not claim a successful live replay', async () => {
  const blocked = Object.assign(new Error('blocked'), { code: 'COUPANG_CONSUMER_OFFER_LIST_STATUS',
    receipt: receipt({ status: 403, transport: 'native_fetch' }) });
  const blockedResult = await runCoupangReadDiagnostic({ targets: [target] }, makeHarness([blocked]).dependencies);
  assert.equal(blockedResult.execution, 'pure_http');
  assert.equal(blockedResult.states.live_replay, false);
  assert.equal(blockedResult.reads[0].liveReplay, false);

  const invalidSchema = makeSuccess({ ordinal: 1, transport: 'native_fetch', liveReplay: true, priceKind: 'account_context_final_price' });
  const schemaResult = await runCoupangReadDiagnostic({ targets: [target] }, makeHarness([invalidSchema]).dependencies);
  assert.equal(schemaResult.stopReason, 'read_failed');
  assert.equal(schemaResult.states.live_replay, false);
  assert.equal(schemaResult.reads[0].liveReplay, false);
});

test('public general price and verified shipping require their exact evidence kinds', async () => {
  const harness = makeHarness([makeSuccess({ ordinal: 1, shippingStatus: 'verified', shippingFee: 0 })]);
  const result = await runCoupangReadDiagnostic({ targets: [target] }, harness.dependencies);

  assert.equal(result.passed, true);
  assert.equal(result.reads[0].generalPriceKRW, 11200);
  assert.equal(result.reads[0].shippingFeeKRW, 0);
  assert.equal(result.reads[0].memberPriceVerified, false);
});

test('invalid inputs fail before context creation or a request', async () => {
  const harness = makeHarness([]);
  await assert.rejects(runCoupangReadDiagnostic({ targets: [target, target], repeat: 2 }, harness.dependencies),
    error => error.code === 'COUPANG_READ_DIAGNOSTIC_INPUT_INVALID');
  await assert.rejects(runCoupangReadDiagnostic({ targets: [target], repeat: 4, fourthDelaySeconds: 601 }, harness.dependencies),
    error => error.code === 'COUPANG_READ_DIAGNOSTIC_INPUT_INVALID');
  await assert.rejects(runCoupangReadDiagnostic({ targets: ['https://evil.example/vp/products/1?itemId=2&vendorItemId=3'] }, harness.dependencies),
    error => error.code === 'COUPANG_READ_DIAGNOSTIC_INPUT_INVALID');
  assert.equal(harness.contextCreations, 0);
  assert.equal(harness.readCount, 0);
});

test('proof projection removes cookie, header and response body values', async () => {
  const harness = makeHarness([makeSuccess({ ordinal: 1 })]);
  const result = await runCoupangReadDiagnostic({ targets: [target] }, harness.dependencies);
  const serialized = JSON.stringify(result);
  const directProjection = projectCoupangReadProof(receipt(), identity);

  assert.equal(result.reads[0].proof.exactRequestIdentityMatched, true);
  assert.equal(directProjection.exactRequestIdentityMatched, true);
  assert.equal(JSON.stringify(directProjection).includes('DO_NOT_EXPOSE_COOKIE_SECRET'), false);
  assert.equal(serialized.includes('DO_NOT_EXPOSE_COOKIE_SECRET'), false);
  assert.equal(serialized.includes('DO_NOT_EXPOSE_AUTH_SECRET'), false);
  assert.equal(serialized.includes('DO_NOT_EXPOSE_RESPONSE_SECRET'), false);
  assert.equal(serialized.includes('DO_NOT_EXPOSE_BOOTSTRAP_SECRET'), false);
});

test('injected regression fixtures never claim a live replay', async () => {
  const harness = makeHarness([makeSuccess({ ordinal: 1, transport: 'injected' })]);
  const result = await runCoupangReadDiagnostic({ targets: [target] }, harness.dependencies);

  assert.equal(result.passed, true);
  assert.equal(result.execution, 'injected');
  assert.equal(result.executionMode, 'pure_http_client');
  assert.equal(result.reads[0].proof.transport, 'injected');
  assert.equal(result.reads[0].liveReplay, false);
  assert.equal(result.states.live_replay, false);
});
