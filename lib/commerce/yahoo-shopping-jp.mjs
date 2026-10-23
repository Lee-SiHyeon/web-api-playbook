import { commerceJsonRequest } from './http.mjs';
import { assertCredentialFreeResult } from './credential-output.mjs';
import { japanDestination, imageUrl, integer, text, money, fail } from '../retail/japan-http.mjs';

const ORIGIN = 'https://shopping.yahooapis.jp';
const PATH = '/ShoppingWebService/V3/itemSearch';
export const YAHOO_SEARCH_DOC = 'https://developer.yahoo.co.jp/webapi/shopping/v3/itemsearch.html';

// Public consumer login is not a Yahoo developer application registration.
// This documented API requires the caller's own appId. Affiliate generation is
// deliberately not claimed: ValueCommerce IDs/ownership remain unverified.
export function createYahooShoppingJpClient({ appId, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (!text(appId, 500) || appId.trim() !== appId || /\s/.test(appId)) fail('YAHOO_APP_ID_REQUIRED');
  async function search({ query, categoryId, sellerId, jan, start = 1, results = 20, sort = '-score' } = {}) {
    if (query !== undefined && !text(query, 120) || categoryId !== undefined && !/^\d{1,12}$/.test(String(categoryId))
      || sellerId !== undefined && !/^[a-z0-9_-]{1,100}$/.test(sellerId)
      || jan !== undefined && !/^\d{8,14}$/.test(jan)
      || !Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(results) || results < 1 || results > 100
      || start + results > 1000 || !['-score','+price','-price','-review_count'].includes(sort)
      || [query, categoryId, sellerId, jan].every(v => v === undefined)) fail('YAHOO_SEARCH_INPUT_INVALID');
    const fields = [['appid', appId], ['start', String(start)], ['results', String(results)], ['sort', sort]];
    for (const [name, value] of [['query',query],['genre_category_id',categoryId],['seller_id',sellerId],['jan_code',jan]])
      if (value !== undefined) fields.push([name, String(value)]);
    let response;
    try { response = await commerceJsonRequest({ service: 'yahoo-shopping-jp', origin: ORIGIN, path: PATH,
      query: fields, fetchImpl, now }); }
    catch (e) { if (e.receipt) Object.assign(e.receipt, { credentialsUsed: true, anonymous: false, credentialType: 'registered_application_id' }); throw e; }
    const { payload: p } = response;
    const request = { ...response.request, credentialsUsed: true, anonymous: false, credentialType: 'registered_application_id' };
    if (!Array.isArray(p.hits) || p.hits.length > results || !integer(p.totalResultsAvailable)
      || p.totalResultsReturned !== p.hits.length || p.firstResultsPosition !== start
      || query !== undefined && p.request?.query !== query) fail('YAHOO_SEARCH_SCHEMA_INVALID', request);
    const items = p.hits.map(row => {
      if (!text(row.code, 250) || !text(row.name, 2000) || !text(row.seller?.sellerId, 100)
        || typeof row.inStock !== 'boolean') fail('YAHOO_SEARCH_ITEM_INVALID', request);
      const target = japanDestination('yahoo', row.url);
      const canonicalUrl = target?.kind === 'product' ? target.url : null;
      // Do not fabricate URL/ID equivalence (LOHACO has a distinct seller alias).
      const identityVerified = canonicalUrl !== null
        && new URL(canonicalUrl).pathname.split('/')[1] === row.seller.sellerId
        && row.code === row.seller.sellerId + '_' + new URL(canonicalUrl).pathname.split('/')[2].replace(/\.html$/, '');
      return { id: row.code, sellerId: row.seller.sellerId, title: row.name, canonicalUrl,
        identityVerified, price: money(row.price, 'official_api_listing'),
        availability: row.inStock ? 'available' : 'unavailable',
        images: [row.image?.medium, row.exImage?.url].map(u => imageUrl('yahoo', u)).filter(Boolean),
        affiliateRate: Number.isFinite(row.affiliateRate) && row.affiliateRate >= 0 && row.affiliateRate <= 100 ? row.affiliateRate : null,
        affiliateUrl: null, selectedVariantPriceVerified: false };
    });
    const nextStart = start + p.hits.length;
    const result = { schema: 'web-api-yahoo-jp-search-v1', ok: true, executionMode: 'pure_http',
      service: 'yahoo-shopping-jp', checkedAt: request.checkedAt, browserUsed: false, credentialsUsed: true,
      accountOwnerVerified: false, affiliateLinkVerified: false, contractProvenance: { kind: 'first_party_documented_api', sourceURL: YAHOO_SEARCH_DOC },
      request, items, pagination: { start, results, returned: items.length, total: p.totalResultsAvailable,
        nextStart: items.length && nextStart <= p.totalResultsAvailable && nextStart + results <= 1000 ? nextStart : null,
        apiWindowLimit: 1000, completeCatalog: false } };
    assertCredentialFreeResult(result, { appId });
    return result;
  }
  return Object.freeze({ search });
}
