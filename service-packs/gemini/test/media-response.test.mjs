import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeGeminiMediaResponse, inspectGeminiMediaResponse } from '../src/media-response.mjs';

function utf16Frame(value, { extraUnits = 2 } = {}) {
  const payload = JSON.stringify(value);
  const units = Buffer.byteLength(payload, 'utf16le') / 2;
  return Buffer.from(`)]}'\n${units + extraUnits}\n${payload}\n`, 'utf8');
}

test('validates Gemini UTF-16 frame lengths with the observed two-unit overhead', () => {
  const response = inspectGeminiMediaResponse(utf16Frame([{ text: '중립 도형 🟦' }]), {
    capability: 'image',
    contentType: 'application/json; charset=UTF-8',
    assetOrigins: ['https://gemini.gstatic.com'],
  });
  assert.equal(response.framing, 'utf16_length_frames');
  assert.equal(response.frameCount, 1);
  assert.equal(response.responseBytes > 0, true);
  assert.equal(JSON.stringify(response).includes('중립 도형'), false);
});

test('reports a malformed frame length without interpreting a partial response', () => {
  const body = utf16Frame([{ status: 'OK' }], { extraUnits: 3 });
  const response = inspectGeminiMediaResponse(body, {
    capability: 'video',
    contentType: 'application/json',
    assetOrigins: ['https://gemini.gstatic.com'],
  });
  assert.equal(response.framing, 'unclassified');
  assert.equal(response.parseErrorCode, 'BATCH_FRAME_LENGTH_MISMATCH');
  assert.equal(response.frameCount, 0);
});

test('accepts asset URLs only from captured origins and redacts signed query values', () => {
  const value = [{ asset: { url: 'https://gemini.gstatic.com/path/generated?id=opaque&signature=do-not-persist' } }];
  const response = inspectGeminiMediaResponse(utf16Frame(value), {
    capability: 'image',
    contentType: 'application/json',
    assetOrigins: ['https://gemini.gstatic.com'],
  });
  assert.equal(response.allowedAssetUrlCandidateCount, 1);
  assert.equal(response.assetCandidates[0].host, 'gemini.gstatic.com');
  assert.deepEqual(response.assetCandidates[0].queryKeyNames, ['id', 'signature']);
  assert.equal(JSON.stringify(response).includes('do-not-persist'), false);
  assert.equal(JSON.stringify(response).includes('https://gemini.gstatic.com'), false);
});

test('decodes a null-selector wrb.fr JSON string before safe media extraction', () => {
  const nested = JSON.stringify({
    response: { asset: { url: 'https://gemini.gstatic.com/gg-dl/task/image.png?sig=memory-only' } },
    status: 'COMPLETE',
  });
  const response = inspectGeminiMediaResponse(utf16Frame([['wrb.fr', null, nested]]), {
    capability: 'image',
    contentType: 'application/json',
    assetOrigins: ['https://gemini.gstatic.com'],
  });
  assert.equal(response.framing, 'utf16_length_frames');
  assert.equal(response.nullSelectorResponseCount, 1);
  assert.deepEqual(response.rpcIds, []);
  assert.equal(response.allowedAssetUrlCandidateCount, 1);
  assert.equal(response.statusErrorFieldPaths.length, 1);
  assert.equal(JSON.stringify(response).includes('memory-only'), false);
  assert.equal(JSON.stringify(response).includes('COMPLETE'), false);
});

test('keeps business data available only through the in-memory decoder, not the audit summary', () => {
  const nested = JSON.stringify({
    responseId: 'response-private-value',
    conversationId: 'c_0123456789abcdef',
    content: 'Neutral geometry result',
    thought: 'private reasoning must not be exposed as output',
    asset: { url: 'https://gemini.gstatic.com/gg-dl/result.png?signature=memory-only' },
  });
  const decoded = decodeGeminiMediaResponse(utf16Frame([['wrb.fr', null, nested]]), {
    capability: 'image',
    contentType: 'application/json',
    assetOrigins: ['https://gemini.gstatic.com'],
    expectedIntent: 'Neutral geometry result',
  });
  assert.equal(decoded.summary.expectedIntentMatched, true);
  assert.deepEqual(decoded.internal.textCandidates, ['Neutral geometry result']);
  assert.deepEqual(decoded.internal.resourceIds.map((item) => item.kind).sort(), ['conversationId', 'responseId']);
  assert.equal(decoded.internal.resourceIds.find((item) => item.kind === 'conversationId').value, 'c_0123456789abcdef');
  assert.equal(decoded.internal.assetCandidates[0].url, 'https://gemini.gstatic.com/gg-dl/result.png?signature=memory-only');
  const audit = JSON.stringify(decoded.summary);
  assert.equal(audit.includes('memory-only'), false);
  assert.equal(audit.includes('response-private-value'), false);
  assert.equal(audit.includes('Neutral geometry result'), false);
  assert.equal(audit.includes('private reasoning'), false);
});

test('does not return candidates from an unobserved asset origin', () => {
  const value = [{ image: { url: 'https://images.example.invalid/private/output.png?key=secret' } }];
  const response = inspectGeminiMediaResponse(utf16Frame(value), {
    capability: 'image',
    contentType: 'application/json',
    assetOrigins: ['https://gemini.gstatic.com'],
  });
  assert.equal(response.allowedAssetUrlCandidateCount, 0);
  assert.equal(response.blockedAssetUrlCandidateCount, 1);
  assert.deepEqual(response.assetCandidates, []);
  assert.equal(JSON.stringify(response).includes('images.example.invalid'), false);
  assert.equal(JSON.stringify(response).includes('secret'), false);
});

test('recognizes valid inline image bytes but returns only safe metadata', () => {
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const value = [{ image: { data: `data:image/png;base64,${pngSignature.toString('base64')}` } }];
  const response = inspectGeminiMediaResponse(utf16Frame(value), {
    capability: 'image',
    contentType: 'application/json',
    assetOrigins: ['https://gemini.gstatic.com'],
  });
  assert.equal(response.mediaMagicMatched, true);
  assert.equal(response.inlineMediaCandidateCount, 1);
  assert.equal(response.inlineMediaCandidates, undefined);
  assert.equal(JSON.stringify(response).includes(pngSignature.toString('base64')), false);
});

test('detects a direct binary artifact by declared MIME and file signature', () => {
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const response = inspectGeminiMediaResponse(pngSignature, {
    capability: 'image',
    contentType: 'image/png',
    assetOrigins: ['https://gemini.gstatic.com'],
  });
  assert.equal(response.framing, 'direct_media');
  assert.equal(response.mediaMagicMatched, true);
  assert.equal(response.inlineMediaCandidateCount, 1);
});
