import test from 'node:test';
import assert from 'node:assert/strict';
import { collectOfferSnapshot, normalizeOffer, offerKey, comparePriceSnapshots, compareDecimal, snapshotCsv } from '../lib/commerce/snapshots.mjs';
const time = '2026-10-05T01:00:00Z';
const offer = (id, amount = '12.50', extra = {}) => ({ provider: 'supplier', productId: id, title: 'Product '+id,
  price: { amount, currency: 'USD', kind: 'supplier_base' }, availability: 'unknown', observedAt: time,
  context: { region: 'USA' }, ...extra });
const snapshot = offers => ({ schema: 'web-api-product-price-snapshot-v1', offers });

test('traversal deduplicates overlaps and preserves the source limit boundary', async () => {
  const cursors = [];
  const result = await collectOfferSnapshot({ provider: 'supplier', maxOffers: 3, loadPage: async ({ cursor }) => {
    cursors.push(cursor);
    return cursor === null ? { offers: [offer('a'), offer('b')], coverage: 'paged_result', nextCursor: 2 }
      : { offers: [offer('b'), offer('c'), offer('d')], coverage: 'paged_result', nextCursor: null };
  } });
  assert.deepEqual(cursors, [null, 2]); assert.equal(result.offers.length, 3);
  assert.equal(result.collection.capHit, true); assert.equal(result.collection.complete, false);
});

test('a predictive sample stays incomplete even when it has no next cursor', async () => {
  const result = await collectOfferSnapshot({ provider: 'supplier', loadPage: async () => ({
    offers: [offer('a')], coverage: 'predictive_sample', nextCursor: null,
    receipts: [{ method: 'GET', httpStatus: 200, authorization: 'never-save', privateUrl: 'never-save' }],
  }) });
  assert.equal(result.collection.complete, false);
  assert.deepEqual(result.receipts, [{ method: 'GET', httpStatus: 200 }]);
});

test('pagination cycles and conflicting duplicate quotes fail instead of dropping evidence', async () => {
  await assert.rejects(collectOfferSnapshot({ provider: 'supplier', maxPages: 4,
    loadPage: async () => ({ offers: [], coverage: 'paged_result', nextCursor: 'repeat' }) }), { code: 'COLLECTION_PAGINATION_LOOP' });
  await assert.rejects(collectOfferSnapshot({ provider: 'supplier',
    loadPage: async () => ({ offers: [offer('a'), offer('a','13.00')], coverage: 'regional_feed' }) }), { code: 'COLLECTION_CONFLICTING_DUPLICATE' });
});

test('decimal prices stay exact and changes never compare different currencies or price roles', () => {
  assert.equal(compareDecimal('999999999999999999.12345678', '999999999999999999.12345677'), 1);
  assert.equal(compareDecimal('1.10', '1.1'), 0);
  const changes = comparePriceSnapshots(snapshot([offer('a'),offer('b')]), snapshot([
    offer('a','11.00'), offer('b','10.00',{ price: { amount:'10.00',currency:'EUR',kind:'supplier_base' } }),
    offer('c','13.00'),
  ]));
  assert.equal(changes.changes[0].priceDirection, 'decreased');
  assert.equal(changes.changes[1].type, 'first_observed');
  assert.equal(changes.missingMeansUnavailable, false);
});

test('currency ambiguity and ranges are retained without inventing a scalar offer', () => {
  const value = normalizeOffer(offer('a', null, { price: null,
    priceRange: { min: { amount:'1.00',currency:null,kind:'regional_catalog_base' }, max: { amount:'3.00',currency:null,kind:'regional_catalog_base' } } }));
  assert.equal(value.price, null); assert.equal(value.priceRange.min.currency, null);
  assert.throws(() => normalizeOffer(offer('a','1.0',{ price: { amount:1,currency:'USD',kind:'supplier_base' } })), { code:'OFFER_PRICE_INVALID' });
});

test('CSV quotes multiline delimiters and neutralizes spreadsheet formulas while JSON preserves source values', () => {
  const value = offer('a','1.00',{ title:'=HYPERLINK("url")' });
  const csv = snapshotCsv(snapshot([value]));
  assert.ok(csv.includes('"\'=HYPERLINK(""url"")"'));
  assert.equal(normalizeOffer(value).title, '=HYPERLINK("url")');
});

test('baseline duplicate IDs and credential-bearing collection context are invalid', () => {
  assert.throws(() => comparePriceSnapshots(snapshot([offer('a'),offer('a')]),snapshot([])), { code:'PRICE_BASELINE_DUPLICATE' });
  assert.throws(() => normalizeOffer(offer('a','1.00',{context:{accessToken:'never-save'}})), { code:'COLLECTION_CONTEXT_INVALID' });
});

test('currency-unknown quotes and partial responses cannot claim complete price collection', async () => {
  const currencyUnknown = await collectOfferSnapshot({ provider: 'supplier', loadPage: async () => ({
    offers: [offer('a','1.00',{price:{amount:'1.00',currency:null,kind:'regional_catalog_base'}})], coverage: 'regional_feed',
  }) });
  assert.equal(currencyUnknown.collection.currencyUnverifiedCount, 1);
  assert.equal(currencyUnknown.collection.complete, false);
  const partial = await collectOfferSnapshot({ provider: 'supplier', loadPage: async () => ({
    offers: [offer('a')], coverage: 'paged_result', partial: true, priceUnavailableCount: 2,
  }) });
  assert.equal(partial.collection.partialResponses, 1);
  assert.equal(partial.collection.priceUnavailableCount, 2);
  assert.equal(partial.collection.rowsSeen, 3);
  assert.equal(partial.collection.complete, false);
});

test('destination, marketplace, locale, seller and production context remain separate identities', () => {
  const original = normalizeOffer(offer('a'));
  for (const [key, value] of Object.entries({country:'DE',marketplace:'EBAY_DE',locale:'de_DE',advertiserId:'10',catalogId:'20',productionCurrency:'EUR',technique:'embroidery'})) {
    const changed = normalizeOffer(offer('a','12.50',{context:{region:'USA',[key]:value}}));
    assert.notEqual(offerKey(original),offerKey(changed),key);
  }
});

test('ambiguous currency quotes retain changes without asserting a monetary rise or fall',()=>{
  const a=offer('a','10.00',{price:{amount:'10.00',currency:null,kind:'regional_catalog_base'}});
  const b=offer('a','20.00',{price:{amount:'20.00',currency:null,kind:'regional_catalog_base'}});
  const result=comparePriceSnapshots(snapshot([a]),snapshot([b]));
  assert.equal(result.changes[0].priceDirection,'currency_unverified');
});

test('returned affiliate URLs survive JSON/CSV without asserting publisher attribution or final target',()=>{
  const value=normalizeOffer(offer('a','10.00',{affiliateUrl:'https://network.example/click?publisher=owned'}));
  assert.equal(value.affiliateLink.source,'api_returned');assert.equal(value.affiliateLink.attributionVerified,false);
  assert.equal(value.affiliateLink.finalTargetVerified,false);
  assert.ok(snapshotCsv(snapshot([value])).includes('https://network.example/click?publisher=owned'));
});
