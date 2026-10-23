import test from 'node:test';
import assert from 'node:assert/strict';
import { ownerReadCanRetry } from '../providers/x.mjs';
test('bounded owner read retry excludes authentication, rate-limit and non-JSON challenge responses', () => {
  const response = (status, codes, mime = 'application/json') => ({ status, headers: { 'content-type': mime }, raw: JSON.stringify({ errors: codes.map(code => ({ code })) }) });
  assert.equal(ownerReadCanRetry(response(404, [34])), true);
  for (const status of [401, 403, 418, 429]) assert.equal(ownerReadCanRetry(response(status, [34])), false);
  assert.equal(ownerReadCanRetry(response(404, [89])), false);
  assert.equal(ownerReadCanRetry(response(404, [34], 'text/html')), false);
  assert.equal(ownerReadCanRetry(response(200, [])), false);
  assert.equal(ownerReadCanRetry(response(503, [])), true);
});
