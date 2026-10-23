import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail } from './errors.mjs';
import { MAX_DOCUMENT_BYTES, MAX_HEADER_BYTES, readPublicDocument } from './public-document.mjs';

const HELPER_PATH = fileURLToPath(new URL('../scripts/gemini-public-document-chrome.py', import.meta.url));
const MAX_PROTOCOL_HEADER_BYTES = 1024;
const MAX_CHILD_STDOUT_BYTES = MAX_DOCUMENT_BYTES + MAX_PROTOCOL_HEADER_BYTES;
const ALLOWED_CHILD_ERRORS = new Set(['PUBLIC_DOCUMENT_TOO_LARGE', 'PUBLIC_DOCUMENT_HEADER_TOO_LARGE', 'PUBLIC_DOCUMENT_TRANSPORT_FAILED']);
const ALLOWED_HTTP_VERSIONS = new Set(['http/1.0', 'http/1.1', 'h2', 'h3']);
const CHILD_TIMEOUT_MS = 30000;

function parseFrame(output) {
  const boundary = output.indexOf(0x0a);
  if (boundary < 2 || boundary > MAX_PROTOCOL_HEADER_BYTES) {
    fail('PUBLIC_DOCUMENT_TRANSPORT_FAILED', 'Public document request failed; no authenticated request was attempted.');
  }
  let frame;
  try { frame = JSON.parse(output.subarray(0, boundary).toString('utf8')); }
  catch { fail('PUBLIC_DOCUMENT_TRANSPORT_FAILED', 'Public document request failed; no authenticated request was attempted.'); }
  if (frame && typeof frame.error === 'string' && ALLOWED_CHILD_ERRORS.has(frame.error)) {
    fail(frame.error, 'Public document request failed; no authenticated request was attempted.');
  }
  const body = output.subarray(boundary + 1);
  if (!frame || !Number.isInteger(frame.status) || typeof frame.contentType !== 'string'
      || frame.contentType.length > 256 || body.length > MAX_DOCUMENT_BYTES
      || !Number.isInteger(frame.headerBytes) || frame.headerBytes < 1 || frame.headerBytes > MAX_HEADER_BYTES
      || (frame.httpVersion !== null && frame.httpVersion !== undefined && !ALLOWED_HTTP_VERSIONS.has(frame.httpVersion))) {
    fail(body.length > MAX_DOCUMENT_BYTES ? 'PUBLIC_DOCUMENT_TOO_LARGE' : 'PUBLIC_DOCUMENT_TRANSPORT_FAILED',
      'Public document request failed; no authenticated request was attempted.');
  }
  return {
    status: frame.status, contentType: frame.contentType, httpVersion: frame.httpVersion ?? null,
    headerBytes: frame.headerBytes, body: Buffer.from(body),
  };
}

function runPython(pythonPath, { spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(pythonPath, [HELPER_PATH], {
        cwd: '/',
        env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      reject(Object.assign(new Error('PUBLIC_DOCUMENT_TRANSPORT_FAILED'), { code: 'PUBLIC_DOCUMENT_TRANSPORT_FAILED' }));
      return;
    }
    const chunks = [];
    let total = 0;
    let settled = false;
    const timer = setTimeout(() => rejectSafe(), CHILD_TIMEOUT_MS);
    timer.unref?.();
    const rejectSafe = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* Child may already have exited. */ }
      reject(Object.assign(new Error('PUBLIC_DOCUMENT_TRANSPORT_FAILED'), { code: 'PUBLIC_DOCUMENT_TRANSPORT_FAILED' }));
    };
    child.stdout.on('data', chunk => {
      total += chunk.length;
      if (total > MAX_CHILD_STDOUT_BYTES) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          try { child.kill(); } catch { /* Child may already have exited. */ }
          reject(Object.assign(new Error('PUBLIC_DOCUMENT_TOO_LARGE'), { code: 'PUBLIC_DOCUMENT_TOO_LARGE' }));
        }
        return;
      }
      if (!settled) chunks.push(Buffer.from(chunk));
    });
    // Stderr may contain interpreter/library diagnostics. Never forward or retain it.
    child.stderr.on('data', () => {});
    child.once('error', rejectSafe);
    child.once('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(Object.assign(new Error('PUBLIC_DOCUMENT_TRANSPORT_FAILED'), { code: 'PUBLIC_DOCUMENT_TRANSPORT_FAILED' }));
        return;
      }
      try { resolve(parseFrame(Buffer.concat(chunks, total))); }
      catch (error) { reject(error); }
    });
  });
}

export async function readPublicDocumentChrome({ pythonPath, spawnImpl } = {}) {
  if (typeof pythonPath !== 'string' || !isAbsolute(pythonPath)) {
    fail('PUBLIC_DOCUMENT_PYTHON_PATH_INVALID', 'Chrome-compatible transport requires an absolute Python executable path.');
  }
  let negotiatedHttpVersion = null;
  let responseHeaderBytes = null;
  const receipt = await readPublicDocument({
    responseImpl: async () => {
      const received = await runPython(pythonPath, { spawnImpl });
      negotiatedHttpVersion = received.httpVersion;
      responseHeaderBytes = received.headerBytes;
      return received;
    },
    executionMode: 'chrome_compatible_http',
  });
  return {
    ...receipt,
    transport: {
      library: 'curl_cffi', libraryVersion: '0.16.3', browserProfile: 'chrome150', platform: 'Linux x86_64',
      negotiatedHttpVersion, responseHeaderBytes,
    },
  };
}

export const chromePublicDocumentInternals = Object.freeze({ HELPER_PATH, MAX_CHILD_STDOUT_BYTES });
