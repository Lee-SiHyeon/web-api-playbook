// 회수·리콜 수집원: 공식 공표를 RecallRecord(recall-safety-ontology.v1.json)로 정규화하는 순수 파서와, fetch를 주입받는 수집 함수.
// 파서는 네트워크를 쓰지 않는다(fixtures/의 실제 응답으로 테스트). 수집 함수는 익명 GET/POST만 한다.
// 키가 필요한 API(data.go.kr)는 클라이언트만 있고 키 이름은 DATA_GO_KR_SERVICE_KEY, 가입하지 않았다.
import { readFileSync } from 'node:fs';

export const REGISTRY = JSON.parse(readFileSync(new URL('./recall-sources.v1.json', import.meta.url), 'utf8'));

export const SOURCE_IDS = Object.freeze({
  food: 'foodsafetykorea:I0490',
  drug: 'nedrug:RecallSaleStop',
  consumer: 'safetykorea:recallBoard',
});

export const SOURCE_LABELS = Object.freeze({
  [SOURCE_IDS.food]: '식품안전나라(식품의약품안전처) 회수·판매중지',
  [SOURCE_IDS.drug]: '의약품안전나라(식품의약품안전처) 회수·판매중지',
  [SOURCE_IDS.consumer]: '제품안전정보센터(국가기술표준원) 국내리콜',
});

const clean = value => String(value ?? '').replace(/<!--.*?-->/gs, '').replace(/\s+/g, ' ').trim();
const decodeEntities = text => String(text)
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const stripTags = html => decodeEntities(clean(String(html).replace(/<[^>]+>/g, ' ')));

// "2026-10-02 17:52:26.65" | "20261002" | "20261002101254" | "2026.10.02" -> "2026-10-02" (잘못된 달·일이면 null)
export function isoDate(value) {
  const text = String(value ?? '').trim();
  const m = /^(\d{4})[-./]?(\d{2})[-./]?(\d{2})/.exec(text);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

// GTIN을 14자리 숫자열로 맞춘다. 길이 8·12·13·14만 인정. checksumOk는 GS1 체크디지트 통과 여부.
export function normalizeGtin(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(digits.length)) return null;
  const body = digits.slice(0, -1).padStart(13, '0');
  const sum = [...body].reverse().reduce((acc, ch, i) => acc + Number(ch) * (i % 2 === 0 ? 3 : 1), 0);
  const checksumOk = (10 - (sum % 10)) % 10 === Number(digits.at(-1));
  return { gtin14: digits.padStart(14, '0'), checksumOk };
}

export const barcodeList = value => [...new Set(String(value ?? '').split(/[|,;/\s]+/)
  .map(part => normalizeGtin(part)?.gtin14).filter(Boolean))];

// RFC 4180 수준의 CSV. 따옴표 안의 쉼표·줄바꿈·"" 이스케이프를 처리한다.
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  const src = String(text).replace(/^﻿/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i += 1; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some(cell => cell !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some(cell => cell !== '')) rows.push(row);
  return rows;
}

const record = fields => ({
  brand: null, models: [], barcodes: [], lots: [], manufactureDate: null, expiry: null, action: null, kind: null,
  names: [], noticeUrlVerified: false, ...fields,
});

// 식품안전나라 I0490 JSON. 응답 모양: {I0490:{total_count,row:[...],RESULT:{CODE,MSG}}}.
export function parseFoodSafetyI0490(json) {
  const body = typeof json === 'string' ? JSON.parse(json) : json;
  const service = body?.I0490;
  if (!service) throw Object.assign(new Error('FOODSAFETY_I0490_ENVELOPE_MISSING'), { code: 'FOODSAFETY_I0490_ENVELOPE_MISSING' });
  const code = service.RESULT?.CODE;
  if (code && code !== 'INFO-000' && code !== 'INFO-200') {
    throw Object.assign(new Error(`FOODSAFETY_${code}`), { code: `FOODSAFETY_${code}`, message: service.RESULT?.MSG });
  }
  return (service.row ?? []).map(row => record({
    id: `${SOURCE_IDS.food}:${row.RTRVLDSUSE_SEQ}`,
    sourceId: SOURCE_IDS.food,
    category: 'food',
    productName: clean(row.PRDTNM),
    names: [clean(row.PRDTNM)].filter(Boolean),
    company: clean(row.BSSHNM),
    barcodes: barcodeList(row.BRCDNO),
    manufactureDate: clean(row.MNFDT) && clean(row.MNFDT) !== '데이터없음' ? clean(row.MNFDT) : null,
    expiry: clean(row.DISTBTMLMT) || null,
    reason: clean(row.RTRVLPRVNS),
    noticeDate: isoDate(row.CRET_DTM),
    action: clean(row.RTRVLPLANDOC_RTRVLMTHD) || null,
    kind: clean(row.RTRVL_GRDCD_NM) || null,
    packaging: clean(row.FRMLCUNIT) || null,
    noticeUrl: 'https://www.foodsafetykorea.go.kr/',
    noticeUrlVerified: false,
  }));
}

export function foodSafetyUrl({ keyId = 'sample', start = 1, end = 5, createdOn = null } = {}) {
  if (!/^[A-Za-z0-9]+$/.test(keyId)) throw new Error('FOODSAFETY_KEY_INVALID');
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) throw new Error('FOODSAFETY_RANGE_INVALID');
  const filter = createdOn ? `/CRET_DTM=${String(createdOn).replace(/\D/g, '')}` : '';
  return `https://openapi.foodsafetykorea.go.kr/api/${keyId}/I0490/json/${start}/${end}${filter}`;
}

// 의약품안전나라 CSV: 품목기준코드,품목명,업체명,회수사유내용,강제여부구분,승인일자,회수명령일자,사업자번호,표준코드
export function parseNedrugRecallCsv(text) {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const index = Object.fromEntries(header.map((name, i) => [clean(name), i]));
  for (const need of ['품목기준코드', '품목명', '업체명', '회수사유내용', '회수명령일자', '표준코드']) {
    if (!(need in index)) throw Object.assign(new Error('NEDRUG_CSV_COLUMN_MISSING'), { code: 'NEDRUG_CSV_COLUMN_MISSING', column: need });
  }
  const get = (row, name) => clean(row[index[name]]);
  return rows.filter(row => get(row, '품목기준코드')).map(row => record({
    id: `${SOURCE_IDS.drug}:${get(row, '품목기준코드')}:${get(row, '회수명령일자')}`,
    sourceId: SOURCE_IDS.drug,
    category: 'drug',
    productName: get(row, '품목명'),
    names: [get(row, '품목명')],
    company: get(row, '업체명'),
    barcodes: barcodeList(get(row, '표준코드')),
    reason: get(row, '회수사유내용'),
    noticeDate: isoDate(get(row, '회수명령일자')),
    kind: get(row, '강제여부구분') === 'Y' ? '회수명령' : get(row, '강제여부구분') === 'N' ? '영업자 회수' : null,
    noticeUrl: 'https://nedrug.mfds.go.kr/pbp/CCBGA01',
    noticeUrlVerified: true,
  }));
}

const cellsOf = rowHtml => [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1]);
const splitModels = text => [...new Set(text.split(/\s*[/,]\s*/).map(part => part.replace(/\(\s*\d+\s*종\s*\)/g, '').trim()).filter(part => part && part !== '-'))];

// 제품안전정보센터 국내리콜 목록(SSR HTML). 열: 번호, 사진, 제품명, 모델명, 사업자명, 리콜종류, 바코드번호, 공표일.
// 목록에는 리콜 사유가 없다(상세 공표문에만 있음). reason은 빈 문자열이고, 사유가 필요한 글(회수 알림)은 후보에서 제외된다.
export function parseSafetykoreaBoard(html) {
  const rows = String(html).match(/<tr[^>]*onclick="goDetail\('\d+'\)"[\s\S]*?<\/tr>/g) ?? [];
  return rows.map(row => {
    const uid = /goDetail\('(\d+)'\)/.exec(row)[1];
    const cells = cellsOf(row);
    if (cells.length < 8) throw Object.assign(new Error('SAFETYKOREA_ROW_SHAPE'), { code: 'SAFETYKOREA_ROW_SHAPE', uid });
    const productName = stripTags(cells[2]);
    const modelText = stripTags(cells[3]).replace(/^\(제품명\)\s*/, '').replace(/-->/g, '').trim();
    const kind = stripTags(cells[5]);
    const barcodeText = stripTags(cells[6]);
    return record({
      id: `${SOURCE_IDS.consumer}:${uid}`,
      sourceId: SOURCE_IDS.consumer,
      category: /완구|어린이|유아|장난감|슬라임/.test(productName) ? 'children_product' : 'consumer_product',
      productName,
      names: [productName, ...(/^\(제품명\)/.test(stripTags(cells[3])) ? [modelText] : [])].filter(Boolean),
      company: stripTags(cells[4]),
      models: splitModels(modelText),
      barcodes: barcodeList(barcodeText === '-' ? '' : barcodeText),
      reason: '',
      noticeDate: isoDate(stripTags(cells[7])),
      kind: kind || null,
      noticeUrl: 'https://www.safetykorea.kr/recall/recallBoard',
      noticeUrlVerified: true,
    });
  });
}

// data.go.kr 키 API 클라이언트(키 없이는 호출하지 않는다). 응답 필드명을 이 실행에서 확인하지 못해 별칭 목록으로 읽는다(shapeVerified:false).
export const DATA_GO_KR_KEY_RECORD = 'DATA_GO_KR_SERVICE_KEY';
export const DATA_GO_KR_SERVICES = Object.freeze({
  drug: { base: 'https://apis.data.go.kr/1471000/MdcinRtrvlSleStpgeInfoService05', category: 'drug', operation: null },
  device: { base: 'https://apis.data.go.kr/1471000/MdlpRtrvlSleStpgeInfoService04', category: 'device', operation: null },
});
const ALIASES = {
  name: ['PRDUCT', 'ITEM_NAME', 'PRDLST_NM', 'productName', '품목명', '제품명'],
  company: ['ENTP_NAME', 'ENTRPS', 'BSSH_NM', 'company', '업체명', '제조수입사'],
  reason: ['RTRVL_RESN', 'RECALL_COMMAND_RESN', 'recallReason', '회수사유내용', '리콜사유'],
  date: ['RECALL_COMMAND_DATE', 'RTRVL_CMND_DE', 'noticeDate', '회수명령일자', '공표일'],
  id: ['ITEM_SEQ', 'recallId', '품목기준코드', 'id'],
  model: ['MODEL_NAME', 'model', '모델명'],
};
const pick = (item, keys) => keys.map(k => item?.[k]).find(v => v !== undefined && v !== null && String(v).trim() !== '');

export function dataGoKrRequestUrl(service, { serviceKey, pageNo = 1, numOfRows = 100, operation = service.operation } = {}) {
  if (!serviceKey) throw Object.assign(new Error('DATA_GO_KR_KEY_MISSING'), { code: 'DATA_GO_KR_KEY_MISSING', keyRecord: DATA_GO_KR_KEY_RECORD });
  if (!operation) throw Object.assign(new Error('DATA_GO_KR_OPERATION_UNKNOWN'), { code: 'DATA_GO_KR_OPERATION_UNKNOWN' });
  const query = new URLSearchParams({ serviceKey, pageNo: String(pageNo), numOfRows: String(numOfRows), type: 'json' });
  return `${service.base}/${operation}?${query}`;
}

export function parseDataGoKrJson(json, { sourceId, category }) {
  const body = typeof json === 'string' ? JSON.parse(json) : json;
  const items = body?.body?.items ?? body?.response?.body?.items ?? [];
  const list = (Array.isArray(items) ? items : items.item ?? []).map(entry => entry.item ?? entry);
  return list.map(item => {
    const name = clean(pick(item, ALIASES.name)), model = clean(pick(item, ALIASES.model));
    return record({
      id: `${sourceId}:${clean(pick(item, ALIASES.id)) || name}:${isoDate(pick(item, ALIASES.date)) ?? ''}`,
      sourceId, category, productName: name, names: [name].filter(Boolean),
      company: clean(pick(item, ALIASES.company)), models: model ? splitModels(model) : [],
      reason: clean(pick(item, ALIASES.reason)), noticeDate: isoDate(pick(item, ALIASES.date)),
      shapeVerified: false, noticeUrl: 'https://www.data.go.kr/', noticeUrlVerified: false,
    });
  }).filter(r => r.productName);
}

const getText = async (fetchImpl, url, init) => {
  const response = await fetchImpl(url, init);
  if (!response.ok) throw Object.assign(new Error(`HTTP_${response.status}`), { code: `HTTP_${response.status}`, url });
  return response.text();
};

export async function fetchFoodSafety({ fetchImpl = globalThis.fetch, keyId = 'sample', start = 1, end = 5, createdOn = null } = {}) {
  return parseFoodSafetyI0490(await getText(fetchImpl, foodSafetyUrl({ keyId, start, end, createdOn })));
}

export async function fetchNedrugRecalls({ fetchImpl = globalThis.fetch } = {}) {
  return parseNedrugRecallCsv(await getText(fetchImpl, 'https://nedrug.mfds.go.kr/cmn/xls/downc/OpenData_PotOpenRecallSaleStop'));
}

// pages: 1이면 GET 최신 목록, 2 이상이면 페이지 JS(goPage)와 같은 POST. pageNo는 0부터.
export async function fetchSafetykoreaRecalls({ fetchImpl = globalThis.fetch, pages = 1, delayMs = 800, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const out = [];
  for (let page = 0; page < pages; page += 1) {
    const html = page === 0
      ? await getText(fetchImpl, 'https://www.safetykorea.kr/recall/recallBoard')
      : await getText(fetchImpl, 'https://www.safetykorea.kr/recall/recallBoard', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ selectedOption: '0', textWord: '', pageNo: String(page) }).toString() });
    out.push(...parseSafetykoreaBoard(html));
    if (page + 1 < pages) await sleep(delayMs);
  }
  return out;
}

// 수집원별 실패를 숨기지 않는다: 하나가 실패해도 나머지 레코드는 돌려주고 failures에 남긴다(게이트는 failures가 있으면 coverage를 줄여 읽는다).
export async function collectRecallIndex({ fetchImpl = globalThis.fetch, now = new Date(), foodKeyId = 'sample', safetykoreaPages = 3 } = {}) {
  const jobs = [
    ['food', () => fetchFoodSafety({ fetchImpl, keyId: foodKeyId, end: foodKeyId === 'sample' ? 5 : 1000 })],
    ['drug', () => fetchNedrugRecalls({ fetchImpl })],
    ['consumer', () => fetchSafetykoreaRecalls({ fetchImpl, pages: safetykoreaPages })],
  ];
  const records = [], failures = [];
  for (const [name, job] of jobs) {
    try { records.push(...await job()); } catch (error) { failures.push({ source: name, code: error.code ?? error.message }); }
  }
  return { fetchedAt: now.toISOString(), records, failures, coverage: { food: foodKeyId === 'sample' ? 'sample_5_latest_only' : 'keyed', drug: 'full_csv', consumer: `latest_${safetykoreaPages}_pages` } };
}
