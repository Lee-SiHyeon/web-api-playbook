import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAuthenticatedChromeFetch } from '../src/authenticated-chrome-fetch.mjs';

function registry() {
  return {
    schemaVersion: 1,
    serviceId: 'grok-web',
    serviceOrigin: 'https://grok.com',
    allowedOrigins: ['https://grok.com'],
    identityOperationId: null,
    operations: [{
      id: 'test.private.read',
      kind: 'read',
      method: 'GET',
      urlTemplate: 'https://grok.com/rest/test/{{input.id}}',
      authMode: 'session',
      request: {
        inputSchema: { properties: { id: { type: 'string', maxLength: 64 } }, required: ['id'] },
        credentialBindings: { cookies: ['sso'], headers: [] },
      },
      response: { mode: 'json', statuses: [200], contentTypes: ['application/json'], maxBytes: 4096 },
      evidence: {
        source: 'browser_network_capture',
        capturedAt: '2026-10-06T00:00:00+09:00',
        requestMethod: 'GET',
        requestPath: '/rest/test/__grok_input_segment__',
        httpStatus: 200,
        responseContentType: 'application/json',
        securityBoundary: 'normal_observed_xhr',
        securitySignals: [],
      },
    }],
  };
}

async function fakePython(t, reply, { inspectMetadata = false } = {}) {
  const scratchRoot = process.env.TMPDIR || path.join(os.homedir(), '.nad-scratch', 'tmp');
  await mkdir(scratchRoot, { recursive: true });
  const directory = await mkdtemp(path.join(scratchRoot, 'grok-auth-fetch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'python');
  const metadataBodyCode = inspectMetadata
    ? `
  const credentials = packet.credentialHeaders || {};
  bodyBase64 = Buffer.from(JSON.stringify({
    urlOk: packet.url === "https://grok.com/rest/test/item-1",
    methodOk: packet.method === "GET",
    cookieNames: packet.cookies.map(cookie => cookie.name),
    allowedCookieNames: packet.allowedCookieNames,
    metadataNames: Object.keys(credentials).sort(),
    metadataValuesPresent: credentials["x-statsig-id"] === "current-browser-value"
      && credentials["x-xai-request-id"] === "per-action-id",
    cookieHeaderPresent: Object.hasOwn(packet.headers, "cookie"),
  })).toString("base64");
`
    : `bodyBase64 = ${JSON.stringify(reply.bodyBase64)};`;
  const script = `#!/usr/bin/env node
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const packet = JSON.parse(input);
  let bodyBase64;
${metadataBodyCode}
  process.stdout.write(JSON.stringify({
    status: ${reply.status},
    contentType: ${JSON.stringify(reply.contentType)},
    httpVersion: ${JSON.stringify(reply.httpVersion)},
    bodyBase64,
    setCookies: [],
  }));
});
`;
  await writeFile(executable, script, { mode: 0o700 });
  await chmod(executable, 0o700);
  return executable;
}

test('authenticated Chrome transport passes only the observed operation and scoped session cookie', async t => {
  const bodyBase64 = Buffer.from('{"value":"ok"}').toString('base64');
  const pythonExecutable = await fakePython(t, {
    status: 200, contentType: 'application/json', httpVersion: 'h2', bodyBase64, setCookies: [],
  });
  const fetchImpl = createAuthenticatedChromeFetch({ registry: registry(), pythonExecutable });
  const response = await fetchImpl('https://grok.com/rest/test/item-1', {
    method: 'GET',
    headers: { cookie: 'sso=test-session-cookie', accept: 'application/json' },
    redirect: 'manual',
  });
  assert.equal(response.status, 200);
  assert.equal(response.transportEvidence.httpVersion, 'h2');
  assert.deepEqual(await response.json(), { value: 'ok' });
});

test('authenticated Chrome transport blocks challenge cookies and unobserved routes before spawn', async () => {
  const fetchImpl = createAuthenticatedChromeFetch({ registry: registry(), pythonExecutable: '/no-such-executable' });
  await assert.rejects(fetchImpl('https://grok.com/rest/test/item-1', {
    method: 'GET', headers: { cookie: 'sso=ok; cf_clearance=challenge' }, redirect: 'manual',
  }), { code: 'AUTH_CHROME_COOKIE_REJECTED' });
  await assert.rejects(fetchImpl('https://grok.com/rest/test/item-1', {
    method: 'GET', headers: {}, redirect: 'manual',
  }), { code: 'AUTH_CHROME_COOKIE_REJECTED' });
  await assert.rejects(fetchImpl('https://grok.com/rest/test/item-1?unobserved=yes', {
    method: 'GET', headers: { cookie: 'sso=ok' }, redirect: 'manual',
  }), { code: 'AUTH_CHROME_OPERATION_UNRESOLVED' });
});

test('authenticated Chrome transport forwards only contract-listed per-action metadata headers in memory', async t => {
  const bodyBase64 = Buffer.from('{"value":"ok"}').toString('base64');
  const pythonExecutable = await fakePython(t, {
    status: 200, contentType: 'application/json', httpVersion: 'h2', bodyBase64, setCookies: [],
  }, { inspectMetadata: true });
  const captured = registry();
  captured.operations[0].request.perActionMetadataHeaders = ['x-statsig-id', 'x-xai-request-id'];
  const fetchImpl = createAuthenticatedChromeFetch({ registry: captured, pythonExecutable });
  const response = await fetchImpl('https://grok.com/rest/test/item-1', {
    method: 'GET',
    headers: {
      cookie: 'sso=test-session-cookie',
      'x-statsig-id': 'current-browser-value',
      'x-xai-request-id': 'per-action-id',
    },
    redirect: 'manual',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    urlOk: true, methodOk: true, cookieNames: ['sso'], allowedCookieNames: ['sso'],
    metadataNames: ['x-statsig-id', 'x-xai-request-id'], metadataValuesPresent: true, cookieHeaderPresent: false,
  });
});

test('optional source-conversation metadata may be absent and is forwarded only when present', async t => {
  const pythonExecutable = await fakePython(t, {
    status: 200, contentType: 'application/json', httpVersion: 'h2', bodyBase64: '', setCookies: [],
  }, { inspectMetadata: true });
  const captured = registry();
  captured.operations[0].request.optionalPerActionMetadataHeaders = ['x-source-conversation-id'];
  const fetchImpl = createAuthenticatedChromeFetch({ registry: captured, pythonExecutable });
  for (const present of [false, true]) {
    const response = await fetchImpl('https://grok.com/rest/test/item-1', {
      method: 'GET', redirect: 'manual', headers: {
        cookie: 'sso=test-session-cookie', ...(present ? { 'x-source-conversation-id': 'fixture-source-conversation' } : {}),
      },
    });
    const data = await response.json();
    assert.deepEqual(data.metadataNames, present ? ['x-source-conversation-id'] : []);
    assert.equal(data.cookieHeaderPresent, false);
  }
});
