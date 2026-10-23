import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findInstagramCommentInPages,
  findInstagramCommentOnPost,
  isInstagramCommentApprovalVerified,
  isInstagramCommentDeletionVerified,
  isInstagramCommentRestricted,
  normalizeInstagramComment,
} from '../instagram-comments.mjs';

function page(comments, hasNextPage, nextCursor = null) {
  return { comments, pagination: { hasNextPage, nextCursor } };
}

test('comment scan follows cursors before concluding that a target is absent', async () => {
  const responses = [page([{ id: '10' }], true, 'cursor-2'), page([{ id: '42' }], false)];
  const afterValues = [];
  const result = await findInstagramCommentInPages(async after => {
    afterValues.push(after);
    return responses.shift();
  }, '42');

  assert.equal(result.state, 'found');
  assert.equal(result.comment.id, '42');
  assert.deepEqual(afterValues, [null, 'cursor-2']);
});

test('a missing comment is conclusive only after the connection is exhausted', async () => {
  const truncated = await findInstagramCommentInPages(async () => page([{ id: '10' }], true, 'cursor-2'), '42', {
    maxPages: 1,
  });
  assert.equal(truncated.state, 'incomplete');
  assert.equal(isInstagramCommentDeletionVerified(truncated), false);

  const exhausted = await findInstagramCommentInPages(async after => after == null
    ? page([{ id: '10' }], true, 'cursor-2')
    : page([{ id: '11' }], false), '42');
  assert.equal(exhausted.state, 'not_found');
  assert.equal(isInstagramCommentDeletionVerified(exhausted), true);
  assert.equal(isInstagramCommentDeletionVerified({ state: 'found' }), false);
});

test('a broken or repeated cursor leaves comment absence unverified', async () => {
  const missingCursor = await findInstagramCommentInPages(async () => page([], true), '42');
  assert.equal(missingCursor.state, 'incomplete');

  const repeatedCursor = await findInstagramCommentInPages(async () => page([], true, 'same-cursor'), '42');
  assert.equal(repeatedCursor.state, 'incomplete');
});

test('comment lookup binds a reply id to the supplied post and parent thread', async () => {
  const rootCalls = [];
  const replyCalls = [];
  const result = await findInstagramCommentOnPost({
    handle: 'Owner_Name', shortcode: 'AbC123', mediaId: '900', commentId: '902', parentCommentId: '901',
  }, {
    readComments: async input => {
      rootCalls.push(input);
      return page([{ id: '901', parentCommentId: null }], false);
    },
    readReplies: async input => {
      replyCalls.push(input);
      return input.after == null
        ? page([{ id: '9001', parentCommentId: '901' }], true, 'reply-page-2')
        : page([{ id: '902', parentCommentId: '901' }], false);
    },
  });

  assert.equal(result.state, 'found');
  assert.equal(result.comment.id, '902');
  assert.equal(rootCalls[0].handle, 'owner_name');
  assert.equal(rootCalls[0].shortcode, 'AbC123');
  assert.equal(rootCalls[0].mediaId, '900');
  assert.equal(replyCalls[0].parentCommentId, '901');
  assert.equal(replyCalls[1].after, 'reply-page-2');
});

test('comment lookup rejects a comment id outside the requested post', async () => {
  const result = await findInstagramCommentOnPost({
    handle: 'owner_name', shortcode: 'AbC123', mediaId: '900', commentId: '777',
  }, {
    readComments: async () => page([{ id: '776', parentCommentId: null }], false),
  });

  assert.equal(result.state, 'not_found');
  assert.equal(result.comment, null);
});

test('restricted status preserves numeric source values and approval requires status zero', () => {
  const restricted = normalizeInstagramComment({ node: { pk: '42', restricted_status: 1 } });
  const approved = normalizeInstagramComment({ node: { pk: '42', restricted_status: 0 } });
  const unknown = normalizeInstagramComment({ node: { pk: '42', restricted_status: null } });

  assert.equal(restricted.restrictedStatus, 1);
  assert.equal(approved.restrictedStatus, 0);
  assert.equal(unknown.restrictedStatus, null);
  assert.equal(isInstagramCommentRestricted(restricted), true);
  assert.equal(isInstagramCommentRestricted(unknown), false);
  assert.equal(isInstagramCommentApprovalVerified(approved), true);
  assert.equal(isInstagramCommentApprovalVerified(restricted), false);
  assert.equal(isInstagramCommentApprovalVerified(unknown), false);
  assert.equal(isInstagramCommentApprovalVerified({ restrictedStatus: 'approved' }), false);
});
