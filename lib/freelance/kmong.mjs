import { createHash } from 'node:crypto';
import { parseHTML } from 'linkedom';

const SERVICE = 'kmong';
const WEB_ORIGIN = 'https://kmong.com';
const API_ORIGIN = 'https://api.kmong.com';
const SEARCH_BUNDLE_URL = WEB_ORIGIN + '/_next-market-desktop/_next/static/chunks/0g7pmw2wpij3i.js';
const RUNTIME_CONFIG_URL = WEB_ORIGIN + '/dynamic-env.js';
const MAX_HTML_BYTES = 3 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_CARDS = 100;
const MAX_REVIEWS_PER_PAGE = 5;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

export class KmongReadError extends Error {
  constructor(code, receipt = {}) {
    super(code);
    this.name = 'KmongReadError';
    this.code = code;
    this.service = SERVICE;
    this.receipt = receipt;
  }
}

const fail = (code, receipt) => { throw new KmongReadError('KMONG_' + code, receipt); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function checkedAt(now) {
  let value;
  try { value = now(); } catch { fail('CLOCK_INVALID'); }
  const millis = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(millis)) fail('CLOCK_INVALID');
  try { return new Date(millis).toISOString(); } catch { fail('CLOCK_INVALID'); }
}

function safeText(value, max = 20_000) {
  return typeof value === 'string' && value.length <= max && !CONTROL.test(value);
}

function cleanText(value, max = 20_000) {
  if (!safeText(value, max)) return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized || null;
}

function safeId(value) {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof id !== 'string' || !/^[1-9]\d{0,19}$/.test(id)) fail('ID_INVALID');
  return id;
}

function safePage(value, label, max) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) fail(label + '_INVALID');
  return value;
}

function safeDocumentUrl(value, expectedPath = null) {
  let url;
  try { url = new URL(value); } catch { fail('URL_INVALID'); }
  if (url.protocol !== 'https:' || url.origin !== WEB_ORIGIN || url.username || url.password ||
      url.port || url.hash || (expectedPath && url.pathname !== expectedPath)) fail('URL_ORIGIN_REJECTED');
  return url;
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readBounded(response, maxBytes, receipt) {
  if (!response.body?.getReader) fail('BODY_UNREADABLE', receipt);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        fail('RESPONSE_TOO_LARGE', { ...receipt, responseBytes: total });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function mimeOf(response) {
  return response.headers?.get?.('content-type')?.split(';')[0]?.trim().toLowerCase() ?? null;
}

async function request({ url, kind, fetchImpl, observedAt, contractProvenance = null, referer = null }) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || ![WEB_ORIGIN, API_ORIGIN].includes(target.origin) ||
      target.username || target.password || target.port || target.hash) fail('REQUEST_ORIGIN_REJECTED');
  const receiptBase = {
    method: 'GET', origin: target.origin, path: target.pathname,
    queryFields: [...new Set([...target.searchParams.keys()])].sort(),
    observedAt, browserUsed: false, authenticated: false,
    credentialsUsed: false, cookiesSent: false, readOnly: true,
    contractProvenance: {
      kind: 'first_party_document',
      sourceURL: kind === 'review-json' ? null : target.origin + target.pathname,
    },
  };
  if (contractProvenance) receiptBase.contractProvenance = contractProvenance;
  let response;
  try {
    response = await fetchImpl(target.href, {
      method: 'GET',
      headers: {
        accept: kind.endsWith('-json') ? 'application/json' : 'text/html,application/xhtml+xml',
        ...(kind === 'review-json' ? { referer: WEB_ORIGIN + '/gig/' + target.pathname.split('/').at(-1) } : {}),
        ...(referer ? { referer } : {}),
      },
      redirect: 'manual',
      credentials: 'omit',
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    fail(error?.name === 'TimeoutError' ? 'HTTP_TIMEOUT' : 'HTTP_TRANSPORT_FAILED', {
      ...receiptBase, causeCode: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'TRANSPORT_ERROR',
    });
  }
  const mime = mimeOf(response);
  const responseReceipt = {
    ...receiptBase, httpStatus: response.status, mime,
    responseURL: receiptBase.origin + receiptBase.path,
    redirectFollowed: false,
  };
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel().catch(() => {});
    fail('REDIRECT_REJECTED', responseReceipt);
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    fail('HTTP_STATUS_INVALID', responseReceipt);
  }
  const expectedMime = kind.endsWith('-json') ? 'application/json' : 'text/html';
  if (mime !== expectedMime) {
    await response.body?.cancel().catch(() => {});
    fail(kind.endsWith('-json') && mime === 'text/html' ? 'CHALLENGE_OR_LOGIN_HTML' : 'HTTP_MIME_INVALID', responseReceipt);
  }
  const bytes = await readBounded(response, kind.endsWith('-json') ? MAX_JSON_BYTES : MAX_HTML_BYTES, responseReceipt);
  let body;
  try { body = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail('UTF8_INVALID', { ...responseReceipt, responseBytes: bytes.length }); }
  const requestReceipt = {
    ...responseReceipt, responseBytes: bytes.length, responseSha256: digest(bytes),
  };
  if (kind.endsWith('-json')) {
    try { body = JSON.parse(body); }
    catch { fail('JSON_INVALID', requestReceipt); }
  }
  return { body, receipt: requestReceipt };
}

function dom(html, receipt) {
  if (!safeText(html, MAX_HTML_BYTES)) fail('HTML_INVALID', receipt);
  const lower = html.slice(0, 20_000).toLowerCase();
  if (/<input\b[^>]*type\s*=\s*["']?password/i.test(html) ||
      /<title[^>]*>[^<]*(?:sign in|log in|로그인|보안 확인|captcha)/i.test(html) ||
      /captcha|unusual traffic|access denied|자동 입력 방지|보안문자/i.test(lower)) {
    fail('LOGIN_OR_CHALLENGE_PAGE', receipt);
  }
  return parseHTML(html).document;
}

function anchors(document, selector = 'a[href]') {
  return [...document.querySelectorAll(selector)];
}

function normalizeCategory(anchor) {
  const href = anchor.getAttribute('href');
  const match = /^\/category\/(\d{1,12})\/?$/.exec(href ?? '');
  const title = cleanText(anchor.textContent, 200);
  if (!match || !title) return null;
  return {
    id: match[1],
    title,
    url: WEB_ORIGIN + '/category/' + match[1],
  };
}

function normalizeGigHref(value) {
  if (typeof value !== 'string') return null;
  const match = /^\/gig\/(\d{1,20})\/?$/.exec(value);
  return match ? { id: match[1], url: WEB_ORIGIN + '/gig/' + match[1] } : null;
}

function parseStartingPrice(value) {
  const match = /(?:^|\s)([\d,]+)\s*원\s*~?(?:\s|$)/.exec(value ?? '');
  if (!match) return null;
  const amount = Number(match[1].replaceAll(',', ''));
  if (!Number.isSafeInteger(amount) || amount < 0) return null;
  return { amount, currency: 'KRW', basis: 'displayed_starting_price', exactCheckoutAmount: false };
}

function spacedText(node) {
  if (!node) return '';
  if (node.nodeType === 3) return node.textContent ?? '';
  return Array.from(node.childNodes ?? []).map(child => ' ' + spacedText(child) + ' ').join('');
}

function parseCard(anchor) {
  const identity = normalizeGigHref(anchor.getAttribute('href'));
  if (!identity) return null;
  const cardText = cleanText(spacedText(anchor), 10_000);
  if (!cardText) return null;
  const rating = /(?:^|\s)([1-5](?:\.\d{1,2})?)\s*\(([\d,]+)\)/.exec(cardText);
  const price = /(?:^|\s)([\d,]+\s*원\s*~?)(?=\s|$)/.exec(cardText);
  if (!rating || !price) return null;
  const title = cleanText(cardText.slice(0, rating.index), 1_000);
  const displayedPrice = parseStartingPrice(' ' + price[1] + ' ');
  const reviewCount = Number(rating[2].replaceAll(',', ''));
  const ratingValue = Number(rating[1]);
  if (!title || !displayedPrice || !Number.isSafeInteger(reviewCount) || ratingValue < 0 || ratingValue > 5) return null;
  const sellerStart = price.index + price[0].indexOf(price[1]) + price[1].length;
  const seller = cleanText(cardText.slice(sellerStart), 500);
  return {
    ...identity, title,
    startingPrice: displayedPrice,
    reviewSummary: { average: ratingValue, count: reviewCount, source: 'visible_gig_card' },
    ...(seller ? { sellerDisplayName: seller } : {}),
  };
}

export function parseKmongCategories(html, { url = WEB_ORIGIN + '/' } = {}) {
  safeDocumentUrl(url);
  const document = dom(html);
  const unique = new Map();
  for (const anchor of anchors(document)) {
    const category = normalizeCategory(anchor);
    if (category && !unique.has(category.id)) unique.set(category.id, category);
  }
  const items = [...unique.values()];
  if (!items.length) fail('CATEGORY_SCHEMA_INVALID');
  return {
    schemaVersion: 1,
    service: SERVICE,
    operation: 'categories',
    observedAt: null,
    url,
    categories: items,
    pagination: {
      complete: false,
      source: 'home_linked_categories',
      itemCount: items.length,
    },
    contractProvenance: { kind: 'first_party_document', sourceURL: url },
  };
}

export function parseKmongHome(html, { url = WEB_ORIGIN + '/', observedAt = null, requests = [] } = {}) {
  safeDocumentUrl(url, '/');
  const document = dom(html, requests.at(-1));
  const categories = parseKmongCategories(html, { url });
  const links = anchors(document, 'a[data-testid="GigCard"]');
  const unique = new Map();
  for (const link of links) {
    const gig = parseCard(link);
    if (gig && !unique.has(gig.id)) unique.set(gig.id, gig);
  }
  const items = [...unique.values()].slice(0, MAX_CARDS);
  if (!items.length) fail('HOME_SCHEMA_INVALID', requests.at(-1));
  return {
    schemaVersion: 1,
    service: SERVICE,
    operation: 'home',
    observedAt,
    url,
    items,
    categories: categories.categories,
    pagination: {
      complete: false,
      source: 'curated_home_sections',
      itemCount: items.length,
      nextPage: null,
    },
    requests,
    contractProvenance: { kind: 'first_party_document', sourceURL: url },
  };
}

function parseJsonLd(document, id) {
  let product = null;
  let breadcrumb = null;
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    const raw = script.textContent;
    if (!safeText(raw, 500_000)) continue;
    let value;
    try { value = JSON.parse(raw); } catch { continue; }
    if (!object(value)) continue;
    if (value['@type'] === 'Product') product = value;
    if (value['@type'] === 'BreadcrumbList') breadcrumb = value;
  }
  if (!object(product) || product.sku !== 'gig-' + id) fail('DETAIL_IDENTITY_MISMATCH');
  const aggregate = product.aggregateRating;
  let reviewSummary = null;
  if (object(aggregate)) {
    const average = Number(aggregate.ratingValue);
    const count = Number(aggregate.reviewCount ?? aggregate.ratingCount);
    if (Number.isFinite(average) && average >= 0 && average <= 5 &&
        Number.isSafeInteger(count) && count >= 0) {
      reviewSummary = { average, count, source: 'product_json_ld_aggregate' };
    }
  }
  const offers = product.offers;
  let offerRange = null;
  if (object(offers) && offers.priceCurrency === 'KRW') {
    const low = Number(offers.lowPrice);
    const high = Number(offers.highPrice);
    if (Number.isSafeInteger(low) && low >= 0 && Number.isSafeInteger(high) && high >= low) {
      offerRange = { minimumAmount: low, maximumAmount: high, currency: 'KRW', basis: 'aggregate_offer_range' };
    }
  }
  const categories = Array.isArray(breadcrumb?.itemListElement)
    ? breadcrumb.itemListElement.flatMap(item => {
      if (!object(item) || typeof item.item !== 'string') return [];
      const match = /^https:\/\/kmong\.com\/category\/(\d{1,12})\/?$/.exec(item.item);
      const title = cleanText(item.name, 200);
      return match && title ? [{ id: match[1], title, url: WEB_ORIGIN + '/category/' + match[1] }] : [];
    })
    : [];
  return {
    productTitle: cleanText(product.name, 1_000),
    reviewSummary,
    offerRange,
    categories,
  };
}

function parsePackageTable(document) {
  const table = document.querySelector('section[data-testid="package-table"]');
  if (!table) fail('PACKAGE_TABLE_MISSING');
  const header = table.querySelector('[data-testid="table-header"]');
  const body = table.querySelector('[data-testid="table-body"]');
  if (!header || !body) fail('PACKAGE_TABLE_SCHEMA_INVALID');
  const headerCells = Array.from(header.children);
  const packageHeaders = headerCells.slice(1).map(cell => {
    const paragraphs = Array.from(cell.querySelectorAll('p')).map(node => cleanText(node.textContent, 200)).filter(Boolean);
    const title = paragraphs[0];
    const amountText = paragraphs.slice(1).join(' ');
    const match = /([\d,]+)\s*원/.exec(amountText);
    const amount = match ? Number(match[1].replaceAll(',', '')) : NaN;
    if (!title || !Number.isSafeInteger(amount) || amount < 0) fail('PACKAGE_HEADER_INVALID');
    return { title, amount, currency: 'KRW', basis: 'listed_package_price', finalCheckoutAmountVerified: false };
  });
  if (!packageHeaders.length || packageHeaders.length > 10) fail('PACKAGE_HEADER_INVALID');
  const packages = packageHeaders.map(headerCell => ({
    title: headerCell.title,
    price: {
      amount: headerCell.amount,
      currency: headerCell.currency,
      basis: headerCell.basis,
      finalCheckoutAmountVerified: headerCell.finalCheckoutAmountVerified,
    },
    description: null,
    descriptionDetails: null,
    deliveryTime: null,
    revisionLimit: null,
    attributes: [],
  }));
  for (const row of Array.from(body.children)) {
    const cells = Array.from(row.children);
    if (cells.length !== packageHeaders.length + 1) continue;
    const label = cleanText(cells[0].textContent, 200);
    if (!label) continue;
    for (let index = 0; index < packages.length; index++) {
      const cell = cells[index + 1];
      const paragraphs = Array.from(cell.querySelectorAll('p')).map(node => cleanText(node.textContent, 5_000)).filter(Boolean);
      const value = cleanText(cell.textContent, 5_000);
      if (label === '패키지 설명') {
        packages[index].description = paragraphs[0] ?? value;
        packages[index].descriptionDetails = paragraphs.slice(1).join('\n') || null;
      } else if (label === '작업일') {
        packages[index].deliveryTime = value;
      } else if (label === '수정 횟수') {
        packages[index].revisionLimit = value;
      } else if (value) {
        packages[index].attributes.push({ label, value });
      } else if (cell.querySelector('svg')) {
        // A visual checkmark has no stable accessible text in the observed markup.
        packages[index].attributes.push({ label, value: null, state: 'icon_only_uninterpreted' });
      }
    }
  }
  const highlights = [];
  for (const item of table.querySelectorAll('li')) {
    const value = cleanText(item.textContent, 2_000);
    if (!value) continue;
    const match = /^(STANDARD|DELUXE|PREMIUM)\s*:\s*(.+)$/i.exec(value);
    if (match) highlights.push({ package: match[1].toUpperCase(), text: match[2] });
  }
  if (packages.some(item => !item.description || !item.deliveryTime || !item.revisionLimit)) {
    fail('PACKAGE_METADATA_INCOMPLETE');
  }
  return { packages, packageHighlights: highlights };
}

function observedReviewsUrl(html, id) {
  const normalized = html.replace(/\\u0026/gi, '&');
  const candidates = [...normalized.matchAll(/https:\/\/api\.kmong\.com\/order-app\/order\/v1\/reviews\/gigs\/(\d{1,20})\?page=1&perPage=(\d{1,2})&sortType=CREATED_AT_DESC/g)];
  const match = candidates.find(entry => entry[1] === id);
  if (!match || match[2] !== String(MAX_REVIEWS_PER_PAGE)) fail('REVIEW_LINK_NOT_OBSERVED');
  return new URL(match[0]);
}

export function parseKmongDetail(html, { id, url = null, observedAt = null, requests = [] } = {}) {
  const safe = safeId(id);
  const expectedUrl = WEB_ORIGIN + '/gig/' + safe;
  const target = safeDocumentUrl(url ?? expectedUrl, '/gig/' + safe);
  const document = dom(html, requests.at(-1));
  const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href');
  if (canonical) {
    const canonicalUrl = safeDocumentUrl(new URL(canonical, target).href);
    if (canonicalUrl.pathname !== '/gig/' + safe) fail('DETAIL_IDENTITY_MISMATCH');
  }
  const jsonLd = parseJsonLd(document, safe);
  const title = jsonLd.productTitle ?? cleanText(document.querySelector('h1')?.textContent, 1_000);
  const packageData = parsePackageTable(document);
  const reviewUrl = observedReviewsUrl(html, safe);
  return {
    schemaVersion: 1,
    service: SERVICE,
    operation: 'detail',
    observedAt,
    url: expectedUrl,
    gig: {
      id: safe,
      title,
      categories: jsonLd.categories,
      reviewSummary: jsonLd.reviewSummary,
      offerRange: jsonLd.offerRange,
      ...packageData,
    },
    reviewSource: {
      url: reviewUrl.href,
      pageParameter: 'page',
      pageSize: MAX_REVIEWS_PER_PAGE,
      sortType: 'CREATED_AT_DESC',
      sourceURL: expectedUrl,
    },
    requests,
    contractProvenance: { kind: 'first_party_document', sourceURL: expectedUrl },
  };
}

function safeReviewBody(value) {
  if (typeof value !== 'string' || value.length > 20_000 || CONTROL.test(value)) fail('REVIEW_BODY_INVALID');
  // Keep review prose while removing common direct-contact strings. Account
  // identifiers, thumbnails, order IDs, and purchase amounts are not projected.
  return value
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu, '[contact removed]')
    .replace(/(?:https?:\/\/|www\.)[^\s]+/giu, '[link removed]')
    .replace(/(?<![\p{L}\d])(?:\+\d{1,3}[\s().-]*)?\(?\d{2,4}\)?[\s().-]*\d{3,4}[\s.-]*\d{4}(?!\d)/gu,
      '[contact removed]');
}

function parseReviewResponse(payload, { id, page, pageSize, observedAt, url, requests, detail }) {
  if (!object(payload) || !object(payload.reviewPage) || !Array.isArray(payload.reviewPage.items)) fail('REVIEWS_SCHEMA_INVALID');
  const source = payload.reviewPage;
  const currentPage = Number(source.currentPage);
  const lastPage = Number(source.lastPage);
  const perPage = Number(source.perPage);
  const totalCount = Number(source.totalItemCount);
  const empty = totalCount === 0 && source.items.length === 0;
  if (currentPage !== page || lastPage < 0 ||
      (empty ? currentPage !== 1 || lastPage > 1 : lastPage < 1 || currentPage > lastPage) ||
      perPage !== pageSize || !Number.isSafeInteger(totalCount) || totalCount < 0 ||
      source.items.length > pageSize || totalCount < source.items.length) fail('REVIEWS_PAGE_BINDING_INVALID');
  const reviews = source.items.map(item => {
    if (!object(item) || !object(item.buyerReview) || !object(item.orderDetail)) fail('REVIEW_ROW_SCHEMA_INVALID');
    if (String(item.orderDetail.gigId) !== id) fail('REVIEW_GIG_IDENTITY_MISMATCH');
    const buyer = item.buyerReview;
    const rating = Number(buyer.score);
    if (!Number.isFinite(rating) || rating < 0 || rating > 5) fail('REVIEW_RATING_INVALID');
    const review = {
      rating,
      body: safeReviewBody(buyer.comment),
      createdAt: safeText(buyer.createdDateTime, 100) ? buyer.createdDateTime : null,
    };
    if (object(item.sellerReview) && typeof item.sellerReview.comment === 'string') {
      review.sellerResponse = {
        body: safeReviewBody(item.sellerReview.comment),
        createdAt: safeText(item.sellerReview.createdDateTime, 100) ? item.sellerReview.createdDateTime : null,
      };
    }
    return review;
  });
  const endReached = empty || currentPage === lastPage;
  return {
    schemaVersion: 1,
    service: SERVICE,
    operation: 'reviews',
    observedAt,
    url: detail.url,
    gigId: id,
    aggregateRating: detail.gig.reviewSummary,
    items: reviews,
    pagination: {
      page: currentPage,
      pageSize: perPage,
      totalItemCount: totalCount,
      lastPage,
      complete: currentPage === 1 && lastPage <= 1 && reviews.length === totalCount,
      endReached,
      nextPage: endReached ? null : currentPage + 1,
      pageWalked: false,
    },
    requests,
    contractProvenance: {
      kind: 'first_party_document',
      sourceURL: detail.url,
      discoveryBasis: 'review_link_embedded_in_first_party_detail_document',
    },
  };
}

export function parseKmongReviews(payload, { id, page = 1, pageSize = MAX_REVIEWS_PER_PAGE, url = null,
  observedAt = null, requests = [], detail = null } = {}) {
  const safe = safeId(id);
  safePage(page, 'REVIEW_PAGE', 100_000);
  if (pageSize !== MAX_REVIEWS_PER_PAGE) fail('REVIEW_PAGE_SIZE_NOT_VERIFIED');
  const detailValue = detail ?? {
    url: WEB_ORIGIN + '/gig/' + safe,
    gig: { id: safe, reviewSummary: null },
  };
  return parseReviewResponse(payload, {
    id: safe, page, pageSize, observedAt, url, requests, detail: detailValue,
  });
}

function normalizedSearchGig(gig) {
  if (!object(gig)) fail('SEARCH_ROW_SCHEMA_INVALID');
  const id = safeId(gig.gigId);
  const title = cleanText(gig.title, 1_000);
  const amount = Number(gig.price);
  if (!title || !Number.isSafeInteger(amount) || amount < 0) fail('SEARCH_ROW_SCHEMA_INVALID');
  const review = object(gig.review) ? gig.review : {};
  const average = Number(review.reviewAverage);
  const count = Number(review.reviewCount);
  const reviewSummary = Number.isFinite(average) && average >= 0 && average <= 5 &&
    Number.isSafeInteger(count) && count >= 0
    ? { average, count, source: 'search_gig_review_summary' }
    : null;
  let category = null;
  if (object(gig.category)) {
    category = Object.fromEntries([
      ['rootCategoryId', 'rootCategoryId'], ['rootCategoryName', 'rootCategoryName'],
      ['subCategoryId', 'subCategoryId'], ['subCategoryName', 'subCategoryName'],
      ['thirdCategoryId', 'thirdCategoryId'], ['thirdCategoryName', 'thirdCategoryName'],
    ].flatMap(([key, source]) => {
      const value = gig.category[source];
      if (typeof value === 'number' && Number.isSafeInteger(value)) return [[key, String(value)]];
      const normalized = cleanText(value, 300);
      return normalized ? [[key, normalized]] : [];
    }));
  }
  return {
    id, title, url: WEB_ORIGIN + '/gig/' + id,
    startingPrice: { amount, currency: 'KRW', basis: 'displayed_starting_price', exactCheckoutAmount: false },
    reviewSummary,
    ...(category && Object.keys(category).length ? { category } : {}),
    isPrime: typeof gig.isPrime === 'boolean' ? gig.isPrime : null,
    isQualityGuaranteed: typeof gig.isQualityGuaranteed === 'boolean' ? gig.isQualityGuaranteed : null,
    hasPackages: typeof gig.hasPackages === 'boolean' ? gig.hasPackages : null,
    hasVideos: typeof gig.hasVideos === 'boolean' ? gig.hasVideos : null,
  };
}

export function parseKmongSearch(payload, { keyword, page = 1, perPage = 40, observedAt = null,
  url = null, requests = [] } = {}) {
  if (!object(payload) || !Array.isArray(payload.gigs)) fail('SEARCH_SCHEMA_INVALID');
  if (payload.keyword !== keyword) fail('SEARCH_KEYWORD_BINDING_INVALID', requests.at(-1));
  const currentPage = Number(payload.currentPage);
  const lastPage = Number(payload.lastPage);
  const responsePageSize = Number(payload.perPage);
  const totalItemCount = Number(payload.totalItemCount);
  const empty = totalItemCount === 0 && payload.gigs.length === 0;
  if (currentPage !== page || responsePageSize !== perPage || !Number.isSafeInteger(totalItemCount) ||
      totalItemCount < 0 || payload.gigs.length > perPage || totalItemCount < payload.gigs.length ||
      !Number.isSafeInteger(lastPage) || lastPage < 0 ||
      (empty ? currentPage !== 1 || lastPage > 1 : lastPage < 1 || currentPage > lastPage)) {
    fail('SEARCH_PAGE_BINDING_INVALID', requests.at(-1));
  }
  const items = payload.gigs.map(normalizedSearchGig);
  const endReached = empty || currentPage === lastPage;
  return {
    schemaVersion: 1,
    service: SERVICE,
    operation: 'search',
    observedAt,
    keyword,
    items,
    pagination: {
      page: currentPage,
      pageSize: responsePageSize,
      totalItemCount,
      lastPage,
      complete: currentPage === 1 && lastPage <= 1 && items.length === totalItemCount,
      endReached,
      nextPage: endReached ? null : currentPage + 1,
      pageWalked: false,
    },
    requests,
    contractProvenance: {
      kind: 'first_party_bundle',
      sourceURL: SEARCH_BUNDLE_URL,
      runtimeConfigurationSource: RUNTIME_CONFIG_URL,
    },
  };
}

export function createKmongClient({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') fail('CLIENT_CONFIGURATION_INVALID');
  async function readHtml(url, pathname) {
    const target = safeDocumentUrl(url, pathname);
    const observedAt = checkedAt(now);
    const result = await request({ url: target.href, kind: 'html', fetchImpl, observedAt });
    return {
      html: result.body,
      observedAt,
      receipt: {
        ...result.receipt,
        contractProvenance: { kind: 'first_party_document', sourceURL: target.href },
      },
    };
  }
  async function home() {
    const fetched = await readHtml(WEB_ORIGIN + '/', '/');
    return parseKmongHome(fetched.html, {
      url: WEB_ORIGIN + '/', observedAt: fetched.observedAt, requests: [fetched.receipt],
    });
  }
  async function categories() {
    const fetched = await readHtml(WEB_ORIGIN + '/', '/');
    const parsed = parseKmongCategories(fetched.html, { url: WEB_ORIGIN + '/' });
    return {
      ...parsed,
      observedAt: fetched.observedAt,
      requests: [fetched.receipt],
    };
  }
  async function detail({ id } = {}) {
    const safe = safeId(id);
    const url = WEB_ORIGIN + '/gig/' + safe;
    const fetched = await readHtml(url, '/gig/' + safe);
    return parseKmongDetail(fetched.html, {
      id: safe, url, observedAt: fetched.observedAt, requests: [fetched.receipt],
    });
  }
  async function search({ keyword, page = 1, perPage = 40 } = {}) {
    const query = cleanText(keyword, 120);
    if (!query || /[\x00-\x1f\x7f]/.test(query)) fail('SEARCH_KEYWORD_INVALID');
    safePage(page, 'SEARCH_PAGE', 1_000);
    if (perPage !== 40) fail('SEARCH_PAGE_SIZE_NOT_VERIFIED');
    const observedAt = checkedAt(now);
    const url = new URL('/gig-app/gig/v2/gigs/search', API_ORIGIN);
    const params = {
      keyword: query, isPrime: 'false', isFastReaction: 'false', isCompany: 'false',
      isNowContactable: 'false', hasPortfolios: 'false', includeAggregations: 'true',
      page: String(page), perPage: String(perPage),
    };
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    const referer = WEB_ORIGIN + '/search?type=gigs&keyword=' + encodeURIComponent(query);
    const contractProvenance = {
      kind: 'first_party_bundle',
      sourceURL: SEARCH_BUNDLE_URL,
      runtimeConfigurationSource: RUNTIME_CONFIG_URL,
      routeRebase: '/api/msa -> https://api.kmong.com and remove /api/msa prefix',
      method: 'GET',
      queryFields: Object.keys(params),
    };
    const fetched = await request({
      url: url.href, kind: 'search-json', fetchImpl, observedAt,
      contractProvenance, referer,
    });
    const receipt = {
      ...fetched.receipt,
      contractProvenance,
    };
    return parseKmongSearch(fetched.body, {
      keyword: query, page, perPage, observedAt, url: url.href, requests: [receipt],
    });
  }
  async function reviews({ id, page = 1, pageSize = MAX_REVIEWS_PER_PAGE } = {}) {
    const safe = safeId(id);
    safePage(page, 'REVIEW_PAGE', 100_000);
    if (pageSize !== MAX_REVIEWS_PER_PAGE) fail('REVIEW_PAGE_SIZE_NOT_VERIFIED');
    const detailResult = await detail({ id: safe });
    const reviewUrl = new URL(detailResult.reviewSource.url);
    reviewUrl.searchParams.set('page', String(page));
    const fetched = await request({
      url: reviewUrl.href, kind: 'review-json', fetchImpl, observedAt: detailResult.observedAt,
    });
    const requests = [...detailResult.requests, {
      ...fetched.receipt,
      contractProvenance: {
        kind: 'first_party_document',
        sourceURL: detailResult.url,
        discoveryBasis: 'review_link_embedded_in_first_party_detail_document',
      },
    }];
    return parseKmongReviews(fetched.body, {
      id: safe, page, pageSize, url: reviewUrl.href,
      observedAt: detailResult.observedAt, requests, detail: detailResult,
    });
  }
  return Object.freeze({ home, categories, search, detail, reviews });
}

