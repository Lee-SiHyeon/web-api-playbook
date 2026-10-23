import https from 'node:https';
import { GeminiClientError } from './errors.mjs';

export const DEFAULT_MAX_HEADER_BYTES = 256 * 1024;

function incomingHeaders(rawHeaders) {
  const headers = new Headers();
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    headers.append(rawHeaders[index], rawHeaders[index + 1]);
  }
  return headers;
}

function countHeaderBytes(rawHeaders) {
  let total = 0;
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    total += Buffer.byteLength(rawHeaders[index], 'latin1') + Buffer.byteLength(rawHeaders[index + 1], 'latin1') + 4;
  }
  return total;
}

export function createHttpsFetch({ requestImpl = https.request, maxHeaderBytes = DEFAULT_MAX_HEADER_BYTES } = {}) {
  if (typeof requestImpl !== 'function' || !Number.isSafeInteger(maxHeaderBytes) || maxHeaderBytes < 1024) {
    throw new TypeError('A Node HTTPS request function and a positive header limit are required.');
  }
  return async function httpsFetch(input, init = {}) {
    const url = input instanceof URL ? input : new URL(String(input));
    if (url.protocol !== 'https:') throw new GeminiClientError('HTTPS_REQUIRED', 'The direct HTTP transport only accepts HTTPS URLs.');
    const method = String(init.method || 'GET').toUpperCase();
    if (!['GET', 'POST'].includes(method)) throw new GeminiClientError('METHOD_UNSUPPORTED', 'The direct HTTP transport received an unsupported method.');
    return await new Promise((resolve, reject) => {
      let settled = false;
      const failOnce = (error) => {
        if (settled) return;
        settled = true;
        reject(new GeminiClientError('TRANSPORT_FAILED', 'The observed Gemini HTTPS request failed before a response was available.'));
      };
      let request;
      try {
        request = requestImpl(url, {
          method,
          headers: Object.fromEntries(new Headers(init.headers || {}).entries()),
          signal: init.signal,
          maxHeaderSize: maxHeaderBytes,
        }, (response) => {
          const headerBytes = countHeaderBytes(response.rawHeaders || []);
          if (headerBytes > maxHeaderBytes) {
            response.destroy();
            failOnce(new Error('response headers exceeded the local limit'));
            return;
          }
          settled = true;
          resolve({
            status: response.statusCode || 0,
            headers: incomingHeaders(response.rawHeaders || []),
            body: response,
            headerBytes,
          });
        });
      } catch {
        failOnce(new Error('request construction failed'));
        return;
      }
      request.on('error', failOnce);
      if (Number.isSafeInteger(init.timeoutMs) && init.timeoutMs > 0) {
        request.setTimeout(init.timeoutMs, () => request.destroy(new Error('timeout')));
      }
      if (init.body != null) request.write(init.body);
      request.end();
    });
  };
}

export const httpsFetch = createHttpsFetch();
