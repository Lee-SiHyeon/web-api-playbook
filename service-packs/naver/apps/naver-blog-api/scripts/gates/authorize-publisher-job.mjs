import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fingerprint } from '../../../../packages/contracts/src/index.mjs';
import {
  evaluatePublisherJobGate,
  evaluatePublisherResultGate,
  publisherContentFingerprint,
} from './publisher-gates.mjs';
import { evaluateCommercialSnapshot } from './commercial-snapshot-gates.mjs';
import { readJsonFile } from './json-io.mjs';

function parseArgs(args) {
  const out = {};
  for (const arg of args) {
    const [key, ...rest] = arg.replace(/^--/, '').split('=');
    out[key] = rest.join('=');
  }
  for (const field of ['dry-run-job', 'dry-run-result', 'dry-run-gate', 'commercial-snapshot', 'output']) {
    if (!out[field]) throw new Error(`--${field}=... is required`);
  }
  if (out['approved-by'] !== 'user') throw new Error('--approved-by=user is required');
  return out;
}

const options = parseArgs(process.argv.slice(2));
const paths = Object.fromEntries(
  Object.entries(options)
    .filter(([key]) => ['dry-run-job', 'dry-run-result', 'dry-run-gate', 'commercial-snapshot', 'output'].includes(key))
    .map(([key, value]) => [key, path.resolve(value)]),
);
const [dryJob, dryResult, storedGate, commercialSnapshot] = await Promise.all([
  readJsonFile(paths['dry-run-job']),
  readJsonFile(paths['dry-run-result']),
  readJsonFile(paths['dry-run-gate']),
  readJsonFile(paths['commercial-snapshot']),
]);

if (!(dryJob.dryRun === true || dryJob.publish === false)) throw new Error('source job is not a dry-run');
const jobGate = await evaluatePublisherJobGate(dryJob, { baseDir: path.dirname(paths['dry-run-job']) });
if (!jobGate.passed) throw new Error(`dry-run job gate failed: ${jobGate.failedChecks.join(',')}`);
const resultGate = evaluatePublisherResultGate(dryJob, dryResult);
if (!resultGate.passed) throw new Error(`dry-run result gate failed: ${resultGate.failedChecks.join(',')}`);
if (storedGate.passed !== true || storedGate.inputFingerprint !== resultGate.inputFingerprint) {
  throw new Error('stored dry-run gate is missing or stale');
}
const commercialGate = evaluateCommercialSnapshot(commercialSnapshot, { now: new Date(), maxAgeMinutes: 60 });
if (!commercialGate.passed) throw new Error(`commercial snapshot gate failed: ${commercialGate.failedChecks.join(',')}`);

const approvedAt = new Date().toISOString();
const publishJob = {
  ...dryJob,
  jobId: options['job-id'] || `${dryJob.jobId}-publish-${Date.now()}`,
  dryRun: false,
  publish: true,
  publishSettings: {
    visibility: options.visibility || 'public',
    timing: options.timing || 'current',
  },
  commercialSnapshot,
  preflight: {
    passed: true,
    dryRunJobId: dryJob.jobId,
    dryRunJobFingerprint: fingerprint(dryJob),
    dryRunResultFingerprint: fingerprint(dryResult),
    dryRunGateFingerprint: fingerprint(storedGate),
  },
  authorization: {
    approved: true,
    approvedBy: 'user',
    approvedAt,
    scope: 'publish_once',
  },
};
publishJob.authorization.contentFingerprint = publisherContentFingerprint(publishJob);
const finalGate = await evaluatePublisherJobGate(publishJob, {
  baseDir: path.dirname(paths.output),
  now: new Date(approvedAt),
});
if (!finalGate.passed) throw new Error(`authorized publish job failed gate: ${finalGate.failedChecks.join(',')}`);
await writeFile(paths.output, JSON.stringify(publishJob, null, 2) + '\n', { flag: 'wx' });
await writeFile(paths.output.replace(/\.json$/i, '.gate.json'), JSON.stringify(finalGate, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({
  completed: true,
  output: paths.output,
  jobId: publishJob.jobId,
  approvedAt,
  contentFingerprint: publishJob.authorization.contentFingerprint,
  commercialGateFingerprint: fingerprint(commercialGate),
}));
