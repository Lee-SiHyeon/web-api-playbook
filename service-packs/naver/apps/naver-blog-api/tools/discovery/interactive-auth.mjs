import { existsSync } from 'node:fs';
import { ApiError, BLOG_ID } from '../../scripts/client.mjs';
import { SessionClient } from '../../scripts/session-client.mjs';
import { ADMIN_ROOT, AUTH_ORIGINS, classifyBrowserOpenError } from './headless-auth.mjs';

const requiredCookies = ['NID_AUT', 'NID_SES'];
const hasRequiredCookies = cookies => requiredCookies.every(name =>
  cookies.some(cookie => cookie.name === name && typeof cookie.value === 'string' && cookie.value.length > 0));
const safeField = /^[A-Za-z_$][\w$.-]{0,100}$/;
const readMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
const relevantHost = host => host === 'naver.com' || host.endsWith('.naver.com')
  || host === 'pstatic.net' || host.endsWith('.pstatic.net');
const sanitizeUrl = raw => {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !relevantHost(url.hostname)) return null;
  return { url: url.origin + url.pathname,
    queryFields: [...new Set([...url.searchParams.keys()].filter(field => safeField.test(field)))].sort() };
};

export function browserRequestMetadata(request) {
  const target = sanitizeUrl(request?.url?.());
  if (!target) return null;
  const method = String(request?.method?.() || '').toUpperCase();
  if (!method) return null;
  return { ...target, method,
    resourceType: typeof request?.resourceType === 'function' ? request.resourceType() : null,
    blocked: !readMethods.has(method) };
}
const verificationSummary = value => value ? {
  verified: value.verified === true,
  httpStatus: value.httpStatus ?? null,
  mime: value.mime ?? null,
  bytes: value.bytes ?? null,
  actorMatched: value.actorMatched === true,
  adminShell: value.adminShell === true,
  substantialAdminDocument: value.substantialAdminDocument === true,
  loginHTML: value.loginHTML === true,
  redirectCount: value.redirectCount ?? null,
  finalPath: value.finalPath ?? null,
  userAgentApplied: value.userAgentApplied === true,
} : null;

// Opens one temporary visible browser context. The user signs in directly on Naver's page;
// this helper never receives, fills, logs, or persists the password.
export class InteractiveAuth {
  constructor({ loadChromium = async () => (await import('playwright')).chromium,
    now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    timeoutMs = 5 * 60 * 1000, pollMs = 500, readOnlyWarmupUrl = null } = {}) {
    if (typeof loadChromium !== 'function' || typeof now !== 'function' || typeof sleep !== 'function'
      || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 10 * 60 * 1000
      || !Number.isInteger(pollMs) || pollMs < 100 || pollMs > 5000) {
      throw new ApiError('INPUT', 'Invalid interactive login options');
    }
    if (readOnlyWarmupUrl !== null) {
      let warmup;
      try { warmup = new URL(readOnlyWarmupUrl); } catch { throw new ApiError('INPUT', 'Invalid read-only warmup URL'); }
      if (warmup.origin !== 'https://blog.naver.com' || warmup.pathname !== '/PostWriteForm.naver'
        || warmup.searchParams.get('blogId') !== BLOG_ID || [...warmup.searchParams.keys()].some(key => key !== 'blogId')) {
        throw new ApiError('SCOPE', 'Only the authorized PostWriteForm GET may be used as a browser warmup');
      }
    }
    this.loadChromium = loadChromium; this.now = now; this.sleep = sleep;
    this.timeoutMs = timeoutMs; this.pollMs = pollMs;
    this.browser = null; this.context = null; this.page = null; this.stage = 'not_started';
    this.readOnlyWarmupUrl = readOnlyWarmupUrl;
    this.warmupEvidence = null;
  }

  async open() {
    if (this.browser) return this.status();
    if (process.env.DEBUG || process.env.PWDEBUG) {
      throw new ApiError('DEBUG_UNSAFE', 'Disable debug logging before opening the login window');
    }
    try {
      const chromium = await this.loadChromium();
      if (!chromium || typeof chromium.launch !== 'function' || typeof chromium.executablePath !== 'function'
        || !existsSync(chromium.executablePath())) {
        throw new ApiError('BROWSER_RUNTIME_MISSING', 'Playwright Chromium is missing. Run npm run setup:browser and retry');
      }
      this.browser = await chromium.launch({ headless: false, timeout: 20000 });
      this.context = await this.browser.newContext({ locale: 'ko-KR', timezoneId: 'Asia/Seoul', acceptDownloads: false });
      this.page = await this.context.newPage();
      this.page.setDefaultTimeout(12000);
      this.page.setDefaultNavigationTimeout(20000);
      await this.page.goto(ADMIN_ROOT, { waitUntil: 'domcontentloaded' });
      this.stage = 'awaiting_manual_login';
      return this.status();
    } catch (error) {
      await this.#discardBrowser();
      this.stage = 'open_failed';
      if (error instanceof ApiError) throw error;
      throw classifyBrowserOpenError(error);
    }
  }

  async status() {
    if (!this.page || this.page.isClosed()) {
      return { stage: this.stage, classification: 'manual_login_not_open', browserOpen: false,
        interactive: true, credentialValuesReturned: false };
    }
    const url = new URL(this.page.url());
    const cookies = await this.context.cookies(AUTH_ORIGINS);
    const present = requiredCookies.filter(name => cookies.some(cookie => cookie.name === name && cookie.value));
    return { stage: this.stage,
      classification: hasRequiredCookies(cookies) ? 'session_issued_unverified' : 'manual_login_pending',
      page: url.origin + url.pathname, browserOpen: true, interactive: true,
      authCookieNamesPresent: present, credentialValuesReturned: false };
  }

  async handoffHTTP({ fetchImpl = globalThis.fetch, now = this.now } = {}) {
    if (!this.browser) await this.open();
    const deadline = this.now() + this.timeoutMs;
    let sawRequiredCookies = false;
    let verificationAttempts = 0;
    let nextVerificationAt = 0;
    let browserAdminNavigationAttempts = 0;
    let browserAdminVerified = false;
    let nextBrowserNavigationAt = 0;
    let browserIdentityHeaders = {};
    let lastVerification = null;
    while (this.now() < deadline) {
      if (!this.page || this.page.isClosed()) {
        await this.#discardBrowser();
        this.stage = 'manual_login_cancelled';
        throw new ApiError('MANUAL_LOGIN_CANCELLED', 'The temporary login window was closed before authentication completed');
      }
      let cookies = await this.context.cookies(AUTH_ORIGINS);
      if (hasRequiredCookies(cookies)) {
        sawRequiredCookies = true;
        if (!browserAdminVerified && this.now() >= nextBrowserNavigationAt && browserAdminNavigationAttempts < 12) {
          browserAdminNavigationAttempts++;
          nextBrowserNavigationAt = this.now() + 5000;
          try {
            await this.page.goto(ADMIN_ROOT, { waitUntil: 'domcontentloaded' });
            await this.page.waitForTimeout?.(250);
            const current = new URL(this.page.url());
            browserAdminVerified = current.origin === 'https://admin.blog.naver.com'
              && (current.pathname === `/${BLOG_ID}` || current.pathname.startsWith(`/${BLOG_ID}/`));
            if (browserAdminVerified && typeof this.page.evaluate === 'function') {
              try {
                const identity = await this.page.evaluate(() => ({
                  userAgent: navigator.userAgent,
                  languages: Array.isArray(navigator.languages) ? navigator.languages : [navigator.language],
                }));
                const languages = Array.isArray(identity?.languages)
                  ? identity.languages.filter(value => typeof value === 'string' && /^[A-Za-z0-9-]{1,35}$/.test(value)).slice(0, 6)
                  : [];
                browserIdentityHeaders = {
                  ...(typeof identity?.userAgent === 'string' && identity.userAgent.length <= 512 ? { 'user-agent': identity.userAgent } : {}),
                  ...(languages.length ? { 'accept-language': languages.join(',') } : {}),
                };
              } catch { browserIdentityHeaders = {}; }
            }
            cookies = await this.context.cookies(AUTH_ORIGINS);
          } catch {
            browserAdminVerified = false;
          }
        }
      }
      if (browserAdminVerified && hasRequiredCookies(cookies)
        && this.now() >= nextVerificationAt && verificationAttempts < 5) {
        verificationAttempts++;
        nextVerificationAt = this.now() + 2000;
        if (this.readOnlyWarmupUrl && !this.warmupEvidence) {
          this.warmupEvidence = await this.#captureReadOnlyWarmup(this.readOnlyWarmupUrl);
          cookies = await this.context.cookies(AUTH_ORIGINS);
        }
        const session = new SessionClient({ cookies, fetchImpl, now, defaultHeaders: browserIdentityHeaders });
        try {
          const verification = await session.verifyRoot();
          lastVerification = verificationSummary(verification);
          if (verification.verified) {
            await this.closeBrowser();
            this.stage = 'http_session_handed_off';
            return { session, verification, warmupEvidence: this.warmupEvidence };
          }
        } catch (error) {
          if (error instanceof ApiError && error.details) {
            lastVerification = verificationSummary(error.details);
          }
          session.clear();
          if (!(error instanceof ApiError) || !['AUTH_MISSING', 'AUTH_UNVERIFIED', 'TRANSPORT', 'TIMEOUT'].includes(error.code)) {
            throw error;
          }
        }
        session.clear();
      }
      if (sawRequiredCookies && verificationAttempts >= 5) {
        await this.#discardBrowser();
        this.stage = 'manual_login_unverified';
        throw new ApiError('AUTH_UNVERIFIED', 'Login completed, but the protected blog page could not be verified', {
          browserAdminVerified, browserAdminNavigationAttempts, verificationAttempts,
          verification: lastVerification,
        });
      }
      await this.sleep(this.pollMs);
    }
    await this.#discardBrowser();
    this.stage = 'manual_login_timeout';
    const timeoutMinutes = Math.ceil(this.timeoutMs / 60000);
    throw new ApiError('MANUAL_LOGIN_TIMEOUT', sawRequiredCookies
      ? 'Login cookies appeared, but the protected blog page could not be verified before timeout'
      : `Manual login was not completed within ${timeoutMinutes} minutes`, {
      browserAdminVerified, browserAdminNavigationAttempts, verificationAttempts,
      verification: lastVerification,
    });
  }

  async #captureReadOnlyWarmup(raw) {
    const requests = new Map();
    const responses = new Map();
    let blockedNonReadTotal = 0;
    let blockedUnrecordedTotal = 0;
    const keyOf = metadata => `${metadata.method}|${metadata.url}|${metadata.queryFields.join(',')}|${metadata.resourceType ?? ''}`;
    const routeHandler = async route => {
      const request = route.request();
      const method = String(request?.method?.() || '').toUpperCase();
      const metadata = browserRequestMetadata(request);
      if (metadata) requests.set(keyOf(metadata), metadata);
      // Method safety is enforced before origin relevance. A foreign or malformed POST must not
      // become allowed merely because it is omitted from the Naver-focused evidence record.
      if (!readMethods.has(method)) {
        blockedNonReadTotal++;
        if (!metadata) blockedUnrecordedTotal++;
        await route.abort('blockedbyclient');
      }
      else await route.continue();
    };
    const responseHandler = response => {
      const metadata = browserRequestMetadata(response.request());
      if (!metadata || metadata.blocked) return;
      responses.set(keyOf(metadata), { ...metadata, httpStatus: response.status() });
    };
    let navigationError = false;
    await this.context.route('**/*', routeHandler);
    this.page.on('response', responseHandler);
    try {
      try { await this.page.goto(raw, { waitUntil: 'domcontentloaded' }); }
      catch { navigationError = true; }
      await this.page.waitForTimeout?.(3000);
      let dom = { current: null, forms: [], scripts: [], frames: [], fieldNames: [] };
      try {
        const observed = await this.page.evaluate(() => ({
          current: location.href,
          forms: [...document.forms].slice(0, 100).map(form => ({
            action: form.action || location.href,
            method: (form.method || 'GET').toUpperCase(),
            fieldNames: [...form.elements].map(element => element.name).filter(Boolean).slice(0, 500),
          })),
          scripts: [...document.scripts].map(script => script.src).filter(Boolean).slice(0, 500),
          frames: [...document.querySelectorAll('iframe[src]')].map(frame => frame.src).filter(Boolean).slice(0, 200),
          fieldNames: [...document.querySelectorAll('input[name],textarea[name],select[name]')]
            .map(element => element.name).filter(Boolean).slice(0, 1000),
        }));
        const current = sanitizeUrl(observed.current);
        dom = {
          current,
          forms: (observed.forms || []).map(form => ({
            ...sanitizeUrl(form.action), method: String(form.method || 'GET').toUpperCase(),
            fieldNames: [...new Set((form.fieldNames || []).filter(field => safeField.test(field)))].sort(),
          })).filter(form => form.url),
          scripts: (observed.scripts || []).map(sanitizeUrl).filter(Boolean),
          frames: (observed.frames || []).map(sanitizeUrl).filter(Boolean),
          fieldNames: [...new Set((observed.fieldNames || []).filter(field => safeField.test(field)))].sort(),
        };
      } catch { navigationError = true; }
      return {
        mode: 'browser_read_only_warmup',
        target: { url: 'https://blog.naver.com/PostWriteForm.naver', queryFields: ['blogId'] },
        navigationError,
        requests: [...requests.values()],
        responses: [...responses.values()],
        blockedNonReadRequests: [...requests.values()].filter(request => request.blocked),
        blockedNonReadTotal,
        blockedUnrecordedTotal,
        allowedReadRequests: [...requests.values()].filter(request => !request.blocked).length,
        dom,
        mutationRequestsSent: 0,
        credentialValuesReturned: false,
      };
    } finally {
      this.page.off('response', responseHandler);
      await this.context.unroute('**/*', routeHandler).catch(() => {});
    }
  }

  async #discardBrowser() {
    const browser = this.browser;
    this.browser = null; this.context = null; this.page = null;
    try { await browser?.close(); } catch {}
  }

  async closeBrowser() {
    await this.#discardBrowser();
    return { browserClosed: true, sessionInMemory: false };
  }

  async close() {
    await this.#discardBrowser();
    this.warmupEvidence = null;
    this.stage = 'closed';
    return { browserClosed: true, sessionCleared: true };
  }
}
