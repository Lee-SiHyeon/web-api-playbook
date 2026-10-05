import { normalizeOffer, sanitizedRequestReceipt } from './snapshots.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Preserve the site's displayed rank; array order never creates a rank. */
export function rankingSnapshot(result, { provider = 'oliveyoung-public', limit = 10 } = {}) {
  if (provider !== 'oliveyoung-public' || !object(result) || !Array.isArray(result.products) || !object(result.rankingContext) ||
      !Number.isInteger(limit) || limit < 1 || limit > 100 ||
      !Number.isFinite(Date.parse(result.checkedAt)) || result.executionMode !== 'pure_http' ||
      result.sourceFormat !== 'html_document' || result.isXhr !== false) {
    fail('RANKING_RESULT_INVALID');
  }
  const ranks = new Set(), ids = new Set();
  const products = result.products.map(product => {
    if (!object(product) || !Number.isInteger(product.rank) || product.rank < 1 || product.rank > 100 ||
        ranks.has(product.rank) || ids.has(product.productId)) fail('RANKING_IDENTITY_INVALID');
    ranks.add(product.rank); ids.add(product.productId);
    const offer = normalizeOffer({ provider, productId: product.productId, title: product.title, url: product.url,
      price: { ...product.price, display: product.price?.display ?? product.price?.displayText },
      availability: product.availability, observedAt: result.checkedAt,
      context: { country: 'KR', priceBasis: product.priceContext?.optionRangeHint ? 'displayed_starting_price' : 'displayed_ranking_price' },
      source: 'oliveyoung_domestic_displayed_sales_ranking' });
    return { rank: product.rank, ...offer,
      ...(product.brand ? { brand: product.brand } : {}),
      ...(product.referencePrice ? { referencePrice: product.referencePrice } : {}),
      ...(product.priceContext ? { priceContext: product.priceContext } : {}) };
  }).filter(product => product.rank <= limit).sort((a, b) => a.rank - b.rank);
  const receipts = (result.receipts?.length ? result.receipts : [result.receipt])
    .map(receipt => sanitizedRequestReceipt(receipt?.request ?? receipt)).filter(Boolean);
  if (receipts.some(receipt => receipt.browserUsed === true) ||
      !receipts.some(receipt => receipt.httpStatus === 200 && receipt.browserUsed === false)) fail('RANKING_RESULT_INVALID');
  const categories = (result.categories ?? []).map(category => {
    if (!object(category) || typeof category.categoryId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(category.categoryId) ||
        typeof category.categoryName !== 'string' || !category.categoryName.trim() || category.categoryName.length > 100) fail('RANKING_RESULT_INVALID');
    return { categoryId: category.categoryId, categoryName: category.categoryName };
  });
  const sessionReceipt = (result.receipts ?? [result.receipt]).find(receipt => receipt?.sessionKind === 'server_issued_anonymous');
  let anonymousSession;
  if (sessionReceipt) {
    const approved = new Set(['__cf_bm', '_cfuvid', 'cf_clearance']);
    const names = sessionReceipt.sentCookieNames;
    const bootstrap = sessionReceipt.bootstrapRequest;
    const issued = bootstrap?.issuedCookieNames;
    if (sessionReceipt.inputCookiesAccepted !== false || !Array.isArray(names) || !names.length ||
        names.some(name => !approved.has(name)) || !Array.isArray(issued) || !issued.length ||
        issued.some(name => !approved.has(name)) || names.some(name => !issued.includes(name)) ||
        bootstrap.origin !== 'https://www.oliveyoung.co.kr' || bootstrap.path !== '/store/main/main.do' ||
        bootstrap.cookieSent !== false || bootstrap.browserUsed !== false || bootstrap.httpStatus !== 200) fail('RANKING_SESSION_METADATA_INVALID');
    anonymousSession = { sessionKind: 'server_issued_anonymous', inputCookiesAccepted: false,
      sentCookieNames: [...names],
      bootstrapRequest: { ...sanitizedRequestReceipt(bootstrap), inputCookiesAccepted: false,
        issuedCookieNames: [...issued] } };
  }
  return { schema: 'web-api-product-ranking-snapshot-v1', provider, checkedAt: result.checkedAt,
    executionMode: result.executionMode, rankingContext: { ...result.rankingContext },
    sourceFormat: result.sourceFormat ?? null, isXhr: result.isXhr === true,
    ...(anonymousSession ? { anonymousSession } : {}),
    categories, products, receipts, collection: { requestedTop: limit, productsStored: products.length,
      topRanksVerified: products.length === limit && products.every((p, i) => p.rank === i + 1),
      ranksCreatedFromArrayOrder: false, catalogComplete: false },
    credentialsUsed: receipts.some(receipt => receipt.credentialsUsed === true), secretsPersistedInEvidence: false };
}

const csvCell = value => {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^\s*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
};

export function rankingCsv(snapshot) {
  if (snapshot?.schema !== 'web-api-product-ranking-snapshot-v1' || !Array.isArray(snapshot.products)) fail('RANKING_RESULT_INVALID');
  const context = snapshot.rankingContext;
  const rows = snapshot.products.map(p => [p.rank, p.productId, p.title, p.price.amount, p.price.currency,
    p.context.priceBasis, p.price.display, p.referencePrice?.amount, p.referencePrice?.displayText,
    p.referencePrice?.optionRangeHint, p.availability, p.url, context.categoryId, context.categoryName,
    context.rankingType, context.sourceAsOf, snapshot.checkedAt]);
  return [['rank', 'product_id', 'title', 'amount', 'currency', 'price_basis', 'price_display', 'reference_amount',
    'reference_display', 'reference_starting_price', 'availability', 'url',
    'category_id', 'category_name', 'ranking_type', 'source_as_of', 'observed_at'], ...rows]
    .map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
