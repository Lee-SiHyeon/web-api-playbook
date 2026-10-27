import path from 'node:path';
import { ProtectedStore } from '../protected-store.mjs';
import { ScopedSession } from '../scoped-session.mjs';
import { withSessionLock } from '../session-lock.mjs';

export const SOOMGO_ACCOUNT_ORIGIN = 'https://api.soomgo.com';
export const SOOMGO_ACCOUNT_PATH = '/api2/users/me/';
export const SOOMGO_ACCOUNT_URL = SOOMGO_ACCOUNT_ORIGIN + SOOMGO_ACCOUNT_PATH;
export const SOOMGO_REQUESTS_PATH = '/v1/me/requests/sent';
export const SOOMGO_CHATS_PATH = '/api/v2.4/chats/';
export const SOOMGO_ACCOUNT_STORE = 'soomgo-account-state';
export const SOOMGO_REQUEST_PAGE_SIZE = 15;
export const SOOMGO_REQUEST_MAX_PAGES = 15;

const ORIGINS = [SOOMGO_ACCOUNT_ORIGIN];
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TOKEN_LENGTH = 8192;
const MAX_CURSOR_LENGTH = 4096;
const MAX_SOURCE_COUNT = 1_000_000_000;
const TOKEN = /^[A-Za-z0-9._~+/-]+={0,4}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTROL = /[\x00-\x1f\x7f]/;
const OWNER_CONSENTS = ['allow_use_marketing', 'allow_use_select_info', 'allow_news_letters'];

function fail(code, receipt) {
  const error = new Error(code);
  error.name = 'SoomgoAuthError';
  error.code = code;
  if (receipt) error.receipt = receipt;
  throw error;
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value, keys) => object(value) && Reflect.ownKeys(value).length === keys.length &&
  Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key));
const validEmail = value => typeof value === 'string' && value.length <= 320 && EMAIL.test(value) && !CONTROL.test(value);
const validText = (value, max, { allowEmpty = false } = {}) => typeof value === 'string' &&
  (allowEmpty || value.length > 0) && value.length <= max && !CONTROL.test(value);
const validToken = value => typeof value === 'string' && value.length <= MAX_TOKEN_LENGTH && TOKEN.test(value);
const validCursor = value => typeof value === 'string' && value.length > 0 && value.length <= MAX_CURSOR_LENGTH && !CONTROL.test(value);
const validIdentifier = value => Number.isSafeInteger(value) && value > 0 || validText(value, 128);
const safeDate = value => typeof value === 'string' && value.length <= 128 && !CONTROL.test(value) &&
  Number.isFinite(Date.parse(value)) ? value : null;
const safeCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const safeOptionalText = (value, max = 512) => validText(value, max) ? value : null;
const validIso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === value;

function checkedAt(now) {
  let value;
  try { value = now(); } catch { fail('SOOMGO_AUTH_CLOCK_INVALID'); }
  const millis = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(millis)) fail('SOOMGO_AUTH_CLOCK_INVALID');
  try { return new Date(millis).toISOString(); } catch { fail('SOOMGO_AUTH_CLOCK_INVALID'); }
}

export function validateSoomgoSessionImport(input) {
  if (!exactKeys(input, ['schemaVersion', 'service', 'expectedOwnerId', 'expectedEmail', 'authToken']) ||
      input.schemaVersion !== 1 || input.service !== 'soomgo' ||
      !Number.isSafeInteger(input.expectedOwnerId) || input.expectedOwnerId <= 0 ||
      !validEmail(input.expectedEmail) || !validToken(input.authToken)) {
    fail('SOOMGO_AUTH_IMPORT_INVALID');
  }
  return {
    version: 1,
    service: 'soomgo',
    expectedOwnerId: input.expectedOwnerId,
    expectedEmail: input.expectedEmail.trim().toLowerCase(),
    authToken: input.authToken,
  };
}

function expectedHeadersByOrigin(value) {
  if (!object(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, SOOMGO_ACCOUNT_ORIGIN)) {
    fail('SOOMGO_AUTH_STATE_INVALID');
  }
  const headers = value[SOOMGO_ACCOUNT_ORIGIN];
  if (!exactKeys(headers, ['authorization']) || typeof headers.authorization !== 'string' ||
      !headers.authorization.startsWith('Token ')) fail('SOOMGO_AUTH_STATE_INVALID');
  const token = headers.authorization.slice('Token '.length);
  if (!validToken(token)) fail('SOOMGO_AUTH_STATE_INVALID');
  return headers;
}

function safeSession(session, fetchImpl) {
  let serialized;
  try { serialized = session.toJSON(); } catch { fail('SOOMGO_AUTH_STATE_INVALID'); }
  if (JSON.stringify(serialized.allowedOrigins) !== JSON.stringify(ORIGINS) ||
      JSON.stringify(serialized.cookieOrigins) !== JSON.stringify([]) || serialized.allowLoopbackHttp !== false ||
      JSON.stringify(serialized.defaultHeaders) !== JSON.stringify({ accept: 'application/json' }) ||
      serialized.timeoutMs !== 15_000 || serialized.maxRequestBytes !== 1_024 ||
      serialized.maxResponseBytes !== MAX_RESPONSE_BYTES || serialized.maxRedirects !== 0 ||
      !Array.isArray(serialized.cookieJar?.cookies) || serialized.cookieJar.cookies.length !== 0) {
    fail('SOOMGO_AUTH_STATE_INVALID');
  }
  expectedHeadersByOrigin(serialized.headersByOrigin);
  try { return ScopedSession.fromJSON(serialized, { fetchImpl }); }
  catch { fail('SOOMGO_AUTH_STATE_INVALID'); }
}

function validateStoredState(state, fetchImpl) {
  const keys = ['version', 'service', 'expectedEmail', 'ownerId', 'verified', 'reauthRequired',
    'bootstrapMode', 'createdAt', 'updatedAt', 'lastVerifiedAt', 'session'];
  if (!exactKeys(state, keys) || state.version !== 1 || state.service !== 'soomgo' ||
      !validEmail(state.expectedEmail) || state.expectedEmail !== state.expectedEmail.trim().toLowerCase() ||
      !Number.isSafeInteger(state.ownerId) || state.ownerId <= 0 || typeof state.verified !== 'boolean' ||
      typeof state.reauthRequired !== 'boolean' || state.bootstrapMode !== 'manual_browser_token_import' ||
      !validIso(state.createdAt) || !validIso(state.updatedAt) || !validIso(state.lastVerifiedAt)) {
    fail('SOOMGO_AUTH_STATE_INVALID');
  }
  const transport = state.session;
  if (!object(transport) || JSON.stringify(transport.allowedOrigins) !== JSON.stringify(ORIGINS) ||
      JSON.stringify(transport.cookieOrigins) !== JSON.stringify([]) || transport.allowLoopbackHttp !== false ||
      JSON.stringify(transport.defaultHeaders) !== JSON.stringify({ accept: 'application/json' }) ||
      transport.timeoutMs !== 15_000 || transport.maxRequestBytes !== 1_024 ||
      transport.maxResponseBytes !== MAX_RESPONSE_BYTES || transport.maxRedirects !== 0 ||
      !Array.isArray(transport.cookieJar?.cookies) || transport.cookieJar.cookies.length !== 0) {
    fail('SOOMGO_AUTH_STATE_INVALID');
  }
  expectedHeadersByOrigin(transport.headersByOrigin);
  let session;
  try { session = ScopedSession.fromJSON(transport, { fetchImpl }); }
  catch { fail('SOOMGO_AUTH_STATE_INVALID'); }
  return { state, session: safeSession(session, fetchImpl) };
}

function makeSession(token, fetchImpl, scheme = 'Token') {
  if (!validToken(token) || !['Token', 'Bearer'].includes(scheme)) fail('SOOMGO_AUTH_TOKEN_INVALID');
  try {
    return new ScopedSession({
      allowedOrigins: ORIGINS,
      cookieOrigins: [],
      defaultHeaders: { accept: 'application/json' },
      headersByOrigin: { [SOOMGO_ACCOUNT_ORIGIN]: { authorization: `${scheme} ${token}` } },
      timeoutMs: 15_000,
      maxRequestBytes: 1_024,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      maxRedirects: 0,
      fetchImpl,
    });
  } catch { fail('SOOMGO_AUTH_TOKEN_INVALID'); }
}

function ownerSchema(data, receipt) {
  if (!object(data) || !Number.isSafeInteger(data.id) || data.id <= 0 || !validEmail(data.email) ||
      !validText(data.phone, 256, { allowEmpty: true }) || !validText(data.first_name, 256, { allowEmpty: true }) ||
      !validText(data.last_name, 256, { allowEmpty: true }) || typeof data.is_certify_name !== 'boolean' ||
      !(data.provider === null || object(data.provider)) || !validText(data.social_sign_up, 256, { allowEmpty: true }) ||
      OWNER_CONSENTS.some(key => Object.hasOwn(data, key) && typeof data[key] !== 'boolean')) {
    fail('SOOMGO_AUTH_OWNER_SCHEMA_INVALID', receipt);
  }
  return { ownerId: data.id, email: data.email.trim().toLowerCase() };
}

function safeMime(value) {
  if (typeof value !== 'string') return null;
  const mime = value.split(';', 1)[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) ? mime : null;
}

function responseReceipt(status, mime, bytes, checkedAtValue, { path = SOOMGO_ACCOUNT_PATH, authorizationScheme = 'Token' } = {}) {
  return {
    method: 'GET', origin: SOOMGO_ACCOUNT_ORIGIN, path, authorizationScheme,
    httpStatus: status, mime: safeMime(mime), responseBytes: bytes,
    checkedAt: checkedAtValue, browserUsed: false, authenticated: false,
    credentialsUsed: true, cookiesSent: false, readOnly: true,
  };
}

function transportReceipt(causeCode, checkedAtValue, { path = SOOMGO_ACCOUNT_PATH, authorizationScheme = 'Token' } = {}) {
  const safeCauseCode = typeof causeCode === 'string' && /^SCOPED_SESSION_[A-Z_]+$/.test(causeCode)
    ? causeCode : 'TRANSPORT_ERROR';
  return {
    method: 'GET', origin: SOOMGO_ACCOUNT_ORIGIN, path, authorizationScheme,
    checkedAt: checkedAtValue, browserUsed: false, authenticated: false,
    credentialsUsed: true, cookiesSent: false, readOnly: true, causeCode: safeCauseCode,
  };
}

function requestOptions(input = {}) {
  if (!object(input) || Reflect.ownKeys(input).some(key => typeof key !== 'string' ||
      !['status', 'maxPages', 'after'].includes(key))) {
    fail('SOOMGO_AUTH_REQUEST_OPTIONS_INVALID');
  }
  const status = input.status ?? 'opened';
  const maxPages = input.maxPages ?? 1;
  const after = input.after ?? null;
  if (!['opened', 'closed_expired'].includes(status) || !Number.isSafeInteger(maxPages) ||
      maxPages < 1 || maxPages > SOOMGO_REQUEST_MAX_PAGES ||
      !(after === null || validCursor(after))) fail('SOOMGO_AUTH_REQUEST_OPTIONS_INVALID');
  return { status, maxPages, after, sourceStatus: status === 'opened' ? 'opened' : 'closed,expired' };
}

function requestsUrl(sourceStatus, after) {
  const query = new URLSearchParams();
  query.set('status', sourceStatus);
  query.set('limit', String(SOOMGO_REQUEST_PAGE_SIZE));
  if (after !== null) query.set('after', after);
  return `${SOOMGO_ACCOUNT_ORIGIN}${SOOMGO_REQUESTS_PATH}?${query.toString()}`;
}

function requestPageSchema(data, receipt) {
  const response = data?.response;
  const pagination = response?.pagination;
  if (!object(data) || data.code !== 0 || !validText(data.reason, 1_000, { allowEmpty: true }) ||
      !validText(data.request, 2_048, { allowEmpty: true }) || !object(response) ||
      !Number.isSafeInteger(response.totalOpenedCount) || response.totalOpenedCount < 0 ||
      !Number.isSafeInteger(response.totalCompletedCount) || response.totalCompletedCount < 0 ||
      typeof response.legacyExisting !== 'boolean' || !Array.isArray(response.items) ||
      response.items.length > SOOMGO_REQUEST_PAGE_SIZE || !object(pagination) ||
      !Number.isSafeInteger(pagination.count) || pagination.count < 0 || pagination.count > MAX_SOURCE_COUNT ||
      pagination.limit !== SOOMGO_REQUEST_PAGE_SIZE ||
      !(pagination.before === null || validCursor(pagination.before)) ||
      !(pagination.after === null || validCursor(pagination.after))) {
    fail('SOOMGO_AUTH_REQUEST_SCHEMA_INVALID', receipt);
  }
  return {
    items: response.items.map(item => projectRequestItem(item, receipt)),
    totalOpenedCount: response.totalOpenedCount,
    totalCompletedCount: response.totalCompletedCount,
    legacyExisting: response.legacyExisting,
    pagination: {
      count: pagination.count,
      before: pagination.before,
      after: pagination.after,
      limit: pagination.limit,
    },
  };
}

function projectRequestItem(item, receipt) {
  if (!object(item) || !validIdentifier(item.id)) fail('SOOMGO_AUTH_REQUEST_ROW_SCHEMA_INVALID', receipt);
  const service = object(item.service) ? {
    id: validIdentifier(item.service.id) ? item.service.id : null,
    name: safeOptionalText(item.service.name),
  } : null;
  const progressStatus = object(item.progressStatus) ? {
    type: Number.isInteger(item.progressStatus.type) && item.progressStatus.type >= 1 && item.progressStatus.type <= 4
      ? item.progressStatus.type : null,
    name: safeOptionalText(item.progressStatus.name),
  } : null;
  return {
    id: item.id,
    service,
    status: ['opened', 'expired', 'closed'].includes(item.status) ? item.status : null,
    progressStatus,
    startedAt: safeDate(item.startedAt),
    endedAt: safeDate(item.endedAt),
    quoteCount: safeCount(item.quoteCount),
    unreadQuoteCnt: safeCount(item.unreadQuoteCnt),
  };
}

function chatPageSchema(data, receipt) {
  if (!object(data) || !Object.hasOwn(data, 'next') || !Object.hasOwn(data, 'cursor') ||
      !(data.next === null || validCursor(data.next)) || !(data.cursor === null || validCursor(data.cursor)) ||
      !Array.isArray(data.results) || !Array.isArray(data.escrow_events_meta)) {
    fail('SOOMGO_AUTH_CHAT_SCHEMA_INVALID', receipt);
  }
  return {
    results: data.results.map(item => projectChatItem(item, receipt)),
    escrowEventsMetaCount: data.escrow_events_meta.length,
    nextPresent: data.next !== null,
    cursorPresent: data.cursor !== null,
  };
}

function projectChatItem(item, receipt) {
  if (!object(item) || !validIdentifier(item.id)) fail('SOOMGO_AUTH_CHAT_ROW_SCHEMA_INVALID', receipt);
  return {
    id: item.id,
    updated_at: safeDate(item.updated_at),
    new_message_count: safeCount(item.new_message_count),
    last_message_type: typeof item.last_message_type === 'string' && validText(item.last_message_type, 128)
      ? item.last_message_type
      : Number.isSafeInteger(item.last_message_type) ? item.last_message_type : null,
  };
}

export function createSoomgoAuth({ store = new ProtectedStore(), fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (!store || typeof store.read !== 'function' || typeof store.write !== 'function' ||
      typeof store.status !== 'function' || typeof fetchImpl !== 'function' || typeof now !== 'function') {
    fail('SOOMGO_AUTH_CONFIGURATION_INVALID');
  }
  const locked = callback => withSessionLock(callback, {
    root: path.join(store.directory, 'locks'), key: SOOMGO_ACCOUNT_STORE,
  });
  const save = state => store.write(SOOMGO_ACCOUNT_STORE, JSON.stringify(state));

  function loadState() {
    const raw = store.read(SOOMGO_ACCOUNT_STORE);
    if (!raw) fail('SOOMGO_AUTH_SESSION_MISSING');
    let parsed;
    try { parsed = JSON.parse(raw); } catch { fail('SOOMGO_AUTH_STATE_INVALID'); }
    return validateStoredState(parsed, fetchImpl);
  }

  async function readJson(session, url, { path, operation, authorizationScheme }) {
    let response;
    try {
      response = await session.request(url, {
        method: 'GET', headers: { accept: 'application/json' },
      });
    } catch (error) {
      const code = error?.code === 'SCOPED_SESSION_TIMEOUT' ? 'SOOMGO_AUTH_TIMEOUT' :
        error?.code === 'SCOPED_SESSION_REDIRECT_LIMIT' || error?.code === 'SCOPED_SESSION_REDIRECT_SCOPE' ||
          error?.code === 'SCOPED_SESSION_REDIRECT_AUTO_FOLLOWED' ? 'SOOMGO_AUTH_REDIRECT_REJECTED' :
            'SOOMGO_AUTH_TRANSPORT_FAILED';
      fail(code, { ...transportReceipt(error?.code, checkedAt(now), { path, authorizationScheme }), operation });
    }
    const body = typeof response.raw === 'string' ? response.raw : '';
    const mime = response.headers?.['content-type'] ?? null;
    if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
      fail('SOOMGO_AUTH_RESPONSE_INVALID');
    }
    const receipt = { ...responseReceipt(response.status, mime, Buffer.byteLength(body), checkedAt(now), {
      path, authorizationScheme,
    }), operation };
    const normalizedMime = safeMime(mime);
    if (response.status === 204 || response.status === 401) fail('SOOMGO_AUTH_REAUTH_REQUIRED', receipt);
    if (response.status === 403) fail('SOOMGO_AUTH_FORBIDDEN', receipt);
    if (response.status === 429) fail('SOOMGO_AUTH_THROTTLED', receipt);
    if (response.status >= 500) fail('SOOMGO_AUTH_SERVER_ERROR', receipt);
    if (response.status !== 200 || normalizedMime === 'text/html') fail(
      normalizedMime === 'text/html' ? 'SOOMGO_AUTH_CHALLENGE_HTML' : 'SOOMGO_AUTH_RESPONSE_INVALID', receipt);
    if (normalizedMime !== 'application/json') fail('SOOMGO_AUTH_RESPONSE_INVALID', receipt);
    let data;
    try { data = JSON.parse(body); } catch { fail('SOOMGO_AUTH_RESPONSE_INVALID', receipt); }
    return { data, receipt };
  }

  async function readOwner(session, { expectedEmail, expectedOwnerId, operation }) {
    const { data, receipt } = await readJson(session, SOOMGO_ACCOUNT_URL, {
      operation, path: SOOMGO_ACCOUNT_PATH, authorizationScheme: 'Token',
    });
    const owner = ownerSchema(data, receipt);
    if (owner.email !== expectedEmail || owner.ownerId !== expectedOwnerId) {
      fail('SOOMGO_AUTH_OWNER_MISMATCH', receipt);
    }
    return { receipt, owner };
  }

  async function verifyStored(operation) {
    return locked(async () => {
      const { state, session } = loadState();
      if (state.reauthRequired) {
        fail('SOOMGO_AUTH_REAUTH_REQUIRED', {
          method: 'GET', origin: SOOMGO_ACCOUNT_ORIGIN, path: SOOMGO_ACCOUNT_PATH,
          checkedAt: state.updatedAt, browserUsed: false, authenticated: false,
          credentialsUsed: false, cookiesSent: false, readOnly: true, operation, requestCount: 0,
        });
      }
      try {
        const result = await readOwner(session, {
          operation, expectedEmail: state.expectedEmail, expectedOwnerId: state.ownerId,
        });
        const verifiedAt = checkedAt(now);
        save({ ...state, verified: true, reauthRequired: false, updatedAt: verifiedAt,
          lastVerifiedAt: verifiedAt, session: session.toJSON() });
        return {
          service: 'soomgo', command: operation,
          authenticated: true, ownerVerified: true, ownerIdPinned: true,
          browserUsed: false, readOnly: true, requestCount: 1,
          credentialProvider: store.status(SOOMGO_ACCOUNT_STORE).provider,
          persistent: store.status(SOOMGO_ACCOUNT_STORE).persistent,
          bootstrapMode: 'manual_browser_token_import', readMode: 'pure_http',
          renewal: 'not_implemented',
          receipt: { ...result.receipt, authenticated: true, ownerVerified: true },
        };
      } catch (error) {
        state.verified = false;
        state.updatedAt = checkedAt(now);
        if (error?.code === 'SOOMGO_AUTH_REAUTH_REQUIRED' || error?.code === 'SOOMGO_AUTH_OWNER_MISMATCH') {
          state.reauthRequired = true;
        }
        save({ ...state, session: session.toJSON() });
        throw error;
      }
    });
  }

  function reauthReceipt(operation) {
    return {
      method: 'GET', origin: SOOMGO_ACCOUNT_ORIGIN, path: SOOMGO_ACCOUNT_PATH,
      checkedAt: checkedAt(now), browserUsed: false, authenticated: false,
      credentialsUsed: false, cookiesSent: false, readOnly: true, operation, requestCount: 0,
    };
  }

  async function withOwnerPreflight(operation, run) {
    return locked(async () => {
      const { state, session } = loadState();
      if (state.reauthRequired) fail('SOOMGO_AUTH_REAUTH_REQUIRED', reauthReceipt(operation));

      let ownerPreflight;
      try {
        ownerPreflight = await readOwner(session, {
          operation: `${operation}-owner-preflight`,
          expectedEmail: state.expectedEmail,
          expectedOwnerId: state.ownerId,
        });
      } catch (error) {
        state.verified = false;
        state.updatedAt = checkedAt(now);
        if (error?.code === 'SOOMGO_AUTH_REAUTH_REQUIRED' || error?.code === 'SOOMGO_AUTH_OWNER_MISMATCH') {
          state.reauthRequired = true;
        }
        save({ ...state, session: session.toJSON() });
        if (error?.receipt) error.receipt = { ...error.receipt, requestCount: 1 };
        throw error;
      }

      const preflightAt = checkedAt(now);
      state.verified = true;
      state.reauthRequired = false;
      state.updatedAt = preflightAt;
      state.lastVerifiedAt = preflightAt;
      const safeOwnerReceipt = { ...ownerPreflight.receipt, authenticated: true, ownerVerified: true };
      let operationResult;
      try {
        const authHeader = expectedHeadersByOrigin(session.toJSON().headersByOrigin).authorization;
        const token = authHeader.slice('Token '.length);
        operationResult = await run({ state, session, token, ownerReceipt: safeOwnerReceipt });
        state.updatedAt = checkedAt(now);
        save({ ...state, session: session.toJSON() });
        const stored = store.status(SOOMGO_ACCOUNT_STORE);
        const { operationRequests = 1, receipt: operationReceipt, ...result } = operationResult;
        return {
          service: 'soomgo', command: operation,
          authenticated: true, ownerVerified: true, ownerIdPinned: true,
          browserUsed: false, readOnly: true,
          requestCount: 1 + operationRequests,
          credentialProvider: stored.provider, persistent: stored.persistent,
          bootstrapMode: 'manual_browser_token_import', readMode: 'pure_http',
          renewal: 'not_implemented',
          ...result,
          receipt: { ownerPreflight: safeOwnerReceipt, ...(operationReceipt ?? {}) },
        };
      } catch (error) {
        state.updatedAt = checkedAt(now);
        if (error?.code === 'SOOMGO_AUTH_REAUTH_REQUIRED') {
          state.reauthRequired = true;
          state.verified = false;
        }
        save({ ...state, session: session.toJSON() });
        if (error?.receipt) error.receipt = { ...error.receipt, ownerPreflight: safeOwnerReceipt };
        else error.receipt = { operation, ownerPreflight: safeOwnerReceipt };
        if (error?.partialResult) {
          error.partialResult = {
            service: 'soomgo', command: operation,
            authenticated: true, ownerVerified: true, ownerIdPinned: true,
            browserUsed: false, readOnly: true,
            requestCount: 1 + (error.partialResult.operationRequests ?? 0),
            credentialProvider: store.status(SOOMGO_ACCOUNT_STORE).provider,
            persistent: store.status(SOOMGO_ACCOUNT_STORE).persistent,
            bootstrapMode: 'manual_browser_token_import', readMode: 'pure_http',
            renewal: 'not_implemented',
            ...error.partialResult,
            receipt: { ownerPreflight: safeOwnerReceipt, ...(error.partialResult.receipt ?? {}) },
          };
        }
        throw error;
      }
    });
  }

  async function readRequests(input = {}) {
    const options = requestOptions(input);
    return withOwnerPreflight('requests', async ({ token }) => {
      const bearerSession = makeSession(token, fetchImpl, 'Bearer');
      const items = [];
      const requestIds = new Set();
      const pageReceipts = [];
      const seenCursors = new Set();
      let cursor = options.after;
      let attemptedPages = 0;
      let pageCount = 0;
      let duplicateItemCount = 0;
      let totals = null;
      let legacyExisting = false;
      let stopReason = null;
      const startedWithAfter = options.after !== null;

      const result = (status, { resumeAfter = null, unstable = false } = {}) => {
        const paginationComplete = status === 'complete' || status === 'complete_with_coverage_gap';
        const statusCountConsistent = paginationComplete && totals !== null &&
          (options.status === 'opened'
            ? items.length === totals.totalOpenedCount
            : items.length >= totals.totalCompletedCount);
        // The source `pagination.count` meaning is not established. Accept either
        // per-page counts or a repeated overall count; never equate it with limit.
        const paginationCountConsistent = paginationComplete && pageReceipts.length > 0 && (
          pageReceipts.every(page => page.pagination.count === page.itemCount) ||
          pageReceipts.every(page => page.pagination.count === items.length));
        const sourceCountContradiction = paginationComplete &&
          (statusCountConsistent === false || paginationCountConsistent === false);
        const coverageGaps = [
          ...(legacyExisting ? ['legacyExisting'] : []),
          ...(startedWithAfter ? ['resumed_window_only'] : []),
          ...(sourceCountContradiction ? ['source_total_mismatch'] : []),
        ];
        const completeForSelectedStatus = paginationComplete && coverageGaps.length === 0 && !unstable;
        return {
          status,
          statusFilter: options.status,
          sourceStatus: options.sourceStatus,
          pageSize: SOOMGO_REQUEST_PAGE_SIZE,
          maxPages: options.maxPages,
          pageCount,
          operationRequests: attemptedPages,
          items: [...items],
          duplicateItemCount,
          totalOpenedCount: totals?.totalOpenedCount ?? null,
          totalCompletedCount: totals?.totalCompletedCount ?? null,
          legacyExisting,
          sourceCountReconciliation: paginationComplete ? {
            returnedRows: items.length,
            statusCountConsistent,
            paginationCountConsistent,
          } : null,
          startedWithAfter,
          resumedWindowOnly: startedWithAfter,
          sourceCountReconciliation: paginationComplete && totals !== null ? {
            returnedRows: items.length,
            comparator: options.status === 'opened' ? 'equals_totalOpenedCount' : 'at_least_totalCompletedCount',
            expectedCount: options.status === 'opened' ? totals.totalOpenedCount : totals.totalCompletedCount,
            consistent: !sourceCountContradiction,
          } : null,
          paginationComplete,
          completeForSelectedStatus,
          coverage: {
            scope: 'source_reported_status_filter',
            legacyExisting,
            resumedWindowOnly: startedWithAfter,
            gaps: coverageGaps,
            entireSoomgoCatalogComplete: false,
          },
          ...(cursor !== null && !unstable ? { nextAfter: cursor } : {}),
          ...(resumeAfter !== null ? { resumeAfter } : {}),
          ...(stopReason ? { stopReason } : {}),
          ...(unstable ? { unstable: true } : {}),
          receipt: { pages: pageReceipts },
        };
      };

      for (let index = 0; index < options.maxPages; index++) {
        if (cursor !== null && seenCursors.has(cursor)) {
          stopReason = 'repeated_after_cursor';
          const partial = result('unstable', { unstable: true });
          const error = Object.assign(new Error('SOOMGO_AUTH_REQUESTS_UNSTABLE'), {
            code: 'SOOMGO_AUTH_REQUESTS_UNSTABLE',
            receipt: { path: SOOMGO_REQUESTS_PATH, authorizationScheme: 'Bearer', operation: 'requests' },
            partialResult: partial,
          });
          throw error;
        }
        if (cursor !== null) seenCursors.add(cursor);
        attemptedPages++;
        const url = requestsUrl(options.sourceStatus, cursor);
        let response;
        let page;
        try {
          response = await readJson(bearerSession, url, {
            operation: 'requests', path: SOOMGO_REQUESTS_PATH, authorizationScheme: 'Bearer',
          });
          page = requestPageSchema(response.data, response.receipt);
        } catch (error) {
          stopReason = 'request_failed';
          if (error?.receipt) error.receipt = {
            ...error.receipt,
            page: pageCount + 1,
            query: {
              status: options.sourceStatus,
              limit: SOOMGO_REQUEST_PAGE_SIZE,
              afterPresent: cursor !== null,
            },
          };
          error.partialResult = result('partial', { resumeAfter: cursor });
          throw error;
        }

        const pageReceipt = {
          ...response.receipt,
          authenticated: true,
          ownerVerified: true,
          page: pageCount + 1,
          query: {
            status: options.sourceStatus,
            limit: SOOMGO_REQUEST_PAGE_SIZE,
            afterPresent: cursor !== null,
          },
          itemCount: page.items.length,
          pagination: {
            count: page.pagination.count,
            limit: page.pagination.limit,
            beforePresent: page.pagination.before !== null,
            afterPresent: page.pagination.after !== null,
          },
          legacyExisting: page.legacyExisting,
        };
        let pageDuplicates = 0;
        for (const item of page.items) {
          const idKey = String(item.id);
          if (requestIds.has(idKey)) {
            duplicateItemCount++;
            pageDuplicates++;
          } else {
            requestIds.add(idKey);
            items.push(item);
          }
        }
        if (pageDuplicates) pageReceipt.duplicateItemCount = pageDuplicates;
        pageReceipts.push(pageReceipt);
        pageCount++;
        const nextMetrics = {
          totalOpenedCount: page.totalOpenedCount,
          totalCompletedCount: page.totalCompletedCount,
          legacyExisting: page.legacyExisting,
        };
        const metricsChanged = totals && (totals.totalOpenedCount !== nextMetrics.totalOpenedCount ||
            totals.totalCompletedCount !== nextMetrics.totalCompletedCount ||
            totals.legacyExisting !== nextMetrics.legacyExisting);
        totals = nextMetrics;
        legacyExisting = page.legacyExisting;
        cursor = page.pagination.after;
        if (pageDuplicates) {
          stopReason = 'duplicate_request_id';
          const partial = result('unstable', { unstable: true });
          throw Object.assign(new Error('SOOMGO_AUTH_REQUESTS_UNSTABLE'), {
            code: 'SOOMGO_AUTH_REQUESTS_UNSTABLE', receipt: pageReceipt, partialResult: partial,
          });
        }
        if (metricsChanged) {
          stopReason = 'source_counts_changed';
          const partial = result('unstable', { unstable: true });
          throw Object.assign(new Error('SOOMGO_AUTH_REQUESTS_UNSTABLE'), {
            code: 'SOOMGO_AUTH_REQUESTS_UNSTABLE', receipt: pageReceipt, partialResult: partial,
          });
        }
        if (cursor !== null && seenCursors.has(cursor)) {
          stopReason = 'repeated_after_cursor';
          const partial = result('unstable', { unstable: true });
          throw Object.assign(new Error('SOOMGO_AUTH_REQUESTS_UNSTABLE'), {
            code: 'SOOMGO_AUTH_REQUESTS_UNSTABLE', receipt: pageReceipt, partialResult: partial,
          });
        }
        if (cursor === null) break;
      }

      const countContradiction = totals !== null && (options.status === 'opened'
        ? items.length !== totals.totalOpenedCount
        : items.length < totals.totalCompletedCount) || pageReceipts.length > 0 &&
          !(pageReceipts.every(page => page.pagination.count === page.itemCount) ||
            pageReceipts.every(page => page.pagination.count === items.length));
      const status = cursor !== null ? 'partial' :
        legacyExisting || startedWithAfter || countContradiction ? 'complete_with_coverage_gap' : 'complete';
      return result(status, { resumeAfter: null });
    });
  }

  async function readChats(...args) {
    if (args.length) fail('SOOMGO_AUTH_CHAT_OPTIONS_INVALID');
    return withOwnerPreflight('chats', async ({ session }) => {
      const url = `${SOOMGO_ACCOUNT_ORIGIN}${SOOMGO_CHATS_PATH}?role=customer`;
      const response = await readJson(session, url, {
        operation: 'chats', path: SOOMGO_CHATS_PATH, authorizationScheme: 'Token',
      });
      const page = chatPageSchema(response.data, response.receipt);
      return {
        status: 'first_page_only',
        pageCount: 1,
        complete: false,
        results: page.results,
        escrowEventsMetaCount: page.escrowEventsMetaCount,
        pagination: {
          nextPresent: page.nextPresent,
          cursorPresent: page.cursorPresent,
          followupQueryVerified: false,
        },
        operationRequests: 1,
        receipt: {
          response: {
            ...response.receipt,
            authenticated: true,
            ownerVerified: true,
            query: { role: 'customer' },
            resultCount: page.results.length,
            escrowEventsMetaCount: page.escrowEventsMetaCount,
            pagination: {
              nextPresent: page.nextPresent,
              cursorPresent: page.cursorPresent,
            },
          },
        },
      };
    });
  }

  return Object.freeze({
    status() {
      const stored = store.status(SOOMGO_ACCOUNT_STORE);
      return {
        service: 'soomgo', configured: stored.available, currentAuthentication: 'not_checked',
        credentialProvider: stored.provider, persistent: stored.persistent,
        browserUsed: false, requestCount: 0,
      };
    },
    importSession(input) {
      return locked(async () => {
        const imported = validateSoomgoSessionImport(input);
        let candidate;
        try { candidate = makeSession(imported.authToken, fetchImpl); }
        finally { imported.authToken = ''; }
        const previousRaw = store.read(SOOMGO_ACCOUNT_STORE);
        let previous = null;
        if (previousRaw) {
          let parsed;
          try { parsed = JSON.parse(previousRaw); } catch { fail('SOOMGO_AUTH_STATE_INVALID'); }
          previous = validateStoredState(parsed, fetchImpl).state;
          if (previous.expectedEmail !== imported.expectedEmail || previous.ownerId !== imported.expectedOwnerId) {
            fail('SOOMGO_AUTH_OWNER_MISMATCH');
          }
        }
        try {
          const result = await readOwner(candidate, {
            operation: 'session-import', expectedEmail: imported.expectedEmail,
            expectedOwnerId: imported.expectedOwnerId,
          });
          const verifiedAt = checkedAt(now);
          const state = {
            version: 1,
            service: 'soomgo',
            expectedEmail: imported.expectedEmail,
            ownerId: imported.expectedOwnerId,
            verified: true,
            reauthRequired: false,
            bootstrapMode: 'manual_browser_token_import',
            createdAt: previous?.createdAt ?? verifiedAt,
            updatedAt: verifiedAt,
            lastVerifiedAt: verifiedAt,
            session: candidate.toJSON(),
          };
          save(state);
          const stored = store.status(SOOMGO_ACCOUNT_STORE);
          return {
            service: 'soomgo', command: 'session-import', stored: true,
            authenticated: true, ownerVerified: true, ownerIdPinned: true,
            credentialProvider: stored.provider, persistent: stored.persistent,
            bootstrapMode: 'manual_browser_token_import', readMode: 'pure_http',
            browserUsed: false, requestCount: 1, renewal: 'not_implemented',
            receipt: { ...result.receipt, authenticated: true, ownerVerified: true },
          };
        } finally {
          // The imported token lives only in the scoped Authorization header
          // after this point; never retain the validator's separate copy.
          imported.authToken = '';
        }
      });
    },
    owner: () => verifyStored('owner'),
    health: () => verifyStored('health'),
    verify: () => verifyStored('verify'),
    requests: readRequests,
    chats: readChats,
  });
}
