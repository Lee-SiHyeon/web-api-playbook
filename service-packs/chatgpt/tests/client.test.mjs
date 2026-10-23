import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ChatGPTWebClient } from '../src/client.mjs';
import { loadRegistry, PRIMARY_ORIGIN } from '../src/contracts.mjs';
import { MutationJournal } from '../src/journal.mjs';
import { syntheticOperation, syntheticRegistry, syntheticSessionProvider } from './helpers.mjs';

test('generic status never claims an operation-specific ChatGPT client or live replay', async () => {
  const registry = await loadRegistry();
  const client = new ChatGPTWebClient({ registry, sessionProvider: syntheticSessionProvider });
  const status = await client.status();
  assert.equal(status.genericInfrastructureReady, true);
  assert.equal(status.contractState, 'CONTRACT_NOT_CAPTURED');
  for (const operation of Object.values(status.operations)) {
    assert.equal(operation.captured, false);
    assert.equal(operation.clientExists, false);
    assert.equal(operation.credentialPropagated, false);
    assert.equal(operation.liveReplay, false);
  }
  let fetchCount = 0;
  const noContract = new ChatGPTWebClient({ registry, sessionProvider: syntheticSessionProvider,
    fetchImpl: async () => { fetchCount += 1; return new Response('{}'); } });
  await assert.rejects(noContract.sendRead('text.history', {}), (error) => error.code === 'CONTRACT_NOT_CAPTURED');
  assert.equal(fetchCount, 0);
});

test('injected registries are validated before client setup and again at operation lookup', async () => {
  const operation = syntheticOperation();
  const registry = syntheticRegistry([operation]);
  const unsafe = { ...registry, operations: [{ ...registry.operations[0],
    request: { ...registry.operations[0].request, headers: { 'x-session-token': 'never-static' } } }] };
  assert.throws(() => new ChatGPTWebClient({ registry: unsafe }), (error) => error.code === 'CONTRACT_INVALID');
  await assert.rejects(ChatGPTWebClient.create({ registry: unsafe }), (error) => error.code === 'CONTRACT_INVALID');

  const client = new ChatGPTWebClient({ registry, sessionProvider: syntheticSessionProvider });
  client.registry.operations[0].request.headers['x-auth-proof'] = 'never-static';
  assert.throws(() => client.getOperation(operation.id), (error) => error.code === 'CONTRACT_INVALID');
});

test('observed read transport is origin scoped and refuses redirects', async () => {
  const operation = syntheticOperation({ id: 'history.read.synthetic', kind: 'read', method: 'POST' });
  const registry = syntheticRegistry([operation]);
  let captured;
  const client = new ChatGPTWebClient({ registry, sessionProvider: syntheticSessionProvider,
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    } });
  const result = await client.sendRead(operation.id, { targetId: 'synthetic-id', text: 'test input' });
  assert.deepEqual(result.body, { ok: true });
  assert.equal(captured.url.origin, PRIMARY_ORIGIN);
  assert.equal(captured.options.redirect, 'manual');
  assert.equal(captured.options.headers.get('cookie'), 'synthetic_session=unit-test-only');
  assert.equal(captured.options.credentials, undefined);

  const redirectClient = new ChatGPTWebClient({ registry, sessionProvider: syntheticSessionProvider,
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.invalid/' } }) });
  await assert.rejects(redirectClient.sendRead(operation.id, { targetId: 'synthetic-id' }),
    (error) => error.code === 'HTTP_REDIRECT_REJECTED');
});

test('mutation is journaled once, payload and target remain hashed, and uncertain outcomes are held', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chatgpt-client-journal-'));
  try {
    const operation = syntheticOperation({ id: 'text.send.synthetic', kind: 'mutation', method: 'POST' });
    const registry = syntheticRegistry([operation]);
    let calls = 0;
    const journal = new MutationJournal({ directory });
    const client = new ChatGPTWebClient({ registry, journal, sessionProvider: syntheticSessionProvider,
      fetchImpl: async () => { calls += 1; return new Response(JSON.stringify({ accepted: true }),
        { status: 200, headers: { 'content-type': 'application/json' } }); } });
    const result = await client.sendMutation(operation.id, { targetId: 'private-thread-id', text: 'private prompt text' });
    assert.equal(result.state, 'response_received');
    assert.equal(calls, 1);
    await assert.rejects(client.sendMutation(operation.id, { targetId: 'private-thread-id', text: 'private prompt text' }),
      (error) => error.code === 'MUTATION_OUTCOME_UNKNOWN_HOLD');
    assert.equal(calls, 1);
    const journalText = await readFile(path.join(directory, `${result.journalId}.json`), 'utf8');
    assert.equal(journalText.includes('private prompt text'), false);
    assert.equal(journalText.includes('private-thread-id'), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('media upload uses the captured multipart field and validates local bytes before dispatch', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chatgpt-client-upload-'));
  try {
    const imagePath = path.join(directory, 'input.png');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    await writeFile(imagePath, png);
    const operation = syntheticOperation({ id: 'image.upload.synthetic', kind: 'media-upload', method: 'POST', encoding: 'multipart' });
    const registry = syntheticRegistry([operation]);
    let calls = 0;
    let filePart;
    const client = new ChatGPTWebClient({ registry, journal: new MutationJournal({ directory: path.join(directory, 'journal') }),
      sessionProvider: syntheticSessionProvider, fetchImpl: async (_url, options) => {
        calls += 1;
        filePart = options.body.get('file');
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      } });
    const result = await client.uploadMedia(operation.id, { targetId: 'synthetic-target' }, imagePath);
    assert.equal(result.state, 'response_received');
    assert.equal(calls, 1);
    assert.equal(filePart.type, 'image/png');
    assert.equal(filePart.size, png.length);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('media download checks the captured response contract before saving', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chatgpt-client-download-'));
  try {
    const output = path.join(directory, 'result.png');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    const operation = syntheticOperation({ id: 'image.download.synthetic', kind: 'media-download', method: 'GET', encoding: 'none', responseKind: 'media' });
    const registry = syntheticRegistry([operation]);
    const client = new ChatGPTWebClient({ registry, sessionProvider: syntheticSessionProvider,
      fetchImpl: async () => new Response(png, { status: 200, headers: { 'content-type': 'image/png' } }) });
    const result = await client.downloadMedia(operation.id, { targetId: 'synthetic-image-id' }, output);
    assert.equal(result.signatureVerified, true);
    assert.equal(result.bytes, png.length);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
