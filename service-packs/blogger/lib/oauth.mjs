// Official Blogger API v3 (https://developers.google.com/blogger/docs/3.0/reference). OAuth scope:
// https://www.googleapis.com/auth/blogger . Token material comes from env or a 0600 file outside git.
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { request, BloggerError, GOOGLE_API_ORIGIN } from './transport.mjs';
import { stateDir } from './session-store.mjs';

const BASE = `${GOOGLE_API_ORIGIN}/blogger/v3`;
const TOKEN_ORIGIN = 'https://oauth2.googleapis.com';
const ID = /^\d{5,25}$/;
const id = v => { if (!ID.test(String(v))) throw new BloggerError('BLOGGER_INPUT_INVALID'); return String(v); };

export function loadOAuth({ env = process.env } = {}) {
  if (env.BLOGGER_OAUTH_ACCESS_TOKEN) return { access_token: env.BLOGGER_OAUTH_ACCESS_TOKEN };
  const file = path.join(stateDir(env), 'oauth.json');
  let st; try { st = statSync(file); } catch { return null; }
  if ((st.mode & 0o077) !== 0) throw new BloggerError('BLOGGER_OAUTH_PERMISSIONS_TOO_OPEN');
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { throw new BloggerError('BLOGGER_OAUTH_INVALID'); }
}

export async function refreshAccessToken(o, { fetchImpl = fetch } = {}) {
  if (!o?.refresh_token || !o.client_id || !o.client_secret) throw new BloggerError('BLOGGER_OAUTH_REFRESH_UNAVAILABLE');
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: o.refresh_token, client_id: o.client_id, client_secret: o.client_secret });
  const r = await request(`${TOKEN_ORIGIN}/token`, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' }, allowedOrigins: [TOKEN_ORIGIN], fetchImpl });
  const j = JSON.parse(r.text);
  if (!j.access_token) throw new BloggerError('BLOGGER_OAUTH_INVALID');
  return j.access_token; // kept in memory only
}

export class BloggerApiClient {
  constructor({ accessToken, fetchImpl = fetch, timeoutMs } = {}) {
    if (!accessToken) throw new BloggerError('BLOGGER_AUTH_MISSING', { phase: 'login acquisition' });
    this.token = accessToken; this.fetchImpl = fetchImpl; this.timeoutMs = timeoutMs;
  }
  async #call(method, p, { query, json } = {}) {
    const u = new URL(`${BASE}${p}`);
    for (const [k, v] of Object.entries(query || {})) if (v != null) u.searchParams.set(k, String(v));
    const r = await request(u, { method, bearer: this.token, allowedOrigins: [GOOGLE_API_ORIGIN], fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs,
      headers: json ? { 'content-type': 'application/json' } : {}, body: json ? JSON.stringify(json) : undefined });
    try { return JSON.parse(r.text); } catch { throw new BloggerError('BLOGGER_SCHEMA_CHANGED'); }
  }
  listBlogs() { return this.#call('GET', '/users/self/blogs'); }
  listPosts(blogId, { status, pageToken, maxResults = 50, view = 'ADMIN' } = {}) {
    return this.#call('GET', `/blogs/${id(blogId)}/posts`, { query: { status, pageToken, maxResults, view, fetchBodies: false } });
  }
  getPost(blogId, postId) { return this.#call('GET', `/blogs/${id(blogId)}/posts/${id(postId)}`, { query: { view: 'ADMIN' } }); }
  pageViews(blogId, range = 'all') { return this.#call('GET', `/blogs/${id(blogId)}/pageviews`, { query: { range } }); }
  // Writes: callers MUST go through lib/writes.mjs (journal-first). Not exported as a CLI path otherwise.
  insertDraft(blogId, post) { return this.#call('POST', `/blogs/${id(blogId)}/posts`, { query: { isDraft: true }, json: post }); }
  publish(blogId, postId) { return this.#call('POST', `/blogs/${id(blogId)}/posts/${id(postId)}/publish`); }
  patch(blogId, postId, fields) { return this.#call('PATCH', `/blogs/${id(blogId)}/posts/${id(postId)}`, { json: fields }); }
}
