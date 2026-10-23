import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFragment } from 'parse5';
import { readPublicPage, readPublicResource, safeUrl } from '../../lib/cps-public-reader.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HUB_ROOT = path.resolve(HERE, '../..');
const BATCH_REPORT = path.join(HUB_ROOT, 'references/cps-reverify/batch-01.json');
export const merchantIds = Object.freeze(['kurly', 'halfclub1', 'myrealtrip']);
const ALLOWED_HOSTS = Object.freeze({
  kurly: ['kurly.com'],
  halfclub1: ['halfclub.com'],
  myrealtrip: ['myrealtrip.com'],
});

function readSavedBatch() {
  try { return JSON.parse(readFileSync(BATCH_REPORT, 'utf8').replace(/^\uFEFF/, '')); }
  catch { return null; }
}

function observedProductUrl(merchantId, url) {
  const row = readSavedBatch()?.merchants?.find(merchant => merchant.merchantId === merchantId);
  const allowed = new Set((row?.records ?? []).map(record => safeUrl(record.url)).filter(Boolean));
  const requested = url ? safeUrl(url) : null;
  if (requested) return allowed.has(requested) ? requested : null;
  return (row?.records ?? []).map(record => safeUrl(record.url)).find(candidate => candidate && allowed.has(candidate)) ?? null;
}

function walkNodes(root, predicate) {
  const found = [];
  const visit = node => {
    if (!node || found.length >= 20_000) return;
    if (predicate(node)) found.push(node);
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(root);
  return found;
}

function attr(node, name) { return node?.attrs?.find(item => item.name === name)?.value ?? null; }
function nodeText(node) { return (node?.childNodes ?? []).map(child => child.value ?? '').join(''); }

function parseInlineJson(html) {
  let root;
  try { root = parseFragment(String(html ?? '')); } catch { return { nextData: null, jsonLd: [] }; }
  const scripts = walkNodes(root, node => node.tagName === 'script');
  let nextData = null;
  const jsonLd = [];
  for (const script of scripts) {
    const text = nodeText(script).trim();
    const scriptId = attr(script, 'id');
    const type = String(attr(script, 'type') ?? '').toLowerCase();
    if (!text || text.length > 8 * 1024 * 1024) continue;
    if (scriptId === '__NEXT_DATA__') {
      try { nextData = JSON.parse(text); } catch { /* keep metadata-only result unavailable */ }
    } else if (type === 'application/ld+json') {
      try { jsonLd.push(JSON.parse(text)); } catch { /* ignore malformed public schema block */ }
    }
  }
  return { nextData, jsonLd };
}

function collectJsonLdReviews(blocks) {
  const nodes = blocks.flatMap(block => Array.isArray(block?.['@graph']) ? block['@graph'] : [block]);
  const product = nodes.find(node => {
    const types = Array.isArray(node?.['@type']) ? node['@type'] : [node?.['@type']];
    return types.includes('Product');
  }) ?? null;
  return { product, reviews: Array.isArray(product?.review) ? product.review : [] };
}

function dateValue(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  // Preserve the source representation. Kurly currently serves ISO-style
  // local timestamps without an explicit timezone; do not invent one.
  return /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(trimmed) ? trimmed : null;
}

function safeSampleMetadata(review, locator) {
  let rating = null;
  let helpfulCount = null;
  let publishedAt = null;
  let bodyAvailable = false;
  for (const [key, value] of Object.entries(review ?? {})) {
    if (/rating|score|star/i.test(key) && !/(?:count|total|cnt)/i.test(key)) {
      const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : null;
      if (Number.isFinite(number) && number >= 0 && number <= 5) rating = number;
    }
    if (/helpful|useful|recommend|like/i.test(key) && Number.isSafeInteger(value) && value >= 0) helpfulCount = value;
    if (/publishedAt|registeredAt|createdAt|writtenAt|reviewDate|datePublished/i.test(key)) publishedAt = dateValue(value) ?? publishedAt;
    if (/^(?:contents?|reviewBody|body|text|comment)$/i.test(key) && typeof value === 'string' && value.trim().length > 0) bodyAvailable = true;
  }
  return { rating, publishedAt, helpfulCount, bodyAvailable, locator };
}

function pageReceipt(receipt, requestUrl) {
  return {
    id: receipt?.id ?? null,
    requestMethod: 'GET', requestUrl: safeUrl(receipt?.requestUrl ?? requestUrl),
    responseStatus: Number.isInteger(receipt?.responseStatus) ? receipt.responseStatus : null,
    contentType: receipt?.contentType ?? null,
    bytes: Number.isSafeInteger(receipt?.bytes) ? receipt.bytes : 0,
    responseSha256: typeof receipt?.responseSha256 === 'string' ? receipt.responseSha256 : null,
    observedAt: receipt?.observedAt ?? null, checkedAt: receipt?.observedAt ?? null,
    browserUsed: false, cookiesSent: false, authorizationSent: false,
  };
}

function getScriptUrls(html, baseUrl) {
  let root;
  try { root = parseFragment(String(html ?? '')); } catch { return []; }
  return walkNodes(root, node => node.tagName === 'script' || node.tagName === 'link')
    .flatMap(node => {
      const raw = node.tagName === 'script' ? attr(node, 'src') : attr(node, 'href');
      if (!raw) return [];
      const url = safeUrl(new URL(raw, baseUrl).href);
      if (!url) return [];
      if (node.tagName === 'script' || /(?:modulepreload|prefetch)/i.test(attr(node, 'rel') ?? '')) return [url];
      return [];
    });
}

function productRecordFromKurly(pageUrl, nextData, jsonLdProduct, receiptId, capturedSamples, sampleCount) {
  const pageProps = nextData?.props?.pageProps;
  const product = pageProps?.product;
  const productId = product?.no == null ? null : String(product.no);
  const title = typeof product?.name === 'string' ? product.name.trim() : '';
  let url;
  try { url = safeUrl(pageUrl); } catch { url = null; }
  if (!productId || !title || !url) return null;
  const productSchemaName = typeof jsonLdProduct?.name === 'string' ? jsonLdProduct.name.trim() : null;
  const titleVerified = productSchemaName === title;
  const record = {
    type: 'RetailProduct', sourceLocalId: productId, title, url,
    description: null, brand: null,
    price: { amount: null, currency: null, priceText: null },
    rating: {
      value: null, best: null, worst: null,
      reviewCount: Number.isSafeInteger(product?.reviewCount) && product.reviewCount >= 0 ? product.reviewCount : null,
      ratingCount: null,
    },
    variants: [], reviewSamples: capturedSamples,
    evidence: [
      { receiptId, locator: '__NEXT_DATA__.props.pageProps.product.{no,name}', fields: ['sourceLocalId', 'title', 'url'] },
      { receiptId, locator: '__NEXT_DATA__.props.pageProps.reviews[*]', fields: ['reviewSamples'] },
      { receiptId, locator: '__NEXT_DATA__.props.pageProps.product.reviewCount', fields: ['rating.reviewCount', 'rating'] },
    ],
    reviewList: { returnedSampleCount: sampleCount, capturedSampleCount: capturedSamples.length, aggregateReviewCount: recordCount(product?.reviewCount) },
  };
  return { record, titleVerified };
}

function recordCount(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }

function blockedReport(merchantId, url, result) {
  const receipt = result.receipt ? pageReceipt(result.receipt, url) : null;
  return {
    merchantId, siteUrl: url, status: result.blocked ? `blocked_http_${result.status ?? 'challenge'}` : 'page_unavailable',
    receipts: receipt ? [receipt] : [], records: [], contracts: [{ operation: 'product_detail_review_surface',
      state: result.blocked ? 'blocked' : 'unavailable', receiptId: receipt?.id ?? null,
      requestUrl: safeUrl(url), responseStatus: result.status ?? null, stopReason: result.stopReason ?? null }],
    operations: { reviews_list: { state: result.blocked ? 'blocked' : 'unavailable', evidenceReceiptIds: receipt?.id ? [receipt.id] : [] } },
    frontier: [{ url: safeUrl(url), label: 'observed_product_detail_review_surface', state: result.blocked ? 'blocked' : 'pending', stopReason: result.stopReason ?? null }],
  };
}

async function collectKurly(productUrl, { maxSamples = 5 } = {}) {
  const limit = Math.min(5, Math.max(0, Number.isInteger(maxSamples) ? maxSamples : 5));
  const page = await readPublicPage(productUrl, { allowedHosts: ALLOWED_HOSTS.kurly, maxRedirects: 3, maxBytes: 8 * 1024 * 1024, timeoutMs: 20_000 });
  if (!page.ok) return blockedReport('kurly', productUrl, page);
  const receipt = pageReceipt(page.receipt, page.url);
  const { nextData, jsonLd } = parseInlineJson(page.html);
  const pageProps = nextData?.props?.pageProps;
  const product = pageProps?.product;
  const reviews = Array.isArray(pageProps?.reviews) ? pageProps.reviews : [];
  const { product: productSchema, reviews: schemaReviews } = collectJsonLdReviews(jsonLd);
  const pageReviews = reviews.slice(0, limit);
  const samples = pageReviews.map((review, index) => safeSampleMetadata(review,
    `__NEXT_DATA__.props.pageProps.reviews[${index}].{registeredAt,contents}`));
  const parsedRecord = productRecordFromKurly(page.url, nextData, productSchema, receipt.id, samples, reviews.length);
  const productIdFromPath = new URL(page.url).pathname.match(/^\/goods\/([A-Za-z0-9_-]+)\/?$/)?.[1] ?? null;
  const identityMatchesObservedUrl = Boolean(parsedRecord && productIdFromPath === parsedRecord.record.sourceLocalId);
  if (!identityMatchesObservedUrl) {
    return {
      merchantId: 'kurly', siteUrl: page.url, status: 'identity_unverified', receipts: [receipt], records: [],
      contracts: [{ operation: 'product_detail_review_surface', state: 'identity_unverified', receiptId: receipt.id,
        requestedUrl: safeUrl(productUrl), finalUrl: safeUrl(page.url), pagePropsProductNo: parsedRecord?.record.sourceLocalId ?? null,
        productIdFromPath, sampleCount: reviews.length, stopReason: 'NEXT_DATA_PRODUCT_ID_DOES_NOT_MATCH_OBSERVED_GOODS_URL' }],
      operations: { reviews_list: { state: 'identity_unverified', evidenceReceiptIds: [receipt.id] } },
      frontier: [{ url: safeUrl(productUrl), label: 'observed_product_detail_review_surface', state: 'pending', stopReason: 'PRODUCT_ID_URL_MISMATCH' }],
    };
  }
  const record = parsedRecord.record;
  const schemaReviewCount = schemaReviews.length;
  const contract = {
    operation: 'reviews_list', state: reviews.length ? 'live_replay_verified_metadata_only' : 'aggregate_only_no_review_list',
    method: 'GET', receiptId: receipt.id, requestedUrl: safeUrl(productUrl), finalUrl: safeUrl(page.url),
    locator: '__NEXT_DATA__.props.pageProps.reviews', returnedSampleCount: reviews.length,
    capturedSampleCount: samples.length, aggregateReviewCount: record.rating.reviewCount,
    schemaReviewCount, productIdentity: { sourceLocalId: record.sourceLocalId, title: record.title, url: record.url },
    identityEvidenceLocator: '__NEXT_DATA__.props.pageProps.product.{no,name}',
    sampleFields: ['rating', 'publishedAt', 'helpfulCount', 'bodyAvailable'],
    omittedFields: ['reviewId', 'author', 'body', 'imageUrl'],
    browserUsed: false, cookiesSent: false, authorizationSent: false,
  };
  const assessment = {
    merchantId: 'kurly', siteUrl: safeUrl(page.url), status: reviews.length ? 'review_list_metadata_sampled' : 'aggregate_only_no_review_list',
    receipts: [receipt], records: reviews.length ? [record] : [], contracts: [contract],
    operations: {
      product_detail: { state: 'replay_verified', evidenceReceiptIds: [receipt.id] },
      reviews_list: { state: reviews.length ? 'metadata_sampled' : 'not_exposed', evidenceReceiptIds: [receipt.id] },
      rating_summary: { state: record.rating.reviewCount !== null ? 'aggregate_count_only' : 'not_exposed', evidenceReceiptIds: record.rating.reviewCount !== null ? [receipt.id] : [] },
    }, frontier: [],
  };
  if (!parsedRecord.titleVerified) {
    assessment.contracts.push({ operation: 'product_identity_crosscheck', state: 'jsonld_name_disagreement', receiptId: receipt.id,
      nextDataTitle: record.title, jsonLdTitle: typeof productSchema?.name === 'string' ? productSchema.name.trim() : null });
  }
  return assessment;
}

function publicScriptMetadata(html, baseUrl) {
  const urls = getScriptUrls(html, baseUrl);
  return urls.map(url => ({ url, label: /goReviewWrite/i.test(url) ? 'review_write_component_observed_not_used'
    : /EventItemComment/i.test(url) ? 'event_comment_component_observed_not_a_review_list_contract' : 'public_script_observed' }));
}

function reviewRouteCandidates(source) {
  const candidates = new Set();
  for (const match of String(source ?? '').matchAll(/["'`]((?:https?:\/\/[^"'`\s]+|\/[^"'`\s]+))["'`]/gi)) {
    const raw = match[1];
    if (!/(?:review|rating|comment)/i.test(raw) || /\.(?:jpe?g|png|gif|webp|avif|svg)(?:[?#]|$)/i.test(raw)) continue;
    try {
      const url = new URL(raw, 'https://observed.invalid/');
      candidates.add(`${url.origin === 'https://observed.invalid' ? '' : url.origin}${url.pathname}`);
    } catch { /* keep non-URL text out of the route ledger */ }
  }
  return [...candidates];
}

async function collectObservedButNoList(merchantId, productUrl) {
  const hosts = ALLOWED_HOSTS[merchantId];
  const page = await readPublicPage(productUrl, { allowedHosts: hosts, maxRedirects: 3, maxBytes: 8 * 1024 * 1024, timeoutMs: 20_000 });
  if (!page.ok) return blockedReport(merchantId, productUrl, page);
  const receipt = pageReceipt(page.receipt, page.url);
  const { nextData, jsonLd } = parseInlineJson(page.html);
  const resources = publicScriptMetadata(page.html, page.url);
  const contracts = [];
  if (merchantId === 'halfclub1') {
    const data = parseInlineJson(page.html);
    const pdpScript = (() => {
      let root; try { root = parseFragment(page.html); } catch { return null; }
      const script = walkNodes(root, node => node.tagName === 'script' && attr(node, 'id') === 'pdp-data')[0];
      if (!script) return null;
      try { return JSON.parse(nodeText(script)); } catch { return null; }
    })();
    const detailReviewCount = recordCount(pdpScript?.productInfo?.reviewTotalCnt);
    const resourcesWithReviewNames = resources.filter(row => /review|comment/i.test(row.url));
    contracts.push({ operation: 'product_detail_review_surface', state: 'aggregate_only_no_review_list', receiptId: receipt.id,
      locator: 'script#pdp-data.productInfo.reviewTotalCnt', aggregateReviewCount: detailReviewCount,
      reviewListEmbedded: false, observedReviewNamedResources: resourcesWithReviewNames.map(row => ({ url: row.url, label: row.label })),
      browserUsed: false, cookiesSent: false, authorizationSent: false });
  } else {
    const schema = collectJsonLdReviews(jsonLd);
    const nextReviewKeys = [];
    const queryData = nextData?.props?.pageProps?.dehydratedState?.queries?.[0]?.state?.data?.data;
    const aggregateCount = recordCount(queryData?.reviewCount ?? nextData?.props?.pageProps?.product?.reviewCount);
    const aggregateRatingRaw = schema.product?.aggregateRating?.ratingValue ?? queryData?.reviewScore ?? null;
    const aggregateRating = aggregateRatingRaw == null ? null : Number.isFinite(Number(aggregateRatingRaw)) ? Number(aggregateRatingRaw) : null;
    for (const image of queryData?.images ?? []) if (Object.keys(image ?? {}).some(key => /reviewId/i.test(key))) nextReviewKeys.push('review_image_reference');
    contracts.push({ operation: 'product_detail_review_surface', state: 'aggregate_and_review_media_only', receiptId: receipt.id,
      locator: '__NEXT_DATA__.props.pageProps.dehydratedState.queries[0].state.data.data',
      aggregateReviewCount: aggregateCount, aggregateRating, reviewListEmbedded: false,
      observedReviewImageReferences: nextReviewKeys.length > 0, reviewListRouteInPageSpecificBundle: null,
      browserUsed: false, cookiesSent: false, authorizationSent: false });
    const pageSpecificBundle = resources.find(row => /\/pages\/products\/%5Bgid%5D-[^/]+\.js/i.test(new URL(row.url).pathname));
    if (pageSpecificBundle) {
      let host;
      try { host = new URL(pageSpecificBundle.url).hostname; } catch { host = null; }
      if (host) {
        const resource = await readPublicResource(pageSpecificBundle.url, { allowedHosts: [host], maxRedirects: 2, maxBytes: 8 * 1024 * 1024, timeoutMs: 20_000 });
        const bundleReceipt = resource.receipt ? pageReceipt(resource.receipt, pageSpecificBundle.url) : null;
        if (bundleReceipt) {
          // Replace the GET label while preserving the helper-generated hash,
          // MIME, status, bytes, time, and no-credentials assertions.
          bundleReceipt.requestMethod = 'GET';
        }
        const routeCandidates = resource.ok ? reviewRouteCandidates(resource.body) : [];
        contracts.push({ operation: 'observed_product_page_bundle_review_contract',
          state: resource.ok ? routeCandidates.length ? 'review_route_candidate_observed_not_replayed' : 'review_route_not_found_in_observed_page_bundle' : resource.blocked ? 'blocked' : 'source_unavailable',
          receiptId: bundleReceipt?.id ?? null, requestedUrl: safeUrl(pageSpecificBundle.url),
          responseStatus: resource.status ?? null, contentType: resource.contentType ?? null,
          literalReviewRouteCandidates: resource.ok ? routeCandidates : null,
          stopReason: resource.stopReason ?? null, browserUsed: false, cookiesSent: false, authorizationSent: false });
        if (bundleReceipt) return {
          merchantId, siteUrl: safeUrl(page.url), status: 'aggregate_only_no_review_list_path', receipts: [receipt, bundleReceipt], records: [], contracts,
          operations: { reviews_list: { state: 'not_exposed', evidenceReceiptIds: [receipt.id, bundleReceipt.id] }, rating_summary: {
            state: aggregateCount !== null || aggregateRating !== null ? 'aggregate_only' : 'not_exposed', evidenceReceiptIds: [receipt.id] } },
          frontier: [{ url: safeUrl(pageSpecificBundle.url), label: 'observed_product_page_review_contract', state: resource.ok && !routeCandidates.length ? 'inspected_no_route' : resource.blocked ? 'blocked' : 'pending', stopReason: resource.stopReason ?? null }],
        };
      }
    }
  }
  return {
    merchantId, siteUrl: safeUrl(page.url), status: 'aggregate_only_no_review_list_path', receipts: [receipt], records: [], contracts,
    operations: { reviews_list: { state: 'not_exposed', evidenceReceiptIds: [receipt.id] } },
    frontier: resources.filter(row => /review|comment/i.test(row.url)).map(row => ({ ...row, state: 'observed_not_followed' })),
  };
}

/**
 * Direct-HTTP review metadata collector for product URLs already present in
 * batch-01. It reads one observed PDP per merchant and stores no review body,
 * identity, review ID, or image URL. Only Kurly exposes inline list metadata.
 */
export async function collectMerchant(merchantId, options = {}) {
  if (!merchantIds.includes(merchantId)) throw Object.assign(new Error('MERCHANT_NOT_IN_REVIEW_SUPPLEMENT'), { code: 'MERCHANT_NOT_IN_REVIEW_SUPPLEMENT' });
  const productUrl = observedProductUrl(merchantId, options.productUrl);
  if (!productUrl) return {
    merchantId, siteUrl: null, status: 'no_observed_product_url', receipts: [], records: [], contracts: [], operations: {},
    frontier: [{ url: null, label: 'observed_product_detail', state: 'pending', stopReason: 'NO_MATCHING_URL_IN_BATCH_01_RECORDS' }],
  };
  if (merchantId === 'kurly') return collectKurly(productUrl, options);
  return collectObservedButNoList(merchantId, productUrl);
}

export async function collectBatch01ReviewSupplement(options = {}) {
  const merchants = [];
  for (const merchantId of merchantIds) merchants.push(await collectMerchant(merchantId, options[merchantId] ?? {}));
  return { schemaVersion: 1, batchId: '01-review', checkedAt: new Date().toISOString(), merchants };
}
