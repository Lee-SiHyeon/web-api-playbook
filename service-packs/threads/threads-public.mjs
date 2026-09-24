import { createHash } from 'node:crypto';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
export function parseThreadsPublic(html, handle) {
  if (!/^[A-Za-z0-9_.]{1,30}$/.test(handle)) throw new Error('THREADS_INPUT');
  const roots = [...html.matchAll(/<script\b[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)].flatMap(m => {
    try { return [JSON.parse(m[1])]; } catch { return []; }
  });
  return parseThreadsPayload(roots, handle);
}

export function parseThreadsPayload(roots, handle) {
  if (!/^[A-Za-z0-9_.]{1,30}$/.test(handle)) throw new Error('THREADS_INPUT');
  const posts = new Map();
  function walk(v, depth = 0) {
    if (!v || typeof v !== 'object' || depth > 60) return;
    if (v.caption?.text && v.user?.username === handle && /^[A-Za-z0-9_-]{5,30}$/.test(v.code || '') && Number.isFinite(v.taken_at)) {
      const info = v.text_post_app_info || {};
      posts.set(v.code, { title: String(v.caption.text).slice(0, 220), summary: String(v.caption.text).slice(0, 1500),
        url: `https://www.threads.com/@${handle}/post/${v.code}`, publisher: handle,
        publishedAt: new Date(v.taken_at * 1000).toISOString(),
        engagement: { likes: count(v.like_count), replies: count(info.direct_reply_count), reposts: count(info.repost_count), views: null },
        paidPartnership: v.is_paid_partnership === true });
      return; // Do not promote a quoted older post into the current profile feed.
    }
    for (const child of Object.values(v)) walk(child, depth + 1);
  }
  roots.forEach(v => walk(v));
  if (!posts.size) throw new Error('THREADS_PUBLIC_POSTS_UNAVAILABLE');
  return [...posts.values()];
}

export async function fetchThreadsPublic(handle, limit, { fetchImpl = globalThis.fetch } = {}) {
  if (!/^[A-Za-z0-9_.]{1,30}$/.test(handle) || !Number.isInteger(limit) || limit < 1 || limit > 30) throw new Error('THREADS_INPUT');
  const url = `https://www.threads.com/@${handle}`;
  const response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { accept: 'text/html' } });
  if (response.status !== 200 || !(response.headers.get('content-type') || '').includes('text/html')) { await response.body?.cancel(); throw new Error('THREADS_HTTP_UNAVAILABLE'); }
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > 3000000) throw new Error('THREADS_SIZE'); chunks.push(chunk); }
  const html = Buffer.concat(chunks).toString('utf8');
  const items = parseThreadsPublic(html, handle).slice(0, limit);
  return { items, receipt: { sourceUrl: url, httpStatus: response.status, observedItems: items.length,
    responseSha256: createHash('sha256').update(html).digest('hex'), executionMode: 'pure_http', browserUsed: false,
    bodyMethod: 'public_html_embedded_json', fullTimeline: false } };
}
