import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { summarizeAgentHar, compareContractShapes, summarizeReaCapture } from '../lib/browser-evidence.mjs';

const secret = 'PRIVATE_VALUE_12345';
function har(value = 1) { return { log: { entries: [{ startedDateTime: '2026-10-15T00:00:00Z',
  request: { url: `https://example.test/api/search?token=${secret}`, method: 'GET', headers: [{ name: 'Cookie', value: secret }] },
  response: { status: 200, headers: [{ name: 'Set-Cookie', value: secret }], content: { mimeType: 'application/json', text: JSON.stringify({ count: value, token: secret }) } } }] } }; }

test('HAR normalization removes values and does not promote a shape match to website equality', () => {
  const first = summarizeAgentHar(har(1)), second = summarizeAgentHar(har(2));
  assert.equal(JSON.stringify(first).includes(secret), false);
  assert.equal(first.directHttpReplay, false);
  assert.equal(first.coverage.initiatorStacks, 'not_provided_by_agent_browser_har');
  const result = compareContractShapes(first, second);
  assert.equal(result.result, 'same_contract_shapes');
  assert.equal(result.valuesCompared, false);
  assert.equal(result.websiteEquivalent, 'unknown');
});

test('empty captures, failed body reads and invalid JSON cannot establish matching contracts', () => {
  const empty = summarizeAgentHar({ log: { entries: [] } });
  assert.equal(compareContractShapes(empty, empty).result, 'unknown');
  const missing = har(); delete missing.log.entries[0].response.content.text;
  const partial = summarizeAgentHar(missing);
  assert.equal(partial.coverage.bodyMissing, 1);
  assert.equal(compareContractShapes(partial, partial).result, 'unknown');
  const invalid = har(); invalid.log.entries[0].response.content.text = '{';
  const broken = summarizeAgentHar(invalid);
  assert.equal(compareContractShapes(broken, broken).result, 'unknown');
});

function rea() {
  const bytes = Buffer.from(JSON.stringify({ token: secret, items: [{ price: 1200 }] }));
  const request = { sequence: 1, step_index: 1, kind: 'request', transaction_id: secret, method: 'GET',
    url: `https://example.test/api/search?q=${secret}`, redirected_from_transaction_id: null, redirected_from_transaction_state: 'root' };
  const events = [request, { ...request, sequence: 2, kind: 'response', status: 200 },
    { ...request, sequence: 3, kind: 'request-finished' },
    { sequence: 4, step_index: 1, kind: 'network-content', transaction_id: secret, source_event_sequence: 2, phase: 'response',
      body: { state: 'captured', representation: 'playwright-response-body-bytes', encoding: 'base64',
        content: bytes.toString('base64'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), media_type: 'application/json' } }];
  return { scenario: { action_count: 1 }, steps: [0,1].map(i => ({ step_index: i, step_id: `step-${i}`, status: 'completed', artifacts: { dom: { state: 'not_requested' } } })),
    events: { retained: events.length, dropped: 0, items: events, omissions: { by_kind: [], network_transactions: [], network_transaction_range: null } }, completeness: { status: 'complete', equality_eligible: true } };
}

test('REA importer pairs original events, validates retained bytes and discards sensitive text', () => {
  const result = summarizeReaCapture({ predicate_type: 'rea.browser-scenario-capture', normalized_result: rea() });
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(result.transactions[0].stepIndex, 1);
  assert.equal(result.transactions[0].body.contentIntegrity, 'verified');
  assert.equal(result.transactions[0].body.originalWireBody, 'not_attested');
  assert.equal(result.upstreamEnvelopeAuthenticated, false);
  assert.equal(result.directHttpReplay, false);
});

test('REA importer rejects mismatched source references and tampered body content', () => {
  const mismatch = rea(); mismatch.events.items[3].source_event_sequence = 1;
  assert.throws(() => summarizeReaCapture(mismatch), /BROWSER_EVIDENCE_INVALID/);
  const tampered = rea(); tampered.events.items[3].body.content = Buffer.from('different').toString('base64');
  assert.throws(() => summarizeReaCapture(tampered), /BROWSER_EVIDENCE_INVALID/);
  const duplicate = rea(); duplicate.steps[1].step_id = duplicate.steps[0].step_id;
  assert.throws(() => summarizeReaCapture(duplicate), /BROWSER_EVIDENCE_INVALID/);
});

test('REA dropped events, missing predecessors and unfinished requests remain gaps', () => {
  const input = rea(); input.events.dropped = 1;
  input.events.items[0].redirected_from_transaction_id = 'unobserved';
  input.events.items[2].kind = 'request-unfinished';
  const result = summarizeReaCapture(input);
  assert.ok(result.coverage.issues.includes('events_dropped'));
  assert.ok(result.coverage.issues.includes('redirect_predecessor_missing'));
  assert.ok(result.coverage.issues.includes('request_not_completed'));
});

test('REA request body shapes survive without values and contradictory omission counts are gaps', () => {
  const input = rea(); input.events.items[0].method = 'POST';
  const bytes = Buffer.from(`query=${secret}&page=2`);
  input.events.items.push({ sequence: 5, step_index: 1, kind: 'network-content', transaction_id: secret, source_event_sequence: 1, phase: 'request',
    body: { state: 'captured', encoding: 'base64', content: bytes.toString('base64'), bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), media_type: 'application/x-www-form-urlencoded' } });
  input.events.retained++;
  input.events.omissions.by_kind.push({ kind: 'request', count: 1, reasons: ['max-events'] });
  const result = summarizeReaCapture(input);
  assert.deepEqual(result.transactions[0].requestBody.formFields, ['page', 'query']);
  assert.equal(result.transactions[0].requestBody.contentIntegrity, 'verified');
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.ok(result.coverage.issues.includes('omission_accounting_mismatch'));
  assert.ok(result.coverage.issues.includes('events_dropped'));
  input.events.items[4].body.sha256 = '0'.repeat(64);
  assert.throws(() => summarizeReaCapture(input), /BROWSER_EVIDENCE_INVALID/);
});
