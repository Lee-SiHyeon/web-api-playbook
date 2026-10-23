import { createHash } from 'node:crypto';
import { parseHTML } from 'linkedom';

export const TOKYO_DEV_ORIGIN = 'https://www.tokyodev.com';
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const JOB_PATH = /^\/companies\/([a-z0-9][a-z0-9_-]{0,100})\/jobs\/([a-z0-9][a-z0-9_-]{0,240})$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const JAPANESE_LEVEL_LABELS = new Set([
  'No Japanese required', 'Basic Japanese', 'Conversational Japanese', 'Business Japanese', 'Fluent Japanese',
]);

export function tokyoDevFail(code, receipt) {
  const error = new Error(code);
  error.code = code;
  if (receipt) error.receipt = receipt;
  throw error;
}

const cleanText = (value, maxLength = 2_000) => {
  if (typeof value !== 'string' || CONTROL.test(value) || value.length > maxLength) return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text || null;
};

function safeObservedJobUrl(value) {
  if (typeof value !== 'string' || value.length > 2_000 || CONTROL.test(value)) {
    tokyoDevFail('TOKYODEV_JOB_URL_INVALID');
  }
  let url;
  try { url = new URL(value, `${TOKYO_DEV_ORIGIN}/`); }
  catch { tokyoDevFail('TOKYODEV_JOB_URL_INVALID'); }
  const match = url.origin === TOKYO_DEV_ORIGIN ? JOB_PATH.exec(url.pathname) : null;
  if (!match || url.search || url.hash || url.username || url.password || url.port) {
    tokyoDevFail('TOKYODEV_JOB_URL_INVALID');
  }
  const companySlug = match[1];
  const roleSlug = match[2];
  return { url: `${url.origin}${url.pathname}`, companySlug, roleSlug, id: `${companySlug}:${roleSlug}` };
}

function parseHtml(html) {
  if (typeof html !== 'string' || Buffer.byteLength(html, 'utf8') > MAX_RESPONSE_BYTES) {
    tokyoDevFail('TOKYODEV_DOCUMENT_INVALID');
  }
  const document = parseHTML(html).document;
  if (!document.documentElement) tokyoDevFail('TOKYODEV_DOCUMENT_INVALID');
  const lower = (document.body?.textContent || document.documentElement.textContent || '').toLowerCase();
  if (/(?:verify\s+you\s+are\s+human|captcha|access\s+denied|challenge-platform)/i.test(lower)) {
    tokyoDevFail('TOKYODEV_ACCESS_CHALLENGE');
  }
  return document;
}

function companyFromCard(anchor, companySlug) {
  const companyItem = anchor.closest('li[id^="company_"]');
  if (!companyItem) tokyoDevFail('TOKYO_DEV_LIST_SCHEMA_INVALID');
  // Current HTML places an image-only company-logo link before the text name.
  const companyLink = companyItem.querySelector(`h3 a[href="/companies/${companySlug}"]`)
    ?? [...companyItem.querySelectorAll(`a[href="/companies/${companySlug}"]`)]
      .find(link => cleanText(link.textContent, 500));
  if (!companyLink) tokyoDevFail('TOKYO_DEV_LIST_IDENTITY_MISMATCH');
  const company = cleanText(companyLink.textContent, 500);
  if (!company) tokyoDevFail('TOKYO_DEV_LIST_SCHEMA_INVALID');
  return company;
}

const tagText = node => cleanText(node.textContent, 300);

function factsFromCard(anchor, companySlug) {
  const card = anchor.closest('[data-collapsable-list-target="item"]');
  if (!card) tokyoDevFail('TOKYO_DEV_LIST_SCHEMA_INVALID');
  const labels = [...card.querySelectorAll('a[href^="/jobs/"]')]
    .map(tagText).filter(Boolean);
  const compensationLabel = labels.find(value => /^¥[\d.,]+M?\s*~\s*¥?[\d.,]+M?(?:\s|$)/.test(value)) ?? null;
  const language = labels.find(value => value === 'No Japanese required' || /^(?:Basic|Conversational|Business|Fluent) Japanese$/.test(value)) ?? null;
  const residentsOnly = labels.includes('Japan residents only');
  const abroad = labels.includes('Apply from abroad');
  if (residentsOnly && abroad) tokyoDevFail('TOKYO_DEV_LIST_FACTS_CONFLICT');
  const workplaceTypeLabel = labels.find(value => ['Fully remote', 'Partially remote', 'No remote'].includes(value)) ?? null;
  const special = new Set([
    'No Japanese required', 'Basic Japanese', 'Conversational Japanese', 'Business Japanese', 'Fluent Japanese',
    'Japan residents only', 'Apply from abroad', 'Fully remote', 'Partially remote', 'No remote',
  ]);
  return {
    company: companyFromCard(anchor, companySlug),
    sourceFacts: {
      sourceId: null,
      japaneseSkillRequirement: language,
      residencyRequirement: residentsOnly ? 'Japan residents only' : null,
      canApplyFromAbroad: abroad ? true : residentsOnly ? false : null,
      workplaceTypeLabel,
      compensationLabel,
      categoryLabels: labels.filter(value => !special.has(value) && value !== compensationLabel),
    },
  };
}

function listAdvertisedCount(document) {
  const heading = cleanText(document.querySelector('main h1')?.textContent, 500);
  const match = heading && /^\/\/\s*([\d,]+)\s+IT jobs?\s+for English speakers in Japan$/i.exec(heading);
  if (!match) tokyoDevFail('TOKYO_DEV_LIST_SCHEMA_INVALID');
  const count = Number(match[1].replaceAll(',', ''));
  if (!Number.isSafeInteger(count) || count < 0 || count > 5_000) tokyoDevFail('TOKYO_DEV_LIST_SCHEMA_INVALID');
  return count;
}

function safeDate(value) {
  const date = cleanText(value, 100);
  if (!date || !Number.isFinite(Date.parse(date))) tokyoDevFail('TOKYO_DEV_DETAIL_SCHEMA_INVALID');
  return date;
}

function descriptionText(html) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > 1_500_000) {
    tokyoDevFail('TOKYO_DEV_DETAIL_SCHEMA_INVALID');
  }
  const document = parseHTML(`<div id="description-root">${html}</div>`).document;
  const root = document.querySelector('#description-root');
  if (!root) tokyoDevFail('TOKYO_DEV_DETAIL_SCHEMA_INVALID');
  for (const node of root.querySelectorAll('script,style,template,svg,iframe')) node.remove();
  const blocks = new Set(['br', 'p', 'div', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'section']);
  const visit = node => {
    if (node.nodeType === 3) return node.nodeValue ?? '';
    if (!node.childNodes) return '';
    const body = [...node.childNodes].map(visit).join('');
    return blocks.has((node.tagName ?? '').toLowerCase()) ? `${body}\n` : body;
  };
  const result = visit(root).replace(/\r/g, '').replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!result || result.length > 1_000_000 || CONTROL.test(result)) tokyoDevFail('TOKYO_DEV_DETAIL_SCHEMA_INVALID');
  return result;
}

function postingJsonLd(document) {
  const postings = [];
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    const content = script.textContent;
    if (!content || content.length > 2_000_000) tokyoDevFail('TOKYO_DEV_DETAIL_SCHEMA_INVALID');
    let payload;
    try { payload = JSON.parse(content); } catch { tokyoDevFail('TOKYO_DEV_DETAIL_SCHEMA_INVALID'); }
    const nodes = Array.isArray(payload) ? payload : [payload];
    postings.push(...nodes.filter(node => node && node['@type'] === 'JobPosting'));
  }
  if (postings.length !== 1) tokyoDevFail('TOKYO_DEV_DETAIL_SCHEMA_INVALID');
  return postings[0];
}

function locationFrom(value) {
  if (value === null || value === undefined) return { location: null, locations: [] };
  const places = Array.isArray(value) ? value : [value];
  const labels = places.map((place, index) => {
    if (!place || typeof place !== 'object' || Array.isArray(place)) tokyoDevFail('TOKYO_DEV_DETAIL_SCHEMA_INVALID');
    const address = place.address;
    if (!address || typeof address !== 'object' || Array.isArray(address)) tokyoDevFail('TOKYO_DEV_DETAIL_SCHEMA_INVALID');
    const city = cleanText(address.addressLocality, 200);
    const region = cleanText(address.addressRegion, 200);
    const country = cleanText(address.addressCountry, 8);
    const label = [city, region, country].filter(Boolean).join(', ');
    if (!label) tokyoDevFail('TOKYO_DEV_DETAIL_SCHEMA_INVALID');
    return label;
  });
  return { location: labels[0] ?? null, locations: [...new Set(labels)] };
}

function baseSalaryFrom(value, description) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) tokyoDevFail('TOKYO_DEV_DETAIL_SCHEMA_INVALID');
  const currency = cleanText(value.currency, 12);
  const salary = value.value;
  if (!currency || !salary || typeof salary !== 'object' || Array.isArray(salary)) tokyoDevFail('TOKYO_DEV_DETAIL_SCHEMA_INVALID');
  const min = salary.minValue ?? null;
  const max = salary.maxValue ?? null;
  for (const amount of [min, max]) {
    if (amount !== null && (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0)) {
      tokyoDevFail('TOKYO_DEV_DETAIL_SCHEMA_INVALID');
    }
  }
  const interval = cleanText(salary.unitText, 100);
  if (!interval || min === null && max === null) tokyoDevFail('TOKYO_DEV_DETAIL_SCHEMA_INVALID');
  const text = description.match(/<h3>\s*Compensation\s*<\/h3>\s*<p>([\s\S]*?)<\/p>/i)?.[1] ?? null;
  const summary = text
    ? cleanText(parseHTML(`<!doctype html><html><body><div>${text}</div></body></html>`).document.body?.textContent ?? '', 1000)
    : null;
  return { summary, components: [{ type: 'baseSalary', min, max, currency, interval }] };
}

function detailFacts(document) {
  const labels = [...document.querySelectorAll('main li.flex.items-center')]
    .map(tagText).filter(Boolean).map(value => value.replace(/^[^\p{L}\p{N}¥]+/u, '').trim());
  const languageLabel = labels.find(value => /Japanese/.test(value)) ?? null;
  const language = languageLabel && JAPANESE_LEVEL_LABELS.has(languageLabel) ? languageLabel : null;
  const residentsOnly = labels.some(value => value === 'Japan residents only' || value.startsWith('Japan residents only '));
  const abroad = labels.some(value => value === 'Apply from abroad' || value.startsWith('Apply from abroad '));
  if (residentsOnly && abroad) tokyoDevFail('TOKYO_DEV_DETAIL_FACTS_CONFLICT');
  const workplaceTypeLabel = labels.find(value => /^(?:Fully remote|Partially remote|No remote)$/.test(value)) ?? null;
  return { japaneseSkillRequirement: language,
    japaneseSkillRequirementRaw: language === null ? languageLabel : null,
    residencyRequirement: residentsOnly ? 'Japan residents only' : null,
    canApplyFromAbroad: abroad ? true : residentsOnly ? false : null,
    workplaceTypeLabel };
}

export function parseTokyoDevJobsPage(html, { url = `${TOKYO_DEV_ORIGIN}/jobs` } = {}) {
  if (url !== `${TOKYO_DEV_ORIGIN}/jobs`) tokyoDevFail('TOKYO_DEV_LIST_URL_INVALID');
  const document = parseHtml(html);
  const count = listAdvertisedCount(document);
  const jobs = [];
  const seen = new Set();
  for (const anchor of document.querySelectorAll('a[href^="/companies/"][href*="/jobs/"]')) {
    const identity = safeObservedJobUrl(anchor.getAttribute('href'));
    if (seen.has(identity.id)) tokyoDevFail('TOKYO_DEV_LIST_IDENTITY_DUPLICATE');
    const title = cleanText(anchor.textContent, 500);
    if (!title) tokyoDevFail('TOKYO_DEV_LIST_SCHEMA_INVALID');
    const card = factsFromCard(anchor, identity.companySlug);
    const sourceFacts = { ...card.sourceFacts };
    jobs.push({
      key: `tokyodev:jp:jobs:${encodeURIComponent(identity.id)}`, provider: 'tokyodev', board: 'jobs', id: identity.id,
      title, company: card.company, url: identity.url, applyUrl: null, location: null, locations: [],
      workplaceType: null, employmentType: null, department: null, team: null, descriptionText: null,
      compensation: null, publishedAt: null, updatedAt: null, deadlineAt: null, sourceFacts,
    });
    seen.add(identity.id);
  }
  if (jobs.length === 0 && count !== 0) tokyoDevFail('TOKYO_DEV_LIST_SCHEMA_INVALID');
  return { jobs, coverage: {
    complete: jobs.length === count, reason: jobs.length === count ? 'advertised_count_matches_rendered_cards' : 'rendered_card_count_differs_from_advertised_total',
    returned: jobs.length, sourceTotal: count, filteredOut: 0, pages: 1, next: null,
  } };
}

export function parseTokyoDevJobDetail(html, { url } = {}) {
  const identity = safeObservedJobUrl(url);
  const document = parseHtml(html);
  const posting = postingJsonLd(document);
  const title = cleanText(posting.title, 500);
  const visibleTitle = cleanText(document.querySelector('main h1')?.textContent, 500);
  const organization = posting.hiringOrganization;
  const company = organization && typeof organization === 'object' ? cleanText(organization.name, 500) : null;
  const identifier = posting.identifier;
  const sourceId = identifier && typeof identifier === 'object' ? cleanText(identifier.value, 200) : null;
  if (!title || title !== visibleTitle || !company || !sourceId || sourceId.length > 200) tokyoDevFail('TOKYO_DEV_DETAIL_IDENTITY_MISMATCH');
  const jobUrl = cleanText(document.querySelector('link[rel="canonical"]')?.getAttribute('href'), 2_000);
  const canonical = jobUrl ? safeObservedJobUrl(jobUrl).url : null;
  if (!canonical || canonical !== identity.url) tokyoDevFail('TOKYO_DEV_DETAIL_IDENTITY_MISMATCH');
  if (organization.sameAs !== undefined && organization.sameAs !== null) {
    let companyUrl;
    try { companyUrl = new URL(organization.sameAs); } catch { tokyoDevFail('TOKYO_DEV_DETAIL_SCHEMA_INVALID'); }
    if (companyUrl.protocol !== 'https:' || !companyUrl.hostname) tokyoDevFail('TOKYO_DEV_DETAIL_SCHEMA_INVALID');
  }
  if (posting.employmentType !== undefined && typeof posting.employmentType !== 'string' && !Array.isArray(posting.employmentType)) {
    tokyoDevFail('TOKYO_DEV_DETAIL_SCHEMA_INVALID');
  }
  const employmentType = Array.isArray(posting.employmentType)
    ? posting.employmentType.map(value => cleanText(value, 100)).filter(Boolean).join(', ') || null
    : cleanText(posting.employmentType, 100);
  const places = locationFrom(posting.jobLocation);
  const description = descriptionText(posting.description);
  const sourceFacts = {
    sourceId,
    ...detailFacts(document),
    compensationLabel: [...document.querySelectorAll('main li.flex.items-center')]
      .map(tagText).find(value => /^💴/.test(value)) ?? null,
    categoryLabels: [],
  };
  return {
    key: `tokyodev:jp:jobs:${encodeURIComponent(identity.id)}`, provider: 'tokyodev', board: 'jobs', id: identity.id,
    title, company, url: identity.url, applyUrl: null,
    location: places.location, locations: places.locations, workplaceType: null,
    employmentType, department: null, team: null, descriptionText: description,
    compensation: baseSalaryFrom(posting.baseSalary, posting.description),
    publishedAt: safeDate(posting.datePosted), updatedAt: null, deadlineAt: null, sourceFacts,
  };
}

async function boundedBody(response, receipt) {
  const reader = response.body?.getReader?.();
  if (!reader) tokyoDevFail('TOKYO_DEV_BODY_UNREADABLE', receipt);
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        tokyoDevFail('TOKYO_DEV_RESPONSE_TOO_LARGE', { ...receipt, responseBytes: bytes });
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  const raw = Buffer.concat(chunks, bytes);
  let html;
  try { html = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
  catch { tokyoDevFail('TOKYO_DEV_ENCODING_INVALID', { ...receipt, responseBytes: bytes }); }
  return { html, responseBytes: bytes, responseSha256: createHash('sha256').update(raw).digest('hex') };
}

export function createTokyoDevJobsClient({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') tokyoDevFail('TOKYO_DEV_CLIENT_CONFIGURATION_INVALID');

  async function read(url, operation) {
    const parsed = new URL(url);
    if (parsed.origin !== TOKYO_DEV_ORIGIN || parsed.username || parsed.password || parsed.search || parsed.hash) {
      tokyoDevFail('TOKYO_DEV_REQUEST_SCOPE_REJECTED');
    }
    const checkedAt = new Date(now()).toISOString();
    const receipt = {
      method: 'GET', origin: parsed.origin, path: parsed.pathname, checkedAt,
      browserUsed: false, anonymous: true, credentialsUsed: false, cookiesSent: false, readOnly: true,
    };
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET', redirect: 'manual', credentials: 'omit',
        headers: { accept: 'text/html,application/xhtml+xml' }, signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      tokyoDevFail(error?.name === 'TimeoutError' ? 'TOKYO_DEV_TIMEOUT' : 'TOKYO_DEV_TRANSPORT_FAILED', receipt);
    }
    const mime = response.headers?.get?.('content-type')?.split(';')[0]?.trim().toLowerCase() ?? null;
    const responseReceipt = { ...receipt, httpStatus: response.status, mime };
    if ([301, 302, 303, 307, 308].includes(response.status) || response.redirected) {
      await response.body?.cancel().catch(() => {});
      tokyoDevFail('TOKYO_DEV_REDIRECT_REJECTED', responseReceipt);
    }
    if (response.status === 403) {
      await response.body?.cancel().catch(() => {});
      tokyoDevFail('TOKYO_DEV_ACCESS_REJECTED', responseReceipt);
    }
    if (response.status === 429) {
      await response.body?.cancel().catch(() => {});
      tokyoDevFail('TOKYO_DEV_THROTTLED', responseReceipt);
    }
    if (response.status !== 200 || mime !== 'text/html') {
      await response.body?.cancel().catch(() => {});
      tokyoDevFail('TOKYO_DEV_RESPONSE_INVALID', responseReceipt);
    }
    const body = await boundedBody(response, responseReceipt);
    const { html, responseBytes, responseSha256 } = body;
    return { html, receipt: { ...responseReceipt, responseBytes, responseSha256, operation } };
  }

  async function list() {
    const url = `${TOKYO_DEV_ORIGIN}/jobs`;
    const result = await read(url, 'list');
    const projection = parseTokyoDevJobsPage(result.html, { url });
    const observedAt = result.receipt.checkedAt;
    return {
      schemaVersion: 1, provider: 'tokyodev', operation: 'list',
      scope: { provider: 'tokyodev', board: 'jobs', region: 'jp', filters: {} }, observedAt,
      jobs: projection.jobs, coverage: projection.coverage, requests: [result.receipt],
    };
  }

  async function detail({ url } = {}) {
    const identity = safeObservedJobUrl(url);
    const result = await read(identity.url, 'detail');
    const job = parseTokyoDevJobDetail(result.html, { url: identity.url });
    return {
      schemaVersion: 1, provider: 'tokyodev', operation: 'detail',
      scope: { provider: 'tokyodev', board: 'jobs', region: 'jp', filters: { id: identity.id } },
      observedAt: result.receipt.checkedAt, jobs: [job],
      coverage: { complete: false, reason: 'single_job_detail_not_a_board_snapshot', returned: 1,
        sourceTotal: null, filteredOut: 0, pages: 1, next: null },
      requests: [result.receipt],
    };
  }

  return { list, detail };
}

export const tokyoDevResponseFingerprint = bytes => createHash('sha256').update(bytes).digest('hex');
