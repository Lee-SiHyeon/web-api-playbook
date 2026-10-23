import { CAPABILITIES } from './constants.mjs';

export function buildEvidenceMatrix(contract = null, implementationEvidence = {}, replayEvidence = {}) {
  const result = {};
  for (const capability of CAPABILITIES) {
    const operationNames = {
      text: ['text', 'history_read'],
      history: ['history_list', 'history_search', 'history_read'],
      image: ['image', 'history_read'],
      video: ['video', 'history_read'],
    }[capability];
    const captured = operationNames.every((name) => contract?.operations?.[name]?.observation?.requestResponse === true);
    const implementation = implementationEvidence[capability];
    const replay = replayEvidence[capability];
    result[capability] = {
      captured,
      client_exists: implementation?.clientExists === true,
      remnant_free: implementation?.remnantFree === true,
      credential_propagated: replay?.credentialPropagated === true,
      live_replay: replay?.liveReplay === true,
    };
  }
  return result;
}

export function currentEvidenceMatrix() {
  return buildEvidenceMatrix();
}
