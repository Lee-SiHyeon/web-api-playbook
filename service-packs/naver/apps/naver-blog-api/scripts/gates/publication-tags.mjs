import {fingerprint} from '../../../../packages/contracts/src/index.mjs';

// The observed PostBottomCommon check_tagsvalidate permits at most 30 tags and
// isValidateTagLength checks each tag's JS string length against 100.
// Callers supply already-selected tags; normalization never silently rewrites
// a reviewed tag, adds a hashtag marker or turns prose into metadata.
export function validPublicationTags(tags, {allowEmpty = false} = {}) {
  return Array.isArray(tags) && tags.length >= (allowEmpty ? 0 : 1) && tags.length <= 30 &&
    tags.every(tag => typeof tag === 'string' && tag === tag.normalize('NFC') && tag.length >= 1 && tag.length <= 100 && /^[\p{L}\p{N}\p{M}]+$/u.test(tag)) &&
    new Set(tags.map(tag => tag.toLocaleLowerCase('en-US'))).size === tags.length;
}

export const samePublicationTags = (expected, actual) => validPublicationTags(expected) &&
  validPublicationTags(actual) && fingerprint(expected) === fingerprint(actual);

export function serializePublicationTags(tags) {
  if (!validPublicationTags(tags)) throw Error('PUBLICATION_TAGS_INVALID');
  return tags.join(',');
}

export function parseOwnerTags(value) {
  if (typeof value !== 'string') throw Error('OWNER_TAGS_UNOBSERVED');
  const tags = value === '' ? [] : value.split(',');
  if (!validPublicationTags(tags, {allowEmpty: true})) throw Error('OWNER_TAGS_NONCANONICAL');
  return tags;
}

export function publicationTagsReadback(job, observation) {
  return {publicTagsVerified: samePublicationTags(job?.publishSettings?.tags, observation?.tags) && observation?.tagsObserved === true};
}

export function parsePublicTagResponse(data, logNo) {
  if (!data || !Array.isArray(data.taglist) || data.taglist.length > 1 || data.taglist.some(row => row?.logno !== String(logNo) || row.msg !== '' || typeof row.tagName !== 'string')) throw Error('PUBLIC_TAG_RESPONSE_SCOPE');
  if (!data.taglist.length) return [];
  return parseOwnerTags(decodeURIComponent(data.taglist[0].tagName.replace(/\+/g, '%20')));
}

export function tagsOnlyContentFingerprint(job) {
  return fingerprint({operation: job?.operation, blogId: job?.blogId, target: job?.target,
    executionMode: job?.executionMode, tags: job?.tags, preflight: job?.preflight});
}

const hasOnly = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const recent = (time, now, minutes) => Number.isFinite(Date.parse(time)) && Date.parse(time) <= now.getTime() && now.getTime() - Date.parse(time) <= minutes * 60000;
const hash = value => /^[a-f0-9]{64}$/.test(value || '');

export function evaluateTagsOnlyJob(job, {now = new Date(), requireAuthorization = true} = {}) {
  const preflight = job?.preflight, auth = job?.authorization;
  const checks = {
    metadataOnlyInput: hasOnly(job, ['jobId', 'operation', 'blogId', 'target', 'tags', 'executionMode', 'preflight', 'authorization']),
    operationScope: job?.operation === 'update_tags' && job?.blogId === 'aicandoanything' && job?.executionMode === 'independent_http',
    targetScope: hasOnly(job?.target, ['type', 'logNo']) && job.target.type === 'update' && /^\d{6,}$/.test(String(job.target.logNo || '')),
    jobIdPresent: typeof job?.jobId === 'string' && job.jobId.length >= 6,
    canonicalTags: validPublicationTags(job?.tags),
    preflightBound: !requireAuthorization || preflight?.kind === 'independent_http_tags_preflight' && preflight.source === 'independent_http' &&
      preflight.blogId === job.blogId && String(preflight.logNo) === String(job.target.logNo) && recent(preflight.checkedAt, now, 30) &&
      ['sourceModelFingerprint', 'sourceDocumentFingerprint', 'sourceConfigurationFingerprint', 'sourceMetadataFingerprint', 'sourcePublicFingerprint'].every(key => hash(preflight[key])) &&
      validPublicationTags(preflight.originalTags, {allowEmpty: true}),
    fillsMissingTagsOnly: !requireAuthorization || preflight?.originalTags?.length === 0,
    authorization: !requireAuthorization || auth?.approved === true && auth.approvedBy === 'user' && auth.scope === 'update_tags_once' &&
      recent(auth.approvedAt, now, 120) && auth.contentFingerprint === tagsOnlyContentFingerprint(job),
  };
  return {passed: Object.values(checks).every(value => value === true), checks, failedChecks: Object.keys(checks).filter(key => checks[key] !== true)};
}
