import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { readMp4DurationFromFile } from '../src/mp4-duration.mjs';

async function scratchDirectory() {
  const base = path.join(homedir(), '.nad-scratch', 'tmp');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(base, 'mp4-duration-'));
  await chmod(directory, 0o700);
  return directory;
}

function box(type, payload) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, 4, 'ascii');
  return Buffer.concat([header, payload]);
}

function sampleMp4({ version = 0, timescale = 1000, duration = 6000 } = {}) {
  const ftypPayload = Buffer.alloc(8);
  ftypPayload.write('isom', 0, 4, 'ascii');
  const ftyp = box('ftyp', ftypPayload);
  const headerPayload = Buffer.alloc(version === 0 ? 100 : 112);
  headerPayload[0] = version;
  if (version === 0) {
    headerPayload.writeUInt32BE(timescale, 12);
    headerPayload.writeUInt32BE(duration, 16);
  } else {
    headerPayload.writeUInt32BE(timescale, 20);
    headerPayload.writeBigUInt64BE(BigInt(duration), 24);
  }
  const moov = box('moov', box('mvhd', headerPayload));
  return Buffer.concat([ftyp, moov]);
}

test('MP4 duration reader handles movie-header versions 0 and 1', async t => {
  const directory = await scratchDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const v0 = path.join(directory, 'v0.mp4');
  const v1 = path.join(directory, 'v1.mp4');
  await writeFile(v0, sampleMp4());
  await writeFile(v1, sampleMp4({ version: 1, timescale: 90_000, duration: 540_000 }));
  assert.equal(await readMp4DurationFromFile(v0), 6);
  assert.equal(await readMp4DurationFromFile(v1), 6);
});

test('MP4 duration reader rejects a file without a movie header', async t => {
  const directory = await scratchDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'invalid.mp4');
  await writeFile(file, box('ftyp', Buffer.alloc(8)));
  await assert.rejects(readMp4DurationFromFile(file), { code: 'MP4_DURATION_NOT_FOUND' });
});
