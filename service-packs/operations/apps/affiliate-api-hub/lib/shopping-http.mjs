import {
  ShoppingReadError, loadShoppingSession, headersForShoppingSession,
  applyShoppingCookieRotation, rotateShoppingCookies, withShoppingSessionLock, invalidateShoppingSession,
} from './shopping-session-store.mjs';

const inMemoryRequests = new WeakSet();

function inspectChallengePage(response, body) {
  const html = /<(?:html|title|form|body)\b/i.test(body);
  const title = html ? body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '' : '';
  const visibleText = html ? body.replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&(?:nbsp|amp|lt|gt|quot|#39);/gi, ' ').replace(/\s+/g, ' ').trim() : '';
  const challengeSignals = {
    cfMitigatedHeader: response.headers.get('cf-mitigated')?.toLowerCase() === 'challenge',
    captchaRequiredHeader: /^(?:1|true|yes|required)$/i.test(response.headers.get('x-captcha-required') || ''),
    sucuriBlockHeader: !!response.headers.get('x-sucuri-block'),
    challengeTitle: /just a moment|attention required|access denied/i.test(title),
    challengeMarkup: html && /\b(?:id|class)\s*=\s*["'][^"']*(?:cf-challenge-running|cf-browser-verification|challenge-form|cf-error-details|cf-chl-)[^"']*["']/i.test(body),
    visibleChallengeCopy: /verify you are human|checking your browser|enable javascript and cookies to continue|unusual traffic|비정상 접근|자동\s*입력\s*방지/i.test(visibleText),
  };
  const weakSignals = { challengePlatformMarkerOnly: /challenge-platform/i.test(body), nCaptchaMarkerOnly: /ncaptcha/i.test(body) };
  // A normal page can contain a Login link. Require the actual password form and title.
  const loginPage = html && /login|log in|sign in|로그인/i.test(title) &&
    /<form\b/i.test(body) && /<input\b[^>]*\btype\s*=\s*(?:["']password["']|password(?:\s|>))/i.test(body);
  return { confirmed: Object.values(challengeSignals).some(Boolean), challengeSignals, weakSignals, loginPage };
}

function responseCookies(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const joined = headers.get('set-cookie');
  if (!joined) return [];
  // Commas in Expires are legal. A combined second cookie cannot be parsed safely.
  if (/,[ \t]*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=/.test(joined)) throw new ShoppingReadError('SESSION_COOKIE_HEADERS_UNSUPPORTED');
  return [joined];
}

function retryAfter(value) {
  if (typeof value !== 'string' || value.length > 64) return null;
  if (/^\d{1,8}$/.test(value)) return String(Number(value));
  if (/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value) && Number.isFinite(Date.parse(value))) return value;
  return null;
}

async function boundedBody(response, maxBytes) {
  if (!response.body) return { text: '', bytes: 0 };
  const reader = response.body.getReader();
  const chunks = []; let bytes = 0, finished = false;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) { finished = true; break; }
      bytes += part.value.byteLength;
      if (bytes > maxBytes) throw new ShoppingReadError('RESPONSE_SIZE');
      chunks.push(Buffer.from(part.value));
    }
    return { text: Buffer.concat(chunks).toString('utf8'), bytes };
  } catch (error) {
    const code = error instanceof ShoppingReadError ? error.code : /AbortError|TimeoutError/.test(error?.name || '') ? 'TRANSPORT_TIMEOUT' : 'RESPONSE_BODY_FAILED';
    throw new ShoppingReadError(code, { bytesRead: bytes });
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function request({ service, target, method, body, referer, maxBytes, htmlOnly = false, fetchImpl = globalThis.fetch, suppliedSession }) {
  const execute = async () => {
    const session = suppliedSession ?? loadShoppingSession(service);
    if (session.service !== service) throw new ShoppingReadError('SESSION_SCOPE');
    const headers = headersForShoppingSession(session, target, referer);
    const signal = AbortSignal.timeout(20000);
    let response;
    try { response = await fetchImpl(target, { method, headers, ...(body === undefined ? {} : { body }), redirect: 'manual', signal }); }
    catch (error) { throw new ShoppingReadError(signal.aborted || /AbortError|TimeoutError/.test(error?.name || '') ? 'TRANSPORT_TIMEOUT' : 'TRANSPORT_FAILED', { retry: false }); }
    if (!response || !Number.isInteger(response.status) || !response.headers?.get) throw new ShoppingReadError('RESPONSE_SCHEMA');
    // Check the actual response origin before accepting rotations, even for injected transports.
    if (response.redirected || response.url && response.url !== target.href) {
      await response.body?.cancel().catch(() => {});
      throw new ShoppingReadError('RESPONSE_ORIGIN_SCOPE', { retry: false });
    }
    let rotated;
    try {
      const setCookies = responseCookies(response.headers);
      rotated = suppliedSession ? rotateShoppingCookies(session, setCookies, target) : applyShoppingCookieRotation(session, setCookies, target);
    } catch (error) {
      await response.body?.cancel().catch(() => {});
      throw error;
    }
    const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const contentType = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime) ? mime : '';
    let result = { text: '', bytes: 0 }, bodyError = null;
    try { result = await boundedBody(response, maxBytes); } catch (error) { bodyError = error; }
    const challenge = inspectChallengePage(response, result.text);
    let loginRedirect = false;
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      try {
        const location = new URL(response.headers.get('location'), target);
        loginRedirect = location.origin === target.origin && /(?:^|\/)(?:login|signin|sign-in)(?:[/.]|$)/i.test(location.pathname);
      } catch { /* An invalid or cross-origin redirect remains a rejected response. */ }
    }
    const receipt = {
      checkedAt: new Date().toISOString(), method, path: target.pathname, status: response.status, contentType,
      bytes: bodyError?.details?.bytesRead ?? result.bytes, bodyComplete: !bodyError,
      sessionProvider: suppliedSession ? 'in_memory' : 'windows_current_user_dpapi',
      credentialSent: !!headers.cookie, credentialPropagated: !!headers.cookie,
      cookieRotationApplied: rotated, cookieRotationPersisted: !suppliedSession && rotated,
      authenticatedOwnerVerified: false, browserUsed: false, execution: 'pure_http',
      retryAfter: retryAfter(response.headers.get('retry-after')), retry: false,
      transport: fetchImpl === globalThis.fetch ? 'native_fetch' : 'injected',
      challengeConfirmed: challenge.confirmed, challengeSignals: challenge.challengeSignals,
      weakChallengeSignals: challenge.weakSignals, loginRedirect, loginPage: challenge.loginPage,
    };
    if (response.status === 429) throw new ShoppingReadError('RATE_LIMITED', receipt);
    if (challenge.confirmed) throw new ShoppingReadError('SITE_CHALLENGE', { ...receipt, challenge: true });
    if (response.status === 401 || loginRedirect || challenge.loginPage) {
      invalidateShoppingSession(session, { persist: !suppliedSession });
      throw new ShoppingReadError('REAUTH_REQUIRED', receipt);
    }
    if (response.status !== 200) throw new ShoppingReadError('HTTP_REJECTED', receipt);
    if (bodyError) throw new ShoppingReadError(bodyError.code, receipt);
    if (htmlOnly && !['text/html', 'application/xhtml+xml'].includes(contentType)) throw new ShoppingReadError('CONTENT_TYPE', receipt);
    return { text: result.text, receipt, session };
  };
  // Cover load → request → rotation with one per-service lock, so parallel collectors
  // cannot restore a stale token over a newer rotation. Busy callers do not retry.
  if (suppliedSession == null) return withShoppingSessionLock(service, execute);
  if (typeof suppliedSession !== 'object' || Array.isArray(suppliedSession)) throw new ShoppingReadError('SESSION_SCHEMA');
  if (inMemoryRequests.has(suppliedSession)) throw new ShoppingReadError('SESSION_BUSY');
  inMemoryRequests.add(suppliedSession);
  try { return await execute(); } finally { inMemoryRequests.delete(suppliedSession); }
}

export async function shoppingHttpRead({ service, path, body, referer, fetchImpl, session }) {
  const postScopes = {
    gmarket: ['https://item.gmarket.co.kr', '/Review'],
    auction: ['https://itempage3.auction.co.kr', '/WebService/ReviewService.asmx/GetReviewList'],
    'naver-brand': ['https://brand.naver.com', '/n/v1/contents/reviews/query-pages'],
  };
  const scope = Object.hasOwn(postScopes, service) ? postScopes[service] : null;
  if (!scope || path !== scope[1]) throw new ShoppingReadError('ENDPOINT_SCOPE');
  if (!(typeof body === 'string' || body instanceof URLSearchParams) || Buffer.byteLength(String(body)) > 256 * 1024)
    throw new ShoppingReadError('REQUEST_BODY_SCHEMA');
  return request({ service, target: new URL(path, scope[0]), method: 'POST', body, referer,
    maxBytes: 4 * 1024 * 1024, fetchImpl, suppliedSession: session });
}

export async function shoppingHttpGetDocument({ service, url, fetchImpl, session } = {}) {
  const scopes = {
    'gmarket-search': { origin: 'https://www.gmarket.co.kr', path: '/n/search', query: 'keyword' },
    'naver-search': { origin: 'https://search.shopping.naver.com', path: '/search/all', query: 'query' },
  };
  const scope = Object.hasOwn(scopes, service) ? scopes[service] : null;
  if (!scope) throw new ShoppingReadError('ENDPOINT_SCOPE');
  let target; try { target = new URL(url); } catch { throw new ShoppingReadError('URL_INPUT'); }
  const query = target.searchParams.get(scope.query);
  if (target.origin !== scope.origin || target.pathname !== scope.path || target.username || target.password || target.hash ||
      target.searchParams.getAll(scope.query).length !== 1 || [...target.searchParams.keys()].some(key => key !== scope.query) ||
      !query?.trim() || query.length > 100 || /[\u0000-\u001f\u007f]/.test(query)) throw new ShoppingReadError('ENDPOINT_SCOPE');
  const result = await request({ service, target, method: 'GET', maxBytes: 8 * 1024 * 1024,
    htmlOnly: true, fetchImpl, suppliedSession: session });
  return { html: result.text, receipt: result.receipt, session: result.session };
}
