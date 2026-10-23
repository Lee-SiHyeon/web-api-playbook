import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadSummary, responseSummary, safeCliFailure, streamSummary } from '../src/cli-output.mjs';

test('CLI response summaries omit bodies, media paths, filenames, and stream identifiers', async () => {
  const response = responseSummary({ operationId: 'text.read.synthetic', httpStatus: 200,
    mimeType: 'application/json', responseKind: 'json',
    body: { access_token: 'private-token', signed_url: 'https://private.invalid/?signature=secret' } });
  assert.equal(response.bodyOmitted, true);
  assert.equal(JSON.stringify(response).includes('private-token'), false);
  assert.equal(JSON.stringify(response).includes('private.invalid'), false);

  async function* events() {
    yield { id: 'private-session-id', event: 'secret-event', data: 'cookie=private-cookie' };
  }
  const stream = await streamSummary({ operationId: 'text.send.synthetic', journalId: 'safe-journal-id',
    httpStatus: 200, mimeType: 'text/event-stream', events: events() });
  assert.equal(stream.eventCount, 1);
  assert.equal(stream.dataBytes, Buffer.byteLength('cookie=private-cookie'));
  assert.equal(JSON.stringify(stream).includes('private-cookie'), false);
  assert.equal(JSON.stringify(stream).includes('private-session-id'), false);

  const media = downloadSummary({ outputPath: 'C:\\Users\\private\\file.png', filename: 'private.png',
    bytes: 10, mimeType: 'image/png', signatureVerified: true });
  assert.deepEqual(media, { saved: true, bytes: 10, mimeType: 'image/png', signatureVerified: true });

  const providerError = Object.assign(new Error('CREDENTIAL_STORE_FAILED'), {
    code: 'CREDENTIAL_STORE_FAILED', providerOperation: 'write', providerCause: 'ETIMEDOUT',
    providerStage: 'write', providerErrorClass: 'TimeoutException', providerErrorId: 'Safe.ErrorId',
    stderr: 'never print cookie=secret',
  });
  const safeError = safeCliFailure(providerError);
  assert.deepEqual(safeError, { error: 'CREDENTIAL_STORE_FAILED', providerOperation: 'write',
    providerCause: 'ETIMEDOUT', providerStage: 'write', providerErrorClass: 'TimeoutException',
    providerErrorId: 'Safe.ErrorId' });
  assert.equal(JSON.stringify(safeError).includes('secret'), false);
  assert.deepEqual(safeCliFailure(new Error('raw private error text')), { error: 'INTERNAL_ERROR' });
});
