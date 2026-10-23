import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectRpcResponses,
  collectNullSelectorResponses,
  parseCapturedStreamGenerateResponse,
  parseBatchResponse,
  requireRpcResponse,
} from '../src/batch-response.mjs';

function frame(value) {
  const json = JSON.stringify(value);
  const bytes = Buffer.from(json, 'utf8');
  return Buffer.concat([Buffer.from(String(bytes.length) + '\n'), bytes, Buffer.from('\n')]);
}

test('parses a direct JSON batch response with an XSSI prefix', () => {
  const body = ")]}'\n" + JSON.stringify([['wrb.fr', 'observed-rpc-id', JSON.stringify({ answer: '안녕하세요' })]]);
  const frames = parseBatchResponse(body);
  assert.equal(requireRpcResponse(frames, 'observed-rpc-id').data.answer, '안녕하세요');
});

test('parses byte-length framed UTF-8 batches and multiple frames', () => {
  const wire = Buffer.concat([
    Buffer.from(")]}'\r\n"),
    frame({ metadata: true }),
    frame([['wrb.fr', 'captured-rpc-id', JSON.stringify({ text: '제미나이' })]]),
  ]);
  const frames = parseBatchResponse(wire, { lengthUnit: 'bytes', frameLengthOverheadUnits: 0 });
  assert.equal(frames.length, 2);
  assert.equal(requireRpcResponse(frames, 'captured-rpc-id').data.text, '제미나이');
  assert.equal(collectRpcResponses(frames).length, 1);
});

test('parses UTF-16-code-unit length frames from the live Gemini batch format', () => {
  const first = JSON.stringify({ label: '한국어 응답' });
  const second = JSON.stringify([['wrb.fr', 'captured-rpc-id', JSON.stringify({ text: '고양이 🐈' })]]);
  const wire = Buffer.from(")]}'\n" + (first.length + 2) + '\n' + first + '\r\n' + (second.length + 2) + '\n' + second + '\r\n', 'utf8');
  const frames = parseBatchResponse(wire, { lengthUnit: 'utf16_code_units', frameLengthOverheadUnits: 2 });
  assert.equal(frames.length, 2);
  assert.equal(requireRpcResponse(frames, 'captured-rpc-id').data.text, '고양이 🐈');
});

test('resumes the next decimal header after the raw JSON value boundary', () => {
  const first = JSON.stringify({ label: '첫 프레임' });
  const second = JSON.stringify('abcdef');
  assert.equal(second.length, 8);
  const secondLength = second.length + 2;
  const wire = Buffer.from(")]}'\n" + (first.length + 2) + '\n' + first + '\n' + secondLength + '\n' + second + '\r\n', 'utf8');
  const frames = parseBatchResponse(wire, { lengthUnit: 'utf16_code_units', frameLengthOverheadUnits: 2 });
  assert.deepEqual(frames, [{ label: '첫 프레임' }, 'abcdef']);
});

test('does not guess legacy byte framing when the observed operation has no byte contract', () => {
  const payload = JSON.stringify({ label: '한국어' });
  const wire = Buffer.concat([Buffer.from(")]}'\n" + Buffer.byteLength(payload) + '\n'), Buffer.from(payload), Buffer.from('\n')]);
  assert.throws(() => parseBatchResponse(wire));
  assert.throws(() => parseBatchResponse(wire, { lengthUnit: 'bytes', frameLengthOverheadUnits: 2 }), { code: 'BATCH_FRAME_LENGTH_UNIT_INVALID' });
});

test('does not infer an RPC id when no observed id was supplied', () => {
  const frames = parseBatchResponse(JSON.stringify([['wrb.fr', 'some-rpc-id', '{}']]));
  assert.throws(() => requireRpcResponse(frames, ''), { code: 'RPC_ID_NOT_OBSERVED' });
  assert.throws(() => requireRpcResponse(frames, 'another-rpc-id'), { code: 'RPC_RESPONSE_MISSING' });
});

test('rejects truncated, malformed, oversized, and invalid UTF-8 frames without echoing bodies', () => {
  assert.throws(() => parseBatchResponse(")]}'\n20\n[]", { lengthUnit: 'bytes' }), { code: 'BATCH_FRAME_TRUNCATED' });
  assert.throws(() => parseBatchResponse(")]}'\nabc\n[]"), { code: 'BATCH_RESPONSE_INVALID_JSON' });
  assert.throws(() => parseBatchResponse(Buffer.from([0xff])), { code: 'BATCH_RESPONSE_INVALID_UTF8' });
  assert.throws(() => parseBatchResponse('123456789', { maxBytes: 4 }), { code: 'BATCH_RESPONSE_TOO_LARGE' });
});

test('rejects ambiguous duplicate results for the observed RPC id', () => {
  const value = [
    ['wrb.fr', 'same-id', '{}'],
    ['wrb.fr', 'same-id', '{}'],
  ];
  assert.throws(() => requireRpcResponse(parseBatchResponse(JSON.stringify(value)), 'same-id'), { code: 'RPC_RESPONSE_AMBIGUOUS' });
});

test('decodes a captured StreamGenerate null-selector frame without inventing an RPC id', () => {
  const data = [null, ['conversation-meta', 'response-meta'], null, null, [[null, ['CORE_SMOKE_OK']]]];
  const body = ")]}'\n" + JSON.stringify([['wrb.fr', null, JSON.stringify(data)]]);
  const operation = {
    observation: { requestResponse: true },
    effect: 'mutation',
    retryPolicy: 'never',
    request: { method: 'POST', path: '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate' },
    response: { selector: 'null' },
  };
  const result = parseCapturedStreamGenerateResponse(body, {
    operation,
    lengthUnit: 'utf16_code_units',
    frameLengthOverheadUnits: 2,
  });
  assert.equal(result.selector, null);
  assert.equal(result.responses.length, 1);
  assert.deepEqual(result.responses[0].data, data);
  assert.equal(collectNullSelectorResponses(parseBatchResponse(body)).length, 1);
  assert.equal(collectRpcResponses(parseBatchResponse(body)).length, 0);
});

test('binds null-selector decoding to the exact no-retry StreamGenerate contract', () => {
  assert.throws(() => parseCapturedStreamGenerateResponse('[]', {
    operation: { observation: { requestResponse: true }, effect: 'read', request: { method: 'POST', path: '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate' }, response: { selector: 'null' } },
    lengthUnit: 'utf16_code_units', frameLengthOverheadUnits: 2,
  }), { code: 'TEXT_RESPONSE_CONTRACT_REQUIRED' });
});
