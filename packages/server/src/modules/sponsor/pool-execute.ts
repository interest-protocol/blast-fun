import { z } from "zod";
import { isValidTransactionDigest, toBase64 } from "@mysten/sui/utils";

import { PresaleRouteError } from "@blast/core/modules/presale/route-kit/errors.ts";

/** How long execute waits for the sponsor service's answer. */
export const GAS_POOL_EXECUTE_TIMEOUT_MS = 20_000;
/** The largest `execute_tx` answer read: effects JSON lists every changed object. */
const EXECUTE_ANSWER_LIMIT_BYTES = 1_024 * 1_024;

/** Reads at most `limit` bytes of `response`'s body as text, or null when it is longer. */
export async function boundedText(
  response: Response,
  limit: number,
): Promise<string | null> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * An executed transaction's outcome, from the pool's effects or the fullnode:
 * its digest, its status, and the net gas in MIST (computation + storage −
 * rebate), which may be negative.
 */
export type SponsorExecutionEffects = Readonly<{
  digest: string;
  status: "success" | "failure";
  gasUsed: bigint;
}>;

/**
 * The sponsor service's answer to one execute:
 * - `executed`: the pool answered with effects;
 * - `unknown`: anything else. The pool may have submitted the transaction
 *   before the failure (a timeout, a cut-off answer, a gateway page, an error
 *   raised after the fullnode call), so the caller looks the digest up on the
 *   chain. `reason` and `httpStatus` are metric labels only.
 */
export type GasPoolExecution =
  | Readonly<{ status: "executed"; effects: SponsorExecutionEffects }>
  | Readonly<{
      status: "unknown";
      reason: "transport" | "pool_error" | "malformed";
      httpStatus: number | null;
    }>;

/**
 * The sponsor service's execute call (the `gas-pool` service). It signs as sponsor and submits; the web
 * app signs nothing. `execute` never throws.
 */
export type PresaleGasPoolExecutor = Readonly<{
  execute(
    input: Readonly<{ txBytes: Uint8Array; userSignature: string }>,
  ): Promise<GasPoolExecution>;
}>;

const mistSchema = z
  .union([
    z.number().int().safe().nonnegative().transform(String),
    z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
  ])
  .transform(BigInt);
const poolEffectsSchema = z.object({
  status: z.object({ status: z.enum(["success", "failure"]) }),
  transactionDigest: z.string().refine(isValidTransactionDigest),
  gasUsed: z.object({
    computationCost: mistSchema,
    storageCost: mistSchema,
    storageRebate: mistSchema,
  }),
});
const poolAnswerSchema = z.object({
  error: z.unknown().optional(),
  effects: z.unknown().optional(),
});

/**
 * The fields execute keeps from a `SuiTransactionBlockEffects` (JSON-RPC
 * shape, as the sponsor service answers): `status.status`, the digest, and the net
 * gas from `gasUsed`. Null when out of shape.
 */
export function parsePoolEffects(value: unknown): SponsorExecutionEffects | null {
  const parsed = poolEffectsSchema.safeParse(value);
  if (!parsed.success) return null;
  const {
    transactionDigest: digest,
    status: { status },
    gasUsed,
  } = parsed.data;
  return {
    digest,
    status,
    gasUsed: gasUsed.computationCost + gasUsed.storageCost - gasUsed.storageRebate,
  };
}

/**
 * The sponsor service's execute client (blast-gas-pool's `server.ts`):
 * `POST <url>/v1/execute` with `{ tx_bytes, user_sig }` and `Authorization: Bearer <token>`,
 * waiting at most `timeoutMs` (20 s) for the whole answer. Only a 2xx carrying
 * effects and no `error` is `executed`; every other outcome is `unknown`.
 * The caller's request signal is not passed on: a client that goes away must
 * not cut off an execution that may already be on chain.
 */
export function createSuiGasPoolExecutor(
  input: Readonly<{
    url: string;
    token: string;
    fetch?: typeof globalThis.fetch;
    timeoutMs?: number;
  }>,
): PresaleGasPoolExecutor {
  const endpoint = new URL("v1/execute", input.url.endsWith("/") ? input.url : `${input.url}/`);
  const fetch = input.fetch ?? globalThis.fetch;
  const timeoutMs = input.timeoutMs ?? GAS_POOL_EXECUTE_TIMEOUT_MS;
  return Object.freeze({
    async execute({ txBytes, userSignature }) {
      const body = JSON.stringify({
        tx_bytes: toBase64(txBytes),
        user_sig: userSignature,
      });
      let response: Response | undefined;
      let text: string | null;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${input.token}`,
            "content-type": "application/json",
          },
          body,
          signal: AbortSignal.timeout(timeoutMs),
          cache: "no-store",
        });
        text = await boundedText(response, EXECUTE_ANSWER_LIMIT_BYTES);
      } catch {
        return {
          status: "unknown",
          reason: "transport",
          httpStatus: response?.status ?? null,
        } as const;
      }
      const httpStatus = response.status;
      let answer: unknown;
      try {
        answer = text === null || text === "" ? undefined : JSON.parse(text);
      } catch {
        return { status: "unknown", reason: "malformed", httpStatus } as const;
      }
      const parsed = poolAnswerSchema.safeParse(answer);
      const record = parsed.success ? parsed.data : null;
      if (record && z.string().safeParse(record.error).success)
        return { status: "unknown", reason: "pool_error", httpStatus } as const;
      const effects = response.ok && record ? parsePoolEffects(record.effects) : null;
      if (!effects) return { status: "unknown", reason: "malformed", httpStatus } as const;
      return { status: "executed", effects } as const;
    },
  });
}

/** The gas pool's address and bearer, parsed once at boot. */
export type GasPoolSettings = Readonly<{ url: string; token: string | null }>;

/**
 * `PRESALE_GAS_POOL_URL` (http or https) and `PRESALE_GAS_POOL_TOKEN`, the
 * reserve client's settings: null while the URL is unset, so execution
 * answers `service_unavailable`. A set URL that is not http or https throws.
 */
export function gasPoolSettings(
  environment: Readonly<Record<string, string | undefined>>,
): GasPoolSettings | null {
  const url = environment.PRESALE_GAS_POOL_URL?.trim();
  if (!url) return null;
  if (!URL.canParse(url) || !["https:", "http:"].includes(new URL(url).protocol)) {
    throw new Error("PRESALE_GAS_POOL_URL must be an http or https URL.");
  }
  return { url, token: environment.PRESALE_GAS_POOL_TOKEN?.trim() || null };
}

/** The executor for `settings`; without a URL or a token, `service_unavailable` before anything is submitted. */
export function gasPoolExecutor(settings: GasPoolSettings | null): PresaleGasPoolExecutor {
  if (!settings?.token) throw new PresaleRouteError("service_unavailable");
  return createSuiGasPoolExecutor({ url: settings.url, token: settings.token });
}
