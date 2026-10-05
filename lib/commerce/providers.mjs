const fail = code => { throw Object.assign(new Error(code), { code }); };
export const COMMERCE_PROVIDERS = Object.freeze({
  'printful-feed': { service: 'printful', operations: ['search', 'product', 'collect'], credentials: [], readiness: 'verified_public_feed', coverage: 'regional_feed' },
  'shopify-storefronts': { service: 'shopify-storefronts', operations: ['search', 'product', 'collect'], credentials: [], readiness: 'verified_public_storefronts', stores: ['allbirds', 'colourpop'] },
  'aliexpress-partner': { service: 'aliexpress-partner', operations: ['search', 'product', 'collect'], credentials: ['appKey', 'appSecret', 'trackingId', 'appSignature'], readiness: 'credentialed_live_pending' },
  'aliexpress-social': { service: 'aliexpress-partner', operations: ['search', 'collect'], credentials: ['appKey', 'appSecret'], readiness: 'credentialed_live_pending' },
  'ebay-partner': { service: 'ebay-partner', operations: ['search', 'product', 'collect'], credentials: ['accessToken', 'clientId', 'clientSecret', 'affiliateCampaignId', 'affiliateReferenceId'], readiness: 'credentialed_live_pending' },
  'amazon-partner': { service: 'amazon-partner', operations: ['search', 'product', 'collect'], credentials: ['credentialId', 'credentialSecret', 'credentialVersion', 'partnerTag'], readiness: 'credentialed_live_pending' },
  'amazon-public': { service: 'amazon', operations: ['search', 'collect'], credentials: [], readiness: 'verified_public_xhr', coverage: 'provider_limited', market: 'US' },
  cjdropshipping: { service: 'cjdropshipping', operations: ['search', 'product', 'collect'], credentials: ['accessToken'], readiness: 'credentialed_live_pending' },
  banggood: { service: 'banggood', operations: ['search', 'product', 'collect'], credentials: ['apiKey', 'apiSecret'], readiness: 'credentialed_live_pending' },
  awin: { service: 'awin', operations: ['search', 'product', 'collect'], credentials: ['publisherId', 'accessToken'], readiness: 'feed_row_envelope_unconfirmed' },
  impact: { service: 'impact', operations: ['search', 'product', 'collect'], credentials: ['accountSid', 'authToken'], readiness: 'credentialed_live_pending' },
  'printful-api': { service: 'printful', operations: ['product', 'collect'], credentials: ['accessToken'], readiness: 'credentialed_live_pending' },
  oliveyoung: { service: 'oliveyoung', operations: ['search', 'collect'], credentials: ['session'], readiness: 'session_and_live_contract_pending' },
  'oliveyoung-public': { service: 'oliveyoung-public', operations: ['search', 'collect'], credentials: ['session'], credentialsOptional: true, readiness: 'captured_http_replay_blocked', market: 'KR' },
  'oliveyoung-global': { service: 'oliveyoung-global', operations: ['product', 'collect', 'best-sellers', 'category'], credentials: [], readiness: 'verified_public_xhr', market: 'global_USD_KR', coverage: 'category_bestseller_or_product' },
  'shopee-id': { service: 'shopee-affiliate-id', operations: ['search', 'product', 'collect'], credentials: ['appId', 'appSecret'], readiness: 'credentialed_live_pending', market: 'ID' },
  'rakuten-ichiba': { service: 'rakuten-ichiba', operations: ['search', 'product', 'collect'], credentials: ['applicationId', 'accessKey', 'affiliateId'], readiness: 'credentialed_live_pending', market: 'JP' },
  'rakuten-advertising': { service: 'rakuten-advertising', operations: ['search', 'collect'], credentials: ['accessToken'], readiness: 'credentialed_live_pending' },
  'sephora-affiliate': { service: 'sephora', operations: ['search', 'collect'], credentials: ['accessToken'], readiness: 'merchant_identity_and_live_pending', network: 'rakuten-advertising' },
  'ulta-affiliate': { service: 'ulta', operations: ['search', 'product', 'collect'], credentials: ['accountSid', 'authToken'], readiness: 'catalog_identity_and_live_pending', network: 'impact' },
  sephora: { service: 'sephora', operations: ['search', 'collect'], credentials: [], readiness: 'verified_public_xhr', market: 'US' },
  ulta: { service: 'ulta', operations: ['search', 'collect'], credentials: [], readiness: 'verified_public_xhr', market: 'US' },
});

const stringId = value => value == null ? null : String(value);
const title = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value;
const available = value => value === true ? 'available' : value === false ? 'unavailable' : 'unknown';
const money = (value, kind) => value && { amount: value.amount, currency: value.currency, kind };
const requestReceipts = value => [value?.receipt?.request ?? value?.receipt ?? value?.request,
  value?.receipt?.currencyRequest, ...(value?.receipts ?? []).map(receipt => receipt?.request ?? receipt)].filter(Boolean);
const page = (offers, result, coverage, nextCursor = null) => ({ offers, coverage, nextCursor, receipts: requestReceipts(result) });
const MAX_IDS = new Set(['query', 'id', 'store', 'region', 'currency', 'marketplace', 'categoryId', 'country', 'language',
  'locale', 'advertiserId', 'catalogId', 'pageSize', 'productionCurrency', 'shopCode', 'genreId', 'merchantId']);

function credentialOptions(provider, credentials) {
  const allowed = COMMERCE_PROVIDERS[provider].credentials;
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials) ||
      Object.keys(credentials).some(key => !allowed.includes(key))) fail('COMMERCE_CREDENTIAL_FIELDS_INVALID');
  if (allowed.length && Object.keys(credentials).length === 0 && COMMERCE_PROVIDERS[provider].credentialsOptional !== true) fail('COMMERCE_CREDENTIALS_REQUIRED');
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
  else if (provider === 'amazon-public') client = (await import('../retail/amazon.mjs')).createAmazonPublicClient();
  else if (provider === 'cjdropshipping') client = (await import('./cjdropshipping.mjs')).createCjDropshippingClient(cred);
  else if (provider === 'banggood') client = (await import('./banggood.mjs')).createBanggoodClient(cred);
  else if (provider === 'awin') client = (await import('./awin.mjs')).createAwinPublisherFeedClient(cred);
  else if (provider === 'impact') client = (await import('./impact.mjs')).createImpactPartnerCatalogClient(cred);
  else if (provider === 'oliveyoung') client = (await import('./oliveyoung.mjs')).createOliveyoungCommerceClient(cred);
  else if (provider === 'oliveyoung-global') client = (await import('./oliveyoung-global.mjs')).createOliveyoungGlobalClient();
  else if (provider === 'oliveyoung-public') client = (await import('./oliveyoung-korea-public.mjs')).createOliveyoungKoreaPublicClient(cred);
  else if (provider === 'shopee-id') client = (await import('./shopee-affiliate.mjs')).createShopeeAffiliateClient(cred);
  else if (provider === 'rakuten-ichiba') client = (await import('./rakuten-ichiba.mjs')).createRakutenIchibaClient(cred);
  else if (provider === 'rakuten-advertising' || provider === 'sephora-affiliate') {
    if (provider === 'sephora-affiliate') client = (await import('./brand-affiliates.mjs')).createSephoraRakutenClient({ ...cred, advertiserMid: args.merchantId });
    else client = (await import('./rakuten-advertising.mjs')).createRakutenAdvertisingProductSearchClient(cred);
  } else if (provider === 'ulta-affiliate') client = (await import('./brand-affiliates.mjs')).createUltaImpactCatalogClient({ ...cred, catalogId: args.catalogId });
  else if (provider === 'sephora') client = (await import('./sephora.mjs')).createSephoraPublicClient();
  else if (provider === 'ulta') client = (await import('./ulta.mjs')).createUltaPublicClient();

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
    if (provider === 'oliveyoung-public') {
      const result = await client.searchProducts({ query: args.query, page: cursor ?? 1, pageSize: size });
      const offers = result.products.map(product => ({ ...base(product.productId, null, product.title,
        `https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=${encodeURIComponent(product.productId)}`,
        money(product.price, 'retail_current'), { country: 'KR', priceBasis: product.priceContext?.optionRangeHint ? 'displayed_starting_price' : 'displayed_search_price' }),
        availability: product.availability }));
      return page(offers, result, 'provider_limited', result.pagination?.nextPage ?? null);
    }
    if (provider === 'oliveyoung-global') {
      if (args.query !== undefined || args.pageSize !== undefined && !args.categoryId || args.id && args.categoryId) fail('OLIVEYOUNG_GLOBAL_BESTSELLER_SCOPE_INVALID');
      const result = args.id ? await client.getProduct({ id: args.id, country: args.country, currency: args.currency })
        : args.categoryId ? await client.getCategoryProducts({ categoryId: args.categoryId, page: cursor ?? 1, pageSize: args.pageSize ?? 24,
          country: args.country, currency: args.currency }) : await client.getBestSellers({ country: args.country, currency: args.currency });
      const products = result.product ? [result.product] : result.products;
      if (products.length && result.marketContext?.currencyVerified !== true && result.product?.marketContext?.currencyVerified !== true) {
        fail('OLIVEYOUNG_GLOBAL_CURRENCY_CONTEXT_UNVERIFIED');
      }
      const offers = products.flatMap(product => {
        const context = { country: 'KR', priceBasis: args.id ? 'product_display_default' : args.categoryId ? 'category_product' : 'homepage_best_seller' };
        const emit = (variantId, label, quote, kind, basis) => ({ ...base(product.id, variantId, label,
          product.url, money(quote, kind), { ...context, priceBasis: basis }), availability: 'unknown' });
        const quotes = [];
        for (const [quote, range, kind] of [[product.price, product.priceRange?.sale, 'retail_current'],
          [product.listPrice, product.priceRange?.list, 'retail_list']]) {
          if (quote) quotes.push(emit(null, product.name, quote, kind, context.priceBasis));
          else if (range?.min && range?.max) quotes.push({ ...emit(null, product.name, null, kind, context.priceBasis),
            priceRange: { min: money(range.min, kind), max: money(range.max, kind) } });
        }
        if (args.id) for (const option of product.options ?? []) {
          if (!option.variantId || !option.price) continue;
          quotes.push(emit(option.variantId, `${product.name} / ${option.name ?? option.variantId}`,
            option.price, 'retail_current', 'option_price'));
          if (option.listPrice) quotes.push(emit(option.variantId, `${product.name} / ${option.name ?? option.variantId}`,
            option.listPrice, 'retail_list', 'option_price'));
        }
        return quotes;
      });
      return page(offers, result, args.id ? 'product_detail' : args.categoryId ? 'paged_result' : 'provider_limited', result.pagination?.nextPage ?? null);
    }
    if (provider === 'amazon-public') {
      const result = await client.searchProducts({ query: args.query, page: cursor ?? 1 });
      const priced = result.items.filter(item => typeof item.currentDisplayPrice?.amount === 'string');
      const offers = priced.map(item => ({ ...base(item.asin, null, item.title, item.productUrl,
        { amount: item.currentDisplayPrice.amount, currency: item.currentDisplayPrice.currencyCode ?? null,
          kind: 'retail_current', display: item.currentDisplayPrice.displayText },
        { marketplace: 'www.amazon.com', priceBasis: 'displayed_search_card' }), source: 'amazon.observed_search_card_xhr' }));
      return { ...page(offers, result, 'provider_limited', result.page < 20 ? result.page + 1 : null),
        priceUnavailableCount: result.items.length - priced.length, partial: result.partial === true };
    }
    if (provider === 'ulta') {
      // The API's actual page is 64 plus sponsored cards. Its pageSize argument
      // is only a local cap; collect every returned card before advancing.
      const result=await client.searchProducts({query:args.query,page:cursor??1,pageSize:100});
      const priced=result.products.filter(item=>item.price||item.priceRange);
      const offers=priced.map(item=>{
        const quoteKind=item.salePrice?'retail_current':'retail_list';
        const out=base(item.productId,item.priceRange?null:item.variantId,`${item.brandName} / ${item.productName}`,item.productUrl,
          money(item.price,quoteKind),{country:'US',priceBasis:item.priceRange?'product_range':'current_sku'});
        if(item.priceRange)out.priceRange={min:money(item.priceRange.min,quoteKind),max:money(item.priceRange.max,quoteKind)};
        return out;
      });
      const next=result.page<result.pageCount?result.page+1:null;
      return {...page(offers,result,'provider_limited',next),priceUnavailableCount:result.products.length-priced.length};
    }
    if (provider === 'sephora') {
      const result=await client.searchProducts({query:args.query,page:cursor??1,pageSize:Math.min(size,60),countryCode:'US'});
      const offers=result.products.map(item=>{
        const out=base(item.productId,item.priceScope==='product_range'?null:item.variantId,
          `${item.brandName} / ${item.productName}`,item.productUrl,money(item.price,'retail_list'),
          {country:'US',priceBasis:item.priceScope});
        if(item.priceRange)out.priceRange={min:money(item.priceRange.min,'retail_list'),max:money(item.priceRange.max,'retail_list')};
        return out;
      });
      const next=result.page*result.pageSize<result.totalProducts?result.page+1:null;
      return page(offers,result,'paged_result',next);
    }
    if (provider === 'oliveyoung') {
      const result = await client.searchProducts({ keyword: args.query, pageNumber: 0, pageSize: size });
      return page(result.products.map(item => ({ ...base(item.productId, null, item.title, item.url, item.price, { country: 'KR' }),
        availability: item.availability })), result, 'provider_limited');
    }
    if (provider === 'shopee-id') {
      const result = args.id ? await client.getProductById({ itemId: args.id })
        : await client.searchProducts({ keyword: args.query, page: cursor ?? 1, limit: size });
      const offers = result.products.map(item => {
        const out = base(item.productId ?? item.itemId, null, item.title ?? item.productName, item.url ?? null,
          money(item.price, 'retail_current'), { country: 'ID' });
        if (typeof item.priceRange?.min === 'string' && typeof item.priceRange?.max === 'string') out.priceRange = {
          min: { amount:item.priceRange.min,currency:null,kind:'retail_current' }, max: { amount:item.priceRange.max,currency:null,kind:'retail_current' } };
        return out;
      });
      return page(offers, result, args.id ? 'product_detail' : 'paged_result', !args.id && result.pageInfo.hasNextPage ? (result.pageInfo.page ?? cursor ?? 1) + 1 : null);
    }
    if (provider === 'rakuten-ichiba') {
      const result = args.id ? await client.getItem({ itemCode: args.id }) : await client.searchItems({ keyword: args.query,
        shopCode: args.shopCode, genreId: args.genreId, hits: Math.min(30,size), page: cursor ?? 1 });
      const items = args.id ? [result] : result.products;
      return page(items.map(item => ({ ...base(item.itemCode, null, item.title, item.canonicalUrl, money(item.price, 'retail_current'),
        { country:'JP', store:item.shopCode,priceBasis:String(item.priceBasis?.meaning ?? item.price.basis ?? 'listing_level_api_item_price') }),
        ...(item.affiliateUrl?{affiliateUrl:item.affiliateUrl}:{}),availability:item.availability })), result, args.id ? 'product_detail' : 'paged_result', result.pagination?.nextPage ?? null);
    }
    if (provider === 'rakuten-advertising' || provider === 'sephora-affiliate') {
      const result = await client.searchProducts({ keyword:args.query,
        ...(provider==='rakuten-advertising'?{advertiserMid:args.merchantId}:{}),page:cursor ?? 1,pageSize:size });
      const offers = result.items.flatMap(item => [
        {...base(item.productId,item.variantId,item.title,item.canonicalURL,item.price,
          {advertiserId:String(item.source.advertiserId),...(provider==='sephora-affiliate'?{country:'US'}:{})}),...(item.affiliateURL?{affiliateUrl:item.affiliateURL}:{})},
        ...(item.salePrice ? [base(item.productId,item.variantId,item.title,item.canonicalURL,money(item.salePrice,'reported_sale'),
          {advertiserId:String(item.source.advertiserId),...(provider==='sephora-affiliate'?{country:'US'}:{})})] : []),
      ]);
      const paging=result.pagination;
      const next=paging.page<paging.totalPages && paging.page*paging.pageSize<paging.conservativeResultCap ? paging.page+1:null;
      return page(offers,result,paging.resultSetMayBeTruncated?'provider_limited':'paged_result',next);
    }
    if (provider === 'ulta-affiliate') {
      const result=args.id?await client.getProduct({productId:args.id}):await client.listProducts({keyword:args.query,limit:Math.min(1000,remaining)});
      const items=result.item?[result.item]:result.items;
      const priced=items.filter(item=>typeof item.price?.amount==='string'&&item.price.currency);
      return {...page(priced.map(item=>({...base(item.productId,item.variantId,item.title,null,item.price,{country:'US',catalogId:args.catalogId}),
        availability:item.availability})),result,'provider_limited'),priceUnavailableCount:items.length-priced.length};
    }
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
