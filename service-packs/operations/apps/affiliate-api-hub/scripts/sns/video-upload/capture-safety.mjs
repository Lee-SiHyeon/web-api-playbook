/**
 * In-memory sanitizer for observed browser upload traffic.
 *
 * This module deliberately does not log or persist its inputs. Callers should
 * sanitize each CDP request/response before serializing or writing a capture.
 */

export const REMOVED = '[REMOVED]';

const SECRET_NAMES = new Set([
  'auth', 'authorization', 'proxyauthorization', 'authentication', 'bearer',
  'cookie', 'cookies', 'setcookie', 'password', 'passwd', 'passphrase', 'pwd',
  'csrf', 'csrftoken', 'xcsrftoken', 'xsrf', 'xsrftoken', 'dtsg', 'fbdtsg',
  'fb_dtsg', 'lsd', 'jazoest', 'claim', 'wwwclaim', 'xigwwwclaim',
  'token', 'accesstoken', 'refreshtoken', 'idtoken', 'authtoken', 'sessiontoken',
  'apikey', 'clientkey', 'clientsecret', 'consumerkey', 'consumersecret',
  'privatekey', 'secret', 'signature', 'sig', 'hmac', 'jwt', 'credential',
  'credentials', 'nonce', 'attestation', 'botguard', 'acrawler', 'zti',
  'uploadid', 'uploadsessionid', 'session', 'sessionid', 'sessionkey',
  'sessionsecret', 'websessionid', 'sid', 'xsid', 'secure1psid', 'secure3psid',
  'serializeddelegationcontext', 'delegationcontext', 'visitordata',
  'serviceintegritydimensions', 'challenge', 'webresponse', 'authdata',
  'authenticationdata', 'clicktrackingparams', 'trackingparams',
  'uploadsession', 'connection', 'uploadticket', 'ticket', 'proof',
]);

const SECRET_KEY_RE = /(?:cookie|csrf|xsrf|dtsg|jazoest|claim|token|signature|hmac|credential|password|passwd|passphrase|secret|attestation|botguard|acrawler|zti|nonce|(?:^|)session(?:id|key|secret|token)|(?:^|)upload(?:session)?id|(?:^|)authorization|(?:^|)authentication|(?:^|)proxyauthorization|(?:^|)bearer|(?:^|)sid$|serializeddelegationcontext|delegationcontext|visitordata|serviceintegritydimensions|challenge|webresponse|authdata|authenticationdata|clicktrackingparams|trackingparams|uploadsession|uploadticket|ticket|proof|connection)/;
const URL_KEY_RE = /(?:^|)(?:url|uri|href|endpoint|link)$/;
const URL_RE = /(?:https?:\/\/|wss?:\/\/|[a-z][a-z0-9+.-]*:\/\/|\/\/)[^\s"'<>]+/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const INLINE_PAIR_RE = /(["']?)([A-Za-z][A-Za-z0-9_.-]{0,80})\1(\s*[:=]\s*)(["'])([^"'\\]*(?:\\.[^"'\\]*)*)\4|\b([A-Za-z][A-Za-z0-9_.-]{0,80})(\s*[:=]\s*)([^\s&;,}\])"']+)/g;

function normalizeKey(key) {
  return String(key).normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitiveKey(key) {
  const normalized = normalizeKey(key);
  if (SECRET_NAMES.has(normalized)) return true;
  return SECRET_KEY_RE.test(normalized);
}

function isUrlKey(key) {
  return URL_KEY_RE.test(normalizeKey(key));
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isUrlLike(text) {
  return /^(?:https?:\/\/|wss?:\/\/|[a-z][a-z0-9+.-]*:\/\/|\/\/|\/)/i.test(text);
}

function isOpaquePathSegment(segment) {
  let decoded = segment;
  try { decoded = decodeURIComponent(segment); } catch { /* retain raw segment */ }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(decoded)) return true;
  if (decoded.length >= 16 && /^[A-Za-z0-9_-]+$/.test(decoded) && /[A-Za-z]/.test(decoded) && /[0-9_-]/.test(decoded)) return true;
  return false;
}

const STATIC_UPLOAD_SEGMENTS = new Set([
  'api', 'v1', 'v2', 'v3', 'media', 'video', 'videos', 'image', 'images',
  'start', 'init', 'initialize', 'create', 'upload', 'uploads', 'chunk', 'chunks',
  'part', 'parts', 'finish', 'complete', 'commit', 'finalize', 'status',
  'query', 'metadata', 'session', 'sessions', 'resumable', 'nexus', 'transfer',
  'reel', 'reels', 'clip', 'clips', 'publish', 'draft', 'process', 'validate',
  'configure', 'segment', 'file', 'files', 'content', 'edit', 'update', 'get',
  'list', 'prepare', 'confirm', 'cancel', 'abort', 'delete', 'progress', 'details',
  'uploadvideo', 'createvideo', 'youtubei', 'graphql', 'creator', 'studio', 'instagram',
]);

function isStaticUploadSegment(segment) {
  const lower = String(segment).toLowerCase();
  return STATIC_UPLOAD_SEGMENTS.has(lower) || STATIC_UPLOAD_SEGMENTS.has(lower.replace(/[^a-z0-9]/g, '')) || /^v\d+$/.test(lower);
}

function isUploadMarkerSegment(segment) {
  return /(?:upload|resumable|nexus)/i.test(decodeURIComponentSafe(segment).toLowerCase().replace(/[^a-z0-9]/g, ''));
}

function sanitizePathname(pathname, { maskOpaqueAny = false, maskDynamicPath = false } = {}) {
  const segments = pathname.split('/');
  const lowerSegments = segments.map((segment) => {
    try { return decodeURIComponent(segment).toLowerCase(); } catch { return segment.toLowerCase(); }
  });
  const lowerPath = lowerSegments.join('/');
  const markerIndices = lowerSegments.map((segment, index) => isUploadMarkerSegment(segments[index]) ? index : -1).filter((index) => index >= 0);
  const uploadContext = markerIndices.length > 0;
  const nexusUploadContext = lowerPath.includes('/nexus/') && /(?:^|\/)(?:upload|uploads|resumable)(?:\/|$)/.test(lowerPath);
  const warpUpload = lowerSegments.findIndex((segment, index) => segment === 'warp' && lowerSegments[index + 2] === 'upload');

  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment) continue;
    const current = lowerSegments[index];
    const previous = lowerSegments[index - 1];
    const previousIsRoute = isUploadMarkerSegment(segments[index - 1]) || /^(?:session|sessions|uploadsession|upload_sessions?)$/.test(previous);
    const routeValue = previousIsRoute && !isStaticUploadSegment(current);
    const afterUploadMarker = markerIndices.some((markerIndex) => index > markerIndex);
    const dynamicAfterUpload = afterUploadMarker && !isStaticUploadSegment(current);
    const dynamicSignedPath = maskDynamicPath && !isStaticUploadSegment(current);
    const opaqueNexusValue = nexusUploadContext && isOpaquePathSegment(segment);
    const opaqueResumableValue = uploadContext && lowerPath.includes('/resumable/') && isOpaquePathSegment(segment);
    const warpServiceId = warpUpload >= 0 && index === warpUpload + 1;
    const warpVideoId = warpUpload >= 0 && index === warpUpload + 4 && lowerSegments[warpUpload + 2] === 'upload' && /^v\d+$/.test(lowerSegments[warpUpload + 3] ?? '');
    const opaqueLabeledId = /(?:^|[_-])(?:upload_?id|session_?id)[=_-]/i.test(decodeURIComponentSafe(segment));
    const unknownHostOpaqueValue = maskOpaqueAny && isOpaquePathSegment(segment);
    if (routeValue || dynamicAfterUpload || dynamicSignedPath || opaqueNexusValue || opaqueResumableValue || warpServiceId || warpVideoId || opaqueLabeledId || unknownHostOpaqueValue) segments[index] = REMOVED;
  }
  return segments.join('/');
}

function decodeURIComponentSafe(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function isFirstPartyHost(host) {
  return /(?:^|\.)(?:youtube\.com|googlevideo\.com|instagram\.com|facebook\.com|fbcdn\.net|naver\.com|naver\.net|pstatic\.net)$/i.test(host);
}

function hasSignedQuery(query) {
  return [...new URLSearchParams(query).keys()].some((name) => /(?:signature|sig$|token|credential|securitytoken|x-amz-|x-goog-|policy|expires|key-pair-id)/i.test(name));
}

function estimateEntropy(value) {
  const counts = new Map();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function looksLikeOpaqueCredential(value) {
  return value.length >= 32
    && /^[A-Za-z0-9_+\/-]+=*$/.test(value)
    && /[A-Za-z]/.test(value)
    && /[0-9]/.test(value)
    && estimateEntropy(value) >= 3.6;
}

function decodeCredentialBlob(value) {
  if (typeof Buffer === 'undefined' || value.length < 20 || !/^[A-Za-z0-9_+\/-]+=*$/.test(value)) return null;
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = Buffer.from(normalized, 'base64').toString('utf8');
    if (!decoded || decoded.includes('\u0000') || [...decoded].filter((character) => character.charCodeAt(0) >= 32 || '\r\n\t'.includes(character)).length < decoded.length * 0.9) return null;
    return decoded;
  } catch {
    return null;
  }
}

function sanitizeQuery(query) {
  if (!query) return '';
  const pairs = [...new URLSearchParams(query).entries()];
  if (!pairs.length) return '';
  return `?${pairs.map(([name]) => `${encodeURIComponent(name)}=${encodeURIComponent(REMOVED)}`).join('&')}`;
}

/** Keep the endpoint origin and ordinary route while dropping all query/fragment values. */
export function sanitizeUrl(value) {
  const input = String(value);
  const hashIndex = input.indexOf('#');
  const withoutHash = hashIndex < 0 ? input : input.slice(0, hashIndex);
  const queryIndex = withoutHash.indexOf('?');
  const base = queryIndex < 0 ? withoutHash : withoutHash.slice(0, queryIndex);
  const query = queryIndex < 0 ? '' : withoutHash.slice(queryIndex + 1);

  // Credentials in the authority are removed along with any URL query values.
  const schemeMatch = base.match(/^([a-z][a-z0-9+.-]*:\/\/)([^/]*)(.*)$/i);
  if (schemeMatch) {
    const [, scheme, authority, rawPath] = schemeMatch;
    const safeAuthority = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;
    const signedOpaqueUrl = Boolean(query && hasSignedQuery(query) && !isFirstPartyHost(safeAuthority.split(':')[0]));
    const isTrustedHost = isFirstPartyHost(safeAuthority.split(':')[0]);
    const safePath = signedOpaqueUrl
      ? `/${REMOVED}`
      : sanitizePathname(rawPath || '/', { maskOpaqueAny: !isTrustedHost, maskDynamicPath: Boolean(query && hasSignedQuery(query) && isTrustedHost) });
    return `${scheme}${safeAuthority}${safePath}${sanitizeQuery(query)}`;
  }

  const pathWithoutLeadingProtocol = base.startsWith('//') ? base.slice(2) : base;
  if (base.startsWith('//')) {
    const slash = pathWithoutLeadingProtocol.indexOf('/');
    const authority = slash < 0 ? pathWithoutLeadingProtocol : pathWithoutLeadingProtocol.slice(0, slash);
    const rawPath = slash < 0 ? '/' : pathWithoutLeadingProtocol.slice(slash);
    const safeAuthority = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;
    const signedOpaqueUrl = Boolean(query && hasSignedQuery(query) && !isFirstPartyHost(safeAuthority.split(':')[0]));
    const isTrustedHost = isFirstPartyHost(safeAuthority.split(':')[0]);
    return `//${safeAuthority}${signedOpaqueUrl ? `/${REMOVED}` : sanitizePathname(rawPath, { maskOpaqueAny: !isTrustedHost, maskDynamicPath: Boolean(query && hasSignedQuery(query) && isTrustedHost) })}${sanitizeQuery(query)}`;
  }
  return `${sanitizePathname(pathWithoutLeadingProtocol)}${sanitizeQuery(query)}`;
}

function encodeFormValue(value) {
  return encodeURIComponent(value).replace(/%20/g, '+');
}

function decodeFormValue(value) {
  try { return decodeURIComponent(value.replace(/\+/g, ' ')); } catch { return value; }
}

function looksLikeForm(text) {
  if (!text.includes('=')) return false;
  if (text.includes('&')) return true;
  const separator = text.indexOf('=');
  return isSensitiveKey(decodeFormValue(text.slice(0, separator)));
}

function sanitizeFormBody(text, seen) {
  const pieces = text.split('&');
  let changed = false;
  const output = pieces.map((piece) => {
    const equalsAt = piece.indexOf('=');
    const rawKey = equalsAt < 0 ? piece : piece.slice(0, equalsAt);
    const rawValue = equalsAt < 0 ? '' : piece.slice(equalsAt + 1);
    const key = decodeFormValue(rawKey);
    const value = decodeFormValue(rawValue);
    const clean = sanitizeValue(value, key, seen);
    if (clean === value || typeof clean !== 'string') return piece;
    changed = true;
    return equalsAt < 0 ? rawKey : `${rawKey}=${encodeFormValue(clean)}`;
  });
  return changed ? output.join('&') : text;
}

function parseJson(text) {
  const trimmed = text.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function sanitizeJsonString(text, parsed, seen) {
  const clean = sanitizeValue(parsed, undefined, seen);
  const before = JSON.stringify(parsed);
  const after = JSON.stringify(clean);
  return before === after ? text : after;
}

function scrubInlinePairs(text) {
  let result = text.replace(JWT_RE, REMOVED);
  result = result.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, `$1 ${REMOVED}`);
  result = result.replace(INLINE_PAIR_RE, (...args) => {
    const [, quote, quotedKey, quotedSeparator, valueQuote, , bareKey, bareSeparator] = args;
    const key = quotedKey || bareKey;
    if (!key || !isSensitiveKey(key)) return args[0];
    if (quotedKey) return `${quote}${quotedKey}${quote}${quotedSeparator}${valueQuote}${REMOVED}${valueQuote}`;
    return `${bareKey}${bareSeparator}${REMOVED}`;
  });
  return result;
}

function sanitizeString(value, keyHint, seen) {
  const text = String(value);
  if (keyHint !== undefined && isSensitiveKey(keyHint)) {
    if (isUrlKey(keyHint) && isUrlLike(text)) return sanitizeUrl(text);
    return REMOVED;
  }

  if ((keyHint !== undefined && isUrlKey(keyHint)) || isUrlLike(text)) return sanitizeUrl(text);

  const parsed = parseJson(text);
  if (parsed !== null) return sanitizeJsonString(text, parsed, seen);

  const decodedBlob = decodeCredentialBlob(text);
  if (decodedBlob !== null) {
    const decodedJson = parseJson(decodedBlob);
    if (decodedJson !== null) {
      const clean = sanitizeValue(decodedJson, undefined, seen);
      if (JSON.stringify(clean) !== JSON.stringify(decodedJson)) {
        const encoded = Buffer.from(JSON.stringify(clean), 'utf8').toString(text.includes('-') || text.includes('_') ? 'base64url' : 'base64');
        return encoded;
      }
    }
    if (looksLikeOpaqueCredential(text)) return REMOVED;
  } else if (looksLikeOpaqueCredential(text)) return REMOVED;

  // Some form fields contain percent-encoded JSON or a nested upload URL.
  if (/%(?:7b|5b|22|3a|2f|3f)/i.test(text)) {
    let decoded;
    try { decoded = decodeURIComponent(text.replace(/\+/g, ' ')); } catch { decoded = text; }
    if (decoded !== text) {
      const decodedJson = parseJson(decoded);
      if (decodedJson !== null) {
        const clean = sanitizeValue(decodedJson, undefined, seen);
        const safeJson = JSON.stringify(clean);
        if (safeJson !== JSON.stringify(decodedJson)) return encodeFormValue(safeJson);
      } else if (isUrlLike(decoded)) {
        const safeUrl = sanitizeUrl(decoded);
        if (safeUrl !== decoded) return encodeFormValue(safeUrl);
      } else if (looksLikeForm(decoded)) {
        const safeForm = sanitizeFormBody(decoded, seen);
        if (safeForm !== decoded) return encodeFormValue(safeForm);
      }
    }
  }

  if (looksLikeForm(text)) return sanitizeFormBody(text, seen);

  let result = text.replace(URL_RE, (candidate) => {
    const suffix = candidate.match(/[),.;]+$/)?.[0] ?? '';
    const url = suffix ? candidate.slice(0, -suffix.length) : candidate;
    return `${sanitizeUrl(url)}${suffix}`;
  });
  result = scrubInlinePairs(result);
  return result;
}

function headerNameIsSensitive(name) {
  return isSensitiveKey(name) || /(?:authorization|cookie|csrf|xsrf|token|signature|nonce|session|attestation|bot.?guard|acrawler|zti|claim|credential|secret|password|sid)/i.test(name);
}

function isAllowedHeader(name) {
  const lower = String(name).toLowerCase();
  if (headerNameIsSensitive(lower)) return true;
  if (lower === 'x-instagram-rupload-params') return true;
  if (/^(?:accept|accept-language|content-type|content-length|content-range|range|origin|referer|location|host|user-agent|x-requested-with)$/.test(lower)) return true;
  if (/^(?:upload-url|x-upload-url|x-goog-upload-url)$/.test(lower)) return true;
  if (/^(?:x-)?(?:upload|goog-upload)-(?:offset|length|protocol|command|chunk-size|content-length|content-type|header-content-length|header-content-type)$/.test(lower)) return true;
  if (/^x-entity-(?:length|name|type)$/.test(lower)) return true;
  return false;
}

function sanitizeHeaderValue(name, value, seen) {
  if (headerNameIsSensitive(name)) return REMOVED;
  if (typeof value === 'string') {
    if (name.toLowerCase() === 'x-instagram-rupload-params') return sanitizeBody(value);
    if (/(?:url|location|referer)/i.test(name) && isUrlLike(value)) return sanitizeUrl(value);
    return sanitizeValue(value, name, seen);
  }
  return sanitizeValue(value, name, seen);
}

/** Retain only upload-relevant safe headers; credential/attestation names keep a removal marker. */
export function sanitizeHeaders(headers) {
  const output = Array.isArray(headers) ? [] : {};
  const entries = headerEntries(headers);
  const seen = new WeakSet();
  for (const [nameValue, value] of entries) {
    const name = String(nameValue);
    if (!isAllowedHeader(name)) continue;
    const clean = sanitizeHeaderValue(name, value, seen);
    if (Array.isArray(output)) {
      if (Array.isArray(headers) && headers.every((entry) => Array.isArray(entry) && entry.length >= 2)) output.push([name, clean]);
      else output.push({ name, value: clean });
    } else {
      Object.defineProperty(output, name, { value: clean, enumerable: true, writable: true, configurable: true });
    }
  }
  return output;
}

function headerEntries(headers) {
  if (headers && typeof headers.entries === 'function' && !Array.isArray(headers)) {
    try { return [...headers.entries()]; } catch { return []; }
  }
  if (Array.isArray(headers)) {
    const entries = [];
    for (const item of headers) {
      if (Array.isArray(item) && item.length >= 2) entries.push([item[0], item[1]]);
      else if (isPlainRecord(item) && typeof item.name === 'string') entries.push([item.name, item.value]);
    }
    return entries;
  }
  if (isPlainRecord(headers)) return Object.entries(headers);
  return [];
}

function sanitizeValue(value, keyHint, seen) {
  if (keyHint !== undefined && isSensitiveKey(keyHint)) {
    if (isUrlKey(keyHint) && typeof value === 'string' && isUrlLike(value)) return sanitizeUrl(value);
    return REMOVED;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return sanitizeString(value, keyHint, seen);
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return REMOVED;
  if (value instanceof URL) return sanitizeUrl(value.href);
  if (value instanceof URLSearchParams) return sanitizeFormBody(value.toString(), seen);
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return REMOVED;
  if (typeof value !== 'object' || seen.has(value)) return REMOVED;

  if (Array.isArray(value)) {
    seen.add(value);
    const output = value.map((child) => sanitizeValue(child, undefined, seen));
    seen.delete(value);
    return output;
  }
  if (!isPlainRecord(value)) return REMOVED;

  seen.add(value);
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    const clean = /headers?$/i.test(normalizeKey(key)) ? sanitizeHeaders(child) : sanitizeValue(child, key, seen);
    Object.defineProperty(output, key, { value: clean, enumerable: true, writable: true, configurable: true });
  }
  seen.delete(value);
  return output;
}

/** Sanitize parsed CDP request/response data while it is still in memory. */
export function sanitizeCapture(value) {
  if (typeof value === 'string') return sanitizeBody(value);
  return sanitizeValue(value, undefined, new WeakSet());
}

/** Sanitize JSON, URL-encoded form data, or plain text without logging the input. */
export function sanitizeBody(body) {
  if (body instanceof URLSearchParams) return sanitizeFormBody(body.toString(), new WeakSet());
  if (typeof body !== 'string') return sanitizeCapture(body);
  const parsed = parseJson(body);
  if (parsed !== null) return sanitizeJsonString(body, parsed, new WeakSet());
  if (looksLikeForm(body)) return sanitizeFormBody(body, new WeakSet());
  return sanitizeString(body, undefined, new WeakSet());
}
