import {
  createMutationJournal,
  digestBody,
  reserveMutationDispatch,
  settleMutationDispatch,
  mutationDispatchConsumed,
} from './journal.mjs';
import { GeminiClientError } from './errors.mjs';

export async function executeMutationOnce({ transport, capability, requestSpec, actor, callerIntent, root }) {
  if (!requestSpec || (typeof requestSpec.body !== 'string' && !Buffer.isBuffer(requestSpec.body) && !(requestSpec.body instanceof Uint8Array))) {
    throw new GeminiClientError('MUTATION_BODY_INVALID', 'A mutation requires its exact encoded request body in memory.');
  }
  const wireBodyDigest = digestBody(requestSpec.body);
  const job = await createMutationJournal({ capability, body: requestSpec.body, actor, callerIntent, root });
  const ticket = await reserveMutationDispatch(job);
  try {
    const response = await transport.request(capability, requestSpec, { dispatchTicket: ticket, wireBodyDigest });
    const settled = await settleMutationDispatch(ticket, {
      state: 'response_received',
      httpStatus: response.httpStatus,
      responseBytes: response.responseBytes,
      responseSha256: response.responseSha256 ?? digestBody(response.body),
      dispatchStartedAt: response.dispatchStartedAt,
      responseReceivedAt: response.responseReceivedAt,
    });
    return Object.freeze({
      jobId: job.jobId,
      journalPath: job.jobPath,
      intentKeyHash: job.intentKeyHash,
      wireBodyDigest,
      responseSha256: settled.responseSha256,
      responseBytes: settled.responseBytes,
      httpStatus: settled.httpStatus,
      dispatchStartedAt: settled.dispatchStartedAt,
      responseReceivedAt: settled.responseReceivedAt,
      response,
    });
  } catch (error) {
    const state = mutationDispatchConsumed(ticket) ? 'outcome_unknown' : 'preflight_failed';
    await settleMutationDispatch(ticket, { state, failureCode: error?.code });
    throw error;
  }
}
