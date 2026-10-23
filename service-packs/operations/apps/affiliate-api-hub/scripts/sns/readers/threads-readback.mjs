import { createHash } from 'node:crypto';
import { openMetaContext, metaRequest, sendMetaQuery } from '../../../../social-actions/lib/meta-bootstrap.mjs';

const OWNER = 'lifehack__ailab';
const TARGET = Object.freeze({ operation: 'BarcelonaPostPageTargetQuery', docId: '28075442415461409' });
const DOWNWARD = Object.freeze({ operation: 'BarcelonaPostPageDownwardQuery', docId: '28129600913406640' });
const DIRECT_REPLIES = Object.freeze({ operation: 'BarcelonaPostPageDirectRepliesRefetchQuery', docId: '28263344770004423' });
const PROFILE_ROUTE = 'comet.threads.BarcelonaProfileThreadsColumnRoute';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const sha256 = text => createHash('sha256').update(text).digest('hex');

// Captured from the logged-in profile permalink flow on 2026-09-28. The two
// operations are read-only POSTs to /api/graphql with URL-encoded Relay forms.
const TARGET_FLAGS = Object.freeze({
  __relay_internal__pv__BarcelonaCanSeeSponsoredContentrelayprovider: false,
  __relay_internal__pv__BarcelonaGenAIRepliesEnabledrelayprovider: false,
  __relay_internal__pv__BarcelonaHasBestOfThreadsrelayprovider: false,
  __relay_internal__pv__BarcelonaHasCommunitiesrelayprovider: true,
  __relay_internal__pv__BarcelonaHasCommunityEmojiUpdateCardrelayprovider: true,
  __relay_internal__pv__BarcelonaHasCommunityEntityCardrelayprovider: true,
  __relay_internal__pv__BarcelonaHasCommunityPermalinkPivotsrelayprovider: false,
  __relay_internal__pv__BarcelonaHasCommunityTopContributorsrelayprovider: false,
  __relay_internal__pv__BarcelonaHasDearAlgoConsumptionrelayprovider: true,
  __relay_internal__pv__BarcelonaHasDearAlgoWebProductionrelayprovider: false,
  __relay_internal__pv__BarcelonaHasEventBadgerelayprovider: false,
  __relay_internal__pv__BarcelonaHasGameScoreSharerelayprovider: true,
  __relay_internal__pv__BarcelonaHasGhostPostEmojiActivationrelayprovider: false,
  __relay_internal__pv__BarcelonaHasInsightsPermalinkUFIrelayprovider: true,
  __relay_internal__pv__BarcelonaHasMessagingrelayprovider: true,
  __relay_internal__pv__BarcelonaHasMetaAiContentAttachmentsrelayprovider: false,
  __relay_internal__pv__BarcelonaHasMusicrelayprovider: true,
  __relay_internal__pv__BarcelonaHasNewspaperLinkStylerelayprovider: false,
  __relay_internal__pv__BarcelonaHasPodcastTranscriptConsumptionrelayprovider: true,
  __relay_internal__pv__BarcelonaHasPodcastV2Consumptionrelayprovider: true,
  __relay_internal__pv__BarcelonaHasPodcastV2Productionrelayprovider: false,
  __relay_internal__pv__BarcelonaHasPrivateRepliesDeprecationrelayprovider: true,
  __relay_internal__pv__BarcelonaHasPublicViewCountCardrelayprovider: true,
  __relay_internal__pv__BarcelonaHasScorecardCommunityrelayprovider: true,
  __relay_internal__pv__BarcelonaHasSportTeamAllegianceCardrelayprovider: true,
  __relay_internal__pv__BarcelonaHasViewerRepliedrelayprovider: true,
  __relay_internal__pv__BarcelonaHasWebFaviconsrelayprovider: false,
  __relay_internal__pv__BarcelonaIsCrawlerrelayprovider: false,
  __relay_internal__pv__BarcelonaIsInternalUserrelayprovider: false,
  __relay_internal__pv__BarcelonaIsLoggedInrelayprovider: true,
  __relay_internal__pv__BarcelonaIsSearchDiscoveryEnabledrelayprovider: false,
  __relay_internal__pv__BarcelonaMessagesHasLiveChatMessagingrelayprovider: false,
  __relay_internal__pv__BarcelonaMessagingHasMetaAIBotrelayprovider: false,
  __relay_internal__pv__BarcelonaOptionalCookiesEnabledrelayprovider: true,
  __relay_internal__pv__BarcelonaShouldFetchPostAuthorFullNamerelayprovider: false,
  __relay_internal__pv__BarcelonaShouldFulfillLightboxQueryrelayprovider: true,
  __relay_internal__pv__BarcelonaShouldShowFediverseM075Featuresrelayprovider: true,
  __relay_internal__pv__BarcelonaShouldShowFediverseM1Featuresrelayprovider: true,
});

const DOWNWARD_FLAGS = Object.freeze({
  __relay_internal__pv__BarcelonaCanSeeSponsoredContentrelayprovider: false,
  __relay_internal__pv__BarcelonaGenAIRepliesEnabledrelayprovider: false,
  __relay_internal__pv__BarcelonaHasBestOfThreadsrelayprovider: false,
  __relay_internal__pv__BarcelonaHasCommunitiesrelayprovider: true,
  __relay_internal__pv__BarcelonaHasCommunityEmojiUpdateCardrelayprovider: true,
  __relay_internal__pv__BarcelonaHasCommunityEntityCardrelayprovider: true,
  __relay_internal__pv__BarcelonaHasCommunityTopContributorsrelayprovider: false,
  __relay_internal__pv__BarcelonaHasDearAlgoConsumptionrelayprovider: true,
  __relay_internal__pv__BarcelonaHasDearAlgoWebProductionrelayprovider: false,
  __relay_internal__pv__BarcelonaHasEventBadgerelayprovider: false,
  __relay_internal__pv__BarcelonaHasGameScoreSharerelayprovider: true,
  __relay_internal__pv__BarcelonaHasGhostPostEmojiActivationrelayprovider: false,
  __relay_internal__pv__BarcelonaHasMessagingrelayprovider: true,
  __relay_internal__pv__BarcelonaHasMetaAiContentAttachmentsrelayprovider: false,
  __relay_internal__pv__BarcelonaHasMusicrelayprovider: true,
  __relay_internal__pv__BarcelonaHasNewspaperLinkStylerelayprovider: false,
  __relay_internal__pv__BarcelonaHasPermalinkIndentationrelayprovider: true,
  __relay_internal__pv__BarcelonaHasPodcastTranscriptConsumptionrelayprovider: true,
  __relay_internal__pv__BarcelonaHasPodcastV2Consumptionrelayprovider: true,
  __relay_internal__pv__BarcelonaHasPrivateRepliesDeprecationrelayprovider: true,
  __relay_internal__pv__BarcelonaHasPublicViewCountCardrelayprovider: true,
  __relay_internal__pv__BarcelonaHasScorecardCommunityrelayprovider: true,
  __relay_internal__pv__BarcelonaHasSportTeamAllegianceCardrelayprovider: true,
  __relay_internal__pv__BarcelonaHasViewerRepliedrelayprovider: true,
  __relay_internal__pv__BarcelonaHasWebFaviconsrelayprovider: false,
  __relay_internal__pv__BarcelonaIsCrawlerrelayprovider: false,
  __relay_internal__pv__BarcelonaIsInternalUserrelayprovider: false,
  __relay_internal__pv__BarcelonaIsLoggedInrelayprovider: true,
  __relay_internal__pv__BarcelonaIsSearchDiscoveryEnabledrelayprovider: false,
  __relay_internal__pv__BarcelonaMessagesHasLiveChatMessagingrelayprovider: false,
  __relay_internal__pv__BarcelonaMessagingHasMetaAIBotrelayprovider: false,
  __relay_internal__pv__BarcelonaOptionalCookiesEnabledrelayprovider: true,
  __relay_internal__pv__BarcelonaShouldFetchPostAuthorFullNamerelayprovider: false,
  __relay_internal__pv__BarcelonaShouldFulfillLightboxQueryrelayprovider: true,
  __relay_internal__pv__BarcelonaShouldShowFediverseM075Featuresrelayprovider: true,
});

const normalizeId = value => String(value ?? '').split('_')[0];

function validateId(value) {
  const id = String(value ?? '');
  if (!/^\d{10,25}$/.test(id)) fail('THREADS_READBACK_POST_ID_INVALID');
  return id;
}

function postSummary(node, expectedOwner = OWNER) {
  const id = normalizeId(node?.pk ?? node?.id);
  const owner = String(node?.user?.username ?? '').toLowerCase();
  const text = node?.caption?.text;
  const selfThread = node?.text_post_app_info?.self_thread_info;
  const position = Number(selfThread?.post_position_in_self_thread);
  const length = Number(selfThread?.self_thread_length);
  if (!/^\d{10,25}$/.test(id) || owner !== expectedOwner || typeof node?.code !== 'string'
    || typeof text !== 'string' || !selfThread || typeof selfThread.id !== 'string'
    || !Number.isInteger(position) || position < 1 || !Number.isInteger(length) || length < position) {
    fail('THREADS_READBACK_POST_SCHEMA');
  }
  return { id, code: node.code, owner, captionSha256: sha256(text), threadId: selfThread.id,
    position, threadLength: length, isReply: node?.text_post_app_info?.is_reply === true };
}

function parseTarget(payload, expectedId) {
  const media = payload?.data?.media;
  if (!media || normalizeId(media.pk ?? media.id) !== expectedId) fail('THREADS_READBACK_TARGET_MISMATCH');
  return postSummary(media);
}

function parseDownward(payload, parentId) {
  const media = payload?.data?.media;
  if (!media || normalizeId(media.id) !== parentId) fail('THREADS_READBACK_PARENT_MISMATCH');
  const edges = media.text_post_app_info?.self_thread?.posts?.edges;
  if (!Array.isArray(edges)) fail('THREADS_READBACK_CHILDREN_SCHEMA');
  const children = edges.map(edge => postSummary(edge?.node));
  const ids = children.map(item => item.id);
  if (new Set(ids).size !== ids.length) fail('THREADS_READBACK_DUPLICATE_CHILD');
  return children;
}

export function buildThreadsTargetVariables(postId) {
  return { ...TARGET_FLAGS, postID: validateId(postId) };
}

export function buildThreadsDownwardVariables(postId) {
  return { ...DOWNWARD_FLAGS, postID: validateId(postId), sortOrder: 'TOP' };
}

// Observed in the logged-in native permalink flow on 2026-10-02. Each next
// request uses the preceding direct_replies.page_info.end_cursor. These are
// public contract fields; the opaque cursor stays in memory only.
export function buildThreadsDirectRepliesVariables(postId, after) {
  if (typeof after !== 'string' || !after || after.length > 8192 || /[\x00-\x20\x7f]/.test(after)) {
    fail('THREADS_READBACK_CURSOR_INVALID');
  }
  return {
    ...DOWNWARD_FLAGS,
    __relay_internal__pv__BarcelonaShouldFetchPostAuthorFullNamerelayprovider: true,
    after, filterType: null, first: 4, postID: validateId(postId), sortOrder: 'TOP',
  };
}

export function parseThreadsReadbackPayloads(targetPayload, downwardPayload, postId) {
  const id = validateId(postId);
  const target = parseTarget(targetPayload, id);
  const children = parseDownward(downwardPayload, id);
  return { target, children, relation: { parentId: target.id, childIds: children.map(item => item.id) } };
}

export async function readThreadsPostsById(postIds, {
  context,
  contextLoader = openMetaContext,
  querySender = sendMetaQuery,
  owner = OWNER,
} = {}) {
  if (!Array.isArray(postIds) || postIds.length < 1 || postIds.length > 10
    || !/^[A-Za-z0-9_.]{1,30}$/.test(owner)) fail('THREADS_READBACK_INPUT_INVALID');
  const ids = postIds.map(validateId);
  if (new Set(ids).size !== ids.length) fail('THREADS_READBACK_DUPLICATE_TARGET');
  const ctx = context || await contextLoader('threads', owner);
  if (ctx?.service !== 'threads' || ctx.handle?.toLowerCase() !== owner.toLowerCase()
    || ctx.bundle?.service !== 'threads' || ctx.bundle.owner?.toLowerCase() !== owner.toLowerCase()
    || !/^\d{1,25}$/.test(String(ctx.bundle.ownerId || ''))) fail('THREADS_READBACK_OWNER_UNVERIFIED');

  const posts = new Map();
  const relations = [];
  const receipts = [];
  for (const id of ids) {
    const targetRequest = metaRequest(ctx, TARGET.operation, TARGET.docId, buildThreadsTargetVariables(id),
      { canonicalRouteName: PROFILE_ROUTE });
    const targetResult = await querySender(ctx, targetRequest);
    const target = parseTarget(targetResult?.payload, id);
    posts.set(target.id, target);
    receipts.push(targetResult.receipt);

    const downwardRequest = metaRequest(ctx, DOWNWARD.operation, DOWNWARD.docId, buildThreadsDownwardVariables(id),
      { canonicalRouteName: PROFILE_ROUTE });
    const downwardResult = await querySender(ctx, downwardRequest);
    const children = parseDownward(downwardResult?.payload, id);
    for (const child of children) {
      const existing = posts.get(child.id);
      if (existing && (existing.captionSha256 !== child.captionSha256 || existing.threadId !== child.threadId
        || existing.position !== child.position || existing.owner !== child.owner)) fail('THREADS_READBACK_CONFLICTING_POST');
      posts.set(child.id, child);
    }
    relations.push({ parentId: id, childIds: children.map(item => item.id) });
    receipts.push(downwardResult.receipt);
  }
  return { owner, ownerVerified: true, posts: [...posts.values()].sort((a, b) => a.position - b.position),
    relations, receipts: receipts.map(({ httpStatus, operation, path, bytes }) => ({ httpStatus, operation, path, bytes })),
    checkedAt: new Date().toISOString(), executionMode: 'pure_http', browserUsed: false,
    credentialProvider: 'windows_dpapi_current_user', credentialValuesRecorded: false, liveReplay: true };
}

export function verifyThreadsChainReadback(readback, expectedIds, expectedCaptions) {
  if (!Array.isArray(expectedIds) || expectedIds.length < 1 || !readback?.ownerVerified
    || readback.owner?.toLowerCase() !== OWNER || !Array.isArray(readback.posts)
    || !Array.isArray(readback.relations) || !Array.isArray(expectedCaptions)
    || expectedCaptions.length !== expectedIds.length
    || expectedCaptions.some(caption => typeof caption !== 'string')) {
    return { verified: false, reason: 'THREADS_READBACK_SCHEMA' };
  }
  const ids = expectedIds.map(validateId);
  const byId = new Map(readback.posts.map(post => [normalizeId(post.id), post]));
  const ordered = ids.map(id => byId.get(id));
  if (ordered.some(post => !post || post.owner !== OWNER || !post.threadId || !Number.isInteger(post.position))) {
    return { verified: false, reason: 'THREADS_READBACK_POST_MISSING' };
  }
  if (new Set(ordered.map(post => post.threadId)).size !== 1
    || ordered.some((post, index) => index > 0 && post.position !== ordered[index - 1].position + 1)) {
    return { verified: false, reason: 'THREADS_READBACK_CHAIN_ORDER_MISMATCH' };
  }
  if (ordered.some((post, index) => post.captionSha256 !== sha256(expectedCaptions[index]))) {
    return { verified: false, reason: 'THREADS_READBACK_CAPTION_MISMATCH' };
  }
  const relationMap = new Map(readback.relations.map(item => [normalizeId(item.parentId), item.childIds.map(normalizeId)]));
  for (let index = 0; index < ids.length - 1; index += 1) {
    if (!relationMap.get(ids[index])?.includes(ids[index + 1])) {
      return { verified: false, reason: 'THREADS_READBACK_REPLY_LINK_MISMATCH' };
    }
  }
  return { verified: true, postIds: ids, threadId: ordered[0].threadId,
    positions: ordered.map(post => post.position), captionSha256: ordered.map(post => post.captionSha256) };
}

export const THREADS_READBACK_CONTRACTS = Object.freeze({ target: TARGET, downward: DOWNWARD, directReplies: DIRECT_REPLIES });
