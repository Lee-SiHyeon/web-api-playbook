import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { compareGeminiStreamResponseIdWithHistoryTurn, readGeminiHistoryTurnResponse,
  readGeminiRawStructuredContentTextCandidates, readGeminiStructuredContentTextCandidates } from '../src/history-turn-response.mjs';

const PROMPT = 'Read the provided text attachment and reply with its exact contents.';
const TURN_ID = 'turn-id-memory-only-01';
const DRAFT_ID = 'draft-id-memory-only-01';
const FILE_TEXT = 'ATTACH42:OK!';

function mappedTurn({ prompt = PROMPT, turnId = TURN_ID, draftId = DRAFT_ID, plainText = 'A plain candidate.', structuredText = FILE_TEXT } = {}) {
  const turn = [];
  turn[0] = [null, turnId];
  turn[2] = [[prompt]];
  turn[3] = [];
  turn[3][0] = [[draftId, [plainText]]];
  turn[3][12] = [[[
    [{ 39: ['code one', 'txt', 1, null, 2] }],
    [{ 39: ['code two', 'py', 1, null, 2] }],
    [null, [null, 18, structuredText]],
  ]]];
  return turn;
}

function sourceObservedNestedRichText(text) {
  const file = [null, 1, 'source-file', null, [1, null, 'text/plain'], null, null, null, 1, null, null, 'text/plain'];
  const fileFields = [file, null, null, null, null, null, 'source-kind'];
  const sourceFields = Array(32).fill(null);
  sourceFields[31] = [[['source-label', 1], [[null, fileFields]], [text, 2]]];
  const root = Array(14).fill(null);
  root[13] = [[[null, [null, 18, text]], sourceFields]];
  return [[[root]]];
}

test('reads source-mapped hNv turnId, draftId, plain candidate, and structured subtree separately', () => {
  const turn = mappedTurn();
  const payload = [[turn]];
  const result = readGeminiHistoryTurnResponse(payload, { prompt: PROMPT });

  assert.equal(result.matched, true);
  assert.equal(result.source, 'hNvQHb_runtime_mapped_turn');
  assert.deepEqual(result.turnPath, [0, 0]);
  assert.deepEqual(result.requestText, { present: true, utf8Bytes: Buffer.byteLength(PROMPT), sha256: digest(PROMPT) });
  assert.equal(result.turnId.present, true);
  assert.equal(result.draftId.present, true);
  assert.equal(result.turnId.sha256, digest(TURN_ID));
  assert.equal(result.draftId.sha256, digest(DRAFT_ID));
  assert.equal(result.plainTextCandidate.sha256, digest('A plain candidate.'));
  assert.equal(result.structuredContentPresent, true);
  assert.equal(result.structuredContentDecodeState, 'source_mapped_raw_subtree');
  assert.equal(result.structuredTextCandidateCount, 1);
  assert.equal(result.structuredSourceShapeComplete, true);
  assert.equal(result.internal.turnId, TURN_ID);
  assert.equal(result.internal.draftId, DRAFT_ID);
  assert.deepEqual(result.internal.structuredTextCandidates, [FILE_TEXT]);
  for (const privateValue of [PROMPT, TURN_ID, DRAFT_ID, FILE_TEXT, 'A plain candidate.']) {
    assert.equal(JSON.stringify(result).includes(privateValue), false);
  }
});

test('requires exactly one hNv turn for the exact prompt', () => {
  const duplicate = readGeminiHistoryTurnResponse([[mappedTurn()], [mappedTurn()]], { prompt: PROMPT });
  assert.equal(duplicate.matched, false);
  assert.equal(duplicate.reason, 'task_turn_ambiguous');
  assert.equal(duplicate.exactPromptTurnCount, 2);
  assert.equal(Object.hasOwn(duplicate, 'internal'), false);

  const missing = readGeminiHistoryTurnResponse([[mappedTurn({ prompt: 'other prompt' })]], { prompt: PROMPT });
  assert.equal(missing.matched, false);
  assert.equal(missing.reason, 'task_turn_missing');
});

test('compares StreamGenerate metadata ID against distinct hNv turnId and draftId values', () => {
  const readback = readGeminiHistoryTurnResponse([[mappedTurn()]], { prompt: PROMPT });
  const turn = compareGeminiStreamResponseIdWithHistoryTurn(TURN_ID, readback);
  assert.equal(turn.responseIdExactMatchKind, 'exactly_matches_turn_id_value');
  assert.equal(turn.responseIdExactlyMatchedTurnId, true);
  assert.equal(turn.responseIdExactlyMatchedDraftId, false);

  const draft = compareGeminiStreamResponseIdWithHistoryTurn(DRAFT_ID, readback);
  assert.equal(draft.responseIdExactMatchKind, 'exactly_matches_draft_id_value');
  assert.equal(draft.responseIdExactlyMatchedTurnId, false);
  assert.equal(draft.responseIdExactlyMatchedDraftId, true);

  const both = readGeminiHistoryTurnResponse([[mappedTurn({ turnId: TURN_ID, draftId: TURN_ID })]], { prompt: PROMPT });
  assert.equal(compareGeminiStreamResponseIdWithHistoryTurn(TURN_ID, both).responseIdExactMatchKind, 'exactly_matches_both_values');
  assert.equal(compareGeminiStreamResponseIdWithHistoryTurn('other-id', readback).responseIdExactMatchKind, 'no_exact_value_match');
  assert.equal(JSON.stringify(turn).includes(TURN_ID), false);
});

test('extracts only source-decoded structured child text and keeps values non-enumerable', () => {
  const result = readGeminiStructuredContentTextCandidates({ children: [
    { type: 'code', code: 'not the answer', language: 'text' },
    { text: FILE_TEXT },
    { text: 'another visible text child' },
    null,
  ] });
  assert.equal(result.matched, true);
  assert.deepEqual(result.candidates.map(({ childIndex, utf8Bytes }) => ({ childIndex, utf8Bytes })), [
    { childIndex: 1, utf8Bytes: Buffer.byteLength(FILE_TEXT) },
    { childIndex: 2, utf8Bytes: Buffer.byteLength('another visible text child') },
  ]);
  assert.equal(result.internal.values[1], FILE_TEXT);
  assert.equal(JSON.stringify(result).includes(FILE_TEXT), false);
});

test('maps raw hNv structured children through the observed code and text branches', () => {
  const raw = [[[
    [{ 39: ['code-memory-only', 'text', 1, null, 2] }],
    [{ 39: ['other-code-memory-only', 'txt', 1, null, 2] }],
    [null, [null, 18, FILE_TEXT]],
  ]]];
  const result = readGeminiRawStructuredContentTextCandidates(raw);
  assert.equal(result.matched, true);
  assert.equal(result.reason, 'source_observed_hnv_structured_content_shape');
  assert.equal(result.childrenCount, 3);
  assert.equal(result.codeChildCount, 2);
  assert.equal(result.textChildCount, 1);
  assert.equal(result.unclassifiedChildCount, 0);
  assert.equal(result.sourceShapeComplete, true);
  assert.deepEqual(result.candidates[0].path, [0, 0, 2, 1, 2]);
  assert.equal(result.candidates[0].sha256, digest(FILE_TEXT));
  assert.equal(result.internal.values[0], FILE_TEXT);
  assert.equal(JSON.stringify(result).includes(FILE_TEXT), false);
  assert.equal(JSON.stringify(result).includes('code-memory-only'), false);
});

test('maps the source-correlated nested rich text leaf and excludes its source-metadata duplicate', () => {
  const raw = sourceObservedNestedRichText(FILE_TEXT);
  const result = readGeminiRawStructuredContentTextCandidates(raw);
  assert.equal(result.matched, true);
  assert.equal(result.reason, 'source_observed_hnv_nested_rich_text_shape');
  assert.equal(result.childrenCount, 1);
  assert.equal(result.sourceMetadataBranchCount, 1);
  assert.equal(result.textChildCount, 1);
  assert.equal(result.unclassifiedChildCount, 0);
  assert.equal(result.sourceShapeComplete, true);
  assert.deepEqual(result.candidates[0].path, [0, 0, 0, 13, 0, 0, 1, 2]);
  assert.equal(result.candidates[0].sha256, digest(FILE_TEXT));
  assert.deepEqual(result.internal.values, [FILE_TEXT]);
  assert.equal(JSON.stringify(result).includes(FILE_TEXT), false);
});

test('fails closed for unknown siblings or malformed source metadata in the nested rich shape', () => {
  const unknownSibling = sourceObservedNestedRichText(FILE_TEXT);
  unknownSibling[0][0][0][12] = 'unclassified';
  const siblingResult = readGeminiRawStructuredContentTextCandidates(unknownSibling);
  assert.equal(siblingResult.textChildCount, 0);
  assert.equal(siblingResult.sourceShapeComplete, false);
  assert.deepEqual(siblingResult.internal.values, []);

  const malformedMetadata = sourceObservedNestedRichText(FILE_TEXT);
  malformedMetadata[0][0][0][13][0][1][30] = 'unclassified';
  const metadataResult = readGeminiRawStructuredContentTextCandidates(malformedMetadata);
  assert.equal(metadataResult.textChildCount, 0);
  assert.equal(metadataResult.sourceShapeComplete, false);
  assert.deepEqual(metadataResult.internal.values, []);
});

test('does not classify an unknown structured child as rendered text', () => {
  const result = readGeminiRawStructuredContentTextCandidates([[[['unknown-branch']]]]);
  assert.equal(result.matched, true);
  assert.equal(result.textChildCount, 0);
  assert.equal(result.unclassifiedChildCount, 1);
  assert.equal(result.sourceShapeComplete, false);
  assert.deepEqual(result.internal.values, []);
});

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
