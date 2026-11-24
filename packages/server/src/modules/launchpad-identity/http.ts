// Request-reading helpers shared by the launchpad routes. Not part of the
// module's public API (index.ts does not export them).
import { LaunchpadMutationError, invalidRequest } from "@blast/server/modules/launchpad-identity/errors.ts";

/** `application/json`, optionally with `charset=utf-8`, and nothing else. */
export function assertJsonContentType(request: Request): void {
  const [type, ...parameters] = (request.headers.get("content-type") ?? "")
    .split(";")
    .map((part) => part.trim().toLowerCase());
  if (
    type !== "application/json" ||
    parameters.some((parameter) => parameter !== "charset=utf-8")
  ) {
    throw new LaunchpadMutationError("LAUNCHPAD_CONTENT_TYPE_INVALID");
  }
}

/** Reads at most `limit` bytes of strict UTF-8 JSON. */
export async function readBoundedJson(request: Request, limit: number): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= limit)) {
    throw new LaunchpadMutationError("LAUNCHPAD_PAYLOAD_TOO_LARGE");
  }
  if (!request.body) throw invalidRequest();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        throw new LaunchpadMutationError("LAUNCHPAD_PAYLOAD_TOO_LARGE");
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    if (error instanceof LaunchpadMutationError) throw error;
    throw invalidRequest();
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw invalidRequest();
  }
}
