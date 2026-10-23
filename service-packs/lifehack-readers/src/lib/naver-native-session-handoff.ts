import { exactKeys, record, verifyNativeHandoff } from './native-handoff-envelope';

export const NAVER_CONNECT_ORIGIN = 'https://gw-brandconnect.naver.com';
export const NAVER_CONNECT_CHANNEL = 'aicandoanything';
export interface NaverNativeCookie {
  name: string; value: string; domain: string; path: string;
  hostOnly?: boolean; secure?: boolean; httpOnly?: boolean; sameSite?: string;
  expires?: number; expirationDate?: number;
}
export interface NaverNativeMaterial {
  cookies: NaverNativeCookie[]; userAgent: string; loginId: string; spaceId: string;
  ownerBindingProof: {
    version: 1; capturedAt: number; origin: string; path: string; method: 'GET'; httpStatus: 200;
    loginId: string; spaceId: string; channel: { type: 'NBLOG'; id: string };
  };
}

export function validNaverCookies(value: unknown, now = Date.now()): value is NaverNativeCookie[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 3) return false;
  const names = new Set<string>();
  for (const item of value) {
    const cookie = record(item);
    if (!cookie || !['name', 'value', 'domain', 'path'].every(key => Object.hasOwn(cookie, key))
      || Object.keys(cookie).some(key => !['name', 'value', 'domain', 'path', 'hostOnly', 'secure',
        'httpOnly', 'sameSite', 'expires', 'expirationDate'].includes(key))
      || typeof cookie.name !== 'string' || !['NID_AUT', 'NID_SES', 'NID_JKL'].includes(cookie.name)
      || names.has(cookie.name) || typeof cookie.value !== 'string'
      || !/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,16384}$/.test(cookie.value)
      || typeof cookie.domain !== 'string' || !['.naver.com', 'naver.com', 'gw-brandconnect.naver.com',
        '.gw-brandconnect.naver.com'].includes(cookie.domain) || cookie.path !== '/') return false;
    if (['.naver.com', 'naver.com'].includes(cookie.domain) && cookie.hostOnly === true) return false;
    for (const key of ['hostOnly', 'secure', 'httpOnly']) if (cookie[key] !== undefined && typeof cookie[key] !== 'boolean') return false;
    if (cookie.sameSite !== undefined && !['Strict', 'Lax', 'None', 'strict', 'lax', 'none',
      'no_restriction', 'unspecified'].includes(String(cookie.sameSite))) return false;
    for (const key of ['expires', 'expirationDate']) {
      const expiry = cookie[key];
      if (expiry !== undefined && (typeof expiry !== 'number' || !Number.isFinite(expiry)
        || (expiry > 0 && (expiry * 1000 <= now || expiry > 8.64e12)))) return false;
    }
    if (cookie.expires !== undefined && cookie.expirationDate !== undefined && cookie.expires !== cookie.expirationDate) return false;
    names.add(cookie.name);
  }
  return names.has('NID_AUT') && names.has('NID_SES');
}

export function verifyNaverNativeSessionHandoff(input: {
  envelope: unknown; publicKeyPem: string; expectedEmail: string; expectedLoginId: string;
  expectedRevision: number; now?: number;
}): NaverNativeMaterial {
  return verifyNativeHandoff({ ...input, provider: 'naver_connect', kind: 'authorized_existing_native_session',
    sourceKinds: ['windows_native_browser', 'windows_dpapi_session'], errorCode: 'NAVER_NATIVE_HANDOFF_INVALID',
    validateMaterial(value, now) {
      const material = record(value);
      const proof = record(material?.ownerBindingProof);
      const channel = record(proof?.channel);
      if (!material || !exactKeys(material, ['cookies', 'userAgent', 'loginId', 'spaceId', 'ownerBindingProof'])
        || !validNaverCookies(material.cookies, now) || !input.expectedLoginId
        || material.loginId !== input.expectedLoginId || !/^[A-Za-z0-9_-]{1,100}$/.test(input.expectedLoginId)
        || typeof material.spaceId !== 'string' || !/^[0-9]{1,32}$/.test(material.spaceId)
        || !/[1-9]/.test(material.spaceId) || typeof material.userAgent !== 'string'
        || !/^[\x20-\x7e]{1,512}$/.test(material.userAgent) || !material.userAgent.trim()
        || !proof || !exactKeys(proof, ['version', 'capturedAt', 'origin', 'path', 'method', 'httpStatus',
          'loginId', 'spaceId', 'channel']) || proof.version !== 1 || proof.origin !== NAVER_CONNECT_ORIGIN
        || proof.path !== `/brand-connect/query/creator-space/${material.spaceId}` || proof.method !== 'GET'
        || proof.httpStatus !== 200 || proof.loginId !== material.loginId || proof.spaceId !== material.spaceId
        || !Number.isSafeInteger(proof.capturedAt) || Number(proof.capturedAt) < now - 120_000
        || Number(proof.capturedAt) > now + 10_000 || !channel || !exactKeys(channel, ['type', 'id'])
        || channel.type !== 'NBLOG' || channel.id !== NAVER_CONNECT_CHANNEL) throw new Error();
      return material as unknown as NaverNativeMaterial;
    },
  });
}
