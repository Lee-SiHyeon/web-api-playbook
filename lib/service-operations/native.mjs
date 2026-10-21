// Named native reads only. No runner accepts CLI arguments or a login/write action.
// Credential objects are the existing clients' bundles, never public operation inputs.
import os from 'node:os';
import path from 'node:path';

const fail = (code, receipt) => { throw Object.assign(new Error(code), { code, ...(receipt ? { receipt } : {}) }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (extra = {}) => ({ type: 'string', ...extra });
const integer = (value, maximum) => ({ type: 'integer', default: value, minimum: 1, maximum });
const required = () => text({ required: true });
const naverRoot = '../../service-packs/naver/apps/naver-blog-api/scripts/';
const tistoryRoot = '../../service-packs/tistory/';
const tistoryOrigin = 'https://i-never-stop-study.tistory.com';
const naverActor = 'aicandoanything'; // Session-health actor pinned by the existing pack.
const statisticPaths = Object.freeze({
  count: '/manage/v2/statistics/blog/count', trend: '/manage/v2/statistics/dashboard/trend',
  top: '/manage/statistics/dashboard/topEntry.json', inflow: '/manage/statistics/dashboard/inflow.json',
  keyword: '/manage/statistics/dashboard/keyword.json', recent: '/manage/statistics/dashboard/recentEntry.json',
});

// Defense in depth around native business projections, not a provider/state serializer.
const privateKey = /^(?:cookies?|cookieJar|set-cookie|headers|rawHeaders|defaultHeaders|headersByOrigin|authorization|proxy-authorization|session|state|credentials?|password|secret|lsd|csrf|site|profileContract|authToken|csrfToken|bearerToken|accessToken|refreshToken|transactionId|transactionProvider|fetchImpl|__proto__|constructor|prototype)$|(?:^|[_-])(?:token|password|secret)(?:$|[_-])/i;
function safeJson(value, ancestors = new Set(), depth = 0) {
  if (depth > 40) fail('NATIVE_OUTPUT_INVALID');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('NATIVE_OUTPUT_INVALID'); return value; }
  if (typeof value !== 'object' || ancestors.has(value) ||
      !Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('NATIVE_OUTPUT_INVALID');
  ancestors.add(value);
  const result = Array.isArray(value)
    ? Array.from(value, child => child === undefined ? null : safeJson(child, ancestors, depth + 1))
    : Object.fromEntries(Object.entries(value).filter(([key, child]) => !privateKey.test(key) && child !== undefined)
      .map(([key, child]) => [key, safeJson(child, ancestors, depth + 1)]));
  ancestors.delete(value);
  return result;
}
function output(result, operation, pageInfo) {
  const { receipt = {}, ...data } = result;
  return safeJson({ data, receipt: { ...receipt, operation: receipt.operation ?? operation, networkUsed: true },
    ...(pageInfo ? { pageInfo } : {}) });
}
function stableError(error, id, networkUsed, aborted) {
  let code = aborted ? 'OPERATION_ABORTED' : error?.code ?? error?.message;
  if (code === 'LOGIN_INPUT_MISSING') code = 'REAUTH_REQUIRED'; // Inpock renewal is deliberately unavailable.
  if (['CREDENTIAL_STORE_PLATFORM_UNSUPPORTED', 'PROTECTED_STORE_PROVIDER_REQUIRED'].includes(code)) code = 'PROVIDER_MISSING';
  if (['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'].includes(code)) code = 'NATIVE_DEPENDENCY_MISSING';
  const nativeCodes = new Set(['OAUTH_REQUIRED', 'USER_AGENT_REQUIRED', 'RATE_LIMITED', 'ACCESS_BLOCKED', 'HTTP_ERROR', 'NOT_JSON',
    'TRANSPORT', 'SCHEMA', 'INPUT', 'CLOSED', 'ROUTE_DENIED', 'DEPTH_LIMIT', 'ITEM_LIMIT', 'POST_MISMATCH',
    'SESSION_INVALID', 'HEADER_INVALID', 'TRANSACTION_INVALID', 'CONTRACT_INVALID', 'HANDLE_INVALID', 'IDENTITY_MISMATCH',
    'AUTH_REJECTED', 'SERVICE_ERROR', 'CLIENT_CLOSED', 'CONVERSATION_SCHEMA', 'AUTH_MISSING', 'AUTH_UNVERIFIED',
    'TIMEOUT', 'SIZE', 'SESSION_COOKIE_INVALID', 'READ_ONLY', 'UNOBSERVED', 'FORBIDDEN', 'REDIRECT', 'HTTP', 'MIME', 'JSON', 'APPLICATION', 'THROTTLED', 'SERVICE']);
  if (nativeCodes.has(code)) code = `${id.toUpperCase().replaceAll('-', '_')}_${code}`;
  // Only known client errors cross this boundary; provider exceptions/messages never do.
  const known = /^(?:NATIVE_[A-Z_0-9]+$|OPERATION_ABORTED$|PROVIDER_MISSING$|PROVIDER_INVALID$|PROVIDER_UNREADABLE$|SESSION_MISSING$|REAUTH_REQUIRED$|AUTH_[A-Z_]+$|OWNER_[A-Z_]+$|CONFIGURED_OWNER_MISMATCH$|INPOCK_[A-Z_]+$|GABIA_[A-Z_]+$|THREADS_[A-Z_0-9]+$|X_[A-Z_0-9]+$|TISTORY_[A-Z_0-9]+$|NAVER_[A-Z_0-9]+$|REDDIT_[A-Z_0-9]+$|PROTECTED_STORE_[A-Z_]+$|CREDENTIAL_[A-Z_]+$)/;
  const trusted = typeof code === 'string' && known.test(code);
  if (!trusted) code = `NATIVE_${id.toUpperCase().replaceAll('-', '_')}_READ_FAILED`;
  let receipt = {};
  try { if (trusted && object(error?.receipt)) receipt = safeJson(error.receipt); } catch {}
  const status = trusted ? error?.status ?? error?.httpStatus ?? receipt.httpStatus ?? receipt.status ?? error?.details?.httpStatus : null;
  return Object.assign(new Error(code), { code, receipt: { ...receipt, serviceId: id, networkUsed },
    ...(Number.isSafeInteger(status) && status >= 100 && status <= 599 ? { status } : {}) });
}

function runtime(id, actions, options) {
  let closed = false;
  const active = new Set();
  const adapters = Object.fromEntries(Object.entries(actions).map(([name, action]) => [`${id}.${name}`, async (input = {}, { signal } = {}) => {
    if (closed) fail('NATIVE_ADAPTER_CLOSED');
    const controller = new AbortController(); active.add(controller);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let requests = 0;
    const ctx = {
      options,
      // The optional importer is a trusted dependency-injection seam, never an operation input.
      module: relative => (options.importModule ?? (url => import(url)))(new URL(relative, import.meta.url).href),
      async fetch(url, init = {}) {
        if (combined.aborted) fail('OPERATION_ABORTED');
        const method = (init.method ?? 'GET').toUpperCase();
        if (!['GET', 'HEAD'].includes(method)) {
          const target = new URL(url);
          const operation = init.body instanceof URLSearchParams ? init.body.get('fb_api_req_friendly_name') : null;
          const allowed = id === 'threads' && method === 'POST' && target.origin === 'https://www.threads.com' &&
            !target.search && !target.hash && (
              target.pathname === '/api/graphql' && operation === 'BarcelonaProfileThreadsTabDirectQuery' ||
              target.pathname === '/graphql/query' && operation === 'BarcelonaPostViewCountQuery');
          if (!allowed) fail('NATIVE_READ_ONLY');
        }
        // The existing Threads client can retry a rejected cached session.
        // Bound these public operations to at most two current network reads;
        // do not turn cache recovery into an unbounded verification burst.
        const budget = id === 'threads' ? name === 'public-html' ? 1 : 2
          : id === 'gabia' && name === 'public-https' ? 1 : Infinity;
        if (requests >= budget) fail('NATIVE_READ_BUDGET_EXCEEDED');
        requests++;
        return (options.fetchImpl ?? globalThis.fetch)(url, { ...init,
          signal: init.signal ? AbortSignal.any([combined, init.signal]) : combined });
      },
      async credential(fallback) {
        if (typeof options.credentialProvider === 'function') {
          let value;
          try { value = await options.credentialProvider(id); } catch { fail('PROVIDER_UNREADABLE'); }
          if (value == null) fail('PROVIDER_MISSING');
          if (!object(value)) fail('PROVIDER_INVALID');
          return value;
        }
        return fallback();
      },
    };
    try {
      if (combined.aborted) fail('OPERATION_ABORTED');
      const result = await action(input, ctx);
      if (combined.aborted) fail('OPERATION_ABORTED');
      return safeJson({ ...result, receipt: { ...result.receipt, networkUsed: requests > 0 } });
    } catch (error) { throw stableError(error, id, requests > 0, combined.aborted); }
    finally { active.delete(controller); }
  }]));
  return { adapters, close() { closed = true; for (const controller of active) controller.abort(); } };
}
async function rootStore(ctx) {
  const { ProtectedStore } = await ctx.module('../protected-store.mjs');
  return new ProtectedStore(ctx.options.storeDirectory ? { directory: ctx.options.storeDirectory } : {});
}
function parseCredential(raw) {
  if (!raw) fail('PROVIDER_MISSING');
  try { const value = JSON.parse(raw); if (!object(value)) fail('PROVIDER_INVALID'); return value; }
  catch { fail('PROVIDER_INVALID'); }
}
async function namedCredential(ctx, name, packRoot) {
  // Pack SecureString DPAPI envelopes differ from root ProtectedStore envelopes.
  // Preserve the original reader for its canonical shared directory (including
  // an explicit spelling). A non-canonical storeDirectory selects a root-store
  // bundle: these native pack readers have no authDir/custom-folder interface.
  const packDirectory = path.join(os.homedir(), '.config', 'affiliate-content-operations', 'credentials');
  const canonicalPack = packRoot && (!ctx.options.storeDirectory ||
    path.resolve(ctx.options.storeDirectory).toLowerCase() === path.resolve(packDirectory).toLowerCase());
  if (!canonicalPack) return parseCredential((await rootStore(ctx)).read(ctx.options.sessionName ?? name));
  const { readCredential } = await ctx.module(packRoot + 'secure-credential-store.mjs');
  return parseCredential(readCredential(ctx.options.sessionName ?? name));
}
async function existingRootAuth(ctx, id, name, authModule, factory) {
  let backing, state;
  state = await ctx.credential(async () => {
    backing = await rootStore(ctx);
    return parseCredential(backing.read(ctx.options.sessionName ?? name));
  });
  let serialized = JSON.stringify(state);
  // Do not expose password credentials to ensureInternal: it cannot initiate a
  // new login even when an existing Inpock cookie is rejected. GET-only fetch is
  // a second, independent guard. Ordinary saved-session rotation stays native.
  const store = {
    directory: backing?.directory ?? ctx.options.storeDirectory ?? path.join(os.tmpdir(), 'playbook-native-read-locks'),
    read: key => key === name ? serialized : null,
    write(key, value) {
      if (key !== name) fail('NATIVE_READ_ONLY');
      serialized = value;
      return backing ? backing.write(ctx.options.sessionName ?? name, value) : { stored: false, persistent: false };
    },
  };
  const module = await ctx.module(authModule);
  return module[factory]({ store, fetchImpl: ctx.fetch });
}

const inpockActions = {
  async health(input, ctx) {
    const auth = await existingRootAuth(ctx, 'inpock', 'inpock-state', '../web-auth/inpock.mjs', 'createInpockAuth');
    return output(await auth.health(), 'health');
  },
  ...Object.fromEntries([['blocks', 'listBlocks'], ['public-profile', 'publicProfile'], ['stats', 'miniStats']].map(([name, method]) => [name, async (input, ctx) => {
    const auth = await existingRootAuth(ctx, 'inpock', 'inpock-state', '../web-auth/inpock.mjs', 'createInpockAuth');
    const { createInpockReadClient } = await ctx.module('../inpock-read.mjs');
    const result = await createInpockReadClient({ auth })[method](name === 'blocks' ? { maxPages: input.query?.maxPages ?? 1 } : undefined);
    // Match scripts/inpock.mjs: never dump raw blocks or the raw public user.
    const { blocks, profile, ...summary } = result;
    if (profile) summary.profileFields = Object.keys(profile);
    return output(summary, name, name === 'blocks' ? { complete: result.complete, pages: result.pages, stopReason: result.stopReason } : undefined);
  }])),
};
const gabiaActions = {
  async 'public-https'(input, ctx) {
    const { verifyPublicHttps } = await ctx.module('../gabia-dns.mjs');
    const result = await verifyPublicHttps({ ...input.query, maxRedirects: 0, fetchImpl: ctx.fetch });
    if (result.status !== 'reachable') fail(result.errorCode ?? 'GABIA_PUBLIC_HTTPS_NOT_REACHABLE', result);
    return output(result, 'public-https');
  },
  async 'public-dns'(input, ctx) {
    const { verifyPublicDns } = await ctx.module('../gabia-dns.mjs');
    const result = await verifyPublicDns({ recordSet: input.body.recordSet, fetchImpl: ctx.fetch });
    if (result.status === 'inconclusive') fail('GABIA_PUBLIC_DNS_INCONCLUSIVE', result);
    return output(result, 'public-dns');
  },
  async 'domain-read'(input, ctx) {
    // No persisted Gabia provider name is asserted by the existing read runner.
    const credentials = await ctx.credential(() => ctx.options.sessionName ? namedCredential(ctx) : fail('PROVIDER_MISSING'));
    const { createGabiaReadClient } = await ctx.module('../gabia-read.mjs');
    return output(await createGabiaReadClient({ input: credentials, fetchImpl: ctx.fetch }).readDomain(), 'domain-read');
  },
};
const threadsActions = {
  async 'public-profile'(input, ctx) {
    const { fetchThreadsXhr } = await ctx.module('../../service-packs/threads/threads-xhr.mjs');
    const { handle, limit = 3 } = input.query;
    return output(await fetchThreadsXhr(handle, limit, { fetchImpl: ctx.fetch }), 'public-profile', { fullTimeline: false });
  },
  async 'public-html'(input, ctx) {
    const { fetchThreadsPublic } = await ctx.module('../../service-packs/threads/threads-public.mjs');
    const { handle, limit = 3 } = input.query;
    return output(await fetchThreadsPublic(handle, limit, { fetchImpl: ctx.fetch }), 'public-html', { fullTimeline: false });
  },
  async views(input, ctx) {
    const { probeThreadsViews } = await ctx.module('../../service-packs/threads/threads-xhr.mjs');
    const result = await probeThreadsViews(input.query, { fetchImpl: ctx.fetch });
    if (result.error) fail(result.error, result.receipt);
    return output(result, 'views');
  },
};
async function withX(ctx, callback) {
  if (typeof ctx.options.credentialProvider === 'function') {
    const credentials = await ctx.credential();
    if (credentials.origin !== undefined && credentials.origin !== 'https://x.com') fail('X_PROVIDER_ORIGIN');
    if (credentials.expiresAt !== undefined && (!Number.isFinite(Date.parse(credentials.expiresAt)) || Date.parse(credentials.expiresAt) <= Date.now())) fail('X_PROVIDER_EXPIRED');
    const { createXClient } = await ctx.module('../web-auth/x-read-client.mjs');
    const fetchImpl = async (url, init = {}) => {
      const target = new URL(url);
      if (credentials.transactionProvider && /\/graphql\//.test(target.pathname) && ['https://x.com', 'https://api.x.com'].includes(target.origin)) {
        const transactionId = await credentials.transactionProvider({ method: init.method ?? 'GET', path: target.pathname });
        if (typeof transactionId !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(transactionId)) fail('X_TRANSACTION_INVALID');
        const headers = new Headers(init.headers); headers.set('x-client-transaction-id', transactionId);
        return ctx.fetch(url, { ...init, headers });
      }
      return ctx.fetch(url, init);
    };
    const client = await createXClient({ session: credentials, fetchImpl });
    try { return await callback(client); } finally { client.close(); }
  }
  const auth = await existingRootAuth(ctx, 'x', 'x-web-state', '../web-auth/x.mjs', 'createXAuth');
  return auth.withSession(async session => {
    const { createXClient } = await ctx.module('../web-auth/x-read-client.mjs');
    const client = await createXClient({ session, fetchImpl: session.fetchImpl });
    try { return await callback(client); } finally { client.close(); }
  });
}
const xActions = {
  profile: (input, ctx) => withX(ctx, async client => {
    const result = await client.profile(input.path.handle);
    return output({ ...result, receipt: result.receipt ?? client.receipts?.at(-1) ?? {} }, 'profile');
  }),
  timeline: (input, ctx) => withX(ctx, async client => {
    const { collectXPages } = await ctx.module('../web-auth/x-read-client.mjs');
    const result = await collectXPages(client, input.path.handle, { maxPages: input.query?.maxPages ?? 1, limit: 100, ...(input.query?.cursor ? { cursor: input.query.cursor } : {}) });
    // Return whole fetched pages; do not discard items in front of nextCursor.
    return output(result, 'timeline', { nextCursor: result.nextCursor ?? null, fullTimeline: false });
  }),
  conversation: (input, ctx) => withX(ctx, async client => {
    const { decodeConversation } = await ctx.module('../../service-packs/social-x/src/conversation.mjs');
    const result = await client.detail(input.path.postId);
    return output({ ...decodeConversation(result.instructions, input.path.postId), receipt: result.receipt }, 'conversation', { complete: false, representative: false });
  }),
};
async function naverClient(ctx) {
  const credentials = await ctx.credential(() => namedCredential(ctx, 'naver-blog-session', naverRoot));
  const { SessionClient } = await ctx.module(naverRoot + 'session-client.mjs');
  const client = new SessionClient({ cookies: credentials.cookies, fetchImpl: ctx.fetch, ownerBlogId: naverActor,
    defaultHeaders: credentials.userAgent ? { 'user-agent': credentials.userAgent } : {},
    // Provider-supplied sessions are read-only memory bundles, not vault imports.
    persistRotation: !ctx.options.credentialProvider && !ctx.options.storeDirectory && !ctx.options.sessionName });
  return client;
}
async function verifyNaver(client) {
  const receipt = await client.verifyRoot();
  if (!receipt.verified || !receipt.actorMatched || !receipt.adminShell) fail('NAVER_OWNER_UNVERIFIED');
  return receipt;
}
const naverActions = {
  async health(input, ctx) {
    const client = await naverClient(ctx);
    try { return output({ authenticated: true, ownerVerified: true, receipt: await verifyNaver(client) }, 'health'); }
    finally { client.clear(); }
  },
  async visits(input, ctx) {
    const client = await naverClient(ctx);
    try {
      await verifyNaver(client);
      const { read } = await ctx.module(naverRoot + 'client.mjs');
      const { metric, ...query } = input.query;
      const url = 'https://blog.stat.naver.com/api/blog/visit/' + metric;
      const result = await read({ operation: `visit/${metric}`, query }, {
        cookie: client.cookieFor(url), fetchImpl: client.fetch.bind(client), maxRetries: 0,
      });
      return output({ data: result.data, receipt: result.evidence }, 'visits');
    } finally { client.clear(); }
  },
};
async function withTistory(ctx, callback) {
  const credentials = await ctx.credential(() => namedCredential(ctx, 'tistory-auth-state-v1', tistoryRoot + 'scripts/'));
  const { ScopedHttpSession } = await ctx.module(tistoryRoot + 'lib/transport.mjs');
  const { verifySession, decodeJson } = await ctx.module(tistoryRoot + 'lib/auth.mjs');
  if (credentials.version !== 1 || credentials.blogOrigin !== tistoryOrigin) fail('TISTORY_STATE_INVALID');
  const session = ScopedHttpSession.fromJSON(credentials.session, { fetchImpl: ctx.fetch });
  try {
    // Never call prepare()/withAuthenticatedSession(): those may renew via Kakao.
    const verified = await verifySession(session, credentials.identity);
    return await callback({ session, receipt: { ...verified.receipt, checkedAt: verified.verifiedAt, renewal: 'not_attempted' }, decodeJson });
  } finally { session.jar.removeAllCookiesSync(); }
}
const tistoryActions = {
  health: (input, ctx) => withTistory(ctx, async ({ receipt }) => output({ authenticated: true, ownerVerified: true, receipt }, 'health')),
  statistics: (input, ctx) => withTistory(ctx, async ({ session, receipt, decodeJson }) => {
    const name = input.query.operation;
    if (!Object.hasOwn(statisticPaths, name)) fail('TISTORY_OPERATION_INVALID');
    const response = await session.request(tistoryOrigin + statisticPaths[name], { headers: { accept: 'application/json' }, referer: tistoryOrigin + '/manage' });
    return output({ statistics: decodeJson(response), receipt: { ...receipt, method: 'GET', path: statisticPaths[name], httpStatus: response.status, mime: response.headers['content-type'] ?? null } }, 'statistics');
  }),
  categories: (input, ctx) => withTistory(ctx, async ({ session, receipt, decodeJson }) => {
    const route = '/manage/category/simple.json';
    const response = await session.request(tistoryOrigin + route, { headers: { accept: 'application/json' }, referer: tistoryOrigin + '/manage' });
    return output({ categories: decodeJson(response), receipt: { ...receipt, method: 'GET', path: route, httpStatus: response.status, mime: response.headers['content-type'] ?? null } }, 'categories');
  }),
};
async function withReddit(ctx, callback) {
  const credentials = await ctx.credential(async () => {
    if (ctx.options.sessionName) return namedCredential(ctx);
    if (!process.env.REDDIT_ACCESS_TOKEN || !process.env.REDDIT_USER_AGENT) fail('PROVIDER_MISSING');
    return { accessToken: process.env.REDDIT_ACCESS_TOKEN, userAgent: process.env.REDDIT_USER_AGENT };
  });
  const { RedditClient } = await ctx.module('../../service-packs/social-x/src/reddit.mjs');
  const client = new RedditClient({ accessToken: credentials.accessToken, userAgent: credentials.userAgent, fetchImpl: ctx.fetch });
  try { return await callback(client); } finally { client.close(); }
}
const redditActions = {
  search: (input, ctx) => withReddit(ctx, async client => {
    const { q, ...query } = input.query;
    const result = await client.search(q, query);
    return output(result, 'search', { after: result.after, complete: false });
  }),
  comments: (input, ctx) => withReddit(ctx, async client => output(await client.comments(input.path.postId, input.query), 'comments', { complete: false, representative: false })),
};

function definition(id, title, operations, actions, verificationChecks, metadata = {}) {
  return { id, title, ...metadata, profile: { schemaVersion: 2, serviceId: id, allowedOrigins: [], operations }, verificationChecks,
    createAdapters: (options = {}) => runtime(id, actions, options) };
}
const op = (adapter, evidence, description, inputs = {}) => ({ adapter, semantics: 'read', evidence, description, inputs });
const check = (operation, input = {}) => ({ operation, input, kind: 'live_read' });
const threadsQuery = { handle: required(), limit: integer(3, 30) };
export const definitions = [
  definition('inpock', 'Inpock saved-session reads', {
    health: op('inpock.health', 'lib/web-auth/inpock.mjs:createInpockAuth.health', 'Verify the saved owner; never log in.'),
    blocks: op('inpock.blocks', 'lib/inpock-read.mjs:listBlocks; scripts/inpock.mjs:summary', 'Read bounded block inventory summaries.', { query: { maxPages: integer(1, 2) } }),
    'public-profile': op('inpock.public-profile', 'lib/inpock-read.mjs:publicProfile; scripts/inpock.mjs:summary', 'Read the current owner public profile summary.'),
    stats: op('inpock.stats', 'lib/inpock-read.mjs:miniStats', 'Read owner mini statistics.'),
  }, inpockActions, [check('health')], { aliases: ['inpock-link'] }),
  definition('gabia', 'Gabia native public and owner reads', {
    'public-https': op('gabia.public-https', 'lib/gabia-dns.mjs:verifyPublicHttps', 'Strict TLS HTTPS read, no redirects or body download.', { query: { domain: required(), url: text() } }),
    'public-dns': op('gabia.public-dns', 'lib/gabia-dns.mjs:verifyPublicDns; examples/gabia/lifehackailab-records.json', 'Compare an explicit record plan: 12 recursive DNS reads, not authoritative DNS.', { body: { recordSet: { type: 'json', required: true } } }),
    'domain-read': op('gabia.domain-read', 'lib/gabia-read.mjs:createGabiaReadClient.readDomain; scripts/gabia-read.mjs', 'Provider bundle: owner, target-filtered domain list, A/AAAA/CNAME records. Three reads.'),
  }, gabiaActions, [check('public-https', { query: { domain: 'gabia.com', url: 'https://www.gabia.com/' } })]),
  definition('threads', 'Threads observed public reads', {
    'public-profile': op('threads.public-profile', 'service-packs/threads/threads-xhr.mjs:fetchThreadsXhr', 'Observed Relay bootstrap then independent public GraphQL read; anonymous cache reuse, not account login.', { query: threadsQuery }),
    'public-html': op('threads.public-html', 'service-packs/threads/threads-public.mjs:fetchThreadsPublic', 'Explicit public HTML embedded-JSON read, never a silent GraphQL fallback.', { query: threadsQuery }),
    views: op('threads.views', 'service-packs/threads/threads-xhr.mjs:probeThreadsViews', 'Read observed post view count; preserve server null.', { query: { handle: required(), code: required(), postId: required() } }),
  }, threadsActions, [check('public-profile', { query: { handle: 'threads', limit: 1 } })], { checklistIds: ['creator-threads'] }),
  definition('x', 'X saved-session and social-pack reads', {
    profile: op('x.profile', 'lib/web-auth/x-read-client.mjs:profile; service-packs/social-x/src/provider.mjs:transactionProvider', 'Read a named profile using an existing session and the current source-observed contract.', { path: { handle: required() } }),
    timeline: op('x.timeline', 'lib/web-auth/x-read-client.mjs:collectXPages; service-packs/social-x/src/client.mjs:timeline', 'Read one or two pages; retain every fetched item and continuation cursor.', { path: { handle: required() }, query: { maxPages: integer(1, 2), cursor: text() } }),
    conversation: op('x.conversation', 'service-packs/social-x/src/conversation.mjs:decodeConversation; lib/web-auth/x-read-client.mjs:detail', 'Read first ranked conversation page; incomplete and non-representative.', { path: { postId: required() } }),
  }, xActions, [check('profile', { path: { handle: 'sama' } })], { aliases: ['social-x'] }),
  definition('naver-blog', 'Naver Blog saved-session reads', {
    health: op('naver-blog.health', 'service-packs/naver/apps/naver-blog-api/scripts/naver-session-health.mjs; scripts/session-client.mjs:verifyRoot', 'Verify the existing pack owner using the protected admin page; no login.'),
    visits: op('naver-blog.visits', 'service-packs/naver/apps/naver-blog-api/scripts/client.mjs:read; references/api-catalog.json', 'Observed visit statistics only; pass current observed query values.', { query: {
      metric: text({ required: true, enum: ['cv', 'uv', 'visit', 'averageVisit', 'revisit', 'averageDuration'] }),
      _: required(), exclude: required(), startDate: required(), timeDimension: required(),
    } }),
  }, naverActions, [check('health')], { aliases: ['naver'] }),
  definition('tistory', 'Tistory saved-session reads without renewal', {
    health: op('tistory.health', 'service-packs/tistory/lib/auth.mjs:verifySession', 'Two protected reads bind the saved account and target blog; never renew.'),
    statistics: op('tistory.statistics', 'service-packs/tistory/scripts/client.mjs:operations; lib/auth.mjs:decodeJson', 'Read one of the six existing named statistics endpoints.', { query: { operation: text({ required: true, enum: Object.keys(statisticPaths) }) } }),
    categories: op('tistory.categories', 'service-packs/tistory/README.md:manage/category/simple.json; lib/auth.mjs:decodeJson', 'Read the observed category list after owner verification.'),
  }, tistoryActions, [check('health')]),
  definition('reddit', 'Reddit existing OAuth read client', {
    search: op('reddit.search', 'service-packs/social-x/src/reddit.mjs:RedditClient.search', 'OAuth first-page post search; not global comment search.', { query: { q: required(), limit: integer(5, 100), after: text() } }),
    comments: op('reddit.comments', 'service-packs/social-x/src/reddit.mjs:RedditClient.comments', 'Read ranked comments with unresolved more counts; incomplete.', { path: { postId: required() }, query: { limit: integer(5, 100) } }),
  }, redditActions, [check('search', { query: { q: 'Grok 4.7', limit: 1 } })]),
];
