import { createWriteStream } from 'node:fs';
import { access, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { FlowBridgeServer } from './bridge-server.mjs';
import { createJournal, findUnresolvedJournal, loadJournal, updateJournal } from './journal.mjs';
import {
  buildGetMediaRequest,
  buildProjectMediaRequest,
  buildTextVideoSubmission,
  findProjectMediaByClientIds,
  findSignedVideoUrl,
  FlowProtocolError,
  getBatchPayload,
  readTextVideoSubmit,
  RPC,
} from './protocol.mjs';

const GENERATION_TIMEOUT_MS = 15 * 60 * 1000;
const POLL_INTERVAL_MS = 5_000;

export class FlowClient {
  constructor({ bridge = new FlowBridgeServer(), fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('A Fetch-compatible function is required.');
    this.bridge = bridge;
    this.fetch = fetchImpl;
  }

  async start() {
    await this.bridge.start();
    await this.bridge.waitForClient();
  }

  async getContext() {
    const result = await this.bridge.request('context');
    if (!result || typeof result.projectId !== 'string') {
      throw new Error('Open a signed-in Google Flow project in Chrome before generating.');
    }
    return result;
  }

  async assertActiveProject(projectId) {
    const active = await this.getContext();
    if (active.projectId.toLowerCase() !== projectId.toLowerCase()) {
      throw new Error('The active Flow tab is a different project from this job. Open the matching project first.');
    }
  }

  async batchRpc(rpcId, freq, { captchaAction, timeoutMs = 60_000 } = {}) {
    await this.bridge.waitForClient(timeoutMs);
    let result;
    try {
      result = await this.bridge.request('rpc', { rpcId, freq, captchaAction }, timeoutMs);
    } catch (error) {
      const knownPreflightFailure = /^(NO_|RECAPTCHA_|CAPTCHA_|RPC_|INVALID_|UNEXPECTED_)/.test(error?.message || '');
      if (captchaAction && !knownPreflightFailure) {
        throw new FlowProtocolError('Generation bridge outcome is ambiguous. Do not retry; reconcile the Flow project first.', {
          rpcId,
          ambiguous: true,
        });
      }
      throw error;
    }
    if (!result || !Number.isInteger(result.status) || typeof result.text !== 'string') {
      throw new FlowProtocolError('Flow bridge returned an incomplete RPC response.', {
        rpcId,
        ambiguous: Boolean(captchaAction),
      });
    }
    if (result.status < 200 || result.status >= 300) {
      throw new FlowProtocolError('Flow RPC returned HTTP ' + result.status + '.', {
        rpcId,
        httpStatus: result.status,
        ambiguous: captchaAction !== undefined,
      });
    }
    return getBatchPayload(result.text, rpcId, { ambiguousOnMissing: Boolean(captchaAction) });
  }

  async getMedia(mediaId) {
    return this.batchRpc(RPC.getMedia, buildGetMediaRequest(mediaId));
  }

  async getProjectMedia(projectId) {
    return this.batchRpc(RPC.projectMedia, buildProjectMediaRequest(projectId));
  }

  async listMediaIds() {
    const projectId = (await this.getContext()).projectId;
    const listing = await this.getProjectMedia(projectId);
    const ids = Array.isArray(listing?.[1]) ? listing[1]
      .map((scene) => scene?.[3]?.[4])
      .filter((id) => typeof id === 'string' && /^[A-Fa-f0-9-]{16,64}$/.test(id)) : [];
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

  async waitForVideo(mediaId, { timeoutMs = GENERATION_TIMEOUT_MS } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const payload = await this.getMedia(mediaId);
      const url = findSignedVideoUrl(payload);
      if (url) return url;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error('Flow generation is still processing. Do not submit again; check this media in the Flow project.');
  }

  async downloadVideo(signedUrl, outputPath) {
    const url = signedUrl instanceof URL ? signedUrl : new URL(signedUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'flow-content.google') {
      throw new Error('Flow returned a media URL outside the expected host.');
    }
    const resolvedPath = await this.prepareOutputPath(outputPath);
    const tempPath = resolvedPath + '.' + randomUUID() + '.part';
    try {
      const response = await this.fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(120_000) });
      if (!response.ok || !response.body) throw new Error('Flow video download returned HTTP ' + response.status + '.');
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
      await rename(tempPath, resolvedPath);
      return { outputPath: resolvedPath, bytes: size };
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async downloadExistingVideo(mediaId, outputPath) {
    buildGetMediaRequest(mediaId);
    const projectId = (await this.getContext()).projectId;
    const listing = await this.getProjectMedia(projectId);
    const belongsToProject = Array.isArray(listing?.[2]) && listing[2].some((item) =>
      typeof item?.[0] === 'string' && item[0].toLowerCase() === mediaId.toLowerCase());
    if (!belongsToProject) throw new Error('This media id is not in the active Flow project.');
    await this.prepareOutputPath(outputPath);
    const videoUrl = await this.waitForVideo(mediaId, { timeoutMs: 60_000 });
    return this.downloadVideo(videoUrl, outputPath);
  }

  async finishJob(job) {
    let result;
    try {
      const videoUrl = await this.waitForVideo(job.mediaId);
      result = await this.downloadVideo(videoUrl, job.outputPath);
    } catch {
      await updateJournal(job, { state: 'needs_download' });
      throw new Error('Flow media exists but download is incomplete. Run reconcile --job ' + job.jobPath + '.');
    }
    await updateJournal(job, { state: 'downloaded', bytes: result.bytes });
    return { ...result, jobPath: job.jobPath };
  }

  async reconcileJob(jobOrPath, { attempts = 1 } = {}) {
    let job = typeof jobOrPath === 'string' ? await loadJournal(jobOrPath) : jobOrPath;
    await this.assertActiveProject(job.projectId);
    if (job.state === 'rejected' || job.state === 'preflight_failed') {
      throw new Error('This Flow job was not accepted for generation. Start a new job if needed.');
    }
    try {
      const bytes = await this.verifyMp4File(job.outputPath);
      await updateJournal(job, { state: 'downloaded', bytes });
      return { outputPath: job.outputPath, bytes, jobPath: job.jobPath };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (!job.mediaId) {
      for (let index = 0; index < attempts; index += 1) {
        const payload = await this.getProjectMedia(job.projectId);
        const match = findProjectMediaByClientIds(payload, job.projectId, job.clientIds);
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
    return this.finishJob(job);
  }

  async generateVideo(options) {
    const context = await this.getContext();
    if (options.projectId && options.projectId.toLowerCase() !== context.projectId.toLowerCase()) {
      throw new Error('The requested project does not match the active Flow tab.');
    }
    const projectId = context.projectId;
    const normalized = {
      prompt: options.prompt,
      projectId,
      aspect: options.aspect || '16:9',
      duration: Number(options.duration || 4),
      resolution: options.resolution || '720p',
    };
    const { freq, clientIds } = buildTextVideoSubmission(normalized);
    const outputPath = await this.prepareOutputPath(options.outputPath);
    const promptHash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
    const previous = await findUnresolvedJournal(projectId, promptHash);
    if (previous) {
      throw new Error('An unresolved Flow job already exists. Run reconcile --job ' + previous.jobPath + ' before submitting again.');
    }
    let job = await createJournal({ ...normalized, promptHash, clientIds, outputPath });
    let payload;
    try {
      payload = await this.batchRpc(RPC.generateTextVideo, freq, {
        captchaAction: 'VIDEO_GENERATION',
        timeoutMs: 120_000,
      });
    } catch (error) {
      if (error instanceof FlowProtocolError && error.rejected) {
        await updateJournal(job, { state: 'rejected', serverCode: error.serverCode });
        throw error;
      }
      if (error instanceof FlowProtocolError && error.ambiguous) {
        job = await updateJournal(job, { state: 'needs_reconciliation' });
        try { return await this.reconcileJob(job, { attempts: 3 }); } catch (reconcileError) {
          if ((await loadJournal(job.jobPath)).mediaId) throw reconcileError;
          throw new FlowProtocolError('Generation outcome remains uncertain. Do not submit again; run reconcile --job ' + job.jobPath + '.', {
            rpcId: RPC.generateTextVideo,
            httpStatus: error.httpStatus,
            ambiguous: true,
          });
        }
      }
      await updateJournal(job, { state: 'preflight_failed' });
      throw error;
    }
    let accepted;
    try { accepted = readTextVideoSubmit(payload); } catch {
      job = await updateJournal(job, { state: 'needs_reconciliation' });
      try { return await this.reconcileJob(job, { attempts: 3 }); } catch (reconcileError) {
        if ((await loadJournal(job.jobPath)).mediaId) throw reconcileError;
        throw new FlowProtocolError('Create response had no recognizable media id. Outcome remains uncertain; run reconcile --job ' + job.jobPath + '.', {
          rpcId: RPC.generateTextVideo,
          ambiguous: true,
        });
      }
    }
    job = await updateJournal(job, { state: 'accepted', mediaId: accepted.mediaId });
    return this.finishJob(job);
  }

  close() { this.bridge.close(); }
}
