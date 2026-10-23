import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { loadXSession, storeXSession } from '../../scripts/session-vault.mjs';
import { loadWebAuth } from '../../../affiliate-api-hub/adapters/web-auth-provider.mjs';
import { SOCIAL_REQUEST_TIMEOUTS } from '../../../social-actions/lib/request-timeouts.mjs';

const hash = s => createHash('sha256').update(s).digest('hex');
const validHandle = h => typeof h === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(h);
const count = x => (typeof x === 'number' || typeof x === 'string') && /^\d+$/.test(String(x)) && Number.isSafeInteger(Number(x)) ? Number(x) : null;
export class XApiError extends Error {
  constructor(code, receipt = {}) { super(code); this.code = code; this.receipt = receipt; }
}
const isReadTimeout = error => error?.name === 'TimeoutError' || error?.code === 'ETIMEDOUT'
  || error?.cause?.code === 'ETIMEDOUT';
async function readFetch(fetchImpl, url, init) {
  try { return await fetchImpl(url, init); }
  catch (error) {
    if (!isReadTimeout(error)) throw error;
    throw new XApiError('X_READ_TIMEOUT', { method: 'GET', path: new URL(url).pathname, writeSent: false });
  }
}
// Post format as a writing reference (added 2026-09-27; the collector used to keep only text and counts): media,
// link card, long-form note with rich text, links/hashtags/mentions, own-thread continuation, line rhythm.
const EMOJI = /[☀-➿\u{1F000}-\u{1FAFF}]/gu;
export function decodeXMedia(legacy) {
  const media = legacy?.extended_entities?.media ?? legacy?.entities?.media ?? [];
  if (!Array.isArray(media)) throw new XApiError('X_MEDIA_SCHEMA');
  const cdnUrl = value => {
    if (typeof value !== 'string') return null;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.port
        && ['pbs.twimg.com', 'video.twimg.com'].includes(url.hostname) ? url.href : null;
    } catch { return null; }
  };
  return media.filter(item => item && ['photo', 'video', 'animated_gif'].includes(item.type)).map(item => ({
    id: /^\d{1,25}$/.test(item.id_str || '') ? item.id_str : null,
    type: item.type, url: cdnUrl(item.media_url_https),
    width: count(item.original_info?.width), height: count(item.original_info?.height),
    altText: typeof item.ext_alt_text === 'string' ? item.ext_alt_text.slice(0, 10000) : null,
    durationMs: count(item.video_info?.duration_millis),
    aspectRatio: Array.isArray(item.video_info?.aspect_ratio) && item.video_info.aspect_ratio.length === 2
      && item.video_info.aspect_ratio.every(n => Number.isSafeInteger(n) && n > 0) ? [...item.video_info.aspect_ratio] : null,
    variants: (Array.isArray(item.video_info?.variants) ? item.video_info.variants : [])
      .filter(variant => cdnUrl(variant?.url) && ['video/mp4', 'application/x-mpegURL', 'application/vnd.apple.mpegurl'].includes(variant.content_type))
      .map(variant => ({ url: cdnUrl(variant.url), contentType: variant.content_type, bitrate: count(variant.bitrate) })),
  }));
}

export function xFormat(tweet, legacy, text, author) {
  const media = legacy.extended_entities?.media ?? legacy.entities?.media ?? [];
  const entities = legacy.entities ?? {};
  const note = tweet.note_tweet?.note_tweet_results?.result;
  const lines = String(text).split('\n');
  return {
    photos: media.filter(m => m.type === 'photo').length, videos: media.filter(m => m.type === 'video' || m.type === 'animated_gif').length,
    linkCard: Boolean(tweet.card), links: (entities.urls ?? []).length, hashtags: (entities.hashtags ?? []).map(h => h.text).slice(0, 10),
    mentions: (entities.user_mentions ?? []).length, longForm: Boolean(note), richText: Boolean(note?.richtext?.richtext_tags?.length),
    quote: legacy.is_quote_status === true,
    ownThread: Boolean(legacy.in_reply_to_screen_name && author && legacy.in_reply_to_screen_name.toLowerCase() === author.toLowerCase()),
    lang: legacy.lang ?? null, chars: String(text).length, lines: lines.length, blankLines: lines.filter(l => !l.trim()).length,
    emoji: (String(text).match(EMOJI) ?? []).length,
  };
}

export function decodeXTimeline(instructions, handle) {
  if (!validHandle(handle) || !Array.isArray(instructions)) throw new XApiError('X_TIMELINE_SCHEMA');
  const items = new Map(), timelineEntries = []; let nextCursor = null, invalidCursor = false;
  function item(content) {
    if (!content || content.promotedMetadata) return null;
    const value = content.itemContent || content;
    if (value.promotedMetadata) return null;
    if (value.cursorType === 'Bottom') {
      if (typeof value.value !== 'string' || value.value.length < 1 || value.value.length > 4096) invalidCursor = true;
      else {
        if (nextCursor != null && nextCursor !== value.value) invalidCursor = true;
        nextCursor = value.value;
      }
      return { cursor: true, ownerItem: false, row: null };
    }
    const outer = value.tweet_results?.result;
    const tweet = outer?.__typename === 'TweetWithVisibilityResults' ? outer.tweet : outer;
    if (!tweet || tweet.__typename !== 'Tweet') return null;
    const user = tweet.core?.user_results?.result;
    const author = user?.core?.screen_name ?? user?.legacy?.screen_name;
    const legacy = tweet.legacy;
    if (author?.toLowerCase() !== handle.toLowerCase() || legacy?.retweeted_status_result) return null;
    const text = tweet.note_tweet?.note_tweet_results?.result?.text ?? legacy?.full_text;
    const date = Date.parse(legacy?.created_at);
    const publisherId = user?.rest_id ?? user?.legacy?.id_str ?? null;
    const row = {
      id: tweet.rest_id,
      title: typeof text === 'string' ? text.slice(0,220) : '',
      summary: typeof text === 'string' ? text.slice(0,1500) : '',
      text: typeof text === 'string' ? text : '',
      url: /^\d{10,25}$/.test(tweet.rest_id || '') ? `https://x.com/${author}/status/${tweet.rest_id}` : null,
      publisher: author, publisherId,
      publishedAt: Number.isFinite(date) ? new Date(date).toISOString() : null,
      engagement: { likes: count(legacy?.favorite_count), replies: count(legacy?.reply_count), reposts: count(legacy?.retweet_count), quotes: count(legacy?.quote_count), views: count(tweet.views?.count) },
      quotedPostId: /^\d{10,25}$/.test(legacy?.quoted_status_id_str || '') ? legacy.quoted_status_id_str : null,
      replyToPostId: /^\d{10,25}$/.test(legacy?.in_reply_to_status_id_str || '') ? legacy.in_reply_to_status_id_str : null,
      media: decodeXMedia(legacy),
      quotedMedia: decodeXMedia(tweet.quoted_status_result?.result?.legacy ?? tweet.quoted_status_result?.result?.tweet?.legacy),
      format: legacy && typeof text === 'string' ? xFormat(tweet, legacy, text, author) : null,
    };
    const decodable = /^\d{10,25}$/.test(row.id || '') && Boolean(legacy)
      && typeof text === 'string' && Boolean(text.trim());
    const validOwnerItem = decodable && Number.isFinite(date)
      && /^\d{1,25}$/.test(String(publisherId ?? ''));
    if (decodable) items.set(row.id, row);
    return { cursor: false, ownerItem: true, validOwnerItem, row };
  }
  function sortIndexValue(value) {
    if (typeof value === 'string' && /^\d{1,20}$/.test(value)) return value;
    if (Number.isSafeInteger(value) && value >= 0) return String(value);
    return null;
  }
  function addEntry(entry, instructionType, forcedKind = null) {
    const content = entry?.content || {};
    const entryId = typeof entry?.entryId === 'string' ? entry.entryId : null;
    const pin = instructionType === 'TimelinePinEntry' || entryId?.startsWith('pin-') === true;
    const children = [content, ...(Array.isArray(content.items) ? content.items.map(child => child?.item ?? child) : [])];
    const ownerItems = [];
    let malformedOwnerItemCount = 0, hasCursor = false;
    for (const child of children) {
      const decoded = item(child);
      if (!decoded) continue;
      if (decoded.cursor) { hasCursor = true; continue; }
      if (!decoded.ownerItem) continue;
      if (decoded.validOwnerItem) ownerItems.push(decoded.row);
      else malformedOwnerItemCount++;
      if (pin && decoded.row) {
        decoded.row.isPinned = true;
        const flattened = items.get(decoded.row.id);
        if (flattened) flattened.isPinned = true;
      }
    }
    const sortIndex = sortIndexValue(entry?.sortIndex);
    const cursorOnly = !forcedKind && (hasCursor || entryId?.startsWith('cursor-'))
      && ownerItems.length === 0 && malformedOwnerItemCount === 0;
    const kind = forcedKind || (pin ? 'pin'
      : cursorOnly ? 'cursor'
        : entryId?.startsWith('profile-conversation-') || content.entryType === 'TimelineTimelineModule' || Array.isArray(content.items) ? 'profile-conversation'
          : entryId?.startsWith('tweet-') || content.entryType === 'TimelineTimelineItem' ? 'tweet' : 'other');
    timelineEntries.push({ entryId, kind, sortIndex, hasInvalidSortIndex: entry?.sortIndex != null && sortIndex == null,
      isPinned: pin, isCursor: cursorOnly, ownerItems, malformedOwnerItemCount });
  }
  for (const instruction of instructions) {
    const entries = instruction.entries || (instruction.entry ? [instruction.entry] : []);
    for (const entry of entries) addEntry(entry, instruction.type);
    for (const child of instruction.moduleItems || []) addEntry({ content: child?.item ?? child }, instruction.type, 'profile-conversation');
  }
  return { items: [...items.values()], nextCursor, timelineEntries, invalidCursor };
}

export async function collectXPages(client, handle, { maxPages = 2, limit = 30, cursor } = {}) {
  if (!validHandle(handle) || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 5 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new XApiError('X_PAGE_LIMIT');
  const user = await client.profile(handle);
  const items = new Map(); const seen = new Set(); const pages = [];
  let nextCursor = cursor; let stopReason = 'page_limit';
  for (let n = 0; n < maxPages; n++) {
    if (nextCursor && seen.has(nextCursor)) { stopReason = 'cursor_cycle'; break; }
    if (nextCursor) seen.add(nextCursor);
    const response = await client.timeline(user.id, nextCursor);
    const page = decodeXTimeline(response.instructions, handle);
    for (const row of page.items) items.set(row.id, row);
    pages.push({ ...response.receipt, observedItems: page.items.length });
    nextCursor = page.nextCursor;
    if (!nextCursor) { stopReason = 'no_next_cursor'; break; }
    if (items.size >= limit) { stopReason = 'item_limit'; break; }
  }
  return { items: [...items.values()].slice(0,limit), remainder: [...items.values()].slice(limit), nextCursor, receipt: { sourceUrl: `https://x.com/${handle}`, pages,
    observedItems: items.size, executionMode: 'pure_http', browserUsed: false, bodyMethod: 'graphql_json',
    fullTimeline: false, stopReason, hasNextPage: !!nextCursor, authenticationMode: pages[0]?.authenticationMode } };
}

export async function fetchXXhr(handle, limit, { fetchImpl = globalThis.fetch, session, sessionLoader = loadXSession } = {}) {
  if (!validHandle(handle) || !Number.isInteger(limit) || limit < 1 || limit > 30) throw new XApiError('X_INPUT');
  if(!session && fetchImpl===globalThis.fetch) {
    let provider;
    try { provider=await loadWebAuth('x'); }
    catch(e) { if(e.message!=='WEB_AUTH_PLAYBOOK_NOT_INSTALLED')throw e; }
    if(provider?.status().sessionStored) return provider.withSession(async credentials=>{
      const client=await createXClient({fetchImpl:credentials.fetchImpl,session:credentials});
      try{return await collectXPages(client,handle,{limit,maxPages:2});}finally{client.close();}
    });
  }
  const suppliedSession = !!session;
  if (!session) {
    try { session = await sessionLoader(); }
    catch { throw new XApiError('X_SESSION_STORE_UNAVAILABLE'); }
  }
  if (!session) throw new XApiError('X_SESSION_REQUIRED');
  if (suppliedSession) {
    try { await storeXSession(session); }
    catch { throw new XApiError('X_SESSION_STORE_UNAVAILABLE'); }
  }
  const client = await createXClient({ fetchImpl, session });
  try { return await collectXPages(client, handle, { limit, maxPages: 2 }); }
  finally { client.close(); }
}
async function readBody(response, limit = 3000000) {
  let length = 0; const chunks = [];
  try {
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > limit) throw new XApiError('X_RESPONSE_LIMIT');
      chunks.push(chunk);
    }
  } catch (error) {
    if (!isReadTimeout(error)) throw error;
    throw new XApiError('X_READ_TIMEOUT', { method: 'GET', writeSent: false });
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Public client contract discovery only. Never evaluate JavaScript or extract posts from HTML.
export function contractsFromSource(source, defaults) {
  const result = {};
  const timelineOperation=source.includes('operationName:"UserOriginalsTimeline"')?'UserOriginalsTimeline':'UserTweets';
  const optional=['SearchTimeline','Followers'].filter(name=>source.includes(`operationName:"${name}"`));
  const names=['UserByScreenName', timelineOperation, 'TweetDetail', ...optional];
  if(source.includes('operationName:"UserTweetsAndReplies"'))names.push('UserTweetsAndReplies');
  for (const name of names) {
    const pattern = new RegExp('queryId:"([A-Za-z0-9_-]+)",operationName:"' + name + '",operationType:"query",metadata:\\{featureSwitches:(\\[[^\\]]*\\]),fieldToggles:(\\[[^\\]]*\\])');
    const match = source.match(pattern);
    if (!match) throw new XApiError('X_CONTRACT_CHANGED');
    const keys = JSON.parse(match[2]);
    // This feature was observed as false in the current signed-in UserOriginalsTimeline request (2026-09-24).
    const observedDefaults={rweb_conversational_replies_downvote_enabled:{value:false},...defaults};
    const missing = keys.filter(k => typeof observedDefaults[k]?.value !== 'boolean');
    result[name] = { queryId: match[1], features: Object.fromEntries(keys.filter(k => !missing.includes(k)).map(k => [k, observedDefaults[k].value])), fieldNames: JSON.parse(match[3]), missing };
  }
  return result;
}

export async function createXClient({ fetchImpl = globalThis.fetch, session } = {}) {
  const activeSession = session ? { authToken: session.authToken, csrfToken: session.csrfToken } : null;
  if (activeSession && [activeSession.authToken, activeSession.csrfToken].some(value =>
    typeof value !== 'string' || !value || value.length > 4096 || !/^[\x21-\x7e]+$/.test(value) || /[;\r\n]/.test(value))) {
    throw new XApiError('X_SESSION_INVALID');
  }
  // This app-shell URL was observed while following X's client manifest reference.
  const boot = await readFetch(fetchImpl, 'https://x.com/manifest.js', { redirect: 'error', signal: AbortSignal.timeout(SOCIAL_REQUEST_TIMEOUTS.publicAsset) });
  if (!boot.ok) throw new XApiError(`X_BOOTSTRAP_HTTP_${boot.status}`);
  const html = await readBody(boot);
  const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});?\s*(?:window\.|<\/script>)/);
  let state;
  try { state = JSON.parse(stateMatch?.[1]); } catch { throw new XApiError('X_BOOTSTRAP_SCHEMA'); }
  const asset = html.match(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/main\.[A-Za-z0-9]+\.js/)?.[0];
  if (!asset) throw new XApiError('X_ASSET_MISSING');
  const scriptResponse = await readFetch(fetchImpl, asset, { redirect: 'error', signal: AbortSignal.timeout(SOCIAL_REQUEST_TIMEOUTS.publicAsset) });
  if (!scriptResponse.ok) throw new XApiError('X_ASSET_HTTP');
  const source = await readBody(scriptResponse);
  const defaults = { ...state.featureSwitch?.defaultConfig, ...state.featureSwitch?.user?.config };
  const contracts = contractsFromSource(source, defaults);
  const bearer = source.match(/AAAA[A-Za-z0-9%_-]{50,}/)?.[0];
  if (!bearer) throw new XApiError('X_PUBLIC_CLIENT_AUTH_MISSING');
  const cookies = new Map(boot.headers.getSetCookie().map(c => c.split(';')[0]).map(c => [c.slice(0,c.indexOf('=')),c.slice(c.indexOf('=')+1)]));
  const baseHeaders = { authorization: 'Bearer ' + decodeURIComponent(bearer), 'x-twitter-active-user': 'yes', 'x-twitter-client-language': 'en', accept: 'application/json' };
  let mode = 'anonymous_guest';
  const guest = activeSession ? null : cookies.get('gt') || html.match(/document\.cookie\s*=\s*["']gt=([0-9]+)/)?.[1];
  if (!activeSession && !guest) throw new XApiError('X_GUEST_PROVIDER_MISSING');
  if (activeSession) mode = 'user_session';
  const requestHeaders = () => ({
    ...baseHeaders,
    ...(activeSession ? {
      cookie: 'auth_token=' + activeSession.authToken + '; ct0=' + activeSession.csrfToken,
      'x-csrf-token': activeSession.csrfToken,
      'x-twitter-auth-type': 'OAuth2Session',
    } : { 'x-guest-token': guest }),
  });
  async function persistRotatedSession(response) {
    if (!activeSession) return;
    let changed = false;
    for (const raw of response.headers.getSetCookie?.() || []) {
      if (raw.length > 8192 || /[\r\n]/.test(raw)) continue;
      const [pair, ...attributes] = raw.split(';');
      const equal = pair.indexOf('=');
      if (equal < 1) continue;
      const name = pair.slice(0, equal).trim();
      if (!['auth_token', 'ct0'].includes(name)) continue;
      const value = pair.slice(equal + 1).trim();
      if (!value || value.length > 4096 || !/^[\x21-\x7e]+$/.test(value) || /[;\r\n]/.test(value)) continue;
      let domain = 'api.x.com';
      let path = '/';
      let secure = false;
      let expired = false;
      for (const attribute of attributes) {
        const index = attribute.indexOf('=');
        const key = (index < 0 ? attribute : attribute.slice(0, index)).trim().toLowerCase();
        const part = index < 0 ? '' : attribute.slice(index + 1).trim().toLowerCase();
        if (key === 'domain') domain = part.replace(/^\./, '');
        if (key === 'path') path = part;
        if (key === 'secure') secure = true;
        if (key === 'max-age' && /^-?\d+$/.test(part) && Number(part) <= 0) expired = true;
        if (key === 'expires' && Number.isFinite(Date.parse(part)) && Date.parse(part) <= Date.now()) expired = true;
      }
      if (expired || !secure || !path.startsWith('/') || !['x.com', 'api.x.com'].includes(domain)) continue;
      const field = name === 'auth_token' ? 'authToken' : 'csrfToken';
      if (activeSession[field] !== value) {
        activeSession[field] = value;
        changed = true;
      }
    }
    if (changed) {
      try { await storeXSession(activeSession); }
      catch { throw new XApiError('X_SESSION_STORE_UNAVAILABLE'); }
    }
  }
  const receipts = [];
  async function query(operation, variables) {
    const contract = contracts[operation];
    if (!contract) throw new XApiError('X_OPERATION_NOT_ALLOWED');
    if (contract.missing.length) throw new XApiError('X_FEATURE_DEFAULT_MISSING', { operation, missing: contract.missing });
    const webTransport=Boolean(activeSession)&&defaults.responsive_web_api_transition_enabled?.value===true;
    const url = new URL(`${webTransport?'https://x.com/i/api':'https://api.x.com'}/graphql/${contract.queryId}/${operation}`);
    url.searchParams.set('variables', JSON.stringify(variables));
    url.searchParams.set('features', JSON.stringify(contract.features));
    if(operation==='UserOriginalsTimeline')url.searchParams.set('fieldToggles',JSON.stringify({withPayments:false,withArticlePlainText:false}));
    const response = await readFetch(fetchImpl, url, { redirect: 'error', headers: requestHeaders(), signal: AbortSignal.timeout(SOCIAL_REQUEST_TIMEOUTS.read) });
    await persistRotatedSession(response);
    const text = await readBody(response);
    const receipt = { operation, method: 'GET', path: url.pathname, httpStatus: response.status, mime: response.headers.get('content-type'), bytes: Buffer.byteLength(text), sha256: hash(text),
      checkedAt: new Date().toISOString(), executionMode: 'pure_http', browserUsed: false, authenticationMode: mode, contractEvidence: 'observed_public_client_source', liveReplay: false };
    receipts.push(receipt);
    if (!response.ok) throw new XApiError(`X_HTTP_${response.status}`, receipt);
    if (!receipt.mime?.includes('json')) throw new XApiError('X_NOT_JSON', receipt);
    let payload; try { payload = JSON.parse(text); } catch { throw new XApiError('X_NOT_JSON', receipt); }
    if (payload.errors?.length) throw new XApiError('X_SERVICE_ERROR', { ...receipt, serviceCodes: payload.errors.map(e => e.code).filter(Number.isInteger) });
    if (!payload.data) throw new XApiError('X_DATA_MISSING', receipt);
    return { data: payload.data, receipt };
  }
  return { receipts, contracts,
    async profile(handle) {
      if (!validHandle(handle)) throw new XApiError('X_HANDLE_INVALID');
      const { data, receipt } = await query('UserByScreenName', { screen_name: handle, withGrokTranslatedBio: state.featureSwitch.defaultConfig.responsive_web_grok_bio_auto_translation_is_enabled?.value === true });
      const user = data.user?.result;
      const name = user?.core?.screen_name ?? user?.legacy?.screen_name;
      if (user?.__typename !== 'User' || name?.toLowerCase() !== handle.toLowerCase() || !/^\d+$/.test(user.rest_id)) throw new XApiError('X_PROFILE_IDENTITY', receipt);
      const visibility = [user?.privacy?.protected, user?.legacy?.protected].filter(value => typeof value === 'boolean');
      if (visibility.some(Boolean)) throw new XApiError('X_PRIVATE_PROFILE_BLOCKED', receipt);
      if (!visibility.length) throw new XApiError('X_PROFILE_VISIBILITY_UNVERIFIED', receipt);
      receipt.liveReplay = true;
      return { id: user.rest_id, handle: name, name: user.core?.name ?? user.legacy?.name ?? name };
    },
    async timeline(userId, cursor) {
      if (!/^\d{1,25}$/.test(userId) || (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 4096))) throw new XApiError('X_TIMELINE_INPUT');
      const { data, receipt } = await query(contracts.UserOriginalsTimeline?'UserOriginalsTimeline':'UserTweets', { userId, count: 20, ...(cursor ? {cursor} : {}), includePromotedContent: true, withQuickPromoteEligibilityTweetFields: true,
        withVoice: state.featureSwitch.defaultConfig.voice_consumption_enabled?.value === true });
      const instructions = data.user?.result?.timeline?.timeline?.instructions ?? data.user?.result?.timeline_v2?.timeline?.instructions;
      if (!Array.isArray(instructions)) throw new XApiError('X_TIMELINE_SCHEMA', receipt);
      receipt.liveReplay = true;
      return { instructions, receipt };
    },
    async detail(postId) {
      if (!/^\d{10,25}$/.test(postId)) throw new XApiError('X_POST_INVALID');
      const { data, receipt } = await query('TweetDetail', { focalTweetId: postId, rankingMode: 'Relevance', includePromotedContent: true, withCommunity: state.featureSwitch.defaultConfig.c9s_enabled?.value === true,
        withQuickPromoteEligibilityTweetFields: true, withBirdwatchNotes: state.featureSwitch.defaultConfig.responsive_web_birdwatch_consumption_enabled?.value === true, withVoice: state.featureSwitch.defaultConfig.voice_consumption_enabled?.value === true });
      const instructions = data.threaded_conversation_with_injections_v2?.instructions;
      if (!Array.isArray(instructions)) throw new XApiError('X_DETAIL_SCHEMA', receipt);
      receipt.liveReplay = true;
      return { instructions, receipt };
    },
    close() {
      activeSession?.authToken && (activeSession.authToken = '');
      activeSession?.csrfToken && (activeSession.csrfToken = '');
      for (const key of Object.keys(baseHeaders)) delete baseHeaders[key];
      cookies.clear();
    }
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  let client;
  try { client = await createXClient(); const user = await client.profile(process.argv[2] || 'sama'); const page = await client.timeline(user.id); console.log(JSON.stringify({ user, instructions: page.instructions.length, receipts: client.receipts })); }
  catch (e) { console.log(JSON.stringify({ error: e.code || 'X_TRANSPORT_FAILURE', receipt: e.receipt, receipts: client?.receipts })); process.exitCode = 2; }
  finally { client?.close(); }
}
