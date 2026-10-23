import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCoreOptions, parseHistoryReadOptions, parseLifecycleReadOptions, parseLifecycleMutationOptions,
  parsePublicShareReadOptions,
  parseModelChoiceOptions, parseTextOptions, parseTextActionOptions,
  parseAttachmentChainOptions,
} from '../src/cli.mjs';

test('history CLI defaults to metadata and supports explicit JSON business output', () => {
  const base = ['list', '--session-stdin', '--expect-owner', 'owner@example.com'];
  assert.deepEqual(parseCoreOptions(base), {
    sessionStdin: true,
    contractPath: new URL('../discovery/observed-contract.json', import.meta.url).pathname,
    expectedOwner: 'owner@example.com',
    output: 'metadata',
  });
  const json = parseCoreOptions([...base, '--output=json']);
  assert.equal(json.output, 'json');
});

test('text CLI requires a one-shot envelope, explicit owner, stable intent, and mutation confirmation', () => {
  const base = ['--envelope-stdin', '--expect-owner', 'owner@example.com', '--caller-intent', 'protocol-check-v1', '--confirm'];
  assert.deepEqual(parseTextOptions(base), {
    envelopeStdin: true,
    confirmed: true,
    contractPath: new URL('../discovery/observed-contract.json', import.meta.url).pathname,
    expectedOwner: 'owner@example.com',
    callerIntent: 'protocol-check-v1',
    modelChoiceId: undefined,
    thinkingChoiceId: undefined,
    output: 'metadata',
  });
  assert.throws(() => parseTextOptions(base.filter((value) => value !== '--confirm')), { code: 'MUTATION_CONFIRMATION_REQUIRED' });
  const selected = parseTextOptions([
    ...base, '--model-choice', 'model:e6fa609c3fa255c0', '--thinking-level', 'thinking:thinking-level-extended',
  ]);
  assert.equal(selected.modelChoiceId, 'model:e6fa609c3fa255c0');
  assert.equal(selected.thinkingChoiceId, 'thinking:thinking-level-extended');
  assert.throws(() => parseTextOptions([...base, '--thinking-level', 'thinking:thinking-level-extended']), {
    code: 'MODEL_CHOICE_INVALID',
  });
});

test('text-action CLI requires a guarded envelope, expected-owner hash, fresh intent, and confirmation', () => {
  const base = ['--envelope-stdin', '--expect-owner-sha256', 'a'.repeat(64),
    '--caller-intent', 'text-edit-action-v1', '--confirm'];
  assert.deepEqual(parseTextActionOptions(base), {
    envelopeStdin: true,
    confirmed: true,
    contractPath: new URL('../discovery/observed-contract.json', import.meta.url).pathname,
    expectedOwnerSha256: 'a'.repeat(64),
    callerIntent: 'text-edit-action-v1',
  });
  assert.throws(() => parseTextActionOptions(base.filter((value) => value !== '--confirm')),
    { code: 'MUTATION_CONFIRMATION_REQUIRED' });
  assert.throws(() => parseTextActionOptions(['--envelope-stdin', '--confirm', '--caller-intent', 'text-action-v1']),
    { code: 'OWNER_EXPECTATION_INVALID' });
  assert.throws(() => parseTextActionOptions([...base, '--expect-owner', 'owner@example.com']),
    { code: 'CLI_ARGUMENT_INVALID' });
});

test('history detail CLI accepts one envelope and an optional intent for independent reconciliation', () => {
  const base = ['--envelope-stdin', '--expect-owner', 'owner@example.com', '--caller-intent', 'protocol-check-v1'];
  assert.equal(parseHistoryReadOptions(base).callerIntent, 'protocol-check-v1');
  assert.equal(parseHistoryReadOptions(base).responseMarker, undefined);
  assert.equal(parseHistoryReadOptions([...base, '--output=json']).output, 'json');
  assert.equal(parseHistoryReadOptions([...base, '--response-marker', 'MODELSEL42']).responseMarker, 'MODELSEL42');
  assert.equal(parseHistoryReadOptions([...base, '--response-marker', '42']).responseMarker, '42');
  assert.throws(() => parseHistoryReadOptions([...base, '--response-marker', 'bad marker']), { code: 'CLI_ARGUMENT_INVALID' });
  assert.throws(() => parseHistoryReadOptions(['--expect-owner', 'owner@example.com']), { code: 'HISTORY_DETAIL_ENVELOPE_STDIN_REQUIRED' });
});

test('read-only lifecycle CLI requires a stdin envelope and explicit owner with metadata as the default', () => {
  const base = ['--envelope-stdin', '--expect-owner', 'owner@example.com'];
  assert.deepEqual(parseLifecycleReadOptions(base), {
    envelopeStdin: true,
    contractPath: new URL('../discovery/observed-contract.json', import.meta.url).pathname,
    expectedOwner: 'owner@example.com',
    output: 'metadata',
  });
  assert.equal(parseLifecycleReadOptions([...base, '--output=json']).output, 'json');
  assert.throws(() => parseLifecycleReadOptions(['--expect-owner', 'owner@example.com']), { code: 'LIFECYCLE_ENVELOPE_STDIN_REQUIRED' });
  assert.throws(() => parseLifecycleReadOptions([...base, '--output=content']), { code: 'CLI_ARGUMENT_INVALID' });
});

test('public shared-conversation CLI requires only a bounded stdin envelope and defaults to metadata', () => {
  const base = ['--envelope-stdin'];
  assert.deepEqual(parsePublicShareReadOptions(base), {
    envelopeStdin: true,
    contractPath: new URL('../discovery/observed-contract.json', import.meta.url).pathname,
    output: 'metadata',
  });
  assert.equal(parsePublicShareReadOptions([...base, '--output=json']).output, 'json');
  assert.throws(() => parsePublicShareReadOptions(['--output=json']), { code: 'PUBLIC_SHARE_READ_ENVELOPE_REQUIRED' });
});

test('lifecycle mutation CLI requires one envelope, an owner gate, and explicit confirmation', () => {
  const base = ['--envelope-stdin', '--expect-owner', 'owner@example.com', '--confirm'];
  assert.deepEqual(parseLifecycleMutationOptions(base), {
    envelopeStdin: true,
    confirmed: true,
    contractPath: new URL('../discovery/observed-contract.json', import.meta.url).pathname,
    expectedOwner: 'owner@example.com',
    output: 'metadata',
  });
  assert.equal(parseLifecycleMutationOptions([...base, '--output=link']).output, 'link');
  assert.throws(() => parseLifecycleMutationOptions(base.filter((value) => value !== '--confirm')),
    { code: 'LIFECYCLE_MUTATION_CONFIRMATION_REQUIRED' });
  assert.throws(() => parseLifecycleMutationOptions(base.filter((value) => value !== '--envelope-stdin')),
    { code: 'LIFECYCLE_MUTATION_ENVELOPE_REQUIRED' });
  assert.throws(() => parseLifecycleMutationOptions([...base, '--confirm']), { code: 'CLI_ARGUMENT_INVALID' });
});

test('model-choice CLI keeps selection local and separates model and thinking choice arguments', () => {
  const base = ['--envelope-stdin', '--expect-owner', 'owner@example.com'];
  assert.deepEqual(parseModelChoiceOptions(base), {
    envelopeStdin: true,
    contractPath: new URL('../discovery/observed-contract.json', import.meta.url).pathname,
    expectedOwner: 'owner@example.com',
    selectedChoiceId: undefined,
    thinkingChoiceId: undefined,
    output: 'metadata',
  });
  assert.equal(parseModelChoiceOptions([
    ...base, '--select', 'model:e6fa609c3fa255c0', '--thinking', 'thinking:thinking-level-extended', '--output=json',
  ]).thinkingChoiceId, 'thinking:thinking-level-extended');
  assert.throws(() => parseModelChoiceOptions([...base, '--thinking', 'thinking:thinking-level-extended']), { code: 'MODEL_CHOICE_INVALID' });
  assert.throws(() => parseModelChoiceOptions([...base, '--select', 'model:not-a-source-id']), { code: 'MODEL_CHOICE_INVALID' });
  assert.throws(() => parseModelChoiceOptions([...base, '--select', 'model:e6fa609c3fa255c0', '--select', 'model:56fdd199312815e2']), {
    code: 'CLI_ARGUMENT_INVALID',
  });
});

test('history CLI rejects unsupported output modes and requires an expected owner', () => {
  assert.throws(() => parseCoreOptions([
    'list', '--session-stdin', '--expect-owner', 'owner@example.com', '--output', 'xml',
  ]), { code: 'CLI_ARGUMENT_INVALID' });
  assert.throws(() => parseCoreOptions(['list', '--session-stdin']), { code: 'OWNER_EXPECTATION_REQUIRED' });
});

test('attachment-chain CLI requires separate upload and message intents plus one bounded prompt', () => {
  const args = ['--envelope-stdin', '--expect-owner', 'owner@example.com', '--caller-intent', 'upload-v1',
    '--message-intent', 'message-v1', '--prompt', 'Return the attached file text exactly.', '--confirm'];
  assert.deepEqual(parseAttachmentChainOptions(args), {
    envelopeStdin: true,
    confirmed: true,
    contractPath: new URL('../discovery/observed-contract.json', import.meta.url).pathname,
    expectedOwner: 'owner@example.com',
    uploadCallerIntent: 'upload-v1',
    messageCallerIntent: 'message-v1',
    prompt: 'Return the attached file text exactly.',
  });
  assert.throws(() => parseAttachmentChainOptions(args.filter((value) => value !== '--message-intent' && value !== 'message-v1')),
    { code: 'MUTATION_INTENT_INVALID' });
  assert.throws(() => parseAttachmentChainOptions(args.filter((value) => value !== '--confirm')),
    { code: 'MUTATION_CONFIRMATION_REQUIRED' });
  assert.throws(() => parseAttachmentChainOptions([...args, '--prompt', 'second prompt']), { code: 'CLI_ARGUMENT_INVALID' });
});
