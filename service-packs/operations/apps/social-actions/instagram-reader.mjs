import {
  openMetaContext, relayDocId, metaRequest, sendMetaQuery, metaFail, withMetaSessionLock,
} from './lib/meta-bootstrap.mjs';

const PROFILE_FLAGS = Object.freeze({
  PolarisCannesGuardianExperienceEnabled: '6793',
  PolarisCASB976ProfileEnabled: '17028',
  PolarisWebSchoolsEnabled: '17363',
  PolarisRepostsConsumptionEnabled: '9448',
  PolarisShortDramaEnabled: '12774',
});
const POSTS_OPERATION = 'PolarisProfilePostsTabContentQuery_connection';
const PROFILE_OPERATION = 'PolarisProfilePageContentQuery';
const POST_PAGE_LIMIT = 12;

function normalizeHandle(input) {
  if (typeof input !== 'string' || input.length > 300) metaFail('INSTAGRAM_READ_INPUT');
  let handle = input.trim();
  if (handle.startsWith('https://')) {
    let url;
    try { url = new URL(handle); } catch { metaFail('INSTAGRAM_TARGET_SCOPE'); }
    if (url.origin !== 'https://www.instagram.com' || url.username || url.password || url.search || url.hash) {
      metaFail('INSTAGRAM_TARGET_SCOPE');
    }
    handle = url.pathname.replace(/^\/+|\/+$/g, '').replace(/^@/, '');
  } else handle = handle.replace(/^@/, '');
  if (!/^[A-Za-z0-9_.]{1,30}$/.test(handle)) metaFail('INSTAGRAM_TARGET_INVALID');
  return handle.toLowerCase();
}

function boolFlag(map, key, code = 'INSTAGRAM_FEATURE_FLAG_MISSING') {
  if (!map.has(key) || typeof map.get(key) !== 'boolean') metaFail(code);
  return map.get(key);
}

function profileVariables(context, id) {
  const variables = { id, enable_integrity_filters: true };
  for (const [flag, key] of Object.entries(PROFILE_FLAGS)) {
    const provider = context.sources.get(flag + '.relayprovider')?.source;
    if (!provider?.includes('"' + key + '"')) metaFail('INSTAGRAM_PROFILE_FLAG_CONTRACT_CHANGED');
    if (flag === 'PolarisShortDramaEnabled') {
      const qexProvider = context.sources.get('PolarisShortDramaEnabled.relayprovider')?.source || '';
      if (!qexProvider.includes('"1697"') || !qexProvider.includes('"3668"')) metaFail('INSTAGRAM_PROFILE_FLAG_CONTRACT_CHANGED');
      variables['__relay_internal__pv__' + flag + 'relayprovider'] = context.document.qex.get('1697') === true
        ? context.document.qex.get('3668') === true : boolFlag(context.document.gkx, key);
    } else {
      variables['__relay_internal__pv__' + flag + 'relayprovider'] = boolFlag(context.document.gkx, key);
    }
  }
  return variables;
}

function postsVariables(context, handle, limit, after) {
  const querySource = context.sources.get(POSTS_OPERATION + '.graphql')?.source || '';
  const multiCaptionSource = context.sources.get('PolarisMultiCaptionCarouselEnabled.relayprovider')?.source || '';
  const shortDramaSource = context.sources.get('PolarisShortDramaEnabled.relayprovider')?.source || '';
  const reelsDebugSource = context.sources.get('PolarisReelsRecoDebugOverlayEnabled.relayprovider')?.source || '';
  for (const field of ['after', 'before', 'data', 'first', 'last', 'username']) {
    if (!querySource.includes('name:"' + field + '"')) metaFail('INSTAGRAM_POSTS_CONTRACT_CHANGED');
  }
  if (!querySource.includes('xdt_api__v1__feed__user_timeline_graphql_connection')
    || !querySource.includes('xdt_viewer') || !multiCaptionSource.includes('"2404"')
    || !shortDramaSource.includes('"1697"') || !shortDramaSource.includes('"3668"')
    || !shortDramaSource.includes('"12774"') || !reelsDebugSource.includes('"684"')) {
    metaFail('INSTAGRAM_POSTS_CONTRACT_CHANGED');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > POST_PAGE_LIMIT) metaFail('INSTAGRAM_POST_LIMIT_INVALID');
  if (after != null && (typeof after !== 'string' || !after || after.length > 8192 || /[\x00-\x20\x7f]/.test(after))) {
    metaFail('INSTAGRAM_CURSOR_INVALID');
  }
  const multiCaption = boolFlag(context.document.qex, '2404');
  const shortDrama = context.document.qex.get('1697') === true
    ? context.document.qex.get('3668') === true : boolFlag(context.document.gkx, '12774');
  const reelsDebug = boolFlag(context.document.gkx, '684');
  return {
    after: after ?? null, before: null, data: {}, first: limit,
    include_multi_captions: multiCaption, last: null, username: handle,
    __relay_internal__pv__PolarisMultiCaptionCarouselEnabledrelayprovider: multiCaption,
    __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: shortDrama,
    __relay_internal__pv__PolarisReelsRecoDebugOverlayEnabledrelayprovider: reelsDebug,
  };
}

function integerOrNull(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function postUrl(code, productType) {
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(code)) metaFail('INSTAGRAM_POST_SCHEMA_INVALID');
  const path = /clip|reel/i.test(String(productType || '')) ? 'reel' : 'p';
  return `https://www.instagram.com/${path}/${code}/`;
}

function normalizePost(edge, handle, targetId) {
  const node = edge?.node;
  if (!node || typeof node !== 'object') metaFail('INSTAGRAM_POST_SCHEMA_INVALID');
  const owner = node.user?.username;
  const ownerId = String(node.user?.pk ?? node.user?.id ?? '');
  if (typeof owner !== 'string' || owner.toLowerCase() !== handle || ownerId !== targetId) {
    metaFail('INSTAGRAM_POST_OWNER_MISMATCH');
  }
  const code = node.code;
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(code)) metaFail('INSTAGRAM_POST_SCHEMA_INVALID');
  const timestamp = integerOrNull(node.taken_at);
  return {
    id: String(node.pk ?? node.id ?? ''),
    shortcode: code,
    url: postUrl(code, node.product_type),
    username: handle,
    caption: typeof node.caption?.text === 'string' ? node.caption.text : '',
    publishedAt: timestamp == null ? null : new Date(timestamp * 1000).toISOString(),
    mediaType: integerOrNull(node.media_type),
    productType: typeof node.product_type === 'string' ? node.product_type : null,
    likeCount: integerOrNull(node.like_count),
    commentCount: integerOrNull(node.comment_count),
    viewCount: integerOrNull(node.view_count),
    carouselCount: Array.isArray(node.carousel_media) ? node.carousel_media.length : 0,
  };
}

async function readProfile(context, handle) {
  const routeId = String(context.document.route?.rootView?.props?.id || '');
  if (!/^\d{1,30}$/.test(routeId)) metaFail('INSTAGRAM_PROFILE_TARGET_MISSING');
  const variables = profileVariables(context, routeId);
  const docId = relayDocId(context, PROFILE_OPERATION);
  const result = await sendMetaQuery(context, metaRequest(context, PROFILE_OPERATION, docId, variables));
  const user = result.payload.data?.user;
  if (user?.username?.toLowerCase() !== handle || String(user.id ?? user.pk ?? '') !== routeId) {
    metaFail('INSTAGRAM_PROFILE_TARGET_MISMATCH');
  }
  const profile = {
    id: routeId,
    username: handle,
    fullName: typeof user.full_name === 'string' ? user.full_name : '',
    biography: typeof user.biography === 'string' ? user.biography : '',
    profilePictureUrl: typeof user.profile_pic_url === 'string' ? user.profile_pic_url : null,
    private: user.is_private === true,
    verified: user.is_verified === true,
    followerCount: integerOrNull(user.follower_count),
    followingCount: integerOrNull(user.following_count),
    postCount: integerOrNull(user.media_count),
    externalUrl: typeof user.external_url === 'string' ? user.external_url : null,
  };
  return { profile, docId, sourceSha256: context.sources.get(PROFILE_OPERATION + '.graphql')?.sha256 || null, receipt: result.receipt };
}

async function withProfile(handleInput, operation) {
  const handle = normalizeHandle(handleInput);
  return withMetaSessionLock('instagram', async () => {
    const context = await openMetaContext('instagram', handle);
    return operation(context, handle);
  });
}

export async function readInstagramProfile({ handle, target } = {}) {
  return withProfile(handle ?? target, async (context, normalizedHandle) => {
    const result = await readProfile(context, normalizedHandle);
    return {
      service: 'instagram', operation: 'profile', profile: result.profile,
      receipt: { ...result.receipt, live_replay: true, captured: false, client_exists: true,
        credential_propagated: true, remnant_free: true, sourceSha256: result.sourceSha256,
        evidence: 'current_first_party_relay_module_and_direct_http_replay' },
    };
  });
}

export async function readInstagramPosts({ handle, target, limit = POST_PAGE_LIMIT, after = null } = {}) {
  return withProfile(handle ?? target, async (context, normalizedHandle) => {
    const targetId = String(context.document.route?.rootView?.props?.id || '');
    if (!/^\d{1,30}$/.test(targetId)) metaFail('INSTAGRAM_PROFILE_TARGET_MISSING');
    const querySource = context.sources.get(POSTS_OPERATION + '.graphql')?.source;
    if (!querySource) metaFail('INSTAGRAM_POSTS_SOURCE_MISSING');
    const docId = relayDocId(context, POSTS_OPERATION);
    const variables = postsVariables(context, normalizedHandle, limit, after);
    const result = await sendMetaQuery(context, metaRequest(context, POSTS_OPERATION, docId, variables));
    const viewerId = String(result.payload.data?.xdt_viewer?.user?.id ?? '');
    const savedViewerId = context.bundle.cookies.find(cookie => cookie.name === 'ds_user_id')?.value;
    if (!savedViewerId || viewerId !== savedViewerId) metaFail('INSTAGRAM_POSTS_VIEWER_MISMATCH');
    const connection = result.payload.data?.xdt_api__v1__feed__user_timeline_graphql_connection;
    const edges = connection?.edges;
    const pageInfo = connection?.page_info;
    if (!Array.isArray(edges) || edges.length > limit || !pageInfo
      || typeof pageInfo.has_next_page !== 'boolean' || typeof pageInfo.has_previous_page !== 'boolean'
      || (pageInfo.end_cursor != null && typeof pageInfo.end_cursor !== 'string')) metaFail('INSTAGRAM_POSTS_SCHEMA_INVALID');
    const posts = edges.map(edge => normalizePost(edge, normalizedHandle, targetId));
    return {
      service: 'instagram', operation: 'posts', username: normalizedHandle, posts,
      pagination: { requested: limit, returned: posts.length, hasNextPage: pageInfo.has_next_page,
        hasPreviousPage: pageInfo.has_previous_page, nextCursor: pageInfo.end_cursor || null },
      receipt: { ...result.receipt, live_replay: true, captured: false, client_exists: true,
        credential_propagated: true, remnant_free: true, sourceSha256: querySource.sha256,
        docId, evidence: 'current_first_party_relay_module_and_direct_http_replay', targetOwnerMatched: true,
        returnedCount: posts.length, requestedCount: limit },
    };
  });
}

export const instagramReadCapabilities = Object.freeze(['profile', 'posts']);
