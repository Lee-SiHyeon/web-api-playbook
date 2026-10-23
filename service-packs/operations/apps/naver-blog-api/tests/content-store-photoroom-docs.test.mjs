import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fetchPhotoroomDocs, parsePhotoroomIntroduction, DOCUMENT_URL } from '../research/content-store/photoroom-docs.mjs';
import { collect, validateConfig } from '../research/content-store/collect.mjs';

const document = `# Introduction\nAll endpoints follow the same logic: they take an image as their input, apply edits to it, and return their result as a new edited image.\nThe Photoroom API consists of two API endpoints.\nThe key must be passed in the x-api-key HTTP header on every request.\n`;
const response = (body, type = 'text/markdown; charset=utf-8') => new Response(body, { status: 200, headers: { 'content-type': type } });

test('public Markdown document becomes a full-document collector candidate', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method, redirect: options.redirect, accept: options.headers.accept });
    return response(document);
  };
  const config = { schemaVersion: 1, fields: ['ai'], perSourceLimit: 1,
    sources: [{ id: 'official-ai-photoroom-docs', kind: 'photoroom_docs', field: 'ai' }] };
  const result = await collect(config, { fetchImpl, now: new Date('2026-09-28T00:00:00Z') });
  assert.deepEqual(calls, [{ url: DOCUMENT_URL, method: 'GET', redirect: 'manual', accept: 'text/markdown' }]);
  assert.equal(result.sources[0].status, 'collected');
  assert.equal(result.sources[0].liveReplay, true);
  assert.equal(result.candidates[0].sourceKind, 'official_document');
  assert.equal(result.candidates[0].contentCoverage, 'full_document');
  assert.equal(result.candidates[0].originalArticleFetched, true);
  assert.match(result.candidates[0].bodyEvidence.sha256, /^[a-f0-9]{64}$/);
});

test('rejects login HTML and changed document claims instead of creating candidates', async () => {
  await assert.rejects(fetchPhotoroomDocs(1, { fetchImpl: async () => response('<html>login</html>', 'text/html') }),
    { code: 'PHOTOROOM_DOC_MIME' });
  assert.throws(() => parsePhotoroomIntroduction('# Introduction\nUnrelated text'), { code: 'PHOTOROOM_DOC_SCHEMA' });
});

test('regular source config includes the Photoroom document adapter', async () => {
  const config = JSON.parse(await readFile(new URL('../research/content-store/sources.json', import.meta.url)));
  validateConfig(config);
  assert.equal(config.sources.filter(row => row.kind === 'photoroom_docs').length, 1);
});
