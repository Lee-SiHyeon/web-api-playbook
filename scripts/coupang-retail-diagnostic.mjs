import http2 from 'node:http2';
import { channel } from 'node:diagnostics_channel';
import { unzipSync, brotliDecompressSync } from 'node:zlib';
import { mkdir, open } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCoupangVisitorContext } from '../service-packs/affiliate/apps/affiliate-api-hub/lib/coupang-visitor-context.mjs';
import { readCoupangConsumerOfferList, readCoupangConsumerReviews } from '../service-packs/affiliate/apps/affiliate-api-hub/adapters/coupang-consumer.mjs';
import { readCoupangRetailSearch, readCoupangDocument } from '../lib/retail/coupang-public.mjs';

const ORIGIN = 'https://www.coupang.com', MAX = 6 * 1024 * 1024;
const productUrl = `${ORIGIN}/vp/products/6247736560?itemId=12646874013&vendorItemId=79914317500`;
const code = value => /^COUPANG_[A-Z0-9_]+$/.test(value ?? '') ? value : 'COUPANG_DIAGNOSTIC_FAILED';

// Native Node HTTP/2, with the actual native-fetch header set. No browser
// impersonation, proxy, TLS-option changes, browser cookies or fallback transport.
export async function nativeHttp2Read(url, init, capturedHeaders) {
  if (new URL(url).origin !== ORIGIN || init.method !== 'GET' || !capturedHeaders)
    throw Object.assign(new Error(), { code: 'COUPANG_HTTP2_INPUT' });
  return new Promise((resolve, reject) => {
    const u = new URL(url), session = http2.connect(u.origin);
    let done = false, stream;
    const finish = (error, result) => {
      if (done) return; done = true; clearTimeout(timer);
      stream?.close(); session.destroy(); error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => finish(Object.assign(new Error(), { code: 'COUPANG_HTTP2_TIMEOUT' })), 20000);
    session.on('error', () => finish(Object.assign(new Error(), { code: 'COUPANG_HTTP2_TRANSPORT' })));
    session.once('connect', () => {
      if (session.alpnProtocol !== 'h2') return finish(Object.assign(new Error(), { code: 'COUPANG_HTTP2_NOT_NEGOTIATED' }));
      const requestHeaders = { ...capturedHeaders, ...init.headers };
      for (const key of ['host','connection','upgrade','keep-alive','transfer-encoding','proxy-connection']) delete requestHeaders[key];
      stream = session.request({ ':method': 'GET', ':path': u.pathname + u.search, ...requestHeaders });
      let responseHeaders, bytes = 0; const chunks = [];
      stream.on('response', headers => { responseHeaders = headers; });
      stream.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX) return finish(Object.assign(new Error(), { code: 'COUPANG_HTTP2_RESPONSE_LIMIT' }));
        chunks.push(chunk);
      });
      stream.on('error', () => finish(Object.assign(new Error(), { code: 'COUPANG_HTTP2_STREAM' })));
      stream.on('end', () => {
        if (done) return;
        try {
          let body = Buffer.concat(chunks);
          const encoding = responseHeaders?.['content-encoding'];
          if (['gzip','deflate'].includes(encoding)) body = unzipSync(body, { maxOutputLength: MAX });
          else if (encoding === 'br') body = brotliDecompressSync(body, { maxOutputLength: MAX });
          else if (encoding && encoding !== 'identity') throw new Error();
          const headers = new Headers();
          for (const [key, value] of Object.entries(responseHeaders ?? {})) {
            if (key.startsWith(':') || ['content-encoding','content-length'].includes(key)) continue;
            for (const item of Array.isArray(value) ? value : [value]) headers.append(key, String(item));
          }
          finish(null, new Response(body, { status: Number(responseHeaders[':status']), headers }));
        } catch { finish(Object.assign(new Error(), { code: 'COUPANG_HTTP2_RESPONSE' })); }
      });
      stream.end();
    });
  });
}

/** Explicit diagnosis only. Normal collectors still stop on a rejected read. */
export async function runRetailDiagnostic({ baseFetch = globalThis.fetch, http2Read = nativeHttp2Read,
  sleep = delay, onProgress = () => {}, now = Date.now } = {}) {
  let active = '', firstVisitor = null, nativeSearchHeaders = null, networkRequests = 0, bootstrapRequests = 0;
  let identityPreserved = true;
  const report = { schema: 'coupang-retail-diagnostic-v1', checkedAt: new Date(now()).toISOString(),
    executionMode: 'pure_http_diagnostic', nativeNetwork: baseFetch === globalThis.fetch && http2Read === nativeHttp2Read,
    browserUsed: false, ownerCredentialUsed: false, visitorValuesPersisted: false, visitorContextCount: 1,
    rebootstrapAllowed: false, automaticRetry: false, explicitlyRequested403Comparison: true, writesSubmitted: 0,
    runs: [], stopped: null, unattempted: [], limitations: ['No RSC input values or browser-cookie replay are inferred.',
      'A Document 403 does not by itself establish a login requirement, quota, fingerprint cause or server cooldown.'] };
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    if (u.origin !== ORIGIN || init.method !== 'GET') throw new Error('scope');
    if (u.pathname.endsWith('/web-adapter/proxy')) {
      if (++bootstrapRequests !== 1) throw new Error('no visitor replacement');
    }
    const visitor = /(?:^|;\s*)PCID=([^;]+)/.exec(init.headers.cookie ?? '')?.[1] ?? null;
    if (visitor) { firstVisitor ??= visitor; identityPreserved &&= visitor === firstVisitor; }
    if (!identityPreserved) throw new Error('visitor changed');
    const options = { ...init, headers: { ...init.headers } };
    if (active === 'search_home_referer') options.headers.referer = `${ORIGIN}/`;
    if (active === 'search_native_http2') {
      if (!nativeSearchHeaders) throw Object.assign(new Error(), { code: 'COUPANG_HTTP2_HEADERS_UNOBSERVED' });
      networkRequests++; return http2Read(url, options, nativeSearchHeaders);
    }
    networkRequests++;
    return baseFetch(url, options);
  };
  const listener = message => {
    if (active !== 'search_sorted' || String(message.request.origin) !== ORIGIN || !message.request.path.startsWith('/np/search?')) return;
    const raw = message.request.headers;
    const entries = Array.isArray(raw) ? Array.from({ length: raw.length / 2 }, (_, i) => [raw[i*2], raw[i*2+1]])
      : String(raw).split('\r\n').filter(Boolean).map(line => { const at = line.indexOf(':'); return [line.slice(0,at),line.slice(at+1).trim()]; });
    nativeSearchHeaders = Object.fromEntries(entries.map(([k,v]) => [String(k).toLowerCase(),String(v)]));
  };
  const requests = channel('undici:request:create');
  requests.subscribe(listener);
  const visitorContext = createCoupangVisitorContext({ fetchImpl, allowRebootstrap: false, maxAgeMs: 1200000, now });
  const opts = { authentication: 'visitor', fetchImpl, visitorContext };
  const probes = [
    ['offer_control_before', 'Known public JSON control', () => readCoupangConsumerOfferList({ ...opts, url: productUrl })],
    ['search_sorted', 'Add observed salePriceAsc sort only', () => readCoupangRetailSearch('무선 마우스', { ...opts, sorter: 'salePriceAsc' })],
    ['search_free_delivery', 'Add observed free-delivery field group to sorted search', () => readCoupangRetailSearch('무선 마우스', { ...opts, sorter: 'salePriceAsc', freeDelivery: true })],
    ['search_home_referer', 'Default search plus observed Referer header name and public home source; header value is a hypothesis', () => readCoupangRetailSearch('무선 마우스', opts)],
    ['search_native_http2', 'Sorted search using native HTTP/2 with captured native-fetch headers', () => readCoupangRetailSearch('무선 마우스', { ...opts, sorter: 'salePriceAsc' })],
    ['category_default', 'Observed category Document without page query', () => readCoupangDocument(`${ORIGIN}/np/categories/178255`, opts)],
    ['category_page2', 'Add observed category page=2 only', () => readCoupangDocument(`${ORIGIN}/np/categories/178255?page=2`, opts)],
    ['offer_control_after', 'Same SKU and visitor control after Document denials', () => readCoupangConsumerOfferList({ ...opts, url: productUrl })],
    ['review_json', 'Existing observed public review JSON contract', () => readCoupangConsumerReviews({ ...opts, url: productUrl })],
  ];
  try {
    for (const [name, hypothesis, invoke] of probes) {
      active = name;
      let row;
      try {
        const result = await invoke(), receipt = result.receipt ?? result.request;
        row = { name, hypothesis, ok: true, receipt, count: result.count ?? result.reviews?.length ?? result.data?.products?.length,
          price: result.selectedOffer?.price ?? null, executionVerified: report.nativeNetwork };
      } catch (error) { row = { name, hypothesis, ok: false, code: code(error.code), receipt: error.receipt ?? null }; }
      row.transportKind = name === 'search_native_http2' ? 'node_native_http2' : 'node_native_fetch';
      report.runs.push(row); onProgress(row);
      const status = row.receipt?.status ?? row.receipt?.httpStatus;
      // The shared detector includes generic Access Denied titles. A deliberate
      // 403 comparison may advance to another named hypothesis after that denial,
      // but never to a challenge-solving flow or an unchanged retry.
      const strongChallenge = row.receipt?.interactiveChallengeSignal === true
        || status !== 403 && row.receipt?.challengeConfirmed === true;
      if (!identityPreserved || !row.ok && (name === 'offer_control_before' || [401,418,429].includes(status)
        || strongChallenge || row.code === 'COUPANG_VISITOR_CONTEXT_EXPIRED')) {
        report.stopped = name; break;
      }
      if (report.runs.length < probes.length) await sleep(1000);
    }
  } finally {
    requests.unsubscribe(listener); nativeSearchHeaders = null; firstVisitor = null;
  }
  report.unattempted = probes.slice(report.runs.length).map(([name]) => name);
  Object.assign(report, { networkRequests, bootstrapRequests, identityPreserved, endedAt: new Date(now()).toISOString() });
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), out = args.find(x => x.startsWith('--out='))?.slice(6);
  if (args.length !== 2 || !out || !args.includes('--compare-403')) throw new Error('USAGE_--compare-403_--out=NEW_FILE');
  await mkdir(path.dirname(out), { recursive: true });
  const file = await open(out, 'wx');
  try {
    const report = await runRetailDiagnostic({ onProgress: row => console.log(JSON.stringify({ name: row.name,
      ok: row.ok, code: row.code, status: row.receipt?.status ?? row.receipt?.httpStatus,
      server: row.receipt?.server, count: row.count })) });
    await file.writeFile(JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ output: out, probes: report.runs.length, networkRequests: report.networkRequests,
      bootstrapRequests: report.bootstrapRequests, identityPreserved: report.identityPreserved, stopped: report.stopped }));
  } finally { await file.close(); }
}
