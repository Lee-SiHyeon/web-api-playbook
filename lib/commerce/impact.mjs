import { createHash } from 'node:crypto';

const API_ORIGIN = 'https://api.impact.com';
const CONTRACT_URL = 'https://integrations.impact.com/partner-api-reference/reference/catalogs/catalogs';
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const MAX_PAGE_SIZE = 1_000;
const MAX_LIST_ITEMS = 10_000;
const MAX_STRING = 100_000;
const SID = /^[A-Za-z0-9_-]{1,128}$/;
const ISO_CURRENCY = /^[A-Z]{3}$/;
const DECIMAL = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/;

export class ImpactPartnerCatalogError extends Error {
  constructor(code, receipt = {}) {
    super(code);
    this.name = 'ImpactPartnerCatalogError';
    this.code = code;
    this.receipt = receipt;
  }
}

const fail = (code, receipt = {}) => { throw new ImpactPartnerCatalogError(code, receipt); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const cleanText = (value, max = MAX_STRING) => typeof value === 'string' && value.length > 0 &&
  value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const optionalText = (value, max = MAX_STRING) => value === undefined || value === null || cleanText(value, max);
const optionalMoney = value => value === undefined || value === null || decimal(value) !== null;

function mimeOf(response) {
  return response.headers?.get?.('content-type')?.split(';')[0]?.trim()?.toLowerCase() ?? null;
}

async function readBoundedText(response, maxBytes, receipt) {
  if (!response.body?.getReader) fail('IMPACT_RESPONSE_INVALID', receipt);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        fail('IMPACT_RESPONSE_TOO_LARGE', { ...receipt, responseBytes: total });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

function urlOrNull(value) {
  if (typeof value !== 'string' || value.length > 8_192) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return url.toString();
  } catch { return null; }
}

function decimal(value) {
  let normalized = value;
  if (typeof normalized === 'number') {
    if (!Number.isFinite(normalized) || normalized < 0) return null;
    normalized = String(normalized);
  }
  if (typeof normalized !== 'string' || normalized.length > 64) return null;
  const result = normalized.trim();
  return DECIMAL.test(result) ? result : null;
}

function availabilityOf(value) {
  switch (String(value ?? '').toLowerCase()) {
    case 'instock':
    case 'limitedavailability': return 'available';
    case 'outofstock': return 'unavailable';
    default: return 'unknown';
  }
}

function normalizeItem(item, checkedAt, { expectedCatalogId = null } = {}) {
  if (!object(item) || !cleanText(item.Id, 512) || !cleanText(item.Name, 2_000) ||
      !optionalText(item.CatalogId, 256) || !optionalText(item.CatalogItemId, 512) ||
      !optionalText(item.CampaignId, 256) || !optionalText(item.CampaignName, 1_000) ||
      !optionalText(item.Manufacturer, 1_000) || !optionalText(item.Description, 100_000) ||
      !optionalText(item.StockAvailability, 128) || !optionalText(item.Currency, 16) ||
      !optionalMoney(item.CurrentPrice) || !optionalMoney(item.OriginalPrice) ||
      !optionalText(item.DiscountPercentage, 64) || !optionalText(item.ItemGroupId, 512) ||
      !optionalText(item.Asin, 128) || !optionalText(item.Gtin, 128) || !optionalText(item.Mpn, 128) ||
      !optionalText(item.Category, 2_000) ||
      (item.Currency !== undefined && item.Currency !== null &&
        (typeof item.Currency !== 'string' || !ISO_CURRENCY.test(item.Currency)))) {
    fail('IMPACT_ITEM_SCHEMA_INVALID');
  }
  if (expectedCatalogId !== null && item.CatalogId !== undefined && String(item.CatalogId) !== expectedCatalogId) {
    fail('IMPACT_CATALOG_ID_MISMATCH');
  }
  if (item.Bullets !== undefined && (!Array.isArray(item.Bullets) || item.Bullets.length > 100 ||
      item.Bullets.some(value => !cleanText(value, 5_000)))) fail('IMPACT_ITEM_SCHEMA_INVALID');
  if (item.Labels !== undefined && (!Array.isArray(item.Labels) || item.Labels.length > 500 ||
      item.Labels.some(value => !cleanText(value, 1_000)))) fail('IMPACT_ITEM_SCHEMA_INVALID');

  const amount = decimal(item.CurrentPrice);
  const currency = typeof item.Currency === 'string' && ISO_CURRENCY.test(item.Currency) ? item.Currency : null;
  const price = amount !== null && currency !== null
    ? { amount, currency, kind: 'retail_current' }
    : { amount: null, currency, kind: 'unknown' };
  const originalAmount = decimal(item.OriginalPrice);
  const originalPrice = originalAmount !== null && currency !== null
    ? { amount: originalAmount, currency, kind: 'retail_list' }
    : null;
  const catalogId = typeof item.CatalogId === 'string' ? item.CatalogId : expectedCatalogId;
  return {
    provider: 'impact',
    productId: item.Id,
    variantId: typeof item.ItemGroupId === 'string' && item.ItemGroupId ? item.ItemGroupId : null,
    title: item.Name,
    url: urlOrNull(item.Url),
    imageUrl: urlOrNull(item.ImageUrl),
    price,
    ...(originalPrice ? { listPrice: originalPrice } : {}),
    availability: availabilityOf(item.StockAvailability),
    observedAt: checkedAt,
    source: {
      network: 'impact',
      catalogId,
      catalogItemId: item.CatalogItemId ?? null,
      campaignId: item.CampaignId ?? null,
      campaignName: item.CampaignName ?? null,
      ...(item.Manufacturer ? { manufacturer: item.Manufacturer } : {}),
      ...(item.Category ? { category: item.Category } : {}),
      ...(item.Description ? { description: item.Description } : {}),
      ...(item.Bullets ? { bullets: item.Bullets } : {}),
      ...(item.Labels ? { labels: item.Labels } : {}),
      ...(item.StockAvailability ? { stockAvailability: item.StockAvailability } : {}),
      ...(item.DiscountPercentage !== undefined ? { discountPercentage: item.DiscountPercentage } : {}),
      ...(item.Asin ? { asin: item.Asin } : {}),
      ...(item.Gtin ? { gtin: item.Gtin } : {}),
      ...(item.Mpn ? { mpn: item.Mpn } : {}),
    },
  };
}

function normalizeCatalog(catalog) {
  if (!object(catalog) || !cleanText(String(catalog.Id ?? ''), 256) || !cleanText(catalog.Name, 2_000) ||
      !optionalText(catalog.Language, 64) || !optionalText(catalog.AdvertiserId, 256) ||
      !optionalText(catalog.AdvertiserName, 2_000) || !optionalText(catalog.CampaignId, 256) ||
      !optionalText(catalog.CampaignName, 2_000) || !optionalText(catalog.Currency, 16) ||
      !optionalText(catalog.DateLastUpdated, 128) || !optionalText(catalog.ServiceAreas, 5_000)) {
    fail('IMPACT_CATALOG_SCHEMA_INVALID');
  }
  const itemCount = Number(catalog.NumberOfItems);
  return {
    id: String(catalog.Id),
    name: catalog.Name,
    ...(catalog.Language ? { language: catalog.Language } : {}),
    ...(catalog.AdvertiserId ? { advertiserId: String(catalog.AdvertiserId) } : {}),
    ...(catalog.AdvertiserName ? { advertiserName: catalog.AdvertiserName } : {}),
    ...(catalog.CampaignId ? { campaignId: String(catalog.CampaignId) } : {}),
    ...(catalog.CampaignName ? { campaignName: catalog.CampaignName } : {}),
    ...(Number.isSafeInteger(itemCount) && itemCount >= 0 ? { itemCount } : {}),
    ...(catalog.Currency && ISO_CURRENCY.test(catalog.Currency) ? { currency: catalog.Currency } : {}),
    ...(catalog.DateLastUpdated ? { lastUpdatedAt: catalog.DateLastUpdated } : {}),
    ...(catalog.ServiceAreas ? { serviceAreas: catalog.ServiceAreas } : {}),
    // Locations and FTPLocations are deliberately omitted: download paths may
    // be private, and Impact documents FTPLocations as containing credentials.
  };
}

function safeCheckedAt(now) {
  let instant;
  try { instant = new Date(now()); } catch { fail('IMPACT_CLOCK_INVALID'); }
  if (!Number.isFinite(instant.getTime())) fail('IMPACT_CLOCK_INVALID');
  return instant.toISOString();
}

function validateQueryText(value, code, max = 2_000) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail(code);
  return value;
}

function validatePage(page, pageSize) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 100_000 ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) fail('IMPACT_PAGE_INVALID');
  return { page, pageSize };
}

function pathSegment(value, code, max = 512) {
  if (typeof value !== 'string' || !value || value.length > max || /[\x00-\x20\x7f/\\?#]/.test(value)) fail(code);
  return encodeURIComponent(value);
}

export function createImpactPartnerCatalogClient({ accountSid, authToken, fetchImpl = globalThis.fetch, now = Date.now,
  timeoutMs = 30_000, maxResponseBytes = MAX_JSON_BYTES } = {}) {
  if (typeof accountSid !== 'string' || !SID.test(accountSid)) fail('IMPACT_ACCOUNT_SID_INVALID');
  if (typeof authToken !== 'string' || !authToken || authToken.length > 16_384 || /[\r\n\0]/.test(authToken)) {
    fail('IMPACT_AUTH_TOKEN_REQUIRED');
  }
  if (typeof fetchImpl !== 'function' || typeof now !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000 ||
      !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > MAX_JSON_BYTES) {
    fail('IMPACT_CLIENT_OPTIONS_INVALID');
  }

  const authorization = `Basic ${Buffer.from(`${accountSid}:${authToken}`, 'utf8').toString('base64')}`;

  async function getJson(path, params, capabilityId) {
    const url = new URL(path, API_ORIGIN);
    const queryFields = [];
    for (const [name, value] of Object.entries(params ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(name, String(value));
      queryFields.push(name);
    }
    const checkedAt = safeCheckedAt(now);
    const requestBase = { method: 'GET', origin: API_ORIGIN, path, checkedAt,
      browserUsed: false, credentialsUsed: true, authScheme: 'basic', queryFields };
    const baseReceipt = {
      schema: 'web-api-credentialed-read-receipt-v1', service: 'impact', capabilityId, checkedAt,
      secretsPersistedInEvidence: false, authenticated: true, credentialsUsed: true,
      credentialBindingVerified: true,
      credentialBinding: { source: 'process-memory', serviceMatched: true, originMatched: true, persisted: false },
      contractProvenance: { kind: 'first_party_documented_api', sourceURL: CONTRACT_URL },
    };
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET', redirect: 'manual', credentials: 'omit',
        headers: { accept: 'application/json', authorization },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const causeCode = error?.name === 'TimeoutError' ? 'TIMEOUT' : 'TRANSPORT_ERROR';
      fail('IMPACT_TRANSPORT_FAILED', { ...baseReceipt, request: { ...requestBase, causeCode } });
    }
    const mime = mimeOf(response);
    const request = { ...requestBase, httpStatus: response.status, mime };
    if (response.status === 401) fail('IMPACT_AUTH_REQUIRED', { ...baseReceipt, request });
    if (response.status === 403) fail('IMPACT_SCOPE_DENIED', { ...baseReceipt, request });
    if (response.status === 404) fail('IMPACT_RESOURCE_NOT_FOUND', { ...baseReceipt, request });
    if (response.status === 429) fail('IMPACT_THROTTLED', { ...baseReceipt, request });
    if (response.status !== 200 || response.redirected || mime !== 'application/json') {
      fail('IMPACT_RESPONSE_INVALID', { ...baseReceipt, request });
    }
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maxResponseBytes) {
      fail('IMPACT_RESPONSE_TOO_LARGE', { ...baseReceipt, request: { ...request, responseBytes: declared } });
    }
    let raw;
    try { raw = await readBoundedText(response, maxResponseBytes, { ...baseReceipt, request }); }
    catch (error) {
      if (error instanceof ImpactPartnerCatalogError) throw error;
      fail('IMPACT_TRANSPORT_FAILED', { ...baseReceipt, request });
    }
    const responseBytes = Buffer.byteLength(raw, 'utf8');
    let payload;
    try { payload = JSON.parse(raw); }
    catch { fail('IMPACT_JSON_INVALID', { ...baseReceipt, request: { ...request, responseBytes } }); }
    if (!object(payload)) fail('IMPACT_RESPONSE_SCHEMA_INVALID', { ...baseReceipt,
      request: { ...request, responseBytes } });
    const responseSha256 = createHash('sha256').update(raw, 'utf8').digest('hex');
    return {
      payload,
      receipt: {
        ...baseReceipt,
        schemaVerified: false,
        expectedResultVerified: false,
        request: { ...request, responseBytes, responseSha256 },
      },
    };
  }

  function completeReceipt(base, { schemaVerified, expectedResultVerified, matchedProductId = null } = {}) {
    return { ...base, schemaVerified, expectedResultVerified,
      ...(matchedProductId !== null ? { productIdMatched: true } : {}) };
  }

  async function searchProducts({ keyword, page = 1, pageSize = 100, query } = {}) {
    const paging = validatePage(page, pageSize);
    const searchKeyword = validateQueryText(keyword, 'IMPACT_KEYWORD_INVALID', 500);
    const filter = validateQueryText(query, 'IMPACT_FILTER_INVALID');
    const path = `/Mediapartners/${pathSegment(accountSid, 'IMPACT_ACCOUNT_SID_INVALID')}/Catalogs/ItemSearch`;
    const call = await getJson(path, { Keyword: searchKeyword, PageSize: paging.pageSize, Page: paging.page, Query: filter }, 'catalog.search');
    const rows = call.payload.Items;
    if (!Array.isArray(rows) || rows.length > paging.pageSize || rows.some(row => !object(row))) {
      fail('IMPACT_SEARCH_SCHEMA_INVALID', call.receipt);
    }
    const items = rows.map(row => normalizeItem(row, call.receipt.checkedAt));
    const queryHash = searchKeyword ? createHash('sha256').update(searchKeyword.toLowerCase()).digest('hex') : null;
    return {
      provider: 'impact',
      items,
      page: { page: paging.page, pageSize: paging.pageSize,
        hasMore: rows.length === paging.pageSize ? 'possible' : 'unknown' },
      receipt: completeReceipt(call.receipt, { schemaVerified: true, expectedResultVerified: true }),
      ...(queryHash ? { querySha256: queryHash } : {}),
    };
  }

  async function getProduct({ catalogId, productId } = {}) {
    const catalog = pathSegment(catalogId, 'IMPACT_CATALOG_ID_INVALID');
    const id = pathSegment(productId, 'IMPACT_PRODUCT_ID_INVALID');
    const path = `/Mediapartners/${pathSegment(accountSid, 'IMPACT_ACCOUNT_SID_INVALID')}/Catalogs/${catalog}/Items/${id}`;
    const call = await getJson(path, {}, 'catalog.product_detail');
    const item = normalizeItem(call.payload, call.receipt.checkedAt, { expectedCatalogId: catalogId });
    if (item.productId !== productId) fail('IMPACT_PRODUCT_ID_MISMATCH', call.receipt);
    return { provider: 'impact', item,
      receipt: completeReceipt(call.receipt, { schemaVerified: true, expectedResultVerified: true, matchedProductId: productId }) };
  }

  async function listCatalogs({ campaignId } = {}) {
    const campaign = campaignId === undefined || campaignId === null ? undefined : String(campaignId);
    if (campaign !== undefined && !/^\d{1,20}$/.test(campaign)) fail('IMPACT_CAMPAIGN_ID_INVALID');
    const path = `/Mediapartners/${pathSegment(accountSid, 'IMPACT_ACCOUNT_SID_INVALID')}/Catalogs`;
    const call = await getJson(path, { CampaignId: campaign }, 'catalog.list');
    const rows = call.payload.Catalogs;
    if (!Array.isArray(rows) || rows.length > MAX_LIST_ITEMS || rows.some(row => !object(row))) {
      fail('IMPACT_CATALOG_LIST_SCHEMA_INVALID', call.receipt);
    }
    const catalogs = rows.map(normalizeCatalog);
    return { provider: 'impact', catalogs,
      receipt: completeReceipt(call.receipt, { schemaVerified: true, expectedResultVerified: true }) };
  }

  async function listCatalogItems({ catalogId, query } = {}) {
    const catalog = pathSegment(catalogId, 'IMPACT_CATALOG_ID_INVALID');
    const filter = validateQueryText(query, 'IMPACT_FILTER_INVALID');
    const path = `/Mediapartners/${pathSegment(accountSid, 'IMPACT_ACCOUNT_SID_INVALID')}/Catalogs/${catalog}/Items`;
    const call = await getJson(path, { Query: filter }, 'catalog.list_items');
    const rows = call.payload.Items;
    if (!Array.isArray(rows) || rows.length > MAX_LIST_ITEMS || rows.some(row => !object(row))) {
      fail('IMPACT_CATALOG_ITEMS_SCHEMA_INVALID', call.receipt);
    }
    const items = rows.map(row => normalizeItem(row, call.receipt.checkedAt, { expectedCatalogId: catalogId }));
    return { provider: 'impact', items,
      receipt: completeReceipt(call.receipt, { schemaVerified: true, expectedResultVerified: true }) };
  }

  return { searchProducts, getProduct, listCatalogs, listCatalogItems };
}
