import { authError, decodeJson } from '../../tistory-api/lib/auth.mjs';
import { safeError, withAuthenticatedSession } from '../../tistory-api/lib/operations.mjs';
import { createHash } from 'node:crypto';

const TISTORY_ORIGIN = 'https://www.tistory.com';
const FOLLOWING_LIST_PATH = '/legacy/subscription/user/followings?isSummary=false';
const MAX_PUBLIC_PAGE_BYTES = 2 * 1024 * 1024;
const ACTIONS = Object.freeze({
  subscribe: { method: 'POST', route: 'add', desired: true },
  unsubscribe: { method: 'DELETE', route: 'delete', desired: false },
});

function fail(code) {
  return authError(code);
}

function normalizeBlogId(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,16}$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? String(id) : null;
}

function blogReference(value) {
  if (typeof value !== 'string') throw fail('TISTORY_TARGET_INVALID');
  let reference = value.trim();
  if (!reference || reference.length > 2048 || /[\x00-\x20\x7f]/.test(reference)) {
    throw fail('TISTORY_TARGET_INVALID');
  }

  if (reference.startsWith('@')) reference = reference.slice(1);
  if (/^[a-z0-9-]+$/i.test(reference)) reference = `https://${reference}.tistory.com`;
  else if (!/^https:\/\//i.test(reference)) reference = `https://${reference}`;

  let url;
  try { url = new URL(reference); } catch { throw fail('TISTORY_TARGET_INVALID'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
    || !/^[a-z0-9-]+\.tistory\.com$/.test(host)) {
    throw fail('TISTORY_TARGET_SCOPE');
  }
  return { host, reference: `https://${host}` };
}

function attribute(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(tag)?.[2] ?? null;
}

export function resolveBlogIdFromHtml(html, expectedHost) {
  if (typeof html !== 'string' || !/^[a-z0-9-]+\.tistory\.com$/i.test(expectedHost || '')) {
    throw fail('TISTORY_TARGET_IDENTITY_INVALID');
  }
  const ids = new Set();

  // Current public blog pages expose the blog identifier in the first-party BLOG config.
  // Some home pages omit the subscription button, so the config is the canonical fallback.
  for (const match of html.matchAll(/["']BLOG["']\s*:\s*\{\s*["']id["']\s*:\s*["']?(\d{1,16})["']?/g)) {
    const id = normalizeBlogId(match[1]);
    if (id) ids.add(id);
  }

  const buttons = html.match(/<button\b[^>]*>/gi) || [];
  for (const button of buttons) {
    if (!/(?:^|\s)btn_subscription(?:\s|$)/.test(attribute(button, 'class') || '')) continue;
    const id = normalizeBlogId(attribute(button, 'data-blog-id'));
    if (id) ids.add(id);
    const pageUrl = attribute(button, 'data-url');
    if (pageUrl) {
      try {
        const parsed = new URL(pageUrl);
        if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== expectedHost.toLowerCase()) {
          throw fail('TISTORY_TARGET_IDENTITY_MISMATCH');
        }
      } catch (error) {
        if (error?.code === 'TISTORY_TARGET_IDENTITY_MISMATCH') throw error;
        throw fail('TISTORY_TARGET_IDENTITY_MISMATCH');
      }
    }
  }

  if (ids.size !== 1) throw fail(ids.size ? 'TISTORY_TARGET_IDENTITY_AMBIGUOUS' : 'TISTORY_TARGET_ID_UNRESOLVED');
  return [...ids][0];
}

async function readBoundedText(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PUBLIC_PAGE_BYTES) {
        await reader.cancel().catch(() => {});
        throw fail('TISTORY_TARGET_PAGE_TOO_LARGE');
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error?.code === 'TISTORY_TARGET_PAGE_TOO_LARGE') throw error;
    throw fail('TISTORY_TARGET_PAGE_READ_FAILED');
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

async function resolveTarget(input, { fetchImpl = globalThis.fetch } = {}) {
  const value = input?.target ?? input?.blogId;
  const numeric = normalizeBlogId(value);
  if (numeric) return { blogId: numeric, reference: String(value).trim(), canonicalUrl: null };

  if (typeof value !== 'string') throw fail('TISTORY_TARGET_INVALID');
  const target = blogReference(value);
  if (typeof fetchImpl !== 'function') throw fail('TISTORY_FETCH_UNAVAILABLE');

  let response;
  try {
    response = await fetchImpl(`${target.reference}/`, {
      method: 'GET',
      headers: { accept: 'text/html,application/xhtml+xml' },
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw fail('TISTORY_TARGET_TIMEOUT');
    throw fail('TISTORY_TARGET_LOOKUP_FAILED');
  }
  if (response.status === 403) throw fail('TISTORY_TARGET_ACCESS_DENIED');
  if (response.status === 429) throw fail('TISTORY_RATE_LIMITED');
  if (response.status !== 200 || !/\bhtml\b/i.test(response.headers.get('content-type') || '')) {
    throw fail('TISTORY_TARGET_PAGE_UNAVAILABLE');
  }

  const html = await readBoundedText(response);
  const blogId = resolveBlogIdFromHtml(html, target.host);
  return { blogId, reference: value.trim(), canonicalUrl: target.reference };
}

function listUrl() {
  return TISTORY_ORIGIN + FOLLOWING_LIST_PATH;
}

async function readFollowingState(session, blogId) {
  const response = await session.request(listUrl(), {
    method: 'GET',
    headers: { accept: 'application/json' },
    referer: `${TISTORY_ORIGIN}/feed?type=following`,
  });
  const payload = decodeJson(response);
  if (payload?.status !== 200 || !Array.isArray(payload.data)) throw fail('TISTORY_SUBSCRIPTION_LIST_SCHEMA');

  let match = null;
  for (const item of payload.data) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw fail('TISTORY_SUBSCRIPTION_LIST_SCHEMA');
    const itemId = normalizeBlogId(item.id);
    if (!itemId || typeof item.subscribing !== 'boolean') throw fail('TISTORY_SUBSCRIPTION_LIST_SCHEMA');
    if (itemId === blogId) {
      if (match && match.subscribing !== item.subscribing) throw fail('TISTORY_SUBSCRIPTION_LIST_AMBIGUOUS');
      match = item;
    }
  }
  return {
    state: { subscribed: match?.subscribing === true },
    readReceipt: {
      source: 'tistory_followings',
      method: 'GET',
      origin: TISTORY_ORIGIN,
      path: FOLLOWING_LIST_PATH,
      httpStatus: response.status,
      verified: true,
      live_replay: true,
      browserUsed: false,
      checkedAt: new Date().toISOString(),
    },
  };
}

function ownerFingerprint(identity) {
  const userId = identity?.userId == null ? '' : String(identity.userId);
  const blogId = identity?.blogId == null ? '' : String(identity.blogId);
  if (!userId || !blogId) throw fail('TISTORY_OWNER_IDENTITY_REQUIRED');
  return createHash('sha256').update(`tistory\0${userId}\0${blogId}`).digest('hex').slice(0, 16);
}

function ensureNotOwnBlog(target, identity) {
  if (String(identity?.blogId ?? '') === target.blogId) throw fail('TISTORY_SELF_SUBSCRIPTION_BLOCKED');
}

function actionMetadata(operation, target, currentState, receipt, identity, readReceipt) {
  const spec = ACTIONS[operation];
  const needsAction = currentState.subscribed !== spec.desired;
  return {
    service: 'tistory',
    ready: true,
    needsAction,
    noOp: !needsAction,
    ...(needsAction ? {} : { reason: spec.desired ? 'already_subscribed' : 'not_subscribed' }),
    operation,
    target: target.reference,
    targetInfo: { blogId: target.blogId, canonicalUrl: target.canonicalUrl },
    normalizedTarget: target.blogId,
    ownerFingerprint: ownerFingerprint(identity),
    captured: false,
    contractEvidence: 'current_first_party_consumer_javascript',
    client_exists: true,
    remnant_free: true,
    browserUsed: false,
    credential_propagated: true,
    credential_propagated_for_write: false,
    live_replay: false,
    mutationCount: 0,
    currentState: { subscribed: currentState.subscribed },
    readReceipt,
    request: {
      method: spec.method,
      origin: TISTORY_ORIGIN,
      path: `/api/v1/subscription/${spec.route}/${target.blogId}`,
      bodyFields: [],
    },
    auth: {
      authenticated: receipt.authenticated === true,
      ownerVerified: receipt.ownerVerified === true,
      browserUsed: false,
      provider: receipt.provider,
    },
  };
}

function validateOperation(input) {
  const operation = input?.operation;
  if (!Object.hasOwn(ACTIONS, operation)) throw fail('TISTORY_ACTION_INVALID');
  return operation;
}

export async function prepareTistoryAction(input, options = {}) {
  const operation = validateOperation(input);
  const target = await resolveTarget(input, options);
  return withAuthenticatedSession(async ({ session, state, receipt }) => {
    ensureNotOwnBlog(target, state.identity);
    const read = await readFollowingState(session, target.blogId);
    return actionMetadata(operation, target, read.state, receipt, state.identity, read.readReceipt);
  });
}

export async function executeTistoryAction(input, { beforeWrite, fetchImpl = globalThis.fetch } = {}) {
  const operation = validateOperation(input);
  const target = await resolveTarget(input, { fetchImpl });
  const spec = ACTIONS[operation];

  return withAuthenticatedSession(async ({ session, state, receipt }) => {
    ensureNotOwnBlog(target, state.identity);
    const initialRead = await readFollowingState(session, target.blogId);
    const metadata = actionMetadata(operation, target, initialRead.state, receipt, state.identity, initialRead.readReceipt);
    if (!metadata.needsAction) {
      return {
        ...metadata,
        status: 'no_op',
        success: true,
        needs_reconciliation: false,
        mutationCount: 0,
        readbackVerified: true,
        afterState: { subscribed: initialRead.state.subscribed },
      };
    }
    if (typeof beforeWrite !== 'function') throw fail('TISTORY_WRITE_JOURNAL_REQUIRED');

    const journalResult = await beforeWrite(metadata);
    if (journalResult === false) throw fail('TISTORY_WRITE_JOURNAL_REJECTED');

    let writeResponse = null;
    let writeError = null;
    try {
      writeResponse = await session.request(TISTORY_ORIGIN + metadata.request.path, {
        method: spec.method,
        headers: {
          accept: 'application/json',
          origin: TISTORY_ORIGIN,
        },
        referer: `${TISTORY_ORIGIN}/feed?type=following`,
      });
    } catch (error) {
      writeError = safeError(error);
    }

    let afterState = null;
    let readReceipt = null;
    let readbackError = null;
    try {
      const afterRead = await readFollowingState(session, target.blogId);
      afterState = afterRead.state;
      readReceipt = afterRead.readReceipt;
    } catch (error) {
      readbackError = safeError(error);
    }

    const write = writeResponse ? {
      httpStatus: writeResponse.status,
      mime: writeResponse.headers['content-type'] || null,
      bytes: Buffer.byteLength(writeResponse.raw),
    } : null;
    const responseReceived = writeResponse !== null;
    const desiredState = spec.desired;
    const confirmed = afterState?.subscribed === desiredState;

    return {
      ...metadata,
      status: confirmed ? 'succeeded' : 'outcome_unknown',
      success: confirmed,
      needs_reconciliation: !confirmed,
      mutationCount: 1,
      readbackVerified: confirmed,
      currentState: afterState || metadata.currentState,
      live_replay: confirmed,
      credential_propagated_for_write: confirmed && writeResponse?.status >= 200 && writeResponse?.status < 300,
      write,
      ...(writeError ? { writeError } : {}),
      afterState,
      initialReadReceipt: initialRead.readReceipt,
      readReceipt,
      ...(readbackError ? { readbackError } : {}),
      verification: {
        source: 'independent_followings_read',
        confirmed,
        responseReceived,
      },
    };
  });
}
