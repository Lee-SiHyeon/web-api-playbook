import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { environmentSession, loadProtectedSessionPersistence } from '../api/environment-session.mjs';
import { NaverEditorClient } from '../api/editor-client.mjs';
import { evaluatePublisherJobGate } from '../gates/publisher-gates.mjs';
import { collectHeadlessEnvelope } from './headless-inputs.mjs';
import { validateCreateEnvelope, createJournalKey } from '../api/create-envelope.mjs';
import { WriteJournal } from '../api/write-journal.mjs';

export async function runHeadlessPublication({ job, jobPath, baseDir, command, cookieHeader, journal, output,
  onStage = () => {} }, { collect = collectHeadlessEnvelope, spawnImpl = spawn,
  verifyOwner = async session => new NaverEditorClient({ blogId: job.blogId, session }).loadEditor(undefined, { allowEmpty: true }),
  now = () => new Date(), env = process.env } = {}) {
  if (!['prepare-create', 'create'].includes(command) || job?.target?.type !== 'create' ||
      job.inputProvider !== 'headless_sdk' || job.executionMode !== 'independent_http' ||
      !['private','public'].includes(job.publishSettings?.visibility)) throw Error('HYBRID_CREATE_JOB_REQUIRED');
  if (command === 'create' ? job.publish !== true || job.dryRun !== false : job.publish === true || job.dryRun === false)
    throw Error('HYBRID_COMMAND_MODE_MISMATCH');
  // A missing or stale business gate prevents launching the engine at all.
  const gate = await evaluatePublisherJobGate(job, { baseDir, now: now() });
  if (!gate.passed) { const e = Error('PUBLICATION_GATE_FAILED'); e.details = { failedChecks: gate.failedChecks }; throw e; }
  if (command === 'create') {
    const ledger = new WriteJournal(journal);
    try {
      await ledger.read(createJournalKey(ledger, job));
      throw Error('WRITE_ALREADY_ATTEMPTED_READBACK_REQUIRED');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const session = environmentSession({ NAVER_COOKIE: cookieHeader,
    persistence: await loadProtectedSessionPersistence(env.NAVER_SESSION_VAULT_MODULE) });
  let capture; const seeds = [];
  try {
    await verifyOwner(session); onStage('owner_http_verified');
    for (const part of session.cookieFor('https://blog.naver.com/').split('; ')) {
      const i = part.indexOf('=');
      seeds.push({ name: part.slice(0, i), value: part.slice(i + 1), domain: '.naver.com', path: '/',
        expires: -1, secure: true, httpOnly: true });
    }
    capture = await collect({ cookies: seeds, blogId: job.blogId, document: job.publicationBundle.document, publishSettings: job.publishSettings, onStage });
    if (!capture.metadata.browserClosed) throw Error('CREATE_BROWSER_NOT_CLOSED_OR_CANCELLED');
    validateCreateEnvelope(capture.envelope, { blogId: job.blogId, document: job.publicationBundle.document, now: now() });
    onStage('browser_closed_http_handoff');
    const childEnv = { NAVER_COOKIE: capture.cookieHeader };
    for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'TEMP', 'TMP',
      'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'APPDATA']) {
      if (env[name]) childEnv[name] = env[name];
    }
    if (env.NAVER_SESSION_VAULT_MODULE) childEnv.NAVER_SESSION_VAULT_MODULE = env.NAVER_SESSION_VAULT_MODULE;
    const secrets = [new URLSearchParams(capture.envelope.body).get('tokenId'),
      ...capture.cookieHeader.split(';').map(part => part.slice(part.indexOf('=') + 1).trim())];
    try {
      return await new Promise((resolve, reject) => {
        let raw = '', oversized = false;
        const args = ['scripts/api/publisher-cli.mjs', `--command=${command}`, `--job=${jobPath}`, `--journal=${journal}`];
        if (output) args.push(`--output=${output}`);
        const child = spawnImpl(process.execPath, args, { cwd: fileURLToPath(new URL('../../', import.meta.url)),
          env: childEnv, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], timeout: 150000 });
        const read = chunk => {
          if (raw.length + chunk.length > 2 * 1024 * 1024) { oversized = true; child.kill(); return; }
          raw += chunk.toString();
        };
        child.stdout.on('data', read); child.stderr.on('data', read);
        child.stdin.on('error', () => {});
        child.on('error', () => reject(Error('HYBRID_HTTP_RUNNER_FAILED')));
        child.on('close', code => {
          if (oversized || secrets.some(secret => secret && raw.includes(secret))) return reject(Error('HYBRID_OUTPUT_REDACTED'));
          let result;
          try { result = JSON.parse(raw); } catch { return reject(Error('HYBRID_HTTP_OUTCOME_UNKNOWN')); }
          if (code !== 0 || result.ok !== true) {
            const error = Error(/^[A-Z_]+$/.test(result.code || '') ? result.code : 'HYBRID_HTTP_FAILED');
            error.details = { retryAllowed: false }; return reject(error);
          }
          resolve({ ...result, inputProvider: 'headless_sdk', browserEngineFree: false,
            browserClosedBeforeHTTPWrite: true, inputEvidence: capture.metadata });
        });
        child.stdin.end(JSON.stringify(capture.envelope));
      });
    } finally { delete childEnv.NAVER_COOKIE; secrets.fill(''); }
  } finally {
    session.clear(); seeds.forEach(c => { c.value = ''; });
    if (capture) { capture.envelope.body = ''; capture.cookieHeader = ''; }
  }
}
