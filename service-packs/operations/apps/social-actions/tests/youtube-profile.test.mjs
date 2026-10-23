import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateYoutubeProfileEnvelope } from '../youtube-profile.mjs';

const CHANNEL_ID = 'UCtLdZc1Ooz6KLbDNfo60E5A';
const ORIGIN = 'https://studio.youtube.com';
const WRITE_PATH = '/youtubei/v1/channel_edit/update_channel_page_settings';
const READ_PATH = '/youtubei/v1/channel_edit/get_channel_page_settings';
const now = Date.parse('2026-09-28T00:00:00.000Z');

const localized = original => ({ original, originalLanguage: 'ko_KR', messages: [] });
const context = () => ({
  client: { clientName: 62 },
  request: { reauthRequestInfo: { encodedReauthProofToken: 'test-reauth-proof' } },
  user: { delegationContext: { externalChannelId: CHANNEL_ID } },
});
const requestHeaders = () => ({
  authorization: 'SAPISIDHASH test-value',
  'content-type': 'application/json; charset=UTF-8',
  referer: `${ORIGIN}/channel/${CHANNEL_ID}/editing/profile`,
  origin: ORIGIN,
  'x-origin': ORIGIN,
  'x-youtube-client-name': '62',
});

function makeEnvelope({ write = true, body, url, observedAt, ...overrides } = {}) {
  const requestBody = body ?? (write ? {
    externalChannelId: CHANNEL_ID,
    context: context(),
    titleUpdate: { brandTitle: localized('생활이득AI연구소') },
    descriptionUpdate: { description: localized('AI로 비교한 생활 이득') },
    attestationResponseData: { challenge: 'test-challenge', webResponse: 'test-web-response' },
  } : { externalChannelId: CHANNEL_ID, context: context() });
  const envelope = {
    version: 1,
    channelId: CHANNEL_ID,
    observedAt: observedAt ?? new Date(now).toISOString(),
    helperClosed: true,
    request: {
      method: 'POST',
      url: `${ORIGIN}${url ?? (write ? WRITE_PATH : READ_PATH)}`,
      headers: requestHeaders(),
      body: JSON.stringify(requestBody),
    },
  };
  if (write) Object.assign(envelope, { browserWriteBlocked: true, blockedReason: 'inspector', responseReceived: false });
  else envelope.responseStatus = 200;
  return Object.assign(envelope, overrides);
}

function bodyOf(envelope) {
  return JSON.parse(envelope.request.body);
}

function rejectsWith(code, envelope, options = { now }) {
  assert.throws(() => validateYoutubeProfileEnvelope(envelope, options), error => error.code === code);
}

test('accepts observed title and description mutation with native proof and browser-block provenance', () => {
  const envelope = makeEnvelope();
  const checked = validateYoutubeProfileEnvelope(envelope, { now });
  assert.equal(checked.write, true);
  assert.equal(checked.body.titleUpdate.brandTitle.original, '생활이득AI연구소');
  assert.equal(checked.body.descriptionUpdate.description.original, 'AI로 비교한 생활 이득');
  assert.match(checked.requestSha256, /^[a-f0-9]{64}$/);
});

test('accepts the native avatarImageUpdate encryptedBlobId shape', () => {
  const envelope = makeEnvelope({ body: {
    externalChannelId: CHANNEL_ID,
    context: context(),
    avatarImageUpdate: { encryptedBlobId: 'encrypted_blob_id_from_observed_upload' },
    attestationResponseData: { challenge: 'test-challenge', webResponse: 'test-web-response' },
  } });
  const checked = validateYoutubeProfileEnvelope(envelope, { now });
  assert.deepEqual(checked.body.avatarImageUpdate, { encryptedBlobId: 'encrypted_blob_id_from_observed_upload' });
  assert.equal(checked.write, true);
});

test('rejects an avatar body with unsupported fields or an empty blob id', () => {
  const base = {
    externalChannelId: CHANNEL_ID,
    context: context(),
    attestationResponseData: { challenge: 'test-challenge', webResponse: 'test-web-response' },
  };
  rejectsWith('YOUTUBE_PROFILE_AVATAR_INVALID', makeEnvelope({ body: {
    ...base,
    avatarImageUpdate: { encryptedBlobId: 'encrypted-blob', delete: {} },
  } }));
  rejectsWith('YOUTUBE_PROFILE_AVATAR_INVALID', makeEnvelope({ body: {
    ...base,
    avatarImageUpdate: { encryptedBlobId: '' },
  } }));
  rejectsWith('YOUTUBE_PROFILE_AVATAR_INVALID', makeEnvelope({ body: {
    ...base,
    avatarImageUpdate: { encryptedBlobId: 'x'.repeat(16385) },
  } }));
});

test('rejects a mismatched channel target at the envelope and request levels', () => {
  rejectsWith('YOUTUBE_PROFILE_ENVELOPE_INVALID', makeEnvelope({ channelId: 'UC-other' }));
  const bodyTarget = bodyOf(makeEnvelope());
  bodyTarget.externalChannelId = 'UC-other';
  rejectsWith('YOUTUBE_PROFILE_REQUEST_INVALID', makeEnvelope({ body: bodyTarget }));
  const delegatedTarget = bodyOf(makeEnvelope());
  delegatedTarget.context.user.delegationContext.externalChannelId = 'UC-other';
  rejectsWith('YOUTUBE_PROFILE_REQUEST_INVALID', makeEnvelope({ body: delegatedTarget }));
});

test('rejects non-Studio URLs, routes, and methods', () => {
  rejectsWith('YOUTUBE_PROFILE_REQUEST_INVALID', makeEnvelope({ url: `https://www.youtube.com${WRITE_PATH}` }));
  rejectsWith('YOUTUBE_PROFILE_REQUEST_INVALID', makeEnvelope({ url: '/youtubei/v1/channel_edit/other' }));
  const envelope = makeEnvelope();
  envelope.request.method = 'PUT';
  rejectsWith('YOUTUBE_PROFILE_REQUEST_INVALID', envelope);
});

test('enforces the captured request age and helper closure', () => {
  const fresh = makeEnvelope({ observedAt: new Date(now - 120000).toISOString() });
  assert.equal(validateYoutubeProfileEnvelope(fresh, { now }).write, true);
  rejectsWith('YOUTUBE_PROFILE_ENVELOPE_INVALID', makeEnvelope({ observedAt: new Date(now - 120001).toISOString() }));
  rejectsWith('YOUTUBE_PROFILE_ENVELOPE_INVALID', makeEnvelope({ observedAt: new Date(now + 5001).toISOString() }));
  rejectsWith('YOUTUBE_PROFILE_ENVELOPE_INVALID', makeEnvelope({ helperClosed: false }));
});

test('requires a browser-blocked write receipt before sending', () => {
  rejectsWith('YOUTUBE_PROFILE_BROWSER_WRITE_NOT_BLOCKED', makeEnvelope({ browserWriteBlocked: false }));
  rejectsWith('YOUTUBE_PROFILE_BROWSER_WRITE_NOT_BLOCKED', makeEnvelope({ blockedReason: 'other' }));
  rejectsWith('YOUTUBE_PROFILE_BROWSER_WRITE_NOT_BLOCKED', makeEnvelope({ responseReceived: true }));
});

test('rejects unknown mutation fields and malformed localized fields', () => {
  const withExtra = bodyOf(makeEnvelope());
  withExtra.videoId = 'unrelated';
  rejectsWith('YOUTUBE_PROFILE_UPDATE_SCOPE', makeEnvelope({ body: withExtra }));
  const badLocale = bodyOf(makeEnvelope());
  badLocale.titleUpdate.brandTitle.originalLanguage = 'en_US';
  rejectsWith('YOUTUBE_PROFILE_LOCALIZED_TEXT_INVALID', makeEnvelope({ body: badLocale }));
});

test('requires native challenge and reauth proofs for title and avatar writes', () => {
  const noAttestation = bodyOf(makeEnvelope());
  delete noAttestation.attestationResponseData;
  rejectsWith('YOUTUBE_PROFILE_NATIVE_PROOF_MISSING', makeEnvelope({ body: noAttestation }));
  const noReauth = bodyOf(makeEnvelope());
  delete noReauth.context.request.reauthRequestInfo;
  rejectsWith('YOUTUBE_PROFILE_NATIVE_PROOF_MISSING', makeEnvelope({ body: noReauth }));
});

test('accepts a scoped owner read only with observed HTTP 200 provenance', () => {
  const envelope = makeEnvelope({ write: false });
  const checked = validateYoutubeProfileEnvelope(envelope, { now });
  assert.equal(checked.write, false);
  assert.equal(checked.body.externalChannelId, CHANNEL_ID);
  assert.equal(checked.requestSha256, createHash('sha256').update(envelope.request.body).digest('hex'));
  rejectsWith('YOUTUBE_PROFILE_READ_PROVENANCE_INVALID', makeEnvelope({ write: false, responseStatus: 204 }));
  const extra = { externalChannelId: CHANNEL_ID, context: context(), videoIds: ['unrelated'] };
  rejectsWith('YOUTUBE_PROFILE_READ_PROVENANCE_INVALID', makeEnvelope({ write: false, body: extra }));
});

test('rejects unapproved or duplicate headers', () => {
  const extra = makeEnvelope();
  extra.request.headers.cookie = 'session-cookie';
  rejectsWith('YOUTUBE_PROFILE_HEADERS_INVALID', extra);
  const duplicateCase = makeEnvelope();
  duplicateCase.request.headers.Authorization = 'SAPISIDHASH second-value';
  rejectsWith('YOUTUBE_PROFILE_HEADERS_INVALID', duplicateCase);
});
