import { parse } from 'parse5';
import { contractsFromHar, normalizeCandidate, normalizeMime, normalizeUrl } from './contracts.mjs';
import { discoverHtml } from '../scripts/discover-html.mjs';

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const unique = values => [...new Set(values)].sort(compare);
const canonical = value => JSON.stringify(sortKeys(value));
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort(compare).map(key => [key, sortKeys(value[key])]));
}
function fail(code) { throw Object.assign(new Error(code), { code }); }

function httpUrl(raw, baseUrl) {
  const url = baseUrl === undefined ? new URL(raw) : new URL(raw, baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('non_http_url');
  return url;
}

// Values only participate in a private equality key. Neither values nor their
// hashes are exported. Preserve repeated-query ordering within each key.
function exactTarget(url, queryString = []) {
  const query = new URLSearchParams(url.search);
  const urlNames = new Set(query.keys());
  for (const item of queryString) {
    if (typeof item?.name === 'string' && !urlNames.has(item.name)) query.append(item.name, item.value ?? '');
  }
  query.sort();
  return { origin: url.origin, path: url.pathname, query: [...query] };
}

function harBody(request, sourceEntry) {
  const data = request.postData;
  if (!object(data)) return request.bodySize > 0 ? { unknown: `entry-${sourceEntry}` } : null;
  const header = Array.isArray(request.headers)
    ? request.headers.find(item => typeof item?.name === 'string' && item.name.toLowerCase() === 'content-type') : null;
  const mime = normalizeMime(data.mimeType)
    ?? normalizeMime(header?.value);
  if (typeof data.text === 'string') {
    if (mime === 'application/json') {
      try { return { mime, json: JSON.parse(data.text) }; } catch { /* Keep exact text identity only. */ }
    }
    return { mime, text: data.text };
  }
  if (Array.isArray(data.params)) return { mime, params: data.params };
  return { unknown: `entry-${sourceEntry}` };
}

// discoverHtml deliberately discards raw selectors and coalesces normalized URLs.
// This small parse5 adapter recovers occurrence identity, not discovery semantics:
// targets and kinds must still be present in discoverHtml's inventory. In
// particular, occurrences beyond its evidence display limit must not disappear.
function htmlOccurrences(html, baseUrl, inventory) {
  const nodes = [];
  const stack = [parse(html)];
  while (stack.length) {
    const node = stack.pop();
    nodes.push(node);
    // Match discoverHtml's traversal, including template content ordering.
    if (node.content) stack.push(node.content);
    for (let index = (node.childNodes?.length ?? 0) - 1; index >= 0; index -= 1) stack.push(node.childNodes[index]);
  }
  const attr = (node, name) => node.attrs?.find(item => item.name === name)?.value;
  let effectiveBase = baseUrl;
  const base = nodes.find(node => node.tagName === 'base' && typeof attr(node, 'href') === 'string');
  if (base) {
    try { effectiveBase = new URL(attr(base, 'href'), baseUrl).href; } catch { /* Same fallback as discovery. */ }
  }
  const attributes = { a: 'href', area: 'href', iframe: 'src', frame: 'src', script: 'src', link: 'href' };
  const kinds = { a: 'navigation_link', area: 'navigation_link', iframe: 'embedded_frame', frame: 'embedded_frame',
    script: 'script_asset', link: 'link_resource' };
  const discovered = new Map(inventory.candidates.map(candidate => [canonical({ kind: candidate.kind, target: candidate.target }), candidate]));
  const result = [];
  let ordinal = 0;
  for (const node of nodes) {
    const attribute = attributes[node.tagName];
    if (!attribute) continue;
    const raw = attr(node, attribute);
    if (typeof raw !== 'string' || !raw.trim()) continue;
    ordinal += 1;
    let url, target = null;
    try { url = httpUrl(raw, effectiveBase); target = normalizeUrl(url.href); } catch { /* Report unresolved occurrences. */ }
    const candidate = discovered.get(canonical({ kind: kinds[node.tagName], target }));
    if (candidate) result.push({ candidate, url, element: `${node.tagName}-${ordinal}` });
  }
  return result;
}

// There is no reusable source inspector in scripts/inspect-bundle.mjs: that file
// audits package files and executes at import time. This intentionally bounded
// lexical fallback recognizes literal fetch/axios/XHR targets and URL literals.
// It does NOT parse JavaScript, execute it, expand templates, or infer data values.
function bundleTokens(source) {
  const tokens = [], issues = [];
  let index = 0;
  while (index < source.length) {
    const start = index, character = source[index];
    if (/\s/.test(character)) { index += 1; continue; }
    if (source.startsWith('//', index)) {
      const end = source.indexOf('\n', index + 2);
      index = end < 0 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      if (end < 0) { issues.push({ code: 'bundle_unterminated_comment', offset: start }); break; }
      index = end + 2;
      continue;
    }
    if (['"', "'", '`'].includes(character)) {
      const quote = character;
      let value = '', dynamic = false, valid = true, closed = false;
      index += 1;
      while (index < source.length) {
        const next = source[index++];
        if (next === quote) { closed = true; break; }
        if (quote === '`' && next === '$' && source[index] === '{') dynamic = true;
        if (next !== '\\') { value += next; continue; }
        if (index >= source.length) break;
        const escape = source[index++];
        const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
        if (escape === '\n') continue;
        if (escape === '\r') { if (source[index] === '\n') index += 1; continue; }
        if (escape === 'x' || escape === 'u') {
          const size = escape === 'x' ? 2 : 4;
          const digits = source.slice(index, index + size);
          if (new RegExp(`^[0-9a-fA-F]{${size}}$`).test(digits)) { value += String.fromCharCode(parseInt(digits, 16)); index += size; }
          else valid = false;
        } else value += escapes[escape] ?? escape;
      }
      if (!closed) { issues.push({ code: 'bundle_unterminated_literal', offset: start }); break; }
      tokens.push({ kind: 'literal', value: valid && !dynamic ? value : null, dynamic, offset: start });
      continue;
    }
    const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(index));
    if (identifier) {
      tokens.push({ kind: 'identifier', value: identifier[0], offset: index });
      index += identifier[0].length;
    } else { tokens.push({ kind: 'punctuation', value: character, offset: index }); index += 1; }
  }
  return { tokens, issues };
}

function inspectSourceBundle(source) {
  const { tokens, issues } = bundleTokens(source);
  const targets = [], used = new Set();
  const value = index => tokens[index]?.value;
  const literal = index => tokens[index]?.kind === 'literal' && typeof value(index) === 'string';
  const push = (index, method, kind, incomplete = false) => {
    used.add(index);
    if (!literal(index)) { issues.push({ code: 'bundle_dynamic_target', offset: tokens[index]?.offset ?? source.length }); return; }
    targets.push({ raw: value(index), method, kind, incomplete, offset: tokens[index].offset });
  };
  for (let index = 0; index < tokens.length; index += 1) {
    if (value(index) === 'fetch' && value(index + 1) === '(') {
      if (![')', ','].includes(value(index + 3))) {
        used.add(index + 2);
        issues.push({ code: 'bundle_dynamic_target', offset: tokens[index + 2]?.offset ?? source.length });
        continue;
      }
      let method = 'UNKNOWN', incomplete = true;
      if (value(index + 3) === ')') { method = 'GET'; incomplete = false; }
      else if (value(index + 3) === ',' && value(index + 4) === '{') {
        let depth = 1, hasBody = false, uncertain = false, declaredMethod = 'GET';
        for (let end = index + 5; end < tokens.length && depth; end += 1) {
          const token = value(end);
          if (depth === 1 && token === 'method') {
            if (value(end + 1) === ':' && literal(end + 2) && [',', '}'].includes(value(end + 3))) declaredMethod = value(end + 2);
            else uncertain = true;
          }
          if (depth === 1 && token === 'body' && value(end + 1) === ':') hasBody = true;
          if (depth === 1 && ['.', '['].includes(token)) uncertain = true;
          if (['{', '[', '('].includes(token)) depth += 1;
          if (['}', ']', ')'].includes(token)) depth -= 1;
          if (!depth && value(end + 1) === ')' && !uncertain) { method = declaredMethod; incomplete = hasBody; }
        }
      }
      push(index + 2, method, 'fetch_literal', incomplete);
    } else if (value(index) === 'axios' && value(index + 1) === '.'
      && ['get', 'head', 'options', 'post', 'put', 'patch', 'delete'].includes(value(index + 2)) && value(index + 3) === '(') {
      if ([')', ','].includes(value(index + 5))) push(index + 4, value(index + 2).toUpperCase(), 'axios_literal', value(index + 5) !== ')');
      else { used.add(index + 4); issues.push({ code: 'bundle_dynamic_target', offset: tokens[index + 4]?.offset ?? source.length }); }
    } else if (value(index) === '.' && value(index + 1) === 'open' && value(index + 2) === '('
      && literal(index + 3) && /^[A-Za-z]{3,12}$/.test(value(index + 3)) && value(index + 4) === ',') {
      if ([')', ','].includes(value(index + 6))) {
        push(index + 5, value(index + 3), 'xhr_open_literal', !['GET', 'HEAD'].includes(value(index + 3).toUpperCase()));
      } else { used.add(index + 5); issues.push({ code: 'bundle_dynamic_target', offset: tokens[index + 5]?.offset ?? source.length }); }
    }
  }
  for (let index = 0; index < tokens.length; index += 1) {
    if (!used.has(index) && literal(index) && /^(?:https?:\/\/|\/(?!\/)|\.\.?\/)/.test(value(index))) {
      push(index, 'UNKNOWN', 'url_literal', true);
    }
  }
  return { targets, issues };
}

function profileFields(operation, group) {
  const fields = operation[`${group}Fields`];
  if (fields !== undefined) {
    if (!Array.isArray(fields) || fields.some(field => typeof field !== 'string')) return null;
    return fields;
  }
  const typed = operation.inputs?.[group];
  if (typed === undefined) return [];
  return object(typed) ? Object.keys(typed) : null;
}

/**
 * Deterministic, synchronous preparation of supplied local evidence only.
 * Profile metadata is compared, never validated as executable or executed.
 * Malformed input containers throw; incomplete evidence becomes explicit gaps.
 */
export function prepareOperations(options = {}) {
  if (!object(options)) fail('XHR_PREPARE_OPTIONS_INVALID');
  const { har, html, bundles = [], baseUrl, intent, profile } = options;
  if (!Array.isArray(bundles)) fail('XHR_PREPARE_BUNDLES_INVALID');
  if (har === undefined && html === undefined && !bundles.length) fail('XHR_PREPARE_INPUT_REQUIRED');
  if (intent !== undefined && typeof intent !== 'string') fail('XHR_PREPARE_INTENT_INVALID');
  if (baseUrl !== undefined) {
    try { if (typeof baseUrl !== 'string') throw new Error(); httpUrl(baseUrl); }
    catch { fail('XHR_PREPARE_BASE_URL_INVALID'); }
  }
  if (html !== undefined && (typeof html !== 'string' || !html.trim())) fail('XHR_PREPARE_HTML_INVALID');
  if (profile !== undefined && (!object(profile) || profile.operations !== undefined && !object(profile.operations))) fail('XHR_PREPARE_PROFILE_INVALID');
  const sources = Array.from(bundles, (bundle, index) => {
    if (typeof bundle === 'string' && bundle.trim()) return { name: `bundle-${index + 1}`, source: bundle };
    if (!object(bundle) || typeof bundle.name !== 'string' || !bundle.name.trim()
      || typeof bundle.source !== 'string' || !bundle.source.trim()) fail('XHR_PREPARE_BUNDLE_INVALID');
    return { name: bundle.name, source: bundle.source };
  });
  const merged = new Map(), identities = new Map(), variants = new Map(), gapMap = new Map(), stages = [];
  const addGap = (code, details = {}) => {
    const gap = { code, ...details };
    gapMap.set(canonical(gap), gap);
  };
  const add = (shape, url, body, provenance, observation = null, incomplete = false) => {
    const normalized = normalizeCandidate(shape);
    const target = exactTarget(url, shape.extraQuery);
    const equalityKey = canonical({ normalizedId: normalized.id, target, body });
    let candidate = merged.get(equalityKey);
    if (!candidate) {
      const { id: normalizedId, evidence, ...fields } = normalized;
      const variant = (variants.get(normalizedId) ?? 0) + 1;
      variants.set(normalizedId, variant);
      const id = `${normalizedId}-${variant}`;
      candidate = { id, normalizedId, ...fields, state: 'candidate', requestObserved: false,
        replayVerified: false, valuesRecorded: false, identityComplete: !incomplete && normalized.method !== 'UNKNOWN',
        kinds: [], provenance: [], observations: [] };
      merged.set(equalityKey, candidate);
      identities.set(id, { path: target.path });
    }
    candidate.kinds = unique([...candidate.kinds, provenance.kind]);
    candidate.provenance.push(provenance);
    candidate.identityComplete &&= !incomplete && normalized.method !== 'UNKNOWN';
    if (observation) {
      candidate.state = 'request_observed'; candidate.requestObserved = true;
      // The upstream contract's response digest is useful for replay tooling but
      // does not belong in this value-free candidate inventory.
      const { responseSha256, ...metadata } = observation;
      candidate.observations.push(metadata);
    }
    return candidate;
  };
  const stage = (name, supplied, sourcesCount, operation) => {
    if (!supplied) {
      stages.push({ stage: name, status: 'not_provided', sources: 0, candidates: 0 });
      addGap('source_not_provided', { stage: name });
      return;
    }
    const before = gapMap.size;
    const status = operation();
    const count = [...merged.values()].filter(candidate => candidate.provenance.some(item => item.stage === name)).length;
    stages.push({ stage: name, status: status ?? (gapMap.size > before ? 'partial' : 'complete'), sources: sourcesCount, candidates: count });
  };

  stage('har', har !== undefined, 1, () => {
    const inventory = contractsFromHar(har, { generatedAt: '1970-01-01T00:00:00.000Z' });
    if (inventory.sourceEvidence.entriesSkipped) addGap('har_entries_skipped', { stage: 'har', count: inventory.sourceEvidence.entriesSkipped });
    for (const contract of inventory.contracts) {
      for (const observation of contract.observations) {
        const request = har.log.entries[observation.sourceEntry - 1].request;
        const body = harBody(request, observation.sourceEntry);
        const candidate = add({ ...contract, extraQuery: Array.isArray(request.queryString) ? request.queryString : [] },
          httpUrl(request.url), body, { stage: 'har', source: 'HAR', sourceReference: `entry-${observation.sourceEntry}`,
            kind: 'har_request', methodBasis: 'request_observed', normalizedId: contract.id }, observation, body?.unknown !== undefined);
        if (body?.unknown !== undefined) addGap('request_body_identity_unknown', { stage: 'har', candidateId: candidate.id });
        if (!observation.responseBodyAvailable) addGap('response_body_unavailable', { stage: 'har', candidateId: candidate.id, sourceEntry: observation.sourceEntry });
        if (observation.responseSchema?.state) addGap('response_schema_unavailable', { stage: 'har', candidateId: candidate.id,
          sourceEntry: observation.sourceEntry, reason: observation.responseSchema.state });
      }
    }
  });
  stage('html', html !== undefined, 1, () => {
    if (baseUrl === undefined) { addGap('base_url_required', { stage: 'html' }); return 'blocked'; }
    const inventory = discoverHtml(html, { baseUrl });
    for (const occurrence of htmlOccurrences(html, baseUrl, inventory)) {
      if (!occurrence.url) {
        addGap('html_target_unresolved', { stage: 'html', sourceReference: occurrence.element, reason: occurrence.candidate.reason });
        continue;
      }
      add({ url: occurrence.url.href, method: 'GET' }, occurrence.url, null,
        { stage: 'html', source: 'HTML', sourceReference: occurrence.element, kind: occurrence.candidate.kind,
          discoveryId: occurrence.candidate.id, methodBasis: 'html_resource_get_candidate', sameOrigin: occurrence.candidate.sameOrigin });
    }
    if (!inventory.candidates.length) addGap('no_candidates_in_source', { stage: 'html' });
  });
  stage('bundles', sources.length > 0, sources.length, () => {
    for (const [index, bundle] of sources.entries()) {
      const bundleReference = `bundle-${index + 1}`;
      const inspected = inspectSourceBundle(bundle.source);
      addGap('bundle_lexical_inspection_only', { stage: 'bundles', name: bundle.name, bundleReference });
      for (const issue of inspected.issues) addGap(issue.code, { stage: 'bundles', name: bundle.name, bundleReference, offset: issue.offset });
      for (const target of inspected.targets) {
        let url;
        try { url = httpUrl(target.raw, baseUrl); }
        catch {
          addGap('bundle_target_unresolved', { stage: 'bundles', name: bundle.name, bundleReference, offset: target.offset,
            reason: baseUrl === undefined && !/^https?:\/\//i.test(target.raw) ? 'base_url_required' : 'invalid_or_non_http_url' });
          continue;
        }
        const body = target.incomplete ? { unknown: `${bundleReference}:${target.offset}` } : null;
        const candidate = add({ url: url.href, method: target.method }, url, body,
          { stage: 'bundles', source: 'source', name: bundle.name, bundleReference,
            sourceReference: `source-${target.offset}`, kind: target.kind, methodBasis: target.kind }, null, target.incomplete);
        if (target.incomplete) addGap('bundle_request_details_unknown', { stage: 'bundles', candidateId: candidate.id });
      }
      if (!inspected.targets.length) addGap('no_candidates_in_source', { stage: 'bundles', name: bundle.name, bundleReference });
    }
  });

  const candidates = [...merged.values()].sort((a, b) => compare(a.id, b.id));
  const normalizedGroups = new Map();
  for (const candidate of candidates) {
    candidate.provenance.sort((a, b) => compare(canonical(a), canonical(b)));
    candidate.observations.sort((a, b) => a.sourceEntry - b.sourceEntry);
    const group = normalizedGroups.get(candidate.normalizedId) ?? [];
    group.push(candidate.id); normalizedGroups.set(candidate.normalizedId, group);
    if (!candidate.requestObserved) addGap('request_not_observed', { candidateId: candidate.id });
    if (candidate.operationFields.length) addGap('selector_values_omitted', { candidateId: candidate.id, fields: candidate.operationFields });
    if (candidate.method === 'UNKNOWN') addGap('request_method_unknown', { candidateId: candidate.id });
  }
  for (const [normalizedId, candidateIds] of normalizedGroups) {
    if (candidateIds.length > 1) addGap('normalized_selector_collision', { normalizedId, candidateIds: unique(candidateIds),
      reason: 'distinct_exact_or_unresolved_identities_kept_separate' });
  }

  const implemented = [];
  for (const [operationId, operation] of Object.entries(profile?.operations ?? {}).sort(([a], [b]) => compare(a, b))) {
    let shape;
    const queryFields = object(operation) ? profileFields(operation, 'query') : null;
    const bodyFields = object(operation) ? profileFields(operation, 'body') : null;
    try {
      if (!object(operation) || typeof operation.origin !== 'string' || typeof operation.path !== 'string'
        || !operation.path.startsWith('/') || !/^[A-Za-z]{3,12}$/.test(operation.method ?? '') || !queryFields || !bodyFields) throw new Error();
      shape = normalizeCandidate({ ...operation, path: operation.path.replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g, ':id'), queryFields, bodyFields });
    } catch {
      implemented.push({ operationId, state: 'declared_in_profile', match: 'metadata_incomplete', candidateIds: [] });
      addGap('profile_operation_metadata_incomplete', { operationId });
      continue;
    }
    const fieldsMatch = (candidate, group) => {
      const observed = candidate[`${group}Fields`], declared = shape[`${group}Fields`];
      if (canonical(observed) === canonical(declared)) return true;
      // Typed profiles can describe optional fields absent from a recording.
      // Such a subset is only a review match, never an exact/executable match.
      return object(operation.inputs?.[group]) && observed.every(field => declared.includes(field));
    };
    const matches = candidates.filter(candidate => candidate.method === shape.method && candidate.origin === shape.origin
      && candidate.path === shape.path && fieldsMatch(candidate, 'query') && fieldsMatch(candidate, 'body')
      && (operation.encoding === undefined || candidate.encoding === shape.encoding));
    const exactShape = matches.length === 1 && matches[0].identityComplete && !matches[0].operationFields.length
      && canonical(matches[0].queryFields) === canonical(shape.queryFields) && canonical(matches[0].bodyFields) === canonical(shape.bodyFields)
      && identities.get(matches[0].id).path === operation.path && !/[{}:]/.test(operation.path);
    const match = !matches.length ? 'not_discovered' : exactShape ? 'exact_shape' : 'normalized_only';
    implemented.push({ operationId, state: 'declared_in_profile', match, candidateIds: matches.map(candidate => candidate.id) });
    if (match === 'not_discovered') addGap('profile_operation_not_discovered', { operationId });
    if (match === 'normalized_only') addGap('profile_match_requires_review', { operationId, candidateIds: matches.map(candidate => candidate.id) });
  }
  const discovered = candidates.map(candidate => ({ candidateId: candidate.id,
    operationIds: implemented.filter(operation => operation.candidateIds.includes(candidate.id)).map(operation => operation.operationId) }));
  if (profile !== undefined) {
    addGap('profile_implementation_not_verified');
    for (const capability of discovered) {
      if (!capability.operationIds.length) addGap('discovered_capability_not_declared', { candidateId: capability.candidateId });
    }
  }
  stages.push({ stage: 'profile', status: profile === undefined ? 'not_provided' : 'metadata_only',
    operations: implemented.length, matched: implemented.filter(operation => operation.candidateIds.length).length });
  if (!candidates.length) addGap('no_candidates_discovered');
  addGap('offline_preparation_not_replay_verification');
  const coverage = {
    scope: 'supplied_sources_only', complete: false, totalCapabilities: null,
    liveNetworkUsed: false, requestsExecuted: 0, replayVerified: 0,
    candidates: candidates.length, requestObserved: candidates.filter(candidate => candidate.requestObserved).length,
    candidateOnly: candidates.filter(candidate => !candidate.requestObserved).length,
    bySource: Object.fromEntries(['HAR', 'HTML', 'source'].map(source => [source,
      candidates.filter(candidate => candidate.provenance.some(item => item.source === source)).length])),
    profileProvided: profile !== undefined, implemented, discovered,
    implementedCount: implemented.length,
    discoveredOnlyCount: discovered.filter(capability => !capability.operationIds.length).length,
    implementationMeaning: 'profile_declaration_only_not_executable_verification',
  };
  return { schemaVersion: 1, intent: intent ?? null, candidates,
    gaps: [...gapMap.values()].sort((a, b) => compare(canonical(a), canonical(b))), coverage, stages };
}
