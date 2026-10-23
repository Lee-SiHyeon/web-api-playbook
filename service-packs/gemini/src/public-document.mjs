import { request } from 'node:https';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parse } from 'parse5';
import { fail } from './errors.mjs';

export const PUBLIC_DOCUMENT_URL = 'https://gemini.google.com/';
export const MAX_HEADER_BYTES = 262144;
export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

function walk(node, visit) {
  const pending = [node];
  while (pending.length) {
    const current = pending.pop();
    visit(current);
    for (const child of [...(current.childNodes ?? [])].reverse()) pending.push(child);
  }
}

function text(node) {
  let value = '';
  walk(node, child => { if (child.nodeName === '#text') value += child.value; });
  return value;
}

export function inspectPublicDocument(html) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > MAX_DOCUMENT_BYTES) {
    fail('PUBLIC_DOCUMENT_TOO_LARGE', 'Public document exceeds the configured bound.');
  }
  const document = parse(html);
  let title = '', lang = '', scripts = 0, externalScripts = 0, appElements = 0;
  const scriptIds = new Set();
  walk(document, node => {
    const attrs = Object.fromEntries((node.attrs ?? []).map(attr => [attr.name, attr.value]));
    if (node.tagName === 'html') lang = attrs.lang ?? '';
    if (node.tagName === 'title') title = text(node).replace(/[\u200e\u200f]/g, '').trim().slice(0, 120);
    if (node.tagName === 'chat-app-orchestrator') appElements++;
    if (node.tagName === 'script') {
      scripts++;
      if (attrs.src) externalScripts++;
      if (attrs.id) scriptIds.add(attrs.id);
    }
  });
  const layoutMatched = appElements === 1 && scriptIds.has('bard-initial-data')
    && scriptIds.has('base-js') && /Google Gemini/i.test(title);
  const challengeDocument = /^(?:just a moment|verify you are human|access denied)/i.test(title)
    || (!layoutMatched && /__cf_chl|cf-chl|challenge-platform/.test(html));
  return {
    title, lang, scripts, externalScripts, appElements,
    layoutMatched, challengeDocument,
    bootstrapMarkers: Object.fromEntries(['AF_initDataCallback', 'WIZ_global_data', 'FdrFJe', 'cfb2h']
      .map(name => [name, html.includes(name)])),
    // Marker presence does not expose token values or prove authentication.
    authenticationVerified: false,
  };
}

export async function readPublicDocument({ requestImpl = request, responseImpl, timeoutMs = 20000, executionMode = 'pure_http' } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    fail('PUBLIC_DOCUMENT_TIMEOUT_INVALID', 'Timeout must be between 1 and 60000 milliseconds.');
  }
  if (!['pure_http', 'chrome_compatible_http'].includes(executionMode)) {
    fail('PUBLIC_DOCUMENT_TRANSPORT_INVALID', 'Unsupported public document transport.');
  }
  const checkedAt = new Date().toISOString();
  let received;
  try {
    if (responseImpl) {
      received = await responseImpl({ url: PUBLIC_DOCUMENT_URL, method: 'GET', timeoutMs, maxHeaderBytes: MAX_HEADER_BYTES, maxDocumentBytes: MAX_DOCUMENT_BYTES });
    } else received = await new Promise((resolve, reject) => {
      const req = requestImpl(PUBLIC_DOCUMENT_URL, {
        method: 'GET', maxHeaderSize: MAX_HEADER_BYTES,
        signal: AbortSignal.timeout(timeoutMs),
      }, response => {
        const status = response.statusCode;
        const contentType = String(response.headers['content-type'] ?? '');
        if (status !== 200 || !/^text\/html(?:;|$)/i.test(contentType)) {
          response.destroy();
          reject(Object.assign(new Error('PUBLIC_DOCUMENT_RESPONSE_REJECTED'), { code: 'PUBLIC_DOCUMENT_RESPONSE_REJECTED' }));
          return;
        }
        const parts = [];
        let bytes = 0;
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > MAX_DOCUMENT_BYTES) {
            response.destroy(Object.assign(new Error('PUBLIC_DOCUMENT_TOO_LARGE'), { code: 'PUBLIC_DOCUMENT_TOO_LARGE' }));
          } else parts.push(Buffer.from(chunk));
        });
        response.on('error', reject);
        response.on('end', () => resolve({ status, contentType, bytes, body: Buffer.concat(parts) }));
      });
      req.on('error', reject);
      req.end();
    });
  } catch (error) {
    const code = ['PUBLIC_DOCUMENT_TOO_LARGE', 'PUBLIC_DOCUMENT_HEADER_TOO_LARGE', 'PUBLIC_DOCUMENT_RESPONSE_REJECTED'].includes(error?.code)
      ? error.code : 'PUBLIC_DOCUMENT_TRANSPORT_FAILED';
    fail(code, 'Public document request failed; no authenticated request was attempted.');
  }
  if (!received || !Number.isInteger(received.status) || typeof received.contentType !== 'string' || !Buffer.isBuffer(received.body)
      || received.body.length > MAX_DOCUMENT_BYTES) {
    fail(received?.body?.length > MAX_DOCUMENT_BYTES ? 'PUBLIC_DOCUMENT_TOO_LARGE' : 'PUBLIC_DOCUMENT_TRANSPORT_FAILED',
      'Public document request failed; no authenticated request was attempted.');
  }
  if (received.status !== 200 || !/^text\/html(?:;|$)/i.test(received.contentType)) {
    fail('PUBLIC_DOCUMENT_RESPONSE_REJECTED', 'Public document request failed; no authenticated request was attempted.');
  }
  const metadata = inspectPublicDocument(received.body.toString('utf8'));
  if (metadata.challengeDocument) fail('PUBLIC_DOCUMENT_CHALLENGE', 'Received a challenge document.');
  if (!metadata.layoutMatched) fail('HTML_LAYOUT_CHANGED', 'Expected public app-shell selectors were absent.');
  return {
    operation: 'public_document_metadata', checkedAt, executionMode,
    status: received.status, contentType: received.contentType, bodyBytes: received.body.length,
    bodySha256: createHash('sha256').update(received.body).digest('hex'),
    credentialsSent: false, directReadVerified: true,
    ...metadata,
    browserCaptured: false, chatLiveReplay: false, imageLiveReplay: false, videoLiveReplay: false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(`${JSON.stringify(await readPublicDocument())}\n`); }
  catch (error) { process.stderr.write(`${error.code ?? 'PUBLIC_DOCUMENT_FAILED'}\n`); process.exitCode = 1; }
}
