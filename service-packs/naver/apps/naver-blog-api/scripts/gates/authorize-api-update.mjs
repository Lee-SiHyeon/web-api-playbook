import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fingerprint } from "../../../../packages/contracts/src/index.mjs";
import {
  evaluatePublisherJobGate,
  publisherContentFingerprint,
} from "./publisher-gates.mjs";

// Records already obtained user authorization; this flag is not an authentication
// mechanism and must never be used to invent consent or verifier evidence.
const args = Object.fromEntries(
  process.argv.slice(2).map((s) => {
    const i = s.indexOf("=");
    return [s.slice(2, i), s.slice(i + 1)];
  }),
);
try {
  for (const key of ["job", "preflight", "output"])
    if (!args[key]) throw new Error("REQUIRED_INPUT_MISSING");
  if (args["approved-by"] !== "user")
    throw new Error("USER_AUTHORIZATION_REQUIRED");
  const read = async (p) =>
    JSON.parse(
      (await readFile(path.resolve(p), "utf8")).replace(/^\uFEFF/, ""),
    );
  const source = await read(args.job),
    preflight = await read(args.preflight);
  if (
    source.publish === true ||
    source.dryRun === false ||
    !['update', 'create'].includes(source.target?.type)
  )
    throw new Error("SOURCE_MUST_BE_DRY_RUN");
  if (
    preflight.kind !== (source.target.type === 'create' ? 'headless_input_http_create_preflight' : 'independent_http_update_preflight') ||
    preflight.blogId !== source.blogId ||
    (source.target.type === 'update' && preflight.logNo !== String(source.target.logNo)) ||
    preflight.publicationBundleFingerprint !==
      fingerprint(source.publicationBundle)
  )
    throw new Error("PREFLIGHT_MISMATCH");
  const now = new Date(),
    age = now.getTime() - Date.parse(preflight.checkedAt);
  if (!Number.isFinite(age) || age < 0 || age > 30 * 60000)
    throw new Error("PREFLIGHT_EXPIRED");
  const job = {
    ...source,
    jobId: `${source.jobId}-api-${Date.now()}`,
    publish: true,
    dryRun: false,
    executionMode: "independent_http",
    publicationBundleFingerprint: fingerprint(source.publicationBundle),
    preflight: {
      ...preflight,
      passed: true,
      dryRunJobId: source.jobId,
      dryRunJobFingerprint: fingerprint(source),
      dryRunResultFingerprint: fingerprint(preflight),
      dryRunGateFingerprint: fingerprint({
        kind: "compiled_exact_document",
        preflight,
      }),
    },
    authorization: {
      approved: true,
      approvedBy: "user",
      approvedAt: now.toISOString(),
      scope: "publish_once",
    },
  };
  job.authorization.contentFingerprint = publisherContentFingerprint(job);
  const gate = await evaluatePublisherJobGate(job, {
    baseDir: path.dirname(path.resolve(args.output)),
    now,
  });
  if (!gate.passed)
    throw new Error(`GATE_FAILED:${gate.failedChecks.join(",")}`);
  await writeFile(
    path.resolve(args.output),
    JSON.stringify(job, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      ok: true,
      jobId: job.jobId,
      output: path.resolve(args.output),
      gatePassed: true,
    }),
  );
} catch (e) {
  console.error(
    JSON.stringify({
      ok: false,
      code: /^[A-Z_:,a-z]+$/.test(e.message) ? e.message : "EXECUTION_FAILED",
    }),
  );
  process.exitCode = 2;
}
