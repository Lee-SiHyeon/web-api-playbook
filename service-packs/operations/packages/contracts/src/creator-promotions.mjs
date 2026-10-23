import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { fingerprint } from './index.mjs';

export const CREATOR_PROMOTION_SCHEMA_VERSION = 1;
export const CREATOR_PROMOTION_CONTEXT = Object.freeze({
  '@vocab': 'urn:creator-promotion:vocab:',
  schema: 'https://schema.org/',
  prov: 'http://www.w3.org/ns/prov#',
  ccp: 'urn:creator-promotion:vocab:',
  Creator: 'ccp:Creator',
  Content: 'ccp:Content',
  Collaboration: 'ccp:Collaboration',
  Promotion: 'ccp:Promotion',
  SourceEvidence: 'ccp:SourceEvidence',
  creator: { '@id': 'ccp:creator', '@type': '@id' },
  content: { '@id': 'ccp:content', '@type': '@id' },
  brand: 'schema:brand',
  product: { '@id': 'ccp:product', '@type': '@id' },
  products: { '@id': 'ccp:products', '@type': '@id', '@container': '@set' },
  evidence: { '@id': 'ccp:evidence', '@type': '@id', '@container': '@set' },
  sourceEvidence: { '@id': 'ccp:sourceEvidence', '@type': '@id', '@container': '@set' },
  verifiesAnnouncement: { '@id': 'ccp:verifiesAnnouncement', '@type': '@id' },
  derivedFromAnnouncement: { '@id': 'ccp:derivedFromAnnouncement', '@type': '@id' },
  platform: 'ccp:platform',
  platformAccountId: 'ccp:platformAccountId',
  videoId: 'ccp:videoId',
  channelId: 'ccp:channelId',
  announcementKind: 'ccp:announcementKind',
  collaborationKind: 'ccp:collaborationKind',
  announcementStatus: 'ccp:announcementStatus',
  verificationStatus: 'ccp:verificationStatus',
  validityStatus: 'ccp:validityStatus',
  promoCode: 'ccp:promoCode',
  reportedPromoCodes: 'ccp:reportedPromoCodes',
  reportedDiscountPercents: 'ccp:reportedDiscountPercents',
  eligibilityStatus: 'ccp:eligibilityStatus',
  eligibility: 'ccp:eligibility',
  locale: 'ccp:locale',
  market: 'ccp:market',
  provider: 'ccp:provider',
  productId: 'ccp:productId',
  variantId: 'ccp:variantId',
  sourceType: 'ccp:sourceType',
  sourceRef: { '@id': 'ccp:sourceRef', '@type': '@id' },
  sourceNativeId: 'ccp:sourceNativeId',
  capturedAt: { '@id': 'prov:generatedAtTime', '@type': 'schema:DateTime' },
  observedAt: { '@id': 'ccp:observedAt', '@type': 'schema:DateTime' },
  publishedAt: { '@id': 'schema:datePublished', '@type': 'schema:DateTime' },
  validFrom: { '@id': 'schema:validFrom', '@type': 'schema:DateTime' },
  validThrough: { '@id': 'schema:validThrough', '@type': 'schema:DateTime' },
  checkedAt: { '@id': 'ccp:checkedAt', '@type': 'schema:DateTime' },
  validUntil: { '@id': 'ccp:validUntil', '@type': 'schema:DateTime' },
  canonicalUrl: { '@id': 'schema:url', '@type': '@id' },
  title: 'schema:name',
  description: 'schema:description',
  excerpt: 'ccp:excerpt',
  sourceSpans: 'ccp:sourceSpans',
  sourceField: 'ccp:sourceField',
  sourcePointer: 'ccp:sourcePointer',
  contentHash: 'ccp:contentHash',
  hashAlgorithm: 'ccp:hashAlgorithm',
  contentHashAlgorithm: 'ccp:contentHashAlgorithm',
  independenceCluster: 'ccp:independenceCluster',
  adOrSponsorshipSignal: 'ccp:adOrSponsorshipSignal',
  observedFields: 'ccp:observedFields',
  productScope: 'ccp:productScope',
  usageContext: 'ccp:usageContext',
  support: 'ccp:support',
  claimId: 'ccp:claimId',
  claimType: 'ccp:claimType',
  text: 'schema:text',
  sources: { '@id': 'ccp:sources', '@type': '@id', '@container': '@set' },
  allowedWording: 'ccp:allowedWording',
  forbiddenWording: 'ccp:forbiddenWording',
  currentPrice: 'ccp:currentPrice',
  listedPrice: 'ccp:listedPrice',
  price: 'schema:price',
  priceCurrency: 'schema:priceCurrency',
  priceBasis: 'ccp:priceBasis',
  discountPercent: 'ccp:discountPercent',
  terms: 'ccp:terms',
  membershipRequired: 'ccp:membershipRequired',
  couponRequired: 'ccp:couponRequired',
  active: 'ccp:active',
  officialSource: 'ccp:officialSource',
  merchantFirstParty: 'ccp:merchantFirstParty',
  sourceReceipt: 'ccp:sourceReceipt',
  announcements: { '@id': 'ccp:announcements', '@type': '@id', '@container': '@set' },
  promotionNodes: { '@id': 'ccp:promotionNodes', '@type': '@id', '@container': '@set' },
  collaborationNodes: { '@id': 'ccp:collaborationNodes', '@type': '@id', '@container': '@set' },
  productCandidates: 'ccp:productCandidates',
  generatedAt: { '@id': 'ccp:generatedAt', '@type': 'schema:DateTime' },
  graphVersion: 'ccp:graphVersion',
  diagnostics: 'ccp:diagnostics',
});

const MAX_TITLE_LENGTH = 1_000;
const MAX_DESCRIPTION_LENGTH = 50_000;
const MAX_EXCERPT_LENGTH = 240;
const MAX_SPANS = 8;
const MAX_CODES = 8;
const MAX_ANNOUNCEMENTS_PER_VIDEO = 1;
const HASH_PATTERN = /^[a-f0-9]{64}$/i;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const DISCOUNT_CUE = /(?:할인(?:율|가|코드)?|쿠폰(?:\s*코드)?|프로모션(?:\s*코드)?|특가|공동\s*구매|공구|세일|discount|coupon|promo(?:tion)?|\bdeal\b|\bsale\b|group\s*buy|\boff\b)/giu;
const COLLAB_CUE = /(?:콜라보|컬래버|협업|공동\s*개발|함께\s*(?:만든|제작)|내가\s*(?:만든|개발|디자인)|제가\s*(?:만든|개발|디자인)|(?:IP|캐릭터|애니메이션|애니|게임)\s*콜라보|collab(?:oration)?|co[\s-]?created|created\s+with|designed\s+with)/giu;
const SPONSORSHIP_CUE = /(?:유료\s*광고|협찬|광고\s*포함|제품\s*제공|sponsored|paid\s+promotion|gifted\s+by)/giu;
const RECOMMENDATION_CUE = /(?:추천|리뷰|사용기|review|recommend(?:ation)?)/giu;
const PROMO_CODE_CUE = /(?:쿠폰\s*코드|할인\s*코드|프로모션\s*코드|promo(?:tion)?\s*code|coupon\s*code|\bcode\b|코드)\s*(?:는|가|[:：=\-])?\s*([A-Z0-9][A-Z0-9_-]{3,31})\b(?![A-Z0-9_.%@-])/giu;
const PERCENT_CUE = /(?:(\d{1,3}(?:\.\d+)?)\s*%\s*(?:할인|off|discount)|(?:할인|off|discount)\s*(\d{1,3}(?:\.\d+)?)\s*%)/giu;
const TRACKING_QUERY = /^(?:utm_.+|fbclid|gclid|dclid|mc_cid|mc_eid|si|feature|ref_src|tag|ascsubtag|linkcode|camp|creative|clickid|affiliate_id|affid|partner_id|subid|sub_id|clickref|irclickid|ranmida|raneaid|awc|srsltid)$/i;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']);
const AFFILIATE_SHORT_HOSTS = new Set(['youtu.be', 'bit.ly', 't.co', 'tinyurl.com', 'linktr.ee', 'coupa.ng', 'link.coupang.com', 'amzn.to']);

function text(value, name, { optional = false, max = 10_000 } = {}) {
  if (value == null && optional) return null;
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a nonempty string`);
  if (value.length > max) throw new RangeError(`${name} exceeds ${max} characters`);
  return value;
}

function fullInstant(value, name, { optional = false } = {}) {
  if (value == null && optional) return null;
  if (typeof value !== 'string' || !ISO_INSTANT_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${name} must be a full ISO timestamp with an explicit timezone`);
  }
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
      || Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6]) > 59
      || (parts[10] != null && (Number(parts[10]) > 14 || (Number(parts[10]) === 14 && Number(parts[11]) !== 0)))) {
    throw new TypeError(`${name} must be a valid ISO timestamp`);
  }
  return new Date(value).toISOString();
}

function isPrivateAddress(host) {
  const ipVersion = isIP(host);
  if (ipVersion === 4) {
    const parts = host.split('.').map(Number);
    return parts[0] === 0 || parts[0] === 10 || parts[0] === 127
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168)
      || parts[0] >= 224;
  }
  if (ipVersion === 6) {
    const normalized = host.toLowerCase();
    return normalized === '::' || normalized === '::1'
      || normalized.startsWith('fc') || normalized.startsWith('fd')
      || normalized.startsWith('fe80:') || normalized.startsWith('::ffff:127.');
  }
  return false;
}

function publicHttpsUrl(value, name, { allowedHosts } = {}) {
  text(value, name, { max: 4_096 });
  let url;
  try { url = new URL(value); } catch { throw new TypeError(`${name} must be an absolute URL`); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || !host
      || url.port && url.port !== '443'
      || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')
      || isPrivateAddress(host)
      || (allowedHosts && !allowedHosts.has(host))) {
    throw new TypeError(`${name} must be a public HTTPS URL`);
  }
  url.hash = '';
  const kept = [...url.searchParams.entries()]
    .filter(([key]) => !TRACKING_QUERY.test(key))
    .sort(([aKey, aValue], [bKey, bValue]) => aKey.localeCompare(bKey) || aValue.localeCompare(bValue));
  url.search = '';
  for (const [key, value] of kept) url.searchParams.append(key, value);
  return url.toString();
}

function canonicalYouTubeUrl(sourceUrl, videoId) {
  const safe = publicHttpsUrl(sourceUrl, 'video.sourceUrl', { allowedHosts: YOUTUBE_HOSTS });
  const url = new URL(safe);
  let urlVideoId = null;
  if (url.hostname === 'youtu.be') urlVideoId = url.pathname.split('/').filter(Boolean)[0] ?? null;
  else if (url.pathname === '/watch') urlVideoId = url.searchParams.get('v');
  else if (/^\/(?:shorts|embed|live)\/[^/]+/.test(url.pathname)) urlVideoId = url.pathname.split('/')[2];
  if (!urlVideoId || urlVideoId !== videoId) throw new TypeError('video.sourceUrl must identify video.videoId');
  if (url.hostname === 'youtu.be') return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  return safe;
}

function idFor(kind, values) {
  return `urn:creator-promotion:${kind}:${fingerprint(values)}`;
}

function trustedCallback(callback, rawValue, normalizedValue) {
  if (typeof callback !== 'function') return false;
  try { return callback(rawValue, normalizedValue) === true; }
  catch { return false; }
}

function cueMatches(value, pattern, kind, field) {
  pattern.lastIndex = 0;
  const matches = [];
  for (const match of value.matchAll(pattern)) {
    matches.push({ kind, field, index: match.index, length: match[0].length, cue: match[0] });
  }
  return matches;
}

function redactPublicText(value) {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/https?:\/\/[^\s)\]}>,]+/gi, '[link]')
    .replace(/\b\+?\d[\d\s().-]{7,}\d\b/g, '[phone]');
}

function spanAround(value, match) {
  const hardLimit = MAX_EXCERPT_LENGTH;
  const boundaryPattern = /\n+|[!?。！？]+|\.(?=\s|$)/g;
  let sentenceStart = 0;
  for (const boundary of value.slice(0, match.index).matchAll(boundaryPattern)) {
    sentenceStart = boundary.index + boundary[0].length;
  }
  const rightStart = match.index + match.length;
  const nextBoundary = boundaryPattern.exec(value.slice(rightStart));
  const sentenceEnd = nextBoundary ? rightStart + nextBoundary.index + nextBoundary[0].length : value.length;
  let start = sentenceStart;
  let end = sentenceEnd;
  if (end - start > hardLimit) {
    start = Math.max(sentenceStart, match.index - Math.floor((hardLimit - match.length) / 2));
    end = Math.min(sentenceEnd, start + hardLimit);
    if (end - start < hardLimit) start = Math.max(sentenceStart, end - hardLimit);
  }
  const raw = value.slice(start, end);
  const leading = raw.length - raw.trimStart().length;
  const trimmed = raw.trim();
  const excerpt = redactPublicText(trimmed).slice(0, hardLimit);
  const exactStart = start + leading;
  return { start: exactStart, end: exactStart + trimmed.length, excerpt, redacted: excerpt !== trimmed };
}

function cuePolarity(value, match) {
  const span = spanAround(value, match);
  const local = value.slice(span.start, span.end);
  return /(?:아님|아닌|아니(?:다|라|에요|어요|지만)?|안\s*(?:하|받|돼)|없(?:음|어요|습니다|다)?|\b(?:no|not|without|never|isn't|aren't|wasn't|weren't|doesn't|don't|didn't|can't|won't|is\s+not|are\s+not)\b)/i.test(local)
    ? 'negated_or_ambiguous' : 'positive';
}

function parseReportedCodes(textValue) {
  const codes = [];
  PROMO_CODE_CUE.lastIndex = 0;
  for (const match of textValue.matchAll(PROMO_CODE_CUE)) {
    const code = match[1].trim();
    if (!codes.includes(code)) codes.push(code);
    if (codes.length >= MAX_CODES) break;
  }
  return codes;
}

function parseReportedDiscounts(textValue) {
  const percentages = [];
  PERCENT_CUE.lastIndex = 0;
  for (const match of textValue.matchAll(PERCENT_CUE)) {
    const value = Number(match[1] ?? match[2]);
    if (!Number.isFinite(value) || value < 0 || value > 100) continue;
    if (!percentages.includes(value)) percentages.push(value);
  }
  return percentages;
}

function explicitCollaborationKind(textValue) {
  if (/(?:IP|캐릭터|애니메이션|애니|게임)\s*콜라보/i.test(textValue)) return 'ip_collaboration_mentioned';
  if (/(?:내가|제가)\s*(?:만든|개발|디자인)|공동\s*개발|함께\s*(?:만든|제작)|(?:유튜버|크리에이터|creator).{0,20}(?:콜라보|협업)|(?:콜라보|협업).{0,20}(?:유튜버|크리에이터|creator)/i.test(textValue)) {
    return 'creator_product_collaboration_mentioned';
  }
  return 'unspecified_collaboration_mentioned';
}

function normalizeProductReferences(video, evidenceId, trustedVideo) {
  if (video.productReferences == null) return [];
  if (!Array.isArray(video.productReferences)) throw new TypeError('video.productReferences must be an array');
  return video.productReferences.map((reference, index) => {
    if (!reference || typeof reference !== 'object' || Array.isArray(reference)) throw new TypeError(`video.productReferences[${index}] must be an object`);
    const provider = text(reference.provider, `video.productReferences[${index}].provider`, { max: 100 });
    const productId = text(String(reference.productId ?? ''), `video.productReferences[${index}].productId`, { max: 300 });
    const variantId = text(String(reference.variantId ?? ''), `video.productReferences[${index}].variantId`, { max: 300 });
    const market = text(reference.market, `video.productReferences[${index}].market`, { max: 20 }).toUpperCase();
    const rawProductUrl = publicHttpsUrl(reference.productUrl ?? reference.canonicalProductUrl, `video.productReferences[${index}].productUrl`);
    const host = new URL(rawProductUrl).hostname.toLowerCase();
    const sourceStart = reference.start;
    const sourceEnd = reference.end;
    const pointerValid = reference.sourceField === 'description'
      && Number.isSafeInteger(sourceStart) && Number.isSafeInteger(sourceEnd)
      && sourceStart >= 0 && sourceEnd > sourceStart && sourceEnd <= video.description.length
      && (() => {
        try { return publicHttpsUrl(video.description.slice(sourceStart, sourceEnd).trim(), 'video.description product URL') === rawProductUrl; }
        catch { return false; }
      })();
    const directUrl = !AFFILIATE_SHORT_HOSTS.has(host) && trustedVideo && pointerValid ? rawProductUrl : null;
    return {
      provider,
      productId,
      variantId,
      market,
      directProductUrl: directUrl,
      sourceEvidenceId: evidenceId,
      sourcePointer: pointerValid ? `description[${sourceStart}:${sourceEnd}]` : `caller_supplied.productReferences[${index}]`,
      sourcePointerStatus: trustedVideo && pointerValid ? 'source_verified' : 'caller_supplied_unverified',
      sourceBound: Boolean(directUrl),
    };
  });
}

function boundVideoResponseHash(video) {
  const receipt = video.sourceReceipt;
  const boundId = receipt?.sourceNativeId ?? receipt?.videoId;
  const supplied = receipt?.videoContentHash
    ?? (boundId === video.videoId ? receipt?.responseHash ?? receipt?.contentHash : null);
  if (typeof supplied === 'string' && HASH_PATTERN.test(supplied)) return supplied.toLowerCase();
  return null;
}

function sourceHash(video) {
  const supplied = boundVideoResponseHash(video);
  if (supplied) return supplied;
  return fingerprint({
    videoId: video.videoId,
    channelId: video.channelId,
    title: video.title,
    description: video.description ?? '',
    publishedAt: video.publishedAt ?? null,
    productReferences: Array.isArray(video.productReferences) ? video.productReferences.map(reference => ({
      provider: reference.provider, productId: reference.productId, variantId: reference.variantId,
      market: reference.market, productUrl: reference.productUrl ?? reference.canonicalProductUrl,
      sourceField: reference.sourceField, start: reference.start, end: reference.end,
    })) : [],
  });
}

function sourceStatus(sourceReceipt) {
  const status = sourceReceipt?.httpStatus ?? sourceReceipt?.status;
  return Number.isInteger(status) ? status : null;
}

function validateVideo(video) {
  if (!video || typeof video !== 'object' || Array.isArray(video)) throw new TypeError('video must be an object');
  const videoId = text(String(video.videoId ?? ''), 'video.videoId', { max: 200 });
  const channelId = text(String(video.channelId ?? ''), 'video.channelId', { max: 300 });
  const title = text(video.title, 'video.title', { max: MAX_TITLE_LENGTH });
  let description = '';
  if (video.description != null) {
    if (typeof video.description !== 'string' || video.description.length > MAX_DESCRIPTION_LENGTH) {
      throw new TypeError(`video.description must be a string of at most ${MAX_DESCRIPTION_LENGTH} characters`);
    }
    description = video.description;
  }
  const observedAt = fullInstant(video.observedAt, 'video.observedAt');
  const publishedAt = fullInstant(video.publishedAt, 'video.publishedAt', { optional: true });
  const sourceUrl = canonicalYouTubeUrl(video.sourceUrl, videoId);
  const channelTitle = video.channelTitle == null || video.channelTitle === '' ? null : text(video.channelTitle, 'video.channelTitle', { max: 300 });
  return { ...video, videoId, channelId, title, description, observedAt, publishedAt, sourceUrl, channelTitle };
}

/**
 * Extracts public announcements from one normalized video DTO. It does not infer a merchant offer,
 * formal partnership, product identity, or current availability from creator-authored text.
 */
export function extractPromotionClaims(input, { trustedVideoVerifier } = {}) {
  const video = validateVideo(input);
  const trustedVideo = trustedCallback(trustedVideoVerifier, input, video) && sourceStatus(video.sourceReceipt) === 200;
  const creatorId = idFor('creator', { platform: 'youtube', channelId: video.channelId });
  const contentId = idFor('content', { platform: 'youtube', videoId: video.videoId });
  const hash = sourceHash(video);
  const evidenceId = idFor('evidence', {
    sourceType: 'creator_public_video', sourceRef: video.sourceUrl,
    capturedAt: video.observedAt, contentHash: hash,
  });
  const productReferences = normalizeProductReferences(video, evidenceId, trustedVideo);
  const titleMatches = [
    ...cueMatches(video.title, DISCOUNT_CUE, 'discount', 'title'),
    ...cueMatches(video.title, COLLAB_CUE, 'collaboration', 'title'),
    ...cueMatches(video.title, SPONSORSHIP_CUE, 'sponsorship', 'title'),
    ...cueMatches(video.title, RECOMMENDATION_CUE, 'recommendation', 'title'),
  ];
  const descriptionMatches = [
    ...cueMatches(video.description, DISCOUNT_CUE, 'discount', 'description'),
    ...cueMatches(video.description, COLLAB_CUE, 'collaboration', 'description'),
    ...cueMatches(video.description, SPONSORSHIP_CUE, 'sponsorship', 'description'),
    ...cueMatches(video.description, RECOMMENDATION_CUE, 'recommendation', 'description'),
  ];
  const matches = [...titleMatches, ...descriptionMatches];
  const locatedMatches = matches.map(match => ({
    ...match,
    polarity: cuePolarity(match.field === 'title' ? video.title : video.description, match),
  }));
  const hasDiscount = locatedMatches.some(match => match.kind === 'discount');
  const hasCollaboration = locatedMatches.some(match => match.kind === 'collaboration');
  const hasRecommendation = locatedMatches.some(match => match.kind === 'recommendation');
  const hasSponsorshipDisclosure = locatedMatches.some(match => match.kind === 'sponsorship');
  const promotionSignals = locatedMatches.filter(match => match.kind === 'discount' || match.kind === 'collaboration');
  const positiveSignalKinds = new Set(promotionSignals.filter(match => match.polarity === 'positive').map(match => match.kind));
  const announcementPolarity = positiveSignalKinds.size === 0 ? 'negated_or_ambiguous'
    : promotionSignals.some(match => match.polarity !== 'positive') ? 'mixed' : 'positive';
  const announcementKind = hasDiscount && hasCollaboration ? 'discount_and_collaboration'
    : hasDiscount ? 'discount_announcement'
      : hasCollaboration ? 'collaboration_announcement' : null;
  const allSpans = [];
  const uniqueSpanKeys = new Set();
  for (const match of locatedMatches.filter(item => item.kind === 'discount' || item.kind === 'collaboration')) {
    const span = { field: match.field, kind: match.kind, polarity: match.polarity,
      ...spanAround(match.field === 'title' ? video.title : video.description, match) };
    const key = `${span.field}:${span.start}:${span.end}:${span.kind}:${span.excerpt}`;
    if (uniqueSpanKeys.has(key)) continue;
    uniqueSpanKeys.add(key);
    allSpans.push(span);
  }
  allSpans.sort((a, b) => (a.kind === 'discount' ? 0 : 1) - (b.kind === 'discount' ? 0 : 1)
    || a.field.localeCompare(b.field) || a.start - b.start);
  const spans = allSpans.slice(0, MAX_SPANS);
  const sourceEvidence = {
    '@id': evidenceId,
    '@type': ['SourceEvidence', 'prov:Entity'],
    source_type: 'creator_public_video',
    source_ref: video.sourceUrl,
    sourceNativeId: video.videoId,
    captured_at: video.observedAt,
    valid_until: null,
    product_scope: productReferences.some(reference => reference.sourceBound) ? 'product_reference_observed' : 'unspecified',
    usage_context: 'creator_promotion_discovery',
    independence_cluster: `youtube:${video.channelId}:${video.videoId}`,
    ad_or_sponsorship_signal: hasSponsorshipDisclosure ? 'disclosure_term_observed' : 'not_observed',
    observed_fields: ['channelId', 'title', 'descriptionCueSpans', ...(video.publishedAt ? ['publishedAt'] : [])],
    content_hash: hash,
    hashAlgorithm: 'sha256',
    httpStatus: sourceStatus(video.sourceReceipt),
    trustedCapture: trustedVideo,
    excerptLimit: MAX_EXCERPT_LENGTH,
    ...(boundVideoResponseHash(video) ? { responseHash: boundVideoResponseHash(video) } : {}),
    sourceSpans: spans,
  };
  const creator = {
    '@id': creatorId,
    '@type': 'Creator',
    platform: 'youtube',
    platformAccountId: video.channelId,
    ...(video.channelTitle ? { displayName: redactPublicText(video.channelTitle) } : {}),
    canonicalUrl: `https://www.youtube.com/channel/${encodeURIComponent(video.channelId)}`,
    evidence: [evidenceId],
  };
  const content = {
    '@id': contentId,
    '@type': ['Content', 'schema:VideoObject'],
    platform: 'youtube',
    platformContentId: video.videoId,
    title: redactPublicText(video.title),
    canonicalUrl: video.sourceUrl,
    ...(video.publishedAt ? { publishedAt: video.publishedAt } : {}),
    creator: creatorId,
    evidence: [evidenceId],
    ...(spans.length ? { excerpts: spans.map(span => span.excerpt) } : {}),
    ...(productReferences.length ? { productReferences } : {}),
  };
  const discountText = allSpans.filter(span => span.kind === 'discount')
    .map(span => (span.field === 'title' ? video.title : video.description).slice(span.start, span.end)).join('\n');
  const reportedPromoCodes = parseReportedCodes(discountText);
  const reportedDiscountPercents = parseReportedDiscounts(discountText);
  const discountSignals = locatedMatches.filter(match => match.kind === 'discount');
  const collaborationSignals = locatedMatches.filter(match => match.kind === 'collaboration');
  const polarityFor = signals => signals.length === 0 ? null
    : signals.every(signal => signal.polarity === 'positive') ? 'positive'
      : signals.every(signal => signal.polarity !== 'positive') ? 'negated_or_ambiguous' : 'mixed';
  const discountPolarity = polarityFor(discountSignals);
  const collaborationPolarity = polarityFor(collaborationSignals);
  let announcements = [];
  if (announcementKind && MAX_ANNOUNCEMENTS_PER_VIDEO > 0) {
    const promotionSpan = spans.find(span => span.kind === 'discount') ?? null;
    const collaborationSpan = spans.find(span => span.kind === 'collaboration') ?? null;
    const primarySpan = promotionSpan ?? collaborationSpan ?? spans[0] ?? null;
    const excerpt = primarySpan?.excerpt ?? video.title.slice(0, MAX_EXCERPT_LENGTH);
    const announcementId = idFor('announcement', {
      videoId: video.videoId, kind: announcementKind,
      excerptHash: createHash('sha256').update(excerpt).digest('hex'),
    });
    const sourceStatus200 = sourceEvidence.httpStatus === 200 && trustedVideo;
    const claim = {
      claimId: idFor('claim', { announcementId, excerpt }),
      text: `The creator video reports: ${excerpt}`,
      claim_type: 'creator_announcement',
      sources: [evidenceId],
      support: sourceStatus200 && primarySpan?.polarity === 'positive' ? 'supports' : 'uncertain',
      allowed_wording: 'Attribute the statement to this creator video and its capture time.',
      forbidden_wording: [
        'The discount is currently available without a matching fresh merchant source.',
        'A formal brand partnership is confirmed by creator wording alone.',
      ],
      checked_at: video.observedAt,
      expires_at: null,
    };
    announcements = [{
      id: announcementId,
      kind: announcementKind,
      collaborationKind: hasCollaboration ? explicitCollaborationKind(`${video.title}\n${video.description}`) : null,
      creatorId,
      contentId,
      sourceEvidenceId: evidenceId,
      sourceSpan: primarySpan,
      promotionSpan,
      collaborationSpan,
      excerpt,
      reportedPromoCodes,
      reportedDiscountPercents,
      productReferences,
      polarity: announcementPolarity,
      discountPolarity,
      collaborationPolarity,
      containsRecommendationSignal: hasRecommendation,
      sponsorshipDisclosureSignal: hasSponsorshipDisclosure ? 'disclosure_term_observed' : 'not_observed',
      announcementStatus: 'unverified_announcement',
      verificationStatus: 'unverified_announcement',
      validityStatus: 'unknown',
      claim,
    }];
  }
  return {
    creator,
    content,
    sourceEvidence,
    announcements,
    diagnostics: {
      videoId: video.videoId,
      recommendationOnly: hasRecommendation && !announcementKind,
      sponsorshipDisclosureSignal: hasSponsorshipDisclosure ? 'disclosure_term_observed' : 'not_observed',
      productReferenceCount: productReferences.length,
      announcementCount: announcements.length,
    },
  };
}

function finiteAmount(value, name) {
  const decimalString = typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.trim());
  if (typeof value !== 'number' && !decimalString) throw new TypeError(`${name} must be a number or a plain decimal string`);
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  const amount = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isFinite(amount) || amount < 0) throw new TypeError(`${name} must be a nonnegative number`);
  return amount;
}

function validateMerchantObservation(observation, index, officialOriginAllowlist, trustedMerchantVerifier) {
  const prefix = `merchantObservations[${index}]`;
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) throw new TypeError(`${prefix} must be an object`);
  const provider = text(observation.provider, `${prefix}.provider`, { max: 100 });
  const productId = text(String(observation.productId ?? ''), `${prefix}.productId`, { max: 300 });
  const variantId = text(String(observation.variantId ?? ''), `${prefix}.variantId`, { max: 300 });
  const market = text(observation.market, `${prefix}.market`, { max: 20 }).toUpperCase();
  const currency = text(observation.currency, `${prefix}.currency`, { max: 3 }).toUpperCase();
  if (!/^[A-Z]{2,3}$/.test(market)) throw new TypeError(`${prefix}.market must be an explicit market code`);
  if (!/^[A-Z]{3}$/.test(currency)) throw new TypeError(`${prefix}.currency must be an ISO currency code`);
  const title = text(observation.title, `${prefix}.title`, { max: MAX_TITLE_LENGTH });
  const canonicalProductUrl = publicHttpsUrl(observation.canonicalProductUrl, `${prefix}.canonicalProductUrl`);
  const sourceUrl = publicHttpsUrl(observation.sourceUrl, `${prefix}.sourceUrl`);
  const productOrigin = new URL(canonicalProductUrl).origin;
  const sourceOrigin = new URL(sourceUrl).origin;
  const checkedAt = fullInstant(observation.checkedAt, `${prefix}.checkedAt`);
  const validFrom = fullInstant(observation.validFrom, `${prefix}.validFrom`, { optional: true });
  const validThrough = fullInstant(observation.validThrough, `${prefix}.validThrough`, { optional: true });
  if (validFrom && validThrough && Date.parse(validFrom) >= Date.parse(validThrough)) throw new TypeError(`${prefix} validity interval is empty or reversed`);
  const price = finiteAmount(observation.price, `${prefix}.price`);
  const priceBasis = observation.priceBasis == null ? null : text(observation.priceBasis, `${prefix}.priceBasis`, { max: 80 });
  const listedPrice = observation.listedPrice == null ? null : finiteAmount(observation.listedPrice, `${prefix}.listedPrice`);
  const discountPercent = observation.discountPercent == null ? null : finiteAmount(observation.discountPercent, `${prefix}.discountPercent`);
  if (discountPercent != null && discountPercent > 100) throw new TypeError(`${prefix}.discountPercent must not exceed 100`);
  const promoCode = observation.promoCode == null ? null : text(observation.promoCode, `${prefix}.promoCode`, { max: 100 });
  const sourceReceipt = observation.sourceReceipt == null ? {} : observation.sourceReceipt;
  if (typeof sourceReceipt !== 'object' || Array.isArray(sourceReceipt)) throw new TypeError(`${prefix}.sourceReceipt must be an object`);
  const httpStatus = sourceReceipt.httpStatus ?? sourceReceipt.status;
  const responseHash = sourceReceipt.responseHash ?? sourceReceipt.contentHash;
  const receiptUrl = sourceReceipt.sourceUrl == null ? sourceUrl : publicHttpsUrl(sourceReceipt.sourceUrl, `${prefix}.sourceReceipt.sourceUrl`);
  const receiptOrigin = new URL(receiptUrl).origin;
  const configuredOrigins = new Set(officialOriginAllowlist[provider] ?? []);
  const sameOriginProof = sourceOrigin === productOrigin && receiptOrigin === productOrigin;
  const allowlistProof = configuredOrigins.has(sourceOrigin) && configuredOrigins.has(receiptOrigin) && configuredOrigins.has(productOrigin);
  const verifierView = {
    provider, productId, variantId, market, currency, title,
    canonicalProductUrl, sourceUrl, checkedAt, validFrom, validThrough,
    price, listedPrice, discountPercent, promoCode, priceBasis: observation.priceBasis ?? null,
    eligibilityStatus: observation.eligibilityStatus ?? 'unknown',
    sourceReceipt: { httpStatus, responseHash: typeof responseHash === 'string' && HASH_PATTERN.test(responseHash) ? responseHash.toLowerCase() : null },
  };
  const trustedReceipt = trustedCallback(trustedMerchantVerifier, observation, verifierView);
  const officialFirstParty = trustedReceipt
    && httpStatus === 200
    && typeof responseHash === 'string' && HASH_PATTERN.test(responseHash)
    && (sameOriginProof || allowlistProof);
  const eligibility = observation.eligibility;
  if (observation.active != null && typeof observation.active !== 'boolean') throw new TypeError(`${prefix}.active must be boolean when present`);
  if (observation.brand != null) text(observation.brand, `${prefix}.brand`, { max: 300 });
  if (eligibility?.termsObserved != null) text(eligibility.termsObserved, `${prefix}.eligibility.termsObserved`, { max: 4_000 });
  const conditionsKnown = observation.eligibilityStatus === 'known'
    && eligibility && typeof eligibility === 'object' && !Array.isArray(eligibility)
    && typeof eligibility.couponRequired === 'boolean'
    && typeof eligibility.membershipRequired === 'boolean'
    && typeof eligibility.termsObserved === 'string' && Boolean(eligibility.termsObserved.trim())
    && Array.isArray(eligibility.eligibleMarkets) && eligibility.eligibleMarkets.includes(market)
    && ['current_payable', 'coupon_payable', 'sale_price'].includes(priceBasis)
    && (!eligibility.couponRequired || priceBasis === 'coupon_payable');
  const stockState = observation.stockState == null ? 'unknown' : text(observation.stockState, `${prefix}.stockState`, { max: 80 });
  return {
    ...observation,
    provider, productId, variantId, market, currency, title, canonicalProductUrl, sourceUrl,
    checkedAt, validFrom, validThrough, price, listedPrice, discountPercent, promoCode, priceBasis, stockState,
    sourceReceipt,
    trustedReceipt,
    officialOriginPolicy: sameOriginProof ? 'same_origin' : allowlistProof ? 'configured_origin_allowlist' : 'unverified_origin',
    officialFirstParty,
    responseHash: typeof responseHash === 'string' && HASH_PATTERN.test(responseHash) ? responseHash.toLowerCase() : null,
    httpStatus: Number.isInteger(httpStatus) ? httpStatus : null,
    conditionsKnown,
  };
}

function sourceBoundProductMatch(announcement, observation) {
  const refs = (announcement.productReferences ?? []).filter(reference => reference.sourceBound && reference.directProductUrl);
  if (refs.length !== 1) return false;
  return refs.some(reference => reference.directProductUrl
    && reference.provider === observation.provider
    && reference.productId === observation.productId
    && reference.variantId === observation.variantId
    && reference.market === observation.market
    && reference.directProductUrl === observation.canonicalProductUrl);
}

function exactAnnouncementMatch(announcement, observation) {
  if (!['discount_announcement', 'discount_and_collaboration'].includes(announcement.kind)
      || announcement.discountPolarity !== 'positive') return false;
  if (announcement.reportedPromoCodes.length > 1 || announcement.reportedDiscountPercents.length > 1) return false;
  if (!sourceBoundProductMatch(announcement, observation)) return false;
  if (announcement.reportedPromoCodes.length > 0) {
    if (!observation.promoCode || !announcement.reportedPromoCodes.includes(observation.promoCode)) return false;
  }
  if (announcement.reportedDiscountPercents.length > 0) {
    if (observation.discountPercent == null || !announcement.reportedDiscountPercents.includes(observation.discountPercent)) return false;
  }
  return true;
}

function observationValidity(observation, generatedAt, freshnessMs) {
  const now = Date.parse(generatedAt);
  const checked = Date.parse(observation.checkedAt);
  if (observation.validThrough && now >= Date.parse(observation.validThrough)) return 'expired';
  if (observation.validFrom && now < Date.parse(observation.validFrom)) return 'not_yet_active';
  if (checked > now || now - checked > freshnessMs) return 'stale';
  if (!observation.validFrom || !observation.validThrough) return 'unknown';
  if (observation.active === false) return 'inactive';
  if (observation.active !== true) return 'unknown';
  if (!observation.officialFirstParty || !observation.conditionsKnown) return 'unknown';
  return 'active';
}

function makeMerchantEvidence(observation) {
  const contentHash = observation.responseHash ?? fingerprint({
    provider: observation.provider,
    productId: observation.productId,
    variantId: observation.variantId,
    market: observation.market,
    currency: observation.currency,
    price: observation.price,
    listedPrice: observation.listedPrice,
    promoCode: observation.promoCode,
    validFrom: observation.validFrom,
    validThrough: observation.validThrough,
    eligibility: observation.eligibility,
  });
  return {
    '@id': idFor('evidence', {
      sourceType: 'merchant_first_party_offer',
      sourceRef: observation.sourceUrl,
      capturedAt: observation.checkedAt,
      contentHash,
    }),
    '@type': ['SourceEvidence', 'prov:Entity'],
    source_type: observation.officialFirstParty ? 'merchant_first_party_offer' : 'merchant_offer_candidate',
    source_ref: observation.sourceUrl,
    sourceNativeId: observation.promotionId ?? null,
    captured_at: observation.checkedAt,
    valid_until: observation.validThrough,
    product_scope: {
      provider: observation.provider, productId: observation.productId,
      variantId: observation.variantId, market: observation.market,
      currency: observation.currency,
    },
    usage_context: 'creator_promotion_verification',
    independence_cluster: `merchant:${observation.provider}:${observation.productId}:${observation.variantId}:${observation.market}`,
    ad_or_sponsorship_signal: 'not_applicable',
    observed_fields: ['productId', 'variantId', 'market', 'currency', 'price', 'listedPrice', 'promoCode', 'validFrom', 'validThrough', 'eligibility'],
    content_hash: contentHash,
    hashAlgorithm: 'sha256',
    httpStatus: observation.httpStatus,
    officialFirstParty: observation.officialFirstParty,
  };
}

function offerIdentity(observation) {
  return idFor('promotion', {
    merchant: observation.provider,
    promotionId: observation.promotionId ?? null,
    productId: observation.productId,
    variantId: observation.variantId,
    market: observation.market,
    currency: observation.currency,
    promoCode: observation.promoCode,
    validFrom: observation.validFrom,
    validThrough: observation.validThrough,
    termsHash: observation.eligibility?.termsObserved
      ? createHash('sha256').update(observation.eligibility.termsObserved).digest('hex') : null,
  });
}

function productIdFor(observation) {
  return idFor('product', {
    provider: observation.provider, productId: observation.productId,
    variantId: observation.variantId, market: observation.market,
  });
}

function mergeNode(nodes, node) {
  const old = nodes.get(node['@id']);
  if (!old) { nodes.set(node['@id'], node); return; }
  const merged = { ...old, ...node };
  for (const field of ['evidence', 'sourceEvidence', 'products']) {
    const values = [...(old[field] ?? []), ...(node[field] ?? [])];
    if (values.length) merged[field] = [...new Set(values)].sort();
  }
  nodes.set(node['@id'], merged);
}

/**
 * Builds a portable JSON-LD graph and existing-contract sidecars from normalized public videos.
 * `merchantObservations` are read-only normalized first-party offer snapshots; opaque links are
 * never followed. Exact matching requires a direct product reference carried by the video DTO.
 */
export function buildPromotionGraph({ videos, merchantObservations = [], generatedAt, freshnessMs = 24 * 60 * 60 * 1000, officialOriginAllowlist = {}, trustedVideoVerifier, trustedMerchantVerifier } = {}) {
  if (!Array.isArray(videos)) throw new TypeError('videos must be an array');
  if (!Array.isArray(merchantObservations)) throw new TypeError('merchantObservations must be an array');
  if (!officialOriginAllowlist || typeof officialOriginAllowlist !== 'object' || Array.isArray(officialOriginAllowlist)) throw new TypeError('officialOriginAllowlist must be an object');
  const normalizedOriginAllowlist = {};
  for (const [provider, origins] of Object.entries(officialOriginAllowlist)) {
    if (!provider || !Array.isArray(origins)) throw new TypeError('officialOriginAllowlist values must be arrays of HTTPS origins');
    normalizedOriginAllowlist[provider] = origins.map((origin, index) => {
      const normalized = publicHttpsUrl(origin, `officialOriginAllowlist.${provider}[${index}]`);
      const parsed = new URL(normalized);
      if (parsed.pathname !== '/' || parsed.search) throw new TypeError(`officialOriginAllowlist.${provider} entries must be bare origins`);
      return parsed.origin;
    });
  }
  const generated = fullInstant(generatedAt, 'generatedAt');
  if (!Number.isSafeInteger(freshnessMs) || freshnessMs < 0) throw new TypeError('freshnessMs must be a nonnegative safe integer');
  const nodes = new Map();
  const claims = new Map();
  const productCandidates = new Map();
  const announcementsByVideo = new Map();
  const diagnostics = { duplicateVideos: 0, unmatchedMerchantObservations: 0, staleMerchantObservations: 0, rejectedLinks: 0 };
  const seenVideos = new Map();

  for (const raw of videos) {
    const extracted = extractPromotionClaims(raw, { trustedVideoVerifier });
    const videoId = raw.videoId;
    const prior = seenVideos.get(videoId);
    if (prior) {
      if (prior.channelId !== raw.channelId) throw new TypeError(`conflicting creator identity for video ${videoId}`);
      if (prior.observedAt === raw.observedAt && prior.sourceHash !== sourceHash(raw)) throw new TypeError(`conflicting source content at identical capture time for video ${videoId}`);
      diagnostics.duplicateVideos += 1;
      if (Date.parse(raw.observedAt) <= Date.parse(prior.observedAt)) continue;
    }
    seenVideos.set(videoId, {
      channelId: raw.channelId, observedAt: raw.observedAt,
      sourceHash: sourceHash(raw), contentId: extracted.content['@id'], creatorId: extracted.creator['@id'],
      evidenceId: extracted.sourceEvidence['@id'], announcements: extracted.announcements,
      claimIds: extracted.announcements.map(item => item.claim.claimId),
      productReferences: extracted.announcements[0]?.productReferences ?? [],
    });
    mergeNode(nodes, extracted.creator);
    mergeNode(nodes, extracted.content);
    mergeNode(nodes, extracted.sourceEvidence);
    announcementsByVideo.delete(videoId);
    diagnostics.rejectedLinks += extracted.content.productReferences?.filter(reference => !reference.directProductUrl).length ?? 0;
    for (const announcement of extracted.announcements) {
      claims.set(announcement.claim.claimId, announcement.claim);
      announcementsByVideo.set(videoId, announcement);
      if (announcement.kind === 'discount_announcement' || announcement.kind === 'discount_and_collaboration') {
        mergeNode(nodes, {
          '@id': announcement.id,
          '@type': ['Promotion', 'schema:Offer'],
          announcementKind: announcement.kind,
          announcementStatus: announcement.announcementStatus,
          verificationStatus: announcement.verificationStatus,
          validityStatus: announcement.validityStatus,
          polarity: announcement.discountPolarity,
          claimId: announcement.claim.claimId,
          creator: announcement.creatorId,
          content: announcement.contentId,
          evidence: [announcement.sourceEvidenceId],
          reportedPromoCodes: announcement.reportedPromoCodes,
          reportedDiscountPercents: announcement.reportedDiscountPercents,
          excerpt: announcement.excerpt,
          sourceSpans: announcement.promotionSpan ? [announcement.promotionSpan] : [],
          verificationNote: 'Creator statement only; current merchant eligibility, price, and validity are unverified.',
        });
      }
      if (announcement.kind === 'collaboration_announcement' || announcement.kind === 'discount_and_collaboration') {
        const collaborationId = idFor('collaboration', { announcementId: announcement.id, kind: announcement.collaborationKind });
        announcement.collaborationId = collaborationId;
        mergeNode(nodes, {
          '@id': collaborationId,
          '@type': 'Collaboration',
          collaborationKind: announcement.collaborationKind,
          announcementStatus: 'unverified_announcement',
          verificationStatus: 'unverified_announcement',
          polarity: announcement.collaborationPolarity,
          creator: announcement.creatorId,
          content: announcement.contentId,
          evidence: [announcement.sourceEvidenceId],
          excerpt: announcement.excerpt,
          sourceSpans: announcement.collaborationSpan ? [announcement.collaborationSpan] : [],
          verificationNote: 'Creator content mentions collaboration; formal brand confirmation is absent.',
        });
      }
    }
  }

  const validatedObservations = merchantObservations.map((observation, index) => validateMerchantObservation(observation, index, normalizedOriginAllowlist, trustedMerchantVerifier))
    .sort((a, b) => Date.parse(a.checkedAt) - Date.parse(b.checkedAt)
      || a.provider.localeCompare(b.provider) || a.productId.localeCompare(b.productId)
      || a.variantId.localeCompare(b.variantId) || (a.responseHash ?? '').localeCompare(b.responseHash ?? ''));
  for (const observation of validatedObservations) {
    const merchantEvidence = makeMerchantEvidence(observation);
    mergeNode(nodes, merchantEvidence);
    const productId = productIdFor(observation);
    const product = {
      '@id': productId,
      '@type': 'schema:Product',
      provider: observation.provider,
      productId: observation.productId,
      variantId: observation.variantId,
      market: observation.market,
      currency: observation.currency,
      title: observation.title,
      ...(observation.brand ? { brand: observation.brand } : {}),
      canonicalUrl: observation.canonicalProductUrl,
      evidence: [merchantEvidence['@id']],
    };
    mergeNode(nodes, product);
    const payableBasis = ['current_payable', 'coupon_payable', 'sale_price'].includes(observation.priceBasis);
    const validityStatus = observationValidity(observation, generated, freshnessMs);
    if (validityStatus === 'stale') diagnostics.staleMerchantObservations += 1;
    const freshObservation = Date.parse(observation.checkedAt) <= Date.parse(generated)
      && Date.parse(generated) - Date.parse(observation.checkedAt) <= freshnessMs;
    const priceVerified = observation.officialFirstParty && observation.httpStatus === 200
      && observation.responseHash && observation.conditionsKnown && payableBasis && freshObservation
      && (observation.priceBasis === 'current_payable' || validityStatus === 'active');
    const productCandidate = {
      provider: observation.provider,
      program: 'creator_promotion_collection',
      productId: observation.productId,
      title: observation.title,
      ...(observation.brand ? { brand: observation.brand } : {}),
      variant: { id: observation.variantId },
      priceBasis: observation.priceBasis ?? 'merchant_observed',
      ...(priceVerified ? { payablePrice: observation.price } : { observedPrice: { amount: observation.price, currency: observation.currency } }),
      currency: observation.currency,
      priceVerificationStatus: priceVerified ? 'first_party_fresh' : 'unverified_observation',
      stockState: observation.stockState,
      couponRequired: observation.conditionsKnown ? observation.eligibility.couponRequired : null,
      membershipRequired: observation.conditionsKnown ? observation.eligibility.membershipRequired : null,
      ...(observation.currency === 'KRW' && priceVerified ? { payablePriceKrw: observation.price } : {}),
      ...(observation.listedPrice == null ? {} : { listedPrice: { amount: observation.listedPrice, currency: observation.currency } }),
      checkedAt: observation.checkedAt,
      evidenceRefs: [merchantEvidence['@id']],
    };
    const candidateKey = `${observation.provider}\u0000${observation.productId}\u0000${observation.variantId}\u0000${observation.market}`;
    productCandidates.set(candidateKey, productCandidate);
    const linked = [];
    for (const [videoId, announcement] of announcementsByVideo) {
      if (!exactAnnouncementMatch(announcement, observation)) continue;
      linked.push({ videoId, announcement });
    }
    if (!linked.length) diagnostics.unmatchedMerchantObservations += 1;
    const merchantPromotionId = offerIdentity(observation);
    const sourceAllowsVerification = observation.officialFirstParty && observation.httpStatus === 200
      && observation.responseHash && observation.conditionsKnown;
    const fullyDated = Boolean(observation.validFrom && observation.validThrough);
    const fresh = validityStatus !== 'stale';
    const merchantVerified = sourceAllowsVerification && fullyDated && fresh
      && validityStatus !== 'unknown';
    mergeNode(nodes, {
      '@id': merchantPromotionId,
      '@type': ['Promotion', 'schema:Offer'],
      announcementStatus: 'merchant_observation',
      verificationStatus: merchantVerified ? 'merchant_verified' : 'unverified_announcement',
      validityStatus,
      provider: observation.provider,
      productId: observation.productId,
      variantId: observation.variantId,
      market: observation.market,
      locale: observation.locale ?? observation.market,
      product: productId,
      evidence: [merchantEvidence['@id']],
      sourceEvidence: [merchantEvidence['@id']],
      sourceReceipt: {
        sourceType: observation.sourceReceipt.sourceType ?? null,
        httpStatus: observation.httpStatus,
        officialFirstParty: observation.officialFirstParty,
        officialOriginPolicy: observation.officialOriginPolicy,
        responseHash: observation.responseHash,
      },
      price: observation.price,
      priceCurrency: observation.currency,
      priceBasis: observation.priceBasis ?? 'merchant_observed',
      ...(observation.listedPrice == null ? {} : { listedPrice: observation.listedPrice }),
      ...(observation.discountPercent == null ? {} : { discountPercent: observation.discountPercent }),
      ...(observation.promoCode == null ? {} : { promoCode: observation.promoCode }),
      ...(observation.validFrom ? { validFrom: observation.validFrom } : {}),
      ...(observation.validThrough ? { validThrough: observation.validThrough } : {}),
      checkedAt: observation.checkedAt,
      eligibilityStatus: observation.conditionsKnown ? 'known' : 'unknown',
      eligibility: observation.conditionsKnown ? {
        status: 'known',
        couponRequired: observation.eligibility.couponRequired,
        membershipRequired: observation.eligibility.membershipRequired,
        eligibleMarkets: [...observation.eligibility.eligibleMarkets].map(String).sort(),
        termsObserved: observation.eligibility.termsObserved.trim(),
      } : { status: 'unknown' },
      terms: observation.conditionsKnown ? observation.eligibility.termsObserved.trim() : null,
      active: observation.active === true && validityStatus === 'active',
      verifiesAnnouncement: linked.map(({ announcement }) => announcement.id),
      verificationNote: merchantVerified
        ? linked.length
          ? 'Fresh first-party offer is active and matches the exact creator product, variant, market, code or stated discount, validity interval, and eligibility.'
          : 'Fresh first-party offer is verified for this exact product, variant, market, validity interval, and eligibility; no exact creator announcement link was established.'
        : 'Merchant snapshot does not satisfy every exact-scope, freshness, date, source, or eligibility requirement for current verification.',
    });
    for (const { announcement } of linked) {
      const announcementNode = nodes.get(announcement.id);
      if (!announcementNode) continue;
      const currentlyVerified = merchantVerified;
      mergeNode(nodes, {
        '@id': announcement.id,
        verificationStatus: currentlyVerified ? 'merchant_verified' : 'unverified_announcement',
        validityStatus,
        product: productId,
        provider: observation.provider,
        productId: observation.productId,
        variantId: observation.variantId,
        market: observation.market,
        priceCurrency: observation.currency,
        price: observation.price,
        ...(observation.validFrom ? { validFrom: observation.validFrom } : {}),
        ...(observation.validThrough ? { validThrough: observation.validThrough } : {}),
        eligibilityStatus: observation.conditionsKnown ? 'known' : 'unknown',
        sourceEvidence: [merchantEvidence['@id']],
        verifiesPromotion: merchantPromotionId,
      });
    }
  }

  const graph = {
    '@context': CREATOR_PROMOTION_CONTEXT,
    '@id': idFor('graph', { generatedAt: generated, videoIds: [...seenVideos.keys()].sort() }),
    '@type': 'ccp:CreatorPromotionGraph',
    graphVersion: CREATOR_PROMOTION_SCHEMA_VERSION,
    generatedAt: generated,
    '@graph': [...nodes.values()].sort((a, b) => a['@id'].localeCompare(b['@id'])),
  };
  const result = {
    graph,
    sourceEvidence: graph['@graph'].filter(node => node['@type']?.includes?.('SourceEvidence')),
    claims: [...claims.values()].sort((a, b) => a.claimId.localeCompare(b.claimId)),
    productCandidates: [...productCandidates.values()].sort((a, b) => `${a.provider}:${a.productId}:${a.variant?.id}`.localeCompare(`${b.provider}:${b.productId}:${b.variant?.id}`)),
    diagnostics,
  };
  validatePromotionGraph(result);
  return result;
}

/** Validates graph invariants and references. It does not validate merchant adapter truth. */
export function validatePromotionGraph(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new TypeError('promotion graph result must be an object');
  const graph = result.graph;
  if (!graph || graph.graphVersion !== CREATOR_PROMOTION_SCHEMA_VERSION || !Array.isArray(graph['@graph'])) throw new TypeError('promotion graph envelope is invalid');
  fullInstant(graph.generatedAt, 'graph.generatedAt');
  const nodes = new Map();
  for (const node of graph['@graph']) {
    if (!node || typeof node !== 'object' || Array.isArray(node) || typeof node['@id'] !== 'string' || !node['@id'].startsWith('urn:creator-promotion:')) {
      throw new TypeError('every graph node needs a creator-promotion URN @id');
    }
    if (nodes.has(node['@id'])) throw new TypeError(`duplicate graph node ${node['@id']}`);
    nodes.set(node['@id'], node);
  }
  const references = ['creator', 'content', 'brand', 'product', 'verifiesAnnouncement', 'verifiesPromotion'];
  for (const node of nodes.values()) {
    for (const key of references) {
      const value = node[key];
      if (typeof value === 'string' && value.startsWith('urn:') && !nodes.has(value)) throw new TypeError(`unresolved ${key} reference from ${node['@id']}`);
      if (Array.isArray(value)) for (const id of value) {
        if (typeof id === 'string' && id.startsWith('urn:') && !nodes.has(id)) throw new TypeError(`unresolved ${key} reference from ${node['@id']}`);
      }
    }
    for (const key of ['evidence', 'sourceEvidence']) {
      for (const id of node[key] ?? []) if (!nodes.has(id)) throw new TypeError(`unresolved ${key} reference from ${node['@id']}`);
    }
    if (node['@type']?.includes?.('SourceEvidence') && !HASH_PATTERN.test(node.content_hash ?? '')) throw new TypeError(`invalid evidence hash on ${node['@id']}`);
    if (node.verificationStatus === 'merchant_verified' && node.validityStatus === 'active') {
      if (!node.product || !node.market || !node.priceCurrency || !node.validFrom || !node.validThrough || node.eligibilityStatus !== 'known') {
        throw new TypeError(`active verified promotion lacks exact scope or conditions: ${node['@id']}`);
      }
    }
  }
  for (const claim of result.claims ?? []) {
    if (!claim || typeof claim.claimId !== 'string' || !Array.isArray(claim.sources) || claim.sources.length === 0) throw new TypeError('creator announcement claim is invalid');
    if (!['supports', 'contradicts', 'not_addressed', 'uncertain'].includes(claim.support)) throw new TypeError(`invalid claim support ${claim.claimId}`);
    for (const id of claim.sources) if (!nodes.has(id)) throw new TypeError(`claim source ${id} is unresolved`);
  }
  for (const product of result.productCandidates ?? []) {
    if (!product.provider || !product.productId || !product.title || !product.checkedAt || !Array.isArray(product.evidenceRefs) || product.evidenceRefs.length === 0) {
      throw new TypeError('product candidate lacks existing-contract keys or evidence');
    }
    if (Object.hasOwn(product, 'payablePriceKrw') && (!Number.isFinite(product.payablePriceKrw) || product.payablePriceKrw < 0)) {
      throw new TypeError('product candidate payablePriceKrw must be a nonnegative number');
    }
  }
  return true;
}
