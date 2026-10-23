import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FlowClient } from './client.mjs';
import { FlowHttpTransport } from './http-transport.mjs';
import { createDownloadJournal } from './journal.mjs';
import { buildGetMediaRequest, findSignedVideoUrl, RPC } from './protocol.mjs';
import { createDocumentProvenanceAudit } from './document-provenance.mjs';

const FLOW_MEDIA_ID = /^[A-Fa-f0-9-]{16,64}$/;

/** Select the first completed video in the project listing's newest-first order. */
export function selectLatestCompletedVideo(records) {
  if (!Array.isArray(records)) return null;
  return records.find(record => typeof record?.[0] === 'string'
    && FLOW_MEDIA_ID.test(record[0])
    && record?.[5]?.[8]?.[0] === 3
    && Number.isInteger(record?.[5]?.[13]) && record[5][13] > 0) ?? null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  const key = args[i];
  if (!['--receipt', '--download', '--reconcile'].includes(key) || !args[i + 1]) {
    throw new Error('Use --receipt FILE, --download NEW_MP4_PATH, or --reconcile JOB_PATH.');
  }
  options[key.slice(2)] = args[i + 1];
}
if (options.download && options.reconcile) throw new Error('Choose download or reconcile.');
const receipt = {
  version: 1, startedAt: new Date().toISOString(), mode: 'pure_http',
  browserUsedForRecurringReads: false, credentialProvider: 'Windows DPAPI CurrentUser',
  generationRequests: 0, externalMutations: 0, requests: [], checks: {},
};
const provenance = createDocumentProvenanceAudit();
async function readDocumentForAudit(response) {
  const limit = 5 * 1024 * 1024;
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > limit) throw Object.assign(new Error('Flow document audit exceeded its size limit.'), {
      code: 'FLOW_DOCUMENT_AUDIT_SIZE_LIMIT',
    });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
const observeFetch = async (input, init = {}) => {
  const url = new URL(input);
  const rpcId = url.searchParams.get('rpcids');
  if (rpcId === RPC.generateTextVideo) throw new Error('VERIFIER_GENERATION_DENIED');
  const record = {
    method: init.method ?? 'GET', origin: url.origin,
    operation: url.hostname === 'flow-content.google' ? 'download_existing_video'
      : rpcId ?? 'project_document',
    credentialPresent: new Headers(init.headers).has('cookie'),
  };
  if (rpcId) record.documentProvenance = provenance.inspectRpc(url, init.body);
  receipt.requests.push(record);
  const response = await fetch(input, init);
  record.httpStatus = response.status;
  record.mime = response.headers.get('content-type')?.split(';', 1)[0] ?? null;
  if (!rpcId && url.origin === 'https://flow.google.com' && response.status === 200 && record.mime === 'text/html') {
    provenance.observeDocument(url, await readDocumentForAudit(response.clone()));
  }
  return response;
};
const client = new FlowClient({
  transport: new FlowHttpTransport({ fetchImpl: observeFetch }), fetchImpl: observeFetch,
});
try {
  await client.start();
  const context = await client.getContext();
  const listing = await client.getProjectMedia(context.projectId);
  receipt.checks.authenticatedProjectRead = true;
  receipt.checks.sceneCount = listing[1].length;
  receipt.checks.mediaCount = listing[2].length;
  receipt.checks.completedVideoAvailable = false;
  receipt.checks.downloadVerification = 'unavailable_no_completed_video';
  if (options.reconcile) {
    const result = await client.reconcileJob(options.reconcile);
    receipt.checks.reconciled = true;
    receipt.checks.completedVideoAvailable = true;
    receipt.checks.downloadVerification = 'downloaded_and_verified';
    receipt.checks.mp4SignatureVerified = true;
    receipt.checks.downloadedBytes = result.bytes;
  } else {
    const video = selectLatestCompletedVideo(listing[2]);
    if (video) {
      receipt.checks.completedVideoAvailable = true;
      receipt.checks.downloadVerification = 'candidate_completed_video';
      const mediaId = video[0];
      // The initial authenticated project listing already proves this media is in scope.
      // Read its state directly to avoid another Zzl0ze project-list request.
      const state = await client.readGenerationState(mediaId);
      receipt.checks.generationState = {
        observedStateCode: state.observedStateCode, videoBytes: state.videoBytes,
        creditBalance: state.creditBalance,
      };
      if (state.observedStateCode === 3 && Number.isInteger(state.videoBytes) && state.videoBytes > 0) {
        if (options.download) {
          const outputPath = await client.prepareOutputPath(options.download);
          // A durable existing-media job is resumed; this does not create or regenerate media.
          const job = await createDownloadJournal({ projectId: context.projectId, mediaId, outputPath });
          const result = await client.reconcileJob(job.jobPath);
          receipt.checks.existingDownloadReconciled = true;
          receipt.checks.downloadVerification = 'downloaded_and_verified';
          receipt.checks.downloadedBytes = result.bytes;
          receipt.checks.mp4SignatureVerified = true;
          receipt.checks.jobPath = path.relative(process.cwd(), result.jobPath);
          const before = receipt.requests.length;
          const repeated = await client.reconcileJob(job.jobPath);
          receipt.checks.completedReconcileMadeNoRequests = before === receipt.requests.length;
          receipt.checks.completedReconcileSameBytes = repeated.bytes === result.bytes;
        } else {
          // The selected ID came from the authenticated project listing above, so no second
          // membership listing is needed before this read-only media detail request.
          const media = await client.batchRpc(RPC.getMedia, buildGetMediaRequest(mediaId));
          receipt.checks.signedVideoUrlPresent = Boolean(findSignedVideoUrl(media));
          if (!receipt.checks.signedVideoUrlPresent) throw Object.assign(new Error('Existing video URL unavailable.'), { code: 'FLOW_VIDEO_URL_MISSING' });
          receipt.checks.downloadVerification = 'signed_url_verified';
        }
      } else {
        receipt.checks.downloadVerification = 'unavailable_media_not_ready';
      }
    }
  }
  try {
    await client.generateVideo({ prompt: 'non-mutating Flow verification', outputPath: path.resolve('.runtime/verification-unwritten.mp4') });
  } catch (error) {
    const guardReason = error.serverCode ?? error.code;
    receipt.checks.generationGuard = ['FLOW_HTTP_CAPTCHA_ISSUER_UNAVAILABLE', 'FLOW_GENERATION_UNRESOLVED', 'FLOW_GENERATION_IN_PROGRESS'].includes(guardReason);
    if (receipt.checks.generationGuard) receipt.checks.generationGuardReason = guardReason;
  }
  const rpcRequests = receipt.requests.filter(record => record.documentProvenance);
  receipt.checks.documentPairMatchesAllReadRequests = rpcRequests.length > 0 && rpcRequests.every(record => {
    const check = record.documentProvenance;
    return check.requestTokenMatchesDocument && check.sessionIdMatchesDocument && check.formKeysUnique && check.queryKeysUnique;
  });
  receipt.passed = receipt.checks.authenticatedProjectRead && receipt.checks.generationGuard === true
    && receipt.checks.documentPairMatchesAllReadRequests;
} catch (error) {
  receipt.passed = false;
  receipt.error = {
    code: typeof error.code === 'string' && /^[A-Za-z0-9_]{1,100}$/.test(error.code) ? error.code : 'FLOW_VERIFICATION_FAILED',
    serverCode: typeof error.serverCode === 'string' && /^[A-Z0-9_]{1,100}$/.test(error.serverCode) ? error.serverCode : undefined,
    httpStatus: Number.isInteger(error.httpStatus) ? error.httpStatus : undefined,
    rpcId: error.rpcId,
  };
} finally { client.close(); provenance.clear(); }
receipt.finishedAt = new Date().toISOString();
if (options.receipt) await writeFile(options.receipt, JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt, null, 2));
if (!receipt.passed) process.exitCode = 1;
}
