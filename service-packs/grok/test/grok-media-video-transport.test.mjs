import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createGrokCffiVideoFetch } from '../src/grok-media-video-transport.mjs';
import { buildGrokImagineVideoCreateBody } from '../src/grok-media-api.mjs';

function assetRequestContext() {
  return {
    schemaVersion: 1, source: 'normal_ui_asset_request', ownerIdentityDigest: 'a'.repeat(64),
    assetOrigin: 'https://assets.grok.com', pathClass: '/users/*/generated/*', method: 'GET',
    observedCookieNames: ['sso'],
    cookies: [{ name: 'sso', value: 'test-owner-cookie', domain: '.grok.com', path: '/', secure: true, httpOnly: true }],
    headers: { referer: 'https://grok.com/', 'user-agent': 'Mozilla/5.0 Chrome/154.0.0.0 Safari/537.36', 'sec-ch-ua-platform': '"Linux"' },
  };
}

async function makeDirectory() {
  const base = path.join(homedir(), '.nad-scratch', 'tmp');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(base, 'grok-media-video-transport-'));
  await chmod(directory, 0o700);
  return directory;
}

test('CFFI video transport allows only the captured first-party endpoint and native sso binding', async t => {
  const directory = await makeDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const body = Buffer.from('{"accepted":true}', 'utf8');
  const helperReply = {
    status: 200, contentType: 'application/json', httpVersion: 'h2',
    bodyBase64: body.toString('base64'), bodyBytes: body.length,
    responseBodySha256: createHash('sha256').update(body).digest('hex'),
    contentLength: body.length, retryAfterSeconds: null,
    cfMitigated: false,
    requestHeaderNames: ['accept','content-type','origin','referer','sec-ch-ua-platform','user-agent','x-statsig-id','x-xai-request-id'],
    responseHeaderNames: ['content-length','content-type'],
    cookieNamesUsed: ['sso'], source: 'curl_cffi-0.16.3-chrome150',
  };
  const scriptPath = path.join(directory, 'fake-video-http.mjs');
  await writeFile(scriptPath, `process.stdout.write(${JSON.stringify(JSON.stringify(helperReply))});\n`, { mode: 0o600 });
  const context = assetRequestContext();
  const fetchImpl = createGrokCffiVideoFetch({
    pythonExecutable: process.execPath,
    scriptPath,
    assetRequestContext: context,
    expectedOwnerIdentityDigest: context.ownerIdentityDigest,
  });
  const headers = {
    accept: 'application/json', 'content-type': 'application/json', origin: 'https://grok.com', referer: 'https://grok.com/imagine',
    cookie: 'sso=test-owner-cookie', 'user-agent': 'Mozilla/5.0 Chrome/154.0.0.0 Safari/537.36',
    'sec-ch-ua-platform': '"Linux"', 'x-statsig-id': 'safe-sdk-id', 'x-xai-request-id': 'safe-request-id',
  };
  const response = await fetchImpl('https://grok.com/rest/app-chat/conversations/new', {
    method: 'POST', headers, body: JSON.stringify(buildGrokImagineVideoCreateBody({ prompt: 'neutral video test' })),
    credentials: 'omit', redirect: 'manual',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accepted: true });
  assert.deepEqual(response.transportEvidence.cookieNamesUsed, ['sso']);
  assert.equal(response.transportEvidence.responseBodySha256, createHash('sha256').update(body).digest('hex'));
  assert.equal(response.transportEvidence.responseBytesRead, body.length);
  assert.equal(response.transportEvidence.contentLength, body.length);
  assert.deepEqual(response.transportEvidence.responseHeaderNames, ['content-length','content-type']);
  const imageReferenceBody = {
    enableImageStreaming: true, enableSideBySide: true, kind: 'CONVERSATION_KIND_IMAGINE',
    mediaGenInput: { imageToVideo: { prompt: 'neutral video test', inputAssets: ['private-image-asset-0001'],
      aspectRatio: '2:3', duration: 6, resolutionName: '480p', mode: 'custom', skipAudio: true } },
    message: 'neutral video test --mode=custom', modelName: 'imagine-video-gen',
    responseMetadata: { experiments: [], modelConfigOverride: { modelMap: {} } }, sendFinalMetadata: true,
  };
  const imageReferenceHeaders = { ...headers,
    referer: 'https://grok.com/imagine/post/private-image-asset-0001?scope=asset&conversation=private-conversation-test-0001' };
  const imageReferenceResponse = await fetchImpl('https://grok.com/rest/app-chat/conversations/new', {
    method: 'POST', headers: imageReferenceHeaders, body: JSON.stringify(imageReferenceBody),
    credentials: 'omit', redirect: 'manual',
  });
  assert.equal(imageReferenceResponse.status, 200);
  await assert.rejects(fetchImpl('https://grok.com/rest/app-chat/conversations/new', {
    method: 'POST', headers: { ...imageReferenceHeaders, referer: 'https://grok.com/library?scope=asset' },
    body: JSON.stringify(imageReferenceBody), credentials: 'omit', redirect: 'manual',
  }), { code: 'MEDIA_VIDEO_HEADERS_INVALID' });
  await assert.rejects(fetchImpl('https://attacker.example/rest/app-chat/conversations/new', {
    method: 'POST', headers, body: '{}', credentials: 'omit', redirect: 'manual',
  }), { code: 'MEDIA_VIDEO_REQUEST_SCOPE_INVALID' });
  const challengeContext = { ...context, observedCookieNames: ['cf_clearance'], cookies: [
    { ...context.cookies[0], name: 'cf_clearance' },
  ] };
  assert.throws(() => createGrokCffiVideoFetch({
    pythonExecutable: process.execPath, scriptPath, assetRequestContext: challengeContext,
    expectedOwnerIdentityDigest: context.ownerIdentityDigest,
  }), { code: 'MEDIA_ASSET_REQUEST_CONTEXT_INVALID' });
});

test('CFFI video transport preserves only safe response-stage failure evidence', async t => {
  const directory = await makeDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const context = assetRequestContext();
  const evidence = {
    stage: 'response_body', requestStarted: true, responseReceived: true, httpStatus: 200,
    contentType: 'application/json', httpVersion: 'h2', responseBytesRead: 17, requestBodyBytes: 586,
    cfMitigated: false, errorClass: 'ConnectionError',
    requestHeaderNames: ['accept','content-type','origin','referer','sec-ch-ua-platform','user-agent','x-statsig-id','x-xai-request-id'],
    responseHeaderNames: ['content-length','content-type'], cookieNamesUsed: ['sso'],
    source: 'curl_cffi-0.16.3-chrome150',
  };
  const partialResources = {
    requestIds: [], conversationIds: ['private-conversation-test-0001'],
    responseIds: ['private-response-test-0001'], assetIds: [], itemIds: [], postIds: [],
  };
  const helperReply = { error: 'CFFI_RESPONSE_STREAM_FAILED', transportEvidence: evidence, partialResources,
    responseBodySha256: 'd'.repeat(64) };
  const scriptPath = path.join(directory, 'fake-video-error.mjs');
  await writeFile(scriptPath, `process.stdout.write(${JSON.stringify(JSON.stringify(helperReply))});process.exitCode=2;\n`, { mode: 0o600 });
  const fetchImpl = createGrokCffiVideoFetch({
    pythonExecutable: process.execPath,
    scriptPath,
    assetRequestContext: context,
    expectedOwnerIdentityDigest: context.ownerIdentityDigest,
  });
  const headers = {
    accept: 'application/json', 'content-type': 'application/json', origin: 'https://grok.com',
    referer: 'https://grok.com/imagine', cookie: 'sso=test-owner-cookie',
    'user-agent': 'Mozilla/5.0 Chrome/154.0.0.0 Safari/537.36', 'sec-ch-ua-platform': '"Linux"',
    'x-statsig-id': 'safe-sdk-id', 'x-xai-request-id': 'safe-request-id',
  };
  await assert.rejects(fetchImpl('https://grok.com/rest/app-chat/conversations/new', {
    method: 'POST', headers, body: JSON.stringify(buildGrokImagineVideoCreateBody({ prompt: 'neutral video test' })),
    credentials: 'omit', redirect: 'manual',
  }), error => {
    assert.equal(error.code, 'MEDIA_VIDEO_CFFI_REQUEST_FAILED');
    assert.deepEqual(error.details.transportEvidence, evidence);
    assert.deepEqual(error.details.partialResources, partialResources);
    assert.equal(error.details.responseBodySha256, 'd'.repeat(64));
    assert.doesNotMatch(JSON.stringify(error), /test-owner-cookie|safe-sdk-id|neutral video test/);
    return true;
  });
});

test('checked-in CFFI helper accepts the source-shaped image-to-video body before header preflight', () => {
  const body = {
    enableImageStreaming: true, enableSideBySide: true, kind: 'CONVERSATION_KIND_IMAGINE',
    mediaGenInput: { imageToVideo: { prompt: 'neutral reference video test', inputAssets: ['private-image-asset-0001'],
      aspectRatio: '2:3', duration: 6, resolutionName: '480p', mode: 'custom', skipAudio: true } },
    message: 'neutral reference video test --mode=custom', modelName: 'imagine-video-gen',
    responseMetadata: { experiments: [], modelConfigOverride: { modelMap: {} } }, sendFinalMetadata: true,
  };
  const packet = {
    bodyText: JSON.stringify(body), cookies: [],
    headers: { 'content-type': 'application/json', origin: 'https://grok.com',
      referer: 'https://grok.com/imagine/post/private-image-asset-0001?scope=asset&conversation=private-conversation-0001' },
    method: 'POST', observedCookieNames: ['sso'], timeoutMs: 30_000,
    url: 'https://grok.com/rest/app-chat/conversations/new',
  };
  const result = spawnSync('python3', ['scripts/grok_media_video_submit.py'], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    input: JSON.stringify(packet), encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: homedir(), PYTHONDONTWRITEBYTECODE: '1' },
    timeout: 15_000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).error, 'NATIVE_HEADER_BINDING_REQUIRED');
  assert.doesNotMatch(result.stdout + result.stderr, /private-image-asset|private-conversation|neutral reference video test/);
});

test('CFFI helper identifies session-construction failure before any request starts', async t => {
  const directory = await makeDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packageRoot = path.join(directory, 'python-stubs');
  const moduleDirectory = path.join(packageRoot, 'curl_cffi');
  await mkdir(moduleDirectory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(moduleDirectory, '__init__.py'), "__version__ = '0.16.3'\n", { mode: 0o600 });
  await writeFile(path.join(moduleDirectory, 'requests.py'), `class Session:\n    def __init__(self, **kwargs):\n        raise RuntimeError('private setup text must not be emitted')\n`, { mode: 0o600 });
  const prompt = 'neutral session setup test';
  const body = {
    enableImageStreaming: true, enableSideBySide: true, kind: 'CONVERSATION_KIND_IMAGINE',
    mediaGenInput: { imageToVideo: { prompt, inputAssets: ['private-image-asset-0001'], aspectRatio: '2:3',
      duration: 6, resolutionName: '480p', mode: 'custom', skipAudio: true } },
    message: `${prompt} --mode=custom`, modelName: 'imagine-video-gen',
    responseMetadata: { experiments: [], modelConfigOverride: { modelMap: {} } }, sendFinalMetadata: true,
  };
  const packet = {
    bodyText: JSON.stringify(body), cookies: [{ name: 'sso', value: 'test-cookie-value', domain: '.grok.com',
      path: '/', secure: true, httpOnly: true }],
    headers: { accept: 'application/json', 'content-type': 'application/json', origin: 'https://grok.com',
      referer: 'https://grok.com/imagine/post/private-image-asset-0001?scope=asset&conversation=private-conversation-0001',
      'user-agent': 'Mozilla/5.0 Chrome/154.0.0.0', 'sec-ch-ua-platform': '"Linux"',
      'x-statsig-id': 'test-statsig-id', 'x-xai-request-id': 'test-request-id' },
    method: 'POST', observedCookieNames: ['sso'], timeoutMs: 30_000,
    url: 'https://grok.com/rest/app-chat/conversations/new',
  };
  const result = spawnSync('python3', ['scripts/grok_media_video_submit.py'], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    input: JSON.stringify(packet), encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: homedir(), TMPDIR: path.join(homedir(), '.nad-scratch', 'tmp'),
      PYTHONPATH: packageRoot, PYTHONDONTWRITEBYTECODE: '1' },
    timeout: 15_000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 2);
  const reply = JSON.parse(result.stdout);
  assert.equal(reply.error, 'CFFI_SESSION_CREATE_FAILED');
  assert.deepEqual({ stage: reply.transportEvidence.stage, requestStarted: reply.transportEvidence.requestStarted,
    responseReceived: reply.transportEvidence.responseReceived, errorClass: reply.transportEvidence.errorClass,
    httpStatus: reply.transportEvidence.httpStatus, responseBytesRead: reply.transportEvidence.responseBytesRead,
    cookieNamesUsed: reply.transportEvidence.cookieNamesUsed }, {
    stage: 'session_setup', requestStarted: false, responseReceived: false, errorClass: 'RuntimeError',
    httpStatus: null, responseBytesRead: 0, cookieNamesUsed: [],
  });
  assert.doesNotMatch(result.stdout + result.stderr, /private setup text|test-cookie-value|test-statsig-id|private-image-asset/);
});

test('Node default timeout matches the real Python packet validator and fails before the fake session can send', async t => {
  const directory = await makeDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packageRoot = path.join(directory, 'python-stubs');
  const moduleDirectory = path.join(packageRoot, 'curl_cffi');
  await mkdir(moduleDirectory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(moduleDirectory, '__init__.py'), "__version__ = '0.16.3'\n", { mode: 0o600 });
  await writeFile(path.join(moduleDirectory, 'requests.py'), `class Session:\n    def __init__(self, **kwargs):\n        raise RuntimeError('intentional no-network test')\n`, { mode: 0o600 });
  const pythonShim = path.join(directory, 'python-with-stub');
  await writeFile(pythonShim, `#!/bin/sh\nexport PYTHONPATH='${packageRoot}'\nexec python3 "$@"\n`, { mode: 0o700 });
  await chmod(pythonShim, 0o700);
  const context = assetRequestContext();
  const fetchImpl = createGrokCffiVideoFetch({
    pythonExecutable: pythonShim,
    scriptPath: path.resolve(path.dirname(new URL(import.meta.url).pathname), '../scripts/grok_media_video_submit.py'),
    assetRequestContext: context,
    expectedOwnerIdentityDigest: context.ownerIdentityDigest,
  });
  const prompt = 'neutral default-timeout validator test';
  const body = {
    enableImageStreaming: true, enableSideBySide: true, kind: 'CONVERSATION_KIND_IMAGINE',
    mediaGenInput: { imageToVideo: { prompt, inputAssets: ['private-image-asset-0001'], aspectRatio: '2:3',
      duration: 6, resolutionName: '480p', mode: 'custom', skipAudio: true } },
    message: `${prompt} --mode=custom`, modelName: 'imagine-video-gen',
    responseMetadata: { experiments: [], modelConfigOverride: { modelMap: {} } }, sendFinalMetadata: true,
  };
  const headers = {
    accept: 'application/json', 'content-type': 'application/json', origin: 'https://grok.com',
    referer: 'https://grok.com/imagine/post/private-image-asset-0001?scope=asset&conversation=private-conversation-test-0001',
    cookie: 'sso=test-owner-cookie', 'user-agent': 'Mozilla/5.0 Chrome/154.0.0.0 Safari/537.36',
    'sec-ch-ua-platform': '"Linux"', 'x-statsig-id': 'test-statsig-id', 'x-xai-request-id': 'test-xai-request-id',
  };
  await assert.rejects(fetchImpl('https://grok.com/rest/app-chat/conversations/new', {
    method: 'POST', headers, body: JSON.stringify(body), credentials: 'omit', redirect: 'manual',
  }), error => {
    assert.equal(error.code, 'MEDIA_VIDEO_CFFI_REQUEST_FAILED');
    assert.equal(error.details.helperErrorCode, 'CFFI_SESSION_CREATE_FAILED');
    assert.equal(error.details.transportEvidence.stage, 'session_setup');
    assert.equal(error.details.transportEvidence.requestStarted, false);
    assert.equal(error.details.transportEvidence.responseReceived, false);
    assert.equal(error.details.transportEvidence.httpStatus, null);
    assert.equal(error.details.responseBodySha256, null);
    return true;
  });
});
