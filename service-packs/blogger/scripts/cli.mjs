#!/usr/bin/env node
// Blogger pack CLI. Reads are default. Writes require --execute and the official OAuth transport.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { importFromCdp, loadSession, stateDir } from '../lib/session-store.mjs';
import { BloggerWebClient } from '../lib/web.mjs';
import { feedGetPost } from '../lib/public-feed.mjs';
import { BloggerApiClient, loadOAuth, refreshAccessToken } from '../lib/oauth.mjs';
import { executeWrite } from '../lib/writes.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const a = Object.fromEntries(rest.filter(x => x.startsWith('--')).map(x => { const [k, ...v] = x.slice(2).split('='); return [k, v.length ? v.join('=') : true]; }));
const out = o => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);
const transport = a.transport || 'web';

async function api() {
  const o = loadOAuth();
  if (!o) throw Object.assign(new Error('BLOGGER_OAUTH_MISSING'), { code: 'BLOGGER_OAUTH_MISSING' });
  const token = o.access_token || await refreshAccessToken(o);
  return new BloggerApiClient({ accessToken: token });
}
const web = () => new BloggerWebClient({ session: loadSession() });
const need = k => { if (!a[k]) throw Object.assign(new Error(`missing --${k}`), { code: 'BLOGGER_INPUT_MISSING' }); return String(a[k]); };

const cmds = {
  async 'session:import'() { const r = await importFromCdp({ cdp: a.cdp }); out({ ok: true, cookieCount: r.cookieCount, cookieNames: r.cookieNames }); },
  async 'list-blogs'() { out(transport === 'api' ? await (await api()).listBlogs() : { blogs: await web().listBlogs(need('blog')) }); },
  async 'list-posts'() { out(transport === 'api' ? await (await api()).listPosts(need('blog'), { status: a.status }) : await web().listPosts(need('blog'))); },
  async 'get-post'() {
    if (transport === 'api') return out(await (await api()).getPost(need('blog'), need('post')));
    if (transport === 'feed') return out(await feedGetPost(need('blog-url'), need('post')));
    out(await web().getPost(need('blog'), need('post')));
  },
  async stats() { out(transport === 'api' ? await (await api()).pageViews(need('blog'), a.range || 'all') : await web().stats(need('blog'))); },
  async write(op) {
    const content = a.file ? JSON.parse(readFileSync(String(a.file), 'utf8')) : {};
    const plan = { operation: op, blogId: need('blog'), postId: a.post ? String(a.post) : undefined, transport: 'api', title: content.title, contentBytes: content.content ? Buffer.byteLength(content.content) : 0 };
    if (!a.execute) return out({ dryRun: true, plan, note: 'add --execute to send; journal is reserved before sending; no retry' });
    const res = await executeWrite({ api: await api(), journalRoot: a.journal || path.join(stateDir(), 'journal'), operation: op, blogId: plan.blogId, postId: plan.postId, content });
    out(res);
  },
  async 'create-draft'() { return cmds.write('create-draft'); },
  async publish() { need('post'); return cmds.write('publish'); },
  async update() { need('post'); return cmds.write('update'); },
};

if (!cmds[cmd] || cmd === 'write') {
  out({ usage: 'cli.mjs <session:import|list-blogs|list-posts|get-post|stats|create-draft|publish|update> --blog=ID [--post=ID] [--transport=web|api|feed] [--blog-url=https://x.blogspot.com] [--file=post.json] [--execute]' });
  process.exit(2);
}
cmds[cmd]().catch(e => { out({ ok: false, error: e.code || 'BLOGGER_ERROR', status: e.status, outcome: e.outcome, phase: e.phase }); process.exit(1); });
