import test from 'node:test';
import assert from 'node:assert/strict';
import { createAllbirdsPublicClient } from '../lib/retail/shopify.mjs';

const productFixture = handle => ({
  id: 18778193471557,
  handle,
  title: 'Men’s Runner NZ Slip On',
  vendor: 'Allbirds',
  type: 'Shoes',
  url: '/products/' + handle,
  available: true,
  price: 10500,
  price_min: 10500,
  price_max: 10500,
  variants: [
    { id: 41271264378960, title: '8', price: 10500, available: true, option1: '8', option2: null, option3: null },
    { id: 41271264411728, title: '8.5', price: 10500, available: false, option1: '8.5', option2: null, option3: null },
  ],
});

const js = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'text/javascript; charset=utf-8' },
});
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
});

function productAndCurrencyFetch(handle, assertions = () => {}) {
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls++;
    assert.equal(url.origin, 'https://www.allbirds.com');
    assert.equal(url.search, '');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    assert.deepEqual(init.headers, { accept: 'application/json' });
    assert.equal(init.headers.cookie, undefined);
    assert.equal(init.headers.authorization, undefined);
    if (calls === 1) {
      assert.equal(url.pathname, '/products/' + handle + '.js');
      const response = js(productFixture(handle));
      assertions('product', response);
      return response;
    }
    assert.equal(url.pathname, '/cart.js');
    const response = js({ currency: 'USD', item_count: 0, items: [] });
    assertions('currency', response);
    return response;
  };
  return { fetchImpl, getCalls: () => calls };
}

test('Allbirds product detail and presentment currency use bounded anonymous GETs', async () => {
  const handle = 'mens-runner-nz-slip-on-mushroom';
  const { fetchImpl, getCalls } = productAndCurrencyFetch(handle);
  const result = await createAllbirdsPublicClient({
    fetchImpl, now: () => Date.parse('2026-10-05T00:00:00.000Z'),
  }).getProduct({ handle });
  assert.equal(getCalls(), 2);
  assert.deepEqual(result.product.price, {
    amount: '105.00', amountInApiUnits: 10500, currency: 'USD', minorUnitExponent: 2,
  });
  assert.equal(result.product.canonicalUrl,
    'https://www.allbirds.com/products/' + handle);
  assert.deepEqual(result.product.variants[0].price, {
    amount: '105.00', amountInApiUnits: 10500, currency: 'USD', minorUnitExponent: 2,
  });
  assert.equal(result.product.title, 'Men’s Runner NZ Slip On');
  assert.equal(result.product.variants.length, 2);
  assert.equal(result.product.variants[1].available, false);
  assert.equal(result.receipt.schema, 'web-api-public-read-receipt-v1');
  assert.equal(result.receipt.anonymous, true);
  assert.equal(result.receipt.credentialsUsed, false);
  assert.equal(result.receipt.request.path, '/products/' + handle + '.js');
  assert.equal(result.receipt.request.mime, 'text/javascript');
  assert.equal(result.receipt.request.browserUsed, false);
  assert.equal(result.receipt.request.cookieSent, false);
  assert.equal(result.receipt.currencyRequest.path, '/cart.js');
  assert.equal(result.receipt.currencyRequest.itemCount, 0);
  assert.equal(JSON.stringify(result.receipt).includes('Men’s Runner'), false);
});

test('invalid handles cannot select another origin or inject path/query fields', async () => {
  let calls = 0;
  const client = createAllbirdsPublicClient({ fetchImpl: async () => { calls++; throw new Error('unexpected'); } });
  for (const handle of ['', '../cart', 'mens/product', 'a?currency=EUR', 'a#fragment',
    'https://example.org/item', 'x'.repeat(121), null, 9]) {
    await assert.rejects(client.getProduct({ handle }), { code: 'SHOPIFY_PRODUCT_HANDLE_INVALID' });
  }
  assert.equal(calls, 0);
});

test('responses for a different handle, incomplete products, or duplicate variants fail closed', async () => {
  const handle = 'mens-runner';
  const wrongHandle = createAllbirdsPublicClient({ fetchImpl: async () => js(productFixture('other-product')) });
  await assert.rejects(wrongHandle.getProduct({ handle }), { code: 'SHOPIFY_PRODUCT_SCHEMA_INVALID' });

  for (const mutate of [
    value => { value.title = ''; },
    value => { value.price = -1; },
    value => { value.available = 'true'; },
    value => { value.variants[0].id = value.variants[1].id; },
    value => { value.variants[0].available = 1; },
  ]) {
    const invalid = productFixture(handle);
    mutate(invalid);
    await assert.rejects(createAllbirdsPublicClient({ fetchImpl: async () => js(invalid) })
      .getProduct({ handle }), { code: 'SHOPIFY_PRODUCT_SCHEMA_INVALID' });
  }
});

test('HTML gates, redirects, throttling, and unobserved MIME types are errors', async () => {
  const handle = 'mens-runner';
  const cases = [
    [new Response('<html>challenge</html>', { status: 403, headers: { 'content-type': 'text/html' } }),
      'SHOPIFY_ACCESS_BLOCKED'],
    [new Response(null, { status: 302, headers: { location: 'https://www.allbirds.com/password' } }),
      'SHOPIFY_RESPONSE_INVALID'],
    [new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      'SHOPIFY_RESPONSE_INVALID'],
    [new Response(JSON.stringify(productFixture(handle)), { status: 429,
      headers: { 'content-type': 'text/javascript' } }), 'SHOPIFY_THROTTLED'],
  ];
  for (const [response, code] of cases) {
    await assert.rejects(createAllbirdsPublicClient({ fetchImpl: async () => response })
      .getProduct({ handle }), error => {
      assert.equal(error.code, code);
      assert.equal(error.receipt.origin, 'https://www.allbirds.com');
      assert.equal(error.receipt.path, '/products/' + handle + '.js');
      assert.equal(JSON.stringify(error.receipt).includes('challenge'), false);
      return true;
    });
  }

  const wrongMime = createAllbirdsPublicClient({ fetchImpl: async () =>
    new Response(JSON.stringify(productFixture(handle)), { headers: { 'content-type': 'text/plain' } }) });
  await assert.rejects(wrongMime.getProduct({ handle }), { code: 'SHOPIFY_RESPONSE_INVALID' });
});

test('currency is independently checked and cart response contents are not returned', async () => {
  const handle = 'mens-runner';
  let calls = 0;
  const mismatch = createAllbirdsPublicClient({ fetchImpl: async () => {
    calls++;
    if (calls === 1) return js({ ...productFixture(handle), currency: 'EUR' });
    return js({ currency: 'USD', item_count: 0, items: [] });
  } });
  await assert.rejects(mismatch.getProduct({ handle }), { code: 'SHOPIFY_CURRENCY_MISMATCH' });

  calls = 0;
  const malformedCurrency = createAllbirdsPublicClient({ fetchImpl: async () => {
    calls++;
    return calls === 1 ? js(productFixture(handle)) : js({ currency: 'US dollars', item_count: 0 });
  } });
  await assert.rejects(malformedCurrency.getProduct({ handle }), { code: 'SHOPIFY_CURRENCY_SCHEMA_INVALID' });

  calls = 0;
  const unsupportedCurrency = createAllbirdsPublicClient({ fetchImpl: async () => {
    calls++;
    return calls === 1 ? js(productFixture(handle)) : js({ currency: 'JPY', item_count: 0 });
  } });
  await assert.rejects(unsupportedCurrency.getProduct({ handle }), { code: 'SHOPIFY_CURRENCY_UNSUPPORTED' });

  const { fetchImpl } = productAndCurrencyFetch(handle);
  const result = await createAllbirdsPublicClient({ fetchImpl }).getProduct({ handle });
  assert.equal('items' in result, false);
  assert.equal('items' in result.receipt.currencyRequest, false);
});

test('product and cart response limits are enforced before parsing', async () => {
  const handle = 'mens-runner';
  const tooLargeProduct = createAllbirdsPublicClient({ fetchImpl: async () =>
    new Response(' '.repeat(1024 * 1024 + 1), { headers: { 'content-type': 'text/javascript' } }) });
  await assert.rejects(tooLargeProduct.getProduct({ handle }), { code: 'SHOPIFY_RESPONSE_TOO_LARGE' });

  let calls = 0;
  const tooLargeCart = createAllbirdsPublicClient({ fetchImpl: async () => {
    calls++;
    return calls === 1 ? js(productFixture(handle)) :
      new Response(' '.repeat(64 * 1024 + 1), { headers: { 'content-type': 'text/javascript' } });
  } });
  await assert.rejects(tooLargeCart.getProduct({ handle }), { code: 'SHOPIFY_RESPONSE_TOO_LARGE' });
});

test('predictive product search uses documented fields and removes tracking from product URLs', async () => {
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls++;
    assert.equal(url.origin, 'https://www.allbirds.com');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    assert.deepEqual(init.headers, { accept: 'application/json' });
    assert.equal(init.headers.cookie, undefined);
    assert.equal(init.headers.authorization, undefined);
    if (calls === 1) {
      assert.equal(url.pathname, '/search/suggest.json');
      assert.deepEqual([...url.searchParams], [
        ['q', 'runner'],
        ['resources[type]', 'product'],
        ['resources[limit]', '5'],
        ['resources[options][unavailable_products]', 'hide'],
      ]);
      return json({ resources: { results: { products: [{
        id: 7205207343184,
        handle: 'mens-runner-nz-slip-on-mushroom',
        title: 'Men’s Runner NZ Slip On',
        vendor: 'Allbirds',
        type: 'Shoes',
        available: true,
        price: '105.00',
        price_min: '105.00',
        price_max: '105.00',
        url: '/products/mens-runner-nz-slip-on-mushroom?_pos=1&_psq=runner&_psid=private-looking-id',
      }] } } });
    }
    assert.equal(url.pathname, '/cart.js');
    assert.equal(url.search, '');
    return js({ currency: 'USD', item_count: 0, items: [] });
  };
  const result = await createAllbirdsPublicClient({ fetchImpl })
    .searchProducts({ query: ' runner ', limit: 5 });
  assert.equal(calls, 2);
  assert.equal(result.query, 'runner');
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0].price.amount, '105.00');
  assert.equal(result.products[0].price.currency, 'USD');
  assert.equal(result.products[0].canonicalUrl,
    'https://www.allbirds.com/products/mens-runner-nz-slip-on-mushroom');
  assert.equal(result.products[0].canonicalUrl.includes('_psid'), false);
  assert.equal(result.receipt.capabilityId, 'catalog.predictive_search');
  assert.equal(result.receipt.request.path, '/search/suggest.json');
  assert.equal(result.receipt.request.mime, 'application/json');
  assert.deepEqual(result.receipt.request.queryFields,
    ['q', 'resources[type]', 'resources[limit]', 'resources[options][unavailable_products]']);
  assert.equal(result.receipt.currencyRequest.path, '/cart.js');
  assert.equal(JSON.stringify(result.receipt).includes('runner'), false);
});

test('predictive search rejects unsafe inputs and malformed result bindings', async () => {
  let calls = 0;
  const client = createAllbirdsPublicClient({ fetchImpl: async () => { calls++; throw new Error('unexpected'); } });
  for (const query of ['', ' ', '\nmalicious', 'x'.repeat(101), null, 5]) {
    await assert.rejects(client.searchProducts({ query }), { code: 'SHOPIFY_SEARCH_INPUT_INVALID' });
  }
  for (const limit of [0, 11, 1.5, '5', null]) {
    await assert.rejects(client.searchProducts({ query: 'runner', limit }),
      { code: 'SHOPIFY_SEARCH_INPUT_INVALID' });
  }
  assert.equal(calls, 0);

  const base = {
    id: 1, handle: 'mens-runner', title: 'Runner', vendor: 'Allbirds', type: 'Shoes',
    available: true, price: '100.00', price_min: '100.00', price_max: '100.00',
    url: '/products/mens-runner',
  };
  for (const mutate of [
    item => { item.url = 'https://attacker.example/products/mens-runner'; },
    item => { item.url = '/products/another-product'; },
    item => { item.price = '100'; },
    item => { item.available = 'yes'; },
    item => { item.handle = '../outside'; },
  ]) {
    const item = { ...base };
    mutate(item);
    const malformed = createAllbirdsPublicClient({ fetchImpl: async () =>
      json({ resources: { results: { products: [item] } } }) });
    await assert.rejects(malformed.searchProducts({ query: 'runner' }),
      { code: 'SHOPIFY_SEARCH_SCHEMA_INVALID' });
  }
});

test('predictive search HTML gates and redirects fail without returning page content', async () => {
  for (const [response, code] of [
    [new Response('<html>robot challenge</html>', { status: 403,
      headers: { 'content-type': 'text/html' } }), 'SHOPIFY_ACCESS_BLOCKED'],
    [new Response(null, { status: 302,
      headers: { location: 'https://www.allbirds.com/password' } }), 'SHOPIFY_RESPONSE_INVALID'],
  ]) {
    await assert.rejects(createAllbirdsPublicClient({ fetchImpl: async () => response })
      .searchProducts({ query: 'runner' }), error => {
      assert.equal(error.code, code);
      assert.equal(error.receipt.path, '/search/suggest.json');
      assert.equal(JSON.stringify(error.receipt).includes('robot challenge'), false);
      return true;
    });
  }
});
