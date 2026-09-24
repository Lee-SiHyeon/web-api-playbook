import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEditorSurfaceArgs, sanitizeObservedLinks } from '../scripts/editor-surface-discovery.mjs';

test('editor surface arguments are bounded and write flags are rejected', () => {
  assert.deepEqual(parseEditorSurfaceArgs([]), { help: false, maxDocuments: 30 });
  assert.deepEqual(parseEditorSurfaceArgs(['--max-documents=60']), { help: false, maxDocuments: 60 });
  for (const args of [['--max-documents=0'], ['--max-documents=61'], ['--publish'], ['--delete']]) {
    assert.throws(() => parseEditorSurfaceArgs(args), { code: 'INPUT' });
  }
});

test('editor surface link evidence contains metadata but no values or response bodies', () => {
  const links = sanitizeObservedLinks([{
    id: 'abc', url: 'https://blog.naver.com/PostWrite.naver', queryFields: ['blogId', 'token'],
    kind: 'form', method: 'POST', state: 'unreviewed_candidate', classification: null,
    value: 'synthetic-private', body: 'synthetic-private-body',
  }]);
  assert.deepEqual(links, [{ id: 'abc', url: 'https://blog.naver.com/PostWrite.naver',
    queryFields: ['blogId', 'token'], kind: 'form', method: 'POST',
    state: 'unreviewed_candidate', classification: null }]);
  assert.doesNotMatch(JSON.stringify(links), /synthetic|body|value/);
});
