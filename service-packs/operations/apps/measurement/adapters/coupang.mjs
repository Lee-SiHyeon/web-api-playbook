import { metric } from './shared.mjs';

const METRICS = Object.freeze(['clicks', 'orders', 'commission']);

export function createCoupangAdapter() {
  return async function readCoupangItem() {
    return Object.fromEntries(METRICS.map(name => [name, metric(null, {
      source: 'coupang.partners-edge', reason: 'partner_reporting_edge_blocked',
    })]));
  };
}

export const COUPANG_METRICS = METRICS;

