import { GeminiClientError } from './errors.mjs';
import { requireCapturedOperation } from './contract.mjs';

const HISTORY_LIST_RPC = 'MaZiqc';

export function buildHistoryListRequest(contract, session) {
  const operation = requireCapturedOperation(contract, 'history_list');
  const context = session?.batchContext;
  if (!context) throw new GeminiClientError('SESSION_CONTEXT_REQUIRED', 'A fresh Gemini batch context is required for history reads.');
  if (operation.response.framing !== 'batchexecute' || operation.response.rpcId !== HISTORY_LIST_RPC) {
    throw new GeminiClientError('RPC_ID_NOT_OBSERVED', 'The history-list RPC does not match the captured Gemini operation.');
  }
  const fReq = JSON.stringify([[[HISTORY_LIST_RPC, JSON.stringify(context.historyListArgs), null, 'generic']]]);
  const body = new URLSearchParams([['f.req', fReq], ['at', context.at]]).toString();
  const queryValues = {
    rpcids: HISTORY_LIST_RPC,
    'source-path': context.sourcePath,
    bl: context.buildLabel,
    'f.sid': context.fSid,
    hl: context.locale,
    _reqid: context.requestId,
    rt: context.requestType,
  };
  const query = operation.request.queryKeys.map((name) => {
    if (!Object.hasOwn(queryValues, name)) {
      throw new GeminiClientError('REQUEST_CONTRACT_MISMATCH', 'The observed history query contains an unsupported field.');
    }
    return [name, queryValues[name]];
  });
  return Object.freeze({
    method: operation.request.method,
    path: operation.request.path,
    query: Object.freeze(query.map((entry) => Object.freeze(entry))),
    headers: Object.freeze({}),
    contentType: operation.request.contentType,
    body,
  });
}

export function historyListRpcId() {
  return HISTORY_LIST_RPC;
}
