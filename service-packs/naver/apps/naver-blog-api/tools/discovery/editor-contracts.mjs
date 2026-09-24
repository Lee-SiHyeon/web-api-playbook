import { createHash } from 'node:crypto';
import { ApiError } from '../../scripts/client.mjs';

export const BLOG = '4053103';
export const ADMIN_ROOT = `https://admin.blog.naver.com/${BLOG}`;
export const PUBLIC_ROOT = `https://blog.naver.com/${BLOG}`;
const appOrigins = new Set(['https://admin.blog.naver.com', 'https://blog.naver.com']);
const sensitive = /token|secret|auth|session|csrf|password|cookie|signature|email|search|keyword|^(?:q|code|state|key|nid_aut|nid_ses)$/i;
const pageFields = new Set(['blogId', 'logNo', 'categoryNo', 'parentCategoryNo', 'currentPage', 'viewDate', 'widgetTypeCall', 'topReferer', 'trackingCode', 'directAccess', 'skinType', 'skinId', 'from']);
const editorFields = new Set(['blogId', 'logNo', 'categoryNo']);
const safeId = /^[a-zA-Z_$][\w$.-]{0,100}$/;
export const resourceId = url => createHash('sha256').update(url).digest('hex').slice(0, 20);

export function metadata(raw) {
  const url = new URL(raw);
  return { id: resourceId(url.href), url: url.origin + url.pathname,
    queryFields: [...new Set([...url.searchParams.keys()].filter(k => safeId.test(k)))].sort() };
}

// Being present in HTML or JavaScript is not proof that an endpoint is safe.
// This classifies a small set of read documents, not write/API contracts.
export function classifyRead(raw, kind = 'link') {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' || u.port || u.username || u.password || u.hash || /%23|%7b|%7d/i.test(u.pathname)) return null;
  const fields = [...u.searchParams.keys()];
  if (fields.length !== new Set(fields).size || fields.some(k => sensitive.test(k))) return null;
  if ([...u.searchParams.values()].some(v => /[\r\n]|\[redacted\]|[<>]/i.test(v))) return null;
  if (u.href === ADMIN_ROOT) return 'admin_read_document';
  if (kind === 'script' && u.hostname === 'ssl.pstatic.net' && /\.js$/i.test(u.pathname) && fields.every(k => ['v', '_', 't'].includes(k))) return 'public_script';
  if (u.origin !== 'https://blog.naver.com') return null;
  if (new RegExp(`^/${BLOG}(?:/\\d+)?$`).test(u.pathname)) return fields.length === 0 ? 'public_blog_document' : null;
  const isEditor = /^\/(?:PostWriteForm|PostUpdateForm)\.naver$/.test(u.pathname);
  if (!isEditor && !/^\/(?:PostList|PostView)\.naver$/.test(u.pathname)) return null;
  if (u.searchParams.get('blogId') !== BLOG) return null;
  const allowedFields = isEditor ? editorFields : pageFields;
  if (fields.some(k => !allowedFields.has(k))) return null;
  for (const k of ['logNo', 'categoryNo', 'parentCategoryNo', 'currentPage']) {
    if (u.searchParams.has(k) && !/^\d+$/.test(u.searchParams.get(k))) return null;
  }
  if (u.searchParams.has('topReferer')) {
    try {
      const r = new URL(u.searchParams.get('topReferer'));
      if (!appOrigins.has(r.origin) || r.username || r.password || r.hash || [...r.searchParams.keys()].some(k => sensitive.test(k))) return null;
    } catch { return null; }
  }
  return isEditor ? 'editor_form_document' : 'public_post_document';
}

function decodeAttribute(s) {
  return s.replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#(?:x([\da-f]+)|(\d+));/gi, (all, hex, dec) => {
    const n = Number.parseInt(hex || dec, hex ? 16 : 10);
    return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
  });
}

export function discoverHTML(body, base) {
  const output = [];
  const executable = [];
  const fields = new Set();
  // Extract literal tag attributes only. JS templates are candidates, not DOM.
  const html = body.replace(/<!--[\s\S]*?-->/g, '').replace(/(<script\b[^>]*>)[\s\S]*?<\/script\s*>/gi, '$1</script>');
  for (const tag of html.matchAll(/<(a|iframe|script|form|input|textarea|select)\b([^>]*)>/gi)) {
    const name = tag[1].toLowerCase();
    const attrs = Object.fromEntries([...tag[2].matchAll(/\b([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m => [m[1].toLowerCase(), decodeAttribute(m[2] ?? m[3])]));
    if (['input', 'textarea', 'select'].includes(name)) {
      if (safeId.test(attrs.name || '')) fields.add(attrs.name);
      continue;
    }
    const raw = attrs[name === 'a' ? 'href' : name === 'form' ? 'action' : 'src'];
    if (!raw) continue;
    let u;
    try { u = new URL(raw, base); } catch { continue; }
    if (u.protocol !== 'https:' || (!appOrigins.has(u.origin) && u.hostname !== 'ssl.pstatic.net')) continue;
    const kind = name === 'script' ? 'script' : name === 'form' ? 'form' : name === 'iframe' ? 'frame' : 'link';
    const classification = kind !== 'form' ? classifyRead(u.href, kind) : null;
    const record = { ...metadata(u.href), kind, state: classification ? 'read_candidate' : 'unreviewed_candidate', classification,
      source: 'HTTP_HTML_literal_attribute', ...(kind === 'form' ? { method: (attrs.method || 'GET').toUpperCase() } : {}) };
    output.push(record);
    if (classification) executable.push({ id: record.id, url: u.href, kind, classification });
  }
  return { links: [...new Map(output.map(x => [x.id + ':' + x.kind, x])).values()],
    formFieldNames: [...fields].sort(), executable };
}

export function scanSource(body, base, terms = ['PostWrite', 'PostUpdate', 'PostDelete', 'documentModel', 'editor', 'sticker']) {
  if (!Array.isArray(terms) || terms.length > 20 || terms.some(t => typeof t !== 'string' || !/^[\w.-]{1,64}$/.test(t))) throw new ApiError('INPUT', 'Supply at most 20 identifier search terms');
  const candidates = [];
  for (const match of body.matchAll(/["'`]((?:https:\/\/[^\s"'`<>]+)?\/[A-Za-z0-9_./?=&%{}:-]+)["'`]/g)) {
    if (!terms.some(t => match[1].toLowerCase().includes(t.toLowerCase()))) continue;
    try {
      const url = new URL(match[1], base);
      if (!appOrigins.has(url.origin)) continue;
      candidates.push({ ...metadata(url.href), source: 'source_candidate', captured: false, executable: false });
    } catch {}
  }
  // Return matching property/declaration names only, never arbitrary string values.
  const identifiers = [...new Set([...body.matchAll(/\b([A-Za-z_$][\w$]{2,100})\s*(?=[:=(])/g)]
    .map(m => m[1]).filter(x => terms.some(t => x.toLowerCase().includes(t.toLowerCase()))))].slice(0, 100);
  return { ...metadata(base), identifiers,
    candidates: [...new Map(candidates.map(x => [x.url + x.queryFields.join(','), x])).values()].slice(0, 100) };
}

export function hasStrongAdminEvidence(body) {
  const actorMatched = body.includes(`/${BLOG}/config/bloginfo`)
    || body.includes(`/${BLOG}/stat/today`)
    || body.includes(`blogId=${BLOG}`)
    || body.includes(`blogId%3D${BLOG}`)
    || new RegExp(`["']blogId["']\\s*:\\s*["']?${BLOG}["']?`).test(body);
  const adminShell = /Admin(?:UserBasic|Main)\.naver|adminMain\.|id=["']lnbMenu|블로그\s*(?:관리|글쓰기)/i.test(body);
  return body.length >= 1024 && actorMatched && adminShell;
}

export function hasStrongEditorEvidence(body) {
  const actorMatched = body.includes(`blogId=${BLOG}`)
    || body.includes(`blogId%3D${BLOG}`)
    || new RegExp(`["']blogId["']\\s*[:=]\\s*["']?${BLOG}["']?`).test(body)
    || new RegExp(`\\bblogId\\s*=\\s*["']?${BLOG}["']?`).test(body)
    || new RegExp(`(?:value|content)\\s*=\\s*["']${BLOG}["']`, 'i').test(body);
  const editorShell = /PostWriteForm|PostUpdateForm|PostWrite\.naver|PostUpdate\.naver|documentModel|SmartEditor|se[-_.]?(?:component|document|editor)|editorVersion/i.test(body);
  return body.length >= 1024 && actorMatched && editorShell;
}

export function isLoginHTML(body) {
  const loginMarkup = /<form\b[^>]*action\s*=\s*["'][^"']*(?:nid\.naver\.com\/nidlogin|\/nidlogin\.login)/i.test(body)
    || /(?:location(?:\.href)?|location\.replace\()\s*=?\s*["']https:\/\/nid\.naver\.com\/nidlogin/i.test(body)
    || (/<input\b[^>]*type\s*=\s*["']password["']/i.test(body) && /nidlogin|nid\.naver\.com/i.test(body));
  // Naver's authenticated management shell can contain dormant login markup in bundled templates.
  // Strong actor-scoped admin evidence takes precedence over that embedded, non-active markup.
  return loginMarkup && !hasStrongAdminEvidence(body) && !hasStrongEditorEvidence(body);
}

export async function fetchDocument(raw, { kind = 'link', session = null, fetchImpl = globalThis.fetch, maxBytes = 12 * 1024 * 1024, timeoutMs = 20000, now = Date.now } = {}) {
  const classification = classifyRead(raw, kind);
  if (!classification) throw new ApiError('UNREVIEWED', 'Not a classified read document or observed static script');
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 12 * 1024 * 1024 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new ApiError('INPUT', 'Invalid HTTP read budget');
  const isApp = appOrigins.has(new URL(raw).origin);
  const credentials = isApp && session ? session.cookieFor(raw) : '';
  try {
    const response = await fetchImpl(raw, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'text/html,application/javascript;q=0.9', referer: ADMIN_ROOT,
        ...(credentials ? { cookie: credentials, ...(session.userAgent ? { 'user-agent': session.userAgent } : {}) } : {}) } });
    const receipt = { ...metadata(raw), method: 'GET', httpStatus: response.status, checkedAt: new Date(now()).toISOString(),
      source: 'independent_HTTP', classification, credentialSupplied: Boolean(credentials), authenticated: 'not_established' };
    if (response.status !== 200) {
      await response.body?.cancel();
      receipt.state = [401, 403].includes(response.status) ? 'blocked_auth_or_permission' : response.status >= 300 && response.status < 400 ? 'blocked_redirect' : 'blocked_http';
      return { receipt, body: null };
    }
    const mime = (response.headers.get('content-type') || '').toLowerCase();
    if (!/^(?:text\/(?:html|javascript)|application\/(?:javascript|x-javascript))(?:\s*;|$)/i.test(mime)) {
      await response.body?.cancel(); throw new ApiError('MIME', 'Expected HTML or JavaScript');
    }
    if (!response.body) throw new ApiError('SCHEMA', 'HTTP response has no body');
    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body.cancel(); throw new ApiError('SIZE', 'Read exceeds response budget');
    }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) throw new ApiError('SIZE', 'Read exceeds response budget');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    let charset = /charset=["']?([^;\s"']+)/i.exec(mime)?.[1] || 'utf-8';
    if (/ms949|ks_c_5601-1987/i.test(charset)) charset = 'euc-kr';
    const body = new TextDecoder(charset).decode(bytes);
    const login = mime.startsWith('text/html') && isLoginHTML(body);
    Object.assign(receipt, { mime: mime.split(';')[0], bytes: size, sha256: createHash('sha256').update(bytes).digest('hex'),
      loginHTML: login, state: login ? 'blocked_auth' : 'http_document_read' });
    return { receipt, body: login ? null : body };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'TIMEOUT' : 'TRANSPORT', 'HTTP discovery failed; raw response and connection details omitted');
  }
}
