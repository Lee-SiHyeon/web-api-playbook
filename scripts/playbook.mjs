import { readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { options, jsonFile, safeError, stdinJsonNoEcho } from '../lib/cli.mjs';
import { createOperationRegistry } from '../lib/operation-registry.mjs';
import { serveOperationMcp } from '../lib/operation-mcp.mjs';
import { checkOperations } from '../lib/operation-health.mjs';
import { runOperationFlow, collectOperationPages } from '../lib/operation-flow.mjs';
import { createServiceRegistry, listServiceOperations } from '../lib/service-operations/index.mjs';
import { verifyServiceOperations } from '../lib/service-operations/verify.mjs';

const usage = {
  commands: ['list', 'describe', 'tools', 'run', 'check', 'flow', 'collect', 'mcp', 'verify'],
  examples: [
    'node scripts/playbook.mjs list --all',
    'node scripts/playbook.mjs describe --service=oliveyoung-public',
    'node scripts/playbook.mjs verify --all --output=work/service-verification.json',
    'node scripts/playbook.mjs describe --profile=work/profile-v2.json',
    'node scripts/playbook.mjs run --profile=work/profile-v2.json --operation=search --input=work/input.json',
    'node scripts/playbook.mjs check --profile=work/profile-v2.json',
    'node scripts/playbook.mjs collect --profile=work/profile-v2.json --plan=work/collection.json --checkpoint=work/checkpoint.json',
    'node scripts/playbook.mjs mcp --profile=work/profile-v2.json',
  ],
};
function fail(code) { const error = new Error(code); error.code = code; throw error; }
async function saveCheckpoint(file, value) {
  if (!file) return;
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 }); await rename(temporary, file); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}
async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '--help' || command === 'help') { console.log(JSON.stringify(usage, null, 2)); return; }
  if (!usage.commands.includes(command)) fail('COMMAND_INVALID');
  const args = options(rest, ['profile', 'service', 'operation', 'input', 'plan', 'checkpoint', 'output', 'all',
    'include-unconnected', 'timeout', 'credentials-stdin', 'session', 'store-dir', 'progress']);
  const booleanFlags = new Set(['all', 'include-unconnected', 'credentials-stdin', 'progress']);
  for (const [key, value] of Object.entries(args)) {
    if (booleanFlags.has(key) ? value !== true : typeof value !== 'string' || !value) fail('ARGUMENT_INVALID');
  }
  const allowed = {
    list: ['all', 'output'], describe: ['profile', 'service', 'operation', 'output'], tools: ['profile', 'service', 'output'],
    run: ['profile', 'service', 'operation', 'input', 'output', 'timeout', 'session', 'store-dir', 'credentials-stdin'],
    check: ['profile', 'service', 'plan', 'output', 'timeout', 'session', 'store-dir', 'credentials-stdin'],
    flow: ['profile', 'service', 'plan', 'checkpoint', 'output', 'timeout', 'session', 'store-dir', 'credentials-stdin'],
    collect: ['profile', 'service', 'plan', 'checkpoint', 'output', 'timeout', 'session', 'store-dir', 'credentials-stdin'],
    mcp: ['profile', 'service', 'session', 'store-dir'],
    verify: ['service', 'all', 'timeout', 'include-unconnected', 'output', 'session', 'store-dir', 'credentials-stdin', 'progress'],
  };
  if (Object.keys(args).some(key => !allowed[command].includes(key))) fail('ARGUMENT_INVALID');
  if (args.profile && args.service || command === 'verify' && (args.all === true) === Boolean(args.service)) fail('ARGUMENT_INVALID');
  if (!['list', 'verify'].includes(command) && !args.profile && !args.service) fail('PROFILE_REQUIRED');
  if (!args.service && ['session', 'store-dir', 'credentials-stdin'].some(key => args[key] !== undefined) && !(command === 'verify' && args.all && !args['credentials-stdin'])) fail('SERVICE_REQUIRED');
  const timeoutMs = args.timeout === undefined ? 30000 : /^[1-9]\d*$/.test(args.timeout) ? Number(args.timeout) : NaN;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs > 300000) fail('SERVICE_TIMEOUT_INVALID');
  let credentialProvider;
  if (args['credentials-stdin']) {
    const supplied = await stdinJsonNoEcho(128 * 1024, { prompt: 'Service credentials JSON: ' });
    if (supplied?.service !== args.service || !supplied.credentials || typeof supplied.credentials !== 'object' || Array.isArray(supplied.credentials)) fail('CREDENTIAL_SERVICE_MISMATCH');
    // This provider is bound only to the single explicitly selected registry;
    // its internal provider ID can differ from a CLI alias.
    credentialProvider = async () => supplied.credentials;
  }
  const bindingOptions = { credentialProvider, sessionName: args.session, storeDirectory: args['store-dir'] };
  let registry;
  try {
  if (command !== 'list' && command !== 'verify') registry = args.service
    ? await createServiceRegistry(args.service, { ...bindingOptions, bind: !['describe', 'tools'].includes(command) })
    : createOperationRegistry(await jsonFile(args.profile));
  if (command === 'mcp') {
    await serveOperationMcp(registry); return;
  }
  let checkpoint;
  if (args.checkpoint) {
    try { checkpoint = JSON.parse(await readFile(args.checkpoint, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') fail('CHECKPOINT_INVALID'); }
  }
  const execute = (name, input, context) => {
    // Generic flows/checkpoints cannot reconstruct uncertain writes. Existing service
    // writers stay on their journal/readback runner and can be bound via the library.
    if (registry.profile.operations[name]?.semantics !== 'read') fail('READ_OPERATION_REQUIRED');
    return registry.execute(name, input, context);
  };
  let result;
  const signal = AbortSignal.timeout(timeoutMs);
  if (command === 'list') result = await listServiceOperations({ includeUnconnected: args.all === true });
  if (command === 'verify') {
    result = await verifyServiceOperations({ ...bindingOptions, timeoutMs, ...(args.service ? { services: [args.service] } : {}),
      includeUnconnected: args['include-unconnected'] === true,
      ...(args.progress ? { onResult: value => process.stderr.write(`${JSON.stringify({ serviceId: value.serviceId,
        verdict: value.verdict, checks: value.checks.map(check => ({ operation: check.operation, outcome: check.outcome,
          ...(check.code ? { code: check.code } : {}), ...(check.liveReadVerified !== undefined ? { liveReadVerified: check.liveReadVerified } : {}) })) })}\n`) } : {}) });
    if (result.summary.notFullyVerified > 0) process.exitCode = 1;
  }
  if (command === 'describe') result = args.operation ? registry.describe(args.operation) : { serviceId: registry.profile.serviceId, operations: registry.list() };
  if (command === 'tools') result = { tools: registry.tools() };
  if (command === 'run') {
    if (!args.operation) fail('OPERATION_REQUIRED');
    result = await registry.execute(args.operation, args.input ? await jsonFile(args.input) : {}, { signal });
  }
  if (command === 'check') {
    const checks = args.plan ? await jsonFile(args.plan) : undefined;
    result = await checkOperations(registry.profile, { execute, signal,
      ...(checks ? { checks } : args.service ? { checks: registry.verificationChecks } : {}) });
    if (result.verdict !== 'ok') process.exitCode = 1;
  }
  if (command === 'flow' || command === 'collect') {
    if (!args.plan) fail('PLAN_REQUIRED');
    const plan = await jsonFile(args.plan);
    const context = { execute, checkpoint, signal, onCheckpoint: value => saveCheckpoint(args.checkpoint, value) };
    result = command === 'flow' ? await runOperationFlow(plan, context) : await collectOperationPages(plan, context);
    if (result.partial === true || result.ok === false || result.complete === false) process.exitCode = 1;
  }
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (args.output) await writeFile(args.output, text, { flag: 'wx', mode: 0o600 });
  process.stdout.write(text);
  } finally { await registry?.close?.(); }
}
main().catch(error => { console.error(JSON.stringify({ ok: false, code: safeError(error) })); process.exitCode = 1; });
