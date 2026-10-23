import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseBrandProductDocument } from '../adapters/naver-brand-document.mjs';

const url = 'https://brand.naver.com/hera/products/7195971829';
const receipt = { checkedAt: '2026-09-30T00:00:00Z', httpStatus: 200 };
function document(changes = {}) {
  return '<script>window.__PRELOADED_STATE__=' + JSON.stringify({
    channel: { channelUid: 'observed_channel', channelName: '헤라' },
    simpleProductForDetailPage: { id: 7195971829, productNo: 7161850422,
      name: '상품', salePrice: 60000, benefitsView: { dispDiscountedSalePrice: 54000 },
      reviewAmount: { totalReviewCount: 12, averageReviewScore: 4.5 },
      channel: { channelUid: 'observed_channel' }, ...changes },
  }) + ';</script>';
}

test('document snapshot identifies its source and separates displayed from base price', () => {
  const result = parseBrandProductDocument(document(), url, receipt);
  assert.equal(result.sourceProtocol, 'SSR_DOCUMENT');
  assert.equal(result.xhrApiRead, false);
  assert.equal(result.reviewBodiesIncluded, false);
  assert.equal(result.product.basePriceKrw, 60000);
  assert.equal(result.product.listingPriceKrw, 54000);
  assert.equal(result.product.reviewCount, 12);
  assert.equal(result.product.payablePriceVerified, false);
});

test('another product or channel cannot become a successful snapshot', () => {
  for (const changes of [{ id: 7195971830 }, { channel: { channelUid: 'another_channel' } }]) {
    assert.throws(() => parseBrandProductDocument(document(changes), url, receipt),
      error => error.code === 'SCHEMA_CHANGED');
  }
});

test('boolean price values are not converted into one-won offers', () => {
  const result = parseBrandProductDocument(document({ salePrice: true,
    benefitsView: { dispDiscountedSalePrice: true } }), url, receipt);
  assert.equal(result.product.listingPriceKrw, null);
  assert.equal(result.product.basePriceKrw, null);
});

test('private worker rejects arbitrary hosts and credential fields before HTTP dispatch', () => {
  const worker = fileURLToPath(new URL('../scripts/naver-brand-document-worker.py', import.meta.url));
  for (const input of [
    { url: 'https://example.com/hera/products/7195971829' },
    { url, headers: { cookie: 'SENTINEL_MUST_NOT_LEAK' } },
  ]) {
    const result = spawnSync('python3', [worker], { input: JSON.stringify(input),
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'], timeout: 3000 });
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).error.code, 'INPUT');
    assert.equal(result.output[3].length, 0);
    assert.equal(Buffer.concat([result.stdout, result.stderr]).includes(Buffer.from('SENTINEL_MUST_NOT_LEAK')), false);
  }
});
