import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {PNG} from 'pngjs';
import {NaverEditorClient} from '../scripts/api/editor-client.mjs';
import {WriteJournal} from '../scripts/api/write-journal.mjs';
import {environmentSession} from '../scripts/api/environment-session.mjs';
import {marketAnalysisFixture} from './support/market-analysis-fixture.mjs';
import {NOW, bind, seedModel, publicHtml} from './support/publication-fixture.mjs';
import {MARKET_ANALYSIS_SCOPE} from '../scripts/gates/market-analysis-article-contract.mjs';
import {fingerprint} from '../../../packages/contracts/src/index.mjs';
import {publisherContentFingerprint} from '../scripts/gates/publisher-gates.mjs';

const json = result => new Response(JSON.stringify({isSuccess: true, result}), {headers: {'content-type': 'application/json'}});
async function setup(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'naver-market-update-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const job = await marketAnalysisFixture(directory), document = job.publicationBundle.document;
  job.target = {type: 'update', logNo: MARKET_ANALYSIS_SCOPE.existingLogNo}; document.logNo = job.target.logNo;
  job.inputProvider = 'independent_http';
  const initialConfiguration = {openType: 2, searchYn: true, commentYn: false, sympathyYn: true, outSideAllowYn: false, scrapType: 2};
  const initialMeta = {logNo: Number(job.target.logNo), categoryId: 13, noticePostYn: false, postWriteTimeType: 'now',
    tags: job.publishSettings.tags.join(','), postLocationJson: {location: 'synthetic-original'}, postLocationSupportYn: false, directorySeq: 0};
  const state = {writes: 0, model: seedModel(), configuration: structuredClone(initialConfiguration), meta: structuredClone(initialMeta),
    postWriteMutation: null, breakSourceLink: false, lostResponse: false};
  const journal = new WriteJournal(path.join(directory, 'journal'));
  for (const image of document.blocks.filter(block => block.type === 'image')) {
    const bytes = await readFile(path.join(directory, image.file)), png = PNG.sync.read(bytes);
    image.uploadReceipt = {schemaVersion: 1, operation: 'uploadPng', source: 'independent_http', blogId: job.blogId, checkedAt: NOW.toISOString(),
      sha256: image.sha256, publishedUrl: image.publishedUrl, fileName: image.file, width: png.width, height: png.height, fileSize: bytes.length, readbackVerified: true};
    const key = journal.key('uploadPng', {blogId: job.blogId}, {sha256: image.sha256, fileName: image.file});
    await journal.reserve(key, {operation: 'uploadPng', synthetic: true}); await journal.finish(key, 'verified', image.uploadReceipt);
  }
  const session = environmentSession({NAVER_COOKIE: 'NID_AUT=synthetic-market-aut; NID_SES=synthetic-market-ses'}); t.after(() => session.clear());
  const fetchImpl = async (raw, init) => {
    const url = new URL(raw);
    if (url.pathname === '/BlogTagListInfo.naver') return new Response(JSON.stringify({taglist:[{msg:'',logno:String(job.target.logNo),tagName:encodeURIComponent(state.meta.tags)}]}),{headers:{'content-type':'text/plain;charset=UTF-8'}});
    if (url.origin === 'https://blogfiles.pstatic.net') {
      assert.equal(new Headers(init.headers).has('cookie'), false);
      return new Response(await readFile(path.join(directory, url.pathname.split('/').at(-1))), {headers: {'content-type': 'image/png'}});
    }
    assert.equal(url.origin, 'https://blog.naver.com', 'The noncommercial update must not call an affiliate API');
    if (url.pathname === '/PostWriteFormSeOptions.naver') return json({documentModel: JSON.stringify(state.model)});
    if (url.pathname === '/PostWriteFormManagerOptions.naver') return json({blogId: job.blogId, isWriterBlogOwner: true,
      formView: {editorSource: 'synthetic-source', postConfiguration: state.configuration, postFormMeta: state.meta}});
    if (url.pathname === '/RabbitUpdate.naver') {
      state.writes++;
      const population = JSON.parse(init.body.get('populationParams'));
      assert.deepEqual(population.configuration, initialConfiguration);
      assert.deepEqual(population.populationMeta, initialMeta);
      state.model = JSON.parse(init.body.get('documentModel')); state.configuration = population.configuration; state.meta = population.populationMeta;
      state.postWriteMutation?.(state);
      if (state.lostResponse) throw Error('Synthetic transport response lost after the write');
      return json({redirectUrl: `https://blog.naver.com/PostView.naver?blogId=${job.blogId}&logNo=${job.target.logNo}`});
    }
    if (url.pathname === '/PostView.naver') {
      let html = publicHtml(document);
      if (state.breakSourceLink) html = html.replace('href="https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400"', 'href="https://evil.example/"');
      return new Response(html, {headers: {'content-type': 'text/html'}});
    }
    throw Error('UNEXPECTED_REQUEST');
  };
  const client = new NaverEditorClient({blogId: job.blogId, session, journal, fetchImpl, now: () => NOW});
  const prepared = await client.prepareUpdate(job);
  job.preflight = {...job.preflight, ...prepared}; bind(job);
  job.preflight.compiledPresentationFingerprint = prepared.compiledPresentationFingerprint;
  for (const review of Object.values(job.publicationBundle.renderReviews)) review.compiledPresentationFingerprint = prepared.compiledPresentationFingerprint;
  job.publicationBundleFingerprint = fingerprint(job.publicationBundle);
  job.preflight.publicationBundleFingerprint = job.publicationBundleFingerprint;
  job.authorization.contentFingerprint = publisherContentFingerprint(job);
  return {directory, job, client, state, initialMeta, initialConfiguration};
}

test('market update performs one full-gated write preserving public/search/category and all observed settings', async t => {
  const {directory, job, client, state} = await setup(t);
  const receipt = await client.updatePost(job, {baseDir: directory});
  assert.equal(state.writes, 1); assert.equal(receipt.readbackVerified, true);
  assert.equal(receipt.configurationVerified, true); assert.equal(receipt.metadataVerified, true); assert.equal(receipt.categoryVerified, true);
  assert.equal(receipt.searchAllowedVerified, true); assert.equal(receipt.resultGate.passed, true);
  assert.equal(receipt.data.receipt.publicReadback.researchSourceLinksPresent, true);
  assert.doesNotMatch(JSON.stringify(receipt), /NID_AUT=|synthetic-market-aut/);
  assert.equal((await client.reconcileUpdate(job)).readbackVerified, true); assert.equal(state.writes, 1);
});

for (const [name, mutate, code] of [
  ['category', state => state.meta.categoryId = 12, 'MARKET_UPDATE_STATE_OUT_OF_SCOPE'],
  ['search visibility', state => state.configuration.searchYn = false, 'MARKET_UPDATE_STATE_OUT_OF_SCOPE'],
  ['unrelated configuration', state => state.configuration.commentYn = true, 'SOURCE_PUBLICATION_SETTINGS_CHANGED'],
  ['unrelated metadata', state => state.meta.tags += ',another-tag', 'SOURCE_PUBLICATION_SETTINGS_CHANGED'],
]) test(`market update rejects changed ${name} before any mutation`, async t => {
  const {directory, job, client, state} = await setup(t); mutate(state);
  await assert.rejects(client.updatePost(job, {baseDir: directory}), {code}); assert.equal(state.writes, 0);
});

for (const [name, mutate] of [
  ['category', state => state.meta.categoryId = 12],
  ['unrelated setting', state => state.configuration.commentYn = true],
  ['nested metadata', state => state.meta.postLocationJson.location = 'altered'],
]) test(`market update treats post-write ${name} mismatch as uncertain and reconciles by reads only`, async t => {
  const {directory, job, client, state, initialMeta, initialConfiguration} = await setup(t); state.postWriteMutation = mutate;
  await assert.rejects(client.updatePost(job, {baseDir: directory}), {code: 'WRITE_OUTCOME_UNKNOWN'});
  assert.equal((await client.reconcileUpdate(job)).readbackVerified, false); assert.equal(state.writes, 1);
  state.meta = structuredClone(initialMeta); state.configuration = structuredClone(initialConfiguration);
  assert.equal((await client.reconcileUpdate(job)).readbackVerified, true); assert.equal(state.writes, 1);
});

test('lost market update response plus missing source href never causes an automatic retry', async t => {
  const {directory, job, client, state} = await setup(t); state.lostResponse = true; state.breakSourceLink = true;
  await assert.rejects(client.updatePost(job, {baseDir: directory}), {code: 'WRITE_OUTCOME_UNKNOWN'});
  assert.equal(state.writes, 1); assert.equal((await client.reconcileUpdate(job)).readbackVerified, false);
  state.breakSourceLink = false;
  assert.equal((await client.reconcileUpdate(job)).readbackVerified, true); assert.equal(state.writes, 1);
});
