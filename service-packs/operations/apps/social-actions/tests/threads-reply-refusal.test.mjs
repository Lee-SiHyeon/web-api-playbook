import test from 'node:test';
import assert from 'node:assert/strict';
import { threadsReplyRefusal, safeThreadsReplyRefusal, safeThreadsReplyRequestShape,
  threadsReplyWriteWasExplicitlyRefused } from '../lib/threads-reply-refusal.mjs';

test('a readback carries the original write time and never becomes a new write failure', () => {
  const incident = threadsReplyRefusal({ code: 'THREADS_REPLY_SERVER_INTEGRITY_BLOCKED', httpStatus: 400,
    writes: 1, reconciliationOnly: true, status: 'not_found_full_scan',
    writeAttemptAt: '2026-10-01T05:06:26.434Z', checkedAt: '2026-10-01T07:20:38.962Z',
    reconciliationCode: 'THREADS_REPLY_NOT_FOUND_IN_FULL_SCAN', postId: '3998102096557632423', message: 'PRIVATE' });
  assert.equal(incident.origin, 'saved_write'); assert.equal(incident.readback, 'unverified');
  assert.equal(incident.firstWriteAt, '2026-10-01T05:06:26.434Z'); assert.equal(incident.specificCauseKnown, false);
  assert.equal(incident.automaticWritesBlocked, true); assert.equal(JSON.stringify(incident).includes('PRIVATE'), false);
  assert.equal(incident.targetOnly, true);
  assert.deepEqual(safeThreadsReplyRefusal({ ...incident, cookies: 'SECRET' }), incident);
  assert.equal(threadsReplyRefusal({ code: 'THREADS_HTTP_400', httpStatus: 400 }), null);
});

test('only the captured complete integrity refusal shape proves a write was rejected', () => {
  const captured = { httpStatus: 400, providerContentTypeClass: 'json', providerBodyBytes: 61,
    providerBodyTruncated: false, providerRejectionCategory: 'integrity_blocked', providerTopLevelKeys: ['message', 'status'] };
  assert.equal(threadsReplyWriteWasExplicitlyRefused(captured), true);
  for (const changed of [
    { ...captured, httpStatus: 403 }, { ...captured, providerBodyBytes: 62 },
    { ...captured, providerBodyTruncated: true }, { ...captured, providerTopLevelKeys: ['message', 'error_code', 'status'] },
    { ...captured, providerContentTypeClass: 'text' }, { ...captured, providerRejectionCategory: 'unclassified' },
  ]) assert.equal(threadsReplyWriteWasExplicitlyRefused(changed), false);
  const refusal=threadsReplyRefusal({ ...captured, code:'THREADS_REPLY_SERVER_INTEGRITY_BLOCKED', writes:1 });
  assert.equal(refusal.writeOutcome,'not_created_explicit_refusal'); assert.equal(refusal.specificCauseKnown,false);
});

test('request shape drops arbitrary values and records only keys, types and binding booleans', () => {
  const shape = safeThreadsReplyRequestShape({ version: 2, method: 'POST', path: '/api/v1/media/configure_text_only_post/',
    appInfoTypes: { reply_id: 'string', caption: 'PRIVATE' }, caption: 'PRIVATE', parentIdsMatch: true, headers: { Cookie: 'PRIVATE' } });
  assert.deepEqual(shape.appInfoTypes, { reply_id: 'string' });
  assert.equal(JSON.stringify(shape).includes('PRIVATE'), false);
  assert.equal(safeThreadsReplyRequestShape({ ...shape, path: 'https://www.threads.com?token=PRIVATE' }), null);
});
