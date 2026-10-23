import { metaRequest, sendMetaQuery, boundedText, rotateMetaCookiesWithRetry } from './lib/meta-bootstrap.mjs';
import { metaCookieHeader } from '../naver-blog-api/scripts/meta-auth-session.mjs';
const fail = (code, fields = {}) => { throw Object.assign(new Error(code), { code, ...fields }); };
const READ_RECEIPT = Symbol('threads-preview-read');
const names = ['BarcelonaHasBestOfThreads','BarcelonaIsSearchDiscoveryEnabled','BarcelonaHasCommunities','BarcelonaHasGameScoreShare','BarcelonaMessagesHasLiveChatMessaging','BarcelonaHasPublicViewCountCard','BarcelonaHasCommunityEmojiUpdateCard','BarcelonaHasCommunityEntityCard','BarcelonaHasScorecardCommunity','BarcelonaHasSportTeamAllegianceCard','BarcelonaHasMusic','BarcelonaHasNewspaperLinkStyle','BarcelonaHasMessaging','BarcelonaHasPodcastV2Consumption','BarcelonaHasPodcastTranscriptConsumption','BarcelonaOptionalCookiesEnabled','BarcelonaShouldFulfillLightboxQuery','BarcelonaShouldFetchPostAuthorFullName','BarcelonaCanSeeSponsoredContent','BarcelonaIsLoggedIn','BarcelonaHasEventBadge','BarcelonaHasWebFavicons','BarcelonaIsCrawler','BarcelonaHasDearAlgoConsumption','BarcelonaHasDearAlgoWebProduction','BarcelonaHasCommunityTopContributors','BarcelonaHasViewerReplied','BarcelonaHasPrivateRepliesDeprecation','BarcelonaHasGhostPostEmojiActivation'];
const flags = [false,false,true,true,false,true,true,true,true,true,true,false,true,true,true,true,true,false,false,true,false,false,false,true,false,false,true,true,false];
export const THREADS_REPLY_PREVIEW_FLAGS = Object.freeze(Object.fromEntries(names.map((name,i) => ['__relay_internal__pv__'+name+'relayprovider',flags[i]])));

export function threadsReplyLink(message) {
  const urls = message.match(/https?:\/\/[^\s]+/g) || [];
  if (!urls.length) return null;
  if (urls.length !== 1) fail('THREADS_REPLY_LINK_COUNT_UNSUPPORTED');
  const match = urls[0].match(/^https:\/\/www\.threads\.com\/@([A-Za-z0-9_.]{1,30})\/post\/([A-Za-z0-9_-]{5,30})\/?$/);
  if (!match) fail('THREADS_REPLY_LINK_SCOPE_UNSUPPORTED');
  return { url: urls[0], author: match[1], code: match[2] };
}

async function readPreview(context, operation, docId, variables, referer) {
  const request = metaRequest(context, operation, docId, variables,
    { canonicalRouteName: 'comet.threads.BarcelonaPostColumnRoute', graphPath: '/graphql/query' });
  request.headers.referer = referer;
  // All three composer reads share the same owner/GraphQL cooldown and error
  // classification as timeline and eligibility reads. Do not dispatch an
  // alternate GraphQL path while the shared deadline is active.
  const { payload, receipt } = await sendMetaQuery(context, request);
  let data = payload?.data?.data, dataPath = 'data.data';
  if (operation === 'BarcelonaComposerQuotedPostPreviewQuery') {
    const candidates = [[payload?.data, 'data'], [payload?.data?.data, 'data.data']]
      .filter(([value]) => value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'quotePost'));
    if (candidates.length !== 1) fail('THREADS_REPLY_PREVIEW_REJECTED', { previewOperation: operation, previewDataShape: 'unexpected_quote' });
    [data, dataPath] = candidates[0];
  }
  if (payload?.status !== 'ok' || payload?.errors?.length || !data || typeof data !== 'object' || Array.isArray(data)) {
    fail('THREADS_REPLY_PREVIEW_REJECTED', { previewOperation: operation, previewDataShape: dataPath });
  }
  Object.defineProperty(data, READ_RECEIPT, { value: { operation, docId, httpStatus: receipt.httpStatus,
    status: 'ok', dataPath } });
  return data;
}

export async function prepareThreadsReplyLink(message, { context, parentUrl, query = readPreview } = {}) {
  const link = threadsReplyLink(message);
  if (!link) return { caption: message, quotedPostId: null, sourceUrl: null };
  if (context?.service !== 'threads' || context.bundle?.owner !== 'lifehack__ailab'
    || context.bundle?.origin !== 'https://www.threads.com' || context.documentReceipt?.ownerVerified !== true) fail('THREADS_REPLY_PREVIEW_OWNER_UNVERIFIED');
  let referer = link.url;
  if (parentUrl) {
    const url = new URL(parentUrl);
    if (url.origin !== context.bundle.origin || url.username || url.password || url.search || url.hash
      || !/^\/@[A-Za-z0-9_.]{1,30}\/post\/[A-Za-z0-9_-]{5,30}$/.test(url.pathname)) fail('THREADS_REPLY_PARENT_URL_INVALID');
    referer = url.href;
  }
  const allowed = await query(context, 'BarcelonaLexicalAutoLinkPluginQuery', '28978145841778573', { url: link.url }, referer);
  if (!Object.hasOwn(allowed, 'link_attachment_disallowed_reason') || allowed.link_attachment_disallowed_reason !== null) fail('THREADS_REPLY_LINK_NOT_ALLOWED');
  const result = await query(context, 'BarcelonaComposerLinkPreviewQuery', '28155759017429741', {
    url: link.url, includeNewspaperStyle: false, includeGroupInviteLink: true, includeLiveChatLinkInfo: false,
    ...THREADS_REPLY_PREVIEW_FLAGS,
  }, referer);
  const id = String(result.media?.pk ?? '');
  if (result.link_type !== 'quote' || !/^\d{10,25}$/.test(id) || result.media?.code !== link.code
    || result.media?.user?.username?.toLowerCase() !== link.author.toLowerCase()) fail('THREADS_REPLY_PREVIEW_IDENTITY_MISMATCH');
  // Native composer performs this final quote-card read after converting the
  // URL. Await its identity proof before any configure request.
  const quote = await query(context, 'BarcelonaComposerQuotedPostPreviewQuery', '28386886824295530', {
    postID: id, ...THREADS_REPLY_PREVIEW_FLAGS,
  }, referer);
  if (String(quote.quotePost?.pk ?? '') !== id || quote.quotePost?.code !== link.code
    || quote.quotePost?.user?.username?.toLowerCase() !== link.author.toLowerCase()) {
    fail('THREADS_REPLY_QUOTE_PREVIEW_IDENTITY_MISMATCH');
  }
  const caption = message.replace(link.url, '');
  if (!caption.trim()) fail('THREADS_REPLY_QUOTE_CAPTION_EMPTY');
  return { caption, quotedPostId: id, sourceUrl: link.url,
    quoteRead: { ...(quote[READ_RECEIPT] || {}), identityVerified: true, postId: id } };
}

export async function readThreadsQuotedReplyParent({ created, parentId, context }) {
  if (typeof context?.fetchImpl !== 'function') return false;
  const url = new URL(created.url);
  if (url.origin !== 'https://www.threads.com' || url.search || url.hash
    || !/^\/@lifehack__ailab\/post\/[A-Za-z0-9_-]{5,30}$/.test(url.pathname)
    || context.bundle?.owner !== 'lifehack__ailab' || context.documentReceipt?.ownerVerified !== true) fail('THREADS_REPLY_PARENT_DOCUMENT_SCOPE');
  const response = await context.fetchImpl(url.href, { headers: { accept: 'text/html', cookie: metaCookieHeader(context.bundle, url.href) },
    redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  await rotateMetaCookiesWithRetry(context.bundle, response);
  if (response.status !== 200) fail('THREADS_REPLY_PARENT_DOCUMENT_HTTP_' + response.status);
  if (!/^text\/html(?:;|$)/i.test(response.headers.get('content-type') || '')) fail('THREADS_REPLY_PARENT_DOCUMENT_MIME');
  const html = await boundedText(response);
  const matches = []; let nodes = 0;
  const walk = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 65) return;
    if (++nodes > 200_000) fail('THREADS_REPLY_PARENT_DOCUMENT_COMPLEXITY');
    if (String(value.pk) === created.id && value.text_post_app_info?.containing_thread) matches.push(value);
    for (const child of Object.values(value)) walk(child, depth + 1);
  };
  for (const match of html.matchAll(/<script\b[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) {
    let value; try { value = JSON.parse(match[1]); } catch { continue; } walk(value);
  }
  if (matches.length !== 1) return false;
  const thread = matches[0].text_post_app_info.containing_thread;
  const posts = thread.posts?.edges, ids = thread.post_ids?.edges;
  // Observed new reply document: exactly one ancestor in both independent
  // edge lists. Do not infer an immediate parent from a longer ancestry list.
  return Array.isArray(posts) && Array.isArray(ids) && posts.length === 1 && ids.length === 1
    && String(posts[0]?.node?.pk) === parentId && String(ids[0]?.node?.pk) === parentId;
}
