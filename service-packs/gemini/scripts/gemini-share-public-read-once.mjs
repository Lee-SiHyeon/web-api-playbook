import { createHash } from 'node:crypto';
import { stdin, stdout } from 'node:process';
import { loadObservedContract } from '../src/contract.mjs';
import { GeminiClientError } from '../src/errors.mjs';
import { GeminiWebClient } from '../src/client.mjs';
import { validateSessionBundle } from '../src/session.mjs';
import {
  listConversations,
  publicShareConversationRowCount,
  publicShareConversationRowHasId,
  readConversation,
  readPublicShareLinks,
} from '../src/conversation-lifecycle.mjs';

const MAX_ENVELOPE_BYTES = 4 * 1024 * 1024;
const SHARE_ID = /^[A-Za-z0-9._~-]{8,256}$/;

function fail(code, message) {
  throw new GeminiClientError(code, message);
}

function wipe(value, depth = 0) {
  if (depth > 24 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      if (typeof value[i] === 'string') value[i] = '';
      else wipe(value[i], depth + 1);
    }
    value.length = 0;
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string') value[key] = '';
    else wipe(child, depth + 1);
  }
}

async function readEnvelope() {
  if (!stdin || stdin.isTTY === true) fail('SHARE_PUBLIC_READ_ENVELOPE_REQUIRED', 'A one-shot public-share envelope must be piped to stdin.');
  const chunks = [];
  let length = 0;
  for await (const chunk of stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    length += bytes.length;
    if (length > MAX_ENVELOPE_BYTES) fail('SHARE_PUBLIC_READ_ENVELOPE_TOO_LARGE', 'The public-share envelope exceeded its bounded size.');
    chunks.push(Buffer.from(bytes));
  }
  if (!length) fail('SHARE_PUBLIC_READ_ENVELOPE_REQUIRED', 'A one-shot public-share envelope was empty.');
  const raw = Buffer.concat(chunks, length);
  let envelope;
  try { envelope = JSON.parse(raw.toString('utf8')); }
  catch { raw.fill(0); fail('SHARE_PUBLIC_READ_ENVELOPE_INVALID', 'The public-share envelope is not valid JSON.'); }
  raw.fill(0);
  const allowed = new Set(['session', 'expectedOwner', 'shareIds', 'requestHeaders', 'taskTitle', 'taskMarker', 'historyRouteSuffix']);
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
      || Object.keys(envelope).some((key) => !allowed.has(key))
      || typeof envelope.expectedOwner !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(envelope.expectedOwner)
      || !Array.isArray(envelope.shareIds) || envelope.shareIds.length !== 2
      || envelope.shareIds.some((id) => typeof id !== 'string' || !SHARE_ID.test(id))
      || new Set(envelope.shareIds).size !== 2
      || !Array.isArray(envelope.requestHeaders) || envelope.requestHeaders.length !== 2
      || envelope.requestHeaders.some((headers) => !headers || typeof headers !== 'object' || Array.isArray(headers))
      || typeof envelope.taskTitle !== 'string' || !envelope.taskTitle.trim() || envelope.taskTitle.length > 160
      || typeof envelope.taskMarker !== 'string' || !envelope.taskMarker.trim() || envelope.taskMarker.length > 80
      || typeof envelope.historyRouteSuffix !== 'string' || !/^[0-9a-f]{16}$/.test(envelope.historyRouteSuffix)
      || !envelope.session || typeof envelope.session !== 'object' || Array.isArray(envelope.session)) {
    wipe(envelope);
    fail('SHARE_PUBLIC_READ_ENVELOPE_INVALID', 'The public-share envelope has an unsupported shape.');
  }
  return envelope;
}

function collectTaskText(root, { marker }) {
  const pending = [{ value: root, depth: 0 }];
  const matched = new Set();
  let visited = 0;
  while (pending.length && visited < 100_000) {
    const { value, depth } = pending.pop();
    visited += 1;
    if (depth > 24) continue;
    if (typeof value === 'string') {
      const trimmed = value.trimStart();
      if ((trimmed.startsWith('[') || trimmed.startsWith('{')) && trimmed.length <= 2 * 1024 * 1024) {
        try { pending.push({ value: JSON.parse(trimmed), depth: depth + 1 }); continue; } catch { /* Plain text. */ }
      }
      if (value.includes(marker)) matched.add(value);
    } else if (Array.isArray(value)) {
      for (const child of value) pending.push({ value: child, depth: depth + 1 });
    } else if (value && typeof value === 'object') {
      for (const child of Object.values(value)) pending.push({ value: child, depth: depth + 1 });
    }
  }
  if (pending.length) fail('SHARE_PUBLIC_READ_CONTENT_SCAN_LIMIT', 'The bounded public-share content scan exceeded its limit.');
  return [...matched].sort();
}

function exactValueCount(root, expected, maxNodes = 100_000) {
  const pending = [{ value: root, depth: 0 }];
  let matches = 0;
  let visited = 0;
  while (pending.length && visited < maxNodes) {
    const { value, depth } = pending.pop();
    visited += 1;
    if (depth > 24) continue;
    if (typeof value === 'string') {
      if (value === expected) matches += 1;
      const trimmed = value.trimStart();
      if ((trimmed.startsWith('[') || trimmed.startsWith('{')) && trimmed.length <= 2 * 1024 * 1024) {
        try { pending.push({ value: JSON.parse(trimmed), depth: depth + 1 }); } catch { /* Plain text. */ }
      }
    } else if (Array.isArray(value)) {
      for (const child of value) pending.push({ value: child, depth: depth + 1 });
    } else if (value && typeof value === 'object') {
      for (const child of Object.values(value)) pending.push({ value: child, depth: depth + 1 });
    }
  }
  return matches;
}

function contentDigest(strings) {
  return createHash('sha256').update(JSON.stringify(strings), 'utf8').digest('hex');
}

export async function runSharePublicReadOnce(envelope) {
  const contract = await loadObservedContract();
  const publicRead = contract.operations?.share_public_read;
  const allowedHeaders = new Set((publicRead?.request?.headerNames ?? []).map((name) => String(name).toLowerCase()));
  const forbiddenHeaders = new Set(['cookie', 'authorization', 'proxy-authorization', 'host', 'content-length']);
  for (const headers of envelope.requestHeaders) {
    for (const [name, value] of Object.entries(headers)) {
      const normalized = name.toLowerCase();
      if (!allowedHeaders.has(normalized) || forbiddenHeaders.has(normalized)
          || typeof value !== 'string' || value.length > 8192 || /[\0\r\n]/.test(value)) {
        fail('SHARE_PUBLIC_READ_HEADERS_INVALID', 'The captured public-share request headers exceeded the observed safe allowlist.');
      }
    }
  }
    const validatedSession = validateSessionBundle(envelope.session, contract);
    const session = {
      ...validatedSession,
      requestHeaders: Object.freeze({
        ...(validatedSession.requestHeaders ?? {}),
        history_read: validatedSession.requestHeaders?.history_read ?? validatedSession.requestHeaders?.history_list ?? {},
      }),
    };
  const taskClient = new GeminiWebClient({ contract, session });
  let taskConversationId = '';
  let history;
  let detail;
  let ownerLinks;
  try {
    const identity = await taskClient.refreshSession(envelope.expectedOwner);
    if (identity.ownerMatched !== true || identity.anonymousOwnerAbsent !== true) {
      fail('OWNER_VERIFICATION_FAILED', 'The current Gemini session did not match the expected owner.');
    }
    history = await listConversations(taskClient, { expectedOwner: envelope.expectedOwner });
    const titleRows = history.conversations.filter((item) => item.title === envelope.taskTitle);
    if (titleRows.length !== 1) fail('TASK_CONVERSATION_NOT_UNIQUE', 'The exact task title did not select one history conversation.');
    taskConversationId = titleRows[0].conversationId;
    if (taskConversationId.slice(2) !== envelope.historyRouteSuffix) {
      fail('TASK_ROUTE_ID_MISMATCH', 'The API conversation ID suffix did not match the captured task route suffix.');
    }
    ownerLinks = await readPublicShareLinks(taskClient, { expectedOwner: envelope.expectedOwner });
    const ownerTaskRowCount = publicShareConversationRowCount(ownerLinks.internal.data, envelope.taskTitle);
    if (ownerTaskRowCount !== 2) fail('OWNER_SHARE_ROWS_NOT_TWO', 'The owner list did not return the two exact task rows being verified.');
    const ownerRowShareIdCounts = envelope.shareIds.map((shareId) =>
      publicShareConversationRowHasId(ownerLinks.internal.data, envelope.taskTitle, shareId));
    if (ownerRowShareIdCounts.some((count) => count !== 1)) {
      fail('OWNER_SHARE_ID_ROW_BINDING_FAILED', 'Each copied public share ID must bind to one exact task row in the owner list.');
    }
    detail = await readConversation(taskClient, {
      expectedOwner: envelope.expectedOwner,
      conversationId: taskConversationId,
      expectedIntent: envelope.taskMarker,
    });
    const historyPayload = detail.payload;
    if (!historyPayload || detail.binding?.bound !== true) {
      fail('TASK_CONVERSATION_DETAIL_NOT_BOUND', 'The exact conversation ID did not bind to its current detail response.');
    }
    const historyTaskTexts = collectTaskText(historyPayload, { marker: envelope.taskMarker });
    if (historyTaskTexts.length === 0) fail('TASK_MARKER_NOT_IN_HISTORY_CONTENT', 'The direct conversation detail lacked the task content marker.');
    const shares = [];
    for (let index = 0; index < envelope.shareIds.length; index += 1) {
      const scopedSession = {
        ...session,
        requestHeaders: Object.freeze({
          ...(session.requestHeaders ?? {}),
          share_public_read: Object.freeze({ ...envelope.requestHeaders[index] }),
        }),
      };
      const shareClient = new GeminiWebClient({ contract, session: scopedSession });
      try {
        const result = await shareClient.readSharedConversation({
          shareId: envelope.shareIds[index],
          expectedOwner: envelope.expectedOwner,
        });
        const data = result.internal?.data;
        if (!data || result.ownerMatched !== true || result.anonymousOwnerAbsent !== true
            || result.httpStatus !== 200 || result.rpcId !== 'ujx1Bf' || result.credentialPropagated !== true) {
          fail('DIRECT_SHARE_READ_UNVERIFIED', 'A direct public-share replay failed its owner, HTTP, or RPC checks.');
        }
        const shareTaskTexts = collectTaskText(data, { marker: envelope.taskMarker });
        const sameTaskContent = JSON.stringify(shareTaskTexts) === JSON.stringify(historyTaskTexts);
        shares.push({
          ownerMatched: true,
          anonymousOwnerAbsent: true,
          credentialPropagated: true,
          httpStatus: result.httpStatus,
          contentType: result.contentType,
          responseBytes: result.responseBytes,
          responseSha256: result.responseSha256,
          rpcId: result.rpcId,
          shareIdLength: result.shareIdLength,
          responseDecoded: true,
          taskTitlePresent: exactValueCount(data, envelope.taskTitle) > 0,
          taskMarkerPresent: shareTaskTexts.some((value) => value.includes(envelope.taskMarker)),
          exactMarkerValueCount: exactValueCount(data, envelope.taskMarker),
          taskContentMatchesConversationDetail: sameTaskContent,
          taskContentDigest: contentDigest(shareTaskTexts),
          historyTaskContentDigest: contentDigest(historyTaskTexts),
          shareResponseEchoesConversationId: exactValueCount(data, taskConversationId) > 0,
        });
        if (data && typeof data === 'object') wipe(data);
      } finally {
        shareClient.transport.session = null;
      }
    }
    return Object.freeze({
      ownerMatched: true,
      anonymousOwnerAbsent: true,
      taskConversationCount: titleRows.length,
      taskConversationDetailBound: true,
      taskRouteSuffixMatchesHistoryId: true,
      historyResponseEchoesConversationId: detail.summary?.apiConversationIdMatched === true,
      historyDetailHttpStatus: detail.httpStatus,
      historyDetailResponseBytes: detail.responseBytes,
      historyDetailResponseSha256: detail.responseSha256,
      historyDetailRpcMatchCount: detail.summary?.rpcMatchCount,
      taskMarkerInHistoryDetail: true,
      ownerShareCount: ownerLinks.shareCount,
      ownerTaskRowCount: 2,
      ownerRowShareIdCounts,
      historyExactMarkerValueCount: exactValueCount(historyPayload, envelope.taskMarker),
      historyTaskContentDigest: contentDigest(historyTaskTexts),
      shares,
    });
  } finally {
    if (detail?.payload && typeof detail.payload === 'object') wipe(detail.payload);
    if (history?.data && typeof history.data === 'object') wipe(history.data);
    if (ownerLinks?.internal?.data && typeof ownerLinks.internal.data === 'object') wipe(ownerLinks.internal.data);
    taskConversationId = '';
    taskClient.transport.session = null;
  }
}

async function main() {
  let envelope;
  try {
    envelope = await readEnvelope();
    stdout.write(`${JSON.stringify(await runSharePublicReadOnce(envelope))}\n`);
    return 0;
  } finally {
    wipe(envelope);
  }
}

main().catch((error) => {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
    ? error.code : 'SHARE_PUBLIC_READ_FAILED';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
