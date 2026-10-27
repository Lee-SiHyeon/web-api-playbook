import { commerceJsonRequest, commerceFail } from '../commerce/http.mjs';
import { SOOMGO_ORIGIN } from './soomgo.mjs';

const WEB_ORIGIN = 'https://soomgo.com';
const DEFAULT_USER_AGENT = 'SoomgoFrontend-production/ef0d6196ed27a3515e4a3668af8c717132d52f61';
const FORM_PATH_PREFIX = '/v2/services/';
const FORM_PATH_SUFFIX = '/form';
const ADDRESS_PATH = '/v1/requests/forms/addresses';
const MAX_FORM_BYTES = 1024 * 1024;
const MAX_ADDRESS_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS = 500;
const MAX_OPTIONS = 500;
const MAX_USER_INPUT_BYTES = 128 * 1024;
const MAX_USER_INPUT_NODES = 10_000;
const MAX_USER_INPUT_DEPTH = 16;
const MAX_FORM_INPUT_BYTES = 1024 * 1024;
const MAX_FORM_INPUT_NODES = 100_000;
const MAX_FORM_INPUT_DEPTH = 24;
const MAX_ADDRESS_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_ADDRESS_INPUT_NODES = 100_000;
const MAX_ADDRESS_INPUT_DEPTH = 12;

export const SOOMGO_REQUEST_CONTRACT = Object.freeze({
  sourceUrl: 'https://assets.cdn.soomgo.com/vite/8ac8a9e/assets/client-bundle.DU0XyXHr.js',
  sourceSha256: '8f68069b2e77d53071cd60699c6f94babaea1cb089425bd1912a476ee1ae3f3e',
  sourceKind: 'first_party_bundle_contract',
  pageUrlPattern: 'https://soomgo.com/hire/:serviceSlug',
});
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const ITEM_TYPES = Object.freeze({
  1: 'checkbox',
  2: 'radio',
  3: 'text_field',
  4: 'selectbox',
  5: 'date_picker',
  6: 'address3',
  7: 'address2',
  9: 'image',
  10: 'spinner',
  11: 'textarea',
});

function fail(code, receipt = undefined, details = undefined) {
  const error = new Error(code);
  error.name = 'SoomgoRequestError';
  error.code = code;
  error.service = 'soomgo';
  if (receipt !== undefined) error.receipt = receipt;
  if (details !== undefined) error.details = details;
  throw error;
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredText(value, field, max = 2000) {
  if (typeof value !== 'string' || value.length > max || CONTROL.test(value) || !value.trim()) {
    fail('SOOMGO_REQUEST_SCHEMA_INVALID', undefined, { field });
  }
  return value;
}

function optionalText(value, field, max = 2000) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > max || CONTROL.test(value)) {
    fail('SOOMGO_REQUEST_SCHEMA_INVALID', undefined, { field });
  }
  return value;
}

function positiveId(value, field) {
  if (!Number.isSafeInteger(value) || value < 1 || value > Number.MAX_SAFE_INTEGER) {
    fail('SOOMGO_REQUEST_SCHEMA_INVALID', undefined, { field });
  }
  return value;
}

function safeSlug(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200 ||
    !/^[\p{L}\p{N}-]+$/u.test(value)) fail('SOOMGO_REQUEST_SERVICE_INVALID');
  return value;
}

function sourceService(value) {
  if (!isRecord(value)) fail('SOOMGO_REQUEST_SERVICE_REQUIRED');
  return {
    id: positiveId(value.id, 'service.id'),
    slug: safeSlug(value.slug),
    name: requiredText(value.name, 'service.name', 200),
  };
}

function cloneJson(value, field = 'value', limits = undefined, depth = 0) {
  limits ??= {
    nodes: 0, bytes: 0, maxNodes: MAX_USER_INPUT_NODES,
    maxBytes: 512 * 1024, maxDepth: MAX_USER_INPUT_DEPTH,
  };
  if (depth > limits.maxDepth) fail('SOOMGO_REQUEST_SCHEMA_TOO_COMPLEX', undefined, { field });
  if (++limits.nodes > limits.maxNodes) fail('SOOMGO_REQUEST_SCHEMA_TOO_COMPLEX', undefined, { field });
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('SOOMGO_REQUEST_SCHEMA_INVALID', undefined, { field });
    return value;
  }
  if (typeof value === 'string') {
    limits.bytes += Buffer.byteLength(value, 'utf8');
    if (limits.bytes > limits.maxBytes || CONTROL.test(value)) {
      fail('SOOMGO_REQUEST_SCHEMA_INVALID', undefined, { field });
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => cloneJson(entry, `${field}.${index}`, limits, depth + 1));
  if (!isRecord(value)) fail('SOOMGO_REQUEST_SCHEMA_INVALID', undefined, { field });
  const output = Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    if (BLOCKED_KEYS.has(key) || key.length > 200) fail('SOOMGO_REQUEST_SCHEMA_INVALID', undefined, { field });
    output[key] = cloneJson(entry, `${field}.${key}`, limits, depth + 1);
  }
  return output;
}

function validateAnswerSchema(item, itemIndex) {
  if (!Array.isArray(item.answerSchema) || item.answerSchema.length < 1 || item.answerSchema.length > MAX_OPTIONS) {
    fail('SOOMGO_REQUEST_SCHEMA_INVALID', undefined, { field: `items.${itemIndex}.answerSchema` });
  }
  const seen = new Set();
  return item.answerSchema.map((option, optionIndex) => {
    if (!isRecord(option)) fail('SOOMGO_REQUEST_SCHEMA_INVALID', undefined,
      { field: `items.${itemIndex}.answerSchema.${optionIndex}` });
    const id = positiveId(option.id, `items.${itemIndex}.answerSchema.${optionIndex}.id`);
    if (seen.has(id)) fail('SOOMGO_REQUEST_SCHEMA_INVALID', undefined,
      { field: `items.${itemIndex}.answerSchema.${optionIndex}.id` });
    seen.add(id);
    return {
      ...cloneJson(option, `items.${itemIndex}.answerSchema.${optionIndex}`),
      id,
      text: optionalText(option.text, `items.${itemIndex}.answerSchema.${optionIndex}.text`, 2000),
    };
  });
}

function normalizeItem(raw, index) {
  if (!isRecord(raw)) fail('SOOMGO_REQUEST_SCHEMA_INVALID', undefined, { field: `items.${index}` });
  const id = positiveId(raw.id, `items.${index}.id`);
  const type = positiveId(raw.type, `items.${index}.type`);
  const itemName = requiredText(raw.name, `items.${index}.name`, 100);
  if (typeof raw.required !== 'boolean' || typeof raw.instantMatch !== 'boolean') {
    fail('SOOMGO_REQUEST_SCHEMA_INVALID', undefined, { field: `items.${index}` });
  }
  if (raw.isDefaultInfo !== undefined && typeof raw.isDefaultInfo !== 'boolean') {
    fail('SOOMGO_REQUEST_SCHEMA_INVALID', undefined, { field: `items.${index}.isDefaultInfo` });
  }
  const item = {
    id,
    type,
    typeName: ITEM_TYPES[type] ?? null,
    subType: raw.subType === null || raw.subType === undefined ? null : positiveId(raw.subType, `items.${index}.subType`),
    name: itemName,
    required: raw.required,
    instantMatch: raw.instantMatch,
    isDefaultInfo: raw.isDefaultInfo ?? null,
    question: optionalText(raw.question, `items.${index}.question`, 1000),
    description: optionalText(raw.description, `items.${index}.description`, 3000),
    answerSchema: validateAnswerSchema(raw, index),
    conditionalState: !Object.hasOwn(raw, 'conditional') ? 'not_exposed'
      : raw.conditional === null ? 'explicit_none' : 'condition_present_unresolved',
  };
  if (Object.hasOwn(raw, 'conditional')) item.conditional = cloneJson(raw.conditional, `items.${index}.conditional`);
  return item;
}

function normalizeForm(raw, expectedService) {
  if (!isRecord(raw) || !isRecord(raw.service) || raw.service.id !== expectedService.id ||
    (raw.serviceId !== undefined && raw.serviceId !== expectedService.id) ||
    raw.service.slug !== expectedService.slug || !Array.isArray(raw.items) ||
    raw.items.length < 1 || raw.items.length > MAX_ITEMS) {
    fail('SOOMGO_REQUEST_FORM_IDENTITY_OR_SCHEMA_INVALID');
  }
  if (typeof raw.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(raw.id)) {
    fail('SOOMGO_REQUEST_FORM_IDENTITY_OR_SCHEMA_INVALID');
  }
  const idSet = new Set();
  const items = raw.items.map(normalizeItem);
  for (const item of items) {
    if (idSet.has(item.id)) fail('SOOMGO_REQUEST_SCHEMA_INVALID', undefined, { field: 'items.duplicateId' });
    idSet.add(item.id);
  }
  const conditionalCount = items.filter(item => item.conditionalState !== 'explicit_none').length;
  return {
    id: raw.id,
    name: requiredText(raw.name, 'form.name', 200),
    description: optionalText(raw.description, 'form.description', 5000),
    serviceId: raw.serviceId === undefined ? expectedService.id : positiveId(raw.serviceId, 'form.serviceId'),
    service: {
      id: expectedService.id,
      slug: expectedService.slug,
      name: requiredText(raw.service.name, 'form.service.name', 200),
    },
    updatedAt: optionalText(raw.updatedAt, 'form.updatedAt', 100),
    items,
    schemaCoverage: {
      returnedItems: items.length,
      unsupportedTypes: [...new Set(items.filter(item => item.typeName === null).map(item => item.type))],
      unresolvedConditionalItems: items.filter(item => item.conditionalState !== 'explicit_none').map(item => item.id),
      sourceTotal: null,
      conditionFieldPresentForEveryItem: conditionalCount === 0,
      countComplete: false,
      reason: conditionalCount ? 'conditional_field_missing_or_unresolved' : 'provider_does_not_report_form_item_total',
    },
  };
}

function requestReceipt(request) {
  return {
    method: request.method,
    origin: request.origin,
    path: request.path,
    queryFields: [...request.queryFields],
    httpStatus: request.httpStatus,
    mime: request.mime,
    responseBytes: request.responseBytes,
    responseSha256: request.responseSha256,
    checkedAt: request.checkedAt,
    browserUsed: false,
    anonymous: true,
    credentialsUsed: false,
    cookiesSent: false,
    authorizationSent: false,
  };
}

function serviceFormPath(service) {
  return `/v2/services/${encodeURIComponent(service.slug)}${FORM_PATH_SUFFIX}`;
}

function publicLocationText(value, field, max, { optional = false, index } = {}) {
  if (value === undefined || value === null) {
    if (optional) return null;
    fail('SOOMGO_REQUEST_ADDRESS_SCHEMA_INVALID', undefined, { field: `addresses.${index}.${field}` });
  }
  if (typeof value !== 'string' || value.length > max) {
    fail('SOOMGO_REQUEST_ADDRESS_SCHEMA_INVALID', undefined, { field: `addresses.${index}.${field}` });
  }
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean && !optional) fail('SOOMGO_REQUEST_ADDRESS_SCHEMA_INVALID', undefined, { field: `addresses.${index}.${field}` });
  return clean || null;
}

function normalizeAddress(value, index) {
  if (!isRecord(value)) fail('SOOMGO_REQUEST_ADDRESS_SCHEMA_INVALID', undefined, { field: `addresses.${index}` });
  const addressRowid = positiveId(value.addressRowid, `addresses.${index}.addressRowid`);
  return {
    addressRowid,
    addr1: publicLocationText(value.addr1, 'addr1', 120, { index }),
    addr2: publicLocationText(value.addr2, 'addr2', 120, { index }),
    addr3: publicLocationText(value.addr3, 'addr3', 120, { index }),
    address: publicLocationText(value.address, 'address', 400, { optional: true, index }),
  };
}

function safeInputObject(value, name) {
  if (value === undefined) return Object.create(null);
  if (!isRecord(value)) fail('SOOMGO_REQUEST_INPUT_INVALID', undefined, { field: name });
  let inputBytes;
  try { inputBytes = Buffer.byteLength(JSON.stringify(value), 'utf8'); }
  catch { fail('SOOMGO_REQUEST_INPUT_INVALID', undefined, { field: name }); }
  if (inputBytes > MAX_USER_INPUT_BYTES) fail('SOOMGO_REQUEST_INPUT_TOO_LARGE', undefined, { field: name });
  return cloneJson(value, name, {
    nodes: 0, bytes: 0, maxNodes: MAX_USER_INPUT_NODES,
    maxBytes: MAX_USER_INPUT_BYTES, maxDepth: MAX_USER_INPUT_DEPTH,
  });
}

function normalizeAddressOptions(value) {
  const snapshot = cloneJson(value, 'addressOptions', {
    nodes: 0, bytes: 0, maxNodes: MAX_ADDRESS_INPUT_NODES,
    maxBytes: MAX_ADDRESS_INPUT_BYTES, maxDepth: MAX_ADDRESS_INPUT_DEPTH,
  });
  if (!isRecord(snapshot) || snapshot.service !== 'soomgo' || snapshot.operation !== 'address_options' ||
    snapshot.depth !== 3 || !Array.isArray(snapshot.items) || snapshot.items.length > 10_000 ||
    !isRecord(snapshot.coverage) || typeof snapshot.coverage.complete !== 'boolean' ||
    snapshot.coverage.complete !== false || !Array.isArray(snapshot.requests) || snapshot.requests.length < 1) {
    fail('SOOMGO_REQUEST_ADDRESS_SNAPSHOT_INVALID');
  }
  const request = snapshot.requests[0];
  if (!isRecord(request) || request.method !== 'GET' || request.origin !== SOOMGO_ORIGIN ||
    request.path !== ADDRESS_PATH || request.httpStatus !== 200 || request.browserUsed !== false ||
    request.credentialsUsed !== false || request.cookiesSent !== false ||
    !Array.isArray(request.queryFields) || !request.queryFields.includes('depth')) {
    fail('SOOMGO_REQUEST_ADDRESS_SNAPSHOT_INVALID');
  }
  const items = snapshot.items.map(normalizeAddress);
  const ids = new Set(items.map(item => item.addressRowid));
  if (ids.size !== items.length) fail('SOOMGO_REQUEST_ADDRESS_SNAPSHOT_INVALID');
  return { ...snapshot, items };
}

function conditionalState(item) {
  if (typeof item.conditionalState === 'string' &&
    ['explicit_none', 'not_exposed', 'condition_present_unresolved'].includes(item.conditionalState)) {
    return item.conditionalState;
  }
  if (!Object.hasOwn(item, 'conditional')) return 'not_exposed';
  return item.conditional === null ? 'explicit_none' : 'condition_present_unresolved';
}

function scalarInput(value, field, maxLength, rule) {
  if (typeof value !== 'string' || value.length > maxLength || CONTROL.test(value) || !value.trim()) {
    fail('SOOMGO_REQUEST_ANSWER_INVALID', undefined, { field });
  }
  const text = value;
  if (rule?.maxLength !== undefined && (!Number.isSafeInteger(rule.maxLength) ||
    rule.maxLength < 1 || text.length > rule.maxLength)) {
    fail('SOOMGO_REQUEST_ANSWER_INVALID', undefined, { field, rule: 'maxLength' });
  }
  if (rule?.minLength !== undefined && (!Number.isSafeInteger(rule.minLength) ||
    rule.minLength < 0 || text.length < rule.minLength)) {
    fail('SOOMGO_REQUEST_ANSWER_INVALID', undefined, { field, rule: 'minLength' });
  }
  return text;
}

function dateRange(value, validation, now) {
  // The current public UI capture emits a plain YYYY-MM-DD value.
  const selectedDate = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
  if (!selectedDate || !Number.isFinite(Date.parse(`${selectedDate}T00:00:00Z`))) {
    fail('SOOMGO_REQUEST_ANSWER_INVALID', undefined, { rule: 'date_format' });
  }
  const [year, month, day] = selectedDate.split('-').map(Number);
  const parsedDay = new Date(Date.UTC(year, month - 1, day));
  if (parsedDay.getUTCFullYear() !== year || parsedDay.getUTCMonth() !== month - 1 || parsedDay.getUTCDate() !== day) {
    fail('SOOMGO_REQUEST_ANSWER_INVALID', undefined, { rule: 'date_format' });
  }
  const range = validation?.rangeFromToday;
  if (range === undefined || range === null) return { selectedDate, checked: false, reason: 'range_not_declared' };
  if (!Array.isArray(range) || range.length !== 2 || !range.every(v => Number.isSafeInteger(v)) ||
    range[0] < 0 || range[1] < range[0] || range[1] > 3650) {
    fail('SOOMGO_REQUEST_SCHEMA_INVALID', undefined, { field: 'validation.rangeFromToday' });
  }
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(now())).map(part => [part.type, part.value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const epochDay = date => Math.trunc(Date.UTC(...date.split('-').map((n, i) => i === 1 ? Number(n) - 1 : Number(n))) / 86_400_000);
  const delta = epochDay(selectedDate) - epochDay(today);
  if (delta < range[0] || delta > range[1]) fail('SOOMGO_REQUEST_ANSWER_INVALID', undefined,
    { rule: 'rangeFromToday', minDays: range[0], maxDays: range[1] });
  return { selectedDate, checked: true, daysFromToday: delta };
}

function optionById(item, optionId) {
  if (!Number.isSafeInteger(optionId) || optionId < 1) {
    fail('SOOMGO_REQUEST_ANSWER_INVALID', undefined, { field: 'answerId' });
  }
  const option = item.answerSchema.find(entry => entry.id === optionId);
  if (!option) fail('SOOMGO_REQUEST_ANSWER_INVALID', undefined, { itemId: item.id, answerId: optionId });
  return option;
}

function optionExtras(option, answerInput, item, answerId) {
  if (option.extra === undefined || option.extra === null) return { extraValue: null, requirednessKnown: true };
  if (!isRecord(option.extra)) fail('SOOMGO_REQUEST_SCHEMA_INVALID', undefined,
    { field: `items.${item.id}.answerSchema.${answerId}.extra` });
  const input = option.extra;
  const rule = isRecord(input.validation) ? input.validation : null;
  if (answerInput.extraValue === undefined || answerInput.extraValue === null || answerInput.extraValue === '') {
    return { extraValue: null, requirednessKnown: typeof input.required === 'boolean' };
  }
  if (typeof answerInput.extraValue !== 'string') fail('SOOMGO_REQUEST_ANSWER_INVALID', undefined,
    { itemId: item.id, answerId, field: 'extraValue' });
  return {
    extraValue: scalarInput(answerInput.extraValue, `answers.${item.id}.${answerId}.extraValue`,
      rule?.maxLength ?? 2000, rule),
    requirednessKnown: typeof input.required === 'boolean',
  };
}

function mapAddress(answer, item, addressOptions) {
  if (!isRecord(answer) || !isRecord(addressOptions) || addressOptions.service !== 'soomgo' ||
    addressOptions.operation !== 'address_options' || addressOptions.depth !== 3 ||
    !Array.isArray(addressOptions.items)) {
    fail('SOOMGO_REQUEST_ADDRESS_OPTIONS_REQUIRED', undefined, { itemId: item.id });
  }
  const levels = item.type === 6 ? ['addr1', 'addr2', 'addr3'] : null;
  if (!levels || item.answerSchema.length !== 3 || item.answerSchema.some((option, index) => option.id !== index + 1)) {
    fail('SOOMGO_REQUEST_ADDRESS_ANSWER_SCHEMA_UNSUPPORTED', undefined, { itemId: item.id });
  }
  const answerIds = item.answerSchema.map(option => option.id);
  if (answerIds.length !== 3 || answerIds.some((id, index) => id !== index + 1)) {
    fail('SOOMGO_REQUEST_ADDRESS_ANSWER_SCHEMA_UNSUPPORTED', undefined, { itemId: item.id });
  }
  let matches;
  if (answer.addressRowid !== undefined) {
    const rowid = positiveId(answer.addressRowid, `answers.${item.id}.addressRowid`);
    matches = addressOptions.items.filter(entry => entry.addressRowid === rowid);
  } else {
    for (const key of levels) requiredText(answer[key], `answers.${item.id}.${key}`, 120);
    matches = addressOptions.items.filter(entry => levels.every(level => entry[level] === answer[level]));
  }
  if (!matches.length) fail('SOOMGO_REQUEST_ADDRESS_NOT_IN_CATALOG', undefined, { itemId: item.id });
  const first = matches[0];
  if (matches.some(row => levels.some(level => row[level] !== first[level]))) {
    fail('SOOMGO_REQUEST_ADDRESS_AMBIGUOUS', undefined, { itemId: item.id });
  }
  if (levels.some(level => answer[level] !== undefined && answer[level] !== first[level])) {
    fail('SOOMGO_REQUEST_ADDRESS_MISMATCH', undefined, { itemId: item.id });
  }
  return {
    addressRowid: first.addressRowid,
    address: first.address,
    values: Object.fromEntries(levels.map(level => [level, first[level]])),
    answers: levels.map((level, index) => ({ answerId: index + 1, value: first[level], extraValue: '' })),
    uiStateMapping: 'observed',
  };
}

function prepareItem(item, rawInput, addressOptions, now) {
  if (rawInput === undefined || rawInput === null) return { state: 'unanswered', answers: [] };
  if (item.typeName === null) return { state: 'unsupported_input_type', answers: [] };
  const input = isRecord(rawInput) ? rawInput : null;
  if (!input) return { state: 'invalid_answer_shape', answers: [] };

  if (item.type === 1 || item.type === 2 || item.type === 4) {
    const ids = input.answerIds;
    if (!Array.isArray(ids) || ids.length > item.answerSchema.length) return { state: 'invalid_answer_shape', answers: [] };
    const multiple = item.type === 1;
    if (!multiple && ids.length > 1) return { state: 'too_many_choices', answers: [] };
    const extraInputs = isRecord(input.extraTextByAnswerId) ? input.extraTextByAnswerId : Object.create(null);
    const unique = new Set();
    const answers = [];
    let unknownExtra = false;
    for (const id of ids) {
      const option = optionById(item, id);
      if (unique.has(id)) return { state: 'duplicate_choice', answers: [] };
      unique.add(id);
      const extras = optionExtras(option, { extraValue: extraInputs[String(id)] }, item, id);
      if (option.extra && extras.extraValue === null) unknownExtra = true;
      answers.push({ answerId: id, value: option.text, extraValue: extras.extraValue ?? '' });
    }
    return {
      state: unknownExtra ? 'extra_answer_requiredness_unknown' : 'valid',
      answers: item.type === 1 ? answers : [],
      selection: item.type === 1 ? undefined : answers.map(answer => ({
        answerId: answer.answerId, label: answer.value, extraValue: answer.extraValue,
      })),
      uiStateMapping: item.type === 1 ? 'observed' : 'not_observed',
    };
  }

  if (item.type === 3 || item.type === 11) {
    const option = item.answerSchema[0];
    const value = scalarInput(input.value, `answers.${item.id}.value`, 5000,
      isRecord(option.validation) ? option.validation : null);
    return { state: 'valid', answers: [], value, uiStateMapping: 'not_observed' };
  }

  if (item.type === 5) {
    const option = item.answerSchema[0];
    const value = requiredText(input.value, `answers.${item.id}.value`, 100);
    const date = dateRange(value, isRecord(option.validation) ? option.validation : null, now);
    return {
      state: date.checked ? 'valid' : 'date_range_unchecked',
      answers: [{ answerId: option.id, value, extraValue: '' }], date,
      uiStateMapping: 'observed',
    };
  }

  if (item.type === 6 || item.type === 7) {
    if (item.type === 7) return { state: 'address2_wire_mapping_unobserved', answers: [] };
    if (!addressOptions) return { state: 'address_options_unavailable', answers: [] };
    const address = mapAddress(input, item, addressOptions);
    return { state: 'valid', answers: address.answers, address, uiStateMapping: 'observed' };
  }

  if (item.type === 10) {
    const values = input.valuesByAnswerId;
    if (!isRecord(values)) return { state: 'invalid_answer_shape', answers: [] };
    const answers = [];
    for (const option of item.answerSchema) {
      const value = values[String(option.id)] ?? '0';
      if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) {
        return { state: 'invalid_spinner_value', answers: [] };
      }
      answers.push({ answerId: option.id, value, extraValue: '', text: option.text ?? '' });
    }
    return { state: 'valid', answers: [], spinnerValues: answers, uiStateMapping: 'not_observed' };
  }

  if (item.type === 9) return { state: 'image_upload_contract_unavailable', answers: [] };
  return { state: 'unsupported_input_type', answers: [] };
}

export function createSoomgoRequestClient({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') fail('SOOMGO_REQUEST_CLIENT_CONFIGURATION_INVALID');

  async function readJson(path, query = [], maxBytes = MAX_FORM_BYTES) {
    const result = await commerceJsonRequest({
      service: 'soomgo', origin: SOOMGO_ORIGIN, path, query,
      method: 'GET', fetchImpl, now, maxBytes, timeoutMs: 20_000,
      userAgent: DEFAULT_USER_AGENT,
    });
    return { payload: result.payload, request: result.request };
  }

  return Object.freeze({
    async getServiceForm({ service: rawService } = {}) {
      const service = sourceService(rawService);
      const path = serviceFormPath(service);
      const { payload, request } = await readJson(path);
      if (!isRecord(payload) || payload.code !== 0 || !isRecord(payload.response)) {
        fail('SOOMGO_REQUEST_FORM_SCHEMA_INVALID', requestReceipt(request));
      }
      const form = normalizeForm(payload.response, service);
      return {
        schemaVersion: 1,
        service: 'soomgo',
        operation: 'service_request_form',
        observedAt: request.checkedAt,
        status: 'read_only_schema',
        form,
        conditionalCoverage: {
          itemCount: form.items.length,
          explicitNoConditionCount: form.items.filter(item => item.conditionalState === 'explicit_none').length,
          conditionalUnresolvedItemIds: form.schemaCoverage.unresolvedConditionalItems,
          complete: form.schemaCoverage.unresolvedConditionalItems.length === 0,
          reason: form.schemaCoverage.unresolvedConditionalItems.length
            ? 'form_does_not_expose_complete_condition_rules' : 'all_items_explicitly_unconditional',
        },
        requests: [requestReceipt(request)],
        contractProvenance: { ...SOOMGO_REQUEST_CONTRACT },
        dispatch: { supported: false, requestSent: false, requestWriteVerification: 'not_attempted' },
      };
    },

    async listAddressOptions({ areaDepth = 3 } = {}) {
      if (areaDepth !== 3) fail('SOOMGO_REQUEST_ADDRESS_DEPTH_UNVERIFIED');
      const depth = `area${areaDepth}`;
      const { payload, request } = await readJson(ADDRESS_PATH, [['depth', depth]], MAX_ADDRESS_BYTES);
      if (!isRecord(payload) || payload.code !== 0 || !isRecord(payload.response) ||
        !Array.isArray(payload.response.addresses) || payload.response.addresses.length > 100_000) {
        fail('SOOMGO_REQUEST_ADDRESS_SCHEMA_INVALID', requestReceipt(request));
      }
      const items = payload.response.addresses.map(normalizeAddress);
      if (new Set(items.map(item => item.addressRowid)).size !== items.length) {
        fail('SOOMGO_REQUEST_ADDRESS_SCHEMA_INVALID', requestReceipt(request));
      }
      return {
        schemaVersion: 1,
        service: 'soomgo',
        operation: 'address_options',
        observedAt: request.checkedAt,
        depth: areaDepth,
        items,
        coverage: {
          returned: items.length,
          sourceTotal: null,
          complete: false,
          reason: 'provider_does_not_report_address_total_or_pagination',
          next: null,
        },
        requests: [requestReceipt(request)],
        contractProvenance: { ...SOOMGO_REQUEST_CONTRACT },
      };
    },
  });
}

/**
 * Build a local, never-dispatched questionnaire draft from a current form read.
 * No submission route is exposed; service form answers are only one step in the
 * full account, contact verification, and consent flow.
 */
export function prepareSoomgoRequest(formResult, {
  answersByItemId = {}, addressOptions = undefined, now = Date.now,
} = {}) {
  if (!isRecord(formResult) || formResult.service !== 'soomgo' ||
    formResult.operation !== 'service_request_form' || !isRecord(formResult.form) ||
    !Array.isArray(formResult.form.items)) {
    fail('SOOMGO_REQUEST_FORM_READ_REQUIRED');
  }
  if (typeof now !== 'function') fail('SOOMGO_REQUEST_CLIENT_CONFIGURATION_INVALID');
  const formInput = cloneJson(formResult.form, 'form', {
    nodes: 0, bytes: 0, maxNodes: MAX_FORM_INPUT_NODES,
    maxBytes: MAX_FORM_INPUT_BYTES, maxDepth: MAX_FORM_INPUT_DEPTH,
  });
  const formService = sourceService(formInput.service);
  const form = normalizeForm(formInput, formService);
  const inputs = safeInputObject(answersByItemId, 'answersByItemId');
  const addressCatalog = addressOptions === undefined ? undefined : normalizeAddressOptions(addressOptions);
  const items = form.items;
  const itemIds = new Set(items.map(item => String(item.id)));
  for (const key of Object.keys(inputs)) {
    if (!itemIds.has(key)) fail('SOOMGO_REQUEST_INPUT_UNKNOWN_ITEM', undefined, { itemId: key });
  }

  const missingRequiredItemIds = [];
  const invalidItemIds = [];
  const unsupportedItemIds = [];
  const unresolvedConditionalItemIds = [];
  const unresolvedRuleItemIds = [];
  const unresolvedUiStateMappingItemIds = [];
  const preparedAnswers = [];
  const answerStates = [];

  for (const item of items) {
    if (conditionalState(item) !== 'explicit_none') unresolvedConditionalItemIds.push(item.id);
    const input = inputs[String(item.id)];
    const normalized = prepareItem(item, input, addressCatalog, now);
    answerStates.push({ itemId: item.id, state: normalized.state });
    if (input !== undefined && input !== null && normalized.uiStateMapping !== 'observed') {
      unresolvedUiStateMappingItemIds.push(item.id);
    }
    if (item.required && (input === undefined || input === null)) missingRequiredItemIds.push(item.id);
    if (normalized.state === 'valid' || normalized.state === 'date_range_unchecked' ||
      normalized.state === 'extra_answer_requiredness_unknown') {
      if (normalized.answers.length || normalized.address) {
        preparedAnswers.push({
          itemId: item.id,
          type: item.typeName,
          answers: normalized.answers,
          ...(normalized.selection ? { selection: normalized.selection } : {}),
          ...(normalized.value ? { value: normalized.value } : {}),
          ...(normalized.spinnerValues ? { spinnerValues: normalized.spinnerValues } : {}),
          uiStateMapping: normalized.uiStateMapping ?? 'not_observed',
          ...(normalized.address ? { address: normalized.address } : {}),
        });
      } else if (normalized.selection || normalized.value || normalized.spinnerValues) {
        preparedAnswers.push({
          itemId: item.id,
          type: item.typeName,
          ...(normalized.selection ? { selection: normalized.selection } : {}),
          ...(normalized.value ? { value: normalized.value } : {}),
          ...(normalized.spinnerValues ? { spinnerValues: normalized.spinnerValues } : {}),
          uiStateMapping: normalized.uiStateMapping ?? 'not_observed',
        });
      }
      if (normalized.state !== 'valid') unresolvedRuleItemIds.push(item.id);
    } else if (input !== undefined && input !== null) {
      invalidItemIds.push(item.id);
      unsupportedItemIds.push(item.id);
    }
    if (item.required && normalized.state === 'unanswered') {
      // Already reported as missing, preserve the local UI's empty-answer state.
    } else if (item.required && normalized.state !== 'valid' && normalized.state !== 'date_range_unchecked' &&
      normalized.state !== 'extra_answer_requiredness_unknown') {
      if (input !== undefined && input !== null) invalidItemIds.push(item.id);
      else missingRequiredItemIds.push(item.id);
    }
    if (item.required && input !== undefined && input !== null &&
      (normalized.state === 'valid' || normalized.state === 'date_range_unchecked' ||
        normalized.state === 'extra_answer_requiredness_unknown') &&
      normalized.answers.length === 0 && !normalized.address && !normalized.selection &&
      normalized.value === undefined && !normalized.spinnerValues) {
      invalidItemIds.push(item.id);
    }
  }

  const dedupe = values => [...new Set(values)];
  const missing = dedupe(missingRequiredItemIds);
  const invalid = dedupe(invalidItemIds);
  const unsupported = dedupe(unsupportedItemIds);
  const conditionUnresolved = dedupe(unresolvedConditionalItemIds);
  const rulesUnresolved = dedupe(unresolvedRuleItemIds);
  const uiStateMappingUnresolved = dedupe(unresolvedUiStateMappingItemIds);
  const wireMappingUnresolved = dedupe(preparedAnswers.map(item => item.itemId));
  const payloadComplete = missing.length === 0 && invalid.length === 0 && unsupported.length === 0 &&
    conditionUnresolved.length === 0 && rulesUnresolved.length === 0;

  return {
    schemaVersion: 1,
    service: 'soomgo',
    operation: 'prepare_request',
    status: 'prepared_only',
    observedAt: new Date(now()).toISOString(),
    serviceContext: {
      id: form.service.id,
      slug: form.service.slug,
      name: form.service.name,
      formId: form.id,
    },
    preparedAnswers,
    validation: {
      scope: 'service_form_answers_only',
      payloadComplete,
      requestReady: false,
      uiStateMappingComplete: uiStateMappingUnresolved.length === 0,
      unresolvedUiStateMappingItemIds: uiStateMappingUnresolved,
      wireMappingVerified: false,
      wireMappingComplete: false,
      missingRequiredItemIds: missing,
      invalidItemIds: invalid,
      unsupportedItemIds: unsupported,
      unresolvedConditionalItemIds: conditionUnresolved,
      unresolvedRuleItemIds: rulesUnresolved,
      unresolvedWireMappingItemIds: wireMappingUnresolved,
      answerStates,
    },
    gates: {
      authentication: 'not_attempted',
      phoneVerification: 'not_attempted',
      accountDetails: 'not_prepared',
      termsConsent: 'not_confirmed',
      privacyConsent: 'not_confirmed',
      dispatchSupported: false,
      requestSent: false,
      externallySubmitted: false,
    },
    requests: [],
    contractProvenance: { ...SOOMGO_REQUEST_CONTRACT },
  };
}

export const SOOMGO_REQUEST_CAPABILITIES = Object.freeze({
  formRead: 'first_party_bundle_contract',
  addressOptionsRead: 'first_party_bundle_contract',
  localQuestionnairePreparation: 'prepared_only',
  serviceQuestionValidationWrite: 'not_implemented',
  requestDispatch: 'not_implemented',
  accountRegistrationAndContactVerification: 'not_implemented',
  authAndTermsConsent: 'not_implemented',
});

export function dispatchSoomgoRequest() {
  fail('SOOMGO_REQUEST_SUBMIT_UNAVAILABLE');
}

// Keep the observed static values reachable for offline checkers without loading
// or re-evaluating the vendor's minified bundle.
export const SOOMGO_REQUEST_TYPES = ITEM_TYPES;
export const SOOMGO_REQUEST_SERVICE_ORIGIN = SOOMGO_ORIGIN;
export const SOOMGO_REQUEST_WEB_ORIGIN = WEB_ORIGIN;
