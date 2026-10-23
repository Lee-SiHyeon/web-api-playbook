import { fail } from './errors.mjs';

export const GROK_CONVERSATION_RESTORE_OPERATION_IDS = Object.freeze({
  activeList: 'conversation.list.read',
  deletedList: 'conversation.deleted.list',
  detail: 'conversation.read',
  restore: 'conversation.restore',
});

export const GROK_CONVERSATION_RESTORE_SOURCE_PERMITS = Object.freeze({
  deletedList: 'first-read:conversation.deleted.list',
  restore: 'first-live:conversation.restore',
});

const PAGE_SIZE = 1_000;
const MAX_PAGES = 20;
const SAFE_REASON = /^[A-Z][A-Z0-9_]{0,63}$/;
const SAFE_INTENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateConversationId(value) {
  if (typeof value !== 'string' || value.length < 16 || value.length > 512 || /[\r\n\0]/.test(value)) {
    throw fail('CONVERSATION_ID_INVALID');
  }
  return value;
}

function validateIntent(options) {
  if (!plainObject(options) || options.confirm !== true) throw fail('CONVERSATION_RESTORE_CONFIRM_REQUIRED');
  if (typeof options.intentId !== 'string' || !SAFE_INTENT.test(options.intentId.trim())) {
    throw fail('CONVERSATION_RESTORE_INTENT_ID_REQUIRED');
  }
  const permit = options.sourceDiscoveryPermit ?? null;
  if (permit !== null && permit !== GROK_CONVERSATION_RESTORE_SOURCE_PERMITS.restore) {
    throw fail('CONVERSATION_RESTORE_SOURCE_PERMIT_INVALID');
  }
  return { confirm: true, intentId: options.intentId.trim(), sourceDiscoveryPermit: permit };
}

function readResult(result, code) {
  if (!result || !Number.isInteger(result.status) || result.status < 200 || result.status >= 300
    || !plainObject(result.data)) throw fail(code);
  return result;
}

async function allConversationIds(read, operationId, { sourceDiscoveryPermit = null } = {}) {
  const counts = new Map();
  const cursors = new Set();
  let pageToken;
  let status = null;
  let complete = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = readResult(await read(operationId, {
      pageSize: PAGE_SIZE,
      ...(pageToken ? { pageToken } : {}),
    }, { sourceDiscoveryPermit }), operationId === GROK_CONVERSATION_RESTORE_OPERATION_IDS.deletedList
      ? 'CONVERSATION_DELETED_LIST_READ_FAILED' : 'CONVERSATION_LIST_READ_FAILED');
    const rows = result.data.conversations;
    if (!Array.isArray(rows)) throw fail(operationId === GROK_CONVERSATION_RESTORE_OPERATION_IDS.deletedList
      ? 'CONVERSATION_DELETED_LIST_RESPONSE_INVALID' : 'CONVERSATION_LIST_RESPONSE_INVALID');
    status = result.status;
    for (const row of rows) {
      if (!plainObject(row) || typeof row.conversationId !== 'string') {
        throw fail(operationId === GROK_CONVERSATION_RESTORE_OPERATION_IDS.deletedList
          ? 'CONVERSATION_DELETED_LIST_RESPONSE_INVALID' : 'CONVERSATION_LIST_RESPONSE_INVALID');
      }
      counts.set(row.conversationId, (counts.get(row.conversationId) ?? 0) + 1);
    }
    const next = result.data.nextPageToken;
    if (typeof next !== 'string' || !next) { complete = true; break; }
    if (next.length > 8_192 || /[\r\n\0]/.test(next) || cursors.has(next)) {
      throw fail('CONVERSATION_CURSOR_INVALID');
    }
    cursors.add(next);
    pageToken = next;
  }
  return { counts, complete, status };
}

function sameIdsExcept(left, right, excludedId) {
  const leftIds = new Set([...left].filter(([id]) => id !== excludedId).map(([id]) => id));
  const rightIds = new Set([...right].filter(([id]) => id !== excludedId).map(([id]) => id));
  return leftIds.size === rightIds.size && [...leftIds].every(id => rightIds.has(id));
}

async function holdForReview(journal, localOperationId, { httpStatus, reasonCode }) {
  if (!SAFE_REASON.test(reasonCode)) throw fail('CONVERSATION_RESTORE_REASON_INVALID');
  const entry = await journal.get(localOperationId);
  if (entry && ['accepted', 'processing', 'outcome_unknown'].includes(entry.state)) {
    await journal.transition(localOperationId, 'needs_review', { httpStatus, reasonCode });
  }
}

async function markVerified(journal, localOperationId, { httpStatus, operationId }) {
  const entry = await journal.get(localOperationId);
  if (!entry || !['accepted', 'outcome_unknown', 'needs_review'].includes(entry.state)) {
    throw fail('CONVERSATION_RESTORE_JOURNAL_STATE_INVALID');
  }
  await journal.transition(localOperationId, 'completed', {
    httpStatus,
    reasonCode: 'CONVERSATION_RESTORE_READBACK_VERIFIED',
    reconciledBy: operationId,
  });
}

/** Restore an explicitly selected owner soft-deleted conversation, binding completion to detail and both full lists. */
export function createGrokConversationRestoreClient({ client, journal } = {}) {
  if (!client || typeof client.read !== 'function' || typeof client.submit !== 'function'
    || typeof client.status !== 'function' || typeof journal?.get !== 'function'
    || typeof journal?.transition !== 'function') throw fail('CONVERSATION_RESTORE_RUNTIME_REQUIRED');

  const read = (operationId, input, options = {}) => client.read(operationId, input, options);
  const readAllDeleted = sourceDiscoveryPermit => allConversationIds(read,
    GROK_CONVERSATION_RESTORE_OPERATION_IDS.deletedList, { sourceDiscoveryPermit });
  const readAllActive = () => allConversationIds(read, GROK_CONVERSATION_RESTORE_OPERATION_IDS.activeList);

  async function detail(id) {
    const result = readResult(await read(GROK_CONVERSATION_RESTORE_OPERATION_IDS.detail, { conversationId: id }),
      'CONVERSATION_READ_FAILED');
    const conversation = plainObject(result.data.conversation) ? result.data.conversation : result.data;
    if (conversation.conversationId !== id) throw fail('CONVERSATION_READ_ID_MISMATCH');
    if (conversation.viewerIsOwner !== true || conversation.isReadonly === true
      || (conversation.accessLevel && conversation.accessLevel !== 'OWNER')) {
      throw fail('CONVERSATION_OWNER_ACCESS_REQUIRED');
    }
    return { result, conversation };
  }

  return Object.freeze({
    async deletedConversations(input = {}) {
      if (!plainObject(input) || Object.keys(input).some(key => !['pageSize', 'pageToken', 'workspaceId'].includes(key))) {
        throw fail('CONVERSATION_DELETED_LIST_INPUT_INVALID');
      }
      if (input.pageSize !== undefined && (!Number.isInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > PAGE_SIZE)) {
        throw fail('CONVERSATION_PAGE_SIZE_INVALID');
      }
      const result = readResult(await read(GROK_CONVERSATION_RESTORE_OPERATION_IDS.deletedList, input, {
        sourceDiscoveryPermit: GROK_CONVERSATION_RESTORE_SOURCE_PERMITS.deletedList,
      }), 'CONVERSATION_DELETED_LIST_READ_FAILED');
      if (!Array.isArray(result.data.conversations)) throw fail('CONVERSATION_DELETED_LIST_RESPONSE_INVALID');
      return result;
    },

    async restore(conversationId, options) {
      const id = validateConversationId(conversationId);
      const mutation = validateIntent(options);
      if (client.status) {
        const status = await client.status();
        if (status?.session?.ownerVerified !== true) throw fail('OWNER_VERIFICATION_REQUIRED');
      }

      const beforeDeleted = await readAllDeleted(GROK_CONVERSATION_RESTORE_SOURCE_PERMITS.deletedList);
      if (!beforeDeleted.complete || beforeDeleted.counts.get(id) !== 1) {
        throw fail('CONVERSATION_RESTORE_TARGET_NOT_UNIQUE_SOFT_DELETED');
      }
      const beforeActive = await readAllActive();
      if (!beforeActive.complete) throw fail('CONVERSATION_RESTORE_ACTIVE_LIST_INCOMPLETE');
      if (beforeActive.counts.has(id)) throw fail('CONVERSATION_RESTORE_TARGET_ALREADY_ACTIVE');

      const submitted = await client.submit(GROK_CONVERSATION_RESTORE_OPERATION_IDS.restore, {
        body: { conversationId: id },
      }, mutation);
      if (typeof submitted?.localOperationId !== 'string') throw fail('CONVERSATION_SUBMIT_RECEIPT_INVALID');

      let ownerDetail;
      let afterActive;
      let afterDeleted;
      try {
        ownerDetail = await detail(id);
        afterActive = await readAllActive();
        afterDeleted = await readAllDeleted(GROK_CONVERSATION_RESTORE_SOURCE_PERMITS.deletedList);
      } catch {
        await holdForReview(journal, submitted.localOperationId, {
          httpStatus: submitted.httpStatus,
          reasonCode: 'CONVERSATION_RESTORE_READBACK_FAILED',
        });
        return { ...submitted, state: 'needs_review', verified: false, readbackStatus: null };
      }

      const targetActiveExactlyOnce = afterActive.counts.get(id) === 1;
      const targetAbsentFromDeleted = !afterDeleted.counts.has(id);
      const otherActiveConversationsUnchanged = sameIdsExcept(beforeActive.counts, afterActive.counts, id);
      const otherDeletedConversationsUnchanged = sameIdsExcept(beforeDeleted.counts, afterDeleted.counts, id);
      const listsComplete = afterActive.complete && afterDeleted.complete;
      const verified = listsComplete && ownerDetail.conversation.viewerIsOwner === true
        && targetActiveExactlyOnce && targetAbsentFromDeleted
        && otherActiveConversationsUnchanged && otherDeletedConversationsUnchanged;
      if (!verified) {
        await holdForReview(journal, submitted.localOperationId, {
          httpStatus: ownerDetail.result.status,
          reasonCode: listsComplete ? 'CONVERSATION_RESTORE_READBACK_MISMATCH' : 'CONVERSATION_RESTORE_LIST_READBACK_INCOMPLETE',
        });
        return { ...submitted, state: 'needs_review', verified: false, readbackStatus: ownerDetail.result.status,
          conversationPresent: targetActiveExactlyOnce, deletedEntryAbsent: targetAbsentFromDeleted,
          otherActiveConversationsUnchanged, otherDeletedConversationsUnchanged, viewerIsOwner: true };
      }

      await markVerified(journal, submitted.localOperationId, {
        httpStatus: ownerDetail.result.status,
        operationId: GROK_CONVERSATION_RESTORE_OPERATION_IDS.detail,
      });
      return { ...submitted, state: 'completed', verified: true,
        readbackStatus: ownerDetail.result.status, conversationPresent: true, deletedEntryAbsent: true,
        otherActiveConversationsUnchanged: true, otherDeletedConversationsUnchanged: true,
        viewerIsOwner: true, titleLength: typeof ownerDetail.conversation.title === 'string'
          ? ownerDetail.conversation.title.length : null };
    },
  });
}
