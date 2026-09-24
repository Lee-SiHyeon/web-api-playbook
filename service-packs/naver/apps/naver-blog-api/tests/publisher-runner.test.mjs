import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { publicationFixture } from "./support/publication-fixture.mjs";
import { evaluatePublisherJobGate } from "../scripts/gates/publisher-gates.mjs";
const exec = promisify(execFile);
const script = (name) =>
  fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
const save = (file, data) => writeFile(file, JSON.stringify(data));
async function directory(t) {
  const d = await mkdtemp(path.join(os.tmpdir(), "naver-runner-test-"));
  t.after(() => rm(d, { recursive: true, force: true }));
  return d;
}

test("normal API process fails closed when credentials are not propagated", async (t) => {
  const d = await directory(t);
  const output = path.join(d, "observation.json");
  const env = { ...process.env };
  delete env.NAVER_COOKIE;
  await assert.rejects(
    exec(
      process.execPath,
      [
        script("api/publisher-cli.mjs"),
        "--command=inspect-editor",
        "--blog-id=fixtureblog",
        "--log-no=123456789",
        `--output=${output}`,
      ],
      { env, windowsHide: true },
    ),
    (e) => e.code === 2 && JSON.parse(e.stderr.trim()).code === "AUTH_MISSING",
  );
  await assert.rejects(readFile(output), { code: "ENOENT" });
});

test('an existing receipt aborts the runner before it can contact the network',async t=>{
  const d=await directory(t),output=path.join(d,'existing.json');
  await writeFile(output,'{"preserved":true}');
  await assert.rejects(exec(process.execPath,[script('api/publisher-cli.mjs'),'--command=upload-image',
    '--blog-id=syntheticblog','--file=does-not-exist.png',`--output=${output}`],
    {env:{SystemRoot:process.env.SystemRoot,NAVER_COOKIE:'NID_AUT=synthetic-aut; NID_SES=synthetic-ses'},windowsHide:true}),
    e=>e.code===2&&JSON.parse(e.stderr.trim()).code==='EEXIST');
  assert.equal(await readFile(output,'utf8'),'{"preserved":true}');
});
test("API authorization CLI binds reviewed bundle and real preflight before accepting a job", async (t) => {
  const d = await directory(t),
    job = await publicationFixture(d, new Date());
  job.publish = false;
  job.dryRun = true;
  delete job.authorization;
  const preflight = {
    ...job.preflight,
    blogId: job.blogId,
    logNo: String(job.target.logNo),
  };
  await save(path.join(d, "job.json"), job);
  await save(path.join(d, "preflight.json"), preflight);
  const args = [
    script("gates/authorize-api-update.mjs"),
    `--job=${path.join(d, "job.json")}`,
    `--preflight=${path.join(d, "preflight.json")}`,
    `--output=${path.join(d, "approved.json")}`,
    "--approved-by=user",
  ];
  const result = await exec(process.execPath, args, { windowsHide: true });
  assert.equal(JSON.parse(result.stdout).gatePassed, true);
  const approved = JSON.parse(
    await readFile(path.join(d, "approved.json"), "utf8"),
  );
  assert.equal(approved.executionMode, "independent_http");
  assert.equal(
    (await evaluatePublisherJobGate(approved, { baseDir: d })).passed,
    true,
  );
  job.publicationBundle.document.blocks[3].text += " 검수 후 변경";
  await save(path.join(d, "job.json"), job);
  args[3] = `--output=${path.join(d, "rejected.json")}`;
  await assert.rejects(
    exec(process.execPath, args, { windowsHide: true }),
    (e) => e.code === 2 && e.stderr.includes("PREFLIGHT_MISMATCH"),
  );
});
test("legacy HTTP server cannot publish even a job labelled independent_http", async (t) => {
  const d = await directory(t),
    job = await publicationFixture(d, new Date());
  const jobPath = path.join(d, "job.json");
  await save(jobPath, job);
  const child = spawn(
    process.execPath,
    [
      script("naver-publisher-server.mjs"),
      `--job=${jobPath}`,
      `--result=${path.join(d, "result.json")}`,
      "--port=0",
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  });
  const endpoint = await new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(
      () => reject(new Error("SERVER_START_TIMEOUT")),
      5000,
    );
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const line = out.split("\n").find((v) => v.includes('"listening"'));
      if (line) {
        clearTimeout(timer);
        resolve(JSON.parse(line).listening);
      }
    });
  });
  const get = await fetch(endpoint + "/job");
  assert.equal(get.status, 410);
  assert.equal((await get.json()).error, "browser_publishing_retired");
  const post = await fetch(endpoint + "/result", {
    method: "POST",
    body: JSON.stringify({
      jobId: job.jobId,
      ok: true,
      mode: "publish",
      data: { published: true },
    }),
  });
  assert.equal(post.status, 410);
  await assert.rejects(readFile(path.join(d, "result.json")), {
    code: "ENOENT",
  });
});
