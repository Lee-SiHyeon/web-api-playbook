import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { loadContractRegistry } from '../src/client.mjs';
import { materializeOperationUrl, operationReadiness } from '../src/contracts.mjs';
import {
  createGrokConversationFilesClient,
  GROK_CONVERSATION_FILE_OPERATION_IDS,
} from '../src/grok-conversation-files.mjs';

const CONVERSATION_ID = 'conversation-id-1234567890';
const OWNER_SCOPE = 'a'.repeat(64);

test('file API contracts use first-party FilesService V2 and workspace download source paths', async () => {
  const registry = await loadContractRegistry();
  const operations = new Map(registry.operations.map(operation => [operation.id, operation]));
  const list = operations.get('conversation.files.list');
  const content = operations.get('conversation.file.content.resolve');
  const zip = operations.get('conversation.files.zip.resolve');
  const workspaceZip = operations.get('conversation.workspace.zip.resolve');
  assert.equal(list.urlTemplate, 'https://grok.com/rest/conversations/files/list');
  assert.equal(list.evidence.sourceFunctionName, 'filesServiceListFilesV2Raw');
  assert.equal(content.urlTemplate, 'https://grok.com/rest/conversations/files/content');
  assert.equal(content.evidence.sourceFunctionName, 'filesServiceGetFileContentV2Raw');
  assert.equal(zip.urlTemplate, 'https://grok.com/rest/conversations/files/download-zip');
  assert.equal(zip.evidence.sourceFunctionName, 'filesServiceDownloadFilesAsZipRaw');
  assert.equal(workspaceZip.method, 'POST');
  assert.equal(workspaceZip.urlTemplate, 'https://grok.com/rest/app-chat/conversations/{{input.conversationId}}/download-workspace');
  assert.equal(workspaceZip.evidence.sourceFunctionName, 'chatDownloadAppWorkspaceRaw');
  for (const operation of [list, content, zip, workspaceZip]) {
    assert.equal(operationReadiness(operation).ready, false);
    assert.equal(operationReadiness(operation).reason, 'FIRST_LIVE_REPLAY_REQUIRED');
  }
  const listUrl = materializeOperationUrl(list, { conversationId: CONVERSATION_ID, path: '/' });
  assert.equal(listUrl.pathname, '/rest/conversations/files/list');
  assert.equal(listUrl.searchParams.get('conversationId'), CONVERSATION_ID);
  assert.equal(listUrl.searchParams.get('path'), '/');
  const contentUrl = materializeOperationUrl(content, { conversationId: CONVERSATION_ID, path: '/task.csv' });
  assert.equal(contentUrl.searchParams.get('isDownload'), 'true');
});

function clientWithRead(readImpl, { ownerVerified = true } = {}) {
  const calls = [];
  return {
    calls,
    client: {
      status: async () => ({ session: { ownerVerified } }),
      read: async (...args) => { calls.push(args); return readImpl(...args); },
    },
  };
}

test('conversation file list binds the owner and returns only first-party listing fields', async () => {
  const mock = clientWithRead(async (operationId, input, options) => {
    assert.equal(operationId, GROK_CONVERSATION_FILE_OPERATION_IDS.list);
    assert.deepEqual(input, { conversationId: CONVERSATION_ID, path: '/' });
    assert.equal(options.sourceDiscoveryPermit, 'first-read:conversation.files.list');
    assert.equal(options.expectedOwnerScopeSha256, OWNER_SCOPE);
    return {
      status: 200, contentType: 'application/json', responseBytes: 128,
      requestDigest: 'b'.repeat(64), responseDigest: 'c'.repeat(64),
      data: { path: '/', nextPageToken: 'next-page', files: [{
        name: 'task.csv', path: '/task.csv', isDirectory: false, size: 14,
        mimeType: 'text/csv', modifiedAt: '2026-10-06T00:00:00Z',
      }] },
    };
  });
  const api = createGrokConversationFilesClient({ client: mock.client });
  const result = await api.listFiles({ conversationId: CONVERSATION_ID, path: '/' }, { expectedOwnerScopeSha256: OWNER_SCOPE });
  assert.deepEqual(result.files, [{ name: 'task.csv', path: '/task.csv', isDirectory: false,
    size: 14, mimeType: 'text/csv', modifiedAt: '2026-10-06T00:00:00Z' }]);
  assert.equal(result.nextPageToken, 'next-page');
});

test('content resolution exposes metadata and URL presence only, never the server-issued URL values', async () => {
  const signedUrl = 'https://files.example.invalid/signed/private-value';
  const mock = clientWithRead(async () => ({
    status: 200, contentType: 'application/json', responseBytes: 128,
    requestDigest: 'b'.repeat(64), responseDigest: 'c'.repeat(64),
    data: { mimeType: 'text/csv', size: 14, isTruncated: false, downloadSignedUrl: signedUrl },
  }));
  const api = createGrokConversationFilesClient({ client: mock.client });
  const result = await api.resolveFileContent({ conversationId: CONVERSATION_ID, path: '/task.csv' });
  assert.deepEqual(result, {
    status: 200, contentType: 'application/json', responseBytes: 128,
    requestDigest: 'b'.repeat(64), responseDigest: 'c'.repeat(64), rawResponseDigest: null,
    transportEvidence: null, mimeType: 'text/csv', size: 14,
    isTruncated: false, dataUrlPresent: false, signedUrlPresent: false, downloadSignedUrlPresent: true,
  });
  assert.equal(JSON.stringify(result).includes('private-value'), false);
});

test('file and ZIP metadata accepts bounded decimal strings from FilesService V2', async () => {
  const mock = clientWithRead(async operationId => {
    const common = { status: 200, contentType: 'application/json', responseBytes: 128,
      requestDigest: 'b'.repeat(64), responseDigest: 'c'.repeat(64) };
    if (operationId === GROK_CONVERSATION_FILE_OPERATION_IDS.list) return { ...common,
      data: { path: '/', files: [{ name: 'neutral.csv', path: '/neutral.csv', isDirectory: false, size: '22' }] } };
    if (operationId === GROK_CONVERSATION_FILE_OPERATION_IDS.content) return { ...common,
      data: { mimeType: 'text/csv', size: '22', isTruncated: false, downloadSignedUrl: 'https://files.invalid/signed/value' } };
    if (operationId === GROK_CONVERSATION_FILE_OPERATION_IDS.zip) return { ...common,
      data: { downloadUrl: 'https://files.invalid/signed/archive', fileCount: '1', totalSize: '22' } };
    return { ...common,
      data: { downloadUrl: 'https://files.invalid/signed/workspace', sizeBytes: '22', expiresAt: 'later' } };
  });
  const api = createGrokConversationFilesClient({ client: mock.client });
  const list = await api.listFiles({ conversationId: CONVERSATION_ID, path: '/' });
  const content = await api.resolveFileContent({ conversationId: CONVERSATION_ID, path: '/neutral.csv' });
  const filesZip = await api.resolveZip({ conversationId: CONVERSATION_ID, path: '/' });
  const workspaceZip = await api.resolveWorkspaceZip({ conversationId: CONVERSATION_ID });
  assert.equal(list.files[0].size, 22);
  assert.equal(content.size, 22);
  assert.equal(filesZip.fileCount, 1);
  assert.equal(filesZip.totalSize, 22);
  assert.equal(workspaceZip.sizeBytes, 22);
  assert.equal(JSON.stringify([list, content, filesZip, workspaceZip]).includes('signed/value'), false);
});

test('invalid file metadata preserves only safe response shape diagnostics', async () => {
  const mock = clientWithRead(async () => ({
    status: 200, contentType: 'application/json', responseBytes: 64,
    requestDigest: 'b'.repeat(64), responseDigest: 'c'.repeat(64),
    data: { mimeType: 'text/csv', size: 'private-size-value', downloadSignedUrl: 'https://files.invalid/private' },
  }));
  const api = createGrokConversationFilesClient({ client: mock.client });
  await assert.rejects(api.resolveFileContent({ conversationId: CONVERSATION_ID, path: '/neutral.csv' }), error => {
    assert.equal(error.code, 'CONVERSATION_FILE_CONTENT_SHAPE_INVALID');
    assert.equal(error.details.status, 200);
    assert.equal(error.details.responseShape.fields.size.type, 'string');
    assert.equal(JSON.stringify(error.details).includes('private-size-value'), false);
    assert.equal(JSON.stringify(error.details).includes('files.invalid'), false);
    return true;
  });
});

test('ZIP resolvers do not expose URLs and support only the source-declared owner and path fields', async () => {
  const mock = clientWithRead(async operationId => ({
    status: 200, contentType: 'application/json', responseBytes: 64,
    requestDigest: 'b'.repeat(64), responseDigest: 'c'.repeat(64),
    data: operationId === GROK_CONVERSATION_FILE_OPERATION_IDS.zip
      ? { downloadUrl: 'https://files.example.invalid/signed/private-value.zip', fileCount: 1, totalSize: 14 }
      : { downloadUrl: 'https://files.example.invalid/signed/private-value.zip', sizeBytes: 64, expiresAt: 'soon' },
  }));
  const api = createGrokConversationFilesClient({ client: mock.client });
  const filesZip = await api.resolveZip({ conversationId: CONVERSATION_ID, path: '/' });
  const workspaceZip = await api.resolveWorkspaceZip({ conversationId: CONVERSATION_ID });
  assert.equal(filesZip.fileCount, 1);
  assert.equal(filesZip.downloadUrlPresent, true);
  assert.equal(workspaceZip.sizeBytes, 64);
  assert.equal(workspaceZip.expiresAtPresent, true);
  assert.equal(JSON.stringify([filesZip, workspaceZip]).includes('private-value'), false);
  assert.deepEqual(mock.calls[1][1], { conversationId: CONVERSATION_ID, body: {} });
});

test('owner, path, pagination, and response-shape gates fail before exposing file data', async () => {
  const unowned = clientWithRead(async () => { throw new Error('must not dispatch'); }, { ownerVerified: false });
  const unownedApi = createGrokConversationFilesClient({ client: unowned.client });
  await assert.rejects(unownedApi.listFiles({ conversationId: CONVERSATION_ID }), { code: 'OWNER_VERIFICATION_REQUIRED' });
  assert.equal(unowned.calls.length, 0);

  const owned = clientWithRead(async () => ({ status: 200, data: { files: 'invalid' } }));
  const ownedApi = createGrokConversationFilesClient({ client: owned.client });
  await assert.rejects(ownedApi.listFiles({ conversationId: CONVERSATION_ID, path: '/../../other' }),
    { code: 'CONVERSATION_FILE_PATH_INVALID' });
  await assert.rejects(ownedApi.listFiles({ conversationId: CONVERSATION_ID, pageSize: 0 }),
    { code: 'CONVERSATION_FILE_PAGE_SIZE_INVALID' });
  await assert.rejects(ownedApi.listFiles({ conversationId: CONVERSATION_ID }),
    { code: 'CONVERSATION_FILE_LIST_SHAPE_INVALID' });
});

test('task file download resolves a server-issued URL in memory and returns only the saved artifact proof', async () => {
  const tempRoot = process.env.TMPDIR || '/home/worker/.nad-scratch/tmp';
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(path.join(tempRoot, 'grok-task-file-'));
  const signedUrl = 'https://files.example.invalid/signed/private-value';
  const body = Buffer.from('label,value\nneutral,14\n', 'utf8');
  const mock = clientWithRead(async () => ({
    status: 200, contentType: 'application/json', responseBytes: 128,
    requestDigest: 'b'.repeat(64), responseDigest: 'c'.repeat(64), rawResponseDigest: 'd'.repeat(64),
    data: { mimeType: 'text/csv', size: body.length, isTruncated: false, downloadSignedUrl: signedUrl },
  }));
  const api = createGrokConversationFilesClient({
    client: mock.client,
    fetchSourceResolvedArtifact: async url => {
      assert.equal(url, signedUrl);
      return new Response(body, { status: 200, headers: { 'content-type': 'text/csv' } });
    },
  });
  try {
    const result = await api.downloadFile({ conversationId: CONVERSATION_ID, path: '/neutral.csv' }, {
      expectedOwnerScopeSha256: OWNER_SCOPE,
      outputDir: directory,
      suggestedName: 'neutral.csv',
    });
    assert.equal(result.bytes, body.length);
    assert.equal(result.mimeType, 'text/csv');
    assert.equal(result.resolverStatus, 200);
    assert.equal(result.resolverRequestDigest, 'b'.repeat(64));
    assert.equal(result.resolverResponseDigest, 'd'.repeat(64));
    assert.equal(JSON.stringify(result).includes('private-value'), false);
    assert.deepEqual(await readFile(result.path), body);
  } finally {
    body.fill(0);
    await rm(directory, { recursive: true, force: true });
  }
});

test('task file download follows only bounded credentialless HTTPS redirects and omits redirect URLs from output', async () => {
  const tempRoot = process.env.TMPDIR || '/home/worker/.nad-scratch/tmp';
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(path.join(tempRoot, 'grok-task-file-redirect-'));
  const signedUrl = 'https://origin.example.invalid/signed/private-value';
  const redirectUrl = 'https://cdn.example.invalid/object?signature=second-private';
  const body = Buffer.from('label,value\nneutral,14\n', 'utf8');
  let calls = 0;
  const mock = clientWithRead(async () => ({
    status: 200, contentType: 'application/json', responseBytes: 128,
    requestDigest: 'b'.repeat(64), responseDigest: 'c'.repeat(64),
    data: { mimeType: 'text/csv', size: body.length, isTruncated: false, downloadSignedUrl: signedUrl },
  }));
  const api = createGrokConversationFilesClient({
    client: mock.client,
    fetchSourceResolvedArtifact: async url => {
      calls += 1;
      if (calls === 1) {
        assert.equal(url, signedUrl);
        return new Response(null, { status: 302, headers: { location: redirectUrl } });
      }
      assert.equal(url, redirectUrl);
      return new Response(body, { status: 200, headers: { 'content-type': 'text/csv' } });
    },
  });
  try {
    const result = await api.downloadFile({ conversationId: CONVERSATION_ID, path: '/neutral.csv' }, {
      expectedOwnerScopeSha256: OWNER_SCOPE, outputDir: directory,
    });
    assert.equal(result.redirectCount, 1);
    assert.deepEqual(result.redirectOrigins, ['origin.example.invalid', 'cdn.example.invalid'].map(host => `https://${host}`));
    assert.equal(JSON.stringify(result).includes('private-value'), false);
    assert.equal(JSON.stringify(result).includes('second-private'), false);
    assert.deepEqual(await readFile(result.path), body);
  } finally {
    body.fill(0);
    await rm(directory, { recursive: true, force: true });
  }
});

test('unsupported artifact MIME is returned as a safe type diagnostic and never saved', async () => {
  const mock = clientWithRead(async () => ({
    status: 200, contentType: 'application/json', responseBytes: 64,
    requestDigest: 'b'.repeat(64), responseDigest: 'c'.repeat(64),
    data: { mimeType: 'text/csv', size: 22, isTruncated: false, downloadSignedUrl: 'https://files.invalid/private' },
  }));
  const api = createGrokConversationFilesClient({
    client: mock.client,
    fetchSourceResolvedArtifact: async () => new Response('unused', {
      status: 200, headers: { 'content-type': 'application/octet-stream' },
    }),
  });
  await assert.rejects(api.downloadFile({ conversationId: CONVERSATION_ID, path: '/neutral.csv' }, {
    outputDir: '/home/worker/.nad-scratch/tmp',
  }), error => {
    assert.equal(error.code, 'FILE_TYPE_UNEXPECTED');
    assert.equal(error.details.actualMimeType, 'application/octet-stream');
    assert.deepEqual(error.details.allowedMimeTypes, ['text/csv']);
    assert.equal(JSON.stringify(error.details).includes('files.invalid'), false);
    return true;
  });
});

test('workspace ZIP accepts octet-stream only with ZIP signature verification', async () => {
  const tempRoot = process.env.TMPDIR || '/home/worker/.nad-scratch/tmp';
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(path.join(tempRoot, 'grok-workspace-zip-'));
  const body = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const mock = clientWithRead(async () => ({
    status: 200, contentType: 'application/json', responseBytes: 64,
    requestDigest: 'b'.repeat(64), responseDigest: 'c'.repeat(64),
    data: { downloadUrl: 'https://files.invalid/signed/workspace', sizeBytes: String(body.length) },
  }));
  const api = createGrokConversationFilesClient({
    client: mock.client,
    fetchSourceResolvedArtifact: async () => new Response(body, {
      status: 200, headers: { 'content-type': 'application/octet-stream' },
    }),
  });
  try {
    const result = await api.downloadWorkspaceZip({ conversationId: CONVERSATION_ID }, {
      outputDir: directory, suggestedName: 'workspace.zip',
    });
    assert.equal(result.mimeType, 'application/zip');
    assert.equal(result.responseMimeType, 'application/octet-stream');
    assert.equal(result.magicVerified, true);
    assert.equal(result.bytes, body.length);
  } finally {
    body.fill(0);
    await rm(directory, { recursive: true, force: true });
  }
});
