import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePublicScript } from '../tools/discovery/public-script-analysis.mjs';
import { selectLatestEditorEvidenceName } from '../scripts/analyze-editor-scripts.mjs';

test('public script analysis retains endpoint metadata without values or source bodies', () => {
  const source = `
    const PostWriteApi = '/PostWrite.naver?blogId=4053103&token=synthetic-private';
    const uploadPhoto = 'https://blog.naver.com/upload/Photo.naver?session=synthetic-private';
    const unrelated = '/ordinary/path';
    const options = { method: 'POST' };
  `;
  const result = analyzePublicScript(source, 'https://ssl.pstatic.net/editor.js');
  assert.ok(result.identifiers.includes('PostWriteApi'));
  assert.ok(result.identifiers.includes('uploadPhoto'));
  assert.deepEqual(result.methodHints, ['POST']);
  assert.ok(result.candidates.some(candidate => candidate.path === '/PostWrite.naver' && candidate.origin === null));
  assert.ok(result.candidates.some(candidate => candidate.url === 'https://blog.naver.com/upload/Photo.naver'));
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private|4053103/);
  assert.equal(Object.hasOwn(result, 'source'), false);
});

test('public script analysis refuses non-pstatic sources', () => {
  assert.throws(() => analyzePublicScript('const editor = 1;', 'https://invalid.test/editor.js'), { code: 'SCOPE' });
});

test('latest editor evidence selection prefers the newest surface or read run', () => {
  assert.equal(selectLatestEditorEvidenceName([
    'live-editor-read-20260919T041802Z.json',
    'live-editor-surface-20260919T043900Z.json',
    'editor-surface-failure-20260919T044000Z.json',
  ]), 'live-editor-surface-20260919T043900Z.json');
});
