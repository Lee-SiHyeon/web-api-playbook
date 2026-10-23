import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GrokWebClient } from '../src/client.mjs';
import { ProtectedJsonStore } from '../src/protected-json-store.mjs';

function testRegistry() {
  const evidence = {
    source: 'browser_network_capture',
    capturedAt: '2026-10-06',
    requestMethod: 'GET',
    requestPath: '/rest/account/me',
    httpStatus: 200,
    responseContentType: 'application/json',
    securityBoundary: 'normal_observed_xhr',
    securitySignals: [],
  };
  return {
    schemaVersion: 1,
    serviceId: 'grok-web',
    serviceOrigin: 'https://grok.com',
    allowedOrigins: ['https://grok.com'],
    identityOperationId: 'identity.read',
    operations: [{
      id: 'identity.read',
      kind: 'read',
      role: 'identity',
      identityJsonPointer: '/handle',
      method: 'GET',
      urlTemplate: 'https://grok.com/rest/account/me',
      authMode: 'session',
      request: { credentialBindings: { cookies: ['sid'], headers: [] }, inputSchema: { properties: {}, required: [] } },
      response: { mode: 'json', statuses: [200], contentTypes: ['application/json'], maxBytes: 4096 },
      evidence,
    }],
  };
}

test('client.read exposes the transport raw-body digest separately from its parsed-data digest', async () => {
  const rawBody = '{\n  "handle" : "owner-raw-proof"\n}\n';
  const sessionPersistence = new ProtectedJsonStore({ provider: 'memory' });
  const fetchImpl = async (url, init) => {
    assert.equal(new Headers(init.headers).get('cookie'), 'sid=test-session-cookie');
    assert.equal(String(url), 'https://grok.com/rest/account/me');
    return new Response(rawBody, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = new GrokWebClient({ registry: testRegistry(), sessionPersistence, fetchImpl });
  const bundle = {
    schemaVersion: 1,
    serviceId: 'grok-web',
    origin: 'https://grok.com',
    capturedAt: new Date().toISOString(),
    sourceObservationId: 'read-raw-digest-test',
    origins: [{ origin: 'https://grok.com', cookies: [{ name: 'sid', value: 'test-session-cookie',
      domain: 'grok.com', path: '/', secure: true, httpOnly: true }], headers: [] }],
  };
  await client.importSession(bundle);
  await client.verifyOwner('owner-raw-proof');
  const result = await client.read('identity.read');
  const rawDigest = createHash('sha256').update(rawBody).digest('hex');
  const parsedDigest = createHash('sha256').update(JSON.stringify({ handle: 'owner-raw-proof' })).digest('hex');
  assert.equal(result.rawResponseDigest, rawDigest);
  assert.equal(result.rawResponseDigestKind, 'raw_http_body');
  assert.equal(result.responseDigest, parsedDigest);
  assert.notEqual(result.rawResponseDigest, result.responseDigest);
  assert.equal(result.responseBytes, Buffer.byteLength(rawBody));
  await client.clearSession();
});
