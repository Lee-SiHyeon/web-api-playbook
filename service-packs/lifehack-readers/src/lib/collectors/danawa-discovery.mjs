// Bounded anonymous Danawa search + exact product-page inspection used by the
// scheduled catalog discovery job. Search snippets are hints only: a candidate
// is registered only after the exact pcode page and its own mall list validate.
import { danawaOfferIdentity, parseMallList, parseProductPage } from './danawa.mjs';

const SEARCH_ORIGIN = 'https://search.danawa.com';
const SEARCH_PATH = '/dsearch.php';
const PRODUCT_ORIGIN = 'https://prod.danawa.com';
const PRODUCT_PATH = '/info/';
const MALL_LIST_PATH = '/info/ajax/getAllPriceCompareMallList.ajax.php';
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024;
const MAX_SEARCH_CANDIDATES = 80;
const MAX_PRODUCT_OFFERS = 60;
const REQUEST_TIMEOUT_MS = 20_000;
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class DanawaDiscoveryError extends Error {
  constructor(code) {
    super(code);
    this.name = 'DanawaDiscoveryError';
    this.code = code;
  }
}

function fail(code) { throw new DanawaDiscoveryError(code); }

function text(value) {
  return String(value ?? '').replace(/<\/?(b|strong|em)>/g, '').replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&#([0-9]+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ').trim();
}

function positiveWon(value) {
  const amount = Number(String(value ?? '').replace(/[^\d]/g, ''));
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

function optionLabel(block) {
  const value = text(/<p class="memory_sect">[\s\S]*?<span class="text">([\s\S]*?)<\/span>/.exec(block)?.[1]);
  return value && value.length <= 120 ? value : null;
}

/** Parse only Danawa's observed search-result structures into exact option pcodes. */
export function parseDanawaSearch(html) {
  const source = String(html);
  const names = new Map();
  for (const match of source.matchAll(/<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(match[1]); } catch { continue; }
    if (data?.['@type'] !== 'ItemList' || !Array.isArray(data.itemListElement)) continue;
    for (const entry of data.itemListElement) {
      const pcode = /[?&]pcode=(\d{1,20})\b/.exec(String(entry?.url ?? ''))?.[1];
      if (pcode && typeof entry.name === 'string' && entry.name.trim().length <= 240) names.set(pcode, entry.name.trim());
    }
  }

  const out = [];
  const seen = new Set();
  const items = [...source.matchAll(/id="productItem(\d{1,20})"/g)];
  for (let index = 0; index < items.length && out.length < MAX_SEARCH_CANDIDATES; index++) {
    const basePcode = items[index][1];
    const block = source.slice(items[index].index, items[index + 1]?.index ?? source.length);
    const baseName = names.get(basePcode) ?? text(/<p class="prod_name">([\s\S]*?)<\/p>/.exec(block)?.[1]);
    if (!baseName || baseName.length > 240) continue;

    const options = [...block.matchAll(/<li id="productInfoDetail_(\d{1,20})"[\s\S]*?(?=<li id="productInfoDetail_|<\/ul>)/g)];
    if (!options.length) {
      const minPrice = positiveWon(new RegExp(`id="min_price_${basePcode}"\\s*value="([\\d,]+)"`).exec(block)?.[1]);
      if (minPrice && !seen.has(basePcode)) {
        seen.add(basePcode);
        out.push({ pcode: basePcode, basePcode, name: baseName, label: null, minPrice });
      }
      continue;
    }

    for (const option of options) {
      if (out.length >= MAX_SEARCH_CANDIDATES) break;
      const pcode = option[1];
      const optionBlock = option[0];
      const price = positiveWon(/<p class="price_sect">[\s\S]*?<strong>([\d,]+)<\/strong>/.exec(optionBlock)?.[1]);
      if (!price || seen.has(pcode)) continue;
      seen.add(pcode);
      out.push({ pcode, basePcode, name: names.get(pcode) ?? baseName, label: optionLabel(optionBlock), minPrice: price });
    }
  }

  if (items.length === 0 && !/(검색\s*결과가\s*없|검색된\s*상품이\s*없|조회된\s*상품이\s*없)/.test(text(source))) {
    fail('DANAWA_SEARCH_SCHEMA');
  }
  return out;
}

function assertUrl(url, origin, pathname) {
  if (url.origin !== origin || url.pathname !== pathname || url.username || url.password || url.port || url.hash) {
    fail('DANAWA_REQUEST_SCOPE');
  }
}

async function readResponse(response, signal) {
  if (response.status === 401 || response.status === 403 || response.status === 418) fail('DANAWA_ACCESS_BLOCKED');
  if (response.status === 429) fail('DANAWA_RATE_LIMITED');
  if (response.status >= 300 && response.status < 400) fail('DANAWA_REDIRECT_REJECTED');
  if (response.status !== 200) fail('DANAWA_HTTP_STATUS');
  if (!/^text\/html\b/i.test(response.headers.get('content-type') ?? '')) fail('DANAWA_CONTENT_TYPE');

  const length = response.headers.get('content-length');
  if (length && Number(length) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    fail('DANAWA_RESPONSE_TOO_LARGE');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) fail('DANAWA_CANCELLED');
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        fail('DANAWA_RESPONSE_TOO_LARGE');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

async function requestText(url, { method = 'GET', body, referer, signal, fetchImpl }) {
  const expectedOrigin = url.origin === SEARCH_ORIGIN ? SEARCH_ORIGIN : PRODUCT_ORIGIN;
  const expectedPath = url.origin === SEARCH_ORIGIN ? SEARCH_PATH : method === 'POST' ? MALL_LIST_PATH : PRODUCT_PATH;
  assertUrl(url, expectedOrigin, expectedPath);
  if (url.origin === SEARCH_ORIGIN && method !== 'GET') fail('DANAWA_REQUEST_SCOPE');

  let response;
  try {
    response = await fetchImpl(url, {
      method,
      body,
      redirect: 'manual',
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      headers: {
        'user-agent': USER_AGENT,
        'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        ...(method === 'POST' ? {
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'x-requested-with': 'XMLHttpRequest',
          referer,
        } : {}),
      },
    });
  } catch (error) {
    if (error instanceof DanawaDiscoveryError) throw error;
    fail(signal.aborted ? 'DANAWA_CANCELLED' : 'DANAWA_TRANSPORT');
  }
  return readResponse(response, signal);
}

/** Use a query selected from the reviewed, database-seeded search rotation. */
export async function searchDanawaProducts(query, { fetchImpl = globalThis.fetch, signal = new AbortController().signal } = {}) {
  if (typeof query !== 'string' || !query.trim() || query.length > 100) fail('DANAWA_QUERY_INVALID');
  const url = new URL(SEARCH_PATH, SEARCH_ORIGIN);
  url.searchParams.set('query', query.trim());
  const html = await requestText(url, { signal, fetchImpl });
  return parseDanawaSearch(html);
}

function sleep(ms, signal, sleepImpl) {
  if (signal.aborted) return Promise.reject(new DanawaDiscoveryError('DANAWA_CANCELLED'));
  return sleepImpl(ms, signal);
}

/** Verify an exact pcode and return up to five current, unconditional seller targets. */
export async function readDanawaProductOffers(pcode, { fetchImpl = globalThis.fetch, signal = new AbortController().signal,
  sleepImpl = (ms, abortSignal) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    abortSignal.addEventListener('abort', () => { clearTimeout(timer); reject(new DanawaDiscoveryError('DANAWA_CANCELLED')); }, { once: true });
  }) } = {}) {
  if (typeof pcode !== 'string' || !/^[1-9][0-9]{0,19}$/.test(pcode)) fail('DANAWA_PCODE_INVALID');
  const productUrl = new URL(PRODUCT_PATH, PRODUCT_ORIGIN);
  productUrl.searchParams.set('pcode', pcode);
  const pageHtml = await requestText(productUrl, { signal, fetchImpl });
  const page = parseProductPage(pageHtml, pcode);

  await sleep(1_000, signal, sleepImpl);
  const formBody = new URLSearchParams(Object.entries(page.form).map(([key, value]) => [key, String(value)])).toString();
  const mallUrl = new URL(MALL_LIST_PATH, PRODUCT_ORIGIN);
  const mallHtml = await requestText(mallUrl, { method: 'POST', body: formBody, referer: productUrl.href, signal, fetchImpl });
  const eligible = parseMallList(mallHtml)
    .filter((row) => !row.couponRequired && !row.warranty && /^[A-Za-z0-9]{1,24}$/.test(row.mallCode));
  const listingsByMall = new Map();
  for (const row of eligible) {
    if (!listingsByMall.has(row.mallCode)) listingsByMall.set(row.mallCode, new Map());
    listingsByMall.get(row.mallCode).set(danawaOfferIdentity(row), row);
  }
  // Existing targets identify only pcode + mall. Register a target only when
  // that identity currently resolves to one distinct eligible merchant listing.
  const sellers = [...listingsByMall.values()]
    .filter((listings) => listings.size === 1)
    .map((listings) => [...listings.values()][0])
    .sort((a, b) => {
      const totalA = a.shipping === null ? null : a.price + a.shipping;
      const totalB = b.shipping === null ? null : b.price + b.shipping;
      if (totalA !== null && totalB !== null && totalA !== totalB) return totalA - totalB;
      if (totalA !== null && totalB === null) return -1;
      if (totalA === null && totalB !== null) return 1;
      return a.price - b.price;
    });

  const offers = sellers.slice(0, MAX_PRODUCT_OFFERS).slice(0, 3);
  if (!offers.length) fail(eligible.length ? 'DANAWA_OFFER_AMBIGUOUS' : 'DANAWA_NO_ELIGIBLE_SELLERS');
  const conditions = [];
  if (/(해외구매|해외직구|직구)/i.test(page.name)) conditions.push('해외구매 · 관세·통관비 미확인');
  if (/병행수입/.test(page.name)) conditions.push('병행수입 · 추가비용·보증범위 미확인');
  return {
    pcode,
    name: page.name,
    brand: typeof page.form.makerName === 'string' ? page.form.makerName.slice(0, 100) : '',
    conditions,
    offers: offers.map((offer) => ({
      mallCode: offer.mallCode,
      seller: offer.mall,
      itemPrice: offer.price,
      shipping: offer.shipping,
      conditions,
    })),
  };
}

export const DISCOVERY_LIMITS = Object.freeze({ maxSearchCandidates: MAX_SEARCH_CANDIDATES, maxSellerTargetsPerProduct: 3 });
