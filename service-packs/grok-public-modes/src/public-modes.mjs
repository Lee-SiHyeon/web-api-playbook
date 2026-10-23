import { parse } from 'parse5';

const HOME_URL = 'https://grok.com/';
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const MODES_SCRIPT_ID = 'server-client-data-modes';

export class GrokPublicModesError extends Error {
  constructor(code, { httpStatus, transportCode } = {}) {
    super(code);
    this.name = 'GrokPublicModesError';
    this.code = code;
    if (Number.isInteger(httpStatus)) this.httpStatus = httpStatus;
    if (typeof transportCode === 'string' && /^[A-Za-z0-9_]{1,100}$/.test(transportCode)) this.transportCode = transportCode;
  }
}

function fail(code, details) {
  throw new GrokPublicModesError(code, details);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function cancelBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is best effort; never expose transport details in errors.
  }
}

async function readBoundedBody(response) {
  const contentLength = response.headers.get('content-length');
  if (/^\d+$/.test(contentLength ?? '') && Number(contentLength) > MAX_HTML_BYTES) {
    await cancelBody(response);
    fail('GROK_HTML_TOO_LARGE', { httpStatus: response.status });
  }

  const reader = response.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(), byteLength: 0 };

  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      byteLength += chunk.byteLength;
      if (byteLength > MAX_HTML_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the bounded-size error even when cancellation fails.
        }
        fail('GROK_HTML_TOO_LARGE', { httpStatus: response.status });
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof GrokPublicModesError) throw error;
    fail('GROK_BODY_READ_FAILED', { httpStatus: response.status, transportCode: error.cause?.code ?? error.code });
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A failed or cancelled stream may not release cleanly.
    }
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, byteLength };
}

function getAttribute(node, name) {
  return node.attrs?.find((attribute) => attribute.name === name)?.value;
}

function findModeScript(document) {
  const stack = [document];
  const matches = [];

  while (stack.length > 0) {
    const node = stack.pop();
    if (node.tagName === 'script' && getAttribute(node, 'id') === MODES_SCRIPT_ID) {
      matches.push(node);
    }
    for (const child of node.childNodes ?? []) stack.push(child);
  }

  if (matches.length === 0) fail('GROK_MODES_SCRIPT_MISSING');
  if (matches.length !== 1) fail('GROK_MODES_SCHEMA_CHANGED');
  const script = matches[0];
  if ((getAttribute(script, 'type') ?? '').trim().toLowerCase() !== 'application/json') {
    fail('GROK_MODES_SCHEMA_CHANGED');
  }
  return (script.childNodes ?? [])
    .filter((node) => node.nodeName === '#text')
    .map((node) => node.value)
    .join('');
}

function projectModes(value) {
  if (!isRecord(value) || typeof value.locale !== 'string' ||
      typeof value.defaultModeId !== 'string' || !Array.isArray(value.modes)) {
    fail('GROK_MODES_SCHEMA_CHANGED');
  }
  return {
    locale: value.locale,
    defaultModeId: value.defaultModeId,
    // Mode rows are public response data; keep their observed shape opaque.
    modes: value.modes,
  };
}

/**
 * Reads the observed public SSR mode catalog from the Grok home document.
 * No cookies, auth headers, or account-scoped endpoints are used.
 */
export async function getPublicModes({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') fail('GROK_FETCH_UNAVAILABLE');

  let response;
  try {
    response = await fetchImpl(HOME_URL, {
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    fail('GROK_FETCH_FAILED', { transportCode: error.cause?.code ?? error.code });
  }

  if (response.status !== 200) {
    await cancelBody(response);
    fail('GROK_HTTP_ERROR', { httpStatus: response.status });
  }

  const rawContentType = response.headers.get('content-type') ?? '';
  if (!/^text\/html(?:\s*;|$)/i.test(rawContentType)) {
    await cancelBody(response);
    fail('GROK_MIME_ERROR', { httpStatus: response.status });
  }

  const { bytes, byteLength } = await readBoundedBody(response);
  let html;
  try {
    html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('GROK_HTML_ENCODING_INVALID', { httpStatus: response.status });
  }

  let document;
  try {
    document = parse(html);
  } catch {
    fail('GROK_HTML_PARSE_FAILED', { httpStatus: response.status });
  }
  const scriptText = findModeScript(document);
  let decoded;
  try {
    decoded = JSON.parse(scriptText);
  } catch {
    fail('GROK_MODES_JSON_INVALID', { httpStatus: response.status });
  }

  return {
    scope: 'public_ui_modes',
    transport: 'direct_http',
    request: {
      method: 'GET',
      url: HOME_URL,
      credentials: 'omitted',
    },
    http: {
      status: response.status,
      contentType: 'text/html',
      bytes: byteLength,
      checkedAt: new Date().toISOString(),
    },
    config: projectModes(decoded),
  };
}
