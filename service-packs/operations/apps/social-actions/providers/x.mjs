import path from 'node:path';
import { SOCIAL_REQUEST_TIMEOUTS } from '../lib/request-timeouts.mjs';
import { annotateBotError, traceBotRequest, safeBotFailure } from '../lib/bot-diagnostics.mjs';
import { createBotDebugFetch } from '../lib/bot-debug-log.mjs';
import {withReadBudget} from '../x-read-budget.mjs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { webApiPlaybookRoot } from '../../affiliate-api-hub/adapters/web-auth-provider.mjs';
import { contractsFromSource } from '../../naver-blog-api/research/content-store/x-xhr.mjs';

const API_ORIGIN = 'https://api.x.com';
const WEB_ORIGIN = 'https://x.com';
const X_STATE = 'x-web-state';
const API_ORIGINS = ['https://x.com', API_ORIGIN];
const FEATURE_FIELDS = Object.freeze({
  include_profile_interstitial_type: '1',
  include_blocking: '1',
  include_blocked_by: '1',
  include_followed_by: '1',
  include_want_retweets: '1',
  include_mute_edge: '1',
  include_can_dm: '1',
  include_can_media_tag: '1',
  include_ext_is_blue_verified: '1',
  include_ext_verified_type: '1',
  include_ext_profile_image_shape: '1',
  skip_status: '1',
});

export class XSocialActionError extends Error {
  constructor(code, receipt = {}) {
    super(code);
    this.name = 'XSocialActionError';
    this.code = code;
    this.receipt = receipt;
  }
}

function fail(code, receipt) { throw new XSocialActionError(code, receipt); }
// x.com GraphQL reads intermittently answer 404 with an empty body for the same session that succeeds on the next
// call (2026-10-01..02: SearchTimeline 10/306, Followers 8/232, UserTweetsAndReplies 2/242; TweetDetail 0/756).
// Reads are idempotent, so retry those twice before surfacing a failure.
export const GRAPHQL_READ_404_RETRIES = 2;
export function transientGraphqlRead404(response) {
  return response?.status === 404 && !String(response.raw ?? '').length;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, process.env.NODE_TEST_CONTEXT ? 0 : ms));
export function ownerReadCanRetry(response) {
  if ([500, 502, 503, 504].includes(response.status)) return true;
  // This exact read intermittently returns 404 despite succeeding with the same saved session.
  // Retry only the JSON page-missing code, never authentication/rate/challenge errors.
  if (response.status !== 404 || !response.headers['content-type']?.includes('json')) return false;
  try { const errors = JSON.parse(response.raw)?.errors; return Array.isArray(errors) && errors.length > 0 && errors.every(e => e.code === 34); } catch { return false; }
}
const validHandle = value => typeof value === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(value);
const validId = value => typeof value === 'string' && /^\d{1,25}$/.test(value);

function normalizeInput(input) {
  const operation = input?.operation ?? input?.action;
  const target = input?.target ?? input?.targetHandle;
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || !['follow', 'unfollow'].includes(operation) || !validHandle(target)
    || input.operation != null && input.action != null && input.operation !== input.action
    || input.target != null && input.targetHandle != null && input.target !== input.targetHandle) {
    fail('X_ACTION_INPUT_INVALID');
  }
  return { operation, target };
}

function ownerUrlIsValid(value) {
  try {
    const url = new URL(value);
    return url.origin === API_ORIGIN && url.pathname === '/1.1/account/settings.json'
      && !url.hash && !url.username && !url.password
      && [...url.searchParams].every(([name, entry]) =>
        (name.startsWith('include_') && entry === 'true') || (name === 'ext' && entry === 'ssoConnections'));
  } catch { return false; }
}

function exactOrigins(value) {
  return Array.isArray(value) && JSON.stringify(value) === JSON.stringify(API_ORIGINS);
}

function apiHeadersFrom(state) {
  const headers = state?.session?.headersByOrigin?.[API_ORIGIN];
  if (!headers || typeof headers.authorization !== 'string' || !/^Bearer [A-Za-z0-9%._~-]+$/.test(headers.authorization)) {
    fail('X_ACTION_SESSION_INVALID');
  }
  return headers;
}

function userFromGraphQL(raw, target) {
  let payload;
  try { payload = JSON.parse(raw); } catch { fail('X_PROFILE_RESPONSE_INVALID'); }
  if (payload?.errors?.length || !payload?.data?.user?.result) fail('X_PROFILE_RESPONSE_INVALID');
  const user = payload.data.user.result;
  const handle = user?.core?.screen_name;
  const following = user?.relationship_perspectives?.following;
  const outgoingRequest = user?.follow_request_sent;
  if (user?.__typename !== 'User' || handle?.toLowerCase() !== target.toLowerCase() || !validId(user.rest_id)) {
    fail('X_PROFILE_IDENTITY_MISMATCH');
  }
  if (typeof following !== 'boolean' || typeof outgoingRequest !== 'boolean') {
    fail('X_RELATIONSHIP_UNVERIFIED', { operation: 'UserByScreenName' });
  }
  const pinned = user.legacy?.pinned_tweet_ids_str;
  return { userId: user.rest_id, handle, protected: user.privacy?.protected ?? user.legacy?.protected ?? null, pinnedPostIds: Array.isArray(pinned) ? pinned.filter(validId) : null, relation: { following, followRequestSent: outgoingRequest,followsMe:typeof user.relationship_perspectives?.followed_by==='boolean'?user.relationship_perspectives.followed_by:null } };
}

function expectedState(action, relation) {
  if (action === 'follow') {
    if (relation.following) return 'already_following';
    if (relation.followRequestSent) return 'follow_request_pending';
    return 'ready';
  }
  if (relation.following) return 'ready';
  if (relation.followRequestSent) return 'ready_to_cancel';
  return 'already_unfollowed';
}

function responseStatusError(status, operation) {
  const receipt = { operation, httpStatus: status, browserUsed: false, executionMode: 'pure_http' };
  if (status === 401) fail('X_REAUTH_REQUIRED', receipt);
  if (status === 403 || status === 418) fail('X_ACTION_BLOCKED', receipt);
  if (status === 429) fail('X_RATE_LIMITED', receipt);
  if (status >= 500) fail('X_ACTION_OUTCOME_UNKNOWN', { ...receipt, outcome: 'unknown' });
  fail('X_HTTP_REJECTED', receipt);
}

async function loadRuntime(root = webApiPlaybookRoot()) {
  const moduleUrl = relative => pathToFileURL(path.join(root, relative)).href;
  const require = createRequire(pathToFileURL(path.join(root, 'package.json')));
  const [{ ProtectedStore }, { ScopedSession }, { withSessionLock }, { createHttpXTransaction }, { isMissingXOwnerRoute, verifyXHomeOwner }, { cachedXOwner, rememberXOwner, forgetXOwner }] = await Promise.all([
    import(moduleUrl('lib/protected-store.mjs')),
    import(moduleUrl('lib/scoped-session.mjs')),
    import(moduleUrl('lib/session-lock.mjs')),
    import(moduleUrl('lib/web-auth/x-transaction.mjs')),
    import(moduleUrl('lib/web-auth/x-owner-home.mjs')),
    import(moduleUrl('lib/web-auth/x-owner-cache.mjs')),
  ]);
  const { CookieJar } = require('tough-cookie');
  return { ProtectedStore, ScopedSession, withSessionLock, createHttpXTransaction, CookieJar, isMissingXOwnerRoute, verifyXHomeOwner, cachedXOwner, rememberXOwner, forgetXOwner };
}

async function withVerifiedSession(work, { fetchImpl = globalThis.fetch, playbookRoot } = {}) {
  fetchImpl=createBotDebugFetch(fetchImpl,{service:'x'});
  const root = playbookRoot || webApiPlaybookRoot();
  const { ProtectedStore, ScopedSession, withSessionLock, createHttpXTransaction, CookieJar, cachedXOwner, rememberXOwner, forgetXOwner } = await loadRuntime(root);
  const store = new ProtectedStore();
  return withSessionLock(async () => {
    const raw = store.read(X_STATE);
    if (!raw) fail('X_ACTION_SESSION_MISSING');
    let state;
    try { state = JSON.parse(raw); } catch { fail('X_ACTION_SESSION_INVALID'); }
    if (state?.version !== 1 || !validHandle(state.handle) || !ownerUrlIsValid(state.ownerUrl)
      || !exactOrigins(state.session?.allowedOrigins) || !exactOrigins(state.session?.cookieOrigins)) {
      fail('X_ACTION_SESSION_INVALID');
    }
    let session;
    let transaction, primaryError;
    try {
      // Business API headers must never remain on the next /home bootstrap.
      if (state.session.headersByOrigin?.[WEB_ORIGIN]) {
        for (const name of ['authorization', 'x-csrf-token', 'x-client-transaction-id']) delete state.session.headersByOrigin[WEB_ORIGIN][name];
      }
      const jar = CookieJar.deserializeSync(state.session.cookieJar);
      const cookies = jar.getCookiesSync(`${API_ORIGIN}/`);
      const authToken = cookies.find(cookie => cookie.key === 'auth_token')?.value;
      const csrfToken = cookies.find(cookie => cookie.key === 'ct0')?.value;
      if (!authToken || !csrfToken) fail('X_REAUTH_REQUIRED');
      const headers = apiHeadersFrom(state);
      headers['x-csrf-token'] = csrfToken;
      session = ScopedSession.fromJSON(state.session, { fetchImpl, timeoutMs: SOCIAL_REQUEST_TIMEOUTS.read });
      transaction = await createHttpXTransaction(session, { fetchImpl, expectedOwner: state.handle });
      let owner = transaction.ownerProof;
      if (!owner && transaction.ownerIncomplete) owner = cachedXOwner(state.handle,authToken);
      if (!owner && transaction.ownerIncomplete) {
        const ownerRequest = await request(session, 'GET', '/1.1/account/settings.json', state.ownerUrl, undefined, transaction, { ScopedSession, CookieJar, fetchImpl });
        session = ownerRequest.session;
        // The settings endpoint is rate limited per account; a proof for this same auth token (hash) stays valid.
        const staleProof = ownerRequest.response.status===429 ? cachedXOwner(state.handle,authToken,Date.now(),{maxAgeMs:6*3600000}) : null;
        if(staleProof) owner = { ...staleProof, receipt: { ...staleProof.receipt, ownerVerificationRateLimitedFallback: true } };
        else {
        if(ownerRequest.response.status!==200 || !ownerRequest.response.headers['content-type']?.includes('json')) fail('X_OWNER_VERIFY_FAILED',safeReceipt('owner_verify',ownerRequest.response));
        let value;try{value=JSON.parse(ownerRequest.response.raw);}catch{fail('X_OWNER_VERIFY_FAILED');}
        if(value.errors?.length || value.screen_name?.toLowerCase()!==state.handle.toLowerCase())fail('X_OWNER_MISMATCH');
        owner = { screen_name: value.screen_name, receipt: { ownerVerified: true, ownerVerificationMethod: 'account_settings' } };
        }
      }
      if (!owner) fail('X_OWNER_MISMATCH');
      if (!owner.receipt.ownerVerificationCached) rememberXOwner(state.handle,authToken,owner);
      const ownerVerificationMethod = owner.receipt.ownerVerificationMethod;
      if (owner?.screen_name?.toLowerCase() !== state.handle.toLowerCase()) fail('X_OWNER_MISMATCH');
      await persistState(store, state, session);

      const bootstrap = await loadCurrentXClient(session, { fetchImpl, home: transaction.home });
      await persistState(store, state, session);
      const context = {
        ownerHandle: state.handle,
        ownerVerificationMethod,
        ownerVerificationCached: owner.receipt.ownerVerificationCached === true,
        apiTransitionEnabled: bootstrap.apiTransitionEnabled,
        searchContract: bootstrap.searchContract || null,
        followersContract: bootstrap.followersContract || null,
        timelineContract: bootstrap.timelineContract || null,
        ownerRepliesContract: bootstrap.ownerRepliesContract || null,
        timelineWithVoice: bootstrap.timelineWithVoice,
        timelineWithCommunity: bootstrap.timelineWithCommunity,
        ownerFingerprint: createHash('sha256').update(state.handle.toLowerCase()).digest('hex').slice(0, 16),
        request: async (method, route, url, body) => {
          const send=async()=>{const result=await request(session, method, route, url, body, transaction, { ScopedSession, CookieJar, fetchImpl });session=result.session;return result;};
          const operation=route.split('/').pop();
          let completed;
          if(method==='GET'&&route.includes('/graphql/')){
            for(let attempt=0;;attempt++){
              await withReadBudget(async()=>{completed=await send();return completed.response;},{owner:state.handle,operation});
              if(attempt>=GRAPHQL_READ_404_RETRIES||!transientGraphqlRead404(completed.response))break;
              await sleep(1500*(attempt+1));
            }
          }
          else completed=await send();
          session = completed.session;
          if([401,403].includes(completed.response.status)) forgetXOwner(state.handle,authToken);
          try { await persistState(store, state, session); }
          catch (error) {
            if (method === 'POST') fail('X_ACTION_OUTCOME_UNKNOWN', {
              operation: route.split('/').pop().replace('.json', ''), method, writeSent: true,
              httpStatus: completed.response.status, outcome: 'unknown', browserUsed: false, executionMode: 'pure_http',
              store: safeBotFailure(error).localStore || null,
            });
            annotateBotError(error, { method, operation, path: '/{api}/{operation}', stage: 'cookie_persistence',
              httpStatus: completed.response.status, writeSent: false });
            error.receipt = { ...error.receipt, operation, httpStatus: completed.response.status, writeSent: false };
            throw error;
          }
          return completed.response;
        },
        lookupUser: async target => lookupUser(context, target, bootstrap),
        async persist() { await persistState(store, state, session); },
      };
      return await work(context);
    } catch (error) {
      primaryError = error; throw error;
    } finally {
      if (session && state) {
        await finishXSessionPersistence(() => persistState(store, state, session), primaryError);
      }
    }
  }, { root: path.join(store.directory, 'locks'), key: X_STATE, timeoutMs:SOCIAL_REQUEST_TIMEOUTS.sessionLock });
}

function safeReceipt(operation, response) {
  let errorCodes = [];
  try { errorCodes = (JSON.parse(response.raw)?.errors || []).map(e => e.code).filter(Number.isInteger); } catch {}
  return {
    operation,
    httpStatus: response.status,
    mime: response.headers['content-type'] || null,
    bytes: Buffer.byteLength(response.raw || ''),
    errorCodes,
    rateLimitReset: /^\d+$/.test(response.headers['x-rate-limit-reset'] || '') ? Number(response.headers['x-rate-limit-reset']) : null,
    retryAfterSeconds: /^\d+$/.test(response.headers['retry-after'] || '') ? Number(response.headers['retry-after']) : null,
    browserUsed: false,
    executionMode: 'pure_http',
  };
}

export function sessionPersistenceChanged(before, after) {
  const comparable = value => JSON.stringify(value, (key, item) => key === 'lastAccessed' ? undefined : item);
  return comparable(before) !== comparable(after);
}
export async function finishXSessionPersistence(persist, primaryError) {
  try { await persist(); }
  catch (error) {
    if (!primaryError) throw error;
    // Preserve the rejection or uncertain write if cleanup also fails.
    primaryError.cleanupDiagnostic = { stage: 'session_cleanup' };
    primaryError.cleanupStore = safeBotFailure(error).localStore || null;
  }
}
export async function persistState(store, state, session) {
  if (!session) return;
  const snapshot = session.toJSON();
  const apiHeaders = snapshot.headersByOrigin?.[API_ORIGIN];
  if (apiHeaders) delete apiHeaders['x-client-transaction-id'];
  // Cookie access timestamps change on every read; they are not credential rotations.
  if (!sessionPersistenceChanged(state.session, snapshot)) return;
  try { store.write(X_STATE, JSON.stringify({ ...state, session: snapshot })); }
  catch (error) { fail('X_ACTION_SESSION_STORE_FAILED', { store: error?.detail ?? null }); }
  state.session = snapshot;
}

export function timelineVariablesValid(variables) {
  return variables&&typeof variables==='object'&&!Array.isArray(variables)
    &&validId(variables.userId)&&variables.count===20&&variables.includePromotedContent===true
    &&typeof variables.withQuickPromoteEligibilityTweetFields==='boolean'&&typeof variables.withVoice==='boolean'
    &&Object.keys(variables).every(key=>['userId','count','includePromotedContent','withQuickPromoteEligibilityTweetFields','withVoice','cursor'].includes(key))
    &&(variables.cursor===undefined||typeof variables.cursor==='string'&&variables.cursor.length<=4096);
}
export function timelineTogglesValid(toggles) {
  return toggles&&typeof toggles==='object'&&!Array.isArray(toggles)
    &&Object.keys(toggles).sort().join() === 'withArticlePlainText,withPayments'
    &&toggles.withPayments===false&&toggles.withArticlePlainText===false;
}
export function ownerRepliesVariablesValid(variables) {
  return variables&&typeof variables==='object'&&!Array.isArray(variables)
    &&validId(variables.userId)&&variables.count===20&&variables.includePromotedContent===true
    &&typeof variables.withCommunity==='boolean'&&variables.withQuickPromoteEligibilityTweetFields===true
    &&typeof variables.withVoice==='boolean'
    &&Object.keys(variables).every(key=>['userId','count','cursor','includePromotedContent','withCommunity','withQuickPromoteEligibilityTweetFields','withVoice'].includes(key))
    &&(variables.cursor===undefined||typeof variables.cursor==='string'&&variables.cursor.length<=4096);
}
async function request(session, method, route, rawUrl, body, transaction, { ScopedSession, CookieJar, fetchImpl }) {
  const isTweetRead = route === '/i/api/graphql/blErEeZkos5TDrWmrCp7cw/TweetDetail';
  const isSearchRead = /^\/(?:i\/api\/)?graphql\/[A-Za-z0-9_-]+\/SearchTimeline$/.test(route);
  const isProfileRead = /^\/(?:i\/api\/)?graphql\/[A-Za-z0-9_-]+\/UserByScreenName$/.test(route);
  const isOwnerRepliesRead=/^\/(?:i\/api\/)?graphql\/[A-Za-z0-9_-]+\/UserTweetsAndReplies$/.test(route);
  const isTimelineRead = /^\/(?:i\/api\/)?graphql\/[A-Za-z0-9_-]+\/(?:UserOriginalsTimeline|UserTweets)$/.test(route)||isOwnerRepliesRead;
  const isWebGraphqlRead = route.startsWith('/i/api/graphql/') && (isSearchRead || isProfileRead || isTimelineRead);
  const isReaction = ['/i/api/graphql/lI07N6Otwv1PhnEgXILM7A/FavoriteTweet', '/i/api/graphql/mbRO74GrOvSfRcJnlMapnQ/CreateRetweet', '/i/api/graphql/VIHsNu89pK-kW35JpHq7Xw/PinTweet'].includes(route);
  const isEngagementRead = ['/i/api/graphql/UBCF0EF800cPqREAeu1uuA/Retweeters', '/i/api/graphql/HaFAhly6sDpoeqGEbFb2Ig/Favoriters'].includes(route);
  const isConnectionsRead = /^\/i\/api\/graphql\/[A-Za-z0-9_-]+\/Followers$/.test(route) || isTweetRead || isEngagementRead || isWebGraphqlRead;
  const isFriendshipMutation = /^\/1\.1\/friendships\/(?:create|destroy|cancel)\.json$/.test(route);
  const isReadRoute = route === '/1.1/account/settings.json'
    || isProfileRead || isConnectionsRead || isSearchRead || isTimelineRead;
  if (isFriendshipMutation || isReaction ? method !== 'POST' : !isReadRoute || method !== 'GET') {
    fail('X_ACTION_REQUEST_SCOPE');
  }
  let url;
  try { url = new URL(rawUrl); } catch { fail('X_ACTION_REQUEST_SCOPE'); }
  if (url.origin !== (isConnectionsRead || isReaction ? WEB_ORIGIN : API_ORIGIN) || url.pathname !== route || url.hash || url.username || url.password
    || route !== '/1.1/account/settings.json' && !route.startsWith('/graphql/') && !isConnectionsRead && url.search
    || route === '/1.1/account/settings.json' && !ownerUrlIsValid(url.href)) {
    fail('X_ACTION_REQUEST_SCOPE');
  }
  if (route.startsWith('/graphql/') || isConnectionsRead) {
    const entries = [...url.searchParams];
    let variables; let features;
    try {
      variables = JSON.parse(url.searchParams.get('variables'));
      features = JSON.parse(url.searchParams.get('features'));
    } catch { fail('X_ACTION_REQUEST_SCOPE'); }
    const variablesValid = variables && typeof variables === 'object' && !Array.isArray(variables)
      && (isSearchRead ? typeof variables.rawQuery === 'string' && variables.rawQuery.trim().length>0 && variables.rawQuery.length<=300
          && variables.count===20 && ['Latest','Top','People'].includes(variables.product) && variables.querySource==='typed_query'
          && typeof variables.withGrokTranslatedBio==='boolean' && typeof variables.withQuickPromoteEligibilityTweetFields==='boolean'
          && Object.keys(variables).every(key=>['rawQuery','count','cursor','querySource','product','withGrokTranslatedBio','withQuickPromoteEligibilityTweetFields'].includes(key))
          && (variables.cursor===undefined || typeof variables.cursor==='string' && variables.cursor.length<=4096)
        : isTweetRead ? validId(variables.focalTweetId) && Object.keys(variables).every(key => ['focalTweetId', 'with_rux_injections', 'rankingMode', 'includePromotedContent', 'withCommunity', 'withQuickPromoteEligibilityTweetFields', 'withBirdwatchNotes', 'withVoice'].includes(key))
        : isEngagementRead ? validId(variables.tweetId) && variables.count === 20 && variables.enableRanking === true && variables.includePromotedContent === true
          && Object.keys(variables).every(key => ['tweetId', 'count', 'enableRanking', 'includePromotedContent', 'cursor'].includes(key))
          && (variables.cursor === undefined || typeof variables.cursor === 'string' && variables.cursor.length <= 4096)
        : isOwnerRepliesRead ? ownerRepliesVariablesValid(variables)
        : isTimelineRead ? timelineVariablesValid(variables)
        : isConnectionsRead && !isProfileRead
        ? Object.keys(variables).every(key => ['userId', 'count', 'includePromotedContent', 'withGrokTranslatedBio', 'cursor'].includes(key))
          && validId(variables.userId) && variables.count === 20 && variables.includePromotedContent === false
          && typeof variables.withGrokTranslatedBio === 'boolean'
          && (variables.cursor === undefined || typeof variables.cursor === 'string' && variables.cursor.length <= 4096)
        : Object.keys(variables).every(key => ['screen_name', 'withGrokTranslatedBio'].includes(key))
          && validHandle(variables.screen_name) && typeof variables.withGrokTranslatedBio === 'boolean');
    const featuresValid = features && typeof features === 'object' && !Array.isArray(features)
      && Object.values(features).every(value => typeof value === 'boolean');
    let togglesValid = true;
    const timelineToggles=isTimelineRead&&(route.endsWith('/UserOriginalsTimeline')||isOwnerRepliesRead);
    if(timelineToggles){try{togglesValid=timelineTogglesValid(JSON.parse(url.searchParams.get('fieldToggles')));}catch{togglesValid=false;}}
    if (isTweetRead) { try { const toggles = JSON.parse(url.searchParams.get('fieldToggles')); togglesValid = toggles && Object.values(toggles).every(v => typeof v === 'boolean'); } catch { togglesValid = false; } }
    if (entries.length !== (isTweetRead || timelineToggles ? 3 : 2) || !togglesValid || url.searchParams.getAll('variables').length !== 1 || url.searchParams.getAll('features').length !== 1
      || !variablesValid || !featuresValid) fail('X_ACTION_REQUEST_SCOPE');
  }
  if (isReaction) {
    let payload; try { payload = JSON.parse(body); } catch { fail('X_ACTION_REQUEST_INVALID'); }
    if (typeof body !== 'string' || Object.keys(payload).sort().join() !== 'queryId,variables' || payload.queryId !== route.split('/')[4]
      || Object.keys(payload.variables || {}).join() !== 'tweet_id' || !validId(payload.variables.tweet_id) || url.search) fail('X_ACTION_REQUEST_INVALID');
  }
  if (method === 'GET' && body !== undefined || method === 'POST' && !isReaction && !(body instanceof URLSearchParams)
    || method === 'POST' && !isReaction && !route.startsWith('/1.1/friendships/')) {
    fail('X_ACTION_REQUEST_INVALID');
  }
  const snapshot = session.toJSON();
  const originalWebHeaders = snapshot.headersByOrigin[WEB_ORIGIN] ? { ...snapshot.headersByOrigin[WEB_ORIGIN] } : null;
  const apiHeaders = snapshot.headersByOrigin?.[API_ORIGIN];
  if (!apiHeaders) fail('X_ACTION_SESSION_INVALID');
  const jar = CookieJar.deserializeSync(snapshot.cookieJar);
  const csrf = jar.getCookiesSync(`${API_ORIGIN}/`).find(cookie => cookie.key === 'ct0')?.value;
  if (!csrf) fail('X_REAUTH_REQUIRED');
  apiHeaders['x-csrf-token'] = csrf;
  try { apiHeaders['x-client-transaction-id'] = await transaction.generate(method, route); }
  catch { fail('X_TRANSACTION_REQUIRED', { operation: route.split('/').pop(), writeSent: false }); }
  if (isConnectionsRead || isReaction) snapshot.headersByOrigin[WEB_ORIGIN] = { ...apiHeaders, referer: WEB_ORIGIN + '/' };
  const requestSession = ScopedSession.fromJSON(snapshot, { fetchImpl,
    timeoutMs: method === 'POST' ? SOCIAL_REQUEST_TIMEOUTS.write : SOCIAL_REQUEST_TIMEOUTS.read });
  const init = body === undefined ? { method } : {
    method,
    body,
    headers: { 'content-type': isReaction ? 'application/json' : 'application/x-www-form-urlencoded' },
  };
  return traceBotRequest({ method, path: isWebGraphqlRead || isTweetRead || isConnectionsRead || isReaction ? '/i/api/graphql/{contract}/{operation}' : '/1.1/{operation}',
    operation: route.split('/').pop(), timeoutMs: method === 'POST' ? SOCIAL_REQUEST_TIMEOUTS.write : SOCIAL_REQUEST_TIMEOUTS.read,
    writeSent: method === 'POST' }, async trace => {
  try {
    const response = await requestSession.request(url.href, init);
    trace.stage('decode', response);
    if (isConnectionsRead || isReaction) {
      const updated = requestSession.toJSON();
      if (originalWebHeaders) updated.headersByOrigin[WEB_ORIGIN] = originalWebHeaders;
      else delete updated.headersByOrigin[WEB_ORIGIN];
      return { response, session: ScopedSession.fromJSON(updated, { fetchImpl }) };
    }
    return { response, session: requestSession };
  } catch (error) {
    const code = error?.code;
    if (method === 'POST') {
      const receipt = { operation: route, method, writeSent: true, browserUsed: false, executionMode: 'pure_http', outcome: 'unknown' };
      fail(code === 'SCOPED_SESSION_WRITE_REDIRECT_BLOCKED' ? 'X_ACTION_REDIRECT_BLOCKED' : 'X_ACTION_OUTCOME_UNKNOWN', receipt);
    }
    fail(code === 'SCOPED_SESSION_TIMEOUT' ? 'X_READ_TIMEOUT' : 'X_READ_FAILED', { operation: route, causeCode: /^[A-Z0-9_]+$/.test(code || '') ? code : null });
  }
  });
}

async function lookup(context, targetHandle) {
  return context.lookupUser(targetHandle);
}

// Owner-verified scoped HTTP context; no credentials or raw session leave the callback.
export const withXReadContext = (work, options) => withVerifiedSession(work, options);
export async function inspectXOwner({withContext,...options}={}){
  return (withContext||((work)=>withVerifiedSession(work,options)))(async context=>{
    const user=await context.lookupUser(context.ownerHandle);
    return {owner:context.ownerHandle,userId:user.userId,ownerVerified:true,checkedAt:new Date().toISOString(),writes:0};
  });
}

async function readBoundedText(response, limit = 4 * 1024 * 1024) {
  if (!response.ok) responseStatusError(response.status, 'main_asset');
  const reader = response.body?.getReader();
  if (!reader) fail('X_BOOTSTRAP_CHANGED');
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      fail('X_MAIN_ASSET_LIMIT');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

// Parsed main.js contracts per (asset, feature switches). The asset name is content-hashed,
// so a new X deploy changes the key; this only saves re-downloading the same multi-MB bundle.
const mainContractCache = new Map();
export function xHomeReusable(home) {
  return home?.status === 200 && home.headers?.['content-type']?.includes('html') === true && typeof home.raw === 'string';
}

async function loadCurrentXClient(session, { fetchImpl, home: transactionHome } = {}) {
  let home = xHomeReusable(transactionHome) ? transactionHome : null;
  if (!home) {
    try { home = await session.request('https://x.com/home'); }
    catch { fail('X_BOOTSTRAP_UNAVAILABLE'); }
  }
  const stateMatch = home.raw.match(/(?:window\.)?__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;?\s*(?:window\.|<\/script>)/);
  let state;
  try { state = JSON.parse(stateMatch?.[1]); } catch { fail('X_BOOTSTRAP_CHANGED'); }
  const asset = home.raw.match(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/main\.[A-Za-z0-9]+\.js/)?.[0];
  if (!asset || new URL(asset).origin !== 'https://abs.twimg.com') fail('X_MAIN_ASSET_MISSING');
  const featureConfig = { ...state.featureSwitch?.defaultConfig, ...state.featureSwitch?.user?.config };
  const cacheKey = `${asset}\n${createHash('sha256').update(JSON.stringify(featureConfig)).digest('hex')}`;
  const cachedContracts = mainContractCache.get(cacheKey);
  let operations = cachedContracts && structuredClone(cachedContracts.operations), sourceHash = cachedContracts?.sourceHash;
  if (!operations) {
    let assetResponse;
    try { assetResponse = await fetchImpl(asset, { redirect: 'error', signal: AbortSignal.timeout(SOCIAL_REQUEST_TIMEOUTS.publicAsset) }); }
    catch { fail('X_MAIN_ASSET_UNAVAILABLE'); }
    if (assetResponse.headers.get('content-type')?.includes('javascript') !== true) fail('X_MAIN_ASSET_INVALID');
    let source;
    try { source = await readBoundedText(assetResponse); }
    catch (error) {
      if (error instanceof XSocialActionError) throw error;
      fail('X_MAIN_ASSET_UNAVAILABLE');
    }
    try { operations = contractsFromSource(source, featureConfig); }
    catch { fail('X_MAIN_CONTRACT_CHANGED'); }
    sourceHash = createHash('sha256').update(source).digest('hex');
    if (!process.env.NODE_TEST_CONTEXT) {
      if (mainContractCache.size >= 8) mainContractCache.clear();
      mainContractCache.set(cacheKey, { operations, sourceHash });
    }
  }
  const operation = operations.UserByScreenName;
  if (!operation || !/^[-A-Za-z0-9_]{1,128}$/.test(operation.queryId) || operation.missing.length) {
    fail('X_MAIN_CONTRACT_INCOMPLETE', { operation: 'UserByScreenName', missing: operation?.missing || [] });
  }
  const grokDefault = state.featureSwitch?.defaultConfig?.responsive_web_grok_bio_auto_translation_is_enabled?.value;
  if (typeof grokDefault !== 'boolean') fail('X_FEATURE_DEFAULT_MISSING');
  return {
    asset: new URL(asset).pathname.split('/').pop(),
    sourceHash,
    contract: operation,
    searchContract: operations.SearchTimeline || null,
    followersContract: operations.Followers || null,
    timelineContract: operations.UserOriginalsTimeline
      ? {...operations.UserOriginalsTimeline,operation:'UserOriginalsTimeline'}
      : operations.UserTweets ? {...operations.UserTweets,operation:'UserTweets'} : null,
    ownerRepliesContract:operations.UserTweetsAndReplies
      ? {...operations.UserTweetsAndReplies,operation:'UserTweetsAndReplies'}:null,
    timelineWithVoice: state.featureSwitch?.defaultConfig?.voice_consumption_enabled?.value === true,
    timelineWithCommunity:state.featureSwitch?.defaultConfig?.c9s_enabled?.value===true,
    apiTransitionEnabled: (state.featureSwitch?.user?.config?.responsive_web_api_transition_enabled ?? state.featureSwitch?.defaultConfig?.responsive_web_api_transition_enabled)?.value === true,
    withGrokTranslatedBio: grokDefault,
  };
}

async function lookupUser(context, target, bootstrap) {
  const prefix = bootstrap.apiTransitionEnabled ? '/i/api' : '';
  const url = new URL(`${prefix}/graphql/${bootstrap.contract.queryId}/UserByScreenName`, bootstrap.apiTransitionEnabled ? WEB_ORIGIN : API_ORIGIN);
  url.searchParams.set('variables', JSON.stringify({ screen_name: target, withGrokTranslatedBio: bootstrap.withGrokTranslatedBio }));
  url.searchParams.set('features', JSON.stringify(bootstrap.contract.features));
  const response = await context.request('GET', url.pathname, url.href);
  if (response.status !== 200) responseStatusError(response.status, 'UserByScreenName');
  if (!response.headers['content-type']?.includes('json')) fail('X_PROFILE_RESPONSE_INVALID', safeReceipt('UserByScreenName', response));
  const profile = userFromGraphQL(response.raw, target);
  return {
    ...profile,
    receipt: { ...safeReceipt('UserByScreenName', response), asset: bootstrap.asset, assetSha256: bootstrap.sourceHash },
  };
}

function actionRoute(action, relation) {
  if (action === 'follow') return '/1.1/friendships/create.json';
  if (relation.followRequestSent && !relation.following) return '/1.1/friendships/cancel.json';
  return '/1.1/friendships/destroy.json';
}

function followForm(userId) {
  return new URLSearchParams({ ...FEATURE_FIELDS, user_id: userId });
}

function cancelForm(userId) { return new URLSearchParams({ user_id: userId }); }

function requestPlan(operation, current) {
  const route = actionRoute(operation, current.relation);
  const bodyFields = route.endsWith('/cancel.json') ? ['user_id'] : [...Object.keys(FEATURE_FIELDS), 'user_id'];
  return {
    method: 'POST',
    path: route,
    operation: route.slice('/1.1/'.length).replace('.json', ''),
    bodyFields,
  };
}

function safeActionView(input, current, route, context) {
  const plan = requestPlan(input.operation, current);
  const request = {
    ...plan,
    operation: route?.startsWith('/1.1/') ? route.slice('/1.1/'.length).replace('.json', '') : plan.operation,
  };
  const transactionId = {
    source: 'authenticated_x_home_html_and_first_party_ondemand_js',
    library: 'x-client-transaction-id@0.3.1',
    browserRequired: false,
  };
  return {
    service: 'x',
    operation: input.operation,
    requestOperation: request.operation,
    target: current.handle,
    normalizedTarget: current.userId,
    ownerFingerprint: context.ownerFingerprint,
    ownerVerified: true,
    currentState: { following: current.relation.following, outgoingRequest: current.relation.followRequestSent },
    request,
    transactionId,
    auth: {
      ownerVerified: true,
      provider: 'windows_dpapi_current_user',
      ownerFingerprint: context.ownerFingerprint,
      credentialStore: X_STATE,
      credentialProtection: 'Windows DPAPI CurrentUser',
      credentialOrigins: API_ORIGINS,
      browserUsed: false,
      transactionId,
    },
    captured: false,
    client_exists: true,
    remnant_free: true,
    credential_propagated: true,
    credential_propagated_for_write: false,
    executionMode: 'pure_http',
    browserUsed: false,
  };
}

function assertNotOwner(context, current) {
  if (current.handle.toLowerCase() === context.ownerHandle.toLowerCase()) fail('X_SELF_ACTION_BLOCKED');
}

export async function inspectXAction(input, options = {}) {
  const normalized = normalizeInput(input);
  return withVerifiedSession(async context => {
    const current = await lookup(context, normalized.target);
    assertNotOwner(context, current);
    const currentActionState = expectedState(normalized.operation, current.relation);
    const noOp = currentActionState !== 'ready' && currentActionState !== 'ready_to_cancel';
    return {
      ...safeActionView(normalized, current, actionRoute(normalized.operation, current.relation), context),
      ready: true,
      noOp,
      noOpReason: noOp ? currentActionState : null,
      needs_reconciliation: false,
      ownerVerified: true,
      contractEvidence: 'authenticated_current_main_js',
      mutationCount: 0,
      writeSent: false,
      live_replay: false,
      code: null,
      readReceipt: { ...current.receipt, live_replay: true },
    };
  }, options);
}

export async function prepareXAction(input, options = {}) {
  const inspection = await inspectXAction(input, options);
  return { ...inspection, dryRun: true };
}

export async function executeXAction(input, options = {}) {
  const normalized = normalizeInput(input);
  if (typeof options.beforeWrite !== 'function') fail('X_ACTION_JOURNAL_REQUIRED');
  return withVerifiedSession(async context => {
    const current = await lookup(context, normalized.target);
    assertNotOwner(context, current);
    const currentActionState = expectedState(normalized.operation, current.relation);
    if (currentActionState !== 'ready' && currentActionState !== 'ready_to_cancel') {
      return {
        ...safeActionView(normalized, current, actionRoute(normalized.operation, current.relation), context),
        ready: true,
        noOp: true,
        noOpReason: currentActionState,
        success: true,
        readbackVerified: true,
        needs_reconciliation: false,
        ownerVerified: true,
        mutationCount: 0,
        writeSent: false,
        live_replay: false,
        code: null,
        readReceipt: { ...current.receipt, live_replay: true },
      };
    }

    const route = actionRoute(normalized.operation, current.relation);
    const pathName = route;
    const form = route.endsWith('/cancel.json') ? cancelForm(current.userId) : followForm(current.userId);
    const intent = {
      ...safeActionView(normalized, current, route, context),
      contractEvidence: 'authenticated_current_main_js',
      executionMode: 'pure_http',
      browserUsed: false,
    };
    if (await options.beforeWrite(intent) === false) fail('SOCIAL_JOURNAL_REJECTED');

    let response;
    try { response = await context.request('POST', pathName, new URL(route, API_ORIGIN).href, form); }
    catch (error) {
      const code = error instanceof XSocialActionError ? error.code : 'X_ACTION_OUTCOME_UNKNOWN';
      const writeSent = error?.receipt?.writeSent !== false;
      return {
        ...safeActionView(normalized, current, route, context),
        ready: true,
        success: false,
        readbackVerified: false,
        needs_reconciliation: writeSent,
        mutationCount: writeSent ? 1 : 0,
        writeSent,
        status: writeSent ? 'needs_reconciliation' : 'blocked',
        code,
        outcome: writeSent ? 'unknown' : 'not_sent',
        live_replay: false,
        readReceipt: { ...current.receipt, live_replay: true },
        writeReceipt: error?.receipt || { operation: intent.request.operation, writeSent },
      };
    }
    const postReceipt = safeReceipt(intent.request.operation, response);
    let responseJson;
    try { responseJson = JSON.parse(response.raw); } catch { responseJson = null; }
    if (response.status < 200 || response.status >= 300
      || !response.headers['content-type']?.includes('json')
      || !responseJson || typeof responseJson !== 'object') {
      return {
        ...safeActionView(normalized, current, route, context),
        ready: true,
        success: false,
        readbackVerified: false,
        needs_reconciliation: true,
        mutationCount: 1,
        writeSent: true,
        code: response.status === 401 ? 'X_REAUTH_REQUIRED'
          : response.status === 403 || response.status === 418 ? 'X_ACTION_BLOCKED'
            : response.status === 429 ? 'X_RATE_LIMITED'
              : response.status >= 500 ? 'X_ACTION_OUTCOME_UNKNOWN' : 'X_HTTP_REJECTED',
        outcome: 'unknown',
        live_replay: false,
        readReceipt: { ...current.receipt, live_replay: true },
        writeReceipt: { ...postReceipt, writeSent: true },
      };
    }
    await context.persist();
    let readback;
    try { readback = await lookup(context, normalized.target); }
    catch (error) {
      return {
        ...safeActionView(normalized, current, route, context),
        ready: true,
        success: false,
        readbackVerified: false,
        needs_reconciliation: true,
        mutationCount: 1,
        writeSent: true,
        code: error?.code || 'X_READBACK_FAILED',
        outcome: 'unknown',
        live_replay: false,
        readReceipt: { ...current.receipt, live_replay: true },
        writeReceipt: { ...postReceipt, writeSent: true, readback: 'failed' },
      };
    }
    if (readback.userId !== current.userId) {
      return {
        ...safeActionView(normalized, readback, route, context),
        ready: true,
        success: false,
        readbackVerified: false,
        needs_reconciliation: true,
        mutationCount: 1,
        writeSent: true,
        code: 'X_TARGET_IDENTITY_CHANGED',
        outcome: 'unknown',
        live_replay: false,
        readReceipt: { ...readback.receipt, live_replay: true },
        writeReceipt: { ...postReceipt, writeSent: true, readback: 'target_id_changed' },
      };
    }
    const rel = readback.relation;
    const verified = normalized.operation === 'follow'
      ? rel.following || rel.followRequestSent
      : !rel.following && !rel.followRequestSent;
    if (!verified) {
      return {
        ...safeActionView(normalized, readback, route, context),
        ready: true,
        success: false,
        readbackVerified: false,
        needs_reconciliation: true,
        mutationCount: 1,
        writeSent: true,
        code: 'X_READBACK_STATE_NOT_CONFIRMED',
        outcome: 'unknown',
        live_replay: false,
        readReceipt: { ...readback.receipt, live_replay: true },
        writeReceipt: { ...postReceipt, writeSent: true, readback: 'state_not_confirmed' },
      };
    }
    return {
      ...safeActionView(normalized, readback, route, context),
      ready: true,
      success: true,
      readbackVerified: true,
      needs_reconciliation: false,
      ownerVerified: true,
      mutationCount: 1,
      writeSent: true,
      live_replay: true,
      credential_propagated_for_write: true,
      code: null,
      readReceipt: { ...readback.receipt, live_replay: true },
      writeReceipt: { ...postReceipt, writeSent: true },
    };
  }, options);
}
