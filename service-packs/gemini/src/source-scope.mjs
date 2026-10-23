import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const SCOPE_SCHEMA = 'gemini-feature-source-scope-v1';
const AUTH_OPERATION = 'identity';

const BASE_HANDLER_UNITS = {
  identity: [
    ['src/client.mjs', ['constructor', 'verifyOwner', 'refreshSession', 'read']],
    ['src/http-session-bootstrap.mjs', ['MAX_APP_HTML_BYTES', 'SCRIPT_PATTERN', 'WIZ_ASSIGNMENT_PATTERN', 'CONTEXT_KEYS', 'HISTORY_QUERY_CONTEXT', 'missingContext', 'isPlainObject', 'jsonObjectEnd', 'readWizGlobalData', 'requiredWizString', 'capturedHistoryOperation', 'historyContextTemplate', 'identityRequestSpec', 'htmlFromResponse', 'geminiDocumentHasExpectedOwner', 'clearBody', 'refreshGeminiHttpSession']],
    ['src/session.mjs', ['isRecord', 'assertValue', 'validateRequestHeaders', 'validateBatchContext', 'validateSessionBundle', 'makeCookieHeader']],
    ['src/contract.mjs', ['requireCapturedOperation', 'validateObservedContract']],
    ['src/http-transport.mjs', ['mimeType', 'toBodyBuffer', 'cancelResponseBody', 'readBoundedBody', 'request', 'MAX_RESPONSE_BYTES', 'STATIC_FORBIDDEN_HEADERS']],
    ['src/https-transport.mjs', ['createHttpsFetch', 'incomingHeaders', 'countHeaderBytes', 'DEFAULT_MAX_HEADER_BYTES']],
    ['src/constants.mjs', ['SERVICE_ID', 'SERVICE_ORIGIN', 'CREDENTIAL_NAME']],
  ],
  login: [
    ['src/client.mjs', ['verifyOwner', 'refreshSession', 'read']],
    ['src/http-session-bootstrap.mjs', ['geminiDocumentHasExpectedOwner', 'refreshGeminiHttpSession']],
    ['src/session.mjs', ['validateSessionBundle', 'makeCookieHeader']],
    ['src/contract.mjs', ['requireCapturedOperation']],
    ['src/http-transport.mjs', ['request']],
    ['src/https-transport.mjs', ['createHttpsFetch', 'incomingHeaders', 'countHeaderBytes']],
    ['src/constants.mjs', ['SERVICE_ID', 'SERVICE_ORIGIN', 'CREDENTIAL_NAME']],
    ['scripts/gemini-settings-update-once.py', ['capture_one_shot_session', 'persist_login_evidence']],
  ],
  history: [
    ['src/client.mjs', ['constructor', 'verifyOwner', 'refreshSession', 'read', 'listHistory', 'readHistoryDetail', 'searchHistory']],
    ['src/http-session-bootstrap.mjs', ['MAX_APP_HTML_BYTES', 'SCRIPT_PATTERN', 'WIZ_ASSIGNMENT_PATTERN', 'CONTEXT_KEYS', 'HISTORY_QUERY_CONTEXT', 'missingContext', 'isPlainObject', 'jsonObjectEnd', 'readWizGlobalData', 'requiredWizString', 'capturedHistoryOperation', 'historyContextTemplate', 'identityRequestSpec', 'htmlFromResponse', 'geminiDocumentHasExpectedOwner', 'clearBody', 'refreshGeminiHttpSession']],
    ['src/session.mjs', ['isRecord', 'assertValue', 'validateRequestHeaders', 'validateBatchContext', 'validateSessionBundle', 'makeCookieHeader', 'readLifecycleReadEnvelopeFromStdin', 'readHistoryDetailEnvelopeFromStdin']],
    ['src/contract.mjs', ['requireCapturedOperation', 'validateObservedContract']],
    ['src/http-transport.mjs', ['mimeType', 'toBodyBuffer', 'cancelResponseBody', 'readBoundedBody', 'request', 'MAX_RESPONSE_BYTES', 'STATIC_FORBIDDEN_HEADERS']],
    ['src/https-transport.mjs', ['createHttpsFetch', 'incomingHeaders', 'countHeaderBytes', 'DEFAULT_MAX_HEADER_BYTES']],
    ['src/constants.mjs', ['SERVICE_ID', 'SERVICE_ORIGIN', 'CREDENTIAL_NAME']],
    ['src/batch-response.mjs', ['__module__']],
    ['src/rpc-adapters.mjs', ['HISTORY_LIST_RPC', 'buildHistoryListRequest', 'historyListRpcId']],
    ['src/history-detail.mjs', ['GEMINI_HISTORY_DETAIL_RPC', 'GEMINI_API_CONVERSATION_ID_PATTERN', 'GEMINI_ROUTE_CONVERSATION_ID_PATTERN', 'GEMINI_API_CONVERSATION_ID_TOKEN', 'REQUIRED_QUERY_KEYS', 'MAX_DETAIL_RESPONSE_BYTES', 'MAX_JSON_DEPTH', 'MAX_JSON_NODES', '__module__']],
    ['src/conversation-lifecycle.mjs', ['HISTORY_PATH', 'HISTORY_ID', 'MAX_SEARCH_LENGTH', 'fail', 'isRecord', 'requireClient', 'nextRequestId', 'buildReadRequest', 'matchesRpcArgsTemplate', 'bindRpcArgsTemplate', 'countRpcPlaceholder', 'verifyOwner', 'executeReadRpc', 'parseTimestamp', 'decodeNestedJson', 'extractConversationSummaries', 'searchConversations']],
    ['src/cli.mjs', ['runHistoryReadOnce', 'lifecycleReadMetadata', 'runLifecycleReadOnce']],
  ],
  model_catalog: [
    ['src/client.mjs', ['constructor', 'verifyOwner', 'refreshSession', 'read', 'listModels']],
    ['src/http-session-bootstrap.mjs', ['MAX_APP_HTML_BYTES', 'SCRIPT_PATTERN', 'WIZ_ASSIGNMENT_PATTERN', 'CONTEXT_KEYS', 'HISTORY_QUERY_CONTEXT', 'missingContext', 'isPlainObject', 'jsonObjectEnd', 'readWizGlobalData', 'requiredWizString', 'capturedHistoryOperation', 'historyContextTemplate', 'identityRequestSpec', 'htmlFromResponse', 'geminiDocumentHasExpectedOwner', 'clearBody', 'refreshGeminiHttpSession']],
    ['src/session.mjs', ['isRecord', 'assertValue', 'validateRequestHeaders', 'validateBatchContext', 'validateSessionBundle', 'makeCookieHeader', 'readLifecycleReadEnvelopeFromStdin']],
    ['src/contract.mjs', ['requireCapturedOperation', 'validateObservedContract']],
    ['src/http-transport.mjs', ['mimeType', 'toBodyBuffer', 'cancelResponseBody', 'readBoundedBody', 'request', 'MAX_RESPONSE_BYTES', 'STATIC_FORBIDDEN_HEADERS']],
    ['src/https-transport.mjs', ['createHttpsFetch', 'incomingHeaders', 'countHeaderBytes', 'DEFAULT_MAX_HEADER_BYTES']],
    ['src/constants.mjs', ['SERVICE_ID', 'SERVICE_ORIGIN', 'CREDENTIAL_NAME']],
    ['src/batch-response.mjs', ['__module__']],
    ['src/conversation-lifecycle.mjs', ['HISTORY_PATH', 'GEMINI_MODEL_STATUS_RPC', 'MODEL_ID', 'fail', 'isRecord', 'safeResponseShape', 'requireClient', 'nextRequestId', 'buildReadRequest', 'matchesRpcArgsTemplate', 'bindRpcArgsTemplate', 'countRpcPlaceholder', 'verifyOwner', 'executeReadRpc', 'numberList', 'computeModelCapacity', 'toModelName', 'parseModel', 'parseModelStatus', 'readModels']],
    ['src/cli.mjs', ['lifecycleReadMetadata', 'runLifecycleReadOnce']],
    ['scripts/gemini-model-catalog-http-once.mjs', ['readInput', 'sourceSnapshot', 'performModelRead']],
    ['scripts/gemini-model-catalog-read-once.py', ['safe_model_result', 'run_model_read']],
  ],
};

const HANDLER_UNITS = Object.freeze({
  ...BASE_HANDLER_UNITS,
  edit: [
    ...BASE_HANDLER_UNITS.identity,
    ['src/client.mjs', ['listHistory', 'readHistoryDetail', 'searchHistory', 'renameConversation', 'captureMutationResponseOnce']],
    ['src/batch-response.mjs', ['__module__']],
    ['src/history-detail.mjs', ['__module__']],
    ['src/conversation-lifecycle.mjs', ['HISTORY_PATH', 'HISTORY_ID', 'fail', 'isRecord', 'safeResponseShape', 'requireClient', 'nextRequestId', 'buildReadRequest', 'matchesRpcArgsTemplate', 'bindRpcArgsTemplate', 'countRpcPlaceholder', 'verifyOwner', 'executeReadRpc', 'parseTimestamp', 'decodeNestedJson', 'extractConversationSummaries', 'readConversation', 'listConversations', 'searchConversations']],
    ['src/lifecycle-mutation.mjs', ['BATCH_PATH', 'EXPECTED_RPC', 'QUERY_KEYS', 'fail', 'isRecord', 'validJsonValue', 'countExact', 'countTemplatePlaceholder', 'bindMutationTemplate', 'captureInstalledMutationContract', 'installLifecycleMutationCapture', 'buildCapturedLifecycleMutationRequest', 'mutateConversationOnce']],
    ['src/journal.mjs', ['__module__']], ['src/mutation.mjs', ['__module__']],
    ['scripts/gemini-lifecycle-mutation-once.mjs', ['readEnvelope', 'validateEnvelope', 'collectConversationIds', 'containsSameRow', 'runLifecycleMutation']],
    ['src/cli.mjs', ['parseLifecycleMutationOptions', 'readLifecycleMutationInput', 'wipeLifecycleMutationInput', 'wipeLifecycleResponse', 'runLifecycleMutationCli']],
  ],
  delete: [
    ...BASE_HANDLER_UNITS.identity,
    ['src/client.mjs', ['listHistory', 'readHistoryDetail', 'searchHistory', 'deleteConversation', 'captureMutationResponseOnce']],
    ['src/batch-response.mjs', ['__module__']],
    ['src/history-detail.mjs', ['__module__']],
    ['src/conversation-lifecycle.mjs', ['HISTORY_PATH', 'HISTORY_ID', 'fail', 'isRecord', 'safeResponseShape', 'requireClient', 'nextRequestId', 'buildReadRequest', 'matchesRpcArgsTemplate', 'bindRpcArgsTemplate', 'countRpcPlaceholder', 'verifyOwner', 'executeReadRpc', 'parseTimestamp', 'decodeNestedJson', 'extractConversationSummaries', 'readConversation', 'listConversations', 'searchConversations']],
    ['src/lifecycle-mutation.mjs', ['BATCH_PATH', 'EXPECTED_RPC', 'QUERY_KEYS', 'fail', 'isRecord', 'validJsonValue', 'countExact', 'countTemplatePlaceholder', 'bindMutationTemplate', 'captureInstalledMutationContract', 'installLifecycleMutationCapture', 'buildCapturedLifecycleMutationRequest', 'mutateConversationOnce']],
    ['src/journal.mjs', ['__module__']], ['src/mutation.mjs', ['__module__']],
    ['scripts/gemini-lifecycle-mutation-once.mjs', ['readEnvelope', 'validateEnvelope', 'collectConversationIds', 'containsSameRow', 'runLifecycleMutation']],
    ['src/cli.mjs', ['parseLifecycleMutationOptions', 'readLifecycleMutationInput', 'wipeLifecycleMutationInput', 'wipeLifecycleResponse', 'runLifecycleMutationCli']],
  ],
  share: [
    ...BASE_HANDLER_UNITS.identity,
    ['src/client.mjs', ['readHistoryDetail', 'readPublicShareLinks', 'readSharedConversation', 'readAnonymousSharedConversation', 'createConversationShare', 'revokePublicShareLink', 'captureMutationResponseOnce']],
    ['src/history-detail.mjs', ['__module__']],
    ['src/batch-response.mjs', ['__module__']],
    ['src/conversation-lifecycle.mjs', ['HISTORY_PATH', 'MAX_SEARCH_LENGTH', 'GEMINI_LIST_PUBLIC_SHARE_LINKS_RPC', 'GEMINI_PUBLIC_SHARED_CONVERSATION_RPC', 'fail', 'isRecord', 'requireClient', 'nextRequestId', 'buildReadRequest', 'matchesRpcArgsTemplate', 'bindRpcArgsTemplate', 'countRpcPlaceholder', 'verifyOwner', 'executeReadRpc', 'executeAnonymousShareReadRpc', 'publicShareCount', 'readConversation', 'readPublicShareLinks', 'readSharedConversation', 'readAnonymousSharedConversation', 'publicShareConversationRowCount', 'publicShareConversationRowHasId']],
    ['src/lifecycle-mutation.mjs', ['BATCH_PATH', 'EXPECTED_RPC', 'QUERY_KEYS', 'fail', 'isRecord', 'validJsonValue', 'countExact', 'countTemplatePlaceholder', 'bindMutationTemplate', 'captureInstalledMutationContract', 'installLifecycleMutationCapture', 'buildCapturedLifecycleMutationRequest', 'createConversationShareOnce', 'revokePublicShareLinkOnce']],
    ['src/share-link.mjs', ['findCreatedShareUrl', 'shareIdFromCreatedUrl']],
    ['src/journal.mjs', ['__module__']], ['src/mutation.mjs', ['__module__']],
    ['src/session.mjs', ['readAnonymousShareReadEnvelopeFromStdin']],
    ['src/cli.mjs', ['lifecycleReadMetadata', 'runLifecycleReadOnce', 'parseLifecycleMutationOptions', 'parseLifecycleReadOptions', 'parsePublicShareReadOptions', 'readLifecycleMutationInput', 'runAnonymousShareReadOnce', 'wipeLifecycleMutationInput', 'wipeLifecycleResponse', 'runShareMutationFromEnvelope', 'runLifecycleMutationCli']],
  ],
});

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) => JSON.stringify(value);

function findUnit(source, symbol) {
  if (symbol === '__module__') return source;
  const python = new RegExp(`^([\\t ]*)def\\s+${symbol}\\s*\\(`, 'm').exec(source);
  if (python) {
    const start = python.index;
    const indent = python[1].length;
    const lines = source.slice(start).split(/(?<=\n)/);
    let length = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (index > 0 && line.trim() && !/^\s*#/.test(line)
          && (line.match(/^[\t ]*/)?.[0].length ?? 0) <= indent) break;
      length += line.length;
    }
    return source.slice(start, start + length).trimEnd();
  }
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`^[\\t ]*(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}\\s*\\(`, 'm'),
    new RegExp(`^[\\t ]*(?:async\\s+)?${escaped}\\s*\\(`, 'm'),
    new RegExp(`^[\\t ]*(?:export\\s+)?const\\s+${escaped}\\s*=`, 'm'),
  ];
  let match = null;
  for (const pattern of patterns) {
    match = pattern.exec(source);
    if (match) break;
  }
  if (!match) throw new Error(`source unit missing: ${symbol}`);
  const start = match.index;
  if (/\bconst\s+/.test(match[0])) {
    const semicolon = source.indexOf(';', start + match[0].length);
    if (semicolon >= 0) return source.slice(start, semicolon + 1).trimEnd();
    const end = source.indexOf('\n', start);
    return source.slice(start, end < 0 ? source.length : end).trimEnd();
  }
  const signatureStart = source.indexOf('(', start + match[0].length - 1);
  if (signatureStart < 0) throw new Error(`source unit signature missing: ${symbol}`);
  let parenDepth = 0;
  let signatureQuote = '';
  let signatureEscape = false;
  let signatureLineComment = false;
  let signatureBlockComment = false;
  let signatureEnd = -1;
  for (let index = signatureStart; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (signatureLineComment) { if (char === '\n') signatureLineComment = false; continue; }
    if (signatureBlockComment) {
      if (char === '*' && next === '/') { signatureBlockComment = false; index += 1; }
      continue;
    }
    if (signatureQuote) {
      if (signatureEscape) { signatureEscape = false; continue; }
      if (char === '\\') { signatureEscape = true; continue; }
      if (char === signatureQuote) signatureQuote = '';
      continue;
    }
    if (char === '/' && next === '/') { signatureLineComment = true; index += 1; continue; }
    if (char === '/' && next === '*') { signatureBlockComment = true; index += 1; continue; }
    if (char === '"' || char === "'" || char === '`') { signatureQuote = char; continue; }
    if (char === '(') parenDepth += 1;
    else if (char === ')' && --parenDepth === 0) { signatureEnd = index + 1; break; }
  }
  if (signatureEnd < 0) throw new Error(`source unit signature terminator missing: ${symbol}`);
  const open = source.indexOf('{', signatureEnd);
  if (open < 0) throw new Error(`source unit body missing: ${symbol}`);
  let depth = 0;
  let quote = '';
  let lineComment = false;
  let blockComment = false;
  let escapedChar = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') { blockComment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (escapedChar) { escapedChar = false; continue; }
      if (char === '\\') { escapedChar = true; continue; }
      if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (char === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`source unit terminator missing: ${symbol}`);
}

async function readUnit(root, file, symbol) {
  const fullPath = path.resolve(root, file);
  const source = await readFile(fullPath, 'utf8');
  const unit = findUnit(source, symbol);
  return { path: `${file}#${symbol}`, sha256: sha256(unit) };
}

function operationProjection(contract, names) {
  const operations = Object.fromEntries([...new Set([AUTH_OPERATION, ...names])].sort()
    .map((name) => [name, contract?.operations?.[name] ?? null]));
  return {
    schema: contract?.version ?? null,
    service: contract?.service ?? null,
    origin: contract?.origin ?? null,
    auth: contract?.auth ?? null,
    operations,
  };
}

export async function snapshotFeatureSourceScope({ root, contract, featureId, operationNames } = {}) {
  const units = HANDLER_UNITS[featureId];
  if (!Array.isArray(units) || !Array.isArray(operationNames) || operationNames.length === 0) {
    throw new TypeError('a supported feature and its required operation names are required');
  }
  const contractScope = operationProjection(contract, operationNames);
  const contractScopeSha256 = sha256(canonical(contractScope));
  const implementationUnits = [];
  for (const [file, symbols] of units) {
    for (const symbol of symbols) implementationUnits.push(await readUnit(root, file, symbol));
  }
  implementationUnits.sort((left, right) => left.path.localeCompare(right.path));
  const implementationScopeSha256 = sha256(canonical(implementationUnits));
  return Object.freeze({
    schema: SCOPE_SCHEMA,
    featureId,
    operationNames: [...new Set(operationNames)].sort(),
    authOperation: AUTH_OPERATION,
    contractScopeSha256,
    implementationUnits: Object.freeze(implementationUnits),
    implementationScopeSha256,
  });
}

export function validateFeatureSourceScope(scope, currentScope) {
  return scope?.schema === SCOPE_SCHEMA
    && scope.featureId === currentScope?.featureId
    && canonical(scope.operationNames) === canonical(currentScope.operationNames)
    && scope.authOperation === AUTH_OPERATION
    && scope.contractScopeSha256 === currentScope.contractScopeSha256
    && scope.implementationScopeSha256 === currentScope.implementationScopeSha256
    && canonical(scope.implementationUnits) === canonical(currentScope.implementationUnits);
}
