import { COMMERCE_PROVIDERS } from './providers.mjs';
import { assertCredentialFreeResult } from './credential-output.mjs';
import { sanitizedCatalogReceipt } from './reviews.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ready = state => ['implemented_pending_live', 'verified_public_read'].includes(state);
const definition = (credentials, args, operations, note) => ({ credentials, args, operations, note });

export function effectiveReviewPageSize(provider, requested) {
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > 100) fail('CATALOG_PAGE_SIZE_INVALID');
  if (provider === 'shopify-storefronts') return Math.min(requested, 5);
  if (provider === 'oliveyoung-global') return Math.min(requested, 10);
  if (provider === 'oliveyoung-public') return Math.min(requested, 10);
  if (provider === 'rakuten-public') return 30;
  if (provider === 'ulta' && requested > 25) fail('ULTA_REVIEW_INPUT_INVALID');
  return requested;
}

/** Availability is per operation. An account cannot supply an unobserved contract. */
export const CATALOG_READERS = Object.freeze({
  'amazon-partner': definition(COMMERCE_PROVIDERS['amazon-partner'].credentials,
    ['id', 'marketplace', 'currency'], { product: 'implemented_pending_live', variations: 'implemented_pending_live', reviews: 'not_exposed_by_official_api' },
    'Creators API requires approved API credentials and PartnerTag; these are separate from a shopper login.'),
  'aliexpress-partner': definition(COMMERCE_PROVIDERS['aliexpress-partner'].credentials,
    ['id', 'country', 'currency', 'language'], { product: 'implemented_pending_live', reviews: 'not_exposed_by_official_api' },
    'The affiliate catalog does not expose full review bodies, SKU options or a long description.'),
  'rakuten-ichiba': definition(COMMERCE_PROVIDERS['rakuten-ichiba'].credentials.filter(key => key !== 'affiliateId'),
    ['id'], { product: 'implemented_pending_live', reviews: 'not_exposed_by_official_api' },
    'Registered applicationId/accessKey are required. Full retailer reviews are a separate service.'),
  'rakuten-public': definition([], ['id', 'shopId', 'itemId', 'reviewUrl', 'productUrl'],
    { product: 'unimplemented', reviews: 'verified_public_read' },
    'Public review bootstrap is separate from the keyed Ichiba product API; identity and media limits stay explicit.'),
  'oliveyoung-global': definition([], ['id', 'query', 'productUrl', 'country', 'currency', 'page', 'categoryId', 'pageSize'],
    { product: 'verified_public_read', reviews: 'verified_public_read', 'review-media': 'verified_public_read',
      'best-sellers': 'verified_public_read', suggest: 'verified_public_read', 'popular-keywords': 'verified_public_read', 'category-products': 'implemented_pending_live' },
    'Global storefront and Korea Curator are separate; price currency is conditional on observed market context.'),
  'ebay-partner': definition(COMMERCE_PROVIDERS['ebay-partner'].credentials.filter(key => !key.startsWith('affiliate')),
    ['id', 'marketplace'], { product: 'implemented_pending_live', variations: 'implemented_pending_live', reviews: 'not_exposed_by_official_api' },
    'Browse product/variant metadata requires an application token; review summaries are distinct from review bodies.'),
  'shopee-id': definition(COMMERCE_PROVIDERS['shopee-id'].credentials,
    ['id'], { product: 'implemented_pending_live', reviews: 'not_exposed_by_official_api' },
    'Affiliate productOfferV2 is an offer record, not full retail detail or a review list.'),
  'shopify-storefronts': { ...definition([], ['id', 'store'], { product: 'verified_public_read', reviews: 'store_specific' },
    'Only the named Allbirds and ColourPop storefronts are supported; review support is store-specific.'),
    storeOperations: { allbirds: { product: 'verified_public_read', reviews: 'source_disabled' },
      colourpop: { product: 'verified_public_read', reviews: 'verified_public_read' } } },
  sephora: definition([], ['id', 'skuId', 'productUrl'], { product: 'verified_public_read', reviews: 'verified_public_read' },
    'Search/price success does not establish product-detail or review support.'),
  ulta: definition([], ['id', 'skuId', 'productUrl'], { product: 'verified_public_read', reviews: 'verified_public_read' },
    'Use the exact productUrl returned by search; product IDs do not imply a product slug.'),
  oliveyoung: definition(COMMERCE_PROVIDERS.oliveyoung.credentials, ['id'],
    { product: 'unimplemented', reviews: 'unimplemented' }, 'Public detail/review contracts were not reached before the access gate.'),
  'oliveyoung-public': { ...definition(['session'], ['id'], { product: 'implemented_pending_live', reviews: 'implemented_pending_live' },
    'Korean browser XHR/source contracts exist; direct HTTP is currently blocked. Optional anonymous cookies are memory-only and do not establish user login.'), credentialsOptional: true },
  'aliexpress-public': definition([], ['id'], { product: 'unimplemented', reviews: 'unimplemented' },
    'SEO metadata is not a complete product/price or review response.'),
  'amazon-public': definition([], ['id', 'marketplace'], { product: 'unimplemented', reviews: 'unimplemented' },
    'Public product JSON and review contracts require independent HTTP verification.'),
  'shopee-public': definition([], ['id', 'shopId'], { product: 'unimplemented', reviews: 'unimplemented' },
    'The observed PDP request returned an access error, not a product record.'),
});

function credentialsFor(provider, supplied) {
  const allowed = CATALOG_READERS[provider].credentials;
  if (!object(supplied) || Object.keys(supplied).some(key => !allowed.includes(key))) fail('CATALOG_CREDENTIAL_FIELDS_INVALID');
  if (allowed.length && !Object.keys(supplied).length && CATALOG_READERS[provider].credentialsOptional !== true) fail('CATALOG_CREDENTIALS_REQUIRED');
  return { ...supplied };
}

/** Drop affiliate output without discarding descriptions, images or options. */
export function catalogOnly(value, field = '') {
  if (Array.isArray(value)) return value.map(item => catalogOnly(item, field));
  if (object(value)) return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/affiliate|promotionurl|promotionlink|partnertag|trackingid|appsignature|authorization|cookie|accesstoken|appsecret|credentialsecret/i.test(key))
    .map(([key, item]) => [key, catalogOnly(item, key)]));
  if (typeof value === 'string' && /(?:url|uri|href|link)$/i.test(field) && /^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (/(^|\.)amazon\.(?:com(?:\.(?:mx|br|au|be|tr))?|co\.(?:uk|jp)|ca|de|fr|it|es|nl|eg|in|ie|pl|sa|se|ae|sg)$/.test(url.hostname) &&
          /\/(?:dp|gp\/product)\/[A-Z0-9]{10}(?:\/|$)/.test(url.pathname)) return `${url.origin}${url.pathname}`;
    } catch { /* Validated provider modules own URL validation. */ }
  }
  return value;
}

function receipts(result) {
  return [result?.receipt?.request ?? result?.receipt, result?.request,
    result?.receipt?.productRequest, result?.receipt?.aggregateRequest, result?.receipt?.currencyRequest,
    result?.receipt?.detailsRequest, result?.receipt?.reviewSummaryRequest,
    result?.receipt?.currencyContextRequest,
    ...(result?.receipts ?? []).map(item => item?.request ?? item),
    ...(result?.pages ?? []).flatMap(page => receipts(page))]
    .map(sanitizedCatalogReceipt).filter(Boolean);
}

export async function createCatalogReader({ provider, operation, args = {}, credentials = {}, factories = {}, now = Date.now } = {}) {
  const def = CATALOG_READERS[provider];
  if (!def || !Object.hasOwn(def.operations, operation) || !object(args) ||
      Object.keys(args).some(key => !def.args.includes(key)) || typeof now !== 'function') fail('CATALOG_JOB_INVALID');
  if (args.page !== undefined && !['review-media', 'category-products'].includes(operation) ||
      (args.categoryId !== undefined || args.pageSize !== undefined) && operation !== 'category-products') fail('CATALOG_JOB_INVALID');
  if (def.storeOperations && !Object.hasOwn(def.storeOperations, args.store ?? 'allbirds')) fail('CATALOG_STORE_UNSUPPORTED');
  const state = def.storeOperations?.[args.store ?? 'allbirds']?.[operation] ?? def.operations[operation];
  if (!ready(state)) fail(state === 'not_exposed_by_official_api' ? 'CATALOG_OPERATION_NOT_EXPOSED_BY_API'
    : state === 'source_disabled' ? 'CATALOG_REVIEW_SOURCE_DISABLED' : 'CATALOG_OPERATION_UNIMPLEMENTED');
  const needsId = ['product', 'reviews', 'review-media', 'variations'].includes(operation);
  if (needsId && (typeof args.id !== 'string' || !args.id.trim() || args.id.length > 256 || /[\x00-\x1f\x7f]/.test(args.id))) fail('CATALOG_PRODUCT_ID_REQUIRED');
  if (!needsId && args.id !== undefined || operation !== 'suggest' && args.query !== undefined) fail('CATALOG_JOB_INVALID');
  if (operation === 'suggest' && (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 120 ||
      /[\x00-\x1f\x7f]/.test(args.query))) fail('CATALOG_QUERY_REQUIRED');
  const cred = credentialsFor(provider, credentials);
  let client;
  if (factories[provider]) client = await factories[provider]({ ...cred, ...args });
  else if (provider === 'amazon-partner') client = (await import('./amazon-creators.mjs'))
    .createAmazonCreatorsClient({ ...cred, marketplace: args.marketplace ?? 'www.amazon.com' });
  else if (provider === 'aliexpress-partner') client = (await import('./aliexpress-affiliate.mjs')).createAliExpressAffiliateClient(cred);
  else if (provider === 'rakuten-ichiba') client = (await import('./rakuten-ichiba.mjs')).createRakutenIchibaClient(cred);
  else if (provider === 'rakuten-public') client = (await import('./rakuten-ichiba-public.mjs')).createRakutenIchibaPublicClient();
  else if (provider === 'oliveyoung-global') client = (await import('./oliveyoung-global.mjs')).createOliveyoungGlobalClient();
  else if (provider === 'oliveyoung-public') client = (await import('./oliveyoung-korea-public.mjs')).createOliveyoungKoreaPublicClient(cred);
  else if (provider === 'ebay-partner') {
    const mod = await import('./ebay-browse.mjs');
    if (!cred.accessToken) cred.accessToken = (await mod.acquireEbayAppToken({ clientId: cred.clientId, clientSecret: cred.clientSecret })).accessToken;
    client = mod.createEbayBrowseClient({ accessToken: cred.accessToken, marketplaceId: args.marketplace ?? 'EBAY_US' });
  }
  else if (provider === 'shopee-id') client = (await import('./shopee-affiliate.mjs')).createShopeeAffiliateClient(cred);
  else if (provider === 'shopify-storefronts') client = (await import('./shopify-storefronts.mjs'))
    .createShopifyStorefrontClient({ store: args.store ?? 'allbirds' });
  else if (provider === 'sephora') client = (await import('./sephora.mjs')).createSephoraPublicClient();
  else if (provider === 'ulta') client = (await import('./ulta.mjs')).createUltaPublicClient();
  else fail('CATALOG_OPERATION_UNIMPLEMENTED');

  const productParams = { productId: args.id, ...(args.skuId ? { skuId: args.skuId } : {}),
    ...(args.productUrl ? { productUrl: args.productUrl } : {}) };
  return {
    async product() {
      let data;
      if (provider === 'amazon-partner') data = operation === 'variations'
        ? await client.getAllVariations({ asin: args.id, currencyOfPreference: args.currency })
        : await client.getItems({ itemIds: [args.id], currencyOfPreference: args.currency });
      else if (provider === 'aliexpress-partner') data = await client.getProduct({ productId: args.id,
        country: args.country ?? 'US', currency: args.currency ?? 'USD', language: args.language ?? 'EN' });
      else if (provider === 'rakuten-ichiba') data = await client.getItem({ itemCode: args.id });
      else if (provider === 'oliveyoung-global') data = operation === 'review-media'
        ? await client.getReviewMedia({ productId: args.id, pageNum: args.page ?? 1, country: args.country, currency: args.currency })
        : operation === 'best-sellers' ? await client.getBestSellers({ country: args.country, currency: args.currency })
          : operation === 'suggest' ? await client.getSearchSuggestions({ query: args.query })
            : operation === 'popular-keywords' ? await client.getPopularKeywords()
              : operation === 'category-products' ? await client.getCategoryProducts({ categoryId: args.categoryId, page: args.page ?? 1,
                pageSize: args.pageSize ?? 24, country: args.country, currency: args.currency })
            : await client.getProduct({ id: args.id, productUrl: args.productUrl, country: args.country, currency: args.currency });
      else if (provider === 'oliveyoung-public') data = await client.getProduct({ goodsNumber: args.id });
      else if (provider === 'ebay-partner') data = operation === 'variations'
        ? await client.getItemGroup({ itemGroupId: args.id }) : await client.getItem({ itemId: args.id });
      else if (provider === 'shopee-id') data = await client.getProductById({ itemId: args.id });
      else if (provider === 'shopify-storefronts') data = await client.getProduct({ handle: args.id });
      else data = await client.getProduct(productParams);
      const safe = catalogOnly(data);
      assertCredentialFreeResult(safe, cred);
      return { schema: 'web-api-product-catalog-v1', provider, operation, requestedId: args.id ?? null,
        ...(args.query ? { query: args.query } : {}),
        checkedAt: new Date(now()).toISOString(), executionMode: 'pure_http', browserUsed: false,
        credentialsUsed: receipts(data).some(receipt => receipt.credentialsUsed === true),
        secretsPersistedInEvidence: false, data: safe, receipts: receipts(data) };
    },
    async reviewsPage({ cursor, pageSize }) {
      let result;
      if (provider === 'shopify-storefronts') result = await client.getReviews({ handle: args.id, pageSize: Math.min(pageSize, 5), ...(cursor === null ? {} : { cursor }) });
      else if (provider === 'rakuten-public') {
        if (args.id !== `${args.shopId}:${args.itemId}`) fail('CATALOG_REVIEW_IDENTITY_MISMATCH');
        result = await client.getReviews({ shopId: args.shopId, itemId: args.itemId, reviewUrl: args.reviewUrl,
          productUrl: args.productUrl, page: cursor ?? 1 });
      } else if (provider === 'oliveyoung-global') result = await client.getReviews({ productId: args.id,
        pageNum: cursor ?? 1, rowsPerPage: Math.min(pageSize, 10), country: args.country, currency: args.currency });
      else if (provider === 'oliveyoung-public') {
        let continuation = null;
        if (cursor !== null) { try { continuation = JSON.parse(cursor); } catch { fail('CATALOG_REVIEW_CONTINUATION_INVALID'); } }
        result = await client.getReviews({ goodsNumber: args.id, continuation, pageSize });
        result = { ...result, productIdMatched: result.productId === args.id,
          nextCursor: result.continuation === null ? null : JSON.stringify(result.continuation),
          paginationVerified: result.loginRequiredIndicated !== true };
      }
      else result = await client.getReviews({ ...productParams, page: cursor ?? 1, pageSize });
      const reviewReceipt = result.receipt?.request ?? result.receipt ?? result.request;
      const matched = result.productIdMatched === true || result.receipt?.productIdMatched === true || reviewReceipt?.productIdMatched === true;
      let nextCursor, paginationVerified;
      if (Object.hasOwn(result, 'nextCursor')) { nextCursor = result.nextCursor; paginationVerified = result.paginationVerified === true || result.receipt?.paginationVerified === true; }
      else if (object(result.pagination) && Object.hasOwn(result.pagination, 'nextPage')) {
        nextCursor = result.pagination.nextPage; paginationVerified = result.paginationVerified === true || result.pagination.verified === true || result.receipt?.paginationVerified === true;
      } else if (result.pagination?.hasMore === false && result.pagination?.verified === true) {
        nextCursor = null; paginationVerified = true;
      } else fail('CATALOG_REVIEW_CONTINUATION_UNVERIFIED');
      const adapted = provider === 'oliveyoung-global' ? result.reviews.map(row => ({ ...row,
        variantLabel: row.optionName, images: row.images.filter(image => image.video !== true).map(image => image.imageUrl) }))
        : provider === 'rakuten-public' ? result.reviews.map(row => ({ ...row,
          identityKind: row.identityKind === 'native_revSubkey' ? 'native_review_id' : row.identityKind,
          postedAt: row.postDate, images: (row.media ?? []).filter(media => media.type === 1).map(media => media.thumbnailUrl) }))
          : result.reviews;
      if (provider === 'oliveyoung-public') for (let index = 0; index < adapted.length; index++) {
        const row = adapted[index];
        adapted[index] = { ...row, postedAt: row.createdAt ?? null, variantLabel: row.optionName ?? null,
          associatedProductReview: row.productRelation === 'related_product',
          images: (row.photos ?? []).map(photo => photo.imagePath).filter(url => typeof url === 'string' && url.startsWith('https://')) };
      }
      const safe = catalogOnly(adapted);
      assertCredentialFreeResult(safe, cred);
      return { productId: args.id, productIdMatched: matched, reviews: safe,
        nextCursor, paginationVerified, total: result.totalReviews ?? result.pagination?.totalReviews ?? result.pagination?.total ?? null, receipts: receipts(result) };
    },
  };
}
