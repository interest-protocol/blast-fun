// Request guards the launchpad telemetry routes share (coin views and
// outcome reports). `route.ts` re-exports the public ones (the cookie name,
// body bounds and `visitorIdFromRequest`); the rest stay internal.

import { LAUNCHPAD_REPORTING_POLICY, parseVisitorId } from "@blast/core/modules/launchpad-telemetry/contracts.ts";

/** First-party, HttpOnly: the browser script never reads the visitor ID. */
export const VISITOR_COOKIE_NAME = "__Host-blast_vid";
/** The visitor ID lasts as long as the records it correlates are kept. */
const VISITOR_COOKIE_MAX_AGE_SECONDS = LAUNCHPAD_REPORTING_POLICY.retentionDays * 24 * 60 * 60;

/**
 * The `Set-Cookie` value that mints `visitorId`: first-party (`__Host-`, so
 * `Path=/`, `Secure` and no `Domain`), HttpOnly, `SameSite=Lax`, kept for the
 * reporting policy's retention. Every route that mints a visitor sends exactly this.
 */
export function visitorCookie(visitorId: string): string {
  return `${VISITOR_COOKIE_NAME}=${visitorId}; Path=/; Max-Age=${VISITOR_COOKIE_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

/** A coin view is about 130 bytes; anything much larger is not one. */
export const LAUNCHPAD_TELEMETRY_BODY_LIMIT = 1_024;
/** A beacon's body arrives at once; a slow drip is abandoned after this long. */
export const LAUNCHPAD_TELEMETRY_BODY_DEADLINE_MS = 1_500;

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

/**
 * The request's opaque visitor ID, or null. Server flows pass it with the
 * verified outcomes they record so the funnel can join them to first views.
 */
export function visitorIdFromRequest(request: Request): string | null {
  try {
    return parseVisitorId(readCookie(request.headers.get("cookie"), VISITOR_COOKIE_NAME));
  } catch {
    return null;
  }
}

/** Like `assertTrustedMutationRequest`, but an absent `Origin` is allowed. */
export function sameOrigin(request: Request, expectedOrigin: string): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  return (
    (fetchSite === null || fetchSite === "same-origin") &&
    (origin === null || origin === expectedOrigin)
  );
}

type BodyRead = { text: string } | { refused: 400 | 408 | 413 };

/**
 * The body as text, stopping at `limit` bytes or at the deadline, whichever
 * comes first. A body the client aborts or that fails to stream is a 400.
 */
export async function boundedText(request: Request, limit: number, deadlineMs: number): Promise<BodyRead> {
  if (!request.body) return { text: "" };
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = request.body.getReader();
  } catch {
    // Already read or locked by someone else.
    return { refused: 400 };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), deadlineMs);
  });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>> | "deadline";
      try {
        chunk = await Promise.race([reader.read(), deadline]);
      } catch {
        await reader.cancel().catch(() => undefined);
        return { refused: 400 };
      }
      if (chunk === "deadline") {
        await reader.cancel().catch(() => undefined);
        return { refused: 408 };
      }
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        return { refused: 413 };
      }
      chunks.push(chunk.value);
    }
  } finally {
    clearTimeout(timer);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(bytes) };
}
