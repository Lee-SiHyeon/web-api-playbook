import { createHash } from 'node:crypto';
import { SOCIAL_REQUEST_TIMEOUTS } from './lib/request-timeouts.mjs';
import {
  boundedText,
  metaFail,
  metaRequest,
  openMetaContext,
  parseMetaBootstrap,
  sendMetaQuery,
  rotateMetaCookiesWithRetry,
  withMetaSessionLock,
  forgetMetaOwnerDocument,
} from './lib/meta-bootstrap.mjs';
import {
  buildThreadsDirectRepliesVariables,
  buildThreadsDownwardVariables,
  buildThreadsTargetVariables,
  THREADS_READBACK_CONTRACTS,
} from '../affiliate-api-hub/scripts/sns/readers/threads-readback.mjs';
import {
  metaCookieHeader,
} from '../naver-blog-api/scripts/meta-auth-session.mjs';
import { reserveThreadsRead } from './lib/threads-read-budget.mjs';
import { annotateBotError, traceBotRequest } from './lib/bot-diagnostics.mjs';
import { readThreadsSharedCooldown, hasObservedThreadsGraphqlThrottle, recordThreadsGraphqlCooldown,
  recordThreadsGraphqlSuccess, recordThreadsHttp429Cooldown, isThreadsGraphqlThrottle,
  THREADS_GRAPHQL_THROTTLED, THREADS_GRAPHQL_BACKOFF, THREADS_HTTP_429_THROTTLED,
  THREADS_HTTP_429_PERSIST_FAILED } from './lib/threads-graphql-throttle.mjs';

const ORIGIN = 'https://www.threads.com';
const OWNER = 'lifehack__ailab';
const PROFILE_ROUTE = 'comet.threads.BarcelonaProfileThreadsColumnRoute';
const MAX_RESPONSE_BYTES = 5_000_000;
const MAX_IMAGE_CAROUSEL_CHILDREN = 20;

const FOLLOWERS_QUERY = Object.freeze({
  operation: 'BarcelonaFriendshipsFollowersTabQuery',
  docId: '27993451613683779',
  path: '/graphql/query',
  first: 20,
});

const FEEDBACK_HUB_QUERY = Object.freeze({
  operation: 'BarcelonaFeedbackHubDialogQuery',
  docId: '27639876885686872',
  path: '/api/graphql',
});

const FOLLOWER_FLAGS = Object.freeze({
  __relay_internal__pv__BarcelonaIsInternalUserrelayprovider: false,
  __relay_internal__pv__BarcelonaIsLoggedInrelayprovider: true,
  __relay_internal__pv__BarcelonaIsCrawlerrelayprovider: false,
  __relay_internal__pv__BarcelonaShouldShowFediverseListsrelayprovider: true,
});

const FEEDBACK_FLAGS = Object.freeze({
  __relay_internal__pv__BarcelonaIsLoggedInrelayprovider: true,
  __relay_internal__pv__BarcelonaShouldShowFediverseM075Featuresrelayprovider: true,
  __relay_internal__pv__BarcelonaShouldShowFediverseListsrelayprovider: true,
  __relay_internal__pv__BarcelonaCanSeeSponsoredContentrelayprovider: false,
  __relay_internal__pv__BarcelonaMessagesHasLiveChatMessagingrelayprovider: false,
  __relay_internal__pv__BarcelonaHasEventBadgerelayprovider: false,
  __relay_internal__pv__BarcelonaHasWebFaviconsrelayprovider: false,
  __relay_internal__pv__BarcelonaIsCrawlerrelayprovider: false,
  __relay_internal__pv__BarcelonaHasCommunityTopContributorsrelayprovider: false,
});

const PROFILE_TIMELINE_MODULES = Object.freeze({
  operation: 'BarcelonaProfileThreadsTabDirectQuery.threads.graphql',
  operationId: 'BarcelonaProfileThreadsTabDirectQuery_threadsRelayOperation',
  pagination: 'BarcelonaProfileThreadsTabPaginationDirectFragment.threads.graphql',
  component: 'BarcelonaProfileThreadsTab.react',
  entrypoint: 'BarcelonaProfileThreadsTab.entrypoint',
});
const PROFILE_TIMELINE_MAX_LIMIT = 100;
const PROFILE_TIMELINE_MAX_PAGES = 25;
const PROFILE_TIMELINE_MAX_SCRIPT_COUNT = 35;
const PROFILE_TIMELINE_MAX_SCRIPT_BYTES = 15_000_000;
const PROFILE_TIMELINE_MAX_SCRIPT_TOTAL_BYTES = 60_000_000;
const profileTimelineContractCache = new Map();

const fail = metaFail;
const safeId = value => /^\d{1,25}$/.test(String(value ?? '')) ? String(value) : null;
const safeHandle = value => typeof value === 'string' && /^[A-Za-z0-9_.]{1,30}$/.test(value) ? value : null;
const sha256 = value => createHash('sha256').update(value).digest('hex');

function verifyContext(context, owner = OWNER) {
  if (context?.service !== 'threads' || context.handle?.toLowerCase() !== owner.toLowerCase()
    || context.bundle?.service !== 'threads' || context.bundle.owner?.toLowerCase() !== owner.toLowerCase()
    || !safeId(context.bundle.ownerId) || context.bundle.origin !== ORIGIN) {
    fail('THREADS_SOCIAL_OWNER_UNVERIFIED');
  }
  return context;
}

export function buildThreadsFollowersVariables(ownerId, after = null) {
  const id = safeId(ownerId);
  if (!id) fail('THREADS_SOCIAL_OWNER_ID_INVALID');
  if (after !== null && (typeof after !== 'string' || !after || after.length > 8192)) fail('THREADS_SOCIAL_FOLLOWERS_CURSOR_INVALID');
  return { ...(after ? { after } : {}), first: FOLLOWERS_QUERY.first, userID: id, ...FOLLOWER_FLAGS };
}

export function buildThreadsFeedbackHubVariables(postId) {
  const id = safeId(postId);
  if (!id) fail('THREADS_SOCIAL_POST_ID_INVALID');
  return { post_id: id, sort_type: 'default', ...FEEDBACK_FLAGS };
}

function buildRequest(context, descriptor, variables) {
  verifyContext(context);
  const request = metaRequest(context, descriptor.operation, descriptor.docId, variables);
  const url = new URL(request.url);
  if (url.origin !== ORIGIN || url.pathname !== '/api/graphql' || url.search || url.hash
    || request.method !== 'POST'
    || request.body?.get('fb_api_req_friendly_name') !== descriptor.operation
    || request.body?.get('doc_id') !== descriptor.docId) {
    fail('THREADS_SOCIAL_REQUEST_SCOPE');
  }
  request.url = ORIGIN + descriptor.path;
  request.headers.cookie = metaCookieHeader(context.bundle, request.url);
  if (new URL(request.headers.referer).origin !== ORIGIN) fail('THREADS_SOCIAL_REFERER_SCOPE');
  return request;
}

async function assertThreadsSocialReadCooldown(context, metadata) {
  const cooldown = await readThreadsSharedCooldown({ ...(context?.throttleRoot ? { root: context.throttleRoot } : {}) });
  if (cooldown) {
    const code = isThreadsGraphqlThrottle(cooldown) ? THREADS_GRAPHQL_THROTTLED : cooldown.code || THREADS_HTTP_429_THROTTLED;
    throw annotateBotError(Object.assign(new Error(code), {
      ...cooldown, code, cooldownPersisted: cooldown.cooldownPersisted !== false, dispatchStarted: false, writeSent: false,
    }), { ...metadata, stage: 'cooldown_gate', httpStatus: cooldown.httpStatus, writeSent: false, elapsedMs: 0 });
  }
}

async function loadGuardedContext(handle, context, contextLoader) {
  if (context) return context;
  return withMetaSessionLock('threads', async () => {
    await assertThreadsSocialReadCooldown(null, { method: 'GET', path: '/{profile}', operation: 'protected_profile_bootstrap' });
    return contextLoader('threads', handle);
  });
}

async function sendQuery(context, request, expectedOperation, expectedPath) {
  verifyContext(context);
  const url = new URL(request.url);
  if (url.origin !== ORIGIN || url.pathname !== expectedPath || url.search || url.hash
    || request.method !== 'POST' || request.headers.origin !== ORIGIN
    || new URL(request.headers.referer).origin !== ORIGIN
    || request.body?.get('fb_api_req_friendly_name') !== expectedOperation) {
    fail('THREADS_SOCIAL_REQUEST_SCOPE');
  }

  return withMetaSessionLock('threads', () => sendLockedThreadsSocialQuery(context, request, expectedOperation, expectedPath));
}

async function sendLockedThreadsSocialQuery(context, request, expectedOperation, expectedPath) {
  const metadata = { method: 'POST', path: expectedPath, operation: expectedOperation,
    timeoutMs: SOCIAL_REQUEST_TIMEOUTS.read, writeSent: false };
  await assertThreadsSocialReadCooldown(context, metadata);
  await reserveThreadsRead({ operation: expectedOperation, root: context.readBudgetRoot, limits: context.readBudgetLimits });
  const requestStartedAt = Date.now();
  return traceBotRequest(metadata, async trace => {
    const { url: requestUrl, ...init } = request;
    const response = await context.fetchImpl(requestUrl, init);
    trace.stage('cookie_persistence', response);
    let observed429 = null;
    if (response.status === 429) {
      try {
        observed429 = await recordThreadsHttp429Cooldown({ response, operation: expectedOperation,
          ...(context.throttleRoot ? { root: context.throttleRoot } : {}) });
      } catch (error) {
        observed429 = { httpStatus: 429, code: THREADS_HTTP_429_PERSIST_FAILED,
          rateLimited: true, cooldownReason: 'http_429_rate_limit', cooldownPersisted: false,
          retryAt: Number.isSafeInteger(error?.retryAt) ? error.retryAt : Date.now() + 15 * 60_000,
          retryAfterSeconds: Number.isSafeInteger(error?.retryAfterSeconds) ? error.retryAfterSeconds : 15 * 60,
          deadlineSource: error?.deadlineSource || 'local_fallback_15_minutes',
          fallbackMilliseconds: error?.fallbackMilliseconds ?? 15 * 60_000 };
      }
    }
    await rotateMetaCookiesWithRetry(context.bundle, response);
    const mime = response.headers.get('content-type') || '';
    if (response.status !== 200) {
      const code = 'THREADS_SOCIAL_HTTP_' + response.status;
      const error = Object.assign(new Error(code), { code, httpStatus: response.status });
      if (observed429) Object.assign(error, observed429, { code, cooldownCode: observed429.code, httpStatus: 429,
        dispatchStarted: true, writeSent: false });
      else {
        const retryAfter = response.headers.get('retry-after');
        if (retryAfter) {
          const numeric = Number(retryAfter);
          const seconds = Number.isFinite(numeric) && numeric >= 0 ? Math.ceil(numeric)
            : Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000);
          if (Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 86_400) error.retryAfterSeconds = seconds;
        }
        const rawReset = response.headers.get('x-ratelimit-reset') || response.headers.get('x-rate-limit-reset');
        const reset = rawReset == null ? NaN : Number(rawReset);
        if (Number.isSafeInteger(reset) && reset > 0 && reset <= 99_999_999_999_999) error.rateLimitReset = reset;
      }
      throw error;
    }
    if (!/^(?:application\/json|text\/javascript)(?:;|$)/i.test(mime)) fail('THREADS_SOCIAL_MIME');
    trace.stage('response_body', response);
    const text = await boundedText(response, MAX_RESPONSE_BYTES);
    trace.body(text); trace.stage('decode');
    let payload;
    try { payload = JSON.parse(text.replace(/^for \(;;\);\s*/, '')); }
    catch { fail('THREADS_SOCIAL_NOT_JSON'); }
    if (payload?.errors?.length || payload?.error) {
      if (/friction|challenge|checkpoint|captcha/i.test(JSON.stringify(payload.errors || payload.error))) {
        forgetMetaOwnerDocument('threads');
        fail('META_INTERACTION_REQUIRED');
      }
      if (hasObservedThreadsGraphqlThrottle(payload)) {
        let cooldown;
        const now = Date.now();
        try { cooldown = await recordThreadsGraphqlCooldown({ response, operation: expectedOperation, now,
          ...(context.throttleRoot ? { root: context.throttleRoot } : {}) }); }
        catch { cooldown = { httpStatus: 200, retryAt: now + THREADS_GRAPHQL_BACKOFF.initialMilliseconds,
          cooldownPersisted: false, fallbackMilliseconds: THREADS_GRAPHQL_BACKOFF.initialMilliseconds, deadlineSource: 'local_fallback' }; }
        throw Object.assign(new Error(THREADS_GRAPHQL_THROTTLED), { ...cooldown, code: THREADS_GRAPHQL_THROTTLED,
          rateLimited: true, providerErrorCode: 1675004, cooldownReason: 'graphql_200_rate_limit' });
      }
      forgetMetaOwnerDocument('threads');
      fail('THREADS_SOCIAL_SERVICE_ERROR');
    }
    if (!payload?.data || typeof payload.data !== 'object') fail('THREADS_SOCIAL_DATA_MISSING');
    await recordThreadsGraphqlSuccess({ operation: expectedOperation, requestStartedAt,
      ...(context.throttleRoot ? { root: context.throttleRoot } : {}) });
    return {
      payload,
      receipt: {
        operation: expectedOperation,
        method: 'POST',
        path: expectedPath,
        httpStatus: response.status,
        mime: mime.split(';')[0].toLowerCase(),
        bytes: Buffer.byteLength(text),
        responseSha256: sha256(text),
        checkedAt: new Date().toISOString(),
        executionMode: 'pure_http',
        browserUsed: false,
        credentialProvider: 'windows_dpapi_current_user',
        credentialValuesRecorded: false,
        owner: context.bundle.owner,
        ownerVerified: true,
        captured: true,
        client_exists: true,
        credential_propagated: true,
        remnant_free: true,
        live_replay: true,
      },
    };
  }).catch(error => {
    const httpStatus = error.requestDiagnostic?.httpStatus;
    if (Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) error.httpStatus = httpStatus;
    throw error;
  });
}

export function decodeThreadsFollowers(payload, expectedOwnerId) {
  const ownerId = safeId(expectedOwnerId);
  if (!ownerId) fail('THREADS_SOCIAL_OWNER_ID_INVALID');
  const user = payload?.data?.user;
  const responseOwnerId = safeId(user?.pk ?? user?.id);
  if (!user || responseOwnerId !== ownerId) fail('THREADS_SOCIAL_FOLLOWERS_OWNER_MISMATCH');
  const connection = user.followers;
  const edges = connection?.edges;
  const pageInfo = connection?.page_info;
  if (!Array.isArray(edges) || edges.length > FOLLOWERS_QUERY.first
    || !pageInfo || typeof pageInfo.has_next_page !== 'boolean'
    || !(pageInfo.end_cursor === null || typeof pageInfo.end_cursor === 'string')) {
    fail('THREADS_SOCIAL_FOLLOWERS_SCHEMA');
  }
  if (pageInfo.has_next_page && (!pageInfo.end_cursor || pageInfo.end_cursor.length > 8192)) {
    fail('THREADS_SOCIAL_FOLLOWERS_CURSOR_MISSING');
  }

  const ids = new Set();
  const handles = new Set();
  const followers = edges.map(edge => {
    const node = edge?.node;
    const id = safeId(node?.pk ?? node?.id);
    const username = safeHandle(node?.username);
    const state = node?.friendship_status;
    if (!id || !username || ids.has(id) || handles.has(username.toLowerCase())
      || !state || typeof state.followed_by !== 'boolean'
      || typeof state.following !== 'boolean' || typeof state.outgoing_request !== 'boolean'
      || typeof node.is_verified !== 'boolean'
      || !(node.text_post_app_is_private === null || typeof node.text_post_app_is_private === 'boolean')) {
      fail('THREADS_SOCIAL_FOLLOWERS_ROW_SCHEMA');
    }
    ids.add(id);
    handles.add(username.toLowerCase());
    return {
      id,
      username,
      following: state.following,
      followsOwner: state.followed_by,
      outgoingRequest: state.outgoing_request,
      verified: node.is_verified,
      private: node.text_post_app_is_private,
    };
  });

  return {
    ownerId,
    followers,
    page: {
      requestedFirst: FOLLOWERS_QUERY.first,
      observed: followers.length,
      hasNextPage: pageInfo.has_next_page,
      fullList: !pageInfo.has_next_page,
      cursorFingerprint: pageInfo.end_cursor ? sha256(pageInfo.end_cursor).slice(0, 16) : null,
    },
  };
}

function normalizedPostId(value) {
  const id = String(value ?? '').split('_')[0];
  return safeId(id);
}

function imageOnlyContentType(post, failureCode) {
  if (post?.caption !== null) return null;
  if (post.media_type === 1) return 'image';
  if (post.media_type === 8 && Array.isArray(post.carousel_media)
    && post.carousel_media.length > 0 && post.carousel_media.length <= MAX_IMAGE_CAROUSEL_CHILDREN) {
    for (let index = 0; index < post.carousel_media.length; index++) {
      const child = post.carousel_media[index];
      if (!child || typeof child !== 'object' || Array.isArray(child) || child.media_type !== 1) fail(failureCode);
    }
    return 'image_carousel';
  }
  fail(failureCode);
}

function decodeSelfThreadInfo(value) {
  const id=safeId(String(value?.id??''));
  const position=Number(value?.post_position_in_self_thread);
  const length=Number(value?.self_thread_length);
  return id&&Number.isSafeInteger(position)&&position>=1&&Number.isSafeInteger(length)&&length>=position
    ? {id,position,length} : null;
}

export function decodeThreadsEngagement(payload, expectedPostId) {
  const postId = safeId(expectedPostId);
  if (!postId) fail('THREADS_SOCIAL_POST_ID_INVALID');
  const hub = payload?.data?.feedback_hub;
  const rows = hub?.post_activity;
  if (!hub || !Array.isArray(rows) || rows.length > 1000) fail('THREADS_SOCIAL_ENGAGEMENT_SCHEMA');

  const byType = { like: [], repost: [], quote: [] };
  const unsupportedKinds = new Map();
  for (const row of rows) {
    const kind = row?.extra?.icon_name;
    if (typeof kind !== 'string' || !/^[a-z_]{1,40}$/.test(kind)) fail('THREADS_SOCIAL_ENGAGEMENT_ROW_SCHEMA');
    const associatedPost = row.post?.pk ?? row.post?.id;
    if (associatedPost != null && normalizedPostId(associatedPost) !== postId) {
      fail('THREADS_SOCIAL_ENGAGEMENT_POST_MISMATCH');
    }
    if (!Object.hasOwn(byType, kind)) {
      unsupportedKinds.set(kind, (unsupportedKinds.get(kind) || 0) + 1);
      continue;
    }
    const actor = row.actor;
    const id = safeId(actor?.pk ?? actor?.id);
    const username = safeHandle(actor?.username);
    const friendship = actor?.friendship_status;
    if (!id || !username || friendship != null && (typeof friendship !== 'object'
      || Array.isArray(friendship)
      || ['followed_by', 'following', 'outgoing_request'].some(key => typeof friendship[key] !== 'boolean'))
      || row.timestamp != null && !Number.isFinite(row.timestamp)) {
      fail('THREADS_SOCIAL_ENGAGEMENT_ACTOR_SCHEMA');
    }
    byType[kind].push({
      id,
      username,
      ...(typeof actor.is_verified === 'boolean' ? { verified: actor.is_verified } : {}),
      ...(friendship ? {
        followsOwner: friendship.followed_by,
        following: friendship.following,
        outgoingRequest: friendship.outgoing_request,
      } : {}),
      ...(Number.isFinite(row.timestamp) ? { timestamp: row.timestamp } : {}),
    });
  }

  return {
    postId,
    activities: byType,
    counts: Object.fromEntries(Object.entries(byType).map(([kind, actors]) => [kind, actors.length])),
    unsupportedKinds: [...unsupportedKinds.entries()].map(([kind, count]) => ({ kind, count })),
    rowCount: rows.length,
    exhaustive: false,
    pagination: 'not_exposed_in_observed_response',
  };
}

export function decodeThreadsPost(payload, { postId, expectedAuthor } = {}) {
  const id = safeId(postId);
  const expected = expectedAuthor == null ? null : safeHandle(expectedAuthor);
  if (!id) fail('THREADS_SOCIAL_POST_ID_INVALID');
  if (expectedAuthor != null && !expected) fail('THREADS_SOCIAL_EXPECTED_AUTHOR_INVALID');
  const media = payload?.data?.media;
  const mediaId = media?.pk ?? media?.id;
  const author = safeHandle(media?.user?.username);
  const text = media?.caption?.text;
  const info = media?.text_post_app_info;
  if (!media || normalizedPostId(mediaId) !== id || !author
    || expected && author.toLowerCase() !== expected.toLowerCase()
    || typeof media.code !== 'string' || !/^[A-Za-z0-9_-]{5,30}$/.test(media.code)
    || typeof text !== 'string' || text.length > 5000
    || typeof media.has_liked !== 'boolean' || !info
    || typeof info.direct_reply_count !== 'number' || !Number.isSafeInteger(info.direct_reply_count)
    || info.direct_reply_count < 0) {
    fail('THREADS_SOCIAL_POST_SCHEMA');
  }
  const shareInfo = info.share_info;
  const pinInfo = info.pinned_post_info;
  const reposted = shareInfo && typeof shareInfo.is_reposted_by_viewer === 'boolean'
    ? shareInfo.is_reposted_by_viewer : null;
  const pinned = pinInfo && typeof pinInfo.is_pinned_to_profile === 'boolean'
    ? pinInfo.is_pinned_to_profile : null;
  const likeCount = Number.isSafeInteger(media.like_count) && media.like_count >= 0 ? media.like_count : null;
  const repostCount = Number.isSafeInteger(info.repost_count) && info.repost_count >= 0 ? info.repost_count : null;
  const quoteCount = Number.isSafeInteger(info.quote_count) && info.quote_count >= 0 ? info.quote_count : null;
  const timestamp = Number.isFinite(media.taken_at) ? media.taken_at : null;
  const selfThreadInfo=decodeSelfThreadInfo(info.self_thread_info);
  return {
    id,
    code: media.code,
    author,
    url: `https://www.threads.com/@${author}/post/${media.code}`,
    text,
    isReply: typeof info.is_reply === 'boolean' ? info.is_reply : null,
    canReply: typeof info.can_reply === 'boolean' ? info.can_reply : null,
    directReplyCount: info.direct_reply_count,
    likeCount,
    repostCount,
    quoteCount,
    quotedPostId: normalizedPostId(shareInfo?.quoted_post?.pk) || null,
    hasLiked: media.has_liked,
    isRepostedByViewer: reposted,
    isPinnedToProfile: pinned,
    selfThreadInfo,
    ...(timestamp == null ? {} : { publishedAt: new Date(timestamp * 1000).toISOString() }),
  };
}

export function decodeThreadsComments(payload, { postId, expectedAuthor, rootPost } = {}) {
  const id = safeId(postId);
  const expected = expectedAuthor == null ? null : safeHandle(expectedAuthor);
  if (!id) fail('THREADS_SOCIAL_POST_ID_INVALID');
  if (expectedAuthor != null && !expected) fail('THREADS_SOCIAL_EXPECTED_AUTHOR_INVALID');
  const media = payload?.data?.media;
  const mediaId = media?.pk ?? media?.id;
  const info = media?.text_post_app_info;
  const connection = info?.direct_replies;
  const edges = connection?.edges;
  const pageInfo = connection?.page_info;
  const author = safeHandle(rootPost?.author);
  if (!media || normalizedPostId(mediaId) !== id || !rootPost || rootPost.id !== id || !author
    || expected && author.toLowerCase() !== expected.toLowerCase()
    || !Array.isArray(edges) || edges.length > 100
    || !pageInfo || typeof pageInfo.has_next_page !== 'boolean'
    || !(pageInfo.end_cursor === null || typeof pageInfo.end_cursor === 'string')) {
    fail('THREADS_SOCIAL_COMMENTS_SCHEMA');
  }
  if (rootPost.canReply !== null && typeof rootPost.canReply !== 'boolean') {
    fail('THREADS_SOCIAL_COMMENTS_ROOT_SCHEMA');
  }

  const seen = new Set();
  let nestedContinuation = false;
  let nestedPaginationVerified = true;
  const comments = [];
  for (const edge of edges) {
    const group = edge?.node;
    const postsConnection = group?.posts;
    if (!Array.isArray(postsConnection?.edges) || postsConnection.edges.length > 100) {
      fail('THREADS_SOCIAL_COMMENTS_GROUP_SCHEMA');
    }
    if (postsConnection.page_info?.has_next_page === true) nestedContinuation = true;
    if (typeof postsConnection.page_info?.has_next_page !== 'boolean') nestedPaginationVerified = false;
    for (const [index, postEdge] of postsConnection.edges.entries()) {
      const post = postEdge?.node;
      const replyId = normalizedPostId(post?.pk ?? post?.id);
      const replyAuthor = safeHandle(post?.user?.username);
      // Observed image-only replies carry caption:null and media_type:1. The
      // observed image carousel uses media_type:8 with image-only children.
      const imageContentType = imageOnlyContentType(post, 'THREADS_SOCIAL_COMMENT_ROW_SCHEMA');
      const text = imageContentType ? '' : post?.caption?.text;
      const replyInfo = post?.text_post_app_info;
      if (!replyId || seen.has(replyId) || !replyAuthor || typeof text !== 'string' || text.length > 5000
        || !replyInfo || typeof replyInfo.is_reply !== 'boolean'
        || !Number.isSafeInteger(replyInfo.direct_reply_count) || replyInfo.direct_reply_count < 0
        || typeof post.has_liked !== 'boolean') {
        fail('THREADS_SOCIAL_COMMENT_ROW_SCHEMA');
      }
      seen.add(replyId);
      const comment = {
        id: replyId,
        authorId: safeId(post.user?.pk ?? post.user?.id),
        // The first node in each direct_replies group is the observed direct
        // reply; later posts in that group are nested descendants.
        directParentPostId: index === 0 ? id : null,
        author: replyAuthor,
        text,
        ...(imageContentType ? { contentType: imageContentType, captionPresent: false } : {}),
        isReply: replyInfo.is_reply,
        canReply: typeof replyInfo.can_reply === 'boolean' ? replyInfo.can_reply : null,
        directReplyCount: replyInfo.direct_reply_count,
        hasLiked: post.has_liked,
        ...(Number.isSafeInteger(post.like_count) && post.like_count >= 0 ? { likeCount: post.like_count } : {}),
        ...(Number.isFinite(post.taken_at) ? { publishedAt: new Date(post.taken_at * 1000).toISOString() } : {}),
      };
      comments.push(comment);
    }
  }
  const selfThreadPosts=info.self_thread?.posts;
  const selfThreadEdges=selfThreadPosts==null?null:selfThreadPosts.edges;
  if(selfThreadPosts!=null&&(!Array.isArray(selfThreadEdges)||selfThreadEdges.length>100)) {
    fail('THREADS_SOCIAL_SELF_THREAD_SCHEMA');
  }
  const selfThreadChildren=[];
  if(Array.isArray(selfThreadEdges)) for(const edge of selfThreadEdges) {
    const post=edge?.node,childId=normalizedPostId(post?.pk??post?.id),childAuthor=safeHandle(post?.user?.username);
    const imageContentType=imageOnlyContentType(post,'THREADS_SOCIAL_SELF_THREAD_POST_SCHEMA');
    const childText=imageContentType?'':post?.caption?.text,childPostInfo=post?.text_post_app_info;
    const childThreadInfo=decodeSelfThreadInfo(childPostInfo?.self_thread_info);
    if(!childId||!childAuthor||typeof childText!=='string'||childText.length>5000||!childPostInfo
      ||typeof childPostInfo.is_reply!=='boolean') fail('THREADS_SOCIAL_SELF_THREAD_POST_SCHEMA');
    if(childAuthor.toLowerCase()!==author.toLowerCase()||childPostInfo.is_reply!==true
      ||!rootPost.selfThreadInfo||!childThreadInfo||childThreadInfo.id!==rootPost.selfThreadInfo.id
      ||childThreadInfo.position!==rootPost.selfThreadInfo.position+1) continue;
    selfThreadChildren.push({id:childId,authorId:safeId(post?.user?.pk??post?.user?.id),author:childAuthor,
      text:childText,isReply:true,directParentPostId:id,relationSource:'self_thread_adjacent_position',
      ...(imageContentType?{contentType:imageContentType,captionPresent:false}:{}),
      selfThreadInfo:childThreadInfo});
  }
  const hasNextPage = pageInfo.has_next_page;
  return {
    postId: id,
    postAuthor: author,
    canReply: rootPost.canReply,
    totalDirectReplyCount: rootPost.directReplyCount,
    rootSelfThreadInfo:rootPost.selfThreadInfo,
    comments,
    selfThreadChildren,
    selfThreadPage:{coverage:'observed_self_thread_edges',observedChildren:selfThreadEdges?.length||0,fullList:false},
    page: {
      coverage: 'first_downward_response',
      observedGroups: edges.length,
      observedReplies: comments.length,
      hasNextPage,
      nestedContinuationAvailable: nestedContinuation,
      nestedPaginationVerified,
      // The captured page-info and nested group shape have not been proven to
      // provide a complete direct-reply traversal contract.
      fullList: false,
      cursorFingerprint: pageInfo.end_cursor ? sha256(pageInfo.end_cursor).slice(0, 16) : null,
    },
  };
}

function validPartialThreadsCommentRead(result, operation) {
  const receipt = result?.receipt;
  return result?.partialGraphqlRead === true && result.payload === null
    && receipt?.operation === operation && receipt.httpStatus === 200
    && receipt.partialGraphqlRead === true && receipt.providerErrorCode === 4686025
    && Number.isSafeInteger(receipt.providerErrorCount) && receipt.providerErrorCount > 0
    && receipt.providerErrorCount <= 10_000;
}

function incompleteThreadsCommentsSnapshot(postId, rootPost) {
  return {
    postId,
    postAuthor: rootPost.author,
    canReply: rootPost.canReply,
    totalDirectReplyCount: rootPost.directReplyCount,
    rootSelfThreadInfo: rootPost.selfThreadInfo,
    comments: [],
    selfThreadChildren: [],
    selfThreadPage: { coverage: 'partial_graphql_read', observedChildren: 0, fullList: false },
    page: {
      coverage: 'partial_direct_replies', observedGroups: 0, observedReplies: 0,
      hasNextPage: null, nestedContinuationAvailable: null, nestedPaginationVerified: false,
      fullList: false, cursorFingerprint: null, graphqlIncomplete: true,
    },
  };
}

async function loadContext(owner, context, contextLoader) {
  return verifyContext(await loadGuardedContext(owner, context, contextLoader), owner);
}

export async function paginateThreadsFollowers(fetchPage, ownerId, maxPages) {
  const followers = []; const seen = new Set(); const receipts = []; let after = null; let last;
  for (let page = 0; page < maxPages; page++) {
    const result = await fetchPage(after);
    last = decodeThreadsFollowers(result.payload, ownerId);
    receipts.push(result.receipt);
    for (const f of last.followers) if (!seen.has(f.id)) { seen.add(f.id); followers.push(f); }
    const next = result.payload?.data?.user?.followers?.page_info?.end_cursor;
    if (!last.page.hasNextPage || !next || next === after) break;
    after = next;
  }
  return { followers, receipts, last };
}

export async function readThreadsFollowers({
  owner = OWNER,
  maxPages = 20,
  context,
  contextLoader = openMetaContext,
  querySender = sendQuery,
} = {}) {
  if (owner.toLowerCase() !== OWNER) fail('THREADS_SOCIAL_OWNER_SCOPE');
  // 2026-10-21: page through the list (was first page only: 18 of more, so older followers were never seen).
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 25) fail('THREADS_SOCIAL_FOLLOWERS_PAGE_LIMIT_INVALID');
  const ctx = await loadContext(owner, context, contextLoader);
  const { followers, receipts, last } = await paginateThreadsFollowers(async after => {
    const request = buildRequest(ctx, FOLLOWERS_QUERY, buildThreadsFollowersVariables(ctx.bundle.ownerId, after));
    return querySender(ctx, request, FOLLOWERS_QUERY.operation, FOLLOWERS_QUERY.path);
  }, ctx.bundle.ownerId, maxPages);
  return {
    ownerId: last.ownerId, followers,
    page: { ...last.page, fullList: last.page.hasNextPage === false, observed: followers.length, pages: receipts.length },
    receipt: receipts[0], receipts,
  };
}

export async function readThreadsEngagement(postId, {
  owner = OWNER,
  context,
  contextLoader = openMetaContext,
  querySender = sendQuery,
} = {}) {
  if (owner.toLowerCase() !== OWNER) fail('THREADS_SOCIAL_OWNER_SCOPE');
  const ctx = await loadContext(owner, context, contextLoader);
  const variables = buildThreadsFeedbackHubVariables(postId);
  const request = buildRequest(ctx, FEEDBACK_HUB_QUERY, variables);
  const result = await querySender(ctx, request, FEEDBACK_HUB_QUERY.operation, FEEDBACK_HUB_QUERY.path);
  return {
    ...decodeThreadsEngagement(result.payload, postId),
    receipt: result.receipt,
  };
}

export async function inspectThreadsPost({ postId, expectedAuthor } = {}, {
  owner = OWNER,
  context,
  contextLoader = openMetaContext,
  querySender = sendMetaQuery,
} = {}) {
  if (owner.toLowerCase() !== OWNER) fail('THREADS_SOCIAL_OWNER_SCOPE');
  const id = safeId(postId);
  if (!id) fail('THREADS_SOCIAL_POST_ID_INVALID');
  const ctx = await loadContext(owner, context, contextLoader);
  const contract = THREADS_READBACK_CONTRACTS.target;
  const variables = buildThreadsTargetVariables(id);
  const request = metaRequest(ctx, contract.operation, contract.docId, variables,
    { canonicalRouteName: PROFILE_ROUTE });
  const result = await querySender(ctx, request);
  return {
    ...decodeThreadsPost(result.payload, { postId: id, expectedAuthor }),
    receipt: {
      ...result.receipt,
      credentialProvider: 'windows_dpapi_current_user',
      credentialValuesRecorded: false,
      owner: ctx.bundle.owner,
      ownerVerified: true,
      executionMode: 'pure_http',
      browserUsed: false,
      captured: true,
      client_exists: true,
      credential_propagated: true,
      remnant_free: true,
      live_replay: true,
    },
  };
}

export async function readThreadsComments(postId, {
  expectedAuthor,
  owner = OWNER,
  context,
  contextLoader = openMetaContext,
  querySender = sendMetaQuery,
  maxPages = 10,
} = {}) {
  if (owner.toLowerCase() !== OWNER) fail('THREADS_SOCIAL_OWNER_SCOPE');
  const id = safeId(postId);
  if (!id) fail('THREADS_SOCIAL_POST_ID_INVALID');
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 25) fail('THREADS_SOCIAL_COMMENTS_PAGE_LIMIT_INVALID');
  let ctx = await loadContext(owner, context, contextLoader);
  const ownerId = ctx.bundle.ownerId;
  const refreshExpiredContext = async () => {
    if (!(Date.now() - ctx.createdAt > 180_000)) return;
    // A long traversal can outlive the local request context. Refresh only
    // before the next read; never resend a page or relax the expiry check.
    ctx = await withMetaSessionLock('threads', async () => {
      await assertThreadsSocialReadCooldown(ctx, {
        method: 'GET', path: '/{profile}', operation: 'protected_profile_bootstrap',
      });
      const readGates = Object.fromEntries(['throttleRoot', 'readBudgetRoot', 'readBudgetLimits']
        .filter(key => ctx[key] !== undefined).map(key => [key, ctx[key]]));
      const fresh = verifyContext(await contextLoader('threads', owner, { freshDocument: true, ...readGates }), owner);
      if (fresh.bundle.ownerId !== ownerId || fresh.documentReceipt?.ownerVerified !== true) {
        fail('THREADS_SOCIAL_OWNER_UNVERIFIED');
      }
      return { ...fresh, ...readGates };
    });
  };
  await refreshExpiredContext();
  // DOWNWARD only exposes root ID and reply groups in the observed payload;
  // bind identity and reply permission from the captured TARGET read.
  const root = await inspectThreadsPost({ postId: id, expectedAuthor }, {
    owner, context: ctx, contextLoader, querySender,
  });
  await refreshExpiredContext();
  const contract = THREADS_READBACK_CONTRACTS.downward;
  const variables = buildThreadsDownwardVariables(id);
  const request = metaRequest(ctx, contract.operation, contract.docId, variables,
    { canonicalRouteName: PROFILE_ROUTE });
  const result = await querySender(ctx, request);
  let graphqlIncomplete = result?.partialGraphqlRead === true;
  if (graphqlIncomplete && !validPartialThreadsCommentRead(result, contract.operation)) {
    fail('THREADS_SOCIAL_COMMENTS_PARTIAL_READ_SCHEMA');
  }
  const initial = graphqlIncomplete
    ? incompleteThreadsCommentsSnapshot(id, root)
    : decodeThreadsComments(result.payload, { postId: id, expectedAuthor, rootPost: root });
  const pages = [result.receipt];
  const byId = new Map(initial.comments.map(comment => [comment.id, comment]));
  const cursors = new Set();
  let page = initial;
  let cursor = graphqlIncomplete ? null : result.payload.data.media.text_post_app_info.direct_replies.page_info.end_cursor;
  let nestedContinuation = initial.page.nestedContinuationAvailable;
  let nestedPaginationVerified = initial.page.nestedPaginationVerified;
  while (!graphqlIncomplete && page.page.hasNextPage && pages.length < maxPages) {
    if (!cursor) fail('THREADS_SOCIAL_COMMENTS_CURSOR_MISSING');
    if (cursors.has(cursor)) fail('THREADS_SOCIAL_COMMENTS_CURSOR_REPEATED');
    cursors.add(cursor);
    await refreshExpiredContext();
    const nextContract = THREADS_READBACK_CONTRACTS.directReplies;
    const nextRequest = metaRequest(ctx, nextContract.operation, nextContract.docId,
      buildThreadsDirectRepliesVariables(id, cursor), { canonicalRouteName: PROFILE_ROUTE });
    const nextResult = await querySender(ctx, nextRequest);
    if (nextResult?.partialGraphqlRead === true) {
      if (!validPartialThreadsCommentRead(nextResult, nextContract.operation)) {
        fail('THREADS_SOCIAL_COMMENTS_PARTIAL_READ_SCHEMA');
      }
      graphqlIncomplete = true;
      pages.push(nextResult.receipt);
      break;
    }
    page = decodeThreadsComments(nextResult.payload, { postId: id, expectedAuthor, rootPost: root });
    pages.push(nextResult.receipt);
    nestedContinuation ||= page.page.nestedContinuationAvailable;
    nestedPaginationVerified &&= page.page.nestedPaginationVerified;
    for (const comment of page.comments) {
      const existing = byId.get(comment.id);
      if (existing && ['authorId', 'author', 'directParentPostId', 'isReply', 'text'].some(key => existing[key] !== comment[key])) {
        fail('THREADS_SOCIAL_COMMENTS_CONFLICTING_REPLY');
      }
      byId.set(comment.id, comment);
    }
    cursor = nextResult.payload.data.media.text_post_app_info.direct_replies.page_info.end_cursor;
    if (page.page.hasNextPage && cursors.has(cursor)) fail('THREADS_SOCIAL_COMMENTS_CURSOR_REPEATED');
  }
  const comments = [...byId.values()];
  const directComments = comments.filter(comment => comment.directParentPostId === id);
  // A terminal service page can still omit unavailable/hidden replies. Never
  // use terminal pagination alone as proof that an owner reply does not exist.
  const countMatches = !graphqlIncomplete && Number.isSafeInteger(root.directReplyCount)
    && directComments.length === root.directReplyCount;
  let rootAfter = null;
  if (!graphqlIncomplete && !page.page.hasNextPage && !nestedContinuation && nestedPaginationVerified
    && countMatches && directComments.every(comment => comment.isReply)) {
    await refreshExpiredContext();
    rootAfter = await inspectThreadsPost({ postId: id, expectedAuthor }, { owner, context: ctx, contextLoader, querySender });
  }
  const stableCount = rootAfter !== null && rootAfter.directReplyCount === root.directReplyCount;
  const fullList = !graphqlIncomplete && !page.page.hasNextPage && !nestedContinuation
    && nestedPaginationVerified && countMatches && stableCount;
  return {
    ...initial,
    comments,
    page: {
      ...page.page,
      coverage: fullList ? 'complete_count_verified_direct_replies' : 'partial_direct_replies',
      observedGroups: directComments.length,
      pageCount: pages.length,
      observedReplies: comments.length,
      observedDirectReplies: directComments.length,
      nestedContinuationAvailable: nestedContinuation,
      nestedPaginationVerified,
      graphqlIncomplete,
      truncatedByLimit: page.page.hasNextPage === true && pages.length >= maxPages,
      countMatches,
      stableCount,
      fullList,
    },
    receipt: {
      rootPost: root.receipt,
      ...(rootAfter ? { rootPostAfter: rootAfter.receipt } : {}),
      comments: {
        ...result.receipt,
        pages,
        credentialProvider: 'windows_dpapi_current_user',
        credentialValuesRecorded: false,
        owner: ctx.bundle.owner,
        ownerVerified: true,
        executionMode: 'pure_http',
        browserUsed: false,
        captured: true,
        client_exists: true,
        credential_propagated: true,
        remnant_free: true,
        live_replay: true,
      },
    },
  };
}

function verifyProfileContext(context, handle) {
  if (context?.service !== 'threads' || context.handle?.toLowerCase() !== handle.toLowerCase()
    || context.bundle?.service !== 'threads' || context.bundle?.owner?.toLowerCase() !== OWNER
    || !safeId(context.bundle.ownerId) || context.bundle.origin !== ORIGIN) {
    fail('THREADS_SOCIAL_PROFILE_CONTEXT_UNVERIFIED');
  }
  return context;
}

function collectProfilePosts(roots, handle) {
  const posts = new Map();
  let nodes = 0;
  const walk = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 60) return;
    if (++nodes > 180_000) fail('THREADS_SOCIAL_PROFILE_COMPLEXITY');
    const author = safeHandle(value.user?.username ?? value.owner?.username);
    const id = normalizedPostId(value.pk ?? value.id ?? value.media_id);
    const code = value.code;
    const caption = value.caption?.text;
    const info = value.text_post_app_info;
    if (author?.toLowerCase() === handle.toLowerCase() && id
      && typeof code === 'string' && /^[A-Za-z0-9_-]{5,30}$/.test(code)
      && typeof caption === 'string' && caption.length <= 5000
      && info && typeof info === 'object') {
      const pin = info.pinned_post_info?.is_pinned_to_profile;
      const reposted = info.share_info?.is_reposted_by_viewer;
      const post = {
        id,
        code,
        author,
        url: `https://www.threads.com/@${author}/post/${code}`,
        text: caption,
        isReply: typeof info.is_reply === 'boolean' ? info.is_reply : null,
        canReply: typeof info.can_reply === 'boolean' ? info.can_reply : null,
        directReplyCount: Number.isSafeInteger(info.direct_reply_count) && info.direct_reply_count >= 0
          ? info.direct_reply_count : null,
        likeCount: Number.isSafeInteger(value.like_count) && value.like_count >= 0 ? value.like_count : null,
        repostCount: Number.isSafeInteger(info.repost_count) && info.repost_count >= 0 ? info.repost_count : null,
        quoteCount: Number.isSafeInteger(info.quote_count) && info.quote_count >= 0 ? info.quote_count : null,
        hasLiked: typeof value.has_liked === 'boolean' ? value.has_liked : null,
        isRepostedByViewer: typeof reposted === 'boolean' ? reposted : null,
        isPinnedToProfile: typeof pin === 'boolean' ? pin : null,
        ...(Number.isFinite(value.taken_at)
          ? { publishedAt: new Date(value.taken_at * 1000).toISOString() } : {}),
      };
      const existing = posts.get(id);
      if (existing && (existing.code !== post.code || existing.text !== post.text
        || existing.isPinnedToProfile !== post.isPinnedToProfile)) {
        fail('THREADS_SOCIAL_PROFILE_POST_CONFLICT');
      }
      posts.set(id, post);
    }
    for (const child of Object.values(value)) walk(child, depth + 1);
  };
  roots.forEach(root => walk(root));
  return [...posts.values()].sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
}

export function decodeThreadsProfileDocument(html, { handle, viewerOwner, viewerId } = {}) {
  const username = safeHandle(handle);
  const owner = safeHandle(viewerOwner);
  const id = safeId(viewerId);
  if (!username || !owner || !id || typeof html !== 'string') fail('THREADS_SOCIAL_PROFILE_INPUT_INVALID');
  const document = parseMetaBootstrap(html, username);
  const viewer = document.modules.get('BarcelonaSharedData')?.viewer;
  if (viewer?.username?.toLowerCase() !== owner.toLowerCase() || safeId(viewer?.id) !== id) {
    fail('THREADS_SOCIAL_PROFILE_VIEWER_MISMATCH');
  }
  const roots = [];
  for (const match of html.matchAll(/<script\b[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) {
    try { roots.push(JSON.parse(match[1])); } catch { /* ignore non-JSON application blocks */ }
    if (roots.length > 500) fail('THREADS_SOCIAL_PROFILE_SCRIPT_LIMIT');
  }
  const posts = collectProfilePosts(roots, username);
  const pinKnown = posts.some(post => post.isPinnedToProfile !== null);
  const pinnedPostIds = posts.filter(post => post.isPinnedToProfile === true).map(post => post.id);
  return {
    handle: username,
    posts,
    pinnedPostIds,
    pinState: pinnedPostIds.length ? 'pinned_post_observed' : pinKnown ? 'no_pin_in_initial_window' : 'not_exposed',
    coverage: 'initial_document_window',
    fullTimeline: false,
  };
}

export async function readThreadsProfilePosts({ handle = OWNER } = {}, {
  context,
  contextLoader = openMetaContext,
  fetchImpl,
} = {}) {
  const username = safeHandle(handle);
  if (!username) fail('THREADS_SOCIAL_PROFILE_HANDLE_INVALID');
  const ctx = verifyProfileContext(await loadGuardedContext(username, context, contextLoader), username);
  const url = `${ORIGIN}/@${username}/`;
  const response = await withMetaSessionLock('threads', async () => {
    await assertThreadsSocialReadCooldown(ctx, { method: 'GET', path: '/{profile}', operation: 'ThreadsProfileDocumentRead' });
    await reserveThreadsRead({ operation: 'ThreadsProfileDocumentRead', root: ctx.readBudgetRoot, limits: ctx.readBudgetLimits });
    const response = await (fetchImpl || ctx.fetchImpl)(url, {
      headers: {
        accept: 'text/html',
        cookie: metaCookieHeader(ctx.bundle, url),
        'cache-control': 'no-cache',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(SOCIAL_REQUEST_TIMEOUTS.read),
    });
    await rotateMetaCookiesWithRetry(ctx.bundle, response);
    return response;
  });
  const responseUrl = new URL(response.url);
  if (responseUrl.origin !== ORIGIN || responseUrl.pathname !== `/@${username}/`
    || responseUrl.search || responseUrl.hash) fail('THREADS_SOCIAL_PROFILE_RESPONSE_SCOPE');
  if (response.status !== 200) fail('THREADS_SOCIAL_PROFILE_HTTP_' + response.status);
  const mime = response.headers.get('content-type') || '';
  if (!/^text\/html(?:;|$)/i.test(mime)) fail('THREADS_SOCIAL_PROFILE_MIME');
  const html = await boundedText(response, MAX_RESPONSE_BYTES);
  const result = decodeThreadsProfileDocument(html, {
    handle: username,
    viewerOwner: ctx.bundle.owner,
    viewerId: ctx.bundle.ownerId,
  });
  return {
    ...result,
    receipt: {
      operation: 'ThreadsAuthenticatedProfileDocument',
      method: 'GET',
      path: `/@${username}/`,
      httpStatus: response.status,
      mime: mime.split(';')[0].toLowerCase(),
      bytes: Buffer.byteLength(html),
      responseSha256: sha256(html),
      checkedAt: new Date().toISOString(),
      executionMode: 'pure_http',
      browserUsed: false,
      credentialProvider: 'windows_dpapi_current_user',
      credentialValuesRecorded: false,
      owner: ctx.bundle.owner,
      ownerVerified: true,
      credential_propagated: true,
      captured: true,
      client_exists: true,
      remnant_free: true,
      live_replay: true,
    },
  };
}

async function extractProfileTimelineSources(sources) {
  const values = new Map();
  let totalBytes = 0;
  const targets = new Set(Object.values(PROFILE_TIMELINE_MODULES));

  for (const scriptUrl of sources.scriptUrls) {
    let parsed;
    try { parsed = new URL(scriptUrl); } catch { fail('THREADS_SOCIAL_PROFILE_SOURCE_SCOPE'); }
    if (parsed.origin !== 'https://static.cdninstagram.com' || !parsed.pathname.startsWith('/rsrc.php/')
      || parsed.username || parsed.password) fail('THREADS_SOCIAL_PROFILE_SOURCE_SCOPE');
  }

  const fetchScript = async url => {
    const response = await sources.fetchImpl(url, {
      headers: { accept: 'text/javascript, application/javascript, */*' },
      credentials: 'omit',
      redirect: 'manual',
      signal: AbortSignal.timeout(SOCIAL_REQUEST_TIMEOUTS.read),
    });
    if (response.status !== 200) fail('THREADS_SOCIAL_PROFILE_SOURCE_HTTP_' + response.status);
    const text = await boundedText(response, PROFILE_TIMELINE_MAX_SCRIPT_BYTES);
    totalBytes += Buffer.byteLength(text);
    if (totalBytes > PROFILE_TIMELINE_MAX_SCRIPT_TOTAL_BYTES) fail('THREADS_SOCIAL_PROFILE_SOURCE_LIMIT');
    return text;
  };

  for (let offset = 0; offset < sources.scriptUrls.length; offset += 4) {
    const scripts = await Promise.all(sources.scriptUrls.slice(offset, offset + 4).map(async url => ({
      url,
      text: await fetchScript(url),
    })));
    for (const { text } of scripts) {
      const moduleMatches = [...text.matchAll(/__d\("([^"]+)"/g)];
      for (let index = 0; index < moduleMatches.length; index += 1) {
        const name = moduleMatches[index][1];
        if (!targets.has(name)) continue;
        const end = moduleMatches[index + 1]?.index ?? text.length;
        const source = text.slice(moduleMatches[index].index, end);
        const existing = values.get(name);
        if (existing && existing !== source) fail('THREADS_SOCIAL_PROFILE_SOURCE_AMBIGUOUS');
        values.set(name, source);
      }
    }
  }

  const operationSource = values.get(PROFILE_TIMELINE_MODULES.operation);
  const operationIdSource = values.get(PROFILE_TIMELINE_MODULES.operationId);
  const paginationSource = values.get(PROFILE_TIMELINE_MODULES.pagination);
  const componentSource = values.get(PROFILE_TIMELINE_MODULES.component);
  const entrypointSource = values.get(PROFILE_TIMELINE_MODULES.entrypoint);
  if ([operationSource, operationIdSource, paginationSource, componentSource, entrypointSource].some(value => !value)) {
    fail('THREADS_SOCIAL_PROFILE_SOURCE_MISSING');
  }

  const docId = /(?:a|i|l)\.exports="(\d{10,30})"/.exec(operationIdSource)?.[1];
  if (!docId
    || !/name:"after",variableName:"after"/.test(operationSource)
    || !/name:"first",variableName:"first"/.test(operationSource)
    || !operationSource.includes('name:"page_info"')
    || !operationSource.includes('name:"end_cursor"')
    || !operationSource.includes('name:"has_next_page"')
    || !operationSource.includes('name:"thread_items"')
    || !operationSource.includes('name:"post"')
    || !operationSource.includes('name:"caption"')
    || !operationSource.includes('name:"text"')
    || !operationSource.includes('name:"code"')
    || !operationSource.includes('name:"user"')
    || !/forward:\{count:"first",cursor:"after"\}/.test(paginationSource)
    || !componentSource.includes('usePaginationFragment')
    || !componentSource.includes('.loadNext')
    || !entrypointSource.includes('allow_page_info_for_lox_user:t.routeProps.max_thread_count!=null')
    || !entrypointSource.includes('first:t.routeProps.initial_thread_count')
    || !entrypointSource.includes('userID:t.routeProps.user_id')) {
    fail('THREADS_SOCIAL_PROFILE_PAGINATION_CONTRACT_UNVERIFIED');
  }

  const localArguments = new Set([...operationSource.matchAll(/kind:"LocalArgument",name:"([^"]+)"/g)]
    .map(match => match[1]));
  const providerNames = [...localArguments]
    .filter(name => name.startsWith('__relay_internal__pv__'))
    .sort();
  if (!localArguments.has('after') || !localArguments.has('first') || !localArguments.has('userID')
    || !localArguments.has('allow_page_info_for_lox_user') || providerNames.length === 0) {
    fail('THREADS_SOCIAL_PROFILE_PAGINATION_CONTRACT_UNVERIFIED');
  }

  const sourceFingerprint = sha256([
    operationSource,
    operationIdSource,
    paginationSource,
    componentSource,
    entrypointSource,
  ].join('\n'));
  return { operation: 'BarcelonaProfileThreadsTabDirectQuery', docId, providerNames, sourceFingerprint };
}

async function loadProfileTimelineContract(scriptUrls, fetchImpl) {
  if (!Array.isArray(scriptUrls) || scriptUrls.length === 0
    || scriptUrls.length > PROFILE_TIMELINE_MAX_SCRIPT_COUNT || typeof fetchImpl !== 'function') {
    fail('THREADS_SOCIAL_PROFILE_SOURCE_MISSING');
  }
  const cacheKey = sha256(scriptUrls.join('\n'));
  const cached = profileTimelineContractCache.get(cacheKey);
  if (cached) return cached;
  const contract = await extractProfileTimelineSources({ scriptUrls, fetchImpl });
  if (profileTimelineContractCache.size < 32) profileTimelineContractCache.set(cacheKey, contract);
  return contract;
}

function extractProfileTimelinePreload(html, handle, expectedRoute, providerNames) {
  const candidates = [];
  let nodeCount = 0;
  const walk = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 70) return;
    if (++nodeCount > 300_000) fail('THREADS_SOCIAL_PROFILE_PRELOAD_COMPLEXITY');
    if (Array.isArray(value.expectedPreloaders) && value.expectedPreloaders[1]?.variables) {
      const route = value.initialRouteInfo?.route;
      const routeProps = route?.rootView?.props;
      if (route && routeProps) candidates.push({
        routeName: route.canonicalRouteName,
        routeProps,
        variables: value.expectedPreloaders[1].variables,
      });
    }
    for (const child of Object.values(value)) walk(child, depth + 1);
  };

  let scriptCount = 0;
  for (const match of html.matchAll(/<script\b[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) {
    scriptCount += 1;
    if (scriptCount > 500) fail('THREADS_SOCIAL_PROFILE_SCRIPT_LIMIT');
    let root;
    try { root = JSON.parse(match[1]); } catch { continue; }
    walk(root);
  }

  const unique = new Map(candidates.map(candidate => [
    sha256(JSON.stringify({ routeName: candidate.routeName, variables: candidate.variables })), candidate,
  ]));
  if (unique.size !== 1) fail(unique.size ? 'THREADS_SOCIAL_PROFILE_PRELOAD_AMBIGUOUS' : 'THREADS_SOCIAL_PROFILE_PRELOAD_MISSING');
  const candidate = [...unique.values()][0];
  const { routeName, routeProps, variables } = candidate;
  const keys = Object.keys(variables).sort();
  const expectedKeys = ['allow_page_info_for_lox_user', 'first', 'userID', ...providerNames].sort();
  const targetId = safeId(routeProps.user_id);
  if (routeName !== expectedRoute || !targetId || targetId !== safeId(variables.userID)
    || !safeId(variables.userID) || !Number.isSafeInteger(variables.first)
    || variables.first < 1 || variables.first > PROFILE_TIMELINE_MAX_LIMIT
    || routeProps.initial_thread_count !== variables.first
    || typeof variables.allow_page_info_for_lox_user !== 'boolean'
    || variables.allow_page_info_for_lox_user !== (routeProps.max_thread_count != null)
    || keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])
    || providerNames.some(name => typeof variables[name] !== 'boolean')) {
    fail('THREADS_SOCIAL_PROFILE_PRELOAD_INVALID');
  }
  if (routeProps.username != null && String(routeProps.username).toLowerCase() !== handle.toLowerCase()
    || routeProps.handle != null && String(routeProps.handle).replace(/^@/, '').toLowerCase() !== handle.toLowerCase()) {
    fail('THREADS_SOCIAL_PROFILE_PRELOAD_IDENTITY_MISMATCH');
  }
  return { routeName, variables: JSON.parse(JSON.stringify(variables)), targetId };
}

function extractProfileTimelineConnection(payload) {
  const candidates = [];
  let nodes = 0;
  const walk = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 70) return;
    if (++nodes > 250_000) fail('THREADS_SOCIAL_PROFILE_RESPONSE_COMPLEXITY');
    if (Array.isArray(value.edges) && value.edges.length <= 1000
      && value.page_info && typeof value.page_info.has_next_page === 'boolean'
      && (value.page_info.end_cursor === null || typeof value.page_info.end_cursor === 'string')) {
      candidates.push(value);
    }
    for (const child of Object.values(value)) walk(child, depth + 1);
  };
  if (!payload?.data || typeof payload.data !== 'object') fail('THREADS_SOCIAL_PROFILE_RESPONSE_SCHEMA');
  walk(payload.data);
  if (candidates.length !== 1) fail('THREADS_SOCIAL_PROFILE_CONNECTION_AMBIGUOUS');
  const connection = candidates[0];
  const pageInfo = connection.page_info;
  if (pageInfo.end_cursor != null && (pageInfo.end_cursor.length > 8192 || /[\x00-\x20\x7f]/.test(pageInfo.end_cursor))) {
    fail('THREADS_SOCIAL_PROFILE_CURSOR_INVALID');
  }
  if (pageInfo.has_next_page && !pageInfo.end_cursor) fail('THREADS_SOCIAL_PROFILE_CURSOR_MISSING');
  return { edges: connection.edges, hasNextPage: pageInfo.has_next_page, cursor: pageInfo.end_cursor };
}

function decodeProfileTimelinePost(value, handle) {
  const author = safeHandle(value?.user?.username ?? value?.owner?.username);
  if (!author || author.toLowerCase() !== handle.toLowerCase()) return null;
  const id = normalizedPostId(value?.pk ?? value?.id ?? value?.media_id);
  const code = value?.code;
  const captionValue = value.caption === null ? ''
    : value.caption && typeof value.caption === 'object' && Object.hasOwn(value.caption, 'text')
      && value.caption.text === null ? '' : value.caption?.text;
  const info = value?.text_post_app_info;
  if (!id || typeof code !== 'string' || !/^[A-Za-z0-9_-]{5,30}$/.test(code)
    || !Object.hasOwn(value, 'caption') || typeof captionValue !== 'string' || captionValue.length > 5000
    || !info || typeof info !== 'object') {
    fail('THREADS_SOCIAL_PROFILE_POST_SCHEMA');
  }
  const pin = info.pinned_post_info?.is_pinned_to_profile;
  const reposted = info.share_info?.is_reposted_by_viewer;
  return {
    id,
    code,
    author,
    url: `https://www.threads.com/@${author}/post/${code}`,
    text: captionValue,
    isReply: typeof info.is_reply === 'boolean' ? info.is_reply : null,
    canReply: typeof info.can_reply === 'boolean' ? info.can_reply : null,
    directReplyCount: Number.isSafeInteger(info.direct_reply_count) && info.direct_reply_count >= 0
      ? info.direct_reply_count : null,
    likeCount: Number.isSafeInteger(value.like_count) && value.like_count >= 0 ? value.like_count : null,
    repostCount: Number.isSafeInteger(info.repost_count) && info.repost_count >= 0 ? info.repost_count : null,
    quoteCount: Number.isSafeInteger(info.quote_count) && info.quote_count >= 0 ? info.quote_count : null,
    hasLiked: typeof value.has_liked === 'boolean' ? value.has_liked : null,
    isRepostedByViewer: typeof reposted === 'boolean' ? reposted : null,
    isPinnedToProfile: typeof pin === 'boolean' ? pin : null,
    ...(Number.isFinite(value.taken_at)
      ? { publishedAt: new Date(value.taken_at * 1000).toISOString() } : {}),
  };
}

function collectProfileTimelinePosts(edges, handle) {
  const posts = new Map();
  for (const edge of edges) {
    const thread = edge?.node;
    const items = thread?.thread_items;
    if (!thread || !Array.isArray(items) || items.length > 100) fail('THREADS_SOCIAL_PROFILE_THREAD_SCHEMA');
    for (const item of items) {
      if (!item?.post || typeof item.post !== 'object') fail('THREADS_SOCIAL_PROFILE_THREAD_ITEM_SCHEMA');
      const post = decodeProfileTimelinePost(item.post, handle);
      if (!post) continue;
      const previous = posts.get(post.id);
      if (previous && (previous.code !== post.code || previous.text !== post.text
        || previous.isPinnedToProfile !== post.isPinnedToProfile)) fail('THREADS_SOCIAL_PROFILE_POST_CONFLICT');
      posts.set(post.id, post);
    }
  }
  return [...posts.values()];
}

function buildProfileTimelineRequest(context, contract, variables, routeName) {
  const request = metaRequest(context, contract.operation, contract.docId, variables, { canonicalRouteName: routeName });
  const url = new URL(request.url);
  if (url.origin !== ORIGIN || url.pathname !== '/api/graphql' || url.search || url.hash
    || request.method !== 'POST' || request.body?.get('fb_api_req_friendly_name') !== contract.operation
    || request.body?.get('doc_id') !== contract.docId || request.headers.origin !== ORIGIN
    || new URL(request.headers.referer).origin !== ORIGIN) {
    fail('THREADS_SOCIAL_PROFILE_REQUEST_SCOPE');
  }
  return request;
}

/**
 * Read the profile's Threads connection through the current first-party Relay
 * pagination contract. `fullTimeline` is true only when the service reports
 * no next page and every returned row fits within the requested limit.
 */
export async function readThreadsProfileTimeline({ handle = OWNER, limit = 30 } = {}, {
  context,
  contextLoader = openMetaContext,
  fetchImpl,
  querySender = sendMetaQuery,
  sourceContractLoader = loadProfileTimelineContract,
} = {}) {
  const username = safeHandle(handle);
  if (!username) fail('THREADS_SOCIAL_PROFILE_HANDLE_INVALID');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PROFILE_TIMELINE_MAX_LIMIT) {
    fail('THREADS_SOCIAL_PROFILE_LIMIT_INVALID');
  }
  const ctx = verifyProfileContext(await loadGuardedContext(username, context, contextLoader), username);
  const url = `${ORIGIN}/@${username}/`;
  await reserveThreadsRead({ operation: 'ThreadsProfileDocumentRead', root: ctx.readBudgetRoot, limits: ctx.readBudgetLimits });
  const response = await (fetchImpl || ctx.fetchImpl)(url, {
    headers: { accept: 'text/html', cookie: metaCookieHeader(ctx.bundle, url), 'cache-control': 'no-cache' },
    redirect: 'manual',
    signal: AbortSignal.timeout(SOCIAL_REQUEST_TIMEOUTS.read),
  });
  await rotateMetaCookiesWithRetry(ctx.bundle, response);
  let responseUrl;
  try { responseUrl = new URL(response.url); } catch { fail('THREADS_SOCIAL_PROFILE_RESPONSE_SCOPE'); }
  if (responseUrl.origin !== ORIGIN || responseUrl.pathname !== `/@${username}/`
    || responseUrl.search || responseUrl.hash) fail('THREADS_SOCIAL_PROFILE_RESPONSE_SCOPE');
  if (response.status !== 200) fail('THREADS_SOCIAL_PROFILE_HTTP_' + response.status);
  const mime = response.headers.get('content-type') || '';
  if (!/^text\/html(?:;|$)/i.test(mime)) fail('THREADS_SOCIAL_PROFILE_MIME');
  const html = await boundedText(response, MAX_RESPONSE_BYTES);
  const document = parseMetaBootstrap(html, username);
  const viewer = document.modules.get('BarcelonaSharedData')?.viewer;
  if (viewer?.username?.toLowerCase() !== ctx.bundle.owner.toLowerCase()
    || safeId(viewer?.id) !== safeId(ctx.bundle.ownerId)) fail('THREADS_SOCIAL_PROFILE_VIEWER_MISMATCH');

  const contract = await sourceContractLoader(document.scriptUrls, ctx.fetchImpl);
  if (!contract || contract.operation !== 'BarcelonaProfileThreadsTabDirectQuery'
    || !/^\d{10,30}$/.test(contract.docId || '') || !Array.isArray(contract.providerNames)
    || !contract.sourceFingerprint) fail('THREADS_SOCIAL_PROFILE_PAGINATION_CONTRACT_UNVERIFIED');
  const preload = extractProfileTimelinePreload(html, username, PROFILE_ROUTE, contract.providerNames);
  const posts = new Map();
  const requestedCursors = new Set();
  const pageReceipts = [];
  let hasNextPage = false;
  let exhausted = false;
  let pageCapReached = false;
  let lastCursor = null;
  let pageCount = 0;

  while (pageCount < PROFILE_TIMELINE_MAX_PAGES) {
    const variables = pageCount === 0
      ? preload.variables
      : { ...preload.variables, after: lastCursor };
    if (pageCount > 0) {
      if (!lastCursor || requestedCursors.has(lastCursor)) fail('THREADS_SOCIAL_PROFILE_CURSOR_CYCLE');
      requestedCursors.add(lastCursor);
    }
    const request = buildProfileTimelineRequest(ctx, contract, variables, preload.routeName);
    const result = await querySender(ctx, request);
    const connection = extractProfileTimelineConnection(result?.payload);
    const pagePosts = collectProfileTimelinePosts(connection.edges, username);
    for (const post of pagePosts) {
      const previous = posts.get(post.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(post)) fail('THREADS_SOCIAL_PROFILE_POST_CONFLICT');
      posts.set(post.id, post);
    }
    pageCount += 1;
    pageReceipts.push({
      page: pageCount,
      operation: contract.operation,
      path: '/api/graphql',
      httpStatus: Number.isInteger(result?.receipt?.httpStatus) ? result.receipt.httpStatus : 200,
      bytes: Number.isSafeInteger(result?.receipt?.bytes) ? result.receipt.bytes : null,
      edgeCount: connection.edges.length,
      cursorFingerprint: connection.cursor ? sha256(connection.cursor).slice(0, 16) : null,
    });
    hasNextPage = connection.hasNextPage;
    lastCursor = connection.cursor;
    if (!hasNextPage) {
      exhausted = true;
      break;
    }
    if (posts.size >= limit) break;
    if (pageCount >= PROFILE_TIMELINE_MAX_PAGES) {
      pageCapReached = true;
      break;
    }
  }

  const observedPosts = [...posts.values()].sort((a, b) =>
    (b.publishedAt || '').localeCompare(a.publishedAt || '') || a.id.localeCompare(b.id));
  const returnedPosts = observedPosts.slice(0, limit);
  const truncatedByLimit = observedPosts.length > limit || hasNextPage && observedPosts.length >= limit;
  const fullTimeline = exhausted && !truncatedByLimit;
  const pinnedPosts = observedPosts.filter(post => post.isPinnedToProfile === true);
  const pinnedPostIds = pinnedPosts.map(post => post.id);
  const pinKnown = observedPosts.every(post => typeof post.isPinnedToProfile === 'boolean');
  const pinState = pinnedPostIds.length ? 'pinned_post_observed'
    : pinKnown ? fullTimeline ? 'no_pin_in_full_timeline' : 'no_pin_in_observed_window'
      : 'not_exposed';
  const stopReason = exhausted ? truncatedByLimit ? 'server_exhausted_but_output_limited' : 'server_exhausted'
    : pageCapReached ? 'request_page_cap'
      : truncatedByLimit ? 'requested_limit' : 'page_continuation_unresolved';
  return {
    handle: username,
    posts: returnedPosts,
    pinnedPosts,
    pinnedPostIds,
    pinState,
    coverage: fullTimeline ? 'complete_profile_threads_timeline' : 'bounded_profile_threads_timeline',
    fullTimeline,
    page: {
      requestedLimit: limit,
      observedUniquePosts: observedPosts.length,
      returnedPosts: returnedPosts.length,
      pageCount,
      hasNextPage,
      truncatedByLimit,
      requestPageCapReached: pageCapReached,
      stopReason,
      cursorFingerprint: lastCursor ? sha256(lastCursor).slice(0, 16) : null,
    },
    receipt: {
      operation: contract.operation,
      docId: contract.docId,
      method: 'POST',
      path: '/api/graphql',
      checkedAt: new Date().toISOString(),
      executionMode: 'pure_http',
      browserUsed: false,
      credentialProvider: 'windows_dpapi_current_user',
      credentialValuesRecorded: false,
      owner: ctx.bundle.owner,
      ownerVerified: true,
      credential_propagated: true,
      captured: false,
      captureSource: 'current_authenticated_profile_document_preload_and_first_party_pagination_callsite; browser_next_page_request_not_captured',
      client_exists: true,
      remnant_free: true,
      live_replay: true,
      targetIdVerifiedAgainstRoute: true,
      providerFieldCount: contract.providerNames.length,
      sourceFingerprint: contract.sourceFingerprint,
      pages: pageReceipts,
    },
  };
}

export const readThreadsPost = inspectThreadsPost;

export const THREADS_SOCIAL_CONTRACTS = Object.freeze({
  followers: FOLLOWERS_QUERY,
  feedbackHub: FEEDBACK_HUB_QUERY,
  post: THREADS_READBACK_CONTRACTS.target,
  comments: THREADS_READBACK_CONTRACTS.downward,
  commentsNextPage: THREADS_READBACK_CONTRACTS.directReplies,
});
