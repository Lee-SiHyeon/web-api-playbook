import assert from 'node:assert/strict';
import test from 'node:test';
import { createGrokWorkspaceClient, GROK_WORKSPACE_OPERATION_IDS } from '../src/grok-workspaces.mjs';

const createdId = 'workspace_created_0123456789';
const existingId = 'workspace_existing_0123456789';
const intent = suffix => ({ confirm: true, intentId: `workspace-test-${suffix}` });

function fakeRuntime({ ownerVerified = true, initialWorkspaces = [{ workspaceId: existingId, name: 'Existing', isPublic: false, kind: 'WORKSPACE_KIND_UNIFIED', accessLevel: 'OWNER', isReadonly: false }], nextPageToken = '' } = {}) {
  const workspaces = new Map(initialWorkspaces.map(item => [item.workspaceId, { ...item }]));
  const journalEntries = new Map();
  const calls = [];
  let nextOperation = 0;
  let createId = createdId;
  const client = {
    async status() { return { session: { ownerVerified } }; },
    async read(operationId, input = {}) {
      calls.push({ type: 'read', operationId, input: { ...input } });
      if (operationId === GROK_WORKSPACE_OPERATION_IDS.list) {
        return { status: 200, data: { workspaces: [...workspaces.values()].map(item => ({ ...item })), nextPageToken } };
      }
      if (operationId === GROK_WORKSPACE_OPERATION_IDS.read) {
        const workspace = workspaces.get(input.workspaceId);
        return workspace
          ? { status: 200, data: { ...workspace } }
          : { status: 404, data: { error: 'not-found' } };
      }
      throw new Error(`unexpected read ${operationId}`);
    },
    async submit(operationId, input, options) {
      calls.push({ type: 'submit', operationId, input: structuredClone(input), options: { ...options } });
      const localOperationId = `00000000-0000-4000-8000-${String(++nextOperation).padStart(12, '0')}`;
      journalEntries.set(localOperationId, { localOperationId, state: 'accepted' });
      if (operationId === GROK_WORKSPACE_OPERATION_IDS.create) {
        const workspace = { workspaceId: createId, ...input.body, isPublic: false, accessLevel: 'OWNER', isReadonly: false };
        workspaces.set(createId, workspace);
        return { localOperationId, state: 'accepted', httpStatus: 200 };
      }
      if (operationId === GROK_WORKSPACE_OPERATION_IDS.update) {
        const workspace = workspaces.get(input.workspaceId);
        Object.assign(workspace, input.body);
        return { localOperationId, state: 'accepted', httpStatus: 200 };
      }
      if (operationId === GROK_WORKSPACE_OPERATION_IDS.delete) {
        workspaces.delete(input.workspaceId);
        journalEntries.get(localOperationId).state = 'needs_review';
        return { localOperationId, state: 'needs_review', httpStatus: 200 };
      }
      throw new Error(`unexpected submit ${operationId}`);
    },
    async getInMemoryServiceJobId() { return createId; },
  };
  const journal = {
    async get(localOperationId) { return journalEntries.get(localOperationId) ?? null; },
    async transition(localOperationId, state, details = {}) {
      const entry = journalEntries.get(localOperationId);
      if (!entry) throw new Error('missing entry');
      Object.assign(entry, { state, ...details });
      return { ...entry };
    },
  };
  return { client, journal, calls, workspaces, setCreateId(value) { createId = value; } };
}

test('create only accepts a source-backed kind and an exact workspace name', async () => {
  const runtime = fakeRuntime();
  const workspace = createGrokWorkspaceClient(runtime);

  await assert.rejects(workspace.create({ name: 'New project' }, intent('create-missing-kind')), { code: 'WORKSPACE_KIND_INVALID' });
  await assert.rejects(workspace.create({ name: 'New project', kind: 'WORKSPACE_KIND_UNIFIED', isPublic: true }, intent('create-public')), { code: 'WORKSPACE_BODY_UNKNOWN_FIELD' });
  assert.equal(runtime.calls.some(call => call.type === 'submit'), false);
});

test('create, rename, and delete verify independent reads for the authorized private workspace', async () => {
  const runtime = fakeRuntime();
  const workspace = createGrokWorkspaceClient(runtime);
  const created = await workspace.create({ name: 'Private test', kind: 'WORKSPACE_KIND_UNIFIED' }, intent('create'));

  assert.equal(created.verified, true);
  assert.equal(created.workspace.workspaceId, createdId);
  assert.equal(created.workspace.isPublic, false);
  assert.deepEqual(runtime.calls.find(call => call.type === 'submit' && call.operationId === 'workspaces.create').input.body,
    { name: 'Private test', kind: 'WORKSPACE_KIND_UNIFIED' });

  const renamed = await workspace.update(createdId, { name: 'Private test renamed' }, intent('rename'));
  assert.equal(renamed.verified, true);
  assert.equal(renamed.workspace.name, 'Private test renamed');
  assert.deepEqual(runtime.calls.find(call => call.type === 'submit' && call.operationId === 'workspaces.update').input.body,
    { name: 'Private test renamed' });

  const removed = await workspace.delete(createdId, intent('delete'));
  assert.equal(removed.verified, true);
  assert.equal(removed.state, 'completed');
  assert.equal(runtime.workspaces.has(createdId), false);
  const listCalls = runtime.calls.filter(call => call.type === 'read' && call.operationId === 'workspaces.list');
  assert.equal(listCalls.length, 2); // create collision check and post-delete absence readback
});

test('create stops before dispatch when preflight pagination cycles or a name already exists', async () => {
  const paged = fakeRuntime({ nextPageToken: 'next-page' });
  await assert.rejects(createGrokWorkspaceClient(paged).create({ name: 'New', kind: 'WORKSPACE_KIND_UNIFIED' }, intent('paged')),
    { code: 'WORKSPACE_CURSOR_CYCLE' });
  assert.equal(paged.calls.some(call => call.type === 'submit'), false);

  const duplicate = fakeRuntime({ initialWorkspaces: [{ workspaceId: existingId, name: 'Already there', isPublic: false }] });
  await assert.rejects(createGrokWorkspaceClient(duplicate).create({ name: 'Already there', kind: 'WORKSPACE_KIND_UNIFIED' }, intent('duplicate')),
    { code: 'WORKSPACE_NAME_ALREADY_EXISTS' });
  assert.equal(duplicate.calls.some(call => call.type === 'submit'), false);
});

test('an explicitly confirmed owner can update and delete an existing private workspace after a fresh target read', async () => {
  const runtime = fakeRuntime();
  const workspace = createGrokWorkspaceClient(runtime);

  const renamed = await workspace.update(existingId, { name: 'Existing renamed' }, intent('existing-rename'));
  assert.equal(renamed.verified, true);
  assert.equal(renamed.workspace.name, 'Existing renamed');
  const removed = await workspace.delete(existingId, intent('existing-delete'));
  assert.equal(removed.verified, true);
  assert.equal(runtime.workspaces.has(existingId), false);
  assert.equal(runtime.calls.filter(call => call.type === 'submit' && ['workspaces.update', 'workspaces.delete'].includes(call.operationId)).length, 2);
});

test('foreign and shared readonly targets are rejected before mutation dispatch', async () => {
  const foreign = fakeRuntime({ initialWorkspaces: [{ workspaceId: existingId, name: 'Foreign', isPublic: false, kind: 'WORKSPACE_KIND_UNIFIED', accessLevel: 'VIEWER', isReadonly: false }] });
  const foreignWorkspace = createGrokWorkspaceClient(foreign);
  await assert.rejects(foreignWorkspace.update(existingId, { name: 'No' }, intent('foreign-update')), { code: 'WORKSPACE_OWNER_ACCESS_REQUIRED' });
  await assert.rejects(foreignWorkspace.delete(existingId, intent('foreign-delete')), { code: 'WORKSPACE_OWNER_ACCESS_REQUIRED' });
  assert.equal(foreign.calls.some(call => call.type === 'submit'), false);

  const sharedReadonly = fakeRuntime({ initialWorkspaces: [{ workspaceId: existingId, name: 'Shared', isPublic: false, kind: 'WORKSPACE_KIND_UNIFIED', accessLevel: 'OWNER', isReadonly: true }] });
  const sharedWorkspace = createGrokWorkspaceClient(sharedReadonly);
  await assert.rejects(sharedWorkspace.delete(existingId, intent('readonly-delete')), { code: 'WORKSPACE_OWNER_ACCESS_REQUIRED' });
  assert.equal(sharedReadonly.calls.some(call => call.type === 'submit'), false);

  const unclassified = fakeRuntime({ initialWorkspaces: [{ workspaceId: existingId, name: 'Owner without readonly field', isPublic: false, kind: 'WORKSPACE_KIND_UNIFIED', accessLevel: 'OWNER' }] });
  const unclassifiedWorkspace = createGrokWorkspaceClient(unclassified);
  const ownerWithoutReadonlyFlag = await unclassifiedWorkspace.update(existingId, { name: 'Owner without readonly field renamed' }, intent('missing-readonly-flag'));
  assert.equal(ownerWithoutReadonlyFlag.verified, true);
  assert.equal(unclassified.calls.some(call => call.type === 'submit'), true);

  const publicWorkspaceRuntime = fakeRuntime({ initialWorkspaces: [{ workspaceId: existingId, name: 'Public', isPublic: true, kind: 'WORKSPACE_KIND_UNIFIED', accessLevel: 'OWNER', isReadonly: false }] });
  const publicWorkspace = createGrokWorkspaceClient(publicWorkspaceRuntime);
  const publicRename = await publicWorkspace.update(existingId, { name: 'Public renamed' }, intent('public-rename'));
  assert.equal(publicRename.verified, true);
  assert.equal(publicRename.workspace.isPublic, true);
  const publicDelete = await publicWorkspace.delete(existingId, intent('public-delete'));
  assert.equal(publicDelete.verified, true);
  assert.equal(publicWorkspaceRuntime.workspaces.has(existingId), false);
});

test('owner verification is required before a create mutation', async () => {
  const runtime = fakeRuntime({ ownerVerified: false });
  const workspace = createGrokWorkspaceClient(runtime);
  await assert.rejects(workspace.create({ name: 'New', kind: 'WORKSPACE_KIND_UNIFIED' }, intent('unverified')), { code: 'OWNER_VERIFICATION_REQUIRED' });
  assert.equal(runtime.calls.length, 0);
});
