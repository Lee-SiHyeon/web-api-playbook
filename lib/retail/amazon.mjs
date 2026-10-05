import { createHash } from 'node:crypto';
import { parseHTML } from 'linkedom';

const ORIGIN = 'https://www.amazon.com';
const PATH = '/s/query';
const MARKETPLACE = 'ATVPDKIKX0DER';
const MIME = 'application/json-amazonui-streaming';
const ACCEPT = 'text/html,image/webp,*/*';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_FRAMES = 128;
const ASIN = /^[A-Z0-9]{10}$/;
const ISO_CURRENCIES = new Set(Intl.supportedValuesOf('currency'));

export class AmazonPublicApiError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'AmazonPublicApiError';
    this.code = code;
    Object.assign(this, details);
  }
}

const fail = (code, details) => { throw new AmazonPublicApiError(code, details); };

function normalizedQuery(value) {
  if (typeof value !== 'string') fail('AMAZON_SEARCH_QUERY_INVALID');
  const query = value.trim().replace(/\s+/g, ' ');
  if (!query || query.length > 120 || /[\u0000-\u001f\u007f]/.test(query)) fail('AMAZON_SEARCH_QUERY_INVALID');
  return query;
}

function normalizedPage(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 20) fail('AMAZON_SEARCH_PAGE_INVALID');
  return value;
}

function text(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function price(node) {
  const displayed = text(node?.querySelector('.a-offscreen')?.textContent);
  if (!displayed) return null;
  const fixed = displayed.match(/^(?:(?<iso>[A-Z]{3})\s+|(?<symbol>[$€£¥₹])\s*)(?<value>(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)$/);
  const explicitCode = fixed?.groups.iso ?? null;
  const verifiedCode = explicitCode && ISO_CURRENCIES.has(explicitCode) ? explicitCode : null;
  return {
    displayText: displayed,
    amount: fixed ? fixed.groups.value.replaceAll(',', '') : null,
    currencyCode: verifiedCode,
    currencyCodeExplicit: Boolean(explicitCode),
    currencyVerified: Boolean(verifiedCode),
  };
}

function productCard(payload) {
  const asin = payload?.asin;
  if (!ASIN.test(asin ?? '') || typeof payload?.html !== 'string' ||
      Buffer.byteLength(payload.html) > 150_000) return null;
  const document = parseHTML(payload.html).document;
  const asinNodes = [...document.querySelectorAll('[data-asin]')];
  if (!asinNodes.some(node => node.getAttribute('data-asin') === asin)) return null;
  const matchingLink = [...document.querySelectorAll('a[href]')].some(node => {
    const href = node.getAttribute('href');
    return typeof href === 'string' && href.includes(`/dp/${asin}`);
  });
  if (!matchingLink) return null;
  const title = text(document.querySelector('h2 span')?.textContent);
  if (!title) return null;
  const priceNodes = [...document.querySelectorAll('.a-price')];
  const current = price(priceNodes.find(node => !node.classList.contains('a-text-price')));
  const struck = price(priceNodes.find(node => node.classList.contains('a-text-price')));
  let thumbnailUrl = null;
  const rawImage = document.querySelector('img.s-image')?.getAttribute('src');
  if (rawImage) {
    try {
      const parsed = new URL(rawImage);
      if (parsed.origin === 'https://m.media-amazon.com') thumbnailUrl = parsed.href;
    } catch { /* Invalid image URL is omitted, not followed. */ }
  }
  return {
    asin,
    title,
    productUrl: `${ORIGIN}/dp/${asin}`,
    thumbnailUrl,
    currentDisplayPrice: current,
    struckDisplayPrice: struck,
    priceBasis: 'displayed_search_card',
    ...(Number.isInteger(payload.index) ? { resultIndex: payload.index } : {}),
  };
}

/** Parse only the observed Amazon streaming XHR, never an HTML page document. */
export function parseAmazonSearchStream(raw, { query, page } = {}) {
  const expectedQuery = normalizedQuery(query);
  const expectedPage = normalizedPage(page);
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) fail('AMAZON_SEARCH_STREAM_INVALID');
  const chunks = raw.split('&&&').map(chunk => chunk.trim()).filter(Boolean);
  if (!chunks.length || chunks.length > MAX_FRAMES) fail('AMAZON_SEARCH_STREAM_INVALID');
  let metadata = null;
  let pageTitle = null;
  const items = [];
  const seen = new Set();
  const observedAsins = new Set();
  let resultFrames = 0;
  let namedResultFrames = 0;
  for (const chunk of chunks) {
    let frame;
    try { frame = JSON.parse(chunk); }
    catch { fail('AMAZON_SEARCH_STREAM_INVALID'); }
    if (!Array.isArray(frame) || frame.length !== 3 || frame[0] !== 'dispatch' ||
        typeof frame[1] !== 'string' || !frame[2] || typeof frame[2] !== 'object' || Array.isArray(frame[2])) {
      fail('AMAZON_SEARCH_STREAM_INVALID');
    }
    const [_, name, payload] = frame;
    if (typeof payload.html === 'string') {
      for (const match of payload.html.matchAll(/\bdata-asin=["']([A-Z0-9]{10})["']/g)) observedAsins.add(match[1]);
    }
    if (name === 'data-search-metadata') metadata = payload.metadata;
    if (name === 'data-title-and-meta') pageTitle = text(payload.title);
    if (name.startsWith('data-main-slot:search-result-')) {
      namedResultFrames++;
      const card = productCard(payload);
      if (card) {
        resultFrames++;
        if (!seen.has(card.asin)) { items.push(card); seen.add(card.asin); }
      }
    }
  }
  if (!metadata || typeof metadata !== 'object' || metadata.marketplaceId !== MARKETPLACE ||
      Number(metadata.page) !== expectedPage ||
      text(metadata.keywords).toLocaleLowerCase('en-US') !== expectedQuery.toLocaleLowerCase('en-US') ||
      !Number.isInteger(metadata.asinOnPageCount) || metadata.asinOnPageCount < 0 ||
      metadata.asinOnPageCount > 64 ||
      !pageTitle || !Array.isArray(items)) fail('AMAZON_SEARCH_METADATA_MISMATCH');
  const mainResultFrameCountMatched = namedResultFrames === items.length && resultFrames === items.length;
  const allAsinsOnPageCovered = mainResultFrameCountMatched &&
    metadata.asinOnPageCount === items.length &&
    [...observedAsins].every(asin => seen.has(asin));
  const partial = !allAsinsOnPageCovered;
  return {
    query: expectedQuery,
    page: expectedPage,
    marketplaceId: MARKETPLACE,
    locale: typeof metadata.locale === 'string' ? metadata.locale : null,
    pageTitle,
    reportedTotalResultCount: Number.isSafeInteger(metadata.totalResultCount) ? metadata.totalResultCount : null,
    reportedAsinsOnPage: metadata.asinOnPageCount,
    namedResultFrameCount: namedResultFrames,
    observedAsinCount: observedAsins.size,
    items,
    partial,
    mainResultFrameCountMatched,
    resultCountVerified: allAsinsOnPageCovered,
    allAsinsOnPageCovered,
    emptyPageObserved: metadata.asinOnPageCount === 0,
    paginationTerminationVerified: false,
  };
}

async function readBounded(response) {
  if (!response.body?.getReader) fail('AMAZON_RESPONSE_BODY_UNAVAILABLE');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        fail('AMAZON_RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), size);
}

export function createAmazonPublicClient({ fetchImpl = globalThis.fetch, timeoutMs = 12000 } = {}) {
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) {
    fail('AMAZON_CLIENT_OPTIONS_INVALID');
  }
  return Object.freeze({
    async searchProducts({ query, page = 1 } = {}) {
      const checkedQuery = normalizedQuery(query);
      const checkedPage = normalizedPage(page);
      const url = new URL(PATH, ORIGIN);
      url.searchParams.set('k', checkedQuery);
      url.searchParams.set('page', String(checkedPage));
      let response;
      try {
        response = await fetchImpl(url.href, {
          method: 'POST',
          headers: { accept: ACCEPT, 'content-type': 'application/json', origin: ORIGIN },
          body: JSON.stringify({ 'customer-action': 'pagination' }),
          redirect: 'manual',
          credentials: 'omit',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        fail('AMAZON_TRANSPORT_FAILED', { cause: error });
      }
      const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? null;
      if (response.status === 429) fail('AMAZON_RATE_LIMITED', { status: response.status });
      if (response.status !== 200) fail('AMAZON_HTTP_FAILED', { status: response.status });
      if (mime !== MIME) fail('AMAZON_RESPONSE_NOT_XHR', { status: response.status, mime });
      const body = await readBounded(response);
      const data = parseAmazonSearchStream(body.toString('utf8'), { query: checkedQuery, page: checkedPage });
      return {
        ...data,
        transport: 'anonymous_xhr_http',
        receipt: {
          method: 'POST', origin: ORIGIN, path: PATH, httpStatus: 200,
          mime, responseBytes: body.byteLength,
          responseSha256: createHash('sha256').update(body).digest('hex'),
          browserUsed: false, anonymous: true, cookieSent: false, readOnly: true,
          credentialsUsed: false, checkedAt: new Date().toISOString(),
          schemaVerified: true, expectedResultVerified: data.items.length > 0,
          resultScope: 'validated_main_search_cards',
          partial: data.partial,
          allAsinsOnPageCovered: data.allAsinsOnPageCovered,
        },
      };
    },
  });
}
