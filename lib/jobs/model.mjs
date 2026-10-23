import { parseFragment } from 'parse5';

const PROVIDERS = new Set(['greenhouse', 'lever', 'ashby', 'remotive', 'reed', 'tokyodev']);
const REGIONS = new Set(['global', 'eu', 'gb', 'jp']);
const JAPANESE_SKILL_LABELS = new Set([
  'No Japanese required', 'Basic Japanese', 'Conversational Japanese', 'Business Japanese', 'Fluent Japanese',
]);
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export function jobsFail(code, receipt = undefined) {
  const error = new Error(code);
  error.code = code;
  if (receipt) error.receipt = receipt;
  throw error;
}

function scalar(value, field, max = 20_000) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > max || CONTROL.test(value)) {
    jobsFail('JOBS_SCHEMA_INVALID', { field });
  }
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned || null;
}

function identity(value, field) {
  const out = typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? String(value) : scalar(value, field, 200);
  if (!out || !/^[\p{L}\p{N}][\p{L}\p{N}._:-]{0,199}$/u.test(out)) {
    jobsFail('JOBS_SCHEMA_INVALID', { field });
  }
  return out;
}

export function boardName(value) {
  const out = scalar(value, 'board', 120);
  if (!out || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(out)) {
    jobsFail('JOBS_BOARD_INVALID');
  }
  return out;
}

export function regionName(value = 'global') {
  if (typeof value !== 'string' || !REGIONS.has(value)) jobsFail('JOBS_REGION_INVALID');
  return value;
}

export function validateProvider(value) {
  if (typeof value !== 'string' || !PROVIDERS.has(value)) jobsFail('JOBS_PROVIDER_INVALID');
  return value;
}

export function safeJobUrl(value, field) {
  const raw = scalar(value, field, 2_000);
  if (!raw) jobsFail('JOBS_SCHEMA_INVALID', { field });
  let url;
  try { url = new URL(raw); } catch { jobsFail('JOBS_SCHEMA_INVALID', { field }); }
  if (url.protocol !== 'https:' || !url.hostname || url.port || url.username || url.password || url.hash) {
    jobsFail('JOBS_SCHEMA_INVALID', { field });
  }
  for (const key of url.searchParams.keys()) {
    if (/(?:token|secret|session|auth|credential|password|cookie|signature)/i.test(key)) {
      jobsFail('JOBS_SCHEMA_INVALID', { field });
    }
  }
  return url.href;
}

function plainText(html, field) {
  const value = scalar(html, field, 1_500_000);
  if (!value) return null;
  const visit = node => {
    if (node.tagName === 'script' || node.tagName === 'style') return '';
    if (typeof node.value === 'string') return node.value;
    if (!node.childNodes) return '';
    const separator = ['br', 'p', 'div', 'li', 'h1', 'h2', 'h3', 'section'].includes(node.tagName) ? '\n' : '';
    return node.childNodes.map(visit).join('') + separator;
  };
  let output = value;
  for (let depth = 0; depth < 3; depth++) {
    const parsed = visit(parseFragment(output));
    const nestedHtml = /<\/?(?:p|div|li|h[1-6]|section|br|strong|em|ul|ol|span)\b[^>]*>/i.test(parsed);
    if (!/(?:&lt;|&#0*60;|&#x0*3c;)/i.test(parsed) && !nestedHtml) { output = parsed; break; }
    output = parsed;
  }
  return output.replace(/[\t\r\f\v ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim() || null;
}

function nonNegativeNumber(value, field) {
  if (value === undefined || value === null) return null;
  const number = typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)
    ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || number < 0) {
    jobsFail('JOBS_SCHEMA_INVALID', { field });
  }
  return number;
}

function payComponent(value, field, tier = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    jobsFail('JOBS_SCHEMA_INVALID', { field });
  }
  return {
    type: scalar(value.compensationType ?? value.type, `${field}.type`, 100),
    min: nonNegativeNumber(value.minValue ?? value.min, `${field}.min`),
    max: nonNegativeNumber(value.maxValue ?? value.max, `${field}.max`),
    currency: scalar(value.currencyCode ?? value.currency, `${field}.currency`, 12),
    interval: scalar(value.interval, `${field}.interval`, 100),
    summary: scalar(value.summary, `${field}.summary`, 1_000),
    tierId: tier?.id ?? null,
    tierTitle: tier?.title ?? null,
    tierSummary: tier?.summary ?? null,
    tierAdditionalInformation: tier?.additionalInformation ?? null,
  };
}

export function greenhousePay(job) {
  return null;
}

export function leverPay(job) {
  const range = job.salaryRange;
  if (range == null) return null;
  if (typeof range !== 'object' || Array.isArray(range)) jobsFail('JOBS_SCHEMA_INVALID', { field: 'salaryRange' });
  return {
    summary: scalar(job.salaryDescriptionPlain, 'salaryDescriptionPlain', 2_000),
    components: [{
      type: 'salary',
      min: nonNegativeNumber(range.min, 'salaryRange.min'),
      max: nonNegativeNumber(range.max, 'salaryRange.max'),
      currency: scalar(range.currency, 'salaryRange.currency', 12),
      interval: scalar(range.interval, 'salaryRange.interval', 100),
      summary: null,
    }],
  };
}

export function ashbyPay(job) {
  const value = job.compensation;
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) jobsFail('JOBS_SCHEMA_INVALID', { field: 'compensation' });
  const tiers = value.compensationTiers;
  if (tiers !== undefined && tiers !== null && !Array.isArray(tiers)) {
    jobsFail('JOBS_SCHEMA_INVALID', { field: 'compensation.compensationTiers' });
  }
  const components = [];
  for (const [tierIndex, tier] of (tiers ?? []).entries()) {
    if (!tier || typeof tier !== 'object' || Array.isArray(tier)) {
      jobsFail('JOBS_SCHEMA_INVALID', { field: `compensation.compensationTiers.${tierIndex}` });
    }
    if (tier.components !== undefined && tier.components !== null && !Array.isArray(tier.components)) {
      jobsFail('JOBS_SCHEMA_INVALID', { field: `compensation.compensationTiers.${tierIndex}.components` });
    }
    const tierInfo = {
      id: scalar(tier.id, `compensation.compensationTiers.${tierIndex}.id`, 200),
      title: scalar(tier.title, `compensation.compensationTiers.${tierIndex}.title`, 200),
      summary: scalar(tier.tierSummary, `compensation.compensationTiers.${tierIndex}.tierSummary`, 2_000),
      additionalInformation: scalar(tier.additionalInformation,
        `compensation.compensationTiers.${tierIndex}.additionalInformation`, 2_000),
    };
    for (const [componentIndex, item] of (tier.components ?? []).entries()) {
      components.push(payComponent(item, `compensation.compensationTiers.${tierIndex}.components.${componentIndex}`, tierInfo));
    }
  }
  return {
    summary: scalar(value.scrapeableCompensationSalarySummary ?? value.compensationTierSummary,
      'compensation.summary', 2_000),
    displayOnPosting: typeof job.shouldDisplayCompensationOnJobPostings === 'boolean'
      ? job.shouldDisplayCompensationOnJobPostings : null,
    components,
  };
}

function locationsFrom(raw) {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== 'string' && !Array.isArray(raw)) jobsFail('JOBS_SCHEMA_INVALID', { field: 'locations' });
  const values = Array.isArray(raw) ? raw : [raw];
  return [...new Set(values.map((value, index) => {
    const label = typeof value === 'string' ? value : value?.location;
    return scalar(label, `locations.${index}`, 500);
  }).filter(Boolean))];
}

function timestamp(value, field) {
  const out = scalar(value, field, 100);
  if (out && !Number.isFinite(Date.parse(out))) jobsFail('JOBS_SCHEMA_INVALID', { field });
  return out;
}

function timestampFromMilliseconds(value, field) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || Math.abs(value) > 8_640_000_000_000_000) {
    jobsFail('JOBS_SCHEMA_INVALID', { field });
  }
  return new Date(value).toISOString();
}

function ghDepartments(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) jobsFail('JOBS_SCHEMA_INVALID', { field: 'departments' });
  const names = value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      jobsFail('JOBS_SCHEMA_INVALID', { field: `departments.${index}` });
    }
    return scalar(entry.name, `departments.${index}.name`, 200);
  }).filter(Boolean);
  return names.join(' / ') || null;
}

function leverCategories(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) jobsFail('JOBS_SCHEMA_INVALID', { field: 'categories' });
  const allLocations = value.allLocations;
  if (allLocations !== undefined && allLocations !== null && !Array.isArray(allLocations)) {
    jobsFail('JOBS_SCHEMA_INVALID', { field: 'categories.allLocations' });
  }
  return {
    location: value.location,
    locations: allLocations,
    department: value.department,
    team: value.team,
    employmentType: value.commitment,
  };
}

function canonicalIdentity(provider, region, board, id) {
  return [provider, region, board, id].map(encodeURIComponent).join(':');
}

export function normalizeJob({ provider: rawProvider, board: rawBoard, region: rawRegion = 'global', value }) {
  const provider = validateProvider(rawProvider);
  const board = boardName(rawBoard);
  const region = regionName(rawRegion);
  if (!value || typeof value !== 'object' || Array.isArray(value)) jobsFail('JOBS_SCHEMA_INVALID', { field: 'job' });

  let id; let title; let company = null; let url; let applyUrl = null; let location; let locations; let workplaceType = null;
  let employmentType = null; let department = null; let team = null; let description; let compensation;
  let sourceFacts = null;
  let publishedAt; let updatedAt; let deadlineAt = null;
  if (provider === 'greenhouse') {
    id = identity(value.id, 'job.id'); title = scalar(value.title, 'job.title', 500);
    company = scalar(value.company_name, 'job.company_name', 500);
    url = safeJobUrl(value.absolute_url, 'job.absolute_url'); location = scalar(value.location?.name, 'job.location.name', 500);
    const officeNames = Array.isArray(value.offices) ? value.offices.map((office, index) => {
      if (!office || typeof office !== 'object' || Array.isArray(office)) jobsFail('JOBS_SCHEMA_INVALID', { field: `job.offices.${index}` });
      return scalar(office.location ?? office.name, `job.offices.${index}.location`, 500);
    }) : [];
    locations = locationsFrom([location, ...officeNames].filter(Boolean));
    department = ghDepartments(value.departments);
    description = plainText(value.content, 'job.content'); compensation = greenhousePay(value);
    publishedAt = timestamp(value.first_published, 'job.first_published');
    updatedAt = timestamp(value.updated_at, 'job.updated_at');
    deadlineAt = timestamp(value.application_deadline, 'job.application_deadline');
  } else if (provider === 'lever') {
    const category = leverCategories(value.categories);
    id = identity(value.id, 'job.id'); title = scalar(value.text, 'job.text', 500);
    company = scalar(value.companyName, 'job.companyName', 500);
    url = safeJobUrl(value.hostedUrl, 'job.hostedUrl'); applyUrl = safeJobUrl(value.applyUrl, 'job.applyUrl');
    location = scalar(category.location, 'job.categories.location', 500);
    locations = locationsFrom([location, ...(category.locations ?? [])].filter(Boolean));
    workplaceType = scalar(value.workplaceType, 'job.workplaceType', 100);
    employmentType = scalar(category.employmentType, 'job.categories.commitment', 100);
    department = scalar(category.department, 'job.categories.department', 200);
    team = scalar(category.team, 'job.categories.team', 200);
    description = plainText(value.descriptionPlain ?? value.descriptionBodyPlain, 'job.description');
    compensation = leverPay(value);
    publishedAt = timestampFromMilliseconds(value.createdAt, 'job.createdAt');
    updatedAt = null;
  } else if (provider === 'ashby') {
    id = identity(value.id, 'job.id'); title = scalar(value.title, 'job.title', 500);
    company = scalar(value.companyName, 'job.companyName', 500);
    url = safeJobUrl(value.jobUrl, 'job.jobUrl'); applyUrl = safeJobUrl(value.applyUrl, 'job.applyUrl');
    location = scalar(value.location, 'job.location', 500);
    const secondary = value.secondaryLocations ?? [];
    if (!Array.isArray(secondary)) jobsFail('JOBS_SCHEMA_INVALID', { field: 'job.secondaryLocations' });
    const secondaryLabels = secondary.map((entry, index) => {
      if (typeof entry === 'string') return scalar(entry, `job.secondaryLocations.${index}`, 500);
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        jobsFail('JOBS_SCHEMA_INVALID', { field: `job.secondaryLocations.${index}` });
      }
      return scalar(entry.location, `job.secondaryLocations.${index}.location`, 500);
    });
    locations = locationsFrom([location, ...secondaryLabels].filter(Boolean));
    workplaceType = scalar(value.workplaceType, 'job.workplaceType', 100);
    employmentType = scalar(value.employmentType, 'job.employmentType', 100);
    department = scalar(value.department, 'job.department', 200);
    team = scalar(value.team, 'job.team', 200);
    description = plainText(value.descriptionPlain ?? value.descriptionHtml, 'job.description');
    compensation = ashbyPay(value);
    publishedAt = timestamp(value.publishedAt, 'job.publishedAt');
    updatedAt = timestamp(value.updatedAt, 'job.updatedAt');
  } else if (provider === 'remotive') {
    id = identity(value.id, 'job.id'); title = scalar(value.title, 'job.title', 500);
    company = scalar(value.company_name, 'job.company_name', 500);
    url = safeJobUrl(value.url, 'job.url');
    location = scalar(value.candidate_required_location, 'job.candidate_required_location', 500);
    locations = locationsFrom(location);
    employmentType = scalar(value.job_type, 'job.job_type', 100);
    department = scalar(value.category, 'job.category', 200);
    description = plainText(value.description, 'job.description');
    const salary = scalar(value.salary, 'job.salary', 500);
    compensation = salary ? { summary: salary, components: [], displayOnPosting: null } : null;
    publishedAt = timestamp(value.publication_date, 'job.publication_date');
    updatedAt = null;
  } else if (provider === 'reed') {
    id = identity(value.jobId, 'job.jobId'); title = scalar(value.jobTitle, 'job.jobTitle', 500);
    company = scalar(value.employerName, 'job.employerName', 500);
    url = value.url == null && value.jobUrl == null ? null : safeJobUrl(value.url ?? value.jobUrl, 'job.url');
    location = scalar(value.locationName, 'job.locationName', 500);
    locations = locationsFrom(location);
    department = scalar(value.category, 'job.category', 200);
    description = plainText(value.jobDescription, 'job.jobDescription');
    const minimum = nonNegativeNumber(value.minimumSalary, 'job.minimumSalary');
    const maximum = nonNegativeNumber(value.maximumSalary, 'job.maximumSalary');
    compensation = minimum !== null || maximum !== null ? {
      summary: null,
      // Reed's API uses local salary figures but does not attach currency or pay interval to each result.
      components: [{ type: 'salary', min: minimum, max: maximum, currency: null, interval: null, summary: null }],
    } : null;
    publishedAt = timestamp(value.date, 'job.date');
    updatedAt = null;
    deadlineAt = timestamp(value.expirationDate, 'job.expirationDate');
  } else {
    id = identity(value.id, 'job.id'); title = scalar(value.title, 'job.title', 500);
    company = scalar(value.hiringOrganization?.name, 'job.hiringOrganization.name', 500);
    url = safeJobUrl(value.url, 'job.url');
    const address = value.jobLocation?.address;
    if (address !== undefined && address !== null && (typeof address !== 'object' || Array.isArray(address))) {
      jobsFail('JOBS_SCHEMA_INVALID', { field: 'job.jobLocation.address' });
    }
    const parts = address ? [address.addressLocality, address.addressRegion, address.addressCountry]
      .map((part, index) => scalar(part, `job.jobLocation.address.${index}`, 300)).filter(Boolean) : [];
    location = parts.length ? parts.join(', ') : null;
    locations = locationsFrom(location);
    employmentType = scalar(value.employmentType, 'job.employmentType', 100);
    description = plainText(value.description, 'job.description');
    const salary = value.baseSalary;
    if (salary === undefined || salary === null) compensation = null;
    else {
      if (typeof salary !== 'object' || Array.isArray(salary)) jobsFail('JOBS_SCHEMA_INVALID', { field: 'job.baseSalary' });
      const valueRange = salary.value;
      if (!valueRange || typeof valueRange !== 'object' || Array.isArray(valueRange)) {
        jobsFail('JOBS_SCHEMA_INVALID', { field: 'job.baseSalary.value' });
      }
      compensation = { summary: null, components: [{
        type: scalar(salary['@type'] ?? 'salary', 'job.baseSalary.type', 100),
        min: nonNegativeNumber(valueRange.minValue, 'job.baseSalary.value.minValue'),
        max: nonNegativeNumber(valueRange.maxValue, 'job.baseSalary.value.maxValue'),
        currency: scalar(salary.currency, 'job.baseSalary.currency', 12),
        interval: scalar(valueRange.unitText, 'job.baseSalary.value.unitText', 100),
        summary: null,
      }] };
    }
    publishedAt = timestamp(value.datePosted, 'job.datePosted');
    updatedAt = null;
    deadlineAt = timestamp(value.validThrough, 'job.validThrough');
    const facts = value.sourceFacts;
    if (facts !== undefined && facts !== null) {
      if (typeof facts !== 'object' || Array.isArray(facts)) jobsFail('JOBS_SCHEMA_INVALID', { field: 'job.sourceFacts' });
      const abroad = facts.canApplyFromAbroad;
      if (abroad !== null && abroad !== undefined && typeof abroad !== 'boolean') {
        jobsFail('JOBS_SCHEMA_INVALID', { field: 'job.sourceFacts.canApplyFromAbroad' });
      }
      const labels = facts.skillLabels ?? [];
      if (!Array.isArray(labels)) jobsFail('JOBS_SCHEMA_INVALID', { field: 'job.sourceFacts.skillLabels' });
      const japaneseRequirement = scalar(facts.japaneseSkillRequirement, 'job.sourceFacts.japaneseSkillRequirement', 500);
      sourceFacts = {
        japaneseSkillRequirement: japaneseRequirement && JAPANESE_SKILL_LABELS.has(japaneseRequirement)
          ? japaneseRequirement : null,
        japaneseSkillRequirementRaw: japaneseRequirement,
        residencyRequirement: scalar(facts.residencyRequirement, 'job.sourceFacts.residencyRequirement', 500),
        canApplyFromAbroad: abroad ?? null,
        workplaceTypeLabel: scalar(facts.workplaceTypeLabel, 'job.sourceFacts.workplaceTypeLabel', 500),
        skillLabels: labels.map((label, index) => scalar(label, `job.sourceFacts.skillLabels.${index}`, 250)).filter(Boolean),
        sourceId: facts.sourceId == null ? null : identity(facts.sourceId, 'job.sourceFacts.sourceId'),
      };
    }
  }
  if (!title) jobsFail('JOBS_SCHEMA_INVALID', { field: 'job.title' });
  return {
    key: canonicalIdentity(provider, region, board, id), provider, board, id, title, company, url, applyUrl,
    location, locations, workplaceType, employmentType, department, team,
    descriptionText: description, compensation, publishedAt, updatedAt, deadlineAt, sourceFacts,
  };
}

export function jobScope(provider, board, region, filters = {}) {
  return { provider: validateProvider(provider), board: boardName(board), region: regionName(region), filters };
}

export function jobEnvelope({ provider, operation, scope, jobs, complete, reason, returned = jobs.length,
  next = null, pages = 1, requests, sourceTotal = null, providerTotal = null, filteredOut = 0, observedAt }) {
  if (!['list', 'detail', 'collect'].includes(operation) || !Array.isArray(jobs) ||
      !Array.isArray(requests) || !Number.isSafeInteger(returned) || returned < 0 ||
      returned !== jobs.length || !Number.isSafeInteger(pages) || pages < 1 || typeof complete !== 'boolean' ||
      typeof reason !== 'string' || !reason || (complete && next !== null) ||
      (next !== null && (!next || typeof next !== 'object' || !Number.isSafeInteger(next.offset) || next.offset < 0)) ||
      !Number.isFinite(Date.parse(observedAt))) jobsFail('JOBS_ENVELOPE_INVALID');
  return {
    schemaVersion: 1, provider, operation, scope, observedAt, jobs,
    coverage: { complete, reason, returned, sourceTotal, providerTotal, filteredOut, next, pages },
    requests,
  };
}
