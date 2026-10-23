#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { stdin, stdout } from 'node:process';
import { GeminiWebClient } from '../src/client.mjs';
import { validateSessionBundle } from '../src/session.mjs';

const REPO = new URL('../', import.meta.url);
const CONTRACT_PATH = new URL('../discovery/observed-contract.json', import.meta.url);
const ARTIFACT_ROOT = '/home/worker/artifacts/gemini-media-20261006';
const PREVIOUS_VIDEO_ARTIFACT = `${ARTIFACT_ROOT}/gemini-video-neutral-geometry-20261006.mp4`;
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 200_000;
const MAX_MEDIA_BYTES = 256 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const INTENT_HASHES = Object.freeze({
  image: 'abfe3f954d97a45ae70bfa0680a96e2e950b3648ba0d560c3d9cc01fa08b28a4',
  video: '798c662bed8d133dcf1804c0930ca0c2dd58a4589bd079c4cab23f8cd4a74f3c',
});

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizeText(value) {
  return String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function findRows(value, depth = 0, visited = { count: 0 }) {
  visited.count += 1;
  if (depth > 24 || visited.count > MAX_JSON_NODES) return null;
  if (Array.isArray(value)) {
    if (value.length >= 20 && value.slice(0, Math.min(5, value.length))
      .every((row) => Array.isArray(row) && row.length === 22)) return value;
    for (const item of value) {
      const found = findRows(item, depth + 1, visited);
      if (found) return found;
    }
  } else if (isRecord(value)) {
    for (const item of Object.values(value)) {
      const found = findRows(item, depth + 1, visited);
      if (found) return found;
    }
  }
  return null;
}

function toEpoch(value) {
  if (typeof value === 'boolean' || value === null || value === undefined) return null;
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) return null;
  if (number >= 1_700_000_000 && number <= 2_000_000_000) return number;
  if (number >= 1_700_000_000_000 && number <= 2_000_000_000_000) return number / 1000;
  if (number >= 1_700_000_000_000_000 && number <= 2_000_000_000_000_000) return number / 1_000_000;
  return null;
}

function directTaskCandidates(rows, windows, visibleRouteIds = [], limit = 2) {
  const candidates = [];
  for (const [capability, window] of Object.entries(windows)) {
    let best = null;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const epoch = toEpoch(row?.[5]?.[0]);
      const apiId = row?.[0];
      if (!epoch || epoch < window.start || epoch > window.end
          || typeof apiId !== 'string' || !/^c_[0-9a-f]{16}$/.test(apiId)) continue;
      const distance = Math.abs(epoch - window.midpoint);
      if (!best || distance < best.distance) best = {
        rowIndex: index, epoch, apiId, routeId: apiId.slice(2), distance,
        timeWindowHint: capability, routeVisibleInCurrentHistoryList: visibleRouteIds.includes(apiId.slice(2)),
      };
    }
    if (best) candidates.push(best);
  }
  candidates.sort((a, b) => a.epoch - b.epoch || a.rowIndex - b.rowIndex);
  const seen = new Set();
  return candidates.filter((item) => {
    if (seen.has(item.apiId)) return false;
    seen.add(item.apiId);
    return true;
  }).slice(0, limit);
}

function valueAtPath(root, path) {
  let value = root;
  for (const part of path) {
    if (value === null || value === undefined) return undefined;
    value = value[part];
  }
  return value;
}

function findTaskTurn(payload, expectedHash) {
  const matches = [];
  let visited = 0;
  function walk(value, path = [], depth = 0) {
    visited += 1;
    if (depth > MAX_JSON_DEPTH || visited > MAX_JSON_NODES || matches.length >= 20) return;
    if (typeof value === 'string') {
      const normalized = normalizeText(value);
      if (sha256(Buffer.from(value, 'utf8')) === expectedHash || sha256(Buffer.from(normalized, 'utf8')) === expectedHash) {
        matches.push({ path, normalizedLength: normalized.length });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, [...path, index], depth + 1));
    } else if (isRecord(value)) {
      for (const [key, item] of Object.entries(value)) walk(item, [...path, key], depth + 1);
    }
  }
  walk(payload);
  const exact = matches.find((item) => {
    const tail = item.path.slice(-3);
    return tail.length === 3 && tail[0] === 2 && tail[1] === 0 && tail[2] === 0;
  });
  if (!exact) return { exactPromptMatch: matches.length > 0, exactTurnFound: false, matches: matches.length, turn: null, assistant: null };
  const turnPath = exact.path.slice(0, -3);
  const turn = valueAtPath(payload, turnPath);
  const assistant = Array.isArray(turn?.[3]) ? turn[3][0] : undefined;
  return { exactPromptMatch: true, exactTurnFound: assistant !== undefined, matches: matches.length, turn, assistant };
}

function collectStrings(value, { path = [], out = [], visited = { count: 0 }, depth = 0 } = {}) {
  visited.count += 1;
  if (depth > MAX_JSON_DEPTH || visited.count > MAX_JSON_NODES || out.length >= 500) return out;
  if (typeof value === 'string') {
    out.push({ value, path });
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => collectStrings(item, { path: [...path, index], out, visited, depth: depth + 1 }));
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (/(thought|analysis|reasoning|scratch|system|auth|cookie|token|secret|prompt)/i.test(key)) continue;
      collectStrings(item, { path: [...path, key], out, visited, depth: depth + 1 });
    }
  }
  return out;
}

function assistantTextSummary(assistant, mediaUrlCount, inlineCount) {
  const all = collectStrings(assistant);
  const candidates = all.map((entry) => normalizeText(entry.value))
    .filter((value) => value.length >= 4 && value.length <= 20_000
      && !/^https?:\/\//i.test(value) && !/^data:/i.test(value)
      && !/^c_[0-9a-f]{16}$/i.test(value)
      && !/^[A-Za-z0-9_-]{20,}$/.test(value));
  const joined = candidates.join('\n');
  const lower = joined.toLocaleLowerCase('en-US');
  let classification = 'assistant_text_present';
  if (/\b(i can(?:not|'t)|i am unable|unable to|cannot help|can't help|won't be able)\b/.test(lower)) {
    classification = 'service_refusal_or_capability_limit';
  } else if (/\b(something went wrong|failed to|unable to complete|try again later|temporarily unavailable|request failed)\b/.test(lower)) {
    classification = 'service_error_or_transient_failure';
  } else if (!candidates.length && (mediaUrlCount > 0 || inlineCount > 0)) {
    classification = 'media_result_without_user_facing_text';
  } else if (!candidates.length) {
    classification = 'no_user_facing_assistant_text_or_media';
  }
  return Object.freeze({
    classification,
    candidateTextCount: candidates.length,
    mainTextLength: candidates.length ? candidates[0].length : 0,
    mainTextSha256: candidates.length ? sha256(Buffer.from(candidates[0], 'utf8')) : null,
    allCandidateTextSha256: candidates.length ? sha256(Buffer.from(joined, 'utf8')) : null,
  });
}

function statusClass(value) {
  let visited = 0;
  let statusFields = 0;
  let success = 0;
  let failure = 0;
  let pending = 0;
  function walk(item, depth = 0) {
    visited += 1;
    if (depth > MAX_JSON_DEPTH || visited > MAX_JSON_NODES) return;
    if (Array.isArray(item)) {
      item.forEach((child) => walk(child, depth + 1));
    } else if (isRecord(item)) {
      for (const [key, child] of Object.entries(item)) {
        if (/(status|error|failure|blocked|safety|state|result)/i.test(key)
            && (typeof child === 'string' || typeof child === 'number')) {
          statusFields += 1;
          const text = String(child).toLowerCase();
          if (/success|complete|completed|done|ready|generated|succeeded/.test(text)) success += 1;
          else if (/error|fail|blocked|refus|denied|unavailable|unsupported/.test(text)) failure += 1;
          else if (/pending|processing|queued|running/.test(text)) pending += 1;
        }
        if (/(thought|analysis|reasoning|scratch|system|auth|cookie|token|secret)/i.test(key)) continue;
        walk(child, depth + 1);
      }
    }
  }
  walk(value);
  return Object.freeze({
    fieldCount: statusFields,
    classification: failure ? 'explicit_failure_or_refusal_status'
      : pending ? 'explicit_pending_status'
        : success ? 'explicit_success_status'
          : statusFields ? 'unclassified_status_field' : 'no_named_status_field',
  });
}

function safeUrlReference(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return null;
    const pathFamily = url.pathname.split('/').map((part) => (
      part.length > 40 || /^[0-9a-f-]{16,}$/i.test(part) ? '{id}' : part
    )).join('/');
    return Object.freeze({
      origin: url.origin,
      pathFamily,
      queryKeyNames: [...new Set(url.searchParams.keys())],
    });
  } catch { return null; }
}

function firstPartyGoogleOrigin(origin) {
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false;
    return host === 'googleusercontent.com' || host.endsWith('.googleusercontent.com')
      || host === 'gstatic.com' || host.endsWith('.gstatic.com')
      || host === 'usercontent.google.com' || host.endsWith('.usercontent.google.com');
  } catch { return false; }
}

function collectUrls(value) {
  const urls = [];
  let visited = 0;
  function walk(item, depth = 0) {
    visited += 1;
    if (depth > MAX_JSON_DEPTH || visited > MAX_JSON_NODES || urls.length >= 200) return;
    if (typeof item === 'string') {
      if (item.startsWith('https://')) urls.push(item);
      return;
    }
    if (Array.isArray(item)) item.forEach((child) => walk(child, depth + 1));
    else if (isRecord(item)) Object.values(item).forEach((child) => walk(child, depth + 1));
  }
  walk(value);
  return [...new Set(urls)];
}

function collectInlineCandidates(value, capability) {
  const found = [];
  let visited = 0;
  function inspect(raw) {
    if (raw.length > 32 * 1024 * 1024) return;
    const dataUri = /^data:(image\/[A-Za-z0-9.+-]+|video\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/s.exec(raw);
    if (dataUri) {
      try {
        const bytes = Buffer.from(dataUri[2], 'base64');
        if (validMedia(dataUri[1], bytes, capability)) found.push({ mime: normalizeMime(dataUri[1]), bytes });
      } catch { /* Ignore malformed inline data. */ }
      return;
    }
    if (raw.length < 1024 || raw.length > 32 * 1024 * 1024 || raw.length % 4 !== 0 || !/^[A-Za-z0-9+/=\r\n]+$/.test(raw)) return;
    try {
      const bytes = Buffer.from(raw, 'base64');
      const detected = detectMedia(bytes);
      if (detected && mediaKind(detected) === capability) found.push({ mime: detected, bytes });
    } catch { /* Ignore non-media strings. */ }
  }
  function walk(item, depth = 0) {
    visited += 1;
    if (depth > MAX_JSON_DEPTH || visited > MAX_JSON_NODES || found.length >= 4) return;
    if (typeof item === 'string') { inspect(item); return; }
    if (Array.isArray(item)) item.forEach((child) => walk(child, depth + 1));
    else if (isRecord(item)) Object.values(item).forEach((child) => walk(child, depth + 1));
  }
  walk(value);
  return found;
}

function normalizeMime(value) {
  return String(value || '').split(';', 1)[0].trim().toLowerCase();
}

function mediaKind(mime) {
  return mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'other';
}

function detectMedia(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString())) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString() === 'ftyp') {
    const brand = bytes.subarray(8, 12).toString();
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (brand === 'qt  ') return 'video/quicktime';
    return 'video/mp4';
  }
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video/webm';
  if (bytes.length > 0) {
    const sample = bytes.subarray(0, Math.min(bytes.length, 4096)).toString('utf8').replace(/^\uFEFF/, '').trimStart();
    if (/^(?:<\?xml[^>]*>\s*)?<svg\b/i.test(sample)) return 'image/svg+xml';
  }
  return null;
}

function validMedia(mime, bytes, capability) {
  const normalized = normalizeMime(mime);
  const detected = detectMedia(bytes);
  return detected === normalized && mediaKind(detected) === capability;
}

function extensionForMime(mime) {
  return ({
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/svg+xml': 'svg',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  })[mime] ?? null;
}

function normalizeExpectedOrigins(values) {
  if (!Array.isArray(values)) return new Set();
  const exact = new Set();
  for (const value of values) {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash
          && firstPartyGoogleOrigin(url.origin)) exact.add(url.origin);
    } catch { /* Ignore malformed allowlist values. */ }
  }
  return exact;
}

function safeRedirect(ref, status) {
  return Object.freeze({
    httpStatus: status,
    origin: ref.origin,
    pathFamily: ref.pathFamily,
    queryKeyNames: ref.queryKeyNames,
  });
}

async function readResponseBounded(response, deadline) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_MEDIA_BYTES) throw new Error('asset_too_large');
  const chunks = [];
  let total = 0;
  if (!response.body) throw new Error('asset_body_missing');
  const reader = response.body.getReader();
  while (true) {
    if (Date.now() > deadline) {
      await reader.cancel().catch(() => {});
      throw new Error('asset_time_limit');
    }
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_MEDIA_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error('asset_too_large');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

async function saveVerifiedArtifact(capability, mime, bytes) {
  const extension = extensionForMime(mime);
  if (!extension || detectMedia(bytes) !== mime || mediaKind(mime) !== capability) {
    return { saved: false, reason: 'mime_magic_mismatch' };
  }
  const filename = `gemini-${capability}-neutral-geometry-20261006.direct-http.${extension}`;
  const target = `${ARTIFACT_ROOT}/${filename}`;
  let handle;
  try { handle = await open(target, 'wx', 0o600); }
  catch (error) {
    if (error?.code === 'EEXIST') return { saved: false, reason: 'artifact_path_exists', filename };
    return { saved: false, reason: 'artifact_write_failed' };
  }
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const reread = await readFile(target);
  const magicMime = detectMedia(reread);
  const fileHash = sha256(reread);
  return {
    saved: magicMime === mime && reread.length === bytes.length,
    filename,
    path: target,
    mime,
    bytes: reread.length,
    fileSha256: fileHash,
    magicMime,
    magicVerified: magicMime === mime,
    independentFileReadback: magicMime === mime && reread.length === bytes.length,
  };
}

async function directAssetFetch(url, capability, observedOrigins, redirectOrigins, comparePath = null) {
  const observed = normalizeExpectedOrigins(observedOrigins);
  const redirectObserved = normalizeExpectedOrigins(redirectOrigins);
  let current;
  try { current = new URL(url); } catch { return { status: 'asset_url_rejected', redirects: [], artifact: null }; }
  if (current.protocol !== 'https:' || current.username || current.password || current.hash
      || !firstPartyGoogleOrigin(current.origin) || !observed.has(current.origin)) {
    return { status: 'asset_origin_not_task_observed', redirects: [], artifact: null };
  }
  const redirects = [];
  const deadline = Date.now() + 45_000;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (Date.now() > deadline) return { status: 'asset_time_limit', redirects, artifact: null };
    const response = await fetch(current, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location || hop === MAX_REDIRECTS) return { status: 'redirect_limit', httpStatus: response.status, redirects, artifact: null };
      let next;
      try { next = new URL(location, current); } catch { return { status: 'redirect_url_invalid', httpStatus: response.status, redirects, artifact: null }; }
      if (next.protocol !== 'https:' || next.username || next.password || next.hash
          || !firstPartyGoogleOrigin(next.origin)
          || (!observed.has(next.origin) && !redirectObserved.has(next.origin))) {
        const blockedRef = next.protocol === 'https:' && !next.username && !next.password && firstPartyGoogleOrigin(next.origin)
          ? safeUrlReference(next.href) : null;
        return {
          status: 'redirect_origin_unobserved', httpStatus: response.status,
          blockedRedirectRef: blockedRef,
          blockedRedirectReason: firstPartyGoogleOrigin(next.origin)
            ? 'first_party_origin_not_in_task_observation' : 'destination_not_approved_first_party',
          redirects, artifact: null,
        };
      }
      const ref = safeUrlReference(next.href);
      if (!ref) return { status: 'redirect_url_invalid', httpStatus: response.status, redirects, artifact: null };
      redirects.push(safeRedirect(ref, response.status));
      current = next;
      continue;
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      return { status: 'asset_http_rejected', httpStatus: response.status, mime: normalizeMime(response.headers.get('content-type')), redirects, artifact: null };
    }
    const contentMime = normalizeMime(response.headers.get('content-type'));
    let bytes;
    try { bytes = await readResponseBounded(response, deadline); }
    catch (error) {
      await response.body?.cancel().catch(() => {});
      return { status: error?.message === 'asset_too_large' ? 'asset_too_large' : 'asset_read_failed', httpStatus: 200, mime: contentMime, redirects, artifact: null };
    }
    const magicMime = detectMedia(bytes);
    const mimeMatched = magicMime === contentMime && mediaKind(magicMime) === capability;
    let artifact = null;
    if (mimeMatched) artifact = await saveVerifiedArtifact(capability, contentMime, bytes);
    const result = {
      status: mimeMatched ? (artifact?.saved ? 'artifact_verified' : 'artifact_save_failed') : 'mime_magic_mismatch',
      httpStatus: 200,
      mime: contentMime,
      magicMime,
      bytes: bytes.length,
      sha256: sha256(bytes),
      mimeMagicMatched: mimeMatched,
      credentialsSent: false,
      redirects,
      artifact,
    };
    if (comparePath && capability === 'video' && artifact?.saved) {
      try { result.previousBrowserArtifactSha256 = sha256(await readFile(comparePath)); }
      catch { result.previousBrowserArtifactReadback = false; }
      result.previousBrowserArtifactHashMatched = result.previousBrowserArtifactSha256 === result.sha256;
    }
    bytes.fill(0);
    return result;
  }
  return { status: 'redirect_limit', redirects, artifact: null };
}

function findMediaTaskPayload(payload, expectedCapability) {
  const matches = Object.entries(INTENT_HASHES).map(([capability, hash]) => {
    const result = findTaskTurn(payload, hash);
    return { capability, hash, ...result };
  }).filter((item) => item.exactPromptMatch);
  const task = matches.find((item) => item.capability === expectedCapability) ?? matches[0] ?? null;
  if (!task) return { matches: [], task: null, refs: [], inline: [], textSummary: assistantTextSummary(null, 0, 0) };
  const refs = [];
  const inline = collectInlineCandidates(task.turn, task.capability);
  for (const rawUrl of collectUrls(task.turn)) {
    const ref = safeUrlReference(rawUrl);
    if (ref) refs.push({ rawUrl, ref });
  }
  return {
    matches: matches.map((item) => item.capability), task,
    refs: refs.slice(0, 100), inline: inline.slice(0, 4),
    textSummary: assistantTextSummary(task.assistant, refs.length, inline.length),
  };
}

async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) throw new Error('input_too_large');
    chunks.push(Buffer.from(chunk));
  }
  if (!size) throw new Error('input_empty');
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
}

async function main() {
  const input = await readInput();
  if (!isRecord(input) || !isRecord(input.session) || typeof input.expectedOwner !== 'string'
      || !isRecord(input.windows) || !Array.isArray(input.visibleRouteIds) || !isRecord(input.cdpObservedAssetOrigins)
      || !isRecord(input.cdpRedirectOrigins)) throw new Error('input_shape_invalid');
  const detailReadLimit = Number.isSafeInteger(input.maxDetailReads) ? input.maxDetailReads : 2;
  if (detailReadLimit < 1 || detailReadLimit > 2
      || (input.allowPrivateAssetUrlPipe === true && input.skipAssetFetch !== true)) {
    throw new Error('detail_read_limit_invalid');
  }
  const contract = JSON.parse(await readFile(CONTRACT_PATH, 'utf8'));
  const session = validateSessionBundle(input.session, contract);
  const client = new GeminiWebClient({ contract, session });
  const owner = await client.refreshSession(input.expectedOwner);
  if (!owner.ownerMatched || !owner.anonymousOwnerAbsent) {
    stdout.write(JSON.stringify({
      phase: 'direct_http_owner_gate', ownerMatched: owner.ownerMatched,
      anonymousOwnerAbsent: owner.anonymousOwnerAbsent, directHistoryListStatus: null,
      detailReadCount: 0, candidates: [],
    }));
    return;
  }
  client.nextHistoryRequestId = Number(client.transport.session.batchContext.requestId) + 1;
  const list = await client.listHistory();
  const rows = findRows(list.data);
  if (!rows) {
    stdout.write(JSON.stringify({
      phase: 'direct_http_history_list', ownerMatched: true, anonymousOwnerAbsent: true,
      directHistoryListStatus: list.httpStatus, directHistoryListBytes: list.responseBytes,
      directHistoryListRpcId: list.rpcId, candidateRowsRecognized: false, detailReadCount: 0, candidates: [],
    }));
    return;
  }
  const candidates = directTaskCandidates(rows, input.windows, input.visibleRouteIds, detailReadLimit);
  const results = [];
  for (const candidate of candidates) {
    const updatedRequestHeaders = {
      ...client.transport.session.requestHeaders,
      history_read: {
        ...(client.transport.session.requestHeaders?.history_read ?? {}),
        referer: `https://gemini.google.com/app/${candidate.routeId}`,
      },
    };
    client.transport.session = validateSessionBundle({
      ...client.transport.session, requestHeaders: updatedRequestHeaders,
    }, contract);
    let result;
    try {
      result = await client.readHistoryDetail({
        apiConversationId: candidate.apiId,
        visibleRouteId: candidate.routeId,
      });
    } catch (error) {
      results.push({
        rowIndex: candidate.rowIndex,
        timeWindowHint: candidate.timeWindowHint,
        routeBindingVerified: candidate.apiId.slice(2) === candidate.routeId,
        detailStatus: 'direct_http_failed',
        errorCode: typeof error?.code === 'string' ? error.code : 'HISTORY_DETAIL_FAILED',
      });
      continue;
    }
    const media = findMediaTaskPayload(result.payload, candidate.timeWindowHint);
    const apiIdEchoed = JSON.stringify(result.payload ?? null).includes(candidate.apiId);
    const taskMatched = media.matches.length > 0;
    const selectedTask = media.task;
    const cdpObserved = normalizeExpectedOrigins(input.cdpObservedAssetOrigins[selectedTask?.capability] ?? []);
    const apiTaskObserved = new Set(media.refs.map(({ ref }) => ref.origin).filter((origin) => firstPartyGoogleOrigin(origin)));
    const allowed = new Set([...cdpObserved, ...apiTaskObserved]);
    const references = media.refs.filter(({ ref }) => allowed.has(ref.origin));
    const deniedReferenceCount = media.refs.length - references.length;
    let inlineArtifact = null;
    if (selectedTask && media.inline.length) {
      const candidateInline = media.inline[0];
      const extension = extensionForMime(candidateInline.mime);
      if (extension) {
        const artifact = await saveVerifiedArtifact(selectedTask.capability, candidateInline.mime, candidateInline.bytes);
        inlineArtifact = {
          source: 'direct_http_history_inline',
          bytes: candidateInline.bytes.length,
          mime: candidateInline.mime,
          sha256: sha256(candidateInline.bytes),
          mimeMagicMatched: true,
          artifact,
        };
      }
      for (const item of media.inline) item.bytes.fill(0);
    }
    let asset = null;
    if (selectedTask && !inlineArtifact && references.length && input.skipAssetFetch !== true) {
      const preferred = references.find(({ ref }) => ref.origin === input.preferredAssetOrigin?.[selectedTask.capability])
        ?? references[0];
      asset = await directAssetFetch(
        preferred.rawUrl,
        selectedTask.capability,
        [...allowed],
        [...normalizeExpectedOrigins(input.cdpRedirectOrigins[selectedTask.capability] ?? []), ...allowed],
        selectedTask.capability === 'video' ? PREVIOUS_VIDEO_ARTIFACT : null,
      );
    }
    results.push({
      rowIndex: candidate.rowIndex,
      timeWindowHint: candidate.timeWindowHint,
      deltaFromWindowMidpointSeconds: Number(candidate.distance.toFixed(3)),
      routeVisibleInCurrentHistoryList: candidate.routeVisibleInCurrentHistoryList,
      routeBindingVerified: result.binding.bound,
      rawApiIdUsedInRequest: result.binding.rawApiIdUsedInRequest,
      prefixRemovedFromRequest: result.binding.prefixRemovedFromRequest,
      httpStatus: result.httpStatus,
      contentType: result.contentType,
      responseBytes: result.responseBytes,
      responseSha256: result.responseSha256,
      detailResponseCount: result.summary.rpcMatchCount,
      responseFrameCount: result.summary.frameCount,
      responseFraming: result.summary.framing,
      apiIdEchoedInDetail: apiIdEchoed,
      matchedTaskCapabilities: media.matches,
      exactTaskPromptHashMatched: taskMatched,
      exactTaskTurnLocated: Boolean(selectedTask?.exactTurnFound),
      assistantTextStatus: media.textSummary,
      assistantServiceStatus: selectedTask ? statusClass(selectedTask.turn) : { fieldCount: 0, classification: 'exact_task_turn_unavailable' },
      taskMediaUrlCandidateCount: media.refs.length,
      permittedTaskMediaReferences: references.slice(0, 20).map(({ ref }) => ref),
      cdpObservedAssetOrigins: [...cdpObserved],
      directTaskTurnAssetOrigins: [...apiTaskObserved],
      blockedTaskMediaReferenceCount: deniedReferenceCount,
      inlineArtifact: inlineArtifact && {
        source: inlineArtifact.source, bytes: inlineArtifact.bytes, mime: inlineArtifact.mime,
        sha256: inlineArtifact.sha256, mimeMagicMatched: inlineArtifact.mimeMagicMatched,
        artifact: inlineArtifact.artifact,
      },
      directAssetFetch: asset,
      ...(input.allowPrivateAssetUrlPipe === true && selectedTask?.capability === 'video' && references.length
        ? { privateAssetUrl: (references.find(({ ref }) => ref.origin === input.preferredAssetOrigin?.video) ?? references[0]).rawUrl }
        : {}),
      credentialPropagatedToDetail: result.credentialPropagated,
    });
  }
  stdout.write(JSON.stringify({
    phase: 'direct_http_history_readback',
    ownerMatched: true,
    anonymousOwnerAbsent: true,
    identityCredentialPropagated: owner.credentialPropagated,
    directHistoryList: {
      httpStatus: list.httpStatus,
      contentType: list.contentType,
      responseBytes: list.responseBytes,
      responseSha256: list.responseSha256,
      rpcId: list.rpcId,
      summaryCount: rows.length,
      detailReadCount: results.length,
      detailReadLimit,
    },
    candidates: results,
    persistence: {
      rawApiIdsPersisted: false,
      expectedTaskTextPersisted: false,
      signedUrlValuesPersisted: false,
      detailResponseBodiesPersisted: false,
      sessionValuesPersisted: false,
    },
  }));
}

main().catch((error) => {
  stdout.write(JSON.stringify({
    phase: 'direct_http_history_readback',
    status: 'failed',
    errorCode: typeof error?.code === 'string' ? error.code : 'MEDIA_API_READBACK_FAILED',
    errorClass: error?.constructor?.name ?? 'Error',
    detailReadCount: 0,
    persistence: { rawApiIdsPersisted: false, expectedTaskTextPersisted: false, signedUrlValuesPersisted: false, sessionValuesPersisted: false },
  }));
  process.exitCode = 1;
});
