import { createHash } from 'node:crypto';

const API_ORIGIN = 'https://creatorsapi.amazon';
const API_PATHS = Object.freeze({
  searchItems: '/catalog/v1/searchItems',
  getItems: '/catalog/v1/getItems',
  getVariations: '/catalog/v1/getVariations',
});
const TOKEN_ENDPOINTS = Object.freeze({
  '3.1': 'https://api.amazon.com/auth/o2/token',
  '3.2': 'https://api.amazon.co.uk/auth/o2/token',
  '3.3': 'https://api.amazon.co.jp/auth/o2/token',
});
const MARKETPLACES = new Set([
  'www.amazon.com', 'www.amazon.ca', 'www.amazon.com.mx', 'www.amazon.com.br',
  'www.amazon.co.uk', 'www.amazon.de', 'www.amazon.fr', 'www.amazon.it',
  'www.amazon.es', 'www.amazon.nl', 'www.amazon.com.be', 'www.amazon.eg',
  'www.amazon.in', 'www.amazon.ie', 'www.amazon.pl', 'www.amazon.sa',
  'www.amazon.se', 'www.amazon.com.tr', 'www.amazon.ae', 'www.amazon.co.jp',
  'www.amazon.sg', 'www.amazon.com.au',
]);
const ISO_CURRENCY = /^[A-Z]{3}$/;
const ASIN = /^[A-Z0-9]{10}$/;
const DECIMAL = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/;
const IMAGE_RESOURCES = Object.freeze([
  'images.primary.small', 'images.primary.medium', 'images.primary.large',
  'images.variants.small', 'images.variants.medium', 'images.variants.large',
]);
const ITEM_INFO_RESOURCES = Object.freeze([
  'itemInfo.byLineInfo', 'itemInfo.classifications', 'itemInfo.contentInfo',
  'itemInfo.contentRating', 'itemInfo.externalIds', 'itemInfo.features',
  'itemInfo.manufactureInfo', 'itemInfo.productInfo', 'itemInfo.technicalInfo',
  'itemInfo.title', 'itemInfo.tradeInInfo',
]);
const OFFER_RESOURCES = Object.freeze([
  'offersV2.listings.availability', 'offersV2.listings.condition',
  'offersV2.listings.dealDetails', 'offersV2.listings.isBuyBoxWinner',
  'offersV2.listings.merchantInfo', 'offersV2.listings.price', 'offersV2.listings.type',
]);
const BROWSE_NODE_RESOURCES = Object.freeze([
  'browseNodeInfo.browseNodes', 'browseNodeInfo.browseNodes.ancestor',
  'browseNodeInfo.browseNodes.salesRank', 'browseNodeInfo.websiteSalesRank',
]);
const VARIATION_RESOURCES = Object.freeze([
  'variationSummary.price.highestPrice', 'variationSummary.price.lowestPrice',
  'variationSummary.variationDimension',
]);
const RESOURCE_FIELDS = Object.freeze([
  ...ITEM_INFO_RESOURCES, ...IMAGE_RESOURCES, ...OFFER_RESOURCES,
  ...BROWSE_NODE_RESOURCES, 'parentASIN',
]);
const VARIATION_RESOURCE_FIELDS = Object.freeze([...RESOURCE_FIELDS, ...VARIATION_RESOURCES]);
const VALID_RESOURCES = new Set(VARIATION_RESOURCE_FIELDS);
const ITEM_INFO_KEYS = new Set([
  'byLineInfo', 'classifications', 'contentInfo', 'contentRating', 'externalIds',
  'features', 'manufactureInfo', 'productInfo', 'technicalInfo', 'title', 'tradeInInfo',
]);
const UNAVAILABLE_PRODUCT_FIELDS = Object.freeze([
  'description', 'sku', 'customerReviewRating', 'customerReviewCount',
  'reviewBodies', 'reviewPhotos', 'stockQuantity',
]);
const DEFAULT_VARIATION_RESOURCES = Object.freeze([
  ...RESOURCE_FIELDS, ...VARIATION_RESOURCES,
]);
const BASE_VALID_RESOURCES = new Set(RESOURCE_FIELDS);
const ALL_VALID_RESOURCES = new Set(VARIATION_RESOURCE_FIELDS);
const ALLOWED_SEARCH_FIELDS = new Set([
  'actor', 'artist', 'author', 'availability', 'brand', 'browseNodeId', 'condition',
  'currencyOfPreference', 'deliveryFlags', 'keywords', 'languagesOfPreference',
  'maxPrice', 'minPrice', 'minReviewsRating', 'minSavingPercent', 'searchIndex',
  'sortBy', 'title',
]);
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export class AmazonCreatorsApiError extends Error {
  constructor(code, receipt = {}) {
    super(code);
    this.name = 'AmazonCreatorsApiError';
    this.code = code;
    this.receipt = receipt;
  }
}

const fail = (code, receipt = {}) => { throw new AmazonCreatorsApiError(code, receipt); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const cleanText = (value, max = 1000) => typeof value === 'string' && value.length > 0 &&
  value.length <= max && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);

function validateCredential(value, label, max = 4096) {
  if (!cleanText(value, max) || /\s/.test(value)) fail(`AMAZON_CREATORS_${label}_INVALID`);
  return value;
}

function validateMarketplace(value) {
  if (typeof value !== 'string' || !MARKETPLACES.has(value)) fail('AMAZON_CREATORS_MARKETPLACE_UNSUPPORTED');
  return value;
}

function validatePartnerTag(value) {
  if (!cleanText(value, 128) || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
    fail('AMAZON_CREATORS_PARTNER_TAG_REQUIRED');
  }
  return value;
}

function mimeOf(response) {
  return response.headers?.get?.('content-type')?.split(';')[0]?.trim().toLowerCase() ?? null;
}

async function readResponse(response, { maxBytes = MAX_RESPONSE_BYTES } = {}) {
  if (!response.body?.getReader) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        fail('AMAZON_CREATORS_RESPONSE_TOO_LARGE', { responseBytes: total });
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, total);
}

function requestEvidence({ origin, path, checkedAt, status, mime, responseBytes, bodyFields }) {
  return {
    method: 'POST', origin, path, httpStatus: status, mime, responseBytes, checkedAt,
    browserUsed: false, credentialsUsed: true, cookieSent: false, bodyFields,
  };
}

async function postJson({
  origin, path, body, headers = {}, fetchImpl, timeoutMs, maxBytes, checkedAt,
  service, bodyFields,
}) {
  let url;
  try { url = new URL(path, origin); } catch { fail('AMAZON_CREATORS_REQUEST_INVALID'); }
  if (url.origin !== origin || url.pathname !== path || url.search || url.hash) {
    fail('AMAZON_CREATORS_REQUEST_INVALID');
  }
  const outHeaders = new Headers({ accept: 'application/json', 'content-type': 'application/json', ...headers });
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST', headers: outHeaders, body: JSON.stringify(body), redirect: 'manual',
      credentials: 'omit', signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    fail('AMAZON_CREATORS_TRANSPORT_FAILED', {
      method: 'POST', origin, path, checkedAt,
      causeCode: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'TRANSPORT_ERROR',
      browserUsed: false, credentialsUsed: true, bodyFields,
    });
  }
  const mime = mimeOf(response);
  const raw = await readResponse(response, { maxBytes });
  const request = requestEvidence({ origin, path, checkedAt, status: response.status, mime,
    responseBytes: raw.byteLength, bodyFields });
  if (response.status >= 300 && response.status < 400 || response.redirected) {
    fail('AMAZON_CREATORS_REDIRECT_REJECTED', { service, request, redirectFollowed: false });
  }
  if (response.status === 401 || response.status === 403) fail('AMAZON_CREATORS_AUTH_REJECTED', { service, request });
  if (response.status === 429) fail('AMAZON_CREATORS_THROTTLED', { service, request });
  if (response.status !== 200 || mime !== 'application/json') {
    fail('AMAZON_CREATORS_HTTP_OR_MIME_ERROR', { service, request });
  }
  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); }
  catch { fail('AMAZON_CREATORS_JSON_INVALID', { service, request }); }
  if (!object(payload)) fail('AMAZON_CREATORS_SCHEMA_INVALID', { service, request });
  return { payload, request, responseSha256: createHash('sha256').update(raw).digest('hex') };
}

function parseToken(payload) {
  if (!cleanText(payload.access_token, 16_384) || /\s/.test(payload.access_token) ||
      typeof payload.token_type !== 'string' || payload.token_type.toLowerCase() !== 'bearer' ||
      payload.scope !== 'creatorsapi::default' || !Number.isSafeInteger(payload.expires_in) ||
      payload.expires_in < 1 || payload.expires_in > 3600) {
    fail('AMAZON_CREATORS_TOKEN_SCHEMA_INVALID');
  }
  return { accessToken: payload.access_token, expiresIn: payload.expires_in };
}

function safeUrl(value, marketplace, asin, partnerTag) {
  if (!cleanText(value, 2048)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || host !== marketplace || url.username || url.password || url.hash) return null;
  const match = url.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i);
  if (!match || match[1].toUpperCase() !== asin) return null;
  const returnedTag = url.searchParams.get('tag');
  if (returnedTag !== null && returnedTag !== partnerTag) return null;
  return url.href;
}

function parseMoney(value, label) {
  if (!object(value)) return null;
  const rawAmount = typeof value.amount === 'number' && Number.isFinite(value.amount)
    ? String(value.amount) : value.amount;
  if (typeof rawAmount !== 'string' || !DECIMAL.test(rawAmount) ||
      typeof value.currency !== 'string' || !ISO_CURRENCY.test(value.currency) ||
      value.displayAmount !== undefined && !cleanText(value.displayAmount, 200)) {
    fail('AMAZON_CREATORS_PRICE_SCHEMA_INVALID', { field: label });
  }
  return {
    amount: rawAmount,
    currency: value.currency,
    ...(value.displayAmount !== undefined ? { displayAmount: value.displayAmount } : {}),
  };
}

function copyDocumentedValue(value, state = { nodes: 0 }, depth = 0) {
  state.nodes++;
  if (state.nodes > 10_000 || depth > 10) fail('AMAZON_CREATORS_ITEM_METADATA_INVALID');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > 20_000 || /\0/.test(value)) fail('AMAZON_CREATORS_ITEM_METADATA_INVALID');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('AMAZON_CREATORS_ITEM_METADATA_INVALID');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 1000) fail('AMAZON_CREATORS_ITEM_METADATA_INVALID');
    return value.map(item => copyDocumentedValue(item, state, depth + 1));
  }
  if (!object(value) || Object.keys(value).length > 200) fail('AMAZON_CREATORS_ITEM_METADATA_INVALID');
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,100}$/.test(key)) fail('AMAZON_CREATORS_ITEM_METADATA_INVALID');
    output[key] = copyDocumentedValue(child, state, depth + 1);
  }
  return output;
}

function normalizeImages(value, asin) {
  if (value === undefined || value === null) return [];
  if (!object(value)) fail('AMAZON_CREATORS_ITEM_SCHEMA_INVALID', { asin, field: 'images' });
  const result = [];
  const sizes = ['small', 'medium', 'large'];
  const normalizeImage = (image, role, size, variantIndex = null) => {
    if (image === undefined || image === null) return;
    if (!object(image) || !cleanText(image.url, 2048) ||
        image.height !== undefined && (!Number.isSafeInteger(image.height) || image.height <= 0) ||
        image.width !== undefined && (!Number.isSafeInteger(image.width) || image.width <= 0)) {
      fail('AMAZON_CREATORS_ITEM_SCHEMA_INVALID', { asin, field: 'images' });
    }
    let parsed;
    try { parsed = new URL(image.url); } catch { parsed = null; }
    const host = parsed?.hostname.toLowerCase();
    if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash ||
        !(host === 'm.media-amazon.com' || host.endsWith('.images-amazon.com'))) {
      fail('AMAZON_CREATORS_ITEM_IMAGE_INVALID', { asin });
    }
    result.push({
      role, size, url: parsed.href,
      ...(variantIndex !== null ? { variantIndex } : {}),
      ...(image.height !== undefined ? { height: image.height } : {}),
      ...(image.width !== undefined ? { width: image.width } : {}),
    });
  };
  if (value.primary !== undefined && value.primary !== null) {
    if (!object(value.primary)) fail('AMAZON_CREATORS_ITEM_SCHEMA_INVALID', { asin, field: 'images.primary' });
    for (const size of sizes) normalizeImage(value.primary[size], 'primary', size);
  }
  if (value.variants !== undefined && value.variants !== null) {
    if (!Array.isArray(value.variants) || value.variants.length > 250) {
      fail('AMAZON_CREATORS_ITEM_SCHEMA_INVALID', { asin, field: 'images.variants' });
    }
    value.variants.forEach((variant, index) => {
      if (!object(variant)) fail('AMAZON_CREATORS_ITEM_SCHEMA_INVALID', { asin, field: 'images.variants' });
      for (const size of sizes) normalizeImage(variant[size], 'variant', size, index);
    });
  }
  return result;
}

function variationAttributes(value, asin) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 50) fail('AMAZON_CREATORS_VARIATION_SCHEMA_INVALID', { asin });
  return value.map(attribute => {
    if (!object(attribute) || !cleanText(attribute.name, 200) || !cleanText(attribute.value, 1000)) {
      fail('AMAZON_CREATORS_VARIATION_SCHEMA_INVALID', { asin });
    }
    return { name: attribute.name, value: attribute.value };
  });
}

function normalizeOffer(raw, index) {
  if (!object(raw)) fail('AMAZON_CREATORS_OFFER_SCHEMA_INVALID', { index });
  const result = {};
  if (raw.price !== undefined) {
    if (!object(raw.price)) fail('AMAZON_CREATORS_OFFER_SCHEMA_INVALID', { index, field: 'price' });
    const current = parseMoney(raw.price.money, `offersV2.listings[${index}].price.money`);
    if (current) result.currentPrice = current;
    if (raw.price.savingBasis !== undefined && raw.price.savingBasis !== null) {
      const basis = raw.price.savingBasis;
      if (!object(basis)) fail('AMAZON_CREATORS_OFFER_SCHEMA_INVALID', { index, field: 'savingBasis' });
      const basisMoney = parseMoney(basis.money, `offersV2.listings[${index}].price.savingBasis.money`);
      const type = basis.savingBasisType;
      const label = basis.savingBasisTypeLabel;
      if (type !== undefined && !cleanText(type, 100) || label !== undefined && !cleanText(label, 200)) {
        fail('AMAZON_CREATORS_OFFER_SCHEMA_INVALID', { index, field: 'savingBasisType' });
      }
      result.savingBasis = {
        ...(basisMoney ? { money: basisMoney } : {}),
        ...(type !== undefined ? { type } : {}),
        ...(label !== undefined ? { label } : {}),
      };
    }
    if (raw.price.savings !== undefined && raw.price.savings !== null) {
      const savings = raw.price.savings;
      if (!object(savings)) fail('AMAZON_CREATORS_OFFER_SCHEMA_INVALID', { index, field: 'savings' });
      const savingsMoney = parseMoney(savings.money, `offersV2.listings[${index}].price.savings.money`);
      if (savings.percentage !== undefined && (!Number.isFinite(savings.percentage) || savings.percentage < 0 || savings.percentage > 100)) {
        fail('AMAZON_CREATORS_OFFER_SCHEMA_INVALID', { index, field: 'savings.percentage' });
      }
      result.savings = {
        ...(savingsMoney ? { money: savingsMoney } : {}),
        ...(savings.percentage !== undefined ? { percentage: savings.percentage } : {}),
      };
    }
    if (raw.price.pricePerUnit !== undefined) {
      result.pricePerUnit = parseMoney(raw.price.pricePerUnit, `offersV2.listings[${index}].price.pricePerUnit`);
    }
  }
  if (raw.availability !== undefined) {
    const available = raw.availability;
    if (!object(available) || available.type !== undefined && !cleanText(available.type, 64) ||
        available.message !== undefined && !cleanText(available.message, 500) ||
        ['minOrderQuantity', 'maxOrderQuantity'].some(key => available[key] !== undefined &&
          (!Number.isSafeInteger(available[key]) || available[key] < 0))) {
      fail('AMAZON_CREATORS_OFFER_SCHEMA_INVALID', { index, field: 'availability' });
    }
    result.availability = {
      ...(available.type !== undefined ? { type: available.type } : {}),
      ...(available.message !== undefined ? { message: available.message } : {}),
      ...(available.minOrderQuantity !== undefined ? { minOrderQuantity: available.minOrderQuantity } : {}),
      ...(available.maxOrderQuantity !== undefined ? { maxOrderQuantity: available.maxOrderQuantity } : {}),
    };
  }
  if (raw.condition !== undefined) {
    if (!object(raw.condition) || raw.condition.value !== undefined && !cleanText(raw.condition.value, 64) ||
        raw.condition.subCondition !== undefined && !cleanText(raw.condition.subCondition, 64) ||
        raw.condition.conditionNote !== undefined && typeof raw.condition.conditionNote !== 'string') {
      fail('AMAZON_CREATORS_OFFER_SCHEMA_INVALID', { index, field: 'condition' });
    }
    result.condition = {
      ...(raw.condition.value !== undefined ? { value: raw.condition.value } : {}),
      ...(raw.condition.subCondition !== undefined ? { subCondition: raw.condition.subCondition } : {}),
      ...(raw.condition.conditionNote !== undefined ? { conditionNote: raw.condition.conditionNote } : {}),
    };
  }
  if (raw.merchantInfo !== undefined) {
    if (!object(raw.merchantInfo) || raw.merchantInfo.name !== undefined && !cleanText(raw.merchantInfo.name, 300) ||
        raw.merchantInfo.id !== undefined && !cleanText(raw.merchantInfo.id, 300)) {
      fail('AMAZON_CREATORS_OFFER_SCHEMA_INVALID', { index, field: 'merchantInfo' });
    }
    result.merchantInfo = {
      ...(raw.merchantInfo.id !== undefined ? { id: raw.merchantInfo.id } : {}),
      ...(raw.merchantInfo.name !== undefined ? { name: raw.merchantInfo.name } : {}),
    };
  }
  if (raw.dealDetails !== undefined) {
    if (!object(raw.dealDetails)) fail('AMAZON_CREATORS_OFFER_SCHEMA_INVALID', { index, field: 'dealDetails' });
    const deal = raw.dealDetails;
    const strings = ['accessType', 'badge', 'endTime', 'startTime'];
    const numbers = ['earlyAccessDurationInMilliseconds', 'percentClaimed'];
    if (strings.some(key => deal[key] !== undefined && !cleanText(deal[key], 300)) ||
        numbers.some(key => deal[key] !== undefined && (!Number.isFinite(deal[key]) || deal[key] < 0))) {
      fail('AMAZON_CREATORS_OFFER_SCHEMA_INVALID', { index, field: 'dealDetails' });
    }
    result.dealDetails = Object.fromEntries([
      ...strings.filter(key => deal[key] !== undefined).map(key => [key, deal[key]]),
      ...numbers.filter(key => deal[key] !== undefined).map(key => [key, deal[key]]),
    ]);
  }
  if (raw.isBuyBoxWinner !== undefined) {
    if (typeof raw.isBuyBoxWinner !== 'boolean') fail('AMAZON_CREATORS_OFFER_SCHEMA_INVALID', { index, field: 'isBuyBoxWinner' });
    result.isBuyBoxWinner = raw.isBuyBoxWinner;
  }
  if (raw.type !== undefined) {
    if (!cleanText(raw.type, 64)) fail('AMAZON_CREATORS_OFFER_SCHEMA_INVALID', { index, field: 'type' });
    result.type = raw.type;
  }
  return result;
}

function normalizeItem(raw, marketplace, partnerTag, expectedAsin = null, { includeOptions = false } = {}) {
  if (!object(raw) || typeof raw.asin !== 'string' || !ASIN.test(raw.asin)) {
    fail('AMAZON_CREATORS_ITEM_SCHEMA_INVALID');
  }
  const asin = raw.asin.toUpperCase();
  if (expectedAsin && asin !== expectedAsin) fail('AMAZON_CREATORS_ITEM_ID_MISMATCH', { expectedIdMatched: false });
  const title = raw.itemInfo?.title?.displayValue;
  if (!cleanText(title, 3000)) fail('AMAZON_CREATORS_ITEM_SCHEMA_INVALID', { field: 'itemInfo.title.displayValue' });
  const url = safeUrl(raw.detailPageURL, marketplace, asin, partnerTag);
  if (!url) fail('AMAZON_CREATORS_ITEM_URL_INVALID', { asin, marketplace });
  const images = normalizeImages(raw.images, asin);
  const imageUrl = images.find(image => image.role === 'primary' && image.size === 'medium')?.url ??
    images.find(image => image.role === 'primary' && image.size === 'small')?.url ??
    images.find(image => image.role === 'primary')?.url ?? null;
  const listings = raw.offersV2?.listings ?? [];
  if (!Array.isArray(listings) || listings.length > 100) fail('AMAZON_CREATORS_ITEM_SCHEMA_INVALID', { asin, field: 'offersV2.listings' });
  const offers = listings.map((offer, index) => normalizeOffer(offer, index));
  const featuredOffer = offers.find(offer => offer.isBuyBoxWinner) ?? offers[0] ?? null;
  const parentAsin = raw.parentASIN;
  if (parentAsin !== undefined && parentAsin !== null && (typeof parentAsin !== 'string' || !ASIN.test(parentAsin))) {
    fail('AMAZON_CREATORS_ITEM_SCHEMA_INVALID', { asin, field: 'parentASIN' });
  }
  const itemInfo = raw.itemInfo;
  if (!object(itemInfo)) fail('AMAZON_CREATORS_ITEM_SCHEMA_INVALID', { asin, field: 'itemInfo' });
  const documentedItemInfo = {};
  for (const [key, value] of Object.entries(itemInfo)) {
    if (ITEM_INFO_KEYS.has(key)) documentedItemInfo[key] = copyDocumentedValue(value);
  }
  const browseNodeInfo = raw.browseNodeInfo == null ? null : copyDocumentedValue(raw.browseNodeInfo);
  const attributes = includeOptions ? variationAttributes(raw.variationAttributes, asin) : null;
  const identifiers = {
    asin,
    parentAsin: parentAsin ? parentAsin.toUpperCase() : null,
    externalIds: documentedItemInfo.externalIds ?? null,
    itemPartNumber: documentedItemInfo.manufactureInfo?.itemPartNumber ?? null,
    sku: null,
  };
  return {
    asin, title, url, imageUrl,
    parentAsin: parentAsin ? parentAsin.toUpperCase() : null,
    description: null,
    features: Array.isArray(documentedItemInfo.features?.displayValues)
      ? documentedItemInfo.features.displayValues.filter(value => typeof value === 'string') : null,
    itemInfo: documentedItemInfo,
    browseNodeInfo,
    identifiers,
    images,
    options: attributes,
    ratings: null,
    availability: featuredOffer?.availability ?? null,
    unavailableFields: [...UNAVAILABLE_PRODUCT_FIELDS],
    offers,
  };
}

function validateItemsResult(payload, key, { marketplace, partnerTag, expectedIds = null, maxItems }) {
  const container = payload?.[key];
  if (!object(container) || !Array.isArray(container.items) || container.items.length > maxItems) {
    fail('AMAZON_CREATORS_RESPONSE_SCHEMA_INVALID');
  }
  if (container.errors !== undefined && (!Array.isArray(container.errors) || container.errors.length > 100)) {
    fail('AMAZON_CREATORS_RESPONSE_SCHEMA_INVALID');
  }
  const requested = expectedIds ? new Set(expectedIds) : null;
  const seen = new Set();
  const items = container.items.map(raw => {
    const normalized = normalizeItem(raw, marketplace, partnerTag);
    if (seen.has(normalized.asin)) fail('AMAZON_CREATORS_DUPLICATE_ITEM', { asin: normalized.asin });
    seen.add(normalized.asin);
    if (requested && !requested.has(normalized.asin)) fail('AMAZON_CREATORS_UNREQUESTED_ITEM', { asin: normalized.asin });
    return normalized;
  });
  if (key === 'searchResult' && container.totalResultCount !== undefined &&
      (!Number.isSafeInteger(container.totalResultCount) || container.totalResultCount < 0)) {
    fail('AMAZON_CREATORS_RESPONSE_SCHEMA_INVALID', { field: 'totalResultCount' });
  }
  if (container.searchURL !== undefined && !safeAmazonSearchUrl(container.searchURL, marketplace)) {
    fail('AMAZON_CREATORS_RESPONSE_SCHEMA_INVALID', { field: 'searchURL' });
  }
  if (container.searchRefinements !== undefined && !object(container.searchRefinements)) {
    fail('AMAZON_CREATORS_RESPONSE_SCHEMA_INVALID', { field: 'searchRefinements' });
  }
  const errors = sanitizeErrors(payload.errors ?? container.errors);
  return { items, errors, totalResultCount: key === 'searchResult' ? container.totalResultCount ?? null : null };
}

function sanitizeErrors(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 100) fail('AMAZON_CREATORS_RESPONSE_SCHEMA_INVALID', { field: 'errors' });
  return value.map(error => {
    if (!object(error)) fail('AMAZON_CREATORS_RESPONSE_SCHEMA_INVALID', { field: 'errors' });
    return {
      ...(typeof error.code === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(error.code) ? { code: error.code } : {}),
    };
  });
}

function normalizeVariationSummary(value) {
  if (value === undefined || value === null) return null;
  if (!object(value)) fail('AMAZON_CREATORS_VARIATION_SCHEMA_INVALID', { field: 'variationSummary' });
  const pageCount = Number(value.pageCount);
  const variationCount = Number(value.variationCount);
  if (!Number.isSafeInteger(pageCount) || pageCount < 0 || pageCount > 1_000_000 ||
      !Number.isSafeInteger(variationCount) || variationCount < 0 || variationCount > 10_000_000) {
    fail('AMAZON_CREATORS_VARIATION_SCHEMA_INVALID', { field: 'variationSummary.count' });
  }
  const price = value.price ?? value.Price ?? null;
  let prices = null;
  if (price !== null) {
    if (!object(price)) fail('AMAZON_CREATORS_VARIATION_SCHEMA_INVALID', { field: 'variationSummary.price' });
    const highestPrice = price.highestPrice === undefined || price.highestPrice === null
      ? null : parseMoney(price.highestPrice, 'variationSummary.price.highestPrice');
    const lowestPrice = price.lowestPrice === undefined || price.lowestPrice === null
      ? null : parseMoney(price.lowestPrice, 'variationSummary.price.lowestPrice');
    prices = { highestPrice, lowestPrice };
  }
  const rawDimensions = value.variationDimensions ?? value.variationDimension ?? [];
  if (!Array.isArray(rawDimensions) || rawDimensions.length > 100) {
    fail('AMAZON_CREATORS_VARIATION_SCHEMA_INVALID', { field: 'variationSummary.variationDimensions' });
  }
  const dimensions = rawDimensions.map(dimension => {
    if (!object(dimension) || !cleanText(dimension.name, 200) ||
        dimension.displayName !== undefined && !cleanText(dimension.displayName, 300) ||
        dimension.locale !== undefined && !/^[a-z]{2}_[A-Z]{2}$/.test(dimension.locale) ||
        !Array.isArray(dimension.values) || dimension.values.length > 1000 ||
        dimension.values.some(item => !cleanText(item, 1000))) {
      fail('AMAZON_CREATORS_VARIATION_SCHEMA_INVALID', { field: 'variationSummary.variationDimensions' });
    }
    return {
      name: dimension.name,
      ...(dimension.displayName !== undefined ? { displayName: dimension.displayName } : {}),
      ...(dimension.locale !== undefined ? { locale: dimension.locale } : {}),
      values: [...dimension.values],
    };
  });
  return { pageCount, variationCount, prices, dimensions };
}

function validateVariationResult(payload, { marketplace, partnerTag, variationCount }) {
  const container = payload?.variationsResult;
  if (!object(container) || !Array.isArray(container.items) || container.items.length > variationCount) {
    fail('AMAZON_CREATORS_RESPONSE_SCHEMA_INVALID', { field: 'variationsResult' });
  }
  const items = container.items.map(raw => {
    const normalized = normalizeItem(raw, marketplace, partnerTag, null, { includeOptions: true });
    return { ...normalized, options: variationAttributes(raw.variationAttributes, normalized.asin) };
  });
  const ids = items.map(item => item.asin);
  if (new Set(ids).size !== ids.length) fail('AMAZON_CREATORS_DUPLICATE_ITEM');
  return {
    items,
    errors: sanitizeErrors(payload.errors ?? container.errors),
    summary: normalizeVariationSummary(container.variationSummary),
  };
}

function variationFamilyParents(items) {
  const parentIds = [...new Set(items.map(item => item.parentAsin).filter(Boolean))];
  if (parentIds.length > 1) fail('AMAZON_CREATORS_VARIATION_FAMILY_MISMATCH', { conflictingParentCount: parentIds.length });
  return parentIds;
}

function validateResourceSelection(resources, { variations = false } = {}) {
  const allowed = variations ? ALL_VALID_RESOURCES : BASE_VALID_RESOURCES;
  if (!Array.isArray(resources) || resources.length < 1 || resources.length > 40 ||
      resources.some(resource => !cleanText(resource, 120) || !allowed.has(resource))) {
    fail('AMAZON_CREATORS_RESOURCES_INVALID');
  }
  return [...new Set(resources)];
}

function safeAmazonSearchUrl(value, marketplace) {
  if (!cleanText(value, 4096)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.toLowerCase() === marketplace && !url.username && !url.password;
  } catch { return false; }
}

function normalizeSearchFilters(input) {
  if (!object(input)) fail('AMAZON_CREATORS_SEARCH_INPUT_INVALID');
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'itemCount' || key === 'itemPage' || key === 'maxPages' || key === 'startPage' || key === 'resources') continue;
    if (!ALLOWED_SEARCH_FIELDS.has(key)) fail('AMAZON_CREATORS_SEARCH_FIELD_UNSUPPORTED', { field: key });
    if (['keywords', 'actor', 'artist', 'author', 'brand', 'searchIndex', 'title'].includes(key)) {
      if (!cleanText(value, 500)) fail('AMAZON_CREATORS_SEARCH_INPUT_INVALID', { field: key });
      result[key] = value;
    } else if (key === 'browseNodeId') {
      if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value) ||
          value.length > 19 || value.length === 19 && value > '9223372036854775807') {
        fail('AMAZON_CREATORS_SEARCH_INPUT_INVALID', { field: key });
      }
      result[key] = value;
    } else if (key === 'currencyOfPreference') {
      if (typeof value !== 'string' || !ISO_CURRENCY.test(value)) fail('AMAZON_CREATORS_SEARCH_INPUT_INVALID', { field: key });
      result[key] = value;
    } else if (key === 'languagesOfPreference') {
      if (!Array.isArray(value) || value.length !== 1 || value.some(item => !/^[a-z]{2}_[A-Z]{2}$/.test(item))) {
        fail('AMAZON_CREATORS_SEARCH_INPUT_INVALID', { field: key });
      }
      result[key] = [...value];
    } else if (key === 'deliveryFlags') {
      const allowed = new Set(['AmazonGlobal', 'FreeShipping', 'FulfilledByAmazon', 'Prime']);
      if (!Array.isArray(value) || value.length < 1 || value.length > 4 || value.some(item => !allowed.has(item))) {
        fail('AMAZON_CREATORS_SEARCH_INPUT_INVALID', { field: key });
      }
      result[key] = [...value];
    } else if (key === 'minPrice' || key === 'maxPrice' || key === 'minReviewsRating' || key === 'minSavingPercent') {
      const maximum = key === 'minReviewsRating' ? 4 : key === 'minSavingPercent' ? 99 : Number.MAX_SAFE_INTEGER;
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail('AMAZON_CREATORS_SEARCH_INPUT_INVALID', { field: key });
      result[key] = value;
    } else if (key === 'availability') {
      if (!['Available', 'IncludeOutOfStock'].includes(value)) fail('AMAZON_CREATORS_SEARCH_INPUT_INVALID', { field: key });
      result[key] = value;
    } else if (key === 'condition') {
      if (!['Any', 'New'].includes(value)) fail('AMAZON_CREATORS_SEARCH_INPUT_INVALID', { field: key });
      result[key] = value;
    } else if (key === 'sortBy') {
      if (!['AvgCustomerReviews', 'Featured', 'NewestArrivals', 'Price:HighToLow', 'Price:LowToHigh', 'Relevance'].includes(value)) {
        fail('AMAZON_CREATORS_SEARCH_INPUT_INVALID', { field: key });
      }
      result[key] = value;
    }
  }
  if (!['keywords', 'actor', 'artist', 'author', 'brand', 'title'].some(key => result[key])) {
    fail('AMAZON_CREATORS_SEARCH_TERM_REQUIRED');
  }
  return result;
}

function validatePage(value, field) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10) fail('AMAZON_CREATORS_PAGE_INVALID', { field });
  return value;
}

function evidenceReceipt({ capabilityId, request, contractUrl, responseSha256, schemaVerified, expectedResultVerified,
  expectedIdsMatched }) {
  return {
    schema: 'web-api-credentialed-read-receipt-v1', service: 'amazon-partner', capabilityId,
    checkedAt: request.checkedAt, secretsPersistedInEvidence: false, authenticated: true,
    credentialsUsed: true, credentialBindingVerified: true, schemaVerified, expectedResultVerified,
    credentialBinding: { source: 'process-memory', serviceMatched: true, originMatched: true, persisted: false },
    contractProvenance: { kind: 'first_party_documented_api', sourceURL: contractUrl },
    request, responseSha256,
    ...(expectedIdsMatched !== undefined ? { expectedIdsMatched } : {}),
  };
}

export function createAmazonCreatorsClient({
  credentialId, credentialSecret, credentialVersion, partnerTag, marketplace = 'www.amazon.com',
  fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 15_000, maxResponseBytes = MAX_RESPONSE_BYTES,
} = {}) {
  const id = validateCredential(credentialId, 'CREDENTIAL_ID');
  const secret = validateCredential(credentialSecret, 'CREDENTIAL_SECRET', 16_384);
  if (!Object.hasOwn(TOKEN_ENDPOINTS, credentialVersion)) fail('AMAZON_CREATORS_CREDENTIAL_VERSION_UNSUPPORTED');
  const affiliateTag = validatePartnerTag(partnerTag);
  const targetMarketplace = validateMarketplace(marketplace);
  if (typeof fetchImpl !== 'function' || typeof now !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000 ||
      !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 32 * 1024 * 1024) {
    fail('AMAZON_CREATORS_CLIENT_OPTIONS_INVALID');
  }
  let tokenCache = null;
  let tokenPending = null;

  function checkedAt() {
    const value = new Date(now());
    if (!Number.isFinite(value.getTime())) fail('AMAZON_CREATORS_CLOCK_INVALID');
    return value.toISOString();
  }

  async function getToken() {
    const timestamp = Number(now());
    if (!Number.isFinite(timestamp)) fail('AMAZON_CREATORS_CLOCK_INVALID');
    if (tokenCache && timestamp < tokenCache.expiresAt - 30_000) return tokenCache;
    if (tokenPending) return tokenPending;
    tokenPending = (async () => {
      const endpoint = new URL(TOKEN_ENDPOINTS[credentialVersion]);
      const requestedAt = checkedAt();
      const result = await postJson({
        origin: endpoint.origin, path: endpoint.pathname,
        body: { grant_type: 'client_credentials', client_id: id, client_secret: secret, scope: 'creatorsapi::default' },
        fetchImpl, timeoutMs, maxBytes: Math.min(maxResponseBytes, 32 * 1024), checkedAt: requestedAt,
        service: 'amazon-creators-token', bodyFields: ['grant_type', 'client_id', 'client_secret', 'scope'],
      });
      const parsed = parseToken(result.payload);
      tokenCache = {
        accessToken: parsed.accessToken,
        expiresAt: Number(now()) + parsed.expiresIn * 1000,
        receipt: result.request,
      };
      return tokenCache;
    })().finally(() => { tokenPending = null; });
    return tokenPending;
  }

  async function callCatalog(operation, body, capabilityId, expectedIds = null) {
    const token = await getToken();
    const requestAt = checkedAt();
    const result = await postJson({
      origin: API_ORIGIN, path: API_PATHS[operation],
      body: { ...body, marketplace: targetMarketplace, partnerTag: affiliateTag },
      headers: { authorization: `Bearer ${token.accessToken}`, 'x-marketplace': targetMarketplace },
      fetchImpl, timeoutMs, maxBytes: maxResponseBytes, checkedAt: requestAt,
      service: 'amazon-creators-catalog', bodyFields: Object.keys(body).concat(['marketplace', 'partnerTag']),
    });
    const envelope = operation === 'searchItems' ? 'searchResult' : 'itemsResult';
    const validated = validateItemsResult(result.payload, envelope, {
      marketplace: targetMarketplace, partnerTag: affiliateTag, expectedIds,
      maxItems: operation === 'searchItems' ? body.itemCount : 10,
    });
    const expectedIdsMatched = expectedIds ? expectedIds.every(itemId => validated.items.some(item => item.asin === itemId)) : undefined;
    const partial = operation === 'searchItems' && validated.errors.length > 0;
    return {
      items: validated.items,
      errors: validated.errors,
      totalResultCount: validated.totalResultCount,
      ...(operation === 'searchItems' ? { partial } : {}),
      request: result.request,
      tokenRequest: token.receipt,
      receipt: evidenceReceipt({
        capabilityId, request: result.request,
        contractUrl: operation === 'searchItems'
          ? 'https://affiliate-program.amazon.com/creatorsapi/docs/en-us/api-reference/operations/search-items'
          : 'https://affiliate-program.amazon.com/creatorsapi/docs/en-us/api-reference/operations/get-items',
        responseSha256: result.responseSha256, schemaVerified: true,
        expectedResultVerified: expectedIds ? expectedIdsMatched : validated.items.length > 0 && !partial,
        ...(expectedIds ? { expectedIdsMatched } : {}),
      }),
    };
  }

  async function searchItems(input = {}) {
    const filters = normalizeSearchFilters(input);
    const itemCount = input.itemCount ?? 10;
    const itemPage = input.itemPage ?? 1;
    if (!Number.isSafeInteger(itemCount) || itemCount < 1 || itemCount > 10) {
      fail('AMAZON_CREATORS_PAGE_INVALID', { field: 'itemCount' });
    }
    validatePage(itemPage, 'itemPage');
    const body = {
      ...filters, itemCount, itemPage,
      resources: input.resources ?? RESOURCE_FIELDS,
    };
    body.resources = validateResourceSelection(body.resources);
    return callCatalog('searchItems', body, 'catalog.search');
  }

  async function searchPages(input = {}) {
    const startPage = input.startPage ?? 1;
    const maxPages = input.maxPages ?? 10;
    const itemCount = input.itemCount ?? 10;
    validatePage(startPage, 'startPage');
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 10 || startPage + maxPages - 1 > 10) {
      fail('AMAZON_CREATORS_PAGE_INVALID', { field: 'maxPages' });
    }
    const pages = [];
    for (let itemPage = startPage; itemPage < startPage + maxPages; itemPage++) {
      const page = await searchItems({ ...input, itemPage, itemCount });
      pages.push({ itemPage, ...page });
      if (page.items.length === 0) break;
    }
    const items = pages.flatMap(page => page.items);
    const totalResultCount = pages.at(-1)?.totalResultCount ?? null;
    const expectedPages = totalResultCount === null ? null : Math.min(10, Math.ceil(totalResultCount / itemCount));
    const partialResponses = pages.filter(page => page.partial).map(page => ({ itemPage: page.itemPage, errors: page.errors }));
    return {
      pages,
      items,
      partial: partialResponses.length > 0,
      partialResponses,
      totalResultCount,
      pagination: {
        startPage, requestedPages: maxPages, fetchedPages: pages.length, maxPage: 10,
        maxItemsPerPage: 10, resultCap: 100,
        truncated: totalResultCount !== null && totalResultCount > items.length &&
          (startPage !== 1 || expectedPages === null || pages.length < expectedPages || totalResultCount > 100),
      },
    };
  }

  async function getItems({ itemIds, itemIdType = 'ASIN', condition = 'Any', currencyOfPreference,
    languagesOfPreference, resources = RESOURCE_FIELDS } = {}) {
    if (!Array.isArray(itemIds) || itemIds.length < 1 || itemIds.length > 10 ||
        itemIds.some(item => typeof item !== 'string' || !ASIN.test(item))) {
      fail('AMAZON_CREATORS_ITEM_IDS_INVALID');
    }
    const ids = itemIds.map(value => value.toUpperCase());
    if (new Set(ids).size !== ids.length) fail('AMAZON_CREATORS_ITEM_IDS_INVALID');
    if (itemIdType !== 'ASIN') fail('AMAZON_CREATORS_ITEM_ID_TYPE_UNSUPPORTED');
    if (!['Any', 'New'].includes(condition)) fail('AMAZON_CREATORS_CONDITION_INVALID');
    if (currencyOfPreference !== undefined && (typeof currencyOfPreference !== 'string' || !ISO_CURRENCY.test(currencyOfPreference))) {
      fail('AMAZON_CREATORS_CURRENCY_INVALID');
    }
    if (languagesOfPreference !== undefined && (!Array.isArray(languagesOfPreference) || languagesOfPreference.length !== 1 ||
        languagesOfPreference.some(value => !/^[a-z]{2}_[A-Z]{2}$/.test(value)))) {
      fail('AMAZON_CREATORS_LANGUAGE_INVALID');
    }
    const selectedResources = validateResourceSelection(resources);
    const body = { itemIds: ids, itemIdType, condition, resources: selectedResources };
    if (currencyOfPreference !== undefined) body.currencyOfPreference = currencyOfPreference;
    if (languagesOfPreference !== undefined) body.languagesOfPreference = languagesOfPreference;
    const result = await callCatalog('getItems', body, 'catalog.product_detail', ids);
    const found = new Set(result.items.map(item => item.asin));
    result.missingItemIds = ids.filter(item => !found.has(item));
    result.receipt.expectedResultVerified = result.missingItemIds.length === 0;
    result.receipt.expectedIdsMatched = result.missingItemIds.length === 0;
    return result;
  }

  async function getVariations({ asin, variationPage = 1, variationCount = 10, condition = 'Any',
    currencyOfPreference, languagesOfPreference, resources = DEFAULT_VARIATION_RESOURCES } = {}) {
    if (typeof asin !== 'string' || !ASIN.test(asin)) fail('AMAZON_CREATORS_ASIN_INVALID');
    const requestedAsin = asin.toUpperCase();
    if (!Number.isSafeInteger(variationPage) || variationPage < 1 || variationPage > 1_000_000 ||
        !Number.isSafeInteger(variationCount) || variationCount < 1 || variationCount > 10) {
      fail('AMAZON_CREATORS_VARIATION_PAGE_INVALID');
    }
    if (!['Any', 'New'].includes(condition)) fail('AMAZON_CREATORS_CONDITION_INVALID');
    if (currencyOfPreference !== undefined && (typeof currencyOfPreference !== 'string' || !ISO_CURRENCY.test(currencyOfPreference))) {
      fail('AMAZON_CREATORS_CURRENCY_INVALID');
    }
    if (languagesOfPreference !== undefined && (!Array.isArray(languagesOfPreference) || languagesOfPreference.length !== 1 ||
        languagesOfPreference.some(value => !/^[a-z]{2}_[A-Z]{2}$/.test(value)))) {
      fail('AMAZON_CREATORS_LANGUAGE_INVALID');
    }
    const selectedResources = validateResourceSelection(resources, { variations: true });
    for (const resource of VARIATION_RESOURCES) if (!selectedResources.includes(resource)) selectedResources.push(resource);
    if (selectedResources.length > 40) fail('AMAZON_CREATORS_RESOURCES_INVALID');
    const body = { asin: requestedAsin, condition, variationPage, variationCount, resources: selectedResources };
    if (currencyOfPreference !== undefined) body.currencyOfPreference = currencyOfPreference;
    if (languagesOfPreference !== undefined) body.languagesOfPreference = languagesOfPreference;
    const token = await getToken();
    const requestAt = checkedAt();
    const result = await postJson({
      origin: API_ORIGIN, path: API_PATHS.getVariations,
      body: { ...body, marketplace: targetMarketplace, partnerTag: affiliateTag },
      headers: { authorization: `Bearer ${token.accessToken}`, 'x-marketplace': targetMarketplace },
      fetchImpl, timeoutMs, maxBytes: maxResponseBytes, checkedAt: requestAt,
      service: 'amazon-creators-catalog', bodyFields: Object.keys(body).concat(['marketplace', 'partnerTag']),
    });
    const validated = validateVariationResult(result.payload, {
      marketplace: targetMarketplace, partnerTag: affiliateTag, variationCount,
    });
    const partial = validated.errors.length > 0;
    const pageCount = validated.summary?.pageCount ?? null;
    const expectedItemCount = validated.summary === null ? null : Math.max(0,
      Math.min(variationCount, validated.summary.variationCount - ((variationPage - 1) * variationCount)));
    const pageCountMismatch = expectedItemCount !== null && validated.items.length !== expectedItemCount && !partial;
    const pageIntegrityIssues = [];
    if (validated.summary === null) pageIntegrityIssues.push({ code: 'VARIATION_SUMMARY_UNAVAILABLE' });
    if (pageCountMismatch) pageIntegrityIssues.push({
      code: 'VARIATION_PAGE_COUNT_MISMATCH', expectedItemCount, actualItemCount: validated.items.length,
    });
    let familyBinding;
    const parentAsins = variationFamilyParents(validated.items);
    const requestedItem = validated.items.find(item => item.asin === requestedAsin) ?? null;
    if (validated.items.length === 0 && validated.summary?.variationCount === 0) {
      familyBinding = { status: 'verified_empty', requestedAsin, familyAsin: null, method: 'requested_asin_query' };
    } else if (requestedItem) {
      familyBinding = {
        status: 'verified', requestedAsin, familyAsin: parentAsins[0] ?? null,
        method: 'requested_asin_returned',
      };
    } else if (parentAsins[0] === requestedAsin) {
      familyBinding = { status: 'verified', requestedAsin, familyAsin: requestedAsin, method: 'returned_parent_asin_match' };
    } else if (parentAsins.length === 1) {
      // A child-ASIN request may page past the requested child itself. Resolve that
      // child through GetItems before treating a shared parent ID as family proof.
      const lookup = await getItems({ itemIds: [requestedAsin], resources: ['itemInfo.title', 'parentASIN'] });
      const requestedProduct = lookup.items.find(item => item.asin === requestedAsin) ?? null;
      if (requestedProduct?.parentAsin === parentAsins[0]) {
        familyBinding = {
          status: 'verified', requestedAsin, familyAsin: parentAsins[0],
          method: 'get_items_parent_asin_match',
        };
      } else if (requestedProduct?.parentAsin && requestedProduct.parentAsin !== parentAsins[0]) {
        fail('AMAZON_CREATORS_VARIATION_FAMILY_MISMATCH', {
          requestedAsin, requestedFamily: requestedProduct.parentAsin, returnedFamily: parentAsins[0],
        });
      } else {
        familyBinding = { status: 'inconclusive', requestedAsin, familyAsin: null, method: 'parent_link_unavailable' };
      }
    } else {
      familyBinding = { status: 'inconclusive', requestedAsin, familyAsin: null, method: 'requested_asin_absent' };
    }
    const inconclusive = familyBinding.status === 'inconclusive' || pageIntegrityIssues.length > 0;
    return {
      requestedAsin,
      items: validated.items,
      errors: validated.errors,
      partial,
      inconclusive,
      integrityIssues: pageIntegrityIssues,
      familyBinding,
      summary: validated.summary,
      pagination: {
        page: variationPage, pageCount, variationCount: validated.summary?.variationCount ?? null,
        pageSize: variationCount, expectedItemCount, actualItemCount: validated.items.length,
        hasNext: pageCount === null ? null : variationPage < pageCount,
      },
      request: result.request,
      tokenRequest: token.receipt,
      receipt: evidenceReceipt({
        capabilityId: 'catalog.options', request: result.request,
        contractUrl: 'https://affiliate-program.amazon.com/creatorsapi/docs/en-us/api-reference/operations/get-variations',
        responseSha256: result.responseSha256, schemaVerified: true,
        expectedResultVerified: !partial && !inconclusive && familyBinding.status.startsWith('verified') && validated.summary !== null,
      }),
    };
  }

  async function getAllVariations({ asin, startPage = 1, maxPages = 10, variationCount = 10, ...options } = {}) {
    if (!Number.isSafeInteger(startPage) || startPage < 1 || startPage > 1_000_000 ||
        !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 10 ||
        !Number.isSafeInteger(variationCount) || variationCount < 1 || variationCount > 10) {
      fail('AMAZON_CREATORS_VARIATION_PAGE_INVALID');
    }
    const pages = [];
    const first = await getVariations({ ...options, asin, variationPage: startPage, variationCount });
    pages.push(first);
    const pageCount = first.summary?.pageCount ?? null;
    if (pageCount !== null) {
      const finalPage = Math.min(pageCount, startPage + maxPages - 1);
      for (let page = startPage + 1; page <= finalPage; page++) {
        pages.push(await getVariations({ ...options, asin, variationPage: page, variationCount }));
      }
    }
    const partialResponses = pages.filter(page => page.partial)
      .map(page => ({ page: page.pagination.page, errors: page.errors }));
    const integrityIssues = [];
    const summaryDrift = pages.some(page => page.summary?.pageCount !== pageCount ||
      page.summary?.variationCount !== first.summary?.variationCount);
    if (pageCount === null) integrityIssues.push({ code: 'VARIATION_SUMMARY_UNAVAILABLE' });
    if (summaryDrift) integrityIssues.push({ code: 'VARIATION_SUMMARY_DRIFT' });
    const familyUnboundPages = pages.filter(page => !page.familyBinding.status.startsWith('verified'))
      .map(page => page.pagination.page);
    if (familyUnboundPages.length) integrityIssues.push({ code: 'VARIATION_FAMILY_BINDING_INCONCLUSIVE', pages: familyUnboundPages });
    const uniqueItems = new Map();
    const duplicateAsins = new Set();
    for (const page of pages) {
      for (const item of page.items) {
        if (uniqueItems.has(item.asin)) duplicateAsins.add(item.asin);
        else uniqueItems.set(item.asin, item);
      }
    }
    if (duplicateAsins.size) integrityIssues.push({ code: 'DUPLICATE_ASIN_ACROSS_VARIATION_PAGES', asins: [...duplicateAsins] });
    const expectedTotal = first.summary?.variationCount ?? null;
    const fullPageSet = pageCount !== null && startPage === 1 && pages.length >= pageCount;
    if (fullPageSet && !partialResponses.length && expectedTotal !== null && uniqueItems.size !== expectedTotal) {
      integrityIssues.push({ code: 'VARIATION_COUNT_MISMATCH', expectedCount: expectedTotal, uniqueCount: uniqueItems.size });
    }
    const inconclusive = integrityIssues.length > 0 || pages.some(page => page.inconclusive);
    const complete = pageCount !== null && fullPageSet && partialResponses.length === 0 &&
      integrityIssues.length === 0 && pages.every(page => page.receipt.expectedResultVerified === true);
    const items = [...uniqueItems.values()];
    return {
      requestedAsin: first.requestedAsin, items, pages, summary: first.summary,
      partial: partialResponses.length > 0, partialResponses, inconclusive, integrityIssues,
      pagination: {
        startPage, requestedPages: maxPages, fetchedPages: pages.length, pageCount,
        pageSize: variationCount, complete,
        truncated: !complete && (pageCount === null || startPage !== 1 || pages.length < pageCount || inconclusive),
      },
    };
  }

  return Object.freeze({
    searchItems,
    searchPages,
    getItems,
    getVariations,
    getAllVariations,
    getTokenStatus: () => tokenCache ? { cached: true, expiresAt: new Date(tokenCache.expiresAt).toISOString() } : { cached: false },
  });
}

export const AMAZON_CREATORS_API_CONTRACT = Object.freeze({
  apiOrigin: API_ORIGIN,
  apiPaths: API_PATHS,
  tokenEndpointsByCredentialVersion: TOKEN_ENDPOINTS,
  scope: 'creatorsapi::default',
  maxSearchPages: 10,
  maxItemsPerSearchPage: 10,
  maxGetItems: 10,
});
