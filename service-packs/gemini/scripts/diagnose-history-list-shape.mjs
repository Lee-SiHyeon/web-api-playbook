import { pathToFileURL } from 'node:url';
import { loadObservedContract } from '../src/contract.mjs';
import { GeminiWebClient } from '../src/client.mjs';
import { buildHistoryListRequest } from '../src/rpc-adapters.mjs';
import { collectRpcResponses, parseBatchResponse, requireRpcResponse } from '../src/batch-response.mjs';

const MAX_INPUT_BYTES = 24 * 1024 * 1024;
const MAX_NODES = 200_000;
const ID_PATTERN = /^c_[0-9a-f]{16}$/;
const PROMPT = 'Reply with the sum of 17 + 25 and the label PROTOCOL42. Do not use tools or create media.';
let activeStage = 'startup';

function typeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function nestedJson(value, depth = 0) {
  if (depth > 24) return value;
  if (typeof value === 'string') {
    const trimmed = value.trimStart();
    if ((trimmed.startsWith('[') || trimmed.startsWith('{')) && trimmed.length <= 2 * 1024 * 1024) {
      try { return nestedJson(JSON.parse(trimmed), depth + 1); } catch { return value; }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => nestedJson(entry, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, nestedJson(entry, depth + 1)]));
  }
  return value;
}

function promptFlags(value) {
  let exactPrompt = false;
  let taskMarker = false;
  const pending = [value];
  let visited = 0;
  while (pending.length && visited < MAX_NODES) {
    visited += 1;
    const current = pending.pop();
    if (typeof current === 'string') {
      if (current === PROMPT) exactPrompt = true;
      if (current.includes('PROTOCOL42')) taskMarker = true;
    } else if (Array.isArray(current)) pending.push(...current);
    else if (current && typeof current === 'object') pending.push(...Object.values(current));
  }
  return { exactPrompt, taskMarker };
}

function findTaskCandidates(value) {
  const candidates = new Set();
  const pending = [{ value, depth: 0 }];
  let visited = 0;
  while (pending.length && visited < MAX_NODES) {
    visited += 1;
    const { value: current, depth } = pending.pop();
    if (depth > 24) continue;
    if (typeof current === 'string') {
      const trimmed = current.trimStart();
      if ((trimmed.startsWith('[') || trimmed.startsWith('{')) && trimmed.length <= 2 * 1024 * 1024) {
        try { pending.push({ value: JSON.parse(trimmed), depth: depth + 1 }); } catch { /* Plain text. */ }
      }
      continue;
    }
    if (Array.isArray(current) || (current && typeof current === 'object')) {
      const flags = promptFlags(current);
      if (flags.taskMarker) {
        const ids = new Set();
        const scan = [current];
        let count = 0;
        while (scan.length && count < MAX_NODES) {
          count += 1;
          const item = scan.pop();
          if (typeof item === 'string' && ID_PATTERN.test(item)) ids.add(item);
          else if (Array.isArray(item)) scan.push(...item);
          else if (item && typeof item === 'object') {
            for (const [key, child] of Object.entries(item)) {
              if ((key === 'conversationId' || key === 'conversation_id') && typeof child === 'string' && ID_PATTERN.test(child)) ids.add(child);
              scan.push(child);
            }
          }
        }
        if (ids.size === 1) candidates.add(ids.values().next().value);
      }
      const children = Array.isArray(current) ? current : Object.values(current);
      for (const child of children) pending.push({ value: child, depth: depth + 1 });
    }
  }
  return candidates;
}

function epochSeconds(value) {
  if (typeof value === 'boolean' || value === null || value === undefined) return null;
  const numeric = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) return null;
  if (numeric >= 1_700_000_000 && numeric <= 2_000_000_000) return numeric;
  if (numeric >= 1_700_000_000_000 && numeric <= 2_000_000_000_000) return numeric / 1000;
  if (numeric >= 1_700_000_000_000_000 && numeric <= 2_000_000_000_000_000) return numeric / 1_000_000;
  return null;
}

function findTimeWindowCandidates(value, window, depth = 0, found = new Set()) {
  if (!window || depth > 24) return found;
  if (typeof value === 'string') {
    const trimmed = value.trimStart();
    if ((trimmed.startsWith('[') || trimmed.startsWith('{')) && trimmed.length <= 2 * 1024 * 1024) {
      try { findTimeWindowCandidates(JSON.parse(trimmed), window, depth + 1, found); } catch { /* Plain text. */ }
    }
    return found;
  }
  if (Array.isArray(value)) {
    if (typeof value[0] === 'string' && ID_PATTERN.test(value[0])) {
      const epoch = epochSeconds(value?.[5]?.[0]);
      if (epoch !== null && epoch >= window.startEpoch && epoch <= window.endEpoch) found.add(value[0]);
    }
    for (const child of value) findTimeWindowCandidates(child, window, depth + 1, found);
  } else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) findTimeWindowCandidates(child, window, depth + 1, found);
  }
  return found;
}

function summarizeData(data, includeTransientId = false) {
  const decoded = nestedJson(data);
  const rowGroups = [];
  const statusEnums = [];
  const taskIds = findTaskCandidates(decoded);
  const pending = [{ value: decoded, path: [], depth: 0 }];
  let visited = 0;
  while (pending.length && visited < MAX_NODES) {
    visited += 1;
    const { value, path, depth } = pending.pop();
    if (depth > 24) continue;
    if (Array.isArray(value)) {
      const idRows = value.filter((row) => Array.isArray(row) && typeof row[0] === 'string' && ID_PATTERN.test(row[0]));
      if (idRows.length && idRows.length === value.length) {
        rowGroups.push(Object.freeze({
          path: path.map((part) => Number.isInteger(part) ? part : '{field}'),
          rowCount: idRows.length,
          firstRowIdPatternMatched: true,
          firstRowIdLength: idRows[0][0].length,
          taskMarkerRowCount: idRows.filter((row) => promptFlags(row).taskMarker).length,
          exactPromptRowCount: idRows.filter((row) => promptFlags(row).exactPrompt).length,
        }));
      }
      for (let index = value.length - 1; index >= 0; index -= 1) pending.push({ value: value[index], path: [...path, index], depth: depth + 1 });
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (/^(?:error|status|code|reason)/i.test(key)
            && ((Number.isInteger(child) && child >= 0 && child <= 65535)
              || (typeof child === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(child)))) {
          statusEnums.push({ path: [...path, '{field}'], valueType: typeName(child), enumValue: child });
        }
        pending.push({ value: child, path: [...path, key], depth: depth + 1 });
      }
    }
  }
  const flags = promptFlags(decoded);
  return {
    rootType: typeName(decoded),
    rootArrayLength: Array.isArray(decoded) ? decoded.length : null,
    rootObjectFieldCount: decoded && typeof decoded === 'object' && !Array.isArray(decoded) ? Object.keys(decoded).length : null,
    exactPromptPresent: flags.exactPrompt,
    taskMarkerPresent: flags.taskMarker,
    taskConversationIdCandidateCount: taskIds.size,
    taskConversationIdCandidate: includeTransientId && taskIds.size === 1 ? taskIds.values().next().value : null,
    rowGroups: rowGroups.slice(0, 24),
    rowGroupCount: rowGroups.length,
    statusErrorEnums: statusEnums.slice(0, 24),
    statusErrorEnumCount: statusEnums.length,
  };
}

function decodeOperation(body, operation) {
  const frames = parseBatchResponse(body, {
    lengthUnit: operation.response.frameLengthUnit,
    frameLengthOverheadUnits: operation.response.frameLengthOverheadUnits,
  });
  const rpc = requireRpcResponse(frames, operation.response.rpcId);
  return { frames, rpc, rpcs: collectRpcResponses(frames) };
}

function queryRecord(url) {
  return [...new URL(String(url)).searchParams.entries()];
}

function safeArgsSummary(value) {
  const numbers = [];
  const nullPaths = [];
  const booleans = [];
  const strings = [];
  const pending = [{ value, path: [] }];
  while (pending.length && pending.length < MAX_NODES) {
    const current = pending.pop();
    const item = current.value;
    if (item === null) nullPaths.push(current.path);
    else if (typeof item === 'boolean') booleans.push({ path: current.path, value: item });
    else if (typeof item === 'number' && Number.isFinite(item)) numbers.push({ path: current.path, value: item });
    else if (typeof item === 'string') strings.push({ path: current.path, length: item.length });
    else if (Array.isArray(item)) {
      for (let index = item.length - 1; index >= 0; index -= 1) pending.push({ value: item[index], path: [...current.path, index] });
    }
  }
  return { type: typeName(value), topLength: Array.isArray(value) ? value.length : null, numbers, nullPaths, booleans, strings };
}

function parsedRequest(url, body) {
  const params = new URLSearchParams(Buffer.from(body).toString('utf8'));
  const formFields = [...params.keys()];
  let rpcId = null;
  let rpcArgs = null;
  try {
    const outer = JSON.parse(params.get('f.req'));
    const call = outer?.[0]?.[0];
    if (Array.isArray(call) && call.length >= 2 && typeof call[0] === 'string') {
      rpcId = call[0];
      rpcArgs = JSON.parse(call[1]);
    }
  } catch { /* Shape summary only. */ }
  return { query: queryRecord(url), formFields, rpcId, rpcArgs, at: params.get('at') };
}

function compareRequestContext(browser, direct) {
  const bQuery = Object.fromEntries(browser.query);
  const dQuery = Object.fromEntries(direct.query);
  const changedQueryKeys = Object.keys(bQuery).filter((key) => bQuery[key] !== dQuery[key]);
  const requestFieldNames = ['rpcids', 'source-path', 'bl', 'f.sid', 'hl', '_reqid', 'rt'];
  return {
    methodAndPathMatched: browser.method === direct.method && new URL(String(browser.url)).pathname === new URL(String(direct.url)).pathname,
    queryKeysMatched: browser.query.map(([name]) => name).join('\0') === direct.query.map(([name]) => name).join('\0'),
    formFieldNamesMatched: browser.formFields.join('\0') === direct.formFields.join('\0'),
    rpcIdMatched: browser.rpcId === direct.rpcId,
    rpcArgsMatched: JSON.stringify(browser.rpcArgs) === JSON.stringify(direct.rpcArgs),
    queryValuesMatchedExceptFreshFields: requestFieldNames.filter((key) => !['bl', 'f.sid', '_reqid'].includes(key))
      .every((key) => bQuery[key] === dQuery[key]),
    freshQueryValueKeysChanged: changedQueryKeys.filter((key) => ['bl', 'f.sid', '_reqid'].includes(key)),
    atTokenChangedAfterBootstrap: browser.at !== direct.at,
    bodyHasAtField: browser.formFields.includes('at') && direct.formFields.includes('at'),
    browserHistoryArgs: safeArgsSummary(browser.rpcArgs),
    directHistoryArgs: safeArgsSummary(direct.rpcArgs),
  };
}

async function readInput() {
  let source = '';
  for await (const chunk of process.stdin) {
    source += chunk;
    if (Buffer.byteLength(source) > MAX_INPUT_BYTES) throw new Error('INPUT_TOO_LARGE');
  }
  return JSON.parse(source);
}

async function main() {
  activeStage = 'read_input';
  const input = await readInput();
  activeStage = 'load_contract';
  const contract = await loadObservedContract();
  try { new URL(String(input.browserObservation.url)); }
  catch { throw new Error('BROWSER_OBSERVED_URL_INVALID'); }
  const browserBody = Buffer.from(input.browserObservation.responseBase64, 'base64');
  activeStage = 'prepare_browser_context';
  const browserRequest = {
    url: input.browserObservation.url,
    method: input.browserObservation.method,
    headers: input.browserObservation.headers,
    body: Buffer.from(input.browserObservation.requestBody, 'utf8'),
  };
  activeStage = 'client_bootstrap';
  const client = new GeminiWebClient({ contract, session: input.session });
  const refreshed = await client.refreshSession(input.expectedOwner);
  if (!refreshed.ownerMatched || !refreshed.anonymousOwnerAbsent) throw new Error('DIRECT_OWNER_GATE_FAILED');
  const directRequestSpec = buildHistoryListRequest(contract, client.transport.session);
  const directUrl = new URL(directRequestSpec.path, contract.origin);
  for (const [name, value] of directRequestSpec.query) directUrl.searchParams.append(name, value);
  activeStage = 'direct_history_read';
  const directList = await client.listHistory();
  activeStage = 'parse_history_responses';
  const browserDecoded = decodeOperation(browserBody, contract.operations.history_list);
  const browserSummary = summarizeData(browserDecoded.rpc.data);
  const directSummary = summarizeData(directList.data);
  const browserAllRpcSummaries = browserDecoded.rpcs.map((entry) => ({ rpcId: entry.rpcId, data: summarizeData(entry.data) }));
  const directAllRpcSummaries = [{ rpcId: directList.rpcId, data: directSummary }];
  const browserTaskIds = new Set(browserDecoded.rpcs.flatMap((entry) => [...findTaskCandidates(entry.data)]));
  const directTaskIds = findTaskCandidates(directList.data);
  const taskWindow = input.taskWindow;
  const browserTimeIds = findTimeWindowCandidates(browserDecoded.rpc.data, taskWindow);
  const directTimeIds = findTimeWindowCandidates(directList.data, taskWindow);
  const browserParsedRequest = parsedRequest(browserRequest.url, browserRequest.body);
  browserParsedRequest.method = browserRequest.method;
  browserParsedRequest.url = browserRequest.url;
  const directParsedRequest = parsedRequest(directUrl.href, directRequestSpec.body);
  directParsedRequest.method = directRequestSpec.method;
  directParsedRequest.url = directUrl.href;
  const browserHeaderNames = Object.keys(browserRequest.headers).map((name) => name.toLowerCase()).filter((name) => !['cookie', 'authorization', 'host', 'content-length'].includes(name)).sort();
  const directHeaderNames = [...new Set([
    ...Object.keys(client.transport.session.requestHeaders?.history_list ?? {}),
    'content-type',
  ].map((name) => name.toLowerCase()).filter((name) => !['cookie', 'authorization', 'host', 'content-length'].includes(name)))].sort();
  const candidateIds = new Set([...browserTaskIds, ...directTaskIds]);
  const timeCandidateIds = new Set([...browserTimeIds, ...directTimeIds]);
  const selectedIds = candidateIds.size === 1 ? candidateIds : timeCandidateIds;
  activeStage = 'compare_history_responses';
  const output = {
    browser: {
      httpStatus: input.browserObservation.status,
      contentType: input.browserObservation.contentType,
      responseBytes: browserBody.length,
      frameCount: browserDecoded.frames.length,
      rpcId: browserDecoded.rpc.rpcId,
      data: browserSummary,
      rpcPayloads: browserAllRpcSummaries,
    },
    direct: {
      ownerMatched: refreshed.ownerMatched,
      anonymousOwnerAbsent: refreshed.anonymousOwnerAbsent,
      httpStatus: directList.httpStatus,
      contentType: directList.contentType,
      responseBytes: directList.responseBytes,
      responseSha256: directList.responseSha256,
      rpcId: directList.rpcId,
      credentialPropagated: directList.credentialPropagated,
      data: directSummary,
      rpcPayloads: directAllRpcSummaries,
    },
    requestComparison: {
      ...compareRequestContext(browserParsedRequest, directParsedRequest),
      browserHeaderNameCount: browserHeaderNames.length,
      directHeaderNameCount: directHeaderNames.length,
      sharedHeaderNames: browserHeaderNames.filter((name) => directHeaderNames.includes(name)).length,
      browserOnlyHeaderNames: browserHeaderNames.filter((name) => !directHeaderNames.includes(name)),
      directOnlyHeaderNames: directHeaderNames.filter((name) => !browserHeaderNames.includes(name)),
    },
    taskConversationIdCandidateCount: candidateIds.size,
    timeWindowCandidateCount: timeCandidateIds.size,
    timeWindowStartEpoch: taskWindow?.startEpoch ?? null,
    timeWindowEndEpoch: taskWindow?.endEpoch ?? null,
    candidateSource: candidateIds.size === 1 ? 'task_prompt_marker' : timeCandidateIds.size === 1 ? 'request_time_window' : 'ambiguous_or_missing',
    apiConversationId: input.internalHandoff === true && selectedIds.size === 1 ? selectedIds.values().next().value : null,
  };
  browserBody.fill(0);
  browserRequest.body.fill(0);
  browserRequest.url = '';
  for (const cookie of input.session.cookies) cookie.value = '';
  input.session.cookies.length = 0;
  input.session.requestHeaders = {};
  input.session.headers = {};
  input.session.batchContext = {};
  input.expectedOwner = '';
  input.browserObservation.url = '';
  input.browserObservation.requestBody = '';
  input.browserObservation.responseBase64 = '';
  input.browserObservation.headers = {};
  directUrl.search = '';
  directUrl.pathname = '/';
  process.stdout.write(JSON.stringify(output) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const explicit = /^[A-Z][A-Z0-9_]{1,63}$/.test(error?.message ?? '') ? error.message : null;
    const code = explicit ?? (error?.code === 'ERR_INVALID_URL'
      ? 'HISTORY_LIST_DIAGNOSTIC_' + activeStage.toUpperCase()
      : typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
        ? error.code : 'HISTORY_LIST_DIAGNOSTIC_FAILED');
    process.stderr.write(code + '\n');
    process.exitCode = 1;
  });
}
