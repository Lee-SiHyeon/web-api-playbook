import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { webApiPlaybookRoot } from '../affiliate-api-hub/adapters/web-auth-provider.mjs';
import { metaCookieHeader } from '../naver-blog-api/scripts/meta-auth-session.mjs';
import { openMetaContext, metaRequest, rotateMetaCookiesWithRetry } from './lib/meta-bootstrap.mjs';
import { SOCIAL_REQUEST_TIMEOUTS } from './lib/request-timeouts.mjs';

const ORIGIN = 'https://www.threads.com';
const OWNER = 'lifehack__ailab';
const GRAPHQL_PATH = '/graphql/query';
const STORE_PREFIX = 'threads-profile-envelope-v1';
const READ_ENVELOPE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PROFILE_LINK_MUTATION = Object.freeze({
  operation: 'useBarcelonaCreateOrUpdateBioLinkMutation',
  docId: '38378537858458247',
});
const PROFILE_BIO_TEXT = 'AI로 비교한 생활 이득 🧠\n최저가·혜택·여행 특가를 매일 정리해요\n전체 비교표는 👇 블로그에서';
const PROFILE_DISPLAY_NAME = '생활이득AI연구소';
const PROFILE_BIO_MUTATION = Object.freeze({ operation: 'useBarcelonaEditProfileMutation', docId: '30608164248810546' });
const PROFILE_BIO_VARIABLE_KEYS = Object.freeze([
  'external_url', 'biography', 'username', 'name', 'is_private', 'profile_picture_upload_id',
  'remove_profile_picture', 'copy_ig_profile_picture_to_text_post_app',
]);
const PROFILE_READ = Object.freeze({
  profile: { operation: 'BarcelonaProfileEditDialogQuery', docId: '28100575339605432' },
  links: { operation: 'BarcelonaEditProfileLinksPageQuery', docId: '28490805697220665' },
});
const APPROVED_LINKS = new Map([
  ['https://blog.naver.com/aicandoanything', new Set(['', '블로그'])],
  ['https://cafe.naver.com/lifehackailab', new Set(['', '네이버 카페'])],
]);
const HEADER_ALLOWLIST = new Set([
  'accept', 'content-type', 'origin', 'referer', 'user-agent', 'sec-ch-prefers-color-scheme',
  'sec-ch-ua', 'sec-ch-ua-full-version-list', 'sec-ch-ua-mobile', 'sec-ch-ua-model',
  'sec-ch-ua-platform', 'sec-ch-ua-platform-version', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site',
  'x-asbd-id', 'x-bloks-version-id',
  'x-fb-friendly-name', 'x-fb-lsd', 'x-ig-app-id', 'x-root-field-name', 'x-web-session-id',
]);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const sha256 = value => createHash('sha256').update(value).digest('hex');

async function getStore() {
  const root = webApiPlaybookRoot();
  const { ProtectedStore } = await import(pathToFileURL(path.join(root, 'lib', 'protected-store.mjs')).href);
  return new ProtectedStore();
}

function envelopeStoreName(kind, key) {
  if (!['write', 'bio-write', 'profile-read', 'links-read'].includes(kind)
    || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(key || '')) fail('THREADS_PROFILE_JOB_INVALID');
  return `${STORE_PREFIX}-${kind}-${key}`;
}

function parseRequest(envelope) {
  let url;
  try { url = new URL(envelope?.request?.url); } catch { fail('THREADS_PROFILE_REQUEST_INVALID'); }
  const request = envelope.request;
  if (request.method !== 'POST' || url.origin !== ORIGIN || url.pathname !== GRAPHQL_PATH
    || url.username || url.password || url.hash || url.search || typeof request.body !== 'string'
    || Buffer.byteLength(request.body) > 128 * 1024) fail('THREADS_PROFILE_REQUEST_INVALID');
  const form = new URLSearchParams(request.body);
  const docId = form.get('doc_id');
  const operation = form.get('fb_api_req_friendly_name');
  let variables;
  try { variables = JSON.parse(form.get('variables') || 'null'); } catch { fail('THREADS_PROFILE_VARIABLES_INVALID'); }
  if (!variables || typeof variables !== 'object' || Array.isArray(variables)) fail('THREADS_PROFILE_VARIABLES_INVALID');
  return { url, request, form, operation, docId, variables };
}

function normalizeHeaders(raw, { requireLsd = true } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('THREADS_PROFILE_HEADERS_INVALID');
  const headers = {};
  for (const [key, value] of Object.entries(raw)) {
    const name = key.toLowerCase();
    if (name === 'cookie' || name === 'authorization' || name === 'x-csrftoken') continue;
    if (!HEADER_ALLOWLIST.has(name)) continue;
    if (Object.hasOwn(headers, name) || typeof value !== 'string' || /[\r\n\0]/.test(value) || value.length > 16384) {
      fail('THREADS_PROFILE_HEADERS_INVALID');
    }
    headers[name] = value;
  }
  if (headers.origin !== ORIGIN || !headers.referer || new URL(headers.referer).origin !== ORIGIN
    || !headers['content-type'] || !/^application\/x-www-form-urlencoded(?:;|$)/i.test(headers['content-type'])
    || !headers['x-ig-app-id'] || requireLsd && !headers['x-fb-lsd'] || !headers['user-agent']) fail('THREADS_PROFILE_HEADERS_INVALID');
  return headers;
}

function sanitizeReadRequestBody(body) {
  const form = new URLSearchParams(body);
  const operation = form.get('fb_api_req_friendly_name');
  const docId = form.get('doc_id');
  const variables = form.get('variables');
  if (!operation || !docId || !variables) fail('THREADS_PROFILE_READ_PROVENANCE_INVALID');
  return new URLSearchParams({
    fb_api_req_friendly_name: operation,
    doc_id: docId,
    variables,
    fb_api_caller_class: form.get('fb_api_caller_class') || 'RelayModern',
    server_timestamps: form.get('server_timestamps') || 'true',
  }).toString();
}

export function sanitizeThreadsProfileReadRequest(request) {
  if (!request || typeof request !== 'object') fail('THREADS_PROFILE_REQUEST_INVALID');
  const headers = Object.fromEntries(Object.entries(request.headers || {}).filter(([name]) =>
    !['cookie', 'authorization', 'x-csrftoken', 'x-fb-lsd', 'x-web-session-id', 'x-asbd-id']
      .includes(name.toLowerCase())));
  return { ...request, headers, body: sanitizeReadRequestBody(request.body || '') };
}

export function buildFreshThreadsProfileReadRequest({ checked, freshRequest } = {}) {
  if (!checked || !freshRequest) fail('THREADS_PROFILE_READ_PROVENANCE_INVALID');
  const freshForm = new URLSearchParams(String(freshRequest.body || ''));
  if (freshForm.get('fb_api_req_friendly_name') !== checked.operation
    || freshForm.get('doc_id') !== checked.docId
    || freshForm.get('variables') !== JSON.stringify(checked.variables)) fail('THREADS_PROFILE_READ_PROVENANCE_INVALID');
  const headers = { ...checked.headers, ...(freshRequest.headers || {}) };
  headers.origin = ORIGIN;
  headers.referer = checked.headers.referer;
  headers['content-type'] = checked.headers['content-type'];
  headers['user-agent'] = checked.headers['user-agent'];
  headers['x-fb-friendly-name'] = checked.operation;
  return { url: checked.url.href, method: 'POST', headers, body: freshForm.toString() };
}

export function validateThreadsProfileEnvelope(envelope, { kind = 'write', now = Date.now(), allowSanitized = false } = {}) {
  const age = now - Date.parse(envelope?.observedAt);
  const maxAge = ['write', 'bio-write'].includes(kind) && !allowSanitized ? 120000 : READ_ENVELOPE_MAX_AGE_MS;
  if (envelope?.version !== 1 || envelope.owner !== OWNER || envelope.kind !== kind
    || envelope.helperClosed !== true || !Number.isFinite(age) || age < -5000 || age > maxAge) {
    fail('THREADS_PROFILE_ENVELOPE_INVALID');
  }
  const checked = parseRequest(envelope);
  const headers = normalizeHeaders(checked.request.headers, { requireLsd: ['write', 'bio-write'].includes(kind) && !allowSanitized });
  if (['write', 'bio-write'].includes(kind)) {
    if (envelope.browserWriteBlocked !== true || envelope.blockedReason !== 'inspector'
      || envelope.responseReceived !== false || envelope.networkFailureBlocked !== true) {
      fail('THREADS_PROFILE_BROWSER_WRITE_NOT_BLOCKED');
    }
    if (kind === 'write') {
      if (checked.operation !== PROFILE_LINK_MUTATION.operation || checked.docId !== PROFILE_LINK_MUTATION.docId) {
        fail('THREADS_PROFILE_OPERATION_UNVERIFIED');
      }
      const allowed = new Set(['link_id', 'title', 'url']);
      if (Object.keys(checked.variables).some(key => !allowed.has(key))
        || typeof checked.variables.url !== 'string' || typeof checked.variables.title !== 'string'
        || checked.variables.url.length > 2048 || checked.variables.title.length > 100
        || checked.variables.link_id !== undefined && checked.variables.link_id !== null
          && typeof checked.variables.link_id !== 'string') {
        fail('THREADS_PROFILE_LINK_VARIABLES_INVALID');
      }
      let link;
      try { link = new URL(checked.variables.url); } catch { fail('THREADS_PROFILE_LINK_INVALID'); }
      if (!['https:', 'http:'].includes(link.protocol) || link.username || link.password || link.hash) fail('THREADS_PROFILE_LINK_INVALID');
      if (!APPROVED_LINKS.get(checked.variables.url)?.has(checked.variables.title)) fail('THREADS_PROFILE_CONTENT_MISMATCH');
      } else {
      const keys = Object.keys(checked.variables).sort();
      const uploadId = checked.variables.profile_picture_upload_id;
      if (checked.operation !== PROFILE_BIO_MUTATION.operation || checked.docId !== PROFILE_BIO_MUTATION.docId
        || JSON.stringify(keys) !== JSON.stringify([...PROFILE_BIO_VARIABLE_KEYS].sort())
        || checked.variables.external_url !== 'https://blog.naver.com/aicandoanything'
        || checked.variables.biography !== PROFILE_BIO_TEXT || checked.variables.username !== OWNER
        || checked.variables.name !== PROFILE_DISPLAY_NAME || checked.variables.is_private !== false
        || uploadId !== null && !(typeof uploadId === 'string' && uploadId.length <= 1024 && !/[\r\n\0]/.test(uploadId)
          || Number.isSafeInteger(uploadId) && uploadId > 0)
        || checked.variables.remove_profile_picture !== false
        || checked.variables.copy_ig_profile_picture_to_text_post_app !== false) fail('THREADS_PROFILE_BIO_VARIABLES_INVALID');
    }
  } else {
    const contract = PROFILE_READ[kind === 'profile-read' ? 'profile' : 'links'];
    if (!contract || checked.operation !== contract.operation || checked.docId !== contract.docId
      || envelope.responseStatus !== 200) fail('THREADS_PROFILE_READ_PROVENANCE_INVALID');
  }
  return { kind, ...checked, headers, requestSha256: sha256(checked.request.body) };
}

export async function stageThreadsProfileEnvelope({ kind = 'write', key, envelope } = {}) {
  if (!key) fail('THREADS_PROFILE_JOB_INVALID');
  const checked = validateThreadsProfileEnvelope(envelope, { kind });
  const protectedEnvelope = structuredClone(envelope);
  protectedEnvelope.request = sanitizeThreadsProfileReadRequest(protectedEnvelope.request);
  const store = await getStore();
  const receipt = store.write(envelopeStoreName(kind, key), JSON.stringify(protectedEnvelope));
  if (!receipt.persistent || receipt.provider !== 'Windows DPAPI CurrentUser') fail('THREADS_PROFILE_DPAPI_REQUIRED');
  const reread = store.read(envelopeStoreName(kind, key));
  if (!reread) fail('THREADS_PROFILE_DPAPI_READBACK_FAILED');
  validateThreadsProfileEnvelope(JSON.parse(reread), { kind, allowSanitized: true });
  return { staged: true, kind, operation: checked.operation, docId: checked.docId,
    provider: receipt.provider, helperClosed: true, requestSha256: checked.requestSha256,
    credentialValuesRecorded: false };
}

async function loadEnvelope(kind, key) {
  const store = await getStore();
  const name = envelopeStoreName(kind, key);
  const raw = store.read(name);
  if (!raw) fail('THREADS_PROFILE_ENVELOPE_MISSING');
  let envelope;
  try { envelope = JSON.parse(raw); } catch { fail('THREADS_PROFILE_ENVELOPE_INVALID'); }
  return { store, name, envelope, checked: validateThreadsProfileEnvelope(envelope, { kind, allowSanitized: true }) };
}

function getUser(payload) {
  const candidates = [payload?.data?.viewer?.user, payload?.data?.user, payload?.viewer?.user];
  return candidates.find(value => value && typeof value === 'object') || null;
}

async function readJson(response) {
  const type = response.headers.get('content-type') || '';
  if (!/^(?:application\/json|text\/javascript)(?:;|$)/i.test(type)) fail('THREADS_PROFILE_RESPONSE_MIME');
  const reader = response.body?.getReader();
  if (!reader) fail('THREADS_PROFILE_RESPONSE_EMPTY');
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 2_000_000) fail('THREADS_PROFILE_RESPONSE_LIMIT');
    chunks.push(Buffer.from(value));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^for \(;;\);\s*/, '')); }
  catch { fail('THREADS_PROFILE_RESPONSE_INVALID'); }
}

async function sendObserved(envelope, checked, bundle, freshRequest = null) {
  const csrf = bundle.cookies.find(cookie => cookie.name === 'csrftoken')?.value;
  if (!csrf) fail('THREADS_PROFILE_CSRF_MISSING');
  let headers = checked.headers;
  let body = checked.request.body;
  if (freshRequest) {
    const rebuilt = buildFreshThreadsProfileReadRequest({ checked, freshRequest });
    headers = rebuilt.headers;
    body = rebuilt.body;
  }
  const headersWithSession = { ...headers, cookie: metaCookieHeader(bundle, checked.url), 'x-csrftoken': csrf };
  const response = await fetch(checked.url, { method: 'POST', headers: headersWithSession, body,
    redirect: 'manual', signal: AbortSignal.timeout(checked.operation.includes('Mutation') ? SOCIAL_REQUEST_TIMEOUTS.write : SOCIAL_REQUEST_TIMEOUTS.read) });
  await rotateMetaCookiesWithRetry(bundle, response, Date.now());
  const data = await readJson(response);
  return { response, data };
}

async function readProfileState() {
  const context = await openMetaContext('threads', OWNER);
  const bundle = context.bundle;
  if (bundle.owner.toLowerCase() !== OWNER || !bundle.ownerId) fail('THREADS_PROFILE_OWNER_NOT_VERIFIED');
  const profileRead = await loadEnvelope('profile-read', 'active');
  const linksRead = await loadEnvelope('links-read', 'active');
  const profileFresh = metaRequest(context, profileRead.checked.operation, profileRead.checked.docId, profileRead.checked.variables);
  const linksFresh = metaRequest(context, linksRead.checked.operation, linksRead.checked.docId, linksRead.checked.variables);
  const profileResult = await sendObserved(profileRead.envelope, profileRead.checked, bundle, profileFresh);
  const linksResult = await sendObserved(linksRead.envelope, linksRead.checked, bundle, linksFresh);
  const user = getUser(profileResult.data) || getUser(linksResult.data);
  if (!user || String(user.id || '') !== String(bundle.ownerId)
    || String(user.username || OWNER).toLowerCase() !== OWNER) fail('THREADS_PROFILE_OWNER_MISMATCH');
  const linksUser = getUser(linksResult.data);
  const links = Array.isArray(linksUser?.bio_links) ? linksUser.bio_links.map(item => ({
    url: typeof item?.url === 'string' ? item.url : null,
    title: typeof item?.title === 'string' ? item.title : '',
    linkIdPresent: !!(item?.link_id || item?.id),
  })) : null;
  const pictureUrl = user.profile_pic_url || user.profile_pic_url_hd || user.profile_picture_url || null;
  let picturePathSha256 = null;
  try { if (typeof pictureUrl === 'string') picturePathSha256 = sha256(new URL(pictureUrl).pathname); } catch {}
  return { bundle, context, snapshot: {
    owner: OWNER, ownerIdVerified: true,
    displayName: user.full_name ?? user.name ?? null,
    bio: user.biography ?? user.bio ?? null,
    isPrivate: typeof user.is_private === 'boolean' ? user.is_private : null,
    bioLinks: links,
    profilePictureUrlSha256: typeof pictureUrl === 'string' ? sha256(pictureUrl) : null,
    profilePicturePathSha256: picturePathSha256,
    profileQueryStatus: profileResult.response.status,
    linksQueryStatus: linksResult.response.status,
    checkedAt: new Date().toISOString(), executionMode: 'browser_assisted_http',
  } };
}

async function readProfileSnapshot() {
  return (await readProfileState()).snapshot;
}

export async function readThreadsProfile() {
  return readProfileSnapshot();
}

function journalPath(key) {
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(key || '') || !process.env.LOCALAPPDATA) fail('THREADS_PROFILE_JOB_INVALID');
  return path.join(process.env.LOCALAPPDATA, 'affiliate-content-operations', 'threads', 'journal', `${key}.json`);
}

async function readRecord(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function writeRecord(file, record) {
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await fs.rename(temp, file);
}

function validateExpectedLink(variables, expected) {
  if (!expected || variables.url !== expected.url || variables.title !== expected.title) fail('THREADS_PROFILE_CONTENT_MISMATCH');
}

export async function sendThreadsProfileLink({ key, expectedUrl, expectedTitle = '' } = {}) {
  const file = journalPath(key);
  const previous = await readRecord(file);
  if (previous) {
    if (previous.expectedUrl !== expectedUrl || previous.expectedTitle !== expectedTitle) fail('THREADS_PROFILE_CONTENT_MISMATCH');
    return { ...previous, alreadyAttempted: true, retrySent: false };
  }
  const staged = await loadEnvelope('write', key);
  validateExpectedLink(staged.checked.variables, { url: expectedUrl, title: expectedTitle });
  const { bundle, context, snapshot: before } = await readProfileState();
  if (!before.ownerIdVerified || before.linksQueryStatus !== 200 || before.profileQueryStatus !== 200) fail('THREADS_PROFILE_OWNER_NOT_VERIFIED');
  if (before.bioLinks?.some(link => link.url === expectedUrl && link.title === expectedTitle)) {
    return { state: 'already_applied', writeCount: 0, before, expectedUrl, expectedTitle };
  }
  const claim = path.join(path.dirname(file), `request-${staged.checked.requestSha256}.json`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const claimHandle = await fs.open(claim, 'wx', 0o600).catch(error => {
    if (error.code === 'EEXIST') fail('THREADS_PROFILE_REQUEST_ALREADY_CLAIMED');
    throw error;
  });
  try { await claimHandle.writeFile(JSON.stringify({ key, requestSha256: staged.checked.requestSha256 }) + '\n'); }
  finally { await claimHandle.close(); }
  const record = { version: 1, key, owner: OWNER, kind: 'bio_link', state: 'sending', writeCount: 1,
    operation: staged.checked.operation, docId: staged.checked.docId, requestSha256: staged.checked.requestSha256,
    expectedUrl, expectedTitle, before, browserWriteBlocked: true, helperClosed: true,
    executionMode: 'browser_assisted_http', sentAt: new Date().toISOString() };
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(record, null, 2) + '\n'); } finally { await handle.close(); }
  staged.store.write(staged.name, JSON.stringify({ consumed: true, key }));
  try {
    const freshRequest = metaRequest(context, staged.checked.operation, staged.checked.docId, staged.checked.variables);
    const { response, data } = await sendObserved(staged.envelope, staged.checked, bundle, freshRequest);
    const user = getUser(data);
    Object.assign(record, {
      httpStatus: response.status,
      responseKeys: Object.keys(data || {}),
      mutationKeys: Object.keys(data?.data?.useBarcelonaCreateOrUpdateBioLinkMutation || {}),
      errorCodes: (data?.errors || []).map(error => error?.extensions?.code ?? error?.code ?? null),
      state: response.status === 200 && !data?.errors?.length && !data?.error ? 'needs_readback' : 'needs_reconciliation',
      responseOwnerVerified: user ? String(user.id || '') === String(bundle.ownerId) : null,
    });
  } catch {
    record.state = 'needs_reconciliation';
    record.code = 'THREADS_PROFILE_REQUEST_UNCONFIRMED';
  }
  await writeRecord(file, record);
  return { ...record, journalPath: file };
}

export async function sendThreadsProfileBio({ key, expectedBio = PROFILE_BIO_TEXT } = {}) {
  if (expectedBio !== PROFILE_BIO_TEXT) fail('THREADS_PROFILE_CONTENT_MISMATCH');
  const file = journalPath(key);
  const previous = await readRecord(file);
  if (previous) {
    if (previous.expectedBio !== expectedBio) fail('THREADS_PROFILE_CONTENT_MISMATCH');
    return { ...previous, alreadyAttempted: true, retrySent: false };
  }
  const staged = await loadEnvelope('bio-write', key);
  if (staged.checked.variables.biography !== expectedBio) fail('THREADS_PROFILE_CONTENT_MISMATCH');
  const { bundle, context, snapshot: before } = await readProfileState();
  if (!before.ownerIdVerified || before.profileQueryStatus !== 200 || before.linksQueryStatus !== 200) {
    fail('THREADS_PROFILE_OWNER_NOT_VERIFIED');
  }
  const uploadId = staged.checked.variables.profile_picture_upload_id;
  const profilePictureUpdate = typeof uploadId === 'string' || Number.isSafeInteger(uploadId);
  if (before.bio === expectedBio && !profilePictureUpdate) {
    return { state: 'already_applied', writeCount: 0, before, expectedBio };
  }
  const claim = path.join(path.dirname(file), `request-${staged.checked.requestSha256}.json`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const claimHandle = await fs.open(claim, 'wx', 0o600).catch(error => {
    if (error.code === 'EEXIST') fail('THREADS_PROFILE_REQUEST_ALREADY_CLAIMED');
    throw error;
  });
  try { await claimHandle.writeFile(JSON.stringify({ key, requestSha256: staged.checked.requestSha256 }) + '\n'); }
  finally { await claimHandle.close(); }
  const record = { version: 1, key, owner: OWNER, kind: 'profile_bio', state: 'sending', writeCount: 1,
    operation: staged.checked.operation, docId: staged.checked.docId, requestSha256: staged.checked.requestSha256,
    expectedBio, profilePictureUpdate, before, browserWriteBlocked: true, helperClosed: true,
    executionMode: 'browser_assisted_http', sentAt: new Date().toISOString() };
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(record, null, 2) + '\n'); } finally { await handle.close(); }
  staged.store.write(staged.name, JSON.stringify({ consumed: true, key }));
  try {
    const freshRequest = metaRequest(context, staged.checked.operation, staged.checked.docId, staged.checked.variables);
    const { response, data } = await sendObserved(staged.envelope, staged.checked, bundle, freshRequest);
    const user = getUser(data);
    Object.assign(record, {
      httpStatus: response.status,
      responseKeys: Object.keys(data || {}),
      mutationKeys: Object.keys(data?.data || {}),
      errorCodes: (data?.errors || []).map(error => error?.extensions?.code ?? error?.code ?? null),
      state: response.status === 200 && !data?.errors?.length && !data?.error ? 'needs_readback' : 'needs_reconciliation',
      responseOwnerVerified: user ? String(user.id || '') === String(bundle.ownerId) : null,
    });
  } catch {
    record.state = 'needs_reconciliation';
    record.code = 'THREADS_PROFILE_REQUEST_UNCONFIRMED';
  }
  await writeRecord(file, record);
  return { ...record, journalPath: file };
}

export async function reconcileThreadsProfileLink({ key } = {}) {
  const file = journalPath(key);
  const record = await readRecord(file);
  if (!record) fail('THREADS_PROFILE_JOURNAL_MISSING');
  if (record.kind !== 'bio_link') fail('THREADS_PROFILE_JOURNAL_SCOPE_INVALID');
  const readback = await readProfileSnapshot();
  const verified = readback.ownerIdVerified && readback.linksQueryStatus === 200
    && readback.bioLinks?.some(link => link.url === record.expectedUrl && link.title === record.expectedTitle);
  Object.assign(record, { readback, checkedAt: new Date().toISOString(),
    state: verified || record.state === 'profile_verified' ? 'profile_verified' : 'needs_reconciliation',
    latestReadbackMatches: !!verified });
  await writeRecord(file, record);
  return record;
}

export async function reconcileThreadsProfileBio({ key } = {}) {
  const file = journalPath(key);
  const record = await readRecord(file);
  if (!record) fail('THREADS_PROFILE_JOURNAL_MISSING');
  if (record.kind !== 'profile_bio') fail('THREADS_PROFILE_JOURNAL_SCOPE_INVALID');
  const readback = await readProfileSnapshot();
  const photoVerified = !record.profilePictureUpdate
    || !!readback.profilePicturePathSha256 && readback.profilePicturePathSha256 !== record.before?.profilePicturePathSha256;
  const verified = readback.ownerIdVerified && readback.profileQueryStatus === 200
    && readback.bio === record.expectedBio && photoVerified;
  Object.assign(record, { readback, checkedAt: new Date().toISOString(),
    state: verified || record.state === 'profile_verified' ? 'profile_verified' : 'needs_reconciliation',
    latestReadbackMatches: !!verified });
  await writeRecord(file, record);
  return record;
}

export const THREADS_PROFILE_CONTRACT = Object.freeze({
  origin: ORIGIN,
  owner: OWNER,
  write: PROFILE_LINK_MUTATION,
  bioWrite: PROFILE_BIO_MUTATION,
  reads: PROFILE_READ,
});
