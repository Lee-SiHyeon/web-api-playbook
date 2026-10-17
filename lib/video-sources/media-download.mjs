import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync, createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Bounded media download with a provenance sidecar. Every saved file records where it came from and which
// rights basis the caller claims, because product videos are third-party works (seller/creator copyright).

export const RIGHTS_BASIS = Object.freeze([
  'seller_product_video_unverified',   // seller-uploaded marketplace video; reuse terms not verified
  'affiliate_api_media',               // returned by an official affiliate/partner API for promotion
  'supplier_licensed_marketing',       // supplier explicitly licenses media to resellers (e.g. dropship catalog)
  'own_footage',                       // filmed by the operator
  'creator_content_unlicensed',        // UGC from a social platform; reference only unless licensed
]);

export class MediaDownloadError extends Error {
  constructor(code, detail = null) { super(code); this.name = 'MediaDownloadError'; this.code = code; this.detail = detail; }
}
const fail = (code, detail) => { throw new MediaDownloadError(code, detail); };

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

export async function downloadMedia({ url, outDir, fileStem, allowedHosts, provenance, maxBytes = 256 * 1024 * 1024,
  fetchImpl = globalThis.fetch, now = Date.now, userAgent } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { fail('MEDIA_URL_INVALID'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) fail('MEDIA_URL_INVALID');
  if (!Array.isArray(allowedHosts) || !allowedHosts.includes(parsed.hostname)) fail('MEDIA_HOST_NOT_ALLOWED', { host: parsed.hostname });
  if (typeof fileStem !== 'string' || !SAFE_NAME.test(fileStem)) fail('MEDIA_NAME_INVALID');
  if (!provenance || typeof provenance !== 'object' || !RIGHTS_BASIS.includes(provenance.rightsBasis)
    || typeof provenance.sourcePlatform !== 'string' || typeof provenance.sourceUrl !== 'string') fail('MEDIA_PROVENANCE_REQUIRED');
  if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 1024 * 1024 * 1024) fail('MEDIA_LIMIT_INVALID');
  const dir = path.resolve(outDir);
  mkdirSync(dir, { recursive: true });
  const response = await fetchImpl(parsed.href, { redirect: 'follow', headers: { accept: 'video/*,image/*;q=0.8',
    ...(userAgent ? { 'user-agent': userAgent } : {}) } });
  const finalHost = new URL(response.url || parsed.href).hostname;
  if (!allowedHosts.includes(finalHost)) fail('MEDIA_REDIRECT_HOST_NOT_ALLOWED', { host: finalHost });
  if (response.status !== 200 || !response.body) fail('MEDIA_HTTP_FAILED', { status: response.status });
  const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!/^(video\/(mp4|webm|quicktime)|image\/(jpeg|png|webp|avif))$/.test(mime)) fail('MEDIA_MIME_UNSUPPORTED', { mime });
  const ext = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'image/jpeg': 'jpg', 'image/png': 'png',
    'image/webp': 'webp', 'image/avif': 'avif' }[mime];
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) fail('MEDIA_TOO_LARGE', { declared });
  const target = path.join(dir, `${fileStem}.${ext}`);
  if (existsSync(target)) fail('MEDIA_TARGET_EXISTS', { file: target });
  const tmp = `${target}.${process.pid}.part`;
  const hash = createHash('sha256');
  let bytes = 0;
  const counter = new TransformStream({ transform(chunk, controller) {
    bytes += chunk.byteLength; if (bytes > maxBytes) { controller.error(new MediaDownloadError('MEDIA_TOO_LARGE')); return; }
    hash.update(chunk); controller.enqueue(chunk); } });
  try {
    await pipeline(Readable.fromWeb(response.body.pipeThrough(counter)), createWriteStream(tmp, { flags: 'wx' }));
    renameSync(tmp, target);
  } catch (error) {
    rmSync(tmp, { force: true });
    if (error instanceof MediaDownloadError) throw error;
    fail('MEDIA_WRITE_FAILED');
  }
  const sha256 = hash.digest('hex');
  const record = { version: 1, file: path.basename(target), mime, bytes, sha256, downloadedAt: new Date(now()).toISOString(),
    downloadUrlHost: finalHost, ...provenance,
    reuseNote: provenance.rightsBasis === 'own_footage' || provenance.rightsBasis === 'supplier_licensed_marketing'
      ? 'licensed_or_owned' : 'third_party_work_verify_rights_before_publishing' };
  writeFileSync(`${target}.provenance.json`, JSON.stringify(record, null, 2));
  return { ...record, path: target };
}
