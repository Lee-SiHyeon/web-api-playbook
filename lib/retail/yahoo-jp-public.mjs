import { documentOf, jsonScript, documentLinks, japanDestination, imageUrl, clean, text, integer, money, fail } from './japan-http.mjs';

const list = (value, maximum = 2000) => {
  if (!Array.isArray(value) || value.length > maximum) fail('YAHOO_PUBLIC_SCHEMA_CHANGED');
  return value;
};
const properties = doc => {
  const p = jsonScript(doc, '#__NEXT_DATA__').props?.pageProps;
  if (!p || p.error) fail('YAHOO_PUBLIC_DATA_INVALID');
  return p;
};
const canonicalProduct = raw => {
  const url = japanDestination('yahoo', raw);
  return url?.kind === 'product' ? url.url : null;
};

export function parseYahooNavigation(html, url) {
  const doc = documentOf(html), data = properties(doc);
  const links = documentLinks('yahoo', doc, url), nodes = new Map(), edges = [];
  const category = (value, parent) => {
    if (!value || !text(value.name, 250) || !integer(value.gid)) fail('YAHOO_CATEGORY_SCHEMA_CHANGED');
    const target = japanDestination('yahoo', value.link);
    if (!target || target.kind !== 'category' || !new URL(target.url).pathname.split('/').includes(String(value.gid))) fail('YAHOO_CATEGORY_IDENTITY_MISMATCH');
    nodes.set(target.url, { ...target, id: String(value.gid), label: value.name });
    edges.push({ from: parent, to: target.url, relation: parent === url ? 'home_to_category' : 'category_to_child' });
    return target.url;
  };
  if (url === 'https://shopping.yahoo.co.jp/') {
    for (const group of list(data.categoryEntity?.bigCategories, 100)) {
      for (const item of list(group.categories, 100)) category(item, url);
      for (const branch of list(group.childCategories, 100)) {
        const parent = category(branch.category, url);
        for (const child of list(branch.childCategories, 500)) category(child, parent);
      }
    }
    if (!nodes.size) fail('YAHOO_CATEGORY_EMPTY');
  } else if (!data.genreCategoryEntity) fail('YAHOO_CATEGORY_SCHEMA_CHANGED');
  const uniqueEdges = [...new Map(edges.map(e => [e.from + '\0' + e.to, e])).values()];
  const byUrl = new Map(links.map(l => [l.url, l]));
  for (const node of nodes.values()) byUrl.set(node.url, { url: node.url, kind: 'category', label: node.label, relation: 'category_navigation' });
  // Home/module card labels may only name a brand. Retain candidate URLs;
  // don't manufacture product titles or offerings from them.
  const candidates = [...byUrl.values()].filter(l => l.kind === 'product').map(l => ({ url: l.url, needsDetail: true }));
  return { root: 'https://shopping.yahoo.co.jp/', navigationScope: 'shopping_product_categories',
    rootDiscoveryComplete: url === 'https://shopping.yahoo.co.jp/' && nodes.size > 0,
    categoryNodes: [...nodes.values()], edges: uniqueEdges, links: [...byUrl.values()],
    products: [], identityCandidates: candidates, pagination: null, completeCatalog: false };
}

function description(raw) {
  if (typeof raw !== 'string' || raw.length > 500000) return null;
  const doc = documentOf('<html><body>' + raw + '</body></html>');
  for (const node of doc.querySelectorAll('script,style,iframe')) node.remove();
  return clean(doc.body.textContent).slice(0, 20000) || null;
}
function availability(stock) {
  return stock?.isAvailable === true ? 'available' : stock?.isAvailable === false ? 'unavailable' : 'unknown';
}

export function parseYahooProduct(html, url) {
  const doc = documentOf(html), p = properties(doc), item = p.item;
  const [sellerId, filename] = new URL(url).pathname.split('/').filter(Boolean);
  const srid = filename?.replace(/\.html$/, '');
  const canonical = canonicalProduct(doc.querySelector('link[rel="canonical"]')?.getAttribute('href'));
  if (!item || p.seller?.id !== sellerId || item.srid !== srid || canonical !== url || !text(item.name)) fail('YAHOO_PRODUCT_IDENTITY_MISMATCH');
  const ld = [...doc.querySelectorAll('script[type="application/ld+json"]')].map(s => {
    try { return JSON.parse(s.textContent); } catch { return null; }
  }).filter(j => j?.['@type'] === 'Product');
  if (ld.length !== 1 || ld[0].offers?.priceCurrency !== 'JPY'
    || canonicalProduct(ld[0].offers.url) !== url || ld[0].offers.price !== item.applicablePrice) fail('YAHOO_PRODUCT_PRICE_MISMATCH');
  const variants = list(item.individualItemList ?? [], 1000).map(v => {
    if (!text(v.skuId, 250)) fail('YAHOO_VARIANT_ID_INVALID');
    if (v.price != null && !integer(v.price.applicablePrice)) fail('YAHOO_VARIANT_PRICE_INVALID');
    const options = list(v.optionList, 20).map(o => {
      if (!text(o.name, 250) || !text(o.choiceName, 500)) fail('YAHOO_VARIANT_OPTION_INVALID');
      return { name: o.name, value: o.choiceName };
    });
    return { id: v.skuId, options, price: v.price == null ? null : money(v.price.applicablePrice, 'sku_applicable_price'),
      selectedVariantPriceVerified: v.price != null,
      availability: availability(v.stock), quantity: integer(v.stock?.quantity) ? v.stock.quantity : null,
      priceSource: v.price == null ? null : 'item.individualItemList.price.applicablePrice', stockBasis: 'item.individualItemList.stock' };
  });
  if (new Set(variants.map(v => v.id)).size !== variants.length) fail('YAHOO_VARIANT_DUPLICATE');
  const customizationOptions = list(item.selectOptionList ?? [], 200).map(o => {
    if (!text(o.name, 1000)) fail('YAHOO_CUSTOMIZATION_INVALID');
    return { name: o.name, choices: list(o.choiceList, 200).map(c => {
      if (!text(c.name, 1000)) fail('YAHOO_CUSTOMIZATION_INVALID');
      return { name: c.name, selectable: c.isSelectable === true, additionalChargeJpy: integer(c.charge) ? c.charge : null };
    }), inventoryVariant: false };
  });
  const previewReviews = list(p.review?.itemReviews ?? [], 100).filter(r => text(r.id, 100)
    && /^[a-zA-Z0-9_-]{1,100}$/.test(r.id) && text(r.body, 50000) && Number.isInteger(r.rating)
    && r.rating >= 1 && r.rating <= 5 && /^\d{4}\/\d{1,2}\/\d{1,2}$/.test(r.postedDate ?? '')).map(r => ({
      id: r.id, body: r.body, title: text(r.title, 2000) ? r.title : null, rating: r.rating, date: r.postedDate,
      scope: 'product_page_preview', authorStored: false,
    }));
  const reviewSummary = integer(p.review?.reviewSummary?.count) && Number.isFinite(p.review?.reviewSummary?.average)
    ? { count: p.review.reviewSummary.count, average: p.review.reviewSummary.average } : null;
  return { product: { id: sellerId + ':' + srid, sellerId, itemId: srid, title: clean(item.name), url,
    sellerManagedItemId: text(item.sellerManagedItemId, 200) ? item.sellerManagedItemId : null,
    shopName: clean(p.seller.name), brand: clean(item.brandName) || null,
    description: description(item.information), price: money(item.applicablePrice, 'product_display_representative'),
    availability: availability(item.stock), quantity: integer(item.stock?.quantity) ? item.stock.quantity : null,
    jan: /^\d{8,14}$/.test(item.janCode ?? '') ? item.janCode : null,
    images: list(item.images?.displayItemImageList ?? [], 200).map(i => imageUrl('yahoo', i.src)).filter(Boolean),
    variants, customizationOptions, variantCoverage: variants.length ? 'individualItemList' : item.axisNum === 0 ? 'no_sku_axis' : 'unverified',
    reviewSummary, previewReviews, reviewPaginationVerified: false,
    identityVerified: true, source: '__NEXT_DATA__.props.pageProps.item' },
    links: documentLinks('yahoo', doc, url), completeCatalog: false };
}
