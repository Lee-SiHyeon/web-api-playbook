import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const naverRoot = path.resolve(currentDir, '..', '..');

export async function loadTravelAdapterRegistry(naverDirectory = naverRoot) {
  const upstream = path.resolve(naverDirectory, '..', 'affiliate-api-hub', 'references', 'travel-adapters.json');
  try { return JSON.parse(await readFile(upstream, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Packaged snapshots separate the original sibling apps into service-packs/naver and service-packs/affiliate.
  const packaged = path.resolve(naverDirectory, '../../..', 'affiliate', 'apps', 'affiliate-api-hub', 'references', 'travel-adapters.json');
  return JSON.parse(await readFile(packaged, 'utf8'));
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, '');
}

function matchesPatterns(keyword, patterns = []) {
  const target = normalize(keyword);
  return patterns.some(pattern => target.includes(normalize(pattern)));
}

function matchesCluster(keyword, cluster) {
  return matchesPatterns(keyword, cluster.patterns);
}

function adapterState(adapter) {
  return {
    id: adapter.id,
    priority: adapter.priority,
    verification: adapter.verification,
    accessState: adapter.accessState,
    roles: adapter.roles,
    nextAction: adapter.nextAction,
  };
}

export function buildVerticalBrief(profile, trendRecord, adapterRegistry) {
  const adaptersById = new Map(adapterRegistry.adapters.map(adapter => [adapter.id, adapter]));
  const candidates = [];

  for (const group of trendRecord.seedExpansions || []) {
    for (const suggestion of group.suggestions || []) {
      candidates.push({
        keyword: suggestion.keyword,
        score: suggestion.opportunityScore ?? 0,
        tags: suggestion.tags || [],
        source: 'autocomplete',
        seed: group.seed,
      });
    }
  }

  for (const idea of trendRecord.contentIdeas || []) {
    if (!matchesPatterns(idea.keyword, profile.contextPatterns || [])) continue;
    candidates.push({
      keyword: idea.keyword,
      score: idea.score ?? 0,
      tags: [],
      source: 'content_idea',
      format: idea.format,
      reason: idea.reason || [],
    });
  }

  const deduped = new Map();
  for (const candidate of candidates) {
    const key = normalize(candidate.keyword);
    const current = deduped.get(key);
    if (!current || candidate.score > current.score) deduped.set(key, candidate);
  }

  const clusterResults = profile.clusters.map(cluster => {
    const opportunities = [...deduped.values()]
      .filter(candidate => matchesCluster(candidate.keyword, cluster))
      .sort((a, b) => b.score - a.score || a.keyword.localeCompare(b.keyword, 'ko'))
      .slice(0, 20);
    const preferred = cluster.preferredAdapters.map(id => adaptersById.get(id)).filter(Boolean);
    const capabilityCoverage = Object.fromEntries(cluster.requiredCapabilities.map(capability => [
      capability,
      preferred.filter(adapter => adapter.capabilities.includes(capability)).map(adapter => adapter.id),
    ]));
    const missingCapabilities = Object.entries(capabilityCoverage)
      .filter(([, ids]) => ids.length === 0)
      .map(([capability]) => capability);
    const verifiedMonetization = preferred.filter(adapter => (
      adapter.roles.includes('monetization') && adapter.verification !== 'design_only'
    ));
    const liveMonetization = verifiedMonetization.filter(adapter => (
      ['live_read_verified', 'live_write_verified'].includes(adapter.verification)
    ));

    return {
      id: cluster.id,
      name: cluster.name,
      opportunities,
      preferredAdapters: preferred.map(adapterState),
      capabilityCoverage,
      missingCapabilities,
      readyForContentResearch: opportunities.length > 0,
      hasVerifiedMonetizationPath: verifiedMonetization.length > 0 && missingCapabilities.length === 0,
      readyForMonetizationIntegration: liveMonetization.length > 0 && missingCapabilities.length === 0,
      requiresAccountOrKey: preferred.some(adapter => !['public', 'account_portal'].includes(adapter.accessState)),
    };
  });

  return {
    schemaVersion: 1,
    checkedAt: trendRecord.checkedAt,
    vertical: profile.id,
    sourceMode: trendRecord.mode,
    sourceCoverage: trendRecord.coverage,
    clusterResults,
    topOpportunities: clusterResults
      .flatMap(cluster => cluster.opportunities.map(item => ({ ...item, cluster: cluster.id })))
      .sort((a, b) => b.score - a.score)
      .filter((item, index, list) => (
        list.findIndex(other => normalize(other.keyword) === normalize(item.keyword)) === index
      ))
      .slice(0, 40),
    adapterGaps: clusterResults
      .filter(cluster => cluster.missingCapabilities.length || !cluster.readyForMonetizationIntegration)
      .map(cluster => ({
        id: cluster.id,
        missingCapabilities: cluster.missingCapabilities,
        preferredAdapters: cluster.preferredAdapters.map(item => item.id),
        requiresAccountOrKey: cluster.requiresAccountOrKey,
        hasVerifiedMonetizationPath: cluster.hasVerifiedMonetizationPath,
        readyForMonetizationIntegration: cluster.readyForMonetizationIntegration,
      })),
    browserUsedForNormalExecution: false,
    credentialsPersisted: false,
  };
}

function markdown(brief) {
  const lines = [
    `# ${brief.vertical} vertical trend brief`,
    '',
    `- checkedAt: ${brief.checkedAt}`,
    `- API-only source mode: ${brief.sourceMode}`,
    `- browser used: ${brief.browserUsedForNormalExecution}`,
    '',
    '## Top opportunities',
    '',
    '| Rank | Keyword | Score | Cluster | Source |',
    '|---:|---|---:|---|---|',
    ...brief.topOpportunities.map((item, index) => (
      `| ${index + 1} | ${item.keyword} | ${item.score} | ${item.cluster} | ${item.source} |`
    )),
    '',
    '## Adapter coverage',
    '',
  ];
  for (const cluster of brief.clusterResults) {
    lines.push(`### ${cluster.name}`, '');
    lines.push(`- verified monetization path: ${cluster.hasVerifiedMonetizationPath}`);
    lines.push(`- live monetization ready: ${cluster.readyForMonetizationIntegration}`);
    lines.push(`- missing capabilities: ${cluster.missingCapabilities.join(', ') || 'none'}`);
    lines.push(`- adapters: ${cluster.preferredAdapters.map(item => `${item.id}(${item.verification})`).join(', ') || 'none'}`);
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

export async function buildFromFiles(verticalId = 'travel') {
  const profile = JSON.parse(
    await readFile(path.join(currentDir, 'verticals', `${verticalId}.json`), 'utf8'),
  );
  const trend = JSON.parse(await readFile(path.join(currentDir, 'latest.json'), 'utf8'));
  const adapters = await loadTravelAdapterRegistry();
  const brief = buildVerticalBrief(profile, trend, adapters);
  const outputDir = path.join(currentDir, 'vertical-latest');
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, `${verticalId}.json`), JSON.stringify(brief, null, 2) + '\n');
  await writeFile(path.join(outputDir, `${verticalId}.md`), markdown(brief));
  return brief;
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invoked === import.meta.url) {
  const brief = await buildFromFiles(process.argv[2] || 'travel');
  console.log(JSON.stringify({
    completed: true,
    vertical: brief.vertical,
    topOpportunityCount: brief.topOpportunities.length,
    gapCount: brief.adapterGaps.length,
  }));
}
