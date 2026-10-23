import { createHash } from 'node:crypto';
import { fail } from './errors.mjs';

export const GROK_CONVERSATION_OPERATION_IDS = Object.freeze({
  list: 'conversation.list.read',
  read: 'conversation.read',
  responseNodes: 'history.response-nodes',
  loadResponses: 'history.load-responses',
  taskResponses: 'history.task-responses',
  sharingRead: 'conversation.share.read',
  sharingSet: 'conversation.share.set',
  sharingLinkRead: 'conversation.share.link.read',
  sharingRevoke: 'conversation.share.revoke',
  settingsRead: 'settings.read',
  settingsUpdate: 'settings.update',
  imagineModelOverrides: 'models.imagine-overrides',
  modes: 'models.modes',
  uploadStatus: 'upload.status',
  uploadInit: 'upload.init',
  uploadPatch: 'upload.patch',
  uploadComplete: 'upload.complete',
  uploadAbort: 'upload.abort',
  create: 'conversation.create',
  update: 'conversation.update',
  regenerate: 'conversation.regenerate',
  delete: 'conversation.soft-delete',
  softDelete: 'conversation.soft-delete',
  restore: 'conversation.restore',
});

export const GROK_CONVERSATION_SOURCE_DISCOVERY_PERMITS = Object.freeze({
  create: 'first-live:conversation.create',
  titleUpdate: 'first-live:conversation.update',
  regenerateResponse: 'first-live:conversation.regenerate',
  settingsUpdate: 'first-live:settings.update',
  sharingSet: 'first-live:conversation.share.set',
  sharingRevoke: 'first-live:conversation.share.revoke',
  sharingLinkRead: 'first-read:conversation.share.link.read',
  delete: 'first-live:conversation.soft-delete',
});

const LIST_FIELDS = new Set([
  'pageSize', 'pageToken', 'searchQuery', 'workspaceId', 'filterIsStarred', 'forceElastic',
  'kind', 'isKidsMode', 'enableNsfw', 'excludeProjects', 'includeComputer',
]);
const CREATE_FIELDS = new Set([
  'systemPromptName', 'temporary', 'addResponseRequest', 'workspaceIds', 'taskResultId', 'templateId', 'kind',
]);
const UPDATE_FIELDS = new Set(['title', 'starred', 'botAgentId']);
const REGENERATE_PROOF_FIELDS = new Set(['expectedParentMessageSha256', 'expectedAssistantPattern']);
const SHARE_FIELDS = new Set(['responseId', 'allowIndexing']);
const SAFE_SETTINGS_PREFERENCE = 'autoWrapLongLinesCode';
const PAGE_LIMIT = 20;

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateId(value, code) {
  if (typeof value !== 'string' || value.length < 16 || value.length > 512
    || /[\r\n\0]/.test(value)) throw fail(code);
  return value;
}

function validateText(value, code, { max = 4_000, allowEmpty = false } = {}) {
  if (typeof value !== 'string' || value.length > max || /[\r\n\0]/.test(value)
    || (!allowEmpty && !value.trim())) throw fail(code);
  return value;
}

function validateRegenerateProof(value, required) {
  if (value === undefined && !required) return null;
  assertKeys(value, REGENERATE_PROOF_FIELDS, 'CONVERSATION_REGENERATE_PROOF_INVALID');
  if (typeof value.expectedParentMessageSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.expectedParentMessageSha256)) throw fail('CONVERSATION_REGENERATE_PROOF_INVALID');
  validateText(value.expectedAssistantPattern, 'CONVERSATION_REGENERATE_PROOF_INVALID', { max: 512 });
  try { new RegExp(value.expectedAssistantPattern); } catch { throw fail('CONVERSATION_REGENERATE_PROOF_INVALID'); }
  return value;
}

function messageHash(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function shareLinkContainsResponse(linkData, responseId) {
  return Array.isArray(linkData?.responses)
    && linkData.responses.some(response => plainObject(response) && response.responseId === responseId);
}

function senderKind(value) {
  const sender = typeof value === 'string' ? value.toLowerCase() : '';
  if (sender === 'assistant' || sender === 'model') return 'assistant';
  if (sender === 'user' || sender === 'human') return 'user';
  return 'other';
}

function validateSafeIntent(options, codePrefix) {
  if (!plainObject(options) || options.confirm !== true) throw fail(`${codePrefix}_CONFIRM_REQUIRED`);
  validateText(options.intentId, `${codePrefix}_INTENT_ID_REQUIRED`, { max: 256 });
  return options;
}

function assertOwnerVerified(status, codePrefix = 'CONVERSATION') {
  if (status?.session?.ownerVerified !== true) throw fail('OWNER_VERIFICATION_REQUIRED', { codePrefix });
}

function assertKeys(value, allowed, code) {
  if (!plainObject(value) || Object.keys(value).some(key => !allowed.has(key))) throw fail(code);
  return value;
}

function readResult(result, code) {
  if (!result || !Number.isInteger(result.status) || result.status < 200 || result.status >= 300
    || !plainObject(result.data)) throw fail(code);
  return result;
}

function conversationRecord(data) {
  return plainObject(data.conversation) ? data.conversation : data;
}

function validateListInput(input = {}) {
  assertKeys(input, LIST_FIELDS, 'CONVERSATION_LIST_INPUT_INVALID');
  if (input.pageSize !== undefined && (!Number.isInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 1_000)) {
    throw fail('CONVERSATION_PAGE_SIZE_INVALID');
  }
  if (input.pageToken !== undefined) validateText(input.pageToken, 'CONVERSATION_PAGE_TOKEN_INVALID', { max: 8_192 });
  if (input.searchQuery !== undefined) validateText(input.searchQuery, 'CONVERSATION_SEARCH_QUERY_INVALID', { max: 512 });
  if (input.workspaceId !== undefined) validateId(input.workspaceId, 'CONVERSATION_WORKSPACE_ID_INVALID');
  for (const key of ['filterIsStarred', 'forceElastic', 'isKidsMode', 'enableNsfw', 'excludeProjects', 'includeComputer']) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') throw fail('CONVERSATION_LIST_INPUT_INVALID', { field: key });
  }
  for (const key of ['kind']) {
    if (input[key] !== undefined) validateText(input[key], 'CONVERSATION_LIST_INPUT_INVALID', { max: 128 });
  }
  return input;
}

function validateResponseIds(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 500) throw fail('HISTORY_RESPONSE_IDS_INVALID');
  const ids = value.map(id => validateId(id, 'HISTORY_RESPONSE_ID_INVALID'));
  if (new Set(ids).size !== ids.length) throw fail('HISTORY_RESPONSE_IDS_DUPLICATE');
  return ids;
}

function validateCreateBody(body) {
  assertKeys(body, CREATE_FIELDS, 'CONVERSATION_CREATE_BODY_INVALID');
  if (Object.hasOwn(body, 'systemPromptName')) validateText(body.systemPromptName, 'CONVERSATION_SYSTEM_PROMPT_INVALID', { max: 256, allowEmpty: true });
  if (Object.hasOwn(body, 'temporary') && typeof body.temporary !== 'boolean') throw fail('CONVERSATION_TEMPORARY_FLAG_INVALID');
  if (Object.hasOwn(body, 'workspaceIds')) {
    if (!Array.isArray(body.workspaceIds) || body.workspaceIds.length > 32) throw fail('CONVERSATION_WORKSPACE_IDS_INVALID');
    for (const id of body.workspaceIds) validateId(id, 'CONVERSATION_WORKSPACE_ID_INVALID');
  }
  for (const key of ['taskResultId', 'templateId']) {
    if (Object.hasOwn(body, key)) validateText(body[key], 'CONVERSATION_CREATE_BODY_INVALID', { max: 512 });
  }
  if (Object.hasOwn(body, 'kind')) validateText(body.kind, 'CONVERSATION_KIND_INVALID', { max: 128 });
  if (Object.hasOwn(body, 'addResponseRequest')) validateBoundedJsonObject(body.addResponseRequest, 'CONVERSATION_INITIAL_RESPONSE_INVALID', 64 * 1024);
  return body;
}

function validateUpdateBody(body) {
  assertKeys(body, UPDATE_FIELDS, 'CONVERSATION_UPDATE_BODY_INVALID');
  if (!Object.keys(body).length) throw fail('CONVERSATION_UPDATE_EMPTY');
  if (Object.hasOwn(body, 'title')) validateText(body.title, 'CONVERSATION_TITLE_INVALID', { max: 256 });
  if (Object.hasOwn(body, 'starred') && typeof body.starred !== 'boolean') throw fail('CONVERSATION_STARRED_FLAG_INVALID');
  if (Object.hasOwn(body, 'botAgentId')) validateText(body.botAgentId, 'CONVERSATION_BOT_AGENT_ID_INVALID', { max: 512 });
  return body;
}

function validateBoundedJsonObject(value, code, maxBytes, depth = 0) {
  if (!plainObject(value) || depth > 12) throw fail(code);
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw fail(code); }
  if (Buffer.byteLength(encoded, 'utf8') > maxBytes) throw fail(code);
  return value;
}

function validateSharingBody(body) {
  assertKeys(body, SHARE_FIELDS, 'CONVERSATION_SHARING_BODY_INVALID');
  if (!Object.hasOwn(body, 'responseId')) throw fail('CONVERSATION_SHARING_RESPONSE_ID_REQUIRED');
  validateId(body.responseId, 'CONVERSATION_SHARING_RESPONSE_ID_INVALID');
  if (!Object.hasOwn(body, 'allowIndexing') || typeof body.allowIndexing !== 'boolean') {
    throw fail('CONVERSATION_SHARING_INDEXING_CHOICE_REQUIRED');
  }
  return body;
}

async function holdForReview(journal, localOperationId, { httpStatus, reasonCode }) {
  const entry = await journal.get(localOperationId);
  if (entry && ['accepted', 'processing', 'outcome_unknown'].includes(entry.state)) {
    await journal.transition(localOperationId, 'needs_review', { httpStatus, reasonCode });
  }
}

async function markVerified(journal, localOperationId, { httpStatus, operationId }) {
  const entry = await journal.get(localOperationId);
  if (!entry || !['accepted', 'outcome_unknown', 'needs_review'].includes(entry.state)) throw fail('CONVERSATION_JOURNAL_READBACK_STATE_INVALID');
  await journal.transition(localOperationId, 'completed', {
    httpStatus,
    reasonCode: 'CONVERSATION_READBACK_VERIFIED',
    reconciledBy: operationId,
  });
}

async function allConversationIds(read, pageSize = 1_000) {
  const ids = new Set();
  const tokens = new Set();
  let pageToken;
  let complete = false;
  let status = 200;
  for (let page = 0; page < PAGE_LIMIT; page++) {
    const result = readResult(await read(GROK_CONVERSATION_OPERATION_IDS.list, {
      pageSize,
      ...(pageToken ? { pageToken } : {}),
    }), 'CONVERSATION_LIST_READ_FAILED');
    const data = result.data;
    if (!Array.isArray(data.conversations)) throw fail('CONVERSATION_LIST_RESPONSE_INVALID');
    status = result.status;
    for (const item of data.conversations) {
      if (!plainObject(item) || typeof item.conversationId !== 'string') throw fail('CONVERSATION_LIST_RESPONSE_INVALID');
      ids.add(item.conversationId);
    }
    const next = data.nextPageToken;
    if (typeof next !== 'string' || !next) { complete = true; break; }
    validateText(next, 'CONVERSATION_PAGE_TOKEN_INVALID', { max: 8_192 });
    if (tokens.has(next)) throw fail('CONVERSATION_CURSOR_CYCLE');
    tokens.add(next);
    pageToken = next;
  }
  return { ids, complete, status };
}

export function createGrokConversationClient({ client, journal } = {}) {
  if (!client || typeof client.read !== 'function' || typeof client.submit !== 'function'
    || typeof client.status !== 'function' || typeof journal?.get !== 'function'
    || typeof journal?.transition !== 'function') throw fail('CONVERSATION_RUNTIME_REQUIRED');

  async function readConversation(id) {
    const conversationId = validateId(id, 'CONVERSATION_ID_INVALID');
    const result = readResult(await client.read(GROK_CONVERSATION_OPERATION_IDS.read, { conversationId }), 'CONVERSATION_READ_FAILED');
    const conversation = conversationRecord(result.data);
    if (conversation.conversationId !== conversationId) throw fail('CONVERSATION_READ_ID_MISMATCH');
    return result;
  }

  async function readSettings() {
    return readResult(await client.read(GROK_CONVERSATION_OPERATION_IDS.settingsRead, {}), 'SETTINGS_READ_FAILED');
  }

  async function readSharing(conversationId, responseId) {
    const id = validateId(conversationId, 'CONVERSATION_ID_INVALID');
    const response = validateId(responseId, 'CONVERSATION_SHARING_RESPONSE_ID_INVALID');
    const result = readResult(await client.read(GROK_CONVERSATION_OPERATION_IDS.sharingRead, {
      conversationId: id,
      responseId: response,
    }), 'CONVERSATION_SHARING_READ_FAILED');
    if (!plainObject(result.data.sharing)
      && typeof result.data.workspaceSeedEligible !== 'boolean'
      && typeof result.data.workspaceSeedIneligibleReason !== 'string') {
      throw fail('CONVERSATION_SHARING_RESPONSE_INVALID');
    }
    return result;
  }

  async function readShareLink(shareLinkId) {
    const id = validateId(shareLinkId, 'CONVERSATION_SHARE_LINK_ID_INVALID');
    assertOwnerVerified(await client.status());
    const result = readResult(await client.read(GROK_CONVERSATION_OPERATION_IDS.sharingLinkRead, { shareLinkId: id }, {
      sourceDiscoveryPermit: GROK_CONVERSATION_SOURCE_DISCOVERY_PERMITS.sharingLinkRead,
    }), 'CONVERSATION_SHARE_LINK_READ_FAILED');
    return result;
  }

  async function readOwnedConversation(id) {
    const result = await readConversation(id);
    const conversation = conversationRecord(result.data);
    if (conversation.viewerIsOwner !== true || conversation.isReadonly === true
      || conversation.accessLevel && conversation.accessLevel !== 'OWNER') {
      throw fail('CONVERSATION_OWNER_ACCESS_REQUIRED');
    }
    return { result, conversation };
  }

  async function list(input = {}) {
    validateListInput(input);
    const result = readResult(await client.read(GROK_CONVERSATION_OPERATION_IDS.list, input), 'CONVERSATION_LIST_READ_FAILED');
    if (!Array.isArray(result.data.conversations)) throw fail('CONVERSATION_LIST_RESPONSE_INVALID');
    return result;
  }

  return Object.freeze({
    list,

    async search(query, options = {}) {
      validateText(query, 'CONVERSATION_SEARCH_QUERY_INVALID', { max: 512 });
      const input = validateListInput({ ...options, searchQuery: query });
      return list(input);
    },

    async read(conversationId) { return readConversation(conversationId); },

    async responseNodes(conversationId, { includeThreads } = {}) {
      const id = validateId(conversationId, 'CONVERSATION_ID_INVALID');
      if (includeThreads !== undefined && typeof includeThreads !== 'boolean') throw fail('HISTORY_INCLUDE_THREADS_INVALID');
      const result = readResult(await client.read(GROK_CONVERSATION_OPERATION_IDS.responseNodes, {
        conversationId: id,
        ...(includeThreads === undefined ? {} : { includeThreads }),
      }), 'HISTORY_RESPONSE_NODES_READ_FAILED');
      if (!Array.isArray(result.data.responseNodes) || !Array.isArray(result.data.inflightResponses)) {
        throw fail('HISTORY_RESPONSE_NODES_RESPONSE_INVALID');
      }
      return result;
    },

    async loadResponses(conversationId, responseIds) {
      const id = validateId(conversationId, 'CONVERSATION_ID_INVALID');
      const ids = validateResponseIds(responseIds);
      const result = readResult(await client.read(GROK_CONVERSATION_OPERATION_IDS.loadResponses, {
        conversationId: id,
        responseIds: ids,
      }), 'HISTORY_LOAD_RESPONSES_READ_FAILED');
      if (!Array.isArray(result.data.responses)) throw fail('HISTORY_LOAD_RESPONSES_RESPONSE_INVALID');
      return result;
    },

    async taskResponses(conversationId) {
      const id = validateId(conversationId, 'CONVERSATION_ID_INVALID');
      const result = readResult(await client.read(GROK_CONVERSATION_OPERATION_IDS.taskResponses, { conversationId: id }),
        'HISTORY_TASK_RESPONSES_READ_FAILED');
      if (!Array.isArray(result.data.taskIdWithResponseIds)) throw fail('HISTORY_TASK_RESPONSES_RESPONSE_INVALID');
      return result;
    },

    async sharing(conversationId, responseId) { return readSharing(conversationId, responseId); },

    async shareLink(shareLinkId) { return readShareLink(shareLinkId); },

    async settings() { return readSettings(); },

    async updateSettingsPreference(name, value, options) {
      if (name !== SAFE_SETTINGS_PREFERENCE || typeof value !== 'boolean') throw fail('SETTINGS_PREFERENCE_NOT_SUPPORTED');
      validateSafeIntent(options, 'SETTINGS_UPDATE');
      const sourceDiscoveryPermit = options.sourceDiscoveryPermit ?? null;
      if (sourceDiscoveryPermit !== null
        && sourceDiscoveryPermit !== GROK_CONVERSATION_SOURCE_DISCOVERY_PERMITS.settingsUpdate) {
        throw fail('SETTINGS_SOURCE_DISCOVERY_PERMIT_INVALID');
      }
      assertOwnerVerified(await client.status());
      const before = await readSettings();
      const beforeSettings = before.data;
      const beforePreferences = beforeSettings.preferences;
      if (!plainObject(beforePreferences) || typeof beforePreferences[name] !== 'boolean') {
        throw fail('SETTINGS_PREFERENCE_CURRENT_VALUE_UNAVAILABLE');
      }
      if (Object.values(beforePreferences).some(preference => typeof preference !== 'boolean')) {
        throw fail('SETTINGS_PREFERENCE_MAP_UNSUPPORTED');
      }
      const beforeValue = beforePreferences[name];
      if (beforeValue === value) throw fail('SETTINGS_PREFERENCE_ALREADY_SET');
      const submitted = await client.submit(GROK_CONVERSATION_OPERATION_IDS.settingsUpdate, {
        body: { preferences: { ...beforePreferences, [name]: value } },
      }, { ...options, sourceDiscoveryPermit });
      if (typeof submitted?.localOperationId !== 'string') throw fail('CONVERSATION_SUBMIT_RECEIPT_INVALID');
      let after;
      try { after = await readSettings(); } catch {
        await holdForReview(journal, submitted.localOperationId, {
          httpStatus: submitted.httpStatus, reasonCode: 'SETTINGS_UPDATE_READBACK_FAILED',
        });
        throw fail('SETTINGS_UPDATE_READBACK_FAILED');
      }
      const afterPreferences = after.data.preferences;
      const changedPreferenceMatched = plainObject(afterPreferences) && afterPreferences[name] === value;
      const otherPreferencesUnchanged = plainObject(afterPreferences)
        && Object.keys(beforePreferences).filter(key => key !== name)
          .every(key => JSON.stringify(beforePreferences[key]) === JSON.stringify(afterPreferences[key]))
        && Object.keys(afterPreferences).filter(key => key !== name).length
          === Object.keys(beforePreferences).filter(key => key !== name).length;
      const otherSettingsUnchanged = Object.keys(beforeSettings).filter(key => key !== 'preferences')
        .every(key => JSON.stringify(beforeSettings[key]) === JSON.stringify(after.data[key]))
        && Object.keys(after.data).filter(key => key !== 'preferences').length
          === Object.keys(beforeSettings).filter(key => key !== 'preferences').length;
      if (!changedPreferenceMatched || !otherPreferencesUnchanged || !otherSettingsUnchanged) {
        await holdForReview(journal, submitted.localOperationId, {
          httpStatus: after.status, reasonCode: 'SETTINGS_UPDATE_READBACK_MISMATCH',
        });
        return { ...submitted, state: 'needs_review', verified: false, readbackStatus: after.status,
          preferenceName: name, beforeValue, afterValue: afterPreferences?.[name] ?? null,
          otherPreferencesUnchanged, otherSettingsUnchanged };
      }
      await markVerified(journal, submitted.localOperationId, {
        httpStatus: after.status, operationId: GROK_CONVERSATION_OPERATION_IDS.settingsRead,
      });
      return { ...submitted, state: 'completed', verified: true, httpStatus: submitted.httpStatus,
        readbackStatus: after.status, preferenceName: name, beforeValue, afterValue: value,
        otherPreferencesUnchanged: true, otherSettingsUnchanged: true };
    },

    async imagineModelOverrides(body) {
      validateBoundedJsonObject(body, 'PRIVATE_MODEL_OVERRIDES_INPUT_INVALID', 64 * 1024);
      const result = readResult(await client.read(GROK_CONVERSATION_OPERATION_IDS.imagineModelOverrides, { body }), 'PRIVATE_MODEL_OVERRIDES_READ_FAILED');
      if (!Array.isArray(result.data.modelMapOverrides)) throw fail('PRIVATE_MODEL_OVERRIDES_RESPONSE_INVALID');
      return result;
    },

    async modes(locale = 'en') {
      validateText(locale, 'MODEL_MODE_LOCALE_INVALID', { max: 32 });
      const result = readResult(await client.read(GROK_CONVERSATION_OPERATION_IDS.modes, { locale }), 'MODEL_MODES_READ_FAILED');
      if (!Array.isArray(result.data.modes)) throw fail('MODEL_MODES_RESPONSE_INVALID');
      return result;
    },

    async uploadStatus(uploadId) {
      const id = validateId(uploadId, 'UPLOAD_ID_INVALID');
      return readResult(await client.read(GROK_CONVERSATION_OPERATION_IDS.uploadStatus, { uploadId: id }), 'UPLOAD_STATUS_READ_FAILED');
    },

    async create(body, options) {
      validateCreateBody(body);
      validateSafeIntent(options, 'CONVERSATION_CREATE');
      const sourceDiscoveryPermit = options.sourceDiscoveryPermit ?? null;
      if (sourceDiscoveryPermit !== null && sourceDiscoveryPermit !== GROK_CONVERSATION_SOURCE_DISCOVERY_PERMITS.create) {
        throw fail('CONVERSATION_SOURCE_DISCOVERY_PERMIT_INVALID');
      }
      assertOwnerVerified(await client.status());
      const submitted = await client.submit(GROK_CONVERSATION_OPERATION_IDS.create, { body }, {
        ...options,
        sourceDiscoveryPermit,
      });
      if (typeof submitted?.localOperationId !== 'string') throw fail('CONVERSATION_SUBMIT_RECEIPT_INVALID');
      const conversationId = await client.getInMemoryServiceJobId?.(submitted.localOperationId);
      if (typeof conversationId !== 'string') {
        await holdForReview(journal, submitted.localOperationId, { httpStatus: submitted.httpStatus, reasonCode: 'CONVERSATION_ID_NOT_OBSERVED' });
        return { ...submitted, state: 'needs_review', verified: false, readbackStatus: null };
      }
      validateId(conversationId, 'CONVERSATION_ID_INVALID');
      let readback;
      try { readback = await readOwnedConversation(conversationId); } catch {
        await holdForReview(journal, submitted.localOperationId, { httpStatus: submitted.httpStatus, reasonCode: 'CONVERSATION_CREATE_READBACK_FAILED' });
        return { ...submitted, state: 'needs_review', verified: false, readbackStatus: null };
      }
      await markVerified(journal, submitted.localOperationId, { httpStatus: readback.result.status, operationId: GROK_CONVERSATION_OPERATION_IDS.read });
      return { ...submitted, state: 'completed', verified: true, readbackStatus: readback.result.status, conversationId };
    },

    async update(conversationId, patch, options) {
      const id = validateId(conversationId, 'CONVERSATION_ID_INVALID');
      const body = validateUpdateBody(patch);
      validateSafeIntent(options, 'CONVERSATION_UPDATE');
      const sourceDiscoveryPermit = options.sourceDiscoveryPermit ?? null;
      if (sourceDiscoveryPermit !== null
        && (sourceDiscoveryPermit !== GROK_CONVERSATION_SOURCE_DISCOVERY_PERMITS.titleUpdate
          || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'title'))) {
        throw fail('CONVERSATION_SOURCE_DISCOVERY_PERMIT_INVALID');
      }
      assertOwnerVerified(await client.status());
      await readOwnedConversation(id);
      const submitted = await client.submit(GROK_CONVERSATION_OPERATION_IDS.update, { conversationId: id, body }, {
        ...options,
        sourceDiscoveryPermit,
      });
      if (typeof submitted?.localOperationId !== 'string') throw fail('CONVERSATION_SUBMIT_RECEIPT_INVALID');
      let result;
      try { result = (await readOwnedConversation(id)).result; } catch {
        await holdForReview(journal, submitted.localOperationId, { httpStatus: submitted.httpStatus, reasonCode: 'CONVERSATION_UPDATE_READBACK_FAILED' });
        throw fail('CONVERSATION_UPDATE_READBACK_FAILED');
      }
      const after = conversationRecord(result.data);
      const matches = Object.entries(body).every(([key, value]) => JSON.stringify(after[key]) === JSON.stringify(value));
      if (!matches) {
        await holdForReview(journal, submitted.localOperationId, { httpStatus: result.status, reasonCode: 'CONVERSATION_UPDATE_READBACK_MISMATCH' });
        return { ...submitted, state: 'needs_review', verified: false, readbackStatus: result.status };
      }
      await markVerified(journal, submitted.localOperationId, { httpStatus: result.status, operationId: GROK_CONVERSATION_OPERATION_IDS.read });
      return { ...submitted, state: 'completed', verified: true, readbackStatus: result.status };
    },

    async regenerate(conversationId, responseId, options) {
      const id = validateId(conversationId, 'CONVERSATION_ID_INVALID');
      const targetResponseId = validateId(responseId, 'HISTORY_RESPONSE_ID_INVALID');
      validateSafeIntent(options, 'CONVERSATION_REGENERATE');
      const sourceDiscoveryPermit = options.sourceDiscoveryPermit ?? null;
      if (sourceDiscoveryPermit !== null
        && sourceDiscoveryPermit !== GROK_CONVERSATION_SOURCE_DISCOVERY_PERMITS.regenerateResponse) {
        throw fail('CONVERSATION_SOURCE_DISCOVERY_PERMIT_INVALID');
      }
      const proof = validateRegenerateProof(options.targetProof, sourceDiscoveryPermit !== null);
      assertOwnerVerified(await client.status());
      await readOwnedConversation(id);

      const beforeNodes = readResult(await client.read(GROK_CONVERSATION_OPERATION_IDS.responseNodes, { conversationId: id }),
        'HISTORY_RESPONSE_NODES_READ_FAILED');
      if (!Array.isArray(beforeNodes.data.responseNodes) || !Array.isArray(beforeNodes.data.inflightResponses)) {
        throw fail('HISTORY_RESPONSE_NODES_RESPONSE_INVALID');
      }
      const beforeRows = beforeNodes.data.responseNodes;
      const targetNode = beforeRows.find(item => item?.responseId === targetResponseId);
      if (!targetNode || senderKind(targetNode.sender) !== 'assistant'
        || typeof targetNode.parentResponseId !== 'string') throw fail('CONVERSATION_REGENERATE_TARGET_INVALID');
      const beforeIds = validateResponseIds(beforeRows.map(item => item?.responseId));
      const beforeLoaded = readResult(await client.read(GROK_CONVERSATION_OPERATION_IDS.loadResponses, {
        conversationId: id,
        responseIds: beforeIds,
      }), 'HISTORY_LOAD_RESPONSES_READ_FAILED');
      if (!Array.isArray(beforeLoaded.data.responses)) throw fail('HISTORY_LOAD_RESPONSES_RESPONSE_INVALID');
      const loadedById = new Map(beforeLoaded.data.responses.map(item => [item.responseId, item]));
      const target = loadedById.get(targetResponseId);
      const parentResponseId = validateId(target?.parentResponseId, 'CONVERSATION_REGENERATE_PARENT_INVALID');
      if (parentResponseId !== targetNode.parentResponseId) throw fail('CONVERSATION_REGENERATE_TARGET_INVALID');
      const parent = loadedById.get(parentResponseId);
      const parentMessageCandidates = [
        ...(typeof parent?.message === 'string' ? [['message', parent.message]] : []),
        ...(typeof parent?.query === 'string' ? [['query', parent.query]] : []),
      ];
      const matchedParentCandidate = proof
        ? parentMessageCandidates.find(([, value]) => messageHash(value) === proof.expectedParentMessageSha256)
        : null;
      const parentMessageField = matchedParentCandidate?.[0] ?? parentMessageCandidates[0]?.[0];
      const parentMessage = matchedParentCandidate?.[1] ?? parentMessageCandidates[0]?.[1] ?? null;
      if (senderKind(parent?.sender) !== 'user' || typeof parentMessage !== 'string') {
        throw fail('CONVERSATION_REGENERATE_PARENT_INVALID');
      }
      const targetMessage = typeof target?.message === 'string' ? target.message : '';
      const expectedPattern = proof ? new RegExp(proof.expectedAssistantPattern) : null;
      const exactParentMatched = proof ? Boolean(matchedParentCandidate) : null;
      const targetPatternMatched = expectedPattern ? expectedPattern.test(targetMessage.trim()) : null;
      if (proof && (!exactParentMatched || !targetPatternMatched)) throw fail('CONVERSATION_REGENERATE_TARGET_PROOF_MISMATCH');
      if (Array.isArray(target?.fileAttachments) && target.fileAttachments.length) {
        throw fail('CONVERSATION_REGENERATE_FILES_UNSUPPORTED');
      }

      const modelName = typeof target?.model === 'string' && target.model.trim()
        ? target.model
        : typeof target?.metadata?.request_metadata?.model === 'string' && target.metadata.request_metadata.model.trim()
          ? target.metadata.request_metadata.model : undefined;
      const body = {
        message: '',
        parentResponseId,
        isRegenRequest: true,
        skipCancelCurrentInflightRequests: true,
        ...(modelName ? { modelName } : {}),
      };
      const submitted = await client.submit(GROK_CONVERSATION_OPERATION_IDS.regenerate, {
        conversationId: id,
        body,
      }, {
        ...options,
        sourceDiscoveryPermit,
      });
      if (typeof submitted?.localOperationId !== 'string') throw fail('CONVERSATION_SUBMIT_RECEIPT_INVALID');

      let afterNodes = null;
      let newNode = null;
      const beforeSet = new Set(beforeIds);
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          afterNodes = readResult(await client.read(GROK_CONVERSATION_OPERATION_IDS.responseNodes, { conversationId: id }),
            'HISTORY_RESPONSE_NODES_READ_FAILED');
          if (!Array.isArray(afterNodes.data.responseNodes) || !Array.isArray(afterNodes.data.inflightResponses)) {
            throw fail('HISTORY_RESPONSE_NODES_RESPONSE_INVALID');
          }
        }
        catch {
          afterNodes = null;
          break;
        }
        const added = afterNodes.data.responseNodes.filter(item => !beforeSet.has(item?.responseId));
        if (added.length > 1) break;
        if (added.length === 1 && afterNodes.data.inflightResponses.length === 0) {
          newNode = added[0];
          break;
        }
        if (attempt < 19) await new Promise(resolve => setTimeout(resolve, 1_000));
      }
      if (!afterNodes || !newNode || senderKind(newNode.sender) !== 'assistant'
        || newNode.parentResponseId !== parentResponseId) {
        await holdForReview(journal, submitted.localOperationId, {
          httpStatus: afterNodes?.status ?? submitted.httpStatus,
          reasonCode: 'CONVERSATION_REGENERATE_READBACK_PENDING',
        });
        return { ...submitted, state: 'needs_review', verified: false,
          readbackStatus: afterNodes?.status ?? null, exactParentMatched: exactParentMatched === true,
          targetPatternMatched: targetPatternMatched === true };
      }

      let afterLoaded;
      try {
        afterLoaded = readResult(await client.read(GROK_CONVERSATION_OPERATION_IDS.loadResponses, {
          conversationId: id,
          responseIds: [targetResponseId, parentResponseId, newNode.responseId],
        }), 'HISTORY_LOAD_RESPONSES_READ_FAILED');
        if (!Array.isArray(afterLoaded.data.responses)) throw fail('HISTORY_LOAD_RESPONSES_RESPONSE_INVALID');
      }
      catch {
        await holdForReview(journal, submitted.localOperationId, {
          httpStatus: submitted.httpStatus,
          reasonCode: 'CONVERSATION_REGENERATE_READBACK_FAILED',
        });
        return { ...submitted, state: 'needs_review', verified: false, readbackStatus: null,
          exactParentMatched: exactParentMatched === true, targetPatternMatched: targetPatternMatched === true };
      }
      const afterById = new Map(afterLoaded.data.responses.map(item => [item.responseId, item]));
      const afterParent = afterById.get(parentResponseId);
      const afterTarget = afterById.get(targetResponseId);
      const regenerated = afterById.get(newNode.responseId);
      const parentUnchanged = typeof parentMessageField === 'string' && afterParent?.[parentMessageField] === parentMessage;
      const targetUnchanged = typeof afterTarget?.message === 'string' && afterTarget.message === targetMessage;
      const regeneratedPatternMatched = proof && typeof regenerated?.message === 'string'
        ? expectedPattern.test(regenerated.message.trim()) : null;
      const verified = senderKind(regenerated?.sender) === 'assistant' && parentUnchanged && targetUnchanged
        && (!proof || regeneratedPatternMatched === true);
      if (!verified) {
        await holdForReview(journal, submitted.localOperationId, {
          httpStatus: afterLoaded.status,
          reasonCode: 'CONVERSATION_REGENERATE_READBACK_MISMATCH',
        });
        return { ...submitted, state: 'needs_review', verified: false, readbackStatus: afterLoaded.status,
          exactParentMatched: exactParentMatched === true, targetPatternMatched: targetPatternMatched === true,
          regeneratedPatternMatched: regeneratedPatternMatched === true };
      }
      await markVerified(journal, submitted.localOperationId, {
        httpStatus: afterLoaded.status,
        operationId: GROK_CONVERSATION_OPERATION_IDS.loadResponses,
      });
      return { ...submitted, state: 'completed', verified: true, readbackStatus: afterLoaded.status,
        addedAssistantResponseCount: 1, exactParentMatched: exactParentMatched === true,
        targetPatternMatched: targetPatternMatched === true, regeneratedPatternMatched: regeneratedPatternMatched === true };
    },

    async delete(conversationId, options) {
      const id = validateId(conversationId, 'CONVERSATION_ID_INVALID');
      validateSafeIntent(options, 'CONVERSATION_DELETE');
      const sourceDiscoveryPermit = options.sourceDiscoveryPermit ?? null;
      if (sourceDiscoveryPermit !== null
        && sourceDiscoveryPermit !== GROK_CONVERSATION_SOURCE_DISCOVERY_PERMITS.delete) {
        throw fail('CONVERSATION_SOURCE_DISCOVERY_PERMIT_INVALID');
      }
      assertOwnerVerified(await client.status());
      await readOwnedConversation(id);
      const submitted = await client.submit(GROK_CONVERSATION_OPERATION_IDS.delete, { conversationId: id }, {
        ...options, sourceDiscoveryPermit,
      });
      if (typeof submitted?.localOperationId !== 'string') throw fail('CONVERSATION_SUBMIT_RECEIPT_INVALID');
      let snapshot;
      try { snapshot = await allConversationIds((operationId, input) => client.read(operationId, input)); } catch {
        await holdForReview(journal, submitted.localOperationId, { httpStatus: submitted.httpStatus, reasonCode: 'CONVERSATION_DELETE_READBACK_FAILED' });
        return { ...submitted, state: 'needs_review', verified: false, readbackStatus: null };
      }
      if (!snapshot.complete || snapshot.ids.has(id)) {
        await holdForReview(journal, submitted.localOperationId, { httpStatus: snapshot.status, reasonCode: 'CONVERSATION_DELETE_READBACK_INCOMPLETE' });
        return { ...submitted, state: 'needs_review', verified: false, readbackStatus: snapshot.status };
      }
      await markVerified(journal, submitted.localOperationId, { httpStatus: snapshot.status, operationId: GROK_CONVERSATION_OPERATION_IDS.list });
      return { ...submitted, state: 'completed', verified: true, conversationAbsent: true, readbackStatus: snapshot.status };
    },

    async setSharing(conversationId, body, options) {
      const id = validateId(conversationId, 'CONVERSATION_ID_INVALID');
      validateSharingBody(body);
      validateSafeIntent(options, 'CONVERSATION_SHARING');
      assertOwnerVerified(await client.status());
      await readOwnedConversation(id);
      const before = await readSharing(id, body.responseId);
      const beforeSharing = before.data.sharing;
      if (plainObject(beforeSharing) && (beforeSharing.shareLinkId || beforeSharing.publicId
        || beforeSharing.users?.length || beforeSharing.teams?.length)) {
        throw fail('CONVERSATION_SHARING_EXISTING_LINK_REQUIRES_REVOKE');
      }
      const sourceDiscoveryPermit = options.sourceDiscoveryPermit ?? null;
      if (sourceDiscoveryPermit !== null
        && sourceDiscoveryPermit !== GROK_CONVERSATION_SOURCE_DISCOVERY_PERMITS.sharingSet) {
        throw fail('CONVERSATION_SOURCE_DISCOVERY_PERMIT_INVALID');
      }
      const submitted = await client.submit(GROK_CONVERSATION_OPERATION_IDS.sharingSet, { conversationId: id, body }, {
        ...options, sourceDiscoveryPermit, retainResponseInMemory: true,
      });
      if (typeof submitted?.localOperationId !== 'string') throw fail('CONVERSATION_SUBMIT_RECEIPT_INVALID');
      const issued = typeof client.getInMemoryPrivateResponse === 'function'
        ? await client.getInMemoryPrivateResponse(submitted.localOperationId) : null;
      const shareLinkId = typeof issued?.shareLinkId === 'string' ? issued.shareLinkId : null;
      if (typeof client.clearInMemoryPrivateResponse === 'function') {
        await client.clearInMemoryPrivateResponse(submitted.localOperationId);
      }
      if (!shareLinkId || shareLinkId.length < 16 || shareLinkId.length > 512 || /[\r\n\0]/.test(shareLinkId)) {
        await holdForReview(journal, submitted.localOperationId, { httpStatus: submitted.httpStatus,
          reasonCode: 'CONVERSATION_SHARE_ISSUED_LINK_ID_MISSING' });
        return { ...submitted, state: 'needs_review', verified: false, readbackStatus: null };
      }
      let after;
      try { after = await readSharing(id, body.responseId); } catch {
        await holdForReview(journal, submitted.localOperationId, { httpStatus: submitted.httpStatus, reasonCode: 'CONVERSATION_SHARING_READBACK_FAILED' });
        return { ...submitted, state: 'needs_review', verified: false, readbackStatus: null, shareLinkId };
      }
      const sharing = after.data.sharing;
      if (!plainObject(sharing)) {
        await holdForReview(journal, submitted.localOperationId, { httpStatus: after.status, reasonCode: 'CONVERSATION_SHARING_READBACK_INCOMPLETE' });
        return { ...submitted, state: 'needs_review', verified: false, readbackStatus: after.status, shareLinkId };
      }
      if (typeof sharing.shareLinkId !== 'string' || !sharing.shareLinkId) {
        await holdForReview(journal, submitted.localOperationId, { httpStatus: after.status, reasonCode: 'CONVERSATION_SHARE_LINK_ID_READBACK_MISSING' });
        return { ...submitted, state: 'needs_review', verified: false, readbackStatus: after.status,
          shareLinkId, allowIndexing: body.allowIndexing };
      }
      let linkRead;
      try { linkRead = await readShareLink(shareLinkId); } catch {
        await holdForReview(journal, submitted.localOperationId, { httpStatus: after.status, reasonCode: 'CONVERSATION_SHARE_LINK_READBACK_FAILED' });
        return { ...submitted, state: 'needs_review', verified: false, readbackStatus: after.status,
          shareLinkId, allowIndexing: body.allowIndexing };
      }
      const link = linkRead.data;
      const linkedConversationId = link?.conversation?.conversationId;
      const sameConversation = linkedConversationId === id;
      const sameResponse = shareLinkContainsResponse(link, body.responseId);
      const issuedLinkMatchedScopedState = sharing.shareLinkId === shareLinkId
        || sharing.publicId === shareLinkId
        || (typeof link?.canonicalShareLinkId === 'string' && link.canonicalShareLinkId === sharing.publicId);
      const publicLink = link?.isPublic === true;
      const indexingMatches = link?.allowIndexing === body.allowIndexing;
      if (!sameConversation || !sameResponse || !publicLink || !indexingMatches || !issuedLinkMatchedScopedState) {
        await holdForReview(journal, submitted.localOperationId, { httpStatus: linkRead.status,
          reasonCode: !issuedLinkMatchedScopedState ? 'CONVERSATION_SHARE_ISSUED_LINK_STATE_MISMATCH'
            : !sameConversation || !sameResponse ? 'CONVERSATION_SHARE_LINK_CONTENT_READBACK_MISMATCH' : 'CONVERSATION_SHARE_LINK_READBACK_MISMATCH' });
        return { ...submitted, state: 'needs_review', verified: false, readbackStatus: linkRead.status,
          shareLinkId, sameConversationId: sameConversation, sameResponseId: sameResponse,
          isPublic: publicLink, issuedLinkMatchedScopedState, allowIndexing: link?.allowIndexing ?? null };
      }
      await markVerified(journal, submitted.localOperationId, { httpStatus: after.status, operationId: GROK_CONVERSATION_OPERATION_IDS.sharingRead });
      return { ...submitted, state: 'completed', verified: true, readbackStatus: after.status,
        shareLinkId, shareRecordId: sharing.shareLinkId, publicId: sharing.publicId ?? null,
        isPublic: true, allowIndexing: body.allowIndexing,
        sameConversationId: true, sameResponseId: true, issuedLinkMatchedScopedState: true,
        shareLinkReadbackStatus: linkRead.status };
    },

    async revokeSharingLink(conversationId, responseId, shareLinkId, options) {
      const id = validateId(conversationId, 'CONVERSATION_ID_INVALID');
      const response = validateId(responseId, 'CONVERSATION_SHARING_RESPONSE_ID_INVALID');
      const linkId = validateId(shareLinkId, 'CONVERSATION_SHARE_LINK_ID_INVALID');
      validateSafeIntent(options, 'CONVERSATION_SHARING_REVOKE');
      assertOwnerVerified(await client.status());
      await readOwnedConversation(id);
      const before = await readSharing(id, response);
      const beforeSharing = before.data.sharing;
      if (!plainObject(beforeSharing) || typeof beforeSharing.shareLinkId !== 'string') {
        throw fail('CONVERSATION_SHARE_LINK_TARGET_MISMATCH');
      }
      let currentLink = null;
      const publicLookupId = beforeSharing.shareLinkId === linkId && typeof beforeSharing.publicId === 'string' && beforeSharing.publicId
        ? beforeSharing.publicId : linkId;
      try { currentLink = await readShareLink(publicLookupId); } catch { /* The owner read still binds the target. */ }
      const linkConversationId = currentLink?.data?.conversation?.conversationId;
      const linkResponseMatched = currentLink && shareLinkContainsResponse(currentLink.data, response);
      const sameScopedLink = beforeSharing.shareLinkId === linkId
        || beforeSharing.publicId === linkId
        || currentLink?.data?.canonicalShareLinkId === beforeSharing.publicId;
      if (!currentLink || !sameScopedLink || currentLink.data?.isPublic !== true || linkConversationId !== id || !linkResponseMatched) {
        throw fail('CONVERSATION_SHARE_LINK_TARGET_MISMATCH');
      }
      const sourceDiscoveryPermit = options.sourceDiscoveryPermit ?? null;
      if (sourceDiscoveryPermit !== null
        && sourceDiscoveryPermit !== GROK_CONVERSATION_SOURCE_DISCOVERY_PERMITS.sharingRevoke) {
        throw fail('CONVERSATION_SOURCE_DISCOVERY_PERMIT_INVALID');
      }
      const submitted = await client.submit(GROK_CONVERSATION_OPERATION_IDS.sharingRevoke, {
        // The share dialog uses publicId in URLs, and the owner record ID for DELETE.
        shareLinkId: beforeSharing.shareLinkId,
      }, { ...options, sourceDiscoveryPermit });
      if (typeof submitted?.localOperationId !== 'string') throw fail('CONVERSATION_SUBMIT_RECEIPT_INVALID');
      let after;
      try { after = await readSharing(id, response); } catch {
        await holdForReview(journal, submitted.localOperationId, { httpStatus: submitted.httpStatus, reasonCode: 'CONVERSATION_SHARE_REVOKE_READBACK_FAILED' });
        throw fail('CONVERSATION_SHARE_REVOKE_READBACK_FAILED');
      }
      const afterSharing = after.data.sharing;
      const linkAbsent = !plainObject(afterSharing) || (afterSharing.shareLinkId !== beforeSharing.shareLinkId
        && (afterSharing.publicId === undefined || afterSharing.publicId === null));
      if (!linkAbsent) {
        await holdForReview(journal, submitted.localOperationId, { httpStatus: after.status, reasonCode: 'CONVERSATION_SHARE_REVOKE_READBACK_MISMATCH' });
        return { ...submitted, state: 'needs_review', verified: false, readbackStatus: after.status, shareLinkAbsent: false };
      }
      await markVerified(journal, submitted.localOperationId, { httpStatus: after.status, operationId: GROK_CONVERSATION_OPERATION_IDS.sharingRead });
      return { ...submitted, state: 'completed', verified: true, readbackStatus: after.status, shareLinkAbsent: true,
        sameConversationId: true, sameResponseId: true, isPublic: true };
    },

  });
}
