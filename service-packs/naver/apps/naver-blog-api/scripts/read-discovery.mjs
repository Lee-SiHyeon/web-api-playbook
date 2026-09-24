import { writeFile } from 'node:fs/promises';
import { stdin as defaultInput, stdout as defaultOutput } from 'node:process';
import { pathToFileURL } from 'node:url';
import { ApiError, BLOG_ID } from './client.mjs';
import { ApiWorkflow } from '../tools/discovery/api-workflow.mjs';
import { InteractiveAuth } from '../tools/discovery/interactive-auth.mjs';

const DEFAULT_MAX_DOCUMENTS = 12;
const MAX_DOCUMENTS = 50;
const editorReadClassifications = new Set(['editor_form_document', 'public_script']);

export function parseArgs(args = []) {
  let help = false;
  let maxDocuments = DEFAULT_MAX_DOCUMENTS;
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    const match = /^--max-documents=(\d+)$/.exec(arg);
    if (!match) throw new ApiError('INPUT', 'Supported flags: --help, --max-documents=1..50');
    maxDocuments = Number(match[1]);
    if (!Number.isInteger(maxDocuments) || maxDocuments < 1 || maxDocuments > MAX_DOCUMENTS) {
      throw new ApiError('INPUT', 'max-documents must be between 1 and 50');
    }
  }
  return { help, maxDocuments };
}

export function selectEditorReadCandidates(links = [], seen = new Set()) {
  if (!Array.isArray(links)) return [];
  const selected = [];
  const local = new Set();
  for (const link of links) {
    if (!link || link.state !== 'read_candidate' || !editorReadClassifications.has(link.classification)) continue;
    if (typeof link.id !== 'string' || !link.id || seen.has(link.id) || local.has(link.id)) continue;
    local.add(link.id);
    selected.push({ id: link.id, classification: link.classification });
  }
  return selected;
}

export function summarizeLogin(result = {}) {
  return {
    state: typeof result.state === 'string' ? result.state : null,
    classification: typeof result.classification === 'string' ? result.classification : null,
    authenticatedHTTP: result.authenticatedHTTP === true,
    apiOnly: result.apiOnly === true,
    browserOpen: result.browserOpen === true,
    verification: result.verification ? {
      verified: result.verification.verified === true,
      actor: result.verification.actor ?? null,
      httpStatus: result.verification.httpStatus ?? null,
      mime: result.verification.mime ?? null,
      source: result.verification.source ?? null,
    } : null,
  };
}

function usage() {
  return [
    'Read-only Naver Blog editor discovery',
    '',
    'Usage:',
    '  npm run discover:editor-read',
    '  node scripts/read-discovery.mjs --max-documents=12',
    '',
    'A temporary browser window opens for manual Naver login. This process never receives',
    'or stores the password. Cookies, response bodies, and query values are not written',
    'to the evidence file.',
    'No publish, edit, delete, upload, settings, or other write request is executed.',
  ].join('\n');
}

function evidenceName(now = new Date()) {
  return `live-editor-read-${now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}.json`;
}

function failureEvidenceName(now = new Date()) {
  return `editor-run-failure-${now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}.json`;
}

function safeFailureDetails(details) {
  if (!details || typeof details !== 'object') return null;
  const verification = details.verification && typeof details.verification === 'object' ? {
    verified: details.verification.verified === true,
    httpStatus: Number.isInteger(details.verification.httpStatus) ? details.verification.httpStatus : null,
    mime: typeof details.verification.mime === 'string' ? details.verification.mime.slice(0, 100) : null,
    bytes: Number.isInteger(details.verification.bytes) ? details.verification.bytes : null,
    actorMatched: details.verification.actorMatched === true,
    adminShell: details.verification.adminShell === true,
    substantialAdminDocument: details.verification.substantialAdminDocument === true,
    loginHTML: details.verification.loginHTML === true,
    redirectCount: Number.isInteger(details.verification.redirectCount) ? details.verification.redirectCount : null,
    finalPath: typeof details.verification.finalPath === 'string' ? details.verification.finalPath.slice(0, 300) : null,
    userAgentApplied: details.verification.userAgentApplied === true,
  } : null;
  const document = details.document && typeof details.document === 'object' ? {
    classification: typeof details.document.classification === 'string' ? details.document.classification.slice(0, 100) : null,
    state: typeof details.document.state === 'string' ? details.document.state.slice(0, 100) : null,
    httpStatus: Number.isInteger(details.document.httpStatus) ? details.document.httpStatus : null,
    mime: typeof details.document.mime === 'string' ? details.document.mime.slice(0, 100) : null,
  } : null;
  return {
    browserAdminVerified: details.browserAdminVerified === true,
    browserAdminNavigationAttempts: Number.isInteger(details.browserAdminNavigationAttempts) ? details.browserAdminNavigationAttempts : null,
    verificationAttempts: Number.isInteger(details.verificationAttempts) ? details.verificationAttempts : null,
    ...(verification ? { verification } : {}),
    ...(document ? { document } : {}),
  };
}

async function persistFailure(error, now = new Date()) {
  const apiError = error instanceof ApiError;
  const destination = new URL(`../evidence/${failureEvidenceName(now)}`, import.meta.url);
  const record = {
    schemaVersion: 1,
    checkedAt: now.toISOString(),
    actor: BLOG_ID,
    mode: 'authenticated_read_only_editor_discovery',
    completed: false,
    error: {
      code: apiError ? error.code : 'DISCOVERY_FAILED',
      message: apiError ? error.message : 'Read-only discovery failed; raw details omitted',
      ...(apiError && safeFailureDetails(error.details) ? { details: safeFailureDetails(error.details) } : {}),
    },
    mutationRequests: 0,
    credentialsPersisted: false,
  };
  await writeFile(destination, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  return destination.pathname.split('/').at(-1);
}

export async function run({ args = process.argv.slice(2), input = defaultInput, output = defaultOutput,
  workflow = null, now = () => new Date() } = {}) {
  const options = parseArgs(args);
  if (options.help) {
    output.write(usage() + '\n');
    return { help: true };
  }
  if (!input.isTTY || !output.isTTY) throw new ApiError('TTY_REQUIRED', 'Run this command in a local interactive terminal');

  const activeWorkflow = workflow ?? new ApiWorkflow({ auth: new InteractiveAuth() });
  try {
    output.write('Naver Blog read-only discovery is starting. No write request is enabled.\n');
    const prepared = await activeWorkflow.prepare();
    output.write(JSON.stringify({ stage: prepared.stage ?? null, classification: prepared.classification ?? null,
      browserOpen: prepared.browserOpen === true, interactive: prepared.interactive === true }, null, 2) + '\n');
    output.write('Complete the Naver login in the temporary browser window. This terminal does not receive the password.\n');
    const login = await activeWorkflow.enableHTTP();
    const loginSummary = summarizeLogin(login);
    output.write(JSON.stringify(loginSummary, null, 2) + '\n');
    if (!loginSummary.authenticatedHTTP) {
      return { authenticatedHTTP: false, classification: loginSummary.classification, state: loginSummary.state };
    }

    const seen = new Set();
    const scheduled = new Set();
    const queue = [{ id: null, classification: 'admin_read_document' }];
    const inspected = [];
    while (queue.length && inspected.length < options.maxDocuments) {
      const target = queue.shift();
      const result = await activeWorkflow.inspect(target.id ? { id: target.id } : undefined);
      if (typeof result.id === 'string') seen.add(result.id);
      inspected.push({ id: result.id ?? null, classification: result.classification ?? target.classification,
        state: result.state ?? null, httpStatus: result.httpStatus ?? null, mime: result.mime ?? null,
        formFieldNames: Array.isArray(result.formFieldNames) ? result.formFieldNames : [] });
      if (result.state !== 'http_document_read') {
        throw new ApiError(result.state === 'blocked_auth' ? 'AUTH_LOST' : 'DISCOVERY_BLOCKED',
          'Read-only discovery stopped before the document could be classified as authenticated content', {
            document: {
              classification: result.classification ?? target.classification,
              state: result.state ?? null,
              httpStatus: result.httpStatus ?? null,
              mime: result.mime ?? null,
            },
          });
      }
      if (typeof result.id === 'string' && result.state === 'http_document_read') {
        try { activeWorkflow.scan({ id: result.id }); }
        catch (error) { if (!(error instanceof ApiError)) throw error; }
      }
      const candidates = selectEditorReadCandidates(result.links, new Set([...seen, ...scheduled]));
      for (const candidate of candidates) scheduled.add(candidate.id);
      queue.push(...candidates);
    }

    const checkedAt = now();
    const workflowEvidence = activeWorkflow.evidence();
    if (!workflowEvidence.authenticatedHTTP || !workflowEvidence.apiOnly) {
      throw new ApiError('AUTH_LOST', 'The verified HTTP session was no longer active at completion');
    }
    const record = {
      schemaVersion: 1,
      checkedAt: checkedAt.toISOString(),
      actor: BLOG_ID,
      mode: 'authenticated_read_only_editor_discovery',
      completed: true,
      mutationRequests: 0,
      inspected,
      frontier: activeWorkflow.frontier(),
      ...workflowEvidence,
    };
    const destination = new URL(`../evidence/${evidenceName(checkedAt)}`, import.meta.url);
    await writeFile(destination, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
    output.write(JSON.stringify({ completed: true, inspected: inspected.length,
      evidenceFile: destination.pathname.split('/').at(-1), mutationRequests: 0 }, null, 2) + '\n');
    return { authenticatedHTTP: true, inspected: inspected.length, destination };
  } finally {
    await activeWorkflow.close().catch(() => {});
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invokedPath === import.meta.url) {
  run().catch(async error => {
    const apiError = error instanceof ApiError;
    let evidenceFile = null;
    try { evidenceFile = await persistFailure(error); } catch {}
    console.error(JSON.stringify({ code: apiError ? error.code : 'DISCOVERY_FAILED',
      message: apiError ? error.message : 'Read-only discovery failed; raw details omitted',
      ...(evidenceFile ? { evidenceFile } : {}) }));
    process.exitCode = 1;
  });
}
