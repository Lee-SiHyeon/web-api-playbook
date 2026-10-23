import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentProvenanceAudit } from '../src/document-provenance.mjs';
const documentUrl = 'https://flow.google.com/project/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const rpcUrl = 'https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=Zzl0ze&f.sid=document-session';

test('document provenance compares actual paired values without exposing them', () => {
  const audit = createDocumentProvenanceAudit();
  audit.observeDocument(documentUrl, '<script>window.WIZ_global_data={"SNlM0e":"private-request-token","FdrFJe":"document-session"}</script>');
  const result = audit.inspectRpc(rpcUrl, new URLSearchParams({ at: 'private-request-token', 'f.req': '[]' }));
  assert.equal(result.requestTokenMatchesDocument, true);
  assert.equal(result.sessionIdMatchesDocument, true);
  assert.doesNotMatch(JSON.stringify(result), /private-request-token|document-session/);
  audit.clear();
  assert.equal(audit.inspectRpc(rpcUrl, 'at=private-request-token').documentPairObserved, false);
});

test('mixed document pairs and duplicate fields are reported as mismatches', () => {
  const audit = createDocumentProvenanceAudit();
  audit.observeDocument(documentUrl, '{"SNlM0e":"token-one","FdrFJe":"session-one"}');
  audit.observeDocument(documentUrl, '{"SNlM0e":"token-two","FdrFJe":"session-two"}');
  const stale = audit.inspectRpc(rpcUrl + '&f.sid=session-two', 'at=token-one&at=token-two');
  assert.equal(stale.requestTokenMatchesDocument, false);
  assert.equal(stale.sessionIdMatchesDocument, false);
  assert.equal(stale.formKeysUnique, false);
  assert.equal(stale.queryKeysUnique, false);
});

test('unrelated documents cannot replace the active Flow document pair', () => {
  const audit = createDocumentProvenanceAudit();
  audit.observeDocument(documentUrl, '{"SNlM0e":"token","FdrFJe":"document-session"}');
  assert.equal(audit.observeDocument('https://unrelated.example/project/aaaaaaaaaaaaaaaa', '{"SNlM0e":"other","FdrFJe":"other"}'), false);
  assert.equal(audit.inspectRpc(rpcUrl, 'at=token').requestTokenMatchesDocument, true);
});
