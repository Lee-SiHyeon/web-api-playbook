import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  buildGrokAssetUrl,
  createGrokMediaApi,
  buildGrokImagineImageFrames,
  buildGrokImagineVideoCreateBody,
  GROK_MEDIA_OPERATION_IDS,
  GROK_MEDIA_PRIVATE_ASSET_DATA,
  GROK_MEDIA_PRIVATE_RESPONSE_IDS,
  GROK_MEDIA_PRIVATE_REFERENCE_ASSET_IDS,
  validateCapturedGrokImagineImageFrames,
  verifyGrokAssetBytes,
} from '../src/grok-media-api.mjs';

test('asset URL builder keeps the observed owner-generated route and cache query', () => {
  assert.equal(buildGrokAssetUrl('users/owner/generated/video.mp4').href,
    'https://assets.grok.com/users/owner/generated/video.mp4?cache=1');
  assert.throws(() => buildGrokAssetUrl('users/owner/generated/video.mp4?download=1'), { code: 'MEDIA_ASSET_URL_INVALID' });
});

function clientWith(results) {
  const calls = [];
  return {
    calls,
    client: {
      async read(operationId, input, options) {
        calls.push({ operationId, input, options });
        const next = results.shift();
        if (!next) throw new Error('unexpected read');
        return next;
      },
    },
  };
}

test('media quota exposes availability and window without implying a remaining count', async () => {
  const { client, calls } = clientWith([{
    status: 200,
    data: {
      image: { available: true, windowSizeSeconds: 64_800 },
      imagePro: { available: true, windowSizeSeconds: 64_800 },
      imageEdit: { available: true, windowSizeSeconds: 64_800 },
      video: { available: false, windowSizeSeconds: 64_800 },
      video720p: { available: false, windowSizeSeconds: 64_800 },
    },
  }]);
  const api = createGrokMediaApi({ client });
  const result = await api.getImagineQuota();
  assert.equal(calls[0].operationId, GROK_MEDIA_OPERATION_IDS.quota);
  assert.equal(result.modes.image.available, true);
  assert.equal(result.modes.video.available, false);
  assert.equal(result.remainingCountExposed, false);
});

test('media references remove record IDs, user IDs, signed URLs and sample keys', async () => {
  const { client } = clientWith([{
    status: 200,
    data: {
      references: [{
        id: 'reference-secret-id', userId: 'owner-secret-id', name: 'studio-reference', kind: 'image',
        description: 'neutral reference https://assets.grok.com/private?sig=private-signed-value', isOwner: true, sampleKey: 'private-sample-key',
        assets: [{ assetId: 'asset-secret-id', mimeType: 'image/jpeg', url: 'https://assets.grok.com/private?signed=secret' }],
      }],
    },
  }]);
  const result = await createGrokMediaApi({ client }).listReferences();
  const serialized = JSON.stringify(result);
  assert.equal(result.count, 1);
  assert.match(serialized, /studio-reference/);
  assert.doesNotMatch(serialized, /reference-secret-id|owner-secret-id|asset-secret-id|assets\.grok\.com|signed=secret|private-sample-key|private-signed-value/);
});

test('media asset pagination consumes cursors in memory and omits IDs, URLs, summaries and cursor values', async () => {
  const marker = 'opaque-cursor-do-not-print';
  const { client, calls } = clientWith([
    { status: 200, data: { assets: [{
      assetId: 'asset-id-one', mimeType: 'image/jpeg', name: 'image.jpg', sizeBytes: 100,
      width: 10, height: 10, summary: 'private prompt', key: 'private-key', isModelGenerated: true,
    }], nextPageToken: marker } },
    { status: 200, data: { assets: [{
      assetId: 'asset-id-two', mimeType: 'video/mp4', name: 'generated_video.mp4', sizeBytes: 200,
      width: 10, height: 10, summary: 'private prompt 2', key: 'private-key-2', isModelGenerated: true,
    }] } },
  ]);
  const result = await createGrokMediaApi({ client }).listAssets({ maxPages: 2 });
  assert.equal(result.complete, true);
  assert.equal(result.assets.length, 2);
  assert.deepEqual(calls.map(call => call.input), [{}, { pageToken: marker }]);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /asset-id-one|asset-id-two|opaque-cursor|private prompt|private-key/);
});

test('asset readback compares IDs in memory and returns only sanitized new media metadata', async () => {
  const { client } = clientWith([
    { status: 200, data: { assets: [{ assetId: 'before-id', mimeType: 'image/jpeg', name: 'before.jpg', isModelGenerated: true }] } },
    { status: 200, data: { assets: [
      { assetId: 'before-id', mimeType: 'image/jpeg', name: 'before.jpg', isModelGenerated: true },
      { assetId: 'new-id', mimeType: 'video/mp4', name: 'generated_video.mp4', sizeBytes: 2_000, isModelGenerated: true, isPublic: false },
    ] } },
  ]);
  const api = createGrokMediaApi({ client });
  const baseline = await api.captureAssetSnapshot({ maxPages: 1 });
  const result = await api.readBackNewAssets(baseline, { maxPages: 1 });
  assert.equal(result.verified, true);
  assert.equal(result.assets.length, 1);
  assert.equal(result.assets[0].mimeType, 'video/mp4');
  assert.equal(result.assets[0].isPublic, false);
  assert.doesNotMatch(JSON.stringify(result), /new-id|before-id/);
});

test('asset correlation IDs remain in memory and selection rejects IDs outside the baseline delta', async () => {
  const { client } = clientWith([
    { status: 200, data: { assets: [{ assetId: 'baseline-id', mimeType: 'image/jpeg' }] } },
    { status: 200, data: { assets: [
      { assetId: 'baseline-id', mimeType: 'image/jpeg' },
      { assetId: 'target-id', responseId: 'target-response', sourceConversationId: 'target-conversation-id',
        key: 'users/owner/generated/target.jpg', mimeType: 'image/jpeg', isPublic: false, isModelGenerated: true },
      { assetId: 'unrelated-id', responseId: 'old-response', sourceConversationId: 'old-conversation-id',
        key: 'users/owner/generated/unrelated.jpg', mimeType: 'image/jpeg', isPublic: false, isModelGenerated: true },
    ] } },
    { status: 200, data: { assets: [
      { assetId: 'baseline-id', mimeType: 'image/jpeg' },
      { assetId: 'target-id', responseId: 'target-response', sourceConversationId: 'target-conversation-id',
        key: 'users/owner/generated/target.jpg', mimeType: 'image/jpeg', isPublic: false, isModelGenerated: true },
      { assetId: 'unrelated-id', responseId: 'old-response', sourceConversationId: 'old-conversation-id',
        key: 'users/owner/generated/unrelated.jpg', mimeType: 'image/jpeg', isPublic: false, isModelGenerated: true },
    ] } },
  ]);
  const api = createGrokMediaApi({ client });
  const snapshot = await api.captureAssetSnapshot({ maxPages: 1 });
  const result = await api.readBackNewAssets(snapshot, { maxPages: 1, assetIds: ['target-id'] });
  assert.equal(result.verified, true);
  assert.equal(result.assets.length, 1);
  assert.equal(result.assets[0][GROK_MEDIA_PRIVATE_ASSET_DATA].assetId, 'target-id');
  assert.equal(result.assets[0][GROK_MEDIA_PRIVATE_ASSET_DATA].responseId, 'target-response');
  assert.doesNotMatch(JSON.stringify(result), /target-id|target-response|target-conversation|users\/owner|unrelated-id/);
  const missing = await api.readBackNewAssets(snapshot, { maxPages: 1, assetIds: ['not-new'] });
  assert.equal(missing.verified, false);
  assert.equal(missing.reason, 'MEDIA_CORRELATED_ASSET_NOT_OBSERVED');
});

test('exact asset detail uses the captured first-read contract and verifies selected bytes without a full list', async () => {
  const assetId = 'private-output-video-metadata-0001';
  const conversationId = 'private-output-video-conversation-0001';
  const responseId = 'private-output-video-response-0001';
  const { client, calls } = clientWith([{ status: 200, data: {
    assetId, responseId, sourceConversationId: conversationId, key: 'users/owner/generated/video.mp4',
    mimeType: 'video/mp4', isPublic: false, isModelGenerated: true, createTime: Date.now(),
  } }]);
  const api = createGrokMediaApi({ client });
  const asset = await api.readAssetMetadata({ assetId });
  assert.equal(calls[0].operationId, GROK_MEDIA_OPERATION_IDS.assetMetadata);
  assert.deepEqual(calls[0].input, { assetId });
  assert.equal(calls[0].options.sourceDiscoveryPermit, 'first-read:attachment.asset.read');
  assert.equal(asset.isPublic, false);
  assert.equal(asset[GROK_MEDIA_PRIVATE_ASSET_DATA].assetId, assetId);
  const readback = await api.verifyExactAssets({ assets: [asset], verifyAsset: async selected => ({
    mimeType: selected.mimeType, bodyBytes: 4096, magicVerified: true, sha256: 'c'.repeat(64), durationSeconds: 6,
  }) });
  assert.equal(readback.verified, true);
  assert.equal(readback.assets.length, 1);
  assert.deepEqual(readback.mediaVerifications, [{ mimeType: 'video/mp4', bodyBytes: 4096,
    magicVerified: true, durationSeconds: 6, sha256: 'c'.repeat(64) }]);
  assert.doesNotMatch(JSON.stringify({ asset, readback }), /private-output-video|users\/owner/);
});

test('asset downloader resolves the opaque key from private in-memory metadata on sanitized list assets', async () => {
  const assetId = 'private-listed-image-asset-0001';
  const key = 'users/owner/generated/listed-image.jpg';
  const { client } = clientWith([{ status: 200, data: { assets: [{ assetId, key, mimeType: 'image/jpeg',
    isPublic: false, isModelGenerated: true, responseId: 'private-listed-image-response-0001',
    sourceConversationId: 'private-listed-image-conversation-0001' }] } }]);
  let capturedUrl;
  const api = createGrokMediaApi({ client, assetReader: async input => {
    capturedUrl = input.assetUrl;
    return { status: 200, mimeType: 'image/jpeg', bodyBytes: 3, magicVerified: true,
      sha256: 'd'.repeat(64), source: 'curl_cffi-0.16.3-chrome150', cookiesUsed: true,
      cookieNamesUsed: ['sso'], headersSubmittedNames: ['referer', 'user-agent', 'sec-ch-ua-platform'], artifactPath: null };
  } });
  const listed = await api.listAssets({ maxPages: 1 });
  const asset = listed.assets[0];
  assert.equal(asset.key, undefined);
  const ownerIdentityDigest = 'a'.repeat(64);
  const result = await api.verifyAssetBytes(asset, {
    expectedOwnerIdentityDigest: ownerIdentityDigest,
    assetRequestContext: {
      schemaVersion: 1, source: 'normal_ui_asset_request', ownerIdentityDigest,
      assetOrigin: 'https://assets.grok.com', pathClass: '/users/*/generated/*', method: 'GET',
      observedCookieNames: ['sso'],
      cookies: [{ name: 'sso', value: 'observed-owner-sso', domain: '.grok.com', path: '/', secure: true, httpOnly: true }],
      headers: { referer: 'https://grok.com/imagine', 'user-agent': 'Mozilla/5.0 Chrome/154.0.0.0 Safari/537.36',
        'sec-ch-ua-platform': '"Linux"' },
    },
  });
  assert.equal(capturedUrl, 'https://assets.grok.com/users/owner/generated/listed-image.jpg?cache=1');
  assert.equal(result.magicVerified, true);
  assert.equal(result.sha256, 'd'.repeat(64));
  assert.equal(result.mimeType, 'image/jpeg');
  assert.equal(JSON.stringify(result).includes(key), false);
});

test('conversation readback hashes the exact prompt and keeps response IDs private', async () => {
  const prompt = 'A matte teal sphere beside an ivory cube on a pale gray studio surface.';
  const conversationId = 'private-conversation-id-0001';
  const responseIds = ['private-user-response-0001', 'private-assistant-response-0001'];
  const { client, calls } = clientWith([
    { status: 200, data: { conversation: { conversationId, prompt } } },
    { status: 200, data: { responseNodes: responseIds.map((responseId, index) => ({
      responseId, sender: index === 0 ? 'user' : 'assistant',
    })) } },
    { status: 200, data: { responses: [
      { responseId: responseIds[0], sender: 'user', message: prompt },
      { responseId: responseIds[1], sender: 'assistant', message: 'Generated output' },
    ] } },
  ]);
  const evidence = await createGrokMediaApi({ client }).readConversationEvidence({ conversationId, expectedPrompt: prompt });
  assert.deepEqual(calls.map(call => call.operationId), [
    GROK_MEDIA_OPERATION_IDS.conversation,
    GROK_MEDIA_OPERATION_IDS.responseNodes,
    GROK_MEDIA_OPERATION_IDS.loadResponses,
  ]);
  assert.deepEqual(calls[2].input, { conversationId, responseIds });
  assert.equal(evidence.conversationMatch, true);
  assert.equal(evidence.promptExactMatch, true);
  assert.equal(evidence.promptSha256, createHash('sha256').update(prompt, 'utf8').digest('hex'));
  assert.deepEqual(evidence[GROK_MEDIA_PRIVATE_RESPONSE_IDS].matchingPrompt, responseIds);
  assert.doesNotMatch(JSON.stringify(evidence), /private-conversation-id|private-user-response|Generated output|teal sphere/);
});

test('image reference proof requires a private generated asset linked to one exact owner prompt and history response', async () => {
  const prompt = 'A matte teal sphere beside a white cube in a clean studio.';
  const promptSha256 = createHash('sha256').update(prompt, 'utf8').digest('hex');
  const conversationId = 'private-image-conversation-0001';
  const responseId = 'private-image-response-0001';
  const assetId = 'private-image-asset-0001';
  const { client } = clientWith([
    { status: 200, data: { assets: [{ assetId, responseId, sourceConversationId: conversationId,
      key: 'users/owner/generated/private.jpg', mimeType: 'image/jpeg', isPublic: false, isModelGenerated: true }] } },
    { status: 200, data: { conversation: { conversationId, prompt } } },
    { status: 200, data: { responseNodes: [
      { responseId: 'private-user-response-0001', sender: 'user' }, { responseId, sender: 'assistant' },
    ] } },
    { status: 200, data: { responses: [
      { responseId: 'private-user-response-0001', sender: 'user', message: prompt },
      { responseId, sender: 'assistant', message: 'Generated output' },
    ] } },
  ]);
  const api = createGrokMediaApi({ client });
  const snapshot = await api.captureAssetSnapshot({ maxPages: 1 });
  const proof = await api.verifyOwnedGeneratedImageReference({ assetId, expectedPromptSha256: promptSha256, snapshot });
  assert.equal(proof.verified, true);
  assert.equal(proof.promptSha256, promptSha256);
  assert.equal(proof.sourceResponseInHistory, true);
  assert.equal(proof.asset[GROK_MEDIA_PRIVATE_ASSET_DATA].assetId, assetId);
  assert.doesNotMatch(JSON.stringify(proof), /private-image-asset|private-image-response|private-image-conversation|users\/owner|Generated output|sphere beside/);
});

test('conversation readback keeps image-reference asset IDs in memory and reports only linkage', async () => {
  const prompt = 'A sphere moves beside a cube.';
  const sourceAssetId = 'private-source-image-0001';
  const conversationId = 'private-image-video-conversation-0001';
  const { client } = clientWith([
    { status: 200, data: { conversation: { conversationId, prompt } } },
    { status: 200, data: { responseNodes: [
      { responseId: 'private-user-response-0002', sender: 'user' }, { responseId: 'private-assistant-response-0002', sender: 'assistant' },
    ] } },
    { status: 200, data: { responses: [
      { responseId: 'private-user-response-0002', sender: 'user', message: prompt },
      { responseId: 'private-assistant-response-0002', sender: 'assistant', message: 'Generated output', mediaGenInput: {
        imageToVideo: { inputAssets: [sourceAssetId] },
      } },
    ] } },
  ]);
  const evidence = await createGrokMediaApi({ client }).readConversationEvidence({
    conversationId, expectedPrompt: prompt, expectedReferenceAssetId: sourceAssetId,
  });
  assert.equal(evidence.referenceAssetMatched, true);
  assert.equal(evidence.referenceAssetCount, 1);
  assert.deepEqual(evidence[GROK_MEDIA_PRIVATE_REFERENCE_ASSET_IDS], [sourceAssetId]);
  assert.doesNotMatch(JSON.stringify(evidence), /private-source-image|private-assistant-response|sphere moves/);
});

test('conversation readback binds the native custom-mode suffix to the exact prompt and response input', async () => {
  const prompt = 'The teal sphere turns beside the still white cube.';
  const sourceAssetId = 'private-source-image-custom-mode-0001';
  const conversationId = 'private-image-video-custom-mode-conversation-0001';
  const userResponseId = 'private-custom-mode-user-response-0001';
  const assistantResponseId = 'private-custom-mode-assistant-response-0001';
  const promptSha256 = createHash('sha256').update(prompt, 'utf8').digest('hex');
  const { client } = clientWith([
    { status: 200, data: { conversation: { conversationId, prompt } } },
    { status: 200, data: { responseNodes: [
      { responseId: userResponseId, sender: 'user' }, { responseId: assistantResponseId, sender: 'assistant' },
    ] } },
    { status: 200, data: { responses: [
      { responseId: userResponseId, sender: 'user', message: `${prompt} --mode=custom` },
      { responseId: assistantResponseId, sender: 'assistant', message: 'Generated output', mediaGenInput: {
        imageToVideo: { inputAssets: [sourceAssetId] },
      } },
    ] } },
  ]);
  const evidence = await createGrokMediaApi({ client }).readConversationEvidence({
    conversationId, expectedPrompt: prompt, expectedReferenceAssetId: sourceAssetId,
  });
  assert.equal(evidence.conversationMatch, true);
  assert.equal(evidence.nestedConversationPromptMatchesExpected, true);
  assert.equal(evidence.promptExactMatch, true);
  assert.equal(evidence.promptSha256, promptSha256);
  assert.equal(evidence.uniqueUserPromptCount, 1);
  assert.equal(evidence.matchedUserMessageForm, 'native_custom_mode_suffix');
  assert.equal(evidence.referenceAssetMatched, true);
  assert.deepEqual(evidence[GROK_MEDIA_PRIVATE_RESPONSE_IDS].matchingPrompt, [userResponseId, assistantResponseId]);
  assert.doesNotMatch(JSON.stringify(evidence), /private-source-image-custom-mode|private-custom-mode|turns beside/);
});

test('owner image verification binds its task prompt hash when history stores the native custom-mode suffix', async () => {
  const prompt = 'A neutral teal sphere beside a white cube.';
  const promptSha256 = createHash('sha256').update(prompt, 'utf8').digest('hex');
  const assetId = 'private-image-asset-custom-mode-0001';
  const conversationId = 'private-image-custom-mode-conversation-0001';
  const responseId = 'private-image-custom-mode-response-0001';
  const { client } = clientWith([
    { status: 200, data: { assets: [{ assetId, responseId, sourceConversationId: conversationId,
      key: 'users/owner/generated/private.jpg', mimeType: 'image/jpeg', isPublic: false, isModelGenerated: true }] } },
    { status: 200, data: { conversation: { conversationId, prompt } } },
    { status: 200, data: { responseNodes: [{ responseId, sender: 'user' }] } },
    { status: 200, data: { responses: [{ responseId, sender: 'user', message: `${prompt} --mode=custom` }] } },
  ]);
  const api = createGrokMediaApi({ client });
  const snapshot = await api.captureAssetSnapshot({ maxPages: 1 });
  const proof = await api.verifyOwnedGeneratedImageReference({ assetId, expectedPromptSha256: promptSha256, snapshot });
  assert.equal(proof.verified, true);
  assert.equal(proof.promptSha256, promptSha256);
  assert.equal(proof.sourceResponseInHistory, true);
});

test('asset magic verifier sees IDs only in memory and persists only MIME, byte count and verification status', async () => {
  const { client } = clientWith([
    { status: 200, data: { assets: [{ assetId: 'baseline-id', mimeType: 'image/jpeg' }] } },
    { status: 200, data: { assets: [
      { assetId: 'baseline-id', mimeType: 'image/jpeg' },
      { assetId: 'new-private-id', mimeType: 'video/mp4', key: 'private-key', name: 'test.mp4' },
    ] } },
  ]);
  const api = createGrokMediaApi({ client });
  const snapshot = await api.captureAssetSnapshot({ maxPages: 1 });
  let verifiedPrivateId;
  const result = await api.readBackNewAssets(snapshot, {
    maxPages: 1,
    verifyAsset: async asset => {
      verifiedPrivateId = asset.assetId;
      return { status: 200, mimeType: asset.mimeType, bodyBytes: 1234, magicVerified: true };
    },
  });
  assert.equal(verifiedPrivateId, 'new-private-id');
  assert.deepEqual(result.mediaVerifications, [{ httpStatus: 200, mimeType: 'video/mp4', bodyBytes: 1234, magicVerified: true }]);
  assert.doesNotMatch(JSON.stringify(result), /new-private-id|private-key/);
});

test('image frame builder uses the observed Quality 2.0 batch and makes a fresh request ID', () => {
  let id = 0;
  let timestamp = 100;
  const args = {
    prompt: 'neutral geometric test',
    now: () => timestamp++,
    requestId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
  };
  const first = buildGrokImagineImageFrames(args);
  const second = buildGrokImagineImageFrames(args);
  assert.equal(first.length, 1);
  assert.equal(first[0].item.content[0].type, 'input_text');
  assert.equal(first[0].type, 'conversation.item.create');
  assert.equal(first[0].item.content[0].properties.num_generations, 4);
  assert.equal(first[0].item.content[0].properties.enable_pro, true);
  assert.notEqual(first[0].item.content[0].requestId, second[0].item.content[0].requestId);
  assert.equal(first[0].item.content[0].text, 'neutral geometric test');
});

test('captured image frames must be fresh native Quality 2.0 frames for the approved prompt', () => {
  const now = 50_000;
  const frames = buildGrokImagineImageFrames({
    prompt: 'neutral geometric test', now: () => now, requestId: () => '00000000-0000-4000-8000-000000000301',
  });
  assert.equal(validateCapturedGrokImagineImageFrames(frames, { prompt: 'neutral geometric test', now: () => now }), frames);
  const resetVariant = [
    { type: 'conversation.item.create', timestamp: now, item: { type: 'message', content: [{ type: 'reset' }] } },
    { ...frames[0], timestamp: now + 1 },
  ];
  assert.equal(validateCapturedGrokImagineImageFrames(resetVariant, { prompt: 'neutral geometric test', now: () => now + 1 }), resetVariant);
  assert.throws(
    () => validateCapturedGrokImagineImageFrames(frames, { prompt: 'different user request', now: () => now }),
    { code: 'MEDIA_CAPTURE_FRAME_INVALID' },
  );
  assert.throws(
    () => validateCapturedGrokImagineImageFrames(frames, { prompt: 'neutral geometric test', now: () => now + 180_001 }),
    { code: 'MEDIA_CAPTURE_FRAME_INVALID' },
  );
});

test('video builder uses only the observed six-second, 480p, no-audio profile', () => {
  const body = buildGrokImagineVideoCreateBody({ prompt: 'neutral geometric test' });
  assert.equal(body.modelName, 'imagine-video-gen');
  assert.equal(body.kind, 'CONVERSATION_KIND_IMAGINE');
  assert.deepEqual(body.mediaGenInput.textToVideo, {
    aspectRatio: '2:3',
    duration: 6,
    prompt: 'neutral geometric test',
    resolutionName: '480p',
    skipAudio: true,
  });
  assert.equal(body.message, `${body.mediaGenInput.textToVideo.prompt} --mode=custom`);
});

test('asset byte check streams and validates MIME plus file magic without returning URLs or IDs', async () => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02, 0x03]);
  let requestedUrl;
  const result = await verifyGrokAssetBytes({ assetId: 'private-asset-id', key: 'users/test/generated/asset/image.jpg', mimeType: 'image/jpeg' }, {
    fetchImpl: async url => {
      requestedUrl = url.toString();
      return new Response(bytes, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    },
  });
  assert.equal(new URL(requestedUrl).origin, 'https://assets.grok.com');
  assert.equal(result.mimeType, 'image/jpeg');
  assert.equal(result.status, 200);
  assert.equal(result.magicVerified, true);
  assert.equal(result.bodyBytes, bytes.length);
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.doesNotMatch(JSON.stringify(result), /private-asset-id|assets\.grok\.com|users\/test/);
  const parsed = new URL(requestedUrl);
  assert.equal(parsed.origin, 'https://assets.grok.com');
  assert.equal(parsed.pathname, '/users/test/generated/asset/image.jpg');
  assert.equal(parsed.search, '?cache=1');
  await assert.rejects(verifyGrokAssetBytes({ key: 'https://attacker.example/users/u/generated/a/image.jpg', mimeType: 'image/jpeg' }, {
    fetchImpl: async () => { throw new Error('must not request an unapproved origin'); },
  }), { code: 'MEDIA_ASSET_ORIGIN_SCOPE' });
  await assert.rejects(verifyGrokAssetBytes({ key: '/users/u/other/a/image.jpg', mimeType: 'image/jpeg' }, {
    fetchImpl: async () => { throw new Error('must not request an unapproved path'); },
  }), { code: 'MEDIA_ASSET_PATH_SCOPE' });
});

test('asset browser bridge accepts only a local verifier and returns safe magic evidence', async () => {
  const assetUrl = 'users/owner/generated/image.jpg';
  let call;
  const result = await verifyGrokAssetBytes({ key: assetUrl, mimeType: 'image/jpeg' }, {
    assetVerificationBridgeUrl: 'http://127.0.0.1:40521/verify',
    fetchImpl: async (url, options) => {
      call = { url: url.toString(), options };
      return new Response(JSON.stringify({
        assetHttpStatus: 200,
        bodyBytes: 2048,
        magicVerified: true,
        mimeType: 'image/jpeg',
        source: 'curl_cffi_chrome150',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  assert.equal(call.url, 'http://127.0.0.1:40521/verify');
  assert.equal(call.options.method, 'POST');
  assert.deepEqual(JSON.parse(call.options.body), {
    assetUrl: 'https://assets.grok.com/users/owner/generated/image.jpg?cache=1',
    mimeType: 'image/jpeg',
  });
  assert.equal(result.magicVerified, true);
  assert.equal(result.bodyBytes, 2048);
  await assert.rejects(verifyGrokAssetBytes({ key: assetUrl, mimeType: 'image/jpeg' }, {
    assetVerificationBridgeUrl: 'http://attacker.example/verify',
    fetchImpl: async () => { throw new Error('must not contact a remote bridge'); },
  }), { code: 'MEDIA_ASSET_BRIDGE_URL_INVALID' });
});

test('CFFI asset reader uses only owner-bound observed sso and returns a disk-independent hash', async () => {
  const ownerDigest = 'a'.repeat(64);
  const context = {
    schemaVersion: 1,
    source: 'normal_ui_asset_request',
    ownerIdentityDigest: ownerDigest,
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
  let call;
  const digest = 'b'.repeat(64);
  const mediaApi = createGrokMediaApi({ client: { async read() { throw new Error('not used'); } }, assetReader: async input => {
    call = input;
    return {
      status: 200, mimeType: 'image/jpeg', bodyBytes: 2048, magicVerified: true, sha256: digest,
      source: 'curl_cffi-0.16.3-chrome150', cookiesUsed: true, cookieNamesUsed: ['sso'],
      headersSubmittedNames: ['referer', 'sec-ch-ua-platform', 'user-agent'], artifactPath: null, verified: true,
    };
  } });
  const result = await mediaApi.verifyAssetBytes({ key: 'users/owner/generated/image.jpg', mimeType: 'image/jpeg' }, {
    assetRequestContext: context,
    expectedOwnerIdentityDigest: ownerDigest,
  });
  assert.equal(call.assetUrl, 'https://assets.grok.com/users/owner/generated/image.jpg?cache=1');
  assert.deepEqual(call.assetRequestContext.observedCookieNames, ['sso']);
  assert.equal(call.assetRequestContext.cookies[0].domain, '.grok.com');
  assert.equal(call.expectedOwnerIdentityDigest, ownerDigest);
  assert.equal(result.sha256, digest);
  assert.equal(result.status, 200);
  assert.equal(result.magicVerified, true);
  assert.doesNotMatch(JSON.stringify(result), /test-owner-cookie|private-asset-id/);
  await assert.rejects(mediaApi.verifyAssetBytes({ key: 'users/owner/generated/image.jpg', mimeType: 'image/jpeg' }, {
    assetRequestContext: { ...context, ownerIdentityDigest: 'c'.repeat(64) },
    expectedOwnerIdentityDigest: ownerDigest,
  }), { code: 'MEDIA_ASSET_REQUEST_CONTEXT_INVALID' });
  await assert.rejects(mediaApi.verifyAssetBytes({ key: 'users/owner/generated/image.jpg', mimeType: 'image/jpeg' }, {
    assetRequestContext: { ...context, cookies: [{ ...context.cookies[0], domain: 'attacker.example' }] },
    expectedOwnerIdentityDigest: ownerDigest,
  }), { code: 'MEDIA_ASSET_COOKIE_SCOPE_INVALID' });
});

test('asset download-to-file re-reads disk bytes and checks the saved hash and magic', async t => {
  const base = path.join(homedir(), 'artifacts');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const outputRoot = await mkdtemp(path.join(base, 'grok-media-download-'));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02, 0x03]);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const ownerIdentityDigest = 'a'.repeat(64);
  const context = {
    schemaVersion: 1, source: 'normal_ui_asset_request', ownerIdentityDigest,
    assetOrigin: 'https://assets.grok.com', pathClass: '/users/*/generated/*', method: 'GET',
    observedCookieNames: ['sso'],
    cookies: [{ name: 'sso', value: 'test-owner-cookie', domain: '.grok.com', path: '/', secure: true, httpOnly: true }],
    headers: { referer: 'https://grok.com/', 'user-agent': 'Mozilla/5.0 Chrome/154.0.0.0 Safari/537.36', 'sec-ch-ua-platform': '"Linux"' },
  };
  const api = createGrokMediaApi({ client: { async read() { throw new Error('not used'); } }, assetReader: async options => {
    const artifactPath = path.join(options.outputRoot, options.outputName);
    await writeFile(artifactPath, bytes, { mode: 0o600, flag: 'wx' });
    return { status: 200, mimeType: 'image/jpeg', bodyBytes: bytes.length, magicVerified: true, sha256,
      source: 'curl_cffi-0.16.3-chrome150', cookiesUsed: true, cookieNamesUsed: ['sso'], artifactPath };
  } });
  const result = await api.downloadAssetToFile({ key: 'users/owner/generated/image.jpg', mimeType: 'image/jpeg' }, {
    assetRequestContext: context, expectedOwnerIdentityDigest: ownerIdentityDigest,
    outputRoot, outputName: 'image-01.jpg',
  });
  assert.equal(result.artifactPath, path.join(outputRoot, 'image-01.jpg'));
  assert.equal(result.status, 200);
  assert.equal(result.sha256, sha256);
  assert.equal(result.diskSha256, sha256);
  assert.equal(result.diskBodyBytes, bytes.length);
  assert.equal(result.magicVerified, true);
});
