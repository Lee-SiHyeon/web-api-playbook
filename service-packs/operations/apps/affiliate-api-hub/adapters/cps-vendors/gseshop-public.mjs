import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseFragment } from 'parse5';
import { isStrongPublicChallenge, safeUrl } from '../../lib/cps-public-reader.mjs';

const ROOT_URL = 'https://www.gsshop.com/';
const OBSERVED_INDEX_URL = 'https://www.gsshop.com/index.gs';
const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '../..');
const SUPPLEMENT_PATH = path.join(APP_ROOT, 'references/cps-reverify/gseshop-public-bootstrap-supplement.json');
const ACCEPT = 'text/html,application/xhtml+xml';

function attr(node, name) {
  return node?.attrs?.find(row => row.name === name)?.value ?? null;
}

function walk(node, visit, output = []) {
  if (!node || output.length >= 10_000) return output;
  if (visit(node)) output.push(node);
  for (const child of node.childNodes ?? []) walk(child, visit, output);
  return output;
}

function scriptText(node) {
  return (node?.childNodes ?? []).map(child => child.value ?? '').join('');
}

function pageTitle(html) {
  const root = parseFragment(html);
  const node = walk(root, item => item.tagName === 'title')[0];
  return node ? walk(node, item => item.nodeName === '#text').map(item => item.value ?? '').join(' ').replace(/\s+/g, ' ').trim().slice(0, 1000) || null : null;
}

function decodeBody(bytes, contentType) {
  const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType ?? '')?.[1] ?? 'utf-8';
  try { return new TextDecoder(charset, { fatal: false }).decode(bytes); }
  catch { return new TextDecoder('utf-8', { fatal: false }).decode(bytes); }
}

async function boundedBytes(response) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    return bytes.length > MAX_BYTES ? { bytes: null, bytesRead: MAX_BYTES + 1, tooLarge: true } : { bytes, bytesRead: bytes.length, tooLarge: false };
  }
  const chunks = [];
  let bytesRead = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    bytesRead += chunk.length;
    if (bytesRead > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      return { bytes: null, bytesRead: MAX_BYTES + 1, tooLarge: true };
    }
    chunks.push(chunk);
  }
  return { bytes: Buffer.concat(chunks), bytesRead, tooLarge: false };
}

function cookieNames(headers) {
  let values = [];
  if (typeof headers?.getSetCookie === 'function') values = headers.getSetCookie();
  if (!values.length) {
    const joined = headers?.get?.('set-cookie');
    if (joined) values = joined.split(/,(?=\s*[^;,=\s]+\s*=)/g);
  }
  return [...new Set(values.map(value => /^\s*([^=;,\s]+)\s*=/.exec(value)?.[1] ?? null).filter(Boolean))];
}

function makeReceipt(url, observedAt, response = null, bodyInfo = null, stopReason = null, redirects = []) {
  const contentType = response?.headers?.get?.('content-type') ?? null;
  const setCookieNames = cookieNames(response?.headers);
  const responseSha256 = bodyInfo?.bytes && !bodyInfo.tooLarge
    ? createHash('sha256').update(bodyInfo.bytes).digest('hex') : null;
  const finalUrl = safeUrl(response?.url || url) ?? safeUrl(url);
  return {
    id: randomUUID(), receiptId: null,
    requestMethod: 'GET', method: 'GET', requestUrl: safeUrl(url), requestedUrl: safeUrl(url), finalUrl,
    responseStatus: Number.isInteger(response?.status) ? response.status : null,
    status: Number.isInteger(response?.status) ? response.status : null,
    contentType, mime: contentType,
    bytes: bodyInfo?.bytesRead ?? 0, responseBytes: bodyInfo?.bytesRead ?? 0,
    responseSha256, sha256: responseSha256,
    observedAt, checkedAt: observedAt,
    browserUsed: false, cookiesSent: false, cookieNamesSent: [], authorizationSent: false,
    explicitRequestHeaderNames: ['accept'], setCookieHeaderPresent: setCookieNames.length > 0, setCookieNames,
    redirects, stopReason,
    ...(bodyInfo?.tooLarge ? { responseBodyTruncated: true } : {}),
  };
}

function validFirstPartyUrl(value, base) {
  const url = safeUrl(value, base);
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.origin === 'https://www.gsshop.com' && !parsed.port ? parsed.href : null;
  } catch { return null; }
}

async function requestPage(fetchImpl, requestUrl, timeoutMs) {
  const observedAt = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let response;
  try {
    response = await fetchImpl(requestUrl, {
      method: 'GET', redirect: 'manual', credentials: 'omit',
      headers: { accept: ACCEPT }, signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    const receipt = makeReceipt(requestUrl, observedAt, null, null, 'PUBLIC_HTTP_TRANSPORT_FAILED');
    return { receipt, html: null, location: null, blocked: false, stopReason: receipt.stopReason };
  }
  let bodyInfo;
  try { bodyInfo = await boundedBytes(response); }
  catch {
    clearTimeout(timer);
    const receipt = makeReceipt(requestUrl, observedAt, response, null, 'PUBLIC_HTTP_BODY_FAILED');
    return { receipt, html: null, location: null, blocked: false, stopReason: receipt.stopReason };
  }
  clearTimeout(timer);
  const status = response.status;
  const contentType = response.headers?.get?.('content-type') ?? null;
  const location = response.headers?.get?.('location') ?? null;
  let stopReason = null;
  let blocked = false;
  if (bodyInfo.tooLarge) stopReason = 'RESPONSE_TOO_LARGE';
  else if ([401, 403, 418, 429].includes(status)) { stopReason = 'HTTP_ACCESS_BLOCKED'; blocked = true; }
  else if (status !== 200 && !(status >= 300 && status < 400)) stopReason = 'HTTP_STATUS_REJECTED';
  else if (status === 200 && !/^text\/html\b|^application\/xhtml\+xml\b/i.test(contentType ?? '')) stopReason = 'HTML_CONTENT_TYPE_REQUIRED';
  const html = bodyInfo.bytes ? decodeBody(bodyInfo.bytes, contentType) : null;
  if (!stopReason && isStrongPublicChallenge(response.headers, html ?? '')) {
    stopReason = 'VISIBLE_CHALLENGE';
    blocked = true;
  }
  const receipt = makeReceipt(requestUrl, observedAt, response, bodyInfo, stopReason, []);
  return { receipt, html: stopReason ? null : html, location, blocked, stopReason };
}

function parseJsonScript(root, id) {
  const node = walk(root, item => item.tagName === 'script' && attr(item, 'id') === id)[0];
  if (!node) return { present: false, value: null, valid: false };
  try { return { present: true, value: JSON.parse(scriptText(node)), valid: true }; }
  catch { return { present: true, value: null, valid: false }; }
}

function safeNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== 'string' || !/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(value.trim())) return null;
  const parsed = Number(value.replaceAll(',', ''));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function productIdentity(rawUrl, pageUrl) {
  const resolved = validFirstPartyUrl(rawUrl, pageUrl);
  if (!resolved) return null;
  const url = new URL(resolved);
  if (url.pathname !== '/prd/prd.gs') return null;
  const id = url.searchParams.get('prdid');
  return id && /^\d{4,}$/.test(id) ? { id, url: safeUrl(url.href) } : null;
}

function observedPrice(field, value) {
  const amount = safeNumber(value);
  if (amount == null) return null;
  const secondary = field === 'gsPrc';
  return {
    amount, currency: null, priceText: String(value),
    priceKind: secondary ? 'source_secondary_metric' : 'sale_price',
    sourceField: field, type: field, sourceOfferType: field,
    qualifiers: { sourceField: field, role: secondary ? 'not_established' : 'sale_price' },
  };
}

function makeProduct({ id, title, url, locator, fields, prices, receiptId, sourcePageUrl }) {
  const cleanTitle = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim().slice(0, 1000) : '';
  if (!id || !cleanTitle || !url) return null;
  const observedPrices = prices.filter(Boolean);
  if (observedPrices.length) fields.push('prices');
  return {
    type: 'RetailProduct', sourceLocalId: id, title: cleanTitle, url,
    description: null, brand: null,
    price: { amount: null, currency: null, priceText: null }, prices: observedPrices,
    rating: { value: null, best: null, worst: null, reviewCount: null, ratingCount: null },
    variants: [], reviewSamples: [], sourcePageUrl,
    retrievalContext: { retrievalKind: 'homepage_embedded_product_cards', sourcePageUrl },
    evidence: [{ receiptId, locator, fields: [...new Set(fields)] }],
  };
}

function extractProductCards(html, pageUrl, receiptId) {
  const root = parseFragment(html);
  const scripts = walk(root, node => node.tagName === 'script');
  const sameOriginLinkCount = walk(root, node => ['a', 'link'].includes(node.tagName) && attr(node, 'href') !== null)
    .filter(node => validFirstPartyUrl(attr(node, 'href'), pageUrl) !== null).length;
  const entry = parseJsonScript(root, 'entryData');
  const common = parseJsonScript(root, 'common-data');
  const records = [];
  if (entry.valid && Array.isArray(entry.value?.mainBigBannerList)) {
    entry.value.mainBigBannerList.forEach((row, index) => {
      if (!row || row.productYn !== 'Y' || typeof row.exposPrdNm !== 'string') return;
      const identity = productIdentity(row.linkUrl, pageUrl);
      const dealNo = row.dealNo == null ? null : String(row.dealNo);
      if (!identity || !dealNo || dealNo !== identity.id) return;
      const fields = ['type', 'productYn', 'sourceLocalId', 'dealNo', 'title', 'url'];
      const prices = [];
      for (const field of ['salePrc', 'gsPrc']) {
        const price = observedPrice(field, row[field]);
        if (price) { prices.push(price); fields.push(`prices.${field}`); }
      }
      records.push(makeProduct({ id: identity.id, title: row.exposPrdNm, url: identity.url,
        locator: `script#entryData.mainBigBannerList[${index}]`, fields, prices, receiptId, sourcePageUrl: safeUrl(pageUrl) }));
    });
  }
  if (common.valid) {
    const banners = Array.isArray(common.value?.tvDataBanner) ? common.value.tvDataBanner
      : common.value?.tvDataBanner && typeof common.value.tvDataBanner === 'object' ? [common.value.tvDataBanner] : [];
    banners.forEach((row, index) => {
      if (!row || typeof row.productName !== 'string') return;
      const identity = productIdentity(row.linkUrl, pageUrl);
      if (!identity) return;
      const price = observedPrice('salePrice', row.salePrice);
      const fields = ['type', 'sourceLocalId', 'title', 'url', 'productName', 'linkUrl'];
      if (price) fields.push('prices.salePrice');
      records.push(makeProduct({ id: identity.id, title: row.productName, url: identity.url,
        locator: `script#common-data.tvDataBanner[${index}]`, fields, prices: price ? [price] : [], receiptId, sourcePageUrl: safeUrl(pageUrl) }));
    });
  }
  const unique = new Map();
  for (const record of records.filter(Boolean)) {
    const prior = unique.get(record.sourceLocalId);
    if (!prior) unique.set(record.sourceLocalId, record);
    else if (prior.evidence[0].receiptId !== receiptId) unique.set(record.sourceLocalId, record);
  }
  return {
    records: [...unique.values()], entry, common, sameOriginLinkCount,
    jsonLdCount: scripts.filter(node => /application\/ld\+json/i.test(attr(node, 'type') ?? '')).length,
    embeddedJsonCount: scripts.filter(node => /(?:application|text)\/(?:[a-z0-9.+-]+\+)?json/i.test(attr(node, 'type') ?? '') || ['entryData', 'common-data'].includes(attr(node, 'id'))).length,
  };
}

async function persistSupplement({ receipts, records = null, checkedAt, pageFlags = null, status = null, stopReason = null }) {
  if (!existsSync(SUPPLEMENT_PATH)) return;
  const current = JSON.parse(await readFile(SUPPLEMENT_PATH, 'utf8'));
  const allReceipts = new Map((current.receipts ?? []).map(item => [item.receiptId ?? item.id, item]));
  for (const receipt of receipts) allReceipts.set(receipt.receiptId ?? receipt.id, receipt);
  current.receipts = [...allReceipts.values()];
  current.checkedAt = checkedAt ?? current.checkedAt;
  if (records) current.records = records;
  if (pageFlags) current.pageFlags = { ...(current.pageFlags ?? {}), ...pageFlags };
  if (status) current.status = status;
  if (stopReason !== null) current.stopReason = stopReason;
  const latest = receipts.at(-1);
  if (latest) {
    current.assessment = {
      ...(current.assessment ?? {}),
      latestAnonymousCatalogStatus: latest.responseStatus ?? latest.status ?? null,
      latestAnonymousCatalogReceiptId: latest.receiptId ?? latest.id,
      latestAnonymousCatalogSetCookieNames: latest.setCookieNames ?? [],
      latestAnonymousCatalogCookiesSent: latest.cookiesSent,
      latestAnonymousCatalogAuthorizationSent: latest.authorizationSent,
      catalogReachedWithoutCookieContinuity: Boolean(records?.length),
      ...(records ? { latestAnonymousOfferingRecordCount: records.length } : {}),
    };
  }
  const temporary = `${SUPPLEMENT_PATH}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(SUPPLEMENT_PATH), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(current, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, SUPPLEMENT_PATH);
}

function report({ checkedAt, receipts, records, pageFlags, status, stopReason, frontierNote }) {
  const indexReceipt = [...receipts].reverse().find(item => item.requestUrl === OBSERVED_INDEX_URL || item.requestedUrl === OBSERVED_INDEX_URL);
  const evidenceReceipt = indexReceipt?.receiptId ?? indexReceipt?.id ?? null;
  return {
    merchantId: 'gseshop', siteUrl: ROOT_URL, checkedAt,
    status, stopReason: stopReason ?? null,
    receipts, records,
    contracts: [{ operation: 'anonymous_homepage_product_cards', method: 'GET', requestUrl: ROOT_URL,
      observedRedirectUrl: OBSERVED_INDEX_URL, responseType: 'text/html', authentication: 'none',
      evidenceReceiptIds: receipts.map(item => item.receiptId ?? item.id) }],
    operations: {
      anonymous_homepage_product_cards: { state: records.length ? 'live_replay_verified' : status === 'blocked' ? 'blocked' : 'reachable_without_offering_data', evidenceReceiptId: evidenceReceipt },
      product_detail: { state: 'not_requested_unobserved' },
      ratings: { state: 'not_present_in_observed_cards' },
      reviews: { state: 'not_present_in_observed_cards' },
    },
    frontier: [{ operation: 'product_detail_and_reviews', state: 'not_requested', retry: false,
      note: frontierNote ?? 'The observed homepage embeds product-card fields; product detail and review URLs were not fetched.' }],
    pageFlags,
  };
}

/**
 * Read the observed public GS SHOP root redirect and anonymous product cards.
 * No cookies, authorization, browser session, script execution, or guessed URL is used.
 */
export async function collectGseshopPublic({ fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS, persist = false } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('FETCH_IMPL_REQUIRED');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new RangeError('TIMEOUT_INVALID');
  const receipts = [];
  const root = await requestPage(fetchImpl, ROOT_URL, timeoutMs);
  receipts.push(root.receipt);
  const redirects = [];
  let page = root;
  let pageUrl = ROOT_URL;
  if (persist) await persistSupplement({ receipts, checkedAt: root.receipt.observedAt, status: 'attempt_without_response' });

  if (root.stopReason) {
    const result = report({ checkedAt: root.receipt.observedAt, receipts, records: [], pageFlags: { inlineScriptsExecuted: false },
      status: root.blocked ? 'blocked' : 'attempt_without_response', stopReason: root.stopReason });
    if (persist) await persistSupplement({ receipts, checkedAt: result.checkedAt, records: [], status: result.status, stopReason: result.stopReason });
    return result;
  }
  if (root.receipt.status >= 300 && root.receipt.status < 400) {
    const target = validFirstPartyUrl(root.location, ROOT_URL);
    if (!target || target !== OBSERVED_INDEX_URL) {
      root.receipt.stopReason = 'UNOBSERVED_REDIRECT_TARGET';
      const result = report({ checkedAt: root.receipt.observedAt, receipts, records: [], pageFlags: { inlineScriptsExecuted: false },
        status: 'attempt_without_response', stopReason: root.receipt.stopReason });
      if (persist) await persistSupplement({ receipts, checkedAt: result.checkedAt, records: [], status: result.status, stopReason: result.stopReason });
      return result;
    }
    redirects.push({ status: root.receipt.status, from: ROOT_URL, to: target });
    root.receipt.redirects = redirects;
    if (persist) await persistSupplement({ receipts, checkedAt: root.receipt.observedAt, status: 'attempt_without_response' });
    pageUrl = target;
    page = await requestPage(fetchImpl, target, timeoutMs);
    page.receipt.redirects = redirects;
    receipts.push(page.receipt);
    if (persist) await persistSupplement({ receipts, checkedAt: page.receipt.observedAt, status: 'attempt_without_response' });
  }

  if (page.stopReason) {
    const result = report({ checkedAt: page.receipt.observedAt, receipts, records: [], pageFlags: { inlineScriptsExecuted: false },
      status: page.blocked ? 'blocked' : 'attempt_without_response', stopReason: page.stopReason });
    if (persist) await persistSupplement({ receipts, checkedAt: result.checkedAt, records: [], status: result.status, stopReason: result.stopReason });
    return result;
  }
  if (page.receipt.status !== 200 || typeof page.html !== 'string') {
    page.receipt.stopReason = 'EXPECTED_PUBLIC_PAGE_NOT_RETURNED';
    const result = report({ checkedAt: page.receipt.observedAt, receipts, records: [], pageFlags: { inlineScriptsExecuted: false },
      status: 'attempt_without_response', stopReason: page.receipt.stopReason });
    if (persist) await persistSupplement({ receipts, checkedAt: result.checkedAt, records: [], status: result.status, stopReason: result.stopReason });
    return result;
  }

  // Persist the hash/status receipt before parsing; HTML remains transient in memory only.
  if (persist) await persistSupplement({ receipts, checkedAt: page.receipt.observedAt, status: 'attempt_without_response' });
  let extracted;
  try { extracted = extractProductCards(page.html, pageUrl, page.receipt.id); }
  catch {
    page.receipt.stopReason = 'EMBEDDED_STATE_PARSE_FAILED';
    const result = report({ checkedAt: page.receipt.observedAt, receipts, records: [], pageFlags: { inlineScriptsExecuted: false },
      status: 'reachable_without_offering_data', stopReason: page.receipt.stopReason });
    if (persist) await persistSupplement({ receipts, checkedAt: result.checkedAt, records: [], status: result.status, stopReason: result.stopReason });
    return result;
  }
  const records = extracted.records.map(row => ({
    ...row,
    evidence: row.evidence.map(item => ({ ...item, receiptId: page.receipt.id })),
  }));
  const flag = {
    title: pageTitle(page.html), sameOriginLinkCount: extracted.sameOriginLinkCount,
    jsonLdCount: extracted.jsonLdCount, embeddedJsonCount: extracted.embeddedJsonCount,
    entryDataParsed: extracted.entry.valid, commonDataParsed: extracted.common.valid,
    entryProductCardCount: Array.isArray(extracted.entry.value?.mainBigBannerList) ? extracted.entry.value.mainBigBannerList.length : 0,
    offeringRecordCount: records.length,
    productDetailFetched: false, reviewDataObserved: false,
    inlineScriptsExecuted: false,
  };
  const status = records.length ? 'data_observed' : 'reachable_without_offering_data';
  const result = report({ checkedAt: page.receipt.observedAt, receipts, records, pageFlags: { noCookieCatalog: flag, inlineScriptsExecuted: false }, status,
    frontierNote: 'The anonymous homepage contains product cards with direct product identities and prices. Product detail/review reads remain unobserved; no product URLs were fetched.' });
  if (persist) await persistSupplement({ receipts, records, checkedAt: result.checkedAt, pageFlags: { noCookieCatalog: flag, inlineScriptsExecuted: false }, status });
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  collectGseshopPublic({ persist: true }).then(result => {
    process.stdout.write(`${JSON.stringify({ ok: result.status === 'data_observed', merchantId: result.merchantId, status: result.status,
      checkedAt: result.checkedAt, receiptCount: result.receipts.length, recordCount: result.records.length,
      recordSample: result.records.slice(0, 3).map(({ sourceLocalId, title, url, prices }) => ({ sourceLocalId, title, url, prices })),
      stopReason: result.stopReason ?? null })}\n`);
  }).catch(() => {
    process.stderr.write('{"ok":false,"error":"GS_PUBLIC_COLLECTION_FAILED"}\n');
    process.exitCode = 2;
  });
}
