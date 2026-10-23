// 토스쇼핑 하루특가·베스트 × 시장가: which Toss items (Open API; displayPrice already includes shipping) are the lowest
// payable price against Danawa, Naver 통합검색 cards and 쇼핑 커넥트 stores (priceVerdict with the Toss item as `self`).
// Usage: node toss-deal-check.mjs [--best=30] [--out=path.json]
// Toss terms: posting on SNS/blog is allowed; this output is not a stored price catalogue or a comparison website.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { searchDanawa, fetchDanawaOffers, matchDanawaResult, danawaQuery, sizeTokens, danawaSession } from './danawa-prices.mjs';
import { naverSearchCards } from './naver-crawler-snapshot.mjs';
import { brandconnectSearch } from './brandconnect-offers.mjs';
import { naverSameProduct, priceVerdict } from './goldbox-market-check.mjs';
import { modelCode } from './naver-deal-check.mjs';
import { isFood } from './food-classifier.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOSS_CLIENT = path.resolve(HERE, '../../../affiliate-api-hub/adapters/toss-openapi.mjs');
const DEFAULT_WATCH_FILE = path.join(HERE, 'toss-watch-items.v1.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));
export const TOSS_LIST_PAGE_SIZE = 30;
export const DEFAULT_TOSS_LIST_PAGES = 3;
export const MAX_TOSS_LIST_PAGES = 3;
export const MAX_TOSS_COMPARISONS = 30;
export const MAX_TOSS_WATCH_ITEMS = 30;
const DEFAULT_FOOD_CATEGORY_ID = 50995;
const TOSS_FEED_SOURCES = new Set(['today_deal', 'category_best_food', 'best_selling']);

const fail = code => { throw Object.assign(new Error(code), { code }); };
const safeCode = error => /^[A-Z0-9_]{1,80}$/.test(String(error?.code ?? '')) ? String(error.code) : 'SOURCE_READ_FAILED';
const positiveSafeInteger = value => Number.isSafeInteger(value) && value > 0;

export function normalizeTacaItemId(value) {
  const raw = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) return null;
  const normalized = raw.replace(/^0+(?=\d)/, '');
  return /^[1-9]\d*$/.test(normalized) ? normalized : null;
}

// Toss categoryIds run root -> leaf; names come from the live /categories tree, read in memory and never stored as a catalogue.
export function tossCategoryIndex(tree) {
  const index = new Map();
  const walk = nodes => {
    for (const node of Array.isArray(nodes) ? nodes : []) {
      if (Number.isSafeInteger(node?.categoryId) && typeof node.displayName === 'string' && node.displayName.trim()) index.set(node.categoryId, node.displayName.trim());
      walk(node?.children);
    }
  };
  walk(Array.isArray(tree) ? tree : tree?.categories);
  return index;
}

export function tossCategoryNames(index, ids) {
  if (!(index instanceof Map) || !Array.isArray(ids)) return [];
  return ids.map(id => index.get(id)).filter(Boolean);
}

function boundedInteger(value, { name, min, max, code }) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) fail(code ?? `TOSS_${name.toUpperCase()}_INVALID`);
  return n;
}

export function parseTossWatchItems(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { fail('TOSS_WATCHLIST_JSON_INVALID'); }
  if (value?.schemaVersion !== 1 || !Array.isArray(value.items) || value.items.length > MAX_TOSS_WATCH_ITEMS) fail('TOSS_WATCHLIST_SCHEMA_INVALID');
  const ids = [];
  for (const item of value.items) {
    const id = normalizeTacaItemId(item?.tacaItemId);
    if (!id) fail('TOSS_WATCHLIST_ITEM_ID_INVALID');
    ids.push(id);
  }
  return [...new Set(ids)];
}

function watchIdsFromArgument(value) {
  if (value === undefined) {
    let raw;
    try { raw = readFileSync(DEFAULT_WATCH_FILE, 'utf8'); }
    catch { fail('TOSS_WATCHLIST_UNAVAILABLE'); }
    return parseTossWatchItems(raw);
  }
  if (!String(value).trim()) return [];
  const ids = String(value).split(',').map(s => normalizeTacaItemId(s));
  if (ids.length > MAX_TOSS_WATCH_ITEMS || ids.some(id => !id)) fail('TOSS_WATCH_ITEMS_INVALID');
  return [...new Set(ids)];
}

function validateFeedCursors(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('TOSS_FEED_CURSORS_INVALID');
  const cursors = {};
  for (const [source, cursor] of Object.entries(value)) {
    if (!TOSS_FEED_SOURCES.has(source)) fail('TOSS_FEED_SOURCE_INVALID');
    if (cursor === null) continue;
    if (typeof cursor !== 'string' || !cursor.trim() || cursor.length > 4096) fail('TOSS_FEED_CURSOR_INVALID');
    cursors[source] = cursor;
  }
  return cursors;
}

function newFeedCoverage() {
  return { available: false, pages: 0, returnedCount: 0, uniqueCount: 0, exhausted: false, remainingUnknown: true,
    continuationUsed: false, hasNext: null, unrankableCount: 0, knownExcludedCount: 0, stopReason: 'NOT_READ', errorCode: null };
}

async function collectListFeed({ list, source, size, maxPages, feedCursor = null, offers, sourceCoverage }) {
  let cursor;
  let nextFeedCursor = null;
  let continuationSkippedMiddle = false;
  let savedCursorPending = typeof feedCursor === 'string';
  const requestedCursors = new Set();
  const coverage = newFeedCoverage();
  sourceCoverage[source] = coverage;
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    if (cursor !== undefined && requestedCursors.has(cursor)) {
      coverage.stopReason = 'REPEATED_CURSOR';
      break;
    }
    if (cursor !== undefined) requestedCursors.add(cursor);
    let page;
    try { page = await list({ size, ...(cursor !== undefined ? { cursor } : {}) }); }
    catch (error) {
      coverage.stopReason = 'READ_ERROR';
      coverage.errorCode = safeCode(error);
      nextFeedCursor = null;
      break;
    }
    coverage.pages += 1;
    if (!Array.isArray(page?.items) || typeof page?.hasNext !== 'boolean') {
      coverage.stopReason = 'MALFORMED_PAGE';
      coverage.errorCode = 'TOSS_LIST_PAGE_SCHEMA_INVALID';
      nextFeedCursor = null;
      break;
    }
    coverage.available = true;
    coverage.hasNext = page.hasNext;
    coverage.returnedCount += page.items.length;
    for (const item of page.items) offers.push({ ...item, source });
    if (!page.hasNext) {
      coverage.exhausted = true;
      coverage.stopReason = 'EXHAUSTED';
      nextFeedCursor = null;
      break;
    }
    if (typeof page.nextCursor !== 'string' || !page.nextCursor.trim() || page.nextCursor.length > 4096) {
      coverage.stopReason = 'HAS_NEXT_WITHOUT_CURSOR';
      coverage.errorCode = typeof page.nextCursor === 'string' && page.nextCursor.length > 4096
        ? 'TOSS_LIST_CURSOR_INVALID' : 'TOSS_LIST_CURSOR_MISSING';
      nextFeedCursor = null;
      break;
    }
    const nextCursor = page.nextCursor;
    if (requestedCursors.has(nextCursor) || nextCursor === cursor) {
      coverage.stopReason = 'REPEATED_CURSOR';
      nextFeedCursor = null;
      break;
    }
    if (pageIndex === maxPages - 1) {
      coverage.stopReason = 'PAGE_CAP';
      nextFeedCursor = nextCursor;
      break;
    }
    if (pageIndex === 0 && savedCursorPending) {
      savedCursorPending = false;
      if (feedCursor !== nextCursor) {
        cursor = feedCursor;
        continuationSkippedMiddle = true;
        coverage.continuationUsed = true;
      } else cursor = nextCursor;
    } else cursor = nextCursor;
  }
  coverage.remainingUnknown = !coverage.exhausted || continuationSkippedMiddle;
  coverage.items = coverage.returnedCount;
  coverage.error = coverage.errorCode;
  return { coverage, nextFeedCursor };
}

/**
 * Read the bounded Toss candidate lists plus an optional exact-ID watchlist.
 * The OpenAPI terms restrict broad price crawling, so each list stream is capped at three pages and detail is
 * queried only for explicit watched IDs; fresh detail replaces a possibly stale listing row.
 */
export async function collectTossItems({ api, foodOnly = false, pages = DEFAULT_TOSS_LIST_PAGES, best = 30, watchedTacaItemIds = [],
  feedCursors = {}, now = () => new Date() } = {}) {
  if (!api || typeof api.todayDeals !== 'function' || typeof api.categoryBest !== 'function' || typeof api.bestSelling !== 'function' || typeof api.detail !== 'function') fail('TOSS_API_REQUIRED');
  const pageLimit = boundedInteger(pages, { name: 'list_pages', min: 1, max: MAX_TOSS_LIST_PAGES, code: 'TOSS_LIST_PAGE_CAP_INVALID' });
  const bestSize = boundedInteger(best, { name: 'best_size', min: 1, max: TOSS_LIST_PAGE_SIZE, code: 'TOSS_BEST_SIZE_INVALID' });
  const savedFeedCursors = validateFeedCursors(feedCursors);
  if (!Array.isArray(watchedTacaItemIds) || watchedTacaItemIds.length > MAX_TOSS_WATCH_ITEMS) fail('TOSS_WATCH_ITEMS_INVALID');
  const watchIds = watchedTacaItemIds.map(normalizeTacaItemId);
  if (watchIds.some(id => !id)) fail('TOSS_WATCH_ITEMS_INVALID');
  const uniqueWatchIds = [...new Set(watchIds)];
  const rawOffers = [];
  const sources = {};
  const listSize = TOSS_LIST_PAGE_SIZE;
  const nextFeedCursors = {};

  const todayResult = await collectListFeed({ list: args => api.todayDeals(args), source: 'today_deal', size: listSize,
    maxPages: pageLimit, feedCursor: savedFeedCursors.today_deal ?? null, offers: rawOffers, sourceCoverage: sources });
  nextFeedCursors.today_deal = todayResult.nextFeedCursor;
  const categorySource = foodOnly ? 'category_best_food' : 'best_selling';
  const categoryResult = await collectListFeed({
    list: args => foodOnly ? api.categoryBest(DEFAULT_FOOD_CATEGORY_ID, args) : api.bestSelling(args),
    source: categorySource, size: bestSize, maxPages: pageLimit, feedCursor: savedFeedCursors[categorySource] ?? null,
    offers: rawOffers, sourceCoverage: sources,
  });
  nextFeedCursors[categorySource] = categoryResult.nextFeedCursor;

  const excluded = [];
  const byId = new Map();
  let duplicateCount = 0;
  for (const item of rawOffers) {
    const id = normalizeTacaItemId(item?.tacaItemId);
    if (!id) {
      excluded.push({ source: item?.source ?? null, title: typeof item?.title === 'string' ? item.title : null, tacaItemId: null, reason: 'INVALID_TACA_ITEM_ID' });
      if (sources[item?.source]) sources[item.source].unrankableCount += 1;
      continue;
    }
    if (byId.has(id)) { duplicateCount += 1; continue; }
    byId.set(id, { ...item, tacaItemId: id });
  }

  const watchAlreadyListed = uniqueWatchIds.filter(id => byId.has(id)).length;
  const listedUniqueCount = byId.size;
  const listedUniqueBySource = Object.fromEntries(Object.keys(sources).map(source => [source,
    [...byId.values()].filter(item => item.source === source).length]));
  const watchIdsForDetail = uniqueWatchIds;
  const foundWatchIds = new Set();
  const watchCoverage = {
    available: false,
    requestedCount: uniqueWatchIds.length,
    alreadyListedCount: watchAlreadyListed,
    detailBatches: 0,
    detailReturnedCount: 0,
    foundCount: 0,
    notFoundCount: 0,
    notFoundIds: [],
    unknownCount: 0,
    exhausted: uniqueWatchIds.length === 0,
    remainingUnknown: false,
    errorCode: null,
  };
  sources.watched_detail = watchCoverage;
  for (let start = 0; start < watchIdsForDetail.length; start += MAX_TOSS_WATCH_ITEMS) {
    const batch = watchIdsForDetail.slice(start, start + MAX_TOSS_WATCH_ITEMS);
    let detail;
    try { detail = await api.detail(batch); }
    catch (error) {
      watchCoverage.errorCode = safeCode(error);
      watchCoverage.remainingUnknown = true;
      watchCoverage.exhausted = false;
      watchCoverage.unknownCount += batch.length;
      for (const id of batch) {
        const stale = byId.get(id);
        byId.delete(id);
        excluded.push({ source: stale?.source ?? 'watched_detail', title: stale?.title ?? null, tacaItemId: id, reason: 'WATCH_DETAIL_UNVERIFIED' });
      }
      continue;
    }
    watchCoverage.available = true;
    watchCoverage.detailBatches += 1;
    if (!Array.isArray(detail?.items) || !Array.isArray(detail?.notFoundIds)) {
      watchCoverage.errorCode = 'TOSS_DETAIL_SCHEMA_INVALID';
      watchCoverage.remainingUnknown = true;
      watchCoverage.exhausted = false;
      watchCoverage.unknownCount += batch.length;
      for (const id of batch) {
        const stale = byId.get(id);
        byId.delete(id);
        excluded.push({ source: stale?.source ?? 'watched_detail', title: stale?.title ?? null, tacaItemId: id, reason: 'WATCH_DETAIL_UNVERIFIED' });
      }
      continue;
    }
    watchCoverage.detailReturnedCount += detail.items.length;
    const requested = new Set(batch);
    const returnedIds = new Set();
    for (const item of detail.items) {
      const id = normalizeTacaItemId(item?.tacaItemId);
      if (!id || !requested.has(id)) {
        excluded.push({ source: 'watched_detail', title: typeof item?.title === 'string' ? item.title : null, tacaItemId: id, reason: 'DETAIL_ITEM_NOT_REQUESTED' });
        continue;
      }
      returnedIds.add(id);
      foundWatchIds.add(id);
      const listed = byId.get(id);
      byId.set(id, { ...item, tacaItemId: id, source: 'watched_detail', ...(listed ? { listedSource: listed.source ?? null } : {}) });
    }
    const notFound = new Set(detail.notFoundIds.map(normalizeTacaItemId).filter(Boolean));
    for (const id of batch) {
      if (returnedIds.has(id)) continue;
      if (notFound.has(id)) {
        const stale = byId.get(id);
        byId.delete(id);
        excluded.push({ source: stale?.source ?? 'watched_detail', title: stale?.title ?? null, tacaItemId: id, reason: 'WATCH_DETAIL_NOT_FOUND' });
        watchCoverage.notFoundIds.push(id);
        watchCoverage.notFoundCount += 1;
      } else {
        watchCoverage.errorCode ??= 'TOSS_DETAIL_RESULT_INCOMPLETE';
        watchCoverage.remainingUnknown = true;
        watchCoverage.exhausted = false;
        watchCoverage.unknownCount += 1;
        const stale = byId.get(id);
        byId.delete(id);
        excluded.push({ source: stale?.source ?? 'watched_detail', title: stale?.title ?? null, tacaItemId: id, reason: 'WATCH_DETAIL_UNVERIFIED' });
      }
    }
  }
  watchCoverage.foundCount = foundWatchIds.size;
  watchCoverage.exhausted = watchCoverage.unknownCount === 0;
  watchCoverage.pages = watchCoverage.detailBatches;
  watchCoverage.items = watchCoverage.detailReturnedCount;
  watchCoverage.error = watchCoverage.errorCode;

  const offers = [];
  const unrankableReasons = new Set(['stock_unverified', 'INVALID_PRICE', 'INVALID_TITLE']);
  const knownExcludedReasons = new Set(['SOLD_OUT', 'NOT_FOOD']);
  let unrankableCount = excluded.filter(row => row.reason === 'INVALID_TACA_ITEM_ID').length;
  let knownExcludedCount = 0;
  for (const item of byId.values()) {
    const title = typeof item.title === 'string' ? item.title : null;
    const reason = item.soldOut === true ? 'SOLD_OUT'
      : item.soldOut !== false ? 'stock_unverified'
        : !positiveSafeInteger(item.price) ? 'INVALID_PRICE'
          : !title?.trim() ? 'INVALID_TITLE'
            : foodOnly && !isFood(title) ? 'NOT_FOOD' : null;
    if (reason) {
      excluded.push({ source: item.source ?? null, tacaItemId: item.tacaItemId, tacaId: item.tacaId ?? null, title,
        price: item.price ?? null, originalPrice: item.originalPrice ?? null, soldOut: item.soldOut,
        productUrl: item.productUrl ?? null, image: item.image ?? null, priceIncludesShipping: item.priceIncludesShipping === true,
        ...(item.listedSource ? { listedSource: item.listedSource } : {}), reason });
      if (unrankableReasons.has(reason)) {
        unrankableCount += 1;
        if (sources[item.source]) sources[item.source].unrankableCount += 1;
      } else if (knownExcludedReasons.has(reason)) {
        knownExcludedCount += 1;
        if (sources[item.source]) sources[item.source].knownExcludedCount += 1;
      }
      continue;
    }
    offers.push(item);
  }
  const listSources = Object.entries(sources).filter(([name]) => name !== 'watched_detail').map(([, source]) => source);
  for (const [sourceName, source] of Object.entries(sources)) {
    source.uniqueCount = sourceName === 'watched_detail' ? watchCoverage.foundCount : (listedUniqueBySource[sourceName] ?? 0);
    source.rows = source.uniqueCount;
    source.items ??= source.returnedCount ?? source.detailReturnedCount ?? 0;
    source.error ??= source.errorCode ?? null;
  }
  const exhausted = listSources.length > 0 && listSources.every(source => source.exhausted) && watchCoverage.exhausted;
  const incompleteListStreams = listSources.filter(source => source.remainingUnknown).length;
  const remainingUnknown = incompleteListStreams + watchCoverage.unknownCount + unrankableCount;
  const available = Object.values(sources).some(source => source.available);
  const checkedAt = now().toISOString();
  const coverage = {
    checkedAt,
    available,
    exhausted,
    complete: available && exhausted && !remainingUnknown,
    collectionComplete: available && exhausted && !remainingUnknown,
    collectionPartial: !available || !exhausted || remainingUnknown,
    remainingUnknown,
    hasRemainingUnknown: remainingUnknown > 0,
    pages: listSources.reduce((n, source) => n + source.pages, 0),
    pageLimit,
    pageSize: listSize,
    sources,
    counts: {
      rawReturned: rawOffers.length,
      uniqueListed: listedUniqueCount,
      watchedRequested: uniqueWatchIds.length,
      watchedFound: watchCoverage.foundCount,
      duplicateIds: duplicateCount,
      excludedByCollection: excluded.length,
      unrankable: unrankableCount,
      knownExcluded: knownExcludedCount,
      offers: offers.length,
    },
  };
  return { offers, items: offers, excluded, coverage, nextFeedCursors };
}

export function selectTossComparisonBatch(offers, { watchedTacaItemIds = [], limit = MAX_TOSS_COMPARISONS, offset = 0 } = {}) {
  if (!Array.isArray(offers)) fail('TOSS_COMPARISON_OFFERS_INVALID');
  const boundedLimit = boundedInteger(limit, { name: 'comparison_limit', min: 1, max: MAX_TOSS_COMPARISONS, code: 'TOSS_COMPARISON_LIMIT_INVALID' });
  const startOffset = boundedInteger(offset, { name: 'comparison_offset', min: 0, max: Number.MAX_SAFE_INTEGER, code: 'TOSS_COMPARISON_OFFSET_INVALID' });
  if (!Array.isArray(watchedTacaItemIds) || watchedTacaItemIds.length > MAX_TOSS_WATCH_ITEMS) fail('TOSS_WATCH_ITEMS_INVALID');
  const normalizedWatchIds = watchedTacaItemIds.map(normalizeTacaItemId);
  if (normalizedWatchIds.some(id => !id)) fail('TOSS_WATCH_ITEMS_INVALID');
  const watched = new Set(normalizedWatchIds);
  const eligible = offers.filter(item => item?.soldOut === false && positiveSafeInteger(item?.price) && typeof item?.title === 'string' && item.title.trim());
  const watchedItems = eligible.filter(item => watched.has(normalizeTacaItemId(item.tacaItemId)));
  const remaining = eligible.filter(item => !watched.has(normalizeTacaItemId(item.tacaItemId)));
  const normalizedOffset = remaining.length ? startOffset % remaining.length : 0;
  const rotated = remaining.length ? [...remaining.slice(normalizedOffset), ...remaining.slice(0, normalizedOffset)] : [];
  const prioritized = watchedItems.slice(0, boundedLimit);
  const selected = [...prioritized, ...rotated.slice(0, Math.max(0, boundedLimit - prioritized.length))];
  const selectedRegularCount = Math.max(0, selected.length - prioritized.length);
  const nextOffset = remaining.length ? (normalizedOffset + selectedRegularCount) % remaining.length : 0;
  return {
    offers: selected,
    coverage: {
      attemptedCount: selected.length,
      remainingUnknown: selected.length < eligible.length,
      nextOffset,
      offset: normalizedOffset,
      limit: boundedLimit,
      totalEligible: eligible.length,
      watchedSelected: prioritized.length,
      regularSelected: selectedRegularCount,
    },
  };
}

// Toss's own delivery fee for the item: the fee read from the product (hub note → shippingFeeKrw, a free-shipping threshold
// already applied), else 0 when the listed price already includes shipping (Open API displayPrice), else unknown (null).
export function tossShippingFee(item) {
  if (Number.isSafeInteger(item?.shippingFeeKrw) && item.shippingFeeKrw >= 0) return item.shippingFeeKrw;
  return item?.priceIncludesShipping === true ? 0 : null;
}

export async function checkTossDeals(items, { naverCards = null, connectSearch = null, fetchImpl = danawaSession(), delayMs = 800, categoryIndex = null } = {}) {
  const rows = [];
  let danawaBlocked = false;
  for (const item of items ?? []) {
    const base = { source: item.source ?? null, tacaItemId: normalizeTacaItemId(item.tacaItemId), title: typeof item.title === 'string' ? item.title : null,
      price: item.price, originalPrice: item.originalPrice ?? null, productUrl: item.productUrl ?? null, image: item.image ?? null,
      priceIncludesShipping: item.priceIncludesShipping === true, shippingFeeKrw: tossShippingFee(item),
      // Product facts straight from the Toss card, used by the post copy to say what the item is and how it is rated.
      rating: typeof item.rating === 'number' ? item.rating : null, reviewCount: Number.isSafeInteger(item.reviewCount) ? item.reviewCount : null,
      discountRate: typeof item.discountRate === 'number' ? item.discountRate : null,
      categoryIds: Array.isArray(item.categoryIds) ? item.categoryIds : [], categoryNames: tossCategoryNames(categoryIndex, item.categoryIds) };
    const exclusionReason = item.soldOut === true ? 'SOLD_OUT'
      : item.soldOut !== false ? 'stock_unverified'
        : !positiveSafeInteger(item.price) ? 'INVALID_PRICE'
        : !base.title?.trim() ? 'INVALID_TITLE' : null;
    if (exclusionReason) {
      rows.push({ ...base, route: 'excluded', exclusionReason, verdict: null, comparisonComplete: false });
      continue;
    }
    const query = danawaQuery(item.title) || item.title.slice(0, 40);
    let danawaOffers = [], danawa = null;
    const sourceCoverage = { danawa: danawaBlocked ? 'skipped_after_block' : 'pending', naver: naverCards ? 'pending' : 'not_configured', connect: connectSearch ? 'pending' : 'not_configured' };
    const sourceErrors = {};
    if (danawaBlocked) sourceCoverage.danawa = 'skipped_after_block';
    else {
      try {
        const model = modelCode(item.title);
        const search = await searchDanawa(model ?? query, { fetchImpl });
        const sizes = sizeTokens(item.title);
        const byModel = model ? search.results.filter(x => x.name.toUpperCase().includes(model)) : [];
        const match = model ? (byModel.find(x => sizes.length && sizes.every(s => sizeTokens(x.name).includes(s))) ?? (byModel.length === 1 ? byModel[0] : null))
          : matchDanawaResult(item.title, search.results);
        if (match) { await sleep(delayMs); const o = await fetchDanawaOffers(match.pcode, { fetchImpl }); danawaOffers = o.offers; danawa = { pcode: o.pcode, name: o.name }; }
        sourceCoverage.danawa = 'complete';
      } catch (error) {
        if (error.code === 'ACCESS_BLOCKED') {
          danawaBlocked = true;
          sourceCoverage.danawa = 'blocked';
          sourceErrors.danawa = 'ACCESS_BLOCKED';
        } else {
          sourceCoverage.danawa = 'error';
          sourceErrors.danawa = safeCode(error);
        }
      }
    }
    let naverSame = [], connectSame = [];
    if (naverCards) {
      try { naverSame = naverSameProduct(item.title, await naverCards(query)); sourceCoverage.naver = 'complete'; }
      catch (error) { sourceCoverage.naver = 'error'; sourceErrors.naver = safeCode(error); }
    }
    if (connectSearch) {
      try { connectSame = naverSameProduct(item.title, await connectSearch(query)).slice(0, 3); sourceCoverage.connect = 'complete'; }
      catch (error) { sourceCoverage.connect = 'error'; sourceErrors.connect = safeCode(error); }
    }
    const verdict = priceVerdict({ title: item.title, salePrice: item.price, danawaOffers, naverSame, connectSame, excludeMall: '토스',
      self: { channel: 'toss', seller: '토스쇼핑', shipping: tossShippingFee(item),
        priceIncludesShipping: item.priceIncludesShipping, affiliate: 'toss_sharelink',
        productId: String(item.tacaItemId), productUrl: item.productUrl, image: item.image ?? null } });
    // Same guard as the Goldbox rows: without Danawa, a >35% lead is usually a different pack on a Naver card.
    const runnerUp = verdict.offers.find(o => o.payable > verdict.offers[0].payable);
    const route = !danawa && verdict.route === 'toss_sharelink' && runnerUp && runnerUp.payable > verdict.offers[0].payable * 1.35 ? 'naver_only_gap_check' : verdict.route;
    const comparisonComplete = sourceCoverage.danawa === 'complete'
      && (!naverCards || sourceCoverage.naver === 'complete')
      && (!connectSearch || sourceCoverage.connect === 'complete');
    rows.push({ ...base, danawa, route, verdict, sourceCoverage, sourceErrors, comparisonComplete });
    await sleep(delayMs);
  }
  return rows;
}

export function summarizeTossComparison(rows) {
  const compared = (rows ?? []).filter(row => row.verdict);
  const sourceCount = key => compared.reduce((counts, row) => {
    const status = row.sourceCoverage?.[key] ?? 'unknown';
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, {});
  return {
    attemptedCount: compared.length,
    complete: compared.length > 0 && compared.every(row => row.comparisonComplete === true),
    incompleteCount: compared.filter(row => row.comparisonComplete !== true).length,
    sources: { danawa: sourceCount('danawa'), naver: sourceCount('naver'), connect: sourceCount('connect') },
  };
}

async function main() {
  const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  const { createTossOpenApi } = await import(pathToFileURL(TOSS_CLIENT).href);
  const api = createTossOpenApi();
  const food = process.argv.includes('--food');
  const pages = boundedInteger(arg('pages') ?? DEFAULT_TOSS_LIST_PAGES, { name: 'list_pages', min: 1, max: MAX_TOSS_LIST_PAGES, code: 'TOSS_LIST_PAGE_CAP_INVALID' });
  const best = boundedInteger(arg('best') ?? 30, { name: 'best_size', min: 1, max: TOSS_LIST_PAGE_SIZE, code: 'TOSS_BEST_SIZE_INVALID' });
  const compareLimit = boundedInteger(arg('compare-limit') ?? MAX_TOSS_COMPARISONS, { name: 'comparison_limit', min: 1, max: MAX_TOSS_COMPARISONS, code: 'TOSS_COMPARISON_LIMIT_INVALID' });
  const compareOffset = boundedInteger(arg('comparison-offset') ?? 0, { name: 'comparison_offset', min: 0, max: Number.MAX_SAFE_INTEGER, code: 'TOSS_COMPARISON_OFFSET_INVALID' });
  const watchedTacaItemIds = watchIdsFromArgument(arg('watch-items'));
  const { collectTossItemsWithCheckpoint } = await import('./toss-collection-state.mjs');
  const collected = await collectTossItemsWithCheckpoint({ api, foodOnly: food, pages, best, watchedTacaItemIds });
  const eligibleForComparison = collected.offers.filter(item => item.soldOut === false && positiveSafeInteger(item.price) && typeof item.title === 'string' && item.title.trim());
  const batch = selectTossComparisonBatch(collected.offers, { watchedTacaItemIds, limit: compareLimit, offset: compareOffset });
  const excludedRows = collected.excluded.map(({ reason, ...row }) => ({ ...row, route: 'excluded', exclusionReason: reason, verdict: null, comparisonComplete: false }));
  let categoryIndex = null;
  try { categoryIndex = tossCategoryIndex(await api.categories()); } catch { /* names are optional; the copy just omits the category */ }
  const comparedRows = await checkTossDeals(batch.offers, { naverCards: naverSearchCards(), connectSearch: brandconnectSearch(), categoryIndex });
  const rows = [...excludedRows, ...comparedRows];
  const checkedAt = new Date().toISOString();
  const summary = summarizeTossComparison(rows);
  const comparisonUnknown = batch.coverage.remainingUnknown || summary.incompleteCount > 0;
  const comparison = { ...summary, ...batch.coverage, remainingUnknown: comparisonUnknown,
    complete: (batch.coverage.totalEligible === 0 && summary.attemptedCount === 0) || (summary.complete && !batch.coverage.remainingUnknown) };
  const excluded = collected.excluded;
  const exclusionCounts = excluded.reduce((counts, entry) => { counts[entry.reason] = (counts[entry.reason] ?? 0) + 1; return counts; }, {});
  const combinedRemainingUnknown = collected.coverage.remainingUnknown + (comparisonUnknown ? 1 : 0);
  const coverage = { ...collected.coverage, collectionComplete: collected.coverage.complete, comparison, comparisonComplete: comparison.complete,
    collectionPartial: !collected.coverage.complete, remainingUnknown: combinedRemainingUnknown, hasRemainingUnknown: combinedRemainingUnknown > 0,
    complete: collected.coverage.complete && comparison.complete,
    counts: { ...collected.coverage.counts, eligibleForComparison: eligibleForComparison.length, attemptedComparisons: comparison.attemptedCount,
      excluded: excluded.length, excludedByReason: exclusionCounts } };
  const output = { checkedAt, rows, excluded, coverage, checkpoint: collected.checkpoint };
  if (arg('out')) writeFileSync(arg('out'), JSON.stringify(output, null, 2));
  for (const r of rows.filter(x => x.verdict)) {
    const next = r.verdict.offers.find(o => o.payable > r.verdict.offers[0].payable);
    console.log([r.route.padEnd(22), `src ${r.verdict.sources}`, `${r.price}원`, `next ${next?.seller ?? '-'} ${next?.payable ?? ''}`,
      `Danawa ${r.sourceCoverage.danawa}`, `Naver ${r.sourceCoverage.naver}`, `Connect ${r.sourceCoverage.connect}`, r.title.slice(0, 36)].join(' | '));
  }
  console.log(JSON.stringify({ checkedAt, coverage: { available: coverage.available, complete: coverage.complete, collectionPartial: coverage.collectionPartial,
    remainingUnknown: coverage.remainingUnknown, pages: coverage.pages, sources: coverage.sources, counts: coverage.counts,
    comparison: coverage.comparison }, routes: rows.reduce((a, x) => ({ ...a, [x.route]: (a[x.route] ?? 0) + 1 }), {}) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.code ?? error.message); process.exitCode = 1; });
