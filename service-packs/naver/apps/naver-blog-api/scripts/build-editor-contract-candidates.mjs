import { readdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { BLOG_ID } from './client.mjs';
import { classifyEditorCapability, mergeEditorCandidates, normalizeEditorCandidate } from '../tools/discovery/editor-contract-normalizer.mjs';

async function latest(prefix) {
  const directory = new URL('../evidence/', import.meta.url);
  const names = (await readdir(directory)).filter(name => name.startsWith(prefix) && name.endsWith('.json')).sort().reverse();
  if (!names.length) return null;
  return { name: names[0], data: JSON.parse(await readFile(new URL(names[0], directory), 'utf8')) };
}

function timestamp(value = new Date()) {
  return value.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export async function buildEditorContractCandidates({ now = () => new Date() } = {}) {
  const surface = await latest('live-editor-surface-');
  const scripts = await latest('public-editor-script-analysis-');
  const normalized = [];

  if (surface?.data?.completed === true) {
    const warmup = surface.data.browserWarmup;
    for (const request of warmup?.requests || []) {
      if (!request?.url || !request?.method) continue;
      const capability = classifyEditorCapability(request.url);
      if (!request.blocked && !['xhr', 'fetch', 'document'].includes(request.resourceType) && capability === 'unclassified') continue;
      normalized.push(normalizeEditorCandidate(request, {
        source: `${surface.name}:browser_request`,
        confidence: request.blocked ? 'browser_attempt_blocked_before_send' : 'browser_read_request_observed',
      }));
    }
    for (const form of warmup?.dom?.forms || []) {
      if (!form?.url || !form?.method) continue;
      normalized.push(normalizeEditorCandidate(form, {
        source: `${surface.name}:browser_dom_form`, confidence: 'browser_dom_literal_form',
      }));
    }
    for (const candidate of surface.data.linkContracts || []) {
      if (!candidate?.url) continue;
      normalized.push(normalizeEditorCandidate(candidate, {
        source: `${surface.name}:html_literal`, confidence: candidate.state === 'read_candidate' ? 'observed_read_metadata' : 'observed_candidate_metadata',
      }));
    }
    for (const scan of surface.data.sourceScans || []) {
      for (const candidate of scan.candidates || []) {
        normalized.push(normalizeEditorCandidate(candidate, {
          source: `${surface.name}:source_scan`, confidence: 'source_string_candidate',
        }));
      }
    }
  }

  if (scripts?.data) {
    for (const analysis of scripts.data.analyses || []) {
      for (const candidate of analysis.candidates || []) {
        normalized.push(normalizeEditorCandidate(candidate, {
          source: `${scripts.name}:public_script`, confidence: 'public_script_string_candidate',
        }));
      }
    }
  }

  const candidates = mergeEditorCandidates(normalized);
  const checkedAt = now();
  const record = {
    schemaVersion: 1,
    checkedAt: checkedAt.toISOString(),
    actor: BLOG_ID,
    mode: 'editor_contract_candidate_normalization',
    sourceEvidence: [surface?.name, scripts?.name].filter(Boolean),
    candidateCount: candidates.length,
    mutationCandidates: candidates.filter(candidate => candidate.mutationCandidate).length,
    executableCandidates: 0,
    valuesObserved: false,
    mutationRequests: 0,
    candidates,
  };
  const evidenceDestination = new URL(`../evidence/editor-contract-candidates-${timestamp(checkedAt)}.json`, import.meta.url);
  const referenceDestination = new URL('../references/editor-contract-candidates.json', import.meta.url);
  const text = JSON.stringify(record, null, 2) + '\n';
  await writeFile(evidenceDestination, text, { flag: 'wx' });
  await writeFile(referenceDestination, text);
  return { record, evidenceDestination, referenceDestination };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invokedPath === import.meta.url) {
  buildEditorContractCandidates().then(({ record, evidenceDestination }) => {
    console.log(JSON.stringify({ completed: true, candidateCount: record.candidateCount,
      mutationCandidates: record.mutationCandidates,
      evidenceFile: evidenceDestination.pathname.split('/').at(-1), mutationRequests: 0 }));
  }).catch(error => {
    console.error(JSON.stringify({ code: error?.code || 'NORMALIZATION_FAILED', message: 'Editor contract normalization failed' }));
    process.exitCode = 1;
  });
}
