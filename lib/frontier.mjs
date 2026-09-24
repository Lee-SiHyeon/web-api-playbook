import { createHash } from 'node:crypto';
import { open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { normalizeFieldNames, normalizePath, normalizeUrl } from './contracts.mjs';

export const FRONTIER_SCHEMA = 'xhr-discovery-frontier-v1';
export const NODE_STATES = Object.freeze([
  'pending', 'candidate', 'inspected', 'request_observed', 'replay_verified',
  'blocked_auth', 'blocked_runtime', 'out_of_scope', 'budget_deferred', 'mutation_excluded',
]);
const TERMINAL_STATES = new Set(['inspected', 'replay_verified', 'out_of_scope', 'mutation_excluded']);
const EVIDENCE_SOURCES = new Set(['DOM', 'network', 'source', 'direct_replay', 'HAR', 'HTML', 'manual_metadata']);
const EDGE_TYPES = new Set(['link', 'menu', 'iframe', 'script', 'request', 'schema', 'pagination', 'source_import', 'other']);
const PAGINATION_KINDS = new Set(['none', 'page', 'offset', 'cursor', 'unknown']);
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const SAFE_REASON_CODES = new Set([
  'unspecified', 'origin_outside_scope', 'mutation_semantics_excluded', 'operation_semantics_require_review',
  'budget_limit', 'auth_required', 'runtime_unavailable', 'transport_failed', 'http_403',
  'schema_mismatch', 'timeout', 'response_limit', 'browser_connection_lost',
  'application_not_authenticated', 'blocked_by_policy', 'upstream_rate_limit',
  'incomplete_page', 'cursor_stalled', 'pagination_exhausted',
]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function iso(value, fallback = null) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return fallback;
  return new Date(value).toISOString();
}

function safeCode(value, fallback = 'unspecified') {
  return typeof value === 'string' && SAFE_REASON_CODES.has(value) ? value : fallback;
}

function safeStage(value, allowed) {
  return typeof value === 'string' && allowed.has(value) ? value : null;
}

function safeInstanceKey(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw fail('XHR_FRONTIER_INSTANCE_KEY_INVALID');
  }
  return value.toLowerCase();
}

function cleanOrigin(raw) {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.origin;
  } catch { return null; }
}

function scopeUrl(raw) {
  const normalized = normalizeUrl(raw);
  return { origin: normalized.origin, path: normalized.path, queryFields: normalized.queryFields };
}

function normalizePagination(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};
  const kind = PAGINATION_KINDS.has(input.kind) ? input.kind : 'unknown';
  const sequenceValue = input.sequence ?? input.pageIndex ?? input.offset;
  const sequence = Number.isSafeInteger(sequenceValue) && sequenceValue >= 0 ? sequenceValue : null;
  const total = Number.isSafeInteger(input.total) && input.total >= 0 ? input.total : null;
  const cursorPresent = input.cursorPresent === true || (typeof input.cursor === 'string' && input.cursor.length > 0);
  const terminal = typeof input.terminal === 'boolean' ? input.terminal : null;
  const termination = ['next_flag_false', 'cursor_exhausted', 'offset_exhausted', 'server_total_reached', 'unknown'].includes(input.termination)
    ? input.termination : 'unknown';
  return { kind, sequence, total, cursorPresent, terminal, termination };
}

function normalizedNodeKey(node) {
  return JSON.stringify({
    origin: node.origin,
    path: node.path,
    stage: node.stage,
    instanceKey: node.instanceKey,
    method: node.method,
    queryFields: node.queryFields,
    bodyFields: node.bodyFields,
    operationFields: node.operationFields,
    pagination: { kind: node.pagination.kind, sequence: node.pagination.sequence },
  });
}

function nodeId(node) {
  return sha256(normalizedNodeKey(node)).slice(0, 24);
}

function normalizeNodeInput(frontier, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('XHR_FRONTIER_NODE_INVALID');
  let url = null;
  if (typeof input.url === 'string') url = scopeUrl(input.url);
  const origin = cleanOrigin(input.origin) ?? url?.origin;
  const rawPath = typeof input.path === 'string' ? input.path : url?.path;
  if (!origin || !rawPath) throw fail('XHR_FRONTIER_NODE_SCOPE_REQUIRED');
  const pathname = normalizePath(rawPath);
  const stage = safeStage(input.stage ?? frontier.scope.stages[0], new Set(frontier.scope.stages));
  if (!stage) throw fail('XHR_FRONTIER_STAGE_INVALID');
  const method = typeof input.method === 'string' && /^[A-Za-z]{3,12}$/.test(input.method) ? input.method.toUpperCase() : null;
  const queryFields = normalizeFieldNames(input.queryFields ?? url?.queryFields ?? []);
  const bodyFields = normalizeFieldNames(input.bodyFields ?? []);
  const operationFields = normalizeFieldNames(input.operationFields ?? []);
  const depth = Number.isSafeInteger(input.depth) && input.depth >= 0 ? input.depth : null;
  const evidenceSource = EVIDENCE_SOURCES.has(input.evidenceSource) ? input.evidenceSource : 'manual_metadata';
  const pagination = normalizePagination(input.pagination);
  const allowed = frontier.scope.allowedOrigins.includes(origin);
  const explicitlyExcludedMutation = input.mutationExcluded === true || input.state === 'mutation_excluded';
  const explicitSafeRead = input.readOnly === true || input.state === 'pending' || input.state === 'request_observed' || input.state === 'replay_verified';
  let state;
  let reason = null;
  if (!allowed) { state = 'out_of_scope'; reason = 'origin_outside_scope'; }
  else if (explicitlyExcludedMutation) { state = 'mutation_excluded'; reason = safeCode(input.reason, 'mutation_semantics_excluded'); }
  else if (input.state && NODE_STATES.includes(input.state)) {
    state = input.state;
    reason = input.reason ? safeCode(input.reason) : null;
  } else if (explicitSafeRead) state = 'pending';
  else { state = 'candidate'; reason = 'operation_semantics_require_review'; }
  const node = {
    origin,
    path: pathname,
    stage,
    instanceKey: safeInstanceKey(input.instanceKey),
    method,
    queryFields,
    bodyFields,
    operationFields,
    depth,
    state,
    reason,
    attempts: 0,
    lastAttemptAt: null,
    evidenceSource,
    evidenceSources: [evidenceSource],
    pagination,
  };
  node.id = nodeId(node);
  return node;
}

export function createFrontier({ root, stages, allowedOrigins = [], createdAt = new Date().toISOString() } = {}) {
  if (typeof root !== 'string' || !Array.isArray(stages) || !stages.length
    || stages.length > 32 || stages.some(stage => typeof stage !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(stage))) {
    throw fail('XHR_FRONTIER_INIT_INVALID');
  }
  const normalizedRoot = scopeUrl(root);
  const normalizedAllowed = [...new Set([normalizedRoot.origin, ...allowedOrigins.map(cleanOrigin).filter(Boolean)])].sort();
  const frontier = {
    schema: FRONTIER_SCHEMA,
    createdAt: iso(createdAt, new Date().toISOString()),
    checkedAt: iso(createdAt, new Date().toISOString()),
    scope: {
      requestedRoot: { origin: normalizedRoot.origin, path: normalizedRoot.path, queryFields: normalizedRoot.queryFields },
      allowedOrigins: normalizedAllowed,
      stages: [...new Set(stages)],
      rootDiscovery: 'unknown',
      totalDenominator: 'unknown',
    },
    sharedFailureBoundary: null,
    nodes: [],
    edges: [],
  };
  const rootNode = normalizeNodeInput(frontier, {
    origin: normalizedRoot.origin,
    path: normalizedRoot.path,
    queryFields: normalizedRoot.queryFields,
    stage: frontier.scope.stages[0],
    depth: 0,
    readOnly: true,
    evidenceSource: 'manual_metadata',
    pagination: { kind: 'none', terminal: false, termination: 'unknown' },
  });
  frontier.nodes.push(rootNode);
  frontier.scope.rootId = rootNode.id;
  return frontier;
}

function findNode(frontier, id) {
  return frontier.nodes.find(node => node.id === id) ?? null;
}

export function addNode(frontier, input = {}, { parentId = null, edgeType = 'link', observedAt = new Date().toISOString() } = {}) {
  assertFrontier(frontier);
  if (!EDGE_TYPES.has(edgeType)) throw fail('XHR_FRONTIER_EDGE_INVALID');
  if (parentId && !findNode(frontier, parentId)) throw fail('XHR_FRONTIER_PARENT_MISSING');
  const candidate = normalizeNodeInput(frontier, input);
  let node = findNode(frontier, candidate.id);
  if (!node) {
    node = candidate;
    frontier.nodes.push(node);
  } else {
    if (candidate.depth !== null) node.depth = node.depth === null ? candidate.depth : Math.min(node.depth, candidate.depth);
    if (node.state === 'candidate' && candidate.state === 'pending') { node.state = 'pending'; node.reason = null; }
    if (candidate.state === 'mutation_excluded') { node.state = candidate.state; node.reason = candidate.reason; }
    if (!node.evidenceSources.includes(candidate.evidenceSource)) node.evidenceSources.push(candidate.evidenceSource);
  }
  if (parentId) {
    const edge = {
      from: parentId,
      to: node.id,
      type: edgeType,
      stage: node.stage,
      evidenceSource: EVIDENCE_SOURCES.has(input.evidenceSource) ? input.evidenceSource : 'manual_metadata',
      observedAt: iso(observedAt, new Date().toISOString()),
    };
    if (!frontier.edges.some(existing => existing.from === edge.from && existing.to === edge.to
      && existing.type === edge.type && existing.stage === edge.stage)) frontier.edges.push(edge);
  }
  frontier.checkedAt = iso(observedAt, frontier.checkedAt);
  return node;
}

export function nextNodes(frontier, { limit = 10, stage = null, includeDeferred = false } = {}) {
  assertFrontier(frontier);
  if (frontier.sharedFailureBoundary && ['blocked_auth', 'blocked_runtime'].includes(frontier.sharedFailureBoundary.state)) return [];
  const max = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 10;
  return frontier.nodes
    .filter(node => (node.state === 'pending' || (includeDeferred && node.state === 'budget_deferred'))
      && (!stage || node.stage === stage))
    .sort((a, b) => (a.depth ?? Number.MAX_SAFE_INTEGER) - (b.depth ?? Number.MAX_SAFE_INTEGER)
      || a.stage.localeCompare(b.stage) || a.id.localeCompare(b.id))
    .slice(0, max)
    .map(node => ({ ...node, pagination: { ...node.pagination } }));
}

export function markNode(frontier, { id, state, attempted = false, at = new Date().toISOString(),
  evidenceSource, reason, pagination, rootDiscovery } = {}) {
  assertFrontier(frontier);
  if (!NODE_STATES.includes(state)) throw fail('XHR_FRONTIER_STATE_INVALID');
  const node = findNode(frontier, id);
  if (!node) throw fail('XHR_FRONTIER_NODE_MISSING');
  const observedAt = iso(at);
  if (!observedAt) throw fail('XHR_FRONTIER_TIMESTAMP_INVALID');
  node.state = state;
  node.reason = reason ? safeCode(reason) : (state === 'mutation_excluded' ? 'mutation_semantics_excluded' : null);
  if (attempted) {
    node.attempts += 1;
    node.lastAttemptAt = observedAt;
  }
  if (EVIDENCE_SOURCES.has(evidenceSource)) {
    node.evidenceSource = evidenceSource;
    if (!node.evidenceSources.includes(evidenceSource)) node.evidenceSources.push(evidenceSource);
  }
  if (pagination) node.pagination = normalizePagination(pagination);
  if (id === frontier.scope.rootId && ['unknown', 'pending', 'observed', 'complete', 'blocked'].includes(rootDiscovery)) {
    frontier.scope.rootDiscovery = rootDiscovery;
  }
  frontier.checkedAt = observedAt;
  return node;
}

export function setFailureBoundary(frontier, boundary = null) {
  assertFrontier(frontier);
  if (boundary === null) { frontier.sharedFailureBoundary = null; return frontier; }
  if (!boundary || !['blocked_auth', 'blocked_runtime', 'budget_deferred'].includes(boundary.state)) throw fail('XHR_FRONTIER_BOUNDARY_INVALID');
  frontier.sharedFailureBoundary = {
    state: boundary.state,
    code: safeCode(boundary.code),
    stage: frontier.scope.stages.includes(boundary.stage) ? boundary.stage : null,
    nodeId: findNode(frontier, boundary.nodeId)?.id ?? null,
    observedAt: iso(boundary.observedAt, frontier.checkedAt),
  };
  return frontier;
}

export function frontierReport(frontier, { generatedAt = new Date().toISOString() } = {}) {
  assertFrontier(frontier);
  const stages = Object.fromEntries(frontier.scope.stages.map(stage => {
    const stageNodes = frontier.nodes.filter(node => node.stage === stage);
    const states = Object.fromEntries(NODE_STATES.map(state => [state, stageNodes.filter(node => node.state === state).length]));
    const paginationNodes = stageNodes.filter(node => node.pagination.kind !== 'none');
    return [stage, {
      observed: stageNodes.length,
      denominator: 'unknown',
      states,
      processed: states.inspected + states.request_observed + states.replay_verified,
      unresolved: states.pending + states.candidate + states.blocked_auth + states.blocked_runtime + states.budget_deferred,
      pagination: {
        nodes: paginationNodes.length,
        terminalObserved: paginationNodes.filter(node => node.pagination.terminal === true && node.pagination.termination !== 'unknown').length,
        denominator: 'unknown',
      },
    }];
  }));
  const totals = Object.fromEntries(NODE_STATES.map(state => [state, frontier.nodes.filter(node => node.state === state).length]));
  const unresolved = frontier.nodes.filter(node => !TERMINAL_STATES.has(node.state));
  const allPagesSettled = frontier.nodes.filter(node => node.pagination.kind !== 'none')
    .every(node => node.pagination.terminal === true && node.pagination.termination !== 'unknown');
  const boundedScopeExhausted = frontier.scope.rootDiscovery === 'complete' && unresolved.length === 0 && allPagesSettled;
  return {
    schema: 'xhr-discovery-frontier-report-v1',
    generatedAt: iso(generatedAt, new Date().toISOString()),
    scope: frontier.scope,
    observedNodes: frontier.nodes.length,
    observedEdges: frontier.edges.length,
    denominator: 'unknown',
    rootDiscovery: frontier.scope.rootDiscovery,
    stages,
    states: totals,
    unresolvedNodes: unresolved.length,
    boundedScopeExhausted,
    wholeSiteCoverageClaimed: false,
    paginationTerminationObserved: allPagesSettled,
    sharedFailureBoundary: frontier.sharedFailureBoundary,
    nextWorkItem: nextNodes(frontier, { limit: 1 })[0]?.id ?? null,
  };
}

function assertFrontier(frontier) {
  if (!frontier || typeof frontier !== 'object' || frontier.schema !== FRONTIER_SCHEMA
    || !Array.isArray(frontier.nodes) || !Array.isArray(frontier.edges) || !frontier.scope) throw fail('XHR_FRONTIER_INVALID');
}

function sanitizeSnapshot(value) {
  if (!value || typeof value !== 'object' || value.schema !== FRONTIER_SCHEMA || !value.scope
    || !Array.isArray(value.scope.stages) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) throw fail('XHR_FRONTIER_INVALID');
  const requestedRoot = value.scope.requestedRoot;
  const origin = cleanOrigin(requestedRoot?.origin);
  const pathname = typeof requestedRoot?.path === 'string' ? normalizePath(requestedRoot.path) : null;
  if (!origin || !pathname) throw fail('XHR_FRONTIER_INVALID');
  const stages = [...new Set(value.scope.stages.filter(stage => typeof stage === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(stage)))];
  if (!stages.length) throw fail('XHR_FRONTIER_INVALID');
  const allowedOrigins = [...new Set([origin, ...(Array.isArray(value.scope.allowedOrigins) ? value.scope.allowedOrigins.map(cleanOrigin).filter(Boolean) : [])])].sort();
  const frontier = {
    schema: FRONTIER_SCHEMA,
    createdAt: iso(value.createdAt, new Date().toISOString()),
    checkedAt: iso(value.checkedAt, new Date().toISOString()),
    scope: {
      requestedRoot: { origin, path: pathname, queryFields: normalizeFieldNames(requestedRoot.queryFields ?? []) },
      allowedOrigins,
      stages,
      rootDiscovery: ['unknown', 'pending', 'observed', 'complete', 'blocked'].includes(value.scope.rootDiscovery) ? value.scope.rootDiscovery : 'unknown',
      totalDenominator: 'unknown',
    },
    sharedFailureBoundary: null,
    nodes: [],
    edges: [],
  };
  for (const rawNode of value.nodes) {
    const node = normalizeNodeInput(frontier, rawNode);
    node.attempts = Number.isSafeInteger(rawNode.attempts) && rawNode.attempts >= 0 ? rawNode.attempts : 0;
    node.lastAttemptAt = iso(rawNode.lastAttemptAt);
    const additionalEvidence = Array.isArray(rawNode.evidenceSources)
      ? rawNode.evidenceSources.filter(source => EVIDENCE_SOURCES.has(source)) : [];
    node.evidenceSources = [...new Set([...node.evidenceSources, ...additionalEvidence])];
    node.id = nodeId(node);
    if (!frontier.nodes.some(existing => existing.id === node.id)) frontier.nodes.push(node);
  }
  frontier.scope.rootId = frontier.nodes.some(node => node.id === value.scope.rootId) ? value.scope.rootId : null;
  if (!frontier.scope.rootId) {
    const root = frontier.nodes.find(node => node.origin === origin && node.path === pathname && node.depth === 0);
    if (!root) throw fail('XHR_FRONTIER_ROOT_MISSING');
    frontier.scope.rootId = root.id;
  }
  for (const edge of value.edges) {
    if (!edge || !frontier.nodes.some(node => node.id === edge.from) || !frontier.nodes.some(node => node.id === edge.to)) continue;
    frontier.edges.push({
      from: edge.from,
      to: edge.to,
      type: EDGE_TYPES.has(edge.type) ? edge.type : 'other',
      stage: safeStage(edge.stage, new Set(stages)) ?? frontier.nodes.find(node => node.id === edge.to).stage,
      evidenceSource: EVIDENCE_SOURCES.has(edge.evidenceSource) ? edge.evidenceSource : 'manual_metadata',
      observedAt: iso(edge.observedAt, frontier.checkedAt),
    });
  }
  if (value.sharedFailureBoundary) {
    try { setFailureBoundary(frontier, value.sharedFailureBoundary); } catch { /* Drop malformed metadata only. */ }
  }
  return frontier;
}

export async function loadFrontier(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw fail('XHR_FRONTIER_PATH_INVALID');
  let info;
  try { info = await stat(filePath); } catch { throw fail('XHR_FRONTIER_READ_FAILED'); }
  if (!info.isFile() || info.size > MAX_SNAPSHOT_BYTES) throw fail('XHR_FRONTIER_SIZE_INVALID');
  let text;
  try { text = await readFile(filePath, 'utf8'); } catch { throw fail('XHR_FRONTIER_READ_FAILED'); }
  try { return sanitizeSnapshot(JSON.parse(text.replace(/^\uFEFF/, ''))); } catch (error) { throw error?.code ? error : fail('XHR_FRONTIER_INVALID'); }
}

export async function writeNewSnapshot(filePath, data) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || path.extname(filePath).toLowerCase() !== '.json') throw fail('XHR_FRONTIER_PATH_INVALID');
  const serialized = JSON.stringify(data, null, 2) + '\n';
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SNAPSHOT_BYTES) throw fail('XHR_FRONTIER_SIZE_INVALID');
  let handle;
  try { handle = await open(filePath, 'wx', 0o600); }
  catch (error) {
    if (error?.code === 'EEXIST') throw fail('XHR_FRONTIER_OUTPUT_EXISTS');
    throw fail('XHR_FRONTIER_WRITE_FAILED');
  }
  try { await handle.writeFile(serialized, 'utf8'); await handle.sync(); }
  catch { throw fail('XHR_FRONTIER_WRITE_FAILED'); }
  finally { await handle.close().catch(() => {}); }
  return { written: true, bytes: Buffer.byteLength(serialized, 'utf8') };
}

export { sanitizeSnapshot };
