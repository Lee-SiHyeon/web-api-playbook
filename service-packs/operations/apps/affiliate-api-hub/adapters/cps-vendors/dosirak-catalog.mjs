import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPublicResource, isStrongPublicChallenge, safeUrl } from '../../lib/cps-public-reader.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '../..');
const REVERIFY = resolve(APP_ROOT, 'references/cps-reverify');
const PRIOR_PATH = resolve(REVERIFY, 'dosirak-single-country-supplement.json');
const OUTPUT_PATH = resolve(REVERIFY, 'dosirak-catalog-supplement.json');
const API_ORIGIN = 'https://esimapi.wifidosirak.com';
const API_BASE = `${API_ORIGIN}/api/v1`;
const API_HOSTS = ['esimapi.wifidosirak.com'];
const SITE_HOSTS = ['dosirakesim.com'];
const OBSERVED_BUNDLE_URL = 'https://dosirakesim.com/dist/js/app.bundle.js?v=XS2Eta2ZUauXVNhJLxXHB7atZBqASzQDyODBjcAjXhA';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function receiptFromResource(page, kind) {
  const source = page.receipt ?? {};
  return {
    receiptId: source.id ?? randomUUID(), kind,
    method: source.requestMethod ?? 'GET', requestedUrl: safeUrl(source.requestUrl ?? page.url), finalUrl: safeUrl(page.url),
    status: page.status ?? source.responseStatus ?? null, mime: page.contentType ?? source.contentType ?? null,
    bytes: source.bytes ?? 0, sha256: source.responseSha256 ?? null, checkedAt: source.observedAt ?? null,
    redirects: (page.redirects ?? []).map(item => ({ status: item.status, from: safeUrl(item.from), to: safeUrl(item.to) })),
    browserUsed: false, cookiesSent: false, authorizationSent: false, stopReason: page.stopReason ?? null,
  };
}

function routeLiteral(bundle, name) {
  const start = bundle.indexOf(`${name}:`);
  if (start < 0) return null;
  const window = bundle.slice(start, start + 260);
  const literals = [...window.matchAll(/"((?:\\.|[^"\\])*)"/g)].map(match => {
    try { return JSON.parse(`"${match[1]}"`); } catch { return null; }
  }).filter(Boolean);
  return literals.find(value => value.startsWith('/')) ?? null;
}

function sourceContract(bundle) {
  const route = routeLiteral(bundle, 'getQuickUseDay');
  const callIndex = bundle.indexOf('countryId: sCountrys.join');
  const callWindow = callIndex < 0 ? '' : bundle.slice(callIndex, callIndex + 2400);
  const callObserved = callIndex >= 0 && callWindow.includes('getQuickUseDay') && callWindow.includes('.post');
  return {
    route,
    callObserved,
    fieldNames: callObserved ? ['countryId'] : [],
    bodySource: callObserved ? 'data_c.countryId = sCountrys.join(",")' : null,
    responsePath: callObserved && callWindow.includes('quickUseDay') ? '$.resultValue[].quickUseDay' : null,
    evidence: {
      bundleContainsObservedProductRoute: bundle.includes('/product/web/product'),
      getProductByCountryIdRoute: routeLiteral(bundle, 'getProductByCountryId'),
      getProductByCountryIdCallerCount: Math.max(0, [...bundle.matchAll(/getProductByCountryId/g)].length - 1),
      getProductsByCountryRoute: routeLiteral(bundle, 'getProductsByCountry'),
      getProductsByCountryCallerCount: Math.max(0, [...bundle.matchAll(/getProductsByCountry/g)].length - 1),
      categoryListCallsite: bundle.includes('getProductsByCategoryId'),
      productDetailCallsite: bundle.includes('getProductWithLanguage') || bundle.includes('getProduct:function'),
    },
  };
}

function selectedCountryIds(countryRows, requestedCountryIds) {
  const active = [...new Set((Array.isArray(countryRows) ? countryRows : [])
    .filter(row => row?.isUse === true && typeof row.countryId === 'string' && /^[A-Z]{3}$/.test(row.countryId))
    .map(row => row.countryId))];
  if (requestedCountryIds == null) return active;
  if (!Array.isArray(requestedCountryIds)) throw new TypeError('DOSIRAK_COUNTRY_IDS_MUST_BE_ARRAY');
  const requested = [...new Set(requestedCountryIds)];
  const selected = requested.filter(id => active.includes(id));
  if (!selected.length || selected.length !== requested.length || selected.length > 200) throw new Error('DOSIRAK_COUNTRY_IDS_NOT_IN_ACTIVE_BOOTSTRAP');
  return selected;
}

async function postObservedJson(urlValue, data, timeoutMs = 20_000) {
  const url = new URL(urlValue);
  const observedAt = new Date().toISOString();
  const base = { id: randomUUID(), requestMethod: 'POST', requestUrl: safeUrl(url.href), responseStatus: null, contentType: null,
    observedAt, browserUsed: false, cookiesSent: false, authorizationSent: false };
  const finish = (status, contentType, bytes, responseSha256, stopReason = null) => ({
    receipt: { ...base, responseStatus: status, contentType, bytes, responseSha256, stopReason },
    status, contentType, blocked: [401, 403, 418, 429].includes(status), stopReason,
  });
  if (url.protocol !== 'https:' || url.hostname !== 'esimapi.wifidosirak.com' || url.pathname !== '/api/v1/product/web/quickUseDay' || url.search || url.port || url.username || url.password) {
    return { ok: false, ...finish(null, null, 0, null, 'OBSERVED_POST_SCOPE_REJECTED') };
  }
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  if (body.length > 16_384) return { ok: false, ...finish(null, null, 0, null, 'REQUEST_BODY_LIMIT') };
  let response;
  try {
    response = await fetch(url.href, {
      method: 'POST', redirect: 'manual', credentials: 'omit', cache: 'no-store',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body, signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, ...finish(null, null, 0, null, 'PUBLIC_POST_TRANSPORT_FAILED') };
  }
  const status = response.status;
  const contentType = response.headers.get('content-type');
  if ([401, 403, 418, 429].includes(status)) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, ...finish(status, contentType, 0, null, `HTTP_${status}`) };
  }
  if (status >= 300 && status < 400) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, ...finish(status, contentType, 0, null, 'POST_REDIRECT_NOT_FOLLOWED') };
  }
  if (status !== 200 || !/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(contentType ?? '')) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, ...finish(status, contentType, 0, null, 'HTTP_STATUS_OR_JSON_MIME_REJECTED') };
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_RESPONSE_BYTES) return { ok: false, ...finish(status, contentType, 0, null, 'RESPONSE_TOO_LARGE') };
  const raw = bytes.toString('utf8');
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (isStrongPublicChallenge(response.headers, raw)) return { ok: false, ...finish(status, contentType, bytes.length, hash, 'VISIBLE_CHALLENGE') };
  let value;
  try { value = JSON.parse(raw); } catch { return { ok: false, ...finish(status, contentType, bytes.length, hash, 'JSON_PARSE_FAILED') }; }
  return { ok: true, ...finish(status, contentType, bytes.length, hash), value };
}

function cleanQuickUseOptions(response) {
  const rows = Array.isArray(response?.resultValue) ? response.resultValue : [];
  return rows.slice(0, 100).map((row, index) => ({
    sourceLocalId: row?.quickUseDay == null ? `observed-option-${index + 1}` : String(row.quickUseDay),
    quickUseDay: Number.isFinite(Number(row?.quickUseDay)) ? Number(row.quickUseDay) : null,
    default: row?.defaultYN === 'Y' ? true : row?.defaultYN === 'N' ? false : null,
    singleCountryOnly: row?.singleCountryYn === 'Y' ? true : row?.singleCountryYn === 'N' ? false : null,
  })).filter(row => row.quickUseDay != null || row.default != null || row.singleCountryOnly != null);
}

function priorProductEvidence(prior) {
  const contracts = (prior?.contracts ?? [])
    .filter(row => ['product_search', 'single_country_native_fetch_comparison'].includes(row.operation))
    // HTTP 200 plus an empty product array proves a completed empty read, not
    // successful product discovery. Keep the transport receipts and counts,
    // but make the data outcome explicit for downstream ontology importers.
    .map(row => ({ ...row, state: 'live_replay_empty' }));
  const receiptsById = new Map((prior?.receipts ?? []).map(row => [row.id ?? row.receiptId, row]));
  const receipts = contracts.map(row => receiptsById.get(row.receiptId)).filter(Boolean).map(row => ({
    receiptId: row.id ?? row.receiptId, kind: row.kind ?? 'observed_public_api_json', method: row.requestMethod ?? row.method ?? 'POST',
    requestedUrl: safeUrl(row.requestUrl ?? row.url), finalUrl: safeUrl(row.finalUrl ?? row.requestUrl ?? row.url),
    status: row.responseStatus ?? row.status ?? null, mime: row.contentType ?? row.mime ?? null,
    bytes: row.bytes ?? 0, sha256: row.responseSha256 ?? row.sha256 ?? null, checkedAt: row.observedAt ?? row.checkedAt ?? null,
    redirects: [], browserUsed: row.browserUsed === true, cookiesSent: row.cookiesSent === true, authorizationSent: row.authorizationSent === true,
  }));
  return { contracts, receipts };
}

export async function collectDosirakCatalog({ countryIds = null, timeoutMs = 20_000 } = {}) {
  const prior = JSON.parse(await readFile(PRIOR_PATH, 'utf8'));
  const report = {
    schemaVersion: 1, merchantId: 'dosirak1', merchantName: '도시락eSIM', siteUrl: 'https://dosirakesim.com/',
    checkedAt: new Date().toISOString(), status: 'pending', receipts: [], records: [], serviceOptions: [], contracts: [], operations: {}, frontier: [],
  };
  const bundle = await readPublicResource(OBSERVED_BUNDLE_URL, { allowedHosts: SITE_HOSTS, maxRedirects: 2, maxBytes: 8 * 1024 * 1024, timeoutMs });
  const bundleReceipt = bundle.receipt ? receiptFromResource(bundle, 'observed_public_source_resource') : null;
  if (bundleReceipt) report.receipts.push(bundleReceipt);
  if (!bundle.ok) {
    report.status = bundle.blocked ? 'blocked_host' : 'source_bundle_unavailable';
    report.frontier.push({ url: OBSERVED_BUNDLE_URL, state: bundle.stopReason ?? `HTTP_${bundle.status ?? 'NO_RESPONSE'}`, retry: false, evidenceReceiptId: bundleReceipt?.receiptId ?? null });
    report.contracts.push({ operation: 'observed_public_source_resource', state: report.status, method: 'GET', receiptId: bundleReceipt?.receiptId ?? null, status: bundle.status ?? null, mime: bundle.contentType ?? null });
    return save(report);
  }
  const source = sourceContract(bundle.body);
  report.contracts.push({ operation: 'observed_public_source_resource', state: source.callObserved && source.route ? 'source_contract_verified' : 'source_contract_incomplete',
    method: 'GET', receiptId: bundleReceipt.receiptId, requestedUrl: bundleReceipt.requestedUrl,
    productRoute: '/api/v1/product/web/product', productCaller: 'getProduct() -> POST getAllProducts', productRequestFieldNames: ['countryId'],
    quickUseRoutePath: source.route, quickUseCallsiteObserved: source.callObserved, quickUseRequestFieldNames: source.fieldNames,
    quickUseRequestFieldSource: source.bodySource, quickUseResponsePath: source.responsePath,
    sourceOnlyRoutes: [
      { name: 'getProductByCountryId', path: source.evidence.getProductByCountryIdRoute, callerOccurrences: source.evidence.getProductByCountryIdCallerCount, replayed: false },
      { name: 'getProductsByCountry', path: source.evidence.getProductsByCountryRoute, callerOccurrences: source.evidence.getProductsByCountryCallerCount, replayed: false },
    ], parser: 'static source inspection only', rawSourcePersisted: false,
  });
  if (!source.callObserved || source.route !== '/product/web/quickUseDay') {
    report.status = 'source_contract_incomplete';
    report.frontier.push({ url: OBSERVED_BUNDLE_URL, state: 'quick_use_callsite_or_exact_route_missing', retry: false, evidenceReceiptId: bundleReceipt.receiptId });
    return save(report);
  }

  const countryUrl = `${API_BASE}/product/country`;
  const countries = await readPublicResource(countryUrl, { allowedHosts: API_HOSTS, maxRedirects: 1, maxBytes: 2 * 1024 * 1024, timeoutMs });
  const countryReceipt = countries.receipt ? receiptFromResource(countries, 'observed_country_bootstrap') : null;
  if (countryReceipt) report.receipts.push(countryReceipt);
  if (!countries.ok) {
    const blocked = countries.blocked === true || [401, 403, 418, 429].includes(countries.status);
    report.status = blocked ? 'blocked_host' : 'country_bootstrap_unavailable';
    report.contracts.push({ operation: 'country_bootstrap', method: 'GET', receiptId: countryReceipt?.receiptId ?? null, requestUrl: countries.url,
      status: countries.status ?? null, mime: countries.contentType ?? null, browserUsed: false, cookiesSent: false, authorizationSent: false, stopReason: countries.stopReason ?? null });
    report.frontier.push({ url: countries.url, state: blocked ? 'stopped_at_host_block' : 'country_bootstrap_unavailable', retry: false, evidenceReceiptId: countryReceipt?.receiptId ?? null });
    return save(report);
  }
  let countryRows;
  try { countryRows = JSON.parse(countries.body); } catch { countryRows = null; }
  if (!Array.isArray(countryRows)) {
    report.status = 'country_bootstrap_schema_unverified';
    report.contracts.push({ operation: 'country_bootstrap', method: 'GET', receiptId: countryReceipt?.receiptId ?? null, requestUrl: countries.url, status: countries.status, mime: countries.contentType, resultArray: false });
    report.frontier.push({ url: countries.url, state: 'country_bootstrap_schema_unverified', retry: false, evidenceReceiptId: countryReceipt?.receiptId ?? null });
    return save(report);
  }
  const ids = selectedCountryIds(countryRows, countryIds);
  report.contracts.push({ operation: 'country_bootstrap', state: 'live_replay_verified', method: 'GET', receiptId: countryReceipt.receiptId,
    requestUrl: countryUrl, status: countries.status, mime: countries.contentType, resultCount: countryRows.length, activeCountryCount: selectedCountryIds(countryRows, null).length,
    browserUsed: false, cookiesSent: false, authorizationSent: false, responseFields: ['countryId', 'isUse'] });

  const quickUrl = `${API_BASE}${source.route}`;
  const quick = await postObservedJson(quickUrl, { countryId: ids.join(',') }, timeoutMs);
  const quickReceipt = {
    receiptId: quick.receipt.id, kind: 'observed_quick_use_day_json', method: 'POST', requestedUrl: quick.receipt.requestUrl, finalUrl: quick.receipt.requestUrl,
    status: quick.receipt.responseStatus, mime: quick.receipt.contentType, bytes: quick.receipt.bytes, sha256: quick.receipt.responseSha256,
    checkedAt: quick.receipt.observedAt, redirects: [], browserUsed: false, cookiesSent: false, authorizationSent: false, stopReason: quick.receipt.stopReason ?? null,
  };
  report.receipts.push(quickReceipt);
  const { contracts: priorProductContracts, receipts: priorProductReceipts } = priorProductEvidence(prior);
  for (const item of priorProductReceipts) if (!report.receipts.some(row => row.receiptId === item.receiptId)) report.receipts.push(item);
  report.contracts.push({ operation: 'observed_quick_use_day_lookup', method: 'POST', receiptId: quickReceipt.receiptId,
    requestUrl: quickUrl, status: quickReceipt.status, mime: quickReceipt.mime, browserUsed: false, cookiesSent: false, authorizationSent: false,
    requestFieldNames: ['countryId'], requestCountryCount: ids.length, countryBootstrapReceiptId: countryReceipt.receiptId,
    sourceBundleReceiptId: bundleReceipt.receiptId, callsite: 'observed getQuickUseDay caller; countryId from selectedCountrys.join(",")',
    responsePath: source.responsePath, parser: quick.ok ? 'resultValue quickUseDay allowlist normalization' : null });
  report.contracts.push(...priorProductContracts.map(item => ({ ...item, evidenceEra: 'prior_2026-09-27_public_replay' })));
  if (!quick.ok) {
    report.status = quick.blocked ? 'blocked_host_after_prior_empty_product_reads' : 'quick_use_lookup_unavailable';
    report.frontier.push({ url: quickUrl, state: quick.blocked ? 'stopped_at_host_block' : quick.stopReason ?? 'quick_use_lookup_unavailable', retry: false, evidenceReceiptId: quickReceipt.receiptId });
  } else {
    report.serviceOptions = cleanQuickUseOptions(quick.value);
    const productCount = Number(priorProductContracts.find(item => item.operation === 'product_search')?.resultCount ?? 0);
    report.status = productCount > 0 ? 'reachable_with_product_records' : 'reachable_no_product_records';
    report.operations = {
      productSearch: { state: productCount > 0 ? 'live_replay_partial' : 'live_replay_empty', evidenceReceiptIds: priorProductContracts.filter(item => item.operation === 'product_search').map(item => item.receiptId).filter(Boolean), normalizedRecordCount: 0 },
      quickUseDayOptions: { state: report.serviceOptions.length ? 'live_replay' : 'live_replay_empty', evidenceReceiptIds: [quickReceipt.receiptId], optionCount: report.serviceOptions.length },
      price: { state: 'not_observed', evidenceReceiptIds: [quickReceipt.receiptId] },
      ratingSummary: { state: 'not_observed', evidenceReceiptIds: [quickReceipt.receiptId] },
      reviews: { state: 'not_observed', evidenceReceiptIds: [quickReceipt.receiptId] },
    };
  }
  report.frontier.push(
    { url: quickUrl, state: report.serviceOptions.length ? 'quick_use_options_observed_not_product_records' : 'quick_use_empty_not_product_records', retry: false, evidenceReceiptId: quickReceipt.receiptId },
    { url: null, routePath: source.evidence.getProductByCountryIdRoute, state: 'source_map_route_no_caller', retry: false },
    { url: null, routePath: source.evidence.getProductsByCountryRoute, state: 'source_map_route_no_caller', retry: false },
    { url: null, routePath: 'observed GET products-by-category caller with this.categoryId', state: 'not_replayed_missing_observed_category_id', retry: false },
    { url: null, routePath: 'observed GET product detail caller with productCode', state: 'not_replayed_missing_public_product_code', retry: false },
  );
  return save(report);
}

async function save(report) {
  report.checkedAt = new Date().toISOString();
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  const temporary = `${OUTPUT_PATH}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await rename(temporary, OUTPUT_PATH);
  return report;
}

export const dosirakCatalogPaths = Object.freeze({ supplementPath: OUTPUT_PATH });

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  collectDosirakCatalog().then(report => {
    process.stdout.write(`${JSON.stringify({ status: report.status, records: report.records.length, serviceOptionCount: report.serviceOptions.length, receipts: report.receipts.length })}\n`);
  }).catch(error => {
    process.stderr.write(`${error?.code ?? error?.message ?? 'DOSIRAK_CATALOG_FAILED'}\n`);
    process.exitCode = 1;
  });
}
