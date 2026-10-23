export const COLLECTOR_MAX_BODY_BYTES = 2 * 1024 * 1024;

/** A single deadline covers headers and streamed body consumption, including injected fetches. */
export async function fetchCollectorResponse(
  fetchImpl: typeof fetch,
  url: string,
  options: RequestInit = {},
  limits: { timeoutMs?: number; maxBytes?: number; readErrorBody?: boolean } = {},
): Promise<{ ok: boolean; status: number; headers: Headers; body: Uint8Array }> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const maxBytes = limits.maxBytes ?? COLLECTOR_MAX_BODY_BYTES;
  let timeout: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      const error = new Error('Collector request timed out.');
      controller.abort(error);
      reject(error);
    }, limits.timeoutMs ?? 8000);
  });
  try {
    return await Promise.race([
      deadline,
      (async () => {
        const response = await fetchImpl(url, { ...options, signal: controller.signal });
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => {});
          controller.signal.throwIfAborted();
        }
        // Provider errors need no body. A trusted internal relay may explicitly read its bounded JSON receipt.
        reader = response.body?.getReader();
        if (!response.ok && !limits.readErrorBody) return { ok: false, status: response.status, headers: response.headers, body: new Uint8Array() };
        if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('Collector response is too large.');
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > maxBytes) throw new Error('Collector response is too large.');
            chunks.push(value);
          }
        }
        const body = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
        return { ok: response.ok, status: response.status, headers: response.headers, body };
      })(),
    ]);
  } finally {
    clearTimeout(timeout!);
    controller.abort();
    // Cancellation itself must not prolong the deadline (some streams never settle).
    void reader?.cancel().catch(() => {});
  }
}
