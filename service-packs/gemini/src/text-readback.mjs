const API_CONVERSATION_ID = /^c_[0-9a-f]{16}$/;

function epoch(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Bind a text response to one history row without using the generated title.
 * A source-decoded API conversation ID is authoritative. When the response
 * carries no ID, the fallback accepts exactly one row updated in the actual
 * dispatch/response window; callers must still verify it through hNvQHb.
 */
export function selectTextReadbackConversation(rows, {
  responseConversationId,
  dispatchStartedAt,
  responseReceivedAt,
  clockSkewMs = 5_000,
  responseLagMs = 120_000,
} = {}) {
  const candidates = Array.isArray(rows) ? rows : [];
  if (responseConversationId !== undefined && responseConversationId !== null) {
    if (typeof responseConversationId !== 'string' || !API_CONVERSATION_ID.test(responseConversationId)) {
      return Object.freeze({ state: 'invalid_response_id', source: 'response', conversationId: null,
        historyRowMatched: false, candidateCount: 0 });
    }
    return Object.freeze({ state: 'candidate', source: 'response', conversationId: responseConversationId,
      historyRowMatched: candidates.some((row) => row?.conversationId === responseConversationId), candidateCount: 1 });
  }

  if (!Number.isSafeInteger(clockSkewMs) || clockSkewMs < 0 || clockSkewMs > 30_000
      || !Number.isSafeInteger(responseLagMs) || responseLagMs < 0 || responseLagMs > 10 * 60_000) {
    return Object.freeze({ state: 'invalid_window', source: 'dispatch_time', conversationId: null,
      historyRowMatched: false, candidateCount: 0 });
  }
  const start = epoch(dispatchStartedAt);
  const end = epoch(responseReceivedAt);
  if (start === null || end === null || end < start) {
    return Object.freeze({ state: 'window_unavailable', source: 'dispatch_time', conversationId: null,
      historyRowMatched: false, candidateCount: 0 });
  }
  const lowerBound = start - clockSkewMs;
  const upperBound = end + responseLagMs;
  const matches = candidates.filter((row) => {
    const updated = epoch(row?.updatedAt);
    return updated !== null && updated >= lowerBound && updated <= upperBound
      && typeof row?.conversationId === 'string' && API_CONVERSATION_ID.test(row.conversationId);
  });
  if (matches.length !== 1) {
    return Object.freeze({ state: matches.length ? 'ambiguous' : 'no_candidate', source: 'dispatch_time',
      conversationId: null, historyRowMatched: false, candidateCount: matches.length });
  }
  return Object.freeze({ state: 'candidate', source: 'dispatch_time',
    conversationId: matches[0].conversationId, historyRowMatched: true, candidateCount: 1 });
}
