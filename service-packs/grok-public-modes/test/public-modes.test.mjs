import assert from 'node:assert/strict';
import test from 'node:test';
import { getPublicModes, GrokPublicModesError } from '../src/public-modes.mjs';

function mode(id, availability = { available: {} }) {
  return {
    id,
    title: `Title ${id}`,
    description: 'Synthetic public description',
    badgeText: '',
    iconHint: 'synthetic-icon',
    tags: ['synthetic', 'public'],
    availability,
  };
}

function htmlFor(value) {
  return `<!doctype html><html><body><main><script type="application/json" id="server-client-data-modes">${JSON.stringify(value)}</script></main></body></html>`;
}

function config() {
  return {
    locale: 'en',
    defaultModeId: 'mode-public',
    modes: [
      mode('mode-public'),
      mode('mode-locked', { requiresUpgrade: { message: 'Synthetic upgrade message' } }),
    ],
  };
}

function fakeFetch(body, { status = 200, contentType = 'text/html; charset=utf-8', headers = {} } = {}) {
  return async (url, options) => {
    assert.equal(url, 'https://grok.com/');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.credentials, 'omit');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    assert.equal(Object.keys(options).some((key) => key.toLowerCase() === 'headers'), false);
    const responseHeaders = new Headers({ 'content-type': contentType, ...headers });
    return new Response(body, { status, headers: responseHeaders });
  };
}

test('reads and projects only observed public SSR mode fields', async () => {
  const result = await getPublicModes({ fetchImpl: fakeFetch(htmlFor(config())) });

  assert.equal(result.scope, 'public_ui_modes');
  assert.equal(result.transport, 'direct_http');
  assert.deepEqual(result.request, {
    method: 'GET',
    url: 'https://grok.com/',
    credentials: 'omitted',
  });
  assert.equal(result.http.status, 200);
  assert.equal(result.http.contentType, 'text/html');
  assert.equal(result.http.bytes, Buffer.byteLength(htmlFor(config())));
  assert.match(result.http.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(result.config, config());
});

test('rejects changed top-level schema with a typed safe code', async () => {
  const changed = config();
  changed.locale = { unexpected: 'must not appear in errors' };
  const responseBody = htmlFor(changed);

  await assert.rejects(
    getPublicModes({ fetchImpl: fakeFetch(responseBody) }),
    (error) => error instanceof GrokPublicModesError &&
      error.code === 'GROK_MODES_SCHEMA_CHANGED' &&
      error.message === 'GROK_MODES_SCHEMA_CHANGED' &&
      !error.message.includes('unexpected'),
  );
});

test('keeps mode-row fields opaque for callers', async () => {
  const configWithExtension = config();
  configWithExtension.modes[0].futureField = { value: 'synthetic' };
  const result = await getPublicModes({ fetchImpl: fakeFetch(htmlFor(configWithExtension)) });

  assert.deepEqual(result.config.modes[0], configWithExtension.modes[0]);
});

test('rejects an HTTP redirect without following it', async () => {
  await assert.rejects(
    getPublicModes({ fetchImpl: fakeFetch('<html>redirect</html>', { status: 302 }) }),
    (error) => error instanceof GrokPublicModesError &&
      error.code === 'GROK_HTTP_ERROR' && error.httpStatus === 302,
  );
});

test('rejects non-HTML responses before parsing their body', async () => {
  await assert.rejects(
    getPublicModes({ fetchImpl: fakeFetch('{"private":"synthetic"}', { contentType: 'application/json' }) }),
    (error) => error instanceof GrokPublicModesError &&
      error.code === 'GROK_MIME_ERROR' && error.httpStatus === 200 &&
      !error.message.includes('private'),
  );
});

test('rejects a streamed document larger than 2 MiB and cancels the stream', async () => {
  let cancelled = false;
  const fetchImpl = async () => new Response(new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
    },
    cancel() {
      cancelled = true;
    },
  }), { status: 200, headers: { 'content-type': 'text/html' } });

  await assert.rejects(
    getPublicModes({ fetchImpl }),
    (error) => error instanceof GrokPublicModesError && error.code === 'GROK_HTML_TOO_LARGE',
  );
  assert.equal(cancelled, true);
});
