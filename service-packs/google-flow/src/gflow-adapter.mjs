import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFile, stat, link, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveProfileEndpoint, connectProfileCdp, profileError } from './profile-cdp.mjs';
import { assertProfileOwner } from './profile-sync.mjs';
import { createNetworkCapture } from './profile-observe.mjs';
import { readCredential } from './secure-credential-store.mjs';
import { GOOGLE_FLOW_AUTH_CREDENTIAL } from './google-sso-recovery.mjs';
import { createGenerationIntent, updateJournal, releaseGenerationFence } from './journal.mjs';
import { hashGenerationPrompt } from './generation-input.mjs';
import { findProjectMediaByGenerationRequest } from './protocol.mjs';

export const DEFAULT_GFLOW_ROOT = 'C:\\Users\\User\\tools\\gflow';

export function normalizeGflowSpec(options) {
  if (options.confirmGeneration !== true) throw profileError('GENERATION_CONFIRMATION_REQUIRED');
  if (typeof options.prompt !== 'string' || !options.prompt.trim() || options.prompt.length > 20_000) throw profileError('FLOW_GFLOW_PROMPT_INVALID');
  if (!/^[a-f0-9-]{16,64}$/i.test(options.projectId)) throw profileError('FLOW_GFLOW_PROJECT_INVALID');
  if (!['9:16','16:9'].includes(options.aspect ?? '16:9')) throw profileError('FLOW_GFLOW_ASPECT_INVALID');
  if (![4,6,8,10].includes(Number(options.duration ?? 8))) throw profileError('FLOW_GFLOW_DURATION_INVALID');
  if (options.resolution !== undefined && options.resolution !== '720p') throw profileError('FLOW_GFLOW_RESOLUTION_UNVERIFIED');
  if (options.audio !== undefined || options.dialogue !== undefined) throw profileError('FLOW_AUDIO_CONTRACT_UNVERIFIED');
  if (options.extend && (!/^[a-f0-9-]{16,64}$/i.test(options.extend) || options.startFrame || options.endFrame || options.character)) {
    throw profileError('FLOW_GFLOW_EXTEND_OPTIONS_INVALID');
  }
  const character = options.character === undefined ? [] : Array.isArray(options.character) ? options.character : [options.character];
  if (character.some(name => typeof name !== 'string' || !name.trim() || name.length > 100 || /[\r\n\0]/.test(name))) throw profileError('FLOW_GFLOW_CHARACTER_INVALID');
  if (typeof options.outputPath !== 'string' || !options.outputPath || path.extname(options.outputPath).toLowerCase() !== '.mp4') throw profileError('FLOW_GFLOW_OUTPUT_INVALID');
  return { ...options, prompt: options.prompt.trim(), aspect: options.aspect ?? '16:9',
    duration: Number(options.duration ?? 8), resolution: options.resolution ?? '720p', character,
    outputPath: path.resolve(options.outputPath),
    ...(options.startFrame ? { startFrame: path.resolve(options.startFrame) } : {}),
    ...(options.endFrame ? { endFrame: path.resolve(options.endFrame) } : {}) };
}

// Never retry a click whose outcome may have been accepted by the web app.
export function createSingleSubmit(beforeSubmit) {
  let used = false;
  return async click => {
    if (used) throw profileError('FLOW_GFLOW_DUPLICATE_SUBMIT_BLOCKED');
    used = true;
    await beforeSubmit();
    await click();
  };
}

export function generationRequestIdentity(postData, projectId) {
  try {
    const form = new URLSearchParams(postData);
    const rpc = JSON.parse(form.get('f.req'))?.[0]?.[0];
    if (rpc?.[0] !== 'YhhmEf') return null;
    const payload = JSON.parse(rpc[1]);
    const requestId = payload?.[2]?.[0];
    if (payload?.[1]?.[5]?.toLowerCase() !== projectId.toLowerCase() || !/^[a-f0-9-]{36}$/i.test(requestId)) return null;
    return { requestId };
  } catch { return null; }
}

async function assertNoChallenge(page) {
  const host = new URL(page.url()).hostname;
  if (host === 'accounts.google.com') throw profileError('FLOW_PROFILE_LOGIN_REQUIRED');
  const challenge = await page.locator('iframe[src*="/bframe"]').evaluateAll(nodes => nodes.some(e => {
    const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden';
  }));
  if (challenge) throw profileError('FLOW_PROFILE_CHALLENGE_REQUIRED');
}

async function strictFrameUpload(flow, slot, filename) {
  const page = flow.page;
  const button = page.getByText(slot, { exact: true });
  if (await button.count() !== 1) throw profileError('FLOW_GFLOW_FRAME_SLOT_UNVERIFIED');
  await button.click();
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor({ state: 'visible' });
  const upload = dialog.getByRole('button', { name: /upload media/i });
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 15000 }), upload.click()]);
  await chooser.setFiles(filename);
  await dialog.locator('[role="option"][aria-selected="true"]').waitFor({ state: 'visible', timeout: 30000 });
  await dialog.getByRole('button', { name: /add to prompt/i }).click();
  await dialog.waitFor({ state: 'hidden' });
  if (await page.getByText(slot, { exact: true }).count() !== 0) throw profileError('FLOW_GFLOW_FRAME_REFERENCE_UNVERIFIED');
}

async function strictSettings(flow, spec) {
  const settings = flow.page.locator('button').filter({ hasText: /crop_(16_9|9_16|square|portrait|landscape)/ });
  if (await settings.count() !== 1) throw profileError('FLOW_GFLOW_SETTINGS_UNVERIFIED');
  await flow.applySettings({ type: 'video', ratio: spec.aspect, duration: spec.duration, outputs: 1,
    startFrame: spec.startFrame, endFrame: spec.endFrame });
  await settings.click();
  const chosen = await flow.page.locator('[aria-selected="true"],[aria-pressed="true"],[data-state="active"],[data-state="on"],[data-state="checked"]').allTextContents();
  const text = chosen.join(' ');
  const wanted = [spec.aspect === '9:16' ? /crop_9_16/ : /crop_16_9/, new RegExp(`\\b${spec.duration}s\\b`), /(?:\b1x\b|\bx1\b)/, /720p/,
    /Video/, spec.startFrame || spec.endFrame ? /Frames/ : /Ingredients/];
  if (!wanted.every(pattern => pattern.test(text))) throw profileError('FLOW_GFLOW_SETTINGS_UNVERIFIED');
  await flow.page.keyboard.press('Escape');
}

export async function runGflowBrowser(spec, { beforeSubmit, onIdentity, gflowRoot = DEFAULT_GFLOW_ROOT, profileDir } = {}) {
  const require = createRequire(path.join(gflowRoot, 'package.json'));
  const root = path.dirname(require.resolve('@swissmarley/gflow-cli/package.json'));
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (pkg.version !== '1.1.1') throw profileError('FLOW_GFLOW_VERSION_UNREVIEWED');
  // Import the MIT UI library, never its launcher that suppresses automation signals.
  const { FlowPage } = await import(pathToFileURL(path.join(root, 'dist/src/flow/page.js')).href);
  const { ScenePage } = await import(pathToFileURL(path.join(root, 'dist/src/flow/scene.js')).href);
  const { chromium } = require('playwright');
  const resolved = await resolveProfileEndpoint({ profileDir, launch: true });
  const cdp = await connectProfileCdp({ profileDir, launch: false });
  let browser, page, capture;
  let submitted = false;
  const pendingIdentity = [];
  let generationTransports = 0;
  let duplicateBlocked = false;
  try {
    browser = await chromium.connectOverCDP(resolved.endpoint);
    const context = browser.contexts()[0];
    if (!context) throw profileError('FLOW_PROFILE_CDP_UNAVAILABLE');
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    const pageSession = await context.newCDPSession(page);
    const { targetInfo } = await pageSession.send('Target.getTargetInfo');
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: targetInfo.targetId, flatten: true });
    capture = createNetworkCapture(cdp, sessionId);
    await capture.enable();
    await page.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const knownCreate = request.method() === 'POST' && ((url.hostname === 'flow.google.com'
        && url.searchParams.get('rpcids')?.split(',').includes('YhhmEf'))
        || (url.hostname === 'aisandbox-pa.googleapis.com' && /(?:batchAsyncGenerate|extendVideo|video:extend)/i.test(url.pathname)));
      const identity = generationRequestIdentity(request.postData(), spec.projectId);
      if (knownCreate || identity) {
        if (!submitted || generationTransports++ > 0) { duplicateBlocked = true; await route.abort('blockedbyclient'); return; }
        if (identity) {
          const saved = onIdentity(identity); pendingIdentity.push(saved);
          try { await saved; } catch { duplicateBlocked = true; await route.abort('blockedbyclient'); return; }
        }
      }
      await route.continue();
    });
    await page.goto(`https://flow.google.com/project/${spec.projectId}`, { waitUntil: 'domcontentloaded' });
    await assertNoChallenge(page);
    const broker = JSON.parse(readCredential(GOOGLE_FLOW_AUTH_CREDENTIAL));
    assertProfileOwner(await page.content(), broker.owner);
    const flow = new FlowPage(page);
    await flow.assertReady();
    const singleSubmit = createSingleSubmit(async () => { await assertNoChallenge(page); await beforeSubmit(); submitted = true; });
    if (spec.extend) {
      const scene = new ScenePage(page);
      await scene.openScene({ project: spec.projectId, mediaId: spec.extend });
      const before = await scene.totalDurationValue();
      if (!await scene.pickPlusMenuItem(/extend/i)) throw profileError('FLOW_GFLOW_EXTEND_UNAVAILABLE');
      await flow.fillPrompt(spec.prompt);
      const submit = page.locator('button').filter({ hasText: /arrow_forward/ });
      if (await submit.count() !== 1) throw profileError('FLOW_GFLOW_SUBMIT_UNVERIFIED');
      await singleSubmit(() => submit.click({ timeout: 5000 }));
      await scene.waitForTimelineGrowth(before, 900000, 'one extension');
      await assertNoChallenge(page);
      // One normal export click. The upstream download retry is deliberately not used.
      const exportButton = page.getByRole('button', { name: /download/i });
      if (await exportButton.count() !== 1) throw profileError('FLOW_GFLOW_DOWNLOAD_UNVERIFIED');
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 300000 }), exportButton.click()]);
      const temp = path.join(path.dirname(spec.outputPath), `.flow-${randomUUID()}.mp4`);
      await download.saveAs(temp);
      if (duplicateBlocked) throw profileError('FLOW_GFLOW_DUPLICATE_SUBMIT_BLOCKED');
      const evidence = await capture.finish(); capture = null;
      return { downloadedFile: temp, observedTotalDuration: await scene.totalDurationLabel(), capture: evidence };
    }
    await strictSettings(flow, spec);
    if (spec.startFrame) await strictFrameUpload(flow, 'Start', spec.startFrame);
    if (spec.endFrame) await strictFrameUpload(flow, 'End', spec.endFrame);
    for (const name of spec.character) {
      await flow.referenceCharacter(name);
      if (!(await page.locator('[role="textbox"]').allTextContents()).some(t => t.includes(name))) throw profileError('FLOW_GFLOW_CHARACTER_REFERENCE_UNVERIFIED');
    }
    await flow.fillPrompt(spec.prompt);
    const submit = page.locator('button').filter({ hasText: /arrow_forward/ }).filter({ hasText: /Create/ });
    if (await submit.count() !== 1 || !await submit.isEnabled()) throw profileError('FLOW_GFLOW_SUBMIT_UNVERIFIED');
    await singleSubmit(() => submit.click({ timeout: 5000 }));
    // Observe the request identity; polling and download are handled by the maintained HTTP client.
    await page.waitForTimeout(2000);
    await Promise.all(pendingIdentity);
    if (duplicateBlocked) throw profileError('FLOW_GFLOW_DUPLICATE_SUBMIT_BLOCKED');
    const evidence = await capture.finish(); capture = null;
    return { capture: evidence };
  } catch (error) {
    if (!submitted && error?.code?.startsWith('FLOW_')) throw profileError(error.code);
    throw profileError(submitted ? 'FLOW_GFLOW_OUTCOME_UNCERTAIN' : 'FLOW_GFLOW_PREFLIGHT_FAILED');
  } finally {
    await Promise.allSettled(pendingIdentity);
    if (capture) await capture.finish().catch(() => {});
    await page?.close().catch(() => {});
    await browser?.close().catch(() => {}); // CDP disconnect; never terminates the profile Chrome.
    cdp.close();
  }
}

export async function generateWithGflow(client, options, { runImpl = runGflowBrowser, jobDir } = {}) {
  const spec = normalizeGflowSpec(options);
  await client.assertActiveProject(spec.projectId);
  if (spec.extend) await client.assertProjectMedia(spec.extend);
  for (const filename of [spec.startFrame,spec.endFrame].filter(Boolean)) {
    const file = await stat(filename);
    if (!file.isFile() || !file.size || !/\.(?:jpg|jpeg|png|webp)$/i.test(filename)) throw profileError('FLOW_GFLOW_FRAME_FILE_INVALID');
  }
  spec.outputPath = await client.prepareOutputPath(spec.outputPath);
  let job;
  let submitted = false;
  const beforeSubmit = async () => {
    if (submitted) throw profileError('FLOW_GFLOW_DUPLICATE_SUBMIT_BLOCKED');
    const reserved = await createGenerationIntent({ projectId: spec.projectId, promptHash: hashGenerationPrompt(spec.prompt),
      clientIds: [randomUUID()], aspect: spec.aspect, duration: spec.duration, resolution: spec.resolution,
      outputPath: spec.outputPath, inputMode: 'gflow_browser' }, { jobDir });
    if (!reserved.job) throw profileError('FLOW_GENERATION_FENCE_BUSY');
    job = await updateJournal(reserved.job, { state: 'needs_reconciliation', backend: 'gflow',
      operationKind: spec.extend ? 'extend' : 'generate', generationSubmitAttempts: 1 });
    submitted = true;
  };
  const onIdentity = async identity => {
    if (!job || !submitted) throw profileError('FLOW_GFLOW_IDENTITY_WITHOUT_INTENT');
    if (job.requestId && job.requestId !== identity.requestId) throw profileError('FLOW_GFLOW_MULTIPLE_REQUESTS');
    job = await updateJournal(job, identity);
  };
  try {
    const result = await runImpl(spec, { beforeSubmit, onIdentity, profileDir: spec.profileDir });
    if (!submitted) throw profileError('FLOW_GFLOW_NO_SUBMISSION');
    if (spec.extend && result.downloadedFile) {
      const bytes = await client.verifyMp4File(result.downloadedFile);
      await link(result.downloadedFile, spec.outputPath);
      job = await updateJournal(job, { state: 'downloaded', bytes, observedTotalDuration: result.observedTotalDuration });
      await releaseGenerationFence(job);
      return { status: 'downloaded', mode: 'browser_automation', outputPath: spec.outputPath, bytes, jobPath: job.jobPath, capture: result.capture };
    }
    if (!job.requestId) throw profileError('FLOW_GFLOW_IDENTITY_UNOBSERVED');
    let matched;
    for (let i = 0; i < 6 && !matched; i += 1) {
      matched = findProjectMediaByGenerationRequest(await client.getProjectMedia(spec.projectId), spec.projectId, job.requestId);
      if (!matched) await new Promise(resolve => setTimeout(resolve, 2000));
    }
    if (!matched) throw profileError('FLOW_GFLOW_OUTCOME_UNCERTAIN');
    job = await updateJournal(job, { state: 'accepted', mediaId: matched.mediaId });
    const downloaded = await client.reconcileJob(job);
    return { status: 'downloaded', mode: 'gflow_browser_generate_http_download', mediaId: matched.mediaId,
      ...downloaded, generationSubmitAttempts: 1, capture: result.capture };
  } catch (error) {
    if (job) {
      await updateJournal(job, { state: 'needs_reconciliation', lastError: { code: /^FLOW_[A-Z0-9_]+$/.test(error?.code) ? error.code : 'FLOW_GFLOW_OUTCOME_UNCERTAIN' } });
      throw Object.assign(profileError('FLOW_GFLOW_OUTCOME_UNCERTAIN'), { jobPath: job.jobPath, generationSubmitAttempts: 1 });
    }
    if (error?.code?.startsWith('FLOW_')) throw error;
    throw profileError('FLOW_GFLOW_PREFLIGHT_FAILED');
  }
}
