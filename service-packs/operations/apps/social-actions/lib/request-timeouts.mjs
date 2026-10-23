// Processing deadlines only. Request pacing, server cooldowns, authentication
// freshness and the number of mutation attempts are independent of these limits.
export const SOCIAL_REQUEST_TIMEOUTS = Object.freeze({
  read: 90_000,
  publicAsset: 60_000,
  write: 120_000,
  ai: 180_000,
  sessionLock: 600_000,
  readiness: 300_000,
});
