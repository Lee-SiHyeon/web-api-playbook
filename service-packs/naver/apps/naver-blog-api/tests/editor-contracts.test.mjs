import test from 'node:test';
import assert from 'node:assert/strict';
import { editorCandidates, executeEditorCandidate, getEditorCandidate, listEditorCandidates } from '../scripts/editor-contracts.mjs';

test('editor contract catalog is metadata-only and immutable at its execution boundary', () => {
  assert.ok(editorCandidates.length > 0);
  assert.ok(editorCandidates.every(candidate => candidate.executable === false && candidate.valuesObserved === false));
  assert.throws(() => executeEditorCandidate(), { code: 'NOT_IMPLEMENTED' });
});

test('editor contract catalog filters and resolves candidates without network access', () => {
  const mutations = listEditorCandidates({ mutationOnly: true });
  assert.ok(mutations.every(candidate => candidate.mutationCandidate));
  const selected = getEditorCandidate(editorCandidates[0].id);
  assert.equal(selected.id, editorCandidates[0].id);
  assert.throws(() => getEditorCandidate('0'.repeat(20)), { code: 'UNKNOWN_CANDIDATE' });
});
