import { ApiError, BLOG_ID } from '../../scripts/client.mjs';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { SessionClient, selectCookieHeader } from '../../scripts/session-client.mjs';

export const ADMIN_ROOT = `https://admin.blog.naver.com/${BLOG_ID}`;
export const AUTH_ORIGINS = Object.freeze([
  'https://admin.blog.naver.com', 'https://blog.naver.com', 'https://blog.stat.naver.com',
]);

export function credentialHeader(cookies, raw, now = Date.now()) {
  return selectCookieHeader(cookies, raw, now);
}

export function classifyAuthPage({ text = '', inputNames = [], cookieNames = [], origin = '' }) {
  if (inputNames.some(x => /captcha|autoinput/i.test(x)) || /자동\s*입력\s*방지|보이는\s*문자|보안\s*문자|CAPTCHA/i.test(text)) return 'captcha_required';
  if (/2단계\s*인증|인증\s*알림을|인증\s*요청을\s*보냈|일회용\s*인증번호|인증번호를\s*입력/.test(text)) return 'additional_verification_required';
  if (/보호조치가|이용이\s*제한|로그인이\s*제한|비정상적인\s*로그인/.test(text)) return 'account_protection';
  if (/아이디\s*또는\s*비밀번호|비밀번호가\s*일치하지|비밀번호를\s*다시\s*확인/.test(text)) return 'credentials_rejected';
  if (['NID_AUT', 'NID_SES'].every(n => cookieNames.includes(n)) && AUTH_ORIGINS.includes(origin)) return 'session_issued_unverified';
  return 'login_pending';
}

export function classifyBrowserOpenError(error) {
  const message = String(error?.message || '');
  if (/executable.*(?:does not exist|doesn.?t exist|not found)|ENOENT/i.test(message)) {
    return new ApiError('BROWSER_RUNTIME_MISSING', 'Playwright Chromium is missing. Run npm run setup:browser and retry');
  }
  if (/net::ERR_(?:NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|CONNECTION|TIMED_OUT)/i.test(message)) {
    return new ApiError('NAVIGATION_NETWORK', 'Could not reach the Naver login page; check the PC network and retry');
  }
  if (/net::ERR_CERT/i.test(message)) {
    return new ApiError('NAVIGATION_CERTIFICATE', 'The Naver login page certificate could not be verified on this PC');
  }
  return new ApiError('BROWSER_OPEN_FAILED', 'Could not open the Naver login page; browser details were omitted');
}

export class HeadlessAuth {
  constructor({ loadChromium = async () => (await import('playwright')).chromium, headless = true } = {}) {
    this.browser = null; this.context = null; this.page = null; this.submitted = false; this.cookies = [];
    this.stage = 'not_started'; this.loadChromium = loadChromium; this.headless = headless;
  }
  async open() {
    if (this.browser) return this.status();
    // Do not enable tracing, HAR, screenshots, or verbose Playwright logging.
    if (process.env.DEBUG || process.env.PWDEBUG) throw new ApiError('DEBUG_UNSAFE', 'Disable debug logging before credential input');
    try {
      const chromium = await this.loadChromium();
      if (!chromium || typeof chromium.launch !== 'function' || typeof chromium.executablePath !== 'function'
        || !existsSync(chromium.executablePath())) {
        throw new ApiError('BROWSER_RUNTIME_MISSING', 'Playwright Chromium is missing. Run npm run setup:browser and retry');
      }
      this.browser = await chromium.launch({ headless: this.headless, timeout: 20000 });
      this.context = await this.browser.newContext({ locale: 'ko-KR', timezoneId: 'Asia/Seoul', acceptDownloads: false });
      this.page = await this.context.newPage();
      this.page.setDefaultTimeout(12000);
      this.page.setDefaultNavigationTimeout(20000);
      await this.page.goto(ADMIN_ROOT, { waitUntil: 'domcontentloaded' });
      this.stage = 'login_page_open';
      return this.status();
    } catch (error) {
      const browser = this.browser;
      this.browser = null; this.context = null; this.page = null; this.cookies = []; this.stage = 'open_failed';
      try { await browser?.close(); } catch {}
      if (error instanceof ApiError) throw error;
      throw classifyBrowserOpenError(error);
    }
  }
  async status() {
    if (!this.page || this.page.isClosed()) return { stage: this.stage, browserOpen: false, headless: this.headless };
    const url = new URL(this.page.url());
    const visible = await this.page.locator('body').evaluate(body => {
      const seen = el => Boolean(el.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden';
      return { text: body.innerText, inputs: [...body.querySelectorAll('input')].filter(seen).map(el => ({ id: el.id, name: el.name, type: el.type })),
        buttons: [...body.querySelectorAll('button,input[type=submit]')].filter(seen).map(el => ({ id: el.id, type: el.type, label: (el.tagName === 'INPUT' ? '' : el.innerText).trim().slice(0, 80) })) };
    });
    const cookies = await this.context.cookies(AUTH_ORIGINS);
    const classification = classifyAuthPage({ text: visible.text, inputNames: visible.inputs.map(x => x.name || x.id), cookieNames: cookies.map(c => c.name), origin: url.origin });
    return { stage: this.stage, classification, page: url.origin + url.pathname, inputs: visible.inputs, buttons: visible.buttons,
      authCookieNamesPresent: ['NID_AUT', 'NID_SES'].filter(name => cookies.some(c => c.name === name && c.value)),
      headless: this.headless, existingChromeConnection: false, loginAttempts: Number(this.submitted), credentialValuesReturned: false };
  }
  async login({ username, password } = {}) {
    if (typeof username !== 'string' || username !== BLOG_ID || typeof password !== 'string' || !password || password.length > 1024) throw new ApiError('INPUT', 'Supply the authorized blog account credentials');
    if (!this.page || new URL(this.page.url()).origin !== 'https://nid.naver.com') throw new ApiError('LOGIN_PAGE', 'An observed Naver login page is required');
    if (this.submitted) throw new ApiError('LOGIN_ONCE', 'Only one credential submission is allowed in this lifecycle');
    const before = await this.status();
    if (['captcha_required', 'additional_verification_required', 'account_protection'].includes(before.classification)) return before;
    const loginButtonId = ['loginBtn_row', 'log.login'].find(id => before.buttons.some(x => x.id === id));
    if (!before.inputs.some(x => x.id === 'id') || !before.inputs.some(x => x.id === 'pw') || !loginButtonId) {
      throw new ApiError('LOGIN_SCHEMA', 'Observed login controls differ from the supported form');
    }
    this.submitted = true;
    try {
      await this.page.locator('#id').fill(username);
      await this.page.locator('#pw').fill(password);
      await this.page.locator(`[id="${loginButtonId}"]`).click();
      this.stage = 'credentials_submitted';
      for (let i = 0; i < 20; i++) {
        await this.page.waitForTimeout(500);
        let result;
        try { result = await this.status(); } catch { continue; }
        if (result.classification !== 'login_pending') {
          this.stage = result.classification;
          if (result.classification === 'session_issued_unverified') this.cookies = await this.context.cookies(AUTH_ORIGINS);
          return { ...result, stage: this.stage };
        }
      }
      return this.status();
    } finally { username = ''; password = ''; }
  }
  cookieFor(url) {
    if (!this.cookies.length) throw new ApiError('AUTH_MISSING', 'No headless login session is available');
    return credentialHeader(this.cookies, url);
  }
  async verifyHTTP() {
    const cookie = this.cookieFor(ADMIN_ROOT);
    const response = await fetch(ADMIN_ROOT, { method: 'GET', redirect: 'manual', headers: { cookie, accept: 'text/html' }, signal: AbortSignal.timeout(20000) });
    const mime = response.headers.get('content-type') || '';
    if (response.status !== 200 || !mime.includes('text/html')) { await response.body?.cancel(); throw new ApiError('AUTH_UNVERIFIED', 'Protected root did not return expected HTML'); }
    const parts = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new ApiError('SIZE', 'Authentication response exceeds budget'); parts.push(chunk); }
    const bytes = Buffer.concat(parts);
    const html = bytes.toString('utf8');
    const actorMatched = html.includes(`/${BLOG_ID}/config/bloginfo`) && html.includes(`/${BLOG_ID}/stat/today`);
    const loginRedirect = /location(?:\.href)?\s*=\s*["']https:\/\/nid\.naver\.com|<input[^>]+type=["']password/i.test(html);
    const verified = actorMatched && !loginRedirect;
    if (verified) this.stage = 'protected_root_HTTP_verified';
    return { verified, actor: BLOG_ID, source: 'independent_node_fetch', method: 'GET', url: ADMIN_ROOT,
      httpStatus: response.status, mime: 'text/html', bytes: size, sha256: createHash('sha256').update(bytes).digest('hex'), actorMatched,
      loginRedirect, checkedAt: new Date().toISOString(), browserUsedForHTTPRequest: false };
  }
  async handoffHTTP({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    if (!this.cookies.length) throw new ApiError('AUTH_MISSING', 'No authenticated session to hand off');
    const session = new SessionClient({ cookies: this.cookies, fetchImpl, now });
    try {
      const verification = await session.verifyRoot();
      if (!verification.verified) throw new ApiError('AUTH_UNVERIFIED', 'Expected account-scoped navigation was not established');
      await this.closeBrowser();
      this.cookies = []; this.stage = 'http_session_handed_off';
      return { session, verification };
    } catch (error) {
      session.clear(); this.cookies = [];
      await this.close().catch(() => {});
      if (error instanceof ApiError) throw error;
      throw new ApiError('HANDOFF_FAILED', 'HTTP handoff failed; raw details omitted');
    }
  }
  async closeBrowser() {
    const browser = this.browser;
    this.browser = null; this.page = null; this.context = null;
    if (browser) await browser.close();
    return { browserClosed: true, sessionInMemory: this.cookies.length > 0 };
  }
  async close() { this.cookies = []; try { await this.closeBrowser(); } finally { this.stage = 'closed'; } return { browserClosed: true, sessionCleared: true }; }
}
