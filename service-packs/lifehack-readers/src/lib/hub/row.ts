import type { HubItem } from './types';
import { classifyHubTitle } from './category';

// Display text from any source is cleaned once here, for every writer: HTML entities decoded (11번가 sent
// "무료배송 &nbsp; &nbsp; 카드 4% 할인"), tags stripped, whitespace collapsed. null stays null.
const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', times: '×' };
export function cleanDisplayText(value: string | null | undefined): string | null {
  if (value == null) return null;
  let t = String(value).replace(/<[^>]*>/g, ' ');
  for (let i = 0; i < 2; i++) { // twice: "&amp;nbsp;" double-encoding
    t = t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') { const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m; }
      return NAMED_ENTITIES[e.toLowerCase()] ?? m;
    });
  }
  t = t.replace(/[\u00a0\s]+/g, ' ').trim();
  return t || null;
}

type HubRowInput = Partial<HubItem> & Pick<HubItem, 'id' | 'kind' | 'title' | 'source' | 'sourceUrl' | 'postedAt'>;

// HubItem (camelCase contract) → public.hub_items row (snake_case columns).
export function toHubRow(i: HubRowInput) {
  const observedAt = i.observedAt ?? i.updatedAt ?? i.postedAt;
  return {
    // Native partner category evidence survives persistence; other hot deals use the common title classifier.
    id: i.id, kind: i.kind, category: i.kind === 'hotdeal' ? i.facts?.partnerSearch?.category?.hubCategory ?? classifyHubTitle(i.title) : i.category ?? 'etc', title: cleanDisplayText(i.title) ?? i.title, store: cleanDisplayText(i.store), price_krw: i.priceKrw ?? null,
    shipping_note: cleanDisplayText(i.shippingNote), image_url: i.imageUrl ?? null, source: i.source, source_url: i.sourceUrl,
    affiliate_url: i.affiliateUrl ?? null, target_url: i.targetUrl ?? null, posted_at: i.postedAt, expires_at: i.expiresAt ?? null, comments: i.comments ?? null,
    // views is owned by the hub_record_view RPC and never written here (a refresh would reset it)
    votes: i.votes ?? null, tags: i.tags ?? [], summary: cleanDisplayText(i.summary), ended: !!i.ended,
    // Replay/import time never makes an old source observation appear current.
    observed_at: observedAt, updated_at: observedAt, facts: i.facts ?? {},
  };
}

type Db = { from: (table: string) => any; rpc?: (name: string, args: Record<string, unknown>) => PromiseLike<any> };

// Every writer (Vercel collectors, PC importer) goes through this:
// Atomic SQL enforces first posted_at, monotonic observations and separate link enrichment. The source's
// observation time advances last_seen_at only when a writer is supplied; a writerless replay can enrich links
// but cannot refresh price, revive an ended item, or claim it was listed again.
// Deploy the additive observation-integrity migration before this application version. If the RPC is absent,
// fail closed: an unconditional compatibility upsert would reintroduce the race and erase newer observations.
export async function upsertHubItems(
  db: Db,
  items: HubRowInput[],
  writer?: string | null,
): Promise<{ error: { message: string } | null; count: number }> {
  if (!items.length) return { error: null, count: 0 };
  const byId = new Map<string, ReturnType<typeof toHubRow>>();
  for (const item of items) {
    const row = toHubRow(item), observed = Date.parse(row.observed_at);
    if (!Number.isFinite(observed) || observed > Date.now() + 300_000) return { error: { message: 'Invalid or future source observation time' }, count: 0 };
    const prior = byId.get(row.id);
    if (!prior || observed > Date.parse(prior.observed_at)) byId.set(row.id, row);
  }
  if (typeof db.rpc !== 'function') return { error: { message: 'Atomic hub observation writer unavailable; apply database migration first' }, count: 0 };
  const rows = [...byId.values()];
  let count = 0;
  for (let offset = 0; offset < rows.length; offset += 500) {
    const batch = rows.slice(offset, offset + 500);
    const { data, error } = await db.rpc('hub_upsert_items', { p_items: batch, p_writer: writer || null });
    if (error) return { error, count };
    if (!data || !Number.isSafeInteger(data.accepted) || data.accepted < 0 || data.accepted > batch.length)
      return { error: { message: 'Invalid atomic hub observation receipt' }, count };
    count += data.accepted;
  }
  return { error: null, count };
}
