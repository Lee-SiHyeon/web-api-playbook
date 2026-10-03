const ACCESS_DENIED_TITLE = /<title\b[^>]*>\s*Access\s+Denied\s*<\/title\s*>/i;
const MAX_ERROR_BODY_BYTES = 64 * 1024;

function headerValue(headers, wantedName) {
  if (!headers || typeof headers !== 'object') return '';
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === wantedName);
  return typeof entry?.[1] === 'string' ? entry[1] : '';
}

function safeBodyText(raw) {
  try {
    if (typeof raw === 'string') return raw.slice(0, MAX_ERROR_BODY_BYTES);
    if (Buffer.isBuffer(raw)) return raw.subarray(0, MAX_ERROR_BODY_BYTES).toString('utf8');
    if (raw instanceof Uint8Array) return Buffer.from(raw.subarray(0, MAX_ERROR_BODY_BYTES)).toString('utf8');
  } catch { /* malformed error bodies stay in the generic forbidden class */ }
  return '';
}

// Distinguishes a recognizable HTML access-denied response from other 403s.
// It does not claim which edge provider produced the page and never exposes its body.
export function coupangForbiddenCode(response) {
  if (response?.status !== 403) return 'AUTH_FORBIDDEN';
  const contentType = headerValue(response.headers, 'content-type');
  if (!/^text\/html(?:\s*;|\s*$)/i.test(contentType)) return 'AUTH_FORBIDDEN';
  return ACCESS_DENIED_TITLE.test(safeBodyText(response.raw))
    ? 'COUPANG_HTTP_ACCESS_DENIED'
    : 'AUTH_FORBIDDEN';
}
