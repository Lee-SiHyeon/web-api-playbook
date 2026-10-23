import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { downloadGeminiMediaAssetOnce } from '../src/media-download.mjs';

const sourceUrl = 'https://contribution.usercontent.google.com/download?c=opaque&filename=video.mp4&opi=1';
const sourceOrigin = 'https://contribution.usercontent.google.com';
const sourceRef = Object.freeze({
  origin: sourceOrigin,
  pathFamily: '/download',
  queryKeyNames: ['c', 'filename', 'opi'],
});
const cookieJar = [{ name: 'SID', value: 'sentinel-cookie-value', domain: '.google.com', path: '/', secure: true, expires: 0 }];
const nativeGet = Object.freeze({
  exactUrlMatched: true,
  method: 'GET',
  origin: sourceOrigin,
  pathFamily: '/download',
  queryKeyNames: ['c', 'filename', 'opi'],
  httpStatus: 200,
  mime: 'video/mp4',
  capability: 'video',
  headerNames: ['accept', 'cookie', 'referer', 'user-agent'],
  cookieHeaderPresent: true,
  cookieNames: ['SID'],
});
const tempDirs = [];

async function tempDir() {
  const base = process.env.TMPDIR || path.join(os.homedir(), '.nad-scratch', 'tmp');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(base, 'gemini-media-download-'));
  tempDirs.push(directory);
  return directory;
}

function fakeMp4() {
  const body = Buffer.alloc(32);
  body.write('....ftypisom', 0, 'ascii');
  return body;
}

function edge(from, to, httpStatus = 302) {
  return Object.freeze({ httpStatus, from, to });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test('forwards only cookies whose observed names and domain/path scope match the exact native task GET', async () => {
  const output = await tempDir();
  const body = fakeMp4();
  let capturedCookie = null;
  const result = await downloadGeminiMediaAssetOnce({
    url: sourceUrl,
    capability: 'video',
    observedNativeRequest: nativeGet,
    cookieCookies: cookieJar,
    allowedOrigins: [sourceOrigin],
    artifactRoot: output,
    artifactName: 'task-video.direct-http.mp4',
    fetchImpl: async (_url, options) => {
      capturedCookie = options.headers.get('cookie');
      return new Response(body, { status: 200, headers: { 'content-type': 'video/mp4' } });
    },
  });

  assert.equal(capturedCookie, 'SID=sentinel-cookie-value');
  assert.equal(result.httpStatus, 200);
  assert.equal(result.mimeMagicMatched, true);
  assert.equal(result.artifact.independentFileReadback, true);
  assert.equal(result.artifact.bytes, body.length);
  assert.equal(result.credentialForwarding.cookiesForwardedToCrossOriginRedirects, false);
  assert.deepEqual(result.credentialForwarding.cookieNames, ['SID']);
  const saved = await readFile(result.artifact.path);
  assert.deepEqual(saved, body);
});

test('does not forward cookies across a task-observed redirect to another origin', async () => {
  const output = await tempDir();
  const targetUrl = 'https://lh3.googleusercontent.com/media.mp4?sig=opaque';
  const targetRef = Object.freeze({
    origin: 'https://lh3.googleusercontent.com',
    pathFamily: '/media.mp4',
    queryKeyNames: ['sig'],
  });
  const calls = [];
  const result = await downloadGeminiMediaAssetOnce({
    url: sourceUrl,
    capability: 'video',
    observedNativeRequest: nativeGet,
    cookieCookies: cookieJar,
    allowedOrigins: [sourceOrigin, targetRef.origin],
    observedRedirectEdges: [edge(sourceRef, targetRef)],
    artifactRoot: output,
    artifactName: 'redirected-video.direct-http.mp4',
    fetchImpl: async (url, options) => {
      calls.push({ origin: new URL(url).origin, cookie: options.headers.get('cookie') });
      if (calls.length === 1) return new Response(null, { status: 302, headers: { location: targetUrl } });
      return new Response(fakeMp4(), { status: 200, headers: { 'content-type': 'video/mp4' } });
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].cookie, 'SID=sentinel-cookie-value');
  assert.equal(calls[1].origin, targetRef.origin);
  assert.equal(calls[1].cookie, null);
  assert.equal(result.redirects.length, 1);
  assert.equal(result.credentialForwarding.cookiesByRequestHop[1].cookieNames.length, 0);
  assert.equal(result.artifact.independentFileReadback, true);
});

test('blocks a redirect unless its exact origin, path family, and query keys were observed for this task', async () => {
  const output = await tempDir();
  let calls = 0;
  await assert.rejects(downloadGeminiMediaAssetOnce({
    url: sourceUrl,
    capability: 'video',
    observedNativeRequest: nativeGet,
    cookieCookies: cookieJar,
    allowedOrigins: [sourceOrigin, 'https://lh3.googleusercontent.com'],
    observedRedirectEdges: [],
    artifactRoot: output,
    artifactName: 'blocked-video.direct-http.mp4',
    fetchImpl: async () => {
      calls += 1;
      return new Response(null, { status: 302, headers: { location: 'https://lh3.googleusercontent.com/media.mp4?sig=opaque' } });
    },
  }), (error) => error?.code === 'MEDIA_REDIRECT_NOT_TASK_OBSERVED');
  assert.equal(calls, 1);
});

test('rejects cookie scopes that do not cover the exact observed host', async () => {
  let calls = 0;
  await assert.rejects(downloadGeminiMediaAssetOnce({
    url: sourceUrl,
    capability: 'video',
    observedNativeRequest: nativeGet,
    cookieCookies: [{ name: 'SID', value: 'sentinel', domain: '.example.com', path: '/', secure: true }],
    allowedOrigins: [sourceOrigin],
    artifactRoot: await tempDir(),
    artifactName: 'invalid-scope.direct-http.mp4',
    fetchImpl: async () => { calls += 1; return new Response(fakeMp4()); },
  }), (error) => error?.code === 'MEDIA_COOKIE_SCOPE_MISMATCH');
  assert.equal(calls, 0);
});

test('allows a domain and path-matched non-Secure cookie on the observed HTTPS host', async () => {
  const output = await tempDir();
  let capturedCookie = null;
  const result = await downloadGeminiMediaAssetOnce({
    url: sourceUrl,
    capability: 'video',
    observedNativeRequest: nativeGet,
    cookieCookies: [{ name: 'SID', value: 'sentinel-nonsecure', domain: '.google.com', path: '/download', secure: false, expires: 0 }],
    allowedOrigins: [sourceOrigin],
    artifactRoot: output,
    artifactName: 'task-video-nonsecure-cookie.direct-http.mp4',
    fetchImpl: async (_url, options) => {
      capturedCookie = options.headers.get('cookie');
      return new Response(fakeMp4(), { status: 200, headers: { 'content-type': 'video/mp4' } });
    },
  });
  assert.equal(capturedCookie, 'SID=sentinel-nonsecure');
  assert.equal(result.httpStatus, 200);
  assert.equal(result.mimeMagicMatched, true);
});

test('requires declared MIME and media magic to agree', async () => {
  await assert.rejects(downloadGeminiMediaAssetOnce({
    url: sourceUrl,
    capability: 'video',
    observedNativeRequest: nativeGet,
    cookieCookies: cookieJar,
    allowedOrigins: [sourceOrigin],
    artifactRoot: await tempDir(),
    artifactName: 'wrong-mime.direct-http.mp4',
    fetchImpl: async () => new Response(fakeMp4(), { status: 200, headers: { 'content-type': 'image/png' } }),
  }), (error) => error?.code === 'MEDIA_NATIVE_RESPONSE_MISMATCH');
});

test('recognizes an SVG image response without assuming PNG', async () => {
  const output = await tempDir();
  const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>');
  const imageNative = { ...nativeGet, mime: 'image/svg+xml', capability: 'image' };
  const imageUrl = 'https://contribution.usercontent.google.com/download?c=opaque&filename=image.svg&opi=1';
  const result = await downloadGeminiMediaAssetOnce({
    url: imageUrl,
    capability: 'image',
    observedNativeRequest: imageNative,
    cookieCookies: cookieJar,
    allowedOrigins: [sourceOrigin],
    artifactRoot: output,
    artifactName: 'task-image.direct-http.svg',
    fetchImpl: async () => new Response(svg, { status: 200, headers: { 'content-type': 'image/svg+xml' } }),
  });
  assert.equal(result.mime, 'image/svg+xml');
  assert.equal(result.mimeMagicMatched, true);
  assert.equal(result.artifact.independentFileReadback, true);
});
