import { createImpactPartnerCatalogClient } from './impact.mjs';
import { createRakutenAdvertisingProductSearchClient } from './rakuten-advertising.mjs';

const API_ORIGIN = 'https://api.impact.com';
const CATALOGS_DOC = 'https://integrations.impact.com/partner-api-reference/reference/catalogs/catalogs';
const US_CURRENCY = 'USD';
const US_AREA_NAMES = new Set(['us', 'usa', 'united states', 'united states of america']);
const CATALOG_NAME_ALIASES = new Set(['ulta beauty', 'ulta beauty, inc.']);
const SEPHORA_NAME_ALIASES = new Set(['sephora']);
const CONTROL = /[\x00-\x1f\x7f]/;
const MAX_CATALOG_ID = 128;
const MAX_KEYWORD = 500;
const MAX_RETURNED_ITEMS = 1_000;

export class BrandAffiliateCatalogError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'BrandAffiliateCatalogError';
    this.code = code;
    this.details = details;
  }
}

const fail = (code, details) => { throw new BrandAffiliateCatalogError(`BRAND_AFFILIATE_${code}`, details); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 2_000) => typeof value === 'string' && value.length > 0 && value.length <= max && !CONTROL.test(value);

function normalizedName(value) {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');
}

function validateCatalogId(value, credentials) {
  if (!text(value, MAX_CATALOG_ID) || !/^[A-Za-z0-9_-]+$/.test(value) ||
      value === credentials.accountSid || value === credentials.authToken) {
    fail('CATALOG_ID_INVALID');
  }
  return value;
}

function validateLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RETURNED_ITEMS) fail('LIMIT_INVALID');
  return value;
}

function validateKeyword(value) {
  if (value === undefined || value === null) return null;
  if (!text(value, MAX_KEYWORD) || !value.trim()) fail('KEYWORD_INVALID');
  return value.normalize('NFKC').toLocaleLowerCase('en-US').trim();
}

function containsCredential(value, secrets, depth = 0) {
  if (depth > 24) return false;
  if (typeof value === 'string') return secrets.some(secret => secret &&
    (value === secret || (secret.length >= 8 && value.includes(secret))));
  if (Array.isArray(value)) return value.some(item => containsCredential(item, secrets, depth + 1));
  if (object(value)) return Object.values(value).some(item => containsCredential(item, secrets, depth + 1));
  return false;
}

function safeReceipt(receipt, operation) {
  const request = receipt?.request ?? {};
  const path = operation === 'catalog.verify'
    ? '/Mediapartners/{AccountSID}/Catalogs'
    : operation === 'catalog.items'
      ? '/Mediapartners/{AccountSID}/Catalogs/{CatalogId}/Items'
      : '/Mediapartners/{AccountSID}/Catalogs/{CatalogId}/Items/{ProductId}';
  const safeRequest = {
    method: 'GET', origin: API_ORIGIN, path,
    browserUsed: false, anonymous: false, credentialsUsed: true, cookieSent: false,
    ...(text(request.checkedAt, 64) ? { checkedAt: request.checkedAt } : {}),
    ...(Number.isInteger(request.httpStatus) ? { httpStatus: request.httpStatus } : {}),
    ...(text(request.mime, 128) ? { mime: request.mime } : {}),
    ...(Number.isSafeInteger(request.responseBytes) ? { responseBytes: request.responseBytes } : {}),
    ...(typeof request.responseSha256 === 'string' && /^[a-f0-9]{64}$/.test(request.responseSha256)
      ? { responseSha256: request.responseSha256 } : {}),
  };
  return {
    schema: 'web-api-credentialed-read-receipt-v1',
    service: 'impact',
    capabilityId: operation,
    checkedAt: safeRequest.checkedAt ?? new Date().toISOString(),
    secretsPersistedInEvidence: false,
    authenticated: true,
    credentialsUsed: true,
    credentialBindingVerified: true,
    schemaVerified: receipt?.schemaVerified === true,
    expectedResultVerified: receipt?.expectedResultVerified === true,
    contractProvenance: { kind: 'first_party_documented_api', sourceURL: CATALOGS_DOC },
    request: safeRequest,
  };
}

function safeFailure(error, operation) {
  const translated = {
    IMPACT_CATALOG_ID_MISMATCH: 'ITEM_CATALOG_IDENTITY_MISMATCH',
    IMPACT_PRODUCT_ID_MISMATCH: 'PRODUCT_IDENTITY_MISMATCH',
    IMPACT_PRODUCT_NOT_FOUND: 'PRODUCT_NOT_FOUND',
  }[error?.code];
  if (translated) fail(translated, { operation });
  const sourceCode = typeof error?.code === 'string' && /^IMPACT_[A-Z0-9_]{1,80}$/.test(error.code)
    ? error.code : 'IMPACT_REQUEST_FAILED';
  fail('IMPACT_READ_FAILED', { operation, sourceCode });
}

function catalogView(catalog, secrets) {
  const result = {
    id: catalog.id,
    advertiserId: catalog.advertiserId ?? null,
    advertiserName: catalog.advertiserName,
    campaignId: catalog.campaignId ?? null,
    campaignName: catalog.campaignName ?? null,
    language: catalog.language ?? null,
    currency: catalog.currency ?? null,
    serviceAreas: catalog.serviceAreas ?? null,
    itemCount: catalog.itemCount ?? null,
    lastUpdatedAt: catalog.lastUpdatedAt ?? null,
  };
  if (containsCredential(result, secrets)) fail('RESPONSE_CONTAINS_CREDENTIAL');
  return result;
}

function catalogIsUlta(catalog) {
  return text(catalog?.advertiserName, 2_000) && CATALOG_NAME_ALIASES.has(normalizedName(catalog.advertiserName));
}

function verifyUsCatalog(catalog) {
  const area = typeof catalog.serviceAreas === 'string' ? catalog.serviceAreas : '';
  const areaParts = area.normalize('NFKC').toLocaleLowerCase('en-US')
    .split(/[,;|/]|\s+and\s+/i).map(value => value.trim()).filter(Boolean);
  if (catalog.currency !== US_CURRENCY || !areaParts.some(value => US_AREA_NAMES.has(value))) {
    fail('CATALOG_REGION_UNVERIFIED', {
      catalogId: catalog.id,
      currency: catalog.currency ?? null,
      serviceAreas: area || null,
      requiredMarket: 'US',
    });
  }
}

function verifyItemBinding(item, catalogId, secrets) {
  if (object(item) && containsCredential(item, secrets)) fail('RESPONSE_CONTAINS_CREDENTIAL');
  if (!object(item) || !object(item.source) || String(item.source.catalogId ?? '') !== catalogId) {
    fail('ITEM_CATALOG_IDENTITY_MISMATCH', { catalogId });
  }
  if (item.price?.amount !== null && item.price?.amount !== undefined && item.price?.currency !== US_CURRENCY) {
    fail('ITEM_CURRENCY_MISMATCH', { catalogId, currency: item.price?.currency ?? null });
  }
}

function localSearchText(item) {
  const source = item.source ?? {};
  return [item.title, source.manufacturer, source.category, source.description,
    ...(Array.isArray(source.bullets) ? source.bullets : []),
    ...(Array.isArray(source.labels) ? source.labels : [])]
    .filter(value => typeof value === 'string')
    .join(' ')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US');
}

function validateAdvertiserMid(value) {
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) fail('SEPHORA_MID_REQUIRED');
  return value;
}

function rakutenReceipt(receipt) {
  const request = receipt?.request ?? {};
  const safeRequest = {
    method: 'GET',
    origin: 'https://api.linksynergy.com',
    path: '/productsearch/1.0',
    browserUsed: false,
    anonymous: false,
    credentialsUsed: true,
    cookieSent: false,
    ...(text(request.checkedAt, 64) ? { checkedAt: request.checkedAt } : {}),
    ...(Number.isInteger(request.httpStatus) ? { httpStatus: request.httpStatus } : {}),
    ...(text(request.mime, 128) ? { mime: request.mime } : {}),
    ...(Number.isSafeInteger(request.responseBytes) ? { responseBytes: request.responseBytes } : {}),
    ...(Number.isSafeInteger(request.page) ? { page: request.page } : {}),
    ...(Number.isSafeInteger(request.pageSize) ? { pageSize: request.pageSize } : {}),
    ...(Number.isSafeInteger(request.totalMatches) ? { totalMatches: request.totalMatches } : {}),
    ...(Number.isSafeInteger(request.totalPages) ? { totalPages: request.totalPages } : {}),
  };
  return {
    schema: 'web-api-credentialed-read-receipt-v1',
    service: 'rakuten-advertising',
    capabilityId: 'catalog.product_search',
    checkedAt: safeRequest.checkedAt ?? new Date().toISOString(),
    secretsPersistedInEvidence: false,
    authenticated: true,
    credentialsUsed: true,
    credentialBindingVerified: true,
    schemaVerified: receipt?.schemaVerified === true,
    expectedResultVerified: receipt?.expectedResultVerified === true,
    contractProvenance: {
      kind: 'first_party_documented_api',
      sourceURL: 'https://developers.rakutenadvertising.com/guides/product_search',
    },
    request: safeRequest,
  };
}

function verifySephoraItems(result, advertiserMid, accessToken) {
  if (!object(result) || result.provider !== 'rakuten-advertising' || !Array.isArray(result.items)) {
    fail('SEPHORA_RAKUTEN_RESPONSE_INVALID');
  }
  if (result.items.some(item => containsCredential(item, [accessToken]))) fail('RESPONSE_CONTAINS_CREDENTIAL');
  for (const item of result.items) {
    if (String(item.source?.advertiserId ?? '') !== advertiserMid ||
        !text(item.source?.advertiserName, 2_000) ||
        !SEPHORA_NAME_ALIASES.has(normalizedName(item.source.advertiserName))) {
      fail('RAKUTEN_ADVERTISER_MISMATCH', { advertiserMid });
    }
    if (item.price?.currency !== US_CURRENCY ||
        item.salePrice && item.salePrice.currency !== US_CURRENCY) {
      fail('SEPHORA_RAKUTEN_CURRENCY_MISMATCH', { advertiserMid });
    }
  }
  return result.items.length > 0;
}

/**
 * Ulta Beauty's publisher program is through Impact. The caller supplies its
 * own Impact credentials and a catalog ID obtained from that authenticated
 * partner account. This adapter never applies to a program or creates links.
 */
export function createUltaImpactCatalogClient({
  accountSid,
  authToken,
  catalogId,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  const selectedCatalogId = validateCatalogId(catalogId, { accountSid, authToken });
  const secrets = [accountSid, authToken].filter(value => typeof value === 'string');
  let impact;
  try {
    impact = createImpactPartnerCatalogClient({ accountSid, authToken, fetchImpl, now });
  } catch (error) {
    safeFailure(error, 'client.create');
  }

  async function verifyCatalog() {
    let result;
    try { result = await impact.listCatalogs(); }
    catch (error) { safeFailure(error, 'catalog.verify'); }
    if (!object(result) || !Array.isArray(result.catalogs)) fail('CATALOG_LIST_INVALID');
    const selected = result.catalogs.filter(catalog => String(catalog?.id ?? '') === selectedCatalogId);
    if (selected.length === 0) fail('CATALOG_ID_NOT_FOUND', { catalogId: selectedCatalogId });
    if (selected.length !== 1) fail('CATALOG_ID_AMBIGUOUS', { catalogId: selectedCatalogId });
    const catalog = selected[0];
    if (containsCredential(catalog, secrets)) fail('RESPONSE_CONTAINS_CREDENTIAL');
    if (!catalogIsUlta(catalog)) {
      fail('CATALOG_ADVERTISER_MISMATCH', {
        catalogId: selectedCatalogId,
        advertiserName: text(catalog.advertiserName, 2_000) ? catalog.advertiserName : null,
      });
    }
    verifyUsCatalog(catalog);
    const safeCatalog = catalogView(catalog, secrets);
    return {
      brand: 'ulta-beauty',
      network: 'impact',
      market: 'US',
      catalog: safeCatalog,
      receipt: safeReceipt(result.receipt, 'catalog.verify'),
    };
  }

  async function listProducts(options = {}) {
    if (!object(options)) fail('SEARCH_OPTIONS_INVALID');
    const { keyword, limit = 100 } = options;
    const normalizedKeyword = validateKeyword(keyword);
    const resultLimit = validateLimit(limit);
    const verified = await verifyCatalog();
    let result;
    try { result = await impact.listCatalogItems({ catalogId: selectedCatalogId }); }
    catch (error) { safeFailure(error, 'catalog.items'); }
    if (!object(result) || !Array.isArray(result.items) || result.items.length > 10_000) {
      fail('CATALOG_ITEMS_RESPONSE_INVALID', { catalogId: selectedCatalogId });
    }
    for (const item of result.items) verifyItemBinding(item, selectedCatalogId, secrets);
    const matched = normalizedKeyword === null ? result.items
      : result.items.filter(item => localSearchText(item).includes(normalizedKeyword));
    const items = matched.slice(0, resultLimit);
    const currencies = [...new Set(result.items.map(item => item.price?.currency).filter(Boolean))].sort();
    return {
      provider: 'impact',
      brand: 'ulta-beauty',
      market: 'US',
      catalog: verified.catalog,
      items,
      search: {
        keyword: normalizedKeyword,
        mode: normalizedKeyword === null ? 'catalog_items' : 'local_substring_filter',
        remoteSearchUsed: false,
      },
      priceCurrency: US_CURRENCY,
      observedItemCurrencies: currencies,
      coverage: 'provider_limited',
      completeness: 'unknown_catalog_response_cap_and_no_paging_contract',
      counts: {
        catalogItemsReturned: result.items.length,
        keywordMatches: matched.length,
        itemsReturned: items.length,
        resultLimit,
        priceUnavailable: matched.filter(item => item.price?.kind === 'unknown').length,
      },
      receipts: [verified.receipt, safeReceipt(result.receipt, 'catalog.items')],
    };
  }

  async function getProduct(options = {}) {
    if (!object(options)) fail('PRODUCT_OPTIONS_INVALID');
    const { productId } = options;
    if (!text(productId, 512) || /[\x00-\x20\x7f/\\?#]/.test(productId)) fail('PRODUCT_ID_INVALID');
    const verified = await verifyCatalog();
    let result;
    try { result = await impact.getProduct({ catalogId: selectedCatalogId, productId }); }
    catch (error) { safeFailure(error, 'catalog.product_detail'); }
    verifyItemBinding(result?.item, selectedCatalogId, secrets);
    if (result.item.productId !== productId) fail('PRODUCT_IDENTITY_MISMATCH', { catalogId: selectedCatalogId });
    return {
      provider: 'impact',
      brand: 'ulta-beauty',
      market: 'US',
      catalog: verified.catalog,
      item: result.item,
      receipts: [verified.receipt, safeReceipt(result.receipt, 'catalog.product_detail')],
    };
  }

  return Object.freeze({ verifyCatalog, listProducts, searchProducts: listProducts, getProduct });
}

/**
 * Sephora's US publisher program is listed through Rakuten Advertising. MID is
 * caller-supplied and checked against the advertiser identity returned by the
 * account-scoped Product Search API; this adapter contains no guessed MID.
 */
export function createSephoraRakutenClient({
  accessToken,
  advertiserMid,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleepImpl,
} = {}) {
  const selectedMid = validateAdvertiserMid(advertiserMid);
  if (typeof accessToken !== 'string' || !accessToken || accessToken.length > 8_192 ||
      accessToken !== accessToken.trim() || /[\s\x00-\x1f\x7f]/.test(accessToken)) {
    fail('SEPHORA_RAKUTEN_TOKEN_REQUIRED');
  }
  let rakuten;
  try {
    rakuten = createRakutenAdvertisingProductSearchClient({ accessToken, fetchImpl, now,
      ...(sleepImpl === undefined ? {} : { sleepImpl }) });
  } catch (error) {
    const sourceCode = typeof error?.code === 'string' && /^RAKUTEN_[A-Z0-9_]{1,80}$/.test(error.code)
      ? error.code : 'RAKUTEN_CLIENT_INVALID';
    fail('SEPHORA_RAKUTEN_CLIENT_INVALID', { sourceCode });
  }

  async function read(input) {
    if (!object(input)) fail('SEPHORA_RAKUTEN_SEARCH_INVALID');
    if (input.advertiserMid !== undefined && input.advertiserMid !== selectedMid) {
      fail('SEPHORA_RAKUTEN_MID_OVERRIDE_REJECTED');
    }
    if (input.language !== undefined && input.language !== 'en_US') fail('SEPHORA_RAKUTEN_LANGUAGE_REJECTED');
    let result;
    try {
      result = await rakuten.searchProducts({ ...input, advertiserMid: selectedMid, language: 'en_US' });
    } catch (error) {
      const sourceCode = typeof error?.code === 'string' && /^RAKUTEN_[A-Z0-9_]{1,80}$/.test(error.code)
        ? error.code : 'RAKUTEN_REQUEST_FAILED';
      fail('SEPHORA_RAKUTEN_READ_FAILED', { sourceCode, advertiserMid: selectedMid });
    }
    const merchantVerified = verifySephoraItems(result, selectedMid, accessToken);
    return {
      provider: 'rakuten-advertising',
      brand: 'sephora',
      market: merchantVerified ? 'US' : null,
      advertiser: {
        advertiserMid: selectedMid,
        advertiserName: merchantVerified ? result.items[0].source.advertiserName : null,
        identityVerified: merchantVerified,
        marketEvidence: merchantVerified ? 'exact advertiser response name + en_US query + USD response price' : 'no product row to verify',
      },
      items: result.items,
      trackingLinkSemantics: 'Rakuten Product Search linkurl; final merchant hostname was not resolved',
      finalDomainVerified: false,
      pagination: result.pagination,
      receipts: [rakutenReceipt(result.receipt)],
    };
  }

  return Object.freeze({
    verifyMerchant() { return read({ page: 1, pageSize: 1 }); },
    searchProducts(input) { return read(input); },
  });
}
