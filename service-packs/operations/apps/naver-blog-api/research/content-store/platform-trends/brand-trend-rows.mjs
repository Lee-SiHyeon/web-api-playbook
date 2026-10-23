const DEFAULT_OBSERVED_AT = () => new Date().toISOString();
const SENSITIVE_ASSIGNMENT = /(?:^|[\s"'([{,?&;])(?:cookie|set-cookie|authorization|proxy-authorization|(?:access|refresh|id|auth|csrf|xsrf)?[_-]?token|csrf(?:token)?|xsrf(?:token)?|ct0|password|passwd|fb_dtsg|lsd|jazoest|dtsg|hsi|sapisid|signature|sig|hmac|bearer|credential|claim)\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s&,;)}\]]+)/i;
const BEARER_OR_JWT = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/-]+=*|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/i;
const MAX_TRAVERSAL_DEPTH = 64;
const MAX_TRAVERSAL_NODES = 50_000;
const SUPPORTED_INSTRUCTION_TYPES = new Set([
  'TimelineAddEntries',
  'TimelineAddToModule',
  'TimelineReplaceEntry',
  'TimelinePinEntry',
  'TimelineRemoveEntry',
  'TimelineClearCache',
  'TimelineTerminateTimeline',
  'TimelineShowAlert',
  'TimelineShowCover',
]);

function responseError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeText(value, { stripQuery = false } = {}) {
  if (typeof value !== 'string') return null;
  let text = value.trim();
  if (!text) return null;
  text = text.replace(/(?:https?:)?\/\/[^\s"'<>]+/gi, (url) => {
    const end = url.search(/[?#]/);
    return end < 0 ? url : url.slice(0, end);
  });
  if (stripQuery) {
    const end = text.search(/[?#]/);
    if (end >= 0) text = text.slice(0, end);
  }
  if (SENSITIVE_ASSIGNMENT.test(text) || BEARER_OR_JWT.test(text)) return null;
  return text || null;
}

function safeUrl(value) {
  const text = safeText(value, { stripQuery: true });
  if (!text) return null;
  try {
    const url = new URL(text, 'https://relative.invalid');
    if (url.hostname === 'relative.invalid') return `${url.pathname}` || null;
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return text;
  }
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(String(value).replaceAll(',', '').trim());
  return Number.isFinite(number) ? number : null;
}

function safeStringArray(values) {
  if (!Array.isArray(values)) return [];
  return values.map((value) => safeText(String(value))).filter(Boolean);
}

function safeCurve(values) {
  if (!Array.isArray(values)) return [];
  return values.flatMap((point) => {
    if (!point || typeof point !== 'object') return [];
    const timestamp = finiteNumber(point.timestamp);
    const value = finiteNumber(point.value);
    return timestamp === null || value === null ? [] : [{ timestamp, value }];
  });
}

/**
 * Build a row using only ontology fields and the explicitly supported extensions.
 * Unknown properties are intentionally discarded; absent metrics remain null.
 */
export function canonicalRow(fields = {}) {
  const postCount = finiteNumber(fields.post_count);
  const views = finiteNumber(fields.views);
  const volume = finiteNumber(fields.volume);
  const suppliedUnits = safeText(fields.metric_units);
  return {
    source_id: safeText(fields.source_id),
    platform: safeText(fields.platform),
    market: safeText(fields.market),
    observed_at: safeText(fields.observed_at) ?? DEFAULT_OBSERVED_AT(),
    period_days: finiteNumber(fields.period_days),
    account_scope: safeText(fields.account_scope),
    trend_id: safeText(fields.trend_id),
    label: safeText(fields.label),
    rank: finiteNumber(fields.rank),
    rank_change: finiteNumber(fields.rank_change),
    volume,
    views,
    post_count: postCount,
    curve: safeCurve(fields.curve),
    related_content_ids: safeStringArray(fields.related_content_ids),
    related_urls: Array.isArray(fields.related_urls)
      ? fields.related_urls.map(safeUrl).filter(Boolean)
      : [],
    creator_ids: safeStringArray(fields.creator_ids),
    audio_id: safeText(fields.audio_id),
    industry_ids: safeStringArray(fields.industry_ids),
    access: safeText(fields.access),
    endpoint: safeUrl(fields.endpoint),
    verdict: safeText(fields.verdict),
    http_status: finiteNumber(fields.http_status),
    capture_ref: safeText(fields.capture_ref, { stripQuery: true }),
    limitations: safeStringArray(fields.limitations),
    surface: safeText(fields.surface),
    context: safeText(fields.context),
    category: safeText(fields.category),
    location: safeText(fields.location),
    personalized: typeof fields.personalized === 'boolean' ? fields.personalized : null,
    metric_units: suppliedUnits ?? (postCount !== null ? 'posts' : views !== null ? 'views' : volume !== null ? 'volume' : null),
    traffic: fields.traffic === 'high' || fields.traffic === 'low' ? fields.traffic : 'medium',
  };
}

function parsePublicPostCount(description) {
  if (typeof description !== 'string') return null;
  const match = description.match(/(?:^|\b)(\d[\d,]*(?:\.\d+)?)\s*([KMB])?\s+posts?\b/i);
  if (!match) return null;
  const base = Number(match[1].replaceAll(',', ''));
  const multiplier = ({ K: 1_000, M: 1_000_000, B: 1_000_000_000 })[String(match[2] ?? '').toUpperCase()] ?? 1;
  const count = base * multiplier;
  return Number.isFinite(count) ? Math.round(count) : null;
}

function categoryFromContext(context) {
  if (!context) return null;
  const separator = context.indexOf('·');
  return separator < 0 ? null : safeText(context.slice(0, separator));
}

function isTimelineTrend(itemContent) {
  return itemContent && typeof itemContent === 'object'
    && (itemContent.__typename === 'TimelineTrend' || itemContent.itemType === 'TimelineTrend');
}

function validateXResponse(payload, httpStatus) {
  if (httpStatus !== undefined && httpStatus !== null && Number(httpStatus) !== 200) {
    throw responseError('x_explore_http_status');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw responseError('x_explore_schema_drift');
  }
  if ((payload.error !== undefined && payload.error !== null && payload.error !== false && payload.error !== '')
    || (payload.errors !== undefined && payload.errors !== null
      && (!Array.isArray(payload.errors) || payload.errors.length > 0))) {
    throw responseError('x_explore_response_error');
  }
  const instructions = payload?.data?.timeline?.timeline?.instructions;
  if (!Array.isArray(instructions)) throw responseError('x_explore_schema_drift');
  for (const instruction of instructions) {
    if (!instruction || typeof instruction !== 'object' || Array.isArray(instruction)
      || !SUPPORTED_INSTRUCTION_TYPES.has(instruction.type)) {
      throw responseError('x_explore_schema_drift');
    }
    if (instruction.type === 'TimelineAddEntries' && !Array.isArray(instruction.entries)) {
      throw responseError('x_explore_schema_drift');
    }
  }
  return instructions;
}

function findTimelineTrends(instructions) {
  const found = [];
  const seen = new WeakSet();
  let visitedNodes = 0;
  const visit = (value, depth = 0) => {
    if (depth > MAX_TRAVERSAL_DEPTH) throw responseError('x_explore_complexity_limit');
    visitedNodes += 1;
    if (visitedNodes > MAX_TRAVERSAL_NODES) throw responseError('x_explore_complexity_limit');
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const child of value) visit(child, depth + 1);
      return;
    }
    if (isTimelineTrend(value.itemContent)) {
      found.push(value.itemContent);
      return;
    }
    if ((value.entryType === 'TimelineTimelineModule' || value.__typename === 'TimelineTimelineModule')
      && Array.isArray(value.items)) {
      visit(value.items, depth + 1);
      return;
    }
    for (const child of Object.values(value)) visit(child, depth + 1);
  };
  visit(instructions);
  return found;
}

/** Normalize observed X Explore TimelineTrend entries to ontology-compatible rows. */
export function normalizeXTrends(payload, {
  observedAt,
  market = 'KR',
  location = market,
  surface = 'Trending',
  accountScope = 'lifehack__ailab',
  endpoint,
  captureRef,
  httpStatus,
  access = 'brand-session',
  brandTrafficEvidence = false,
} = {}) {
  const normalizedMarket = safeText(market)?.toUpperCase() ?? 'KR';
  const rows = [];
  const instructions = validateXResponse(payload, httpStatus);
  for (const item of findTimelineTrends(instructions)) {
    const label = safeText(item.name);
    if (!label) continue;
    const metadata = item.trend_metadata && typeof item.trend_metadata === 'object'
      ? item.trend_metadata
      : {};
    const context = safeText(metadata.domain_context);
    const description = safeText(metadata.meta_description);
    const postCount = parsePublicPostCount(description);
    rows.push(canonicalRow({
      source_id: 'x_explore_trends',
      platform: 'X',
      market: normalizedMarket,
      observed_at: observedAt,
      account_scope: accountScope,
      label,
      rank: item.rank,
      post_count: postCount,
      related_urls: [],
      access,
      endpoint,
      verdict: 'brand_session_required',
      http_status: httpStatus,
      capture_ref: captureRef,
      surface,
      context,
      category: categoryFromContext(context),
      location,
      personalized: true,
      metric_units: postCount === null ? null : 'posts',
      traffic: brandTrafficEvidence === true ? 'high' : 'medium',
    }));
  }
  return rows;
}
