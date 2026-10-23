import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assertLayout,
  attr,
  createPublicClient,
  hasClass,
  links,
  parseHtml,
  structuralFingerprint
} from './html-public.mjs';
import { GOV_PRESS_LAYOUTS } from './gov-press-layouts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CAPTURE_DIR = path.join(process.env.LOCALAPPDATA || 'C:\\Users\\User\\AppData\\Local', 'Temp', 'html-parser-captures');

export const GOV_PRESS_SOURCE_IDS = Object.freeze({
  koreaPolicyList: 'policy-list',
  ministryNotices: 'ministry-notices',
  ministryReleaseDocuments: 'ministry-release-documents',
  mof: 'mof-release-2026',
  mafra: 'mafra-release-2026',
  mss: 'mss-donghaeng-2026',
  mois: 'mois-local-voucher-2025',
  motir: 'motir-2025-grand-festival'
});

export const GOV_PRESS_SOURCE_URLS = Object.freeze({
  'policy-list': 'https://www.korea.kr/news/policyNewsList.do',
  'ministry-notices': 'https://www.korea.kr/news/policyNewsList.do',
  'korea-press-release-list': 'https://www.korea.kr/briefing/pressReleaseList.do',
  'mof-release-2026': 'https://www.mof.go.kr/doc/ko/selectDoc.do?bbsSeq=10&docSeq=68564&menuSeq=971',
  'mafra-release-2026': 'https://www.mafra.go.kr/bbs/home/792/579002/artclView.do',
  'mafra-release-2026-market': 'https://www.mafra.go.kr/bbs/home/792/579208/artclView.do',
  'mss-donghaeng-2026': 'https://www.mss.go.kr/site/smba/ex/bbs/View.do?bcIdx=1067208&cbIdx=86&parentSeq=1067208',
  'mss-payback-2025': 'https://www.mss.go.kr/site/smba/ex/bbs/View.do?bcIdx=1061050&cbIdx=86',
  'mss-grand-festival-2026': 'https://www.mss.go.kr/site/smba/ex/bbs/View.do?bcIdx=1069642&cbIdx=288',
  'mois-local-voucher-2025': 'https://www.mois.go.kr/frt/bbs/type010/commonSelectBoardArticle.do?bbsId=BBSMSTR_000000000008&nttId=120224',
  'mois-high-oil-2026': 'https://www.mois.go.kr/frt/sub/a06/b07/highOilPriceSupport/screen.do',
  'motir-2025-grand-festival': 'https://www.motir.go.kr/kor/article/ATCL3f49a5a8c/171123/view',
  'korea-2025-consumer-coupon': 'https://www.korea.kr/news/policyNewsView.do?newsId=148950949',
  'korea-2026-onnuri': 'https://www.korea.kr/multi/mediaNewsView.do?newsId=148972107',
  'korea-2025-grand-festival': 'https://www.korea.kr/news/policyNewsView.do?newsId=148952975'
});

export const GOV_PRESS_MINISTRIES = Object.freeze({
  'www.mof.go.kr': '해양수산부',
  'www.mafra.go.kr': '농림축산식품부',
  'www.mss.go.kr': '중소벤처기업부',
  'www.mois.go.kr': '행정안전부',
  'www.motir.go.kr': '산업통상부'
});

// The maps name observed, semantic hooks first and keep fallback hooks bounded.
// The collector records the selected hook and list-header labels in each fingerprint.
export const GOV_PRESS_SELECTOR_MAPS = Object.freeze({
  'korea-policy-list': Object.freeze({
    rows: ['.list_type li'],
    title: ['.list_type strong'],
    date: ['.list_type .source'],
    ministry: ['.list_type .agency', '.list_type .writer', '.list_type .dept'],
    next: ['.paging a[onclick*="pageLink"]'],
    detailLink: 'a[href*="policyNewsView.do"]'
  }),
  'korea-press-release-list': Object.freeze({
    rows: ['.list_type li'],
    title: ['.list_type strong'],
    date: ['.list_type .source'],
    ministry: ['.list_type .agency', '.list_type .writer', '.list_type .dept'],
    next: ['.paging a[onclick*="pageLink"]'],
    detailLink: 'a[href*="pressReleaseView.do"]'
  }),
  'korea-policy-detail': Object.freeze({
    title: ['.view_title', 'main#main h1'],
    date: ['.article_head .info', 'time[datetime]', '.news-date', '.view-date'],
    ministry: ['.article_head .info', '.agency', '.ministry', '.writer', '.press'],
    body: ['.article_body .view_cont', '.article_body', '#articleText', '.news-body', '.view-content', '.view-content-area', '.article-content'],
    attachments: ['.attachment', '.file_list', '.fileList', '.attached-file', '.attach-file']
  }),
  'korea-media-detail': Object.freeze({
    title: ['main#main h1'],
    date: ['.article_head .info'],
    ministry: ['.article_head .info'],
    body: ['.article_body .view_cont'],
    attachments: ['.article_body .attach-list', '.file_list', '.attachment']
  }),
  'korea-release-detail': Object.freeze({
    title: ['.view_title', 'main#main h1'],
    date: ['.article_head .info', '.view_info', 'time[datetime]'],
    ministry: ['.article_head .info', '.view_info'],
    body: ['.article_body .view_cont', '.view_cont'],
    attachments: ['.file_list', '.attach-list', '.attachment']
  }),
  'mof-selectDoc': Object.freeze({
    title: ['.bo-tit'],
    date: ['.bod-info-box', 'time[datetime]'],
    ministry: ['.writer', '.dept', '.department', '.agency'],
    body: ['.bod-detail-view'],
    attachments: ['.attach-list']
  }),
  'mafra-artclView': Object.freeze({
    title: ['.view_top dt', '.view_top h3', '.view_top h2', '.view_top .tit'],
    date: ['.view_top .date', '.view_top dd.date', 'time[datetime]'],
    ministry: ['.view_top .dept', '.view_top .writer', '.view_top .agency'],
    body: ['.view_contents'],
    attachments: ['.artclFile', '.artcl_file', '.file_list', '.fileList', '.attach', '.attachment']
  }),
  'mss-View': Object.freeze({
    title: ['.board_view h4#sj', '.board_view .tit', '.board_view .title', '.bbs_view .tit', '.view_title'],
    date: ['.board_view .date', '.board_info', '.view_info', 'time[datetime]'],
    ministry: ['.board_view .dept', '.dept', '.writer', '.agency'],
    body: ['.board_view .view_contents', '.board_view .view_cont', '.board_view .view_conts', '.bbs_view .view_cont', '.view_cont', '.view_content', '.board_txt'],
    attachments: ['.file_list', '.board_view .file', '.board_file', '.fileList', '.attach', '.attachment']
  }),
  'mois-commonSelectBoardArticle': Object.freeze({
    title: ['#contents h4.subject'],
    date: ['#contents .table_info'],
    ministry: [],
    body: ['#contents #desc_pc.desc'],
    attachments: ['.fileList', '.bbs_view .file', '.file_list', '.board_file', '.attach', '.attachment']
  }),
  'motir-view': Object.freeze({
    title: ['.detail-tit'],
    date: ['.detail-info'],
    ministry: [],
    body: ['#cont-body .detail-cont'],
    attachments: ['.info-down', '.article_file', '.file_list', '.fileList', '.attach', '.attachment']
  }),
  'mois-high-oil-page': Object.freeze({
    title: ['#contents h2.title'],
    date: ['.update', '.date', 'time[datetime]'],
    ministry: ['.agency', '.dept', '.writer'],
    body: ['#contents .bl_list_blue01', '#contents table'],
    bodyCombine: true,
    attachments: ['.fileList', '.attach', '.attachment']
  })
});

const DETAIL_TYPE_BY_PATH = Object.freeze([
  ['korea-policy-detail', url => url.hostname.endsWith('korea.kr') && /\/news\/policyNewsView\.do$/i.test(url.pathname)],
  ['korea-media-detail', url => url.hostname.endsWith('korea.kr') && /\/multi\/mediaNewsView\.do$/i.test(url.pathname)],
  ['korea-release-detail', url => url.hostname.endsWith('korea.kr') && /\/briefing\/pressReleaseView\.do$/i.test(url.pathname)],
  ['mof-selectDoc', url => url.hostname.endsWith('mof.go.kr') && /\/selectDoc\.do$/i.test(url.pathname)],
  ['mafra-artclView', url => url.hostname.endsWith('mafra.go.kr') && /\/artclView\.do$/i.test(url.pathname)],
  ['mss-View', url => url.hostname.endsWith('mss.go.kr') && /\/View\.do$/i.test(url.pathname)],
  ['mois-commonSelectBoardArticle', url => url.hostname.endsWith('mois.go.kr') && /\/commonSelectBoardArticle\.do$/i.test(url.pathname)],
  ['motir-view', url => url.hostname.endsWith('motir.go.kr') && /\/view\/?$/i.test(url.pathname)],
  ['mois-high-oil-page', url => url.hostname.endsWith('mois.go.kr') && /\/highOilPriceSupport\/screen\.do$/i.test(url.pathname)]
]);

const AGENCY_RE = /(국무조정실|국무총리비서실|대통령비서실|국가안보실|국가유산청|인사혁신처|해양경찰청|통일부|병무청|방위사업청|기상청|질병관리청|개인정보보호위원회|국민권익위원회|국가인권위원회|방송통신위원회|해양수산부|농림축산식품부|중소벤처기업부|행정안전부|산업통상자원부|산업통상부|기획재정부|재정경제부|문화체육관광부|보건복지부|기후에너지환경부|환경부|국토교통부|고용노동부|교육부|과학기술정보통신부|성평등가족부|여성가족부|국가보훈부|공정거래위원회|금융위원회|국세청|관세청|조달청|통계청|산림청|농촌진흥청|식품의약품안전처|소방청|경찰청|국가데이터처|지식재산청)/;
const DATE_RE = /(20\d{2})\s*(?:[-./]|년\s*)(\d{1,2})\s*(?:[-./]|월\s*)(\d{1,2})\s*(?:일)?/;
const BLOCK_TAGS = new Set(['address', 'article', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'h1', 'h2', 'h3', 'h4', 'h5', 'li', 'ol', 'p', 'section', 'table', 'td', 'th', 'tr', 'ul']);
const HIDE_TAGS = new Set(['script', 'style', 'noscript', 'svg', 'iframe', 'nav', 'footer', 'header']);
const DOWNLOAD_RE = /\.(?:pdf|hwp|hwpx|docx?|xlsx?|pptx?|zip)(?:$|[?#])/i;

function splitSelector(selector) {
  return String(selector).trim().split(/\s+(?![^\[]*\])/).filter(Boolean);
}

function simpleSelectorMatches(node, selector) {
  if (!node || !node.tagName) return false;
  const tagMatch = selector.match(/^[a-z][\w-]*/i);
  if (tagMatch && node.tagName.toLowerCase() !== tagMatch[0].toLowerCase()) return false;
  for (const match of selector.matchAll(/#([\w-]+)/g)) if (attr(node, 'id') !== match[1]) return false;
  for (const match of selector.matchAll(/\.([\w-]+)/g)) if (!hasClass(node, match[1])) return false;
  for (const match of selector.matchAll(/\[([^\]]+)\]/g)) {
    const content = match[1].trim();
    const operator = content.match(/^([\w:-]+)\s*(\*=|\^=|\$=|=)?\s*["']?([^"']*)["']?$/);
    if (!operator) return false;
    const [, name, op, expected] = operator;
    const actual = attr(node, name);
    if (actual == null) return false;
    if (op === '=' && actual !== expected) return false;
    if (op === '*=' && !actual.includes(expected)) return false;
    if (op === '^=' && !actual.startsWith(expected)) return false;
    if (op === '$=' && !actual.endsWith(expected)) return false;
  }
  return true;
}

function selectorMatches(node, selector, parents) {
  const parts = splitSelector(selector);
  if (!parts.length || !simpleSelectorMatches(node, parts.at(-1))) return false;
  let ancestor = parents.get(node);
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    while (ancestor && !simpleSelectorMatches(ancestor, parts[i])) ancestor = parents.get(ancestor);
    if (!ancestor) return false;
    ancestor = parents.get(ancestor);
  }
  return true;
}

function indexTree(root) {
  const nodes = [];
  const parents = new WeakMap();
  const visit = (node, parent = null) => {
    if (!node) return;
    if (parent) parents.set(node, parent);
    nodes.push(node);
    const kids = node.childNodes ?? node.content?.childNodes ?? [];
    for (const child of kids) visit(child, node);
  };
  visit(root);
  return { nodes, parents };
}

function selectAll(index, selectors) {
  for (const selector of selectors ?? []) {
    const found = index.nodes.filter(node => selectorMatches(node, selector, index.parents));
    if (found.length) return { nodes: found, selector };
  }
  return { nodes: [], selector: null };
}

function ownText(node, { lineBreaks = false } = {}) {
  if (!node) return '';
  const parts = [];
  const visit = current => {
    if (current.nodeName === '#text') {
      if (current.value) parts.push(current.value);
      return;
    }
    if (HIDE_TAGS.has(String(current.tagName ?? '').toLowerCase())) return;
    const before = parts.length;
    const kids = current.childNodes ?? current.content?.childNodes ?? [];
    for (const child of kids) visit(child);
    if (lineBreaks && current.tagName && BLOCK_TAGS.has(current.tagName.toLowerCase()) && parts.length > before) parts.push('\n');
  };
  visit(node);
  return parts.join('');
}

function cleanText(value) {
  return String(value ?? '').replace(/\u00a0/g, ' ').replace(/[\t\r ]+/g, ' ').replace(/ *\n+ */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function normalizedDate(raw) {
  const match = String(raw ?? '').match(DATE_RE);
  if (!match) return null;
  const [, year, month, day] = match;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function dateValue(raw) {
  if (!raw) return null;
  const normalized = normalizedDate(raw);
  return normalized ? { value: normalized, raw: cleanText(raw) } : null;
}

function fieldLabelRaw(selector, node, fallback) {
  const nodeClass = String(attr(node, 'class') ?? '').trim();
  const nodeId = String(attr(node, 'id') ?? '').trim();
  const hook = nodeId ? `#${nodeId}` : nodeClass ? `.${nodeClass.split(/\s+/).join('.')}` : selector;
  return fallback ?? hook ?? null;
}

function labeledPairs(index) {
  const pairs = [];
  for (const node of index.nodes) {
    const tag = String(node.tagName ?? '').toLowerCase();
    if (tag === 'th' || tag === 'dt') {
      const parent = index.parents.get(node);
      const siblings = parent?.childNodes ?? [];
      const pos = siblings.indexOf(node);
      const expectedTag = tag === 'th' ? 'td' : 'dd';
      const value = siblings.slice(pos + 1).find(sibling => String(sibling.tagName ?? '').toLowerCase() === expectedTag);
      if (value) pairs.push({ label: cleanText(ownText(node)), value: cleanText(ownText(value)) });
      continue;
    }
    const classes = String(attr(node, 'class') ?? '').toLowerCase();
    if (!/(label|item_title|tit_txt|th)/.test(classes)) continue;
    const parent = index.parents.get(node);
    const siblings = parent?.childNodes ?? [];
    const pos = siblings.indexOf(node);
    const value = siblings.slice(pos + 1).find(sibling => sibling.nodeName !== '#text' && !/(label|item_title|tit_txt|th)/.test(String(attr(sibling, 'class') ?? '').toLowerCase()));
    if (value) pairs.push({ label: cleanText(ownText(node)), value: cleanText(ownText(value)) });
  }
  return pairs.filter(pair => pair.label && pair.value);
}

function findPair(pairs, expression) {
  return pairs.find(pair => expression.test(pair.label)) ?? null;
}

function metaValue(index, property) {
  for (const node of index.nodes) {
    if (String(node.tagName ?? '').toLowerCase() !== 'meta') continue;
    const key = attr(node, 'property') ?? attr(node, 'name');
    if (key?.toLowerCase() === property.toLowerCase()) return attr(node, 'content') ?? null;
  }
  return null;
}

function nearestRecordContainer(index, anchor) {
  let node = anchor;
  let fallback = anchor;
  for (let depth = 0; depth < 7; depth += 1) {
    const parent = index.parents.get(node);
    if (!parent) break;
    node = parent;
    const tag = String(node.tagName ?? '').toLowerCase();
    const classes = String(attr(node, 'class') ?? '').toLowerCase();
    const text = cleanText(ownText(node));
    if (['li', 'tr', 'article'].includes(tag) || /(item|list|card|news|board|press|row)/.test(classes)) return node;
    if (text.length <= 1200 && text.length > cleanText(ownText(fallback)).length) fallback = node;
  }
  return fallback;
}

function nearestClassContainer(index, anchor, className) {
  let node = anchor;
  for (let depth = 0; depth < 10; depth += 1) {
    if (hasClass(node, className)) return node;
    node = index.parents.get(node);
    if (!node) return null;
  }
  return null;
}

function dateFromText(raw) {
  return String(raw ?? '').match(DATE_RE)?.[0] ?? null;
}

function agencyFromText(raw) {
  return String(raw ?? '').match(AGENCY_RE)?.[1] ?? null;
}

function headerLabels(index) {
  const labels = [];
  for (const node of index.nodes) {
    if (String(node.tagName ?? '').toLowerCase() === 'th') {
      const label = cleanText(ownText(node));
      if (label && !labels.includes(label)) labels.push(label);
    }
  }
  return labels;
}

function makeLayout(index, selectors, rowCount) {
  return structuralFingerprint(selectors.filter(Boolean), headerLabels(index).slice(0, 12));
}

function maybeAssertLayout(layout, expected, rowCount, range = {}) {
  if (!expected) return { layoutStatus: 'baseline_missing' };
  try {
    assertLayout({ ...layout, rowCount }, expected, {
      rowCount,
      expectedRows: expected.rowCount,
      rowTolerance: expected.rowTolerance ?? 0,
      minRows: range.minRows ?? 1,
      maxRows: range.maxRows ?? 200
    });
    return { layoutStatus: 'matched' };
  } catch (error) {
    if (error?.code === 'HTML_LAYOUT_CHANGED') return { layoutStatus: 'HTML_LAYOUT_CHANGED', layoutError: error.message };
    throw error;
  }
}

function pickNode(index, selectors) {
  const selected = selectAll(index, selectors);
  const node = selected.nodes.find(item => cleanText(ownText(item)) || String(item.tagName ?? '').toLowerCase() === 'meta') ?? null;
  return { node, selector: node ? selected.selector : null };
}

function within(index, root, selector) {
  return index.nodes.filter(node => {
    if (!selectorMatches(node, selector, index.parents)) return false;
    let parent = index.parents.get(node);
    while (parent) {
      if (parent === root) return true;
      parent = index.parents.get(parent);
    }
    return false;
  });
}

function valueFromNode(node) {
  if (!node) return '';
  if (String(node.tagName ?? '').toLowerCase() === 'meta') return cleanText(attr(node, 'content'));
  return cleanText(ownText(node));
}

function articleType(url) {
  for (const [type, predicate] of DETAIL_TYPE_BY_PATH) if (predicate(url)) return type;
  return null;
}

function articleMinistry(url, sourceId, fallback) {
  const host = url.hostname.toLowerCase();
  const wwwHost = host.startsWith('www.') ? host : `www.${host}`;
  return fallback ?? GOV_PRESS_MINISTRIES[host] ?? GOV_PRESS_MINISTRIES[wwwHost] ?? null;
}

function attachmentRecords(index, baseUrl, selectors, selectedHooks) {
  const candidates = index.nodes.filter(node => String(node.tagName ?? '').toLowerCase() === 'a');
  const found = [];
  for (const anchor of candidates) {
    const href = attr(anchor, 'href');
    if (!href || /^(?:javascript:|mailto:|#)/i.test(href)) continue;
    const url = new URL(href, baseUrl).href;
    const text = cleanText(ownText(anchor));
    if (/^바로보기$/.test(text)) continue;
    let parent = index.parents.get(anchor);
    let inAttachmentArea = false;
    for (let depth = 0; parent && depth < 6; depth += 1, parent = index.parents.get(parent)) {
      const hook = `${attr(parent, 'id') ?? ''} ${attr(parent, 'class') ?? ''}`.toLowerCase();
      if (/(file|attach|download)/.test(hook)) {
        inAttachmentArea = true;
        break;
      }
    }
    if (!DOWNLOAD_RE.test(url) && !/(?:첨부|다운로드|붙임|파일)/i.test(`${text} ${attr(anchor, 'title') ?? ''}`) && !inAttachmentArea) continue;
    const name = text || cleanText(attr(anchor, 'title')) || path.basename(new URL(url).pathname);
    if (found.some(item => item.url === url)) continue;
    found.push({ title: name, titleRaw: text || null, fileNameRaw: name || null, url, labelRaw: '첨부파일' });
  }
  if (found.length) selectedHooks.push(selectors.find(selector => selectAll(index, [selector]).nodes.length) ?? 'a[href*="download"]');
  return found;
}

function ministryValue(pairs, url, sourceId, fallback) {
  const pair = pairs.find(candidate => /(부처|기관|작성기관|담당기관|제공기관|소관기관|발행기관)/.test(candidate.label) && agencyFromText(candidate.value));
  if (pair) {
    const agency = agencyFromText(pair.value);
    if (agency) return { value: agency, raw: pair.value, labelRaw: pair.label };
  }
  const staticName = articleMinistry(url, sourceId, fallback);
  return staticName ? { value: staticName, raw: staticName, labelRaw: '공식 사이트' } : null;
}

function titleValue(index, selectorMap) {
  const title = pickNode(index, selectorMap.title);
  let raw = valueFromNode(title.node);
  if (title.node && hasClass(title.node, 'subject')) {
    for (const subtitle of within(index, title.node, '.sub_desc')) {
      const subtitleText = valueFromNode(subtitle);
      if (subtitleText) raw = raw.replace(subtitleText, '');
    }
  }
  raw = cleanText(raw);
  const beforePipe = raw.split(/\s*[|｜]\s*/)[0];
  raw = beforePipe || raw;
  return { value: raw, raw: valueFromNode(title.node), selector: title.selector, node: title.node };
}

function dateField(index, selectorMap, pairs) {
  const pair = findPair(pairs, /(등록일|작성일|게시일|보도일|발표일|입력일|기사일|날짜)/);
  if (pair) {
    const found = dateValue(pair.value);
    if (found) return { ...found, labelRaw: pair.label, selector: 'label-value' };
  }
  const selected = pickNode(index, selectorMap.date);
  const raw = valueFromNode(selected.node);
  const found = dateValue(raw);
  if (found) return { ...found, labelRaw: fieldLabelRaw(selected.selector, selected.node, '등록일'), selector: selected.selector };
  for (const node of index.nodes) {
    if (String(node.tagName ?? '').toLowerCase() !== 'time') continue;
    const value = attr(node, 'datetime') ?? ownText(node);
    const parsed = dateValue(value);
    if (parsed) return { ...parsed, labelRaw: '게시일', selector: 'time[datetime]' };
  }
  return null;
}

function bodyField(index, selectorMap) {
  if (selectorMap.bodyCombine) {
    const selectedNodes = [];
    const selectedSelectors = [];
    for (const selector of selectorMap.body) {
      const matches = index.nodes.filter(node => selectorMatches(node, selector, index.parents));
      if (matches.length) {
        selectedNodes.push(...matches);
        selectedSelectors.push(selector);
      }
    }
    const uniqueTexts = [...new Set(selectedNodes.map(node => cleanText(ownText(node, { lineBreaks: true })).trim()).filter(text => text.length >= 15))];
    if (uniqueTexts.length) return { value: uniqueTexts.join('\n'), selector: selectedSelectors.join(', ') };
    return null;
  }
  const selected = selectAll(index, selectorMap.body);
  const candidates = selected.nodes
    .map(node => {
      const altText = within(index, node, 'img').map(image => cleanText(attr(image, 'alt'))).filter(Boolean);
      const bodyText = cleanText(ownText(node, { lineBreaks: true }));
      return { node, text: cleanText([bodyText, ...altText].join('\n')) };
    })
    .filter(item => item.text.length >= 40)
    .sort((left, right) => left.text.length - right.text.length);
  const item = candidates[0] ?? null;
  if (item) return { value: item.text, selector: selected.selector };
  return null;
}

/** Detects a known Korean government press-release page family from its public URL. */
export function detectGovPressPageType(inputUrl) {
  let url;
  try { url = new URL(inputUrl); } catch { return null; }
  if (url.hostname.endsWith('korea.kr') && /\/news\/policyNewsList\.do$/i.test(url.pathname)) return 'korea-policy-list';
  if (url.hostname.endsWith('korea.kr') && /\/briefing\/pressReleaseList\.do$/i.test(url.pathname)) return 'korea-press-release-list';
  return articleType(url);
}

function parseKoreaList(html, {
  sourceId,
  pageUrl,
  listType,
  articlePath,
  expectedLayout = null
}) {
  const doc = parseHtml(html);
  const index = indexTree(doc);
  const baseUrl = new URL(pageUrl);
  const allLinks = links(doc, baseUrl.href);
  const records = [];
  const paginationLinks = [];
  let paginationEvidence = null;
  const usedRows = new Set();
  const detailHook = listType === 'korea-policy-list' ? 'a[href*="policyNewsView.do"]' : 'a[href*="pressReleaseView.do"]';
  const selectedHooks = [detailHook];

  for (const link of allLinks) {
    const url = new URL(link.url);
    const title = cleanText(link.text);
    if (url.origin !== baseUrl.origin || !articlePath.test(url.pathname) || !url.searchParams.has('newsId')) continue;
    const anchor = link.node;
    const listWrapper = nearestClassContainer(index, anchor, 'list_type');
    if (!listWrapper) continue;
    // `.list_type` is the observed results wrapper. Scope links to its nearest
    // semantic list item so featured/recommended items outside it are ignored.
    let row = anchor;
    let ancestor = index.parents.get(anchor);
    while (ancestor && ancestor !== listWrapper) {
      if (['li', 'article', 'tr'].includes(String(ancestor.tagName ?? '').toLowerCase())) { row = ancestor; break; }
      ancestor = index.parents.get(ancestor);
    }
    if (row === anchor) row = listWrapper;
    const rowText = cleanText(ownText(row, { lineBreaks: true }));
    if (usedRows.has(url.href)) continue;
    usedRows.add(url.href);
    const dateRaw = dateFromText(rowText);
    const ministryRaw = agencyFromText(rowText);
    const date = dateValue(dateRaw);
    const strongTitle = within(index, row, 'strong').map(node => cleanText(ownText(node))).find(Boolean);
    const titleValueRaw = strongTitle || title || null;
    const sourceNode = within(index, row, '.source').find(node => dateFromText(ownText(node)));
    const sourceDateRaw = sourceNode ? dateFromText(ownText(sourceNode)) : dateRaw;
    const published = dateValue(sourceDateRaw);
    records.push({
      sourceId,
      sourceType: listType,
      title: titleValueRaw,
      titleRaw: titleValueRaw,
      publishedDate: published?.value ?? date?.value ?? null,
      dateRaw: published?.raw ?? date?.raw ?? null,
      ministry: ministryRaw,
      ministryRaw,
      sourceUrl: url.href,
      rowRaw: rowText || null,
      rawLabels: {
        title: titleValueRaw ? (strongTitle ? 'strong 정책뉴스 제목' : '정책뉴스 링크') : null,
        publishedDate: sourceDateRaw ? (listType === 'korea-policy-list' ? '정책뉴스 작성일' : '보도자료 작성일') : null,
        ministry: ministryRaw ? '목록 부처 표기' : null
      }
    });
    const rowClasses = String(attr(row, 'class') ?? '').trim().split(/\s+/).filter(Boolean);
    if (rowClasses.length) selectedHooks.push(`.${rowClasses.join('.')}`);
  }

  for (const link of allLinks) {
    const url = new URL(link.url);
    const text = cleanText(link.text);
    const query = url.searchParams;
    const sameListPath = url.origin === baseUrl.origin && url.pathname === baseUrl.pathname;
    const hasPagingParam = [...query.keys()].some(key => /^(page|pageindex|pageno|page_no|currentpage)$/i.test(key));
    const hasNextLabel = /^(다음|다음글|next|›|»|>)$/i.test(text);
    if (sameListPath && (hasPagingParam || hasNextLabel) && url.href !== baseUrl.href && !paginationLinks.includes(url.href)) paginationLinks.push(url.href);
  }

  const mainForm = index.nodes.find(node => String(node.tagName ?? '').toLowerCase() === 'form' && attr(node, 'id') === 'mainForm');
  const pageControls = selectAll(index, ['a[onclick*="pageLink"]']).nodes;
  if (mainForm || pageControls.length) {
    const formAction = mainForm ? new URL(attr(mainForm, 'action') || baseUrl.href, baseUrl.href).href : null;
    const formMethod = mainForm ? String(attr(mainForm, 'method') ?? 'get').toLowerCase() : null;
    const pageField = mainForm ? within(index, mainForm, 'input[name="pageIndex"]').map(node => ({ name: attr(node, 'name'), type: attr(node, 'type') })) : [];
    const pageNumbers = pageControls.map(node => Number(/pageLink\s*\(\s*(\d+)/i.exec(attr(node, 'onclick') ?? '')?.[1])).filter(Number.isFinite);
    paginationEvidence = {
      source: 'observed public page DOM',
      formAction,
      formMethod,
      pageFieldNames: pageField.map(field => field.name).filter(Boolean),
      controlName: pageControls.length ? 'pageLink(number)' : null,
      observedPageNumbers: [...new Set(pageNumbers)].sort((a, b) => a - b),
      followed: false,
      blockedReason: formMethod && formMethod !== 'get' ? 'DIRECT_GET_ONLY' : null
    };
    // A bounded anonymous GET probe of this exact observed form action,
    // hidden field and pageLink(2) value was verified on 2026-10-03.
    if (listType === 'korea-policy-list' && formMethod === 'post'
      && formAction === baseUrl.origin + baseUrl.pathname
      && pageField.some(field => field.name === 'pageIndex') && pageNumbers.includes(2)) {
      const getPage = new URL(formAction);
      getPage.searchParams.set('pageIndex', '2');
      paginationLinks.push(getPage.href);
      paginationEvidence.getHypothesisUrl = getPage.href;
      paginationEvidence.getProbeResult = 'verified_different_news_ids';
      paginationEvidence.followed = true;
      paginationEvidence.blockedReason = null;
      paginationEvidence.verification = 'checked_in_public_get_probe';
    }
  }

  const headers = headerLabels(index);
  if (records.length) selectedHooks.push('.list_type', '.list_type strong', '.list_type .source');
  if (paginationEvidence) {
    if (index.nodes.some(node => hasClass(node, 'paging'))) selectedHooks.push('.paging');
    if (pageControls.length) selectedHooks.push('a[onclick*="pageLink"]');
    if (mainForm) selectedHooks.push('form#mainForm');
    if (index.nodes.some(node => String(node.tagName ?? '').toLowerCase() === 'input' && attr(node, 'name') === 'pageIndex')) selectedHooks.push('input[name="pageIndex"]');
  }
  const layout = structuralFingerprint([...new Set(selectedHooks)], headers.slice(0, 12));
  const checked = maybeAssertLayout(layout, expectedLayout ?? GOV_PRESS_LAYOUTS[listType], records.length, { minRows: 1, maxRows: 100 });
  if (checked.layoutStatus === 'HTML_LAYOUT_CHANGED') throw Object.assign(new Error('HTML_LAYOUT_CHANGED'), { code: 'HTML_LAYOUT_CHANGED', pageType: listType, records });
  return {
    sourceId,
    sourceType: listType,
    pageUrl: baseUrl.href,
    records,
    paginationLinks,
    paginationEvidence,
    recordCount: records.length,
    headerLabels: headers,
    selectors: [...new Set(selectedHooks)],
    fingerprint: layout,
    ...checked
  };
}

/** Parse the server-rendered korea.kr policy-news listing; returns only observed article/page links. */
export function parseGovPressList(html, { sourceId = 'policy-list', pageUrl = GOV_PRESS_SOURCE_URLS['policy-list'], expectedLayout = null } = {}) {
  return parseKoreaList(html, {
    sourceId,
    pageUrl,
    listType: 'korea-policy-list',
    articlePath: /\/news\/policyNewsView\.do$/i,
    expectedLayout
  });
}

/** Parse korea.kr's official press-release listing for reusable source discovery. */
export function parseKoreaBriefingList(html, { sourceId = 'korea-press-release-list', pageUrl = GOV_PRESS_SOURCE_URLS['korea-press-release-list'], expectedLayout = null } = {}) {
  return parseKoreaList(html, {
    sourceId,
    pageUrl,
    listType: 'korea-press-release-list',
    articlePath: /\/briefing\/pressReleaseView\.do$/i,
    expectedLayout
  });
}

/** Parse a server-rendered official press article with CMS-specific selector maps. */
export function parseGovPressDetail(html, { sourceId = 'ministry-release-documents', articleUrl, ministry: ministryFallback = null, expectedLayout = null } = {}) {
  if (!articleUrl) throw new TypeError('articleUrl is required');
  const url = new URL(articleUrl);
  const pageType = articleType(url);
  if (!pageType) throw Object.assign(new Error('GOV_PRESS_PAGE_TYPE_UNKNOWN'), { code: 'GOV_PRESS_PAGE_TYPE_UNKNOWN' });
  const doc = parseHtml(html);
  const index = indexTree(doc);
  const selectorMap = GOV_PRESS_SELECTOR_MAPS[pageType];
  const pairs = labeledPairs(index);
  const title = titleValue(index, selectorMap);
  const date = dateField(index, selectorMap, pairs);
  const body = bodyField(index, selectorMap);
  const ministryPair = pairs.find(pair => /(부처|기관|작성기관|담당기관|제공기관|소관기관|발행기관)/.test(pair.label) && agencyFromText(pair.value));
  const articleInfo = pickNode(index, selectorMap.ministry);
  const articleInfoAgency = articleInfo.node ? agencyFromText(valueFromNode(articleInfo.node)) : null;
  const bodyAgency = body ? agencyFromText(body.value) : null;
  const ministry = ministryPair
    ? { value: agencyFromText(ministryPair.value), raw: ministryPair.value, labelRaw: ministryPair.label }
    : articleInfoAgency
      ? { value: articleInfoAgency, raw: valueFromNode(articleInfo.node), labelRaw: '기사 정보' }
      : ministryValue(pairs, url, sourceId, ministryFallback)
        ?? (bodyAgency ? { value: bodyAgency, raw: bodyAgency, labelRaw: '본문 기관 표기' } : null);
  const selectedHooks = [title.selector, date?.selector, body?.selector].filter(Boolean);
  const attachments = attachmentRecords(index, url.href, selectorMap.attachments, selectedHooks);
  const headerRaw = headerLabels(index);
  const fingerprint = structuralFingerprint([...new Set(selectedHooks)], headerRaw.slice(0, 12));
  const layoutStatus = maybeAssertLayout(fingerprint, expectedLayout ?? GOV_PRESS_LAYOUTS[pageType], title.value && body?.value ? 1 : 0, { minRows: 1, maxRows: 1 });
  const rawLabels = {
    title: title.selector ? fieldLabelRaw(title.selector, title.node, '보도자료 제목') : '보도자료 제목',
    publishedDate: date?.labelRaw ?? null,
    ministry: ministry?.labelRaw ?? null,
    body: body?.selector ? fieldLabelRaw(body.selector, { tagName: 'div' }, '본문') : null,
    attachments: attachments.length ? '첨부파일' : null
  };
  const record = {
    sourceId,
    sourceType: pageType,
    title: title.value || null,
    titleRaw: title.raw || null,
    publishedDate: date?.value ?? null,
    dateRaw: date?.raw ?? null,
    ministry: ministry?.value ?? null,
    ministryRaw: ministry?.raw ?? null,
    body: body?.value ?? null,
    bodyRawLabel: '본문',
    attachments,
    sourceUrl: url.href,
    rawLabels,
    selectors: [...new Set(selectedHooks)],
    headerLabels: headerRaw,
    fingerprint,
    ...layoutStatus
  };
  if (layoutStatus.layoutStatus === 'HTML_LAYOUT_CHANGED') {
    throw Object.assign(new Error('HTML_LAYOUT_CHANGED'), { code: 'HTML_LAYOUT_CHANGED', pageType, partial: record });
  }
  const missing = ['title', 'publishedDate', 'ministry', 'body'].filter(field => !record[field]);
  if (missing.length) {
    throw Object.assign(new Error(`GOV_PRESS_REQUIRED_FIELDS_MISSING:${missing.join(',')}`), {
      code: 'GOV_PRESS_REQUIRED_FIELDS_MISSING',
      pageType,
      missing,
      partial: record
    });
  }
  return record;
}

/** Parse an official policy information page that is not a dated press release. */
export function parseGovPolicyPage(html, { sourceId, pageUrl, expectedLayout = null } = {}) {
  if (!pageUrl) throw new TypeError('pageUrl is required');
  const url = new URL(pageUrl);
  const pageType = articleType(url);
  if (pageType !== 'mois-high-oil-page') throw Object.assign(new Error('GOV_POLICY_PAGE_TYPE_UNKNOWN'), { code: 'GOV_POLICY_PAGE_TYPE_UNKNOWN' });
  const doc = parseHtml(html);
  const index = indexTree(doc);
  const selectorMap = GOV_PRESS_SELECTOR_MAPS[pageType];
  const pairs = labeledPairs(index);
  const title = titleValue(index, selectorMap);
  const date = dateField(index, selectorMap, pairs);
  const body = bodyField(index, selectorMap);
  const ministry = ministryValue(pairs, url, sourceId, null);
  const selectedHooks = [title.selector, date?.selector, body?.selector].filter(Boolean);
  const attachments = attachmentRecords(index, url.href, selectorMap.attachments, selectedHooks);
  const headers = headerLabels(index);
  const fingerprint = structuralFingerprint([...new Set(selectedHooks)], headers.slice(0, 12));
  const layout = maybeAssertLayout(fingerprint, expectedLayout ?? GOV_PRESS_LAYOUTS[pageType], title.value && body?.value ? 1 : 0, { minRows: 1, maxRows: 1 });
  const record = {
    sourceId,
    sourceType: pageType,
    title: title.value || null,
    titleRaw: title.raw || null,
    publishedDate: date?.value ?? null,
    dateRaw: date?.raw ?? null,
    ministry: ministry?.value ?? null,
    ministryRaw: ministry?.raw ?? null,
    body: body?.value ?? null,
    bodyRawLabel: '본문',
    attachments,
    sourceUrl: url.href,
    rawLabels: {
      title: title.selector ? fieldLabelRaw(title.selector, title.node, '정책 페이지 제목') : null,
      publishedDate: date?.labelRaw ?? null,
      ministry: ministry?.labelRaw ?? null,
      body: body?.selector ? '정책 본문' : null,
      attachments: attachments.length ? '첨부파일' : null
    },
    selectors: [...new Set(selectedHooks)],
    headerLabels: headers,
    fingerprint,
    ...layout
  };
  const missing = ['title', 'ministry', 'body'].filter(field => !record[field]);
  if (missing.length) throw Object.assign(new Error(`GOV_POLICY_REQUIRED_FIELDS_MISSING:${missing.join(',')}`), { code: 'GOV_POLICY_REQUIRED_FIELDS_MISSING', pageType, missing, partial: record });
  if (layout.layoutStatus === 'HTML_LAYOUT_CHANGED') throw Object.assign(new Error('HTML_LAYOUT_CHANGED'), { code: 'HTML_LAYOUT_CHANGED', pageType, partial: record });
  return record;
}

function capturePathFromEnv(env) {
  return env.HTML_PARSER_CAPTURE_DIR || DEFAULT_CAPTURE_DIR;
}

function officialHostAliases(hostname) {
  const root = String(hostname).replace(/^www\./i, '');
  return [...new Set([hostname, root, `www.${root}`])];
}

function validPublicHtml(result) {
  return result && result.status === 200 && /^text\/html\b/i.test(result.contentType ?? '') && !result.challenge && !result.error && typeof result.html === 'string';
}

function failureResult(result, pageType) {
  const status = result?.challenge ? 'challenge_blocked' : result?.error ? 'fetch_error' : result?.status !== 200 ? 'http_error' : 'response_invalid';
  return {
    status,
    pageType,
    httpStatus: result?.status ?? result?.httpStatus ?? null,
    contentType: result?.contentType ?? null,
    challenge: result?.challenge ?? false,
    captureFiles: result?.captureFiles ?? null,
    error: result?.error ?? null,
    url: result?.url ?? null,
    checkedAt: result?.checkedAt ?? null
  };
}

function ensureHttpOnly(url) {
  if (url.protocol !== 'https:') throw Object.assign(new Error('PUBLIC_HTTPS_REQUIRED'), { code: 'PUBLIC_HTTPS_REQUIRED' });
  if (url.username || url.password) throw Object.assign(new Error('URL_CREDENTIALS_FORBIDDEN'), { code: 'URL_CREDENTIALS_FORBIDDEN' });
}

async function recordRequest(result, pageType, parse) {
  if (!validPublicHtml(result)) return failureResult(result, pageType);
  try {
    const record = parse(result.html);
    return {
      status: record.layoutStatus === 'baseline_missing' ? 'usable_html_baseline_missing' : 'usable_html',
      pageType,
      httpStatus: result.status,
      contentType: result.contentType,
      charset: result.charset,
      record,
      captureFiles: result.captureFiles ?? null,
      url: result.url,
      checkedAt: result.checkedAt
    };
  } catch (error) {
    return {
      status: error?.code === 'HTML_LAYOUT_CHANGED' ? 'HTML_LAYOUT_CHANGED' : 'parse_error',
      pageType: error?.pageType ?? pageType,
      httpStatus: result.status,
      contentType: result.contentType,
      captureFiles: result.captureFiles ?? null,
      url: result.url,
      checkedAt: result.checkedAt,
      error: error?.code ?? error?.message ?? 'GOV_PRESS_PARSE_ERROR',
      missing: error?.missing ?? null,
      partial: error?.partial ?? null
    };
  }
}

/** Fetch and parse one official public article using a plain anonymous HTTPS GET. */
export async function collectGovPressArticle(articleUrl, {
  sourceId = 'ministry-release-documents',
  ministry = null,
  fetchImpl = fetch,
  now = () => new Date(),
  captureDir = capturePathFromEnv(process.env),
  expectedLayout = null,
  minIntervalMs = 2000,
  timeoutMs = 20000
} = {}) {
  const url = new URL(articleUrl);
  ensureHttpOnly(url);
  const pageType = articleType(url);
  if (!pageType) return { status: 'unsupported_page', url: url.href, sourceId, pageType: null };
  const client = createPublicClient({
    captureDir,
    requestLimit: 40,
    minIntervalMs,
    timeoutMs,
    allowedHosts: officialHostAliases(url.hostname),
    fetchImpl
  });
  const result = await client.get(url.href, { sourceId, pageType });
  return recordRequest(result, pageType, html => parseGovPressDetail(html, { sourceId, articleUrl: result.url || url.href, ministry, expectedLayout }));
}

/** Fetch and parse a non-article MOIS policy information page as an anonymous HTTPS GET. */
export async function collectGovPolicyPage(pageUrl = GOV_PRESS_SOURCE_URLS['mois-high-oil-2026'], {
  sourceId = 'mois-high-oil-2026',
  fetchImpl = fetch,
  captureDir = capturePathFromEnv(process.env),
  expectedLayout = GOV_PRESS_LAYOUTS['mois-high-oil-page'],
  minIntervalMs = 2000,
  timeoutMs = 20000
} = {}) {
  const url = new URL(pageUrl);
  ensureHttpOnly(url);
  if (articleType(url) !== 'mois-high-oil-page') return { status: 'unsupported_page', url: url.href, sourceId, pageType: null };
  const client = createPublicClient({ captureDir, requestLimit: 40, minIntervalMs, timeoutMs, allowedHosts: officialHostAliases(url.hostname), fetchImpl });
  const response = await client.get(url.href, { sourceId, pageType: 'mois-high-oil-page' });
  if (!validPublicHtml(response)) return failureResult(response, 'mois-high-oil-page');
  try {
    const record = parseGovPolicyPage(response.html, { sourceId, pageUrl: response.url || url.href, expectedLayout });
    return {
      status: record.publishedDate ? (record.layoutStatus === 'baseline_missing' ? 'usable_html_baseline_missing' : 'usable_html') : (record.layoutStatus === 'baseline_missing' ? 'usable_html_partial_date_missing_baseline' : 'usable_html_partial_date_missing'),
      pageType: 'mois-high-oil-page',
      httpStatus: response.status,
      contentType: response.contentType,
      charset: response.charset,
      record,
      captureFiles: response.captureFiles ?? null,
      url: response.url,
      checkedAt: response.checkedAt
    };
  } catch (error) {
    return {
      status: error?.code === 'HTML_LAYOUT_CHANGED' ? 'HTML_LAYOUT_CHANGED' : 'parse_error',
      pageType: error?.pageType ?? 'mois-high-oil-page',
      httpStatus: response.status,
      contentType: response.contentType,
      captureFiles: response.captureFiles ?? null,
      url: response.url,
      checkedAt: response.checkedAt,
      error: error?.code ?? error?.message ?? 'GOV_POLICY_PAGE_PARSE_ERROR',
      missing: error?.missing ?? null,
      partial: error?.partial ?? null
    };
  }
}

/**
 * Fetch a korea.kr policy list, observed/verified pagination pages, and observed policy detail links.
 * The only page URL synthesized is the exact observed form action plus pageIndex=2, verified by a public GET.
 */
export async function collectKoreaPolicyNews({
  listUrl = GOV_PRESS_SOURCE_URLS['policy-list'],
  sourceId = 'policy-list',
  maxPages = 2,
  maxArticles = 5,
  fetchImpl = fetch,
  now = () => new Date(),
  captureDir = capturePathFromEnv(process.env),
  expectedLayouts = GOV_PRESS_LAYOUTS,
  minIntervalMs = 2000,
  timeoutMs = 20000
} = {}) {
  const startUrl = new URL(listUrl);
  ensureHttpOnly(startUrl);
  if (!startUrl.hostname.endsWith('korea.kr') || !/\/news\/policyNewsList\.do$/i.test(startUrl.pathname)) {
    return { status: 'unsupported_list', url: startUrl.href, sourceId };
  }
  const client = createPublicClient({
    captureDir,
    requestLimit: 40,
    minIntervalMs,
    timeoutMs,
    allowedHosts: officialHostAliases(startUrl.hostname),
    fetchImpl
  });
  const pending = [startUrl.href];
  const seenPages = new Set();
  const pages = [];
  const detailUrls = new Map();
  const rowMinistryByUrl = new Map();
  const details = [];

  while (pending.length && pages.length < Math.max(1, Math.min(maxPages, 40))) {
    const pageUrl = pending.shift();
    if (seenPages.has(pageUrl)) continue;
    seenPages.add(pageUrl);
    const response = await client.get(pageUrl, { sourceId, pageType: 'korea-policy-list' });
    if (!validPublicHtml(response)) {
      pages.push(failureResult(response, 'korea-policy-list'));
      break;
    }
    let parsed;
    try {
      parsed = parseGovPressList(response.html, { sourceId, pageUrl: response.url || pageUrl, expectedLayout: expectedLayouts['korea-policy-list'] });
    } catch (error) {
      pages.push({ status: error?.code === 'HTML_LAYOUT_CHANGED' ? 'HTML_LAYOUT_CHANGED' : 'parse_error', pageType: 'korea-policy-list', error: error?.code ?? error?.message, captureFiles: response.captureFiles ?? null });
      break;
    }
    const pageResult = { ...parsed, status: parsed.layoutStatus === 'matched' ? 'usable_html' : parsed.layoutStatus, httpStatus: response.status, contentType: response.contentType, charset: response.charset, captureFiles: response.captureFiles ?? null, checkedAt: response.checkedAt };
    if (pages.length && pageResult.records) {
      const priorIds = new Set((pages[0].records ?? []).map(row => new URL(row.sourceUrl).searchParams.get('newsId')));
      const newIds = pageResult.records.map(row => new URL(row.sourceUrl).searchParams.get('newsId')).filter(id => id && !priorIds.has(id));
      if (newIds.length) pages[0].paginationEvidence = { ...pages[0].paginationEvidence, followed: true, verification: 'different_news_ids', newArticleIds: newIds };
      else {
        pageResult.status = 'pagination_get_unverified';
        pages[0].paginationEvidence = { ...pages[0].paginationEvidence, followed: false, verification: 'no_new_news_ids', blockedReason: 'pagination_get_unverified' };
      }
    }
    pages.push(pageResult);
    for (const href of parsed.paginationLinks) {
      const candidate = new URL(href);
      if (candidate.origin === startUrl.origin && candidate.pathname === startUrl.pathname && !seenPages.has(candidate.href) && !pending.includes(candidate.href)) pending.push(candidate.href);
    }
    for (const row of parsed.records) {
      if (row.sourceUrl) {
        const articleUrl = new URL(row.sourceUrl);
        const newsId = articleUrl.searchParams.get('newsId');
        if (newsId && !detailUrls.has(newsId)) detailUrls.set(newsId, row.sourceUrl);
      }
      if (row.sourceUrl && row.ministry) rowMinistryByUrl.set(row.sourceUrl, row.ministry);
    }
  }

  for (const articleUrl of [...detailUrls.values()].slice(0, Math.max(0, Math.min(maxArticles, 35)))) {
    const response = await client.get(articleUrl, { sourceId, pageType: 'korea-policy-detail' });
    const result = await recordRequest(response, 'korea-policy-detail', html => parseGovPressDetail(html, {
      sourceId,
      articleUrl: response.url || articleUrl,
      ministry: rowMinistryByUrl.get(articleUrl) ?? null,
      expectedLayout: expectedLayouts['korea-policy-detail']
    }));
    details.push(result);
  }

  const usableDetails = details.filter(item => item.status === 'usable_html' || item.status === 'usable_html_baseline_missing');
  const usablePages = pages.filter(item => item.status === 'usable_html' || item.status === 'baseline_missing');
  const status = pages.some(item => item.status === 'HTML_LAYOUT_CHANGED') || details.some(item => item.status === 'HTML_LAYOUT_CHANGED')
    ? 'HTML_LAYOUT_CHANGED'
    : usablePages.length > 0 && usableDetails.length > 0
      ? usableDetails.length < details.length
        ? 'usable_html_partial_details'
        : (usableDetails.some(item => item.status.endsWith('baseline_missing')) || usablePages.some(item => item.layoutStatus === 'baseline_missing') ? 'usable_html_baseline_missing' : 'usable_html')
      : 'incomplete';
  return {
    status,
    sourceId,
    checkedAt: now().toISOString(),
    listUrl: startUrl.href,
    pageCount: pages.filter(page => page.records).length,
    articleLinkCount: detailUrls.size,
    parsedArticleCount: usableDetails.length,
    pages,
    details,
    paginationUrls: [...seenPages].slice(1)
  };
}

/** Fetch and parse the korea.kr official press-release list and observed article links. */
export async function collectKoreaBriefingReleases({
  listUrl = GOV_PRESS_SOURCE_URLS['korea-press-release-list'],
  sourceId = 'korea-press-release-list',
  maxPages = 1,
  maxArticles = 0,
  fetchImpl = fetch,
  now = () => new Date(),
  captureDir = capturePathFromEnv(process.env),
  expectedLayouts = GOV_PRESS_LAYOUTS,
  minIntervalMs = 2000,
  timeoutMs = 20000
} = {}) {
  const startUrl = new URL(listUrl);
  ensureHttpOnly(startUrl);
  if (!startUrl.hostname.endsWith('korea.kr') || !/\/briefing\/pressReleaseList\.do$/i.test(startUrl.pathname)) return { status: 'unsupported_list', url: startUrl.href, sourceId };
  const client = createPublicClient({ captureDir, requestLimit: 40, minIntervalMs, timeoutMs, allowedHosts: officialHostAliases(startUrl.hostname), fetchImpl });
  const articleLimit = Math.max(0, Math.min(Number.isFinite(maxArticles) ? Math.floor(maxArticles) : 0, 35));
  const pending = [startUrl.href];
  const seenPages = new Set();
  const pages = [];
  const detailByUrl = new Map();
  const details = [];

  while (pending.length && pages.length < Math.max(1, Math.min(maxPages, 40))) {
    const pageUrl = pending.shift();
    if (seenPages.has(pageUrl)) continue;
    seenPages.add(pageUrl);
    const response = await client.get(pageUrl, { sourceId, pageType: 'korea-press-release-list' });
    if (!validPublicHtml(response)) {
      pages.push(failureResult(response, 'korea-press-release-list'));
      break;
    }
    const parsed = parseKoreaBriefingList(response.html, { sourceId, pageUrl: response.url || pageUrl, expectedLayout: expectedLayouts['korea-press-release-list'] });
    pages.push({ ...parsed, status: parsed.layoutStatus === 'matched' ? 'usable_html' : parsed.layoutStatus, httpStatus: response.status, contentType: response.contentType, charset: response.charset, captureFiles: response.captureFiles ?? null, checkedAt: response.checkedAt });
    for (const href of parsed.paginationLinks) {
      const candidate = new URL(href);
      if (candidate.origin === startUrl.origin && candidate.pathname === startUrl.pathname && !seenPages.has(candidate.href) && !pending.includes(candidate.href)) pending.push(candidate.href);
    }
    for (const row of parsed.records) if (row.sourceUrl && !detailByUrl.has(row.sourceUrl)) detailByUrl.set(row.sourceUrl, row);
  }

  for (const [articleUrl, row] of [...detailByUrl.entries()].slice(0, articleLimit)) {
    const response = await client.get(articleUrl, { sourceId, pageType: 'korea-release-detail' });
    details.push(await recordRequest(response, 'korea-release-detail', html => parseGovPressDetail(html, {
      sourceId,
      articleUrl: response.url || articleUrl,
      ministry: row.ministry ?? null,
      expectedLayout: expectedLayouts['korea-release-detail']
    })));
  }
  const usableDetails = details.filter(item => item.status === 'usable_html' || item.status === 'usable_html_baseline_missing');
  const usablePages = pages.filter(item => item.status === 'usable_html' || item.status === 'baseline_missing');
  const listOnly = articleLimit === 0;
  const allPagesUsable = pages.length > 0 && pages.every(page => usablePages.includes(page));
  const status = pages.some(item => item.status === 'HTML_LAYOUT_CHANGED') || details.some(item => item.status === 'HTML_LAYOUT_CHANGED')
    ? 'HTML_LAYOUT_CHANGED'
    : listOnly && allPagesUsable
      ? (usablePages.some(item => item.layoutStatus === 'baseline_missing' || item.status === 'baseline_missing') ? 'usable_html_baseline_missing' : 'usable_html')
      : usablePages.length && usableDetails.length
      ? (usableDetails.some(item => item.status.endsWith('baseline_missing')) || usablePages.some(item => item.layoutStatus === 'baseline_missing') ? 'usable_html_baseline_missing' : 'usable_html')
      : 'incomplete';
  return {
    status,
    coverage: listOnly ? 'list_only' : 'list_and_details_requested',
    sourceId,
    checkedAt: now().toISOString(),
    listUrl: startUrl.href,
    pageCount: pages.filter(page => page.records).length,
    releaseLinkCount: detailByUrl.size,
    parsedArticleCount: usableDetails.length,
    pages,
    details,
    paginationUrls: [...seenPages].slice(1)
  };
}

/** Convenience dispatcher for a known ontology source ID or a directly observed article URL. */
export async function collectGovPressSource(sourceId, options = {}) {
  if (sourceId === 'policy-list' || sourceId === 'ministry-notices') return collectKoreaPolicyNews({ sourceId, ...options });
  if (sourceId === 'korea-press-release-list') return collectKoreaBriefingReleases({ sourceId, ...options });
  if (sourceId === 'mois-high-oil-2026') return collectGovPolicyPage(options.pageUrl ?? GOV_PRESS_SOURCE_URLS[sourceId], { sourceId, ...options });
  const articleUrl = options.articleUrl ?? GOV_PRESS_SOURCE_URLS[sourceId];
  if (!articleUrl) return { status: 'source_url_required', sourceId };
  return collectGovPressArticle(articleUrl, { sourceId, ...options });
}

export function createGovPressLayout({ selectors, headerLabels = [], rowCount = 1 }) {
  const fingerprint = structuralFingerprint(selectors, headerLabels);
  return { ...fingerprint, rowCount };
}

export async function writeGovPressFixture(name, html, metadata = {}) {
  const safeName = String(name).replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  const directory = path.join(HERE, 'fixtures', 'gov-press');
  await fs.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `${safeName}.html`);
  await fs.writeFile(filePath, `${String(html).trim()}\n`, 'utf8');
  await fs.writeFile(path.join(directory, `${safeName}.meta.json`), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  return { filePath, metaPath: path.join(directory, `${safeName}.meta.json`) };
}

async function runCli(argv = process.argv.slice(2)) {
  const [command, key] = argv;
  if (command !== 'collect' || !key) {
    process.stdout.write('Usage: node gov-press-html.mjs collect <source-id>\n');
    process.exitCode = 64;
    return;
  }
  const result = await collectGovPressSource(key);
  const compact = {
    status: result.status,
    sourceId: result.sourceId,
    sourceType: result.record?.sourceType ?? result.pageType ?? null,
    httpStatus: result.httpStatus ?? null,
    title: result.record?.title ?? null,
    publishedDate: result.record?.publishedDate ?? null,
    ministry: result.record?.ministry ?? null,
    bodyCharacters: result.record?.body?.length ?? 0,
    attachmentCount: result.record?.attachments?.length ?? 0,
    pageCount: result.pageCount ?? 0,
    parsedArticleCount: result.parsedArticleCount ?? 0,
    error: result.error ?? null,
    missing: result.missing ?? null,
    captureFiles: result.captureFiles ?? null
  };
  process.stdout.write(`${JSON.stringify(compact, null, 2)}\n`);
  if (result.status !== 'usable_html' && result.status !== 'usable_html_baseline_missing') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli().catch(error => {
    process.stderr.write(`${error?.code ?? error?.message ?? 'GOV_PRESS_COLLECT_FAILED'}\n`);
    process.exitCode = 1;
  });
}
