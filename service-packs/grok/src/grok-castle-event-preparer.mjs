import { fail } from './errors.mjs';

export const GROK_CASTLE_EVENT_PREPARER_SOURCE = Object.freeze({
  registrationFunction: 'registerCastleChatMinter',
  nativeHook: 'gatewayConnectionManager.setOutboundEventPreparer',
  preparedEventTypes: Object.freeze(['response.create', 'conversation.queue.add', 'conversation.queue.interject']),
  tokenField: 'castle_request_token',
  behavior: 'consume_fresh_or_prime_and_wait',
});

const PREPARABLE_EVENT_TYPES = new Set(GROK_CASTLE_EVENT_PREPARER_SOURCE.preparedEventTypes);
const MAX_EVENT_BYTES = 256 * 1024;
// A guarded native capture observed a genuine 5,941-character token. Keep
// modest headroom while staying far below the event and transport frame caps.
const MAX_TOKEN_BYTES = 8_192;

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonBytes(value) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { throw fail('TEXT_REQUEST_METADATA_EVENT_INVALID'); }
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_EVENT_BYTES) {
    throw fail('TEXT_REQUEST_METADATA_EVENT_SIZE_INVALID');
  }
  return serialized;
}

/**
 * Pass an outbound event through the injected first-party Castle event preparer.
 * This module never creates, substitutes, or persists a Castle token.
 */
export async function prepareGrokOutboundEvent(event, { requestMetadataProducer } = {}) {
  if (!plainObject(event) || !PREPARABLE_EVENT_TYPES.has(event.type) || Object.hasOwn(event, 'castle_request_token')) {
    throw fail('TEXT_REQUEST_METADATA_EVENT_INVALID');
  }
  if (!requestMetadataProducer || typeof requestMetadataProducer.prepareOutboundEvent !== 'function') {
    throw fail('TEXT_FIRST_PARTY_REQUEST_METADATA_PRODUCER_REQUIRED');
  }
  const eventText = jsonBytes(event);
  let providerInput;
  try { providerInput = structuredClone(event); } catch { throw fail('TEXT_REQUEST_METADATA_EVENT_INVALID'); }
  let prepared;
  try {
    prepared = await requestMetadataProducer.prepareOutboundEvent(providerInput);
  } catch {
    throw fail('TEXT_FIRST_PARTY_REQUEST_METADATA_PRODUCER_FAILED');
  }
  if (!plainObject(prepared) || typeof prepared.castle_request_token !== 'string'
    || !prepared.castle_request_token.trim() || Buffer.byteLength(prepared.castle_request_token, 'utf8') > MAX_TOKEN_BYTES
    || /[\r\n\0]/.test(prepared.castle_request_token)) {
    throw fail('TEXT_FIRST_PARTY_CASTLE_TOKEN_UNAVAILABLE');
  }
  const originalFields = { ...prepared };
  delete originalFields.castle_request_token;
  if (jsonBytes(originalFields) !== eventText) throw fail('TEXT_REQUEST_METADATA_EVENT_MUTATED');
  return prepared;
}

/** Validate an event already captured after the first-party event preparer ran. */
export function validatePreparedGrokOutboundEvent(event) {
  if (!plainObject(event) || !PREPARABLE_EVENT_TYPES.has(event.type)
    || typeof event.castle_request_token !== 'string' || !event.castle_request_token.trim()
    || Buffer.byteLength(event.castle_request_token, 'utf8') > MAX_TOKEN_BYTES || /[\r\n\0]/.test(event.castle_request_token)) {
    throw fail('TEXT_FIRST_PARTY_CASTLE_EVENT_INVALID');
  }
  jsonBytes(event);
  try { return structuredClone(event); } catch { throw fail('TEXT_FIRST_PARTY_CASTLE_EVENT_INVALID'); }
}
