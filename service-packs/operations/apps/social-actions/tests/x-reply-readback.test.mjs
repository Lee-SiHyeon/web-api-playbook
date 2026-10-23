import test from 'node:test';
import assert from 'node:assert/strict';
import { replyTextMatches } from '../../affiliate-api-hub/scripts/sns/writers/x-reply-readback.mjs';
test('reply readback accepts only exact text with observed automatic mentions and exact parent', () => {
  assert.equal(replyTextMatches({ text: '@target @another Thanks & hello!', parentId: '123' }, 'Thanks & hello!', '123'), true);
  assert.equal(replyTextMatches({ text: '@target Thanks & hello!', parentId: '456' }, 'Thanks & hello!', '123'), false);
  assert.equal(replyTextMatches({ text: 'Unexpected extra prose Thanks & hello!', parentId: '123' }, 'Thanks & hello!', '123'), false);
  assert.equal(replyTextMatches({ text: '@target Thanks & hello!', parentId: '123' }, 'Thanks & hello!'), false);
});
