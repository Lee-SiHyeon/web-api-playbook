import { createHash } from 'node:crypto';
import { ApiError } from '../../scripts/client.mjs';

const writeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const safeField = /^[A-Za-z_$][\w$.-]{0,100}$/;

export function classifyEditorCapability(value = '') {
  const text = String(value).toLowerCase();
  if (/nidlogin|(?:^|\/)login(?:\.|\/|$)|auth(?:enticate|orize)?/.test(text)) return 'authentication_navigation';
  if (/postdelete|deletepost|remove(?:post|log)|\/delete/.test(text)) return 'delete';
  if (/postupdate|updatepost|modify(?:post|log)|\/update/.test(text)) return 'update';
  if (/postwrite|writepost|publish|submitpost|\/write/.test(text)) return 'publish';
  if (/autosave|auto_save|draft|temporary|temp(?:save|post)|saveasdraft/.test(text)) return 'draft_or_autosave';
  if (/\.(?:swf|js|css|png|jpe?g|gif|webp|svg)\b|preview|setslidephoto\d*(?:view|preview)/.test(text)) return 'media_asset';
  if (/upload|attach|photo|image|video|media|file/.test(text)) return 'media_upload';
  if (/sticker|emoticon/.test(text)) return 'sticker';
  if (/template|format|preset|documentmodel/.test(text)) return 'template_or_document';
  if (/editor|smarteditor|postwriteform|postupdateform/.test(text)) return 'editor_surface';
  return 'unclassified';
}

export function normalizeEditorCandidate(candidate = {}, context = {}) {
  if (!candidate || typeof candidate !== 'object') throw new ApiError('INPUT', 'Candidate must be an object');
  const url = typeof candidate.url === 'string' ? candidate.url : null;
  const path = typeof candidate.path === 'string' ? candidate.path : url ? new URL(url).pathname : null;
  if (!path || !path.startsWith('/') || /[\r\n]/.test(path)) throw new ApiError('INPUT', 'Candidate path is required');
  const method = typeof candidate.method === 'string' ? candidate.method.toUpperCase() : null;
  if (method && !['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    throw new ApiError('INPUT', 'Unsupported candidate method');
  }
  const queryFields = Array.isArray(candidate.queryFields)
    ? [...new Set(candidate.queryFields.filter(field => typeof field === 'string' && safeField.test(field)))].sort()
    : [];
  const formFieldNames = Array.isArray(candidate.formFieldNames)
    ? [...new Set(candidate.formFieldNames.filter(field => typeof field === 'string' && safeField.test(field)))].sort()
    : [];
  const terms = Array.isArray(candidate.terms)
    ? [...new Set(candidate.terms.filter(term => typeof term === 'string' && term.length <= 100))].sort()
    : [];
  const resourceType = typeof candidate.resourceType === 'string' && /^[a-z_]{1,40}$/.test(candidate.resourceType)
    ? candidate.resourceType : null;
  const capability = classifyEditorCapability([url, path, ...terms, ...formFieldNames].filter(Boolean).join(' '));
  const mutationCandidate = writeMethods.has(method) || ['publish', 'update', 'delete', 'draft_or_autosave', 'media_upload'].includes(capability);
  const key = `${url ?? 'origin-unresolved'}|${path}|${method ?? 'UNKNOWN'}|${queryFields.join(',')}|${formFieldNames.join(',')}|${resourceType ?? ''}`;
  return {
    id: createHash('sha256').update(key).digest('hex').slice(0, 20),
    origin: url ? new URL(url).origin : null,
    path,
    method,
    queryFields,
    formFieldNames,
    terms,
    resourceType,
    capability,
    mutationCandidate,
    executable: false,
    valuesObserved: false,
    source: typeof context.source === 'string' ? context.source : 'unknown_evidence',
    confidence: typeof context.confidence === 'string' ? context.confidence : 'candidate_only',
  };
}

export function mergeEditorCandidates(records = []) {
  if (!Array.isArray(records)) throw new ApiError('INPUT', 'Candidate collection must be an array');
  const merged = new Map();
  for (const record of records) {
    const key = `${record.origin ?? ''}|${record.path}|${record.method ?? ''}|${record.queryFields.join(',')}|${record.formFieldNames.join(',')}|${record.resourceType ?? ''}`;
    if (!merged.has(key)) {
      merged.set(key, { ...record, sources: [record.source], confidenceLevels: [record.confidence] });
      continue;
    }
    const previous = merged.get(key);
    previous.terms = [...new Set([...previous.terms, ...record.terms])].sort();
    previous.sources = [...new Set([...previous.sources, record.source])].sort();
    previous.confidenceLevels = [...new Set([...previous.confidenceLevels, record.confidence])].sort();
    previous.mutationCandidate ||= record.mutationCandidate;
    if (previous.capability === 'unclassified' && record.capability !== 'unclassified') previous.capability = record.capability;
  }
  return [...merged.values()].sort((a, b) => `${a.capability}:${a.path}`.localeCompare(`${b.capability}:${b.path}`));
}
