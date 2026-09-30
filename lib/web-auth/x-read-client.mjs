// Derived from affiliate-content-operations X collector, 2026-09-24.
// The enclosing createXAuth().withSession transport owns cookies and DPAPI rotation.
import { createHash } from 'node:crypto';

const hash = s => createHash('sha256').update(s).digest('hex');
const validHandle = h => typeof h === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(h);
const count = x => (typeof x === 'number' || typeof x === 'string') && /^\d+$/.test(String(x)) && Number.isSafeInteger(Number(x)) ? Number(x) : null;
export class XApiError extends Error {
  constructor(code, receipt = {}) { super(code); this.code = code; this.receipt = receipt; }
}

export function decodeXTimeline(instructions, handle) {
  if (!validHandle(handle) || !Array.isArray(instructions)) throw new XApiError('X_TIMELINE_SCHEMA');
  const items = new Map(); let nextCursor = null;
  function item(content) {
    if (!content || content.promotedMetadata) return;
    const value = content.itemContent || content;
    if (value.promotedMetadata) return;
    if (value.cursorType === 'Bottom' && typeof value.value === 'string' && value.value.length <= 4096) nextCursor = value.value;
    const outer = value.tweet_results?.result;
    const tweet = outer?.__typename === 'TweetWithVisibilityResults' ? outer.tweet : outer;
    if (!tweet || tweet.__typename !== 'Tweet') return;
    const user = tweet.core?.user_results?.result;
    const author = user?.core?.screen_name ?? user?.legacy?.screen_name;
    const legacy = tweet.legacy;
    if (author?.toLowerCase() !== handle.toLowerCase() || !/^\d{10,25}$/.test(tweet.rest_id || '') || !legacy || legacy.retweeted_status_result) return;
    const text = tweet.note_tweet?.note_tweet_results?.result?.text ?? legacy.full_text;
    if (typeof text !== 'string' || !text.trim()) return;
    const date = Date.parse(legacy.created_at);
    items.set(tweet.rest_id, { id: tweet.rest_id, title: text.slice(0,220), summary: text.slice(0,1500), text,
      url: `https://x.com/${author}/status/${tweet.rest_id}`, publisher: author,
      publishedAt: Number.isFinite(date) ? new Date(date).toISOString() : null,
      engagement: { likes: count(legacy.favorite_count), replies: count(legacy.reply_count), reposts: count(legacy.retweet_count), quotes: count(legacy.quote_count), views: count(tweet.views?.count) },
      quotedPostId: /^\d{10,25}$/.test(legacy.quoted_status_id_str || '') ? legacy.quoted_status_id_str : null,
      replyToPostId: /^\d{10,25}$/.test(legacy.in_reply_to_status_id_str || '') ? legacy.in_reply_to_status_id_str : null });
  }
  for (const instruction of instructions) {
    const entries = instruction.entries || (instruction.entry ? [instruction.entry] : []);
    for (const entry of entries) {
      item(entry.content);
      for (const child of entry.content?.items || []) item(child.item);
    }
    for (const child of instruction.moduleItems || []) item(child.item);
  }
  return { items: [...items.values()], nextCursor };
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

async function readBody(response, limit = 3000000) {
  let length = 0; const chunks = [];
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > limit) throw new XApiError('X_RESPONSE_LIMIT');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Public client contract discovery only. Never evaluate JavaScript or extract posts from HTML.
export function contractsFromSource(source, defaults) {
  const result = {};
  const timelineOperation=source.includes('operationName:"UserOriginalsTimeline"')?'UserOriginalsTimeline':'UserTweets';
  for (const name of ['UserByScreenName', timelineOperation, 'TweetDetail']) {
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
  const boot = await fetchImpl('https://x.com/manifest.js', { redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!boot.ok) throw new XApiError(`X_BOOTSTRAP_HTTP_${boot.status}`);
  const html = await readBody(boot);
  const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});?\s*(?:window\.|<\/script>)/);
  let state;
  try { state = JSON.parse(stateMatch?.[1]); } catch { throw new XApiError('X_BOOTSTRAP_SCHEMA'); }
  const asset = html.match(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/main\.[A-Za-z0-9]+\.js/)?.[0];
  if (!asset) throw new XApiError('X_ASSET_MISSING');
  const scriptResponse = await fetchImpl(asset, { redirect: 'error', signal: AbortSignal.timeout(15000) });
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
    const response = await fetchImpl(url, { redirect: 'error', headers: requestHeaders(), signal: AbortSignal.timeout(15000) });
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
