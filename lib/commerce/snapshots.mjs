const DECIMAL = /^(?:0|[1-9]\d{0,17})(?:\.\d{1,8})?$/;
const KINDS = new Set(['retail_current', 'retail_list', 'reported_sale', 'market_reference', 'supplier_base', 'supplier_catalog', 'regional_catalog_base', 'unknown']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const text = (value, max = 1000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const CONTEXT = new Set(['store', 'region', 'marketplace', 'warehouse', 'locale', 'currency', 'query', 'operation', 'advertiserId', 'catalogId',
  'country', 'technique', 'productionCurrency', 'priceBasis']);

export function safeCollectionContext(context = {}) {
  if (!object(context) || Object.entries(context).some(([key, value]) => !CONTEXT.has(key) || !text(value, 256))) fail('COLLECTION_CONTEXT_INVALID');
  return { ...context };
}

function money(value) {
  if (value === null || value === undefined) return null;
  if (!object(value) || typeof value.amount !== 'string' || !DECIMAL.test(value.amount) ||
      value.currency !== null && !/^[A-Z]{3}$/.test(value.currency ?? '') || !KINDS.has(value.kind)) fail('OFFER_PRICE_INVALID');
  return { amount: value.amount, currency: value.currency, kind: value.kind,
    ...(text(value.display, 80) ? { display: value.display } : {}),
    ...(value.shippingIncluded === true || value.shippingIncluded === false ? { shippingIncluded: value.shippingIncluded } : {}) };
}

export function normalizeOffer(value) {
  if (!object(value) || !text(value.provider, 60) || !/^[a-z][a-z0-9-]*$/.test(value.provider) ||
      !text(value.title) || !validTime(value.observedAt) ||
      !(text(value.productId, 256) || text(value.variantId, 256))) fail('OFFER_IDENTITY_INVALID');
  let url = null;
  if (value.url !== null && value.url !== undefined) {
    try {
      const parsed = new URL(value.url);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.href.length > 2048) fail('OFFER_URL_INVALID');
      url = parsed.href;
    } catch { fail('OFFER_URL_INVALID'); }
  }
  const price = money(value.price);
  let priceRange = null;
  if (value.priceRange !== undefined && value.priceRange !== null) {
    const min = money(value.priceRange.min), max = money(value.priceRange.max);
    if (!min || !max || min.currency !== max.currency || min.kind !== max.kind || compareDecimal(min.amount, max.amount) > 0) fail('OFFER_PRICE_RANGE_INVALID');
    priceRange = { min, max };
  }
  if (!price && !priceRange) fail('OFFER_PRICE_MISSING');
  if (!['available', 'unavailable', 'unknown'].includes(value.availability ?? 'unknown')) fail('OFFER_AVAILABILITY_INVALID');
  let affiliateLink = null;
  const affiliateUrl = value.affiliateUrl ?? value.affiliateLink?.url;
  if (affiliateUrl !== null && affiliateUrl !== undefined) {
    try {
      const parsed = new URL(affiliateUrl);
      if (!['https:','http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.href.length > 8192) fail('OFFER_AFFILIATE_URL_INVALID');
      affiliateLink = { url:parsed.href,source:'api_returned',attributionVerified:false,finalTargetVerified:false };
    } catch { fail('OFFER_AFFILIATE_URL_INVALID'); }
  }
  return { schema: 'web-api-product-offer-v1', provider: value.provider,
    productId: text(value.productId, 256) ? value.productId : null,
    variantId: text(value.variantId, 256) ? value.variantId : null,
    title: value.title, url, price, priceRange, availability: value.availability ?? 'unknown',
    context: safeCollectionContext(value.context), observedAt: value.observedAt, ...(affiliateLink ? { affiliateLink } : {}),
    source: typeof value.source === 'string' && text(value.source, 240) ? value.source : 'documented_provider_response' };
}

export function offerKey(offer) {
  const p = offer.price ?? offer.priceRange?.min;
  return JSON.stringify([offer.provider, offer.context?.store ?? null, offer.context?.region ?? null,
    offer.context?.marketplace ?? null, offer.context?.warehouse ?? null,
    offer.context?.advertiserId ?? null, offer.context?.catalogId ?? null,
    offer.context?.country ?? null, offer.context?.technique ?? null, offer.context?.productionCurrency ?? null,
    offer.context?.locale ?? null,
    offer.context?.priceBasis ?? null,
    offer.productId, offer.variantId, p?.currency ?? null, p?.kind ?? null]);
}

export function compareDecimal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !DECIMAL.test(a) || !DECIMAL.test(b)) fail('PRICE_DECIMAL_INVALID');
  const [aw, af = ''] = a.split('.'), [bw, bf = ''] = b.split('.');
  const size = Math.max(af.length, bf.length);
  const left = BigInt(aw + af.padEnd(size, '0')), right = BigInt(bw + bf.padEnd(size, '0'));
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparableValue(offer) { return JSON.stringify([offer.price, offer.priceRange, offer.availability]); }

export function comparePriceSnapshots(previous, current) {
  if (previous?.schema !== 'web-api-product-price-snapshot-v1' || current?.schema !== 'web-api-product-price-snapshot-v1' ||
      !Array.isArray(previous.offers) || !Array.isArray(current.offers)) fail('PRICE_BASELINE_INVALID');
  const before = new Map();
  for (const value of previous.offers) {
    const offer = normalizeOffer(value), key = offerKey(offer);
    if (before.has(key)) fail('PRICE_BASELINE_DUPLICATE');
    before.set(key, offer);
  }
  const changes = [];
  for (const value of current.offers) {
    const offer = normalizeOffer(value), key = offerKey(offer), old = before.get(key);
    if (!old) changes.push({ key, type: 'first_observed', current: offer });
    else if (comparableValue(old) !== comparableValue(offer)) {
      const currencyKnown = (old.price ?? old.priceRange?.min)?.currency !== null && (offer.price ?? offer.priceRange?.min)?.currency !== null;
      const direction = currencyKnown && old.price && offer.price ? compareDecimal(offer.price.amount, old.price.amount) : null;
      changes.push({ key, type: 'changed', priceDirection: !currencyKnown ? 'currency_unverified' : direction === null ? 'range_or_shape_changed' : direction < 0 ? 'decreased' : direction > 0 ? 'increased' : 'unchanged',
        previous: old, current: offer });
    }
  }
  return { schema: 'web-api-product-price-changes-v1', changes,
    missingMeansUnavailable: false, comparison: 'same provider, product, variant, region, currency and price kind; no currency conversion' };
}

const SAFE_RECEIPT_KEYS = new Set(['method', 'origin', 'path', 'httpStatus', 'mime', 'responseBytes', 'responseSha256',
  'checkedAt', 'browserUsed', 'anonymous', 'credentialsUsed', 'cookieSent', 'schemaVerified', 'productIdMatched',
  'productHandleMatched', 'productCount', 'variantCount', 'currency', 'region', 'sourceLastModified', 'lastModified']);
export function sanitizedRequestReceipt(value) {
  if (!object(value)) return null;
  const out = Object.fromEntries(Object.entries(value).filter(([key, item]) => SAFE_RECEIPT_KEYS.has(key) &&
    (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')));
  return Object.keys(out).length ? out : null;
}

/** Bounded, serial page traversal; source-specific adapters own pagination semantics. */
export async function collectOfferSnapshot({ provider, context = {}, loadPage, maxPages = 3, maxOffers = 100, now = Date.now } = {}) {
  if (!text(provider, 60) || typeof loadPage !== 'function' || typeof now !== 'function' ||
      !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100 ||
      !Number.isInteger(maxOffers) || maxOffers < 1 || maxOffers > 50_000) fail('COLLECTION_INPUT_INVALID');
  const safeContext = safeCollectionContext(context), offers = new Map(), receipts = [], seenCursors = new Set();
  let cursor = null, coverage = 'unknown', exhausted = false, rowsSeen = 0, pagesRead = 0, capHit = false, priceUnavailableCount = 0,
    currencyUnverifiedCount = 0, partialResponses = 0;
  for (; pagesRead < maxPages;) {
    const page = await loadPage({ cursor, remaining: maxOffers - offers.size });
    if (!object(page) || !Array.isArray(page.offers) || !['paged_result', 'predictive_sample', 'regional_feed', 'product_detail', 'provider_limited'].includes(page.coverage)) fail('COLLECTION_PAGE_INVALID');
    if (!Number.isInteger(page.priceUnavailableCount ?? 0) || (page.priceUnavailableCount ?? 0) < 0) fail('COLLECTION_PAGE_INVALID');
    pagesRead++; coverage = page.coverage; priceUnavailableCount += page.priceUnavailableCount ?? 0;
    rowsSeen += page.offers.length + (page.priceUnavailableCount ?? 0);
    for (const value of page.offers) {
      const offer = normalizeOffer({ ...value, provider, context: { ...safeContext, ...value.context } }), key = offerKey(offer);
      if ((offer.price ?? offer.priceRange?.min)?.currency === null) currencyUnverifiedCount++;
      const previous = offers.get(key);
      if (previous && comparableValue(previous) !== comparableValue(offer)) fail('COLLECTION_CONFLICTING_DUPLICATE');
      if (!previous && offers.size >= maxOffers) { capHit = true; continue; }
      offers.set(key, offer);
    }
    for (const value of page.receipts ?? []) {
      const receipt = sanitizedRequestReceipt(value);
      if (receipt) receipts.push(receipt);
    }
    if (page.partial === true) partialResponses++;
    if (page.nextCursor === null || page.nextCursor === undefined) { exhausted = true; break; }
    if (offers.size >= maxOffers) { capHit = true; break; }
    const key = JSON.stringify(page.nextCursor);
    if (typeof key !== 'string' || key.length > 2048 || seenCursors.has(key)) fail('COLLECTION_PAGINATION_LOOP');
    seenCursors.add(key); cursor = page.nextCursor;
  }
  return { schema: 'web-api-product-price-snapshot-v1', checkedAt: new Date(now()).toISOString(), provider, context: safeContext,
    executionMode: 'pure_http', offers: [...offers.values()], receipts,
    collection: { pagesRead, rowsSeen, offersStored: offers.size, maxPages, maxOffers, coverage, capHit, priceUnavailableCount, currencyUnverifiedCount, partialResponses,
      sourceExhausted: exhausted, complete: exhausted && !capHit && priceUnavailableCount === 0 && currencyUnverifiedCount === 0 && partialResponses === 0 &&
        ['paged_result', 'regional_feed', 'product_detail'].includes(coverage) } };
}

function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
export function snapshotCsv(snapshot) {
  if (snapshot?.schema !== 'web-api-product-price-snapshot-v1' || !Array.isArray(snapshot.offers)) fail('PRICE_SNAPSHOT_INVALID');
  const fields = ['provider', 'store', 'region', 'marketplace', 'country', 'warehouse', 'locale', 'technique', 'production_currency', 'advertiser_id', 'catalog_id', 'price_basis', 'product_id', 'variant_id', 'title', 'url', 'affiliate_url', 'amount', 'currency',
    'price_kind', 'range_min', 'range_max', 'availability', 'observed_at'];
  const rows = snapshot.offers.map(value => {
    const offer = normalizeOffer(value), p = offer.price ?? offer.priceRange?.min;
    return [offer.provider, offer.context.store, offer.context.region, offer.context.marketplace, offer.context.country, offer.context.warehouse,
      offer.context.locale, offer.context.technique, offer.context.productionCurrency, offer.context.advertiserId, offer.context.catalogId, offer.context.priceBasis,
      offer.productId, offer.variantId, offer.title, offer.url, offer.affiliateLink?.url,
      offer.price?.amount, p.currency, p.kind, offer.priceRange?.min.amount, offer.priceRange?.max.amount, offer.availability, offer.observedAt];
  });
  return [fields, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
