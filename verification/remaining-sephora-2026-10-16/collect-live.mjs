import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSephoraPublicClient } from '../../lib/commerce/sephora.mjs';

const outDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(outDir, '../..');
const hashPaths = [
  'lib/commerce/sephora.mjs',
  'lib/commerce/sephora-reviews.mjs',
  'lib/commerce/http.mjs',
];
const implementation = Object.fromEntries(await Promise.all(hashPaths.map(async file => [
  file,
  createHash('sha256').update(await readFile(path.join(root, file))).digest('hex'),
])));
const client = createSephoraPublicClient();
const summary = {
  schema: 'sephora-live-revalidation-run-v1',
  startedAt: new Date().toISOString(),
  executionMode: 'pure_http',
  browserUsed: false,
  credentialsUsed: false,
  accountCredentialsUsed: false,
  secretsPersistedInEvidence: false,
  externalWrites: 0,
  implementation,
  capabilities: {},
};

const shortError = error => ({
  outcome: 'failed',
  code: /^[A-Z][A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : 'UNEXPECTED_ERROR',
  request: error?.receipt && typeof error.receipt === 'object' ? {
    method: error.receipt.method ?? null,
    origin: error.receipt.origin ?? null,
    path: error.receipt.path ?? null,
    checkedAt: error.receipt.checkedAt ?? null,
    httpStatus: Number.isInteger(error.receipt.httpStatus) ? error.receipt.httpStatus : null,
    mime: error.receipt.mime ?? null,
    browserUsed: error.receipt.browserUsed === false ? false : null,
    credentialsUsed: error.receipt.credentialsUsed === false ? false : null,
    cookieSent: error.receipt.cookieSent === false ? false : null,
  } : null,
});

async function run(id, action) {
  try {
    const value = await action();
    summary.capabilities[id] = { outcome: 'success', checkedAt: value.checkedAt };
    return value;
  } catch (error) {
    summary.capabilities[id] = shortError(error);
    return null;
  }
}

async function saveProof(filename, capabilityId, sourceReceipt, matchedResult, extra = {}) {
  const proof = {
    schema: 'web-api-public-read-receipt-v1',
    service: 'sephora',
    capabilityId,
    checkedAt: sourceReceipt.checkedAt,
    secretsPersistedInEvidence: false,
    anonymous: true,
    credentialsUsed: false,
    authenticated: false,
    schemaVerified: true,
    expectedResultVerified: true,
    contractProvenance: sourceReceipt.contractProvenance,
    request: sourceReceipt.request,
    implementation,
    executionMode: 'pure_http',
    browserUsed: false,
    accountCredentialsUsed: false,
    ...extra,
    matchedResult,
  };
  if (sourceReceipt.publicKeyBootstrap) proof.publicKeyBootstrap = sourceReceipt.publicKeyBootstrap;
  await writeFile(path.join(outDir, filename), `${JSON.stringify(proof, null, 2)}\n`, 'utf8');
  return proof;
}

await mkdir(outDir, { recursive: true });

const search = await run('catalog.search', async () => {
  const result = await client.searchAllProducts({ query: 'concealer', pageSize: 60, maxPages: 100 });
  const ids = result.products.map(item => item.productId);
  const priced = result.products.filter(item => item.price || item.priceRange).length;
  const validUrls = result.products.filter(item => /^https:\/\/www\.sephora\.com\/product\//.test(item.productUrl)).length;
  const rated = result.products.filter(item => Number.isFinite(item.rating) && item.rating >= 0 && item.rating <= 5).length;
  const reviewed = result.products.filter(item => Number.isSafeInteger(item.reviewCount) && item.reviewCount >= 0).length;
  const imaged = result.products.filter(item => item.images.length > 0).length;
  const salePriced = result.products.filter(item => item.salePrice).length;
  if (!result.complete || !result.totalProducts || result.products.length !== result.totalProducts ||
      new Set(ids).size !== ids.length || priced !== result.products.length || validUrls !== result.products.length ||
      rated !== result.products.length || reviewed !== result.products.length || imaged < 1 || salePriced < 1 ||
      result.receipts.some(receipt => receipt.queryMatched !== true)) throw Object.assign(new Error(), { code: 'SEARCH_RESULT_NOT_COMPLETE' });
  const first = result.receipts[0];
  await saveProof('catalog-search.json', 'catalog.search', first, {
    query: result.query,
    queryMatched: true,
    page: 1,
    pageSize: result.pageSize,
    totalProducts: result.totalProducts,
    pageCount: result.pageCount,
    returnedProducts: result.products.length,
    uniqueProductIds: new Set(ids).size,
    pricedProducts: priced,
    validatedProductUrls: validUrls,
    ratedProducts: rated,
    reviewCountProducts: reviewed,
    imagedProducts: imaged,
    productsWithoutValidImages: result.products.length - imaged,
    salePricedProducts: salePriced,
    currency: 'USD',
  });
  return { checkedAt: first.checkedAt, result };
});

if (search) {
  const result = search.result;
  await saveProof('catalog-pagination.json', 'catalog.pagination', result.receipts.at(-1), {
    query: result.query,
    queryMatched: true,
    firstPage: 1,
    lastPage: result.pageCount,
    pageCount: result.pageCount,
    pageSize: result.pageSize,
    totalProducts: result.totalProducts,
    returnedProducts: result.products.length,
    uniqueProductIds: new Set(result.products.map(item => item.productId)).size,
    pageReturnedCounts: result.pages.map(page => page.returnedProducts),
    terminationVerified: result.complete === true && result.products.length === result.totalProducts,
  });
  summary.capabilities['catalog.pagination'] = { outcome: 'success', checkedAt: result.receipts.at(-1).checkedAt };
}

const saleProduct = await run('catalog.product_detail', async () => {
  const result = await client.getProduct({ productId: 'P417985', skuId: '2234219' });
  const product = result.product;
  if (product.productId !== 'P417985' || product.currentSku.skuId !== '2234219' || !product.variantCount ||
      product.variants.length !== product.variantCount || !product.productUrl) throw Object.assign(new Error(), { code: 'PRODUCT_IDENTITY_NOT_VERIFIED' });
  await saveProof('product-detail.json', 'catalog.product_detail', result.receipt, {
    productId: product.productId,
    requestedProductId: 'P417985',
    productIdMatched: true,
    currentSkuId: product.currentSku.skuId,
    requestedSkuId: '2234219',
    currentSkuMatched: true,
    variantCount: product.variantCount,
    images: product.currentSku.images.length,
    descriptionReturned: Boolean(product.description),
    descriptionStatus: product.descriptionStatus,
  }, { requestedProductId: 'P417985', productIdMatched: true, requestedSkuId: '2234219', currentSkuMatched: true });
  return { checkedAt: result.receipt.checkedAt, result };
});

if (saleProduct) {
  const product = saleProduct.result.product;
  const variants = product.variants;
  const skuIds = variants.map(variant => variant.skuId);
  const saleVariants = variants.filter(variant => variant.salePrice &&
    Number(variant.salePrice.amount) < Number(variant.listPrice.amount));
  const optionRows = variants.filter(variant => Array.isArray(variant.options) && variant.options.length > 0);
  const imageRows = variants.filter(variant => variant.images.length > 0);
  if (new Set(skuIds).size !== variants.length || !optionRows.length || !variants.every(variant =>
    variant.skuId && variant.title && variant.listPrice && ['in_stock', 'out_of_stock'].includes(variant.availability))) {
    summary.capabilities['catalog.variants'] = { outcome: 'failed', code: 'VARIANT_SHAPE_INCOMPLETE' };
  } else {
    await saveProof('product-variants.json', 'catalog.variants', saleProduct.result.receipt, {
      productId: product.productId,
      requestedProductId: 'P417985',
      productIdMatched: true,
      currentSkuId: product.currentSku.skuId,
      variantCount: variants.length,
      uniqueSkuIds: new Set(skuIds).size,
      variantsWithOptionLabels: optionRows.length,
      variantsWithImages: imageRows.length,
      pricedVariants: variants.filter(variant => variant.listPrice).length,
      onSaleVariantCount: saleVariants.length,
      allAvailabilityValuesMapped: variants.every(variant => ['in_stock', 'out_of_stock'].includes(variant.availability)),
    }, { requestedProductId: 'P417985', productIdMatched: true, requestedSkuId: '2234219', currentSkuMatched: true });
    summary.capabilities['catalog.variants'] = { outcome: 'success', checkedAt: saleProduct.checkedAt };
  }
  const sale = saleVariants.find(variant => variant.skuId === '2234219') ?? saleVariants[0];
  if (!sale) {
    summary.capabilities['catalog.sale_price'] = { outcome: 'failed', code: 'NO_RETURNED_SALE_PRICE' };
  } else {
    await saveProof('sale-price.json', 'catalog.sale_price', saleProduct.result.receipt, {
      productId: product.productId,
      requestedProductId: 'P417985',
      productIdMatched: true,
      skuId: sale.skuId,
      requestedSkuId: '2234219',
      currentSkuMatched: sale.skuId === '2234219',
      listPrice: sale.listPrice,
      salePrice: sale.salePrice,
      discounted: Number(sale.salePrice.amount) < Number(sale.listPrice.amount),
      currency: sale.salePrice.currency,
    }, { requestedProductId: 'P417985', productIdMatched: true, requestedSkuId: '2234219',
      currentSkuMatched: product.currentSku.skuId === '2234219' });
    summary.capabilities['catalog.sale_price'] = { outcome: 'success', checkedAt: saleProduct.checkedAt };
  }
}

const reviewFamilyProduct = await run('catalog.reviews.read', async () => {
  const result = await client.getProduct({ productId: 'P417985', skuId: '2234219' });
  if (result.product.productId !== 'P417985' || !result.product.currentSku.skuId) throw Object.assign(new Error(), { code: 'REVIEW_PRODUCT_IDENTITY_NOT_VERIFIED' });
  const first = await client.getReviews({ productId: 'P417985', page: 1, pageSize: 100 });
  if (!first.reviews.length || first.productIdMatched !== true ||
      !first.reviews.some(review => review.bodyAvailable) || !first.reviews.every(review => review.productId === 'P417985')) {
    throw Object.assign(new Error(), { code: 'REVIEW_BODY_OR_FAMILY_NOT_VERIFIED' });
  }
  await saveProof('reviews-page1.json', 'catalog.reviews.read', first.receipt, {
    productId: first.productId,
    requestedProductId: 'P417985',
    productIdMatched: true,
    sourceFilter: first.sourceFilter,
    page: first.pagination.page,
    pageSize: first.pagination.pageSize,
    offset: first.pagination.offset,
    totalReviews: first.totalReviews,
    returned: first.reviews.length,
    familyBound: first.reviews.filter(review => review.productId === 'P417985').length,
    bodyCount: first.reviews.filter(review => review.bodyAvailable).length,
    hasMore: first.pagination.hasMore,
    nextPage: first.pagination.nextPage,
    verified: first.pagination.verified,
  }, { publicApiKeyUsed: first.receipt.publicApiKeyUsed, publicApiKeyPersisted: false,
    productIdMatched: true, sourceFilter: first.sourceFilter, pagination: first.pagination,
    publicKeyBootstrap: first.receipt.publicKeyBootstrap });
  return { checkedAt: first.receipt.checkedAt, product: result.product, first };
});

if (reviewFamilyProduct) {
  const { first } = reviewFamilyProduct;
  const reviewSkuId = first.reviews.find(review => review.variantId)?.variantId ?? reviewFamilyProduct.product.currentSku.skuId;
  const pageSize = first.pagination.pageSize;
  const lastPage = Math.max(1, Math.ceil(first.totalReviews / pageSize));
  if (lastPage < 2 || !first.pagination.hasMore) {
    summary.capabilities['catalog.reviews.pagination'] = {
      outcome: 'limited', code: 'CURRENT_TOTAL_DOES_NOT_REQUIRE_MULTIPAGE_TERMINATION', totalReviews: first.totalReviews,
    };
  } else {
    const last = await run('catalog.reviews.pagination', async () => {
      const result = await client.getReviews({ productId: 'P417985', page: lastPage, pageSize });
      if (result.totalReviews !== first.totalReviews || result.pagination.page !== lastPage ||
          result.pagination.offset !== (lastPage - 1) * pageSize || result.pagination.hasMore !== false ||
          result.pagination.nextPage !== null || result.pagination.verified !== true || !result.reviews.length) {
        throw Object.assign(new Error(), { code: 'REVIEW_FINAL_PAGE_NOT_VERIFIED' });
      }
      await saveProof('reviews-last-page.json', 'catalog.reviews.pagination', result.receipt, {
        productId: result.productId,
        requestedProductId: 'P417985',
        productIdMatched: true,
        sourceFilter: result.sourceFilter,
        page: result.pagination.page,
        pageSize: result.pagination.pageSize,
        offset: result.pagination.offset,
        totalReviews: result.totalReviews,
        returned: result.reviews.length,
        familyBound: result.reviews.filter(review => review.productId === 'P417985').length,
        bodyCount: result.reviews.filter(review => review.bodyAvailable).length,
        hasMore: result.pagination.hasMore,
        nextPage: result.pagination.nextPage,
        terminationVerified: true,
      }, { publicApiKeyUsed: result.receipt.publicApiKeyUsed, publicApiKeyPersisted: false,
        productIdMatched: true, sourceFilter: result.sourceFilter, pagination: result.pagination,
        publicKeyBootstrap: result.receipt.publicKeyBootstrap });
      return { checkedAt: result.receipt.checkedAt, result };
    });
    if (last) summary.capabilities['catalog.reviews.pagination'] = { outcome: 'success', checkedAt: last.checkedAt };
  }

  const skuId = reviewSkuId;
  const skuReviews = await run('catalog.reviews.variant_filter', async () => {
    const result = await client.getReviews({ productId: 'P417985', skuId, page: 1, pageSize: 20 });
    if (!result.reviews.length || result.productIdMatched !== true || result.sourceFilter !== `ProductId:${skuId};ExcludeFamily:True` ||
        !result.reviews.every(review => review.variantId === skuId) || !result.pagination.verified) {
      throw Object.assign(new Error(), { code: 'SKU_REVIEW_SCOPE_NOT_VERIFIED' });
    }
    await saveProof('reviews-sku-filter.json', 'catalog.reviews.variant_filter', result.receipt, {
      productId: result.productId,
      requestedProductId: 'P417985',
      productIdMatched: true,
      skuId,
      requestedSkuId: skuId,
      sourceFilter: result.sourceFilter,
      page: result.pagination.page,
      pageSize: result.pagination.pageSize,
      totalReviews: result.totalReviews,
      returned: result.reviews.length,
      allVariantIdsMatched: result.reviews.every(review => review.variantId === skuId),
      uniqueReviewIds: new Set(result.reviews.map(review => review.reviewId)).size,
      verified: result.pagination.verified,
    }, { publicApiKeyUsed: result.receipt.publicApiKeyUsed, publicApiKeyPersisted: false,
      productIdMatched: true, sourceFilter: result.sourceFilter, pagination: result.pagination,
      publicKeyBootstrap: result.receipt.publicKeyBootstrap });
    return { checkedAt: result.receipt.checkedAt, result };
  });
}

summary.completedAt = new Date().toISOString();
await writeFile(path.join(outDir, 'collection-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  schema: summary.schema,
  startedAt: summary.startedAt,
  completedAt: summary.completedAt,
  executionMode: summary.executionMode,
  browserUsed: summary.browserUsed,
  credentialsUsed: summary.credentialsUsed,
  externalWrites: summary.externalWrites,
  implementation: summary.implementation,
  capabilities: summary.capabilities,
}));
