import fs from 'node:fs';
import { SOCIAL_REQUEST_TIMEOUTS } from './lib/request-timeouts.mjs';
import { openMetaContext, metaRequest, sendMetaQuery, withMetaSessionLock, metaFail } from './lib/meta-bootstrap.mjs';
import { readThreadsSharedCooldown, THREADS_GRAPHQL_THROTTLED } from './lib/threads-graphql-throttle.mjs';

const CONTRACT = JSON.parse(fs.readFileSync(new URL('./contracts/threads-insights.json', import.meta.url), 'utf8'));
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const numericId = value => typeof value === 'string' && /^\d{1,30}$/.test(value);
const shortcode = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const safeInsightUrl = value => {
  let url; try { url = new URL(value); } catch { metaFail('THREADS_INSIGHTS_SCHEMA'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) metaFail('THREADS_INSIGHTS_SCHEMA');
  url.search = ''; url.hash = '';
  return url.href;
};

// CDN image URLs may carry temporary signatures. Keep them out of analytics
// output, while preserving actual nulls and the provider's availability status.
export function cleanThreadsInsightData(value, depth = 0) {
  if (depth > 30) metaFail('THREADS_INSIGHTS_SCHEMA');
  if (Array.isArray(value)) return value.map(item => cleanThreadsInsightData(item, depth + 1));
  if (isObject(value)) return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/(?:token|secret|authorization|cookie|signature)/i.test(key)
      && !/^(?:community_favicon_url|image_url|favicon_url)$/.test(key))
    .map(([key, item]) => [key, cleanThreadsInsightData(item, depth + 1)]));
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) return safeInsightUrl(value);
  return value;
}

export function threadsInsightDateRange({ startDate, endDate } = {}) {
  const valid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value + 'T00:00:00Z'))
    && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
  if (!valid(startDate) || !valid(endDate)) metaFail('THREADS_INSIGHTS_DATE_INPUT');
  const days = (Date.parse(endDate) - Date.parse(startDate)) / 86_400_000;
  if (days < 0 || days > 90) metaFail('THREADS_INSIGHTS_DATE_INPUT');
  return { startDate, endDate };
}

export function buildThreadsInsightVariables(operation, range, postId) {
  const dates = threadsInsightDateRange(range);
  if (['summary', 'audience'].includes(operation)) return { ...dates, timeZoneID: 'ASIA_SEOUL' };
  if (operation === 'links') return { ...dates, timeZoneName: 'Asia/Seoul' };
  if (operation === 'aiSummary') return { ...dates, timeZone: 'Asia/Seoul' };
  if (operation === 'posts') return { ...dates, first: 10, orderedBy: 'DATE', postType: 'TOP_LEVEL', timeZoneName: 'Asia/Seoul',
    __relay_internal__pv__BarcelonaHasInsightsV2M2relayprovider: false,
    __relay_internal__pv__BarcelonaIsInternalUserrelayprovider: false,
    __relay_internal__pv__BarcelonaOptionalCookiesEnabledrelayprovider: true };
  if (!numericId(postId)) metaFail('THREADS_INSIGHTS_POST_INPUT');
  if (operation === 'postRates') return { postID: postId };
  if (operation === 'post') return { ...dates, mediaID: postId, postID: postId, timeZoneID: 'ASIA_SEOUL',
    __relay_internal__pv__BarcelonaCanSeeSponsoredContentrelayprovider: false,
    __relay_internal__pv__BarcelonaIsLoggedInrelayprovider: true,
    __relay_internal__pv__BarcelonaMessagesHasLiveChatMessagingrelayprovider: false,
    __relay_internal__pv__BarcelonaHasEventBadgerelayprovider: false,
    __relay_internal__pv__BarcelonaHasWebFaviconsrelayprovider: false,
    __relay_internal__pv__BarcelonaIsCrawlerrelayprovider: false,
    __relay_internal__pv__BarcelonaHasCommunityTopContributorsrelayprovider: false };
  metaFail('THREADS_INSIGHTS_OPERATION');
}

export function decodeThreadsInsightResponse(operation, payload, { owner = CONTRACT.owner, postId, code } = {}) {
  const data = payload?.data;
  if (!isObject(data) || payload.errors?.length || payload.error) metaFail('THREADS_INSIGHTS_SCHEMA');
  if (['summary', 'audience'].includes(operation)) {
    const insights = data.xigTextAppViewer?.text_app_account_insights;
    if (!isObject(insights) || typeof insights.status !== 'string') metaFail('THREADS_INSIGHTS_SCHEMA');
    if (insights.data === null && insights.status.startsWith('UNAVAILABLE_')) return { status: insights.status, available: false, data: null };
    if (!isObject(insights.data)) metaFail('THREADS_INSIGHTS_SCHEMA');
    if (!isObject(insights.data.engagement_summary)) metaFail('THREADS_INSIGHTS_SCHEMA');
    return cleanThreadsInsightData(insights);
  }
  if (operation === 'aiSummary') {
    if (!Object.hasOwn(data, 'xth_insights_ai_summary')) metaFail('THREADS_INSIGHTS_SCHEMA');
    return { available: data.xth_insights_ai_summary != null, summary: cleanThreadsInsightData(data.xth_insights_ai_summary) };
  }
  if (operation === 'links') {
    const edges = data.xdtTextAppViewer?.contentInsights?.links?.edges;
    if (!Array.isArray(edges)) metaFail('THREADS_INSIGHTS_SCHEMA');
    return edges.map(({ node }) => {
      if (!/^\d+$/.test(node?.click_count || '') || !numericId(node?.link?.id) || typeof node?.link?.raw_url !== 'string') metaFail('THREADS_INSIGHTS_SCHEMA');
      let url; try { url = new URL(node.link.raw_url); } catch { metaFail('THREADS_INSIGHTS_SCHEMA'); }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) metaFail('THREADS_INSIGHTS_SCHEMA');
      const clicks = Number(node.click_count);
      if (count(clicks) == null) metaFail('THREADS_INSIGHTS_SCHEMA');
      return { id: node.link.id, url: safeInsightUrl(node.link.raw_url), clicks, title: node.link.link_preview?.title ?? null };
    });
  }
  if (operation === 'posts') {
    const connection = data.viewer?.content_insights?.posts;
    if (!Array.isArray(connection?.edges) || typeof connection?.page_info?.has_next_page !== 'boolean') metaFail('THREADS_INSIGHTS_SCHEMA');
    const posts = connection.edges.map(({ node }) => {
      const post = node?.post;
      if (!numericId(post?.pk) || !shortcode(post?.code) || post?.user?.username?.toLowerCase() !== owner.toLowerCase()) metaFail('THREADS_INSIGHTS_OWNER_MISMATCH');
      return { id: post.pk, code: post.code, owner: post.user.username,
        url: `https://www.threads.com/@${owner}/post/${post.code}`,
        impressions: count(post.text_post_app_info?.impression_count), likes: count(post.like_count),
        replies: count(post.text_post_app_info?.direct_reply_count), reposts: count(post.text_post_app_info?.repost_count),
        quotes: count(post.text_post_app_info?.quote_count), mediaType: post.media_type ?? null };
    });
    const nextCursor = connection.page_info.end_cursor;
    if (connection.page_info.has_next_page && (typeof nextCursor !== 'string' || !nextCursor || nextCursor.length > 8192)) metaFail('THREADS_INSIGHTS_SCHEMA');
    return { posts, hasNextPage: connection.page_info.has_next_page, nextCursor: nextCursor ?? null,
      fullInventory: false, paginationSupported: false, stopReason: 'captured_first_page_only' };
  }
  const media = data.media;
  if (!numericId(postId) || media?.id !== postId + '_' + CONTRACT.ownerId) metaFail('THREADS_INSIGHTS_POST_IDENTITY');
  if (operation === 'post') {
    if (media.pk !== postId || media.user?.username?.toLowerCase() !== owner.toLowerCase() || media.code !== code) metaFail('THREADS_INSIGHTS_OWNER_MISMATCH');
    if (!isObject(data.mediaInsights) && data.mediaInsights !== null) metaFail('THREADS_INSIGHTS_SCHEMA');
  } else if (operation !== 'postRates') metaFail('THREADS_INSIGHTS_OPERATION');
  const insights = media.text_post_app_info?.post_insights;
  if (!isObject(insights) && insights !== null) metaFail('THREADS_INSIGHTS_SCHEMA');
  // The captured rates response exposes only this composite ID, without user,
  // pk or shortcode. Owner-list provenance plus that exact ID is the gate.
  return { id: postId, code, available: insights != null, metrics: cleanThreadsInsightData(insights),
    ...(operation === 'post' ? { breakdowns: cleanThreadsInsightData(data.mediaInsights) } : {}) };
}

export async function createThreadsInsightsClient({ startDate, endDate, fetchImpl = globalThis.fetch,
  openContext = openMetaContext, sendQuery = sendMetaQuery, readCooldown = readThreadsSharedCooldown } = {}) {
  const range = threadsInsightDateRange({ startDate, endDate });
  const cooldownGate = async () => {
    const state = await readCooldown();
    if (state?.rateLimited === true && state.retryAt > Date.now()) throw Object.assign(new Error(state.code || THREADS_GRAPHQL_THROTTLED), {
      code:state.code || THREADS_GRAPHQL_THROTTLED, httpStatus:state.httpStatus ?? 200,
      retryAt:state.retryAt, rateLimited:true, cooldownReason:state.cooldownReason, deadlineSource:state.deadlineSource,
      dispatchStarted:false, writeSent:false });
  };
  await cooldownGate();
  let context;
  const open = async () => {
    context = await openContext('threads', CONTRACT.owner, { fetchImpl });
    if (context.service !== 'threads' || context.bundle.owner !== CONTRACT.owner || context.bundle.ownerId !== CONTRACT.ownerId) metaFail('THREADS_INSIGHTS_OWNER_MISMATCH');
  };
  await open();
  const directRuntime = openContext === openMetaContext && sendQuery === sendMetaQuery && fetchImpl === globalThis.fetch;
  const ownedPosts = new Map();
  async function query(operation, post) {
    return withMetaSessionLock('threads', async () => {
      await cooldownGate();
      const contract = CONTRACT.operations[operation];
      if (!contract) metaFail('THREADS_INSIGHTS_OPERATION');
      if (['post', 'postRates'].includes(operation) && ownedPosts.get(post?.id)?.code !== post?.code) metaFail('THREADS_INSIGHTS_POST_NOT_OBSERVED');
      if (Date.now() - context.createdAt > 120_000) await open();
      const variables = buildThreadsInsightVariables(operation, range, post?.id);
      const request = metaRequest(context, contract.name, contract.docId, variables, { graphPath: contract.path });
      // Use the shared bounded read deadline; a read timeout never dispatches
      // another query or changes authentication freshness in this client.
      request.signal = AbortSignal.timeout(SOCIAL_REQUEST_TIMEOUTS.read);
      let response;
      try { response = await sendQuery(context, request); }
      catch (error) {
        if (typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)) throw error;
        throw Object.assign(new Error('THREADS_INSIGHTS_READ_FAILED'), {
          code: error.name === 'TimeoutError' || error.name === 'AbortError' ? 'THREADS_INSIGHTS_READ_TIMEOUT' : 'THREADS_INSIGHTS_READ_FAILED', operation });
      }
      const { payload, receipt } = response;
      const data = decodeThreadsInsightResponse(operation, payload, { owner: context.bundle.owner, postId: post?.id, code: post?.code });
      if (operation === 'posts') data.posts.forEach(item => ownedPosts.set(item.id, item));
      return { service: 'threads', operation, owner: context.bundle.owner, range, data,
        receipt: { ...receipt, captured: true, client_exists: true, remnant_free: true, credential_propagated: directRuntime,
          live_replay: directRuntime, executionMode: directRuntime ? 'pure_http' : 'injected_transport', freshOwnerRead: context.documentReceipt,
          contractObservedAt: CONTRACT.observedAt, responseRoot: contract.responseRoot, socialWrites: 0 } };
    });
  }
  return { read: query, range, owner: CONTRACT.owner };
}
