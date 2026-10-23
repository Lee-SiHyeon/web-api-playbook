import { readFile, open } from "node:fs/promises";
import path from "node:path";
import { NaverEditorClient } from "./editor-client.mjs";
import { environmentSession } from "./environment-session.mjs";
import { WriteJournal } from "./write-journal.mjs";
import { fingerprint } from "../../../../packages/contracts/src/index.mjs";
import { inspectEditorModel } from "./editor-model.mjs";
import { auditPost } from './post-audit.mjs';

const options = {};
const commands = [
  "read-post",
  "inspect-editor",
  "list-drafts",
  "read-draft",
  "prepare-update",
  "update",
  "reconcile",
  "prepare-draft", "save-draft", "prepare-private-probe", "verify-private-update",
  "upload-image", "reconcile-draft",
  "session-status",
  "inspect-styles",
  "preview-update",
  "audit-post",
  "prepare-create", "create", "reconcile-create",
];
let session, outputHandle;
try {
  for (const arg of process.argv.slice(2)) {
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!match || Object.hasOwn(options, match[1])) throw Error('INPUT');
    options[match[1]] = match[2];
  }
  if (!commands.includes(options.command)) throw new Error("COMMAND_REQUIRED");
  if (Object.keys(options).some(k => !["command", "blog-id", "log-no", "output", "journal", "job", "document", "file"].includes(k)))
    throw new Error("UNKNOWN_OPTION");
  const requiresJob = ["preview-update", "prepare-update", "update", "reconcile", "save-draft", "verify-private-update", "reconcile-draft", "prepare-create", "create", "reconcile-create"].includes(
    options.command,
  );
  const job = requiresJob
    ? JSON.parse(
        (await readFile(path.resolve(options.job), "utf8")).replace(
          /^\uFEFF/,
          "",
        ),
      )
    : null;
  const document = options.command === "prepare-draft"
    ? JSON.parse((await readFile(path.resolve(options.document), "utf8")).replace(/^\uFEFF/, "")) : null;
  const blogId = job?.blogId || job?.document?.blogId || document?.blogId || options["blog-id"];
  if (
    !['read-post', 'audit-post'].includes(options.command) &&
    !(
      options.command === "reconcile" &&
      job?.publishSettings?.visibility === "public"
    )
  )
    session = environmentSession({ NAVER_COOKIE: process.env.NAVER_COOKIE });
  const client = new NaverEditorClient({
    blogId,
    session,
    journal: new WriteJournal(
      path.resolve(options.journal || ".runtime/publisher-journal"),
    ),
  });
  // Reserve receipt destination before any network mutation, after credential
  // validation. An existing output can never cause a write followed by EEXIST.
  if (options.output) outputHandle = await open(path.resolve(options.output), "wx", 0o600);
  let result;
  if (['prepare-create', 'create'].includes(options.command)) {
    const chunks = []; let size = 0, envelope;
    try {
      for await (const chunk of process.stdin) {
        size += chunk.length;
        if (size > 3 * 1024 * 1024) throw Error('INPUT_LIMIT');
        chunks.push(chunk);
      }
      envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      result = options.command === 'prepare-create' ? await client.prepareCreate(job, envelope)
        : await client.createPost(job, { envelope, baseDir: path.dirname(path.resolve(options.job)) });
    } finally { chunks.forEach(chunk => chunk.fill(0)); if (envelope) envelope.body = ''; }
  }
  if (options.command === 'reconcile-create') result = await client.reconcileCreate(job);
  if (options.command === 'session-status') result = await client.sessionStatus();
  if (options.command === 'preview-update') {
    if(job.target?.type!=='update' || job.publish===true || job.dryRun!==true) throw Error('DRY_UPDATE_REQUIRED');
    const document=job.publicationBundle.document;
    if(document.blogId!==blogId || String(document.logNo)!==String(job.target.logNo)) throw Error('SCOPE');
    const model=await client.compilePreview(job.target.logNo,document);
    const {previewEditorModel}=await import('../hybrid/editor-preview.mjs');
    result=await previewEditorModel({model,document,
      cookieHeader:session.cookieFor('https://blog.naver.com/'),baseDir:path.dirname(path.resolve(options.job))});
  }
  if (options.command === 'inspect-styles') {
    const current = await client.loadEditor(options['log-no']);
    const styles = current.model.document.components.flatMap(c =>
      [...(c.value || []), ...(c.title || [])].flatMap(p => [
        ...(p.style ? [{kind:'paragraph',style:p.style}] : []),
        ...(p.nodes || []).filter(n => n.style).map(n => ({kind:'textNode',style:n.style})),
      ]));
    result = {source:'independent_http',protectedOwnerVerified:true,
      styles:[...new Map(styles.map(s => [JSON.stringify(s),s])).values()]};
  }
  if (options.command === 'audit-post') result = await auditPost(await client.readPost(options['log-no']));
  if (options.command === "read-post")
    result = await client.readPost(options["log-no"]);
  if (options.command === "inspect-editor") {
    const current = await client.loadEditor(options["log-no"]);
    const observed = inspectEditorModel(current.model);
    result = {
      source: "independent_http",
      blogId,
      logNo: options["log-no"] || null,
      protectedOwnerVerified: true,
      document: observed,
      sourceDocumentFingerprint: fingerprint(observed),
    };
  }
  if (options.command === "list-drafts") result = await client.listDrafts();
  if (options.command === "read-draft") {
    const current = await client.readDraft(options["log-no"]);
    result = {
      source: "independent_http",
      blogId,
      logNo: options["log-no"],
      document: inspectEditorModel(current.model),
    };
  }
  if (options.command === "prepare-update")
    result = await client.prepareUpdate(job);
  if (options.command === "update")
    result = await client.updatePost(job, {
      baseDir: path.dirname(path.resolve(options.job)),
    });
  if (options.command === "reconcile")
    result = await client.reconcileUpdate(job);
  if (options.command === "reconcile-draft") result = await client.reconcileDraft(job);
  if (options.command === "prepare-draft") result = await client.prepareDraft(document);
  if (options.command === "save-draft") {
    const age = Date.now() - Date.parse(job?.checkedAt || "");
    if (job?.kind !== "independent_http_draft_preflight" || !Number.isFinite(age) || age < 0 || age > 30 * 60000)
      throw new Error("PREFLIGHT_EXPIRED");
    result = await client.saveDraft(job);
  }
  if (options.command === "prepare-private-probe") result = await client.preparePrivateProbe(options["log-no"]);
  if (options.command === "verify-private-update") result = await client.verifyPrivateUpdate(job);
  if (options.command === "upload-image") result = await client.uploadImage({
    bytes: await readFile(path.resolve(options.file)), fileName: path.basename(options.file) });
  if (outputHandle) await outputHandle.writeFile(JSON.stringify(result, null, 2) + "\n");
  // Never serialize the editor options, form, session, or raw response errors.
  console.log(
    JSON.stringify({
      ok: true,
      command: options.command,
      source: options.command === 'preview-update' ? 'native_editor_browser' : "independent_http",
      output: options.output || null,
      result: options.output
        ? {
            readbackVerified: result.readbackVerified,
            smartEditorBodyPresent: result.smartEditorBodyPresent,
            units: result.units?.length,
            passed: result.passed,
            duplicateImagePairs: result.duplicateImages?.length,
            authState: result.authState,
            logNo: result.logNo,
          }
        : result,
    }),
  );
  if (options.command === "read-post" && !result.smartEditorBodyPresent)
    process.exitCode = 2;
  if (["reconcile", "reconcile-draft"].includes(options.command) && !result.readbackVerified)
    process.exitCode = 2;
  if (options.command === 'session-status' && !result.protectedOwnerVerified) process.exitCode = 2;
  if (options.command === 'audit-post' && !result.passed) process.exitCode = 2;
} catch (error) {
  if (outputHandle) await outputHandle.writeFile(JSON.stringify({ok:false,
    code: /^[A-Z_]+$/.test(error.code || error.message || '') ? (error.code || error.message) : 'EXECUTION_FAILED'})+'\n');
  console.error(
    JSON.stringify({
      ok: false,
      code:
        error.code ||
        (/^[A-Z_]+$/.test(error.message || "")
          ? error.message
          : "EXECUTION_FAILED"),
      details: error.details || {},
    }),
  );
  process.exitCode = 2;
} finally {
  await outputHandle?.close();
  session?.clear();
}
