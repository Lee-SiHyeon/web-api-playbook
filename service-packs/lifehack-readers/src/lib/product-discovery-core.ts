export type DiscoveryRpcResult = { data: unknown; error: { code?: string } | null };
export type DiscoveryRpc = (name: string, args: Record<string, unknown>) => PromiseLike<DiscoveryRpcResult>;

export type DiscoveryTerm = {
  termKey: string;
  category: string;
  query: string;
  leaseToken: string;
};

export type DiscoveryCandidate = {
  pcode: string;
  termKey: string;
  category: string;
  searchName: string;
  label: string | null;
  leaseToken: string;
};

export type DiscoverySeller = {
  mallCode: string;
  seller: string;
  itemPrice: number;
  shipping: number | null;
  conditions: string[];
};

export type VerifiedDiscoveryProduct = {
  pcode: string;
  name: string;
  brand: string;
  conditions: string[];
  offers: DiscoverySeller[];
};

export type DiscoverySearch = (query: string, signal: AbortSignal) => Promise<unknown>;
export type DiscoveryProductReader = (pcode: string, signal: AbortSignal) => Promise<unknown>;

const WORKER_ID = 'lifehack-vercel-cron-danawa-discovery';
const MAX_CANDIDATES_PER_SEARCH = 6;
const SAFE_PCODE = /^[1-9][0-9]{0,19}$/;
const SAFE_CATEGORY = new Set(['저장장치', '모니터', 'PC 주변기기', '오디오', '생활가전', '주방가전']);
const TERM_IDENTITY = new Map<string, RegExp>([
  ['storage-990-pro', /990.*pro|pro.*990/],
  ['monitor-27gp850', /27gp850/],
  ['peripheral-superlight-2', /superlight2/],
  ['audio-wh1000xm5', /wh1000xm5/],
  ['appliance-bespoke-robot', /비스포크|vr90f/],
  ['kitchen-philips-airfryer', /필립스/],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function tokenString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function errorCode(error: unknown): string {
  const value = isRecord(error) && typeof error.code === 'string' ? error.code : '';
  if (/ACCESS_BLOCKED/.test(value)) return 'source_blocked';
  if (/RATE_LIMITED/.test(value)) return 'source_rate_limited';
  if (/TRANSPORT|CANCELLED/.test(value)) return 'source_transport';
  if (/SCHEMA|CONTENT_TYPE|REQUEST_SCOPE|RESPONSE_TOO_LARGE/.test(value)) return 'source_schema';
  if (/PCODE|PRODUCT_IDENTITY/.test(value)) return 'source_identity_changed';
  if (/NO_ELIGIBLE_SELLERS/.test(value)) return 'no_eligible_sellers';
  return 'internal_error';
}

function safeDatabaseCode(value: unknown): string {
  return typeof value === 'string' && /^[A-Z0-9]{5}$/.test(value) ? value : 'DATABASE_ERROR';
}

async function safeRpc(rpc: DiscoveryRpc, name: string, args: Record<string, unknown>): Promise<DiscoveryRpcResult> {
  try { return await rpc(name, args); }
  catch { return { data: null, error: {} }; }
}

function parseTerm(value: unknown): DiscoveryTerm | null {
  if (!isRecord(value) || value.claimed !== true || !tokenString(value.termKey, 80) ||
      typeof value.category !== 'string' || !SAFE_CATEGORY.has(value.category) ||
      !tokenString(value.query, 100) || !tokenString(value.leaseToken, 64)) return null;
  return { termKey: value.termKey, category: value.category, query: value.query, leaseToken: value.leaseToken };
}

function parseCandidate(value: unknown): DiscoveryCandidate | null {
  if (!isRecord(value) || value.claimed !== true || typeof value.pcode !== 'string' || !SAFE_PCODE.test(value.pcode) ||
      !tokenString(value.termKey, 80) || typeof value.category !== 'string' || !SAFE_CATEGORY.has(value.category) ||
      !tokenString(value.searchName, 240) || !(value.label === null || value.label === undefined || tokenString(value.label, 120)) ||
      !tokenString(value.leaseToken, 64)) return null;
  return {
    pcode: value.pcode,
    termKey: value.termKey,
    category: value.category,
    searchName: value.searchName,
    label: typeof value.label === 'string' ? value.label : null,
    leaseToken: value.leaseToken,
  };
}

export function matchesDanawaDiscoveryTerm(termKey: string, name: string, label: string | null = null): boolean {
  const expectedIdentity = TERM_IDENTITY.get(termKey);
  if (!expectedIdentity) return false;
  const normalized = `${name} ${label ?? ''}`.toLocaleLowerCase('ko-KR').replace(/[\s\p{P}\p{S}]+/gu, '');
  return expectedIdentity.test(normalized);
}

function safeSearchCandidates(termKey: string, value: unknown): Array<{ pcode: string; name: string; label: string | null }> {
  if (!Array.isArray(value)) return [];
  const result: Array<{ pcode: string; name: string; label: string | null }> = [];
  const seen = new Set<string>();
  for (const row of value) {
    if (!isRecord(row) || typeof row.pcode !== 'string' || !SAFE_PCODE.test(row.pcode) || seen.has(row.pcode) ||
        !tokenString(row.name, 240) || !(row.label === null || tokenString(row.label, 120)) ||
        !Number.isSafeInteger(row.minPrice) || Number(row.minPrice) <= 0) continue;
    // Do not auto-publish used or refurbished units. A parallel import remains
    // a distinct Danawa pcode and therefore a distinct product identity.
    if (/(중고|리퍼(?:비시)?|전시품|반품|스크래치|재생)/i.test(`${row.name} ${row.label ?? ''}`)) continue;
    // Danawa search can include adjacent models (for example XM4 results on an
    // XM5 query). Keep the product code exact, but also require the reviewed
    // term's distinguishing model tokens before admitting it to the queue.
    if (!matchesDanawaDiscoveryTerm(termKey, row.name, typeof row.label === 'string' ? row.label : null)) continue;
    seen.add(row.pcode);
    result.push({ pcode: row.pcode, name: row.name.trim(), label: typeof row.label === 'string' ? row.label.trim() : null });
    if (result.length >= MAX_CANDIDATES_PER_SEARCH) break;
  }
  return result;
}

function safeVerifiedProduct(value: unknown, pcode: string): VerifiedDiscoveryProduct | null {
  if (!isRecord(value)) throw Object.assign(new Error('source schema'), { code: 'DANAWA_PRODUCT_SCHEMA' });
  if (value.pcode !== pcode) throw Object.assign(new Error('source identity changed'), { code: 'DANAWA_PRODUCT_IDENTITY' });
  if (!tokenString(value.name, 240) ||
      !(value.brand === '' || typeof value.brand === 'string' && value.brand.length <= 100) ||
      !Array.isArray(value.conditions) || value.conditions.some((condition) =>
        condition !== '해외구매 · 관세·통관비 미확인' && condition !== '병행수입 · 추가비용·보증범위 미확인') ||
      !Array.isArray(value.offers) || value.offers.length < 1 || value.offers.length > 3) {
    throw Object.assign(new Error('source schema'), { code: 'DANAWA_PRODUCT_SCHEMA' });
  }
  const offers: DiscoverySeller[] = [];
  const seenCodes = new Set<string>();
  for (const row of value.offers) {
    if (!isRecord(row) || !tokenString(row.mallCode, 24) || !/^[A-Za-z0-9]{1,24}$/.test(row.mallCode) ||
        seenCodes.has(row.mallCode) || !tokenString(row.seller, 240) ||
        !Number.isSafeInteger(row.itemPrice) || Number(row.itemPrice) <= 0 ||
        !(row.shipping === null || Number.isSafeInteger(row.shipping) && Number(row.shipping) >= 0) ||
        !Array.isArray(row.conditions) || row.conditions.some((condition) =>
          condition !== '해외구매 · 관세·통관비 미확인' && condition !== '병행수입 · 추가비용·보증범위 미확인')) {
      throw Object.assign(new Error('source schema'), { code: 'DANAWA_PRODUCT_SCHEMA' });
    }
    seenCodes.add(row.mallCode);
    offers.push({ mallCode: row.mallCode, seller: row.seller.trim(), itemPrice: Number(row.itemPrice),
      shipping: row.shipping === null ? null : Number(row.shipping), conditions: [...row.conditions] as string[] });
  }
  return { pcode, name: value.name.trim(), brand: typeof value.brand === 'string' ? value.brand.trim() : '',
    conditions: [...value.conditions] as string[], offers };
}

export async function runDanawaDiscoverySearch(dependencies: {
  rpc: DiscoveryRpc;
  search: DiscoverySearch;
  workerId?: string;
}): Promise<Record<string, number | boolean | string>> {
  const workerId = dependencies.workerId ?? WORKER_ID;
  const claimed = await safeRpc(dependencies.rpc, 'claim_danawa_discovery_term', {
    p_worker_id: workerId,
    p_lease_seconds: 600,
  });
  if (claimed.error) return { claimed: false, failed: true, code: 'queue_unavailable', databaseCode: safeDatabaseCode(claimed.error.code) };
  const term = parseTerm(claimed.data);
  if (!term) return { claimed: false, capacityReached: isRecord(claimed.data) && claimed.data.capacityReached === true };

  const signal = AbortSignal.timeout(25_000);
  try {
    const candidates = safeSearchCandidates(term.termKey, await dependencies.search(term.query, signal));
    const completed = await safeRpc(dependencies.rpc, 'complete_danawa_discovery_term', {
      p_term_key: term.termKey,
      p_lease_token: term.leaseToken,
      p_candidates: candidates,
    });
    if (completed.error || !isRecord(completed.data) || !Number.isSafeInteger(completed.data.queued)) {
      await safeRpc(dependencies.rpc, 'fail_danawa_discovery_term', {
        p_term_key: term.termKey, p_lease_token: term.leaseToken, p_error_code: 'internal_error',
      });
      return { claimed: true, failed: true, code: 'queue_write_failed',
        databaseCode: safeDatabaseCode(completed.error?.code) };
    }
    return { claimed: true, queued: Number(completed.data.queued), results: candidates.length };
  } catch (error) {
    const failed = await safeRpc(dependencies.rpc, 'fail_danawa_discovery_term', {
      p_term_key: term.termKey,
      p_lease_token: term.leaseToken,
      p_error_code: errorCode(error) === 'source_rate_limited' ? 'source_rate_limited'
        : errorCode(error) === 'source_blocked' ? 'source_blocked'
          : errorCode(error) === 'source_transport' ? 'source_transport'
            : errorCode(error) === 'source_schema' ? 'source_schema' : 'internal_error',
    });
    return { claimed: true, failed: true, retryScheduled: failed.data === true, code: errorCode(error) };
  }
}

export async function runDanawaDiscoveryCandidate(dependencies: {
  rpc: DiscoveryRpc;
  readProduct: DiscoveryProductReader;
  workerId?: string;
}): Promise<Record<string, number | boolean | string>> {
  const workerId = dependencies.workerId ?? WORKER_ID;
  const claimed = await safeRpc(dependencies.rpc, 'claim_danawa_discovery_candidate', {
    p_worker_id: workerId,
    p_lease_seconds: 600,
  });
  if (claimed.error) return { claimed: false, failed: true, code: 'queue_unavailable', databaseCode: safeDatabaseCode(claimed.error.code) };
  const candidate = parseCandidate(claimed.data);
  if (!candidate) return { claimed: false, capacityReached: isRecord(claimed.data) && claimed.data.capacityReached === true };

  const signal = AbortSignal.timeout(48_000);
  try {
    const product = safeVerifiedProduct(await dependencies.readProduct(candidate.pcode, signal), candidate.pcode);
    if (!product) throw Object.assign(new Error('source_identity_changed'), { code: 'DANAWA_PRODUCT_IDENTITY' });
    const result = await safeRpc(dependencies.rpc, 'complete_danawa_discovery_candidate', {
      p_pcode: candidate.pcode,
      p_lease_token: candidate.leaseToken,
      p_result: {
        product: {
          title: product.name,
          brand: product.brand,
          variant: candidate.label ?? (/해외구매|해외직구|직구/i.test(product.name) ? '해외구매'
            : /병행수입/.test(product.name) ? '병행수입' : product.name),
        },
        offers: product.offers,
      },
    });
    if (!result.error && isRecord(result.data) && result.data.status === 'rejected' && result.data.reason === 'identity_conflict') {
      return { claimed: true, rejected: true, pcode: candidate.pcode, status: 'rejected', code: 'identity_conflict' };
    }
    if (!result.error && isRecord(result.data) &&
      (result.data.status === 'registered' || result.data.status === 'already_registered') &&
        Number.isSafeInteger(result.data.observations) && typeof result.data.slug === 'string' &&
        /^[a-z0-9-]{1,180}$/.test(result.data.slug)) {
      return {
        claimed: true,
        registered: true,
        alreadyRegistered: result.data.status === 'already_registered',
        pcode: candidate.pcode,
        slug: result.data.slug,
        status: result.data.status,
        observations: Number(result.data.observations),
      };
    }
    if (result.error || !isRecord(result.data) || result.data.status !== 'registered' ||
        !Number.isSafeInteger(result.data.observations)) {
      const databaseCode = result.error?.code === 'P0001' ? 'catalog_capacity' : 'registration_failed';
      await safeRpc(dependencies.rpc, 'fail_danawa_discovery_candidate', {
        p_pcode: candidate.pcode,
        p_lease_token: candidate.leaseToken,
        p_error_code: databaseCode,
        p_retry_seconds: databaseCode === 'catalog_capacity' ? 21600 : 3600,
      });
      return { claimed: true, failed: true, pcode: candidate.pcode, status: 'retry_scheduled', code: databaseCode,
        databaseCode: safeDatabaseCode(result.error?.code) };
    }
    return { claimed: true, registered: true, observations: Number(result.data.observations) };
  } catch (error) {
    const code = errorCode(error);
    const retryCode = code === 'source_blocked' || code === 'source_rate_limited' || code === 'source_transport' ||
      code === 'source_schema' || code === 'source_identity_changed' || code === 'no_eligible_sellers' ? code : 'internal_error';
    const failed = await safeRpc(dependencies.rpc, 'fail_danawa_discovery_candidate', {
      p_pcode: candidate.pcode,
      p_lease_token: candidate.leaseToken,
      p_error_code: retryCode,
      p_retry_seconds: retryCode === 'source_blocked' || retryCode === 'source_rate_limited' ? 21600 : 3600,
    });
    return { claimed: true, failed: true, pcode: candidate.pcode, status: 'retry_scheduled',
      retryScheduled: failed.data === true, code };
  }
}

export const productDiscoveryLimits = Object.freeze({
  maxCandidatesPerSearch: MAX_CANDIDATES_PER_SEARCH,
  maxPublishedOptions: 24,
  maxSellerTargetsPerOption: 3,
});
