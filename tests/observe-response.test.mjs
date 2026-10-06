import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import { observeResponse } from '../scripts/observe-response.mjs';

test('delayed consumer receives every byte while observer exposes only completed metadata', async () => {
  const chunks = [Buffer.from('first-frame\n'), Buffer.from('second-frame\n')];
  let auditCalls = 0;
  const response = observeResponse({ status: 200, body: Readable.from(chunks) }, { onAudit: () => { auditCalls++; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(response.audit, null);
  assert.equal(auditCalls, 0);
  const received = [];
  for await (const chunk of response.body) received.push(chunk);
  const expected = Buffer.concat(chunks);
  assert.deepEqual(Buffer.concat(received), expected);
  assert.deepEqual(response.audit, { bytes: expected.length, sha256: createHash('sha256').update(expected).digest('hex'), fullyRead: true });
  assert.equal(auditCalls, 1);
});

test('partial reads and audit failures do not masquerade as complete bodies or discard consumed data', async () => {
  const response = observeResponse({ body: Readable.from([Buffer.from('one'), Buffer.from('two')]) }, {
    onAudit: () => { throw new Error('sink unavailable'); },
  });
  for await (const chunk of response.body) { assert.equal(chunk.toString(), 'one'); break; }
  assert.equal(response.audit.fullyRead, false);
  assert.equal(response.audit.bytes, 3);
  assert.equal(response.audit.auditCallbackFailed, true);
  await assert.rejects(async () => { for await (const _chunk of response.body) {} }, /RESPONSE_BODY_ALREADY_CONSUMED/);
});
