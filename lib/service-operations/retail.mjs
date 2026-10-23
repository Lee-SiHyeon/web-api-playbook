import path from 'node:path';
import os from 'node:os';
import { createAliExpressPublicClient } from '../retail/aliexpress.mjs';
import { createAmazonPublicClient } from '../retail/amazon.mjs';
import { createAmazonNavigationClient } from '../retail/amazon-navigation.mjs';
import { crawlAmazonSearch } from '../retail/amazon-crawl.mjs';
import { createEbayPublicClient } from '../retail/ebay.mjs';
import { createWalmartPublicClient } from '../retail/walmart.mjs';
import { createAllbirdsPublicClient } from '../retail/shopify.mjs';
import { createOverseasSitemapClient } from '../retail/overseas-sitemaps.mjs';
import { createSheinPublicClient } from '../retail/shein.mjs';
import { createJapanPublicClient, crawlJapanPublic } from '../retail/japan-public.mjs';
import { japanDestination } from '../retail/japan-http.mjs';
import * as coupang from '../retail/coupang-public.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const string = (required = false) => ({ type: 'string', ...(required ? { required: true } : {}) });
const integer = (minimum, maximum, value) => ({ type: 'integer', minimum, maximum,
  ...(value === undefined ? {} : { default: value }) });
const json = { type: 'json' };
const queryInput = { query: string(true) };
const urlInput = { path: { url: string(true) } };
const source = file => `lib/retail/${file}.mjs`;
const read = (evidence, inputs, run, description) => ({ evidence, inputs, run, description });
const check = (operation, input = {}) => [{ kind: 'live_read', operation, input }];
// References resolve against the preceding operation's native .data projection.
// An empty/failed predecessor is skipped by the common verifier, never replaced
// with a recorded ID, fabricated URL, or another search page.
const fromResult = (operation, pointer) => ({ $result: { operation, pointer } });

// Only the public projections returned by the maintained modules are exposed.
// Drop request-header values and local persistence receipts, not business fields
// such as raw price labels, source paths, partial coverage, or sourceFormat.
const privateKeys = new Set(['explicitHeadersSent', 'headers', 'rawHeaders', 'storage',
  'cookieJar', 'providerState', 'rawBody', 'rawHtml', 'authorization', 'accessToken', 'refreshToken']);
function finite(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('RETAIL_RESULT_INVALID'); return value; }
  if (!value || typeof value !== 'object' || ancestors.has(value)
    || !Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('RETAIL_RESULT_INVALID');
  ancestors.add(value);
  const output = Array.isArray(value)
    ? Array.from(value, item => item === undefined ? null : finite(item, ancestors))
    : Object.fromEntries(Object.entries(value).filter(([key, item]) => item !== undefined && !privateKeys.has(key))
      .map(([key, item]) => [key, finite(item, ancestors)]));
  ancestors.delete(value);
  return output;
}
const nativeReceipt = result => result.receipt ?? result.request
  ?? { requests: result.requests ?? result.receipts ?? [] };
function responseStatus(value) {
  if (!value || typeof value !== 'object') return undefined;
  const direct = value.httpStatus ?? value.status;
  if (Number.isInteger(direct) && direct >= 100 && direct <= 599) return direct;
  for (const key of ['request', 'receipt', 'requests', 'receipts', 'pages', 'runs']) {
    const child = value[key];
    const status = Array.isArray(child) ? child.map(responseStatus).filter(value => value !== undefined).at(-1) : responseStatus(child);
    if (status !== undefined) return status;
  }
  return undefined;
}
function resultEnvelope(result, nativeNetwork) {
  const status = responseStatus(result);
  return finite({ data: result,
    pageInfo: result.pagination ?? result.data?.pagination ?? result.coverage?.pagination
      ?? result.collection ?? (Object.hasOwn(result, 'nextOffset') ? {
        nextOffset: result.nextOffset, snapshotSha256: result.snapshotSha256,
        shardComplete: result.shardComplete, completeCatalog: false } : {}),
    // Proof is a native fetch binding AND an observed HTTP response status in
    // the maintained client's sanitized receipt, never merely a resolved call.
    // Injected transports cannot claim live network, even with a fixture 200.
    receipt: { ...nativeReceipt(result), ...(status === undefined ? {} : { httpStatus: status }),
      networkUsed: nativeNetwork && status !== undefined } });
}
function safeFailure(error, nativeNetwork) {
  const code = /^[A-Z][A-Z0-9_]{1,100}$/.test(error?.code ?? '') ? error.code : 'RETAIL_READ_FAILED';
  const safe = Object.assign(new Error(code), { code });
  const status = responseStatus(error) ?? responseStatus(error?.partialResult);
  if (status !== undefined) safe.status = status;
  // Never propagate an arbitrary error message, cause, detail, provider, or state.
  try { safe.receipt = finite({ ...(error?.receipt ?? {}), ...(status === undefined ? {} : { httpStatus: status }),
    networkUsed: nativeNetwork && status !== undefined }); }
  catch { safe.receipt = { networkUsed: false }; }
  if (error?.partialResult) safe.partialResult = finite(error.partialResult);
  return safe;
}

// Keep the original fetch identity when no cancellation bridge is necessary:
// Coupang's native receipts intentionally distinguish an injected transport.
function transportOptions(options, signal) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  return { fetchImpl: signal ? (url, init = {}) => {
    if (signal.aborted) fail('OPERATION_ABORTED');
    return fetchImpl(url, { ...init, signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal });
  } : fetchImpl, ...(options.now === undefined ? {} : { now: options.now }) };
}

function definition(id, title, checklistIds, aliases, operations, verificationChecks) {
  return { id, title, checklistIds, aliases,
    profile: { schemaVersion: 2, serviceId: id, allowedOrigins: [],
      operations: Object.fromEntries(Object.entries(operations).map(([name, spec]) => [name, {
        adapter: `${id}.${name}`, semantics: 'read', evidence: spec.evidence,
        description: spec.description ?? `${title}: ${name}`, inputs: spec.inputs,
      }])) },
    verificationChecks,
    createAdapters(options = {}) {
      let closed = false;
      const resources = new Map();
      const nativeNetwork = options.fetchImpl === undefined || options.fetchImpl === globalThis.fetch;
      return { adapters: Object.fromEntries(Object.entries(operations).map(([name, spec]) => [`${id}.${name}`,
        async (input, { signal } = {}) => {
          if (closed) fail('RETAIL_ADAPTER_CLOSED');
          if (signal?.aborted) fail('OPERATION_ABORTED');
          const runtime = { ...options, ...transportOptions(options, signal), resources, serviceId: id };
          try {
            const result = await spec.run(input, runtime);
            if (signal?.aborted) fail('OPERATION_ABORTED');
            return resultEnvelope(result, nativeNetwork);
          } catch (error) {
            throw safeFailure(signal?.aborted ? { code: 'OPERATION_ABORTED' } : error, nativeNetwork);
          }
        }])),
      close() { closed = true; resources.clear(); } };
    } };
}

// These two session modules already validate their native state and reuse the
// protected store. No import/bootstrap/login operation is exposed here.
// An injected provider may return that SAME native state object (schema below),
// retained only for this adapter lifetime; otherwise the existing store is used.
// sessionName selects a store entry, not a new service/session contract.
async function sessionStore(options, nativeName, schema) {
  const selected = options.sessionName ?? nativeName;
  if (typeof selected !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(selected)) fail('PROTECTED_STORE_NAME_INVALID');
  if (!options.resources.has('store')) options.resources.set('store', (async () => {
    let store;
    if (options.credentialProvider !== undefined) {
      if (typeof options.credentialProvider !== 'function') fail('PROVIDER_MISSING');
      const state = await providerCredential(options, options.serviceId);
      if (state == null) fail('PROVIDER_MISSING');
      if (state.schema !== schema) fail('RETAIL_PROVIDER_STATE_INVALID');
      let raw = JSON.stringify(state);
      store = { directory: path.resolve(options.storeDirectory ?? path.join(os.tmpdir(), 'playbook-retail-provider')),
        read: () => raw, write: (_name, value) => { raw = value; return { available: true }; } };
    } else {
      const { ProtectedStore } = await import('../protected-store.mjs');
      try { store = new ProtectedStore({ directory: options.storeDirectory }); }
      catch (error) {
        if (['PROTECTED_STORE_PROVIDER_REQUIRED', 'PROTECTED_STORE_PROVIDER_UNSUPPORTED'].includes(error?.code)) fail('PROVIDER_MISSING');
        throw error;
      }
    }
    return { directory: store.directory, read: () => store.read(selected), write: (_name, value) => store.write(selected, value) };
  })());
  return options.resources.get('store');
}

async function providerCredential(options, id) {
  try { return await options.credentialProvider(id); }
  catch { fail('PROVIDER_UNAVAILABLE'); }
}

async function sitemapRead(client, task) {
  try { return await task(); }
  catch (error) {
    // OverseasSitemapError has a stable code/detail but does not attach its
    // already-sanitized HTTP receipt. Preserve it for common error reporting.
    const receipt = client.getReceipts().at(-1);
    if (receipt) error.receipt = receipt;
    throw error;
  }
}

const sitemapPageInputs = { path: { shardPath: string(true) }, query: {
  offset: integer(0, 1_000_000, 0), limit: integer(1, 1000, 100), snapshotSha256: string() } };
function sitemapOperations(service) {
  return {
    'sitemap-index': read(`${source('overseas-sitemaps')}#createOverseasSitemapClient.listShards; scripts/overseas-retail.mjs`, {},
      async (_input, options) => {
        const client = createOverseasSitemapClient(service, options);
        const shards = await sitemapRead(client, () => client.listShards());
        if (!shards.length) fail('SITEMAP_INDEX_EMPTY');
        return { shards, completeCatalog: false, coverage: 'public_product_identity_and_lastmod_only', requests: client.getReceipts() };
      }, 'Public sitemap index, not priced offers (AliExpress uses two observed indexes).'),
    'sitemap-products': read(`${source('overseas-sitemaps')}#createOverseasSitemapClient.listProductsPage; scripts/overseas-retail.mjs`, sitemapPageInputs,
      async ({ path: p, query: q = {} }, options) => {
        if ((q.offset ?? 0) > 0 && q.snapshotSha256 === undefined) fail('SNAPSHOT_REQUIRED_FOR_RESUME');
        const client = createOverseasSitemapClient(service, options);
        return sitemapRead(client, () => client.listProductsPage(p.shardPath, {
          offset: q.offset ?? 0, limit: q.limit ?? 100, expectedSnapshotSha256: q.snapshotSha256 }));
      }, 'One already-observed shard; resume requires its snapshot hash. Identity/lastmod only, no price or stock.'),
  };
}

function japanDefinition(service) {
  const id = service === 'rakuten' ? 'japan-rakuten' : 'retail-yahoo-shopping-jp';
  const evidence = `${source('japan-public')}#createJapanPublicClient; scripts/japan-retail.mjs`;
  const operations = {
    home: read(evidence, {}, (_input, options) => createJapanPublicClient({ ...options, service }).home()),
    page: read(evidence, urlInput, ({ path: p }, options) => createJapanPublicClient({ ...options, service }).read(p.url)),
    product: read(evidence, urlInput, ({ path: p }, options) => {
      if (japanDestination(service, p.url)?.kind !== 'product') fail('JAPAN_PRODUCT_URL_REQUIRED');
      return createJapanPublicClient({ ...options, service }).read(p.url);
    }),
    crawl: read(`${source('japan-public')}#crawlJapanPublic; scripts/japan-retail.mjs`, {
      query: { maxPages: integer(1, 5, 1) }, body: { state: json } },
    async ({ query: q = {}, body: b = {} }, options) => {
      const result = await crawlJapanPublic({ service, state: b.state, maxPages: q.maxPages ?? 1,
        client: createJapanPublicClient({ ...options, service }) });
      // A blocked traversal is evidence, never a successful verification.
      if (result.collection.blocked) {
        const blocked = result.nodes.find(node => node.state.startsWith('blocked_'));
        throw Object.assign(new Error(blocked.stopReason), { code: blocked.stopReason, partialResult: result,
          receipt: { httpStatus: blocked.httpStatus, pagesReadThisRun: result.collection.pagesReadThisRun } });
      }
      return result;
    }, 'Bounded read traversal; state is returned as JSON, not saved or scheduled. Blocked evidence is retained on error.'),
  };
  if (service === 'rakuten') operations.search = read(evidence, { query: {
    ...queryInput, categoryId: string(), page: integer(1, 150, 1) } },
  ({ query: q }, options) => createJapanPublicClient({ ...options, service }).search(q));
  // Official application-ID Yahoo search is owned by the commerce definition.
  return definition(id, service === 'rakuten' ? 'Rakuten Ichiba public retail' : 'Yahoo Japan public retail',
    [service === 'rakuten' ? 'rakuten-ichiba' : 'yahoo-shopping-jp'],
    [service === 'rakuten' ? 'japan-rakuten-storefront-public' : 'retail-yahoo-jp-public'], operations, [
      ...check('home'),
      ...check('page', { path: { url: fromResult('home', service === 'rakuten'
        ? '/data/links/0/url' : '/data/categoryNodes/0/url') } }),
    ]);
}

export const definitions = [
  definition('retail-aliexpress', 'AliExpress public retail', ['aliexpress'], ['retail-aliexpress-public'], {
    'product-seo': read(`${source('aliexpress')}#createAliExpressPublicClient.getProductSeo; scripts/retail.mjs`, {
      path: { productId: string(true) }, query: { subject: string() } },
    ({ path: p, query: q = {} }, options) => createAliExpressPublicClient(options).getProductSeo({ productId: p.productId, subject: q.subject }),
    'Observed SEO metadata only; missing title/price/currency remain unknown.'),
    ...sitemapOperations('aliexpress'),
  }, check('sitemap-index')),
  definition('retail-amazon', 'Amazon public retail', ['amazon'], ['retail-amazon-public'], {
    search: read(`${source('amazon')}#createAmazonPublicClient.searchProducts; scripts/retail.mjs`, {
      query: { ...queryInput, page: integer(1, 20, 1) } },
    ({ query: q }, options) => createAmazonPublicClient(options).searchProducts(q), 'Anonymous streaming XHR read; retains partial main-card coverage and observed pagination.'),
    navigation: read(`${source('amazon-navigation')}#createAmazonNavigationClient.getNavigation; scripts/retail.mjs`, {},
      (_input, options) => createAmazonNavigationClient(options).getNavigation(), 'Two observed anonymous menu reads, not a complete catalog.'),
    crawl: read(`${source('amazon-crawl')}#crawlAmazonSearch; scripts/retail.mjs`, {
      query: { ...queryInput, maxPages: integer(1, 5, 1) }, body: { checkpoint: json } },
    async ({ query: q, body: b = {} }, options) => {
      const result = await crawlAmazonSearch({ query: q.query, maxPages: q.maxPages ?? 1,
        checkpoint: b.checkpoint ?? null, client: createAmazonPublicClient(options) });
      if (result.failure) throw Object.assign(new Error(result.failure.code), { code: result.failure.code,
        partialResult: result, receipt: { pagesRead: result.pagesRead,
          ...(result.failure.status === undefined ? {} : { httpStatus: result.failure.status }) } });
      return result;
    }),
    product: read(`${source('amazon-retail-session')}#getAmazonProduct; scripts/retail.mjs`, { path: { asin: string(true) } },
      async ({ path: p }, options) => {
        if (!/^[A-Z0-9]{10}$/.test(p.asin)) fail('AMAZON_PRODUCT_INPUT_INVALID');
        const { getAmazonProduct, AMAZON_RETAIL_STORE } = await import('../retail/amazon-retail-session.mjs');
        const store = await sessionStore(options, AMAZON_RETAIL_STORE, 'amazon-retail-public-session-v1');
        return getAmazonProduct({ asin: p.asin, store, fetchImpl: options.fetchImpl });
      }, 'Read using an existing protected retail session; local same-origin state rotations only. Never login or bootstrap.'),
  }, [
    ...check('search', { query: { query: 'wireless mouse', page: 1 } }),
    ...check('product', { path: { asin: fromResult('search', '/items/0/asin') } }),
  ]),
  definition('retail-ebay', 'eBay public catalog hints', ['ebay'], ['retail-ebay-public'], {
    suggest: read(`${source('ebay')}#createEbayPublicClient.suggestCatalogHints; scripts/retail.mjs`, { query: queryInput },
      ({ query: q }, options) => createEbayPublicClient(options).suggestCatalogHints(q), 'Public keyword/category hints, not Browse API item search.'),
  }, check('suggest', { query: { query: 'wireless mouse' } })),
  definition('retail-walmart', 'Walmart public search', ['walmart'], ['retail-walmart-public'], {
    search: read(`${source('walmart')}#createWalmartPublicClient.searchProducts; scripts/retail.mjs`, { query: queryInput },
      ({ query: q }, options) => createWalmartPublicClient(options).searchProducts(q)),
  }, check('search', { query: { query: 'wireless mouse' } })),
  definition('retail-shopify', 'Allbirds public Shopify storefront (not arbitrary stores)', ['shopify'], ['retail-allbirds-public'], {
    product: read(`${source('shopify')}#createAllbirdsPublicClient.getProduct; scripts/retail.mjs`, { path: { handle: string(true) } },
      ({ path: p }, options) => createAllbirdsPublicClient(options).getProduct(p)),
    'predictive-search': read(`${source('shopify')}#createAllbirdsPublicClient.searchProducts; scripts/retail.mjs`, {
      query: { ...queryInput, limit: integer(1, 10, 1) } },
    ({ query: q }, options) => createAllbirdsPublicClient(options).searchProducts(q), 'Two cookie-free GETs: suggest and cart.js currency metadata; no cart mutation or cart contents.'),
  }, check('predictive-search', { query: { query: 'runner', limit: 1 } })),
  definition('retail-iherb', 'iHerb public product identities', ['iherb'], ['retail-iherb-public'],
    sitemapOperations('iherb'), check('sitemap-index')),
  definition('retail-shein', 'SHEIN Korean public home catalog', ['shein'], ['retail-shein-public'], {
    home: read(`${source('shein')}#createSheinPublicClient.getHomeCatalog; scripts/overseas-retail.mjs`, {},
      (_input, options) => createSheinPublicClient(options).getHomeCatalog()),
  }, check('home')),
  definition('coupang-retail', 'Coupang public retail and travel reads', ['coupang-retail'], ['retail-coupang-public'], {
    categories: read(`${source('coupang-public')}#readCoupangCategories; scripts/coupang-public.mjs`, {},
      (_input, options) => coupang.readCoupangCategories(options)),
    document: read(`${source('coupang-public')}#readCoupangDocument; scripts/coupang-public.mjs`, urlInput,
      ({ path: p }, options) => coupang.readCoupangDocument(p.url, { ...options, authentication: 'anonymous' })),
    'retail-search': read(`${source('coupang-public')}#readCoupangRetailSearch; scripts/coupang-public.mjs`, {
      query: { ...queryInput, page: integer(1, 1000, 1), sorter: { type: 'string', enum: ['salePriceAsc'] },
        freeDelivery: { type: 'boolean', default: false } } },
    ({ query: q }, options) => coupang.readCoupangRetailSearch(q.query, { ...options, ...q, authentication: 'anonymous' }),
    'Anonymous received-HTML cards only; no automatic visitor bootstrap, challenges, or fallback.'),
    'retail-search-session': read(`${source('coupang-retail-session')}#searchCoupangRetail`, { query: queryInput },
      async ({ query: q }, options) => {
        const { searchCoupangRetail, COUPANG_RETAIL_STORE } = await import('../retail/coupang-retail-session.mjs');
        const store = await sessionStore(options, COUPANG_RETAIL_STORE, 'coupang-retail-public-session-v1');
        const result = await searchCoupangRetail(q.query, { store, fetchImpl: options.fetchImpl });
        if (!result.ok) throw Object.assign(new Error(result.code), { code: result.code, receipt: result.receipt });
        return result;
      }, 'Existing protected RSC session only; native local renewal/rotation, no new visitor/login bootstrap.'),
    autocomplete: read(`${source('coupang-public')}#readCoupangTravelAutocomplete; scripts/coupang-public.mjs`, { query: queryInput },
      ({ query: q }, options) => coupang.readCoupangTravelAutocomplete(q.query, options), 'Observed travel autocomplete read POST.'),
    search: read(`${source('coupang-public')}#readCoupangTravelSearch; scripts/coupang-public.mjs`, {
      body: { template: { type: 'json', required: true } }, query: { page: integer(1, 10000),
        sort: { type: 'string', enum: ['COUPANG_RATING', 'LOWEST_PRICE', 'HIGHEST_PRICE'] },
        resultsOnly: { type: 'boolean', default: false } } },
    ({ body: b, query: q = {} }, options) => coupang.readCoupangTravelSearch(b.template, { ...options, ...q }),
    'Observed travel read POST; caller supplies the maintained module\'s observed template, never guessed runtime inputs.'),
    rooms: read(`${source('coupang-public')}#readCoupangTravelRooms; scripts/coupang-public.mjs`, {
      body: { observed: { type: 'json', required: true } } },
    ({ body: b }, options) => coupang.readCoupangTravelRooms(b.observed, options)),
    'ticket-options': read(`${source('coupang-public')}#readCoupangTravelTicketOptions; scripts/coupang-public.mjs`, {
      body: { observed: { type: 'json', required: true } } },
    ({ body: b }, options) => coupang.readCoupangTravelTicketOptions(b.observed, options)),
    reviews: read(`${source('coupang-public')}#readCoupangTravelReviews; scripts/coupang-public.mjs`, {
      path: { productId: string(true) }, query: { page: integer(0, 10000, 0),
        sort: { type: 'string', enum: ['DATE_DESC', 'ORDER_SCORE_ASC'], default: 'DATE_DESC' } } },
    ({ path: p, query: q = {} }, options) => coupang.readCoupangTravelReviews(p.productId, { ...options, ...q })),
  }, [
    // Prioritize the user's retail SEARCH concern over category inventory.
    // Anonymous mode is pinned by the adapter; no visitor/login fallback runs.
    ...check('retail-search', { query: { query: '무선 마우스', page: 1 } }),
    ...check('categories'),
    // No retail product-detail check: the maintained Document parser has a
    // travel-detail contract, but no general /vp/products retail-detail one.
  ]),
  japanDefinition('rakuten'),
  japanDefinition('yahoo'),
];
