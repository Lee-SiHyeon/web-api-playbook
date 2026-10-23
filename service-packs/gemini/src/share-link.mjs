const SHARE_ID = /^[A-Za-z0-9._~-]{8,256}$/;
const SHARE_HOSTS = new Set(['gemini.google.com', 'g.co']);
const MAX_NODES = 100_000;
const MAX_DEPTH = 24;
const MAX_STRING_BYTES = 2 * 1024 * 1024;

function observedShareUrl(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 8192) return null;
  const candidate = value.trim();
  if (!/^https:\/\//i.test(candidate)) return null;
  let url;
  try { url = new URL(candidate); } catch { return null; }
  if (!SHARE_HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password || url.hash) return null;
  const segments = url.pathname.split('/').filter(Boolean);
  const shareIndex = segments.findIndex((segment) => segment.toLowerCase() === 'share');
  if (shareIndex < 0 || shareIndex + 1 !== segments.length - 1) return null;
  const shareId = segments[shareIndex + 1];
  if (!SHARE_ID.test(shareId) || url.search) return null;
  return Object.freeze({ url: url.href, shareId });
}

/** Return a unique public share URL from the current CreateSharedConversation response. */
export function findCreatedShareUrl(payload) {
  const matches = new Map();
  const pending = [{ value: payload, depth: 0 }];
  let visited = 0;
  while (pending.length && visited < MAX_NODES) {
    const { value, depth } = pending.pop();
    visited += 1;
    if (depth > MAX_DEPTH) continue;
    if (typeof value === 'string') {
      const direct = observedShareUrl(value);
      if (direct) matches.set(direct.shareId, direct.url);
      const trimmed = value.trimStart();
      if (Buffer.byteLength(value, 'utf8') <= MAX_STRING_BYTES && (trimmed.startsWith('[') || trimmed.startsWith('{'))) {
        try { pending.push({ value: JSON.parse(trimmed), depth: depth + 1 }); } catch { /* Not an encoded JSON field. */ }
      }
    } else if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) pending.push({ value: value[index], depth: depth + 1 });
    } else if (value && typeof value === 'object') {
      for (const child of Object.values(value)) pending.push({ value: child, depth: depth + 1 });
    }
  }
  return matches.size === 1 ? matches.values().next().value : null;
}

export function shareIdFromCreatedUrl(rawUrl) {
  const observed = observedShareUrl(rawUrl);
  return observed?.shareId ?? null;
}
