import { ROOTS, japanDestination, japanDocument, sha, fail } from './japan-http.mjs';
import { parseRakutenHome, parseRakutenListing, parseRakutenProduct } from './rakuten-public-catalog.mjs';
import { parseYahooNavigation, parseYahooProduct } from './yahoo-jp-public.mjs';

export function createJapanPublicClient({ service, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (!ROOTS[service]) fail('JAPAN_SERVICE_INVALID');
  async function read(url) {
    const fetched = await japanDocument(service, url, { fetchImpl, now });
    let data;
    try {
      if (service === 'rakuten') data = fetched.kind === 'home' ? parseRakutenHome(fetched.html)
        : fetched.kind === 'product' ? parseRakutenProduct(fetched.html, fetched.url) : parseRakutenListing(fetched.html, fetched.url);
      else data = fetched.kind === 'product' ? parseYahooProduct(fetched.html, fetched.url)
        : ['home', 'category'].includes(fetched.kind) ? parseYahooNavigation(fetched.html, fetched.url)
          : fail('YAHOO_LISTING_RESPONSE_CONTRACT_UNVERIFIED');
    } catch (e) {
      if (e.code) { e.receipt ??= fetched.requests.at(-1); throw e; }
      fail('JAPAN_SCHEMA_INVALID', fetched.requests.at(-1));
    }
    return { schema: 'web-api-japan-retail-result-v1', ok: true,
      service: service === 'rakuten' ? 'rakuten-ichiba' : 'yahoo-shopping-jp', operation: fetched.kind,
      url: fetched.url, checkedAt: fetched.checkedAt, executionMode: 'pure_http', browserUsed: false, credentialsUsed: false,
      anonymous: true, writesSubmitted: 0, completeCatalog: false, affiliateLinkVerified: false,
      contractProvenance: { kind: 'direct_http_observed', responseFormat: 'html_document',
        sourceURL: new URL(fetched.url).origin + new URL(fetched.url).pathname },
      fiveStates: { captured: false, client_exists: true, credential_propagated: false, remnant_free: true, live_replay: true },
      credentialStatus: 'not_required_for_public_document', requests: fetched.requests, data,
      dataSha256: sha(JSON.stringify(data)) };
  }
  function search({ query, categoryId, page = 1 } = {}) {
    if (service !== 'rakuten') fail('YAHOO_PUBLIC_SEARCH_CONTRACT_UNVERIFIED');
    if (typeof query !== 'string' || !query.trim() || query.length > 120 || /[\x00-\x1f\x7f/\\?#]/.test(query)
      || categoryId !== undefined && !/^\d{1,12}$/.test(String(categoryId))
      || !Number.isSafeInteger(page) || page < 1 || page > 150) fail('JAPAN_SEARCH_INPUT_INVALID');
    return read('https://search.rakuten.co.jp/search/mall/' + encodeURIComponent(query) + '/'
      + (categoryId === undefined ? '' : categoryId + '/') + (page > 1 ? '?p=' + page : ''));
  }
  return Object.freeze({ home: () => read(ROOTS[service]), read, search });
}

export async function crawlJapanPublic({ service, state, maxPages = 5, client = createJapanPublicClient({ service }), checkpoint } = {}) {
  if (!ROOTS[service] || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) fail('JAPAN_CRAWL_INPUT_INVALID');
  if (state === undefined) state = { schema: 'web-api-japan-frontier-v1', service, root: ROOTS[service],
    nodes: [{ url: ROOTS[service], kind: 'home', depth: 0, state: 'pending', attempts: 0 }], edges: [], runs: [] };
  else state = structuredClone(state);
  if (state.schema !== 'web-api-japan-frontier-v1' || state.service !== service || state.root !== ROOTS[service]
    || !Array.isArray(state.nodes) || !Array.isArray(state.edges) || !Array.isArray(state.runs)
    || state.nodes.length > 50000 || state.nodes.some(n => japanDestination(service, n.url)?.url !== n.url
      || japanDestination(service, n.url)?.kind !== n.kind
      || !['pending','replay_verified','blocked_http','blocked_schema','adapter_pending'].includes(n.state)
      || !Number.isInteger(n.depth) || n.depth < 0)
    || new Set(state.nodes.map(n => n.url)).size !== state.nodes.length
    || state.nodes.filter(n => n.url === state.root && n.depth === 0).length !== 1) fail('JAPAN_FRONTIER_INVALID');
  const known = new Map(state.nodes.map(n => [n.url, n]));
  const edgeKeys = new Set(state.edges.map(e => e.from + '\0' + e.to + '\0' + e.relation));
  let reads = 0;
  while (reads < maxPages) {
    const node = state.nodes.filter(n => n.state === 'pending').sort((a,b) => a.depth - b.depth)[0];
    if (!node) break;
    if (node.kind === 'reviews' || service === 'yahoo' && node.kind === 'listing') {
      node.state = 'adapter_pending'; node.stopReason = node.kind === 'reviews' ? 'use_separate_review_adapter' : 'listing_response_contract_unverified';
      continue;
    }
    node.attempts++; reads++;
    try {
      const run = await client.read(node.url);
      node.state = 'replay_verified'; node.lastAttemptAt = run.checkedAt; node.evidenceSource = 'direct_http_document';
      node.resultIndex = state.runs.length; state.runs.push(run);
      const add = (target, from, relation, depth) => {
        const dest = japanDestination(service, target);
        if (!dest) return;
        if (!known.has(dest.url)) {
          const child = { ...dest, depth, state: 'pending', attempts: 0 };
          known.set(dest.url, child); state.nodes.push(child);
        }
        const key = from + '\0' + dest.url + '\0' + relation;
        if (!edgeKeys.has(key)) { edgeKeys.add(key); state.edges.push({ from, to: dest.url, relation }); }
      };
      for (const edge of run.data.edges ?? []) {
        // Structural menu IDs remain edges even when they are not fetchable URLs.
        const key = edge.from + '\0' + edge.to + '\0' + edge.relation;
        if (!edgeKeys.has(key)) { edgeKeys.add(key); state.edges.push(edge); }
      }
      for (const link of run.data.links ?? []) add(link.url, link.parent ?? node.url, link.relation, node.depth + 1);
      for (const row of run.data.products ?? []) add(row.url, node.url, 'listing_to_product', node.depth + 1);
      if (run.data.pagination?.nextUrl) add(run.data.pagination.nextUrl, node.url, 'listing_next_page', node.depth + 1);
    } catch (error) {
      node.state = error.receipt?.httpStatus && error.receipt.httpStatus !== 200 ? 'blocked_http' : 'blocked_schema';
      node.stopReason = /^[A-Z][A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'JAPAN_READ_FAILED';
      node.httpStatus = error.receipt?.httpStatus ?? null;
      node.lastAttemptAt = new Date().toISOString(); node.evidenceSource = 'direct_http_attempt';
    }
    if (checkpoint) await checkpoint(state);
  }
  state.collection = { pagesReadThisRun: reads, verified: state.nodes.filter(n => n.state === 'replay_verified').length,
    pending: state.nodes.filter(n => n.state === 'pending').length,
    blocked: state.nodes.filter(n => n.state.startsWith('blocked_')).length,
    adapterPending: state.nodes.filter(n => n.state === 'adapter_pending').length,
    frontierExhausted: !state.nodes.some(n => n.state === 'pending'), completeCatalog: false,
    stopReason: state.nodes.some(n => n.state === 'pending') ? 'page_budget' : 'known_frontier_processed' };
  if (checkpoint) await checkpoint(state);
  return state;
}
