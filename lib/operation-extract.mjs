import { parseHTML } from 'linkedom';

// Parsing budgets, not transport policy: the caller still validates HTTP status
// and MIME and owns fetching, retries, and pagination.
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_ITEMS = 1000;
const MAX_FIELDS = 100;
const MAX_SELECTOR_LENGTH = 1024;
const MAX_POINTERS = 100;
const MAX_POINTER_LENGTH = 4096;
const FORMATS = new Set(['json', 'html', 'text', 'empty', 'ssr_json']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function fail(code) {
  // Never retain parser messages, causes, URLs, selectors, or response samples.
  throw Object.assign(new Error(code), { code });
}

function pointerTokens(pointer) {
  if (typeof pointer !== 'string' || pointer.length > MAX_POINTER_LENGTH
    || pointer !== '' && !pointer.startsWith('/') || /~(?![01])/.test(pointer)) {
    fail('EXTRACT_CONFIG_INVALID');
  }
  return pointer === '' ? [] : pointer.slice(1).split('/').map(token => token.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function atPointer(data, tokens) {
  let value = data;
  for (const token of tokens) {
    if (value === null || typeof value !== 'object'
      || Array.isArray(value) && !/^(?:0|[1-9][0-9]*)$/.test(token)
      || !Object.hasOwn(value, token)) fail('EXTRACT_REQUIRED_MISSING');
    value = value[token];
  }
  return value;
}

function selector(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_SELECTOR_LENGTH) {
    fail('EXTRACT_CONFIG_INVALID');
  }
  return value.trim();
}

function fields(value) {
  if (!object(value) || Object.keys(value).length > MAX_FIELDS) fail('EXTRACT_CONFIG_INVALID');
  return Object.entries(value).map(([name, field]) => {
    if (!object(field) || field.attribute !== undefined && (typeof field.attribute !== 'string' || !field.attribute.trim())
      || field.required !== undefined && typeof field.required !== 'boolean'
      || field.absoluteUrl !== undefined && typeof field.absoluteUrl !== 'boolean') fail('EXTRACT_CONFIG_INVALID');
    return [name, { selector: selector(field.selector), attribute: field.attribute,
      required: field.required === true, absoluteUrl: field.absoluteUrl === true }];
  });
}

function declaration(config) {
  if (!object(config)) fail('EXTRACT_CONFIG_INVALID');
  const format = config.format === undefined ? 'json' : config.format;
  if (!FORMATS.has(format)) fail('EXTRACT_CONFIG_INVALID');
  const pointers = config.requiredPointers === undefined ? [] : config.requiredPointers;
  if (!Array.isArray(pointers) || pointers.length > MAX_POINTERS
    || pointers.length && !['json', 'ssr_json'].includes(format)) fail('EXTRACT_CONFIG_INVALID');
  const result = { format, pointers: Array.from(pointers, pointerTokens) };
  if (format === 'html') {
    const html = config.html;
    if (!object(html)) fail('EXTRACT_CONFIG_INVALID');
    const limit = html.limit === undefined ? MAX_ITEMS : html.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ITEMS) fail('EXTRACT_CONFIG_INVALID');
    result.html = { items: selector(html.items), fields: fields(html.fields),
      page: html.page === undefined ? [] : fields(html.page), limit };
  }
  if (format === 'ssr_json') {
    const ssr = config.ssr;
    if (!object(ssr) || typeof ssr.key !== 'string' || !ssr.key.trim() || ssr.key.length > 256) {
      fail('EXTRACT_CONFIG_INVALID');
    }
    result.ssr = { key: ssr.key, pointer: pointerTokens(ssr.pointer === undefined ? '' : ssr.pointer) };
  }
  return result;
}

function parseJson(raw) {
  try { return JSON.parse(raw.replace(/^\uFEFF/, '')); }
  catch { fail('EXTRACT_JSON_INVALID'); }
}

function parseDocument(raw) {
  // linkedom constructs an inert document: no script execution or URL loading.
  try { return parseHTML(raw).document; }
  catch { fail('EXTRACT_HTML_INVALID'); }
}

function matches(root, value) {
  // Explicitly support fields on the repeated element itself, not only children.
  if (value === ':scope') {
    const scope = root.nodeType === 1 ? root : root.documentElement;
    return scope ? [scope] : [];
  }
  try { return root.querySelectorAll(value); }
  catch { fail('EXTRACT_SELECTOR_INVALID'); }
}

function absoluteHttpUrl(value, base) {
  let url;
  try { url = new URL(value); }
  catch {
    try {
      const baseUrl = new URL(base);
      if (!['http:', 'https:'].includes(baseUrl.protocol)) fail('EXTRACT_URL_INVALID');
      url = new URL(value, baseUrl);
    } catch { fail('EXTRACT_URL_INVALID'); }
  }
  if (!['http:', 'https:'].includes(url.protocol)) fail('EXTRACT_URL_INVALID');
  return url.href;
}

function record(root, entries, base) {
  return Object.fromEntries(entries.map(([name, field]) => {
    const nodes = matches(root, field.selector);
    if (nodes.length > 1) fail('EXTRACT_SELECTOR_AMBIGUOUS');
    const node = nodes[0];
    let value = node ? field.attribute === undefined
      ? node.textContent.replace(/\s+/g, ' ').trim() : node.getAttribute(field.attribute)?.trim() : null;
    if (value === undefined || value === '') value = null;
    if (value === null && field.required) fail('EXTRACT_REQUIRED_MISSING');
    if (value !== null && field.absoluteUrl) value = absoluteHttpUrl(value, base);
    return [name, value];
  }));
}

function htmlResult(document, html, base) {
  // Compile every field selector even for an empty list, so declaration errors
  // never depend on whether this particular page contains records.
  const probe = document.createElement('div');
  for (const [, field] of [...html.fields, ...html.page]) matches(probe, field.selector);
  const nodes = matches(document, html.items);
  const data = [];
  for (let i = 0; i < Math.min(nodes.length, html.limit); i++) data.push(record(nodes[i], html.fields, base));
  return { format: 'html', data, pageInfo: record(document, html.page, base) };
}

function ssrData(document, ssr) {
  const candidates = [...document.querySelectorAll('script')].filter(script => {
    const type = (script.getAttribute('type') ?? '').split(';', 1)[0].trim().toLowerCase();
    return script.getAttribute('id') === ssr.key
      || /^application\/(?:[\w.-]+\+)?json$/.test(type) && type === ssr.key.toLowerCase();
  });
  if (!candidates.length) fail('EXTRACT_SSR_MISSING');
  if (candidates.length !== 1) fail('EXTRACT_SSR_AMBIGUOUS');
  return atPointer(parseJson(candidates[0].textContent), ssr.pointer);
}

/**
 * Extract a buffered operation response without network access or side effects.
 *
 * @param {{status: number, headers: object, raw: string, url?: string}} response
 * @param {{format?: 'json'|'html'|'text'|'empty'|'ssr_json', requiredPointers?: string[],
 *   html?: {items: string, fields: Object<string, {selector: string, attribute?: string,
 *     required?: boolean, absoluteUrl?: boolean}>, page?: Object<string, {selector: string,
 *     attribute?: string, required?: boolean, absoluteUrl?: boolean}>, limit?: number},
 *   ssr?: {key: string, pointer?: string}}} config
 * @returns {{format: string, data: *, pageInfo: object}}
 *
 * Default format: json. Required RFC 6901 pointers assert presence (null is
 * present); for SSR they are relative to the selected ssr.pointer result.
 * ssr.key matches a literal script id or JSON MIME type, never JavaScript.
 * HTML page fields are document-scoped; item fields are record-scoped, with
 * :scope selecting the item itself. Text is whitespace-normalized; attributes
 * are trimmed. Missing/blank fields become null, or fail when required.
 * Bodies are limited to 4 MiB UTF-8; HTML limit caps output, defaults to 1000,
 * and must be 1..1000. Each field map and pointer list is limited to 100 entries;
 * selectors to 1024 characters and JSON pointers to 4096 characters.
 * Recoverable HTML is accepted using normal HTML parser semantics.
 * Errors expose only a stable EXTRACT_* code, also used as the message.
 */
export function extractOperationResponse(response, config = {}) {
  const spec = declaration(config);
  if (!object(response) || typeof response.raw !== 'string') fail('EXTRACT_RESPONSE_INVALID');
  const raw = response.raw;
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) fail('EXTRACT_BODY_TOO_LARGE');
  let data;
  if (spec.format === 'html') return htmlResult(parseDocument(raw), spec.html, response.url);
  if (spec.format === 'ssr_json') data = ssrData(parseDocument(raw), spec.ssr);
  else if (spec.format === 'json') data = parseJson(raw);
  else if (spec.format === 'text') data = raw;
  else {
    if (raw.trim() !== '') fail('EXTRACT_EMPTY_MISMATCH');
    data = null;
  }
  for (const pointer of spec.pointers) atPointer(data, pointer);
  return { format: spec.format, data, pageInfo: {} };
}
