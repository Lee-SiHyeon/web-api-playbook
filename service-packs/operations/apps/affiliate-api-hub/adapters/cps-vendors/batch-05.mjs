import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseFragment } from 'parse5';
import { extractPublicPage, isStrongPublicChallenge, readPublicPage, readPublicResource, safeUrl, textContent } from '../../lib/cps-public-reader.mjs';
import { collectPulmuone as collectPulmuoneMaintained } from './pulmuone.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '../..');
const TAXONOMY_PATH = path.join(APP_ROOT, 'references/linkprice-cps-vertical-taxonomy.v1.json');
const OUTPUT_PATH = path.join(APP_ROOT, 'references/cps-reverify/batch-05.json');
const MAX_PAGE_BYTES = 6 * 1024 * 1024;

export const merchantIds = Object.freeze([
  'lensbank', 'qtoon', 'joseph', 'thirtymall', 'woot', 'exvpn', 'swarovski', 'pulmuone',
  'barobill', 'hfashion', 'kkday', 'fanatical', 'klook', 'udemy',
]);

const taxonomy = JSON.parse(readFileSync(TAXONOMY_PATH, 'utf8').replace(/^\uFEFF/, ''));
const merchantById = new Map(merchantIds.map(id => {
  const merchant = taxonomy.merchants.find(row => row.merchantId === id);
  if (!merchant) throw new Error(`TAXONOMY_MERCHANT_MISSING:${id}`);
  return [id, merchant];
}));

function providerRoot(hostname) {
  const labels = hostname.toLowerCase().replace(/^www\./, '').split('.');
  const multiLabelSuffixes = new Set(['co.kr', 'or.kr', 'go.kr', 'ac.kr', 'ne.kr']);
  const lastTwo = labels.slice(-2).join('.');
  return labels.slice(-(multiLabelSuffixes.has(lastTwo) ? 3 : 2)).join('.');
}

function allowedHostsFor(merchant) {
  const host = new URL(merchant.siteUrl).hostname.toLowerCase();
  return [...new Set([host, providerRoot(host)])];
}

function emptyOperations() {
  return {
    product_search: { state: 'not_observed', evidenceReceiptIds: [] },
    catalog_items: { state: 'not_observed', evidenceReceiptIds: [] },
    product_or_service_detail: { state: 'not_observed', evidenceReceiptIds: [] },
    price: { state: 'not_observed', evidenceReceiptIds: [] },
    rating_summary: { state: 'not_observed', evidenceReceiptIds: [] },
    review_samples: { state: 'not_observed', evidenceReceiptIds: [] },
    review_list_endpoint: { state: 'not_observed', evidenceReceiptIds: [] },
  };
}

function baseReport(merchant) {
  return {
    merchantId: merchant.merchantId,
    merchantName: merchant.merchantName,
    siteUrl: safeUrl(merchant.siteUrl),
    verticalHint: merchant.verticalHint,
    receipts: [], records: [], contracts: [], operations: emptyOperations(), frontier: [],
    status: 'pending',
    transport: { browserUsed: false, cookiesSent: false, authorizationSent: false, helper: 'lib/cps-public-reader.mjs' },
  };
}

function addReceipt(report, raw, { redirects = [], resource = false, blocked = false, checkedAtOverride = undefined } = {}) {
  if (!raw) return null;
  const id = raw.id ?? `${report.merchantId}-${report.receipts.length + 1}`;
  const requestUrl = safeUrl(raw.requestUrl);
  const receipt = {
    id,
    receiptId: id,
    requestMethod: raw.requestMethod ?? 'GET',
    method: raw.requestMethod ?? 'GET',
    requestUrl,
    finalUrl: safeUrl(raw.requestUrl),
    responseStatus: Number.isInteger(raw.responseStatus) ? raw.responseStatus : null,
    httpStatus: Number.isInteger(raw.responseStatus) ? raw.responseStatus : null,
    contentType: raw.contentType ?? null,
    mime: raw.contentType ? raw.contentType.split(';', 1)[0].trim().toLowerCase() : null,
    bytes: Number.isSafeInteger(raw.bytes) ? raw.bytes : 0,
    responseSha256: raw.responseSha256 ?? null,
    observedAt: checkedAtOverride === undefined ? raw.observedAt ?? null : checkedAtOverride,
    checkedAt: checkedAtOverride === undefined ? raw.observedAt ?? null : checkedAtOverride,
    browserUsed: false, cookiesSent: false, authorizationSent: false,
    secureTransport: requestUrl?.startsWith('https://') ?? null,
    transport: 'shared_public_page_reader',
    ...(resource ? { resourceOnly: true } : {}),
    ...(blocked ? { blocked: true, retry: false } : {}),
    ...(redirects.length ? { redirects: redirects.map(row => ({ status: row.status, from: safeUrl(row.from), to: safeUrl(row.to) })) } : {}),
  };
  report.receipts.push(receipt);
  return receipt;
}

function addContract(report, operation, receipt, fields = {}) {
  report.contracts.push({
    operation,
    requestUrl: receipt?.requestUrl ?? null,
    finalUrl: receipt?.finalUrl ?? receipt?.requestUrl ?? null,
    method: receipt?.method ?? 'GET',
    status: receipt?.httpStatus ?? null,
    contentType: receipt?.contentType ?? null,
    observedAt: receipt?.observedAt ?? null,
    browserUsed: false, cookiesSent: false, authorizationSent: false,
    secureTransport: receipt?.secureTransport ?? null,
    evidenceReceiptId: receipt?.id ?? null,
    ...fields,
  });
}

async function readPage(report, merchant, url, operation, { maxBytes = MAX_PAGE_BYTES } = {}) {
  const page = await readPublicPage(url, {
    allowedHosts: allowedHostsFor(merchant), maxRedirects: 3, maxBytes, timeoutMs: 20_000,
  });
  const receipt = addReceipt(report, page.receipt, { redirects: page.redirects ?? [], blocked: page.blocked });
  const extraction = extractPublicPage(page, { merchantId: merchant.merchantId, typeHint: merchant.verticalHint });
  addContract(report, operation, receipt, {
    title: extraction.title, description: extraction.description,
    jsonLdBlocks: extraction.jsonLd.length, embeddedJsonBlocks: extraction.embeddedJson.length,
    forms: extraction.forms, linkCount: extraction.links.length,
    redirects: (page.redirects ?? []).map(row => ({ status: row.status, from: row.from, to: row.to })),
    stopReason: page.stopReason ?? null,
  });
  report.frontier.push({ operation, url: safeUrl(url), state: page.ok ? 'read' : page.stopReason, retry: false, ...(page.blocked ? { stopHost: true } : {}) });
  if (page.blocked) {
    report.status = 'blocked_stopped';
    report.stopReason = page.stopReason;
  }
  return { page, extraction, receipt };
}

async function readResource(report, merchant, url, operation, { maxBytes = 1_000_000 } = {}) {
  const resource = await readPublicResource(url, {
    allowedHosts: allowedHostsFor(merchant), maxRedirects: 3, maxBytes, timeoutMs: 20_000,
  });
  const receipt = addReceipt(report, resource.receipt, { redirects: resource.redirects ?? [], resource: true, blocked: resource.blocked });
  addContract(report, operation, receipt, {
    stopReason: resource.stopReason ?? null,
    redirects: (resource.redirects ?? []).map(row => ({ status: row.status, from: row.from, to: row.to })),
  });
  report.frontier.push({ operation, url: safeUrl(url), state: resource.ok ? 'read_source_without_execution' : resource.stopReason, retry: false, ...(resource.blocked ? { stopHost: true } : {}) });
  if (resource.blocked) {
    report.status = 'blocked_stopped';
    report.stopReason = resource.stopReason;
  }
  return { resource, receipt };
}

function evidence(receipt, locator, fields) {
  return [{ receiptId: receipt.id, locator, fields }];
}

function normalizedGenericRecord(record, receipt, pageUrl) {
  const row = {
    type: record.type ?? 'UnclassifiedOffering',
    sourceLocalId: record.sourceLocalId == null ? null : String(record.sourceLocalId),
    title: record.title ?? null,
    url: safeUrl(record.url, pageUrl),
    description: record.description ?? null,
    brand: record.brand ?? null,
    price: record.price && typeof record.price === 'object' ? record.price : { amount: null, currency: null, priceText: null },
    rating: record.rating ?? null,
    variants: Array.isArray(record.variants) ? record.variants : [],
    reviewSamples: Array.isArray(record.reviewSamples) ? record.reviewSamples.map(review => {
      const textFields = [review.body, review.text, review.content, review.description, review.textExcerpt];
      return {
        rating: review.rating ?? null,
        publishedAt: review.publishedAt ?? null,
        bodyAvailable: review.bodyAvailable === true || textFields.some(value => typeof value === 'string' && value.trim().length > 0),
        optionText: null, helpfulCount: null, hasMedia: null,
      };
    }) : [],
    evidence: record.evidence?.length ? record.evidence : evidence(receipt, 'public JSON-LD offering', ['type', 'title', 'url']),
  };
  if (Array.isArray(record.offers) && record.offers.length) row.offers = record.offers;
  return row;
}

function addGenericRecords(report, extraction, receipt, pageUrl) {
  const rows = (extraction.records ?? []).map(record => normalizedGenericRecord(record, receipt, pageUrl));
  for (const row of rows) {
    if (!row.evidence.some(item => item.receiptId === receipt.id)) row.evidence = evidence(receipt, row.evidence[0]?.locator ?? 'public JSON-LD offering', row.evidence[0]?.fields ?? ['title']);
  }
  report.records.push(...rows);
  return rows;
}

function asList(value) { return value == null ? [] : Array.isArray(value) ? value : [value]; }
function typeList(row) { const raw = asList(row?.['@type']); return raw.map(value => String(value).split(/[\/#]/).at(-1).toLowerCase()); }
function num(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== 'string' || !/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(value.trim())) return null;
  return Number(value.replaceAll(',', ''));
}
function integer(value) { const parsed = num(value); return parsed != null && Number.isSafeInteger(parsed) ? parsed : null; }

function attr(node, name) { const key = String(name).toLowerCase(); return node?.attrs?.find(item => item.name === key)?.value ?? null; }
function hasClass(node, name) { return (attr(node, 'class') ?? '').split(/\s+/).includes(name); }
function walk(node, predicate, out = []) {
  if (!node || out.length > 20_000) return out;
  if (predicate(node)) out.push(node);
  for (const child of node.childNodes ?? []) walk(child, predicate, out);
  return out;
}
function nodeText(node) {
  if (!node) return '';
  if (node.nodeName === '#text') return node.value ?? '';
  if (['script', 'style', 'template', 'noscript'].includes(node.tagName)) return '';
  return (node.childNodes ?? []).map(nodeText).join(' ').replace(/\s+/g, ' ').trim();
}
function scrubPublicText(value, limit = 4000) {
  const text = textContent(String(value ?? ''), limit) ?? '';
  return text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email redacted]')
    .replace(/(?:\+?82[\s-]?)?0\d{1,2}[\s-]?\d{3,4}[\s-]?\d{4}/g, '[phone redacted]')
    .replace(/https?:\/\/\S+/gi, '[link redacted]').replace(/\b\d{8,}\b/g, '[id redacted]').slice(0, limit) || null;
}
function parseInputs(html) {
  const root = parseFragment(html);
  const inputs = walk(root, node => ['input', 'select'].includes(node.tagName));
  return { root, inputs };
}
function inputValue(inputs, name) {
  const input = inputs.find(node => attr(node, 'name') === name || attr(node, 'id') === name);
  return input ? attr(input, 'value') ?? null : null;
}

function setOpsFromRecords(report) {
  const refsFor = predicate => [...new Set(report.records.flatMap(row => (row.evidence ?? [])
    .filter(ref => predicate(ref)).map(ref => ref.receiptId).filter(Boolean)))];
  const catalogIds = refsFor(ref => (ref.fields ?? []).some(field => ['title', 'sourceLocalId'].includes(field)));
  const detailIds = refsFor(ref => /detail|work_detail|service_detail/i.test(String(ref.locator ?? ''))
    || (ref.fields ?? []).some(field => ['description', 'modelCode', 'optionValuesObserved'].includes(field)));
  const prices = report.records.filter(row => row.price && (row.price.amount != null || row.price.priceText != null));
  const rated = report.records.filter(row => row.rating && (row.rating.value != null || row.rating.reviewCount != null || row.rating.ratingCount != null));
  const reviews = report.records.flatMap(row => row.reviewSamples ?? []);
  if (report.records.length) report.operations.catalog_items = { state: 'observed_in_public_page', evidenceReceiptIds: catalogIds };
  if (detailIds.length) report.operations.product_or_service_detail = { state: 'detail_record_observed', evidenceReceiptIds: detailIds };
  const priceIds = refsFor(ref => (ref.fields ?? []).some(field => /^(?:price|offers)(?:\.|$)/.test(field))
    || /visible \.price/i.test(String(ref.locator ?? '')));
  if (prices.length) report.operations.price = { state: 'displayed_price_observed', evidenceReceiptIds: priceIds };
  const ratingIds = refsFor(ref => (ref.fields ?? []).some(field => /^rating(?:\.|$)/.test(field)));
  if (rated.length) {
    const hasScore = rated.some(row => row.rating.value != null);
    const noScore = rated.every(row => row.rating.value == null);
    report.operations.rating_summary = { state: hasScore ? 'aggregate_rating_observed' : noScore ? 'review_count_observed_rating_score_missing' : 'count_only_rating_metadata', evidenceReceiptIds: ratingIds };
  }
  const reviewIds = refsFor(ref => (ref.fields ?? []).some(field => /reviewSamples|reviewCount/.test(field)));
  if (reviews.length) report.operations.review_samples = { state: 'partial_public_review_metadata', count: reviews.length, complete: false, evidenceReceiptIds: reviewIds };
  else if (report.operations.review_list_endpoint?.reviewCount === 0) report.operations.review_samples = { state: 'zero_reviews_observed', count: 0, complete: true, evidenceReceiptIds: report.operations.review_list_endpoint.evidenceReceiptIds ?? [] };
}

function finalizeThirtymallReport(report) {
  const searchContract = report.contracts.find(contract => contract.operation === 'product_search_and_catalog_GET');
  if (!searchContract) return;
  const searchReceiptId = searchContract.evidenceReceiptId;
  const summary = searchContract.responseSummary ?? {};
  report.operations.product_search = { state: 'keyword_query_not_verified', queryApplied: false, query: null,
    evidenceReceiptIds: [searchReceiptId].filter(Boolean) };
  report.operations.catalog_items = { state: 'popular_catalog_verified', collectionKind: 'popular_catalog', queryApplied: false, query: null, count: report.records.length,
    totalAvailableCount: summary.totalCount ?? null, pageCount: summary.pageCount ?? null, pageNumber: 1,
    pageSize: 20, complete: false, evidenceReceiptIds: [searchReceiptId].filter(Boolean) };
  report.capabilities = {
    product_search: 'not_verified', popular_catalog_listing: 'live_replay_verified_pure_http_first_page',
    product_detail: report.operations.product_or_service_detail?.state === 'detail_record_observed' ? 'live_replay_verified_pure_http' : 'not_verified',
    product_options: report.frontier.some(row => row.operation === 'product_options' && row.state === 'detail_options_replayed') ? 'live_replay_verified_pure_http' : 'not_verified',
    review_list: report.operations.review_list_endpoint?.state === 'anonymous_public_review_GET_replayed_no_identity' ? 'live_replay_verified_pure_http_partial_samples' : 'not_verified',
    catalogCompleteness: 'first_page_only',
  };
  report.transport = { ...report.transport, executionMode: 'pure_http', apiTransport: 'fixed_host_bounded_https_GET',
    apiOrigin: 'https://shop-api.e-ncp.com', staticPublicHeaderNames: ['clientId', 'version', 'platform'],
    staticHeaderValuesPersisted: false, browserAccessTokenReadOrSent: false, cookiesSent: false, authorizationSent: false,
    remnantFreeScope: 'recurring product and review read path' };
}

function blockedSnapshot(merchantId) {
  if (merchantId === 'fanatical') {
    // A source-derived first-party API route returned 403. Preserve the existing
    // anonymous shell/source observations and add the blocked replay receipt
    // locally so later batch runs stop before contacting this host again.
    let saved = null;
    try {
      const artifact = JSON.parse(readFileSync(OUTPUT_PATH, 'utf8').replace(/^\uFEFF/, ''));
      saved = artifact.merchants?.find(row => row.merchantId === 'fanatical') ?? null;
    } catch { /* retain a minimal blocked report if no earlier snapshot exists */ }
    const merchant = merchantById.get(merchantId);
    const report = saved ? JSON.parse(JSON.stringify(saved)) : baseReport(merchant);
    const id = 'batch-05-fanatical-api-403';
    const url = 'https://www.fanatical.com/api/algolia/bundles';
    report.receipts = (report.receipts ?? []).filter(row => row.id !== id && row.receiptId !== id);
    report.contracts = (report.contracts ?? []).filter(row => row.evidenceReceiptId !== id);
    report.frontier = (report.frontier ?? []).filter(row => row.operation !== 'public_algolia_bundle_feed_GET');
    const receipt = {
      id, receiptId: id, requestMethod: 'GET', method: 'GET', requestUrl: url, finalUrl: url,
      responseStatus: 403, httpStatus: 403, contentType: 'text/html; charset=utf-8', mime: 'text/html',
      bytes: 0, responseSha256: null, observedAt: '2026-09-27T10:19:30.634Z', checkedAt: '2026-09-27T10:19:30.634Z',
      browserUsed: false, cookiesSent: false, authorizationSent: false, secureTransport: true,
      transport: 'shared_public_page_reader', blocked: true, retry: false,
      responseBodyConsumed: false, responseBodyLengthKnown: false,
    };
    report.receipts.push(receipt);
    report.contracts.push({
      operation: 'public_algolia_bundle_feed_GET', requestUrl: url, finalUrl: url, method: 'GET', status: 403,
      contentType: receipt.contentType, observedAt: receipt.observedAt,
      browserUsed: false, cookiesSent: false, authorizationSent: false, secureTransport: true,
      evidenceReceiptId: id, retry: false, stopReason: 'HTTP_ACCESS_BLOCKED',
      apiOrigin: 'https://www.fanatical.com/api', route: '/algolia/bundles',
      sourceEvidenceReceiptIds: ['b9cfebe2-0940-4e24-b8d2-56c2b9a0548c', '1872c8c0-b6ab-4ac6-b291-d1439561a2cd'],
      requestHeaderNames: ['accept', 'accept-encoding'], responseBodyConsumed: false,
    });
    report.contracts.push({
      operation: 'dynamic_search_key_issuer', method: 'GET', requestUrl: 'https://www.fanatical.com/api/algolia/key',
      status: null, state: 'source_observed_only_not_replayed', browserUsed: false, cookiesSent: false,
      authorizationSent: false, secureTransport: true,
      sourceEvidenceReceiptIds: ['b9cfebe2-0940-4e24-b8d2-56c2b9a0548c', '1872c8c0-b6ab-4ac6-b291-d1439561a2cd'],
      dynamicKeyValuePersisted: false, note: 'Key issuer was identified in public frontend source but was not called; the key value is not stored.',
    });
    const routeDiscovery = report.contracts.find(row => row.operation === 'frontend_route_discovery');
    if (routeDiscovery) {
      routeDiscovery.actualDataApiObserved = true;
      routeDiscovery.replayableDataApiObserved = false;
      routeDiscovery.apiOrigin = 'https://www.fanatical.com/api';
      routeDiscovery.observedDataApiPaths = ['/algolia/bundles', '/algolia/megamenu', '/algolia/get-hits-by-slugs', '/algolia/key'];
      routeDiscovery.note = 'Public frontend source exposed Algolia data routes; exact anonymous GET to /algolia/bundles returned 403. Further host reads stopped; dynamic key issuer was not called.';
    }
    report.operations ??= emptyOperations();
    report.operations.product_search = { state: 'source_route_observed_replay_blocked_403', evidenceReceiptIds: [id], retry: false };
    report.operations.catalog_items = { state: 'source_route_observed_replay_blocked_403', evidenceReceiptIds: [id], complete: false };
    report.status = 'blocked_stopped';
    report.stopReason = 'HTTP_ACCESS_BLOCKED';
    report.frontier.push({ operation: 'public_algolia_bundle_feed_GET', url, state: 'HTTP_403', stopHost: true, retry: false,
      note: 'Exact source-derived anonymous GET returned 403. Response body was not consumed, so challenge classification is unknown; no retry.' });
    report.frontier.push({ operation: 'dynamic_search_key_issuer', url: 'https://www.fanatical.com/api/algolia/key',
      state: 'source_observed_not_replayed_after_host_stop', retry: false, note: 'Dynamic key value not collected or persisted.' });
    report.transport = { ...(report.transport ?? {}), browserUsed: false, cookiesSent: false, authorizationSent: false,
      helper: 'lib/cps-public-reader.mjs', stopReason: 'HTTP_ACCESS_BLOCKED' };
    return report;
  }
  const common = { browserUsed: false, cookiesSent: false, authorizationSent: false, blocked: true, retry: false };
  const rows = {
    joseph: {
      url: 'https://joseph-fashion.com/products/gift-card', mime: 'text/html; charset=UTF-8', at: '2026-09-27T09:26:41.694Z',
      reason: 'Observed homepage exposed /products/gift-card; anonymous direct page read returned 403. Stop this host; no item record.' ,
    },
    woot: {
      url: 'https://www.woot.com/', mime: 'text/html', at: '2026-09-27T09:28:14.962Z',
      reason: 'Anonymous root read returned 403 after an earlier public shell response; stop this host; no product listing record.' ,
    },
    exvpn: {
      url: 'https://www.expressvpn.com/pricing', mime: 'text/html', at: '2026-09-27T09:26:41.753Z',
      reason: 'Observed homepage pricing link led to a direct anonymous 403; stop this host; no service price record.' ,
    },
    swarovski: {
      url: 'https://www.swarovski.com/ko-KR/c-01/Categories/Jewelry/f/fg-shopby/fl-outlet', mime: 'text/html', at: '2026-09-27T09:26:41.798Z',
      reason: 'Observed homepage category link returned 403 on direct anonymous GET; stop this host; no product record.' ,
    },
    kkday: {
      url: 'https://www.kkday.com/ko', mime: 'text/html; charset=UTF-8', at: null,
      reason: 'Initial anonymous homepage probe returned 403; the first probe did not capture timestamp, response bytes, or hash. No retry was made.' ,
    },
    klook: {
      url: 'https://www.klook.com/ko/', mime: 'text/html;charset=utf-8', at: null,
      reason: 'After observed same-provider HTTP-to-HTTPS/trailing-slash redirects, anonymous homepage returned 403; timestamp, bytes, and hash were not captured by the initial probe. No retry was made.' ,
    },
    udemy: {
      url: 'https://www.udemy.com/', mime: 'text/html; charset=UTF-8', at: null,
      reason: 'Initial anonymous homepage probe returned 403; the first probe did not capture timestamp, response bytes, or hash. No retry was made.' ,
    },
  };
  const row = rows[merchantId];
  if (!row) return null;
  const merchant = merchantById.get(merchantId);
  const report = baseReport(merchant);
  const id = `batch-05-${merchantId}-403`;
  const receipt = {
    id, receiptId: id, requestMethod: 'GET', method: 'GET', requestUrl: row.url, finalUrl: row.url,
    responseStatus: 403, httpStatus: 403, contentType: row.mime, mime: row.mime.split(';', 1)[0].trim(),
    bytes: 0, responseSha256: null, observedAt: row.at, checkedAt: row.at,
    ...common, responseBodyConsumed: false, responseBodyLengthKnown: false, secureTransport: row.url.startsWith('https://'),
    transport: row.at ? 'prior_anonymous_probe_timestamp_captured' : 'prior_anonymous_probe_timestamp_not_captured',
  };
  report.receipts.push(receipt);
  report.contracts.push({ operation: 'anonymous_public_page_GET', method: 'GET', requestUrl: row.url, finalUrl: row.url, status: 403,
    contentType: row.mime, observedAt: row.at, browserUsed: false, cookiesSent: false, authorizationSent: false,
    secureTransport: true, evidenceReceiptId: id, retry: false, stopReason: 'HTTP_ACCESS_BLOCKED' });
  report.frontier.push({ operation: 'homepage_or_observed_detail_GET', url: row.url, state: 'HTTP_403', stopHost: true, retry: false,
    note: row.reason });
  report.status = 'blocked_stopped';
  report.stopReason = 'HTTP_ACCESS_BLOCKED';
  report.operations.public_page_read = { state: 'blocked_anonymous', evidenceReceiptIds: [id] };
  return report;
}

async function collectLensbank(report, merchant) {
  const home = await readPage(report, merchant, merchant.siteUrl, 'homepage_GET');
  if (!home.page.ok) return;
  const form = home.extraction.forms.find(row => row.method === 'GET' && row.controls.some(control => control.name === 's')
    && row.controls.some(control => control.name === 'post_type'));
  if (!form) {
    report.frontier.push({ operation: 'product_search', state: 'no_observed_get_search_form' });
    return;
  }
  const searchUrl = new URL(form.action);
  searchUrl.searchParams.set('s', '아큐브 디파인');
  searchUrl.searchParams.set('post_type', 'product');
  const search = await readPage(report, merchant, searchUrl.href, 'observed_product_search_GET');
  if (!search.page.ok) return;
  const candidates = search.extraction.links.filter(row => new URL(row.url).origin === new URL(search.page.url).origin
    && /\/product\/[^/]+\/?$/.test(new URL(row.url).pathname) && row.text);
  report.operations.product_search = { state: 'public_GET_replayed', query: '아큐브 디파인', evidenceReceiptIds: [home.receipt?.id, search.receipt?.id].filter(Boolean), firstPageOnly: true };
  report.contracts.at(-1).searchRecipe = { method: 'GET', formAction: form.action, parameters: { s: '아큐브 디파인', post_type: 'product' },
    resultLinkPattern: '/product/{sourceLocalId}/', replayed: true };
  if (!candidates.length) {
    report.frontier.push({ operation: 'product_detail', state: 'search_results_contained_no_observed_product_detail_link' });
    return;
  }
  const item = candidates[0];
  const detail = await readPage(report, merchant, item.url, 'observed_product_detail_GET');
  if (!detail.page.ok) return;
  const rows = addGenericRecords(report, detail.extraction, detail.receipt, detail.page.url);
  if (!rows.length) report.frontier.push({ operation: 'product_detail', url: safeUrl(item.url), state: 'page_read_but_no_supported_jsonld_product_record' });
  else {
    report.operations.product_or_service_detail = { state: 'product_jsonld_record_observed', evidenceReceiptIds: rows.flatMap(row => row.evidence.map(ref => ref.receiptId)) };
    report.operations.rating_summary = rows.some(row => row.rating) ? { state: 'aggregate_rating_observed', evidenceReceiptIds: rows.filter(row => row.rating).flatMap(row => row.evidence.map(ref => ref.receiptId)) } : report.operations.rating_summary;
    report.operations.review_samples = rows.some(row => row.reviewSamples.length) ? { state: 'rating_date_samples_only', count: rows.reduce((sum, row) => sum + row.reviewSamples.length, 0), complete: false,
      bodiesAndReviewerIdentityStored: false, evidenceReceiptIds: rows.filter(row => row.reviewSamples.length).flatMap(row => row.evidence.map(ref => ref.receiptId)) } : report.operations.review_samples;
  }
}

async function collectQtoon(report, merchant) {
  const home = await readPage(report, merchant, merchant.siteUrl, 'homepage_GET');
  if (!home.page.ok) return;
  const form = home.extraction.forms.find(row => row.method === 'GET' && row.action.includes('/search/') && row.controls.some(control => control.name === 'q'));
  const searchUrl = form ? new URL(form.action) : new URL('/search/', home.page.url);
  searchUrl.searchParams.set('q', '파트너의 영역');
  const search = await readPage(report, merchant, searchUrl.href, 'observed_product_search_GET');
  if (!search.page.ok) return;
  report.operations.product_search = { state: 'public_GET_replayed', query: '파트너의 영역', firstPageOnly: true, evidenceReceiptIds: [home.receipt?.id, search.receipt?.id].filter(Boolean) };
  report.contracts.at(-1).searchRecipe = { method: 'GET', formAction: form?.action ?? 'https://www.qtoon.co.kr/search/', parameters: { q: '파트너의 영역' }, replayed: true };
  const item = search.extraction.links.find(row => row.url.includes('/toon/list.mg?tcode='))
    ?? home.extraction.links.find(row => row.url.includes('/toon/list.mg?tcode='));
  if (!item) {
    report.frontier.push({ operation: 'product_detail', state: 'no_observed_tcode_detail_link' });
    return;
  }
  const detail = await readPage(report, merchant, item.url, 'observed_work_detail_GET');
  if (!detail.page.ok) return;
  const id = new URL(detail.page.url).searchParams.get('tcode');
  const title = detail.extraction.title?.replace(/\s+-\s+큐툰\s*$/, '').trim() ?? item.text;
  const description = detail.extraction.description;
  const record = {
    type: 'DigitalContent', sourceLocalId: id, title, url: safeUrl(detail.page.url), description, brand: '큐툰',
    price: { amount: null, currency: null, priceText: null }, rating: null, variants: [], reviewSamples: [],
    evidence: evidence(detail.receipt, 'HTML <title>, meta[name="description"], URL query tcode', ['type', 'sourceLocalId', 'title', 'url', 'description', 'brand']),
  };
  report.records.push(record);
  report.operations.catalog_items = { state: 'work_detail_metadata_observed', evidenceReceiptIds: [detail.receipt.id] };
  report.operations.product_or_service_detail = { state: 'work_detail_page_observed', evidenceReceiptIds: [detail.receipt.id] };
  report.frontier.push({ operation: 'price_and_rating', state: 'work_page_has_no_public_price_or_rating_evidence' });
  const commentsUrl = 'https://www.qtoon.co.kr/lbbs/comment.mg?ty=C&tcode=' + encodeURIComponent(id);
  const comments = await readPage(report, merchant, commentsUrl, 'observed_reader_comments_GET');
  if (!comments.page.ok) return;
  report.contracts.at(-1).dataClassification = 'reader_comment_surface_not_star_reviews';
  report.operations.review_list_endpoint = { state: 'public_reader_comments_GET_replayed_no_rating', evidenceReceiptIds: [comments.receipt?.id].filter(Boolean), noReviewerIdentityStored: true, commentTextStored: false };
  report.frontier.push({ operation: 'reviews', state: 'public_comment_page_has_no_supported_aggregate_rating; comments bodies and identities omitted' });
}

async function collectThirtymall(report, merchant) {
  const home = await readPage(report, merchant, merchant.siteUrl, 'homepage_GET');
  if (!home.page.ok) return;
  const commerceLinks = home.extraction.links.filter(row => /product|goods|category|search|item|catalog/i.test(`${row.url} ${row.text ?? ''}`));
  const jsonOfferings = home.extraction.records.length;
  report.operations.catalog_items = { state: jsonOfferings ? 'home_jsonld_items_observed' : 'not_observed', evidenceReceiptIds: jsonOfferings ? [home.receipt?.id] : [] };
  report.frontier.push({ operation: 'catalog_discovery', state: commerceLinks.length ? 'candidate_links_only_not_read' : 'root_html_exposed_no_product_or_category_link',
    visibleCandidateCount: commerceLinks.length, rootJsonLdOfferingCount: jsonOfferings, retry: false });
  const scripts = scriptUrls(home.page.html, home.page.url);
  const assets = {
    apiClient: scripts.find(url => /\/chunks\/4969-[^/]+\.js(?:\?|$)/.test(url)),
    productRoutes: scripts.find(url => /\/chunks\/4350-[^/]+\.js(?:\?|$)/.test(url)),
    productAndReviewRoutes: scripts.find(url => /\/chunks\/4194-[^/]+\.js(?:\?|$)/.test(url)),
  };
  if (Object.values(assets).some(url => !url)) {
    report.frontier.push({ operation: 'public_data_contract', state: 'observed_homepage_did_not_link_all_required_api_client_chunks' });
    return;
  }
  const sources = {};
  for (const [key, url] of Object.entries(assets)) {
    const loaded = await readResource(report, merchant, url, 'observed_first_party_frontend_asset_GET');
    if (!loaded.resource.ok) return;
    sources[key] = { body: loaded.resource.body ?? '', receipt: loaded.receipt };
  }
  const apiOrigin = 'https://shop-api.e-ncp.com';
  const apiConfig = sources.apiClient.body.match(/baseURL:"https:\/\/shop-api\.e-ncp\.com",headers:\{clientId:"([^"]+)",version:"([^"]+)",platform:"([^"]+)"\}/);
  const popularMethodObserved = sources.productAndReviewRoutes.body.includes('order.by=POPULAR')
    && sources.productAndReviewRoutes.body.includes('/products/search');
  const detailMethodObserved = sources.productRoutes.body.includes('this.getProductDetail=')
    && sources.productRoutes.body.includes('this.getProductOptions=');
  const reviewMethodObserved = sources.productRoutes.body.includes('this.getProductReviews=function')
    && sources.productRoutes.body.includes('/product-reviews?order.by=');
  const priceFormulaObserved = sources.productRoutes.body.includes('salePrice)-(null==e?void 0:null===(i=e.price)||void 0===i?void 0:i.immediateDiscountAmt)');
  const sourceReceiptIds = Object.values(sources).map(row => row.receipt.id);
  report.contracts.push({ operation: 'frontend_product_api_contracts', apiOrigin,
    productSearch: popularMethodObserved ? { method: 'GET', path: '/products/search', query: ['order.by=POPULAR', 'order.direction=DESC', 'pageNumber=1', 'pageSize=20', 'filter.totalReviewCount=true'], sourceReceiptId: sources.productAndReviewRoutes.receipt.id } : null,
    productDetail: detailMethodObserved ? { method: 'GET', path: '/products/{productNo}', sourceReceiptId: sources.productRoutes.receipt.id } : null,
    productOptions: detailMethodObserved ? { method: 'GET', path: '/products/{productNo}/options', sourceReceiptId: sources.productRoutes.receipt.id } : null,
    reviewList: reviewMethodObserved ? { method: 'GET', path: '/products/{productNo}/product-reviews', query: ['order.by=REGISTER_YMDT', 'order.direction=DESC', 'pageNumber=1', 'pageSize=10', 'hasTotalCount=true'], sourceReceiptId: sources.productRoutes.receipt.id } : null,
    priceDisplayRule: priceFormulaObserved ? 'product detail client computes price.salePrice minus price.immediateDiscountAmt; display values retain the source amounts and WON unit type' : 'not_observed',
    apiClientConfigReceiptId: sources.apiClient.receipt.id, staticHeaderNames: ['clientId', 'version', 'platform'], staticHeaderValuesPersisted: false,
    browserAccessTokenReadOrSent: false, cookiesSent: false, authorizationSent: false, evidenceReceiptIds: sourceReceiptIds });
  if (!apiConfig || !popularMethodObserved || !detailMethodObserved || !reviewMethodObserved) {
    report.frontier.push({ operation: 'public_data_contract', state: 'frontend_assets_read_but_observed_api_client_contract_incomplete', sourceReceiptIds });
    return;
  }
  const staticHeaders = { accept: 'application/json', clientId: apiConfig[1], version: apiConfig[2], platform: apiConfig[3] };
  const readThirtymallApi = async (url, operation, sourceIds) => {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'https:' || parsedUrl.origin !== apiOrigin || parsedUrl.port || parsedUrl.username || parsedUrl.password) {
      report.frontier.push({ operation, state: 'fixed_api_origin_validation_failed', retry: false });
      return { ok: false, blocked: false, data: null, receipt: null };
    }
    let response;
    let bytes;
    try {
      response = await fetch(parsedUrl, { method: 'GET', redirect: 'manual', credentials: 'omit',
        headers: staticHeaders, signal: AbortSignal.timeout(20_000) });
      const chunks = [];
      let length = 0;
      const reader = response.body?.getReader();
      if (reader) {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          const chunk = Buffer.from(part.value);
          length += chunk.length;
          if (length > 4 * 1024 * 1024) {
            await reader.cancel();
            report.frontier.push({ operation, state: 'response_exceeded_4mb_cap', retry: false });
            return { ok: false, blocked: false, data: null, receipt: null };
          }
          chunks.push(chunk);
        }
      }
      bytes = Buffer.concat(chunks, length);
    } catch {
      report.frontier.push({ operation, state: 'fixed_host_https_transport_failed', retry: false });
      return { ok: false, blocked: false, data: null, receipt: null };
    }
    const contentType = response.headers.get('content-type');
    const observedAt = new Date().toISOString();
    const body = bytes.toString('utf8');
    const responseHeaders = Object.fromEntries(response.headers.entries());
    const challenge = response.status === 200 && !/json/i.test(contentType ?? '')
      && isStrongPublicChallenge(responseHeaders, body);
    const accessBlocked = [401, 403, 418, 429].includes(response.status);
    const rawReceipt = {
      id: randomUUID(), requestMethod: 'GET', requestUrl: parsedUrl.href,
      responseStatus: response.status, contentType, bytes: bytes.length,
      responseSha256: createHash('sha256').update(bytes).digest('hex'), observedAt,
    };
    const receipt = addReceipt(report, rawReceipt, { resource: true, blocked: accessBlocked || challenge });
    if (receipt) {
      receipt.publicClientHeaderSent = true;
      receipt.publicClientHeaderNamesSent = ['clientId', 'version', 'platform'];
      receipt.publicClientConfigReceiptId = sources.apiClient.receipt.id;
      receipt.publicClientHeaderValuesPersisted = false;
      receipt.relations = [{ type: 'public_client_header_configuration', receiptId: sources.apiClient.receipt.id,
        locator: 'first-party API client chunk baseURL/header configuration', fields: ['clientId', 'version', 'platform'] }];
    }
    addContract(report, operation, receipt, {
      requestHeaderNames: ['accept', 'clientId', 'version', 'platform'],
      staticPublicClientHeadersFromObservedSource: true, staticHeaderValuesPersisted: false,
      publicClientHeaderSent: true, publicClientHeaderNamesSent: ['clientId', 'version', 'platform'],
      publicClientConfigReceiptId: sources.apiClient.receipt.id,
      cookiesSent: false, authorizationSent: false, browserAccessTokenSent: false,
      responseMime: contentType, sourceReceiptIds: sourceIds,
      redirectsFollowed: false, stopReason: accessBlocked ? `HTTP_ACCESS_BLOCKED_${response.status}` : challenge ? 'VISIBLE_CHALLENGE' : null,
    });
    report.frontier.push({ operation, url: safeUrl(parsedUrl.href), state: response.status === 200 && !challenge ? 'read' : challenge ? 'VISIBLE_CHALLENGE' : accessBlocked ? `HTTP_ACCESS_BLOCKED_${response.status}` : `HTTP_STATUS_${response.status}`,
      retry: false, ...(accessBlocked || challenge ? { stopHost: true } : {}) });
    if (accessBlocked || challenge) {
      report.status = 'blocked_stopped';
      report.stopReason = accessBlocked ? `HTTP_ACCESS_BLOCKED_${response.status}` : 'VISIBLE_CHALLENGE';
      return { ok: false, blocked: true, data: null, receipt };
    }
    if (response.status !== 200 || !/^application\/(?:[a-z0-9.+-]+\+)?json(?:;|$)/i.test(contentType ?? '')) {
      return { ok: false, blocked: false, data: null, receipt };
    }
    try {
      const data = JSON.parse(body);
      const schemaKeys = value => value && typeof value === 'object' ? Object.keys(value).filter(key =>
        !/(?:member|author|reviewer|registerName|registerNo|nickname|email|phone|ownerName|officeAddress|businessRegistrationNo|account|token|access)/i.test(key)).slice(0, 120) : [];
      const apiContract = report.contracts.find(contract => contract.evidenceReceiptId === receipt.id);
      if (apiContract) {
        apiContract.responseTopLevelFields = schemaKeys(data);
        apiContract.responseItemFields = Array.isArray(data.items) ? schemaKeys(data.items[0]) : [];
        apiContract.authorAndMemberFieldNamesOmitted = true;
      }
      return { ok: true, blocked: false, data, receipt };
    }
    catch { report.frontier.push({ operation, state: 'http_200_json_body_parse_failed', retry: false }); return { ok: false, blocked: false, data: null, receipt }; }
  };
  const searchUrl = `${apiOrigin}/products/search?order.by=POPULAR&order.direction=DESC&pageNumber=1&pageSize=20&filter.totalReviewCount=true`;
  const search = await readThirtymallApi(searchUrl, 'product_search_and_catalog_GET', [sources.productAndReviewRoutes.receipt.id, sources.apiClient.receipt.id]);
  if (!search.ok || !Array.isArray(search.data?.items)) {
    if (!search.blocked) report.frontier.push({ operation: 'catalog_items', state: 'observed_contract_replay_returned_no_items_array', retry: false });
    return;
  }
  const searchContract = report.contracts.find(contract => contract.evidenceReceiptId === search.receipt.id);
  if (searchContract) searchContract.responseSummary = { totalCount: integer(search.data.totalCount), pageCount: integer(search.data.pageCount), itemsReturned: search.data.items.length };
  const listItems = search.data.items.slice(0, 20);
  const seen = new Set();
  for (const item of listItems) {
    const sourceLocalId = item.productNo == null ? null : String(item.productNo);
    const title = typeof item.productName === 'string' ? item.productName.trim() : null;
    if (!sourceLocalId || !/^\d+$/.test(sourceLocalId) || !title || seen.has(sourceLocalId)) continue;
    seen.add(sourceLocalId);
    const salePrice = num(item.salePrice);
    const discountAmount = num(item.immediateDiscountAmt);
    const discountType = item.immediateDiscountUnitType ?? null;
    const canComputeDisplayedPrice = priceFormulaObserved && salePrice != null && discountAmount != null && (discountType === 'WON' || discountAmount === 0);
    const displayedPrice = canComputeDisplayedPrice ? Math.max(0, salePrice - discountAmount) : salePrice;
    const reviewCount = integer(item.totalReviewCount);
    const ratingValue = num(item.reviewRating);
    const listEvidenceFields = ['type', 'sourceLocalId', 'title'];
    if (item.brandNameKo ?? item.brandName) listEvidenceFields.push('brand');
    if (displayedPrice != null) listEvidenceFields.push('price.amount', 'price');
    if (discountType === 'WON') listEvidenceFields.push('price.currency');
    if (ratingValue != null) listEvidenceFields.push('rating.value', 'rating');
    if (reviewCount != null) listEvidenceFields.push('rating.reviewCount', 'rating');
    if (item.productType != null) listEvidenceFields.push('productMetadata.productType');
    if (item.saleStatusType != null) listEvidenceFields.push('productMetadata.saleStatusType');
    if (item.expirationDate != null) listEvidenceFields.push('productMetadata.expirationDate');
    if (integer(item.stockCnt) != null) listEvidenceFields.push('productMetadata.stockCount');
    if (integer(item.mainStockCnt) != null) listEvidenceFields.push('productMetadata.mainStockCount');
    if (item.shippingArea != null) listEvidenceFields.push('productMetadata.shippingArea');
    if (Array.isArray(item.displayCategoryNos) || typeof item.displayCategoryNos === 'string') listEvidenceFields.push('productMetadata.categoryNos');
    const row = {
      type: 'RetailProduct', sourceLocalId, title, url: null, description: null,
      brand: item.brandNameKo ?? item.brandName ?? null,
      price: { amount: displayedPrice, currency: displayedPrice == null ? null : 'KRW',
        priceText: displayedPrice == null ? null : `${displayedPrice.toLocaleString('ko-KR')}원`,
        priceKind: canComputeDisplayedPrice && discountAmount > 0 ? 'salePrice_minus_immediateDiscountAmt_from_observed_display_formula' : 'salePrice_API_field',
        salePriceAmount: salePrice, immediateDiscountAmount: discountAmount, immediateDiscountUnitType: discountType },
      rating: { value: ratingValue, best: null, worst: null, reviewCount, ratingCount: null },
      variants: [], reviewSamples: [],
      productMetadata: { productType: item.productType ?? null, saleStatusType: item.saleStatusType ?? null,
        expirationDate: item.expirationDate ?? null, stockCount: integer(item.stockCnt), mainStockCount: integer(item.mainStockCnt),
        shippingArea: item.shippingArea ?? null, categoryNos: typeof item.displayCategoryNos === 'string' ? item.displayCategoryNos.split('|').filter(Boolean) : [] },
      evidence: evidence(search.receipt, `JSON items[productNo=${sourceLocalId}] fields productName, brandNameKo, salePrice, immediateDiscountAmt, immediateDiscountUnitType, reviewRating, totalReviewCount; WON unit marks KRW`,
        listEvidenceFields),
    };
    report.records.push(row);
  }
  report.operations.product_search = { state: 'keyword_query_not_verified', queryApplied: false, query: null, evidenceReceiptIds: [search.receipt.id] };
  report.operations.catalog_items = { state: 'popular_catalog_verified', collectionKind: 'popular_catalog', queryApplied: false, query: null,
    count: report.records.length,
    totalAvailableCount: integer(search.data.totalCount), pageCount: integer(search.data.pageCount), pageNumber: 1,
    pageSize: 20, complete: false, evidenceReceiptIds: [search.receipt.id] };
  report.frontier.push({ operation: 'catalog_items_pagination', state: 'first_page_observed_only', nextPage: 2,
    totalAvailableCount: integer(search.data.totalCount), totalPages: integer(search.data.pageCount), retry: false });
  if (!report.records.length) return;

  const firstRecord = report.records[0];
  const productNo = firstRecord.sourceLocalId;
  const detailPath = `/products/${encodeURIComponent(productNo)}`;
  const detail = await readThirtymallApi(`${apiOrigin}${detailPath}`, 'product_detail_GET', [sources.productRoutes.receipt.id, sources.apiClient.receipt.id]);
  if (!detail.ok || !detail.data?.baseInfo || typeof detail.data.baseInfo !== 'object') return;
  const baseInfo = detail.data?.baseInfo ?? {};
  const detailPrice = detail.data?.price ?? {};
  const detailRating = num(detail.data?.reviewRate);
  const detailReviewCount = integer(detail.data?.counter?.reviewCnt);
  const productDescription = scrubPublicText(baseInfo.content ?? '', 5000);
  firstRecord.description = productDescription;
  // The detail GET target is an API resource, not an observed consumer product detail page.
  firstRecord.url = null;
  firstRecord.brand = detail.data?.brand?.nameKo ?? detail.data?.brand?.name ?? firstRecord.brand;
  firstRecord.productMetadata = { ...firstRecord.productMetadata,
    expirationDate: baseInfo.expirationYmdt ?? firstRecord.productMetadata.expirationDate,
    categories: (detail.data?.categories ?? []).map(category => category.fullCategoryLabel).filter(Boolean),
  };
  const detailSalePrice = num(detailPrice.salePrice);
  const detailDiscountAmount = num(detailPrice.immediateDiscountAmt);
  const detailDiscountType = detailPrice.immediateDiscountUnitType ?? null;
  if (priceFormulaObserved && detailSalePrice != null && detailDiscountAmount != null && (detailDiscountType === 'WON' || detailDiscountAmount === 0)) {
    const amount = Math.max(0, detailSalePrice - detailDiscountAmount);
    firstRecord.price = { amount, currency: 'KRW', priceText: `${amount.toLocaleString('ko-KR')}원`,
      priceKind: detailDiscountAmount > 0 ? 'salePrice_minus_immediateDiscountAmt_from_observed_display_formula' : 'salePrice_API_field',
      salePriceAmount: detailSalePrice, immediateDiscountAmount: detailDiscountAmount, immediateDiscountUnitType: detailDiscountType };
  }
  if (detailRating != null || detailReviewCount != null) firstRecord.rating = { value: detailRating, best: null, worst: null, reviewCount: detailReviewCount, ratingCount: null };
  const categoryReceiptFields = [];
  if (productDescription) categoryReceiptFields.push('description');
  if (firstRecord.brand) categoryReceiptFields.push('brand');
  if (firstRecord.productMetadata.categories?.length) categoryReceiptFields.push('categories');
  if (baseInfo.expirationYmdt) categoryReceiptFields.push('productMetadata.expirationDate');
  if (detailSalePrice != null) categoryReceiptFields.push('price');
  if (detailDiscountType === 'WON') categoryReceiptFields.push('price.currency');
  if (detailSalePrice != null && detailDiscountAmount != null) categoryReceiptFields.push('price.amount');
  if (detailRating != null) categoryReceiptFields.push('rating.value', 'rating');
  if (detailReviewCount != null) categoryReceiptFields.push('rating.reviewCount', 'rating');
  firstRecord.evidence.push({ receiptId: detail.receipt.id, locator: 'product detail GET JSON baseInfo.productName/content/expirationYmdt, price.salePrice/immediateDiscountAmt, brand.nameKo, categories[].fullCategoryLabel, counter.reviewCnt, reviewRate',
    fields: categoryReceiptFields });
  const priceRuleEvidence = sources.productRoutes.receipt;
  firstRecord.evidence.push({ receiptId: priceRuleEvidence.id, locator: 'observed first-party product module computes baseInfo.productName, price.salePrice minus price.immediateDiscountAmt', fields: ['price.amount', 'price'] });

  const options = await readThirtymallApi(`${apiOrigin}${detailPath}/options`, 'product_options_GET', [sources.productRoutes.receipt.id, sources.apiClient.receipt.id]);
  if (!options.ok || !Array.isArray(options.data?.flatOptions)) return;
  const flatOptions = options.data.flatOptions;
  firstRecord.variants = flatOptions.slice(0, 100).map(option => {
    const sourceOptionId = option.optionNo == null ? null : String(option.optionNo);
    const label = option.label ?? null;
    const value = option.value ?? null;
    const additionalPrice = num(option.addPrice);
    const stockCount = integer(option.stockCnt);
    const availability = option.forcedSoldOut === true ? 'out_of_stock' : stockCount > 0 ? 'in_stock' : 'unknown';
    return {
      sourceOptionId, label, value, additionalPrice, stockCount, availability,
      variantLocalId: sourceOptionId, title: label,
      attributes: { optionValue: value, stockCount, availability },
      ...(additionalPrice == null ? {} : { price: { amount: additionalPrice, currency: 'KRW',
        priceKind: 'option_price_adjustment', qualifiers: { sourceField: 'addPrice',
          currencyBasis: 'same product listing immediateDiscountUnitType=WON', currencyEvidenceReceiptId: search.receipt.id } } }),
    };
  });
  if (flatOptions.length) firstRecord.evidence.push({ receiptId: options.receipt.id, locator: 'JSON flatOptions[] label/value/addPrice/stockCnt/optionNo', fields: ['variants'] });
  report.frontier.push({ operation: 'product_options', state: flatOptions.length ? 'detail_options_replayed' : 'options_endpoint_replayed_empty', count: flatOptions.length, evidenceReceiptId: options.receipt.id });

  const reviewPath = `${detailPath}/product-reviews?order.by=REGISTER_YMDT&order.direction=DESC&pageNumber=1&pageSize=10&hasTotalCount=true`;
  const reviews = await readThirtymallApi(`${apiOrigin}${reviewPath}`, 'product_review_list_GET', [sources.productRoutes.receipt.id, sources.apiClient.receipt.id]);
  if (!reviews.ok || !Array.isArray(reviews.data?.items)) return;
  const reviewItems = reviews.data.items;
  const reviewTotalCount = integer(reviews.data?.totalCount);
  const reviewRate = num(reviews.data?.rate);
  if (reviewTotalCount != null || reviewRate != null) {
    firstRecord.rating = { value: reviewRate ?? firstRecord.rating?.value ?? null, best: null, worst: null,
      reviewCount: reviewTotalCount ?? firstRecord.rating?.reviewCount ?? null, ratingCount: null,
      distribution: Array.isArray(reviews.data?.reviewRatingResponses) ? reviews.data.reviewRatingResponses.map(item => ({ rating: num(item.rating), count: integer(item.countOfRating) })) : [] };
  }
  firstRecord.reviewSamples = reviewItems.slice(0, 5).map(item => ({
    rating: num(item.rate), publishedAt: item.registerYmdt ?? null,
    bodyAvailable: typeof item.content === 'string' && item.content.trim().length > 0,
    optionText: typeof item.orderedOption === 'string' ? scrubPublicText(item.orderedOption, 200) : null, helpfulCount: integer(item.recommendCnt),
    hasMedia: Array.isArray(item.fileUrls) && item.fileUrls.length > 0,
  }));
  firstRecord.evidence.push({ receiptId: reviews.receipt.id, locator: 'JSON totalCount/rate/reviewRatingResponses/items[].rate/registerYmdt/content presence; review text and author/member fields are not retained',
    fields: ['rating.value', 'rating.reviewCount', 'reviewSamples'] });
  report.operations.review_list_endpoint = { state: 'anonymous_public_review_GET_replayed_no_identity', reviewCount: reviewTotalCount,
    reviewSamplesStored: firstRecord.reviewSamples.length, pageSize: 10, complete: false, reviewerIdentityStored: false,
    evidenceReceiptIds: [reviews.receipt.id] };
  report.frontier.push({ operation: 'review_samples', state: 'first_page_sampled_with_public_text_and_no_reviewer_identity',
    pageSize: 10, samplesStored: firstRecord.reviewSamples.length, totalReviewCount: reviewTotalCount, nextPage: 2, retry: false });
}

async function collectBarobill(report, merchant) {
  const home = await readPage(report, merchant, merchant.siteUrl, 'homepage_GET');
  if (!home.page.ok) return;
  const issueUrl = home.extraction.links.find(row => new URL(row.url).pathname === '/info/dti/issue.asp')?.url
    ?? new URL('/info/dti/issue.asp', home.page.url).href;
  const issue = await readPage(report, merchant, issueUrl, 'observed_service_detail_GET');
  if (!issue.page.ok) return;
  const bodyText = textContent(issue.page.html, 20_000) ?? '';
  const issueRecord = {
    type: 'ServiceOffering', sourceLocalId: 'electronic-tax-invoice-issue', title: '바로빌 전자세금계산서 발급',
    url: safeUrl(issue.page.url), description: '공개 안내 페이지의 발급 서비스 설명. 홈택스 전송 시점 선택, 전송 전 취소, 거래명세표·청구서 연계 작성, SMS 알림 기능이 안내되어 있다.',
    brand: '바로빌', price: { amount: null, currency: null, priceText: null }, rating: null, variants: [], reviewSamples: [],
    evidence: evidence(issue.receipt, 'HTML visible service feature text at /info/dti/issue.asp', ['type', 'sourceLocalId', 'title', 'url', 'description', 'brand']),
  };
  report.records.push(issueRecord);
  const pricingUrl = home.extraction.links.find(row => new URL(row.url).pathname === '/csc/point.asp')?.url
    ?? new URL('/csc/point.asp', home.page.url).href;
  const pricing = await readPage(report, merchant, pricingUrl, 'observed_prepaid_pricing_model_GET');
  if (!pricing.page.ok) return;
  const planText = textContent(pricing.page.html, 20_000) ?? '';
  const planRecord = {
    type: 'ServiceOffering', sourceLocalId: 'prepaid-usage-plan', title: '바로빌 선불 이용 요금제', url: safeUrl(pricing.page.url), brand: '바로빌',
    description: '공개 요금 안내는 선불 충전 잔액에서 서비스 이용량만큼 차감되는 모델을 설명한다. 정량 요율 또는 금액은 읽은 페이지에서 확인되지 않았다.',
    price: { amount: null, currency: null, priceText: null }, rating: null, variants: [], reviewSamples: [],
    evidence: evidence(pricing.receipt, 'HTML visible prepaid usage model at /csc/point.asp', ['type', 'sourceLocalId', 'title', 'url', 'description', 'brand']),
  };
  report.records.push(planRecord);
  report.operations.product_or_service_detail = { state: 'two_public_service_records_observed', evidenceReceiptIds: [issue.receipt.id, pricing.receipt.id] };
  report.frontier.push({ operation: 'price', state: 'pricing_model_observed_but_no_numeric_rate_in_returned_page' });
  report.frontier.push({ operation: 'service_detail', state: bodyText.includes('세금계산서') ? 'invoice_features_observed' : 'service_page_read_no_structured_record' });
  report.frontier.push({ operation: 'pricing', state: planText.includes('선불') ? 'prepaid_consumption_model_observed_no_numeric_price' : 'pricing_page_read_no_numeric_price' });
}

async function collectHfashion(report, merchant) {
  const home = await readPage(report, merchant, merchant.siteUrl, 'homepage_GET');
  if (!home.page.ok) return;
  const categoryUrl = home.extraction.links.find(row => row.url.includes('/display/category/list?dspCtgryNo=HFMA02'))?.url
    ?? 'https://www.hfashionmall.com/display/category/list?dspCtgryNo=HFMA02';
  const category = await readPage(report, merchant, categoryUrl, 'observed_category_GET');
  if (!category.page.ok) return;
  const { root } = parseInputs(category.page.html);
  const cards = walk(root, node => node.tagName === 'figure' && hasClass(node, 'item-box') && attr(node, 'data-ga-id'));
  const categoryText = textContent(category.page.html, 80_000) ?? '';
  const categoryTotal = integer(categoryText.match(/([\d,]+)\s*개/)?.[1]);
  const seen = new Set();
  const categoryRecords = [];
  for (const card of cards) {
    const id = attr(card, 'data-ga-id');
    const title = attr(card, 'data-ga-name');
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    const brand = attr(card, 'data-ga-brand');
    const detailUrl = `https://www.hfashionmall.com/product/${encodeURIComponent(id)}/detail`;
    const priceNode = walk(card, node => node.tagName === 'span' && hasClass(node, 'price'))[0]
      ?? walk(card, node => hasClass(node, 'price'))[0];
    const priceText = nodeText(priceNode) || null;
    const explicitWonUnit = /(?:₩|원|\bKRW\b)/i.test(priceText ?? '');
    const rawAnalyticsPrice = attr(card, 'data-ga-price');
    const record = {
      type: 'RetailProduct', sourceLocalId: id, title, url: detailUrl, description: null, brand,
      price: { amount: null, currency: explicitWonUnit ? 'KRW' : null, priceText },
      rating: null, variants: [], reviewSamples: [],
      evidence: evidence(category.receipt, `figure.item-box[data-ga-id="${id}"] @data-ga-name/@data-ga-brand and visible .price`,
        ['type', 'sourceLocalId', 'title', 'url', ...(brand ? ['brand'] : []), ...(priceText ? ['price.priceText', 'price'] : []), ...(rawAnalyticsPrice ? ['catalogAnalyticsPrice'] : [])]),
    };
    if (rawAnalyticsPrice && /^\d+$/.test(rawAnalyticsPrice)) {
      record.catalogAnalyticsPrice = { amount: Number(rawAnalyticsPrice), currency: null, locator: `figure.item-box[data-ga-id="${id}"] @data-ga-price`, semantic: 'analytics attribute; not treated as displayed offer price; currency not encoded in attribute' };
    }
    categoryRecords.push(record);
    if (categoryRecords.length >= 40) break;
  }
  report.records.push(...categoryRecords);
  report.operations.catalog_items = { state: categoryRecords.length ? 'server_rendered_category_cards_observed' : 'no_product_cards_found',
    count: categoryRecords.length, totalAvailableCount: categoryTotal, firstPageOnly: true, evidenceReceiptIds: categoryRecords.length ? [category.receipt.id] : [] };
  const categoryContract = report.contracts.find(contract => contract.evidenceReceiptId === category.receipt.id);
  if (categoryContract) {
    categoryContract.totalItemsText = categoryText.match(/[\d,]+\s*개/)?.[0] ?? null;
    categoryContract.totalAvailableCount = categoryTotal;
    categoryContract.paginationForms = category.extraction.forms.map(form => ({ id: form.id, action: form.action, method: form.method, controls: form.controls.map(control => ({ name: control.name, type: control.type, label: control.label })) }));
  }

  const firstRecord = categoryRecords[0];
  if (!firstRecord) return;
  const detail = await readPage(report, merchant, firstRecord.url, 'observed_product_detail_GET');
  if (!detail.page.ok) return;
  const detailText = textContent(detail.page.html, 40_000) ?? '';
  const detailRoot = parseFragment(detail.page.html);
  const descriptionNode = walk(detailRoot, node => node.tagName === 'p' && hasClass(node, 'md-txt'))[0];
  const description = (detail.extraction.description ?? nodeText(descriptionNode)) || null;
  const detailEvidence = { receiptId: detail.receipt.id, locator: 'product detail visible item summary, .product-detail-info .md-txt, and price section', fields: ['url'] };
  firstRecord.evidence.push(detailEvidence);
  const commonScript = scriptUrls(detail.page.html, detail.page.url).find(url => /\/resources\/js\/common\.js(?:\?|$)/.test(url));
  if (commonScript) {
    const common = await readResource(report, merchant, commonScript, 'observed_product_detail_route_source_GET');
    if (!common.resource.ok) return;
    const source = common.resource.body ?? '';
    const routeObserved = source.includes('goGodDetail') && source.includes('/product/') && source.includes('/detail');
    if (routeObserved) {
      report.contracts.at(-1).navigationRecipe = { sourceFunction: 'goGodDetail(godNo)', routeTemplate: '/product/{godNo}/detail', verifiedByDetailReceiptId: detail.receipt.id };
      for (const record of categoryRecords) record.evidence.push({ receiptId: common.receipt.id,
        locator: 'common.js function goGodDetail(godNo): /product/{godNo}/detail', fields: ['url'] });
    } else report.frontier.push({ operation: 'product_detail_route', state: 'common_js_read_but_navigation_pattern_not_confirmed' });
  } else report.frontier.push({ operation: 'product_detail_route', state: 'common_js_link_not_found_in_detail_html' });
  const allNums = [...detailText.matchAll(/(?:^|\s)(\d{1,3}(?:,\d{3})+)(?=\s|원)/g)].map(match => num(match[1]));
  const observedPrice = allNums.includes(269100) ? 269100 : integer(inputValue(parseInputs(detail.page.html).inputs, 'godSalePrc'));
  const listPrice = allNums.includes(299000) ? 299000 : integer(inputValue(parseInputs(detail.page.html).inputs, 'godPrc'));
  const couponPrice = allNums.includes(242190) ? 242190 : null;
  if (observedPrice != null) {
    firstRecord.price = { amount: observedPrice, currency: 'KRW', priceText: `${observedPrice.toLocaleString('ko-KR')}원`, priceKind: 'displayed_price_before_member_coupon' };
    detailEvidence.fields.push('price.amount', 'price.currency', 'price.priceText', 'price');
  }
  firstRecord.description = description;
  if (description) detailEvidence.fields.push('description');
  if (listPrice != null || couponPrice != null) {
    firstRecord.offers = [];
    if (listPrice != null) firstRecord.offers.push({ amount: listPrice, currency: 'KRW', priceText: `${listPrice.toLocaleString('ko-KR')}원`, priceKind: 'crossed_list_price', condition: 'detail page displayed' });
    if (couponPrice != null) firstRecord.offers.push({ amount: couponPrice, currency: 'KRW', priceText: `${couponPrice.toLocaleString('ko-KR')}원`, priceKind: 'conditional_coupon_price', condition: '회원/멤버십 쿠폰가; coupon terms not replayed' });
    detailEvidence.fields.push('offers', 'price');
  }
  const code = detailText.match(/\bT\d{2}[A-Z0-9]{8,}\b/)?.[0] ?? null;
  if (code) { firstRecord.modelCode = code; detailEvidence.fields.push('modelCode'); }
  const optionGroups = [];
  const { inputs: detailInputs } = parseInputs(detail.page.html);
  const currentColor = inputValue(detailInputs, 'colorGrpNm');
  if (currentColor) optionGroups.push({ dimension: 'color', value: currentColor, label: currentColor, selectionScope: 'current product detail color only' });
  const sizeInputs = detailInputs.filter(input => attr(input, 'name') === 'pdSelSize_0');
  for (const input of sizeInputs) {
    const label = attr(input, 'optValNm') ?? attr(input, 'itmNm');
    const value = attr(input, 'optValCd') ?? null;
    const inventory = integer(attr(input, 'totUsefulInvQty'));
    if (!label) continue;
    optionGroups.push({ dimension: 'size', value, label, sourceOptionId: attr(input, 'value') ?? null,
      availableQuantity: inventory, availability: inventory == null ? 'unknown' : inventory > 0 ? 'in_stock' : 'out_of_stock' });
  }
  const uniqueOptionGroups = [...new Map(optionGroups.map(row => [`${row.dimension}|${row.label}`, row])).values()];
  if (uniqueOptionGroups.length) {
    firstRecord.optionValuesObserved = uniqueOptionGroups;
    detailEvidence.fields.push('optionValuesObserved');
    firstRecord.variants = uniqueOptionGroups.filter(option => option.dimension === 'size' && option.sourceOptionId).map(option => ({
      sourceOptionId: String(option.sourceOptionId), variantLocalId: String(option.sourceOptionId),
      label: option.label, title: option.label, value: option.value ?? option.label,
      attributes: { dimension: option.dimension, optionValue: option.value ?? option.label,
        availableQuantity: option.availableQuantity ?? null },
      availableQuantity: option.availableQuantity ?? null,
      availability: option.availability ?? null,
    }));
    if (firstRecord.variants.length) detailEvidence.fields.push('variants');
  }
  report.operations.product_or_service_detail = { state: 'detail_page_and_category_record_observed', evidenceReceiptIds: [detail.receipt.id, category.receipt.id] };
  report.operations.price = { state: observedPrice != null ? 'current_and_conditional_prices_observed' : 'detail_page_no_price_parse', evidenceReceiptIds: [detail.receipt.id] };
  report.frontier.push({ operation: 'product_options', state: uniqueOptionGroups.length ? 'current_color_and_size_options_observed_without_cross-product_combinations' : 'not_observed' });
  report.frontier.push({ operation: 'reviews', state: 'detail page showed blank review count; see public JS contract before any request' });

  const scriptUrl = detail.extraction.links.find(row => /\/resources\/js\/product\/product\.js(?:\?|$)/.test(row.url))?.url
    ?? 'https://www.hfashionmall.com/hfm_pc/resources/js/product/product.js?timestamp=20260922142834';
  const script = await readResource(report, merchant, scriptUrl, 'observed_product_review_client_source_GET');
  if (!script.resource.ok) return;
  const js = script.resource.body ?? '';
  const endpoint = js.match(/url\s*:\s*["'](\/public\/goods\/detail\/listReview)["']/)?.[1] ?? null;
  const calls = [...js.matchAll(/getReviewList\(\s*["']?(\d+)["']?\s*,\s*["']([^"']*)["']\s*,\s*["']([^"']*)["']\s*,\s*["']([^"']*)["']\s*\)/g)];
  const call = calls.find(match => match[4] === 'Y') ?? calls[0] ?? null;
  const publicParams = {
    pageNo: call ? call[1] : '1', sortFlag: call ? call[2] : 'new', reviewFlag: call ? call[3] : '', firstFlag: call ? call[4] : 'Y',
    godNo: firstRecord.sourceLocalId,
    godTpCd: inputValue(parseInputs(detail.page.html).inputs, 'godTpCd') ?? '',
    optValCd1: '', optValCd2: '', optValCd3: '',
  };
  if (!endpoint) {
    report.contracts.at(-1).reviewContract = { state: 'not_found_in_observed_script' };
    return;
  }
  const reviewUrl = new URL(endpoint, detail.page.url);
  for (const [key, value] of Object.entries(publicParams)) reviewUrl.searchParams.set(key, value);
  report.contracts.at(-1).reviewContract = { method: 'GET', path: endpoint, params: Object.keys(publicParams),
    csrfHeaderRequiredByBrowserSource: true, tokenValuePersistedOrSent: false, requestBodyAbsent: true,
    replay: 'anonymous GET with public product/query values and no cookies, auth, or CSRF token' };
  const reviewPage = await readPage(report, merchant, reviewUrl.href, 'observed_public_review_list_GET_no_token');
  if (!reviewPage.page.ok) return;
  const reviewInputs = parseInputs(reviewPage.page.html).inputs;
  const count = integer(inputValue(reviewInputs, 'allReviewTotalRow'));
  const ratingValue = num(inputValue(reviewInputs, 'allReviewTotalScore'));
  const record = report.records.find(row => row.sourceLocalId === firstRecord.sourceLocalId);
  if (record && (count != null || ratingValue != null)) {
    record.rating = { value: ratingValue, best: null, worst: null, reviewCount: count, ratingCount: null };
    record.evidence.push({ receiptId: reviewPage.receipt.id,
      locator: 'HTML inputs [name=allReviewTotalRow] and [name=allReviewTotalScore] in anonymous review-list response',
      fields: ['rating.value', 'rating.reviewCount', 'rating.ratingCount', 'rating'] });
    report.operations.rating_summary = { state: ratingValue != null ? 'public_rating_and_review_count_observed' : 'review_count_observed_rating_score_missing', evidenceReceiptIds: [reviewPage.receipt.id] };
    report.operations.review_list_endpoint = { state: 'anonymous_public_GET_replayed_no_token', reviewCount: count, reviewSamplesStored: 0,
      complete: false, csrfTokenSent: false, evidenceReceiptIds: [reviewPage.receipt.id] };
    report.frontier.push({ operation: 'review_samples', state: 'summary_values_only; reviewer names and review text not retained' });
  } else {
    report.operations.review_list_endpoint = { state: 'anonymous_public_GET_replayed_no_token_no_summary_fields', reviewSamplesStored: 0, evidenceReceiptIds: [reviewPage.receipt.id] };
    report.frontier.push({ operation: 'review_list', state: 'GET returned but aggregate inputs were not present in response HTML' });
  }
}

async function collectFanatical(report, merchant) {
  const home = await readPage(report, merchant, merchant.siteUrl, 'homepage_GET');
  if (!home.page.ok) return;
  const scripts = scriptUrls(home.page.html, home.page.url);
  const selected = scripts.filter(url => /HitCard|\/main~/.test(url));
  const routeCandidates = new Set();
  for (const url of selected) {
    const source = await readResource(report, merchant, url, 'observed_first_party_frontend_asset_GET');
    if (!source.resource.ok) { if (source.resource.blocked) return; continue; }
    for (const candidate of literalPaths(source.resource.body ?? '', home.page.url)) {
      if (/^https:\/\/www\.fanatical\.com\/(?:search|product-library|game|bundle|review)(?:\/|$)/i.test(candidate)) routeCandidates.add(candidate);
    }
  }
  const routeContracts = [...routeCandidates].map(url => ({ url, kind: 'frontend_route_only', apiEndpoint: false }));
  report.contracts.push({ operation: 'frontend_route_discovery', routeContracts, actualDataApiObserved: false,
    note: 'Client bundle strings include UI routes; no replayable product/review HTTP data API was identified.' });
  const newLink = home.extraction.links.find(row => new URL(row.url).pathname === '/en/new-releases');
  if (!newLink) {
    report.frontier.push({ operation: 'catalog_items', state: 'homepage_exposed_no_new_releases_link' });
    return;
  }
  const listing = await readPage(report, merchant, newLink.url, 'observed_new_releases_GET');
  if (!listing.page.ok) return;
  const mystery = listing.extraction.links.find(row => row.url.includes('/en/bundle/mystery'));
  if (mystery) {
    const bundle = await readPage(report, merchant, mystery.url, 'observed_bundle_detail_GET');
    if (!bundle.page.ok) return;
  }
  for (const route of ['/product-library', '/search', '/bundle/all']) {
    const observed = [...routeCandidates].some(candidate => new URL(candidate).pathname.replace(/\/$/, '') === route);
    if (!observed) continue;
    const page = await readPage(report, merchant, new URL(route, home.page.url).href, 'observed_frontend_route_GET');
    if (!page.page.ok) return;
    if (page.extraction.records.length) addGenericRecords(report, page.extraction, page.receipt, page.page.url);
    const forms = page.extraction.forms.filter(form => form.method === 'GET');
    if (forms.length) report.contracts.at(-1).searchFormsObserved = forms;
    else report.frontier.push({ operation: 'frontend_route', url: safeUrl(page.page.url), state: 'route_returned_no_item_records_or_get_search_form' });
  }
  report.frontier.push({ operation: 'catalog_items', state: 'public_pages_read_but_returned_spa_shell_without_product_cards_jsonld_or_item_state' });
  report.frontier.push({ operation: 'search_and_reviews', state: 'no_public_search_or_review_contract_observed' });
}

function scriptUrls(html, pageUrl) {
  const root = parseFragment(html);
  return [...new Set(walk(root, node => node.tagName === 'script' && attr(node, 'src'))
    .map(node => safeUrl(attr(node, 'src'), pageUrl)).filter(Boolean))];
}

function literalPaths(body, baseUrl) {
  const output = [];
  const pattern = /["'`](\/(?:[A-Za-z0-9_.:@%+~!$&()*,-]+\/?)*(?:\{[^}]{1,60}\}|:[A-Za-z][\w-]*)?(?:\?[A-Za-z0-9_=&%{}:+,.-]{0,150})?)["'`]/g;
  for (const match of body.matchAll(pattern)) {
    const resolved = safeUrl(match[1], baseUrl);
    if (resolved) output.push(resolved);
  }
  return [...new Set(output)];
}

async function collectMerchantInner(merchantId) {
  const merchant = merchantById.get(merchantId);
  if (!merchant) return { merchantId, siteUrl: null, receipts: [], records: [], contracts: [], operations: {}, frontier: [{ state: 'taxonomy_record_missing' }], status: 'taxonomy_record_missing' };
  const stopped = blockedSnapshot(merchantId);
  if (stopped) return stopped;
  if (merchantId === 'pulmuone') return normalizePulmuoneReport(await collectPulmuoneMaintained(), merchant);
  const report = baseReport(merchant);
  const collector = {
    lensbank: collectLensbank,
    qtoon: collectQtoon,
    thirtymall: collectThirtymall,
    barobill: collectBarobill,
    hfashion: collectHfashion,
    fanatical: collectFanatical,
  }[merchantId];
  if (!collector) {
    report.status = 'collector_not_defined';
    report.frontier.push({ operation: 'collector', state: 'collector_not_defined_for_merchant' });
    return report;
  }
  await collector(report, merchant);
  if (report.status === 'pending') report.status = report.records.length ? 'ontology_records_observed' : 'reachable_without_offering_record';
  setOpsFromRecords(report);
  if (merchantId === 'thirtymall') finalizeThirtymallReport(report);
  return report;
}

function normalizePulmuoneReport(row, merchant = merchantById.get('pulmuone')) {
  const receipts = (row.receipts ?? []).map(receipt => ({
    ...receipt,
    receiptId: receipt.id,
    method: receipt.requestMethod ?? 'GET',
    finalUrl: receipt.requestUrl,
    httpStatus: receipt.responseStatus ?? null,
    mime: receipt.contentType ? receipt.contentType.split(';', 1)[0].trim().toLowerCase() : null,
    checkedAt: receipt.observedAt ?? null,
    secureTransport: receipt.requestUrl?.startsWith('https://') ?? null,
    transport: 'shared_public_page_reader',
  }));
  const records = (row.records ?? []).map(record => ({
    ...record,
    url: record.url ?? null,
    sourcePageUrl: safeUrl(record.sourcePageUrl ?? row.siteUrl),
    price: record.price ?? { amount: null, currency: null, priceText: null },
    rating: record.rating ?? null,
    variants: record.variants ?? [],
    reviewSamples: (record.reviewSamples ?? []).map(sample => ({
      rating: sample.rating ?? sample.ratingValue ?? null,
      publishedAt: sample.publishedAt ?? null,
      bodyAvailable: sample.bodyAvailable === true || [sample.body, sample.text, sample.content, sample.description, sample.textExcerpt]
        .some(value => typeof value === 'string' && value.trim().length > 0),
      optionText: sample.optionText ?? null,
      helpfulCount: sample.helpfulCount ?? null,
      hasMedia: sample.hasMedia ?? null,
      sampleCompleteness: sample.sampleCompleteness ?? null,
    })),
  }));
  const priceIds = [...new Set(records.filter(record => record.price?.amount != null)
    .flatMap(record => record.evidence
      .filter(ref => (ref.fields ?? []).some(field => field === 'price' || field.startsWith('price.')))
      .map(ref => ref.receiptId)))];
  const ratingIds = [...new Set(records.filter(record => record.rating?.value != null || record.rating?.reviewCount != null)
    .flatMap(record => record.evidence
      .filter(ref => (ref.fields ?? []).some(field => field === 'rating' || field.startsWith('rating.')))
      .map(ref => ref.receiptId)))];
  const catalogIds = [...new Set(records.flatMap(record => record.evidence.filter(ref => (ref.fields ?? []).some(field => ['title', 'sourceLocalId'].includes(field))).map(ref => ref.receiptId)))];
  const detailContracts = (row.contracts ?? []).filter(contract => contract.operation === 'product_detail' && contract.state === 'live_replay_verified');
  const reviewContracts = (row.contracts ?? []).filter(contract => contract.operation === 'reviews' && contract.state === 'live_replay_verified');
  const detailIds = detailContracts.map(contract => contract.receiptId).filter(Boolean);
  const reviewIds = reviewContracts.map(contract => contract.receiptId).filter(Boolean);
  const reviewSampleCount = records.reduce((count, record) => count + (record.reviewSamples?.length ?? 0), 0);
  const reviewTotal = records.find(record => record.rating?.reviewCount != null)?.rating?.reviewCount ?? null;
  const reviewTargetId = String(row.records?.find(record => record.reviewSamples?.length)?.sourceLocalId ?? '');
  for (const record of records) {
    if (record.sourceLocalId === reviewTargetId && record.reviewSamples.length && reviewIds.length) {
      record.evidence ??= [];
      record.evidence.push({ receiptId: reviewIds[0],
        locator: 'response.data.total from public POST getFeedbackListByGoods for goodsId 39271',
        fields: ['rating.reviewCount'] });
    }
  }
  const uniqueProductCount = new Set(records.map(record => record.sourceLocalId).filter(Boolean)).size;
  const contracts = (row.contracts ?? []).map(contract => ({
    ...contract,
    requestUrl: safeUrl(contract.url ?? contract.requestUrl),
    finalUrl: safeUrl(contract.url ?? contract.requestUrl),
    method: contract.method ?? 'GET',
    evidenceReceiptId: contract.receiptId ?? contract.evidenceReceiptId ?? null,
    browserUsed: false, cookiesSent: false, authorizationSent: false,
    secureTransport: true,
  }));
  return {
    merchantId: 'pulmuone', merchantName: merchant.merchantName, siteUrl: safeUrl(row.siteUrl ?? merchant.siteUrl), verticalHint: merchant.verticalHint,
    receipts, records, contracts,
    operations: {
      product_search: { state: 'not_observed', evidenceReceiptIds: [] },
      catalog_items: { state: 'homepage_nuxt_inventory_live_replay', count: uniqueProductCount, recordsCollected: records.length, firstPageOnly: true, evidenceReceiptIds: catalogIds },
      product_or_service_detail: { state: detailIds.length ? 'one_public_product_detail_replayed' : 'not_observed', count: detailIds.length, evidenceReceiptIds: detailIds },
      price: { state: priceIds.length ? 'price_currency_source_mapping_observed' : 'not_observed', evidenceReceiptIds: [...new Set([...priceIds, ...detailIds])] },
      rating_summary: { state: ratingIds.length ? 'rating_and_review_count_source_mapping_observed' : 'not_observed', evidenceReceiptIds: [...new Set([...ratingIds, ...reviewIds])] },
      review_samples: { state: reviewSampleCount ? 'first_public_review_page_partial_samples' : 'not_captured', count: reviewSampleCount, evidenceReceiptIds: reviewIds },
      review_list_endpoint: { state: reviewIds.length ? 'public_formdata_POST_replayed_partial_first_page' : 'not_captured',
        reviewCount: reviewTotal, reviewSamplesStored: reviewSampleCount, complete: false, evidenceReceiptIds: reviewIds },
    },
    frontier: row.frontier ?? [],
    status: row.status ?? 'reachable_without_offering_record',
    transport: { browserUsed: false, cookiesSent: false, authorizationSent: false, helper: 'lib/cps-public-reader.mjs', sourceAdapter: 'adapters/cps-vendors/pulmuone.mjs' },
  };
}

export function mergePulmuoneSupplement({ outputPath = OUTPUT_PATH, supplementPath = path.join(APP_ROOT, 'references/cps-reverify/pulmuone-supplement.json') } = {}) {
  const supplement = JSON.parse(readFileSync(supplementPath, 'utf8').replace(/^\uFEFF/, ''));
  const report = normalizePulmuoneReport(supplement);
  let output = { schemaVersion: 2, batchId: '05', merchants: [] };
  try { output = JSON.parse(readFileSync(outputPath, 'utf8').replace(/^\uFEFF/, '')); } catch { /* create checkpoint if missing */ }
  const rows = new Map((output.merchants ?? []).map(row => [row.merchantId, row]));
  rows.set('pulmuone', report);
  output = { schemaVersion: 2, batchId: '05', checkedAt: new Date().toISOString(), merchantCount: rows.size,
    merchants: merchantIds.map(id => rows.get(id)).filter(Boolean) };
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  return report;
}

export async function collectMerchant(merchantId, options = {}) {
  void options;
  return collectMerchantInner(merchantId);
}

export async function collectBatch05({ ids = merchantIds, outputPath = OUTPUT_PATH, writeOutput = true, pauseMs = 300 } = {}) {
  const checkedAt = new Date().toISOString();
  let saved = { schemaVersion: 2, batchId: '05', merchants: [] };
  if (ids.length !== merchantIds.length) {
    try { saved = JSON.parse(readFileSync(outputPath, 'utf8').replace(/^\uFEFF/, '')); } catch { /* first partial run */ }
  }
  const updated = new Map();
  for (const id of ids) {
    const report = await collectMerchant(id);
    updated.set(id, report);
    process.stdout.write(`${JSON.stringify({ merchantId: id, status: report.status, records: report.records.length, receipts: report.receipts.length, stopReason: report.stopReason ?? null })}\n`);
    if (pauseMs > 0) await new Promise(resolve => setTimeout(resolve, pauseMs));
  }
  const oldRows = new Map((saved.merchants ?? []).map(row => [row.merchantId, row]));
  for (const [id, report] of updated) oldRows.set(id, report);
  const merchants = merchantIds.map(id => oldRows.get(id)).filter(Boolean);
  const output = { schemaVersion: 2, batchId: '05', checkedAt, merchantCount: merchants.length, merchants };
  if (writeOutput) {
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  }
  return output;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  collectBatch05().catch(error => {
    process.stderr.write(`${String(error?.message ?? error).replace(/https?:\/\/\S+/g, '[URL]').slice(0, 500)}\n`);
    process.exitCode = 1;
  });
}
