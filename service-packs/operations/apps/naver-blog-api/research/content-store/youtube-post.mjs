import { createHash } from 'node:crypto';

export function youtubeIdentity(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  let id;
  if (url.hostname === 'youtu.be') id = url.pathname.match(/^\/([A-Za-z0-9_-]{11})\/?$/)?.[1];
  else if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) {
    id = url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})\/?$/)?.[1];
  }
  return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? { platform: 'youtube', id, url: `https://www.youtube.com/watch?v=${id}` } : null;
}

// This is metadata, not a transcript. Transcript evidence is attached separately
// with its acquisition method and time ranges by the reference workflow.
export async function fetchYouTubePost(input, fetchImpl = globalThis.fetch) {
  const endpoint = new URL('https://www.youtube.com/oembed');
  endpoint.searchParams.set('url', input.url);
  endpoint.searchParams.set('format', 'json');
  const response = await fetchImpl(endpoint, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { accept: 'application/json' } });
  const receipt = { sourceUrl: input.url, collectionMethod: 'youtube_oembed_metadata',
    httpStatus: response.status, httpStatuses: [response.status], browserUsed: false, credentialsUsed: false,
    readerReturnedContent: false, postContentValidated: false, contentCoverage: 'metadata_only',
    transcriptAvailable: false, liveReplay: false, executionMode: 'pure_http' };
  const unavailable = code => ({ status: 'unavailable', items: [], receipt: { ...receipt, code } });
  if (response.status !== 200 || !(response.headers.get('content-type') || '').includes('application/json')) {
    await response.body?.cancel();
    return unavailable(response.status !== 200 ? `YOUTUBE_HTTP_${response.status}` : 'YOUTUBE_CONTENT_TYPE');
  }
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body || []) {
    bytes += chunk.length;
    if (bytes > 100000) return unavailable('YOUTUBE_METADATA_TOO_LARGE');
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  receipt.responseBytes = body.length;
  receipt.responseSha256 = createHash('sha256').update(body).digest('hex');
  receipt.responseBodyRead = true;
  let value;
  try { value = JSON.parse(body.toString('utf8')); } catch { return unavailable('YOUTUBE_METADATA_SCHEMA'); }
  const embed = String(value.html || '').match(/<iframe\b[^>]*\bsrc=["']([^"']+)["']/i)?.[1];
  if (value.type !== 'video' || value.provider_name !== 'YouTube' || youtubeIdentity(embed)?.id !== input.id
    || typeof value.title !== 'string' || !value.title.trim() || typeof value.author_name !== 'string') return unavailable('YOUTUBE_METADATA_IDENTITY');
  return { status: 'partial', items: [{ title: value.title.slice(0,300), summary: '', url: input.url,
    publisher: value.author_name.slice(0,160), sourceKind: 'video_reference', evidenceLevel: 'video_metadata',
    publishedAt: null, publishedAtPrecision: 'unknown', contentCoverage: 'metadata_only', bodyTruncated: false }],
  receipt: { ...receipt, observedItems: 1, readerReturnedContent: true, metadataValidated: true, liveReplay: true,
    code: 'YOUTUBE_TRANSCRIPT_NOT_FETCHED' } };
}
