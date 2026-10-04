import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COUPANG_PUBLIC_PRICE_MAX_ITEMS,
  COUPANG_PUBLIC_PRICE_DEFAULT_SPACING_MS,
  parseCoupangPublicPriceManifestJson,
  validateCoupangPublicPriceManifest,
  validateCoupangPublicPriceSpacing,
  verifyCoupangPublicPriceFrontier,
} from '../lib/coupang-public-price-verification.mjs';

const makeItem = (productId, itemId, vendorItemId, extra = {}) => ({
  productUrl: `https://www.coupang.com/vp/products/${productId}?itemId=${itemId}&vendorItemId=${vendorItemId}`,
  productId,
  itemId,
  vendorItemId,
  ...extra,
});

const makeManifest = (items, sourceMetadata = { frontierSource: 'browser_dom_option_map', capturedAt: '2026-10-03T01:00:00.000Z' }) => ({
  schemaVersion: 1,
  sourceMetadata,
  items,
});

const offerListResult = (item, amount, overrides = {}) => {
  const { selectedOffer: selectedOfferOverrides = {}, ...resultOverrides } = overrides;
  const identity = {
    productId: item.productId,
    itemId: item.itemId,
    vendorItemId: item.vendorItemId,
    selected: true,
  };
  return {
    productId: item.productId,
    itemId: item.itemId,
    selectedVendorItemId: item.vendorItemId,
    selectedOffer: {
      ...identity,
      price: { amount, currency: 'KRW', priceKind: 'offer_list_general_sale_price', basis: 'public_offer_list' },
      shipping: { amount: 9900, currency: 'KRW' },
      shippingReadStatus: 'conditional_unverified',
      rawResponse: 'SHOULD_NOT_BE_COPIED',
      ...selectedOfferOverrides,
    },
    receipt: { status: 200, transport: 'native_fetch', ownerCredentialUsed: false,
      visitorBootstrap: { status: 200, cookie: 'SHOULD_NOT_BE_COPIED' },
      responseText: 'SHOULD_NOT_BE_COPIED', requestUrl: item.productUrl },
    states: { live_replay: true },
    rawResponse: 'SHOULD_NOT_BE_COPIED',
    ...resultOverrides,
  };
};

function makeForbiddenError(status) {
  return Object.assign(new Error('UNSAFE ERROR MESSAGE MUST NOT BE COPIED'), {
    code: status === 429 ? 'COUPANG_CONSUMER_RATE_LIMITED' : 'COUPANG_CONSUMER_ACCESS_BLOCKED',
    receipt: { status, transport: 'native_fetch', ownerCredentialUsed: false,
      responseText: 'SHOULD_NOT_BE_COPIED', requestUrl: 'https://opaque.invalid/private' },
  });
}

test('validates strict source metadata, exact canonical URLs, identity uniqueness, and price bounds', () => {
  const valid = makeManifest([makeItem('100', '200', '300', { expectedGeneralPriceKrw: 5000 })]);
  assert.deepEqual(validateCoupangPublicPriceManifest(valid).items[0], {
    ...valid.items[0], expectedGeneralPriceKrw: 5000,
  });
  assert.equal(validateCoupangPublicPriceSpacing(), COUPANG_PUBLIC_PRICE_DEFAULT_SPACING_MS);
  assert.equal(validateCoupangPublicPriceSpacing(300_000), 300_000);
  assert.equal(parseCoupangPublicPriceManifestJson(JSON.stringify(valid)).items.length, 1);
  assert.throws(() => validateCoupangPublicPriceSpacing(19_999), { code: 'SPACING_OUT_OF_RANGE' });
  assert.throws(() => validateCoupangPublicPriceSpacing(300_001), { code: 'SPACING_OUT_OF_RANGE' });
  assert.throws(() => validateCoupangPublicPriceManifest(makeManifest([], valid.sourceMetadata)), { code: 'FRONTIER_EMPTY' });
  assert.throws(() => validateCoupangPublicPriceManifest(makeManifest([
    makeItem('100', '200', '300'), makeItem('100', '200', '300'),
  ])), { code: 'DUPLICATE_SKU' });
  assert.throws(() => validateCoupangPublicPriceManifest(makeManifest([
    makeItem('100', '200', '300', { unexpected: true }),
  ])), { code: 'SKU_SCHEMA' });
  assert.throws(() => validateCoupangPublicPriceManifest({ ...valid, extra: 'not allowed' }), { code: 'MANIFEST_SCHEMA' });
  assert.throws(() => validateCoupangPublicPriceManifest(makeManifest(valid.items,
    { frontierSource: 'freeform text from a URL' })), { code: 'SOURCE_METADATA_INVALID' });
  assert.throws(() => validateCoupangPublicPriceManifest(makeManifest(valid.items,
    { frontierSource: 'browser_dom_option_map', capturedAt: 'yesterday' })), { code: 'SOURCE_METADATA_INVALID' });
  assert.throws(() => validateCoupangPublicPriceManifest(makeManifest([
    makeItem('100', '200', '300', { expectedGeneralPriceKrw: 0 }),
  ])), { code: 'EXPECTED_PRICE_INVALID' });
});

test('rejects out-of-scope or noncanonical URLs and oversize frontiers before any reader call', async () => {
  const valid = makeItem('100', '200', '300');
  const invalidItems = [
    { ...valid, productUrl: 'https://evil.example/vp/products/100?itemId=200&vendorItemId=300' },
    { ...valid, productUrl: 'https://www.coupang.com/vp/products/100?vendorItemId=300&itemId=200' },
    { ...valid, productUrl: `${valid.productUrl}&sourceType=goldbox` },
    { ...valid, productUrl: `${valid.productUrl}&itemId=200` },
    { ...valid, productUrl: valid.productUrl.replace('/products/100?', '/products/101?') },
    { ...valid, vendorItemId: '0300' },
  ];
  let readerCalls = 0;
  let sleepCalls = 0;
  const options = {
    live: true,
    visitorContext: {},
    readOfferList: async () => { readerCalls += 1; throw new Error('reader should not be called'); },
    sleep: async () => { sleepCalls += 1; },
  };
  for (const item of invalidItems) {
    await assert.rejects(verifyCoupangPublicPriceFrontier(makeManifest([item]), options));
  }
  await assert.rejects(verifyCoupangPublicPriceFrontier(makeManifest([]), options), { code: 'FRONTIER_EMPTY' });
  await assert.rejects(verifyCoupangPublicPriceFrontier({ ...makeManifest([valid]), extra: true }, options),
    { code: 'MANIFEST_SCHEMA' });
  await assert.rejects(verifyCoupangPublicPriceFrontier(makeManifest([
    valid, { ...valid },
  ]), options), { code: 'DUPLICATE_SKU' });
  await assert.rejects(verifyCoupangPublicPriceFrontier(makeManifest([
    { ...valid, unexpected: 'field' },
  ]), options), { code: 'SKU_SCHEMA' });
  const tooMany = Array.from({ length: COUPANG_PUBLIC_PRICE_MAX_ITEMS + 1 }, (_, index) =>
    makeItem(String(1000 + index), String(2000 + index), String(3000 + index)));
  await assert.rejects(verifyCoupangPublicPriceFrontier(makeManifest(tooMany), options), { code: 'FRONTIER_TOO_LARGE' });
  await assert.rejects(verifyCoupangPublicPriceFrontier(makeManifest([valid]), { ...options, spacingMs: 19_999 }),
    { code: 'SPACING_OUT_OF_RANGE' });
  assert.equal(readerCalls, 0);
  assert.equal(sleepCalls, 0);
});

test('dry-run validates without creating visitor state, waiting, or calling the reader', async () => {
  let readerCalls = 0;
  let sleepCalls = 0;
  const item = makeItem('100', '200', '300');
  const report = await verifyCoupangPublicPriceFrontier(makeManifest([item]), {
    readOfferList: async () => { readerCalls += 1; throw new Error('network forbidden in dry-run'); },
    sleep: async () => { sleepCalls += 1; },
  });
  assert.equal(report.status, 'validated_only');
  assert.equal(report.passed, false);
  assert.equal(report.attemptedCount, 0);
  assert.equal(report.unattemptedCount, 1);
  assert.equal(report.frontierEnumerationComplete, false);
  assert.equal(report.states.live_replay, false);
  assert.equal(readerCalls, 0);
  assert.equal(sleepCalls, 0);
});

test('a native HTTP 200 without normalized exact-SKU price evidence is not a verified read', async () => {
  const item = makeItem('100', '200', '300');
  const report = await verifyCoupangPublicPriceFrontier(makeManifest([item]), {
    live: true,
    visitorContext: {},
    readOfferList: async () => ({ receipt: { status: 200, transport: 'native_fetch' } }),
    sleep: async () => {},
  });
  assert.equal(report.rows[0].httpStatus, 200);
  assert.equal(report.rows[0].status, 'identity_mismatch');
  assert.equal(report.rows[0].selectedIdentityMatched, false);
  assert.equal(report.rows[0].observedGeneralPriceKrw, null);
  assert.equal(report.rows[0].priceVerified, false);
  assert.equal(report.verifiedPriceCount, 0);
  assert.equal(report.states.live_replay, false);
});

test('actual CLI dry-run revalidates a manifest with omitted optional metadata and price, without a reader call', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'coupang-public-prices-'));
  const manifestPath = join(directory, 'frontier.json');
  const manifest = {
    schemaVersion: 1,
    sourceMetadata: { frontierSource: 'user_supplied_exact_skus' },
    items: [makeItem('100', '200', '300')],
  };
  await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
  const scriptPath = fileURLToPath(new URL('../scripts/verify-coupang-public-prices.mjs', import.meta.url));
  let calls = 0;
  const oldLog = console.log;
  const oldError = console.error;
  const output = [];
  const errors = [];
  try {
    console.log = line => output.push(String(line));
    console.error = line => errors.push(String(line));
    const { main } = await import('../scripts/verify-coupang-public-prices.mjs');
    const code = await main(['--manifest', manifestPath, '--dry-run'], {
      readOfferList: async () => { calls += 1; throw new Error('HTTP is not allowed in this test'); },
      sleep: async () => { throw new Error('wait is not allowed in this test'); },
    });
    assert.equal(code, 3);
  } finally {
    console.log = oldLog;
    console.error = oldError;
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(errors.length, 0);
  assert.equal(output.length, 1);
  const report = JSON.parse(output[0]);
  assert.equal(report.status, 'validated_only');
  assert.equal(report.passed, false);
  assert.equal(report.providedFrontierCount, 1);
  assert.equal(report.unattemptedCount, 1);
  assert.equal(report.frontierEnumerationComplete, false);
  assert.equal(report.browserUsed, false);
  assert.equal(report.ownerCredentialUsed, false);
  assert.equal(calls, 0);
});

test('verifies exact selected identity and price, while expected-price drift stays explicit and safe', async () => {
  const rows = [
    makeItem('100', '200', '300', { expectedGeneralPriceKrw: 5000 }),
    makeItem('101', '201', '301', { expectedGeneralPriceKrw: 6000 }),
  ];
  const calls = [];
  const waits = [];
  const sharedVisitorContext = {};
  const report = await verifyCoupangPublicPriceFrontier(makeManifest(rows), {
    live: true,
    visitorContext: sharedVisitorContext,
    readOfferList: async options => {
      calls.push(options);
      const item = rows[calls.length - 1];
      return offerListResult(item, calls.length === 1 ? 5000 : 6250);
    },
    sleep: async milliseconds => { waits.push(milliseconds); },
  });
  assert.deepEqual(calls.map(row => row.url), rows.map(row => row.productUrl));
  assert.ok(calls.every(row => row.authentication === 'visitor' && row.visitorContext === sharedVisitorContext));
  assert.deepEqual(waits, [20_000]);
  assert.equal(report.status, 'partial');
  assert.equal(report.passed, false);
  assert.equal(report.rows[0].status, 'verified');
  assert.equal(report.rows[0].observedGeneralPriceKrw, 5000);
  assert.equal(report.rows[0].expectedPriceMatched, true);
  assert.equal(report.rows[1].status, 'expected_price_mismatch');
  assert.equal(report.rows[1].observedGeneralPriceKrw, 6250);
  assert.equal(report.rows[1].expectedPriceMatched, false);
  assert.equal(report.rows[1].priceVerified, false);
  assert.equal(report.rows[0].shippingReadStatus, 'conditional_unverified');
  assert.equal(report.rows[0].shipping, undefined);
  assert.equal(report.nativeOfferReadCount, 2);
  assert.equal(report.states.live_replay, true);
  assert.equal(report.frontierEnumerationComplete, false);
  assert.equal(report.allRetailerPricePathsComplete, false);
  assert.equal(report.browserUsed, false);
  assert.equal(report.ownerCredentialUsed, false);
  const serialized = JSON.stringify(report);
  for (const forbidden of ['SHOULD_NOT_BE_COPIED', 'opaque.invalid', 'responseText', 'requestUrl'])
    assert.equal(serialized.includes(forbidden), false);
});

test('stops at the first 403, keeps it unpriced, and marks later SKUs unattempted', async () => {
  const rows = [makeItem('100', '200', '300'), makeItem('101', '201', '301'), makeItem('102', '202', '302')];
  let readerCalls = 0;
  const waits = [];
  const report = await verifyCoupangPublicPriceFrontier(makeManifest(rows), {
    live: true,
    visitorContext: {},
    readOfferList: async () => {
      readerCalls += 1;
      if (readerCalls === 1) return offerListResult(rows[0], 5000);
      throw makeForbiddenError(403);
    },
    sleep: async milliseconds => { waits.push(milliseconds); },
  });
  assert.equal(readerCalls, 2);
  assert.deepEqual(waits, [20_000]);
  assert.equal(report.status, 'partial');
  assert.equal(report.passed, false);
  assert.equal(report.haltReason, 'access_blocked');
  assert.equal(report.blocked403Count, 1);
  assert.equal(report.rows[1].status, 'blocked_403');
  assert.equal(report.rows[1].observedGeneralPriceKrw, null);
  assert.equal(report.rows[1].priceVerified, false);
  assert.equal(report.rows[2].status, 'unattempted');
  assert.equal(report.rows[2].attempted, false);
  assert.equal(report.unattemptedCount, 1);
  assert.equal(JSON.stringify(report).includes('UNSAFE ERROR MESSAGE'), false);
  assert.equal(JSON.stringify(report).includes('opaque.invalid'), false);
});

test('stops at the first 429 without retrying or spacing subsequent requests', async () => {
  const rows = [makeItem('100', '200', '300'), makeItem('101', '201', '301'), makeItem('102', '202', '302')];
  let readerCalls = 0;
  let sleepCalls = 0;
  const report = await verifyCoupangPublicPriceFrontier(makeManifest(rows), {
    live: true,
    visitorContext: {},
    readOfferList: async () => { readerCalls += 1; throw makeForbiddenError(429); },
    sleep: async () => { sleepCalls += 1; },
  });
  assert.equal(readerCalls, 1);
  assert.equal(sleepCalls, 0);
  assert.equal(report.status, 'failed');
  assert.equal(report.haltReason, 'rate_limited');
  assert.equal(report.retryCount, 0);
  assert.equal(report.rateLimitedCount, 1);
  assert.equal(report.rows[0].observedGeneralPriceKrw, null);
  assert.equal(report.rows[1].status, 'unattempted');
  assert.equal(report.rows[2].status, 'unattempted');
  assert.equal(report.unattemptedCount, 2);
});

test('403-only responses do not claim verified live price replay', async () => {
  const rows = [makeItem('100', '200', '300'), makeItem('101', '201', '301')];
  let calls = 0;
  const report = await verifyCoupangPublicPriceFrontier(makeManifest(rows), {
    live: true,
    visitorContext: {},
    readOfferList: async () => { calls += 1; throw makeForbiddenError(403); },
    sleep: async () => {},
  });
  assert.equal(calls, 1);
  assert.equal(report.status, 'failed');
  assert.equal(report.nativeOfferReadCount, 1);
  assert.equal(report.states.live_replay, false);
  assert.equal(report.rows[0].observedGeneralPriceKrw, null);
  assert.equal(report.rows[1].status, 'unattempted');
});

test('rejects nonpositive, non-KRW, and identity-drifted normalized responses', async () => {
  const rows = [makeItem('100', '200', '300'), makeItem('101', '201', '301'), makeItem('102', '202', '302'),
    makeItem('103', '203', '303'), makeItem('104', '204', '304')];
  let call = 0;
  const report = await verifyCoupangPublicPriceFrontier(makeManifest(rows), {
    live: true,
    visitorContext: {},
    readOfferList: async () => {
      call += 1;
      if (call === 1) return offerListResult(rows[0], 0);
      if (call === 2) return offerListResult(rows[1], 5000, { selectedOffer: { productId: '999' } });
      if (call === 3) return offerListResult(rows[2], 4000,
        { selectedOffer: { price: { amount: 4000, currency: 'KRW', priceKind: 'coupon_price', basis: 'public_offer_list' } } });
      if (call === 4) return offerListResult(rows[3], 4000,
        { selectedOffer: { price: { amount: 4000, currency: 'KRW', priceKind: 'unknown_kind', basis: 'public_offer_list' } } });
      return offerListResult(rows[4], 4000,
        { selectedOffer: { price: { amount: 4000, currency: 'USD', priceKind: 'offer_list_general_sale_price', basis: 'public_offer_list' } } });
    },
    sleep: async () => {},
  });
  assert.deepEqual(report.rows.map(row => row.status), ['invalid_price', 'identity_mismatch', 'invalid_price', 'invalid_price', 'invalid_price']);
  assert.ok(report.rows.every(row => row.observedGeneralPriceKrw === null && !row.priceVerified));
  assert.equal(report.status, 'failed');
});
