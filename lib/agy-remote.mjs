import { randomUUID, createHash } from 'node:crypto';
import { ScopedSession } from './scoped-session.mjs';
import { WriteJournal } from './write-journal.mjs';
import { readAgySummarySnapshot, agyConnectEnvelope } from './agy-remote-stream.mjs';
import { CookieJar } from 'tough-cookie';

export const AGY_ORIGIN = 'https://antigravity.google.com';
export const AGY_STORE = 'agy-remote';
export const AGY_API = '/$rpc/devtools_jetski_boq_api_proto.ApiService/';
export const AGY_LS = '/exa.language_server_pb.LanguageServerService/';
export const AGY_AUTH_HEADERS = Object.freeze(['authorization', 'x-goog-api-key', 'x-goog-authuser',
  'origin', 'x-origin', 'x-referer', 'x-user-agent', 'x-goog-encode-response-if-executable']);
const MAX_AGE = 60 * 60 * 1000; // Client policy, not a measured Google expiration.
const fail = (code, extra = {}) => { throw Object.assign(new Error(code), { code, ...extra }); };
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const text = (x, max = 512) => typeof x === 'string' && x.trim().length > 0 && x.length <= max && !/[\0\r\n]/.test(x);
const uuid = x => typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const signingCookies = Object.freeze({ SAPISIDHASH: 'SAPISID', SAPISID1PHASH: '__Secure-1PAPISID', SAPISID3PHASH: '__Secure-3PAPISID' });
const cookieValues = session => {
  try { return new Map(CookieJar.deserializeSync(session.cookieJar).getCookiesSync(AGY_ORIGIN + AGY_API).map(c => [c.key, c.value])); }
  catch { fail('AGY_STATE_INVALID'); }
};
const authDigest = (timestamp, cookie) => createHash('sha1').update(`${timestamp} ${cookie} ${AGY_ORIGIN}`).digest('hex');

/** Promote only a signing format that exactly reproduces the observed first-party authorization. */
export function deriveAgySigning(session) {
  const auth = session.headersByOrigin?.[AGY_ORIGIN]?.authorization;
  if (typeof auth !== 'string') return null;
  const parts = auth.split(' '); if (!parts.length || parts.length % 2) return null;
  const cookies = cookieValues(session), result = [], seen = new Set();
  for (let i = 0; i < parts.length; i += 2) {
    const scheme = parts[i], name = signingCookies[scheme], match = /^(\d{1,16})_([a-f0-9]{40})$/.exec(parts[i + 1]);
    const cookie = cookies.get(name);
    if (!name || !cookie || !match || seen.has(scheme) || authDigest(match[1], cookie) !== match[2]) return null;
    result.push({ scheme, cookieName: name }); seen.add(scheme);
  }
  return result.length ? result : null;
}

function freshAuthorization(session, schemes, now) {
  const cookies = cookieValues(session), timestamp = String(Math.floor(now / 1000));
  return schemes.map(({ scheme, cookieName }) => {
    const cookie = cookies.get(cookieName); if (!cookie) fail('AGY_REAUTH_REQUIRED');
    return `${scheme} ${timestamp}_${authDigest(timestamp, cookie)}`;
  }).join(' ');
}
const methods = new Set(['GetUserStatus', 'GetAllCascadeTrajectories', 'GetCascadeTrajectory',
  'GetCascadeTrajectorySteps', 'GetCascadeModelConfigData', 'ListProjects', 'ReadProjects',
  'StartCascade', 'SendUserCascadeMessage', 'UpdateConversationAnnotations',
  'CancelCascadeInvocation', 'DeleteCascadeTrajectory', 'JetboxDeleteSummary', 'JetboxWriteSummary']);

export function parseAgyJson(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 32 * 1024 * 1024) fail('AGY_RESPONSE_INVALID');
  try { return JSON.parse(raw.replace(/^\)\]\}'\s*/, '')); }
  catch { fail('AGY_RESPONSE_INVALID'); }
}

export function decodeAgyInstances(data) {
  if (!Array.isArray(data) || !Array.isArray(data[0]) || data[0].length > 1000) fail('AGY_INSTANCES_SCHEMA');
  const ids = new Set();
  return data[0].map(row => {
    if (!Array.isArray(row) || !text(row[0], 160) || !Array.isArray(row[1]) || !text(row[1][0], 160)
      || !Number.isSafeInteger(row[2]) || ids.has(row[0])) fail('AGY_INSTANCES_SCHEMA');
    ids.add(row[0]);
    return { id: row[0], name: row[1][0], version: row[1][1] ?? null,
      status: row[2] === 1 ? 'online' : row[2] === 2 ? 'offline' : 'unknown', statusCode: row[2] };
  });
}

export function decodeAgyProxy(data) {
  if (!Array.isArray(data) || typeof data[0] !== 'string' || !Array.isArray(data[1] ?? [])) fail('AGY_PROXY_SCHEMA');
  const headers = Object.fromEntries((data[1] ?? []).map(pair => {
    if (!Array.isArray(pair) || !text(pair[0], 256) || typeof pair[1] !== 'string') fail('AGY_PROXY_SCHEMA');
    return [pair[0].toLowerCase(), pair[1]];
  }));
  if (headers['grpc-status'] && headers['grpc-status'] !== '0') fail('AGY_REMOTE_REJECTED');
  const result = parseAgyJson(Buffer.from(data[0], 'base64').toString('utf8'));
  if (result?.error?.code === 'unauthenticated') fail('AGY_REMOTE_AUTH_REQUIRED');
  if (result?.error?.code === 'permission_denied') fail('AGY_REMOTE_PERMISSION_DENIED');
  if (!object(result) || result.error || typeof result.code === 'string' && typeof result.message === 'string') fail('AGY_REMOTE_REJECTED');
  return result;
}

export function importAgyState({ expectedEmail, headers, cookies }, { now = Date.now } = {}) {
  if (!text(expectedEmail, 320) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(expectedEmail) || !object(headers)) fail('AGY_AUTH_INPUT');
  const selected = {};
  for (const [key, value] of Object.entries(headers)) {
    if (AGY_AUTH_HEADERS.includes(key.toLowerCase())) selected[key.toLowerCase()] = value;
  }
  if (!text(selected.authorization, 8192) || !text(selected['x-goog-api-key'], 512)) fail('AGY_AUTH_INPUT');
  const session = new ScopedSession({ allowedOrigins: [AGY_ORIGIN], cookieOrigins: [AGY_ORIGIN], cookies,
    headersByOrigin: { [AGY_ORIGIN]: selected }, defaultHeaders: { accept: 'application/json+protobuf',
      'content-type': 'application/json+protobuf' }, maxRedirects: 0, timeoutMs: 30000,
    maxRequestBytes: 1024 * 1024, maxResponseBytes: 32 * 1024 * 1024 });
  const serialized = session.toJSON(), schemes = deriveAgySigning(serialized);
  return { version: 1, expectedEmail: expectedEmail.toLowerCase(), importedAt: new Date(now()).toISOString(), session: serialized,
    ...(schemes ? { authMode: 'google_first_party_signature', authSchemes: schemes } : {}) };
}

export function validateAgyState(state) {
  const t = state?.session;
  if (state?.version !== 1 || !text(state.expectedEmail, 320) || !Number.isFinite(Date.parse(state.importedAt)) || !object(t)
    || JSON.stringify(t.allowedOrigins) !== JSON.stringify([AGY_ORIGIN])
    || JSON.stringify(t.cookieOrigins) !== JSON.stringify([AGY_ORIGIN]) || t.maxRedirects !== 0 || t.allowLoopbackHttp !== false
    || t.timeoutMs !== 30000 || t.maxRequestBytes !== 1024 * 1024 || t.maxResponseBytes !== 32 * 1024 * 1024
    || Object.keys(t.headersByOrigin ?? {}).some(k => k !== AGY_ORIGIN)
    || Object.keys(t.headersByOrigin?.[AGY_ORIGIN] ?? {}).some(k => !AGY_AUTH_HEADERS.includes(k))) fail('AGY_STATE_INVALID');
  if (state.authMode !== undefined && (state.authMode !== 'google_first_party_signature' || !Array.isArray(state.authSchemes)
    || state.authSchemes.length < 1 || state.authSchemes.length > 3
    || state.authSchemes.some(x => !object(x) || !Object.hasOwn(signingCookies, x.scheme) || signingCookies[x.scheme] !== x.cookieName))) fail('AGY_STATE_INVALID');
  if (state.maintenance !== undefined) {
    let url; try { url = new URL(state.maintenance.endpoint); } catch { fail('AGY_STATE_INVALID'); }
    if (url.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash || state.maintenance.maxAgeMs !== 300000
      || !text(state.maintenance.ownerRemote, 160) || !text(state.maintenance.tabId, 160)) fail('AGY_STATE_INVALID');
  }
  return structuredClone(state);
}

/** Business operations use Node HTTP only. Browser bootstrap is a separate module. */
export function createAgyRemoteClient({ state, fetchImpl, now = Date.now, saveState = async () => {},
  journalRoot, onReceipt = () => {}, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const current = validateAgyState(state);
  if (!current.authMode) {
    const schemes = deriveAgySigning(current.session);
    if (schemes) { current.authMode = 'google_first_party_signature'; current.authSchemes = schemes; }
  }
  const baseFetch = fetchImpl ?? globalThis.fetch;
  const fetchWithStream = async (url, init) => {
    const response = await baseFetch(url, init);
    if (new URL(url).pathname !== AGY_API + 'StreamProxyCommand' || !response.ok
      || !/^application\/json\+protobuf(?:;|$)/i.test(response.headers.get('content-type') ?? '')) return response;
    const snapshot = await readAgySummarySnapshot(response);
    const headers = new Headers(response.headers); headers.delete('content-length'); headers.delete('content-encoding');
    return new Response(JSON.stringify(snapshot), { status: response.status, headers });
  };
  // Validate imported cookie jar and transport even before an operation is invoked.
  ScopedSession.fromJSON(current.session);
  const journal = journalRoot ? new WriteJournal({ root: journalRoot, service: 'agy-remote' }) : null;
  const observations = new Map(), bindings = new Map();

  async function request(apiMethod, body) {
    if (!['ListInstances', 'ProxyCommand', 'StreamProxyCommand'].includes(apiMethod)) fail('AGY_METHOD_NOT_ALLOWED');
    const age = now() - Date.parse(current.importedAt);
    if (age < 0 || !current.authMode && age > MAX_AGE) fail('AGY_BOOTSTRAP_REQUIRED');
    const transport = structuredClone(current.session);
    if (current.authMode) transport.headersByOrigin[AGY_ORIGIN].authorization = freshAuthorization(transport, current.authSchemes, now());
    const session = ScopedSession.fromJSON(transport, { fetchImpl: fetchWithStream });
    let r;
    try { r = await session.request(AGY_ORIGIN + AGY_API + apiMethod, { method: 'POST', body: JSON.stringify(body) }); }
    catch (error) { if (typeof error.code === 'string' && error.code.startsWith('AGY_STREAM_')) throw error; fail('AGY_TRANSPORT_FAILED'); }
    current.session = session.toJSON(); await saveState(structuredClone(current));
    onReceipt({ service: 'agy-remote', apiMethod, httpStatus: r.status, browserUsed: false,
      checkedAt: new Date(now()).toISOString(), responseBytes: Buffer.byteLength(r.raw) });
    if (r.status === 401) fail('AGY_REAUTH_REQUIRED', { httpStatus: 401 });
    if (r.status === 403) fail('AGY_FORBIDDEN', { httpStatus: 403 });
    if (r.status === 429) fail('AGY_THROTTLED', { httpStatus: 429 });
    if (r.status !== 200) fail('AGY_HTTP_ERROR', { httpStatus: r.status });
    if (!/^application\/json\+protobuf(?:;|$)/i.test(r.headers['content-type'] ?? '')) fail('AGY_AUTH_OR_RESPONSE_INVALID');
    return parseAgyJson(r.raw);
  }
  async function rpc(remote, method, body = {}) {
    if (!methods.has(method)) fail('AGY_METHOD_NOT_ALLOWED');
    return decodeAgyProxy(await request('ProxyCommand', [remote.id, AGY_LS + method,
      Buffer.from(JSON.stringify(body)).toString('base64')]));
  }
  async function instances() { return decodeAgyInstances(await request('ListInstances', [])); }
  async function resolve(selector) {
    if (!text(selector, 160)) fail('AGY_REMOTE_REQUIRED');
    const all = await instances(); const matches = all.filter(x => x.id === selector || x.name === selector);
    if (!matches.length) fail('AGY_REMOTE_NOT_FOUND');
    if (matches.length !== 1) fail('AGY_REMOTE_AMBIGUOUS');
    const remote = matches[0]; if (remote.status !== 'online') fail('AGY_REMOTE_OFFLINE');
    const owner = await rpc(remote, 'GetUserStatus');
    if (owner?.userStatus?.email?.toLowerCase() !== current.expectedEmail) fail('AGY_OWNER_MISMATCH');
    return remote;
  }
  async function owner(selector) {
    const remote = await resolve(selector);
    return { email: current.expectedEmail, ownerVerified: true, remote };
  }
  async function models(selector) {
    const remote = await resolve(selector); const data = await rpc(remote, 'GetCascadeModelConfigData');
    if (!Array.isArray(data.clientModelConfigs)) fail('AGY_MODELS_SCHEMA');
    return { remote, models: data.clientModelConfigs.map(x => ({ label: x.label, model: x.modelOrAlias?.model ?? null,
      alias: x.modelOrAlias?.alias ?? null, modelId: x.modelId ?? null })),
      defaults: { model: data.defaultOverrideModelConfig?.modelOrAlias?.model ?? null,
        alias: data.defaultOverrideModelConfig?.modelOrAlias?.alias ?? null } };
  }
  async function projects(selector) {
    const remote = await resolve(selector); const data = await rpc(remote, 'ListProjects');
    if (!Array.isArray(data.projectIds) || !data.projectIds.every(id => text(id, 160))) fail('AGY_PROJECTS_SCHEMA');
    const read = data.projectIds.length ? await rpc(remote, 'ReadProjects', { ids: data.projectIds }) : { projects: [] };
    if (!Array.isArray(read.projects) || read.failedIds?.length || read.notFoundIds?.length) fail('AGY_PROJECTS_INCOMPLETE');
    return { remote, projects: read.projects.map(x => ({ id: x.id, name: x.name, archived: x.archived === true,
      resourcesAvailable: object(x.projectResources) })) };
  }
  async function summaries(remote) {
    const persisted = await request('StreamProxyCommand', [remote.id, AGY_LS + 'JetboxSubscribeToSummaries',
      agyConnectEnvelope({}).toString('base64'), [['content-type', 'application/connect+json']]]);
    if (!object(persisted) || !object(persisted.updates ?? {})) fail('AGY_SESSIONS_SCHEMA');
    const data = await rpc(remote, 'GetAllCascadeTrajectories');
    if (!object(data.trajectorySummaries)) fail('AGY_SESSIONS_SCHEMA');
    const combined = { ...(persisted.updates ?? {}) };
    for (const [id, value] of Object.entries(data.trajectorySummaries)) combined[id] = { ...combined[id], ...value,
      annotations: { ...combined[id]?.annotations, ...value.annotations } };
    for (const id of persisted.deletes ?? []) delete combined[id];
    if (Object.entries(combined).some(([id, value]) => !uuid(id) || !object(value))) fail('AGY_SESSIONS_SCHEMA');
    observations.set(remote.id, persisted.observation);
    bindings.set(remote.id, new Map(Object.entries(combined)));
    return combined;
  }
  const summaryView = (id, x) => ({ id, title: x.annotations?.title || x.summary || '', status: x.status ?? null,
    projectId: x.trajectoryMetadata?.projectId ?? null, stepCount: x.stepCount ?? null,
    lastModifiedTime: x.lastModifiedTime ?? null, archived: x.annotations?.archived === true });
  async function sessions(selector, { limit = 100, cursor, projectId, query } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || projectId !== undefined && !text(projectId, 160)
      || query !== undefined && !text(query, 256)) fail('AGY_LIST_INPUT');
    const remote = await resolve(selector); const rows = await summaries(remote);
    const all = Object.entries(rows).map(([id, x]) => summaryView(id, x))
      .filter(x => (!projectId || x.projectId === projectId) && (!query || x.title.toLowerCase().includes(query.toLowerCase())))
      .sort((a, b) => (b.lastModifiedTime ?? '').localeCompare(a.lastModifiedTime ?? '') || a.id.localeCompare(b.id));
    const fingerprint = digest([remote.id, projectId ?? '', query ?? '', all.map(x => [x.id, x.lastModifiedTime])]);
    let offset = 0;
    if (cursor !== undefined) {
      if (typeof cursor !== 'string' || cursor.length > 1024) fail('AGY_CURSOR_INVALID');
      let value; try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString()); } catch { fail('AGY_CURSOR_INVALID'); }
      if (value.fingerprint !== fingerprint) fail('AGY_CURSOR_STALE_OR_WRONG_REMOTE');
      if (!Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > all.length) fail('AGY_CURSOR_INVALID');
      offset = value.offset;
    }
    const next = offset + limit;
    return { remote, sessions: all.slice(offset, next), observedCount: all.length,
      nextCursor: next < all.length ? Buffer.from(JSON.stringify({ fingerprint, offset: next })).toString('base64url') : null,
      pageComplete: next >= all.length, complete: false, scope: 'persisted_and_loaded_trajectories', observation: observations.get(remote.id) };
  }
  async function requireSession(remote, id) {
    if (!uuid(id)) fail('AGY_CONVERSATION_ID_INVALID');
    const cached = bindings.get(remote.id)?.get(id);
    if (cached) return summaryView(id, cached);
    const rows = await summaries(remote);
    if (!Object.hasOwn(rows, id)) fail('AGY_CONVERSATION_NOT_IN_REMOTE');
    return summaryView(id, rows[id]);
  }
  async function readOn(remote, id) {
    const summary = await requireSession(remote, id); const data = await rpc(remote, 'GetCascadeTrajectory', { cascadeId: id });
    const trajectory = data.trajectory;
    const total = data.numTotalSteps ?? 0;
    if (!object(trajectory) || trajectory.cascadeId !== id || !Array.isArray(trajectory.steps ?? [])
      || !Number.isSafeInteger(total) || total > 100000 || total < (trajectory.steps ?? []).length) fail('AGY_TRAJECTORY_SCHEMA');
    const steps = [...(trajectory.steps ?? [])];
    while (steps.length < total) {
      const next = await rpc(remote, 'GetCascadeTrajectorySteps', { cascadeId: id, stepOffset: steps.length });
      if (!Array.isArray(next.steps) || !next.steps.length || steps.length + next.steps.length > total) fail('AGY_TRAJECTORY_INCOMPLETE');
      steps.push(...next.steps);
    }
    const messages = steps.flatMap((step, index) => {
      if (step.userInput) return [{ index, role: 'user', text: (step.userInput.items ?? []).map(x => x.text ?? '').join(''),
        clientMessageId: step.userInput.clientMessageId ?? null, status: step.status }];
      if (step.plannerResponse?.response) return [{ index, role: 'assistant', text: step.plannerResponse.response, status: step.status }];
      return [];
    });
    const errors = steps.flatMap((step, index) => /(?:ERROR|FAILED)$/.test(step.status ?? '') || /ERROR(?:_MESSAGE)?$/.test(step.type ?? '')
      ? [{ index, type: step.type, status: step.status }] : []);
    return { remote, conversation: { ...summary, status: data.status, stepCount: steps.length, messages,
      failed: errors.length > 0, errors, complete: true, stepTypes: [...new Set(steps.map(x => x.type))] } };
  }
  async function read(selector, id) { return readOn(await resolve(selector), id); }
  function writeArgs(confirm, intent) {
    if (confirm !== 'CONFIRM') fail('AGY_CONFIRM_REQUIRED');
    if (!journal) fail('AGY_JOURNAL_REQUIRED');
    if (!text(intent, 128)) fail('AGY_INTENT_REQUIRED');
  }
  async function mutate({ operation, remote, intent, payload, perform, verify, safe = {} }) {
    const key = journal.key(operation, { owner: current.expectedEmail, remoteId: remote.id, intent }, payload);
    // Generated identifiers are persisted before sending, so an uncertain write is reconcilable.
    await journal.reserve(key, { operation, remoteId: remote.id, ...safe });
    let value;
    try { value = await perform(); await journal.finish(key, 'acknowledged_requires_readback', safe); }
    catch { await journal.finish(key, 'outcome_unknown', safe).catch(() => {}); fail('AGY_WRITE_OUTCOME_UNKNOWN', { journalKey: key }); }
    let found = false;
    try { found = await verify(value); }
    catch { fail('AGY_READBACK_REQUIRED', { journalKey: key }); }
    await journal.reconcile(key, { result: found ? 'found' : 'ambiguous', ...safe });
    if (!found) fail('AGY_READBACK_REQUIRED', { journalKey: key });
    return { remote, verified: true, journalKey: key, ...safe };
  }
  async function create({ remote: selector, projectId, model, title, intent, confirm } = {}) {
    writeArgs(confirm, intent);
    if (!text(projectId, 160) || !text(model, 160) || !/^MODEL_[A-Z0-9_]+$/.test(model) || title !== undefined && !text(title, 256)) fail('AGY_CREATE_INPUT');
    const remote = await resolve(selector);
    const listed = await rpc(remote, 'ListProjects');
    if (!listed.projectIds?.includes(projectId)) fail('AGY_PROJECT_NOT_IN_REMOTE');
    const configs = await rpc(remote, 'GetCascadeModelConfigData');
    if (!configs.clientModelConfigs?.some(x => x.modelOrAlias?.model === model)) fail('AGY_MODEL_NOT_IN_REMOTE');
    // Deterministic resource ID from the stable intent; retries never generate a new conversation.
    const seed = digest([current.expectedEmail, remote.id, intent, 'create']).slice(0, 32);
    const id = `${seed.slice(0, 8)}-${seed.slice(8, 12)}-4${seed.slice(13, 16)}-a${seed.slice(17, 20)}-${seed.slice(20)}`;
    const payload = { source: 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT', cascadeId: id, requestedModel: model,
      projectEnvConfig: { projectId, defaultProjectEnvironment: {} } };
    const result = await mutate({ operation: 'conversation-create', remote, intent, payload, safe: { conversationId: id },
      perform: async () => { const r = await rpc(remote, 'StartCascade', payload); if (r.cascadeId !== id) fail('AGY_CREATED_ID_MISMATCH'); return r; },
      verify: async () => Object.hasOwn(await summaries(remote), id) });
    if (title) await rename({ remote: selector, id, title, intent: `${intent}:title`, confirm });
    return { ...result, id, projectId, model };
  }
  async function send({ remote: selector, id, prompt, model, intent, confirm } = {}) {
    writeArgs(confirm, intent);
    if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 128 * 1024 || prompt.includes('\0')) fail('AGY_MESSAGE_INPUT');
    if (model !== undefined && !/^MODEL_[A-Z0-9_]+$/.test(model)) fail('AGY_MESSAGE_INPUT');
    const remote = await resolve(selector); await requireSession(remote, id);
    const clientMessageId = randomUUID();
    const payload = { cascadeId: id, items: [{ text: prompt }], clientMessageId,
      deliveryStrategy: 'MESSAGE_DELIVERY_STRATEGY_WHEN_IDLE',
      ...(model ? { cascadeConfig: { plannerConfig: { planModel: model } } } : {}) };
    const result = await mutate({ operation: 'message-send', remote, intent,
      payload: { id, prompt, model: model ?? null }, safe: { conversationId: id, clientMessageId, promptHash: digest(prompt) },
      perform: () => rpc(remote, 'SendUserCascadeMessage', payload), verify: async () => {
        for (let attempt = 0; attempt < 8; attempt++) {
          const r = await readOn(remote, id);
          if (r.conversation.messages.some(x => x.clientMessageId === clientMessageId && x.text === prompt)) return true;
          await sleep(250);
        }
        return false;
      } });
    return { ...result, id, clientMessageId };
  }
  async function rename({ remote: selector, id, title, intent, confirm } = {}) {
    writeArgs(confirm, intent); if (!text(title, 256)) fail('AGY_TITLE_INPUT');
    const remote = await resolve(selector); await requireSession(remote, id);
    return mutate({ operation: 'conversation-rename', remote, intent, payload: { id, title }, safe: { conversationId: id, titleHash: digest(title) },
      perform: () => rpc(remote, 'UpdateConversationAnnotations', { cascadeIds: [id], annotations: { title }, mergeAnnotations: true }),
      verify: async () => (await summaries(remote))[id]?.annotations?.title === title });
  }
  async function cancel({ remote: selector, id, intent, confirm } = {}) {
    writeArgs(confirm, intent); const remote = await resolve(selector); await requireSession(remote, id);
    return mutate({ operation: 'conversation-cancel', remote, intent, payload: { id }, safe: { conversationId: id },
      perform: () => rpc(remote, 'CancelCascadeInvocation', { cascadeId: id }),
      verify: async () => { for (let i = 0; i < 20; i++) { if ((await readOn(remote, id)).conversation.status === 'CASCADE_RUN_STATUS_IDLE') return true; await sleep(250); } return false; } });
  }
  async function remove({ remote: selector, id, intent, confirm } = {}) {
    writeArgs(confirm, intent); const remote = await resolve(selector); await requireSession(remote, id);
    return mutate({ operation: 'conversation-delete', remote, intent, payload: { id }, safe: { conversationId: id },
      perform: () => rpc(remote, 'DeleteCascadeTrajectory', { cascadeId: id }),
      verify: async () => !Object.hasOwn(await summaries(remote), id) });
  }
  async function wait({ remote: selector, id, timeoutMs = 120000, intervalMs = 1000 } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000 || !Number.isSafeInteger(intervalMs) || intervalMs < 250) fail('AGY_WAIT_INPUT');
    const remote = await resolve(selector); const deadline = now() + timeoutMs;
    for (;;) {
      const result = await readOn(remote, id);
      if (result.conversation.status === 'CASCADE_RUN_STATUS_IDLE') return { ...result, completed: true, succeeded: !result.conversation.failed };
      if (/WAITING|AWAITING|NEEDS_USER/.test(result.conversation.status ?? '')) return { ...result, completed: false, attentionRequired: true };
      if (now() >= deadline) return { ...result, completed: false, timeout: true, resume: 'read-or-wait-with-same-conversation-id' };
      await sleep(Math.min(intervalMs, deadline - now()));
    }
  }
  async function reconcile({ remote: selector, journalKey } = {}) {
    if (!journal) fail('AGY_JOURNAL_REQUIRED');
    const remote = await resolve(selector); const record = await journal.read(journalKey);
    if (!record || record.safeRecord.remoteId !== remote.id) fail('AGY_JOURNAL_REMOTE_MISMATCH');
    const safe = record.safeRecord, id = safe.conversationId; let found = false;
    if (safe.operation === 'conversation-create') found = Object.hasOwn(await summaries(remote), id);
    else if (safe.operation === 'conversation-delete') found = !Object.hasOwn(await summaries(remote), id);
    else if (safe.operation === 'conversation-rename') found = digest((await summaries(remote))[id]?.annotations?.title ?? '') === safe.titleHash;
    else if (safe.operation === 'message-send') found = (await readOn(remote, id)).conversation.messages
      .some(m => m.clientMessageId === safe.clientMessageId && digest(m.text) === safe.promptHash);
    else if (safe.operation === 'conversation-cancel') found = (await readOn(remote, id)).conversation.status === 'CASCADE_RUN_STATUS_IDLE';
    else fail('AGY_RECONCILIATION_UNSUPPORTED');
    if (record.status !== 'reconciled') await journal.reconcile(journalKey, { result: found ? 'found' : 'ambiguous', conversationId: id });
    return { remote, journalKey, found, writesExecuted: false, originalState: record.status, id };
  }
  return { instances, owner, models, projects, sessions, read, create, send, rename, cancel, remove, wait, reconcile };
}
