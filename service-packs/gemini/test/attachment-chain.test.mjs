import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { loadObservedContract } from '../src/contract.mjs';
import { assertPromptDoesNotContainFileContent, attachInternalAttachmentRecovery, inspectAttachmentTaskAssistantReply, requestAttachmentMessageRecapture, requireAttachmentUploadQueryReadback, runAttachmentChainOnce, safeProtocolErrorDetails, sendTextWithOneAttachmentMessageRecapture, summarizeAttachmentReplyText } from '../src/attachment-chain.mjs';
import { GeminiClientError } from '../src/errors.mjs';

test('attachment-chain keeps normalized MIME diagnostics while discarding other error values', () => {
  const details = safeProtocolErrorDetails({
    selectedFileMimeType: 'Text/Plain; charset=UTF-8',
    nativeTransferMimeType: 'APPLICATION/OCTET-STREAM',
    expectedTransferMimeType: 'Application/X-WWW-Form-Urlencoded',
    sourceEffectiveHeaderName: 'content-type',
    sourceEffectiveHeaderValueSource: 'xhr_transport_default_content_type',
    signedUrl: 'https://example.invalid/upload?token=secret',
    cookie: 'SID=secret',
  });
  assert.deepEqual(details, {
    selectedFileMimeType: 'text/plain',
    nativeTransferMimeType: 'application/octet-stream',
    expectedTransferMimeType: 'application/x-www-form-urlencoded',
    sourceEffectiveHeaderName: 'content-type',
    sourceEffectiveHeaderValueSource: 'xhr_transport_default_content_type',
  });
});

test('attachment-chain preserves only source tuple counts, shapes, and hashes from binding diagnostics', () => {
  const details = safeProtocolErrorDetails({
    attachmentBinding: {
      responsePayloadMatchCount: 0,
      filenameMatchCount: 1,
      mimeTypeMatchCount: 1,
      sourceProtoTupleMatchCount: 0,
      sourceParentValueMatchCount: 0,
      expectedResponsePayloadSha256: 'a'.repeat(64),
      sourceProtoCandidates: [{
        vePath: [18, 0], dqcPath: [18, 0, 0], veLength: 3, tupleLength: 4,
        tupleLayout: 'observed_dqc_dh_context_null_mime', tupleElementTypes: ['string', 'number', 'null', 'string'],
        dhArrayIndex: 0, contextArrayIndex: 1, sizeArrayIndex: null, mimeArrayIndex: 3,
        contextValueIsNumber: true, contextEqualsFileSize: false, sourceParentValueMatch: false,
        filenameBytes: 14, filenameSha256: 'b'.repeat(64), filenameMatched: true,
        dhBytes: 22, dhSha256: 'c'.repeat(64), dhMatched: false,
        sizeMatched: null, mimeType: 'text/plain', mimeTypeMatched: true, matched: false,
        rawValue: 'must-not-survive',
      }],
      candidates: [{ kind: 'array', length: 4, elementTypes: ['string', 'number', 'null', 'string'],
        dhSha256: 'd'.repeat(64), mimeType: 'text/plain', rawValue: 'must-not-survive' }],
      uploadedFilesTupleCandidates: [{ index: 0, responsePayloadMatchCount: 1,
        filenameMatchCount: 1, mimeTypeMatchCount: 1, sourceShapeMatchCount: 0,
        fieldShapes: [{ kind: 'array', length: 4, elementTypes: ['string', 'number', 'null', 'string'],
          dhSha256: 'e'.repeat(64), mimeType: 'text/plain', rawValue: 'must-not-survive' }] }],
    },
  });
  assert.equal(details.attachmentBinding.responsePayloadMatchCount, 0);
  assert.equal(details.attachmentBinding.sourceProtoTupleMatchCount, 0);
  assert.deepEqual(details.attachmentBinding.sourceProtoCandidates[0].dqcPath, [18, 0, 0]);
  assert.equal(details.attachmentBinding.sourceProtoCandidates[0].mimeType, 'text/plain');
  assert.equal(details.attachmentBinding.sourceProtoCandidates[0].tupleLayout, 'observed_dqc_dh_context_null_mime');
  assert.equal(details.attachmentBinding.candidates[0].dhSha256, 'd'.repeat(64));
  assert.equal(details.attachmentBinding.uploadedFilesTupleCandidates[0].fieldShapes[0].mimeType, 'text/plain');
  assert.equal(JSON.stringify(details).includes('must-not-survive'), false);
});

test('partial attachment-chain result keeps the actual ref non-enumerable and usable in process', () => {
  const reference = Object.freeze({ filename: 'file.txt', mimeType: 'text/plain', dh: 'raw-memory-only' });
  const capture = { url: 'https://gemini.google.com/_/captured', method: 'POST', body: 'raw-capture-memory-only' };
  const client = { transport: { session: { cookies: ['memory-only'] } }, verifiedOwner: 'owner@example.com' };
  const partial = attachInternalAttachmentRecovery({ outputStatus: 'upload_verified_attachment_message_unbound' }, reference, capture, client);
  assert.equal(Object.keys(partial).includes('internal'), false);
  assert.equal(JSON.stringify(partial).includes(reference.dh), false);
  assert.equal(partial.internal.attachmentRef, reference);
  assert.equal(partial.internal.capturedRequest, capture);
  assert.equal(partial.internal.client, client);
  assert.equal(typeof partial.internal.release, 'function');
  assert.equal(client.transport.session.cookies[0], 'memory-only');
  partial.internal.release();
  assert.equal(client.transport.session, null);
  assert.equal(client.verifiedOwner, null);
  assert.equal(capture.body, '');
});

test('same-process recovery handshake emits safe diagnostics and retains a fresh captured request in memory', async () => {
  let outputText = '';
  const output = new Writable({ write(chunk, _encoding, callback) { outputText += chunk.toString(); callback(); } });
  const body = Buffer.from('captured-message-body-memory-only');
  const line = JSON.stringify({ event: 'attachment-message', capture: {
    url: 'https://gemini.google.com/_/captured', method: 'POST', bodyBase64: body.toString('base64'), headers: {},
  } });
  const recovered = await requestAttachmentMessageRecapture({ next: async () => ({ value: line, done: false }) }, output, {
    attempt: 1,
    attachmentBinding: { expectedResponsePayloadSha256: 'a'.repeat(64), rawDh: 'never-emit-this' },
  });
  assert.equal(recovered.kind, 'message-recapture');
  assert.equal(recovered.capture.body, body.toString());
  assert.equal(recovered.capture.method, 'POST');
  const event = JSON.parse(outputText);
  assert.equal(event.event, 'attachment-binding-recapture-needed');
  assert.equal(event.attempt, 1);
  assert.equal(JSON.stringify(event).includes('never-emit-this'), false);
  assert.equal(JSON.stringify(event).includes(body.toString()), false);
});

test('same-process recovery handshake accepts one bounded abandon signal', async () => {
  let outputText = '';
  const output = new Writable({ write(chunk, _encoding, callback) { outputText += chunk.toString(); callback(); } });
  const abandoned = await requestAttachmentMessageRecapture({
    next: async () => ({ value: JSON.stringify({ event: 'attachment-recovery-abandon' }), done: false }),
  }, output, { attempt: 1, attachmentBinding: {} });
  assert.equal(abandoned, null);
  assert.equal(JSON.parse(outputText).event, 'attachment-binding-recapture-needed');
});

test('same-process recovery accepts only a bounded source path resolution from the private pipe', async () => {
  let outputText = '';
  const output = new Writable({ write(chunk, _encoding, callback) { outputText += chunk.toString(); callback(); } });
  const resolution = await requestAttachmentMessageRecapture({
    next: async () => ({ value: JSON.stringify({ event: 'attachment-binding-resolution', plan: {
      vePath: [18, 0], dqcPath: [18, 0, 0], tupleLayout: 'observed_dqc_dh_context_null_mime',
    } }), done: false }),
  }, output, { attempt: 1, attachmentBinding: {} });
  assert.equal(resolution.kind, 'binding-resolution');
  assert.deepEqual(resolution.plan, { vePath: [18, 0], dqcPath: [18, 0, 0],
    tupleLayout: 'observed_dqc_dh_context_null_mime' });
  assert.equal(JSON.parse(outputText).event, 'attachment-binding-recapture-needed');
});

test('attachment prompt cannot reveal the expected file content', () => {
  const fileBody = Buffer.from('MIME47:OK!!!');
  assert.equal(assertPromptDoesNotContainFileContent('Read the file and return its exact contents.', fileBody), true);
  assert.throws(() => assertPromptDoesNotContainFileContent('Return MIME47:OK!!! exactly.', fileBody), {
    code: 'ATTACHMENT_CHAIN_PROMPT_CONTAINS_FILE_CONTENT',
  });
});

function sourceStructuredText(text) {
  return [[[
    [null, [null, 18, text]],
  ]]];
}

function sourceNestedRichStructuredText(text) {
  const file = [null, 1, 'source-file', null, [1, null, 'text/plain'], null, null, null, 1, null, null, 'text/plain'];
  const fileFields = [file, null, null, null, null, null, 'source-kind'];
  const sourceFields = Array(32).fill(null);
  sourceFields[31] = [[['source-label', 1], [[null, fileFields]], [text, 2]]];
  const root = Array(14).fill(null);
  root[13] = [[[null, [null, 18, text]], sourceFields]];
  return [[[root]]];
}

function sourceHistoryTurn({ prompt, turnId = 'turn-id-memory-only', draftId = 'draft-id-memory-only',
  plainText = 'plain candidate', structuredText = null, structuredRaw = null } = {}) {
  const turn = [];
  turn[0] = [null, turnId];
  turn[2] = [[prompt]];
  turn[3] = [];
  turn[3][0] = [[draftId, [plainText]]];
  if (structuredText !== null) turn[3][12] = sourceStructuredText(structuredText);
  if (structuredRaw !== null) turn[3][12] = structuredRaw;
  return turn;
}

test('history answer proof uses rendered structured text and compares metadata ID to turnId/draftId separately', () => {
  const prompt = 'Read the attached text file and reply with exactly its contents, with no quotes or extra text.';
  const answer = 'MIME48:OK!!!';
  const responseId = 'turn-id-memory-only';
  const payload = [[sourceHistoryTurn({ prompt, turnId: responseId, draftId: 'draft-id-is-distinct',
    plainText: 'not the visible answer', structuredText: answer })]];

  const result = inspectAttachmentTaskAssistantReply(payload, { prompt, expectedFileText: answer, responseId });

  assert.equal(result.promptPathCount, 1);
  assert.equal(result.taskTurnMatchCount, 1);
  assert.equal(result.assistantNodePresent, true);
  assert.equal(result.exactAnswerPathCount, 1);
  assert.equal(result.exactAnswerMatched, true);
  assert.equal(result.structuredContentPresent, true);
  assert.equal(result.structuredSourceShapeComplete, true);
  assert.equal(result.responseIdExactMatchKind, 'exactly_matches_turn_id_value');
  assert.equal(result.responseIdExactlyMatchedTurnId, true);
  assert.equal(result.responseIdExactlyMatchedDraftId, false);
  assert.deepEqual(result.assistantPath, [0, 0, 3, 12]);
  assert.equal(JSON.stringify(result).includes(answer), false);
  assert.equal(JSON.stringify(result).includes(responseId), false);
});

test('history answer proof reports the exact nested rich text path and ignores its source metadata duplicate', () => {
  const prompt = 'Read the attached text file and reply with exactly its contents, with no quotes or extra text.';
  const answer = 'MIME48:OK!!!';
  const responseId = 'turn-id-memory-only';
  const payload = [[sourceHistoryTurn({ prompt, turnId: responseId, draftId: 'draft-id-is-distinct',
    plainText: 'not the visible answer', structuredRaw: sourceNestedRichStructuredText(answer) })]];
  const result = inspectAttachmentTaskAssistantReply(payload, { prompt, expectedFileText: answer, responseId });
  assert.equal(result.exactAnswerPathCount, 1);
  assert.equal(result.exactAnswerMatched, true);
  assert.equal(result.structuredSourceShapeComplete, true);
  assert.deepEqual(result.exactAnswerPaths, [[0, 0, 3, 12, 0, 0, 0, 13, 0, 0, 1, 2]]);
  assert.equal(result.responseIdExactlyMatchedTurnId, true);
  assert.equal(JSON.stringify(result).includes(answer), false);
  assert.equal(JSON.stringify(result).includes(responseId), false);
});

test('direct reply diagnostics preserve decoded text identity and separate rendered normalization', () => {
  const expected = 'MIME49:OK!!!';
  const exact = summarizeAttachmentReplyText(expected, expected);
  assert.equal(exact.rawExactMatch, true);
  assert.equal(exact.normalizedMatch, true);
  assert.equal(exact.rawUtf8Bytes, 12);
  assert.deepEqual(exact.normalizedMatchVariants, ['raw', 'trim']);

  const rendered = summarizeAttachmentReplyText(`${expected}\n`, expected);
  assert.equal(rendered.rawExactMatch, false);
  assert.equal(rendered.normalizedMatch, true);
  assert.equal(rendered.rawUtf8Bytes, 13);
  assert.deepEqual(rendered.normalizedMatchVariants, ['trim']);
  assert.equal(Object.hasOwn(rendered, 'text'), false);
  assert.equal(JSON.stringify(rendered).includes(expected), false);
});

test('history answer proof does not accept file text found only outside the assistant node', () => {
  const prompt = 'Read the attached text file and reply with exactly its contents, with no quotes or extra text.';
  const answer = 'MIME48:OK!!!';
  const payload = [[sourceHistoryTurn({ prompt, plainText: 'I read the file.', structuredText: 'not the file' })]];
  payload.attachmentMetadata = { content: answer };

  const result = inspectAttachmentTaskAssistantReply(payload, { prompt, expectedFileText: answer });

  assert.equal(result.taskTurnMatchCount, 1);
  assert.equal(result.assistantNodePresent, true);
  assert.equal(result.exactAnswerPathCount, 0);
  assert.equal(result.exactAnswerMatched, false);
});

test('history answer diagnostics recognize only anchored wrappers without treating them as exact output', () => {
  const prompt = 'Read the attached text file and reply with exactly its contents, with no quotes or extra text.';
  const answer = 'MIME48:OK!!!';
  const turn = sourceHistoryTurn({ prompt, plainText: 'plain candidate',
    structuredText: `\`\`\`text\n${answer}\n\`\`\`` });

  const result = inspectAttachmentTaskAssistantReply([[turn]], { prompt, expectedFileText: answer });

  assert.equal(result.exactAnswerMatched, false);
  assert.equal(result.exactAnswerPathCount, 0);
  assert.equal(result.normalizedAnswerPaths.length, 1);
  assert.deepEqual(result.normalizedAnswerPaths[0].variants, ['anchored_fence']);
});

test('history answer diagnostics distinguish turnId from draftId and reject duplicate exact turns', () => {
  const prompt = 'Read the attached text file and reply with exactly its contents, with no quotes or extra text.';
  const answer = 'MIME48:OK!!!';
  const turnId = 'turn-id-memory-only';
  const draftId = 'draft-id-memory-only';
  const single = inspectAttachmentTaskAssistantReply([[sourceHistoryTurn({ prompt, turnId, draftId,
    plainText: 'plain candidate', structuredText: answer })]], {
    prompt, expectedFileText: answer, responseId: turnId,
  });
  assert.equal(single.responseIdExactlyMatchedTurnId, true);
  assert.equal(single.responseIdExactlyMatchedDraftId, false);
  assert.equal(single.responseIdExactMatchKind, 'exactly_matches_turn_id_value');

  const draftBinding = inspectAttachmentTaskAssistantReply([[sourceHistoryTurn({ prompt, turnId, draftId,
    plainText: 'plain candidate', structuredText: answer })]], {
    prompt, expectedFileText: answer, responseId: draftId,
  });
  assert.equal(draftBinding.exactAnswerMatched, true);
  assert.equal(draftBinding.responseIdExactlyMatchedTurnId, false);
  assert.equal(draftBinding.responseIdExactlyMatchedDraftId, true);
  assert.equal(draftBinding.responseIdExactMatchKind, 'exactly_matches_draft_id_value');

  const duplicate = inspectAttachmentTaskAssistantReply([[sourceHistoryTurn({ prompt, structuredText: answer }),
    sourceHistoryTurn({ prompt, structuredText: answer })]], {
    prompt, expectedFileText: answer,
  });
  assert.equal(duplicate.taskTurnMatchCount, 2);
  assert.equal(duplicate.assistantNodePresent, false);
  assert.equal(duplicate.exactAnswerMatched, false);
});

test('attachment chain requires the same-session final upload query size before text dispatch', () => {
  assert.equal(requireAttachmentUploadQueryReadback({ httpStatus: 200, uploadStatus: 'final', sizeReceived: 12 }, 12), true);
  assert.throws(() => requireAttachmentUploadQueryReadback({ httpStatus: 200, uploadStatus: 'final', sizeReceived: 11 }, 12), {
    code: 'ATTACHMENT_CHAIN_UPLOAD_QUERY_READBACK_REQUIRED',
  });
  assert.throws(() => requireAttachmentUploadQueryReadback({ httpStatus: 200, uploadStatus: 'active', sizeReceived: 12 }, 12), {
    code: 'ATTACHMENT_CHAIN_UPLOAD_QUERY_READBACK_REQUIRED',
  });
});

test('recaptures one SDK message in the same process using the same reference and unspent intent', async () => {
  let outputText = '';
  const output = new Writable({ write(chunk, _encoding, callback) { outputText += chunk.toString(); callback(); } });
  const reference = Object.freeze({ filename: 'file.txt', mimeType: 'text/plain', dh: 'same-upload-ref' });
  const firstCapture = { url: 'https://gemini.google.com/_/captured', method: 'POST', body: 'first-body', headers: { 'content-type': 'application/x-www-form-urlencoded' } };
  const secondBody = Buffer.from('recaptured-native-message');
  const secondLine = JSON.stringify({ event: 'attachment-message', capture: {
    url: 'https://gemini.google.com/_/captured', method: 'POST',
    bodyBase64: secondBody.toString('base64'), headers: { 'content-type': 'application/x-www-form-urlencoded' },
  } });
  const intent = { actor: 'owner@example.com', callerIntent: 'message-intent-v1' };
  const calls = [];
  const client = { async generateTextWithAttachmentOnce(capture, prompt, receivedReference, options) {
    calls.push({ capture, prompt, receivedReference, options });
    if (calls.length === 1) throw new GeminiClientError('TEXT_ATTACHMENT_CAPTURE_MISMATCH', 'mismatch', {
      attachmentBinding: { responsePayloadMatchCount: 1, filenameMatchCount: 1, mimeTypeMatchCount: 1,
        sourceProtoTupleMatchCount: 0, expectedResponsePayloadSha256: 'a'.repeat(64), rawDh: 'must-not-emit' },
    });
    return { attachmentBinding: { matched: true }, requestSent: true };
  } };
  let latestCapture = firstCapture;
  const result = await sendTextWithOneAttachmentMessageRecapture({
    client, capture: firstCapture, prompt: 'Read the attached file.', attachmentRef: reference, textOptions: intent,
    iterator: { next: async () => ({ value: secondLine, done: false }) }, output,
    onRecaptured: (capture) => { latestCapture = capture; },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].receivedReference, reference);
  assert.equal(calls[1].receivedReference, reference);
  assert.equal(calls[0].options, intent);
  assert.equal(calls[1].options, intent);
  assert.equal(latestCapture, result.capture);
  assert.equal(result.recaptureCount, 1);
  assert.equal(result.result.requestSent, true);
  assert.equal(firstCapture.body, '');
  assert.equal(JSON.parse(outputText).event, 'attachment-binding-recapture-needed');
  assert.equal(outputText.includes('must-not-emit'), false);
  assert.equal(outputText.includes('same-upload-ref'), false);
});

test('source path resolution sends the held first capture once with the same upload reference', async () => {
  let outputText = '';
  const output = new Writable({ write(chunk, _encoding, callback) { outputText += chunk.toString(); callback(); } });
  const reference = Object.freeze({ filename: 'shape.txt', mimeType: 'text/plain', dh: 'upload-ref-in-memory', fileSizeBytes: 12 });
  const inner = Array(99).fill(null);
  inner[0] = ['Read the attached file and return its contents.', 1];
  inner[18] = [[[reference.dh, 777, null, reference.mimeType], reference.filename]];
  const form = new URLSearchParams([['f.req', JSON.stringify([null, JSON.stringify(inner)])], ['at', 'token-memory-only']]);
  const capture = { url: 'https://gemini.google.com/_/captured', method: 'POST', body: form.toString(), headers: {
    'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
  } };
  const planLine = JSON.stringify({ event: 'attachment-binding-resolution', plan: {
    vePath: [18, 0], dqcPath: [18, 0, 0], tupleLayout: 'observed_dqc_dh_context_null_mime',
  } });
  const intent = { actor: 'owner@example.com', callerIntent: 'message-intent-v1' };
  const calls = [];
  const client = {
    async generateTextWithAttachmentOnce(receivedCapture, _prompt, receivedRef) {
      calls.push(['guarded', receivedCapture, receivedRef]);
      throw new GeminiClientError('TEXT_ATTACHMENT_CAPTURE_MISMATCH', 'needs source path', {
        attachmentBinding: { responsePayloadMatchCount: 1, filenameMatchCount: 1, mimeTypeMatchCount: 1 },
      });
    },
    async generateTextOnce(receivedCapture, _prompt, options) {
      calls.push(['direct', receivedCapture, options]);
      return { requestSent: true, directDispatchCount: 1 };
    },
  };
  const result = await sendTextWithOneAttachmentMessageRecapture({
    client, capture, prompt: inner[0][0], attachmentRef: reference, textOptions: intent,
    iterator: { next: async () => ({ value: planLine, done: false }) }, output,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0][2], reference);
  assert.equal(calls[1][1], capture);
  assert.equal(calls[1][2], intent);
  assert.equal(result.capture, capture);
  assert.equal(result.bindingResolutionCount, 1);
  assert.equal(result.result.requestSent, true);
  assert.equal(result.result.attachmentBinding.sourceLayout, 'observed_dqc_dh_context_null_mime');
  assert.equal(result.result.attachmentBinding.contextEqualsFileSize, false);
  assert.equal(outputText.includes(reference.dh), false);
});

test('attachment-chain rejects an unsupported first protocol line and still closes its readers cleanly', async () => {
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  await assert.rejects(runAttachmentChainOnce({
    confirmed: true,
    expectedOwner: 'owner@example.com',
    uploadCallerIntent: 'upload-intent-v1',
    messageCallerIntent: 'message-intent-v1',
    prompt: 'Read the attached text.',
  }, {
    input: Readable.from(['{}\n']),
    output,
    contract: await loadObservedContract(),
  }), { code: 'ATTACHMENT_UPLOAD_ENVELOPE_INVALID' });
});
