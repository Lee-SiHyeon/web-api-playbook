import test from 'node:test';
import assert from 'node:assert/strict';
import { createAwinPublisherFeedClient } from '../lib/commerce/awin.mjs';
import { createImpactPartnerCatalogClient } from '../lib/commerce/impact.mjs';

const FIXED_NOW = Date.parse('2026-10-05T02:00:00.000Z');

function response(body, { status = 200, mime = 'application/json' } = {}) {
  return new Response(body, { status, headers: { 'content-type': mime } });
}

const awinRow = (overrides = {}) => ({
  id: 'item_123', title: 'Cotton Runner Shoe', description: 'Lightweight cotton shoe',
  link: 'https://shop.example.test/products/cotton-runner', image_link: 'https://img.example.test/cotton.jpg',
  brand: 'Example', product_type: 'Shoes > Runners', availability: 'in_stock',
  price: '60.00 GBP', sale_price: '45.00 GBP',
  sale_price_effective_date: '2026-10-01T00:00:00Z/2026-10-31T23:59:59Z', item_group_id: 'runner-family',
  ...overrides,
});

const impactItem = (overrides = {}) => ({
  Id: 'catalog-1_item-42', CatalogId: 'catalog-1', CatalogItemId: 'item-42',
  CampaignId: '77', CampaignName: 'Example Partner Program', Name: 'Compact USB-C Hub',
  Description: 'Six-port USB-C hub', Manufacturer: 'Example Co',
  Url: 'https://tracking.example.test/click?u=abc', ImageUrl: 'https://img.example.test/hub.jpg',
  CurrentPrice: '29.95', OriginalPrice: '39.95', Currency: 'USD',
  StockAvailability: 'InStock', ItemGroupId: 'hub-family',
  ...overrides,
});

test('Awin flat Google-feed fixture maps retail offer fields and scans locally', async () => {
  let clock = FIXED_NOW;
  const calls = [];
  const feed = [awinRow(), awinRow({ id: 'item_456', title: 'Wool Coat', price: '120.00 GBP', sale_price: undefined,
    sale_price_effective_date: undefined, item_group_id: undefined, product_type: 'Outerwear' })].map(row => JSON.stringify(row)).join('\n') + '\n';
  const client = createAwinPublisherFeedClient({ publisherId: '12345', accessToken: 'memory-token',
    now: () => clock, sleepImpl: async ms => { clock += ms; },
    fetchImpl: async (input, init) => {
      calls.push({ url: new URL(input), init });
      return response(feed, { mime: 'application/x-ndjson' });
    },
  });
  const result = await client.searchProducts({ advertiserId: '6789', locale: 'en_GB', keyword: 'runner', page: 1, pageSize: 10 });
  assert.equal(result.provider, 'awin');
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0], {
    provider: 'awin', productId: 'runner-family', variantId: 'item_123',
    title: 'Cotton Runner Shoe', url: 'https://shop.example.test/products/cotton-runner',
    imageUrl: 'https://img.example.test/cotton.jpg',
    price: { amount: '45.00', currency: 'GBP', kind: 'retail_current' },
    listPrice: { amount: '60.00', currency: 'GBP', kind: 'retail_list' },
    availability: 'available', observedAt: '2026-10-05T02:00:00.000Z',
    source: { network: 'awin', advertiserId: '6789', locale: 'en_GB', feedProductId: 'item_123',
      productGroupId: 'runner-family', priceSource: 'publisher-enhanced-google-feed', feedAvailability: 'in_stock',
      description: 'Lightweight cotton shoe', brand: 'Example', productType: 'Shoes > Runners', salePrice: '45.00 GBP', salePriceActive: true },
  });
  assert.equal(calls[0].url.origin, 'https://api.awin.com');
  assert.equal(calls[0].url.pathname, '/publishers/12345/awinfeeds/download/6789-retail-en_GB.jsonl');
  assert.equal(calls[0].url.search, '');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.headers.authorization, 'Bearer memory-token');
  assert.equal(result.receipt.request.credentialsUsed, true);
  assert.equal(result.receipt.secretsPersistedInEvidence, false);
  assert.equal(JSON.stringify(result.receipt).includes('memory-token'), false);
});

test('Awin getProduct reads by exact feed product ID and fails closed for nested undocumented rows', async () => {
  let clock = FIXED_NOW;
  const client = createAwinPublisherFeedClient({ publisherId: '12345', accessToken: 'token',
    now: () => clock, sleepImpl: async ms => { clock += ms; },
    fetchImpl: async () => response(JSON.stringify(awinRow({ id: 'item_123', item_group_id: undefined })) + '\n', { mime: 'application/json' }),
  });
  const found = await client.getProduct({ advertiserId: '6789', locale: 'en_GB', productId: 'item_123' });
  assert.equal(found.item.productId, 'item_123');
  assert.equal(found.item.variantId, null);
  assert.equal(found.receipt.productIdMatched, true);

  const unsupported = createAwinPublisherFeedClient({ publisherId: '12345', accessToken: 'token',
    fetchImpl: async () => response(JSON.stringify({ meta: { advertiser_id: 6789 }, product_basic: { id: 'item_123', title: 'x' } }), { mime: 'application/json' }),
  });
  await assert.rejects(unsupported.getProduct({ advertiserId: '6789', locale: 'en_GB', productId: 'item_123' }),
    error => error.code === 'AWIN_PRODUCT_SCHEMA_UNSUPPORTED');

  const productDetailsWrapper = createAwinPublisherFeedClient({ publisherId: '12345', accessToken: 'token',
    fetchImpl: async () => response(JSON.stringify({ product_details: { id: 'item_123', title: 'x' } }), { mime: 'application/json' }),
  });
  await assert.rejects(productDetailsWrapper.getProduct({ advertiserId: '6789', locale: 'en_GB', productId: 'item_123' }),
    error => error.code === 'AWIN_PRODUCT_SCHEMA_UNSUPPORTED');
});

test('Awin detects the documented terminal JSONL error even after a product row', async () => {
  const client = createAwinPublisherFeedClient({ publisherId: '12345', accessToken: 'token',
    fetchImpl: async () => response(`${JSON.stringify(awinRow({ sale_price: undefined, sale_price_effective_date: undefined, item_group_id: undefined }))}\n{"error":500,"message":"feed failed"}\n`, { mime: 'application/x-ndjson' }),
  });
  await assert.rejects(client.searchProducts({ advertiserId: '6789', locale: 'en_GB', keyword: 'cotton' }),
    error => error.code === 'AWIN_FEED_INCOMPLETE' && error.receipt.request.terminalErrorCode === 500);
});

test('Awin blocks redirects, HTML gates, invalid price and unsafe URLs', async () => {
  const make = fetchImpl => createAwinPublisherFeedClient({ publisherId: '12345', accessToken: 'token', fetchImpl });
  await assert.rejects(make(async () => response('', { status: 302, mime: 'text/html' })).searchProducts({ advertiserId: '6789', locale: 'en_GB' }),
    error => error.code === 'AWIN_RESPONSE_INVALID');
  await assert.rejects(make(async () => response('<html>login</html>', { mime: 'text/html' })).searchProducts({ advertiserId: '6789', locale: 'en_GB' }),
    error => error.code === 'AWIN_RESPONSE_INVALID');
  for (const row of [awinRow({ price: 'free' }), awinRow({ link: 'javascript:alert(1)' })]) {
    await assert.rejects(make(async () => response(JSON.stringify(row))).searchProducts({ advertiserId: '6789', locale: 'en_GB' }));
  }
});

test('Impact partner item search uses the documented Partner v16 route and normalizes price/availability', async () => {
  const calls = [];
  const client = createImpactPartnerCatalogClient({ accountSid: 'SID_123', authToken: 'memory-secret', now: () => FIXED_NOW,
    fetchImpl: async (input, init) => {
      calls.push({ url: new URL(input), init });
      return response(JSON.stringify({ Items: [impactItem()] }));
    },
  });
  const result = await client.searchProducts({ keyword: 'USB hub', page: 2, pageSize: 25, query: "CurrentPrice > 10" });
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0], {
    provider: 'impact', productId: 'catalog-1_item-42', variantId: 'hub-family', title: 'Compact USB-C Hub',
    url: 'https://tracking.example.test/click?u=abc', imageUrl: 'https://img.example.test/hub.jpg',
    price: { amount: '29.95', currency: 'USD', kind: 'retail_current' },
    listPrice: { amount: '39.95', currency: 'USD', kind: 'retail_list' },
    availability: 'available', observedAt: '2026-10-05T02:00:00.000Z',
    source: { network: 'impact', catalogId: 'catalog-1', catalogItemId: 'item-42', campaignId: '77',
      campaignName: 'Example Partner Program', manufacturer: 'Example Co', description: 'Six-port USB-C hub',
      stockAvailability: 'InStock' },
  });
  assert.equal(calls[0].url.origin, 'https://api.impact.com');
  assert.equal(calls[0].url.pathname, '/Mediapartners/SID_123/Catalogs/ItemSearch');
  assert.equal(calls[0].url.searchParams.get('Keyword'), 'USB hub');
  assert.equal(calls[0].url.searchParams.get('Page'), '2');
  assert.equal(calls[0].url.searchParams.get('PageSize'), '25');
  assert.equal(calls[0].url.searchParams.get('Query'), 'CurrentPrice > 10');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.headers.authorization, `Basic ${Buffer.from('SID_123:memory-secret').toString('base64')}`);
  assert.equal(result.receipt.credentialBindingVerified, true);
  assert.equal(JSON.stringify(result.receipt).includes('memory-secret'), false);
});

test('Impact item detail binds catalog and product identity to the partner endpoint', async () => {
  const calls = [];
  const client = createImpactPartnerCatalogClient({ accountSid: 'SID123', authToken: 'token',
    fetchImpl: async (input, init) => { calls.push({ url: new URL(input), init }); return response(JSON.stringify(impactItem())); },
  });
  const result = await client.getProduct({ catalogId: 'catalog-1', productId: 'catalog-1_item-42' });
  assert.equal(result.item.productId, 'catalog-1_item-42');
  assert.equal(result.receipt.productIdMatched, true);
  assert.equal(calls[0].url.pathname, '/Mediapartners/SID123/Catalogs/catalog-1/Items/catalog-1_item-42');

  const wrongId = createImpactPartnerCatalogClient({ accountSid: 'SID123', authToken: 'token',
    fetchImpl: async () => response(JSON.stringify(impactItem({ Id: 'different' }))),
  });
  await assert.rejects(wrongId.getProduct({ catalogId: 'catalog-1', productId: 'wanted' }),
    error => error.code === 'IMPACT_PRODUCT_ID_MISMATCH');
});

test('Impact catalog listing strips private feed locations and carries documented currency/count only', async () => {
  const client = createImpactPartnerCatalogClient({ accountSid: 'SID123', authToken: 'token',
    fetchImpl: async () => response(JSON.stringify({ Catalogs: [{
      Id: 'catalog-1', Name: 'US Home Catalog', Language: 'en_US', AdvertiserId: 'brand-1',
      AdvertiserName: 'Example Brand', CampaignId: '77', CampaignName: 'Partner Program',
      NumberOfItems: '123', Currency: 'USD', DateLastUpdated: '2026-10-04T00:00:00Z',
      Locations: ['https://private.example.test/feed'], FTPLocations: ['ftp://user:secret@ftp.example.test/items.csv'],
    }] })),
  });
  const result = await client.listCatalogs({ campaignId: '77' });
  assert.deepEqual(result.catalogs[0], {
    id: 'catalog-1', name: 'US Home Catalog', language: 'en_US', advertiserId: 'brand-1',
    advertiserName: 'Example Brand', campaignId: '77', campaignName: 'Partner Program', itemCount: 123,
    currency: 'USD', lastUpdatedAt: '2026-10-04T00:00:00Z',
  });
  assert.equal(JSON.stringify(result).includes('ftp://'), false);
  assert.equal(JSON.stringify(result).includes('user:secret@'), false);
});

test('Impact rejects redirect, HTML, invalid page bounds and invalid item currency without following links', async () => {
  const make = fetchImpl => createImpactPartnerCatalogClient({ accountSid: 'SID123', authToken: 'token', fetchImpl });
  await assert.rejects(make(async () => response('', { status: 302, mime: 'text/html' })).searchProducts({ keyword: 'x' }),
    error => error.code === 'IMPACT_RESPONSE_INVALID');
  await assert.rejects(make(async () => response('<html>login</html>', { mime: 'text/html' })).searchProducts({ keyword: 'x' }),
    error => error.code === 'IMPACT_RESPONSE_INVALID');
  await assert.rejects(make(async () => response(JSON.stringify({ Items: [impactItem({ Currency: 'US' })] }))).searchProducts({}),
    error => error.code === 'IMPACT_ITEM_SCHEMA_INVALID');
  const bounded = make(async () => response('{"Items":[]}'));
  await assert.rejects(bounded.searchProducts({ page: 0 }), error => error.code === 'IMPACT_PAGE_INVALID');
});

test('Impact preserves preorder/backorder without claiming on-hand availability and labels absent prices unknown', async () => {
  const client = createImpactPartnerCatalogClient({ accountSid: 'SID123', authToken: 'token',
    fetchImpl: async () => response(JSON.stringify({ Items: [
      impactItem({ Id: 'preorder', StockAvailability: 'PreOrder', CurrentPrice: undefined, Currency: 'USD' }),
      impactItem({ Id: 'backorder', StockAvailability: 'BackOrder' }),
    ] })),
  });
  const result = await client.searchProducts({});
  assert.deepEqual(result.items.map(item => item.availability), ['unknown', 'unknown']);
  assert.deepEqual(result.items[0].price, { amount: null, currency: 'USD', kind: 'unknown' });
  assert.equal(result.items[0].source.stockAvailability, 'PreOrder');
  assert.equal(result.items[1].source.stockAvailability, 'BackOrder');
});
