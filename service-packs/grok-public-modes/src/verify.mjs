import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getPublicModes } from './public-modes.mjs';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--receipt')) throw new Error('Use --receipt FILE.');
const receipt = { version: 1, startedAt: new Date().toISOString(), scope: 'public_ui_modes',
  mode: 'pure_http', credentialsSent: false, generationRequests: 0, externalMutations: 0,
  authenticatedLibraryReplay: false, authenticatedConversationReplay: false };
try {
  const result = await getPublicModes();
  receipt.http = result.http;
  receipt.checks = { publicModeCount: result.config.modes.length,
    localePresent: typeof result.config.locale === 'string',
    defaultModePresent: typeof result.config.defaultModeId === 'string' };
  receipt.passed = true;
} catch (error) {
  receipt.passed = false;
  receipt.error = { code: typeof error.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(error.code)
    ? error.code : 'GROK_PUBLIC_MODES_FAILED', httpStatus: error.httpStatus, transportCode: error.transportCode };
}
receipt.finishedAt = new Date().toISOString();
if (args.length) {
  await mkdir(path.dirname(path.resolve(args[1])), { recursive: true });
  await writeFile(args[1], JSON.stringify(receipt, null, 2) + '\n');
}
console.log(JSON.stringify(receipt, null, 2));
if (!receipt.passed) process.exitCode = 1;
