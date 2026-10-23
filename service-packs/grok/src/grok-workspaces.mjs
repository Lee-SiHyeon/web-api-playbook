import { fail } from './errors.mjs';

export const GROK_WORKSPACE_OPERATION_IDS = Object.freeze({
  list: 'workspaces.list',
  sharedList: 'workspaces.shared.list',
  read: 'workspaces.read',
  create: 'workspaces.create',
  update: 'workspaces.update',
  delete: 'workspaces.delete',
});

export const GROK_WORKSPACE_KINDS = Object.freeze([
  'WORKSPACE_KIND_IMAGINE',
  'WORKSPACE_KIND_ALL',
  'WORKSPACE_KIND_IMAGINE_ALL',
  'WORKSPACE_KIND_UNIFIED',
]);

const ORDER_BY = new Set([
  'ORDER_BY_INVALID',
  'ORDER_BY_RELEVANCY',
  'ORDER_BY_CREATE_TIME',
  'ORDER_BY_LAST_USE_TIME',
  'ORDER_BY_NAME',
]);
const MAX_PAGE_COUNT = 20;

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertClient(client, journal) {
  if (!client || typeof client.read !== 'function' || typeof client.submit !== 'function'
    || typeof client.status !== 'function' || typeof journal?.get !== 'function'
    || typeof journal?.transition !== 'function') throw fail('WORKSPACE_RUNTIME_REQUIRED');
}

function validateWorkspaceId(value) {
  if (typeof value !== 'string' || value.length < 16 || value.length > 128
    || !/^[A-Za-z0-9_-]+$/.test(value)) throw fail('WORKSPACE_ID_INVALID');
  return value;
}

function validateString(value, code, { max = 4_000, allowEmpty = false } = {}) {
  if (typeof value !== 'string' || value.length > max || /[\r\n\0]/.test(value)
    || (!allowEmpty && !value.trim())) throw fail(code);
  return value;
}

function validateQueryInput(input, { shared = false } = {}) {
  if (!plainObject(input)) throw fail('WORKSPACE_INPUT_INVALID');
  const allowed = shared ? ['pageSize', 'pageToken', 'orderBy']
    : ['query', 'pageSize', 'pageToken', 'orderBy', 'kind'];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw fail('WORKSPACE_INPUT_UNKNOWN_FIELD');
  if (input.pageSize !== undefined && (!Number.isInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 1_000)) {
    throw fail('WORKSPACE_PAGE_SIZE_INVALID');
  }
  if (input.pageToken !== undefined) validateString(input.pageToken, 'WORKSPACE_PAGE_TOKEN_INVALID', { max: 8_192 });
  if (input.orderBy !== undefined && !ORDER_BY.has(input.orderBy)) throw fail('WORKSPACE_ORDER_BY_INVALID');
  if (input.query !== undefined) validateString(input.query, 'WORKSPACE_QUERY_INVALID', { max: 256, allowEmpty: true });
  if (input.kind !== undefined && !GROK_WORKSPACE_KINDS.includes(input.kind)) throw fail('WORKSPACE_KIND_INVALID');
  return input;
}

function validateWorkspaceBody(value, { create = false } = {}) {
  if (!plainObject(value)) throw fail('WORKSPACE_BODY_INVALID');
  const allowed = create ? ['name', 'kind'] : ['name'];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw fail('WORKSPACE_BODY_UNKNOWN_FIELD');
  const body = {};
  if (create || Object.hasOwn(value, 'name')) body.name = validateString(value.name, 'WORKSPACE_NAME_INVALID', { max: 120 });
  if (value.kind !== undefined) {
    if (!create || !GROK_WORKSPACE_KINDS.includes(value.kind)) throw fail('WORKSPACE_KIND_INVALID');
    body.kind = value.kind;
  }
  if (create && !Object.hasOwn(body, 'name')) throw fail('WORKSPACE_NAME_INVALID');
  if (create && !Object.hasOwn(body, 'kind')) throw fail('WORKSPACE_KIND_INVALID');
  if (!Object.keys(body).length) throw fail('WORKSPACE_UPDATE_EMPTY');
  return body;
}

function validateIntentOptions(options) {
  if (!plainObject(options) || options.confirm !== true) throw fail('WORKSPACE_WRITE_CONFIRM_REQUIRED');
  validateString(options.intentId, 'WORKSPACE_INTENT_ID_REQUIRED', { max: 256 });
  return options;
}

function responseData(result, code) {
  if (!result || !Number.isInteger(result.status) || result.status < 200 || result.status >= 300
    || !plainObject(result.data)) throw fail(code);
  return result.data;
}

function workspaceRecord(data) {
  if (plainObject(data.workspace)) return data.workspace;
  return data;
}

async function markVerified(journal, localOperationId, { httpStatus, operationId }) {
  const entry = await journal.get(localOperationId);
  if (!entry || !['accepted', 'needs_review'].includes(entry.state)) throw fail('WORKSPACE_JOURNAL_READBACK_STATE_INVALID');
  await journal.transition(localOperationId, 'completed', {
    httpStatus,
    reasonCode: 'WORKSPACE_READBACK_VERIFIED',
    reconciledBy: operationId,
  });
}

async function holdForReview(journal, localOperationId, { httpStatus, reasonCode }) {
  const entry = await journal.get(localOperationId);
  if (!entry || !['accepted', 'processing'].includes(entry.state)) return;
  await journal.transition(localOperationId, 'needs_review', { httpStatus, reasonCode });
}

async function allWorkspaces(read, pageSize = 1000) {
  const workspaces = [];
  const workspaceIds = new Set();
  const tokens = new Set();
  let pageToken;
  let complete = false;
  let status = 200;
  for (let page = 0; page < MAX_PAGE_COUNT; page++) {
    const input = { pageSize, ...(pageToken ? { pageToken } : {}) };
    const result = await read(GROK_WORKSPACE_OPERATION_IDS.list, input);
    const data = responseData(result, 'WORKSPACE_LIST_READ_FAILED');
    status = result.status;
    if (!Array.isArray(data.workspaces)) throw fail('WORKSPACE_LIST_RESPONSE_INVALID');
    for (const workspace of data.workspaces) {
      if (!plainObject(workspace) || typeof workspace.workspaceId !== 'string') throw fail('WORKSPACE_LIST_RESPONSE_INVALID');
      workspaces.push(workspace);
      workspaceIds.add(workspace.workspaceId);
    }
    const next = data.nextPageToken;
    if (typeof next !== 'string' || !next) {
      complete = true;
      break;
    }
    validateString(next, 'WORKSPACE_PAGE_TOKEN_INVALID', { max: 8_192 });
    if (tokens.has(next)) throw fail('WORKSPACE_CURSOR_CYCLE');
    tokens.add(next);
    pageToken = next;
  }
  return { workspaces, workspaceIds, complete, status };
}

export function createGrokWorkspaceClient({ client, journal } = {}) {
  assertClient(client, journal);

  async function readOwnedPrivateWorkspace(workspaceId) {
    const result = await client.read(GROK_WORKSPACE_OPERATION_IDS.read, { workspaceId });
    const workspace = workspaceRecord(responseData(result, 'WORKSPACE_READ_FAILED'));
    if (workspace.workspaceId !== workspaceId) throw fail('WORKSPACE_READ_ID_MISMATCH');
    if (workspace.accessLevel !== 'OWNER' || workspace.isReadonly === true) throw fail('WORKSPACE_OWNER_ACCESS_REQUIRED');
    return { result, workspace };
  }

  return Object.freeze({
    async list(input = {}) {
      validateQueryInput(input);
      const result = await client.read(GROK_WORKSPACE_OPERATION_IDS.list, input);
      const data = responseData(result, 'WORKSPACE_LIST_READ_FAILED');
      if (!Array.isArray(data.workspaces)) throw fail('WORKSPACE_LIST_RESPONSE_INVALID');
      return result;
    },

    async listShared(input = {}) {
      validateQueryInput(input, { shared: true });
      const result = await client.read(GROK_WORKSPACE_OPERATION_IDS.sharedList, input);
      const data = responseData(result, 'WORKSPACE_SHARED_LIST_READ_FAILED');
      if (!Array.isArray(data.workspaces)) throw fail('WORKSPACE_SHARED_LIST_RESPONSE_INVALID');
      return result;
    },

    async read(workspaceId) {
      const id = validateWorkspaceId(workspaceId);
      const result = await client.read(GROK_WORKSPACE_OPERATION_IDS.read, { workspaceId: id });
      const data = responseData(result, 'WORKSPACE_READ_FAILED');
      if (typeof workspaceRecord(data).workspaceId !== 'string') throw fail('WORKSPACE_READ_RESPONSE_INVALID');
      return result;
    },

    async create(input, options) {
      const body = validateWorkspaceBody(input, { create: true });
      validateIntentOptions(options);
      const status = await client.status();
      if (status?.session?.ownerVerified !== true) throw fail('OWNER_VERIFICATION_REQUIRED');
      const snapshot = await allWorkspaces((operationId, input) => client.read(operationId, input));
      if (!snapshot.complete) throw fail('WORKSPACE_CREATE_PREFLIGHT_INCOMPLETE');
      if (snapshot.workspaces.some(workspace => workspace.name === body.name)) throw fail('WORKSPACE_NAME_ALREADY_EXISTS');
      const submitted = await client.submit(GROK_WORKSPACE_OPERATION_IDS.create, { body }, options);
      if (typeof submitted?.localOperationId !== 'string') throw fail('WORKSPACE_SUBMIT_RECEIPT_INVALID');
      const workspaceId = await client.getInMemoryServiceJobId?.(submitted.localOperationId);
      if (typeof workspaceId !== 'string') {
        await holdForReview(journal, submitted.localOperationId, { httpStatus: submitted.httpStatus, reasonCode: 'WORKSPACE_ID_NOT_OBSERVED' });
        throw fail('WORKSPACE_ID_NOT_OBSERVED');
      }
      validateWorkspaceId(workspaceId);
      const result = await client.read(GROK_WORKSPACE_OPERATION_IDS.read, { workspaceId });
      const workspace = workspaceRecord(responseData(result, 'WORKSPACE_CREATE_READBACK_FAILED'));
      const matches = workspace.workspaceId === workspaceId && workspace.name === body.name
        && workspace.isPublic === false && workspace.kind === body.kind
        && workspace.accessLevel === 'OWNER' && workspace.isReadonly !== true;
      if (!matches) {
        await holdForReview(journal, submitted.localOperationId, { httpStatus: result.status, reasonCode: 'WORKSPACE_CREATE_READBACK_MISMATCH' });
        return { ...submitted, state: 'needs_review', verified: false, readbackStatus: result.status, workspace };
      }
      await markVerified(journal, submitted.localOperationId, { httpStatus: result.status, operationId: GROK_WORKSPACE_OPERATION_IDS.read });
      return { ...submitted, state: 'completed', verified: true, readbackStatus: result.status, workspace };
    },

    async update(workspaceId, patch, options) {
      const id = validateWorkspaceId(workspaceId);
      const body = validateWorkspaceBody(patch);
      validateIntentOptions(options);
      const status = await client.status();
      if (status?.session?.ownerVerified !== true) throw fail('OWNER_VERIFICATION_REQUIRED');
      const before = await readOwnedPrivateWorkspace(id);
      const submitted = await client.submit(GROK_WORKSPACE_OPERATION_IDS.update, { workspaceId: id, body }, options);
      if (typeof submitted?.localOperationId !== 'string') throw fail('WORKSPACE_SUBMIT_RECEIPT_INVALID');
      const result = await client.read(GROK_WORKSPACE_OPERATION_IDS.read, { workspaceId: id });
      const workspace = workspaceRecord(responseData(result, 'WORKSPACE_UPDATE_READBACK_FAILED'));
      const matches = workspace.workspaceId === id
        && Object.entries(body).every(([key, value]) => JSON.stringify(workspace[key]) === JSON.stringify(value))
        && workspace.isPublic === before.workspace.isPublic && workspace.kind === before.workspace.kind
        && workspace.accessLevel === 'OWNER' && workspace.isReadonly !== true;
      if (!matches) {
        await holdForReview(journal, submitted.localOperationId, { httpStatus: result.status, reasonCode: 'WORKSPACE_UPDATE_READBACK_MISMATCH' });
        return { ...submitted, state: 'needs_review', verified: false, readbackStatus: result.status, workspace };
      }
      await markVerified(journal, submitted.localOperationId, { httpStatus: result.status, operationId: GROK_WORKSPACE_OPERATION_IDS.read });
      return { ...submitted, state: 'completed', verified: true, readbackStatus: result.status, workspace };
    },

    async delete(workspaceId, options) {
      const id = validateWorkspaceId(workspaceId);
      validateIntentOptions(options);
      const status = await client.status();
      if (status?.session?.ownerVerified !== true) throw fail('OWNER_VERIFICATION_REQUIRED');
      await readOwnedPrivateWorkspace(id);
      const submitted = await client.submit(GROK_WORKSPACE_OPERATION_IDS.delete, { workspaceId: id }, options);
      if (typeof submitted?.localOperationId !== 'string') throw fail('WORKSPACE_SUBMIT_RECEIPT_INVALID');
      const snapshot = await allWorkspaces((operationId, input) => client.read(operationId, input));
      if (!snapshot.complete || snapshot.workspaceIds.has(id)) {
        await holdForReview(journal, submitted.localOperationId, { httpStatus: snapshot.status, reasonCode: 'WORKSPACE_DELETE_READBACK_INCOMPLETE' });
        return { ...submitted, state: 'needs_review', verified: false, readbackStatus: snapshot.status };
      }
      await markVerified(journal, submitted.localOperationId, { httpStatus: snapshot.status, operationId: GROK_WORKSPACE_OPERATION_IDS.list });
      return { ...submitted, state: 'completed', verified: true, readbackStatus: snapshot.status };
    },
  });
}
