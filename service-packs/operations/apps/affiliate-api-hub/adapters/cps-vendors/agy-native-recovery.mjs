import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { safeUrl, isStrongPublicChallenge } from '../../lib/cps-public-reader.mjs';

export const merchantIds = Object.freeze(['ohouse', 'kbbook']);
export const nativeRecoveryMerchants = Object.freeze(['ohouse', 'kbbook']);

const MAX_GET_REQUESTS = 4;
const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;

const MERCHANTS_CONFIG = Object.freeze({
  ohouse: {
    siteUrl: 'https://ohou.se/',
    approvedOrigin: 'https://ohou.se',
    providerRoot: 'ohou.se',
  },
  kbbook: {
    siteUrl: 'https://www.kyobobook.co.kr/',
    approvedOrigin: 'https://www.kyobobook.co.kr',
    providerRoot: 'kyobobook.co.kr',
  },
});

const PRIVATE_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([address, bits]) => {
  const network = address.split('.').reduce((n, octet) => ((n << 8) | Number(octet)) >>> 0, 0);
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return { network: network & mask, mask };
});

export function isPublicIpv4(address) {
  if (isIP(address) !== 4) return false;
  const value = address.split('.').reduce((n, octet) => ((n << 8) | Number(octet)) >>> 0, 0);
  return !PRIVATE_V4.some(({ network, mask }) => (value & mask) === network);
}

export function parseIpv6(address) {
  if (isIP(address) !== 6) return null;
  let str = address.toLowerCase();

  const lastColon = str.lastIndexOf(':');
  if (lastColon !== -1 && str.slice(lastColon + 1).includes('.')) {
    const v4Part = str.slice(lastColon + 1);
    if (isIP(v4Part) !== 4) return null;
    const octets = v4Part.split('.').map(Number);
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    str = `${str.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const parts = str.split('::');
  if (parts.length > 2) return null;

  const left = parts[0] ? parts[0].split(':').map(h => parseInt(h, 16)) : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(':').map(h => parseInt(h, 16)) : [];

  if (parts.length === 2) {
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null;
    const middle = new Array(missing).fill(0);
    return [...left, ...middle, ...right];
  }

  if (left.length !== 8) return null;
  return left;
}

export function isPublicIpv6(address) {
  const words = parseIpv6(address);
  if (!words) return false;
  // Conservative Global Unicast: 2000::/3 (0x2000 to 0x3fff)
  if ((words[0] & 0xe000) !== 0x2000) return false;
  // Exclude documentation 2001:db8::/32
  if (words[0] === 0x2001 && words[1] === 0x0db8) return false;
  // Exclude benchmarking 2001:2::/48
  if (words[0] === 0x2001 && words[1] === 0x0002) return false;
  // Exclude Orchid 2001:20::/28
  if (words[0] === 0x2001 && (words[1] & 0xfff0) === 0x0020) return false;
  // Exclude 6to4 relay 2002::/16
  if (words[0] === 0x2002) return false;
  return true;
}

export function isPublicIp(address) {
  const version = isIP(address);
  if (version === 4) return isPublicIpv4(address);
  if (version === 6) return isPublicIpv6(address);
  return false;
}

export async function validateDestination(url, approvedOrigin, lookupFn = lookup) {
  if (url.protocol !== 'https:') {
    return { ok: false, stopReason: 'HTTPS_SCHEME_REQUIRED' };
  }
  if (url.username || url.password) {
    return { ok: false, stopReason: 'URL_CREDENTIALS_REJECTED' };
  }
  if (url.port) {
    return { ok: false, stopReason: 'NONSTANDARD_PORT_REJECTED' };
  }
  if (url.origin !== approvedOrigin) {
    return { ok: false, stopReason: 'ORIGIN_REJECTED' };
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname)) {
    if (!isPublicIp(hostname)) {
      return { ok: false, stopReason: 'NON_PUBLIC_ADDRESS_REJECTED' };
    }
    return { ok: true };
  }

  let addresses;
  try {
    addresses = await lookupFn(hostname, { all: true, verbatim: true });
  } catch {
    return { ok: false, stopReason: 'DNS_LOOKUP_FAILED' };
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    return { ok: false, stopReason: 'DNS_LOOKUP_FAILED' };
  }
  for (const entry of addresses) {
    if (!isPublicIp(entry.address)) {
      return { ok: false, stopReason: 'NON_PUBLIC_ADDRESS_REJECTED' };
    }
  }
  return { ok: true };
}

function makeReceipt(url, status, contentType, bytes, sha256, observedAt, stopReason = null) {
  return {
    id: randomUUID(),
    method: 'GET',
    requestUrl: safeUrl(url),
    responseStatus: Number.isInteger(status) ? status : null,
    contentType: contentType ?? null,
    bytes: Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null,
    responseSha256: sha256 ?? null,
    observedAt,
    browserUsed: false,
    cookiesSent: false,
    authorizationSent: false,
    transport: 'native_recovery_fetch',
    ...(stopReason ? { stopReason } : {}),
  };
}

async function readBodyBounded(response, maxBytes) {
  if (!response.body) return { bytes: new Uint8Array(), error: null };
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { bytes: null, error: 'RESPONSE_TOO_LARGE' };
      }
      chunks.push(value);
    }
  } catch {
    return { bytes: null, error: 'RESPONSE_BODY_FAILED' };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, error: null };
}

export async function readNativePage(initialUrl, approvedOrigin, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const lookupFn = options.lookupFn ?? lookup;
  let remainingBudget = options.budget ?? MAX_GET_REQUESTS;
  const receipts = [];
  const redirects = [];
  let current = initialUrl;

  for (let attempt = 0; attempt <= MAX_REDIRECTS; attempt += 1) {
    if (remainingBudget <= 0) {
      return {
        ok: false,
        blocked: false,
        stopReason: 'REQUEST_BUDGET_EXHAUSTED',
        url: safeUrl(current),
        receipts,
        redirects,
        remainingBudget: 0,
      };
    }

    let url;
    try {
      url = new URL(current);
      url.hash = '';
    } catch {
      return {
        ok: false,
        blocked: true,
        stopReason: 'URL_INVALID',
        url: safeUrl(current),
        receipts,
        redirects,
        remainingBudget,
      };
    }

    const destCheck = await validateDestination(url, approvedOrigin, lookupFn);
    if (!destCheck.ok) {
      return {
        ok: false,
        blocked: true,
        stopReason: destCheck.stopReason,
        url: safeUrl(current),
        receipts,
        redirects,
        remainingBudget,
      };
    }

    remainingBudget -= 1;
    const observedAt = new Date().toISOString();
    let response;
    try {
      response = await fetchFn(url.href, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const stopReason = error?.name === 'TimeoutError' ? 'REQUEST_TIMEOUT' : 'NATIVE_FETCH_TRANSPORT_FAILED';
      const failedReceipt = makeReceipt(url.href, null, null, null, null, observedAt, stopReason);
      receipts.push(failedReceipt);
      return {
        ok: false,
        blocked: false,
        stopReason,
        url: url.href,
        receipts,
        redirects,
        remainingBudget,
      };
    }

    const status = response.status;
    const contentType = response.headers.get('content-type');

    if ([401, 403, 418, 429].includes(status)) {
      try { await response.body?.cancel(); } catch { /* Ignore */ }
      const blockedReceipt = makeReceipt(url.href, status, contentType, null, null, observedAt, 'HTTP_ACCESS_BLOCKED');
      receipts.push(blockedReceipt);
      return {
        ok: false,
        blocked: true,
        stopReason: 'HTTP_ACCESS_BLOCKED',
        url: url.href,
        status,
        receipts,
        redirects,
        remainingBudget,
      };
    }

    if (status >= 300 && status < 400) {
      const location = response.headers.get('location');
      try { await response.body?.cancel(); } catch { /* Ignore */ }
      const redirectReceipt = makeReceipt(url.href, status, contentType, null, null, observedAt);
      receipts.push(redirectReceipt);

      if (!location) {
        return {
          ok: false,
          blocked: false,
          stopReason: 'REDIRECT_LOCATION_MISSING',
          url: url.href,
          status,
          receipts,
          redirects,
          remainingBudget,
        };
      }
      let target;
      try {
        target = new URL(location, url);
        target.hash = '';
      } catch {
        return {
          ok: false,
          blocked: true,
          stopReason: 'REDIRECT_URL_INVALID',
          url: url.href,
          status,
          receipts,
          redirects,
          remainingBudget,
        };
      }
      if (url.protocol === 'https:' && target.protocol === 'http:') {
        return {
          ok: false,
          blocked: true,
          stopReason: 'REDIRECT_HTTPS_DOWNGRADE_REJECTED',
          url: url.href,
          status,
          receipts,
          redirects,
          remainingBudget,
        };
      }
      if (target.origin !== approvedOrigin) {
        return {
          ok: false,
          blocked: true,
          stopReason: 'REDIRECT_OUTSIDE_ALLOWED_ORIGIN',
          url: url.href,
          status,
          receipts,
          redirects,
          remainingBudget,
        };
      }
      redirects.push({ status, from: safeUrl(url.href), to: safeUrl(target.href) });
      current = target.href;
      continue;
    }

    if (status !== 200) {
      try { await response.body?.cancel(); } catch { /* Ignore */ }
      const errorReceipt = makeReceipt(url.href, status, contentType, null, null, observedAt);
      receipts.push(errorReceipt);
      return {
        ok: false,
        blocked: false,
        stopReason: `HTTP_STATUS_${status}`,
        url: url.href,
        status,
        receipts,
        redirects,
        remainingBudget,
      };
    }

    const mime = (contentType ?? '').split(';', 1)[0].trim().toLowerCase();
    if (!['text/html', 'application/xhtml+xml'].includes(mime)) {
      try { await response.body?.cancel(); } catch { /* Ignore */ }
      const mimeReceipt = makeReceipt(url.href, status, contentType, null, null, observedAt, 'HTML_CONTENT_TYPE_REQUIRED');
      receipts.push(mimeReceipt);
      return {
        ok: false,
        blocked: false,
        stopReason: 'HTML_CONTENT_TYPE_REQUIRED',
        url: url.href,
        status,
        contentType,
        receipts,
        redirects,
        remainingBudget,
      };
    }

    const bodyResult = await readBodyBounded(response, maxBytes);
    if (bodyResult.error) {
      const errReceipt = makeReceipt(url.href, status, contentType, null, null, observedAt, bodyResult.error);
      receipts.push(errReceipt);
      return {
        ok: false,
        blocked: false,
        stopReason: bodyResult.error,
        url: url.href,
        status,
        receipts,
        redirects,
        remainingBudget,
      };
    }

    const html = new TextDecoder('utf-8', { fatal: false }).decode(bodyResult.bytes);
    const digest = createHash('sha256').update(bodyResult.bytes).digest('hex');
    const headersObj = Object.fromEntries(response.headers.entries());
    const isChallenge = isStrongPublicChallenge(headersObj, html);
    const receiptRow = makeReceipt(
      url.href,
      status,
      contentType,
      bodyResult.bytes.length,
      digest,
      observedAt,
      isChallenge ? 'VISIBLE_CHALLENGE' : null
    );
    receipts.push(receiptRow);

    if (isChallenge) {
      return {
        ok: false,
        blocked: true,
        stopReason: 'VISIBLE_CHALLENGE',
        url: url.href,
        status,
        receipts,
        redirects,
        remainingBudget,
      };
    }

    return {
      ok: true,
      blocked: false,
      stopReason: null,
      url: url.href,
      status,
      contentType,
      html,
      receipts,
      redirects,
      remainingBudget,
    };
  }

  return {
    ok: false,
    blocked: false,
    stopReason: 'REDIRECT_LIMIT_REACHED',
    url: safeUrl(current),
    receipts,
    redirects,
    remainingBudget,
  };
}

export function decodeTurbo(array) {
  if (!Array.isArray(array)) return null;
  const cache = new Map();

  function resolve(val) {
    if (typeof val === 'number') {
      if (val < 0) {
        if (val === -1) return undefined;
        if (val === -2) return NaN;
        if (val === -3) return Infinity;
        if (val === -4) return -Infinity;
        return null;
      }
      if (cache.has(val)) return cache.get(val);
      if (val >= array.length) return null;
      return decodeEntry(array[val], val);
    }
    if (val !== null && typeof val === 'object') {
      return decodeEntry(val);
    }
    return val;
  }

  function decodeEntry(entry, index) {
    if (entry === null || typeof entry !== 'object') {
      if (index !== undefined) cache.set(index, entry);
      return entry;
    }
    if (Array.isArray(entry)) {
      const arr = [];
      if (index !== undefined) cache.set(index, arr);
      for (const item of entry) {
        arr.push(resolve(item));
      }
      return arr;
    }
    const obj = {};
    if (index !== undefined) cache.set(index, obj);
    for (const [k, v] of Object.entries(entry)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      if (k.startsWith('_')) {
        const keyIdx = Number(k.slice(1));
        const keyName = array[keyIdx];
        if (typeof keyName === 'string') {
          if (keyName === '__proto__' || keyName === 'constructor' || keyName === 'prototype') continue;
          Object.defineProperty(obj, keyName, {
            value: resolve(v),
            writable: true,
            enumerable: true,
            configurable: true,
          });
        }
      } else {
        Object.defineProperty(obj, k, {
          value: resolve(v),
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
    }
    return obj;
  }

  return resolve(0);
}

function findOhouseObjects(obj, found = [], visited = new Set()) {
  if (!obj || typeof obj !== 'object' || visited.has(obj)) return found;
  visited.add(obj);
  if (obj.name && (obj.selling_price !== undefined || obj.price !== undefined || obj.original_price !== undefined || obj.selling_cost !== undefined)) {
    found.push(obj);
  }
  if (Array.isArray(obj)) {
    for (const item of obj) findOhouseObjects(item, found, visited);
  } else {
    for (const val of Object.values(obj)) findOhouseObjects(val, found, visited);
  }
  return found;
}

export function parseOhouseStream(html, receiptId) {
  if (typeof html !== 'string') return [];
  const marker = 'streamController.enqueue(';
  const start = html.indexOf(marker);
  if (start === -1) return [];
  const end = html.indexOf(');', start);
  if (end === -1) return [];
  const arg = html.slice(start + marker.length, end).trim();
  let array;
  try {
    const unescaped = JSON.parse(arg);
    array = JSON.parse(unescaped);
  } catch {
    return [];
  }
  const decoded = decodeTurbo(array);
  if (!decoded) return [];
  const rawProducts = findOhouseObjects(decoded);
  const records = [];
  const seenIds = new Set();

  for (const p of rawProducts) {
    const id = p.id != null ? String(p.id).trim() : null;
    const title = typeof p.name === 'string' ? p.name.trim() : null;
    if (!id || !title || seenIds.has(id)) continue;
    seenIds.add(id);

    const rawAmount = p.selling_price ?? p.price ?? p.selling_cost;
    const amount = typeof rawAmount === 'number' && Number.isFinite(rawAmount) ? rawAmount
      : typeof rawAmount === 'string' && /^\d+$/.test(rawAmount.trim()) ? Number(rawAmount.trim()) : null;
    const rawList = p.original_price ?? p.cost;
    const listAmount = typeof rawList === 'number' && Number.isFinite(rawList) ? rawList
      : typeof rawList === 'string' && /^\d+$/.test(rawList.trim()) ? Number(rawList.trim()) : null;

    const reviewAvg = typeof p.review_avg === 'number' && Number.isFinite(p.review_avg) ? p.review_avg : null;
    const reviewCount = typeof p.review_count === 'number' && Number.isSafeInteger(p.review_count) ? p.review_count : null;
    const brand = typeof p.brand_name === 'string' && p.brand_name.trim() ? p.brand_name.trim() : null;

    const literalUrl = typeof p.url === 'string' && /^https?:\/\//i.test(p.url) ? safeUrl(p.url)
      : typeof p.link_url === 'string' && /^https?:\/\//i.test(p.link_url) ? safeUrl(p.link_url) : null;
    const currency = typeof p.currency === 'string' && p.currency.trim() ? p.currency.trim() : null;
    const priceText = typeof p.price_text === 'string' && p.price_text.trim() ? p.price_text.trim() : null;

    const fields = ['sourceLocalId', 'title'];
    if (literalUrl) fields.push('url');
    if (amount != null) fields.push('price');
    if (reviewAvg != null || reviewCount != null) fields.push('rating');
    if (brand) fields.push('brand');

    records.push({
      type: 'RetailProduct',
      sourceLocalId: id,
      title,
      url: literalUrl,
      description: null,
      brand,
      price: {
        amount,
        currency,
        priceText,
        listAmount,
        priceKind: 'displayed_sale_price',
      },
      rating: (reviewAvg != null || reviewCount != null) ? {
        value: reviewAvg,
        best: null,
        worst: null,
        reviewCount,
        ratingCount: null,
      } : null,
      variants: [],
      reviewSamples: [],
      evidence: [
        {
          receiptId,
          locator: `script:window.__reactRouterContext:streamController.enqueue:production[id=${id}]`,
          fields,
        },
      ],
    });
  }
  return records;
}

export function parseKbbookBooks(html, receiptId) {
  if (typeof html !== 'string') return [];
  const books = [];
  const seenIds = new Set();
  const pushMatches = [...html.matchAll(/self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g)].map(m => m[1]);

  for (const raw of pushMatches) {
    let unescaped;
    try {
      unescaped = JSON.parse(`"${raw}"`);
    } catch {
      continue;
    }
    let idx = unescaped.indexOf('saleCmdtid');
    while (idx !== -1) {
      const openBrace = unescaped.lastIndexOf('{', idx);
      if (openBrace !== -1) {
        let depth = 0;
        let closeBrace = -1;
        for (let i = openBrace; i < unescaped.length; i++) {
          if (unescaped[i] === '{') depth++;
          else if (unescaped[i] === '}') {
            depth--;
            if (depth === 0) {
              closeBrace = i;
              break;
            }
          }
        }
        if (closeBrace !== -1) {
          try {
            const item = JSON.parse(unescaped.slice(openBrace, closeBrace + 1));
            const id = item.saleCmdtid != null ? String(item.saleCmdtid).trim() : null;
            const title = typeof item.cmdtName === 'string' ? item.cmdtName.trim() : null;
            if (id && title && !seenIds.has(id)) {
              seenIds.add(id);

              const rawAmount = item.discountPrice ?? item.saleCmdtSapr;
              const amount = typeof rawAmount === 'number' && Number.isFinite(rawAmount) ? rawAmount
                : typeof rawAmount === 'string' && /^\d+$/.test(rawAmount.trim()) ? Number(rawAmount.trim()) : null;

              const brand = typeof item.pbcmName === 'string' && item.pbcmName.trim() ? item.pbcmName.trim() : null;
              const description = item.mdChoice?.description && typeof item.mdChoice.description === 'string'
                ? item.mdChoice.description.trim() : null;

              const literalUrl = typeof item.url === 'string' && /^https?:\/\//i.test(item.url) ? safeUrl(item.url)
                : typeof item.linkUrl === 'string' && /^https?:\/\//i.test(item.linkUrl) ? safeUrl(item.linkUrl) : null;
              const currency = typeof item.currency === 'string' && item.currency.trim() ? item.currency.trim() : null;
              const priceText = typeof item.priceText === 'string' && item.priceText.trim() ? item.priceText.trim() : null;

              const fields = ['sourceLocalId', 'title'];
              if (literalUrl) fields.push('url');
              if (amount != null) fields.push('price');
              if (brand) fields.push('brand');
              if (description) fields.push('description');

              books.push({
                type: 'RetailProduct',
                sourceLocalId: id,
                title,
                url: literalUrl,
                description,
                brand,
                price: {
                  amount,
                  currency,
                  priceText,
                  priceKind: 'displayed_discount_price',
                },
                rating: null,
                variants: [],
                reviewSamples: [],
                evidence: [
                  {
                    receiptId,
                    locator: `script:self.__next_f:saleCmdtid=${id}`,
                    fields,
                  },
                ],
              });
            }
          } catch {
            // Malformed segment ignored
          }
        }
      }
      idx = unescaped.indexOf('saleCmdtid', idx + 1);
    }
  }
  return books;
}

export async function collectNativeRecovery(merchantId, options = {}) {
  if (!merchantIds.includes(merchantId)) {
    throw Object.assign(new Error(`MERCHANT_NOT_IN_NATIVE_RECOVERY:${merchantId}`), { code: 'MERCHANT_NOT_IN_NATIVE_RECOVERY' });
  }

  const config = MERCHANTS_CONFIG[merchantId];
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const checkedAt = now().toISOString();

  const report = {
    merchantId,
    siteUrl: config.siteUrl,
    checkedAt,
    status: 'pending',
    receipts: [],
    records: [],
    contracts: [],
    operations: {},
    frontier: [],
  };

  // 1. Fetch root page (capping total wire GET requests to MAX_GET_REQUESTS)
  const rootResult = options.fixture
    ? options.fixture
    : await readNativePage(config.siteUrl, config.approvedOrigin, {
        ...options,
        maxBytes: MAX_BYTES,
        budget: MAX_GET_REQUESTS,
      });

  if (Array.isArray(rootResult.receipts)) {
    report.receipts.push(...rootResult.receipts);
  } else if (rootResult.receipt) {
    report.receipts.push(rootResult.receipt);
  }

  if (!rootResult.ok) {
    const isBlocked = rootResult.blocked || [401, 403, 418, 429].includes(rootResult.status);
    report.status = isBlocked ? `http_${rootResult.status ?? 403}_blocked` : rootResult.stopReason ?? 'read_failed';
    report.frontier.push({
      url: rootResult.url ?? config.siteUrl,
      state: isBlocked ? 'blocked' : 'failed',
      stopReason: rootResult.stopReason,
      receiptId: rootResult.receipts?.[0]?.id ?? rootResult.receipt?.id ?? null,
    });
    report.operations = {
      product_search: { state: 'not_observed' },
      catalog_listing: { state: isBlocked ? 'blocked' : 'failed' },
      product_detail: { state: 'not_observed' },
      price: { state: 'not_observed' },
      rating_summary: { state: 'not_observed' },
      reviews_list: { state: 'not_observed' },
      variants: { state: 'not_observed' },
    };
    return report;
  }

  // 2. Parse embedded root public records
  const rootReceiptId = rootResult.receipts?.at(-1)?.id ?? rootResult.receipt?.id ?? null;
  if (merchantId === 'ohouse') {
    report.records = parseOhouseStream(rootResult.html, rootReceiptId);
  } else if (merchantId === 'kbbook') {
    report.records = parseKbbookBooks(rootResult.html, rootReceiptId);
  }

  report.contracts.push({
    operation: 'public_homepage_embedded_state',
    method: 'GET',
    requestUrl: config.siteUrl,
    finalUrl: rootResult.url,
    receiptId: rootReceiptId,
    status: rootResult.status,
    recordsExtracted: report.records.length,
    parser: merchantId === 'ohouse' ? 'react_router_turbo_stream_parser' : 'next_f_rsc_stream_parser',
  });

  const hasOfferings = report.records.length > 0;
  report.status = hasOfferings ? 'data_observed' : 'reachable_no_normalized_records';

  const hasPrices = report.records.some(r => r.price?.amount != null);
  const hasRatings = report.records.some(r => r.rating?.value != null || r.rating?.reviewCount != null);

  report.operations = {
    product_search: {
      state: 'not_observed',
      evidenceReceiptIds: [rootReceiptId].filter(Boolean),
      note: 'Collector observes public homepage embedded stream; keyword search was not replayed.',
    },
    catalog_listing: {
      state: hasOfferings ? 'data_observed' : 'not_observed',
      evidenceReceiptIds: [rootReceiptId].filter(Boolean),
      note: `Observed ${report.records.length} commercial offerings from public root application state.`,
    },
    product_detail: {
      state: 'not_observed',
      evidenceReceiptIds: [],
      note: 'Product detail link not followed in root-embedded recovery pass.',
    },
    price: {
      state: hasPrices ? 'data_observed' : 'not_observed',
      evidenceReceiptIds: [rootReceiptId].filter(Boolean),
    },
    rating_summary: {
      state: hasRatings ? 'data_observed' : 'not_observed',
      evidenceReceiptIds: [rootReceiptId].filter(Boolean),
    },
    reviews_list: {
      state: 'not_observed',
      evidenceReceiptIds: [],
      note: 'No review text or reviewer identity is collected or persisted.',
    },
    variants: {
      state: 'not_observed',
      evidenceReceiptIds: [],
      note: 'Product variant options not collected in this pass.',
    },
  };

  report.frontier.push({
    operation: 'native_http_recovery',
    state: hasOfferings ? 'previous_rejection_retained_ordinary_native_http' : 'reachable_no_data',
    retry: false,
    note: 'Ordinary native Node fetch observed public offering data; does not assert that the prior block was solved.',
  });

  return report;
}

export const collectMerchant = collectNativeRecovery;
