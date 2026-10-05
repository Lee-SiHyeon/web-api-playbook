import { createHash } from 'node:crypto';
import { parseHTML } from 'linkedom';
import { createOliveyoungHttpFetch } from './oliveyoung-http-transport.mjs';

const ORIGIN = 'https://www.oliveyoung.co.kr';
const PATH = '/store/main/getBestList.do';
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024;
const MAX_RANK = 100;
const CATEGORY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const GOODS_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class OliveyoungKoreaRankingError extends Error {
  constructor(code, receipt = {}) {
    super(code);
    this.name = 'OliveyoungKoreaRankingError';
    this.code = code;
    this.receipt = receipt;
  }
}

const fail = (code, receipt = {}) => { throw new OliveyoungKoreaRankingError(code, receipt); };
const cleanText = (value, max = 2000) => typeof value === 'string' && value.length <= max &&
  !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) ? value.replace(/\s+/g, ' ').trim() : '';

function timestamp(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail('OLIVEYOUNG_RANKING_OPTIONS_INVALID');
  return date.toISOString();
}

function hiddenInput(document, name) {
  const input = [...document.querySelectorAll('input')].find(item => item.name === name);
  return input?.value ?? null;
}

function categoryOptions(document) {
  const container = document.querySelector('.best-area .common-menu');
  if (!container) return [];
  const seen = new Set();
  const result = [];
  for (const element of container.querySelectorAll('a,button,[role="tab"],[data-ref-dispCatNo]')) {
    const id = element.getAttribute('data-ref-dispCatNo') ?? element.getAttribute('data-ref-dispcatno');
    const name = cleanText(element.textContent, 100);
    if (!id || !name || !CATEGORY_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    const className = String(element.className ?? '');
    const ariaSelected = element.getAttribute('aria-selected');
    result.push({
      categoryId: id,
      categoryName: name,
      ...(className ? { selected: /\b(?:on|active|selected)\b/.test(className) } :
        ariaSelected ? { selected: ariaSelected === 'true' } : {}),
    });
  }
  return result;
}

function parsePrice(element, sourceField, kind) {
  if (!element) return null;
  const displayText = cleanText(element.textContent, 120);
  const match = displayText.match(/^((?:0|[1-9][0-9]{0,2}(?:,[0-9]{3})+|[1-9][0-9]{0,14}))\s*원(?:\s*(~))?$/);
  if (!match) return null;
  return {
    amount: match[1].replaceAll(',', ''),
    currency: 'KRW',
    minorUnitExponent: 0,
    kind,
    sourceField,
    displayText,
    optionRangeHint: Boolean(match[2]),
  };
}

function safeProductUrl(anchor, productId) {
  let url;
  try { url = new URL(anchor.href, ORIGIN); }
  catch { fail('OLIVEYOUNG_RANKING_PRODUCT_LINK_INVALID'); }
  const goodsNos = url.searchParams.getAll('goodsNo');
  if (url.origin !== ORIGIN || url.pathname !== '/store/goods/getGoodsDetail.do' ||
      url.username || url.password || url.port || url.hash || goodsNos.length !== 1 ||
      goodsNos[0] !== productId) {
    fail('OLIVEYOUNG_RANKING_PRODUCT_LINK_INVALID');
  }
  const clean = new URL('/store/goods/getGoodsDetail.do', ORIGIN);
  clean.searchParams.set('goodsNo', productId);
  const displayCategory = url.searchParams.get('dispCatNo');
  if (displayCategory && CATEGORY_ID.test(displayCategory)) clean.searchParams.set('dispCatNo', displayCategory);
  return clean.href;
}

function parseProducts(document, limit) {
  const active = document.querySelector('.best-area .TabsConts.on') ?? document.querySelector('.best-area');
  if (!active) fail('OLIVEYOUNG_RANKING_CONTAINER_MISSING');
  const markers = [...active.querySelectorAll('.prd_thumb .thumb_flag.best')];
  if (!markers.length) fail('OLIVEYOUNG_RANKING_MARKERS_MISSING');
  const products = [];
  const seenRanks = new Set();
  const seenIds = new Set();
  for (const marker of markers) {
    const rankText = cleanText(marker.textContent, 8);
    if (!/^[0-9]{1,3}$/.test(rankText)) continue;
    const rank = Number(rankText);
    if (!Number.isSafeInteger(rank) || rank < 1 || rank > MAX_RANK || rank > limit) continue;
    if (seenRanks.has(rank)) fail('OLIVEYOUNG_RANKING_DUPLICATE_RANK', { rank });
    const card = marker.closest('li');
    if (!card) fail('OLIVEYOUNG_RANKING_CARD_MISSING', { rank });
    const productIds = [...new Set([...card.querySelectorAll('a[href*="getGoodsDetail.do"]')].flatMap(anchor => {
      try {
        const url = new URL(anchor.href, ORIGIN);
        const ids = url.searchParams.getAll('goodsNo');
        return url.origin === ORIGIN && url.pathname === '/store/goods/getGoodsDetail.do' &&
          ids.length === 1 && GOODS_ID.test(ids[0]) ? [ids[0]] : [];
      } catch { return []; }
    }))];
    if (productIds.length !== 1) fail('OLIVEYOUNG_RANKING_PRODUCT_BINDING_INVALID', { rank });
    const productId = productIds[0];
    if (seenIds.has(productId)) fail('OLIVEYOUNG_RANKING_DUPLICATE_PRODUCT', { rank });
    seenIds.add(productId);

    const info = card.querySelector('.prd_info') ?? card;
    const title = cleanText(info.querySelector('.prd_name .tx_name')?.textContent, 2000);
    const brand = cleanText(info.querySelector('.prd_name .tx_brand')?.textContent, 500);
    const price = parsePrice(info.querySelector('.prd_price .tx_cur'), '.prd_price .tx_cur', 'retail_current');
    const referencePrice = parsePrice(info.querySelector('.prd_price .tx_org'), '.prd_price .tx_org', 'retail_list');
    if (!title || !price) fail('OLIVEYOUNG_RANKING_CARD_SCHEMA_INVALID', { rank });
    const stockText = cleanText(info.querySelector('.prd_flag')?.textContent ?? '', 200);
    const soldOut = /품절/.test(stockText);
    const productAnchor = [...card.querySelectorAll('a[href*="getGoodsDetail.do"]')].find(anchor =>
      cleanText(anchor.textContent, 2000).length > 5) ?? card.querySelector('a[href*="getGoodsDetail.do"]');
    products.push({
      rank,
      productId,
      title,
      ...(brand ? { brand } : {}),
      url: safeProductUrl(productAnchor, productId),
      price,
      ...(referencePrice ? { referencePrice } : {}),
      availability: soldOut ? 'unavailable' : 'unknown',
      priceContext: {
        sourceFormat: 'html_document',
        optionRangeHint: price.optionRangeHint,
        selectedVariantPrice: false,
      },
    });
    seenRanks.add(rank);
  }
  products.sort((a, b) => a.rank - b.rank);
  const expectedRanks = products.map(product => product.rank);
  if (expectedRanks.length < limit || expectedRanks.some((rank, index) => rank !== index + 1)) {
    fail('OLIVEYOUNG_RANKING_TOP_N_INCOMPLETE', { requestedLimit: limit, observedRanks: expectedRanks });
  }
  return { products, renderedRankCount: markers.length };
}

function parseRankingHtml(html, limit) {
  const { document } = parseHTML(html);
  const pageTitle = cleanText(document.querySelector('title')?.textContent, 500);
  if (!pageTitle.includes('랭킹')) fail('OLIVEYOUNG_RANKING_DOCUMENT_INVALID');
  const dispCatNo = hiddenInput(document, 'dispCatNo');
  const fltDispCatNo = hiddenInput(document, 'fltDispCatNo');
  const pageIdx = hiddenInput(document, 'pageIdx');
  const rowsPerPage = hiddenInput(document, 'rowsPerPage');
  if (!dispCatNo || !CATEGORY_ID.test(dispCatNo) || !/^[0-9]{1,6}$/.test(pageIdx ?? '') ||
      !/^[0-9]{1,4}$/.test(rowsPerPage ?? '')) {
    fail('OLIVEYOUNG_RANKING_FORM_STATE_UNVERIFIED');
  }
  return {
    ...parseProducts(document, limit),
    pageTitle,
    formState: { dispCatNo, fltDispCatNo: fltDispCatNo ?? '', pageIdx, rowsPerPage },
    categories: categoryOptions(document),
  };
}

export function createOliveyoungKoreaRankingClient({
  fetchImpl,
  now = () => new Date(),
  timeoutMs = 20_000,
  maxResponseBytes = MAX_RESPONSE_BYTES,
} = {}) {
  if (fetchImpl !== undefined && typeof fetchImpl !== 'function' ||
      typeof now !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 250 ||
      timeoutMs > 120_000 || !Number.isSafeInteger(maxResponseBytes) ||
      maxResponseBytes < 1024 || maxResponseBytes > 8 * 1024 * 1024) {
    fail('OLIVEYOUNG_RANKING_OPTIONS_INVALID');
  }
  let defaultFetch;
  async function getFetch() {
    if (fetchImpl) return fetchImpl;
    if (!defaultFetch) {
      defaultFetch = Promise.resolve(createOliveyoungHttpFetch({ timeoutMs, maxResponseBytes }));
    }
    return defaultFetch;
  }
  async function readPage(url, checkedAt, requestedCategoryId = null) {
    let response;
    try {
      response = await (await getFetch())(url, {
        method: 'GET',
        headers: { accept: 'text/html,application/xhtml+xml' },
        redirect: 'manual',
        credentials: 'omit',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      fail('OLIVEYOUNG_RANKING_TRANSPORT_FAILED', {
        method: 'GET', origin: ORIGIN, path: PATH, browserUsed: false,
        sourceFormat: 'html_document', isXhr: false, executionMode: 'pure_http',
        causeCode: error?.code ?? 'TRANSPORT_ERROR',
      });
    }
    const mime = response.headers?.get?.('content-type')?.split(';')[0]?.trim().toLowerCase() ?? null;
    const baseReceipt = {
      schema: 'http-public-read-v1',
      service: 'oliveyoung-public',
      capabilityId: 'ranking.top_products',
      method: 'GET',
      origin: ORIGIN,
      path: url.pathname,
      queryFields: [...new Set([...url.searchParams.keys()])],
      categoryId: requestedCategoryId,
      httpStatus: response.status,
      mime,
      readOnly: true,
      browserUsed: false,
      sessionUsed: false,
      cookieSent: false,
      sourceFormat: 'html_document',
      isXhr: false,
      executionMode: 'pure_http',
      checkedAt,
    };
    if (response.redirected || [301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      fail('OLIVEYOUNG_RANKING_REDIRECT_REJECTED', baseReceipt);
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => {});
      fail('OLIVEYOUNG_RANKING_HTTP_BLOCKED', baseReceipt);
    }
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => {});
      fail('OLIVEYOUNG_RANKING_HTTP_ERROR', baseReceipt);
    }
    if (!/^text\/html$/i.test(mime ?? '')) {
      await response.body?.cancel().catch(() => {});
      fail('OLIVEYOUNG_RANKING_MIME_INVALID', baseReceipt);
    }
    const reader = response.body?.getReader?.();
    if (!reader) fail('OLIVEYOUNG_RANKING_BODY_UNREADABLE', baseReceipt);
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxResponseBytes) {
          await reader.cancel().catch(() => {});
          fail('OLIVEYOUNG_RANKING_RESPONSE_TOO_LARGE', { ...baseReceipt, responseBytes: total });
        }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    const body = Buffer.concat(chunks, total);
    const receipt = {
      ...baseReceipt,
      responseBytes: body.byteLength,
      responseSha256: createHash('sha256').update(body).digest('hex'),
    };
    return { html: body.toString('utf8'), receipt };
  }

  return Object.freeze({
    async getRanking({ categoryId = null, limit = 10 } = {}) {
      if (categoryId !== null && !CATEGORY_ID.test(categoryId) ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RANK) {
        fail('OLIVEYOUNG_RANKING_INPUT_INVALID');
      }
      const checkedAt = timestamp(now);
      const initialUrl = new URL(PATH, ORIGIN);
      const initial = await readPage(initialUrl, checkedAt);
      const initialPage = parseRankingHtml(initial.html, limit);
      let page = initialPage;
      let finalReceipt = initial.receipt;
      const receipts = [initial.receipt];
      if (categoryId !== null) {
        const category = initialPage.categories.find(item => item.categoryId === categoryId);
        if (!category) fail('OLIVEYOUNG_RANKING_CATEGORY_UNOBSERVED', { requestedCategoryId: categoryId });
        const url = new URL(PATH, ORIGIN);
        url.searchParams.set('dispCatNo', initialPage.formState.dispCatNo);
        url.searchParams.set('fltDispCatNo', categoryId);
        url.searchParams.set('pageIdx', initialPage.formState.pageIdx);
        url.searchParams.set('rowsPerPage', initialPage.formState.rowsPerPage);
        const selected = await readPage(url, checkedAt, categoryId);
        page = parseRankingHtml(selected.html, limit);
        if (page.formState.fltDispCatNo !== categoryId) {
          fail('OLIVEYOUNG_RANKING_CATEGORY_FILTER_NOT_APPLIED', {
            requestedCategoryId: categoryId,
            observedFilteredCategoryId: page.formState.fltDispCatNo || null,
            receipt: selected.receipt,
          });
        }
        finalReceipt = selected.receipt;
        receipts.push(selected.receipt);
      }
      const products = page.products.slice(0, limit);
      const category = categoryId === null ? null :
        page.categories.find(item => item.categoryId === categoryId) ?? null;
      return {
        products,
        topRanksVerified: products.length === limit &&
          products.every((product, index) => product.rank === index + 1),
        categories: page.categories,
        rankingContext: {
          rankingType: 'oliveyoung_best_store',
          rankingLabel: '오늘의 랭킹',
          rankingScope: 'best_store_page',
          categoryId: category?.categoryId ?? null,
          categoryName: category?.categoryName ?? '전체',
          baseCategoryFormId: page.formState.dispCatNo,
          filteredCategoryId: page.formState.fltDispCatNo || null,
          pageIndex: Number(page.formState.pageIdx),
          rowsPerPage: Number(page.formState.rowsPerPage),
          renderedRankCount: page.renderedRankCount,
          requestedLimit: limit,
          sourceAsOf: null,
          sourceFormat: 'html_document',
          isXhr: false,
        },
        checkedAt,
        receipt: finalReceipt,
        receipts,
        executionMode: 'pure_http',
        sourceFormat: 'html_document',
        isXhr: false,
      };
    },
  });
}
