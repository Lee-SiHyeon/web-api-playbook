import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PRIVATE_CREATE_TITLE, PRIVATE_CREATE_PARAGRAPHS, HEADLESS_CREATE_TITLE, HEADLESS_CREATE_PARAGRAPHS,
  validatePrivateCreateEnvelope, verifyPrivateCreate } from '../tools/discovery/private-create-probe.mjs';
import { compileEditorModel } from '../scripts/api/editor-model.mjs';
import { environmentSession } from '../scripts/api/environment-session.mjs';
import { WriteJournal } from '../scripts/api/write-journal.mjs';
import { seedModel, publicHtml } from './support/publication-fixture.mjs';

const NOW = new Date('2026-09-20T13:00:00Z');
const blogId = 'syntheticblog', logNo = '123456789';
const document = { blogId, logNo, title: PRIVATE_CREATE_TITLE,
  blocks: PRIVATE_CREATE_PARAGRAPHS.map(text => ({ type: 'paragraph', text })) };
const model = compileEditorModel(seedModel(), document);
const json = result => new Response(JSON.stringify({ isSuccess: true, result }),
  { headers: { 'content-type': 'application/json' } });
function envelope(probe = 'browser') {
  const fixtureModel = probe === 'headless' ? compileEditorModel(seedModel(), { ...document,
    title: HEADLESS_CREATE_TITLE, blocks: HEADLESS_CREATE_PARAGRAPHS.map(text => ({ type: 'paragraph', text })) }) : model;
  return { blogId, observedAt: NOW.toISOString(), browserRequestCancelled: true,
    body: new URLSearchParams({ blogId, documentModel: JSON.stringify(fixtureModel),
      populationParams: JSON.stringify({ configuration: { openType: 0 },
        populationMeta: { logNo: null, postWriteTimeType: 'now', noticePostYn: false } }),
      mediaResources: JSON.stringify({ image: [], video: [], file: [] }),
      productApiVersion: 'v1', tokenId: 'synthetic-current-token' }).toString() };
}
async function setup(t, options = {}) {
  const fixtureDocument = options.probe === 'headless' ? { ...document,
    title: HEADLESS_CREATE_TITLE, blocks: HEADLESS_CREATE_PARAGRAPHS.map(text => ({ type: 'paragraph', text })) } : document;
  const fixtureModel = compileEditorModel(seedModel(), fixtureDocument);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'naver-create-probe-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const fetchImpl = async (raw, init) => {
    const url = new URL(raw); calls.push({ url, init });
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.cookie, 'NID_AUT=synthetic-aut; NID_SES=synthetic-ses');
    if (url.pathname === '/PostWriteFormSeOptions.naver')
      return json({ documentModel: url.searchParams.has('logNo') ? JSON.stringify(fixtureModel) : null });
    if (url.pathname === '/PostWriteFormManagerOptions.naver')
      return json({ blogId: options.wrongOwner ? 'foreignblog' : blogId,
        isWriterBlogOwner: true, formView: { editorSource: 'synthetic-source',
          postConfiguration: { openType: options.publicReadback ? 2 : 0 },
          postFormMeta: { logNo: url.searchParams.get('logNo') } } });
    if (url.pathname === '/RabbitWrite.naver') {
      if (options.lostResponse) throw Error('synthetic-secret-response');
      if (options.loginHtml) return new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } });
      return json({ redirectUrl: options.wrongRedirect ? 'https://foreign.example/' :
        `https://blog.naver.com/PostView.naver?blogId=${blogId}&logNo=${logNo}` });
    }
    if (url.pathname === '/PostView.naver') return new Response(publicHtml(
      options.mismatch ? { ...fixtureDocument, blocks: fixtureDocument.blocks.slice(0, 3) } : fixtureDocument),
      { headers: { 'content-type': 'text/html' } });
    throw Error('UNEXPECTED_REQUEST');
  };
  const session = environmentSession({ NAVER_COOKIE: 'NID_AUT=synthetic-aut; NID_SES=synthetic-ses' });
  t.after(() => session.clear());
  return { blogId, session, probe: options.probe || 'browser', journal: new WriteJournal(directory), directory, calls,
    fetchImpl, now: () => NOW };
}

test('fresh browser-issued private create makes one HTTP write and verifies all content', async t => {
  const state = await setup(t);
  const receipt = await verifyPrivateCreate(envelope(), state);
  assert.equal(receipt.readbackVerified, true);
  assert.equal(receipt.privateVisibilityVerified, true);
  assert.equal(receipt.logNo, logNo);
  assert.equal(receipt.browserFreeTokenIssuanceVerified, false);
  assert.equal(receipt.publicationQualityVerified, false);
  assert.equal(state.calls.filter(c => c.url.pathname === '/RabbitWrite.naver').length, 1);
  const records = await Promise.all((await readdir(state.directory)).map(f => readFile(path.join(state.directory, f), 'utf8')));
  assert.ok(records.every(r => !/synthetic-current-token|NID_AUT=|documentModel/.test(r)));
  assert.equal(JSON.parse(records[0]).state, 'verified');
});

test('invalid or stale envelopes cannot reach a network request', async t => {
  const state = await setup(t);
  const cases = [
    e => { e.browserRequestCancelled = false; },
    e => { e.observedAt = new Date(NOW.getTime() - 60001).toISOString(); },
    e => { e.observedAt = new Date(NOW.getTime() + 1).toISOString(); },
    e => { e.blogId = 'foreignblog'; },
    e => { e.body += '&tokenId=synthetic-duplicate'; },
    e => { e.body = e.body.replace('synthetic-current-token', encodeURIComponent(Buffer.from('FAILURE. synthetic').toString('base64'))); },
    e => { const p = new URLSearchParams(e.body); p.set('documentModel', JSON.stringify(compileEditorModel(seedModel(), { ...document, title: 'commercial text' }))); e.body = p.toString(); },
    e => { const p = new URLSearchParams(e.body); const v = JSON.parse(p.get('populationParams')); v.configuration.openType = 2; p.set('populationParams', JSON.stringify(v)); e.body = p.toString(); },
    e => { const p = new URLSearchParams(e.body); const v = JSON.parse(p.get('populationParams')); v.populationMeta.logNo = logNo; p.set('populationParams', JSON.stringify(v)); e.body = p.toString(); },
    e => { const p = new URLSearchParams(e.body); const v = JSON.parse(p.get('populationParams')); v.populationMeta.postWriteTimeType = 'reserve'; p.set('populationParams', JSON.stringify(v)); e.body = p.toString(); },
  ];
  for (const mutate of cases) {
    const e = envelope(); mutate(e);
    await assert.rejects(verifyPrivateCreate(e, state));
  }
  assert.equal(state.calls.length, 0);
});

test('current owner is checked before attempting creation', async t => {
  const state = await setup(t, { wrongOwner: true });
  await assert.rejects(verifyPrivateCreate(envelope(), state), { code: 'ACTOR_SCOPE_UNVERIFIED' });
  assert.equal(state.calls.some(c => c.url.pathname === '/RabbitWrite.naver'), false);
});

test('uncertain creation is not resubmitted with another fresh token', async t => {
  const state = await setup(t, { lostResponse: true });
  await assert.rejects(verifyPrivateCreate(envelope(), state), { code: 'PROBE_WRITE_OUTCOME_UNKNOWN' });
  const fresh = envelope(); fresh.body = fresh.body.replace('synthetic-current-token', 'synthetic-next-token');
  await assert.rejects(verifyPrivateCreate(fresh, state), /WRITE_ALREADY_ATTEMPTED_READBACK_REQUIRED/);
  assert.equal(state.calls.filter(c => c.url.pathname === '/RabbitWrite.naver').length, 1);
});

for (const option of ['wrongRedirect', 'loginHtml', 'mismatch', 'publicReadback']) {
  test(`creation cannot be certified after ${option}`, async t => {
    const state = await setup(t, { [option]: true });
    await assert.rejects(verifyPrivateCreate(envelope(), state));
    const records = await readdir(state.directory);
    const record = JSON.parse(await readFile(path.join(state.directory, records[0]), 'utf8'));
    assert.equal(record.state, 'submitted_unknown');
    assert.equal(record.receipt.retryAllowed, false);
    assert.equal(state.calls.filter(c => c.url.pathname === '/RabbitWrite.naver').length, 1);
  });
}

test('handoff freshness limit is local policy and does not assume a token length', () => {
  const e = envelope(); e.body = e.body.replace('synthetic-current-token', 'synthetic-different-token-length');
  assert.equal(validatePrivateCreateEnvelope(e, { blogId, now: NOW }).handoffAgeMs, 0);
});

test('headless probe accepts only its fixed private document and preserves one-write recovery', async t => {
  const state = await setup(t, { probe: 'headless' });
  const receipt = await verifyPrivateCreate(envelope('headless'), state);
  assert.equal(receipt.operation, 'headlessPrivateCreateProbe');
  assert.equal(receipt.readbackVerified, true);
  assert.equal(receipt.browserFreeTokenIssuanceVerified, false);
  await assert.rejects(verifyPrivateCreate(envelope('headless'), { ...state,
    journal: new WriteJournal(state.directory) }), /WRITE_ALREADY_ATTEMPTED_READBACK_REQUIRED/);
  assert.equal(state.calls.filter(c => c.url.pathname === '/RabbitWrite.naver').length, 1);
});

test('changing the probe selection cannot authorize arbitrary or mismatched content', async t => {
  const state = await setup(t);
  await assert.rejects(verifyPrivateCreate(envelope(), { ...state, probe: 'headless' }), { code: 'PROBE_CONTENT' });
  await assert.rejects(verifyPrivateCreate(envelope('headless'), state), { code: 'PROBE_CONTENT' });
  await assert.rejects(verifyPrivateCreate(envelope(), { ...state, probe: 'arbitrary' }), { code: 'PROBE_PROFILE' });
  const publicEnvelope = envelope('headless');
  const params = new URLSearchParams(publicEnvelope.body);
  const population = JSON.parse(params.get('populationParams')); population.configuration.openType = 2;
  params.set('populationParams', JSON.stringify(population)); publicEnvelope.body = params.toString();
  await assert.rejects(verifyPrivateCreate(publicEnvelope, { ...state, probe: 'headless' }), { code: 'PROBE_PRIVATE_CREATE_ONLY' });
  assert.equal(state.calls.length, 0);
});
