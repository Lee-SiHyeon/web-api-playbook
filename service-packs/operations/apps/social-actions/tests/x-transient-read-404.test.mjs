import test from 'node:test';
import assert from 'node:assert/strict';
import { transientGraphqlRead404, GRAPHQL_READ_404_RETRIES } from '../providers/x.mjs';

test('only an empty-body 404 counts as a transient GraphQL read failure', () => {
  assert.equal(transientGraphqlRead404({ status: 404, raw: '' }), true);
  assert.equal(transientGraphqlRead404({ status: 404 }), true);
  assert.equal(transientGraphqlRead404({ status: 404, raw: '{"errors":[{"code":34}]}' }), false);
  for (const status of [200, 401, 403, 429, 500]) assert.equal(transientGraphqlRead404({ status, raw: '' }), false);
  assert.equal(GRAPHQL_READ_404_RETRIES, 2);
});
