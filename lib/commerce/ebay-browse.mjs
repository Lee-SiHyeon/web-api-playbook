const API_ORIGIN = 'https://api.ebay.com';
const TOKEN_PATH = '/identity/v1/oauth2/token';
const SEARCH_PATH = '/buy/browse/v1/item_summary/search';
const ITEM_PATH = '/buy/browse/v1/item';
const ITEM_GROUP_PATH = '/buy/browse/v1/item/get_items_by_item_group';
const BROWSE_SCOPE = 'https://api.ebay.com/oauth/api_scope';
const FIXED_PRICE_FILTER = 'buyingOptions:{FIXED_PRICE}';
const MAX_API_BODY = 4 * 1024 * 1024;
const MAX_TOKEN_BODY = 32 * 1024;
const MAX_SEARCH_LIMIT = 200;
const MAX_SEARCH_OFFSET = 10_000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const REST_ITEM_ID = /^v1\|\d{1,30}\|\d{1,30}$/;
const MARKETPLACES = Object.freeze({
  EBAY_AT: { country: 'AT', currency: 'EUR', host: 'www.ebay.at' },
  EBAY_AU: { country: 'AU', currency: 'AUD', host: 'www.ebay.com.au' },
  EBAY_BE: { country: 'BE', currency: 'EUR', host: 'www.ebay.com.be' },
  EBAY_CA: { country: 'CA', currency: 'CAD', host: 'www.ebay.ca' },
  EBAY_CH: { country: 'CH', currency: 'CHF', host: 'www.ebay.ch' },
  EBAY_DE: { country: 'DE', currency: 'EUR', host: 'www.ebay.de' },
  EBAY_ES: { country: 'ES', currency: 'EUR', host: 'www.ebay.es' },
  EBAY_FR: { country: 'FR', currency: 'EUR', host: 'www.ebay.fr' },
  EBAY_GB: { country: 'GB', currency: 'GBP', host: 'www.ebay.co.uk' },
  EBAY_HK: { country: 'HK', currency: 'HKD', host: 'www.ebay.com.hk' },
  EBAY_IE: { country: 'IE', currency: 'EUR', host: 'www.ebay.ie' },
  EBAY_IT: { country: 'IT', currency: 'EUR', host: 'www.ebay.it' },
  EBAY_NL: { country: 'NL', currency: 'EUR', host: 'www.ebay.nl' },
  EBAY_PL: { country: 'PL', currency: 'PLN', host: 'www.ebay.pl' },
  EBAY_SG: { country: 'SG', currency: 'SGD', host: 'www.ebay.com.sg' },
  EBAY_US: { country: 'US', currency: 'USD', host: 'www.ebay.com' },
});
const SUPPORTED_CURRENCIES = new Set(Object.values(MARKETPLACES).map(entry => entry.currency));

export class EbayBrowseError extends Error {
  constructor(code, receipt = {}) {
    super(code);
    this.name = 'EbayBrowseError';
    this.code = code;
    this.receipt = receipt;
  }
}

const fail = (code, receipt) => { throw new EbayBrowseError(code, receipt); };
const safeText = (value, max = 1000) => typeof value === 'string' && value.length > 0 &&
  value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const safeRichText = (value, max) => typeof value === 'string' && value.length > 0 &&
  value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const validMarketplace = value => Object.hasOwn(MARKETPLACES, value);

function validateMarketplace(value) {
  if (!validMarketplace(value)) fail('EBAY_MARKETPLACE_UNSUPPORTED');
  return value;
}

function validateToken(value) {
  if (!safeText(value, 8192) || /\s/.test(value)) fail('EBAY_ACCESS_TOKEN_INVALID');
  return value;
}

async function readBounded(response, maxBytes, receipt) {
  if (!response.body?.getReader) fail('EBAY_RESPONSE_INVALID', receipt);
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
        fail('EBAY_RESPONSE_TOO_LARGE', { ...receipt, responseBytes: total });
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, total).toString('utf8');
}

function responseMime(response) {
  return response.headers?.get?.('content-type')?.split(';')[0]?.trim()?.toLowerCase() ?? null;
}

async function readJson(response, { maxBytes, receipt, acceptedMime = 'application/json' }) {
  const mime = responseMime(response);
  const current = { ...receipt, httpStatus: response.status, mime };
  if (response.status === 401) fail('EBAY_AUTH_REQUIRED', current);
  if (response.status === 403) fail('EBAY_ACCESS_DENIED', current);
  if (response.status === 429) fail('EBAY_RATE_LIMITED', current);
  if (response.status >= 500) fail('EBAY_UPSTREAM_FAILED', current);
  if (response.status !== 200 || mime !== acceptedMime || response.redirected) {
    fail('EBAY_RESPONSE_INVALID', current);
  }
  let raw;
  try { raw = await readBounded(response, maxBytes, current); }
  catch (error) {
    if (error instanceof EbayBrowseError) throw error;
    fail('EBAY_TRANSPORT_FAILED', current);
  }
  let payload;
  try { payload = JSON.parse(raw); }
  catch { fail('EBAY_RESPONSE_INVALID', { ...current, responseBytes: Buffer.byteLength(raw) }); }
  return { payload, receipt: { ...current, responseBytes: Buffer.byteLength(raw) } };
}

function validMoney(money, marketplaceId, label) {
  if (!object(money) || typeof money.value !== 'string' ||
      !/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/.test(money.value) ||
      typeof money.currency !== 'string' || !SUPPORTED_CURRENCIES.has(money.currency) ||
      money.currency !== MARKETPLACES[marketplaceId]?.currency) {
    fail('EBAY_MONEY_SCHEMA_INVALID', { field: label, marketplaceId });
  }
  const [wholeRaw, fractionRaw = ''] = money.value.split('.');
  const whole = BigInt(wholeRaw).toString();
  const fraction = fractionRaw.padEnd(2, '0');
  return { amount: `${whole}.${fraction}`, currency: money.currency, kind: 'retail_current' };
}

function officialItemUrl(value, marketplaceId) {
  if (!safeText(value, 2048)) fail('EBAY_ITEM_URL_INVALID', { marketplaceId });
  let url;
  try { url = new URL(value); }
  catch { fail('EBAY_ITEM_URL_INVALID', { marketplaceId }); }
  if (url.protocol !== 'https:' || url.hostname !== MARKETPLACES[marketplaceId].host ||
      url.username || url.password) fail('EBAY_ITEM_URL_INVALID', { marketplaceId });
  return url.href;
}

function trackedUrl(value, marketplaceId, campaignId) {
  if (!campaignId || typeof value !== 'string') return undefined;
  try {
    if (!safeText(value, 4096)) return undefined;
    const url = new URL(value);
    const marketHost = MARKETPLACES[marketplaceId].host;
    const marketDomain = marketHost.startsWith('www.') ? marketHost.slice(4) : marketHost;
    const affiliateHosts = new Set([marketHost, `rover.${marketDomain}`]);
    if (url.protocol !== 'https:' || !affiliateHosts.has(url.hostname) || url.username || url.password) return undefined;
    if (url.searchParams.get('campid') !== campaignId) return undefined;
    return url.href;
  } catch { return undefined; }
}

function optionalMoney(value, marketplaceId, label) {
  return value === undefined ? undefined : validMoney(value, marketplaceId, label);
}

function normalizeShippingOptions(value, marketplaceId) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 20) fail('EBAY_ITEM_SCHEMA_INVALID', { marketplaceId });
  return value.map((option, index) => {
    if (!object(option)) fail('EBAY_ITEM_SCHEMA_INVALID', { marketplaceId });
    const output = {};
    if (option.shippingCost !== undefined) {
      output.shippingCost = validMoney(option.shippingCost, marketplaceId, `shippingOptions[${index}].shippingCost`);
    }
    for (const key of ['shippingCostType', 'type', 'shippingServiceCode', 'minEstimatedDeliveryDate',
      'maxEstimatedDeliveryDate']) {
      if (option[key] !== undefined) {
        if (!safeText(option[key], 200)) fail('EBAY_ITEM_SCHEMA_INVALID', { marketplaceId });
        output[key] = option[key];
      }
    }
    return output;
  });
}

function normalizeImage(value, marketplaceId) {
  if (!object(value) || !safeText(value.imageUrl, 4096)) fail('EBAY_ITEM_SCHEMA_INVALID', { marketplaceId });
  let url;
  try { url = new URL(value.imageUrl); }
  catch { fail('EBAY_ITEM_SCHEMA_INVALID', { marketplaceId }); }
  const host = url.hostname.toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      !['ebayimg.com', 'ebaystatic.com'].some(domain => host === domain || host.endsWith(`.${domain}`))) {
    fail('EBAY_ITEM_SCHEMA_INVALID', { marketplaceId });
  }
  const image = { url: url.href };
  for (const dimension of ['width', 'height']) {
    if (value[dimension] !== undefined) {
      if (!Number.isSafeInteger(value[dimension]) || value[dimension] < 0 || value[dimension] > 20_000) {
        fail('EBAY_ITEM_SCHEMA_INVALID', { marketplaceId });
      }
      image[dimension] = value[dimension];
    }
  }
  return image;
}

function normalizeAspects(value, marketplaceId) {
  if (!Array.isArray(value) || value.length > 200) fail('EBAY_ITEM_SCHEMA_INVALID', { marketplaceId });
  return value.map(entry => {
    if (!object(entry) || !safeText(entry.name, 200) || !safeText(entry.value, 5000) ||
        entry.type !== undefined && !safeText(entry.type, 100)) fail('EBAY_ITEM_SCHEMA_INVALID', { marketplaceId });
    return { name: entry.name, value: entry.value, ...(entry.type === undefined ? {} : { type: entry.type }) };
  });
}

function normalizeProductReviewSummary(value, marketplaceId) {
  if (!object(value) || !['reviewCount', 'averageRating', 'ratingHistograms'].some(key => value[key] !== undefined) ||
      value.reviewCount !== undefined && (!Number.isSafeInteger(value.reviewCount) || value.reviewCount < 0) ||
      value.averageRating !== undefined && (typeof value.averageRating !== 'string' ||
        !/^(?:[0-4](?:\.\d{1,2})?|5(?:\.0{1,2})?)$/.test(value.averageRating)) ||
      value.ratingHistograms !== undefined && (!Array.isArray(value.ratingHistograms) || value.ratingHistograms.length > 5)) {
    fail('EBAY_ITEM_SCHEMA_INVALID', { marketplaceId });
  }
  const seen = new Set();
  const ratingHistograms = (value.ratingHistograms ?? []).map(entry => {
    if (!object(entry) || typeof entry.rating !== 'string' || !/^[1-5]$/.test(entry.rating) ||
        !Number.isSafeInteger(entry.count) || entry.count < 0 || seen.has(entry.rating)) {
      fail('EBAY_ITEM_SCHEMA_INVALID', { marketplaceId });
    }
    seen.add(entry.rating);
    return { rating: entry.rating, count: entry.count };
  });
  return { source: 'primaryProductReviewRating',
    ...(value.reviewCount === undefined ? {} : { reviewCount: value.reviewCount }),
    ...(value.averageRating === undefined ? {} : { averageRating: value.averageRating }),
    ...(value.ratingHistograms === undefined ? {} : { ratingHistograms }) };
}

function normalizeProductInfo(value, marketplaceId) {
  if (!object(value)) fail('EBAY_ITEM_SCHEMA_INVALID', { marketplaceId });
  const output = {};
  for (const key of ['title', 'description', 'brand']) {
    if (value[key] !== undefined) {
      if (!(key === 'description' ? safeRichText(value[key], 250_000) : safeText(value[key], 1000))) {
        fail('EBAY_ITEM_SCHEMA_INVALID', { marketplaceId });
      }
      output[key] = value[key];
    }
  }
  if (value.image !== undefined || value.additionalImages !== undefined) {
    if (value.additionalImages !== undefined && (!Array.isArray(value.additionalImages) || value.additionalImages.length > 40)) {
      fail('EBAY_ITEM_SCHEMA_INVALID', { marketplaceId });
    }
    output.images = [
      ...(value.image === undefined ? [] : [{ role: 'primary', ...normalizeImage(value.image, marketplaceId) }]),
      ...(value.additionalImages ?? []).map(image => ({ role: 'additional', ...normalizeImage(image, marketplaceId) })),
    ];
  }
  for (const key of ['gtins', 'mpns']) {
    if (value[key] !== undefined) {
      if (!Array.isArray(value[key]) || value[key].length > 40 ||
          value[key].some(identifier => !safeText(identifier, 100))) fail('EBAY_ITEM_SCHEMA_INVALID', { marketplaceId });
      output[key] = [...value[key]];
    }
  }
  if (value.aspectGroups !== undefined) {
    if (!Array.isArray(value.aspectGroups) || value.aspectGroups.length > 50) fail('EBAY_ITEM_SCHEMA_INVALID', { marketplaceId });
    output.aspectGroups = value.aspectGroups.map(group => {
      if (!object(group) || !safeText(group.localizedGroupName, 200) ||
          !Array.isArray(group.aspects) || group.aspects.length > 100) fail('EBAY_ITEM_SCHEMA_INVALID', { marketplaceId });
      return { name: group.localizedGroupName, aspects: group.aspects.map(aspect => {
        if (!object(aspect) || !safeText(aspect.localizedName, 200) ||
            !Array.isArray(aspect.localizedValues) || aspect.localizedValues.length > 50 ||
            aspect.localizedValues.some(value => !safeText(value, 5000))) fail('EBAY_ITEM_SCHEMA_INVALID', { marketplaceId });
        return { name: aspect.localizedName, values: [...aspect.localizedValues] };
      }) };
    });
  }
  if (value.additionalProductIdentities !== undefined) {
    if (!Array.isArray(value.additionalProductIdentities) || value.additionalProductIdentities.length > 50) {
      fail('EBAY_ITEM_SCHEMA_INVALID', { marketplaceId });
    }
    output.additionalProductIdentities = value.additionalProductIdentities.map(entry => {
      if (!object(entry) || !Array.isArray(entry.productIdentity) || entry.productIdentity.length > 50) {
        fail('EBAY_ITEM_SCHEMA_INVALID', { marketplaceId });
      }
      return { productIdentity: entry.productIdentity.map(identity => {
        if (!object(identity) || !safeText(identity.identifierType, 100) ||
            !safeText(identity.identifierValue, 500)) fail('EBAY_ITEM_SCHEMA_INVALID', { marketplaceId });
        return { type: identity.identifierType, value: identity.identifierValue };
      }) };
    });
  }
  return output;
}

function normalizeDetailFields(value, marketplaceId) {
  const output = {};
  for (const key of ['subtitle', 'shortDescription', 'description', 'brand', 'gtin', 'mpn', 'epid']) {
    if (value[key] !== undefined) {
      const valid = key === 'description' || key === 'shortDescription'
        ? safeRichText(value[key], key === 'description' ? 250_000 : 10_000)
        : safeText(value[key], 1000);
      if (!valid) {
        fail('EBAY_ITEM_SCHEMA_INVALID', { marketplaceId });
      }
      output[key] = value[key];
    }
  }
  if (value.legacyItemId !== undefined) {
    if (typeof value.legacyItemId !== 'string' || !/^\d{1,30}$/.test(value.legacyItemId)) {
      fail('EBAY_ITEM_SCHEMA_INVALID', { marketplaceId });
    }
    output.legacyItemId = value.legacyItemId;
  }
  if (value.categoryIdPath !== undefined) {
    if (!safeText(value.categoryIdPath, 500) || !/^\d{1,12}(?:\|\d{1,12}){0,19}$/.test(value.categoryIdPath)) {
      fail('EBAY_ITEM_SCHEMA_INVALID', { marketplaceId });
    }
    output.categoryIds = value.categoryIdPath.split('|');
    output.leafCategoryId = output.categoryIds.at(-1);
  }
  if (value.image !== undefined || value.additionalImages !== undefined) {
    if (value.additionalImages !== undefined && (!Array.isArray(value.additionalImages) || value.additionalImages.length > 40)) {
      fail('EBAY_ITEM_SCHEMA_INVALID', { marketplaceId });
    }
    output.images = [
      ...(value.image === undefined ? [] : [{ role: 'primary', ...normalizeImage(value.image, marketplaceId) }]),
      ...(value.additionalImages ?? []).map(image => ({ role: 'additional', ...normalizeImage(image, marketplaceId) })),
    ];
  }
  if (value.localizedAspects !== undefined) output.localizedAspects = normalizeAspects(value.localizedAspects, marketplaceId);
  if (value.primaryItemGroup !== undefined) {
    const group = value.primaryItemGroup;
    if (!object(group) || !safeText(group.itemGroupId, 100) || !/^\d+$/.test(group.itemGroupId) ||
        group.itemGroupType !== undefined && !safeText(group.itemGroupType, 100)) fail('EBAY_ITEM_SCHEMA_INVALID', { marketplaceId });
    output.variationGroup = { id: group.itemGroupId,
      ...(group.itemGroupType === undefined ? {} : { type: group.itemGroupType }),
      optionsComplete: false };
    if (group.itemGroupTitle !== undefined) {
      if (!safeText(group.itemGroupTitle, 1000)) fail('EBAY_ITEM_SCHEMA_INVALID', { marketplaceId });
      output.variationGroup.title = group.itemGroupTitle;
    }
    if (group.itemGroupImage !== undefined || group.itemGroupAdditionalImages !== undefined) {
      if (group.itemGroupAdditionalImages !== undefined &&
          (!Array.isArray(group.itemGroupAdditionalImages) || group.itemGroupAdditionalImages.length > 40)) {
        fail('EBAY_ITEM_SCHEMA_INVALID', { marketplaceId });
      }
      output.variationGroup.images = [
        ...(group.itemGroupImage === undefined ? [] : [{ role: 'primary', ...normalizeImage(group.itemGroupImage, marketplaceId) }]),
        ...(group.itemGroupAdditionalImages ?? []).map(image => ({ role: 'additional', ...normalizeImage(image, marketplaceId) })),
      ];
    }
  }
  if (value.primaryProductReviewRating !== undefined) {
    output.productReviewSummary = normalizeProductReviewSummary(value.primaryProductReviewRating, marketplaceId);
  }
  if (value.product !== undefined) output.product = normalizeProductInfo(value.product, marketplaceId);
  return output;
}

function normalizeItem(value, marketplaceId, { affiliateCampaignId, detail = false } = {}) {
  if (!object(value) || typeof value.itemId !== 'string' || !REST_ITEM_ID.test(value.itemId) || !safeText(value.title, 1000) ||
      !safeText(value.itemWebUrl, 2048)) {
    fail('EBAY_ITEM_SCHEMA_INVALID', { marketplaceId });
  }
  const price = optionalMoney(value.price, marketplaceId, 'price');
  const currentBidPrice = optionalMoney(value.currentBidPrice, marketplaceId, 'currentBidPrice');
  if (!price && !currentBidPrice) fail('EBAY_ITEM_PRICE_MISSING', { marketplaceId });
  const output = {
    itemId: value.itemId,
    title: value.title,
    itemWebUrl: officialItemUrl(value.itemWebUrl, marketplaceId),
    ...(price ? { price } : {}),
    ...(currentBidPrice ? { currentBidPrice } : {}),
    ...(value.shippingOptions !== undefined ? { shippingOptions: normalizeShippingOptions(value.shippingOptions, marketplaceId) } : {}),
  };
  if (value.categoryId !== undefined) {
    if (typeof value.categoryId !== 'string' || !/^\d{1,12}$/.test(value.categoryId)) {
      fail('EBAY_ITEM_SCHEMA_INVALID', { marketplaceId });
    }
    output.categoryId = value.categoryId;
  }
  if (value.categoryPath !== undefined) {
    if (!safeText(value.categoryPath, 1000)) fail('EBAY_ITEM_SCHEMA_INVALID', { marketplaceId });
    output.categoryPath = value.categoryPath;
  }
  if (value.categories !== undefined) {
    if (!Array.isArray(value.categories) || value.categories.length > 20 || value.categories.some(category =>
      !object(category) || typeof category.categoryId !== 'string' || !/^\d{1,12}$/.test(category.categoryId) ||
      !safeText(category.categoryName, 200))) {
      fail('EBAY_ITEM_SCHEMA_INVALID', { marketplaceId });
    }
    output.categories = value.categories.map(category => ({
      categoryId: category.categoryId, categoryName: category.categoryName,
    }));
  }
  if (value.condition !== undefined) {
    if (!safeText(value.condition, 200)) fail('EBAY_ITEM_SCHEMA_INVALID', { marketplaceId });
    output.condition = value.condition;
  }
  if (value.estimatedAvailabilityStatus !== undefined) {
    if (!['IN_STOCK', 'LIMITED_STOCK', 'OUT_OF_STOCK'].includes(value.estimatedAvailabilityStatus)) {
      fail('EBAY_ITEM_SCHEMA_INVALID', { marketplaceId });
    }
    output.estimatedAvailabilityStatus = value.estimatedAvailabilityStatus;
  }
  if (value.estimatedAvailabilities !== undefined) {
    if (!Array.isArray(value.estimatedAvailabilities) || value.estimatedAvailabilities.length > 20) {
      fail('EBAY_ITEM_SCHEMA_INVALID', { marketplaceId });
    }
    output.estimatedAvailabilities = value.estimatedAvailabilities.map(availability => {
      if (!object(availability) || !['IN_STOCK', 'LIMITED_STOCK', 'OUT_OF_STOCK']
        .includes(availability.estimatedAvailabilityStatus)) fail('EBAY_ITEM_SCHEMA_INVALID', { marketplaceId });
      const parsed = { estimatedAvailabilityStatus: availability.estimatedAvailabilityStatus };
      for (const key of ['estimatedAvailableQuantity', 'estimatedRemainingQuantity', 'estimatedSoldQuantity']) {
        if (availability[key] !== undefined) {
          if (!Number.isSafeInteger(availability[key]) || availability[key] < 0) {
            fail('EBAY_ITEM_SCHEMA_INVALID', { marketplaceId });
          }
          parsed[key] = availability[key];
        }
      }
      if (availability.availabilityThresholdType !== undefined) {
        if (!safeText(availability.availabilityThresholdType, 100)) fail('EBAY_ITEM_SCHEMA_INVALID', { marketplaceId });
        parsed.availabilityThresholdType = availability.availabilityThresholdType;
      }
      if (availability.availabilityThreshold !== undefined) {
        if (!Number.isSafeInteger(availability.availabilityThreshold) || availability.availabilityThreshold < 0) {
          fail('EBAY_ITEM_SCHEMA_INVALID', { marketplaceId });
        }
        parsed.availabilityThreshold = availability.availabilityThreshold;
      }
      return parsed;
    });
  }
  if (detail) Object.assign(output, normalizeDetailFields(value, marketplaceId));
  const affiliateUrl = trackedUrl(value.itemAffiliateWebUrl, marketplaceId, affiliateCampaignId);
  if (affiliateUrl) output.itemAffiliateWebUrl = affiliateUrl;
  // The API's price and shippingCost remain separate. This client never synthesizes an
  // all-in amount because delivery destination, quantity, and tax context vary.
  return output;
}

function searchLinkMatches(value, { query, limit, offset, categoryId, marketplaceId }) {
  if (!safeText(value, 4096)) return false;
  try {
    const url = new URL(value);
    if (url.origin !== API_ORIGIN || url.pathname !== SEARCH_PATH || url.username || url.password) return false;
    const params = url.searchParams;
    if (params.get('q') !== query || Number(params.get('limit')) !== limit ||
        Number(params.get('offset')) !== offset ||
        params.get('filter') !== FIXED_PRICE_FILTER ||
        (categoryId ? params.get('category_ids') !== categoryId : params.has('category_ids'))) return false;
    // Marketplace is sent as a header, not part of this URL. Reject duplicate critical keys.
    for (const key of ['q', 'limit', 'offset', 'filter', 'category_ids']) {
      if (params.getAll(key).length > 1) return false;
    }
    return validMarketplace(marketplaceId);
  } catch { return false; }
}

function parseNextOffset(value, expected) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') fail('EBAY_PAGINATION_INVALID', { marketplaceId: expected.marketplaceId });
  try {
    const url = new URL(value);
    if (url.origin !== API_ORIGIN || url.pathname !== SEARCH_PATH ||
        url.searchParams.get('q') !== expected.query || Number(url.searchParams.get('limit')) !== expected.limit ||
        url.searchParams.get('filter') !== FIXED_PRICE_FILTER ||
        Number(url.searchParams.get('offset')) % expected.limit !== 0 ||
        (expected.categoryId ? url.searchParams.get('category_ids') !== expected.categoryId :
          url.searchParams.has('category_ids')) ||
        !['q', 'limit', 'offset', 'filter', 'category_ids'].every(key => url.searchParams.getAll(key).length <= 1)) {
      fail('EBAY_PAGINATION_INVALID', { marketplaceId: expected.marketplaceId });
    }
    const nextOffset = Number(url.searchParams.get('offset'));
    if (!Number.isSafeInteger(nextOffset) || nextOffset !== expected.offset + expected.limit ||
        nextOffset >= MAX_SEARCH_OFFSET || nextOffset > expected.offset + MAX_SEARCH_LIMIT) {
      fail('EBAY_PAGINATION_INVALID', { marketplaceId: expected.marketplaceId });
    }
    return nextOffset;
  } catch (error) {
    if (error instanceof EbayBrowseError) throw error;
    fail('EBAY_PAGINATION_INVALID', { marketplaceId: expected.marketplaceId });
  }
}

function validateSearch(payload, request) {
  const { query, limit, offset, categoryId, marketplaceId } = request;
  if (!object(payload) || !Number.isSafeInteger(payload.total) || payload.total < 0 ||
      payload.limit !== limit || payload.offset !== offset || !Array.isArray(payload.itemSummaries) ||
      payload.itemSummaries.length > limit || !searchLinkMatches(payload.href, request)) {
    fail('EBAY_SEARCH_SCHEMA_INVALID', { marketplaceId });
  }
  const items = payload.itemSummaries.map(item => normalizeItem(item, marketplaceId, request));
  const ids = new Set();
  for (const item of items) {
    if (ids.has(item.itemId)) fail('EBAY_SEARCH_SCHEMA_INVALID', { marketplaceId });
    ids.add(item.itemId);
  }
  const nextOffset = parseNextOffset(payload.next, request);
  if (nextOffset !== null && nextOffset <= offset) fail('EBAY_PAGINATION_INVALID', { marketplaceId });
  const categorySuggestions = payload.categorySuggestions;
  if (categorySuggestions !== undefined && (!Array.isArray(categorySuggestions) || categorySuggestions.length > 100 ||
      categorySuggestions.some(item => !object(item) || typeof item.category?.categoryId !== 'string' ||
        !/^\d{1,12}$/.test(item.category.categoryId) ||
        !safeText(item.category?.categoryName, 200)))) fail('EBAY_SEARCH_SCHEMA_INVALID', { marketplaceId });
  const categories = (categorySuggestions ?? []).map(item => ({
    categoryId: item.category.categoryId, categoryName: item.category.categoryName,
  }));
  return { items, categories, pagination: { total: payload.total, limit, offset, nextOffset } };
}

function normalizeItemGroup(payload, itemGroupId, marketplaceId, affiliateCampaignId) {
  if (!object(payload) || !Array.isArray(payload.items) || payload.items.length < 1 ||
      payload.items.length > 1000 || payload.commonDescriptions !== undefined &&
      (!Array.isArray(payload.commonDescriptions) || payload.commonDescriptions.length > 1000) ||
      payload.warnings !== undefined && (!Array.isArray(payload.warnings) || payload.warnings.length > 100 ||
        payload.warnings.some(warning => !object(warning)))) {
    fail('EBAY_ITEM_GROUP_SCHEMA_INVALID', { marketplaceId });
  }
  const items = payload.items.map(source => {
    const sourceGroupId = source?.primaryItemGroup?.itemGroupId ?? source?.primaryItemGroupId;
    if (sourceGroupId !== itemGroupId) fail('EBAY_ITEM_GROUP_ID_MISMATCH', { marketplaceId });
    return normalizeItem(source, marketplaceId, { affiliateCampaignId, detail: true });
  });
  const byId = new Map(items.map(item => [item.itemId, item]));
  if (byId.size !== items.length) fail('EBAY_ITEM_GROUP_SCHEMA_INVALID', { marketplaceId });
  let descriptionMappings = 0;
  for (const common of payload.commonDescriptions ?? []) {
    if (!object(common) || !safeRichText(common.description, 250_000) ||
        !Array.isArray(common.itemIds) || common.itemIds.length < 1 || common.itemIds.length > 1000) {
      fail('EBAY_ITEM_GROUP_SCHEMA_INVALID', { marketplaceId });
    }
    for (const itemId of common.itemIds) {
      const item = byId.get(itemId);
      if (!item || item.description !== undefined && item.description !== common.description) {
        fail('EBAY_ITEM_GROUP_SCHEMA_INVALID', { marketplaceId });
      }
      if (item.description === undefined) {
        item.description = common.description;
        descriptionMappings++;
      }
    }
  }
  return { items, descriptionMappings, warningCount: payload.warnings?.length ?? 0 };
}

function validateSearchInput({ query, limit = 20, offset = 0, categoryId, marketplaceId }) {
  if (!safeText(query, 1000) || query.trim().length === 0 || query.trim().length !== query.length ||
      !Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT ||
      !Number.isInteger(offset) || offset < 0 || offset >= MAX_SEARCH_OFFSET || offset % limit !== 0 ||
      categoryId !== undefined && (typeof categoryId !== 'string' || !/^\d{1,12}$/.test(categoryId))) {
    fail('EBAY_SEARCH_INPUT_INVALID');
  }
  validateMarketplace(marketplaceId);
  return { query, limit, offset, categoryId, marketplaceId };
}

export async function acquireEbayAppToken({ clientId, clientSecret, fetchImpl = globalThis.fetch,
  now = Date.now } = {}) {
  if (!safeText(clientId, 1024) || !safeText(clientSecret, 2048) ||
      typeof fetchImpl !== 'function' || typeof now !== 'function') fail('EBAY_OAUTH_INPUT_INVALID');
  const receipt = { method: 'POST', origin: API_ORIGIN, path: TOKEN_PATH,
    queryFields: [], browserUsed: false, credentialsUsed: true, checkedAt: new Date(now()).toISOString() };
  const body = new URLSearchParams({ grant_type: 'client_credentials', scope: BROWSE_SCOPE }).toString();
  let response;
  try {
    response = await fetchImpl(new URL(TOKEN_PATH, API_ORIGIN), {
      method: 'POST', redirect: 'manual', credentials: 'omit',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}` },
      body, signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    fail('EBAY_OAUTH_TRANSPORT_FAILED', { ...receipt,
      causeCode: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'TRANSPORT_ERROR' });
  }
  const { payload, receipt: checked } = await readJson(response, { maxBytes: MAX_TOKEN_BODY, receipt });
  if (!object(payload) || !safeText(payload.access_token, 8192) || /\s/.test(payload.access_token) ||
      !Number.isSafeInteger(payload.expires_in) || payload.expires_in < 60 ||
      !safeText(payload.token_type, 100)) fail('EBAY_OAUTH_SCHEMA_INVALID', checked);
  return { accessToken: payload.access_token, tokenType: payload.token_type, expiresIn: payload.expires_in,
    issuedAt: new Date(now()).toISOString(), receipt: { ...checked, accessTokenPersisted: false } };
}

export function createEbayBrowseClient({ accessToken, marketplaceId = 'EBAY_US', affiliateCampaignId,
  affiliateReferenceId, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const bearer = validateToken(accessToken);
  const defaultMarketplace = validateMarketplace(marketplaceId);
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') fail('EBAY_CLIENT_INVALID');
  if (affiliateCampaignId !== undefined && !/^\d{10}$/.test(affiliateCampaignId)) {
    fail('EBAY_AFFILIATE_CAMPAIGN_INVALID');
  }
  if (affiliateReferenceId !== undefined && (!affiliateCampaignId ||
      !/^[A-Za-z0-9._~:-]{1,256}$/.test(affiliateReferenceId))) {
    fail('EBAY_AFFILIATE_REFERENCE_INVALID');
  }

  const requestHeaders = targetMarketplace => {
    const headers = { accept: 'application/json', authorization: `Bearer ${bearer}`,
      'x-ebay-c-marketplace-id': targetMarketplace };
    if (affiliateCampaignId) headers['x-ebay-c-enduserctx'] =
      `affiliateCampaignId=${affiliateCampaignId}${affiliateReferenceId ? `,affiliateReferenceId=${affiliateReferenceId}` : ''}`;
    return headers;
  };

  async function get(path, targetMarketplace, queryFields, capabilityId) {
    const url = new URL(path, API_ORIGIN);
    if (queryFields) for (const [key, value] of queryFields) url.searchParams.append(key, value);
    const checkedAt = new Date(now()).toISOString();
    const receipt = { schema: 'web-api-credentialed-read-receipt-v1', service: 'ebay-partner', capabilityId,
      checkedAt, secretsPersistedInEvidence: false,
      contractProvenance: { kind: 'first_party_documented_api', sourceURL: capabilityId === 'catalog.search' ?
        'https://developer.ebay.com/api-docs/buy/browse/resources/item_summary/methods/search' :
        capabilityId === 'catalog.variation_group' ?
          'https://developer.ebay.com/api-docs/buy/browse/resources/item/methods/getItemsByItemGroup' :
          'https://developer.ebay.com/api-docs/buy/browse/resources/item/methods/getItem' },
    };
    const requestReceipt = {
      method: 'GET', origin: API_ORIGIN, path: url.pathname, queryFields: [...url.searchParams.keys()],
      marketplaceId: targetMarketplace, browserUsed: false, credentialsUsed: true,
      authorizationHeaderSent: true, checkedAt,
    };
    let response;
    try {
      response = await fetchImpl(url, { method: 'GET', redirect: 'manual', credentials: 'omit',
        headers: requestHeaders(targetMarketplace), signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      fail('EBAY_TRANSPORT_FAILED', { ...receipt, request: requestReceipt,
        causeCode: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'TRANSPORT_ERROR' });
    }
    try {
      const result = await readJson(response, { maxBytes: MAX_API_BODY, receipt: requestReceipt });
      return { payload: result.payload, receipt: { ...receipt, authenticated: true,
        request: result.receipt } };
    } catch (error) {
      if (error instanceof EbayBrowseError) error.receipt = { ...receipt, request: error.receipt };
      throw error;
    }
  }

  return Object.freeze({
    async searchItems({ query, limit = 20, offset = 0, categoryId, marketplaceId: requestedMarketplace } = {}) {
      const selectedMarketplace = requestedMarketplace ?? defaultMarketplace;
      const input = validateSearchInput({ query, limit, offset, categoryId, marketplaceId: selectedMarketplace });
      const params = [['q', input.query], ['limit', String(input.limit)], ['offset', String(input.offset)],
        ['filter', FIXED_PRICE_FILTER]];
      if (input.categoryId) params.push(['category_ids', input.categoryId]);
      const { payload, receipt } = await get(SEARCH_PATH, input.marketplaceId, params, 'catalog.search');
      const normalized = validateSearch(payload, { ...input, affiliateCampaignId });
      return { ...normalized, marketplaceId: input.marketplaceId,
        receipt: { ...receipt, credentialsUsed: true, credentialBindingVerified: true,
          credentialBinding: { source: 'process-memory', serviceMatched: true, originMatched: true, persisted: false },
          schemaVerified: true, expectedResultVerified: true, itemCount: normalized.items.length,
          queryMatched: true, paginationVerified: true, priceCurrencySet: [...new Set(normalized.items.flatMap(item =>
            [item.price?.currency, item.currentBidPrice?.currency].filter(Boolean)))].sort() } };
    },
    async getItem({ itemId, marketplaceId: requestedMarketplace } = {}) {
      const selectedMarketplace = requestedMarketplace ?? defaultMarketplace;
      validateMarketplace(selectedMarketplace);
      if (typeof itemId !== 'string' || !REST_ITEM_ID.test(itemId)) fail('EBAY_ITEM_ID_INVALID');
      const path = `${ITEM_PATH}/${encodeURIComponent(itemId)}`;
      const { payload, receipt } = await get(path, selectedMarketplace, [['fieldgroups', 'PRODUCT']], 'catalog.item_detail');
      if (!object(payload) || payload.itemId !== itemId) fail('EBAY_ITEM_SCHEMA_INVALID', receipt);
      const item = normalizeItem(payload, selectedMarketplace, { affiliateCampaignId, detail: true });
      return { item, marketplaceId: selectedMarketplace,
        receipt: { ...receipt, credentialsUsed: true, credentialBindingVerified: true,
          credentialBinding: { source: 'process-memory', serviceMatched: true, originMatched: true, persisted: false },
          schemaVerified: true, expectedResultVerified: true, itemIdMatched: true, priceCurrencySet:
          [...new Set([item.price?.currency, item.currentBidPrice?.currency].filter(Boolean))].sort(),
          shippingCostCount: item.shippingOptions?.filter(option => option.shippingCost).length ?? 0,
          productFieldgroupRequested: true, productContainerReturned: item.product !== undefined,
          productReviewSummaryReturned: item.productReviewSummary !== undefined } };
    },
    async getItemGroup({ itemGroupId, marketplaceId: requestedMarketplace } = {}) {
      const selectedMarketplace = requestedMarketplace ?? defaultMarketplace;
      validateMarketplace(selectedMarketplace);
      if (typeof itemGroupId !== 'string' || !/^\d{1,30}$/.test(itemGroupId)) fail('EBAY_ITEM_GROUP_ID_INVALID');
      const { payload, receipt } = await get(ITEM_GROUP_PATH, selectedMarketplace,
        [['item_group_id', itemGroupId]], 'catalog.variation_group');
      const group = normalizeItemGroup(payload, itemGroupId, selectedMarketplace, affiliateCampaignId);
      return { itemGroupId, items: group.items, marketplaceId: selectedMarketplace,
        receipt: { ...receipt, credentialsUsed: true, credentialBindingVerified: true,
          credentialBinding: { source: 'process-memory', serviceMatched: true, originMatched: true, persisted: false },
          schemaVerified: true, expectedResultVerified: true, itemGroupIdMatched: true,
          itemCount: group.items.length, descriptionMappings: group.descriptionMappings,
          warningCount: group.warningCount } };
    },
  });
}

export const ebayBrowseContract = Object.freeze({
  apiOrigin: API_ORIGIN,
  tokenPath: TOKEN_PATH,
  searchPath: SEARCH_PATH,
  itemPath: ITEM_PATH,
  itemGroupPath: ITEM_GROUP_PATH,
  browseScope: BROWSE_SCOPE,
  maxSearchLimit: MAX_SEARCH_LIMIT,
  maxSearchOffset: MAX_SEARCH_OFFSET,
  marketplaces: MARKETPLACES,
});
