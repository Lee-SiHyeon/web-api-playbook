const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function cleanAccount(value) {
  if (typeof value !== 'string' || value.length > 80 || CONTROL.test(value)) return null;
  const account = value.trim().replace(/^@/, '').toLowerCase();
  return /^[a-z0-9_.]{1,30}$/.test(account) ? account : null;
}

function comparableText(value) {
  if (typeof value !== 'string' || value.length > 20_000 || CONTROL.test(value)) return null;
  return value.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').trim();
}

function ownPostUrl(site, value) {
  if (typeof value !== 'string' || value.length > 2_000 || CONTROL.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const segments = url.pathname.split('/').filter(Boolean);
  if (site === 'x') {
    if (!['x.com', 'www.x.com'].includes(url.hostname) || segments.length !== 3 || segments[1] !== 'status' ||
        !/^\d{1,25}$/.test(segments[2])) return null;
    const account = cleanAccount(segments[0]);
    return account ? { account, url: `https://x.com/${account}/status/${segments[2]}` } : null;
  }
  if (site === 'threads') {
    if (!['threads.com', 'www.threads.com'].includes(url.hostname) || segments.length !== 3 || segments[1] !== 'post' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(segments[2]) || !segments[0].startsWith('@')) return null;
    const account = cleanAccount(segments[0]);
    return account ? { account, url: `https://www.threads.com/@${account}/post/${segments[2]}` } : null;
  }
  return null;
}

/**
 * Confirm a newly-created post using the exact author's post URL, visible body,
 * and timestamp. A composer closing or a URL without matching content is not
 * sufficient evidence that the requested post exists.
 */
export function verifyOwnPostReadback({ site, account, expectedText, attemptedAt, checkedAt = Date.now(),
  candidates = [], beforeUrls = [] } = {}) {
  const expectedAccount = cleanAccount(account);
  const body = comparableText(expectedText);
  if (!['x', 'threads'].includes(site) || !expectedAccount || body === null || !Number.isFinite(attemptedAt) ||
      !Number.isFinite(checkedAt) || !Array.isArray(candidates) || candidates.length > 500 ||
      !Array.isArray(beforeUrls) || beforeUrls.length > 500) {
    return { outcome: 'outcome_unknown', reason: 'READBACK_INPUT_INVALID' };
  }
  const previouslyVisible = new Set(beforeUrls.flatMap(value => {
    const identity = ownPostUrl(site, value);
    return identity ? [identity.url] : [];
  }));
  const matches = new Map();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const identity = ownPostUrl(site, candidate.url);
    if (!identity || previouslyVisible.has(identity.url) || identity.account !== expectedAccount || comparableText(candidate.text) !== body) continue;
    if (typeof candidate.createdAt !== 'string' || !Number.isFinite(Date.parse(candidate.createdAt))) continue;
    const createdAt = Date.parse(candidate.createdAt);
    if (createdAt < attemptedAt - 1_000 || createdAt > checkedAt + 120_000) continue;
    matches.set(identity.url, { url: identity.url, account: identity.account, createdAt: new Date(createdAt).toISOString() });
  }
  if (matches.size === 1) return { outcome: 'verified', ...matches.values().next().value, textMatched: true };
  return { outcome: 'outcome_unknown', reason: matches.size > 1
    ? 'MULTIPLE_MATCHING_OWN_POSTS' : 'NO_EXACT_OWN_POST_READBACK' };
}

/** Submit at most once, then poll only the caller's independent readback. */
export async function submitOnce({ preflight, submit, readback, wait, maxPolls = 45,
  state = { submissionAttempted: false, outcomeUnknown: false, needsReconciliation: false } } = {}) {
  if (typeof preflight !== 'function' || typeof submit !== 'function' || typeof readback !== 'function' ||
      typeof wait !== 'function' || !Number.isSafeInteger(maxPolls) || maxPolls < 1 || maxPolls > 120 ||
      !state || typeof state !== 'object' || Array.isArray(state)) {
    return { outcome: 'not_submitted', submissionAttempted: false, needsReconciliation: false, reason: 'SUBMIT_INPUT_INVALID' };
  }
  let ready;
  try { ready = await preflight(); }
  catch {
    const result = { outcome: 'not_submitted', submissionAttempted: false, outcomeUnknown: false,
      needsReconciliation: false, reason: 'SUBMIT_PREFLIGHT_FAILED' };
    Object.assign(state, result); return result;
  }
  if (ready !== true) {
    const result = { outcome: 'not_submitted', submissionAttempted: false, outcomeUnknown: false,
      needsReconciliation: false, reason: ready?.reason ?? 'SUBMIT_PREFLIGHT_REJECTED' };
    Object.assign(state, result); return result;
  }

  // A CDP error can arrive after the browser received the event, so any error
  // while dispatching the single click is ambiguous and must not be retried.
  Object.assign(state, { submissionAttempted: true, outcome: 'outcome_unknown',
    outcomeUnknown: true, needsReconciliation: true });
  try { await submit(); }
  catch {
    const result = { outcome: 'outcome_unknown', submissionAttempted: true, outcomeUnknown: true,
      needsReconciliation: true, reason: 'SUBMIT_DISPATCH_UNCONFIRMED' };
    Object.assign(state, result); return result;
  }

  for (let poll = 0; poll < maxPolls; poll++) {
    let result;
    try { result = await readback(); }
    catch { result = null; }
    if (result?.outcome === 'verified' && typeof result.url === 'string' && result.textMatched === true) {
      const completed = { ...result, submissionAttempted: true, outcomeUnknown: false, needsReconciliation: false };
      Object.assign(state, completed); return completed;
    }
    // Only an explicit, caller-verified rejection can end the reconciliation
    // loop as a failure. A generic toast/timeout is never treated as rejection.
    if (result?.outcome === 'rejected' && result.explicitlyRejected === true) {
      const rejected = { outcome: 'rejected', submissionAttempted: true, outcomeUnknown: false,
        needsReconciliation: false,
        reason: typeof result.reason === 'string' ? result.reason : 'SUBMIT_EXPLICITLY_REJECTED' };
      Object.assign(state, rejected); return rejected;
    }
    if (poll + 1 < maxPolls) {
      try { await wait(); }
      catch {
        const unknown = { outcome: 'outcome_unknown', submissionAttempted: true, outcomeUnknown: true,
          needsReconciliation: true, reason: 'POST_RECONCILIATION_WAIT_FAILED' };
        Object.assign(state, unknown); return unknown;
      }
    }
  }
  const unknown = { outcome: 'outcome_unknown', submissionAttempted: true, outcomeUnknown: true,
    needsReconciliation: true, reason: 'POST_READBACK_NOT_FOUND' };
  Object.assign(state, unknown); return unknown;
}
