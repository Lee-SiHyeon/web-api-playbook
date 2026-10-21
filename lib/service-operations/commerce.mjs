import { COMMERCE_PROVIDERS, createCommerceReader } from '../commerce/providers.mjs';
import { CATALOG_READERS, createCatalogReader, effectiveReviewPageSize } from '../commerce/catalog-readers.mjs';
import { collectOfferSnapshot } from '../commerce/snapshots.mjs';
import { collectReviews, sanitizedCatalogReceipt, safeReviewCursor } from '../commerce/reviews.mjs';
import { rankingSnapshot } from '../commerce/rankings.mjs';
import { assertCredentialFreeResult } from '../commerce/credential-output.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (required = false) => ({ type: 'string', ...(required ? { required: true } : {}) });
const integer = (value, maximum = 100, minimum = 1) => ({ type: 'integer', default: value, minimum, maximum });
const controls = { limit: integer(20), maxPages: integer(1, 2) };
const reviewControls = provider => ({ ...controls, pageSize: integer(
  provider === 'shopify-storefronts' ? 5 : provider.startsWith('oliveyoung') ? 10 : 20,
  provider === 'shopify-storefronts' ? 5 : provider.startsWith('oliveyoung') ? 10 : provider === 'ulta' ? 25 : 100) });
const fields = names => Object.fromEntries(names.map(name => [name, name === 'pageSize' ? integer(20) : text()]));
const modules = {
  'printful-feed': ['printful', 'createPrintfulCatalogClient'],
  'printful-api': ['printful', 'createPrintfulCatalogClient'],
  'shopify-storefronts': ['shopify-storefronts', 'createShopifyStorefrontClient'],
  'aliexpress-partner': ['aliexpress-affiliate', 'createAliExpressAffiliateClient'],
  'aliexpress-social': ['aliexpress-affiliate', 'createAliExpressAffiliateClient'],
  'ebay-partner': ['ebay-browse', 'createEbayBrowseClient'],
  'amazon-partner': ['amazon-creators', 'createAmazonCreatorsClient'],
  cjdropshipping: ['cjdropshipping', 'createCjDropshippingClient'],
  banggood: ['banggood', 'createBanggoodClient'], awin: ['awin', 'createAwinPublisherFeedClient'],
  impact: ['impact', 'createImpactPartnerCatalogClient'], oliveyoung: ['oliveyoung', 'createOliveyoungCommerceClient'],
  'oliveyoung-public': ['oliveyoung-korea-public', 'createOliveyoungKoreaPublicClient'],
  'oliveyoung-global': ['oliveyoung-global', 'createOliveyoungGlobalClient'],
  'shopee-id': ['shopee-affiliate', 'createShopeeAffiliateClient'],
  'rakuten-ichiba': ['rakuten-ichiba', 'createRakutenIchibaClient'],
  'rakuten-public': ['rakuten-ichiba-public', 'createRakutenIchibaPublicClient'],
  'rakuten-advertising': ['rakuten-advertising', 'createRakutenAdvertisingProductSearchClient'],
  'sephora-affiliate': ['brand-affiliates', 'createSephoraRakutenClient'],
  'ulta-affiliate': ['brand-affiliates', 'createUltaImpactCatalogClient'],
  sephora: ['sephora', 'createSephoraPublicClient'], ulta: ['ulta', 'createUltaPublicClient'],
  ably: ['ably', 'createAblyClient'], adpick: ['adpick-shoppingmate', 'createAdpickReadClient'],
  'yahoo-shopping-jp': ['yahoo-shopping-jp', 'createYahooShoppingJpClient'],
};
const evidenceFor = provider => provider === 'amazon-public' ? 'lib/retail/amazon.mjs#createAmazonPublicClient'
  : `lib/commerce/${modules[provider][0]}.mjs#${modules[provider][1]}`;
const commerceArgs = {
  'printful-feed': ['query', 'region'], 'shopify-storefronts': ['query', 'store', 'pageSize'],
  'aliexpress-partner': ['query', 'currency', 'country', 'language', 'categoryId', 'pageSize'],
  'aliexpress-social': ['query', 'country', 'pageSize'],
  'ebay-partner': ['query', 'marketplace', 'categoryId', 'pageSize'],
  'amazon-partner': ['query', 'currency', 'marketplace', 'pageSize'],
  'amazon-public': ['query', 'pageSize'], cjdropshipping: ['query', 'country', 'categoryId', 'pageSize'],
  banggood: ['query', 'currency', 'categoryId'], awin: ['query', 'locale', 'advertiserId', 'pageSize'],
  impact: ['query', 'catalogId', 'pageSize'], oliveyoung: ['query', 'pageSize'],
  'oliveyoung-public': ['query', 'pageSize'],
  'oliveyoung-global': ['country', 'currency', 'categoryId'], 'shopee-id': ['query', 'pageSize'],
  'rakuten-ichiba': ['query', 'shopCode', 'genreId', 'pageSize'],
  'rakuten-advertising': ['query', 'merchantId', 'pageSize'],
  'sephora-affiliate': ['query', 'merchantId', 'pageSize'], 'ulta-affiliate': ['query', 'catalogId', 'pageSize'],
  sephora: ['query', 'pageSize'], ulta: ['query', 'pageSize'],
};

// Retain business output, including price.raw and opaque pagination tokens, but
// never serialize provider/client state or credential-bearing request headers.
const secretField = /^(?:headers|rawHeaders|requestHeaders|responseHeaders|providerState|credentialState|clientState|session|cookies|cookie|authorization|password|token|accessToken|authToken|refreshToken|anonymousToken|authkey|apiKey|apiSecret|appKey|appSecret|appId|applicationId|accessKey|clientId|clientSecret|credentialId|credentialSecret|credentialVersion|partnerTag|trackingId|appSignature|accountSid|publisherId)$/i;
function finiteJson(value, seen = new Set(), depth = 0) {
  if (depth > 30) fail('COMMERCE_OUTPUT_INVALID');
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('COMMERCE_OUTPUT_INVALID'); return value; }
  if (value instanceof Date) { if (!Number.isFinite(value.getTime())) fail('COMMERCE_OUTPUT_INVALID'); return value.toISOString(); }
  if (typeof value !== 'object' || seen.has(value) ||
      !Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('COMMERCE_OUTPUT_INVALID');
  seen.add(value);
  const result = Array.isArray(value) ? Array.from(value, item => finiteJson(item, seen, depth + 1))
    : Object.fromEntries(Object.entries(value).filter(([key]) => !secretField.test(key))
      .map(([key, item]) => [key, finiteJson(item, seen, depth + 1)]));
  seen.delete(value);
  return result;
}
function redactReceiptPaths(value, credentials) {
  const values = new Set(Object.values(credentials).filter(value => typeof value === 'string' && value.length));
  function visit(value, key = '') {
    if (Array.isArray(value)) return value.map(item => visit(item, key));
    if (object(value)) return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, visit(item, name)]));
    if (key === 'path' && typeof value === 'string') return value.split('/').map(segment => {
      let decoded; try { decoded = decodeURIComponent(segment); } catch { decoded = segment; }
      return values.has(decoded) ? '{redacted}' : segment;
    }).join('/');
    return value;
  }
  return visit(value);
}
function safeFailure(error, signal, credentials) {
  const request = error?.receipt?.request ?? error?.receipt;
  const status = error?.status ?? error?.httpStatus ?? request?.httpStatus;
  const code = signal?.aborted ? 'OPERATION_ABORTED' : status === 429 ? 'COMMERCE_RATE_LIMITED'
    : status === 403 ? 'COMMERCE_ACCESS_DENIED'
      : typeof error?.code === 'string' && /^[A-Z][A-Z0-9_-]{1,100}$/.test(error.code) ? error.code : 'COMMERCE_READ_FAILED';
  const result = Object.assign(new Error(code), { code });
  if (Number.isInteger(status) && status >= 100 && status <= 599) result.status = status;
  const receipt = sanitizedCatalogReceipt(request);
  if (receipt) result.receipt = redactReceiptPaths(finiteJson(receipt), credentials);
  return result;
}
function spec(provider, kind, query = {}, { needsId = false, operation, method, map, description } = {}) {
  return { provider, kind, operation, method, map,
    description: description ?? 'Existing provider read; bounded result scope, never a full-site catalog claim.',
    evidence: `${evidenceFor(provider)}; lib/commerce/${kind === 'offers' ? 'providers' : kind === 'catalog' || kind === 'reviews' ? 'catalog-readers' : modules[provider]?.[0] ?? 'providers'}.mjs`,
    inputs: { ...(needsId ? { path: { id: text(true) } } : {}), ...(Object.keys(query).length ? { query } : {}) } };
}
const direct = (provider, method, query = {}, extra = {}) => spec(provider, 'direct', query, { method, ...extra });
const catalog = (provider, operation, query = {}, extra = {}) => spec(provider, 'catalog', query,
  { needsId: ['product', 'variations', 'review-media'].includes(operation), operation, ...extra });
const check = (operation, query = {}, path) => ({ kind: 'live_read', operation,
  input: { ...(path ? { path } : {}), ...(Object.keys(query).length ? { query } : {}) } });
const fromResult = (operation, pointer) => ({ $result: { operation, pointer } });

function factorySet(provider, client) { return { [provider]: () => client }; }
function adaptersFor(id, operations, options = {}) {
  const clients = new Set(), closed = new WeakSet();
  let disposed = false;
  const now = options.now ?? Date.now;
  const closeClient = async client => {
    if (!client || closed.has(client)) return;
    closed.add(client); clients.delete(client);
    if (typeof client.close === 'function') await client.close();
  };
  async function credentialsFor(provider) {
    const allowed = provider === 'adpick' ? ['apiKey'] : provider === 'yahoo-shopping-jp' ? ['appId']
      : COMMERCE_PROVIDERS[provider]?.credentials ?? [];
    if (!allowed.length || COMMERCE_PROVIDERS[provider]?.credentialsOptional) return {};
    if (typeof options.credentialProvider !== 'function') fail('PROVIDER_MISSING');
    let supplied;
    try { supplied = await options.credentialProvider(id); } catch { fail('PROVIDER_MISSING'); }
    if (!object(supplied)) fail('PROVIDER_MISSING');
    const credentials = Object.fromEntries(allowed.filter(key => supplied[key] !== undefined).map(key => [key, supplied[key]]));
    if (!Object.keys(credentials).length) fail('PROVIDER_MISSING');
    // Reuse an existing app token; never invoke the eBay token-acquisition runner.
    if (provider === 'ebay-partner' && !credentials.accessToken) fail('PROVIDER_MISSING');
    return credentials;
  }
  const adapters = Object.fromEntries(Object.entries(operations).map(([name, operation]) => [`${id}.${name}`, async (input = {}, { signal } = {}) => {
    let client, credentials = {}, networkUsed = false, reads = 0;
    try {
      if (disposed) fail('COMMERCE_ADAPTER_CLOSED');
      if (signal?.aborted) fail('OPERATION_ABORTED');
      const args = { ...input.path, ...input.query };
      const { limit = 20, maxPages = 1, cursor = null, ...params } = args;
      credentials = await credentialsFor(operation.provider);
      if (disposed) fail('COMMERCE_ADAPTER_CLOSED');
      if (signal?.aborted) fail('OPERATION_ABORTED');
      let nativeFetch = options.fetchImpl ?? globalThis.fetch;
      // Keep the existing cookie-free domestic HTTP transport, not a browser or
      // a bypass/retry after an access failure. Injection always takes precedence.
      if (!options.fetchImpl && operation.provider === 'oliveyoung-public' && operation.kind !== 'ranking') {
        nativeFetch = (await import('../commerce/oliveyoung-http-transport.mjs')).createOliveyoungHttpFetch();
      }
      const fetchImpl = async (url, init = {}) => {
        if (signal?.aborted) fail('OPERATION_ABORTED');
        // An arbitrary injected fetch may be a deterministic local fixture.
        // Only a real/default transport (or explicitly attested injection) is
        // current network evidence; invocation alone is not live verification.
        networkUsed = !options.fetchImpl || options.fetchImpl.networkUsed === true; reads++;
        const signals = [signal, init.signal].filter(Boolean);
        return nativeFetch(url, { ...init, ...(signals.length ? { signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) } : {}) });
      };
      const clientOptions = { ...credentials, ...params, fetchImpl, now };
      if (operation.provider === 'ebay-partner') clientOptions.marketplaceId = params.marketplace ?? 'EBAY_US';
      if (operation.provider === 'sephora-affiliate') clientOptions.advertiserMid = params.merchantId;
      if (operation.provider === 'adpick') clientOptions.apiKeyProvider = async () => credentials.apiKey;
      if (operation.provider === 'shopify-storefronts') clientOptions.store = params.store ?? 'allbirds';
      if (operation.kind === 'ranking') {
        const create = options.factories?.['oliveyoung-ranking'] ??
          (await import('../commerce/oliveyoung-korea-ranking.mjs')).createOliveyoungKoreaRankingClient;
        // Default ranking owns its persistent anonymous transport and close().
        client = await create({ now, ...(options.fetchImpl ? { fetchImpl } : {}) });
      } else if (options.factories?.[operation.provider]) client = await options.factories[operation.provider](clientOptions);
      else if (operation.provider === 'amazon-public') client = (await import('../retail/amazon.mjs')).createAmazonPublicClient(clientOptions);
      else {
        const [file, exported] = modules[operation.provider];
        client = (await import(`../commerce/${file}.mjs`))[exported](clientOptions);
      }
      if (!object(client)) fail('COMMERCE_CLIENT_INVALID');
      clients.add(client);
      if (disposed) fail('COMMERCE_ADAPTER_CLOSED');
      if (signal?.aborted) fail('OPERATION_ABORTED');
      let data;
      if (operation.kind === 'offers') {
        const loadPage = await createCommerceReader({ provider: operation.provider, args: params, credentials,
          factories: factorySet(operation.provider, client), now });
        const context = Object.fromEntries(Object.entries(params).filter(([key]) =>
          ['store', 'region', 'marketplace', 'locale', 'currency', 'country', 'productionCurrency', 'advertiserId', 'catalogId', 'query'].includes(key)));
        data = await collectOfferSnapshot({ provider: operation.provider, context: { ...context, operation: name },
          loadPage: async value => { if (signal?.aborted) fail('OPERATION_ABORTED'); return loadPage(value); },
          maxPages: name === 'collect' ? maxPages : 1, maxOffers: limit, now });
        data.credentialsUsed = data.receipts.some(receipt => receipt.credentialsUsed === true);
        data.secretsPersistedInEvidence = false;
      } else if (operation.kind === 'catalog' || operation.kind === 'reviews') {
        const allowedCredentials = CATALOG_READERS[operation.provider].credentials;
        const readerArgs = { ...params };
        if (operation.kind === 'reviews') delete readerArgs.pageSize;
        const reader = await createCatalogReader({ provider: operation.provider, operation: operation.operation ?? name, args: readerArgs,
          credentials: Object.fromEntries(Object.entries(credentials).filter(([key]) => allowedCredentials.includes(key))),
          factories: factorySet(operation.provider, client), now });
        data = operation.kind === 'catalog' ? await reader.product() : await collectReviews({ provider: operation.provider, productId: params.id,
          loadPage: async value => { if (signal?.aborted) fail('OPERATION_ABORTED'); return reader.reviewsPage({ ...value,
            pageSize: effectiveReviewPageSize(operation.provider, params.pageSize ?? 20) }); },
          maxPages, maxReviews: limit, initialCursor: safeReviewCursor(cursor), now });
      } else if (operation.kind === 'ranking') {
        const result = await client.getRanking({ ...params, limit });
        data = rankingSnapshot(result, { limit });
        if (!options.factories?.['oliveyoung-ranking'] && !options.fetchImpl) {
          networkUsed = data.receipts.length > 0; reads = data.receipts.length;
        }
      } else if (operation.kind === 'domestic-reviews') {
        data = await collectReviews({ provider: operation.provider, productId: params.id, maxPages, maxReviews: limit, now,
          initialCursor: safeReviewCursor(cursor), loadPage: async ({ cursor: next }) => {
            if (signal?.aborted) fail('OPERATION_ABORTED');
            let continuation = null;
            if (next !== null) { try { continuation = JSON.parse(next); } catch { fail('CATALOG_REVIEW_CONTINUATION_INVALID'); } }
            const result = await client.getReviews({ goodsNumber: params.id, pageSize: Math.min(params.pageSize ?? 10, 10), continuation });
            return { productId: result.productId, productIdMatched: result.productId === params.id,
              reviews: result.reviews.map(row => ({ ...row, postedAt: row.createdAt ?? null, variantLabel: row.optionName ?? null,
                associatedProductReview: row.productRelation === 'related_product',
                images: (row.photos ?? []).map(photo => photo.imagePath).filter(url => typeof url === 'string' && url.startsWith('https://')) })),
              nextCursor: result.continuation === null ? null : JSON.stringify(result.continuation),
              paginationVerified: result.loginRequiredIndicated !== true, total: result.totalReviews ?? null,
              receipts: result.receipts ?? [result.receipt?.request ?? result.receipt] };
          } });
      } else {
        const callArgs = operation.map ? operation.map({ ...params, limit }) : params;
        if (typeof client[operation.method] !== 'function') fail('COMMERCE_CLIENT_INVALID');
        data = await client[operation.method](callArgs);
        if (operation.provider === 'ably') data = { schema: 'web-api-ably-result-v1', service: 'ably', command: name,
          ok: true, checkedAt: new Date(now()).toISOString(), executionMode: 'pure_http', browserUsed: false,
          accountLogin: false, writesSubmitted: 0, requests: client.receipts, data };
      }
      if (signal?.aborted) fail('OPERATION_ABORTED');
      const result = redactReceiptPaths(finiteJson({ data,
        pageInfo: { completeCatalog: false, scope: data?.collection?.coverage ?? operation.description,
          ...(data?.collection ? { collection: data.collection } : {}), ...(data?.pagination ? { pagination: data.pagination } : {}) },
        receipt: { networkUsed, requestsSent: networkUsed ? reads : 0, transportCalls: reads,
          transportInjected: Boolean(options.fetchImpl || options.factories?.[operation.provider]), browserUsed: false, retryAutomatic: false,
          ...(data?.receipts ? { requests: data.receipts } : {}),
          ...(data?.receipt ? { native: data.receipt } : {}) } }), credentials);
      assertCredentialFreeResult(result, credentials);
      return result;
    } catch (error) { throw safeFailure(error, signal, credentials); }
    finally { await closeClient(client).catch(() => {}); }
  }]));
  return { adapters, async close() { disposed = true; await Promise.all([...clients].map(closeClient)); } };
}

function definition(id, title, operations, verificationChecks = [], metadata = {}) {
  return { id, title, ...metadata, profile: { schemaVersion: 2, serviceId: id, allowedOrigins: [],
    operations: Object.fromEntries(Object.entries(operations).map(([name, op]) => [name, {
      adapter: `${id}.${name}`, semantics: 'read', evidence: op.evidence, description: op.description, inputs: op.inputs,
    }])) }, verificationChecks, createAdapters: (options = {}) => adaptersFor(id, operations, options) };
}
function providerDefinition(provider, id = provider) {
  const supported = COMMERCE_PROVIDERS[provider], operations = {};
  const query = fields(commerceArgs[provider]);
  if (query.query && !['printful-feed', 'impact', 'banggood', 'ulta-affiliate'].includes(provider)) query.query.required = true;
  if (query.store) query.store = { type: 'string', default: 'allbirds', enum: ['allbirds', 'colourpop'] };
  if (provider === 'printful-feed') query.region = { type: 'string', default: 'USA', enum: ['USA', 'Europe', 'Australia', 'Japan', 'Canada', 'Brazil', 'UK', 'China'] };
  if (provider === 'sephora-affiliate') query.merchantId.required = true;
  if (provider === 'ulta-affiliate') query.catalogId.required = true;
  if (provider === 'awin') { query.advertiserId.required = true; query.locale.required = true; }
  for (const operation of ['search', 'collect']) if (supported.operations.includes(operation)) {
    operations[operation] = spec(provider, 'offers', { ...query, ...(operation === 'collect' ? controls : { limit: integer(20) }) });
  }
  if (supported.operations.includes('product')) {
    const productQuery = { ...query, limit: integer(20) }; delete productQuery.query;
    if (provider === 'cjdropshipping') delete productQuery.country;
    if (provider === 'impact') productQuery.catalogId = text(true);
    operations.product = spec(provider, 'offers', productQuery, { needsId: true });
  }
  const catalogDef = CATALOG_READERS[provider];
  if (catalogDef) {
    const catalogQuery = fields(catalogDef.args.filter(key => !['id', 'query', 'page', 'categoryId', 'pageSize'].includes(key)));
    if (catalogQuery.store) catalogQuery.store = { type: 'string', default: 'allbirds', enum: ['allbirds', 'colourpop'] };
    if (['verified_public_read', 'implemented_pending_live'].includes(catalogDef.operations.product)) {
      if (operations.product) operations['product-prices'] = operations.product;
      operations.product = catalog(provider, 'product', catalogQuery);
    }
    if (['verified_public_read', 'store_specific'].includes(catalogDef.operations.reviews)) {
      const reviewQuery = { ...catalogQuery, ...reviewControls(provider), cursor: { type: 'json' } };
      if (provider === 'shopify-storefronts') reviewQuery.store = { type: 'string', default: 'colourpop', enum: ['colourpop'] };
      operations.reviews = spec(provider, 'reviews', reviewQuery, { needsId: true, operation: 'reviews',
        description: 'Bounded public review pages; native identity, body/media and continuation/completeness limits retained.' });
    }
  }
  let checks = operations.search && !['awin', 'sephora-affiliate', 'ulta-affiliate'].includes(provider)
    ? [check('search', { ...(query.query ? { query: provider === 'printful-feed' ? 'shirt' : 'serum' } : {}), limit: 1 })] : [];
  if (provider === 'oliveyoung-global') {
    operations['best-sellers'] = catalog(provider, 'best-sellers', fields(['country', 'currency']));
    operations.suggest = catalog(provider, 'suggest', { query: text(true) });
    operations['popular-keywords'] = catalog(provider, 'popular-keywords');
    operations['category-products'] = catalog(provider, 'category-products', { categoryId: text(true), page: integer(1, 10000),
      pageSize: { type: 'integer', default: 24, enum: [24, 36, 48] }, ...fields(['country', 'currency']) });
    operations['review-media'] = catalog(provider, 'review-media', { page: integer(1, 10000), ...fields(['country', 'currency']) });
    checks = [check('best-sellers'), check('product', {}, { id: fromResult('best-sellers', '/data/products/0/id') }),
      check('reviews', { limit: 1, maxPages: 1 }, { id: fromResult('product', '/data/product/id') })];
  }
  if (provider === 'oliveyoung-public') {
    // The catalog runner intentionally gates this operation's readiness string;
    // the independently implemented anonymous cursor reader is executable today.
    operations.reviews = spec(provider, 'domestic-reviews', { ...reviewControls(provider), cursor: { type: 'json' } }, { needsId: true });
    operations.ranking = spec(provider, 'ranking', { categoryId: text(), limit: integer(10) });
    for (const [name, method] of [['description', 'getProductDescription'], ['review-stats', 'getReviewStats'], ['review-summary', 'getReviewSummary']]) {
      operations[name] = direct(provider, method, {}, { needsId: true, map: ({ id }) => ({ goodsNumber: id }) });
    }
    operations['photo-reviews'] = direct(provider, 'getPhotoReviews', { page: integer(1, 10000), limit: integer(10, 10) },
      { needsId: true, map: ({ id, page, limit }) => ({ goodsNumber: id, pageNumber: page, pageSize: limit }) });
    checks = [check('search', { query: '선크림', limit: 1 }),
      check('reviews', { limit: 1, maxPages: 1 }, { id: fromResult('search', '/offers/0/productId') }),
      check('review-stats', {}, { id: fromResult('search', '/offers/0/productId') })];
  }
  if (provider === 'sephora' || provider === 'ulta') {
    checks = [check('search', { query: 'serum', limit: 1 }),
      check('product', provider === 'ulta' ? { productUrl: fromResult('search', '/offers/0/url') } : {},
        { id: fromResult('search', '/offers/0/productId') }),
      check('reviews', { limit: 1, maxPages: 1,
        skuId: fromResult('product', provider === 'ulta' ? '/data/product/skuId' : '/data/product/currentSku/skuId'),
        ...(provider === 'ulta' ? { productUrl: fromResult('product', '/data/product/productUrl') } : {}) },
      { id: fromResult('product', '/data/product/productId') })];
  }
  if (provider === 'shopify-storefronts') {
    // Shopify product APIs take a handle, not the numeric productId in an offer.
    // Preserve the existing native search result so references bind its actual
    // returned handle; do not derive a handle or invent an ID/slug conversion.
    operations['search-native'] = direct(provider, 'searchProducts', { query: text(true),
      store: { type: 'string', default: 'allbirds', enum: ['allbirds', 'colourpop'] }, limit: integer(1, 10) },
    { map: ({ store, ...input }) => input, description: 'Native named-store predictive search, retaining returned product handles; not a full-site listing.' });
    checks = [check('search-native', { query: 'lipstick', store: 'colourpop', limit: 1 }),
      check('product', { store: 'colourpop' }, { id: fromResult('search-native', '/products/0/handle') }),
      check('reviews', { store: 'colourpop', limit: 1, maxPages: 1 }, { id: fromResult('product', '/data/product/handle') })];
  }
  if (provider === 'impact') {
    operations.catalogs = direct(provider, 'listCatalogs', { campaignId: text() }); checks = [check('catalogs')];
  }
  if (provider === 'banggood') {
    operations.categories = direct(provider, 'listCategories', fields(['categoryId', 'lang'])); checks = [check('categories')];
  }
  if (provider === 'amazon-partner') operations.variations = direct(provider, 'getVariations',
    { currency: text(), page: integer(1, 10), limit: integer(1, 10) }, { needsId: true,
      map: ({ id, currency, page, limit }) => ({ asin: id, variationPage: page, variationCount: limit, ...(currency ? { currencyOfPreference: currency } : {}) }) });
  if (provider === 'ebay-partner') operations.variations = catalog(provider, 'variations', fields(['marketplace']));
  if (provider === 'rakuten-ichiba') operations.genre = direct(provider, 'getGenre', { genreId: text(true) });
  if (provider === 'printful-feed') {
    operations['api-product-prices'] = spec('printful-api', 'offers', { ...fields(['region', 'currency', 'productionCurrency', 'pageSize']), limit: integer(20) }, { needsId: true });
    for (const [name, method, needsId] of [['api-products', 'listProducts', false], ['api-categories', 'listCategories', false], ['api-product', 'getProduct', true], ['api-variants', 'listVariants', true]]) {
      operations[name] = direct('printful-api', method, method === 'getProduct' ? {} : { limit: integer(1), offset: integer(0, 1000000, 0) },
        { needsId, map: method === 'getProduct' ? ({ id }) => ({ productId: Number(id) })
          : ({ id, ...rest }) => ({ ...rest, ...(id ? { productId: Number(id) } : {}) }) });
    }
  }
  const required = provider === 'ebay-partner' ? ['accessToken'] : provider === 'rakuten-ichiba' ? ['applicationId', 'accessKey']
    : provider === 'aliexpress-partner' ? ['appKey', 'appSecret'] : [...supported.credentials];
  return definition(id, `${id} — existing commerce reads`, operations, checks,
    { checklistIds: [supported.service], requires: supported.credentialsOptional ? [] : required,
      ...(id !== provider ? { aliases: [provider] } : {}) });
}

const publicReviews = spec('rakuten-public', 'reviews', { shopId: text(true), itemId: text(true), reviewUrl: text(true), productUrl: text(),
  ...controls, cursor: { type: 'json' } }, { needsId: true, operation: 'reviews' });
const ablyOperations = {
  categories: direct('ably', 'categories'),
  ranking: direct('ably', 'ranking', { categorySno: text(), period: { type: 'string', enum: ['daily', 'weekly', 'monthly'] }, age: text(), limit: integer(10) }, { map: args => args }),
  search: direct('ably', 'search', { query: text(true), limit: integer(10, 150) }, { map: args => args }),
  product: direct('ably', 'product', { options: { type: 'boolean', default: true } }, { needsId: true }),
  outfits: direct('ably', 'outfits', { goodsSno: text(), order: { type: 'string', default: 'recommend', enum: ['recommend', 'recent'] }, limit: integer(10, 90) }, { map: args => args }),
  'style-contents': direct('ably', 'styleContents', { limit: integer(10) }, { map: args => args }),
  markets: direct('ably', 'marketRanking', { type: integer(7, 999), limit: integer(10) }, { map: args => args }),
};
// The native Ably client accepts a positive integer goods sno as well as its
// decimal string. Result-bound checks must retain that native numeric identity.
ablyOperations.product.inputs.path.id = { type: 'json', required: true };

export const definitions = [
  ...Object.keys(COMMERCE_PROVIDERS).filter(provider => provider !== 'printful-api').map(provider =>
    providerDefinition(provider, provider === 'printful-feed' ? 'printful' : provider === 'amazon-public' ? 'amazon'
      : provider === 'shopee-id' ? 'shopee-affiliate-id' : provider)),
  definition('rakuten-public', 'Rakuten Ichiba public review reads', {
    'review-target': direct('rakuten-public', 'resolveReviewTarget', { productUrl: text(true), itemCode: text() }), reviews: publicReviews,
  }, [check('review-target', { productUrl: 'https://item.rakuten.co.jp/kinujo/001/', itemCode: 'kinujo:001' }),
    check('reviews', { shopId: fromResult('review-target', '/shopId'), itemId: fromResult('review-target', '/itemId'),
      reviewUrl: fromResult('review-target', '/reviewUrl'), limit: 1, maxPages: 1 }, { id: fromResult('review-target', '/targetKey') })],
  { checklistIds: ['rakuten-ichiba'] }),
  definition('ably', 'Ably anonymous public reads', ablyOperations,
    [check('ranking', { limit: 1 }), check('product', { options: false }, { id: fromResult('ranking', '/data/items/0/sno') })],
    { checklistIds: ['ably'] }),
  definition('adpick', 'Adpick Shoppingmate documented GET reads', {
    malls: direct('adpick', 'readMalls', { rewardmalls: { type: 'boolean', default: false }, order: { type: 'string', default: 'new', enum: ['new', 'popular', 'commission'] }, pData: text() }),
    search: direct('adpick', 'searchProducts', { q: text(true), limit: integer(1, 20), pData: text() }, { map: args => args }),
    best: direct('adpick', 'bestProducts', { area: { type: 'string', required: true, enum: ['today', 'commission', 'pick', 'popular'] }, limit: integer(1, 10), pData: text() }, { map: args => args }),
  }, [check('malls')], { checklistIds: ['adpick'], requires: ['apiKey'] }),
  definition('yahoo-shopping-jp', 'Yahoo Japan official item search', {
    search: direct('yahoo-shopping-jp', 'search', { ...fields(['query', 'categoryId', 'sellerId', 'jan']), start: integer(1, 999),
      results: integer(1), sort: { type: 'string', default: '-score', enum: ['-score', '+price', '-price', '-review_count'] } }),
  }, [check('search', { query: 'シャンプー', results: 1 })], { checklistIds: ['yahoo-shopping-jp'], requires: ['appId'] }),
];
