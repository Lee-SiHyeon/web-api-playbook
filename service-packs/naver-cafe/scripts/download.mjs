import { writeFile } from 'node:fs/promises';
import { createStoredCafeClient } from '../lib/client.mjs';
import { downloadAttachment } from '../lib/download.mjs';

const values = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i], value = process.argv[i + 1];
  if (!['--id', '--index', '--out-dir', '--receipt'].includes(name) || !value || values.has(name)) {
    console.error(JSON.stringify({ ok: false, code: 'CAFE_DOWNLOAD_ARGUMENT_INVALID' })); process.exit(2);
  }
  values.set(name, value);
}
try {
  const client = await createStoredCafeClient();
  const result = await downloadAttachment(client, { articleId: values.get('--id') || '21',
    index: Number(values.get('--index') || '0'), outDir: values.get('--out-dir') || 'runtime/downloads' });
  if (values.has('--receipt')) await writeFile(values.get('--receipt'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(result));
} catch (error) {
  const code = /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'CAFE_DOWNLOAD_FAILED';
  console.error(JSON.stringify({ ok: false, code,
    ...(error.details?.httpStatus ? { httpStatus: error.details.httpStatus } : {}),
    ...(error.details?.redirectOrigin ? { redirectOrigin: error.details.redirectOrigin } : {}) }));
  process.exitCode = 1;
}
