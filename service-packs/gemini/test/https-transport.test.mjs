import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createHttpsFetch, DEFAULT_MAX_HEADER_BYTES } from '../src/https-transport.mjs';

test('uses bounded 256 KiB response headers for the observed public Gemini document size', async () => {
  let capturedOptions;
  const requestImpl = (url, options, callback) => {
    capturedOptions = options;
    const request = new EventEmitter();
    request.write = () => {};
    request.setTimeout = () => {};
    request.end = () => {
      const response = Readable.from([Buffer.from('{}')]);
      response.statusCode = 200;
      response.rawHeaders = ['content-type', 'application/json'];
      callback(response);
    };
    return request;
  };
  const fetch = createHttpsFetch({ requestImpl });
  const response = await fetch('https://gemini.google.com/observed', { method: 'GET', headers: { accept: 'application/json' } });
  const parts = [];
  for await (const part of response.body) parts.push(part);
  assert.equal(capturedOptions.maxHeaderSize, DEFAULT_MAX_HEADER_BYTES);
  assert.equal(response.headerBytes > 0, true);
  assert.equal(Buffer.concat(parts).toString('utf8'), '{}');
});

test('keeps the response-header limit bounded and rejects non-HTTPS URLs', async () => {
  const fetch = createHttpsFetch({ requestImpl: () => { throw new Error('must not be called'); }, maxHeaderBytes: 1024 });
  await assert.rejects(fetch('http://gemini.google.com/'), { code: 'HTTPS_REQUIRED' });
});

test('rejects a mocked response whose header block exceeds the configured limit', async () => {
  const requestImpl = (url, options, callback) => {
    const request = new EventEmitter();
    request.write = () => {};
    request.setTimeout = () => {};
    request.end = () => {
      const response = Readable.from([]);
      response.statusCode = 200;
      response.rawHeaders = ['x-test', 'x'.repeat(1100)];
      callback(response);
    };
    return request;
  };
  const fetch = createHttpsFetch({ requestImpl, maxHeaderBytes: 1024 });
  await assert.rejects(fetch('https://gemini.google.com/'), { code: 'TRANSPORT_FAILED' });
});
