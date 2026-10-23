const scopes = {
  THREADS_REPLY_SERVER_INTEGRITY_BLOCKED: 'reply_integrity',
  THREADS_REPLY_SERVER_FETCH_POLICY_BLOCKED: 'reply_endpoint_policy',
};
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const postId = value => /^\d{10,25}$/.test(value || '') ? value : null;
const readbackCodes = new Set(['THREADS_REPLY_SCAN_INCOMPLETE',
  'THREADS_REPLY_QUOTE_READBACK_UNVERIFIED', 'THREADS_REPLY_CREATED_POST_MISMATCH', 'THREADS_REPLY_PARENT_READBACK_MISMATCH',
  'THREADS_REPLY_OWNER_TIMELINE_REQUIRED']);

// The checked-in 2026-10-01 capture records one complete 61-byte HTTP 400
// JSON body with only {message,status}; its exact known message is the
// integrity refusal. No code/subcode was present, so do not generalize this
// verdict to any other 400 response.
export function threadsReplyWriteWasExplicitlyRefused(value) {
  const status = Number(value?.writeHttpStatus ?? value?.httpStatus);
  const keys = value?.providerTopLevelKeys;
  return status === 400 && value?.providerContentTypeClass === 'json'
    && value?.providerBodyBytes === 61 && value?.providerBodyTruncated === false
    && value?.providerRejectionCategory === 'integrity_blocked'
    && Array.isArray(keys) && keys.length === 2 && [...keys].sort().join(',') === 'message,status';
}

export function safeThreadsReplyRequestShape(value) {
  if (![1, 2, 3].includes(value?.version) || value.method !== 'POST' || value.path !== '/api/v1/media/configure_text_only_post/') return null;
  const result = { version: value.version, method: value.method, path: value.path };
  const name = item => typeof item === 'string' && /^[A-Za-z_][A-Za-z0-9_-]{0,79}$/.test(item);
  for (const key of ['formKeys', 'headerNames']) if (Array.isArray(value[key])) result[key] = value[key].filter(name).slice(0, 80);
  for (const key of ['appInfoTypes', 'textEntityTypes']) if (value[key] && typeof value[key] === 'object') {
    result[key] = Object.fromEntries(Object.entries(value[key]).filter(([k,v]) => name(k)
      && ['null', 'array', 'string', 'boolean', 'number', 'object', 'undefined'].includes(v)).slice(0, 80));
  }
  for (const key of ['parentIdsMatch', 'captionMatches', 'quotedPostPresent', 'quotedPostMatches', 'refererMatches',
    'csrfBodyMatchesHeader', 'webSessionBodyMatchesHeader', 'nullDraftPresent', 'draftOmitted', 'composerSessionPresent', 'crossSharingOmitted']) {
    if (typeof value[key] === 'boolean') result[key] = value[key];
  }
  if (/^[0-9a-f]{64}$/.test(value.fingerprint || '')) result.fingerprint = value.fingerprint;
  return result;
}

// A saved response is evidence about one target, not an account-wide status.
// A parent-comment scan cannot prove that a prior reply was never created.
export function threadsReplyRefusal(value, fallback = {}) {
  const code = value?.writeFailureCode || value?.code;
  if (!scopes[code]) return null;
  const explicitlyRefused = threadsReplyWriteWasExplicitlyRefused(value) || value?.writeOutcome === 'not_created_explicit_refusal';
  return { schemaVersion: 1, code, scope: scopes[code], automaticWritesBlocked: true,
    targetOnly: true, ...(explicitlyRefused ? { writeOutcome: 'not_created_explicit_refusal' } : {}),
    origin: value.reconciliationOnly === true ? 'saved_write' : Number(value.writes) > 0 || value.writeSent === true ? 'live_write' : 'unknown',
    firstWriteAt: timestamp(value.writeAttemptAt || value.writeStartedAt || fallback.firstWriteAt),
    responseAt: timestamp(value.writeResponseAt || fallback.responseAt),
    originalHttpStatus: Number(value.httpStatus) === 400 ? 400 : null,
    postId: postId(value.postId || fallback.postId),
    specificCauseKnown: false,
    readback: value.success === true && value.readbackVerified === true ? 'verified_present' : 'unverified',
    reconciliationCode: readbackCodes.has(value.reconciliationCode) ? value.reconciliationCode : null,
    lastReconciledAt: value.reconciliationOnly === true ? timestamp(value.checkedAt) : null };
}

export function safeThreadsReplyRefusal(value) {
  if (!value || !scopes[value.code] || value.automaticWritesBlocked !== true) return null;
  return { schemaVersion: 1, code: value.code, scope: scopes[value.code], automaticWritesBlocked: true,
    targetOnly: value.targetOnly !== false,
    ...(value.writeOutcome === 'not_created_explicit_refusal' ? { writeOutcome: 'not_created_explicit_refusal' } : {}),
    origin: ['saved_write', 'live_write', 'unknown'].includes(value.origin) ? value.origin : 'unknown',
    firstWriteAt: timestamp(value.firstWriteAt), responseAt: timestamp(value.responseAt), originalHttpStatus: value.originalHttpStatus === 400 ? 400 : null,
    postId: postId(value.postId), specificCauseKnown: false,
    readback: value.readback === 'verified_present' ? 'verified_present' : 'unverified',
    reconciliationCode: readbackCodes.has(value.reconciliationCode) ? value.reconciliationCode : null,
    lastReconciledAt: timestamp(value.lastReconciledAt) };
}
