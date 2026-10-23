import { mkdir, open, readdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const CHANNELS = new Set(['threads', 'instagram', 'x']);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const line = value => `${JSON.stringify(value)}\n`;

export function defaultJournalDir(env = process.env) {
  const root = env.LOCALAPPDATA;
  if (!root) fail('SNS_JOURNAL_ROOT_MISSING');
  return path.join(root, 'affiliate-content-operations', 'sns', 'journal');
}

export function runKeyFor(runDir) {
  return createHash('sha256').update(path.resolve(runDir)).digest('hex').slice(0, 20);
}

function validateScope(channel, runKey) {
  if (!CHANNELS.has(channel)) fail('SNS_CHANNEL_INVALID');
  if (typeof runKey !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(runKey)) fail('SNS_RUN_KEY_INVALID');
}

function isThreadsCreateIntent(intent) {
  if (intent?.channel !== 'threads' || intent.request?.method !== 'POST') return false;
  try {
    const url = new URL(intent.request.url);
    // Official Graph API publish (threads-graph.mjs) is the same public create, so it needs the same checkpoint.
    if (url.origin === 'https://graph.threads.net') return /^\/v1\.0\/me\/threads_publish$/.test(url.pathname);
    return url.origin === 'https://www.threads.com'
      && /^\/api\/v1\/media\/configure_(?:text_only_post|text_post_app_(?:feed|sidecar))\/$/.test(url.pathname);
  } catch { return false; }
}

function hasThreadsCreateCheckpoint(events) {
  return events.some(event => event.type === 'checkpoint' && event.checkpoint?.kind === 'threads_post_created');
}

function requestResolved(events, intent) {
  if (isXCreateIntent(intent)) return hasXCreateCheckpoint(events)
    ||events.some(event=>xPositiveReconciliationForIntent(event,intent));
  if (events.some(event => event.type === 'reconciled')) return true;
  if (!events.some(event => event.type === 'result')) return false;
  // HTTP headers alone do not prove that a Threads configure response was
  // decoded into a created post ID. Keep that write locked until readback or
  // explicit reconciliation resolves it.
  if (isThreadsCreateIntent(intent)) return hasThreadsCreateCheckpoint(events);
  return true;
}

function isXCreateIntent(intent) {
  if(intent?.channel!=='x'||intent.request?.method!=='POST')return false;
  try {const url=new URL(intent.request.url);return ['https://x.com','https://api.x.com'].includes(url.origin)&&/\/graphql\/[^/]+\/(?:CreateTweet|CreateNoteTweet)$/.test(url.pathname);}catch{return false;}
}
function hasXCreateCheckpoint(events) {return events.some(e=>e.type==='checkpoint'&&e.checkpoint?.kind==='x_post_created');}
function xPositiveReconciliation(event){
  return event.type==='reconciled'&&event.outcome==='created_found_by_owner_readback'&&event.readbackVerified===true
    &&/^\d{1,25}$/.test(event.postId||'')&&/^\d{1,25}$/.test(event.parentId||'')
    &&/^\d{1,25}$/.test(event.ownerId||'')&&/^[a-f0-9]{64}$/.test(event.contentSha256||'');
}
function xPositiveReconciliationForIntent(event,intent){
  const identity=intent?.request?.postIdentity;
  return xPositiveReconciliation(event)&&identity
    &&event.channel===intent.channel&&event.runKey===intent.runKey&&event.sequence===intent.sequence
    &&Number.isFinite(Date.parse(event.at))&&Date.parse(event.at)>=Date.parse(intent.at)
    &&event.parentId===identity.parentId&&event.contentSha256===identity.contentSha256;
}
// Compatibility export for historical callers. Timeline absence, even with a
// caller-supplied "complete" flag, never proves that a dispatched create failed.
export function xNegativeReconciliation(){ return false; }

function normalizeCheckpoint(channel, value) {
  if(channel==='x'&&value?.kind==='x_post_created'&&/^\d{1,25}$/.test(String(value.postId??'')))return {kind:'x_post_created',postId:String(value.postId)};
  if (channel !== 'threads' || value?.kind !== 'threads_post_created'
    || !/^\d{10,25}$/.test(String(value.postId ?? ''))) fail('SNS_CHECKPOINT_INVALID');
  let permalink;
  if (value.permalink !== undefined && value.permalink !== null) {
    let url;
    try { url = new URL(value.permalink); } catch { fail('SNS_CHECKPOINT_INVALID'); }
    if (url.origin !== 'https://www.threads.com' || !/^\/@[A-Za-z0-9_.]{1,30}\/post\/[A-Za-z0-9_-]{5,30}\/?$/.test(url.pathname)
      || url.search || url.hash) fail('SNS_CHECKPOINT_INVALID');
    permalink = url.href;
  }
  return { kind: 'threads_post_created', postId: String(value.postId), ...(permalink ? { permalink } : {}) };
}

function requestSummary(request) {
  let url;
  try {
    const parsed = new URL(request.url);
    let requestPath = parsed.pathname;
    // Upload entity names carry per-transfer IDs. Keep the route evidence while
    // omitting the generated media ID from the persistent journal.
    requestPath = requestPath.replace(/^(\/rupload_ig(?:photo|video)\/)[^/]+/i, '$1[entity]');
    url = `${parsed.origin}${requestPath}`;
  } catch {
    fail('SNS_REQUEST_URL_INVALID');
  }
  const body = request.body;
  const bodyBytes = Buffer.isBuffer(body) || body instanceof Uint8Array
    ? Buffer.from(body)
    : Buffer.from(body instanceof URLSearchParams ? body.toString() : typeof body === 'string' ? body : JSON.stringify(body ?? null));
  let postIdentity;
  if(isXCreateIntent({channel:'x',request})){
    try{const variables=JSON.parse(bodyBytes).variables;
      if(typeof variables?.tweet_text==='string')postIdentity={contentSha256:createHash('sha256').update(variables.tweet_text).digest('hex'),
        parentId:String(variables.reply?.in_reply_to_tweet_id||'')||null};
    }catch{}
  }
  return {
    method: String(request.method || 'GET').toUpperCase(),
    url,
    bodyBytes: bodyBytes.length,
    bodySha256: createHash('sha256').update(bodyBytes).digest('hex'),
    ...(typeof request.assetSha256 === 'string' && /^[a-f0-9]{64}$/.test(request.assetSha256)
      ? { assetSha256: request.assetSha256 } : {}),
    ...(postIdentity?{postIdentity}:{}),
  };
}

async function eventsFor(file) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const events = [];
  for (const row of text.split('\n')) {
    if (!row) continue;
    try { events.push(JSON.parse(row)); } catch { fail('SNS_JOURNAL_CORRUPT'); }
  }
  return events;
}

async function existingFiles(journalDir, channel, runKey) {
  let names;
  try { names = await readdir(journalDir); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const prefix = `${channel}.${runKey}.`;
  return names.filter(name => name.startsWith(prefix) && name.endsWith('.jsonl')).sort()
    .map(name => path.join(journalDir, name));
}

// A chain may contain several creates, but one caller run must never restart
// from post zero after a checkpoint or successful upload. This reservation is
// kept for reconciliation; a new authorized chain needs its own stable run key.
function directGraphRejection(events, intent) {
  if (!isThreadsCreateIntent(intent) || hasThreadsCreateCheckpoint(events)
    || !intent.request.url.startsWith('https://graph.threads.net/')
    || events.some(event => event.type === 'reconciled' && event.outcome === 'created_found_by_owner_readback')) return false;
  const digest = createHash('sha256').update(JSON.stringify(intent.request)).digest('hex');
  return events.some(event => event.type === 'provider_rejected' && event.origin === 'https://graph.threads.net'
    && Number.isInteger(event.httpStatus) && event.httpStatus >= 400 && event.httpStatus < 500
    && Number.isSafeInteger(event.providerCode) && event.providerCode >= 0 && event.requestSha256 === digest);
}

export async function recordThreadsGraphRejection({ file, httpStatus, providerCode }) {
  const events = await eventsFor(file), intent = events.find(event => event.type === 'intent');
  if (!isThreadsCreateIntent(intent) || !intent.request.url.startsWith('https://graph.threads.net/')
    || hasThreadsCreateCheckpoint(events) || !Number.isInteger(httpStatus) || httpStatus < 400 || httpStatus >= 500
    || !Number.isSafeInteger(providerCode) || providerCode < 0) fail('SNS_GRAPH_REJECTION_INVALID');
  const handle = await open(file, 'a');
  try {
    await handle.writeFile(line({ type: 'provider_rejected', origin: 'https://graph.threads.net', httpStatus, providerCode,
      requestSha256: createHash('sha256').update(JSON.stringify(intent.request)).digest('hex'), at: new Date().toISOString() }));
    await handle.sync();
  } finally { await handle.close(); }
}

export async function reserveThreadsChain({ runKey, journalDir = defaultJournalDir() }) {
  validateScope('threads', runKey);
  for (const file of await existingFiles(journalDir, 'threads', runKey)) {
    const events = await eventsFor(file);
    if (events.some(event => event.type === 'intent' && isThreadsCreateIntent(event) && !directGraphRejection(events, event))) {
      fail('SNS_JOURNAL_RECONCILIATION_REQUIRED');
    }
  }
  await mkdir(journalDir, { recursive: true });
  const file = path.join(journalDir, 'threads.' + runKey + '.chain-once');
  const contents = line({ version: 1, channel: 'threads', runKey, nonce: randomUUID(), reservedAt: new Date().toISOString() });
  let handle;
  try {
    handle = await open(file, 'wx', 0o600);
    await handle.writeFile(contents);
    await handle.sync();
  } catch (error) {
    if (error.code === 'EEXIST') fail('SNS_JOURNAL_RECONCILIATION_REQUIRED');
    throw error;
  } finally { await handle?.close(); }
  let released = false;
  return { async releaseAfterProviderRejection() {
    if (released || await readFile(file, 'utf8') !== contents) fail('SNS_CHAIN_RESERVATION_CHANGED');
    released = true;
    await unlink(file);
  } };
}

export async function unresolvedJournalFiles({ channel, runKey, journalDir = defaultJournalDir() }) {
  validateScope(channel, runKey);
  const unresolved = [];
  for (const file of await existingFiles(journalDir, channel, runKey)) {
    const events = await eventsFor(file);
    const intent = events.find(event => event.type === 'intent');
    if (intent && !requestResolved(events, intent)) unresolved.push(file);
  }
  return unresolved;
}
export async function readXCreateJournalSlots({runKey,journalDir=defaultJournalDir()}){
  validateScope('x',runKey);
  const slots=[];
  for(const file of await existingFiles(journalDir,'x',runKey)){
    const events=await eventsFor(file),intent=events.find(event=>event.type==='intent');
    if(!isXCreateIntent(intent))continue;
    const checkpoint=events.find(event=>event.type==='checkpoint'&&event.checkpoint?.kind==='x_post_created');
    const reconciled=events.find(event=>xPositiveReconciliationForIntent(event,intent));
    slots.push({file,intent,resolved:requestResolved(events,intent),postId:checkpoint?.checkpoint.postId||reconciled?.postId||null,
      reconciliation:reconciled||null,
      postIdentity:intent.request.postIdentity||(reconciled?{contentSha256:reconciled.contentSha256,parentId:reconciled.parentId}:null)});
  }
  return slots;
}
export async function readXCreateJournalSlot({runKey,index=0,journalDir=defaultJournalDir()}){
  if(!Number.isSafeInteger(index)||index<0||index>100)fail('SNS_JOURNAL_SLOT_INVALID');
  return (await readXCreateJournalSlots({runKey,journalDir}))[index]||null;
}

export async function beginJournalIntent({ channel, runKey, journalDir = defaultJournalDir(), request, now = () => new Date().toISOString() }) {
  validateScope(channel, runKey);
  if (!request || typeof request.url !== 'string' || !request.method) fail('SNS_REQUEST_INVALID');
  await mkdir(journalDir, { recursive: true });
  const files = await existingFiles(journalDir, channel, runKey);
  let sequence = 0;
  for (const file of files) {
    const events = await eventsFor(file);
    const intent = events.find(event => event.type === 'intent');
    const completed = requestResolved(events, intent);
    if (intent && !completed) fail('SNS_JOURNAL_RECONCILIATION_REQUIRED');
    sequence = Math.max(sequence, Number(intent?.sequence) || 0);
  }
  sequence += 1;
  const file = path.join(journalDir, `${channel}.${runKey}.${String(sequence).padStart(6, '0')}.jsonl`);
  const intent = { type: 'intent', channel, runKey, sequence, request: requestSummary(request), at: now() };
  let handle;
  try {
    handle = await open(file, 'wx', 0o600);
    await handle.writeFile(line(intent), 'utf8');
  } catch (error) {
    if (error.code === 'EEXIST') fail('SNS_JOURNAL_CONCURRENT_RESERVATION');
    throw error;
  } finally {
    await handle?.close();
  }
  return {
    file,
    sequence,
    async result(details = {}) {
      const events = await eventsFor(file);
      if (requestResolved(events, intent)) fail('SNS_JOURNAL_ALREADY_RESOLVED');
      const event = { type: 'result', channel, runKey, sequence, at: now(), ...details };
      await open(file, 'a').then(async handle => { try { await handle.writeFile(line(event), 'utf8'); } finally { await handle.close(); } });
      return event;
    },
    async checkpoint(value) {
      const checkpoint = normalizeCheckpoint(channel, value);
      const events = await eventsFor(file);
      if (!events.some(event => event.type === 'result' && event.outcome === 'response')
        || hasThreadsCreateCheckpoint(events) || hasXCreateCheckpoint(events) || events.some(event => event.type === 'reconciled')) {
        fail('SNS_CHECKPOINT_STATE_INVALID');
      }
      const event = { type: 'checkpoint', channel, runKey, sequence, at: now(), checkpoint };
      await open(file, 'a').then(async handle => { try { await handle.writeFile(line(event), 'utf8'); } finally { await handle.close(); } });
      return event;
    },
  };
}

export async function journaledRequest({ channel, runKey, journalDir = defaultJournalDir(), request, send, now, returnJournal = false }) {
  if (typeof send !== 'function') fail('SNS_TRANSPORT_REQUIRED');
  const intent = await beginJournalIntent({ channel, runKey, journalDir, request, ...(now ? { now } : {}) });
  try {
    const response = await send(request);
    const status = Number(response?.status ?? response?.receipt?.status);
    await intent.result({ outcome: 'response', ...(Number.isFinite(status) ? { httpStatus: status } : {}) });
    return returnJournal ? { response, checkpoint: intent.checkpoint } : response;
  } catch (error) {
    const status = Number(error?.receipt?.status ?? error?.httpStatus);
    if (Number.isFinite(status)) await intent.result({ outcome: 'known_error', httpStatus: status });
    throw error;
  }
}

export async function reconcileIntent({ file, result, now = () => new Date().toISOString() }) {
  const events = await eventsFor(file);
  const intent = events.find(event => event.type === 'intent');
  if (!intent) fail('SNS_JOURNAL_INTENT_MISSING');
  if(isXCreateIntent(intent)){
    if(requestResolved(events,intent))fail('SNS_JOURNAL_ALREADY_RESOLVED');
    const candidate={type:'reconciled',...result};
    if(!xPositiveReconciliation(candidate))fail('SNS_X_RECONCILIATION_POSITIVE_REQUIRED');
    const identity=intent.request.postIdentity;
    if(!identity||identity.parentId!==result.parentId||identity.contentSha256!==result.contentSha256)
      fail('SNS_X_RECONCILIATION_IDENTITY_MISMATCH');
    if(['channel','runKey','sequence'].some(field=>result[field]!==undefined&&result[field]!==intent[field]))
      fail('SNS_X_RECONCILIATION_IDENTITY_MISMATCH');
    const event={...result,type:'reconciled',channel:'x',runKey:intent.runKey,sequence:intent.sequence,at:now()};
    if(!xPositiveReconciliationForIntent(event,intent))fail('SNS_X_RECONCILIATION_IDENTITY_MISMATCH');
    await open(file,'a').then(async handle=>{try{await handle.writeFile(line(event),'utf8');await handle.sync();}finally{await handle.close();}});
    return event;
  }
  const pendingThreadsCreate = (isThreadsCreateIntent(intent) || isXCreateIntent(intent))
    && events.some(event => event.type === 'result' && (event.outcome === 'response' || event.outcome === 'known_error'))
    && !hasThreadsCreateCheckpoint(events) && !hasXCreateCheckpoint(events);
  if (events.some(event => event.type === 'reconciled') || hasThreadsCreateCheckpoint(events)
    || events.some(event => event.type === 'result') && !pendingThreadsCreate) fail('SNS_JOURNAL_ALREADY_RESOLVED');
  const event = { ...(result && typeof result === 'object' ? result : { outcome: 'manually_reconciled' }),
    type: 'reconciled', channel: intent.channel, runKey: intent.runKey, sequence: intent.sequence, at: now() };
  await open(file, 'a').then(async handle => { try { await handle.writeFile(line(event), 'utf8'); } finally { await handle.close(); } });
  return event;
}
