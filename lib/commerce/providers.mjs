const fail = code => { throw Object.assign(new Error(code), { code }); };
export const COMMERCE_PROVIDERS = Object.freeze({
  'printful-feed': { service: 'printful', operations: ['search', 'product', 'collect'], credentials: [], readiness: 'verified_public_feed', coverage: 'regional_feed' },
  'shopify-storefronts': { service: 'shopify-storefronts', operations: ['search', 'product', 'collect'], credentials: [], readiness: 'verified_public_storefronts', stores: ['allbirds', 'colourpop'] },
  'aliexpress-partner': { service: 'aliexpress-partner', operations: ['search', 'product', 'collect'], credentials: ['appKey', 'appSecret', 'trackingId', 'appSignature'], readiness: 'credentialed_live_pending' },
  'aliexpress-social': { service: 'aliexpress-partner', operations: ['search', 'collect'], credentials: ['appKey', 'appSecret'], readiness: 'credentialed_live_pending' },
  'ebay-partner': { service: 'ebay-partner', operations: ['search', 'product', 'collect'], credentials: ['accessToken', 'clientId', 'clientSecret', 'affiliateCampaignId', 'affiliateReferenceId'], readiness: 'credentialed_live_pending' },
  'amazon-partner': { service: 'amazon-partner', operations: ['search', 'product', 'collect'], credentials: ['credentialId', 'credentialSecret', 'credentialVersion', 'partnerTag'], readiness: 'credentialed_live_pending' },
  cjdropshipping: { service: 'cjdropshipping', operations: ['search', 'product', 'collect'], credentials: ['accessToken'], readiness: 'credentialed_live_pending' },
  banggood: { service: 'banggood', operations: ['search', 'product', 'collect'], credentials: ['apiKey', 'apiSecret'], readiness: 'credentialed_live_pending' },
  awin: { service: 'awin', operations: ['search', 'product', 'collect'], credentials: ['publisherId', 'accessToken'], readiness: 'feed_row_envelope_unconfirmed' },
  impact: { service: 'impact', operations: ['search', 'product', 'collect'], credentials: ['accountSid', 'authToken'], readiness: 'credentialed_live_pending' },
  'printful-api': { service: 'printful', operations: ['product', 'collect'], credentials: ['accessToken'], readiness: 'credentialed_live_pending' },
});

const stringId = value => value == null ? null : String(value);
const title = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value;
const available = value => value === true ? 'available' : value === false ? 'unavailable' : 'unknown';
const money = (value, kind) => value && { amount: value.amount, currency: value.currency, kind };
const requestReceipts = value => [value?.receipt?.request ?? value?.receipt, value?.receipt?.currencyRequest].filter(Boolean);
const page = (offers, result, coverage, nextCursor = null) => ({ offers, coverage, nextCursor, receipts: requestReceipts(result) });
const MAX_IDS = new Set(['query', 'id', 'store', 'region', 'currency', 'marketplace', 'categoryId', 'country', 'language',
  'locale', 'advertiserId', 'catalogId', 'pageSize', 'productionCurrency']);

function credentialOptions(provider, credentials) {
  const allowed = COMMERCE_PROVIDERS[provider].credentials;
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials) ||
      Object.keys(credentials).some(key => !allowed.includes(key))) fail('COMMERCE_CREDENTIAL_FIELDS_INVALID');
  if (allowed.length && Object.keys(credentials).length === 0) fail('COMMERCE_CREDENTIALS_REQUIRED');
  return { ...credentials };
}

/** Factory injection is for fixture tests; CLI uses these pinned production modules. */
export async function createCommerceReader({ provider, args = {}, credentials = {}, factories = {}, now = Date.now } = {}) {
  const definition = COMMERCE_PROVIDERS[provider];
  if (!definition || !args || typeof args !== 'object' || Array.isArray(args) ||
      Object.keys(args).some(key => !MAX_IDS.has(key)) || typeof now !== 'function') fail('COMMERCE_JOB_INVALID');
  if (provider === 'cjdropshipping' && args.id && args.country) fail('COMMERCE_DESTINATION_UNSUPPORTED_FOR_DETAIL');
  const cred = credentialOptions(provider, credentials);
  const time = () => new Date(now()).toISOString();
  let client;
  if (factories[provider]) client = await factories[provider]({ ...cred, ...args });
  else if (provider === 'printful-feed' || provider === 'printful-api') {
    client = (await import('./printful.mjs')).createPrintfulCatalogClient({ ...cred });
  } else if (provider === 'shopify-storefronts') {
    client = (await import('./shopify-storefronts.mjs')).createShopifyStorefrontClient({ store: args.store ?? 'allbirds' });
  } else if (provider.startsWith('aliexpress-')) {
    client = (await import('./aliexpress-affiliate.mjs')).createAliExpressAffiliateClient(cred);
  } else if (provider === 'ebay-partner') {
    const mod = await import('./ebay-browse.mjs');
    if (!cred.accessToken) cred.accessToken = (await mod.acquireEbayAppToken({ clientId: cred.clientId, clientSecret: cred.clientSecret })).accessToken;
    client = mod.createEbayBrowseClient({ accessToken: cred.accessToken, marketplaceId: args.marketplace ?? 'EBAY_US',
      affiliateCampaignId: cred.affiliateCampaignId, affiliateReferenceId: cred.affiliateReferenceId });
  } else if (provider === 'amazon-partner') client = (await import('./amazon-creators.mjs')).createAmazonCreatorsClient({ ...cred, marketplace: args.marketplace ?? 'www.amazon.com' });
  else if (provider === 'cjdropshipping') client = (await import('./cjdropshipping.mjs')).createCjDropshippingClient(cred);
  else if (provider === 'banggood') client = (await import('./banggood.mjs')).createBanggoodClient(cred);
  else if (provider === 'awin') client = (await import('./awin.mjs')).createAwinPublisherFeedClient(cred);
  else if (provider === 'impact') client = (await import('./impact.mjs')).createImpactPartnerCatalogClient(cred);

  let feed;
  const base = (productId, variantId, name, url, price, context = {}) => ({ productId: stringId(productId),
    variantId: stringId(variantId), title: title(name), url, price, context, observedAt: time(),
    source: `${definition.service}_documented_response` });
  function storefrontOffers(product) {
    if (Array.isArray(product.variants)) return product.variants.map(v => ({
      ...base(product.id, v.id, `${product.title} / ${v.title}`, product.canonicalUrl, money(v.price, 'retail_current'), { store: args.store ?? 'allbirds' }),
      availability: available(v.available) }));
    return [{ ...base(product.id, null, product.title, product.canonicalUrl, money(product.price, 'retail_current'), { store: args.store ?? 'allbirds' }), availability: available(product.available) }];
  }
  function cjOffer(product) {
    const price = product.price ?? product.prices?.sellPrice;
    if (!price?.raw) fail('COMMERCE_PRICE_NOT_AVAILABLE');
    const parts = price.raw.split('-');
    const out = base(product.productId, null, product.title, null,
      parts.length === 1 ? { amount: parts[0], currency: price.currency, kind: 'supplier_catalog' } : null);
    if (parts.length === 2) out.priceRange = { min: { amount: parts[0], currency: price.currency, kind: 'supplier_catalog' },
      max: { amount: parts[1], currency: price.currency, kind: 'supplier_catalog' } };
    return out;
  }
  function networkOffer(item) {
    if (!item.price?.amount || !item.price.currency) fail('COMMERCE_PRICE_NOT_AVAILABLE');
    return { ...base(item.productId, item.variantId, item.title, item.url, item.price,
      provider === 'awin' ? { advertiserId: String(args.advertiserId), locale: args.locale } :
        item.source?.catalogId ? { catalogId: String(item.source.catalogId) } : {}), availability: item.availability ?? 'unknown' };
  }

  return async function loadPage({ cursor, remaining } = {}) {
    const requestedSize = args.pageSize ?? 20;
    if (!Number.isInteger(requestedSize) || requestedSize < 1 || requestedSize > 100) fail('COMMERCE_PAGE_SIZE_INVALID');
    const size = requestedSize;
    if (provider === 'printful-feed') {
      if (!feed) {
        if (args.region === 'all') {
          feed = await client.getPublicCatalogFeeds();
          feed = { ...feed, products: feed.feeds.flatMap(region => region.products.map(product => ({ ...product, region: region.region }))) };
        } else feed = await client.getPublicCatalogFeed({ region: args.region ?? 'USA' });
      }
      const selected = feed.products.filter(item => (args.id ? String(item.variantId) === args.id : true) &&
        (args.query ? `${item.title} ${item.type} ${item.categories}`.toLowerCase().includes(args.query.toLowerCase()) : true));
      const priced = selected.filter(item => typeof item.productPrice.amount === 'string');
      return { ...page(priced.map(item => base(null, item.variantId, `${item.title} / ${item.color} / ${item.size}`, null,
        { ...item.productPrice, kind: 'regional_catalog_base' }, { region: item.region ?? feed.region })), feed, 'regional_feed'),
        priceUnavailableCount: selected.length - priced.length };
    }
    if (provider === 'shopify-storefronts') {
      const result = args.id ? await client.getProduct({ handle: args.id }) : await client.searchProducts({ query: args.query, limit: Math.min(10, size, remaining) });
      return page((result.product ? [result.product] : result.products).flatMap(storefrontOffers), result,
        args.id ? 'product_detail' : 'predictive_sample');
    }
    if (provider === 'aliexpress-partner' || provider === 'aliexpress-social') {
      const currentPage = cursor ?? 1;
      const result = args.id ? await client.getProduct({ productId: args.id, currency: args.currency ?? 'USD', country: args.country ?? 'US', language: args.language ?? 'EN' })
        : provider === 'aliexpress-social' ? await client.searchSocialProducts({ keyword: args.query, page: currentPage, limit: Math.min(50,size), shipTo: args.country ?? 'US' })
          : await client.searchProducts({ query: args.query, page: currentPage, limit: Math.min(50,size), currency: args.currency ?? 'USD', shipToCountry: args.country ?? 'US', language: args.language ?? 'EN',
            ...(args.categoryId ? { categoryIds: [args.categoryId] } : {}) });
      const products = result.product ? [result.product] : result.products;
      const offers = products.map(p => {
        const out = base(p.productId, null, p.title, p.url, money(p.targetSalePrice ?? p.salePrice, 'retail_current'), { country: args.country ?? 'US' });
        if (p.salePriceRange) out.priceRange = { min: money(p.salePriceRange.min, 'retail_current'), max: money(p.salePriceRange.max, 'retail_current') };
        return out;
      });
      const more = !args.id && (provider === 'aliexpress-social' ? result.page * result.pageSize < result.totalCount : result.page < result.pageCount);
      return page(offers, result, args.id ? 'product_detail' : 'paged_result', more ? currentPage + 1 : null);
    }
    if (provider === 'ebay-partner') {
      const result = args.id ? await client.getItem({ itemId: args.id }) : await client.searchItems({ query: args.query, offset: cursor ?? 0, limit: size, categoryId: args.categoryId });
      const items = result.item ? [result.item] : result.items;
      return page(items.map(item => base(item.itemId, null, item.title, item.itemWebUrl, item.price, { marketplace: result.marketplaceId })), result,
        args.id ? 'product_detail' : result.pagination.total > 10000 ? 'provider_limited' : 'paged_result', result.pagination?.nextOffset ?? null);
    }
    if (provider === 'cjdropshipping') {
      const result = args.id ? await client.getProductDetail({ productId: args.id })
        : await client.searchProducts({ keyword: args.query, page: cursor ?? 1, size, countryCode: args.country, categoryId: args.categoryId });
      const next = result.pagination && result.pagination.page < result.pagination.totalPages ? result.pagination.page + 1 : null;
      const products = result.product?.variants?.length ? result.product.variants.map(variant => ({ ...variant,
        title: `${result.product.title} / ${variant.title ?? variant.sku ?? variant.variantId}` }))
        : result.product ? [result.product] : result.products;
      const priced = products.filter(product => product.price?.raw || product.prices?.sellPrice?.raw);
      return { ...page(priced.map(product => ({ ...cjOffer(product), variantId: stringId(product.variantId),
        ...(args.country ? { context: { country: args.country } } : {}) })), result,
        args.id ? 'product_detail' : result.pagination.totalRecords >= 6000 ? 'provider_limited' : 'paged_result', next),
        priceUnavailableCount: products.length - priced.length };
    }
    if (provider === 'banggood') {
      const result = args.id ? await client.getProduct({ productId: args.id, currency: args.currency ?? 'USD' })
        : await client.listProducts({ keyword: args.query, currency: args.currency ?? 'USD', categoryId: args.categoryId });
      const offers = args.id ? result.warehouses.flatMap(w => [
        { ...base(result.productId, null, result.name, result.productUrl, money(w.warehousePrice, 'supplier_catalog'), { warehouse: w.warehouse }), source: 'banggood.warehouse_price' },
        ...(w.marketPrice ? [{ ...base(result.productId, null, result.name, result.productUrl, money(w.marketPrice, 'market_reference'), { warehouse: w.warehouse }), source: 'banggood.market_price' }] : []),
      ]) : result.products.map(p => base(p.productId, null, p.name, p.productUrl, money(p.price, 'retail_current')));
      return page(offers, result, args.id ? 'product_detail' : 'provider_limited');
    }
    if (provider === 'awin' || provider === 'impact') {
      const common = provider === 'awin' ? { advertiserId: args.advertiserId, locale: args.locale } : { catalogId: args.catalogId };
      const result = args.id ? await client.getProduct({ ...common, productId: args.id })
        : await client.searchProducts({ ...common, keyword: args.query, page: cursor ?? 1, pageSize: size });
      if (args.id && !result.item) fail('COMMERCE_PRODUCT_NOT_FOUND');
      const next = !args.id && [true, 'possible'].includes(result.page.hasMore) ? result.page.page + 1 : null;
      const items = result.item ? [result.item] : result.items;
      const priced = items.filter(item => typeof item.price?.amount === 'string' && item.price.currency);
      return { ...page(priced.map(networkOffer), result,
        args.id ? 'product_detail' : provider === 'awin' ? 'regional_feed' : 'provider_limited', next), priceUnavailableCount: items.length - priced.length };
    }
    if (provider === 'printful-api') {
      if (!args.id || !/^\d{1,9}$/.test(args.id)) fail('COMMERCE_PRODUCT_ID_REQUIRED');
      const product = await client.getProduct({ productId: Number(args.id) });
      const result = await client.getProductPrices({ productId: Number(args.id), limit: size, offset: cursor ?? 0, currency: args.currency ?? 'USD',
        sellingRegionName: args.region ?? 'worldwide', productionCurrency: args.productionCurrency ?? 'USD' });
      const offers = result.prices.variants.flatMap(v => v.techniques.map(t => base(args.id, v.variantId,
        `${product.product?.title ?? args.id} / ${t.technique}`, null, money(t.price, 'supplier_base'),
        { technique: t.technique, region: args.region ?? 'worldwide', productionCurrency: args.productionCurrency ?? 'USD' })));
      const paging = result.pagination;
      const next = paging.offset + paging.limit < paging.total ? paging.offset + paging.limit : null;
      return page(offers, result, 'paged_result', next);
    }
    if (provider === 'amazon-partner') {
      const currentPage = cursor ?? 1;
      const result = args.id ? await client.getItems({ itemIds: [args.id], currencyOfPreference: args.currency })
        : await client.searchItems({ keywords: args.query, itemCount: Math.min(10,size), itemPage: currentPage, currencyOfPreference: args.currency });
      const priced = result.items.filter(item => item.offers.some(offer => offer.currentPrice));
      const offers = priced.map(item => base(item.asin, null, item.title, item.url,
        money(item.offers.find(offer => offer.currentPrice).currentPrice, 'retail_current'), { marketplace: args.marketplace ?? 'www.amazon.com' }));
      const next = !args.id && currentPage < 10 && result.items.length > 0 &&
        (result.totalResultCount === null || currentPage * Math.min(10,size) < result.totalResultCount) ? currentPage + 1 : null;
      return { ...page(offers, result, 'provider_limited', next), priceUnavailableCount: result.items.length - priced.length, partial: result.partial === true };
    }
    fail('COMMERCE_PROVIDER_UNSUPPORTED');
  };
}
