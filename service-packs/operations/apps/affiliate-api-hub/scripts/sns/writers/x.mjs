import { journaledRequest, defaultJournalDir, runKeyFor, readXCreateJournalSlot } from './journal.mjs';
import { uploadVideo as uploadXVideo, uploadImage as uploadXImage } from './x-media.mjs';
import { replyTextMatches } from './x-reply-readback.mjs';
import { quoteTargetId,quoteTextMatches } from './x-quote-readback.mjs';
import { refreshCreateTweetContract } from './x-create-contract.mjs';
import { reserveXWrite, noteXWriteRejection } from './x-write-gate.mjs';
import { createBotDebugFetch, withBotDebugScope, recordProtectedBotError } from '../../../../social-actions/lib/bot-debug-log.mjs';
import { SOCIAL_REQUEST_TIMEOUTS } from '../../../../social-actions/lib/request-timeouts.mjs';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { assertXAffiliateDisclosure } from './x-affiliate-disclosure.mjs';

const X_CLIENT_URL = new URL('../../../../../../social-x/src/client.mjs', import.meta.url);
const X_AUTH_URL = new URL('../../../../../../../lib/web-auth/x.mjs', import.meta.url);
// Resolve the package from this workspace, not a sibling checkout which may not exist in CI.
const twitterText = createRequire(import.meta.url)('twitter-text');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const writeProgress = new AsyncLocalStorage();
// Keep nested publishers' progress scoped to their caller, including concurrent jobs.
export const withXWriteProgress = (hooks, task) => writeProgress.run(hooks, task);

function createTweetContract(contracts) {
  const contract = contracts?.operations?.CreateTweet;
  if (!contract?.queryId || !contract.features || typeof contract.features !== 'object') fail('NOT_IMPLEMENTED_CONTRACT_MISSING');
  return contract;
}
function createNoteTweetContract(contracts) {
  const contract = contracts?.operations?.CreateNoteTweet;
  if (!contract?.queryId || !contract.features || typeof contract.features !== 'object') fail('X_NOTE_TWEET_CONTRACT_MISSING');
  return contract;
}

// Evidence: contracts/x.json CreateTweet and docs/sns-posting-contracts/contracts.json
// confirm the operation and optional reply.in_reply_to_tweet_id variable. Media ids come from x-media.mjs (X's own
// uploader contract); the composer sends them as media_entities [{media_id, tagged_users: []}] (main.js, 2026-09-28).
function buildCreateRequest(operation, { post, replyToId, quoteUrl, contracts, mediaIds = [] }) {
  if (typeof post !== 'string' || !post.trim()) fail('X_POST_INVALID');
  if (!Array.isArray(mediaIds) || mediaIds.some(id => !/^\d{1,25}$/.test(String(id)))) fail('X_MEDIA_IDS_INVALID');
  // First-party main.46773420fb4da51aa.js, observed 2026-10-01: attachment_url:t.attachment_url.
  if(quoteUrl!==undefined&&(typeof quoteUrl!=='string'||!quoteTargetId(quoteUrl)||!quoteUrl.startsWith('https://x.com/')||replyToId||mediaIds.length))fail('X_QUOTE_INPUT_INVALID');
  const contract = operation === 'CreateNoteTweet' ? createNoteTweetContract(contracts) : createTweetContract(contracts);
  // The bundle forwards richtext_options and media_options from composer state; it confirmed no blank object shape, so leave both absent for plain text.
  const variables = {
    tweet_text: post,
    ...(quoteUrl?{attachment_url:quoteUrl}:{}),
    ...(replyToId ? { reply: { in_reply_to_tweet_id: String(replyToId), exclude_reply_user_ids: [] } } : {}),
    media: { media_entities: mediaIds.map(id => ({ media_id: String(id), tagged_users: [] })), possibly_sensitive: false },
    semantic_annotation_ids: [],
    disallowed_reply_options: null,
  };
  const payload = { variables, features: contract.features,
    ...(Object.keys(contract.fieldToggles || {}).length ? { fieldToggles: contract.fieldToggles } : {}), queryId: contract.queryId };
  return {
    method: 'POST', url: `https://x.com/i/api/graphql/${contract.queryId}/${operation}`,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  };
}
export function buildCreateTweetRequest(options) { return buildCreateRequest('CreateTweet', options); }
export function buildCreateNoteTweetRequest(options) { return buildCreateRequest('CreateNoteTweet', options); }

export async function loadXContracts() {
  const { loadContracts } = await import(X_CLIENT_URL.href);
  return loadContracts();
}

async function withDefaultClient(callback, { fetchImpl = globalThis.fetch } = {}) {
  fetchImpl=createBotDebugFetch(fetchImpl,{service:'x'});
  const [{ XClient, loadContracts }, { createXAuth }] = await Promise.all([
    import(X_CLIENT_URL.href), import(X_AUTH_URL.href),
  ]);
  const savedContracts = await loadContracts();
  const auth = createXAuth({ fetchImpl });
  return auth.withSession(async credentials => {
    const contracts = await refreshCreateTweetContract(savedContracts,credentials.fetchImpl);
    const client = new XClient({ ...credentials, contracts, fetchImpl, transactionProvider: credentials.transactionProvider,requestTimeouts:SOCIAL_REQUEST_TIMEOUTS });
    const records=new Map();
    try { return await withBotDebugScope(record=>records.set(record.id,record),()=>callback(client, contracts)); }
    catch(error){
      if(!process.env.NODE_TEST_CONTEXT) {
        const reference=await recordProtectedBotError('x',error,{operation:'publishThread',protectedDebugRecords:[...records.values()]});
        records.set(reference.id,reference);
      }
      error.protectedDebugRecords=[...records.values()].slice(-12);throw error;
    }
    finally { client.close(); }
  });
}

export function createTweetResponseShape(result,operation='CreateTweet') {
  const field=operation==='CreateNoteTweet'?'notetweet_create':'create_tweet';
  const data=result?.data,create=data?.[field],outer=create?.tweet_results?.result;
  const kind=value=>value===null?'null':Array.isArray(value)?'array':typeof value;
  const safeKeys=(value,allowed)=>Object.keys(value&&typeof value==='object'?value:{}).filter(key=>allowed.includes(key));
  return { dataType:kind(data),createType:kind(create),resultType:kind(outer),
    dataKeys:safeKeys(data,['create_tweet','notetweet_create']),createKeys:safeKeys(create,['tweet_results']),
    resultKeys:safeKeys(outer,['tweet','rest_id','legacy','__typename']),
    errorCount:Array.isArray(result?.errors)?Math.min(result.errors.length,100):0,
    type:['Tweet','TweetWithVisibilityResults','TweetTombstone','TweetUnavailable'].includes(outer?.__typename)?outer.__typename:null };
}
function postIdFrom(result,operation='CreateTweet') {
  const field=operation==='CreateNoteTweet'?'notetweet_create':'create_tweet';
  const outer = result?.data?.[field]?.tweet_results?.result;
  const id = outer?.tweet?.rest_id ?? outer?.rest_id ?? outer?.tweet?.legacy?.id_str ?? outer?.legacy?.id_str;
  if (!/^\d{1,25}$/.test(String(id ?? ''))) throw Object.assign(new Error('X_CREATE_SCHEMA'),{code:'X_CREATE_SCHEMA',receipt:{...result?.receipt,writeSent:true},detail:createTweetResponseShape(result,operation),responseSchema:createTweetResponseShape(result,operation)});
  return String(id);
}

function createOperationForPost(post, longPostAllowed) {
  const weightedLength=twitterText.parseTweet(post).weightedLength;
  if(!Number.isFinite(weightedLength))fail('X_POST_INVALID');
  if(weightedLength<=280)return 'CreateTweet';
  if(longPostAllowed!==true)fail('X_LONG_POST_NOT_ALLOWED');
  return 'CreateNoteTweet';
}
function fullReadbackText(item) {
  return item?.text ?? item?.note_tweet?.note_tweet_results?.result?.text
    ?? item?.tweet?.note_tweet?.note_tweet_results?.result?.text;
}

function runScope(options) {
  const runKey = options.runKey || (options.runDir && runKeyFor(options.runDir));
  if (!runKey) fail('SNS_RUN_KEY_REQUIRED');
  return { channel: 'x', runKey, journalDir: options.journalDir || undefined };
}

export async function publishThread(posts, options = {}) {
  if (!Array.isArray(posts) || posts.length < 1 || posts.some(post => typeof post !== 'string' || !post.trim())) fail('X_POSTS_INVALID');
  assertXAffiliateDisclosure(posts, options);
  const operations=posts.map(post=>createOperationForPost(post,options.longPostAllowed));
  if(options.quoteUrl!==undefined&&(typeof options.quoteUrl!=='string'||!quoteTargetId(options.quoteUrl)||!options.quoteUrl.startsWith('https://x.com/')||posts.length!==1||options.replyToId||options.videoFile||options.images?.length))fail('X_QUOTE_INPUT_INVALID');
  if (options.media?.length) fail('NOT_IMPLEMENTED_CONTRACT_MISSING');
  if (options.images !== undefined && (!Array.isArray(options.images) || options.images.length > 4)) fail('X_IMAGES_INVALID');
  if (options.images?.length && options.videoFile) fail('X_MEDIA_COMBINATION_UNVERIFIED');
  if (options.videoFile != null && (typeof options.videoFile !== 'string' || !options.videoFile.trim())) fail('X_VIDEO_FILE_INVALID');
  // `videoFile` or `images` attach first-party uploaded media to the root post.
  if (options.videoFile && options.mediaIds?.[0]?.length) fail('X_MEDIA_COMBINATION_UNVERIFIED');
  // options.mediaIds: {<post index>: [uploaded media id, …]} for already-uploaded, verified media.
  if (options.mediaIds && Object.values(options.mediaIds).some(v => !Array.isArray(v) || v.some(id => !/^\d+$/.test(String(id))))) fail('X_MEDIA_IDS_INVALID');
  const scope = runScope(options);
  if (!options.client) {
    // Posts count toward the account's tweet limit: wait for the shared gate before taking the session.
    // Callers that already reserved pass `writeGate: null`.
    const writeGate = options.writeGate === undefined ? (process.env.NODE_TEST_CONTEXT ? null : reserveXWrite) : options.writeGate;
    const progress = writeProgress.getStore();
    if (writeGate) for (const operation of operations) await writeGate({ operation,
      isStopped: options.isStopped ?? progress?.isStopped,
      onWait: options.onWait ?? progress?.onWait, onReady: options.onReady ?? progress?.onReady });
    return withDefaultClient((client, contracts) => publishThread(posts, { ...options, client, contracts }), options);
  }
  const contracts = options.contracts;
  createTweetContract(contracts);
  if(operations.includes('CreateNoteTweet'))createNoteTweetContract(contracts);
  let uploadedVideoId = null;
  const uploadedImageIds = [];
  if (options.videoFile) {
    const upload = options.uploadVideo || uploadXVideo;
    const result = await upload(options.videoFile, {
      runKey: scope.runKey,
      journalDir: scope.journalDir || defaultJournalDir(),
    });
    if (!/^\d{1,25}$/.test(String(result?.mediaId ?? '')) || result?.processed !== true) fail('X_VIDEO_UPLOAD_UNVERIFIED');
    uploadedVideoId = String(result.mediaId);
  }
  if (options.images?.length) {
    const upload = options.uploadImage || uploadXImage;
    for (const image of options.images) {
      const result = await upload(image, {
        runKey: scope.runKey,
        journalDir: scope.journalDir || defaultJournalDir(),
      });
      if (!/^\d{1,25}$/.test(String(result?.mediaId ?? '')) || result?.processed !== true) fail('X_IMAGE_UPLOAD_UNVERIFIED');
      uploadedImageIds.push(String(result.mediaId));
    }
  }
  const ids = [];
  const readbacks = [];
  for (const [index, post] of posts.entries()) {
    // options.replyToId attaches the first post under an existing post (the affiliate reply after a published chain).
    const replyToId = index ? ids[index - 1] : options.replyToId;
    const mediaIds = [...(options.mediaIds?.[index] ?? []), ...(index === 0 && uploadedVideoId ? [uploadedVideoId] : []),
      ...(index === 0 ? uploadedImageIds : [])];
    const operation=operations[index];
    const builder=operation==='CreateNoteTweet'?buildCreateNoteTweetRequest:buildCreateTweetRequest;
    const plan = builder({ post, ...(replyToId ? { replyToId } : {}), ...(options.quoteUrl?{quoteUrl:options.quoteUrl}:{}), contracts, mediaIds });
    const variables = JSON.parse(plan.body).variables;
    const slot=await readXCreateJournalSlot({runKey:scope.runKey,index,journalDir:scope.journalDir});
    if(slot&&(!slot.resolved||!slot.postId))fail('SNS_JOURNAL_RECONCILIATION_REQUIRED');
    if(slot?.postIdentity&&(slot.postIdentity.parentId!==String(replyToId||'')&&!(slot.postIdentity.parentId===null&&!replyToId)
      ||slot.postIdentity.contentSha256!==createHash('sha256').update(post).digest('hex')))fail('SNS_JOURNAL_RECONCILIATION_REQUIRED');
    let id=slot?.postId;
    if(!id){
      const {response:result,checkpoint} = await journaledRequest({ ...scope, request: plan, send: async () => {
        try { return await options.client.request(operation, variables); }
        catch (error) {
          // 344/226/185/88 in a 200 body: pause every X bot's counted writes.
          if (!process.env.NODE_TEST_CONTEXT && Array.isArray(error?.receipt?.serviceErrorCodes)) await noteXWriteRejection(error.receipt.serviceErrorCodes).catch(() => null);
          throw error;
        }
      },returnJournal:true });
      id=postIdFrom(result,operation);await checkpoint({kind:'x_post_created',postId:id});
    }
    ids.push(id);
    try {
      const detail = await options.client.conversation(id);
      const item = detail?.focal;
      const comparableItem=typeof item?.text==='string'?item:{...item,text:fullReadbackText(item)};
      // A post with media ends with its t.co media link in the returned text.
      const textVerified = item?.id === id && (options.quoteUrl
        ? quoteTextMatches(comparableItem,post,options.quoteUrl)
        : replyTextMatches(comparableItem, post, replyToId) || mediaIds.length > 0 && !replyToId && String(comparableItem?.text ?? '').startsWith(post));
      const mediaVerified = mediaIds.length === 0 || mediaIds.every(mediaId =>
        Array.isArray(item?.media) && item.media.some(media => String(media?.id ?? '') === String(mediaId)));
      const verified = textVerified && mediaVerified;
      readbacks.push({ id, verified, ...(mediaIds.length ? { mediaVerified } : {}),
        ...(verified ? {} : { reason: !textVerified ? 'X_READBACK_MISMATCH' : 'X_MEDIA_READBACK_MISMATCH' }) });
    } catch (error) {
      readbacks.push({ id, verified: false, reason: error?.code || 'X_READBACK_FAILED' });
    }
    if(slot&&readbacks.at(-1)?.verified!==true)fail('SNS_JOURNAL_RECONCILIATION_REQUIRED');
  }
  return { ids, permalinks: ids.map(id => `https://x.com/i/status/${id}`), readbackVerified: readbacks.every(item => item.verified), readbacks };
}

// Preserve the complete reviewed post.txt, including its disclosure prefix.
// Validate the main and planned reply together before the first side effect.
export async function publishAffiliateVideoFromFile(postFile, affiliateReply, options = {}) {
  if (typeof affiliateReply !== 'string' || !affiliateReply.trim()) fail('X_AFFILIATE_REPLY_REQUIRED');
  const mainText = (await readFile(postFile, 'utf8')).trim();
  assertXAffiliateDisclosure([mainText], { affiliateReply });
  const main = await publishThread([mainText], { ...options, affiliateReply });
  if (!main.readbackVerified) fail('X_MAIN_READBACK_REQUIRED');
  const reply = await publishThread([affiliateReply], { ...options, videoFile: undefined,
    mediaIds: undefined, images: undefined, affiliateReply: undefined,
    runKey: `${runScope(options).runKey}-affiliate`, replyToId: main.ids[0], mainText });
  return { main, affiliateReply: reply, readbackVerified: main.readbackVerified && reply.readbackVerified };
}
