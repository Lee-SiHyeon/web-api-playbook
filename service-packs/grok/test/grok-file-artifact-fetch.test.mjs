import assert from 'node:assert/strict';
import test from 'node:test';
import { loadContractRegistry } from '../src/client.mjs';
import { createGrokFileArtifactFetch } from '../src/grok-file-artifact-fetch.mjs';

function fixtureRegistry(base) {
  const registry = structuredClone(base);
  registry.allowedOrigins.push('https://files.example.invalid');
  const source = registry.operations.find(operation => operation.id === 'conversation.file.content.resolve');
  registry.operations.push({
    id: 'artifact.conversation-file.download',
    kind: 'download',
    method: source.method,
    urlTemplate: source.urlTemplate,
    authMode: 'session',
    request: structuredClone(source.request),
    response: { mode: 'bytes', statuses: [200], contentTypes: ['text/csv'], maxBytes: 1024 },
    artifact: {
      sourceOperationId: source.id,
      urlJsonPointer: '/downloadSignedUrl',
      allowedOrigins: ['https://files.example.invalid'],
      mimeTypes: ['text/csv'],
      maxBytes: 1024,
    },
    evidence: {
      ...structuredClone(source.evidence),
      httpStatus: 200,
      responseContentType: 'text/csv',
      directReplay: {
        source: 'direct_http', status: 200, parsedData: true, observedAt: '2026-10-06T00:00:00Z',
        ownerVerified: true, tlsVerified: true, trustEnv: false, redirectsFollowed: false,
        explicitRetries: 0, attemptCountPerMutation: 1, responseBytes: 12,
        responseDigestPersisted: true, responseSha256: 'b'.repeat(64), requestDigest: 'c'.repeat(64),
        intentDigest: 'd'.repeat(64), requestHeaderNames: [], cookieNames: [],
      },
    },
  });
  return registry;
}

test('credentialless artifact fetch allows only declared server-issued origins and omits cookies', async () => {
  const registry = fixtureRegistry(await loadContractRegistry());
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url: url.href, init };
    return new Response('label,value\nneutral,14\n', { status: 200, headers: { 'content-type': 'text/csv' } });
  };
  const fetchFile = createGrokFileArtifactFetch({ registry, fetchImpl }).fetch;
  const response = await fetchFile('https://files.example.invalid/signed/private?signature=opaque', {
    method: 'GET', credentials: 'omit', redirect: 'manual',
  });
  assert.equal(response.status, 200);
  assert.equal(seen.init.credentials, 'omit');
  assert.equal(seen.init.redirect, 'manual');
  assert.equal(Object.hasOwn(seen.init, 'headers'), false);
  assert.equal(seen.url.includes('opaque'), true);
});

test('credentialless artifact fetch rejects an unlisted origin, cookies, headers, and redirects', async () => {
  const registry = fixtureRegistry(await loadContractRegistry());
  const fetchFile = createGrokFileArtifactFetch({ registry, fetchImpl: async () => new Response('') }).fetch;
  await assert.rejects(fetchFile('https://other.example.invalid/file.csv', {
    method: 'GET', credentials: 'omit', redirect: 'manual',
  }), { code: 'FILE_ARTIFACT_FETCH_SCOPE' });
  await assert.rejects(fetchFile('https://files.example.invalid/file.csv', {
    method: 'GET', credentials: 'omit', redirect: 'manual', headers: { cookie: 'sso=never' },
  }), { code: 'FILE_ARTIFACT_FETCH_SCOPE' });
  await assert.rejects(fetchFile('https://files.example.invalid/file.csv', {
    method: 'GET', credentials: 'include', redirect: 'manual',
  }), { code: 'FILE_ARTIFACT_FETCH_SCOPE' });
  await assert.rejects(fetchFile('https://files.example.invalid/file.csv', {
    method: 'GET', credentials: 'omit', redirect: 'follow',
  }), { code: 'FILE_ARTIFACT_FETCH_SCOPE' });
});

test('source-resolved artifact URL uses no credentials and rejects private or non-HTTPS targets', async () => {
  const registry = await loadContractRegistry();
  let seen;
  const fetchFile = createGrokFileArtifactFetch({
    registry,
    fetchImpl: async (url, init) => {
      seen = { url: url.href, init };
      return new Response('label,value\nneutral,14\n', { status: 200, headers: { 'content-type': 'text/csv' } });
    },
  });
  const response = await fetchFile.fetchSourceResolvedArtifact('https://files.example.invalid/opaque?signature=private');
  assert.equal(response.status, 200);
  assert.equal(seen.init.credentials, 'omit');
  assert.equal(seen.init.redirect, 'manual');
  assert.equal(seen.init.method, 'GET');
  assert.equal(Object.hasOwn(seen.init, 'headers'), false);
  assert.equal(seen.url.includes('private'), true);
  await assert.rejects(fetchFile.fetchSourceResolvedArtifact('http://files.example.invalid/object'),
    { code: 'FILE_ARTIFACT_URL_SCOPE' });
  await assert.rejects(fetchFile.fetchSourceResolvedArtifact('https://127.0.0.1/private'),
    { code: 'FILE_ARTIFACT_URL_SCOPE' });
});
