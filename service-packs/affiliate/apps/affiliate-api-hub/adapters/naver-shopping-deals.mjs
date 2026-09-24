import { parse } from 'parse5';

export const promotionUrl = 'https://shopping.naver.com/promotion';
const apiOrigin = 'https://vertical-api.shopping.naver.com';
const layoutPattern = /^I_[a-f0-9]{24}$/;

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
      method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(20000),
      headers: { accept: json ? 'application/json' : 'text/html', referer: promotionUrl },
    });
  } catch { throw new ShoppingDealError('TRANSPORT'); }
  const contentType = response.headers.get('content-type') ?? '';
  if (response.status !== 200 || !(json ? /\bjson\b/i : /text\/html/i).test(contentType)) {
    await response.body?.cancel();
    throw new ShoppingDealError('HTTP_OR_CONTENT_TYPE', { status: response.status, contentType });
  }
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > limit) throw new ShoppingDealError('RESPONSE_SIZE');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let data = text;
  if (json) {
    try { data = JSON.parse(text); } catch { throw new ShoppingDealError('JSON_SCHEMA'); }
  }
  return { data, receipt: { url: String(url), status: response.status, contentType, bytes } };
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

export function parseDealPage(data, { layoutId, page, checkedAt, window }) {
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
      mobileUrl: publicUrl(p.mobileLandingUrl), currency: 'KRW',
      salePrice: amount(p.salePrice, true), discountedPrice: amount(p.discountedPrice),
      displayDiscountPercent: amount(p.discountedRatio), deliveryFee: amount(p.deliveryFee),
      deliveryFeeType: p.deliveryFeeType ?? null, isDeliveryFree: p.isDeliveryFree ?? null,
      minimumQuantity: p.minPurchaseQuantity ?? null,
      status: expired ? 'expired' : p.isSoldOut ? 'sold_out' : startsLater || p.isComingSoon ? 'upcoming' : endAt ? 'listed_active' : 'end_unknown',
      campaignStartAt: window.startAt, campaignEndAt: window.endAt, saleEndAt,
      checkoutPriceVerified: false, checkedAt, sourceUrl: promotionUrl, layoutId,
    };
  });
}

export async function collectTodayDeals({ maxPages = 30, fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new ShoppingDealError('PAGE_LIMIT_INPUT');
  const startedAt = now().toISOString();
  const manifestRead = await readResponse(promotionUrl, { json: false, fetchImpl });
  const manifest = parsePromotionManifest(manifestRead.data);
  const products = new Map(); const layoutResults = []; const receipts = [manifestRead.receipt];
  let duplicateCount = 0;
  for (const layout of manifest.layouts) {
    let complete = false; let pages = 0; let returnedItems = 0;
    for (let page = 1; page <= maxPages; page++) {
      const url = new URL(`${apiOrigin}/v1/waffle-maker/layouts/${layout.layoutId}/auto-sort-products`);
      if (page === 1) url.searchParams.set('first', '');
      url.searchParams.set('page', String(page)); url.searchParams.set('type', 'VIEW');
      const read = await readResponse(url, { json: true, fetchImpl });
      const items = parseDealPage(read.data, { layoutId: layout.layoutId, page, checkedAt: now().toISOString(), window: layout });
      receipts.push(read.receipt); pages++; returnedItems += items.length;
      let added = 0;
      for (const item of items) {
        if (products.has(item.productId)) duplicateCount++;
        else added++;
        products.set(item.productId, item);
      }
      if (!read.data.hasNext) { complete = true; break; }
      if (!added) throw new ShoppingDealError('PAGINATION_NO_PROGRESS', { page });
    }
    layoutResults.push({ ...layout, pages, returnedItems, complete, stopReason: complete ? 'hasNext_false' : 'max_pages' });
  }
  return {
    schemaVersion: 1, startedAt, finishedAt: now().toISOString(),
    scope: 'default_promotion_page_AUTO_SORT_PRODUCT_layouts', sourceUrl: promotionUrl,
    browserUsed: false, credentialsUsed: false, sdkTokenUsed: false,
    state: { captured: true, client_exists: true, remnant_free: true, credential_propagated: 'not_required', live_replay: true },
    complete: layoutResults.every(l => l.complete), layouts: layoutResults,
    productCount: products.size, duplicateCount, products: [...products.values()], receipts,
    limitations: ['Other promotion tabs and keyword search are outside this collector.', 'Listing prices are not verified checkout prices.', 'No price history or historical-low claim.'],
  };
}
