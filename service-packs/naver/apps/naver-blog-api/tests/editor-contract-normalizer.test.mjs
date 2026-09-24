import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyEditorCapability, mergeEditorCandidates, normalizeEditorCandidate } from '../tools/discovery/editor-contract-normalizer.mjs';

test('editor candidates are classified without preserving values or becoming executable', () => {
  const record = normalizeEditorCandidate({
    url: 'https://blog.naver.com/PostWrite.naver', method: 'POST',
    queryFields: ['blogId', 'token'], formFieldNames: ['documentModel', 'title'], terms: ['PostWrite'],
    resourceType: 'xhr',
    privateValue: 'synthetic-private',
  }, { source: 'fixture', confidence: 'observed_candidate_metadata' });
  assert.equal(record.capability, 'publish');
  assert.equal(record.mutationCandidate, true);
  assert.equal(record.executable, false);
  assert.equal(record.valuesObserved, false);
  assert.equal(record.resourceType, 'xhr');
  assert.doesNotMatch(JSON.stringify(record), /synthetic-private/);
});

test('capability classifier separates write, update, delete, media and draft families', () => {
  assert.equal(classifyEditorCapability('/PostWrite.naver'), 'publish');
  assert.equal(classifyEditorCapability('/PostUpdate.naver'), 'update');
  assert.equal(classifyEditorCapability('/PostDelete.naver'), 'delete');
  assert.equal(classifyEditorCapability('/upload/Photo.naver'), 'media_upload');
  assert.equal(classifyEditorCapability('/AutoSaveDraft.naver'), 'draft_or_autosave');
  assert.equal(classifyEditorCapability('/post/editor/slide_photo/swf/motionPhoto.swf'), 'media_asset');
  assert.equal(classifyEditorCapability('/nidlogin.login?template=blog'), 'authentication_navigation');
});

test('duplicate candidate evidence merges sources but never enables execution', () => {
  const first = normalizeEditorCandidate({ path: '/PostWrite.naver', method: 'POST', terms: ['PostWrite'] }, { source: 'a' });
  const second = normalizeEditorCandidate({ path: '/PostWrite.naver', method: 'POST', terms: ['publish'] }, { source: 'b' });
  const merged = mergeEditorCandidates([first, second]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].sources, ['a', 'b']);
  assert.equal(merged[0].executable, false);
});
