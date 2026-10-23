import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_APPS = path.resolve(HERE, '../../');
const ONTOLOGY_FILE = path.resolve(HERE, '../references/cps-commerce-ontology.v1.json');
const CROSSWALK_FILE = path.resolve(HERE, '../references/linkprice-cps-consumer-crosswalk.v1.json');
const VERTICAL_FILE = path.resolve(HERE, '../references/linkprice-cps-vertical-taxonomy.v1.json');
const SOURCE_REGISTRY_FILE = path.resolve(REPO_APPS, 'naver-blog-api/research/content-store/shopping-sources.v1.json');
const REVERIFICATION_FILE = path.resolve(HERE, '../references/cps-reverify/coverage.json');
const readJson = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

export const loadCpsCommerceOntology = () => readJson(ONTOLOGY_FILE);
export const loadCpsConsumerCrosswalk = () => readJson(CROSSWALK_FILE);
export const loadCpsVerticalTaxonomy = () => readJson(VERTICAL_FILE);
export const loadConsumerShoppingRegistry = () => readJson(SOURCE_REGISTRY_FILE);

const cleanHost = value => {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
};
const matchesHost = (host, root) => host === root || host.endsWith('.' + root);

export function allowedHostsForMerchant(merchantId, siteUrl, crosswalk = loadCpsConsumerCrosswalk()) {
  const mapping = crosswalk.mappings.find(row => row.merchantId === merchantId);
  const explicit = mapping?.allowedHostRoots ?? [];
  const base = cleanHost(siteUrl);
  return [...new Set([...explicit, ...(base ? [base] : [])].map(x => String(x).toLowerCase().replace(/^www\./, '')))];
}

export function productUrlBelongsToMerchant(productUrl, merchantId, siteUrl, crosswalk = loadCpsConsumerCrosswalk()) {
  let url;
  try { url = new URL(productUrl); } catch { return false; }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const roots = allowedHostsForMerchant(merchantId, siteUrl, crosswalk);
  return roots.some(root => matchesHost(host, root));
}

const capState = c => {
  if (!c) return 'not_captured';
  if (c.decision === 'use') return 'verified_public_http';
  if (c.decision === 'manual_url_only') return 'manual_url_only';
  if (c.access === 'protected_session') return 'protected_session_only';
  if (c.access === 'blocked' || c.decision === 'exclude' && ['bot_challenge', 'rate_limited', 'http_rejected'].includes(c.reason)) return 'blocked';
  if (c.access === 'html_only' || c.reason === 'no_api_contract' || c.reason === 'not_verified') return 'unverified';
  return 'not_captured';
};

export const capabilityEvidenceState = capState;

export function capabilityForSource(sourceId, capability, shoppingRegistry = loadConsumerShoppingRegistry()) {
  const source = (shoppingRegistry.sites ?? []).find(row => row.id === sourceId) ?? null;
  const evidence = mappedCapability(source, capability);
  return { state: capState(evidence), evidence };
}

const mappedCapability = (source, capability) => source?.capabilities?.find(row => row.capability === capability) ?? null;

function sourceCapability(source, sourceCapability, { parserFallback = false } = {}) {
  const evidence = mappedCapability(source, sourceCapability);
  if (!evidence && parserFallback) return { state: 'parser_available_source_unverified', parser: 'schema_org_jsonld' };
  return evidence ? { state: capState(evidence), evidence } : { state: 'not_captured' };
}

function capabilityProfile(source, mapped) {
  return {
    product_search: mapped ? sourceCapability(source, 'search') : { state: 'not_captured' },
    product_detail: { state: 'parser_available_source_unverified', parser: 'schema_org_jsonld' },
    product_options: sourceCapability(source, 'product_options'),
    price: sourceCapability(source, 'price', { parserFallback: true }),
    market_price_reference: sourceCapability(source, 'price_via_danawa'),
    availability: sourceCapability(source, 'availability', { parserFallback: true }),
    rating_summary: sourceCapability(source, 'rating_summary', { parserFallback: true }),
    reviews_list: sourceCapability(source, 'reviews_list', { parserFallback: true }),
    reviews_photo: sourceCapability(source, 'reviews_photo'),
  };
}

export function buildCpsCommerceMap(merchants, {
  checkedAt = new Date().toISOString(),
  ontology = loadCpsCommerceOntology(),
  crosswalk = loadCpsConsumerCrosswalk(),
  verticalTaxonomy = loadCpsVerticalTaxonomy(),
  shoppingRegistry = loadConsumerShoppingRegistry(),
  reverification = existsSync(REVERIFICATION_FILE) ? readJson(REVERIFICATION_FILE) : null,
  sourceReceipt = null,
} = {}) {
  if (!Array.isArray(merchants)) throw new Error('CPS_MERCHANTS_INVALID');
  const sourceById = new Map((shoppingRegistry.sites ?? []).map(source => [source.id, source]));
  const crosswalkById = new Map(crosswalk.mappings.map(mapping => [mapping.merchantId, mapping]));
  const verticalById = new Map((verticalTaxonomy.merchants ?? []).map(row => [row.merchantId, row]));
  const reverifiedById = new Map((reverification?.coverage ?? []).map(row => [row.merchantId, row]));
  const rows = merchants.map(merchant => {
    const merchantId = merchant?.merchant_id;
    if (typeof merchantId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(merchantId)) throw new Error('CPS_MERCHANT_ID_INVALID');
    const mapping = crosswalkById.get(merchantId) ?? null;
    const source = mapping ? sourceById.get(mapping.consumerSourceId) : null;
    if (mapping && !source) throw new Error(`CROSSWALK_SOURCE_MISSING:${mapping.consumerSourceId}`);
    let siteUrl;
    try {
      siteUrl = new URL(merchant.site_url);
      if (!['https:', 'http:'].includes(siteUrl.protocol) || siteUrl.username || siteUrl.password) throw new Error();
    } catch { throw new Error('CPS_SITE_URL_INVALID'); }
    return {
      affiliateProgram: {
        id: `linkprice:${merchantId}`,
        networkId: 'linkprice',
        merchantId,
        name: merchant.site_name,
        siteUrl: siteUrl.href,
        networkCategory: {
          category1Id: merchant.category1_id ?? null,
          category2Id: merchant.category2_id ?? null,
          cpsCategoryId: merchant.cps_category_id ?? null,
        },
        verticalClassification: verticalById.has(merchantId) ? {
          hint: verticalById.get(merchantId).verticalHint,
          basis: verticalById.get(merchantId).classificationBasis,
          confidence: verticalById.get(merchantId).confidence,
          notes: verticalById.get(merchantId).notes,
          snapshotCheckedAt: verticalTaxonomy.sourceSnapshot?.checkedAt ?? null,
        } : null,
        observedAt: checkedAt,
      },
      consumerSource: mapping ? {
        sourceId: mapping.consumerSourceId,
        mappingState: 'explicit_merchant_id_crosswalk',
        offeringTypeHint: mapping.offeringTypeHint,
        allowedHostRoots: allowedHostsForMerchant(merchantId, merchant.site_url, crosswalk),
      } : {
        sourceId: `linkprice-consumer:${merchantId}`,
        mappingState: 'merchant_scoped_source_identity',
        offeringTypeHint: 'UnclassifiedOffering',
        allowedHostRoots: allowedHostsForMerchant(merchantId, merchant.site_url, crosswalk),
      },
      capabilityProfile: capabilityProfile(source, !!mapping),
      latestReverification: reverifiedById.has(merchantId) ? {
        ...reverifiedById.get(merchantId), generatedAt: reverification.generatedAt,
      } : null,
    };
  });
  const mapped = rows.filter(row => row.consumerSource.mappingState === 'explicit_merchant_id_crosswalk').length;
  const statesFor = key => Object.fromEntries([...new Set(rows.map(row => row.capabilityProfile[key].state))]
    .map(state => [state, rows.filter(row => row.capabilityProfile[key].state === state).length]));
  return {
    ontologyId: ontology.ontologyId,
    networkId: 'linkprice',
    kind: 'cps',
    checkedAt,
    liveMerchantCount: rows.length,
    explicitConsumerSourceMappings: mapped,
    unmappedMerchantCount: rows.length - mapped,
    capabilityCoverage: Object.fromEntries(['product_search', 'product_detail', 'price', 'market_price_reference', 'availability', 'rating_summary', 'reviews_list', 'reviews_photo']
      .map(capability => [capability, statesFor(capability)])),
    ...(sourceReceipt ? { sourceReceipt } : {}),
    merchants: rows,
  };
}

const safeMoney = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const safeReviewCount = offer => Number.isSafeInteger(offer.reviews) && offer.reviews >= 0 && !offer.reviewsMissing && !offer.reviewsCapped ? offer.reviews : null;

export function normalizeCpsRetailOffers(offers, { merchant, sourceId, checkedAt, siteReceipt } = {}) {
  if (!Array.isArray(offers) || !merchant || typeof sourceId !== 'string') throw new Error('COMMERCE_OFFERS_INVALID');
  const crosswalk = loadCpsConsumerCrosswalk();
  const consumerMapping = crosswalk.mappings.find(row => row.merchantId === merchant.merchant_id);
  if (!consumerMapping || consumerMapping.consumerSourceId !== sourceId) throw new Error('COMMERCE_SOURCE_MAPPING_MISMATCH');
  return offers.filter(offer => offer.mall === sourceId).map(offer => {
    const itemId = String(offer.id ?? '').startsWith(sourceId + ':') ? String(offer.id).slice(sourceId.length + 1) : String(offer.id ?? '');
    const offeringId = `${sourceId}:product:${itemId}`;
    const observedAt = offer.checkedAt ?? checkedAt;
    const price = safeMoney(offer.price);
    const listPrice = safeMoney(offer.listPrice);
    const shippingFee = safeMoney(offer.shippingFee);
    const reviewCount = safeReviewCount(offer);
    const url = typeof offer.url === 'string' && productUrlBelongsToMerchant(offer.url, merchant.merchant_id, merchant.site_url, crosswalk) ? offer.url : null;
    const rating = Number.isFinite(offer.rating) && offer.rating >= 0 ? offer.rating : null;
    const ratingAggregate = rating !== null || reviewCount !== null ? {
      ratingValue: rating, bestRating: null, worstRating: null, reviewCount, ratingCount: null,
      reviewCountCapped: Boolean(offer.reviewsCapped), observedAt, coverage: 'aggregate_displayed',
    } : null;
    const offerObservation = {
      amountMinor: price, currency: price === null ? null : offer.currency ?? 'KRW', listAmountMinor: listPrice,
      shippingAmountMinor: shippingFee, discountCondition: offer.discountKind ?? null,
      availability: offer.soldOut === true ? 'out_of_stock' : offer.soldOut === false ? 'in_stock' : 'unknown',
      observedAt,
      sellerName: typeof offer.seller === 'string' ? offer.seller : null,
    };
    return {
      ontologyId: 'acada:cps-commerce',
      affiliateProgram: { id: `linkprice:${merchant.merchant_id}`, merchantId: merchant.merchant_id, name: merchant.site_name },
      consumerSource: { sourceId, mappingState: 'explicit_merchant_id_crosswalk' },
      offering: {
        id: offeringId,
        type: 'RetailProduct',
        sourceLocalId: itemId || null,
        title: typeof offer.name === 'string' ? offer.name : null,
        brand: null,
        description: null,
        identifiers: {},
        canonicalUrl: url,
        images: [],
      },
      offerObservations: [offerObservation],
      // Kept for consumers of the first version; new consumers use the array.
      offerObservation,
      ratingAggregate,
      evidence: {
        sourceId,
        requestMethod: siteReceipt?.method ?? (sourceId === 'ssg' ? 'POST' : 'GET'),
        requestUrl: siteReceipt?.requestUrl ?? null,
        responseStatus: Number.isInteger(siteReceipt?.httpStatus) ? siteReceipt.httpStatus : null,
        contentType: siteReceipt?.contentType ?? null,
        responseSha256: siteReceipt?.responseSha256 ?? null,
        observedAt,
        browserUsed: siteReceipt?.browserUsed ?? null,
        cookiesSent: siteReceipt ? (siteReceipt.cookiesSent ?? siteReceipt.credentialSent ?? null) : null,
        authorizationSent: siteReceipt?.authorizationSent ?? null,
        pagination: { pagesRead: 1, nextPageCandidate: null, complete: false, stopReason: 'first_page_search' },
      },
    };
  });
}
