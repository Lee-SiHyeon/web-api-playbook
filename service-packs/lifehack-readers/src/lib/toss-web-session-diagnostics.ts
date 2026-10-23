import { fetchCollectorResponse } from './hub/collectors/fetch-response';
import { clearNativeHandoffMaterial } from './native-handoff-envelope';
import { restoreTossCookieJar, applyTossResponseCookies, exportTossCookieJar } from './toss-cookie-jar';
import { TossSessionClient, tossFailureDiagnostics, validateTossBundle, type TossSessionBundle } from './toss-session-core';

const ACCOUNTS = 'https://business-accounts.toss.im';
const READS = ['/user/me', '/session/web', '/account/trusted-ips'] as const;
interface AccountRead {
  path: typeof READS[number]; httpStatus: number | null; resultType: string | null; errorCode: string | null;
  errorType?: number | null; errorDataFieldTypes?: Record<string, string>;
  successFieldTypes: Record<string, string>; itemFieldTypes: Record<string, string>;
}
const fields = (value: unknown): Record<string, string> => !value || typeof value !== 'object' || Array.isArray(value) ? {}
  : Object.fromEntries(Object.entries(value).filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(key)).slice(0, 24)
    .map(([key, item]) => [key, item === null ? 'null' : Array.isArray(item) ? 'array' : typeof item]));
const safeCode = (value: unknown) => typeof value === 'string' && /^[A-Z0-9_.-]{1,48}$/.test(value) ? value : null;

/** Fixed first-party web-account GETs only. No settings, login, tokens or business writes are submitted. */
export async function diagnoseTossWebSession(bundle: TossSessionBundle, fetchImpl: typeof fetch) {
  const candidate = structuredClone(validateTossBundle(bundle));
  const cookieFormat = candidate.cookies.map(cookie => {
    let jwtFields: Record<string, string> | null = null;
    const parts = cookie.value.split('.');
    if (parts.length === 3 && parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) {
      try { jwtFields = fields(JSON.parse(Buffer.from(parts[1], 'base64url').toString())); } catch { /* Opaque cookies remain unknown. */ }
    }
    return { name: cookie.name, hostOnly: cookie.hostOnly === true,
      expiry: cookie.expires == null || cookie.expires === -1 ? 'session' : cookie.expires * 1000 > Date.now() ? 'live' : 'expired',
      format: jwtFields === null ? 'opaque' : 'jwt_shaped_unverified',
      bindingClaimNames: jwtFields === null ? [] : ['ip', 'ipAddress', 'clientIp', 'deviceId', 'userAgent', 'sessionId', 'sid'].filter(k => k in jwtFields),
      refreshClaimPresent: jwtFields === null ? null : ['refreshToken', 'refresh_token'].some(k => k in jwtFields) };
  });
  const client = new TossSessionClient(candidate, { fetchImpl, maxRequests: 1, deadline: Date.now() + 12000 });
  let ownerVerified = false, memberFailure = null, cookieUpdateObserved = false;
  const accountReads: AccountRead[] = [];
  let jar = restoreTossCookieJar(candidate.cookies);
  try {
    try { await client.verifyOwner(); ownerVerified = true; }
    catch (error) { memberFailure = tossFailureDiagnostics(error); }
    if (memberFailure?.code === 'TOSS_OWNER_MISMATCH') return { ownerVerified, memberFailure, cookieFormat,
      cookieUpdateObserved, accountReads, sourceRequests: client.sourceRequests, sessionStateChanged: false };
    // Keep any response cookies inside this invocation; a diagnostic never
    // changes the shared vault's status or asserts global session expiration.
    const memberCookies = exportTossCookieJar(restoreTossCookieJar(client.bundle.cookies));
    cookieUpdateObserved = JSON.stringify(memberCookies) !== JSON.stringify(exportTossCookieJar(jar));
    jar.removeAllCookiesSync();
    jar = restoreTossCookieJar(memberCookies);
    for (const path of READS) {
      let response: Awaited<ReturnType<typeof fetchCollectorResponse>> | null = null;
      try {
        const url = ACCOUNTS + path;
        response = await fetchCollectorResponse(fetchImpl, url, { method: 'GET', redirect: 'manual', cache: 'no-store',
          headers: { Accept: 'application/json', Origin: 'https://business.toss.im', Referer: 'https://business.toss.im/dashboard/',
            Cookie: jar.getCookieStringSync(url) } }, { timeoutMs: 6000, maxBytes: 65536, readErrorBody: true });
        const before = JSON.stringify(exportTossCookieJar(jar));
        try { applyTossResponseCookies(jar, response.headers, url); } catch { /* The closed read receipt remains diagnostic only. */ }
        cookieUpdateObserved ||= before !== JSON.stringify(exportTossCookieJar(jar));
        let data;
        try { data = JSON.parse(new TextDecoder().decode(response.body)); } catch { /* A non-JSON response is not authentication. */ }
        accountReads.push({ path, httpStatus: response.status,
          resultType: ['SUCCESS', 'FAIL', 'ERROR'].includes(data?.resultType) ? data.resultType as string : null,
          errorCode: safeCode(data?.error?.errorCode),
          errorType: Number.isSafeInteger(data?.error?.errorType) ? data.error.errorType as number : null,
          errorDataFieldTypes: fields(data?.error?.data), successFieldTypes: fields(data?.success),
          itemFieldTypes: Array.isArray(data?.success) ? fields(data.success[0]) : {} });
      } catch {
        accountReads.push({ path, httpStatus: response?.status ?? null, resultType: null, errorCode: 'TRANSPORT_UNAVAILABLE',
          successFieldTypes: {}, itemFieldTypes: {} });
      } finally { response?.body.fill(0); }
    }
    return { ownerVerified, memberFailure, cookieFormat, cookieUpdateObserved, accountReads,
      sourceRequests: client.sourceRequests + READS.length, sessionStateChanged: false };
  } finally { jar.removeAllCookiesSync(); clearNativeHandoffMaterial(candidate); }
}
