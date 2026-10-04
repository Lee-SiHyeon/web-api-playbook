import { commerceJsonRequest, commerceFail } from './http.mjs';

const SERVICE = 'rakuten-ichiba';
const ORIGIN = 'https://openapi.rakuten.co.jp';
const ITEM_PATH = '/ichibams/api/IchibaItem/Search/20260701';
const GENRE_PATH = '/ichibagt/api/IchibaGenre/Search/20260701';
const ITEM_DOC = 'https://webservice.rakuten.co.jp/documentation/ichiba-item-search';
const GENRE_DOC = 'https://webservice.rakuten.co.jp/documentation/ichiba-genre-search';
const APP_DOC = 'https://webservice.rakuten.co.jp/guide';
const ITEM_ELEMENTS = [
  'itemName', 'catchcopy', 'itemCode', 'shopCode', 'itemPrice', 'itemPriceBaseField',
  'itemPriceMin1', 'itemPriceMax1', 'itemPriceMin2', 'itemPriceMax2',
  'itemPriceMin3', 'itemPriceMax3', 'itemUrl', 'affiliateUrl', 'genreId',
  'availability', 'taxFlag', 'postageFlag', 'updateTimestamp', 'affiliateRate',
].join(',');
const SORTS = new Set([
  'standard', '+affiliateRate', '-affiliateRate', '+reviewCount', '-reviewCount',
  '+reviewAverage', '-reviewAverage', '+itemPrice', '-itemPrice',
  '+updateTimestamp', '-updateTimestamp',
]);
const CONTROL = /[\x00-\x1f\x7f]/;

const fail = (code, receipt) => commerceFail(SERVICE, `RAKUTEN_ICHIBA_${code}`, receipt);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value, max = 2_000) => typeof value === 'string' && value.length > 0 &&
  value.length <= max && !CONTROL.test(value);
const safeNonnegative = value => Number.isSafeInteger(value) && value >= 0;

function validateApplicationId(value) {
  if (!isText(value, 1_024) || value.trim() !== value) fail('APPLICATION_ID_REQUIRED');
  return value;
}

function validateAccessKey(value) {
  if (!isText(value, 8_192) || value.trim() !== value || /\s/.test(value)) fail('ACCESS_KEY_REQUIRED');
  return value;
}

function validateAffiliateId(value) {
  if (value === undefined) return undefined;
  if (!isText(value, 512) || value.trim() !== value) fail('AFFILIATE_ID_INVALID');
  return value;
}

function validateShopCode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value)) {
    fail('SHOP_CODE_INVALID');
  }
  return value;
}

function parseItemCode(value) {
  if (typeof value !== 'string' || value.length > 250 || CONTROL.test(value)) fail('ITEM_CODE_INVALID');
  const separator = value.indexOf(':');
  if (separator < 1 || separator === value.length - 1) fail('ITEM_CODE_INVALID');
  const shopCode = validateShopCode(value.slice(0, separator));
  const itemPart = value.slice(separator + 1);
  if (!/^[^\s/?#]{1,200}$/.test(itemPart)) fail('ITEM_CODE_INVALID');
  return { itemCode: value, itemShopCode: shopCode, itemPart };
}

function validatePriceLimit(value, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value >= 999_999_999) fail(`${name}_INVALID`);
  return String(value);
}

function parseJpy(value, sourceField) {
  let integer;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) integer = value;
  else if (typeof value === 'string' && /^(?:0|[1-9]\d{0,14})$/.test(value)) integer = Number(value);
  else fail('ITEM_PRICE_INVALID');
  if (!Number.isSafeInteger(integer)) fail('ITEM_PRICE_INVALID');
  return { amount: String(integer), currency: 'JPY', unit: 'decimal', sourceField };
}

function safeAffiliateUrl(value) {
  if (typeof value !== 'string' || value.length > 4_000 || CONTROL.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return null;
  const host = url.hostname.toLowerCase();
  if (!['hb.afl.rakuten.co.jp', 'afl.rakuten.co.jp'].includes(host)) return null;
  return url.href;
}

function verifiedMerchantTarget(value, shopCode, itemPart) {
  if (typeof value !== 'string' || value.length > 4_000 || CONTROL.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
      !['item.rakuten.co.jp', 'm.rakuten.co.jp'].includes(url.hostname.toLowerCase())) return null;
  let segments;
  try { segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); }
  catch { return null; }
  // Require an exact, visible item-key match in the URL path. Do not infer a
  // slug transformation or construct a path from itemCode.
  if (segments.length < 2 || segments[0] !== shopCode || !segments.slice(1).includes(itemPart)) return null;
  url.search = '';
  url.hash = '';
  return { url: url.href, host: url.hostname.toLowerCase() };
}

function extractStaticAffiliateTargets(value) {
  if (typeof value !== 'string' || value.length > 4_000 || CONTROL.test(value)) return [];
  let url;
  try { url = new URL(value); } catch { return []; }
  if (safeAffiliateUrl(value) === null) return [];
  const targets = [];
  for (const key of ['pc', 'm']) {
    const values = url.searchParams.getAll(key);
    if (values.length === 1 && values[0]) targets.push({ key, value: values[0] });
  }
  return targets;
}

function resolveCanonicalTarget(rawItemUrl, rawAffiliateUrl, shopCode, itemPart) {
  const direct = verifiedMerchantTarget(rawItemUrl, shopCode, itemPart);
  if (direct) return { canonicalUrl: direct.url, canonicalUrlSource: 'api_itemUrl', targetVerified: true,
    targetMatchBasis: 'shopCode_path_and_exact_itemCode_path_segment' };
  for (const [field, value] of [['api_itemUrl', rawItemUrl], ['api_affiliateUrl', rawAffiliateUrl]]) {
    for (const target of extractStaticAffiliateTargets(value)) {
      const verified = verifiedMerchantTarget(target.value, shopCode, itemPart);
      if (verified) return {
        canonicalUrl: verified.url,
        canonicalUrlSource: `${field}.${target.key}`,
        targetVerified: true,
        targetMatchBasis: 'shopCode_path_and_exact_itemCode_path_segment',
      };
    }
  }
  return { canonicalUrl: null, targetVerified: false };
}

function optionalPriceRange(raw, minField, maxField, basis) {
  const minimum = raw[minField] === undefined || raw[minField] === null ? null : parseJpy(raw[minField], minField);
  const maximum = raw[maxField] === undefined || raw[maxField] === null ? null : parseJpy(raw[maxField], maxField);
  if (minimum === null && maximum === null) return null;
  if (minimum !== null && maximum !== null && Number(minimum.amount) > Number(maximum.amount)) {
    fail('ITEM_PRICE_RANGE_INVALID');
  }
  return { basis, min: minimum, max: maximum };
}

function containsCredential(value, credentials, depth = 0) {
  if (depth > 12) return false;
  if (typeof value === 'string') return credentials.some(secret => secret.length >= 8 && value.includes(secret));
  if (Array.isArray(value)) return value.some(child => containsCredential(child, credentials, depth + 1));
  if (isObject(value)) return Object.values(value).some(child => containsCredential(child, credentials, depth + 1));
  return false;
}

const GENRE_KEYS = new Set(['ancestors', 'genre', 'siblings', 'children', 'attributes']);
const GENRE_VALUE_KEYS = new Set(['genreId', 'attributeId', 'itemCount', 'level', 'nameJa']);

function sanitizeGenreData(value, depth = 0) {
  if (depth > 12) return null;
  if (Array.isArray(value)) return value.slice(0, 1_000).map(item => sanitizeGenreData(item, depth + 1));
  if (!isObject(value)) return null;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (GENRE_KEYS.has(key)) {
      if (Array.isArray(child)) output[key] = child.slice(0, 1_000).map(item => sanitizeGenreData(item, depth + 1));
      else output[key] = sanitizeGenreData(child, depth + 1);
    } else if (GENRE_VALUE_KEYS.has(key)) {
      if ((key === 'nameJa' && isText(child, 500)) ||
          (key !== 'nameJa' && (safeNonnegative(child) || (typeof child === 'string' && /^\d{1,20}$/.test(child))))) {
        output[key] = child;
      }
    } else if (Array.isArray(child) || isObject(child)) {
      // Allow documented fields under API-version wrappers without exposing
      // arbitrary string fields or credentials from the raw response.
      const nested = sanitizeGenreData(child, depth + 1);
      if (Array.isArray(child) ? nested.some(isObject) : Object.keys(nested ?? {}).length > 0) output[key] = nested;
    }
  }
  return output;
}

function containsGenreRecord(value, genreId, depth = 0) {
  if (depth > 12) return false;
  if (Array.isArray(value)) return value.some(item => containsGenreRecord(item, genreId, depth + 1));
  if (!isObject(value)) return false;
  if (String(value.genreId) === genreId && isText(value.nameJa, 500)) return true;
  return Object.values(value).some(item => containsGenreRecord(item, genreId, depth + 1));
}

function affiliateMode(params, defaultAffiliateId) {
  return params.affiliateId === undefined ? defaultAffiliateId : validateAffiliateId(params.affiliateId);
}

function queryValue(name, value, max = 500) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || CONTROL.test(value)) {
    fail(`${name.toUpperCase()}_INVALID`);
  }
  return value;
}

function makeReceipt(capabilityId, request, result) {
  return {
    schema: 'web-api-credentialed-read-receipt-v1',
    service: SERVICE,
    capabilityId,
    checkedAt: request.checkedAt,
    secretsPersistedInEvidence: false,
    authenticated: true,
    credentialsUsed: true,
    credentialBindingVerified: true,
    schemaVerified: true,
    expectedResultVerified: true,
    credentialBinding: {
      source: 'process-memory',
      serviceMatched: true,
      originMatched: true,
      persisted: false,
    },
    contractProvenance: { kind: 'first_party_documented_api', sourceURL: ITEM_DOC },
    request,
    result,
  };
}

function normalizeItem(raw, { affiliateId, requestedItemCode } = {}) {
  if (!isObject(raw)) fail('ITEM_SCHEMA_INVALID');
  const itemCode = queryValue('itemCode', raw.itemCode, 250);
  const parsedCode = parseItemCode(itemCode);
  const shopCode = validateShopCode(raw.shopCode);
  if (parsedCode.itemShopCode !== shopCode) fail('ITEM_IDENTITY_MISMATCH');
  if (requestedItemCode && itemCode !== requestedItemCode) fail('ITEM_IDENTITY_MISMATCH');
  if (!isText(raw.itemName, 1_000)) fail('ITEM_TITLE_INVALID');
  const target = resolveCanonicalTarget(raw.itemUrl, raw.affiliateUrl, shopCode, parsedCode.itemPart);
  const affiliateUrl = affiliateId === undefined ? null : safeAffiliateUrl(raw.affiliateUrl);
  if (affiliateId !== undefined && !affiliateUrl) fail('AFFILIATE_URL_INVALID');
  const genreId = raw.genreId === undefined || raw.genreId === null ? null : String(raw.genreId);
  if (genreId !== null && !/^\d{1,20}$/.test(genreId)) fail('ITEM_GENRE_INVALID');
  const availability = raw.availability === 1 || raw.availability === '1' ? 'available'
    : raw.availability === 0 || raw.availability === '0' ? 'unavailable' : 'unknown';
  const baseFields = new Set(['item_price_min1', 'item_price_min2', 'item_price_min3']);
  if (raw.itemPriceBaseField !== undefined && raw.itemPriceBaseField !== null &&
      !baseFields.has(raw.itemPriceBaseField)) fail('ITEM_PRICE_BASE_FIELD_INVALID');
  const priceBasisMeanings = {
    item_price_min1: 'all_item_price_minimum_basis',
    item_price_min2: 'searchable_item_price_minimum_basis',
    item_price_min3: 'purchasable_item_price_minimum_basis',
  };
  const priceRanges = {
    all: optionalPriceRange(raw, 'itemPriceMin1', 'itemPriceMax1', 'all_items'),
    searchable: optionalPriceRange(raw, 'itemPriceMin2', 'itemPriceMax2', 'searchable_items'),
    purchasable: optionalPriceRange(raw, 'itemPriceMin3', 'itemPriceMax3', 'purchasable_items'),
  };
  const item = {
    itemCode,
    shopCode,
    title: raw.itemName,
    price: {
      ...parseJpy(raw.itemPrice, 'itemPrice'),
      basis: 'listing_level_api_item_price',
      selectedVariant: false,
    },
    priceBasis: {
      field: raw.itemPriceBaseField ?? null,
      meaning: raw.itemPriceBaseField ? priceBasisMeanings[raw.itemPriceBaseField] : 'not_specified_by_response',
    },
    priceRanges,
    currency: 'JPY',
    canonicalUrl: target.canonicalUrl,
    targetVerified: target.targetVerified,
    ...(target.targetMatchBasis ? { targetMatchBasis: target.targetMatchBasis } : {}),
    ...(target.canonicalUrlSource ? { canonicalUrlSource: target.canonicalUrlSource } : {}),
    availability,
    ...(genreId === null ? {} : { genreId }),
    ...(isText(raw.catchcopy, 2_000) ? { catchcopy: raw.catchcopy } : {}),
    ...(isText(raw.updateTimestamp, 100) ? { updateTimestamp: raw.updateTimestamp } : {}),
    ...(affiliateUrl ? { affiliateUrl } : {}),
  };
  if (raw.affiliateRate !== undefined && raw.affiliateRate !== null) {
    const rate = typeof raw.affiliateRate === 'number' ? String(raw.affiliateRate) : raw.affiliateRate;
    if (typeof rate !== 'string' || !/^(?:0|[1-9]\d{0,2})(?:\.\d)?$/.test(rate) || Number(rate) > 100) {
      fail('AFFILIATE_RATE_INVALID');
    }
    item.affiliateRate = { percent: rate, sourceField: 'affiliateRate', basis: 'item_specific_api_value' };
  }
  if (raw.taxFlag !== undefined && [0, 1, '0', '1'].includes(raw.taxFlag)) item.taxIncluded = raw.taxFlag === 0 || raw.taxFlag === '0';
  if (raw.postageFlag !== undefined && [0, 1, '0', '1'].includes(raw.postageFlag)) item.postageIncluded = raw.postageFlag === 0 || raw.postageFlag === '0';
  return item;
}

function validateSearchParams(params) {
  if (!isObject(params)) fail('SEARCH_PARAMS_INVALID');
  const query = [];
  if (params.keyword !== undefined) {
    const keyword = queryValue('keyword', params.keyword, 128);
    if (!keyword.trim()) fail('KEYWORD_INVALID');
    const tokens = keyword.trim().split(/\s+/);
    if (tokens.some(token => /^[\x00-\x7f]+$/.test(token) && token.length < 2)) fail('KEYWORD_INVALID');
    query.push(['keyword', keyword]);
  }
  if (params.shopCode !== undefined) query.push(['shopCode', validateShopCode(params.shopCode)]);
  let requestedItemCode;
  if (params.itemCode !== undefined) {
    requestedItemCode = parseItemCode(params.itemCode).itemCode;
    query.push(['itemCode', requestedItemCode]);
  }
  if (params.genreId !== undefined) {
    const genreId = typeof params.genreId === 'number' ? String(params.genreId) : params.genreId;
    if (typeof genreId !== 'string' || !/^\d{1,20}$/.test(genreId)) fail('GENRE_ID_INVALID');
    query.push(['genreId', genreId]);
  }
  if (query.length === 0) fail('SEARCH_SELECTOR_REQUIRED');
  const hits = params.hits ?? 30;
  const page = params.page ?? 1;
  if (!Number.isSafeInteger(hits) || hits < 1 || hits > 30) fail('HITS_INVALID');
  if (!Number.isSafeInteger(page) || page < 1 || page > 100) fail('PAGE_INVALID');
  if (params.sort !== undefined && !SORTS.has(params.sort)) fail('SORT_INVALID');
  if (params.minPrice !== undefined) query.push(['minPrice', validatePriceLimit(params.minPrice, 'MIN_PRICE')]);
  if (params.maxPrice !== undefined) query.push(['maxPrice', validatePriceLimit(params.maxPrice, 'MAX_PRICE')]);
  if (params.minPrice !== undefined && params.maxPrice !== undefined && params.maxPrice <= params.minPrice) {
    fail('PRICE_RANGE_INVALID');
  }
  query.push(['format', 'json'], ['formatVersion', '2'], ['elements', ITEM_ELEMENTS], ['hits', String(hits)], ['page', String(page)]);
  if (params.sort !== undefined) query.push(['sort', params.sort]);
  if (params.availability !== undefined) {
    if (![0, 1].includes(params.availability)) fail('AVAILABILITY_INVALID');
    query.push(['availability', String(params.availability)]);
  }
  if (params.imageFlag !== undefined) {
    if (![0, 1].includes(params.imageFlag)) fail('IMAGE_FLAG_INVALID');
    query.push(['imageFlag', String(params.imageFlag)]);
  }
  if (params.minPrice !== undefined && !query.some(([key]) => key === 'minPrice')) fail('MIN_PRICE_INVALID');
  if (params.maxPrice !== undefined && !query.some(([key]) => key === 'maxPrice')) fail('MAX_PRICE_INVALID');
  return { query, hits, page, requestedItemCode };
}

/**
 * Direct Rakuten Ichiba Web Service client. App ID/access key are injected in
 * memory; accessKey is sent only in its documented header. No browser or cookies.
 */
export function createRakutenIchibaClient({
  applicationId,
  accessKey,
  affiliateId,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  applicationId = validateApplicationId(applicationId);
  accessKey = validateAccessKey(accessKey);
  affiliateId = validateAffiliateId(affiliateId);
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') fail('CLIENT_CONFIGURATION_INVALID');

  async function request(path, query, capabilityId, sourceURL) {
    let result;
    try {
      result = await commerceJsonRequest({
        service: SERVICE,
        origin: ORIGIN,
        path,
        method: 'GET',
        query: [['applicationId', applicationId], ...query],
        accessToken: accessKey,
        authHeader: 'accessKey',
        fetchImpl,
        now,
        maxBytes: 4 * 1024 * 1024,
        timeoutMs: 15_000,
      });
    } catch (error) {
      const originalCode = typeof error?.code === 'string' ? error.code : 'RAKUTEN-ICHIBA_REQUEST_FAILED';
      const code = originalCode.replace(/^RAKUTEN-ICHIBA_/, 'RAKUTEN_ICHIBA_');
      throw Object.assign(new Error(code), { name: 'RakutenIchibaApiError', code, receipt: error?.receipt ?? {} });
    }
    if (isObject(result.payload) && result.payload.error) fail('API_RESPONSE_ERROR', result.request);
    return { ...result, capabilityId, sourceURL };
  }

  async function searchItemPage(params, capabilityId = 'catalog.search') {
    const validated = validateSearchParams(params);
    const activeAffiliateId = affiliateMode(params, affiliateId);
    if (activeAffiliateId !== undefined) validated.query.push(['affiliateId', activeAffiliateId]);
    const result = await request(ITEM_PATH, validated.query, capabilityId, ITEM_DOC);
    const payload = result.payload;
    if (!isObject(payload) || !Array.isArray(payload.items) || payload.items.length > validated.hits ||
        !safeNonnegative(payload.count) || payload.page !== validated.page || payload.hits !== validated.hits ||
        !Number.isSafeInteger(payload.pageCount) || payload.pageCount < 0 || payload.pageCount > 100) {
      fail('SEARCH_RESPONSE_SCHEMA_INVALID', result.request);
    }
    const products = payload.items.map(raw => normalizeItem(raw, {
      affiliateId: activeAffiliateId,
      requestedItemCode: validated.requestedItemCode,
    }));
    if (containsCredential(products, [applicationId, accessKey])) fail('RESPONSE_CONTAINS_CREDENTIAL', result.request);
    const pageCount = payload.pageCount;
    const hasNextPage = validated.page < pageCount && validated.page < 100;
    return {
      products,
      pagination: {
        count: payload.count,
        page: payload.page,
        pageCount,
        hits: payload.hits,
        hasNextPage,
        nextPage: hasNextPage ? validated.page + 1 : null,
      },
      receipt: makeReceipt(capabilityId, result.request, {
        itemCount: products.length,
        itemIdentityMatched: products.every(item => item.itemCode.startsWith(`${item.shopCode}:`)),
        priceCurrency: 'JPY',
        pageMatched: payload.page === validated.page,
      }),
    };
  }

  return Object.freeze({
    searchItems(params) {
      return searchItemPage(params);
    },

    async getItem({ itemCode, affiliateId: requestedAffiliateId } = {}) {
      const identity = parseItemCode(itemCode);
      const result = await searchItemPage({ itemCode: identity.itemCode, hits: 1, page: 1,
        ...(requestedAffiliateId === undefined ? {} : { affiliateId: requestedAffiliateId }) }, 'catalog.item_detail');
      if (result.products.length === 0) fail('ITEM_NOT_FOUND', result.receipt.request);
      if (result.products.length !== 1 || result.products[0].itemCode !== identity.itemCode ||
          result.products[0].shopCode !== identity.itemShopCode) fail('ITEM_IDENTITY_MISMATCH', result.receipt.request);
      return { ...result.products[0], receipt: result.receipt };
    },

    async getGenre({ genreId } = {}) {
      const id = typeof genreId === 'number' ? String(genreId) : genreId;
      if (typeof id !== 'string' || !/^\d{1,20}$/.test(id)) fail('GENRE_ID_INVALID');
      const result = await request(GENRE_PATH,
        [['format', 'json'], ['formatVersion', '2'], ['genreId', id]], 'catalog.genre_lookup', GENRE_DOC);
      const payload = result.payload;
      const data = sanitizeGenreData(payload);
      if (!isObject(payload) || !containsGenreRecord(data, id)) fail('GENRE_RESPONSE_SCHEMA_INVALID', result.request);
      if (containsCredential(data, [applicationId, accessKey])) fail('RESPONSE_CONTAINS_CREDENTIAL', result.request);
      return {
        genreId: id,
        data,
        receipt: {
          ...makeReceipt('catalog.genre_lookup', result.request, { requestedGenreIdMatched: true }),
          contractProvenance: { kind: 'first_party_documented_api', sourceURL: GENRE_DOC },
        },
      };
    },
  });
}

export const RAKUTEN_ICHIBA_CONTRACT = Object.freeze({
  itemSearch: { origin: ORIGIN, path: ITEM_PATH, version: '2026-07-01', method: 'GET' },
  genreSearch: { origin: ORIGIN, path: GENRE_PATH, version: '2026-07-01', method: 'GET' },
  applicationRegistration: APP_DOC,
});
