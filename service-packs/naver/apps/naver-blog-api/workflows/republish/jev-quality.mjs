import fs from 'node:fs/promises';
import path from 'node:path';
import { fingerprint } from '../../../../packages/contracts/src/index.mjs';
import { documentFingerprint, tableRows, text } from '../../scripts/gates/publication-document.mjs';
import { JevSupervisor, jevConfig } from '../affiliate-content-e2e/jev-supervisor.mjs';
import { runReferenceJevQuality, evaluateReferenceJevQualityEvidence } from './reference-jev-quality.mjs';

const MAX_TEXT = 1800;
const MAX_CLAIMS = 80;
const MAX_SOURCES = 8;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Keep the existing adoption floor until it is calibrated on labeled articles.
// For a noul answer, the 0.82 floor implies p(true) >= 0.91 for a positive
// answer. That is stricter than the separate p >= 0.8 quality threshold.
const QUALITY_CONFIDENCE_FLOOR = 0.82;

const clip = (value, limit = MAX_TEXT) => text(value).slice(0, limit);

function blockState(block, index) {
  if (!block || typeof block !== 'object') return { index, type: 'invalid' };
  if (block.type === 'table') {
    let rows = [];
    try { rows = tableRows(block); } catch { rows = []; }
    return { index, type: 'table', id: block.id ?? null, columns: rows[0] ?? [], rows: rows.slice(1, 31) };
  }
  if (['heading', 'notice', 'paragraph', 'quote'].includes(block.type)) {
    return { index, type: block.type, presentation: block.presentation ?? null, text: clip(block.text) };
  }
  if (['list', 'numbered'].includes(block.type)) {
    return { index, type: block.type, items: (block.items ?? []).slice(0, 40).map(clip) };
  }
  if (block.type === 'link') {
    return { index, type: 'link', label: clip(block.label, 400), url: clip(block.url, 1000), display: block.display ?? null };
  }
  if (block.type === 'image') {
    return {
      index,
      type: 'image',
      role: block.role ?? null,
      purpose: clip(block.purpose, 500),
      href: clip(block.href, 1000),
      sourceUrl: clip(block.sourceArtifact?.sourceUrl ?? block.rights?.source, 1000),
    };
  }
  if (block.type === 'imageStrip') {
    return {
      index,
      type: 'imageStrip',
      role: block.role ?? null,
      purpose: clip(block.purpose, 500),
      count: Array.isArray(block.images) ? block.images.length : 0,
    };
  }
  return { index, type: block.type };
}

function claimState(claim, claimBindings = [], sourceIndex = new Map()) {
  const sourceEntries = Array.isArray(claim?.sources) ? claim.sources : [];
  const sources = sourceEntries.flatMap(source => {
    if (source && typeof source === 'object') return [source];
    return claimBindings.filter(binding => binding?.claimId === claim?.claimId && binding?.sourceId === source);
  }).slice(0, MAX_SOURCES);
  return {
    claimId: clip(claim?.claimId, 180),
    text: clip(claim?.text, 1200),
    support: claim?.support ?? null,
    sources: sources.map(source => {
      const sourceId = clip(source?.sourceId, 180);
      const registry = sourceIndex.get(sourceId);
      return {
        sourceId,
        url: clip(registry?.publicUrl ?? registry?.url, 1000),
        sourceKind: clip(registry?.sourceKind, 100),
        collectionMethod: clip(registry?.collectionMethod, 100),
        checkedAt: registry?.checkedAt ?? null,
        locator: clip(source?.locator, 500),
        excerpt: clip(source?.excerpt, 900),
      };
    }),
  };
}

export function buildJevQualityState(document, ledger, claimBindings = [], sourceRegistry = []) {
  const bindings = Array.isArray(claimBindings) ? claimBindings : [];
  const sourceIndex = new Map((Array.isArray(sourceRegistry) ? sourceRegistry : [])
    .filter(source => typeof source?.id === 'string').map(source => [source.id, source]));
  const claims = Array.isArray(ledger?.claims) ? ledger.claims.slice(0, MAX_CLAIMS).map(claim => claimState(claim, bindings, sourceIndex)) : [];
  return {
    kind: 'naver_republish_editorial_quality',
    instruction: 'Review the supplied article and claim evidence. Do not infer facts beyond this state. Return only the requested answer schema for each question.',
    document: {
      blogId: document?.blogId ?? null,
      logNo: String(document?.logNo ?? ''),
      title: clip(document?.title, 300),
      blocks: (Array.isArray(document?.blocks) ? document.blocks : []).map(blockState),
    },
    claimLedger: {
      claimCount: Array.isArray(ledger?.claims) ? ledger.claims.length : 0,
      claims,
    },
  };
}

export const JEV_QUALITY_QUESTIONS = Object.freeze({
  evidence_sufficient: {
    type: 'noul',
    instructions: 'Are the article\'s material factual claims supported by the claim ledger and cited evidence shown in the state? Score 1 only when the evidence is sufficient for publication; score 0 when a material claim is unsupported, ambiguous, or presented more strongly than its evidence.',
    criteria: { '0': 'Material evidence is missing or overstated', '1': 'Material claims are adequately supported' },
  },
  editorial_quality: {
    type: 'score',
    instructions: 'Rate publication readiness of the complete article. Use exactly one integer level: 0 = unsafe or materially incomplete, 1 = usable but has material gaps, 2 = reviewable and transparent, 3 = exceptionally complete and clear.',
    criteria: ['unsafe_or_incomplete', 'usable_with_material_gaps', 'reviewable_and_transparent', 'exceptionally_complete'],
  },
  next_action: {
    type: 'choice',
    instructions: 'Choose the single next action for this exact document revision. Publish only when the evidence, wording, and structure are ready as shown.',
    criteria: { publish: 'Ready for the deterministic publication gates', revise: 'Needs a bounded editorial revision', block: 'Must not be published' },
  },
  ai_slop_free: {
    type: 'noul',
    instructions: 'Does the prose avoid repetitive AI filler, generic disclaimers, fake certainty, canned headings, and the repeated “~아닙니다” style the owner prohibited? Score 1 only when the article reads as intentional, concise Korean prose.',
    criteria: { '0': 'Formulaic or visibly AI-slop prose remains', '1': 'No material AI-slop pattern remains' },
  },
  table_use: {
    type: 'noul',
    instructions: 'Where the article compares items, conditions, prices, plans, benchmarks, or evidence, are the parallel facts organized in tables instead of a dense run-on paragraph? Score 1 when the table choice is appropriate for this article.',
    criteria: { '0': 'A material comparison should be tabular but is not', '1': 'Comparisons are organized appropriately' },
  },
  core_prose: {
    type: 'noul',
    instructions: 'Does each important table have one or two concise sentences that state the takeaway and explain how to read it? Score 1 only when the tables are not left to speak without the article\'s core interpretation.',
    criteria: { '0': 'Important tables lack the core takeaway prose', '1': 'Important tables have concise takeaway prose' },
  },
  unsupported_claims_absent: {
    type: 'noul',
    instructions: 'Are unsupported factual, pricing, experience, or audience claims absent? Score 1 only when the article does not imply testing, completion, or consensus that the evidence does not show.',
    criteria: { '0': 'An unsupported material claim remains', '1': 'Unsupported material claims are absent' },
  },
});

export const JEV_QUALITY_FALLBACKS = Object.freeze({
  evidence_sufficient: 0,
  editorial_quality: 1,
  next_action: 'revise',
  ai_slop_free: 0,
  table_use: 0,
  core_prose: 0,
  unsupported_claims_absent: 0,
});

function check(name, passed, detail = null) {
  return { name, passed: passed === true, ...(detail ? { detail } : {}) };
}

export function evaluateJevQualityEvidence(receipt, {
  document,
  ledger,
  requestFingerprint,
  now = new Date(),
  maxAgeMs = MAX_AGE_MS,
} = {}) {
  if (receipt?.decisionId === 'republish-reference-relative-quality') {
    return evaluateReferenceJevQualityEvidence(receipt, { document, ledger, now });
  }
  const source = receipt?.receipt && typeof receipt.receipt === 'object'
    ? { ...receipt.receipt, ...receipt }
    : receipt;
  const expectedDocumentFingerprint = documentFingerprint(document);
  const expectedLedgerFingerprint = fingerprint(ledger ?? null);
  const checks = [];
  const checkedAt = Date.parse(String(source?.checkedAt ?? ''));
  const evaluationTime = now == null ? Date.now() : new Date(now).getTime();
  const age = Number.isFinite(checkedAt) ? evaluationTime - checkedAt : Infinity;
  checks.push(check('schemaVersion', source?.schemaVersion === 1));
  checks.push(check('decisionId', source?.decisionId === 'republish-editorial-quality'));
  checks.push(check('modeActive', source?.mode === 'active'));
  checks.push(check('providerSucceeded', source?.providerResult === 'ok'));
  checks.push(check('qualityConfidencePolicy', Number(source?.confidenceFloor) >= QUALITY_CONFIDENCE_FLOOR));
  checks.push(check('providerRecorded', typeof source?.provider === 'string' && source.provider.length > 0));
  checks.push(check('modelRecorded', typeof source?.model === 'string' && source.model.length > 0));
  checks.push(check('checkedRecently', Number.isFinite(age) && age >= 0 && age <= maxAgeMs, { ageMs: age }));
  checks.push(check('documentRevisionMatches', source?.documentFingerprint === expectedDocumentFingerprint));
  checks.push(check('claimLedgerRevisionMatches', source?.claimLedgerFingerprint === expectedLedgerFingerprint));
  checks.push(check('requestMatches', !requestFingerprint || source?.requestFingerprint === requestFingerprint));

  const comparisons = source?.comparisons ?? {};
  const adopted = source?.adopted ?? {};
  for (const id of Object.keys(JEV_QUALITY_QUESTIONS)) {
    checks.push(check(`${id}.remoteActive`, comparisons[id]?.eligible === true && comparisons[id]?.adoptedSource === 'jev_active'));
  }
  checks.push(check('evidence_sufficient', Number(adopted.evidence_sufficient?.noul) >= 0.8));
  // Jev's score is an expected value over levels, so valid answers are usually
  // fractional even when the rubric names integer levels.
  checks.push(check('editorial_quality', Number.isFinite(adopted.editorial_quality?.score) &&
    adopted.editorial_quality.score >= 2 && adopted.editorial_quality.score <= 3));
  checks.push(check('next_action', adopted.next_action?.choice === 'publish'));
  for (const id of ['ai_slop_free', 'table_use', 'core_prose', 'unsupported_claims_absent']) {
    checks.push(check(id, Number(adopted[id]?.noul) >= 0.8));
  }
  const failedChecks = checks.filter(item => !item.passed).map(item => item.name);
  return {
    schemaVersion: 1,
    gate: 'jev-quality',
    passed: failedChecks.length === 0,
    checkedAt: new Date(evaluationTime).toISOString(),
    documentFingerprint: expectedDocumentFingerprint,
    claimLedgerFingerprint: expectedLedgerFingerprint,
    requestFingerprint: requestFingerprint ?? null,
    checks,
    failedChecks,
  };
}

export function requireJevQualityEvidence(receipt, options) {
  const result = evaluateJevQualityEvidence(receipt, options);
  if (!result.passed) {
    const code = result.failedChecks.includes('modeActive') || result.failedChecks.includes('providerSucceeded')
      ? 'JEV_QUALITY_REMOTE_REQUIRED'
      : result.failedChecks.some(name => name === 'documentRevisionMatches' || name === 'claimLedgerRevisionMatches' || name === 'requestMatches')
        ? 'JEV_QUALITY_REVISION'
        : 'JEV_QUALITY_FAILED';
    const error = new Error(code);
    error.code = code;
    error.quality = result;
    throw error;
  }
  return result;
}

export async function runJevQuality({ dir, document: suppliedDocument, ledger: suppliedLedger, research: suppliedResearch, fetchImpl, config: suppliedConfig, now = null } = {}) {
  if (!dir) throw new Error('JEV_QUALITY_DIRECTORY_REQUIRED');
  const document = suppliedDocument ?? JSON.parse((await fs.readFile(path.join(dir, 'document.json'), 'utf8')).replace(/^\uFEFF/, ''));
  const ledger = suppliedLedger ?? JSON.parse((await fs.readFile(path.join(dir, 'claim-ledger.json'), 'utf8')).replace(/^\uFEFF/, ''));
  const bundle = await fs.readFile(path.join(dir, 'bundle.json'), 'utf8')
    .then(value => JSON.parse(value.replace(/^\uFEFF/, '')), error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
  const referenceManifestExists = await fs.access(path.join(dir, 'reference-sources.json')).then(() => true, () => false);
  if (bundle?.format === 'ai_research_article' && referenceManifestExists) {
    const result = await runReferenceJevQuality({ dir, document, ledger, fetchImpl,
      config: suppliedConfig, now: now ?? new Date(), mode: 'active' });
    const artifact = { ...result, gate: 'jev-quality',
      policy: { strategy: 'fresh_reference_relative', referenceCount: result.references.length,
        factualAndNativeGatesRemainAuthoritative: true, calibration: 'pilot_two_revisions' } };
    await fs.writeFile(path.join(dir, 'jev-quality.json'), JSON.stringify(artifact, null, 2) + '\n');
    if (!artifact.passed) {
      const code = artifact.failedChecks.includes('providerSucceeded')
        ? 'JEV_REFERENCE_PROVIDER_UNAVAILABLE' : 'JEV_REFERENCE_QUALITY_FAILED';
      const error = new Error(code);
      error.code = code;
      error.quality = artifact;
      throw error;
    }
    return artifact;
  }
  let research = suppliedResearch;
  if (!research) {
    try { research = JSON.parse((await fs.readFile(path.join(dir, 'bundle.json'), 'utf8')).replace(/^\uFEFF/, '')).research; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const state = buildJevQualityState(document, ledger, research?.claimBindings, research?.sources);
  const requestFingerprint = fingerprint(state);
  const config = suppliedConfig ?? jevConfig(process.env, { mode: 'active' });
  const supervisor = new JevSupervisor({ config, fetchImpl });
  const receipt = await supervisor.evaluate({
    decisionId: 'republish-editorial-quality',
    state,
    questions: JEV_QUALITY_QUESTIONS,
    fallbacks: JEV_QUALITY_FALLBACKS,
  });
  const documentFp = documentFingerprint(document);
  const claimLedgerFp = fingerprint(ledger);
  const quality = {
    schemaVersion: 1,
    gate: 'jev-quality',
    checkedAt: receipt.checkedAt,
    documentFingerprint: documentFp,
    claimLedgerFingerprint: claimLedgerFp,
    requestFingerprint,
    decisionId: receipt.decisionId,
    provider: receipt.provider,
    model: receipt.model,
    mode: receipt.mode,
    providerResult: receipt.providerResult,
    receipt,
    policy: {
      remoteActiveRequired: true,
      deterministicFallbackAccepted: false,
      hardPublisherGatesRemainAuthoritative: true,
      maxAgeMs: MAX_AGE_MS,
    },
  };
  const evaluation = evaluateJevQualityEvidence(quality, { document, ledger, requestFingerprint, now: now ?? new Date() });
  const artifact = { ...quality, passed: evaluation.passed, checks: evaluation.checks, failedChecks: evaluation.failedChecks };
  await fs.writeFile(path.join(dir, 'jev-quality.json'), JSON.stringify(artifact, null, 2) + '\n');
  if (!artifact.passed) {
    const code = artifact.failedChecks.includes('modeActive') || artifact.failedChecks.includes('providerSucceeded')
      ? 'JEV_QUALITY_REMOTE_REQUIRED'
      : 'JEV_QUALITY_FAILED';
    const error = new Error(code);
    error.code = code;
    error.quality = artifact;
    throw error;
  }
  return artifact;
}
