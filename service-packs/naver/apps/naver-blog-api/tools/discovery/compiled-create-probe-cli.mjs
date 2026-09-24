import { open } from 'node:fs/promises';
import path from 'node:path';
import { collectHeadlessEnvelope } from '../../scripts/hybrid/headless-inputs.mjs';
import { environmentSession } from '../../scripts/api/environment-session.mjs';
import { NaverEditorClient } from '../../scripts/api/editor-client.mjs';
import { compileEditorModel, inspectEditorModel } from '../../scripts/api/editor-model.mjs';
import { validateCreateEnvelope } from '../../scripts/api/create-envelope.mjs';
import { WriteJournal } from '../../scripts/api/write-journal.mjs';
import { COMPILED_CREATE_TITLE, COMPILED_CREATE_PARAGRAPHS, verifyPrivateCreate } from './private-create-probe.mjs';
import { scopedLoginHeader } from './publisher-session-handoff.mjs';
let output, cookies, capture, session;
try {
  const options = {};
  for (const arg of process.argv.slice(2)) {
    const match = /^--(output|journal)=(.+)$/.exec(arg);
    if (!match || Object.hasOwn(options, match[1])) throw Error('INPUT');
    options[match[1]] = match[2];
  }
  if (!options.output || !options.journal) throw Error('INPUT');
  output = await open(path.resolve(options.output), 'wx', 0o600);
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size > 65536) throw Error('INPUT_LIMIT'); chunks.push(chunk); }
  cookies = JSON.parse(Buffer.concat(chunks).toString('utf8')).cookies;
  chunks.forEach(chunk => chunk.fill(0));
  session = environmentSession({ NAVER_COOKIE: scopedLoginHeader(cookies) });
  const blogId = 'aicandoanything';
  const status = await new NaverEditorClient({ blogId, session }).sessionStatus();
  if (!status.protectedOwnerVerified) throw Error('AUTH_MISSING');
  const document = { blogId, title: COMPILED_CREATE_TITLE,
    blocks: COMPILED_CREATE_PARAGRAPHS.map(text => ({ type: 'paragraph', text })) };
  capture = await collectHeadlessEnvelope({ cookies, blogId, document,
    onStage: progress => console.log(JSON.stringify({ progress })) });
  const prepared = validateCreateEnvelope(capture.envelope, { blogId, document });
  const model = compileEditorModel(prepared.model, document);
  const form = new URLSearchParams(capture.envelope.body);
  form.set('documentModel', JSON.stringify(model));
  capture.envelope.body = form.toString();
  session.clear(); session = environmentSession({ NAVER_COOKIE: capture.cookieHeader });
  const receipt = await verifyPrivateCreate(capture.envelope, { blogId, session,
    journal: new WriteJournal(path.resolve(options.journal)), probe: 'compiled' });
  const result = { schemaVersion: 1, checkedAt: new Date().toISOString(), sessionStatus: status,
    inputProvider: 'headless_sdk', inputEvidence: capture.metadata, httpWrite: receipt,
    compiledComponentCount: model.document.components.length,
    completeDocumentReplacementVerified: inspectEditorModel(model).units.length === 4,
    commercialPublicationQualityVerified: false, browserEngineFree: false, credentialsPersisted: false };
  await output.writeFile(JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, ...result }));
} catch (error) {
  const result = { ok: false, code: /^[A-Z_]+$/.test(error.code || error.message || '')
    ? error.code || error.message : 'COMPILED_PROBE_FAILED', details: error.details || {}, retryAllowed: false };
  if (output) await output.writeFile(JSON.stringify(result) + '\n');
  console.log(JSON.stringify(result)); process.exitCode = 2;
} finally {
  await output?.close(); session?.clear();
  if (Array.isArray(cookies)) cookies.forEach(c => { c.value = ''; });
  if (capture) { capture.envelope.body = ''; capture.cookieHeader = ''; }
}
