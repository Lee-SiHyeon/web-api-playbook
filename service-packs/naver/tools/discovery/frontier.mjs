import { createHash } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const ROOT = 'https://admin.blog.naver.com/4053103';
const HOSTS = new Set(['admin.blog.naver.com', 'blog.stat.naver.com']);
const idOf = value => createHash('sha256').update(value).digest('hex').slice(0, 24);

export function identity(raw) {
  if (typeof raw !== 'string') throw new Error('Expected a string URL');
  // Preserve JavaScript controls as candidates. Do not execute or repair malformed source strings.
  if (!raw.startsWith('https://')) return { id: idOf(raw), url: raw, navigable: false, reason: 'requires_fresh_DOM_observation' };
  const u = new URL(raw);
  if (u.username || u.password || !HOSTS.has(u.hostname) || u.port) return { id: idOf(raw), url: raw, navigable: false, reason: 'outside_blog_management_scope' };
  if ([...u.searchParams.keys()].some(k => /token|password|cookie|secret|session|authorization|csrf/i.test(k))) throw new Error('Sensitive query is not allowed in a durable frontier');
  const actors = u.searchParams.getAll('blogId');
  const actorPath = u.hostname === 'admin.blog.naver.com' ? u.pathname.match(/^\/(\d+)(?:\/|$)/)?.[1] : null;
  if (actors.some(v => v !== '4053103') || (actorPath && actorPath !== '4053103')) return { id: idOf(raw), url: raw, navigable: false, reason: 'different_actor_scope' };
  u.hash = '';
  // Identical duplicate selectors collapse; distinct values remain a distinct request identity.
  const seen = new Set();
  const pairs = [...u.searchParams].filter(pair => { const key = JSON.stringify(pair); if (seen.has(key)) return false; seen.add(key); return true; });
  u.search = new URLSearchParams(pairs.sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv))).toString();
  return { id: idOf(u.href), url: u.href, navigable: true, reason: null };
}

export function buildFrontier(legacy, { checkedAt = new Date().toISOString(), boundary = null } = {}) {
  const nodes = new Map();
  const edges = new Map();
  const add = (raw, source) => {
    const canonical = identity(raw);
    let node = nodes.get(canonical.id);
    if (!node) {
      node = { ...canonical, aliases: [], sources: [], depth: source.depth ?? null, state: canonical.navigable ? source.state ?? 'pending' : 'candidate', attempts: 0, last_attempt_at: null, evidence_source: 'historical_DOM', historicalStates: [], incoming: [] };
      nodes.set(node.id, node);
    }
    if (!node.aliases.includes(raw)) node.aliases.push(raw);
    if (source.index !== undefined && !node.sources.includes(source.index)) node.sources.push(source.index);
    if (source.state && !node.historicalStates.includes(source.state)) node.historicalStates.push(source.state);
    node.attempts = Math.max(node.attempts, source.attempts ?? 0);
    if (source.depth !== undefined) node.depth = node.depth === null ? source.depth : Math.min(node.depth, source.depth);
    if (source.state === 'mutation_excluded') {
      node.state = 'mutation_excluded'; node.reason = 'historical_mutation_exclusion_preserved';
    } else if (source.state === 'inspected' && node.navigable && node.state !== 'mutation_excluded') {
      node.state = 'inspected'; node.observationPeriod = '2026-09-06';
    }
    return node;
  };
  const addEdge = (from, to, type) => {
    if (!from || !to) return;
    const a = add(from, {}), b = add(to, {});
    const edge = { from: a.id, to: b.id, type, evidence_source: 'historical_DOM' };
    edges.set(JSON.stringify(edge), edge);
    if (!b.incoming.includes(a.id)) b.incoming.push(a.id);
  };
  legacy.nodes.forEach((n, index) => add(n.url, { ...n, index }));
  legacy.nodes.forEach(n => {
    addEdge(n.parent, n.url, 'menu_link');
    for (const frame of n.frames ?? []) {
      if (frame === n.url) continue;
      // A seen frame URL is a candidate until it has its own inspection receipt.
      add(frame, { depth: (n.depth ?? 0) + 1 });
      addEdge(n.url, frame, 'page_iframe');
    }
  });
  for (const edge of legacy.edges ?? []) addEdge(edge.from, edge.to, edge.type ?? 'link');
  const root = add(ROOT, { depth: 0 });
  return {
    schemaVersion: 1,
    scope: { requestedRoot: ROOT, rootId: root.id, actor: '4053103', stages: ['management_navigation', 'observed_read_contracts'], rootDiscovery: 'historically_observed_current_session_unverified', exclusions: ['publishing_and_other_mutations', 'unrelated_Naver_services', 'bulk_personal_record_export'] },
    checkedAt, legacyCheckpoint: 'discovery/recursive-map.json', sourceNodeCount: legacy.nodes.length,
    sharedFailureBoundary: boundary,
    nodes: [...nodes.values()], edges: [...edges.values()],
  };
}

export function nextNodes(frontier, limit = 10) {
  if (frontier.sharedFailureBoundary) return [];
  return frontier.nodes.filter(n => n.navigable && ['pending', 'budget_deferred'].includes(n.state))
    .sort((a, b) => (a.depth ?? Infinity) - (b.depth ?? Infinity) || a.id.localeCompare(b.id)).slice(0, limit);
}

export function recordObservation(frontier, { url, links = [], frames = [], observedAt, evidenceSource = 'DOM' }) {
  if (!['DOM', 'network'].includes(evidenceSource) || !observedAt) throw new Error('Observation time and source required');
  const parentIdentity = identity(url);
  const parent = frontier.nodes.find(n => n.id === parentIdentity.id);
  if (!parent || !parent.navigable || parent.state === 'mutation_excluded') throw new Error('Observation parent is not an eligible queued node');
  for (const [type, children] of [['menu_link', links], ['page_iframe', frames]]) {
    for (const child of children) {
      const c = identity(child.url ?? child);
      let node = frontier.nodes.find(n => n.id === c.id);
      if (!node) {
        const readOnly = typeof child === 'object' && child.readOnly === true;
        node = { ...c, aliases: [child.url ?? child], sources: [], incoming: [], depth: (parent.depth ?? 0) + 1, state: c.navigable && readOnly ? 'pending' : 'candidate', reason: c.reason ?? (readOnly ? null : 'operation_semantics_require_review'), attempts: 0, last_attempt_at: null, evidence_source: evidenceSource, historicalStates: [] };
        frontier.nodes.push(node);
      }
      if (!node.incoming.includes(parent.id)) node.incoming.push(parent.id);
      if (!frontier.edges.some(e => e.from === parent.id && e.to === node.id && e.type === type)) frontier.edges.push({ from: parent.id, to: node.id, type, evidence_source: evidenceSource, observedAt });
    }
  }
  parent.state = evidenceSource === 'network' ? 'request_observed' : 'inspected';
  parent.attempts += 1;
  parent.last_attempt_at = observedAt;
  parent.evidence_source = evidenceSource;
  frontier.checkedAt = observedAt;
  return frontier;
}

export function receipt(frontier, contractCount) {
  const counts = {};
  for (const n of frontier.nodes) counts[n.state] = (counts[n.state] ?? 0) + 1;
  const unresolved = frontier.nodes.filter(n => ['pending', 'candidate', 'budget_deferred', 'blocked_runtime', 'blocked_auth'].includes(n.state));
  return {
    checkedAt: frontier.checkedAt, scope: frontier.scope, checkpoint: 'discovery/frontier.json',
    navigation: { sourceNodes: frontier.sourceNodeCount, canonicalNodes: frontier.nodes.length, edges: frontier.edges.length, states: counts, unresolved: unresolved.length },
    conversion: { captured: { historicalReadContracts: contractCount, newThisRun: 0 }, client_exists: { implementedReadOperations: contractCount }, remnant_free: true, credential_propagated: false, live_replay: { thisRun: 0, historicalResumeBatch: 10 } },
    sharedFailureBoundary: frontier.sharedFailureBoundary,
    nextWorkItemAfterRecovery: nextNodes({ ...frontier, sharedFailureBoundary: null }, 1)[0]?.url ?? null,
    recoveryPrerequisite: 'Restore the authorized browser connection, verify the intended actor at the root, and observe an allowed Network event',
    fullRecursiveCoverage: false,
    limitations: ['No new navigation or XHR observation in this blocked run', 'No current authorized API session reached the independent client', 'Navigation receipts do not establish all filters, forms, or pagination coverage'],
  };
}

export async function checkpoint(file, data) {
  const temporary = `${file}.tmp-${idOf(`${Date.now()}-${Math.random()}`)}`;
  await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await rename(temporary, file);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const frontier = JSON.parse(await readFile(new URL('../../discovery/frontier.json', import.meta.url), 'utf8'));
  console.log(JSON.stringify({ scope: frontier.scope, sharedFailureBoundary: frontier.sharedFailureBoundary, next: nextNodes(frontier).map(n => ({ id: n.id, url: n.url, depth: n.depth })) }, null, 2));
}
