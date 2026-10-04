import { access, readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const app = 'service-packs/affiliate/apps/affiliate-api-hub';
const guard = new URL('./coupang-offline-guard.mjs', import.meta.url).href;
const fail = code => { throw Object.assign(new Error(code), { code }); };

async function matchingFiles(directory, pattern) {
  return (await readdir(path.join(root, directory)))
    .filter(name => pattern.test(name)).sort().map(name => `${directory}/${name}`);
}

function run(args, timeout = 120_000) {
  const result = spawnSync(process.execPath, args, {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${guard}`.trim() },
  });
  return {
    passed: result.status === 0 && !result.error && !result.signal,
    exitCode: Number.isInteger(result.status) ? result.status : null,
    timedOut: result.error?.code === 'ETIMEDOUT', signal: result.signal ?? null,
    output: `${result.stdout || ''}\n${result.stderr || ''}`,
  };
}

export async function runCoupangRegression() {
  const startedAt = new Date().toISOString();
  const required = [
    'tests/coupang-attested-session.test.mjs', 'tests/scoped-cookie-evidence.test.mjs',
    ...[
      'adapters/coupang-consumer.mjs', 'adapters/coupang-consumer-offers.mjs',
      'adapters/coupang-wow-prices.mjs', 'adapters/coupang-partners-link.mjs',
      'lib/coupang-goldbox-public.mjs', 'lib/coupang-comparison-shipping.mjs',
      'scripts/coupang-consumer.mjs', 'scripts/verify-coupang-wow-price.mjs',
      'scripts/verify-coupang-public-prices.mjs', 'scripts/verify-coupang-goldbox.mjs',
      'scripts/coupang-flash-sale-inventory.mjs', 'scripts/coupang-read-diagnostic.mjs',
      'scripts/coupang-partners-check.mjs',
      'tests/coupang-consumer.test.mjs', 'tests/coupang-consumer-offers.test.mjs',
      'tests/coupang-wow-prices.test.mjs', 'tests/coupang-visitor-context.test.mjs',
      'tests/coupang-comparison-shipping.test.mjs', 'tests/coupang-partners-link.test.mjs',
      'tests/coupang-partners-owner-binding-persistence.test.mjs',
      'tests/coupang-goldbox-public.test.mjs', 'tests/coupang-goldbox-widget.test.mjs',
      'tests/coupang-flash-sale-inventory.test.mjs',
      'tests/coupang-read-diagnostic.test.mjs', 'tests/verify-coupang-public-prices.test.mjs',
      'tests/verify-coupang-wow-price.test.mjs', 'tests/verify-coupang-goldbox.test.mjs',
    ].map(file => `${app}/${file}`),
  ];
  for (const file of required) {
    try { await access(path.join(root, file)); }
    catch { fail('COUPANG_REGRESSION_PACK_INCOMPLETE'); }
  }
  const appTests = await matchingFiles(`${app}/tests`, /^(?:coupang-|verify-coupang-|shopping-session-).*\.test\.mjs$/);
  const coreTests = await matchingFiles('tests', /^(?:coupang-|scoped-cookie-evidence|brandconnect-renew|linkprice-auth).*\.test\.mjs$/);
  if (appTests.length < 10 || coreTests.length < 4) fail('COUPANG_REGRESSION_PACK_INCOMPLETE');
  const code = [
    'lib/protected-store.mjs', 'lib/scoped-session.mjs', 'lib/web-auth/coupang.mjs', 'lib/web-auth/coupang-attested-session.mjs',
    ...(await matchingFiles(`${app}/adapters`, /^coupang-.*\.mjs$/)),
    ...(await matchingFiles(`${app}/lib`, /^(?:coupang-|shopping-session-store|process-run-lock).*\.mjs$/)),
    ...(await matchingFiles(`${app}/scripts`, /^(?:coupang-consumer|coupang-partners-check|coupang-read-diagnostic|coupang-flash-sale-inventory|verify-coupang-.*)\.mjs$/)),
  ];
  const syntaxFailures = [];
  for (const file of code) if (!run(['--check', file], 30_000).passed) syntaxFailures.push(file);
  const tests = [...coreTests, ...appTests];
  const revisions = await Promise.all([...new Set([...code, ...tests, 'scripts/coupang-offline-guard.mjs',
    'scripts/coupang-regression.mjs'])].sort().map(async file => ({ path: file,
    sha256: createHash('sha256').update(await readFile(path.join(root, file))).digest('hex') })));
  const testResult = run(['--test', '--test-reporter=tap', ...tests]);
  const count = name => Number(new RegExp(`^# ${name} (\\d+)$`, 'm').exec(testResult.output)?.[1] ?? 0);
  const report = {
    schemaVersion: 1, operation: 'coupang_offline_regression', startedAt,
    completedAt: new Date().toISOString(),
    passed: syntaxFailures.length === 0 && testResult.passed && count('tests') > 0
      && count('pass') === count('tests') && count('fail') === 0 && count('skipped') === 0 && count('todo') === 0,
    scope: 'packaged_coupang_clients_and_shared_authentication_regressions',
    revisions,
    syntax: { checked: code.length, failed: syntaxFailures },
    tests: { files: tests.length, total: count('tests'), passed: count('pass'), failed: count('fail'),
      skipped: count('skipped'), exitCode: testResult.exitCode, timedOut: testResult.timedOut, signal: testResult.signal },
    evidence: { mode: 'offline_mocked_regression',
      isolation: 'in_process_guards_not_os_sandbox',
      defaultFetchBlocked: true, dpapiHelperExecFileSyncBlocked: true,
      realProviderIntentionallyUsed: false, browserUsed: false, liveReplayVerified: false },
    states: { captured: 'historical_contracts_only', client_exists: true,
      credential_propagated: 'not_checked', remnant_free: 'not_checked', live_replay: false },
  };
  return report;
}

export async function main(args = process.argv.slice(2)) {
  if (args.length > 1 || args.length === 1 && args[0] !== '--write') fail('COUPANG_REGRESSION_ARGUMENTS_INVALID');
  const report = await runCoupangRegression();
  if (args[0] === '--write') {
    const directory = path.join(root, 'work', 'coupang-regression', `${Date.now()}-${process.pid}`);
    await mkdir(directory, { recursive: true });
    const target = path.join(directory, 'receipt.json');
    await writeFile(target, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    report.receiptPath = target;
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => {
    console.error(JSON.stringify({ passed: false,
      code: /^COUPANG_REGRESSION_[A-Z_]+$/.test(error?.code || '') ? error.code : 'COUPANG_REGRESSION_FAILED' }));
    process.exitCode = 1;
  });
