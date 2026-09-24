import { writeFile } from 'node:fs/promises';
import { stdin as defaultInput, stdout as defaultOutput } from 'node:process';
import { pathToFileURL } from 'node:url';
import { ApiError, BLOG_ID } from './client.mjs';
import { ApiWorkflow } from '../tools/discovery/api-workflow.mjs';
import { InteractiveAuth } from '../tools/discovery/interactive-auth.mjs';

const WRITE_FORM = `https://blog.naver.com/PostWriteForm.naver?blogId=${BLOG_ID}`;
const DEFAULT_MAX_DOCUMENTS = 30;
const MAX_DOCUMENTS = 60;
const scanTerms = Object.freeze([
  'PostWrite', 'PostUpdate', 'PostDelete', 'documentModel', 'editor', 'SmartEditor',
  'sticker', 'upload', 'photo', 'video', 'autosave', 'draft', 'template', 'publish',
]);

export function parseEditorSurfaceArgs(args = []) {
  let help = false;
  let maxDocuments = DEFAULT_MAX_DOCUMENTS;
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') { help = true; continue; }
    const match = /^--max-documents=(\d+)$/.exec(arg);
    if (!match) throw new ApiError('INPUT', 'Supported flags: --help, --max-documents=1..60');
    maxDocuments = Number(match[1]);
    if (!Number.isInteger(maxDocuments) || maxDocuments < 1 || maxDocuments > MAX_DOCUMENTS) {
      throw new ApiError('INPUT', 'max-documents must be between 1 and 60');
    }
  }
  return { help, maxDocuments };
}

export function sanitizeObservedLinks(links = []) {
  if (!Array.isArray(links)) return [];
  return links.slice(0, 500).map(link => ({
    id: typeof link?.id === 'string' ? link.id : null,
    url: typeof link?.url === 'string' ? link.url : null,
    queryFields: Array.isArray(link?.queryFields) ? link.queryFields.filter(value => typeof value === 'string').slice(0, 50) : [],
    kind: typeof link?.kind === 'string' ? link.kind : null,
    method: typeof link?.method === 'string' ? link.method : null,
    state: typeof link?.state === 'string' ? link.state : null,
    classification: typeof link?.classification === 'string' ? link.classification : null,
  }));
}

function usage() {
  return [
    'Read-only Naver Blog editor surface discovery',
    '',
    'Usage:',
    '  npm run discover:editor-surface',
    '  node scripts/editor-surface-discovery.mjs --max-documents=30',
    '',
    'A temporary browser is used only for manual login and is closed after the session handoff.',
    'The collector then sends approved GET requests only. It never submits a post, edit, delete,',
    'upload, draft, autosave, settings, or other mutation request.',
  ].join('\n');
}

function timestamp(value = new Date()) {
  return value.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function evidenceName(now = new Date()) {
  return `live-editor-surface-${timestamp(now)}.json`;
}

function failureName(now = new Date()) {
  return `editor-surface-failure-${timestamp(now)}.json`;
}

async function persistFailure(error, now = new Date()) {
  const destination = new URL(`../evidence/${failureName(now)}`, import.meta.url);
  const record = {
    schemaVersion: 1,
    checkedAt: now.toISOString(),
    actor: BLOG_ID,
    mode: 'authenticated_read_only_editor_surface_discovery',
    completed: false,
    error: {
      code: error instanceof ApiError ? error.code : 'DISCOVERY_FAILED',
      message: error instanceof ApiError ? error.message : 'Editor surface discovery failed; raw details omitted',
    },
    mutationRequests: 0,
    credentialsPersisted: false,
  };
  await writeFile(destination, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  return destination.pathname.split('/').at(-1);
}

export async function runEditorSurface({ args = process.argv.slice(2), input = defaultInput,
  output = defaultOutput, workflow = null, now = () => new Date() } = {}) {
  const options = parseEditorSurfaceArgs(args);
  if (options.help) { output.write(usage() + '\n'); return { help: true }; }
  if (!input.isTTY || !output.isTTY) throw new ApiError('TTY_REQUIRED', 'Run this command in a local interactive terminal');

  const activeWorkflow = workflow ?? new ApiWorkflow({ auth: new InteractiveAuth({
    readOnlyWarmupUrl: WRITE_FORM,
    timeoutMs: 10 * 60 * 1000,
  }) });
  try {
    output.write('Naver Blog editor surface discovery is starting in GET-only mode.\n');
    await activeWorkflow.prepare();
    output.write('Complete the Naver login in the temporary browser window.\n');
    const login = await activeWorkflow.enableHTTP();
    if (!login.authenticatedHTTP || !login.apiOnly) throw new ApiError('AUTH_UNVERIFIED', 'Verified API-only session was not established');

    const seed = activeWorkflow.observeRead({ url: WRITE_FORM, kind: 'link' });
    const queue = [{ id: seed.id, classification: seed.classification }];
    const seen = new Set();
    const scheduled = new Set([seed.id]);
    const documents = [];
    const linkContracts = [];

    while (queue.length && documents.length < options.maxDocuments) {
      const target = queue.shift();
      const result = await activeWorkflow.inspect({ id: target.id });
      seen.add(target.id);
      if (result.state !== 'http_document_read') {
        throw new ApiError(result.state === 'blocked_auth' ? 'AUTH_LOST' : 'DISCOVERY_BLOCKED',
          'The editor read document did not complete as an authenticated GET');
      }
      const links = sanitizeObservedLinks(result.links);
      linkContracts.push(...links);
      documents.push({
        id: result.id ?? target.id,
        classification: result.classification ?? target.classification,
        state: result.state,
        httpStatus: result.httpStatus ?? null,
        mime: result.mime ?? null,
        bytes: result.bytes ?? null,
        formFieldNames: Array.isArray(result.formFieldNames) ? result.formFieldNames.slice(0, 500) : [],
        observedLinks: links.length,
      });

      try { activeWorkflow.scan({ id: target.id, terms: scanTerms }); }
      catch (error) { if (!(error instanceof ApiError)) throw error; }

      for (const link of links) {
        // The initial editor document is seeded with its known, authorized blogId value.
        // Discovered evidence deliberately omits query values, so only value-free public scripts
        // are promoted automatically. Other editor URLs remain metadata candidates for review.
        if (link.state !== 'read_candidate' || link.classification !== 'public_script') continue;
        if (!link.id || seen.has(link.id) || scheduled.has(link.id)) continue;
        const observed = activeWorkflow.observeRead({ url: link.url, kind: 'script' });
        scheduled.add(observed.id);
        queue.push({ id: observed.id, classification: observed.classification });
      }
    }

    if (!documents.some(document => document.classification === 'editor_form_document')) {
      throw new ApiError('EDITOR_NOT_OBSERVED', 'No authenticated editor form document was read');
    }
    const workflowEvidence = activeWorkflow.evidence();
    if (!workflowEvidence.authenticatedHTTP || !workflowEvidence.apiOnly) {
      throw new ApiError('AUTH_LOST', 'The verified HTTP session was no longer active at completion');
    }
    const checkedAt = now();
    const record = {
      schemaVersion: 1,
      checkedAt: checkedAt.toISOString(),
      actor: BLOG_ID,
      mode: 'authenticated_read_only_editor_surface_discovery',
      completed: true,
      seed: { url: 'https://blog.naver.com/PostWriteForm.naver', queryFields: ['blogId'] },
      mutationRequests: 0,
      documents,
      linkContracts: [...new Map(linkContracts.map(item => [`${item.id}:${item.kind}:${item.method ?? ''}`, item])).values()],
      frontier: activeWorkflow.frontier(),
      ...workflowEvidence,
    };
    const destination = new URL(`../evidence/${evidenceName(checkedAt)}`, import.meta.url);
    await writeFile(destination, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
    output.write(JSON.stringify({ completed: true, documents: documents.length,
      evidenceFile: destination.pathname.split('/').at(-1), mutationRequests: 0 }, null, 2) + '\n');
    return { completed: true, documents: documents.length, destination };
  } finally {
    await activeWorkflow.close().catch(() => {});
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invokedPath === import.meta.url) {
  runEditorSurface().catch(async error => {
    let evidenceFile = null;
    try { evidenceFile = await persistFailure(error); } catch {}
    console.error(JSON.stringify({
      code: error instanceof ApiError ? error.code : 'DISCOVERY_FAILED',
      message: error instanceof ApiError ? error.message : 'Editor surface discovery failed; raw details omitted',
      ...(evidenceFile ? { evidenceFile } : {}),
    }));
    process.exitCode = 1;
  });
}
