import { ProtectedStore } from '../protected-store.mjs';
import { validateBundle, requestWithDependencies } from './toss/client-core.mjs';
import { loginHttp } from './toss/login-http.mjs';

const ORIGIN = 'https://sharelink.toss.im';
const STORE_NAME = 'toss-sharelink-state';
const CURATION_OPERATION = 'shopping-curation-sections';
const codePattern = /^[A-Z][A-Z0-9_]{1,100}$/;

export class TossWebAuthError extends Error {
  constructor(code, receipt = undefined) {
    super(code);
    this.name = 'WebAuthError';
    this.code = codePattern.test(code) ? code : 'TOSS_AUTH_FAILED';
    this.receipt = receipt;
  }
}

const fail = code => { throw new TossWebAuthError(code); };

function summarizeCuration(data) {
  const sections = data?.success?.sections;
  if (!Array.isArray(sections)) fail('TOSS_CURATION_SCHEMA_INVALID');
  const summary = { sectionCount: sections.length, itemCount: 0, todayDealEntryCount: 0 };
  for (const section of sections) {
    if (!Array.isArray(section?.items)) fail('TOSS_CURATION_SCHEMA_INVALID');
    for (const item of section.items) {
      summary.itemCount++;
      if (item?.todayDeal) summary.todayDealEntryCount++;
    }
  }
  return summary;
}

function normalizeError(error) {
  if (error instanceof TossWebAuthError) return error;
  return new TossWebAuthError(codePattern.test(error?.code || '') ? error.code : 'TOSS_AUTH_FAILED');
}

export function createTossAuth({ store = new ProtectedStore(), fetchImpl = fetch, login = loginHttp,
  now = () => new Date() } = {}) {
  function loadSession() {
    let raw;
    try { raw = store.read(STORE_NAME); }
    catch (error) { throw normalizeError(error); }
    if (!raw) fail('TOSS_REAUTH_REQUIRED');
    try { return validateBundle(JSON.parse(raw)); }
    catch (error) { throw normalizeError(error); }
  }

  function persistSession(bundle) {
    try {
      validateBundle(bundle);
      const safeBundle = { version: bundle.version, service: bundle.service, allowedOrigin: bundle.allowedOrigin,
        capturedAt: bundle.capturedAt, cookies: bundle.cookies, expectedOwner: bundle.expectedOwner,
        readRequests: bundle.readRequests };
      const saved = store.write(STORE_NAME, JSON.stringify(safeBundle));
      return { ...saved, service: 'toss-sharelink', credentialScope: ORIGIN };
    } catch (error) { throw normalizeError(error); }
  }

  async function request(operation) {
    try { return await requestWithDependencies(operation, { loadSession, fetchImpl, persistSession }); }
    catch (error) { throw normalizeError(error); }
  }

  async function health() {
    const member = await request('member');
    const curation = await request(CURATION_OPERATION);
    return { service: 'toss-sharelink', authenticated: true, ownerMatched: true,
      httpStatus: member.status, resultType: member.data.resultType, transport: 'node-fetch', browserUsed: false,
      ...summarizeCuration(curation.data), checkedAt: now().toISOString() };
  }

  async function performLogin(identity) {
    let curationSummary = null;
    let result;
    try {
      result = await login(identity, {
        loadBaseline: () => {
          let baseline;
          try { baseline = loadSession(); }
          catch (error) {
            if (error.code === 'TOSS_REAUTH_REQUIRED') fail('TOSS_LOGIN_OWNER_BASELINE_REQUIRED');
            throw error;
          }
          if (!baseline.expectedOwner?.publisherId || !baseline.readRequests?.member) fail('TOSS_LOGIN_OWNER_BASELINE_REQUIRED');
          return baseline;
        },
        fetchImpl,
        persistSession,
        check: async () => {
          const member = await request('member');
          return { service: 'toss-sharelink', authenticated: true, ownerMatched: true,
            httpStatus: member.status, resultType: member.data.resultType, browserUsed: false };
        },
        read: async operation => {
          const value = await request(operation);
          if (operation === CURATION_OPERATION) curationSummary = summarizeCuration(value.data);
          return value;
        },
      });
    } catch (error) { throw normalizeError(error); }
    finally {
      if (identity && typeof identity === 'object') {
        try { identity.email = ''; identity.password = ''; } catch {}
      }
    }
    if (result?.authenticated !== true || result?.ownerMatched !== true) {
      const error = new TossWebAuthError(codePattern.test(result?.code || '') ? result.code : 'TOSS_LOGIN_FAILED',
        { providerErrorCode: codePattern.test(result?.errorCode || '') ? result.errorCode : null,
          steps: Array.isArray(result?.steps) ? result.steps : [] });
      throw error;
    }
    return { service: 'toss-sharelink', authenticated: true, ownerMatched: true, httpStatus: 200,
      resultType: 'SUCCESS', browserUsed: false, executionMode: 'pure_http', stored: result.stored === true,
      passwordPersisted: false, credentialScope: ORIGIN,
      loginPostCount: Array.isArray(result.steps) ? result.steps.filter(step => step.method === 'POST').length : 0,
      ...curationSummary, checkedAt: now().toISOString() };
  }

  return {
    status() {
      try { return { service: 'toss-sharelink', ...store.status(STORE_NAME), currentAuthentication: 'not_checked' }; }
      catch (error) { throw normalizeError(error); }
    },
    health,
    // ensure is deliberately a read-only health check. It never logs in or renews credentials.
    ensure: health,
    login: performLogin,
  };
}

export { summarizeCuration };
