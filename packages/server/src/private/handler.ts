import { publicErrorResponse } from "@blast/core/lib/http-errors.ts";
import type { ClientAddress } from "@blast/core/lib/web-security/client-address.ts";
import type { VerifiedPrivateProof } from "@blast/core/modules/backend-api/private-gateway.ts";

/** What the private entry verified: the relay's proof and the client it attests. */
export type PrivateContext = Readonly<{ proof: VerifiedPrivateProof; client: ClientAddress }>;
export type PrivateHandler = (request: Request, context: PrivateContext) => Promise<Response>;
export type PrivateHandlers = Readonly<Record<string, PrivateHandler>>;

/** A thrown owner answers a retryable 503 and logs only a bounded cause label. */
export function withErrorBoundary(handler: PrivateHandler): PrivateHandler {
  return async (request, context) => {
    try {
      return await handler(request, context);
    } catch (cause) {
      return publicErrorResponse(
        "service_unavailable",
        "This service is temporarily unavailable. Please retry.",
        503,
        { route: context.proof.route.id, cause },
      );
    }
  };
}
