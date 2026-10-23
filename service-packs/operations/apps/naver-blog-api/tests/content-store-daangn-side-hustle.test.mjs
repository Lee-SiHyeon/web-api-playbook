import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fetchDaangnSideHustle, validateDaangnSources } from '../research/content-store/daangn-side-hustle.mjs';
import { validateConfig } from '../research/content-store/collect.mjs';

test('manifest keeps the nine observed public URLs on the Daangn cafe origin', async () => {
  const manifest = JSON.parse(await readFile(new URL('../research/content-store/daangn-side-hustle-sources.json', import.meta.url)));
  const sources = validateDaangnSources(manifest);
  assert.equal(sources.length, 9);
  assert.equal(sources.filter(row => row.kind === 'post').length, 5);
  assert.throws(() => validateDaangnSources({ schemaVersion: 1, sources: [{
    sourceRecordId: 'bad', url: 'https://other.example/posts/x', kind: 'post',
  }] }), { code: 'DAANGN_SOURCE_MANIFEST' });
});

test('login or challenge HTML does not produce a collected source', async () => {
  const manifest = { schemaVersion: 1, sources: [{ sourceRecordId: 'daangn-test',
    url: 'https://cafe.daangn.com/categories/economy-finance', kind: 'category' }] };
  const fetchImpl = async () => new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  await assert.rejects(fetchDaangnSideHustle(1, { fetchImpl, manifest }), { code: 'DAANGN_SOURCE_SCHEMA' });
});

test('regular collector config contains one side-hustle source', async () => {
  const config = JSON.parse(await readFile(new URL('../research/content-store/sources.json', import.meta.url)));
  validateConfig(config);
  assert.equal(config.sources.filter(row => row.kind === 'daangn_side_hustle').length, 1);
});
