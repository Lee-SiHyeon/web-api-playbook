export const ORIGIN = 'https://sharelink.toss.im';
const OWNER_PATH = '/api-public/v3/shopping-growth/sharelink/member';
const COOKIE_NAMES = new Set(['TGSID', 'TBIZAUTH']);
const fail = code => Object.assign(new Error(code), { code });

export function allowedUrl(value) {
  const u = new URL(value);
  if (u.origin !== ORIGIN || u.username || u.password || u.hash ||
      !(/^\/api-public\/v3\/shopping-growth\/sharelink\//.test(u.pathname) ||
        /^\/api-public\/v3\/shopping\/sharelink\//.test(u.pathname))) {
    throw fail('TOSS_REQUEST_SCOPE_REJECTED');
  }
  return u;
}

export function validateBundle(bundle) {
  if (bundle?.version !== 1 || bundle.service !== 'toss-sharelink' || bundle.allowedOrigin !== ORIGIN ||
      !Array.isArray(bundle.cookies) || !bundle.cookies.length || !bundle.expectedOwner ||
      typeof bundle.expectedOwner !== 'object' || Array.isArray(bundle.expectedOwner) ||
      !Object.hasOwn(bundle.expectedOwner, 'publisherId') || !bundle.expectedOwner.publisherId ||
      !bundle.readRequests?.member) throw fail('TOSS_STATE_INVALID');
  for (const c of bundle.cookies) {
    if (!COOKIE_NAMES.has(c.name) || !['.toss.im','toss.im','sharelink.toss.im','.sharelink.toss.im'].includes(c.domain) ||
        c.path !== '/' || !c.secure || !c.httpOnly || typeof c.value !== 'string' || !c.value ||
        /[;\r\n]/.test(c.value)) throw fail('TOSS_COOKIE_SCOPE_REJECTED');
  }
  for (const [name, request] of Object.entries(bundle.readRequests)) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name) || request.method !== 'GET') throw fail('TOSS_OPERATION_REJECTED');
    allowedUrl(request.url);
  }
  if (new URL(bundle.readRequests.member.url).pathname !== OWNER_PATH) throw fail('TOSS_OWNER_REQUEST_INVALID');
  return bundle;
}

export function ownerMatches(actualOwner, expectedOwner) {
  if (!actualOwner || typeof actualOwner !== 'object' || Array.isArray(actualOwner) ||
      !expectedOwner || typeof expectedOwner !== 'object' || Array.isArray(expectedOwner) ||
      !Object.hasOwn(expectedOwner, 'publisherId') || !expectedOwner.publisherId ||
      !Object.hasOwn(actualOwner, 'publisherId') ||
      String(actualOwner.publisherId) !== String(expectedOwner.publisherId)) return false;
  for (const key of ['userNo', 'bizUserNo']) {
    if (Object.hasOwn(expectedOwner, key) && String(actualOwner[key]) !== String(expectedOwner[key])) return false;
  }
  return true;
}

export function schema(value, depth = 0) {
  if (value === null) return 'null';
  if (depth > 7) return Array.isArray(value) ? 'array' : typeof value;
  if (Array.isArray(value)) return value.length ? [schema(value[0], depth + 1)] : [];
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, schema(v, depth + 1)]));
  return typeof value;
}

// Product detail (contract from the first-party /home bundle, GET /api-public/v3/shopping/sharelink/v2/products/{tacaItemId};
// observed 2026-09-28): seller (merchantInfo.name, reviewStat), price, delivery fee, origin, product reviews.
export const productDetailUrl = tacaItemId => {
  if (!Number.isSafeInteger(Number(tacaItemId)) || Number(tacaItemId) <= 0) throw fail('TOSS_INPUT_INVALID');
  return `${ORIGIN}/api-public/v3/shopping/sharelink/v2/products/${Number(tacaItemId)}`;
};

// Observed 2026-10-07: /links/best-ranking/daily-deals?sectionCode=TODAY_DEAL
// uses the section-items hook with size 20 and optional response paging.nextCursor.
// It supplies no tabCode. Cursor values remain request memory, never receipts.
export function todayDealItemsUrl(nextCursor = null) {
  if (nextCursor !== null && (typeof nextCursor !== 'string' || !nextCursor
      || nextCursor.length > 8192 || /[\r\n]/.test(nextCursor))) throw fail('TOSS_INPUT_INVALID');
  const u = new URL(`${ORIGIN}/api-public/v3/shopping/sharelink/curation-sections/TODAY_DEAL/items`);
  u.searchParams.set('size', '20');
  if (nextCursor !== null) u.searchParams.set('nextCursor', nextCursor);
  return u.href;
}

export async function requestWithDependencies(operation = 'member', {
  loadSession,
  fetchImpl = fetch,
  persistSession,
  url = null,
} = {}) {
  const bundle = loadSession();
  const recorded = url ? { url } : bundle.readRequests[operation];
  if (!recorded) throw fail('TOSS_OPERATION_NOT_CAPTURED');
  const u = allowedUrl(recorded.url);
  const now = Date.now() / 1000;
  const valid = bundle.cookies.filter(c => c.expires === undefined || c.expires === -1 || c.expires > now);
  if (!valid.length) throw fail('TOSS_REAUTH_REQUIRED');
  const headers = { Accept: 'application/json', Cookie: valid.map(c => `${c.name}=${c.value}`).join('; ') };
  let response;
  try { response = await fetchImpl(u, {method:'GET', headers, redirect:'manual', signal:AbortSignal.timeout(30000)}); }
  catch { throw fail('TOSS_HTTP_FAILED'); }
  if ([301,302,303,307,308,401,403].includes(response.status)) throw fail('TOSS_REAUTH_REQUIRED');
  if (!response.ok || !/application\/json/i.test(response.headers.get('content-type') || '')) throw fail('TOSS_RESPONSE_INVALID');
  let data;
  try { data = await response.json(); } catch { throw fail('TOSS_RESPONSE_INVALID'); }
  if (data.resultType !== 'SUCCESS') {
    if (/AUTH|LOGIN|UNAUTHORIZED|EXPIRED/i.test(data.error?.errorCode || '')) throw fail('TOSS_REAUTH_REQUIRED');
    throw fail('TOSS_SERVICE_REJECTED');
  }
  if (operation === 'member' && !ownerMatches(data.success, bundle.expectedOwner)) {
    throw fail('TOSS_OWNER_MISMATCH');
  }
  let rotated = false;
  for (const line of response.headers.getSetCookie?.() || []) {
    const fields = line.split(';').map(v => v.trim());
    const index = fields[0].indexOf('=');
    const name = fields[0].slice(0,index), value = fields[0].slice(index+1);
    if (!COOKIE_NAMES.has(name) || /[;\r\n]/.test(value)) continue;
    const old = bundle.cookies.find(c => c.name === name);
    if (!old) continue;
    const attrs = new Map(fields.slice(1).map(v => {const i=v.indexOf('='); return i<0?[v.toLowerCase(),true]:[v.slice(0,i).toLowerCase(),v.slice(i+1)];}));
    if (attrs.has('domain') && !['.toss.im','toss.im','sharelink.toss.im','.sharelink.toss.im'].includes(attrs.get('domain'))) continue;
    if (attrs.has('path') && attrs.get('path') !== '/') continue;
    if (!value || Number(attrs.get('max-age')) === 0) { old.expires = 0; rotated = true; continue; }
    old.value = value;
    if (attrs.has('max-age') && Number.isFinite(Number(attrs.get('max-age')))) old.expires = now + Number(attrs.get('max-age'));
    else if (attrs.has('expires') && Number.isFinite(Date.parse(attrs.get('expires')))) old.expires = Date.parse(attrs.get('expires')) / 1000;
    rotated = true;
  }
  if (rotated) persistSession(bundle);
  return { status:response.status, operation, origin:u.origin, path:u.pathname, queryKeys:[...u.searchParams.keys()], data };
}

// Link issuance (contract from the first-party /home bundle, 2026-09-28): POST /api-public/v3/shopping/sharelink/link/issue
// {tacaItemId} → shortUrl. One journaled send per option id; an issued entry is returned without sending again, and an
// intent without a result must be reconciled against the issued-links list before any new attempt.
export const ISSUE_PATH = '/api-public/v3/shopping/sharelink/link/issue';
export function shortUrlOf(data) {
  const s = data?.success?.shortUrl ?? data?.shortUrl ?? null;
  if (typeof s !== 'string') return null;
  try { const u = new URL(s); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; } catch { return null; }
}
export async function issueLinkWithDependencies(tacaItemId, { loadSession, fetchImpl = fetch, journal, now = () => new Date().toISOString() } = {}) {
  if (!Number.isSafeInteger(Number(tacaItemId)) || Number(tacaItemId) <= 0) throw fail('TOSS_ISSUE_INPUT_INVALID');
  const id = Number(tacaItemId);
  const previous = journal.read(id);
  if (previous?.state === 'issued') return { tacaItemId: id, shortUrl: previous.shortUrl, reused: true, sent: false };
  if (previous) throw fail('TOSS_ISSUE_RECONCILE_REQUIRED');
  const bundle = loadSession();
  const at = Date.now() / 1000;
  const valid = bundle.cookies.filter(c => c.expires === undefined || c.expires === -1 || c.expires > at);
  if (!valid.length) throw fail('TOSS_REAUTH_REQUIRED');
  journal.write(id, { state: 'intent', tacaItemId: id, at: now() });
  let response, data;
  try {
    response = await fetchImpl(allowedUrl(ORIGIN + ISSUE_PATH), { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30000), body: JSON.stringify({ tacaItemId: id }),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Cookie: valid.map(c => `${c.name}=${c.value}`).join('; '), Origin: ORIGIN, Referer: ORIGIN + '/home' } });
    data = await response.json();
  } catch { journal.write(id, { state: 'needs_reconciliation', tacaItemId: id, cause: 'transport', at: now() }); throw fail('TOSS_ISSUE_OUTCOME_UNKNOWN'); }
  if ([401, 403].includes(response.status) || /AUTH|LOGIN|EXPIRED/i.test(data?.error?.errorCode || '')) { journal.write(id, { state: 'rejected', tacaItemId: id, httpStatus: response.status, at: now() }); throw fail('TOSS_REAUTH_REQUIRED'); }
  const shortUrl = data?.resultType === 'SUCCESS' ? shortUrlOf(data) : null;
  if (!shortUrl) {
    journal.write(id, { state: 'rejected', tacaItemId: id, httpStatus: response.status, errorCode: data?.error?.errorCode ?? null, at: now() });
    throw fail(data?.resultType === 'SUCCESS' ? 'TOSS_ISSUE_RESPONSE_INVALID' : 'TOSS_ISSUE_REJECTED');
  }
  journal.write(id, { state: 'issued', tacaItemId: id, shortUrl, httpStatus: response.status, at: now() });
  return { tacaItemId: id, shortUrl, reused: false, sent: true };
}
// Reconcile an unclear issue: the issued-links list is the independent read.
export function findIssued(listData, tacaItemId) {
  const hit = (listData?.success?.data ?? []).find(x => Number(x.tacaItemId) === Number(tacaItemId));
  return hit ? { tacaItemId: Number(hit.tacaItemId), shortUrl: hit.shortUrl, commissionRate: hit.commissionRate ?? null, issuedAt: hit.issuedAt ?? null } : null;
}
