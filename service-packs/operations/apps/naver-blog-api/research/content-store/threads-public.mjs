import { createHash } from 'node:crypto';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
export function parseThreadsPublic(html, handle) {
  if (!/^[A-Za-z0-9_.]{1,30}$/.test(handle)) throw new Error('THREADS_INPUT');
  const roots = [...html.matchAll(/<script\b[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)].flatMap(m => {
    try { return [JSON.parse(m[1])]; } catch { return []; }
  });
  return parseThreadsPayload(roots, handle);
}

// Post format as a writing reference (added 2026-09-27; the parser used to keep only text and counts): media, link card,
// own-thread continuation (a reply to the same author), mentions/links in text fragments, line rhythm.
const EMOJI = /[☀-➿\u{1F000}-\u{1FAFF}]/gu;
export function threadsFormat(v, info, handle) {
  const text = String(v.caption?.text ?? '');
  const lines = text.split('\n');
  const fragments = info.text_fragments?.fragments ?? [];
  const carousel = Array.isArray(v.carousel_media) ? v.carousel_media : [];
  return {
    photos: carousel.length ? carousel.filter(m => !m.video_versions?.length).length : (v.image_versions2?.candidates?.length && !v.video_versions?.length ? 1 : 0),
    videos: carousel.length ? carousel.filter(m => m.video_versions?.length).length : (v.video_versions?.length ? 1 : 0),
    linkCard: Boolean(info.link_preview_attachment), links: fragments.filter(f => f.fragment_type === 'link').length,
    mentions: fragments.filter(f => f.fragment_type === 'mention').length,
    ownThread: info.is_reply === true && info.reply_to_author?.username === handle,
    quote: Boolean(info.share_info?.quoted_post), topic: info.tag_header?.display_name ?? null,
    chars: text.length, lines: lines.length, blankLines: lines.filter(l => !l.trim()).length, emoji: (text.match(EMOJI) ?? []).length,
  };
}

export function parseThreadsPayload(roots, handle) {
  if (!/^[A-Za-z0-9_.]{1,30}$/.test(handle)) throw new Error('THREADS_INPUT');
  const posts = new Map();
  function walk(v, depth = 0) {
    if (!v || typeof v !== 'object' || depth > 60) return;
    if (v.caption?.text && v.user?.username === handle && /^[A-Za-z0-9_-]{5,30}$/.test(v.code || '') && Number.isFinite(v.taken_at)) {
      const info = v.text_post_app_info || {};
      posts.set(v.code, { title: String(v.caption.text).slice(0, 220), summary: String(v.caption.text).slice(0, 1500),
        bodySha256: createHash('sha256').update(String(v.caption.text)).digest('hex'),
        bodyLength: String(v.caption.text).length, bodyTruncated: String(v.caption.text).length > 1500,
        url: `https://www.threads.com/@${handle}/post/${v.code}`, publisher: handle,
        publishedAt: new Date(v.taken_at * 1000).toISOString(),
        engagement: { likes: count(v.like_count), replies: count(info.direct_reply_count), reposts: count(info.repost_count), quotes: count(info.quote_count), views: null },
        paidPartnership: v.is_paid_partnership === true, format: threadsFormat(v, info, handle) });
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
