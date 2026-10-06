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
  for (const cookie of bundle.cookies) {
    if (!COOKIE_NAMES.has(cookie.name) || !['.toss.im', 'toss.im', 'sharelink.toss.im', '.sharelink.toss.im'].includes(cookie.domain) ||
        cookie.path !== '/' || !cookie.secure || !cookie.httpOnly || typeof cookie.value !== 'string' || !cookie.value ||
        /[;\r\n]/.test(cookie.value)) throw fail('TOSS_COOKIE_SCOPE_REJECTED');
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
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, schema(item, depth + 1)]));
  return typeof value;
}

export async function requestWithDependencies(operation = 'member', { loadSession, fetchImpl = fetch, persistSession } = {}) {
  const bundle = loadSession();
  const recorded = bundle.readRequests[operation];
  if (!recorded) throw fail('TOSS_OPERATION_NOT_CAPTURED');
  const url = allowedUrl(recorded.url);
  const now = Date.now() / 1000;
  const validCookies = bundle.cookies.filter(cookie => cookie.expires === undefined || cookie.expires === -1 || cookie.expires > now);
  if (!validCookies.length) throw fail('TOSS_REAUTH_REQUIRED');
  const headers = { Accept: 'application/json', Cookie: validCookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') };
  let response;
  try { response = await fetchImpl(url, { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(30000) }); }
  catch { throw fail('TOSS_HTTP_FAILED'); }
  if ([301, 302, 303, 307, 308, 401, 403].includes(response.status)) throw fail('TOSS_REAUTH_REQUIRED');
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
    const fields = line.split(';').map(value => value.trim());
    const index = fields[0].indexOf('=');
    const name = fields[0].slice(0, index), value = fields[0].slice(index + 1);
    if (!COOKIE_NAMES.has(name) || /[;\r\n]/.test(value)) continue;
    const old = bundle.cookies.find(cookie => cookie.name === name);
    if (!old) continue;
    const attrs = new Map(fields.slice(1).map(field => {
      const i = field.indexOf('=');
      return i < 0 ? [field.toLowerCase(), true] : [field.slice(0, i).toLowerCase(), field.slice(i + 1)];
    }));
    if (attrs.has('domain') && !['.toss.im', 'toss.im', 'sharelink.toss.im', '.sharelink.toss.im'].includes(attrs.get('domain'))) continue;
    if (attrs.has('path') && attrs.get('path') !== '/') continue;
    if (!value || Number(attrs.get('max-age')) === 0) { old.expires = 0; rotated = true; continue; }
    old.value = value;
    if (attrs.has('max-age') && Number.isFinite(Number(attrs.get('max-age')))) old.expires = now + Number(attrs.get('max-age'));
    else if (attrs.has('expires') && Number.isFinite(Date.parse(attrs.get('expires')))) old.expires = Date.parse(attrs.get('expires')) / 1000;
    rotated = true;
  }
  if (rotated) persistSession(bundle);
  return { status: response.status, operation, origin: url.origin, path: url.pathname, queryKeys: [...url.searchParams.keys()], data };
}
