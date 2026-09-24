import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractProductFeatures,
  scoreProducts,
  buildPositioning,
  buildComparisonRecord,
} from '../scripts/compare-coupang-products.mjs';

test('feature extraction recognizes capacity, power, connector and bundles', () => {
  assert.deepEqual(extractProductFeatures({
    title: '1+1 YINTO 도킹형 고속충전 PD 20W C타입 5000mAh',
    salePriceKrw: 12000,
  }), {
    title: '1+1 YINTO 도킹형 고속충전 PD 20W C타입 5000mAh',
    model: 'YINTO',
    brand: 'YINTO',
    capacityMah: 5000,
    capacitySource: 'title_explicit',
    powerW: 20,
    connector: 'usb_c',
    bundleQuantity: 2,
    docking: true,
    mini: false,
    fastChargeClaim: true,
    foldableConnector: false,
    led: false,
    samsungCellClaim: false,
    wireless: false,
    grip: false,
    semiSolidBatteryClaim: false,
    salePriceKrw: 12000,
    listPriceKrw: null,
    discountPercent: null,
    badgeCount: 0,
    evidenceCoverage: {
      currentPrice: true,
      capacity: true,
      chargingPower: true,
      connector: true,
      physicalMeasurements: false,
      caseCompatibility: false,
      communityReviewSignals: false,
      safetyCertification: false,
    },
  });
});

test('model names can supply a bounded capacity hint without pretending it is measured', () => {
  const product = extractProductFeatures({ title: '팬택 USR-B2A-MINI5000 C타입 도킹형', salePriceKrw: 5120 });
  assert.equal(product.capacityMah, 5000);
  assert.equal(product.capacitySource, 'model_hint');
});

test('scenario scoring differentiates portable, fast charge and all-day products', () => {
  const products = scoreProducts([
    extractProductFeatures({ title: '스피디 C타입 도킹형 5000mAh', salePriceKrw: 6900 }),
    extractProductFeatures({ title: 'YINTO C타입 도킹형 PD 20W 5000mAh', salePriceKrw: 13770 }),
    extractProductFeatures({ title: '이어맥 C타입 도킹형 PD 22.5W 10000mAh', salePriceKrw: 16800 }),
  ]);
  assert.equal(products[0].scores.portableEmergency > products[2].scores.portableEmergency, true);
  assert.equal(products[1].scores.fastCharge > products[0].scores.fastCharge, true);
  assert.equal(products[2].scores.allDay > products[0].scores.allDay, true);
});

test('positioning states tradeoffs instead of declaring a universal winner', () => {
  const selection = { model: 'SPE-B2PA5GPQCP', title: 'selected', capacityMah: 4900, connector: 'usb_c', salePriceKrw: 6900 };
  const products = scoreProducts([
    { ...extractProductFeatures({ title: '스피디 SPE-B2PA5GPQCP C타입 도킹형', salePriceKrw: 6900 }), ...selection, selected: true },
    extractProductFeatures({ title: '팬택 C타입 도킹형 5000mAh', salePriceKrw: 5120 }),
    extractProductFeatures({ title: '스피디 C타입 도킹형 20W 5000mAh', salePriceKrw: 9990 }),
    extractProductFeatures({ title: '이어맥 C타입 도킹형 22.5W 10000mAh', salePriceKrw: 16800 }),
  ]);
  const result = buildPositioning(products, selection);
  assert.match(result.positioning, /입문형/);
  assert.ok(result.tradeoffs.some(value => /가장 싼 제품/.test(value)));
  assert.ok(result.notRecommendedFor.some(value => /1만mAh/.test(value)));
});

test('comparison record remains non-executable and contains no credential material', () => {
  const search = {
    checkedAt: '2026-09-19T00:00:00Z',
    query: '도킹형 보조배터리',
    products: [
      { title: '스피디 SPE-B2PA5GPQCP C타입 도킹형', salePriceKrw: 6900 },
      { title: '팬택 C타입 도킹형 5000mAh', salePriceKrw: 5120 },
    ],
  };
  const selection = { selection: { model: 'SPE-B2PA5GPQCP', title: search.products[0].title, capacityMah: 4900, connector: 'usb_c', salePriceKrw: 6900 } };
  const record = buildComparisonRecord(search, selection, new Date('2026-09-19T00:00:00Z'));
  assert.equal(record.executable, false);
  assert.equal(record.credentialsPersisted, false);
  assert.doesNotMatch(JSON.stringify(record), /cookie|authorization|sessionToken/i);
});
