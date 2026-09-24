import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, selectEditorReadCandidates, summarizeLogin } from '../scripts/read-discovery.mjs';

test('read-discovery argument parsing is bounded and rejects unknown flags', () => {
  assert.deepEqual(parseArgs([]), { help: false, maxDocuments: 12 });
  assert.deepEqual(parseArgs(['--help']), { help: true, maxDocuments: 12 });
  assert.deepEqual(parseArgs(['--max-documents=50']), { help: false, maxDocuments: 50 });
  for (const args of [['--max-documents=0'], ['--max-documents=51'], ['--max-documents=x'], ['--write']]) {
    assert.throws(() => parseArgs(args), { code: 'INPUT' });
  }
});

test('read-discovery promotes only observed editor documents and public scripts', () => {
  const links = [
    { id: 'editor', state: 'read_candidate', classification: 'editor_form_document' },
    { id: 'script', state: 'read_candidate', classification: 'public_script' },
    { id: 'post', state: 'read_candidate', classification: 'public_post_document' },
    { id: 'form', state: 'unreviewed_candidate', classification: null, method: 'POST' },
    { id: 'delete', state: 'unreviewed_candidate', classification: 'editor_form_document' },
    { id: 'editor', state: 'read_candidate', classification: 'editor_form_document' },
  ];
  assert.deepEqual(selectEditorReadCandidates(links, new Set(['script'])), [
    { id: 'editor', classification: 'editor_form_document' },
  ]);
});

test('login summary excludes cookies, credentials and arbitrary response fields', () => {
  const result = summarizeLogin({ state: 'http_ready', classification: 'session_issued_unverified',
    authenticatedHTTP: true, apiOnly: true, browserOpen: false, password: 'synthetic-secret', cookie: 'NID_SES=x',
    verification: { verified: true, actor: '4053103', httpStatus: 200, mime: 'text/html',
      source: 'independent_node_fetch', sha256: 'synthetic-hash', privateBody: 'synthetic-private' } });
  assert.deepEqual(result, { state: 'http_ready', classification: 'session_issued_unverified',
    authenticatedHTTP: true, apiOnly: true, browserOpen: false,
    verification: { verified: true, actor: '4053103', httpStatus: 200, mime: 'text/html', source: 'independent_node_fetch' } });
  assert.doesNotMatch(JSON.stringify(result), /secret|NID_|private|sha256/);
});
