import { loadTikTokSession, storeTikTokSessionState, TIKTOK_ORIGIN, TIKTOK_OWNER_HANDLE } from '../lib/tiktok-auth-session.mjs';

const STUDIO_USER_PATH = '/tiktokstudio/api/web/user';
const UPLOAD_PROFILE_PATH = '/api/v1/user/profile/upload/';

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function parseJson(raw) {
  try { return JSON.parse(raw); } catch { fail('TIKTOK_RESPONSE_NOT_JSON'); }
}

function objectKeys(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).slice(0, 80) : [];
}

function nestedObjectShapes(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const shapes = {};
  for (const [key, item] of Object.entries(value)) {
    if (item && typeof item === 'object') {
      shapes[key] = Array.isArray(item)
        ? { type: 'array', length: item.length, firstItemKeys: objectKeys(item[0]) }
        : { type: 'object', keys: objectKeys(item) };
    }
  }
  return shapes;
}

function collectHandleValues(value, found = [], depth = 0) {
  if (!value || typeof value !== 'object' || depth > 30 || found.length > 20) return found;
  if (Array.isArray(value)) {
    for (const item of value) collectHandleValues(item, found, depth + 1);
    return found;
  }
  for (const [key, item] of Object.entries(value)) {
    if (['unique_id', 'uniqueId', 'uniqueID', 'handle'].includes(key)
      && typeof item === 'string' && /^[A-Za-z0-9._]{1,50}$/.test(item)) found.push({ key, value: item });
    else collectHandleValues(item, found, depth + 1);
  }
  return found;
}

// The current Studio response has a PascalCase UserProfile.UserBase envelope.
// NickName and arbitrary nested handle-like fields are not identity evidence.
export function verifyTikTokStudioOwner(payload, expectedOwner = TIKTOK_OWNER_HANDLE) {
  const base = payload?.userBaseInfo?.UserProfile?.UserBase;
  return payload?.statusCode === 0 && typeof base?.UniqId === 'string'
    && /^[A-Za-z0-9._]{1,50}$/.test(base.UniqId)
    && base.UniqId.toLowerCase() === expectedOwner.toLowerCase()
    && typeof base.Id === 'string' && /^\d{1,30}$/.test(base.Id);
}

async function directGet(path, source) {
  const loaded = await loadTikTokSession();
  const result = await loaded.session.request(TIKTOK_ORIGIN + path, {
    method: 'GET',
    headers: { accept: 'application/json, text/plain, */*' },
  });
  if (result.status === 401 || result.status === 403 || result.status === 418 || result.status === 429) {
    fail('TIKTOK_HTTP_' + result.status);
  }
  if (result.status !== 200 || !/json/i.test(result.headers['content-type'] || '')) {
    return {
      service: 'tiktok', method: 'GET', path, status: result.status,
      sourceEvidence: source, client_exists: true, credential_propagated: true,
      remnant_free: true, live_replay: false, ownerVerified: false,
      responseMime: result.headers['content-type']?.split(';')[0] || null,
    };
  }
  const payload = parseJson(result.raw);
  await storeTikTokSessionState(loaded.session);
  const handleValues = collectHandleValues(payload);
  const studioRead = path === STUDIO_USER_PATH;
  const ownerVerified = studioRead ? verifyTikTokStudioOwner(payload)
    : handleValues.some(item => item.value.toLowerCase() === TIKTOK_OWNER_HANDLE.toLowerCase());
  return {
    service: 'tiktok', method: 'GET', path, status: result.status,
    sourceEvidence: source, client_exists: true, credential_propagated: true,
    remnant_free: true, directHttpReplayed: true, live_replay: ownerVerified, ownerVerified,
    responseMime: result.headers['content-type']?.split(';')[0] || null,
    responseRootKeys: objectKeys(payload),
    responseObjectShapes: nestedObjectShapes(payload),
    observedIdentityFieldNames: studioRead && ownerVerified ? ['userBaseInfo.UserProfile.UserBase.UniqId', 'userBaseInfo.UserProfile.UserBase.Id']
      : [...new Set(handleValues.map(item => item.key))],
    observedHandleMatchesOwner: ownerVerified,
    observedHandleCount: handleValues.length,
    ...(studioRead ? { creatorProfile: { ownerVerified, analyticsData: false,
      isPrivate: typeof payload.userExtra?.isPrivate === 'boolean' ? payload.userExtra.isPrivate : null,
      isU16: typeof payload.userExtra?.isU16 === 'boolean' ? payload.userExtra.isU16 : null } } : {}),
    auth: { ownerHandle: loaded.ownerHandle, provider: loaded.provider, persistent: loaded.persistent },
  };
}

export async function readTikTokStudioUser() {
  return directGet(STUDIO_USER_PATH, 'authenticated_studio_response_observed_in_browser');
}

export async function readTikTokUploadProfile() {
  return directGet(UPLOAD_PROFILE_PATH, 'authenticated_upload_settings_response_observed_in_browser');
}

export const tiktokReadContract = Object.freeze({
  source: 'first_party_tiktok_web',
  routes: Object.freeze({
    studioUser: Object.freeze({ method: 'GET', path: STUDIO_USER_PATH, observedRequestCapture: false, observedResponse: true }),
    uploadProfile: Object.freeze({ method: 'GET', path: UPLOAD_PROFILE_PATH, observedRequestCapture: false, observedResponse: true }),
  }),
  writes: Object.freeze({ supported: false, reason: 'This provider is read-only; browser-assisted video publishing uses tiktok-publisher.mjs' }),
});
