import test from 'node:test';
import assert from 'node:assert/strict';
import { createUltaPublicClient } from '../lib/commerce/ulta.mjs';

const ORIGIN = 'https://www.ulta.com';
const UUID = '11111111-1111-4111-8111-111111111111';

function pageUrl(page, query = 'lipstick') {
  const url = new URL('/search', ORIGIN);
  url.searchParams.set('search', query);
  if (page > 1) url.searchParams.set('page', String(page));
  return url.toString();
}

function htmlBootstrap(page = 1, query = 'lipstick') {
  const target = new URL(pageUrl(page, query));
  const graphql = `query NonCachedPage( $stagingHost: String, $previewOptions: JSON, $moduleParams: JSON ) {\n` +
    ` Page: NonCachedPage( stagingHost:$stagingHost, previewOptions:$previewOptions, moduleParams:$moduleParams , ` +
    `url: { path: ${JSON.stringify(target.toString())} }, contentId: "${UUID}") { content customResponseAttributes meta }\n}`;
  const module = {
    id: UUID,
    type: 'ProductListingResults',
    moduleName: 'ProductListingResults',
    meta: { initAction: {
      graphql,
      method: 'GET',
      params: ['gti', 'loginStatus', 'retailerVisitorId', 'breakpoint'],
      customHeaders: [
        { key: 'X-ULTA-GRAPH-TYPE', value: 'query' },
        { key: 'X-ULTA-GRAPH-SUB-TYPE', value: 'noncachedpage' },
        { key: 'X-ULTA-GRAPH-MODULE-NAME', value: 'ProductListingResults' },
      ],
    } },
  };
  const state = { ROOT_QUERY: { 'Page({"url":{"path":"/search"})': { content: { modules: [module] } } } };
  return `<html><script id="apollo_state">window.__APOLLO_STATE__ = ${JSON.stringify(state)};\n` +
    `window.__APP_LOCALE__ = 'en-US'\n` +
    `window.__GRAPHQL_DOMAIN__ = 'https://www.ulta.com'\n` +
    `window.__GRAPHQL_GET_URI__ = 'dxl/graphql?ultasite=en-us&user-agent=gomez'\n` +
    `window.__REQUEST_HEADERS__ = {"X_ULTA_SITE":"CB"};</script></html>`;
}

function product({ id, sku, name, listPrice, salePrice = null, sponsored = false }) {
  return {
    productId: id,
    skuId: sku,
    brandName: 'Beauty Brand',
    productName: name,
    listPrice,
    salePrice,
    sponsored,
    action: { url: `/p/fixture-${id}?sku=${sku}&tracking=discarded` },
  };
}

function apiPayload(page = 1, loadMoreUrl = page < 2 ? pageUrl(page + 1) : null) {
  return {
    data: { Page: { content: {
      moduleName: 'ProductListingResults',
      page,
      pageSize: 64,
      resultCount: 128,
      items: page === 1
        ? [
          product({ id: 'pimprod2057119', sku: '2648428', name: 'Serum Lipstick', listPrice: '$9.99', salePrice: '$8.99' }),
          product({ id: 'pimprod2043355', sku: '2619358', name: 'Range Lipstick', listPrice: '$37.00 - $39.00', sponsored: true }),
        ]
        : [product({ id: 'pimprod2054938', sku: '2641200', name: 'Second Page Lipstick', listPrice: '$12.00' })],
      loadMoreUrl,
    } } },
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function harness({ mutatePayload, pageSize = 100 } = {}) {
  const calls = [];
  const client = createUltaPublicClient({
    now: () => Date.parse('2026-10-05T00:00:00Z'),
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      const headers = new Headers(init.headers);
      calls.push({ url, init, headers });
      if (url.pathname === '/search') {
        const requestedPage = Number(url.searchParams.get('page') ?? 1);
        return new Response(htmlBootstrap(requestedPage, url.searchParams.get('search')), {
          status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      assert.equal(url.pathname, '/dxl/graphql');
      const variables = JSON.parse(url.searchParams.get('variables'));
      assert.deepEqual(Object.keys(variables.moduleParams).sort(), ['breakpoint', 'gti', 'loginStatus']);
      assert.equal(variables.moduleParams.gti, '');
      assert.equal(variables.moduleParams.loginStatus, 'anonymous');
      assert.equal(variables.moduleParams.breakpoint, 'desktop');
      const requestPage = Number(new URL(headers.get('referer')).searchParams.get('page') ?? 1);
      const payload = apiPayload(requestPage);
      mutatePayload?.(payload, requestPage);
      return jsonResponse(payload);
    },
  });
  return { client, calls, pageSize };
}

test('Ulta public search reads prices through the observed anonymous GraphQL XHR', async () => {
  const { client, calls } = harness();
  const result = await client.searchProducts({ query: ' lipstick ' });
  const apiCall = calls.find(call => call.url.pathname === '/dxl/graphql');

  assert.equal(calls.length, 2);
  assert.equal(apiCall.init.method, 'GET');
  assert.equal(apiCall.init.redirect, 'manual');
  assert.equal(apiCall.init.credentials, 'omit');
  assert.equal(apiCall.headers.get('cookie'), null);
  assert.equal(apiCall.headers.get('authorization'), null);
  assert.equal(apiCall.url.origin, ORIGIN);
  assert.equal(apiCall.url.searchParams.get('operationName'), 'NonCachedPage');
  assert.equal(apiCall.url.searchParams.get('ultasite'), 'en-us');
  assert.equal(apiCall.url.searchParams.get('user-agent'), 'gomez');
  assert.match(apiCall.url.searchParams.get('query'), /contentId:\s*"11111111-/);
  assert.equal(apiCall.headers.get('x-ulta-dxl-query-id'), 'NonCachedPage');
  assert.equal(apiCall.headers.get('x-ulta-graph-module-name'), 'ProductListingResults');
  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 64);
  assert.equal(result.resultCount, 128);
  assert.equal(result.products.length, 2);
  assert.deepEqual(result.products[0].listPrice, {
    minAmount: '9.99', maxAmount: '9.99', currency: 'USD', kind: 'retail_list',
  });
  assert.deepEqual(result.products[0].salePrice, {
    minAmount: '8.99', maxAmount: '8.99', currency: 'USD', kind: 'retail_sale',
  });
  assert.equal(result.products[0].currentPrice.minAmount, '8.99');
  assert.deepEqual(result.products[0].price, { amount: '8.99', currency: 'USD', kind: 'retail_sale' });
  assert.deepEqual(result.products[1].listPrice, {
    minAmount: '37.00', maxAmount: '39.00', currency: 'USD', kind: 'retail_list',
  });
  assert.deepEqual(result.products[1].priceRange, {
    min: { amount: '37.00', currency: 'USD' },
    max: { amount: '39.00', currency: 'USD' },
    kind: 'retail_list',
  });
  assert.equal(result.products[1].productUrl,
    `${ORIGIN}/p/fixture-pimprod2043355?sku=2619358`);
  assert.equal(result.products[1].sponsored, true);
  assert.equal(result.receipt.schema, 'web-api-public-read-receipt-v1');
  assert.equal(result.receipt.contractProvenance.kind, 'browser_xhr_observed');
  assert.equal(result.receipt.request.browserUsed, false);
  assert.equal(result.receipt.request.cookieSent, false);
  assert.equal(result.receipt.request.authorizationSent, false);
  assert.equal(JSON.stringify(result.receipt).includes(UUID), false);
});

test('Ulta page 2 follows the first-party loadMoreUrl and rebinds its content ID', async () => {
  const { client, calls } = harness();
  const result = await client.searchProducts({ query: 'lipstick', page: 2, pageSize: 64 });
  assert.deepEqual(calls.map(call => call.url.pathname), ['/search', '/dxl/graphql', '/search', '/dxl/graphql']);
  assert.equal(calls[2].url.searchParams.get('page'), '2');
  assert.equal(calls[3].headers.get('referer'), pageUrl(2));
  assert.equal(result.page, 2);
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0].productId, 'pimprod2054938');
  assert.equal(result.receipt.bootstrapRequests.length, 2);
});

test('Ulta rejects mismatched bootstrap URLs and never sends GraphQL for them', async () => {
  let calls = 0;
  const client = createUltaPublicClient({ fetchImpl: async () => {
    calls++;
    return new Response(htmlBootstrap(1, 'other'), {
      status: 200, headers: { 'content-type': 'text/html' },
    });
  } });
  await assert.rejects(client.searchProducts({ query: 'lipstick' }), { code: 'ULTA_BOOTSTRAP_CONTRACT_INVALID' });
  assert.equal(calls, 1);
});

test('Ulta rejects untrusted continuation URLs from a GraphQL response', async () => {
  const { client, calls } = harness({ mutatePayload: payload => {
    payload.data.Page.content.loadMoreUrl = 'https://attacker.example/search?search=lipstick&page=2';
  } });
  await assert.rejects(client.searchProducts({ query: 'lipstick', page: 2 }), {
    code: 'ULTA_PAGINATION_CONTRACT_INVALID',
  });
  assert.equal(calls.filter(call => call.url.pathname === '/dxl/graphql').length, 1);
});

test('Ulta blocks redirects, access denials, and invalid pagination or search inputs', async () => {
  const blocked = createUltaPublicClient({ fetchImpl: async () => new Response('<html>blocked</html>', {
    status: 403, headers: { 'content-type': 'text/html' },
  }) });
  await assert.rejects(blocked.searchProducts({ query: 'lipstick' }), { code: 'ULTA_AUTH_REJECTED' });

  let calls = 0;
  const client = createUltaPublicClient({ fetchImpl: async () => {
    calls++;
    return new Response('', { status: 200, headers: { 'content-type': 'text/html' } });
  } });
  for (const input of [
    {}, { query: '' }, { query: 'x\n' }, { query: 'x'.repeat(121) },
    { query: 'lipstick', page: 0 }, { query: 'lipstick', page: 11 },
    { query: 'lipstick', pageSize: 101 },
  ]) await assert.rejects(client.searchProducts(input), { code: 'ULTA_SEARCH_INPUT_INVALID' });
  assert.equal(calls, 0);
});
