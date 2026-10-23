import { createHash } from 'node:crypto';
import { collect } from '../../naver-blog-api/research/content-store/grocery-compare.mjs';
import { readCoupangProducts } from './coupang-products.mjs';

const aliases = { coupang: 'coupang', 'coupang-partners': 'coupang-partners',
  ssg: 'ssg', emart: 'ssg', elevenst: 'elevenst', '11st': 'elevenst' };
const safeCode = error => /^[A-Z][A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : 'SHOPPING_READ_FAILED';
const fail = code => Object.assign(new Error(code), { code });

// A general product list reuses the existing collectors in catalog mode. Meat
// relevance/weight filters belong only to the grocery comparison workflow.
export async function readShoppingProducts({ query, sources = ['coupang', 'elevenst', 'ssg'], limit = 36,
  fetchImpl = globalThis.fetch, coupangRead = readCoupangProducts } = {}) {
  if (typeof query !== 'string' || !query.trim() || query.length > 120 || /[\x00-\x1f\x7f]/.test(query)
    || !Number.isInteger(limit) || limit < 1 || limit > 36 || !Array.isArray(sources) || !sources.length
    || sources.some(source => !Object.hasOwn(aliases, source))) throw fail('SHOPPING_INPUT_INVALID');
  sources = [...new Set(sources.map(source => aliases[source]))];
  const checkedAt = new Date().toISOString(), sites = {}, items = [];
  const publicSources = sources.filter(source => source !== 'coupang' && source !== 'coupang-partners');
  if (sources.includes('coupang')) {
    sites.coupang = { status: 'error', error: 'COUPANG_CONSUMER_SEARCH_BLOCKED', count: 0, total: null,
      sourceScope: 'consumer_search_first_page', receipt: null, browserUsed: false,
      blockedBy: 'observed_direct_http_403',
      evidenceRef: 'docs/coupang-account-rsc-replay-2026-09-27.json',
      states: { captured: true, client_exists: false, remnant_free: 'not_applicable',
        credential_propagated: false, live_replay: false } };
  }
  const publicWork = async () => {
    if (!publicSources.length) return;
    const receipts = [];
    const trackedFetch = async (input, init = {}) => {
      const url = new URL(input);
      const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(20000) });
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body ?? []) {
        bytes += chunk.byteLength;
        if (bytes > 8 * 1024 * 1024) throw fail('SHOPPING_RESPONSE_TOO_LARGE');
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks);
      receipts.push({ source: url.hostname === 'search.ssg.com' ? 'ssg' : 'elevenst',
        method: init.method ?? 'GET', endpoint: url.origin + url.pathname, httpStatus: response.status,
        contentType: response.headers.get('content-type'), bytes,
        responseSha256: createHash('sha256').update(body).digest('hex'),
        browserUsed: false, credentialsUsed: false });
      if (response.status === 200 && !/^application\/(?:[\w.-]+\+)?json(?:;|$)/i.test(response.headers.get('content-type') ?? ''))
        throw fail('SHOPPING_MIME_INVALID');
      return new Response([204, 205, 304].includes(response.status) ? null : body,
        { status: response.status, headers: response.headers });
    };
    const result = await collect(query.trim(), { onlySources: publicSources, filterMode: 'catalog',
      perSite: limit, kurlyDetails: 0, fetchImpl: trackedFetch });
    for (const source of publicSources) {
      const status = result.sites[source], sourceItems = result.offers.filter(offer => offer.mall === source);
      const receipt = receipts.find(row => row.source === source) ?? null;
      const successful = !!status && !status.error && receipt?.httpStatus === 200;
      sites[source] = { status: successful ? sourceItems.length ? 'ok' : 'empty' : 'error',
        error: status?.error ?? (successful ? null : 'SHOPPING_READ_FAILED'), count: sourceItems.length,
        total: status?.total ?? null, sourceScope: 'consumer_search_first_page', receipt,
        states: { captured: true, client_exists: true, remnant_free: true,
          credential_propagated: 'not_required', live_replay: successful && sourceItems.length > 0 } };
      if (successful) items.push(...sourceItems.map(offer => ({ ...offer, source,
        title: offer.name, sourceScope: 'consumer_search_first_page', priceBasis: 'listed_price' })));
    }
  };
  const coupangPartnersWork = async () => {
    if (!sources.includes('coupang-partners')) return;
    try {
      const result = await coupangRead({ query: query.trim(), limit });
      sites['coupang-partners'] = { status: result.products.length ? 'ok' : 'empty', count: result.products.length,
        total: result.total, sourceScope: 'partners_web_catalog_first_page', receipt: result.receipt,
        states: { captured: true, client_exists: true, remnant_free: true,
          credential_propagated: result.receipt?.credentialPropagated === true, live_replay: result.products.length > 0 } };
      items.push(...result.products.map(product => {
        const { reviewCount: partnerReviewCount, ...partnerProduct } = product;
        return { ...partnerProduct, mall: 'coupang-partners', source: 'coupang-partners',
          id: `coupang-partners:${product.productId}:${product.itemId}:${product.vendorItemId}`, name: product.title,
          reviews: null, partnerMetadata: { reviewCount: partnerReviewCount ?? null },
          shippingFee: product.freeShipping === true ? 0 : null,
          sourceScope: 'partners_web_catalog_first_page', checkedAt: result.receipt?.checkedAt ?? checkedAt };
      }));
    } catch (error) { sites['coupang-partners'] = { status: 'error', error: safeCode(error), count: 0,
      sourceScope: 'partners_web_catalog_first_page', browserUsed: false }; }
  };
  const results = await Promise.allSettled([publicWork(), coupangPartnersWork()]);
  if (results[0].status === 'rejected') for (const source of publicSources)
    sites[source] = { status: 'error', error: safeCode(results[0].reason), count: 0 };
  if (results[1].status === 'rejected') sites['coupang-partners'] = { status: 'error', error: safeCode(results[1].reason), count: 0,
    sourceScope: 'partners_web_catalog_first_page', browserUsed: false };
  const failures = sources.filter(source => sites[source]?.status === 'error');
  const sortedItems = sources.filter(source => sites[source]?.status === 'ok')
    .flatMap(source => items.filter(item => item.source === source));
  const execution = publicSources.length || sources.includes('coupang-partners') ? 'pure_http' : 'not_attempted';
  return { schemaVersion: 1, query: query.trim(), checkedAt, execution, browserUsed: false,
    ok: failures.length === 0, partial: failures.length > 0 && failures.length < sources.length,
    requestedSources: sources, failedSources: failures, sites, count: sortedItems.length, items: sortedItems,
    coverage: 'One observed search page per source; coupang is the www.coupang.com consumer search and is blocked after an observed direct HTTP 403; coupang-partners is a separate explicit Partners web catalog source.' };
}
