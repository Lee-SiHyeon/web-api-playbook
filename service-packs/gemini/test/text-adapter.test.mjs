import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCapturedTextRequest, inspectCapturedAttachmentReference } from '../src/text-adapter.mjs';
import { validateObservedContract } from '../src/contract.mjs';
import { SERVICE_ID, SERVICE_ORIGIN } from '../src/constants.mjs';

function contract() {
  return validateObservedContract({
    version: 1,
    service: SERVICE_ID,
    origin: SERVICE_ORIGIN,
    observedAt: '2026-10-06T00:00:00.000Z',
    auth: { origins: [SERVICE_ORIGIN], cookieNames: ['AUTH_COOKIE'], headerNames: [] },
    assetOrigins: [],
    operations: {
      text: {
        observation: { request: true, requestResponse: false },
        effect: 'mutation', retryPolicy: 'never',
        request: {
          method: 'POST', origin: SERVICE_ORIGIN,
          path: '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
          queryKeys: ['bl', 'f.sid', 'hl', '_reqid', 'rt'],
          headerNames: ['content-type', 'referer', 'x-same-domain'],
          contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
          bodyFieldNames: ['f.req', 'at'],
        },
      },
    },
  });
}

function session() {
  return {
    version: 1, service: SERVICE_ID, origin: SERVICE_ORIGIN, capturedAt: '2026-10-06T00:00:00.000Z',
    cookies: [{ name: 'AUTH_COOKIE', value: 'cookie-memory-only' }], headers: {},
    requestHeaders: {},
    batchContext: {
      at: 'fresh-token-memory-only', fSid: 'session-memory-only', buildLabel: 'build_1', locale: 'ko',
      requestType: 'c', sourcePath: '/app', requestId: '1234', historyListArgs: [28, null, [0, null, 1]],
    },
  };
}

function capture() {
  const prompt = 'API 연결 확인용. 답변은 CORE_SMOKE_OK 한 단어만 출력해.';
  const inner = Array(99).fill(null);
  inner[0] = [prompt, 1, null, null, null, null, 1];
  inner[59] = '123e4567-e89b-12d3-a456-426614174000';
  const outer = [null, JSON.stringify(inner)];
  const form = new URLSearchParams([['f.req', JSON.stringify(outer)], ['at', 'captured-token-memory-only']]);
  const url = new URL('/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=build_1&f.sid=session-memory-only&hl=ko&_reqid=1234&rt=c', SERVICE_ORIGIN);
  return { prompt, request: { url: url.href, method: 'POST', body: form.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' } } };
}

test('builds a direct text request from the captured StreamGenerate template without storing session values', () => {
  const observed = contract();
  const current = session();
  const captured = capture();
  const exact = buildCapturedTextRequest(observed, current, captured.request, {
    prompt: captured.prompt, preserveClientRequestId: true, preserveCapturedToken: true,
  });
  assert.equal(exact.body, captured.request.body);
  assert.deepEqual(exact.query.map(([name]) => name), ['bl', 'f.sid', 'hl', '_reqid', 'rt']);
  assert.throws(() => buildCapturedTextRequest(observed, current, captured.request, {
    prompt: 'different task intent', preserveClientRequestId: true, preserveCapturedToken: true,
  }), { code: 'TEXT_CAPTURE_INTENT_MISMATCH' });

  const updated = buildCapturedTextRequest(observed, current, captured.request, { prompt: '새 요청 CORE_SMOKE_OK' });
  const fields = new URLSearchParams(updated.body);
  const outer = JSON.parse(fields.get('f.req'));
  const inner = JSON.parse(outer[1]);
  assert.equal(inner[0][0], '새 요청 CORE_SMOKE_OK');
  assert.match(inner[59], /^[0-9a-f-]{36}$/i);
  assert.notEqual(inner[59], '123e4567-e89b-12d3-a456-426614174000');
  assert.equal(fields.get('at'), 'fresh-token-memory-only');
});

test('rejects a captured text request from another origin or with a changed prompt field path', () => {
  const observed = contract();
  const current = session();
  const captured = capture();
  assert.throws(() => buildCapturedTextRequest(observed, current, { ...captured.request, url: 'https://flow.google.com/_/StreamGenerate' }, { prompt: 'test' }), { code: 'REQUEST_ORIGIN_BLOCKED' });
  const form = new URLSearchParams(captured.request.body);
  form.set('f.req', JSON.stringify([null, JSON.stringify(Array(99).fill(null))]));
  assert.throws(() => buildCapturedTextRequest(observed, current, { ...captured.request, body: form.toString() }, { prompt: 'test' }), { code: 'TEXT_TEMPLATE_INVALID' });
});

test('binds a captured attachment message to the opaque SDK upload response in memory', () => {
  const captured = capture();
  const attachmentRef = Object.freeze({ filename: 'api-attachment.txt', mimeType: 'text/plain', dh: 'opaque-sdk-response' });
  const outer = JSON.parse(new URLSearchParams(captured.request.body).get('f.req'));
  const inner = JSON.parse(outer[1]);
  inner[18] = { uploadedFiles: [{ fileId: 'local-queue-id', ...attachmentRef }] };
  const form = new URLSearchParams(captured.request.body);
  form.set('f.req', JSON.stringify([null, JSON.stringify(inner)]));
  const inspected = inspectCapturedAttachmentReference({ ...captured.request, body: form.toString() }, attachmentRef);
  assert.deepEqual(inspected, {
    matched: true,
    sourceShapeMatchCount: 1,
    sourceTupleMatchCount: 0,
    uploadedFilesTupleMatchCount: 1,
    responsePayloadMatchCount: 1,
    filenameMatchCount: 1,
    mimeTypeMatchCount: 1,
    fileSizeMatchCount: 0,
    uploadedFilesArrayCount: 1,
    fileIdPresent: true,
    sourceValueCorrelationMatch: false,
    sourceParentValueMatchCount: 0,
    sourceLayout: null,
    contextValueIsNumber: false,
    contextEqualsFileSize: null,
  });
  assert.throws(() => inspectCapturedAttachmentReference({ ...captured.request, body: captured.request.body }, attachmentRef), {
    code: 'TEXT_ATTACHMENT_CAPTURE_MISMATCH',
  });
  assert.equal(JSON.stringify(inspected).includes(attachmentRef.dh), false);
});

test('binds the observed Aqc VE/dqc tuple and keeps the Gl context number separate from file size', () => {
  const captured = capture();
  const attachmentRef = Object.freeze({ filename: 'api-attachment.txt', mimeType: 'text/plain',
    dh: 'opaque-sdk-response', fileSizeBytes: 19 });
  const outer = JSON.parse(new URLSearchParams(captured.request.body).get('f.req'));
  const inner = JSON.parse(outer[1]);
  // Aqc sets VE filename plus dqc dh/Gl-context/null/MIME; size is proven by the upload query.
  inner[18] = [[[attachmentRef.dh, 777, null, attachmentRef.mimeType], attachmentRef.filename]];
  const form = new URLSearchParams(captured.request.body);
  form.set('f.req', JSON.stringify([null, JSON.stringify(inner)]));
  const inspected = inspectCapturedAttachmentReference({ ...captured.request, body: form.toString() }, attachmentRef);
  assert.equal(inspected.matched, true);
  assert.equal(inspected.sourceShapeMatchCount, 0);
  assert.equal(inspected.sourceTupleMatchCount, 1);
  assert.equal(inspected.sourceParentValueMatchCount, 1);
  assert.equal(inspected.uploadedFilesTupleMatchCount, 0);
  assert.equal(inspected.responsePayloadMatchCount, 1);
  assert.equal(inspected.filenameMatchCount, 1);
  assert.equal(inspected.mimeTypeMatchCount, 1);
  assert.equal(inspected.uploadedFilesArrayCount, 0);
  assert.equal(inspected.fileIdPresent, false);
  assert.equal(inspected.fileSizeMatchCount, 0);
  assert.equal(inspected.sourceValueCorrelationMatch, true);
});

test('binds compact dh-context-MIME values only beneath the matching VE filename parent', () => {
  const captured = capture();
  const attachmentRef = Object.freeze({ filename: 'api-attachment.txt', mimeType: 'text/plain',
    dh: 'opaque-sdk-response', fileSizeBytes: 19 });
  const outer = JSON.parse(new URLSearchParams(captured.request.body).get('f.req'));
  const inner = JSON.parse(outer[1]);
  inner[18] = [[[attachmentRef.dh, 777, attachmentRef.mimeType], attachmentRef.filename]];
  const form = new URLSearchParams(captured.request.body);
  form.set('f.req', JSON.stringify([null, JSON.stringify(inner)]));
  const inspected = inspectCapturedAttachmentReference({ ...captured.request, body: form.toString() }, attachmentRef);
  assert.equal(inspected.matched, true);
  assert.equal(inspected.sourceTupleMatchCount, 0);
  assert.equal(inspected.sourceParentValueMatchCount, 1);
  assert.equal(inspected.sourceValueCorrelationMatch, true);
});

test('binds source fields held under one VE filename parent when nested metadata is not a recognized tuple', () => {
  const captured = capture();
  const attachmentRef = Object.freeze({ filename: 'api-attachment.txt', mimeType: 'text/plain',
    dh: 'opaque-sdk-response', fileSizeBytes: 19 });
  const outer = JSON.parse(new URLSearchParams(captured.request.body).get('f.req'));
  const inner = JSON.parse(outer[1]);
  // Keep the filename at the source VE field-2 position, with source values
  // inside its child metadata object. This exercises parent-scoped correlation.
  inner[18] = [[{ dh: attachmentRef.dh, size: attachmentRef.fileSizeBytes, mimeType: attachmentRef.mimeType },
    attachmentRef.filename]];
  const form = new URLSearchParams(captured.request.body);
  form.set('f.req', JSON.stringify([null, JSON.stringify(inner)]));
  const inspected = inspectCapturedAttachmentReference({ ...captured.request, body: form.toString() }, attachmentRef);
  assert.equal(inspected.matched, true);
  assert.equal(inspected.sourceShapeMatchCount, 0);
  assert.equal(inspected.sourceTupleMatchCount, 0);
  assert.equal(inspected.sourceValueCorrelationMatch, true);
  assert.equal(inspected.sourceParentValueMatchCount, 1);
  assert.equal(inspected.responsePayloadMatchCount, 1);
  assert.equal(inspected.filenameMatchCount, 1);
  assert.equal(inspected.mimeTypeMatchCount, 1);
  assert.ok(inspected.fileSizeMatchCount >= 1);
});

test('reports only safe source tuple occurrence counts, shapes, hashes, and standard MIME on mismatch', () => {
  const captured = capture();
  const attachmentRef = Object.freeze({ filename: 'api-attachment.txt', mimeType: 'text/plain',
    dh: 'opaque-sdk-response', fileSizeBytes: 19 });
  const outer = JSON.parse(new URLSearchParams(captured.request.body).get('f.req'));
  const inner = JSON.parse(outer[1]);
  inner[18] = [[['different-opaque-response', 777, null, 'text/plain'], attachmentRef.filename]];
  const form = new URLSearchParams(captured.request.body);
  form.set('f.req', JSON.stringify([null, JSON.stringify(inner)]));
  let error;
  try {
    inspectCapturedAttachmentReference({ ...captured.request, body: form.toString() }, attachmentRef);
  } catch (caught) { error = caught; }
  assert.equal(error?.code, 'TEXT_ATTACHMENT_CAPTURE_MISMATCH');
  const diagnostic = error.details.attachmentBinding;
  assert.equal(diagnostic.responsePayloadMatchCount, 0);
  assert.equal(diagnostic.filenameMatchCount, 1);
  assert.equal(diagnostic.mimeTypeMatchCount, 1);
  assert.equal(diagnostic.sourceProtoTupleMatchCount, 0);
  assert.equal(diagnostic.sourceProtoCandidates.length, 1);
  assert.equal(diagnostic.sourceProtoCandidates[0].filenameMatched, true);
  assert.equal(diagnostic.sourceProtoCandidates[0].dhMatched, false);
  assert.equal(diagnostic.sourceProtoCandidates[0].mimeTypeMatched, true);
  assert.match(diagnostic.sourceProtoCandidates[0].dhSha256, /^[a-f0-9]{64}$/);
  const serialized = JSON.stringify(error.details);
  assert.equal(serialized.includes(attachmentRef.filename), false);
  assert.equal(serialized.includes(attachmentRef.dh), false);
  assert.equal(serialized.includes('different-opaque-response'), false);
});

test('does not bind a source-value match when any opaque/reference value is duplicated', () => {
  const captured = capture();
  const attachmentRef = Object.freeze({ filename: 'api-attachment.txt', mimeType: 'text/plain',
    dh: 'opaque-sdk-response', fileSizeBytes: 19 });
  const outer = JSON.parse(new URLSearchParams(captured.request.body).get('f.req'));
  const inner = JSON.parse(outer[1]);
  inner[18] = [[[attachmentRef.dh, attachmentRef.fileSizeBytes, attachmentRef.mimeType], attachmentRef.filename]];
  inner[19] = attachmentRef.dh;
  const form = new URLSearchParams(captured.request.body);
  form.set('f.req', JSON.stringify([null, JSON.stringify(inner)]));
  assert.throws(() => inspectCapturedAttachmentReference({ ...captured.request, body: form.toString() }, attachmentRef), {
    code: 'TEXT_ATTACHMENT_CAPTURE_MISMATCH',
  });
});
