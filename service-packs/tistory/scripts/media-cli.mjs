import path from 'node:path';
import { uploadImage, uploadVideoAttachment, safeMediaError } from '../lib/media.mjs';

function parseArgs(args) {
  let file;
  let journal;
  let kind = 'image';
  let kindSeen = false;
  for (const arg of args) {
    if (arg.startsWith('--file=') && file === undefined) file = arg.slice(7);
    else if (arg.startsWith('--journal=') && journal === undefined) journal = arg.slice(10);
    else if (arg.startsWith('--kind=') && !kindSeen) {
      kind = arg.slice(7);
      kindSeen = true;
      if (!['image', 'video-attachment'].includes(kind)) {
        throw Object.assign(new Error(), { code: 'TISTORY_MEDIA_ARGUMENTS_INVALID' });
      }
    }
    else throw Object.assign(new Error(), { code: 'TISTORY_MEDIA_ARGUMENTS_INVALID' });
  }
  if (!file || !journal || !path.isAbsolute(file) || !path.isAbsolute(journal)) {
    throw Object.assign(new Error(), { code: 'TISTORY_MEDIA_ARGUMENTS_INVALID' });
  }
  return { file, journal, kind };
}

async function main() {
  const { file, journal, kind } = parseArgs(process.argv.slice(2));
  const upload = kind === 'video-attachment' ? uploadVideoAttachment : uploadImage;
  const receipt = await upload(file, { journalPath: journal });
  console.log(JSON.stringify(receipt, null, 2));
  if (!receipt.ok) process.exitCode = 1;
}

main().catch(error => {
  console.error(JSON.stringify({ ok: false, code: safeMediaError(error?.code) }));
  process.exitCode = 1;
});
