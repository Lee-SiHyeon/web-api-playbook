import { createHash } from 'node:crypto';
import { contractsFromHar, normalizeUrl, normalizeMime, normalizeFieldNames, schemaOf } from './contracts.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const natural = value => Number.isSafeInteger(value) && value >= 0;
const fail = () => { throw new Error('BROWSER_EVIDENCE_INVALID'); };

export function summarizeAgentHar(har) {
  const inventory = contractsFromHar(har);
  const entries = har.log.entries;
  const bodyMissing = entries.filter(entry => typeof entry.response?.content?.text !== 'string').length;
  const responseMissing = entries.filter(entry => !Number.isInteger(entry.response?.status) || entry.response.status < 100).length;
  // HAR cannot prove the collector saw all events or that an absent body is empty.
  return { schema: 'web-api-browser-evidence-v1', producer: 'agent-browser-har',
    valuesRecorded: false, rawHeadersRecorded: false, directHttpReplay: false,
    coverage: { entries: entries.length, entriesSkipped: inventory.sourceEvidence.entriesSkipped, bodyMissing, responseMissing,
      initiatorStacks: 'not_provided_by_agent_browser_har', redirectAncestry: 'not_attested',
      fullCapture: 'unknown', originalWireBody: 'not_attested' },
    inventory };
}

export function compareContractShapes(left, right) {
  const ready = value => value?.schema === 'web-api-browser-evidence-v1' && value.producer === 'agent-browser-har' &&
    value.coverage.entries > 0 && value.coverage.entriesSkipped === 0 && value.coverage.bodyMissing === 0 && value.coverage.responseMissing === 0 &&
    value.inventory.contracts.every(contract => contract.observations.every(observation => observation.responseSchema?.state !== 'invalid_json'));
  const base = { scope: 'sanitized_contract_shapes_only', websiteEquivalent: 'unknown', valuesCompared: false };
  if (!ready(left) || !ready(right)) return { ...base, result: 'unknown', reason: 'incomplete_body_or_response_evidence' };
  const project = value => value.inventory.contracts.map(c => ({ method: c.method, origin: c.origin, path: c.path,
    queryFields: c.queryFields, bodyFields: c.bodyFields, encoding: c.encoding,
    responses: [...new Set(c.observations.map(o => JSON.stringify({ status: o.status, mime: o.responseMime, schema: o.responseSchema })))].sort() }))
    .map(item => JSON.stringify(item)).sort();
  return { ...base, result: JSON.stringify(project(left)) === JSON.stringify(project(right)) ? 'same_contract_shapes' : 'different_contract_shapes' };
}

// Narrow import adapter for REA's pinned browser scenario payload. It deliberately
// does not authenticate the upstream Evidence envelope or implement REA equality.
export function summarizeReaCapture(input) {
  const capture = input?.predicate_type === 'rea.browser-scenario-capture' ? input.normalized_result : input;
  if (!object(capture) || !object(capture.events) || !Array.isArray(capture.events.items) ||
    !Array.isArray(capture.steps) || !natural(capture.scenario?.action_count) ||
    capture.steps.length !== capture.scenario.action_count + 1 || capture.steps.length > 10000 ||
    capture.events.items.length > 100000 || capture.events.retained !== capture.events.items.length || !natural(capture.events.dropped)) fail();
  const steps = capture.steps, events = capture.events.items, seq = new Map(), requests = new Map(), grouped = new Map();
  const stepIds = new Set();
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].step_index !== i || typeof steps[i].step_id !== 'string' || !steps[i].step_id || stepIds.has(steps[i].step_id)) fail();
    stepIds.add(steps[i].step_id);
  }
  for (const event of events) {
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 1 || seq.has(event.sequence) ||
      !natural(event.step_index) || event.step_index >= steps.length) fail();
    seq.set(event.sequence, event);
    if (typeof event.transaction_id === 'string') {
      if (!grouped.has(event.transaction_id)) grouped.set(event.transaction_id, []);
      grouped.get(event.transaction_id).push(event);
    }
    if (event.kind === 'request') {
      if (typeof event.transaction_id !== 'string' || !event.transaction_id || requests.has(event.transaction_id)) fail();
      requests.set(event.transaction_id, event);
    }
  }
  const issues = new Set(), transactions = [];
  if (capture.events.dropped > 0) issues.add('events_dropped');
  const omissions = capture.events.omissions;
  if (!object(omissions)) issues.add('omission_accounting_missing');
  else {
    if (!Array.isArray(omissions.by_kind) || !Array.isArray(omissions.network_transactions) ||
      omissions.by_kind.some(item => !item || typeof item.kind !== 'string' || !natural(item.count) || item.count === 0) ||
      (omissions.network_transaction_range != null && (!natural(omissions.network_transaction_range.count) || omissions.network_transaction_range.count === 0))) fail();
    const omittedCount = omissions.by_kind.reduce((sum, item) => sum + item.count, 0);
    if (!Number.isSafeInteger(omittedCount)) fail();
    if (omittedCount !== capture.events.dropped || new Set(omissions.by_kind.map(item => item.kind)).size !== omissions.by_kind.length) issues.add('omission_accounting_mismatch');
    if (omittedCount || omissions.network_transactions.length || omissions.network_transaction_range) issues.add('events_dropped');
  }
  if (steps.some(step => step.status !== 'completed')) issues.add('step_not_completed');
  if (capture.completeness?.status !== 'complete' || capture.completeness?.equality_eligible !== true) issues.add('producer_incomplete');
  const bodies = { request: new Map(), response: new Map() };
  for (const event of events) {
    if (event.kind !== 'network-content') continue;
    const source = seq.get(event.source_event_sequence);
    if (!['request', 'response'].includes(event.phase) || !source || source.kind !== event.phase || source.transaction_id !== event.transaction_id || source.sequence >= event.sequence) fail();
    const phaseBodies = bodies[event.phase];
    if (phaseBodies.has(event.transaction_id)) fail();
    const body = event.body;
    let summary = { state: 'unknown', originalWireBody: 'not_attested' };
    if (body?.state === 'captured') {
      if (typeof body.content !== 'string' || body.content.length > 8 * 1024 * 1024 || body.encoding !== 'base64') fail();
      const bytes = Buffer.from(body.content, 'base64');
      if (bytes.toString('base64') !== body.content || bytes.length !== body.bytes || digest(bytes) !== body.sha256) fail();
      let responseSchema = null;
      const mime = normalizeMime(body.media_type);
      if (mime === 'application/json' || mime?.endsWith('+json')) { try { responseSchema = schemaOf(JSON.parse(bytes.toString('utf8'))); } catch { issues.add(event.phase + '_json_invalid'); } }
      const formFields = mime === 'application/x-www-form-urlencoded' ? normalizeFieldNames([...new URLSearchParams(bytes.toString('utf8')).keys()]) : [];
      summary = { state: 'captured', bytes: bytes.length, mime, bodySchema: responseSchema, formFields, contentIntegrity: 'verified',
        originalWireBody: 'not_attested', representation: ['browser-decoded-response-bytes', 'playwright-response-body-bytes', 'playwright-request-post-data-buffer'].includes(body.representation) ? body.representation : 'unknown' };
    } else {
      summary.state = ['not_requested', 'not_exposed', 'unavailable'].includes(body?.state) ? body.state : 'unknown';
      issues.add(event.phase + '_body_unavailable');
    }
    phaseBodies.set(event.transaction_id, summary);
  }
  const ancestryChecked = new Set();
  for (const [id, request] of requests) {
    const chain = new Set([id]); let cursor = request;
    while (cursor.redirected_from_transaction_id != null && !ancestryChecked.has(cursor.transaction_id)) {
      const parent = cursor.redirected_from_transaction_id;
      if (chain.has(parent)) { issues.add('redirect_cycle'); break; }
      chain.add(parent); cursor = requests.get(parent);
      if (!cursor) { issues.add('redirect_predecessor_missing'); break; }
    }
    if (cursor?.redirected_from_transaction_id == null && cursor?.redirected_from_transaction_state !== 'root') issues.add('redirect_root_unknown');
    for (const member of chain) ancestryChecked.add(member);
    const related = grouped.get(id) ?? [];
    const responses = related.filter(event => event.kind === 'response');
    if (responses.length !== 1) issues.add('request_response_pair_incomplete');
    const finished = related.some(event => event.kind === 'request-finished');
    if (!finished || related.some(event => ['request-unfinished', 'request-failed'].includes(event.kind))) issues.add('request_not_completed');
    const route = normalizeUrl(request.url);
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,32}$/.test(request.method)) fail();
    transactions.push({ index: transactions.length, stepIndex: request.step_index, method: request.method, ...route,
      status: Number.isInteger(responses[0]?.status) ? responses[0].status : null, finished,
      body: bodies.response.get(id) ?? { state: 'unknown', originalWireBody: 'not_attested' },
      requestBody: bodies.request.get(id) ?? { state: 'unknown', originalWireBody: 'not_attested' } });
    if (!bodies.response.has(id)) issues.add('response_body_unavailable');
    if (['POST', 'PUT', 'PATCH'].includes(request.method) && !bodies.request.has(id)) issues.add('request_body_unavailable');
  }
  for (const event of events) if (['response', 'request-finished', 'request-failed', 'request-unfinished', 'network-content'].includes(event.kind) && !requests.has(event.transaction_id)) issues.add('request_event_missing');
  if (!transactions.length) issues.add('no_network_transactions');
  return { schema: 'web-api-browser-evidence-v1', producer: 'rea-scenario-import',
    upstreamRevision: 'e45eb33f03deaa2ab047f876736ccaa22498448f',
    valuesRecorded: false, rawHeadersRecorded: false, upstreamEnvelopeAuthenticated: false,
    directHttpReplay: false, websiteEquivalent: 'unknown',
    steps: steps.map((step, index) => ({ index, status: ['completed', 'failed', 'cancelled'].includes(step.status) ? step.status : 'unknown',
      artifacts: Object.fromEntries(['dom', 'accessibility', 'screenshot', 'url'].map(name => [name,
        ['captured', 'missing', 'truncated', 'not_requested'].includes(step.artifacts?.[name]?.state) ? step.artifacts[name].state : 'unknown'])) })),
    coverage: { retainedEvents: events.length, droppedEvents: capture.events.dropped, issues: [...issues].sort(), originalWireBody: 'not_attested' },
    transactions };
}
