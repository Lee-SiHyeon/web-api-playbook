import { lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchText, assertStatus } from '../trend-radar/lib/http.mjs';
import { parseNews, hash } from './collect.mjs';

export const normalizeTitle = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

// Public RSS only exposes the newest posts, so a miss here never proves that no earlier post exists.
export function logNoFrom(url, blogId) {
  try {
    const u = new URL(url);
    if (u.origin !== 'https://blog.naver.com') return null;
    const fromQuery = u.searchParams.get('logNo');
    const fromPath = u.pathname.match(/^\/([A-Za-z0-9_-]+)\/(\d{6,})\/?$/);
    const owner = fromQuery ? u.searchParams.get('blogId') : fromPath?.[1];
    const logNo = fromQuery || fromPath?.[2];
    return owner === blogId && /^\d{6,}$/.test(logNo || '') ? logNo : null;
  } catch { return null; }
}

export function parseBlogRss(xml, blogId) {
  const posts = [];
  const seen = new Set();
  for (const item of parseNews(xml)) {
    const logNo = logNoFrom(item.url, blogId);
    if (!logNo || seen.has(logNo)) continue;
    seen.add(logNo);
    posts.push({ logNo, title: item.title, url: `https://blog.naver.com/${blogId}/${logNo}`,
      publishedAt: item.publishedAt && Number.isFinite(Date.parse(item.publishedAt)) ? new Date(item.publishedAt).toISOString() : null });
  }
  return posts;
}

export async function fetchExistingPosts(blogId, { fetchImpl = globalThis.fetch, now = new Date() } = {}) {
  if (!/^[a-zA-Z0-9_-]{2,40}$/.test(blogId)) throw new Error('BLOG_ID');
  const url = `https://rss.blog.naver.com/${blogId}.xml`;
  const result = await fetchText(url, { fetchImpl, attempts: 1, timeoutMs: 12000, headers: { accept: 'application/rss+xml' } });
  assertStatus(result.response);
  if (Buffer.byteLength(result.text) > 2000000) throw new Error('SOURCE_TOO_LARGE');
  const posts = parseBlogRss(result.text, blogId);
  return { schemaVersion: 1, kind: 'existing_posts', blogId, checkedAt: now.toISOString(), coverage: 'rss_recent_only',
    receipt: { httpStatus: result.response.status, sourceUrl: url, responseSha256: hash(result.text), observedItems: posts.length, browserUsed: false, credentialsUsed: false },
    posts, titles: posts.map(post => post.title) };
}

export async function main(args) {
  const [blogId, output, titlesOutput] = args;
  if (!blogId || !output) throw new Error('Use existing-posts.mjs BLOG_ID NEW_OUTPUT_JSON [NEW_TITLES_JSON]');
  for (const target of [output, titlesOutput].filter(Boolean).map(file => path.resolve(file))) {
    try { await lstat(target); throw new Error('OUTPUT_EXISTS'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const record = await fetchExistingPosts(blogId);
  await writeFile(path.resolve(output), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  if (titlesOutput) await writeFile(path.resolve(titlesOutput), JSON.stringify(record.titles, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ blogId, posts: record.posts.length, coverage: record.coverage, output: path.resolve(output) }));
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main(process.argv.slice(2)).catch(error => { console.error(/^[A-Z_]+$/.test(error?.message || '') ? error.message : 'EXISTING_POSTS_FAILED'); process.exitCode = 1; });
