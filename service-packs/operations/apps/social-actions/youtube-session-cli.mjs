import { youtubeSessionStatus } from './lib/youtube-auth-session.mjs';

const operation = process.argv[2];
try {
  if (operation !== 'status') throw Object.assign(new Error('YOUTUBE_SESSION_COMMAND_INVALID'), { code: 'YOUTUBE_SESSION_COMMAND_INVALID' });
  console.log(JSON.stringify(await youtubeSessionStatus()));
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: error?.code || 'YOUTUBE_SESSION_FAILED' }));
  process.exitCode = 1;
}
