import { parseBatchResponse } from '../../google-flow/src/protocol.mjs';

export const GEMINI_ORIGIN = 'https://gemini.google.com';
export const GEMINI_BATCH_PATH = '/_/BardChatUi/data/batchexecute';
export const GEMINI_RPC = Object.freeze({
  listConversations: 'MaZiqc',
  readConversation: 'hNvQHb',
});

const CONVERSATION_ID = /^c_[A-Fa-f0-9]{1,256}$/;
const MAX_CONVERSATIONS = 24;
const MAX_CONVERSATION_ROWS = 10;

export class GeminiProtocolError extends Error {
  constructor(message, { code = 'GEMINI_PROTOCOL_ERROR', rpcId, httpStatus, transportCode } = {}) {
    super(message);
    this.name = 'GeminiProtocolError';
    this.code = code;
    this.rpcId = rpcId;
    this.httpStatus = httpStatus;
    this.transportCode = transportCode;
  }
}

export function isGeminiConversationId(value) {
  return typeof value === 'string' && CONVERSATION_ID.test(value);
}

function buildEnvelope(rpcId, payload) {
  if (!Object.values(GEMINI_RPC).includes(rpcId)) {
    throw new GeminiProtocolError('Gemini RPC is not in the read-only allowlist.', { code: 'GEMINI_RPC_OUT_OF_SCOPE' });
  }
  return JSON.stringify([[[rpcId, JSON.stringify(payload), null, 'generic']]]);
}

export function buildConversationListRequest() {
  return buildEnvelope(GEMINI_RPC.listConversations, [24, null, [0, null, 1]]);
}

export function buildConversationReadRequest(conversationId) {
  if (!isGeminiConversationId(conversationId)) {
    throw new GeminiProtocolError('Gemini conversation id is invalid.', { code: 'GEMINI_CONVERSATION_ID_INVALID' });
  }
  return buildEnvelope(GEMINI_RPC.readConversation, [conversationId, 10, null, 1, [0], [4], null, 1]);
}

export function parseBatchReply(text, expectedRpcId) {
  if (!Object.values(GEMINI_RPC).includes(expectedRpcId)) {
    throw new GeminiProtocolError('Gemini RPC is not in the read-only allowlist.', {
      code: 'GEMINI_RPC_OUT_OF_SCOPE', rpcId: expectedRpcId,
    });
  }
  let entries;
  try { entries = parseBatchResponse(text); }
  catch { entries = []; }
  const entry = entries.find((candidate) => candidate.rpcId === expectedRpcId);
  if (!entry) {
    throw new GeminiProtocolError('Gemini response did not contain the expected RPC result.', {
      code: 'GEMINI_RPC_RESULT_MISSING', rpcId: expectedRpcId,
    });
  }
  if (entry.error !== undefined) {
    throw new GeminiProtocolError('Gemini rejected the read request.', {
      code: 'GEMINI_RPC_REJECTED', rpcId: expectedRpcId,
    });
  }
  return entry.data;
}

export function parseConversationList(payload) {
  const rows = payload?.[2];
  if (!Array.isArray(rows) || rows.length > MAX_CONVERSATIONS) {
    throw new GeminiProtocolError('Gemini conversation list has an unexpected shape.', {
      code: 'GEMINI_CONVERSATION_LIST_SCHEMA', rpcId: GEMINI_RPC.listConversations,
    });
  }
  const seen = new Set();
  return rows.map((row) => {
    const id = row?.[0];
    const title = row?.[1];
    if (!isGeminiConversationId(id) || typeof title !== 'string' || seen.has(id.toLowerCase())) {
      throw new GeminiProtocolError('Gemini conversation list contains an invalid row.', {
        code: 'GEMINI_CONVERSATION_LIST_SCHEMA', rpcId: GEMINI_RPC.listConversations,
      });
    }
    seen.add(id.toLowerCase());
    return { id, title };
  });
}

export function parseConversationRows(payload) {
  const rows = payload?.[0];
  if (!Array.isArray(rows) || rows.length > MAX_CONVERSATION_ROWS || rows.some((row) => !Array.isArray(row))) {
    throw new GeminiProtocolError('Gemini conversation response has an unexpected shape.', {
      code: 'GEMINI_CONVERSATION_SCHEMA', rpcId: GEMINI_RPC.readConversation,
    });
  }
  return rows;
}
