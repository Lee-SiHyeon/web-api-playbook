import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOntologyDataset, validateOntologyDataset } from '../lib/cps-ontology-dataset.mjs';
import { queryDataset } from '../scripts/cps-reverify.mjs';

const observedAt = '2026-09-27T00:00:00.000Z';
const sha256 = 'a'.repeat(64);

function makeSourceMap(merchantIds) {
  return {
    checkedAt: observedAt,
    merchants: merchantIds.map(merchantId => ({
      affiliateProgram: {
        id: `linkprice:${merchantId}`,
        networkId: 'linkprice',
        merchantId,
        name: merchantId,
        siteUrl: `https://${merchantId}.example/`,
      },
    })),
  };
}

function makeReceipt(receiptId, overrides = {}) {
  return {
    receiptId,
    method: 'GET',
    requestUrl: 'https://shop.example/product/sku-1',
    finalUrl: 'https://shop.example/product/sku-1',
    httpStatus: 200,
    contentType: 'text/html; charset=utf-8',
    responseSha256: sha256,
    checkedAt: observedAt,
    browserUsed: false,
    cookiesSent: false,
    authorizationSent: false,
    ...overrides,
  };
}

function makeRecord(receiptId, fields = {}) {
  return {
    type: 'RetailProduct',
    sourceLocalId: 'sku-1',
    title: 'Observed item',
    url: 'https://shop.example/product/sku-1',
    evidence: [{ receiptId, locator: 'JSON-LD Product', fields: ['sourceLocalId', 'url', 'title', ...Object.keys(fields)] }],
    ...fields,
  };
}

function build({ merchantIds = ['merchant'], crosswalk = { mappings: [] }, reports, generatedAt = observedAt } = {}) {
  const batches = reports.map(({ batchId = '01', ...report }) => ({ batchId, checkedAt: observedAt, merchants: [report] }));
  return buildOntologyDataset({ sourceMap: makeSourceMap(merchantIds), crosswalk, batches, generatedAt });
}

test('shared consumer source preserves separate affiliate programs and produces a closed graph', () => {
  const reports = ['gmarket', 'gmarket2'].map((merchantId, index) => ({
    merchantId,
    status: 'records_observed',
    receipts: [makeReceipt(`receipt-${merchantId}`)],
    records: [makeRecord(`receipt-${merchantId}`, { price: { amount: index ? '1.234' : 0, currency: index ? 'KWD' : 'KRW' } })],
  }));
  const dataset = build({
    merchantIds: ['gmarket', 'gmarket2'],
    crosswalk: { mappings: [
      { merchantId: 'gmarket', consumerSourceId: 'gmarket' },
      { merchantId: 'gmarket2', consumerSourceId: 'gmarket' },
    ] },
    reports,
  });

  assert.deepEqual(validateOntologyDataset(dataset, { expectedMerchants: 2 }), { ok: true, errors: [] });
  assert.equal(dataset.entities.consumerSources.length, 1);
  assert.deepEqual(new Set(dataset.entities.consumerSources[0].affiliateProgramIds), new Set(['linkprice:gmarket', 'linkprice:gmarket2']));
  assert.equal(dataset.entities.commercialOfferings.length, 1);
  assert.deepEqual(new Set(dataset.entities.commercialOfferings[0].affiliateProgramIds), new Set(['linkprice:gmarket', 'linkprice:gmarket2']));
  assert.deepEqual(dataset.entities.offerObservations.map(row => [row.amount, row.currency, row.amountMinor]), [
    ['0', 'KRW', 0], ['1.234', 'KWD', 1234],
  ]);
});

test('unknown currency and missing rating data stay unknown', () => {
  const dataset = build({ reports: [{
    merchantId: 'merchant',
    status: 'records_observed',
    receipts: [makeReceipt('receipt-1')],
    records: [makeRecord('receipt-1', { price: { amount: 19.9, listAmount: 29.9, currency: null } })],
  }] });

  const [price] = dataset.entities.offerObservations;
  assert.equal(price.amount, '19.9');
  assert.equal(price.currency, null);
  assert.equal(price.amountMinor, null);
  assert.equal(price.listAmount, '29.9');
  assert.equal(price.listAmountMinor, null);
  assert.equal(price.availability, 'unknown');
  assert.equal(dataset.entities.ratingAggregates.length, 0);
});

test('unassigned three-letter currency codes do not generate ISO minor units', () => {
  const dataset = build({ reports: [{
    merchantId: 'merchant',
    status: 'records_observed',
    receipts: [makeReceipt('receipt-1')],
    records: [makeRecord('receipt-1', { price: { amount: '1.23', currency: 'ABC' } })],
  }] });

  const [price] = dataset.entities.offerObservations;
  assert.equal(price.amountMinor, null);
  assert.equal(price.currency, null);
});

test('price values are not exported when the evidence only supports the title', () => {
  const record = makeRecord('receipt-1', {
    price: { amount: 12900, currency: 'KRW' },
    evidence: [{ receiptId: 'receipt-1', locator: 'JSON-LD Product.name and sku', fields: ['title', 'sourceLocalId'] }],
  });
  const dataset = build({ reports: [{
    merchantId: 'merchant',
    status: 'records_observed',
    receipts: [makeReceipt('receipt-1')],
    records: [record],
  }] });

  assert.equal(dataset.entities.commercialOfferings.length, 1);
  assert.equal(dataset.entities.offerObservations.length, 0);
});

test('observed zero review counts are retained while reviewer text and identity are omitted', () => {
  const dataset = build({ reports: [{
    merchantId: 'merchant',
    status: 'records_observed',
    receipts: [makeReceipt('receipt-1')],
    records: [makeRecord('receipt-1', {
      rating: { value: 0, reviewCount: 0, ratingCount: 0 },
      reviewSamples: [{
        rating: 0,
        title: 'Reviewer name and order 123456',
        body: 'Contact reviewer@example.com or 010-1234-5678',
        reviewer: 'Reviewer name',
        reviewerIdentity: 'user-123',
        author: 'Reviewer name',
        helpfulCount: 0,
      }],
    })],
  }] });

  const [rating] = dataset.entities.ratingAggregates;
  assert.deepEqual([rating.ratingValue, rating.reviewCount, rating.ratingCount], [null, 0, 0]);
  assert.equal(rating.sourceMetrics.displayedZeroValue, 0);
  const [review] = dataset.entities.reviewObservations;
  assert.equal(review.ratingValue, 0);
  assert.equal(review.helpfulCount, 0);
  assert.equal(review.body, null);
  assert.equal(review.reviewerIdentity, null);
  assert.equal(Object.hasOwn(review, 'reviewer'), false);
  assert.equal(Object.hasOwn(review, 'author'), false);
  assert.equal(Object.hasOwn(review, 'title'), true);
  assert.equal(review.title, null);
});

test('records tied to a blocked or credentialed receipt are quarantined', () => {
  const dataset = build({ reports: [{
    merchantId: 'merchant',
    status: 'blocked',
    receipts: [makeReceipt('blocked-receipt', { httpStatus: 403, responseSha256: null })],
    records: [makeRecord('blocked-receipt', { price: { amount: 1000, currency: 'KRW' } })],
  }] });

  assert.equal(dataset.entities.commercialOfferings.length, 0);
  assert.equal(dataset.quarantine.length, 1);
  assert.equal(dataset.quarantine[0].reason, 'public_receipt_or_locator_missing');
  assert.equal(validateOntologyDataset(dataset, { expectedMerchants: 1 }).ok, true);
});

test('duplicate merchant reports are rejected instead of silently merged', () => {
  const report = {
    merchantId: 'merchant', status: 'records_observed',
    receipts: [makeReceipt('receipt-1')], records: [makeRecord('receipt-1')],
  };
  assert.throws(() => build({
    merchantIds: ['merchant'], crosswalk: { mappings: [] },
    reports: [{ ...report, batchId: '01' }, { ...report, batchId: '02' }],
  }), /DUPLICATE_MERCHANT_REPORT:merchant/);
});

test('anonymous bootstrap provenance remains closed in paginated merchant queries', () => {
  const dataset = build({ reports: [{
    merchantId: 'merchant', status: 'records_observed',
    receipts: [makeReceipt('config'), makeReceipt('bootstrap', { publicClientConfigReceiptId: 'config' }), makeReceipt('data', {
      publicRequestTokenSent: true, bootstrapReceiptId: 'bootstrap',
      publicClientHeaderSent: true, configReceiptId: 'config',
      anonymousBootstrap: { kind: 'public_anonymous_bootstrap', issuedWithoutAccount: true, retention: 'memory_only' },
    })],
    records: [makeRecord('data'), { ...makeRecord('data'), sourceLocalId: 'sku-2', title: 'Second observed item' }],
  }] });
  assert.deepEqual(validateOntologyDataset(dataset, { expectedMerchants: 1 }), { ok: true, errors: [] });
  const result = queryDataset(dataset, 'merchant', { limit: 1 });
  assert.equal(result.total, 2);
  assert.equal(result.nextOffset, 1);
  assert.deepEqual(new Set(result.receipts.map(row => row.originalId)), new Set(['data', 'bootstrap', 'config']));
  const second = queryDataset(dataset, 'merchant', { limit: 1, offset: 1 });
  assert.equal(second.offerings[0].sourceLocalId, 'sku-2');
  assert.equal(second.nextOffset, null);
});

test('a claimed public request token without its anonymous issuance evidence fails validation', () => {
  const dataset = build({ reports: [{
    merchantId: 'merchant', status: 'records_observed',
    receipts: [makeReceipt('data', { publicRequestTokenSent: true, bootstrapReceiptId: 'missing', publicClientHeaderSent: true })],
    records: [makeRecord('data')],
  }] });
  const result = validateOntologyDataset(dataset, { expectedMerchants: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.errors.some(value => value.startsWith('invalid_bootstrapReceiptId:')), true);
  assert.equal(result.errors.some(value => value.startsWith('anonymous_bootstrap_proof_missing:')), true);
  assert.equal(result.errors.some(value => value.startsWith('public_client_config_proof_missing:')), true);
});

test('only the maintained owner-verified Coupang web catalog admits protected-session evidence', () => {
  const receipt = makeReceipt('protected', { requestUrl: 'https://partners.coupang.com/api/v1/search', finalUrl: 'https://partners.coupang.com/api/v1/search',
    method: 'POST', cookiesSent: true, authenticationMode: 'protected_first_party_session', credentialProvider: 'windows_dpapi', ownerReadbackVerified: true });
  const input = overrides => build({ merchantIds: ['coupang'], crosswalk: { mappings: [{ merchantId: 'coupang', consumerSourceId: 'coupang' }] }, reports: [{
    merchantId: 'coupang', status: 'records_observed', receipts: [{ ...receipt, ...overrides }], records: [makeRecord('protected')],
  }] });
  const verified = input({});
  assert.equal(verified.entities.commercialOfferings.length, 1);
  assert.equal(verified.scope.credentialsRequired, true);
  assert.deepEqual(verified.scope.protectedSourceIds, ['coupang']);
  assert.equal(validateOntologyDataset(verified, { expectedMerchants: 1 }).ok, true);
  for (const overrides of [{ ownerReadbackVerified: false }, { credentialProvider: null }, { requestUrl: 'https://www.coupang.com/np/search' }, { authorizationSent: null }]) {
    assert.equal(input(overrides).entities.commercialOfferings.length, 0);
  }
});

test('unsupported source identifiers and schema types are omitted while an evidenced URL remains usable', () => {
  const record = makeRecord('receipt-1', { sourceSchemaType: 'Product',
    evidence: [{ receiptId: 'receipt-1', locator: 'a.product-link', fields: ['title', 'url'] }],
  });
  const dataset = build({ reports: [{ merchantId: 'merchant', status: 'records_observed', receipts: [makeReceipt('receipt-1')], records: [record] }] });
  const [offering] = dataset.entities.commercialOfferings;
  assert.equal(offering.identityScope, 'source_url');
  assert.equal(offering.sourceLocalId, null);
  assert.equal(offering.sourceSchemaType, null);
  assert.equal(offering.canonicalUrl, record.url);
});

test('structured accommodation dates survive normalization without asserting a nightly price', () => {
  const dataset = build({ reports: [{ merchantId: 'merchant', status: 'records_observed', receipts: [makeReceipt('stay')],
    records: [makeRecord('stay', { price: { amount: 151593, currency: 'KRW', priceKind: 'date_conditioned_accommodation_quote',
      condition: { checkIn: '2026-12-13', checkOut: '2026-12-14' }, qualifiers: ['nightly_vs_stay_total_not_established'] } })],
  }] });
  const [price] = dataset.entities.offerObservations;
  assert.deepEqual(price.conditions, { checkIn: '2026-12-13', checkOut: '2026-12-14' });
  assert.deepEqual(price.qualifiers, ['nightly_vs_stay_total_not_established']);
  assert.equal(price.discountCondition, null);
  assert.equal(price.amountMinor, 151593);
});

test('entity property references are checked in addition to relation endpoints', () => {
  const dataset = build({ reports: [{ merchantId: 'merchant', status: 'records_observed', receipts: [makeReceipt('p')],
    records: [makeRecord('p', { price: { amount: 100, currency: 'KRW' } })],
  }] });
  dataset.entities.offerObservations[0].offeringId = 'missing';
  const result = validateOntologyDataset(dataset, { expectedMerchants: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.errors.some(error => error.startsWith('reference_missing:offeringId:')), true);
});

test('discount adjustments and reference amounts retain their roles without counting as sale quotes', () => {
  const dataset = build({ reports: [{ merchantId: 'merchant', status: 'records_observed', receipts: [makeReceipt('prices')],
    records: [makeRecord('prices', { offers: [
      { type: 'CouponAdjustment', amount: 0, currency: 'KRW' },
      { type: 'OriginalSalePrice', amount: 20000, currency: 'KRW' },
      { type: 'customerPrice', amount: 15000, currency: 'KRW' },
      { sourceOfferType: 'finalPrice', amount: 12000, currency: 'KRW' },
    ] })],
  }] });
  assert.deepEqual(dataset.entities.offerObservations.map(price => [price.sourceOfferType, price.priceKind, price.priceRole]), [
    ['CouponAdjustment', 'CouponAdjustment', 'adjustment'],
    ['OriginalSalePrice', 'OriginalSalePrice', 'reference'],
    ['customerPrice', 'customerPrice', 'source_secondary_price'],
    ['finalPrice', 'finalPrice', 'quoted_price'],
  ]);
  assert.equal(dataset.coverage[0].counts.prices, 1);
  assert.equal(dataset.entities.offerObservations[0].amountMinor, 0);
});

test('observed option names and duration conditions survive variant normalization', () => {
  const dataset = build({ reports: [{ merchantId: 'merchant', status: 'records_observed', receipts: [makeReceipt('options')],
    records: [makeRecord('options', { variants: [{ name: 'Daily 1 GB', text: '1 GB each day, reduced speed afterwards',
      price: { amount: 1100, currency: 'KRW', conditions: { selectedDays: 1 } },
    }] })],
  }] });
  const [variant] = dataset.entities.productVariants;
  assert.equal(variant.title, 'Daily 1 GB');
  assert.equal(variant.description, '1 GB each day, reduced speed afterwards');
  assert.equal(variant.identityScope, 'observed_option_label');
  assert.deepEqual(dataset.entities.offerObservations[0].conditions, { selectedDays: 1 });
  assert.equal(validateOntologyDataset(dataset, { expectedMerchants: 1 }).ok, true);
});

test('product specifications remain attributes rather than becoming purchasable variants', () => {
  const attributes = [{ name: 'Cooling area', value: '29.3 m2' }, { name: 'Motor', value: 'dual inverter' }];
  const dataset = build({ reports: [{ merchantId: 'merchant', status: 'records_observed', receipts: [makeReceipt('specs')],
    records: [makeRecord('specs', { attributes, variants: [] })],
  }] });
  assert.deepEqual(dataset.entities.commercialOfferings[0].attributes, attributes);
  assert.equal(dataset.entities.productVariants.length, 0);
});

test('catalog flags without an option identity do not create purchasable variants', () => {
  const dataset = build({ reports: [{ merchantId: 'merchant', status: 'records_observed', receipts: [makeReceipt('flags')],
    records: [makeRecord('flags', { variants: [
      { type: 'offerBundle', isCheaperThanRoaming: true, hasLimitedOption: false },
      { name: 'Daily 1 GB', price: { amount: 1100, currency: 'KRW' } },
    ] })],
  }] });
  assert.equal(dataset.entities.productVariants.length, 1);
  assert.equal(dataset.entities.productVariants[0].title, 'Daily 1 GB');
  assert.equal(dataset.entities.offerObservations.length, 1);
  assert.equal(dataset.coverage[0].counts.variants, 1);
});

test('an unrated zero display is retained as a source metric, while an explicit nonempty zero-rating population survives', () => {
  for (const [ratingCount, expected] of [[null, null], [0, null], [2, 0]]) {
    const dataset = build({ reports: [{ merchantId: 'merchant', status: 'records_observed', receipts: [makeReceipt('ratings')],
      records: [makeRecord('ratings', { rating: { value: 0, reviewCount: 0, ratingCount } })],
    }] });
    const [rating] = dataset.entities.ratingAggregates;
    assert.equal(rating.ratingValue, expected);
    assert.equal(rating.reviewCount, 0);
    assert.equal(rating.ratingCount, ratingCount);
    if (expected === null) assert.equal(rating.sourceMetrics.displayedZeroValue, 0);
  }
});

test('activity and digital publication adapter types retain their offering families', () => {
  for (const [type, expected] of [['TravelActivity', 'TravelOffering'], ['DigitalPublication', 'DigitalContent'], ['WebtoonSeries', 'DigitalContent']]) {
    const dataset = build({ reports: [{ merchantId: 'merchant', status: 'records_observed', receipts: [makeReceipt('type')],
      records: [makeRecord('type', { type })],
    }] });
    assert.equal(dataset.entities.commercialOfferings[0].offeringType, expected);
  }
});
