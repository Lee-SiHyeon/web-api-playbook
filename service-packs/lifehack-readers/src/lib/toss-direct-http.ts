import { request as httpsRequest } from 'node:https';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';

const ORIGINS = new Set(['https://business.toss.im', 'https://business-accounts.toss.im',
  'https://oauth2.cert.toss.im', 'https://sharelink.toss.im', 'https://api-public.toss.im']);
type RequestFactory = (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;

/** Login-only Node HTTPS transport. Request bodies and cookies do not pass through Next fetch caching. */
export function createTossDirectHttpFetch(requestImpl: RequestFactory = httpsRequest): typeof fetch {
  return async (input, init = {}) => {
    const url = new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    if (!ORIGINS.has(url.origin) || url.username || url.password || url.hash || !['GET', 'POST'].includes(method)) {
      throw Error('TOSS_HTTP_TRANSPORT_SCOPE_REJECTED');
    }
    const headers = new Headers(init.headers);
    let bytes: Buffer | undefined;
    if (init.body != null) {
      if (typeof init.body === 'string' || init.body instanceof URLSearchParams) bytes = Buffer.from(init.body.toString());
      else if (init.body instanceof Uint8Array) bytes = Buffer.from(init.body);
      else if (init.body instanceof ArrayBuffer) bytes = Buffer.from(new Uint8Array(init.body));
      else if (init.body instanceof FormData) {
        const entries = [...init.body.entries()];
        if (entries.length !== 1 || entries[0][0] !== 'token' || typeof entries[0][1] !== 'string' || entries[0][1].length > 8192) {
          throw Error('TOSS_HTTP_TRANSPORT_BODY_REJECTED');
        }
        const encodingHeaders = new Headers(headers); encodingHeaders.delete('content-type');
        const encoded = new Request(url, { method, headers: encodingHeaders, body: init.body });
        bytes = Buffer.from(await encoded.arrayBuffer());
        headers.set('Content-Type', encoded.headers.get('content-type')!);
      }
      else throw Error('TOSS_HTTP_TRANSPORT_BODY_REJECTED');
    }
    if (bytes && (method !== 'POST' || bytes.length > 32768)) { bytes.fill(0); throw Error('TOSS_HTTP_TRANSPORT_BODY_REJECTED'); }
    headers.set('Accept-Encoding', 'identity');
    if (!headers.has('User-Agent')) headers.set('User-Agent',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36');
    if (bytes) headers.set('Content-Length', String(bytes.length));
    const signal = init.signal;
    if (signal?.aborted) { bytes?.fill(0); throw Error('TOSS_HTTP_TRANSPORT_ABORTED'); }
    return new Promise<Response>((resolve, reject) => {
      let incoming: IncomingMessage | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => { incoming?.destroy(); request.destroy(Error('TOSS_HTTP_TRANSPORT_ABORTED')); };
      const cleanup = () => { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', abort); bytes?.fill(0); };
      const request = requestImpl(url, { method, headers: Object.fromEntries(headers) }, response => {
        incoming = response;
        const chunks: Buffer[] = []; let size = 0;
        response.on('data', (part: Buffer) => {
          const chunk = Buffer.from(part); size += chunk.length;
          if (size > 2 * 1024 * 1024) { chunk.fill(0); response.destroy(); request.destroy(Error('TOSS_HTTP_TRANSPORT_RESPONSE_LIMIT')); }
          else chunks.push(chunk);
        });
        response.once('error', () => { chunks.forEach(x => x.fill(0)); cleanup(); reject(Error('TOSS_HTTP_TRANSPORT_RESPONSE_FAILED')); });
        response.once('end', () => {
          cleanup();
          const resultHeaders = new Headers();
          for (let i = 0; i < response.rawHeaders.length; i += 2) resultHeaders.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
          const body = Buffer.concat(chunks); chunks.forEach(x => x.fill(0));
          const status = response.statusCode ?? 502;
          try { resolve(new Response([204, 205, 304].includes(status) ? null : body, { status, headers: resultHeaders })); }
          catch { body.fill(0); reject(Error('TOSS_HTTP_TRANSPORT_RESPONSE_FAILED')); }
        });
      });
      request.once('error', () => { cleanup(); reject(Error('TOSS_HTTP_TRANSPORT_REQUEST_FAILED')); });
      timer = setTimeout(abort, 15000);
      signal?.addEventListener('abort', abort, { once: true });
      request.end(bytes, () => bytes?.fill(0));
    });
  };
}

export const tossDirectHttpFetch = createTossDirectHttpFetch();

/** Keep one wire transport for Vercel authentication and subsequent session use. */
export const tossRuntimeHttpFetch: typeof fetch = (input, init) =>
  process.env.VERCEL === '1' && process.env.NODE_ENV === 'production'
    ? tossDirectHttpFetch(input, init) : fetch(input, init);
