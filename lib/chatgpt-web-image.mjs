// Pure helpers for scripts/chatgpt-image.mjs (no network, no CDP). Kept separate so they can be unit-tested.

export const MIN_IMAGE_WIDTH = 512;
export const TARGET_CDP = { phone: 'http://127.0.0.1:9471', pc: 'http://127.0.0.1:9333' };
const GENERATED_ALT = /^(생성된 이미지|Generated image)/;

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

// argv = process.argv.slice(2). Returns the resolved options; throws UsageError on bad input.
export function parseArgs(argv) {
  const opts = { out: null, prompt: null, target: 'phone', cdp: null, timeoutSec: 300, probe: false, quota: false, keepTab: false };
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      if (opts.out) throw new UsageError(`unexpected argument: ${arg}`);
      opts.out = arg;
      continue;
    }
    const eq = arg.indexOf('=');
    const key = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
    const value = eq < 0 ? true : arg.slice(eq + 1);
    switch (key) {
      case 'prompt':
        if (typeof value !== 'string' || !value.trim()) throw new UsageError('--prompt needs text');
        opts.prompt = value;
        break;
      case 'target':
        if (typeof value !== 'string' || !Object.hasOwn(TARGET_CDP, value)) throw new UsageError('--target must be phone or pc');
        opts.target = value;
        break;
      case 'cdp':
        if (typeof value !== 'string' || !/^https?:\/\//.test(value)) throw new UsageError('--cdp must be an http(s) URL');
        opts.cdp = value.replace(/\/+$/, '');
        break;
      case 'timeout': {
        const n = Number(value);
        if (typeof value !== 'string' || !Number.isInteger(n) || n <= 0) throw new UsageError('--timeout must be a positive number of seconds');
        opts.timeoutSec = n;
        break;
      }
      case 'probe':
        if (value !== true) throw new UsageError('--probe takes no value');
        opts.probe = true;
        break;
      case 'quota':
        if (value !== true) throw new UsageError('--quota takes no value');
        opts.quota = true;
        break;
      case 'keep-tab':
        if (value !== true) throw new UsageError('--keep-tab takes no value');
        opts.keepTab = true;
        break;
      default:
        throw new UsageError(`unknown option: ${arg}`);
    }
  }
  const sendsOrDownloads = !opts.probe && !opts.quota;
  if (sendsOrDownloads && !opts.out) throw new UsageError('missing <out.png>');
  if (sendsOrDownloads && !opts.prompt) throw new UsageError('missing --prompt');
  opts.cdpOverride = opts.cdp !== null;
  opts.cdp = opts.cdp ?? TARGET_CDP[opts.target];
  return opts;
}

// candidates: [{src, alt, w, previewParent}] from the page. `before` is the set (or array) of srcs that existed before sending.
// Ignores images narrower than MIN_IMAGE_WIDTH and srcs seen before. Prefers images inside the generated-image preview
// and images whose alt says "generated image"; among equal scores the last one in page order wins.
export function selectImageCandidate(candidates, before = []) {
  const seen = new Set(before);
  let best = null;
  let bestScore = -1;
  for (const c of candidates) {
    if (!c || !c.src || !(c.w >= MIN_IMAGE_WIDTH) || seen.has(c.src)) continue;
    const score = (c.previewParent ? 2 : 0) + (GENERATED_ALT.test(c.alt || '') ? 1 : 0);
    if (score >= bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

// "data:image/png;base64,...." -> { mime, bytes: Buffer }. Non-base64 data URLs are percent-decoded.
export function decodeDataUrl(dataUrl) {
  const m = /^data:([^;,]*)((?:;[^;,]*)*),([\s\S]*)$/.exec(String(dataUrl ?? ''));
  if (!m) throw new Error('not a data URL');
  const mime = m[1] || 'application/octet-stream';
  const bytes = /;base64$/i.test(m[2]) ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  return { mime, bytes };
}

// ---- captured conversation contract (GET /backend-api/conversations/{id}) ----
// The generated image is a tool message from the image tool (author.name "t2uay3k.…") whose content.parts holds an
// image_asset_pointer. The conversation JSON is walked as either a `messages` array or a `mapping` tree.
export const IMAGE_TOOL_NAME_PREFIX = 't2uay3k.';
export const IMAGE_POINTER_TYPE = 'image_asset_pointer';
export const FINISHED_STATUS = 'finished_successfully';
const SEDIMENT_POINTER = /^sediment:\/\/(file_[0-9a-zA-Z]+)$/;

// Returns [{fileId, mimeType, width, height, sizeBytes, genId}] for finished image-tool messages, in conversation order.
export function findGeneratedImages(conversation) {
  const messages = [];
  if (Array.isArray(conversation?.messages)) messages.push(...conversation.messages);
  if (conversation?.mapping && typeof conversation.mapping === 'object') {
    for (const node of Object.values(conversation.mapping)) if (node?.message) messages.push(node.message);
  }
  const found = [];
  const seen = new Set();
  for (const message of messages) {
    if (message?.author?.role !== 'tool' || !String(message.author.name ?? '').startsWith(IMAGE_TOOL_NAME_PREFIX)) continue;
    if (message.status !== FINISHED_STATUS) continue;
    const parts = Array.isArray(message.content?.parts) ? message.content.parts : [];
    for (const part of parts) {
      if (part?.content_type !== IMAGE_POINTER_TYPE) continue;
      const m = SEDIMENT_POINTER.exec(part.asset_pointer ?? '');
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      found.push({
        fileId: m[1],
        mimeType: part.mime_type ?? null,
        width: part.width ?? null,
        height: part.height ?? null,
        sizeBytes: part.size_bytes ?? null,
        genId: part.metadata?.dalle?.gen_id ?? null,
      });
    }
  }
  return found;
}

// Logs and output show only the tail of a file id.
export function redactFileId(fileId) {
  return `…${String(fileId).slice(-6)}`;
}

// /c/<conversation-id>[/…] -> conversation id, or null.
export function conversationIdFromPath(pathname) {
  const m = /^\/c\/([0-9a-zA-Z-]+)/.exec(String(pathname ?? ''));
  return m ? m[1] : null;
}

// Response of POST /backend-api/conversation/init -> the image_gen entry of limits_progress, or null.
export function imageGenLimit(initResponse) {
  const entry = (initResponse?.limits_progress ?? []).find((item) => item?.feature_name === 'image_gen');
  return entry ? { remaining: entry.remaining ?? null, resetAfter: entry.reset_after ?? null } : null;
}
