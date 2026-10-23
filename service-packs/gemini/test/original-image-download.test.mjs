import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { GeminiWebClient } from '../src/client.mjs';
import {
  downloadGeminiOriginalImageOnce,
  prepareGeminiOriginalImageDownload,
  originalImageDownloadContractSummary,
} from '../src/original-image-download.mjs';

const API_ID = 'c_1234567890abcdef';
const ROUTE_ID = API_ID.slice(2);
const PROMPT = 'Create the teal sphere and white cube image';
const ORIGINAL_ID = 'a'.repeat(42);
const FINAL_ID = 'b'.repeat(42);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(name, data) {
  const type = Buffer.from(name, 'ascii');
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crcInput = Buffer.concat([type, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(crcInput));
  return Buffer.concat([length, crcInput, crc]);
}

function pngFixture(width = 1, height = 1) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const rows = Buffer.alloc(height * (1 + width * 4));
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))]);
}

function batchResponse(downloadUrl) {
  const rpcData = JSON.stringify([downloadUrl]);
  const frame = JSON.stringify([[['wrb.fr', 'c8o8Fe', rpcData, null, null, null, 'generic']]]);
  const progress = JSON.stringify([]);
  const encode = (value) => `${value.length + 2}\n${value}\n`;
  return Buffer.from(`)]}'\n${encode(frame)}${encode(progress)}`, 'utf8');
}

function response(status, contentType, bytes) {
  const body = Buffer.from(bytes);
  return {
    status,
    headers: new Headers({ 'content-type': contentType, 'content-length': String(body.length) }),
    body: Readable.from([body]),
  };
}

function makeTaskReadback({ id = API_ID, prompt = PROMPT } = {}) {
  const result = {
    httpStatus: 200,
    binding: { bound: true },
    summary: {
      rpcMatchCount: 1,
      taskIntentMatched: true,
      apiConversationIdMatched: true,
    },
  };
  Object.defineProperty(result, 'payload', { value: [id, prompt], enumerable: false });
  return Object.freeze(result);
}

function makePreparedRequest({ id = API_ID, downloadId = ORIGINAL_ID } = {}) {
  const args = [[[id]], null, null, null, null];
  const fReq = JSON.stringify([[['c8o8Fe', JSON.stringify(args), null, 'generic']]]);
  const params = new URLSearchParams([
    ['f.req', fReq], ['at', 'native-batch-token'],
  ]);
  const url = new URL('https://gemini.google.com/_/BardChatUi/data/batchexecute');
  for (const [key, value] of Object.entries({
    rpcids: 'c8o8Fe', 'source-path': '/app', bl: 'captured-build', 'f.sid': 'captured-session',
    hl: 'en', _reqid: '12345', rt: 'c',
  })) url.searchParams.append(key, value);
  const baseUrl = `https://lh3.googleusercontent.com/gg/${downloadId}`;
  const originalSizeUrl = `${baseUrl}=s0-d-I`;
  const ref = (origin, pathname) => ({
    origin,
    pathFamily: pathname.replace(/\/(?:[0-9a-f-]{16,}|[^/]{41,})(?=\/|$)/gi, '/{id}'),
    queryKeyNames: ['alr'],
  });
  const referer = `https://gemini.google.com/app/${ROUTE_ID}`;
  return {
    nativeRequest: {
      url: url.toString(),
      method: 'POST',
      body: params.toString(),
      contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
      headers: {
        accept: '*/*',
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        origin: 'https://gemini.google.com',
        referer,
        'x-same-domain': '1',
      },
    },
    source: {
      normalUiCaptureVerified: true,
      downloadRpcId: 'c8o8Fe',
      originalSizeControlObserved: true,
      originalSizeControlClicked: true,
      browserDownloadEventObserved: true,
      c8ResponseHttpStatus: 200,
      c8ResponseRpcMatchCount: 1,
      nativeDownloadUrl: baseUrl,
      originalSizeUrl,
      observedAssetRequests: [
        {
          method: 'GET', url: `${originalSizeUrl}?alr=yes`, requestExtraInfoObserved: true,
          cookieNames: [], headers: { accept: '*/*', referer },
        },
        {
          method: 'GET', url: `https://lh3.google.com/rd-gg/${FINAL_ID}?alr=yes`, requestExtraInfoObserved: true,
          cookieNames: ['SID'], headers: { accept: '*/*', referer },
        },
        {
          method: 'GET', url: `https://lh3.googleusercontent.com/rd-gg/${FINAL_ID}?alr=yes`, requestExtraInfoObserved: true,
          cookieNames: [], headers: { accept: '*/*', referer },
        },
      ],
    },
  };
}

function makeClient(fetchImpl) {
  return {
    verifiedOwner: 'owner@example.test',
    contract: {
      assetOrigins: [
        'https://lh3.googleusercontent.com', 'https://lh3.google.com',
      ],
      mediaAssetDownload: {
        cookieScopes: [{ name: 'SID', domain: '.google.com', path: '/', secure: true }],
      },
    },
    transport: {
      session: {
        cookies: [{ name: 'SID', value: 'session-cookie' }],
        mediaCookies: [{ name: 'SID', value: 'asset-cookie', domain: '.google.com', path: '/', secure: true }],
      },
      fetch: fetchImpl,
    },
  };
}

function makeMainClient(fetchImpl, taskReadback) {
  const client = Object.create(GeminiWebClient.prototype);
  Object.assign(client, {
    verifiedOwner: 'owner@example.test',
    contract: {
      assetOrigins: ['https://lh3.googleusercontent.com', 'https://lh3.google.com'],
      mediaAssetDownload: {
        cookieScopes: [{ name: 'SID', domain: '.google.com', path: '/', secure: true }],
      },
    },
    transport: {
      session: {
        cookies: [{ name: 'SID', value: 'session-cookie' }],
        mediaCookies: [{ name: 'SID', value: 'asset-cookie', domain: '.google.com', path: '/', secure: true }],
      },
      fetch: fetchImpl,
    },
    readHistoryDetail: async (options) => {
      assert.equal(options.mediaCapability, 'image');
      assert.equal(options.expectedIntent, PROMPT);
      return taskReadback;
    },
  });
  return client;
}

async function makeScratchRoot(t) {
  const root = process.env.TMPDIR || path.join(os.homedir(), '.nad-scratch', 'tmp');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'gemini-original-image-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('replays captured c8o8Fe, applies source size-zero URL transform, and reads back exact PNG bytes', async (t) => {
  const scratch = await makeScratchRoot(t);
  const artifactRoot = path.join(scratch, 'artifacts');
  await mkdir(artifactRoot, { recursive: true });
  const expectedPath = path.join(scratch, 'expected.png');
  const png = pngFixture(2, 1);
  await writeFile(expectedPath, png);
  const baseUrl = `https://lh3.googleusercontent.com/gg/${ORIGINAL_ID}`;
  const finalUrl = `https://lh3.googleusercontent.com/rd-gg/${FINAL_ID}`;
  const c8Body = batchResponse(baseUrl);
  const getCalls = [];
  const fetchImpl = async (urlValue, init = {}) => {
    const url = new URL(urlValue);
    if (init.method === 'POST') return response(200, 'application/json', c8Body);
    getCalls.push({ url, headers: new Headers(init.headers || {}) });
    if (url.hostname === 'lh3.googleusercontent.com' && url.pathname.startsWith('/gg/')) {
      return response(200, 'text/plain', `https://lh3.google.com/rd-gg/${FINAL_ID}`);
    }
    if (url.hostname === 'lh3.google.com') {
      assert.equal(parseCookieNames(init.headers.get('cookie')), 'SID');
      return response(200, 'text/plain', finalUrl);
    }
    if (url.hostname === 'lh3.googleusercontent.com' && url.pathname.startsWith('/rd-gg/')) {
      return response(200, 'image/png', png);
    }
    throw new Error('UNEXPECTED_TEST_URL');
  };
  const client = makeClient(fetchImpl);
  const taskReadback = makeTaskReadback();
  const preparedRequest = makePreparedRequest();
  const prepared = prepareGeminiOriginalImageDownload({
    client, taskReadback, expectedOwner: 'Owner@example.test', apiConversationId: API_ID,
    visibleRouteId: ROUTE_ID, expectedIntent: PROMPT, preparedRequest,
  });
  assert.equal(prepared.summary.operation, 'c8o8Fe');
  assert.equal(prepared.summary.request.argsTopLevelCount, 5);
  assert.equal(JSON.stringify(prepared).includes(API_ID), false);

  const result = await downloadGeminiOriginalImageOnce({
    client, taskReadback, expectedOwner: 'owner@example.test', apiConversationId: API_ID,
    visibleRouteId: ROUTE_ID, expectedIntent: PROMPT, preparedRequest,
    artifactRoot, artifactName: 'direct.png', expectedArtifactPath: expectedPath,
  });
  assert.equal(result.outcome, 'fullsize_direct_http_verified');
  assert.equal(result.c8.httpStatus, 200);
  assert.equal(result.c8.framing.lengthUnit, 'utf16_code_units');
  assert.equal(result.c8.framing.frameLengthOverheadUnits, 2);
  assert.equal(result.asset.dimensions.width, 2);
  assert.equal(result.asset.dimensions.height, 1);
  assert.equal(result.asset.bytesMatchedExpected, true);
  assert.equal(result.asset.independentFileReadback, true);
  assert.equal(result.asset.hops.length, 3);
  assert.equal(getCalls[0].url.pathname.endsWith('=s0-d-I'), true);
  assert.equal(getCalls[0].url.searchParams.get('alr'), 'yes');
  assert.equal(result.credentialBinding.assetCookieScopesValidated, true);
  assert.equal(JSON.stringify(result).includes(API_ID), false);
  assert.equal(JSON.stringify(result).includes('asset-cookie'), false);
});

test('main Gemini client wrapper performs hNvQHb task binding before original-image dispatch', async (t) => {
  const scratch = await makeScratchRoot(t);
  const artifactRoot = path.join(scratch, 'artifacts');
  await mkdir(artifactRoot, { recursive: true });
  const expectedPath = path.join(scratch, 'expected.png');
  const png = pngFixture(2, 1);
  await writeFile(expectedPath, png);
  const c8Body = batchResponse(`https://lh3.googleusercontent.com/gg/${ORIGINAL_ID}`);
  const fetchImpl = async (urlValue, init = {}) => {
    const url = new URL(urlValue);
    if (init.method === 'POST') return response(200, 'application/json', c8Body);
    if (url.hostname === 'lh3.googleusercontent.com' && url.pathname.startsWith('/gg/')) {
      return response(200, 'text/plain', `https://lh3.googleusercontent.com/rd-gg/${FINAL_ID}`);
    }
    return response(200, 'image/png', png);
  };
  const client = makeMainClient(fetchImpl, makeTaskReadback());
  const result = await client.downloadOriginalImageOnce({
    expectedOwner: 'owner@example.test',
    apiConversationId: API_ID,
    visibleRouteId: ROUTE_ID,
    expectedIntent: PROMPT,
    preparedRequest: makePreparedRequest(),
    artifactRoot,
    artifactName: 'client-direct.png',
    expectedArtifactPath: expectedPath,
  });
  assert.equal(result.taskReadback.taskPromptMatched, true);
  assert.equal(result.taskReadback.apiConversationIdMatched, true);
  assert.equal(result.outcome, 'fullsize_direct_http_verified');
});

test('refuses an hNvQHb readback for a different conversation before network dispatch', async () => {
  let dispatchCount = 0;
  const client = makeClient(async () => { dispatchCount += 1; throw new Error('NOT_EXPECTED'); });
  assert.throws(() => prepareGeminiOriginalImageDownload({
    client, taskReadback: makeTaskReadback({ id: 'c_fedcba0987654321' }),
    expectedOwner: 'owner@example.test', apiConversationId: API_ID,
    visibleRouteId: ROUTE_ID, expectedIntent: PROMPT, preparedRequest: makePreparedRequest(),
  }), { code: 'ORIGINAL_IMAGE_TASK_READBACK_REQUIRED' });
  assert.equal(dispatchCount, 0);
});

test('requires the normal SDK original-size control and c8o8Fe source capture', async () => {
  const client = makeClient(async () => { throw new Error('NOT_EXPECTED'); });
  const preparedRequest = makePreparedRequest();
  preparedRequest.source.originalSizeControlClicked = false;
  assert.throws(() => prepareGeminiOriginalImageDownload({
    client, taskReadback: makeTaskReadback(), expectedOwner: 'owner@example.test',
    apiConversationId: API_ID, visibleRouteId: ROUTE_ID, expectedIntent: PROMPT, preparedRequest,
  }), { code: 'ORIGINAL_IMAGE_NATIVE_SOURCE_CAPTURE_REQUIRED' });
});

test('requires the size-zero transform to match the captured c8o8Fe asset family', async () => {
  const client = makeClient(async () => { throw new Error('NOT_EXPECTED'); });
  const preparedRequest = makePreparedRequest();
  preparedRequest.source.originalSizeUrl = `https://lh3.googleusercontent.com/gg/${'c'.repeat(42)}=s0-d-I`;
  assert.throws(() => prepareGeminiOriginalImageDownload({
    client, taskReadback: makeTaskReadback(), expectedOwner: 'owner@example.test',
    apiConversationId: API_ID, visibleRouteId: ROUTE_ID, expectedIntent: PROMPT, preparedRequest,
  }), { code: 'ORIGINAL_IMAGE_SIZE_TRANSFORM_UNOBSERVED' });
});

test('rejects an unobserved text/plain URL hop before making the next request', async (t) => {
  const scratch = await makeScratchRoot(t);
  const artifactRoot = path.join(scratch, 'artifacts');
  await mkdir(artifactRoot, { recursive: true });
  const expectedPath = path.join(scratch, 'expected.png');
  await writeFile(expectedPath, pngFixture());
  let getCount = 0;
  const fetchImpl = async (urlValue, init = {}) => {
    const url = new URL(urlValue);
    if (init.method === 'POST') return response(200, 'application/json', batchResponse(`https://lh3.googleusercontent.com/gg/${ORIGINAL_ID}`));
    getCount += 1;
    return response(200, 'text/plain', 'https://lh3.googleusercontent.com/unobserved/file.png');
  };
  const preparedRequest = makePreparedRequest();
  const client = makeClient(fetchImpl);
  await assert.rejects(() => downloadGeminiOriginalImageOnce({
    client, taskReadback: makeTaskReadback(), expectedOwner: 'owner@example.test',
    apiConversationId: API_ID, visibleRouteId: ROUTE_ID, expectedIntent: PROMPT,
    preparedRequest, artifactRoot, artifactName: 'blocked.png', expectedArtifactPath: expectedPath,
  }), { code: 'ORIGINAL_IMAGE_ASSET_REFERENCE_UNOBSERVED' });
  assert.equal(getCount, 1);
});

function parseCookieNames(value) {
  return String(value || '').split(';').map((part) => part.trim().split('=', 1)[0]).filter(Boolean).join(',');
}

test('publishes only the safe captured contract summary', () => {
  const summary = originalImageDownloadContractSummary();
  assert.equal(summary.rpcId, 'c8o8Fe');
  assert.equal(summary.effect, 'read');
  assert.equal(summary.response.frameLengthOverheadUnits, 2);
  assert.equal(JSON.stringify(summary).includes('downloadUrl='), false);
});
