import { stageYoutubeProfile, readYoutubeProfile, sendYoutubeProfile, reconcileYoutubeProfile } from './youtube-profile.mjs';
import { persistYoutubeSessionFromCookies } from './lib/youtube-auth-session.mjs';
try {
  const command = process.argv[2];
  let input = {};
  if (command !== 'read') {
    let raw = '';
    for await (const chunk of process.stdin) { raw += chunk; if (Buffer.byteLength(raw) > 1000000) throw Object.assign(new Error(), { code: 'YOUTUBE_PROFILE_INPUT_LIMIT' }); }
    input = JSON.parse(raw);
  }
  let result;
  if (command === 'stage') result = await stageYoutubeProfile(input);
  else if (command === 'session') result = await persistYoutubeSessionFromCookies(input);
  else if (command === 'read') result = await readYoutubeProfile();
  else if (command === 'send') result = await sendYoutubeProfile(input);
  else if (command === 'reconcile') result = await reconcileYoutubeProfile(input);
  else throw Object.assign(new Error(), { code: 'YOUTUBE_PROFILE_COMMAND_INVALID' });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: /^YOUTUBE_[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'YOUTUBE_PROFILE_OPERATION_FAILED' }));
  process.exitCode = 1;
}
