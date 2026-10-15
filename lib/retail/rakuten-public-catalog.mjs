import { documentOf, assignedJson, jsonScript, documentLinks, japanDestination, imageUrl,
  clean, text, integer, money, fail } from './japan-http.mjs';

const numeric = v => /^\d{1,20}$/.test(String(v));
const list = (v, max = 1000) => {
  if (!Array.isArray(v) || v.length > max) fail('RAKUTEN_PUBLIC_SCHEMA_CHANGED');
  return v;
};
const summary = (count, average) => integer(count) && Number.isFinite(average) && average >= 0 && average <= 5
  ? { count, average } : null;

export function parseRakutenHome(html) {
  const doc = documentOf(html);
  const widget = doc.querySelector('#side-navi [irc="GenreWidget"][data-items]');
  if (!widget) fail('RAKUTEN_HOME_MENU_MISSING');
  let groups; try { groups = JSON.parse(widget.getAttribute('data-items')); } catch { fail('RAKUTEN_HOME_MENU_INVALID'); }
  const menus = [], links = [], edges = [];
  for (const group of list(groups, 100)) {
    if (!/^[a-zA-Z][\w-]{0,80}$/.test(group.key)) fail('RAKUTEN_HOME_MENU_INVALID');
    const groupId = 'genre-group:' + group.key;
    menus.push({ id: groupId, label: group.key, labelBasis: 'first_party_menu_key' });
    edges.push({ from: 'https://www.rakuten.co.jp/', to: groupId, relation: 'home_to_menu' });
    for (const item of list(group.items, 100)) {
      const target = japanDestination('rakuten', item.link);
      const label = item.key ?? item.title?.ja ?? item.title;
      if (!target || target.kind !== 'category' || !text(label, 250)) fail('RAKUTEN_HOME_MENU_INVALID');
      links.push({ ...target, label, relation: 'menu_to_category', parent: groupId });
      edges.push({ from: groupId, to: target.url, relation: 'menu_to_category' });
    }
  }
  if (!menus.length || !links.length) fail('RAKUTEN_HOME_MENU_EMPTY');
  return { root: 'https://www.rakuten.co.jp/', navigationScope: 'ichiba_product_genres',
    rootDiscoveryComplete: true, menus, edges, links, products: [], pagination: null,
    otherWidgetsExcluded: [...doc.querySelectorAll('#side-navi [irc][data-items]')]
      .map(w => w.getAttribute('irc')).filter(name => name !== 'GenreWidget'),
    completeCatalog: false };
}

export function parseRakutenListing(html, url) {
  const doc = documentOf(html);
  const state = assignedJson(doc, 'window.__INITIAL_STATE__ =').state?.data;
  const data = state?.ichibaSearch, query = state?.uiQuestion;
  if (!data || data.error || !query || !integer(data.pagination?.numFound) || !integer(query.page) || query.page < 1) fail('RAKUTEN_LISTING_SCHEMA_CHANGED');
  const input = new URL(url), parts = input.pathname.split('/').filter(Boolean);
  const requestedPage = Number(input.searchParams.get('p') ?? 1);
  if (requestedPage !== query.page) fail('RAKUTEN_LISTING_PAGE_MISMATCH');
  let requestedKeyword = input.searchParams.get('sitem');
  if (input.hostname === 'search.rakuten.co.jp' && parts[2] && parts[2] !== '-') requestedKeyword = decodeURIComponent(parts[2]);
  if (requestedKeyword !== null && requestedKeyword !== undefined && requestedKeyword !== query.keywords) fail('RAKUTEN_LISTING_QUERY_MISMATCH');
  const requestedGenre = input.hostname === 'www.rakuten.co.jp' ? parts[1] : parts[3] ?? input.searchParams.get('g');
  if (requestedGenre && String(query.category) !== requestedGenre) fail('RAKUTEN_LISTING_CATEGORY_MISMATCH');
  const products = list(data.items, 200).map((row, position) => {
    const target = japanDestination('rakuten', row.originalItemUrl);
    if (!target || target.kind !== 'product' || !numeric(row.code) || !numeric(row.shop?.id) || !text(row.name)
      || new URL(target.url).pathname.split('/')[1] !== row.shop.urlCode) fail('RAKUTEN_LISTING_IDENTITY_MISMATCH');
    return { id: String(row.shop.id) + ':' + row.code, shopId: String(row.shop.id), itemId: String(row.code),
      shopCode: row.shop.urlCode, shopName: clean(row.shop.name), title: clean(row.name), url: target.url,
      price: money(row.price, row.hasPriceRange ? 'listing_minimum_or_range' : 'listing_display'),
      selectedVariantPriceVerified: false,
      listingVariantId: text(row.variantId, 200) ? row.variantId : null,
      availability: row.isSoldOut === true ? 'unavailable' : 'unknown',
      sponsored: row.itemOptions?.cpc != null, position: position + 1,
      images: list(row.images ?? [], 100).map(i => imageUrl('rakuten', i.url)).filter(Boolean),
      reviewSummary: summary(row.review?.numReviews, row.review?.score),
      reviewUrl: japanDestination('rakuten', row.review?.url)?.url ?? null,
      variants: [], source: 'INITIAL_STATE.state.data.ichibaSearch.items' };
  });
  if (!products.length && data.pagination.numFound !== 0) fail('RAKUTEN_LISTING_EMPTY_UNEXPECTED');
  const links = documentLinks('rakuten', doc, url);
  let nextUrl = null;
  for (const a of doc.querySelectorAll('a[href]')) if (clean(a.textContent) === '次のページ') {
    const next = japanDestination('rakuten', a.getAttribute('href'), url);
    if (!next || next.kind !== 'listing' || Number(new URL(next.url).searchParams.get('p')) !== query.page + 1) fail('RAKUTEN_NEXT_PAGE_INVALID');
    const nextURL = new URL(next.url), nextParts = nextURL.pathname.split('/').filter(Boolean);
    const nextKeyword = nextParts[2] === '-' ? '' : decodeURIComponent(nextParts[2] ?? nextURL.searchParams.get('sitem') ?? '');
    const nextGenre = nextParts[3] ?? nextURL.searchParams.get('g') ?? '0';
    if (nextKeyword !== (query.keywords ?? '') || nextGenre !== String(query.category)) fail('RAKUTEN_NEXT_PAGE_QUERY_MISMATCH');
    nextUrl = next.url;
  }
  const categoryNodes = [], categoryEdges = [], seen = new Set();
  function visit(node, parent = null, depth = 0) {
    if (!node) return;
    if (depth > 20 || !numeric(node.id) || !text(node.name, 250) && !(node.id === 0 && node.name === '')) fail('RAKUTEN_CATEGORY_SCHEMA_CHANGED');
    const id = String(node.id);
    if (!seen.has(id)) {
      seen.add(id); categoryNodes.push({ id, label: node.name || null, structuralRoot: node.id === 0, leafReportedBySite: node.leaf === true });
      for (const child of list(node.children ?? [], 1000)) visit(child, id, depth + 1);
    }
    if (parent) categoryEdges.push({ from: parent, to: id, relation: 'genre_parent_to_child' });
  }
  visit(state.genreTree?.parent_category);
  return { products, links, categoryNodes, categoryEdges, query: { keyword: query.keywords, categoryId: String(query.category), page: query.page },
    pagination: { page: query.page, returned: products.length, reportedTotal: data.pagination.numFound,
      advertisedPageSize: data.pagination.pageSize, includesSponsored: products.some(p => p.sponsored), nextUrl,
      allPagesRead: false, stopReason: nextUrl ? null : 'no_observed_next_link' }, completeCatalog: false };
}

function plainHtml(value, max = 20000) {
  if (typeof value !== 'string' || value.length > 500000) return null;
  const doc = documentOf('<html><body>' + value + '</body></html>');
  for (const node of doc.querySelectorAll('script,style,iframe')) node.remove();
  return clean(doc.body.textContent).slice(0, max) || null;
}

export function parseRakutenProduct(html, url) {
  const doc = documentOf(html);
  const packet = jsonScript(doc, '#item-page-app-data');
  const item = packet.newApi?.itemInfoSku;
  const [shopCode, manageNumber] = new URL(url).pathname.split('/').filter(Boolean);
  const field = name => doc.querySelector('input[name="' + name + '"]')?.getAttribute('value');
  if (!item || item.manageNumber !== manageNumber || !numeric(item.shopId) || !numeric(item.itemId)
    || String(item.shopId) !== field('shop_bid') || String(item.itemId) !== field('item_id') || shopCode !== field('shopurl')
    || !text(item.title)) fail('RAKUTEN_PRODUCT_IDENTITY_MISMATCH');
  const id = String(item.shopId) + ':' + item.itemId;
  const selectors = list(item.variantSelectors ?? [], 20).map(s => {
    if (!text(s.key, 250) || !text(s.label, 250)) fail('RAKUTEN_VARIANT_SELECTOR_INVALID');
    return { key: s.key, label: s.label, values: list(s.values, 1000).map(v => {
      if (!text(v.value, 500) || !text(v.label, 500)) fail('RAKUTEN_VARIANT_SELECTOR_INVALID');
      return { value: v.value, label: v.label };
    }) };
  });
  const stockRows = list(item.purchaseInfo?.sku ?? [], 1000);
  const stocks = new Map(stockRows.map(s => [s.variantId, s.newPurchaseSku]));
  if (stocks.size !== stockRows.length) fail('RAKUTEN_VARIANT_DUPLICATE');
  const variants = list(item.sku ?? [], 1000).map(v => {
    if (!text(v.variantId, 200) || !Array.isArray(v.selectorValues) || v.selectorValues.length !== selectors.length
      || v.selectorValues.some((value, i) => !selectors[i].values.some(choice => choice.value === value))) fail('RAKUTEN_VARIANT_INVALID');
    const stock = stocks.get(v.variantId);
    const quantity = integer(stock?.quantity) ? stock.quantity : null;
    const availability = v.hidden === true || stock?.stockCondition === 'sold-out' || quantity === 0 ? 'unavailable'
      : quantity > 0 ? 'available' : 'unknown';
    return { id: v.variantId, options: selectors.map((s, i) => ({ name: s.label, value: v.selectorValues[i] })),
      price: money(v.taxIncludedPrice, 'sku_tax_included'), availability, quantity,
      stockBasis: stock ? 'purchaseInfo.sku.newPurchaseSku' : 'not_observed',
      priceSource: 'newApi.itemInfoSku.sku.taxIncludedPrice', hidden: v.hidden === true,
      jan: /^\d{8,14}$/.test(v.articleNumber?.value ?? '') ? v.articleNumber.value : null,
      images: list(v.images ?? [], 100).map(i => imageUrl('rakuten', i.location)).filter(Boolean),
      attributes: list(v.attributes ?? [], 200).filter(a => text(a.title, 250) && text(a.value, 2000))
        .map(a => ({ label: a.title, value: a.value })) };
  });
  if (new Set(variants.map(v => v.id)).size !== variants.length) fail('RAKUTEN_VARIANT_DUPLICATE');
  const reviewUrl = documentLinks('rakuten', doc, url).find(link => link.kind === 'reviews'
    && new URL(link.url).pathname.split('/')[3] === String(item.shopId) + '_' + item.itemId)?.url ?? null;
  const normalMin = item.purchaseInfo?.purchaseBySellType?.normalPurchase?.price?.minPrice;
  return { product: { id, shopId: String(item.shopId), itemId: String(item.itemId), shopCode, manageNumber,
    title: clean(item.title), shopName: clean(packet.shop?.shopName), url,
    description: plainHtml(item.newProductDescription ?? item.pcFields?.productDescription),
    price: integer(normalMin) ? money(normalMin, 'product_minimum') : null,
    images: list(item.media?.images ?? [], 200).map(i => imageUrl('rakuten', i.location)).filter(Boolean),
    selectors, variants, variantCoverage: variants.length ? 'itemInfoSku.sku' : 'no_sku_rows_observed',
    unmappedInventoryRows: stockRows.filter(s => !variants.some(v => v.id === s.variantId)).length,
    reviewSummary: summary(item.itemReviewInfo?.summary?.itemReviewCount, item.itemReviewInfo?.summary?.itemReviewRating),
    reviewUrl, identityVerified: true, source: 'item-page-app-data.newApi.itemInfoSku' },
    links: documentLinks('rakuten', doc, url), completeCatalog: false };
}
