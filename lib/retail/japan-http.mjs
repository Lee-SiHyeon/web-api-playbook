import { createHash } from 'node:crypto';
import { parseHTML } from 'linkedom';

export const ROOTS = Object.freeze({ rakuten: 'https://www.rakuten.co.jp/', yahoo: 'https://shopping.yahoo.co.jp/' });
export const sha = value => createHash('sha256').update(value).digest('hex');
export const fail = (code, receipt) => { throw Object.assign(new Error(code), { code, ...(receipt ? { receipt } : {}) }); };
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const clean = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
export const integer = value => Number.isSafeInteger(value) && value >= 0;
export const text = (value, max = 2000) => typeof value === 'string' && value.length > 0 && value.length <= max
  && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
export const money = (amount, basis) => {
  if (!integer(amount)) fail('JAPAN_PRICE_INVALID');
  return { amount: String(amount), currency: 'JPY', basis, checkoutPriceVerified: false };
};

// Canonicalization is also the read allowlist. No account/cart/search proxy URLs,
// signed parameters or tracking identifiers can be followed or persisted.
export function japanDestination(service, raw, base = ROOTS[service]) {
  let u;
  try { u = new URL(raw, base); } catch { return null; }
  if (!raw || u.protocol !== 'https:' || u.port || u.username || u.password
    || /[\x00-\x20\x7f\\]/.test(raw)) return null;
  const path = u.pathname;
  let kind;
  if (service === 'rakuten') {
    if (u.origin === 'https://www.rakuten.co.jp' && path === '/') kind = 'home';
    else if (u.origin === 'https://www.rakuten.co.jp' && /^\/category\/\d{1,12}\/$/.test(path)) kind = 'category';
    else if (u.origin === 'https://search.rakuten.co.jp' && /^\/search\/mall(?:\/[^/?#]{1,500})?(?:\/\d{1,12})?\/?$/.test(path)) kind = 'listing';
    else if (u.origin === 'https://item.rakuten.co.jp' && /^\/[a-zA-Z0-9._-]{1,100}\/[a-zA-Z0-9._-]{1,200}\/?$/.test(path)
      && !/\/(?:info|search|index)\.html$/.test(path)) kind = 'product';
    else if (u.origin === 'https://review.rakuten.co.jp' && /^\/item\/1\/\d+_\d+\/\d+\.\d+\/$/.test(path)) kind = 'reviews';
  } else if (service === 'yahoo') {
    if (u.origin === 'https://shopping.yahoo.co.jp' && path === '/') kind = 'home';
    else if (u.origin === 'https://shopping.yahoo.co.jp' && /^\/category\/(?:\d{1,12}\/){1,5}recommend\/?$/.test(path)) kind = 'category';
    else if (u.origin === 'https://shopping.yahoo.co.jp' && (/^\/categoryranking\/\d{1,12}\/list$/.test(path) || path === '/search')) kind = 'listing';
    else if (u.origin === 'https://store.shopping.yahoo.co.jp' && /^\/[a-zA-Z0-9_-]{1,100}\/[a-zA-Z0-9_.-]{1,200}\.html$/.test(path)
      && !/\/(?:info|search|index|privacy|guide|company|payment|shoppingguide)\.html$/.test(path)) kind = 'product';
    else if (u.origin === 'https://shopping.yahoo.co.jp' && path === '/review/item/list') kind = 'reviews';
  }
  if (!kind) return null;
  const allowed = service === 'rakuten' ? { p: /^[1-9]\d{0,3}$/, s: /^\d{1,2}$/, sitem: /^.{1,120}$/, g: /^\d{1,12}$/ }
    : kind === 'reviews' ? { store_id: /^[\w-]{1,100}$/, page_key: /^[\w.-]{1,200}$/, page: /^[1-9]\d{0,3}$/ }
      : { p: /^.{1,120}$/, b: /^[1-9]\d{0,5}$/, cid: /^\d{1,12}$/, rterm: /^(?:realtime|daily|weekly)$/, rused: /^\d$/ };
  const query = new URLSearchParams();
  if (['listing', 'reviews'].includes(kind)) for (const [key, re] of Object.entries(allowed)) {
    const values = u.searchParams.getAll(key);
    if (values.length > 1) return null;
    if (values.length && (!re.test(values[0]) || /[\x00-\x1f\x7f]/.test(values[0]))) return null;
    if (values.length) query.set(key, values[0]);
  }
  const canonical = u.origin + path + (query.size ? '?' + query : '');
  return { url: canonical, kind };
}

export function imageUrl(service, raw) {
  let u; try { u = new URL(raw); } catch { return null; }
  const hosts = service === 'rakuten'
    ? ['tshop.r10s.jp', 'thumbnail.image.rakuten.co.jp', 'image.rakuten.co.jp', 'image.space.rakuten.co.jp']
    : ['item-shopping.c.yimg.jp', 'shopping.c.yimg.jp'];
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !hosts.includes(u.hostname)) return null;
  return u.origin + u.pathname;
}

export function documentOf(html) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > 12 * 1024 * 1024) fail('JAPAN_DOCUMENT_INVALID');
  const doc = parseHTML(html).document;
  if (!doc.documentElement) fail('JAPAN_DOCUMENT_INVALID');
  return doc;
}
export function jsonScript(doc, selector) {
  const source = doc.querySelector(selector)?.textContent;
  if (!source) fail('JAPAN_DATA_MISSING');
  try { return JSON.parse(source); } catch { fail('JAPAN_DATA_INVALID'); }
}
export function assignedJson(doc, marker) {
  const scripts = [...doc.querySelectorAll('script:not([src])')].filter(s => s.textContent.includes(marker));
  if (scripts.length !== 1) fail('JAPAN_DATA_MISSING');
  const source = scripts[0].textContent;
  const at = source.indexOf(marker) + marker.length;
  const start = at + source.slice(at).search(/\S/);
  if (source[start] !== '{') fail('JAPAN_DATA_INVALID');
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(source.slice(start, i + 1)); } catch { fail('JAPAN_DATA_INVALID'); }
    }
  }
  fail('JAPAN_DATA_INVALID');
}

export function documentLinks(service, doc, sourceUrl) {
  const found = new Map();
  for (const a of doc.querySelectorAll('a[href]')) {
    const dest = japanDestination(service, a.getAttribute('href'), sourceUrl);
    if (!dest || dest.url === sourceUrl) continue;
    const label = clean(a.textContent).slice(0, 250);
    if (!found.has(dest.url)) found.set(dest.url, { ...dest, label, relation: dest.kind === 'category' ? 'navigation_link' : 'page_to_' + dest.kind });
  }
  return [...found.values()];
}

export async function japanDocument(service, raw, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const initial = japanDestination(service, raw);
  if (!initial || initial.kind === 'reviews') fail('JAPAN_READ_NOT_ALLOWED');
  let target = initial;
  const requests = [];
  for (let hop = 0; hop < 4; hop++) {
    const u = new URL(target.url);
    const checkedAt = new Date(now()).toISOString();
    let r;
    try { r = await fetchImpl(target.url, { method: 'GET', redirect: 'manual', credentials: 'omit',
      headers: { accept: 'text/html,application/xhtml+xml' }, signal: AbortSignal.timeout(25000) }); }
    catch { fail('JAPAN_TRANSPORT_FAILED', { checkedAt, url: target.url, httpStatus: null }); }
    const type = r.headers.get('content-type') ?? '';
    const receipt = { checkedAt, url: target.url, method: 'GET', origin: u.origin, path: u.pathname,
      queryFields: [...u.searchParams.keys()], httpStatus: r.status, mime: type.split(';')[0].trim().toLowerCase(),
      browserUsed: false, anonymous: true, readOnly: true, cookieSent: false, cookiesSent: false,
      authorizationSent: false, credentialsUsed: false };
    requests.push(receipt);
    if (r.redirected) { await r.body?.cancel(); fail('JAPAN_IMPLICIT_REDIRECT_REJECTED', receipt); }
    if ([301,302,303,307,308].includes(r.status)) {
      const next = japanDestination(service, r.headers.get('location'), target.url);
      await r.body?.cancel();
      if (!next || new URL(next.url).origin !== u.origin || next.kind !== target.kind || hop === 3) fail('JAPAN_REDIRECT_REJECTED', receipt);
      receipt.redirectTo = next.url; target = next; continue;
    }
    if (r.status !== 200 || receipt.mime !== 'text/html') {
      await r.body?.cancel();
      fail(r.status === 429 ? 'JAPAN_RATE_LIMITED' : r.status !== 200 ? 'JAPAN_HTTP_REJECTED' : 'JAPAN_MIME_INVALID', receipt);
    }
    const reader = r.body?.getReader();
    if (!reader) fail('JAPAN_BODY_UNREADABLE', receipt);
    const chunks = []; let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > 8 * 1024 * 1024) { await reader.cancel(); fail('JAPAN_RESPONSE_TOO_LARGE', receipt); }
        chunks.push(Buffer.from(value));
      }
    } catch (e) { if (e.code?.startsWith('JAPAN_')) throw e; fail('JAPAN_BODY_READ_FAILED', receipt); }
    finally { reader.releaseLock(); }
    const body = Buffer.concat(chunks);
    const charset = /charset\s*=\s*["']?([a-z0-9_-]+)/i.exec(type)?.[1]?.toLowerCase() ?? 'utf-8';
    if (!['utf-8','utf8','euc-jp','shift_jis','windows-31j'].includes(charset)) fail('JAPAN_CHARSET_UNSUPPORTED', receipt);
    let html;
    try { html = new TextDecoder(charset === 'windows-31j' ? 'shift_jis' : charset, { fatal: true }).decode(body); }
    catch { fail('JAPAN_DECODE_FAILED', receipt); }
    Object.assign(receipt, { responseBytes: bytes, responseSha256: sha(body), charset, documentBodyPersisted: false });
    return { url: target.url, kind: target.kind, checkedAt, html, requests };
  }
  fail('JAPAN_REDIRECT_REJECTED');
}
