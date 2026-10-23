import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadMetaSession, rotateMetaCookies } from '../../../../naver-blog-api/scripts/meta-auth-session.mjs';
import { openMetaContext, metaRequest } from '../../../../social-actions/lib/meta-bootstrap.mjs';
import { readInstagramProfile } from '../../../../social-actions/instagram-reader.mjs';
import { journaledRequest, defaultJournalDir } from './journal.mjs';

export const PROFILE_OWNER = 'lifehack__ailab';
export const INSTAGRAM_ORIGIN = 'https://www.instagram.com';
export const THREADS_ORIGIN = 'https://www.threads.com';
export const INSTAGRAM_PROFILE_FORM_PATH = '/api/v1/web/accounts/edit/';
export const INSTAGRAM_PROFILE_FORM_READBACK_PATH = '/api/v1/accounts/edit/web_form_data/';
export const INSTAGRAM_PROFILE_PICTURE_MUTATION_ID = '28293585443628449';
export const INSTAGRAM_PROFILE_PICTURE_MUTATION_NAME = 'PolarisUserActionSetProfilePicMutation';
export const INSTAGRAM_POST_READBACK_ID = '27830990013244856';
export const INSTAGRAM_POST_READBACK_NAME = 'PolarisPostRootQuery';

export const DEFAULT_PROFILE = Object.freeze({
  owner: PROFILE_OWNER,
  name: '생활이득AI연구소',
  bio: 'AI로 비교한 생활 이득 🧠\n최저가·혜택·여행 특가를 매일 정리해요\n전체 비교표는 👇 블로그에서',
  website: 'https://blog.naver.com/aicandoanything',
  bioLinks: Object.freeze([
    Object.freeze({ url: 'https://blog.naver.com/aicandoanything', title: '전체 비교표' }),
    Object.freeze({ url: 'https://cafe.naver.com/lifehackailab', title: '네이버 카페' }),
  ]),
});

const fail = code => { throw Object.assign(new Error(code), { code }); };
let lastProfileUploadTimestamp = 0;

function createProfileUploadId() {
  const now = Date.now();
  lastProfileUploadTimestamp = lastProfileUploadTimestamp >= now ? lastProfileUploadTimestamp + 1 : now;
  return String(lastProfileUploadTimestamp);
}

function assertOwner(session, service) {
  if (!session || session.service !== service) fail('META_SESSION_REQUIRED');
  if (session.owner !== PROFILE_OWNER) fail('META_OWNER_MISMATCH');
  return session;
}

function sessionCookie(session, name) {
  return session?.cookies?.find(cookie => cookie.name === name)?.value;
}

function sessionHeader(session, name) {
  const headers = session?.ownerRequest?.headers || {};
  const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

function instagramHeaders(session) {
  assertOwner(session, 'instagram');
  const headers = {};
  for (const [source, target] of [
    ['x-instagram-ajax', 'X-Instagram-AJAX'], ['x-ig-app-id', 'X-IG-App-ID'], ['x-asbd-id', 'X-ASBD-ID'],
    ['x-ig-www-claim', 'X-IG-WWW-Claim'], ['x-web-session-id', 'X-Web-Session-ID'],
    ['x-web-device-id', 'X-Web-Device-Id'], ['x-mid', 'X-Mid'], ['x-bloks-version-id', 'X-BLOKS-VERSION-ID'],
  ]) {
    const value = sessionHeader(session, source);
    if (value) headers[target] = value;
  }
  const csrf = sessionCookie(session, 'csrftoken');
  if (!csrf) fail('META_CSRF_MISSING');
  if (!headers['X-IG-App-ID']) fail('META_APP_ID_MISSING');
  headers['X-CSRFToken'] = csrf;
  headers.cookie = (session.cookies || []).map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  // Browser fetch metadata: Meta refuses API calls without it ("SecFetch Policy violation" on Threads, 2026-09-28).
  Object.assign(headers, { Origin: INSTAGRAM_ORIGIN, Referer: `${INSTAGRAM_ORIGIN}/accounts/edit/`, 'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', 'X-Requested-With': 'XMLHttpRequest' });
  const ua = sessionHeader(session, 'user-agent');
  if (ua) headers['User-Agent'] = ua;
  return headers;
}

function instagramRelayHeaders(session) {
  const headers = instagramHeaders(session);
  const lsd = sessionHeader(session, 'x-fb-lsd');
  if (lsd) headers['X-FB-LSD'] = lsd;
  return headers;
}

function threadsHeaders(session) {
  assertOwner(session, 'threads');
  const headers = {};
  for (const [source, target] of [
    ['x-ig-app-id', 'X-IG-App-ID'], ['x-fb-lsd', 'X-FB-LSD'],
    ['x-asbd-id', 'X-ASBD-ID'], ['x-web-session-id', 'X-Web-Session-ID'],
  ]) {
    const value = sessionHeader(session, source);
    if (value) headers[target] = value;
  }
  const csrf = sessionCookie(session, 'csrftoken');
  if (!csrf) fail('META_CSRF_MISSING');
  if (!headers['X-IG-App-ID']) fail('META_APP_ID_MISSING');
  if (!headers['X-FB-LSD']) fail('META_LSD_MISSING');
  headers['X-CSRFToken'] = csrf;
  headers.cookie = (session.cookies || []).map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  return headers;
}

function validateProfile(profile) {
  if (!profile || (profile.owner ?? PROFILE_OWNER) !== PROFILE_OWNER) fail('META_OWNER_MISMATCH');
  if (typeof profile.name !== 'string' || !profile.name.trim()
    || typeof profile.bio !== 'string' || typeof profile.website !== 'string') fail('INSTAGRAM_PROFILE_INVALID');
  if (profile.username !== undefined && profile.username !== PROFILE_OWNER) fail('META_OWNER_MISMATCH');
  const links = profile.bioLinks;
  if (links !== undefined) {
    if (!Array.isArray(links) || links.length > 5) fail('INSTAGRAM_BIO_LINKS_INVALID');
    for (const item of links) {
      if (!item || typeof item.url !== 'string' || typeof item.title !== 'string') fail('INSTAGRAM_BIO_LINKS_INVALID');
      let url;
      try { url = new URL(item.url); } catch { fail('INSTAGRAM_BIO_LINKS_INVALID'); }
      if (url.protocol !== 'https:') fail('INSTAGRAM_BIO_LINKS_INVALID');
    }
  }
}

function formBody(fields) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) body.set(key, String(value));
  }
  return body;
}

// Verified in cached public Instagram chunk instagramjs/7.js, module
// PolarisAPISaveProfile. bio_links is an explicit assumption: the observed
// saver sends external_url only, even though the current profile model reads bio_links.
export function buildInstagramProfileEditRequest({ profile = DEFAULT_PROFILE, session }) {
  assertOwner(session, 'instagram');
  validateProfile(profile);
  const fields = {
    biography: profile.bio,
    chaining_enabled: profile.chainingEnabled === true ? 'on' : '',
    external_url: profile.website,
    first_name: profile.name,
    gender: profile.gender,
    username: PROFILE_OWNER,
    ...(profile.bioLinks !== undefined ? { bio_links: JSON.stringify(profile.bioLinks) } : {}),
  };
  return {
    method: 'POST', url: `${INSTAGRAM_ORIGIN}${INSTAGRAM_PROFILE_FORM_PATH}`,
    headers: { ...instagramHeaders(session), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody(fields),
  };
}

function imageData({ bytes, width, height, mimeType = 'image/png' }) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (!data.length || !Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1
    || typeof mimeType !== 'string' || !mimeType) fail('INSTAGRAM_PROFILE_PICTURE_INVALID');
  if (mimeType === 'image/png' && (data.length < 24 || data.toString('hex', 0, 8) !== '89504e470d0a1a0a'
    || data.readUInt32BE(16) !== width || data.readUInt32BE(20) !== height)) fail('INSTAGRAM_PROFILE_PICTURE_INVALID');
  return data;
}

// Verified in PolarisAPIFbUploaderPhoto / PolarisAPIRuploadPhoto and
// PolarisUserActionSetProfilePicMutation in the cached public Instagram chunk.
export function buildInstagramProfilePictureRequests({ bytes, width, height, mimeType = 'image/png', uploadId, session }) {
  const data = imageData({ bytes, width, height, mimeType });
  assertOwner(session, 'instagram');
  const id = String(uploadId || '');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) fail('INSTAGRAM_UPLOAD_ID_REQUIRED');
  const entityName = `fb_uploader_${id}`;
  const uploadHeaders = instagramHeaders(session);
  // PolarisAPIRuploadPhoto explicitly omits the WWW-Claim and Web-Device-ID
  // defaults for rupload requests.
  delete uploadHeaders['X-IG-WWW-Claim'];
  delete uploadHeaders['X-Web-Device-Id'];
  uploadHeaders['Sec-Fetch-Site'] = 'same-site';
  Object.assign(uploadHeaders, {
    Offset: '0', 'X-Entity-Length': String(data.length), 'X-Entity-Name': entityName,
    'X-Entity-Type': mimeType,
    'X-Instagram-Rupload-Params': JSON.stringify({ media_type: 1, upload_id: id,
      upload_media_height: height, upload_media_width: width }),
  });
  const upload = { method: 'POST', url: `https://i.instagram.com/rupload_igphoto/${encodeURIComponent(entityName)}`,
    headers: uploadHeaders, body: data };

  const operationHeaders = instagramRelayHeaders(session);
  operationHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
  operationHeaders['X-FB-Friendly-Name'] = INSTAGRAM_PROFILE_PICTURE_MUTATION_NAME;
  const setPicture = {
    method: 'POST', url: `${INSTAGRAM_ORIGIN}/api/graphql`, headers: operationHeaders,
    body: formBody({ fb_api_caller_class: 'RelayModern', doc_id: INSTAGRAM_PROFILE_PICTURE_MUTATION_ID,
      fb_api_req_friendly_name: INSTAGRAM_PROFILE_PICTURE_MUTATION_NAME, server_timestamps: 'true',
      variables: JSON.stringify({ upload_id: id }) }),
  };
  return [upload, setPicture];
}

export function buildFreshInstagramProfilePictureMutationRequest({ uploadId, session, context }) {
  const id = String(uploadId || '');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) fail('INSTAGRAM_UPLOAD_ID_REQUIRED');
  assertOwner(session, 'instagram');
  const fresh = metaRequest(context, INSTAGRAM_PROFILE_PICTURE_MUTATION_NAME, INSTAGRAM_PROFILE_PICTURE_MUTATION_ID,
    { upload_id: id });
  if (fresh.url !== `${INSTAGRAM_ORIGIN}/api/graphql` || fresh.method !== 'POST'
    || fresh.body.get('doc_id') !== INSTAGRAM_PROFILE_PICTURE_MUTATION_ID
    || fresh.body.get('fb_api_req_friendly_name') !== INSTAGRAM_PROFILE_PICTURE_MUTATION_NAME
    || JSON.stringify(JSON.parse(fresh.body.get('variables') || 'null')) !== JSON.stringify({ upload_id: id })) {
    fail('INSTAGRAM_PROFILE_PICTURE_CONTRACT_INVALID');
  }
  const freshNames = new Set(Object.keys(fresh.headers).map(name => name.toLowerCase()));
  const baseHeaders = Object.fromEntries(Object.entries(instagramHeaders(session))
    .filter(([name]) => !freshNames.has(name.toLowerCase())));
  return { ...fresh, headers: { ...baseHeaders, ...fresh.headers, referer: `${INSTAGRAM_ORIGIN}/accounts/edit/` } };
}

// Verified read contract from meta-auth-session.mjs's owner request contract.
export function buildInstagramProfileReadbackRequest({ session }) {
  assertOwner(session, 'instagram');
  return { method: 'GET', url: `${INSTAGRAM_ORIGIN}${INSTAGRAM_PROFILE_FORM_READBACK_PATH}`,
    headers: instagramHeaders(session) };
}

// Verified GraphQL query from PolarisPostRootQuery in cached Instagram chunks.
// It reads by shortcode. The media-info REST route remains an unverified alternative.
export function buildInstagramPostReadbackRequest({ shortcode, session }) {
  assertOwner(session, 'instagram');
  if (typeof shortcode !== 'string' || !/^[A-Za-z0-9_-]{3,32}$/.test(shortcode)) fail('INSTAGRAM_SHORTCODE_INVALID');
  const headers = instagramRelayHeaders(session);
  headers['Content-Type'] = 'application/x-www-form-urlencoded';
  headers['X-FB-Friendly-Name'] = INSTAGRAM_POST_READBACK_NAME;
  return { method: 'POST', url: `${INSTAGRAM_ORIGIN}/api/graphql`, headers,
    body: formBody({ fb_api_caller_class: 'RelayModern', doc_id: INSTAGRAM_POST_READBACK_ID,
      fb_api_req_friendly_name: INSTAGRAM_POST_READBACK_NAME, server_timestamps: 'true',
      variables: JSON.stringify({ shortcode }) }) };
}

// The cached Threads bundle has profile route/view modules but no profile edit
// mutation or request builder. Keep the real writer fail-closed until that code is observed.
export function buildThreadsProfileEditRequest({ session }) {
  assertOwner(session, 'threads');
  fail('THREADS_PROFILE_CONTRACT_MISSING');
}

// The exact Threads post page readback route was not present in the cached modules.
// This candidate GET builder is assumed and must not be treated as verified readback.
export function buildThreadsPostReadbackRequest({ permalink, session }) {
  assertOwner(session, 'threads');
  let url;
  try { url = new URL(permalink); } catch { fail('THREADS_PERMALINK_INVALID'); }
  if (url.origin !== THREADS_ORIGIN || !/^\/@lifehack__ailab\/post\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) {
    fail('THREADS_PERMALINK_INVALID');
  }
  return { method: 'GET', url: url.toString(), headers: { ...threadsHeaders(session), Accept: 'text/html,application/json' },
    contractStatus: 'assumed' };
}

// Meta's GraphQL endpoints may prefix JSON with "for (;;);" — parsed through text so a live 200 is not mistaken for a
// failure (first live apply 2026-09-28 threw here after the picture mutation answered 200).
async function responseJson(response) {
  if (typeof response?.text === 'function') {
    const text = await response.text();
    try { return JSON.parse(String(text).replace(/^\s*for\s*\(;;\);/, '')); } catch { return null; }
  }
  if (typeof response?.json === 'function') return response.json();
  if (response?.body && typeof response.body === 'object') return response.body;
  if (response?.data && typeof response.data === 'object') return response.data;
  return response;
}

// A refused request keeps Meta's reason (JSON message, or content type + text start) as error.detail.
async function assertResponse(response, prefix = 'INSTAGRAM') {
  const status = Number(response?.status ?? response?.receipt?.status ?? 200);
  if (response?.ok === false || status < 200 || status >= 300) {
    let detail = null;
    if (typeof response?.text === 'function') {
      let text = '';
      try { text = await response.text(); } catch { text = ''; }
      try { const j = JSON.parse(text); detail = [j.message, j.error_type, j.error_title].filter(Boolean).join(' | ').slice(0, 300) || null; }
      catch { detail = `${response.headers?.get?.('content-type') ?? '?'}: ${String(text).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}`; }
    }
    throw Object.assign(new Error(`${prefix}_HTTP_${status}`), { code: `${prefix}_HTTP_${status}`, httpStatus: status, detail });
  }
}

function matchingProfileFields(form, profile) {
  if (!form || typeof form !== 'object') return [];
  const expected = { username: PROFILE_OWNER, first_name: profile.name, biography: profile.bio, external_url: profile.website };
  return Object.entries(expected).filter(([key, value]) => String(form[key] ?? '') === String(value)).map(([key]) => key);
}

async function requireSession(session, loadSession) {
  const value = session || await loadSession('instagram');
  return assertOwner(value, 'instagram');
}

function profilePicturePathFingerprint(readResult) {
  const urlValue = readResult?.profile?.profilePictureUrl;
  if (readResult?.service !== 'instagram' || readResult?.profile?.username?.toLowerCase() !== PROFILE_OWNER
    || typeof readResult?.profile?.id !== 'string' || !/^\d{1,30}$/.test(readResult.profile.id)
    || readResult?.receipt?.httpStatus !== 200 || typeof urlValue !== 'string') {
    fail('INSTAGRAM_PROFILE_PICTURE_READBACK_INVALID');
  }
  let url;
  try { url = new URL(urlValue); } catch { fail('INSTAGRAM_PROFILE_PICTURE_READBACK_INVALID'); }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.cdninstagram.com') || url.username || url.password) {
    fail('INSTAGRAM_PROFILE_PICTURE_READBACK_INVALID');
  }
  return { ownerId: readResult.profile.id, pathSha256: createHash('sha256').update(url.pathname).digest('hex') };
}

async function reserveProfilePictureRun(journalDir, runKey, pictureSha256) {
  await mkdir(journalDir, { recursive: true });
  const file = path.join(journalDir, `instagram.profile-picture.${runKey}.claim.jsonl`);
  let handle;
  try { handle = await open(file, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') fail('INSTAGRAM_PROFILE_PICTURE_ALREADY_ATTEMPTED');
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ state: 'reserved', owner: PROFILE_OWNER,
      pictureSha256, at: new Date().toISOString(), automaticRetry: false }) + '\n');
    await handle.sync();
  } finally { await handle.close(); }
  return file;
}

async function recordProfilePictureRun(file, details) {
  const handle = await open(file, 'a');
  try { await handle.writeFile(JSON.stringify({ ...details, at: new Date().toISOString() }) + '\n'); }
  finally { await handle.close(); }
}

function approvalRunKey(approvalId) {
  if (typeof approvalId !== 'string' || !approvalId.trim()) fail('APPROVAL_REQUIRED');
  return `profile-${createHash('sha256').update(approvalId).digest('hex').slice(0, 24)}`;
}

// Fake-injected tests exercise this only with a supplied session and transport.
// The CLI calls it only after --approval is present.
export async function sendInstagramProfile({ profile = DEFAULT_PROFILE, picture, approvalId, session,
  loadSession = loadMetaSession, rotateCookies = rotateMetaCookies, transport, journalDir = defaultJournalDir(),
  runKey, uploadIdFactory = createProfileUploadId } = {}) {
  const approvedRunKey = approvalRunKey(approvalId);
  const key = runKey || approvedRunKey;
  if (typeof transport !== 'function') fail('SNS_TRANSPORT_REQUIRED');
  const currentSession = await requireSession(session, loadSession);
  validateProfile(profile);
  const image = picture || {};
  const uploadId = uploadIdFactory();
  const runRequest = async request => {
    const response = await journaledRequest({ channel: 'instagram', runKey: key, journalDir, request, send: transport });
    await rotateCookies(currentSession, response);
    await assertResponse(response);
    return response;
  };
  // The save form resends every field, so the current similar-account suggestion and gender settings are read first and
  // kept unless the caller sets them (owner 2026-09-28 first live apply).
  const beforeForm = (await responseJson(await runRequest(buildInstagramProfileReadbackRequest({ session: currentSession }))))?.form_data ?? {};
  profile = { ...profile, chainingEnabled: profile.chainingEnabled ?? beforeForm.chaining_enabled === true,
    gender: profile.gender ?? beforeForm.gender ?? undefined };
  const requests = [buildInstagramProfileEditRequest({ profile, session: currentSession }),
    ...buildInstagramProfilePictureRequests({ ...image, uploadId, session: currentSession })];
  await runRequest(requests[0]);
  await runRequest(requests[1]);
  const setResponse = await runRequest(requests[2]);
  const setPayload = await responseJson(setResponse);
  if (Array.isArray(setPayload?.errors) && setPayload.errors.length) fail('INSTAGRAM_PROFILE_PICTURE_FAILED');
  const pictureUser = setPayload?.data?.xig_web_set_profile_picture?.user
    ?? setPayload?.xig_web_set_profile_picture?.user;
  const pictureReceiptSeen = typeof pictureUser?.profile_pic_url === 'string' && pictureUser.profile_pic_url.length > 0;

  const readbackResponse = await runRequest(buildInstagramProfileReadbackRequest({ session: currentSession }));
  const readback = await responseJson(readbackResponse);
  const form = readback?.form_data;
  const verifiedFields = matchingProfileFields(form, profile);
  const baseProfileReadbackVerified = verifiedFields.length === 4;
  const assumedFields = profile.bioLinks !== undefined ? ['bio_links'] : [];
  const readbackVerified = baseProfileReadbackVerified && pictureReceiptSeen && assumedFields.length === 0;
  return { owner: PROFILE_OWNER, approvalId, uploadId, requestsSent: requests.length + 1,
    profilePictureReceiptSeen: pictureReceiptSeen, verifiedFields,
    readbackVerified,
    readbackReason: readbackVerified ? null : assumedFields.length ? 'INSTAGRAM_PROFILE_ASSUMED_FIELDS_UNVERIFIED' : 'INSTAGRAM_PROFILE_READBACK_INCOMPLETE',
    assumedFields,
    assumptionsVerified: false };
}

// Photo-only operation for requests that must preserve the existing profile text and links.
export async function sendInstagramProfilePicture({ picture, approvalId, session,
  loadSession = loadMetaSession, rotateCookies = rotateMetaCookies, transport, journalDir = defaultJournalDir(),
  runKey, uploadIdFactory = createProfileUploadId, readProfile = readInstagramProfile,
  openContext = openMetaContext } = {}) {
  const approvedRunKey = approvalRunKey(approvalId);
  const key = runKey || approvedRunKey;
  if (typeof transport !== 'function') fail('SNS_TRANSPORT_REQUIRED');
  const storedSession = await requireSession(session, loadSession);
  const context = await openContext('instagram', PROFILE_OWNER);
  const currentSession = assertOwner(context?.bundle, 'instagram');
  if (currentSession.owner !== storedSession.owner
    || currentSession.ownerId && storedSession.ownerId
      && String(currentSession.ownerId) !== String(storedSession.ownerId)) fail('META_OWNER_MISMATCH');
  const image = imageData(picture || {});
  const beforeRead = await readProfile({ handle: PROFILE_OWNER });
  const before = profilePicturePathFingerprint(beforeRead);
  const sessionOwnerId = sessionCookie(currentSession, 'ds_user_id');
  if (!sessionOwnerId || sessionOwnerId !== before.ownerId) fail('META_OWNER_MISMATCH');
  const uploadId = uploadIdFactory();
  const requests = buildInstagramProfilePictureRequests({ ...picture, bytes: image, uploadId, session: currentSession });
  requests[1] = buildFreshInstagramProfilePictureMutationRequest({ uploadId, session: currentSession, context });
  const claimFile = await reserveProfilePictureRun(journalDir, key, createHash('sha256').update(image).digest('hex'));
  const runRequest = async request => {
    const response = await journaledRequest({ channel: 'instagram', runKey: key, journalDir, request, send: transport });
    await rotateCookies(currentSession, response);
    await assertResponse(response);
    return response;
  };
  try {
    const uploadResponse = await runRequest(requests[0]);
    const uploadPayload = await responseJson(uploadResponse);
    if (uploadPayload?.status !== 'ok') fail('INSTAGRAM_PROFILE_PICTURE_UPLOAD_UNVERIFIED');
    const mutationResponse = await runRequest(requests[1]);
    const mutation = await responseJson(mutationResponse);
    const mutationErrors = Array.isArray(mutation?.errors) && mutation.errors.length > 0
      || !!mutation?.error || !!mutation?.error_type || mutation?.status === 'fail';
    const pictureUser = mutation?.data?.xig_web_set_profile_picture?.user
      ?? mutation?.xig_web_set_profile_picture?.user;
    const pictureReceiptSeen = typeof pictureUser?.profile_pic_url === 'string' && pictureUser.profile_pic_url.length > 0;
    const afterRead = await readProfile({ handle: PROFILE_OWNER });
    const after = profilePicturePathFingerprint(afterRead);
    const readbackVerified = before.ownerId === after.ownerId && before.pathSha256 !== after.pathSha256
      && !mutationErrors;
    const result = { owner: PROFILE_OWNER, state: readbackVerified ? 'profile_picture_verified' : 'needs_reconciliation',
      requestsSent: 2, profilePictureReceiptSeen: pictureReceiptSeen,
      uploadHttpStatus: Number(uploadResponse.status), uploadStatus: ['ok', 'fail'].includes(uploadPayload?.status) ? uploadPayload.status : 'unknown',
      mutationHttpStatus: Number(mutationResponse.status),
      mutationTopLevelKeys: Object.keys(mutation || {}).slice(0, 20),
      mutationDataKeys: Object.keys(mutation?.data || {}).slice(0, 20),
      beforePathSha256: before.pathSha256, afterPathSha256: after.pathSha256, readbackVerified,
      mutationErrorPresent: mutationErrors };
    await recordProfilePictureRun(claimFile, { state: result.state, requestsSent: result.requestsSent,
      profilePictureReceiptSeen: result.profilePictureReceiptSeen, beforePathSha256: result.beforePathSha256,
      afterPathSha256: result.afterPathSha256, readbackVerified, mutationErrorPresent: mutationErrors,
      uploadHttpStatus: result.uploadHttpStatus, uploadStatus: result.uploadStatus,
      mutationHttpStatus: result.mutationHttpStatus, mutationTopLevelKeys: result.mutationTopLevelKeys,
      mutationDataKeys: result.mutationDataKeys });
    return result;
  } catch (error) {
    await recordProfilePictureRun(claimFile, { state: 'needs_reconciliation', requestsSent: null,
      failureCode: typeof error?.code === 'string' && /^INSTAGRAM_[A-Z0-9_]+$/.test(error.code) ? error.code : 'INSTAGRAM_PROFILE_PICTURE_UNCONFIRMED' });
    throw error;
  }
}

export async function sendThreadsProfile({ session } = {}) {
  if (session) assertOwner(session, 'threads');
  fail('THREADS_PROFILE_CONTRACT_MISSING');
}

export function redactProfileRequest(request) {
  const headers = {};
  for (const [name, value] of Object.entries(request.headers || {})) {
    headers[name] = /cookie|authorization|csrf|lsd|www-claim|web-session-id/i.test(name) ? '<redacted>' : value;
  }
  let body = request.body;
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    const bytes = Buffer.from(body);
    body = { binary: true, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  } else if (body instanceof URLSearchParams) {
    const form = new URLSearchParams(body);
    for (const name of ['fb_dtsg', 'jazoest', 'lsd', '__user', 'av', '__req', '__hs', '__hsi', '__rev',
      '__comet_req', '__spin_r', '__spin_b', '__spin_t']) {
      if (form.has(name)) form.set(name, '<redacted>');
    }
    if (form.has('variables')) {
      try {
        const variables = JSON.parse(form.get('variables'));
        if (variables && typeof variables === 'object' && typeof variables.upload_id === 'string') {
          variables.upload_id = '<redacted>';
          form.set('variables', JSON.stringify(variables));
        }
      } catch {}
    }
    body = form.toString();
  }
  return { method: request.method, url: request.url, headers, body };
}

export async function readProfilePictureFile(filePath) {
  const bytes = await readFile(filePath);
  if (bytes.length < 24 || bytes.toString('hex', 0, 8) !== '89504e470d0a1a0a') fail('INSTAGRAM_PROFILE_PICTURE_INVALID');
  return { bytes, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), mimeType: 'image/png' };
}
