import test from 'node:test';
import assert from 'node:assert/strict';
import { FlowClient } from '../src/client.mjs';
import { buildTextVideoSubmission, CAPTCHA_SLOT, RPC } from '../src/protocol.mjs';

function makeClient() {
  let rpcCalls = 0;
  const client = new FlowClient({
    transport: {
      getContext: () => ({ projectId: '123e4567-e89b-42d3-a456-426614174000' }),
      rpc: async () => {
        rpcCalls += 1;
        throw new Error('Transport must not be called by a blocked generation operation.');
      },
    },
  });
  return { client, getRpcCalls: () => rpcCalls };
}

test('generateVideo fails closed when the pure HTTP first-party input issuer is unavailable', async () => {
  const { client, getRpcCalls } = makeClient();
  await assert.rejects(client.generateVideo({ prompt: 'synthetic', outputPath: 'unused.mp4' }), (error) =>
    error.serverCode === 'FLOW_HTTP_CAPTCHA_ISSUER_UNAVAILABLE' && error.rejected === true);
  assert.equal(getRpcCalls(), 0);
});

test('the generation RPC cannot enter the browser-free read transport', async () => {
  const { client, getRpcCalls } = makeClient();
  await assert.rejects(client.batchRpc(RPC.generateTextVideo, '[]'), (error) =>
    error.serverCode === 'FLOW_GENERATION_INPUT_REQUIRED' && error.rejected === true);
  assert.equal(getRpcCalls(), 0);
});

test('the text-to-video builder matches the observed Flow envelope without embedding a token', () => {
  const projectId = '123e4567-e89b-42d3-a456-426614174000';
  const { freq, clientIds, requestId } = buildTextVideoSubmission({
    prompt: 'synthetic test prompt',
    projectId,
    aspect: '16:9',
    duration: 4,
    resolution: '360p',
  });
  const envelope = JSON.parse(freq);
  const [rpcId, encodedPayload, , envelopeType] = envelope[0][0];
  const payload = JSON.parse(encodedPayload);

  assert.equal(rpcId, RPC.generateTextVideo);
  assert.equal(envelopeType, 'generic');
  assert.equal(payload[0][0][0][2][0][0][0], 'synthetic test prompt');
  assert.equal(payload[0][0][1], 'abra_t2v_4s_360p');
  assert.equal(payload[0][0][2], 2);
  assert.deepEqual(payload[0][0][7], [4]);
  assert.equal(payload[1][5], projectId);
  assert.deepEqual(payload[1][10], [CAPTCHA_SLOT, 1]);
  assert.equal(clientIds.length, 2);
  assert.ok(clientIds.every((id) => /^[A-F0-9-]{36}$/.test(id)));
  assert.equal(payload[2][0], requestId);
  assert.match(requestId, /^[A-F0-9-]{36}$/);
});
