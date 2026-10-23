import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { metaRequest, openMetaContext, sendMetaQuery, withMetaSessionLock } from './lib/meta-bootstrap.mjs';
import { inspectThreadsPost, readThreadsProfileTimeline } from './threads-social.mjs';

const OWNER = 'lifehack__ailab';
const ORIGIN = 'https://www.threads.com';
// This lazy menu asset URL was observed when the authenticated post menu loaded.
// It is fetched as public JavaScript with credentials omitted and is never evaluated.
const PIN_SOURCE_ASSET = 'https://static.cdninstagram.com/rsrc.php/v4i9eD4/yU/l/ko_KR-j/7BowlCT8jgp.js';
const MAX_SOURCE_BYTES = 8_000_000;
const MAX_JOURNAL_BYTES = 24_000;
const CONTRACTS = Object.freeze({
  pin: Object.freeze({
    operation: 'useTHPinPostToProfileMutationPinMutation',
    docId: '26917686924509763',
    responseField: 'xdt_api__v1__text_feed__pin_post_to_profile',
    desiredPinned: true,
  }),
  unpin: Object.freeze({
    operation: 'useTHPinPostToProfileMutationUnpinMutation',
    docId: '26782015404752924',
    responseField: 'xdt_api__v1__text_feed__unpin_post_from_profile',
    desiredPinned: false,
  }),
});

const fail = code => { throw Object.assign(new Error(code), { code }); };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const safeCode = error => /^[A-Z][A-Z0-9_]{2,100}$/.test(error?.code || '')
  ? error.code : 'THREADS_PIN_OUTCOME_UNKNOWN';

function normalizeInput(input = {}) {
  const postId = String(input.postId ?? '');
  const operation = input.operation;
  const execute = input.execute === true;
  const reconcile = input.reconcile === true;
  if (!Object.hasOwn(CONTRACTS, operation) || !/^\d{10,25}$/.test(postId)
    || typeof input.execute !== 'undefined' && typeof input.execute !== 'boolean'
    || typeof input.reconcile !== 'undefined' && typeof input.reconcile !== 'boolean'
    || execute && reconcile) fail('THREADS_PIN_INPUT_INVALID');
  return { operation, postId, desiredPinned: CONTRACTS[operation].desiredPinned, execute, reconcile };
}

function extractModules(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > MAX_SOURCE_BYTES) fail('THREADS_PIN_SOURCE_INVALID');
  const matches = [...source.matchAll(/__d\("([^"]+)"/g)];
  const modules = new Map();
  for (let index = 0; index < matches.length; index += 1) {
    const name = matches[index][1];
    const body = source.slice(matches[index].index, matches[index + 1]?.index ?? source.length);
    if (modules.has(name) && modules.get(name) !== body) fail('THREADS_PIN_SOURCE_AMBIGUOUS');
    modules.set(name, body);
  }
  return modules;
}

export function verifyThreadsPinSource(source, assetUrl = PIN_SOURCE_ASSET) {
  let asset;
  try { asset = new URL(assetUrl); } catch { fail('THREADS_PIN_SOURCE_SCOPE'); }
  if (asset.origin !== 'https://static.cdninstagram.com' || !asset.pathname.startsWith('/rsrc.php/')
    || asset.username || asset.password || asset.search || asset.hash) fail('THREADS_PIN_SOURCE_SCOPE');
  const modules = extractModules(source);
  const menu = modules.get('BarcelonaOverflowMenuPinPostOption.react');
  const hook = modules.get('useTHPinPostToProfileMutation');
  const pin = modules.get('useTHPinPostToProfileMutationPinMutation.threads.graphql');
  const unpin = modules.get('useTHPinPostToProfileMutationUnpinMutation.threads.graphql');
  const menuFragment = modules.get('BarcelonaOverflowMenuPinPostOption_media.threads.graphql');
  const wrapper = modules.get('useBarcelonaPinPostToProfileMutation');
  if (!menu || !hook || !pin || !unpin || !menuFragment || !wrapper
    || !menu.includes('useBarcelonaPinPostToProfileMutation')
    || !menu.includes('g(f.pk,!0)') || !menu.includes('g(f.pk,!1)')
    || !menu.includes('PIN_TO_PROFILE_OPTION') || !menu.includes('UNPIN_OPTION')
    || !menu.includes('can_viewer_pin_to_profile') || !menu.includes('can_viewer_unpin_from_profile')
    || !hook.includes('variables:{post_id:t}')
    || !pin.includes('id:"26917686924509763"')
    || !pin.includes('name:"xdt_api__v1__text_feed__pin_post_to_profile"')
    || !pin.includes('name:"post_id",variableName:"post_id"')
    || !pin.includes('name:"is_pinned_to_profile"')
    || !unpin.includes('id:"26782015404752924"')
    || !unpin.includes('name:"xdt_api__v1__text_feed__unpin_post_from_profile"')
    || !unpin.includes('name:"post_id",variableName:"post_id"')
    || !unpin.includes('name:"is_pinned_to_profile"')
    || !menuFragment.includes('name:"can_viewer_pin_to_profile"')
    || !menuFragment.includes('name:"can_viewer_unpin_from_profile"')) fail('THREADS_PIN_SOURCE_CONTRACT_CHANGED');
  const sourceFingerprint = sha256([menu, hook, wrapper, menuFragment, pin, unpin].join('\n'));
  return {
    operation: 'ThreadsOwnerProfilePinMenu',
    assetPath: asset.origin + asset.pathname,
    assetSha256: sha256(source),
    sourceFingerprint,
    modules: {
      menu: sha256(menu),
      mutationHook: sha256(hook),
      pin: sha256(pin),
      unpin: sha256(unpin),
    },
    captured: false,
    captureSource: 'current_first_party_dynamic_menu_source; mutation_request_not_action_captured',
  };
}

async function loadThreadsPinSource(context) {
  const url = new URL(PIN_SOURCE_ASSET);
  if (url.origin !== 'https://static.cdninstagram.com' || !url.pathname.startsWith('/rsrc.php/')) {
    fail('THREADS_PIN_SOURCE_SCOPE');
  }
  const response = await context.fetchImpl(PIN_SOURCE_ASSET, {
    headers: { accept: 'text/javascript, application/javascript, */*' },
    credentials: 'omit',
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status !== 200) fail('THREADS_PIN_SOURCE_HTTP_' + response.status);
  if (!/^(?:application\/(?:javascript|x-javascript)|text\/javascript)(?:;|$)/i.test(response.headers.get('content-type') || '')) {
    fail('THREADS_PIN_SOURCE_MIME');
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_SOURCE_BYTES) fail('THREADS_PIN_SOURCE_LIMIT');
  return verifyThreadsPinSource(Buffer.from(bytes).toString('utf8'), PIN_SOURCE_ASSET);
}

export function buildThreadsPinRequest(context, operation, postId) {
  const contract = CONTRACTS[operation];
  if (!contract || !/^\d{10,25}$/.test(String(postId ?? ''))) fail('THREADS_PIN_INPUT_INVALID');
  const request = metaRequest(context, contract.operation, contract.docId, { post_id: String(postId) });
  let url;
  try { url = new URL(request.url); } catch { fail('THREADS_PIN_REQUEST_INVALID'); }
  if (request.method !== 'POST' || url.origin !== ORIGIN || url.pathname !== '/api/graphql'
    || url.search || url.hash || !(request.body instanceof URLSearchParams)
    || request.body.get('fb_api_req_friendly_name') !== contract.operation
    || request.body.get('doc_id') !== contract.docId
    || request.body.get('variables') !== JSON.stringify({ post_id: String(postId) })
    || request.headers.origin !== ORIGIN || new URL(request.headers.referer).origin !== ORIGIN) {
    fail('THREADS_PIN_REQUEST_INVALID');
  }
  return request;
}

export function decodeThreadsPinMutation(payload, operation) {
  const contract = CONTRACTS[operation];
  if (!contract) fail('THREADS_PIN_INPUT_INVALID');
  const value = payload?.data?.data?.pinned_post_info?.is_pinned_to_profile;
  if (typeof value !== 'boolean') fail('THREADS_PIN_MUTATION_RESPONSE_INVALID');
  return { isPinnedToProfile: value, matchesRequestedState: value === contract.desiredPinned };
}

function verifyOwnerContext(context) {
  if (context?.service !== 'threads' || context?.handle?.toLowerCase() !== OWNER
    || context?.bundle?.service !== 'threads' || context.bundle.owner?.toLowerCase() !== OWNER
    || !/^\d{1,25}$/.test(String(context.bundle.ownerId || '')) || context.bundle.origin !== ORIGIN
    || context.documentReceipt?.ownerVerified !== true) fail('THREADS_PIN_OWNER_UNVERIFIED');
  return context.bundle;
}

function defaultJournalRoot() {
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'),
    'affiliate-content-operations', 'social-actions', 'threads-pins');
}

function journalFile(root, ownerId, operation, postId) {
  const scope = `${OWNER}:${ownerId}:${operation}:${postId}`;
  return path.join(root, `${sha256(scope).slice(0, 40)}.json`);
}

function validateJournal(record, identity) {
  if (record?.version !== 1 || record.service !== 'threads' || record.operation !== identity.operation
    || record.owner !== OWNER || record.ownerId !== identity.ownerId || record.postId !== identity.postId
    || record.author !== OWNER || record.desiredPinned !== identity.desiredPinned || record.writes !== 1
    || !['dispatch_reserved', 'needs_reconciliation', 'verified', 'succeeded'].includes(record.status)
    || typeof record.sourceFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(record.sourceFingerprint)
    || typeof record.dispatchConfirmed !== 'boolean') fail('THREADS_PIN_JOURNAL_MISMATCH');
  return record;
}

async function readJournal(file, identity) {
  let raw;
  try { raw = await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (raw.length > MAX_JOURNAL_BYTES) fail('THREADS_PIN_JOURNAL_INVALID');
  let record;
  try { record = JSON.parse(raw); } catch { fail('THREADS_PIN_JOURNAL_INVALID'); }
  return validateJournal(record, identity);
}

async function atomicWrite(file, record, { create = false } = {}) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(record) + '\n', 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  try {
    if (create) await link(temporary, file);
    else await rename(temporary, file);
  } catch (error) {
    if (create && error.code === 'EEXIST') fail('THREADS_PIN_RECONCILE_FIRST');
    throw error;
  } finally { await unlink(temporary).catch(() => {}); }
}

function verifyReadState(post, profile, postId) {
  if (String(post?.id ?? '') !== postId || String(post?.author ?? '').toLowerCase() !== OWNER
    || typeof post?.isPinnedToProfile !== 'boolean') fail('THREADS_PIN_TARGET_READBACK_MISMATCH');
  if (String(profile?.handle ?? '').toLowerCase() !== OWNER || profile?.receipt?.ownerVerified !== true
    || String(profile?.receipt?.owner ?? '').toLowerCase() !== OWNER
    || !Array.isArray(profile?.pinnedPosts) || !Array.isArray(profile?.pinnedPostIds)
    || profile.pinnedPostIds.some(id => !/^\d{10,25}$/.test(String(id)))
    || new Set(profile.pinnedPostIds.map(String)).size !== profile.pinnedPostIds.length
    || profile.pinnedPosts.some(item => String(item?.author ?? '').toLowerCase() !== OWNER
      || item?.isPinnedToProfile !== true || !/^\d{10,25}$/.test(String(item?.id ?? '')))) {
    fail('THREADS_PIN_PROFILE_READBACK_MISMATCH');
  }
  const observedIds = profile.pinnedPosts.map(item => String(item.id)).sort();
  const listedIds = profile.pinnedPostIds.map(String).sort();
  if (JSON.stringify(observedIds) !== JSON.stringify(listedIds)) fail('THREADS_PIN_PROFILE_READBACK_MISMATCH');
  const profileContainsTarget = listedIds.includes(postId);
  if (profileContainsTarget !== post.isPinnedToProfile) fail('THREADS_PIN_STATE_CONFLICT');
  return {
    target: { id: postId, author: OWNER, isPinnedToProfile: post.isPinnedToProfile },
    ownerProfilePinnedPostIds: listedIds,
    profileContainsTarget,
  };
}

async function readCurrentState(context, postId, deps) {
  const post = await deps.postReader({ postId, expectedAuthor: OWNER }, {
    owner: OWNER, context, contextLoader: deps.contextLoader, querySender: deps.querySender,
  });
  const profile = await deps.profileReader({ handle: OWNER, limit: 30 }, {
    context, contextLoader: deps.contextLoader, querySender: deps.querySender,
  });
  return { post, profile, state: verifyReadState(post, profile, postId) };
}

function stateMatches(operation, state) {
  const contract = CONTRACTS[operation];
  return state.target.isPinnedToProfile === contract.desiredPinned
    && state.profileContainsTarget === contract.desiredPinned;
}

function assertReady(operation, state) {
  if (operation === 'pin' && state.ownerProfilePinnedPostIds.some(id => id !== state.target.id)) {
    fail('THREADS_PIN_OTHER_PROFILE_PIN_PRESENT');
  }
  if (operation === 'unpin' && !state.profileContainsTarget) fail('THREADS_PIN_TARGET_NOT_PROFILE_PINNED');
}

function baseReceipt(input, bundle, source, before, deps) {
  const contract = CONTRACTS[input.operation];
  return {
    service: 'threads', operation: input.operation, owner: OWNER, ownerId: bundle.ownerId,
    ownerVerified: true, postId: input.postId, targetAuthor: OWNER, desiredPinned: input.desiredPinned,
    currentTargetPinned: before.target.isPinnedToProfile,
    ownerProfilePinnedPostIds: before.ownerProfilePinnedPostIds,
    executionMode: 'pure_http', browserUsed: false,
    credentialProvider: 'windows_dpapi_current_user', credentialValuesRecorded: false,
    captured: false,
    captureSource: source.captureSource,
    client_exists: true, remnant_free: true,
    credential_propagated: false,
    readCredentialPropagated: deps.querySender === sendMetaQuery,
    live_replay: false,
    writes: 0,
    sourceAssetPath: source.assetPath,
    sourceAssetSha256: source.assetSha256,
    sourceFingerprint: source.sourceFingerprint,
    request: { method: 'POST', path: '/api/graphql', operation: contract.operation,
      docId: contract.docId, variables: { post_id: input.postId } },
    checkedAt: new Date().toISOString(),
  };
}

export async function pinThreadsPost(input = {}, {
  contextLoader = openMetaContext,
  querySender = sendMetaQuery,
  mutationSender = sendMetaQuery,
  postReader = inspectThreadsPost,
  profileReader = readThreadsProfileTimeline,
  sourceLoader = loadThreadsPinSource,
  sessionLock = withMetaSessionLock,
  journalRoot = defaultJournalRoot(),
} = {}) {
  const normalized = normalizeInput(input);
  const deps = { contextLoader, querySender, postReader, profileReader };
  return sessionLock('threads', async () => {
    const context = await contextLoader('threads', OWNER);
    const bundle = verifyOwnerContext(context);
    const sourceEvidence = await sourceLoader(context);
    if (!sourceEvidence || sourceEvidence.operation !== 'ThreadsOwnerProfilePinMenu'
      || !/^[a-f0-9]{64}$/.test(sourceEvidence.sourceFingerprint || '')
      || sourceEvidence.captured !== false) fail('THREADS_PIN_SOURCE_CONTRACT_UNVERIFIED');
    const before = await readCurrentState(context, normalized.postId, deps);
    const receipt = baseReceipt(normalized, bundle, sourceEvidence, before.state, deps);
    const identity = { ownerId: bundle.ownerId, operation: normalized.operation,
      postId: normalized.postId, desiredPinned: normalized.desiredPinned };
    const file = journalFile(journalRoot, bundle.ownerId, normalized.operation, normalized.postId);
    const existing = await readJournal(file, identity);

    if (existing) {
      const matches = stateMatches(normalized.operation, before.state);
      if (normalized.reconcile) {
        const status = matches ? 'verified' : 'needs_reconciliation';
        const reconciled = { ...existing, status, readbackVerified: matches,
          currentState: before.state, credential_propagated: existing.dispatchConfirmed,
          live_replay: matches && existing.dispatchConfirmed && existing.mutationResponseVerified === true,
          updatedAt: new Date().toISOString() };
        await atomicWrite(file, reconciled);
        return { ...receipt, ...reconciled, success: matches, writes: existing.writes, journalPath: file };
      }
      if (matches && ['verified', 'succeeded'].includes(existing.status)) {
        return { ...receipt, ...existing, noOp: true, success: true, readbackVerified: true,
          writes: existing.writes, journalPath: file };
      }
      fail('THREADS_PIN_RECONCILE_FIRST');
    }
    if (stateMatches(normalized.operation, before.state)) {
      return { ...receipt, success: true, noOp: true, readbackVerified: true, ready: true };
    }
    assertReady(normalized.operation, before.state);
    const plan = { ...receipt, ready: true, stateBefore: before.state };
    if (!normalized.execute) return plan;

    const request = buildThreadsPinRequest(context, normalized.operation, normalized.postId);

    const journalPath = file;
    const reserved = {
      version: 1, service: 'threads', operation: normalized.operation, owner: OWNER,
      ownerId: bundle.ownerId, postId: normalized.postId, author: OWNER,
      desiredPinned: normalized.desiredPinned, sourceFingerprint: sourceEvidence.sourceFingerprint,
      writes: 1, dispatchConfirmed: false, mutationResponseVerified: false,
      status: 'dispatch_reserved', stateBefore: before.state,
      request: { method: 'POST', path: '/api/graphql', operation: CONTRACTS[normalized.operation].operation,
        docId: CONTRACTS[normalized.operation].docId, variables: { post_id: normalized.postId } },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    await atomicWrite(journalPath, reserved, { create: true });

    let mutationResult = null;
    let mutationState = null;
    let failureCode = null;
    try {
      mutationResult = await mutationSender(context, request);
      mutationState = decodeThreadsPinMutation(mutationResult?.payload, normalized.operation);
    } catch (error) { failureCode = safeCode(error); }
    const dispatchConfirmed = mutationSender === sendMetaQuery
      && mutationResult?.receipt?.httpStatus === 200;
    const mutationResponseVerified = mutationState?.matchesRequestedState === true;
    const needsReconciliation = {
      ...reserved, status: 'needs_reconciliation', dispatchConfirmed, mutationResponseVerified,
      ...(failureCode ? { failureCode } : {}),
      ...(Number.isInteger(mutationResult?.receipt?.httpStatus) ? { httpStatus: mutationResult.receipt.httpStatus } : {}),
      updatedAt: new Date().toISOString(),
    };
    await atomicWrite(journalPath, needsReconciliation);

    let after = null;
    try {
      const fresh = await contextLoader('threads', OWNER);
      verifyOwnerContext(fresh);
      after = await readCurrentState(fresh, normalized.postId, deps);
    } catch (error) { failureCode ||= safeCode(error); }
    const readbackVerified = after != null && stateMatches(normalized.operation, after.state);
    const success = readbackVerified;
    const finalRecord = {
      ...needsReconciliation,
      status: success ? 'succeeded' : readbackVerified ? 'verified' : 'needs_reconciliation',
      readbackVerified,
      currentState: after?.state || before.state,
      credential_propagated: dispatchConfirmed,
      live_replay: success && dispatchConfirmed,
      ...(failureCode ? { failureCode } : {}),
      updatedAt: new Date().toISOString(),
    };
    await atomicWrite(journalPath, finalRecord);
    return { ...receipt, ...finalRecord, success, journalPath,
      ready: true, readCredentialPropagated: deps.querySender === sendMetaQuery };
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [operation, postId, flag] = process.argv.slice(2);
  if (process.argv.length > 5 || flag && !['--execute', '--reconcile'].includes(flag)) {
    console.log(JSON.stringify({ ok: false, code: 'THREADS_PIN_INPUT_INVALID' })); process.exitCode = 1;
  } else pinThreadsPost({ operation, postId, execute: flag === '--execute', reconcile: flag === '--reconcile' })
    .then(result => { console.log(JSON.stringify(result)); if (result.success === false) process.exitCode = 2; })
    .catch(error => { console.log(JSON.stringify({ ok: false, code: safeCode(error) })); process.exitCode = 1; });
}

export const THREADS_PIN_CONTRACTS = CONTRACTS;
