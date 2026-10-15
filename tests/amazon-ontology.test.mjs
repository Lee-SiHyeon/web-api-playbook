import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { projectAmazonRetail } from '../lib/retail/amazon-ontology.mjs';
const root = new URL('../verification/amazon-discovery-2026-10-15/', import.meta.url);
const runs = await Promise.all(['search-crawl', 'search-resume', 'product-lotion', 'product-option', 'product-mouse']
  .map(async name => JSON.parse(await readFile(new URL(`${name}.json`, root), 'utf8'))));

test('saved HTTP results project search, detail and variant edges without fabricating offers', () => {
  const data = projectAmazonRetail(runs);
  const ids = new Set(runs.slice(0, 2).flatMap(r => r.data.pages.flatMap(p => p.items.map(i => i.asin))));
  assert.equal(data.coverage.uniqueSearchProducts, ids.size);
  assert.equal(data.coverage.productDetailsRead, 3); assert.deepEqual(data.coverage.searchPages.map(p => p.page), [1, 2, 3, 4]);
  assert.ok(data.coverage.searchPages.some(p => p.partial)); assert.equal(data.completeCatalog, false);
  assert.equal(data.networkUsed, false); assert.equal(data.databaseWrites, 0);
  const lotion = data.offerings.find(p => p.sourceLocalId === 'B08KT2Z93D');
  assert.ok(lotion.description); assert.ok(lotion.features.length); assert.equal(lotion.imagesAreCompleteGallery, false);
  const offer = data.offers.find(o => o.externalProductId === 'B08KT2Z93D');
  assert.equal(offer.amountMinor, 13363); assert.equal(offer.currency, 'KRW'); assert.equal(offer.listAmountMinor, null);
  assert.ok(data.offers.every(o => o.landedCostMinor === null && o.shippingAmountMinor === null && o.checkoutPriceVerified === false));
  const child = data.variants.find(v => v.sourceLocalId === 'B08KT5HM98');
  assert.equal(child.relatedOfferingId, 'amazon:B08KT5HM98'); assert.equal(child.priceVerified, false);
  assert.ok(data.variants.some(v => v.relatedOfferingId === null));
  assert.equal(data.reviews.length, 0);
});

test('failed, browser-backed, wrong-identity and unpropagated-cookie results are rejected', () => {
  for (const mutate of [r => r.ok = false, r => r.browserUsed = true, r => r.data.asin = 'B000000000',
    r => r.data.receipt.cookieHeaderMatchedOnWire = false, r => r.data.receipt.httpStatus = 403,
    r => r.data.receipt.credentialPropagated = false, r => r.data.images[0].url = 'https://evil.test/p.jpg']) {
    const run = structuredClone(runs[2]); mutate(run);
    assert.throws(() => projectAmazonRetail([run]), { code: 'AMAZON_ONTOLOGY_INPUT_INVALID' });
  }
});

test('ambiguous or fractional-won prices are retained only as product observations', () => {
  const run = structuredClone(runs[2]); run.data.displayedPrice.currencyVerified = false;
  assert.equal(projectAmazonRetail([run]).offers.length, 0);
  run.data.displayedPrice.currencyVerified = true; run.data.displayedPrice.amount = '1.25';
  assert.equal(projectAmazonRetail([run]).offers.length, 0);
  run.data.displayedPrice.currencyCode = 'USD'; run.data.displayedPrice.amount = '13.99';
  assert.equal(projectAmazonRetail([run]).offers[0].amountMinor, 1399);
});
