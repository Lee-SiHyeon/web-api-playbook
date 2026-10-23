import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInMemoryGrokWorkspaceRuntime } from '../src/runtime.mjs';
import { loadContractRegistry } from '../src/client.mjs';
import { materializeOperationUrl, operationReadiness } from '../src/contracts.mjs';
import { NonSecretJsonFileStore } from '../src/nonsecret-json-store.mjs';

const ownerEmail = 'workspace-owner@example.test';
const existingId = 'workspace-runtime-existing-0123456789';
const createdId = 'workspace-runtime-created-0123456789';

function sessionBundle() {
  return {
    schemaVersion: 1,
    serviceId: 'grok-web',
    origin: 'https://grok.com',
    capturedAt: new Date().toISOString(),
    sourceObservationId: 'workspace-runtime-test',
    origins: [{
      origin: 'https://grok.com',
      cookies: [{ name: 'sso', value: 'test-only-sso-value', origin: 'https://grok.com', path: '/', secure: true, httpOnly: true }],
      headers: [],
    }],
  };
}

test('workspace runtime wires source-derived contracts through owner-bound reads, CRUD, and semantic journal completion', async t => {
  const scratchRoot = path.join(os.homedir(), '.nad-scratch', 'tmp');
  await mkdir(scratchRoot, { recursive: true });
  const journalDirectory = await mkdtemp(path.join(scratchRoot, 'grok-workspaces-runtime-'));
  t.after(() => rm(journalDirectory, { recursive: true, force: true }));
  const journalPath = path.join(journalDirectory, 'operations.json');
  const registry = await loadContractRegistry();
  const workspaces = new Map([[existingId, {
    workspaceId: existingId, name: 'Existing owner workspace', kind: 'WORKSPACE_KIND_UNIFIED',
    isPublic: false, isReadonly: false, accessLevel: 'OWNER',
  }]]);
  const calls = [];

  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = String(init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers ?? {});
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, cookiePresent: headers.has('cookie') });
    let status = 200;
    let data;
    if (url.pathname === '/api/auth/session' && method === 'GET') {
      data = { status: 'authenticated', session: { email: ownerEmail } };
    } else if (url.pathname === '/rest/workspaces' && method === 'GET') {
      data = { workspaces: [...workspaces.values()].map(item => ({ ...item })), nextPageToken: '' };
    } else if (url.pathname === '/rest/workspaces' && method === 'POST') {
      assert.deepEqual(Object.keys(body).sort(), ['kind', 'name']);
      data = { workspaceId: createdId, ...body, isPublic: false, isReadonly: false, accessLevel: 'OWNER' };
      workspaces.set(createdId, { ...data });
    } else if (url.pathname === '/rest/workspaces/shared' && method === 'GET') {
      data = { workspaces: [], nextPageToken: '' };
    } else {
      const match = /^\/rest\/workspaces\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
      if (!match) return new Response(JSON.stringify({ error: 'not-found' }), { status: 404, headers: { 'content-type': 'application/json' } });
      const id = decodeURIComponent(match[1]);
      if (method === 'GET') {
        data = workspaces.get(id) ?? null;
        if (!data) status = 404;
      } else if (method === 'PUT') {
        const current = workspaces.get(id);
        if (!current) status = 404;
        else {
          Object.assign(current, body);
          data = { ...current };
        }
      } else if (method === 'DELETE') {
        if (!workspaces.has(id)) status = 404;
        else {
          workspaces.delete(id);
          data = {};
        }
      } else {
        status = 404;
      }
    }
    return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  };

  const runtime = await createInMemoryGrokWorkspaceRuntime({
    registry,
    fetchImpl,
    journalPersistence: new NonSecretJsonFileStore({ filePath: journalPath }),
  });
  await runtime.client.importSession(sessionBundle());
  const ownerReceipt = await runtime.client.verifyOwner(ownerEmail);
  assert.equal(ownerReceipt.ownerVerified, true);
  assert.equal((await runtime.client.status()).readiness.capabilities.workspaceManagement.directReplayVerified, true);

  const listed = await runtime.workspaces.list({ pageSize: 1000 });
  assert.equal(listed.status, 200);
  assert.equal(listed.data.workspaces.length, 1);
  assert.equal(listed.data.workspaces[0].workspaceId, existingId);
  const shared = await runtime.workspaces.listShared({ pageSize: 1000 });
  assert.deepEqual(shared.data.workspaces, []);

  const created = await runtime.workspaces.create({ name: 'Runtime private project', kind: 'WORKSPACE_KIND_UNIFIED' }, {
    confirm: true, intentId: 'runtime-workspace-create-once',
  });
  assert.equal(created.verified, true);
  assert.equal(created.workspace.workspaceId, createdId);
  assert.equal(created.workspace.isPublic, false);
  assert.equal(created.workspace.accessLevel, 'OWNER');

  const renamed = await runtime.workspaces.update(existingId, { name: 'Existing owner workspace renamed' }, {
    confirm: true, intentId: 'runtime-workspace-rename-once',
  });
  assert.equal(renamed.verified, true);
  assert.equal(renamed.workspace.name, 'Existing owner workspace renamed');

  const deleted = await runtime.workspaces.delete(createdId, { confirm: true, intentId: 'runtime-workspace-delete-once' });
  assert.equal(deleted.verified, true);
  assert.equal(workspaces.has(createdId), false);
  assert.equal(workspaces.has(existingId), true);

  const journalEntries = await runtime.journal.list();
  assert.equal(journalEntries.length, 3);
  assert.deepEqual(journalEntries.map(entry => entry.state), ['completed', 'completed', 'completed']);
  assert.deepEqual(journalEntries.map(entry => entry.attemptCount), [1, 1, 1]);
  assert.equal(journalEntries.every(entry => entry.serviceJobIdDigest === null || /^[a-f0-9]{64}$/.test(entry.serviceJobIdDigest)), true);
  const persistedJournal = await readFile(journalPath, 'utf8');
  assert.equal(persistedJournal.includes(createdId), false);
  assert.equal(persistedJournal.includes(ownerEmail), false);
  assert.equal(persistedJournal.includes('test-only-sso-value'), false);

  const postDeleteList = calls.findLast(call => call.method === 'GET' && call.path === '/rest/workspaces');
  assert.equal(postDeleteList.query.pageSize, '1000');
  assert.equal(postDeleteList.cookiePresent, true);
  const deleteCall = calls.find(call => call.method === 'DELETE');
  assert.equal(deleteCall.path, `/rest/workspaces/${createdId}`);
  assert.equal(deleteCall.body, null);
});

test('source-derived workspace readiness keeps omitted query fields optional and requires write readback', async () => {
  const registry = await loadContractRegistry();
  const listOperation = registry.operations.find(operation => operation.id === 'workspaces.list');
  assert.equal(materializeOperationUrl(listOperation, {}).search, '');
  assert.equal(materializeOperationUrl(listOperation, { pageSize: 1000, kind: 'WORKSPACE_KIND_UNIFIED' }).searchParams.get('pageSize'), '1000');

  const deleteOperation = registry.operations.find(operation => operation.id === 'workspaces.delete');
  const noReadback = { ...deleteOperation, evidence: { ...deleteOperation.evidence, semanticReadbackVerified: false } };
  assert.equal(operationReadiness(noReadback).ready, false);
  assert.equal(operationReadiness(deleteOperation).ready, true);
});
