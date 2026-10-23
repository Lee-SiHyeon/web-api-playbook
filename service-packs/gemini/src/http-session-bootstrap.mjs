import { createHash } from 'node:crypto';
import { GeminiClientError } from './errors.mjs';
import { requireCapturedOperation } from './contract.mjs';
import { historyListRpcId } from './rpc-adapters.mjs';
import { validateSessionBundle } from './session.mjs';

const MAX_APP_HTML_BYTES = 16 * 1024 * 1024;
const SCRIPT_PATTERN = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
const WIZ_ASSIGNMENT_PATTERN = /\b(?:window\s*\.\s*)?WIZ_global_data\s*=\s*/g;
const CONTEXT_KEYS = Object.freeze({ at: 'SNlM0e', fSid: 'cfb2h', buildLabel: 'FdrFJe' });
const HISTORY_QUERY_CONTEXT = Object.freeze({
  'source-path': 'sourcePath',
  bl: 'buildLabel',
  'f.sid': 'fSid',
  hl: 'locale',
  _reqid: 'requestId',
  rt: 'requestType',
});

function missingContext(field, reason = 'required_value_missing', extra = {}) {
  throw new GeminiClientError(
    'HTTP_SESSION_CONTEXT_MISSING',
    'The authenticated Gemini app response did not provide a validated history context.',
    { field, reason, ...extra },
  );
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function jsonObjectEnd(source, start) {
  if (source[start] !== '{') return -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

function readWizGlobalData(html) {
  if (typeof html !== 'string' || Buffer.byteLength(html, 'utf8') > MAX_APP_HTML_BYTES) {
    missingContext('WIZ_global_data', 'app_document_size_invalid');
  }
  const matches = [];
  for (const scriptMatch of html.matchAll(SCRIPT_PATTERN)) {
    const script = scriptMatch[1];
    WIZ_ASSIGNMENT_PATTERN.lastIndex = 0;
    let assignment;
    while ((assignment = WIZ_ASSIGNMENT_PATTERN.exec(script)) !== null) {
      let start = assignment.index + assignment[0].length;
      while (/\s/.test(script[start] ?? '')) start += 1;
      const end = jsonObjectEnd(script, start);
      if (end < 0) missingContext('WIZ_global_data', 'assignment_not_json');
      let value;
      try { value = JSON.parse(script.slice(start, end)); }
      catch { missingContext('WIZ_global_data', 'assignment_not_json'); }
      if (!isPlainObject(value)) missingContext('WIZ_global_data', 'assignment_shape_invalid');
      matches.push(value);
    }
  }
  if (matches.length !== 1) {
    missingContext('WIZ_global_data', matches.length === 0 ? 'assignment_missing' : 'assignment_ambiguous');
  }
  return matches[0];
}

function requiredWizString(wiz, field) {
  const sourceKey = CONTEXT_KEYS[field];
  const value = wiz[sourceKey];
  if (typeof value !== 'string' || !value || value.length > 16_384 || /[\r\n\0]/.test(value)) {
    missingContext(field);
  }
  if (field === 'buildLabel' && !/^[A-Za-z0-9._-]{1,256}$/.test(value)) {
    missingContext(field, 'value_shape_invalid');
  }
  return value;
}

function capturedHistoryOperation(contract) {
  const operation = requireCapturedOperation(contract, 'history_list');
  if (operation.effect !== 'read' || operation.request.method !== 'POST'
      || operation.response.framing !== 'batchexecute') {
    missingContext('history_list', 'contract_binding_invalid');
  }
  const expectedQueryNames = new Set(['rpcids', ...Object.keys(HISTORY_QUERY_CONTEXT)]);
  if (operation.request.queryKeys.length !== expectedQueryNames.size
      || operation.request.queryKeys.some(name => !expectedQueryNames.has(name))) {
    missingContext('history_list', 'contract_query_binding_invalid');
  }
  for (const queryName of operation.request.queryKeys) {
    if (queryName === 'rpcids') {
      if (operation.response.rpcId !== historyListRpcId()) {
        missingContext(queryName, 'contract_binding_missing');
      }
      continue;
    }
    const key = HISTORY_QUERY_CONTEXT[queryName];
    if (!key) missingContext(queryName, 'contract_binding_missing');
  }
  if (operation.request.bodyFieldNames?.length !== 2
      || !operation.request.bodyFieldNames.includes('f.req')
      || !operation.request.bodyFieldNames.includes('at')) {
    missingContext('history_list', 'contract_body_binding_invalid');
  }
  return operation;
}

function historyContextTemplate(operation, session) {
  const template = session.batchContext;
  if (!template) {
    missingContext('history_list', 'captured_template_missing', {
      validatedWizFieldNames: Object.values(CONTEXT_KEYS),
    });
  }
  for (const queryName of operation.request.queryKeys) {
    if (queryName === 'rpcids') continue;
    const key = HISTORY_QUERY_CONTEXT[queryName];
    if (typeof template[key] !== 'string' || !template[key]) missingContext(queryName, 'captured_template_missing');
  }
  return template;
}

function identityRequestSpec(contract) {
  const operation = requireCapturedOperation(contract, 'identity');
  if (operation.effect !== 'read' || operation.request.method !== 'GET'
      || operation.request.path !== '/app' || operation.request.queryKeys.length !== 0
      || operation.response.framing !== 'text' || operation.response.contentType !== 'text/html') {
    throw new GeminiClientError('HTTP_SESSION_BOOTSTRAP_CONTRACT_INVALID', 'The observed Gemini identity read is not the expected app document.');
  }
  return Object.freeze({ method: 'GET', path: '/app', query: [], headers: {} });
}

function htmlFromResponse(response) {
  if (!response || response.httpStatus !== 200 || response.contentType !== 'text/html'
      || !Buffer.isBuffer(response.body) || response.body.length > MAX_APP_HTML_BYTES) {
    throw new GeminiClientError('HTTP_SESSION_BOOTSTRAP_RESPONSE_INVALID', 'The direct Gemini app read was not a bounded HTML response.');
  }
  return response.body.toString('utf8');
}

export function geminiDocumentHasExpectedOwner(html, expectedOwner, { allowMissingWiz = false } = {}) {
  let wiz;
  try { wiz = readWizGlobalData(html); }
  catch (error) {
    if (allowMissingWiz && error?.code === 'HTTP_SESSION_CONTEXT_MISSING') return false;
    throw error;
  }
  // oPEP7c is the active account field observed in the current first-party
  // app bootstrap. Other account addresses can also occur in chooser markup.
  const activeOwner = wiz.oPEP7c;
  return typeof activeOwner === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(activeOwner)
    && activeOwner.trim().toLowerCase() === expectedOwner.trim().toLowerCase()
    && html.includes('chat-app-orchestrator');
}

function clearBody(response) {
  if (Buffer.isBuffer(response?.body)) response.body.fill(0);
}

/**
 * Refresh the client-side Gemini batch context from the current authenticated app document.
 * Existing locale, source path, request template, and `_reqid` sequence seed come from the
 * validated browser capture; `_reqid` is a client counter, not a server expiry value.
 */
export async function refreshGeminiHttpSession({ client, expectedOwner } = {}) {
  const transport = client?.transport;
  const contract = client?.contract;
  if (!transport || typeof transport.request !== 'function' || !contract || !transport.session) {
    throw new GeminiClientError('HTTP_SESSION_BOOTSTRAP_INPUT_INVALID', 'An authenticated Gemini HTTP client and captured session are required.');
  }
  if (typeof expectedOwner !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(expectedOwner)) {
    throw new GeminiClientError('OWNER_EXPECTATION_INVALID', 'A valid expected Gemini account address is required.');
  }
  const session = validateSessionBundle(transport.session, contract);
  const historyOperation = capturedHistoryOperation(contract);
  const requestSpec = identityRequestSpec(contract);

  let authenticated;
  let anonymous;
  try {
    authenticated = await transport.request('identity', requestSpec);
    anonymous = await transport.request('identity', requestSpec, { omitCredentials: true });
    const authenticatedHtml = htmlFromResponse(authenticated);
    const anonymousHtml = htmlFromResponse(anonymous);
    const ownerMatched = geminiDocumentHasExpectedOwner(authenticatedHtml, expectedOwner);
    const anonymousOwnerAbsent = !geminiDocumentHasExpectedOwner(anonymousHtml, expectedOwner, { allowMissingWiz: true });
    if (!ownerMatched || !anonymousOwnerAbsent) {
      throw new GeminiClientError('OWNER_VERIFICATION_FAILED', 'The direct Gemini app reads did not verify the expected signed-in account.');
    }

    const wiz = readWizGlobalData(authenticatedHtml);
    const at = requiredWizString(wiz, 'at');
    const fSid = requiredWizString(wiz, 'fSid');
    const buildLabel = requiredWizString(wiz, 'buildLabel');
    const observedAt = new Date().toISOString();
    const responseBytes = authenticated.responseBytes ?? authenticated.body.length;
    const responseSha256 = createHash('sha256').update(authenticated.body).digest('hex');
    let template;
    try { template = historyContextTemplate(historyOperation, session); }
    catch (error) {
      if (error?.code === 'HTTP_SESSION_CONTEXT_MISSING'
          && error.details?.field === 'history_list'
          && error.details?.reason === 'captured_template_missing') {
        throw new GeminiClientError(error.code, error.message, {
          ...error.details,
          ownerMatched,
          anonymousOwnerAbsent,
          responseBytes,
          responseSha256,
          observedAt,
        });
      }
      throw error;
    }
    const batchContext = validateSessionBundle({
      ...session,
      batchContext: {
        ...template,
        at,
        fSid,
        buildLabel,
      },
    }, contract).batchContext;
    return Object.freeze({
      batchContext,
      observedAt,
      ownerMatched,
      anonymousOwnerAbsent,
      responseBytes,
      responseSha256,
    });
  } finally {
    clearBody(authenticated);
    clearBody(anonymous);
  }
}
