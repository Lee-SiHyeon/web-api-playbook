import { ShoppingReadError } from '../lib/shopping-session-store.mjs';
import { shoppingHttpGetDocument } from '../lib/shopping-http.mjs';

const amount = value => {
  if (typeof value !== 'string' || !/^\d[\d,]*$/.test(value)) return null;
  const n = Number(value.replace(/,/g, ''));
  return Number.isSafeInteger(n) ? n : null;
};

export function parseGmarketProductDocument(html, { query = '', count = 40 } = {}) {
  if (typeof html !== 'string' || !Number.isInteger(count) || count < 1 || count > 40)
    throw new ShoppingReadError('PRODUCT_INPUT');
  const script = html.match(/<script\b(?=[^>]*\bid=["']__NEXT_DATA__["'])[^>]*>([\s\S]*?)<\/script>/i);
  if (!script) throw new ShoppingReadError('GMARKET_SEARCH_SCHEMA');
  let data;
  try { data = JSON.parse(script[1]); } catch { throw new ShoppingReadError('GMARKET_SEARCH_SCHEMA'); }
  const modules = data?.props?.pageProps?.initialStates?.curatorData?.regionsData?.content?.modules;
  if (!Array.isArray(modules)) throw new ShoppingReadError('GMARKET_SEARCH_SCHEMA');
  const products = []; const seen = new Set(); let pagination = null;
  for (const module of modules) {
    const rows = module?.rows;
    if (!Array.isArray(rows) || !rows.length) continue;
    if (rows[0]?.designName === 'Pagination') {
      const p = rows[0].viewModel;
      if (Number.isSafeInteger(p?.currentPageIndex) && Number.isSafeInteger(p?.lastPageIndex))
        pagination = { page: p.currentPageIndex, pagesVisible: Array.isArray(p.pageList) ? p.pageList.length : null,
          totalPages: p.lastPageIndex, nextPage: p.currentPageIndex < p.lastPageIndex ? p.currentPageIndex + 1 : null };
      continue;
    }
    if (rows[0]?.designName !== 'ItemCardGeneral' || !rows[0]?.viewModel?.title?.title?.text?.includes('일반상품')) continue;
    for (const row of rows) {
      if (row?.designName !== 'ItemCardGeneral') continue;
      const model = row.viewModel; const info = model?.commonItemInfo;
      const productId = model?.itemNo; const title = info?.item?.text?.trim();
      let link; try { link = new URL(info?.item?.link); } catch { continue; }
      if (!/^\d+$/.test(productId ?? '') || !title || link.origin !== 'https://item.gmarket.co.kr' ||
          link.pathname.toLowerCase() !== '/item' || link.searchParams.get('goodscode') !== productId) continue;
      const sponsored = link.searchParams.get('buyboxtype') === 'ad';
      if (sponsored || model.isSoldOut || seen.has(productId)) continue;
      const price = info?.price;
      const currentPriceKRW = amount(price?.price?.text);
      if (currentPriceKRW === null || currentPriceKRW <= 0) continue;
      const shippingText = info?.deliveryTags?.map(tag => tag?.text?.text).filter(Boolean).join(', ') || null;
      const shippingMatch = shippingText?.match(/배송비\s*([\d,]+)\s*원/);
      const ratingText = info?.score?.avgStarScore;
      const rating = typeof ratingText === 'string' && ratingText.trim() ? Number(ratingText) : NaN;
      const originalPriceKRW = amount(price?.beforePrice?.text) ??
        (amount(price?.binPrice) > currentPriceKRW ? amount(price.binPrice) : null);
      const priceLabel = price?.assistText?.text?.trim() || null;
      products.push({ source: 'gmarket', productId, title,
        url: `https://item.gmarket.co.kr/Item?goodscode=${productId}`,
        currentPriceKRW, originalPriceKRW, priceLabel, priceRequiresCoupon: /쿠폰/.test(priceLabel ?? ''),
        shippingText, shippingFeeKRW: /무료배송/.test(shippingText ?? '') ? 0 : shippingMatch ? amount(shippingMatch[1]) : null,
        rating: Number.isFinite(rating) && rating >= 0 && rating <= 5 ? rating : null,
        reviewCount: amount(info?.score?.feedbackCount?.text), purchaseCount: amount(info?.score?.payCount?.text),
        seller: model?.seller?.seller?.text?.trim() || null, sponsored: false, soldOut: false,
        placement: 'organic', dataOrigin: 'next-data' });
      seen.add(productId);
      if (products.length >= count) break;
    }
  }
  if (!products.length) throw new ShoppingReadError('GMARKET_SEARCH_EMPTY');
  const fields = ['title', 'currentPriceKRW', 'originalPriceKRW', 'priceLabel', 'shippingText', 'shippingFeeKRW', 'rating', 'reviewCount', 'seller'];
  return { source: 'gmarket', query, productCount: products.length, products, pagination,
    fieldCoverage: Object.fromEntries(fields.map(field => [field, products.filter(p => p[field] !== null && p[field] !== '').length])),
    coverage: 'Observed first-page organic non-sponsored products embedded in the search document __NEXT_DATA__.' };
}

export async function readGmarketProducts({ query, count = 40, fetchImpl, session } = {}) {
  if (typeof query !== 'string' || !query.trim() || query.length > 100 || /[\r\n\0]/.test(query))
    throw new ShoppingReadError('QUERY_INPUT');
  const url = new URL('https://www.gmarket.co.kr/n/search');
  url.searchParams.set('keyword', query.trim());
  const response = await shoppingHttpGetDocument({ service: 'gmarket-search', url: url.href, fetchImpl, session });
  const parsed = parseGmarketProductDocument(response.html, { query: query.trim(), count });
  return { ...parsed, receipt: response.receipt, browserUsed: false, executionMode: 'pure_http',
    state: { captured: true, client_exists: true, remnant_free: !fetchImpl,
      credential_propagated: response.receipt.credentialSent, live_replay: !fetchImpl } };
}
