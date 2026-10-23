import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { collectSnapshot, searchRows, verifiedOperations, stayDates, REGISTRY_FILE, OPERATIONS } from '../research/content-store/naver-crawler-snapshot.mjs';
import { naverSameProduct } from '../research/content-store/goldbox-market-check.mjs';

const registry = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8'));
const withLevel = (op, level) => ({ services: registry.services.map(s => ({ ...s, operations: s.operations.map(o => (`${s.id}.${o.id}` === op ? { ...o, level } : o)) })) });

const fakeRun = calls => (script, args) => {
  calls.push([script, ...args]);
  const cmd = script.includes('deals') ? 'deals' : args[0];
  const results = {
    deals: { products: [
      { productId: '1', title: '두유 24팩', url: 'https://smartstore.naver.com/main/products/1', salePrice: 30000, discountedPrice: 18900, displayDiscountPercent: 37, status: 'listed_active', saleEndAt: '2026-10-01T01:59:59Z' },
      { productId: '2', title: '품절 상품', salePrice: 1000, discountedPrice: 900, status: 'sold_out' }] },
    feed: { items: [{ productId: 'promotion:x', title: '쿠팡', listingPriceKrw: null }, { productId: '9', title: '청소기', listingPriceKrw: 99000 }] },
    'integrated-search': { items: [{ productId: '5', title: '에어프라이어', listingPriceKrw: 116560, sellersCount: 12, averageRating: 4.9, reviewCount: 100 }] },
    'flight-search': { items: [{ itineraryId: 'A1', airlineName: '에어서울', flightNumber: '1', departureAirport: 'GMP', arrivalAirport: 'CJU', legType: 'departure', listingPriceKrw: 28700, priceScope: 'per_leg', departureDate: '20261014' }] },
    'hotel-search': { items: [{ hotelId: 11, title: '호텔A', listingPriceKrw: 200000, priceScope: 'indicative_hotel_min_rate_without_dates' }] },
    'hotel-rates': { rates: [{ listingPriceKrw: 250000 }, { listingPriceKrw: 230000 }] },
    'travel-products': { items: [{ productId: 't1', recordType: 'tourProduct', title: '경주시티투어', listingPriceKrw: 25000, priceScope: 'indicative_starting_price' }] },
    'flight-cards': { cards: [{ code: 'B01', name: 'KB국민카드', category: '신용카드(즉시할인)' }] },
  };
  return { ok: true, result: results[cmd] };
};

test('only live_replay_verified operations in service-capabilities are called', async () => {
  const all = verifiedOperations(registry);
  assert.equal(all.skipped.length, 0, JSON.stringify(all.skipped));
  const gated = withLevel('naver_travel.hotel-rates', 'blocked');
  const calls = [];
  const snap = await collectSnapshot({ registry: gated, run: fakeRun(calls), routes: ['GMP-CJU'], hotelRegions: ['제주'], now: new Date('2026-09-30T03:00:00Z') });
  assert.deepEqual(snap.gate.skipped, [{ op: 'naver_travel.hotel-rates', level: 'blocked' }]);
  assert.equal(calls.some(c => c.includes('hotel-rates')), false);
  assert.equal(Object.keys(OPERATIONS).every(op => op.startsWith('naver_shopping.') || op.startsWith('naver_travel.')), true);
});

test('rows keep display-price semantics and the Danawa check runs on active 오늘끝딜 items only', async () => {
  const calls = [], checked = [];
  const marketCheck = async items => { checked.push(...items); return items.map(i => ({ title: i.title, salePrice: i.deal.salePrice, status: 'beats_market', market: { offersCompared: 15 } })); };
  const snap = await collectSnapshot({ registry, run: fakeRun(calls), shoppingQueries: ['에어프라이어'], routes: ['GMP-CJU'], hotelRegions: ['제주'],
    now: new Date('2026-09-30T03:00:00Z'), marketCheck });
  assert.deepEqual(snap.stay, { checkIn: '2026-10-14', checkOut: '2026-10-16' });
  const deal = snap.shopping.find(r => r.source === 'today_deal' && r.productKey === 'naver:1');
  assert.deepEqual([deal.listPrice, deal.price, deal.discountPercent], [30000, 18900, 37]);
  assert.equal(snap.shopping.filter(r => r.source === 'promotion_feed').length, 1, 'feed cards without a price are dropped');
  assert.equal(snap.shopping.find(r => r.source === 'integrated_search').query, '에어프라이어');
  assert.deepEqual(checked.map(i => i.title), ['두유 24팩']);
  assert.equal(snap.marketChecks[0].productKey, 'naver:1');
  const rate = snap.travel.find(r => r.kind === 'hotel_rate_min');
  assert.deepEqual([rate.price, rate.context, rate.detail.quotes], [230000, '제주:2026-10-14~2026-10-16', 2]);
  assert.equal(snap.travel.find(r => r.kind === 'flight_domestic').priceScope, 'per_leg');
  assert.equal(snap.flightCards.length, 1);
  assert.ok(calls.some(c => c.join(' ').includes('--departure-date 20261014 --return-date 20261016')));
});

test('integrated-search rows preserve safe source identity and source-bound verification without elevating conditional coupon price', () => {
  const title = '존바바토스 아티산 오드뚜왈렛 75ml';
  const rows = searchRows({ items: [
    { productId: '123456789', idKind: 'nv_mid', title, seller: '공식스토어', url: null,
      sourceUrl: 'https://search.shopping.naver.com/search/all?query=perfume',
      listingPriceKrw: 26000, conditionalCouponPriceKrw: 10000, deliveryFeeKrw: 0,
      productUrlVerified: false, couponEligibilityVerified: false, payablePriceVerified: false, optionsVerified: false,
      accessToken: 'must-not-survive', authorization: 'also-must-not-survive', soldOut: true,
      arbitraryField: { secret: 'not-a-card-field' } },
    { productId: '123456790', idKind: 'nv_mid', title, url: 'https://shopping.naver.com/products/123456790',
      listingPriceKrw: 27000, productUrlVerified: true, couponEligibilityVerified: true,
      payablePriceVerified: true, optionsVerified: true },
    { productId: '123456791', idKind: 'unknown-secret-kind', title, url: 'https://shopping.naver.com/products/123456791',
      listingPriceKrw: 28000, productUrlVerified: 'true', couponEligibilityVerified: 'true',
      payablePriceVerified: 1, optionsVerified: null },
    { productId: { token: 'not-a-product-id' }, idKind: 'nv_mid', title, listingPriceKrw: 1000 },
  ] }, '향수');

  assert.equal(rows.length, 3, 'non-scalar source identities are dropped');
  const [unverified, verified, strictOnly] = rows;
  assert.deepEqual([unverified.productId, unverified.idKind, unverified.productKey],
    ['123456789', 'nv_mid', 'naver:123456789']);
  assert.deepEqual([unverified.productUrlVerified, unverified.couponEligibilityVerified,
    unverified.payablePriceVerified, unverified.optionsVerified], [false, false, false, false]);
  assert.equal(unverified.url, null, 'search sourceUrl is not promoted into a product URL');
  assert.deepEqual([unverified.price, unverified.couponPrice, unverified.shipping], [26000, 10000, 0]);

  const compared = naverSameProduct('존바바토스 아티산 오 드 뚜왈렛, 75ml, 1개', [unverified])[0];
  assert.ok(compared);
  assert.deepEqual([compared.best, compared.couponPrice, compared.advertisedCouponPrice], [26000, null, 10000],
    'an ineligible conditional amount remains advertised evidence, not the effective price');

  assert.deepEqual([verified.productUrlVerified, verified.couponEligibilityVerified,
    verified.payablePriceVerified, verified.optionsVerified], [true, true, true, true]);
  assert.equal(verified.url, 'https://shopping.naver.com/products/123456790');
  assert.deepEqual([strictOnly.idKind, strictOnly.productUrlVerified, strictOnly.couponEligibilityVerified,
    strictOnly.payablePriceVerified, strictOnly.optionsVerified], [null, false, false, false, false]);
  for (const row of rows) {
    assert.equal('sourceUrl' in row, false);
    assert.equal('accessToken' in row, false);
    assert.equal('authorization' in row, false);
    assert.equal('arbitraryField' in row, false);
    assert.equal('soldOut' in row, false);
    assert.equal('stockStatus' in row, false);
  }
  assert.equal(JSON.stringify(rows).includes('must-not-survive'), false);
  assert.equal(JSON.stringify(rows).includes('not-a-card-field'), false);
});

test('a failed crawler call is recorded and the rest of the snapshot continues', async () => {
  const run = (script, args) => (args[0] === 'hotel-search' ? { ok: false, code: 'RATE_LIMITED' } : fakeRun([])(script, args));
  const snap = await collectSnapshot({ registry, run, routes: [], hotelRegions: ['부산'], now: new Date('2026-09-30T03:00:00Z') });
  assert.deepEqual(snap.errors, [{ op: 'naver_travel.hotel-search', args: 'hotel-search 부산 10', code: 'RATE_LIMITED' }]);
  assert.ok(snap.travel.some(r => r.kind === 'travel_feed_tour'));
});

test('stay dates are counted from the KST calendar day', () => {
  assert.deepEqual(stayDates(new Date('2026-09-30T16:30:00Z'), 14, 2), { checkIn: '2026-10-15', checkOut: '2026-10-17' });
});
