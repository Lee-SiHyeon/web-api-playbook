import { createHash } from 'node:crypto';
import { parseFragment } from 'parse5';
import { decimalToMinor } from '../lib/cps-values.mjs';
import { readPublicPage } from '../lib/cps-public-reader.mjs';
import { allowedHostsForMerchant, loadCpsConsumerCrosswalk, productUrlBelongsToMerchant } from './cps-commerce-ontology.mjs';

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_JSONLD_BLOCKS = 40;
const MAX_REVIEWS = 30;
const cleanText = (value, limit = 4000) => typeof value === 'string' ? value.replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit) || null : null;
const scrubReviewText = value => cleanText(value, 3000)?.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[이메일]')
  .replace(/(?:\+?82[\s-]?)?0\d{1,2}[\s-]?\d{3,4}[\s-]?\d{4}/g, '[전화번호]')
  .replace(/\b\d{6}[- ]?[1-4]\d{6}\b/g, '[개인식별번호]')
  .replace(/(주문\s*번호|운송장\s*번호?|송장\s*번호?|계좌\s*번호|카드\s*번호)\s*[:：#-]?\s*[A-Z0-9-]{4,}/gi, '$1 [민감정보]')
  .replace(/https?:\/\/\S+/gi, '[링크]') ?? null;
const attr = (node, name) => node?.attrs?.find(item => item.name === name)?.value ?? null;

function descendants(root, predicate, found = []) {
  if (!root) return found;
  if (predicate(root)) found.push(root);
  for (const child of root.childNodes ?? []) descendants(child, predicate, found);
  return found;
}

function scriptText(node) {
  return (node.childNodes ?? []).map(child => child.value ?? '').join('');
}

function schemaTypes(node) {
  const value = node?.['@type'];
  const types = Array.isArray(value) ? value : value ? [value] : [];
  return types.map(type => String(type).split(/[\/#]/).at(-1).toLowerCase());
}

function flattenJsonLd(value, result = [], depth = 0) {
  if (depth > 12 || value == null) return result;
  if (Array.isArray(value)) { for (const item of value) flattenJsonLd(item, result, depth + 1); return result; }
  if (typeof value !== 'object') return result;
  result.push(value);
  for (const key of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement', 'hasVariant']) {
    if (Object.hasOwn(value, key)) flattenJsonLd(value[key], result, depth + 1);
  }
  return result;
}

function parseJsonLd(html) {
  const scripts = descendants(parseFragment(html), node => node?.tagName === 'script' && /application\/ld\+json/i.test(attr(node, 'type') ?? ''));
  const objects = [];
  let blocksRead = 0;
  for (const script of scripts.slice(0, MAX_JSONLD_BLOCKS)) {
    const raw = scriptText(script).trim();
    if (!raw || raw.length > 1024 * 1024) continue;
    try { objects.push(...flattenJsonLd(JSON.parse(raw))); blocksRead++; } catch { /* Invalid blocks provide no evidence. */ }
  }
  return { objects, blocksRead };
}

const isOffering = node => schemaTypes(node).some(type => [
  'product', 'productgroup', 'service', 'hotel', 'lodgingbusiness', 'touristtrip', 'trip', 'event', 'course',
  'softwareapplication', 'book', 'creativework', 'productcollection',
].includes(type));
const first = (...values) => values.find(value => value !== undefined && value !== null && value !== '') ?? null;
const list = value => value == null ? [] : Array.isArray(value) ? value : [value];
const nameOf = value => typeof value === 'string' ? value : value && typeof value === 'object' ? value.name ?? null : null;

function decimal(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) return value.trim();
  return null;
}

const amountMinor = decimalToMinor;

function cleanUrl(value, baseUrl, allowedHost) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value, baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || !(url.hostname === allowedHost || url.hostname.endsWith('.' + allowedHost))) return null;
    url.hash = '';
    return safeResponseUrl(url.href);
  } catch { return null; }
}

function ratingSummary(aggregateRating, observedAt) {
  if (!aggregateRating || typeof aggregateRating !== 'object') return null;
  const numeric = value => {
    if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()))) return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const count = value => {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
      const number = Number(value);
      return Number.isSafeInteger(number) ? number : null;
    }
    return null;
  };
  const ratingValue = numeric(aggregateRating.ratingValue);
  const reviewCount = count(aggregateRating.reviewCount);
  const ratingCount = count(aggregateRating.ratingCount);
  if (ratingValue == null && reviewCount == null && ratingCount == null) return null;
  return { ratingValue, bestRating: numeric(aggregateRating.bestRating), worstRating: numeric(aggregateRating.worstRating), reviewCount, ratingCount, observedAt, coverage: 'aggregate_displayed' };
}

function reviewRows(product, offeringId, observedAt, { includeBodies = false } = {}) {
  return list(first(product.review, product.reviews)).slice(0, MAX_REVIEWS).map((review, index) => {
    if (!review || typeof review !== 'object' || !schemaTypes(review).some(type => type === 'review')) return null;
    const rawRating = review.reviewRating?.ratingValue;
    const ratingValue = typeof rawRating === 'number' || typeof rawRating === 'string' && /^\d+(?:\.\d+)?$/.test(rawRating.trim()) ? Number(rawRating) : NaN;
    const rating = Number.isFinite(ratingValue) && ratingValue >= 0 ? ratingValue : null;
    const date = typeof review.datePublished === 'string' && /^\d{4}-\d{2}-\d{2}(?:T[^ ]+)?$/.test(review.datePublished) ? review.datePublished : null;
    return {
      id: `${offeringId}:review:${createHash('sha256').update(String(review['@id'] ?? index + 1)).digest('hex').slice(0, 16)}`,
      offeringId,
      ratingValue: rating,
      publishedAt: date,
      title: includeBodies ? scrubReviewText(review.name)?.slice(0, 500) ?? null : null,
      body: includeBodies ? scrubReviewText(first(review.reviewBody, review.description)) : null,
      optionText: null,
      helpfulCount: null,
      hasMedia: review.image == null ? null : Boolean(review.image),
      reviewerIdentity: null,
      sampleCompleteness: 'partial',
      observedAt,
    };
  }).filter(Boolean);
}

function pointsToCurrentPage(row, currentUrl) {
  const candidates = [row.url, row['@id'], row.mainEntityOfPage?.url, row.mainEntityOfPage?.['@id'],
    typeof row.mainEntityOfPage === 'string' ? row.mainEntityOfPage : null].filter(value => typeof value === 'string');
  const comparable = url => {
    const normalized = new URL(url);
    normalized.hash = '';
    for (const key of [...normalized.searchParams.keys()]) if (/^utm_|^(gclid|fbclid|msclkid|referrer|trackingId)$/i.test(key)) normalized.searchParams.delete(key);
    normalized.searchParams.sort();
    return normalized.href;
  };
  return candidates.some(value => {
    try { return comparable(new URL(value, currentUrl)) === comparable(currentUrl); } catch { return false; }
  });
}

function offersFrom(product, pageUrl, roots) {
  const rawOffers = list(product.offers);
  return rawOffers.slice(0, 20).filter(offer => offer && typeof offer === 'object').map(offer => {
    const currencyValue = first(offer.priceCurrency, offer.priceSpecification?.priceCurrency);
    const currency = typeof currencyValue === 'string' ? currencyValue.toUpperCase() : currencyValue;
    const price = first(offer.price, offer.priceSpecification?.price);
    const availabilityUrl = String(offer.availability ?? '');
    const availabilityType = availabilityUrl.split(/[\/#]/).at(-1);
    const availability = ({ InStock: 'in_stock', OutOfStock: 'out_of_stock', PreOrder: 'preorder', BackOrder: 'backorder' })[availabilityType] ?? 'unknown';
    let url = null;
    for (const root of roots) { url = cleanUrl(offer.url, pageUrl, root); if (url) break; }
    return {
      amountMinor: amountMinor(price, currency),
      currency: typeof currency === 'string' && /^[A-Z]{3}$/.test(currency) ? currency : null,
      listAmountMinor: null,
      shippingAmountMinor: null,
      discountCondition: cleanText(offer.description, 1000),
      availability,
      seller: nameOf(offer.seller),
      validUntil: typeof offer.priceValidUntil === 'string' ? offer.priceValidUntil : null,
      url,
    };
  });
}

const offeringType = node => {
  const types = schemaTypes(node);
  if (types.some(type => ['product', 'productgroup', 'productcollection', 'book'].includes(type))) return 'RetailProduct';
  if (types.some(type => ['hotel', 'lodgingbusiness', 'touristtrip', 'trip', 'event'].includes(type))) return 'TravelOffering';
  if (types.some(type => ['course', 'softwareapplication', 'service'].includes(type))) return types.includes('course') || types.includes('softwareapplication') ? 'DigitalContent' : 'ServiceOffering';
  return 'UnclassifiedOffering';
};

function safeResponseUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/token|auth|session|password|secret|csrf|email|phone|account|key|query|keyword|kwd|inputkeyword|^q$/i.test(key)) url.searchParams.set(key, 'REDACTED');
    return url.href;
  } catch { return null; }
}

export async function readCpsProductPage({ merchant, productUrl, now = () => new Date(), includeReviewBodies = false } = {}) {
  if (!merchant || typeof merchant.merchant_id !== 'string' || typeof merchant.site_url !== 'string') throw Object.assign(new Error('MERCHANT_INPUT_INVALID'), { code: 'MERCHANT_INPUT_INVALID' });
  let url;
  try { url = new URL(productUrl); } catch { throw Object.assign(new Error('PRODUCT_URL_INVALID'), { code: 'PRODUCT_URL_INVALID' }); }
  if (!productUrlBelongsToMerchant(url.href, merchant.merchant_id, merchant.site_url)) throw Object.assign(new Error('PRODUCT_URL_OUTSIDE_MERCHANT_SCOPE'), { code: 'PRODUCT_URL_OUTSIDE_MERCHANT_SCOPE' });
  url.hash = '';
  const page = await readPublicPage(url.href, { allowedHosts: allowedHostsForMerchant(merchant.merchant_id, merchant.site_url), maxBytes: MAX_BYTES });
  const requestUrl = page.url ?? url.href;
  const observedAt = page.receipt?.observedAt ?? now().toISOString();
  const contentType = page.contentType ?? page.receipt?.contentType ?? '';
  const baseReceipt = { ...page.receipt, method: 'GET', requestUrl: safeResponseUrl(requestUrl), httpStatus: page.status, contentType,
    checkedAt: observedAt, browserUsed: false, cookiesSent: false, authorizationSent: false,
    redirects: page.redirects, transport: 'https_public_ipv4_pinned', credentials: 'omitted' };
  if (!page.ok) throw Object.assign(new Error('PRODUCT_' + (page.stopReason ?? 'TRANSPORT_FAILED')), {
    code: 'PRODUCT_' + (page.stopReason ?? 'TRANSPORT_FAILED'), receipt: { ...baseReceipt, retry: false },
  });
  const { html } = page;
  const { bytes, responseSha256 } = page.receipt;
  const { objects, blocksRead } = parseJsonLd(html);
  const candidates = objects.filter(isOffering);
  const current = new URL(requestUrl);
  let products = candidates.filter(row => pointsToCurrentPage(row, current));
  const groups = products.filter(row => schemaTypes(row).includes('productgroup'));
  if (groups.length === 1 && products.every(product => product === groups[0] || list(groups[0].hasVariant).includes(product))) products = groups;
  if (products.length !== 1) throw Object.assign(new Error(products.length ? 'PRODUCT_SCHEMA_AMBIGUOUS' : 'PRODUCT_SCHEMA_NOT_FOUND'), {
    code: products.length ? 'PRODUCT_SCHEMA_AMBIGUOUS' : 'PRODUCT_SCHEMA_NOT_FOUND',
    receipt: { ...baseReceipt, bytes, responseSha256, jsonLdBlocksRead: blocksRead, offeringCandidates: candidates.length },
  });
  const row = products[0];
  const crosswalk = loadCpsConsumerCrosswalk();
  const consumerMapping = crosswalk.mappings.find(mapping => mapping.merchantId === merchant.merchant_id) ?? null;
  const allowedRoots = allowedHostsForMerchant(merchant.merchant_id, merchant.site_url, crosswalk);
  for (const alternate of list(row.sameAs)) {
    const root = cleanHost(typeof alternate === 'string' ? alternate : alternate?.url);
    if (root && productUrlBelongsToMerchant(`https://${root}/`, merchant.merchant_id, merchant.site_url, crosswalk)) allowedRoots.push(root);
  }
  const idValue = first(row.productGroupID, row.sku, row.productID, row.gtin, row.gtin13, row.gtin14, row.isbn, row.mpn, row['@id'], row.url, requestUrl);
  const identityNamespace = consumerMapping?.consumerSourceId ?? `linkprice-consumer:${merchant.merchant_id}`;
  const offeringId = `${identityNamespace}:offering:${createHash('sha256').update(String(idValue)).digest('hex').slice(0, 20)}`;
  const variantRows = list(row.hasVariant).filter(variant => variant && typeof variant === 'object' && isOffering(variant));
  const variantKey = (variant, index) => first(variant.sku, variant.productID, variant.mpn, variant['@id'], variant.url) ?? null;
  const productVariants = variantRows.map((variant, index) => {
    const localId = variantKey(variant, index);
    const variantOffers = offersFrom(variant, requestUrl, allowedRoots);
    return { id: `${offeringId}:variant:${createHash('sha256').update(String(localId ?? `position:${index}`)).digest('hex').slice(0, 16)}`,
      parentOfferingId: offeringId, variantLocalId: localId === null ? null : String(localId), title: cleanText(variant.name, 1000),
      attributes: Object.fromEntries(['color', 'size', 'material', 'pattern'].filter(key => variant[key] != null).map(key => [key, cleanText(nameOf(variant[key]), 300)])),
      availability: variantOffers.length && variantOffers.every(offer => offer.availability === variantOffers[0].availability) ? variantOffers[0].availability : 'unknown' };
  });
  const brand = nameOf(row.brand);
  const imageValues = list(row.image).map(item => typeof item === 'string' ? item : item?.url ?? item?.contentUrl).filter(Boolean);
  const images = imageValues.slice(0, 10).map(imageUrl => {
    try { const parsed = new URL(imageUrl, requestUrl); return parsed.protocol === 'https:' ? safeResponseUrl(parsed.href) : null; } catch { return null; }
  }).filter(Boolean);
  const reviewedAt = observedAt;
  const aggregate = ratingSummary(row.aggregateRating, reviewedAt);
  const reviews = reviewRows(row, offeringId, reviewedAt, { includeBodies: includeReviewBodies === true });
  const receipt = { ...baseReceipt, sourceId: identityNamespace, requestMethod: 'GET', responseStatus: baseReceipt.httpStatus, observedAt,
    bytes, responseSha256, jsonLdBlocksRead: blocksRead, schemaType: schemaTypes(row), parser: 'schema_org_jsonld',
    productUrl: safeResponseUrl(requestUrl), browserUsed: false, cookiesSent: false, authorizationSent: false,
    pagination: { pagesRead: 1, nextPageCandidate: null, complete: false, stopReason: 'single_product_page_jsonld' } };
  return {
    ontologyId: 'acada:cps-commerce',
    affiliateProgram: { id: `linkprice:${merchant.merchant_id}`, merchantId: merchant.merchant_id, name: merchant.site_name },
    consumerSource: {
      sourceId: identityNamespace,
      provisionalSourceId: `linkprice-consumer:${merchant.merchant_id}`,
      mappingState: consumerMapping ? 'explicit_merchant_id_crosswalk' : 'unverified_single_page_observation',
      origin: current.origin,
    },
    offering: {
      id: offeringId,
      type: offeringType(row),
      schemaTypes: schemaTypes(row),
      sourceLocalId: cleanText(first(row.sku, row.gtin, row.gtin13, row.gtin14, row.isbn, row.mpn), 200),
      title: cleanText(row.name, 1000),
      brand: cleanText(brand, 300),
      description: cleanText(first(row.description, row.disambiguatingDescription), 4000),
      identifiers: Object.fromEntries(['gtin', 'gtin8', 'gtin12', 'gtin13', 'gtin14', 'isbn', 'mpn'].filter(key => typeof row[key] === 'string').map(key => [key, row[key].slice(0, 200)])),
      canonicalUrl: allowedRoots.map(root => cleanUrl(first(row.url, row['@id'], requestUrl), requestUrl, root)).find(Boolean) ?? safeResponseUrl(requestUrl),
      images,
    },
    productVariants,
    offerObservations: [
      ...offersFrom(row, requestUrl, allowedRoots).map(offer => ({ ...offer, observedAt, variantLocalId: null })),
      ...variantRows.flatMap((variant, index) => offersFrom(variant, requestUrl, allowedRoots).map(offer => ({ ...offer,
        observedAt, variantLocalId: productVariants[index].variantLocalId, variantId: productVariants[index].id }))),
    ],
    ratingAggregate: aggregate,
    reviewObservations: reviews,
    reviewCoverage: { aggregateReviewCount: aggregate?.reviewCount ?? null, sampleCount: reviews.length, complete: false,
      bodiesIncluded: includeReviewBodies === true, bodyRetention: includeReviewBodies === true ? 'transient_output_only' : 'omitted' },
    evidence: receipt,
  };
}

function cleanHost(value) { try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; } }
