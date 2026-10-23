import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parsePostsPage, BloggerWebClient } from '../lib/web.mjs';
import { cookieHeaderFor, request } from '../lib/transport.mjs';
import { saveSession, loadSession } from '../lib/session-store.mjs';
import { feedGetPost } from '../lib/public-feed.mjs';
import { BloggerApiClient } from '../lib/oauth.mjs';
import { executeWrite } from '../lib/writes.mjs';

const BLOG = '1000000000000000001';
const post = (id, st, views) => [id, `T${id}`, null, [null, null, 'x'], [views, 0], ['A', null, null, null, [null, null, '/profile/1']], 'snip', 1771845024084, BLOG, st, null, 1, ['l1'], [null, null, `https://demo.blogspot.com/p/${id}.html`], null, `T${id}`, 1, null, null, 1771845024084, null, 2];
const blog = [BLOG, 'Demo', 'https://demo.blogspot.com', 4, null, 1, null, null, null, null, [[1, 2]]];
const cb = (k, d) => `AF_initDataCallback({key: '${k}', hash: '1', data:${JSON.stringify(d)}, sideChannel: {}});`;
const html = `<html><script>${cb('ds:1', [[blog]])}${cb('ds:0', [blog])}${cb('ds:2', [BLOG, [post('2000001', 1, 5), post('2000002', 2, 0)], null, null, null, '', 1, 2])}</script></html>`;
const res = (status, text, headers = {}) => new Response(text, { status, headers: { 'content-type': 'text/html', ...headers } });
const session = { cookies: [{ name: 'SID', value: 'v', domain: '.google.com', path: '/', expires: -1 }, { name: 'B', value: 'w', domain: '.blogger.com', path: '/', expires: -1 }] };

test('parses posts dashboard init data', () => {
  const p = parsePostsPage(html);
  assert.equal(p.blogs.length, 1); assert.equal(p.current.postCount, 2);
  assert.equal(p.total, 2); assert.deepEqual(p.posts.map(x => x.status), ['live', 'draft']);
  assert.equal(p.posts[0].views, 5);
});

test('200 login page is an auth failure, missing data is schema change', () => {
  assert.throws(() => parsePostsPage('<a href="https://accounts.google.com/ServiceLogin">'), { code: 'BLOGGER_AUTH_EXPIRED' });
  assert.throws(() => parsePostsPage('<html></html>'), { code: 'BLOGGER_SCHEMA_CHANGED' });
});

test('cookies only go to www.blogger.com', () => {
  assert.ok(cookieHeaderFor('https://www.blogger.com/blog/posts/1', session.cookies).includes('B=w'));
  assert.equal(cookieHeaderFor('https://demo.blogspot.com/', session.cookies), null);
  assert.equal(cookieHeaderFor('https://www.googleapis.com/x', session.cookies), null);
});

test('web client sends cookie, no redirect follow, maps redirect to login as expired', async () => {
  let seen;
  const c = new BloggerWebClient({ session, fetchImpl: async (u, o) => { seen = o; return res(200, html); } });
  const l = await c.listPosts(BLOG);
  assert.equal(seen.redirect, 'manual'); assert.ok(seen.headers.cookie);
  assert.equal(l.complete, true);
  const c2 = new BloggerWebClient({ session, fetchImpl: async () => res(302, '', { location: 'https://accounts.google.com/ServiceLogin' }) });
  await assert.rejects(c2.listPosts(BLOG), { code: 'BLOGGER_AUTH_EXPIRED' });
});

test('bearer refused off googleapis origin; foreign origin refused', async () => {
  await assert.rejects(request('https://evil.example/', { bearer: 't', allowedOrigins: ['https://evil.example'], fetchImpl: async () => res(200, '') }), { code: 'BLOGGER_ORIGIN_NOT_ALLOWED' });
  await assert.rejects(request('https://www.blogger.com/', { allowedOrigins: ['https://www.googleapis.com'] }), { code: 'BLOGGER_ORIGIN_NOT_ALLOWED' });
});

test('feed get-post sends no credentials and rejects non-blogspot', async () => {
  let h;
  const p = await feedGetPost('https://demo.blogspot.com', '2000001', { fetchImpl: async (u, o) => { h = o.headers; return res(200, JSON.stringify({ entry: { id: { $t: 'tag:blogger.com,1999:blog-1.post-2000001' }, title: { $t: 'T' }, content: { $t: 'c' }, link: [] } })); } });
  assert.equal(p.id, '2000001'); assert.equal(h.cookie, undefined); assert.equal(h.authorization, undefined);
  await assert.rejects(feedGetPost('https://evil.example', '2000001'), { code: 'BLOGGER_PUBLIC_ORIGIN_NOT_ALLOWED' });
});

test('session store is 0600 outside git and refuses open permissions', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'blg-'));
  const env = { BLOGGER_STATE_DIR: dir };
  const r = saveSession([...session.cookies, { name: 'X', value: 'y', domain: '.youtube.com' }], { env });
  assert.equal(r.cookieCount, 2); assert.equal(statSync(r.file).mode & 0o777, 0o600);
  assert.equal(loadSession({ env }).cookies.length, 2);
  chmodSync(r.file, 0o644);
  assert.throws(() => loadSession({ env }), { code: 'BLOGGER_SESSION_PERMISSIONS_TOO_OPEN' });
});

const apiWith = handler => new BloggerApiClient({ accessToken: 'tok', fetchImpl: handler });

test('write: journal reserved first, ack requires readback, duplicate intent blocked', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'blgj-'));
  let calls = 0;
  const api = apiWith(async (u, o) => { calls++; assert.equal(o.method, 'POST'); assert.match(String(u), /isDraft=true/); return res(200, JSON.stringify({ id: '3000001', status: 'DRAFT' }), { 'content-type': 'application/json' }); });
  const r = await executeWrite({ api, journalRoot: root, operation: 'create-draft', blogId: BLOG, content: { title: 't', content: '<p>x</p>' } });
  assert.equal(r.status, 'finished'); assert.equal(r.state, 'acknowledged_requires_readback'); assert.equal(r.postId, '3000001');
  await assert.rejects(executeWrite({ api, journalRoot: root, operation: 'create-draft', blogId: BLOG, content: { title: 't', content: '<p>x</p>' } }), { code: 'WRITE_JOURNAL_EXISTS' });
  assert.equal(calls, 1);
  const raw = readFileSync(path.join(root, 'blogger', `${r.key}.json`), 'utf8');
  assert.ok(!raw.includes('<p>x</p>') && !raw.includes('tok'));
});

test('write: timeout => needs-reconciliation, not retried', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'blgj-'));
  let calls = 0;
  const api = apiWith(async () => { calls++; throw new TypeError('network'); });
  const r = await executeWrite({ api, journalRoot: root, operation: 'publish', blogId: BLOG, postId: '3000001' });
  assert.equal(r.status, 'needs-reconciliation'); assert.equal(calls, 1);
});

test('write: definite 4xx recorded as rejected', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'blgj-'));
  const r = await executeWrite({ api: apiWith(async () => res(401, '{}')), journalRoot: root, operation: 'update', blogId: BLOG, postId: '3000001', content: { title: 'n' } });
  assert.equal(r.state, 'rejected');
});
