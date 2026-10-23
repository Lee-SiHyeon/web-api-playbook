import { parse } from 'parse5';
import { createHash } from 'node:crypto';

export const promotionUrl = 'https://shopping.naver.com/promotion';
const apiOrigin = 'https://vertical-api.shopping.naver.com';
const layoutPattern = /^I_[a-f0-9]{24}$/;
const v3IdPattern = /^[a-f0-9]{24}$/;
const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
// 2026-10-16: the promotion bundle (chunk 87718-*) moved the V3 routes from /v3/web/v1 to /v3/waffle-maker/v1;
// /v1/waffle-maker/layout/pages/{uid} (the previous fallback) answers 404.
const v3Path = '/v3/waffle-maker/v1/waffle-promotion';
export const requestGapMs = 1500;

export class ShoppingDealError extends Error {
  constructor(code, details = {}) {
    super(code); this.name = 'ShoppingDealError'; this.code = code; this.details = details;
  }
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const child of node.childNodes ?? []) walk(child, visit);
}

function objects(value, visit) {
  if (!value || typeof value !== 'object') return;
  visit(value);
  for (const child of Object.values(value)) objects(child, visit);
}

export function koreanDate(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value))
    throw new ShoppingDealError('DATE_SCHEMA');
  const explicitZone = /(?:Z|[+-]\d{2}:\d{2})$/.test(value);
  const date = new Date(explicitZone ? value : value + '+09:00');
  if (!Number.isFinite(date.getTime())) throw new ShoppingDealError('DATE_SCHEMA');
  return date.toISOString();
}

export function parsePromotionManifest(html) {
  let script;
  walk(parse(html), node => {
    if (node.tagName === 'script' && node.attrs?.some(a => a.name === 'id' && a.value === '__NEXT_DATA__'))
      script = node.childNodes?.map(n => n.value ?? '').join('');
  });
  let props;
  try { props = JSON.parse(script).props.pageProps; }
  catch { throw new ShoppingDealError('MANIFEST_SCHEMA'); }
  if (!props || typeof props !== 'object') throw new ShoppingDealError('MANIFEST_SCHEMA');
  if (Array.isArray(props?.tabList)) {
    const tabs = new Map();
    for (const tab of props.tabList) {
      if (!tab || typeof tab !== 'object') throw new ShoppingDealError('TAB_SCHEMA');
      if (tab.tabType !== 'WAFFLE') continue;
      const tabId = tab.uid ?? tab.id;
      if (!v3IdPattern.test(tabId) || typeof tab.title !== 'string') throw new ShoppingDealError('TAB_SCHEMA');
      if (tab.version !== 'V3') throw new ShoppingDealError('TAB_VERSION_SCHEMA', { tabId, version: tab.version });
      tabs.set(tabId, { tabId, title: tab.title, version: tab.version });
    }
    if (!tabs.size) throw new ShoppingDealError('WAFFLE_TAB_MISSING');
    return { sourceUrl: promotionUrl, timeZone: 'Asia/Seoul', tabs: [...tabs.values()], layouts: [] };
  }
  const waffle = props.waffleData;
  if (!Array.isArray(waffle?.pageLayout?.layers) || !waffle.pageData) throw new ShoppingDealError('MANIFEST_SCHEMA');
  const metadata = new Map();
  objects(waffle.pageData, value => {
    if (typeof value.itemLayoutId === 'string') metadata.set(value.itemLayoutId, value);
  });
  const layouts = new Map();
  for (const layer of waffle.pageLayout.layers) {
    objects(layer, value => {
      if (value.componentType !== 'AUTO_SORT_PRODUCT') return;
      if (!layoutPattern.test(value.layoutId)) throw new ShoppingDealError('LAYOUT_ID_SCHEMA');
      const meta = metadata.get(value.layoutId);
      if (!meta) throw new ShoppingDealError('LAYOUT_METADATA_MISSING');
      layouts.set(value.layoutId, {
        layoutId: value.layoutId, title: layer.meta?.title ?? null,
        startAt: koreanDate(meta.startDate), endAt: koreanDate(meta.endDate),
      });
    });
  }
  if (!layouts.size) throw new ShoppingDealError('AUTO_SORT_LAYOUT_MISSING');
  return { sourceUrl: promotionUrl, timeZone: 'Asia/Seoul', layouts: [...layouts.values()] };
}

async function readResponse(url, { json, fetchImpl, limit = 4 * 1024 * 1024 }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET', redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(20000),
      headers: {
        accept: json ? 'application/json' : 'text/html', 'accept-language': 'ko-KR',
        'user-agent': userAgent, referer: promotionUrl,
      },
    });
  } catch { throw new ShoppingDealError('TRANSPORT'); }
  const contentType = response.headers.get('content-type') ?? '';
  if ([418, 429].includes(response.status)) {
    await response.body?.cancel();
    throw new ShoppingDealError(response.status === 418 ? 'WAF_BLOCKED' : 'RATE_LIMITED', { status: response.status });
  }
  if (response.status !== 200 || !(json ? /\bjson\b/i : /text\/html/i).test(contentType)) {
    await response.body?.cancel();
    throw new ShoppingDealError('HTTP_OR_CONTENT_TYPE', { status: response.status, contentType });
  }
  const chunks = []; let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > limit) throw new ShoppingDealError('RESPONSE_SIZE');
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof ShoppingDealError) throw error;
    throw new ShoppingDealError('TRANSPORT');
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let data = text;
  if (json) {
    try { data = JSON.parse(text); } catch { throw new ShoppingDealError('JSON_SCHEMA'); }
  }
  const target = new URL(url);
  return { data, receipt: { method: 'GET', origin: target.origin, path: target.pathname, url: String(url),
    queryFields: [...target.searchParams.keys()], status: response.status, contentType, bytes,
    sha256: createHash('sha256').update(Buffer.concat(chunks)).digest('hex'), checkedAt: new Date().toISOString() } };
}

function amount(value, required = false) {
  if (value == null && !required) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new ShoppingDealError('PRICE_SCHEMA');
  return value;
}

function publicUrl(value) {
  if (value == null) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) throw Error();
    return url.href;
  } catch { throw new ShoppingDealError('PRODUCT_URL_SCHEMA'); }
}

const SKIPPABLE_PAGE_ERRORS = new Set(['EMPTY_PRODUCT_PAGE', 'EMPTY_CONTINUATION', 'PAGINATION_NO_PROGRESS']);

export function parseDealPage(data, { layoutId, page, checkedAt, window }) {
  if (Array.isArray(data?.products)) {
    const info = data.paginationInfo;
    if (data.paginationInfoType !== 'PAGE' || info?.pageNo !== page || !Number.isInteger(info.pageSize) || info.pageSize < 1 ||
        !Number.isInteger(info.totalCount) || info.totalCount < 0 || typeof info.hasNext !== 'boolean' ||
        (window.dataConditionType && data.dataConditionType !== window.dataConditionType)) throw new ShoppingDealError('PAGE_SCHEMA');
    if (info.hasNext && !data.products.length) throw new ShoppingDealError('EMPTY_CONTINUATION');
    if (!data.products.length && (info.totalCount > 0 || window.totalCount > 0))
      throw new ShoppingDealError('EMPTY_PRODUCT_PAGE', { layoutId, page, totalCount: info.totalCount });
    // V3 cards use channelProductId (the landing URL ID), not productMeta.productNo.
    return parseDealPage({ itemLayoutId: layoutId, page, hasNext: info.hasNext, contents: data.products.map(p => ({
      productId: p.channelProductId, name: p.productMeta?.name,
      salePrice: p.productMeta?.salePrice,
      discountedPrice: p.benefitAdditional?.discountedPrice ?? p.benefitMeta?.dispDiscountedSalePrice,
      discountedRatio: p.benefitAdditional?.discountedRatio ?? p.benefitMeta?.dispDiscountedRatio,
      landingUrl: p.productAdditional?.landingUrl ?? p.productMeta?.productUrl,
      mobileLandingUrl: p.productAdditional?.mobileLandingUrl,
      imageUrl: p.productMeta?.imageUrl,
      deliveryFee: p.deliveryAdditional?.deliveryFee ?? p.deliveryMeta?.baseFee,
      deliveryFeeType: p.deliveryMeta?.deliveryFeeType,
      isDeliveryFree: p.deliveryMeta?.isFreeDelivery,
      minPurchaseQuantity: p.productMeta?.purchaseQuantityInfo?.minPurchaseQuantity,
      saleEndDate: p.productAdditional?.saleEndDate,
      isSoldOut: p.productAdditional?.isSoldOut, isComingSoon: p.productAdditional?.isComingSoon,
    })) }, { layoutId, page, checkedAt, window });
  }
  if (data?.itemLayoutId !== layoutId || data.page !== page || typeof data.hasNext !== 'boolean' || !Array.isArray(data.contents))
    throw new ShoppingDealError('PAGE_SCHEMA');
  if (data.hasNext && !data.contents.length) throw new ShoppingDealError('EMPTY_CONTINUATION');
  return data.contents.map(p => {
    if (!/^\d+$/.test(String(p.productId)) || typeof p.name !== 'string' || !p.name.trim() || typeof p.isSoldOut !== 'boolean')
      throw new ShoppingDealError('PRODUCT_SCHEMA');
    const saleEndAt = koreanDate(p.saleEndDate);
    const endAt = [saleEndAt, window.endAt].filter(Boolean).sort()[0] ?? null;
    const startsLater = window.startAt && Date.parse(window.startAt) > Date.parse(checkedAt);
    const expired = endAt && Date.parse(endAt) < Date.parse(checkedAt);
    return {
      productId: String(p.productId), title: p.name, url: publicUrl(p.landingUrl),
      mobileUrl: publicUrl(p.mobileLandingUrl), imageUrl: publicUrl(p.imageUrl), currency: 'KRW',
      salePrice: amount(p.salePrice, true), discountedPrice: amount(p.discountedPrice),
      displayDiscountPercent: amount(p.discountedRatio), deliveryFee: amount(p.deliveryFee),
      deliveryFeeType: p.deliveryFeeType ?? null, isDeliveryFree: p.isDeliveryFree ?? null,
      minimumQuantity: p.minPurchaseQuantity ?? null,
      status: expired ? 'expired' : p.isSoldOut ? 'sold_out' : startsLater || p.isComingSoon ? 'upcoming' : endAt ? 'listed_active' : 'end_unknown',
      campaignStartAt: window.startAt, campaignEndAt: window.endAt, saleEndAt,
      checkoutPriceVerified: false, checkedAt, sourceUrl: promotionUrl, layoutId,
      ...(window.tabId ? { tabId: window.tabId, tabTitle: window.tabTitle, itemGroupId: window.itemGroupId } : {}),
    };
  });
}

function tabPage(data, tab) {
  if (data?.pageCode !== tab.tabId || data.serviceCode !== 'WAFFLE_PROMOTION' || !Array.isArray(data.layers))
    throw new ShoppingDealError('TAB_PAGE_SCHEMA', { tabId: tab.tabId });
  for (const layer of data.layers) validateLayer(layer);
  return data.layers;
}

function validateLayer(layer) {
  if (!v3IdPattern.test(layer?.layoutId) || !v3IdPattern.test(layer.layerCode) || !Array.isArray(layer.blocks) ||
      !['BOUND', 'DEFERRED', 'PLACEHOLDER'].includes(layer.bindStatus)) throw new ShoppingDealError('LAYER_SCHEMA');
}

function productGroups(layers, tab) {
  const groups = new Map();
  for (const layer of layers) {
    for (const block of layer.blocks) {
      if (!Array.isArray(block.itemGroups)) throw new ShoppingDealError('ITEM_GROUP_SCHEMA');
      for (const group of block.itemGroups) {
        if (group.productElements == null) continue;
        if (!Array.isArray(group.productElements) || !v3IdPattern.test(group.id) || !v3IdPattern.test(block.layoutId))
          throw new ShoppingDealError('ITEM_GROUP_SCHEMA');
        for (const element of group.productElements) {
          const endpoint = new Map([['MANUAL', 'manual-products'], ['RANKING', 'auto-products'], ['AUTO_SORT', 'auto-sort-products']]).get(element.dataConditionType);
          if (!endpoint) throw new ShoppingDealError('PRODUCT_CONDITION_SCHEMA', { itemGroupId: group.id, type: element.dataConditionType });
          const info = element.paginationInfo;
          if (element.paginationInfoType !== 'PAGE' || !Number.isInteger(info?.totalCount) || info.totalCount < 0)
            throw new ShoppingDealError('PAGE_SCHEMA');
          groups.set(group.id, {
            layoutId: block.layoutId, layerLayoutId: layer.layoutId, itemGroupId: group.id,
            tabId: tab.tabId, tabTitle: tab.title, title: layer.meta?.title ?? null,
            startAt: koreanDate(group.exposureCondition?.exposureStartAt),
            endAt: koreanDate(group.exposureCondition?.exposureEndAt),
            dataConditionType: element.dataConditionType, totalCount: info.totalCount,
            pageSize: Number.isInteger(info.pageSize) && info.pageSize > 0 ? Math.min(info.pageSize, 300) : 20,
            endpoint, initialPage: element,
          });
        }
      }
    }
  }
  return [...groups.values()];
}

function apiUrl(path, params) {
  const url = new URL(apiOrigin + path);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url;
}

export async function collectTodayDeals({ maxPages = 30, maxRequests = 100, fetchImpl = globalThis.fetch, now = () => new Date(), gapMs = null } = {}) {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new ShoppingDealError('PAGE_LIMIT_INPUT');
  if (!Number.isInteger(maxRequests) || maxRequests < 2 || maxRequests > 200) throw new ShoppingDealError('REQUEST_LIMIT_INPUT');
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') throw new ShoppingDealError('INPUT');
  // Slow, sequential, no retries: pause between live requests (injected test transports run unpaced).
  const gap = gapMs ?? (fetchImpl === globalThis.fetch ? requestGapMs : 0);
  let requests = 0;
  const read = async (url, options) => {
    if (requests >= maxRequests) throw new ShoppingDealError('REQUEST_LIMIT', { maxRequests });
    if (requests++ && gap) await new Promise(resolve => setTimeout(resolve, gap));
    return readResponse(url, { ...options, fetchImpl });
  };
  const startedAt = now().toISOString();
  const manifestRead = await read(promotionUrl, { json: false });
  const manifest = parsePromotionManifest(manifestRead.data);
  const products = new Map(); const layoutResults = []; const receipts = [manifestRead.receipt];
  const tabResults = []; const layouts = [...manifest.layouts];
  if (manifest.tabs) {
    for (const tab of manifest.tabs) {
      const pageRead = await read(apiUrl(`${v3Path}/pages/${tab.tabId}`, { exposureDevice: 'WEB', serviceCode: 'WAFFLE_PROMOTION' }), { json: true });
      receipts.push(pageRead.receipt);
      const layers = new Map(tabPage(pageRead.data, tab).map(layer => [layer.layoutId, layer]));
      const pending = [...layers.values()].filter(layer => layer.bindStatus !== 'BOUND');
      // The public server rejects more than three layerCodes in a single GET.
      for (let i = 0; i < pending.length; i += 3) {
        const batch = pending.slice(i, i + 3);
        const layerRead = await read(apiUrl(`${v3Path}/pages/${tab.tabId}/layers`, {
          exposureDevice: 'WEB', layerCodes: batch.map(layer => layer.layerCode).join(','), serviceCode: 'WAFFLE_PROMOTION',
        }), { json: true });
        receipts.push(layerRead.receipt);
        if (!Array.isArray(layerRead.data)) throw new ShoppingDealError('LAYERS_SCHEMA');
        const expected = new Set(batch.map(layer => layer.layoutId));
        for (const layer of layerRead.data) {
          validateLayer(layer);
          if (!expected.has(layer.layoutId) || layer.bindStatus !== 'BOUND') throw new ShoppingDealError('LAYERS_SCHEMA');
          layers.set(layer.layoutId, layer);
        }
        // Omitted layers have no currently exposed content (observed on 2026-10-11).
        for (const layer of batch) if (layers.get(layer.layoutId).bindStatus !== 'BOUND') layers.delete(layer.layoutId);
      }
      const groups = productGroups([...layers.values()], tab);
      layouts.push(...groups);
      tabResults.push({ ...tab, layoutCount: groups.length, omittedLayerCount: pageRead.data.layers.length - layers.size });
    }
  }
  let duplicateCount = 0;
  for (const { initialPage, endpoint, ...layout } of layouts) {
    let complete = false; let pages = 0; let returnedItems = 0; let skippedReason = null;
    const seenInLayout = new Set();
    let stopReason = null;
    for (let page = 1; page <= maxPages; page++) {
      let data;
      if (page === 1 && initialPage?.paginationInfo?.pageNo === 1 && Array.isArray(initialPage.products) && initialPage.products.length) {
        data = initialPage;
      } else {
        const url = layout.itemGroupId
          ? apiUrl(`${v3Path}/item-groups/${layout.itemGroupId}/paginated-elements/${endpoint}`, {
            pageNo: page, pageSize: layout.pageSize, ...(layout.dataConditionType === 'AUTO_SORT' ? { sortType: 'VIEW' } : {}),
          })
          : apiUrl(`/v1/waffle-maker/layouts/${layout.layoutId}/auto-sort-products`, { ...(page === 1 ? { first: '' } : {}), page, type: 'VIEW' });
        if (requests >= maxRequests) { stopReason = 'max_requests'; break; }
        const pageRead = await read(url, { json: true });
        receipts.push(pageRead.receipt); data = pageRead.data;
      }
      let items;
      try {
        items = parseDealPage(data, { layoutId: layout.layoutId, page, checkedAt: now().toISOString(), window: layout });
      } catch (error) {
        // One product group answering an empty page (sold through mid-rotation) must not drop every other tab's
        // deals (seen 2026-10-11): stop this group, keep the rest, and say why in its layout result.
        if (!SKIPPABLE_PAGE_ERRORS.has(error?.code)) throw error;
        skippedReason = error.code;
        break;
      }
      pages++; returnedItems += items.length;
      let added = 0;
      for (const item of items) {
        if (!seenInLayout.has(item.productId)) { seenInLayout.add(item.productId); added++; }
        if (products.has(item.productId)) duplicateCount++;
        else products.set(item.productId, item);
      }
      if (!(data.paginationInfo?.hasNext ?? data.hasNext)) { complete = true; break; }
      if (!added) throw new ShoppingDealError('PAGINATION_NO_PROGRESS', { page });
    }
    layoutResults.push({ ...layout, pages, returnedItems, complete, stopReason: skippedReason ?? (complete ? 'hasNext_false' : stopReason ?? 'max_pages') });
  }
  if (!products.size) throw new ShoppingDealError('EMPTY_DEALS', { tabCount: tabResults.length, layoutCount: layouts.length });
  for (const tab of tabResults) {
    const results = layoutResults.filter(layout => layout.tabId === tab.tabId);
    tab.complete = results.every(layout => layout.complete);
    tab.returnedItems = results.reduce((count, layout) => count + layout.returnedItems, 0);
    if (!results.length) tab.stopReason = 'no_exposed_product_groups';
  }
  return {
    schemaVersion: 1, startedAt, finishedAt: now().toISOString(),
    scope: manifest.tabs ? 'promotion_page_WAFFLE_tabs' : 'default_promotion_page_AUTO_SORT_PRODUCT_layouts', sourceUrl: promotionUrl,
    browserUsed: false, credentialsUsed: false, sdkTokenUsed: false,
    state: { captured: true, client_exists: true, remnant_free: true, credential_propagated: 'not_required', live_replay: true },
    complete: layoutResults.every(l => l.complete), layouts: layoutResults, ...(manifest.tabs ? { tabs: tabResults } : {}),
    productCount: products.size, duplicateCount, products: [...products.values()], receipts,
    limitations: ['Ranking/calendar tabs, personalized products and keyword search are outside this collector.', 'Listing prices are not verified checkout prices.', 'No price history or historical-low claim.'],
  };
}
