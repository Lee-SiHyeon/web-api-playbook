import { createHash } from 'node:crypto';
import { parseHTML } from 'linkedom';

const ORIGIN = 'https://kr.shein.com';
const MAX_BYTES = 4 * 1024 * 1024;
const ID = /^\d{1,20}$/;
const CURRENCIES = new Set(Intl.supportedValuesOf('currency'));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clean = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

export class SheinPublicError extends Error {
  constructor(code, receipt = null) {
    super(code);
    this.name = 'SheinPublicError';
    this.code = code;
    this.receipt = receipt;
  }
}
const fail = (code, receipt) => { throw new SheinPublicError(code, receipt); };

// Parse a JSON object literal from the observed assignment. Never execute site JS.
function rawData(document) {
  const matches = [...document.querySelectorAll('script:not([src])')]
    .map(node => /(?:^|[;\r\n])\s*(?:window\.)?gbRawData\s*=\s*/.exec(node.textContent))
    .filter(Boolean);
  if (matches.length !== 1) fail('SHEIN_HTML_LAYOUT_CHANGED');
  const match = matches[0];
  const source = match.input.slice(match.index + match[0].length);
  if (!source.startsWith('{')) fail('SHEIN_EMBEDDED_JSON_INVALID');
  const stack = [];
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') {
      if (stack.pop() !== (c === '}' ? '{' : '[')) fail('SHEIN_EMBEDDED_JSON_INVALID');
      if (!stack.length) {
        try { return JSON.parse(source.slice(0, i + 1)); }
        catch { fail('SHEIN_EMBEDDED_JSON_INVALID'); }
      }
    }
    if (stack.length > 100) fail('SHEIN_EMBEDDED_JSON_INVALID');
  }
  fail('SHEIN_EMBEDDED_JSON_INVALID');
}

function price(value, currency, kind) {
  if (!object(value) || typeof value.amount !== 'string' || !/^\d{1,12}(?:\.\d{1,4})?$/.test(value.amount)
    || !clean(value.amountWithSymbol) || value.amountWithSymbol.length > 100) fail('SHEIN_PRICE_SCHEMA_INVALID');
  return { amount: value.amount, displayText: clean(value.amountWithSymbol), currency,
    currencyVerified: currency !== null, kind, basis: 'displayed_home_card',
    variantId: null, shippingIncluded: null, taxIncluded: null };
}

function imageUrl(value) {
  try {
    const url = new URL(value, ORIGIN);
    if (url.protocol !== 'https:' || url.hostname !== 'img.ltwebstatic.com' || url.username || url.password
      || url.port || url.search || url.hash) return null;
    return url.href;
  } catch { return null; }
}

function navigation(document) {
  const menus = document.querySelectorAll('[role="menubar"][aria-label="Category menu"]');
  if (menus.length !== 1) fail('SHEIN_HTML_LAYOUT_CHANGED');
  const result = [];
  for (const node of menus[0].querySelectorAll('a[href]')) {
    const label = clean(node.textContent);
    let url;
    try { url = new URL(node.getAttribute('href'), ORIGIN); } catch { continue; }
    const match = /-(sc|c)-(\d+)\.html$/.exec(url.pathname);
    if (url.origin !== ORIGIN || url.username || url.password || !label || label.length > 200 || !match) continue;
    // Tracking parameters are not needed for category identity; these are observed destinations, not fetched pages.
    const target = url.origin + url.pathname;
    if (result.some(row => row.url === target)) continue;
    result.push({ label, url: target, externalCategoryId: match[2],
      edgeType: match[1] === 'c' ? 'home_to_category' : 'home_to_collection',
      idNamespace: match[1] === 'c' ? 'category' : 'collection', state: 'pending' });
  }
  if (!result.length || result.length > 100) fail('SHEIN_HTML_LAYOUT_CHANGED');
  return result;
}

/** The KR homepage Document contains public gbRawData product cards, not a complete catalog. */
export function parseSheinHomeDocument(html) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > MAX_BYTES) fail('SHEIN_RESPONSE_TOO_LARGE');
  const document = parseHTML(html).document;
  const title = clean(document.querySelector('title')?.textContent);
  if (/just a moment|access denied|verify you are human|security verification/i.test(title)
    || document.querySelector('#challenge-form, #px-captcha, form[action*="captcha"]')) fail('SHEIN_CHALLENGE');
  const data = rawData(document);
  if (!object(data) || data.SiteUID !== 'kr' || data.lang !== 'kr'
    || !object(data.content) || !Array.isArray(data.content.content)) fail('SHEIN_SCHEMA_INVALID');
  const currency = typeof data.currency === 'string' && CURRENCIES.has(data.currency) ? data.currency : null;
  const cards = [];
  let nodes = 0;
  function visit(component, path, depth = 0) {
    if (!object(component) || depth > 12 || ++nodes > 500) fail('SHEIN_SCHEMA_INVALID');
    const append = (list, location) => {
      if (list === undefined) return;
      if (!Array.isArray(list) || list.length > 100) fail('SHEIN_SCHEMA_INVALID');
      for (const row of list) cards.push({ row, location });
    };
    if (component.props?.items !== undefined) {
      if (!Array.isArray(component.props.items) || component.props.items.length > 100) fail('SHEIN_SCHEMA_INVALID');
      component.props.items.forEach((item, index) => append(item?.productList, `${path}.props.items[${index}].productList`));
    }
    for (const key of ['flashProductsV2', 'productsV2']) append(component.props?.metaData?.[key], `${path}.props.metaData.${key}`);
    if (component.content !== undefined) {
      if (!Array.isArray(component.content)) fail('SHEIN_SCHEMA_INVALID');
      component.content.forEach((child, index) => visit(child, `${path}.content[${index}]`, depth + 1));
    }
  }
  data.content.content.forEach((component, index) => visit(component, `gbRawData.content.content[${index}]`));
  if (!cards.length || cards.length > 500) fail('SHEIN_HTML_LAYOUT_CHANGED');
  const products = [];
  const seen = new Map();
  for (const { row, location } of cards) {
    if (!object(row) || !ID.test(row.goods_id ?? '') || typeof row.goods_id !== 'string'
      || !clean(row.goods_name) || row.goods_name.length > 1500) fail('SHEIN_PRODUCT_SCHEMA_INVALID');
    const product = {
      externalProductId: row.goods_id, title: clean(row.goods_name), productUrl: null,
      imageUrl: imageUrl(row.goods_img), externalCategoryId: ID.test(row.cat_id ?? '') ? String(row.cat_id) : null,
      salePrice: price(row.salePrice, currency, 'sale'),
      retailPrice: row.retailPrice == null ? null : price(row.retailPrice, currency, 'reference_retail'),
      stock: null, options: null, reviewCount: null, sourcePaths: [location],
    };
    const prior = seen.get(product.externalProductId);
    if (prior) {
      if (prior.title !== product.title || JSON.stringify(prior.salePrice) !== JSON.stringify(product.salePrice)
        || JSON.stringify(prior.retailPrice) !== JSON.stringify(product.retailPrice)) fail('SHEIN_CONFLICTING_PRODUCT_CARDS');
      prior.sourcePaths.push(location);
    } else { seen.set(product.externalProductId, product); products.push(product); }
  }
  return {
    source: 'shein', sourceUrl: `${ORIGIN}/`, dataChannel: 'public_http', sourceFormat: 'document_embedded_json',
    context: { marketplaceId: 'kr.shein.com', storefrontLocale: 'kr', currency, shipToCountry: null,
      currencySource: 'gbRawData.currency', shipToCountrySource: 'not_verified' },
    products, navigation: navigation(document),
    coverage: { scope: 'initial_home_document_cards_and_category_menu', completeCatalog: false,
      detailVerified: false, optionsVerified: false, reviewsVerified: false, paginationVerified: false },
  };
}

export function createSheinPublicClient({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') fail('SHEIN_CLIENT_INVALID');
  return {
    async getHomeCatalog() {
      const receipt = { method: 'GET', origin: ORIGIN, path: '/', checkedAt: new Date(now()).toISOString(),
        browserUsed: false, anonymous: true, cookieSent: false, credentialsUsed: false, queryFields: [] };
      let response;
      try { response = await fetchImpl(`${ORIGIN}/`, { method: 'GET', redirect: 'manual', credentials: 'omit',
        headers: { accept: 'text/html' }, signal: AbortSignal.timeout(15_000) }); }
      catch { fail('SHEIN_TRANSPORT_FAILED', receipt); }
      receipt.httpStatus = response.status;
      receipt.mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? null;
      if (response.status !== 200 || response.redirected || receipt.mime !== 'text/html') {
        await response.body?.cancel().catch(() => {});
        fail(response.status === 429 ? 'SHEIN_THROTTLED' : [401, 403, 418, 451].includes(response.status)
          ? 'SHEIN_ACCESS_BLOCKED' : 'SHEIN_RESPONSE_INVALID', receipt);
      }
      if (!response.body?.getReader) fail('SHEIN_BODY_UNREADABLE', receipt);
      const reader = response.body.getReader();
      const chunks = [];
      let bytes = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_BYTES) { await reader.cancel().catch(() => {}); fail('SHEIN_RESPONSE_TOO_LARGE', receipt); }
          chunks.push(value);
        }
      } catch (error) {
        if (error instanceof SheinPublicError) throw error;
        fail('SHEIN_TRANSPORT_FAILED', receipt);
      } finally { reader.releaseLock(); }
      const raw = Buffer.concat(chunks, bytes);
      receipt.responseBytes = bytes;
      let parsed;
      try { parsed = parseSheinHomeDocument(raw.toString('utf8')); }
      catch (error) { if (error instanceof SheinPublicError) error.receipt = receipt; throw error; }
      // Hash the public projection, not session-bearing source HTML.
      receipt.publicProjectionSha256 = createHash('sha256').update(JSON.stringify(parsed)).digest('hex');
      return { ...parsed, receipt: { ...receipt, schemaVerified: true, productCount: parsed.products.length,
        navigationCount: parsed.navigation.length, rawBodyPersisted: false } };
    },
  };
}
