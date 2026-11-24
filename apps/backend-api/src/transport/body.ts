import { privateBodyDeadlineMs } from "@blast/core/modules/backend-api/private-body.ts";

/** Route-specific byte and time caps apply even to undeclared/chunked bodies. */
export async function boundedPrivateBody(
  request: Request,
  maximum: number,
  outerSignal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const reject = (status: number, code: string) =>
    Response.json(
      { error: { code } },
      { status, headers: { "Cache-Control": "private, no-store" } },
    );
  const declared = request.headers.get("content-length");
  const invalidLength = declared && (!/^\d+$/.test(declared) || Number(declared) > maximum);
  if (!request.body) {
    if (invalidLength) {
      throw reject(413, "body_too_large");
    }
    return new Uint8Array();
  }
  const reader = request.body.getReader();
  const signal = AbortSignal.any([
    outerSignal,
    AbortSignal.timeout(privateBodyDeadlineMs(maximum)),
  ]);
  let cancellation: Promise<void> | undefined;
  const cancel = () => (cancellation ??= reader.cancel(signal.reason).catch(() => {}));
  const abort = () => {
    void cancel();
  };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (invalidLength) {
      throw reject(413, "body_too_large");
    }
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) {
        complete = true;
        break;
      }
      size += next.value.byteLength;
      if (size > maximum) {
        void cancel();
        throw reject(413, "body_too_large");
      }
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    if (!complete) {
      await cancel();
    }
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
