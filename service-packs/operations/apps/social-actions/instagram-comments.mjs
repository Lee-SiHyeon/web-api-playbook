import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  loadInstagramPostSources, metaFail, metaRequest, openMetaContext, relayDocId,
  sendMetaQuery, withMetaSessionLock,
} from './lib/meta-bootstrap.mjs';

const COMMENT_PAGE_LIMIT = 24;
const COMMENT_SCAN_MAX_PAGES = 100;
const JOURNAL_ROOT = path.join(os.homedir(), '.config', 'affiliate-content-operations', 'instagram-comment-write-journal');
const COMMENT_OPERATIONS = Object.freeze({
  initial: 'PolarisPostCommentsContainerQuery',
  page: 'PolarisPostCommentsPaginationQuery',
  replies: 'PolarisPostChildCommentsQuery',
  replyPage: 'PolarisPostCommentsChildrenPaginationtQuery',
  create: 'PolarisPostCommentInputRevampedMutation',
  delete: 'usePolarisPostDeleteCommentMutation',
  approve: 'usePolarisApproveRestrictedCommentMutation',
  like: 'usePolarisCommentLikeMutation',
  unlike: 'usePolarisCommentUnlikeMutation',
});

function validateHandle(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.]{1,30}$/.test(value)) metaFail('INSTAGRAM_COMMENT_HANDLE_INVALID');
  return value.toLowerCase();
}

function validateId(value, code) {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof id !== 'string' || !/^\d{1,30}$/.test(id)) metaFail(code);
  return id;
}

function validateCursor(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\x00-\x20\x7f]/.test(value)) {
    metaFail('INSTAGRAM_COMMENT_CURSOR_INVALID');
  }
  return value;
}

function validateLimit(value) {
  if (!Number.isInteger(value) || value < 1 || value > COMMENT_PAGE_LIMIT) metaFail('INSTAGRAM_COMMENT_LIMIT_INVALID');
  return value;
}

function validateIdempotencyKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) {
    metaFail('INSTAGRAM_COMMENT_IDEMPOTENCY_KEY_REQUIRED');
  }
  return value;
}

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

async function writeJournal(file, record, create = false) {
  await mkdir(JOURNAL_ROOT, { recursive: true });
  const text = JSON.stringify(record, null, 2) + '\n';
  if (create) { await writeFile(file, text, { flag: 'wx' }); return; }
  const temporary = file + '.' + process.pid + '.tmp';
  await writeFile(temporary, text, { flag: 'wx' });
  await rename(temporary, file);
}

async function reserveCommentWrite({ context, operation, idempotencyKey, shortcode, mediaId, commentId, text, parentCommentId }) {
  const keyHash = sha256(idempotencyKey);
  const file = path.join(JOURNAL_ROOT, keyHash + '.json');
  const record = { schemaVersion: 1, service: 'instagram', owner: context.bundle.owner, operation,
    idempotencyKeyHash: keyHash, shortcode, mediaId, ...(commentId ? { commentId } : {}),
    ...(parentCommentId ? { parentCommentId } : {}), ...(text ? { textSha256: sha256(text) } : {}),
    createdAt: new Date().toISOString(), state: 'reserved', writesSent: 0, readbackVerified: false };
  try { await writeJournal(file, record, true); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let prior;
    try { prior = JSON.parse(await readFile(file, 'utf8')); } catch { metaFail('INSTAGRAM_COMMENT_JOURNAL_INVALID'); }
    if (prior?.state !== 'not_sent' || prior?.writesSent !== 0) metaFail('INSTAGRAM_COMMENT_DUPLICATE_OR_UNRESOLVED');
    record.retryOf = prior.createdAt;
    await writeJournal(file, record);
  }
  return { file, record };
}

function source(context, name, code = 'INSTAGRAM_COMMENT_CONTRACT_CHANGED') {
  const result = context.sources.get(name)?.source;
  if (!result) metaFail('INSTAGRAM_COMMENT_SOURCE_MISSING');
  return result;
}

function assertFields(text, fields, code = 'INSTAGRAM_COMMENT_CONTRACT_CHANGED') {
  for (const field of fields) {
    if (!text.includes('name:"' + field + '"') && !text.includes(field + ':')) metaFail(code);
  }
}

function assertOperation(context, operation, root, variables = []) {
  const query = source(context, operation + '.graphql');
  const opModule = source(context, operation + '_instagramRelayOperation');
  const docId = relayDocId(context, operation);
  if (!query.includes(root)) metaFail('INSTAGRAM_COMMENT_CONTRACT_CHANGED');
  assertFields(query, variables);
  if (!/^\d{10,30}$/.test(docId) || !opModule.includes(docId)) metaFail('INSTAGRAM_COMMENT_CONTRACT_CHANGED');
  return { query, docId, sha256: context.sources.get(operation + '.graphql').sha256 };
}

export function normalizeInstagramComment(edge) {
  const node = edge?.node;
  if (!node || typeof node !== 'object' || node.pk == null) metaFail('INSTAGRAM_COMMENT_SCHEMA_INVALID');
  const id = String(node.pk);
  if (!/^\d{1,30}$/.test(id)) metaFail('INSTAGRAM_COMMENT_SCHEMA_INVALID');
  const authorId = node.user?.pk == null ? null : String(node.user.pk);
  const timestamp = Number(node.created_at);
  return {
    id,
    text: typeof node.text === 'string' ? node.text : null,
    username: typeof node.user?.username === 'string' ? node.user.username : null,
    userId: authorId && /^\d{1,30}$/.test(authorId) ? authorId : null,
    createdAt: Number.isSafeInteger(timestamp) && timestamp >= 0 && timestamp <= 4_102_444_800
      ? new Date(timestamp * 1000).toISOString() : null,
    parentCommentId: node.parent_comment_id == null ? null : String(node.parent_comment_id),
    childCommentCount: Number.isSafeInteger(node.child_comment_count) && node.child_comment_count >= 0
      ? node.child_comment_count : 0,
    restrictedStatus: Number.isSafeInteger(node.restricted_status) || typeof node.restricted_status === 'string'
      ? node.restricted_status : null,
    covered: node.is_covered === true,
    edited: node.is_edited === true,
    likedByViewer: node.has_liked_comment === true,
    likeCount: Number.isSafeInteger(node.comment_like_count) && node.comment_like_count >= 0
      ? node.comment_like_count : null,
  };
}

async function withPostContext({ handle, shortcode, isReel = false, mediaId } = {}, operation) {
  const owner = validateHandle(handle);
  if (typeof shortcode !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(shortcode)) metaFail('INSTAGRAM_POST_SOURCE_INPUT');
  if (typeof isReel !== 'boolean') metaFail('INSTAGRAM_POST_SOURCE_INPUT');
  return withMetaSessionLock('instagram', async () => {
    const context = await openMetaContext('instagram', owner);
    const loaded = await loadInstagramPostSources(context, { shortcode, isReel, mediaId });
    context.sources = new Map([...context.sources, ...loaded.sources]);
    context.postSourceReceipt = loaded.receipt;
    return operation(context, owner);
  });
}

function commentReceipt(result, contract, operation, responseKeys = []) {
  return {
    ...result.receipt,
    operation,
    live_replay: true,
    captured: false,
    client_exists: true,
    credential_propagated: true,
    remnant_free: true,
    browserUsed: false,
    sourceSha256: contract.sha256,
    docId: contract.docId,
    responseKeys,
    evidence: 'current_first_party_graphql_module_and_direct_http_replay',
  };
}

export async function readInstagramComments({
  handle, shortcode, isReel = false, mediaId, limit = COMMENT_PAGE_LIMIT, after = null, sortOrder = 'popular',
} = {}) {
  const normalizedMediaId = validateId(mediaId, 'INSTAGRAM_COMMENT_MEDIA_ID_INVALID');
  const pageSize = validateLimit(limit);
  const cursor = validateCursor(after);
  if (!['popular', 'recent'].includes(sortOrder)) metaFail('INSTAGRAM_COMMENT_SORT_INVALID');
  return withPostContext({ handle, shortcode, isReel, mediaId: normalizedMediaId }, async context => {
    const operation = cursor || sortOrder === 'recent' ? COMMENT_OPERATIONS.page : COMMENT_OPERATIONS.initial;
    const contract = assertOperation(context, operation, 'xdt_api__v1__media__media_id__comments__connection',
      ['after', 'before', 'first', 'last', 'media_id']);
    if (operation === COMMENT_OPERATIONS.page && !contract.query.includes('name:"sort_order"')) {
      metaFail('INSTAGRAM_COMMENT_CONTRACT_CHANGED');
    }
    const loggedInProvider = source(context, 'PolarisIsLoggedIn.relayprovider');
    const featureId = /gkx"\)\("(\d{1,10})"\)/.exec(loggedInProvider)?.[1];
    if (!featureId || !context.document.gkx.has(featureId)
      || typeof context.document.gkx.get(featureId) !== 'boolean') metaFail('INSTAGRAM_COMMENT_CONTRACT_CHANGED');
    const variables = {
      after: cursor,
      before: null,
      first: pageSize,
      last: null,
      media_id: normalizedMediaId,
      __relay_internal__pv__PolarisIsLoggedInrelayprovider: context.document.gkx.get(featureId),
      ...(operation === COMMENT_OPERATIONS.page ? { sort_order: sortOrder } : {}),
    };
    const result = await sendMetaQuery(context,
      metaRequest(context, operation, contract.docId, variables));
    const connection = result.payload.data?.xdt_api__v1__media__media_id__comments__connection;
    if (!Array.isArray(connection?.edges) || connection.edges.length > pageSize
      || typeof connection.page_info?.has_next_page !== 'boolean'
      || (connection.page_info.end_cursor != null && typeof connection.page_info.end_cursor !== 'string')) {
      metaFail('INSTAGRAM_COMMENT_SCHEMA_INVALID');
    }
    const comments = connection.edges.map(normalizeInstagramComment);
    return {
      service: 'instagram', operation: 'comments', mediaId: normalizedMediaId, comments,
      pagination: { requested: pageSize, returned: comments.length,
        hasNextPage: connection.page_info.has_next_page, nextCursor: connection.page_info.end_cursor || null },
      receipt: commentReceipt(result, contract, operation, Object.keys(connection)),
    };
  });
}

export async function readInstagramCommentReplies({
  handle, shortcode, isReel = false, mediaId, parentCommentId, limit = COMMENT_PAGE_LIMIT, after = null,
} = {}) {
  const normalizedMediaId = validateId(mediaId, 'INSTAGRAM_COMMENT_MEDIA_ID_INVALID');
  const parentId = validateId(parentCommentId, 'INSTAGRAM_COMMENT_PARENT_ID_INVALID');
  const pageSize = validateLimit(limit);
  const cursor = validateCursor(after);
  return withPostContext({ handle, shortcode, isReel, mediaId: normalizedMediaId }, async context => {
    const operation = cursor ? COMMENT_OPERATIONS.replyPage : COMMENT_OPERATIONS.replies;
    const contract = assertOperation(context, operation,
      'xdt_api__v1__media__media_id__comments__parent_comment_id__child_comments__connection',
      ['after', 'before', 'first', 'is_chronological', 'last', 'media_id', 'parent_comment_id']);
    const provider = source(context, 'PolarisIsLoggedIn.relayprovider');
    const featureId = /gkx"\)\("(\d{1,10})"\)/.exec(provider)?.[1];
    if (!featureId || !context.document.gkx.has(featureId)
      || typeof context.document.gkx.get(featureId) !== 'boolean') metaFail('INSTAGRAM_COMMENT_CONTRACT_CHANGED');
    const variables = {
      after: cursor,
      before: null,
      first: pageSize,
      is_chronological: true,
      last: null,
      media_id: normalizedMediaId,
      parent_comment_id: parentId,
      __relay_internal__pv__PolarisIsLoggedInrelayprovider: context.document.gkx.get(featureId),
    };
    const result = await sendMetaQuery(context,
      metaRequest(context, operation, contract.docId, variables));
    const connection = result.payload.data?.xdt_api__v1__media__media_id__comments__parent_comment_id__child_comments__connection;
    if (!Array.isArray(connection?.edges) || connection.edges.length > pageSize
      || typeof connection.page_info?.has_next_page !== 'boolean'
      || (connection.page_info.end_cursor != null && typeof connection.page_info.end_cursor !== 'string')) {
      metaFail('INSTAGRAM_COMMENT_SCHEMA_INVALID');
    }
    return {
      service: 'instagram', operation: 'comment_replies', mediaId: normalizedMediaId,
      parentCommentId: parentId, comments: connection.edges.map(normalizeInstagramComment),
      pagination: { requested: pageSize, returned: connection.edges.length,
        hasNextPage: connection.page_info.has_next_page, nextCursor: connection.page_info.end_cursor || null },
      receipt: commentReceipt(result, contract, operation, Object.keys(connection)),
    };
  });
}

// An absent comment is conclusive only after the Relay connection is exhausted.
// readPage is injected so cursor and exhaustion behavior can be verified without HTTP.
export async function findInstagramCommentInPages(readPage, commentId, { maxPages = COMMENT_SCAN_MAX_PAGES } = {}) {
  const targetId = validateId(commentId, 'INSTAGRAM_COMMENT_ID_INVALID');
  if (typeof readPage !== 'function' || !Number.isInteger(maxPages) || maxPages < 1
    || maxPages > COMMENT_SCAN_MAX_PAGES) metaFail('INSTAGRAM_COMMENT_SCAN_INPUT_INVALID');
  const seenCursors = new Set();
  let after = null;
  for (let pagesRead = 0; pagesRead < maxPages; pagesRead++) {
    const page = await readPage(after);
    if (!page || !Array.isArray(page.comments)) return { state: 'incomplete', comment: null, pagesRead: pagesRead + 1 };
    const comment = page.comments.find(item => item?.id === targetId);
    if (comment) return { state: 'found', comment, pagesRead: pagesRead + 1 };
    const hasNextPage = page.pagination?.hasNextPage;
    if (hasNextPage === false) return { state: 'not_found', comment: null, pagesRead: pagesRead + 1 };
    const nextCursor = page.pagination?.nextCursor;
    if (hasNextPage !== true || typeof nextCursor !== 'string' || !nextCursor
      || /[\x00-\x20\x7f]/.test(nextCursor) || nextCursor.length > 8192
      || nextCursor === after || seenCursors.has(nextCursor)) {
      return { state: 'incomplete', comment: null, pagesRead: pagesRead + 1 };
    }
    seenCursors.add(nextCursor);
    after = nextCursor;
  }
  return { state: 'incomplete', comment: null, pagesRead: maxPages };
}

export async function findInstagramCommentOnPost({
  handle, shortcode, isReel = false, mediaId, commentId, parentCommentId = null,
} = {}, { readComments = readInstagramComments, readReplies = readInstagramCommentReplies,
  maxPages = COMMENT_SCAN_MAX_PAGES } = {}) {
  const owner = validateHandle(handle);
  if (typeof shortcode !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(shortcode)
    || typeof isReel !== 'boolean') metaFail('INSTAGRAM_POST_SOURCE_INPUT');
  const normalizedMediaId = validateId(mediaId, 'INSTAGRAM_COMMENT_MEDIA_ID_INVALID');
  const targetId = validateId(commentId, 'INSTAGRAM_COMMENT_ID_INVALID');
  const parentId = parentCommentId == null ? null : validateId(parentCommentId, 'INSTAGRAM_COMMENT_PARENT_ID_INVALID');
  if (typeof readComments !== 'function' || typeof readReplies !== 'function') metaFail('INSTAGRAM_COMMENT_SCAN_INPUT_INVALID');
  const readTopLevel = after => readComments({ handle: owner, shortcode, isReel, mediaId: normalizedMediaId,
    limit: COMMENT_PAGE_LIMIT, after, sortOrder: 'recent' });
  if (parentId == null) {
    return findInstagramCommentInPages(readTopLevel, targetId, { maxPages });
  }
  const parent = await findInstagramCommentInPages(readTopLevel, parentId, { maxPages });
  if (parent.state !== 'found') return { state: 'parent_unverified', comment: null, pagesRead: parent.pagesRead };
  const readThread = after => readReplies({ handle: owner, shortcode, isReel, mediaId: normalizedMediaId,
    parentCommentId: parentId, limit: COMMENT_PAGE_LIMIT, after });
  const reply = await findInstagramCommentInPages(readThread, targetId, { maxPages });
  if (reply.state === 'found' && reply.comment.parentCommentId !== parentId) {
    return { state: 'parent_unverified', comment: null, pagesRead: parent.pagesRead + reply.pagesRead };
  }
  return { ...reply, pagesRead: parent.pagesRead + reply.pagesRead };
}

function requireCommentOnPost(result) {
  if (result.state === 'found') return result.comment;
  metaFail(result.state === 'not_found' ? 'INSTAGRAM_COMMENT_NOT_ON_POST' : 'INSTAGRAM_COMMENT_POST_MEMBERSHIP_UNVERIFIED');
}

export function isInstagramCommentRestricted(comment) {
  return Boolean(comment && comment.restrictedStatus === 1);
}

export function isInstagramCommentApprovalVerified(comment) {
  // First-party UI marks status 1 as restricted and the approval updater writes numeric 0.
  // Null and unknown values are not proof that approval completed.
  return Boolean(comment && comment.restrictedStatus === 0);
}

export function isInstagramCommentDeletionVerified(lookup) {
  return lookup?.state === 'not_found';
}

function validateCommentText(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2200) metaFail('INSTAGRAM_COMMENT_TEXT_INVALID');
  return value;
}

function exactReplyIdRequest(request, replyId) {
  const encoded = request.body.get('variables');
  const needle = '"replied_to_comment_id":' + JSON.stringify(replyId);
  if (typeof encoded !== 'string' || !encoded.includes(needle)) metaFail('INSTAGRAM_COMMENT_VARIABLE_ENCODING_CHANGED');
  request.body.set('variables', encoded.replace(needle, '"replied_to_comment_id":' + replyId));
  return request;
}

async function sendJournaledMutation(context, request, operation, root, journal) {
  journal.record.state = 'sending';
  journal.record.writesSent = 1;
  await writeJournal(journal.file, journal.record);
  let result;
  try { result = await sendMetaQuery(context, request); }
  catch (error) {
    journal.record.state = 'needs_reconciliation';
    journal.record.failureCode = /^[A-Z0-9_]{1,100}$/.test(error.code || '') ? error.code : 'INSTAGRAM_COMMENT_WRITE_UNKNOWN';
    await writeJournal(journal.file, journal.record).catch(() => {});
    metaFail('INSTAGRAM_COMMENT_WRITE_UNCERTAIN');
  }
  const value = result.payload.data?.[root];
  if (!value || typeof value !== 'object') {
    journal.record.state = 'needs_reconciliation';
    journal.record.failureCode = 'INSTAGRAM_COMMENT_WRITE_RESPONSE_INVALID';
    await writeJournal(journal.file, journal.record);
    metaFail('INSTAGRAM_COMMENT_WRITE_UNCERTAIN');
  }
  journal.record.state = 'response_received';
  journal.record.responseCommentId = value.comment_dict?.pk == null ? null : String(value.comment_dict.pk);
  await writeJournal(journal.file, journal.record);
  return { result, value };
}

function mutationReceipt(result, value, contract, operation, journalPath) {
  return {
    service: 'instagram', operation, result: value, state: 'response_received', journal: journalPath,
    receipt: {
      ...result.receipt, operation, live_replay: true, captured: false, client_exists: true,
      credential_propagated: true, remnant_free: true, browserUsed: false,
      sourceSha256: contract.sha256, docId: contract.docId,
      evidence: 'source_derived_first_party_mutation_response_no_browser_capture',
      readbackVerified: false,
    },
  };
}

async function finishCommentWrite(response, { handle, shortcode, isReel, mediaId, operation, commentId,
  text, parentCommentId }) {
  const record = JSON.parse(await readFile(response.journal, 'utf8'));
  let verified = false;
  try {
    const lookup = await findInstagramCommentOnPost({ handle, shortcode, isReel, mediaId, commentId, parentCommentId });
    const matched = lookup.state === 'found' ? lookup.comment : null;
    if (operation === 'create_comment' || operation === 'reply_to_comment') {
      verified = Boolean(matched && matched.text === text
        && (parentCommentId == null || matched.parentCommentId === parentCommentId));
    } else if (operation === 'delete_comment') verified = isInstagramCommentDeletionVerified(lookup);
    else if (operation === 'approve_restricted_comment') {
      verified = isInstagramCommentApprovalVerified(matched);
    } else if (operation === 'like_comment') verified = Boolean(matched?.likedByViewer);
    else if (operation === 'unlike_comment') verified = Boolean(matched && !matched.likedByViewer);
  } catch { /* Keep the journal unresolved when readback is unavailable. */ }
  record.state = verified ? 'readback_verified' : 'needs_reconciliation';
  record.readbackVerified = verified;
  await writeJournal(response.journal, record);
  return { ...response, state: record.state,
    receipt: { ...response.receipt, readbackVerified: verified, journal: response.journal } };
}

export async function createInstagramComment({
  handle, shortcode, isReel = false, mediaId, text, replyToCommentId = null, idempotencyKey,
} = {}) {
  const normalizedMediaId = validateId(mediaId, 'INSTAGRAM_COMMENT_MEDIA_ID_INVALID');
  const commentText = validateCommentText(text);
  const key = validateIdempotencyKey(idempotencyKey);
  const replyId = replyToCommentId == null ? null : validateId(replyToCommentId, 'INSTAGRAM_COMMENT_PARENT_ID_INVALID');
  if (replyId != null) {
    requireCommentOnPost(await findInstagramCommentOnPost({ handle, shortcode, isReel,
      mediaId: normalizedMediaId, commentId: replyId }));
  }
  const result = await withPostContext({ handle, shortcode, isReel, mediaId: normalizedMediaId }, async context => {
    const operation = COMMENT_OPERATIONS.create;
    const contract = assertOperation(context, operation, 'xig_comment_create', ['data']);
    const inputSource = source(context, 'PolarisPostCommentInputRevamped.react');
    if (!inputSource.includes('comment_text') || !inputSource.includes('media_id')) {
      metaFail('INSTAGRAM_COMMENT_CONTRACT_CHANGED');
    }
    const data = { comment_text: commentText, media_id: normalizedMediaId };
    if (replyId != null) data.replied_to_comment_id = replyId;
    const writeOperation = replyId == null ? 'create_comment' : 'reply_to_comment';
    const journal = await reserveCommentWrite({ context, operation: writeOperation, idempotencyKey: key,
      shortcode, mediaId: normalizedMediaId, text: commentText, parentCommentId: replyId });
    let request = metaRequest(context, operation, contract.docId, { data });
    if (replyId != null) request = exactReplyIdRequest(request, replyId);
    const sent = await sendJournaledMutation(context, request, operation, 'xig_comment_create', journal);
    const response = mutationReceipt(sent.result, sent.value, contract, writeOperation, journal.file);
    const responseId = sent.value.comment_dict?.pk == null ? null : String(sent.value.comment_dict.pk);
    return { ...response, commentId: responseId, response, journal: journal.file };
  });
  const writeOperation = replyId == null ? 'create_comment' : 'reply_to_comment';
  return finishCommentWrite(result.response, { handle, shortcode, isReel, mediaId: normalizedMediaId,
    operation: writeOperation, commentId: result.commentId, text: commentText, parentCommentId: replyId });
}

export async function deleteInstagramComment({ handle, shortcode, isReel = false, mediaId, commentId,
  parentCommentId = null, idempotencyKey } = {}) {
  const normalizedMediaId = validateId(mediaId, 'INSTAGRAM_COMMENT_MEDIA_ID_INVALID');
  const normalizedCommentId = validateId(commentId, 'INSTAGRAM_COMMENT_ID_INVALID');
  const normalizedParentId = parentCommentId == null ? null : validateId(parentCommentId, 'INSTAGRAM_COMMENT_PARENT_ID_INVALID');
  const key = validateIdempotencyKey(idempotencyKey);
  requireCommentOnPost(await findInstagramCommentOnPost({ handle, shortcode, isReel,
    mediaId: normalizedMediaId, commentId: normalizedCommentId, parentCommentId: normalizedParentId }));
  const response = await withPostContext({ handle, shortcode, isReel, mediaId: normalizedMediaId }, async context => {
    const operation = COMMENT_OPERATIONS.delete;
    const contract = assertOperation(context, operation, 'xig_comment_delete', ['input']);
    const inputSource = source(context, 'usePolarisPostDeleteComment');
    if (!inputSource.includes('comment_id') || !inputSource.includes('media_id')) {
      metaFail('INSTAGRAM_COMMENT_CONTRACT_CHANGED');
    }
    const journal = await reserveCommentWrite({ context, operation: 'delete_comment', idempotencyKey: key,
      shortcode, mediaId: normalizedMediaId, commentId: normalizedCommentId, parentCommentId: normalizedParentId });
    const request = metaRequest(context, operation, contract.docId,
      { input: { comment_id: normalizedCommentId, media_id: normalizedMediaId } });
    const sent = await sendJournaledMutation(context, request, operation, 'xig_comment_delete', journal);
    return mutationReceipt(sent.result, sent.value, contract, 'delete_comment', journal.file);
  });
  return finishCommentWrite(response, { handle, shortcode, isReel, mediaId: normalizedMediaId,
    operation: 'delete_comment', commentId: normalizedCommentId, parentCommentId: normalizedParentId });
}

export async function approveInstagramRestrictedComment({ handle, shortcode, isReel = false, mediaId,
  commentId, parentCommentId = null, idempotencyKey } = {}) {
  const normalizedMediaId = validateId(mediaId, 'INSTAGRAM_COMMENT_MEDIA_ID_INVALID');
  const normalizedCommentId = validateId(commentId, 'INSTAGRAM_COMMENT_ID_INVALID');
  const normalizedParentId = parentCommentId == null ? null : validateId(parentCommentId, 'INSTAGRAM_COMMENT_PARENT_ID_INVALID');
  const key = validateIdempotencyKey(idempotencyKey);
  const target = requireCommentOnPost(await findInstagramCommentOnPost({ handle, shortcode, isReel,
    mediaId: normalizedMediaId, commentId: normalizedCommentId, parentCommentId: normalizedParentId }));
  if (!isInstagramCommentRestricted(target)) metaFail('INSTAGRAM_COMMENT_RESTRICTED_STATUS_UNVERIFIED');
  const response = await withPostContext({ handle, shortcode, isReel, mediaId: normalizedMediaId }, async context => {
    const operation = COMMENT_OPERATIONS.approve;
    const contract = assertOperation(context, operation,
      'xdt_api__v1__restrict_action__approve_restricted_comment', ['comment_id']);
    const journal = await reserveCommentWrite({ context, operation: 'approve_restricted_comment', idempotencyKey: key,
      shortcode, mediaId: normalizedMediaId, commentId: normalizedCommentId, parentCommentId: normalizedParentId });
    const request = metaRequest(context, operation, contract.docId, { comment_id: normalizedCommentId });
    const sent = await sendJournaledMutation(context, request, operation,
      'xdt_api__v1__restrict_action__approve_restricted_comment', journal);
    return mutationReceipt(sent.result, sent.value, contract, 'approve_restricted_comment', journal.file);
  });
  return finishCommentWrite(response, { handle, shortcode, isReel, mediaId: normalizedMediaId,
    operation: 'approve_restricted_comment', commentId: normalizedCommentId, parentCommentId: normalizedParentId });
}

async function setInstagramCommentLike({ handle, shortcode, isReel = false, mediaId, commentId,
  parentCommentId = null, idempotencyKey } = {}, desired) {
  const normalizedMediaId = validateId(mediaId, 'INSTAGRAM_COMMENT_MEDIA_ID_INVALID');
  const normalizedCommentId = validateId(commentId, 'INSTAGRAM_COMMENT_ID_INVALID');
  const normalizedParentId = parentCommentId == null ? null : validateId(parentCommentId, 'INSTAGRAM_COMMENT_PARENT_ID_INVALID');
  const key = validateIdempotencyKey(idempotencyKey);
  requireCommentOnPost(await findInstagramCommentOnPost({ handle, shortcode, isReel,
    mediaId: normalizedMediaId, commentId: normalizedCommentId, parentCommentId: normalizedParentId }));
  const operationName = desired ? COMMENT_OPERATIONS.like : COMMENT_OPERATIONS.unlike;
  const root = desired ? 'xig_comment_like' : 'xig_comment_unlike';
  const response = await withPostContext({ handle, shortcode, isReel, mediaId: normalizedMediaId }, async context => {
    const contract = assertOperation(context, operationName, root, ['input']);
    const caller = source(context, desired ? 'usePolarisCommentLike' : 'usePolarisCommentUnlike');
    if (!caller.includes('variables:{input:{comment_id:i.pk}}')) metaFail('INSTAGRAM_COMMENT_CONTRACT_CHANGED');
    const journal = await reserveCommentWrite({ context, operation: desired ? 'like_comment' : 'unlike_comment',
      idempotencyKey: key, shortcode, mediaId: normalizedMediaId, commentId: normalizedCommentId,
      parentCommentId: normalizedParentId });
    const request = metaRequest(context, operationName, contract.docId, { input: { comment_id: normalizedCommentId } });
    const sent = await sendJournaledMutation(context, request, operationName, root, journal);
    return mutationReceipt(sent.result, sent.value, contract, desired ? 'like_comment' : 'unlike_comment', journal.file);
  });
  return finishCommentWrite(response, { handle, shortcode, isReel, mediaId: normalizedMediaId,
    operation: desired ? 'like_comment' : 'unlike_comment', commentId: normalizedCommentId,
    parentCommentId: normalizedParentId });
}

export async function likeInstagramComment(input = {}) { return setInstagramCommentLike(input, true); }
export async function unlikeInstagramComment(input = {}) { return setInstagramCommentLike(input, false); }

export const instagramCommentCapabilities = Object.freeze([
  'comments', 'comment_replies', 'create_comment', 'reply_to_comment', 'delete_comment',
  'approve_restricted_comment', 'like_comment', 'unlike_comment',
]);
