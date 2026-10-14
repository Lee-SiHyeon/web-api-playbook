import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildModeWebApiReqHeaderFromContext,
  collectModetourLive,
  parseModetourProductMaster,
  parseModetourRecommendationList,
} from './modetour.mjs';

const listFixture = JSON.parse(readFileSync(new URL('../fixtures/agent-modetour-recommendations.sample.json', import.meta.url), 'utf8'));
const detailFixture = JSON.parse(readFileSync(new URL('../fixtures/agent-modetour-product-master.sample.json', import.meta.url), 'utf8'));
const wrongDetailFixture = JSON.parse(readFileSync(new URL('../fixtures/agent-modetour-product-master-wrong-id.sample.json', import.meta.url), 'utf8'));

test('recommendation parser preserves duration and airline choices and does not invent price currency or departure dates', () => {
  const products = parseModetourRecommendationList(listFixture);
  const danang = products.find((row) => row.sellerProductId === '49617');
  assert.ok(danang);
  assert.equal(danang.sellerId, 'modetour-package');
  assert.match(danang.title, /다낭/);
  assert.equal(danang.priceQuote.summaryAmount, 329000);
  assert.equal(danang.priceQuote.detailAmount, 329000);
  assert.equal(danang.priceQuote.currency, null);
  assert.equal(danang.priceQuote.quotedBasis, null);
  assert.equal(danang.summaryPriceMinKrw, null);
  assert.deepEqual(danang.durationOptions.map(({ nights, days }) => [nights, days]), [[3, 4], [3, 5], [4, 6]]);
  assert.equal(danang.minimumObservedDepartureDate, '2026-10-16');
  assert.deepEqual(danang.departureDates, []);
  assert.deepEqual(danang.departures, []);
  assert.equal(danang.departureAvailability, null);
  assert.deepEqual(danang.departureAirportText, '인천 / 청주');
  assert.deepEqual(danang.departureAirportCodes, ['SEL', 'CJJ']);
  assert.ok(danang.airlineOptions.some((row) => row.marketingAirName === '제주항공'));
});

test('detail parser takes the current detail response and keeps seller currency and quote basis explicit', () => {
  const listingProduct = listFixture.products.find((row) => row.masterCodeNo === 49617);
  const [product] = parseModetourProductMaster(detailFixture, { listingProduct });
  assert.equal(product.sellerProductId, '49617');
  assert.match(product.title, /다낭/);
  assert.equal(product.priceQuote.detailAmount, 329000);
  assert.equal(product.priceQuote.currency, null);
  assert.equal(product.priceQuote.quotedBasis, null);
  assert.equal(product.minimumObservedDepartureDate, '2026-10-16');
  assert.deepEqual(product.durationOptions.map(({ nights, days }) => [nights, days]), [[3, 4], [3, 5], [4, 6]]);
  assert.deepEqual(product.departures, []);
  assert.deepEqual(parseModetourProductMaster(wrongDetailFixture, { listingProduct }), []);
});

test('Mode SDK serialization uses only the observed lower-camel context fields', () => {
  const encoded = buildModeWebApiReqHeaderFromContext({
    webSiteNo: 7,
    companyNo: 8,
    deviceType: 'PC',
    apiKey: 'test-only-context-value',
    webSite: 'ignored-extra-field',
  });
  assert.deepEqual(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')), {
    WebSiteNo: 7,
    CompanyNo: 8,
    DeviceType: 'PC',
    ApiKey: 'test-only-context-value',
  });
  assert.equal(buildModeWebApiReqHeaderFromContext({ webSiteNo: 7, companyNo: 8, deviceType: 'PC' }), null);
});

test('live collector uses one current context and direct list/detail contracts without persisting context values', async () => {
  const fixtureListResponse = { isOK: true, result: { package: listFixture.products } };
  const fixtureDetailResponse = { isOK: true, result: { productMaster: detailFixture.products } };
  const fixtureContext = encodeURIComponent(JSON.stringify({
    webSiteNo: 7,
    companyNo: 8,
    deviceType: 'PC',
    apiKey: 'test-only-context-value',
    webSite: 'www.modetour.com',
  }));
  const calls = [];
  const fetchImpl = async (url, options) => {
    const parsedUrl = new URL(url);
    const headerNames = Object.keys(options.headers).map((name) => name.toLowerCase()).sort();
    calls.push({ url: parsedUrl, headerNames });
    if (parsedUrl.origin === 'https://www.modetour.com') {
      const response = new Response('<html>anonymous context bootstrap</html>', { status: 200, headers: { 'content-type': 'text/html' } });
      Object.defineProperty(response.headers, 'getSetCookie', {
        value: () => [`ModeEcommerceContext=${fixtureContext}; Path=/; HttpOnly`],
      });
      return response;
    }
    assert.equal(parsedUrl.origin, 'https://b2c-api.modetour.com');
    assert.ok(headerNames.includes('modewebapireqheader'));
    assert.ok(!headerNames.includes('cookie'));
    if (parsedUrl.pathname === '/Package/GetRecommendedProduct') {
      assert.equal(parsedUrl.searchParams.get('theme'), 'Package');
      return new Response(JSON.stringify(fixtureListResponse), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    assert.equal(parsedUrl.pathname, '/Package/GetProductMasterByIds');
    assert.equal(parsedUrl.searchParams.get('productMasterNos'), '49617');
    assert.equal(parsedUrl.searchParams.get('searchFrom'), '2026-10-16');
    return new Response(JSON.stringify(fixtureDetailResponse), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const result = await collectModetourLive({ destination: '다낭', requestBudget: 3, minIntervalMs: 0, fetchImpl });
  assert.equal(result.verdict, 'usable_limited');
  assert.equal(result.requestCount, 3);
  assert.equal(result.recommendationCount, 10);
  assert.equal(result.matchedRecommendationCount, 1);
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0].detailReadStatus, 'live_detail_read');
  assert.equal(result.products[0].minimumObservedDepartureDate, '2026-10-16');
  assert.equal(result.products[0].priceQuote.currency, null);
  assert.equal(result.fiveStates.live_replay, true);
  assert.equal(result.fiveStates.captured, false);
  assert.equal(result.contractSourceObserved, true);
  assert.equal(result.httpIndependentLive, true);
  assert.equal(result.fiveStates.credential_propagated, false);
  assert.equal(result.fiveStates.anonymous_sdk_context_propagated, true);
  assert.equal(calls.length, 3);
  assert.ok(calls[1].headerNames.includes('modewebapireqheader'));
  assert.ok(!calls[1].headerNames.includes('cookie'));
  assert.ok(!JSON.stringify(result).includes('test-only-context-value'));
});

test('detail responses for another master ID are not associated with the requested product', async () => {
  const fixtureListResponse = { isOK: true, result: { package: listFixture.products } };
  const fixtureContext = encodeURIComponent(JSON.stringify({
    webSiteNo: 7,
    companyNo: 8,
    deviceType: 'PC',
    apiKey: 'test-only-context-value',
    webSite: 'www.modetour.com',
  }));
  const fetchImpl = async (url, options) => {
    const parsedUrl = new URL(url);
    if (parsedUrl.origin === 'https://www.modetour.com') {
      const response = new Response('<html>anonymous context bootstrap</html>', { status: 200, headers: { 'content-type': 'text/html' } });
      Object.defineProperty(response.headers, 'getSetCookie', {
        value: () => [`ModeEcommerceContext=${fixtureContext}; Path=/; HttpOnly`],
      });
      return response;
    }
    assert.equal(parsedUrl.origin, 'https://b2c-api.modetour.com');
    assert.ok(Object.keys(options.headers).some((name) => name.toLowerCase() === 'modewebapireqheader'));
    if (parsedUrl.pathname === '/Package/GetRecommendedProduct') {
      return new Response(JSON.stringify(fixtureListResponse), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    assert.equal(parsedUrl.pathname, '/Package/GetProductMasterByIds');
    assert.equal(parsedUrl.searchParams.get('productMasterNos'), '49617');
    return new Response(JSON.stringify(wrongDetailFixture), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const result = await collectModetourLive({ destination: '다낭', requestBudget: 3, minIntervalMs: 0, fetchImpl });
  const [product] = result.products;
  assert.equal(result.verdict, 'list_only');
  assert.equal(result.fiveStates.live_replay, false);
  assert.equal(result.httpIndependentLive, true);
  assert.equal(product.detailRequested, true);
  assert.equal(product.detailReadStatus, 'product_detail_mismatch');
  assert.equal(product.detailErrorCode, 'PRODUCT_DETAIL_MISMATCH');
  assert.equal(product.detailExpectedMasterCodeNo, '49617');
  assert.deepEqual(product.detailReturnedMasterCodeNos, ['99999']);
  assert.equal(product.raw.productMaster.masterCodeNo, 49617);
  assert.doesNotMatch(product.title, /다른 상품/);
});

test('oversized response bodies are canceled at the bounded streaming cap', async () => {
  const fixtureContext = encodeURIComponent(JSON.stringify({
    webSiteNo: 7,
    companyNo: 8,
    deviceType: 'PC',
    apiKey: 'test-only-context-value',
    webSite: 'www.modetour.com',
  }));
  const fixtureListResponse = { isOK: true, result: { package: listFixture.products } };
  let detailChunksQueued = 0;
  let detailStreamCancelled = false;
  const fetchImpl = async (url) => {
    const parsedUrl = new URL(url);
    if (parsedUrl.origin === 'https://www.modetour.com') {
      const response = new Response('<html>anonymous context bootstrap</html>', { status: 200, headers: { 'content-type': 'text/html' } });
      Object.defineProperty(response.headers, 'getSetCookie', {
        value: () => [`ModeEcommerceContext=${fixtureContext}; Path=/; HttpOnly`],
      });
      return response;
    }
    if (parsedUrl.pathname === '/Package/GetRecommendedProduct') {
      return new Response(JSON.stringify(fixtureListResponse), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    assert.equal(parsedUrl.pathname, '/Package/GetProductMasterByIds');
    const body = new ReadableStream({
      pull(controller) {
        detailChunksQueued += 1;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() { detailStreamCancelled = true; },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const result = await collectModetourLive({ destination: '다낭', requestBudget: 3, minIntervalMs: 0, fetchImpl });
  const detailRequest = result.requests.find((request) => request.name.startsWith('product-master-'));
  assert.equal(result.verdict, 'endpoint_error');
  assert.equal(result.requestCount, 3);
  assert.equal(result.fiveStates.live_replay, false);
  assert.equal(result.httpIndependentLive, false);
  assert.equal(result.fiveStates.captured, false);
  assert.equal(result.contractSourceObserved, true);
  assert.equal(detailRequest.responseBodyReadStatus, 'stream_exceeds_limit');
  assert.equal(detailRequest.bytes, null);
  assert.equal(detailRequest.responseBodyLimitBytes, 2 * 1024 * 1024);
  assert.ok(detailRequest.bytesObservedBeforeCancel <= 2 * 1024 * 1024 + 64 * 1024);
  assert.equal(detailStreamCancelled, true);
  assert.ok(detailChunksQueued <= (2 * 1024 * 1024) / (64 * 1024) + 2);
});

test('challenge response stops the collector before API requests', async () => {
  const fetchImpl = async () => new Response('<html>CAPTCHA challenge</html>', {
    status: 403,
    headers: { 'content-type': 'text/html' },
  });
  const result = await collectModetourLive({ destination: '다낭', fetchImpl, minIntervalMs: 0 });
  assert.equal(result.verdict, 'challenge_blocked');
  assert.equal(result.requestCount, 1);
  assert.equal(result.fiveStates.live_replay, false);
});
