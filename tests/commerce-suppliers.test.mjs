import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { createCjDropshippingClient } from '../lib/commerce/cjdropshipping.mjs';
import { createPrintfulCatalogClient, parsePrintfulCatalogCsv } from '../lib/commerce/printful.mjs';

const at = () => Date.parse('2026-10-05T00:00:00.000Z');
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' },
});
const plain = (value, status = 200, mime = 'application/json') => new Response(value, {
  status,
  headers: { 'content-type': mime },
});

// These fixtures copy documented field names and value shapes from first-party
// API examples; identifiers/names are test-only and no live credentials are used.
const cjSearchFixture = {
  code: 200,
  result: true,
  message: 'Success',
  data: {
    pageSize: 2,
    pageNumber: 1,
    totalRecords: 1,
    totalPages: 1,
    content: [{
      productList: [{
        id: 'doc-fixture-product-1',
        nameEn: 'Fixture Hoodie',
        sku: 'CJ-FIXTURE-1',
        bigImage: 'https://cf.cjdropshipping.com/fixture.jpg',
        sellPrice: '11.85',
        nowPrice: '9.50',
        discountPrice: '9.50',
        listedNum: 100,
        categoryId: 'fixture-category',
        threeCategoryName: 'Hoodies & Sweatshirts',
        addMarkStatus: 1,
        warehouseInventoryNum: 500,
        totalVerifiedInventory: 500,
        saleStatus: '3',
      }],
      relatedCategoryList: [],
      keyWord: 'hoodie',
      keyWordOld: 'hoodie',
    }],
  },
  requestId: 'fixture-request-id',
};

const printfulPriceFixture = {
  data: {
    currency: 'USD',
    product: {
      id: 71,
      placements: [{
        id: 'front',
        title: 'Front print',
        type: 'DTG printing',
        technique_key: 'dtg',
        placement_options: [],
        price: '2.95',
        discounted_price: '2.95',
        layers: [{ type: 'file', additional_price: '0.00', layer_options: [] }],
      }],
    },
    variants: [{
      id: 4011,
      techniques: [{
        technique_key: 'dtg',
        technique_display_name: 'DTG printing',
        price: '28.95',
        discounted_price: '28.95',
      }],
    }],
    discount_tiers: [{ quantity: 25, bulk_discount_percentage: 0.08 }],
  },
  paging: { total: 100, offset: 0, limit: 20 },
  _links: { self: { href: 'https://api.printful.com/v2/catalog-products/71/prices' } },
};

const PRINTFUL_CSV_HEADER = [
  'Variant ID', 'Product Name', 'Product Type', 'Product Color', 'Product Size', 'Product Image',
  'Product Weight (oz)', 'Height (In)', 'Length (In)', 'Width (In)', 'Categories', 'Product Price', 'Notes',
];

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const raw = Buffer.from(content, 'utf8');
    const compressed = deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBytes);
    localOffset += local.length + nameBytes.length + compressed.length;
  }
  const centralBytes = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralBytes, end]);
}

function printfulArchive() {
  const prices = {
    USA: '$12.34',
    Europe: '€11.23',
    Australia: 'AU$ 17.85',
    Japan: '¥1867',
    Canada: 'C$ 19.12',
    Brazil: 'R$ 54.95',
    UK: '£11.17',
    China: '$43.86',
  };
  const entries = Object.entries(prices).map(([region, price]) => {
    const row = [
      '4011', `Fixture ${region} T-shirt`, 'T-Shirt', 'White', 'M',
      'https://files.cdn.printful.com/products/71/4011.jpg', '5.00', '0.100', '28.000', '18.000',
      'Shirts', price, 'fixture note',
    ];
    const quote = field => /[",\r\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field;
    return [`${region}_printful_products.csv`, [PRINTFUL_CSV_HEADER, row].map(line => line.map(quote).join(',')).join('\r\n') + '\r\n'];
  });
  return makeZip(entries);
}

test('CJ product search uses documented V2 filters, pagination, bearer boundary, and USD semantics', async () => {
  let call;
  const client = createCjDropshippingClient({
    accessToken: 'test-cj-token',
    now: at,
    fetchImpl: async (url, init) => {
      call = { url: new URL(url), init };
      return json(cjSearchFixture);
    },
  });
  const result = await client.searchProducts({
    keyword: 'hoodie', page: 1, size: 2, categoryId: 'fixture-category', countryCode: 'US',
    startSellPrice: 5, endSellPrice: 20,
  });
  assert.equal(call.url.origin, 'https://developers.cjdropshipping.com');
  assert.equal(call.url.pathname, '/api2.0/v1/product/listV2');
  assert.deepEqual(Object.fromEntries(call.url.searchParams), {
    page: '1', size: '2', keyWord: 'hoodie', categoryId: 'fixture-category', countryCode: 'US',
    startSellPrice: '5', endSellPrice: '20',
  });
  assert.equal(call.init.method, 'GET');
  assert.equal(call.init.redirect, 'manual');
  assert.equal(call.init.credentials, 'omit');
  assert.equal(call.init.headers.get('CJ-Access-Token'), 'test-cj-token');
  assert.equal(call.init.headers.get('cookie'), null);
  assert.equal(call.init.headers.get('authorization'), null);
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0].prices.sellPrice.raw, '11.85');
  assert.equal(result.products[0].prices.sellPrice.currency, 'USD');
  assert.match(result.products[0].prices.sellPrice.priceMeaning, /distinct from the direct wholesale/);
  assert.equal(result.pagination.totalRecords, 1);
  assert.equal(result.receipt.schema, 'web-api-credentialed-read-receipt-v1');
  assert.equal(result.receipt.credentialBinding.persisted, false);
  assert.equal(JSON.stringify(result.receipt).includes('test-cj-token'), false);
});

test('CJ product detail binds product ID and preserves distinct wholesale arrays without inventing their currency', async () => {
  const productId = 'fixture-pid-1';
  let call;
  const client = createCjDropshippingClient({
    accessToken: 'test-cj-token',
    now: at,
    fetchImpl: async (url, init) => {
      call = { url: new URL(url), init };
      return json({
        code: 200, result: true, message: 'Success',
        data: {
          id: productId, nameen: 'Fixture variant product', sku: 'CJ-FIXTURE',
          sellprice: '24.11', bigimg: 'https://cf.cjdropshipping.com/fixture.jpg',
          stanProducts: [{
            id: 'fixture-vid-1', pid: productId, sku: 'CJ-FIXTURE-RED-M', nameen: 'Red / M',
            sellprice: '24.11', variantkey: 'Red-M', totalInventory: 8,
            wholesalePrice: {
              cjWholesalePrice: [{ minQuantity: 3, price: '20.00' }],
              directWholesalePrice: [{ price: '18.00' }],
              updatePriceDate: 1740000000000,
            },
          }],
          variantInventory: [{
            vid: 'fixture-vid-1',
            inventory: [{
              countryCode: 'CN', totalInventory: 46083, cjInventory: 4041,
              factoryInventory: 42042, verifiedWarehouse: 1,
            }],
          }, {
            vid: 'fixture-variant-not-in-stanProducts',
            inventory: [{
              countryCode: 'US', totalInventory: 12, cjInventory: 2,
              factoryInventory: 10, verifiedWarehouse: 2,
            }],
          }],
        },
      });
    },
  });
  const result = await client.getProductDetail({ productId });
  assert.equal(call.url.pathname, '/api2.0/v1/product/productDetail/query');
  assert.equal(call.init.method, 'POST');
  assert.deepEqual(JSON.parse(call.init.body), { id: productId });
  assert.equal(call.init.headers.get('content-type'), 'application/json');
  assert.equal(result.product.productId, productId);
  assert.equal(result.product.variants[0].price.currency, 'USD');
  assert.equal(result.product.variants[0].wholesalePrice.currency, null);
  assert.equal(result.product.variants[0].wholesalePrice.directWholesalePrice[0].price, '18.00');
  assert.deepEqual(result.product.variants[0].inventory.byCountry[0], {
    countryCode: 'CN', cjActual: 4041, factoryVirtual: 42042, total: 46083, verifiedWarehouse: 1,
  });
  assert.equal(result.product.inventoryRowsWithoutListedVariant[0].variantId, 'fixture-variant-not-in-stanProducts');
  assert.equal(result.receipt.productIdMatched, true);
  assert.equal(JSON.stringify(result).includes('test-cj-token'), false);
});

test('CJ product ID mismatch, bad business envelope, and invalid input fail closed', async () => {
  const token = 'test-cj-token';
  const wrongProduct = createCjDropshippingClient({
    accessToken: token,
    fetchImpl: async () => json({ code: 200, result: true, data: { id: 'different', nameen: 'Fixture', sku: 'SKU', stanProducts: [] } }),
  });
  await assert.rejects(wrongProduct.getProductDetail({ productId: 'expected' }), { code: 'CJDROPSHIPPING_PRODUCT_SCHEMA_INVALID' });

  const businessError = createCjDropshippingClient({
    accessToken: token,
    fetchImpl: async () => json({ code: 1600002, result: false, message: 'Sensitive upstream detail', data: null }),
  });
  await assert.rejects(businessError.getCategories(), error => {
    assert.equal(error.code, 'CJDROPSHIPPING_BUSINESS_REJECTED');
    assert.equal(JSON.stringify(error.receipt).includes('Sensitive upstream detail'), false);
    assert.equal(JSON.stringify(error.receipt).includes(token), false);
    return true;
  });

  let calls = 0;
  const invalid = createCjDropshippingClient({ accessToken: token, fetchImpl: async () => { calls++; return json({}); } });
  await assert.rejects(invalid.searchProducts({ page: 1001 }), { code: 'CJDROPSHIPPING_SEARCH_ARGUMENT_INVALID' });
  await assert.rejects(invalid.searchProducts({ startSellPrice: 5, endSellPrice: 1 }), { code: 'CJDROPSHIPPING_SEARCH_ARGUMENT_INVALID' });
  assert.equal(calls, 0);
});

test('CJ category response is flattened with level and parent metadata', async () => {
  const client = createCjDropshippingClient({
    accessToken: 'test-cj-token',
    fetchImpl: async () => json({
      code: 200, result: true, data: [{
        categoryFirstName: 'Home & Garden',
        categoryFirstList: [{
          categorySecondName: 'Furniture',
          categorySecondList: [{ categoryId: 'third-id', categoryName: 'Storage' }],
        }],
      }],
    }),
  });
  const result = await client.getCategories();
  assert.deepEqual(result.categories, [
    { name: 'Home & Garden', parentId: null, level: 1 },
    { name: 'Furniture', parentId: 'Home & Garden', level: 2 },
    { id: 'third-id', name: 'Storage', parentId: 'Furniture', level: 3 },
  ]);
});

test('Printful product catalog listing sends documented filters and validates offset pagination', async () => {
  let call;
  const client = createPrintfulCatalogClient({
    accessToken: 'test-printful-token',
    now: at,
    fetchImpl: async (url, init) => {
      call = { url: new URL(url), init };
      return json({
      data: [{ id: 362, type: 'T-Shirt', name: 'Fixture Organic Tee', brand: null, model: null,
        image: 'https://files.cdn.printful.com/products/12/product.jpg', variant_count: 10,
          is_discontinued: false, categories: [{ id: 7, name: 'Shirts' }] }],
        paging: { total: 1, offset: 4, limit: 5 },
        _links: { self: { href: 'https://api.printful.com/v2/catalog-products?limit=5&offset=4' } },
      });
    },
  });
  const result = await client.listProducts({ limit: 5, offset: 4, categoryIds: [7, 9], colors: ['Grey', 'Heather Grey'], sellingRegionName: 'europe' });
  assert.equal(call.url.origin, 'https://api.printful.com');
  assert.equal(call.url.pathname, '/v2/catalog-products');
  assert.equal(call.url.searchParams.get('category_ids'), '7,9');
  assert.equal(call.url.searchParams.get('colors'), 'Grey,Heather Grey');
  assert.equal(call.url.searchParams.get('selling_region_name'), 'europe');
  assert.equal(call.init.headers.get('authorization'), 'Bearer test-printful-token');
  assert.equal(call.init.headers.get('user-agent'), 'web-api-playbook supplier catalog read client');
  assert.equal(call.init.headers.get('cookie'), null);
  assert.equal(call.init.redirect, 'manual');
  assert.equal(call.init.credentials, 'omit');
  assert.equal(result.products[0].productId, 362);
  assert.equal(result.products[0].brand, null);
  assert.equal(result.products[0].model, null);
  assert.equal(result.pagination.offset, 4);
  assert.equal(result.receipt.schema, 'web-api-credentialed-read-receipt-v1');
  assert.equal(JSON.stringify(result.receipt).includes('test-printful-token'), false);
});

test('Printful valid catalog products may omit brand and model', async () => {
  const client = createPrintfulCatalogClient({
    accessToken: 'test-printful-token',
    fetchImpl: async () => json({
      data: { id: 71, type: 'T-Shirt', name: 'Fixture T-Shirt', brand: null, model: null,
        image: 'https://files.cdn.printful.com/products/71.jpg', variant_count: 1, is_discontinued: false },
      _links: {},
    }),
  });
  const result = await client.getProduct({ productId: 71 });
  assert.equal(result.product.brand, null);
  assert.equal(result.product.model, null);
});

test('Printful product prices preserve exact currency, variant technique and placement amounts', async () => {
  let call;
  const client = createPrintfulCatalogClient({
    accessToken: 'test-printful-token',
    now: at,
    fetchImpl: async (url, init) => {
      call = { url: new URL(url), init };
      return json(printfulPriceFixture);
    },
  });
  const result = await client.getProductPrices({
    productId: 71, limit: 20, offset: 0, currency: 'USD', productionCurrency: 'USD', sellingRegionName: 'north_america',
  });
  assert.equal(call.url.pathname, '/v2/catalog-products/71/prices');
  assert.equal(call.url.searchParams.get('currency'), 'USD');
  assert.equal(call.url.searchParams.get('production_currency'), 'USD');
  assert.equal(call.url.searchParams.get('selling_region_name'), 'north_america');
  assert.equal(result.prices.currency, 'USD');
  assert.equal(result.prices.productionCurrency, 'USD');
  assert.equal(result.prices.variants[0].variantId, 4011);
  assert.equal(result.prices.variants[0].techniques[0].price.amount, '28.95');
  assert.equal(result.prices.placements[0].price.amount, '2.95');
  assert.equal(result.prices.placements[0].discountedPrice.currency, 'USD');
  assert.equal(result.prices.shippingIncluded, false);
  assert.equal(result.prices.taxesIncluded, false);
});

test('Printful variant page is tied to requested product and response pagination', async () => {
  const client = createPrintfulCatalogClient({
    accessToken: 'test-printful-token',
    fetchImpl: async () => json({
      data: [{ id: 9224, catalog_product_id: 294, name: 'Fixture Hoodie White XL', size: 'XL', color: 'White',
        color_code: '#ffffff', image: 'https://files.cdn.printful.com/products/294/9224.jpg' }],
      paging: { total: 1, offset: 0, limit: 20 },
      _links: {},
    }),
  });
  const result = await client.listVariants({ productId: 294 });
  assert.equal(result.variants[0].variantId, 9224);
  assert.equal(result.variants[0].productId, 294);
  assert.equal(result.variants[0].color, 'White');

  const wrongOwner = createPrintfulCatalogClient({
    accessToken: 'test-printful-token',
    fetchImpl: async () => json({ data: [{ id: 9224, catalog_product_id: 71, name: 'Other product' }],
      paging: { total: 1, offset: 0, limit: 20 }, _links: {} }),
  });
  await assert.rejects(wrongOwner.listVariants({ productId: 294 }), { code: 'PRINTFUL_VARIANTS_SCHEMA_INVALID' });
});

test('Printful catalog API requires a token but its official regional feed does not', async () => {
  let calls = 0;
  const publicClient = createPrintfulCatalogClient({ fetchImpl: async () => { calls++; return json({}); } });
  await assert.rejects(publicClient.listProducts(), { code: 'PRINTFUL_ACCESS_TOKEN_REQUIRED' });
  assert.equal(calls, 0);
  assert.equal(typeof publicClient.getPublicCatalogFeed, 'function');
  assert.throws(() => parsePrintfulCatalogCsv('bad', 'USA'), { code: 'PRINTFUL_FEED_CSV_SCHEMA_INVALID' });
});

test('Printful Help-linked anonymous regional price feed follows only the pinned S3 redirect and parses all eight regions', async () => {
  const archive = printfulArchive();
  const calls = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, init });
    const headers = new Headers(init.headers);
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    assert.equal(headers.get('authorization'), null);
    assert.equal(headers.get('cookie'), null);
    assert.equal(headers.get('accept'), 'application/zip');
    if (parsed.origin === 'https://www.printful.com') {
      assert.equal(parsed.pathname, '/custom-products/export');
      return new Response(null, { status: 302, headers: {
        location: 'https://printful.s3.us-west-1.amazonaws.com/productExport/printful_products.zip',
      } });
    }
    assert.equal(parsed.origin, 'https://printful.s3.us-west-1.amazonaws.com');
    assert.equal(parsed.pathname, '/productExport/printful_products.zip');
    return new Response(archive, { status: 200, headers: {
      'content-type': 'application/zip', 'last-modified': 'Sun, 04 Oct 2026 00:10:10 GMT',
    } });
  };
  const client = createPrintfulCatalogClient({ fetchImpl, now: at });
  const regions = [
    ['USA', 'USD', '12.34'], ['Europe', 'EUR', '11.23'], ['Australia', 'AUD', '17.85'],
    ['Japan', 'JPY', '1867'], ['Canada', 'CAD', '19.12'], ['Brazil', 'BRL', '54.95'],
    ['UK', 'GBP', '11.17'], ['China', null, '43.86'],
  ];
  const result = await client.getPublicCatalogFeeds();
  assert.equal(result.feeds.length, regions.length);
  for (let index = 0; index < regions.length; index++) {
    const [region, currency, amount] = regions[index];
    const feed = result.feeds[index];
    assert.equal(feed.region, region);
    assert.equal(feed.productCount, 1);
    assert.equal(feed.products[0].variantId, 4011);
    assert.equal(feed.products[0].dimensionsInches.height, '0.100');
    assert.equal(feed.products[0].dimensionsInches.length, '28.000');
    assert.equal(feed.products[0].productPrice.amount, amount);
    assert.equal(feed.products[0].productPrice.currency, currency);
    assert.equal(feed.priceCurrency, currency);
  }
  assert.equal(result.receipt.schema, 'web-api-public-read-receipt-v1');
  assert.equal(result.receipt.contractProvenance.kind, 'first_party_documented_feed');
  assert.equal(result.receipt.request.origin, 'https://printful.s3.us-west-1.amazonaws.com');
  assert.equal(result.receipt.request.path, '/productExport/printful_products.zip');
  assert.equal(result.receipt.request.mime, 'application/zip');
  assert.equal(result.receipt.redirectRequest.httpStatus, 302);
  assert.equal(result.receipt.request.lastModified, 'Sun, 04 Oct 2026 00:10:10 GMT');
  assert.equal(JSON.stringify(result.receipt).includes('test-printful-token'), false);
  assert.equal(calls.length, 2);

  const one = await client.getPublicCatalogFeed({ region: 'USA' });
  assert.equal(one.region, 'USA');
  assert.equal(one.productCount, 1);
  assert.equal(calls.length, 4);
});

test('Printful public feed rejects redirect targets outside the observed first-party asset origin', async () => {
  let calls = 0;
  const client = createPrintfulCatalogClient({
    fetchImpl: async () => {
      calls++;
      return new Response(null, { status: 302, headers: { location: 'https://example.org/printful_products.zip' } });
    },
  });
  await assert.rejects(client.getPublicCatalogFeed({ region: 'USA' }), { code: 'PRINTFUL_FEED_REDIRECT_INVALID' });
  assert.equal(calls, 1);
});

test('Printful CSV parser handles quoted commas and leaves ambiguous dollar currency unassigned', () => {
  const row = ['4011', 'Fixture, quoted name', 'Poster', '', '18×24', '', '1.90', '0.10', '24.00', '18.00', 'Posters', '$43.86', ''];
  const quote = field => /[",\r\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field;
  const csv = [PRINTFUL_CSV_HEADER, row].map(values => values.map(quote).join(',')).join('\r\n') + '\r\n';
  const product = parsePrintfulCatalogCsv(csv, 'China')[0];
  assert.equal(product.title, 'Fixture, quoted name');
  assert.equal(product.productPrice.display, '$43.86');
  assert.equal(product.productPrice.currency, null);
  assert.equal(product.productPrice.currencyVerified, false);
  assert.equal(product.weightOz, '1.90');
});
