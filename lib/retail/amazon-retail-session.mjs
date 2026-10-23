import path from 'node:path';
import { createHash } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { CookieJar } from 'tough-cookie';
import { ScopedSession } from '../scoped-session.mjs';
import { ProtectedStore } from '../protected-store.mjs';
import { withSessionLock } from '../session-lock.mjs';
import { parseAmazonProductDocument } from './amazon-product.mjs';
const ORIGIN = 'https://www.amazon.com';
export const AMAZON_RETAIL_STORE = 'amazon-retail-public-v1';
export const AMAZON_CONTEXT_LIMIT_MS = 6 * 60 * 60 * 1000; // Local bound, not a server TTL.
const names = new Set(['aws-waf-token','session-id','session-id-time','sst-main','i18n-prefs','lc-main','sp-cdn','ubid-main','skin','rxc','session-token','cmc','csm-hit']);
const fail = (code, receipt) => { throw Object.assign(new Error(code), { code, ...(receipt ? { receipt } : {}) }); };
const schema = 'amazon-retail-public-session-v1';
function validate(state) {
  const age = Date.now() - Date.parse(state?.capturedAt);
  if (state?.schema !== schema || !Number.isFinite(age) || age < -1000 || age > AMAZON_CONTEXT_LIMIT_MS) fail('AMAZON_RETAIL_REBOOTSTRAP_REQUIRED');
  const s = state.session;
  if (JSON.stringify(s?.allowedOrigins) !== JSON.stringify([ORIGIN]) || JSON.stringify(s.cookieOrigins) !== JSON.stringify([ORIGIN])
    || s.allowLoopbackHttp !== false || s.maxRedirects !== 0 || Object.keys(s.defaultHeaders ?? {}).length
    || Object.keys(s.headersByOrigin ?? {}).length || !Array.isArray(s.cookieJar?.cookies) || s.cookieJar.cookies.length > 30) fail('AMAZON_RETAIL_SESSION_SCOPE');
  for (const c of s.cookieJar.cookies) if (!names.has(c.key) || !['amazon.com','www.amazon.com'].includes(c.domain) || c.path !== '/') fail('AMAZON_RETAIL_COOKIE_SCOPE');
  ScopedSession.fromJSON(s);
  if (!CookieJar.deserializeSync(s.cookieJar).getCookiesSync(ORIGIN).some(c => c.key === 'session-id')) fail('AMAZON_RETAIL_SESSION_MISSING');
  if (state.lastFailure) fail('AMAZON_RETAIL_SESSION_REJECTED');
  return state;
}
export async function importAmazonRetailSession(envelope, { store = new ProtectedStore() } = {}) {
  const age = Date.now() - Date.parse(envelope?.capturedAt);
  if (!Number.isFinite(age) || age < 0 || age > 30 * 60 * 1000 || envelope.origin !== ORIGIN
    || envelope.responseStatus !== 200 || !Array.isArray(envelope.cookies) || envelope.cookies.length > 40) fail('AMAZON_RETAIL_IMPORT_INVALID');
  if (envelope.cookies.some(c => !names.has(c.name))) fail('AMAZON_RETAIL_COOKIE_SCOPE');
  const session = new ScopedSession({ allowedOrigins: [ORIGIN], cookieOrigins: [ORIGIN], cookies: envelope.cookies,
    timeoutMs: 20000, maxResponseBytes: 4*1024*1024, maxRedirects: 0 });
  const state = validate({ schema, capturedAt: envelope.capturedAt, session: session.toJSON(), lastSuccessfulReadAt: null, lastFailure: null });
  return withSessionLock(() => store.write(AMAZON_RETAIL_STORE, JSON.stringify(state)), { root: path.join(store.directory,'locks'), key: AMAZON_RETAIL_STORE });
}
export function amazonRetailStatus({ store = new ProtectedStore() } = {}) {
  const storage = store.status(AMAZON_RETAIL_STORE);
  if (!storage.available) return { storage, ready: false, liveCheckPerformed: false };
  try { const state = validate(JSON.parse(store.read(AMAZON_RETAIL_STORE))); return { storage, ready: true,
    capturedAt: state.capturedAt, lastSuccessfulReadAt: state.lastSuccessfulReadAt, localContextLimitMs: AMAZON_CONTEXT_LIMIT_MS,
    sessionRenewalVerified: false, liveCheckPerformed: false }; }
  catch (e) { return { storage, ready: false, code: /^[A-Z_]+$/.test(e?.code??'')?e.code:'AMAZON_RETAIL_STATE_INVALID', liveCheckPerformed: false }; }
}
export async function getAmazonProduct({ asin, store = new ProtectedStore(), fetchImpl = globalThis.fetch } = {}) {
  if (!/^[A-Z0-9]{10}$/.test(asin ?? '')) fail('AMAZON_PRODUCT_INPUT_INVALID');
  return withSessionLock(async () => {
    const raw = store.read(AMAZON_RETAIL_STORE); if (!raw) fail('AMAZON_RETAIL_SESSION_MISSING');
    let state; try { state = JSON.parse(raw); } catch { fail('AMAZON_RETAIL_STATE_INVALID'); }
    validate(state);
    const url = `${ORIGIN}/-/ko/dp/${asin}/`;
    const expected = CookieJar.deserializeSync(state.session.cookieJar).getCookieStringSync(url);
    const receipt = { checkedAt: new Date().toISOString(), method: 'GET', origin: ORIGIN, path: new URL(url).pathname,
      browserUsed: false, cookieSent: Boolean(expected), credentialsUsed: Boolean(expected), readOnly: true,
      credentialProvider: 'protected_store', cookieHeaderMatchedOnWire: false, sessionRenewalVerified: false };
    const dc = channel('undici:request:create');
    const listener = ({ request }) => {
      if (String(request.origin) !== ORIGIN || request.path !== new URL(url).pathname) return;
      const h = request.headers;
      const entries = Array.isArray(h) ? Array.from({length:h.length/2},(_,i)=>[h[i*2],h[i*2+1]])
        : String(h).split('\r\n').filter(Boolean).map(s=>{const p=s.indexOf(':');return [s.slice(0,p),s.slice(p+1).trim()];});
      receipt.cookieHeaderMatchedOnWire = entries.some(([k,v]) => String(k).toLowerCase()==='cookie' && v===expected);
    };
    const session = ScopedSession.fromJSON(state.session, { fetchImpl });
    dc.subscribe(listener);
    try {
      const response = await session.request(url, { headers: { accept: 'text/html' }, onCookiesApplied: event => {
        for (const c of event.cookies) if (!names.has(c.key) || !['amazon.com','www.amazon.com'].includes(c.domain) || c.path !== '/') fail('AMAZON_RETAIL_RESPONSE_COOKIE_SCOPE');
      } });
      Object.assign(receipt, { httpStatus: response.status, mime: response.headers['content-type']?.split(';')[0] ?? '',
        responseBytes: Buffer.byteLength(response.raw), responseSha256: createHash('sha256').update(response.raw).digest('hex') });
      if (response.status !== 200 || receipt.mime !== 'text/html') fail('AMAZON_PRODUCT_HTTP_FAILED');
      const data = parseAmazonProductDocument(response.raw, { asin });
      state.session = session.toJSON(); state.lastSuccessfulReadAt = receipt.checkedAt;
      validate(state); store.write(AMAZON_RETAIL_STORE, JSON.stringify(state));
      return { ...data, transport: 'session_document_http', receipt: { ...receipt, schemaVerified: true,
        expectedResultVerified: true, credentialPropagated: fetchImpl === globalThis.fetch ? receipt.cookieHeaderMatchedOnWire : false,
        initialBootstrap: 'browser_observed_public_session', authenticationVerified: false, sessionPersisted: true } };
    } catch (error) {
      if (['AMAZON_PRODUCT_CHALLENGE','AMAZON_PRODUCT_HTTP_FAILED','AMAZON_RETAIL_SESSION_MISSING','SCOPED_SESSION_REDIRECT_LIMIT'].includes(error.code)) {
        state.session = session.toJSON(); state.lastFailure = { code: error.code, checkedAt: receipt.checkedAt };
        store.write(AMAZON_RETAIL_STORE, JSON.stringify(state));
      }
      fail(/^[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'AMAZON_RETAIL_READ_FAILED', receipt);
    } finally { dc.unsubscribe(listener); }
  }, { root: path.join(store.directory,'locks'), key: AMAZON_RETAIL_STORE });
}
