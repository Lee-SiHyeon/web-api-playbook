import { createOliveyoungClient, OliveyoungError } from '../../service-packs/affiliate/apps/affiliate-api-hub/adapters/oliveyoung-curator.mjs';

const ORIGIN = 'https://m.oliveyoung.co.kr';
const SEARCH_PATH = '/review/api/affiliate/v1/activities/search';
const SEARCH_SOURCE = 'https://cf-static.oliveyoung.co.kr/prd/1.184.0/_next/static/chunks/pages/affiliate/product/search-69ae4f32d74c2ad5.js';
const SEARCH_SOURCE_SHA256 = '26e07cf8ce6cbf04876d626a9aeff7f19836fff653f518694166cc93f644d52d';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class OliveyoungCommerceError extends Error {
  constructor(code, receipt = {}) {
    super(code);
    this.name = 'OliveyoungCommerceError';
    this.code = code;
    this.receipt = receipt;
  }
}

const fail = (code, receipt) => { throw new OliveyoungCommerceError(code, receipt); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 1000) => typeof value === 'string' && value.length > 0 && value.length <= max &&
  value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
const id = value => (typeof value === 'string' || Number.isSafeInteger(value)) &&
  /^[A-Za-z0-9_-]{1,100}$/.test(String(value));

function won(value, field) {
  const amount = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? String(value) : value;
  if (typeof amount !== 'string' || !/^(?:0|[1-9][0-9]{0,14})$/.test(amount)) {
    fail('OLIVEYOUNG_PRICE_SCHEMA_INVALID', { field });
  }
  return { amount, currency: 'KRW', minorUnitExponent: 0 };
}

function percentage(value) {
  if (value == null) return null;
  const normalized = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof normalized !== 'string' || !/^(?:0|[1-9][0-9]{0,2})(?:\.[0-9]{1,4})?$/.test(normalized) ||
      Number(normalized) > 100) fail('OLIVEYOUNG_PRODUCT_SCHEMA_INVALID', { field: 'discountRate' });
  return normalized;
}

function canonicalUrl(goodsNumber) {
  const url = new URL('/m/goods/getGoodsDetail.do', ORIGIN);
  url.searchParams.set('goodsNo', goodsNumber);
  return url.href;
}

function productFromSearchRow(row) {
  if (!object(row)) fail('OLIVEYOUNG_PRODUCT_SCHEMA_INVALID');
  const goods = object(row.goods) ? row.goods : object(row.product) ? row.product : row;
  if (!object(goods) || !id(goods.goodsNumber) || !text(goods.goodsName, 2000)) {
    fail('OLIVEYOUNG_PRODUCT_SCHEMA_INVALID');
  }
  const goodsNumber = String(goods.goodsNumber);
  const currentPrice = won(goods.priceToPay, 'goods.priceToPay');
  const listPrice = goods.originalPrice == null ? null : won(goods.originalPrice, 'goods.originalPrice');
  let categoryNumber = null;
  const rawCategory = goods.displayCategory?.leafCategoryNumber;
  if (rawCategory != null) {
    if (!id(rawCategory)) fail('OLIVEYOUNG_PRODUCT_SCHEMA_INVALID', { field: 'displayCategory.leafCategoryNumber' });
    categoryNumber = String(rawCategory);
  }
  const soldOut = goods.soldOutFlag;
  if (soldOut !== undefined && typeof soldOut !== 'boolean') {
    fail('OLIVEYOUNG_PRODUCT_SCHEMA_INVALID', { field: 'soldOutFlag' });
  }
  return {
    productId: goodsNumber,
    title: goods.goodsName,
    url: canonicalUrl(goodsNumber),
    price: { ...currentPrice, kind: 'retail_current', sourceField: 'goods.priceToPay' },
    listPrice: listPrice && { ...listPrice, kind: 'retail_list', sourceField: 'goods.originalPrice' },
    discountRate: percentage(goods.discountRate),
    availability: soldOut === undefined ? 'unknown' : soldOut ? 'unavailable' : 'available',
    categoryNumber,
  };
}

async function countBytes(response) {
  if (!response.body?.getReader) return null;
  const reader = response.body.getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return total;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        return total;
      }
    }
  } finally { reader.releaseLock(); }
}

function isoNow(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail('OLIVEYOUNG_OPTIONS_INVALID');
  return date.toISOString();
}

/**
 * Commerce view over the existing Shopping Curator HTTP adapter.
 * Catalog search is currently an authenticated Curator endpoint; this factory
 * accepts only a scoped in-memory session, never a password or account cookie file.
 */
export function createOliveyoungCommerceClient({ session, fetchImpl = globalThis.fetch,
  now = () => new Date(), timeoutMs = 15_000 } = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function' ||
      !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    fail('OLIVEYOUNG_OPTIONS_INVALID');
  }
  if (!object(session) || !(session.authorization || Array.isArray(session.cookies) && session.cookies.length)) {
    fail('OLIVEYOUNG_SESSION_REQUIRED');
  }

  let lastRead = null;
  const observedFetch = async (input, init) => {
    let url;
    try { url = new URL(typeof input === 'string' ? input : input.url); }
    catch { fail('OLIVEYOUNG_REQUEST_INVALID'); }
    if (url.origin !== ORIGIN) fail('OLIVEYOUNG_REQUEST_INVALID');
    const response = await fetchImpl(input, init);
    const mime = response.headers?.get?.('content-type')?.split(';')[0]?.trim().toLowerCase() ?? null;
    let responseBytes = null;
    try { responseBytes = await countBytes(response.clone()); } catch { /* The delegated reader validates its own bounded body. */ }
    lastRead = {
      method: init?.method ?? 'GET', origin: url.origin, path: url.pathname,
      httpStatus: response.status, mime, responseBytes, checkedAt: isoNow(now),
      browserUsed: false, credentialsUsed: Boolean(init?.headers?.Authorization || init?.headers?.Cookie),
      ...(url.pathname === SEARCH_PATH ? { queryFields: ['keyword', 'pageNumber', 'pageSize'] } : {}),
    };
    return response;
  };

  let client;
  try { client = createOliveyoungClient(session, { fetchImpl: observedFetch, now, timeoutMs }); }
  catch (error) {
    if (error instanceof OliveyoungError && error.code === 'SESSION_REQUIRED') fail('OLIVEYOUNG_SESSION_REQUIRED');
    throw error;
  }

  function lastSearchReceipt() {
    if (!lastRead || lastRead.path !== SEARCH_PATH) fail('OLIVEYOUNG_REQUEST_RECEIPT_MISSING');
    return {
      schema: 'web-api-session-read-receipt-v1',
      service: 'oliveyoung-shopping-curator',
      capabilityId: 'curator.product_search',
      checkedAt: lastRead.checkedAt,
      authenticated: true,
      credentialsUsed: true,
      schemaVerified: true,
      expectedResultVerified: true,
      secretsPersistedInEvidence: false,
      contractProvenance: {
        kind: 'first_party_web_bundle_source',
        sourceURL: SEARCH_SOURCE,
        sourceSha256: SEARCH_SOURCE_SHA256,
      },
      request: lastRead,
    };
  }

  return Object.freeze({
    async searchProducts({ keyword, pageNumber = 0, pageSize = 10 } = {}) {
      lastRead = null;
      const raw = await client.search({ keyword, pageNumber, pageSize });
      if (!object(raw) || !Array.isArray(raw.data) || raw.data.length > 500 || !object(raw.pagination)) {
        fail('OLIVEYOUNG_SEARCH_SCHEMA_INVALID');
      }
      const products = raw.data.map(productFromSearchRow);
      const receipt = lastSearchReceipt();
      const result = {
        products,
        requestedPage: { pageNumber, pageSize },
        pagination: null,
        receipt,
      };
      return client.assertSafeOutput(result);
    },

    async getProduct() {
      fail('OLIVEYOUNG_PRODUCT_DETAIL_XHR_UNVERIFIED', {
        reason: 'No standalone product-detail XHR contract has been observed and replayed.',
      });
    },

    async curatorStatus() { return client.assertSafeOutput(await client.status()); },
    async ranking() { return client.assertSafeOutput(await client.ranking()); },
    async generated(input) { return client.assertSafeOutput(await client.generated(input)); },

    async createLink() {
      fail('OLIVEYOUNG_ACTOR_BINDING_REQUIRED', {
        reason: 'The current Curator status contract does not return a member identifier to bind before an attribution write.',
      });
    },
  });
}
