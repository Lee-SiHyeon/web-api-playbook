import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WATCHLIST = path.join(HERE, 'toss-watch-items.v1.json');
const MAX_TOSS_MARKET_PAGES = 3;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const positiveInteger = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const idText = value => {
  const id = String(value ?? '').trim();
  if (!/^\d{1,20}$/.test(id) || /^0+$/.test(id)) return null;
  return id;
};
const limitedCount = value => Number.isSafeInteger(value) && value >= 0 && value <= 100000 ? value : null;

function titleIdentity(value) {
  const title = String(value ?? '').normalize('NFKC').toLowerCase();
  if (!title.trim()) return null;

  const weights = [...title.matchAll(/(\d+(?:\.\d+)?)\s*(kg|g|ml|l|매|정|캡슐|롤|mm|cm|인치|gb|tb)(?![a-z가-힣])/gi)]
    .map(match => `${Number(match[1])}${match[2].toLowerCase()}`).sort();
  const quantities = [...title.matchAll(/(\d+)\s*(개입|팩|병|캔|봉|포|통|개|입|ea|pcs)(?![가-힣])/gi)]
    .map(match => Number(match[1]));
  if (quantities.length > 1) return null;
  const quantity = quantities[0] ?? 1;

  const core = title
    .replace(/[\[\]()]/g, ' ')
    .replace(/(?:^|[^a-z0-9가-힣])(?:cj제일제당|씨제이제일제당|cj더마켓|씨제이|cj)(?=$|[^a-z0-9가-힣])/gi, ' ')
    .replace(/\d+(?:\.\d+)?\s*(?:kg|g|ml|l|매|정|캡슐|롤|mm|cm|인치|gb|tb)(?![a-z가-힣])/gi, ' ')
    .replace(/\d+\s*(?:개입|팩|병|캔|봉|포|통|개|입|ea|pcs)(?![가-힣])/gi, ' ')
    .replace(/(?:즉석밥|정기세일|무료배송|무료배송|무료|특가|오늘특가|행사|한정|대용량|묶음)/g, ' ')
    .replace(/[\s\p{P}\p{S}]+/gu, '');

  return core ? { core, weights, quantity } : null;
}

function productUrlBinding(value, tacaId) {
  try {
    const url = new URL(String(value ?? ''));
    if (url.protocol !== 'https:' || url.hostname !== 'toss.shopping' || url.port || url.username || url.password
      || url.search || url.hash || !/^\/t\/\d{1,20}$/.test(url.pathname)) return null;
    const productPageId = url.pathname.slice('/t/'.length);
    return { url: url.href, productPageId, binding: 'same_observed_openapi_item' };
  } catch { return null; }
}

/**
 * Accept only an observed Toss item record with a numeric item ID, an item-bound first-party URL,
 * a positive integer display price, an explicit in-stock flag, and a price marked shipping-inclusive.
 */
export function normalizeTossMarketOffer(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const tacaItemId = idText(raw.tacaItemId);
  const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 500) : '';
  const price = positiveInteger(raw.price);
  const page = productUrlBinding(raw.productUrl, tacaItemId);
  if (!tacaItemId || !title || !price || raw.soldOut !== false || raw.priceIncludesShipping !== true || !page) return null;
  const tacaIdValue = raw.tacaId == null || String(raw.tacaId).trim() === '' ? null : raw.tacaId;
  const tacaId = tacaIdValue === null ? null : idText(tacaIdValue);
  if (tacaIdValue !== null && !tacaId) return null;
  if (tacaId && tacaId !== page.productPageId) return null;
  const image = (() => {
    try {
      const url = new URL(String(raw.image ?? ''));
      return url.protocol === 'https:' && url.hostname === 'shopping.toss.im' && !url.username && !url.password ? url.href : null;
    } catch { return null; }
  })();
  const source = ['today_deal', 'category_best_food', 'best_selling', 'watchlist_detail'].includes(raw.source) ? raw.source : 'toss_openapi';
  return {
    channel: 'toss', seller: '토스쇼핑', affiliate: 'toss_sharelink',
    tacaItemId, tacaId, productId: tacaItemId, title, price, payable: price,
    shipping: 0, shippingKnown: true, priceIncludesShipping: true,
    productUrl: page.url, productPageId: page.productPageId, identityBinding: page.binding,
    soldOut: false, image, source,
  };
}

/** Returns only strict same-product Toss offers; titles, weight/volume and pack count must all agree. */
export function matchTossMarketOffers(title, offers = [], { excludeTacaItemIds = [] } = {}) {
  const target = titleIdentity(title);
  if (!target || !Array.isArray(offers)) return [];
  const excluded = new Set(excludeTacaItemIds.map(idText).filter(Boolean));
  const byId = new Map();
  for (const raw of offers) {
    const offer = normalizeTossMarketOffer(raw);
    if (!offer || excluded.has(offer.tacaItemId)) continue;
    const candidate = titleIdentity(offer.title);
    if (!candidate || candidate.core !== target.core || candidate.quantity !== target.quantity
      || candidate.weights.length !== target.weights.length
      || candidate.weights.some((weight, index) => weight !== target.weights[index])) continue;
    const previous = byId.get(offer.tacaItemId);
    if (!previous || offer.price < previous.price) byId.set(offer.tacaItemId, offer);
  }
  return [...byId.values()].sort((a, b) => a.price - b.price || a.tacaItemId.localeCompare(b.tacaItemId));
}

export function normalizeTossMarketCoverage(raw, offerCount = 0) {
  const sourceRows = Array.isArray(raw?.sources) ? raw.sources
    : raw?.sources && typeof raw.sources === 'object'
      ? Object.entries(raw.sources).map(([id, detail]) => ({ id, ...(detail && typeof detail === 'object' ? detail : {}) })) : [];
  const sources = sourceRows.slice(0, 12).map(row => {
    if (typeof row === 'string') return { id: row.slice(0, 80) };
    if (!row || typeof row !== 'object') return null;
    const remaining = row.remainingUnknown;
    const errorCode = /^[A-Z0-9_]{2,80}$/.test(String(row.errorCode ?? row.error ?? ''))
      ? String(row.errorCode ?? row.error) : null;
    return {
      id: String(row.id ?? row.source ?? '').slice(0, 80) || null,
      pages: limitedCount(row.pages),
      items: limitedCount(row.items ?? row.offers),
      returnedCount: limitedCount(row.returnedCount),
      uniqueCount: limitedCount(row.uniqueCount),
      requestedCount: limitedCount(row.requestedCount),
      foundCount: limitedCount(row.foundCount),
      notFoundCount: limitedCount(row.notFoundCount),
      unknownCount: limitedCount(row.unknownCount),
      unrankableCount: limitedCount(row.unrankableCount),
      continuationUsed: row.continuationUsed === true,
      detailBatches: limitedCount(row.detailBatches),
      available: row.available === true,
      exhausted: row.exhausted === true,
      complete: row.complete === true,
      hasNext: typeof row.hasNext === 'boolean' ? row.hasNext : null,
      remainingUnknown: typeof remaining === 'boolean' ? remaining : limitedCount(remaining),
      stopReason: /^[A-Z0-9_]{2,80}$/.test(String(row.stopReason ?? '')) ? String(row.stopReason) : null,
      error: errorCode,
      errorCode,
    };
  }).filter(Boolean);
  const counts = raw?.counts && typeof raw.counts === 'object' ? Object.fromEntries(
    Object.entries(raw.counts).filter(([key, value]) => /^[a-zA-Z0-9_]{1,50}$/.test(key) && limitedCount(value) !== null)
      .slice(0, 20).map(([key, value]) => [key, limitedCount(value)])) : {};
  const checkedAt = typeof raw?.checkedAt === 'string' && Number.isFinite(Date.parse(raw.checkedAt)) ? raw.checkedAt : null;
  const unknown = raw?.remainingUnknown;
  const remainingUnknown = typeof unknown === 'boolean' ? (unknown ? 1 : 0) : limitedCount(unknown);
  const hasRemainingUnknown = typeof raw?.hasRemainingUnknown === 'boolean'
    ? raw.hasRemainingUnknown : (typeof unknown === 'boolean' ? unknown : remainingUnknown > 0);
  const errorCode = /^[A-Z0-9_]{2,80}$/.test(String(raw?.errorCode ?? raw?.error ?? ''))
    ? String(raw?.errorCode ?? raw?.error) : null;
  const unrankableCount = limitedCount(raw?.unrankableCount ?? raw?.counts?.unrankable) ?? 0;
  const incomplete = hasRemainingUnknown || unrankableCount > 0 || Boolean(errorCode)
    || sources.some(row => row.errorCode || (row.unknownCount ?? 0) > 0);
  return {
    configured: true,
    available: raw?.available === true,
    exhausted: raw?.exhausted === true,
    complete: raw?.complete === true && !incomplete,
    collectionComplete: raw?.collectionComplete === true && !incomplete,
    collectionPartial: raw?.collectionPartial === true || incomplete,
    unrankableCount,
    continuationUsed: raw?.continuationUsed === true,
    remainingUnknown,
    hasRemainingUnknown,
    pages: limitedCount(raw?.pages ?? raw?.pagesRead),
    pageLimit: limitedCount(raw?.pageLimit),
    pageSize: limitedCount(raw?.pageSize),
    offerCount,
    sourceCount: sources.length,
    sources,
    counts,
    checkedAt,
    error: errorCode,
    errorCode,
  };
}

function validateWatchedIds(value) {
  if (!Array.isArray(value) || value.length > 30) fail('TOSS_WATCHLIST_INVALID');
  const ids = [];
  const seen = new Set();
  for (const item of value) {
    const id = idText(typeof item === 'object' && item !== null ? item.tacaItemId : item);
    if (!id) fail('TOSS_WATCHLIST_INVALID');
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }
  return ids;
}

async function readWatchedIds() {
  let text;
  try { text = await readFile(WATCHLIST, 'utf8'); }
  catch { fail('TOSS_WATCHLIST_UNAVAILABLE'); }
  let data;
  try { data = JSON.parse(text); }
  catch { fail('TOSS_WATCHLIST_INVALID'); }
  if (data?.schemaVersion !== 1 || !Array.isArray(data.items)) fail('TOSS_WATCHLIST_INVALID');
  return validateWatchedIds(data.items);
}

/**
 * Load one bounded, cached-in-memory Toss snapshot for cross-source checks. The collector owns all pagination;
 * `watchedTacaItemIds` is an explicit override, while omission reads the checked-in public watchlist.
 */
export async function loadTossMarketSnapshot({ foodOnly = true, pages = 3, best = 30, watchedTacaItemIds, api = null,
  useCheckpoint = api === null } = {}) {
  if (typeof foodOnly !== 'boolean' || !Number.isSafeInteger(pages) || pages < 1 || pages > MAX_TOSS_MARKET_PAGES
    || !Number.isSafeInteger(best) || best < 1 || best > 30 || typeof useCheckpoint !== 'boolean') fail('TOSS_MARKET_OPTIONS_INVALID');
  const watched = watchedTacaItemIds === undefined ? await readWatchedIds() : validateWatchedIds(watchedTacaItemIds);
  try {
    if (!api) {
      const clientPath = pathToFileURL(path.resolve(HERE, '../../../affiliate-api-hub/adapters/toss-openapi.mjs')).href;
      const { createTossOpenApi } = await import(clientPath);
      api = createTossOpenApi();
    }
    const { collectTossItems } = await import('./toss-deal-check.mjs');
    if (typeof collectTossItems !== 'function') fail('TOSS_COLLECTOR_UNAVAILABLE');
    const collect = useCheckpoint ? (await import('./toss-collection-state.mjs')).collectTossItemsWithCheckpoint : collectTossItems;
    const result = await collect({ api, foodOnly, pages, best, watchedTacaItemIds: watched });
    const offers = [], rejected = [];
    for (const row of Array.isArray(result?.offers) ? result.offers : []) {
      const offer = normalizeTossMarketOffer(row);
      if (offer) offers.push(offer);
      else rejected.push({ tacaItemId: idText(row?.tacaItemId), title: typeof row?.title === 'string' ? row.title : null,
        reason: 'MARKET_OFFER_UNVERIFIED' });
    }
    const rawCoverage = result?.coverage ?? {};
    const coverage = normalizeTossMarketCoverage(rejected.length ? {
      ...rawCoverage, complete: false, collectionComplete: false, collectionPartial: true,
      unrankableCount: (limitedCount(rawCoverage.unrankableCount ?? rawCoverage.counts?.unrankable) ?? 0) + rejected.length,
      remainingUnknown: (limitedCount(rawCoverage.remainingUnknown) ?? 0) + rejected.length, hasRemainingUnknown: true,
    } : rawCoverage, offers.length);
    if (coverage.available && result?.coverage?.available !== true) coverage.available = false;
    return { offers, excluded: [...(Array.isArray(result?.excluded) ? result.excluded : []), ...rejected], coverage,
      ...(result.checkpoint ? { checkpoint: result.checkpoint } : {}) };
  } catch (error) {
    const code = /^[A-Z0-9_]{2,80}$/.test(String(error?.code ?? '')) ? String(error.code) : 'TOSS_COLLECTION_FAILED';
    return { offers: [], coverage: normalizeTossMarketCoverage({ available: false, error: code }, 0) };
  }
}

export const tossCoverageNeedsVerification = coverage => coverage?.available !== true
  || (limitedCount(coverage?.unrankableCount ?? coverage?.counts?.unrankable) ?? 0) > 0
  || (Array.isArray(coverage?.sources) ? coverage.sources : Object.values(coverage?.sources ?? {}))
    .some(row => row?.errorCode || row?.error || (limitedCount(row?.unknownCount) ?? 0) > 0);
