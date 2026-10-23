import test from 'node:test';
import assert from 'node:assert/strict';
import { validateThreadsProfileEnvelope, sanitizeThreadsProfileReadRequest,
  buildFreshThreadsProfileReadRequest, THREADS_PROFILE_CONTRACT } from '../threads-profile.mjs';

const ORIGIN = THREADS_PROFILE_CONTRACT.origin;
const now = Date.parse('2026-09-28T01:00:00.000Z');
const BIO = 'AI로 비교한 생활 이득 🧠\n최저가·혜택·여행 특가를 매일 정리해요\n전체 비교표는 👇 블로그에서';

function headers() {
  return {
    accept: '*/*',
    'content-type': 'application/x-www-form-urlencoded',
    origin: ORIGIN,
    referer: `${ORIGIN}/@lifehack__ailab`,
    'user-agent': 'test-only-browser-agent',
    'x-ig-app-id': 'test-only-app-id',
    'x-fb-lsd': 'test-only-lsd',
    'x-csrftoken': 'test-only-csrf',
    cookie: 'test-only-cookie',
  };
}

function request(operation, docId, variables, { url = `${ORIGIN}/graphql/query`, body } = {}) {
  const form = new URLSearchParams({ fb_api_req_friendly_name: operation, doc_id: docId,
    variables: JSON.stringify(variables), lsd: 'test-only-form-token' });
  return { method: 'POST', url, headers: headers(), body: body ?? form.toString() };
}

function writeEnvelope({ request: req, ...overrides } = {}) {
  return {
    version: 1,
    kind: 'write',
    owner: 'lifehack__ailab',
    observedAt: new Date(now).toISOString(),
    helperClosed: true,
    browserWriteBlocked: true,
    blockedReason: 'inspector',
    responseReceived: false,
    networkFailureBlocked: true,
    request: req ?? request(THREADS_PROFILE_CONTRACT.write.operation,
      THREADS_PROFILE_CONTRACT.write.docId,
      { url: 'https://cafe.naver.com/lifehackailab', title: '네이버 카페' }),
    ...overrides,
  };
}

function readEnvelope(kind = 'links-read') {
  const contract = kind === 'profile-read' ? THREADS_PROFILE_CONTRACT.reads.profile : THREADS_PROFILE_CONTRACT.reads.links;
  return { version: 1, kind, owner: 'lifehack__ailab', observedAt: new Date(now).toISOString(), helperClosed: true,
    responseStatus: 200,
    request: request(contract.operation, contract.docId, { __relay_internal__pv__BarcelonaIsLoggedInrelayprovider: true }) };
}

function bioVariables(overrides = {}) {
  return {
  external_url: 'https://blog.naver.com/aicandoanything',
  biography: BIO,
  username: 'lifehack__ailab',
  name: '생활이득AI연구소',
  is_private: false,
  profile_picture_upload_id: null,
  remove_profile_picture: false,
  copy_ig_profile_picture_to_text_post_app: false,
  ...overrides,
};
}

function bioWriteEnvelope(variables = bioVariables()) {
  const contract = THREADS_PROFILE_CONTRACT.bioWrite;
  const form = new URLSearchParams({
    fb_api_req_friendly_name: contract.operation,
    doc_id: contract.docId,
    variables: JSON.stringify(variables),
    fb_dtsg: 'test-only-form-token',
    jazoest: '2123',
    lsd: 'test-only-form-lsd',
  });
  return { version: 1, kind: 'bio-write', owner: 'lifehack__ailab', observedAt: new Date(now).toISOString(),
    helperClosed: true, browserWriteBlocked: true, blockedReason: 'inspector', responseReceived: false,
    networkFailureBlocked: true, request: request(contract.operation, contract.docId, variables, { body: form.toString() }) };
}

function rejects(code, envelope, options = { kind: 'write', now }) {
  assert.throws(() => validateThreadsProfileEnvelope(envelope, options), error => error.code === code);
}

test('accepts a fresh inspector-blocked observed bio-link mutation', () => {
  const checked = validateThreadsProfileEnvelope(writeEnvelope(), { now });
  assert.equal(checked.operation, 'useBarcelonaCreateOrUpdateBioLinkMutation');
  assert.equal(checked.docId, '38378537858458247');
  assert.equal(checked.variables.url, 'https://cafe.naver.com/lifehackailab');
  assert.equal(checked.variables.title, '네이버 카페');
  assert.equal(checked.variables.link_id, undefined);
  assert.equal(checked.headers.cookie, undefined);
});

test('accepts the observed null link_id used when Threads creates a new link', () => {
  const envelope = writeEnvelope({ request: request(THREADS_PROFILE_CONTRACT.write.operation,
    THREADS_PROFILE_CONTRACT.write.docId,
    { link_id: null, url: 'https://cafe.naver.com/lifehackailab', title: '네이버 카페' }) });
  const checked = validateThreadsProfileEnvelope(envelope, { now });
  assert.equal(checked.variables.link_id, null);
});

test('validates the exact observed profile biography mutation', () => {
  const checked = validateThreadsProfileEnvelope(bioWriteEnvelope(), { kind: 'bio-write', now });
  assert.equal(checked.operation, THREADS_PROFILE_CONTRACT.bioWrite.operation);
  assert.equal(checked.docId, THREADS_PROFILE_CONTRACT.bioWrite.docId);
  assert.equal(checked.variables.biography, BIO);
  rejects('THREADS_PROFILE_BIO_VARIABLES_INVALID', bioWriteEnvelope(bioVariables({ biography: 'unexpected text' })),
    { kind: 'bio-write', now });
  const photo = validateThreadsProfileEnvelope(bioWriteEnvelope(bioVariables({ profile_picture_upload_id: 'observed-upload-id' })),
    { kind: 'bio-write', now });
  assert.equal(photo.variables.profile_picture_upload_id, 'observed-upload-id');
  const numericPhoto = validateThreadsProfileEnvelope(bioWriteEnvelope(bioVariables({ profile_picture_upload_id: 1790564668432 })),
    { kind: 'bio-write', now });
  assert.equal(numericPhoto.variables.profile_picture_upload_id, 1790564668432);
  rejects('THREADS_PROFILE_BIO_VARIABLES_INVALID', bioWriteEnvelope(bioVariables({ profile_picture_upload_id: 'bad\nid' })),
    { kind: 'bio-write', now });
  rejects('THREADS_PROFILE_BIO_VARIABLES_INVALID', bioWriteEnvelope(bioVariables({ profile_picture_upload_id: 1.5 })),
    { kind: 'bio-write', now });
});

test('rejects a write without DevTools blocked-request evidence', () => {
  rejects('THREADS_PROFILE_BROWSER_WRITE_NOT_BLOCKED', writeEnvelope({ browserWriteBlocked: false }));
  rejects('THREADS_PROFILE_BROWSER_WRITE_NOT_BLOCKED', writeEnvelope({ blockedReason: 'other' }));
  rejects('THREADS_PROFILE_BROWSER_WRITE_NOT_BLOCKED', writeEnvelope({ responseReceived: true }));
  rejects('THREADS_PROFILE_BROWSER_WRITE_NOT_BLOCKED', writeEnvelope({ networkFailureBlocked: false }));
});

test('rejects stale, future, or open-helper envelopes', () => {
  rejects('THREADS_PROFILE_ENVELOPE_INVALID', writeEnvelope({ observedAt: new Date(now - 120001).toISOString() }));
  rejects('THREADS_PROFILE_ENVELOPE_INVALID', writeEnvelope({ observedAt: new Date(now + 5001).toISOString() }));
  rejects('THREADS_PROFILE_ENVELOPE_INVALID', writeEnvelope({ helperClosed: false }));
  rejects('THREADS_PROFILE_ENVELOPE_INVALID', writeEnvelope({ owner: 'other' }));
});

test('binds the write to Threads GraphQL and the observed mutation document', () => {
  rejects('THREADS_PROFILE_REQUEST_INVALID', writeEnvelope({ request: request(
    THREADS_PROFILE_CONTRACT.write.operation, THREADS_PROFILE_CONTRACT.write.docId,
    { url: 'https://cafe.naver.com/lifehackailab', title: '네이버 카페' }, { url: 'https://www.instagram.com/graphql/query' }) }));
  rejects('THREADS_PROFILE_OPERATION_UNVERIFIED', writeEnvelope({ request: request(
    'UnknownMutation', THREADS_PROFILE_CONTRACT.write.docId,
    { url: 'https://cafe.naver.com/lifehackailab', title: '네이버 카페' }) }));
});

test('limits the mutation variables to an expected bio link', () => {
  rejects('THREADS_PROFILE_LINK_VARIABLES_INVALID', writeEnvelope({ request: request(
    THREADS_PROFILE_CONTRACT.write.operation, THREADS_PROFILE_CONTRACT.write.docId,
    { url: 'https://cafe.naver.com/lifehackailab', title: '네이버 카페', username: 'other' }) }));
  rejects('THREADS_PROFILE_LINK_INVALID', writeEnvelope({ request: request(
    THREADS_PROFILE_CONTRACT.write.operation, THREADS_PROFILE_CONTRACT.write.docId,
    { url: 'javascript:alert(1)', title: '네이버 카페' }) }));
  rejects('THREADS_PROFILE_CONTENT_MISMATCH', writeEnvelope({ request: request(
    THREADS_PROFILE_CONTRACT.write.operation, THREADS_PROFILE_CONTRACT.write.docId,
    { url: 'https://cafe.naver.com/other', title: '네이버 카페' }) }));
});

test('validates the observed profile and bio-links read requests separately', () => {
  const profile = validateThreadsProfileEnvelope(readEnvelope('profile-read'), { kind: 'profile-read', now });
  const links = validateThreadsProfileEnvelope(readEnvelope('links-read'), { kind: 'links-read', now });
  assert.equal(profile.operation, 'BarcelonaProfileEditDialogQuery');
  assert.equal(links.operation, 'BarcelonaEditProfileLinksPageQuery');
  rejects('THREADS_PROFILE_READ_PROVENANCE_INVALID', { ...readEnvelope('links-read'), responseStatus: 201 }, { kind: 'links-read', now });
});

test('stores only the observed read contract and removes captured session material', () => {
  const source = readEnvelope('profile-read').request;
  const sanitized = sanitizeThreadsProfileReadRequest(source);
  const storedForm = new URLSearchParams(sanitized.body);
  assert.equal(sanitized.headers.cookie, undefined);
  assert.equal(sanitized.headers['x-csrftoken'], undefined);
  assert.equal(sanitized.headers['x-fb-lsd'], undefined);
  assert.equal(storedForm.get('fb_api_req_friendly_name'), THREADS_PROFILE_CONTRACT.reads.profile.operation);
  assert.equal(storedForm.get('doc_id'), THREADS_PROFILE_CONTRACT.reads.profile.docId);
  assert.equal(storedForm.get('lsd'), null);
  assert.deepEqual(JSON.parse(storedForm.get('variables')), { __relay_internal__pv__BarcelonaIsLoggedInrelayprovider: true });
});

test('rebuilds read requests with fresh tokens while keeping the observed route and query contract', () => {
  const envelope = readEnvelope('links-read');
  const checked = validateThreadsProfileEnvelope(envelope, { kind: 'links-read', now });
  const freshForm = new URLSearchParams({
    fb_dtsg: 'fresh-dtsg-test-value', jazoest: '2123', lsd: 'fresh-lsd-test-value',
    fb_api_req_friendly_name: checked.operation, doc_id: checked.docId,
    variables: JSON.stringify(checked.variables),
  });
  const request = buildFreshThreadsProfileReadRequest({ checked, freshRequest: {
    body: freshForm,
    headers: { cookie: 'fresh-cookie-test-value', 'x-csrftoken': 'fresh-csrf-test-value',
      'x-fb-lsd': 'fresh-lsd-test-value', 'x-ig-app-id': 'fresh-app-id' },
  } });
  const rebuiltForm = new URLSearchParams(request.body);
  assert.equal(request.url, `${ORIGIN}/graphql/query`);
  assert.equal(rebuiltForm.get('doc_id'), checked.docId);
  assert.equal(rebuiltForm.get('fb_api_req_friendly_name'), checked.operation);
  assert.equal(rebuiltForm.get('fb_dtsg'), 'fresh-dtsg-test-value');
  assert.equal(rebuiltForm.get('lsd'), 'fresh-lsd-test-value');
  assert.equal(request.headers['x-fb-lsd'], 'fresh-lsd-test-value');
  assert.equal(request.headers.referer, envelope.request.headers.referer);
});

test('sanitizes captured write tokens and rebuilds an exact mutation with fresh session parameters', () => {
  const source = bioWriteEnvelope();
  const sanitized = sanitizeThreadsProfileReadRequest(source.request);
  const form = new URLSearchParams(sanitized.body);
  assert.equal(sanitized.headers.cookie, undefined);
  assert.equal(sanitized.headers['x-csrftoken'], undefined);
  assert.equal(sanitized.headers['x-fb-lsd'], undefined);
  assert.equal(form.get('fb_dtsg'), null);
  assert.equal(form.get('jazoest'), null);
  assert.equal(form.get('lsd'), null);
  const checked = validateThreadsProfileEnvelope({ ...source, request: sanitized }, {
    kind: 'bio-write', now: now + 24 * 60 * 60 * 1000, allowSanitized: true,
  });
  const freshForm = new URLSearchParams({
    fb_api_req_friendly_name: checked.operation, doc_id: checked.docId,
    variables: JSON.stringify(checked.variables), fb_dtsg: 'fresh-test-dtsg',
    jazoest: '2987', lsd: 'fresh-test-lsd',
  });
  const rebuilt = buildFreshThreadsProfileReadRequest({ checked, freshRequest: {
    body: freshForm,
    headers: { cookie: 'fresh-test-cookie', 'x-csrftoken': 'fresh-test-csrf',
      'x-fb-lsd': 'fresh-test-lsd', 'x-ig-app-id': 'fresh-test-app' },
  } });
  assert.equal(rebuilt.url, `${ORIGIN}/graphql/query`);
  assert.equal(new URLSearchParams(rebuilt.body).get('fb_dtsg'), 'fresh-test-dtsg');
  assert.equal(new URLSearchParams(rebuilt.body).get('variables'), JSON.stringify(checked.variables));
});
