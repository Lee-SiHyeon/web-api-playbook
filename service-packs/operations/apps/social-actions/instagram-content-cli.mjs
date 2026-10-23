import {
  approveInstagramRestrictedComment, createInstagramComment, deleteInstagramComment,
  likeInstagramComment, readInstagramCommentReplies, readInstagramComments, unlikeInstagramComment,
} from './instagram-comments.mjs';
import { inspectInstagramMedia, publishInstagramMedia, reconcileInstagramPublish,
  resumeInstagramSidecarConfigure } from './instagram-publisher.mjs';
import { readInstagramPosts, readInstagramProfile } from './instagram-reader.mjs';

async function readInput() {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 64 * 1024) throw Object.assign(new Error(), { code: 'INSTAGRAM_INPUT_TOO_LARGE' });
  }
  if (!raw.trim()) throw Object.assign(new Error(), { code: 'INSTAGRAM_INPUT_REQUIRED' });
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error(), { code: 'INSTAGRAM_INPUT_INVALID' }); }
}

const help = `Instagram API-only content operations

  node apps/social-actions/instagram-content-cli.mjs COMMAND < request.json

Read commands: profile, posts, comments, replies
Write commands: publish, resume-configure, create-comment, delete-comment, approve-comment, like-comment, unlike-comment
Local commands: inspect-media, reconcile (owner readback only; no publish resend)

Reconcile a prior publish journal without resending:
  { "payloadHash": "64-character journal id returned by publish" }

Single-Reel publish requests require a JPEG coverFilePath. Set genAiSelfDisclosure:true only
when the content is AI-generated; that adds the captured self-disclosure fields.

resume-configure is a manual one-configure recovery for a journaled sidecar HTTP 500.
It requires a complete owner-post scan with no matching carousel and reuses the journal's uploads.
It never uploads the media again or creates a new journal idempotency key.

Writes use the current user's DPAPI protected Instagram session. Every comment mutation
requires an idempotencyKey. Publish/comment requests are journaled; uncertain writes are
not automatically repeated. Browser XHR capture and live write verification are reported
separately from first-party source-derived request contracts.
`;

const commands = new Set(['profile', 'posts', 'comments', 'replies', 'reconcile', 'inspect-media', 'publish', 'resume-configure',
  'create-comment', 'delete-comment', 'approve-comment', 'like-comment', 'unlike-comment']);

async function main() {
  const [command = 'help'] = process.argv.slice(2);
  if (['help', '--help', '-h'].includes(command)) { process.stdout.write(help); return; }
  if (!commands.has(command)) throw Object.assign(new Error(), { code: 'INSTAGRAM_COMMAND_INVALID' });
  const input = await readInput();
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error(), { code: 'INSTAGRAM_INPUT_INVALID' });
  let result;
  switch (command) {
    case 'profile': result = await readInstagramProfile(input); break;
    case 'posts': result = await readInstagramPosts(input); break;
    case 'comments': result = await readInstagramComments(input); break;
    case 'replies': result = await readInstagramCommentReplies(input); break;
    case 'inspect-media': result = await inspectInstagramMedia(input); break;
    case 'publish': result = await publishInstagramMedia(input); break;
    case 'reconcile': result = await reconcileInstagramPublish(input); break;
    case 'resume-configure': result = await resumeInstagramSidecarConfigure(input); break;
    case 'create-comment': result = await createInstagramComment(input); break;
    case 'delete-comment': result = await deleteInstagramComment(input); break;
    case 'approve-comment': result = await approveInstagramRestrictedComment(input); break;
    case 'like-comment': result = await likeInstagramComment(input); break;
    case 'unlike-comment': result = await unlikeInstagramComment(input); break;
  }
  console.log(JSON.stringify({ ok: true, ...result }));
  if (result.receipt?.readbackVerified === false || result.state === 'needs_reconciliation'
    || result.state === 'pending_reconciliation') process.exitCode = 2;
}

main().catch(error => {
  const value = error?.code || error?.message;
  const code = typeof value === 'string' && /^[A-Z0-9_]{1,96}$/.test(value) ? value : 'INSTAGRAM_OPERATION_FAILED';
  console.log(JSON.stringify({ ok: false, service: 'instagram', code }));
  process.exitCode = 2;
});
