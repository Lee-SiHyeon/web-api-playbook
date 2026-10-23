import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFlowDocumentDiagnostics,
  createFlowDocumentError,
  formatSafeFlowDocumentDiagnostics,
  parseFlowDocument,
} from '../src/document-diagnostics.mjs';

const FLOW_ORIGIN = 'https://flow.google.com';
const PROJECT_ID = '123e4567-e89b-42d3-a456-426614174000';

function missingTokenError() {
  try {
    parseFlowDocument(
      '<script>{"FdrFJe":"private-sid","cfb2h":"private-bl"}</script>',
      {
        sourcePath: `/project/${PROJECT_ID}`,
        responseUrl: `${FLOW_ORIGIN}/project/${PROJECT_ID}?private-query=secret`,
        httpStatus: 200,
        mime: 'text/html; charset=utf-8',
      },
    );
  } catch (error) {
    return error;
  }
  assert.fail('Expected a missing-token diagnostic error.');
}

test('CLI document summary emits only bounded status, enums, and allowlisted booleans', () => {
  const error = missingTokenError();
  const summary = formatSafeFlowDocumentDiagnostics(error);

  assert.equal(summary,
    'documentHttpStatus=200 sessionStatus=undetermined documentMime=text/html requestPathKind=project responsePathKind=project responsePathMatchesRequestedProject=true documentMarkerPresence=SNlM0e:false,FdrFJe:true,cfb2h:true,xZbWve:false documentValidStringPresence=SNlM0e:false,FdrFJe:true,cfb2h:true,xZbWve:false');
  assert.doesNotMatch(summary, /private-sid|private-bl|123e4567|private-query|https?:|[A-Fa-f0-9]{36}/);
});

test('CLI document summary rejects extra fields and arbitrary values instead of serializing them', () => {
  const error = missingTokenError();

  error.documentDiagnostics = { ...error.documentDiagnostics, extra: '<script>raw body</script>' };
  assert.equal(formatSafeFlowDocumentDiagnostics(error), null);

  const withUnsafePath = missingTokenError();
  withUnsafePath.documentDiagnostics = {
    ...withUnsafePath.documentDiagnostics,
    sourcePathHints: {
      ...withUnsafePath.documentDiagnostics.sourcePathHints,
      requestPathKind: `/project/${PROJECT_ID}?token=secret`,
    },
  };
  assert.equal(formatSafeFlowDocumentDiagnostics(withUnsafePath), null);

  const withUnsafeMarker = missingTokenError();
  withUnsafeMarker.documentDiagnostics = {
    ...withUnsafeMarker.documentDiagnostics,
    markerPresence: { ...withUnsafeMarker.documentDiagnostics.markerPresence, SNlM0e: 'private-token' },
  };
  assert.equal(formatSafeFlowDocumentDiagnostics(withUnsafeMarker), null);

  const unknownError = missingTokenError();
  unknownError.code = 'FLOW_OTHER_ERROR';
  assert.equal(formatSafeFlowDocumentDiagnostics(unknownError), null);
});

test('CLI document summary retains auth-deletion status and a safe redirect category', () => {
  const diagnostics = createFlowDocumentDiagnostics({
    httpStatus: 302,
    mime: 'text/html; charset=utf-8',
    sourcePath: `/project/${PROJECT_ID}`,
    responseUrl: `${FLOW_ORIGIN}/project/${PROJECT_ID}`,
  });
  const error = createFlowDocumentError('Flow deleted an authentication cookie after a redirect (accounts_login); bootstrap again.', {
    code: 'FLOW_DOCUMENT_AUTH_COOKIE_DELETED',
    diagnostics,
  });
  error.redirectCategory = 'accounts_login';

  const summary = formatSafeFlowDocumentDiagnostics(error);
  assert.match(summary, /documentHttpStatus=302/);
  assert.match(summary, /sessionStatus=undetermined/);
  assert.match(summary, /documentMime=text\/html/);
  assert.doesNotMatch(summary, /123e4567|accounts\.google\.com|authuser|private/);
});
