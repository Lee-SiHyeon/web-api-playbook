import test from 'node:test';
import assert from 'node:assert/strict';
import { readCoupangComparisonShipping, collectedCoupangComparisonShipping } from '../lib/coupang-comparison-shipping.mjs';

const item = { url: 'https://www.coupang.com/vp/products/8174473713?itemId=26958445168&vendorItemId=95778109365',
  deal: { productId: '8174473713', itemId: '26958445168', vendorItemId: '95778109365' } };
const generalPrice = { amount: 1070, currency: 'KRW', verified: true };
const quote = (price = 1070) => ({ receipt: { status: 200 }, selectedOffer: { ...item.deal, selected: true,
  price: { amount: price, currency: 'KRW' }, shippingReadStatus: 'verified',
  shipping: { fee: { amount: 3000, currency: 'KRW', basis: 'public_offer_list', priceKind: 'public_offer_list_shipping_fee' },
    sourceScope: 'consumer_public_offer_list', memberEligibilityVerified: false,
    sourcePaths: ['vendorItemSaleInfo.deliveryFee.shippingFee'] } } });

test('reconciles an exact public quote with the widget general price before using shipping', async () => {
  const result = await readCoupangComparisonShipping({ item, generalPrice, visitorContext: {}, offerReader: async input => {
    assert.equal(input.url, item.url); assert.equal(input.authentication, 'visitor'); return quote();
  } });
  assert.equal(result.feeKRW, 3000);
  assert.equal(generalPrice.amount + result.feeKRW, 4070);
  assert.equal(result.source, 'coupang_public_offer_list');
});

test('does not query an unverified baseline, missing identity, or cross-origin target', async () => {
  const offerReader = async () => { assert.fail('request must not be sent'); };
  for (const args of [{ generalPrice: { ...generalPrice, verified: false } }, { item: { ...item, deal: {} } },
    { item: { ...item, url: item.url.replace('www.coupang.com', 'example.com') } }]) {
    const result = await readCoupangComparisonShipping({ item, generalPrice, ...args, offerReader });
    assert.equal(result.feeKRW, null);
  }
});

test('keeps shipping unknown on SKU drift, general-price change, and invalid or unverified shipping', async () => {
  const mutate = [q => q.selectedOffer.vendorItemId = '123', q => q.selectedOffer.price.amount = 1000,
    q => q.selectedOffer.shippingReadStatus = 'invalid', q => q.selectedOffer.shippingReadStatus = 'conditional',
    q => q.selectedOffer.shipping.fee.currency = 'USD', q => q.selectedOffer.shipping.fee.amount = -1,
    q => q.selectedOffer.shipping.fee.priceKind = 'account_context_shipping_fee',
    q => q.selectedOffer.shipping.sourceScope = 'consumer_account_price',
    q => q.selectedOffer.shipping.memberEligibilityVerified = true,
    q => q.selectedOffer.shipping.sourcePaths = ['unobserved.private.path']];
  for (const change of mutate) {
    const q = quote(); change(q);
    const result = await readCoupangComparisonShipping({ item, generalPrice, offerReader: async () => q });
    assert.equal(result.feeKRW, null);
    assert.equal(result.status, 200, 'unknown-fee guards retain the public quote HTTP status for run counts');
  }
});

test('preserves a rate-limit boundary and never exports error text or credentials', async () => {
  let calls = 0;
  const result = await readCoupangComparisonShipping({ item, generalPrice, offerReader: async () => {
    calls++; throw Object.assign(new Error('secret'), { code: 'COUPANG_RATE_LIMITED', receipt: { status: 429, headers: { cookie: 'secret' } } });
  } });
  assert.equal(calls, 1); assert.equal(result.readStatus, 'rate_limited'); assert.equal(result.status, 429);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

const collectedDeal = (fee = 2500, general = 25000) => ({
  shippingReadStatus: 'verified',
  shipping: { fee: { amount: fee, currency: 'KRW', priceKind: 'public_offer_list_shipping_fee', basis: 'public_offer_list' },
    sourcePaths: ['vendorItemSaleInfo.deliveryFee.shippingFee'], sourceScope: 'consumer_public_offer_list', memberEligibilityVerified: false },
  publicShippingGeneralPrice: { amount: general, currency: 'KRW', basis: 'public_offer_list',
    priceKind: 'offer_list_general_sale_price', source: 'coupang_public_offer_list' },
});

test('collected shipping requires an exact verified public quote and never implies member eligibility', () => {
  const verified = collectedCoupangComparisonShipping(collectedDeal(), { amount: 25000, currency: 'KRW', verified: true });
  assert.equal(verified.feeKRW, 2500);
  assert.equal(verified.readStatus, 'verified');
  assert.equal(verified.scope, 'consumer_public_offer_list');
  assert.equal(verified.memberEligibilityVerified, false);

  for (const deal of [
    { ...collectedDeal(), shippingReadStatus: 'unknown' },
    { ...collectedDeal(), shipping: null },
    { ...collectedDeal(), shipping: { ...collectedDeal().shipping, memberEligibilityVerified: true } },
    { ...collectedDeal(), publicShippingGeneralPrice: { ...collectedDeal().publicShippingGeneralPrice, amount: 24999 } },
  ]) {
    assert.equal(collectedCoupangComparisonShipping(deal, { amount: 25000, currency: 'KRW', verified: true }), null);
  }

  const explicitlyObservedFree = collectedCoupangComparisonShipping(collectedDeal(0),
    { amount: 25000, currency: 'KRW', verified: true });
  assert.equal(explicitlyObservedFree.feeKRW, 0);
  assert.equal(explicitlyObservedFree.memberEligibilityVerified, false);
});