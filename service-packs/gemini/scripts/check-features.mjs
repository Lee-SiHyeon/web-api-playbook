import { pathToFileURL } from 'node:url';
import { auditGeminiFeatures } from '../src/feature-checklist.mjs';
import { GeminiClientError } from '../src/errors.mjs';

export function parseFeatureAuditOptions(args) {
  const options = { strict: false, json: false };
  for (const value of args) {
    if (value === '--strict' && !options.strict) options.strict = true;
    else if (value === '--json' && !options.json) options.json = true;
    else throw new GeminiClientError('FEATURE_AUDIT_ARGUMENT_INVALID', 'Use only --strict and --json, once each.');
  }
  return options;
}

export function featureAuditExitCode(result, strict) {
  if (!result?.summary || typeof result.summary.strictPass !== 'boolean' || typeof strict !== 'boolean') {
    throw new GeminiClientError('FEATURE_AUDIT_RESULT_INVALID', 'The feature audit result is incomplete.');
  }
  return strict && !result.summary.strictPass ? 2 : 0;
}

function renderText(result) {
  const rows = result.features.flatMap((feature) => [
    `${feature.status.padEnd(26)} ${feature.id} — ${feature.title}`,
    ...feature.reasons.map((reason) => `  ${reason}`),
  ]);
  return [
    `Gemini feature audit (${result.executionMode}; network=${result.networkRequests}, provider=${result.providerInvocations}, browsers=${result.browserProcessesCreated})`,
    `Evidence: ${result.status}; ${result.evidenceFreshness}; last recorded ${result.lastRecordedEvidenceAt ?? 'none'}`,
    `Contract: ${result.contract.installed ? `installed ${result.contract.sha256}` : 'not captured'}`,
    ...rows,
    `Accepted ${result.summary.accepted}/${result.summary.total}; unresolved ${result.summary.unresolved}.`,
  ].join('\n');
}

async function main() {
  let options;
  try {
    options = parseFeatureAuditOptions(process.argv.slice(2));
    const result = await auditGeminiFeatures();
    process.stdout.write((options.json ? JSON.stringify(result, null, 2) : renderText(result)) + '\n');
    process.exitCode = featureAuditExitCode(result, options.strict);
  } catch (error) {
    const code = error instanceof GeminiClientError ? error.code : 'FEATURE_AUDIT_FAILED';
    if (options?.json) {
      process.stdout.write(JSON.stringify({ schema: 'gemini-feature-audit-error-v1', error: code }) + '\n');
    } else {
      process.stderr.write(code + '\n');
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
