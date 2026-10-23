import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { webApiPlaybookRoot } from '../affiliate-api-hub/adapters/web-auth-provider.mjs';
import { loadYoutubeSession, storeYoutubeSessionState, YOUTUBE_CHANNEL_ID } from './lib/youtube-auth-session.mjs';

const ORIGIN = 'https://studio.youtube.com';
const WRITE_PATH = '/youtubei/v1/channel_edit/update_channel_page_settings';
const READ_PATH = '/youtubei/v1/channel_edit/get_channel_page_settings';
const STORE = 'youtube-profile-native-v1';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const hash = value => createHash('sha256').update(value).digest('hex');
const HEADERS = new Set(['authorization', 'content-type', 'referer', 'origin', 'user-agent', 'x-goog-authuser',
  'x-goog-visitor-id', 'x-origin', 'x-youtube-ad-signals', 'x-youtube-client-name', 'x-youtube-client-version',
  'x-youtube-delegation-context', 'x-youtube-page-cl', 'x-youtube-page-label', 'x-youtube-time-zone', 'x-youtube-utc-offset',
  'sec-ch-ua', 'sec-ch-ua-arch', 'sec-ch-ua-bitness', 'sec-ch-ua-form-factors', 'sec-ch-ua-full-version',
  'sec-ch-ua-full-version-list', 'sec-ch-ua-mobile', 'sec-ch-ua-model', 'sec-ch-ua-platform', 'sec-ch-ua-platform-version', 'sec-ch-ua-wow64']);

async function runtime() {
  const root = webApiPlaybookRoot();
  const [{ ProtectedStore }, { ScopedSession }] = await Promise.all([
    import(pathToFileURL(path.join(root, 'lib/protected-store.mjs')).href),
    import(pathToFileURL(path.join(root, 'lib/scoped-session.mjs')).href),
  ]);
  return { store: new ProtectedStore(), ScopedSession };
}

export function validateYoutubeProfileEnvelope(envelope, { now = Date.now() } = {}) {
  const age = now - Date.parse(envelope?.observedAt);
  if (envelope?.version !== 1 || envelope.channelId !== YOUTUBE_CHANNEL_ID || envelope.helperClosed !== true
    || !Number.isFinite(age) || age < -5000 || age > 120000) fail('YOUTUBE_PROFILE_ENVELOPE_INVALID');
  const request = envelope.request;
  let url, body;
  try { url = new URL(request.url); body = JSON.parse(request.body); } catch { fail('YOUTUBE_PROFILE_REQUEST_INVALID'); }
  if (request.method !== 'POST' || url.origin !== ORIGIN || ![WRITE_PATH, READ_PATH].includes(url.pathname)
    || url.username || url.password || url.hash || typeof request.body !== 'string'
    || Buffer.byteLength(request.body) > 128 * 1024 || body.externalChannelId !== YOUTUBE_CHANNEL_ID
    || body.context?.client?.clientName !== 62
    || body.context?.user?.delegationContext?.externalChannelId !== YOUTUBE_CHANNEL_ID) fail('YOUTUBE_PROFILE_REQUEST_INVALID');
  const write = url.pathname === WRITE_PATH;
  if (write) {
    if (envelope.browserWriteBlocked !== true || envelope.blockedReason !== 'inspector'
      || envelope.responseReceived !== false) fail('YOUTUBE_PROFILE_BROWSER_WRITE_NOT_BLOCKED');
    const allowed = new Set(['externalChannelId', 'context', 'titleUpdate', 'descriptionUpdate', 'avatarImageUpdate', 'attestationResponseData']);
    if (Object.keys(body).some(k => !allowed.has(k)) || (!body.titleUpdate && !body.descriptionUpdate && !body.avatarImageUpdate)) fail('YOUTUBE_PROFILE_UPDATE_SCOPE');
    if (body.avatarImageUpdate && (Object.keys(body.avatarImageUpdate).join(',') !== 'encryptedBlobId'
      || typeof body.avatarImageUpdate.encryptedBlobId !== 'string' || !body.avatarImageUpdate.encryptedBlobId
      || body.avatarImageUpdate.encryptedBlobId.length > 16384)) fail('YOUTUBE_PROFILE_AVATAR_INVALID');
    for (const text of [body.titleUpdate?.brandTitle, body.descriptionUpdate?.description].filter(Boolean)) {
      if (typeof text.original !== 'string' || text.originalLanguage !== 'ko_KR' || !Array.isArray(text.messages)) fail('YOUTUBE_PROFILE_LOCALIZED_TEXT_INVALID');
    }
    if ((body.titleUpdate || body.avatarImageUpdate) && (!body.attestationResponseData?.challenge || !body.attestationResponseData?.webResponse
      || !body.context?.request?.reauthRequestInfo?.encodedReauthProofToken)) fail('YOUTUBE_PROFILE_NATIVE_PROOF_MISSING');
  } else if (envelope.responseStatus !== 200 || Object.keys(body).some(k => !['externalChannelId', 'context'].includes(k))) {
    fail('YOUTUBE_PROFILE_READ_PROVENANCE_INVALID');
  }
  const headers = {};
  if (!request.headers || typeof request.headers !== 'object' || Array.isArray(request.headers)) fail('YOUTUBE_PROFILE_HEADERS_INVALID');
  for (const [rawName, value] of Object.entries(request.headers)) {
    const name = rawName.toLowerCase();
    if (!HEADERS.has(name) || Object.hasOwn(headers, name) || typeof value !== 'string'
      || /[\r\n\0]/.test(value) || value.length > 16384) fail('YOUTUBE_PROFILE_HEADERS_INVALID');
    headers[name] = value;
  }
  if (!headers.authorization?.startsWith('SAPISIDHASH ') || headers['x-origin'] !== ORIGIN
    || headers['x-youtube-client-name'] !== '62' || !/^application\/json(?:;|$)/i.test(headers['content-type'] || '')
    || headers.referer !== `${ORIGIN}/channel/${YOUTUBE_CHANNEL_ID}/editing/profile`) fail('YOUTUBE_PROFILE_HEADERS_INVALID');
  return { write, body, headers, requestSha256: hash(request.body) };
}

export async function stageYoutubeProfile(envelope) {
  const checked = validateYoutubeProfileEnvelope(envelope);
  const { store } = await runtime();
  const saved = store.write(STORE + (checked.write ? '-write' : '-read'), JSON.stringify(envelope));
  if (!saved.persistent || saved.provider !== 'Windows DPAPI CurrentUser') fail('YOUTUBE_DPAPI_REQUIRED');
  return { staged: true, operation: checked.write ? 'profile_update' : 'profile_read', provider: saved.provider, helperClosed: true };
}

async function loadEnvelope(write) {
  const { store, ScopedSession } = await runtime();
  let envelope;
  try { envelope = JSON.parse(store.read(STORE + (write ? '-write' : '-read'))); } catch { fail('YOUTUBE_PROFILE_ENVELOPE_MISSING'); }
  const checked = validateYoutubeProfileEnvelope(envelope);
  if (checked.write !== write) fail('YOUTUBE_PROFILE_UPDATE_SCOPE');
  const loaded = await loadYoutubeSession();
  const original = loaded.session.toJSON();
  const session = ScopedSession.fromJSON({ ...original, headersByOrigin: { ...original.headersByOrigin, [ORIGIN]: checked.headers } });
  return { envelope, checked, session, original, store, ScopedSession };
}

async function requestOnce(loaded) {
  validateYoutubeProfileEnvelope(loaded.envelope);
  const response = await loaded.session.request(loaded.envelope.request.url, { method: 'POST', body: loaded.envelope.request.body });
  let data;
  try { data = JSON.parse(response.raw.toString('utf8')); } catch { data = null; }
  // Never print raw responses: context can contain rotated session/proof tokens.
  try {
    const state = loaded.session.toJSON();
    await storeYoutubeSessionState(loaded.ScopedSession.fromJSON({ ...state, headersByOrigin: loaded.original.headersByOrigin }));
  } catch { /* The operation receipt/readback still must be recorded if local persistence failed. */ }
  return { response, data };
}

export function summarizeYoutubeProfile(data) {
  const profile = data?.channelPageSettingsData;
  return { rootKeys: Object.keys(data || {}), profileKeys: Object.keys(profile || {}),
    channelId: profile?.externalChannelId ?? null,
    title: profile?.brandTitle?.original ?? null,
    description: profile?.description?.original ?? null,
    statusCode: profile?.status?.statusCode ?? null,
    handle: profile?.handle?.handle ?? null,
    titleWriteable: profile?.titleWriteable ?? null,
    translatedNameCount: profile?.brandTitle?.messages?.length ?? null,
    avatarUrlSha256: profile?.userSetProfilePicture?.fifeUrl ? hash(profile.userSetProfilePicture.fifeUrl) : null };
}

export async function readYoutubeProfile() {
  const loaded = await loadEnvelope(false);
  const { response, data } = await requestOnce(loaded);
  return { httpStatus: response.status, ...summarizeYoutubeProfile(data), errorPresent: !!data?.error,
    observedAt: new Date().toISOString(), executionMode: 'browser_assisted_http' };
}

function recordPath(key) {
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(key || '') || !process.env.LOCALAPPDATA) fail('YOUTUBE_PROFILE_JOB_INVALID');
  return path.join(process.env.LOCALAPPDATA, 'affiliate-content-operations', 'youtube', 'journal', key + '.json');
}

async function saveRecord(file, record) {
  const tmp = file + '.' + process.pid + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await fs.rename(tmp, file);
}

export async function sendYoutubeProfile({ idempotencyKey, expectedTitle, expectedDescription, expectedAvatarBlobSha256, avatarAssetSha256 } = {}) {
  const file = recordPath(idempotencyKey);
  try { const previous = JSON.parse(await fs.readFile(file, 'utf8'));
    if (previous.expectedTitle !== expectedTitle || previous.expectedDescription !== expectedDescription
      || previous.expectedAvatarBlobSha256 !== expectedAvatarBlobSha256 || previous.avatarAssetSha256 !== avatarAssetSha256) fail('YOUTUBE_PROFILE_CONTENT_MISMATCH');
    return { ...previous, alreadyAttempted: true, retrySent: false }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const loaded = await loadEnvelope(true);
  const body = loaded.checked.body;
  if ((body.titleUpdate && body.titleUpdate.brandTitle?.original !== expectedTitle)
    || (body.descriptionUpdate && body.descriptionUpdate.description?.original !== expectedDescription)
    || (!body.titleUpdate && expectedTitle !== undefined) || (!body.descriptionUpdate && expectedDescription !== undefined)) fail('YOUTUBE_PROFILE_CONTENT_MISMATCH');
  if (body.avatarImageUpdate ? (!/^[a-f0-9]{64}$/.test(avatarAssetSha256 || '')
    || hash(body.avatarImageUpdate.encryptedBlobId) !== expectedAvatarBlobSha256)
    : expectedAvatarBlobSha256 !== undefined || avatarAssetSha256 !== undefined) fail('YOUTUBE_PROFILE_CONTENT_MISMATCH');
  // Reconcile the existing target before an update, using the captured owner-only read.
  const before = await readYoutubeProfile();
  if (before.httpStatus !== 200 || before.channelId !== YOUTUBE_CHANNEL_ID || before.errorPresent
    || before.statusCode !== 'CREATOR_ENTITY_STATUS_OK') fail('YOUTUBE_PROFILE_OWNER_NOT_VERIFIED');
  if (!body.avatarImageUpdate && (!body.titleUpdate || before.title === expectedTitle) && (!body.descriptionUpdate || before.description === expectedDescription)) return { state: 'already_applied', writeCount: 0, before };
  validateYoutubeProfileEnvelope(loaded.envelope);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const claim = path.join(path.dirname(file), 'native-request-' + loaded.checked.requestSha256 + '.json');
  const lock = await fs.open(claim, 'wx', 0o600).catch(error => { if (error.code === 'EEXIST') fail('YOUTUBE_PROFILE_REQUEST_ALREADY_CLAIMED'); throw error; });
  try { await lock.writeFile(JSON.stringify({ idempotencyKey, requestSha256: loaded.checked.requestSha256 }) + '\n'); } finally { await lock.close(); }
  const record = { version: 1, idempotencyKey, channelId: YOUTUBE_CHANNEL_ID, state: 'sending', writeCount: 1,
    requestSha256: loaded.checked.requestSha256, expectedTitle, expectedDescription, expectedAvatarBlobSha256, avatarAssetSha256, before,
    sentAt: new Date().toISOString(), browserWriteBlocked: true, helperClosed: true, executionMode: 'browser_assisted_http' };
  const h = await fs.open(file, 'wx', 0o600);
  try { await h.writeFile(JSON.stringify(record, null, 2) + '\n'); } finally { await h.close(); }
  loaded.store.write(STORE + '-write', JSON.stringify({ consumed: true, idempotencyKey }));
  try {
    const { response, data } = await requestOnce(loaded);
    record.httpStatus = response.status;
    record.responseKeys = Object.keys(data || {});
    record.responseProfile = summarizeYoutubeProfile(data);
    record.updateStatus = Object.fromEntries(Object.entries(data || {}).filter(([key]) => /UpdateStatus$/.test(key))
      .map(([key, value]) => [key, { keys: Object.keys(value || {}), errorCode: value?.errorCode ?? value?.updateStatus?.errorCode ?? null, errorPresent: !!value?.error }]));
    record.state = 'needs_readback';
    if (data?.error || response.status !== 200) { record.state = 'not_confirmed'; record.serviceErrorCode = data?.error?.code ?? null; }
  } catch { record.state = 'needs_reconciliation'; record.code = 'YOUTUBE_PROFILE_REQUEST_UNCONFIRMED'; }
  await saveRecord(file, record);
  return { ...record, journalPath: file };
}

export async function reconcileYoutubeProfile({ idempotencyKey } = {}) {
  const file = recordPath(idempotencyKey);
  const record = JSON.parse(await fs.readFile(file, 'utf8'));
  const readback = await readYoutubeProfile();
  const verified = readback.httpStatus === 200 && !readback.errorPresent && readback.channelId === record.channelId
    && readback.statusCode === 'CREATOR_ENTITY_STATUS_OK'
    && (record.expectedTitle === undefined || readback.title === record.expectedTitle)
    && (record.expectedDescription === undefined || readback.description === record.expectedDescription)
    && (record.expectedAvatarBlobSha256 === undefined || (readback.avatarUrlSha256
      && readback.avatarUrlSha256 !== record.before.avatarUrlSha256
      && readback.avatarUrlSha256 === record.responseProfile?.avatarUrlSha256));
  Object.assign(record, { readback, checkedAt: new Date().toISOString(),
    state: verified || record.state === 'profile_verified' ? 'profile_verified' : 'needs_reconciliation', latestReadbackMatches: !!verified });
  await saveRecord(file, record);
  return record;
}
