import {
  dateOnly, itemIdOf, revenueIdempotencyKey,
} from './shared.mjs';

const AMOUNT_FIELDS = Object.freeze(['settlementAmount', 'commissionAmount', 'partnershipCommission', 'commission', 'amount', 'revenue']);
const ID_FIELDS = Object.freeze(['transactionId', 'reservationId', 'revenueId']);

function amountOf(row) {
  for (const field of AMOUNT_FIELDS) {
    const value = row?.[field];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  }
  return null;
}

function statusOf(value) {
  const state = String(value ?? '').trim().toLowerCase();
  if (['confirmed', 'settled', 'paid', 'complete', 'completed', 'approved', '확정', '지급'].includes(state)) return 'confirmed';
  if (['reversed', 'cancelled', 'canceled', 'refunded', 'returned', '취소', '환불'].includes(state)) return 'reversed';
  if (['pending', 'hold', 'requested', 'processing', '대기', '정산중'].includes(state)) return 'pending';
  return 'pending';
}

function rowsOf(result) {
  const data = result?.data ?? result;
  if (Array.isArray(data)) return data;
  for (const field of ['rows', 'items', 'revenues', 'records', 'list']) {
    if (Array.isArray(data?.[field])) return data[field];
  }
  return data && typeof data === 'object' ? [data] : [];
}

function rowId(row) {
  for (const key of ID_FIELDS) {
    const value = row?.[key];
    if (typeof value === 'string' || typeof value === 'number') return String(value);
  }
  return null;
}

function periodOf(row, from, to) {
  const start = row?.periodStart ?? row?.startDate ?? row?.dateFrom ?? row?.from ?? row?.date ?? null;
  const end = row?.periodEnd ?? row?.endDate ?? row?.dateTo ?? row?.to ?? row?.date ?? null;
  return {
    periodStart: typeof start === 'string' ? start : from,
    periodEnd: typeof end === 'string' ? end : to,
    hasSourcePeriod: typeof start === 'string' || typeof end === 'string',
  };
}

function linkItemIndex(items) {
  const index = new Map();
  for (const item of items) {
    const itemId = itemIdOf(item);
    const roots = [item?.refs, item?.affiliateLinks, item?.links];
    for (const root of roots) {
      const values = Array.isArray(root) ? root : root && typeof root === 'object' ? Object.values(root) : [];
      for (const value of values) {
        if (value && typeof value === 'object') {
          const id = value.linkId ?? value.link_id ?? value.mylinkId ?? value.mylink_id;
          if (id != null) index.set(String(id), itemId);
        }
      }
    }
  }
  return index;
}

function unavailableRecord(network, { observedAt, from, to, source, reason }) {
  return {
    network, status: 'pending', amount: null, currency: 'KRW', observedAt,
    source, periodStart: from, periodEnd: to, reason,
    idempotencyKey: revenueIdempotencyKey(network, '', '', `unavailable:${reason}`, 'pending', null),
  };
}

export function mapMyrealtripRevenue(result, { items = [], observedAt, from, to } = {}) {
  const rows = rowsOf(result);
  const byLink = linkItemIndex(items);
  const revenue = [];
  const aggregates = new Map();
  for (const row of rows) {
    const amount = amountOf(row);
    if (amount === null) continue;
    const status = statusOf(row?.status ?? row?.settlementStatus ?? row?.paymentStatus ?? row?.state);
    const currency = String(row?.currency ?? row?.currencyCode ?? 'KRW').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) continue;
    const linkId = row?.linkId ?? row?.link_id ?? row?.mylinkId ?? row?.mylink_id ?? null;
    const id = rowId(row);
    const period = periodOf(row, from, to);
    if (!id) {
      // Rows without a stable source transaction key stay as a network-level
      // aggregate. Never attribute these to a content item or use the response
      // row number as identity.
      const aggregateKey = [status, currency, period.hasSourcePeriod ? period.periodStart : '',
        period.hasSourcePeriod ? period.periodEnd : ''].join('\u0000');
      const previous = aggregates.get(aggregateKey);
      if (previous) previous.amount += amount;
      else aggregates.set(aggregateKey, { status, currency, amount, ...period });
      continue;
    }
    revenue.push({
      network: 'myrealtrip', status, amount, currency, observedAt,
      source: 'myrealtrip.partner-api.revenues', itemId: linkId == null ? null : byLink.get(String(linkId)) ?? null,
      linkId: linkId == null ? null : String(linkId), sourceRecordId: id,
      periodStart: period.periodStart, periodEnd: period.periodEnd,
      idempotencyKey: revenueIdempotencyKey('myrealtrip', '', '', id, status, amount),
    });
  }
  for (const [key, row] of aggregates) {
    const [status, currency] = key.split('\u0000');
    const periodStart = row.hasSourcePeriod ? row.periodStart : from;
    const periodEnd = row.hasSourcePeriod ? row.periodEnd : to;
    revenue.push({
      network: 'myrealtrip', status, amount: row.amount, currency, observedAt,
      source: 'myrealtrip.partner-api.revenues', itemId: null, linkId: null,
      periodStart, periodEnd,
      idempotencyKey: revenueIdempotencyKey('myrealtrip', row.hasSourcePeriod ? row.periodStart : '',
        row.hasSourcePeriod ? row.periodEnd : '', `network-aggregate:${currency}`, status, row.amount),
    });
  }
  if (revenue.length) return { revenue, problems: [] };
  return {
    revenue: [unavailableRecord('myrealtrip', { observedAt, from, to, source: 'myrealtrip.partner-api.revenues', reason: 'revenue_row_schema_unverified' })],
    problems: [{ network: 'myrealtrip', code: 'MYREALTRIP_REVENUE_SCHEMA_UNVERIFIED', observedAt, source: 'myrealtrip.partner-api.revenues' }],
  };
}

export function createMyrealtripRevenueAdapter({ deps = {}, items = [], now = new Date(), since } = {}) {
  return async function readMyrealtripRevenue() {
    const observedAt = new Date(now).toISOString();
    const to = dateOnly(now);
    const from = dateOnly(since) ?? dateOnly(new Date(new Date(now).getTime() - 30 * 86_400_000));
    let result;
    const injected = deps.myrealtrip?.readRevenue ?? deps.myrealtrip?.revenues ?? deps.readMyrealtripRevenue;
    if (typeof injected === 'function') result = await injected({ from, to, type: 'SETTLEMENT', flight: false });
    else if (deps.myrealtrip?.client && typeof deps.myrealtrip.client.revenues === 'function') {
      result = await deps.myrealtrip.client.revenues({ from, to, type: 'SETTLEMENT', flight: false });
    } else {
      const { createMyrealtripPartnerApi } = await import('../../affiliate-api-hub/adapters/myrealtrip-partner-api.mjs');
      const api = createMyrealtripPartnerApi({ store: deps.myrealtrip?.store ?? null,
        ...(deps.myrealtrip?.fetchImpl ? { fetchImpl: deps.myrealtrip.fetchImpl } : {}) });
      result = await api.revenues({ from, to, type: 'SETTLEMENT', flight: false });
    }
    return mapMyrealtripRevenue(result, { items, observedAt, from, to });
  };
}

export function createLinkpriceRevenueAdapter({ deps = {}, items = [], now = new Date(), since } = {}) {
  return async function readLinkpriceRevenue() {
    const observedAt = new Date(now).toISOString();
    const to = dateOnly(now);
    const from = dateOnly(since) ?? dateOnly(new Date(new Date(now).getTime() - 30 * 86_400_000));
    const injected = deps.linkprice?.readRevenue ?? deps.linkprice?.readReport ?? deps.readLinkpriceRevenue;
    if (typeof injected === 'function') {
      const result = await injected({ from, to, type: 'SETTLEMENT' });
      const records = Array.isArray(result?.revenue) ? result.revenue : Array.isArray(result) ? result : [];
      if (records.length) return { revenue: records.map(row => ({
        ...row, network: 'linkprice', observedAt: row.observedAt ?? observedAt,
        itemId: row.sourceRecordId ? row.itemId ?? null : null, linkId: row.linkId ?? null,
        source: row.source ?? 'linkprice.report-settlement',
        idempotencyKey: row.idempotencyKey ?? revenueIdempotencyKey('linkprice',
          row.sourceRecordId ? '' : from, row.sourceRecordId ? '' : to,
          row.sourceRecordId ?? `network-aggregate:${row.currency ?? 'KRW'}`, row.status, row.amount),
      })), problems: [] };
    }
    return {
      revenue: [unavailableRecord('linkprice', { observedAt, from, to, source: 'linkprice.report-settlement', reason: 'settlement_reader_unavailable' })],
      problems: [{ network: 'linkprice', code: 'LINKPRICE_SETTLEMENT_READER_UNAVAILABLE', observedAt, source: 'linkprice.report-settlement' }],
    };
  };
}

export function createCoupangRevenueAdapter({ now = new Date(), since } = {}) {
  return async function readCoupangRevenue() {
    const observedAt = new Date(now).toISOString();
    const to = dateOnly(now);
    const from = dateOnly(since) ?? dateOnly(new Date(new Date(now).getTime() - 30 * 86_400_000));
    return {
      revenue: [unavailableRecord('coupang', { observedAt, from, to, source: 'coupang.partner-report', reason: 'partner_reporting_edge_blocked' })],
      problems: [{ network: 'coupang', code: 'COUPANG_REPORT_EDGE_BLOCKED', observedAt, source: 'coupang.partner-report' }],
    };
  };
}

export const revenueAdapterInternals = Object.freeze({ amountOf, statusOf, rowsOf, rowId, linkItemIndex });
