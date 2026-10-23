import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { inspectPublicDocument, readPublicDocument, MAX_HEADER_BYTES, MAX_DOCUMENT_BYTES } from '../src/public-document.mjs';

const shell = `<html lang="en-US"><head><title>\u200eGoogle Gemini</title>
<script id="bard-initial-data">WIZ_global_data={FdrFJe:'fixture-secret',cfb2h:'fixture-build'};AF_initDataCallback({});</script>
<script id="base-js" src="https://gemini.gstatic.com/fixture.js"></script></head>
<body><chat-app-orchestrator></chat-app-orchestrator></body></html>`;

function transport(body, { status = 200, type = 'text/html; charset=utf-8' } = {}) {
  return (url, options, callback) => {
    assert.equal(url, 'https://gemini.google.com/');
    assert.equal(options.method, 'GET');
    assert.equal(options.maxHeaderSize, MAX_HEADER_BYTES);
    assert.equal(options.headers, undefined, 'No credentials or browser impersonation headers');
    const req = new EventEmitter();
    req.end = () => queueMicrotask(() => {
      const response = new PassThrough();
      response.statusCode = status;
      response.headers = { 'content-type': type };
      callback(response);
      response.end(body);
    });
    return req;
  };
}

test('real DOM selectors identify public app shell without returning bootstrap values', () => {
  const metadata = inspectPublicDocument(shell);
  assert.equal(metadata.layoutMatched, true);
  assert.equal(metadata.title, 'Google Gemini');
  assert.equal(metadata.scripts, 2);
  assert.equal(metadata.externalScripts, 1);
  assert.equal(metadata.authenticationVerified, false);
  assert.equal(metadata.bootstrapMarkers.FdrFJe, true);
  assert.doesNotMatch(JSON.stringify(metadata), /fixture-secret|fixture-build/);
});

test('a title alone does not prove the expected app document', () => {
  assert.equal(inspectPublicDocument('<title>Google Gemini</title><form>Sign in</form>').layoutMatched, false);
  assert.equal(inspectPublicDocument('<title>Just a moment...</title>').challengeDocument, true);
});

test('bounded HTTP read returns safe metadata and no authentication/generation claim', async () => {
  const result = await readPublicDocument({ requestImpl: transport(shell) });
  assert.equal(result.directReadVerified, true);
  assert.equal(result.credentialsSent, false);
  assert.equal(result.chatLiveReplay, false);
  assert.equal(result.videoLiveReplay, false);
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret|fixture-build/);
});

test('redirects, login JSON and layout drift are rejected', async () => {
  await assert.rejects(readPublicDocument({ requestImpl: transport('', { status: 302 }) }), { code: 'PUBLIC_DOCUMENT_RESPONSE_REJECTED' });
  await assert.rejects(readPublicDocument({ requestImpl: transport('{}', { type: 'application/json' }) }), { code: 'PUBLIC_DOCUMENT_RESPONSE_REJECTED' });
  await assert.rejects(readPublicDocument({ requestImpl: transport('<title>Google Gemini</title>') }), { code: 'HTML_LAYOUT_CHANGED' });
});

test('response and parser bounds reject oversized documents', async () => {
  const huge = 'x'.repeat(MAX_DOCUMENT_BYTES + 1);
  assert.throws(() => inspectPublicDocument(huge), { code: 'PUBLIC_DOCUMENT_TOO_LARGE' });
  await assert.rejects(readPublicDocument({ requestImpl: transport(huge) }), { code: 'PUBLIC_DOCUMENT_TOO_LARGE' });
});
