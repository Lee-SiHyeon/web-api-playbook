import path from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  boundedText,
  metaHash,
  metaRequest,
  openMetaContext,
  parseMetaBootstrap,
  rotateMetaCookiesWithRetry,
} from './lib/meta-bootstrap.mjs';
import {
  metaCookieHeader,
} from '../naver-blog-api/scripts/meta-auth-session.mjs';
import { withSessionLock } from '../tistory-api/lib/lock.mjs';
import { threadsBenefitRuntimeRoot } from './threads-benefit-config.mjs';
import { SOCIAL_REQUEST_TIMEOUTS } from './lib/request-timeouts.mjs';

const ORIGIN = 'https://www.threads.com';
const OWNER = 'lifehack__ailab';
const SEARCH_PATH = '/search';
const SEARCH_PAGINATION_PATH = '/graphql/query';
const SEARCH_PAGINATION_OPERATION = 'BarcelonaSearchResultsRefetchableQuery';
const SEARCH_PAGINATION_DOC_ID = '28117118431294022';
const SEARCH_PAGINATION_ROUTE = 'comet.threads.BarcelonaSearchResultsColumnRoute';
const SEARCH_PAGINATION_CAPTURE = new URL('./evidence/threads-search-pagination-capture-2026-09-30.json', import.meta.url);
const SEARCH_PAGINATION_CAPTURE_SHA256 = '82406900fec86ed708f2b8e60f6628473c024468a1fe1477bc360576a5ab0513';
const MAX_QUERY_LENGTH = 300;
const MAX_PAGES = 5;
const MAX_DOCUMENT_BYTES = 5_000_000;
const MAX_GRAPHQL_BYTES = 5_000_000;
const MAX_JSON_SCRIPTS = 500;
const MAX_SEARCH_EDGES = 100;
const MAX_WALK_NODES = 180_000;

const fail = code => { throw Object.assign(new Error(code), { code }); };
const safeId = value => /^\d{1,25}$/.test(String(value ?? '')) ? String(value) : null;
const safeHandle = value => typeof value === 'string' && /^[A-Za-z0-9_.]{1,30}$/.test(value) ? value : null;

export const THREADS_SEARCH_CONTRACT = Object.freeze({
  operation: 'ThreadsAuthenticatedSearchDocument',
  method: 'GET',
  path: SEARCH_PATH,
  queryParameters: Object.freeze(['q', 'serp_type', 'filter?']),
  modeValues: Object.freeze(['default', 'recent']),
  captureSource: 'authenticated search UI URL observed; Network request event unavailable; direct HTTP Document route replayed',
  browserNetworkEventsCaptured: false,
  paginationOperation: SEARCH_PAGINATION_OPERATION,
  paginationPath: SEARCH_PAGINATION_PATH,
  paginationDocId: SEARCH_PAGINATION_DOC_ID,
  paginationCaptureSource: 'authenticated browser Network request and response observed; cursor values are never recorded',
  pagination: 'optional bounded direct HTTP Relay cursor pages seeded only from the authenticated SSR result',
});

function verifyContext(context) {
  if (context?.service !== 'threads' || context.handle?.toLowerCase() !== OWNER
    || context.bundle?.service !== 'threads' || context.bundle?.owner?.toLowerCase() !== OWNER
    || !safeId(context.bundle.ownerId) || context.bundle.origin !== ORIGIN
    || typeof context.fetchImpl !== 'function') {
    fail('THREADS_SEARCH_OWNER_UNVERIFIED');
  }
  return context;
}

function normalizeQuery(query) {
  if (typeof query !== 'string' || query.trim().length === 0 || query.trim().length > MAX_QUERY_LENGTH
    || /[\0-\x1f\x7f]/.test(query)) fail('THREADS_SEARCH_QUERY_INVALID');
  return query.trim();
}

function normalizeMode(mode) {
  if (mode !== 'default' && mode !== 'recent') fail('THREADS_SEARCH_MODE_INVALID');
  return mode;
}

function normalizePages(pages) {
  if (!Number.isSafeInteger(pages) || pages < 1 || pages > MAX_PAGES) fail('THREADS_SEARCH_PAGES_INVALID');
  return pages;
}

async function loadPaginationCapture() {
  let capture, source;
  try {
    source = await readFile(SEARCH_PAGINATION_CAPTURE, 'utf8');
    if (metaHash(source.replace(/\r\n/g, '\n')) !== SEARCH_PAGINATION_CAPTURE_SHA256) {
      fail('THREADS_SEARCH_PAGINATION_CONTRACT_CHANGED');
    }
    capture = JSON.parse(source);
  } catch (error) {
    if (error?.code === 'THREADS_SEARCH_PAGINATION_CONTRACT_CHANGED') throw error;
    fail('THREADS_SEARCH_PAGINATION_CAPTURE_MISSING');
  }
  const template = capture?.variablesTemplate;
  const keys = template && Object.keys(template);
  if (capture?.service !== 'threads' || capture.operation !== SEARCH_PAGINATION_OPERATION
    || capture.path !== SEARCH_PAGINATION_PATH || capture.method !== 'POST'
    || capture.docId !== SEARCH_PAGINATION_DOC_ID || capture.canonicalRouteName !== SEARCH_PAGINATION_ROUTE
    || capture.captured !== true
    || capture.cursorValuesRecorded !== false || capture.credentialValuesRecorded !== false
    || template?.after !== null || template?.before !== null || template?.first !== 10 || template?.last !== null
    || template?.query !== '스하리' || template?.recent !== 1 || template?.search_surface !== 'default'
    || !Array.isArray(keys) || keys.length < 30
    || keys.some(key => !['after', 'before', 'first', 'last', 'query', 'recent', 'search_surface',
      'has_communities', 'has_community_green_dot', 'has_favicons', 'has_live_chats', 'has_serp_header',
      'meta_place_id', 'pinned_ids', 'power_search_info', 'tagID', 'trend_fbid'].includes(key)
      && !key.startsWith('__relay_internal__pv__'))
    || keys.filter(key => key.startsWith('__relay_internal__pv__')).some(key => typeof template[key] !== 'boolean')
    || keys.some(key => ['has_communities', 'has_community_green_dot', 'has_favicons', 'has_live_chats',
      'has_serp_header'].includes(key) && typeof template[key] !== 'boolean')
    || ['meta_place_id', 'pinned_ids', 'power_search_info', 'tagID', 'trend_fbid']
      .some(key => template[key] !== null)) {
    fail('THREADS_SEARCH_PAGINATION_CONTRACT_CHANGED');
  }
  return template;
}

export function buildThreadsSearchUrl({ query, mode = 'default' } = {}) {
  const normalizedQuery = normalizeQuery(query);
  const normalizedMode = normalizeMode(mode);
  const params = new URLSearchParams();
  params.set('q', normalizedQuery);
  params.set('serp_type', 'default');
  if (normalizedMode === 'recent') params.set('filter', 'recent');
  return `${ORIGIN}${SEARCH_PATH}?${params.toString()}`;
}

function buildPaginationVariables(template, query, mode, cursor) {
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 10_000 || /[\0-\x1f\x7f]/.test(cursor)) {
    fail('THREADS_SEARCH_CURSOR_INVALID');
  }
  const variables = structuredClone(template);
  variables.after = cursor;
  variables.query = query;
  variables.recent = mode === 'recent' ? 1 : 0;
  return variables;
}

function buildPaginationRequest(context, query, mode, cursor, template) {
  const referer = buildThreadsSearchUrl({ query, mode });
  const request = metaRequest(context, SEARCH_PAGINATION_OPERATION, SEARCH_PAGINATION_DOC_ID,
    buildPaginationVariables(template, query, mode, cursor));
  request.body.set('__crn', SEARCH_PAGINATION_ROUTE);
  request.url = `${ORIGIN}${SEARCH_PAGINATION_PATH}`;
  request.headers.referer = referer;
  request.headers.cookie = metaCookieHeader(context.bundle, request.url);
  let parsedReferer;
  try { parsedReferer = new URL(request.headers.referer); } catch { fail('THREADS_SEARCH_PAGINATION_REQUEST_SCOPE'); }
  if (request.method !== 'POST' || request.url !== `${ORIGIN}${SEARCH_PAGINATION_PATH}`
    || request.body?.get('fb_api_req_friendly_name') !== SEARCH_PAGINATION_OPERATION
    || request.body?.get('doc_id') !== SEARCH_PAGINATION_DOC_ID
    || request.body?.get('__crn') !== SEARCH_PAGINATION_ROUTE
    || request.headers.origin !== ORIGIN || parsedReferer.href !== referer
    || [...request.body.keys()].filter(key => key === 'variables').length !== 1) {
    fail('THREADS_SEARCH_PAGINATION_REQUEST_SCOPE');
  }
  return request;
}

export async function sendThreadsSearchPaginationQuery(context, request, { fetchImpl } = {}) {
  if (!context || context.service !== 'threads' || context.bundle?.service !== 'threads'
    || context.bundle?.origin !== ORIGIN || !request || request.url !== `${ORIGIN}${SEARCH_PAGINATION_PATH}`
    || request.method !== 'POST' || request.body?.get('fb_api_req_friendly_name') !== SEARCH_PAGINATION_OPERATION
    || request.body?.get('doc_id') !== SEARCH_PAGINATION_DOC_ID || request.headers?.origin !== ORIGIN) {
    fail('THREADS_SEARCH_PAGINATION_REQUEST_SCOPE');
  }
  const referer = new URL(request.headers.referer);
  let requestVariables;
  try { requestVariables = JSON.parse(request.body.get('variables')); }
  catch { fail('THREADS_SEARCH_PAGINATION_REQUEST_SCOPE'); }
  const query = normalizeQuery(requestVariables?.query);
  const mode = requestVariables?.recent === 1 ? 'recent' : requestVariables?.recent === 0 ? 'default' : null;
  if (!mode || referer.href !== buildThreadsSearchUrl({ query, mode })
    || !request.headers.cookie || request.headers.cookie !== metaCookieHeader(context.bundle, request.url)) {
    fail('THREADS_SEARCH_PAGINATION_REQUEST_SCOPE');
  }
  const { url, ...init } = request;
  const response = await (fetchImpl || context.fetchImpl)(url, init);
  await rotateMetaCookiesWithRetry(context.bundle, response);
  let responseUrl;
  try { responseUrl = new URL(response.url); } catch { fail('THREADS_SEARCH_PAGINATION_RESPONSE_SCOPE'); }
  if (responseUrl.origin !== ORIGIN || responseUrl.pathname !== SEARCH_PAGINATION_PATH
    || responseUrl.search || responseUrl.hash) fail('THREADS_SEARCH_PAGINATION_RESPONSE_SCOPE');
  if (response.status !== 200) fail('THREADS_SEARCH_PAGINATION_HTTP_' + response.status);
  const mime = response.headers.get('content-type') || '';
  if (!/^(?:application\/json|text\/javascript)(?:;|$)/i.test(mime)) fail('THREADS_SEARCH_PAGINATION_MIME');
  const text = await boundedText(response, MAX_GRAPHQL_BYTES);
  let payload;
  try { payload = JSON.parse(text.replace(/^for \(;;\);\s*/, '')); }
  catch { fail('THREADS_SEARCH_PAGINATION_NOT_JSON'); }
  if (payload?.errors?.length || payload?.error) {
    const marker = JSON.stringify(payload.errors || payload.error);
    fail(/friction|challenge|checkpoint|captcha/i.test(marker)
      ? 'META_INTERACTION_REQUIRED' : 'THREADS_SEARCH_PAGINATION_REJECTED');
  }
  if (!payload?.data || typeof payload.data !== 'object') fail('THREADS_SEARCH_PAGINATION_DATA_MISSING');
  return {
    payload,
    receipt: {
      method: 'POST', path: SEARCH_PAGINATION_PATH, operation: SEARCH_PAGINATION_OPERATION,
      httpStatus: response.status, mime: mime.split(';')[0].toLowerCase(), bytes: Buffer.byteLength(text),
      responseSha256: metaHash(text), browserUsed: false, credentialValuesRecorded: false,
      checkedAt: new Date().toISOString(),
    },
  };
}

function parseSearchPaginationPayload(payload) {
  const connection = payload?.data?.searchResults;
  if (!connection || typeof connection !== 'object' || Array.isArray(connection)) {
    fail('THREADS_SEARCH_PAGINATION_CONNECTION_SCHEMA');
  }
  return parseSearchConnection(connection);
}

function collectJsonScriptRoots(html) {
  const roots = [];
  for (const match of html.matchAll(/<script\b[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) {
    if (roots.length >= MAX_JSON_SCRIPTS) fail('THREADS_SEARCH_SCRIPT_LIMIT');
    try { roots.push(JSON.parse(match[1])); } catch { /* unrelated non-JSON script blocks are ignored */ }
  }
  return roots;
}

function hasObservedMediaPayload(post) {
  const candidates = post?.image_versions2?.candidates;
  const hasImageVariants = Array.isArray(candidates) && candidates.length > 0
    && Number.isFinite(post.original_width) && post.original_width > 0
    && Number.isFinite(post.original_height) && post.original_height > 0;
  if (post.media_type === 1) return hasImageVariants;
  if (post.media_type === 8) {
    return hasImageVariants && Array.isArray(post.carousel_media)
      && post.carousel_media.length > 0 && post.carousel_media.length <= 20
      && post.carousel_media.every(item => item && typeof item === 'object' && !Array.isArray(item));
  }
  return false;
}

function normalizeSearchEdge(edge) {
  const items = edge?.node?.thread?.thread_items;
  if (!Array.isArray(items) || items.length < 1 || items.length > 100
    || !items[0]?.post || typeof items[0].post !== 'object') {
    fail('THREADS_SEARCH_POST_SCHEMA');
  }
  const post = items[0].post;
  const id = safeId(String(post.pk ?? post.id ?? '').split('_')[0]);
  const user = post.user;
  const author = safeHandle(user?.username);
  const authorId = safeId(user?.pk ?? user?.id);
  const info = post.text_post_app_info;
  let text = typeof post.caption === 'string' ? post.caption : post.caption?.text;
  const mediaOnly = post.caption === null && hasObservedMediaPayload(post);
  if (mediaOnly) text = '';
  if (!id || !author || !authorId || !info || typeof text !== 'string'
    || typeof info.can_reply !== 'boolean' || typeof info.is_reply !== 'boolean') {
    fail('THREADS_SEARCH_POST_SCHEMA');
  }
  const result = {
    id,
    author,
    authorId,
    text,
    canReply: info.can_reply,
    isReply: info.is_reply,
  };
  if (mediaOnly) result.contentType = 'media';
  // Public engagement counts and the post shortcode, for ranking hot posts. Counts that are absent stay absent.
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const metrics = { likes: count(post.like_count), replies: count(info.direct_reply_count),
    reposts: count(info.repost_count), quotes: count(info.quote_count), reshares: count(info.reshare_count) };
  if (Object.values(metrics).some(value => value !== undefined)) result.metrics = metrics;
  if (typeof post.code === 'string' && /^[\w-]{5,40}$/.test(post.code)) result.url = `https://www.threads.com/@${author}/post/${post.code}`;
  const mediaType = { 1: 'image', 2: 'video', 8: 'carousel' }[post.media_type];
  if (mediaType) result.mediaType = mediaType;
  if (Number.isFinite(post.taken_at) && post.taken_at > 0) {
    result.publishedAt = new Date(post.taken_at * 1000).toISOString();
  }
  return result;
}

function parseSearchConnection(connection) {
  const pageInfo = connection?.page_info;
  const edges = connection?.edges;
  if (!Array.isArray(edges) || edges.length > MAX_SEARCH_EDGES
    || !pageInfo || typeof pageInfo.has_next_page !== 'boolean'
    || typeof pageInfo.has_previous_page !== 'boolean'
    || !(pageInfo.end_cursor === null || typeof pageInfo.end_cursor === 'string' && pageInfo.end_cursor.length <= 10_000
      && !/[\0-\x1f\x7f]/.test(pageInfo.end_cursor))
    || !(pageInfo.start_cursor === null || typeof pageInfo.start_cursor === 'string' && pageInfo.start_cursor.length <= 10_000
      && !/[\0-\x1f\x7f]/.test(pageInfo.start_cursor))) {
    fail('THREADS_SEARCH_CONNECTION_SCHEMA');
  }
  if (pageInfo.has_next_page && (typeof pageInfo.end_cursor !== 'string' || pageInfo.end_cursor.length === 0)) {
    fail('THREADS_SEARCH_CURSOR_MISSING');
  }
  const posts = [];
  const seen = new Map();
  let skippedEdges = 0;
  for (const edge of edges) {
    // One unrecognized result (e.g. a captionless video) is skipped, not acted on;
    // only a page where no edge matches the observed shape is schema drift.
    let post;
    try { post = normalizeSearchEdge(edge); } catch (error) {
      if (error?.code !== 'THREADS_SEARCH_POST_SCHEMA') throw error;
      skippedEdges += 1;
      continue;
    }
    const prior = seen.get(post.id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(post)) fail('THREADS_SEARCH_POST_CONFLICT');
    if (!prior) {
      seen.set(post.id, post);
      posts.push(post);
    }
  }
  if (edges.length > 0 && skippedEdges === edges.length) fail('THREADS_SEARCH_POST_SCHEMA');
  return {
    posts,
    skippedEdges,
    page: { hasNextPage: pageInfo.has_next_page, fullList: false },
    cursor: pageInfo.end_cursor,
    identity: JSON.stringify({ posts, hasNextPage: pageInfo.has_next_page,
      hasPreviousPage: pageInfo.has_previous_page, edgeCount: edges.length, endCursor: pageInfo.end_cursor,
      startCursor: pageInfo.start_cursor }),
  };
}

function decodeThreadsSearchDocumentPage(html, { handle = OWNER, viewerOwner = OWNER, viewerId } = {}) {
  const username = safeHandle(handle);
  const owner = safeHandle(viewerOwner);
  const ownerId = safeId(viewerId);
  if (!username || !owner || !ownerId || typeof html !== 'string'
    || Buffer.byteLength(html) > MAX_DOCUMENT_BYTES) fail('THREADS_SEARCH_DOCUMENT_INVALID');

  const document = parseMetaBootstrap(html, username);
  const viewer = document.modules.get('BarcelonaSharedData')?.viewer;
  if (viewer?.username?.toLowerCase() !== owner.toLowerCase()
    || safeId(viewer?.id) !== ownerId) fail('THREADS_SEARCH_VIEWER_MISMATCH');

  const connections = [];
  let visited = 0;
  const seen = new Set();
  const walk = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 70 || seen.has(value)) return;
    if (++visited > MAX_WALK_NODES) fail('THREADS_SEARCH_DOCUMENT_COMPLEXITY');
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    const connection = value.searchResults;
    if (connection && typeof connection === 'object' && Array.isArray(connection.edges)
      && connection.page_info && typeof connection.page_info === 'object') {
      connections.push(parseSearchConnection(connection));
    }
    for (const item of Object.values(value)) walk(item, depth + 1);
  };
  for (const root of collectJsonScriptRoots(html)) walk(root);
  if (connections.length === 0) fail('THREADS_SEARCH_RESULTS_MISSING');
  const unique = new Map(connections.map(connection => [connection.identity, connection]));
  if (unique.size !== 1) fail('THREADS_SEARCH_RESULTS_AMBIGUOUS');
  const [result] = unique.values();
  return { posts: result.posts, page: result.page, cursor: result.cursor };
}

export function decodeThreadsSearchDocument(html, options = {}) {
  const { posts, page } = decodeThreadsSearchDocumentPage(html, options);
  return { posts, page };
}

async function searchThreadsPostsUnlocked({ query, mode, pages }, {
  context,
  contextLoader,
  fetchImpl,
  paginationQuerySender,
} = {}) {
  const normalizedQuery = normalizeQuery(query);
  const normalizedMode = normalizeMode(mode);
  const url = buildThreadsSearchUrl({ query: normalizedQuery, mode: normalizedMode });
  const ctx = verifyContext(context || await contextLoader('threads', OWNER));
  const response = await (fetchImpl || ctx.fetchImpl)(url, {
    method: 'GET',
    headers: {
      accept: 'text/html',
      cookie: metaCookieHeader(ctx.bundle, url),
      'cache-control': 'no-cache',
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(SOCIAL_REQUEST_TIMEOUTS.read),
  });
  await rotateMetaCookiesWithRetry(ctx.bundle, response);
  let responseUrl;
  try { responseUrl = new URL(response.url); } catch { fail('THREADS_SEARCH_RESPONSE_SCOPE'); }
  if (responseUrl.origin !== ORIGIN || responseUrl.pathname !== SEARCH_PATH
    || responseUrl.searchParams.getAll('q').length !== 1
    || responseUrl.searchParams.get('q') !== normalizedQuery
    || responseUrl.searchParams.getAll('serp_type').length !== 1
    || responseUrl.searchParams.get('serp_type') !== 'default'
    || normalizedMode === 'recent' && (responseUrl.searchParams.getAll('filter').length !== 1
      || responseUrl.searchParams.get('filter') !== 'recent')
    || normalizedMode === 'default' && responseUrl.searchParams.has('filter')
    || [...responseUrl.searchParams.keys()].some(key => !['q', 'serp_type', 'filter'].includes(key))) {
    fail('THREADS_SEARCH_RESPONSE_SCOPE');
  }
  if (response.status !== 200) {
    // Record only where a redirect points (origin + path), never its query, for diagnosis.
    let location = null;
    try { const target = new URL(response.headers.get('location') || '', ORIGIN); location = target.origin + target.pathname; } catch { /* none */ }
    throw Object.assign(new Error('THREADS_SEARCH_HTTP_' + response.status), { code: 'THREADS_SEARCH_HTTP_' + response.status, location });
  }
  const mime = response.headers.get('content-type') || '';
  if (!/^text\/html(?:;|$)/i.test(mime)) fail('THREADS_SEARCH_MIME');
  const html = await boundedText(response, MAX_DOCUMENT_BYTES);
  const initial = decodeThreadsSearchDocumentPage(html, {
    handle: OWNER,
    viewerOwner: ctx.bundle.owner,
    viewerId: ctx.bundle.ownerId,
  });
  const allPosts = new Map(initial.posts.map(post => [post.id, post]));
  let currentPage = initial.page;
  let currentCursor = initial.cursor;
  let paginationTemplate = null;
  const usedCursors = new Set();
  const paginationReceipts = [];
  const querySender = paginationQuerySender || sendThreadsSearchPaginationQuery;
  for (let pageNumber = 1; pageNumber < pages && currentPage.hasNextPage; pageNumber += 1) {
    if (!paginationTemplate) paginationTemplate = await loadPaginationCapture();
    if (typeof currentCursor !== 'string' || usedCursors.has(currentCursor)) fail('THREADS_SEARCH_CURSOR_CYCLE');
    usedCursors.add(currentCursor);
    const request = buildPaginationRequest(ctx, normalizedQuery, normalizedMode, currentCursor, paginationTemplate);
    const result = await querySender(ctx, request, { fetchImpl });
    if (!result?.payload || typeof result.payload !== 'object') fail('THREADS_SEARCH_PAGINATION_DATA_MISSING');
    const parsed = parseSearchPaginationPayload(result.payload);
    for (const post of parsed.posts) {
      const previous = allPosts.get(post.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(post)) fail('THREADS_SEARCH_POST_CONFLICT');
      if (!previous) allPosts.set(post.id, post);
    }
    if (parsed.page.hasNextPage && (typeof parsed.cursor !== 'string' || usedCursors.has(parsed.cursor))) {
      fail('THREADS_SEARCH_CURSOR_CYCLE');
    }
    currentPage = parsed.page;
    currentCursor = parsed.cursor;
    paginationReceipts.push(result.receipt || { method: 'POST', path: SEARCH_PAGINATION_PATH,
      operation: SEARCH_PAGINATION_OPERATION });
  }
  const fullList = pages > 1 && currentPage.hasNextPage === false;
  const result = {
    posts: [...allPosts.values()],
    page: { hasNextPage: currentPage.hasNextPage, fullList },
  };
  const continuationCount = paginationReceipts.length;
  return {
    ...result,
    receipt: {
      operation: THREADS_SEARCH_CONTRACT.operation,
      method: 'GET',
      path: SEARCH_PATH,
      httpStatus: response.status,
      mime: mime.split(';')[0].toLowerCase(),
      bytes: Buffer.byteLength(html),
      responseSha256: metaHash(html),
      checkedAt: new Date().toISOString(),
      query: normalizedQuery,
      mode: normalizedMode,
      coverage: continuationCount === 0
        ? result.page.hasNextPage ? 'initial_document_page_partial' : 'initial_document_page'
        : fullList ? 'cursor_pages_exhausted' : 'bounded_cursor_window_partial',
      pagesRequested: pages,
      pagesFetched: continuationCount + 1,
      paginationRequests: paginationReceipts.map(receipt => ({
        method: receipt.method || 'POST', path: receipt.path || SEARCH_PAGINATION_PATH,
        operation: receipt.operation || SEARCH_PAGINATION_OPERATION,
        httpStatus: receipt.httpStatus ?? null, bytes: receipt.bytes ?? null,
        responseSha256: receipt.responseSha256 ?? null,
      })),
      executionMode: 'pure_http',
      browserUsed: false,
      credentialProvider: 'windows_dpapi_current_user',
      credentialValuesRecorded: false,
      owner: ctx.bundle.owner,
      ownerVerified: true,
      captured: false,
      captureSource: THREADS_SEARCH_CONTRACT.captureSource,
      browserNetworkEventsCaptured: false,
      documentRequestCaptured: false,
      paginationRequestCaptured: true,
      paginationCaptureSource: THREADS_SEARCH_CONTRACT.paginationCaptureSource,
      paginationRequestsCaptured: true,
      paginationBrowserNetworkEventsCaptured: continuationCount > 0,
      client_exists: true,
      remnant_free: true,
      credential_propagated: true,
      live_replay: true,
    },
  };
}

export async function searchThreadsPosts({ query, mode = 'default', pages = 1 } = {}, options = {}) {
  const normalizedQuery = normalizeQuery(query);
  const normalizedMode = normalizeMode(mode);
  const normalizedPages = normalizePages(pages);
  if (options.coordinatorLockHeld !== undefined && typeof options.coordinatorLockHeld !== 'boolean') {
    fail('THREADS_SEARCH_LOCK_OPTION_INVALID');
  }
  const run = () => searchThreadsPostsUnlocked({ query: normalizedQuery, mode: normalizedMode, pages: normalizedPages }, {
    context: options.context,
    contextLoader: options.contextLoader || openMetaContext,
    fetchImpl: options.fetchImpl,
    paginationQuerySender: options.paginationQuerySender,
  });
  if (options.coordinatorLockHeld === true) return run();
  const lock = options.sessionLock || (task => withSessionLock(task, {
    lockPath: path.join(threadsBenefitRuntimeRoot(), 'coordinator.lock'), timeoutMs: 600_000,
  }));
  return lock(run);
}
