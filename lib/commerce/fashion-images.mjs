// Image download for the fashion sourcing commands. Writes into a caller-given LOCAL directory only
// (the CLI downloads into a temp folder first and then copies the files to --out).
// Bounded: https only, image/jpeg|png|webp|gif only, 15 MB per file, paced requests, no cookies.

import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FASHION_USER_AGENT, fashionFail } from './fashion-http.mjs';

const TYPE_EXT = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' });

/**
 * items: [{ url, kind }] -> [{ file, kind, sourceUrl, contentType, bytes, sha256 }] written under dir.
 * Failed items are returned in `skipped` with a code (no retry: 403/429/404 or a non-image body stop that item).
 */
export async function downloadImageSet({
  items, dir, prefix, fetchImpl = globalThis.fetch, sleep = ms => new Promise(r => setTimeout(r, ms)),
  minIntervalMs = 500, maxBytes = 15 * 1024 * 1024, timeoutMs = 30_000,
}) {
  const saved = [];
  const skipped = [];
  let last = 0;
  for (let i = 0; i < items.length; i++) {
    const { url, kind } = items[i];
    let u;
    try { u = new URL(url); } catch { skipped.push({ sourceUrl: url, code: 'IMAGE_URL_INVALID' }); continue; }
    if (u.protocol !== 'https:') { skipped.push({ sourceUrl: url, code: 'IMAGE_URL_INVALID' }); continue; }
    const wait = last + minIntervalMs - Date.now();
    if (last && wait > 0) await sleep(wait);
    last = Date.now();
    let res;
    try {
      res = await fetchImpl(u, { headers: { 'User-Agent': FASHION_USER_AGENT, Accept: 'image/*' }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      skipped.push({ sourceUrl: url, code: error?.name === 'TimeoutError' ? 'IMAGE_TIMEOUT' : 'IMAGE_FETCH_FAILED' });
      continue;
    }
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (res.status !== 200) { skipped.push({ sourceUrl: url, code: `IMAGE_HTTP_${res.status}` }); continue; }
    const ext = TYPE_EXT[contentType];
    if (!ext) { skipped.push({ sourceUrl: url, code: 'IMAGE_TYPE_REJECTED' }); continue; }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > maxBytes) { skipped.push({ sourceUrl: url, code: 'IMAGE_SIZE_REJECTED' }); continue; }
    const file = `${prefix}-${String(saved.length + 1).padStart(2, '0')}-${kind}.${ext}`;
    await writeFile(path.join(dir, file), bytes, { flag: 'wx', mode: 0o600 });
    saved.push({ file, kind, sourceUrl: url, contentType, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  if (!saved.length && items.length) fashionFail('IMAGE_NONE_SAVED', { skipped: skipped.length });
  return { saved, skipped };
}
