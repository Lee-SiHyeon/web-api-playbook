// Session-cookie reads of the Blogger dashboard (www.blogger.com, boq BloggerUi).
// The dashboard server-renders its data as AF_initDataCallback blocks; observed 2026-10-14.
import { request, BloggerError, BLOGGER_WEB_ORIGIN } from './transport.mjs';

const ID = /^\d{5,25}$/;

export function parseInitData(html) {
  if (/accounts\.google\.com\/(?:v3\/signin|ServiceLogin)/.test(html) && !html.includes('AF_initDataCallback')) {
    throw new BloggerError('BLOGGER_AUTH_EXPIRED', { phase: 'readback' }); // 200 login page is a failure
  }
  const out = {};
  for (const m of html.matchAll(/AF_initDataCallback\(\{key: '(ds:\d+)', hash: '\d+', data:([\s\S]*?), sideChannel: \{\}\}\);/g)) {
    try { out[m[1]] = JSON.parse(m[2]); } catch { throw new BloggerError('BLOGGER_SCHEMA_CHANGED', { block: m[1] }); }
  }
  if (!Object.keys(out).length) throw new BloggerError('BLOGGER_SCHEMA_CHANGED');
  return out;
}

const STATUS = { 1: 'live', 2: 'draft', 3: 'scheduled' };

function mapBlog(b) {
  if (!Array.isArray(b) || !ID.test(b[0])) throw new BloggerError('BLOGGER_SCHEMA_CHANGED');
  return { id: b[0], name: b[1], url: b[2], postCount: Array.isArray(b[10]?.[0]) ? b[10][0][1] : undefined };
}

function mapPost(p) {
  if (!Array.isArray(p) || !ID.test(p[0])) throw new BloggerError('BLOGGER_SCHEMA_CHANGED');
  return {
    id: p[0], title: p[1], blogId: p[8],
    status: STATUS[p[9]] || `unknown:${p[9]}`,
    updated: typeof p[7] === 'number' ? new Date(p[7]).toISOString() : null,
    published: typeof p[19] === 'number' ? new Date(p[19]).toISOString() : null,
    url: p[13]?.[2] || null,
    labels: Array.isArray(p[12]) ? p[12] : [],
    views: Array.isArray(p[4]) ? p[4][0] : null,
    comments: Array.isArray(p[4]) ? p[4][1] : null,
    author: p[5]?.[0] || null,
  };
}

export function parsePostsPage(html) {
  const ds = parseInitData(html);
  const blogs = (ds['ds:1']?.[0] || []).map(mapBlog);
  const current = ds['ds:0']?.[0] ? mapBlog(ds['ds:0'][0]) : null;
  const list = ds['ds:2'];
  if (!Array.isArray(list) || !Array.isArray(list[1])) throw new BloggerError('BLOGGER_SCHEMA_CHANGED');
  const posts = list[1].map(mapPost);
  const total = typeof list[7] === 'number' ? list[7] : null;
  const nextPageToken = typeof list[5] === 'string' && list[5] ? list[5] : null;
  return { blogs, current, posts, total, nextPageToken };
}

export class BloggerWebClient {
  constructor({ session, fetchImpl = fetch, timeoutMs } = {}) {
    if (!session?.cookies?.length) throw new BloggerError('BLOGGER_AUTH_MISSING', { phase: 'login acquisition' });
    this.cookies = session.cookies; this.fetchImpl = fetchImpl; this.timeoutMs = timeoutMs;
  }
  async #get(path) {
    const r = await request(`${BLOGGER_WEB_ORIGIN}${path}`, { cookies: this.cookies, allowedOrigins: [BLOGGER_WEB_ORIGIN], fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs, headers: { accept: 'text/html' } });
    if (!/text\/html/.test(r.contentType)) throw new BloggerError('BLOGGER_SCHEMA_CHANGED');
    return r.text;
  }
  // GET /blog/posts/{blogId}: blog switcher (ds:1), current blog (ds:0), first post page (ds:2).
  async postsPage(blogId) {
    if (!ID.test(blogId)) throw new BloggerError('BLOGGER_INPUT_INVALID');
    return parsePostsPage(await this.#get(`/blog/posts/${blogId}`));
  }
  // GET /  -> redirects to the last blog; we need any blog id, so callers pass one or use listBlogs(seed).
  async listBlogs(seedBlogId) {
    const page = await this.postsPage(seedBlogId);
    const blogs = page.blogs.length ? page.blogs : (page.current ? [page.current] : []);
    return blogs.map(b => (page.current && b.id === page.current.id ? { ...b, postCount: page.current.postCount } : b));
  }
  async listPosts(blogId) {
    const page = await this.postsPage(blogId);
    return { posts: page.posts, total: page.total, complete: page.total == null ? 'unknown' : page.posts.length >= page.total, nextPageToken: page.nextPageToken };
  }
  async getPost(blogId, postId) {
    const { posts } = await this.listPosts(blogId);
    const p = posts.find(x => x.id === postId);
    if (!p) throw new BloggerError('BLOGGER_NOT_FOUND');
    return p;
  }
  // Per-post views/comments from the posts dashboard (the only stats observed via session-cookie path).
  async stats(blogId) {
    const { posts, total } = await this.listPosts(blogId);
    return { scope: 'posts_dashboard_first_page', totalPosts: total, totalViews: posts.reduce((a, p) => a + (p.views || 0), 0), totalComments: posts.reduce((a, p) => a + (p.comments || 0), 0), perPost: posts.map(p => ({ id: p.id, views: p.views, comments: p.comments })) };
  }
}
