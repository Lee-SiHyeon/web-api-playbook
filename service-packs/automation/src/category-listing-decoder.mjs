// Narrow decoder for the observed category-page RSC contract, not a React runtime.
// Successful decoding is not evidence of independent HTTP reachability.
export function decodeCategoryListing(raw, {categoryId, page}) {
  if (!/^\d+$/.test(String(categoryId)) || !Number.isInteger(page) || page < 1) throw Error('Expected category and page required');
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 8 * 1024 * 1024 || /^\s*</.test(raw)) throw Error('Invalid listing response');
  const rows = new Map();
  for (const line of raw.split('\n').filter(Boolean)) {
    const match = /^([a-f0-9]+):(.*)$/.exec(line);
    if (!match) continue;
    let value;
    try { value = JSON.parse(match[2]); } catch { continue; }
    if (rows.has(match[1])) throw Error('Duplicate RSC row');
    rows.set(match[1], value);
  }
  const contexts = [], paginations = [];
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (Object.hasOwn(value, 'products') && Object.hasOwn(value, 'linkcodes') && Object.hasOwn(value, 'page')) contexts.push(value);
    if (Object.hasOwn(value, 'currentPageIndex') && Object.hasOwn(value, 'totalPageIndex')) paginations.push(value);
    for (const child of Object.values(value)) if (typeof child === 'object') visit(child);
  }
  for (const value of rows.values()) visit(value);
  if (contexts.length !== 1 || paginations.length !== 1) throw Error('Ambiguous or missing listing context');
  const context = contexts[0], pagination = paginations[0];
  if (String(context.linkcodes) !== String(categoryId) || context.page !== page || pagination.currentPageIndex !== page) throw Error('Listing scope mismatch');
  const reference = /^\$([a-f0-9]+):props:products$/.exec(context.products);
  if (!reference) throw Error('Unsupported product reference');
  const row = rows.get(reference[1]);
  if (!Array.isArray(row) || row[0] !== '$' || !Array.isArray(row[3]?.products)) throw Error('Missing referenced products');
  const products = [], seen = new Set();
  const id = value => {
    if (!(typeof value === 'string' || Number.isSafeInteger(value)) || !/^\d+$/.test(String(value))) throw Error('Invalid option identity');
    return String(value);
  };
  for (const product of row[3].products) {
    const productId = id(product.legacyProductId), itemId = id(product.index?.itemId), vendorItemId = id(product.vendorItemId);
    const url = new URL(product.link, 'https://www.coupang.com');
    if (url.origin !== 'https://www.coupang.com' || url.pathname !== '/vp/products/' + productId || url.searchParams.get('itemId') !== itemId || url.searchParams.get('vendorItemId') !== vendorItemId) throw Error('Option link identity mismatch');
    const title = product.imageAndTitleArea?.title, money = product.priceArea?.i18nSalesPrice;
    if (typeof title !== 'string' || !title.trim() || money?.currency !== 'KRW' || !/^\d+$/.test(money.amount) || !Number.isSafeInteger(Number(money.amount))) throw Error('Listing product schema mismatch');
    const key = [productId, itemId, vendorItemId].join(':');
    if (seen.has(key)) continue;
    seen.add(key);
    products.push({productId, itemId, vendorItemId, title, salesPrice: Number(money.amount), currency: 'KRW', sponsored: typeof product.adBadgeArea?.sponsored === 'boolean' ? product.adBadgeArea.sponsored : null, url: `https://www.coupang.com/vp/products/${productId}?itemId=${itemId}&vendorItemId=${vendorItemId}`});
  }
  if (!Number.isInteger(pagination.totalPageIndex) || pagination.totalPageIndex < page) throw Error('Invalid pagination total');
  const next = pagination.nextPageUnit;
  let nextPage = null, nextUrl = null;
  if (next?.link) {
    const url = new URL(next.link, 'https://www.coupang.com');
    nextPage = Number(url.searchParams.get('page') ?? 1);
    if (url.origin !== 'https://www.coupang.com' || url.pathname !== '/np/categories/' + categoryId || !Number.isInteger(nextPage) || nextPage <= page || nextPage > pagination.totalPageIndex || next.displayPageNo !== nextPage) throw Error('Invalid or stalled next page');
    nextUrl = url.href;
  }
  // The final-page representation has not been observed. Absence is not completion.
  return {categoryId: String(categoryId), page, products, pagination: {nextPage, nextUrl, reportedLastPage: pagination.totalPageIndex, terminationVerified: false}, independentReplayVerified: false};
}
