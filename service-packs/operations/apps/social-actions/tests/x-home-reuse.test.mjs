import test from 'node:test';
import assert from 'node:assert/strict';
import { xHomeReusable } from '../providers/x.mjs';

test('only a complete HTML 200 /home from the transaction bootstrap is reused', () => {
  const ok = { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, raw: '<html></html>' };
  assert.equal(xHomeReusable(ok), true);
  assert.equal(xHomeReusable({ ...ok, status: 302 }), false);
  assert.equal(xHomeReusable({ ...ok, headers: { 'content-type': 'application/json' } }), false);
  assert.equal(xHomeReusable({ ...ok, raw: undefined }), false);
  assert.equal(xHomeReusable(undefined), false);
});
