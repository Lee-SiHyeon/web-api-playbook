import { classifyHubTitle } from '../category';
import { HubCategory } from '../types';

/** Parse common Korean hot-deal title patterns to extract store, price, shipping. */
export interface ParsedDealTitle {
  store: string | null;
  cleanTitle: string;
  priceKrw: number | null;
  shippingNote: string | null;
}

// Common Korean e-commerce stores and their aliases
const STORE_PATTERNS: Record<string, string[]> = {
  '쿠팡': ['쿠팡', 'coupang'],
  '네이버': ['네이버', 'naver'],
  'G마켓': ['g마켓', 'gmarket', 'G마켓'],
  '옥션': ['옥션', 'auction'],
  '11번가': ['11번가', '11st'],
  '위메프': ['위메프', 'wemakeprice'],
  '티몬': ['티몬', 'tmon'],
  '컬리': ['컬리', 'kurly'],
  '마켓컬리': ['마켓컬리'],
  '롯데ON': ['롯데on', '롯데온'],
  '신세계몰': ['신세계몰'],
  '공식몰': ['공식몰'],
  '아마존': ['아마존', 'amazon'],
  '알리바바': ['알리바바'],
  '나이키': ['나이키'],
  'SSG': ['ssg'],
};

// Category keyword patterns
const CATEGORY_KEYWORDS: Record<HubCategory, string[]> = {
  food: ['라면', '생수', '고기', '소시지', '계란', '치즈', '요거트', '우유', '커피', '차', '음료', '과자', '초콜릿', '누텔라', '알밤'],
  living: ['휴지', '물티슈', '세제', '샴푸', '린스', '바디워시', '칫솔', '치약', '쓰레기봉투', '섬유유연제'],
  pc: ['ssd', '그래픽카드', '램', '모니터', 'cpu', '메인보드', '파워서플라이', '쿨러', '노트북', '키보드', '마우스', '마우스패드'],
  digital: ['이어폰', '헤드폰', 'tv', '텔레비전', '청소기', '에어컨', '냉장고', '세탁기', '건조기', '오디오', '스피커', '스마트폰', '태블릿'],
  game: ['게임', 'ps5', 'ps4', 'xbox', '닌텐도', '스팀', 'pc방', 'fps'],
  fashion: ['셔츠', '바지', '치마', '양말', '신발', '운동화', '부츠', '코트', '재킷', '원피스', '가방', '지갑', '시계', '안경'],
  beauty: ['스킨', '토너', '에센스', '크림', '마스크', '팩', '샤워', '로션', '화장품', '립스틱', '파운데이션', '아이섀도', '마스카라', '향수'],
  baby: ['기저귀', '분유', '젖병', '아기', '유모차', '카시트', '아동용', '유아', '어린이'],
  pet: ['반려동물', '개밥', '고양이', '강아지', '펫', '동물용'],
  coupon: ['쿠폰', '상품권', '기프티콘', '카드', '할인권', '바우처'],
  travel: ['항공', '숙박', '호텔', '리조트', '펜션', '에어비앤비', '여행'],
  etc: [],
};

/** Extract store name from bracketed or prefixed patterns. */
function extractStore(title: string): string | null {
  // Pattern: [쿠팡] or [네이버] at start or in parentheses
  const bracketed = title.match(/\[([^\]]+)\]/);
  if (bracketed) {
    const candidate = bracketed[1].trim();
    for (const [store, aliases] of Object.entries(STORE_PATTERNS)) {
      if (aliases.some(a => a.toLowerCase() === candidate.toLowerCase())) {
        return store;
      }
    }
    // Return as-is if matches store-like pattern
    if (candidate.length < 20 && !candidate.includes('http')) {
      return candidate;
    }
  }

  // Search for store keywords in title
  for (const [store, aliases] of Object.entries(STORE_PATTERNS)) {
    for (const alias of aliases) {
      if (title.toLowerCase().includes(alias.toLowerCase())) {
        return store;
      }
    }
  }

  return null;
}

/** Extract price in Korean won (₩, 원, or digits with comma). */
function extractPrice(title: string): { price: number | null; cleanTitle: string } {
  // Pattern: (12,900원) or (₩12,900) or 12,900원 or ₩12,900
  const pricePatterns = [
    /\(₩[\d,]+\)/,                    // (₩12,900)
    /\([\d,]+원\)/,                   // (12,900원)
    /₩[\d,]+/,                        // ₩12,900
    /[\d,]+원(?!\d)/,                 // 12,900원 (not followed by digit)
    /\(₩?[\d,]+\)/,                   // (12,900)
  ];

  let cleanTitle = title;
  let price: number | null = null;

  for (const pattern of pricePatterns) {
    const match = title.match(pattern);
    if (match) {
      const priceStr = match[0]
        .replace(/[^\d,]/g, '')        // Remove non-digits except comma
        .replace(/,/g, '');             // Remove commas
      price = parseInt(priceStr, 10);
      if (price > 0 && price < 1_000_000_000) {
        cleanTitle = title.replace(match[0], '').trim();
        break;
      }
    }
  }

  return { price, cleanTitle };
}

/** Extract shipping info: 무료, 3,000원, 무배, 배송료 등. */
function extractShipping(title: string): { shipping: string | null; cleanTitle: string } {
  const shippingPatterns = [
    /무료배송|무배/i,
    /배송료\s*[\d,]+원/i,
    /배송\s*[\d,]+원/i,
    /\/\s*무료/,                      // / 무료
    /\(무료\)/,
  ];

  let shipping: string | null = null;
  let cleanTitle = title;

  for (const pattern of shippingPatterns) {
    const match = title.match(pattern);
    if (match) {
      const shippingStr = match[0].replace(/[()\/]/g, '').trim();
      if (shippingStr.length < 30) {
        shipping = shippingStr;
        cleanTitle = title.replace(match[0], '').trim();
        break;
      }
    }
  }

  return { shipping, cleanTitle };
}

/** Main parser: extract store, price, shipping from title. */
export function parseDealTitle(title: string): ParsedDealTitle {
  if (!title || title.length === 0) {
    return { store: null, cleanTitle: '', priceKrw: null, shippingNote: null };
  }

  // Remove extra whitespace
  let working = title.replace(/\s+/g, ' ').trim();

  // Extract price (usually in parentheses at end)
  const { price, cleanTitle: afterPrice } = extractPrice(working);
  working = afterPrice;

  // Extract shipping info
  const { shipping, cleanTitle: afterShipping } = extractShipping(working);
  working = afterShipping;

  // Extract store (usually at start in brackets)
  const store = extractStore(title); // Use original to preserve patterns
  if (store) {
    // escape: titles like "[SPF50+/PA++++] …" made an invalid pattern and crashed the build (2026-10-11)
    const escaped = store.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    working = working.replace(new RegExp(`\\[?${escaped}\\]?`, 'i'), '').trim();
  }

  // Final cleanup: remove leading/trailing brackets, extra spaces
  const cleanTitle = working
    .replace(/\(\s*[\/·,]*\s*\)/g, '')   // drop a price/shipping group emptied by extraction
    .replace(/[\(\[]\s*[\/·,]?\s*$/g, '') // and a dangling opener
    .replace(/\s+\/\s*$/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^\s*[\[\(\-\s]+/, '')     // Remove leading brackets
    .replace(/[\]\)\-\s]+\s*$/, '')     // Remove trailing brackets
    .trim();

  return {
    store,
    cleanTitle: cleanTitle || title,
    priceKrw: price,
    shippingNote: shipping,
  };
}

/** Guess category from title keywords. */
export function guessCategory(title: string): HubCategory {
  return classifyHubTitle(title);
}
