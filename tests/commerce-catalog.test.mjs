import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createCatalogReader, catalogOnly, effectiveReviewPageSize } from '../lib/commerce/catalog-readers.mjs';

test('full product output preserves descriptions/images/options that price snapshots omit', async () => {
  const product = { itemCode: 'shop:item', description: '<p>Material and care</p>',
    images: ['https://example.com/image.jpg'], options: [{ name: 'Color', value: 'Red' }],
    affiliateUrl: 'https://tracking.example.com/click', price: { amount: '1234', currency: 'JPY' } };
  const reader = await createCatalogReader({ provider: 'rakuten-ichiba', operation: 'product', args: { id: 'shop:item' },
    credentials: { applicationId: 'fixture-app-credential', accessKey: 'fixture-access-secret' },
    factories: { 'rakuten-ichiba': () => ({ getItem: async ({ itemCode }) => {
      assert.equal(itemCode, 'shop:item'); return product;
    } }) } });
  const result = await reader.product();
  assert.equal(result.data.description, product.description); assert.deepEqual(result.data.options, product.options);
  assert.deepEqual(result.data.images, product.images); assert.equal(Object.hasOwn(result.data, 'affiliateUrl'), false);
});

test('unobserved or unsupported reviews fail before requesting account credentials or network', async () => {
  let constructed = false;
  await assert.rejects(createCatalogReader({ provider: 'shopee-id', operation: 'reviews', args: { id: '123' },
    factories: { 'shopee-id': () => { constructed = true; } } }), { code: 'CATALOG_OPERATION_NOT_EXPOSED_BY_API' });
  await assert.rejects(createCatalogReader({ provider: 'oliveyoung', operation: 'product', args: { id: 'A123' } }),
    { code: 'CATALOG_OPERATION_UNIMPLEMENTED' });
  assert.equal(constructed, false);
  await assert.rejects(createCatalogReader({ provider: 'shopify-storefronts', operation: 'reviews', args: { id: 'product', store: 'allbirds' } }),
    { code: 'CATALOG_REVIEW_SOURCE_DISABLED' });
});

test('API credentials are service-bound and sensitive echoes cannot reach full detail output', async () => {
  await assert.rejects(createCatalogReader({ provider: 'amazon-partner', operation: 'product', args: { id: 'B012345678' },
    credentials: { password: 'fixture-login-password' } }), { code: 'CATALOG_CREDENTIAL_FIELDS_INVALID' });
  const reader = await createCatalogReader({ provider: 'rakuten-ichiba', operation: 'product', args: { id: 'shop:item' },
    credentials: { applicationId: 'fixture-app', accessKey: 'fixture-secret' },
    factories: { 'rakuten-ichiba': () => ({ getItem: async () => ({ description: 'echo fixture-secret' }) }) } });
  await assert.rejects(reader.product(), { code: 'COMMERCE_SECRET_IN_RESULT' });
});

test('affiliate URLs and Amazon attribution are omitted while retailer/product URLs remain', () => {
  const result = catalogOnly({ product: { url: 'https://www.amazon.com/dp/B012345678?tag=fixture-owner&linkCode=ogi',
    images: ['https://images.example.com/photo.jpg?width=500'], affiliateURL: 'https://tracking.example.com/a',
    rating: 4, partnerTag: 'fixture-owner' } });
  assert.equal(result.product.url, 'https://www.amazon.com/dp/B012345678');
  assert.equal(result.product.images[0], 'https://images.example.com/photo.jpg?width=500');
  assert.equal(JSON.stringify(result).includes('fixture-owner'), false);
  const body = 'https://www.amazon.com/dp/B012345678?ref=customer-review-text';
  assert.equal(catalogOnly({ body }).body, body);
});

test('catalog CLI inventory is offline and a credential packet for another provider is rejected', () => {
  const inventory = spawnSync(process.execPath, ['scripts/catalog.mjs', 'providers'], { encoding: 'utf8' });
  assert.equal(inventory.status, 0); assert.equal(JSON.parse(inventory.stdout).networkUsed, false);
  const result = spawnSync(process.execPath, ['scripts/catalog.mjs', 'amazon-partner', 'product', '--id=B012345678', '--credentials-stdin'],
    { encoding: 'utf8', input: JSON.stringify({ provider: 'impact', authToken: 'fixture-secret' }) });
  assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).code, 'CATALOG_CREDENTIAL_SERVICE_MISMATCH');
  assert.equal(result.stdout.includes('fixture-secret'), false);
});

test('review paging records the real provider size and rejects Ulta sizes above its live boundary', () => {
  assert.equal(effectiveReviewPageSize('shopify-storefronts', 20), 5);
  assert.equal(effectiveReviewPageSize('oliveyoung-global', 20), 10);
  assert.equal(effectiveReviewPageSize('rakuten-public', 20), 30);
  assert.equal(effectiveReviewPageSize('sephora', 100), 100);
  assert.equal(effectiveReviewPageSize('ulta', 25), 25);
  assert.throws(() => effectiveReviewPageSize('ulta', 26), { code: 'ULTA_REVIEW_INPUT_INVALID' });
});

test('Olive Young suggestions and best sellers stay separate from product keyword search', async () => {
  const factory = { 'oliveyoung-global': () => ({ getSearchSuggestions: async ({ query }) =>
    ({ query, keywords: ['mask'], categories: [], brands: [] }), getBestSellers: async () => ({ products: [], page: { completeCatalog: false } }) }) };
  const reader = await createCatalogReader({ provider: 'oliveyoung-global', operation: 'suggest', args: { query: 'mask' }, factories: factory });
  const result = await reader.product(); assert.deepEqual(result.data.keywords, ['mask']); assert.equal(result.requestedId, null);
  const browse = await createCatalogReader({ provider: 'oliveyoung-global', operation: 'best-sellers', factories: factory });
  assert.equal((await browse.product()).data.page.completeCatalog, false);
  await assert.rejects(createCatalogReader({ provider: 'oliveyoung-global', operation: 'best-sellers', args: { query: 'mask' } }), { code: 'CATALOG_JOB_INVALID' });
  await assert.rejects(createCatalogReader({ provider: 'oliveyoung-global', operation: 'product', args: {} }), { code: 'CATALOG_PRODUCT_ID_REQUIRED' });
});
