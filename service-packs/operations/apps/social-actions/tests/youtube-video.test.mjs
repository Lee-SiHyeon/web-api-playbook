import test from 'node:test';
import assert from 'node:assert/strict';
import { YOUTUBE_CHANNEL_ID } from '../lib/youtube-auth-session.mjs';
import {
  applyYoutubeVideoReadback,
  matchesYoutubeVideoOwnerReadback,
  summarizeYoutubeVideoOwnerReadback,
  validateYoutubeVideoEnvelope,
  validateYoutubeVideoReadEnvelope,
  youtubeVideoIntentMatches,
} from '../youtube-video.mjs';

const VIDEO_ID = 'RBlvPBD7bcY';
const ASSET_SHA = 'a'.repeat(64);
const TITLE = 'A captured title';
const DESCRIPTION = 'A captured description';
const TAGS = ['틱톡', '앱테크'];
const NOW = Date.now();

function context() {
  return {
    client: { clientName: 62 },
    user: { delegationContext: { externalChannelId: YOUTUBE_CHANNEL_ID } },
  };
}

function headers(referer) {
  return {
    authorization: 'SAPISIDHASH test-only-placeholder',
    'content-type': 'application/json; charset=UTF-8',
    referer,
    'x-origin': 'https://studio.youtube.com',
    'x-youtube-client-name': '62',
  };
}

function writeEnvelope({ operation = 'publish', mutateBody, mutateEnvelope, bodyExtra } = {}) {
  const common = {
    version: 1,
    observedAt: new Date(NOW).toISOString(),
    channelId: YOUTUBE_CHANNEL_ID,
    helperClosed: true,
    browserWriteBlocked: true,
    blockedReason: 'inspector',
    responseReceived: false,
    operation,
    videoId: VIDEO_ID,
    assetSha256: ASSET_SHA,
    expectedTitle: TITLE,
    expectedDescription: DESCRIPTION,
    expectedTags: TAGS,
    expectedInitialTitle: TITLE,
  };
  const body = operation === 'publish'
    ? {
      encryptedVideoId: VIDEO_ID,
      videoReadMask: { title: true },
      flowType: 'VIDEO_MANAGER_FLOW_TYPE_DEFAULT',
      title: { newTitle: TITLE },
      description: { newDescription: DESCRIPTION },
      privacyState: { newPrivacy: 'PUBLIC' },
      draftState: { operation: 'MDE_DRAFT_STATE_UPDATE_OPERATION_REMOVE_DRAFT_STATE' },
      tags: { newTags: [...TAGS] },
      madeForKids: {
        operation: 'MDE_MADE_FOR_KIDS_UPDATE_OPERATION_SET',
        newMfk: 'MDE_MADE_FOR_KIDS_TYPE_NOT_MFK',
      },
      alteredContent: {
        operation: 'MDE_ALTERED_CONTENT_UPDATE_OPERATION_SET',
        newCreatorDisclosedHasAlteredContent: 'MDE_HAS_ALTERED_CONTENT_YES',
      },
      productPlacement: {
        newHasPaidProductPlacement: true,
        newShowPaidProductPlacementOverlay: true,
        newIsPaidProductPlacementSelfDeclaredDefinitive: true,
      },
      context: context(),
      attestationResponseData: { challenge: 'test-challenge', webResponse: 'test-proof' },
      ...bodyExtra,
    }
    : {
      channelId: YOUTUBE_CHANNEL_ID,
      resourceId: { scottyResourceId: { id: 'test-resource-id' } },
      frontendUploadId: 'test-upload-id',
      initialMetadata: {
        title: { newTitle: TITLE },
        privacy: { newPrivacy: 'PRIVATE' },
        draftState: { isDraft: true },
      },
      context: context(),
      presumedShort: true,
      ...bodyExtra,
    };
  mutateBody?.(body);
  const urlPath = operation === 'publish'
    ? '/youtubei/v1/video_manager/metadata_update'
    : '/youtubei/v1/upload/createvideo';
  const referer = operation === 'publish'
    ? 'https://studio.youtube.com/video/' + VIDEO_ID + '/edit'
    : 'https://studio.youtube.com/channel/' + YOUTUBE_CHANNEL_ID + '/videos/upload';
  const envelope = {
    ...common,
    request: {
      method: 'POST',
      url: 'https://studio.youtube.com' + urlPath,
      headers: headers(referer),
      body: JSON.stringify(body),
    },
  };
  mutateEnvelope?.(envelope);
  return envelope;
}

function readEnvelope() {
  const body = {
    context: context(),
    failOnError: true,
    videoIds: [VIDEO_ID],
    mask: { title: true },
    criticalRead: true,
  };
  return {
    version: 1,
    observedAt: new Date(NOW).toISOString(),
    channelId: YOUTUBE_CHANNEL_ID,
    videoId: VIDEO_ID,
    responseStatus: 200,
    helperClosed: true,
    request: {
      method: 'POST',
      url: 'https://studio.youtube.com/youtubei/v1/creator/get_creator_videos',
      headers: headers('https://studio.youtube.com/video/' + VIDEO_ID + '/edit'),
      body: JSON.stringify(body),
    },
  };
}

function verifiedRecord() {
  return {
    operation: 'publish',
    assetSha256: ASSET_SHA,
    expectedTitle: TITLE,
    expectedDescription: DESCRIPTION,
    expectedTags: [...TAGS],
    expectedDurationMs: 33133,
    videoId: VIDEO_ID,
    channelId: YOUTUBE_CHANNEL_ID,
    state: 'published_owner_verified',
    readbackVerified: true,
    readback: { httpStatus: 200, videoId: VIDEO_ID, privacy: 'VIDEO_PRIVACY_PUBLIC' },
  };
}

function ownerReadback() {
  return {
    httpStatus: 200,
    videoId: VIDEO_ID,
    channelId: YOUTUBE_CHANNEL_ID,
    title: TITLE,
    description: DESCRIPTION,
    privacy: 'VIDEO_PRIVACY_PUBLIC',
    status: 'VIDEO_STATUS_PROCESSED',
    responseStatus: 'CREATOR_ENTITY_STATUS_OK',
    videoDurationMs: 33133,
    originalFilename: null,
    tags: TAGS.map(value => ({ value })),
    paidProductPlacement: 'VIDEO_PAID_PRODUCT_PLACEMENT_NOTIFY',
    madeForKids: { effectiveMfk: 'VIDEO_MADE_FOR_KIDS_NOT_MFK' },
    alteredContent: { creatorDisclosedHasAlteredContent: 'VIDEO_HAS_ALTERED_CONTENT_YES' },
  };
}

test('accepts fresh captured publish and private-draft contracts', () => {
  assert.equal(validateYoutubeVideoEnvelope(writeEnvelope(), { now: NOW }).body.encryptedVideoId, VIDEO_ID);
  assert.equal(validateYoutubeVideoEnvelope(writeEnvelope({ operation: 'create_draft' }), { now: NOW }).body.channelId,
    YOUTUBE_CHANNEL_ID);
});

test('rejects stale, unclosed, or unblocked browser captures', () => {
  const stale = writeEnvelope();
  stale.observedAt = new Date(NOW - 120001).toISOString();
  assert.throws(() => validateYoutubeVideoEnvelope(stale, { now: NOW }), { code: 'YOUTUBE_VIDEO_PROVENANCE_INVALID' });

  const notClosed = writeEnvelope();
  notClosed.helperClosed = false;
  assert.throws(() => validateYoutubeVideoEnvelope(notClosed, { now: NOW }), { code: 'YOUTUBE_VIDEO_PROVENANCE_INVALID' });

  const notBlocked = writeEnvelope();
  notBlocked.browserWriteBlocked = false;
  assert.throws(() => validateYoutubeVideoEnvelope(notBlocked, { now: NOW }), { code: 'YOUTUBE_VIDEO_PROVENANCE_INVALID' });
});

test('rejects target mismatch, unsupported route, and unobserved body fields', () => {
  const wrongTarget = writeEnvelope();
  wrongTarget.channelId = 'UC0000000000000000000000';
  assert.throws(() => validateYoutubeVideoEnvelope(wrongTarget, { now: NOW }), { code: 'YOUTUBE_VIDEO_PROVENANCE_INVALID' });

  const wrongRoute = writeEnvelope();
  wrongRoute.request.url = 'https://www.youtube.com/youtubei/v1/video_manager/metadata_update';
  assert.throws(() => validateYoutubeVideoEnvelope(wrongRoute, { now: NOW }), { code: 'YOUTUBE_VIDEO_REQUEST_INVALID' });

  const extraField = writeEnvelope({ bodyExtra: { visibilityOverride: true } });
  assert.throws(() => validateYoutubeVideoEnvelope(extraField, { now: NOW }), { code: 'YOUTUBE_VIDEO_PUBLISH_SCOPE_INVALID' });
});

test('rejects tags, paid-placement, made-for-kids, altered-content, or proof mismatches', () => {
  const wrongTags = writeEnvelope({ mutateBody: body => { body.tags.newTags = ['changed']; } });
  assert.throws(() => validateYoutubeVideoEnvelope(wrongTags, { now: NOW }), { code: 'YOUTUBE_VIDEO_PUBLISH_SCOPE_INVALID' });

  const missingPaidPlacement = writeEnvelope({ mutateBody: body => { body.productPlacement.newShowPaidProductPlacementOverlay = false; } });
  assert.throws(() => validateYoutubeVideoEnvelope(missingPaidPlacement, { now: NOW }), { code: 'YOUTUBE_VIDEO_PUBLISH_SCOPE_INVALID' });

  const wrongMfk = writeEnvelope({ mutateBody: body => { body.madeForKids.newMfk = 'MDE_MADE_FOR_KIDS_TYPE_MFK'; } });
  assert.throws(() => validateYoutubeVideoEnvelope(wrongMfk, { now: NOW }), { code: 'YOUTUBE_VIDEO_PUBLISH_SCOPE_INVALID' });

  const wrongAlteredContent = writeEnvelope({ mutateBody: body => { body.alteredContent.newCreatorDisclosedHasAlteredContent = 'MDE_HAS_ALTERED_CONTENT_NO'; } });
  assert.throws(() => validateYoutubeVideoEnvelope(wrongAlteredContent, { now: NOW }), { code: 'YOUTUBE_VIDEO_PUBLISH_SCOPE_INVALID' });

  const missingNativeProof = writeEnvelope({ mutateBody: body => { delete body.attestationResponseData.webResponse; } });
  assert.throws(() => validateYoutubeVideoEnvelope(missingNativeProof, { now: NOW }), { code: 'YOUTUBE_VIDEO_PUBLISH_SCOPE_INVALID' });
});

test('rejects unsafe header names and wrong publish referer', () => {
  const unexpectedHeader = writeEnvelope();
  unexpectedHeader.request.headers.cookie = 'session-secret';
  assert.throws(() => validateYoutubeVideoEnvelope(unexpectedHeader, { now: NOW }), { code: 'YOUTUBE_VIDEO_HEADERS_INVALID' });

  const wrongReferer = writeEnvelope();
  wrongReferer.request.headers.referer = 'https://studio.youtube.com/video/anotherid/edit';
  assert.throws(() => validateYoutubeVideoEnvelope(wrongReferer, { now: NOW }), { code: 'YOUTUBE_VIDEO_HEADERS_INVALID' });
});

test('accepts only a fresh owner read bound to the same video and channel', () => {
  assert.deepEqual(validateYoutubeVideoReadEnvelope(readEnvelope(), { now: NOW }).body.videoIds, [VIDEO_ID]);

  const wrongIds = readEnvelope();
  wrongIds.request.body = JSON.stringify({ context: context(), videoIds: ['abcdefghijk'] });
  assert.throws(() => validateYoutubeVideoReadEnvelope(wrongIds, { now: NOW }), { code: 'YOUTUBE_VIDEO_READ_INVALID' });

  const wrongChannel = readEnvelope();
  wrongChannel.request.body = JSON.stringify({
    context: { client: { clientName: 62 }, user: { delegationContext: { externalChannelId: 'UC0000000000000000000000' } } },
    videoIds: [VIDEO_ID],
  });
  assert.throws(() => validateYoutubeVideoReadEnvelope(wrongChannel, { now: NOW }), { code: 'YOUTUBE_VIDEO_READ_INVALID' });
});

test('idempotency requires the same operation, asset, title, description, and tags', () => {
  const prior = {
    operation: 'publish', assetSha256: ASSET_SHA, expectedTitle: TITLE,
    expectedDescription: DESCRIPTION, expectedTags: [...TAGS],
  };
  const sameIntent = {
    operation: 'publish', assetSha256: ASSET_SHA, expectedTitle: TITLE,
    expectedDescription: DESCRIPTION, expectedTags: [...TAGS],
  };
  assert.equal(youtubeVideoIntentMatches(prior, sameIntent), true);
  assert.equal(youtubeVideoIntentMatches(prior, { ...sameIntent, expectedTags: ['different'] }), false);
  assert.equal(youtubeVideoIntentMatches(prior, { ...sameIntent, expectedTitle: 'different' }), false);
  assert.equal(youtubeVideoIntentMatches(prior, { ...sameIntent, operation: 'create_draft' }), false);
  assert.equal(youtubeVideoIntentMatches(prior, { ...sameIntent, expectedTags: undefined }), false);
});

test('owner readback requires public/processed state, exact tags, paid disclosure, and AI disclosures', () => {
  const record = verifiedRecord();
  const good = ownerReadback();
  assert.equal(matchesYoutubeVideoOwnerReadback(record, good), true);

  for (const changed of [
    { tags: [{ value: 'wrong' }] },
    { paidProductPlacement: 'VIDEO_PAID_PRODUCT_PLACEMENT_NO' },
    { madeForKids: { effectiveMfk: 'VIDEO_MADE_FOR_KIDS_MFK' } },
    { alteredContent: { creatorDisclosedHasAlteredContent: 'VIDEO_HAS_ALTERED_CONTENT_NO' } },
    { status: 'VIDEO_STATUS_FAILED' },
    { videoDurationMs: 33132 },
  ]) {
    assert.equal(matchesYoutubeVideoOwnerReadback(record, { ...good, ...changed }), false);
  }
});

test('owner readback summary preserves the captured metadata and disclosure fields', () => {
  const source = ownerReadback();
  const summarized = summarizeYoutubeVideoOwnerReadback({
    videos: [{
      videoId: VIDEO_ID,
      channelId: YOUTUBE_CHANNEL_ID,
      title: TITLE,
      description: DESCRIPTION,
      privacy: 'VIDEO_PRIVACY_PUBLIC',
      status: 'VIDEO_STATUS_PROCESSED',
      responseStatus: { statusCode: 'CREATOR_ENTITY_STATUS_OK' },
      videoDurationMs: 33133,
      tags: TAGS.map(value => ({ value })),
      paidProductPlacement: 'VIDEO_PAID_PRODUCT_PLACEMENT_NOTIFY',
      mfkSettings: { effectiveMfk: 'VIDEO_MADE_FOR_KIDS_NOT_MFK' },
      alteredContentSettings: { creatorDisclosedHasAlteredContent: 'VIDEO_HAS_ALTERED_CONTENT_YES' },
    }],
    httpStatus: 200,
  }, VIDEO_ID);
  assert.deepEqual(summarized, source);
});

test('a later mismatching readback cannot erase a prior verified receipt', () => {
  const record = verifiedRecord();
  const savedReadback = record.readback;
  const changed = applyYoutubeVideoReadback(
    record,
    { ...ownerReadback(), title: 'Different title' },
    '2026-09-28T01:00:00.000Z',
  );
  assert.equal(changed.state, 'published_owner_verified');
  assert.equal(changed.readbackVerified, true);
  assert.strictEqual(changed.readback, savedReadback);
  assert.equal(changed.latestReadback.title, 'Different title');
  assert.equal(changed.latestReadbackMatches, false);
});

test('a first matching readback creates an owner-verified receipt', () => {
  const record = {
    operation: 'publish', assetSha256: ASSET_SHA, expectedTitle: TITLE,
    expectedDescription: DESCRIPTION, expectedTags: [...TAGS],
    expectedDurationMs: 33133, videoId: VIDEO_ID, channelId: YOUTUBE_CHANNEL_ID,
    state: 'needs_readback', writeCount: 1,
  };
  const checked = applyYoutubeVideoReadback(record, ownerReadback(), '2026-09-28T01:00:00.000Z');
  assert.equal(checked.state, 'published_owner_verified');
  assert.equal(checked.readbackVerified, true);
  assert.equal(checked.latestReadbackMatches, true);
});
