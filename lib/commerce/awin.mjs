import { createHash } from 'node:crypto';

const API_ORIGIN = 'https://api.awin.com';
const CONTRACT_URL = 'https://help.awin.com/apidocs/retail-publisher-productapidocumentation-1';
const MAX_RESPONSE_BYTES = 512 * 1024 * 1024;
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_PRODUCTS = 2_000_000;
const MIN_REQUEST_INTERVAL_MS = 12_000;
const PRODUCT_ID = /^[A-Za-z0-9_-]{1,50}$/;
const LOCALE = /^[a-z]{2}_[A-Z]{2}$/;
const CURRENCY = /^[A-Z]{3}$/;
const AMOUNT = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/;
const HTML_MIMES = new Set(['text/html', 'application/xhtml+xml']);

export class AwinPublisherFeedError extends Error {
  constructor(code, receipt = {}) {
    super(code);
    this.name = 'AwinPublisherFeedError';
    this.code = code;
    this.receipt = receipt;
  }
}

const fail = (code, receipt = {}) => { throw new AwinPublisherFeedError(code, receipt); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const cleanText = (value, max = 100_000) => typeof value === 'string' && value.length > 0 &&
  value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const optionalText = (value, max = 100_000) => value === undefined || value === null || cleanText(value, max);

function mimeOf(response) {
  return response.headers?.get?.('content-type')?.split(';')[0]?.trim()?.toLowerCase() ?? null;
}

function safeProductUrl(value) {
  if (typeof value !== 'string' || value.length > 2_000) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.toString();
  } catch { return null; }
}

function money(value) {
  if (typeof value !== 'string' || value.length > 64) return null;
  const match = value.trim().match(/^((?:0|[1-9]\d{0,11})(?:\.\d{1,4})?)\s+([A-Z]{3})$/);
  if (!match || !AMOUNT.test(match[1]) || !CURRENCY.test(match[2])) return null;
  return { amount: match[1], currency: match[2] };
}

function activeSale(product, timestamp) {
  if (!product.sale_price) return false;
  if (!product.sale_price_effective_date) return true;
  if (typeof product.sale_price_effective_date !== 'string' || product.sale_price_effective_date.length > 128) return false;
  const parts = product.sale_price_effective_date.split('/');
  if (parts.length !== 2) return false;
  const start = Date.parse(parts[0]);
  const end = Date.parse(parts[1]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return false;
  return timestamp >= start && timestamp <= end;
}

function normalizedProduct(row, { advertiserId, locale, checkedAt, timestamp }) {
  if (!object(row) || row.error !== undefined || !cleanText(String(row.id ?? ''), 50) ||
      !PRODUCT_ID.test(String(row.id)) || !cleanText(row.title, 150) ||
      !cleanText(row.link, 2_000) || !optionalText(row.description, 5_000) ||
      !optionalText(row.brand, 70) || !optionalText(row.product_type, 750) ||
      !optionalText(row.gtin, 64) || !optionalText(row.mpn, 70) ||
      !optionalText(row.availability, 64) || !optionalText(row.item_group_id, 50) ||
      !optionalText(row.image_link, 2_000) || !optionalText(row.sale_price, 64) ||
      !optionalText(row.sale_price_effective_date, 128)) {
    fail('AWIN_PRODUCT_SCHEMA_INVALID');
  }
  const url = safeProductUrl(row.link);
  if (!url) fail('AWIN_PRODUCT_URL_INVALID');
  const basePrice = money(row.price);
  if (!basePrice) fail('AWIN_PRODUCT_PRICE_INVALID');
  const salePrice = money(row.sale_price);
  if (row.sale_price && !salePrice) fail('AWIN_PRODUCT_SALE_PRICE_INVALID');
  if (salePrice && salePrice.currency !== basePrice.currency) fail('AWIN_PRODUCT_CURRENCY_MISMATCH');
  const saleActive = salePrice && activeSale(row, timestamp);
  const availabilityMap = {
    in_stock: 'available',
    out_of_stock: 'unavailable',
    out_ouf_stock: 'unavailable',
    preorder: 'available',
    backorder: 'available',
  };
  const availability = availabilityMap[String(row.availability ?? '').toLowerCase()] ?? 'unknown';
  const groupId = typeof row.item_group_id === 'string' && row.item_group_id ? row.item_group_id : null;
  const variantId = groupId && groupId !== String(row.id) ? String(row.id) : null;
  const productId = groupId && groupId === String(row.id) ? groupId : groupId ? groupId : String(row.id);
  return {
    provider: 'awin',
    productId,
    variantId,
    title: row.title,
    url,
    imageUrl: safeProductUrl(row.image_link),
    price: {
      amount: (saleActive ? salePrice : basePrice).amount,
      currency: basePrice.currency,
      kind: 'retail_current',
    },
    ...(saleActive ? { listPrice: { amount: basePrice.amount, currency: basePrice.currency, kind: 'retail_list' } } : {}),
    availability,
    observedAt: checkedAt,
    source: {
      network: 'awin',
      advertiserId: String(advertiserId),
      locale,
      feedProductId: String(row.id),
      productGroupId: groupId,
      priceSource: 'publisher-enhanced-google-feed',
      ...(row.availability ? { feedAvailability: row.availability } : {}),
      ...(row.description ? { description: row.description } : {}),
      ...(row.brand ? { brand: row.brand } : {}),
      ...(row.product_type ? { productType: row.product_type } : {}),
      ...(row.google_product_category ? { googleProductCategory: row.google_product_category } : {}),
      ...(row.gtin ? { gtin: String(row.gtin) } : {}),
      ...(row.mpn ? { mpn: String(row.mpn) } : {}),
      ...(row.sale_price ? { salePrice: row.sale_price, salePriceActive: Boolean(saleActive) } : {}),
    },
  };
}

function validIdentity(value, pattern, code) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(code);
  return value;
}

function validPage(page, pageSize) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 100_000 ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1_000) {
    fail('AWIN_PAGE_INVALID');
  }
  return { page, pageSize };
}

function safeCheckedAt(now) {
  let instant;
  try { instant = new Date(now()); } catch { fail('AWIN_CLOCK_INVALID'); }
  if (!Number.isFinite(instant.getTime())) fail('AWIN_CLOCK_INVALID');
  return { checkedAt: instant.toISOString(), timestamp: instant.getTime() };
}

// The publisher route returns a complete per-advertiser JSONL feed. Search and
// item lookup below scan that feed locally; they are not remote query endpoints.
export function createAwinPublisherFeedClient({
  publisherId,
  accessToken,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleepImpl = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  maxResponseBytes = 128 * 1024 * 1024,
  maxProducts = MAX_PRODUCTS,
  timeoutMs = 120_000,
} = {}) {
  const validPublisherId = validIdentity(publisherId, /^\d{1,20}$/, 'AWIN_PUBLISHER_ID_INVALID');
  if (typeof accessToken !== 'string' || !accessToken || accessToken.length > 16_384 || /[\r\n\0]/.test(accessToken)) {
    fail('AWIN_ACCESS_TOKEN_REQUIRED');
  }
  if (typeof fetchImpl !== 'function' || typeof now !== 'function' || typeof sleepImpl !== 'function' ||
      !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > MAX_RESPONSE_BYTES ||
      !Number.isSafeInteger(maxProducts) || maxProducts < 1 || maxProducts > MAX_PRODUCTS ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) {
    fail('AWIN_CLIENT_OPTIONS_INVALID');
  }

  const rateState = { lastRequestAt: null, tail: Promise.resolve() };

  async function withPublisherSlot(operation) {
    const previous = rateState.tail;
    let release;
    const current = new Promise(resolve => { release = resolve; });
    rateState.tail = current;
    await previous;
    try {
      const last = rateState.lastRequestAt;
      if (last !== null) {
        const delay = last + MIN_REQUEST_INTERVAL_MS - Number(now());
        if (delay > 0) await sleepImpl(delay);
      }
      rateState.lastRequestAt = Number(now());
      return await operation();
    } finally {
      release();
    }
  }

  async function scanFeed({ advertiserId, locale, keyword = '', matchId = null, matchGroupId = null, page = 1, pageSize = 50 }) {
    const advertiser = validIdentity(advertiserId, /^\d{1,20}$/, 'AWIN_ADVERTISER_ID_INVALID');
    const language = validIdentity(locale, LOCALE, 'AWIN_LOCALE_INVALID');
    const pagination = validPage(page, pageSize);
    if (typeof keyword !== 'string' || keyword.length > 500 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(keyword)) {
      fail('AWIN_KEYWORD_INVALID');
    }
    const normalizedKeyword = keyword.trim().toLocaleLowerCase();
    const { checkedAt, timestamp } = safeCheckedAt(now);
    const path = `/publishers/${validPublisherId}/awinfeeds/download/${advertiser}-retail-${language}.jsonl`;
    const baseRequest = {
      method: 'GET', origin: API_ORIGIN, path, checkedAt, browserUsed: false,
      credentialsUsed: true, credentialType: 'bearer', redirectPolicy: 'manual',
    };
    const evidenceBase = {
      schema: 'web-api-credentialed-read-receipt-v1', service: 'awin',
      capabilityId: matchId ? 'catalog.product_detail' : 'catalog.search',
      checkedAt, secretsPersistedInEvidence: false, authenticated: true, credentialsUsed: true,
      credentialBindingVerified: true, contractProvenance: {
        kind: 'first_party_documented_feed', sourceURL: CONTRACT_URL,
      },
      credentialBinding: { source: 'process-memory', serviceMatched: true, originMatched: true, persisted: false },
    };
    const requestUrl = new URL(path, API_ORIGIN);
    let response;
    try {
      response = await fetchImpl(requestUrl, {
        method: 'GET', redirect: 'manual', credentials: 'omit',
        headers: { accept: 'application/x-ndjson, application/json, text/plain', authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const receipt = { ...evidenceBase, request: { ...baseRequest, causeCode: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'TRANSPORT_ERROR' } };
      fail('AWIN_TRANSPORT_FAILED', receipt);
    }
    const mime = mimeOf(response);
    const receivedRequest = { ...baseRequest, httpStatus: response.status, mime };
    if (response.status === 401) fail('AWIN_AUTH_REQUIRED', { ...evidenceBase, request: receivedRequest });
    if (response.status === 403) fail('AWIN_ACCESS_DENIED', { ...evidenceBase, request: receivedRequest });
    if (response.status === 404) fail('AWIN_FEED_NOT_FOUND', { ...evidenceBase, request: receivedRequest });
    if (response.status === 429) fail('AWIN_THROTTLED', { ...evidenceBase, request: receivedRequest });
    if (response.status !== 200 || response.redirected || HTML_MIMES.has(mime) || !response.body?.getReader) {
      fail('AWIN_RESPONSE_INVALID', { ...evidenceBase, request: receivedRequest });
    }
    const declaredBytes = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declaredBytes) && declaredBytes > maxResponseBytes) {
      fail('AWIN_RESPONSE_TOO_LARGE', { ...evidenceBase, request: { ...receivedRequest, responseBytes: declaredBytes } });
    }

    const reader = response.body.getReader();
    const hash = createHash('sha256');
    let carry = Buffer.alloc(0);
    let responseBytes = 0;
    let lineNumber = 0;
    let feedProducts = 0;
    let matchCount = 0;
    const matches = [];
    const wantedStart = (pagination.page - 1) * pagination.pageSize;
    const wantedEnd = wantedStart + pagination.pageSize;
    const receiptRequest = () => ({ ...receivedRequest, responseBytes,
      responseSha256: null, feedLineCount: lineNumber, feedProductCount: feedProducts,
      queryFields: matchId ? ['id'] : normalizedKeyword ? ['keyword'] : [],
      ...(matchId ? { productIdMatched: matches.length === 1 } : {}),
      ...(normalizedKeyword ? { keywordSha256: createHash('sha256').update(normalizedKeyword).digest('hex') } : {}),
    });
    const processLine = rawLine => {
      if (rawLine.byteLength > MAX_LINE_BYTES) fail('AWIN_FEED_LINE_TOO_LARGE', { ...evidenceBase, request: receiptRequest() });
      const line = rawLine.toString('utf8').replace(/\r$/, '');
      if (!line.trim()) return;
      lineNumber += 1;
      let row;
      try { row = JSON.parse(line); } catch { fail('AWIN_JSONL_LINE_INVALID', { ...evidenceBase, request: receiptRequest() }); }
      if (object(row) && Number.isInteger(row.error)) fail('AWIN_FEED_INCOMPLETE', { ...evidenceBase,
        request: { ...receiptRequest(), terminalErrorCode: row.error } });
      if (!object(row) || row.id === undefined || row.title === undefined || row.link === undefined) {
        fail('AWIN_PRODUCT_SCHEMA_UNSUPPORTED', { ...evidenceBase, request: receiptRequest() });
      }
      if (feedProducts >= maxProducts) fail('AWIN_PRODUCT_LIMIT_EXCEEDED', { ...evidenceBase, request: receiptRequest() });
      feedProducts += 1;
      const normalized = normalizedProduct(row, { advertiserId: advertiser, locale: language, checkedAt, timestamp });
      if (matchId !== null) {
        if (String(row.id) === matchId || (matchGroupId !== null && String(row.item_group_id ?? '') === matchGroupId)) {
          matches.push(normalized);
        }
        return;
      }
      const haystack = [row.title, row.description, row.brand, row.product_type, row.google_product_category,
        row.gtin, row.mpn].filter(value => typeof value === 'string').join('\n').toLocaleLowerCase();
      if (!normalizedKeyword || haystack.includes(normalizedKeyword)) {
        if (matchCount >= wantedStart && matchCount < wantedEnd) matches.push(normalized);
        matchCount += 1;
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        responseBytes += value.byteLength;
        if (responseBytes > maxResponseBytes) {
          await reader.cancel().catch(() => {});
          fail('AWIN_RESPONSE_TOO_LARGE', { ...evidenceBase, request: { ...receiptRequest(), responseBytes } });
        }
        hash.update(value);
        const buffer = Buffer.from(value);
        const joined = carry.length ? Buffer.concat([carry, buffer]) : buffer;
        let start = 0;
        for (let index = 0; index < joined.length; index += 1) {
          if (joined[index] === 0x0a) {
            processLine(joined.subarray(start, index));
            start = index + 1;
          }
        }
        carry = joined.subarray(start);
        if (carry.length > MAX_LINE_BYTES) fail('AWIN_FEED_LINE_TOO_LARGE', { ...evidenceBase, request: receiptRequest() });
      }
      if (carry.length) processLine(carry);
    } catch (error) {
      await reader.cancel().catch(() => {});
      if (error instanceof AwinPublisherFeedError) throw error;
      fail('AWIN_TRANSPORT_FAILED', { ...evidenceBase, request: receiptRequest() });
    } finally {
      reader.releaseLock();
    }
    if (feedProducts === 0) fail('AWIN_FEED_EMPTY', { ...evidenceBase, request: receiptRequest() });
    if (matchId !== null && matches.length > 1) fail('AWIN_PRODUCT_ID_AMBIGUOUS', { ...evidenceBase, request: receiptRequest() });
    const request = { ...receiptRequest(), responseSha256: hash.digest('hex') };
    return {
      matches,
      matchCount: matchId === null ? matchCount : matches.length,
      request,
      checkedAt,
      feedProducts,
      receipt: {
        ...evidenceBase,
        schemaVerified: true,
        expectedResultVerified: matchId === null ? true : matches.length === 1,
        ...(matchId !== null ? { productIdMatched: matches.length === 1 } : {}),
        request,
      },
    };
  }

  async function withFeedKey(_advertiserId, _locale, operation) {
    // Awin's documented five-per-minute guidance is publisher-wide, and it
    // forbids concurrent downloads for the same feed. Serializing all feed
    // reads for this publisher satisfies both boundaries in this process.
    return withPublisherSlot(operation);
  }

  return {
    async searchProducts({ advertiserId, locale, keyword = '', page = 1, pageSize = 50 } = {}) {
      return withFeedKey(advertiserId, locale, async () => {
        const scanned = await scanFeed({ advertiserId, locale, keyword, page, pageSize });
        return {
          provider: 'awin',
          items: scanned.matches,
          page: { page, pageSize, matchingProducts: scanned.matchCount,
            hasMore: scanned.matchCount > page * pageSize },
          receipt: scanned.receipt,
        };
      });
    },
    async getProduct({ advertiserId, locale, productId, variantId = null } = {}) {
      const id = validIdentity(productId, PRODUCT_ID, 'AWIN_PRODUCT_ID_INVALID');
      const variant = variantId === null ? null : validIdentity(variantId, PRODUCT_ID, 'AWIN_VARIANT_ID_INVALID');
      return withFeedKey(advertiserId, locale, async () => {
        const scanned = await scanFeed({ advertiserId, locale, matchId: variant ?? id, matchGroupId: id });
        if (scanned.matches.length === 1 && (scanned.matches[0].productId !== id ||
            (variant !== null && scanned.matches[0].variantId !== variant))) {
          fail('AWIN_PRODUCT_ID_MISMATCH', scanned.receipt);
        }
        return { provider: 'awin', item: scanned.matches[0] ?? null,
          receipt: { ...scanned.receipt, productIdMatched: scanned.matches.length === 1 } };
      });
    },
  };
}
