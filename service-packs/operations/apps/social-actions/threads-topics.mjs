import { boundedText, metaHash, metaRequest, openMetaContext, sendMetaQuery, rotateMetaCookiesWithRetry } from './lib/meta-bootstrap.mjs';

const OWNER = 'lifehack__ailab';
const ORIGIN = 'https://www.threads.com';
const SEARCH = Object.freeze({
  operation: 'useBarcelonaTagsMentionsGraphQLDataSourceQuery',
  docId: '37565484953042725',
});
const RESOLVE = Object.freeze({
  operation: 'BarcelonaTagsUtilsQuery',
  docId: '28370718605952935',
  path: '/graphql/query',
});
const MAX_TOPIC_LENGTH = 160;
const fail = code => { throw Object.assign(new Error(code), { code }); };

export const THREADS_TOPIC_CONTRACTS = Object.freeze({
  search: Object.freeze({ ...SEARCH, method: 'POST', path: '/api/graphql', executionMode: 'pure_http' }),
  resolve: Object.freeze({ ...RESOLVE, method: 'POST', executionMode: 'pure_http' }),
  communityPublishing: 'unverified',
});

function validText(value, max = MAX_TOPIC_LENGTH) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
    && !/[\0-\x1f\x7f]/.test(value);
}

function validateContext(context) {
  if (context?.service !== 'threads' || context?.handle?.toLowerCase() !== OWNER
    || context?.bundle?.service !== 'threads' || context?.bundle?.owner?.toLowerCase() !== OWNER
    || context?.bundle?.origin !== ORIGIN || typeof context?.fetchImpl !== 'function') {
    fail('THREADS_TOPIC_CONTEXT_OWNER_MISMATCH');
  }
  return context;
}

async function contextFor(context, metaContextLoader) {
  if (context) return validateContext(context);
  if (typeof metaContextLoader !== 'function') fail('THREADS_TOPIC_CONTEXT_LOADER_REQUIRED');
  return validateContext(await metaContextLoader('threads', OWNER));
}

function searchVariables(query) {
  if (!validText(query)) fail('THREADS_TOPIC_QUERY_INVALID');
  return {
    query: query.trim(),
    disable_v1_tags: false,
    has_composer_flair: false,
    has_favicons: false,
    has_top_contributors: false,
    include_social_context: true,
  };
}

function normalizeTagInfo(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const allowed = new Set(['tag_name', 'display_text', 'display_name', 'tag_id', 'community_id',
    'is_community', 'slug', 'description', 'tag_description']);
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 20)) {
    if (!allowed.has(key)) continue;
    if (typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) result[key] = item;
    else if (typeof item === 'string' && validText(item, 300)) result[key] = item;
  }
  return Object.keys(result).length ? result : null;
}

function normalizeTopicEdge(edge) {
  const node = edge?.node;
  const entity = node?.entity;
  if (!validText(entity?.display_text) || entity.display_text.length > MAX_TOPIC_LENGTH) return null;
  const rawId = entity.id;
  const id = (typeof rawId === 'string' || typeof rawId === 'number') && /^\d{1,30}$/.test(String(rawId))
    ? String(rawId) : null;
  const subtitle = typeof node.search_result_subtitle === 'string'
    && node.search_result_subtitle.length <= 500 && !/[\0-\x1f\x7f]/.test(node.search_result_subtitle)
    ? node.search_result_subtitle : '';
  return {
    displayText: entity.display_text,
    id,
    searchResultSubtitle: subtitle,
    isCommunity: typeof node.is_community === 'boolean' ? node.is_community : null,
    tagInfo: normalizeTagInfo(node.tag_info),
  };
}

function parseSearchResult(payload) {
  const edges = payload?.data?.xdt_text_app_tags_search?.edges;
  if (!Array.isArray(edges)) fail('THREADS_TOPIC_SEARCH_SCHEMA_MISSING');
  const topics = [];
  const seen = new Set();
  for (const edge of edges.slice(0, 100)) {
    const topic = normalizeTopicEdge(edge);
    if (!topic) continue;
    const key = topic.id ? `id:${topic.id}` : `name:${topic.displayText.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    topics.push(topic);
  }
  return topics;
}

function safeKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value).slice(0, 30).map(key => key.replace(/[^A-Za-z0-9_.-]/g, '?'));
}

function normalizeTopicInput(topic) {
  if (typeof topic === 'string') {
    if (!validText(topic)) fail('THREADS_TOPIC_NAME_INVALID');
    return topic.trim();
  }
  if (!topic || typeof topic !== 'object' || Array.isArray(topic)) fail('THREADS_TOPIC_NAME_INVALID');
  const community = topic.isCommunity ?? topic.is_community;
  if (community === true) fail('THREADS_TOPIC_COMMUNITY_UNVERIFIED');
  if (community !== false) fail('THREADS_TOPIC_COMMUNITY_STATUS_REQUIRED');
  const displayText = topic.displayText ?? topic.display_text;
  if (!validText(displayText)) fail('THREADS_TOPIC_NAME_INVALID');
  return displayText.trim();
}

async function sendResolveRequest(context, request) {
  if (request?.url !== `${ORIGIN}${RESOLVE.path}` || request.method !== 'POST'
    || !(request.body instanceof URLSearchParams)) fail('THREADS_TOPIC_REQUEST_SCOPE_INVALID');
  const { url, ...init } = request;
  const response = await context.fetchImpl(url, init);
  let responseUrl;
  try { responseUrl = new URL(response.url); } catch { fail('THREADS_TOPIC_RESPONSE_SCOPE_INVALID'); }
  if (responseUrl.origin !== ORIGIN || responseUrl.pathname !== RESOLVE.path || responseUrl.search || responseUrl.hash) {
    fail('THREADS_TOPIC_RESPONSE_SCOPE_INVALID');
  }
  await rotateMetaCookiesWithRetry(context.bundle, response);
  const status = Number(response?.status ?? 0);
  if (status !== 200) fail(`THREADS_TOPIC_RESOLVE_HTTP_${status || 'UNKNOWN'}`);
  const contentType = response.headers?.get?.('content-type') || '';
  if (!/^(?:application\/json|text\/javascript)(?:;|$)/i.test(contentType)) fail('THREADS_TOPIC_RESOLVE_MIME');
  const text = await boundedText(response, 5_000_000);
  let payload;
  try { payload = JSON.parse(text.replace(/^for \(;;\);\s*/, '')); } catch { fail('THREADS_TOPIC_RESOLVE_NOT_JSON'); }
  if (payload?.errors?.length || payload?.error) {
    const marker = JSON.stringify(payload.errors || payload.error);
    fail(/friction|challenge|checkpoint|captcha/i.test(marker) ? 'META_INTERACTION_REQUIRED' : 'THREADS_TOPIC_RESOLVE_REJECTED');
  }
  if (!payload?.data || typeof payload.data !== 'object') fail('THREADS_TOPIC_RESOLVE_DATA_MISSING');
  return { payload, receipt: { httpStatus: status, contentType: contentType.slice(0, 120),
    bytes: Buffer.byteLength(text), bodySha256: metaHash(text), dataKeys: safeKeys(payload.data),
    method: 'POST', path: RESOLVE.path, finalUrl: `${ORIGIN}${RESOLVE.path}`, operation: RESOLVE.operation,
    browserUsed: false, checkedAt: new Date().toISOString() } };
}

function parseResolveResult(payload) {
  const value = payload?.data?.xdt_text_app_tags_validate;
  if (!value || typeof value.is_valid !== 'boolean' || typeof value.is_sensitive !== 'boolean') {
    fail('THREADS_TOPIC_RESOLVE_SCHEMA_MISSING');
  }
  return { isValid: value.is_valid, isSensitive: value.is_sensitive };
}

export async function searchThreadsTopics(query, { context, metaContextLoader = openMetaContext } = {}) {
  const variables = searchVariables(query);
  const current = await contextFor(context, metaContextLoader);
  const request = metaRequest(current, SEARCH.operation, SEARCH.docId, variables);
  let responseEvidence = {};
  const queryContext = { ...current, fetchImpl: async (url, init) => {
    const response = await current.fetchImpl(url, init);
    const contentType = response?.headers?.get?.('content-type') || '';
    if (typeof response?.clone === 'function') {
      const text = await boundedText(response.clone(), 5_000_000);
      responseEvidence = { contentType: contentType.slice(0, 120), bytes: Buffer.byteLength(text), bodySha256: metaHash(text) };
    } else responseEvidence = { contentType: contentType.slice(0, 120) };
    return response;
  } };
  const result = await sendMetaQuery(queryContext, request);
  const topics = parseSearchResult(result.payload);
  return {
    topics,
    receipt: { ...result.receipt, ...responseEvidence, dataKeys: safeKeys(result.payload.data), path: '/api/graphql',
      finalUrl: `${ORIGIN}/api/graphql`, browserUsed: false, count: topics.length },
  };
}

export async function resolveThreadsTopic(topic, { context, metaContextLoader = openMetaContext } = {}) {
  const displayText = normalizeTopicInput(topic);
  const current = await contextFor(context, metaContextLoader);
  const request = metaRequest(current, RESOLVE.operation, RESOLVE.docId, { tag_name: displayText });
  request.url = `${ORIGIN}${RESOLVE.path}`;
  const result = await sendResolveRequest(current, request);
  return { displayText, ...parseResolveResult(result.payload), receipt: result.receipt };
}
