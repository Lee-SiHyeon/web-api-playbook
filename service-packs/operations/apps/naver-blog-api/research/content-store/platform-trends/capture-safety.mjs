import { mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_CAPTURE_DIR = 'C:\\Users\\User\\AppData\\Local\\Temp\\platform-trends-captures';
export const DRIVE_CAPTURES_ROOT = 'G:\\내 드라이브\\생활이득AI연구소-data\\captures';

const OMIT = Symbol('omit');
const SECRET_EXACT_KEYS = new Set([
  'auth',
  'authorization',
  'proxyauthorization',
  'authuser',
  'cookie',
  'cookies',
  'setcookie',
  'c_user',
  'cuser',
  'xs',
  'datr',
  'fr',
  'sb',
  'wd',
  'ct0',
  'guestid',
  'personalizationid',
  'dsuserid',
  'igdid',
  'mid',
  'rur',
  'sid',
  'hsid',
  'ssid',
  'apisid',
  'logininfo',
  'visitorinfo1live',
  'ysc',
  'ttwid',
  'uidtt',
  'odintt',
  'sidguard',
  'fb_dtsg',
  'fbdtsg',
  'lsd',
  'jazoest',
  'dtsg',
  'hsi',
  'sapisid',
  'sapisidhash',
  'session',
  'claim',
  'wwwclaim',
  'xigwwwclaim',
  'xmt',
]);

const SECRET_NAMES = new Set([
  'accesskey', 'apikey', 'clientkey', 'consumerkey', 'privatekey', 'secretkey',
  'password', 'passwd', 'passphrase', 'pwd',
  'csrftoken', 'xcsrftoken', 'xsrf', 'xsrftoken',
  'fb_dtsg', 'fbdtsg', 'lsd', 'jazoest', 'dtsg', 'hsi',
  'sapisid', 'sapisidhash', 'secure1psid', 'secure3psid', 'sidcc',
  'sessionid', 'sessionkey', 'sessionsecret', 'sessiontoken',
  'accesstoken', 'refreshtoken', 'idtoken', 'authtoken', 'oauth', 'oauth2',
  'clientsecret', 'consumersecret', 'privatekey', 'secretkey',
  'signature', 'sig', 'hmac', 'jwt', 'bearer', 'credential', 'credentials',
  'secret', 'secrets',
]);

const INLINE_SECRET_NAME = /(?:cookie|setcookie|authorization|proxyauthorization|token|csrf|xsrf|fb_dtsg|fbdtsg|jazoest|dtsg|hsi|sapisid|session|password|passwd|passphrase|apikey|clientsecret|consumersecret|privatekey|secret|signature|hmac|bearer|credential|claim)/i;
const SENSITIVE_HEADER_COLLECTION = /headers?$/i;
const OPAQUE_CAPTURE_KEYS = new Set(['controllerdata', 'feedbackmetadata', 'payload', 'urtendpointoptions', 'requestparams']);
const URL_RE = /(?:[a-z][a-z0-9+.-]*:\/\/|\/\/)[^\s"'<>]+/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

function normalizedKey(key) {
  return String(key).normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSecretKey(key) {
  const original = String(key).normalize('NFKC').toLowerCase();
  const normalized = normalizedKey(key);
  if (SECRET_EXACT_KEYS.has(original) || SECRET_EXACT_KEYS.has(normalized)) return true;
  if (SECRET_NAMES.has(normalized)) return true;
  if (/(?:token|cookie|session|secret|signature|credential|csrf|xsrf|password|passwd|passphrase|bearer)/i.test(normalized)) return true;
  if (/claim$/i.test(normalized)) return true;
  if (/auth$/i.test(normalized)) return true;
  if (/^(?:secure1psid|secure3psid)/i.test(normalized)) return true;
  if (/(?:access|refresh|id|auth|oauth|session|api|client|consumer|private|secret)[_-]?(?:token|key|secret|credential|signature)$/i.test(original)) return true;
  if (/(?:csrf|xsrf)(?:token)?$/i.test(normalized)) return true;
  if (/(?:signature|sig|hmac|jwt|bearer|credential|credentials)$/i.test(normalized)) return true;
  if (/(?:accesskeyid|secretaccesskey)$/i.test(normalized)) return true;
  if (/(?:password|passwd|passphrase|pwd)$/i.test(normalized)) return true;
  if (/^(?:x?igwwwclaim|wwwclaim)$/i.test(normalized)) return true;
  return false;
}

function isOmittedCaptureKey(key) {
  const normalized = normalizedKey(key);
  return OPAQUE_CAPTURE_KEYS.has(normalized) || /(?:cursor|continuation|tracking)/i.test(normalized);
}

function looksLikeJsonContentType(contentType) {
  return typeof contentType === 'string' && /(?:^|\s|;)(?:application|text)\/[a-z0-9.+-]*json(?:\s|;|$)/i.test(contentType.trim());
}

function captureError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function stripSensitiveUrlParts(input) {
  const text = String(input);
  const delimiter = text.search(/[?#]/);
  const pathPart = delimiter === -1 ? text : text.slice(0, delimiter);
  const tail = delimiter === -1 ? '' : text.slice(delimiter);
  try {
    const parsed = new URL(text, 'https://capture.invalid');
    if (parsed.username || parsed.password) {
      return parsed.origin === 'https://capture.invalid'
        ? `${parsed.pathname}`
        : `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    }
    if (tail) return pathPart;
  } catch {
    // Keep non-standard URL-like text to the path portion when it has a query or fragment.
    if (tail) return pathPart;
  }
  return text;
}

function redactInlineSecrets(text) {
  let result = text.replace(JWT_RE, '[REDACTED_TOKEN]');
  result = result.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, '$1 [REDACTED]');

  // Redact key/value material embedded inside a public description or stringified payload.
  const quotedPairPattern = /(["'])([A-Za-z][A-Za-z0-9_.-]{0,80})\1(\s*:\s*)(["'])([^"'\\]*(?:\\.[^"'\\]*)*)\4/g;
  result = result.replace(quotedPairPattern, (whole, quote, key, separator, valueQuote) => {
    if (!isSecretKey(key) && !INLINE_SECRET_NAME.test(normalizedKey(key))) return whole;
    return `${quote}${key}${quote}${separator}${valueQuote}[REDACTED]${valueQuote}`;
  });
  const pairPattern = /(?:^|[\s"'([{,])([A-Za-z][A-Za-z0-9_.-]{0,80})(\s*[=:]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s&;,}\])"']+)/g;
  result = result.replace(pairPattern, (whole, key, separator) => {
    if (!isSecretKey(key) && !INLINE_SECRET_NAME.test(normalizedKey(key))) return whole;
    const splitAt = whole.search(/[=:]/);
    if (splitAt < 0) return whole;
    return `${whole.slice(0, splitAt + 1)}[REDACTED]`;
  });
  return result;
}

function sanitizeString(value, keyHint) {
  let result = String(value);
  const normalizedHint = typeof keyHint === 'string' ? normalizedKey(keyHint) : '';
  if (/(?:urls?|uris?|hrefs?|links?|endpoint)$/.test(normalizedHint)) {
    result = stripSensitiveUrlParts(result);
  } else {
    result = result.replace(URL_RE, (url) => stripSensitiveUrlParts(url));
  }
  return redactInlineSecrets(result);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitizeHeaderCollection(value, seen) {
  if (isPlainRecord(value)) return sanitizeValue(value, 'headers', seen);
  if (Array.isArray(value)) {
    const pairs = [];
    for (const pair of value) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string') return OMIT;
      if (isSecretKey(pair[0])) continue;
      const cleanValue = sanitizeValue(pair[1], pair[0], seen);
      if (cleanValue !== OMIT) pairs.push([pair[0], cleanValue]);
    }
    return pairs;
  }
  // Native Headers, Map, and unfamiliar objects are opaque. Drop the whole collection.
  return OMIT;
}

function sanitizeValue(value, keyHint, seen) {
  if (keyHint !== undefined && (isSecretKey(keyHint) || isOmittedCaptureKey(keyHint))) return OMIT;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return sanitizeString(value, keyHint);
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return OMIT;

  if (value instanceof URL) return sanitizeString(value.href, keyHint ?? 'url');
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return OMIT;
  if (typeof value !== 'object') return OMIT;
  if (seen.has(value)) return OMIT;

  if (Array.isArray(value)) {
    seen.add(value);
    const output = [];
    for (const entry of value) {
      const clean = sanitizeValue(entry, keyHint, seen);
      if (clean === OMIT) continue;
      output.push(clean);
    }
    seen.delete(value);
    return output;
  }

  if (!isPlainRecord(value)) return OMIT;
  seen.add(value);
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSecretKey(key) || isOmittedCaptureKey(key)) continue;
    const clean = SENSITIVE_HEADER_COLLECTION.test(normalizedKey(key))
      ? sanitizeHeaderCollection(child, seen)
      : sanitizeValue(child, key, seen);
    if (clean === OMIT) continue;
    Object.defineProperty(output, key, { value: clean, enumerable: true, writable: true, configurable: true });
  }
  seen.delete(value);
  return output;
}

/** Return a JSON-compatible copy with credential fields and unsafe URL material omitted. */
export function sanitizeCapture(value) {
  const sanitized = sanitizeValue(value, undefined, new WeakSet());
  if (sanitized === OMIT) throw captureError('CAPTURE_UNSAFE_VALUE');
  return sanitized;
}

/** Parse and sanitize a JSON response body. Non-JSON bodies are rejected before persistence. */
export function safeCaptureText(text, contentType) {
  if (typeof text !== 'string') throw captureError('CAPTURE_UNSAFE_FORMAT');
  if (typeof contentType !== 'string' || /html|xml/i.test(contentType) || !looksLikeJsonContentType(contentType)) {
    throw captureError('CAPTURE_UNSAFE_FORMAT');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw captureError('CAPTURE_UNSAFE_FORMAT');
  }
  const sanitized = sanitizeCapture(parsed);
  let serialized;
  try {
    serialized = `${JSON.stringify(sanitized, null, 2)}\n`;
  } catch {
    throw captureError('CAPTURE_UNSAFE_VALUE');
  }
  if (serialized === undefined) throw captureError('CAPTURE_UNSAFE_VALUE');
  return serialized;
}

function assertCaptureDirectory(captureDir) {
  if (process.platform !== 'win32') throw captureError('CAPTURE_DIR_UNAVAILABLE');
  const requested = path.win32.resolve(captureDir ?? DEFAULT_CAPTURE_DIR).toLowerCase();
  const expected = path.win32.resolve(DEFAULT_CAPTURE_DIR).toLowerCase();
  if (requested !== expected) throw captureError('CAPTURE_DIR_NOT_ALLOWED');
  return path.win32.resolve(DEFAULT_CAPTURE_DIR);
}

function assertCaptureBasename(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.json$/i.test(name)) {
    throw captureError('CAPTURE_NAME_INVALID');
  }
  if (name.includes('..') || path.win32.basename(name) !== name || /[\\/:]/.test(name)) {
    throw captureError('CAPTURE_NAME_INVALID');
  }
  return name;
}

/** Persist sanitized JSON only in the approved transient capture directory. */
export async function persistCapture(name, text, { captureDir = DEFAULT_CAPTURE_DIR, contentType = 'application/json' } = {}) {
  const safeName = assertCaptureBasename(name);
  const safeDir = assertCaptureDirectory(captureDir);
  const sanitized = safeCaptureText(text, contentType);
  await mkdir(safeDir, { recursive: true });
  const resolvedDir = await realpath(safeDir);
  // Owner 2026-10-04: raw collection lives on Drive, and %TEMP%\*-captures is a junction to the same folder name under
  // the Drive captures root. Only that exact target is accepted besides the folder itself.
  const driveTarget = path.win32.join(DRIVE_CAPTURES_ROOT, path.win32.basename(safeDir)).toLowerCase();
  const resolved = path.win32.resolve(resolvedDir).toLowerCase();
  if (resolved !== path.win32.resolve(safeDir).toLowerCase() && resolved !== driveTarget) {
    throw captureError('CAPTURE_DIR_NOT_ALLOWED');
  }
  const outputPath = path.win32.join(safeDir, safeName);
  const handle = await open(outputPath, 'wx');
  try {
    await handle.writeFile(sanitized, { encoding: 'utf8' });
  } finally {
    await handle.close();
  }
  return outputPath;
}
