import { publicErrorResponse } from "@blast/core/lib/http-errors.ts";
import { withRouteLimits } from "@blast/core/modules/web-security/route-limits.ts";
import { FEEDBACK_BODY_LIMIT, FEEDBACK_KINDS, FEEDBACK_MESSAGE_LIMIT } from "@blast/core/web/contracts/feedback.ts";
import { readBoundedText } from "@blast/server/lib/web-security/request-body.ts";
import type { PrivateHandler } from "@blast/server/private/handler.ts";
import { z } from "zod";
import { listFeedback, reviewFeedback, saveFeedback } from "./repository.ts";

const KIND = z.enum(FEEDBACK_KINDS);
const ID = z.string().uuid();
const SUBMISSION = z.object({
  id: ID,
  kind: KIND,
  message: z.string().trim().min(1).max(FEEDBACK_MESSAGE_LIMIT).refine((message) => !message.includes("\u0000")),
}).strict();

const noStore = { "Cache-Control": "private, no-store" };

export const submitFeedback: PrivateHandler = async (request, { client }) => {
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return publicErrorResponse("feedback_origin", "Invalid origin.", 403);
  }
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
    return publicErrorResponse("feedback_format", "Expected JSON.", 415);
  }
  const body = await readBoundedText(request, FEEDBACK_BODY_LIMIT, { fatal: true, signal: request.signal })
    .catch(() => null);
  const submission = body === null ? null : SUBMISSION.safeParse(parseJson(body));
  if (!submission?.success) {
    return publicErrorResponse("feedback_invalid", "Write a short message and choose a type.", 400);
  }
  return withRouteLimits(client, ["product_feedback"], async () => {
    await saveFeedback(submission.data);
    return new Response(null, { status: 204, headers: noStore });
  });
};

/** The operator transport authenticates the admin bearer before invoking this route. */
export async function adminFeedback(request: Request): Promise<Response> {
  const query = new URL(request.url).searchParams;
  if (request.method === "GET") {
    const filter = z.object({ kind: KIND.nullable(), before: ID.nullable() }).safeParse({
      kind: query.get("kind"), before: query.get("before"),
    });
    if (!filter.success) {
      return publicErrorResponse("feedback_filter", "Invalid feedback filter.", 400);
    }
    return Response.json(await listFeedback(filter.data.kind, filter.data.before), { headers: noStore });
  }
  if (request.method === "POST") {
    const id = ID.safeParse(query.get("id"));
    if (!id.success) {
      return publicErrorResponse("feedback_id", "Invalid feedback ID.", 400);
    }
    if (!(await reviewFeedback(id.data))) {
      return publicErrorResponse("feedback_missing", "Feedback not found.", 404);
    }
    return new Response(null, { status: 204, headers: noStore });
  }
  return new Response(null, { status: 405, headers: { ...noStore, Allow: "GET, POST" } });
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
