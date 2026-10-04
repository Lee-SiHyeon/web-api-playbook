import { createHash } from 'node:crypto';

const STORE_ORIGIN = 'https://www.allbirds.com';
const MAX_PRODUCT_BYTES = 1024 * 1024;
const MAX_SEARCH_BYTES = 512 * 1024;
const MAX_CART_BYTES = 64 * 1024;
const MAX_VARIANTS = 250;
const MAX_TEXT_LENGTH = 100_000;
const PRODUCT_HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class AllbirdsPublicError extends Error {
  constructor(code, receipt = {}) {
    super(code);
    this.name = 'AllbirdsPublicError';
    this.code = code;
    this.receipt = receipt;
  }
}

const fail = (code, receipt) => { throw new AllbirdsPublicError(code, receipt); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0 &&
  value.length <= MAX_TEXT_LENGTH && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const nonNegativeSafeInteger = value => Number.isSafeInteger(value) && value >= 0;
const nullableText = value => value === null || value === undefined || text(value);
const validUsdDecimal = value => typeof value === 'string' &&
  /^(?:0|[1-9][0-9]{0,11})\.[0-9]{2}$/.test(value);

async function readBoundedText(response, limit, receipt) {
  if (!response.body?.getReader) fail('SHOPIFY_RESPONSE_INVALID', receipt);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        fail('SHOPIFY_RESPONSE_TOO_LARGE', { ...receipt, responseBytes: total });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

function mimeOf(response) {
  return response.headers?.get?.('content-type')?.split(';')[0]?.trim()?.toLowerCase() ?? null;
}

function validVariant(variant) {
  return object(variant) && nonNegativeSafeInteger(variant.id) &&
    text(variant.title) && nonNegativeSafeInteger(variant.price) &&
    typeof variant.available === 'boolean' &&
    ['option1', 'option2', 'option3'].every(key => nullableText(variant[key]));
}

function validProduct(product, handle) {
  if (!object(product) || !nonNegativeSafeInteger(product.id) || product.handle !== handle ||
      !text(product.title) || !text(product.vendor) || !text(product.type) ||
      typeof product.available !== 'boolean' || !nonNegativeSafeInteger(product.price) ||
      !nonNegativeSafeInteger(product.price_min) || !nonNegativeSafeInteger(product.price_max) ||
      product.url !== '/products/' + handle ||
      product.price_min > product.price_max || !Array.isArray(product.variants) ||
      product.variants.length < 1 || product.variants.length > MAX_VARIANTS ||
      product.variants.some(variant => !validVariant(variant))) return false;
  const variantIds = product.variants.map(variant => variant.id);
  if (new Set(variantIds).size !== variantIds.length) return false;
  return product.currency === undefined || /^[A-Z]{3}$/.test(product.currency);
}

function validCartCurrency(cart) {
  return object(cart) && /^[A-Z]{3}$/.test(cart.currency ?? '') &&
    Number.isSafeInteger(cart.item_count) && cart.item_count >= 0;
}

function canonicalSearchUrl(value, handle) {
  if (!text(value)) return null;
  try {
    const parsed = new URL(value, STORE_ORIGIN);
    if (parsed.origin !== STORE_ORIGIN || parsed.username || parsed.password || parsed.hash ||
        parsed.pathname !== '/products/' + handle) return null;
    return STORE_ORIGIN + parsed.pathname;
  } catch {
    return null;
  }
}

function validSearchProduct(product) {
  return object(product) && nonNegativeSafeInteger(product.id) &&
    typeof product.handle === 'string' && product.handle.length <= 120 &&
    PRODUCT_HANDLE.test(product.handle) && text(product.title) && text(product.vendor) &&
    text(product.type) && typeof product.available === 'boolean' &&
    validUsdDecimal(product.price) && validUsdDecimal(product.price_min) &&
    validUsdDecimal(product.price_max) &&
    decimalToMinor(product.price_min) <= decimalToMinor(product.price_max) &&
    canonicalSearchUrl(product.url, product.handle) !== null;
}

function decimalToMinor(value) {
  if (!validUsdDecimal(value)) return null;
  const [whole, fraction] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction);
}

function usdMoney(apiUnits) {
  const whole = Math.floor(apiUnits / 100);
  const fraction = String(apiUnits % 100).padStart(2, '0');
  return {
    amount: whole + '.' + fraction,
    amountInApiUnits: apiUnits,
    currency: 'USD',
    minorUnitExponent: 2,
  };
}

// This adapter intentionally pins one observed Shopify-hosted storefront.
// It is not a generic multi-store marketplace client.
export function createAllbirdsPublicClient({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') fail('SHOPIFY_CLIENT_INVALID');

  async function getJson(path, maxBytes, query = []) {
    const url = new URL(path, STORE_ORIGIN);
    for (const [key, value] of query) url.searchParams.append(key, value);
    const checkedAt = new Date(now()).toISOString();
    const base = { method: 'GET', origin: STORE_ORIGIN, path, checkedAt,
      browserUsed: false, anonymous: true, cookieSent: false, credentialsUsed: false };
    if (query.length) base.queryFields = query.map(([key]) => key);
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      fail('SHOPIFY_TRANSPORT_FAILED', { ...base,
        causeCode: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'TRANSPORT_ERROR' });
    }
    const mime = mimeOf(response);
    const received = { ...base, httpStatus: response.status, mime };
    if (response.status === 401) fail('SHOPIFY_AUTH_REQUIRED', received);
    if (response.status === 403) fail('SHOPIFY_ACCESS_BLOCKED', received);
    if (response.status === 429) fail('SHOPIFY_THROTTLED', received);
    if (response.status !== 200 || response.redirected ||
        !['text/javascript', 'application/json'].includes(mime)) {
      fail('SHOPIFY_RESPONSE_INVALID', received);
    }
    let raw;
    try {
      raw = await readBoundedText(response, maxBytes, received);
    } catch (error) {
      if (error instanceof AllbirdsPublicError) throw error;
      fail('SHOPIFY_TRANSPORT_FAILED', received);
    }
    const responseBytes = Buffer.byteLength(raw, 'utf8');
    let payload;
    try { payload = JSON.parse(raw); }
    catch { fail('SHOPIFY_RESPONSE_INVALID', { ...received, responseBytes }); }
    return { payload, request: { ...received, responseBytes,
      responseSha256: createHash('sha256').update(raw, 'utf8').digest('hex') } };
  }

  async function getUsdCurrency() {
    // Shopify documents cart.js as the Ajax API currency source. This is a
    // cookie-free GET; no cart content is returned or saved by this adapter.
    const currencyRead = await getJson('/cart.js', MAX_CART_BYTES);
    if (!validCartCurrency(currencyRead.payload)) {
      fail('SHOPIFY_CURRENCY_SCHEMA_INVALID', currencyRead.request);
    }
    // This root-path client is for the verified default US storefront context.
    // Other currency exponents and locale/market paths have not been validated.
    if (currencyRead.payload.currency !== 'USD') {
      fail('SHOPIFY_CURRENCY_UNSUPPORTED', currencyRead.request);
    }
    return currencyRead;
  }

  return {
    async getProduct({ handle } = {}) {
      if (typeof handle !== 'string' || handle.length > 120 || !PRODUCT_HANDLE.test(handle)) {
        fail('SHOPIFY_PRODUCT_HANDLE_INVALID');
      }
      const productPath = '/products/' + handle + '.js';
      const productRead = await getJson(productPath, MAX_PRODUCT_BYTES);
      if (!validProduct(productRead.payload, handle)) {
        fail('SHOPIFY_PRODUCT_SCHEMA_INVALID', productRead.request);
      }

      const currencyRead = await getUsdCurrency();
      if (productRead.payload.currency !== undefined &&
          productRead.payload.currency !== currencyRead.payload.currency) {
        fail('SHOPIFY_CURRENCY_MISMATCH', currencyRead.request);
      }

      const product = productRead.payload;
      const variants = product.variants.map(variant => ({
        id: variant.id,
        title: variant.title,
        price: usdMoney(variant.price),
        available: variant.available,
        option1: variant.option1 ?? null,
        option2: variant.option2 ?? null,
        option3: variant.option3 ?? null,
      }));
      return {
        store: 'allbirds',
        product: {
          id: product.id,
          handle: product.handle,
          canonicalUrl: new URL(product.url, STORE_ORIGIN).toString(),
          title: product.title,
          vendor: product.vendor,
          productType: product.type,
          available: product.available,
          price: usdMoney(product.price),
          priceRange: {
            min: usdMoney(product.price_min),
            max: usdMoney(product.price_max),
          },
          variants,
        },
        receipt: {
          schema: 'web-api-public-read-receipt-v1',
          service: 'shopify',
          capabilityId: 'catalog.product_detail',
          checkedAt: productRead.request.checkedAt,
          secretsPersistedInEvidence: false,
          anonymous: true,
          credentialsUsed: false,
          authenticated: false,
          schemaVerified: true,
          expectedResultVerified: true,
          productHandleMatched: true,
          variantCount: variants.length,
          contractProvenance: {
            kind: 'first_party_documented_api',
            sourceURL: 'https://shopify.dev/docs/api/ajax/reference/product',
          },
          request: {
            ...productRead.request,
            schemaVerified: true,
            productHandleMatched: true,
            currency: currencyRead.payload.currency,
            priceMinorUnitExponent: 2,
            priceField: 'USD minor units',
          },
          currencyRequest: {
            ...currencyRead.request,
            currency: currencyRead.payload.currency,
            itemCount: currencyRead.payload.item_count,
          },
        },
      };
    },
    async searchProducts({ query, limit = 5 } = {}) {
      if (!text(query) || query.trim().length < 1 || query.trim().length > 100 ||
          /[\x00-\x1f\x7f]/.test(query) ||
          !Number.isInteger(limit) || limit < 1 || limit > 10) {
        fail('SHOPIFY_SEARCH_INPUT_INVALID');
      }
      const normalizedQuery = query.trim();
      const searchRead = await getJson('/search/suggest.json', MAX_SEARCH_BYTES, [
        ['q', normalizedQuery],
        ['resources[type]', 'product'],
        ['resources[limit]', String(limit)],
        ['resources[options][unavailable_products]', 'hide'],
      ]);
      const products = searchRead.payload?.resources?.results?.products;
      if (!object(searchRead.payload) || !object(searchRead.payload.resources) ||
          !object(searchRead.payload.resources.results) || !Array.isArray(products) ||
          products.length > limit || products.some(product => !validSearchProduct(product))) {
        fail('SHOPIFY_SEARCH_SCHEMA_INVALID', searchRead.request);
      }
      if (new Set(products.map(product => product.id)).size !== products.length ||
          new Set(products.map(product => product.handle)).size !== products.length) {
        fail('SHOPIFY_SEARCH_SCHEMA_INVALID', searchRead.request);
      }
      const currencyRead = await getUsdCurrency();
      if (products.some(product => product.currency !== undefined &&
          product.currency !== currencyRead.payload.currency)) {
        fail('SHOPIFY_CURRENCY_MISMATCH', currencyRead.request);
      }
      return {
        store: 'allbirds',
        query: normalizedQuery,
        products: products.map(product => ({
          id: product.id,
          handle: product.handle,
          canonicalUrl: canonicalSearchUrl(product.url, product.handle),
          title: product.title,
          vendor: product.vendor,
          productType: product.type,
          available: product.available,
          price: { amount: product.price, currency: currencyRead.payload.currency,
            minorUnitExponent: 2 },
          priceRange: {
            min: { amount: product.price_min, currency: currencyRead.payload.currency,
              minorUnitExponent: 2 },
            max: { amount: product.price_max, currency: currencyRead.payload.currency,
              minorUnitExponent: 2 },
          },
        })),
        receipt: {
          schema: 'web-api-public-read-receipt-v1',
          service: 'shopify',
          capabilityId: 'catalog.predictive_search',
          checkedAt: searchRead.request.checkedAt,
          secretsPersistedInEvidence: false,
          anonymous: true,
          credentialsUsed: false,
          authenticated: false,
          schemaVerified: true,
          expectedResultVerified: true,
          productCount: products.length,
          contractProvenance: {
            kind: 'first_party_documented_api',
            sourceURL: 'https://shopify.dev/docs/api/ajax/reference/predictive-search',
          },
          request: {
            ...searchRead.request,
            schemaVerified: true,
            resultArrayVerified: true,
            productCount: products.length,
          },
          currencyRequest: {
            ...currencyRead.request,
            currency: currencyRead.payload.currency,
            itemCount: currencyRead.payload.item_count,
          },
        },
      };
    },
  };
}
