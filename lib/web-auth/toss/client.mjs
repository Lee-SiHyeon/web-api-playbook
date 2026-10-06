import { ProtectedStore } from '../../protected-store.mjs';
import { ORIGIN, validateBundle, requestWithDependencies } from './client-core.mjs';

export { ORIGIN, validateBundle, requestWithDependencies };

export const STORE_NAME = 'toss-sharelink-state';
const store = new ProtectedStore();
const fail = code => Object.assign(new Error(code), { code });

export function storeSession(bundle) {
  validateBundle(bundle);
  const protectedBundle = { version: bundle.version, service: bundle.service, allowedOrigin: bundle.allowedOrigin,
    capturedAt: bundle.capturedAt, cookies: bundle.cookies, expectedOwner: bundle.expectedOwner,
    readRequests: bundle.readRequests };
  return { ...store.write(STORE_NAME, JSON.stringify(protectedBundle)), service: 'toss-sharelink', credentialScope: ORIGIN };
}

export function status() {
  return { service: 'toss-sharelink', ...store.status(STORE_NAME) };
}

function loadSession() {
  const raw = store.read(STORE_NAME);
  if (!raw) throw fail('TOSS_REAUTH_REQUIRED');
  try { return validateBundle(JSON.parse(raw)); } catch { throw fail('TOSS_STATE_INVALID'); }
}

export async function request(operation = 'member') {
  return requestWithDependencies(operation, { loadSession, fetchImpl: fetch, persistSession: storeSession });
}

export async function checkSession() {
  const r = await request('member');
  return { service: 'toss-sharelink', authenticated: true, ownerMatched: true, httpStatus: r.status,
    resultType: r.data.resultType, browserUsed: false, checkedAt: new Date().toISOString() };
}
