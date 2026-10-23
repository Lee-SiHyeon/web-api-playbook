import { createHash } from 'node:crypto';
import { writeSync } from 'node:fs';
import path from 'node:path';
import { loadObservedContract, DEFAULT_CONTRACT_PATH } from './contract.mjs';
import { CREDENTIAL_NAME, CAPABILITIES, OPERATION_NAMES, SERVICE_ID, SERVICE_ORIGIN } from './constants.mjs';
import { currentEvidenceMatrix } from './evidence.mjs';
import { GeminiClientError } from './errors.mjs';
import { credentialExists, credentialStoreReady } from './secure-credential-store.mjs';
import {
  readSessionBundleFromStdin, readTextMutationEnvelopeFromStdin, readHistoryDetailEnvelopeFromStdin,
  readLifecycleReadEnvelopeFromStdin, readAnonymousShareReadEnvelopeFromStdin, readMediaMutationEnvelopeFromStdin,
  readTaskMediaDownloadEnvelopeFromStdin,
  readAttachmentUploadEnvelopeFromStdin,
  readSessionRenewalEnvelopeFromStdin,
  validateSessionBundle,
  readSettingsUpdateEnvelopeFromStdin,
} from './session.mjs';
import { GeminiWebClient } from './client.mjs';
import { runLifecycleMutation } from '../scripts/gemini-lifecycle-mutation-once.mjs';
import {
  extractConversationSummaries, publicShareConversationRowCount, publicShareConversationRowHasId,
} from './conversation-lifecycle.mjs';
import { reconcileLifecycleMutation } from './lifecycle-mutation.mjs';
import { findCreatedShareUrl, shareIdFromCreatedUrl } from './share-link.mjs';
import { runAttachmentChainOnce } from './attachment-chain.mjs';
import { findUnresolvedMutation, markMutationReconciled, mutationIntentDigest } from './journal.mjs';
import { parseCapturedTextResponse, parseRequestOnlyTextResponse } from './text-response.mjs';
import { selectTextReadbackConversation } from './text-readback.mjs';
import { clearTextActionEnvelope, readTextActionEnvelopeFromStdin, submitGeminiTextActionOnce } from './text-lifecycle.mjs';
import { pathToFileURL } from 'node:url';
import { stdin, stdout } from 'node:process';

function usage() {
  return [
    'Gemini web direct HTTP client scaffold',
    'Commands:',
    '  status                 Show contract and protected-provider readiness booleans.',
    '  evidence               Show text/history/image/video evidence states.',
    '  public-status [--transport node|chrome --python /absolute/python]  Read anonymous app-shell metadata only.',
    '  identity --session-stdin --expect-owner <email>  Verify the protected /app principal by direct HTTP.',
    '  history list --session-stdin --expect-owner <email> [--output metadata|json]  Read conversations by direct HTTP.',
    '  history search --envelope-stdin --expect-owner <email> [--output metadata|json]  Search conversations with the captured remote search RPC.',
    '  history read --envelope-stdin --expect-owner <email> [--caller-intent <id> --response-marker <marker>]  Read one conversation detail by direct HTTP.',
    '  models --envelope-stdin --expect-owner <email> [--output metadata|json]  Read the authenticated model status and list.',
    '  model-choice --envelope-stdin --expect-owner <email> [--select model:<id> [--thinking thinking:<level>]]  Read choices and select request metadata in process memory.',
    '  session-renew --envelope-stdin --expect-owner <email>  Verify and atomically install a normally acquired same-owner session; never replays a mutation.',
    '  settings --envelope-stdin --expect-owner <email> [--output metadata|json]  Read only the captured allowlisted preferences.',
    '  settings-read-one --envelope-stdin --expect-owner <email>  Read only side_nav_open_by_default with selector 41 over direct HTTP.',
    '  settings-update --envelope-stdin --expect-owner <email> --caller-intent <id> --confirm  Update one source-verified non-privacy display preference after a direct baseline read.',
    '  settings-update-test --envelope-stdin --expect-owner <email> --caller-intent <id> --confirm  Optionally require a supplied baseline, flip once, and restore it after direct readback.',
    '  public-links --envelope-stdin --expect-owner <email>  Read the signed-in owner’s public-share link inventory as safe metadata.',
    '  public-share-read --envelope-stdin [--output metadata|json]  Read one public shared conversation over HTTP with cookies and authorization omitted.',
    '  lifecycle-mutation --envelope-stdin --confirm [--expect-owner <email>]  Run one confirmed, owner-bound, no-retry rename, delete, share-create, or share-revoke mutation with readback.',
    '       Delete/share-revoke use installed request-only contracts; rename/share-create need captured request and argument values in the bounded stdin envelope.',
    '  text  Requires --envelope-stdin, --expect-owner, --caller-intent, and --confirm.',
    '       Optional --model-choice model:<id> and --thinking-level thinking:<level> bind the selected local model to captured request metadata.',
    '  text-action  Replays one guarded captured edit, regenerate, or continuation request, then reads the exact hNvQHb task back.',
    '  image|video  Require a current browser request envelope, expected owner, stable intent, and --confirm.',
    '  media-download  Requires an exact task media URL, native GET evidence, scoped cookies, and an output path on stdin.',
    '  task-media-download  Reads hNvQHb task detail, binds the exact prompt and API ID, then downloads through the observed asset contract and current session.',
    '  original-image-download --envelope-stdin --expect-owner <email>  Replays a source-prepared c8o8Fe original-size request and reads the exact task image back over HTTP.',
    '  attachment-upload --envelope-stdin --expect-owner <email> --caller-intent <id> --confirm  Uploads one captured file through the observed resumable contract.',
    '  attachment-chain --envelope-stdin --expect-owner <email> --caller-intent <upload-id> --message-intent <text-id> --prompt <text> --confirm  Uploads once, binds a normal SDK attachment capture, sends one direct text request, and reads it back.',
    '  help                   Show this message.',
  ].join('\n');
}

export function parsePublicStatusOptions(args) {
  let transport = 'node';
  let pythonPath;
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (option === '--transport' && i + 1 < args.length) {
      transport = args[++i];
      continue;
    }
    if (option === '--python' && i + 1 < args.length) {
      pythonPath = args[++i];
      continue;
    }
    throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'Unsupported public-status option.');
  }
  if (!['node', 'chrome'].includes(transport)) {
    throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'Unsupported public-status transport.');
  }
  if (transport === 'chrome' && (!pythonPath || !pythonPath.startsWith('/'))) {
    throw new GeminiClientError('PUBLIC_DOCUMENT_PYTHON_PATH_INVALID', 'Chrome-compatible transport requires an absolute Python executable path.');
  }
  if (transport === 'node' && pythonPath !== undefined) {
    throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The Python executable option is only valid with the chrome transport.');
  }
  return { transport, pythonPath };
}

async function safeStatus() {
  let contract = null;
  let contractState = 'CONTRACT_NOT_CAPTURED';
  try {
    contract = await loadObservedContract(process.argv[3] || DEFAULT_CONTRACT_PATH);
    contractState = 'captured_contract_installed';
  } catch (error) {
    if (!(error instanceof GeminiClientError)) throw error;
    contractState = error.code;
  }
  const windowsProvider = process.platform === 'win32';
  const providerReady = windowsProvider ? credentialStoreReady() : true;
  let credentialPresent = false;
  let credentialStoreCheckPassed = false;
  let credentialStoreError = null;
  if (windowsProvider && providerReady) {
    try {
      credentialPresent = credentialExists(CREDENTIAL_NAME);
      credentialStoreCheckPassed = true;
    } catch (error) {
      credentialPresent = false;
      const safeStoreErrors = new Set([
        'CREDENTIAL_STORE_TIMEOUT',
        'CREDENTIAL_STORE_UNAVAILABLE',
        'CREDENTIAL_STORE_UNREADABLE',
        'CREDENTIAL_STORE_FAILED',
      ]);
      credentialStoreError = safeStoreErrors.has(error?.code) ? error.code : 'CREDENTIAL_STORE_FAILED';
    }
  }
  return {
    service: SERVICE_ID,
    origin: SERVICE_ORIGIN,
    contract: contractState,
    credentialProvider: windowsProvider ? 'Windows DPAPI CurrentUser or one-shot stdin' : 'one-shot stdin session injection',
    credentialProviderReady: providerReady,
    sessionInjectionSupported: true,
    credentialStoreCheckPassed,
    credentialStoreError,
    protectedCredentialPresent: windowsProvider && credentialPresent,
    operationContracts: Object.fromEntries(OPERATION_NAMES.map((name) => [name, contract?.operations?.[name]?.observation?.requestResponse === true])),
    operationRequestCaptures: Object.fromEntries(OPERATION_NAMES.map((name) => [name, contract?.operations?.[name]?.observation?.request === true
      || contract?.operations?.[name]?.observation?.requestResponse === true])),
    liveReplay: false,
  };
}

export function parseCoreOptions(args) {
  let sessionStdin = false;
  let contractPath = DEFAULT_CONTRACT_PATH;
  let expectedOwner;
  let output = 'metadata';
  let positional = 0;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--session-stdin') {
      if (sessionStdin) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The one-shot session option was repeated.');
      sessionStdin = true;
      continue;
    }
    if (option === '--expect-owner' && index + 1 < args.length) {
      if (expectedOwner !== undefined) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The expected-owner option was repeated.');
      expectedOwner = args[++index];
      continue;
    }
    if (option === '--output' && index + 1 < args.length) {
      output = args[++index];
      continue;
    }
    if (option.startsWith('--output=')) {
      output = option.slice('--output='.length);
      continue;
    }
    if (option.startsWith('--')) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'An unsupported operation option was supplied.');
    if (positional === 0 && option.endsWith('.json')) {
      contractPath = option;
      positional += 1;
      continue;
    }
    if (positional === 0 && option === 'list') {
      positional += 1;
      continue;
    }
    throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'An unsupported operation argument was supplied.');
  }
  if (!sessionStdin) throw new GeminiClientError('SESSION_STDIN_REQUIRED', 'Use --session-stdin to supply the current Linux browser session in memory.');
  if (!expectedOwner) throw new GeminiClientError('OWNER_EXPECTATION_REQUIRED', 'A direct Gemini operation requires --expect-owner.');
  if (!['metadata', 'json', 'content'].includes(output)) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'Output must be metadata, json, or content.');
  return { sessionStdin, contractPath, expectedOwner, output };
}

export function parseTextOptions(args) {
  let envelopeStdin = false;
  let confirmed = false;
  let contractPath = DEFAULT_CONTRACT_PATH;
  let expectedOwner;
  let callerIntent;
  let modelChoiceId;
  let thinkingChoiceId;
  let output = 'metadata';
  let positional = 0;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--envelope-stdin') {
      if (envelopeStdin) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The text envelope option was repeated.');
      envelopeStdin = true;
      continue;
    }
    if (option === '--confirm') {
      if (confirmed) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The text confirmation option was repeated.');
      confirmed = true;
      continue;
    }
    if (option === '--expect-owner' && index + 1 < args.length) {
      if (expectedOwner !== undefined) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The expected-owner option was repeated.');
      expectedOwner = args[++index];
      continue;
    }
    if (option === '--caller-intent' && index + 1 < args.length) {
      if (callerIntent !== undefined) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The caller-intent option was repeated.');
      callerIntent = args[++index];
      continue;
    }
    if (option === '--model-choice' && index + 1 < args.length) {
      if (modelChoiceId !== undefined) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The model-choice option was repeated.');
      modelChoiceId = args[++index];
      continue;
    }
    if (option === '--thinking-level' && index + 1 < args.length) {
      if (thinkingChoiceId !== undefined) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The thinking-level option was repeated.');
      thinkingChoiceId = args[++index];
      continue;
    }
    if (option === '--output' && index + 1 < args.length) {
      output = args[++index];
      continue;
    }
    if (option.startsWith('--output=')) {
      output = option.slice('--output='.length);
      continue;
    }
    if (option.startsWith('--')) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'An unsupported text option was supplied.');
    if (positional === 0 && option.endsWith('.json')) {
      contractPath = option;
      positional += 1;
      continue;
    }
    throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'An unsupported text argument was supplied.');
  }
  if (!envelopeStdin) throw new GeminiClientError('TEXT_ENVELOPE_STDIN_REQUIRED', 'Use --envelope-stdin to supply a one-shot session and captured request template.');
  if (!confirmed) throw new GeminiClientError('MUTATION_CONFIRMATION_REQUIRED', 'A direct text request requires --confirm.');
  if (!expectedOwner) throw new GeminiClientError('OWNER_EXPECTATION_REQUIRED', 'A direct Gemini text request requires --expect-owner.');
  if (typeof callerIntent !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(callerIntent)) {
    throw new GeminiClientError('MUTATION_INTENT_INVALID', 'A stable caller intent is required for a direct text request.');
  }
  if (modelChoiceId !== undefined && !/^model:[0-9a-f]{16}$/.test(modelChoiceId)) {
    throw new GeminiClientError('MODEL_CHOICE_INVALID', 'A current catalog-backed model choice ID is required.');
  }
  if (thinkingChoiceId !== undefined && (!modelChoiceId || !/^thinking:[a-z0-9-]{1,64}$/.test(thinkingChoiceId))) {
    throw new GeminiClientError('MODEL_CHOICE_INVALID', 'A thinking-level choice requires a model choice in this process.');
  }
  if (!['metadata', 'json', 'content'].includes(output)) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'Output must be metadata, json, or content.');
  return { envelopeStdin, confirmed, contractPath, expectedOwner, callerIntent, modelChoiceId, thinkingChoiceId, output };
}

export function parseTextActionOptions(args) {
  let envelopeStdin = false;
  let confirmed = false;
  let contractPath = DEFAULT_CONTRACT_PATH;
  let expectedOwnerSha256;
  let callerIntent;
  let positional = 0;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--envelope-stdin') {
      if (envelopeStdin) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The text-action envelope option was repeated.');
      envelopeStdin = true;
      continue;
    }
    if (option === '--confirm') {
      if (confirmed) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The text-action confirmation option was repeated.');
      confirmed = true;
      continue;
    }
    if (option === '--expect-owner-sha256' && index + 1 < args.length) {
      if (expectedOwnerSha256 !== undefined) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The text-action owner hash option was repeated.');
      expectedOwnerSha256 = args[++index];
      continue;
    }
    if (option === '--caller-intent' && index + 1 < args.length) {
      if (callerIntent !== undefined) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The text-action caller intent option was repeated.');
      callerIntent = args[++index];
      continue;
    }
    if (option.startsWith('--')) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'An unsupported text-action option was supplied.');
    if (positional === 0 && option.endsWith('.json')) {
      contractPath = option;
      positional += 1;
      continue;
    }
    throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'An unsupported text-action argument was supplied.');
  }
  if (!envelopeStdin) throw new GeminiClientError('TEXT_ACTION_ENVELOPE_STDIN_REQUIRED', 'Use --envelope-stdin to supply the guarded native action capture.');
  if (!confirmed) throw new GeminiClientError('MUTATION_CONFIRMATION_REQUIRED', 'A direct text action requires --confirm.');
  if (!/^[a-f0-9]{64}$/.test(expectedOwnerSha256 ?? '')) {
    throw new GeminiClientError('OWNER_EXPECTATION_INVALID', 'A normalized expected-owner SHA-256 is required.');
  }
  if (typeof callerIntent !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(callerIntent)) {
    throw new GeminiClientError('MUTATION_INTENT_INVALID', 'A fresh stable caller intent is required for a text action.');
  }
  return { envelopeStdin, confirmed, contractPath, expectedOwnerSha256, callerIntent };
}

export function parseHistoryReadOptions(args) {
  let envelopeStdin = false;
  let contractPath = DEFAULT_CONTRACT_PATH;
  let expectedOwner;
  let callerIntent;
  let responseMarker;
  let output = 'metadata';
  let positional = 0;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--envelope-stdin') {
      if (envelopeStdin) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The history detail envelope option was repeated.');
      envelopeStdin = true;
      continue;
    }
    if (option === '--expect-owner' && index + 1 < args.length) {
      if (expectedOwner !== undefined) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The expected-owner option was repeated.');
      expectedOwner = args[++index];
      continue;
    }
    if (option === '--caller-intent' && index + 1 < args.length) {
      if (callerIntent !== undefined) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The caller-intent option was repeated.');
      callerIntent = args[++index];
      continue;
    }
    if (option === '--response-marker' && index + 1 < args.length) {
      if (responseMarker !== undefined) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The response-marker option was repeated.');
      responseMarker = args[++index];
      continue;
    }
    if (option === '--output' && index + 1 < args.length) {
      output = args[++index];
      continue;
    }
    if (option.startsWith('--output=')) {
      output = option.slice('--output='.length);
      continue;
    }
    if (option.startsWith('--')) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'An unsupported history detail option was supplied.');
    if (positional === 0 && option.endsWith('.json')) {
      contractPath = option;
      positional += 1;
      continue;
    }
    throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'An unsupported history detail argument was supplied.');
  }
  if (!envelopeStdin) throw new GeminiClientError('HISTORY_DETAIL_ENVELOPE_STDIN_REQUIRED', 'Use --envelope-stdin to supply one conversation detail read.');
  if (!expectedOwner) throw new GeminiClientError('OWNER_EXPECTATION_REQUIRED', 'A direct Gemini operation requires --expect-owner.');
  if (callerIntent !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(callerIntent)) {
    throw new GeminiClientError('MUTATION_INTENT_INVALID', 'A stable caller intent is required to reconcile a text request.');
  }
  if (responseMarker !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(responseMarker)) {
    throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The response marker must be a short alphanumeric label.');
  }
  if (!['metadata', 'json'].includes(output)) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'History detail output must be metadata or json.');
  return { envelopeStdin, contractPath, expectedOwner, callerIntent, responseMarker, output };
}

export function parseLifecycleReadOptions(args) {
  let envelopeStdin = false;
  let contractPath = DEFAULT_CONTRACT_PATH;
  let expectedOwner;
  let output = 'metadata';
  let positional = 0;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--envelope-stdin') {
      if (envelopeStdin) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The lifecycle envelope option was repeated.');
      envelopeStdin = true;
      continue;
    }
    if (option === '--expect-owner' && index + 1 < args.length) {
      if (expectedOwner !== undefined) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The expected-owner option was repeated.');
      expectedOwner = args[++index];
      continue;
    }
    if (option === '--output' && index + 1 < args.length) {
      output = args[++index];
      continue;
    }
    if (option.startsWith('--output=')) {
      output = option.slice('--output='.length);
      continue;
    }
    if (option.startsWith('--')) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'An unsupported lifecycle read option was supplied.');
    if (positional === 0 && option.endsWith('.json')) {
      contractPath = option;
      positional += 1;
      continue;
    }
    throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'An unsupported lifecycle read argument was supplied.');
  }
  if (!envelopeStdin) throw new GeminiClientError('LIFECYCLE_ENVELOPE_STDIN_REQUIRED', 'Use --envelope-stdin to supply the current session and bounded read input.');
  if (!expectedOwner) throw new GeminiClientError('OWNER_EXPECTATION_REQUIRED', 'A direct Gemini read requires --expect-owner.');
  if (!['metadata', 'json'].includes(output)) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'Lifecycle reads support only metadata or JSON output.');
  return { envelopeStdin, contractPath, expectedOwner, output };
}

export function parsePublicShareReadOptions(args) {
  let envelopeStdin = false;
  let contractPath = DEFAULT_CONTRACT_PATH;
  let output = 'metadata';
  let positional = 0;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--envelope-stdin') {
      if (envelopeStdin) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The public-share envelope option was repeated.');
      envelopeStdin = true;
      continue;
    }
    if (option === '--output' && index + 1 < args.length) {
      output = args[++index];
      continue;
    }
    if (option.startsWith('--output=')) {
      output = option.slice('--output='.length);
      continue;
    }
    if (option.startsWith('--')) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'An unsupported public-share read option was supplied.');
    if (positional === 0 && option.endsWith('.json')) {
      contractPath = option;
      positional += 1;
      continue;
    }
    throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'An unsupported public-share read argument was supplied.');
  }
  if (!envelopeStdin) throw new GeminiClientError('PUBLIC_SHARE_READ_ENVELOPE_REQUIRED', 'Use --envelope-stdin to supply the bounded share ID and fresh session context.');
  if (!['metadata', 'json'].includes(output)) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'Public-share reads support only metadata or JSON output.');
  return { envelopeStdin, contractPath, output };
}

export function parseLifecycleMutationOptions(args) {
  let envelopeStdin = false;
  let confirmed = false;
  let contractPath = DEFAULT_CONTRACT_PATH;
  let expectedOwner;
  let output = 'metadata';
  let positional = 0;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--envelope-stdin') {
      if (envelopeStdin) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The mutation envelope option was repeated.');
      envelopeStdin = true;
      continue;
    }
    if (option === '--confirm') {
      if (confirmed) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The mutation confirmation option was repeated.');
      confirmed = true;
      continue;
    }
    if (option === '--expect-owner' && index + 1 < args.length) {
      if (expectedOwner !== undefined) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The expected-owner option was repeated.');
      expectedOwner = args[++index];
      continue;
    }
    if (option === '--output' && index + 1 < args.length) {
      output = args[++index];
      continue;
    }
    if (option.startsWith('--output=')) {
      output = option.slice('--output='.length);
      continue;
    }
    if (option.startsWith('--')) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'An unsupported lifecycle mutation option was supplied.');
    if (positional === 0 && option.endsWith('.json')) {
      contractPath = option;
      positional += 1;
      continue;
    }
    throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'An unsupported lifecycle mutation argument was supplied.');
  }
  if (!envelopeStdin) throw new GeminiClientError('LIFECYCLE_MUTATION_ENVELOPE_REQUIRED', 'Use --envelope-stdin for one captured lifecycle mutation.');
  if (!confirmed) throw new GeminiClientError('LIFECYCLE_MUTATION_CONFIRMATION_REQUIRED', 'Use --confirm to dispatch the one-shot lifecycle mutation.');
  if (expectedOwner !== undefined && (typeof expectedOwner !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(expectedOwner))) {
    throw new GeminiClientError('OWNER_EXPECTATION_INVALID', 'The expected-owner option is invalid.');
  }
  if (!['metadata', 'link'].includes(output)) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'Lifecycle mutations support metadata or explicit share-link output.');
  return { envelopeStdin, confirmed, contractPath, expectedOwner, output };
}

export function parseSettingsUpdateOptions(args, { action = 'settings-update' } = {}) {
  if (!['settings-read-one', 'settings-update', 'settings-update-test'].includes(action)) {
    throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The settings update action is unsupported.');
  }
  let envelopeStdin = false;
  let confirmed = false;
  let contractPath = DEFAULT_CONTRACT_PATH;
  let expectedOwner;
  let callerIntent;
  let positional = 0;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--envelope-stdin') {
      if (envelopeStdin) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The settings envelope option was repeated.');
      envelopeStdin = true;
      continue;
    }
    if (option === '--confirm') {
      if (confirmed) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The settings confirmation option was repeated.');
      confirmed = true;
      continue;
    }
    if (option === '--expect-owner' && index + 1 < args.length) {
      if (expectedOwner !== undefined) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The expected-owner option was repeated.');
      expectedOwner = args[++index];
      continue;
    }
    if (option === '--caller-intent' && index + 1 < args.length) {
      if (callerIntent !== undefined) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The caller-intent option was repeated.');
      callerIntent = args[++index];
      continue;
    }
    if (option.startsWith('--')) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'An unsupported settings update option was supplied.');
    if (positional === 0 && option.endsWith('.json')) {
      contractPath = option;
      positional += 1;
      continue;
    }
    throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'An unsupported settings update argument was supplied.');
  }
  if (!envelopeStdin) throw new GeminiClientError('SETTINGS_UPDATE_ENVELOPE_STDIN_REQUIRED', 'Use --envelope-stdin to supply the current session and setting input.');
  const writeAction = action !== 'settings-read-one';
  if (writeAction && !confirmed) throw new GeminiClientError('SETTINGS_UPDATE_CONFIRMATION_REQUIRED', 'Use --confirm for the one-shot setting update.');
  if (typeof expectedOwner !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(expectedOwner)) {
    throw new GeminiClientError('OWNER_EXPECTATION_REQUIRED', 'A direct Gemini settings update requires --expect-owner.');
  }
  if (writeAction && (typeof callerIntent !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(callerIntent))) {
    throw new GeminiClientError('MUTATION_INTENT_INVALID', 'A stable caller intent is required for the settings update.');
  }
  return { action, envelopeStdin, confirmed, contractPath, expectedOwner, callerIntent };
}

export function parseModelChoiceOptions(args) {
  let envelopeStdin = false;
  let contractPath = DEFAULT_CONTRACT_PATH;
  let expectedOwner;
  let selectedChoiceId;
  let thinkingChoiceId;
  let output = 'metadata';
  let outputSeen = false;
  let positional = 0;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--envelope-stdin') {
      if (envelopeStdin) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The model-choice envelope option was repeated.');
      envelopeStdin = true;
      continue;
    }
    if (option === '--expect-owner' && index + 1 < args.length) {
      if (expectedOwner !== undefined) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The expected-owner option was repeated.');
      expectedOwner = args[++index];
      continue;
    }
    if (option === '--select' && index + 1 < args.length) {
      if (selectedChoiceId !== undefined) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The model selection option was repeated.');
      selectedChoiceId = args[++index];
      continue;
    }
    if (option === '--thinking' && index + 1 < args.length) {
      if (thinkingChoiceId !== undefined) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The thinking-level option was repeated.');
      thinkingChoiceId = args[++index];
      continue;
    }
    if (option === '--output' && index + 1 < args.length) {
      if (outputSeen) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The output option was repeated.');
      outputSeen = true;
      output = args[++index];
      continue;
    }
    if (option.startsWith('--output=')) {
      if (outputSeen) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The output option was repeated.');
      outputSeen = true;
      output = option.slice('--output='.length);
      continue;
    }
    if (option.startsWith('--')) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'An unsupported model-choice option was supplied.');
    if (positional === 0 && option.endsWith('.json')) {
      contractPath = option;
      positional += 1;
      continue;
    }
    throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'An unsupported model-choice argument was supplied.');
  }
  if (!envelopeStdin) throw new GeminiClientError('LIFECYCLE_ENVELOPE_STDIN_REQUIRED', 'Use --envelope-stdin to supply the current session.');
  if (!expectedOwner) throw new GeminiClientError('OWNER_EXPECTATION_REQUIRED', 'A direct Gemini read requires --expect-owner.');
  if (selectedChoiceId !== undefined && !/^model:[0-9a-f]{16}$/.test(selectedChoiceId)) {
    throw new GeminiClientError('MODEL_CHOICE_INVALID', 'Select a current catalog-backed model choice ID.');
  }
  if (thinkingChoiceId !== undefined && (!selectedChoiceId || !/^thinking:[a-z0-9-]{1,64}$/.test(thinkingChoiceId))) {
    throw new GeminiClientError('MODEL_CHOICE_INVALID', 'A thinking-level choice requires a model selection in the same process.');
  }
  if (!['metadata', 'json'].includes(output)) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'Model-choice output must be metadata or JSON.');
  return { envelopeStdin, contractPath, expectedOwner, selectedChoiceId, thinkingChoiceId, output };
}

export function parseMediaOptions(args) {
  let envelopeStdin = false;
  let confirmed = false;
  let contractPath = DEFAULT_CONTRACT_PATH;
  let expectedOwner;
  let callerIntent;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--envelope-stdin') {
      if (envelopeStdin) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The media envelope option was repeated.');
      envelopeStdin = true;
      continue;
    }
    if (option === '--confirm') {
      if (confirmed) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The media confirmation option was repeated.');
      confirmed = true;
      continue;
    }
    if (option === '--expect-owner' && index + 1 < args.length) {
      if (expectedOwner !== undefined) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The expected-owner option was repeated.');
      expectedOwner = args[++index];
      continue;
    }
    if (option === '--caller-intent' && index + 1 < args.length) {
      if (callerIntent !== undefined) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The caller-intent option was repeated.');
      callerIntent = args[++index];
      continue;
    }
    if (option.startsWith('--')) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'An unsupported media option was supplied.');
    if (option.endsWith('.json') && contractPath === DEFAULT_CONTRACT_PATH) {
      contractPath = option;
      continue;
    }
    throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'An unsupported media argument was supplied.');
  }
  if (!envelopeStdin) throw new GeminiClientError('MEDIA_ENVELOPE_STDIN_REQUIRED', 'Use --envelope-stdin to supply a current browser request capture.');
  if (!confirmed) throw new GeminiClientError('MUTATION_CONFIRMATION_REQUIRED', 'A direct image request requires --confirm.');
  if (!expectedOwner) throw new GeminiClientError('OWNER_EXPECTATION_REQUIRED', 'A direct Gemini media request requires --expect-owner.');
  if (typeof callerIntent !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(callerIntent)) {
    throw new GeminiClientError('MUTATION_INTENT_INVALID', 'A stable caller intent is required for a direct media request.');
  }
  return { envelopeStdin, confirmed, contractPath, expectedOwner, callerIntent };
}

export function parseMediaDownloadOptions(args) {
  let envelopeStdin = false;
  let contractPath = DEFAULT_CONTRACT_PATH;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--envelope-stdin') {
      if (envelopeStdin) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The media download envelope option was repeated.');
      envelopeStdin = true;
      continue;
    }
    if (option.startsWith('--')) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'An unsupported media download option was supplied.');
    if (option.endsWith('.json') && contractPath === DEFAULT_CONTRACT_PATH) {
      contractPath = option;
      continue;
    }
    throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'An unsupported media download argument was supplied.');
  }
  if (!envelopeStdin) throw new GeminiClientError('MEDIA_DOWNLOAD_ENVELOPE_STDIN_REQUIRED', 'Use --envelope-stdin to supply task-bound media URL and native GET evidence.');
  return { envelopeStdin, contractPath };
}

export function parseTaskMediaDownloadOptions(args) {
  let envelopeStdin = false;
  let contractPath = DEFAULT_CONTRACT_PATH;
  let expectedOwner;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--envelope-stdin') {
      if (envelopeStdin) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The task media envelope option was repeated.');
      envelopeStdin = true;
      continue;
    }
    if (option === '--expect-owner' && index + 1 < args.length) {
      if (expectedOwner !== undefined) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The owner option was repeated.');
      expectedOwner = args[++index];
      continue;
    }
    if (option.startsWith('--')) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'An unsupported task media option was supplied.');
    if (option.endsWith('.json') && contractPath === DEFAULT_CONTRACT_PATH) {
      contractPath = option;
      continue;
    }
    throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'An unsupported task media argument was supplied.');
  }
  if (!envelopeStdin) throw new GeminiClientError('TASK_MEDIA_ENVELOPE_STDIN_REQUIRED', 'Use --envelope-stdin to provide the current session and task binding.');
  if (!expectedOwner || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(expectedOwner)) {
    throw new GeminiClientError('OWNER_EXPECTATION_REQUIRED', 'A valid expected Gemini account is required.');
  }
  return { envelopeStdin, contractPath, expectedOwner };
}

export function parseOriginalImageDownloadOptions(args) {
  let envelopeStdin = false;
  let contractPath = DEFAULT_CONTRACT_PATH;
  let expectedOwner;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--envelope-stdin') {
      if (envelopeStdin) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The original-image envelope option was repeated.');
      envelopeStdin = true;
      continue;
    }
    if (option === '--expect-owner' && index + 1 < args.length) {
      if (expectedOwner !== undefined) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The expected-owner option was repeated.');
      expectedOwner = args[++index];
      continue;
    }
    if (option.startsWith('--')) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'An unsupported original-image option was supplied.');
    if (option.endsWith('.json') && contractPath === DEFAULT_CONTRACT_PATH) {
      contractPath = option;
      continue;
    }
    throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'An unsupported original-image argument was supplied.');
  }
  if (!envelopeStdin) throw new GeminiClientError('ORIGINAL_IMAGE_ENVELOPE_STDIN_REQUIRED', 'Use --envelope-stdin to provide the current session and normal-SDK prepared request.');
  if (!expectedOwner || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(expectedOwner)) {
    throw new GeminiClientError('OWNER_EXPECTATION_REQUIRED', 'A valid Gemini account is required for original-image download.');
  }
  return { envelopeStdin, contractPath, expectedOwner };
}

export function parseAttachmentUploadOptions(args) {
  let envelopeStdin = false;
  let confirmed = false;
  let contractPath = DEFAULT_CONTRACT_PATH;
  let expectedOwner;
  let callerIntent;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--envelope-stdin') {
      if (envelopeStdin) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The attachment upload envelope option was repeated.');
      envelopeStdin = true;
      continue;
    }
    if (option === '--confirm') {
      if (confirmed) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The attachment upload confirmation was repeated.');
      confirmed = true;
      continue;
    }
    if (option === '--expect-owner' && index + 1 < args.length) {
      if (expectedOwner !== undefined) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The owner option was repeated.');
      expectedOwner = args[++index];
      continue;
    }
    if (option === '--caller-intent' && index + 1 < args.length) {
      if (callerIntent !== undefined) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The caller-intent option was repeated.');
      callerIntent = args[++index];
      continue;
    }
    if (option.startsWith('--')) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'An unsupported attachment upload option was supplied.');
    if (option.endsWith('.json') && contractPath === DEFAULT_CONTRACT_PATH) {
      contractPath = option;
      continue;
    }
    throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'An unsupported attachment upload argument was supplied.');
  }
  if (!envelopeStdin) throw new GeminiClientError('ATTACHMENT_UPLOAD_ENVELOPE_STDIN_REQUIRED', 'Use --envelope-stdin to provide the current session, captured start request, and file bytes.');
  if (!confirmed) throw new GeminiClientError('MUTATION_CONFIRMATION_REQUIRED', 'A direct attachment upload requires --confirm.');
  if (!expectedOwner || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(expectedOwner)) {
    throw new GeminiClientError('OWNER_EXPECTATION_REQUIRED', 'A valid expected Gemini account is required.');
  }
  if (typeof callerIntent !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(callerIntent)) {
    throw new GeminiClientError('MUTATION_INTENT_INVALID', 'A stable attachment upload caller intent is required.');
  }
  return { envelopeStdin, confirmed, contractPath, expectedOwner, callerIntent };
}

export function parseAttachmentChainOptions(args) {
  let envelopeStdin = false;
  let confirmed = false;
  let contractPath = DEFAULT_CONTRACT_PATH;
  let expectedOwner;
  let uploadCallerIntent;
  let messageCallerIntent;
  let prompt;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--envelope-stdin') {
      if (envelopeStdin) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The attachment-chain envelope option was repeated.');
      envelopeStdin = true;
      continue;
    }
    if (option === '--confirm') {
      if (confirmed) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The attachment-chain confirmation was repeated.');
      confirmed = true;
      continue;
    }
    if (option === '--expect-owner' && index + 1 < args.length) {
      if (expectedOwner !== undefined) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The attachment-chain owner option was repeated.');
      expectedOwner = args[++index];
      continue;
    }
    if (option === '--caller-intent' && index + 1 < args.length) {
      if (uploadCallerIntent !== undefined) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The upload caller-intent option was repeated.');
      uploadCallerIntent = args[++index];
      continue;
    }
    if (option === '--message-intent' && index + 1 < args.length) {
      if (messageCallerIntent !== undefined) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The message caller-intent option was repeated.');
      messageCallerIntent = args[++index];
      continue;
    }
    if (option === '--prompt' && index + 1 < args.length) {
      if (prompt !== undefined) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'The attachment-chain prompt was repeated.');
      prompt = args[++index];
      continue;
    }
    if (option.startsWith('--')) throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'An unsupported attachment-chain option was supplied.');
    if (option.endsWith('.json') && contractPath === DEFAULT_CONTRACT_PATH) {
      contractPath = option;
      continue;
    }
    throw new GeminiClientError('CLI_ARGUMENT_INVALID', 'An unsupported attachment-chain argument was supplied.');
  }
  if (!envelopeStdin) throw new GeminiClientError('ATTACHMENT_CHAIN_ENVELOPE_STDIN_REQUIRED', 'Use --envelope-stdin for the bounded line protocol.');
  if (!confirmed) throw new GeminiClientError('MUTATION_CONFIRMATION_REQUIRED', 'An attachment chain sends one upload and one text mutation and requires --confirm.');
  if (!expectedOwner || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(expectedOwner)) {
    throw new GeminiClientError('OWNER_EXPECTATION_REQUIRED', 'A valid Gemini account is required for the attachment chain.');
  }
  if (typeof uploadCallerIntent !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(uploadCallerIntent)
      || typeof messageCallerIntent !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(messageCallerIntent)
      || uploadCallerIntent === messageCallerIntent) {
    throw new GeminiClientError('MUTATION_INTENT_INVALID', 'Separate stable upload and message intents are required.');
  }
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000 || /[\0\r\n]/.test(prompt)) {
    throw new GeminiClientError('TEXT_PROMPT_INVALID', 'A bounded single-line attachment-chain prompt is required.');
  }
  return { envelopeStdin, confirmed, contractPath, expectedOwner, uploadCallerIntent, messageCallerIntent, prompt };
}

async function readMediaDownloadEnvelope() {
  const maxBytes = 1024 * 1024;
  if (stdin.isTTY === true) throw new GeminiClientError('MEDIA_DOWNLOAD_ENVELOPE_STDIN_REQUIRED', 'A one-shot media download envelope must be piped on stdin.');
  const chunks = [];
  let length = 0;
  for await (const chunk of stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    length += bytes.length;
    if (length > maxBytes) throw new GeminiClientError('MEDIA_DOWNLOAD_ENVELOPE_TOO_LARGE', 'The media download envelope exceeded its size limit.');
    chunks.push(Buffer.from(bytes));
  }
  if (!length) throw new GeminiClientError('MEDIA_DOWNLOAD_ENVELOPE_REQUIRED', 'A task media download envelope was not received.');
  const raw = Buffer.concat(chunks, length);
  let value;
  try { value = JSON.parse(raw.toString('utf8')); }
  catch { raw.fill(0); throw new GeminiClientError('MEDIA_DOWNLOAD_ENVELOPE_INVALID', 'The media download envelope is not valid JSON.'); }
  raw.fill(0);
  const allowed = new Set([
    'url', 'capability', 'observedNativeRequest', 'observedNativeHeaders', 'cookieCookies', 'observedRedirectEdges',
    'artifactRoot', 'artifactName', 'previousArtifactPath',
  ]);
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => !allowed.has(key))) {
    clearEnvelopeStrings(value);
    throw new GeminiClientError('MEDIA_DOWNLOAD_ENVELOPE_INVALID', 'The media download envelope has an unsupported shape.');
  }
  return value;
}

function clearEnvelopeStrings(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (typeof value[index] === 'string') value[index] = '';
      else clearEnvelopeStrings(value[index], seen);
    }
    return;
  }
  for (const key of Object.keys(value)) {
    if (typeof value[key] === 'string') value[key] = '';
    else clearEnvelopeStrings(value[key], seen);
  }
}

function parseTextMutationResponse(contract, response) {
  try {
    const parsed = contract.operations.text.observation.requestResponse === true
      ? parseCapturedTextResponse(contract, response.body)
      : parseRequestOnlyTextResponse(contract, response.body, { contentType: response.contentType });
    return parsed.matched ? { parsed: true, content: parsed.text, data: parsed.data,
      conversationId: parsed.conversationId, responseId: parsed.responseId, responseMeta: parsed }
      : { parsed: false, responseMeta: parsed };
  } catch (error) {
    return { parsed: false, parseErrorCode: error instanceof GeminiClientError ? error.code : 'TEXT_RESPONSE_UNCLASSIFIED' };
  }
}

async function runTextOnce(options) {
  const contract = await loadObservedContract(options.contractPath);
  let envelope = await readTextMutationEnvelopeFromStdin(contract);
  const client = new GeminiWebClient({ contract, session: envelope.session });
  try {
  const identity = await client.refreshSession(options.expectedOwner);
  if (!identity.ownerMatched || !identity.anonymousOwnerAbsent) {
    return {
      service: SERVICE_ID,
      operation: 'text',
      requestSent: false,
      ownerMatched: identity.ownerMatched,
      anonymousOwnerAbsent: identity.anonymousOwnerAbsent,
      credentialPropagated: identity.credentialPropagated,
      outputStatus: 'owner_gate_failed',
    };
  }
  let modelSelection = null;
  if (options.modelChoiceId) {
    const listedChoices = await client.listModelChoices({ expectedOwner: options.expectedOwner });
    const modelChoice = listedChoices.choices.find((choice) => choice.choiceId === options.modelChoiceId);
    if (!modelChoice || modelChoice.kind !== 'model') {
      throw new GeminiClientError('MODEL_CHOICE_NOT_FOUND', 'The selected model choice is not in the current owner-checked catalog.');
    }
    client.selectModelChoice(modelChoice);
    if (options.thinkingChoiceId) {
      const thinkingChoice = listedChoices.choices.find((choice) => choice.choiceId === options.thinkingChoiceId);
      if (!thinkingChoice || thinkingChoice.kind !== 'thinking_level') {
        throw new GeminiClientError('MODEL_CHOICE_NOT_FOUND', 'The thinking-level choice is not in the current guarded UI mapping.');
      }
      client.selectModelChoice(thinkingChoice);
    }
    const readback = client.getSelectedModelChoice({ isTemporaryChat: false });
    modelSelection = {
      selectedChoiceId: readback.selectedChoiceId,
      selectedModeId: readback.selectedModeId,
      modeCategory: readback.modeCategory,
      thinkingLevel: readback.thinkingLevel,
      preparedRequestMetadata: readback.preparedRequestMetadata,
      catalogModelIdMatched: true,
      serverPreferenceWritePerformed: false,
    };
  }
  const before = await client.listHistory();
  const beforeRows = extractConversationSummaries(before.data);
  const result = await client.generateTextOnce(envelope.capturedRequest, envelope.prompt, {
    actor: options.expectedOwner,
    callerIntent: options.callerIntent,
    preserveClientRequestId: true,
    preserveCapturedToken: true,
  });
  const decoded = parseTextMutationResponse(contract, result.response);
  let after = null;
  let readbackError = null;
  let afterRows = [];
  let candidate = null;
  let detailReadback = null;
  let journalReconciled = false;
  try {
    after = await client.listHistory();
    afterRows = extractConversationSummaries(after.data);
  } catch (error) {
    readbackError = error instanceof GeminiClientError ? error.code : 'HISTORY_READBACK_FAILED';
  }
  candidate = selectTextReadbackConversation(afterRows, {
    responseConversationId: decoded.conversationId ?? decoded.responseMeta?.conversationId ?? null,
    dispatchStartedAt: result.dispatchStartedAt,
    responseReceivedAt: result.responseReceivedAt,
  });
  if (candidate.state === 'candidate') {
    try {
      const detail = await client.readHistoryDetail({
        apiConversationId: candidate.conversationId,
        visibleRouteId: candidate.conversationId.slice(2),
        expectedIntent: envelope.prompt,
      });
      const detailStrings = stringsIn(detail.payload);
      const promptMatched = detail.summary.taskIntentMatched === true
        && detailStrings.some((value) => value === envelope.prompt);
      const assistantMarkerMatched = decoded.parsed === true && typeof decoded.content === 'string'
        && detailStrings.some((value) => value === decoded.content);
      const responseIdMatched = decoded.responseId
        ? detailStrings.some((value) => value === decoded.responseId) : null;
      const responseIdBound = responseIdMatched === null || responseIdMatched === true;
      const verified = detail.httpStatus === 200 && detail.binding.bound === true
        && detail.summary.rpcMatchCount === 1 && detail.summary.apiConversationIdMatched === true
        && promptMatched && assistantMarkerMatched && responseIdBound;
      detailReadback = {
        httpStatus: detail.httpStatus,
        rpcMatchCount: detail.summary.rpcMatchCount,
        apiConversationIdMatched: detail.summary.apiConversationIdMatched,
        routeBindingMatched: detail.binding.bound === true,
        promptMatched,
        assistantMarkerMatched,
        responseIdMatched,
        verified,
      };
      if (verified) {
        const intentKeyHash = mutationIntentDigest({
          capability: 'text', actor: options.expectedOwner, callerIntent: options.callerIntent,
        });
        const pending = await findUnresolvedMutation('text', intentKeyHash);
        if (pending) {
          await markMutationReconciled(pending.jobPath, { found: true, resultCategory: 'history_detail_readback' });
          journalReconciled = true;
        }
      }
    } catch (error) {
      readbackError = error instanceof GeminiClientError ? error.code : 'HISTORY_DETAIL_READBACK_FAILED';
    }
  } else if (!readbackError) {
    readbackError = candidate.state === 'ambiguous' ? 'TASK_CONVERSATION_DELTA_AMBIGUOUS'
      : candidate.state === 'window_unavailable' ? 'TASK_CONVERSATION_RESPONSE_ID_AND_TIME_UNAVAILABLE'
        : candidate.state === 'invalid_response_id' ? 'TASK_CONVERSATION_RESPONSE_ID_INVALID'
          : 'TASK_CONVERSATION_UNBOUND';
  }
  const beforeIds = new Set(beforeRows.map((row) => row.conversationId));
  const newConversationCount = afterRows.filter((row) => !beforeIds.has(row.conversationId)).length;
  const readbackVerified = detailReadback?.verified === true && journalReconciled;
  const output = {
    service: SERVICE_ID,
    operation: 'text',
    requestSent: true,
    ownerMatched: true,
    anonymousOwnerAbsent: true,
    credentialPropagated: result.response.credentialPropagated,
    directDispatchCount: 1,
    retryCount: 0,
    httpStatus: result.response.httpStatus,
    responseContentType: result.response.contentType,
    responseBytes: result.response.responseBytes,
    responseSha256: createHash('sha256').update(result.response.body).digest('hex'),
    wireBodySha256: result.wireBodyDigest,
    responseContractCaptured: result.response.responseContractCaptured,
    responseDecoded: decoded.parsed,
    responseFraming: decoded.responseMeta?.framing ?? null,
    nullSelectorFrameCount: decoded.responseMeta?.nullSelectorFrameCount ?? 0,
    mainCandidateChunkCount: decoded.responseMeta?.mainCandidateChunkCount ?? 0,
    chunkAssembly: decoded.responseMeta?.chunkAssembly ?? null,
    responseParseErrorCode: decoded.parseErrorCode ?? null,
    responseCheckpoint: {
      persisted: result.journalPath !== undefined && result.responseSha256 !== undefined,
      state: 'response_received',
      dispatchStartedAt: result.dispatchStartedAt ?? null,
      responseReceivedAt: result.responseReceivedAt ?? null,
      httpStatus: result.httpStatus,
      responseBytes: result.responseBytes,
      responseSha256: result.responseSha256,
    },
    beforeHistoryStatus: before.httpStatus,
    afterHistoryStatus: after?.httpStatus ?? null,
    newConversationCount,
    responseConversationIdMatched: candidate?.historyRowMatched ?? false,
    conversationCandidateSource: candidate?.source ?? null,
    conversationCandidateCount: candidate?.candidateCount ?? 0,
    historyDetailReadback: detailReadback,
    journalReconciled,
    readbackError,
    responseState: 'response_received',
    readbackState: readbackVerified ? 'verified' : 'readback_pending',
    outputStatus: readbackVerified ? 'response_received_readback_verified'
      : decoded.parsed ? 'response_received_readback_pending' : 'response_received_unclassified_readback_pending',
    ...(modelSelection ? {
      modelSelection,
      capturedSelectionMetadataMatched: true,
      selectedModelMetadataSource: 'captured_native_sdk_header',
    } : {}),
  };
  if (options.output === 'json' && decoded.parsed && Object.hasOwn(decoded, 'data')) {
    output.data = decoded.data;
    output.conversationId = decoded.conversationId;
    output.responseId = decoded.responseId;
    output.content = decoded.content;
  }
  if (options.output === 'json') {
    output.beforeHistoryData = before.data;
    output.afterHistoryData = after?.data ?? null;
  }
  if (options.output === 'content' && decoded.parsed && typeof decoded.content === 'string') output.content = decoded.content;
  if (options.output === 'content' && !(decoded.parsed && typeof decoded.content === 'string')) output.outputStatus = 'content_unavailable_unclassified_response';
  if (Buffer.isBuffer(result.response.body)) result.response.body.fill(0);
  return output;
  } finally {
    client.transport.session = null;
    client.verifiedOwner = null;
    client.modelSelection = null;
    options.expectedOwner = '';
    options.callerIntent = '';
    envelope = null;
  }
}

function stringsIn(value, out = [], depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (depth > 24 || budget.nodes > 50_000) return out;
  if (typeof value === 'string') { out.push(value); return out; }
  if (Array.isArray(value)) {
    for (const child of value) stringsIn(child, out, depth + 1, budget);
  } else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) stringsIn(child, out, depth + 1, budget);
  }
  return out;
}

async function runHistoryReadOnce(options) {
  const contract = await loadObservedContract(options.contractPath);
  const envelope = await readHistoryDetailEnvelopeFromStdin(contract);
  const client = new GeminiWebClient({ contract, session: envelope.session });
  const refreshed = await client.refreshSession(options.expectedOwner);
  if (!refreshed.ownerMatched || !refreshed.anonymousOwnerAbsent) {
    return { service: SERVICE_ID, operation: 'history_read', requestSent: false, ownerMatched: refreshed.ownerMatched,
      anonymousOwnerAbsent: refreshed.anonymousOwnerAbsent, outputStatus: 'owner_gate_failed' };
  }
  const result = await client.readHistoryDetail({
    apiConversationId: envelope.apiConversationId,
    visibleRouteId: envelope.visibleRouteId,
    expectedIntent: envelope.expectedIntent,
  });
  const payload = result.payload;
  const textValues = stringsIn(payload);
  const promptMatched = textValues.some((value) => value === envelope.expectedIntent);
  const responseMarker = options.responseMarker ?? 'PROTOCOL42';
  const assistantMarkerMatched = textValues.some((value) => value.includes(responseMarker) && /\b42\b/.test(value));
  const responseIdMatchAvailable = Boolean(envelope.expectedResponseId);
  const responseIdMatched = Boolean(responseIdMatchAvailable
    && textValues.some((value) => value === envelope.expectedResponseId));
  const taskMatched = result.summary.taskIntentMatched && promptMatched;
  const apiIdEchoedInDetail = result.summary.apiConversationIdMatched === true;
  const verified = result.httpStatus === 200 && result.binding.bound && apiIdEchoedInDetail && taskMatched && assistantMarkerMatched
    && (!responseIdMatchAvailable || responseIdMatched);
  let journalReconciled = false;
  if (verified && options.callerIntent) {
    const intentKeyHash = mutationIntentDigest({ capability: 'text', actor: options.expectedOwner, callerIntent: options.callerIntent });
    const pending = await findUnresolvedMutation('text', intentKeyHash);
    if (pending) {
      await markMutationReconciled(pending.jobPath, { found: true, resultCategory: 'history_detail_readback' });
      journalReconciled = true;
    }
  }
  return {
    service: SERVICE_ID,
    operation: 'history_read',
    ownerMatched: true,
    anonymousOwnerAbsent: true,
    httpStatus: result.httpStatus,
    contentType: result.contentType,
    responseBytes: result.responseBytes,
    responseSha256: result.responseSha256,
    credentialPropagated: result.credentialPropagated,
    apiRouteBindingVerified: result.binding.bound,
    rawApiIdUsedInRequest: result.binding.rawApiIdUsedInRequest,
    prefixRemovedFromRequest: result.binding.prefixRemovedFromRequest,
    apiIdEchoedInDetail,
    detailResponseCount: result.summary.rpcMatchCount,
    promptMatched,
    assistantMarkerMatched,
    responseIdMatchAvailable,
    responseIdMatched: responseIdMatchAvailable ? responseIdMatched : null,
    taskMatched,
    journalReconciled,
    outputStatus: verified ? 'verified' : 'needs_review_unverified_detail',
    ...(options.output === 'json' ? { responseShape: result.summary.responseShape } : {}),
  };
}

function lifecycleReadMetadata(action, result, identity) {
  const output = {
    service: SERVICE_ID,
    operation: action === 'history-search' ? 'history_search' : action === 'models' ? 'model_list'
      : action === 'settings' ? 'settings_read' : 'share_read',
    identityHttpStatus: identity.httpStatus,
    httpStatus: result.httpStatus,
    contentType: result.contentType,
    responseBytes: result.responseBytes,
    responseSha256: result.responseSha256,
    rpcId: result.rpcId,
    ownerMatched: identity.ownerMatched,
    anonymousOwnerAbsent: identity.anonymousOwnerAbsent,
    credentialPropagated: result.credentialPropagated,
  };
  output.request = {
    method: result.request.method,
    origin: result.request.origin,
    path: result.request.path,
    queryKeys: result.request.queryKeys,
    headerNames: result.request.headerNames,
    bodyFieldNames: result.request.formFieldNames,
    contentType: result.request.contentType,
    valuesPersisted: false,
  };
  if (action === 'history-search') {
    output.queryLength = result.queryLength;
    output.dataRootType = Array.isArray(result.data) ? 'array' : result.data === null ? 'null' : typeof result.data;
    output.dataRootLength = Array.isArray(result.data) ? result.data.length : null;
  } else if (action === 'models') {
    output.accountStatus = result.accountStatus;
    output.modelCount = result.models.length;
  } else if (action === 'settings') {
    output.requestedKeyCount = result.requestedKeys.length;
    output.reportedKeyCount = Object.values(result.settings).filter((value) => value.found).length;
    output.unreportedKeyCount = result.requestedKeys.length - output.reportedKeyCount;
  } else {
    output.shareCount = result.shareCount;
    output.dataShape = result.dataShape;
    output.rpcId = result.rpcId;
  }
  return output;
}

async function runLifecycleReadOnce(action, options) {
  const contract = await loadObservedContract(options.contractPath);
  const envelope = await readLifecycleReadEnvelopeFromStdin(contract, { action });
  const client = new GeminiWebClient({ contract, session: envelope.session });
  try {
    const identity = await client.refreshSession(options.expectedOwner);
    if (!identity.ownerMatched || !identity.anonymousOwnerAbsent) {
      return {
        service: SERVICE_ID,
        operation: action === 'history-search' ? 'history_search' : action === 'models' ? 'model_list' : 'settings_read',
        requestSent: false,
        ownerMatched: identity.ownerMatched,
        anonymousOwnerAbsent: identity.anonymousOwnerAbsent,
        credentialPropagated: identity.credentialPropagated,
        outputStatus: 'owner_gate_failed',
      };
    }
    let result;
    if (action === 'history-search') {
      result = await client.searchHistory({ expectedOwner: options.expectedOwner, query: envelope.query });
    } else if (action === 'models') {
      result = await client.listModels({ expectedOwner: options.expectedOwner });
    } else if (action === 'settings') {
      result = await client.readSettings({ expectedOwner: options.expectedOwner, keys: envelope.preferenceKeys });
    } else {
      result = await client.readPublicShareLinks({ expectedOwner: options.expectedOwner });
    }
    const output = lifecycleReadMetadata(action, result, identity);
    if (options.output === 'json') {
      let retained;
      if (action === 'history-search') { output.data = result.data; retained = output.data; }
      else if (action === 'models') { output.models = result.models; retained = output.models; }
      else if (action === 'settings') { output.settings = result.settings; retained = output.settings; }
      else if (action === 'public-links') { output.data = result.internal?.data; retained = output.data; }
      if (retained) {
        Object.defineProperty(output, 'cleanup', {
          value: () => {
            wipeLifecycleResponse(retained);
            if (Object.hasOwn(output, 'data')) output.data = null;
            if (Object.hasOwn(output, 'models')) output.models = null;
            if (Object.hasOwn(output, 'settings')) output.settings = null;
          },
          enumerable: false,
        });
      }
    }
    return output;
  } finally {
    client.transport.session = null;
    envelope.session = null;
    envelope.query = '';
    if (Array.isArray(envelope.preferenceKeys)) envelope.preferenceKeys.length = 0;
  }
}

async function runAnonymousShareReadOnce(options) {
  const contract = await loadObservedContract(options.contractPath);
  const envelope = await readAnonymousShareReadEnvelopeFromStdin(contract);
  const client = new GeminiWebClient({ contract, session: envelope.session });
  let result;
  let publicData;
  try {
    result = await client.readAnonymousSharedConversation({ shareId: envelope.shareId });
    publicData = result.internal?.data;
    const output = {
      service: SERVICE_ID,
      operation: 'share_public_read',
      anonymousRequest: result.anonymousRequest === true,
      cookiesOrAuthorizationSent: result.credentialPropagated !== false,
      httpStatus: result.httpStatus,
      contentType: result.contentType,
      responseBytes: result.responseBytes,
      responseSha256: result.responseSha256,
      rpcId: result.rpcId,
      responseRpcDecoded: result.responseRpcDecoded === true,
      shareIdLength: result.shareIdLength,
      dataShape: result.dataShape,
      credentialPropagated: result.credentialPropagated,
      request: {
        method: result.request.method,
        origin: result.request.origin,
        path: result.request.path,
        queryKeys: result.request.queryKeys,
        headerNames: result.request.headerNames,
        bodyFieldNames: result.request.formFieldNames,
        contentType: result.request.contentType,
        valuesPersisted: false,
      },
    };
    if (options.output === 'json') {
      output.data = publicData;
      const retainedData = publicData;
      Object.defineProperty(output, 'cleanup', {
        value: () => {
          wipeLifecycleResponse(retainedData);
          output.data = null;
          publicData = null;
        },
        enumerable: false,
      });
      publicData = null;
    } else {
      wipeLifecycleResponse(publicData);
      publicData = null;
    }
    return output;
  } finally {
    client.transport.session = null;
    if (publicData) wipeLifecycleResponse(publicData);
    envelope.session = null;
    envelope.shareId = '';
  }
}

async function runSettingsUpdateOnce(options) {
  const contract = await loadObservedContract(options.contractPath);
  const envelope = await readSettingsUpdateEnvelopeFromStdin(contract, { action: options.action });
  const client = new GeminiWebClient({ contract, session: envelope.session });
  try {
    const identity = await client.refreshSession(options.expectedOwner);
    if (!identity.ownerMatched || !identity.anonymousOwnerAbsent) {
      return {
        service: SERVICE_ID,
        operation: 'settings_update',
        requestSent: false,
        ownerMatched: identity.ownerMatched,
        anonymousOwnerAbsent: identity.anonymousOwnerAbsent,
        credentialPropagated: false,
        outputStatus: 'owner_gate_failed',
        automaticRetry: false,
      };
    }
    const result = options.action === 'settings-read-one'
      ? await client.readPreference({
        expectedOwner: options.expectedOwner,
        preferenceKey: envelope.preferenceKey,
      })
      : options.action === 'settings-update-test'
      ? await client.testAndRestoreSettingsPreference({
        expectedOwner: options.expectedOwner,
        preferenceKey: envelope.preferenceKey,
        expectedBaselineValue: envelope.baselineValue,
        callerIntent: options.callerIntent,
        confirmed: options.confirmed,
      })
      : await client.updateSettingsPreference({
        expectedOwner: options.expectedOwner,
        preferenceKey: envelope.preferenceKey,
        value: envelope.value,
        baselineValue: envelope.baselineValue,
        callerIntent: options.callerIntent,
        confirmed: options.confirmed,
      });
    return {
      service: SERVICE_ID,
      operation: options.action === 'settings-read-one' ? 'settings_read' : 'settings_update',
      action: options.action,
      ownerMatched: result.ownerMatched === true,
      anonymousOwnerAbsent: result.anonymousOwnerAbsent === true,
      sessionContextRefreshed: true,
      outputStatus: options.action === 'settings-read-one' ? (result.found ? 'verified' : 'unreported') : result.outcome,
      result,
      cookiesPersisted: false,
      requestBodiesPersisted: false,
      responseBodiesPersisted: false,
      automaticRetry: false,
    };
  } finally {
    client.transport.session = null;
    envelope.session = null;
    envelope.value = undefined;
    envelope.baselineValue = undefined;
    envelope.preferenceKey = '';
  }
}

function summarizeModelChoice(choice) {
  return {
    choiceId: choice.choiceId,
    kind: choice.kind,
    label: choice.label,
    ...(choice.uiLabel ? { uiLabel: choice.uiLabel } : {}),
    modelId: choice.modelId,
    modeId: choice.modeId,
    modeCategory: choice.modeCategory,
    thinkingLevel: choice.thinkingLevel,
    availability: choice.availability,
    uiEnabledObserved: choice.uiEnabledObserved,
    mappingStatus: choice.mappingStatus,
  };
}

async function runModelChoiceOnce(options) {
  const contract = await loadObservedContract(options.contractPath);
  const envelope = await readLifecycleReadEnvelopeFromStdin(contract, { action: 'models' });
  const client = new GeminiWebClient({ contract, session: envelope.session });
  try {
    const identity = await client.refreshSession(options.expectedOwner);
    if (!identity.ownerMatched || !identity.anonymousOwnerAbsent) {
      return {
        service: SERVICE_ID,
        operation: 'model_list',
        catalogRequestSent: false,
        ownerMatched: identity.ownerMatched,
        anonymousOwnerAbsent: identity.anonymousOwnerAbsent,
        credentialPropagated: identity.credentialPropagated,
        outputStatus: 'owner_gate_failed',
        serverPreferenceWritePerformed: false,
        businessRequestDispatched: false,
      };
    }
    const listed = await client.listModelChoices({ expectedOwner: options.expectedOwner });
    const choices = listed.choices.map(summarizeModelChoice);
    const metadataChoices = choices.map((choice) => ({
      choiceId: choice.choiceId,
      kind: choice.kind,
      label: choice.label,
      availability: choice.availability,
      modeCategory: choice.modeCategory,
      thinkingLevel: choice.thinkingLevel,
    }));
    const base = {
      service: SERVICE_ID,
      operation: options.selectedChoiceId ? 'model_select' : 'model_list',
      ownerMatched: listed.catalogRead.ownerMatched,
      anonymousOwnerAbsent: listed.catalogRead.anonymousOwnerAbsent,
      credentialPropagated: listed.catalogRead.credentialPropagated,
      catalogRead: listed.catalogRead,
      catalogModelCount: listed.catalogModelCount,
      uiChoiceCount: listed.uiChoiceCount,
      choices: options.output === 'json' ? choices : metadataChoices,
      accountStatusUsedAsPerModelEligibility: false,
      perModelAvailability: 'unknown',
      modeCategoryForCatalogRows: 'unknown',
      serverPreferenceWritePerformed: false,
      businessRequestDispatched: false,
    };
    if (!options.selectedChoiceId) return { ...base, outputStatus: 'verified_read' };
    const selectedChoice = listed.choices.find((choice) => choice.choiceId === options.selectedChoiceId);
    if (!selectedChoice || selectedChoice.kind !== 'model') {
      throw new GeminiClientError('MODEL_CHOICE_NOT_FOUND', 'The selected model choice is not in the current owner-checked catalog and UI mapping.');
    }
    const selection = client.selectModelChoice(selectedChoice);
    let finalSelection = selection;
    if (options.thinkingChoiceId) {
      const thinkingChoice = listed.choices.find((choice) => choice.choiceId === options.thinkingChoiceId);
      if (!thinkingChoice || thinkingChoice.kind !== 'thinking_level') {
        throw new GeminiClientError('MODEL_CHOICE_NOT_FOUND', 'The thinking-level choice is not in the current guarded UI mapping.');
      }
      finalSelection = client.selectModelChoice(thinkingChoice);
    }
    const readback = client.getSelectedModelChoice({ isTemporaryChat: false });
    if (readback.selectedModeId !== finalSelection.selectedModeId
        || readback.modeCategory !== finalSelection.modeCategory
        || readback.thinkingLevel !== finalSelection.thinkingLevel
        || readback.preparedRequestMetadata.modeId !== readback.selectedModeId
        || readback.preparedRequestMetadata.thinkingLevel !== readback.thinkingLevel
        || (readback.modeCategory === null && Object.hasOwn(readback.preparedRequestMetadata, 'modeCategory'))
        || (readback.modeCategory !== null && readback.preparedRequestMetadata.modeCategory !== readback.modeCategory)) {
      throw new GeminiClientError('MODEL_SELECTION_READBACK_MISMATCH', 'The process-local selection and source-shaped request metadata differ.');
    }
    return {
      ...base,
      operation: 'model_select',
      selectionStateOperation: 'selection_state',
      selectionEffect: readback.selectionEffect,
      selectedChoiceId: readback.selectedChoiceId,
      selectedModeId: readback.selectedModeId,
      modeCategory: readback.modeCategory,
      thinkingLevel: readback.thinkingLevel,
      preparedRequestMetadata: readback.preparedRequestMetadata,
      catalogModelIdMatched: true,
      outputStatus: 'local_selection_readback_verified',
      sdkRequestCaptured: false,
      currentNetworkVerifiedForSelectedModel: false,
    };
  } finally {
    client.transport.session = null;
    client.verifiedOwner = null;
    client.modelSelection = null;
    options.expectedOwner = '';
    envelope.session = null;
  }
}

async function runTextActionOnce(options) {
  const contract = await loadObservedContract(options.contractPath);
  let envelope = await readTextActionEnvelopeFromStdin(contract);
  let client;
  try {
    client = new GeminiWebClient({ contract, session: envelope.session });
    return await submitGeminiTextActionOnce({
      client,
      action: envelope.action,
      capturedRequest: envelope.capturedRequest,
      expectedOwner: envelope.expectedOwner,
      expectedOwnerSha256: options.expectedOwnerSha256,
      targetConversationId: envelope.targetConversationId,
      visibleRouteId: envelope.visibleRouteId,
      beforePrompt: envelope.beforePrompt,
      afterPrompt: envelope.afterPrompt,
      expectedAssistantMarker: envelope.expectedAssistantMarker,
      callerIntent: options.callerIntent,
      nativeActionCapture: envelope.nativeActionCapture,
    });
  } finally {
    if (client) {
      client.transport.session = null;
      client.verifiedOwner = null;
      client.modelSelection = null;
    }
    clearTextActionEnvelope(envelope);
    envelope = null;
  }
}

async function runMediaOnce(options, capability) {
  const contract = await loadObservedContract(options.contractPath);
  const envelope = await readMediaMutationEnvelopeFromStdin(contract);
  const client = new GeminiWebClient({ contract, session: envelope.session });
  try {
    const optionsForClient = {
      capture: envelope.capture,
      expectedOwner: options.expectedOwner,
      expectedIntent: envelope.expectedIntent,
      callerIntent: options.callerIntent,
    };
    const result = capability === 'image'
      ? await client.generateImageOnce(optionsForClient)
      : await client.generateVideoOnce(optionsForClient);
    const output = { ...result.summary };
    if (process.env.GEMINI_MEDIA_ORCHESTRATOR === '1' && stdout.isTTY !== true
        && result.internal?.assetReferenceVerified === true && typeof result.internal.assetUrl === 'string') {
      output.privateAssetUrl = result.internal.assetUrl;
    }
    return output;
  } finally {
    client.transport.session = null;
    if (Buffer.isBuffer(envelope.capture?.body)) envelope.capture.body.fill(0);
    if (envelope.capture?.headers && typeof envelope.capture.headers === 'object') {
      for (const name of Object.keys(envelope.capture.headers)) envelope.capture.headers[name] = '';
    }
    envelope.session = null;
    envelope.expectedIntent = '';
  }
}

async function runMediaDownloadOnce(options) {
  const contract = await loadObservedContract(options.contractPath);
  const envelope = await readMediaDownloadEnvelope();
  const client = new GeminiWebClient({ contract });
  try {
    const result = await client.downloadMediaOnce(envelope);
    return {
      service: SERVICE_ID,
      operation: 'media_download',
      httpStatus: result.httpStatus,
      contentType: result.contentType,
      mime: result.mime,
      capability: result.capability,
      bytes: result.bytes,
      sha256: result.sha256,
      mimeMagicMatched: result.mimeMagicMatched,
      independentFileReadback: result.independentFileReadback,
      credentialForwarding: result.credentialForwarding,
      observedRequestHeaderNamesForwarded: result.observedRequestHeaderNamesForwarded,
      redirects: result.redirects,
      artifact: result.artifact,
      sourceUrlPersisted: false,
      cookieValuesPersisted: false,
    };
  } finally {
    client.transport.session = null;
    clearEnvelopeStrings(envelope);
  }
}

async function runTaskMediaDownloadOnce(options) {
  const contract = await loadObservedContract(options.contractPath);
  const envelope = await readTaskMediaDownloadEnvelopeFromStdin(contract);
  const client = new GeminiWebClient({ contract, session: envelope.session });
  let detail;
  try {
    const identity = await client.refreshSession(options.expectedOwner);
    if (identity.ownerMatched !== true || identity.anonymousOwnerAbsent !== true) {
      return {
        service: SERVICE_ID,
        operation: 'task_media_download',
        requestSent: false,
        ownerMatched: identity.ownerMatched,
        anonymousOwnerAbsent: identity.anonymousOwnerAbsent,
        outputStatus: 'owner_gate_failed',
      };
    }
    detail = await client.readHistoryDetail({
      apiConversationId: envelope.apiConversationId,
      visibleRouteId: envelope.visibleRouteId,
      expectedIntent: envelope.expectedIntent,
      mediaCapability: envelope.capability,
    });
    const downloaded = await client.downloadTaskMediaAssetOnce(detail, {
      artifactRoot: envelope.artifactRoot,
      artifactName: envelope.artifactName,
      previousArtifactPath: envelope.previousArtifactPath,
    });
    return {
      service: SERVICE_ID,
      operation: 'task_media_download',
      ownerMatched: true,
      anonymousOwnerAbsent: true,
      credentialPropagated: detail.credentialPropagated,
      detailHttpStatus: detail.httpStatus,
      detailResponseBytes: detail.responseBytes,
      detailResponseSha256: detail.responseSha256,
      detailResponseCount: detail.summary.rpcMatchCount,
      taskPromptMatched: detail.summary.taskIntentMatched,
      apiConversationIdEchoed: detail.summary.apiConversationIdMatched,
      routeBound: detail.binding.bound,
      taskAssetCandidateCount: downloaded.taskAssetCandidateCount,
      excludedTaskCandidateCount: downloaded.excludedTaskCandidateCount,
      httpStatus: downloaded.httpStatus,
      contentType: downloaded.contentType,
      mime: downloaded.mime,
      capability: downloaded.capability,
      bytes: downloaded.bytes,
      sha256: downloaded.sha256,
      mimeMagicMatched: downloaded.mimeMagicMatched,
      independentFileReadback: downloaded.independentFileReadback,
      dimensions: downloaded.dimensions ?? null,
      credentialForwarding: downloaded.credentialForwarding,
      redirects: downloaded.redirects,
      downloadAuthorization: downloaded.downloadAuthorization,
      browserAssetGetPerformed: downloaded.browserAssetGetPerformed,
      artifact: downloaded.artifact,
      outputStatus: 'verified',
    };
  } finally {
    client.transport.session = null;
    detail = null;
  }
}

async function readOriginalImageDownloadEnvelope(contract) {
  const maxBytes = 8 * 1024 * 1024;
  if (stdin.isTTY === true) throw new GeminiClientError('ORIGINAL_IMAGE_ENVELOPE_STDIN_REQUIRED', 'A source-prepared original-image envelope must be piped on stdin.');
  const chunks = [];
  let length = 0;
  for await (const chunk of stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    length += bytes.length;
    if (length > maxBytes) throw new GeminiClientError('ORIGINAL_IMAGE_ENVELOPE_TOO_LARGE', 'The original-image envelope exceeded its size limit.');
    chunks.push(Buffer.from(bytes));
  }
  if (!length) throw new GeminiClientError('ORIGINAL_IMAGE_ENVELOPE_REQUIRED', 'An original-image envelope was not received.');
  const raw = Buffer.concat(chunks, length);
  let input;
  try { input = JSON.parse(raw.toString('utf8')); }
  catch { raw.fill(0); throw new GeminiClientError('ORIGINAL_IMAGE_ENVELOPE_INVALID', 'The original-image envelope is not valid JSON.'); }
  raw.fill(0);
  const allowed = new Set([
    'session', 'apiConversationId', 'visibleRouteId', 'expectedIntent', 'preparedRequest',
    'artifactRoot', 'artifactName', 'expectedArtifactPath',
  ]);
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some((key) => !allowed.has(key))
      || typeof input.apiConversationId !== 'string' || !/^c_[0-9a-f]{16}$/.test(input.apiConversationId)
      || typeof input.visibleRouteId !== 'string' || input.visibleRouteId !== input.apiConversationId.slice(2)
      || typeof input.expectedIntent !== 'string' || !input.expectedIntent.trim()
      || input.expectedIntent.length > 8000 || /[\0]/.test(input.expectedIntent)
      || !input.preparedRequest || typeof input.preparedRequest !== 'object' || Array.isArray(input.preparedRequest)
      || typeof input.artifactRoot !== 'string' || !path.isAbsolute(input.artifactRoot)
      || typeof input.artifactName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.png$/.test(input.artifactName)
      || (input.expectedArtifactPath !== undefined
        && (typeof input.expectedArtifactPath !== 'string' || !path.isAbsolute(input.expectedArtifactPath)))) {
    clearEnvelopeStrings(input);
    throw new GeminiClientError('ORIGINAL_IMAGE_ENVELOPE_INVALID', 'The original-image envelope has an unsupported shape.');
  }
  let session;
  try { session = validateSessionBundle(input.session, contract); }
  catch (error) { clearEnvelopeStrings(input); throw error; }
  let preparedRequest;
  try { preparedRequest = structuredClone(input.preparedRequest); }
  catch { clearEnvelopeStrings(input); throw new GeminiClientError('ORIGINAL_IMAGE_ENVELOPE_INVALID', 'The prepared request could not be copied into memory.'); }
  const result = {
    session,
    apiConversationId: input.apiConversationId,
    visibleRouteId: input.visibleRouteId,
    expectedIntent: input.expectedIntent,
    preparedRequest,
    artifactRoot: input.artifactRoot,
    artifactName: input.artifactName,
    expectedArtifactPath: input.expectedArtifactPath ?? null,
  };
  clearEnvelopeStrings(input);
  return result;
}

async function runOriginalImageDownloadOnce(options) {
  const contract = await loadObservedContract(options.contractPath);
  const envelope = await readOriginalImageDownloadEnvelope(contract);
  const client = new GeminiWebClient({ contract, session: envelope.session });
  try {
    const identity = await client.verifyOwner(options.expectedOwner);
    if (identity.ownerMatched !== true || identity.anonymousOwnerAbsent !== true) {
      return {
        service: SERVICE_ID,
        operation: 'original_image_download',
        requestSent: false,
        ownerMatched: identity.ownerMatched,
        anonymousOwnerAbsent: identity.anonymousOwnerAbsent,
        outputStatus: 'owner_gate_failed',
      };
    }
    const result = await client.downloadOriginalImageOnce({
      expectedOwner: options.expectedOwner,
      apiConversationId: envelope.apiConversationId,
      visibleRouteId: envelope.visibleRouteId,
      expectedIntent: envelope.expectedIntent,
      preparedRequest: envelope.preparedRequest,
      artifactRoot: envelope.artifactRoot,
      artifactName: envelope.artifactName,
      expectedArtifactPath: envelope.expectedArtifactPath,
    });
    return {
      service: SERVICE_ID,
      operation: 'original_image_download',
      ownerMatched: true,
      anonymousOwnerAbsent: true,
      ...result,
      outputStatus: result.outcome === 'fullsize_direct_http_verified' ? 'verified' : 'direct_image_readback_mismatch',
      rawValuesPersistedOrPrinted: false,
    };
  } catch (error) {
    const failureCode = error instanceof GeminiClientError ? error.code : 'ORIGINAL_IMAGE_DOWNLOAD_FAILED';
    const errorClass = error instanceof Error && /^[A-Za-z]+Error$/.test(error.name) ? error.name : 'InternalError';
    return {
      service: SERVICE_ID,
      operation: 'original_image_download',
      outcome: 'needs_review',
      failureCode,
      errorClass,
      directRequestOutcome: 'unknown',
      rawValuesPersistedOrPrinted: false,
    };
  } finally {
    client.transport.session = null;
    clearEnvelopeStrings(envelope.preparedRequest);
    envelope.preparedRequest = null;
    envelope.apiConversationId = '';
    envelope.visibleRouteId = '';
    envelope.expectedIntent = '';
    envelope.artifactRoot = '';
    envelope.artifactName = '';
    envelope.expectedArtifactPath = null;
    envelope.session = null;
  }
}

async function runAttachmentUploadOnce(options) {
  const contract = await loadObservedContract(options.contractPath);
  const envelope = await readAttachmentUploadEnvelopeFromStdin(contract);
  const client = new GeminiWebClient({ contract, session: envelope.session });
  try {
    return await client.uploadAttachmentOnce({
      expectedOwner: options.expectedOwner,
      callerIntent: options.callerIntent,
      capture: envelope.capture,
      uploadCookies: envelope.uploadCookies,
      file: envelope.file,
    });
  } finally {
    client.transport.session = null;
    if (Buffer.isBuffer(envelope.capture?.body)) envelope.capture.body.fill(0);
    if (Buffer.isBuffer(envelope.file?.body)) envelope.file.body.fill(0);
    for (const cookie of envelope.uploadCookies ?? []) cookie.value = '';
    for (const name of Object.keys(envelope.capture?.headers ?? {})) envelope.capture.headers[name] = '';
  }
}

export async function runSessionRenewalOnce(options) {
  const contract = await loadObservedContract(options.contractPath);
  const envelope = await readSessionRenewalEnvelopeFromStdin(contract);
  const client = new GeminiWebClient({ contract, session: envelope.session });
  try {
    return await client.renewSession({ expectedOwner: options.expectedOwner,
      acquireSession: async () => envelope.replacementSession,
    });
  } finally {
    client.transport.session = null;
  }
}

function wipeLifecycleMutationInput(value, depth = 0) {
  if (depth > 24 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (typeof value[index] === 'string') value[index] = '';
      else wipeLifecycleMutationInput(value[index], depth + 1);
    }
    value.length = 0;
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string') value[key] = '';
    else wipeLifecycleMutationInput(child, depth + 1);
  }
}

function wipeLifecycleResponse(value, depth = 0) {
  if (depth > 24 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (typeof value[index] === 'string') value[index] = '';
      else wipeLifecycleResponse(value[index], depth + 1);
    }
    value.length = 0;
    return;
  }
  for (const key of Object.keys(value)) {
    if (typeof value[key] === 'string') value[key] = '';
    else wipeLifecycleResponse(value[key], depth + 1);
    delete value[key];
  }
}

async function readLifecycleMutationInput({ maxBytes = 4 * 1024 * 1024 } = {}) {
  if (!stdin || stdin.isTTY === true) {
    throw new GeminiClientError('LIFECYCLE_MUTATION_ENVELOPE_REQUIRED', 'A one-shot lifecycle mutation envelope must be piped on stdin.');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    length += bytes.length;
    if (length > maxBytes) throw new GeminiClientError('LIFECYCLE_MUTATION_ENVELOPE_TOO_LARGE', 'The lifecycle mutation envelope exceeded its bounded size.');
    chunks.push(Buffer.from(bytes));
  }
  if (!length) throw new GeminiClientError('LIFECYCLE_MUTATION_ENVELOPE_REQUIRED', 'A lifecycle mutation envelope was not received.');
  const raw = Buffer.concat(chunks, length);
  let envelope;
  try { envelope = JSON.parse(raw.toString('utf8')); }
  catch {
    raw.fill(0);
    throw new GeminiClientError('LIFECYCLE_MUTATION_ENVELOPE_INVALID', 'The lifecycle mutation envelope is not valid JSON.');
  }
  raw.fill(0);
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
      || !['rename', 'delete', 'share_create', 'share_revoke'].includes(envelope.action)
      || envelope.confirmed !== true) {
    wipeLifecycleMutationInput(envelope);
    throw new GeminiClientError('LIFECYCLE_MUTATION_ENVELOPE_INVALID', 'The lifecycle mutation envelope has an unsupported shape.');
  }
  return envelope;
}

async function runShareMutationFromEnvelope(envelope, options) {
  const contract = await loadObservedContract(options.contractPath);
  const session = validateSessionBundle(envelope.session, contract);
  const client = new GeminiWebClient({ contract, session });
  let before;
  let after;
  let result;
  let shareUrl = '';
  try {
    if (envelope.action === 'share_create') {
      const allowed = new Set([
        'session', 'expectedOwner', 'action', 'confirmed', 'callerIntent', 'targetConversationId',
        'targetConversationTitle', 'expectedInitialTaskLinkCount', 'rpcId', 'args', 'requestCapture',
      ]);
      if (Object.keys(envelope).some((key) => !allowed.has(key))
          || typeof envelope.targetConversationTitle !== 'string'
          || !envelope.targetConversationTitle.trim() || envelope.targetConversationTitle.length > 160
          || /[\0\r\n]/.test(envelope.targetConversationTitle)
          || !Number.isInteger(envelope.expectedInitialTaskLinkCount)
          || envelope.expectedInitialTaskLinkCount < 0 || envelope.expectedInitialTaskLinkCount > 2) {
        throw new GeminiClientError('SHARE_MUTATION_ENVELOPE_INVALID', 'The share-create envelope is outside the observed bounded contract.');
      }
      before = await client.readPublicShareLinks({ expectedOwner: options.expectedOwner });
      const beforeTaskRowCount = publicShareConversationRowCount(before.internal.data, envelope.targetConversationTitle);
      if (before.ownerMatched !== true || before.anonymousOwnerAbsent !== true
          || beforeTaskRowCount !== envelope.expectedInitialTaskLinkCount) {
        throw new GeminiClientError('SHARE_MUTATION_PREFLIGHT_FAILED', 'The owner list did not match the caller-declared task-share baseline.');
      }
      result = await client.createConversationShare({
        requestCapture: envelope.requestCapture,
        rpcId: envelope.rpcId,
        args: envelope.args,
        targetConversationId: envelope.targetConversationId,
        expectedOwner: options.expectedOwner,
        confirmed: options.confirmed,
        callerIntent: envelope.callerIntent,
      });
      shareUrl = result.internal?.responseData === undefined
        ? null : findCreatedShareUrl(result.internal.responseData);
      const shareId = shareUrl ? shareIdFromCreatedUrl(shareUrl) : null;
      after = await client.readPublicShareLinks({ expectedOwner: options.expectedOwner });
      const afterTaskRowCount = publicShareConversationRowCount(after.internal.data, envelope.targetConversationTitle);
      const exactTargetLinkRowMatched = typeof shareId === 'string'
        && publicShareConversationRowHasId(after.internal.data, envelope.targetConversationTitle, shareId) === 1;
      const readbackVerified = after.ownerMatched === true && after.anonymousOwnerAbsent === true
        && after.httpStatus === 200 && after.shareCount === before.shareCount + 1
        && afterTaskRowCount === beforeTaskRowCount + 1 && exactTargetLinkRowMatched;
      if (readbackVerified && result.journalPath) {
        await reconcileLifecycleMutation(result.journalPath, { found: true, resultCategory: 'share_link_created_after_owner_readback' });
      }
      const handoffRequested = process.env.GEMINI_SHARE_LINK_HANDOFF === '1';
      if (handoffRequested) {
        if (!shareUrl) throw new GeminiClientError('SHARE_URL_NOT_FOUND_IN_RESPONSE', 'The current share response did not contain one source-shaped public link.');
        const handoffFd = Number(process.env.GEMINI_SHARE_URL_FD ?? 3);
        if (!Number.isSafeInteger(handoffFd) || handoffFd < 3) {
          throw new GeminiClientError('SHARE_URL_HANDOFF_FD_INVALID', 'The private share-link handoff descriptor is unavailable.');
        }
        const bytes = Buffer.from(`${shareUrl}\n`, 'utf8');
        try { writeSync(handoffFd, bytes); } finally { bytes.fill(0); }
      }
      const shareUrlFoundInMemory = Boolean(shareUrl);
      if (options.output === 'link') {
        if (!readbackVerified || !shareUrl) {
          throw new GeminiClientError('SHARE_LINK_READBACK_UNVERIFIED', 'The share link did not pass the owner-list readback required for explicit link output.');
        }
        const linkOutput = {
          service: SERVICE_ID,
          operation: 'share_create',
          ownerMatched: result.ownerMatched,
          anonymousOwnerAbsent: result.anonymousOwnerAbsent,
          dispatchCount: 1,
          mutationHttpStatus: result.response?.httpStatus ?? null,
          readbackVerified: true,
          ownerListReadback: {
            httpStatus: after.httpStatus,
            contentType: after.contentType,
            responseBytes: after.responseBytes,
            responseSha256: after.responseSha256,
            request: {
              method: after.request.method,
              origin: after.request.origin,
              path: after.request.path,
              queryKeys: after.request.queryKeys,
              headerNames: after.request.headerNames,
              bodyFieldNames: after.request.formFieldNames,
              contentType: after.request.contentType,
              valuesPersisted: false,
            },
          },
          shareUrl,
        };
        shareUrl = '';
        return linkOutput;
      }
      shareUrl = '';
      return {
        service: SERVICE_ID,
        operation: 'share_create',
        ownerMatched: result.ownerMatched,
        anonymousOwnerAbsent: result.anonymousOwnerAbsent,
        credentialPropagated: result.response?.credentialPropagated === true,
        requestOnlyMutationContract: true,
        retryPolicy: 'never',
        dispatchCount: 1,
        mutationHttpStatus: result.response?.httpStatus ?? null,
        mutationResponseBytes: result.response?.responseBytes ?? null,
        mutationResponseSha256: result.response?.responseSha256 ?? null,
        responseRpcDecoded: result.response?.responseRpcDecoded === true,
        preflightTaskRowCount: beforeTaskRowCount,
        readbackTaskRowCount: afterTaskRowCount,
        exactTargetLinkRowMatched,
        shareUrlFoundInMemory,
        readbackTotalShareCount: after.shareCount,
        ownerListReadback: {
          httpStatus: after.httpStatus,
          contentType: after.contentType,
          responseBytes: after.responseBytes,
          responseSha256: after.responseSha256,
          request: {
            method: after.request.method,
            origin: after.request.origin,
            path: after.request.path,
            queryKeys: after.request.queryKeys,
            headerNames: after.request.headerNames,
            bodyFieldNames: after.request.formFieldNames,
            contentType: after.request.contentType,
            valuesPersisted: false,
          },
        },
        readbackVerified,
        journalReconciled: readbackVerified,
        outputStatus: readbackVerified ? 'verified' : 'unresolved',
      };
    }
    if (envelope.action === 'share_revoke') {
      const allowed = new Set([
        'session', 'expectedOwner', 'action', 'confirmed', 'callerIntent', 'targetShareId',
        'targetConversationTitle', 'expectedRemainingTaskLinkCount', 'rpcId', 'args', 'requestCapture',
      ]);
      if (Object.keys(envelope).some((key) => !allowed.has(key))) {
        throw new GeminiClientError('SHARE_MUTATION_ENVELOPE_INVALID', 'The share-revoke envelope has unsupported fields.');
      }
      result = await client.revokePublicShareLink({
        requestCapture: envelope.requestCapture,
        rpcId: envelope.rpcId,
        args: envelope.args,
        targetShareId: envelope.targetShareId,
        targetConversationTitle: envelope.targetConversationTitle,
        expectedRemainingTaskLinkCount: envelope.expectedRemainingTaskLinkCount,
        expectedOwner: options.expectedOwner,
        confirmed: options.confirmed,
        callerIntent: envelope.callerIntent,
      });
      return {
        service: SERVICE_ID,
        operation: 'share_revoke',
        ownerMatched: result.ownerMatched,
        anonymousOwnerAbsent: result.anonymousOwnerAbsent,
        credentialPropagated: result.credentialPropagated,
        requestOnlyMutationContract: true,
        retryPolicy: 'never',
        dispatchCount: result.dispatchCount,
        retryCount: result.retryCount,
        mutationHttpStatus: result.mutationHttpStatus,
        mutationResponseBytes: result.mutationResponseBytes,
        mutationResponseSha256: result.mutationResponseSha256,
        responseRpcDecoded: result.responseRpcDecoded,
        preflightTaskRowCount: result.preflightTaskRowCount,
        preflightShareIdRowMatched: result.preflightShareIdRowMatched,
        readbackHttpStatus: result.readbackHttpStatus,
        readbackTaskRowCount: result.readbackTaskRowCount,
        readbackShareIdAbsent: result.readbackShareIdAbsent,
        readbackTotalShareCount: result.readbackTotalShareCount,
        ownerListReadback: result.ownerListReadback,
        readbackVerified: result.readbackVerified,
        journalReconciled: result.journalReconciled,
        outputStatus: result.readbackVerified ? 'verified' : 'unresolved',
      };
    }
    throw new GeminiClientError('LIFECYCLE_ACTION_UNSUPPORTED', 'The requested share mutation is unsupported.');
  } finally {
    client.transport.session = null;
    shareUrl = '';
    if (before?.internal?.data) wipeLifecycleResponse(before.internal.data);
    if (after?.internal?.data) wipeLifecycleResponse(after.internal.data);
    if (result?.internal?.responseData && typeof result.internal.responseData === 'object') {
      wipeLifecycleResponse(result.internal.responseData);
    }
  }
}

async function runLifecycleMutationCli(options) {
  const envelope = await readLifecycleMutationInput();
  try {
    if (typeof envelope.expectedOwner !== 'string'
        || (options.expectedOwner !== undefined
          && envelope.expectedOwner.trim().toLocaleLowerCase('en-US') !== options.expectedOwner.trim().toLocaleLowerCase('en-US'))) {
      throw new GeminiClientError('OWNER_VERIFICATION_FAILED', 'The command owner did not match the one-shot mutation envelope.');
    }
    if (envelope.confirmed !== options.confirmed) {
      throw new GeminiClientError('LIFECYCLE_MUTATION_CONFIRMATION_REQUIRED', 'The one-shot mutation envelope and command confirmation must agree.');
    }
    if (envelope.action === 'rename' || envelope.action === 'delete') {
      return await runLifecycleMutation(envelope, { contractPath: options.contractPath });
    }
    return await runShareMutationFromEnvelope(envelope, { ...options, expectedOwner: envelope.expectedOwner });
  } finally {
    wipeLifecycleMutationInput(envelope);
  }
}

async function main() {
  const command = process.argv[2] || 'help';
  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(usage() + '\n');
    return;
  }
  if (command === 'status') {
    process.stdout.write(JSON.stringify(await safeStatus(), null, 2) + '\n');
    return;
  }
  if (command === 'evidence') {
    let matrix = currentEvidenceMatrix();
    try {
      const contract = await loadObservedContract(process.argv[3] || DEFAULT_CONTRACT_PATH);
      matrix = new GeminiWebClient({ contract }).evidence();
    } catch {}
    process.stdout.write(JSON.stringify(matrix, null, 2) + '\n');
    return;
  }
  if (command === 'public-status') {
    const options = parsePublicStatusOptions(process.argv.slice(3));
    const receipt = options.transport === 'chrome'
      ? await (await import('./chrome-public-document-transport.mjs')).readPublicDocumentChrome({ pythonPath: options.pythonPath })
      : await (await import('./public-document.mjs')).readPublicDocument();
    process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
    return;
  }
  if (command === 'text') {
    const options = parseTextOptions(process.argv.slice(3));
    const output = await runTextOnce(options);
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    return;
  }
  if (command === 'text-action') {
    const options = parseTextActionOptions(process.argv.slice(3));
    const output = await runTextActionOnce(options);
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    return;
  }
  if (command === 'image' || command === 'video') {
    const options = parseMediaOptions(process.argv.slice(3));
    const output = await runMediaOnce(options, command);
    stdout.write(JSON.stringify(output, null, 2) + '\n');
    return;
  }
  if (command === 'media-download') {
    const options = parseMediaDownloadOptions(process.argv.slice(3));
    const output = await runMediaDownloadOnce(options);
    stdout.write(JSON.stringify(output, null, 2) + '\n');
    return;
  }
  if (command === 'task-media-download') {
    const options = parseTaskMediaDownloadOptions(process.argv.slice(3));
    const output = await runTaskMediaDownloadOnce(options);
    stdout.write(JSON.stringify(output, null, 2) + '\n');
    return;
  }
  if (command === 'original-image-download') {
    const options = parseOriginalImageDownloadOptions(process.argv.slice(3));
    const output = await runOriginalImageDownloadOnce(options);
    stdout.write(JSON.stringify(output, null, 2) + '\n');
    return;
  }
  if (command === 'model-choice') {
    const options = parseModelChoiceOptions(process.argv.slice(3));
    const output = await runModelChoiceOnce(options);
    stdout.write(JSON.stringify(output, null, 2) + '\n');
    return;
  }
  if (command === 'attachment-upload') {
    const options = parseAttachmentUploadOptions(process.argv.slice(3));
    const output = await runAttachmentUploadOnce(options);
    stdout.write(JSON.stringify(output, null, 2) + '\n');
    return;
  }
  if (command === 'attachment-chain') {
    try {
      const options = parseAttachmentChainOptions(process.argv.slice(3));
      const output = await runAttachmentChainOnce(options);
      stdout.write(JSON.stringify(output) + '\n');
    } catch (error) {
      if (process.env.GEMINI_ATTACHMENT_CHAIN_ORCHESTRATOR !== '1') throw error;
      const code = error instanceof GeminiClientError ? error.code : 'CLIENT_FAILED';
      const errorClass = error instanceof Error && /^[A-Za-z]+Error$/.test(error.name) ? error.name : 'InternalError';
      const details = error instanceof GeminiClientError && error.details && typeof error.details === 'object'
        ? error.details : {};
      stdout.write(JSON.stringify({ event: 'error', errorCode: code, errorClass, details }) + '\n');
      process.exitCode = 1;
    }
    return;
  }
  if (command === 'lifecycle-mutation') {
    const options = parseLifecycleMutationOptions(process.argv.slice(3));
    const output = await runLifecycleMutationCli(options);
    if (options.output === 'link') {
      if (output.operation !== 'share_create' || typeof output.shareUrl !== 'string' || !output.shareUrl) {
        throw new GeminiClientError('SHARE_URL_NOT_FOUND_IN_RESPONSE', 'The confirmed share-create result did not include a source-shaped public URL.');
      }
      stdout.write(`${output.shareUrl}\n`);
      output.shareUrl = '';
      return;
    }
    stdout.write(JSON.stringify(output, null, 2) + '\n');
    return;
  }
  if (command === 'session-renew') {
    const options = parseLifecycleReadOptions(process.argv.slice(3));
    const result = await runSessionRenewalOnce(options);
    stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  if (command === 'history' && process.argv[3] === 'read') {
    const options = parseHistoryReadOptions(process.argv.slice(4));
    const output = await runHistoryReadOnce(options);
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    return;
  }
  if (command === 'history' && process.argv[3] === 'search') {
    const options = parseLifecycleReadOptions(process.argv.slice(4));
    const output = await runLifecycleReadOnce('history-search', options);
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    return;
  }
  if (command === 'models' || command === 'settings') {
    const options = parseLifecycleReadOptions(process.argv.slice(3));
    const output = await runLifecycleReadOnce(command, options);
    try { process.stdout.write(JSON.stringify(output, null, 2) + '\n'); }
    finally { output.cleanup?.(); }
    return;
  }
  if (command === 'settings-read-one' || command === 'settings-update' || command === 'settings-update-test') {
    const options = parseSettingsUpdateOptions(process.argv.slice(3), { action: command });
    const output = await runSettingsUpdateOnce(options);
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    return;
  }
  if (command === 'public-links') {
    const options = parseLifecycleReadOptions(process.argv.slice(3));
    const output = await runLifecycleReadOnce('public-links', options);
    try { process.stdout.write(JSON.stringify(output, null, 2) + '\n'); }
    finally { output.cleanup?.(); }
    return;
  }
  if (command === 'public-share-read') {
    const options = parsePublicShareReadOptions(process.argv.slice(3));
    const output = await runAnonymousShareReadOnce(options);
    try { process.stdout.write(JSON.stringify(output, null, 2) + '\n'); }
    finally { output.cleanup?.(); }
    return;
  }
  if (command === 'identity' || command === 'history') {
    const options = parseCoreOptions(process.argv.slice(3));
    const contract = await loadObservedContract(options.contractPath);
    const session = await readSessionBundleFromStdin(contract);
    const client = new GeminiWebClient({ contract, session });
    const identity = command === 'identity'
      ? await client.verifyOwner(options.expectedOwner)
      : await client.refreshSession(options.expectedOwner);
    if (command === 'identity' || !identity.ownerMatched || !identity.anonymousOwnerAbsent) {
      process.stdout.write(JSON.stringify({
        service: SERVICE_ID,
        operation: 'identity',
        httpStatus: identity.httpStatus,
        responseBytes: identity.responseBytes,
        responseSha256: identity.responseSha256,
        ownerMatched: identity.ownerMatched,
        anonymousOwnerAbsent: identity.anonymousOwnerAbsent,
        credentialPropagated: identity.credentialPropagated,
      }, null, 2) + '\n');
      return;
    }
    const result = await client.listHistory();
    if (options.output === 'content') throw new GeminiClientError('OUTPUT_MODE_UNSUPPORTED', 'History list output does not expose message content.');
    const output = {
      service: SERVICE_ID,
      operation: 'history_list',
      identityHttpStatus: identity.httpStatus,
      identityResponseBytes: identity.responseBytes,
      identityResponseSha256: identity.responseSha256,
      httpStatus: result.httpStatus,
      contentType: result.contentType,
      responseBytes: result.responseBytes,
      responseSha256: result.responseSha256,
      rpcId: result.rpcId,
      ownerMatched: identity.ownerMatched,
      anonymousOwnerAbsent: identity.anonymousOwnerAbsent,
      credentialPropagated: result.credentialPropagated,
      sessionRefreshed: command === 'history',
    };
    if (options.output === 'json') output.data = result.data;
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    return;
  }
  if (CAPABILITIES.includes(command)) {
    let contract;
    try { contract = await loadObservedContract(process.argv[3] || DEFAULT_CONTRACT_PATH); }
    catch (error) {
      const code = error instanceof GeminiClientError ? error.code : 'CONTRACT_UNREADABLE';
      throw new GeminiClientError(code, 'No usable observed Gemini operation is installed.');
    }
    if (!contract.operations[command]) {
      throw new GeminiClientError('CONTRACT_NOT_CAPTURED', 'No observed Gemini contract is installed for ' + command + '.');
    }
    throw new GeminiClientError('OPERATION_ADAPTER_NOT_IMPLEMENTED', 'The observed operation has no reviewed operation-specific client adapter yet.');
  }
  throw new GeminiClientError('COMMAND_UNSUPPORTED', 'The requested CLI command is not available.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const code = error instanceof GeminiClientError ? error.code : 'CLIENT_FAILED';
    if (process.argv[2] === 'original-image-download') {
      const errorClass = error instanceof Error && /^[A-Za-z]+Error$/.test(error.name) ? error.name : 'InternalError';
      stdout.write(JSON.stringify({
        service: SERVICE_ID,
        operation: 'original_image_download',
        outcome: 'needs_review',
        failureCode: code,
        errorClass,
        requestOutcome: 'not_reported',
        rawValuesPersistedOrPrinted: false,
      }) + '\n');
      process.exitCode = 1;
      return;
    }
    if (process.argv[2] === 'attachment-chain' && process.env.GEMINI_ATTACHMENT_CHAIN_ORCHESTRATOR === '1') {
      const errorClass = error instanceof Error && /^[A-Za-z]+Error$/.test(error.name) ? error.name : 'InternalError';
      const details = error instanceof GeminiClientError && error.details && typeof error.details === 'object'
        ? error.details : {};
      stdout.write(JSON.stringify({ event: 'error', errorCode: code, errorClass, details }) + '\n');
      process.exitCode = 1;
      return;
    }
    process.stderr.write(code + '\n');
    process.exitCode = 1;
  });
}
