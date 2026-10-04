import { createHash } from 'node:crypto';
import { createAllbirdsPublicClient } from '../retail/shopify.mjs';

const COLOURPOP_ORIGIN = 'https://colourpop.com';
const PRODUCT_BYTES = 1024 * 1024;
const SEARCH_BYTES = 512 * 1024;
const CART_BYTES = 64 * 1024;
const MAX_VARIANTS = 250;
const MAX_TEXT = 100_000;
const HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STORES = Object.freeze(['allbirds', 'colourpop']);

export class ShopifyStorefrontError extends Error {
  constructor(code, receipt = {}) {
    super(code);
    this.name = 'ShopifyStorefrontError';
    this.code = code;
    this.receipt = receipt;
  }
}

const fail = (code, receipt) => { throw new ShopifyStorefrontError(code, receipt); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT &&
  !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const nullableText = value => value === null || value === undefined || text(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const usdDecimal = value => typeof value === 'string' && /^(?:0|[1-9][0-9]{0,11})\.[0-9]{2}$/.test(value);
const minor = amount => {
  if (!usdDecimal(amount)) return null;
  const [whole, fraction] = amount.split('.');
  return BigInt(whole) * 100n + BigInt(fraction);
};

function amountFromMinor(value) {
  return {
    amount: `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`,
    amountInApiUnits: value,
    currency: 'USD',
    minorUnitExponent: 2,
  };
}

function validVariant(variant) {
  return object(variant) && integer(variant.id) && text(variant.title) && integer(variant.price) &&
    typeof variant.available === 'boolean' &&
    ['option1', 'option2', 'option3'].every(key => nullableText(variant[key]));
}

function validProduct(product, handle) {
  if (!object(product) || !integer(product.id) || product.handle !== handle || !text(product.title) ||
      !text(product.vendor) || !text(product.type) || typeof product.available !== 'boolean' ||
      !integer(product.price) || !integer(product.price_min) || !integer(product.price_max) ||
      product.url !== `/products/${handle}` || product.price_min > product.price_max ||
      !Array.isArray(product.variants) || product.variants.length < 1 ||
      product.variants.length > MAX_VARIANTS || product.variants.some(variant => !validVariant(variant))) return false;
  const ids = product.variants.map(variant => variant.id);
  return new Set(ids).size === ids.length &&
    (product.currency === undefined || /^[A-Z]{3}$/.test(product.currency));
}

function canonicalProductUrl(value, handle) {
  if (!text(value)) return null;
  try {
    const parsed = new URL(value, COLOURPOP_ORIGIN);
    if (parsed.origin !== COLOURPOP_ORIGIN || parsed.username || parsed.password || parsed.hash ||
        parsed.pathname !== `/products/${handle}`) return null;
    return `${COLOURPOP_ORIGIN}${parsed.pathname}`;
  } catch { return null; }
}

function validSearchProduct(product) {
  if (!object(product) || !integer(product.id) || !text(product.handle) ||
      product.handle.length > 120 || !HANDLE.test(product.handle) || !text(product.title) ||
      !text(product.vendor) || !text(product.type) || typeof product.available !== 'boolean' ||
      !usdDecimal(product.price) || !usdDecimal(product.price_min) || !usdDecimal(product.price_max) ||
      minor(product.price_min) > minor(product.price_max) ||
      canonicalProductUrl(product.url, product.handle) === null) return false;
  return product.currency === undefined || /^[A-Z]{3}$/.test(product.currency);
}

async function readBounded(response, limit, request) {
  if (!response.body?.getReader) fail('SHOPIFY_RESPONSE_INVALID', request);
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
        fail('SHOPIFY_RESPONSE_TOO_LARGE', { ...request, responseBytes: total });
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, total).toString('utf8');
}

function publicCurrencyReceipt(currency) {
  const { responseSha256: _discard, ...request } = currency.request;
  return { ...request, currency: currency.currency, itemCount: currency.itemCount };
}

function mimeOf(response) {
  return response.headers?.get?.('content-type')?.split(';')[0]?.trim()?.toLowerCase() ?? null;
}

function makeReceipt(capabilityId, request, extra = {}) {
  return {
    schema: 'web-api-public-read-receipt-v1',
    service: 'shopify-storefronts',
    capabilityId,
    checkedAt: request.checkedAt,
    secretsPersistedInEvidence: false,
    anonymous: true,
    credentialsUsed: false,
    authenticated: false,
    schemaVerified: true,
    expectedResultVerified: true,
    contractProvenance: {
      kind: 'first_party_documented_api',
      sourceURL: capabilityId.endsWith('predictive_search')
        ? 'https://shopify.dev/docs/api/ajax/reference/predictive-search'
        : 'https://shopify.dev/docs/api/ajax/reference/product',
    },
    request: { ...request, schemaVerified: true },
    ...extra,
  };
}

function normalizeAllbirdsResult(result, store, operation) {
  const currencyRequest = result.receipt.currencyRequest;
  const sanitizedCurrencyRequest = currencyRequest
    ? (({ responseSha256: _discard, ...request }) => request)(currencyRequest)
    : currencyRequest;
  return {
    ...result,
    receipt: {
      ...result.receipt,
      service: 'shopify-storefronts',
      capabilityId: `${store}.catalog.${operation}`,
      ...(sanitizedCurrencyRequest ? { currencyRequest: sanitizedCurrencyRequest } : {}),
    },
  };
}

export function createColourPopPublicClient({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') fail('SHOPIFY_CLIENT_INVALID');

  async function getJson(path, limit, query = []) {
    const url = new URL(path, COLOURPOP_ORIGIN);
    for (const [key, value] of query) url.searchParams.append(key, value);
    const checkedAt = new Date(now()).toISOString();
    const base = {
      method: 'GET', origin: COLOURPOP_ORIGIN, path, checkedAt,
      browserUsed: false, anonymous: true, cookieSent: false, credentialsUsed: false,
      ...(query.length ? { queryFields: query.map(([key]) => key) } : {}),
    };
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET', redirect: 'manual', credentials: 'omit',
        headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      fail('SHOPIFY_TRANSPORT_FAILED', { ...base,
        causeCode: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'TRANSPORT_ERROR' });
    }
    const mime = mimeOf(response);
    const request = { ...base, httpStatus: response.status, mime };
    if (response.status === 401) fail('SHOPIFY_AUTH_REQUIRED', request);
    if (response.status === 403) fail('SHOPIFY_ACCESS_BLOCKED', request);
    if (response.status === 429) fail('SHOPIFY_THROTTLED', request);
    if (response.status !== 200 || response.redirected ||
        !['application/json', 'text/javascript'].includes(mime)) {
      fail('SHOPIFY_RESPONSE_INVALID', request);
    }
    let raw;
    try { raw = await readBounded(response, limit, request); }
    catch (error) {
      if (error instanceof ShopifyStorefrontError) throw error;
      fail('SHOPIFY_TRANSPORT_FAILED', request);
    }
    let payload;
    try { payload = JSON.parse(raw); }
    catch { fail('SHOPIFY_RESPONSE_INVALID', { ...request, responseBytes: Buffer.byteLength(raw) }); }
    return {
      payload,
      request: { ...request, responseBytes: Buffer.byteLength(raw),
        responseSha256: createHash('sha256').update(raw, 'utf8').digest('hex') },
    };
  }

  async function getUsdCurrency() {
    const read = await getJson('/cart.js', CART_BYTES);
    const cart = read.payload;
    if (!object(cart) || !/^[A-Z]{3}$/.test(cart.currency ?? '') ||
        !Number.isSafeInteger(cart.item_count) || cart.item_count < 0) {
      fail('SHOPIFY_CURRENCY_SCHEMA_INVALID', read.request);
    }
    if (cart.currency !== 'USD') fail('SHOPIFY_CURRENCY_UNSUPPORTED', read.request);
    // The response can include a cart token and cart contents. Only the currency and
    // empty/non-empty item count survive this boundary; no cart body is returned.
    return { currency: cart.currency, itemCount: cart.item_count, request: read.request };
  }

  return {
    async getProduct({ handle } = {}) {
      if (typeof handle !== 'string' || handle.length > 120 || !HANDLE.test(handle)) {
        fail('SHOPIFY_PRODUCT_HANDLE_INVALID');
      }
      const productRead = await getJson(`/products/${handle}.js`, PRODUCT_BYTES);
      if (!validProduct(productRead.payload, handle)) {
        fail('SHOPIFY_PRODUCT_SCHEMA_INVALID', productRead.request);
      }
      const currency = await getUsdCurrency();
      if (productRead.payload.currency !== undefined && productRead.payload.currency !== currency.currency) {
        fail('SHOPIFY_CURRENCY_MISMATCH', currency.request);
      }
      const product = productRead.payload;
      const variants = product.variants.map(variant => ({
        id: variant.id,
        title: variant.title,
        price: amountFromMinor(variant.price),
        available: variant.available,
        option1: variant.option1 ?? null,
        option2: variant.option2 ?? null,
        option3: variant.option3 ?? null,
      }));
      return {
        store: 'colourpop',
        product: {
          id: product.id,
          handle: product.handle,
          canonicalUrl: `${COLOURPOP_ORIGIN}${product.url}`,
          title: product.title,
          vendor: product.vendor,
          productType: product.type,
          available: product.available,
          price: amountFromMinor(product.price),
          priceRange: { min: amountFromMinor(product.price_min), max: amountFromMinor(product.price_max) },
          variants,
        },
        receipt: makeReceipt('colourpop.catalog.product_detail', productRead.request, {
          productHandleMatched: true,
          variantCount: variants.length,
          currencyRequest: publicCurrencyReceipt(currency),
        }),
      };
    },

    async searchProducts({ query, limit = 5 } = {}) {
      if (!text(query) || query.trim().length < 1 || query.trim().length > 100 ||
          /[\x00-\x1f\x7f]/.test(query) || !Number.isInteger(limit) || limit < 1 || limit > 10) {
        fail('SHOPIFY_SEARCH_INPUT_INVALID');
      }
      const normalized = query.trim();
      const searchRead = await getJson('/search/suggest.json', SEARCH_BYTES, [
        ['q', normalized],
        ['resources[type]', 'product'],
        ['resources[limit]', String(limit)],
        ['resources[options][unavailable_products]', 'hide'],
      ]);
      const products = searchRead.payload?.resources?.results?.products;
      if (!object(searchRead.payload) || !object(searchRead.payload.resources) ||
          !object(searchRead.payload.resources.results) || !Array.isArray(products) ||
          products.length > limit || products.some(product => !validSearchProduct(product)) ||
          new Set(products.map(product => product.id)).size !== products.length ||
          new Set(products.map(product => product.handle)).size !== products.length) {
        fail('SHOPIFY_SEARCH_SCHEMA_INVALID', searchRead.request);
      }
      const currency = await getUsdCurrency();
      if (products.some(product => product.currency !== undefined && product.currency !== currency.currency)) {
        fail('SHOPIFY_CURRENCY_MISMATCH', currency.request);
      }
      return {
        store: 'colourpop',
        query: normalized,
        products: products.map(product => ({
          id: product.id,
          handle: product.handle,
          canonicalUrl: canonicalProductUrl(product.url, product.handle),
          title: product.title,
          vendor: product.vendor,
          productType: product.type,
          available: product.available,
          price: { amount: product.price, currency: currency.currency, minorUnitExponent: 2 },
          priceRange: {
            min: { amount: product.price_min, currency: currency.currency, minorUnitExponent: 2 },
            max: { amount: product.price_max, currency: currency.currency, minorUnitExponent: 2 },
          },
        })),
        receipt: makeReceipt('colourpop.catalog.predictive_search', searchRead.request, {
          productCount: products.length,
          currencyRequest: publicCurrencyReceipt(currency),
        }),
      };
    },
  };
}

export function createShopifyStorefrontClient({ store = 'allbirds', ...options } = {}) {
  if (store === 'allbirds') {
    const client = createAllbirdsPublicClient(options);
    return {
      async getProduct(input) {
        return normalizeAllbirdsResult(await client.getProduct(input), store, 'product_detail');
      },
      async searchProducts(input) {
        return normalizeAllbirdsResult(await client.searchProducts(input), store, 'predictive_search');
      },
    };
  }
  if (store === 'colourpop') return createColourPopPublicClient(options);
  fail('SHOPIFY_STORE_UNSUPPORTED');
}

export function createShopifyStorefronts(options = {}) {
  return Object.freeze({
    stores: STORES,
    forStore(store) { return createShopifyStorefrontClient({ store, ...options }); },
    async getProduct({ store = 'allbirds', ...input } = {}) {
      return createShopifyStorefrontClient({ store, ...options }).getProduct(input);
    },
    async searchProducts({ store = 'allbirds', ...input } = {}) {
      return createShopifyStorefrontClient({ store, ...options }).searchProducts(input);
    },
  });
}
