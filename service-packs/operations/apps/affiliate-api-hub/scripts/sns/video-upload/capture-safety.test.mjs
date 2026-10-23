import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sanitizeBody, sanitizeCapture, sanitizeHeaders, sanitizeUrl } from './capture-safety.mjs';
import { beginUploadObservation, collectUploadObservation } from './capture-observer.mjs';

const sentinels = [
  'SENTINEL_cookie_89',
  'SENTINEL_csrf_41',
  'SENTINEL_bearer_26',
  'SENTINEL_attestation_73',
  'SENTINEL_botguard_55',
  'SENTINEL_nonce_62',
  'SENTINEL_session_18',
  'SENTINEL_sig_34',
  'SENTINEL_form_token_90',
  'SENTINEL_nested_json_14',
  'SENTINEL_nested_url_67',
  'SENTINEL_response_88',
  'SENTINEL_chunk_bytes_23',
  'SENTINEL_upload_session_77',
  'SENTINEL_upload_ticket_32',
  'SENTINEL_ticket_27',
  'SENTINEL_proof_10',
  'SENTINEL_connection_65',
];

function assertNoSentinels(serialized) {
  for (const sentinel of sentinels) assert.equal(serialized.includes(sentinel), false);
}

test('synthetic JSON capture removes sensitive fields and nested serialized secrets while preserving ordinary values', () => {
  const input = {
    title: 'Exact title – 테스트',
    ai_generated: true,
    altered_content: false,
    upload_url: `https://upload.example.test/v1/upload/${sentinels[6]}?upload_id=${sentinels[6]}&X-Goog-Signature=${sentinels[7]}`,
    request: {
      headers: { 'Content-Type': 'application/json; charset=utf-8', Cookie: sentinels[0], Authorization: `Bearer ${sentinels[2]}` },
      body: JSON.stringify({ csrfToken: sentinels[1], attestation: sentinels[3], keep: 'decoded value' }),
    },
    serialized_form: new URLSearchParams([
      ['caption', '  keep spacing  '],
      ['session_id', sentinels[6]],
      ['nested', JSON.stringify({ token: sentinels[8], label: 'normal' })],
    ]).toString(),
    diagnostic: `payload={"nonce":"${sentinels[5]}","text":"normal"}`,
    serializedDelegationContext: sentinels[4],
    visitorData: sentinels[8],
    serviceIntegrityDimensions: { challenge: sentinels[3] },
    webResponse: sentinels[11],
    authData: sentinels[2],
    authenticationData: sentinels[2],
    clickTrackingParams: sentinels[9],
    trackingParams: sentinels[10],
    opaquePayload: Buffer.from(JSON.stringify({ authorization: sentinels[2], visible: 'retained inside safe blob' })).toString('base64'),
    uploadSession: sentinels[13],
    upload_session: sentinels[13],
    ingestToken: sentinels[8],
    connection: sentinels[17],
    uploadTicket: sentinels[14],
    ticket: sentinels[15],
    proof: sentinels[16],
  };

  const clean = sanitizeCapture(input);
  const serialized = JSON.stringify(clean);
  assert.equal(clean.title, input.title);
  assert.equal(clean.ai_generated, true);
  assert.equal(clean.altered_content, false);
  const safeBlob = JSON.parse(Buffer.from(clean.opaquePayload, 'base64').toString('utf8'));
  assert.equal(safeBlob.authorization, '[REMOVED]');
  assert.equal(safeBlob.visible, 'retained inside safe blob');
  assert.equal(clean.request.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.equal(clean.request.headers.Cookie, '[REMOVED]');
  assert.equal(clean.request.headers.Authorization, '[REMOVED]');
  assert.equal(clean.upload_url, `https://upload.example.test/[REMOVED]?upload_id=%5BREMOVED%5D&X-Goog-Signature=%5BREMOVED%5D`);
  assertNoSentinels(serialized);
});

test('synthetic form and nested encoded JSON/URL values are sanitized in memory', () => {
  const nestedJson = JSON.stringify({ access_token: sentinels[8], visible: 'exact value', signed_url: `https://media.example.test/nexus/v1/uploads/6b3102d4-7ccd-4d6a-9305-1234567890ab?sig=${sentinels[7]}` });
  const body = new URLSearchParams({
    title: 'Keep + plus and spaces',
    csrf_token: sentinels[1],
    metadata: nestedJson,
    next: `https://media.example.test/api/next?next=${encodeURIComponent(`https://private.example.test/upload/${sentinels[11]}?key=${sentinels[7]}`)}`,
  }).toString();

  const safe = sanitizeBody(body);
  const decoded = new URLSearchParams(safe);
  assert.equal(decoded.get('title'), 'Keep + plus and spaces');
  assert.equal(decoded.get('csrf_token'), '[REMOVED]');
  const metadata = JSON.parse(decoded.get('metadata'));
  assert.equal(metadata.visible, 'exact value');
  const serialized = JSON.stringify({ safe, metadata, next: decoded.get('next') });
  assertNoSentinels(serialized);
  assert.match(safe, /metadata=/);
});

test('URLs retain ordinary endpoint paths but remove query values and resumable/Nexus opaque path IDs', () => {
  const normal = sanitizeUrl('https://api.example.test/v2/video/create?title=short&nonce=SENTINEL_nonce_62#fragment');
  const resumable = sanitizeUrl('https://upload.example.test/api/resumable/4e365f60-a7a8-4e80-81d3-1578f501abc3/chunk?upload_id=SENTINEL_session_18');
  const nexus = sanitizeUrl('https://upload.youtube.com/nexus/v1/uploads/a876cf96-3dd0-4e8b-b89c-5978589502b3?X-Amz-Signature=SENTINEL_sig_34');
  const naverNexus = sanitizeUrl(`https://upload.naver.com/warp/${sentinels[6]}/upload/v4/a876cf96-3dd0-4e8b-b89c-5978589502b3/sessions?session=${sentinels[6]}`);
  const signedStorage = sanitizeUrl('https://storage.example.test/private/path/a876cf96-3dd0-4e8b-b89c-5978589502b3?X-Amz-Signature=SENTINEL_sig_34');
  const instagramUpload = sanitizeUrl('https://www.instagram.com/upload_video/shortPrivateId?signature=SENTINEL_sig_34');
  const signedFirstParty = sanitizeUrl('https://upload.youtube.com/privateUploadTicket?X-Goog-Signature=SENTINEL_sig_34');

  assert.equal(normal, 'https://api.example.test/v2/video/create?title=%5BREMOVED%5D&nonce=%5BREMOVED%5D');
  assert.equal(resumable, 'https://upload.example.test/api/resumable/[REMOVED]/chunk?upload_id=%5BREMOVED%5D');
  assert.equal(nexus, 'https://upload.youtube.com/nexus/v1/uploads/[REMOVED]?X-Amz-Signature=%5BREMOVED%5D');
  assert.equal(naverNexus, `https://upload.naver.com/warp/[REMOVED]/upload/v4/[REMOVED]/sessions?session=%5BREMOVED%5D`);
  assert.equal(signedStorage, 'https://storage.example.test/[REMOVED]?X-Amz-Signature=%5BREMOVED%5D');
  assert.equal(instagramUpload, 'https://www.instagram.com/upload_video/[REMOVED]?signature=%5BREMOVED%5D');
  assert.equal(signedFirstParty, 'https://upload.youtube.com/[REMOVED]?X-Goog-Signature=%5BREMOVED%5D');
  assertNoSentinels(JSON.stringify([normal, resumable, nexus, naverNexus, signedStorage, instagramUpload, signedFirstParty]));
});

test('headers retain only an explicit safe upload allowlist and mark credential header values as removed', () => {
  const safe = sanitizeHeaders({
    'Content-Type': 'video/mp4',
    'Content-Length': '1048576',
    'Content-Range': 'bytes 0-1048575/6291456',
    'X-Goog-Upload-Offset': '1048576',
    'X-Goog-Upload-Command': 'upload, finalize',
    Cookie: sentinels[0],
    'X-CSRF-Token': sentinels[1],
    'X-Attestation': sentinels[3],
    'X-Instagram-Rupload-Params': JSON.stringify({ media_type: 'video', upload_id: sentinels[13], xsharing_user_ids: [] }),
    'X-Unrelated-Debug': sentinels[9],
  });
  const serialized = JSON.stringify(safe);
  assert.equal(safe['Content-Range'], 'bytes 0-1048575/6291456');
  assert.equal(safe['X-Goog-Upload-Offset'], '1048576');
  assert.equal(safe.Cookie, '[REMOVED]');
  assert.equal(safe['X-CSRF-Token'], '[REMOVED]');
  assert.equal(safe['X-Attestation'], '[REMOVED]');
  assert.deepEqual(JSON.parse(safe['X-Instagram-Rupload-Params']), { media_type: 'video', upload_id: '[REMOVED]', xsharing_user_ids: [] });
  assert.equal('X-Unrelated-Debug' in safe, false);
  assertNoSentinels(serialized);
});

test('synthetic passive CDP observer pairs request and response, omits chunk bytes, and writes only sanitized artifacts', async () => {
  const requestId = 'SENTINEL_internal_cdp_request_id_100';
  const chunkRequestId = 'SENTINEL_internal_cdp_chunk_id_101';
  const profileRequestId = 'SENTINEL_internal_cdp_profile_id_102';
  const chunkPathId = 'd719fbde-8e5b-4b26-971e-196985aca0d7';
  const events = [
    { sequence: 1, method: 'Network.requestWillBeSent', params: { requestId: 'old', request: { url: 'https://www.youtube.com/accounts/oauth/login?token=SENTINEL_bearer_26', method: 'GET', headers: {} } } },
  ];
  const uploadEvents = [
    { sequence: 2, method: 'Network.requestWillBeSent', params: { requestId, request: { url: `https://www.youtube.com/upload/resumable/${chunkPathId}?upload_id=${sentinels[6]}`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '82', Cookie: sentinels[0] }, hasPostData: true } } },
    { sequence: 3, method: 'Network.requestWillBeSentExtraInfo', params: { requestId, headers: { Authorization: `Bearer ${sentinels[2]}`, 'X-CSRF-Token': sentinels[1], 'Content-Type': 'application/json' } } },
    { sequence: 4, method: 'Network.dataReceived', params: { requestId, dataLength: 1024, encodedDataLength: 1024 } },
    { sequence: 5, method: 'Network.responseReceived', params: { requestId, response: { url: `https://www.youtube.com/upload/resumable/${chunkPathId}?next=${sentinels[10]}`, status: 200, mimeType: 'application/json', headers: { 'Content-Type': 'application/json', 'Content-Length': '44', 'Set-Cookie': sentinels[0] } } } },
    { sequence: 6, method: 'Network.responseReceivedExtraInfo', params: { requestId, headers: { 'X-Attestation': sentinels[3], 'Content-Type': 'application/json' } } },
    { sequence: 7, method: 'Network.requestWillBeSent', params: { requestId: chunkRequestId, request: { url: `https://www.youtube.com/upload/resumable/${chunkPathId}/chunk?session=${sentinels[6]}`, method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-1023/6291456', 'Content-Length': '1024' }, hasPostData: true } } },
    { sequence: 8, method: 'Network.dataReceived', params: { requestId: chunkRequestId, dataLength: 1024, encodedDataLength: 1024 } },
    { sequence: 9, method: 'Network.responseReceived', params: { requestId: chunkRequestId, response: { url: `https://www.youtube.com/upload/resumable/${chunkPathId}/chunk`, status: 308, mimeType: 'video/mp4', headers: { 'Content-Range': 'bytes=0-1023', 'Content-Type': 'video/mp4' } } } },
    { sequence: 10, method: 'Network.requestWillBeSent', params: { requestId: 'analytics', request: { url: 'https://www.youtube.com/api/analytics/collect?token=SENTINEL_cookie_89', method: 'POST', headers: {} } } },
    { sequence: 11, method: 'Network.requestWillBeSent', params: { requestId: profileRequestId, request: { url: 'https://www.youtube.com/api/account/profile', method: 'POST', headers: { 'Content-Type': 'application/json' }, hasPostData: true } } },
  ];
  const commands = [];
  const bodyReadIds = [];
  let cursor = 0;
  const send = async (method, params = {}) => {
    commands.push(method);
    if (method === 'Network.getRequestPostData' || method === 'Network.getResponseBody') bodyReadIds.push(params.requestId);
    if (method === 'Network.getRequestPostData' && params.requestId === requestId) {
      return { postData: JSON.stringify({ title: 'Test upload', token: sentinels[8], altered_content: false }) };
    }
    if (method === 'Network.getRequestPostData' && params.requestId === chunkRequestId) {
      return { postData: sentinels[12] };
    }
    if (method === 'Network.getResponseBody' && params.requestId === requestId) {
      return { body: JSON.stringify({ session_id: sentinels[6], result: 'accepted' }) };
    }
    if (method === 'Network.getResponseBody' && params.requestId === chunkRequestId) {
      return { body: sentinels[12], base64Encoded: true };
    }
    return {};
  };
  const readEvents = async ({ afterSequence, limit }) => {
    if (afterSequence === undefined) return { cursor: events.at(-1)?.sequence ?? 0, events: [], hasMore: false, truncated: false };
    const pageEvents = events.filter((event) => event.sequence > afterSequence).slice(0, limit);
    const last = pageEvents.at(-1)?.sequence ?? afterSequence;
    cursor = Math.max(cursor, last);
    return { cursor, events: pageEvents, hasMore: last < events.at(-1).sequence, truncated: false };
  };
  const observation = await beginUploadObservation({ send, readEvents, allowedOrigins: ['https://www.youtube.com'] });
  assert.equal(observation.cursor, 1);
  events.push(...uploadEvents);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'video-upload-capture-test-'));
  try {
    const result = await collectUploadObservation({
      send,
      readEvents,
      observation,
      outputDir: directory,
      fileName: 'synthetic-youtube-upload.json',
      platform: 'youtube',
      requestFilter: (requestInfo) => {
        assert.deepEqual(Object.keys(requestInfo).sort(), ['method', 'url']);
        const { url, method } = requestInfo;
        return url.includes('/upload/resumable/') && ['POST', 'PUT'].includes(method);
      },
      limit: 100,
    });
    const text = await readFile(result.outputPath, 'utf8');
    const document = JSON.parse(text);
    assert.equal(result.requestCount, 2);
    const metadataRequest = document.requests.find((record) => record.request.headers['Content-Type'] === 'application/json');
    const chunkRequest = document.requests.find((record) => record.request.headers['Content-Type'] === 'video/mp4');
    assert.ok(metadataRequest);
    assert.ok(chunkRequest);
    assert.equal(metadataRequest.request.method, 'POST');
    assert.equal(metadataRequest.response.status, 200);
    assert.equal(metadataRequest.body.request.title, 'Test upload');
    assert.equal(metadataRequest.body.response.result, 'accepted');
    assert.equal(metadataRequest.bodyStatus.request, 'captured');
    assert.equal(metadataRequest.bodyStatus.response, 'captured');
    assert.deepEqual(chunkRequest.transfer[0], { sequence: 8, dataLength: 1024, encodedDataLength: 1024 });
    assert.equal(chunkRequest.body, undefined);
    assert.equal(chunkRequest.bodyStatus.request, 'not_json_or_form');
    assert.equal(chunkRequest.bodyStatus.response, 'not_json_or_form');
    assert.equal(commands.includes('Network.getRequestPostData'), true);
    assert.equal(commands.includes('Network.getResponseBody'), true);
    assert.equal(text.includes(requestId), false);
    assert.equal(text.includes(chunkRequestId), false);
    assert.equal(text.includes(profileRequestId), false);
    assert.equal(text.includes('api/analytics/collect'), false);
    assert.equal(text.includes('/api/account/profile'), false);
    assert.equal(bodyReadIds.includes(profileRequestId), false);
    assertNoSentinels(text);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('synthetic observer accepts only exact HTTPS origins and reports missing body availability without error text', async () => {
  let baselineArgs;
  let cursor = 0;
  const events = [];
  const send = async (method) => {
    if (method === 'Network.getResponseBody') throw new Error(`unavailable ${sentinels[11]}`);
    throw new Error(`unexpected ${sentinels[8]}`);
  };
  const readEvents = async (args) => {
    if (args.afterSequence === undefined) {
      baselineArgs = args;
      return { cursor: 0, events: [], hasMore: false };
    }
    const page = events.filter((event) => event.sequence > args.afterSequence);
    return { cursor: page.at(-1)?.sequence ?? args.afterSequence, events: page, hasMore: false };
  };
  await assert.rejects(
    () => beginUploadObservation({ send: async () => ({}), readEvents, allowedOrigins: ['http://www.youtube.com'] }),
    (error) => error.code === 'CDP_ORIGIN_ALLOWLIST_INVALID',
  );
  const observation = await beginUploadObservation({ send: async () => ({}), readEvents, allowedOrigins: ['https://www.youtube.com'] });
  assert.equal(baselineArgs.afterSequence, undefined);
  events.push(
    { sequence: 1, method: 'Network.requestWillBeSent', params: { requestId: 'synthetic-inline', request: { url: 'https://www.youtube.com/upload/video?session=SENTINEL_session_18', method: 'POST', headers: { 'Content-Type': 'application/json' }, hasPostData: true, postData: JSON.stringify({ title: 'inline metadata', authData: sentinels[2] }) } } },
    { sequence: 2, method: 'Network.responseReceived', params: { requestId: 'synthetic-inline', response: { url: 'https://www.youtube.com/upload/video', status: 503, mimeType: 'application/json', headers: { 'Content-Type': 'application/json' } } } },
  );
  const directory = await mkdtemp(path.join(os.tmpdir(), 'video-upload-capture-body-status-'));
  try {
    const result = await collectUploadObservation({
      send,
      readEvents,
      observation,
      outputDir: directory,
      fileName: 'synthetic-missing-body.json',
      platform: 'youtube',
      requestFilter: ({ url, method }) => url.includes('/upload/video') && method === 'POST',
    });
    const stored = await readFile(result.outputPath, 'utf8');
    const document = JSON.parse(stored);
    assert.equal(document.requests[0].body.request.title, 'inline metadata');
    assert.equal(document.requests[0].bodyStatus.request, 'captured');
    assert.equal(document.requests[0].bodyStatus.response, 'unavailable');
    assert.equal(stored.includes('unavailable '), false);
    assert.equal(stored.includes('unexpected '), false);
    assertNoSentinels(stored);
    await assert.rejects(
      () => collectUploadObservation({ send: async () => ({}), readEvents, observation, outputDir: directory, fileName: 'no-filter.json', platform: 'youtube' }),
      (error) => error.code === 'CDP_REQUEST_FILTER_REQUIRED',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('synthetic metadata-only route saves safe field names without reading request or response bodies', async () => {
  const events = [];
  let bodyApiCalls = 0;
  const send = async (method) => {
    if (method === 'Network.getRequestPostData' || method === 'Network.getResponseBody') bodyApiCalls += 1;
    return {};
  };
  const readEvents = async ({ afterSequence }) => {
    if (afterSequence === undefined) return { cursor: 0, events: [], hasMore: false };
    const page = events.filter((event) => event.sequence > afterSequence);
    return { cursor: page.at(-1)?.sequence ?? afterSequence, events: page, hasMore: false };
  };
  const observation = await beginUploadObservation({ send, readEvents, allowedOrigins: ['https://www.instagram.com'] });
  events.push({
    sequence: 1,
    method: 'Network.requestWillBeSent',
    params: {
      requestId: 'synthetic-metadata-only',
      request: {
        url: `https://www.instagram.com/api/upload_video?upload_id=${sentinels[13]}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        hasPostData: true,
        postData: JSON.stringify({ title: 'private title', authData: sentinels[2], altered_content: false }),
      },
    },
  });
  const directory = await mkdtemp(path.join(os.tmpdir(), 'video-upload-capture-metadata-'));
  try {
    const result = await collectUploadObservation({
      send,
      readEvents,
      observation,
      outputDir: directory,
      fileName: 'synthetic-metadata-only.json',
      platform: 'instagram',
      requestFilter: ({ url, method }) => url.includes('/upload_video') && method === 'POST' ? 'metadata_only' : false,
    });
    const stored = await readFile(result.outputPath, 'utf8');
    const record = JSON.parse(stored).requests[0];
    assert.deepEqual(record.request.fieldNames, ['title', 'authData', 'altered_content']);
    assert.equal(record.body, undefined);
    assert.equal(record.bodyStatus.request, 'not_classified');
    assert.equal(bodyApiCalls, 0);
    assertNoSentinels(stored);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
