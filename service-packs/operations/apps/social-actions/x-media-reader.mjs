import { withXReadContext } from './providers/x.mjs';
import { SOCIAL_REQUEST_TIMEOUTS } from './lib/request-timeouts.mjs';
import { decodeXTimeline } from '../naver-blog-api/research/content-store/x-xhr.mjs';

const fail = (code, receipt) => { throw Object.assign(new Error(code), { code, receipt }); };
export async function readXMedia(handle = 'lifehack__ailab', { withContext = withXReadContext } = {}) {
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) fail('X_MEDIA_INPUT');
  return withContext(async context => {
    if (context.ownerHandle !== 'lifehack__ailab') fail('X_MEDIA_OWNER_MISMATCH');
    const profile = await context.lookupUser(handle);
    if (profile.protected !== false) fail('X_MEDIA_PRIVATE_PROFILE');
    const contract = context.timelineContract;
    if (!contract || !['UserOriginalsTimeline', 'UserTweets'].includes(contract.operation)
      || !/^[A-Za-z0-9_-]+$/.test(contract.queryId || '') || contract.missing?.length) fail('X_MEDIA_CONTRACT_UNAVAILABLE');
    const prefix = context.apiTransitionEnabled ? '/i/api' : '';
    const url = new URL(prefix + '/graphql/' + contract.queryId + '/' + contract.operation,
      context.apiTransitionEnabled ? 'https://x.com' : 'https://api.x.com');
    url.searchParams.set('variables', JSON.stringify({ userId: profile.userId, count: 20, includePromotedContent: true,
      withQuickPromoteEligibilityTweetFields: true, withVoice: context.timelineWithVoice === true }));
    url.searchParams.set('features', JSON.stringify(contract.features));
    if (contract.operation === 'UserOriginalsTimeline') url.searchParams.set('fieldToggles', JSON.stringify({ withPayments: false, withArticlePlainText: false }));
    const response = await context.request('GET', url.pathname, url.href);
    const receipt = { service: 'x', operation: 'timeline_media', method: 'GET', path: url.pathname,
      httpStatus: response.status, mime: response.headers['content-type']?.split(';')[0] || null,
      browserUsed: false, executionMode: 'pure_http', checkedAt: new Date().toISOString(),
      captured: false, client_exists: true, remnant_free: true, credential_propagated: withContext === withXReadContext, live_replay: false };
    if (response.status !== 200 || !receipt.mime?.includes('json')) fail('X_MEDIA_READ_REJECTED', receipt);
    let payload; try { payload = JSON.parse(response.raw); } catch { fail('X_MEDIA_SCHEMA', receipt); }
    if (payload.errors?.length) fail('X_MEDIA_SCHEMA', receipt);
    const instructions = payload.data?.user?.result?.timeline?.timeline?.instructions
      ?? payload.data?.user?.result?.timeline_v2?.timeline?.instructions;
    const decoded = decodeXTimeline(instructions, handle);
    if (decoded.items.some(item => item.publisherId !== profile.userId)) fail('X_MEDIA_IDENTITY', receipt);
    receipt.live_replay = withContext === withXReadContext;
    return { service: 'x', owner: context.ownerHandle, target: handle, items: decoded.items,
      hasNextPage: Boolean(decoded.nextCursor), fullInventory: false, paginationSupported: false,
      receipt, socialWrites: 0 };
  });
}

export function selectXMediaAsset(media) {
  if (media?.type === 'photo' && typeof media.url === 'string') return { url: media.url, kind: 'image' };
  if (['video', 'animated_gif'].includes(media?.type)) {
    const mp4 = (media.variants || []).filter(item => item.contentType === 'video/mp4')
      .sort((a, b) => (b.bitrate ?? -1) - (a.bitrate ?? -1))[0];
    if (mp4) return { url: mp4.url, kind: 'video' };
  }
  fail('X_MEDIA_DOWNLOAD_VARIANT_UNAVAILABLE');
}

export function identifyXMediaBytes(buffer, mime) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) fail('X_MEDIA_DOWNLOAD_FORMAT');
  const type = String(mime || '').split(';')[0].toLowerCase();
  if (type === 'image/jpeg' && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (type === 'image/png' && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (type === 'image/gif' && /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('ascii'))) return 'gif';
  if (type === 'image/webp' && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (type === 'video/mp4' && buffer.subarray(4, 8).toString('ascii') === 'ftyp') return 'mp4';
  fail('X_MEDIA_DOWNLOAD_FORMAT');
}

// Uses only the public media CDN URL returned by the read decoder. Authentication
// and scoped account headers are never attached to a download.
export async function downloadXMedia(media, { fetchImpl = globalThis.fetch, maxBytes = 25 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 100 * 1024 * 1024) fail('X_MEDIA_DOWNLOAD_LIMIT');
  const asset = selectXMediaAsset(media);
  let url; try { url = new URL(asset.url); } catch { fail('X_MEDIA_DOWNLOAD_SCOPE'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || !['pbs.twimg.com', 'video.twimg.com'].includes(url.hostname)) fail('X_MEDIA_DOWNLOAD_SCOPE');
  const response = await fetchImpl(url.href, { redirect: 'manual', signal: AbortSignal.timeout(SOCIAL_REQUEST_TIMEOUTS.read), headers: { accept: asset.kind === 'image' ? 'image/*' : 'video/mp4' } });
  if (response.status !== 200) fail('X_MEDIA_DOWNLOAD_HTTP_' + response.status);
  const mime = response.headers.get('content-type')?.split(';')[0] || '';
  let bytes = 0; const chunks = [];
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > maxBytes) fail('X_MEDIA_DOWNLOAD_LIMIT');
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  const extension = identifyXMediaBytes(buffer, mime);
  if (asset.kind === 'video' ? extension !== 'mp4' : extension === 'mp4') fail('X_MEDIA_DOWNLOAD_FORMAT');
  return { bytes: buffer, extension,
    receipt: { httpStatus: 200, mime, bytes: buffer.length, magicVerified: true, accountCredentialsSent: false,
      origin: url.origin, path: url.pathname, browserUsed: false, executionMode: 'pure_http', live_replay: fetchImpl === globalThis.fetch } };
}
