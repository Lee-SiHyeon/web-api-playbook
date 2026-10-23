import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareGrokOutboundEvent, validatePreparedGrokOutboundEvent } from '../src/grok-castle-event-preparer.mjs';

const event = () => ({
  type: 'response.create',
  event_id: '00000000-0000-4000-8000-000000000001',
  item: {
    type: 'message',
    role: 'user',
    x_grok: {
      client_message_id: '00000000-0000-4000-8000-000000000002',
      input_chunks: [{ text: { text: 'memory-only fixture prompt' } }],
    },
  },
});

test('requires the injected first-party event preparer and never creates a Castle token fallback', async () => {
  await assert.rejects(prepareGrokOutboundEvent(event()), { code: 'TEXT_FIRST_PARTY_REQUEST_METADATA_PRODUCER_REQUIRED' });
  await assert.rejects(prepareGrokOutboundEvent(event(), {
    requestMetadataProducer: { async prepareOutboundEvent(value) { return value; } },
  }), { code: 'TEXT_FIRST_PARTY_CASTLE_TOKEN_UNAVAILABLE' });
});

test('accepts only the first-party Castle preparer adding its one-use token field', async () => {
  const input = event();
  let providerCalls = 0;
  const prepared = await prepareGrokOutboundEvent(input, {
    requestMetadataProducer: {
      async prepareOutboundEvent(value) {
        providerCalls++;
        return { ...value, castle_request_token: 'fixture-only-token' };
      },
    },
  });
  assert.equal(providerCalls, 1);
  assert.equal(prepared.castle_request_token, 'fixture-only-token');
  assert.deepEqual(input, event());
  assert.equal(JSON.stringify(prepared).includes('fixture-only-token'), true);
});

test('validates an already prepared native event without changing its Castle field', () => {
  const prepared = { ...event(), castle_request_token: 'in-memory-native-token' };
  const validated = validatePreparedGrokOutboundEvent(prepared);
  assert.deepEqual(validated, prepared);
  assert.notEqual(validated, prepared);
  assert.throws(() => validatePreparedGrokOutboundEvent(event()), { code: 'TEXT_FIRST_PARTY_CASTLE_EVENT_INVALID' });
});

test('accepts the sanitized 5,941-character native token capture within the bounded 8 KiB limit', async () => {
  let tokenLength = 0;
  const prepared = await prepareGrokOutboundEvent(event(), {
    requestMetadataProducer: {
      async prepareOutboundEvent(value) {
        const token = 'x'.repeat(5_941);
        tokenLength = token.length;
        return { ...value, castle_request_token: token };
      },
    },
  });
  assert.equal(tokenLength, 5_941);
  assert.equal(prepared.castle_request_token.length, 5_941);
  await assert.rejects(prepareGrokOutboundEvent(event(), {
    requestMetadataProducer: {
      async prepareOutboundEvent(value) { return { ...value, castle_request_token: 'x'.repeat(8_193) }; },
    },
  }), { code: 'TEXT_FIRST_PARTY_CASTLE_TOKEN_UNAVAILABLE' });
});

test('rejects prefilled tokens, unsupported events, provider mutations, and unbounded event data', async () => {
  const provider = { async prepareOutboundEvent(value) { return { ...value, castle_request_token: 'fixture-only-token' }; } };
  await assert.rejects(prepareGrokOutboundEvent({ ...event(), castle_request_token: 'caller-value' }, { requestMetadataProducer: provider }),
    { code: 'TEXT_REQUEST_METADATA_EVENT_INVALID' });
  await assert.rejects(prepareGrokOutboundEvent({ type: 'session.create' }, { requestMetadataProducer: provider }),
    { code: 'TEXT_REQUEST_METADATA_EVENT_INVALID' });
  await assert.rejects(prepareGrokOutboundEvent(event(), {
    requestMetadataProducer: { async prepareOutboundEvent(value) { return { ...value, extra: true, castle_request_token: 'fixture-only-token' }; } },
  }), { code: 'TEXT_REQUEST_METADATA_EVENT_MUTATED' });
  await assert.rejects(prepareGrokOutboundEvent({ ...event(), extra: 'x'.repeat(300_000) }, { requestMetadataProducer: provider }),
    { code: 'TEXT_REQUEST_METADATA_EVENT_SIZE_INVALID' });
});
