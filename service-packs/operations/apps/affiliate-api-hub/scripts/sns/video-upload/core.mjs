import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, mkdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const PRIVATE = 'private';
const NONPUBLIC_VISIBILITIES = new Set(['private', 'only_me', 'draft']);
const PHASE_NAME = /^[a-z][a-z0-9._-]{1,79}$/;
const POST_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PLATFORM_HOSTS = Object.freeze({
  youtube: new Set(['youtube.com', 'www.youtube.com', 'studio.youtube.com', 'youtu.be']),
  instagram: new Set(['instagram.com', 'www.instagram.com']),
  'naver-clip': new Set(['clip.naver.com', 'clipcreators.naver.com']),
});
const PLATFORM_OWNERS = Object.freeze({
  youtube: 'UCtLdZc1Ooz6KLbDNfo60E5A',
  instagram: 'lifehack__ailab',
  'naver-clip': '@lifehack__ailab',
});

export class VideoUploadError extends Error {
  constructor(code, message = code, details = {}) {
    super(message);
    this.name = 'VideoUploadError';
    this.code = code;
    Object.assign(this, details);
  }
}

function fail(code, message, details) {
  throw new VideoUploadError(code, message, details);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function hashFile(file) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  }).catch(() => fail('VIDEO_FILE_UNREADABLE'));
  return hash.digest('hex');
}

function normalizeText(value, field, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) fail('VIDEO_UPLOAD_INPUT_INVALID', `${field} is required`);
    return '';
  }
  if (typeof value !== 'string' || (required && !value.trim())) {
    fail('VIDEO_UPLOAD_INPUT_INVALID', `${field} must be a ${required ? 'nonempty ' : ''}string`);
  }
  return value.trim();
}

function normalizeInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('VIDEO_UPLOAD_INPUT_INVALID');
  }
  const visibility = input.visibility === 'only-me' ? 'only_me' : (input.visibility ?? PRIVATE);
  if (typeof visibility !== 'string' || !NONPUBLIC_VISIBILITIES.has(visibility)) {
    fail('VIDEO_UPLOAD_PUBLIC_VISIBILITY_FORBIDDEN', 'Only private, only-me, or draft visibility is accepted');
  }
  if (typeof input.aiLabel !== 'boolean') {
    fail('VIDEO_UPLOAD_AI_LABEL_REQUIRED', 'aiLabel must be explicitly true or false');
  }
  if (typeof input.file !== 'string' || !input.file.trim()) fail('VIDEO_UPLOAD_FILE_REQUIRED');
  const tags = input.tags ?? [];
  if (!Array.isArray(tags) || tags.length > 100
    || tags.some(tag => typeof tag !== 'string' || !tag.trim())) {
    fail('VIDEO_UPLOAD_TAGS_INVALID');
  }
  const cover = input.cover == null ? null : input.cover;
  if (cover !== null && (typeof cover !== 'string' || !cover.trim())) fail('VIDEO_UPLOAD_COVER_INVALID');
  return {
    file: path.resolve(input.file),
    title: normalizeText(input.title, 'title', { required: true }),
    description: normalizeText(input.description, 'description'),
    tags: tags.map(tag => tag.trim()),
    aiLabel: input.aiLabel,
    visibility,
    cover: cover === null ? null : path.resolve(cover),
  };
}

function defaultJournalDir() {
  const stateRoot = process.env.LOCALAPPDATA || process.env.XDG_STATE_HOME
    || path.join(os.homedir(), '.local', 'state');
  return path.join(stateRoot, 'affiliate-content-operations', 'video-upload-journal');
}

function validatePlatform(platform) {
  if (!Object.hasOwn(PLATFORM_HOSTS, platform)) fail('VIDEO_UPLOAD_PLATFORM_INVALID');
}

function operationKey({ platform, intentHash, operationId }) {
  if (operationId === undefined || operationId === null || operationId === '') return intentHash;
  if (typeof operationId !== 'string' || operationId.length > 160 || /[\r\n\0]/.test(operationId)) {
    fail('VIDEO_UPLOAD_OPERATION_ID_INVALID');
  }
  return sha256(`${platform}\0${operationId}`);
}

function normalizedPhases(phases) {
  if (!Array.isArray(phases) || phases.length === 0 || phases.length > 64) {
    fail('VIDEO_UPLOAD_PHASE_PLAN_REQUIRED', 'A captured ordered create-phase plan is required');
  }
  const names = phases.map(phase => typeof phase === 'string' ? phase : phase?.name);
  if (names.some(name => typeof name !== 'string' || !PHASE_NAME.test(name))
    || new Set(names).size !== names.length) {
    fail('VIDEO_UPLOAD_PHASE_PLAN_INVALID');
  }
  return names;
}

async function acquireLock(lockFile) {
  let handle;
  try {
    handle = await open(lockFile, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') fail('VIDEO_UPLOAD_JOURNAL_BUSY');
    fail('VIDEO_UPLOAD_JOURNAL_UNAVAILABLE');
  }
  return async () => {
    await handle.close().catch(() => {});
    await rm(lockFile, { force: true }).catch(() => {});
  };
}

async function readEvents(file) {
  let content;
  try { content = await readFile(file, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return [];
    fail('VIDEO_UPLOAD_JOURNAL_UNREADABLE');
  }
  const lines = content.split('\n').filter(Boolean);
  try { return lines.map(line => JSON.parse(line)); }
  catch { fail('VIDEO_UPLOAD_JOURNAL_CORRUPT'); }
}

async function appendEvent(file, base, type, fields = {}) {
  const event = { schemaVersion: 1, platform: base.platform, operationKey: base.key,
    at: new Date().toISOString(), type, ...fields };
  let handle;
  try {
    handle = await open(file, 'a', 0o600);
    await handle.writeFile(`${JSON.stringify(event)}\n`, 'utf8');
    await handle.sync();
  } catch {
    fail('VIDEO_UPLOAD_JOURNAL_WRITE_FAILED');
  } finally {
    await handle?.close().catch(() => {});
  }
  return event;
}

async function hashIntent(platform, input, expectedOwner) {
  let fileStat;
    try { fileStat = await stat(input.file); }
  catch { fail('VIDEO_UPLOAD_FILE_UNREADABLE'); }
  if (!fileStat.isFile() || fileStat.size === 0) fail('VIDEO_UPLOAD_FILE_INVALID');
  const videoHash = await hashFile(input.file);
  let coverHash = null;
  if (input.cover) {
    let coverStat;
    try { coverStat = await stat(input.cover); }
    catch { fail('VIDEO_UPLOAD_COVER_UNREADABLE'); }
    if (!coverStat.isFile() || coverStat.size === 0) fail('VIDEO_UPLOAD_COVER_INVALID');
    coverHash = await hashFile(input.cover);
  }
  const assetSha256 = sha256(JSON.stringify({ videoHash, coverHash }));
  const intentHash = sha256(JSON.stringify({
    platform, assetSha256, title: input.title, description: input.description,
    tags: input.tags, aiLabel: input.aiLabel, visibility: input.visibility, expectedOwner,
  }));
  return { assetSha256, intentHash };
}

function normalizeOwner(owner) {
  if (typeof owner !== 'string' || !/^[A-Za-z0-9@._-]{1,128}$/.test(owner)) {
    fail('VIDEO_UPLOAD_EXPECTED_OWNER_REQUIRED');
  }
  return owner;
}

function safePostId(postId) {
  if (typeof postId !== 'string' || !POST_ID.test(postId)) return null;
  return postId;
}

function safePermalink(platform, value, postId) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return null;
  if (platform === 'naver-clip') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !PLATFORM_HOSTS[platform].has(url.hostname.toLowerCase())
      || url.username || url.password || url.search || url.hash || url.port
      || !/^\/[A-Za-z0-9@._~/-]{0,512}$/.test(url.pathname)) return null;
    const postPath = platform === 'youtube'
      ? url.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{6,32})\/?$/)
      : url.pathname.match(/^\/(?:reel|p)\/([A-Za-z0-9_-]{4,40})\/?$/);
    if (!postPath || postPath[1] !== postId) return null;
    return url.toString();
  } catch { return null; }
}

function verifiedEvent(events) {
  return [...events].reverse().find(event => event.type === 'readback_verified') ?? null;
}

function resultFromVerified(event) {
  return { platform: event.platform, postId: event.postId, url: event.url ?? null,
    visibility: event.visibility };
}

function readbackMatches(readback, { postId, expectedOwner, input }) {
  return Boolean(readback && readback.ownerVerified === true
    && readback.ownerId === expectedOwner
    && readback.postId === postId
    && readback.visibility === input.visibility
    && readback.aiLabel === input.aiLabel
    && readback.title === input.title
    && readback.description === input.description
    && Array.isArray(readback.tags)
    && readback.tags.length === input.tags.length
    && readback.tags.every((tag, index) => tag === input.tags[index]));
}

async function prepareOperation({ platform, input, expectedOwner, operationId, journalDir }) {
  validatePlatform(platform);
  const normalized = normalizeInput(input);
  expectedOwner = normalizeOwner(expectedOwner);
  if (expectedOwner !== PLATFORM_OWNERS[platform]) fail('VIDEO_UPLOAD_OWNER_OUT_OF_SCOPE');
  const { assetSha256, intentHash } = await hashIntent(platform, normalized, expectedOwner);
  const key = operationKey({ platform, intentHash, operationId });
  const directory = path.resolve(journalDir || defaultJournalDir());
  try { await mkdir(directory, { recursive: true, mode: 0o700 }); }
  catch { fail('VIDEO_UPLOAD_JOURNAL_UNAVAILABLE'); }
  return {
    platform, input: normalized, expectedOwner, assetSha256, intentHash, key, directory,
    file: path.join(directory, `${key}.jsonl`), lockFile: path.join(directory, `${key}.lock`),
  };
}

function validatePreviousIntent(events, base) {
  const first = events.find(event => event.type === 'operation_intent');
  if (first && (first.intentHash !== base.intentHash || first.expectedOwner !== base.expectedOwner)) {
    fail('VIDEO_UPLOAD_OPERATION_CONFLICT');
  }
}

/**
 * Run a platform-owned browser callback only after that adapter has supplied an
 * observed ordered phase plan. Every side-effecting create must call
 * onBeforeCreate() and then onCreated(). Raw requests, headers, and receipts are
 * intentionally outside this interface and must never be journaled here.
 */
export async function runBrowserAssistedUpload({
  platform, input, expectedOwner, operationId, journalDir, phasePlan, contractVerified = false,
  browserUpload, readback,
} = {}) {
  if (contractVerified !== true) fail('VIDEO_UPLOAD_CONTRACT_NOT_VERIFIED');
  if (typeof browserUpload !== 'function' || typeof readback !== 'function') {
    fail('VIDEO_UPLOAD_BROWSER_CALLBACK_REQUIRED');
  }
  const phases = normalizedPhases(phasePlan);
  const base = await prepareOperation({ platform, input, expectedOwner, operationId, journalDir });
  const releaseLock = await acquireLock(base.lockFile);
  try {
    const events = await readEvents(base.file);
    validatePreviousIntent(events, base);
    const verified = verifiedEvent(events);
    if (verified) return resultFromVerified(verified);
    if (events.length) {
      fail('VIDEO_UPLOAD_RECONCILIATION_REQUIRED', 'An earlier create may have applied; reconcile before any new upload', {
        operationKey: base.key,
      });
    }

    await appendEvent(base.file, base, 'operation_intent', {
      intentHash: base.intentHash, assetSha256: base.assetSha256,
      expectedVisibility: base.input.visibility, aiLabel: base.input.aiLabel, expectedOwner: base.expectedOwner,
      phaseCount: phases.length, phasePlanHash: sha256(JSON.stringify(phases)),
    });

    let nextPhase = 0;
    let inFlight = null;
    let hookBusy = false;
    let intentDurable = false;
    let journalFailed = false;
    const onBeforeCreate = async phase => {
      if (journalFailed) fail('VIDEO_UPLOAD_JOURNAL_WRITE_FAILED');
      if (hookBusy || phase !== phases[nextPhase] || inFlight !== null) fail('VIDEO_UPLOAD_PHASE_OUT_OF_ORDER');
      hookBusy = true;
      try {
        await appendEvent(base.file, base, 'create_intent', { phaseIndex: nextPhase });
        inFlight = phase;
        intentDurable = true;
      } catch (error) {
        journalFailed = true;
        throw error;
      }
      finally { hookBusy = false; }
    };
    const onCreated = async phase => {
      if (journalFailed) fail('VIDEO_UPLOAD_JOURNAL_WRITE_FAILED');
      if (hookBusy || !intentDurable || phase !== inFlight || phase !== phases[nextPhase]) {
        fail('VIDEO_UPLOAD_PHASE_OUT_OF_ORDER');
      }
      hookBusy = true;
      try {
        await appendEvent(base.file, base, 'create_recorded', { phaseIndex: nextPhase });
        inFlight = null;
        intentDurable = false;
        nextPhase += 1;
      } catch (error) {
        journalFailed = true;
        throw error;
      } finally { hookBusy = false; }
    };

    let submission;
    try {
      submission = await browserUpload({
        platform, file: base.input.file, title: base.input.title,
        description: base.input.description, tags: [...base.input.tags],
        aiLabel: base.input.aiLabel, visibility: base.input.visibility, cover: base.input.cover,
        expectedOwner: base.expectedOwner, intentHash: base.intentHash,
        expectedTitle: base.input.title, expectedDescription: base.input.description,
        expectedTags: [...base.input.tags],
        onBeforeCreate, onCreated,
      });
    } catch {
      if (journalFailed) fail('VIDEO_UPLOAD_JOURNAL_WRITE_FAILED', 'The create journal could not be made durable; stop this upload');
      if (inFlight !== null) {
        await appendEvent(base.file, base, 'create_uncertain', { phaseIndex: nextPhase });
      }
      await appendEvent(base.file, base, 'operation_uncertain', { completedPhases: nextPhase });
      fail('VIDEO_UPLOAD_OUTCOME_UNCERTAIN', 'The UI callback ended after the write journal was opened; do not retry without reconciliation', {
        operationKey: base.key,
      });
    }
    if (journalFailed) {
      fail('VIDEO_UPLOAD_JOURNAL_WRITE_FAILED', 'The callback swallowed a journal failure; no further upload step is allowed');
    }
    if (inFlight !== null || hookBusy || nextPhase !== phases.length) {
      if (inFlight !== null) await appendEvent(base.file, base, 'create_uncertain', { phaseIndex: nextPhase });
      await appendEvent(base.file, base, 'operation_uncertain', { completedPhases: nextPhase });
      fail('VIDEO_UPLOAD_PHASES_INCOMPLETE', 'The callback did not journal every planned create phase', {
        operationKey: base.key,
      });
    }

    const postId = safePostId(submission?.postId);
    if (!postId) {
      await appendEvent(base.file, base, 'operation_uncertain', { completedPhases: nextPhase });
      fail('VIDEO_UPLOAD_POST_ID_MISSING', 'Create outcome requires owner-list reconciliation', {
        operationKey: base.key,
      });
    }
    const url = safePermalink(platform, submission?.url, postId);
    await appendEvent(base.file, base, 'upload_result_received', { postId, url });

    let observed;
    try {
      observed = await readback({ platform, postId, expectedOwner: base.expectedOwner,
        expectedVisibility: base.input.visibility, expectedAiLabel: base.input.aiLabel,
        expectedTitle: base.input.title, expectedDescription: base.input.description,
        expectedTags: [...base.input.tags],
        intentHash: base.intentHash });
    } catch {
      await appendEvent(base.file, base, 'readback_unavailable', { postId });
      fail('VIDEO_UPLOAD_READBACK_UNAVAILABLE', 'The upload may exist; read it back before further writes', {
        operationKey: base.key, postId,
      });
    }
    if (!readbackMatches(observed, { postId, expectedOwner: base.expectedOwner, input: base.input })) {
      await appendEvent(base.file, base, 'readback_rejected', { postId });
      fail('VIDEO_UPLOAD_READBACK_MISMATCH', 'Owner, post ID, private visibility, or AI label did not match', {
        operationKey: base.key, postId,
      });
    }
    const readbackUrl = safePermalink(platform, observed.url, postId) || url;
    const finalEvent = await appendEvent(base.file, base, 'readback_verified', {
      postId, url: readbackUrl, visibility: base.input.visibility, expectedOwner: base.expectedOwner,
    });
    return resultFromVerified(finalEvent);
  } finally {
    await releaseLock();
  }
}

/** Reconcile a known post ID from an interrupted upload. This never creates or resends. */
export async function reconcileBrowserAssistedUpload({
  platform, input, expectedOwner, operationId, journalDir, readback,
} = {}) {
  if (typeof readback !== 'function') fail('VIDEO_UPLOAD_BROWSER_CALLBACK_REQUIRED');
  const base = await prepareOperation({ platform, input, expectedOwner, operationId, journalDir });
  const releaseLock = await acquireLock(base.lockFile);
  try {
    const events = await readEvents(base.file);
    if (!events.length) fail('VIDEO_UPLOAD_JOURNAL_NOT_FOUND');
    validatePreviousIntent(events, base);
    const verified = verifiedEvent(events);
    if (verified) return resultFromVerified(verified);
    const receipt = [...events].reverse().find(event => event.type === 'upload_result_received'
      || event.type === 'readback_unavailable' || event.type === 'readback_rejected');
    const postId = safePostId(receipt?.postId);
    if (!postId) fail('VIDEO_UPLOAD_MANUAL_RECONCILIATION_REQUIRED', 'No post ID was journaled; compare the owner list manually before a new operation');
    let observed;
    try {
    observed = await readback({ platform, postId, expectedOwner: base.expectedOwner,
      expectedVisibility: base.input.visibility, expectedAiLabel: base.input.aiLabel,
      expectedTitle: base.input.title, expectedDescription: base.input.description,
      expectedTags: [...base.input.tags],
      intentHash: base.intentHash });
    } catch {
      await appendEvent(base.file, base, 'readback_unavailable', { postId });
      fail('VIDEO_UPLOAD_READBACK_UNAVAILABLE');
    }
    if (!readbackMatches(observed, { postId, expectedOwner: base.expectedOwner, input: base.input })) {
      await appendEvent(base.file, base, 'readback_rejected', { postId });
      fail('VIDEO_UPLOAD_READBACK_MISMATCH');
    }
    const url = safePermalink(platform, observed.url, postId) || null;
    const event = await appendEvent(base.file, base, 'readback_verified', {
      postId, url, visibility: base.input.visibility, expectedOwner: base.expectedOwner,
    });
    return resultFromVerified(event);
  } finally {
    await releaseLock();
  }
}

export function throwIfBlocked(platform, capability) {
  validatePlatform(platform);
  fail('VIDEO_UPLOAD_BLOCKED', `Upload is blocked for ${platform}: ${capability.blockers.join(', ')}`, {
    platform, capability: structuredClone(capability),
  });
}

export const videoUploadJournalDirectory = defaultJournalDir;
