import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { contractsFromHar } from '../lib/contracts.mjs';
import { summarizeAgentHar, compareContractShapes } from '../lib/browser-evidence.mjs';

// Synthetic transport fixtures, not an AliExpress product/review schema or replay.
const callback = 'fixtureCallback_7';
const secret = 'PRIVATE_SYNTHETIC_VALUE';
function har(text, { mime = 'application/json', query = `callback=${callback}`, base64 = false } = {}) {
  return { log: { entries: [{ request: { method: 'GET', url: `https://example.invalid/read?${query}` },
    response: { status: 200, content: { mimeType: mime,
      text: base64 ? Buffer.from(text).toString('base64') : text, ...(base64 ? { encoding: 'base64' } : {}) } } }] } };
}
const observation = input => contractsFromHar(input).contracts[0].observations[0];

test('HAR decodes exact request-bound JSONP under JSON and JavaScript MIME without executing code', () => {
  const body = ` \n${callback} ( {"data":{"token":"${secret}","rows":[{"title":"sample"}]},"ret":["OK"]} ); \n`;
  for (const mime of ['application/json', 'text/javascript', 'application/javascript']) {
    for (const base64 of [false, true]) {
      const result = contractsFromHar(har(body, { mime, base64 }));
      const item = result.contracts[0].observations[0];
      assert.equal(item.responseFormat, 'jsonp');
      assert.equal(item.responseSchema.properties.data.properties.rows.type, 'array');
      assert.equal(item.responseBytes, Buffer.byteLength(body));
      assert.equal(item.responseSha256, createHash('sha256').update(body).digest('hex'));
      assert.equal(JSON.stringify(result).includes(secret), false);
      assert.equal(JSON.stringify(result).includes(callback), false);
    }
  }
  assert.equal(observation(har('$cb({"ok":true})', { query: 'callback=%24cb' })).responseFormat, 'jsonp');
});

test('HAR rejects callback mismatch, missing/duplicate callback and executable wrappers', () => {
  const invalid = [
    [`different({"ok":true})`, {}],
    [`${callback}({"ok":true})`, { query: 'type=jsonp' }],
    [`${callback}({"ok":true})`, { query: `callback=${callback}&callback=${callback}` }],
    ['obj.cb({"ok":true})', { query: 'callback=obj.cb' }],
    [`${callback}({ok:true})`, {}],
    [`${callback}({"ok":true}, {"second":true})`, {}],
    [`${callback}((()=>({"ok":true}))())`, {}],
    [`${callback}({"ok":true});process.exit(42)`, {}],
    [`${callback}({"ok":true});${callback}({"ok":false})`, {}],
    [`/* arbitrary script */${callback}({"ok":true})`, {}],
  ];
  for (const [body, options] of invalid) {
    const input = har(body, options), item = observation(input);
    assert.ok(['invalid_json', 'invalid_jsonp'].includes(item.responseSchema.state));
    assert.equal(item.responseFormat, null);
    const summary = summarizeAgentHar(input);
    assert.equal(compareContractShapes(summary, summary).result, 'unknown');
  }
});

test('valid JSON remains JSON, and a parseable error envelope is never a live replay', () => {
  const json = observation(har('{"problem":true}', { mime: 'application/problem+json', query: '' }));
  assert.equal(json.responseFormat, 'json');
  const summary = summarizeAgentHar(har(`${callback}({"ret":["ERROR"],"data":{}})`));
  assert.equal(summary.inventory.contracts[0].observations[0].responseFormat, 'jsonp');
  assert.equal(summary.directHttpReplay, false);
  assert.equal(summary.inventory.contracts[0].observations[0].businessOutcome, 'unclassified');
  assert.equal(compareContractShapes(summary, summary).websiteEquivalent, 'unknown');
  const denied = har(`${callback}({"data":{},"ret":["DENIED"]})`);
  denied.log.entries[0].response.status = 403;
  assert.equal(observation(denied).status, 403);
  assert.equal(observation(denied).businessOutcome, 'unclassified');
});

test('oversized structured bodies and invalid JavaScript JSONP cannot establish shape equality', () => {
  for (const input of [har(`${callback}("${'a'.repeat(4 * 1024 * 1024)}")`),
    har(`${callback}({broken})`, { mime: 'text/javascript' })]) {
    const summary = summarizeAgentHar(input);
    assert.ok(summary.inventory.contracts[0].observations[0].responseSchema.state);
    assert.equal(compareContractShapes(summary, summary).result, 'unknown');
  }
});

test('wire JSON and JSONP remain different contract shapes even with identical object schemas', () => {
  const json = summarizeAgentHar(har('{"ok":true}'));
  const jsonp = summarizeAgentHar(har(`${callback}({"ok":true})`));
  assert.equal(compareContractShapes(json, jsonp).result, 'different_contract_shapes');
});

test('malformed HAR base64 is not silently repaired into usable schema evidence', () => {
  const input = har(`${callback}({"ok":true})`, { base64: true });
  input.log.entries[0].response.content.text += '!';
  const item = observation(input);
  assert.equal(item.responseSchema.state, 'invalid_body_encoding');
  assert.equal(item.responseBodyAvailable, false);
  assert.equal(item.responseSha256, null);
  const summary = summarizeAgentHar(input);
  assert.equal(compareContractShapes(summary, summary).result, 'unknown');
});
