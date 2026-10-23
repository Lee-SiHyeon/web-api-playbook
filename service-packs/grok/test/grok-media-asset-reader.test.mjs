import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createGrokCffiAssetReader, validateGrokAssetRequestContext } from '../src/grok-media-asset-reader.mjs';

function assetRequestContext() {
  return {
    schemaVersion: 1,
    source: 'normal_ui_asset_request',
    ownerIdentityDigest: 'a'.repeat(64),
    assetOrigin: 'https://assets.grok.com',
    pathClass: '/users/*/generated/*',
    method: 'GET',
    observedCookieNames: ['sso'],
    cookies: [{ name: 'sso', value: 'test-owner-cookie', domain: '.grok.com', path: '/', secure: true, httpOnly: true }],
    headers: {
      referer: 'https://grok.com/',
      'user-agent': 'Mozilla/5.0 Chrome/154.0.0.0 Safari/537.36',
      'sec-ch-ua-platform': '"Linux"',
    },
  };
}

async function makeScratchDirectory() {
  const base = path.join(homedir(), '.nad-scratch', 'tmp');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(base, 'grok-media-asset-reader-'));
  await chmod(directory, 0o700);
  return directory;
}

test('CFFI asset reader uses the same-origin cached URL and returns only safe byte evidence', async t => {
  const directory = await makeScratchDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const response = {
    assetHttpStatus: 200, bodyBytes: 2_048, magicVerified: true, mimeType: 'image/jpeg', sha256: 'b'.repeat(64),
    source: 'curl_cffi-0.16.3-chrome150', cookiesUsed: true, cookieNamesUsed: ['sso'],
    headersSubmittedNames: ['referer', 'sec-ch-ua-platform', 'user-agent'], artifactPath: null,
  };
  const scriptPath = path.join(directory, 'fake-reader.mjs');
  await writeFile(scriptPath, `process.stdout.write(${JSON.stringify(JSON.stringify(response))});\n`, { mode: 0o600 });
  const context = assetRequestContext();
  const reader = createGrokCffiAssetReader({ pythonExecutable: process.execPath, scriptPath });
  const result = await reader({
    assetUrl: 'https://assets.grok.com/users/owner/generated/image.jpg?cache=1',
    mimeType: 'image/jpeg', assetRequestContext: context, expectedOwnerIdentityDigest: context.ownerIdentityDigest,
  });
  assert.equal(result.verified, true);
  assert.equal(result.sha256, response.sha256);
  assert.equal(result.bodyBytes, 2_048);
  assert.deepEqual(result.cookieNamesUsed, ['sso']);
  assert.doesNotMatch(JSON.stringify(result), /test-owner-cookie|assets\.grok\.com|users\/owner/);
});

test('asset context rejects owner mismatch, unobserved cookies, and cross-origin scope', () => {
  const context = assetRequestContext();
  const url = 'https://assets.grok.com/users/owner/generated/image.jpg?cache=1';
  assert.deepEqual(validateGrokAssetRequestContext(url, context, context.ownerIdentityDigest).cookies.map(x => x.name), ['sso']);
  assert.throws(() => validateGrokAssetRequestContext(url, context, 'c'.repeat(64)), { code: 'MEDIA_ASSET_REQUEST_CONTEXT_INVALID' });
  assert.throws(() => validateGrokAssetRequestContext(url, { ...context, observedCookieNames: ['cf_clearance'] }, context.ownerIdentityDigest), { code: 'MEDIA_ASSET_REQUEST_CONTEXT_INVALID' });
  assert.throws(() => validateGrokAssetRequestContext(url, {
    ...context, cookies: [{ ...context.cookies[0], domain: 'attacker.example' }],
  }, context.ownerIdentityDigest), { code: 'MEDIA_ASSET_COOKIE_SCOPE_INVALID' });
  assert.throws(() => validateGrokAssetRequestContext('https://attacker.example/users/owner/generated/image.jpg?cache=1', context,
    context.ownerIdentityDigest), { code: 'MEDIA_ASSET_CONTEXT_URL_SCOPE' });
  const imagePostContext = { ...context, headers: { ...context.headers,
    referer: 'https://grok.com/imagine/post/private-image-asset-0001?scope=asset&conversation=private-conversation-0001' } };
  assert.equal(validateGrokAssetRequestContext(url, imagePostContext, context.ownerIdentityDigest).cookies[0].name, 'sso');
  assert.throws(() => validateGrokAssetRequestContext(url, { ...context, headers: { ...context.headers,
    referer: 'https://grok.com/imagine/post/private-image-asset-0001?token=unobserved' } }, context.ownerIdentityDigest),
  { code: 'MEDIA_ASSET_HEADERS_INVALID' });
});
