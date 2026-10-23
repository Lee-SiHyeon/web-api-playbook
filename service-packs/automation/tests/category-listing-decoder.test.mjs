import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decodeCategoryListing} from '../src/category-listing-decoder.mjs';

function response(change = () => {}) {
  const product = {legacyProductId: 100, vendorItemId: 300, index: {itemId: 200}, link: '/vp/products/100?itemId=200&vendorItemId=300', imageAndTitleArea: {title: 'Synthetic option'}, priceArea: {i18nSalesPrice: {amount: '7900', currency: 'KRW'}}, adBadgeArea: {sponsored: false}};
  const context = {products: '$11:props:products', linkcodes: '564653', page: 2};
  const pagination = {currentPageIndex: 2, totalPageIndex: 17, nextPageUnit: {displayPageNo: 3, link: '/np/categories/564653?page=3'}};
  change({product, context, pagination});
  return '11:' + JSON.stringify(['$', 'List', null, {products: [product, product]}]) + '\n1b:' + JSON.stringify([context, pagination]);
}
const scope = {categoryId: '564653', page: 2};
test('resolves observed row reference, exact options and next page without claiming completion', () => {
  const result = decodeCategoryListing(response(), scope);
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0].itemId, '200');
  assert.equal(result.pagination.nextPage, 3);
  assert.equal(result.pagination.terminationVerified, false);
  assert.equal(result.independentReplayVerified, false);
});
test('rejects successful HTTP fallback bodies and cross-category response', () => {
  assert.throws(() => decodeCategoryListing('<html>login</html>', scope));
  assert.throws(() => decodeCategoryListing(response(({context}) => context.linkcodes = '999'), scope), /scope mismatch/);
});
test('rejects product option mismatch and stalled pagination', () => {
  assert.throws(() => decodeCategoryListing(response(({product}) => product.index.itemId = 201), scope), /identity mismatch/);
  assert.throws(() => decodeCategoryListing(response(({pagination}) => pagination.nextPageUnit.link = '/np/categories/564653?page=2'), scope), /stalled/);
});
test('unobserved final-page shape remains unresolved', () => {
  const result = decodeCategoryListing(response(({pagination}) => {pagination.totalPageIndex = 2; pagination.nextPageUnit = null;}), scope);
  assert.equal(result.pagination.nextPage, null);
  assert.equal(result.pagination.terminationVerified, false);
});
