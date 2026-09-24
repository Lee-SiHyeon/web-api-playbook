import { credentialExists, readCredential, writeCredential } from './secure-credential-store.mjs';
import { validateLoginIdentity, NAVER_LOGIN_ACTOR } from './naver-login-http.mjs';

const name = 'naver-login-identity';
export function naverLoginIdentityReady() { return credentialExists(name); }
export function storeNaverLoginIdentity(identity) {
  const valid = validateLoginIdentity(identity);
  return writeCredential(name, JSON.stringify({ version: 1, actor: NAVER_LOGIN_ACTOR, ...valid }));
}
export function loadNaverLoginIdentity() {
  const saved = readCredential(name);
  if (!saved) throw new Error('LOGIN_IDENTITY_MISSING');
  let value;
  try { value = JSON.parse(saved); } catch { throw new Error('LOGIN_IDENTITY_INVALID'); }
  if (value.version !== 1 || value.actor !== NAVER_LOGIN_ACTOR) throw new Error('LOGIN_IDENTITY_SCOPE');
  return validateLoginIdentity(value);
}
