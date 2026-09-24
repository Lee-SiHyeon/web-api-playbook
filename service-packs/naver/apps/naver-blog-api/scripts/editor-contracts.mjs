import { readFile } from 'node:fs/promises';
import { ApiError } from './client.mjs';

const catalog = JSON.parse(await readFile(new URL('../references/editor-contract-candidates.json', import.meta.url), 'utf8'));
if (!catalog || catalog.executableCandidates !== 0 || catalog.valuesObserved !== false || !Array.isArray(catalog.candidates)) {
  throw new ApiError('CATALOG_UNSAFE', 'Editor contract catalog must remain non-executable candidate metadata');
}

export const editorCandidates = Object.freeze(catalog.candidates.map(candidate => Object.freeze({
  id: candidate.id,
  origin: candidate.origin ?? null,
  path: candidate.path,
  method: candidate.method ?? null,
  queryFields: Object.freeze([...(candidate.queryFields || [])]),
  formFieldNames: Object.freeze([...(candidate.formFieldNames || [])]),
  resourceType: candidate.resourceType ?? null,
  capability: candidate.capability,
  mutationCandidate: candidate.mutationCandidate === true,
  executable: false,
  valuesObserved: false,
  confidenceLevels: Object.freeze([...(candidate.confidenceLevels || [])]),
  sources: Object.freeze([...(candidate.sources || [])]),
})));

export function listEditorCandidates({ capability = null, mutationOnly = false } = {}) {
  if (capability !== null && (typeof capability !== 'string' || !/^[a-z_]{1,64}$/.test(capability))) {
    throw new ApiError('INPUT', 'Invalid capability filter');
  }
  if (typeof mutationOnly !== 'boolean') throw new ApiError('INPUT', 'mutationOnly must be boolean');
  return editorCandidates.filter(candidate => (!capability || candidate.capability === capability)
    && (!mutationOnly || candidate.mutationCandidate));
}

export function getEditorCandidate(id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{20}$/.test(id)) throw new ApiError('INPUT', 'Invalid candidate id');
  const candidate = editorCandidates.find(entry => entry.id === id);
  if (!candidate) throw new ApiError('UNKNOWN_CANDIDATE', 'Editor contract candidate was not found');
  return candidate;
}

export function executeEditorCandidate() {
  throw new ApiError('NOT_IMPLEMENTED', 'Editor mutation execution is intentionally unavailable until an observed contract is separately reviewed');
}
