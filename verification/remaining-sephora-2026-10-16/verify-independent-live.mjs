import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSephoraPublicClient } from '../../lib/commerce/sephora.mjs';

const outDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(outDir, '../..');
const proofDir = outDir;
const implementationPaths = [
  'lib/commerce/sephora.mjs',
  'lib/commerce/sephora-reviews.mjs',
  'lib/commerce/http.mjs',
];
const readJson = async name => JSON.parse(await readFile(path.join(proofDir, name), 'utf8'));
const [collection, searchProof, pageProof, productProof, variantProof, saleProof, reviewProof, reviewLastProof, skuReviewProof] =
  await Promise.all([
    readJson('collection-summary.json'),
    readJson('catalog-search.json'),
    readJson('catalog-pagination.json'),
    readJson('product-detail.json'),
    readJson('product-variants.json'),
    readJson('sale-price.json'),
    readJson('reviews-page1.json'),
    readJson('reviews-last-page.json'),
    readJson('reviews-sku-filter.json'),
  ]);
const actualHashes = Object.fromEntries(await Promise.all(implementationPaths.map(async file => [
  file,
  createHash('sha256').update(await readFile(path.join(root, file))).digest('hex'),
])));
assert.deepEqual(actualHashes, collection.implementation);
for (const proof of [searchProof, pageProof, productProof, variantProof, saleProof, reviewProof, reviewLastProof, skuReviewProof]) {
  assert.deepEqual(proof.implementation, actualHashes);
  assert.equal(proof.secretsPersistedInEvidence, false);
  assert.equal(proof.credentialsUsed, false);
  assert.equal(proof.request.cookieSent, false);
  assert.equal(proof.request.browserUsed, false);
}

const client = createSephoraPublicClient();
const search = await client.searchAllProducts({ query: 'concealer', pageSize: 60, maxPages: 100 });
assert.equal(search.complete, true);
assert.equal(search.products.length, search.totalProducts);
assert.equal(new Set(search.products.map(item => item.productId)).size, search.totalProducts);
assert.equal(search.receipts.every(receipt => receipt.queryMatched), true);
assert.equal(search.products.every(item => Number.isFinite(item.rating) && Number.isSafeInteger(item.reviewCount)), true);
assert.ok(search.products.some(item => item.images.length > 0));
assert.ok(search.products.some(item => item.salePrice));

const details = await client.getProduct({ productId: 'P417985', skuId: '2234219' });
assert.equal(details.product.productId, 'P417985');
assert.equal(details.product.currentSku.skuId, '2234219');
assert.ok(details.product.variantCount > 0);
assert.equal(new Set(details.product.variants.map(item => item.skuId)).size, details.product.variantCount);
const saleVariant = details.product.variants.find(item => item.skuId === '2234219' && item.salePrice &&
  Number(item.salePrice.amount) < Number(item.listPrice.amount));
assert.ok(saleVariant, 'the selected SKU must still expose an actual salePrice below listPrice');

const familyPage = await client.getReviews({ productId: 'P417985', page: 1, pageSize: 100 });
assert.equal(familyPage.productIdMatched, true);
assert.ok(familyPage.reviews.some(item => item.bodyAvailable));
assert.equal(familyPage.reviews.every(item => item.productId === 'P417985'), true);
const familyLastPageNumber = Math.ceil(familyPage.totalReviews / familyPage.pagination.pageSize);
assert.ok(familyLastPageNumber > 1);
const familyLastPage = await client.getReviews({ productId: 'P417985', page: familyLastPageNumber, pageSize: 100 });
assert.equal(familyLastPage.totalReviews, familyPage.totalReviews);
assert.equal(familyLastPage.pagination.hasMore, false);
assert.equal(familyLastPage.pagination.nextPage, null);
assert.equal(familyLastPage.pagination.verified, true);
const selectedSku = skuReviewProof.matchedResult.skuId;
assert.ok(/^\d{3,16}$/.test(selectedSku));
const skuPage = await client.getReviews({ productId: 'P417985', skuId: selectedSku, page: 1, pageSize: 20 });
assert.equal(skuPage.sourceFilter, `ProductId:${selectedSku};ExcludeFamily:True`);
assert.ok(skuPage.reviews.length > 0);
assert.equal(skuPage.reviews.every(item => item.variantId === selectedSku), true);

const results = {
  schema: 'sephora-independent-live-readback-v1',
  checkedAt: new Date().toISOString(),
  executionMode: 'pure_http',
  independentNodeProcess: true,
  browserUsed: false,
  credentialsUsed: false,
  cookieSent: false,
  externalWrites: 0,
  rawBodiesPersisted: false,
  implementation: actualHashes,
  checks: {
    'catalog.search': {
      outcome: 'verified_live',
      query: 'concealer',
      currentTotalProducts: search.totalProducts,
      returnedProducts: search.products.length,
      uniqueProductIds: new Set(search.products.map(item => item.productId)).size,
      pageCount: search.pageCount,
      pageReturnedCounts: search.pages.map(page => page.returnedProducts),
      ratedProducts: search.products.filter(item => Number.isFinite(item.rating)).length,
      reviewCountProducts: search.products.filter(item => Number.isSafeInteger(item.reviewCount)).length,
      imagedProducts: search.products.filter(item => item.images.length > 0).length,
      productsWithoutValidImages: search.products.filter(item => item.images.length === 0).length,
      salePricedProducts: search.products.filter(item => item.salePrice).length,
      firstRunTotalMatches: search.totalProducts === searchProof.matchedResult.totalProducts,
    },
    'catalog.pagination': {
      outcome: 'verified_live',
      currentTotalProducts: search.totalProducts,
      returnedProducts: search.products.length,
      terminalPageVerified: search.complete && search.products.length === search.totalProducts,
      firstRunPageCountsMatch: JSON.stringify(search.pages.map(page => page.returnedProducts)) ===
        JSON.stringify(pageProof.matchedResult.pageReturnedCounts),
    },
    'catalog.product_detail': {
      outcome: 'verified_live',
      requestedProductId: 'P417985',
      returnedProductId: details.product.productId,
      requestedSkuId: '2234219',
      currentSkuId: details.product.currentSku.skuId,
      matched: true,
      variantCount: details.product.variantCount,
    },
    'catalog.variants': {
      outcome: 'verified_live',
      requestedProductId: 'P417985',
      variantCount: details.product.variantCount,
      uniqueSkuIds: new Set(details.product.variants.map(item => item.skuId)).size,
      variantsWithOptionLabels: details.product.variants.filter(item => item.options.length > 0).length,
      variantsWithImages: details.product.variants.filter(item => item.images.length > 0).length,
    },
    'catalog.sale_price': {
      outcome: 'verified_live',
      productId: details.product.productId,
      skuId: saleVariant.skuId,
      listPrice: saleVariant.listPrice,
      salePrice: saleVariant.salePrice,
      discounted: Number(saleVariant.salePrice.amount) < Number(saleVariant.listPrice.amount),
    },
    'catalog.reviews.read': {
      outcome: 'verified_live',
      productId: familyPage.productId,
      page: familyPage.pagination.page,
      pageSize: familyPage.pagination.pageSize,
      totalReviews: familyPage.totalReviews,
      returned: familyPage.reviews.length,
      bodyCount: familyPage.reviews.filter(item => item.bodyAvailable).length,
      allFamilyBound: familyPage.reviews.every(item => item.productId === 'P417985'),
      firstRunTotalMatches: familyPage.totalReviews === reviewProof.matchedResult.totalReviews,
    },
    'catalog.reviews.pagination': {
      outcome: 'verified_live',
      lastPage: familyLastPageNumber,
      returned: familyLastPage.reviews.length,
      totalReviews: familyLastPage.totalReviews,
      terminalPageVerified: !familyLastPage.pagination.hasMore && familyLastPage.pagination.nextPage === null,
      firstRunLastPageMatches: familyLastPageNumber === reviewLastProof.matchedResult.page,
    },
    'catalog.reviews.variant_filter': {
      outcome: 'verified_live',
      productId: skuPage.productId,
      skuId: selectedSku,
      sourceFilter: skuPage.sourceFilter,
      totalReviews: skuPage.totalReviews,
      returned: skuPage.reviews.length,
      allVariantIdsMatched: skuPage.reviews.every(item => item.variantId === selectedSku),
    },
  },
};
await writeFile(path.join(proofDir, 'independent-readback.json'), `${JSON.stringify(results, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(results));
