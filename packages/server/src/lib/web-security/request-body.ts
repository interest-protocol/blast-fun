/**
 * Reads a request or response body as UTF-8 text, at most `maxBytes` of it: a declared
 * `Content-Length` over the limit is refused unread, and a streamed body is
 * cancelled as soon as it passes the limit. Null when the body is too large,
 * so a caller answers its own "invalid" without buffering a large upload
 * (review L5: `request.text()` read the whole body before checking it).
 * With `signal`, an abort cancels the read and throws; with `fatal`, malformed UTF-8 throws.
 */
export async function readBoundedText(
  message: Pick<Request | Response, "headers" | "body">,
  maxBytes: number,
  options: Readonly<{ fatal?: boolean; signal?: AbortSignal }> = {},
): Promise<string | null> {
  const declared = Number(message.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await message.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!message.body) return "";
  const reader = message.body.getReader();
  const cancel = () => void reader.cancel().catch(() => undefined);
  options.signal?.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      options.signal?.throwIfAborted();
      const { done, value } = await reader.read();
      options.signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    options.signal?.removeEventListener("abort", cancel);
  }
  return new TextDecoder("utf-8", { fatal: options.fatal === true }).decode(Buffer.concat(chunks));
}
