import { PRIMARY_ORIGIN, validateRegistry } from '../src/contracts.mjs';

export function syntheticOperation({ id = 'text.read.synthetic', kind = 'read', method = 'POST',
  responseKind = 'json', encoding = 'json' } = {}) {
  const request = encoding === 'json'
    ? { encoding, headers: {}, template: { target: { $input: 'targetId' }, text: { $input: 'text' } } }
    : encoding === 'multipart'
      ? { encoding, media: { fieldName: 'file', maxBytes: 4096, contentTypes: ['image/png'] },
        textFields: { target: { $input: 'targetId' } }, headers: {} }
      : { encoding, headers: {} };
  return {
    id, family: 'text', kind, captured: true,
    observedAt: '2026-10-03T00:00:00.000Z',
    evidence: { requestRef: 'tests/fixtures/synthetic-request.json', responseRef: 'tests/fixtures/synthetic-response.json' },
    origin: PRIMARY_ORIGIN,
    method,
    pathTemplate: '/__synthetic__/{targetId}',
    inputSchema: { targetId: { type: 'string', required: true, maxLength: 100 }, text: { type: 'string', maxLength: 10000 } },
    targetInput: kind === 'mutation' || kind === 'media-upload' ? 'targetId' : undefined,
    auth: 'chatgpt-session',
    request,
    response: responseKind === 'sse'
      ? { kind: 'sse', contentTypes: ['text/event-stream'], successStatuses: [200], maxBytes: 64_000 }
      : responseKind === 'media'
        ? { kind: 'media', contentTypes: ['image/png'], successStatuses: [200], maxBytes: 4096,
          media: { contentTypes: ['image/png'], maxBytes: 4096 } }
        : { kind: responseKind, contentTypes: [responseKind === 'json' ? 'application/json' : 'text/plain'],
          successStatuses: [200], maxBytes: 64_000 },
  };
}

export function syntheticRegistry(operations = [syntheticOperation()]) {
  return validateRegistry({ schemaVersion: 1, service: 'chatgpt-web', primaryOrigin: PRIMARY_ORIGIN,
    captured: true, captureReference: 'tests/fixtures/synthetic-capture.json',
    allowedOrigins: [PRIMARY_ORIGIN], operations });
}

export const syntheticSessionProvider = {
  async cookieHeaderFor(url) {
    if (url.origin !== PRIMARY_ORIGIN) throw new Error('TEST_SCOPE_ERROR');
    return 'synthetic_session=unit-test-only';
  },
  async status() { return { providerReady: true, credentialPresent: true, authenticated: false }; },
};
