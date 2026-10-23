import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFragment } from 'parse5';
import { readPublicPage, readPublicResource, extractPublicPage, isStrongPublicChallenge, textContent } from '../../lib/cps-public-reader.mjs';
import { collect } from '../../../naver-blog-api/research/content-store/grocery-compare.mjs';
import { collectGseshopPublic } from './gseshop-public.mjs';
import { collectFailurePathMerchant } from './failure-path-supplement.mjs';
import { collectHmallReviewSamples, collectNsmallPhotoReviewFrontier } from './batch-08-review-supplement.mjs';
import { collectNativeRecovery } from './agy-native-recovery.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '../..');
const TAXONOMY_PATH = path.join(APP_ROOT, 'references/linkprice-cps-vertical-taxonomy.v1.json');
const SNAPSHOT_PATH = path.join(APP_ROOT, 'references/linkprice-cps-source-map-2026-09-27.json');
const ASSIGNED = ['yes24', 'hmall', 'kbbook', 'himart', 'signgate', '11st', 'allcredit', 'gseshop', 'auction', 'cjbrand', 'gmarket', 'woori', 'nsseshop', 'emart'];
export const merchantIds = Object.freeze([...ASSIGNED]);
export const refreshableAfterPublicBlockMerchants = Object.freeze(['emart']);
export const nativeRecoveryMerchants = Object.freeze(['kbbook']);
const SEARCH_TERMS = {
  yes24: '아몬드 손원평', kbbook: '아몬드 손원평', hmall: '삼겹살', himart: '에어컨',
  '11st': '삼겹살', gseshop: '삼겹살', auction: '삼겹살', cjbrand: '삼겹살',
  gmarket: '삼겹살', woori: '삼겹살', nsseshop: '삼겹살', emart: '삼겹살',
  signgate: '공동인증서', allcredit: '신용관리',
};
const PROVIDER_ROOTS = {
  yes24: ['yes24.com'], hmall: ['hmall.com'], kbbook: ['kyobobook.co.kr'], himart: ['e-himart.co.kr'],
  signgate: ['signgate.com'], '11st': ['11st.co.kr'], allcredit: ['allcredit.co.kr'], gseshop: ['gsshop.com'],
  auction: ['auction.co.kr'], cjbrand: ['cjthemarket.com'], gmarket: ['gmarket.co.kr'], woori: ['lotteimall.com'],
  nsseshop: ['nsmall.com'], emart: ['ssg.com'],
};
const PRODUCT_PATH = /(?:product|goods|item|detail|book|prd|view|shop|service|certificate|credit|membership|subscription)/i;
const REDACT_KEYS = /token|auth|session|password|secret|csrf|email|phone|account|(?:^|_)key$/i;

function json(file) { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function safeUrl(raw) {
  try {
    const url = new URL(raw);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (REDACT_KEYS.test(key)) url.searchParams.set(key, 'REDACTED');
    return url.href;
  } catch { return null; }
}
const sha = value => createHash('sha256').update(value).digest('hex');
const nullish = value => value == null || value === '' ? null : value;

function liveMerchantRows() {
  const snapshot = json(SNAPSHOT_PATH);
  const rows = new Map(snapshot.merchants.map(row => [row.affiliateProgram.merchantId, row.affiliateProgram]));
  const taxonomy = json(TAXONOMY_PATH);
  return ASSIGNED.map(merchantId => {
    const live = rows.get(merchantId);
    const vertical = taxonomy.merchants.find(row => row.merchantId === merchantId);
    if (!live || !vertical) throw new Error(`MERCHANT_SNAPSHOT_MISSING:${merchantId}`);
    return { merchantId, siteName: live.name, siteUrl: live.siteUrl, verticalHint: vertical.verticalHint, verticalBasis: vertical.classificationBasis };
  });
}

function mapExtractedRecords(pageData, merchantId, receiptId) {
  return (pageData.records ?? []).map((row, index) => ({
    type: row.type ?? (['signgate', 'allcredit'].includes(merchantId) ? 'ServiceOffering' : 'RetailProduct'),
    sourceLocalId: nullish(row.sourceLocalId ?? row.id ?? row.sku ?? row.isbn),
    title: nullish(row.title ?? row.name),
    url: safeUrl(row.url ?? row.canonicalUrl),
    description: nullish(row.description),
    brand: nullish(row.brand),
    price: row.price && (row.price.amount != null || row.price.priceText != null) ? {
      amount: nullish(row.price.amount ?? row.price.value),
      currency: nullish(row.price.currency),
      priceText: nullish(row.price.priceText ?? row.price.text),
    } : null,
    rating: row.rating ? {
      value: nullish(row.rating.value ?? row.rating.ratingValue),
      best: nullish(row.rating.best ?? row.rating.bestRating),
      worst: nullish(row.rating.worst ?? row.rating.worstRating),
      reviewCount: nullish(row.rating.reviewCount),
      ratingCount: nullish(row.rating.ratingCount),
    } : null,
    variants: Array.isArray(row.variants) ? row.variants : [],
    reviewSamples: (row.reviewSamples ?? []).map(review => ({
      rating: nullish(review.rating), title: nullish(review.title), body: nullish(review.body),
      publishedAt: nullish(review.publishedAt), optionText: nullish(review.optionText),
      helpfulCount: nullish(review.helpfulCount), hasMedia: nullish(review.hasMedia),
      author: null,
    })),
    evidence: [{ receiptId, locator: row.locator ?? `extracted.records[${index}]`, fields: row.fields ?? ['title', 'url'] }],
  })).filter(row => row.title || row.price || row.rating);
}

function walkObjects(value, found = [], depth = 0) {
  if (depth > 10 || found.length >= 1200 || value == null) return found;
  if (Array.isArray(value)) { for (const item of value) walkObjects(item, found, depth + 1); return found; }
  if (typeof value !== 'object') return found;
  found.push(value);
  for (const child of Object.values(value)) walkObjects(child, found, depth + 1);
  return found;
}

function embeddedOfferingRecords(pageData, merchantId, receiptId, allowedHosts, pageUrl) {
  const titleKeys = ['productName', 'productNm', 'goodsName', 'goodsNm', 'itemName', 'itemNm', 'prdNm', 'title', 'name'];
  const idKeys = ['sourceLocalId', 'goodsId', 'goodsNo', 'goodsCd', 'itemId', 'itemNo', 'prdId', 'productId', 'productNo', 'isbn', 'sku'];
  const priceKeys = ['price', 'salePrice', 'finalPrice', 'salePrc', 'selPrc', 'dcPrice', 'saleAmt', 'sellingPrice', 'displayPrice'];
  const number = value => {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
    if (typeof value === 'string' && /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(value.trim())) return Number(value.replaceAll(',', ''));
    return null;
  };
  const firstField = (object, keys) => {
    for (const key of keys) if (object[key] != null && object[key] !== '') return [key, object[key]];
    return [null, null];
  };
  const output = [];
  for (const block of pageData?.embeddedJson ?? []) {
    for (const [index, object] of walkObjects(block.value).entries()) {
      const [titleKey, rawTitle] = firstField(object, titleKeys);
      const title = typeof rawTitle === 'string' ? rawTitle.trim().replace(/\s+/g, ' ').slice(0, 1000) : null;
      const [idKey, rawId] = firstField(object, idKeys);
      const [priceKey, rawPrice] = firstField(object, priceKeys);
      const nestedPrice = rawPrice && typeof rawPrice === 'object'
        ? firstField(rawPrice, ['finalPrice', 'salePrice', 'price', 'amount', 'displayPrice'])[1] : rawPrice;
      const amount = number(nestedPrice);
      if (!title || !idKey || rawId == null || amount == null) continue;
      const [urlKey, rawUrl] = firstField(object, ['productUrl', 'goodsUrl', 'itemUrl', 'url', 'link', 'prdUrl']);
      let productUrl = null;
      if (typeof rawUrl === 'string') {
        try {
          const parsed = new URL(rawUrl, pageUrl);
          if (parsed.protocol === 'https:' && allowedHosts.some(root => parsed.hostname === root || parsed.hostname.endsWith(`.${root}`))) productUrl = safeUrl(parsed.href);
        } catch { /* Non-URL identifiers are not evidence. */ }
      }
      const [brandKey, brand] = firstField(object, ['brandName', 'brandNm', 'brand']);
      const [ratingKey, rating] = firstField(object, ['rating', 'ratingValue', 'reviewScore', 'score', 'grade']);
      const [reviewCountKey, reviewCount] = firstField(object, ['reviewCount', 'reviewCnt', 'reviewTotalCount', 'reviewRegCnt']);
      const [ratingCountKey, ratingCount] = firstField(object, ['ratingCount', 'ratingsCount', 'ratingCnt', 'ratingTotalCount']);
      const ratingValue = number(rating);
      const reviewTotal = number(reviewCount);
      const ratingTotal = number(ratingCount);
      const fields = [titleKey, idKey, priceKey].filter(Boolean);
      if (urlKey && productUrl) fields.push(urlKey);
      if (brandKey && typeof brand === 'string') fields.push(brandKey);
      if (ratingKey && ratingValue != null) fields.push(ratingKey);
      if (reviewCountKey && reviewTotal != null) fields.push(reviewCountKey);
      if (ratingCountKey && ratingTotal != null) fields.push(ratingCountKey);
      output.push({
        type: ['signgate', 'allcredit'].includes(merchantId) ? 'ServiceOffering' : 'RetailProduct',
        sourceLocalId: String(rawId).slice(0, 200), title, url: productUrl, description: null,
        brand: typeof brand === 'string' ? brand.slice(0, 300) : null,
        price: { amount, currency: 'KRW', priceText: `${amount.toLocaleString('ko-KR')}원` },
        rating: ratingValue == null && reviewTotal == null && ratingTotal == null ? null : {
          value: ratingValue, best: null, worst: null, reviewCount: reviewTotal, ratingCount: ratingTotal,
        },
        variants: [], reviewSamples: [],
        evidence: [{ receiptId, locator: `${block.id}:embeddedJson[${index}]`, fields }],
      });
    }
  }
  return output;
}

function descendants(root, predicate, output = []) {
  if (!root) return output;
  if (predicate(root)) output.push(root);
  for (const child of root.childNodes ?? []) descendants(child, predicate, output);
  return output;
}

function attribute(node, name) { return node?.attrs?.find(item => item.name === name)?.value ?? null; }

function cjRetrievalContext(pageUrl, title, kind = 'embedded_offerings') {
  const page = new URL(pageUrl);
  const isCategory = page.pathname.includes('category-product-list');
  const isHomepage = /(?:^|\/)main\/?$/i.test(page.pathname) || page.pathname === '/';
  const topicHint = SEARCH_TERMS.cjbrand;
  return {
    query: null,
    queryApplied: false,
    retrievalKind: isCategory ? (kind === 'visible_category_card' ? 'category_listing' : 'category_embedded_offerings')
      : isHomepage ? 'homepage_embedded_offerings' : 'detail_page_embedded_offerings',
    ...(isCategory ? { categoryId: page.searchParams.get('ctgrId'), ...(page.searchParams.get('ctgrId') === '0048' ? { observedCategory: '계란 · 정육 · 수산' } : {}) } : {}),
    sourcePageUrl: safeUrl(pageUrl),
    topicHint,
    topicHintInTitle: String(title ?? '').includes(topicHint),
  };
}

function cjVisibleCatalogRecords(pageResult) {
  if (!pageResult.page.ok || !pageResult.page.html || !/cjthemarket\.com/i.test(pageResult.page.url ?? '')) return [];
  const root = parseFragment(pageResult.page.html);
  const cards = descendants(root, node => node.tagName === 'section' && (attribute(node, 'class') ?? '').split(/\s+/).includes('product__item--category')).slice(0, 100);
  return cards.flatMap(card => {
    const item = descendants(card, node => node.tagName === 'div' && (attribute(node, 'class') ?? '').split(/\s+/).includes('product__item'))[0];
    if (!item) return [];
    const sourceLocalId = attribute(item, 'data-product-id') ?? attribute(item, 'data-prdcd');
    const title = attribute(item, 'data-product-name');
    const rawPrice = attribute(item, 'data-product-price');
    if (!sourceLocalId || !title || !/^\d{1,9}$/.test(rawPrice ?? '')) return [];
    const visible = textContent(card, 2500) ?? '';
    const review = /★\s*([0-5](?:\.\d+)?)\s*\(([\d,]+)\)/.exec(visible);
    const ratingValue = review ? Number(review[1]) : null;
    const reviewCount = review ? Number(review[2].replaceAll(',', '')) : null;
    const amount = Number(rawPrice);
    const fields = ['sourceLocalId', 'title', 'price'];
    const subTitleNode = descendants(item, node => node.tagName === 'p' && (attribute(node, 'class') ?? '').split(/\s+/).includes('product__sub--title'))[0];
    const description = textContent(subTitleNode, 300) ?? null;
    if (description) fields.push('description');
    if (ratingValue != null) fields.push('rating');
    if (reviewCount != null) fields.push('reviewCount');
    return [{ type: 'RetailProduct', sourceLocalId, title, url: null,
      description, brand: null,
      price: { amount, currency: 'KRW', priceText: `${amount.toLocaleString('ko-KR')}원` },
      rating: ratingValue == null && reviewCount == null ? null : { value: ratingValue, best: null, worst: null, reviewCount, ratingCount: null },
      variants: [], reviewSamples: [], relevance: cjRetrievalContext(pageResult.page.url, title, 'visible_category_card'),
      evidence: [{ receiptId: pageResult.receipt.receiptId,
        locator: `section.product__item--category div.product__item[data-product-id="${sourceLocalId}"]`, fields }],
    }];
  });
}

function allcreditVisibleServiceRecord(pageResult) {
  if (!pageResult.page.ok || !pageResult.page.html || !/allcredit\.co\.kr\/screen\/sc(?:9805863239|3260276122)/i.test(pageResult.page.url ?? '')) return [];
  const pageData = pageResult.pageData;
  const title = pageData?.title?.replace(/\s*\|\s*올크레딧\s*$/, '').trim();
  if (!title) return [];
  const visible = (textContent(pageResult.page.html, 30000) ?? '').replace(/\s+/g, ' ').trim();
  const detailMarker = visible.indexOf('서비스 상세');
  const section = detailMarker < 0 ? '' : visible.slice(detailMarker, detailMarker + 1600);
  if (!section || !/서비스\s*선택/.test(visible) || !/신청하기/.test(visible) || !/(?:보고서|신용점수|신용정보)/.test(section)) return [];
  const meaningful = section.slice(0, Math.min(section.indexOf('누가 사용하나요?') > 0 ? section.indexOf('누가 사용하나요?') : 700, 700));
  const serviceId = new URL(pageResult.page.url).pathname.split('/').at(-1);
  return [{ type: 'ServiceOffering', sourceLocalId: serviceId, title, url: pageResult.page.url,
    description: meaningful, brand: '올크레딧', price: null, rating: null, variants: [], reviewSamples: [],
    evidence: [{ receiptId: pageResult.receipt.receiptId,
      locator: `observed first-party detail URL path /screen/${serviceId}`, fields: ['sourceLocalId', 'url'] },
    { receiptId: pageResult.receipt.receiptId,
      locator: 'document.title + visible main service section containing 서비스 선택, included feature list, 신청하기',
      fields: ['title', 'description', 'brand'] }],
    relevance: { query: null, queryApplied: false, retrievalKind: 'service_detail_page', sourcePageUrl: pageResult.page.url },
  }];
}

async function readPage(url, allowedHosts, merchantId, typeHint) {
  const requestUrl = new URL(url);
  if (requestUrl.protocol === 'http:') requestUrl.protocol = 'https:';
  const page = await readPublicPage(requestUrl.href, { allowedHosts, maxRedirects: 5, maxBytes: 2_000_000, timeoutMs: 20_000 });
  const pageData = page.ok ? extractPublicPage(page, { merchantId, typeHint }) : null;
  const receipt = { ...page.receipt, receiptId: page.receipt?.id ?? `batch08:${merchantId}:${sha(String(page.receipt?.requestUrl ?? url)).slice(0, 16)}`,
    requestUrl: safeUrl(page.receipt?.requestUrl ?? url), responseUrl: safeUrl(page.url), redirects: page.redirects ?? [], responseHash: page.receipt?.responseSha256 ?? null };
  return { page, pageData, receipt };
}

function resourceReceipt(resource, merchantId, requestUrl) {
  const receiptId = resource.receipt?.id ?? `batch08:${merchantId}:${sha(String(requestUrl)).slice(0, 16)}`;
  return { ...resource.receipt, receiptId, requestUrl: safeUrl(resource.receipt?.requestUrl ?? requestUrl),
    responseUrl: safeUrl(resource.url), redirects: resource.redirects ?? [], responseHash: resource.receipt?.responseSha256 ?? null };
}

async function readObservedResource(url, allowedHosts, merchantId, maxBytes = 5_000_000) {
  const resource = await readPublicResource(url, { allowedHosts, maxRedirects: 5, maxBytes, timeoutMs: 20_000 });
  return { resource, receipt: resourceReceipt(resource, merchantId, url) };
}

function directReceipt(raw, responseUrl = raw.requestUrl, redirects = []) {
  return { ...raw, receiptId: raw.id, requestUrl: safeUrl(raw.requestUrl), responseUrl: safeUrl(responseUrl),
    redirects, responseHash: raw.responseSha256 ?? null };
}

async function readHimartDirect(url, { method = 'GET', body = undefined, contentType = null, maxBytes = 2_000_000 } = {}) {
  const allowedHosts = PROVIDER_ROOTS.himart;
  let current;
  try { current = new URL(url); } catch { return { ok: false, blocked: false, stopReason: 'URL_INVALID', receipts: [], redirects: [] }; }
  const receipts = [];
  const redirects = [];
  let requestMethod = method;
  let requestBody = body;
  for (let attempt = 0; attempt <= 5; attempt += 1) {
    if (current.protocol !== 'https:' || current.port || !allowedHosts.some(host => current.hostname === host || current.hostname.endsWith(`.${host}`))) {
      return { ok: false, blocked: false, stopReason: 'OBSERVED_ROUTE_OUTSIDE_HTTPS_ALLOWLIST', url: safeUrl(current.href), receipts, redirects };
    }
    let response;
    try {
      response = await fetch(current.href, { method: requestMethod, body: requestBody,
        headers: contentType && requestMethod !== 'GET' ? { 'content-type': contentType } : undefined,
        credentials: 'omit', redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(20_000) });
    } catch {
      return { ok: false, blocked: false, stopReason: 'PUBLIC_HTTP_TRANSPORT_FAILED', url: safeUrl(current.href), receipts, redirects };
    }
    const observedAt = new Date().toISOString();
    const chunks = [];
    let bytes = 0;
    let overflow = false;
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        const chunk = Buffer.from(item.value);
        bytes += chunk.length;
        if (bytes > maxBytes) {
          overflow = true;
          await reader.cancel().catch(() => {});
          break;
        }
        chunks.push(chunk);
      }
    }
    const rawBody = Buffer.concat(chunks);
    const responseHash = sha(rawBody);
    const receipt = { id: `batch08:himart:${sha(`${current.href}\0${observedAt}\0${attempt}`).slice(0, 20)}`,
      requestMethod, requestUrl: safeUrl(current.href), responseStatus: response.status,
      contentType: response.headers.get('content-type'), bytes: rawBody.length, responseSha256: responseHash,
      observedAt, browserUsed: false, cookiesSent: false, authorizationSent: false };
    receipts.push(receipt);
    const bodyText = rawBody.toString('utf8');
    const responseHeaders = Object.fromEntries(response.headers.entries());
    const challenge = isStrongPublicChallenge(responseHeaders, bodyText);
    if (overflow) return { ok: false, blocked: false, stopReason: 'RESPONSE_TOO_LARGE', url: safeUrl(current.href),
      status: response.status, contentType: receipt.contentType, receipts, redirects };
    if ([401, 403, 418, 429].includes(response.status)) return { ok: false, blocked: true,
      stopReason: `HTTP_${response.status}`, url: safeUrl(current.href), status: response.status,
      contentType: receipt.contentType, body: bodyText, receipts, redirects };
    if (challenge) return { ok: false, blocked: true, stopReason: 'VISIBLE_CHALLENGE', url: safeUrl(current.href),
      status: response.status, contentType: receipt.contentType, body: bodyText, receipts, redirects };
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400) {
      if (!location) return { ok: false, blocked: false, stopReason: 'REDIRECT_LOCATION_MISSING', url: safeUrl(current.href),
        status: response.status, contentType: receipt.contentType, body: bodyText, receipts, redirects };
      let next;
      try { next = new URL(location, current); } catch { return { ok: false, blocked: false, stopReason: 'REDIRECT_URL_INVALID',
        url: safeUrl(current.href), status: response.status, contentType: receipt.contentType, body: bodyText, receipts, redirects }; }
      if (next.protocol !== 'https:' || next.port || !allowedHosts.some(host => next.hostname === host || next.hostname.endsWith(`.${host}`))) {
        return { ok: false, blocked: false, stopReason: 'REDIRECT_OUTSIDE_HTTPS_ALLOWLIST', url: safeUrl(current.href),
          status: response.status, contentType: receipt.contentType, body: bodyText, receipts, redirects };
      }
      redirects.push({ status: response.status, from: safeUrl(current.href), to: safeUrl(next.href) });
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && requestMethod !== 'GET')) {
        requestMethod = 'GET';
        requestBody = undefined;
      }
      current = next;
      continue;
    }
    if (response.status !== 200) return { ok: false, blocked: false, stopReason: `HTTP_${response.status}`,
      url: safeUrl(current.href), status: response.status, contentType: receipt.contentType, body: bodyText, receipts, redirects };
    return { ok: true, blocked: false, stopReason: null, url: safeUrl(current.href), status: response.status,
      contentType: receipt.contentType, body: bodyText, receipt, receipts, redirects };
  }
  return { ok: false, blocked: false, stopReason: 'REDIRECT_LIMIT_REACHED', url: safeUrl(current.href), receipts, redirects };
}

async function readHimartHtml(url, typeHint = 'RetailProduct') {
  const direct = await readHimartDirect(url);
  const mime = (direct.contentType ?? '').split(';', 1)[0].trim().toLowerCase();
  const html = direct.ok && ['text/html', 'application/xhtml+xml'].includes(mime) ? direct.body : '';
  const page = { ok: direct.ok && Boolean(html), url: direct.url, status: direct.status ?? direct.receipts.at(-1)?.responseStatus ?? null,
    contentType: direct.contentType ?? null, html, receipt: direct.receipt ?? direct.receipts.at(-1) ?? null,
    redirects: direct.redirects ?? [], blocked: direct.blocked ?? false, stopReason: direct.stopReason ?? null };
  const pageData = page.ok ? extractPublicPage(page, { merchantId: 'himart', typeHint }) : null;
  const receipts = (direct.receipts ?? []).map(item => directReceipt(item, item.requestUrl, direct.redirects ?? []));
  const receipt = page.receipt ? directReceipt(page.receipt, page.url, page.redirects) : receipts.at(-1) ?? null;
  return { page, pageData, receipt, receipts, body: direct.body ?? null };
}

function observedModulePreloads(html, pageUrl, allowedHosts) {
  const root = parseFragment(html ?? '');
  return descendants(root, node => node.tagName === 'link' && String(attribute(node, 'rel') ?? '').toLowerCase() === 'modulepreload')
    .map(node => attribute(node, 'href')).filter(Boolean).map(href => {
      try { const url = new URL(href, pageUrl); return url.protocol === 'https:'
        && allowedHosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`)) ? url.href : null; }
      catch { return null; }
    }).filter(Boolean);
}

function observedScriptUrls(html, pageUrl) {
  const root = parseFragment(html ?? '');
  return descendants(root, node => node.tagName === 'script').map(node => attribute(node, 'src'))
    .filter(src => typeof src === 'string' && /\.js(?:\?|$)/i.test(src))
    .map(src => { try { return new URL(src, pageUrl).href; } catch { return null; } }).filter(Boolean);
}

function nsmallVisibleScriptUrls(html, pageUrl) {
  return observedScriptUrls(html, pageUrl).filter(url => new URL(url).pathname.startsWith('/assets/'));
}

function nsmallAssetUrl(source, filePattern) {
  const match = filePattern.exec(source);
  return match ? `https://m.nsmall.com/assets/${match[0]}` : null;
}

function nextDataFromHtml(html) {
  const root = parseFragment(html ?? '');
  const script = descendants(root, node => node.tagName === 'script' && attribute(node, 'id') === '__NEXT_DATA__')[0];
  if (!script) return null;
  const source = (script.childNodes ?? []).map(child => child.value ?? '').join('').trim();
  try { return JSON.parse(source); } catch { return null; }
}

function hmallNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(value.trim())) return Number(value.replaceAll(',', ''));
  return null;
}

async function collectHmallRanking(row, homepageHtml, homepageUrl, checkedAt) {
  const hosts = PROVIDER_ROOTS.hmall;
  const homepageData = nextDataFromHtml(homepageHtml);
  const templates = homepageData?.props?.pageProps?.respData?.template_list;
  const template = Array.isArray(templates) ? templates.find(item => item?.dispTrtyNm === '랭킹' && item?.mainDispSeq != null) : null;
  if (!template?.appMainCallUrl) {
    row.operations.product_catalog = { state: 'not_observed', reason: 'homepage_ranking_template_not_found' };
    row.frontier.push({ operation: 'product_catalog', reason: 'homepage_ranking_template_not_found' });
    return;
  }
  const routeUrl = new URL(template.appMainCallUrl, homepageUrl).href;
  const routePage = await readPage(routeUrl, hosts, 'hmall', 'RetailProduct');
  row.receipts.push(routePage.receipt);
  row.contracts.push(pageContract(routePage, 'homepage_observed_ranking_route', checkedAt, template.dispTrtyNm));
  if (!routePage.page.ok || routePage.page.blocked) {
    row.operations.product_catalog = { state: routePage.page.blocked ? 'blocked' : 'unavailable',
      reason: routePage.page.stopReason ?? `HTTP_${routePage.page.status}`, url: safeUrl(routeUrl) };
    row.frontier.push({ operation: 'product_catalog', reason: routePage.page.stopReason ?? `HTTP_${routePage.page.status}`, url: safeUrl(routeUrl) });
    return;
  }

  const routeScripts = observedScriptUrls(routePage.page.html, routePage.page.url);
  const mainRouteUrl = routeScripts.find(url => /\/pages\/app\/main\/%5BviewName%5D-[A-Za-z0-9_-]+\.js$/i.test(new URL(url).pathname));
  const apiBundleUrl = routeScripts.find(url => /\/chunks\/1339-[A-Za-z0-9_-]+\.js$/i.test(new URL(url).pathname));
  const assetReads = [];
  for (const [kind, url] of [['hmall_main_route_bundle', mainRouteUrl], ['hmall_section_api_bundle', apiBundleUrl]]) {
    if (!url) continue;
    const loaded = await readObservedResource(url, hosts, 'hmall');
    row.receipts.push(loaded.receipt);
    assetReads.push({ kind, url, ...loaded });
    if (loaded.resource.blocked) {
      row.operations.product_catalog = { state: 'blocked', reason: loaded.resource.stopReason, url: safeUrl(url) };
      row.frontier.push({ operation: 'product_catalog', reason: loaded.resource.stopReason, url: safeUrl(url) });
      return;
    }
  }
  const mainRouteBundle = assetReads.find(item => item.kind === 'hmall_main_route_bundle' && item.resource.ok);
  const apiBundle = assetReads.find(item => item.kind === 'hmall_section_api_bundle' && item.resource.ok);
  const routeEvidence = /main-home\/selectMainTabSectId/.test(mainRouteBundle?.resource.body ?? '')
    && /tdd/.test(mainRouteBundle?.resource.body ?? '');
  const spexEvidence = /sect-mng\/sect-validate/.test(apiBundle?.resource.body ?? '')
    && /sect-mng\/spex-sect-item-search/.test(apiBundle?.resource.body ?? '');
  if (!routeEvidence || !spexEvidence) {
    row.operations.product_catalog = { state: 'not_replayed', reason: 'observed_ranking_route_contract_missing' };
    row.frontier.push({ operation: 'product_catalog', reason: 'observed_ranking_route_contract_missing' });
    return;
  }

  const mainDispSeq = String(template.mainDispSeq);
  const tabParams = new URLSearchParams({ mainDispSeq });
  const tabUrl = `https://www.hmall.com/api/hf/dp/v1/main-home/selectMainTabSectId?${tabParams}`;
  const tabRead = await readObservedResource(tabUrl, hosts, 'hmall', 500_000);
  row.receipts.push(tabRead.receipt);
  if (!tabRead.resource.ok) {
    row.operations.product_catalog = { state: tabRead.resource.blocked ? 'blocked' : 'unavailable',
      responseStatus: tabRead.resource.status, reason: tabRead.resource.stopReason, url: safeUrl(tabUrl) };
    row.frontier.push({ operation: 'product_catalog', reason: tabRead.resource.stopReason ?? 'ranking_tab_lookup_failed', url: safeUrl(tabUrl) });
    return;
  }
  let tab;
  try { tab = JSON.parse(tabRead.resource.body); } catch { tab = null; }
  const sectId = tab?.successYn === 'Y' ? tab?.respData?.sectId : null;
  if (sectId == null) {
    row.operations.product_catalog = { state: 'unavailable', responseStatus: tabRead.resource.status, reason: 'ranking_section_id_missing' };
    row.frontier.push({ operation: 'product_catalog', reason: 'ranking_section_id_missing' });
    return;
  }
  row.contracts.push({ kind: 'observed_hmall_ranking_tab_lookup', endpoint: 'https://www.hmall.com/api/hf/dp/v1/main-home/selectMainTabSectId',
    method: 'GET', requestParams: { mainDispSeq }, sectionId: String(sectId), responseStatus: tabRead.resource.status,
    contentType: tabRead.resource.contentType, mainRouteReceiptId: mainRouteBundle?.receipt.receiptId ?? null,
    verifiedAt: checkedAt, browserUsed: false, cookiesSent: false, authorizationSent: false });

  const sectParams = new URLSearchParams({ sectId: String(sectId) });
  const validateUrl = `https://www.hmall.com/api/hf/dp/v1/sect-mng/sect-validate?${sectParams}`;
  const validateRead = await readObservedResource(validateUrl, hosts, 'hmall', 500_000);
  row.receipts.push(validateRead.receipt);
  if (!validateRead.resource.ok) {
    row.operations.product_catalog = { state: validateRead.resource.blocked ? 'blocked' : 'unavailable',
      responseStatus: validateRead.resource.status, reason: validateRead.resource.stopReason };
    row.frontier.push({ operation: 'product_catalog', reason: validateRead.resource.stopReason ?? 'ranking_section_validation_failed', url: safeUrl(validateUrl) });
    return;
  }
  let validated;
  try { validated = JSON.parse(validateRead.resource.body); } catch { validated = null; }
  if (validated?.successYn !== 'Y') {
    row.operations.product_catalog = { state: 'unavailable', responseStatus: validateRead.resource.status,
      reason: 'ranking_section_validation_not_successful', responseCode: validated?.respCode ?? null };
    row.frontier.push({ operation: 'product_catalog', reason: 'ranking_section_validation_not_successful' });
    return;
  }

  const spexUrl = `https://www.hmall.com/api/hf/dp/v1/sect-mng/spex-sect-item-search?${sectParams}`;
  const spexRead = await readObservedResource(spexUrl, hosts, 'hmall', 500_000);
  row.receipts.push(spexRead.receipt);
  if (!spexRead.resource.ok) {
    row.operations.product_catalog = { state: spexRead.resource.blocked ? 'blocked' : 'unavailable',
      responseStatus: spexRead.resource.status, reason: spexRead.resource.stopReason };
    row.frontier.push({ operation: 'product_catalog', reason: spexRead.resource.stopReason ?? 'ranking_section_route_failed', url: safeUrl(spexUrl) });
    return;
  }
  let spex;
  try { spex = JSON.parse(spexRead.resource.body); } catch { spex = null; }
  const redirectUrl = spex?.respData?.url;
  if (spex?.successYn !== 'Y' || spex?.respData?.respType !== 'redirect' || typeof redirectUrl !== 'string') {
    row.operations.product_catalog = { state: 'unavailable', responseStatus: spexRead.resource.status,
      reason: 'ranking_section_list_route_not_returned', responseCode: spex?.respCode ?? null };
    row.frontier.push({ operation: 'product_catalog', reason: 'ranking_section_list_route_not_returned' });
    return;
  }
  row.contracts.push({ kind: 'observed_hmall_section_item_lookup', endpoint: 'https://www.hmall.com/api/hf/dp/v1/sect-mng/spex-sect-item-search',
    method: 'GET', requestParams: { sectId: String(sectId) }, responseStatus: spexRead.resource.status,
    responseType: spex.respData.respType, returnedPageUrl: safeUrl(new URL(redirectUrl, spexUrl).href),
    sectionValidationReceiptId: validateRead.receipt.receiptId, apiBundleReceiptId: apiBundle?.receipt.receiptId ?? null,
    verifiedAt: checkedAt, browserUsed: false, cookiesSent: false, authorizationSent: false });

  const listPage = await readPage(new URL(redirectUrl, spexUrl).href, hosts, 'hmall', 'RetailProduct');
  row.receipts.push(listPage.receipt);
  if (!listPage.page.ok || listPage.page.blocked) {
    row.operations.product_catalog = { state: listPage.page.blocked ? 'blocked' : 'unavailable',
      responseStatus: listPage.page.status, reason: listPage.page.stopReason, url: safeUrl(listPage.page.url) };
    row.frontier.push({ operation: 'product_catalog', reason: listPage.page.stopReason ?? `HTTP_${listPage.page.status}`, url: safeUrl(listPage.page.url) });
    return;
  }
  row.contracts.push(pageContract(listPage, 'observed_ranking_product_list', checkedAt, template.dispTrtyNm));
  const listData = nextDataFromHtml(listPage.page.html)?.props?.pageProps?.res?.bestInfo;
  const cartItems = Array.isArray(listData?.bestCartItemList) ? listData.bestCartItemList : [];
  const realItems = Array.isArray(listData?.bestRealList) ? listData.bestRealList : [];
  const listPageScriptUrl = observedScriptUrls(listPage.page.html, listPage.page.url)
    .find(url => /\/pages\/dpa\/searchSectItem-[A-Za-z0-9_-]+\.js$/i.test(new URL(url).pathname));
  const listBundleRead = listPageScriptUrl ? await readObservedResource(listPageScriptUrl, hosts, 'hmall') : null;
  if (listBundleRead) row.receipts.push(listBundleRead.receipt);
  if (listBundleRead?.resource.blocked) {
    row.operations.product_catalog = { state: 'blocked', reason: listBundleRead.resource.stopReason, url: safeUrl(listPageScriptUrl) };
    row.frontier.push({ operation: 'product_catalog', reason: listBundleRead.resource.stopReason, url: safeUrl(listPageScriptUrl) });
    return;
  }
  const listBundleBody = listBundleRead?.resource.ok ? listBundleRead.resource.body : '';
  const productRouteObserved = listBundleBody.includes('/md/pda/itemPtc') && listBundleBody.includes('slitmCd');
  const listFieldSemanticsObserved = /price:e\.bbprc/.test(listBundleBody)
    && /itemEvalEvgScrg/.test(listBundleBody)
    && /review_cnt/.test(listBundleBody);
  const cartFirst = cartItems[0];
  const realFirst = realItems[0];
  const detailComparisons = [];
  let detailBundleReceiptId = null;
  for (const [listName, product] of [['bestCartItemList', cartFirst], ['bestRealList', realFirst]]) {
    if (!productRouteObserved || product?.slitmCd == null) continue;
    const detailUrl = `https://www.hmall.com/md/pda/itemPtc?sectId=&slitmCd=${encodeURIComponent(String(product.slitmCd))}`;
    const detailPage = await readPage(detailUrl, hosts, 'hmall', 'RetailProduct');
    row.receipts.push(detailPage.receipt);
    if (detailPage.page.blocked) {
      row.operations.product_catalog = { state: 'records_observed_detail_blocked', reason: detailPage.page.stopReason, url: safeUrl(detailUrl) };
      row.frontier.push({ operation: 'observed_product_detail', reason: detailPage.page.stopReason, url: safeUrl(detailUrl) });
      break;
    }
    if (!detailPage.page.ok) {
      row.frontier.push({ operation: 'observed_product_detail', reason: detailPage.page.stopReason ?? `HTTP_${detailPage.page.status}`, url: safeUrl(detailUrl) });
      continue;
    }
    const detailData = nextDataFromHtml(detailPage.page.html)?.props?.pageProps;
    const detailProduct = detailData?.respData?.itemPtc;
    detailComparisons.push({ list: listName, sourceLocalId: String(product.slitmCd), listRating: hmallNumber(product.itemEvalEvgScrg),
      detailRating: hmallNumber(detailData?.respData?.orgItemEvalScrg),
      listReviewCount: hmallNumber(listName === 'bestCartItemList' ? product.reviewCnt : product.itemEvalCnt),
      detailReviewCount: hmallNumber(detailData?.respData?.reviewTotCnt), detailTitleMatch: detailProduct?.slitmNm === product.slitmNm });
    const detailScriptUrl = observedScriptUrls(detailPage.page.html, detailPage.page.url)
      .find(url => /\/pages\/pda\/itemPtc-[A-Za-z0-9_-]+\.js$/i.test(new URL(url).pathname));
    if (detailScriptUrl && !detailBundleReceiptId) {
      const detailBundle = await readObservedResource(detailScriptUrl, hosts, 'hmall');
      row.receipts.push(detailBundle.receipt);
      if (detailBundle.resource.blocked) {
        row.operations.product_catalog = { state: 'records_observed_detail_bundle_blocked', reason: detailBundle.resource.stopReason, url: safeUrl(detailScriptUrl) };
        row.frontier.push({ operation: 'observed_product_detail_bundle', reason: detailBundle.resource.stopReason, url: safeUrl(detailScriptUrl) });
        break;
      }
      if (detailBundle.resource.ok && /reviewTotCnt/.test(detailBundle.resource.body) && /orgItemEvalScrg/.test(detailBundle.resource.body)
        && /bestRating:5,worstRating:1/.test(detailBundle.resource.body)) detailBundleReceiptId = detailBundle.receipt.receiptId;
    }
  }
  if (!cartItems.length && !realItems.length) {
    row.operations.product_catalog = { state: 'observed_no_records', responseStatus: listPage.page.status,
      reason: 'ranking_page_embedded_no_product_arrays', sectionId: String(sectId) };
    row.frontier.push({ operation: 'product_catalog', reason: 'ranking_page_embedded_no_product_arrays' });
    return;
  }
  const recordMap = new Map();
  const addRankingList = (items, sourceList) => {
    for (const [index, item] of items.entries()) {
      if (item?.slitmCd == null || !item?.slitmNm) continue;
      const id = String(item.slitmCd);
      const priceAmount = hmallNumber(item.bbprc);
      const ratingValue = hmallNumber(item.itemEvalEvgScrg);
      const rawCount = sourceList === 'bestCartItemList' ? item.reviewCnt : item.itemEvalCnt;
      const reviewCount = hmallNumber(rawCount);
      const fields = ['sourceLocalId', 'title'];
      if (item.brndNm) fields.push('brand');
      if (priceAmount != null) fields.push('price');
      if (ratingValue != null && ratingValue > 0) fields.push('rating');
      if (reviewCount != null) fields.push('reviewCount');
      const recordUrl = productRouteObserved ? `https://www.hmall.com/md/pda/itemPtc?sectId=&slitmCd=${encodeURIComponent(id)}` : null;
      const evidence = [{ receiptId: listPage.receipt.receiptId,
        locator: `props.pageProps.res.bestInfo.${sourceList}[${index}]`, fields }];
      if (recordUrl && listBundleRead?.resource.ok) evidence.push({ receiptId: listBundleRead.receipt.receiptId,
        locator: 'observed item link: /md/pda/itemPtc?sectId=&slitmCd={slitmCd}', fields: ['url'] });
      if (detailBundleReceiptId && (ratingValue != null || reviewCount != null)) evidence.push({ receiptId: detailBundleReceiptId,
        locator: 'detail-page AggregateRating mapping: orgItemEvalScrg -> ratingValue, reviewTotCnt -> reviewCount, range 1..5',
        fields: [...(ratingValue != null && ratingValue > 0 ? ['rating'] : []), ...(reviewCount != null ? ['reviewCount'] : [])] });
      const record = { type: 'RetailProduct', sourceLocalId: id, title: item.slitmNm, url: recordUrl, description: null,
        brand: item.brndNm ?? null,
        price: priceAmount == null ? null : { amount: priceAmount, currency: 'KRW', priceText: `${priceAmount.toLocaleString('ko-KR')}원` },
        rating: ratingValue == null && reviewCount == null ? null : { value: ratingValue && ratingValue > 0 ? ratingValue : null,
          best: ratingValue && ratingValue > 0 ? 5 : null, worst: ratingValue && ratingValue > 0 ? 1 : null,
          reviewCount, ratingCount: null },
        variants: [], reviewSamples: [],
        relevance: { query: null, queryApplied: false, retrievalKind: 'ranking_listing', sourcePageUrl: safeUrl(listPage.page.url),
          sectionId: String(sectId), sourceLists: [sourceList], sourceRanks: [{ list: sourceList,
            rank: hmallNumber(sourceList === 'bestRealList' ? item.no : index + 1) ?? index + 1 }] }, evidence };
      const existing = recordMap.get(id);
      if (!existing) { recordMap.set(id, record); continue; }
      if (!existing.relevance.sourceLists.includes(sourceList)) existing.relevance.sourceLists.push(sourceList);
      existing.relevance.sourceRanks.push(...record.relevance.sourceRanks);
      existing.evidence.push(...record.evidence.filter(entry => !existing.evidence.some(prior => prior.receiptId === entry.receiptId && prior.locator === entry.locator)));
      if (!existing.brand && record.brand) existing.brand = record.brand;
      if (!existing.price && record.price) existing.price = record.price;
      if (!existing.rating && record.rating) existing.rating = record.rating;
    }
  };
  addRankingList(cartItems, 'bestCartItemList');
  addRankingList(realItems, 'bestRealList');
  row.records.push(...recordMap.values());
  row.contracts.push({ kind: 'observed_hmall_ranking_data', pageUrl: safeUrl(listPage.page.url), sectionId: String(sectId),
    pageReceiptId: listPage.receipt.receiptId, listBundleUrl: safeUrl(listPageScriptUrl),
    listBundleReceiptId: listBundleRead?.resource.ok ? listBundleRead.receipt.receiptId : null,
    observedLists: { bestCartItemList: cartItems.length, bestRealList: realItems.length },
    productLinkObserved: productRouteObserved, displayPriceField: 'bbprc (shown as 할인 price); sellPrc is the crossed-out normal price when bbprc < sellPrc',
    ratingField: 'itemEvalEvgScrg', reviewCounterFields: ['reviewCnt', 'itemEvalCnt'], ratingCountField: null,
    detailCorrespondence: detailComparisons,
    detailSchemaReceiptId: detailBundleReceiptId,
    completeCatalog: false, browserUsed: false, cookiesSent: false, authorizationSent: false, verifiedAt: checkedAt });
  row.operations.product_catalog = { state: row.records.length ? 'records_observed' : 'observed_no_records',
    sectionId: String(sectId), sectionName: validated?.respData?.sectInfo?.sectNm ?? null,
    sourceLists: { bestCartItemList: cartItems.length, bestRealList: realItems.length }, uniqueRecords: row.records.length,
    recordsComplete: false, queryApplied: false };
  row.operations.rating_summary = { state: row.records.some(record => record.rating) ? 'aggregate_observed' : 'not_observed',
    valueField: 'itemEvalEvgScrg', reviewCountFields: ['reviewCnt', 'itemEvalCnt'], ratingCountField: null };
  row.operations.review_samples = { state: 'not_observed', reason: 'product detail server payload had no review sample rows in rcswList' };
  row.frontier.push({ operation: 'product_catalog_pagination', reason: 'ranking_page_returns_limited_visible_lists_not_complete_catalog',
    sectionId: String(sectId), listed: row.records.length, complete: false });
  row.frontier.push({ operation: 'review_samples', reason: 'no_review_bodies_or_samples_in_server_rendered_detail_payload' });
  if (row.records.length) row.status = 'records_observed';
}

async function collectNsmallSearch(row, query, checkedAt, homepageHtml, homepageUrl) {
  const hosts = PROVIDER_ROOTS.nsseshop;
  const entryUrl = safeUrl(homepageUrl) ?? 'https://m.nsmall.com/';
  const entryScriptUrl = nsmallVisibleScriptUrls(homepageHtml, entryUrl)
    .find(url => /\/assets\/index-[A-Za-z0-9_-]+\.js$/i.test(new URL(url).pathname));
  if (!entryScriptUrl) {
    row.operations.product_search = { state: 'not_observed', reason: 'homepage_did_not_expose_entry_script' };
    row.frontier.push({ operation: 'product_search', reason: 'homepage_did_not_expose_entry_script' });
    return;
  }
  const entryRead = await readObservedResource(entryScriptUrl, hosts, 'nsseshop');
  row.receipts.push(entryRead.receipt);
  if (!entryRead.resource.ok) {
    row.operations.product_search = { state: entryRead.resource.blocked ? 'blocked' : 'unavailable', reason: entryRead.resource.stopReason };
    row.frontier.push({ operation: 'product_search', reason: entryRead.resource.stopReason ?? 'ENTRY_SCRIPT_UNAVAILABLE' });
    return;
  }
  const entryScript = entryRead.resource.body;
  const searchChunkUrl = nsmallAssetUrl(entryScript, /(?<![A-Za-z0-9_-])search-result-[A-Za-z0-9_-]+\.js/);
  const detailChunkUrl = nsmallAssetUrl(entryScript, /(?<![A-Za-z0-9_-])detail-[A-Za-z0-9_-]+\.js/);
  const entryReceiptId = entryRead.receipt.receiptId;
  const assetReads = [];
  for (const [kind, assetUrl] of [['search_route_bundle', searchChunkUrl], ['product_detail_bundle', detailChunkUrl]]) {
    if (!assetUrl) continue;
    const loaded = await readObservedResource(assetUrl, hosts, 'nsseshop');
    row.receipts.push(loaded.receipt);
    assetReads.push({ kind, url: assetUrl, ...loaded });
    if (loaded.resource.blocked) {
      row.operations.product_search = { state: 'blocked', reason: loaded.resource.stopReason };
      row.frontier.push({ operation: 'product_search', reason: loaded.resource.stopReason, url: safeUrl(assetUrl) });
      return;
    }
  }
  const searchBundle = assetReads.find(item => item.kind === 'search_route_bundle' && item.resource.ok);
  const detailBundle = assetReads.find(item => item.kind === 'product_detail_bundle' && item.resource.ok);
  const searchHasContract = /goodsResultSearch/.test(entryScript)
    && /searchTerm:encodeURIComponent\(ua\.value\),pageNum:hl\.pageNum,pageSize:hl\.pageSize/.test(searchBundle?.resource.body ?? '')
    && /pageNum:1,hasNextPage:!1,totalCount:0,get pageSize\(\)\{return t\?40:20\}/.test(searchBundle?.resource.body ?? '');
  const ratingSemanticsObserved = /aggregateRating/.test(detailBundle?.resource.body ?? '')
    && /ratingValue:Number\(a\.score\)/.test(detailBundle?.resource.body ?? '')
    && /reviewCount:Number\(a\.ptcptCnt\)/.test(detailBundle?.resource.body ?? '')
    && /bestRating:5,worstRating:1/.test(detailBundle?.resource.body ?? '');
  row.contracts.push({ kind: 'observed_nsmall_client_assets', homepageUrl: safeUrl(entryUrl), entryScriptUrl: safeUrl(entryScriptUrl),
    entryScriptReceiptId: entryReceiptId, searchRouteBundleUrl: safeUrl(searchChunkUrl),
    searchRouteReceiptId: searchBundle?.receipt.receiptId ?? null, detailBundleUrl: safeUrl(detailChunkUrl),
    detailBundleReceiptId: detailBundle?.receipt.receiptId ?? null,
    routeEvidence: '/goods/{goodsCd} links are constructed from goodsCd in the entry bundle',
    queryEvidence: 'SearchResult route keyword; client sends busChnId=INT, deviceChnId=MOBIL, searchTerm=encodeURIComponent(routeKeyword), pageNum=1, pageSize=20, default sortCriteria=MR, mallNameFilter=""',
    reviewSemantics: ratingSemanticsObserved ? 'detail bundle maps score to AggregateRating.ratingValue and ptcptCnt to AggregateRating.reviewCount; bestRating=5,worstRating=1' : null,
    requestMethod: 'GET', cookiesSent: false, authorizationSent: false, browserUsed: false, verifiedAt: checkedAt });
  if (!searchHasContract) {
    row.operations.product_search = { state: 'not_replayed', reason: 'observed_search_contract_missing_from_route_bundle' };
    row.frontier.push({ operation: 'product_search', reason: 'observed_search_contract_missing_from_route_bundle' });
    return;
  }

  const params = new URLSearchParams({ busChnId: 'INT', deviceChnId: 'MOBIL', searchTerm: encodeURIComponent(query),
    pageNum: '1', pageSize: '20', sortCriteria: 'MR', searchType: '', mallNameFilter: '' });
  const searchUrl = `https://mapi.nsmall.com/md/api/v1/search/goodsResultSearch?${params.toString()}`;
  const searchRead = await readObservedResource(searchUrl, hosts, 'nsseshop', 2_000_000);
  row.receipts.push(searchRead.receipt);
  if (!searchRead.resource.ok) {
    row.operations.product_search = { state: searchRead.resource.blocked ? 'blocked' : 'unavailable',
      responseStatus: searchRead.resource.status, reason: searchRead.resource.stopReason, url: safeUrl(searchUrl) };
    row.frontier.push({ operation: 'product_search', reason: searchRead.resource.stopReason ?? 'SEARCH_UNAVAILABLE', url: safeUrl(searchUrl) });
    return;
  }
  let payload;
  try { payload = JSON.parse(searchRead.resource.body); }
  catch {
    row.operations.product_search = { state: 'unavailable', responseStatus: searchRead.resource.status, reason: 'SEARCH_RESPONSE_NOT_JSON' };
    row.frontier.push({ operation: 'product_search', reason: 'SEARCH_RESPONSE_NOT_JSON' });
    return;
  }
  const data = payload?.data?.resultData;
  if (payload?.data?.resultCode !== '0000' || !Array.isArray(data?.searchGoodsList)) {
    row.operations.product_search = { state: 'unavailable', responseStatus: searchRead.resource.status,
      resultCode: payload?.data?.resultCode ?? null, reason: 'SEARCH_RESULT_ENVELOPE_MISMATCH' };
    row.frontier.push({ operation: 'product_search', reason: 'SEARCH_RESULT_ENVELOPE_MISMATCH' });
    return;
  }
  const searchReceiptId = searchRead.receipt.receiptId;
  const ratingReceiptId = detailBundle?.receipt.receiptId ?? searchBundle?.receipt.receiptId ?? entryReceiptId;
  for (const [index, product] of data.searchGoodsList.entries()) {
    if (product?.goodsType !== 'product' || product.goodsCd == null || !product.productNm) continue;
    const amount = Number(product.dcPrice) > 0 ? Number(product.dcPrice)
      : Number(product.salePrice) > 0 ? Number(product.salePrice) : null;
    const ratingValue = Number.isFinite(Number(product.score)) && product.score !== '' && product.score != null ? Number(product.score) : null;
    const reviewCount = Number.isSafeInteger(Number(product.ptcptCnt)) && product.ptcptCnt != null && product.ptcptCnt !== ''
      ? Number(product.ptcptCnt) : null;
    const fields = ['sourceLocalId', 'title'];
    if (product.brandNm) fields.push('brand');
    if (amount != null) fields.push('price');
    if (ratingValue != null) fields.push('rating');
    if (reviewCount != null) fields.push('reviewCount');
    const routeEvidence = entryScript.includes('"/goods/".concat') && entryScript.includes('goodsCd');
    const ratingEvidence = ratingSemanticsObserved && (ratingValue != null || reviewCount != null);
    row.records.push({ type: 'RetailProduct', sourceLocalId: String(product.goodsCd), title: product.productNm,
      url: routeEvidence ? `https://m.nsmall.com/goods/${encodeURIComponent(String(product.goodsCd))}` : null,
      description: null, brand: product.brandNm || null,
      price: amount == null ? null : { amount, currency: 'KRW', priceText: `${amount.toLocaleString('ko-KR')}원` },
      rating: ratingValue == null && reviewCount == null ? null : { value: ratingValue, best: ratingEvidence ? 5 : null,
        worst: ratingEvidence ? 1 : null, reviewCount, ratingCount: null },
      variants: [], reviewSamples: [], relevance: { query, queryTextInTitle: product.productNm.includes(query) },
      evidence: [{ receiptId: searchReceiptId, locator: `data.resultData.searchGoodsList[${index}]`, fields },
        ...(routeEvidence ? [{ receiptId: entryReceiptId, locator: 'entry-bundle product link: "/goods/" + goodsCd', fields: ['url'] }] : []),
        ...(ratingEvidence ? [{ receiptId: ratingReceiptId, locator: 'detail-bundle JSON-LD mapping: score -> ratingValue, ptcptCnt -> reviewCount, bestRating=5, worstRating=1',
          fields: [...(ratingValue != null ? ['rating'] : []), ...(reviewCount != null ? ['reviewCount'] : [])] }] : [])] });
  }
  row.contracts.push({ kind: 'observed_consumer_search', sourceId: 'nsseshop', endpoint: 'https://mapi.nsmall.com/md/api/v1/search/goodsResultSearch',
    method: 'GET', query, requestParams: { busChnId: 'INT', deviceChnId: 'MOBIL', searchTerm: 'encodeURIComponent(query)',
      pageNum: 1, pageSize: 20, sortCriteria: 'MR', searchType: '', mallNameFilter: '' }, responseStatus: searchRead.resource.status,
    contentType: searchRead.resource.contentType, browserUsed: false, cookiesSent: false, authorizationSent: false,
    verifiedAt: checkedAt, source: 'first-party entry + SearchResult route JavaScript, replayed by anonymous public GET' });
  row.operations.product_search = { state: row.records.length ? 'records_observed' : 'observed_no_records', query,
    responseStatus: searchRead.resource.status, pageNum: 1, pageSize: 20, resultCount: row.records.length,
    goodsTotalSize: Number.isFinite(Number(data.goodsTotalSize)) ? Number(data.goodsTotalSize) : null,
    hasNextPage: Boolean(data.hasNextPage), complete: !data.hasNextPage, responseResultCode: payload.data.resultCode };
  if (data.hasNextPage) row.frontier.push({ operation: 'product_search_pagination', reason: 'additional_search_pages_available',
    nextPage: 2, pageSize: 20, total: Number.isFinite(Number(data.goodsTotalSize)) ? Number(data.goodsTotalSize) : null,
    query, requestContract: 'same observed GET endpoint and parameters with pageNum incremented' });
  row.operations.rating_summary = { state: row.records.some(record => record.rating) ? 'aggregate_observed' : 'not_observed',
    ratingField: 'score', reviewCountField: 'ptcptCnt', ratingCountField: null };
  if (row.records.length) row.status = 'records_observed';
}

function observedMetaRefreshTarget(html, pageUrl, allowedHosts) {
  const root = parseFragment(html ?? '');
  const meta = descendants(root, node => node.tagName === 'meta'
    && String(attribute(node, 'http-equiv') ?? '').toLowerCase() === 'refresh')[0];
  const content = attribute(meta, 'content');
  const match = /(?:^|;)\s*url\s*=\s*['"]?([^'";]+)['"]?/i.exec(content ?? '');
  if (!match) return null;
  try {
    const parsed = new URL(match[1].trim(), pageUrl);
    if (parsed.protocol !== 'https:' || !allowedHosts.some(rootHost => parsed.hostname === rootHost || parsed.hostname.endsWith(`.${rootHost}`))) return null;
    return parsed.href;
  } catch { return null; }
}

function observedScriptNavigations(html, baseUrl, allowedHosts) {
  const found = [];
  const source = String(html ?? '');
  const pattern = /(?:window\s*\.\s*)?location(?:\s*\.\s*href)?\s*=\s*(['"])(.*?)\1/g;
  for (const match of source.matchAll(pattern)) {
    try {
      const parsed = new URL(match[2], baseUrl);
      if (parsed.protocol === 'https:' && allowedHosts.some(rootHost => parsed.hostname === rootHost || parsed.hostname.endsWith(`.${rootHost}`))) {
        if (!found.includes(parsed.href)) found.push(parsed.href);
      }
    } catch { /* Ignore non-URL script navigation strings. */ }
  }
  return found;
}

async function collectYes24Continuation(row, homepage, checkedAt) {
  if (!homepage.page.ok || !homepage.page.html) return;
  const observedTargets = observedScriptNavigations(homepage.page.html, homepage.page.url, PROVIDER_ROOTS.yes24);
  const mobileHome = observedTargets.find(url => new URL(url).hostname === 'm.yes24.com');
  if (!mobileHome) return;
  const mobile = await readPage(mobileHome, PROVIDER_ROOTS.yes24, 'yes24', 'RetailProduct');
  row.receipts.push(mobile.receipt);
  row.contracts.push(pageContract(mobile, 'observed_homepage_script_navigation', checkedAt, 'YES24 mobile main'));
  if (!mobile.page.ok || mobile.page.blocked) {
    row.frontier.push({ operation: 'product_catalog', reason: mobile.page.stopReason ?? `HTTP_${mobile.page.status}`, url: safeUrl(mobileHome) });
    row.operations.product_catalog = { state: mobile.page.blocked ? 'blocked' : 'unavailable', responseStatus: mobile.page.status,
      reason: mobile.page.stopReason ?? 'observed_mobile_main_unavailable', url: safeUrl(mobileHome) };
    return;
  }
  if (/시스템 처리 시 에러가 발생하였습니다/.test(mobile.pageData?.title ?? '')) {
    row.operations.homepage_routing = { state: 'observed_error_page', targetUrl: safeUrl(mobile.page.url),
      responseStatus: mobile.page.status, pageTitle: mobile.pageData.title, redirects: mobile.page.redirects ?? [] };
    row.operations.product_catalog = { state: 'unavailable', reason: 'first_party_pc_and_mobile_homepages_redirect_to_visible_system_error_page' };
    row.frontier.push({ operation: 'product_catalog', reason: 'first_party_pc_and_mobile_homepages_redirect_to_visible_system_error_page',
      responseStatus: mobile.page.status, pageTitle: mobile.pageData.title, url: safeUrl(mobile.page.url) });
    return;
  }
  addPageRecords(row, mobile, 'yes24', PROVIDER_ROOTS.yes24);
  row.operations.homepage_routing = { state: 'observed', targetUrl: safeUrl(mobile.page.url), responseStatus: mobile.page.status,
    redirects: mobile.page.redirects ?? [] };
}

async function collectHimartContinuation(row, homepage, checkedAt) {
  if (!homepage.page.ok || !homepage.page.html) return;
  const metaTarget = observedMetaRefreshTarget(homepage.page.html, homepage.page.url, PROVIDER_ROOTS.himart);
  if (!metaTarget) return;
  const indexPage = await readPage(metaTarget, PROVIDER_ROOTS.himart, 'himart', 'RetailProduct');
  row.receipts.push(indexPage.receipt);
  row.contracts.push(pageContract(indexPage, 'observed_homepage_meta_refresh', checkedAt));
  if (!indexPage.page.ok || indexPage.page.blocked) {
    row.operations.homepage_routing = { state: indexPage.page.blocked ? 'blocked' : 'unavailable',
      responseStatus: indexPage.page.status, reason: indexPage.page.stopReason ?? `HTTP_${indexPage.page.status}` };
    row.frontier.push({ operation: 'homepage_routing', reason: indexPage.page.stopReason ?? `HTTP_${indexPage.page.status}`,
      url: safeUrl(indexPage.page.url) });
    return;
  }
  const observedTargets = observedScriptNavigations(indexPage.page.html, indexPage.page.url, PROVIDER_ROOTS.himart)
    .filter(url => {
      const parsed = new URL(url);
      return parsed.pathname === '/app/display/main' && parsed.searchParams.has('originReferrer');
    });
  const entryUrl = observedTargets[0];
  if (!entryUrl) {
    row.operations.homepage_routing = { state: 'unavailable', metaRefreshUrl: safeUrl(metaTarget), reason: 'observed_homepage_entry_route_not_found' };
    row.frontier.push({ operation: 'homepage_routing', reason: 'observed_homepage_entry_route_not_found' });
    return;
  }

  const entryPage = await readHimartHtml(entryUrl);
  row.receipts.push(...entryPage.receipts);
  if (entryPage.page.ok) row.contracts.push(pageContract(entryPage, 'observed_index_script_navigation', checkedAt, new URL(entryUrl).pathname));
  const routeResult = { requestUrl: safeUrl(entryUrl), finalUrl: safeUrl(entryPage.page.url),
    status: entryPage.page.status, contentType: entryPage.page.contentType,
    bytes: entryPage.receipt?.bytes ?? null, redirects: entryPage.page.redirects, stopReason: entryPage.page.stopReason };
  row.operations.homepage_routing = { state: entryPage.page.blocked ? 'blocked' : entryPage.page.ok ? 'observed' : 'unavailable',
    metaRefreshUrl: safeUrl(metaTarget), entryRoute: routeResult };
  if (entryPage.page.blocked || !entryPage.page.ok) {
    row.frontier.push({ operation: 'homepage_routing', reason: entryPage.page.stopReason ?? `HTTP_${entryPage.page.status}`,
      url: safeUrl(entryPage.page.url) });
    if (entryPage.page.blocked) row.status = 'blocked';
    return;
  }

  const classicScriptUrl = observedScriptUrls(entryPage.page.html, entryPage.page.url)
    .find(url => /\/nativeSearch\.header\.js(?:\?|$)/i.test(url));
  if (!classicScriptUrl) {
    row.operations.product_catalog = { state: 'not_observed', reason: 'search_controller_asset_not_present_on_observed_entry_page' };
    row.frontier.push({ operation: 'product_catalog', reason: 'search_controller_asset_not_present_on_observed_entry_page' });
    return;
  }
  const classicScript = await readObservedResource(classicScriptUrl, PROVIDER_ROOTS.himart, 'himart', 500_000);
  row.receipts.push(classicScript.receipt);
  if (!classicScript.resource.ok || classicScript.resource.blocked) {
    row.operations.product_catalog = { state: classicScript.resource.blocked ? 'blocked' : 'unavailable',
      reason: classicScript.resource.stopReason ?? `HTTP_${classicScript.resource.status}`, url: safeUrl(classicScriptUrl) };
    row.frontier.push({ operation: 'product_catalog', reason: classicScript.resource.stopReason ?? `HTTP_${classicScript.resource.status}`,
      url: safeUrl(classicScriptUrl) });
    if (classicScript.resource.blocked) row.status = 'blocked';
    return;
  }
  const nativeSearchSource = classicScript.resource.body ?? '';
  const optPath = '/app/display/searchOptKeywordAjax';
  const redirectPath = '/app/display/searchRedirectAjax';
  if (!nativeSearchSource.includes(optPath) || !nativeSearchSource.includes(redirectPath)
    || !nativeSearchSource.includes('/app/search/nativeTotalSearch?topSearchQuery=')) {
    row.operations.product_catalog = { state: 'not_observed', reason: 'search_controller_contract_markers_missing' };
    row.frontier.push({ operation: 'product_catalog', reason: 'search_controller_contract_markers_missing' });
    return;
  }
  const ajaxContract = { kind: 'observed_anonymous_search_navigation', sourceAsset: safeUrl(classicScriptUrl),
    query: SEARCH_TERMS.himart, optionsMethod: 'POST', optionsPath: optPath, optionsBody: {},
    redirectMethod: 'POST', redirectPath, redirectBody: {},
    fallbackRoute: '/app/search/nativeTotalSearch?topSearchQuery={query}&query={query}&optChk={optChk}&FROM=MOBILETOP',
    browserUsed: false, cookiesSent: false, verifiedAt: checkedAt };
  const searchHomeUrl = new URL(entryPage.page.url);
  const optionsResult = await readHimartDirect(new URL(optPath, searchHomeUrl).href,
    { method: 'POST', body: '', contentType: 'application/x-www-form-urlencoded; charset=UTF-8', maxBytes: 250_000 });
  row.receipts.push(...optionsResult.receipts.map(item => directReceipt(item, optionsResult.url, optionsResult.redirects)));
  if (!optionsResult.ok) {
    row.operations.product_catalog = { state: optionsResult.blocked ? 'blocked' : 'unavailable',
      reason: optionsResult.stopReason, url: safeUrl(optionsResult.url) };
    row.frontier.push({ operation: 'product_catalog', reason: optionsResult.stopReason, url: safeUrl(optionsResult.url) });
    if (optionsResult.blocked) row.status = 'blocked';
    return;
  }
  const query = SEARCH_TERMS.himart.trim();
  const optChk = optionsResult.body.split('!@!').some(value => value.trim() === query) ? '1' : '';
  const redirectResult = await readHimartDirect(new URL(redirectPath, searchHomeUrl).href,
    { method: 'POST', body: '', contentType: 'application/x-www-form-urlencoded; charset=UTF-8', maxBytes: 250_000 });
  row.receipts.push(...redirectResult.receipts.map(item => directReceipt(item, redirectResult.url, redirectResult.redirects)));
  if (!redirectResult.ok) {
    row.operations.product_catalog = { state: redirectResult.blocked ? 'blocked' : 'unavailable',
      reason: redirectResult.stopReason, url: safeUrl(redirectResult.url) };
    row.frontier.push({ operation: 'product_catalog', reason: redirectResult.stopReason, url: safeUrl(redirectResult.url) });
    if (redirectResult.blocked) row.status = 'blocked';
    return;
  }
  const redirectPair = redirectResult.body.split('!@!').map(value => value.trim()).filter(Boolean)
    .map(value => value.split(',')).find(parts => parts[0]?.trim() === query);
  let searchRouteUrl;
  if (redirectPair?.[1]) {
    const bridge = new URL('/app/search/nativeTotalSearchBridge', searchHomeUrl);
    bridge.searchParams.set('query', query);
    bridge.searchParams.set('rtnUrl', redirectPair[1]);
    searchRouteUrl = bridge.href;
    ajaxContract.redirectMatchObserved = true;
  } else {
    const route = new URL('/app/search/nativeTotalSearch', searchHomeUrl);
    route.searchParams.set('topSearchQuery', query);
    route.searchParams.set('query', query);
    route.searchParams.set('optChk', optChk);
    route.searchParams.set('FROM', 'MOBILETOP');
    searchRouteUrl = route.href;
    ajaxContract.redirectMatchObserved = false;
  }
  row.contracts.push({ ...ajaxContract, optionsResponseStatus: optionsResult.receipts.at(-1)?.responseStatus ?? null,
    optionsBytes: optionsResult.receipts.at(-1)?.bytes ?? null, optChk,
    redirectResponseStatus: redirectResult.receipts.at(-1)?.responseStatus ?? null,
    redirectBytes: redirectResult.receipts.at(-1)?.bytes ?? null });

  const searchPage = await readHimartHtml(searchRouteUrl);
  row.receipts.push(...searchPage.receipts);
  if (!searchPage.page.ok || searchPage.page.blocked) {
    row.operations.product_catalog = { state: searchPage.page.blocked ? 'blocked' : 'unavailable',
      reason: searchPage.page.stopReason ?? `HTTP_${searchPage.page.status}`, searchUrl: safeUrl(searchRouteUrl) };
    row.frontier.push({ operation: 'product_catalog', reason: searchPage.page.stopReason ?? `HTTP_${searchPage.page.status}`,
      url: safeUrl(searchRouteUrl) });
    if (searchPage.page.blocked) row.status = 'blocked';
    return;
  }
  row.contracts.push(pageContract(searchPage, 'observed_native_search_results_route', checkedAt, query));
  const modulePreloads = observedModulePreloads(searchPage.page.html, searchPage.page.url, PROVIDER_ROOTS.himart);
  const assetTargets = [
    ['native_search_route_bundle', modulePreloads.find(url => /\/nativeTotalSearch\.[A-Za-z0-9_-]+\.js(?:\?|$)/.test(url))],
    ['native_search_store_bundle', modulePreloads.find(url => /\/storeSearchData\.[A-Za-z0-9_-]+\.js(?:\?|$)/.test(url))],
    ...modulePreloads.filter(url => /\/service\.[A-Za-z0-9_-]+\.js(?:\?|$)/.test(url))
      .map(url => ['native_search_service_bundle', url]),
    ['native_search_get_helper', modulePreloads.find(url => /\/entry\.[A-Za-z0-9_-]+\.js(?:\?|$)/.test(url))],
  ];
  const scriptReads = [];
  for (const [kind, url] of assetTargets) {
    if (!url) continue;
    const loaded = await readObservedResource(url, PROVIDER_ROOTS.himart, 'himart', kind === 'native_search_get_helper' ? 4_000_000 : 1_000_000);
    row.receipts.push(loaded.receipt);
    scriptReads.push({ kind, url, ...loaded });
    if (loaded.resource.blocked) {
      row.operations.product_catalog = { state: 'blocked', reason: loaded.resource.stopReason, url: safeUrl(url) };
      row.frontier.push({ operation: 'product_catalog', reason: loaded.resource.stopReason, url: safeUrl(url) });
      row.status = 'blocked';
      return;
    }
  }
  const routeBundle = scriptReads.find(item => item.kind === 'native_search_route_bundle' && item.resource.ok);
  const storeBundle = scriptReads.find(item => item.kind === 'native_search_store_bundle' && item.resource.ok);
  const serviceBundle = scriptReads.find(item => item.kind === 'native_search_service_bundle' && item.resource.ok
    && item.resource.body.includes('/app/api/new/display-service/v2/module'));
  const getHelper = scriptReads.find(item => item.kind === 'native_search_get_helper' && item.resource.ok);
  const bundleEvidence = Boolean(routeBundle && storeBundle && serviceBundle && getHelper
    && routeBundle.resource.body.includes('HMG_SCH_KWD_01')
    && serviceBundle.resource.body.includes('/app/api/new/display-service/v2/module')
    && storeBundle.resource.body.includes('/app/api/new/display-service/v2/search')
    && getHelper.resource.body.includes('method:"get"'));
  if (!bundleEvidence) {
    row.operations.product_catalog = { state: 'not_observed', reason: 'native_search_bundle_contract_incomplete' };
    row.frontier.push({ operation: 'product_catalog', reason: 'native_search_bundle_contract_incomplete' });
    return;
  }
  const apiPath = '/app/api/new/display-service/v2/module/nativeTotalSearch';
  const routeParams = Object.fromEntries(new URL(searchPage.page.url).searchParams.entries());
  const apiUrl = new URL(apiPath, searchPage.page.url);
  for (const [key, value] of Object.entries(routeParams)) apiUrl.searchParams.set(key, value);
  const loadedModule = await readObservedResource(apiUrl.href, PROVIDER_ROOTS.himart, 'himart', 5_000_000);
  row.receipts.push(loadedModule.receipt);
  if (!loadedModule.resource.ok || loadedModule.resource.blocked) {
    row.operations.product_catalog = { state: loadedModule.resource.blocked ? 'blocked' : 'unavailable',
      reason: loadedModule.resource.stopReason ?? `HTTP_${loadedModule.resource.status}`, url: safeUrl(apiUrl.href) };
    row.frontier.push({ operation: 'product_catalog', reason: loadedModule.resource.stopReason ?? `HTTP_${loadedModule.resource.status}`,
      url: safeUrl(apiUrl.href) });
    if (loadedModule.resource.blocked) row.status = 'blocked';
    return;
  }
  let responseData;
  try { responseData = JSON.parse(loadedModule.resource.body); }
  catch { responseData = null; }
  const moduleItems = Array.isArray(responseData?.moduleMap) ? responseData.moduleMap
    : responseData?.moduleMap && typeof responseData.moduleMap === 'object' ? Object.values(responseData.moduleMap) : [];
  const goodsModule = moduleItems.find(item => item?.meta?.mdlId === 'HMG_SCH_KWD_01');
  const products = Array.isArray(goodsModule?.product) ? goodsModule.product : [];
  const apiReceiptId = loadedModule.receipt.receiptId;
  const templateReceiptId = storeBundle.receipt.receiptId;
  const money = value => Number.isFinite(hmallNumber(value)) ? hmallNumber(value) : null;
  const safeText = (value, limit = 2000) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, limit).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[이메일]')
    .replace(/(?:\+?82[\s-]?)?0\d{1,2}[\s-]?\d{3,4}[\s-]?\d{4}/g, '[전화번호]') || null : null;
  const mapProduct = (item, index) => {
    const sourceLocalId = typeof item?.goodsNo === 'string' || typeof item?.goodsNo === 'number' ? String(item.goodsNo) : null;
    const title = safeText(item?.goodsNm, 1000);
    if (!sourceLocalId || !title) return null;
    const priceSource = item.priceDispInfo ?? item.priceInfo ?? {};
    const priceInfo = item.priceInfo ?? {};
    const priceAmount = money(priceSource.salePrc ?? priceInfo.dscntSalePrc ?? priceInfo.salePrc);
    const ratingValue = money(item.gdasInfo?.gdasRt);
    const reviewCount = money(item.gdasInfo?.gdasCnt);
    const rating = ratingValue === 0 && reviewCount === 0 || ratingValue == null && reviewCount == null ? null : {
      value: ratingValue, best: 5, worst: 1, reviewCount: reviewCount && reviewCount > 0 ? reviewCount : null, ratingCount: null,
    };
    const prefix = safeText(priceSource.prcPrefix ?? priceInfo.prcPrefix, 100);
    const unit = safeText(priceSource.prcUnit ?? priceSource.prcSuffix ?? priceInfo.prcUnit ?? priceInfo.prcSuffix ?? '원', 100) ?? '원';
    const formattedAmount = priceAmount == null ? null : priceAmount.toLocaleString('ko-KR');
    const maxBenefit = money(priceSource.maxBenefitPrc ?? priceInfo.maxBenefitPrc);
    const parts = [];
    if (priceAmount != null) parts.push(`${prefix ? `${prefix} ` : ''}${formattedAmount}${unit.includes('원') ? unit : `원${unit}`}`);
    if (maxBenefit != null && maxBenefit > 0 && maxBenefit !== priceAmount) parts.push(`최대혜택가 ${maxBenefit.toLocaleString('ko-KR')}원`);
    const priceNote = safeText(priceSource.prcTxt ?? priceInfo.prcTxt, 300);
    if (priceNote) parts.push(priceNote);
    const subscriptionText = [prefix, priceNote, ...parts].filter(Boolean).join(' ');
    const isMonthlySubscription = /월\s*구독료|구독료\s*\/\s*월|월\s*납부/.test(subscriptionText);
    const subscriptionConditions = priceNote?.split(/[\/|]/).map(value => value.trim()).filter(Boolean) ?? [];
    const attributes = Array.isArray(item.goodsAttrs) ? item.goodsAttrs.filter(attr => attr?.attrGrp && attr?.attrVal)
      .map(attr => ({ name: safeText(attr.attrGrp, 100), value: safeText(attr.attrVal, 500) }))
      .filter(attr => attr.name && attr.value) : [];
    const categoryName = safeText(item.mastDispInfo?.categoryM?.cateNm, 200);
    if (categoryName) attributes.unshift({ name: '카테고리', value: categoryName });
    const description = safeText(item.prInfo?.prCont ?? item.promWord, 2000);
    const brand = safeText(item.brndNm, 200);
    const productUrl = safeUrl(new URL(`/app/goods/goodsDetail?goodsNo=${encodeURIComponent(sourceLocalId)}`, searchPage.page.url).href);
    const fields = ['sourceLocalId', 'title', ...(brand ? ['brand'] : []), ...(productUrl ? ['url'] : []),
      ...(priceAmount != null ? ['price'] : []), ...(description ? ['description'] : []),
      ...(rating?.value != null ? ['rating'] : []), ...(rating?.reviewCount != null ? ['reviewCount'] : []),
      ...(attributes.length ? ['attributes'] : [])];
    return { type: 'RetailProduct', sourceLocalId, title, url: productUrl, description, brand,
      price: priceAmount == null ? null : { amount: priceAmount, currency: 'KRW', priceText: parts.join(' / ') || `${formattedAmount}원`,
        ...(isMonthlySubscription ? { billingPeriod: 'month', priceKind: 'advertised_monthly_rate',
          ...(subscriptionConditions.length ? { conditions: subscriptionConditions, discountCondition: subscriptionConditions.join('; ') } : {}) } : {}) },
      rating, attributes, variants: [], reviewSamples: [],
      relevance: { query, queryApplied: true, queryTextInTitle: title.includes(query), retrievalKind: 'native_keyword_search',
        sourcePageUrl: safeUrl(searchPage.page.url), sourceRank: index + 1 },
      evidence: [
        { receiptId: apiReceiptId, locator: `moduleMap.HMG_SCH_KWD_01.product[${index}]`,
          fields: fields.filter(field => field !== 'url') },
        ...(productUrl ? [{ receiptId: templateReceiptId,
          locator: 'observed native detail-route template /app/goods/goodsDetail?goodsNo={goodsNo}', fields: ['url'] }] : []),
      ] };
  };
  const mapped = products.map((item, index) => mapProduct(item, index)).filter(Boolean);
  const seen = new Set(row.records.map(record => `${record.sourceLocalId ?? ''}\0${record.url ?? ''}`));
  for (const record of mapped) {
    const key = `${record.sourceLocalId ?? ''}\0${record.url ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    row.records.push(record);
  }
  const totalResults = money(goodsModule?.totalCnt);
  const pageNumber = money(goodsModule?.page) ?? 1;
  const pageSize = money(goodsModule?.pageSize) ?? mapped.length;
  row.contracts.push({ kind: 'observed_native_keyword_search_api', method: 'GET', endpoint: apiPath,
    query: routeParams.query ?? query, queryParams: routeParams, sourceModuleId: 'HMG_SCH_KWD_01',
    responseStatus: loadedModule.resource.status, responseContentType: loadedModule.resource.contentType,
    totalResults, page: pageNumber, pageSize, returnedRecords: mapped.length,
    sourceAssets: scriptReads.map(item => safeUrl(item.url)), browserUsed: false, cookiesSent: false, verifiedAt: checkedAt });
  row.operations.product_search = { state: mapped.length ? 'records_observed' : 'observed_no_records', query,
    queryApplied: true, responseStatus: loadedModule.resource.status, resultCount: mapped.length, totalResults,
    page: pageNumber, pageSize, catalogComplete: totalResults != null && mapped.length >= totalResults,
    endpoint: safeUrl(apiUrl.href), ratingField: 'gdasInfo.gdasRt', reviewCountField: 'gdasInfo.gdasCnt', ratingCountField: null };
  row.operations.product_catalog = { state: mapped.length ? 'records_observed' : 'observed_no_records',
    recordCount: mapped.length, totalSearchResults: totalResults, complete: totalResults != null && mapped.length >= totalResults,
    scope: { query, page: pageNumber, pageSize } };
  if (totalResults != null && mapped.length < totalResults) row.frontier.push({ operation: 'product_search_pagination',
    reason: 'page_1_only_of_observed_keyword_search', totalResults, page: pageNumber, pageSize, complete: false });
  row.operations.rating_summary = { state: mapped.some(record => record.rating?.value != null) ? 'aggregate_observed' : 'not_observed',
    ratingField: 'gdasInfo.gdasRt', reviewCountField: 'gdasInfo.gdasCnt', ratingCountField: null };
  row.operations.review_samples = { state: 'not_observed', reason: 'search_result_api_returns_aggregate_rating_counts_only' };

  const detailRecords = row.records.filter(record => record.relevance?.retrievalKind === 'native_keyword_search').slice(0, 2);
  for (const record of detailRecords) {
    if (!record.url) continue;
    const detail = await readHimartHtml(record.url);
    row.receipts.push(...detail.receipts);
    if (detail.page.ok) row.contracts.push(pageContract(detail, 'observed_search_product_detail', checkedAt, record.title));
    else {
      row.frontier.push({ operation: 'product_detail', url: record.url,
        reason: detail.page.stopReason ?? `HTTP_${detail.page.status}`, blocked: detail.page.blocked });
      if (detail.page.blocked) { row.status = 'blocked'; break; }
      continue;
    }
    const detailRecord = (detail.pageData?.records ?? []).find(item => item.title === record.title);
    if (!detailRecord) continue;
    const fields = [];
    if (detailRecord.price?.amount != null && detailRecord.price.amount === record.price?.amount) fields.push('price');
    if (detailRecord.rating?.value != null && detailRecord.rating.value === record.rating?.value) fields.push('rating');
    if (detailRecord.rating?.reviewCount != null && detailRecord.rating.reviewCount === record.rating?.reviewCount) fields.push('reviewCount');
    if (detailRecord.reviewSamples?.length) {
      record.reviewSamples = detailRecord.reviewSamples.map(sample => ({ ...sample, author: null }));
      fields.push('reviewSamples');
    }
    if (fields.length) record.evidence.push({ receiptId: detail.receipt.receiptId,
      locator: 'script[type="application/ld+json"]:Product', fields });
  }
  if (row.records.length) row.status = 'records_observed';
}

function signgateProductDetailLinks(page, category) {
  if (!page.page.ok || !page.page.html) return [];
  const pattern = category === 'individual' ? /\/apply\/searchIndvdlProductDetail\.sg(?:\?|$)/ : /\/apply\/searchEntprsProductDetail\.sg(?:\?|$)/;
  const root = parseFragment(page.page.html);
  const found = new Map();
  for (const anchor of descendants(root, node => node.tagName === 'a')) {
    const href = attribute(anchor, 'href');
    if (!href || !pattern.test(href)) continue;
    let url;
    let productKey;
    try {
      url = new URL(href, page.page.url);
      productKey = JSON.parse(url.searchParams.get('prodKey') ?? 'null');
    } catch { continue; }
    const productId = productKey?.prodId;
    if (typeof productId !== 'string' || !/^[A-Za-z0-9]+$/.test(productId) || found.has(productId)) continue;
    found.set(productId, { url: url.href, productId, listingIndex: found.size });
  }
  return [...found.values()];
}

function signgateDetailRecord(detail, listPage, productLink, saleNotice) {
  if (!detail.page.ok || !detail.page.html) return null;
  const visible = (textContent(detail.page.html, 80_000) ?? '').replace(/\s+/g, ' ').trim();
  const detailHeading = visible.indexOf('상품 상세 설명');
  if (detailHeading < 0) return null;
  const section = visible.slice(detailHeading, detailHeading + 5000);
  const priceMatch = /상품 상세 설명\s*(.+?)\s*가격\s*([\d,]+)\s*\(\s*부가세\s*포함\s*\)/.exec(section);
  if (!priceMatch) return null;
  const title = priceMatch[1].trim().replace(/\s+/g, ' ');
  const amount = Number(priceMatch[2].replaceAll(',', ''));
  if (!title || !Number.isFinite(amount)) return null;
  const useMatch = /사용용도\s*(.+?)(?:\s*제출\s*서류\s*안내|\s*상품\s*문의|\s*관련\s*상품|$)/.exec(section);
  const targetMatch = /대상\s*(.+?)\s*기간\s*([\d,]+\s*개월)/.exec(section);
  const durationMatch = /기간\s*([\d,]+\s*개월)/.exec(section);
  const prodKey = (() => { try { return JSON.parse(new URL(detail.page.url).searchParams.get('prodKey') ?? 'null'); } catch { return null; } })();
  const sourceLocalId = prodKey?.prodId ?? productLink.productId;
  const listEvidence = { receiptId: listPage.receipt.receiptId,
    locator: `visible product detail anchor at product-list item ${productLink.listingIndex}`, fields: ['sourceLocalId', 'url'] };
  const fields = ['title', 'price', 'brand'];
  if (useMatch?.[1]?.trim()) fields.push('description');
  const attributes = [
    ...(targetMatch?.[1]?.trim() ? [{ name: '대상', value: targetMatch[1].trim() }] : []),
    ...(durationMatch?.[1]?.trim() ? [{ name: '이용 기간', value: durationMatch[1].trim() }] : []),
  ];
  if (attributes.length) fields.push('attributes');
  const detailEvidence = { receiptId: detail.receipt.receiptId,
    locator: 'visible product detail section: 상품 상세 설명, 가격, 대상, 기간, 사용용도', fields };
  return { type: 'ServiceOffering', sourceLocalId: String(sourceLocalId), title, url: safeUrl(detail.page.url),
    description: useMatch?.[1]?.trim() || null, brand: '한국정보인증',
    price: { amount, currency: 'KRW', priceText: `${amount.toLocaleString('ko-KR')}원 (부가세 포함)` },
    rating: null,
    attributes, variants: [], reviewSamples: [], relevance: { query: null, queryApplied: false, retrievalKind: 'service_catalog_detail',
      sourcePageUrl: safeUrl(listPage.page.url), listingSaysNoCurrentOffers: Boolean(saleNotice) },
    evidence: [listEvidence, detailEvidence] };
}

async function collectSigngateOfferings(row, homepage, checkedAt) {
  if (!homepage.page.ok || !homepage.page.html) return;
  const target = observedMetaRefreshTarget(homepage.page.html, homepage.page.url, PROVIDER_ROOTS.signgate);
  if (!target) {
    row.operations.service_catalog = { state: 'not_observed', reason: 'homepage_redirect_not_found' };
    row.frontier.push({ operation: 'service_catalog', reason: 'homepage_redirect_not_found' });
    return;
  }
  const main = await readPage(target, PROVIDER_ROOTS.signgate, 'signgate', 'ServiceOffering');
  row.receipts.push(main.receipt);
  row.contracts.push(pageContract(main, 'observed_homepage_meta_refresh', checkedAt));
  if (!main.page.ok || main.page.blocked) {
    row.operations.service_catalog = { state: main.page.blocked ? 'blocked' : 'unavailable', responseStatus: main.page.status,
      reason: main.page.stopReason ?? `HTTP_${main.page.status}` };
    row.frontier.push({ operation: 'service_catalog', reason: main.page.stopReason ?? `HTTP_${main.page.status}`,
      url: safeUrl(main.page.url) });
    return;
  }
  const rows = [
    { category: 'individual', landingPath: '/main/indvdlMain.sg', listPath: '/apply/searchIndvdlProductList.sg' },
    { category: 'enterprise', landingPath: '/main/entprsMain.sg', listPath: '/apply/searchEntprsProductList.sg' },
  ];
  let listNoticeSeen = false;
  const listObservations = [];
  for (const item of rows) {
    const landingLink = (main.pageData?.links ?? []).find(link => new URL(link.url).pathname === item.landingPath);
    if (!landingLink) {
      listObservations.push({ category: item.category, state: 'not_observed' });
      continue;
    }
    const landing = await readPage(landingLink.url, PROVIDER_ROOTS.signgate, 'signgate', 'ServiceOffering');
    row.receipts.push(landing.receipt);
    row.contracts.push(pageContract(landing, 'observed_service_line_landing', checkedAt, item.category));
    if (landing.page.blocked) {
      row.operations.service_catalog = { state: 'blocked', reason: landing.page.stopReason, url: safeUrl(landing.page.url) };
      row.frontier.push({ operation: 'service_catalog', reason: landing.page.stopReason, url: safeUrl(landing.page.url) });
      break;
    }
    if (!landing.page.ok) {
      listObservations.push({ category: item.category, state: 'landing_unavailable', responseStatus: landing.page.status,
        reason: landing.page.stopReason ?? `HTTP_${landing.page.status}` });
      continue;
    }
    const observedLink = (landing.pageData?.links ?? []).find(link => new URL(link.url).pathname === item.listPath);
    if (!observedLink) {
      listObservations.push({ category: item.category, state: 'product_list_link_not_observed', landingUrl: safeUrl(landing.page.url) });
      continue;
    }
    const listPage = await readPage(observedLink.url, PROVIDER_ROOTS.signgate, 'signgate', 'ServiceOffering');
    row.receipts.push(listPage.receipt);
    row.contracts.push(pageContract(listPage, 'observed_service_catalog_link', checkedAt, item.category));
    if (listPage.page.blocked) {
      row.operations.service_catalog = { state: 'blocked', reason: listPage.page.stopReason, url: safeUrl(listPage.page.url) };
      row.frontier.push({ operation: 'service_catalog', reason: listPage.page.stopReason, url: safeUrl(listPage.page.url) });
      break;
    }
    if (!listPage.page.ok) {
      listObservations.push({ category: item.category, state: 'unavailable', responseStatus: listPage.page.status,
        reason: listPage.page.stopReason ?? `HTTP_${listPage.page.status}` });
      continue;
    }
    const visible = (textContent(listPage.page.html, 100_000) ?? '').replace(/\s+/g, ' ').trim();
    const saleNotice = /현재\s*판매\s*중인\s*인증서\s*가\s*없습니다/.test(visible);
    listNoticeSeen ||= saleNotice;
    const productLinks = signgateProductDetailLinks(listPage, item.category);
    listObservations.push({ category: item.category, state: 'observed', listUrl: safeUrl(listPage.page.url),
      responseStatus: listPage.page.status, linkedDetailCount: productLinks.length, noCurrentOfferNotice: saleNotice,
      sampleLimit: 5, complete: false });
    row.contracts.push({ kind: 'observed_signgate_certificate_catalog', category: item.category,
      pageUrl: safeUrl(listPage.page.url), pageReceiptId: listPage.receipt.receiptId,
      linkedDetailCount: productLinks.length, noCurrentOfferNotice: saleNotice,
      noticeText: saleNotice ? '현재 판매 중인 인증서가 없습니다.' : null,
      linkPaths: productLinks.slice(0, 5).map(link => safeUrl(link.url)), complete: false,
      browserUsed: false, cookiesSent: false, authorizationSent: false, verifiedAt: checkedAt });
    for (const productLink of productLinks.slice(0, 5)) {
      const detail = await readPage(productLink.url, PROVIDER_ROOTS.signgate, 'signgate', 'ServiceOffering');
      row.receipts.push(detail.receipt);
      if (detail.page.blocked) {
        row.operations.service_catalog = { state: 'records_observed_detail_blocked', reason: detail.page.stopReason,
          url: safeUrl(productLink.url) };
        row.frontier.push({ operation: 'service_catalog_detail', reason: detail.page.stopReason, url: safeUrl(productLink.url) });
        break;
      }
      if (!detail.page.ok) {
        row.frontier.push({ operation: 'service_catalog_detail', reason: detail.page.stopReason ?? `HTTP_${detail.page.status}`,
          url: safeUrl(productLink.url) });
        continue;
      }
      const record = signgateDetailRecord(detail, listPage, productLink, saleNotice);
      if (record && !row.records.some(existing => existing.type === 'ServiceOffering' && existing.sourceLocalId === record.sourceLocalId)) {
        row.records.push(record);
      } else if (!record) {
        row.frontier.push({ operation: 'service_catalog_detail_fields', reason: 'named_product_price_or_usage_not_observed',
          url: safeUrl(productLink.url) });
      }
    }
  }
  const recordCount = row.records.filter(record => record.type === 'ServiceOffering').length;
  row.operations.service_catalog = { state: recordCount ? (listNoticeSeen ? 'records_observed_availability_conflict' : 'records_observed') : 'observed_no_sellable_offer_record',
    recordCount, catalogComplete: false, categoryListings: listObservations,
    availabilityCaveat: listNoticeSeen ? 'linked detail pages expose named priced certificates, while listing pages say there are no certificates currently on sale' : null };
  if (recordCount) row.status = 'records_observed';
  if (listNoticeSeen) row.frontier.push({ operation: 'service_catalog_availability',
    reason: 'listing_pages_state_no_current_offers_while_linked_detail_pages_still_expose_named_priced_services' });
  row.frontier.push({ operation: 'service_catalog_completeness', reason: 'only_first_five_linked_details_per_category_followed', complete: false });
  row.operations.review_samples = { state: 'not_observed', reason: 'service catalog and detail pages contain no product-review samples' };
}

function wooriSearchRequestUrl(query) {
  const observedFilterDefaults = [
    ['isTemplate', 'Y'], ['headerQuery', encodeURIComponent(query)], ['cate_depth', '1'], ['lvl1_cate_no', ''],
    ['lvl1_cate_nm', ''], ['lvl2_cate_no', ''], ['lvl2_cate_nm', ''], ['brand_no', ''], ['brand_nm', ''],
    ['brand_page', '1'], ['brand_sort', 'RANK/DESC'], ['min_price', ''], ['max_price', ''], ['style_cd', ''],
    ['color_cd', ''], ['entr_dawn_dlv_yn', 'N'], ['inst_cpn_yn', 'N'], ['dlv_free_yn', 'N'], ['tdy_snd_yn', 'N'],
    ['gdas_cnt_yn', 'N'], ['smtp_yn', 'N'], ['stpup_yn', 'N'], ['stpup_entr_contr_no', ''], ['requery', ''],
    ['gender_cd', ''], ['gender_nm', ''], ['size_cd', ''], ['stap_cd', ''], ['stap_yn', 'N'], ['goods_attr_code', ''],
  ];
  const observedUrlDefaults = [['page', '1'], ['lst_sort_cd', 'RANK/DESC'], ['colldisplay', '60'], ['dpml_no', '']];
  const queryString = [...observedFilterDefaults, ...observedUrlDefaults].map(([key, value]) => `${key}=${value}`).join('&');
  return { url: `https://www.lotteimall.com/search/searchMain.lotte?${queryString}`, observedFilterDefaults, observedUrlDefaults };
}

async function collectWooriSearch(row, query, searchPage, checkedAt) {
  if (!searchPage?.page?.ok || !searchPage.page.html) return;
  const hosts = PROVIDER_ROOTS.woori;
  const scripts = observedScriptUrls(searchPage.page.html, searchPage.page.url);
  const searchScriptUrl = scripts.find(url => /\/resources\/search\/dist\/search\.min\.js$/i.test(new URL(url).pathname));
  const listScriptUrl = scripts.find(url => /\/resources\/list_common\/dist\/list_common\.min\.js$/i.test(new URL(url).pathname));
  if (!searchScriptUrl) {
    row.operations.product_search = { state: 'not_replayed', reason: 'observed_search_script_not_found' };
    row.frontier.push({ operation: 'product_search', reason: 'observed_search_script_not_found' });
    return;
  }
  const searchScript = await readObservedResource(searchScriptUrl, hosts, 'woori');
  row.receipts.push(searchScript.receipt);
  if (searchScript.resource.blocked) {
    row.operations.product_search = { state: 'blocked', reason: searchScript.resource.stopReason, url: safeUrl(searchScriptUrl) };
    row.frontier.push({ operation: 'product_search', reason: searchScript.resource.stopReason, url: safeUrl(searchScriptUrl) });
    return;
  }
  const searchSource = searchScript.resource.ok ? searchScript.resource.body : '';
  const requestContractObserved = /\/search\/searchMain\.lotte\?/.test(searchSource)
    && /this\.base_domain\s*\+\s*link\s*\+\s*this\.getFormToURL\(\)/.test(searchSource)
    && /getFormToURL: function getFormToURL/.test(searchSource)
    && /page:\s*1/.test(searchSource)
    && /lst_sort_cd:\s*"RANK\/DESC"/.test(searchSource)
    && /colldisplay:\s*60/.test(searchSource);
  let listScriptReceiptId = null;
  let priceMarkupObserved = false;
  if (listScriptUrl) {
    const listScript = await readObservedResource(listScriptUrl, hosts, 'woori');
    row.receipts.push(listScript.receipt);
    if (listScript.resource.blocked) {
      row.operations.product_search = { state: 'blocked', reason: listScript.resource.stopReason, url: safeUrl(listScriptUrl) };
      row.frontier.push({ operation: 'product_search', reason: listScript.resource.stopReason, url: safeUrl(listScriptUrl) });
      return;
    }
    if (listScript.resource.ok && /item\.benefitPrc\?item\.benefitPrc:item\.normalPrc/.test(listScript.resource.body)) {
      priceMarkupObserved = true;
      listScriptReceiptId = listScript.receipt.receiptId;
    }
  }
  row.contracts.push({ kind: 'observed_woori_search_assets', searchScriptUrl: safeUrl(searchScriptUrl),
    searchScriptReceiptId: searchScript.receipt.receiptId, listScriptUrl: safeUrl(listScriptUrl),
    listScriptReceiptId, requestTemplateObserved: requestContractObserved,
    requestTemplate: 'search.min.js getFormToURL serializes initFilter defaults then urlparam defaults into GET /search/searchMain.lotte',
    priceTemplateObserved: priceMarkupObserved,
    priceTemplate: priceMarkupObserved ? 'list_common template displays benefitPrc when present, otherwise normalPrc; displays normalPrc as origin when different' : null,
    ratingFields: ['gdasVal2', 'gdasCnt'], ratingCountField: null,
    browserUsed: false, cookiesSent: false, authorizationSent: false, verifiedAt: checkedAt });
  if (!requestContractObserved) {
    row.operations.product_search = { state: 'not_replayed', reason: 'observed_search_template_defaults_not_verified' };
    row.frontier.push({ operation: 'product_search', reason: 'observed_search_template_defaults_not_verified' });
    return;
  }
  const request = wooriSearchRequestUrl(query);
  const searchRead = await readObservedResource(request.url, hosts, 'woori', 4_000_000);
  row.receipts.push(searchRead.receipt);
  if (!searchRead.resource.ok) {
    row.operations.product_search = { state: searchRead.resource.blocked ? 'blocked' : 'unavailable',
      responseStatus: searchRead.resource.status, reason: searchRead.resource.stopReason, url: safeUrl(request.url) };
    row.frontier.push({ operation: 'product_search', reason: searchRead.resource.stopReason ?? 'observed_search_default_request_failed',
      url: safeUrl(request.url) });
    return;
  }
  let payload;
  try { payload = JSON.parse(searchRead.resource.body); } catch { payload = null; }
  const units = Array.isArray(payload?.body) ? payload.body : [];
  const goodsUnit = units.find(item => item?.meta?.sid === 'search_result_goods_info' && Array.isArray(item.data));
  const headerUnit = units.find(item => item?.meta?.sid === 'search_result_header_info');
  const goods = goodsUnit?.data ?? [];
  const total = hmallNumber(headerUnit?.data?.totCount);
  const searchReceiptId = searchRead.receipt.receiptId;
  for (const [index, item] of goods.entries()) {
    if (item?.goodsNo == null || !item?.goodsNm) continue;
    const sourceLocalId = String(item.goodsNo);
    const benefit = hmallNumber(item.benefitPrc);
    const normal = hmallNumber(item.normalPrc);
    const amount = benefit ?? normal;
    const ratingMatch = /([0-5](?:\.\d+)?)\s*점/.exec(String(item.gdasVal2 ?? ''));
    const ratingValue = ratingMatch ? Number(ratingMatch[1]) : null;
    const reviewCount = hmallNumber(item.gdasCnt);
    const productUrl = typeof item.goodsUrl === 'string' ? safeUrl(new URL(item.goodsUrl, request.url).href) : null;
    const attributes = Array.isArray(item.goodsAttrInfoList) ? item.goodsAttrInfoList.filter(attr => attr?.attrNm && attr?.attrValNm)
      .map(attr => ({ name: String(attr.attrNm), value: String(attr.attrValNm) })) : [];
    const fields = ['sourceLocalId', 'title'];
    if (productUrl) fields.push('url');
    if (item.brandNm) fields.push('brand');
    if (amount != null) fields.push('price');
    if (ratingValue != null) fields.push('rating');
    if (reviewCount != null) fields.push('reviewCount');
    if (attributes.length) fields.push('attributes');
    const evidence = [{ receiptId: searchReceiptId, locator: `body[data.meta.sid=search_result_goods_info].data[${index}]`, fields }];
    if (priceMarkupObserved && listScriptReceiptId && amount != null) evidence.push({ receiptId: listScriptReceiptId,
      locator: 'list_common template uses benefitPrc else normalPrc; normalPrc is origin price when they differ', fields: ['price'] });
    const existing = row.records.find(record => String(record.sourceLocalId) === sourceLocalId);
    if (existing) continue;
    row.records.push({ type: 'RetailProduct', sourceLocalId, title: String(item.goodsNm), url: productUrl,
      description: null, brand: typeof item.brandNm === 'string' ? item.brandNm : null,
      price: amount == null ? null : { amount, currency: 'KRW', priceText: `${amount.toLocaleString('ko-KR')}원` },
      rating: ratingValue == null && reviewCount == null ? null : { value: ratingValue, best: null, worst: null,
        reviewCount, ratingCount: null }, attributes, variants: [], reviewSamples: [],
      relevance: { query, queryTextInTitle: String(item.goodsNm).includes(query), queryApplied: true,
        retrievalKind: 'consumer_search_result', sourcePageUrl: safeUrl(searchPage.page.url), searchPage: 1,
        sourceRank: index + 1 }, evidence });
  }
  row.contracts.push({ kind: 'observed_woori_consumer_search', endpoint: 'https://www.lotteimall.com/search/searchMain.lotte',
    method: 'GET', query, requestUrl: safeUrl(request.url), requestParams: { filterDefaults: Object.fromEntries(request.observedFilterDefaults),
      urlDefaults: Object.fromEntries(request.observedUrlDefaults), goods_attr_dummy: 'omitted_by_source_serializer' },
    responseStatus: searchRead.resource.status, contentType: searchRead.resource.contentType, total,
    pageSize: goods.length, responseUnit: goodsUnit?.meta?.sid ?? null, browserUsed: false, cookiesSent: false,
    authorizationSent: false, verifiedAt: checkedAt });
  row.operations.product_search = { state: row.records.length ? 'records_observed' : 'observed_no_records', query,
    responseStatus: searchRead.resource.status, resultCount: goods.length, total, page: 1,
    complete: total != null && goods.length >= total,
    priceField: priceMarkupObserved ? (goods.some(item => item.benefitPrc) ? 'benefitPrc (displayed), normalPrc (origin when different)' : 'normalPrc') : null,
    ratingField: 'gdasVal2', reviewCountField: 'gdasCnt', ratingCountField: null };
  const anchorUnit = units.find(item => item?.meta?.sid === 'search_result_page_anchor_info');
  const nextPageList = anchorUnit?.data?.nextPageList ?? [];
  if (total != null && goods.length < total) row.frontier.push({ operation: 'product_search_pagination', reason: 'first_ranked_page_only',
    query, currentPage: 1, pageSize: goods.length, total, nextPageObserved: nextPageList.length > 0,
    sourceParameter: 'urlparam.page', complete: false });
  row.operations.rating_summary = { state: row.records.some(record => record.rating?.value != null) ? 'aggregate_observed' : 'not_observed',
    ratingField: 'gdasVal2', reviewCountField: 'gdasCnt', ratingCountField: null };
  row.operations.review_samples = { state: 'not_observed', reason: 'search JSON exposed aggregate review count only; no review body samples' };
  if (row.records.length) row.status = 'records_observed';
}

async function collectKnownSearch(merchant, sourceId, query, now) {
  const receipts = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const headers = new Headers(init.headers ?? {});
    if (headers.has('cookie') || headers.has('authorization')) throw Object.assign(new Error('SEARCH_CREDENTIALS_FORBIDDEN'), { code: 'SEARCH_CREDENTIALS_FORBIDDEN' });
    const response = await fetch(url, { ...init, headers, credentials: 'omit', redirect: 'manual', cache: 'no-store' });
    const bytes = Buffer.from(await response.clone().arrayBuffer());
    const receiptId = `batch08:${merchant.merchantId}:${sha(url.href).slice(0, 16)}`;
    receipts.push({ receiptId, id: receiptId, requestMethod: init.method ?? 'GET', method: init.method ?? 'GET', requestUrl: safeUrl(url.href),
      responseStatus: response.status, contentType: response.headers.get('content-type'), bytes: bytes.length, responseSha256: sha(bytes),
      observedAt: now, browserUsed: false, cookiesSent: false, authorizationSent: false,
      transport: 'node_fetch_direct', credentials: 'omitted', redirect: response.status >= 300 && response.status < 400 ? 'not_followed' : null });
    return response;
  };
  const result = await collect(query, { onlySources: [sourceId], perSite: 20, kurlyDetails: 0, fetchImpl, sleepImpl: async () => {} });
  const candidates = (result.offers ?? []).filter(row => row.mall === sourceId);
  const receiptId = receipts.find(row => row.responseStatus === 200)?.receiptId ?? receipts[0]?.receiptId ?? null;
  const records = candidates.map(offer => ({
    type: 'RetailProduct', sourceLocalId: nullish(String(offer.id ?? '').replace(`${sourceId}:`, '')),
    title: nullish(offer.name), url: safeUrl(offer.url), description: null, brand: null,
    price: offer.price == null ? null : { amount: offer.price, currency: 'KRW', priceText: `${Number(offer.price).toLocaleString('ko-KR')}원` },
    rating: offer.rating == null && offer.reviews == null ? null : { value: nullish(offer.rating), best: null, worst: null,
      reviewCount: offer.reviewsCapped || offer.reviewsMissing ? null : nullish(offer.reviews),
      ratingCount: null },
    variants: [], reviewSamples: [],
    relevance: { query, queryTextInTitle: String(offer.name ?? '').includes(query) },
    evidence: receiptId ? [{ receiptId, locator: `response item ${offer.id}`, fields: [
      ...(offer.id != null ? ['sourceLocalId'] : []), ...(offer.name ? ['title'] : []), ...(offer.url ? ['url'] : []),
      ...(offer.price != null ? ['price'] : []), ...(offer.rating != null ? ['rating'] : []),
      ...(offer.reviews != null && !offer.reviewsCapped && !offer.reviewsMissing ? ['reviewCount'] : []),
    ] }] : [],
  }));
  return { receipts, records, operation: { kind: 'product_search', query, sourceId, searchResponseCount: receipts.length,
    resultCount: records.length, outcome: records.length ? 'records_observed' : Object.values(result.sites ?? {}).find(x => x?.error)?.error ?? 'no_records' } };
}

function candidateLinks(pageData, allowedHosts, currentUrl) {
  const seen = new Set();
  const candidates = [];
  for (const link of pageData?.links ?? []) {
    let url;
    try { url = new URL(link.url, currentUrl); } catch { continue; }
    const hostAllowed = allowedHosts.some(root => url.hostname === root || url.hostname.endsWith(`.${root}`));
    if (!hostAllowed || url.protocol !== 'https:' || url.pathname === new URL(currentUrl).pathname || /\.(?:css|js|png|jpe?g|webp|gif|svg|woff2?|ttf|ico|map)$/i.test(url.pathname)) continue;
    if (/(?:searchPrTprPrices|searchMain|searchCart|cart|wishlist|login|order)/i.test(url.pathname)) continue;
    const serviceRoute = ['signgate', 'allcredit'].includes(pageData?.merchantId) &&
      (/\/screen\//i.test(url.pathname) || /(?:certificate|service|credit|plan|product|price|fee)/i.test(url.pathname)) &&
      /(?:공동인증|신용|인증|이용권|상품|서비스|가격|요금)/i.test(link.text ?? '');
    if (!PRODUCT_PATH.test(url.pathname) && !serviceRoute) continue;
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    candidates.push({ url: url.href, text: link.text ?? '' });
  }
  const score = row => (/detail|goodsdetail|productdetail|itemview|bookdetail/i.test(row.url) ? 20 : 0)
    + (/상품|제품|도서|인증서|신용관리|요금|서비스/i.test(row.text) ? 10 : 0)
    + (pageData?.merchantId === 'cjbrand' && /정육|고기|육류/i.test(row.text) ? 30 : 0)
    - (/category-product-list|category|theme|event|plan/i.test(row.url) ? 5 : 0);
  return candidates.sort((a, b) => score(b) - score(a));
}

function observedSearchForm(pageData, allowedHosts, currentUrl, query) {
  const form = (pageData?.forms ?? []).find(row => row.method === 'GET' &&
    row.controls?.some(control => control.type === 'search' || /(?:search|keyword|query|kwd|kw|^q$)/i.test(control.name ?? '')));
  if (!form) return null;
  let action;
  try { action = new URL(form.action, currentUrl); } catch { return null; }
  if (action.protocol !== 'https:' || !allowedHosts.some(root => action.hostname === root || action.hostname.endsWith(`.${root}`))) return null;
  const control = form.controls.find(row => row.type === 'search' || /(?:search|keyword|query|kwd|kw|^q$)/i.test(row.name ?? ''));
  if (!control?.name) return null;
  action.searchParams.set(control.name, query);
  return { url: action.href, form: { action: safeUrl(form.action), method: form.method, field: control.name } };
}

function addPageRecords(row, pageResult, merchantId, allowedHosts) {
  if (!pageResult.page.ok || !pageResult.pageData) return 0;
  const pageData = { ...pageResult.pageData, pageUrl: pageResult.page.url };
  const additions = [
    ...mapExtractedRecords(pageData, merchantId, pageResult.receipt.receiptId)
      .map(record => merchantId === 'cjbrand' ? { ...record, relevance: cjRetrievalContext(pageResult.page.url, record.title) } : record),
    ...embeddedOfferingRecords(pageData, merchantId, pageResult.receipt.receiptId, allowedHosts, pageResult.page.url)
      .map(record => merchantId === 'cjbrand' ? { ...record, relevance: cjRetrievalContext(pageResult.page.url, record.title) } : record),
    ...(merchantId === 'cjbrand' ? cjVisibleCatalogRecords(pageResult) : []),
    ...(merchantId === 'allcredit' ? allcreditVisibleServiceRecord(pageResult) : []),
  ];
  const seen = new Set(row.records.map(record => `${record.type}\0${record.sourceLocalId ?? ''}\0${record.url ?? ''}\0${record.title ?? ''}`));
  let added = 0;
  for (const record of additions) {
    const key = `${record.type}\0${record.sourceLocalId ?? ''}\0${record.url ?? ''}\0${record.title ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    row.records.push(record);
    added += 1;
  }
  return added;
}

function pageContract(pageResult, kind, checkedAt, linkText = null) {
  const data = pageResult.pageData;
  return { kind, url: safeUrl(pageResult.page.url ?? pageResult.receipt.requestUrl), method: 'GET',
    responseStatus: pageResult.page.status ?? pageResult.receipt.responseStatus ?? null,
    contentType: pageResult.page.contentType ?? pageResult.receipt.contentType ?? null,
    pageTitle: data?.title ?? null, pageDescription: data?.description ?? null,
    linkCount: data?.links?.length ?? 0,
    links: (data?.links ?? []).filter(link => link.text).slice(0, 15).map(link => ({ url: safeUrl(link.url), text: link.text.slice(0, 120) })),
    forms: (data?.forms ?? []).map(form => ({ action: safeUrl(form.action), method: form.method,
      controls: form.controls.map(control => ({ name: control.name, type: control.type, label: control.label })) })),
    embeddedBlocks: (data?.embeddedJson ?? []).map(block => ({ id: block.id, topLevelKeys: Object.keys(block.value ?? {}).slice(0, 40) })),
    parser: 'public_page_extractor', linkText: linkText?.slice(0, 150) ?? null, verifiedAt: checkedAt, browserUsed: false, anonymous: true };
}

export async function collectMerchant(merchantId, { now = () => new Date() } = {}) {
  const merchant = liveMerchantRows().find(row => row.merchantId === merchantId);
  if (!merchant) throw new Error(`BATCH_08_MERCHANT_UNKNOWN:${merchantId}`);
  if (merchantId === 'gseshop') return { ...merchant, ...await collectGseshopPublic() };
  if (merchantId === 'yes24') return { ...merchant, ...await collectFailurePathMerchant(merchantId) };
  if (merchantId === 'kbbook') return { ...merchant, ...await collectNativeRecovery('kbbook', { now }) };
  const checkedAt = now().toISOString();
  if (merchantId === 'emart') {
    const result = await collectKnownSearch(merchant, 'ssg', SEARCH_TERMS.emart, checkedAt);
    return { ...merchant, checkedAt, receipts: result.receipts, records: result.records,
      status: result.records.length ? 'records_observed' : 'search_without_records',
      operations: { product_search: result.operation, reviews_list: { state: 'not_observed' } },
      contracts: [{ operation: 'observed_public_product_search', method: 'POST', endpoint: 'https://search.ssg.com/api/item/all', query: SEARCH_TERMS.emart }],
      frontier: [{ operation: 'product_detail_and_reviews', state: 'previous_www_origin_rejection_retained', retry: false }] };
  }
  const allowedHosts = PROVIDER_ROOTS[merchantId];
  const typeHint = ['signgate', 'allcredit'].includes(merchantId) ? 'ServiceOffering' : 'RetailProduct';
  const row = { ...merchant, checkedAt, receipts: [], records: [], contracts: [], operations: {}, frontier: [], status: 'pending' };
  const visited = new Set();
  const queue = [];
  let homepageBlocked = false;

  try {
    const homepage = await readPage(merchant.siteUrl, allowedHosts, merchantId, typeHint);
    row.receipts.push(homepage.receipt);
    row.operations.homepage = { responseStatus: homepage.page.status ?? homepage.receipt.responseStatus ?? null,
      contentType: homepage.page.contentType ?? homepage.receipt.contentType ?? null, stopReason: homepage.page.stopReason ?? null,
      redirects: homepage.page.redirects ?? [] };
    row.contracts.push(pageContract(homepage, 'homepage_read', checkedAt));
    if (homepage.page.blocked || !homepage.page.ok) {
      homepageBlocked = homepage.page.blocked;
      row.status = homepage.page.blocked ? 'blocked' : 'unavailable';
      row.frontier.push({ operation: 'homepage', reason: homepage.page.stopReason ?? `HTTP_${homepage.page.status}` });
    } else {
      addPageRecords(row, homepage, merchantId, allowedHosts);
      if (merchantId === 'gseshop') {
        const sameOriginLinks = (homepage.pageData?.links ?? []).filter(link => {
          try { return new URL(link.url).origin === new URL(homepage.page.url).origin; } catch { return false; }
        }).map(link => safeUrl(link.url));
        const scripts = observedScriptUrls(homepage.page.html, homepage.page.url);
        const visibleText = textContent(homepage.page.html, 1200);
        row.operations.homepage_content = { state: 'minimal_generic_shell',
          pageTitle: homepage.pageData?.title ?? null, visibleText, formCount: homepage.pageData?.forms?.length ?? 0,
          firstPartyScriptCount: scripts.length, sameOriginLinks, responseStatus: homepage.page.status,
          responseBytes: homepage.receipt.bytes ?? null };
        row.operations.product_catalog = { state: 'unavailable',
          reason: 'public_homepage_serves_only_title_stylesheet_and_self_link_without_catalog_or_search_content' };
        row.contracts.push({ kind: 'homepage_route_inventory', url: safeUrl(homepage.page.url), method: 'GET',
          sameOriginLinks, firstPartyScriptUrls: scripts.map(safeUrl), formCount: homepage.pageData?.forms?.length ?? 0,
          productRecordsObserved: row.records.length, visibleText, browserUsed: false, anonymous: true, verifiedAt: checkedAt });
        row.frontier.push({ operation: 'product_catalog', reason: row.operations.product_catalog.reason,
          responseStatus: homepage.page.status, responseBytes: homepage.receipt.bytes ?? null });
      }
      visited.add(homepage.page.url);
      const formSearch = observedSearchForm(homepage.pageData, allowedHosts, homepage.page.url, SEARCH_TERMS[merchantId]);
      if (formSearch) {
        const searchPage = await readPage(formSearch.url, allowedHosts, merchantId, typeHint);
        row.receipts.push(searchPage.receipt);
        row.contracts.push({ ...pageContract(searchPage, 'observed_search_form', checkedAt),
          formAction: formSearch.form.action, queryField: formSearch.form.field, query: SEARCH_TERMS[merchantId] });
        row.operations.form_search = { responseStatus: searchPage.page.status ?? searchPage.receipt.responseStatus ?? null,
          resultRecords: searchPage.page.ok ? addPageRecords(row, searchPage, merchantId, allowedHosts) : 0,
          stopReason: searchPage.page.stopReason ?? null };
        if (searchPage.page.blocked) {
          homepageBlocked = true;
          row.frontier.push({ operation: 'product_search', reason: searchPage.page.stopReason, url: safeUrl(formSearch.url) });
        } else if (searchPage.page.ok) {
          visited.add(searchPage.page.url);
          queue.push(...candidateLinks(searchPage.pageData, allowedHosts, searchPage.page.url).map(link => ({ ...link, depth: 1 })));
          if (merchantId === 'woori') await collectWooriSearch(row, SEARCH_TERMS.woori, searchPage, checkedAt);
        }
      }
      queue.push(...candidateLinks(homepage.pageData, allowedHosts, homepage.page.url).map(link => ({ ...link, depth: 1 })));
      let detailPagesRead = 0;
      while (queue.length && detailPagesRead < 6 && !homepageBlocked) {
        const link = queue.shift();
        if (visited.has(link.url)) continue;
        visited.add(link.url);
        const detail = await readPage(link.url, allowedHosts, merchantId, typeHint);
        row.receipts.push(detail.receipt);
        detailPagesRead += 1;
        if (detail.page.blocked || !detail.page.ok) {
          row.frontier.push({ operation: 'observed_detail_link', url: safeUrl(link.url), reason: detail.page.stopReason ?? `HTTP_${detail.page.status}` });
          if (detail.page.blocked) homepageBlocked = true;
          continue;
        }
        const added = addPageRecords(row, detail, merchantId, allowedHosts);
        row.contracts.push(pageContract(detail, 'observed_link_followed', checkedAt, link.text));
        if (!added) row.frontier.push({ operation: 'detail_fields', url: safeUrl(detail.page.url), reason: 'NO_NORMALIZED_OFFERING_FIELDS' });
        if (merchantId === 'cjbrand' && added > 0) {
          const visible = textContent(detail.page.html, 30000) ?? '';
          const total = /총\s*([\d,]+)\s*개의?\s*상품/.exec(visible)?.[1]?.replaceAll(',', '') ?? null;
          const visibleCardCount = cjVisibleCatalogRecords(detail).length;
          row.operations.catalog_list = { pageTitle: detail.pageData?.title ?? null, categoryUrl: safeUrl(detail.page.url),
            visibleRecords: visibleCardCount, recordsAddedFromPage: added,
            listedTotal: total == null ? null : Number(total), complete: total != null && visibleCardCount === Number(total) };
          break;
        }
        const children = candidateLinks(detail.pageData, allowedHosts, detail.page.url);
        const usefulChildren = merchantId === 'cjbrand' && row.records.length
          ? children.filter(child => /(?:detail|goodsDetail|productDetail|itemView)/i.test(child.url)) : children;
        if (!row.records.length || link.depth < 2) queue.push(...usefulChildren.map(child => ({ ...child, depth: link.depth + 1 })));
      }
      row.operations.observedPages = { detailPagesRead, queuedLinksRemaining: queue.length,
        recordsObservedFromPages: row.records.length, stoppedAfterAccessBlock: homepageBlocked };
      if (queue.length) row.frontier.push({ operation: 'observed_link_frontier', reason: 'PAGE_BUDGET_REACHED', remainingCandidates: queue.slice(0, 20).map(item => safeUrl(item.url)) });
      row.status = row.records.length ? 'records_observed' : 'public_pages_observed_no_ontology_record';
    }

    const searchSourceId = merchantId === '11st' ? 'elevenst' : merchantId === 'emart' ? 'ssg' : null;
    if (merchantId === 'hmall' && !homepageBlocked && homepage.page.ok) {
      await collectHmallRanking(row, homepage.page.html, homepage.page.url, checkedAt);
    }
    if (merchantId === 'yes24' && homepage.page.ok) await collectYes24Continuation(row, homepage, checkedAt);
    if (merchantId === 'himart' && homepage.page.ok) await collectHimartContinuation(row, homepage, checkedAt);
    if (merchantId === 'signgate' && homepage.page.ok) await collectSigngateOfferings(row, homepage, checkedAt);
    if (searchSourceId) {
      const search = await collectKnownSearch(merchant, searchSourceId, SEARCH_TERMS[merchantId], checkedAt);
      row.receipts.push(...search.receipts);
      row.records.push(...search.records);
      row.operations.product_search = search.operation;
      row.contracts.push({ kind: 'observed_consumer_search', sourceId: searchSourceId, query: SEARCH_TERMS[merchantId],
        method: searchSourceId === 'ssg' ? 'POST' : 'GET', browserUsed: false, cookiesSent: false,
        endpoint: searchSourceId === 'ssg' ? 'https://search.ssg.com/api/item/all' : 'https://apis.11st.co.kr/search/api/tab', verifiedAt: checkedAt });
      if (search.records.length) row.status = homepageBlocked ? 'records_observed_with_homepage_blocked' : 'records_observed';
    }
    if (merchantId === 'nsseshop' && !homepageBlocked && !row.receipts.some(receipt => [401, 403, 418, 429].includes(receipt.responseStatus))) {
      await collectNsmallSearch(row, SEARCH_TERMS.nsseshop, checkedAt, homepage.page.html, homepage.page.url);
    }
    if (['auction', 'gmarket'].includes(merchantId)) {
      row.operations.product_search = { state: 'not_attempted', reason: merchantId === 'auction'
        ? 'saved_site_policy_and_public_search_403' : 'saved_consumer_search_requires_protected_session' };
      row.frontier.push({ operation: 'product_search', reason: row.operations.product_search.reason });
    }
    if (merchantId === 'cjbrand') {
      row.operations.product_search = { state: 'not_observed', reason: 'only_broad_category_listing_observed',
        query: SEARCH_TERMS.cjbrand, queryApplied: false };
      row.frontier.push({ operation: 'product_search', reason: 'no_observed_keyword_search_form_or_endpoint' });
    }
    if (merchantId === 'allcredit') {
      const services = row.records.filter(record => record.type === 'ServiceOffering');
      row.operations.service_catalog = { state: services.length ? 'records_observed' : 'not_observed',
        recordCount: services.length, catalogComplete: false,
        sellabilityEvidence: 'each record comes from a named service detail page with a service selection control, visible feature list, and an 신청하기 action',
        fieldsObserved: ['sourceLocalId', 'title', 'url', 'description', 'brand'], priceObserved: false,
        sourcePages: services.map(record => record.url) };
      if (services.length) row.frontier.push({ operation: 'service_catalog_completeness',
        reason: 'only named service detail pages reached within observed-link page budget', complete: false });
      if (services.some(record => record.price == null)) row.frontier.push({ operation: 'service_pricing',
        reason: 'no public service option amount or price text in observed server-rendered detail pages' });
    }
    if (merchantId === 'woori' && row.operations.form_search && !row.operations.product_search) {
      row.operations.product_search = { state: 'observed_no_records', query: SEARCH_TERMS.woori,
        responseStatus: row.operations.form_search.responseStatus, resultCount: row.operations.form_search.resultRecords };
    } else if (['yes24', 'hmall', 'himart', 'gseshop'].includes(merchantId) && !row.operations.product_search) {
      row.operations.product_search = { state: 'not_observed', reason: 'no_search_form_or_public_search_route_observed' };
      row.frontier.push({ operation: 'product_search', reason: 'no_search_form_or_public_search_route_observed' });
    }
    if (merchantId === 'signgate' && !row.records.some(record => record.type === 'ServiceOffering') && !row.operations.service_catalog) {
      row.operations.service_catalog = { state: 'not_observed', reason: 'homepage_returned_no_visible_service_listing_or_detail_links' };
      row.frontier.push({ operation: 'service_catalog', reason: 'no_visible_service_listing_or_detail_links_observed' });
    }
    if (row.status === 'blocked' && !row.operations.product_search) {
      row.operations.product_search = { state: 'not_attempted', reason: 'homepage_access_blocked' };
      row.frontier.push({ operation: 'product_search', reason: 'homepage_access_blocked' });
    }
    if (merchantId === 'auction') row.operations.reviews_photo = { state: 'manual_url_only', reason: 'exact_public_product_url_not_observed', sampleAvailable: false };
    if (['hmall', 'nsseshop'].includes(merchantId) && !homepageBlocked && !row.receipts.some(receipt => [401, 403, 418, 429].includes(receipt.responseStatus))) {
      const supplement = merchantId === 'hmall' ? await collectHmallReviewSamples() : await collectNsmallPhotoReviewFrontier();
      const seenReceiptIds = new Set(row.receipts.map(receipt => receipt.id ?? receipt.receiptId));
      row.receipts.push(...supplement.receipts.filter(receipt => !seenReceiptIds.has(receipt.id ?? receipt.receiptId)));
      row.records.push(...supplement.records);
      row.contracts.push(...supplement.contracts);
      row.frontier.push(...supplement.frontier);
      row.operations = { ...row.operations, ...supplement.operations };
    }
    row.operations.rating_summary ??= { state: row.records.some(record => record.rating) ? 'aggregate_observed' : 'not_observed' };
    row.operations.review_samples ??= { state: row.records.some(record => record.reviewSamples?.length) ? 'partial_samples_observed' : 'not_observed' };
    if (!row.records.some(record => record.rating)) row.frontier.push({ operation: 'rating_summary', reason: 'not_present_in_observed_page_data' });
    if (!row.records.some(record => record.reviewSamples?.length)) row.frontier.push({ operation: 'review_samples', reason: 'no_review_bodies_or_samples_in_observed_page_data' });
  } catch (error) {
    row.status = 'error';
    row.frontier.push({ operation: 'collector', reason: error.code ?? error.message ?? 'UNEXPECTED_ERROR' });
  }
  return row;
}

export async function collectBatch08({ now = () => new Date() } = {}) {
  const checkedAt = now().toISOString();
  const merchants = [];
  for (const merchantId of ASSIGNED) merchants.push(await collectMerchant(merchantId, { now: () => new Date(checkedAt) }));
  return { schemaVersion: 2, batchId: '08', checkedAt, partial: false, refreshedMerchantIds: [...ASSIGNED],
    checkedAtSemantics: 'full_batch_checked_at', anonymousNoCookies: true, browserUsed: false,
    scope: 'Assigned 14 LinkPrice CPS merchants. Public page/search observations retain their per-row and per-receipt timestamps across targeted refreshes. A row does not imply all products or reviews were collected.', merchants };
}

function normalizeSavedBatch08(result) {
  for (const row of result.merchants ?? []) {
    for (const record of row.records ?? []) {
      if (record.rating && ['11st', 'emart', 'cjbrand'].includes(row.merchantId)) record.rating.ratingCount = null;
      for (const evidence of record.evidence ?? []) {
        evidence.fields = (evidence.fields ?? []).filter(field => {
          if (['11st', 'emart', 'cjbrand'].includes(row.merchantId) && ['ratingCount', 'ratingsCount', 'ratingCnt', 'ratingTotalCount'].includes(field)) return false;
          if (field === 'url') return Boolean(record.url);
          if (field === 'sourceLocalId') return record.sourceLocalId != null;
          if (field === 'title') return record.title != null;
          if (field === 'description') return record.description != null;
          if (field === 'brand') return record.brand != null;
          if (field === 'price') return record.price != null;
          if (field === 'rating') return record.rating?.value != null;
          if (field === 'reviewCount') return record.rating?.reviewCount != null;
          return true;
        });
      }
    }
    if (row.merchantId === '11st' || row.merchantId === 'emart') {
      for (const record of row.records ?? []) {
        record.relevance = { query: SEARCH_TERMS[row.merchantId], queryTextInTitle: String(record.title ?? '').includes(SEARCH_TERMS[row.merchantId]) };
      }
    }
    if (row.merchantId === 'cjbrand') {
      for (const record of row.records ?? []) {
        const evidence = record.evidence?.[0];
        const fromVisibleCategoryCard = evidence?.locator?.startsWith('section.product__item--category');
        const receipt = row.receipts?.find(item => (item.receiptId ?? item.id) === evidence?.receiptId);
        const sourceUrl = receipt?.responseUrl ?? receipt?.requestUrl;
        const isCategoryPage = /category-product-list\?ctgrId=0048(?:&|$)/i.test(sourceUrl ?? '');
        record.relevance = sourceUrl ? cjRetrievalContext(sourceUrl, record.title, fromVisibleCategoryCard && isCategoryPage ? 'visible_category_card' : 'embedded_offerings') : {
          query: null, queryApplied: false, retrievalKind: 'unknown_page', topicHint: SEARCH_TERMS.cjbrand,
          topicHintInTitle: String(record.title ?? '').includes(SEARCH_TERMS.cjbrand),
        };
        if (fromVisibleCategoryCard && isCategoryPage && evidence) {
          evidence.fields = ['sourceLocalId', 'title', 'price', ...(record.url ? ['url'] : []),
            ...(record.description ? ['description'] : []), ...(record.brand ? ['brand'] : []),
            ...(record.rating?.value != null ? ['rating'] : []), ...(record.rating?.reviewCount != null ? ['reviewCount'] : [])];
        }
      }
      row.operations.product_search = { state: 'not_observed', reason: 'only_broad_category_listing_observed',
        query: SEARCH_TERMS.cjbrand, queryApplied: false };
      row.frontier ??= [];
      if (!row.frontier.some(item => item.operation === 'product_search' && item.reason === 'no_observed_keyword_search_form_or_endpoint')) {
        row.frontier.push({ operation: 'product_search', reason: 'no_observed_keyword_search_form_or_endpoint' });
      }
    }
    if (row.merchantId === 'woori' && row.operations.form_search && !row.operations.product_search) {
      row.operations.product_search = { state: 'observed_no_records', query: SEARCH_TERMS.woori,
        responseStatus: row.operations.form_search.responseStatus, resultCount: row.operations.form_search.resultRecords };
    } else if (['yes24', 'hmall', 'himart', 'gseshop', 'nsseshop'].includes(row.merchantId) && !row.operations.product_search) {
      row.operations.product_search = { state: 'not_observed', reason: 'no_search_form_or_public_search_route_observed' };
      row.frontier ??= [];
      if (!row.frontier.some(item => item.operation === 'product_search' && item.reason === 'no_search_form_or_public_search_route_observed')) {
        row.frontier.push({ operation: 'product_search', reason: 'no_search_form_or_public_search_route_observed' });
      }
    }
    if (row.merchantId === 'signgate' && !row.records.some(record => record.type === 'ServiceOffering')) {
      row.operations.service_catalog = { state: 'not_observed', reason: 'homepage_returned_no_visible_service_listing_or_detail_links' };
      row.frontier ??= [];
      if (!row.frontier.some(item => item.operation === 'service_catalog' && item.reason === 'no_visible_service_listing_or_detail_links_observed')) {
        row.frontier.push({ operation: 'service_catalog', reason: 'no_visible_service_listing_or_detail_links_observed' });
      }
    }
    if (row.status === 'blocked' && !row.operations.product_search && row.merchantId === 'kbbook') {
      row.operations.product_search = { state: 'not_attempted', reason: 'homepage_access_blocked' };
      row.frontier ??= [];
      if (!row.frontier.some(item => item.operation === 'product_search' && item.reason === 'homepage_access_blocked')) {
        row.frontier.push({ operation: 'product_search', reason: 'homepage_access_blocked' });
      }
    }
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outDir = path.resolve(HERE, '../../references/cps-reverify');
  mkdirSync(outDir, { recursive: true });
  const output = path.join(outDir, 'batch-08.json');
  const selectedMerchant = ASSIGNED.includes(process.argv[2]) ? process.argv[2] : null;
  let result;
  if (process.argv[2] === '--normalize-saved' && existsSync(output)) {
    result = normalizeSavedBatch08(json(output));
  } else if (selectedMerchant && existsSync(output)) {
    result = json(output);
    const fresh = await collectMerchant(selectedMerchant);
    result.checkedAt = fresh.checkedAt;
    result.partial = true;
    result.refreshedMerchantIds = [...new Set([...(result.refreshedMerchantIds ?? []), selectedMerchant])];
    result.checkedAtSemantics = 'batch_last_updated_at';
    result.merchants = result.merchants.map(row => row.merchantId === selectedMerchant ? fresh : row);
  } else {
    result = await collectBatch08();
  }
  const temporaryOutput = `${output}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporaryOutput, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  renameSync(temporaryOutput, output);
  process.stdout.write(`${JSON.stringify({ output, merchants: result.merchants.length,
    statuses: Object.fromEntries([...new Set(result.merchants.map(row => row.status))].map(status => [status, result.merchants.filter(row => row.status === status).length])),
    records: result.merchants.reduce((sum, row) => sum + row.records.length, 0) }, null, 2)}\n`);
}
