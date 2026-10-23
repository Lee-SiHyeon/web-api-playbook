import {
  inspectThreadsPost,
  readThreadsComments,
  readThreadsEngagement,
  readThreadsFollowers,
  readThreadsProfileTimeline,
  readThreadsProfilePosts,
} from './threads-social.mjs';
import { resolveThreadsTopic, searchThreadsTopics } from './threads-topics.mjs';

const HELP = `Threads read-only social client

Commands:
  followers [--not-following-back]  Read the captured first 20 owner followers
  profile <HANDLE>                  Read initial authenticated profile posts and pin state
  profile-timeline <HANDLE> [LIMIT] Read a bounded paginated profile timeline (default 30)
  post <POST_ID> [AUTHOR]            Read one post's state and reply permission
  comments <POST_ID> [AUTHOR]        Read the first captured direct-replies response
  engagement <POST_ID>               Read captured like/repost/quote activity for one post
  topics <QUERY>                      Search Threads topics
  topic <NAME>                       Resolve topic validity and sensitivity

The client uses the protected Threads session. It never sends a mutation.
Follower/comment/post windows are partial when indicated; comments label direct roots
and nested descendants separately. Topic resolution is a read-only validation request.
`;

async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (['help', '--help', '-h'].includes(command)) {
    process.stdout.write(HELP);
    return;
  }
  let result;
  if (command === 'followers') {
    const followerFlags = args.filter(value => value === '--not-following-back');
    if (args.length !== followerFlags.length || followerFlags.length > 1) {
      throw Object.assign(new Error(), { code: 'THREADS_SOCIAL_COMMAND_INVALID' });
    }
    result = await readThreadsFollowers();
    if (followerFlags.length) {
      (await import('./follow-status-gate.mjs')).assertCompleteFollowerRead(result);
      result = {
        ...result,
        filter: 'follows_owner_and_owner_not_following',
        followers: result.followers.filter(item => item.followsOwner && !item.following && !item.outgoingRequest),
      };
    } else if (args.length) {
      throw Object.assign(new Error(), { code: 'THREADS_SOCIAL_COMMAND_INVALID' });
    }
  } else if (command === 'profile' && args.length === 1) {
    result = await readThreadsProfilePosts({ handle: args[0] });
  } else if (command === 'profile-timeline' && args.length >= 1 && args.length <= 2) {
    const limit = args[1] === undefined ? 30 : /^\d{1,3}$/.test(args[1]) ? Number(args[1]) : NaN;
    if (!Number.isSafeInteger(limit)) throw Object.assign(new Error(), { code: 'THREADS_SOCIAL_COMMAND_INVALID' });
    result = await readThreadsProfileTimeline({ handle: args[0], limit });
  } else if (command === 'post' && args.length >= 1 && args.length <= 2) {
    result = await inspectThreadsPost({ postId: args[0], ...(args[1] ? { expectedAuthor: args[1] } : {}) });
  } else if (command === 'comments' && args.length >= 1 && args.length <= 2) {
    result = await readThreadsComments(args[0], args[1] ? { expectedAuthor: args[1] } : {});
  } else if (command === 'engagement' && args.length === 1) {
    result = await readThreadsEngagement(args[0]);
  } else if (command === 'topics' && args.length >= 1) {
    result = await searchThreadsTopics(args.join(' '));
  } else if (command === 'topic' && args.length >= 1) {
    result = await resolveThreadsTopic(args.join(' '));
  } else {
    throw Object.assign(new Error(), { code: 'THREADS_SOCIAL_COMMAND_INVALID' });
  }
  process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n');
}

main().catch(error => {
  const code = /^THREADS_SOCIAL_[A-Z0-9_]+$/.test(error?.code || '')
    ? error.code
    : 'THREADS_SOCIAL_OPERATION_FAILED';
  process.stderr.write(JSON.stringify({ ok: false, code }) + '\n');
  process.exitCode = 1;
});
