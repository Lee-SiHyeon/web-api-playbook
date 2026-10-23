import { createHash } from 'node:crypto';
import { parseHTML } from 'linkedom';

const ORIGIN = 'https://www.walmart.com';
const SEARCH_PATH = '/search';
const ACCEPT = 'text/html,application/xhtml+xml';
// This is the exact User-Agent sent by the successful direct HTTP probe. It is
// direct-client evidence only; it has not been confirmed by a browser capture.
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_PRODUCT_CARDS = 80;
const ITEM_ID = /^\d{6,20}$/;

export class WalmartPublicError extends Error {
  constructor(code, receipt = {}) {
    super(code);
    this.name = 'WalmartPublicError';
    this.code = code;
    this.receipt = receipt;
  }
}

const fail = (code, receipt) => { throw new WalmartPublicError(code, receipt); };
const text = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

function normalizedQuery(value) {
  if (typeof value !== 'string') fail('WALMART_SEARCH_QUERY_INVALID');
  if (/[\u0000-\u001f\u007f]/.test(value)) fail('WALMART_SEARCH_QUERY_INVALID');
  const query = value.trim().replace(/\s+/g, ' ');
  if (!query || query.length > 120 || /[\u0000-\u001f\u007f]/.test(query)) {
    fail('WALMART_SEARCH_QUERY_INVALID');
  }
  return query;
}

function safeWalmartItemUrl(rawHref) {
  if (typeof rawHref !== 'string' || rawHref.length > 4096) return null;
  let link;
  try { link = new URL(rawHref, ORIGIN); } catch { return null; }
  if (link.origin !== ORIGIN || link.username || link.password || link.hash) return null;
  if (link.pathname === '/sp/track') {
    const destination = link.searchParams.get('rd');
    if (!destination) return null;
    try { link = new URL(destination, ORIGIN); } catch { return null; }
  }
  if (link.origin !== ORIGIN || link.username || link.password || link.hash ||
      !/^\/ip\/(?:[^/]+\/)?\d{6,20}$/.test(link.pathname)) return null;
  const id = link.pathname.split('/').at(-1);
  return { id, url: `${ORIGIN}${link.pathname}` };
}

function titleAnchor(card, titleNode) {
  for (let current = titleNode; current && current !== card.parentElement; current = current.parentElement) {
    if (current.tagName === 'A' && current.getAttribute('href')) return current;
  }
  return [...card.querySelectorAll('a[href]')].find(anchor =>
    anchor.contains(titleNode) || text(anchor.textContent) === text(titleNode.textContent)) ?? null;
}

function imageUrl(card) {
  const image = card.querySelector('img');
  const raw = image?.getAttribute('src') ?? image?.getAttribute('data-src');
  if (!raw || raw.length > 2048) return null;
  try {
    const parsed = new URL(raw, ORIGIN);
    if (parsed.protocol !== 'https:' || !/^i\d+\.walmartimages\.com$/.test(parsed.hostname) ||
        parsed.username || parsed.password) return null;
    return parsed.href;
  } catch { return null; }
}

function displayedPrice(card) {
  const priceNode = card.querySelector('[data-automation-id="product-price"]');
  if (!priceNode) return null;
  const candidates = [priceNode, ...priceNode.querySelectorAll('*')]
    .map(node => text(node.textContent))
    .filter(value => /\bcurrent price\b/i.test(value))
    .sort((left, right) => left.length - right.length);
  const label = candidates[0];
  if (!label) return null;
  const current = label.match(/\bcurrent price\s*(?:Now\s*)?(?<symbol>\$)\s*(?<amount>(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)/i);
  if (!current) return null;
  const compareAt = label.match(/\bWas\s+\$\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)/i);
  return {
    amount: current.groups.amount.replaceAll(',', ''),
    currencySymbol: current.groups.symbol,
    currencyCode: null,
    currencyCodeExplicit: false,
    displayText: label,
    compareAtAmount: compareAt?.[1]?.replaceAll(',', '') ?? null,
  };
}

function productCard(card) {
  const sourceItemId = card.getAttribute('data-item-id');
  const titleNode = card.querySelector('[data-automation-id="product-title"]');
  const title = text(titleNode?.textContent);
  if (!sourceItemId || !/^[a-z\d]{1,32}$/i.test(sourceItemId) || !title || title.length > 500) return null;
  const anchor = titleAnchor(card, titleNode);
  const destination = safeWalmartItemUrl(anchor?.getAttribute('href'));
  if (!destination || (ITEM_ID.test(sourceItemId) && destination.id !== sourceItemId)) return null;
  return {
    id: destination.id,
    sourceItemId,
    title,
    productUrl: destination.url,
    imageUrl: imageUrl(card),
    displayedPrice: displayedPrice(card),
  };
}

function normalizeCardCollection(document) {
  const candidates = [...document.querySelectorAll('[data-item-id]')]
    .filter(card => card.querySelector('[data-automation-id="product-title"]'));
  if (candidates.length > MAX_PRODUCT_CARDS) fail('WALMART_SEARCH_SCHEMA_INVALID');
  const products = [];
  const seen = new Map();
  let unboundCardCount = 0;
  for (const card of candidates) {
    const parsed = productCard(card);
    if (!parsed) {
      unboundCardCount++;
      continue;
    }
    const existing = seen.get(parsed.id);
    if (existing) {
      if (existing.title !== parsed.title || existing.productUrl !== parsed.productUrl) {
        fail('WALMART_SEARCH_IDENTITY_CONFLICT');
      }
      continue;
    }
    seen.set(parsed.id, parsed);
    products.push(parsed);
  }
  const productsWithPrice = products.filter(product => product.displayedPrice).length;
  const productsWithImage = products.filter(product => product.imageUrl).length;
  const partial = products.length === 0 || unboundCardCount > 0 ||
    productsWithPrice < products.length || productsWithImage < products.length;
  return {
    products,
    coverage: {
      productCardCandidates: candidates.length,
      productsReturned: products.length,
      productsWithPrice,
      productsWithImage,
      unboundCardCount,
      pageScope: 'one_observed_search_document',
      pagination: { observed: false, hasNext: null, completeCatalog: false },
      partial,
    },
  };
}

export function parseWalmartSearchDocument(body, { query } = {}) {
  const expectedQuery = normalizedQuery(query);
  if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
    fail('WALMART_SEARCH_DOCUMENT_INVALID');
  }
  const document = parseHTML(body).document;
  const pageTitle = text(document.querySelector('title')?.textContent);
  if (/robot or human|captcha|access denied/i.test(pageTitle)) fail('WALMART_CHALLENGE_RESPONSE');
  if (!pageTitle.toLocaleLowerCase('en-US').includes(expectedQuery.toLocaleLowerCase('en-US'))) {
    fail('WALMART_SEARCH_QUERY_MISMATCH');
  }
  const parsed = normalizeCardCollection(document);
  if (parsed.coverage.productCardCandidates === 0) fail('WALMART_SEARCH_SCHEMA_INVALID');
  return {
    query: expectedQuery,
    pageTitle,
    ...parsed,
    completeCatalog: false,
  };
}

async function readBounded(response, receipt) {
  if (!response.body?.getReader) fail('WALMART_RESPONSE_BODY_UNAVAILABLE', receipt);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        fail('WALMART_RESPONSE_TOO_LARGE', { ...receipt, responseBytes: size });
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

export function createWalmartPublicClient({ fetchImpl = globalThis.fetch, now = Date.now,
  timeoutMs = 15_000 } = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30_000) {
    fail('WALMART_CLIENT_OPTIONS_INVALID');
  }
  return Object.freeze({
    async searchProducts({ query } = {}) {
      const checkedQuery = normalizedQuery(query);
      const url = new URL(SEARCH_PATH, ORIGIN);
      url.searchParams.set('q', checkedQuery);
      const baseReceipt = {
        schema: 'web-api-public-read-receipt-v1',
        capabilityId: 'catalog.search',
        request: {
          method: 'GET', origin: ORIGIN, path: SEARCH_PATH,
          queryFields: ['q'], headerNames: ['accept', 'user-agent'],
          explicitHeadersSent: { accept: ACCEPT, 'user-agent': USER_AGENT },
          userAgentProfile: 'explicit_chrome_131_direct_probe',
          browserUsed: false, anonymous: true, credentialsUsed: false,
          cookieSent: false, readOnly: true,
        },
      };
      let response;
      try {
        response = await fetchImpl(url.href, {
          method: 'GET',
          headers: { accept: ACCEPT, 'user-agent': USER_AGENT },
          redirect: 'follow',
          credentials: 'omit',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        fail('WALMART_TRANSPORT_FAILED', { ...baseReceipt, causeCode:
          error?.name === 'TimeoutError' ? 'TIMEOUT' : 'TRANSPORT_ERROR' });
      }
      const mime = response.headers?.get?.('content-type')?.split(';')[0]?.trim()?.toLowerCase() ?? null;
      const statusReceipt = {
        ...baseReceipt,
        checkedAt: new Date(now()).toISOString(),
        request: { ...baseReceipt.request, httpStatus: response.status, mime,
          responseRedirected: Boolean(response.redirected) },
      };
      if (response.status === 401) fail('WALMART_AUTH_REQUIRED', statusReceipt);
      if (response.status === 403) fail('WALMART_ACCESS_BLOCKED', statusReceipt);
      if (response.status === 429) fail('WALMART_THROTTLED', statusReceipt);
      if (response.status !== 200) fail('WALMART_HTTP_FAILED', statusReceipt);
      if (mime !== 'text/html') fail('WALMART_RESPONSE_INVALID', statusReceipt);
      let finalUrl;
      try { finalUrl = new URL(response.url || url.href); } catch { fail('WALMART_RESPONSE_INVALID', statusReceipt); }
      const bytes = await readBounded(response, statusReceipt);
      const body = new TextDecoder('utf-8').decode(bytes);
      const responseEvidence = {
        ...statusReceipt,
        responseBytes: bytes.byteLength,
        responseSha256: createHash('sha256').update(bytes).digest('hex'),
      };
      if (finalUrl.origin !== ORIGIN || finalUrl.pathname !== SEARCH_PATH ||
          finalUrl.username || finalUrl.password || finalUrl.hash) {
        const responseTitle = text(parseHTML(body).document.querySelector('title')?.textContent).slice(0, 200);
        const challenge = /robot or human|captcha|access denied/i.test(responseTitle);
        fail(challenge ? 'WALMART_CHALLENGE_RESPONSE' : 'WALMART_UNEXPECTED_ROUTE', {
          ...responseEvidence,
          finalOrigin: finalUrl.origin,
          finalPath: finalUrl.pathname,
          responseTitle,
          challenge,
        });
      }
      let data;
      try { data = parseWalmartSearchDocument(body, { query: checkedQuery }); }
      catch (error) {
        if (error instanceof WalmartPublicError) {
          error.receipt = { ...responseEvidence, ...(error.receipt ?? {}) };
          throw error;
        }
        fail('WALMART_SEARCH_SCHEMA_INVALID', responseEvidence);
      }
      return {
        ...data,
        receipt: {
          ...responseEvidence,
          request: { ...statusReceipt.request, finalOrigin: finalUrl.origin,
            finalPath: finalUrl.pathname },
          responseBytes: bytes.byteLength,
          responseSha256: createHash('sha256').update(bytes).digest('hex'),
          productCardCandidates: data.coverage.productCardCandidates,
          productsReturned: data.products.length,
          productsWithPrice: data.coverage.productsWithPrice,
          productsWithImage: data.coverage.productsWithImage,
          unboundCardCount: data.coverage.unboundCardCount,
          paginationObserved: false,
          completeCatalog: false,
        },
      };
    },
  });
}
