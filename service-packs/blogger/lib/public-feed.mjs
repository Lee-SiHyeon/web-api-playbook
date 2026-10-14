// Unauthenticated public Atom/JSON feed of a blogspot blog (published posts only). No credentials sent.
import { request, publicBlogOrigin, BloggerError } from './transport.mjs';

function mapEntry(e) {
  const id = (e.id?.$t || '').match(/post-(\d+)$/)?.[1];
  if (!id) throw new BloggerError('BLOGGER_SCHEMA_CHANGED');
  return {
    id, title: e.title?.$t ?? '', published: e.published?.$t, updated: e.updated?.$t,
    url: (e.link || []).find(l => l.rel === 'alternate')?.href || null,
    labels: (e.category || []).map(c => c.term),
    content: e.content?.$t ?? e.summary?.$t ?? '',
  };
}

export async function feedGetPost(blogUrl, postId, { fetchImpl = fetch } = {}) {
  if (!/^\d{5,25}$/.test(postId)) throw new BloggerError('BLOGGER_INPUT_INVALID');
  const origin = publicBlogOrigin(blogUrl);
  const r = await request(`${origin}/feeds/posts/default/${postId}?alt=json`, { allowedOrigins: [origin], fetchImpl });
  let j; try { j = JSON.parse(r.text); } catch { throw new BloggerError('BLOGGER_SCHEMA_CHANGED'); }
  return mapEntry(j.entry);
}

export async function feedListPosts(blogUrl, { max = 25, start = 1, fetchImpl = fetch } = {}) {
  const origin = publicBlogOrigin(blogUrl);
  const r = await request(`${origin}/feeds/posts/default?alt=json&max-results=${Math.min(max, 150)}&start-index=${start}`, { allowedOrigins: [origin], fetchImpl });
  let j; try { j = JSON.parse(r.text); } catch { throw new BloggerError('BLOGGER_SCHEMA_CHANGED'); }
  return { total: Number(j.feed?.openSearch$totalResults?.$t ?? NaN), posts: (j.feed?.entry || []).map(mapEntry) };
}
