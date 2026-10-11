import { ProtectedStore } from '../../protected-store.mjs';
import { ORIGIN, validateBundle, requestWithDependencies } from './client-core.mjs';

export { ORIGIN, validateBundle, requestWithDependencies };

export const STORE_NAME = 'toss-sharelink-state';
// Importing contracts must not acquire a platform credential provider. Keep the
// existing provider requirement when a legacy operation actually needs storage.
let store;
const getStore = () => store ??= new ProtectedStore();
const fail = code => Object.assign(new Error(code), { code });

export function storeSession(bundle) {
  validateBundle(bundle);
  const protectedBundle = { version: bundle.version, service: bundle.service, allowedOrigin: bundle.allowedOrigin,
    capturedAt: bundle.capturedAt, cookies: bundle.cookies, expectedOwner: bundle.expectedOwner,
    readRequests: bundle.readRequests };
  return { ...getStore().write(STORE_NAME, JSON.stringify(protectedBundle)), service: 'toss-sharelink', credentialScope: ORIGIN };
}

export function status() {
  return { service: 'toss-sharelink', ...getStore().status(STORE_NAME) };
}

function loadSession() {
  const raw = getStore().read(STORE_NAME);
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
