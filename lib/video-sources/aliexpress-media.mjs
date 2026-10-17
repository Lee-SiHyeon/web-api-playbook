import { ScopedSession } from '../scoped-session.mjs';
import { ProtectedStore } from '../protected-store.mjs';
import { createCdpPageFetcher } from './cdp-cookies.mjs';
import { classifyMtopRet, mtopRetSummary, mtopSign, mtopToken, parseMtopBody } from './mtop-h5.mjs';

// Product media (seller video, gallery images, title, store signals) from the AliExpress PC PDP payload.
// Observed 2026-10-17: GET acs.aliexpress.com/h5/mtop.aliexpress.pdp.pc.query/1.0/ (appKey 12574478, jsv 2.5.1).
// Anonymous browser-free calls hit FAIL_SYS_USER_VALIDATE (2026-10-15), so the client replays a cookie bundle
// issued to a real browser profile (imported once, stored with ProtectedStore) and never solves a challenge.

export const ALIEXPRESS_SESSION_STORE = 'aliexpress-browser-session-v1';
const SITE = 'https://ko.aliexpress.com';
const ACS = 'https://acs.aliexpress.com';
const API = 'mtop.aliexpress.pdp.pc.query';
const APP_KEY = '12574478';
const PRODUCT_ID = /^[0-9]{8,20}$/;
const COOKIE_DOMAIN = /^\.?([a-z0-9-]+\.)*aliexpress\.com$/i;
const VIDEO_HOST = 'video.aliexpress-media.com';
const IMAGE_HOST = /^ae-pic-[a-z0-9]+\.aliexpress-media\.com$/;
const REQUIRED_COOKIES = ['_m_h5_tk', '_m_h5_tk_enc', 'cna'];

export class AliExpressMediaError extends Error {
  constructor(code, receipt = null) { super(code); this.name = 'AliExpressMediaError'; this.code = code; this.receipt = receipt; }
}
const fail = (code, receipt) => { throw new AliExpressMediaError(code, receipt); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function httpsUrl(raw, hostTest) {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  try {
    const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return hostTest(url.hostname) ? url.href : null;
  } catch { return null; }
}

/** Keep only first-party AliExpress cookies from a browser export and require the MTOP token pair plus `cna`. */
export function createAliExpressSessionState(cookies, { userAgent, importedAt = new Date().toISOString(), source = 'cdp' } = {}) {
  if (!Array.isArray(cookies) || cookies.length > 400) fail('ALIEXPRESS_SESSION_INPUT_INVALID');
  if (typeof userAgent !== 'string' || userAgent.length < 20 || userAgent.length > 512 || /[\r\n]/.test(userAgent)) fail('ALIEXPRESS_SESSION_UA_INVALID');
  const kept = cookies.filter(c => object(c) && typeof c.name === 'string' && typeof c.value === 'string'
    && typeof c.domain === 'string' && COOKIE_DOMAIN.test(c.domain) && !/[\r\n;]/.test(c.value))
    .map(c => ({ name: c.name, value: c.value, domain: c.domain, path: typeof c.path === 'string' && c.path.startsWith('/') ? c.path : '/',
      secure: c.secure === true, httpOnly: c.httpOnly === true,
      ...(typeof c.expires === 'number' && c.expires > 0 ? { expires: c.expires } : {}) }));
  const names = new Set(kept.map(c => c.name));
  const missing = REQUIRED_COOKIES.filter(name => !names.has(name));
  if (missing.length) fail('ALIEXPRESS_SESSION_COOKIES_MISSING', { missing });
  if (!mtopToken(kept.find(c => c.name === '_m_h5_tk').value)) fail('ALIEXPRESS_SESSION_TOKEN_INVALID');
  return { version: 1, source, importedAt, userAgent, cookies: kept };
}

export function importAliExpressSession(state, { store = new ProtectedStore() } = {}) {
  const valid = createAliExpressSessionState(state.cookies, state);
  return { ...store.write(ALIEXPRESS_SESSION_STORE, JSON.stringify(valid)), cookieCount: valid.cookies.length, importedAt: valid.importedAt };
}

export function aliExpressSessionStatus({ store = new ProtectedStore(), now = Date.now } = {}) {
  const raw = store.read(ALIEXPRESS_SESSION_STORE);
  if (!raw) return { stored: false };
  const state = JSON.parse(raw);
  const tokenCookie = state.cookies.find(c => c.name === '_m_h5_tk');
  const tokenExpiresAt = tokenCookie?.expires ? new Date(tokenCookie.expires * 1000).toISOString() : null;
  return { stored: true, importedAt: state.importedAt, cookieCount: state.cookies.length, tokenExpiresAt,
    tokenExpired: tokenCookie?.expires ? tokenCookie.expires * 1000 <= now() : null };
}

/** Pure parser over `data.result` of mtop.aliexpress.pdp.pc.query. */
export function parseAliExpressPdpMedia(result, productId) {
  if (!object(result)) fail('ALIEXPRESS_PDP_SCHEMA_INVALID');
  const header = object(result.HEADER_IMAGE_PC) ? result.HEADER_IMAGE_PC : {};
  const images = [...new Set((Array.isArray(header.imagePathList) ? header.imagePathList : [])
    .map(u => httpsUrl(u, host => IMAGE_HOST.test(host))).filter(Boolean))].slice(0, 30);
  let video = null;
  const pv = header.productVideo;
  if (object(pv)) {
    const play = object(pv.videoPlayInfo) ? pv.videoPlayInfo : {};
    const playUrl = httpsUrl(play.webUrl ?? play.androidPhoneUrl ?? play.iphoneUrl, host => host === VIDEO_HOST);
    const videoId = typeof pv.videoId === 'number' || typeof pv.videoId === 'string' ? String(pv.videoId) : null;
    if (playUrl && videoId && /^\d{6,24}$/.test(videoId)) {
      const uploader = /\/play\/u\/[a-z_]+\/(\d{4,24})\//.exec(new URL(playUrl).pathname)?.[1] ?? null;
      video = { videoId, playUrl, posterUrl: httpsUrl(pv.posterUrl, host => IMAGE_HOST.test(host)), uploaderAccountId: uploader,
        kind: 'seller_product_video' };
    }
  }
  const title = typeof result.PRODUCT_TITLE?.text === 'string' ? result.PRODUCT_TITLE.text.replace(/\s+/g, ' ').trim().slice(0, 500) || null : null;
  const shop = object(result.SHOP_CARD_PC) ? result.SHOP_CARD_PC : {};
  const storeNum = /[?&]storeNum=(\d{3,20})/.exec(shop.licenseInfo?.actionTarget ?? '')?.[1] ?? null;
  const signals = (Array.isArray(shop.benefitInfoList) ? shop.benefitInfoList : [])
    .filter(item => typeof item?.title === 'string' && typeof item?.value === 'string')
    .map(item => ({ label: item.title.replace(/\s+/g, ' ').trim().slice(0, 80), value: item.value.slice(0, 40) })).slice(0, 6);
  return { productId, productUrl: `${SITE}/item/${productId}.html`, title, video, images,
    store: { storeNum, signals }, hasVideo: video !== null };
}

function pdpData({ productId, locale, currency, country }) {
  return JSON.stringify({ productId, _lang: locale, _currency: currency, country, province: '', city: '', channel: '',
    pdp_ext_f: '', pdpNPI: '', sourceType: '', clientType: 'pc',
    ext: JSON.stringify({ foreverRandomToken: '', site: 'kor', crawler: false, 'x-m-biz-bx-region': '', signedIn: false, host: 'ko.aliexpress.com' }) });
}

function signedUrl({ token, t, data }) {
  const url = new URL(`${ACS}/h5/${API}/1.0/`);
  url.search = new URLSearchParams({ jsv: '2.5.1', appKey: APP_KEY, t, sign: mtopSign({ token, t, appKey: APP_KEY, data }), api: API,
    type: 'originaljson', v: '1.0', timeout: '15000', dataType: 'json', data }).toString();
  return url.href;
}

/** Browser transport: the signed GET runs inside an existing ko.aliexpress.com tab of the automation profile. */
export function aliExpressBrowserTransport({ cdpEndpoint = 'http://127.0.0.1:9333', createFetcher = createCdpPageFetcher } = {}) {
  const fetcher = createFetcher({ endpoint: cdpEndpoint, pageOrigin: SITE, openUrl: `${SITE}/`, allowedRequestOrigins: [ACS] });
  return {
    kind: 'browser_tab_fetch',
    async token() { return mtopToken((await fetcher.cookies([`${ACS}/`])).find(c => c.name === '_m_h5_tk')?.value); },
    async send(url) { const r = await fetcher.fetchText(url); return { status: r.status, raw: r.text }; },
    async afterSuccess() {},
  };
}

/** HTTP transport: replays a stored browser cookie bundle from Node. Observed to be challenged after 1-2 calls. */
export function aliExpressHttpTransport({ store = new ProtectedStore(), fetchImpl, persistRotation = true } = {}) {
  const raw = store.read(ALIEXPRESS_SESSION_STORE);
  if (!raw) fail('ALIEXPRESS_SESSION_MISSING');
  let parsed; try { parsed = JSON.parse(raw); } catch { fail('ALIEXPRESS_SESSION_INVALID'); }
  const state = createAliExpressSessionState(parsed.cookies, parsed);
  const host = new URL(ACS).hostname;
  const session = new ScopedSession({
    allowedOrigins: [ACS], cookieOrigins: [ACS],
    cookies: state.cookies.filter(c => c.domain.startsWith('.') ? host.endsWith(c.domain.slice(1).toLowerCase()) : c.domain.toLowerCase() === host),
    ...(fetchImpl ? { fetchImpl } : {}),
    defaultHeaders: { accept: 'application/json', 'user-agent': state.userAgent, 'accept-language': 'ko-KR,ko;q=0.9,en;q=0.8' },
    timeoutMs: 20_000, maxResponseBytes: 2 * 1024 * 1024, maxRequestBytes: 8 * 1024, maxRedirects: 0,
  });
  const jar = () => session.toJSON().cookieJar?.cookies ?? [];
  return {
    kind: 'stored_session_http',
    async token() { return mtopToken(jar().find(c => c.key === '_m_h5_tk')?.value) || mtopToken(state.cookies.find(c => c.name === '_m_h5_tk').value); },
    async send(url, { referer }) {
      try { const r = await session.request(url, { headers: { referer, origin: SITE } }); return { status: r.status, raw: r.raw }; }
      catch (error) { fail(error?.code === 'SCOPED_SESSION_TIMEOUT' ? 'ALIEXPRESS_TIMEOUT' : 'ALIEXPRESS_TRANSPORT_FAILED'); }
    },
    async afterSuccess() {
      if (!persistRotation) return;
      const rotated = jar().map(c => ({ name: c.key, value: c.value ?? '', domain: c.hostOnly ? c.domain : `.${c.domain}`, path: c.path ?? '/',
        secure: c.secure === true, httpOnly: c.httpOnly === true,
        ...(c.expires && c.expires !== 'Infinity' ? { expires: Math.floor(new Date(c.expires).getTime() / 1000) } : {}) }));
      try { store.write(ALIEXPRESS_SESSION_STORE, JSON.stringify(createAliExpressSessionState(rotated, { ...state }))); } catch {}
    },
  };
}

export function createAliExpressMediaClient({ transport, now = Date.now, minIntervalMs = 2500 } = {}) {
  const channel = transport ?? aliExpressBrowserTransport();
  let lastSentAt = 0;
  return {
    transportKind: channel.kind,
    async getProductMedia({ productId, locale = 'ko_KR', currency = 'KRW', country = 'KR' } = {}) {
      if (typeof productId !== 'string' || !PRODUCT_ID.test(productId)) fail('ALIEXPRESS_INPUT_INVALID');
      if (!/^[a-z]{2}_[A-Z]{2}$/.test(locale) || !/^[A-Z]{3}$/.test(currency) || !/^[A-Z]{2}$/.test(country)) fail('ALIEXPRESS_INPUT_INVALID');
      const data = pdpData({ productId, locale, currency, country });
      const receipt = { method: 'GET', origin: ACS, path: `/h5/${API}/1.0/`, api: API, appKey: APP_KEY, transport: channel.kind,
        checkedAt: new Date(now()).toISOString(), attempts: [] };
      for (let attempt = 0; attempt < 2; attempt++) {
        const wait = lastSentAt + minIntervalMs - now();
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        const token = await channel.token();
        if (!token) fail('ALIEXPRESS_TOKEN_MISSING', receipt);
        lastSentAt = now();
        const response = await channel.send(signedUrl({ token, t: String(now()), data }), { referer: `${SITE}/item/${productId}.html` });
        const body = parseMtopBody(response.raw);
        const verdict = classifyMtopRet(body?.ret);
        receipt.attempts.push({ httpStatus: response.status, ret: mtopRetSummary(body?.ret), verdict, responseBytes: Buffer.byteLength(response.raw ?? '') });
        if (response.status === 429) fail('ALIEXPRESS_THROTTLED', receipt);
        if (response.status !== 200 || !body) fail('ALIEXPRESS_RESPONSE_INVALID', receipt);
        if (verdict === 'token_refresh' && attempt === 0) continue; // gateway rotated _m_h5_tk; re-sign once
        if (verdict === 'challenge') fail('ALIEXPRESS_CHALLENGE_REQUIRED', receipt); // never solve; a person must clear it in the browser
        if (verdict !== 'success') fail(verdict === 'token_refresh' || verdict === 'session_expired' ? 'ALIEXPRESS_SESSION_EXPIRED' : 'ALIEXPRESS_MTOP_FAILED', receipt);
        const media = parseAliExpressPdpMedia(body?.data?.result, productId);
        await channel.afterSuccess();
        return { ...media, receipt: { ...receipt, schemaVerified: true } };
      }
      fail('ALIEXPRESS_MTOP_FAILED', receipt);
    },
  };
}
