import { webcrypto, createHash } from 'node:crypto';
import { JSDOM, ResourceLoader, VirtualConsole } from 'jsdom';

// Anonymous compatibility probe: original Naver SDK, Node web primitives, jsdom.
// No browser engine, account password, saved cookies, fingerprint patches, or writes.
export const NAVER_NODE_USER_AGENT = `Node.js/${process.versions.node} jsdom/26.1.0 NaverLoginHttpClient/1.0`;

export async function issueNaverLoginToken({ pageUrl = 'https://nid.naver.com/nidlogin.login?mode=form', sdk } = {}) {
const sourceUrl = new URL(pageUrl);
if (sourceUrl.origin !== 'https://nid.naver.com' || sourceUrl.pathname !== '/nidlogin.login'
  || sourceUrl.username || sourceUrl.password) throw new Error('LOGIN_TOKEN_PAGE_SCOPE');
if (sdk) {
  const loaderUrl = new URL(sdk.loaderUrl);
  if (loaderUrl.origin !== 'https://ncpt.naver.com' || loaderUrl.pathname !== '/static/ncaptcha-api.js'
    || loaderUrl.username || loaderUrl.password || typeof sdk.siteKey !== 'string'
    || sdk.siteKey.length < 1 || sdk.siteKey.length > 512 || /[\r\n\0]/.test(sdk.siteKey)) throw new Error('LOGIN_TOKEN_SDK_SCOPE');
  if (sdk.keyboardIds && (!Array.isArray(sdk.keyboardIds) || sdk.keyboardIds.length > 4
    || new Set(sdk.keyboardIds).size !== sdk.keyboardIds.length
    || sdk.keyboardIds.some(id => !['id', 'pw', 'captcha', 'chptcha'].includes(id)))) throw new Error('LOGIN_TOKEN_SDK_SCOPE');
}
const userAgent = NAVER_NODE_USER_AGENT;
let token = null;
const receipt = {
  checkedAt: new Date().toISOString(), mode: 'node_sdk_http',
  browserEngineUsed: false, credentialsUsed: false, loginPostCount: 0,
  tokenPostCount: 0, sdkReady: false, callbackReceived: false,
  usableTokenReceived: false, resources: [], requests: [], diagnostics: [],
};

function safeMessage(value) {
  return String(value || '').replace(/https?:\/\/[^\s"'<>]+/g, text => {
    try { const url = new URL(text); return url.origin + url.pathname; } catch { return '<url>'; }
  }).replace(/[A-Za-z0-9_+/=-]{48,}/g, '<opaque>').slice(0, 250);
}
function diagnostic(error) {
  if (receipt.diagnostics.length < 16) receipt.diagnostics.push({
    type: safeMessage(error?.type || error?.name || 'runtime'),
    message: safeMessage(error?.message || error),
  });
}
function safeUrl(raw) {
  const url = new URL(raw, pageUrl);
  return { origin: url.origin, path: url.pathname, queryFieldNames: [...new Set(url.searchParams.keys())] };
}
function allowAsset(url) {
  return !url.username && !url.password && url.protocol === 'https:' && (
    (url.origin === 'https://ncpt.naver.com' && /^\/static\/ncaptcha-(?:api|adapter)\.js$/.test(url.pathname))
    || (url.origin === 'https://wtm.pstatic.net' && /^\/[a-f0-9]+\/[a-f0-9]+\.(?:js|wasm)$/.test(url.pathname))
  );
}
async function bytes(response, limit = 2 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.length;
    if (size > limit) throw new Error('PUBLIC_ASSET_SIZE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function asset(raw, options = {}) {
  const url = new URL(raw, pageUrl);
  if (!allowAsset(url) || (options.method && options.method !== 'GET')) throw new Error('PUBLIC_ASSET_SCOPE');
  const response = await fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { 'user-agent': userAgent } });
  const body = await bytes(response);
  receipt.resources.push({ ...safeUrl(url), status: response.status, bytes: body.length,
    sha256: createHash('sha256').update(body).digest('hex') });
  if (response.status !== 200) throw new Error('PUBLIC_ASSET_REJECTED');
  return new Response(body, { status: response.status, headers: response.headers });
}

class Loader extends ResourceLoader {
  constructor() { super({ userAgent }); }
  fetch(url) {
    if (!allowAsset(new URL(url))) { diagnostic('UNOBSERVED_RESOURCE_BLOCKED'); return null; }
    const promise = asset(url).then(response => response.arrayBuffer()).then(value => Buffer.from(value));
    promise.abort = () => {};
    return promise;
  }
}

let dom;
async function main() {
  let scriptTag;
  if (sdk) {
    const source = new JSDOM('');
    const script = source.window.document.createElement('script');
    const configuredLoader = new URL(sdk.loaderUrl);
    if (!configuredLoader.searchParams.has('ncaptcha-onload')) configuredLoader.searchParams.set('ncaptcha-onload', 'initNcaptcha');
    script.src = configuredLoader.href;
    scriptTag = script.outerHTML;
    source.window.close();
  } else {
  const response = await fetch(pageUrl, { redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { 'user-agent': userAgent, accept: 'text/html' } });
  if (response.status !== 200) throw new Error('LOGIN_PAGE_REJECTED');
  const source = new JSDOM((await bytes(response)).toString('utf8'), { url: pageUrl });
  const loader = [...source.window.document.scripts].find(script => {
    try { const url = new URL(script.src); return url.origin === 'https://ncpt.naver.com' && url.pathname === '/static/ncaptcha-api.js'; }
    catch { return false; }
  });
  if (!loader) throw new Error('SDK_SCRIPT_MISSING');
  scriptTag = loader.outerHTML;
  source.window.close();
  }
  let ready;
  const readyPromise = new Promise(resolve => { ready = resolve; });
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', diagnostic);
  const inputIds = sdk ? (sdk.keyboardIds || ['captcha', 'chptcha']) : ['id', 'pw'];
  dom = new JSDOM(`<!doctype html><html><head></head><body>${inputIds.map(id => `<input id="${id}">`).join('')}${scriptTag}</body></html>`, {
    url: pageUrl, runScripts: 'dangerously', resources: new Loader(), virtualConsole,
    beforeParse(window) {
      window.TextEncoder = TextEncoder;
      window.TextDecoder = TextDecoder;
      window.Response = Response;
      window.Request = Request;
      window.Headers = Headers;
      window.fetch = asset;
      Object.defineProperty(window.crypto, 'subtle', { value: webcrypto.subtle });
      window.initNcaptcha = () => {
        try {
          if (receipt.sdkReady) return;
          window.wtmncapt = new window.homz.Koop({ keyboard: inputIds.map(id => ({ id })), ...(sdk ? { siteKey: sdk.siteKey } : {}) });
          receipt.sdkReady = true;
          ready(true);
        } catch (error) { diagnostic(error); ready(false); }
      };
      window.initNcaptchaRcaptcha = window.initNcaptcha;
      window.init_js_captcha = window.initNcaptcha;
      const XHR = window.XMLHttpRequest;
      const open = XHR.prototype.open;
      const send = XHR.prototype.send;
      const setHeader = XHR.prototype.setRequestHeader;
      XHR.prototype.open = function (method, raw, ...rest) {
        const url = new URL(raw, pageUrl);
        this.__probeUrl = url;
        this.__probeMethod = String(method).toUpperCase();
        this.__probeAllowed = this.__probeMethod === 'POST' && url.origin === 'https://ncpt.naver.com' && url.pathname === '/v2/tokens';
        if (!this.__probeAllowed) { diagnostic('UNOBSERVED_XHR_BLOCKED'); throw new Error('XHR_SCOPE'); }
        return open.call(this, method, url.href, ...rest);
      };
      XHR.prototype.setRequestHeader = function (name, value) {
        if (String(name).toLowerCase() === 'content-type') this.__probeContentType = value;
        return setHeader.call(this, name, value);
      };
      XHR.prototype.send = function (body) {
        if (!this.__probeAllowed || receipt.tokenPostCount >= 1) throw new Error('XHR_SCOPE_OR_COUNT');
        receipt.tokenPostCount += 1;
        const event = { ...safeUrl(this.__probeUrl), method: this.__probeMethod,
          contentType: this.__probeContentType || null, bodyType: typeof body,
          bodyBytes: typeof body === 'string' ? Buffer.byteLength(body) : null };
        receipt.requests.push(event);
        this.addEventListener('loadend', () => {
          event.status = this.status;
          try { const parsed = JSON.parse(this.responseText); event.responseKeys = Object.keys(parsed);
            event.tokenIdPresent = typeof parsed.tokenId === 'string' && parsed.tokenId.length > 0; }
          catch { event.json = false; }
        });
        return send.call(this, body);
      };
    },
  });
  let initTimer;
  const initialized = await Promise.race([readyPromise, new Promise(resolve => { initTimer = setTimeout(() => resolve(false), 20000); })]);
  clearTimeout(initTimer);
  if (!initialized) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => { receipt.callbackTimedOut = true; resolve(); }, 5000);
    try {
      dom.window.wtmncapt.f(value => {
        clearTimeout(timer);
        receipt.callbackReceived = true;
        receipt.callbackType = typeof value;
        receipt.usableTokenReceived = typeof value === 'string' && value.length > 0 && !/^(?:timeout|error\d*\|)/i.test(value);
        receipt.callbackLength = typeof value === 'string' ? value.length : null;
        if (receipt.usableTokenReceived) token = value;
        if (!receipt.usableTokenReceived) receipt.callbackFailure = safeMessage(value);
        resolve();
      });
    } catch (error) { clearTimeout(timer); diagnostic(error); resolve(); }
  });
}

try { await main(); } catch (error) { diagnostic(error); }
finally { dom?.window.close(); }
receipt.serverTokenReceived = receipt.requests.some(request => request.status === 200 && request.tokenIdPresent === true);
if (!receipt.serverTokenReceived) { token = null; receipt.usableTokenReceived = false; }
return { token, receipt };
}
