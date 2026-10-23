import test from 'node:test';
import assert from 'node:assert/strict';
import { maxBenefit, summarizeBenefits } from '../research/content-store/benefit-price.mjs';
import { fromLotteon, fromKurly, fromElevenst, fromSsg, fromHomeplus } from '../research/content-store/grocery-compare.mjs';

test('maxBenefit: card price beats base and the rate is against the list price', () => {
  const b = maxBenefit({ price: 7990, listPrice: 12990, cardPrice: 7490, cardBenefit: '삼성카드' });
  assert.equal(b.bestKind, 'card'); assert.equal(b.baseRate, 38.5); assert.equal(b.maxRate, 42.3); assert.equal(b.conditional, true);
});
test('maxBenefit: no condition means base, points are not a price cut', () => {
  const b = maxBenefit({ price: 1000, listPrice: 1000, pointBack: 50 });
  assert.equal(b.bestKind, 'base'); assert.equal(b.maxRate, 0); assert.equal(b.conditional, false); assert.equal(b.pointBack, 50);
  assert.equal(maxBenefit({ price: null }), null);
});
test('mall mappers expose card / first-order / point fields', () => {
  const l = fromLotteon({ pdName: '사과 3kg', pdId: 'x', priceInfo: { finalPrice: '10000', original: '12000' }, promotionInfo: { type: 'card', text: '롯데카드', value: '5' } }, 't');
  assert.equal(l.cardPrice, 9500); assert.equal(l.cardPriceApprox, true);
  assert.equal(fromKurly({ name: '사과', no: 1, salesPrice: 24900, discountedPrice: 19900, firstOrderBenefit: { price: 16900 } }, 't').firstOrderPrice, 16900);
  assert.equal(fromElevenst({ id: 1, title: '사과 3kg', maxDiscountInfo: { finalPrice: 14900 }, selPrc: 16900, benefitText: [{ type: '11pay', value: '915' }], sellerLogBody: { link_url: 'https://www.11st.co.kr/products/1' } }, 't').pointBack, 915);
  assert.equal(fromSsg({ itemId: 'a', itemNm: '사과', displayPrc: '1495', benefitGrp0: [{ type: 'membership_benefit', txt: '104원' }] }, 't').memberBenefit, 104);
  const h = fromHomeplus({ itemNm: '사과 1kg', itemNo: 1, salePrice: 12990, dcTooltip: { itemDcPrice: -5000, cardDcPrice: -500, dcCardText: '삼성카드' } }, 't');
  assert.equal(h.price, 7990); assert.equal(h.cardPrice, 7490);
});
test('summarizeBenefits ranks by max rate and keeps per-mall best', () => {
  const s = summarizeBenefits([
    { mall: 'homeplus', name: 'a', price: 7990, listPrice: 12990, cardPrice: 7490 },
    { mall: 'kurly', name: 'b', price: 19900, listPrice: 24900, firstOrderPrice: 16900 },
    { mall: 'ssg', name: 'c', price: 1495, listPrice: 2990 }]);
  assert.equal(s.top[0].mall, 'ssg'); assert.equal(s.byMall.homeplus.withCondition, 1); assert.equal(s.topConditional.length, 2);
});
