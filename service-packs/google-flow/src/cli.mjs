import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { FlowClient } from './client.mjs';
import { FlowHttpTransport } from './http-transport.mjs';
import { createNodeRecaptchaProvider } from './node-recaptcha-issuer.mjs';
import { isFlowErrorCandidateReason } from './protocol.mjs';
import { renewFlowGoogleCookies } from './cookie-rotation.mjs';
import { formatSafeFlowDocumentDiagnostics } from './document-diagnostics.mjs';
import { recoverFlowGoogleSession } from './google-sso-recovery.mjs';
import { formatSafeFlowRecoveryContext, startFlowWithRecovery } from './start-with-recovery.mjs';
import { syncFromProfile } from './profile-sync.mjs';
import { observeProfile } from './profile-observe.mjs';
import { generateWithGflow } from './gflow-adapter.mjs';

function parseArgs(argv) {
  const [command, ...args] = argv;
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (key === '--confirm-generation') {
      options['confirm-generation'] = true;
      continue;
    }
    if (key === '--probe-missing-input') {
      options['probe-missing-input'] = true;
      continue;
    }
    if (!key.startsWith('--')) throw new Error('Unexpected argument: ' + key);
    const name = key.slice(2);
    if (!['prompt', 'prompt-file', 'out', 'aspect', 'duration', 'resolution', 'project-id', 'job', 'media-id',
      'backend', 'start-frame', 'end-frame', 'character', 'extend', 'profile-dir', 'seconds', 'audio', 'dialogue'].includes(name)) {
      throw new Error('Unknown option: --' + name);
    }
    const value = args[i + 1];
    if (!value || value.startsWith('--')) throw new Error('Missing value for --' + name);
    if (name === 'character') options[name] = [...(options[name] ?? []), value];
    else options[name] = value;
    i += 1;
  }
  return { command, options };
}

function usage() {
  console.log([
    'Google Flow project media via direct HTTP (no Chrome extension)',
    '  node src/cli.mjs generate --prompt-file PROMPT.txt --out ./.runtime/generated.mp4 --confirm-generation',
    '  node src/cli.mjs generate --prompt-file PROMPT.txt --out ./.runtime/probe.mp4 --probe-missing-input --confirm-generation',
    '  node src/cli.mjs download --media-id EXISTING_MEDIA_ID --out ./.runtime/existing.mp4',
    '  node src/cli.mjs generation-state --media-id EXISTING_MEDIA_ID',
    '  node src/cli.mjs list',
    '  node src/cli.mjs reconcile --job ./.runtime/jobs/YOUR_JOB_ID.json',
    '  node src/cli.mjs status',
    '  node src/cli.mjs renew-session',
    '  node src/cli.mjs recover-session',
    '  node src/cli.mjs sync-from-profile [--profile-dir DEDICATED_PROFILE]',
    '  node src/cli.mjs observe-profile --seconds 60 [--profile-dir DEDICATED_PROFILE]',
    '  node src/cli.mjs generate --backend gflow --start-frame IMAGE.jpg --aspect 9:16 --duration 8 --prompt "Slow camera push in." --out VIDEO.mp4 --confirm-generation',
    '  node src/cli.mjs generate --backend gflow --character NAME --prompt TEXT --out VIDEO.mp4 --confirm-generation',
    '  node src/cli.mjs generate --backend gflow --extend EXISTING_MEDIA_ID --prompt TEXT --out VIDEO.mp4 --confirm-generation',
    'Frames, characters, and extend use the reviewed gflow UI backend until their HTTP contracts are captured.',
    'sync-from-profile verifies the owner and protected HTTP read before updating DPAPI; Chrome owns any native DBSC refresh.',
    'Bootstrap a scoped Flow session into Windows DPAPI once before these direct HTTP commands.',
    'renew-session performs only the observed accounts.google.com RotateCookiesPage GET, then verifies the Flow project read.',
    'Cookie rotation is an explicit normal session operation; it is not proof that an expired session was recovered.',
    'recover-session restores Flow host authentication using the protected Google first-party session and fresh observed redirects.',
    'Expired Google account authentication itself requires normal first-party reauthentication.',
    'generate uses the current Flow document public key and the unmodified first-party SDK in a bounded Node/jsdom worker.',
    'Flow create, polling, and download remain direct HTTP; the issuer does not use a browser engine or send Flow create requests.',
    '--probe-missing-input explicitly sends one active-project 8s/720p/16:9 request with that optional field absent; no retry is automatic.',
  ].join('\n'));
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === 'help' || command === '--help') return usage();
  if (!['generate', 'download', 'generation-state', 'list', 'status', 'reconcile', 'renew-session', 'recover-session', 'sync-from-profile', 'observe-profile'].includes(command)) {
    throw new Error('Command must be generate, download, generation-state, list, reconcile, status, renew-session, or recover-session.');
  }
  if (['renew-session', 'recover-session'].includes(command) && Object.keys(options).length > 0) {
    throw new Error(`${command} does not accept options.`);
  }
  if (command === 'generate' && !options['confirm-generation']) throw new Error('GENERATION_CONFIRMATION_REQUIRED: pass --confirm-generation for one pure HTTP Flow create.');
  if (options['probe-missing-input'] && command !== 'generate') throw new Error('--probe-missing-input is available only with generate.');
  if (command === 'generate' && !options.out) throw new Error('Provide --out for generate.');
  if (command === 'reconcile' && !options.job) throw new Error('Provide --job for reconcile.');
  if (command === 'download' && (!options['media-id'] || !options.out)) {
    throw new Error('Provide --media-id and --out for download.');
  }
  if (command === 'generation-state' && !options['media-id']) {
    throw new Error('Provide --media-id for generation-state.');
  }
  if (command === 'sync-from-profile') {
    if (Object.keys(options).some(key => key !== 'profile-dir')) throw new Error('sync-from-profile accepts only --profile-dir.');
    console.log(JSON.stringify(await syncFromProfile({ profileDir: options['profile-dir'] })));
    return;
  }
  if (command === 'observe-profile') {
    if (Object.keys(options).some(key => !['profile-dir', 'seconds'].includes(key))) throw new Error('observe-profile accepts --profile-dir and --seconds.');
    console.log(JSON.stringify(await observeProfile({ profileDir: options['profile-dir'], seconds: Number(options.seconds ?? 60) })));
    return;
  }
  if (options.backend !== undefined && !['http','gflow'].includes(options.backend)) throw new Error('Backend must be http or gflow.');
  const gflowMode = command === 'generate' && options.backend === 'gflow';
  if (gflowMode && options['probe-missing-input']) throw new Error('The missing-input diagnostic is unavailable with the gflow backend.');
  if (command === 'generate' && !gflowMode && ['start-frame','end-frame','character','extend','audio','dialogue'].some(key => options[key] !== undefined)) {
    throw Object.assign(new Error('FLOW_GENERATION_CONTRACT_UNVERIFIED: use --backend gflow for frames, characters, or one extension.'), { code: 'FLOW_GENERATION_CONTRACT_UNVERIFIED' });
  }

  if (command === 'recover-session') {
    console.log(JSON.stringify({ stage: 'flow_session_recovery', ...await recoverFlowGoogleSession() }));
    return;
  }

  const start = client => startFlowWithRecovery(client, {
    onRecovery: receipt => console.log(JSON.stringify({ stage: 'flow_session_recovery', ...receipt })),
    syncImpl: () => syncFromProfile({ profileDir: options['profile-dir'] }),
  });

  if (command === 'renew-session') {
    const rotation = await renewFlowGoogleCookies();
    console.log(JSON.stringify({ stage: 'cookie_rotation', ...rotation }));
    const client = new FlowClient();
    try {
      await start(client);
      const context = await client.getContext();
      const listing = await client.getProjectMedia(context.projectId);
      console.log(JSON.stringify({ stage: 'flow_readback', mode: 'pure_http', session: 'authenticated',
        projectId: context.projectId, documentCheckedAt: context.documentCheckedAt,
        projectMediaCount: Array.isArray(listing?.[1]) ? listing[1].length : null }));
      return;
    } finally {
      client.close();
    }
  }

  const transport = new FlowHttpTransport();
  const generationInputProvider = command === 'generate' && !gflowMode
    ? createNodeRecaptchaProvider({ transport }) : undefined;
  const client = new FlowClient({ transport, generationInputProvider });
  try {
    await start(client);
    if (command === 'generate') {
      const prompt = options['prompt-file']
        ? await readFile(path.resolve(options['prompt-file']), 'utf8')
        : options.prompt;
      if (!prompt?.trim()) throw new Error('Provide --prompt or --prompt-file for generate.');
      const activeContext = await client.getContext();
      const targetProjectId = options['project-id'] ?? activeContext.projectId;
      if (gflowMode) {
        console.log(JSON.stringify(await generateWithGflow(client, {
          prompt, outputPath: path.resolve(options.out), projectId: targetProjectId,
          confirmGeneration: options['confirm-generation'], aspect: options.aspect, duration: options.duration,
          resolution: options.resolution, startFrame: options['start-frame'], endFrame: options['end-frame'],
          character: options.character, extend: options.extend, profileDir: options['profile-dir'],
          audio: options.audio, dialogue: options.dialogue,
        })));
        return;
      }
      const baseline = await client.getProjectMedia(targetProjectId);
      const baselineProjectMediaCount = Array.isArray(baseline?.[1]) ? baseline[1].length : null;
      let result;
      try {
        result = await client.generateVideo({
          prompt,
          outputPath: path.resolve(options.out),
          projectId: targetProjectId,
          aspect: options.aspect ?? '16:9',
          duration: options.duration ?? 8,
          resolution: options.resolution ?? '720p',
          probeMissingInput: options['probe-missing-input'] === true,
        });
      } catch (error) {
        const issuerReceipt = generationInputProvider?.getLastReceipt();
        if (issuerReceipt) console.error(JSON.stringify({ stage: 'recaptcha_issuer', status: 'failed', issuerReceipt }));
        throw error;
      }
      const issuerReceipt = generationInputProvider?.getLastReceipt();
      console.log(JSON.stringify({ status: result.status, mediaId: result.mediaId, outputPath: result.outputPath,
        bytes: result.bytes, jobPath: result.jobPath, mode: 'pure_http', inputMode: result.inputMode,
        baselineProjectMediaCount, issuerReceipt }));
      return;
    }
    if (command === 'status') {
      const context = await client.getContext();
      const listing = await client.getProjectMedia(context.projectId);
      console.log(JSON.stringify({ mode: 'pure_http', session: 'authenticated',
        projectId: context.projectId, documentCheckedAt: context.documentCheckedAt,
        projectMediaCount: Array.isArray(listing?.[1]) ? listing[1].length : null }));
      return;
    }
    if (command === 'list') {
      const mediaIds = await client.listMediaIds();
      console.log(JSON.stringify({ count: mediaIds.length, mediaIds }));
      return;
    }
    if (command === 'generation-state') {
      const result = await client.getGenerationState(options['media-id']);
      console.log(JSON.stringify({ mode: 'pure_http', ...result }));
      return;
    }
    if (command === 'reconcile') {
      const result = await client.reconcileJob(path.resolve(options.job));
      console.log(JSON.stringify({ status: 'downloaded', outputPath: result.outputPath, bytes: result.bytes, jobPath: result.jobPath }));
      return;
    }
    if (command === 'download') {
      const result = await client.downloadExistingVideo(options['media-id'], path.resolve(options.out));
      console.log(JSON.stringify({ status: 'downloaded', outputPath: result.outputPath, bytes: result.bytes, jobPath: result.jobPath }));
      return;
    }
  } finally {
    client.close();
  }
}

main().catch((error) => {
  const message = error?.message || 'Flow operation failed.';
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : null;
  const rpcStatus = Number.isInteger(error?.rpcStatus) && error.rpcStatus >= 0 && error.rpcStatus <= 16 ? error.rpcStatus : null;
  const hasRecoveryContext = error && typeof error === 'object'
    && (Object.hasOwn(error, 'recoveryDiagnostics') || Object.hasOwn(error, 'startupFailure'));
  const safeMessage = hasRecoveryContext
    ? (code ?? 'Flow session recovery failed.')
    : message.replace(/[\r\n]+/g, ' ').slice(0, 240);
  const documentDiagnostics = formatSafeFlowDocumentDiagnostics(error);
  const recoveryContext = formatSafeFlowRecoveryContext(error);
  const frameDiagnostics = [
    typeof error?.jobPath === 'string' && !/[\r\n\0]/.test(error.jobPath) ? `jobPath=${error.jobPath}` : null,
    typeof error?.flowStored === 'boolean' ? `flowStored=${error.flowStored}` : null,
    typeof error?.googleAuthStored === 'boolean' ? `googleAuthStored=${error.googleAuthStored}` : null,
    ['FLOW_SSO_RECOVERY_CREDENTIAL_STORE_WRITE_TIMEOUT',
      'FLOW_SSO_RECOVERY_CREDENTIAL_STORE_WRITE_FAILED',
      'FLOW_SSO_RECOVERY_CREDENTIAL_STORE_UNVERIFIED'].includes(error?.storeFailureCode)
      ? `storeFailureCode=${error.storeFailureCode}` : null,
    typeof error?.errorMessagePresent === 'boolean' ? `errorMessagePresent=${error.errorMessagePresent}` : null,
    typeof error?.errorInfoPresent === 'boolean' ? `errorInfoPresent=${error.errorInfoPresent}` : null,
    Number.isInteger(error?.errorInfoCount) && error.errorInfoCount >= 0 && error.errorInfoCount <= 1_000_000
      ? `errorInfoCount=${error.errorInfoCount}` : null,
    typeof error?.errorDomainPresent === 'boolean' ? `errorDomainPresent=${error.errorDomainPresent}` : null,
    typeof error?.errorMetadataPresent === 'boolean' ? `errorMetadataPresent=${error.errorMetadataPresent}` : null,
    Number.isInteger(error?.errorMetadataCount) && error.errorMetadataCount >= 0 && error.errorMetadataCount <= 1_000_000
      ? `errorMetadataCount=${error.errorMetadataCount}` : null,
    typeof error?.errorReasonConflict === 'boolean' ? `errorReasonConflict=${error.errorReasonConflict}` : null,
    typeof error?.errorInfoSchemaVerified === 'boolean'
      ? `errorInfoSchemaVerified=${error.errorInfoSchemaVerified}` : null,
    isFlowErrorCandidateReason(error?.errorCandidateReason)
      ? `errorCandidateReason=${error.errorCandidateReason}` : null,
  ];
  console.error([code ? `${code}:` : null, rpcStatus === null ? null : `rpcStatus=${rpcStatus}`,
    ...frameDiagnostics, documentDiagnostics, recoveryContext, safeMessage]
    .filter(Boolean).join(' '));
  process.exitCode = 1;
});
