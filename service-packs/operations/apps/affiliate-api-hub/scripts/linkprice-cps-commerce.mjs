import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadWebAuth } from '../adapters/web-auth-provider.mjs';
import { buildCpsCommerceMap, capabilityForSource, loadCpsConsumerCrosswalk, loadConsumerShoppingRegistry,
  normalizeCpsRetailOffers } from '../adapters/cps-commerce-ontology.mjs';
import { readCpsProductPage } from '../adapters/cps-product-jsonld.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REFERENCES = path.resolve(HERE, '../references');
const safeReceipt = receipt => receipt ? { operation: receipt.operation, httpStatus: receipt.httpStatus, checkedAt: receipt.checkedAt,
  browserUsed: false, recordCount: receipt.recordCount } : null;
const safeRequestUrl = raw => {
  try {
    const url = new URL(raw);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/token|auth|session|password|secret|csrf|email|phone|account|key|query|keyword|kwd|inputkeyword|^q$/i.test(key))
      url.searchParams.set(key, 'REDACTED');
    return url.href;
  } catch { return null; }
};

async function liveCatalog() {
  const auth = await loadWebAuth('linkprice');
  return auth.merchants({ kind: 'cps' });
}

function merchantSource(merchantId, catalog) {
  const merchant = catalog.merchants.find(row => row.merchant_id === merchantId);
  if (!merchant) throw Object.assign(new Error('MERCHANT_NOT_ACTIVE_CPS'), { code: 'MERCHANT_NOT_ACTIVE_CPS' });
  const mapping = loadCpsConsumerCrosswalk().mappings.find(row => row.merchantId === merchantId);
  if (!mapping) throw Object.assign(new Error('CONSUMER_SOURCE_NOT_MAPPED'), { code: 'CONSUMER_SOURCE_NOT_MAPPED' });
  return { merchant, mapping };
}

async function searchMappedMerchant(merchantId, keyword, catalog, limit) {
  if (typeof keyword !== 'string' || !keyword.trim() || keyword.length > 120) throw Object.assign(new Error('SEARCH_QUERY_INVALID'), { code: 'SEARCH_QUERY_INVALID' });
  const { merchant, mapping } = merchantSource(merchantId, catalog);
  const sourceEvidence = capabilityForSource(mapping.consumerSourceId, 'search');
  if (sourceEvidence.state !== 'verified_public_http') throw Object.assign(new Error('PRODUCT_SEARCH_NOT_VERIFIED'), {
    code: 'PRODUCT_SEARCH_NOT_VERIFIED', receipt: { merchantId, sourceId: mapping.consumerSourceId, capability: 'search', state: sourceEvidence.state },
  });
  const permittedSourceIds = new Set(['homeplus', 'lotteon', 'ssg', 'elevenst', 'kurly']);
  if (!permittedSourceIds.has(mapping.consumerSourceId)) throw Object.assign(new Error('PRODUCT_SEARCH_ADAPTER_UNAVAILABLE'), { code: 'PRODUCT_SEARCH_ADAPTER_UNAVAILABLE' });

  const { collect } = await import('../../naver-blog-api/research/content-store/grocery-compare.mjs');
  const requestReceipts = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const headers = new Headers(init.headers ?? {});
    if (headers.has('cookie') || headers.has('authorization')) throw Object.assign(new Error('SOURCE_CREDENTIALS_NOT_ALLOWED'), { code: 'SOURCE_CREDENTIALS_NOT_ALLOWED' });
    const method = String(init.method ?? 'GET').toUpperCase();
    const response = await fetch(url, { ...init, headers, method, credentials: 'omit', redirect: 'manual', cache: 'no-store' });
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body ?? []) {
      bytes += chunk.byteLength;
      if (bytes > 8 * 1024 * 1024) throw Object.assign(new Error('SOURCE_RESPONSE_TOO_LARGE'), { code: 'SOURCE_RESPONSE_TOO_LARGE' });
      chunks.push(Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks);
    requestReceipts.push({ method, requestUrl: safeRequestUrl(url.href), httpStatus: response.status,
      contentType: response.headers.get('content-type') ?? '', observedAt: new Date().toISOString(),
      browserUsed: false, cookiesSent: false, authorizationSent: false, bytes,
      responseSha256: createHash('sha256').update(body).digest('hex') });
    return new Response([204, 205, 304].includes(response.status) ? null : body, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
  };
  const result = await collect(keyword.trim(), { fetchImpl, onlySources: [mapping.consumerSourceId], includeGmarket: false,
    includeMarketReference: false, includeCoupangDanawa: false, perSite: Math.max(1, Math.min(40, Number(limit) || 40)),
    kurlyDetails: 0, sleepImpl: async () => {} });
  const searchReceipt = requestReceipts.find(receipt => receipt.httpStatus === 200) ?? requestReceipts[0] ?? null;
  const offers = normalizeCpsRetailOffers(result.offers, { merchant, sourceId: mapping.consumerSourceId,
    checkedAt: result.checkedAt, siteReceipt: searchReceipt && { ...searchReceipt, credentialSent: false } });
  const siteRead = result.sites[mapping.consumerSourceId] ?? null;
  return { ontologyId: 'acada:cps-commerce', affiliateProgram: { id: `linkprice:${merchantId}`, merchantId, name: merchant.site_name },
    consumerSource: { sourceId: mapping.consumerSourceId, mappingState: 'explicit_merchant_id_crosswalk' },
    query: keyword.trim(), checkedAt: result.checkedAt, resultCount: offers.length, offers,
    searchEvidence: { capabilityState: sourceEvidence.state, registryEvidence: sourceEvidence.evidence,
      sourceRead: siteRead, requestReceipts, browserUsed: false, cookiesSent: false, authorizationSent: false,
      pagination: { pagesRead: requestReceipts.length, complete: false, stopReason: 'first_page_search' } },
  };
}

function safeReviewText(value, limit = 3000) {
  return typeof value === 'string' ? value.replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[이메일]')
    .replace(/(?:\+?82[\s-]?)?0\d{1,2}[\s-]?\d{3,4}[\s-]?\d{4}/g, '[전화번호]')
    .replace(/\b\d{6}[- ]?[1-4]\d{6}\b/g, '[개인식별번호]')
    .replace(/https?:\/\/\S+/gi, '[링크]') || null : null;
}

async function readMappedReviews(merchantId, productUrl, catalog, maxPages) {
  const { merchant, mapping } = merchantSource(merchantId, catalog);
  const sourceEvidence = capabilityForSource(mapping.consumerSourceId, 'reviews_photo');
  if (mapping.consumerSourceId !== 'auction' || sourceEvidence.state !== 'manual_url_only') throw Object.assign(new Error('REVIEWS_URL_ONLY_ADAPTER_UNAVAILABLE'), {
    code: 'REVIEWS_URL_ONLY_ADAPTER_UNAVAILABLE', receipt: { merchantId, sourceId: mapping.consumerSourceId, capability: 'reviews_photo', state: sourceEvidence.state },
  });
  const { readAuctionPhotoReviews } = await import('../adapters/auction-photo-reviews.mjs');
  const read = await readAuctionPhotoReviews({ productUrl, maxPages });
  const offeringId = `auction:product:${new URL(read.productUrl).searchParams.get('itemno')}`;
  const reviewObservations = read.reviews.map(review => ({
    id: `auction:review:${createHash('sha256').update(String(review.reviewId)).digest('hex').slice(0, 20)}`,
    offeringId, ratingValue: review.rating, publishedAt: review.publishedDate, title: null,
    body: safeReviewText(review.text), optionText: safeReviewText(review.optionText, 300),
    helpfulCount: Number.isSafeInteger(review.helpfulCount) ? review.helpfulCount : null,
    hasMedia: true, reviewerIdentity: null, sampleCompleteness: 'partial', observedAt: read.receipts[review.page - 1]?.checkedAt ?? null,
  }));
  const evidence = read.receipts.map(receipt => {
    const requestUrl = new URL('https://bamboo.auction.co.kr/Review/Review/PhotoViewerReviewList');
    requestUrl.searchParams.set('ItemNo', new URL(read.productUrl).searchParams.get('itemno'));
    requestUrl.searchParams.set('PageIndex', String(receipt.page));
    return { sourceId: mapping.consumerSourceId, requestMethod: 'GET', requestUrl: requestUrl.href,
      responseStatus: receipt.status, contentType: receipt.contentType, responseSha256: null, observedAt: receipt.checkedAt,
      browserUsed: false, cookiesSent: false, authorizationSent: false,
      pagination: { pagesRead: receipt.page, complete: false, nextPageCandidate: receipt.page + 1, stopReason: 'page_budget' } };
  });
  return { ontologyId: 'acada:cps-commerce', affiliateProgram: { id: `linkprice:${merchantId}`, merchantId, name: merchant.site_name },
    consumerSource: { sourceId: mapping.consumerSourceId, mappingState: 'explicit_merchant_id_crosswalk' },
    offering: { id: offeringId, type: 'RetailProduct', canonicalUrl: read.productUrl },
    reviewObservations, reviewCoverage: { sourceScope: 'photo_reviews_only', sampleCount: reviewObservations.length,
      complete: false, reviewerIdentity: 'omitted', bodyRetention: 'transient_output_only' },
    evidence, browserUsed: false, cookiesSent: false, authorizationSent: false,
    limits: read.limitations };
}

async function main() {
  const args = process.argv.slice(2);
  const [command, merchantId, input] = args;
  if (['export', 'coverage', 'collect', 'query'].includes(command)) {
    const { runCpsReverify } = await import('./cps-reverify.mjs');
    console.log(JSON.stringify(await runCpsReverify(args), null, 2));
    return;
  }
  if (!['map', 'search', 'product', 'reviews'].includes(command)) throw Object.assign(new Error('USAGE'), { code: 'USAGE' });
  const catalog = await liveCatalog();
  if (command === 'map') {
    const result = buildCpsCommerceMap(catalog.merchants, { checkedAt: catalog.receipt.checkedAt, sourceReceipt: safeReceipt(catalog.receipt) });
    if (args.includes('--snapshot')) {
      const date = catalog.receipt.checkedAt.slice(0, 10);
      const file = path.join(REFERENCES, `linkprice-cps-source-map-${date}.json`);
      writeFileSync(file, JSON.stringify(result, null, 2) + '\n', { flag: 'w' });
      result.snapshotPath = path.relative(path.resolve(HERE, '..'), file).replaceAll(path.sep, '/');
    }
    console.log(JSON.stringify({ ok: true, ...result }));
    return;
  }
  if (command === 'search') {
    if (!merchantId || !input) throw Object.assign(new Error('SEARCH_INPUT_INVALID'), { code: 'SEARCH_INPUT_INVALID' });
    const limit = Number(args.find(arg => arg.startsWith('--limit='))?.slice('--limit='.length)) || 40;
    const result = await searchMappedMerchant(merchantId, input, catalog, limit);
    console.log(JSON.stringify({ ok: true, ...result }));
    return;
  }
  if (!merchantId || !input) throw Object.assign(new Error('PRODUCT_INPUT_INVALID'), { code: 'PRODUCT_INPUT_INVALID' });
  if (command === 'reviews') {
    const maxPages = Number(args.find(arg => arg.startsWith('--max-pages='))?.slice('--max-pages='.length)) || 1;
    const result = await readMappedReviews(merchantId, input, catalog, maxPages);
    console.log(JSON.stringify({ ok: true, ...result, catalogReceipt: safeReceipt(catalog.receipt) }));
    return;
  }
  const merchant = catalog.merchants.find(row => row.merchant_id === merchantId);
  if (!merchant) throw Object.assign(new Error('MERCHANT_NOT_ACTIVE_CPS'), { code: 'MERCHANT_NOT_ACTIVE_CPS' });
  const result = await readCpsProductPage({ merchant, productUrl: input, includeReviewBodies: args.includes('--include-review-bodies') });
  console.log(JSON.stringify({ ok: true, ...result, catalogReceipt: safeReceipt(catalog.receipt) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const errorMessage = typeof error?.message === 'string' ? error.message
      .replace(/https?:\/\/[^\s"'`]+/g, '[URL]')
      .replace(/\b(cookie|authorization|token|secret|password)\b\s*[:=]?\s*[^\s,;]+/gi, '$1=[REDACTED]')
      .slice(0, 240) : null;
    console.log(JSON.stringify({ ok: false, code: /^[A-Z][A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : 'CPS_COMMERCE_FAILED',
      ...(error?.name ? { errorName: error.name } : {}), ...(errorMessage ? { errorMessage } : {}),
      ...(error?.receipt ? { receipt: error.receipt } : {}), ...(error?.details ? { details: error.details } : {}) }));
    process.exitCode = 2;
  });
}
