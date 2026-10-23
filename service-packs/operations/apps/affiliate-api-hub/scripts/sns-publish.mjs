import { createHash } from 'node:crypto';
import { readFile, open } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildThreadsConfigureRequest, buildThreadsPhotoUploadRequest, buildThreadsVideoUploadRequest,
} from './sns/writers/threads.mjs';
import {
  buildInstagramCarouselConfigureRequest, buildInstagramPhotoUploadRequest,
  buildInstagramReelConfigureRequest, buildInstagramReelCoverUploadRequest, buildInstagramVideoUploadRequest,
} from './sns/writers/instagram.mjs';
import { buildCreateTweetRequest, loadXContracts, publishThread } from './sns/writers/x.mjs';
import { defaultJournalDir, runKeyFor } from './sns/writers/journal.mjs';
import { publishChain } from './sns/writers/threads.mjs';
import { publishCarousel, publishReel } from './sns/writers/instagram.mjs';
import { assertNotHeld } from './publish-hold.mjs';
import { SOCIAL_REQUEST_TIMEOUTS } from '../../social-actions/lib/request-timeouts.mjs';
import { assertXAffiliateDisclosure } from './sns/writers/x-affiliate-disclosure.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') fail('SNS_INPUT_MISSING'); throw error; }
}

async function pngDimensions(file) {
  const bytes = await readFile(file);
  if (bytes.length < 24 || bytes.toString('hex', 0, 8) !== '89504e470d0a1a0a') fail('SNS_PNG_CONTRACT_MISSING');
  return { bytes, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function threadsCoverImage(runDir) {
  const file = path.join(runDir, 'sns', 'instagram-01.png');
  let image;
  try { image = await pngDimensions(file); }
  catch (error) { if (error.code === 'ENOENT') fail('THREADS_COVER_IMAGE_MISSING'); throw error; }
  return { ...image, path: file, mimeType: 'image/png' };
}

async function threadsVideoAsset(runDir, manifest) {
  const shorts = manifest.outputs?.shorts;
  if (!shorts) fail('THREADS_VIDEO_OUTPUT_MISSING');
  const seconds = Number(shorts.seconds);
  if (!Number.isFinite(seconds) || seconds <= 0) fail('THREADS_VIDEO_DURATION_REQUIRED');
  const file = path.join(runDir, 'sns', 'shorts.mp4');
  let bytes;
  try { bytes = await readFile(file); }
  catch (error) { if (error.code === 'ENOENT') fail('THREADS_VIDEO_FILE_MISSING'); throw error; }
  if (bytes.length < 12 || bytes.length > 500 * 1024 * 1024 || bytes.toString('ascii', 4, 8) !== 'ftyp') {
    fail('THREADS_VIDEO_NOT_MP4');
  }
  // shorts.mjs renders 1080×1920 frames; Threads' rupload metadata also
  // carries a duration in milliseconds for the uploaded MP4.
  return { bytes, width: 1080, height: 1920, durationMs: Math.round(seconds * 1000), mimeType: 'video/mp4' };
}

// Owner 2026-09-30: Threads carries the shorts by default; SNS_THREADS_VIDEO=off opts out, =on requires it.
async function threadsVideoFor(runDir, manifest) {
  const mode = process.env.SNS_THREADS_VIDEO;
  if (mode === 'off') return null;
  if (mode !== 'on' && !manifest.outputs?.shorts) return null;
  return threadsVideoAsset(runDir, manifest);
}

async function xVideoAsset(runDir, manifest) {
  const name = manifest.outputs?.x?.videoFile;
  if (name == null) return null;
  if (typeof name !== 'string' || path.basename(name) !== name || !/^shorts(?:-[\w-]+)?\.mp4$/i.test(name)) {
    fail('X_VIDEO_PATH_INVALID');
  }
  const file = path.join(runDir, 'sns', name);
  const bytes = await readFile(file).catch(error => { if (error.code === 'ENOENT') fail('X_VIDEO_FILE_MISSING'); throw error; });
  if (bytes.length < 1000 || bytes.toString('ascii', 4, 8) !== 'ftyp') fail('X_VIDEO_NOT_MP4');
  return { file, name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function previewSession(service) {
  return {
    service, owner: 'lifehack__ailab',
    cookies: ['sessionid', 'csrftoken', 'ds_user_id', 'rur'].map(name => ({ name, value: '<redacted>' })),
    ownerRequest: { headers: {
      'x-ig-app-id': '<redacted>', 'x-asbd-id': '<redacted>', 'x-fb-lsd': '<redacted>', 'x-web-session-id': '<redacted>',
      'x-ig-www-claim': '<redacted>', 'x-instagram-ajax': '<redacted>',
    } },
  };
}

function redactRequest(request) {
  const headers = {};
  for (const [name, value] of Object.entries(request.headers || {})) {
    headers[name] = /cookie|authorization|csrf|lsd|www-claim|web-session-id/i.test(name) ? '<redacted>' : value;
  }
  let body = request.body;
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    const bytes = Buffer.from(body);
    body = { binary: true, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  } else if (body instanceof URLSearchParams) body = body.toString();
  return { method: request.method, url: request.url, headers, body };
}

async function instagramAssets(runDir, manifest) {
  const snsDir = path.join(runDir, 'sns');
  const names = manifest.outputs?.instagram?.cards;
  if (!Array.isArray(names) || names.length < 2 || names.length > 10) fail('INSTAGRAM_CARDS_MISSING');
  const cards = names.map(name => {
    if (typeof name !== 'string' || path.basename(name) !== name || !/^instagram-[\w-]+\.png$/i.test(name)) fail('INSTAGRAM_CARD_PATH_INVALID');
    return path.join(snsDir, name);
  });
  const reelPath = path.join(snsDir, 'shorts.mp4');
  const reelCoverName = manifest.outputs?.instagram?.reelCover;
  let reelCoverPath = null;
  if (reelCoverName !== undefined) {
    if (typeof reelCoverName !== 'string' || path.basename(reelCoverName) !== reelCoverName
      || !/^instagram-reel-cover-[\w-]+\.jpe?g$/i.test(reelCoverName)) fail('INSTAGRAM_REEL_COVER_PATH_INVALID');
    reelCoverPath = path.join(snsDir, reelCoverName);
    if (!await exists(reelCoverPath)) fail('INSTAGRAM_REEL_COVER_MISSING');
  }
  let reel = null;
  if (manifest.outputs?.shorts && await exists(reelPath)) {
    reel = { path: reelPath, seconds: Number(manifest.outputs.shorts.seconds), coverPath: reelCoverPath };
  }
  return { cards, reel };
}

async function exists(file) {
  try { await readFile(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function dryRunRequests(runDir, channel, versions, manifest, xContractsLoader = loadXContracts) {
  const requests = [];
  let mediaUploadPlan = null;
  if (channel === 'threads') {
    const session = previewSession('threads');
    const chainId = 'DRY-RUN-CHAIN';
    const cover = process.env.SNS_THREADS_IMAGES === 'on' ? await threadsCoverImage(runDir) : null;
    const video = await threadsVideoFor(runDir, manifest);
    const requestContext = { fbDtsg: 'preview-only', jazoest: '0', lsd: 'preview-only' };
    const firstPostUploadIds = [];
    if (cover) {
      const uploadId = 'DRY-RUN-THREADS-COVER';
      firstPostUploadIds.push(uploadId);
      requests.push(buildThreadsPhotoUploadRequest({ ...cover, uploadId, entityName: `fb_uploader_${uploadId}`,
        requestContext, session }));
    }
    if (video) {
      const uploadId = '1780000000000';
      firstPostUploadIds.push(uploadId);
      requests.push(buildThreadsVideoUploadRequest({ ...video, uploadId, entityName: `fb_uploader_${uploadId}`,
        requestContext, session }));
    }
    for (let index = 0; index < versions.threads.posts.length; index += 1) {
      requests.push(buildThreadsConfigureRequest({ caption: versions.threads.posts[index],
        ...(index === 0 && firstPostUploadIds.length ? { uploadIds: firstPostUploadIds } : { uploadId: `DRY-RUN-UPLOAD-${index + 1}` }),
        chainId, chainIndex: index, chainLength: versions.threads.posts.length,
        requestContext, webSessionId: '<redacted>', session }));
    }
    if (versions.threads.affiliateReply) requests.push(buildThreadsConfigureRequest({ caption: versions.threads.affiliateReply, uploadId: 'DRY-RUN-AFFILIATE',
      chainId: 'DRY-RUN-AFFILIATE-CHAIN', chainIndex: 0, chainLength: 1, replyId: 'DRY-RUN-LAST-POST', webSessionId: '<redacted>', session }));
  } else if (channel === 'instagram') {
    const session = previewSession('instagram');
    const assets = await instagramAssets(runDir, manifest);
    const uploadIds = [];
    for (let index = 0; index < assets.cards.length; index += 1) {
      const image = await pngDimensions(assets.cards[index]);
      const uploadId = `DRY-RUN-UPLOAD-${index + 1}`;
      uploadIds.push(uploadId);
      requests.push(buildInstagramPhotoUploadRequest({ ...image, uploadId, entityName: uploadId, session }));
    }
    requests.push(buildInstagramCarouselConfigureRequest({ caption: versions.instagram.caption, uploadIds,
      clientSidecarId: 'DRY-RUN-SIDECAR', requestContext: { fbDtsg: 'preview-only', jazoest: '0' }, session }));
    if (assets.reel && !assets.reel.coverPath) {
      mediaUploadPlan = { operation: 'instagram_reel_upload', execution: 'direct_http', skipped: 'REEL_COVER_JPEG_NOT_CONFIGURED' };
    } else if (assets.reel) {
      if (!Number.isFinite(assets.reel.seconds) || assets.reel.seconds <= 0) fail('NOT_IMPLEMENTED_CONTRACT_MISSING');
      const bytes = await readFile(assets.reel.path);
      const uploadId = '17900000000000000';
      requests.push(buildInstagramVideoUploadRequest({ bytes, width: 1080, height: 1920,
        durationMs: Math.round(assets.reel.seconds * 1000), uploadId, session }));
      const coverBytes = await readFile(assets.reel.coverPath);
      requests.push(buildInstagramReelCoverUploadRequest({ bytes: coverBytes, width: 1080, height: 1920,
        uploadId, session }));
      requests.push(buildInstagramReelConfigureRequest({ caption: versions.instagram.caption, uploadId,
        sourceType: manifest.outputs.shorts.sourceType ?? manifest.outputs.shorts.source_type ?? 'DRY-RUN-SOURCE-TYPE', session }));
    }
  } else if (channel === 'x') {
    const contracts = await xContractsLoader();
    const video = await xVideoAsset(runDir, manifest);
    if (video) {
      const segments = Math.ceil(video.bytes / (2 * 1024 * 1024));
      mediaUploadPlan = { operation: 'x_video_upload', execution: 'direct_http', file: video.name,
        contentType: 'video/mp4', bytes: video.bytes, sha256: video.sha256, segmentCount: segments,
        phases: ['INIT', 'APPEND', 'FINALIZE', 'STATUS'], attachedPostIndex: 0 };
    }
    for (let index = 0; index < versions.x.posts.length; index += 1) {
      const request = buildCreateTweetRequest({ post: versions.x.posts[index],
        ...(index ? { replyToId: `DRY-RUN-POST-${index}` } : {}), contracts,
        ...(video && index === 0 ? { mediaIds: ['0000000000000000000'] } : {}) });
      requests.push({ ...request, headers: { ...request.headers, 'x-client-transaction-id': '<generated by sns-X on send>' } });
    }
    if (versions.x.affiliateReply) {
      const request = buildCreateTweetRequest({ post: versions.x.affiliateReply, replyToId: 'DRY-RUN-LAST-POST', contracts });
      requests.push({ ...request, headers: { ...request.headers, 'x-client-transaction-id': '<generated by sns-X on send>' } });
    }
  }
  return { requests: requests.map(redactRequest), ...(mediaUploadPlan ? { mediaUploadPlan } : {}) };
}

export async function sendTransport(request) {
  const headers = { ...request.headers };
  let body = request.body;
  if (body instanceof URLSearchParams) body = body.toString();
  else if (body && typeof body === 'object' && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
    body = JSON.stringify(body);
    if (!Object.keys(headers).some(name => name.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
  }
  const {createBotDebugFetch}=await import('../../social-actions/lib/bot-debug-log.mjs');
  const url=new URL(request.url),service=url.origin==='https://www.threads.com'?'threads':
    ['https://x.com','https://api.x.com'].includes(url.origin)?'x':null;
  const fetchImpl=service?createBotDebugFetch(globalThis.fetch,{service}):globalThis.fetch;
  return fetchImpl(request.url, { method: request.method, headers, ...(body === undefined ? {} : { body }),
    // A slow create may already have reached the service. Allow 120 s for its
    // response and keep the existing one-attempt journal/reconciliation policy.
    redirect: 'error', signal: AbortSignal.timeout(SOCIAL_REQUEST_TIMEOUTS.write) });
}

// One whole run is reserved before invoking a writer. Request-level journals alone
// do not stop a second invocation from allocating new upload/chain IDs.
async function reservePublicationRun(root, channel, runKey) {
  const file = path.join(root, 'sns', `.publish-${channel}-intent.json`);
  let handle;
  try { handle = await open(file, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') fail('SNS_RUN_RECONCILIATION_REQUIRED');
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ version: 1, channel, runKey,
      state: 'writer_reserved', createdAt: new Date().toISOString(), automaticRetry: false }) + '\n');
    await handle.sync();
  } finally { await handle.close(); }
}

export async function runSnsPublish({ runDir, channel, dryRun = false, approvalId, transport = sendTransport,
  journalDir, writers = {}, xContractsLoader = loadXContracts } = {}) {
  if (!runDir || !['threads', 'instagram', 'x'].includes(channel)) fail('SNS_ARGUMENTS_INVALID');
  const root = path.resolve(runDir);
  const verification = await readJson(path.join(root, 'final-verification.json'));
  if (verification.status !== 'published_verified') fail('NAVER_NOT_VERIFIED');
  const snsDir = path.join(root, 'sns');
  const versions = await readJson(path.join(snsDir, 'versions.json'));
  const manifest = await readJson(path.join(snsDir, 'sns-manifest.json'));
  if (channel === 'x') assertXAffiliateDisclosure(versions.x.posts, { affiliateReply: versions.x.affiliateReply });
  if (dryRun) {
    return { dryRun: true, channel, ...(await dryRunRequests(root, channel, versions, manifest, xContractsLoader)) };
  }
  if (typeof approvalId !== 'string' || !approvalId.trim()) fail('APPROVAL_REQUIRED');
  // Threads image configure answers posts[0].status=ERROR "Missing info." (NO_RETRY) — a required field is not in the
  // captured contract (2026-09-29). Image posts stay off until the configure request is re-captured; text chains work.
  const threadsCover = channel === 'threads' && process.env.SNS_THREADS_IMAGES === 'on' ? await threadsCoverImage(root) : null;
  const threadsVideo = channel === 'threads' ? await threadsVideoFor(root, manifest) : null;
  const runKey = runKeyFor(root);
  const activeJournalDir = journalDir || defaultJournalDir();
  await reservePublicationRun(root, channel, runKey);
  if (channel === 'threads') {
    const result = await (writers.publishChain || publishChain)(versions.threads.posts, { transport, journalDir: activeJournalDir, runKey, runDir: root,
      images: threadsCover ? [{ postIndex: 0, file: threadsCover }] : [],
      videos: threadsVideo ? [{ postIndex: 0, file: threadsVideo }] : [] });
    // The affiliate reply (registered networks only, checked when the versions were built) goes under the last post.
    const affiliateReply = versions.threads.affiliateReply
      ? await (writers.publishChain || publishChain)([versions.threads.affiliateReply], { transport, journalDir: activeJournalDir, runKey: `${runKey}-affiliate`, runDir: root, replyId: result.ids.at(-1) })
      : null;
    return { channel, approvalId, ...result, ...(affiliateReply ? { affiliateReply } : {}) };
  }
  if (channel === 'instagram') {
    const assets = await instagramAssets(root, manifest);
    const sourceType = manifest.outputs.shorts?.sourceType ?? manifest.outputs.shorts?.source_type;
    // The Reel configure source_type is not verified yet (2026-09-28): without it the carousel still posts and the Reel
    // is skipped and reported, instead of failing the whole channel.
    let reelSkipped = null;
    if (assets.reel && (typeof sourceType !== 'string' || !sourceType.trim())) { assets.reel = null; reelSkipped = 'REEL_SOURCE_TYPE_UNVERIFIED'; }
    if (assets.reel && !assets.reel.coverPath) { assets.reel = null; reelSkipped = 'REEL_COVER_JPEG_NOT_CONFIGURED'; }
    const carousel = await (writers.publishCarousel || publishCarousel)(assets.cards, versions.instagram.caption,
      { transport, journalDir: activeJournalDir, runKey, runDir: root });
    let reel = null;
    if (assets.reel) {
      if (!Number.isFinite(assets.reel.seconds) || assets.reel.seconds <= 0) fail('NOT_IMPLEMENTED_CONTRACT_MISSING');
      reel = await (writers.publishReel || publishReel)(assets.reel.path, versions.instagram.caption,
        { transport, journalDir: activeJournalDir, runKey, runDir: root, sourceType,
          cover: assets.reel.coverPath,
          videoInfo: { width: 1080, height: 1920, durationMs: Math.round(assets.reel.seconds * 1000) } });
    }
    return { channel, approvalId, carousel, reel, ...(reelSkipped ? { reelSkipped } : {}) };
  }
  const video = await xVideoAsset(root, manifest);
  const result = await (writers.publishThread || publishThread)(versions.x.posts, {
    journalDir: activeJournalDir, runKey, runDir: root, ...(video ? { videoFile: video.file } : {}),
    affiliateReply: versions.x.affiliateReply,
  });
  const affiliateReply = versions.x.affiliateReply
    ? await (writers.publishThread || publishThread)([versions.x.affiliateReply], { journalDir: activeJournalDir, runKey: `${runKey}-affiliate`, runDir: root, replyToId: result.ids.at(-1), mainText: versions.x.posts[0] })
    : null;
  return { channel, approvalId, ...result, ...(affiliateReply ? { affiliateReply } : {}) };
}

function cliArgs(argv) {
  const values = Object.fromEntries(argv.filter(arg => arg.startsWith('--') && arg.includes('='))
    .map(arg => { const at = arg.indexOf('='); return [arg.slice(2, at), arg.slice(at + 1)]; }));
  return { runDir: values.run, channel: values.channel, approvalId: values.approval,
    dryRun: argv.includes('--dry-run') };
}

async function main() {
  const args = cliArgs(process.argv.slice(2));
  if (!args.dryRun) assertNotHeld(args.runDir);
  const result = await runSnsPublish(args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error.code || 'SNS_PUBLISH_FAILED', ...(error.detail ? { detail: error.detail } : {}) })}\n`);
    process.exitCode = 1;
  });
}
