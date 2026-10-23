import { TossSessionClient, TossSessionError, TOSS_ORIGIN, validateTossBundle, tossAuthServiceCode, tossContentTypeFamily,
  type TossFailureDiagnostics, type TossSessionBundle } from './toss-session-core';
import { fetchCollectorResponse } from './hub/collectors/fetch-response';
import { tossRuntimeHttpFetch } from './toss-direct-http';
import { applyTossResponseCookies, exportTossCookieJar, restoreTossCookieJar, tossCookieKey, TossCookieJarError } from './toss-cookie-jar';

const ACCOUNTS = 'https://business-accounts.toss.im';
const CALLBACK = TOSS_ORIGIN + '/signup-start';

/** The current Sharelink frontend's SSO bridge. It does not submit a password or send an app notification. */
export async function renewTossHttpSession(bundle: TossSessionBundle, fetchImpl: typeof fetch = tossRuntimeHttpFetch,
  onCookieUpdate?: (candidate: TossSessionBundle) => void) {
  let sourceRequests = 0, memberRequests = 0;
  let details: Partial<Omit<TossFailureDiagnostics, 'code'>> = { phase: 'sso_authorize' };
  try {
    validateTossBundle(bundle);
    const before = bundle.cookies.map(cookie => ({ ...cookie }));
    const jar = restoreTossCookieJar(bundle.cookies);
    const start = new URL(ACCOUNTS + '/oauth2/authorize');
    start.search = new URLSearchParams({ client_id: 'ajvm9wq2t0p1ttet13y3qzb3rvjxhacn', redirect_uri: CALLBACK,
      response_type: 'code', grant_type: 'authorization_code' }).toString();
    let url = start, reached = false;
    for (let hop = 0; hop < 4; hop++) {
      if (url.username || url.password || url.hash || !((url.origin === ACCOUNTS && url.pathname === '/oauth2/authorize')
        || (url.origin === TOSS_ORIGIN && url.pathname === '/signup-start'))) {
        const interactiveLogin = url.origin === 'https://business.toss.im' && url.pathname === '/account/sign-in';
        throw new TossSessionError(interactiveLogin ? 'TOSS_REAUTH_REQUIRED' : 'TOSS_SSO_REDIRECT_REJECTED', details);
      }
      details = { phase: url.origin === ACCOUNTS ? 'sso_authorize' : 'sso_callback' };
      const cookie = jar.getCookieStringSync(url.href);
      if (!cookie) throw new TossSessionError('TOSS_REAUTH_REQUIRED', details);
      sourceRequests++;
      const response = await fetchCollectorResponse(fetchImpl, url.href, { redirect: 'manual', cache: 'no-store',
        headers: { Accept: 'text/html,application/json', 'X-Toss-Locale': 'ko', Cookie: cookie } },
        { timeoutMs: 8000, maxBytes: 1024 * 1024, readErrorBody: true });
      details = { ...details, httpStatus: response.status, contentTypeFamily: tossContentTypeFamily(response.headers.get('content-type')) };
      try {
        applyTossResponseCookies(jar, response.headers, url.href);
        onCookieUpdate?.({ ...bundle, cookies: exportTossCookieJar(jar) });
        let provider: string | null = null;
        if (['application/json', 'application/*+json'].includes(details.contentTypeFamily ?? '')) {
          try { const data = JSON.parse(new TextDecoder().decode(response.body));
            provider = typeof data?.error?.errorCode === 'string' ? data.error.errorCode : null; } catch { /* Preserve HTTP classification below. */ }
        }
        const authCode = tossAuthServiceCode(provider);
        if (authCode) throw new TossSessionError(authCode, { ...details, tossErrorCode: provider });
        if (response.status === 429) throw new TossSessionError('TOSS_THROTTLED', details);
        if (response.status === 401) throw new TossSessionError('TOSS_REAUTH_REQUIRED', details);
        if (response.status === 403) throw new TossSessionError('TOSS_ACCESS_DENIED', details);
        if (response.status >= 400) throw new TossSessionError('TOSS_HTTP_FAILED', details);
        if (url.origin === TOSS_ORIGIN && response.status === 200) { reached = true; break; }
        if (![301,302,303].includes(response.status) || !response.headers.get('location')) throw new TossSessionError('TOSS_REAUTH_REQUIRED', details);
        url = new URL(response.headers.get('location')!, url);
      } finally { response.body.fill(0); }
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    if (!reached) throw new TossSessionError('TOSS_REAUTH_REQUIRED', details);
    const cookies = exportTossCookieJar(jar);
    const candidate: TossSessionBundle = { ...bundle, cookies };
    await new Promise(resolve => setTimeout(resolve, 400));
    const client = new TossSessionClient(candidate, { fetchImpl, maxRequests: 2, deadline: Date.now() + 25_000 });
    try { await client.verifyOwner(); await client.verifyOwner(); }
    finally { memberRequests = client.sourceRequests; onCookieUpdate?.(client.bundle); }
    sourceRequests += memberRequests; memberRequests = 0;
    return { bundle: candidate, sourceRequests,
      cookiesRotated: candidate.cookies.some(c => before.find(old => tossCookieKey(old) === tossCookieKey(c))?.value !== c.value),
      cookieExpiryExtended: candidate.cookies.some(c => (c.expires ?? -1) > (before.find(old => tossCookieKey(old) === tossCookieKey(c))?.expires ?? -1)),
    };
  } catch (error) {
    const failure = error instanceof TossSessionError ? error
      : new TossSessionError(error instanceof TossCookieJarError ? error.code : 'TOSS_HTTP_FAILED', details);
    Object.defineProperty(failure, 'sourceRequests', { value: sourceRequests + memberRequests });
    throw failure;
  }
}
