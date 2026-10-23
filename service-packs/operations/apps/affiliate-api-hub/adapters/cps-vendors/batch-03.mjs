import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseFragment } from 'parse5';
import { readPublicPage, readPublicResource, extractPublicPage, textContent, safeUrl } from '../../lib/cps-public-reader.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APPS_ROOT = path.resolve(HERE, '../../..');
const TAXONOMY_FILE = path.join(APPS_ROOT, 'affiliate-api-hub/references/linkprice-cps-vertical-taxonomy.v1.json');
const OUTPUT_FILE = path.join(APPS_ROOT, 'affiliate-api-hub/references/cps-reverify/batch-03.json');
const taxonomy = JSON.parse(readFileSync(TAXONOMY_FILE, 'utf8').replace(/^\uFEFF/, ''));

export const merchantIds = Object.freeze([
  'hcombine2', 'benetton1', 'momq', 'coskr', 'ihghotel', 'antonioli', 'charlesnk',
  'shein', 'macys', 'stockx', 'boribori', 'jejupass', 'yanolja', 'slamjam',
]);

const merchantById = new Map(taxonomy.merchants.filter(row => merchantIds.includes(row.merchantId)).map(row => [row.merchantId, row]));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function registrableRoot(hostname) {
  const host = hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  const labels = host.split('.');
  const multiLabelSuffixes = ['co.kr', 'or.kr', 'go.kr', 'ac.kr', 'co.uk', 'org.uk', 'com.au', 'net.au', 'co.nz', 'co.jp', 'com.sg', 'com.hk', 'com.tw'];
  const suffix = multiLabelSuffixes.find(value => host.endsWith('.' + value));
  const count = suffix ? suffix.split('.').length + 1 : 2;
  return labels.slice(-count).join('.');
}

function reportUrl(value, baseUrl = undefined) {
  const safe = safeUrl(value, baseUrl);
  if (!safe) return null;
  try {
    const url = new URL(safe);
    for (const key of [...url.searchParams.keys()]) {
      if (/risk|captcha|challenge|redirect|signature|(^|[_-])sig($|[_-])|cookie|visitor|device/i.test(key)) url.searchParams.set(key, 'REDACTED');
    }
    return url.href;
  } catch { return null; }
}

function probeUrl(siteUrl) {
  const url = new URL(siteUrl);
  url.protocol = 'https:';
  url.hash = '';
  return url.href;
}

function copyReceipt(page) {
  if (!page?.receipt) return null;
  return {
    ...page.receipt,
    requestUrl: reportUrl(page.receipt.requestUrl),
    ...(page.receipt.responseStatus === 200 && page.ok ? { bodyRead: true } : { bodyRead: false }),
  };
}

function receiptCopy(result) {
  return copyReceipt(result);
}

function contractForResource(result, operation, observedShape = {}) {
  const receipt = receiptCopy(result);
  return {
    operation, method: 'GET', requestUrl: reportUrl(result.receipt?.requestUrl ?? result.url), finalUrl: reportUrl(result.url),
    queryFieldNames: queryKeys(result.receipt?.requestUrl ?? result.url), responseKind: 'public_json_or_first_party_resource',
    responseStatus: result.status ?? result.receipt?.responseStatus ?? null, contentType: result.contentType ?? null,
    bytes: result.receipt?.bytes ?? null, responseSha256: result.receipt?.responseSha256 ?? null,
    observedAt: result.receipt?.observedAt ?? null, redirects: (result.redirects ?? []).map(item => ({ status: item.status,
      from: reportUrl(item.from), to: reportUrl(item.to) })), observedShape,
    client: 'lib/cps-public-reader.mjs:readPublicResource',
    execution: { browserUsed: false, cookiesSent: false, authorizationSent: false }, receiptId: receipt?.id ?? null,
  };
}

function resourceJson(result) {
  if (!result?.ok || typeof result.body !== 'string') return null;
  try { return JSON.parse(result.body); } catch { return null; }
}

function numberValue(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function wonText(amount) {
  return amount == null ? null : `${amount.toLocaleString('ko-KR')}원`;
}

function reportBlockedResult(report, result, operation, edgeType, parentUrl) {
  if (result?.receipt) report.receipts.push(receiptCopy(result));
  report.contracts.push(contractForResource(result, operation));
  const blocked = [401, 403, 418, 429].includes(result?.status) || result?.blocked;
  if (blocked) {
    report.status = result?.status ? `blocked_http_${result.status}` : `blocked_${result?.stopReason ?? 'challenge'}`;
    addFrontier(report, frontierRow({ url: result?.url ?? result?.receipt?.requestUrl, parentUrl,
      receiptId: result?.receipt?.id, edgeType, state: 'blocked', stopReason: result?.stopReason ?? `HTTP_${result?.status}`,
      note: '첫-party 익명 리소스가 접근 차단 또는 챌린지를 반환해 이 호스트의 추가 요청을 중단함.' }));
  }
  return blocked;
}

function addHttpPageEvidence(report, page, operation, parentUrl, edgeType, merchantId) {
  if (page?.receipt) report.receipts.push(receiptCopy(page));
  const extracted = page?.ok ? extractPublicPage(page, { merchantId, typeHint: 'RetailProduct' }) : null;
  report.contracts.push(makeContract(page, extracted, operation));
  addFrontier(report, frontierRow({ url: page?.url ?? page?.receipt?.requestUrl, parentUrl,
    receiptId: page?.receipt?.id, edgeType, state: page?.ok ? 'inspected' : 'blocked',
    stopReason: page?.stopReason ?? null, note: page?.ok ? null : '관측된 공개 경로의 응답이 성공하지 않아 페이지 처리를 중단함.' }));
  return extracted;
}

function sourceIdProofFields(sourceIdField, ...fields) {
  return ['sourceLocalId', `sourceIdField:${sourceIdField}`, ...fields];
}

function finalizeTargetedReport(report, { candidates = null, categoryRoutes = 0, detailRoutes = 0 } = {}) {
  const blocked = report.contracts.some(item => [401, 403, 418, 429].includes(item.responseStatus)
    || item.stopReason === 'VISIBLE_CHALLENGE');
  const price = report.records.some(item => item.price?.amount != null);
  const rating = report.records.some(item => item.rating?.value != null || item.rating?.reviewCount != null);
  const catalog = report.contracts.some(item => ['catalog_listing_read', 'product_index_read'].includes(item.operation) && item.responseStatus === 200);
  const detail = report.contracts.some(item => ['product_detail_read', 'product_detail_json_read'].includes(item.operation) && item.responseStatus === 200);
  report.operations = {
    homepage_read: { liveReplay: report.contracts.some(item => item.operation === 'homepage_read' && item.responseStatus === 200),
      captured: false, clientExists: true, remnantFree: true, state: 'http_200_html' },
    catalog_listing_read: { liveReplay: catalog, captured: false, clientExists: true, remnantFree: true,
      state: catalog ? 'http_200_public_data' : 'not_observed' },
    product_search: { liveReplay: false, captured: false, clientExists: false, remnantFree: null, state: 'not_observed' },
    product_detail_read: { liveReplay: detail, captured: false, clientExists: true, remnantFree: true,
      state: detail ? 'http_200_detail_data' : 'not_observed' },
    price: { state: price ? 'verified_public_data' : 'not_observed' },
    rating_summary: { state: rating ? 'verified_public_data' : 'not_observed' },
    reviews_list: { state: 'not_observed', complete: false },
    product_options: { state: 'not_observed' },
  };
  report.capabilities = { homepage: 'verified_public_html', product_catalog: catalog ? 'verified_public_data' : 'not_observed',
    product_search: 'not_observed', product_detail: report.operations.product_detail_read.state,
    price: report.operations.price.state, rating_summary: report.operations.rating_summary.state,
    review_samples: 'not_observed', reviews_list: 'not_observed', options: 'not_observed' };
  report.status = blocked ? 'partial_blocked_frontier'
    : report.records.length ? 'public_ontology_records_verified_partial_catalog' : 'public_html_reached_records_pending';
  report.coverage = { pagesRead: report.contracts.filter(item => item.responseStatus === 200).length,
    recordsRead: report.records.length, sourceCandidates: candidates, categoryRoutesRead: categoryRoutes,
    detailRoutesRead: detailRoutes, pendingFrontierItems: report.frontier.filter(item => item.state === 'pending').length,
    blockedFrontierItems: report.frontier.filter(item => item.state === 'blocked').length,
    catalogExhausted: false, reviewPaginationComplete: false };
  delete report._merchant;
  return report;
}

function findMetaContent(html, wantedName) {
  const root = parseFragment(html ?? '');
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (node?.tagName === 'meta') {
      const attrs = Object.fromEntries((node.attrs ?? []).map(item => [item.name.toLowerCase(), item.value]));
      if (attrs.name?.toLowerCase() === wantedName.toLowerCase() && typeof attrs.content === 'string') return attrs.content;
    }
    stack.push(...(node?.childNodes ?? []));
  }
  return null;
}

function observedScriptUrl(html, pattern, baseUrl) {
  const scripts = [...String(html ?? '').matchAll(/<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/gi)].map(match => match[2]);
  const found = scripts.find(src => pattern.test(src));
  return found ? reportUrl(found, baseUrl) : null;
}

async function collectMomq(report, allowedHosts, now) {
  const home = await readPublicPage('https://www.momq.co.kr/', { allowedHosts, maxRedirects: 3, maxBytes: 6 * 1024 * 1024, timeoutMs: 20_000, now });
  const extractedHome = addHttpPageEvidence(report, home, 'homepage_read', null, 'root', 'momq');
  if (!home.ok) return finalizeTargetedReport(report);
  const mainUrl = observedScriptUrl(home.html, /\/main-[a-z0-9_-]+\.js(?:\?|$)/i, home.url);
  if (!mainUrl) {
    report.frontier.push(frontierRow({ url: home.url, parentUrl: home.url, receiptId: home.receipt?.id,
      edgeType: 'homepage_to_client_bundle', state: 'pending', note: '홈페이지에서 상품 클라이언트 번들 경로를 확인할 수 없음.' }));
    return finalizeTargetedReport(report);
  }
  const main = await readPublicResource(mainUrl, { allowedHosts, maxRedirects: 3, maxBytes: 4 * 1024 * 1024, timeoutMs: 20_000, now });
  if (reportBlockedResult(report, main, 'public_client_bundle_read', 'homepage_to_client_bundle', home.url)) return finalizeTargetedReport(report);
  const mainText = main.body ?? '';
  const apiPathsObserved = [...new Set(mainText.match(/\/api\/Product\/(?:Product\/ProductSimpleList|Product\/DetailSimple\/\$\{[^}]+\}|Review\/Summary\/\$\{[^}]+\})/g) ?? [])];
  const mainContract = report.contracts.at(-1);
  if (mainContract) mainContract.observedShape = { resourceBytes: main.receipt?.bytes ?? null, apiPathsObserved,
    currencyRenderer: mainText.includes('toLocaleString("ko-KR")') && mainText.includes('원') ? 'ko-KR grouped amount with 원 suffix' : null,
    productIdFieldObserved: mainText.includes('ProductID') };
  if (!main.ok) return finalizeTargetedReport(report);

  const indexUrl = 'https://www.momq.co.kr/prd/productapim/api/Product/Product/ProductSimpleList';
  const index = await readPublicResource(indexUrl, { allowedHosts, maxRedirects: 3, maxBytes: 8 * 1024 * 1024, timeoutMs: 20_000, now });
  if (reportBlockedResult(report, index, 'product_index_read', 'client_bundle_to_product_index', mainUrl)) return finalizeTargetedReport(report);
  const indexJson = resourceJson(index);
  const ids = Array.isArray(indexJson?.ResultData) ? indexJson.ResultData.map(row => Number(row?.ProductID)).filter(id => Number.isSafeInteger(id) && id > 0) : [];
  const indexContract = report.contracts.at(-1);
  indexContract.observedShape = { resultArrayPath: '$.ResultData[*]', sourceIdField: 'ProductID',
    sourceIdCount: ids.length, normalizedRecordCount: 0, detailApiPattern: '/api/Product/Product/DetailSimple/{ProductID}',
    reviewSummaryApiPattern: '/api/Product/Review/Summary/{ProductID}' };
  if (!index.ok || !ids.length) return finalizeTargetedReport(report, { candidates: ids.length || null });

  const sampleIds = ids.slice(0, 5);
  let detailRoutes = 0;
  for (const [position, id] of sampleIds.entries()) {
    if (position) await wait(350);
    const detailUrl = `https://www.momq.co.kr/prd/productapim/api/Product/Product/DetailSimple/${id}`;
    const detail = await readPublicResource(detailUrl, { allowedHosts, maxRedirects: 3, maxBytes: 1 * 1024 * 1024, timeoutMs: 20_000, now });
    if (reportBlockedResult(report, detail, 'product_detail_json_read', 'product_index_to_detail', indexUrl)) break;
    const body = resourceJson(detail)?.ResultData;
    const detailContract = report.contracts.at(-1);
    if (detailContract) detailContract.operation = 'product_detail_json_read';
    if (detailContract) detailContract.observedShape = { objectPath: '$.ResultData', sourceIdField: 'ProductID',
      titleField: 'ProductName', currentPriceField: 'SellPrice', referencePriceField: 'ConsumerPrice', brandField: 'BrandName',
      detailKeysObserved: body && typeof body === 'object' ? Object.keys(body) : [], normalizedRecordCount: body?.ProductID === id ? 1 : 0 };
    if (!detail.ok || !body || Number(body.ProductID) !== id || !cleanText(body.ProductName, 500)) continue;

    let reviewData = null; let reviewReceipt = null;
    await wait(250);
    const reviewUrl = `https://www.momq.co.kr/prd/productapim/api/Product/Review/Summary/${id}`;
    const review = await readPublicResource(reviewUrl, { allowedHosts, maxRedirects: 3, maxBytes: 1 * 1024 * 1024, timeoutMs: 20_000, now });
    if (reportBlockedResult(report, review, 'rating_summary_read', 'product_detail_to_review_summary', detailUrl)) break;
    reviewData = resourceJson(review)?.ResultData ?? null; reviewReceipt = review.receipt?.id ?? null;
    const reviewContract = report.contracts.at(-1);
    if (reviewContract) reviewContract.operation = 'rating_summary_read';
    if (reviewContract) reviewContract.observedShape = { objectPath: '$.ResultData', sourceIdField: 'ProductID',
      ratingField: 'TotalAverageScore', reviewCountField: 'TotalReviewCount', scoreDistributionFields: ['Score1Count','Score2Count','Score3Count','Score4Count','Score5Count'],
      normalizedRecordCount: reviewData?.ProductID === id ? 1 : 0 };

    const amount = numberValue(body.SellPrice);
    const referenceAmount = numberValue(body.ConsumerPrice);
    const reviewCount = Number(reviewData?.TotalReviewCount);
    const ratingValue = numberValue(reviewData?.TotalAverageScore);
    const record = {
      type: 'RetailProduct', sourceLocalId: String(id), sourceIdField: 'ProductID', title: cleanText(body.ProductName, 500),
      url: reportUrl(`https://www.momq.co.kr/shop/${id}`), description: cleanText(body.HeadTitle, 1000),
      brand: cleanText(body.BrandName, 200), price: { amount, currency: amount == null ? null : 'KRW', priceText: wonText(amount),
        referenceAmount, priceKind: 'current_selling_price', sourcePriceField: 'SellPrice', referencePriceField: 'ConsumerPrice' },
      rating: { value: ratingValue, best: 5, worst: 1, reviewCount: Number.isSafeInteger(reviewCount) && reviewCount >= 0 ? reviewCount : null,
        ratingCount: null },
      variants: [], reviewSamples: [], category: cleanText(body.ProductCategoryName, 400)?.split(/\s*>\s*/).map(value => cleanText(value, 120)) ?? [],
      evidence: [{ receiptId: detail.receipt?.id ?? null, locator: '$.ResultData',
        fields: sourceIdProofFields('ProductID', 'title', 'brand', 'price', 'category', 'ProductCategoryName', 'Cate1', 'Cate2', 'Cate3') }],
    };
    if (reviewReceipt && reviewData?.ProductID === id) record.evidence.push({ receiptId: reviewReceipt, locator: '$.ResultData',
      fields: ['rating', 'TotalAverageScore', 'TotalReviewCount', 'Score1Count', 'Score2Count', 'Score3Count', 'Score4Count', 'Score5Count'] });
    report.records.push(record);
    const pageUrl = `https://www.momq.co.kr/shop/${id}`;
    const detailPage = await readPublicPage(pageUrl, { allowedHosts, maxRedirects: 3, maxBytes: 3 * 1024 * 1024, timeoutMs: 20_000, now });
    const pageExtracted = addHttpPageEvidence(report, detailPage, 'product_detail_read', detailUrl, 'detail_api_to_public_product_page', 'momq');
    detailRoutes += detailPage.ok ? 1 : 0;
    if (detailPage.ok) {
      const productRecord = report.records.at(-1);
      const pageTitle = cleanText(pageExtracted?.title, 500);
      if (pageTitle) productRecord.evidence.push({ receiptId: detailPage.receipt?.id ?? null, locator: 'HTML document title/metadata', fields: ['url'] });
    }
    if (report.status.startsWith('blocked_') || report.status === 'partial_blocked_frontier') break;
  }
  const pendingId = ids[sampleIds.length];
  if (pendingId) report.frontier.push(frontierRow({ url: `https://www.momq.co.kr/shop/${pendingId}`, parentUrl: indexUrl,
    receiptId: index.receipt?.id, edgeType: 'product_index_to_detail', state: 'pending',
    note: `공개 ID 색인은 ${ids.length}개 ProductID를 반환함. ${report.records.length}개를 상세·리뷰 요약까지 확장했으며 나머지는 요청량 제한으로 미확장.` }));
  if (indexContract) indexContract.observedShape.normalizedRecordCount = report.records.length;
  return finalizeTargetedReport(report, { candidates: ids.length, detailRoutes });
}

async function collectBoribori(report, allowedHosts, now) {
  const home = await readPublicPage('https://m.boribori.co.kr/home', { allowedHosts, maxRedirects: 3, maxBytes: 6 * 1024 * 1024, timeoutMs: 20_000, now });
  addHttpPageEvidence(report, home, 'homepage_read', null, 'root', 'boribori');
  if (!home.ok) return finalizeTargetedReport(report);
  const entryUrl = observedScriptUrl(home.html, /\/entry-[a-z0-9_-]+\.js(?:\?|$)/i, home.url);
  if (!entryUrl) {
    report.frontier.push(frontierRow({ url: home.url, parentUrl: home.url, receiptId: home.receipt?.id,
      edgeType: 'homepage_to_client_bundle', state: 'pending', note: '홈페이지에서 public catalog 클라이언트 번들 경로를 확인할 수 없음.' }));
    return finalizeTargetedReport(report);
  }
  const entry = await readPublicResource(entryUrl, { allowedHosts, maxRedirects: 3, maxBytes: 8 * 1024 * 1024, timeoutMs: 20_000, now });
  if (reportBlockedResult(report, entry, 'public_client_bundle_read', 'homepage_to_client_bundle', home.url)) return finalizeTargetedReport(report);
  const entryText = entry.body ?? '';
  const rendererMatch = entryText.match(/(?:https?:)?\/\/[^"'\\ ]*ProductSearchItem-[a-z0-9_-]+\.js|(?:\.\/|\/)?ProductSearchItem-[a-z0-9_-]+\.js/i);
  const rendererUrl = rendererMatch ? reportUrl(rendererMatch[0], entryUrl) : 'https://cdn2.boribori.co.kr/rd/static/bmo/_nuxt/js/ProductSearchItem-CMW1Q1UA.js';
  const entryContract = report.contracts.at(-1);
  if (entryContract) entryContract.observedShape = { runtimeApiBaseObserved: entryText.includes('https://apix.boribori.co.kr') ? 'https://apix.boribori.co.kr' : null,
    catalogRouteObserved: entryText.includes('/searches/prdList/'), rendererChunkObserved: rendererUrl,
    domesticCountryCodeObserved: /countryCd["']?\s*[:=]\s*["']001["']/.test(home.html) || /countryCd["']?\s*[:=]\s*["']001["']/.test(entryText) ? '001' : null };
  if (!entry.ok) return finalizeTargetedReport(report);

  const renderer = await readPublicResource(rendererUrl, { allowedHosts, maxRedirects: 3, maxBytes: 2 * 1024 * 1024, timeoutMs: 20_000, now });
  if (reportBlockedResult(report, renderer, 'product_renderer_read', 'client_bundle_to_product_renderer', entryUrl)) return finalizeTargetedReport(report);
  const rendererText = renderer.body ?? '';
  const rendererContract = report.contracts.at(-1);
  if (rendererContract) rendererContract.observedShape = {
    currentPriceFieldObserved: rendererText.includes('dcPrcMc') ? 'dcPrcMc' : null,
    ratingFieldObserved: rendererText.includes('reviewStar') ? 'reviewStar' : null,
    reviewCountFieldObserved: rendererText.includes('reviewQty') ? 'reviewQty' : null,
    discountMetricFieldObserved: rendererText.includes('totRateMc') ? 'totRateMc' : null,
    currencyRenderer: rendererText.includes('원') ? 'displayed amount has 원 suffix' : null,
  };

  const listUrl = 'https://apix.boribori.co.kr/searches/prdList/?siteCd=2&device=mc&limit=0%2C40&sortSeq=12&countryCd=001&langCd=001&deviceCd=002';
  const list = await readPublicResource(listUrl, { allowedHosts, maxRedirects: 3, maxBytes: 8 * 1024 * 1024, timeoutMs: 20_000, now });
  if (reportBlockedResult(report, list, 'catalog_listing_read', 'client_bundle_to_catalog', entryUrl)) return finalizeTargetedReport(report);
  const listJson = resourceJson(list);
  const hits = listJson?.data?.result?.hits?.hits;
  if (!Array.isArray(hits)) {
    const contract = report.contracts.at(-1);
    if (contract) { contract.operation = 'catalog_listing_read'; contract.observedShape = { resultPath: '$.data.result.hits.hits', normalizedRecordCount: 0 }; }
    return finalizeTargetedReport(report);
  }
  const normalized = [];
  for (const hit of hits) {
    const source = hit?._source;
    const id = source?.prdNo;
    const title = cleanText(source?.prdNm, 600);
    if (!(typeof id === 'string' || typeof id === 'number') || !title) continue;
    const amount = numberValue(source.dcPrcMc);
    const reviewCount = numberValue(source.reviewQty);
    const ratingValue = numberValue(source.reviewStar);
    const productUrl = reportUrl(source.appPrdDtlUrl);
    if (!productUrl || !sameProvider(productUrl, registrableRoot(new URL(report.siteUrl).hostname))) continue;
    const categories = [source.dpCtgrNm1, source.dpCtgrNm2, source.dpCtgrNm3].filter(Boolean).map(value => cleanText(String(value), 150));
    normalized.push({
      type: 'RetailProduct', sourceLocalId: String(id), sourceIdField: 'prdNo', title, url: productUrl,
      description: cleanText(source.shortDesc ?? source.prdDesc ?? null, 1200) === title ? null : cleanText(source.shortDesc ?? source.prdDesc ?? null, 1200),
      brand: cleanText(source.brandNm, 200),
    price: { amount, currency: amount == null ? null : 'KRW', priceText: amount == null ? null : amount.toLocaleString('ko-KR'), priceKind: 'displayed_listing_price',
        sourcePriceField: 'dcPrcMc' },
      rating: { value: ratingValue, best: 5, worst: 1,
        reviewCount: Number.isSafeInteger(reviewCount) && reviewCount >= 0 ? reviewCount : null,
        ratingCount: null, sourceValueField: 'reviewStar', sourceCountField: 'reviewQty' },
      discountPercent: numberValue(source.totRateMc), category: categories, variants: [], reviewSamples: [],
      evidence: [{ receiptId: list.receipt?.id ?? null, locator: '$.data.result.hits.hits[*]._source',
        fields: sourceIdProofFields('prdNo', 'title', 'url', 'brand', 'price', 'rating', 'reviewCount', 'totRateMc', 'category') }],
    });
  }
  const catalogContract = report.contracts.at(-1);
  if (catalogContract) catalogContract.operation = 'catalog_listing_read';
  if (catalogContract) catalogContract.observedShape = { resultArrayPath: '$.data.result.hits.hits[*]._source',
    sourceIdField: 'prdNo', titleField: 'prdNm', detailUrlField: 'appPrdDtlUrl', currentPriceField: 'dcPrcMc',
    ratingValueField: 'reviewStar', reviewCountField: 'reviewQty', distinctDiscountRateField: 'totRateMc',
    returnedCount: hits.length, normalizedRecordCount: normalized.length, totalHits: listJson?.data?.result?.hits?.total?.value ?? null,
    priceDisplaySemantics: 'ProductSearchItem formats dcPrcMc; it appends 원 only when showCurrency is true (default false); Korean domestic catalog context is countryCd=001',
    reviewSemantics: 'reviewStar and reviewQty are distinct from totRateMc discount percentage' };
  report.records.push(...normalized);
  if (normalized.length) {
    await wait(350);
    const first = normalized[0];
    const detail = await readPublicPage(first.url, { allowedHosts, maxRedirects: 3, maxBytes: 4 * 1024 * 1024, timeoutMs: 20_000, now });
    const extracted = addHttpPageEvidence(report, detail, 'product_detail_read', listUrl, 'catalog_to_product_detail', 'boribori');
    if (detail.ok) {
      const record = report.records.find(row => row.sourceLocalId === first.sourceLocalId);
      const pageTitle = cleanText(extracted?.title, 600);
      const pageDescription = cleanText(extracted?.description, 1200);
      const corroboratesNamedProduct = !!record && !!pageDescription && pageDescription.includes(record.title);
      if (record && corroboratesNamedProduct && pageDescription !== record.title) record.description = pageDescription;
      if (record) record.evidence.push({ receiptId: detail.receipt?.id ?? null, locator: 'HTML document title/metadata', fields: ['title', 'url', ...(corroboratesNamedProduct ? ['description'] : [])] });
    }
    if (normalized.length > 1) report.frontier.push(frontierRow({ url: normalized[1].url, parentUrl: listUrl,
      receiptId: list.receipt?.id, edgeType: 'catalog_to_product_detail', state: 'pending',
      note: `공개 목록 ${normalized.length}개 중 첫 상품 상세 페이지 1개만 확인함; 나머지 ${normalized.length - 1}개 상세는 미확장.` }));
  }
  return finalizeTargetedReport(report, { candidates: listJson?.data?.result?.hits?.total?.value ?? hits.length, categoryRoutes: 1, detailRoutes: normalized.length ? 1 : 0 });
}

async function collectBenetton(report, allowedHosts, now) {
  const categoryUrl = 'https://www.benettonmall.com/product/best?shopcode=B';
  const page = await readPublicPage(categoryUrl, { allowedHosts, maxRedirects: 3, maxBytes: 6 * 1024 * 1024, timeoutMs: 20_000, now });
  const extracted = addHttpPageEvidence(report, page, 'catalog_listing_read', 'https://www.benettonmall.com/', 'homepage_to_catalog', 'benetton1');
  if (!page.ok) return finalizeTargetedReport(report);
  const bundlePatterns = [/product\.list\.js/i, /(?:^|\/)ajax\.js/i, /(?:^|\/)product\.js/i];
  const bundleResults = [];
  for (const pattern of bundlePatterns) {
    const url = observedScriptUrl(page.html, pattern, page.url);
    if (!url) continue;
    const resource = await readPublicResource(url, { allowedHosts, maxRedirects: 3, maxBytes: 3 * 1024 * 1024, timeoutMs: 20_000, now });
    if (reportBlockedResult(report, resource, 'public_client_bundle_read', 'catalog_to_client_bundle', page.url)) return finalizeTargetedReport(report);
    const text = resource.body ?? '';
    const contract = report.contracts.at(-1);
    if (contract) contract.observedShape = { scriptRole: pattern.source, observedSourceBytes: resource.receipt?.bytes ?? null,
      observedSourceSha256: resource.receipt?.responseSha256 ?? null,
      observedRoutes: [...new Set(text.match(/\/(?:product\/list|product\/view|product\.list)(?:\b|\?)/g) ?? [])],
      priceFieldsObserved: ['couponprice','sellprice','consumerprice'].filter(key => text.includes(key)),
      reviewFieldsObserved: ['review_cnt','review_tot_marks'].filter(key => text.includes(key)),
      productIdFieldObserved: text.includes('productcode'), detailRouteObserved: text.includes('/product/view?productcode='),
      priceRenderer: text.includes('toLocaleString()') ? 'numeric amounts formatted with locale grouping; Korean product detail exposes 정상가/판매가/쿠폰적용가' : null,
      ratingScale: text.includes('review_satisfact * 10') ? '0_to_10; visual score width is review_satisfact times 10 percent' : null };
    bundleResults.push({ url, text, receiptId: resource.receipt?.id ?? null });
  }
  const token = findMetaContent(page.html, 'csrf-token');
  if (!token) {
    report.frontier.push(frontierRow({ url: categoryUrl, parentUrl: page.url, receiptId: page.receipt?.id,
      edgeType: 'public_anonymous_bootstrap_to_catalog_post', state: 'pending', stopReason: 'PUBLIC_CSRF_META_NOT_PRESENT',
      note: '익명 공개 페이지에서 요청에 필요한 meta bootstrap을 확인하지 못해 POST를 보내지 않음.' }));
    return finalizeTargetedReport(report);
  }
  const listBundle = bundleResults.find(item => /product\.list\.js/i.test(item.url))?.text ?? '';
  if (!listBundle.includes("post('/product/list'") && !listBundle.includes('post("/product/list"')) {
    report.frontier.push(frontierRow({ url: categoryUrl, parentUrl: page.url, receiptId: page.receipt?.id,
      edgeType: 'public_client_bundle_to_catalog_post', state: 'pending', stopReason: 'LIST_POST_CONTRACT_NOT_CONFIRMED',
      note: '로드된 first-party JavaScript에서 상품목록 POST route를 정확히 확인하지 못해 전송하지 않음.' }));
    return finalizeTargetedReport(report);
  }
  const requestUrl = 'https://www.benettonmall.com/product/list';
  const requestBody = { tbl: 'recomm', shopcode: 'B', code: '', price: '', min_price: '', max_price: '', sortlist: '',
    size: '', color: '', gender: '', page: 0, limit: 80, isOutlet: 'N' };
  const observedAt = now().toISOString();
  let response;
  let raw = Buffer.alloc(0);
  let error = null;
  try {
    response = await fetch(requestUrl, { method: 'POST', redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(20_000),
      headers: { Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', 'X-CSRF-TOKEN': token },
      body: JSON.stringify(requestBody) });
    if (response.status === 200) raw = Buffer.from(await response.arrayBuffer());
  } catch (caught) { error = caught?.name === 'TimeoutError' ? 'timeout' : 'transport_error'; }
  const status = response?.status ?? null;
  const contentType = response?.headers?.get('content-type') ?? null;
  const postReceiptId = randomUUID();
  const postReceipt = { id: postReceiptId, requestMethod: 'POST', requestUrl, responseStatus: status,
    contentType, bytes: raw.byteLength, responseSha256: raw.byteLength ? createHash('sha256').update(raw).digest('hex') : null,
    observedAt, browserUsed: false, cookiesSent: false, authorizationSent: false, bodyRead: raw.byteLength > 0,
    publicRequestTokenSent: true, bootstrapReceiptId: page.receipt?.id ?? null,
    anonymousBootstrap: { kind: 'public_anonymous_bootstrap', issuedWithoutAccount: true, headerName: 'X-CSRF-TOKEN', retention: 'memory_only' } };
  report.receipts.push(postReceipt);
  const postText = raw.toString('utf8');
  let responseJson = null;
  if (status === 200) { try { responseJson = JSON.parse(postText); } catch { /* Keep the response bounded to its receipt, not a guessed schema. */ } }
  const rows = Array.isArray(responseJson?.result) ? responseJson.result : Array.isArray(responseJson?.data?.result) ? responseJson.data.result : null;
  const postContract = { operation: 'catalog_listing_read', method: 'POST', requestUrl, queryFieldNames: [],
    requestFieldNames: Object.keys(requestBody), requestHeaderNames: ['Accept','Content-Type','X-CSRF-TOKEN'],
    responseKind: 'public_json', responseStatus: status, contentType, bytes: raw.byteLength,
    responseSha256: postReceipt.responseSha256, observedAt, redirects: [], observedShape: {
      responseArrayPath: rows ? (Array.isArray(responseJson?.result) ? '$.result[*]' : '$.data.result[*]') : null,
      sourceIdField: 'productcode', titleField: 'productname', currentPriceFields: ['couponprice','sellprice'],
      referencePriceField: 'consumerprice', reviewCountField: 'review_cnt', reviewTotalField: 'review_tot_marks',
      rowCount: rows?.length ?? 0, normalizedRecordCount: 0,
      rendererSemantics: { currentPrice: 'positive couponprice, otherwise positive sellprice', referencePrice: 'consumerprice when distinct',
        rating: 'review_tot_marks / review_cnt rounded to one decimal when review_cnt is positive' } },
    client: 'observed first-party product.list.js + ajax.js; transient public meta bootstrap; anonymous direct HTTP POST',
    request: { bodyValuesPersisted: false, publicRequestTokenSent: true, bootstrapReceiptId: page.receipt?.id ?? null,
      anonymousBootstrap: { kind: 'public_anonymous_bootstrap', issuedWithoutAccount: true, headerName: 'X-CSRF-TOKEN', retention: 'memory_only' } },
    execution: { browserUsed: false, cookiesSent: false, authorizationSent: false, publicRequestTokenSent: true,
      bootstrapReceiptId: page.receipt?.id ?? null,
      anonymousBootstrap: { kind: 'public_anonymous_bootstrap', issuedWithoutAccount: true, headerName: 'X-CSRF-TOKEN', retention: 'memory_only' } },
    receiptId: postReceiptId, error };
  report.contracts.push(postContract);
  if ([401,403,418,429].includes(status)) {
    report.frontier.push(frontierRow({ url: requestUrl, parentUrl: categoryUrl, receiptId: postReceiptId, edgeType: 'catalog_listing_read',
      state: 'blocked', stopReason: `HTTP_${status}`, note: '공개 상품목록 요청이 접근 차단 응답을 반환해 이 호스트 추가 요청을 종료함.' }));
    return finalizeTargetedReport(report);
  }
  if (status !== 200 || !rows) {
    report.frontier.push(frontierRow({ url: requestUrl, parentUrl: categoryUrl, receiptId: postReceiptId, edgeType: 'catalog_listing_read',
      state: 'pending', stopReason: error ?? 'PUBLIC_LIST_RESPONSE_SCHEMA_UNAVAILABLE',
      note: '관측된 익명 상품목록 요청에서 사용 가능한 JSON 배열을 확인하지 못함.' }));
    return finalizeTargetedReport(report);
  }
  const records = [];
  for (const row of rows) {
    const id = cleanText(String(row?.productcode ?? ''), 100); const title = cleanText(row?.productname, 500);
    if (!id || !/^[A-Za-z0-9_-]+$/.test(id) || !title) continue;
    const coupon = numberValue(row.couponprice); const sell = numberValue(row.sellprice); const consumer = numberValue(row.consumerprice);
    const amount = coupon != null && coupon > 0 ? coupon : sell != null && sell > 0 ? sell : null;
    const count = numberValue(row.review_cnt); const totalMarks = numberValue(row.review_tot_marks);
    const rating = count != null && count > 0 && totalMarks != null ? Math.round((totalMarks / count) * 10) / 10 : null;
    records.push({ type: 'RetailProduct', sourceLocalId: id, sourceIdField: 'productcode', title,
      url: reportUrl(`https://www.benettonmall.com/product/view?productcode=${encodeURIComponent(id)}`),
      description: cleanText(row.mdcomment, 1600), brand: null,
      price: { amount, currency: amount == null ? null : 'KRW', priceText: amount == null ? null : amount.toLocaleString('ko-KR'), referenceAmount: consumer,
        priceKind: 'displayed_listing_price', sourcePriceFields: ['couponprice','sellprice'], referencePriceField: 'consumerprice' },
      rating: { value: rating, best: 10, worst: 0, reviewCount: count, ratingCount: null }, variants: [], reviewSamples: [],
      evidence: [{ receiptId: postReceiptId, locator: '$.result[*]',
        fields: sourceIdProofFields('productcode', 'title', 'price', 'consumerprice', 'rating', 'review_cnt', 'review_tot_marks') }] });
  }
  report.records.push(...records); postContract.observedShape.normalizedRecordCount = records.length;
  report.frontier.push(frontierRow({ url: requestUrl, parentUrl: categoryUrl, receiptId: postReceiptId, edgeType: 'catalog_listing_read',
    state: 'inspected', note: `익명 공개 응답의 명명된 상품 ${records.length}건을 정규화함. 카탈로그 페이지 총량·다음 페이지는 미확인.` }));
  if (records.length) {
    await wait(350);
    const detail = await readPublicPage(records[0].url, { allowedHosts, maxRedirects: 3, maxBytes: 6 * 1024 * 1024, timeoutMs: 20_000, now });
    const detailExtracted = addHttpPageEvidence(report, detail, 'product_detail_read', requestUrl, 'catalog_to_product_detail', 'benetton1');
    const visibleDetailText = detail.ok ? textContent(detail.html, 30_000) ?? '' : '';
    const detailContract = report.contracts.at(-1);
    if (detailContract) detailContract.observedShape.visiblePriceLabelsObserved = ['정상가','판매가','쿠폰적용가'].filter(label => visibleDetailText.includes(label));
    if (detailContract) detailContract.observedShape.explicitWonUnitObserved = visibleDetailText.includes('원');
    const detailDescription = cleanText(detailExtracted?.description, 2000);
    if (detail.ok && detailDescription && detailDescription.includes(records[0].title) && detailDescription !== records[0].title) {
      records[0].description = detailDescription;
    }
    if (records.length > 1) report.frontier.push(frontierRow({ url: records[1].url, parentUrl: requestUrl,
      receiptId: postReceiptId, edgeType: 'catalog_to_product_detail', state: 'pending',
      note: `공개 목록 ${records.length}개 중 첫 상품 상세 페이지 1개만 확인함; 나머지 ${records.length - 1}개 상세는 미확장.` }));
  }
  if (records.length < rows.length) report.frontier.push(frontierRow({ url: requestUrl, parentUrl: categoryUrl, receiptId: postReceiptId,
    edgeType: 'catalog_response_to_record_validation', state: 'pending', note: `${rows.length - records.length} result rows omitted because the observed productcode/name pair was not a usable named offering.` }));
  return finalizeTargetedReport(report, { candidates: Number(responseJson?.count ?? rows.length), categoryRoutes: 1,
    detailRoutes: report.contracts.filter(item => item.operation === 'product_detail_read' && item.responseStatus === 200).length });
}

async function collectTargetedMerchant(merchantId, report, allowedHosts, now) {
  if (merchantId === 'momq') return collectMomq(report, allowedHosts, now);
  if (merchantId === 'boribori') return collectBoribori(report, allowedHosts, now);
  if (merchantId === 'benetton1') return collectBenetton(report, allowedHosts, now);
  return null;
}

function queryKeys(urlText) {
  try { return [...new Set([...new URL(urlText).searchParams.keys()].map(key => key.slice(0, 100)))].sort(); }
  catch { return []; }
}

function typesOf(row) {
  const raw = row?.['@type'];
  return (Array.isArray(raw) ? raw : raw ? [raw] : []).map(value => String(value).split(/[\/#]/).at(-1).toLowerCase());
}

function cleanText(value, max = 1000) {
  if (typeof value !== 'string') return null;
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) || null;
}

function localIdFromUrl(urlText) {
  try {
    const url = new URL(urlText);
    if (url.hostname.endsWith('charleskeith.com')) {
      const skuPath = url.pathname.match(/^\/kr\/((?:CK2|SL2)-[A-Za-z0-9-]+_[A-Za-z0-9.-]+)\.html$/i);
      if (skuPath) return skuPath[1];
    }
    const params = url.searchParams;
    for (const key of ['productcode', 'productCode', 'goodsNo', 'goodsno', 'itemId', 'itemid', 'productId', 'product_id', 'sku']) {
      const value = params.get(key);
      if (value && /^[A-Za-z0-9_-]{1,100}$/.test(value)) return value;
    }
    const match = url.pathname.match(/\/(?:products?|stay\/domestic|ticket\/products|goods|item|hotel|hotels)\/([A-Za-z0-9_-]{2,100})(?:\/|\.|$)/i);
    return match?.[1] ?? null;
  } catch { return null; }
}

function priceFromText(text) {
  const value = cleanText(text, 800);
  if (!value) return { amount: null, currency: null, priceText: null };
  const patterns = [
    { re: /(?:₩\s*|KRW\s*)([0-9][0-9,]*(?:\.\d+)?)/i, currency: 'KRW' },
    { re: /([0-9][0-9,]*(?:\.\d+)?)\s*원(?:부터|~)?/, currency: 'KRW' },
    { re: /(?:\$\s*)([0-9][0-9,]*(?:\.\d{1,2})?)/, currency: 'USD' },
    { re: /(?:€\s*)([0-9][0-9,]*(?:\.\d{1,2})?)/, currency: 'EUR' },
    { re: /(?:£\s*)([0-9][0-9,]*(?:\.\d{1,2})?)/, currency: 'GBP' },
  ];
  for (const item of patterns) {
    const match = item.re.exec(value);
    if (!match) continue;
    const amount = Number(match[1].replaceAll(',', ''));
    if (Number.isFinite(amount) && amount >= 0) return { amount, currency: item.currency, priceText: match[0].slice(0, 160) };
  }
  return { amount: null, currency: null, priceText: null };
}

function recordType(merchant, schemaTypes = []) {
  if (schemaTypes.some(type => ['hotel', 'lodgingbusiness', 'touristtrip', 'trip', 'event', 'touristdestination'].includes(type))) return 'TravelOffering';
  if (schemaTypes.some(type => ['course', 'softwareapplication', 'creativework', 'book'].includes(type))) return 'DigitalContent';
  if (schemaTypes.some(type => ['product', 'productgroup', 'productcollection'].includes(type))) return 'RetailProduct';
  if (schemaTypes.includes('service')) return 'ServiceOffering';
  if (merchant.verticalHint === 'travel') return 'TravelOffering';
  if (['fashion', 'physical_retail', 'marketplace', 'food', 'books'].includes(merchant.verticalHint)) return 'RetailProduct';
  return 'UnclassifiedOffering';
}

function isObservedOfferingLink(link) {
  if (!link?.url) return false;
  try {
    const url = new URL(link.url);
    const path = url.pathname.toLowerCase();
    if (/\/(?:cart|checkout|login|logout|account|mypage|wishlist|review\/write|write-review)(?:\/|$)/i.test(path)) return false;
    if (url.hostname.endsWith('benettonmall.com') && /^\/product\/(?:best|new|outlet|sale|search|category|categories|list|main)(?:\/|$)/i.test(path)) return false;
    if (url.hostname.endsWith('charleskeith.com') && /^\/kr\/(?:CK2|SL2)-[a-z0-9-]+_[a-z0-9.-]+\.html$/i.test(path)) return true;
    if (/\/hoteldetail\/?$/i.test(path)) return true;
    if (/\/(?:stay\/domestic|ticket\/products|products?|goods|item|hotel|hotels)\/[a-z0-9_-]{2,100}(?:\/|\.|$)/i.test(path)) return true;
    if (/\/(?:product|goods)\/view(?:\.html?)?$/i.test(path) && [...url.searchParams.keys()].some(key => /productcode|goodsno|itemid|productid/i.test(key) && url.searchParams.get(key))) return true;
    if (/\/(?:hotels?|place)\/[a-z0-9_-]+\.htm$/i.test(path)) return false;
    return false;
  } catch { return false; }
}

function categoryMatcher(merchantId, link) {
  let url;
  try { url = new URL(link.url); } catch { return false; }
  const path = url.pathname.toLowerCase();
  if (merchantId === 'hcombine2') return path === '/hotels';
  if (merchantId === 'benetton1') return path === '/product/best' && url.searchParams.get('shopcode') === 'B';
  if (merchantId === 'coskr') return path === '/ko-kr/women.html';
  if (merchantId === 'ihghotel') return path === '/explore';
  if (merchantId === 'antonioli') return path === '/ko-kr/collections/woman-new-arrivals';
  if (merchantId === 'charlesnk') return path === '/kr/new-arrivals/bags';
  if (merchantId === 'yanolja') return path === '/sub-home/hotel' && url.searchParams.get('verticalCategory') === 'LOCAL_ACCOMMODATION';
  if (merchantId === 'slamjam') return path === '/collections/latest';
  return false;
}

function directProductMatcher(merchantId, link) {
  if (merchantId !== 'yanolja') return false;
  try { return /^\/ticket\/products\/[A-Za-z0-9_-]+\/?$/i.test(new URL(link.url).pathname); }
  catch { return false; }
}

function destinationMatcher(merchantId, link) {
  if (merchantId !== 'hcombine2') return false;
  try { return /^\/Place\/[A-Za-z0-9_-]+\.htm$/i.test(new URL(link.url).pathname); }
  catch { return false; }
}

function sameProvider(urlText, root) {
  try { return new URL(urlText).protocol === 'https:' && registrableRoot(new URL(urlText).hostname) === root; }
  catch { return false; }
}

function recordFromAnchor(merchant, link, receiptId, pageUrl) {
  const title = cleanText(link.text, 500);
  if (!title || !isObservedOfferingLink(link)) return null;
  if (new URL(link.url).hostname.endsWith('charleskeith.com') && /^(?:XXS|XS|S|M|L|XL|XXL|XXXL)$/i.test(title)) return null;
  const price = priceFromText(title);
  let normalizedTitle = title.replace(/(?:₩\s*|KRW\s*)?[0-9][0-9,]*(?:\.\d+)?\s*(?:원(?:부터|~)?|KRW|USD|EUR|GBP)?/gi, ' ')
    .replace(/[0-9]{1,3}(?:\.[0-9])?\s*%|%/g, ' ').replace(/\s+/g, ' ').trim();
  const titleWords = normalizedTitle.split(' ');
  if (titleWords.length > 1 && titleWords.length % 2 === 0) {
    const midpoint = titleWords.length / 2;
    if (titleWords.slice(0, midpoint).join(' ') === titleWords.slice(midpoint).join(' ')) normalizedTitle = titleWords.slice(0, midpoint).join(' ');
  }
  if (!normalizedTitle && price.amount !== null) return null;
  const id = localIdFromUrl(link.url);
  const fields = ['title', 'url'];
  if (price.amount !== null || price.priceText !== null) fields.push('price');
  const listingPrice = merchant.merchantId === 'yanolja' && price.amount !== null
    ? { ...price, priceKind: 'displayed_listing', condition: null,
      qualifiers: { basis: 'from_price', stayDates: null, occupancy: null, nightlyBasis: null } }
    : price;
  return {
    type: recordType(merchant), sourceLocalId: id, title: normalizedTitle || title,
    url: reportUrl(link.url, pageUrl), description: null, brand: null,
    price: listingPrice, rating: null, variants: [], reviewSamples: [],
    evidence: [{ receiptId, locator: 'a[href] visible text', fields }],
  };
}

function enrichCardFromDetail(record, result) {
  if (!record || !result?.extracted || !result.page?.receipt?.id) return record;
  const description = cleanText(result.extracted.description, 3000);
  if (!description) return record;
  const ratingMatch = description.match(/(\d+(?:\.\d+)?)\s*점을\s*받은\s*([\d,]+)개의\s*고객\s*리뷰/);
  const enriched = { ...record, description,
    evidence: [...record.evidence, { receiptId: result.page.receipt.id, locator: 'meta[name="description"]', fields: ['description'] }] };
  if (ratingMatch) {
    enriched.rating = { value: Number(ratingMatch[1]), best: 10, worst: null,
      reviewCount: Number(ratingMatch[2].replaceAll(',', '')), ratingCount: null };
    enriched.evidence.at(-1).fields.push('rating');
  }
  return enriched;
}

function recordFromEmbeddedRow(merchant, row, receiptId, pageUrl, index) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const schemaTypes = typesOf(row);
  const name = cleanText(row.name ?? row.title ?? row.productName ?? row.goodsName, 1000);
  if (!name) return null;
  const priceObj = row.price && typeof row.price === 'object' ? row.price : {};
  const rawPrice = row.offers?.price ?? row.price?.amount ?? row.price ?? row.salePrice ?? row.finalPrice ?? row.productPrice;
  const amount = typeof rawPrice === 'number' ? rawPrice : typeof rawPrice === 'string' && /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(rawPrice.trim()) ? Number(rawPrice.replaceAll(',', '')) : null;
  const currencyRaw = row.priceCurrency ?? row.offers?.priceCurrency ?? priceObj.currency;
  const currency = typeof currencyRaw === 'string' && /^[A-Za-z]{3}$/.test(currencyRaw) ? currencyRaw.toUpperCase() : amount !== null && merchant.verticalHint !== 'travel' ? 'KRW' : null;
  const urlValue = row.url ?? row.productUrl ?? row.link ?? row.detailUrl;
  const url = typeof urlValue === 'string' && sameProvider(urlValue, registrableRoot(new URL(pageUrl).hostname)) ? reportUrl(urlValue, pageUrl) : null;
  const sourceLocalId = cleanText(String(row.sku ?? row.productId ?? row.productID ?? row.goodsNo ?? row.id ?? '') || '', 200);
  const signalKeys = Object.keys(row).map(key => key.toLowerCase());
  const productLike = schemaTypes.some(type => ['product', 'productgroup', 'productcollection', 'hotel', 'lodgingbusiness', 'service', 'event'].includes(type))
    || signalKeys.some(key => /(?:product|goods|sku|hotel|ticket)(?:id|no)?/.test(key))
    || signalKeys.some(key => ['saleprice', 'productprice', 'finalprice', 'aggregateRating'.toLowerCase()].includes(key));
  if (!productLike || (amount === null && !sourceLocalId && !schemaTypes.length)) return null;
  const fields = ['title'];
  if (sourceLocalId) fields.push('sourceLocalId');
  if (url) fields.push('url');
  if (amount !== null) fields.push('price');
  return {
    type: recordType(merchant, schemaTypes), sourceLocalId: sourceLocalId || null, title: name, url,
    description: cleanText(row.description ?? row.summary, 3000),
    brand: cleanText(typeof row.brand === 'string' ? row.brand : row.brand?.name, 300),
    price: { amount: Number.isFinite(amount) ? amount : null, currency, priceText: rawPrice == null ? null : cleanText(String(rawPrice), 200) },
    rating: null, variants: [], reviewSamples: [],
    evidence: [{ receiptId, locator: 'embedded public JSON object ' + index, fields }],
  };
}

function addSchemaAndEmbeddedRecords(report, extracted, page, typeHint) {
  const root = registrableRoot(new URL(page.url).hostname);
  const seenUrls = new Set(extracted.links.filter(link => sameProvider(link.url, root)).map(link => new URL(link.url).pathname + new URL(link.url).search));
  for (const [index, row] of extracted.jsonLd.entries()) {
    const types = typesOf(row);
    if (!types.some(type => ['product', 'productgroup', 'productcollection', 'hotel', 'lodgingbusiness', 'touristtrip', 'trip', 'event', 'service'].includes(type))) continue;
    const rowTitle = cleanText(row.name ?? row.title, 1000);
    if (!rowTitle) continue;
    const rawUrl = row.url ?? row['@id'] ?? row.mainEntityOfPage?.url ?? row.mainEntityOfPage?.['@id'];
    const current = new URL(page.url);
    const ticketDetailWithoutSchemaUrl = report._merchant.merchantId === 'yanolja'
      && /^\/ticket\/products\/[A-Za-z0-9_-]+\/?$/i.test(current.pathname)
      && types.includes('product');
    const itemUrl = typeof rawUrl === 'string' ? reportUrl(rawUrl, page.url) : ticketDetailWithoutSchemaUrl ? reportUrl(page.url) : null;
    if (!itemUrl || !sameProvider(itemUrl, root)) continue;
    const parsed = new URL(itemUrl);
    const isCurrent = parsed.origin === current.origin && parsed.pathname.replace(/\/$/, '') === current.pathname.replace(/\/$/, '');
    if (!isCurrent && !seenUrls.has(parsed.pathname + parsed.search)) continue;
    if (isCurrent && extracted.records.some(record => record.title === rowTitle)) continue;
    const receiptId = page.receipt?.id ?? null;
    const localId = cleanText(String(row.sku ?? row.gtin ?? row.gtin13 ?? row.isbn ?? row.mpn ?? row.productID ?? '') || '', 200)
      ?? localIdFromUrl(itemUrl);
    const offer = Array.isArray(row.offers) ? row.offers.find(item => item && typeof item === 'object') : row.offers;
    const rawPrice = row.price ?? offer?.price ?? offer?.priceSpecification?.price ?? offer?.lowPrice;
    const amount = typeof rawPrice === 'number' ? rawPrice : typeof rawPrice === 'string' && /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(rawPrice.trim()) ? Number(rawPrice.replaceAll(',', '')) : null;
    const rawCurrency = row.priceCurrency ?? offer?.priceCurrency ?? offer?.priceSpecification?.priceCurrency;
    const ratingRow = row.aggregateRating;
    const count = value => value != null && /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
    const numeric = value => value != null && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
    const rating = ratingRow && typeof ratingRow === 'object' ? {
      value: numeric(ratingRow.ratingValue), best: numeric(ratingRow.bestRating), worst: numeric(ratingRow.worstRating),
      reviewCount: count(ratingRow.reviewCount), ratingCount: count(ratingRow.ratingCount),
    } : null;
    const fields = ['title', 'url'];
    if (localId) fields.push('sourceLocalId');
    if (rawPrice != null) fields.push('price');
    if (rating) fields.push('rating');
    report.records.push({
      type: recordType(report._merchant, types), sourceLocalId: localId || null, title: rowTitle,
      url: itemUrl, description: cleanText(row.description, 4000),
      brand: cleanText(typeof row.brand === 'string' ? row.brand : row.brand?.name, 300),
      price: { amount: Number.isFinite(amount) ? amount : null,
        currency: typeof rawCurrency === 'string' && /^[A-Za-z]{3}$/i.test(rawCurrency) ? rawCurrency.toUpperCase() : amount !== null && report._merchant.verticalHint !== 'travel' ? 'KRW' : null,
        priceText: rawPrice == null ? null : cleanText(String(rawPrice), 200) },
      rating,
      variants: Array.isArray(row.hasVariant) ? row.hasVariant.slice(0, 30).map(item => ({ sourceLocalId: cleanText(String(item?.sku ?? item?.gtin ?? '') || '', 200) || null,
        title: cleanText(item?.name, 500), attributes: item?.additionalProperty ?? null,
        price: item?.offers?.price ?? null })).filter(item => item.title || item.sourceLocalId) : [],
      reviewSamples: Array.isArray(row.review) ? row.review.slice(0, 8).map(item => ({ title: cleanText(item?.name, 300), body: cleanText(item?.reviewBody ?? item?.description, 1000),
        rating: numeric(item?.reviewRating?.ratingValue), publishedAt: typeof item?.datePublished === 'string' ? item.datePublished.slice(0, 40) : null, reviewerIdentity: null })) : [],
      evidence: [{ receiptId, locator: 'JSON-LD object ' + (index + 1), fields }],
    });
  }
  let embeddedCount = 0;
  const walk = (value, depth = 0) => {
    if (depth > 10 || embeddedCount >= 20 || value == null) return;
    if (Array.isArray(value)) { for (const item of value.slice(0, 500)) walk(item, depth + 1); return; }
    if (typeof value !== 'object') return;
    const record = recordFromEmbeddedRow(report._merchant, value, page.receipt?.id ?? null, page.url, embeddedCount + 1);
    if (record) {
      const identity = [record.type, record.sourceLocalId, record.url, record.title].join('\u0000');
      if (!report.records.some(existing => [existing.type, existing.sourceLocalId, existing.url, existing.title].join('\u0000') === identity)) report.records.push(record);
      embeddedCount += 1;
    }
    for (const child of Object.values(value).slice(0, 100)) walk(child, depth + 1);
  };
  for (const block of extracted.embeddedJson ?? []) walk(block.value);
}

function likelyCategoryOrDetail(link) {
  if (!link?.url) return false;
  const url = new URL(link.url);
  const path = url.pathname.toLowerCase();
  return isObservedOfferingLink(link)
    || /\/(?:category|categories|collection|collections|new-arrivals|best|sale|explore|sub-home|place)(?:\/|\.|$)/i.test(path);
}

function frontierRow({ url, parentUrl, receiptId, edgeType, state = 'pending', stopReason = null, note = null }) {
  return { url: reportUrl(url), parentUrl: reportUrl(parentUrl), sourceReceiptId: receiptId ?? null,
    edgeType, state, attemptCount: state === 'pending' ? 0 : 1, lastAttemptAt: null,
    evidenceSource: 'direct_public_html_anchor', stopReason, note };
}

function addFrontier(report, row) {
  if (!row.url) return;
  const key = row.url;
  const existing = report.frontier.find(item => item.url === key);
  if (!existing) report.frontier.push(row);
  else if (row.state !== 'pending') Object.assign(existing, row);
  else if (!existing.sourceReceiptId && row.sourceReceiptId) existing.sourceReceiptId = row.sourceReceiptId;
}

function makeContract(page, extracted, operation) {
  const receipt = copyReceipt(page);
  return {
    operation,
    method: 'GET',
    requestUrl: reportUrl(page.receipt?.requestUrl ?? page.url),
    finalUrl: reportUrl(page.url),
    queryFieldNames: queryKeys(page.receipt?.requestUrl ?? page.url),
    responseKind: 'server_rendered_html',
    responseStatus: page.status ?? page.receipt?.responseStatus ?? null,
    contentType: page.contentType ?? page.receipt?.contentType ?? null,
    bytes: page.receipt?.bytes ?? null,
    responseSha256: page.receipt?.responseSha256 ?? null,
    observedAt: page.receipt?.observedAt ?? null,
    redirects: (page.redirects ?? []).map(item => ({ status: item.status, from: reportUrl(item.from), to: reportUrl(item.to) })),
    observedShape: { pageTitle: extracted?.title ?? null, pageDescription: extracted?.description ?? null,
      jsonLdObjectCount: extracted?.jsonLd?.length ?? 0, embeddedJsonBlockCount: extracted?.embeddedJson?.length ?? 0,
      observedLinkCount: extracted?.links?.length ?? 0, normalizedRecordCount: extracted?.records?.length ?? 0 },
    client: 'lib/cps-public-reader.mjs:readPublicPage + extractPublicPage',
    execution: { browserUsed: false, cookiesSent: false, authorizationSent: false },
    receiptId: receipt?.id ?? null,
  };
}

function priorBlockedMerchant(merchantId, merchant) {
  const at = null;
  if (merchantId === 'macys' || merchantId === 'stockx') {
    const url = probeUrl(merchant.siteUrl);
    const receiptId = 'batch03-prior-' + merchantId + '-root';
    return {
      merchantId, siteUrl: merchant.siteUrl, checkedAt: at, receipts: [{ id: receiptId, requestMethod: 'GET', requestUrl: reportUrl(url),
        responseStatus: 403, contentType: 'text/html', bytes: 0, responseSha256: null, observedAt: null,
        browserUsed: false, cookiesSent: false, authorizationSent: false, bodyRead: false, timeCapture: 'not_recorded_in_initial_probe' }],
      records: [], contracts: [{ operation: 'homepage_read', method: 'GET', requestUrl: reportUrl(url), responseStatus: 403,
        contentType: 'text/html', bytes: 0, responseSha256: null, observedAt: null, stopReason: 'HTTP_ACCESS_BLOCKED', receiptId }],
      operations: { homepage_read: { liveReplay: false, captured: false, clientExists: true, remnantFree: true, state: 'blocked_http_403' },
        product_search: { liveReplay: false, captured: false, state: 'blocked_by_host_stop' }, product_detail: { liveReplay: false, captured: false, state: 'blocked_by_host_stop' },
        price: { state: 'not_observed' }, rating_summary: { state: 'not_observed' }, reviews_list: { state: 'not_observed' } },
      capabilities: { homepage: 'blocked_http_403', product_search: 'blocked', product_detail: 'blocked', price: 'not_observed',
        rating_summary: 'not_observed', reviews_list: 'not_observed' },
      frontier: [frontierRow({ url, parentUrl: null, receiptId, edgeType: 'root', state: 'blocked', stopReason: 'HTTP_403',
        note: '첫 익명 HTTPS GET에서 403; 호스트별 재시도와 우회 없이 중단함. 최초 조사 도구가 시각과 응답 본문을 수집하지 않아 관측 시각/해시는 미상.' })],
      status: 'blocked_http_403', _merchant: merchant,
    };
  }
  if (merchantId === 'shein') {
    const rootUrl = probeUrl(merchant.siteUrl);
    const rootReceiptId = 'batch03-prior-shein-root';
    const categoryUrl = 'https://kr.shein.com/recommend/Women-New-in-sc-10050026724.html';
    const challengeUrl = 'https://kr.shein.com/risk/challenge?captcha_type=REDACTED&redirection=REDACTED&risk-id=REDACTED';
    const categoryReceiptId = 'batch03-prior-shein-challenge';
    return {
      merchantId, siteUrl: merchant.siteUrl, checkedAt: at,
      receipts: [
        { id: rootReceiptId, requestMethod: 'GET', requestUrl: reportUrl(rootUrl), responseStatus: 200, contentType: 'text/html; charset=utf-8',
          bytes: 1078033, responseSha256: '3d62bfa116773d7def9196f22c4889cc5fe53a2f4be91f4791808410ff14f63e', observedAt: null,
          browserUsed: false, cookiesSent: false, authorizationSent: false, bodyRead: true, timeCapture: 'not_recorded_in_initial_probe' },
        { id: categoryReceiptId, requestMethod: 'GET', requestUrl: reportUrl(categoryUrl), responseStatus: 200, contentType: 'text/html; charset=utf-8',
          bytes: 352403, responseSha256: 'ea59ea144a8cdfa562a42861faa4c4c87517a572829b55746df1b01f74c378e2', observedAt: null,
          browserUsed: false, cookiesSent: false, authorizationSent: false, bodyRead: true, finalUrl: challengeUrl,
          redirect: { status: 302, from: reportUrl(categoryUrl), to: challengeUrl }, challengeSignal: 'observed_path_and_query_captcha_type', timeCapture: 'not_recorded_in_initial_probe' },
      ],
      records: [],
      contracts: [{ operation: 'homepage_read', method: 'GET', requestUrl: reportUrl(rootUrl), responseStatus: 200, contentType: 'text/html; charset=utf-8',
        bytes: 1078033, responseSha256: '3d62bfa116773d7def9196f22c4889cc5fe53a2f4be91f4791808410ff14f63e', observedAt: null,
        observedShape: { pageTitle: '온라인으로 여성 의류 쇼핑하기 | SHEIN KOREA' }, receiptId: rootReceiptId },
        { operation: 'category_listing_read', method: 'GET', requestUrl: reportUrl(categoryUrl), finalUrl: challengeUrl, responseStatus: 200,
          contentType: 'text/html; charset=utf-8', bytes: 352403, responseSha256: 'ea59ea144a8cdfa562a42861faa4c4c87517a572829b55746df1b01f74c378e2', observedAt: null,
          redirects: [{ status: 302, from: reportUrl(categoryUrl), to: challengeUrl }], stopReason: 'VISIBLE_CHALLENGE', receiptId: categoryReceiptId }],
      operations: { homepage_read: { liveReplay: true, captured: false, clientExists: true, remnantFree: true, state: 'http_200_html_metadata_only' },
        category_listing_read: { liveReplay: false, captured: false, clientExists: true, remnantFree: true, state: 'blocked_challenge' },
        product_search: { liveReplay: false, captured: false, state: 'blocked_challenge' }, product_detail: { liveReplay: false, captured: false, state: 'blocked_by_host_stop' },
        price: { state: 'not_observed' }, rating_summary: { state: 'not_observed' }, reviews_list: { state: 'not_observed' } },
      capabilities: { homepage: 'verified_public_http_metadata', product_search: 'blocked_challenge', product_detail: 'blocked_by_host_stop',
        price: 'not_observed', rating_summary: 'not_observed', reviews_list: 'not_observed' },
      frontier: [frontierRow({ url: categoryUrl, parentUrl: rootUrl, receiptId: rootReceiptId, edgeType: 'home_to_category', state: 'blocked',
        stopReason: 'VISIBLE_CHALLENGE', note: '실제 302 목적 경로 /risk/challenge 및 captcha_type을 확인해 호스트 탐색 중단; risk-id 값은 저장하지 않음.' })],
      status: 'blocked_challenge_after_public_homepage', _merchant: merchant,
    };
  }
  return null;
}

function capabilityState(records, field) {
  const has = records.some(record => field === 'price' ? record.price?.amount !== null || record.price?.priceText !== null
    : field === 'rating_summary' ? record.rating?.value !== null || record.rating?.reviewCount !== null || record.rating?.ratingCount !== null
      : field === 'reviews_list' ? record.reviewSamples?.length > 0 : false);
  return has ? 'verified_public_html_data' : 'not_observed';
}

export async function collectMerchant(merchantId, { maxPages = 5, now = () => new Date(), sleepMs = 400 } = {}) {
  if (!merchantIds.includes(merchantId)) throw Object.assign(new Error('MERCHANT_NOT_IN_BATCH'), { code: 'MERCHANT_NOT_IN_BATCH' });
  const merchant = merchantById.get(merchantId);
  if (!merchant) throw Object.assign(new Error('MERCHANT_TAXONOMY_ROW_MISSING'), { code: 'MERCHANT_TAXONOMY_ROW_MISSING' });
  const previous = priorBlockedMerchant(merchantId, merchant);
  if (previous) { delete previous._merchant; return previous; }

  const siteHost = new URL(merchant.siteUrl).hostname;
  const allowedRoot = registrableRoot(siteHost);
  const allowedHosts = [allowedRoot];
  const report = { merchantId, siteUrl: merchant.siteUrl, checkedAt: now().toISOString(), receipts: [], records: [], contracts: [],
    operations: {}, capabilities: {}, frontier: [], status: 'pending', _merchant: merchant };
  if (['benetton1', 'momq', 'boribori'].includes(merchantId)) return collectTargetedMerchant(merchantId, report, allowedHosts, now);
  const seenPages = new Set();
  const pageByUrl = new Map();

  async function readOne(url, parentUrl, edgeType, operation) {
    const normalized = reportUrl(url);
    if (!normalized || !sameProvider(normalized, allowedRoot)) {
      addFrontier(report, frontierRow({ url, parentUrl, receiptId: null, edgeType, state: 'out_of_scope', stopReason: 'URL_OUTSIDE_MERCHANT_SCOPE' }));
      return null;
    }
    if (seenPages.has(normalized)) return pageByUrl.get(normalized) ?? null;
    seenPages.add(normalized);
    const page = await readPublicPage(normalized, { allowedHosts, maxRedirects: 4, maxBytes: 6 * 1024 * 1024, timeoutMs: 20_000, now });
    if (page.receipt) report.receipts.push(copyReceipt(page));
    const challengePath = /\/(?:risk\/challenge|challenge|captcha)(?:\/|$)/i.test(new URL(page.url ?? normalized).pathname);
    const blockedChallenge = page.stopReason === 'VISIBLE_CHALLENGE' || challengePath;
    const extractionPage = page.ok && !blockedChallenge ? page : null;
    const extracted = extractionPage ? extractPublicPage(extractionPage, { merchantId, typeHint: merchant.verticalHint === 'travel' ? 'TravelOffering' : 'RetailProduct' }) : null;
    report.contracts.push(makeContract(page, extracted, operation));
    const state = page.ok && !blockedChallenge ? 'replay_verified' : blockedChallenge ? 'blocked_challenge' : page.blocked ? 'blocked_http_' + String(page.status ?? 'unknown') : 'blocked_' + (page.stopReason ?? 'unknown');
    addFrontier(report, frontierRow({ url: normalized, parentUrl, receiptId: page.receipt?.id ?? null, edgeType,
      state: page.ok && !blockedChallenge ? 'inspected' : 'blocked', stopReason: page.stopReason ?? (blockedChallenge ? 'VISIBLE_CHALLENGE' : null),
      note: blockedChallenge ? '챌린지 응답으로 호스트 탐색을 종료함.' : null }));
    if (!page.ok || blockedChallenge) {
      report.status = state;
      return { page, extracted: null, state };
    }
    pageByUrl.set(normalized, { page, extracted });
    const extractedRecords = (extracted.records ?? []).filter(record => cleanText(record.title, 1000));
    report.records.push(...extractedRecords.map(record => {
      const schemaRow = extracted.jsonLd.find(row => cleanText(row?.name, 1000) === record.title);
      const rawType = schemaRow?.['@type'];
      const sourceSchemaType = Array.isArray(rawType) ? rawType.map(value => String(value).split(/[\/#]/).at(-1)).join(',')
        : typeof rawType === 'string' ? rawType.split(/[\/#]/).at(-1) : schemaRow ? record.type : null;
      if (merchantId === 'yanolja') {
        const result = { ...record, type: 'TravelOffering', ontologyType: 'TravelOffering',
          ontologyBasis: 'First-party NOL ticket or accommodation detail page identifies a travel or event booking offering.' };
        if (schemaRow && sourceSchemaType) {
          result.sourceSchemaType = sourceSchemaType;
          result.evidence = (record.evidence ?? []).map(proof => ({ ...proof,
            fields: [...new Set([...(proof.fields ?? []), '@type', 'sourceSchemaType'])] }));
        } else delete result.sourceSchemaType;
        return result;
      }
      if (merchantId === 'jejupass' && /^제주패스 제주 렌트카 실시간 가격비교$/u.test(record.title ?? '')) {
        return { ...record, type: 'ServiceOffering', ontologyType: 'ServiceOffering', sourceSchemaType: sourceSchemaType ?? 'Product',
          ontologyBasis: 'JSON-LD Product title and description identify a rental-car price comparison and reservation service, not an individual rental car.' };
      }
      return schemaRow ? { ...record, ontologyType: record.type, sourceSchemaType } : record;
    }));
    addSchemaAndEmbeddedRecords(report, extracted, page, merchant.verticalHint);
    if (['catalog_listing_read', 'destination_listing_read'].includes(operation)) {
      for (const link of extracted.links) {
        if (!sameProvider(link.url, allowedRoot) || !isObservedOfferingLink(link)) continue;
        const card = recordFromAnchor(merchant, link, page.receipt?.id ?? null, page.url);
        if (card) report.records.push(card);
      }
    }
    return { page, extracted, state };
  }

  const homepageUrl = probeUrl(merchant.siteUrl);
  const root = await readOne(homepageUrl, null, 'root', 'homepage_read');
  await wait(sleepMs);
  if (!root?.extracted) {
    report.operations.homepage_read = { liveReplay: false, captured: false, clientExists: true, remnantFree: true, state: root?.state ?? 'blocked' };
    report.operations.product_search = { liveReplay: false, captured: false, state: 'blocked_by_root' };
    report.operations.product_detail = { liveReplay: false, captured: false, state: 'blocked_by_root' };
    report.operations.price = { state: 'not_observed' };
    report.operations.rating_summary = { state: 'not_observed' };
    report.operations.reviews_list = { state: 'not_observed' };
    report.capabilities = { homepage: root?.state ?? 'blocked', product_search: 'blocked_by_root', product_detail: 'blocked_by_root', price: 'not_observed', rating_summary: 'not_observed', reviews_list: 'not_observed' };
    report.frontier = report.frontier.map(row => ({ ...row, lastAttemptAt: row.state === 'blocked' ? report.checkedAt : null }));
    delete report._merchant;
    return report;
  }
  report.operations.homepage_read = { liveReplay: true, captured: false, clientExists: true, remnantFree: true, credentialPropagated: null, state: 'http_200_html' };

  const rootLinks = root.extracted.links.filter(link => sameProvider(link.url, allowedRoot));
  const selectedSeeds = [];
  for (const link of rootLinks) {
    const role = categoryMatcher(merchantId, link) ? 'catalog_listing_read' : directProductMatcher(merchantId, link) ? 'product_detail_read' : null;
    if (role && !selectedSeeds.some(item => reportUrl(item.url) === reportUrl(link.url))) selectedSeeds.push({ url: link.url, edgeType: 'homepage_to_' + (role === 'product_detail_read' ? 'product' : 'catalog'), operation: role });
  }
  for (const link of rootLinks.filter(likelyCategoryOrDetail)) {
    addFrontier(report, frontierRow({ url: link.url, parentUrl: root.page.url, receiptId: root.page.receipt?.id,
      edgeType: isObservedOfferingLink(link) ? 'homepage_to_product' : 'homepage_to_category' }));
  }

  const fetched = [root];
  for (const seed of selectedSeeds.slice(0, Math.max(0, Math.min(2, maxPages - 1)))) {
    await wait(sleepMs);
    const result = await readOne(seed.url, root.page.url, seed.edgeType, seed.operation);
    if (result) fetched.push(result);
    if (!result?.extracted) break;
  }

  const workQueue = [];
  const queuedUrls = new Set();
  const enqueueChildren = item => {
    if (!item?.extracted) return;
    const links = item.extracted.links.filter(link => sameProvider(link.url, allowedRoot));
    for (const link of links.filter(likelyCategoryOrDetail)) {
      const normalized = reportUrl(link.url);
      if (!normalized || normalized === reportUrl(item.page.url)) continue;
      const isDetail = isObservedOfferingLink(link);
      const isPlace = destinationMatcher(merchantId, link);
      const edgeType = isPlace ? 'catalog_to_destination' : isDetail ? 'listing_to_detail' : 'catalog_to_category';
      addFrontier(report, frontierRow({ url: normalized, parentUrl: item.page.url, receiptId: item.page.receipt?.id, edgeType }));
      if (!isDetail && !isPlace) continue;
      if (queuedUrls.has(normalized) || seenPages.has(normalized)) continue;
      queuedUrls.add(normalized);
      workQueue.push({ url: normalized, parentUrl: item.page.url, receiptId: item.page.receipt?.id,
        edgeType, operation: isPlace ? 'destination_listing_read' : 'product_detail_read', isPlace, sourceText: link.text });
    }
  };
  for (const item of fetched.slice(1)) enqueueChildren(item);
  let destinationPages = 0;
  let detailPages = 0;
  while (workQueue.length && fetched.length < maxPages) {
    const seed = workQueue.shift();
    if (seed.isPlace && destinationPages >= 1) continue;
    const maxDetails = merchantId === 'yanolja' ? 2 : 1;
    if (!seed.isPlace && detailPages >= maxDetails) continue;
    await wait(sleepMs);
    const result = await readOne(seed.url, seed.parentUrl, seed.edgeType, seed.operation);
    if (seed.isPlace) destinationPages += 1; else detailPages += 1;
    if (result) fetched.push(result);
    if (!result?.extracted && result?.state?.startsWith('blocked')) break;
    if (result?.extracted) enqueueChildren(result);
    if (result?.extracted && seed.sourceText) {
      const card = enrichCardFromDetail(recordFromAnchor(merchant, { url: seed.url, text: seed.sourceText }, seed.receiptId, seed.parentUrl), result);
      if (card) report.records.push(card);
    }
  }

  const uniqueRecords = [];
  const recordIndexByKey = new Map();
  for (const record of report.records) {
    const key = [record.type, record.sourceLocalId ?? '', record.url ?? '', record.title ?? ''].join('\u0000');
    const existingIndex = recordIndexByKey.get(key);
    if (existingIndex === undefined) {
      recordIndexByKey.set(key, uniqueRecords.length);
      uniqueRecords.push(record);
      continue;
    }
    const existing = uniqueRecords[existingIndex];
    if (!existing.description && record.description) existing.description = record.description;
    if ((!existing.rating || existing.rating.value == null) && record.rating?.value != null) existing.rating = record.rating;
    if ((existing.price?.amount == null && existing.price?.priceText == null) && (record.price?.amount != null || record.price?.priceText != null)) existing.price = record.price;
    const evidence = new Map([...existing.evidence, ...record.evidence].map(row => [JSON.stringify(row), row]));
    existing.evidence = [...evidence.values()];
  }
  report.records = uniqueRecords;

  for (const item of fetched) {
    if (!item?.extracted) continue;
    const links = item.extracted.links.filter(link => sameProvider(link.url, allowedRoot) && likelyCategoryOrDetail(link));
    for (const link of links) {
      const url = reportUrl(link.url);
      const known = report.frontier.find(row => row.url === url);
      if (!known) addFrontier(report, frontierRow({ url, parentUrl: item.page.url, receiptId: item.page.receipt?.id,
        edgeType: isObservedOfferingLink(link) ? 'page_to_detail' : 'page_to_catalog' }));
    }
  }
  for (const contract of report.contracts.filter(item => item.operation === 'product_detail_read' && item.responseStatus === 200)) {
    const detailUrl = reportUrl(contract.finalUrl ?? contract.requestUrl);
    const description = cleanText(contract.observedShape?.pageDescription, 3000);
    if (!detailUrl || !description) continue;
    const record = report.records.find(item => item.url === detailUrl);
    if (!record) continue;
    const ratingMatch = description.match(/(\d+(?:\.\d+)?)\s*점을\s*받은\s*([\d,]+)개의\s*고객\s*리뷰/);
    const fields = [];
    if (!record.description) { record.description = description; fields.push('description'); }
    if ((!record.rating || record.rating.value == null) && ratingMatch) {
      record.rating = { value: Number(ratingMatch[1]), best: 10, worst: null,
        reviewCount: Number(ratingMatch[2].replaceAll(',', '')), ratingCount: null };
      fields.push('rating');
    }
    if (fields.length && contract.receiptId) record.evidence.push({ receiptId: contract.receiptId,
      locator: 'meta[name="description"]', fields });
  }
  const attemptedReceiptIds = new Set(report.receipts.map(receipt => receipt.id));
  report.frontier = report.frontier.map(row => {
    if (row.state === 'pending') return row;
    if (attemptedReceiptIds.has(row.sourceReceiptId) && row.state === 'inspected') return { ...row, lastAttemptAt: report.checkedAt };
    return row;
  });

  for (const contract of report.contracts) {
    if (contract.receiptId) contract.observedShape.normalizedRecordCount = report.records.filter(record =>
      (record.evidence ?? []).some(proof => proof.receiptId === contract.receiptId)).length;
  }

  const catalogContracts = report.contracts.filter(contract => ['catalog_listing_read', 'destination_listing_read'].includes(contract.operation));
  const detailContracts = report.contracts.filter(contract => contract.operation === 'product_detail_read');
  report.operations.catalog_listing_read = { liveReplay: catalogContracts.some(item => item.responseStatus === 200), captured: false,
    clientExists: true, remnantFree: true, state: catalogContracts.some(item => item.responseStatus === 200) ? 'http_200_html' : 'not_observed' };
  const detailRecords = detailContracts.some(item => item.responseStatus === 200 && report.records.some(record =>
    (record.evidence ?? []).some(proof => proof.receiptId === item.receiptId)));
  report.operations.product_detail_read = { liveReplay: detailRecords, captured: false,
    clientExists: true, remnantFree: true, state: detailRecords ? 'http_200_html_with_record' : 'no_detail_record_verified' };
  report.operations.product_search = { liveReplay: false, captured: false, clientExists: false, remnantFree: null,
    state: root.extracted.forms.some(form => form.method === 'GET') ? 'get_form_observed_not_submitted' : 'not_observed' };
  report.operations.price = { state: capabilityState(report.records, 'price') };
  report.operations.rating_summary = { state: capabilityState(report.records, 'rating_summary') };
  report.operations.reviews_list = { state: capabilityState(report.records, 'reviews_list'), complete: false };
  report.operations.product_options = { state: report.records.some(record => record.variants?.length) ? 'variant_data_observed' : 'not_observed' };
  report.capabilities = {
    homepage: 'verified_public_html',
    product_search: report.operations.product_search.state,
    product_catalog: catalogContracts.some(item => item.responseStatus === 200) ? 'verified_public_html_route' : 'not_observed',
    product_detail: report.operations.product_detail_read.state,
    price: report.operations.price.state,
    rating_summary: report.operations.rating_summary.state,
    review_samples: report.records.some(record => record.reviewSamples?.length) ? 'partial_jsonld_samples' : 'not_observed',
    reviews_list: report.operations.reviews_list.state,
    options: report.operations.product_options.state,
  };
  const blocked = report.contracts.some(contract => contract.responseStatus && [401, 403, 418, 429].includes(contract.responseStatus))
    || report.contracts.some(contract => contract.stopReason === 'VISIBLE_CHALLENGE');
  report.status = blocked ? 'partial_blocked_frontier' : report.records.length ? 'public_ontology_records_verified_partial_catalog' : 'public_html_reached_records_pending';
  report.coverage = { pagesRead: report.contracts.filter(item => item.responseStatus === 200).length,
    recordsRead: report.records.length, categoryRoutesRead: catalogContracts.filter(item => item.responseStatus === 200).length,
    detailRoutesRead: detailContracts.filter(item => item.responseStatus === 200).length,
    pendingFrontierItems: report.frontier.filter(item => item.state === 'pending').length,
    blockedFrontierItems: report.frontier.filter(item => item.state === 'blocked').length,
    catalogExhausted: false, reviewPaginationComplete: false };
  delete report._merchant;
  return report;
}

export async function collectBatch03(options = {}) {
  const preserveStopped = options.preserveStopped !== false;
  let previousById = new Map();
  if (preserveStopped) {
    try {
      const previous = JSON.parse(readFileSync(OUTPUT_FILE, 'utf8').replace(/^\uFEFF/, ''));
      previousById = new Map((previous.merchants ?? []).map(report => [report.merchantId, report]));
    } catch { /* no previous report to reuse */ }
  }
  const reports = [];
  const reusedStoppedMerchants = [];
  for (const merchantId of merchantIds) {
    const prior = previousById.get(merchantId);
    const priorStopped = prior && (prior.status?.startsWith('blocked') || prior.status === 'partial_blocked_frontier'
      || (prior.contracts ?? []).some(contract => [401, 403, 418, 429].includes(contract.responseStatus) || contract.stopReason === 'VISIBLE_CHALLENGE'));
    if (priorStopped) {
      reports.push(prior);
      reusedStoppedMerchants.push(merchantId);
    } else {
      reports.push(await collectMerchant(merchantId, options));
    }
  }
  return {
    schemaVersion: 2,
    batchId: '03',
    checkedAt: new Date().toISOString(),
    execution: { mode: 'anonymous_public_https_html', browserUsed: false, cookiesSent: false, authorizationSent: false,
      redirects: 'normal HTTPS redirects followed only within the merchant registrable domain', challengePolicy: 'stop host on 401/403/418/429 or confirmed challenge' },
    merchantCount: reports.length,
    reusedStoppedMerchants,
    summary: { withRecords: reports.filter(item => item.records.length > 0).length,
      publicHtmlOnly: reports.filter(item => item.status === 'public_html_reached_records_pending').length,
      blocked: reports.filter(item => item.status.startsWith('blocked') || item.status === 'partial_blocked_frontier').length,
      recordCount: reports.reduce((sum, item) => sum + item.records.length, 0),
      pendingFrontierItems: reports.reduce((sum, item) => sum + item.frontier.filter(row => row.state === 'pending').length, 0) },
    merchants: reports,
  };
}

export async function writeBatch03(options = {}) {
  const artifact = await collectBatch03(options);
  mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  writeFileSync(OUTPUT_FILE, JSON.stringify(artifact, null, 2) + '\n', 'utf8');
  return { path: OUTPUT_FILE, merchantCount: artifact.merchantCount, recordCount: artifact.summary.recordCount, checkedAt: artifact.checkedAt };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await writeBatch03();
  process.stdout.write(JSON.stringify(result) + '\n');
}
