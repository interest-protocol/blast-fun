import type { PresaleWireLifecycle } from "@blast/core/modules/presale/contracts/read-path.ts";
import { z } from "zod";
import { PresaleRouteError } from "@blast/core/modules/presale/route-kit/errors.ts";

/** The parts of the section 2.1 projection a receipt needs. */
export type ReceiptSale = Readonly<{
  saleToken: string;
  quote: string;
  lifecycle: PresaleWireLifecycle;
}>;

/** The parts of the section 2.2 wallet view a receipt needs: each commit's time and running total. */
export type ReceiptCommit = Readonly<{ timestampMs: number; walletCommitment: string }>;

export interface PresaleReadPath {
  /** `GET /v1/presales/{id}`. */
  sale(presaleId: string, signal?: AbortSignal): Promise<ReceiptSale>;
  /** `GET /v1/presales/{id}/wallets/{address}`: the wallet's commits, empty when it never committed. */
  commits(
    presaleId: string,
    wallet: string,
    signal?: AbortSignal,
  ): Promise<readonly ReceiptCommit[]>;
}

const receiptCoinTypeSchema = z.string().regex(/^0x[0-9a-f]{64}::\w+::\w+(?:<.+>)?$/);
const receiptSaleSchema = z.object({
  presale_id: z.string(),
  sale_token: receiptCoinTypeSchema,
  quote: receiptCoinTypeSchema,
  lifecycle: z.enum(["pending", "open", "funded", "migrated", "cancelled"]),
});
const receiptCommitsSchema = z.object({
  presale_id: z.string(),
  address: z.string(),
  commits: z.array(
    z.object({
      timestamp_ms: z.number().int().safe(),
      wallet_commitment: z.string().regex(/^(?:0|[1-9][0-9]{0,19})$/),
    }),
  ),
});
const errorSchema = z.object({ error: z.object({ code: z.string() }) });
const objectSchema = z.record(z.string(), z.unknown());

function unavailable(): PresaleRouteError {
  return new PresaleRouteError("service_unavailable");
}

/**
 * blast-infra's presale `/v1` reads from the server, at `origin`
 * (`marketDataOrigin`). A 200 body is checked for the fields a receipt uses;
 * `not_found` 404 is `not_found`; `invalid_parameter` 400 is
 * `invalid_parameter`; anything else (`not_ready` 503, another status, an
 * unreachable or slow engine, a body off the contract) is
 * `service_unavailable` with `Retry-After`.
 */
export function createPresaleReadPath(
  options: Readonly<{
    origin: string;
    fetch: typeof fetch;
    timeoutMs: number;
  }>,
): PresaleReadPath {
  async function read(path: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    let response: Response;
    let body: unknown;
    try {
      const timeout = AbortSignal.timeout(options.timeoutMs);
      response = await options.fetch(new URL(path, options.origin), {
        cache: "no-store",
        headers: { accept: "application/json" },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      body = await response.json().catch(() => null);
    } catch {
      throw unavailable();
    }
    const error = errorSchema.safeParse(body);
    const code = error.success ? error.data.error.code : null;
    if (response.status === 404 && code === "not_found") throw new PresaleRouteError("not_found");
    if (response.status === 400 && code === "invalid_parameter")
      throw new PresaleRouteError("invalid_parameter");
    const parsed = objectSchema.safeParse(body);
    if (response.status !== 200 || !parsed.success) throw unavailable();
    return parsed.data;
  }

  return Object.freeze<PresaleReadPath>({
    async sale(presaleId, signal) {
      const body = await read(`/v1/presales/${presaleId}`, signal);
      const parsed = receiptSaleSchema.safeParse(body);
      if (!parsed.success || parsed.data.presale_id !== presaleId) throw unavailable();
      const { sale_token: saleToken, quote, lifecycle } = parsed.data;
      return { saleToken, quote, lifecycle };
    },
    async commits(presaleId, wallet, signal) {
      const body = await read(`/v1/presales/${presaleId}/wallets/${wallet}`, signal);
      const parsed = receiptCommitsSchema.safeParse(body);
      if (!parsed.success || parsed.data.presale_id !== presaleId || parsed.data.address !== wallet)
        throw unavailable();
      return parsed.data.commits.map(
        ({ timestamp_ms: timestampMs, wallet_commitment: walletCommitment }) => ({
          timestampMs,
          walletCommitment,
        }),
      );
    },
  });
}

/**
 * The committed amount on a receipt: the latest commit's running
 * `wallet_commitment` (it stays valid after the claim), or null when the
 * wallet never committed. The latest is the greatest `timestamp_ms`; between
 * equal times, the later entry.
 */
export function amountCommitted(commits: readonly ReceiptCommit[]): string | null {
  let latest: ReceiptCommit | null = null;
  for (const commit of commits) {
    if (!latest || commit.timestampMs >= latest.timestampMs) latest = commit;
  }
  return latest?.walletCommitment ?? null;
}
