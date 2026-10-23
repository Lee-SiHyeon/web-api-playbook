import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { downloadValidatedFile } from '../src/file-download.mjs';

const TEMP_ROOT = process.env.TMPDIR || '/home/worker/.nad-scratch/tmp';

test('CSV download is bounded, validates UTF-8, writes atomically, and returns a byte digest', async () => {
  await mkdir(TEMP_ROOT, { recursive: true });
  const directory = await mkdtemp(path.join(TEMP_ROOT, 'grok-csv-download-'));
  try {
    const body = Buffer.from('label,value\nneutral,14\n', 'utf8');
    const result = await downloadValidatedFile(new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/csv', 'content-length': String(body.length) },
    }), { outputDir: directory, suggestedName: 'task.csv', allowedMimeTypes: ['text/csv'], maxBytes: 1024 });
    const written = await readFile(result.path);
    assert.equal(result.bytes, body.length);
    assert.equal(result.mimeType, 'text/csv');
    assert.equal(result.magicVerified, false);
    assert.equal(result.textEncodingVerified, true);
    assert.equal(result.sha256, createHash('sha256').update(body).digest('hex'));
    assert.deepEqual(written, body);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('ZIP download requires its source-declared MIME and local-file magic', async () => {
  await mkdir(TEMP_ROOT, { recursive: true });
  const directory = await mkdtemp(path.join(TEMP_ROOT, 'grok-zip-download-'));
  try {
    const body = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
    const result = await downloadValidatedFile(new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/zip', 'content-length': String(body.length) },
    }), { outputDir: directory, suggestedName: 'task', allowedMimeTypes: ['application/zip'], maxBytes: 1024 });
    assert.equal(result.magicVerified, true);
    assert.deepEqual(await readFile(result.path), body);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('file download rejects bad content magic, non-CSV bytes, and size overrun', async () => {
  await mkdir(TEMP_ROOT, { recursive: true });
  const directory = await mkdtemp(path.join(TEMP_ROOT, 'grok-invalid-file-'));
  try {
    await assert.rejects(downloadValidatedFile(new Response(Buffer.from('not a zip'), {
      status: 200, headers: { 'content-type': 'application/zip' },
    }), { outputDir: directory, allowedMimeTypes: ['application/zip'], maxBytes: 1024 }),
    { code: 'FILE_SIGNATURE_MISMATCH' });
    await assert.rejects(downloadValidatedFile(new Response(Buffer.from([0xff, 0x00, 0xff]), {
      status: 200, headers: { 'content-type': 'text/csv' },
    }), { outputDir: directory, allowedMimeTypes: ['text/csv'], maxBytes: 1024 }),
    { code: 'FILE_TEXT_ENCODING_INVALID' });
    await assert.rejects(downloadValidatedFile(new Response(Buffer.from('a,b\n1,2\n'), {
      status: 200, headers: { 'content-type': 'text/csv' },
    }), { outputDir: directory, allowedMimeTypes: ['text/csv'], maxBytes: 3 }),
    { code: 'FILE_SIZE_LIMIT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
