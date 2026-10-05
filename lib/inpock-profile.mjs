import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, lstat, open, rename, unlink } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { createInpockAuth } from './web-auth/inpock.mjs';
import { createInpockSessionReader } from './inpock-read.mjs';
import { ScopedSession } from './scoped-session.mjs';
import { withSessionLock } from './session-lock.mjs';
import { WriteJournal } from './write-journal.mjs';
import { WebAuthError } from './web-auth/myrealtrip.mjs';

const API = 'https://link-rest.inpock.co.kr';
const WEB = 'https://link.inpock.co.kr';
const DEFAULT_JOURNAL_ROOT = path.join(os.homedir(), '.config', 'xhr-to-api-only', 'journal');
const DEFAULTS = Object.freeze({
  profile_image: null, title: null, bio: null, sns: [], sns_position: 'top',
  layout_type: 'profile', cover_image: null, profile_alignment: 'center',
  profile_size: 'medium', theme: 'minimal', background_type: 'color',
  background_color: '#ffffff', background_image: null, typography: 'pretendard',
  block_shape: 'square-rounded', block_animation: null, block_shadow: null,
  block_alignment: 'center', notice: null, brand_image: null, brand_url: null,
  brand_image_policy: 'default', using_short_link: false, allow_offers: false,
  using_search: false, show_tiktok_browser_popup: true,
});
const FIELDS = Object.keys(DEFAULTS);
const NULLABLE_STRINGS = new Set(['profile_image', 'title', 'bio', 'cover_image', 'background_color',
  'background_image', 'brand_image', 'brand_url']);
const BOOLEANS = new Set(['using_short_link', 'allow_offers', 'using_search', 'show_tiktok_browser_popup']);
const ENUMS = Object.freeze({
  sns_position: ['top', 'bottom'],
  layout_type: ['profile', 'cover_top', 'cover_profile', 'cover_top_gradient'],
  profile_alignment: ['left', 'center'], profile_size: ['small', 'medium', 'large'],
  theme: ['minimal', 'friendly', 'impact'], background_type: ['color', 'image', 'color_image'],
  typography: ['pretendard', 'paperlogy', 'kakao_big_sans', 'laundry_gothic', 'maruburi', 'moneygraphy'],
  block_shape: ['square-rounded', 'square', 'pill'], block_animation: [null, 'ripple', 'bounce', 'paint'],
  block_shadow: [null, 'small', 'medium', 'large'], block_alignment: ['left', 'center'],
  brand_image_policy: ['default', 'custom', 'hidden'],
});
const SNS_TYPES = new Set(['instagram', 'tiktok', 'facebook', 'x', 'threads', 'youtube', 'blog',
  'website', 'phone', 'email']);
const URL_SNS = new Set(['youtube', 'blog', 'website']);
// The public GET design currently exposes all 26 form fields, including settings.
const PUBLIC_FIELDS = new Set(FIELDS);
const HEX = /^[a-f0-9]{64}$/i;
const EDIT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const USERNAME = /^[A-Za-z0-9_.-]{1,320}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, receipt) => { throw new WebAuthError(code, receipt); };

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const clone = value => structuredClone(value);
function semantic(form) {
  return {
    ...form,
    sns: form.sns.map(({ type, value, order }) => ({ type, value, order })),
    notice: form.notice === null ? null : {
      background_color: form.notice.background_color,
      text_color: form.notice.text_color,
      contents: form.notice.contents,
    },
  };
}

function textValue(value, max, { nullable = false, multiline = false } = {}) {
  return (nullable && value === null) || typeof value === 'string' && value.length <= max &&
    !/[\0\x7f]/.test(value) && (multiline || !/[\r\n]/.test(value));
}
function validWebUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
      !/[\x00-\x20\x7f\\]/.test(value) && value.length <= 4096;
  } catch { return false; }
}
function normalizeSns(value, changed) {
  if (!Array.isArray(value) || value.length > 30) fail('INPOCK_PROFILE_SNS_INVALID');
  return value.map((item, index) => {
    if (!object(item) || Object.keys(item).some(key => !['id', 'type', 'value', 'order'].includes(key)) ||
        !SNS_TYPES.has(item.type) || !textValue(item.value, 4096) || !item.value ||
        (changed && 'id' in item) || (!changed && (!Number.isSafeInteger(item.order) || item.order < 0 ||
          ('id' in item && (!Number.isSafeInteger(item.id) || item.id <= 0))))) fail('INPOCK_PROFILE_SNS_INVALID');
    let socialValue = item.value;
    if (changed && !URL_SNS.has(item.type) && !['phone', 'email'].includes(item.type)) {
      socialValue = socialValue.replace(/^@/, '');
    }
    if (URL_SNS.has(item.type) && !validWebUrl(socialValue) ||
        item.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(socialValue) ||
        item.type === 'phone' && !/^\+?[0-9() .-]{3,40}$/.test(socialValue) ||
        !URL_SNS.has(item.type) && !['phone', 'email'].includes(item.type) &&
          (!socialValue || /[\s/@]/.test(socialValue))) fail('INPOCK_PROFILE_SNS_INVALID');
    return changed ? { type: item.type, value: socialValue, order: index } :
      { ...('id' in item ? { id: item.id } : {}), type: item.type, value: socialValue, order: item.order };
  });
}
function normalizeNotice(value, changed) {
  if (value === null) return null;
  if (!object(value) || Object.keys(value).some(key => !['id', 'background_color', 'text_color', 'contents'].includes(key)) ||
      (changed && 'id' in value) || !textValue(value.contents, changed ? 100 : 500,
        { nullable: !changed, multiline: true }) ||
      !textValue(value.background_color, 128, { nullable: true }) ||
      !textValue(value.text_color, 128, { nullable: true }) ||
      (!changed && 'id' in value && value.id !== null && (!Number.isSafeInteger(value.id) || value.id <= 0))) {
    fail('INPOCK_PROFILE_NOTICE_INVALID');
  }
  return { ...(!changed && 'id' in value ? { id: value.id } : {}),
    background_color: value.background_color, text_color: value.text_color, contents: value.contents };
}
function validateField(field, value, { changed = false, imageRefs = new Set() } = {}) {
  if (NULLABLE_STRINGS.has(field)) {
    const max = field === 'title' ? 100 : field === 'bio' ? changed ? 60 : 500 : 4096;
    if (!textValue(value, max, { nullable: true, multiline: field === 'bio' })) fail('INPOCK_PROFILE_FIELD_INVALID', { field });
    if (changed && ['profile_image', 'cover_image', 'background_image', 'brand_image'].includes(field) &&
        value !== null && !imageRefs.has(value)) fail('INPOCK_PROFILE_IMAGE_REFERENCE_UNVERIFIED', { field });
    if (field === 'brand_url' && value !== null && !validWebUrl(value)) fail('INPOCK_PROFILE_FIELD_INVALID', { field });
    return value;
  }
  if (BOOLEANS.has(field)) {
    if (typeof value !== 'boolean') fail('INPOCK_PROFILE_FIELD_INVALID', { field });
    return value;
  }
  if (field in ENUMS) {
    // The current server can return null for theme/background_type. Keep that
    // exact value in an unrelated edit, even though the UI chooses a default.
    if (!changed && value === null && ['theme', 'background_type'].includes(field)) return null;
    if (!ENUMS[field].includes(value)) fail('INPOCK_PROFILE_FIELD_INVALID', { field });
    return value;
  }
  if (field === 'sns') return normalizeSns(value, changed);
  if (field === 'notice') return normalizeNotice(value, changed);
  fail('INPOCK_PROFILE_FIELD_INVALID', { field });
}
function normalizeForm(data) {
  if (!object(data) || Object.keys(data).length !== FIELDS.length ||
      Object.keys(data).some(key => !FIELDS.includes(key))) fail('INPOCK_PROFILE_DESIGN_SCHEMA_INVALID');
  const form = {};
  for (const field of FIELDS) {
    // A complete save must preserve all unrequested raw values. In particular,
    // GET currently has null theme/background_type and notice.contents.
    form[field] = validateField(field, data[field]);
  }
  return form;
}
function normalizeChanges(changes, current, { enforceImageRefs = true } = {}) {
  if (!object(changes) || !Object.keys(changes).length || Object.keys(changes).some(key => !FIELDS.includes(key))) {
    fail('INPOCK_PROFILE_CHANGES_INVALID');
  }
  const refs = new Set(enforceImageRefs ? ['profile_image', 'cover_image', 'background_image', 'brand_image']
    .map(field => current[field]).filter(value => typeof value === 'string' && value) :
    Object.values(changes).filter(value => typeof value === 'string' && value));
  return Object.fromEntries(Object.entries(changes).map(([field, value]) =>
    [field, validateField(field, value, { changed: true, imageRefs: refs })]));
}
function validateEditInput(input) {
  if (!object(input) || Object.keys(input).some(key => !['ownerUsername', 'changes', 'expectedSnapshotHash', 'editId', 'confirm'].includes(key)) ||
      input.confirm !== true) fail('INPOCK_PROFILE_CONFIRM_REQUIRED');
  if (typeof input.ownerUsername !== 'string' || !USERNAME.test(input.ownerUsername)) fail('INPOCK_ACTOR_INVALID');
  if (typeof input.editId !== 'string' || !EDIT_ID.test(input.editId)) fail('INPOCK_PROFILE_EDIT_ID_INVALID');
  if (typeof input.expectedSnapshotHash !== 'string' || !HEX.test(input.expectedSnapshotHash)) {
    fail('INPOCK_PROFILE_SNAPSHOT_HASH_INVALID');
  }
  if (!object(input.changes) || !Object.keys(input.changes).length ||
      Object.keys(input.changes).some(key => !FIELDS.includes(key))) fail('INPOCK_PROFILE_CHANGES_INVALID');
  return input;
}
function validateActor(owner, actor, username) {
  if (owner?.authenticated !== true || owner?.ownerVerified !== true ||
      !Number.isSafeInteger(actor?.id) || actor.id <= 0 || actor.username !== owner.user?.username ||
      username !== undefined && actor.username !== username) fail('OWNER_MISMATCH');
}
async function getDesign(session, now) {
  let response;
  try { response = await session.request(API + '/v2/users/design'); }
  catch (error) { fail('INPOCK_PROFILE_TRANSPORT_FAILED', {
    causeCode: /^SCOPED_SESSION_[A-Z_]+$/.test(error.code || '') ? error.code : 'TRANSPORT_ERROR',
  }); }
  const mime = response.headers['content-type']?.split(';')[0].trim().toLowerCase() ?? null;
  const receipt = { method: 'GET', origin: API, path: '/v2/users/design', httpStatus: response.status, mime,
    responseBytes: Buffer.byteLength(response.raw), checkedAt: new Date(now()).toISOString(), browserUsed: false };
  if (response.status === 401) fail('REAUTH_REQUIRED', receipt);
  if (response.status === 403) fail('AUTH_FORBIDDEN', receipt);
  if (response.status === 429) fail('AUTH_THROTTLED', receipt);
  if (response.status !== 200 || mime !== 'application/json') fail('INPOCK_PROFILE_RESPONSE_INVALID', receipt);
  let body;
  try { body = JSON.parse(response.raw); } catch { fail('INPOCK_PROFILE_RESPONSE_INVALID', receipt); }
  if (!object(body) || !object(body.data) || typeof body.is_draft !== 'boolean') {
    fail('INPOCK_PROFILE_DESIGN_SCHEMA_INVALID', receipt);
  }
  return { profile: normalizeForm(body.data), isDraft: body.is_draft, receipt };
}

// The owner pointer blocks a different edit ID while an earlier save has an uncertain outcome.
// It carries hashes and IDs only; the profile and session never enter the journal directory.
function pendingPath(root, ownerId) { return path.join(root, 'inpock-profile-pending', `${ownerId}.json`); }
async function readPending(root, ownerId) {
  const file = pendingPath(root, ownerId);
  let before;
  try { before = await lstat(file); } catch (error) {
    if (error.code === 'ENOENT') return null;
    fail('INPOCK_PROFILE_PENDING_IO_FAILED');
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > 2048) fail('INPOCK_PROFILE_PENDING_CORRUPT');
  let handle, value;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const after = await handle.stat();
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino) fail('INPOCK_PROFILE_PENDING_CORRUPT');
    value = JSON.parse(await handle.readFile({ encoding: 'utf8' }));
  } catch (error) {
    if (error?.code === 'INPOCK_PROFILE_PENDING_CORRUPT') throw error;
    fail('INPOCK_PROFILE_PENDING_CORRUPT');
  } finally { await handle?.close().catch(() => {}); }
  if (!object(value) || value.version !== 1 || value.ownerId !== ownerId ||
      !['pending', 'resolved'].includes(value.status) || !EDIT_ID.test(value.editId) ||
      !HEX.test(value.journalKey)) fail('INPOCK_PROFILE_PENDING_CORRUPT');
  return value;
}
async function writePending(root, ownerId, value) {
  const dir = path.dirname(pendingPath(root, ownerId));
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('INPOCK_PROFILE_PENDING_IO_FAILED');
    const tmp = path.join(dir, `${ownerId}.${process.pid}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(tmp, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(value)}\n`);
      await handle.sync();
      await handle.close(); handle = null;
      await rename(tmp, pendingPath(root, ownerId));
    } catch { await handle?.close().catch(() => {}); await unlink(tmp).catch(() => {}); fail('INPOCK_PROFILE_PENDING_IO_FAILED'); }
  } catch (error) {
    if (error?.code === 'INPOCK_PROFILE_PENDING_IO_FAILED') throw error;
    fail('INPOCK_PROFILE_PENDING_IO_FAILED');
  }
}
function pointerLock(root, ownerId, callback) {
  return withSessionLock(callback, { root: path.join(root, '.locks'), key: `inpock-profile-pending:${ownerId}` });
}
async function claimPending(root, ownerId, editId, journalKey) {
  return pointerLock(root, ownerId, async () => {
    const prior = await readPending(root, ownerId);
    if (prior?.status === 'pending' && prior.editId !== editId) {
      fail('INPOCK_PROFILE_PENDING_EDIT', { priorJournalKey: prior.journalKey });
    }
    if (prior?.status === 'pending' && prior.journalKey !== journalKey) fail('INPOCK_PROFILE_PENDING_CORRUPT');
    if (!prior || prior.status === 'resolved') {
      await writePending(root, ownerId, { version: 1, ownerId, editId, journalKey, status: 'pending' });
    }
  });
}
async function resolvePending(root, ownerId, editId, journalKey) {
  return pointerLock(root, ownerId, async () => {
    const prior = await readPending(root, ownerId);
    if (!prior || prior.editId !== editId || prior.journalKey !== journalKey) fail('INPOCK_PROFILE_PENDING_CORRUPT');
    if (prior.status !== 'resolved') await writePending(root, ownerId, { ...prior, status: 'resolved' });
  });
}

export function createInpockProfileClient({ auth = createInpockAuth(), journalRoot = DEFAULT_JOURNAL_ROOT,
  journal = new WriteJournal({ root: journalRoot, service: 'inpock' }), anonymousFetch = fetch,
  now = Date.now, readAttempts = 3, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!Number.isInteger(readAttempts) || readAttempts < 1 || readAttempts > 5) fail('INPOCK_PROFILE_READBACK_BUDGET_INVALID');
  const anonymousSession = () => new ScopedSession({
    allowedOrigins: [API], cookieOrigins: [], fetchImpl: anonymousFetch,
    defaultHeaders: { accept: 'application/json' },
    headersByOrigin: { [API]: { origin: WEB, referer: WEB + '/' } },
    timeoutMs: 15000, maxResponseBytes: 1024 * 1024, maxRedirects: 0,
  });
  async function publicCompare(owner, actor, target, changedFields) {
    const reader = createInpockSessionReader({ session: anonymousSession(), owner, actor, now });
    const publicPage = await reader.publicProfile();
    const design = publicPage.profile.design;
    const fields = changedFields.filter(field => PUBLIC_FIELDS.has(field));
    const comparisons = Object.fromEntries(fields.map(field => {
      if (!object(design) || !Object.hasOwn(design, field)) return [field, false];
      let published = design[field];
      if (field === 'sns') published = normalizeSns(published, false).map(({ type, value, order }) => ({ type, value, order }));
      if (field === 'notice') published = published === null ? null :
        semantic({ sns: [], notice: normalizeNotice(published, false) }).notice;
      if (['profile_image', 'cover_image', 'background_image', 'brand_image'].includes(field) && published === '') {
        published = null; // observed public projection of an empty owner image
      }
      return [field, isDeepStrictEqual(canonical(published), canonical(semantic(target)[field]))];
    }));
    return { verified: Object.values(comparisons).every(Boolean), applicable: fields.length > 0,
      comparisons, receipt: publicPage.receipt, checkedFields: fields, publicCredentialsSent: false };
  }
  async function reconcileCurrent({ session, owner, actor, key, record, changes, targetHash, writeSent, writeReceipt }) {
    let diagnostics = null;
    for (let attempt = 0; attempt < readAttempts; attempt++) {
      let current, publicResult = null, ownerMatch = false;
      try {
        current = await getDesign(session, now);
        ownerMatch = !current.isDraft && hash(semantic(current.profile)) === targetHash;
        if (ownerMatch) publicResult = await publicCompare(owner, actor, current.profile, Object.keys(changes));
        diagnostics = { ownerMatch, isDraft: current.isDraft,
          publicComparisons: publicResult?.comparisons ?? null };
      } catch (error) {
        diagnostics = { code: /^[A-Z][A-Z0-9_]+$/.test(error.code || '') ? error.code : 'READBACK_FAILED' };
      }
      if (ownerMatch && publicResult?.verified) {
        const publicVerified = publicResult.applicable ? true : null;
        // The source maps the save endpoint, but its success response has not
        // been observed. A matching readback proves state, not write causality.
        const unverifiedHttpAck = record.state === 'http_2xx_application_unverified_requires_readback';
        if (record.status !== 'reconciled') await journal.reconcile(key, {
          result: 'found', independentRead: true, ownerVerified: true, publicVerified,
          exactFieldsVerified: true, targetHash,
        });
        await resolvePending(journalRoot, actor.id, record.safeRecord.editId, key);
        return { status: unverifiedHttpAck ? 'desired_state_verified_after_unverified_ack' :
          'desired_state_verified_after_unclear_write',
          editPerformed: writeSent ? 'unknown' : false, writeSent,
          writeSuppressed: !writeSent, postAttempts: writeSent ? 1 : 0, authenticated: true,
          ownerVerified: true, readbackVerified: true, publicVerified,
          anonymousPublicVerified: publicVerified, publicCredentialsSent: false, browserUsed: false,
          ownerUsername: actor.username, changedFields: Object.keys(changes),
          snapshotHash: record.safeRecord.baselineHash, targetHash, journalKey: key,
          writeReceipt, readReceipts: { owner: current.receipt, public: publicResult.receipt },
          checkedAt: new Date(now()).toISOString() };
      }
      if (attempt + 1 < readAttempts) await wait(1500);
    }
    if (record.status !== 'reconciled') await journal.reconcile(key, { result: 'ambiguous', independentRead: true });
    return { status: 'outcome_unknown', writeSent, writeSuppressed: !writeSent,
      postAttempts: writeSent ? 1 : 0, readbackVerified: false, publicVerified: false,
      publicCredentialsSent: false, browserUsed: false, journalKey: key, targetHash,
      writeReceipt, diagnostics, automaticResendAllowed: false };
  }
  return {
    snapshot: () => auth.withSession(async (session, owner, actor) => {
      validateActor(owner, actor);
      const current = await getDesign(session, now);
      return { authenticated: true, ownerVerified: true, ownerUsername: actor.username,
        ownerId: actor.id, profile: current.profile, isDraft: current.isDraft,
        snapshotHash: hash(current.profile), receipt: current.receipt, browserUsed: false };
    }),
    preview: async input => {
      if (!object(input) || Object.keys(input).some(key => !['ownerUsername', 'changes'].includes(key))) {
        fail('INPOCK_PROFILE_CHANGES_INVALID');
      }
      const { ownerUsername, changes } = input;
      if (typeof ownerUsername !== 'string' || !USERNAME.test(ownerUsername)) fail('INPOCK_ACTOR_INVALID');
      return auth.withSession(async (session, owner, actor) => {
      validateActor(owner, actor, ownerUsername);
      const current = await getDesign(session, now);
      if (current.isDraft) fail('INPOCK_PROFILE_EXISTING_DRAFT');
      const normalized = normalizeChanges(changes, current.profile);
      const target = { ...current.profile, ...normalized };
      return { ownerUsername: actor.username, before: current.profile, target,
        snapshotHash: hash(current.profile), targetHash: hash(semantic(target)),
        changedFields: Object.keys(normalized).filter(field => !isDeepStrictEqual(current.profile[field], target[field])),
        isDraft: false, receipt: current.receipt, browserUsed: false };
      });
    },
    edit: async input => {
      const checked = validateEditInput(input);
      let writeSent = false, postAttempts = 0, journalKey = null;
      try {
        return await auth.withSession(async (session, owner, actor) => {
          validateActor(owner, actor, checked.ownerUsername);
          const key = journal.key('profile-save', { ownerId: actor.id }, { editId: checked.editId });
          journalKey = key;
          const prior = await journal.read(key);
          const current = await getDesign(session, now);
          if (current.isDraft) fail('INPOCK_PROFILE_EXISTING_DRAFT');
          const normalized = normalizeChanges(checked.changes, current.profile, { enforceImageRefs: !prior });
          const changesHash = hash(normalized);
          if (prior) {
            if (prior.safeRecord?.ownerId !== actor.id || prior.safeRecord?.editId !== checked.editId ||
                prior.safeRecord?.baselineHash !== checked.expectedSnapshotHash ||
                prior.safeRecord?.changesHash !== changesHash) fail('INPOCK_PROFILE_EDIT_CONFLICT');
            const pointer = await readPending(journalRoot, actor.id);
            if (pointer?.status === 'pending' && pointer.editId !== checked.editId) {
              fail('INPOCK_PROFILE_PENDING_EDIT', { priorJournalKey: pointer.journalKey });
            }
            if (prior.status === 'reconciled' && pointer?.status === 'resolved' &&
                hash(semantic(current.profile)) !== prior.safeRecord.targetHash) {
              return { status: 'no_longer_current', writeSent: false, writeSuppressed: true,
                postAttempts: 0, readbackVerified: false, journalKey: key, browserUsed: false };
            }
            return reconcileCurrent({ session, owner, actor, key, record: prior, changes: normalized,
              targetHash: prior.safeRecord.targetHash, writeSent: false, writeReceipt: null });
          }
          const baselineHash = hash(current.profile);
          if (baselineHash !== checked.expectedSnapshotHash) fail('INPOCK_PROFILE_STALE_SNAPSHOT', {
            currentSnapshotHash: baselineHash,
          });
          const target = { ...current.profile, ...normalized };
          const changedFields = Object.keys(normalized).filter(field => !isDeepStrictEqual(current.profile[field], target[field]));
          const pending = await readPending(journalRoot, actor.id);
          if (pending?.status === 'pending' && pending.editId !== checked.editId) {
            fail('INPOCK_PROFILE_PENDING_EDIT', { priorJournalKey: pending.journalKey });
          }
          if (!changedFields.length) return { status: 'unchanged', editPerformed: false,
            writeSent: false, writeSuppressed: true, postAttempts: 0, readbackVerified: false,
            publicVerified: false, ownerVerified: true, snapshotHash: baselineHash, browserUsed: false };
          const targetHash = hash(semantic(target));
          await claimPending(journalRoot, actor.id, checked.editId, key);
          try { await journal.reserve(key, { operation: 'profile-save', ownerId: actor.id,
            editId: checked.editId, baselineHash, changesHash, targetHash }); }
          catch (error) {
            if (error.code === 'WRITE_JOURNAL_EXISTS') fail('INPOCK_PROFILE_EDIT_IN_PROGRESS', { journalKey: key });
            throw error;
          }
          const record = await journal.read(key);
          let response = null, responseBody = null;
          writeSent = true;
          postAttempts = 1;
          try {
            response = await session.request(API + '/v2/users/design/save', { method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ...target, user_id: actor.id }) });
            try { responseBody = JSON.parse(response.raw); } catch { /* unknown ACK; readback decides */ }
          } catch { /* POST may have reached the server; never resend */ }
          const mime = response?.headers['content-type']?.split(';')[0].trim().toLowerCase() ?? null;
          const appError = object(responseBody) && (Object.hasOwn(responseBody, 'error') ||
            Object.hasOwn(responseBody, 'errors') || responseBody.success === false || responseBody.ok === false);
          const http2xxJson = response?.status >= 200 && response.status < 300 && mime === 'application/json';
          const writeReceipt = { method: 'POST', origin: API, path: '/v2/users/design/save',
            httpStatus: response?.status ?? null, mime, responseBytes: response ? Buffer.byteLength(response.raw) : null,
            responseKeys: object(responseBody) ? Object.keys(responseBody).slice(0, 50) : null,
            applicationAckVerified: false, applicationErrorSignaled: !!appError,
            browserUsed: false, checkedAt: new Date(now()).toISOString() };
          await journal.finish(key, http2xxJson && !appError ?
            'http_2xx_application_unverified_requires_readback' : 'outcome_unknown', { httpStatus: response?.status ?? null,
            postAttempts: 1, targetHash });
          const finished = await journal.read(key);
          return reconcileCurrent({ session, owner, actor, key, record: finished, changes: normalized,
            targetHash, writeSent: true, writeReceipt });
        });
      } catch (error) {
        if (writeSent) fail('INPOCK_PROFILE_WRITE_OUTCOME_UNKNOWN', { writeSent: true, postAttempts,
          journalKey, causeCode: /^[A-Z][A-Z0-9_]{1,100}$/.test(error.code || '') ? error.code : 'LOCAL_ERROR' });
        throw error;
      }
    },
  };
}

export const inpockProfileContract = Object.freeze({
  snapshot: 'Authenticated GET /v2/users/design, normalized to the observed complete form',
  preview: 'Merge approved fields against a fresh owner-bound snapshot without a write',
  edit: 'Explicit stable editId, expectedSnapshotHash, ownerUsername and confirm; one POST maximum',
  upload: 'Only already present image references can be reused; file upload is not implemented',
  concurrency: 'Snapshot comparison is client preflight, not server-atomic compare-and-swap',
});
