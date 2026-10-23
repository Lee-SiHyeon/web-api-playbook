// Threads official Graph API writer (owner 2026-10-05: "자동갱신도 넣어 공식 api부터 쓰자").
// The token is the long-lived user token from the app's 사용자 토큰 생성기 (Threads tester lifehack__ailab), kept only in
// the DPAPI ProtectedStore record `threads-graph-api-token` and sent only to graph.threads.net as a Bearer header.
// Post = create a container (POST /me/threads; not public), wait until it is FINISHED, then publish it
// (POST /me/threads_publish; the public write, journaled once). Replies chain with reply_to_id; several images become a
// CAROUSEL. Images must be public HTTPS URLs that Meta fetches itself; this module never hosts files.
// Refresh: GET /refresh_access_token?grant_type=th_refresh_token (token at least 24 h old, extends to 60 days).
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { journaledRequest, defaultJournalDir, reconcileIntent, unresolvedJournalFiles,
  reserveThreadsChain, recordThreadsGraphRejection } from './journal.mjs';

export const GRAPH_ORIGIN = 'https://graph.threads.net';
const API = `${GRAPH_ORIGIN}/v1.0`;
export const TOKEN_RECORD = 'threads-graph-api-token';
export const OWNER = 'lifehack__ailab';
import { webApiPlaybookRoot } from '../../../adapters/web-auth-provider.mjs';
const PLAYBOOK = webApiPlaybookRoot();
const DAY = 86_400_000;
export const REFRESH_AFTER_DAYS = 7;
const MAX_TEXT = 500;
const fail = (code, extra = {}) => { throw Object.assign(new Error(code), { code, ...extra }); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = text => createHash('sha256').update(String(text)).digest('hex');

async function defaultStore() {
  const { ProtectedStore } = await import(pathToFileURL(path.join(PLAYBOOK, 'lib', 'protected-store.mjs')).href);
  return new ProtectedStore();
}

export async function loadThreadsGraphToken({ store } = {}) {
  let raw;
  try { raw = (store ?? await defaultStore()).read(TOKEN_RECORD); } catch { fail('THREADS_GRAPH_TOKEN_MISSING'); }
  let record; try { record = JSON.parse(String(raw ?? '')); } catch { fail('THREADS_GRAPH_TOKEN_MISSING'); }
  if (!/^TH[A-Za-z0-9_-]{40,400}$/.test(String(record?.accessToken ?? ''))) fail('THREADS_GRAPH_TOKEN_MISSING');
  return record;
}

// Metadata only: never the token.
export function tokenAge(record, now = Date.now()) {
  const obtained = Date.parse(record?.obtainedAt ?? '');
  const expires = Date.parse(record?.expiresAt ?? '') || (Number.isFinite(obtained) ? obtained + Number(record?.lifetimeDays ?? 60) * DAY : NaN);
  return { ageDays: Number.isFinite(obtained) ? (now - obtained) / DAY : null, daysLeft: Number.isFinite(expires) ? (expires - now) / DAY : null,
    expiresAt: Number.isFinite(expires) ? new Date(expires).toISOString() : null };
}

export function createThreadsGraphClient({ token, fetchImpl = globalThis.fetch, sleepImpl = sleep } = {}) {
  if (!token) fail('THREADS_GRAPH_TOKEN_MISSING');
  async function call(method, p, params = {}) {
    const url = new URL(API + p);
    if (url.origin !== GRAPH_ORIGIN) fail('THREADS_GRAPH_ORIGIN');
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') (method === 'GET' ? url.searchParams : form).set(k, String(v));
    const response = await fetchImpl(url, { method, headers: { authorization: `Bearer ${token}`, accept: 'application/json',
      ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      ...(method === 'POST' ? { body: form.toString() } : {}), signal: AbortSignal.timeout(30_000) });
    const json = await response.json().catch(() => null);
    const receipt = { method, path: url.pathname, status: response.status };
    if (response.status !== 200 || !json || json.error) {
      const e = json?.error ?? {};
      fail(response.status === 401 || e.code === 190 ? 'THREADS_GRAPH_UNAUTHORIZED' : response.status === 429 || [4, 17, 32, 613].includes(e.code)
        ? 'THREADS_GRAPH_RATE_LIMITED' : 'THREADS_GRAPH_REJECTED',
        { receipt, httpStatus: response.status, detail: { code: e.code ?? null, subcode: e.error_subcode ?? null, message: String(e.message ?? '').slice(0, 200) } });
    }
    return { json, receipt, status: response.status };
  }
  const get = (p, fields, extra = {}) => call('GET', p, { ...(fields ? { fields } : {}), ...extra }).then(r => r.json);
  return {
    call, get,
    me: () => get('/me', 'id,username'),
    publishingLimit: () => get('/me/threads_publishing_limit', 'quota_usage,config,reply_quota_usage,reply_config').then(j => j.data?.[0] ?? null),
    post: id => get(`/${id}`, 'id,permalink,username,text,timestamp,is_reply,media_type,shortcode'),
    recent: (limit = 25) => get('/me/threads', 'id,permalink,username,text,timestamp,is_reply,media_type', { limit }).then(j => j.data ?? []),
    // Containers take a moment to process (images longer); publishing an unfinished one fails.
    async waitFinished(containerId, { timeoutMs = 90_000, intervalMs = 2_000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (true) {
        const s = await get(`/${containerId}`, 'status,error_message');
        if (s.status === 'FINISHED') return s;
        if (['ERROR', 'EXPIRED'].includes(s.status)) fail('THREADS_GRAPH_CONTAINER_' + s.status, { detail: { message: String(s.error_message ?? '').slice(0, 200) } });
        if (Date.now() > deadline) fail('THREADS_GRAPH_CONTAINER_TIMEOUT');
        await sleepImpl(intervalMs);
      }
    },
  };
}

function checkImageUrls(urls) {
  if (!Array.isArray(urls) || urls.length > 20) fail('THREADS_GRAPH_IMAGES_INVALID');
  for (const u of urls) {
    let url; try { url = new URL(u); } catch { fail('THREADS_GRAPH_IMAGE_URL_INVALID'); }
    if (url.protocol !== 'https:' || url.username || url.password) fail('THREADS_GRAPH_IMAGE_URL_INVALID');
  }
  return urls;
}

// Builds the container for one post. topic goes to topic_tag; when Meta refuses that field the container is made again
// without it (a container is not public, so this retry sends nothing to anyone).
async function createContainer(client, { text, imageUrls = [], replyToId = null, topic = null }) {
  const base = { text, ...(replyToId ? { reply_to_id: replyToId } : {}) };
  const make = async params => {
    if (!imageUrls.length) return (await client.call('POST', '/me/threads', { ...params, media_type: 'TEXT' })).json.id;
    if (imageUrls.length === 1) return (await client.call('POST', '/me/threads', { ...params, media_type: 'IMAGE', image_url: imageUrls[0] })).json.id;
    const children = [];
    for (const imageUrl of imageUrls) {
      const child = (await client.call('POST', '/me/threads', { media_type: 'IMAGE', image_url: imageUrl, is_carousel_item: 'true' })).json.id;
      children.push(child);
    }
    for (const child of children) await client.waitFinished(child);
    return (await client.call('POST', '/me/threads', { ...params, media_type: 'CAROUSEL', children: children.join(',') })).json.id;
  };
  if (!topic) return { id: await make(base), topic: null };
  try { return { id: await make({ ...base, topic_tag: topic }), topic }; }
  catch (error) {
    if (error.code !== 'THREADS_GRAPH_REJECTED') throw error;
    return { id: await make(base), topic: null, topicDropped: error.detail?.message ?? true };
  }
}

const normalizePermalink = value => {
  try { const u = new URL(value); u.hostname = 'www.threads.com'; u.search = ''; u.hash = ''; return u.href.replace(/\/$/, ''); } catch { return null; }
};

// posts: texts in chain order; images: public URLs for the first post. Same journal channel ('threads') and run key
// scheme as the web writer, so ledger/status/reconcile flows keep working.
// A failure before the first publish request carries notSent: true (nothing public happened; callers may use another
// writer). After that, errors propagate as they are.
export async function publishChainGraph(posts, options = {}) {
  const state = { sent: false };
  try { return await publishChainGraphInner(posts, options, state); }
  catch (error) { if (!state.sent) error.notSent = true; throw error; }
}

async function publishChainGraphInner(posts, { imageUrls = [], topic = null, replyToId = null, runKey, journalDir = defaultJournalDir(),
  client = null, store = null, readbackDelayMs = 2_000, sleepImpl = sleep } = {}, state) {
  if (!Array.isArray(posts) || !posts.length || posts.some(p => typeof p !== 'string' || !p.trim())) fail('THREADS_POSTS_INVALID');
  if (posts.some(p => [...p].length > MAX_TEXT)) fail('THREADS_GRAPH_TEXT_TOO_LONG');
  if (!runKey) fail('SNS_RUN_KEY_REQUIRED');
  checkImageUrls(imageUrls);
  if ((await unresolvedJournalFiles({ channel: 'threads', runKey, journalDir })).length) fail('SNS_JOURNAL_RECONCILIATION_REQUIRED');
  const reservation = await reserveThreadsChain({ runKey, journalDir });
  const api = client ?? createThreadsGraphClient({ token: (await loadThreadsGraphToken({ store })).accessToken });
  const ids = [], permalinks = [], notes = [];
  for (const [index, text] of posts.entries()) {
    const parent = index ? ids[index - 1] : replyToId;
    const container = await createContainer(api, { text, imageUrls: index === 0 ? imageUrls : [], replyToId: parent, topic: index === 0 ? topic : null });
    if (container.topicDropped) notes.push({ index, topicDropped: container.topicDropped });
    await api.waitFinished(container.id);
    const request = { method: 'POST', url: `${API}/me/threads_publish`, body: JSON.stringify({ creation_id: container.id, textSha256: sha(text) }) };
    const startedAt = Date.now();
    state.sent = true;
    let published;
    try {
      const { response, checkpoint } = await journaledRequest({ channel: 'threads', runKey, journalDir, request, returnJournal: true,
        send: async () => { const r = await api.call('POST', '/me/threads_publish', { creation_id: container.id }); return { status: r.status, json: r.json }; } });
      const id = String(response.json?.id ?? '');
      if (!/^\d{10,25}$/.test(id)) fail('THREADS_GRAPH_PUBLISH_SCHEMA');
      published = { id, checkpoint };
    } catch (error) {
      const [file] = await unresolvedJournalFiles({ channel: 'threads', runKey, journalDir });
      // Meta answered with an error object: the container was not published. Record that so the run key is free again.
      if (error.httpStatus >= 400 && error.httpStatus < 500 && Number.isSafeInteger(error.detail?.code) && file) {
        await recordThreadsGraphRejection({ file, httpStatus: error.httpStatus, providerCode: error.detail.code });
        await reconcileIntent({ file, result: { outcome: 'not_created_provider_rejected', httpStatus: error.httpStatus, providerCode: error.detail?.code ?? null } });
        if (index === 0) {
          await reservation.releaseAfterProviderRejection();
          state.sent = false;
        }
        throw error;
      }
      if (error.httpStatus) throw error;
      // Lost response: look for the post on the owner's own list before anyone retries.
      const found = (await api.recent(10).catch(() => [])).find(p => p.text === text && Date.parse(p.timestamp) >= startedAt - 120_000);
      if (found && file) {
        await reconcileIntent({ file, result: { outcome: 'created_found_by_owner_readback', postId: found.id, readbackVerified: true } });
        published = { id: found.id, checkpoint: null };
      } else throw error;
    }
    const detail = await api.post(published.id).catch(() => null);
    const permalink = normalizePermalink(detail?.permalink);
    if (published.checkpoint) await published.checkpoint({ kind: 'threads_post_created', postId: published.id, ...(permalink ? { permalink } : {}) });
    ids.push(published.id); permalinks.push(permalink);
  }
  // Readback: each post is the owner's, carries the text sent, and later posts are replies.
  await sleepImpl(readbackDelayMs);
  const readback = [];
  for (const [index, id] of ids.entries()) {
    const p = await api.post(id).catch(error => ({ error: error.code }));
    readback.push({ id, ownerVerified: p.username === OWNER, textVerified: p.text === posts[index],
      replyVerified: index === 0 ? (replyToId ? p.is_reply === true : p.is_reply === false) : p.is_reply === true,
      mediaType: p.media_type ?? null, permalink: normalizePermalink(p.permalink), ...(p.error ? { error: p.error } : {}) });
  }
  const readbackVerified = readback.every(r => r.ownerVerified && r.textVerified && r.replyVerified);
  return { ids, permalinks, readbackVerified, readback, writer: 'graph', ...(notes.length ? { notes } : {}) };
}

// Keeper step: health, then refresh once the token is a week old (Meta needs ≥24 h; a refresh restarts the 60 days).
export async function ensureThreadsGraphToken({ store = null, fetchImpl = globalThis.fetch, now = () => Date.now(), allowRefresh = true } = {}) {
  const s = store ?? await defaultStore();
  const record = await loadThreadsGraphToken({ store: s });
  const client = createThreadsGraphClient({ token: record.accessToken, fetchImpl });
  let me;
  try { me = await client.me(); } catch (error) {
    return { ok: false, code: error.code === 'THREADS_GRAPH_UNAUTHORIZED' ? 'THREADS_GRAPH_REAUTH_REQUIRED' : error.code, ...tokenAge(record, now()) };
  }
  if (me.username !== OWNER) return { ok: false, code: 'THREADS_GRAPH_ACCOUNT_MISMATCH' };
  const age = tokenAge(record, now());
  if (!allowRefresh || !(age.ageDays >= REFRESH_AFTER_DAYS)) return { ok: true, action: 'reused', username: me.username, ...age };
  const url = new URL(`${GRAPH_ORIGIN}/refresh_access_token`);
  url.searchParams.set('grant_type', 'th_refresh_token');
  const r = await fetchImpl(url, { headers: { authorization: `Bearer ${record.accessToken}`, accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  const j = await r.json().catch(() => null);
  if (r.status !== 200 || !/^TH[A-Za-z0-9_-]{40,400}$/.test(String(j?.access_token ?? '')) || !Number.isFinite(Number(j?.expires_in))) {
    return { ok: true, action: 'refresh_failed', refreshStatus: r.status, refreshError: j?.error?.code ?? null, username: me.username, ...age };
  }
  const obtainedAt = new Date(now()).toISOString();
  const next = { ...record, accessToken: j.access_token, obtainedAt, expiresAt: new Date(now() + Number(j.expires_in) * 1000).toISOString(), source: 'th_refresh_token' };
  const check = await createThreadsGraphClient({ token: next.accessToken, fetchImpl }).me().catch(() => null);
  if (check?.username !== OWNER) return { ok: true, action: 'refresh_unverified_kept_old', username: me.username, ...age };
  s.write(TOKEN_RECORD, JSON.stringify(next));
  j.access_token = ''; record.accessToken = '';
  return { ok: true, action: 'refreshed', username: me.username, ...tokenAge(next, now()) };
}

async function main() {
  const [command = 'health'] = process.argv.slice(2);
  if (!['health', 'ensure'].includes(command)) fail('THREADS_GRAPH_COMMAND');
  console.log(JSON.stringify(await ensureThreadsGraphToken({ allowRefresh: command === 'ensure' })));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.log(JSON.stringify({ ok: false, code: e.code ?? 'THREADS_GRAPH_FAILED' })); process.exitCode = 1; });
