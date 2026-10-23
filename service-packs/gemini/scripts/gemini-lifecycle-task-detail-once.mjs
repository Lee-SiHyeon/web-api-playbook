import { createHash } from 'node:crypto';
import { writeSync } from 'node:fs';
import { stdin, stdout, stderr } from 'node:process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GeminiWebClient } from '../src/client.mjs';
import { loadObservedContract } from '../src/contract.mjs';
import { readGeminiHistoryTurnResponse } from '../src/history-turn-response.mjs';
import { extractConversationSummaries } from '../src/conversation-lifecycle.mjs';
import { readSessionBundleFromStdin } from '../src/session.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const OWNER_SHA256 = '23e57131977ce522bacf6649eb27538770828a890f7a65589ec4f0960a84b3d7';
const FIXTURE_MARKER = 'LIFECYCLE42';
const sha = (value) => createHash('sha256').update(value).digest('hex');

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

async function readPacket() {
  if (!stdin || stdin.isTTY === true) fail('LIFECYCLE_TARGET_ENVELOPE_REQUIRED');
  const chunks = [];
  let size = 0;
  for await (const chunk of stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    size += bytes.length;
    if (size > MAX_INPUT_BYTES) fail('LIFECYCLE_TARGET_ENVELOPE_TOO_LARGE');
    chunks.push(Buffer.from(bytes));
  }
  if (!size) fail('LIFECYCLE_TARGET_ENVELOPE_REQUIRED');
  const raw = Buffer.concat(chunks, size);
  try { return JSON.parse(raw.toString('utf8')); }
  catch { fail('LIFECYCLE_TARGET_ENVELOPE_INVALID'); }
  finally {
    raw.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

function isoWithin(value, startMs, endMs) {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) && parsed >= startMs && parsed <= endMs;
}

function wipeTree(value, depth = 0) {
  if (depth > 32 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (typeof value[index] === 'string') value[index] = '';
      else wipeTree(value[index], depth + 1);
    }
    value.length = 0;
    return;
  }
  for (const key of Object.keys(value)) {
    if (typeof value[key] === 'string') value[key] = '';
    else wipeTree(value[key], depth + 1);
    delete value[key];
  }
}

async function run(packet) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)
      || Object.keys(packet).some((key) => !['session', 'expectedOwner', 'expectedPrompt', 'windowStart', 'windowEnd', 'priorResponseIdMatched', 'reservedTitle'].includes(key))
      || typeof packet.expectedOwner !== 'string' || typeof packet.expectedPrompt !== 'string'
      || packet.expectedPrompt.length > 8000 || /[\0]/.test(packet.expectedPrompt)
      || packet.expectedPrompt.trim().length < 1
      || packet.priorResponseIdMatched !== true
      || (packet.reservedTitle !== undefined && (typeof packet.reservedTitle !== 'string'
        || !packet.reservedTitle.trim() || packet.reservedTitle.length > 160 || /[\0\r\n]/.test(packet.reservedTitle)))
      || typeof packet.windowStart !== 'string' || typeof packet.windowEnd !== 'string'
      || !Number.isFinite(Date.parse(packet.windowStart)) || !Number.isFinite(Date.parse(packet.windowEnd))
      || Date.parse(packet.windowEnd) < Date.parse(packet.windowStart)) fail('LIFECYCLE_TARGET_ENVELOPE_INVALID');
  const ownerSha = sha(packet.expectedOwner.trim().toLowerCase());
  if (ownerSha !== OWNER_SHA256) fail('EXPECTED_OWNER_NOT_UNIQUE');
  const contract = await loadObservedContract(path.join(ROOT, 'discovery/observed-contract.json'));
  const session = await readSessionBundleFromStdin(contract, {
    input: ReadableFromPacket(packet.session),
    maxBytes: MAX_INPUT_BYTES,
  });
  const client = new GeminiWebClient({ contract, session });
  let listed;
  let searched;
  let detail;
  try {
    const identity = await client.refreshSession(packet.expectedOwner);
    if (identity.ownerMatched !== true || identity.anonymousOwnerAbsent !== true) fail('OWNER_VERIFICATION_FAILED');
    listed = await client.listHistory();
    if (listed.httpStatus !== 200 || listed.credentialPropagated !== true) fail('LIFECYCLE_HISTORY_LIST_FAILED');
    const rows = extractConversationSummaries(listed.data, { maxItems: 500 });
    const startMs = Date.parse(packet.windowStart);
    const endMs = Date.parse(packet.windowEnd);
    const timeCandidates = rows.filter((row) => isoWithin(row.updatedAt, startMs, endMs));
    if (timeCandidates.length !== 1) {
      return {
        operation: 'lifecycle_fixture_task_readback',
        ownerMatched: true,
        anonymousOwnerAbsent: true,
        listHttpStatus: listed.httpStatus,
        windowCandidateCount: timeCandidates.length,
        detailReadCount: 0,
        taskPromptMatched: false,
        apiConversationIdEchoMatched: false,
        routeBindingVerified: false,
        sourceTurnMatched: false,
        structuredSourceShapeComplete: false,
        assistantMarkerMatched: false,
        identifiersOrContentPersisted: false,
      };
    }
    const candidate = timeCandidates[0];
    const reservedTitleAbsent = typeof packet.reservedTitle !== 'string'
      || rows.every((row) => row.title !== packet.reservedTitle);
    searched = await client.searchHistory({ expectedOwner: packet.expectedOwner, query: FIXTURE_MARKER });
    if (searched.httpStatus !== 200 || searched.credentialPropagated !== true) fail('LIFECYCLE_HISTORY_SEARCH_FAILED');
    const encodedSearch = JSON.stringify(searched.data);
    const searchMatched = encodedSearch.includes(candidate.conversationId);
    detail = await client.readHistoryDetail({
      apiConversationId: candidate.conversationId,
      visibleRouteId: candidate.conversationId.slice(2),
      expectedIntent: packet.expectedPrompt,
    });
    const sourceTurn = readGeminiHistoryTurnResponse(detail.payload, { prompt: packet.expectedPrompt });
    const structuredTexts = sourceTurn.internal?.structuredTextCandidates ?? [];
    const assistantMarkerMatched = structuredTexts.some((value) => typeof value === 'string'
      && value.includes(FIXTURE_MARKER) && /\b42\b/.test(value));
    const priorWriterCorrelation = packet.expectedPrompt.includes(FIXTURE_MARKER);
    const verified = detail.httpStatus === 200 && detail.binding?.bound === true
      && detail.summary?.apiConversationIdMatched === true
      && detail.summary?.taskIntentMatched === true
      && sourceTurn.matched === true && sourceTurn.exactPromptTurnCount === 1
      && searchMatched;
    const result = {
      operation: 'lifecycle_fixture_task_readback',
      ownerMatched: true,
      anonymousOwnerAbsent: true,
      listHttpStatus: listed.httpStatus,
      searchHttpStatus: searched.httpStatus,
      detailHttpStatus: detail.httpStatus,
      windowCandidateCount: timeCandidates.length,
      searchMatchedWindowCandidate: searchMatched,
      detailReadCount: 1,
      taskPromptMatched: detail.summary?.taskIntentMatched === true,
      apiConversationIdEchoMatched: detail.summary?.apiConversationIdMatched === true,
      routeBindingVerified: detail.binding?.bound === true,
      sourceTurnMatched: sourceTurn.matched === true,
      sourceTurnPathDepth: Array.isArray(sourceTurn.turnPath) ? sourceTurn.turnPath.length : null,
      structuredContentPresent: sourceTurn.structuredContentPresent === true,
      structuredTextCandidateCount: sourceTurn.structuredTextCandidateCount,
      structuredUnclassifiedChildCount: sourceTurn.structuredUnclassifiedChildCount,
      structuredSourceShapeComplete: sourceTurn.structuredSourceShapeComplete === true,
      assistantMarkerMatched,
      writerPromptIncludesMarker: priorWriterCorrelation,
      priorDirectResponseIdMatched: packet.priorResponseIdMatched,
      taskBound: verified,
      reservedTitleAbsent,
      identifiersOrContentPersisted: false,
    };
    Object.defineProperty(result, 'privateHandoff', {
      value: { apiConversationId: candidate.conversationId, title: candidate.title },
      enumerable: false,
    });
    return result;
  } finally {
    client.transport.session = null;
    if (listed?.data) wipeTree(listed.data);
    if (searched?.data) wipeTree(searched.data);
    if (detail?.payload) wipeTree(detail.payload);
    packet.expectedOwner = '';
    packet.expectedPrompt = '';
    packet.session = null;
  }
}

// Turn an already-parsed in-memory bundle back into a bounded stdin stream so
// the production session validator remains the only session entry point.
function ReadableFromPacket(session) {
  const serialized = JSON.stringify(session);
  return Object.assign((async function* yieldBytes() { yield serialized; })(), { isTTY: false });
}

async function main() {
  let packet;
  try {
    packet = await readPacket();
    const result = await run(packet);
    const handoffFd = Number(process.env.GEMINI_LIFECYCLE_TARGET_FD || 0);
    if (handoffFd !== 0) {
      if (!Number.isSafeInteger(handoffFd) || handoffFd < 3 || result.taskBound !== true
          || typeof result.privateHandoff?.apiConversationId !== 'string'
          || typeof result.privateHandoff?.title !== 'string' || result.reservedTitleAbsent !== true) {
        fail('LIFECYCLE_TARGET_HANDOFF_INVALID');
      }
      const handoff = Buffer.from(`${JSON.stringify(result.privateHandoff)}\n`, 'utf8');
      try { writeSync(handoffFd, handoff); } finally { handoff.fill(0); }
      result.privateHandoff.apiConversationId = '';
      result.privateHandoff.title = '';
    }
    stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.code)
      ? error.code : 'LIFECYCLE_TASK_READBACK_FAILED';
    stdout.write(JSON.stringify({ operation: 'lifecycle_fixture_task_readback', verified: false, error: code }) + '\n');
    process.exitCode = 1;
  } finally {
    if (packet) wipeTree(packet);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
