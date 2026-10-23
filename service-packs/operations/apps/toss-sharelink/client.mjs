import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ORIGIN, allowedUrl, validateBundle, schema, requestWithDependencies, issueLinkWithDependencies, findIssued, productDetailUrl, todayDealItemsUrl } from './client-core.mjs';

export { ORIGIN, allowedUrl, validateBundle, schema, requestWithDependencies };

const webApiPlaybookRoot = process.env.WEB_API_PLAYBOOK_ROOT || fileURLToPath(new URL('../../../..', import.meta.url));
const { ProtectedStore } = await import(pathToFileURL(path.join(webApiPlaybookRoot, 'lib', 'protected-store.mjs')).href);

export const STORE_NAME = 'toss-sharelink-state';
let protectedStore;
const store = () => protectedStore ??= new ProtectedStore();
const fail = code => Object.assign(new Error(code), { code });

export function storeSession(bundle) {
  validateBundle(bundle);
  const protectedBundle = {version:bundle.version,service:bundle.service,allowedOrigin:bundle.allowedOrigin,capturedAt:bundle.capturedAt,
    cookies:bundle.cookies,expectedOwner:bundle.expectedOwner,readRequests:bundle.readRequests};
  return { ...store().write(STORE_NAME, JSON.stringify(protectedBundle)), service: 'toss-sharelink', credentialScope: ORIGIN };
}

export function status() {
  return { service: 'toss-sharelink', ...store().status(STORE_NAME) };
}

function loadSession() {
  const raw = store().read(STORE_NAME);
  if (!raw) throw fail('TOSS_REAUTH_REQUIRED');
  try { return validateBundle(JSON.parse(raw)); } catch { throw fail('TOSS_STATE_INVALID'); }
}

// JSON data is returned only to the caller's memory. The CLI emits metadata, never auth or profile values.
export async function request(operation = 'member') {
  return requestWithDependencies(operation, {loadSession, fetchImpl:fetch, persistSession:storeSession});
}

// Journal: state intent → issued | rejected | needs_reconciliation (reconcile clears or confirms).
// One JSON file per option id under %LOCALAPPDATA%\affiliate-content-operations\toss-sharelink\links (no cookies, no profile data).
export function fileJournal(dir = path.join(process.env.LOCALAPPDATA || '.', 'affiliate-content-operations', 'toss-sharelink', 'links')) {
  const f = id => path.join(dir, `${Number(id)}.json`);
  return {
    read: id => { try { return JSON.parse(readFileSync(f(id), 'utf8')); } catch { return null; } },
    write: (id, entry) => { mkdirSync(dir, { recursive: true }); writeFileSync(f(id), JSON.stringify(entry, null, 2) + '\n'); },
  };
}

export async function issueLink(tacaItemId, { journal = fileJournal() } = {}) {
  return issueLinkWithDependencies(tacaItemId, { loadSession, fetchImpl: fetch, journal });
}

// Unclear or unknown state → read the issued-links list; found = issued (journal updated), else the intent is cleared.
export async function reconcileLink(tacaItemId, { journal = fileJournal() } = {}) {
  const hit = findIssued((await request('shopping-issued-links')).data, tacaItemId);
  if (hit) journal.write(hit.tacaItemId, { state: 'issued', ...hit, reconciled: true, at: new Date().toISOString() });
  else if (journal.read(tacaItemId)) journal.write(Number(tacaItemId), { state: 'not_found_cleared', tacaItemId: Number(tacaItemId), at: new Date().toISOString() });
  return { tacaItemId: Number(tacaItemId), found: Boolean(hit), shortUrl: hit?.shortUrl ?? null };
}

export async function productDetail(tacaItemId) {
  return requestWithDependencies('product-detail', { loadSession, fetchImpl: fetch, persistSession: storeSession, url: productDetailUrl(tacaItemId) });
}

export async function todayDealItemsPage(nextCursor = null) {
  return requestWithDependencies('shopping-today-deal-items', {
    loadSession, fetchImpl: fetch, persistSession: storeSession, url: todayDealItemsUrl(nextCursor),
  });
}

export async function checkSession() {
  const r = await request('member');
  return {service:'toss-sharelink',authenticated:true,ownerMatched:true,httpStatus:r.status,resultType:r.data.resultType,transport:'node-fetch',browserUsed:false,checkedAt:new Date().toISOString()};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const op = process.argv[2] || 'check';
    if (op === 'status') console.log(JSON.stringify(status(),null,2));
    else if (op === 'check') console.log(JSON.stringify(await checkSession(),null,2));
    else if (op === 'issue') console.log(JSON.stringify({ok:true,...await issueLink(process.argv[3])}));
    else if (op === 'reconcile') console.log(JSON.stringify({ok:true,...await reconcileLink(process.argv[3])}));
    else {
      const r = await request(op);
      console.log(JSON.stringify({operation:r.operation,httpStatus:r.status,resultType:r.data.resultType,path:r.path,queryKeys:r.queryKeys,responseSchema:schema(r.data),browserUsed:false,checkedAt:new Date().toISOString()},null,2));
    }
  } catch(error) { console.log(JSON.stringify({ok:false,code:/^[A-Z0-9_]+$/.test(error.code||'')?error.code:'TOSS_CLIENT_FAILED'})); process.exitCode=1; }
}
