import { spawn } from 'node:child_process';
import { lstat, realpath, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const PROVIDERS = ['gemini', 'grok'];
const MAX_OUTPUT = 4 * 1024 * 1024;
const ENV_NAMES = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'];
const LOCAL_CONFIG_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ai-providers.local.json');
export const BUNDLED_PROVIDER_REPOS = Object.freeze(Object.fromEntries(PROVIDERS.map(provider =>
  [provider, fileURLToPath(new URL('../service-packs/' + provider + '/', import.meta.url))])));
const identifier = value => typeof value === 'string' && /^[a-z][a-z0-9._-]{0,127}$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;

export function parseProviderOptions(args) {
  const options = { strict: false, repos: {} };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--strict' && !options.strict) options.strict = true;
    else if (args[i] === '--config' && !options.configPath && typeof args[i + 1] === 'string' && path.isAbsolute(args[i + 1])) {
      options.configPath = args[++i];
    }
    else if (/^--(?:gemini|grok)-repo$/.test(args[i])) {
      const provider = args[i].slice(2, -5);
      if (options.repos[provider] || typeof args[i + 1] !== 'string' || !path.isAbsolute(args[i + 1])) throw new Error('PROVIDER_CHECK_ARGUMENT_INVALID');
      options.repos[provider] = args[++i];
    } else throw new Error('PROVIDER_CHECK_ARGUMENT_INVALID');
  }
  return options;
}

export async function loadProviderRepoConfig(filePath, { optional = false } = {}) {
  let data;
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024) throw new Error();
    data = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return {};
    throw new Error('PROVIDER_CONFIG_INVALID');
  }
  if (!data || data.schema !== 'web-api-ai-provider-repos-v1'
    || Object.keys(data).some(key => !['schema', 'repos'].includes(key))
    || !data.repos || typeof data.repos !== 'object' || Array.isArray(data.repos)
    || Object.entries(data.repos).some(([key, value]) => !PROVIDERS.includes(key)
      || typeof value !== 'string' || !path.isAbsolute(value))) throw new Error('PROVIDER_CONFIG_INVALID');
  return data.repos;
}

export function projectProviderReport(provider, report, childExitCode) {
  if (![0, 2].includes(childExitCode) || !report || report.currentNetworkVerified !== false
    || !['stored_receipt_consistent', 'incomplete'].includes(report.status) || !Array.isArray(report.features)) throw new Error('PROVIDER_REPORT_INVALID');
  const summary = report.summary;
  let total, accepted;
  if (provider === 'gemini') {
    if (report.schema !== 'gemini-feature-audit-result-v1' || report.service !== 'gemini-web'
      || report.executionMode !== 'offline_filesystem_only' || report.networkRequests !== 0
      || report.providerInvocations !== 0 || report.browserProcessesCreated !== 0
      || !summary || !count(summary.total) || !count(summary.accepted) || !count(summary.unresolved)
      || summary.unresolved !== summary.total - summary.accepted || summary.strictPass !== (summary.unresolved === 0)) throw new Error('PROVIDER_REPORT_INVALID');
    total = summary.total; accepted = summary.accepted;
  } else if (provider === 'grok') {
    if (report.schemaVersion !== 1 || report.serviceId !== 'grok-web' || report.mode !== 'strict'
      || typeof report.ioPolicy !== 'string' || !report.ioPolicy.startsWith('offline;')
      || !summary || !count(summary.requiredFeatures) || !count(summary.completeRequiredFeatures)
      || !count(summary.requiredOperations) || !count(summary.completeRequiredOperations)
      || !count(summary.missingRequiredFeatures)
      || summary.missingRequiredFeatures !== summary.requiredFeatures - summary.completeRequiredFeatures
      || summary.completeRequiredOperations > summary.requiredOperations) throw new Error('PROVIDER_REPORT_INVALID');
    total = summary.requiredFeatures; accepted = summary.completeRequiredFeatures;
  } else throw new Error('PROVIDER_REPORT_INVALID');
  if (total === 0 || accepted > total || childExitCode !== (accepted === total ? 0 : 2)
    || report.status !== (accepted === total ? 'stored_receipt_consistent' : 'incomplete')) throw new Error('PROVIDER_REPORT_INVALID');
  const features = report.features.map(feature => {
    const id = feature.id ?? feature.featureId;
    if (!identifier(id) || !identifier(feature.status)) throw new Error('PROVIDER_REPORT_INVALID');
    return { id, status: feature.status };
  });
  if (new Set(features.map(feature => feature.id)).size !== features.length
    || (provider === 'gemini' && features.length !== total)) throw new Error('PROVIDER_REPORT_INVALID');
  if (provider === 'gemini') {
    const acceptedRows = features.filter(feature => ['stored_receipt_consistent', 'not_applicable'].includes(feature.status)).length;
    if (acceptedRows !== accepted) throw new Error('PROVIDER_REPORT_INVALID');
  } else {
    const requiredRows = report.features.filter(feature => feature.required === true);
    if (requiredRows.length !== total
      || requiredRows.filter(feature => feature.status === 'stored_receipt_consistent').length !== accepted) {
      throw new Error('PROVIDER_REPORT_INVALID');
    }
  }
  return { provider, status: 'stored_receipt_consistency', sourceStatus: report.status, strictPass: accepted === total,
    accepted, required: total, unresolved: total - accepted, features };
}

export async function auditProvider(provider, repoPath) {
  if (!repoPath) return { provider, status: 'not_installed', strictPass: false };
  let root, checker;
  try {
    root = await realpath(repoPath);
    checker = path.join(root, 'scripts', 'check-features.mjs');
    const info = await lstat(checker);
    if (!info.isFile() || info.isSymbolicLink() || !(await realpath(checker)).startsWith(root + path.sep)) throw new Error();
  } catch { return { provider, status: 'not_installed', strictPass: false }; }
  const env = Object.fromEntries(ENV_NAMES.filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key]]));
  return new Promise(resolve => {
    let finished = false, bytes = 0, output = '', failure;
    const child = spawn(process.execPath, [checker, '--json', '--strict'], { cwd: root, env, stdio: ['ignore', 'pipe', 'ignore'] });
    const finish = result => { if (!finished) { finished = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => { failure = 'PROVIDER_CHECK_TIMEOUT'; child.kill(); }, 30_000);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) { failure = 'PROVIDER_REPORT_TOO_LARGE'; child.kill(); }
      else output += chunk.toString('utf8');
    });
    child.on('error', () => finish({ provider, status: 'checker_error', strictPass: false, error: 'PROVIDER_CHECK_FAILED' }));
    child.on('close', code => {
      if (failure) return finish({ provider, status: 'checker_error', strictPass: false, error: failure });
      try { finish(projectProviderReport(provider, JSON.parse(output), code)); }
      catch { finish({ provider, status: 'checker_error', strictPass: false, error: 'PROVIDER_REPORT_INVALID' }); }
      output = '';
    });
  });
}

export async function checkProviders(options) {
  const providers = await Promise.all(PROVIDERS.map(provider => auditProvider(provider, options.repos[provider])));
  const report = { schema: 'web-api-ai-provider-check-v1', checkedAt: new Date().toISOString(),
    evidenceScope: 'stored_receipt_consistency', currentNetworkVerified: false,
    strictPass: providers.every(provider => provider.strictPass), providers };
  const exitCode = providers.some(provider => provider.status === 'checker_error') ? 1 : options.strict && !report.strictPass ? 2 : 0;
  return { report, exitCode };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseProviderOptions(process.argv.slice(2));
    const configured = await loadProviderRepoConfig(options.configPath ?? LOCAL_CONFIG_PATH, { optional: !options.configPath });
    options.repos = { ...BUNDLED_PROVIDER_REPOS, ...configured, ...options.repos };
    const { report, exitCode } = await checkProviders(options);
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exitCode = exitCode;
  } catch (error) {
    const code = ['PROVIDER_CHECK_ARGUMENT_INVALID', 'PROVIDER_CONFIG_INVALID'].includes(error?.message)
      ? error.message : 'PROVIDER_CHECK_FAILED';
    process.stdout.write(JSON.stringify({ schema: 'web-api-ai-provider-check-error-v1', error: code }) + '\n');
    process.exitCode = 1;
  }
}
