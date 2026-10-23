import {
  reconcileYoutubeVideo,
  sendYoutubeVideo,
  stageYoutubeVideo,
  stageYoutubeVideoRead,
} from './youtube-video.mjs';

const MAX_INPUT_BYTES = 1_000_000;

async function readInput() {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw) > MAX_INPUT_BYTES) {
      throw Object.assign(new Error('YOUTUBE_VIDEO_INPUT_TOO_LARGE'), {
        code: 'YOUTUBE_VIDEO_INPUT_TOO_LARGE',
      });
    }
  }
  return JSON.parse(raw);
}

try {
  const input = await readInput();
  const operation = process.argv[2];
  let result;

  if (operation === 'stage') {
    result = await stageYoutubeVideo(input);
  } else if (operation === 'send') {
    result = await sendYoutubeVideo(input);
  } else if (operation === 'stage-read') {
    result = await stageYoutubeVideoRead(input);
  } else if (operation === 'reconcile') {
    result = await reconcileYoutubeVideo(input);
  } else {
    throw Object.assign(new Error('YOUTUBE_VIDEO_COMMAND_INVALID'), {
      code: 'YOUTUBE_VIDEO_COMMAND_INVALID',
    });
  }

  console.log(JSON.stringify(result));
} catch (error) {
  const code = /^YOUTUBE_[A-Z0-9_]+$/.test(error?.code || '')
    ? error.code
    : 'YOUTUBE_VIDEO_OPERATION_FAILED';
  console.error(JSON.stringify({ ok: false, code }));
  process.exitCode = 1;
}
