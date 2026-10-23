import { readFile } from 'node:fs/promises';
import { publishThread } from '../affiliate-api-hub/scripts/sns/writers/x.mjs';
import { inspectTweet } from './x-reactions.mjs';
import { replyTextMatches } from '../affiliate-api-hub/scripts/sns/writers/x-reply-readback.mjs';
const [replyToId, messageFile, runKey] = process.argv.slice(2);
if (!/^\d{1,25}$/.test(replyToId || '') || !messageFile || !/^[a-z0-9_-]{1,100}$/.test(runKey || '')) throw new Error('X_REPLY_INPUT');
const text = (await readFile(messageFile, 'utf8')).trim();
try {
  if (runKey === 'verify') {
    const result = await inspectTweet(replyToId);
    const decodedText = result.tweet.text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const parent = process.argv[5];
    const verified = /^\d{1,25}$/.test(parent || '') && result.tweet.author === result.owner && replyTextMatches({ text: decodedText, parentId: result.tweet.replyToId }, text, parent);
    console.log(JSON.stringify({ ...result, readbackVerified: verified, writes: 0 }));
    process.exitCode = verified ? 0 : 2;
  } else {
  const result = await publishThread([text], { replyToId, runKey });
  console.log(JSON.stringify({ ...result, writes: result.ids.length, browserUsed: false }));
  if (!result.readbackVerified) process.exitCode = 2;
  }
} catch (error) { console.log(JSON.stringify({ success: false, code: /^[A-Z_]+$/.test(error.code || '') ? error.code : 'X_REPLY_FAILED' })); process.exitCode = 2; }
