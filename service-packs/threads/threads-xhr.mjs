import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { parseThreadsPayload } from './threads-public.mjs';
import { loadThreadsSession, storeThreadsSession } from './session-vault.mjs';

// Captured read-only GraphQL operation. No arbitrary operation or HTML fallback.
const origin = 'https://www.threads.com';
export function decodeViews(body) {
  let value;
  try { value = JSON.parse(body.replace(/^for \(;;\);\s*/, '')); } catch { throw new Error('THREADS_XHR_NOT_JSON'); }
  if (value.errors?.length || value.error) throw new Error('THREADS_XHR_SERVICE_ERROR');
  const info = value.data?.media?.text_post_app_info;
  if (!info || !Object.hasOwn(info, 'impression_count') || (info.impression_count !== null && (!Number.isSafeInteger(info.impression_count) || info.impression_count < 0))) throw new Error('THREADS_XHR_SCHEMA_UNVERIFIED');
  return { views: info.impression_count, availability: info.impression_count === null ? 'not_provided_by_server' : 'available' };
}

async function bounded(response, limit = 3000000) {
  let size = 0; const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('THREADS_XHR_RESPONSE_LIMIT');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function bootstrapSession(handle, code, fetchImpl, { force = false } = {}) {
  if (!force) {
    try {
      const cached = await loadThreadsSession(handle, code);
      if (cached) return cached;
    } catch {}
  }
  const referer = origin + '/@' + handle + (code ? '/post/' + code : '');
  const bootstrap = await fetchImpl(referer, { redirect: 'error', headers: { accept: 'text/html' }, signal: AbortSignal.timeout(15000) });
  if (bootstrap.status !== 200) throw new Error('THREADS_BOOTSTRAP_HTTP');
  const html = await bounded(bootstrap);
  const modules = new Map(); let profileContract;
  function walk(v, depth = 0) {
    if (!v || typeof v !== 'object' || depth > 60) return;
    if (Array.isArray(v) && ['LSD', 'SiteData'].includes(v[0])) modules.set(v[0], v[2]);
    if (v.queryName === 'BarcelonaProfileThreadsTabDirectQuery' && /^\d+$/.test(v.queryID || '') && v.variables?.userID) profileContract = { name: v.queryName, docId: v.queryID, variables: v.variables };
    for (const child of Object.values(v)) walk(child, depth + 1);
  }
  for (const m of html.matchAll(/<script\b[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) {
    try { walk(JSON.parse(m[1])); } catch {}
  }
  const lsd = modules.get('LSD')?.token;
  const site = modules.get('SiteData');
  const cookieHeader = (bootstrap.headers.getSetCookie?.() || []).find(c => c.startsWith('csrftoken='));
  const cookie = cookieHeader?.split(';')[0];
  if (!lsd || !site || !cookie) throw new Error('THREADS_BOOTSTRAP_MISSING');
  const csrf = cookie.slice('csrftoken='.length);
  let maxAge = null;
  let expiresAt = null;
  const now = Date.now();
  for (const attribute of cookieHeader.split(';').slice(1)) {
    const index = attribute.indexOf('=');
    const key = (index < 0 ? attribute : attribute.slice(0, index)).trim().toLowerCase();
    const value = index < 0 ? '' : attribute.slice(index + 1).trim();
    if (key === 'max-age' && /^-?\d+$/.test(value)) maxAge = Number(value);
    if (key === 'expires' && Number.isFinite(Date.parse(value))) expiresAt = Date.parse(value);
  }
  const ttlMs = Math.min(300000, maxAge === null ? (expiresAt === null ? 300000 : expiresAt - now) : maxAge * 1000);
  if (!Number.isFinite(ttlMs) || ttlMs < 1000) throw new Error('THREADS_BOOTSTRAP_EXPIRED');
  const session = { handle, code: code || null, referer, lsd, site, cookie, csrf, profileContract,
    expiresAt: now + ttlMs, reusedSession: false };
  try { await storeThreadsSession(session, { now, ttlMs }); }
  catch (error) {
    const code = /^[A-Z_0-9]+$/.test(error?.message || '') ? error.message : 'THREADS_SESSION_STORE_FAILED';
    throw new Error(code);
  }
  return session;
}

async function persistThreadsRotation(session, response) {
  const headers = response.headers.getSetCookie?.() || [];
  let changed = false;
  for (const header of headers) {
    if (header.length > 8192 || /[\r\n]/.test(header)) continue;
    const [pair, ...attributes] = header.split(';');
    const equal = pair.indexOf('=');
    if (equal < 1 || pair.slice(0, equal).trim() !== 'csrftoken') continue;
    const value = pair.slice(equal + 1).trim();
    if (!value || value.length > 4096 || !/^[\x21-\x7e]+$/.test(value) || /[;\r\n]/.test(value)) continue;
    let domain = 'www.threads.com';
    let maxAge = null;
    let expiresAt = null;
    const now = Date.now();
    for (const attribute of attributes) {
      const index = attribute.indexOf('=');
      const key = (index < 0 ? attribute : attribute.slice(0, index)).trim().toLowerCase();
      const part = index < 0 ? '' : attribute.slice(index + 1).trim();
      if (key === 'domain') domain = part.toLowerCase().replace(/^\./, '');
      if (key === 'max-age' && /^-?\d+$/.test(part)) maxAge = Number(part);
      if (key === 'expires' && Number.isFinite(Date.parse(part))) expiresAt = Date.parse(part);
    }
    const ttlMs = Math.min(300000, maxAge === null ? (expiresAt === null ? 300000 : expiresAt - now) : maxAge * 1000);
    if (!['threads.com', 'www.threads.com'].includes(domain) || ttlMs < 1000 || ttlMs > 86400000) continue;
    if (session.csrf !== value) {
      session.csrf = value;
      session.cookie = 'csrftoken=' + value;
      session.expiresAt = now + ttlMs;
      changed = true;
    }
  }
  if (changed) {
    try { await storeThreadsSession(session); }
    catch (error) {
      const code = /^[A-Z_0-9]+$/.test(error?.message || '') ? error.message : 'THREADS_SESSION_STORE_FAILED';
      throw new Error(code);
    }
  }
}

async function readQuery(session, contract, fetchImpl) {
  const { referer, lsd, site, cookie, csrf } = session;
  const operation = contract.name;
  const body = new URLSearchParams({ av: '0', __user: '0', __a: '1', dpr: '1', __ccg: 'EXCELLENT', __comet_req: '122',
    fb_api_caller_class: 'RelayModern', fb_api_req_friendly_name: operation, server_timestamps: 'true',
    variables: JSON.stringify(contract.variables), doc_id: contract.docId, lsd,
    __rev: String(site.server_revision), __hs: String(site.haste_session), __hsi: String(site.hsi),
    __spin_r: String(site.__spin_r), __spin_b: String(site.__spin_b), __spin_t: String(site.__spin_t) });
  const queryPath = operation === 'BarcelonaPostViewCountQuery' ? '/graphql/query' : '/api/graphql';
  const response = await fetchImpl(`${origin}${queryPath}`, { method: 'POST', redirect: 'error', body,
    signal: AbortSignal.timeout(15000), headers: { 'content-type': 'application/x-www-form-urlencoded',
      origin, referer, cookie, 'x-csrftoken': csrf, 'x-fb-lsd': lsd, 'x-fb-friendly-name': operation,
      'x-ig-app-id': '238260118697367', 'x-asbd-id': '359341',
      'x-bloks-version-id': '263bb7b084de88b94490949454ce63c4e3dd00f199215b85147f5da7c8ed1288',
      'x-logged-out-threads-migrated-request': 'true', 'x-root-field-name': 'fetch__XDTMediaDict' } });
  await persistThreadsRotation(session, response);
  const text = await bounded(response);
  const receipt = { operation, method: 'POST', path: queryPath, httpStatus: response.status,
    mime: response.headers.get('content-type'), bytes: Buffer.byteLength(text),
    sha256: createHash('sha256').update(text).digest('hex'), checkedAt: new Date().toISOString(),
    executionMode: 'pure_http', browserUsed: false, bootstrap: session.reusedSession ? 'protected_cached_anonymous_session' : 'fresh_http_anonymous_csrf',
    captured: true, client_exists: true, remnant_free: true,
    credential_propagated: session.reusedSession ? 'protected_cached_anonymous_csrf_sent_auth_unverified' : 'fresh_anonymous_csrf_sent_auth_unverified', live_replay: false };
  return { response, text, receipt };
}

export async function fetchThreadsXhr(handle, limit, { fetchImpl = globalThis.fetch } = {}) {
  if (!/^[A-Za-z0-9_.]{1,30}$/.test(handle) || !Number.isInteger(limit) || limit < 1 || limit > 30) throw new Error('THREADS_XHR_INPUT');
  let session = await bootstrapSession(handle, null, fetchImpl);
  if (!session.profileContract && session.reusedSession) session = await bootstrapSession(handle, null, fetchImpl, { force: true });
  if (!session.profileContract) throw new Error('THREADS_PROFILE_CONTRACT_MISSING');
  let query = await readQuery(session, session.profileContract, fetchImpl);
  if (session.reusedSession && [400, 401, 403, 419].includes(query.response.status)) {
    session = await bootstrapSession(handle, null, fetchImpl, { force: true });
    query = await readQuery(session, session.profileContract, fetchImpl);
  }
  const { response, text, receipt } = query;
  if (!response.ok) throw new Error(`THREADS_XHR_HTTP_${response.status}`);
  let payload;
  try { payload = JSON.parse(text.replace(/^for \(;;\);\s*/, '')); } catch { throw new Error('THREADS_XHR_NOT_JSON'); }
  if (payload.error || payload.errors?.length || !payload.data) throw new Error('THREADS_XHR_SERVICE_ERROR');
  const items = parseThreadsPayload([payload.data], handle).slice(0, limit);
  return { items, receipt: { ...receipt, live_replay: true, sourceUrl: `${origin}/@${handle}`, observedItems: items.length,
    bodyMethod: 'graphql_json', fullTimeline: false, bootstrapContentUsed: false, contractEvidence: 'server_relay_preloader_then_independent_replay',
    credential_propagated: session.reusedSession ? 'protected_cached_anonymous_csrf_verified' : 'fresh_anonymous_csrf_verified' } };
}

export async function probeThreadsViews({ handle, code, postId }, { fetchImpl = globalThis.fetch } = {}) {
  if (!/^[A-Za-z0-9_.]{1,30}$/.test(handle) || !/^[A-Za-z0-9_-]{5,30}$/.test(code) || !/^\d{10,25}$/.test(postId)) throw new Error('THREADS_XHR_INPUT');
  let session = await bootstrapSession(handle, code, fetchImpl);
  let query = await readQuery(session, { name: 'BarcelonaPostViewCountQuery', docId: '26985031937839290', variables: { postID: postId } }, fetchImpl);
  if (session.reusedSession && [400, 401, 403, 419].includes(query.response.status)) {
    session = await bootstrapSession(handle, code, fetchImpl, { force: true });
    query = await readQuery(session, { name: 'BarcelonaPostViewCountQuery', docId: '26985031937839290', variables: { postID: postId } }, fetchImpl);
  }
  const { response, text, receipt } = query;
  if (!response.ok) return { receipt, error: `THREADS_XHR_HTTP_${response.status}`, views: null };
  try {
    const result = decodeViews(text);
    receipt.live_replay = true;
    receipt.credential_propagated = session.reusedSession ? 'protected_cached_anonymous_csrf_verified' : 'fresh_anonymous_csrf_verified';
    return { receipt, ...result };
  }
  catch (e) {
    let responseShape = [];
    try {
      const visit = (v, p = '') => {
        if (p.split('.').length > 8) return;
        if (v && typeof v === 'object') for (const [k, child] of Object.entries(v)) visit(child, p ? `${p}.${k}` : k);
        else responseShape.push({ path: p, type: v === null ? 'null' : typeof v, ...(/view_count$/.test(p) && Number.isSafeInteger(v) ? { value: v } : {}) });
      };
      visit(JSON.parse(text));
    } catch {}
    return { receipt, error: e.message, views: null, responseShape };
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [handle, code, postId] = process.argv.slice(2);
  probeThreadsViews({ handle, code, postId }).then(result => console.log(JSON.stringify(result))).catch(() => { console.error('THREADS_XHR_PROBE_FAILED'); process.exitCode = 1; });
}
