import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { META_SERVICES, loadMetaSession, storeMetaSession, rotateMetaCookies, metaCookieHeader } from '../../naver-blog-api/scripts/meta-auth-session.mjs';
import { withSessionLock } from '../../tistory-api/lib/lock.mjs';
import { hasObservedThreadsGraphqlThrottle, recordThreadsGraphqlCooldown, readThreadsSharedCooldown,
  recordThreadsGraphqlSuccess, recordThreadsHttp429Cooldown, isThreadsGraphqlThrottle,
  THREADS_GRAPHQL_THROTTLED, THREADS_GRAPHQL_BACKOFF, THREADS_HTTP_429_THROTTLED,
  THREADS_HTTP_429_PERSIST_FAILED, THREADS_HTTP_429_BACKOFF } from './threads-graphql-throttle.mjs';
import { reserveThreadsRead, consumeThreadsReadReservation } from './threads-read-budget.mjs';
import { SOCIAL_REQUEST_TIMEOUTS } from './request-timeouts.mjs';
import { traceBotRequest, annotateBotError } from './bot-diagnostics.mjs';
import { createBotDebugFetch } from './bot-debug-log.mjs';

// Only data is parsed. Downloaded JavaScript is never evaluated.
const CONFIGS = new Set(['DTSGInitialData', 'LSD', 'SiteData', 'CurrentUserInitialData',
  'RelayAPIConfigDefaults', 'SprinkleConfig', 'PolarisViewer', 'BarcelonaSharedData', 'InstagramWebPushInfo']);
const SOURCES = new Set(['DTSGUtils', 'getAsyncParams', 'BarcelonaNetworkUtils', 'InstagramAPIFetch',
  'useTHLikeMutationLikeMutation.threads.graphql',
  'useTHLikeMutation', 'useTHCreateRepostMutation.threads.graphql', 'useTHCreateRepostMutation.graphql', 'useTHCreateRepostMutation',
  'useTHFollowMutationFollowMutation.threads.graphql',
  'useTHFollowMutationUnfollowMutation.threads.graphql', 'usePolarisFollowMutation.graphql',
  'usePolarisUnfollowMutation.graphql', 'usePolarisFollowMutation_instagramRelayOperation',
  'usePolarisUnfollowMutation_instagramRelayOperation', 'PolarisProfilePageContentQuery_instagramRelayOperation',
  'PolarisProfilePageContentQuery.graphql', 'PolarisProfilePostsTabContentQuery_connection.graphql',
  'PolarisProfilePostsTabContentQuery_connection_instagramRelayOperation',
  'PolarisMultiCaptionCarouselEnabled.relayprovider', 'PolarisShortDramaEnabled.relayprovider',
  'PolarisReelsRecoDebugOverlayEnabled.relayprovider', 'PolarisIsLoggedIn.relayprovider',
  'PolarisPostCommentsContainerQuery.graphql', 'PolarisPostCommentsContainerQuery_instagramRelayOperation',
  'PolarisPostCommentsPaginationQuery.graphql', 'PolarisPostCommentsPaginationQuery_instagramRelayOperation',
  'PolarisPostChildCommentsQuery.graphql', 'PolarisPostChildCommentsQuery_instagramRelayOperation',
  'PolarisPostCommentsChildrenPaginationtQuery.graphql', 'PolarisPostCommentsChildrenPaginationtQuery_instagramRelayOperation',
  'PolarisPostCommentInputRevampedMutation.graphql', 'PolarisPostCommentInputRevampedMutation_instagramRelayOperation',
  'usePolarisCommentInputRevamped', 'PolarisPostCommentInputRevamped.react',
  'PolarisAPICommentOnPost', 'PolarisAPIDeleteCommentOnPost', 'PolarisAPIApproveRestrictedComment',
  'usePolarisCommentLike', 'usePolarisCommentUnlike', 'usePolarisCommentLikeMutation.graphql',
  'usePolarisCommentLikeMutation_instagramRelayOperation', 'usePolarisCommentUnlikeMutation.graphql',
  'usePolarisCommentUnlikeMutation_instagramRelayOperation',
  'usePolarisPostDeleteComment', 'usePolarisApproveRestrictedComment',
  'usePolarisPostDeleteCommentMutation.graphql', 'usePolarisPostDeleteCommentMutation_instagramRelayOperation',
  'usePolarisApproveRestrictedCommentMutation.graphql', 'usePolarisApproveRestrictedCommentMutation_instagramRelayOperation',
  'PolarisCreationAPI', 'PolarisUploadHelpers', 'PolarisAPIRuploadPhoto', 'PolarisAPIRuploadVideo',
  'polarisVideoMergeUtils',
  'PolarisAPIFbUploaderPhoto', 'XPolarisIGXAPIMediaPublishSidecarControllerRouteBuilder',
  'XPolarisIGXAPIMediaPublishClipsControllerRouteBuilder', 'PolarisInstapi', 'PolarisAPIHelpers',
  'PolarisInstajax', 'PolarisInstajaxRequestHeader', 'PolarisConfig', 'BDHeaderConfig',
  'buildPolarisProfileRoute.entrypoint',
  'PolarisCannesGuardianExperienceEnabled.relayprovider', 'PolarisCASB976ProfileEnabled.relayprovider',
  'PolarisWebSchoolsEnabled.relayprovider', 'PolarisRepostsConsumptionEnabled.relayprovider',
  'PolarisShortDramaEnabled.relayprovider', 'usePolarisFollowMutation', 'usePolarisUnfollowMutation']);
const publicSourceCache = new Map();
export const metaFail = code => { throw Object.assign(new Error(code), { code }); };
export const metaHash = text => createHash('sha256').update(text).digest('hex');

export function createMetaSessionLock({ sessionLock = withSessionLock,
  lockRoot = () => process.env.NODE_TEST_CONTEXT ? path.join(os.tmpdir(), 'social-actions-test-meta-' + process.pid)
    : path.join(os.homedir(), '.config', 'affiliate-content-operations') } = {}) {
  const scope = new AsyncLocalStorage();
  return async (service, operation) => {
    if (!META_SERVICES[service] || typeof operation !== 'function') metaFail('META_ACTION_INPUT');
    const parent = scope.getStore();
    if (parent?.get(service)?.active === true) return operation();
    const lease = { active: true }, current = new Map(parent || []);
    current.set(service, lease);
    try {
      return await sessionLock(() => scope.run(current, async () => {
        try { return await operation(); } finally { lease.active = false; }
      }), { lockPath: path.join(lockRoot(), 'meta-' + service + '-social.lock'), timeoutMs: SOCIAL_REQUEST_TIMEOUTS.sessionLock });
    } catch (error) {
      lease.active = false;
      if (error.code === 'TISTORY_SESSION_BUSY') metaFail('META_SESSION_BUSY');
      throw error;
    }
  };
}
export const withMetaSessionLock = createMetaSessionLock();

// Retry only the idempotent local DPAPI operation. Never place a fetch or a
// social mutation inside this callback, or repeat the request that produced a
// cookie rotation. An authentication/challenge failure is never retried here.
export async function retryMetaCredentialOperation(service, operation, { sleep = delay, onRetry = () => {} } = {}) {
  if (service !== 'threads') return operation();
  try { return await operation(); }
  catch (error) {
    if (!['CREDENTIAL_STORE_UNREADABLE', 'CREDENTIAL_STORE_FAILED', 'CREDENTIAL_STORE_UNVERIFIED'].includes(error.code || error.message)) throw error;
    onRetry(); await sleep(1000); return operation();
  }
}

export async function rotateMetaCookiesWithRetry(bundle, response, now = Date.now()) {
  try {
    if (bundle.service !== 'threads') return rotateMetaCookies(bundle, response, now);
    return await withMetaSessionLock('threads', () => retryMetaCredentialOperation('threads', () => rotateMetaCookies(bundle, response, now)));
  } catch (error) {
    // Local persistence must not hide an already received rejection status.
    if (Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599) error.httpStatus = response.status;
    throw error;
  }
}

export async function boundedText(response, limit = 8_000_000) {
  let size = 0; const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) metaFail('META_RESPONSE_LIMIT');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function parseMetaBootstrap(html, handle) {
  const modules = new Map(), gkx = new Map(), qex = new Map(), profiles = [], media = [];
  const seenMedia = new Set();
  let route, nodes = 0;
  const walk = (v, depth = 0) => {
    if (!v || typeof v !== 'object' || depth > 70) return;
    if (++nodes > 180_000) metaFail('META_DOCUMENT_COMPLEXITY');
    if (Array.isArray(v) && CONFIGS.has(v[0]) && Array.isArray(v[1]) && v[2] && typeof v[2] === 'object') modules.set(v[0], v[2]);
    if (v.initialRouteInfo?.route?.params?.username?.toLowerCase() === handle.toLowerCase()) route = v.initialRouteInfo.route;
    if (typeof v.username === 'string' && v.username.toLowerCase() === handle.toLowerCase()
      && /^\d{1,30}$/.test(String(v.pk ?? v.id ?? '')) && v.friendship_status) profiles.push(v);
    const shortcode = typeof v.code === 'string' ? v.code : typeof v.shortcode === 'string' ? v.shortcode : null;
    const mediaId = v.pk ?? v.id ?? v.media_id;
    const author = v.user?.username ?? v.owner?.username ?? v.username;
    if (shortcode && /^\d{1,30}$/.test(String(mediaId ?? ''))
      && typeof author === 'string' && /^[A-Za-z0-9_.]{1,30}$/.test(author)) {
      const key = shortcode + ':' + String(mediaId) + ':' + author.toLowerCase();
      if (!seenMedia.has(key) && media.length < 500) {
        seenMedia.add(key);
        media.push({ shortcode, id: String(mediaId), owner: author.toLowerCase() });
      }
    }
    for (const [key, value] of Object.entries(v.gkxData || {})) if (typeof value?.result === 'boolean') gkx.set(key, value.result);
    for (const [key, value] of Object.entries(v.qexData || {})) if (value && Object.hasOwn(value, 'r')) qex.set(key, value.r);
    for (const value of Object.values(v)) walk(value, depth + 1);
  };
  for (const match of html.matchAll(/<script\b[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) {
    let value;
    try { value = JSON.parse(match[1]); } catch { continue; }
    walk(value);
  }
  const scriptUrls = [...new Set([...html.matchAll(/https:\/\/static\.cdninstagram\.com\/rsrc\.php\/[^"<>\s\\]+\.js(?:\?[^"<>\s\\]*)?/g)]
    .map(m => m[0].replaceAll('&amp;', '&')))];
  if (scriptUrls.length > 35) metaFail('META_SCRIPT_LIMIT');
  return { modules, gkx, qex, profiles, media, route, scriptUrls };
}

async function loadPublicSources(urls, fetchImpl) {
  const sources = new Map(); let bytes = 0;
  for (let i = 0; i < urls.length; i += 4) {
    const batch = await Promise.all(urls.slice(i, i + 4).map(async url => {
      const parsed = new URL(url);
      if (parsed.origin !== 'https://static.cdninstagram.com' || !parsed.pathname.startsWith('/rsrc.php/') || parsed.username || parsed.password) metaFail('META_SCRIPT_SCOPE');
      let js = publicSourceCache.get(url);
      if (!js) {
        const response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(SOCIAL_REQUEST_TIMEOUTS.publicAsset) });
        if (response.status !== 200) metaFail('META_SCRIPT_HTTP_' + response.status);
        js = await boundedText(response, 15_000_000);
        // Immutable first-party CDN resources only; credentials never reach this request or cache.
        if (publicSourceCache.size < 80) publicSourceCache.set(url, js);
      }
      return { js, url };
    }));
    for (const { js, url } of batch) {
      bytes += Buffer.byteLength(js);
      if (bytes > 60_000_000) metaFail('META_SCRIPT_TOTAL_LIMIT');
      for (const match of js.matchAll(/__d\("([^"]+)"/g)) {
        if (!SOURCES.has(match[1])) continue;
        const end = js.indexOf('__d("', match.index + 4);
        const source = js.slice(match.index, end < 0 ? js.length : end);
        const existing = sources.get(match[1]);
        if (existing && existing.source !== source) metaFail('META_SOURCE_AMBIGUOUS');
        sources.set(match[1], { source, sha256: metaHash(source), url: new URL(url).origin + new URL(url).pathname });
      }
    }
  }
  return sources;
}

function validToken(value) { return typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\x00-\x20\x7f]/.test(value); }
function cookieHeader(bundle, url) { return metaCookieHeader(bundle, url); }

function isObservedThreadsQuotedPostFieldError(error, payload) {
  if (!error || typeof error !== 'object' || Array.isArray(error)
    || error.code !== 4686025 || error.severity !== 'ERROR'
    || error.is_not_critical !== true || error.requires_reauth !== false
    || error.is_transient !== false || error.is_silent !== true || error.allow_user_retry !== false
    || !Array.isArray(error.path)) return false;
  const providerText = [error.message, error.summary, error.description, error.description_raw]
    .filter(value => typeof value === 'string').join(' ');
  if (/(?:^|[^a-z0-9])(?:login|session|credential|permission|forbidden|(?:re-?)?auth(?:entication|orization)?|unauthori[sz]ed|access[\s_-]+denied)(?:[^a-z0-9]|$)/i.test(providerText)) return false;
  const path = error.path;
  const field = value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(value);
  if (path.length !== 14 && path.length !== 15) return false;
  if (path[0] !== 'media' || path[1] !== 'text_post_app_info' || path[2] !== 'direct_replies'
    || path[3] !== 'edges' || !Number.isSafeInteger(path[4]) || path[4] < 0 || path[5] !== 'node'
    || path[6] !== 'posts' || path[7] !== 'edges' || !Number.isSafeInteger(path[8]) || path[8] < 0
    || path[9] !== 'node' || path[10] !== 'text_post_app_info' || path[11] !== 'share_info'
    || path[12] !== 'quoted_post') return false;
  const quotedField = path.length === 14 ? path[13]
    : path[13] === 'text_post_app_info' ? path[14] : null;
  if (!field(quotedField)) return false;

  const edges = payload?.data?.media?.text_post_app_info?.direct_replies?.edges;
  if (!Array.isArray(edges) || edges.length > 100 || path[4] >= edges.length) return false;
  const posts = edges[path[4]]?.node?.posts?.edges;
  if (!Array.isArray(posts) || posts.length > 100 || path[8] >= posts.length) return false;
  const replyInfo = posts[path[8]]?.node?.text_post_app_info;
  const shareInfo = replyInfo?.share_info;
  if (!replyInfo || !shareInfo || typeof shareInfo !== 'object' || Array.isArray(shareInfo)) return false;
  const quotedPost = shareInfo.quoted_post;
  if (quotedPost != null && (typeof quotedPost !== 'object' || Array.isArray(quotedPost))) return false;
  const quotedPostInfo = quotedPost?.text_post_app_info;
  if (path.length === 15 && quotedPostInfo != null
    && (typeof quotedPostInfo !== 'object' || Array.isArray(quotedPostInfo))) return false;
  return true;
}

function isObservedThreadsCommentPagePartialRead(context, operation, graphPath, payload, markers) {
  return context.service === 'threads'
    && ['BarcelonaPostPageDownwardQuery', 'BarcelonaPostPageDirectRepliesRefetchQuery'].includes(operation)
    && graphPath === '/api/graphql' && !payload?.error && payload?.data?.media
    && typeof payload.data.media === 'object' && !Array.isArray(payload.data.media)
    && Array.isArray(payload.errors) && payload.errors.length > 0 && payload.errors.length <= 10_000
    && !/friction|challenge|checkpoint|captcha/i.test(markers)
    && payload.errors.every(error => isObservedThreadsQuotedPostFieldError(error, payload));
}

export async function openMetaContext(service, handle, options = {}) {
  let { fetchImpl = globalThis.fetch, readBudgetRoot, readBudgetLimits, readBudgetReservation, throttleRoot } = options;
  // Injectable session persistence is restricted to Node's test runner so
  // production callers always use the protected Windows credential store.
  const loadSession = process.env.NODE_TEST_CONTEXT ? options.loadSession || loadMetaSession : loadMetaSession;
  const storeSession = process.env.NODE_TEST_CONTEXT ? options.storeSession || storeMetaSession : storeMetaSession;
  const freshDocument = 'fetchImpl' in options || options.freshDocument === true || readBudgetReservation != null;
  if(service==='threads')fetchImpl=createBotDebugFetch(fetchImpl,{service});
  return withMetaSessionLock(service, () => openLockedMetaContext(service, handle,
    { fetchImpl, readBudgetRoot, readBudgetLimits, readBudgetReservation, throttleRoot, freshDocument, loadSession, storeSession }));
}

// The owner's own Threads profile document was fetched 1,022 times in ~5 h (2026-10-02) because every owner read
// opened a fresh context. Within one process the verified owner document, its page tokens and script sources are
// reused for 10 minutes; cookies are always re-read from the protected store and the owner identity re-checked.
// Tokens stay in memory only.
export const OWNER_DOCUMENT_TTL_MS = 10 * 60000;
const ownerDocuments = new Map();
export function forgetMetaOwnerDocument(service) { ownerDocuments.delete(service); }

async function openLockedMetaContext(service, handle, options = {}) {
  const { fetchImpl = globalThis.fetch, readBudgetRoot, readBudgetLimits, readBudgetReservation, throttleRoot,
    loadSession = loadMetaSession, storeSession = storeMetaSession } = options;
  const config = META_SERVICES[service];
  if (!config || !/^[A-Za-z0-9_.]{1,30}$/.test(handle || '')) metaFail('META_ACTION_INPUT');
  // A caller passing its own fetchImpl observes the document fetch itself (the reply loader reads the app version
  // from that exact response), so it always gets a fresh document. A cached context made every reply fail with
  // THREADS_REPLY_APP_VERSION_DOCUMENT_MISSING (2026-10-02).
  if (service === 'threads' && !process.env.NODE_TEST_CONTEXT && options.freshDocument !== true) {
    const cached = ownerDocuments.get(service);
    if (cached && cached.handle === handle.toLowerCase() && Date.now() - cached.verifiedAt < OWNER_DOCUMENT_TTL_MS) {
      const bundle = await retryMetaCredentialOperation(service, () => loadSession(service), {});
      if (bundle.owner?.toLowerCase() === cached.owner && String(bundle.ownerId) === cached.ownerId) {
        return { ...cached.context, bundle, fetchImpl, createdAt: Date.now(), requestCount: 0,
          ...(readBudgetRoot ? { readBudgetRoot } : {}), ...(readBudgetLimits ? { readBudgetLimits } : {}),
          ...(throttleRoot ? { throttleRoot } : {}),
          documentReceipt: { ...cached.context.documentReceipt, bootstrap: 'cached_authenticated_http_document',
            documentVerifiedAt: new Date(cached.verifiedAt).toISOString(), credentialRetries: { read: 0, write: 0 } } };
      }
      ownerDocuments.delete(service);
    }
  }
  return traceBotRequest({ method: 'GET', path: '/{profile}', operation: 'protected_profile_bootstrap',
    timeoutMs: SOCIAL_REQUEST_TIMEOUTS.read, writeSent: false }, async trace => {
  if(service==='threads') {
    const cooldown=await readThreadsSharedCooldown({...(throttleRoot?{root:throttleRoot}:{})});
    if(cooldown) {
      trace.stage('cooldown_gate',{status:cooldown.httpStatus,headers:{get:()=>null}});
      throw blockedThreadsCooldown(cooldown,{method:'GET',path:'/{profile}',operation:'protected_profile_bootstrap'});
    }
  }
  const credentialRetries = { read: 0, write: 0 };
  trace.stage('credential_read');
  const bundle = await retryMetaCredentialOperation(service, () => loadSession(service), { onRetry: () => credentialRetries.read++ });
  const url = config.origin + (service === 'threads' ? '/@' : '/') + handle + '/';
  trace.stage('fetch');
  if (service === 'threads') {
    if(readBudgetReservation) await consumeThreadsReadReservation({reservation:readBudgetReservation,operation:'ThreadsProfileDocumentRead',
      ownerId:String(bundle.ownerId),handle:handle.toLowerCase(),postId:readBudgetReservation.postId});
    else await reserveThreadsRead({ operation: 'ThreadsProfileDocumentRead', root: readBudgetRoot, limits: readBudgetLimits });
  }
  const response = await fetchImpl(url, { headers: { accept: 'text/html', 'accept-language': META_ACCEPT_LANGUAGE, cookie: cookieHeader(bundle, url), 'cache-control': 'no-cache' },
    redirect: 'manual', signal: AbortSignal.timeout(SOCIAL_REQUEST_TIMEOUTS.read) });
  trace.stage('cookie_persistence', response);
  const observed429 = service === 'threads' && response.status === 429
    ? await recordObservedThreadsHttp429(response,'protected_profile_bootstrap',throttleRoot) : null;
  await rotateMetaCookiesWithRetry(bundle, response);
  if(observed429) {
    throw Object.assign(new Error(observed429.cooldownPersisted===false?THREADS_HTTP_429_PERSIST_FAILED:'META_DOCUMENT_HTTP_429'),{
      ...observed429,code:observed429.cooldownPersisted===false?THREADS_HTTP_429_PERSIST_FAILED:'META_DOCUMENT_HTTP_429',
      httpStatus:429,dispatchStarted:true,writeSent:false});
  }
  if (response.status !== 200) metaFail('META_DOCUMENT_HTTP_' + response.status);
  if (!/^text\/html(?:;|$)/i.test(response.headers.get('content-type') || '')) metaFail('META_DOCUMENT_MIME');
  trace.stage('response_body', response);
  const html = await boundedText(response); trace.body(html); trace.stage('decode');
  const document = parseMetaBootstrap(html, handle);
  const required = ['DTSGInitialData', 'LSD', 'SiteData', 'CurrentUserInitialData', 'RelayAPIConfigDefaults', 'SprinkleConfig'];
  if (required.some(name => !document.modules.has(name))) metaFail('META_LOGIN_OR_BOOTSTRAP_REQUIRED');
  if (!validToken(document.modules.get('DTSGInitialData').token) || !validToken(document.modules.get('LSD').token)) metaFail('META_BOOTSTRAP_TOKEN_MISSING');
  if (service === 'instagram' && document.modules.get('PolarisViewer')?.data?.username?.toLowerCase() !== bundle.owner.toLowerCase()) metaFail('META_DOCUMENT_OWNER_MISMATCH');
  if (service === 'threads') {
    // Meta's USER_ID is "0" here; the service identity is BarcelonaSharedData.viewer.
    const viewer = document.modules.get('BarcelonaSharedData')?.viewer;
    if (viewer?.username?.toLowerCase() !== bundle.owner.toLowerCase() || String(viewer?.id || '') !== bundle.ownerId) metaFail('META_DOCUMENT_OWNER_MISMATCH');
  }
  const relay = document.modules.get('RelayAPIConfigDefaults');
  if (!/^\d{1,30}$/.test(String(relay.actorID || '')) || !['/api/graphql', '/api/graphql/'].includes(relay.graphURI)) metaFail('META_RELAY_SCOPE');
  // The fresh document verifies the protected owner directly, without replaying a cached GraphQL CSRF envelope.
  bundle.verifiedAt = new Date().toISOString();
  trace.stage('credential_write');
  await retryMetaCredentialOperation(service, () => storeSession(service, bundle), { onRetry: () => credentialRetries.write++ });
  trace.stage('bootstrap');
  const sources = await loadPublicSources(document.scriptUrls, fetchImpl);
  const context = { service, handle, bundle, url, document, sources, fetchImpl, createdAt: Date.now(), requestCount: 0,
    ...(readBudgetReservation ? { readBudgetReservation } : {}),
    ...(readBudgetRoot ? { readBudgetRoot } : {}), ...(readBudgetLimits ? { readBudgetLimits } : {}),
    ...(throttleRoot ? { throttleRoot } : {}),
    documentReceipt: { httpStatus: response.status, bytes: Buffer.byteLength(html), bootstrap: 'fresh_authenticated_http_document',
       browserUsed: false, ownerVerified: true, tokenValuesRecorded: false, credentialRetries } };
  if (service === 'threads' && !process.env.NODE_TEST_CONTEXT && handle.toLowerCase() === bundle.owner.toLowerCase()) {
    ownerDocuments.set(service, { handle: handle.toLowerCase(), owner: bundle.owner.toLowerCase(), ownerId: String(bundle.ownerId),
      verifiedAt: Date.now(), context: { service, handle, url, document, sources, documentReceipt: context.documentReceipt } });
  }
  return context;
  });
}

export async function loadInstagramPostSources(context, { shortcode, isReel = false, mediaId } = {}) {
  if (context?.service !== 'instagram' || typeof shortcode !== 'string'
    || !/^[A-Za-z0-9_-]{1,64}$/.test(shortcode) || typeof isReel !== 'boolean'
    || mediaId != null && !/^\d{1,30}$/.test(String(mediaId))) {
    metaFail('INSTAGRAM_POST_SOURCE_INPUT');
  }
  const path = `/${isReel ? 'reel' : 'p'}/${shortcode}/`;
  const url = context.bundle.origin + path;
  const response = await context.fetchImpl(url, {
    headers: { accept: 'text/html', 'accept-language': META_ACCEPT_LANGUAGE, cookie: cookieHeader(context.bundle, url), 'cache-control': 'no-cache' },
    redirect: 'manual', signal: AbortSignal.timeout(SOCIAL_REQUEST_TIMEOUTS.read),
  });
  await rotateMetaCookiesWithRetry(context.bundle, response);
  if (response.status !== 200) metaFail('INSTAGRAM_POST_DOCUMENT_HTTP_' + response.status);
  if (!/^text\/html(?:;|$)/i.test(response.headers.get('content-type') || '')) metaFail('INSTAGRAM_POST_DOCUMENT_MIME');
  const html = await boundedText(response);
  const document = parseMetaBootstrap(html, context.handle || context.bundle.owner);
  if (document.modules.get('PolarisViewer')?.data?.username?.toLowerCase() !== context.bundle.owner.toLowerCase()) {
    metaFail('META_DOCUMENT_OWNER_MISMATCH');
  }
  const matched = document.media.filter(item => item.shortcode === shortcode);
  if (matched.length !== 1 || matched[0].owner !== String(context.handle || '').toLowerCase()
    || mediaId != null && matched[0].id !== String(mediaId)) metaFail('INSTAGRAM_POST_IDENTITY_MISMATCH');
  if (!document.scriptUrls.length) metaFail('INSTAGRAM_POST_SOURCES_MISSING');
  const sources = await loadPublicSources(document.scriptUrls, context.fetchImpl);
  return {
    sources, post: matched[0],
    receipt: { httpStatus: response.status, bytes: Buffer.byteLength(html), scriptCount: document.scriptUrls.length,
      browserUsed: false, authenticatedViewerVerified: true, source: 'current_first_party_post_document_and_static_modules' },
  };
}

export function relayDocId(context, operation, moduleName = operation + '_instagramRelayOperation') {
  const entry = context.sources.get(moduleName);
  if (!entry) metaFail('META_OPERATION_SOURCE_MISSING');
  const id = /\.exports="(\d{10,30})"/.exec(entry.source)?.[1] || /params:\{id:"(\d{10,30})"/.exec(entry.source)?.[1];
  if (!id) metaFail('META_OPERATION_DOCUMENT_MISSING');
  return id;
}

// Tokens come from the current authenticated first-party document. jazoest is
// derived by the first-party DTSGUtils algorithm already checked in metaRequest;
// this helper returns values for request memory only and persists nothing.
export function freshMetaAuthFields(context) {
  if (Date.now() - context?.createdAt > 180_000) metaFail('META_CONTEXT_EXPIRED');
  const token = context?.document?.modules?.get('DTSGInitialData')?.token;
  const lsd = context?.document?.modules?.get('LSD')?.token;
  const sprinkle = context?.document?.modules?.get('SprinkleConfig');
  const util = context?.sources?.get('DTSGUtils')?.source || '';
  if (!validToken(token) || !validToken(lsd) || sprinkle?.param_name !== 'jazoest' || sprinkle.version !== 2
    || sprinkle.should_randomize !== false || !util.includes('.charCodeAt(') || !util.includes('SprinkleConfig')) {
    metaFail('META_TOKEN_DERIVATION_CHANGED');
  }
  let sum = 0;
  for (let i = 0; i < token.length; i += 1) sum += token.charCodeAt(i);
  return { fbDtsg: token, jazoest: '2' + sum, lsd };
}

// 2026-10-22: a Chrome user-agent on the profile document fetch makes Threads serve the client-rendered shell with no
// embedded profile (every pre-follow lookup -> META_TARGET_NOT_FOUND; same request with Node's UA embeds 6 profile rows).
// So no custom user-agent is sent anywhere (proven path); META_USER_AGENT is kept exported but unused.
// 2026-10-21 trace (web-api-playbook capture of a real Follow back click): the browser sends a Chrome user-agent and
// accept-language; the bot sent Node's default UA. Keep the same desktop Chrome identity as the logged-in box browser.
export const META_USER_AGENT = (process.env.META_USER_AGENT && !/[\r\n]/.test(process.env.META_USER_AGENT) && process.env.META_USER_AGENT.length <= 256)
  ? process.env.META_USER_AGENT : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
const META_ACCEPT_LANGUAGE = 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7';

export function metaRequest(context, operation, docId, variables, { canonicalRouteName, graphPath = '/api/graphql' } = {}) {
  if (graphPath !== '/api/graphql' && !(context.service === 'threads' && graphPath === '/graphql/query')) metaFail('META_REQUEST_SCOPE');
  if (Date.now() - context.createdAt > 180_000) metaFail('META_CONTEXT_EXPIRED');
  const { modules, route } = context.document;
  const site = modules.get('SiteData'), relay = modules.get('RelayAPIConfigDefaults');
  const { fbDtsg: token, jazoest, lsd } = freshMetaAuthFields(context);
  const form = new URLSearchParams({ av: String(relay.actorID), __user: String(modules.get('CurrentUserInitialData').USER_ID),
    __a: '1', __req: (++context.requestCount).toString(36), __hs: String(site.haste_session), dpr: String(site.pr),
    __rev: String(site.client_revision), __hsi: String(site.hsi), __comet_req: String(site.comet_env),
    fb_dtsg: token, jazoest, lsd, __spin_r: String(site.__spin_r), __spin_b: String(site.__spin_b),
    __spin_t: String(site.__spin_t), fb_api_caller_class: 'RelayModern', fb_api_req_friendly_name: operation,
    server_timestamps: 'true', variables: JSON.stringify(variables), doc_id: docId });
  const routeName = canonicalRouteName || route?.canonicalRouteName;
  if (routeName) form.set('__crn', routeName);
  for (const field of ['__hs', 'dpr', '__rev', '__hsi', '__comet_req', '__spin_r', '__spin_b', '__spin_t', '__user']) {
    if (['undefined', 'null', ''].includes(form.get(field))) metaFail('META_BOOTSTRAP_FIELD_MISSING');
  }
  const requestUrl = context.bundle.origin + graphPath;
  const headers = { accept: '*/*', 'content-type': 'application/x-www-form-urlencoded', origin: context.bundle.origin,
    'accept-language': META_ACCEPT_LANGUAGE,
    referer: context.url, cookie: cookieHeader(context.bundle, requestUrl),
    'x-csrftoken': context.bundle.cookies.find(c => c.name === 'csrftoken').value,
    'x-fb-lsd': lsd, 'x-fb-friendly-name': operation };
  for (const [name, value] of Object.entries(relay.customHeaders || {})) {
    if (['x-ig-app-id', 'x-ig-d'].includes(name.toLowerCase()) && typeof value === 'string'
      && value.length <= 256 && !/[\r\n]/.test(value)) headers[name.toLowerCase()] = value;
  }
  if (!headers['x-ig-app-id']) metaFail('META_APP_ID_MISSING');
  return { url: requestUrl, method: 'POST', headers, body: form,
    redirect: 'manual', signal: AbortSignal.timeout(operation.includes('Mutation') ? SOCIAL_REQUEST_TIMEOUTS.write : SOCIAL_REQUEST_TIMEOUTS.read) };
}

export async function sendMetaQuery(context, request) {
  // The cooldown check and dispatch share the existing cross-process owner
  // lease. A second worker must observe the first response before it can send.
  // Use the reentrant session lock before cookie persistence to retain one
  // lock order and avoid a request-lock/session-lock deadlock.
  if (context.service === 'threads') return withMetaSessionLock('threads', () => sendLockedMetaQuery(context, request));
  return sendLockedMetaQuery(context, request);
}

function blockedThreadsCooldown(cooldown,{method,path,operation}) {
  const code=isThreadsGraphqlThrottle(cooldown)?THREADS_GRAPHQL_THROTTLED:cooldown.code||THREADS_HTTP_429_THROTTLED;
  return annotateBotError(Object.assign(new Error(code),{
    ...cooldown,code,cooldownPersisted:cooldown.cooldownPersisted!==false,
    dispatchStarted:false,writeSent:false,
  }),{method,path,operation,stage:'cooldown_gate',httpStatus:cooldown.httpStatus,writeSent:false,elapsedMs:0});
}

async function recordObservedThreadsHttp429(response,operation,root) {
  try {
    return await recordThreadsHttp429Cooldown({response,operation,...(root?{root}:{})});
  } catch(error) {
    const now=Date.now(),retryAt=Number.isSafeInteger(error?.retryAt)?error.retryAt:now+THREADS_HTTP_429_BACKOFF.fallbackMilliseconds;
    const reset=Number(error?.rateLimitReset);
    return {httpStatus:429,code:THREADS_HTTP_429_PERSIST_FAILED,rateLimited:true,
      cooldownReason:'http_429_rate_limit',retryAt,deadlineSource:error?.deadlineSource||'local_fallback_15_minutes',
      ...(Number.isSafeInteger(error?.retryAfterSeconds)?{retryAfterSeconds:error.retryAfterSeconds}:{}),
      ...(Number.isSafeInteger(error?.providerRetryAfterSeconds)?{providerRetryAfterSeconds:error.providerRetryAfterSeconds}:{}),
      ...(Number.isSafeInteger(reset)&&reset>0?{rateLimitReset:reset}:{}),
      fallbackMilliseconds:error?.fallbackMilliseconds??THREADS_HTTP_429_BACKOFF.fallbackMilliseconds,
      cooldownPersisted:false};
  }
}

async function sendLockedMetaQuery(context, request) {
  const { url, ...init } = request;
  const graphPath = url === context.bundle.origin + '/api/graphql' ? '/api/graphql'
    : context.service === 'threads' && url === context.bundle.origin + '/graphql/query' ? '/graphql/query' : null;
  if (!graphPath) metaFail('META_REQUEST_SCOPE');
  const operation = request.body.get('fb_api_req_friendly_name');
  if (context.service === 'threads') {
    const cooldown = await readThreadsSharedCooldown({ ...(context.throttleRoot ? { root: context.throttleRoot } : {}) });
    if (cooldown) throw blockedThreadsCooldown(cooldown,{method:'POST',path:graphPath,operation});
    if (!operation.includes('Mutation')) {
      if(context.readBudgetReservation) {
        let variables;
        try {variables=JSON.parse(request.body.get('variables'));}catch{metaFail('THREADS_READ_RESERVATION_MISMATCH');}
        await consumeThreadsReadReservation({reservation:context.readBudgetReservation,operation,ownerId:String(context.bundle.ownerId),
          handle:context.handle,postId:String(variables?.postID||'')});
      } else await reserveThreadsRead({ operation, root: context.readBudgetRoot, limits: context.readBudgetLimits });
    }
  }
  const requestStartedAt = Date.now();
  return traceBotRequest({ method: 'POST', path: graphPath, operation,
    timeoutMs: operation.includes('Mutation') ? SOCIAL_REQUEST_TIMEOUTS.write : SOCIAL_REQUEST_TIMEOUTS.read,
    writeSent: operation.includes('Mutation') }, async trace => {
  const response = await context.fetchImpl(url, init);
  trace.stage('cookie_persistence', response);
  const observed429 = context.service === 'threads' && response.status === 429
    ? await recordObservedThreadsHttp429(response,operation,context.throttleRoot) : null;
  await rotateMetaCookiesWithRetry(context.bundle, response);
    if (response.status !== 200) {
      if ([400, 401, 403].includes(response.status)) forgetMetaOwnerDocument(context.service);
    const error = Object.assign(new Error('META_GRAPHQL_HTTP_' + response.status), {
      code: 'META_GRAPHQL_HTTP_' + response.status, httpStatus: response.status,
    });
      const retryAfter = response.headers.get('retry-after');
      if (retryAfter) {
        const seconds = Number(retryAfter);
        const parsed = Number.isFinite(seconds) && seconds >= 0
          ? Math.ceil(seconds) : Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000);
        if (Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 86_400) error.retryAfterSeconds = parsed;
      }
      const rawReset = response.headers.get('x-ratelimit-reset') || response.headers.get('x-rate-limit-reset');
      const reset = rawReset == null ? NaN : Number(rawReset);
      if (Number.isSafeInteger(reset) && reset > 0 && reset <= 99_999_999_999_999) error.rateLimitReset = reset;
      if(observed429) {
        throw Object.assign(new Error(observed429.cooldownPersisted===false?THREADS_HTTP_429_PERSIST_FAILED:'META_GRAPHQL_HTTP_429'),{
          ...observed429,code:observed429.cooldownPersisted===false?THREADS_HTTP_429_PERSIST_FAILED:'META_GRAPHQL_HTTP_429',
          httpStatus:429,dispatchStarted:true,writeSent:operation.includes('Mutation')});
      }
      throw error;
    }
  if (!/^(?:application\/json|text\/javascript)(?:;|$)/i.test(response.headers.get('content-type') || '')) metaFail('META_GRAPHQL_MIME');
  trace.stage('response_body', response);
  const text = await boundedText(response, 5_000_000); trace.body(text); trace.stage('decode');
  let payload;
  try { payload = JSON.parse(text.replace(/^for \(;;\);\s*/, '')); } catch { metaFail('META_GRAPHQL_NOT_JSON'); }
  if (payload.errors?.length || payload.error) {
    // A friction/checkpoint response is a stop condition. There is no bypass operation.
    const markers = JSON.stringify(payload.errors || payload.error);
    if (context.service === 'threads' && hasObservedThreadsGraphqlThrottle(payload)) {
      const now = Date.now();
      let cooldown;
      try { cooldown = await recordThreadsGraphqlCooldown({ response, operation: request.body.get('fb_api_req_friendly_name'),
        now, ...(context.throttleRoot ? { root: context.throttleRoot } : {}) }); }
      catch { cooldown = { httpStatus: 200, retryAt: now + THREADS_GRAPHQL_BACKOFF.initialMilliseconds, cooldownPersisted: false,
        fallbackMilliseconds: THREADS_GRAPHQL_BACKOFF.initialMilliseconds, deadlineSource: 'local_fallback' }; }
      throw Object.assign(new Error(THREADS_GRAPHQL_THROTTLED), { ...cooldown, code: THREADS_GRAPHQL_THROTTLED,
        rateLimited: true, providerErrorCode: 1675004, cooldownReason: 'graphql_200_rate_limit' });
    }
    if (isObservedThreadsCommentPagePartialRead(context, operation, graphPath, payload, markers)) {
      return { payload: null, partialGraphqlRead: true, receipt: {
        operation, method: 'POST', path: graphPath, httpStatus: response.status,
        mime: (response.headers.get('content-type') || '').split(';')[0].toLowerCase(),
        bytes: Buffer.byteLength(text), responseSha256: metaHash(text), checkedAt: new Date().toISOString(),
        executionMode: 'pure_http', browserUsed: false, partialGraphqlRead: true,
        providerErrorCode: 4686025, providerErrorCount: payload.errors.length,
      } };
    }
    forgetMetaOwnerDocument(context.service);
    const interaction = /friction|challenge|checkpoint|captcha/i.test(markers);
    // 2026-10-19 (box follow-back @dalbichangae): a rejection carried no reason, so keep the provider's numeric code and a
    // short scrubbed summary (letters/spaces only, no token-like strings) for the journal and the caller.
    const first = (payload.errors || [payload.error]).find(Boolean) || {};
    const providerErrorCode = [first.code, first.api_error_code, first.error_subcode].find(v => Number.isSafeInteger(Number(v)) && String(v).length <= 12);
    const summary = String(first.summary || first.message || first.description || '').replace(/[A-Za-z0-9_\-:%=]{24,}/g, '').replace(/[^\p{L}\p{N} .,'?!()-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    throw Object.assign(new Error(interaction ? 'META_INTERACTION_REQUIRED' : 'META_GRAPHQL_REJECTED'), {
      code: interaction ? 'META_INTERACTION_REQUIRED' : 'META_GRAPHQL_REJECTED',
      ...(providerErrorCode !== undefined ? { providerErrorCode: Number(providerErrorCode) } : {}), ...(summary ? { providerErrorSummary: summary } : {}) });
  }
  if (!payload.data || typeof payload.data !== 'object') { forgetMetaOwnerDocument(context.service); metaFail('META_GRAPHQL_DATA_MISSING'); }
  if (context.service === 'threads') await recordThreadsGraphqlSuccess({ operation, requestStartedAt,
    ...(context.throttleRoot ? { root: context.throttleRoot } : {}) });
  return { payload, receipt: { httpStatus: response.status, bytes: Buffer.byteLength(text), operation: request.body.get('fb_api_req_friendly_name'),
    method: 'POST', path: graphPath, browserUsed: false, checkedAt: new Date().toISOString() } };
  });
}
