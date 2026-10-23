import { readCredential, writeCredential } from '../scripts/secure-credential-store.mjs';
import { BLOG_ORIGIN } from './transport.mjs';
import { authError } from './auth.mjs';

const credentialName = 'tistory-kakao-login-identity-v1';
const loginOrigin = 'https://accounts.kakao.com';

export function validateLoginIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.username !== 'string' || value.username.length > 320
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.username)
    || typeof value.password !== 'string' || !value.password.length || value.password.length > 1024
    || /[\x00-\x1f\x7f]/.test(value.password)) throw authError('TISTORY_LOGIN_IDENTITY_INVALID');
  return { username: value.username, password: value.password };
}

// Called only after the handoff has verified the intended account and blog.
export function saveLoginIdentity(identity, owner) {
  const validated = validateLoginIdentity(identity);
  if (!Number.isSafeInteger(owner?.userId) || owner.userId <= 0
    || !Number.isSafeInteger(owner?.blogId) || owner.blogId <= 0) throw authError('TISTORY_LOGIN_IDENTITY_BINDING');
  try {
    return writeCredential(credentialName, JSON.stringify({ version: 1, loginOrigin,
      blogOrigin: BLOG_ORIGIN, owner: { userId: owner.userId, blogId: owner.blogId }, ...validated }));
  } finally { validated.username = ''; validated.password = ''; }
}

// Runtime-only input for an authorized normal Kakao login. This does not claim
// that password HTTP replay, CAPTCHA or MFA handling has been implemented.
export function loadLoginIdentity(owner) {
  const raw = readCredential(credentialName);
  if (!raw) throw authError('TISTORY_LOGIN_IDENTITY_MISSING');
  if (Buffer.byteLength(raw) > 8192) throw authError('TISTORY_LOGIN_IDENTITY_INVALID');
  let stored;
  try { stored = JSON.parse(raw); } catch { throw authError('TISTORY_LOGIN_IDENTITY_INVALID'); }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw authError('TISTORY_LOGIN_IDENTITY_INVALID');
  if (stored.version !== 1 || stored.loginOrigin !== loginOrigin || stored.blogOrigin !== BLOG_ORIGIN
    || !owner || stored.owner?.userId !== owner.userId || stored.owner?.blogId !== owner.blogId) {
    throw authError('TISTORY_LOGIN_IDENTITY_BINDING');
  }
  try { return validateLoginIdentity(stored); }
  finally { stored.username = ''; stored.password = ''; }
}
