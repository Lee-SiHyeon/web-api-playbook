import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, access, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildAffiliateDraft } from './draft-generator.mjs';
import { evaluateAffiliateDraft } from './quality-gate.mjs';
import { evaluateStageGate, evaluatePublishPackageGate } from './stage-gates.mjs';
import { buildWorkflowClaimLedger } from './claim-ledger.mjs';
import { JevSupervisor, jevConfig, choiceValue } from './jev-supervisor.mjs';
import {
  assessFreshness,
  assessTopicProductRelevance,
  assessTrendInput,
  classifyWorkflowRisk,
  compactTrendData,
} from './workflow-policy.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const affiliateRoot = path.resolve(projectRoot, '..', 'affiliate-api-hub');
const runsRoot = path.join(projectRoot, 'workflow-runs');
const WORKFLOW_VERSION = 'affiliate-content-e2e-v2';

function parseArgs(args) {
  const provided = { seed: false, topic: false, jevMode: false };
  const options = {
    seed: '도킹형 보조배터리',
    topic: null,
    jevMode: process.env.JEV_MODE || 'shadow',
    refreshTrends: false,
    refreshProducts: false,
    resume: null,
  };
  for (const arg of args) {
    if (arg === '--refresh-trends') options.refreshTrends = true;
    else if (arg === '--refresh-products') options.refreshProducts = true;
    else if (arg.startsWith('--seed=')) { options.seed = arg.slice('--seed='.length).trim(); provided.seed = true; }
    else if (arg.startsWith('--topic=')) { options.topic = arg.slice('--topic='.length).trim(); provided.topic = true; }
    else if (arg.startsWith('--jev-mode=')) { options.jevMode = arg.slice('--jev-mode='.length).trim(); provided.jevMode = true; }
    else if (arg.startsWith('--resume=')) options.resume = arg.slice('--resume='.length).trim();
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unsupported argument: ${arg}`);
  }
  Object.defineProperty(options, 'provided', { value: provided, enumerable: false });
  return options;
}

function usage() {
  return [
    'Affiliate content E2E workflow',
    '',
    'node workflows/affiliate-content-e2e/run.mjs [options]',
    '',
    '--seed=도킹형 보조배터리',
    '--topic=도킹형 보조배터리 추천',
    '--jev-mode=off|shadow|active',
    '--refresh-trends',
    '--refresh-products   # requires logged-in Coupang Partners Chrome',
    '--resume=<run-id>',
    '',
    'The workflow ends at ready_for_review. It never publishes automatically.',
  ].join('\n');
}

function slug(value) {
  return String(value || 'topic').replace(/[^0-9A-Za-z가-힣]+/gu, '-').replace(/^-+|-+$/g, '') || 'topic';
}

function compactStamp(date = new Date()) {
  return date.toISOString().replace(/[-:.]/g, '').replace('Z', 'Z');
}

async function exists(target) {
  try { await access(target, fsConstants.F_OK); return true; } catch { return false; }
}

async function readJson(target) {
  return JSON.parse(await readFile(target, 'utf8'));
}

async function readJsonWithDigest(target) {
  const text = await readFile(target, 'utf8');
  return {
    data: JSON.parse(text),
    sha256: createHash('sha256').update(text).digest('hex'),
    bytes: Buffer.byteLength(text),
  };
}

async function writeJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

async function runProcess(command, args, { cwd = projectRoot, timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ code, stdout, stderr });
      else reject(new Error(`${command} exited ${code}: ${(stderr || stdout).slice(-1000)}`));
    });
  });
}

function normalize(value) {
  return String(value || '').replace(/\s+/g, '').toLowerCase();
}

export function topicCandidates(trend, seed, explicitTopic = null) {
  const target = normalize(seed);
  const group = (trend.seedExpansions || []).find(item => normalize(item.seed) === target)
    || (trend.seedExpansions || []).find(item => normalize(item.seed).includes(target) || target.includes(normalize(item.seed)));
  const rows = (group?.suggestions || [])
    .filter(item => !item.semanticDrift)
    .map(item => ({
      keyword: item.keyword,
      score: Number(item.opportunityScore || 0),
      buyerIntent: item.buyerIntent === true,
      problemIntent: item.problemIntent === true,
      numericSpecificity: item.numericSpecificity === true,
      tags: item.tags || [],
    }));
  if (explicitTopic && !rows.some(item => item.keyword === explicitTopic)) {
    rows.push({ keyword: explicitTopic, score: 100, buyerIntent: true, problemIntent: false, numericSpecificity: false, tags: ['user_selected'] });
  }
  return rows
    .sort((a, b) => (b.score + Number(b.buyerIntent) * 8 + Number(b.problemIntent) * 6) - (a.score + Number(a.buyerIntent) * 8 + Number(a.problemIntent) * 6))
    .slice(0, 8);
}

function deterministicTopic(candidates, explicitTopic) {
  if (explicitTopic) return explicitTopic;
  return candidates.find(candidate => candidate.buyerIntent)?.keyword
    || candidates.find(candidate => candidate.problemIntent)?.keyword
    || candidates[0]?.keyword;
}

function deterministicFormat({ productCount, communityCount, problemIntent }) {
  if (productCount >= 4) return 'multi_product_comparison';
  if (problemIntent && communityCount >= 8) return 'problem_solution';
  return 'community_consensus';
}

async function updateState(runDirectory, state, stage, status, details = {}) {
  state.updatedAt = new Date().toISOString();
  state.stages[stage] = { status, checkedAt: state.updatedAt, ...details };
  await writeJson(path.join(runDirectory, 'state.json'), state);
}

async function stage(runDirectory, state, name, execute, validate) {
  const receiptPath = path.join(runDirectory, 'receipts', `${name}.json`);
  const gatePath = path.join(runDirectory, 'gates', `${name}.json`);
  if (state.stages[name]?.status === 'completed' && await exists(receiptPath)) {
    const receipt = await readJson(receiptPath);
    const semanticValid = !validate || validate(receipt);
    const gate = evaluateStageGate(name, receipt);
    if (semanticValid && gate.passed) {
      await writeJson(gatePath, gate);
      return receipt;
    }
  }
  await updateState(runDirectory, state, name, 'in_progress');
  try {
    const receipt = await execute();
    if (validate && !validate(receipt)) throw new Error(`Semantic completion check failed for ${name}`);
    const gate = evaluateStageGate(name, receipt);
    await writeJson(gatePath, gate);
    if (!gate.passed) {
      throw new Error(`GATE_FAILED:${name}:${gate.failedChecks.join(',')}`);
    }
    await writeJson(receiptPath, receipt);
    await updateState(runDirectory, state, name, 'completed', {
      receipt: path.relative(runDirectory, receiptPath),
      gate: path.relative(runDirectory, gatePath),
      gateFingerprint: gate.inputFingerprint,
    });
    return receipt;
  } catch (error) {
    await updateState(runDirectory, state, name, 'failed', { error: String(error?.message || error).slice(0, 1000) });
    throw error;
  }
}

function referenceBriefPath(topic) {
  return path.join(projectRoot, 'research', `brief-${slug(topic)}.json`);
}

function stageSummary(name, data) {
  return { schemaVersion: 1, stage: name, completed: true, checkedAt: new Date().toISOString(), ...data };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(usage()); return; }
  const runId = options.resume || `${compactStamp()}-${slug(options.seed)}`;
  const runDirectory = path.join(runsRoot, runId);
  await mkdir(path.join(runDirectory, 'receipts'), { recursive: true });
  await mkdir(path.join(runDirectory, 'gates'), { recursive: true });
  await mkdir(path.join(runDirectory, 'jev'), { recursive: true });
  await mkdir(path.join(runDirectory, 'assets'), { recursive: true });
  const statePath = path.join(runDirectory, 'state.json');
  const state = await exists(statePath)
    ? await readJson(statePath)
    : {
      schemaVersion: 1,
      workflowVersion: WORKFLOW_VERSION,
      runId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      requested: {
        seed: options.seed,
        topic: options.topic,
        jevMode: options.jevMode,
        refreshTrends: options.refreshTrends,
        refreshProducts: options.refreshProducts,
        resume: options.resume,
      },
      stages: {},
      autoPublishAllowed: false,
    };
  if (options.resume && state.requested) {
    for (const key of ['seed', 'topic', 'jevMode']) {
      const prior = state.requested[key];
      if (!options.provided[key] && prior !== undefined) options[key] = prior;
      else if (options.provided[key] && prior !== undefined && options[key] !== prior) {
        throw new Error(`Resume option mismatch for ${key}: prior run uses ${prior}`);
      }
    }
  }
  await writeJson(statePath, state);

  const supervisor = new JevSupervisor({
    config: jevConfig(process.env, { mode: options.jevMode }),
    receiptDirectory: path.join(runDirectory, 'jev'),
  });

  const policyReceipt = await stage(runDirectory, state, '00-policy', async () => {
    const policy = classifyWorkflowRisk(options.topic || options.seed);
    return stageSummary('policy', { workflowVersion: WORKFLOW_VERSION, policy });
  }, receipt => typeof receipt.policy?.allowed === 'boolean');
  if (!policyReceipt.policy.allowed) {
    state.status = 'blocked_policy';
    state.completedAt = new Date().toISOString();
    await writeJson(statePath, state);
    throw new Error(`RISK_POLICY_BLOCK: ${policyReceipt.policy.matchedRules.join(',')}`);
  }

  const trendReceipt = await stage(runDirectory, state, '01-trends', async () => {
    const latest = path.join(projectRoot, 'research', 'trend-radar', 'latest.json');
    let current = null;
    if (await exists(latest)) current = await readJson(latest);
    const currentAssessment = current ? assessTrendInput(current, options.seed, { maxAgeHours: 24 }) : null;
    if (options.refreshTrends || !currentAssessment?.usable) {
      await runProcess('node', ['research/trend-radar/run.mjs', `--seed=${options.seed.replaceAll(' ', '')},보조배터리`], { timeoutMs: 240000 });
    }
    const source = await readJsonWithDigest(latest);
    const sourceAssessment = assessTrendInput(source.data, options.seed, { maxAgeHours: 24 });
    if (!sourceAssessment.usable) {
      throw new Error(`TREND_INPUT_UNUSABLE: fresh=${sourceAssessment.fresh} hasSeed=${sourceAssessment.hasSeed}`);
    }
    const trend = compactTrendData(source.data, options.seed);
    return stageSummary('trends', {
      source: path.relative(projectRoot, latest),
      sourceSha256: source.sha256,
      sourceBytes: source.bytes,
      sourceAssessment,
      data: trend,
      semanticContract: {
        shoppingContractsSucceeded: trend.coverage?.shoppingContractsSucceeded || 0,
        autocompleteSeedsSucceeded: trend.coverage?.autocompleteSeedsSucceeded || 0,
        browserUsed: trend.browserUsedForNormalExecution === true,
      },
    });
  }, receipt => receipt.data?.seedExpansions?.length > 0 && receipt.semanticContract.browserUsed === false);

  const topicReceipt = await stage(runDirectory, state, '02-topic-selection', async () => {
    const candidates = topicCandidates(trendReceipt.data, options.seed.replaceAll(' ', ''), options.topic);
    if (!candidates.length) throw new Error('No topic candidates available');
    const fallback = deterministicTopic(candidates, options.topic);
    const optionById = Object.fromEntries(candidates.map((candidate, index) => [`topic_${index}`, candidate]));
    const fallbackId = Object.entries(optionById).find(([, candidate]) => candidate.keyword === fallback)?.[0] || 'topic_0';
    if (candidates.length === 1) {
      return stageSummary('topic-selection', {
        candidates,
        deterministicFallback: fallback,
        selected: fallback,
        selectionSource: 'deterministic_single_option',
        jevDecisionId: null,
      });
    }
    const jev = await supervisor.evaluate({
      decisionId: 'topic-selection',
      state: { seed: options.seed, candidates: optionById },
      questions: {
        topic: {
          type: 'choice',
          instructions: {
            question: 'Which allowed candidate in `candidates` is the clearest commercially useful Naver Blog topic?',
            inspect: 'candidates',
            focus: 'Prefer one reader decision, buyer or problem intent, and enough specificity for a non-generic article.',
          },
          criteria: Object.fromEntries(Object.entries(optionById).map(([id, candidate]) => [
            id,
            { keyword: candidate.keyword, score: candidate.score, tags: candidate.tags, buyerIntent: candidate.buyerIntent, problemIntent: candidate.problemIntent },
          ])),
        },
      },
      fallbacks: { topic: fallbackId },
    });
    const selectedId = choiceValue(jev, 'topic');
    return stageSummary('topic-selection', { candidates, deterministicFallback: fallback, selected: optionById[selectedId]?.keyword || fallback, jevDecisionId: 'topic-selection' });
  }, receipt => typeof receipt.selected === 'string' && receipt.selected.length > 2);

  const referenceReceipt = await stage(runDirectory, state, '03-reference-brief', async () => {
    const target = referenceBriefPath(topicReceipt.selected);
    await runProcess('python', ['-X', 'utf8', 'research/topic_brief.py', topicReceipt.selected, '--limit', '8'], { timeoutMs: 180000 });
    const data = await readJson(target);
    return stageSummary('reference-brief', { source: path.relative(projectRoot, target), data });
  }, receipt => receipt.data?.summary?.postCount >= 5);

  const communityReceipt = await stage(runDirectory, state, '04-community-radar', async () => {
    await runProcess('python', ['-X', 'utf8', 'research/community-radar/run.py', options.seed], { timeoutMs: 180000 });
    const target = path.join(projectRoot, 'research', 'community-radar', 'latest.json');
    const data = await readJson(target);
    return stageSummary('community-radar', { source: path.relative(projectRoot, target), data });
  }, receipt => receipt.data?.querySuccessCount >= 6 && receipt.data?.browserUsed === false);

  const productReceipt = await stage(runDirectory, state, '05-product-comparison', async () => {
    if (options.refreshProducts) {
      await runProcess('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/capture-coupang-search-products.ps1', '-Query', options.seed], { cwd: affiliateRoot, timeoutMs: 180000 });
      await runProcess('node', ['scripts/compare-coupang-products.mjs'], { cwd: affiliateRoot, timeoutMs: 120000 });
      await runProcess('node', ['research/build-product-comparison-brief.mjs'], { timeoutMs: 120000 });
    }
    const comparisonPath = path.join(affiliateRoot, 'references', 'coupang-product-comparison.json');
    const briefPath = path.join(projectRoot, 'research', 'brief-coupang-speedy-multi-product.json');
    const selectionPath = path.join(affiliateRoot, 'references', 'selected-product-speedy.json');
    const comparisonSource = await readJsonWithDigest(comparisonPath);
    const briefSource = await readJsonWithDigest(briefPath);
    const selectionSource = await readJsonWithDigest(selectionPath);
    const comparison = comparisonSource.data;
    const brief = briefSource.data;
    const freshness = assessFreshness(comparison.checkedAt, { maxAgeHours: 24 });
    const relevance = assessTopicProductRelevance({ topic: topicReceipt.selected, seed: options.seed, comparison });
    if (!freshness.fresh) throw new Error(`PRODUCT_DATA_STALE: ageHours=${freshness.ageHours}`);
    if (!relevance.relevant) {
      throw new Error(`PRODUCT_TOPIC_MISMATCH: topic=${topicReceipt.selected} productQuery=${comparison.query}`);
    }
    const affiliateUrl = selectionSource.data?.selection?.affiliateUrl || '';
    if (!/^https:\/\/link\.coupang\.com\/a\/[A-Za-z0-9]+$/.test(affiliateUrl)) {
      throw new Error('AFFILIATE_LINK_MISSING_OR_INVALID');
    }
    return stageSummary('product-comparison', {
      comparisonSource: comparisonPath,
      briefSource: path.relative(projectRoot, briefPath),
      selectionSource: selectionPath,
      sourceDigests: {
        comparison: comparisonSource.sha256,
        brief: briefSource.sha256,
        selection: selectionSource.sha256,
      },
      freshness,
      relevance,
      affiliateUrl,
      comparison,
      brief,
    });
  }, receipt => receipt.brief?.comparisonProducts?.length >= 4
    && receipt.comparison?.executable === false
    && receipt.freshness?.fresh === true
    && receipt.relevance?.relevant === true);

  const claimReceipt = await stage(runDirectory, state, '05a-claim-evidence', async () => {
    const ledger = buildWorkflowClaimLedger({
      productReceipt,
      communityReceipt,
      referenceReceipt,
      trendReceipt,
    });
    await writeJson(path.join(runDirectory, 'claim-evidence-ledger.json'), ledger);
    return stageSummary('claim-evidence', {
      checkedAt: new Date().toISOString(),
      ledger,
      claimCount: ledger.claims.length,
      evidenceCount: Object.keys(ledger.evidence).length,
    });
  }, receipt => Array.isArray(receipt?.ledger?.claims) && receipt.ledger.claims.length > 0);

  const formatReceipt = await stage(runDirectory, state, '06-format-selection', async () => {
    const productCount = productReceipt.brief.comparisonProducts.length;
    const communityCount = communityReceipt.data.articleCount || 0;
    const selectedTrend = topicCandidates(trendReceipt.data, options.seed.replaceAll(' ', ''), topicReceipt.selected).find(item => item.keyword === topicReceipt.selected);
    const fallback = deterministicFormat({ productCount, communityCount, problemIntent: selectedTrend?.problemIntent });
    const jev = await supervisor.evaluate({
      decisionId: 'format-selection',
      state: {
        topic: topicReceipt.selected,
        evidence: { productCount, communityCount, referencePostCount: referenceReceipt.data.summary.postCount },
        allowedFormats: {
          multi_product_comparison: 'Compare at least four products and explain scenario-specific winners',
          problem_solution: 'Lead with one repeated problem and use products as bounded solutions',
          community_consensus: 'Organize repeated public community questions without claiming consensus as fact',
        },
      },
      questions: {
        format: {
          type: 'choice',
          instructions: 'Which `allowedFormats` entry best fits the available `evidence` for this `topic`?',
          criteria: {
            multi_product_comparison: 'Several current comparable products and decision axes are available',
            problem_solution: 'One problem is the dominant reader intent and product comparison is secondary',
            community_consensus: 'Community questions are the main evidence and product data is too thin for a comparison',
          },
        },
      },
      fallbacks: { format: fallback },
    });
    return stageSummary('format-selection', { selected: choiceValue(jev, 'format') || fallback, deterministicFallback: fallback, jevDecisionId: 'format-selection' });
  }, receipt => ['multi_product_comparison', 'problem_solution', 'community_consensus'].includes(receipt.selected));

  const draftReceipt = await stage(runDirectory, state, '07-draft', async () => {
    const draft = buildAffiliateDraft({
      topic: topicReceipt.selected,
      format: formatReceipt.selected,
      comparisonBrief: productReceipt.brief,
      community: communityReceipt.data,
      referenceBrief: referenceReceipt.data,
      affiliateUrl: productReceipt.affiliateUrl,
      claimLedger: claimReceipt.ledger,
    });
    const draftPath = path.join(runDirectory, 'draft.md');
    const draftJsonPath = path.join(runDirectory, 'draft.json');
    await writeFile(draftPath, draft.markdown, 'utf8');
    await writeJson(draftJsonPath, draft);
    return stageSummary('draft', { draftPath: path.relative(runDirectory, draftPath), draftJsonPath: path.relative(runDirectory, draftJsonPath), draft });
  }, receipt => receipt.draft?.markdown?.length >= 1800 && receipt.draft?.metadata?.productCount >= 4);

  const chartReceipt = await stage(runDirectory, state, '08-chart', async () => {
    const source = path.join(projectRoot, 'research', 'brief-coupang-speedy-multi-product.json');
    const output = path.join(runDirectory, 'assets', 'product-price-comparison.png');
    await runProcess('python', ['-X', 'utf8', 'workflows/affiliate-content-e2e/render-comparison-chart.py', source, output], { timeoutMs: 120000 });
    const existsOnDisk = await exists(output);
    const file = existsOnDisk ? await stat(output) : null;
    return stageSummary('chart', {
      source,
      output: path.relative(runDirectory, output),
      exists: existsOnDisk,
      bytes: file?.size || 0,
    });
  }, receipt => receipt.exists === true);

  const gateReceipt = await stage(runDirectory, state, '09-quality-gate', async () => {
    const rubric = await readJson(path.join(projectRoot, 'research', 'editorial-quality-rubric.json'));
    const gate = evaluateAffiliateDraft({
      draft: draftReceipt.draft,
      comparisonBrief: productReceipt.brief,
      community: communityReceipt.data,
      rubric,
    });
    const fallbackNext = gate.passed ? 'ready_for_review' : gate.hardBlocks.length ? 'gather_more_evidence' : 'revise_draft';
    const qualityLevel = gate.score >= 90 ? 3 : gate.score >= 80 ? 2 : gate.score >= 65 ? 1 : 0;
    const jev = await supervisor.evaluate({
      decisionId: 'editorial-assessment',
      state: {
        topic: topicReceipt.selected,
        format: formatReceipt.selected,
        deterministicGate: {
          score: gate.score,
          threshold: gate.threshold,
          hardBlocks: gate.hardBlocks,
          metrics: gate.metrics,
        },
        evidence: {
          referencePosts: referenceReceipt.data.summary.postCount,
          communityArticles: communityReceipt.data.articleCount,
          comparisonProducts: productReceipt.brief.comparisonProducts.length,
        },
      },
      questions: {
        evidence_sufficient: {
          type: 'noul',
          instructions: 'Does `evidence` support a transparent comparison article without pretending that unmeasured claims were tested?',
          criteria: {
            true: 'Multiple current products, public reader questions and source limitations are all explicit',
            false: 'The main conclusion depends on missing measurements or unsupported experience claims',
          },
        },
        quality: {
          type: 'score',
          instructions: 'How editorially complete is the proposed article represented by `deterministicGate` and `evidence`?',
          criteria: [
            'Unsafe or too thin to review',
            'Useful structure but substantial evidence or decision support is missing',
            'Reviewable and transparent with only ordinary editorial polish remaining',
            'Exceptionally complete, differentiated and ready for a final human review',
          ],
        },
        next_action: {
          type: 'choice',
          instructions: 'Which allowed next action best follows from `deterministicGate` and `evidence`?',
          criteria: {
            ready_for_review: 'Hard gates pass and the article can be shown to a human reviewer',
            gather_more_evidence: 'A factual or safety evidence gap blocks responsible publication',
            revise_draft: 'Evidence is adequate but writing or structure needs another pass',
            stop: 'The topic or workflow is not viable',
          },
        },
      },
      fallbacks: { evidence_sufficient: gate.passed, quality: qualityLevel, next_action: fallbackNext },
    });
    return stageSummary('quality-gate', {
      gate,
      jevDecisionId: 'editorial-assessment',
      jevAdvice: {
        nextAction: choiceValue(jev, 'next_action'),
        note: 'Jev advice never overrides deterministic hard blocks or publish authorization.',
      },
    });
  }, receipt => typeof receipt.gate?.score === 'number' && receipt.gate?.policy?.autoPublishAllowed === false);

  const finalStatus = gateReceipt.gate.passed ? 'ready_for_review' : gateReceipt.gate.status;
  const publishPackage = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    runId,
    status: finalStatus,
    title: draftReceipt.draft.title,
    topic: topicReceipt.selected,
    format: formatReceipt.selected,
    draft: 'draft.md',
    assets: [chartReceipt.output],
    affiliateLinks: [{ product: productReceipt.brief.selectedProduct.title, url: productReceipt.affiliateUrl }],
    claimLedger: 'claim-evidence-ledger.json',
    quality: { score: gateReceipt.gate.score, threshold: gateReceipt.gate.threshold, hardBlocks: gateReceipt.gate.hardBlocks },
    jev: { mode: supervisor.config.mode, provider: supervisor.config.provider, advice: gateReceipt.jevAdvice },
    publishAuthorized: false,
    automaticPublishingPerformed: false,
  };
  await writeJson(path.join(runDirectory, 'publish-package.json'), publishPackage);
  const publishPackageGate = evaluatePublishPackageGate(publishPackage);
  await writeJson(path.join(runDirectory, 'gates', 'publish-package.json'), publishPackageGate);
  if (!publishPackageGate.passed) {
    throw new Error(`GATE_FAILED:publish-package:${publishPackageGate.failedChecks.join(',')}`);
  }
  const summary = [
    `# Affiliate content workflow — ${runId}`,
    '',
    `- 상태: **${finalStatus}**`,
    `- 주제: ${topicReceipt.selected}`,
    `- 포맷: ${formatReceipt.selected}`,
    `- 품질 점수: ${gateReceipt.gate.score}/${gateReceipt.gate.threshold}`,
    `- 비교 제품: ${productReceipt.brief.comparisonProducts.length}개`,
    `- 커뮤니티 공개 글: ${communityReceipt.data.articleCount}개`,
    `- 네이버 레퍼런스: ${referenceReceipt.data.summary.postCount}개`,
    `- Jev: ${supervisor.config.mode} / ${supervisor.config.provider || 'provider_unavailable'}`,
    '- 자동 게시: 수행하지 않음',
    '',
    '## 산출물',
    '',
    '- `draft.md`',
    '- `assets/product-price-comparison.png`',
    '- `publish-package.json`',
    '- `receipts/`',
    '- `jev/`',
    '',
  ].join('\n');
  await writeFile(path.join(runDirectory, 'summary.md'), summary, 'utf8');
  state.status = finalStatus;
  state.completedAt = new Date().toISOString();
  state.publishAuthorized = false;
  await writeJson(statePath, state);
  console.log(JSON.stringify({
    completed: true,
    runId,
    runDirectory,
    status: finalStatus,
    topic: topicReceipt.selected,
    format: formatReceipt.selected,
    qualityScore: gateReceipt.gate.score,
    hardBlocks: gateReceipt.gate.hardBlocks,
    jevMode: supervisor.config.mode,
    jevProvider: supervisor.config.provider,
    automaticPublishingPerformed: false,
  }));
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invokedPath === import.meta.url) {
  main().catch(error => {
    console.error(JSON.stringify({ completed: false, code: 'WORKFLOW_FAILED', message: String(error?.message || error).slice(0, 1000) }));
    process.exitCode = 1;
  });
}
