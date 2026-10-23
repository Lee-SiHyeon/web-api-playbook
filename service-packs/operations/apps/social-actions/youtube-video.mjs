import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { webApiPlaybookRoot } from '../affiliate-api-hub/adapters/web-auth-provider.mjs';
import {
  loadYoutubeSession,
  storeYoutubeSessionState,
  YOUTUBE_CHANNEL_ID,
} from './lib/youtube-auth-session.mjs';

const ORIGIN = 'https://studio.youtube.com';
const STORE = 'youtube-video-native-v1';
const CREATE_PATH = '/youtubei/v1/upload/createvideo';
const PUBLISH_PATH = '/youtubei/v1/video_manager/metadata_update';
const READ_PATH = '/youtubei/v1/creator/get_creator_videos';
const EXPECTED_PAID_PLACEMENT = 'VIDEO_PAID_PRODUCT_PLACEMENT_NOTIFY';
const EXPECTED_MADE_FOR_KIDS = 'VIDEO_MADE_FOR_KIDS_NOT_MFK';
const EXPECTED_ALTERED_CONTENT = 'VIDEO_HAS_ALTERED_CONTENT_YES';

const HEADER_ALLOWLIST = new Set([
  'authorization', 'content-type', 'referer', 'origin', 'user-agent',
  'x-goog-authuser', 'x-goog-visitor-id', 'x-origin', 'x-youtube-ad-signals',
  'x-youtube-client-name', 'x-youtube-client-version', 'x-youtube-delegation-context',
  'x-youtube-page-cl', 'x-youtube-page-label', 'x-youtube-time-zone',
  'x-youtube-utc-offset', 'sec-ch-ua', 'sec-ch-ua-arch', 'sec-ch-ua-bitness',
  'sec-ch-ua-form-factors', 'sec-ch-ua-full-version', 'sec-ch-ua-full-version-list',
  'sec-ch-ua-mobile', 'sec-ch-ua-model', 'sec-ch-ua-platform',
  'sec-ch-ua-platform-version', 'sec-ch-ua-wow64',
]);

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasOnlyKeys = (value, keys) => isObject(value) && Object.keys(value).every(key => keys.includes(key));
const sameArray = (left, right) => Array.isArray(left) && Array.isArray(right)
  && left.length === right.length && left.every((value, index) => value === right[index]);

async function runtime() {
  const root = webApiPlaybookRoot();
  const [{ ProtectedStore }, { ScopedSession }] = await Promise.all([
    import(pathToFileURL(path.join(root, 'lib/protected-store.mjs')).href),
    import(pathToFileURL(path.join(root, 'lib/scoped-session.mjs')).href),
  ]);
  return { store: new ProtectedStore(), ScopedSession };
}

function parseRequest(envelope, maxBytes, code) {
  if (!isObject(envelope?.request) || typeof envelope.request.body !== 'string'
    || Buffer.byteLength(envelope.request.body) > maxBytes) fail(code);
  let url;
  let body;
  try {
    url = new URL(envelope.request.url);
    body = JSON.parse(envelope.request.body);
  } catch {
    fail(code);
  }
  if (envelope.request.method !== 'POST' || url.origin !== ORIGIN
    || url.username || url.password || url.hash) fail(code);
  return { url, body };
}

function validateContext(body) {
  return body?.context?.client?.clientName === 62
    && body?.context?.user?.delegationContext?.externalChannelId === YOUTUBE_CHANNEL_ID;
}

function validateHeaders(rawHeaders, { refererPath, allowChannelReferer = false } = {}) {
  if (!isObject(rawHeaders)) fail('YOUTUBE_VIDEO_HEADERS_INVALID');
  const headers = {};
  for (const [rawName, value] of Object.entries(rawHeaders)) {
    const name = rawName.toLowerCase();
    if (!HEADER_ALLOWLIST.has(name) || Object.hasOwn(headers, name)
      || typeof value !== 'string' || /[\r\n\0]/.test(value) || value.length > 32768) {
      fail('YOUTUBE_VIDEO_HEADERS_INVALID');
    }
    headers[name] = value;
  }

  let referer;
  try {
    referer = new URL(headers.referer);
  } catch {
    fail('YOUTUBE_VIDEO_HEADERS_INVALID');
  }
  const expectedReferer = refererPath ? ORIGIN + refererPath : null;
  const channelReferer = allowChannelReferer
    && referer.origin === ORIGIN
    && referer.pathname.startsWith('/channel/' + YOUTUBE_CHANNEL_ID);
  if (!headers.authorization?.startsWith('SAPISIDHASH ')
    || headers['x-origin'] !== ORIGIN
    || headers['x-youtube-client-name'] !== '62'
    || !/^application\/json(?:;|$)/i.test(headers['content-type'] || '')
    || (expectedReferer ? headers.referer !== expectedReferer : !channelReferer)) {
    fail('YOUTUBE_VIDEO_HEADERS_INVALID');
  }
  return headers;
}

function validatePublishBody(body, envelope) {
  const allowed = [
    'encryptedVideoId', 'videoReadMask', 'flowType', 'title', 'description',
    'privacyState', 'draftState', 'tags', 'madeForKids', 'alteredContent',
    'productPlacement', 'context', 'attestationResponseData',
  ];
  const tags = envelope.expectedTags;
  const videoId = envelope.videoId;
  const expectedTagsValid = Array.isArray(tags) && tags.length > 0
    && tags.length <= 500 && tags.every(tag => typeof tag === 'string' && tag.length > 0);
  if (Object.keys(body).some(key => !allowed.includes(key))
    || !/^[-\w]{11}$/.test(videoId || '')
    || body.encryptedVideoId !== videoId
    || !hasOnlyKeys(body.title, ['newTitle'])
    || body.title.newTitle !== envelope.expectedTitle
    || !hasOnlyKeys(body.description, ['newDescription'])
    || body.description.newDescription !== envelope.expectedDescription
    || !hasOnlyKeys(body.privacyState, ['newPrivacy'])
    || body.privacyState.newPrivacy !== 'PUBLIC'
    || !hasOnlyKeys(body.draftState, ['operation'])
    || body.draftState.operation !== 'MDE_DRAFT_STATE_UPDATE_OPERATION_REMOVE_DRAFT_STATE'
    || !hasOnlyKeys(body.tags, ['newTags'])
    || !expectedTagsValid
    || !sameArray(body.tags.newTags, tags)
    || !hasOnlyKeys(body.madeForKids, ['operation', 'newMfk'])
    || body.madeForKids.operation !== 'MDE_MADE_FOR_KIDS_UPDATE_OPERATION_SET'
    || body.madeForKids.newMfk !== 'MDE_MADE_FOR_KIDS_TYPE_NOT_MFK'
    || !hasOnlyKeys(body.alteredContent, ['operation', 'newCreatorDisclosedHasAlteredContent'])
    || body.alteredContent.operation !== 'MDE_ALTERED_CONTENT_UPDATE_OPERATION_SET'
    || body.alteredContent.newCreatorDisclosedHasAlteredContent !== 'MDE_HAS_ALTERED_CONTENT_YES'
    || !hasOnlyKeys(body.productPlacement, [
      'newHasPaidProductPlacement',
      'newShowPaidProductPlacementOverlay',
      'newIsPaidProductPlacementSelfDeclaredDefinitive',
    ])
    || body.productPlacement.newHasPaidProductPlacement !== true
    || body.productPlacement.newShowPaidProductPlacementOverlay !== true
    || body.productPlacement.newIsPaidProductPlacementSelfDeclaredDefinitive !== true
    || !body.attestationResponseData?.challenge
    || !body.attestationResponseData?.webResponse
    || !/^[a-f0-9]{64}$/.test(envelope.assetSha256 || '')) {
    fail('YOUTUBE_VIDEO_PUBLISH_SCOPE_INVALID');
  }
}

function validateDraftBody(body, envelope) {
  const allowed = [
    'channelId', 'resourceId', 'frontendUploadId', 'initialMetadata',
    'contentLevelProtection', 'context', 'presumedShort',
  ];
  const metadata = body.initialMetadata;
  if (Object.keys(body).some(key => !allowed.includes(key))
    || body.channelId !== YOUTUBE_CHANNEL_ID
    || !isObject(body.resourceId?.scottyResourceId)
    || typeof body.resourceId.scottyResourceId.id !== 'string'
    || !body.resourceId.scottyResourceId.id
    || typeof body.frontendUploadId !== 'string'
    || !body.frontendUploadId
    || !hasOnlyKeys(metadata, ['title', 'privacy', 'draftState'])
    || !hasOnlyKeys(metadata.title, ['newTitle'])
    || metadata.title.newTitle !== envelope.expectedInitialTitle
    || typeof envelope.expectedInitialTitle !== 'string'
    || !hasOnlyKeys(metadata.privacy, ['newPrivacy'])
    || metadata.privacy.newPrivacy !== 'PRIVATE'
    || !hasOnlyKeys(metadata.draftState, ['isDraft'])
    || metadata.draftState.isDraft !== true
    || body.presumedShort !== true
    || !/^[a-f0-9]{64}$/.test(envelope.assetSha256 || '')) {
    fail('YOUTUBE_VIDEO_DRAFT_SCOPE_INVALID');
  }
}

export function validateYoutubeVideoEnvelope(envelope, { now = Date.now() } = {}) {
  const age = now - Date.parse(envelope?.observedAt);
  if (envelope?.version !== 1
    || envelope.channelId !== YOUTUBE_CHANNEL_ID
    || envelope.helperClosed !== true
    || envelope.browserWriteBlocked !== true
    || envelope.blockedReason !== 'inspector'
    || envelope.responseReceived !== false
    || !Number.isFinite(age)
    || age < -5000
    || age > 120000) fail('YOUTUBE_VIDEO_PROVENANCE_INVALID');

  const { url, body } = parseRequest(envelope, 256000, 'YOUTUBE_VIDEO_REQUEST_INVALID');
  if (!validateContext(body)) fail('YOUTUBE_VIDEO_REQUEST_INVALID');

  if (envelope.operation === 'publish') {
    if (url.pathname !== PUBLISH_PATH) fail('YOUTUBE_VIDEO_PUBLISH_SCOPE_INVALID');
    validatePublishBody(body, envelope);
  } else if (envelope.operation === 'create_draft') {
    if (url.pathname !== CREATE_PATH) fail('YOUTUBE_VIDEO_OPERATION_UNOBSERVED');
    validateDraftBody(body, envelope);
  } else {
    fail('YOUTUBE_VIDEO_OPERATION_UNOBSERVED');
  }

  const refererPath = envelope.operation === 'publish'
    ? '/video/' + envelope.videoId + '/edit'
    : null;
  const headers = validateHeaders(envelope.request.headers, {
    refererPath,
    allowChannelReferer: envelope.operation === 'create_draft',
  });
  return { body, headers, requestSha256: hash(envelope.request.body) };
}

export async function stageYoutubeVideo(envelope) {
  validateYoutubeVideoEnvelope(envelope);
  const { store } = await runtime();
  const receipt = store.write(STORE, JSON.stringify(envelope));
  if (!receipt.persistent || receipt.provider !== 'Windows DPAPI CurrentUser') {
    fail('YOUTUBE_VIDEO_DPAPI_REQUIRED');
  }
  return { staged: true, operation: envelope.operation, helperClosed: true };
}

function journalPath(key) {
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(key || '') || !process.env.LOCALAPPDATA) {
    fail('YOUTUBE_VIDEO_JOB_INVALID');
  }
  return path.join(process.env.LOCALAPPDATA, 'affiliate-content-operations', 'youtube', 'journal', key + '.json');
}

async function save(file, record) {
  const temporary = file + '.' + process.pid + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await fs.rename(temporary, file);
}

export function youtubeVideoIntentMatches(record, intent) {
  if (!isObject(record) || !isObject(intent)
    || !intent.operation
    || record.operation !== intent.operation
    || record.assetSha256 !== intent.assetSha256
    || record.expectedTitle !== intent.expectedTitle
    || record.expectedDescription !== intent.expectedDescription) return false;

  if (intent.operation === 'publish') {
    return Array.isArray(intent.expectedTags)
      && sameArray(record.expectedTags, intent.expectedTags);
  }
  if (intent.operation === 'create_draft') {
    return typeof intent.expectedInitialTitle === 'string'
      && record.expectedInitialTitle === intent.expectedInitialTitle;
  }
  return false;
}

export async function sendYoutubeVideo({
  idempotencyKey,
  operation,
  assetSha256,
  expectedTitle,
  expectedDescription,
  expectedTags,
  expectedInitialTitle,
} = {}) {
  const file = journalPath(idempotencyKey);
  const requestedIntent = {
    operation,
    assetSha256,
    expectedTitle,
    expectedDescription,
    expectedTags,
    expectedInitialTitle,
  };

  try {
    const previous = JSON.parse(await fs.readFile(file, 'utf8'));
    if (previous.idempotencyKey !== idempotencyKey
      || !youtubeVideoIntentMatches(previous, requestedIntent)) {
      fail('YOUTUBE_VIDEO_CONTENT_MISMATCH');
    }
    return { ...previous, alreadyAttempted: true, retrySent: false };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  if (!operation || !/^[a-f0-9]{64}$/.test(assetSha256 || '')
    || (operation === 'publish' && !Array.isArray(expectedTags))
    || (operation === 'create_draft' && typeof expectedInitialTitle !== 'string')) {
    fail('YOUTUBE_VIDEO_INTENT_INVALID');
  }

  const { store, ScopedSession } = await runtime();
  let envelope;
  try {
    envelope = JSON.parse(store.read(STORE));
  } catch {
    fail('YOUTUBE_VIDEO_ENVELOPE_MISSING');
  }
  const checked = validateYoutubeVideoEnvelope(envelope);
  if (envelope.operation !== operation
    || envelope.assetSha256 !== assetSha256
    || envelope.expectedTitle !== expectedTitle
    || envelope.expectedDescription !== expectedDescription
    || (operation === 'publish' && !sameArray(envelope.expectedTags, expectedTags))
    || (operation === 'create_draft' && envelope.expectedInitialTitle !== expectedInitialTitle)) {
    fail('YOUTUBE_VIDEO_CONTENT_MISMATCH');
  }

  const loaded = await loadYoutubeSession();
  const originalSession = loaded.session.toJSON();
  const session = ScopedSession.fromJSON({
    ...originalSession,
    headersByOrigin: {
      ...originalSession.headersByOrigin,
      [ORIGIN]: checked.headers,
    },
  });

  await fs.mkdir(path.dirname(file), { recursive: true });
  const claim = path.join(path.dirname(file), 'video-request-' + checked.requestSha256 + '.json');
  const claimHandle = await fs.open(claim, 'wx', 0o600)
    .catch(error => {
      if (error.code === 'EEXIST') fail('YOUTUBE_VIDEO_REQUEST_ALREADY_CLAIMED');
      throw error;
    });
  try {
    await claimHandle.writeFile(JSON.stringify({
      idempotencyKey,
      requestSha256: checked.requestSha256,
    }) + '\n');
  } finally {
    await claimHandle.close();
  }

  const record = {
    version: 1,
    idempotencyKey,
    operation,
    assetSha256,
    expectedTitle,
    expectedDescription,
    expectedTags: operation === 'publish' ? expectedTags : undefined,
    expectedInitialTitle: operation === 'create_draft' ? expectedInitialTitle : undefined,
    videoId: envelope.videoId,
    channelId: YOUTUBE_CHANNEL_ID,
    state: 'sending',
    writeCount: 1,
    requestSha256: checked.requestSha256,
    browserWriteBlocked: true,
    helperClosed: true,
    executionMode: 'browser_assisted_http',
    sentAt: new Date().toISOString(),
  };
  const recordHandle = await fs.open(file, 'wx', 0o600);
  try {
    await recordHandle.writeFile(JSON.stringify(record, null, 2) + '\n');
  } finally {
    await recordHandle.close();
  }
  store.write(STORE, JSON.stringify({ consumed: true, idempotencyKey }));

  try {
    validateYoutubeVideoEnvelope(envelope);
    const response = await session.request(envelope.request.url, {
      method: 'POST',
      body: envelope.request.body,
    });
    let data;
    try {
      data = JSON.parse(response.raw.toString('utf8'));
    } catch {
      data = null;
    }
    Object.assign(record, {
      httpStatus: response.status,
      responseKeys: Object.keys(data || {}),
      videoId: typeof data?.videoId === 'string' ? data.videoId : envelope.videoId ?? null,
      errorPresent: !!data?.error,
      state: response.status === 200 && !data?.error
        ? operation === 'publish'
          ? 'needs_readback'
          : data?.videoId ? 'draft_created_needs_readback' : 'needs_reconciliation'
        : 'needs_reconciliation',
    });
    if (data?.error) record.serviceErrorCode = data.error.code ?? null;

    try {
      await storeYoutubeSessionState(ScopedSession.fromJSON({
        ...session.toJSON(),
        headersByOrigin: originalSession.headersByOrigin,
      }));
    } catch {
      record.sessionPersistenceWarning = true;
    }
  } catch {
    record.state = 'needs_reconciliation';
    record.code = 'YOUTUBE_VIDEO_REQUEST_UNCONFIRMED';
  }

  await save(file, record);
  return { ...record, journalPath: file };
}

export function validateYoutubeVideoReadEnvelope(envelope, { now = Date.now() } = {}) {
  const age = now - Date.parse(envelope?.observedAt);
  if (envelope?.version !== 1
    || envelope.helperClosed !== true
    || envelope.responseStatus !== 200
    || envelope.channelId !== YOUTUBE_CHANNEL_ID
    || !/^[-\w]{11}$/.test(envelope.videoId || '')
    || !Number.isFinite(age)
    || age < -5000
    || age > 120000) fail('YOUTUBE_VIDEO_READ_INVALID');

  const { url, body } = parseRequest(envelope, 256000, 'YOUTUBE_VIDEO_READ_INVALID');
  if (url.pathname !== READ_PATH
    || !sameArray(body.videoIds, [envelope.videoId])
    || !validateContext(body)
    || Object.keys(body).some(key => !['context', 'failOnError', 'videoIds', 'mask', 'criticalRead'].includes(key))) {
    fail('YOUTUBE_VIDEO_READ_INVALID');
  }
  const headers = validateHeaders(envelope.request.headers, {
    refererPath: '/video/' + envelope.videoId + '/edit',
  });
  return { body, headers };
}

export async function stageYoutubeVideoRead(envelope) {
  validateYoutubeVideoReadEnvelope(envelope);
  const { store } = await runtime();
  const receipt = store.write(STORE + '-read', JSON.stringify(envelope));
  if (!receipt.persistent || receipt.provider !== 'Windows DPAPI CurrentUser') {
    fail('YOUTUBE_VIDEO_DPAPI_REQUIRED');
  }
  return { staged: true, operation: 'owner_video_read', helperClosed: true };
}

export function summarizeYoutubeVideoOwnerReadback(response, videoId) {
  const video = response?.videos?.find(item => item?.videoId === videoId);
  return {
    httpStatus: response?.httpStatus ?? null,
    videoId: video?.videoId ?? null,
    channelId: video?.channelId ?? null,
    title: video?.title ?? null,
    description: video?.description ?? null,
    privacy: video?.privacy ?? null,
    status: video?.status ?? null,
    responseStatus: video?.responseStatus?.statusCode ?? null,
    videoDurationMs: video?.videoDurationMs ?? null,
    originalFilename: video?.originalFilename ?? null,
    tags: Array.isArray(video?.tags) ? video.tags : null,
    paidProductPlacement: video?.paidProductPlacement ?? null,
    madeForKids: video?.mfkSettings ?? null,
    alteredContent: video?.alteredContentSettings ?? null,
  };
}

export function matchesYoutubeVideoOwnerReadback(record, readback) {
  const ownerVerified = readback?.httpStatus === 200
    && readback.videoId === record?.videoId
    && readback.channelId === record?.channelId
    && readback.responseStatus === 'CREATOR_ENTITY_STATUS_OK';
  if (!ownerVerified) return false;

  if (record.operation === 'publish') {
    const readbackTags = Array.isArray(readback.tags)
      ? readback.tags.map(tag => tag?.value)
      : null;
    const durationMatches = record.expectedDurationMs === undefined
      || readback.videoDurationMs === record.expectedDurationMs;
    return readback.title === record.expectedTitle
      && readback.description === record.expectedDescription
      && readback.privacy === 'VIDEO_PRIVACY_PUBLIC'
      && readback.status === 'VIDEO_STATUS_PROCESSED'
      && sameArray(readbackTags, record.expectedTags)
      && readback.paidProductPlacement === EXPECTED_PAID_PLACEMENT
      && readback.madeForKids?.effectiveMfk === EXPECTED_MADE_FOR_KIDS
      && readback.alteredContent?.creatorDisclosedHasAlteredContent === EXPECTED_ALTERED_CONTENT
      && durationMatches;
  }

  return record.operation === 'create_draft'
    && readback.privacy === 'VIDEO_PRIVACY_PRIVATE';
}

export function applyYoutubeVideoReadback(record, readback, checkedAt = new Date().toISOString()) {
  const matches = matchesYoutubeVideoOwnerReadback(record, readback);
  const wasVerified = record.readbackVerified === true
    && ['published_owner_verified', 'draft_owner_verified'].includes(record.state);
  const updated = { ...record };

  if (wasVerified) {
    updated.latestReadback = readback;
    updated.latestReadbackMatches = matches;
  } else {
    updated.readback = readback;
    updated.readbackVerified = matches;
    updated.latestReadbackMatches = matches;
  }

  updated.checkedAt = checkedAt;
  if (matches) {
    updated.state = record.operation === 'publish'
      ? 'published_owner_verified'
      : 'draft_owner_verified';
  } else if (!wasVerified) {
    updated.state = 'needs_reconciliation';
  }
  return updated;
}

export async function reconcileYoutubeVideo({ idempotencyKey } = {}) {
  const file = journalPath(idempotencyKey);
  const record = JSON.parse(await fs.readFile(file, 'utf8'));
  const { store, ScopedSession } = await runtime();
  let envelope;
  try {
    envelope = JSON.parse(store.read(STORE + '-read'));
  } catch {
    fail('YOUTUBE_VIDEO_READ_MISSING');
  }
  const { headers } = validateYoutubeVideoReadEnvelope(envelope);
  if (envelope.videoId !== record.videoId || envelope.channelId !== record.channelId) {
    fail('YOUTUBE_VIDEO_CONTENT_MISMATCH');
  }

  const loaded = await loadYoutubeSession();
  const originalSession = loaded.session.toJSON();
  const session = ScopedSession.fromJSON({
    ...originalSession,
    headersByOrigin: {
      ...originalSession.headersByOrigin,
      [ORIGIN]: headers,
    },
  });
  const response = await session.request(envelope.request.url, {
    method: 'POST',
    body: envelope.request.body,
  });
  let data;
  try {
    data = JSON.parse(response.raw.toString('utf8'));
  } catch {
    data = null;
  }

  const summary = summarizeYoutubeVideoOwnerReadback({
    ...(data || {}),
    httpStatus: response.status,
  }, record.videoId);
  const checkedRecord = applyYoutubeVideoReadback(
    record,
    data?.error ? { ...summary, httpStatus: 0 } : summary,
  );
  Object.assign(record, checkedRecord);

  try {
    await storeYoutubeSessionState(ScopedSession.fromJSON({
      ...session.toJSON(),
      headersByOrigin: originalSession.headersByOrigin,
    }));
  } catch {
    record.sessionPersistenceWarning = true;
  }
  await save(file, record);
  return record;
}
