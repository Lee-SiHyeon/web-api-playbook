import { readFile, open } from 'node:fs/promises';
import path from 'node:path';
import { authorizedSession } from './authorized-session.mjs';
import { environmentSession } from '../../scripts/api/environment-session.mjs';
import { NaverEditorClient } from '../../scripts/api/editor-client.mjs';
import { inspectEditorModel } from '../../scripts/api/editor-model.mjs';
import { WriteJournal } from '../../scripts/api/write-journal.mjs';
import { REVIEWED_REPAIR, reviewedRepairDocument } from '../../scripts/api/reviewed-structure-repair.mjs';

// Completed repair: keep read-only preflight diagnostics, reject apply before
// authentication, browser handoff, file creation or any network request.
let handoff, session, output;
try {
  const options = {};
  for (const arg of process.argv.slice(2)) {
    const match = /^--(mode|from-chrome|journal|backup|output)=(.+)$/.exec(arg);
    if (!match || Object.hasOwn(options, match[1])) throw Error('INPUT');
    options[match[1]] = match[2];
  }
  if (options.mode === 'apply') throw Error('REVIEWED_REPAIR_RETIRED_USE_PUBLICATION_GATE');
  if (options.mode !== 'preflight' || !options.journal || !options.backup || !options.output ||
      ![undefined, 'true', 'false'].includes(options['from-chrome'])) throw Error('INPUT');
  handoff = await authorizedSession({ fromChrome: options['from-chrome'] === 'true', timeoutMs: 30000 });
  session = environmentSession({ NAVER_COOKIE: handoff.cookieFor('https://blog.naver.com/') });
  handoff.clear(); handoff = null;
  const client = new NaverEditorClient({ blogId: REVIEWED_REPAIR.blogId, session,
    journal: new WriteJournal(path.resolve(options.journal)) });
  const context = await client.loadEditor(REVIEWED_REPAIR.logNo);
  const original = inspectEditorModel(context.model);
  reviewedRepairDocument(original);
  const publicSource = await client.readPost(REVIEWED_REPAIR.logNo);
  reviewedRepairDocument(publicSource);
  const backup = path.resolve(options.backup);
  let backupHandle;
  try {
    backupHandle = await open(backup, 'wx', 0o600);
    await backupHandle.writeFile(JSON.stringify({ schemaVersion: 1, blogId: REVIEWED_REPAIR.blogId,
      logNo: REVIEWED_REPAIR.logNo, checkedAt: new Date().toISOString(),
      title: publicSource.title, units: publicSource.units }, null, 2));
    await backupHandle.sync();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    reviewedRepairDocument(JSON.parse(await readFile(backup, 'utf8')));
  } finally { await backupHandle?.close(); }
  output = await open(path.resolve(options.output), 'wx', 0o600);
  const result = { ok: true, readOnly: true, repairId: REVIEWED_REPAIR.id, protectedOwnerVerified: true,
      sourceFingerprint: REVIEWED_REPAIR.sourceFingerprint, beforeUnits: 96, afterUnits: 86,
      beforeImages: 18, afterImages: 13, publiclyApplied: false };
  await output.writeFile(JSON.stringify({ ...result, checkedAt: new Date().toISOString() }, null, 2));
  await output.sync();
  console.log(JSON.stringify(result));
} catch (error) {
  const code = error.code || error.message;
  console.error(JSON.stringify({ ok: false, code: /^[A-Z_]+$/.test(code || '') ? code : 'REPAIR_RUNNER_FAILED',
    retryAllowed: false, ...(error.details?.readbackRequired ? { readbackRequired: true } : {}) }));
  process.exitCode = 2;
} finally { await output?.close(); session?.clear(); handoff?.clear(); }
