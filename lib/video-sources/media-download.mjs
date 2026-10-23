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
  fetchImpl = globalThis.fetch, now = Date.now, userAgent, referer } = {}) {
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
    ...(userAgent ? { 'user-agent': userAgent } : {}), ...(referer ? { referer } : {}) } });
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

/**
 * HLS (m3u8) download: pick the highest variant up to maxHeight from the master playlist, remux with ffmpeg
 * (`-c copy`, no re-encode) into MP4, then hash and write the same provenance sidecar as downloadMedia.
 * ffmpeg comes from `ffmpegPath`, env FFMPEG_BIN, or PATH.
 */
export async function downloadHlsMedia({ masterUrl, outDir, fileStem, allowedHosts, provenance, maxHeight = 1080,
  fetchImpl = globalThis.fetch, now = Date.now, ffmpegPath = process.env.FFMPEG_BIN || 'ffmpeg', timeoutMs = 10 * 60_000 } = {}) {
  let master;
  try { master = new URL(masterUrl); } catch { fail('MEDIA_URL_INVALID'); }
  if (master.protocol !== 'https:' || !Array.isArray(allowedHosts) || !allowedHosts.includes(master.hostname)) fail('MEDIA_HOST_NOT_ALLOWED', { host: master.hostname });
  if (typeof fileStem !== 'string' || !SAFE_NAME.test(fileStem)) fail('MEDIA_NAME_INVALID');
  if (!provenance || typeof provenance !== 'object' || !RIGHTS_BASIS.includes(provenance.rightsBasis)
    || typeof provenance.sourcePlatform !== 'string' || typeof provenance.sourceUrl !== 'string') fail('MEDIA_PROVENANCE_REQUIRED');
  const res = await fetchImpl(master.href, { headers: { accept: 'application/vnd.apple.mpegurl,*/*;q=0.5' } });
  if (res.status !== 200) fail('MEDIA_HTTP_FAILED', { status: res.status });
  const text = await res.text();
  if (!text.startsWith('#EXTM3U') || text.length > 256 * 1024) fail('MEDIA_HLS_INVALID');
  const variants = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^#EXT-X-STREAM-INF:(.*)$/.exec(lines[i]);
    if (!m) continue;
    const res = /RESOLUTION=(\d+)x(\d+)/.exec(m[1]);
    // Compare the short side so a vertical 1080x1920 variant counts as 1080p.
    const height = res ? Math.min(Number(res[1]), Number(res[2])) : NaN;
    const resolution = res ? `${res[1]}x${res[2]}` : null;
    const uri = lines[i + 1]?.trim();
    if (!uri || uri.startsWith('#')) continue;
    const url = new URL(uri, master);
    if (url.protocol === 'https:' && url.hostname === master.hostname) variants.push({ height: Number.isFinite(height) ? height : 0, resolution, url: url.href });
  }
  const chosen = variants.filter(v => v.height <= maxHeight).sort((a, b) => b.height - a.height)[0] ?? (variants.length ? null : { height: null, resolution: null, url: master.href });
  if (!chosen) fail('MEDIA_HLS_NO_VARIANT');
  const dir = path.resolve(outDir);
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${fileStem}.mp4`);
  if (existsSync(target)) fail('MEDIA_TARGET_EXISTS', { file: target });
  const tmp = `${target}.${process.pid}.part.mp4`;
  const { spawn } = await import('node:child_process');
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'https,tls,tcp,crypto',
      '-i', chosen.url, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', '-y', tmp], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-2000); });
    const timer = setTimeout(() => { child.kill(); reject(new MediaDownloadError('MEDIA_HLS_TIMEOUT')); }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); reject(new MediaDownloadError('MEDIA_FFMPEG_UNAVAILABLE')); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new MediaDownloadError('MEDIA_HLS_REMUX_FAILED', { stderr: stderr.slice(-300) })); });
  }).catch(error => { rmSync(tmp, { force: true }); throw error; });
  renameSync(tmp, target);
  const { readFileSync, statSync } = await import('node:fs');
  const bytes = statSync(target).size;
  const sha256 = createHash('sha256').update(readFileSync(target)).digest('hex');
  const record = { version: 1, file: path.basename(target), mime: 'video/mp4', bytes, sha256, downloadedAt: new Date(now()).toISOString(),
    downloadUrlHost: master.hostname, hlsVariantShortSide: chosen.height, hlsVariantResolution: chosen.resolution ?? null, ...provenance,
    reuseNote: provenance.rightsBasis === 'own_footage' || provenance.rightsBasis === 'supplier_licensed_marketing'
      ? 'licensed_or_owned' : 'third_party_work_verify_rights_before_publishing' };
  writeFileSync(`${target}.provenance.json`, JSON.stringify(record, null, 2));
  return { ...record, path: target };
}
