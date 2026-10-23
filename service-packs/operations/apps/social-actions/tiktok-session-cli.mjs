import { captureTikTokSessionFromChrome, tiktokSessionStatus } from './lib/tiktok-auth-session.mjs';

const operation = process.argv[2];
try {
  if (operation === 'capture') console.log(JSON.stringify(await captureTikTokSessionFromChrome()));
  else if (operation === 'status') console.log(JSON.stringify(await tiktokSessionStatus()));
  else throw new Error('TIKTOK_SESSION_COMMAND_INVALID');
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: error?.code || 'TIKTOK_SESSION_FAILED' }));
  process.exitCode = 1;
}
