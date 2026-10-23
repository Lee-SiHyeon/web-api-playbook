import { parse } from 'parse5';
import { extractPublicPage } from './cps-public-reader.mjs';

const MAX_HTML_BYTES = 8 * 1024 * 1024;
const MAX_NODES = 15000;
const fail = code => { throw Object.assign(new Error(code), { code }); };

function fieldName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$.-]{0,63}$/.test(value)) return null;
  if (value.length >= 24 && /[A-Z]/.test(value) && /[a-z]/.test(value) && /\d/.test(value)) return ':dynamic';
  return value;
}

// Store URL structure only: never query values, fragments, credentials or tunnel URLs.
function routeShape(value, baseUrl) {
  let url;
  try { url = new URL(value, baseUrl); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      /(?:^|\.)(?:trycloudflare\.com|ngrok-free\.app)$/i.test(url.hostname)) return null;
  const parts = url.pathname.split('/');
  const sensitive = /^(?:account|auth|authorization|code|csrf|email|key|member|nonce|password|profile|refresh|session|signature|state|token|user)$/i;
  const path = parts.map((part, index) => {
    if (!part) return '';
    if (part.startsWith(':')) return ':id';
    if (sensitive.test(parts[index - 1]) && !/^(?:callback|config|list|login|refresh|search|settings)$/i.test(part)) return ':id';
    return !/^[A-Za-z0-9_.~-]{1,64}$/.test(part) || /^\d{3,}$/.test(part) || /^[a-f0-9]{16,}$/i.test(part) ||
      /^[a-f0-9]{8}-[a-f0-9-]{27,}$/i.test(part) || /^[A-Za-z0-9_-]{24,}$/.test(part) ? ':id' : part;
  }).join('/') || '/';
  return { origin: url.origin, path, queryFields: [...new Set([...url.searchParams.keys()].map(fieldName).filter(Boolean))].sort().slice(0, 64) };
}

// Pure and self-contained so exactly the same structural analysis can run against
// parse5 nodes or a read-only DOM snapshot. No network, storage or page JS execution.
function summarizeFacts(facts, { truncated = false } = {}) {
  const safeName = value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_-]{0,47}$/.test(value) &&
    !/\d{6,}|^[a-f0-9]{16,}$/i.test(value) &&
    !(value.length >= 24 && /[A-Z]/.test(value) && /[a-z]/.test(value) && /\d/.test(value)) ? value : null;
  const tags = {}, signatures = new Map(), forms = [], summaries = [];
  const jsonTypes = new Set(['Product', 'ProductGroup', 'Offer', 'AggregateOffer', 'AggregateRating', 'Review', 'ItemList', 'ListItem', 'Organization', 'WebPage', 'BreadcrumbList']);
  const typeCounts = {}, jsonBlocks = [];
  let jsonBudget = 2 * 1024 * 1024, remainingJsonNodes = 4000, jsonCandidateBlocks = 0;
  for (const [index, fact] of facts.entries()) {
    const tag = /^[a-z][a-z0-9-]{0,31}$/.test(fact.tag || '') ? fact.tag : 'unknown';
    tags[tag] = (tags[tag] || 0) + 1;
    const classes = [...new Set(String(fact.classes || '').split(/\s+/).map(safeName).filter(Boolean))].slice(0, 2).sort();
    const selector = tag + classes.map(name => '.' + name).join('');
    summaries.push({ parent: fact.parent, selector, price: !!fact.price, review: !!fact.review,
      anchors: tag === 'a' ? 1 : 0, images: tag === 'img' ? 1 : 0 });
    if (tag === 'form') {
      forms.push({ elementIndex: index, selector: safeName(fact.id) ? 'form#' + fact.id : 'form',
        method: /^(?:get|post|dialog)$/i.test(fact.method || '') ? fact.method.toUpperCase() : 'GET',
        controls: [], fieldValuesRecorded: false, requestObserved: false });
    }
    if (tag !== 'script' || !['application/ld+json', 'application/json'].includes(fact.scriptType)) continue;
    jsonCandidateBlocks++;
    if (jsonBlocks.length >= 32) continue;
    const block = { elementIndex: index, format: fact.scriptType, marker: fact.id === '__NEXT_DATA__' ? '__NEXT_DATA__' : null,
      parsed: false, fieldNames: [], valuesRecorded: false };
    const raw = typeof fact.jsonText === 'string' ? fact.jsonText : '';
    if (!raw || raw.length > 256 * 1024 || raw.length > jsonBudget || remainingJsonNodes <= 0) {
      block.omitted = 'size_or_node_limit'; jsonBlocks.push(block); continue;
    }
    jsonBudget -= raw.length;
    try {
      const data = JSON.parse(raw), stack = [{ value: data, depth: 0 }], fields = new Set();
      block.parsed = true;
      while (stack.length && remainingJsonNodes > 0) {
        const { value, depth } = stack.pop(); remainingJsonNodes--;
        if (!value || typeof value !== 'object' || depth > 12) continue;
        if (!Array.isArray(value)) {
          for (const type of Array.isArray(value['@type']) ? value['@type'] : [value['@type']]) {
            if (jsonTypes.has(type)) typeCounts[type] = (typeCounts[type] || 0) + 1;
          }
          for (const key of Object.keys(value).slice(0, 100)) if (safeName(key) && fields.size < 80) fields.add(key);
        }
        const children = Object.values(value);
        if (children.length > 100 || depth === 12 && children.some(child => child && typeof child === 'object')) block.truncated = true;
        for (const child of children.slice(0, 100)) if (child && typeof child === 'object') stack.push({ value: child, depth: depth + 1 });
      }
      if (stack.length) block.truncated = true;
      block.fieldNames = [...fields].sort();
    } catch { block.invalidJson = true; }
    jsonBlocks.push(block);
  }
  const formByIndex = new Map(forms.map(form => [form.elementIndex, form]));
  for (const [index, fact] of facts.entries()) {
    if (!['input', 'button', 'select', 'textarea'].includes(fact.tag)) continue;
    let parent = fact.parent;
    for (let depth = 0; Number.isInteger(parent) && parent >= 0 && parent < index && depth < 100; depth++) {
      const form = formByIndex.get(parent);
      if (form) {
        if (form.controls.length < 80) form.controls.push({ elementIndex: index, tag: fact.tag,
          name: safeName(fact.name), type: safeName(fact.type) || fact.tag,
          required: !!fact.required, disabled: !!fact.disabled });
        else form.truncated = true;
        break;
      }
      parent = facts[parent]?.parent;
    }
  }
  // Propagate only booleans/counts; raw text never leaves the traversal.
  for (let index = summaries.length - 1; index >= 0; index--) {
    const row = summaries[index], parent = row.parent;
    if (Number.isInteger(parent) && parent >= 0 && parent < index) {
      summaries[parent].price ||= row.price; summaries[parent].review ||= row.review;
      summaries[parent].anchors += row.anchors; summaries[parent].images += row.images;
    }
    if (!['div', 'li', 'article', 'section', 'tr', 'a'].includes(facts[index].tag) || !row.selector.includes('.')) continue;
    const group = signatures.get(row.selector) || { selector: row.selector, signatureOccurrences: 0,
      withPriceText: 0, withReviewText: 0, withLinksAndImages: 0, inferred: true, selectorMatchVerified: false };
    group.signatureOccurrences++; group.withPriceText += Number(row.price); group.withReviewText += Number(row.review);
    group.withLinksAndImages += Number(row.anchors > 0 && row.images > 0);
    signatures.set(row.selector, group);
  }
  const repeated = [...signatures.values()].filter(row => row.signatureOccurrences >= 2)
    .sort((a, b) => b.withPriceText - a.withPriceText || b.withLinksAndImages - a.withLinksAndImages || b.signatureOccurrences - a.signatureOccurrences);
  return { elementCount: facts.length, tagCounts: tags, traversalTruncated: truncated,
    forms: forms.slice(0, 30), formsTruncated: forms.length > 30,
    repeatedSelectors: repeated.slice(0, 60), selectorsTruncated: repeated.length > 60,
    structuredData: { blocks: jsonBlocks, typeNodeCounts: typeCounts, uniqueProductsVerified: false,
      truncated: jsonCandidateBlocks > jsonBlocks.length || remainingJsonNodes <= 0 || jsonBlocks.some(block => block.truncated || block.omitted) },
    rawTextRecorded: false, inputValuesRecorded: false, ontologyPromotionAllowed: false };
}

function elementFact(tag, attrs, ownText, parent) {
  const values = Object.fromEntries(attrs.map(attr => [attr.name, attr.value]));
  const structural = { tag, parent, classes: values.class, id: values.id, method: values.method,
    name: values.name, type: values.type, required: Object.hasOwn(values, 'required'), disabled: Object.hasOwn(values, 'disabled') };
  if (tag === 'script') {
    structural.scriptType = String(values.type || '').toLowerCase().split(';')[0].trim();
    if (['application/json', 'application/ld+json'].includes(structural.scriptType)) structural.jsonText = ownText;
  } else if (!['style', 'noscript', 'input', 'textarea'].includes(tag)) {
    const text = ownText.slice(0, 8000);
    structural.price = /(?:₩\s*[\d,]+|[\d,]+\s*(?:원|KRW)|\$\s*\d)/i.test(text);
    structural.review = /리뷰|구매후기|상품평|평점|\breviews?\b|\brating\b/i.test(text);
  }
  return structural;
}

function requestSummary(inventory) {
  if (inventory == null) return [];
  if (inventory.schema !== 'xhr-contract-inventory-v1' || !Array.isArray(inventory.contracts) || inventory.contracts.length > 2000)
    fail('DOM_REQUEST_INVENTORY_SCHEMA');
  return inventory.contracts.map(contract => {
    if (typeof contract?.origin !== 'string' || typeof contract.path !== 'string' ||
        !/^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(contract.method)) fail('DOM_REQUEST_INVENTORY_SCHEMA');
    const route = routeShape(contract.path, contract.origin);
    if (!route || route.origin !== contract.origin) fail('DOM_REQUEST_INVENTORY_SCHEMA');
    const names = list => Array.isArray(list) ? [...new Set(list.map(fieldName).filter(Boolean))].sort().slice(0, 64) : [];
    const observations = Array.isArray(contract.observations) ? contract.observations : [];
    return { ...route, method: contract.method, queryFields: names(contract.queryFields), bodyFields: names(contract.bodyFields),
      observedInSuppliedRecording: observations.length > 0,
      recordedStatuses: [...new Set(observations.map(item => item?.status).filter(status => Number.isInteger(status) && status >= 100 && status <= 599))].sort(),
      liveReplayVerified: false, responseValuesRecorded: false };
  });
}

export function analyzeHtml(html, { baseUrl, requestInventory = null } = {}) {
  if (typeof html !== 'string' || !html.length || Buffer.byteLength(html) > MAX_HTML_BYTES) fail('DOM_HTML_INPUT_LIMIT');
  const base = routeShape(baseUrl);
  if (!base) fail('DOM_BASE_URL_INVALID');
  const document = parse(html), facts = [], stack = [{ node: document, parent: null }];
  while (stack.length && facts.length < MAX_NODES) {
    const { node, parent } = stack.pop();
    let nextParent = parent;
    if (node.tagName) {
      nextParent = facts.length;
      const ownText = (node.childNodes || []).filter(child => child.nodeName === '#text').map(child => child.value.slice(0, 262145)).join('').slice(0, 262145);
      facts.push(elementFact(node.tagName, node.attrs || [], ownText, parent));
    }
    for (let index = (node.childNodes?.length || 0) - 1; index >= 0; index--)
      if (node.childNodes[index].nodeName !== '#text') stack.push({ node: node.childNodes[index], parent: nextParent });
  }
  const structure = summarizeFacts(facts, { truncated: stack.length > 0 });
  // Reuse the maintained extractor. Its data values stay internal to this analysis.
  let effectiveBaseUrl = baseUrl;
  const pending = [document];
  while (pending.length) {
    const node = pending.pop();
    if (node.tagName === 'base') {
      const href = node.attrs?.find(attr => attr.name === 'href')?.value;
      if (href && routeShape(href, baseUrl)) effectiveBaseUrl = new URL(href, baseUrl).href;
      break;
    }
    for (let index = (node.childNodes?.length || 0) - 1; index >= 0; index--) pending.push(node.childNodes[index]);
  }
  const page = extractPublicPage({ html, url: baseUrl }, { documentBaseUrl: effectiveBaseUrl });
  const requests = requestSummary(requestInventory);
  const routes = new Map();
  for (const link of page.links) {
    const shape = routeShape(link.url, baseUrl); if (!shape) continue;
    const key = JSON.stringify(shape);
    if (routes.has(key)) { routes.get(key).occurrences++; continue; }
    const related = requests.filter(request => request.origin === shape.origin && request.path === shape.path && request.observedInSuppliedRecording);
    routes.set(key, { ...shape, occurrences: 1, candidateOnly: true,
      recordedRequestMethodsAtSameRoute: [...new Set(related.map(request => request.method))],
      exactRequestIdentityVerified: false });
  }
  const formTargets = page.forms.map(form => ({ method: /^(?:GET|POST|DIALOG)$/.test(form.method) ? form.method : 'UNKNOWN',
    action: routeShape(form.action, baseUrl), fields: [...new Set(form.controls.map(control => fieldName(control.name)).filter(Boolean))],
    requestObserved: false })).filter(form => form.action);
  return { schema: 'xhr-dom-analysis-v1', source: { kind: 'provided_html', base, effectiveBase: routeShape(effectiveBaseUrl),
    networkRequests: 0, browserUsed: false, pageScriptsExecuted: false, liveReplayVerified: false },
    structure, routes: [...routes.values()], formTargets, requests,
    candidateOfferingCount: page.records.length, candidateOfferingsValidated: false,
    limitations: ['Selectors are structural candidates; signature counts are not live CSS match counts.',
      'Recorded requests are supplied evidence, not a replay performed by this tool.',
      'JSON-LD node counts are not verified distinct offerings. Form submitter overrides and shadow roots require separate inspection.'] };
}

// Paste the returned function into the browser tool's read-only DOM evaluation.
// Only this optional discovery step uses a browser. It sends no HTTP requests.
export function browserDomProbeSource() {
  return `() => {
    const elementFact = ${elementFact.toString()};
    const summarizeFacts = ${summarizeFacts.toString()};
    const facts = [], stack = document.documentElement ? [{ node: document.documentElement, parent: null }] : [];
    while (stack.length && facts.length < ${MAX_NODES}) {
      const { node, parent } = stack.pop();
      const index = facts.length;
      const attrs = Array.from(node.attributes).filter(attr => ['class','id','method','name','type','required','disabled'].includes(attr.name)).map(attr => ({ name: attr.name, value: attr.value }));
      const text = Array.from(node.childNodes).filter(child => child.nodeType === 3).map(child => (child.textContent || '').slice(0, 262145)).join('').slice(0, 262145);
      facts.push(elementFact(node.tagName.toLowerCase(), attrs, text, parent));
      for (let i = node.children.length - 1; i >= 0; i--) stack.push({ node: node.children[i], parent: index });
    }
    return { schema: 'xhr-dom-structure-v1', source: { kind: 'read_only_live_dom', browserUsed: true,
      networkRequestsByProbe: 0, cookiesRead: false, browserStorageRead: false, liveReplayVerified: false },
      structure: summarizeFacts(facts, { truncated: stack.length > 0 }) };
  }`;
}
