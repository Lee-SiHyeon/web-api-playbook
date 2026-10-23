import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { GeminiWebClient } from '../src/client.mjs';
import { DEFAULT_CONTRACT_PATH, loadObservedContract } from '../src/contract.mjs';
import { parseAttachmentUploadOptions } from '../src/cli.mjs';
import { readAttachmentUploadEnvelopeFromStdin, validateSessionBundle } from '../src/session.mjs';
import {
  cancelAttachmentUploadSession, queryAttachmentUploadSession, resumeAttachmentUploadSession,
  sameAttachmentUploadSessionUrl, uploadAttachmentOnce,
} from '../src/attachment-upload.mjs';

const tempDirs = [];
const cookie = { name: 'SID', value: 'ordinary-session-value', domain: '.google.com', path: '/', secure: true, expires: 0 };
const uploadCookieScopes = [{ name: 'SID', domain: '.google.com', path: '/', secure: true }];

function contract(overrides = {}) {
  return {
    version: 1,
    capability: 'attachment_upload',
    source: {
      origin: 'https://push.clients6.google.com',
      method: 'POST',
      pathFamily: '/upload/',
      queryKeyNames: [],
      contentType: 'application/x-www-form-urlencoded',
      metadataBodyPrefix: 'File name: ',
      startProtocol: 'resumable',
      startCommand: 'start',
      fileLengthHeader: 'x-goog-upload-header-content-length',
      headerNames: ['accept', 'content-type', 'cookie', 'origin', 'push-id', 'referer', 'user-agent',
        'x-client-pctx', 'x-goog-upload-command', 'x-goog-upload-header-content-length', 'x-goog-upload-protocol', 'x-tenant-id'],
      cookieNames: ['SID'],
      cookieScopes: uploadCookieScopes,
    },
    resumable: {
      startSuccessStatus: 200,
      uploadUrlHeader: 'x-goog-upload-url',
      uploadUrlOrigins: ['https://push.clients6.google.com'],
      uploadUrlPathPrefixes: ['/upload/'],
      uploadMethod: 'POST',
      commandHeader: 'x-goog-upload-command',
      finalizeCommand: 'upload, finalize',
      querySupported: true,
      queryMethod: 'POST',
      queryCommand: 'query',
      uploadStatusHeader: 'x-goog-upload-status',
      sizeReceivedHeader: 'x-goog-upload-size-received',
      chunkGranularityHeader: 'x-goog-upload-chunk-granularity',
      resumeSupported: true,
      offsetHeader: 'x-goog-upload-offset',
      cancelSupported: false,
      nativeContinuation: {
        method: 'POST',
        headerNames: ['x-goog-upload-command', 'x-goog-upload-offset'],
        cookieNames: [],
        commandHeader: 'x-goog-upload-command',
        commandValue: 'upload, finalize',
        offsetHeader: 'x-goog-upload-offset',
        initialOffset: 0,
        bodySemantics: 'selected_file_bytes',
      },
    },
    ...overrides,
  };
}

test('matches native upload continuation to the exact server-issued session query pairs', () => {
  const issued = 'https://push.clients6.google.com/upload/?upload_id=opaque-id&upload_protocol=resumable';
  const reordered = 'https://push.clients6.google.com/upload/?upload_protocol=resumable&upload_id=opaque-id';
  const encoded = 'https://push.clients6.google.com/upload/?upload_protocol=resumable&upload_id=opaque%2Did';

  assert.equal(sameAttachmentUploadSessionUrl(reordered, issued), true);
  assert.equal(sameAttachmentUploadSessionUrl(encoded, issued), true);
  assert.equal(sameAttachmentUploadSessionUrl('https://push.clients6.google.com/upload/?upload_id=other&upload_protocol=resumable', issued), false);
  assert.equal(sameAttachmentUploadSessionUrl(`${issued}&extra=1`, issued), false);
  assert.equal(sameAttachmentUploadSessionUrl(`${issued}&upload_id=duplicate`, issued), false);
  assert.equal(sameAttachmentUploadSessionUrl(issued.replace('push.clients6.google.com', 'example.invalid'), issued), false);
  assert.equal(sameAttachmentUploadSessionUrl(issued.replace('/upload/', '/other/'), issued), false);
});

function capture() {
  return {
    url: 'https://push.clients6.google.com/upload/',
    method: 'POST',
    contentType: 'application/x-www-form-urlencoded',
    body: Buffer.from('File name: api-protocol42.txt'),
    declaredFileBytes: 14,
    headerNames: [...contract().source.headerNames],
    headers: {
      accept: '*/*',
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://gemini.google.com',
      'push-id': 'neutral-push-id',
      referer: 'https://gemini.google.com/app',
      'user-agent': 'captured-browser-agent',
      'x-client-pctx': 'captured-client-context',
      'x-goog-upload-command': 'start',
      'x-goog-upload-header-content-length': '14',
      'x-goog-upload-protocol': 'resumable',
      'x-tenant-id': 'captured-tenant',
    },
  };
}

async function tempDir() {
  const base = process.env.TMPDIR || path.join(os.homedir(), '.nad-scratch', 'tmp');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(base, 'gemini-attachment-upload-'));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test('CLI upload command requires a stable intent, owner gate, piped capture, and confirmation', () => {
  const args = [
    '--envelope-stdin', '--expect-owner', 'user@example.com', '--caller-intent', 'gemini-attachment-upload-cli-test', '--confirm',
  ];
  assert.deepEqual(parseAttachmentUploadOptions(args), {
    envelopeStdin: true,
    confirmed: true,
    contractPath: DEFAULT_CONTRACT_PATH,
    expectedOwner: 'user@example.com',
    callerIntent: 'gemini-attachment-upload-cli-test',
  });
  assert.throws(() => parseAttachmentUploadOptions(args.filter((item) => item !== '--confirm')), { code: 'MUTATION_CONFIRMATION_REQUIRED' });
  assert.throws(() => parseAttachmentUploadOptions(args.filter((item) => item !== '--envelope-stdin')), { code: 'ATTACHMENT_UPLOAD_ENVELOPE_STDIN_REQUIRED' });
});

test('sends the captured start request, finalizes only to the returned session URL, and queries server metadata', async () => {
  const root = await tempDir();
  const calls = [];
  const file = { name: 'api-protocol42.txt', mimeType: 'text/plain', body: Buffer.from('PROTOCOL42:42\n') };
  const fetchImpl = async (url, init) => {
    calls.push({ url: new URL(url).href, method: init.method, cookie: new Headers(init.headers).get('cookie'),
      command: new Headers(init.headers).get('x-goog-upload-command'), offset: new Headers(init.headers).get('x-goog-upload-offset'),
      body: Buffer.from(init.body ?? []) });
    if (calls.length === 1) {
      return new Response('', { status: 200, headers: {
        'x-goog-upload-url': 'https://push.clients6.google.com/upload/session?upload_id=opaque',
        'x-goog-upload-chunk-granularity': '262144',
      } });
    }
    if (calls.length === 2) {
      return new Response(JSON.stringify({ file: { name: file.name, mimeType: file.mimeType, size: file.body.length, id: 'opaque-server-id' } }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-goog-upload-status': 'final', 'x-goog-upload-size-received': '14' },
      });
    }
    return new Response('', { status: 200, headers: {
      'x-goog-upload-status': 'final', 'x-goog-upload-size-received': '14',
    } });
  };
  const result = await uploadAttachmentOnce({
    contract: contract(), capture: capture(), uploadCookies: [cookie], file,
    actor: 'user@example.com', callerIntent: 'gemini-attachment-upload-test', journalRoot: root, fetchImpl,
  });

  assert.equal(result.status, 'verified');
  assert.equal(result.directDispatchCount, 2);
  assert.equal(result.startDispatchCount, 1);
  assert.equal(result.transferDispatchCount, 1);
  assert.equal(result.httpRequestCount, 3);
  assert.equal(result.uploadedFileReadbackVerified, true);
  assert.equal(result.fileName, file.name);
  assert.equal(result.fileBytes, file.body.length);
  assert.equal(result.fileSha256, createHash('sha256').update(file.body).digest('hex'));
  assert.equal(result.upload.metadata.fileNameMatched, true);
  assert.equal(result.upload.metadata.fileSizeMatched, true);
  assert.equal(result.upload.metadata.fileIdPresent, true);
  assert.equal(result.uploadUrl, undefined);
  assert.equal(calls[0].cookie, 'SID=ordinary-session-value');
  assert.equal(calls[0].body.toString(), 'File name: api-protocol42.txt');
  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[1].command, 'upload, finalize');
  assert.equal(calls[1].offset, '0');
  assert.deepEqual(calls[1].body, file.body);
  assert.equal(calls[1].cookie, null);
  assert.equal(calls[2].command, 'query');
  assert.equal(calls[2].cookie, null);
  const jobs = (await readdir(root)).filter((name) => name.endsWith('.json'));
  assert.equal(jobs.length, 2);
  const locks = await readdir(path.join(root, 'dispatch-locks'));
  assert.equal(locks.length, 0);
});

test('reports a rejected transfer separately from an unresolved readback', async () => {
  const file = { name: 'api-protocol42.txt', mimeType: 'text/plain', body: Buffer.from('PROTOCOL42:42\n') };
  let calls = 0;
  const result = await uploadAttachmentOnce({
    contract: contract(), capture: capture(), uploadCookies: [cookie], file,
    actor: 'user@example.com', callerIntent: 'gemini-attachment-upload-rejected-test', journalRoot: await tempDir(),
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return new Response('', { status: 200, headers: {
        'x-goog-upload-url': 'https://push.clients6.google.com/upload/session?upload_id=opaque',
      } });
      if (calls === 2) return new Response('upload rejected', { status: 400, headers: { 'content-type': 'text/plain' } });
      return new Response('', { status: 200, headers: {
        'x-goog-upload-status': 'active', 'x-goog-upload-size-received': '0',
      } });
    },
  });
  assert.equal(result.status, 'upload_rejected');
  assert.equal(result.directDispatchCount, 2);
  assert.equal(result.httpRequestCount, 3);
  assert.equal(result.upload.httpStatus, 400);
  assert.equal(result.query.uploadStatus, 'active');
  assert.equal(result.query.sizeReceived, 0);
  assert.equal(result.uploadedFileReadbackVerified, false);
  assert.equal(result.journalReconciled, false);
});

test('retains a server-issued session in memory for a read-only query when continuation capture fails', async () => {
  const calls = [];
  await assert.rejects(uploadAttachmentOnce({
    contract: contract(), capture: capture(), uploadCookies: [cookie],
    file: { name: 'api-protocol42.txt', mimeType: 'text/plain', body: Buffer.from('PROTOCOL42:42\n') },
    actor: 'user@example.com', callerIntent: 'gemini-attachment-upload-capture-failure-test', journalRoot: await tempDir(),
    continuationCaptureProvider: async () => {
      throw Object.assign(new Error('captured continuation unavailable'), { code: 'ATTACHMENT_UPLOAD_CONTINUATION_CAPTURE_FAILED' });
    },
    fetchImpl: async (url, init) => {
      const command = new Headers(init.headers).get('x-goog-upload-command');
      calls.push({ path: new URL(url).pathname, command });
      if (command === 'start') return new Response('', { status: 200, headers: {
        'x-goog-upload-url': 'https://push.clients6.google.com/upload/session?upload_id=opaque',
      } });
      return new Response('', { status: 200, headers: {
        'x-goog-upload-status': 'active', 'x-goog-upload-size-received': '0',
      } });
    },
  }), (error) => {
    assert.equal(error.code, 'ATTACHMENT_UPLOAD_CONTINUATION_CAPTURE_FAILED');
    assert.equal(error.details.directDispatchCount, 1);
    assert.equal(error.details.startDispatchCount, 1);
    assert.equal(error.details.transferDispatchCount, 0);
    assert.deepEqual(error.details.queryReadback, { httpStatus: 200, uploadStatus: 'active', sizeReceived: 0 });
    return true;
  });
  assert.deepEqual(calls, [
    { path: '/upload/', command: 'start' },
    { path: '/upload/session', command: 'query' },
  ]);
});

test('blocks the default CLI replay before start when a native continuation header value is missing', async () => {
  let calls = 0;
  const observed = contract();
  observed.resumable = {
    ...observed.resumable,
    nativeContinuation: {
      ...observed.resumable.nativeContinuation,
      headerNames: [...observed.resumable.nativeContinuation.headerNames, 'content-type'],
    },
  };
  await assert.rejects(uploadAttachmentOnce({
    contract: observed,
    capture: capture(),
    uploadCookies: [cookie],
    file: { name: 'api-protocol42.txt', mimeType: 'text/plain', body: Buffer.from('PROTOCOL42:42\n') },
    actor: 'user@example.com', callerIntent: 'gemini-attachment-upload-incomplete-template-test', journalRoot: await tempDir(),
    fetchImpl: async () => { calls += 1; return new Response('', { status: 200 }); },
  }), { code: 'ATTACHMENT_UPLOAD_CONTINUATION_VALUE_UNAVAILABLE' });
  assert.equal(calls, 0);
});

test('keeps native transport Content-Type separate from the selected attachment MIME', async () => {
  const observed = await loadObservedContract();
  const source = observed.attachmentUpload.source;
  const file = { name: 'api-offset-proof-v2.txt', mimeType: 'text/plain', body: Buffer.from('OFFSET42:12\n') };
  const headers = Object.fromEntries(source.headerNames.filter((name) => name !== 'cookie').map((name) => [
    name,
    name === 'content-type' ? source.contentType
      : name === 'origin' ? observed.origin
        : name === 'x-goog-upload-protocol' ? source.startProtocol
          : name === 'x-goog-upload-command' ? source.startCommand
            : name === source.fileLengthHeader ? String(file.body.length) : `captured-${name}`,
  ]));
  const captured = {
    url: 'https://push.clients6.google.com/upload/',
    method: source.method,
    contentType: source.contentType,
    body: Buffer.from(`${source.metadataBodyPrefix}${file.name}`),
    declaredFileBytes: file.body.length,
    headerNames: [...source.headerNames],
    headers,
  };
  const uploadCookies = source.cookieScopes.map((scope) => ({ ...scope, value: `sentinel-${scope.name}` }));
  const nativeContinuation = observed.attachmentUpload.resumable.nativeContinuation;
  const nativeContinuationHeaders = Object.fromEntries(nativeContinuation.headerNames
    .filter((name) => name !== 'cookie').map((name) => [
      name,
      name === 'x-goog-upload-command' ? nativeContinuation.commandValue
        : name === 'x-goog-upload-offset' ? '0'
          : name === 'content-type' ? nativeContinuation.headerValuePolicy.sourceEffectiveHeaderValues[name]
            : headers[name],
    ]));
  nativeContinuationHeaders.cookie = uploadCookies.map((item) => `${item.name}=${item.value}`).join('; ');
  const calls = [];
  let observedUploadResponse;
  let responseBufferAlias;
  let attachmentReferenceAlias;
  const result = await uploadAttachmentOnce({
    contract: observed.attachmentUpload,
    capture: captured,
    uploadCookies,
    file,
    actor: 'user@example.com',
    callerIntent: 'gemini-attachment-upload-canonical-header-test',
    journalRoot: await tempDir(),
    useInstalledContinuationTemplate: true,
    continuationCaptureProvider: async ({ uploadUrl }) => {
      const issued = new URL(uploadUrl);
      const browserUrl = new URL(issued.origin + issued.pathname);
      browserUrl.searchParams.set('upload_protocol', issued.searchParams.get('upload_protocol'));
      browserUrl.searchParams.set('upload_id', issued.searchParams.get('upload_id'));
      return {
        url: browserUrl.href,
        method: nativeContinuation.method,
        headerNames: [...nativeContinuation.headerNames],
        headers: { ...nativeContinuationHeaders },
        body: Buffer.from(file.body),
      };
    },
    fetchImpl: async (url, init) => {
      const requestHeaders = new Headers(init.headers);
      const command = requestHeaders.get('x-goog-upload-command');
      calls.push({
        path: new URL(url).pathname,
        command,
        offset: requestHeaders.get('x-goog-upload-offset'),
        contentType: requestHeaders.get('content-type'),
        cookieNames: (requestHeaders.get('cookie') ?? '').split(';').map((item) => item.split('=', 1)[0].trim()).filter(Boolean).sort(),
      });
      if (command === 'start') return new Response('', { status: 200, headers: {
        'x-goog-upload-url': 'https://push.clients6.google.com/upload/session?upload_id=opaque&upload_protocol=resumable',
      } });
      if (command === 'upload, finalize') return new Response('upload-complete', { status: 200, headers: {
        'content-type': 'text/html', 'x-goog-upload-status': 'final',
      } });
      return new Response('', { status: 200, headers: {
        'x-goog-upload-status': 'final', 'x-goog-upload-size-received': String(file.body.length),
      } });
    },
    uploadResponseHandler: async (response) => {
      responseBufferAlias = response.responseBody;
      attachmentReferenceAlias = response.attachmentRef;
      observedUploadResponse = {
        httpStatus: response.httpStatus,
        body: response.responseBody.toString('utf8'),
        attachmentRef: response.attachmentRef,
        headerNames: response.responseHeaders.map(([name]) => name).sort(),
      };
      return { completed: true };
    },
  });
  assert.equal(result.status, 'verified');
  assert.equal(result.directDispatchCount, 2);
  assert.deepEqual(calls.map(({ path, command, offset }) => [path, command, offset]), [
    ['/upload/', 'start', null],
    ['/upload/session', 'upload, finalize', '0'],
    ['/upload/session', 'query', null],
  ]);
  assert.equal(file.mimeType, 'text/plain');
  assert.equal(calls[1].contentType, 'application/x-www-form-urlencoded');
  assert.equal(result.continuationTemplate.sourceEffectiveHeadersMatched, true);
  assert.equal(result.continuationTemplate.serverIssuedUrlIdentityMatched, true);
  assert.equal(result.continuationTemplate.serverIssuedUrlStringNormalized, true);
  assert.equal(result.continuationTemplate.serverIssuedUrlIdentityMatched, true);
  assert.equal(result.continuationTemplate.serverIssuedUrlStringNormalized, true);
  assert.deepEqual(calls[1].cookieNames, [...source.cookieNames].sort());
  assert.equal(result.attachmentReferenceAvailable, true);
  assert.equal(result.responseHandlerCompleted, true);
  assert.equal(Object.keys(result).includes('internal'), false);
  assert.equal(JSON.stringify(result).includes('upload-complete'), false);
  assert.deepEqual(observedUploadResponse, {
    httpStatus: 200,
    body: 'upload-complete',
    attachmentRef: { filename: file.name, mimeType: file.mimeType, dh: 'upload-complete', fileSizeBytes: file.body.length },
    headerNames: ['content-type', 'x-goog-upload-status'],
  });
  assert.deepEqual(result.internal.attachmentRef, observedUploadResponse.attachmentRef);
  assert.equal(responseBufferAlias.every((byte) => byte === 0), true);
  assert.equal(attachmentReferenceAlias.dh, 'upload-complete');
  assert.equal(result.internal.attachmentRef, attachmentReferenceAlias);
  captured.body.fill(0);
  file.body.fill(0);
});

test('retains session query status and cookie-name diagnostics after a pre-transfer continuation mismatch', async () => {
  const observed = await loadObservedContract();
  const upload = observed.attachmentUpload;
  const file = { name: 'cookie-refresh-check.txt', mimeType: 'text/plain', body: Buffer.from('COOKIE42:OK\n') };
  const startHeaders = Object.fromEntries(upload.source.headerNames.filter((name) => name !== 'cookie').map((name) => [
    name,
    name === 'content-type' ? upload.source.contentType
      : name === 'origin' ? observed.origin
        : name === 'x-goog-upload-protocol' ? upload.source.startProtocol
          : name === 'x-goog-upload-command' ? upload.source.startCommand
            : name === upload.source.fileLengthHeader ? String(file.body.length) : `captured-${name}`,
  ]));
  const capture = {
    url: 'https://push.clients6.google.com/upload/', method: 'POST', contentType: upload.source.contentType,
    body: Buffer.from(`${upload.source.metadataBodyPrefix}${file.name}`),
    declaredFileBytes: file.body.length, headerNames: [...upload.source.headerNames], headers: startHeaders,
  };
  const cookies = upload.source.cookieScopes.map((scope) => ({ ...scope, value: `start-${scope.name}` }));
  const continuationNames = upload.resumable.nativeContinuation.headerNames;
  const continuationHeaders = Object.fromEntries(continuationNames.filter((name) => name !== 'cookie').map((name) => [
    name,
    name === 'x-goog-upload-command' ? upload.resumable.finalizeCommand
      : name === 'x-goog-upload-offset' ? '0' : startHeaders[name],
  ]));
  continuationHeaders.cookie = cookies.map((item) => `${item.name}=${item.name === 'SID' ? 'rotated-SID' : item.value}`).join('; ');
  continuationHeaders['content-type'] = upload.resumable.nativeContinuation.headerValuePolicy
    .sourceEffectiveHeaderValues['content-type'];
  const calls = [];
  await assert.rejects(uploadAttachmentOnce({
    contract: upload, capture, uploadCookies: cookies, file,
    actor: 'user@example.com', callerIntent: 'gemini-attachment-cookie-mismatch-query-test', journalRoot: await tempDir(),
    continuationCaptureProvider: async ({ uploadUrl }) => ({
      url: uploadUrl, method: 'POST', headerNames: continuationNames, headers: continuationHeaders, body: Buffer.from(file.body),
    }),
    fetchImpl: async (url, init) => {
      const command = new Headers(init.headers).get(upload.resumable.commandHeader);
      calls.push({ path: new URL(url).pathname, command });
      if (command === upload.source.startCommand) return new Response('', { status: 200, headers: {
        [upload.resumable.uploadUrlHeader]: 'https://push.clients6.google.com/upload/session?upload_id=opaque',
      } });
      if (command === upload.resumable.queryCommand) return new Response('', { status: 200, headers: {
        [upload.resumable.uploadStatusHeader]: 'active', [upload.resumable.sizeReceivedHeader]: '0',
      } });
      throw new Error('The file transfer must not dispatch after the continuation-cookie mismatch.');
    },
  }), (error) => {
    assert.equal(error.code, 'ATTACHMENT_UPLOAD_COOKIE_SET_MISMATCH');
    assert.equal(error.details.directDispatchCount, 1);
    assert.equal(error.details.startDispatchCount, 1);
    assert.equal(error.details.transferDispatchCount, 0);
    assert.deepEqual(error.details.queryReadback, { httpStatus: 200, uploadStatus: 'active', sizeReceived: 0 });
    assert.deepEqual(error.details.valueMismatchCookieNames, ['SID']);
    assert.equal(JSON.stringify(error.details).includes('rotated-SID'), false);
    return true;
  });
  assert.deepEqual(calls, [
    { path: '/upload/', command: 'start' },
    { path: '/upload/session', command: 'query' },
  ]);
  file.body.fill(0);
  capture.body.fill(0);
});

test('main client uses the owner-only gate without requiring Gemini batch history context', async () => {
  const observed = await loadObservedContract();
  const source = observed.attachmentUpload.source;
  const headers = Object.fromEntries(source.headerNames.filter((name) => name !== 'cookie').map((name) => [
    name,
    name === 'content-type' ? source.contentType
      : name === 'origin' ? observed.origin
        : name === 'x-goog-upload-protocol' ? source.startProtocol
          : name === 'x-goog-upload-command' ? source.startCommand
            : name === source.fileLengthHeader ? '14' : `captured-${name}`,
  ]));
  const captured = {
    url: 'https://push.clients6.google.com/upload/',
    method: source.method,
    contentType: source.contentType,
    body: Buffer.from(`${source.metadataBodyPrefix}api-protocol42.txt`),
    declaredFileBytes: 14,
    headerNames: [...source.headerNames],
    headers,
  };
  const file = { name: 'api-protocol42.txt', mimeType: 'text/plain', body: Buffer.from('PROTOCOL42:42\n') };
  const client = new GeminiWebClient({ contract: observed });
  let ownerGateCalls = 0;
  let refreshCalls = 0;
  const authCookies = observed.auth.cookieNames.map((name) => ({ name, value: `session-start-${name}` }));
  client.transport.session = validateSessionBundle({
    version: 1, service: observed.service, origin: observed.origin, capturedAt: '2026-10-06T00:00:00.000Z',
    cookies: authCookies, headers: Object.fromEntries(observed.auth.headerNames.map((name) => [name, 'captured-auth-header'])),
  }, observed);
  client.verifyOwner = async () => {
    ownerGateCalls += 1;
    const currentSid = client.transport.session.cookies.find((item) => item.name === 'SID')?.value;
    return { ownerMatched: ownerGateCalls === 1 ? currentSid === 'session-start-SID' : currentSid === 'session-fresh-SID',
      anonymousOwnerAbsent: true, credentialPropagated: true };
  };
  client.refreshSession = async () => {
    refreshCalls += 1;
    throw new Error('The upload must not require batch-context refresh.');
  };
  const uploadCookies = source.cookieScopes.map((scope) => ({ ...scope, value: `session-start-${scope.name}` }));
  const freshUploadCookies = source.cookieScopes.map((scope) => ({ ...scope, value: `session-fresh-${scope.name}` }));
  const continuationHeaderNames = observed.attachmentUpload.resumable.nativeContinuation.headerNames;
  const continuationHeaders = Object.fromEntries(continuationHeaderNames.filter((name) => name !== 'cookie').map((name) => [
    name,
    name === 'x-goog-upload-command' ? 'upload, finalize'
      : name === 'x-goog-upload-offset' ? '0'
        : name === 'referer' ? `${observed.origin}/app?native-continuation=1`
          : name === 'user-agent' ? 'native-browser-agent'
              : name.startsWith('sec-ch-ua') ? 'native-client-hint'
              : headers[name],
  ]));
  continuationHeaders['content-type'] = observed.attachmentUpload.resumable.nativeContinuation.headerValuePolicy
    .sourceEffectiveHeaderValues['content-type'];
  continuationHeaders.cookie = freshUploadCookies.map((item) => `${item.name}=${item.value}`).join('; ');
  const sentCookieSnapshots = [];
  const sentContinuationHeaderValues = [];
  const result = await client.uploadAttachmentOnce({
    expectedOwner: 'user@example.com',
    callerIntent: 'gemini-attachment-upload-owner-gate-test',
    capture: captured,
    uploadCookies,
    uploadCookieRefreshProvider: async () => freshUploadCookies,
    file,
    journalRoot: await tempDir(),
    useInstalledContinuationTemplate: true,
    continuationCaptureProvider: async ({ uploadUrl }) => ({
      url: uploadUrl,
      method: 'POST',
      headerNames: [...continuationHeaderNames],
      headers: continuationHeaders,
      body: Buffer.from(file.body),
    }),
    fetchImpl: async (url, init) => {
      const requestHeaders = new Headers(init.headers);
      const command = requestHeaders.get('x-goog-upload-command');
      sentCookieSnapshots.push({ command, cookie: requestHeaders.get('cookie') });
      sentContinuationHeaderValues.push({ command, referer: requestHeaders.get('referer'),
        userAgent: requestHeaders.get('user-agent'), secChUa: requestHeaders.get('sec-ch-ua') });
      if (new URL(url).pathname === '/upload/' && command === 'start') {
        return new Response('', { status: 200, headers: {
          'x-goog-upload-url': 'https://push.clients6.google.com/upload/session?upload_id=opaque',
        } });
      }
      if (command === 'query') return new Response('', { status: 200, headers: {
        'x-goog-upload-status': 'final', 'x-goog-upload-size-received': '14',
      } });
      return new Response(JSON.stringify({ file: { name: file.name, size: file.body.length } }), {
        status: 200, headers: { 'content-type': 'application/json', 'x-goog-upload-status': 'final' },
      });
    },
  });
  assert.equal(ownerGateCalls, 2);
  assert.equal(refreshCalls, 0);
  assert.equal(result.ownerMatched, true);
  assert.equal(result.status, 'verified');
  assert.equal(result.continuationTemplate.sourceRequiredHeadersMatched, true);
  assert.equal(result.continuationTemplate.sourceEffectiveHeadersMatched, true);
  assert.ok(result.continuationTemplate.optionalBrowserHeaderVariationNames.includes('referer'));
  assert.ok(result.continuationTemplate.optionalBrowserHeaderVariationNames.includes('user-agent'));
  assert.equal(result.freshUploadCookieOwnerVerified, true);
  assert.match(sentCookieSnapshots[0].cookie, /SID=session-start-SID/);
  assert.match(sentCookieSnapshots[1].cookie, /SID=session-fresh-SID/);
  assert.equal(sentContinuationHeaderValues[1].referer, headers.referer);
  assert.equal(sentContinuationHeaderValues[1].userAgent, headers['user-agent']);
  assert.equal(sentContinuationHeaderValues[1].secChUa, headers['sec-ch-ua']);
  assert.notEqual(sentContinuationHeaderValues[1].referer, continuationHeaders.referer);
  assert.equal(result.attachmentReferenceAvailable, true);
  assert.equal(Object.keys(result).includes('internal'), false);
  assert.deepEqual(result.internal.attachmentRef, {
    filename: file.name,
    mimeType: file.mimeType,
    dh: JSON.stringify({ file: { name: file.name, size: file.body.length } }),
    fileSizeBytes: file.body.length,
  });
  assert.equal(JSON.stringify(result).includes(result.internal.attachmentRef.dh), false);
  file.body.fill(0);
  captured.body.fill(0);
  for (const cookieValue of uploadCookies) cookieValue.value = '';
});

test('rejects a scoped-cookie mismatch before the first HTTP request', async () => {
  let calls = 0;
  await assert.rejects(uploadAttachmentOnce({
    contract: contract(), capture: capture(),
    uploadCookies: [{ ...cookie, domain: '.example.com' }],
    file: { name: 'api-protocol42.txt', mimeType: 'text/plain', body: Buffer.from('PROTOCOL42:42\n') },
    actor: 'user@example.com', callerIntent: 'gemini-attachment-upload-cookie-test', journalRoot: await tempDir(),
    fetchImpl: async () => { calls += 1; return new Response('', { status: 200 }); },
  }), (error) => error?.code === 'ATTACHMENT_UPLOAD_COOKIE_SCOPE_INVALID');
  assert.equal(calls, 0);
});

test('blocks an unobserved upload URL before sending file bytes', async () => {
  const calls = [];
  await assert.rejects(uploadAttachmentOnce({
    contract: contract(), capture: capture(), uploadCookies: [cookie],
    file: { name: 'api-protocol42.txt', mimeType: 'text/plain', body: Buffer.from('PROTOCOL42:42\n') },
    actor: 'user@example.com', callerIntent: 'gemini-attachment-upload-host-test', journalRoot: await tempDir(),
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url).origin, body: Buffer.from(init.body ?? []) });
      return new Response('', { status: 200, headers: { 'x-goog-upload-url': 'https://example.com/upload/session' } });
    },
  }), (error) => error?.code === 'ATTACHMENT_UPLOAD_SESSION_URL_UNOBSERVED');
  assert.equal(calls.length, 1);
});

test('query uses only the returned upload session URL and reports safe status metadata', async () => {
  let call;
  const result = await queryAttachmentUploadSession({
    contract: contract(),
    uploadUrl: 'https://push.clients6.google.com/upload/session?upload_id=opaque',
    fetchImpl: async (url, init) => {
      call = { origin: new URL(url).origin, command: new Headers(init.headers).get('x-goog-upload-command'), body: init.body };
      return new Response('', { status: 200, headers: { 'x-goog-upload-status': 'active', 'x-goog-upload-size-received': '14' } });
    },
  });
  assert.equal(call.origin, 'https://push.clients6.google.com');
  assert.equal(call.command, 'query');
  assert.equal(call.body, undefined);
  assert.equal(result.uploadStatus, 'active');
  assert.equal(result.sizeReceived, 14);
});

test('resumes once from an identity-bound, server-reported active offset', async () => {
  const uploadUrl = 'https://push.clients6.google.com/upload/session?upload_id=opaque';
  const query = await queryAttachmentUploadSession({
    contract: contract(), uploadUrl,
    fetchImpl: async () => new Response('', { status: 200, headers: {
      'x-goog-upload-status': 'active', 'x-goog-upload-size-received': '4',
    } }),
  });
  const file = { name: 'api-protocol42.txt', mimeType: 'text/plain', body: Buffer.from('PROTOCOL42:42\n') };
  let call;
  const result = await resumeAttachmentUploadSession({
    contract: contract(), uploadUrl, file, query,
    fetchImpl: async (url, init) => {
      const headers = new Headers(init.headers);
      call = { origin: new URL(url).origin, command: headers.get('x-goog-upload-command'), offset: headers.get('x-goog-upload-offset'), body: Buffer.from(init.body) };
      return new Response('', { status: 200, headers: {
        'x-goog-upload-status': 'final', 'x-goog-upload-size-received': '14',
      } });
    },
  });
  assert.equal(call.origin, 'https://push.clients6.google.com');
  assert.equal(call.command, 'upload, finalize');
  assert.equal(call.offset, '4');
  assert.deepEqual(call.body, file.body.subarray(4));
  assert.equal(result.sizeReceived, 14);
  await assert.rejects(resumeAttachmentUploadSession({
    contract: contract(), uploadUrl, file, query: { uploadStatus: 'active', sizeReceived: 4 },
    fetchImpl: async () => { throw new Error('must not dispatch'); },
  }), (error) => error?.code === 'ATTACHMENT_UPLOAD_RESUME_UNOBSERVED');
});

test('refuses to invent an upload cancellation request', async () => {
  let calls = 0;
  await assert.rejects(cancelAttachmentUploadSession({
    contract: contract(), fetchImpl: async () => { calls += 1; return new Response('', { status: 200 }); },
  }), (error) => error?.code === 'ATTACHMENT_UPLOAD_CANCEL_UNOBSERVED');
  assert.equal(calls, 0);
});

test('cancels only a query-bound active session and confirms cancellation with a second query', async () => {
  const sourceContract = contract();
  sourceContract.resumable = {
    ...sourceContract.resumable,
    cancelSupported: true,
    cancelMethod: 'POST',
    cancelCommand: 'cancel',
    cancelEligibleStates: ['Upload', 'Query'],
  };
  const uploadUrl = 'https://push.clients6.google.com/upload/session?upload_id=opaque';
  let queryCount = 0;
  const commands = [];
  const query = await queryAttachmentUploadSession({
    contract: sourceContract,
    uploadUrl,
    fetchImpl: async (_url, init) => {
      commands.push(new Headers(init.headers).get('x-goog-upload-command'));
      queryCount += 1;
      return new Response('', { status: 200, headers: {
        'x-goog-upload-status': queryCount === 1 ? 'active' : 'canceled',
        'x-goog-upload-size-received': '0',
      } });
    },
  });
  const result = await cancelAttachmentUploadSession({
    contract: sourceContract,
    uploadUrl,
    query,
    actor: 'user@example.com',
    callerIntent: 'gemini-attachment-upload-cancel-test',
    journalRoot: await tempDir(),
    fetchImpl: async (_url, init) => {
      const command = new Headers(init.headers).get('x-goog-upload-command');
      commands.push(command);
      if (command === 'cancel') return new Response('', { status: 200, headers: { 'content-type': 'text/plain' } });
      return new Response('', { status: 200, headers: {
        'x-goog-upload-status': 'canceled', 'x-goog-upload-size-received': '0',
      } });
    },
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.directDispatchCount, 1);
  assert.equal(result.cancellationReadbackVerified, true);
  assert.equal(result.journalReconciled, true);
  assert.deepEqual(commands, ['query', 'cancel', 'query']);
});

test('reads only a bounded source-shaped upload envelope and validates scoped cookie names', async () => {
  const observed = await loadObservedContract();
  const session = {
    version: 1,
    service: observed.service,
    origin: observed.origin,
    capturedAt: new Date().toISOString(),
    cookies: observed.auth.cookieNames.map((name) => ({ name, value: `sentinel-${name}` })),
    headers: {},
    requestHeaders: {},
  };
  const source = observed.attachmentUpload.source;
  const observedHeaders = Object.fromEntries(source.headerNames.filter((name) => name !== 'cookie').map((name) => [
    name,
    name === 'content-type' ? source.contentType
      : name === 'origin' ? observed.origin
        : name === 'x-goog-upload-protocol' ? source.startProtocol
          : name === 'x-goog-upload-command' ? source.startCommand
            : name === source.fileLengthHeader ? '14' : `sentinel-${name}`,
  ]));
  const original = {
    expectedOwner: 'user@example.com',
    session,
    capture: {
      url: 'https://push.clients6.google.com/upload/',
      method: 'POST',
      contentType: source.contentType,
      bodyBase64: Buffer.from(`${source.metadataBodyPrefix}api-protocol42.txt`).toString('base64'),
      declaredFileBytes: 14,
      headerNames: source.headerNames,
      headers: observedHeaders,
    },
    uploadCookies: observed.attachmentUpload.source.cookieScopes.map((scope) => ({ ...scope, value: `sentinel-${scope.name}` })),
    file: {
      name: 'api-protocol42.txt',
      mimeType: 'text/plain',
      bodyBase64: Buffer.from('PROTOCOL42:42\n').toString('base64'),
    },
  };
  const envelope = await readAttachmentUploadEnvelopeFromStdin(observed, {
    input: Readable.from([Buffer.from(JSON.stringify(original))]),
  });
  assert.equal(envelope.expectedOwner, 'user@example.com');
  assert.equal(envelope.capture.body.toString(), 'File name: api-protocol42.txt');
  assert.equal(envelope.file.body.toString(), 'PROTOCOL42:42\n');
  assert.equal(envelope.uploadCookies.length, observed.attachmentUpload.source.cookieNames.length);
  envelope.capture.body.fill(0);
  envelope.file.body.fill(0);
  for (const item of envelope.uploadCookies) item.value = '';
});
