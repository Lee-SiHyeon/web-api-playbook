import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspectCoupangResponse } from '../lib/retail/coupang-response.mjs';
import { parseCoupangRsc } from '../lib/retail/coupang-rsc.mjs';

const sourceUrl = 'https://www.coupang.com/np/search?q=synthetic&sorter=salePriceAsc';
const listing = { products: [{ legacyProductId: '123', vendorItemId: '789',
  link: 'https://www.coupang.com/vp/products/123?itemId=456&vendorItemId=789',
  imageAndTitleArea: { title: 'Synthetic mouse ]); not executable' },
  priceArea: { i18nSalesPrice: { amount: '3300', currency: 'KRW', fractionDigits: 0 }, price: '3,300', shippingFeeDescription: '' } }] };
const frame = '0:' + JSON.stringify(listing) + '\n';
const inspect = (body, extra = {}) => inspectCoupangResponse({ body, sourceUrl, status: 200,
  contentType: 'text/html; charset=utf-8', parseRsc: parseCoupangRsc, ...extra });
const script = text => '<script>self.__next_f.push(' + JSON.stringify([1, text]) + ')</script>';

test('HTML with a literal embedded Flight stream is parsed, not rejected at the MIME gate', () => {
  const r = inspect('<!doctype html><html><body>' + script(frame) + '</body></html>');
  assert.equal(r.ok, true); assert.equal(r.diagnostic.htmlInspected, true);
  assert.equal(r.diagnostic.parserFormat, 'html_embedded_rsc'); assert.equal(r.diagnostic.productCount, 1);
  assert.equal(r.data.products[0].price.amount, 3300); assert.equal(r.data.products[0].itemId, '456');
});

test('split Flight chunks are reassembled in document order without evaluating JavaScript', () => {
  const r = inspect('<html><body>' + script(frame.slice(0, 31)) + script(frame.slice(31)) + '</body></html>');
  assert.equal(r.ok, true); assert.equal(r.diagnostic.html.flightPushes, 2);
  assert.equal(r.diagnostic.productCount, 1);
});

test('embedded JSON is validated against the exact product/option/price schema', () => {
  const r = inspect('<script id="__NEXT_DATA__" type="application/json">' + JSON.stringify({ props: listing }) + '</script>');
  assert.equal(r.ok, true); assert.equal(r.diagnostic.parserFormat, 'html_embedded_json');
  const bad = structuredClone(listing); bad.products[0].priceArea.i18nSalesPrice.currency = 'USD';
  const invalid = inspect('<script type="application/json">' + JSON.stringify(bad) + '</script>');
  assert.equal(invalid.ok, false); assert.equal(invalid.diagnostic.productCount, null);
  assert.equal(invalid.diagnostic.parseStatus, 'failed');
});

test('unknown HTML is inspected but not reported as an empty catalog', () => {
  const r = inspect('<html><head><title>Unknown response</title></head><body><div>Loading</div></body></html>');
  assert.equal(r.ok, false); assert.equal(r.code, 'COUPANG_RETAIL_HTML_UNSUPPORTED');
  assert.equal(r.diagnostic.htmlInspected, true); assert.equal(r.diagnostic.parseAttempted, false);
  assert.equal(r.diagnostic.parseStatus, 'unsupported'); assert.equal(r.diagnostic.productCount, null);
  assert.equal(r.diagnostic.classification, 'html_unclassified');
});

test('DOM product links remain candidates without a validated price/option adapter', () => {
  const r = inspect('<html><body><a href="/vp/products/123?itemId=456&amp;vendorItemId=789">Synthetic product 3,300원</a></body></html>');
  assert.equal(r.diagnostic.html.productLinks, 1); assert.equal(r.diagnostic.html.exactSkuLinks, 1);
  assert.equal(r.diagnostic.classification, 'unvalidated_listing_candidates');
  assert.equal(r.diagnostic.productCount, null); assert.equal(r.ok, false);
});

test('a script-only response is a structural observation, not a proven bot challenge', () => {
  const r = inspect('<html><head><script src="/resource?token=SYNTHETIC_SECRET"></script></head><body><script>window.location.replace("/next?token=SYNTHETIC_SECRET")</script></body></html>');
  assert.equal(r.diagnostic.classification, 'script_shell'); assert.equal(r.diagnostic.html.scriptNavigation, true);
  assert.equal(r.diagnostic.html.externalScripts, 1); assert.equal(r.diagnostic.productCount, null);
  assert.equal(JSON.stringify(r).includes('SYNTHETIC_SECRET'), false);
});

for (const [name, html, classification, code] of [
  ['denial', '<title>Access Denied</title>', 'access_denied', 'COUPANG_RETAIL_CHALLENGE'],
  ['challenge', '<title>Challenge</title>', 'challenge', 'COUPANG_RETAIL_CHALLENGE'],
  ['login', '<title>로그인 - 쿠팡</title><form><input type="password"></form>', 'login', 'COUPANG_RETAIL_LOGIN_HTML'],
]) test(`explicit ${name} evidence is not a successful zero-product read`, () => {
  const r = inspect(html + script(frame));
  assert.equal(r.ok, false); assert.equal(r.code, code); assert.equal(r.diagnostic.classification, classification);
  assert.equal(r.diagnostic.productCount, null); assert.equal(r.diagnostic.parseAttempted, false);
});

test('HTTP 403/429 never become success even when a valid product payload is present', () => {
  for (const status of [403, 429]) {
    const r = inspect(frame, { status, contentType: 'text/x-component' });
    assert.equal(r.code, 'COUPANG_RETAIL_HTTP_' + status); assert.equal(r.diagnostic.productCount, null);
    assert.equal(r.diagnostic.parseAttempted, false);
  }
});

test('body sniffing supports actual RSC and JSON despite an unexpected Content-Type', () => {
  const rsc = inspect(frame); assert.equal(rsc.ok, true); assert.equal(rsc.diagnostic.parserFormat, 'rsc');
  const json = inspect(JSON.stringify(listing), { contentType: 'application/json' });
  assert.equal(json.ok, true); assert.equal(json.diagnostic.parserFormat, 'json');
  const html = inspect(script(frame), { contentType: 'text/x-component' });
  assert.equal(html.ok, true); assert.equal(html.diagnostic.parserFormat, 'html_embedded_rsc');
  assert.equal(inspect('1:I["synthetic-module"]\n' + frame).ok, true);
  assert.equal(inspect(JSON.stringify(listing)).ok, true);
  assert.equal(inspect('<!-- synthetic comment -->' + script(frame), { contentType: 'text/x-component' }).ok, true);
});

test('malformed payloads and unproven empty lists retain null measured counts', () => {
  for (const body of ['0:{bad json', '0:{"products":[]}']) {
    const r = inspect(body, { contentType: 'text/x-component' });
    assert.equal(r.ok, false); assert.equal(r.diagnostic.parseAttempted, true);
    assert.equal(r.diagnostic.parseStatus, 'failed'); assert.equal(r.diagnostic.productCount, null);
  }
});

test('conflicting validated listings are ambiguous, not silently selected', () => {
  const other = structuredClone(listing); other.products[0].priceArea.i18nSalesPrice.amount = '3400';
  const r = inspect('<script type="application/json">' + JSON.stringify(listing) + '</script>'
    + '<script type="application/json">' + JSON.stringify(other) + '</script>');
  assert.equal(r.code, 'COUPANG_RETAIL_LIST_AMBIGUOUS'); assert.equal(r.diagnostic.productCount, null);
});

test('response scripts are never executed and arbitrary credentials never reach diagnostics', () => {
  const r = inspect('<html><title>SYNTHETIC_PRIVATE_TITLE</title><body><script>globalThis.__responseExecuted=true; self.__next_f.push([1, (()=>"secret")()]);</script>'
    + '<input value="SYNTHETIC_PRIVATE_VALUE"><script type="application/json">{"token":"SYNTHETIC_PRIVATE_TOKEN"}</script></body></html>');
  assert.equal(globalThis.__responseExecuted, undefined);
  assert.equal(r.diagnostic.html.unsupportedFlightPushes, 1); assert.equal(r.diagnostic.productCount, null);
  assert.doesNotMatch(JSON.stringify(r), /SYNTHETIC_PRIVATE/);
});

test('oversized responses and cross-origin input cannot produce data', () => {
  const big = inspect('x'.repeat(8 * 1024 * 1024 + 1)); assert.equal(big.code, 'COUPANG_RETAIL_RESPONSE_SIZE');
  const foreign = inspect(frame, { sourceUrl: 'https://unrelated.test/np/search' });
  assert.equal(foreign.code, 'COUPANG_RETAIL_RESPONSE_SCOPE'); assert.equal(foreign.diagnostic.productCount, null);
});

const domCard = price => '<ul id="product-list"><li><a href="/vp/products/123?itemId=456&amp;vendorItemId=789&amp;traceId=SYNTHETIC_TRACE">'
  + '<div class="ProductUnit_productNameV2__synthetic">Synthetic mouse</div>'
  + '<div class="PriceArea_priceArea__synthetic">' + price + '</div>'
  + '<span data-badge-type="feePrice">배송비 미확인</span></a></li></ul>';

test('observed DOM-card schema parses sale price separately from a struck original and retains conditions', () => {
  const r = inspect(domCard('쿠폰할인<del>30,000원</del><span>47%</span><span>15,900원</span>'));
  assert.equal(r.ok, true); assert.equal(r.diagnostic.parserFormat, 'html_dom'); assert.equal(r.diagnostic.productCount, 1);
  assert.equal(r.data.products[0].price.amount, 15900); assert.equal(r.data.products[0].price.basis, 'html_displayed_sales_price');
  assert.match(r.data.products[0].price.label, /쿠폰할인/); assert.equal(r.data.products[0].itemId, '456');
  assert.equal(r.data.membershipEligibilityVerified, false); assert.equal(r.data.products[0].shippingLabel, '배송비 미확인');
  assert.doesNotMatch(JSON.stringify(r), /SYNTHETIC_TRACE/);
});

test('ambiguous, negative, installment and unit DOM prices are rejected rather than guessed', () => {
  for (const price of ['30,000원 15,900원', '15,900원 (1개당 5,300원)', '월 2,000원', '1개당 2,000원', '-100원', '15.900원']) {
    const r = inspect(domCard(price)); assert.equal(r.ok, false, price);
    assert.equal(r.diagnostic.productCount, null); assert.equal(r.code, 'COUPANG_RETAIL_DOM_PRICE_AMBIGUOUS');
  }
});

test('unrecognized DOM layouts cannot promote a product link to a priced catalog item', () => {
  const r = inspect(domCard('3,300원').replace('PriceArea_priceArea__synthetic', 'unknown-layout'));
  assert.equal(r.ok, false); assert.equal(r.code, 'COUPANG_RETAIL_DOM_SCHEMA'); assert.equal(r.diagnostic.productCount, null);
});

test('the existing observed HTML-card fixture is parsed independently of embedded RSC', async () => {
  const body = await readFile(new URL('./fixtures/coupang/retail-search-dom.html', import.meta.url), 'utf8');
  const r = inspect(body);
  assert.equal(r.ok, true); assert.equal(r.diagnostic.parserFormat, 'html_dom');
  assert.equal(r.diagnostic.productCount, 3);
  assert.deepEqual(r.data.products.map(p => p.price.amount), [15900, 23900, 10400]);
  assert.equal(r.data.pagination.completeCatalog, false);
});
