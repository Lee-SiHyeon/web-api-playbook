import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePulmuoneHome } from '../adapters/cps-vendors/pulmuone.mjs';

test('Nuxt scalar references yield product fields, not array indexes or employee prices', () => {
  const nodes = [{ goodsId: 1, goodsName: 2, salePrice: 3, employeeDiscountPrice: 4, satisfactionScore: 5, satisfactionCount: 6, brandName: 7 },
    39271, '선물 세트', 51770, 30000, 4.9, 99, '풀무원'];
  const html = '<h1>쇼핑몰</h1><p>배송비 3,000원 기준</p><script id="__NUXT_DATA__" type="application/json">' + JSON.stringify(nodes) + '</script>';
  const parsed = parsePulmuoneHome(html, { id: 'receipt' });
  assert.equal(parsed.records.length, 1);
  const record = parsed.records[0];
  assert.equal(record.sourceLocalId, '39271');
  assert.equal(record.title, '선물 세트');
  assert.equal(record.price.amount, 51770);
  assert.equal(record.price.currency, 'KRW');
  assert.equal(record.rating.value, 4.9);
  assert.equal(record.rating.reviewCount, null);
  assert.equal(record.rating.ratingCount, null);
  assert.equal(record.rating.sourceMetrics.satisfactionCount, 99);
});

test('a missing Nuxt price reference and unidentified currency stay null', () => {
  const nodes = [{ goodsId: 1, goodsName: 2, salePrice: -1 }, 39271, '선물 세트'];
  const parsed = parsePulmuoneHome('<script id="__NUXT_DATA__">' + JSON.stringify(nodes) + '</script>', { id: 'receipt' });
  assert.equal(parsed.records[0].price, null);
  assert.equal(parsed.records[0].rating, null);
  assert.equal(parsed.currencyEvidence, null);
});
