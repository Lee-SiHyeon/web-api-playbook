// Bounded Danawa product-option price-list adapter.
// Contract source: Lee-SiHyeon/affiliate-content-operations main
// 42cab3f3b45c98c5478ce4b9fafe7a078357cdea, apps/naver-blog-api/research/content-store/danawa-prices.mjs.
// Reads only the observed product page and its own public mall-list request. No browser, cookies,
// account session, arbitrary URL, retries, or affiliate-link creation.

const PRODUCT_ORIGIN = 'https://prod.danawa.com';
const PRODUCT_PATH = '/info/';
const MALL_LIST_PATH = '/info/ajax/getAllPriceCompareMallList.ajax.php';
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const REQUEST_SPACING_MS = 1_000;
const OBSERVATION_TTL_MS = 6 * 60 * 60 * 1000;
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class DanawaCollectorError extends Error {
  constructor(code) {
    super(code);
    this.name = 'DanawaCollectorError';
    this.code = code;
  }
}

function fail(code) { throw new DanawaCollectorError(code); }

function parseTarget(sourceOfferId) {
  if (typeof sourceOfferId !== 'string' || sourceOfferId.length > 250) fail('DANAWA_TARGET_INVALID');
  const match = /^danawa:([1-9][0-9]{0,19}):([A-Za-z0-9]{1,24})$/.exec(sourceOfferId);
  if (!match) fail('DANAWA_TARGET_INVALID');
  return { pcode: match[1], mallCode: match[2] };
}

function escapeHtmlText(value) {
  return String(value ?? '').replace(/<\/?(b|strong|em)>/g, '').replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function positiveWon(value) {
  const amount = Number(String(value ?? '').replace(/[^\d]/g, ''));
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

function inlineObject(html, name) {
  const match = new RegExp(`var ${name}\\s*=\\s*\\{([\\s\\S]*?)\\};`).exec(String(html));
  if (!match) return null;
  const result = {};
  for (const pair of match[1].matchAll(/(\w+)\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    try { result[pair[1]] = JSON.parse(`"${pair[2]}"`); } catch { fail('DANAWA_PRODUCT_SCHEMA'); }
  }
  for (const pair of match[1].matchAll(/(\w+)\s*:\s*(\d+)\s*[,\n]/g)) result[pair[1]] ??= pair[2];
  return result;
}

function parseProductPage(html, expectedPcode) {
  const global = inlineObject(html, 'oGlobalSetting');
  const settings = inlineObject(html, 'oPriceCompareSetting');
  if (!global?.nProductCode || !settings || String(global.nProductCode) !== expectedPcode) fail('DANAWA_PRODUCT_IDENTITY');
  const productName = String(global.sProductName ?? settings.sProductFullName ?? '').trim();
  if (!productName || productName.length > 240) fail('DANAWA_PRODUCT_SCHEMA');
  const form = {
    pcode: global.nProductCode,
    cate1: global.nCategoryCode1 ?? '',
    cate2: global.nCategoryCode2 ?? '',
    cate3: global.nCategoryCode3 ?? '',
    cate4: global.nCategoryCode4 ?? '',
    UICategoryCode: global.nCategoryCode || 0,
    powerLinkKeyword: global.powerLinkKeyword ?? '',
    minPrice: global.nMinPrice ?? '',
    keyword: global.sKeyword ?? '',
    NaPm: global.sNaPm ?? '',
    ...Object.fromEntries(Object.entries(settings).filter(([key]) => key !== 'sLoginUrl' && key !== 'sProductFullName')),
    makerCode: global.makerCode ?? '',
    makerName: global.makerName ?? '',
  };
  return { pcode: expectedPcode, name: productName, form };
}

// A marketplace code alone can represent many independent merchant listings.
// Include the upstream listing identity and all parsed option/price conditions
// before treating repeated rows as evidence for the same offer.
function danawaOfferIdentity(row) {
  return JSON.stringify([row.listingId, row.listingUrl, row.mallCode, row.mall,
    row.price, row.shipping, row.shippingText, row.title, row.section,
    row.couponRequired, row.warranty]);
}

function parseMallList(html) {
  const source = String(html);
  const headings = [...source.matchAll(/<h4>([^<]*)<\/h4>/g)].map((match) => ({ at: match.index, section: match[1].trim() }));
  const seen = new Set();
  const result = [];
  for (const match of source.matchAll(/<div class="diff_item[^\"]*"\s+data-linkProduct="([^\"]+)"[^>]*>([\s\S]*?)(?=<div class="diff_item|<input type="hidden"|$)/g)) {
    const linkProduct = match[1];
    const code = linkProduct.split('_', 1)[0];
    if (!/^[A-Za-z0-9]{1,24}_[A-Za-z0-9-]{1,120}$/.test(linkProduct)) continue;
    const block = match[2];
    const price = positiveWon(/<em class="prc_c">([^<]*)<\/em>/.exec(block)?.[1]);
    if (price === null) continue;
    const mall = (/<div class="d_mall">[\s\S]*?<img[^>]*alt="([^\"]*)"/.exec(block)?.[1]
      ?? escapeHtmlText(/<div class="d_mall">([\s\S]*?)<div class="report">/.exec(block)?.[1])).trim();
    if (!mall || mall.length > 200) continue;
    const shippingText = escapeHtmlText(/<span class="ship">([\s\S]*?)<\/span>/.exec(block)?.[1]);
    const shipping = /무료/.test(shippingText) ? 0 : positiveWon(/배송비\s*([\d,]+)/.exec(shippingText)?.[1]);
    const title = escapeHtmlText(/<div class="info_line">([\s\S]*?)<\/div>/.exec(block)?.[1]);
    const section = headings.filter((heading) => heading.at < match.index).at(-1)?.section ?? null;
    const couponRequired = /쿠폰/.test(block);
    const warranty = /class="[^"]*warranty|>보증</.test(block);
    const href = /<a\b[^>]*\bhref="(https?:\/\/[^\"]+)"/i.exec(block)?.[1];
    let listingUrl = null;
    if (href && href.length <= 3000) {
      try {
        const url = new URL(href.replaceAll('&amp;', '&'));
        if (!url.username && !url.password) listingUrl = url.href;
      } catch { /* The reviewed listing ID still supplies upstream identity. */ }
    }
    const row = { mall, mallCode: code, listingId: linkProduct, listingUrl,
      price, shipping, shippingText: shippingText || null,
      title: title || null, section, couponRequired, warranty };
    const duplicateKey = danawaOfferIdentity(row);
    if (seen.has(duplicateKey)) continue;
    seen.add(duplicateKey);
    result.push(row);
  }
  return result;
}

async function boundedText(response) {
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    fail('DANAWA_RESPONSE_TOO_LARGE');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
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

function safeRequestUrl(url, method) {
  if (url.origin !== PRODUCT_ORIGIN || url.username || url.password || url.port || url.hash) fail('DANAWA_REQUEST_SCOPE');
  if (method === 'GET' && (url.pathname !== PRODUCT_PATH || [...url.searchParams.keys()].join(',') !== 'pcode')) fail('DANAWA_REQUEST_SCOPE');
  if (method === 'POST' && (url.pathname !== MALL_LIST_PATH || url.search)) fail('DANAWA_REQUEST_SCOPE');
}

async function getText(url, { method, body, referer, signal, fetchImpl }) {
  safeRequestUrl(url, method);
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
    if (error instanceof DanawaCollectorError) throw error;
    fail(signal?.aborted ? 'DANAWA_CANCELLED' : 'DANAWA_TRANSPORT');
  }
  if (response.status === 403 || response.status === 401 || response.status === 418) fail('DANAWA_ACCESS_BLOCKED');
  if (response.status === 429) fail('DANAWA_RATE_LIMITED');
  if (response.status >= 300 && response.status < 400) fail('DANAWA_REDIRECT_REJECTED');
  if (response.status !== 200) fail('DANAWA_HTTP_STATUS');
  const mime = response.headers.get('content-type') ?? '';
  if (!/^text\/html\b/i.test(mime)) fail('DANAWA_CONTENT_TYPE');
  return boundedText(response);
}

async function pause(ms, signal, sleepImpl) {
  if (signal?.aborted) fail('DANAWA_CANCELLED');
  await sleepImpl(ms, signal);
  if (signal?.aborted) fail('DANAWA_CANCELLED');
}

/** Read one reviewed `danawa:<pcode>:<mallCode>` source target without writing it anywhere. */
export async function readDanawaTarget(sourceOfferId, options = {}) {
  const target = parseTarget(sourceOfferId);
  const signal = options.signal ?? new AbortController().signal;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const sleepImpl = options.sleepImpl ?? ((ms, abortSignal) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    abortSignal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DanawaCollectorError('DANAWA_CANCELLED')); }, { once: true });
  }));
  const now = options.now ?? (() => new Date());
  if (signal.aborted) fail('DANAWA_CANCELLED');

  const pageUrl = new URL(PRODUCT_PATH, PRODUCT_ORIGIN);
  pageUrl.searchParams.set('pcode', target.pcode);
  const pageHtml = await getText(pageUrl, { method: 'GET', signal, fetchImpl });
  const page = parseProductPage(pageHtml, target.pcode);

  await pause(REQUEST_SPACING_MS, signal, sleepImpl);
  const body = new URLSearchParams(Object.entries(page.form).map(([key, value]) => [key, String(value)])).toString();
  const mallUrl = new URL(MALL_LIST_PATH, PRODUCT_ORIGIN);
  const mallHtml = await getText(mallUrl, { method: 'POST', body, referer: pageUrl.href, signal, fetchImpl });
  const rows = parseMallList(mallHtml).filter((row) => row.mallCode === target.mallCode && !row.couponRequired && !row.warranty);
  const distinct = new Map(rows.map((row) => [danawaOfferIdentity(row), row]));
  if (distinct.size === 0) fail('DANAWA_GENERAL_OFFER_UNAVAILABLE');
  if (distinct.size !== 1) fail('DANAWA_OFFER_AMBIGUOUS');
  const offer = [...distinct.values()][0];
  const observedAt = now().toISOString();
  return {
    source: 'other',
    sourceOfferId,
    seller: offer.mall,
    itemPrice: offer.price,
    shipping: offer.shipping,
    currency: 'KRW',
    conditions: [],
    stock: 'unknown',
    observedAt,
    validUntil: new Date(Date.parse(observedAt) + OBSERVATION_TTL_MS).toISOString(),
    merchantUrl: pageUrl.href,
  };
}

/**
 * Worker entry point. A target covers one Danawa product option and one mall code;
 * ambiguity, coupon-only rows, blocked responses, and schema changes fail closed.
 */
export async function collect(job, context, options = {}) {
  if (!job || job.source !== 'other' || typeof job.productId !== 'string' || !job.productId) fail('DANAWA_JOB_INVALID');
  if (!context || !(context.signal instanceof AbortSignal) || typeof context.createEventId !== 'function') fail('DANAWA_CONTEXT_INVALID');
  const observation = await readDanawaTarget(job.sourceOfferId, { ...options, signal: context.signal });
  const base = { productId: job.productId, ...observation };
  return [{ eventId: context.createEventId(base), ...base }];
}

export { danawaOfferIdentity, parseMallList, parseProductPage, parseTarget };
