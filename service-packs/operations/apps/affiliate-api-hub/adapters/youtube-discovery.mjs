import { createHash } from 'node:crypto';

const YOUTUBE_ORIGIN = 'https://www.youtube.com';
const DATA_API_ORIGIN = 'https://www.googleapis.com';
const FEED_PATH = '/feeds/videos.xml';
const SEARCH_PAGE_PATH = '/results';
const SEARCH_PATH = '/youtube/v3/search';
const VIDEOS_PATH = '/youtube/v3/videos';
const WATCH_PATH = '/watch';
const FEED_DOC = 'https://developers.google.com/youtube/v3/guides/push_notifications';
const SEARCH_DOC = 'https://developers.google.com/youtube/v3/docs/search/list';
const VIDEOS_DOC = 'https://developers.google.com/youtube/v3/docs/videos/list';
const ATOM_NS = 'http://www.w3.org/2005/Atom';
const YT_NS = 'http://www.youtube.com/xml/schemas/2015';
const MEDIA_NS = 'http://search.yahoo.com/mrss/';
const MAX_FEED_BYTES = 2 * 1024 * 1024;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_WATCH_HTML_BYTES = 4 * 1024 * 1024;
const MAX_SEARCH_PAGE_HTML_BYTES = 4 * 1024 * 1024;
const MAX_XML_NODES = 10_000;
const MAX_XML_DEPTH = 32;
const MAX_FEED_ENTRIES = 100;
const MAX_PAGE_SIZE = 50;
const MAX_SEARCH_PAGES = 20;
const MAX_SEARCH_ITEMS = 500;
const MAX_VIDEO_IDS = 500;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const API_KEY = /^[A-Za-z0-9._-]{1,512}$/;

export class YouTubeDiscoveryError extends Error {
  constructor(code, receipt = {}) {
    super(code);
    this.name = 'YouTubeDiscoveryError';
    this.code = code;
    this.receipt = receipt;
  }
}

const fail = (code, receipt = {}) => { throw new YouTubeDiscoveryError(code, receipt); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value, max = 10_000) => typeof value === 'string' && value.length <= max &&
  !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const hasText = (value, max = 10_000) => isText(value, max) && value.trim().length > 0;

function checkedAt(now) {
  let value;
  try { value = new Date(now()); } catch { fail('YOUTUBE_CLOCK_INVALID'); }
  if (!Number.isFinite(value.getTime())) fail('YOUTUBE_CLOCK_INVALID');
  return value.toISOString();
}

function mimeOf(response) {
  return response.headers?.get?.('content-type')?.split(';')[0]?.trim().toLowerCase() ?? null;
}

function safeDateTime(value, field) {
  if (!hasText(value, 100) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
      !Number.isFinite(Date.parse(value))) {
    fail('YOUTUBE_VIDEO_SCHEMA_INVALID', { field });
  }
  return value;
}

function validateVideoId(value, field = 'videoId') {
  if (typeof value !== 'string' || !VIDEO_ID.test(value)) fail('YOUTUBE_VIDEO_ID_INVALID', { field });
  return value;
}

function validateChannelId(value, field = 'channelId') {
  if (typeof value !== 'string' || !CHANNEL_ID.test(value)) fail('YOUTUBE_CHANNEL_ID_INVALID', { field });
  return value;
}

function checkedHttpsUrl(value, allowedOrigin, allowedPath, receipt = {}) {
  let url;
  try { url = new URL(value); } catch { fail('YOUTUBE_URL_INVALID', receipt); }
  if (url.protocol !== 'https:' || url.origin !== allowedOrigin || url.pathname !== allowedPath || url.username || url.password) {
    fail('YOUTUBE_URL_INVALID', receipt);
  }
  return url;
}

function promotionHints(title, description) {
  const patterns = [
    ['collaboration', /콜라보|컬래버(?:레이션)?|협업|공동\s*(?:개발|제작)|collab(?:oration)?/giu],
    ['discount', /할인|세일|특가|최저가|최대\s*\d{1,3}\s*%/giu],
    ['coupon', /쿠폰|할인\s*코드|프로모션\s*코드|coupon|promo\s*code/giu],
    ['group_buy', /공동\s*구매|공구|마켓\s*(?:오픈|진행)/giu],
    ['paid_disclosure', /유료\s*광고|부분\s*유료광고|광고\s*(?:를\s*)?포함|협찬|sponsored|paid\s*promotion/giu],
    ['affiliate_reference', /제휴\s*링크|파트너스|affiliate\s*link|구매\s*링크/giu],
  ];
  const hints = [];
  for (const [field, value] of [['title', title], ['description', description]]) {
    if (!value) continue;
    for (const [kind, pattern] of patterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(value)) && hints.length < 100) {
        hints.push({
          kind,
          field,
          matchedText: match[0],
          startUtf16: match.index,
          endUtf16: match.index + match[0].length,
          interpretation: 'creator_text_signal_unverified',
        });
        if (!match[0].length) pattern.lastIndex += 1;
      }
    }
  }
  return hints;
}

function extractAssignedJsonObject(html, markers, maxBytes, errorCode) {
  if (!isText(html, maxBytes)) fail(errorCode);
  let markerIndex = -1;
  let selectedMarker = null;
  for (const marker of markers) {
    const index = html.indexOf(marker);
    if (index >= 0 && (markerIndex < 0 || index < markerIndex)) {
      markerIndex = index;
      selectedMarker = marker;
    }
  }
  if (markerIndex < 0) fail(errorCode);
  const start = html.indexOf('{', markerIndex + selectedMarker.length);
  if (start < 0) fail(errorCode);
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) { end = index + 1; break; }
      if (depth < 0) break;
    }
  }
  if (end < 0 || end - start > maxBytes) fail(errorCode);
  try { return JSON.parse(html.slice(start, end)); }
  catch { fail(errorCode); }
}

function textFromRuns(value, { max = 10_000 } = {}) {
  if (typeof value?.simpleText === 'string') return isText(value.simpleText, max) ? value.simpleText : null;
  if (!Array.isArray(value?.runs)) return null;
  const text = value.runs.map(run => typeof run?.text === 'string' ? run.text : '').join('');
  return isText(text, max) ? text : null;
}

function collectSearchPageVideoRenderers(root, { maxVisited = 100_000, maxRenderers = 1_000 } = {}) {
  const stack = [{ node: root, path: 'contents.twoColumnSearchResultsRenderer.primaryContents' }];
  const renderers = [];
  let visited = 0;
  while (stack.length && visited < maxVisited && renderers.length < maxRenderers) {
    const { node, path } = stack.pop();
    visited += 1;
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (let index = node.length - 1; index >= 0; index -= 1) stack.push({ node: node[index], path: `${path}[${index}]` });
      continue;
    }
    if (object(node.videoRenderer)) {
      renderers.push({ renderer: node.videoRenderer, path });
      continue;
    }
    for (const [key, value] of Object.entries(node)) stack.push({ node: value, path: `${path}.${key}` });
  }
  if (stack.length) fail('YOUTUBE_SEARCH_PAGE_LIMIT_EXCEEDED');
  return renderers;
}

function searchPageVideoFromRenderer(renderer, path, observedAt, searchPageSourceURL) {
  const videoId = validateVideoId(renderer.videoId);
  const title = textFromRuns(renderer.title);
  if (!hasText(title, 10_000)) fail('YOUTUBE_SEARCH_PAGE_SCHEMA_INVALID', { field: 'title' });
  const byline = renderer.ownerText ?? renderer.shortBylineText ?? renderer.longBylineText ?? null;
  const channelTitle = textFromRuns(byline);
  let channelId = null;
  for (const run of byline?.runs ?? []) {
    const browseId = run?.navigationEndpoint?.browseEndpoint?.browseId;
    if (browseId != null) {
      channelId = validateChannelId(browseId, 'channelId');
      break;
    }
  }
  const endpointVideoId = renderer.navigationEndpoint?.watchEndpoint?.videoId;
  if (endpointVideoId != null && endpointVideoId !== videoId) {
    fail('YOUTUBE_SEARCH_PAGE_LINK_MISMATCH', { field: 'watchEndpoint.videoId' });
  }
  const rawPath = renderer.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url;
  let linkedVideoId = null;
  if (rawPath != null) {
    if (!hasText(rawPath, 2000)) fail('YOUTUBE_SEARCH_PAGE_SCHEMA_INVALID', { field: 'webCommandMetadata.url' });
    let url;
    try { url = new URL(rawPath, YOUTUBE_ORIGIN); } catch { fail('YOUTUBE_SEARCH_PAGE_LINK_MISMATCH', { field: 'webCommandMetadata.url' }); }
    if (url.protocol !== 'https:' || url.origin !== YOUTUBE_ORIGIN || url.pathname !== WATCH_PATH) {
      fail('YOUTUBE_SEARCH_PAGE_LINK_MISMATCH', { field: 'webCommandMetadata.url' });
    }
    linkedVideoId = url.searchParams.get('v');
    if (linkedVideoId !== videoId) fail('YOUTUBE_SEARCH_PAGE_LINK_MISMATCH', { field: 'webCommandMetadata.url' });
  }
  if (endpointVideoId == null && linkedVideoId == null) fail('YOUTUBE_SEARCH_PAGE_LINK_MISSING');
  const publishedLabelRaw = renderer.publishedTimeText?.simpleText;
  const publishedLabel = publishedLabelRaw == null ? null : isText(publishedLabelRaw, 200) ? publishedLabelRaw :
    fail('YOUTUBE_SEARCH_PAGE_SCHEMA_INVALID', { field: 'publishedTimeText' });
  return {
    provider: 'youtube',
    videoId,
    channelId,
    channelTitle,
    title,
    url: canonicalVideoUrl(videoId),
    publishedLabel,
    promotionHints: promotionHints(title, ''),
    creatorClaims: { basis: 'public_search_result_title', status: 'unverified_creator_claim', checkedAt: observedAt },
    source: { kind: 'first_party_public_document', url: canonicalVideoUrl(videoId),
      contractURL: searchPageSourceURL, observedAt, rendererPath: path },
  };
}

function canonicalVideoUrl(videoId) {
  return `${YOUTUBE_ORIGIN}/watch?v=${videoId}`;
}

function mapVideo({ videoId, channelId, channelTitle, title, description, publishedAt, sourceKind, sourceURL, observedAt }) {
  validateVideoId(videoId);
  validateChannelId(channelId);
  if (!hasText(title, 10_000) || !isText(channelTitle, 10_000) || !isText(description, 100_000)) {
    fail('YOUTUBE_VIDEO_SCHEMA_INVALID');
  }
  const normalizedDescription = description ?? '';
  return {
    provider: 'youtube',
    videoId,
    channelId,
    channelTitle,
    title,
    url: canonicalVideoUrl(videoId),
    publishedAt: safeDateTime(publishedAt, 'publishedAt'),
    description: normalizedDescription,
    descriptionSha256: createHash('sha256').update(normalizedDescription, 'utf8').digest('hex'),
    promotionHints: promotionHints(title, normalizedDescription),
    creatorClaims: {
      basis: 'public_video_title_and_description',
      status: 'unverified_creator_claim',
      checkedAt: observedAt,
    },
    source: {
      kind: sourceKind,
      url: canonicalVideoUrl(videoId),
      contractURL: sourceURL,
      observedAt,
    },
  };
}

function xmlCodePointValid(value) {
  return value === 0x9 || value === 0xa || value === 0xd ||
    (value >= 0x20 && value <= 0xd7ff) ||
    (value >= 0xe000 && value <= 0xfffd) ||
    (value >= 0x10000 && value <= 0x10ffff);
}

function decodeXmlEntities(value) {
  if (typeof value !== 'string' || /&(?!(?:#x[0-9A-Fa-f]+|#[0-9]+|amp|lt|gt|quot|apos);)/.test(value)) {
    fail('YOUTUBE_XML_ENTITY_INVALID');
  }
  return value.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, entity) => {
    if (entity === 'amp') return '&';
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';
    if (entity === 'quot') return '"';
    if (entity === 'apos') return "'";
    const codePoint = entity.startsWith('#x')
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10);
    if (!Number.isInteger(codePoint) || !xmlCodePointValid(codePoint)) fail('YOUTUBE_XML_ENTITY_INVALID');
    return String.fromCodePoint(codePoint);
  });
}

function validateXmlCharacters(value) {
  for (const char of value) {
    if (!xmlCodePointValid(char.codePointAt(0))) fail('YOUTUBE_XML_INVALID');
  }
}

function findTagEnd(xml, from) {
  let quote = null;
  for (let index = from; index < xml.length; index += 1) {
    const char = xml[index];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '>') return index;
  }
  return -1;
}

function parseStartTag(source) {
  let index = 0;
  while (/\s/.test(source[index] ?? '')) index += 1;
  const nameMatch = source.slice(index).match(/^([A-Za-z_][A-Za-z0-9_.:-]*)/);
  if (!nameMatch) fail('YOUTUBE_XML_INVALID');
  const name = nameMatch[1];
  index += name.length;
  const attributes = Object.create(null);
  while (index < source.length) {
    const beforeSpace = index;
    while (/\s/.test(source[index] ?? '')) index += 1;
    if (index >= source.length) break;
    if (beforeSpace === index) fail('YOUTUBE_XML_INVALID');
    const attributeMatch = source.slice(index).match(/^([A-Za-z_][A-Za-z0-9_.:-]*)/);
    if (!attributeMatch || Object.hasOwn(attributes, attributeMatch[1])) fail('YOUTUBE_XML_INVALID');
    const attributeName = attributeMatch[1];
    index += attributeName.length;
    while (/\s/.test(source[index] ?? '')) index += 1;
    if (source[index] !== '=') fail('YOUTUBE_XML_INVALID');
    index += 1;
    while (/\s/.test(source[index] ?? '')) index += 1;
    const quote = source[index];
    if (quote !== '"' && quote !== "'") fail('YOUTUBE_XML_INVALID');
    index += 1;
    const end = source.indexOf(quote, index);
    if (end < 0) fail('YOUTUBE_XML_INVALID');
    const raw = source.slice(index, end);
    if (raw.includes('<')) fail('YOUTUBE_XML_INVALID');
    attributes[attributeName] = decodeXmlEntities(raw);
    index = end + 1;
  }
  return { name, attributes };
}

function parseXmlDocument(xml) {
  if (typeof xml !== 'string' || !xml.length || Buffer.byteLength(xml, 'utf8') > MAX_FEED_BYTES) {
    fail('YOUTUBE_XML_INVALID');
  }
  validateXmlCharacters(xml);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) fail('YOUTUBE_XML_DTD_REJECTED');

  const stack = [];
  let root = null;
  let cursor = 0;
  let nodes = 0;
  let declarationSeen = false;
  const appendText = (text, literal = false) => {
    if (!stack.length) {
      if (text.trim()) fail('YOUTUBE_XML_INVALID');
      return;
    }
    stack.at(-1).text += literal ? text : decodeXmlEntities(text);
  };

  while (cursor < xml.length) {
    const opening = xml.indexOf('<', cursor);
    const textEnd = opening < 0 ? xml.length : opening;
    if (textEnd > cursor) appendText(xml.slice(cursor, textEnd));
    if (opening < 0) { cursor = xml.length; break; }
    if (xml.startsWith('<!--', opening)) {
      const end = xml.indexOf('-->', opening + 4);
      if (end < 0 || xml.slice(opening + 4, end).includes('--')) fail('YOUTUBE_XML_INVALID');
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', opening)) {
      if (!stack.length) fail('YOUTUBE_XML_INVALID');
      const end = xml.indexOf(']]>', opening + 9);
      if (end < 0) fail('YOUTUBE_XML_INVALID');
      appendText(xml.slice(opening + 9, end), true);
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith('<?', opening)) {
      const end = xml.indexOf('?>', opening + 2);
      if (end < 0) fail('YOUTUBE_XML_INVALID');
      const instruction = xml.slice(opening + 2, end).trim();
      if (!/^xml(?:\s|$)/.test(instruction) || declarationSeen || opening !== 0 || stack.length || root) {
        fail('YOUTUBE_XML_PI_REJECTED');
      }
      declarationSeen = true;
      cursor = end + 2;
      continue;
    }
    if (xml.startsWith('<!', opening)) fail('YOUTUBE_XML_DECLARATION_REJECTED');
    const end = findTagEnd(xml, opening + 1);
    if (end < 0) fail('YOUTUBE_XML_INVALID');
    const body = xml.slice(opening + 1, end);
    if (body.startsWith('/')) {
      const closing = body.match(/^\/([A-Za-z_][A-Za-z0-9_.:-]*)\s*$/);
      if (!closing || !stack.length || stack.at(-1).name !== closing[1]) fail('YOUTUBE_XML_INVALID');
      stack.pop();
      cursor = end + 1;
      continue;
    }
    const selfClosing = /\/$/.test(body);
    const start = parseStartTag(selfClosing ? body.replace(/\/\s*$/, '') : body);
    const node = { name: start.name, attributes: start.attributes, children: [], text: '' };
    nodes += 1;
    if (nodes > MAX_XML_NODES || stack.length + 1 > MAX_XML_DEPTH) fail('YOUTUBE_XML_LIMIT_EXCEEDED');
    if (stack.length) stack.at(-1).children.push(node);
    else if (root) fail('YOUTUBE_XML_INVALID');
    else root = node;
    if (!selfClosing) stack.push(node);
    cursor = end + 1;
  }
  if (stack.length || !root || localName(root.name) !== 'feed') fail('YOUTUBE_XML_INVALID');
  if (root.attributes.xmlns !== ATOM_NS || root.attributes['xmlns:yt'] !== YT_NS) fail('YOUTUBE_FEED_SCHEMA_INVALID');
  if (root.attributes['xmlns:media'] !== MEDIA_NS && root.children.some(child => child.name.startsWith('media:'))) {
    fail('YOUTUBE_FEED_SCHEMA_INVALID');
  }
  return root;
}

function localName(name) { return name.includes(':') ? name.slice(name.indexOf(':') + 1) : name; }
function childrenNamed(node, name) { return node.children.filter(child => localName(child.name) === name); }
function childNamed(node, name, { required = false } = {}) {
  const matches = childrenNamed(node, name);
  if (matches.length > 1 || (required && matches.length !== 1)) fail('YOUTUBE_FEED_SCHEMA_INVALID', { field: name });
  return matches[0] ?? null;
}
function textContent(node) {
  if (!node) return '';
  return node.text + node.children.map(textContent).join('');
}
function childText(node, name, { required = false, max = 10_000 } = {}) {
  const child = childNamed(node, name, { required });
  if (!child) return null;
  const value = textContent(child);
  if (!isText(value, max)) fail('YOUTUBE_FEED_SCHEMA_INVALID', { field: name });
  return value;
}

function canonicalFeedVideoUrl(value, videoId) {
  let url;
  try { url = new URL(value); } catch { fail('YOUTUBE_FEED_SCHEMA_INVALID', { field: 'link.href' }); }
  if (url.protocol !== 'https:' || !['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(url.hostname) ||
      url.username || url.password) fail('YOUTUBE_FEED_SCHEMA_INVALID', { field: 'link.href' });
  const isWatch = url.pathname === '/watch' && url.searchParams.get('v') === videoId;
  const isShort = url.pathname === `/shorts/${videoId}` && !url.searchParams.has('v');
  if (!isWatch && !isShort) fail('YOUTUBE_FEED_SCHEMA_INVALID', { field: 'link.href' });
  return canonicalVideoUrl(videoId);
}

function parseChannelFeed(xml, requestedChannelId, observedAt) {
  const root = parseXmlDocument(xml);
  const entries = childrenNamed(root, 'entry');
  if (entries.length > MAX_FEED_ENTRIES) fail('YOUTUBE_FEED_LIMIT_EXCEEDED');
  const seen = new Set();
  const videos = entries.map(entry => {
    const channelId = childText(entry, 'channelId', { required: true, max: 100 });
    if (channelId !== requestedChannelId) fail('YOUTUBE_FEED_CHANNEL_MISMATCH');
    const videoId = childText(entry, 'videoId', { required: true, max: 100 });
    validateVideoId(videoId);
    if (seen.has(videoId)) fail('YOUTUBE_FEED_DUPLICATE_VIDEO');
    seen.add(videoId);
    const compositeId = childText(entry, 'id', { required: true, max: 100 });
    if (compositeId !== `yt:video:${videoId}`) fail('YOUTUBE_FEED_SCHEMA_INVALID', { field: 'id' });
    const title = childText(entry, 'title', { required: true, max: 10_000 });
    if (!title.trim()) fail('YOUTUBE_FEED_SCHEMA_INVALID', { field: 'title' });
    const author = childNamed(entry, 'author', { required: true });
    const channelTitle = childText(author, 'name', { required: true, max: 10_000 });
    if (!channelTitle.trim()) fail('YOUTUBE_FEED_SCHEMA_INVALID', { field: 'author.name' });
    const channelUri = childText(author, 'uri', { required: true, max: 1000 });
    let authorUrl;
    try { authorUrl = new URL(channelUri); } catch { fail('YOUTUBE_FEED_SCHEMA_INVALID', { field: 'author.uri' }); }
    if (!['http:', 'https:'].includes(authorUrl.protocol) || !['www.youtube.com', 'youtube.com'].includes(authorUrl.hostname) ||
        authorUrl.pathname !== `/channel/${channelId}`) fail('YOUTUBE_FEED_SCHEMA_INVALID', { field: 'author.uri' });
    const linkNodes = childrenNamed(entry, 'link');
    const alternateLinks = linkNodes.filter(link => link.attributes.rel === 'alternate');
    if (alternateLinks.length !== 1 || !hasText(alternateLinks[0].attributes.href, 2000)) {
      fail('YOUTUBE_FEED_SCHEMA_INVALID', { field: 'link' });
    }
    const url = canonicalFeedVideoUrl(alternateLinks[0].attributes.href, videoId);
    const group = childNamed(entry, 'group');
    const descriptionNode = group && childNamed(group, 'description');
    const description = descriptionNode ? textContent(descriptionNode) : '';
    if (!isText(description, 100_000)) fail('YOUTUBE_FEED_SCHEMA_INVALID', { field: 'description' });
    const publishedAt = safeDateTime(childText(entry, 'published', { required: true, max: 100 }), 'publishedAt');
    const updatedAtRaw = childText(entry, 'updated', { max: 100 });
    const updatedAt = updatedAtRaw == null ? null : safeDateTime(updatedAtRaw, 'updatedAt');
    return {
      ...mapVideo({ videoId, channelId, channelTitle, title, description, publishedAt,
        sourceKind: 'first_party_documented_feed', sourceURL: FEED_DOC, observedAt }),
      channelUrl: `${YOUTUBE_ORIGIN}/channel/${channelId}`,
      updatedAt,
    };
  });
  return videos;
}

async function readBounded(response, limit, operation, request) {
  if (!response.body?.getReader) fail('YOUTUBE_RESPONSE_BODY_INVALID', { operation, request });
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        fail('YOUTUBE_RESPONSE_TOO_LARGE', { operation, request, responseBytes: total });
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  let data;
  try { data = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total)); }
  catch { fail('YOUTUBE_RESPONSE_ENCODING_INVALID', { operation, request }); }
  return { data, responseBytes: total };
}

function responseReceipt({ service, capabilityId, checked, status, mime, responseBytes, requestFields,
  credentialsUsed, sourceKind, sourceURL }) {
  const path = capabilityId === 'videos.feed' ? FEED_PATH : capabilityId === 'videos.search' ? SEARCH_PATH :
    capabilityId === 'video.page_metadata' ? WATCH_PATH : capabilityId === 'videos.search_page' ? SEARCH_PAGE_PATH : VIDEOS_PATH;
  return {
    schema: 'youtube-public-read-receipt-v1',
    service,
    capabilityId,
    checkedAt: checked,
    authenticated: false,
    credentialsUsed,
    schemaVerified: true,
    expectedResultVerified: true,
    secretsPersistedInEvidence: false,
    request: {
      method: 'GET',
      origin: service === 'youtube-data-api' ? DATA_API_ORIGIN : YOUTUBE_ORIGIN,
      path,
      httpStatus: status,
      mime,
      responseBytes,
      queryFieldNames: requestFields,
      browserUsed: false,
      credentialsUsed,
    },
    ...(credentialsUsed ? { credentialBinding: { source: 'process-memory', credentialName: 'apiKey' } } : {}),
    contractProvenance: { kind: sourceKind, sourceURL },
  };
}

function validatePageToken(value) {
  if (value == null || value === '') return null;
  if (!isText(value, 10_000) || /[\r\n]/.test(value)) fail('YOUTUBE_PAGE_TOKEN_INVALID');
  return value;
}

function validateLimit(value, field, max) {
  if (!Number.isInteger(value) || value < 1 || value > max) fail('YOUTUBE_OPTIONS_INVALID', { field });
  return value;
}

function apiVideoFromResource(raw, observedAt, sourceURL, sourceKind) {
  if (!object(raw) || !object(raw.snippet)) fail('YOUTUBE_VIDEO_SCHEMA_INVALID');
  const snippet = raw.snippet;
  return mapVideo({
    videoId: raw.id,
    channelId: snippet.channelId,
    channelTitle: snippet.channelTitle,
    title: snippet.title,
    description: snippet.description ?? '',
    publishedAt: snippet.publishedAt,
    sourceKind,
    sourceURL,
    observedAt,
  });
}

function searchItemToVideo(raw, observedAt, sourceURL, sourceKind) {
  if (!object(raw) || !object(raw.id) || raw.id.kind !== 'youtube#video') {
    fail('YOUTUBE_SEARCH_SCHEMA_INVALID');
  }
  return apiVideoFromResource({ id: raw.id.videoId, snippet: raw.snippet }, observedAt, sourceURL, sourceKind);
}

function validateApiKey(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !API_KEY.test(value)) fail('YOUTUBE_API_KEY_INVALID');
  return value;
}

function promotionClaimStatus() { return 'unverified_creator_claim'; }

/**
 * Public read-only YouTube source client.
 *
 * Channel feeds and the explicit public-document search/watch methods are
 * anonymous HTTP reads. Search/watch page results are marked as document
 * metadata, not XHR or the documented Data API. The separate `searchVideos`
 * and `getVideos` methods use YouTube Data API v3 and require a caller-provided
 * API key, held only in this factory's process memory. Description URLs are
 * never fetched: they may contain affiliate attribution parameters.
 */
export function createYouTubeDiscoveryClient({ apiKey, fetchImpl = globalThis.fetch,
  now = () => new Date(), timeoutMs = 15_000 } = {}) {
  const credential = validateApiKey(apiKey);
  if (typeof fetchImpl !== 'function' || typeof now !== 'function' ||
      !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    fail('YOUTUBE_OPTIONS_INVALID');
  }

  async function request(url, { operation, service, capabilityId, requestFields, sourceKind, sourceURL,
    credentialsUsed = false, expectedMime, maxBytes }) {
    const allowedOrigin = service === 'youtube-data-api' ? DATA_API_ORIGIN : YOUTUBE_ORIGIN;
    const allowedPath = capabilityId === 'videos.feed' ? FEED_PATH : capabilityId === 'videos.search' ? SEARCH_PATH :
      capabilityId === 'video.page_metadata' ? WATCH_PATH : capabilityId === 'videos.search_page' ? SEARCH_PAGE_PATH : VIDEOS_PATH;
    checkedHttpsUrl(url.href, allowedOrigin, allowedPath);
    const controller = new AbortController();
    let timer;
    let timedOut = false;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new YouTubeDiscoveryError('YOUTUBE_REQUEST_TIMEOUT'));
      }, timeoutMs);
    });
    const operationPromise = (async () => {
      let response;
      try {
        response = await fetchImpl(url.href, {
          method: 'GET',
          headers: { accept: expectedMime },
          redirect: 'manual',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof YouTubeDiscoveryError) throw error;
        fail(timedOut ? 'YOUTUBE_REQUEST_TIMEOUT' : 'YOUTUBE_TRANSPORT_ERROR', { operation, causeName: error?.name ?? 'Error' });
      }
      const checked = checkedAt(now);
      const mime = mimeOf(response);
      const partial = { method: 'GET', origin: allowedOrigin, path: allowedPath, httpStatus: response.status, mime,
        queryFieldNames: requestFields, browserUsed: false, credentialsUsed };
      if (response.status >= 300 && response.status < 400) fail('YOUTUBE_REDIRECT_REJECTED', { operation, request: partial });
      if (response.status !== 200) fail('YOUTUBE_HTTP_ERROR', { operation, request: partial });
      if (!mime || !expectedMime.split(',').some(type => type.trim() === mime)) {
        fail('YOUTUBE_CONTENT_TYPE_INVALID', { operation, request: partial });
      }
      const { data, responseBytes } = await readBounded(response, maxBytes, operation, partial);
      const receipt = responseReceipt({ service, capabilityId, checked, status: response.status, mime,
        responseBytes, requestFields, credentialsUsed, sourceKind, sourceURL });
      return { data, receipt, checked };
    })();
    try { return await Promise.race([operationPromise, timeout]); }
    catch (error) {
      if (error instanceof YouTubeDiscoveryError) throw error;
      fail(timedOut ? 'YOUTUBE_REQUEST_TIMEOUT' : 'YOUTUBE_TRANSPORT_ERROR', { operation, causeName: error?.name ?? 'Error' });
    } finally { clearTimeout(timer); }
  }

  async function getChannelFeed({ channelId } = {}) {
    validateChannelId(channelId);
    const url = new URL(FEED_PATH, YOUTUBE_ORIGIN);
    url.searchParams.set('channel_id', channelId);
    const { data, receipt, checked } = await request(url, {
      operation: 'channel_feed', service: 'youtube', capabilityId: 'videos.feed',
      requestFields: ['channel_id'], sourceKind: 'first_party_documented_feed', sourceURL: FEED_DOC,
      expectedMime: 'application/xml,text/xml,application/atom+xml', maxBytes: MAX_FEED_BYTES,
    });
    let videos;
    try { videos = parseChannelFeed(data, channelId, checked); }
    catch (error) {
      if (error instanceof YouTubeDiscoveryError) throw error;
      fail('YOUTUBE_FEED_SCHEMA_INVALID', { request: receipt.request });
    }
    return {
      provider: 'youtube',
      channelId,
      channelUrl: `${YOUTUBE_ORIGIN}/channel/${channelId}`,
      videos,
      collection: { source: 'channel_feed', pagesRead: 1, entriesSeen: videos.length,
        descriptionCount: videos.filter(video => video.description.length > 0).length, complete: false,
        limitation: 'feed_contains_recent_channel_entries_only' },
      receipt,
    };
  }

  function extractPlayerResponse(html) {
    const parsed = extractAssignedJsonObject(html, ['ytInitialPlayerResponse =', 'ytInitialPlayerResponse='],
      MAX_WATCH_HTML_BYTES, 'YOUTUBE_VIDEO_PAGE_BOOTSTRAP_UNVERIFIED');
    if (!object(parsed) || !object(parsed.videoDetails) || !object(parsed.microformat?.playerMicroformatRenderer)) {
      fail('YOUTUBE_VIDEO_PAGE_BOOTSTRAP_UNVERIFIED');
    }
    return parsed;
  }

  /**
   * Optional no-key read of a single public watch page. This parses only the
   * page's current player JSON bootstrap with JSON.parse; it does not execute
   * page code or use a browser. Results are explicitly SSR document metadata,
   * not a captured XHR or the YouTube Data API contract. There is no silent
   * fallback from the documented feed/API operations to this method.
   */
  async function getVideoPageMetadata({ videoId } = {}) {
    validateVideoId(videoId);
    const url = new URL(WATCH_PATH, YOUTUBE_ORIGIN);
    url.searchParams.set('v', videoId);
    const { data, receipt, checked } = await request(url, {
      operation: 'watch_page_metadata', service: 'youtube-public-document', capabilityId: 'video.page_metadata',
      requestFields: ['v'], sourceKind: 'first_party_public_document', sourceURL: url.href,
      credentialsUsed: false, expectedMime: 'text/html', maxBytes: MAX_WATCH_HTML_BYTES,
    });
    const player = extractPlayerResponse(data);
    const details = player.videoDetails;
    if (details.videoId !== videoId) fail('YOUTUBE_VIDEO_ID_MISMATCH', { request: receipt.request });
    const microformat = player.microformat.playerMicroformatRenderer;
    const publishedAt = microformat.publishDate ?? microformat.uploadDate;
    const video = mapVideo({
      videoId: details.videoId,
      channelId: details.channelId,
      channelTitle: details.author,
      title: details.title,
      description: details.shortDescription ?? '',
      publishedAt,
      sourceKind: 'first_party_public_document',
      sourceURL: url.href,
      observedAt: checked,
    });
    return {
      provider: 'youtube',
      video,
      extraction: { mode: 'json_page_bootstrap', field: 'ytInitialPlayerResponse',
        isXhr: false, pageCodeExecuted: false, rawHtmlPersisted: false },
      receipt,
    };
  }

  async function getSearchPageVideos({ query, maxItems = 10 } = {}) {
    if (!hasText(query, 500) || /[\x00-\x1f\x7f]/.test(query)) fail('YOUTUBE_QUERY_INVALID');
    validateLimit(maxItems, 'maxItems', MAX_PAGE_SIZE);
    const url = new URL(SEARCH_PAGE_PATH, YOUTUBE_ORIGIN);
    url.searchParams.set('search_query', query);
    const { data, receipt, checked } = await request(url, {
      operation: 'search_page_videos', service: 'youtube-public-document', capabilityId: 'videos.search_page',
      requestFields: ['search_query'], sourceKind: 'first_party_public_document',
      sourceURL: `${YOUTUBE_ORIGIN}${SEARCH_PAGE_PATH}?search_query={query}`,
      credentialsUsed: false, expectedMime: 'text/html', maxBytes: MAX_SEARCH_PAGE_HTML_BYTES,
    });
    const initialData = extractAssignedJsonObject(data, ['ytInitialData =', 'ytInitialData='],
      MAX_SEARCH_PAGE_HTML_BYTES, 'YOUTUBE_SEARCH_PAGE_BOOTSTRAP_UNVERIFIED');
    const primary = initialData?.contents?.twoColumnSearchResultsRenderer?.primaryContents;
    if (!object(primary)) fail('YOUTUBE_SEARCH_PAGE_SCHEMA_UNVERIFIED', { request: receipt.request });
    const renderers = collectSearchPageVideoRenderers(primary);
    const videos = [];
    const seenIds = new Set();
    let duplicateCount = 0;
    for (const { renderer, path } of renderers) {
      const video = searchPageVideoFromRenderer(renderer, path, checked,
        `${YOUTUBE_ORIGIN}${SEARCH_PAGE_PATH}?search_query={query}`);
      if (seenIds.has(video.videoId)) { duplicateCount += 1; continue; }
      seenIds.add(video.videoId);
      if (videos.length < maxItems) videos.push(video);
    }
    const pageUrl = url.href;
    return {
      provider: 'youtube',
      query,
      searchUrl: pageUrl,
      videos,
      page: { rendererCount: renderers.length, uniqueVideoIds: seenIds.size, duplicatesRemoved: duplicateCount,
        selected: videos.length, requestedMaxItems: maxItems, complete: false,
        limitation: 'single_public_search_document; pagination_continuation_not_followed' },
      detailRead: { operation: 'getVideoPageMetadata', requiredFor: ['full_description', 'absolute_publishedAt', 'channel_identity_confirmation'],
        maxSelectedIds: videos.length, performed: false },
      receipt,
    };
  }

  function requireApiKey(capabilityId) {
    if (!credential) {
      fail('YOUTUBE_API_KEY_REQUIRED', {
        schema: 'youtube-public-read-receipt-v1', service: 'youtube-data-api', capabilityId,
        checkedAt: checkedAt(now), authenticated: false, credentialsUsed: false,
        schemaVerified: false, expectedResultVerified: false, secretsPersistedInEvidence: false,
        credentialReady: false,
        contractProvenance: { kind: 'first_party_documented_api', sourceURL: capabilityId === 'videos.search' ? SEARCH_DOC : VIDEOS_DOC },
      });
    }
  }

  async function searchVideos({ query, pageToken, maxResults = 25, regionCode = 'KR', relevanceLanguage = 'ko',
    order = 'relevance', publishedAfter, publishedBefore } = {}) {
    requireApiKey('videos.search');
    if (!hasText(query, 500) || /[\x00-\x1f\x7f]/.test(query)) fail('YOUTUBE_QUERY_INVALID');
    validateLimit(maxResults, 'maxResults', MAX_PAGE_SIZE);
    const validRegions = /^[A-Z]{2}$/;
    if (typeof regionCode !== 'string' || !validRegions.test(regionCode)) fail('YOUTUBE_OPTIONS_INVALID', { field: 'regionCode' });
    if (relevanceLanguage != null && (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(relevanceLanguage))) {
      fail('YOUTUBE_OPTIONS_INVALID', { field: 'relevanceLanguage' });
    }
    if (!['date', 'relevance', 'viewCount', 'rating', 'title', 'videoCount'].includes(order)) {
      fail('YOUTUBE_OPTIONS_INVALID', { field: 'order' });
    }
    const token = validatePageToken(pageToken);
    const params = new URLSearchParams({ key: credential, part: 'snippet', q: query, type: 'video', maxResults: String(maxResults),
      regionCode, order });
    if (relevanceLanguage) params.set('relevanceLanguage', relevanceLanguage);
    if (token) params.set('pageToken', token);
    for (const [field, value] of [['publishedAfter', publishedAfter], ['publishedBefore', publishedBefore]]) {
      if (value != null) params.set(field, safeDateTime(value, field));
    }
    const url = new URL(SEARCH_PATH, DATA_API_ORIGIN);
    url.search = params.toString();
    const fields = ['key', 'part', 'q', 'type', 'maxResults', 'regionCode', 'order',
      ...(relevanceLanguage ? ['relevanceLanguage'] : []), ...(token ? ['pageToken'] : []),
      ...(publishedAfter ? ['publishedAfter'] : []), ...(publishedBefore ? ['publishedBefore'] : [])];
    const { data, receipt, checked } = await request(url, {
      operation: 'search_videos', service: 'youtube-data-api', capabilityId: 'videos.search',
      requestFields: fields, sourceKind: 'first_party_documented_api', sourceURL: SEARCH_DOC,
      credentialsUsed: true, expectedMime: 'application/json,application/json; charset=utf-8', maxBytes: MAX_JSON_BYTES,
    });
    let raw;
    try { raw = JSON.parse(data); } catch { fail('YOUTUBE_JSON_INVALID', { request: receipt.request }); }
    if (!object(raw) || raw.kind !== 'youtube#searchListResponse' || !Array.isArray(raw.items) || raw.items.length > maxResults) {
      fail('YOUTUBE_SEARCH_SCHEMA_INVALID', { request: receipt.request });
    }
    const videos = raw.items.map(item => searchItemToVideo(item, checked, SEARCH_DOC, 'first_party_documented_api'));
    const nextPageToken = raw.nextPageToken == null ? null : validatePageToken(raw.nextPageToken);
    const totalResultsApprox = raw.pageInfo?.totalResults;
    if (totalResultsApprox != null && (!Number.isSafeInteger(totalResultsApprox) || totalResultsApprox < 0)) {
      fail('YOUTUBE_SEARCH_SCHEMA_INVALID', { request: receipt.request, field: 'pageInfo.totalResults' });
    }
    return {
      provider: 'youtube',
      query,
      videos,
      pagination: { nextPageToken, hasMore: nextPageToken !== null,
        ...(totalResultsApprox == null ? {} : { totalResultsApprox }), pageSize: videos.length,
        complete: false, providerExhausted: nextPageToken === null,
        completenessMeaning: 'search_results_are_relevance_limited_and_totalResults_is_approximate' },
      receipt,
    };
  }

  async function getVideos({ videoIds } = {}) {
    requireApiKey('videos.list');
    if (!Array.isArray(videoIds) || videoIds.length < 1 || videoIds.length > MAX_VIDEO_IDS) {
      fail('YOUTUBE_VIDEO_IDS_INVALID');
    }
    const ids = videoIds.map((value, index) => validateVideoId(value, `videoIds[${index}]`));
    if (new Set(ids).size !== ids.length) fail('YOUTUBE_VIDEO_IDS_DUPLICATE');
    const videos = [];
    const receipts = [];
    const found = new Set();
    for (let offset = 0; offset < ids.length; offset += MAX_PAGE_SIZE) {
      const batch = ids.slice(offset, offset + MAX_PAGE_SIZE);
      const url = new URL(VIDEOS_PATH, DATA_API_ORIGIN);
      url.search = new URLSearchParams({ key: credential, part: 'snippet', id: batch.join(',') }).toString();
      const { data, receipt, checked } = await request(url, {
        operation: 'get_videos', service: 'youtube-data-api', capabilityId: 'videos.detail',
        requestFields: ['key', 'part', 'id'], sourceKind: 'first_party_documented_api', sourceURL: VIDEOS_DOC,
        credentialsUsed: true, expectedMime: 'application/json,application/json; charset=utf-8', maxBytes: MAX_JSON_BYTES,
      });
      let raw;
      try { raw = JSON.parse(data); } catch { fail('YOUTUBE_JSON_INVALID', { request: receipt.request }); }
      if (!object(raw) || raw.kind !== 'youtube#videoListResponse' || !Array.isArray(raw.items) || raw.items.length > batch.length) {
        fail('YOUTUBE_VIDEOS_SCHEMA_INVALID', { request: receipt.request });
      }
      const requested = new Set(batch);
      for (const item of raw.items) {
        if (!object(item) || !requested.has(item.id) || found.has(item.id)) fail('YOUTUBE_VIDEOS_ID_MISMATCH', { request: receipt.request });
        found.add(item.id);
        videos.push(apiVideoFromResource(item, checked, VIDEOS_DOC, 'first_party_documented_api'));
      }
      receipts.push(receipt);
    }
    return {
      provider: 'youtube',
      videos,
      missingVideoIds: ids.filter(videoId => !found.has(videoId)),
      collection: { idsRequested: ids.length, batchesRead: receipts.length, found: videos.length,
        missing: ids.length - videos.length, complete: videos.length === ids.length,
        limitation: videos.length === ids.length ? null : 'video_not_returned_or_not_public' },
      receipts,
    };
  }

  async function collectSearchVideos({ query, maxPages = 3, maxItems = 100, maxResults = 50,
    regionCode = 'KR', relevanceLanguage = 'ko', order = 'date', publishedAfter, publishedBefore } = {}) {
    requireApiKey('videos.search');
    validateLimit(maxPages, 'maxPages', MAX_SEARCH_PAGES);
    validateLimit(maxItems, 'maxItems', MAX_SEARCH_ITEMS);
    validateLimit(maxResults, 'maxResults', MAX_PAGE_SIZE);
    const videos = [];
    const receipts = [];
    const seenIds = new Set();
    const seenTokens = new Set();
    let pageToken;
    let terminal = false;
    let totalResultsApprox = null;
    for (let page = 0; page < maxPages && videos.length < maxItems; page += 1) {
      const result = await searchVideos({ query, pageToken, maxResults: Math.min(maxResults, maxItems - videos.length),
        regionCode, relevanceLanguage, order, publishedAfter, publishedBefore });
      receipts.push(result.receipt);
      totalResultsApprox ??= result.pagination.totalResultsApprox ?? null;
      for (const video of result.videos) {
        if (!seenIds.has(video.videoId) && videos.length < maxItems) {
          seenIds.add(video.videoId);
          videos.push(video);
        }
      }
      if (!result.pagination.nextPageToken) { terminal = true; break; }
      if (seenTokens.has(result.pagination.nextPageToken)) fail('YOUTUBE_PAGINATION_CYCLE');
      seenTokens.add(result.pagination.nextPageToken);
      pageToken = result.pagination.nextPageToken;
    }
    const limitReached = videos.length >= maxItems;
    const pageBoundReached = !terminal && receipts.length >= maxPages;
    return {
      provider: 'youtube', query, videos,
      pagination: { pagesRead: receipts.length, uniqueVideos: videos.length,
        totalResultsApprox, complete: false, providerExhausted: terminal,
        ...(terminal ? { termination: 'no_nextPageToken' } : limitReached ? { termination: 'item_cap_reached' } :
          pageBoundReached ? { termination: 'page_cap_reached' } : { termination: 'provider_limited' }) },
      receipts,
    };
  }

  return Object.freeze({
    getChannelFeed,
    getVideoPageMetadata,
    getSearchPageVideos,
    searchVideos,
    getVideos,
    collectSearchVideos,
    credentialStatus: () => ({ apiKeyConfigured: Boolean(credential), storage: 'process-memory' }),
  });
}

export const youtubeDiscoveryContract = Object.freeze({
  provider: 'youtube',
  source: 'YouTube public channel feed, public documents, and Data API v3',
  methods: {
    getChannelFeed: { operation: 'GET', origin: YOUTUBE_ORIGIN, path: FEED_PATH,
      fields: ['channel_id'], sourceKind: 'first_party_documented_feed', apiKeyRequired: false },
    getVideoPageMetadata: { operation: 'GET', origin: YOUTUBE_ORIGIN, path: WATCH_PATH,
      fields: ['v'], sourceKind: 'first_party_public_document', apiKeyRequired: false,
      note: 'Optional SSR page metadata; not XHR and not a documented Data API method' },
    getSearchPageVideos: { operation: 'GET', origin: YOUTUBE_ORIGIN, path: SEARCH_PAGE_PATH,
      fields: ['search_query'], sourceKind: 'first_party_public_document', apiKeyRequired: false,
      note: 'Bounded single-page SSR result parsing; no continuation or Data API equivalence is asserted' },
    searchVideos: { operation: 'GET', origin: DATA_API_ORIGIN, path: SEARCH_PATH,
      fields: ['part', 'q', 'type', 'maxResults', 'pageToken', 'regionCode', 'relevanceLanguage', 'publishedAfter', 'publishedBefore'],
      sourceKind: 'first_party_documented_api', apiKeyRequired: true },
    getVideos: { operation: 'GET', origin: DATA_API_ORIGIN, path: VIDEOS_PATH,
      fields: ['part', 'id'], sourceKind: 'first_party_documented_api', apiKeyRequired: true },
  },
  policyBoundary: {
    videoDescription: 'preserved as public business evidence; 30-day refresh/delete policy applies to YouTube API data',
    outboundLinks: 'stored only as description text; never requested or followed by this client',
    promotionInterpretation: 'text matches are unverified creator claims until cross-checked against a retailer source',
    publicDocuments: 'search/watch page JSON bootstrap is explicitly document metadata and can change; it is not XHR or a documented API',
  },
});
