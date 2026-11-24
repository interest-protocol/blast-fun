import { createHmac } from "node:crypto";
import { Pool } from "pg";
import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import {
  readWalletSessionToken,
  walletSessionTokenHash,
} from "@blast/core/modules/social/wallet-sign-in/sessions.ts";
import type { AccountActivitySettings } from "./config.ts";

type ActivityService = Readonly<{
  handle: (request: Request) => Promise<Response>;
  close: () => Promise<void>;
}>;

/** Independent of ordinary product pools, account creation and session activity writes. */
export function createAccountActivityService(config: AccountActivitySettings): ActivityService {
  if (config === null) {
    return { handle: async () => response(204), close: async () => {} };
  }
  if (config === "unavailable") {
    return { handle: async () => response(503), close: async () => {} };
  }
  let verify;
  try {
    verify = createPrivyTokenVerifier({
      appId: config.appId,
      verificationKey: config.verificationKey,
    });
  } catch {
    return { handle: async () => response(503), close: async () => {} };
  }
  const identity = new Pool(config.identity);
  const warehouse = new Pool(config.warehouse);
  for (const pool of [identity, warehouse]) {
    pool.on("error", () =>
      console.error(JSON.stringify({ metric: "analytics.account_activity_connection_failed" })),
    );
  }
  const successful = new Map<string, number>();
  let inflight = 0;
  let closed = false;

  return {
    async handle(request) {
      if (closed) {
        return response(503);
      }
      if (request.method !== "POST") {
        return response(405);
      }
      const url = new URL(request.url);
      if (
        url.origin !== config.origin ||
        request.headers.get("origin") !== config.origin ||
        ![null, "same-origin"].includes(request.headers.get("sec-fetch-site"))
      ) {
        return response(403);
      }
      if (
        url.search ||
        request.body !== null ||
        request.headers.has("transfer-encoding") ||
        (request.headers.has("content-length") && request.headers.get("content-length") !== "0")
      ) {
        return response(400);
      }
      if (inflight >= 2 || request.signal.aborted) {
        return response(503);
      }
      inflight++;
      try {
        const credential = await verifiedCredential(request, verify);
        if (credential === null) {
          return response(401);
        }
        if (request.signal.aborted) {
          return response(503);
        }
        const result = await identity.query<{ account_id: string | null }>(
          "SELECT public.analytics_account_id($1,$2)::text AS account_id",
          [credential.did, credential.tokenHash],
        );
        const account = result.rows[0]?.account_id;
        if (!account) {
          return response(401);
        }
        const hash = createHmac("sha256", config.key)
          .update(`blast-account-v1:${account}`)
          .digest("hex");
        if (request.signal.aborted) {
          return response(503);
        }
        if ((successful.get(hash) ?? 0) > performance.now()) {
          return response(204);
        }
        const started = performance.now();
        const saved = await warehouse.query<{ observed: Date }>(
          "SELECT blast_analytics.record_activity($1,$2) AS observed",
          [hash, config.scope],
        );
        const observed = saved.rows[0]?.observed;
        if (!(observed instanceof Date) || !Number.isFinite(observed.getTime())) {
          return response(503);
        }
        const midnight = Date.UTC(
          observed.getUTCFullYear(),
          observed.getUTCMonth(),
          observed.getUTCDate() + 1,
        );
        successful.delete(hash);
        successful.set(hash, started + Math.min(15 * 60_000, midnight - observed.getTime()));
        if (successful.size > 10_000) {
          successful.delete(successful.keys().next().value!);
        }
        return response(204);
      } catch {
        return response(503);
      } finally {
        inflight--;
      }
    },
    async close() {
      closed = true;
      successful.clear();
      await Promise.all([identity.end(), warehouse.end()]);
    },
  };
}

async function verifiedCredential(
  request: Request,
  verify: (token: string) => Promise<{ userId: string }>,
): Promise<{ did: string | null; tokenHash: string | null } | null> {
  if (request.headers.has("authorization")) {
    const bearer = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(
      request.headers.get("authorization") ?? "",
    );
    if (!bearer?.[1]) {
      return null;
    }
    try {
      return { did: (await verify(bearer[1])).userId, tokenHash: null };
    } catch {
      return null;
    }
  }
  const token = readWalletSessionToken(request);
  return token === null ? null : { did: null, tokenHash: walletSessionTokenHash(token) };
}

function response(status: number): Response {
  return new Response(null, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      ...(status === 503 ? { "Retry-After": "30" } : {}),
      ...(status === 405 ? { Allow: "POST" } : {}),
    },
  });
}
