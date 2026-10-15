import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { krwMinor, projectOverseasRetail } from '../lib/retail/ontology.mjs';

const read = file => readFile(new URL(`../verification/${file}`, import.meta.url), 'utf8').then(JSON.parse);

test('SHEIN home prices become bounded offers without inventing stock, variants or a PDP URL', async () => {
  const run = await read('retail-shein-home-cli-2026-10-15-v2.json');
  const result = projectOverseasRetail(run);
  assert.equal(result.offers.length, 10);
  assert.equal(result.offerings.length, 10);
  assert.equal(result.offers[0].amountMinor, 3732);
  assert.equal(result.offers[0].listAmountMinor, 5890);
  assert.ok(result.offerings.every(row => row.canonicalUrl === null));
  assert.ok(result.offers.every(row => row.availability === 'unknown' && row.shipToCountry === null && row.landedCostMinor === null));
  assert.deepEqual(result.variants, []);
  assert.deepEqual(result.reviews, []);
  assert.equal(result.completeCatalog, false);
  assert.throws(() => projectOverseasRetail({ ...run, credentialsUsed: true }), /./);
});

test('iHerb sitemap IDs remain candidates without invented titles or prices', async () => {
  const run = await read('retail-iherb-sitemap-cli-2026-10-15-v2.json');
  const result = projectOverseasRetail(run);
  assert.equal(result.identityCandidates.length, 100);
  assert.deepEqual(result.offerings, []);
  assert.deepEqual(result.offers, []);
  assert.ok(result.identityCandidates.every(row => row.title === null));
  const changed = structuredClone(run);
  changed.data.items[0].url = 'https://other.test/product/1';
  assert.throws(() => projectOverseasRetail(changed), /./);
});

test('KRW conversion preserves integer units and rejects fractional or unverified money', () => {
  assert.equal(krwMinor({ amount: '1234.00', currency: 'KRW', currencyVerified: true }), 1234);
  for (const amount of ['1.23', '-100', '1e3']) {
    assert.throws(() => krwMinor({ amount, currency: 'KRW', currencyVerified: true }), /./);
  }
  assert.throws(() => krwMinor({ amount: '100', currency: null, currencyVerified: false }), /./);
});
