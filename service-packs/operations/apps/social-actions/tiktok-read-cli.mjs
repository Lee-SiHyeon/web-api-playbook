import { readTikTokStudioUser, readTikTokUploadProfile } from './providers/tiktok.mjs';

const operation = process.argv[2];
try {
  let result;
  if (operation === 'studio-user') result = await readTikTokStudioUser();
  else if (operation === 'upload-profile') result = await readTikTokUploadProfile();
  else throw Object.assign(new Error('TIKTOK_READ_COMMAND_INVALID'), { code: 'TIKTOK_READ_COMMAND_INVALID' });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: error?.code || 'TIKTOK_READ_FAILED' }));
  process.exitCode = 1;
}
