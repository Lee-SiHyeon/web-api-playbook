import { createWriteStream } from 'node:fs';
import { access, link, mkdir, open, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { FlowHttpTransport } from './http-transport.mjs';
import {
  createDownloadJournal,
  createGenerationIntent,
  findUnresolvedJournal,
  loadJournal,
  releaseGenerationFence,
  updateJournal,
} from './journal.mjs';
import { acquireFreshGenerationInput, createGenerationBinding, hashGenerationPrompt, revalidateGenerationInput } from './generation-input.mjs';
import {
  bindCaptchaToken,
  buildTextVideoSubmission,
  omitGenerationInput,
  buildGetMediaRequest,
  buildPollGenerationRequest,
  buildProjectMediaRequest,
  findProjectMediaByGenerationRequest,
  findSignedVideoUrl,
  FlowProtocolError,
  readTextVideoSubmit,
  RPC,
  isFlowErrorCandidateReason,
} from './protocol.mjs';

const GENERATION_TIMEOUT_MS = 15 * 60 * 1000;
const POLL_INTERVAL_MS = 5_000;
const ERROR_FRAME_BOOLEAN_FIELDS = [
  'errorMessagePresent', 'errorInfoPresent', 'errorDomainPresent',
  'errorMetadataPresent', 'errorReasonConflict',
];

function safeErrorFrameAttributes(error) {
  const attributes = {};
  for (const field of ERROR_FRAME_BOOLEAN_FIELDS) {
    if (typeof error?.[field] === 'boolean') attributes[field] = error[field];
  }
  if (typeof error?.errorInfoSchemaVerified === 'boolean') {
    attributes.errorInfoSchemaVerified = error.errorInfoSchemaVerified;
  }
  if (isFlowErrorCandidateReason(error?.errorCandidateReason)) {
    attributes.errorCandidateReason = error.errorCandidateReason;
  }
  for (const field of ['errorInfoCount', 'errorMetadataCount']) {
    if (Number.isInteger(error?.[field]) && error[field] >= 0 && error[field] <= 1_000_000) {
      attributes[field] = error[field];
    }
  }
  return attributes;
}

export class FlowClient {
  constructor({ transport, fetchImpl = globalThis.fetch, generationInputProvider, clock = Date.now, jobDir,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    generationTimeoutMs = GENERATION_TIMEOUT_MS, generationPollIntervalMs = POLL_INTERVAL_MS } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('A Fetch-compatible function is required.');
    if (typeof clock !== 'function' || typeof sleep !== 'function') throw new TypeError('Flow clock and sleep functions are required.');
    if (!Number.isFinite(generationTimeoutMs) || generationTimeoutMs < 1 || generationTimeoutMs > GENERATION_TIMEOUT_MS
        || !Number.isFinite(generationPollIntervalMs) || generationPollIntervalMs < 0 || generationPollIntervalMs > POLL_INTERVAL_MS) {
      throw new TypeError('Flow generation wait bounds are invalid.');
    }
    this.transport = transport ?? new FlowHttpTransport({ fetchImpl });
    this.fetch = fetchImpl;
    this.generationInputProvider = generationInputProvider;
    this.clock = clock;
    this.jobDir = jobDir;
    this.sleep = sleep;
    this.generationTimeoutMs = generationTimeoutMs;
    this.generationPollIntervalMs = generationPollIntervalMs;
  }

  async start() {
    await this.transport.start();
  }

  async getContext() {
    const result = this.transport.getContext();
    if (!result || typeof result.projectId !== 'string') {
      throw new Error('The protected Google Flow project session is unavailable.');
    }
    return result;
  }

  async assertActiveProject(projectId) {
    buildProjectMediaRequest(projectId);
    const active = await this.getContext();
    if (active.projectId.toLowerCase() !== projectId.toLowerCase()) {
      throw new Error('The protected Flow session targets another project. Bootstrap the intended project first.');
    }
  }

  async batchRpc(rpcId, freq, { captchaAction, timeoutMs = 60_000 } = {}) {
    if (captchaAction || rpcId === RPC.generateTextVideo) {
      throw new FlowProtocolError('Flow generation requires generateVideo with a bound pure HTTP first-party input provider. No generation request was sent.', {
        code: 'FLOW_GENERATION_INPUT_REQUIRED', rpcId, rejected: true, serverCode: 'FLOW_GENERATION_INPUT_REQUIRED',
      });
    }
    return (await this.transport.rpc(rpcId, freq, { timeoutMs })).payload;
  }

  async getMedia(mediaId) {
    await this.assertProjectMedia(mediaId);
    return this.batchRpc(RPC.getMedia, buildGetMediaRequest(mediaId));
  }

  async getGenerationState(mediaId) {
    await this.assertProjectMedia(mediaId);
    return this.readGenerationState(mediaId);
  }

  async readGenerationState(mediaId) {
    const payload = await this.batchRpc(RPC.pollGeneration, buildPollGenerationRequest(mediaId));
    const record = Array.isArray(payload?.[2]) ? payload[2].find((item) =>
      typeof item?.[0] === 'string' && item[0].toLowerCase() === mediaId.toLowerCase()) : undefined;
    if (!record) throw new FlowProtocolError('Flow polling response did not contain the requested media id.', {
      rpcId: RPC.pollGeneration,
    });
    const details = record[5];
    return {
      mediaId,
      observedStateCode: Number.isInteger(details?.[8]?.[0]) ? details[8][0] : null,
      videoBytes: Number.isInteger(details?.[13]) && details[13] > 0 ? details[13] : null,
      creditBalance: Number.isInteger(payload?.[1]) ? payload[1] : null,
    };
  }

  async getProjectMedia(projectId) {
    await this.assertActiveProject(projectId);
    const listing = await this.batchRpc(RPC.projectMedia, buildProjectMediaRequest(projectId));
    if (!Array.isArray(listing?.[1]) || !Array.isArray(listing?.[2])) {
      throw new FlowProtocolError('Flow project response has an unexpected media schema.', {
        code: 'FLOW_PROJECT_SCHEMA_CHANGED', rpcId: RPC.projectMedia,
      });
    }
    return listing;
  }

  async assertProjectMedia(mediaId) {
    buildGetMediaRequest(mediaId);
    const projectId = (await this.getContext()).projectId;
    const listing = await this.getProjectMedia(projectId);
    if (!listing[2].some((item) => typeof item?.[0] === 'string'
        && item[0].toLowerCase() === mediaId.toLowerCase())) {
      throw new FlowProtocolError('This media is not in the active Flow project.', {
        code: 'FLOW_MEDIA_OUT_OF_SCOPE', rpcId: RPC.projectMedia, rejected: true,
      });
    }
    return projectId;
  }

  async listMediaIds() {
    const projectId = (await this.getContext()).projectId;
    const listing = await this.getProjectMedia(projectId);
    const ids = listing[2].map((record) => record?.[0]);
    if (ids.some((id) => typeof id !== 'string' || !/^[A-Fa-f0-9-]{16,64}$/.test(id))) {
      throw new FlowProtocolError('Flow project contains an unrecognized media record.', {
        code: 'FLOW_PROJECT_SCHEMA_CHANGED', rpcId: RPC.projectMedia,
      });
    }
    return [...new Set(ids)];
  }

  async prepareOutputPath(outputPath) {
    const resolvedPath = path.resolve(outputPath);
    try {
      await access(resolvedPath);
      throw new Error('Output already exists: ' + resolvedPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await mkdir(path.dirname(resolvedPath), { recursive: true });
    return resolvedPath;
  }

  async verifyMp4File(filePath) {
    const { size } = await stat(filePath);
    const handle = await open(filePath, 'r');
    try {
      const signature = Buffer.alloc(12);
      await handle.read(signature, 0, 12, 0);
      if (size < 12 || signature.toString('ascii', 4, 8) !== 'ftyp') {
        throw new Error('Downloaded file has no valid MP4 signature.');
      }
    } finally {
      await handle.close();
    }
    return size;
  }

  async waitForVideo(mediaId, options = {}) {
    await this.assertProjectMedia(mediaId);
    return this.#pollForVideo(mediaId, options);
  }

  async #pollForVideo(mediaId, { timeoutMs = this.generationTimeoutMs, pollIntervalMs = this.generationPollIntervalMs,
    onObservation } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > GENERATION_TIMEOUT_MS
        || !Number.isFinite(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > POLL_INTERVAL_MS) {
      throw new TypeError('Flow generation wait bounds are invalid.');
    }
    if (onObservation !== undefined && typeof onObservation !== 'function') {
      throw new TypeError('Flow generation observation callback must be a function.');
    }
    const deadline = this.clock() + timeoutMs;
    while (this.clock() < deadline) {
      const generation = await this.readGenerationState(mediaId);
      const observation = {
        phase: 'generation_state',
        mediaId,
        observedStateCode: generation.observedStateCode,
        videoBytes: generation.videoBytes,
        at: new Date(this.clock()).toISOString(),
      };
      await onObservation?.(observation);

      // State code 3 and a positive byte count are the observed completed shape.
      // Other codes are recorded without assigning them undocumented meanings.
      if (generation.observedStateCode === 3 && generation.videoBytes !== null) {
        const payload = await this.batchRpc(RPC.getMedia, buildGetMediaRequest(mediaId));
        const url = findSignedVideoUrl(payload);
        if (url) {
          if (url.pathname.slice('/video/'.length).toLowerCase() !== mediaId.toLowerCase()) {
            throw new FlowProtocolError('Flow returned a video URL for a different media record.', {
              code: 'FLOW_MEDIA_RESPONSE_MISMATCH', rpcId: RPC.getMedia,
            });
          }
          await onObservation?.({
            ...observation,
            phase: 'download_ready',
            at: new Date(this.clock()).toISOString(),
          });
          return url;
        }
      }

      await this.sleep(Math.min(pollIntervalMs, Math.max(0, deadline - this.clock())));
    }
    throw new FlowProtocolError('The media has not reached the observed video-download-ready state. Reconcile this job later.', {
      code: 'FLOW_VIDEO_NOT_READY', rpcId: RPC.pollGeneration,
    });
  }

  async downloadVideo(signedUrl, outputPath) {
    const url = signedUrl instanceof URL ? signedUrl : new URL(signedUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'flow-content.google'
        || !/^\/video\/[A-Fa-f0-9-]{16,64}$/.test(url.pathname)) {
      throw new Error('Flow returned a media URL outside the expected host.');
    }
    const resolvedPath = await this.prepareOutputPath(outputPath);
    const tempPath = resolvedPath + '.' + randomUUID() + '.part';
    try {
      const response = await this.fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(120_000) });
      if (!response.ok || !response.body) throw new FlowProtocolError('Flow video download failed.', {
        code: 'FLOW_DOWNLOAD_HTTP_ERROR', httpStatus: response.status,
      });
      const contentType = response.headers.get('content-type') || '';
      const normalizedType = contentType.split(';', 1)[0].trim().toLowerCase();
      if (normalizedType !== 'video/mp4' && normalizedType !== 'application/octet-stream') {
        throw new Error('Flow media response did not have a video-compatible MIME type.');
      }
      await pipeline(Readable.fromWeb(response.body), createWriteStream(tempPath, { flags: 'wx' }));
      const size = await this.verifyMp4File(tempPath);
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > 0 && declaredLength !== size) {
        throw new Error('Flow media download length did not match the response header.');
      }
      // Creating a hard link is atomic and cannot replace an output created by another worker.
      await link(tempPath, resolvedPath);
      await rm(tempPath);
      return { outputPath: resolvedPath, bytes: size };
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async downloadExistingVideo(mediaId, outputPath) {
    const projectId = await this.assertProjectMedia(mediaId);
    const resolvedPath = await this.prepareOutputPath(outputPath);
    const job = await createDownloadJournal({ projectId, mediaId, outputPath: resolvedPath });
    return this.finishJob(job, { projectVerified: true });
  }

  async finishJob(job, { projectVerified = false } = {}) {
    let result;
    try {
      const waitOptions = {
        timeoutMs: job.operation === 'download_existing' ? 60_000 : this.generationTimeoutMs,
        onObservation: async (lastGenerationObservation) => {
          job = await updateJournal(job, { lastGenerationObservation });
        },
      };
      const videoUrl = projectVerified
        ? await this.#pollForVideo(job.mediaId, waitOptions)
        : await this.waitForVideo(job.mediaId, waitOptions);
      result = await this.downloadVideo(videoUrl, job.outputPath);
    } catch (error) {
      const safeCode = (value) => typeof value === 'string' && /^[A-Za-z0-9_]{1,100}$/.test(value) ? value : undefined;
      const lastError = {
        code: safeCode(error.code) ?? safeCode(error.serverCode) ?? safeCode(error.cause?.code)
          ?? (error.name === 'TimeoutError' ? 'FLOW_DOWNLOAD_TIMEOUT' : 'FLOW_DOWNLOAD_INCOMPLETE'),
        rpcId: safeCode(error.rpcId),
        httpStatus: Number.isInteger(error.httpStatus) ? error.httpStatus : undefined,
        at: new Date().toISOString(),
      };
      await updateJournal(job, { state: 'needs_download', lastError });
      const failure = new FlowProtocolError('Flow download is incomplete. Run reconcile --job ' + job.jobPath + '.', {
        code: lastError.code, rpcId: lastError.rpcId, httpStatus: lastError.httpStatus,
      });
      failure.jobPath = job.jobPath;
      throw failure;
    }
    job = await updateJournal(job, { state: 'downloaded', bytes: result.bytes, lastError: null });
    await releaseGenerationFence(job);
    return { ...result, jobPath: job.jobPath };
  }

  async reconcileJob(jobOrPath, { attempts = 1 } = {}) {
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) throw new TypeError('Reconcile attempts must be between 1 and 10.');
    let job = typeof jobOrPath === 'string' ? await loadJournal(jobOrPath) : jobOrPath;
    await this.assertActiveProject(job.projectId);
    if (job.state === 'rejected' || job.state === 'preflight_failed') {
      throw new Error('This Flow job was not accepted for generation. Start a new job if needed.');
    }
    const isCreateJob = job.operation !== 'download_existing' && Array.isArray(job.clientIds) && job.clientIds.length > 0;
    let projectVerified = false;
    if (isCreateJob) {
      let verifiedByListing = false;
      if (!job.mediaId) {
        for (let index = 0; index < attempts; index += 1) {
          const payload = await this.getProjectMedia(job.projectId);
          const match = findProjectMediaByGenerationRequest(payload, job.projectId, job.requestId);
          if (match) {
            job = await updateJournal(job, { state: 'accepted', mediaId: match.mediaId });
            verifiedByListing = true;
            projectVerified = true;
            break;
          }
          if (index + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
        if (!job.mediaId) {
          throw new FlowProtocolError('No matching media appeared in the project listing. Outcome remains uncertain; do not submit again. Journal: ' + job.jobPath, {
            rpcId: RPC.generateTextVideo, ambiguous: true,
          });
        }
      }
      if (!verifiedByListing) {
        await this.assertProjectMedia(job.mediaId);
        projectVerified = true;
      }
    }
    try {
      const bytes = await this.verifyMp4File(job.outputPath);
      job = await updateJournal(job, { state: 'downloaded', bytes, lastError: null });
      await releaseGenerationFence(job);
      return { outputPath: job.outputPath, bytes, jobPath: job.jobPath };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (!job.mediaId) {
      for (let index = 0; index < attempts; index += 1) {
        const payload = await this.getProjectMedia(job.projectId);
        const match = findProjectMediaByGenerationRequest(payload, job.projectId, job.requestId);
        if (match) {
          job = await updateJournal(job, { state: 'accepted', mediaId: match.mediaId });
          break;
        }
        if (index + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      if (!job.mediaId) {
        throw new FlowProtocolError('No matching media appeared in the project listing. Outcome remains uncertain; do not submit again. Journal: ' + job.jobPath, {
          rpcId: RPC.generateTextVideo,
          ambiguous: true,
        });
      }
    }
    return this.finishJob(job, { projectVerified });
  }

  async generateVideo({ prompt, outputPath, projectId, aspect = '16:9', duration = 8, resolution = '720p', timeoutMs = 60_000,
    probeMissingInput = false } = {}) {
    if (typeof outputPath !== 'string' || !outputPath.trim() || outputPath.includes('\0')) {
      throw new TypeError('An output path is required for Flow video generation.');
    }
    if (typeof prompt !== 'string' || !prompt.trim()) throw new TypeError('A non-empty prompt is required.');
    const context = await this.getContext();
    const targetProjectId = String(projectId ?? context.projectId).toLowerCase();
    await this.assertActiveProject(targetProjectId);
    const normalizedDuration = Number(duration);
    const normalizedResolution = String(resolution).toLowerCase();
    if (typeof probeMissingInput !== 'boolean') throw new TypeError('probeMissingInput must be an explicit boolean.');
    if (probeMissingInput && (normalizedDuration !== 8 || normalizedResolution !== '720p' || aspect !== '16:9')) {
      throw new FlowProtocolError('The missing-input diagnostic is limited to one active-project 8-second 720p 16:9 text-to-video request.', {
        code: 'FLOW_GENERATION_PROBE_SCOPE', rpcId: RPC.generateTextVideo, rejected: true,
      });
    }
    const inputMode = probeMissingInput ? 'absent_probe' : 'verified_pure_http';
    const submission = buildTextVideoSubmission({
      prompt, projectId: targetProjectId, aspect, duration: normalizedDuration, resolution: normalizedResolution,
    });
    const promptHash = hashGenerationPrompt(prompt);
    const modelKey = 'abra_t2v_' + normalizedDuration + 's' + (normalizedResolution === '360p' ? '_360p' : '');
    const binding = createGenerationBinding({
      projectId: targetProjectId, promptHash, aspect, duration: normalizedDuration,
      resolution: normalizedResolution, modelKey, clientIds: submission.clientIds, requestId: submission.requestId,
    });

    const unresolved = await findUnresolvedJournal(targetProjectId, undefined, { jobDir: this.jobDir });
    if (unresolved) {
      throw new FlowProtocolError('An unresolved Flow generation already exists for this project. Reconcile it before another create. Journal: ' + unresolved.jobPath, {
        code: 'FLOW_GENERATION_UNRESOLVED', rpcId: RPC.generateTextVideo, ambiguous: true,
      });
    }

    const input = probeMissingInput ? null
      : await acquireFreshGenerationInput(this.generationInputProvider, binding, { clock: this.clock });
    const resolvedOutputPath = await this.prepareOutputPath(outputPath);
    const intent = await createGenerationIntent({
      projectId: targetProjectId, promptHash, clientIds: submission.clientIds, requestId: submission.requestId,
      aspect, duration: normalizedDuration, resolution: normalizedResolution, outputPath: resolvedOutputPath, inputMode,
    }, { jobDir: this.jobDir });
    if (!intent.job) {
      if (intent.unresolved) {
        throw new FlowProtocolError('An unresolved Flow generation already exists for this project. Reconcile it before another create. Journal: ' + intent.unresolved.jobPath, {
          code: 'FLOW_GENERATION_UNRESOLVED', rpcId: RPC.generateTextVideo, ambiguous: true,
        });
      }
      throw new FlowProtocolError('Another Flow generation holds the project write fence; no create request was sent.', {
        code: 'FLOW_GENERATION_IN_PROGRESS', rpcId: RPC.generateTextVideo, rejected: true,
      });
    }
    let job = intent.job;

    let freq;
    try {
      if (probeMissingInput) {
        freq = omitGenerationInput(submission.freq).freq;
      } else {
        revalidateGenerationInput(input, binding, { now: this.clock() });
        freq = bindCaptchaToken(submission.freq, input.token).freq;
      }
    } catch (error) {
      job = await updateJournal(job, { state: 'preflight_failed', lastError: {
        code: /^[A-Z0-9_]{1,100}$/.test(error?.serverCode ?? '') ? error.serverCode : 'FLOW_GENERATION_PREFLIGHT_FAILED',
        at: new Date().toISOString(),
      } });
      await releaseGenerationFence(job);
      throw error;
    }

    if (typeof this.transport.createVideo !== 'function') {
      job = await updateJournal(job, { state: 'preflight_failed', lastError: {
        code: 'FLOW_GENERATION_TRANSPORT_UNAVAILABLE', at: new Date().toISOString(),
      } });
      await releaseGenerationFence(job);
      throw new FlowProtocolError('The Flow direct HTTP generation transport is unavailable; no create request was sent.', {
        code: 'FLOW_GENERATION_TRANSPORT_UNAVAILABLE', rpcId: RPC.generateTextVideo, rejected: true,
      });
    }

    let created;
    try {
      const response = await this.transport.createVideo(freq, { timeoutMs, inputMode });
      try {
        created = readTextVideoSubmit(response.payload);
      } catch (error) {
        if (error?.ambiguous === true && Number.isInteger(response?.evidence?.httpStatus)) {
          error.httpStatus = response.evidence.httpStatus;
        }
        throw error;
      }
    } catch (error) {
      const rejected = error?.rejected === true;
      const code = /^[A-Z0-9_]{1,100}$/.test(error?.serverCode ?? '') ? error.serverCode
        : /^[A-Z0-9_]{1,100}$/.test(error?.code ?? '') ? error.code
          : rejected ? 'FLOW_GENERATION_REJECTED' : 'FLOW_GENERATION_OUTCOME_UNKNOWN';
      job = await updateJournal(job, { state: rejected ? 'rejected' : 'needs_reconciliation', lastError: {
        code,
        rpcId: RPC.generateTextVideo,
        httpStatus: Number.isInteger(error?.httpStatus) ? error.httpStatus : undefined,
        rpcStatus: Number.isInteger(error?.rpcStatus) && error.rpcStatus >= 0 && error.rpcStatus <= 16 ? error.rpcStatus : undefined,
        ...safeErrorFrameAttributes(error),
        at: new Date().toISOString(),
      } });
      if (rejected) await releaseGenerationFence(job);
      const failure = new FlowProtocolError(rejected
        ? 'Flow rejected the generation request. A new explicit job may be started.'
        : 'Flow generation outcome is uncertain. Reconcile this journal before another create: ' + job.jobPath,
      { code, rpcId: RPC.generateTextVideo, httpStatus: job.lastError.httpStatus,
        rpcStatus: job.lastError.rpcStatus,
        ...safeErrorFrameAttributes(error),
        rejected, ambiguous: !rejected });
      failure.jobPath = job.jobPath;
      throw failure;
    }

    job = await updateJournal(job, { state: 'accepted', mediaId: created.mediaId });
    const downloaded = await this.finishJob(job);
    return { ...downloaded, mediaId: created.mediaId, requestId: submission.requestId, status: 'downloaded', inputMode };
  }

  close() {}
}
