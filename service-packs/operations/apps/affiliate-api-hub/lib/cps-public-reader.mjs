import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { parseFragment } from 'parse5';

const MAX_REDIRECTS = 3;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_JSON_BLOCKS = 40;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_JSON_NODES = 300;
const MAX_LINKS = 500;
const MAX_REVIEWS = 8;
const PAGE_MIMES = new Set(['text/html', 'application/xhtml+xml']);
const RESOURCE_MIMES = new Set([
  'application/json', 'application/ld+json', 'text/json', 'application/x-json', 'text/plain',
  'application/javascript', 'text/javascript', 'application/x-javascript', 'application/ecmascript', 'text/ecmascript',
]);
const SENSITIVE_KEY = /(?:^|[_-])(?:access[_-]?token|refresh[_-]?token|token|authorization|auth|cookie|session|password|secret|csrf|email|e-mail|phone|telephone|mobile|account|credential|api[_-]?key|private[_-]?key)(?:$|[_-])/i;
const CHALLENGE_TEXT = /(?:just a moment|attention required|access denied|verify (?:that )?you are human|verify you are not a robot|checking your browser|unusual traffic|automated requests? detected|security challenge|요청이 차단|비정상적인 접근|자동\s*입력\s*방지|로봇이 아닙니다)/i;
const STRONG_CHALLENGE_HEADERS = new Set(['cf-mitigated', 'x-captcha-required', 'x-sucuri-block']);

const PRIVATE_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([address, bits]) => {
  const network = address.split('.').reduce((n, octet) => ((n << 8) | Number(octet)) >>> 0, 0);
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return { network: network & mask, mask };
});

function isPublicIpv4(address) {
  if (isIP(address) !== 4) return false;
  const value = address.split('.').reduce((n, octet) => ((n << 8) | Number(octet)) >>> 0, 0);
  return !PRIVATE_V4.some(({ network, mask }) => (value & mask) === network);
}

function normalizeAllowedHosts(allowedHosts) {
  if (!Array.isArray(allowedHosts) || allowedHosts.length === 0) return [];
  const result = [];
  for (const candidate of allowedHosts) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    try {
      const url = new URL(candidate.includes('://') ? candidate : `https://${candidate}`);
      if (url.username || url.password || url.port || !['http:', 'https:'].includes(url.protocol)) continue;
      const host = url.hostname.toLowerCase().replace(/\.$/, '');
      if (host && !result.includes(host)) result.push(host);
    } catch { /* Invalid allowlist entries never widen the scope. */ }
  }
  return result;
}

function hostAllowed(hostname, allowedHosts) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return allowedHosts.some(root => host === root || host.endsWith(`.${root}`));
}

function validateRequestUrl(value, allowedHosts) {
  let url;
  try { url = new URL(value); } catch { return { error: 'URL_INVALID' }; }
  if (!['https:', 'http:'].includes(url.protocol)) return { error: 'HTTP_SCHEME_REJECTED' };
  if (url.username || url.password) return { error: 'URL_CREDENTIALS_REJECTED' };
  if (url.port) return { error: 'NONSTANDARD_PORT_REJECTED' };
  if (!hostAllowed(url.hostname, allowedHosts)) return { error: 'HOST_OUTSIDE_ALLOWLIST' };
  if (isIP(url.hostname) === 6) return { error: 'PUBLIC_IPV4_REQUIRED' };
  if (isIP(url.hostname) === 4 && !isPublicIpv4(url.hostname)) return { error: 'NON_PUBLIC_ADDRESS_REJECTED' };
  url.hash = '';
  return { url };
}

const SAFE_QUERY_KEY = /(?:token|auth|session|password|secret|csrf|email|phone|account|credential|api[_-]?key|private[_-]?key)/i;

/** Redact credentials from observed URLs before they leave this module. */
export function safeUrl(value, baseUrl = undefined) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = baseUrl === undefined ? new URL(value) : new URL(value, baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (SAFE_QUERY_KEY.test(key)) url.searchParams.set(key, 'REDACTED');
    }
    return url.href;
  } catch { return null; }
}

function nodeAttr(node, name) {
  return node?.attrs?.find(attribute => attribute.name === name)?.value ?? null;
}

function descendants(root, predicate, output = []) {
  if (!root || output.length >= 5000) return output;
  if (predicate(root)) output.push(root);
  for (const child of root.childNodes ?? []) descendants(child, predicate, output);
  return output;
}

function textFromNode(node, output = []) {
  if (!node) return output;
  if (node.nodeName === '#text') output.push(node.value ?? '');
  if (['script', 'style', 'template', 'noscript'].includes(node.tagName)) return output;
  for (const child of node.childNodes ?? []) textFromNode(child, output);
  return output;
}

export function textContent(nodeOrHtml, limit = 4000) {
  let root = nodeOrHtml;
  if (typeof nodeOrHtml === 'string') root = parseFragment(nodeOrHtml);
  if (!root || typeof limit !== 'number' || limit < 1) return null;
  const text = textFromNode(root).join(' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, Math.floor(limit)) : null;
}

function scriptText(node) {
  return (node.childNodes ?? []).map(child => child.value ?? '').join('');
}

function safeData(value, depth = 0, budget = { nodes: 0 }, inReview = false) {
  budget.nodes += 1;
  if (budget.nodes > MAX_JSON_NODES || depth > 12) return '[TRUNCATED]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return scrubText(value, 4000);
  if (Array.isArray(value)) return value.slice(0, 100).map(item => safeData(item, depth + 1, budget, inReview));
  if (typeof value !== 'object') return null;
  const rawType = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
  const currentIsReview = inReview || rawType.some(type => typeof type === 'string' && type.split(/[\/#]/).at(-1).toLowerCase() === 'review');
  const result = {};
  for (const [key, child] of Object.entries(value).slice(0, 200)) {
    const normalizedKey = String(key).toLowerCase();
    const privateReviewText = currentIsReview && ['reviewbody', 'body', 'description'].includes(normalizedKey);
    result[String(key).slice(0, 200)] = privateReviewText ? '[OMITTED]'
      : SENSITIVE_KEY.test(key) || ['author', 'reviewer', 'revieweridentity'].includes(normalizedKey)
        ? '[REDACTED]' : safeData(child, depth + 1, budget, currentIsReview);
  }
  return result;
}

function scrubText(value, limit = 4000) {
  if (typeof value !== 'string') return null;
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[이메일]')
    .replace(/(?:\+?82[\s-]?)?0\d{1,2}[\s-]?\d{3,4}[\s-]?\d{4}/g, '[전화번호]')
    .replace(/https?:\/\/\S+/gi, '[링크]') || null;
}

function parseCharset(contentType, bytes) {
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 'utf-8'
    : bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
      : bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : null;
  if (bom) return bom;
  const header = /(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType ?? '')?.[1];
  if (header) return header;
  const prefix = bytes.subarray(0, Math.min(bytes.length, 4096)).toString('latin1');
  return /<meta\b[^>]*charset\s*=\s*["']?([^\s"'/>;]+)/i.exec(prefix)?.[1]
    ?? /<meta\b[^>]*content\s*=\s*["'][^"']*charset=([^\s"';]+)/i.exec(prefix)?.[1]
    ?? 'utf-8';
}

function decodeHtml(bytes, contentType) {
  const charset = parseCharset(contentType, bytes);
  try { return new TextDecoder(charset, { fatal: false }).decode(bytes); }
  catch { return new TextDecoder('utf-8', { fatal: false }).decode(bytes); }
}

async function resolvePinnedPublicIpv4(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) === 4) {
    if (!isPublicIpv4(host)) throw new Error('NON_PUBLIC_ADDRESS_REJECTED');
    return host;
  }
  let addresses;
  try { addresses = await lookup(host, { all: true, verbatim: true }); }
  catch { throw new Error('DNS_LOOKUP_FAILED'); }
  const ipv4 = addresses.filter(row => row.family === 4);
  if (!ipv4.length) throw new Error('PUBLIC_IPV4_REQUIRED');
  if (ipv4.some(row => !isPublicIpv4(row.address))) throw new Error('NON_PUBLIC_ADDRESS_REJECTED');
  return ipv4[0].address;
}

function requestPublicHttp(url, pinnedAddress, timeoutMs) {
  return new Promise((resolve, reject) => {
  const requestOptions = {
      method: 'GET',
      headers: { accept: 'text/html,application/xhtml+xml,application/json,application/javascript,text/javascript,*/*;q=0.1', 'accept-encoding': 'identity' },
      signal: AbortSignal.timeout(timeoutMs),
      lookup(host, options, callback) {
        if (host.toLowerCase() !== url.hostname.toLowerCase()) return callback(new Error('HOST_CHANGED'));
        if (options?.all) return callback(null, [{ address: pinnedAddress, family: 4 }]);
        callback(null, pinnedAddress, 4);
      },
    };
    if (url.protocol === 'https:' && isIP(url.hostname) !== 4) requestOptions.servername = url.hostname;
    const requestClient = url.protocol === 'https:' ? https : http;
    const request = requestClient.request(url, requestOptions, response => resolve(response));
    request.once('error', () => reject(new Error('PUBLIC_HTTP_TRANSPORT_FAILED')));
    request.end();
  });
}

async function readBoundedBody(response, maxBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      response.destroy();
      throw new Error('RESPONSE_TOO_LARGE');
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks, bytes);
  return { raw, bytes, responseSha256: createHash('sha256').update(raw).digest('hex') };
}

function headerValue(headers, name) {
  const value = headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value.join(', ') : value == null ? null : String(value);
}

function receiptFor(requestUrl, status, contentType, bytes, responseSha256 = null, observedAt = new Date().toISOString()) {
  return {
    id: randomUUID(),
    requestMethod: 'GET',
    requestUrl: safeUrl(requestUrl),
    responseStatus: Number.isInteger(status) ? status : null,
    contentType: contentType ?? null,
    bytes: Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : 0,
    responseSha256,
    observedAt,
    browserUsed: false,
    cookiesSent: false,
    authorizationSent: false,
  };
}

function strongChallenge(headers, html) {
  for (const name of STRONG_CHALLENGE_HEADERS) {
    const value = headerValue(headers, name);
    if (value && (name === 'cf-mitigated' ? /challenge/i.test(value) : /^(?:1|true|yes|blocked)$/i.test(value))) return true;
  }
  const root = parseFragment(html);
  const title = textContent(descendants(root, node => node.tagName === 'title', [])[0] ?? null, 500) ?? '';
  const headings = descendants(root, node => ['h1', 'h2'].includes(node.tagName), []).slice(0, 4).map(node => textContent(node, 500) ?? '').join(' ');
  const visible = textContent(root, 3000) ?? '';
  return CHALLENGE_TEXT.test(`${title} ${headings} ${visible}`);
}

/** True only for strong visible or response-header challenge signals. */
export function isStrongPublicChallenge(headers, html) {
  return typeof html === 'string' && strongChallenge(headers, html);
}

function isAcceptedResourceMime(mime) {
  return RESOURCE_MIMES.has(mime) || /^application\/[a-z0-9.+-]+\+json$/i.test(mime);
}

async function readPublicResponse(value, {
  allowedHosts,
  maxRedirects = MAX_REDIRECTS,
  maxBytes = MAX_BYTES,
  timeoutMs = 20_000,
  now = () => new Date(),
} = {}, resource = false) {
  const roots = normalizeAllowedHosts(allowedHosts);
  const fail = (stopReason, { url = typeof value === 'string' ? safeUrl(value) : null, status = null, contentType = null, blocked = false, redirects = [], receipt = null } = {}) => ({
    ok: false, url, status, contentType, body: null, receipt, redirects, blocked, stopReason,
  });
  if (!roots.length) return fail('ALLOWED_HOSTS_REQUIRED');
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10) return fail('REDIRECT_LIMIT_INVALID');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024) return fail('BYTE_LIMIT_INVALID');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) return fail('TIMEOUT_INVALID');

  let current = value;
  const redirects = [];
  for (let attempt = 0; attempt <= maxRedirects; attempt += 1) {
    const validated = validateRequestUrl(current, roots);
    if (validated.error) return fail(validated.error, { url: safeUrl(current), redirects });
    const url = validated.url;
    const observedAt = now().toISOString();
    let response;
    try {
      const address = await resolvePinnedPublicIpv4(url.hostname);
      response = await requestPublicHttp(url, address, timeoutMs);
    } catch (error) {
      const reason = /^(?:DNS_LOOKUP_FAILED|PUBLIC_IPV4_REQUIRED|NON_PUBLIC_ADDRESS_REJECTED)$/.test(error?.message) ? error.message : 'PUBLIC_HTTP_TRANSPORT_FAILED';
      return fail(reason, { url: safeUrl(url.href), redirects, receipt: receiptFor(url.href, null, null, 0, null, observedAt) });
    }

    const status = response.statusCode ?? 0;
    const contentType = headerValue(response.headers, 'content-type');
    if ([401, 403, 418, 429].includes(status)) {
      response.destroy();
      return fail('HTTP_ACCESS_BLOCKED', {
        url: safeUrl(url.href), status, contentType, blocked: true, redirects,
        receipt: receiptFor(url.href, status, contentType, 0, null, observedAt),
      });
    }

    if (status >= 300 && status < 400) {
      const location = headerValue(response.headers, 'location');
      response.destroy();
      if (!location) return fail('REDIRECT_LOCATION_MISSING', {
        url: safeUrl(url.href), status, contentType, redirects,
        receipt: receiptFor(url.href, status, contentType, 0, null, observedAt),
      });
      let target;
      try { target = new URL(location, url); } catch { return fail('REDIRECT_URL_INVALID', { url: safeUrl(url.href), status, contentType, redirects }); }
      if (url.protocol === 'https:' && target.protocol === 'http:') return fail('REDIRECT_HTTPS_DOWNGRADE_REJECTED', {
        url: safeUrl(url.href), status, contentType, redirects,
        receipt: receiptFor(url.href, status, contentType, 0, null, observedAt),
      });
      const targetCheck = validateRequestUrl(target.href, roots);
      if (targetCheck.error) return fail(`REDIRECT_${targetCheck.error}`, {
        url: safeUrl(url.href), status, contentType, redirects,
        receipt: receiptFor(url.href, status, contentType, 0, null, observedAt),
      });
      if (attempt >= maxRedirects) return fail('REDIRECT_LIMIT_REACHED', {
        url: safeUrl(url.href), status, contentType, redirects,
        receipt: receiptFor(url.href, status, contentType, 0, null, observedAt),
      });
      redirects.push({ status, from: safeUrl(url.href), to: safeUrl(targetCheck.url.href) });
      current = targetCheck.url.href;
      continue;
    }

    if (status !== 200) {
      response.destroy();
      return fail('HTTP_STATUS_REJECTED', {
        url: safeUrl(url.href), status, contentType, redirects,
        receipt: receiptFor(url.href, status, contentType, 0, null, observedAt),
      });
    }
    const mime = (contentType ?? '').split(';', 1)[0].trim().toLowerCase();
    if (!(resource ? isAcceptedResourceMime(mime) : PAGE_MIMES.has(mime))) {
      response.destroy();
      return fail(resource ? 'PUBLIC_RESOURCE_CONTENT_TYPE_REJECTED' : 'HTML_CONTENT_TYPE_REQUIRED', {
        url: safeUrl(url.href), status, contentType, redirects,
        receipt: receiptFor(url.href, status, contentType, 0, null, observedAt),
      });
    }

    let body;
    try { body = await readBoundedBody(response, maxBytes); }
    catch (error) {
      return fail(error?.message === 'RESPONSE_TOO_LARGE' ? 'RESPONSE_TOO_LARGE' : 'PUBLIC_HTTP_BODY_FAILED', {
        url: safeUrl(url.href), status, contentType, redirects,
        receipt: receiptFor(url.href, status, contentType, 0, null, observedAt),
      });
    }
    const text = decodeHtml(body.raw, contentType);
    const receipt = receiptFor(url.href, status, contentType, body.bytes, body.responseSha256, observedAt);
    if (resource && [...STRONG_CHALLENGE_HEADERS].some(name => {
      const value = headerValue(response.headers, name);
      return value && (name === 'cf-mitigated' ? /challenge/i.test(value) : /^(?:1|true|yes|blocked)$/i.test(value));
    })) return fail('HEADER_CHALLENGE', {
      url: safeUrl(url.href), status, contentType, blocked: true, redirects, receipt,
    });
    if (!resource && strongChallenge(response.headers, text)) return fail('VISIBLE_CHALLENGE', {
      url: safeUrl(url.href), status, contentType, blocked: true, redirects, receipt,
    });
    return { ok: true, url: safeUrl(url.href), status, contentType, body: text, receipt, redirects, blocked: false, stopReason: null };
  }
  return fail('REDIRECT_LIMIT_REACHED', { redirects });
}

/** Read an anonymous first-party HTML page, following only scoped redirects. */
export async function readPublicPage(value, options = {}) {
  const result = await readPublicResponse(value, options, false);
  const { body, ...metadata } = result;
  return { ...metadata, html: body };
}

/** Read an observed anonymous first-party JS/JSON/text resource without executing it. */
export async function readPublicResource(value, options = {}) {
  return readPublicResponse(value, options, true);
}

function typesOf(row) {
  const raw = row?.['@type'];
  const types = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return types.map(value => String(value).split(/[\/#]/).at(-1).toLowerCase());
}

function flattenJson(value, output = [], depth = 0, budget = { count: 0 }) {
  if (depth > 12 || value == null || budget.count >= 2000) return output;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 500)) flattenJson(item, output, depth + 1, budget);
    return output;
  }
  if (typeof value !== 'object') return output;
  budget.count += 1;
  output.push(value);
  for (const key of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement', 'hasVariant']) {
    if (Object.hasOwn(value, key)) flattenJson(value[key], output, depth + 1, budget);
  }
  return output;
}

function parseJsonScripts(root) {
  const scripts = descendants(root, node => node.tagName === 'script');
  const jsonLd = [];
  const rawJsonLd = [];
  const embeddedJson = [];
  let jsonBlocks = 0;
  for (const [index, script] of scripts.entries()) {
    if (jsonBlocks >= MAX_JSON_BLOCKS) break;
    const raw = scriptText(script).trim();
    if (!raw || raw.length > MAX_JSON_BYTES) continue;
    const type = (nodeAttr(script, 'type') ?? '').split(';', 1)[0].trim().toLowerCase();
    const id = nodeAttr(script, 'id');
    const isJsonLd = type === 'application/ld+json';
    const isEmbedded = type === 'application/json' || /(?:^|[-_])(?:next[_-]?data|initial[_-]?state|state|bootstrap)(?:$|[-_])/i.test(id ?? '');
    if (!isJsonLd && !isEmbedded) continue;
    jsonBlocks += 1;
    try {
      const parsed = JSON.parse(raw);
      if (isJsonLd) {
        for (const row of flattenJson(parsed)) {
          jsonLd.push(safeData(row));
          rawJsonLd.push({ row, blockIndex: index + 1 });
        }
      } else {
        embeddedJson.push({ id: scrubText(id ?? `json-${index + 1}`, 200), value: safeData(parsed) });
      }
    } catch { /* Invalid JSON is not structured evidence. */ }
  }
  return { jsonLd: jsonLd.slice(0, 500), rawJsonLd: rawJsonLd.slice(0, 500), embeddedJson: embeddedJson.slice(0, 50) };
}

function schemaOfferingType(row) {
  const types = typesOf(row);
  if (types.some(type => ['product', 'productgroup', 'productcollection', 'book'].includes(type))) return 'RetailProduct';
  if (types.some(type => ['hotel', 'lodgingbusiness', 'touristtrip', 'trip', 'event', 'touristdestination'].includes(type))) return 'TravelOffering';
  if (types.some(type => ['course', 'softwareapplication', 'creativework'].includes(type))) return 'DigitalContent';
  if (types.includes('service')) return 'ServiceOffering';
  return null;
}

function candidatePageUrls(row) {
  const values = [row.url, row['@id'], row.mainEntityOfPage?.url, row.mainEntityOfPage?.['@id'],
    typeof row.mainEntityOfPage === 'string' ? row.mainEntityOfPage : null];
  return values.filter(value => typeof value === 'string');
}

function samePageUrl(value, pageUrl) {
  try {
    const current = new URL(pageUrl);
    const candidate = new URL(value, current);
    if (candidate.origin !== current.origin || candidate.pathname.replace(/\/$/, '') !== current.pathname.replace(/\/$/, '')) return false;
    const meaningful = params => [...params].filter(([key]) => !/^(?:utm_.+|ref|affiliate|click|source|campaign)$/i.test(key));
    const candidateParams = meaningful(candidate.searchParams);
    const currentParams = meaningful(current.searchParams);
    if (candidateParams.length && currentParams.length) {
      return candidateParams.every(([key, paramValue]) => current.searchParams.getAll(key).includes(paramValue));
    }
    if (currentParams.length && !candidateParams.length) return false;
    return true;
  } catch { return false; }
}

function pointsToPage(row, pageUrl) {
  return candidatePageUrls(row).some(value => samePageUrl(value, pageUrl));
}

function isHomePage(pageUrl) {
  try {
    const url = new URL(pageUrl);
    if (!/^\/(?:index\.(?:html?|php))?$/i.test(url.pathname)) return false;
    return ![...url.searchParams.keys()].some(key => /(?:product|item|goods|sku|prd|detail|code|pno|goodsno|itemid|productid)/i.test(key));
  } catch { return true; }
}

function isStrongHomepageOffering(row, pageUrl) {
  const types = typesOf(row);
  if (!types.some(type => ['product', 'service', 'softwareapplication'].includes(type))) return false;
  if (typeof row.name !== 'string' || !row.name.trim()) return false;
  const current = new URL(pageUrl);
  const explicitlyNamesPage = candidatePageUrls(row).some(value => samePageUrl(value, current.href));
  if (!explicitlyNamesPage) return false;
  const hasStableIdentity = first(localIdentifier(row), row.serviceType, row.applicationCategory) != null;
  const rating = row.aggregateRating && typeof row.aggregateRating === 'object' ? row.aggregateRating : {};
  const hasRating = first(rating.ratingValue, rating.reviewCount, rating.ratingCount) != null;
  const hasOfferData = asList(row.offers).some(offer => offer && typeof offer === 'object'
    && first(offer.price, offer.lowPrice, offer.highPrice, offer.priceSpecification?.price, offer.url) != null);
  return Boolean(hasRating || hasOfferData || hasStableIdentity);
}

function first(...values) { return values.find(value => value !== undefined && value !== null && value !== '') ?? null; }
function asList(value) { return value == null ? [] : Array.isArray(value) ? value : [value]; }
function schemaName(value) { return typeof value === 'string' ? value : value && typeof value === 'object' ? value.name ?? null : null; }

function localIdentifier(row) {
  const identifier = row?.identifier;
  const normalizedIdentifier = typeof identifier === 'string' ? identifier
    : identifier && typeof identifier === 'object' ? first(identifier.value, identifier.propertyID) : null;
  const types = typesOf(row);
  if (types.includes('productgroup') && row?.productGroupID != null) return row.productGroupID;
  if (types.includes('service')) return first(row?.serviceId, row?.serviceID, row?.identifier?.value, typeof row?.identifier === 'string' ? row.identifier : null, row?.productID, row?.sku);
  return first(row?.sku, row?.productGroupID, row?.productID, row?.gtin, row?.gtin8, row?.gtin12, row?.gtin13, row?.gtin14, row?.isbn, row?.mpn, normalizedIdentifier);
}

function countValue(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const number = Number(value.trim());
    return Number.isSafeInteger(number) ? number : null;
  }
  return null;
}

function numericValue(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(raw)) return null;
  const amount = Number(raw.replaceAll(',', ''));
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function normalizedCurrency(value, fallbackText = '') {
  return typeof value === 'string' && /^[A-Za-z]{3}$/.test(value) ? value.toUpperCase() : /₩|원/.test(fallbackText) ? 'KRW' : null;
}

function normalizeOffer(offer, pageUrl) {
  const specifications = asList(offer.priceSpecification).filter(item => item && typeof item === 'object');
  const exactValue = first(offer.price, ...specifications.map(item => item.price));
  const lowValue = first(offer.lowPrice, ...specifications.map(item => item.minPrice));
  const highValue = first(offer.highPrice, ...specifications.map(item => item.maxPrice));
  const rawValue = exactValue;
  const rawText = rawValue == null ? null : String(rawValue);
  const currency = normalizedCurrency(first(offer.priceCurrency, ...specifications.map(item => item.priceCurrency)), rawText ?? '');
  const lowPrice = numericValue(lowValue);
  const highPrice = numericValue(highValue);
  const availabilityUrl = String(offer.availability ?? '');
  const availabilityType = availabilityUrl.split(/[\/#]/).at(-1);
  const availability = ({ InStock: 'in_stock', OutOfStock: 'out_of_stock', PreOrder: 'preorder', BackOrder: 'backorder', LimitedAvailability: 'limited' })[availabilityType] ?? 'unknown';
  const amount = numericValue(rawValue);
  let priceText = scrubText(rawText, 200);
  if (priceText == null && (lowPrice != null || highPrice != null)) {
    priceText = `${lowPrice == null ? '' : String(lowPrice)}${lowPrice != null && highPrice != null && lowPrice !== highPrice ? '–' : ''}${highPrice == null || highPrice === lowPrice ? '' : String(highPrice)}${currency ? ` ${currency}` : ''}`;
  }
  return {
    amount,
    currency,
    priceText,
    lowPrice,
    highPrice,
    type: typesOf(offer).includes('aggregateoffer') ? 'AggregateOffer' : 'Offer',
    availability,
    seller: scrubText(schemaName(offer.seller), 300),
    validFrom: typeof offer.validFrom === 'string' ? offer.validFrom.slice(0, 40) : null,
    validUntil: typeof offer.priceValidUntil === 'string' ? offer.priceValidUntil.slice(0, 40) : null,
    condition: scrubText(first(offer.itemCondition, offer.description, ...specifications.map(item => item.description)), 500),
    url: safeUrl(first(offer.url, offer['@id']), pageUrl),
  };
}

function normalizeOffers(row, pageUrl) {
  const output = [];
  const visit = (offer, depth = 0) => {
    if (!offer || typeof offer !== 'object' || output.length >= 30 || depth > 2) return;
    output.push(normalizeOffer(offer, pageUrl));
    for (const nested of asList(offer.offers)) visit(nested, depth + 1);
  };
  for (const offer of asList(row.offers)) visit(offer);
  return output;
}

function normalizePrice(row, offers) {
  const direct = first(row.price);
  const exactOffer = offers.find(offer => offer.amount != null);
  const rangeOffer = offers.find(offer => offer.type === 'AggregateOffer' && (offer.lowPrice != null || offer.highPrice != null))
    ?? offers.find(offer => offer.lowPrice != null || offer.highPrice != null);
  const rangeAmount = rangeOffer?.lowPrice != null && rangeOffer.lowPrice === rangeOffer.highPrice ? rangeOffer.lowPrice : null;
  const amount = numericValue(direct) ?? rangeAmount ?? (rangeOffer ? null : exactOffer?.amount ?? null);
  const currency = normalizedCurrency(first(row.priceCurrency, direct != null ? null : rangeOffer?.currency, exactOffer?.currency), String(direct ?? ''));
  const priceText = direct != null ? scrubText(String(direct), 200)
    : rangeOffer?.priceText ?? exactOffer?.priceText ?? null;
  return { amount, currency, priceText };
}

function normalizeRating(row) {
  const aggregate = row.aggregateRating && typeof row.aggregateRating === 'object' ? row.aggregateRating : null;
  if (!aggregate) return null;
  const value = numericValue(aggregate.ratingValue);
  const best = numericValue(aggregate.bestRating);
  const worst = numericValue(aggregate.worstRating);
  const reviewCount = countValue(aggregate.reviewCount);
  const ratingCount = countValue(aggregate.ratingCount);
  return value == null && best == null && worst == null && reviewCount == null && ratingCount == null
    ? null : { value, best, worst, reviewCount, ratingCount };
}

function normalizeReviews(row) {
  return asList(first(row.review, row.reviews)).slice(0, MAX_REVIEWS).filter(review => review && typeof review === 'object' && typesOf(review).includes('review')).map(review => ({
    title: scrubText(first(review.name, review.headline), 300),
    body: null,
    bodyAvailable: Boolean(first(review.reviewBody, review.description)),
    rating: numericValue(review.reviewRating?.ratingValue),
    publishedAt: typeof review.datePublished === 'string' && /^\d{4}-\d{2}-\d{2}(?:T\S+)?$/.test(review.datePublished) ? review.datePublished.slice(0, 40) : null,
    reviewer: null,
  }));
}

function makeRecord(row, page, receiptId, locator, typeHint) {
  const schemaType = schemaOfferingType(row);
  const type = schemaType ?? (typeof typeHint === 'string' && typeHint.trim() ? scrubText(typeHint, 80) : null);
  if (!type) return null;
  const currentUrl = new URL(page.url);
  const sourceLocalId = localIdentifier(row);
  const resolvedUrl = candidatePageUrls(row).map(value => samePageUrl(value, currentUrl.href) ? safeUrl(new URL(value, currentUrl).href) : null).find(Boolean) ?? null;
  const offers = normalizeOffers(row, currentUrl.href);
  const price = normalizePrice(row, offers);
  const rating = normalizeRating(row);
  const reviews = normalizeReviews(row);
  const variants = asList(row.hasVariant).slice(0, 30).filter(item => item && typeof item === 'object').map(item => {
    const variantOffers = normalizeOffers(item, currentUrl.href);
    return {
      sourceLocalId: localIdentifier(item) == null ? null : scrubText(String(localIdentifier(item)), 200),
      title: scrubText(item.name, 500),
      url: safeUrl(first(item.url, item['@id']), page.url),
      price: normalizePrice(item, variantOffers),
      offers: variantOffers,
    };
  });
  const fields = ['type'];
  if (sourceLocalId != null) fields.push('sourceLocalId');
  if (row.name != null) fields.push('title');
  if (row.description != null) fields.push('description');
  if (schemaName(row.brand) != null) fields.push('brand');
  if (price.amount != null || price.priceText != null) fields.push('price');
  if (offers.length) fields.push('offers');
  if (rating != null) fields.push('rating');
  if (variants.length) fields.push('variants');
  if (reviews.length) fields.push('reviewSamples');
  if (resolvedUrl) fields.push('url');
  return {
    type,
    sourceSchemaType: typeof row['@type'] === 'string' ? row['@type'] : typesOf(row).join('|'),
    sourceLocalId: sourceLocalId == null ? null : scrubText(String(sourceLocalId), 200),
    title: scrubText(row.name, 1000),
    url: resolvedUrl,
    description: scrubText(first(row.description, row.disambiguatingDescription), 4000),
    brand: scrubText(schemaName(row.brand), 300),
    price,
    offers,
    rating,
    variants,
    reviewSamples: reviews,
    evidence: [{ receiptId, locator, fields }],
  };
}

function extractMetadata(root) {
  const titleNode = descendants(root, node => node.tagName === 'title', [])[0];
  const title = textContent(titleNode, 1000);
  let description = null;
  for (const meta of descendants(root, node => node.tagName === 'meta')) {
    const name = (nodeAttr(meta, 'name') ?? nodeAttr(meta, 'property') ?? '').toLowerCase();
    if (['description', 'og:description', 'twitter:description'].includes(name)) {
      description = scrubText(nodeAttr(meta, 'content'), 4000);
      if (description) break;
    }
  }
  return { title, description };
}

function extractLinks(root, baseUrl) {
  const output = [];
  for (const node of descendants(root, row => ['a', 'link'].includes(row.tagName) && nodeAttr(row, 'href') !== null).slice(0, MAX_LINKS)) {
    const url = safeUrl(nodeAttr(node, 'href'), baseUrl);
    if (!url) continue;
    const text = node.tagName === 'a' ? textContent(node, 500) : null;
    const row = { url, text };
    const rel = nodeAttr(node, 'rel');
    if (rel) row.rel = scrubText(rel, 100);
    output.push(row);
  }
  return output;
}

function extractForms(root, baseUrl) {
  return descendants(root, node => node.tagName === 'form').slice(0, 50).map((form, index) => {
    let action = nodeAttr(form, 'action');
    if (action == null || action === '') action = baseUrl;
    action = safeUrl(action, baseUrl);
    if (!action) return null;
    const controls = descendants(form, node => ['input', 'select', 'textarea', 'button'].includes(node.tagName)).slice(0, 100).map(control => {
      const name = nodeAttr(control, 'name');
      const type = (nodeAttr(control, 'type') ?? control.tagName).toLowerCase();
      const label = nodeAttr(control, 'aria-label') ?? nodeAttr(control, 'placeholder');
      return { name: scrubText(name, 150), type: scrubText(type, 50), label: scrubText(label, 300), value: null };
    });
    return { id: scrubText(nodeAttr(form, 'id') ?? `form-${index + 1}`, 150), action, method: (nodeAttr(form, 'method') ?? 'get').toUpperCase(), controls };
  }).filter(Boolean);
}

/** Extract observed page metadata and records; only page-linked offerings become records. */
export function extractPublicPage(page, { merchantId = null, typeHint = null, documentBaseUrl = null } = {}) {
  if (!page || typeof page.html !== 'string' || typeof page.url !== 'string') {
    return { title: null, description: null, links: [], forms: [], jsonLd: [], embeddedJson: [], records: [] };
  }
  let root;
  try { root = parseFragment(page.html); } catch { return { title: null, description: null, links: [], forms: [], jsonLd: [], embeddedJson: [], records: [] }; }
  const metadata = extractMetadata(root);
  const parsed = parseJsonScripts(root);
  const rawRows = parsed.rawJsonLd.map(item => ({ row: item.row, locator: `script[type="application/ld+json"]:${item.blockIndex}` }));
  const records = [];
  const recordKeys = new Set();
  for (const item of rawRows) {
    if (!schemaOfferingType(item.row) || !pointsToPage(item.row, page.url)) continue;
    if (isHomePage(page.url) && !isStrongHomepageOffering(item.row, page.url)) continue;
    const record = makeRecord(item.row, page, page.receipt?.id ?? null, item.locator, typeHint);
    if (!record) continue;
    const identity = `${record.type}\u0000${record.sourceLocalId ?? ''}\u0000${record.url ?? ''}\u0000${record.title ?? ''}`;
    if (recordKeys.has(identity)) continue;
    recordKeys.add(identity);
    records.push(record);
  }
  return {
    title: metadata.title,
    description: metadata.description,
    links: extractLinks(root, documentBaseUrl ?? page.url),
    forms: extractForms(root, documentBaseUrl ?? page.url),
    jsonLd: parsed.jsonLd,
    embeddedJson: parsed.embeddedJson,
    records,
    ...(merchantId ? { merchantId: scrubText(merchantId, 100) } : {}),
  };
}

export const publicPageInternals = Object.freeze({ isPublicIpv4, normalizeAllowedHosts, validateRequestUrl, parseCharset, decodeHtml, isAcceptedResourceMime });
