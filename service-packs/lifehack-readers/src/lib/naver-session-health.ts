import { ScopedSession } from './providers/coupang/scoped-session.mjs';
import { NativeHandoffError, record } from './native-handoff-envelope';
import { NAVER_CONNECT_CHANNEL, NAVER_CONNECT_ORIGIN, validNaverCookies,
  type NaverNativeCookie } from './naver-native-session-handoff';

export interface NaverSessionState {
  version: 1; provider: 'naver_connect'; ownerEmail: string;
  loginId: string; spaceId: string; userAgent: string; cookies: NaverNativeCookie[];
}

export function channelMatches(value: unknown): boolean {
  const channel = record(value);
  if (!channel || (channel.channelType ?? channel.externalChannelType ?? channel.type) !== 'NBLOG') return false;
  // The live creator-space response (observed 2026-10-11) keeps the blog identity under `meta` ({meta:{id,url}}).
  const meta = record(channel.meta);
  const identity = channel.channelId ?? channel.loginId ?? meta?.id;
  if (identity === NAVER_CONNECT_CHANNEL) return true;
  const urlValue = channel.channelUrl ?? channel.url ?? meta?.url;
  if (typeof urlValue !== 'string') return false;
  try {
    const url = new URL(urlValue);
    return url.protocol === 'https:' && ['blog.naver.com', 'm.blog.naver.com'].includes(url.hostname)
      && !url.port && !url.username && !url.password && !url.search && !url.hash
      && url.pathname.replace(/\/$/, '') === `/${NAVER_CONNECT_CHANNEL}`;
  } catch { return false; }
}

/** Reuse Coupang's bounded, exact-origin HTTP jar and observed Set-Cookie rotation. */
/** Last failed health step (no secrets): e.g. "state", "me:401", "me:owner", "check-owner:200-body", "creator-space:channel". */
export let lastNaverHealthFailure: string | null = null;

export async function verifyNaverSessionHealth(state: NaverSessionState, fetchImpl: typeof fetch = fetch): Promise<NaverSessionState> {
  let step = 'state';
  lastNaverHealthFailure = null;
  try {
    if (state.version !== 1 || state.provider !== 'naver_connect' || !state.ownerEmail
      || !/^[A-Za-z0-9_-]{1,100}$/.test(state.loginId) || !/^[0-9]{1,32}$/.test(state.spaceId)
      || !/[1-9]/.test(state.spaceId) || !/^[\x20-\x7e]{1,512}$/.test(state.userAgent)
      || !validNaverCookies(state.cookies)) throw new Error();
    const session = new ScopedSession({
      allowedOrigins: [NAVER_CONNECT_ORIGIN], cookieOrigins: [NAVER_CONNECT_ORIGIN],
      cookies: state.cookies.map(cookie => ['.naver.com', 'naver.com'].includes(cookie.domain)
        ? { ...cookie, domain: '.naver.com', hostOnly: false } : cookie),
      defaultHeaders: { accept: 'application/json', 'user-agent': state.userAgent },
      headersByOrigin: { [NAVER_CONNECT_ORIGIN]: { referer: 'https://brandconnect.naver.com/', 'x-space-id': state.spaceId } },
      timeoutMs: 5_000, maxResponseBytes: 128 * 1024, maxRequestBytes: 1024, maxRedirects: 0, fetchImpl,
    });
    async function read(path: string, empty = false): Promise<unknown> {
      const label = path.split('?')[0].split('/')[3] ?? path;
      step = `${label}:transport`;
      const result = await session.request(NAVER_CONNECT_ORIGIN + path, { method: 'GET' });
      step = `${label}:${result.status}`;
      if (result.status !== 200) throw new Error();
      if (empty) { step = `${label}:200-body`; if (result.raw.trim() !== '') throw new Error(); return null; }
      const mime = (result.headers as Record<string, string>)['content-type']?.split(';')[0].trim().toLowerCase();
      step = `${label}:mime-${mime ?? 'none'}`;
      if (mime !== 'application/json') throw new Error();
      step = `${label}:json`;
      return JSON.parse(result.raw);
    }
    async function checkOwner() {
      const me = record(await read('/brand-connect/query/me'));
      step = 'me:owner';
      if (!me || me.loginId !== state.loginId || me.creator !== true || typeof me.partner !== 'boolean'
        || !Array.isArray(me.activeSpaceIds) || !me.activeSpaceIds.every(id =>
          (typeof id === 'string' && /^[0-9]{1,32}$/.test(id)) || (Number.isSafeInteger(id) && Number(id) > 0))
        || !me.activeSpaceIds.map(String).includes(state.spaceId)) throw new Error();
      await read(`/brand-connect/query/space/check-owner?spaceId=${state.spaceId}`, true);
      const response = record(await read(`/brand-connect/query/creator-space/${state.spaceId}`));
      const space = record(response?.data) ?? response;
      step = 'creator-space:channel';
      // Fail closed on an unknown response schema; never search arbitrary nested response text for an owner name.
      if (!space || !Array.isArray(space.externalChannels) || !space.externalChannels.some(channelMatches)) throw new Error();
    }
    await checkOwner();
    await checkOwner(); // The independently observed rotations are used for the next protected reads.
    const serializedCookies = session.toJSON().cookieJar.cookies as Array<{
      key: string; value: string; domain: string; path: string; hostOnly?: boolean;
      secure?: boolean; httpOnly?: boolean; sameSite?: string; expires?: string;
    }>;
    const cookies = serializedCookies
      .filter(cookie => ['NID_AUT', 'NID_SES', 'NID_JKL'].includes(cookie.key))
      .map(cookie => ({ name: cookie.key, value: cookie.value, domain: cookie.domain, path: cookie.path,
        hostOnly: cookie.hostOnly, secure: cookie.secure, httpOnly: cookie.httpOnly,
        ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
        ...(cookie.expires && cookie.expires !== 'Infinity' ? { expires: Date.parse(String(cookie.expires)) / 1000 } : {}),
      }));
    step = 'rotated-cookies';
    if (!validNaverCookies(cookies)) throw new Error();
    return { ...state, cookies };
  } catch {
    lastNaverHealthFailure = step;
    throw new NativeHandoffError('NAVER_CONNECT_HEALTH_NOT_VERIFIED');
  }
}
