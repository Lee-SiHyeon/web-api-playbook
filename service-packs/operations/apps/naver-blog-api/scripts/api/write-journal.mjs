import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fingerprint } from "../../../../packages/contracts/src/index.mjs";

// The fs-exclusive reservation survives process restarts. An uncertain attempt
// can be reconciled by a read, but never silently resubmitted, even with a new jobId.
export class WriteJournal {
  constructor(directory) {
    this.directory = path.resolve(directory);
  }
  key(operation, target, content) {
    return fingerprint({ operation, target, content });
  }
  async read(key) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("INVALID_JOURNAL_KEY");
    return JSON.parse(await readFile(path.join(this.directory, `${key}.json`), "utf8"));
  }
  async reserve(key, record) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("INVALID_JOURNAL_KEY");
    await mkdir(this.directory, { recursive: true });
    let handle;
    try {
      handle = await open(
        path.join(this.directory, `${key}.json`),
        "wx",
        0o600,
      );
    } catch (e) {
      if (e.code === "EEXIST")
        throw new Error("WRITE_ALREADY_ATTEMPTED_READBACK_REQUIRED");
      throw e;
    }
    try {
      await handle.writeFile(
        JSON.stringify({
          ...record,
          state: "submitted_unknown",
          checkedAt: new Date().toISOString(),
        }),
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  async finish(key, state, receipt = {}) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("INVALID_JOURNAL_KEY");
    const file = path.join(this.directory, `${key}.json`);
    const prior = JSON.parse(await readFile(file, "utf8"));
    const tmp = file + ".next";
    await writeFile(
      tmp,
      JSON.stringify({
        ...prior,
        state,
        receipt,
        checkedAt: new Date().toISOString(),
      }),
      { flag: "wx", mode: 0o600 },
    );
    await rename(tmp, file);
  }
}
