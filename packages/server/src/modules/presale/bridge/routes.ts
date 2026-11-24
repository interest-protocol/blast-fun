import { routeSegments } from "@blast/core/modules/backend-api/route-path.ts";
import { PRESALE_BRIDGE_TRANSFER_PATH } from "@blast/core/modules/backend-api/private/presale-contracts.ts";
import { z } from "zod";
import type { BridgeTransferStatusResponse } from "@blast/core/modules/presale/contracts/web-api.ts";
import { PresaleRouteError } from "@blast/core/modules/presale/route-kit/errors.ts";
import { readJsonBody, type PresaleRouteKit } from "@blast/core/modules/presale/route-kit/route.ts";
import type { BridgeActivationGate } from "./activation.ts";
import type { CircleIris } from "@blast/core/modules/presale/bridge/circle.ts";
import {
  BRIDGE_OPEN_REGISTRATIONS_PER_ACCOUNT,
  BRIDGE_OPEN_REGISTRATIONS_RETRY_AFTER_SECONDS,
  BridgeRegistrationError,
  bridgeSource,
  parseBridgeTransferRegistration,
  positiveBridgeAtoms,
  type BridgeSource,
  type BridgeTransfer,
  type BridgeTransferRegistration,
  type BridgeTransfers,
} from "@blast/core/modules/presale/bridge/contracts.ts";
import { bridgeQuote, type BridgeEtaSeconds } from "@blast/core/modules/presale/bridge/quote.ts";

/** Transfer ids are server-issued: `bt_` and 32 lowercase hex characters. */
export const BRIDGE_TRANSFER_ID = /^bt_[0-9a-f]{32}$/;

/** `source` and `amount`, each exactly once; anything malformed is `invalid_parameter` (CL-21). */
function quoteParameters(request: Request): { source: BridgeSource; amount: bigint } {
  const search = new URL(request.url).searchParams;
  const one = (name: string) => {
    const values = search.getAll(name);
    return values.length === 1 ? values[0] : null;
  };
  const from = bridgeSource(one("source"));
  const amount = positiveBridgeAtoms(one("amount"));
  if (from === null || amount === null) throw new PresaleRouteError("invalid_parameter");
  return { source: from, amount };
}

/** The contracts' registration rule; a refusal is `invalid_request`. */
function registration(body: unknown, privyDid: string | null): BridgeTransferRegistration {
  try {
    return parseBridgeTransferRegistration(body, privyDid);
  } catch (error) {
    if (error instanceof BridgeRegistrationError) throw new PresaleRouteError("invalid_request");
    throw error;
  }
}

/** The `{id}` path segment of `/api/presale/bridge/transfers/{id}`. */
function transferId(request: Request): string {
  const segment = routeSegments(PRESALE_BRIDGE_TRANSFER_PATH, new URL(request.url).pathname)?.id ?? "";
  if (!z.string().regex(BRIDGE_TRANSFER_ID).safeParse(segment).success)
    throw new PresaleRouteError("invalid_parameter");
  return segment;
}

/** The published status payload (CL-7): timestamps in milliseconds. */
export function bridgeTransferStatus(transfer: BridgeTransfer): BridgeTransferStatusResponse {
  const ms = (at: Date | null) => (at === null ? null : at.getTime());
  return {
    status: transfer.status,
    timestamps: {
      sent_ms: transfer.sentAt.getTime(),
      attested_ms: ms(transfer.attestedAt),
      minted_ms: ms(transfer.mintedAt),
      failed_ms: ms(transfer.failedAt),
    },
    sui_digest: transfer.suiDigest,
    error: transfer.error,
  };
}

export type PresaleBridgeRouteDependencies = Readonly<{
  kit: PresaleRouteKit;
  /** The cached Iris facade (`createCachedCircle`): its failures are `bridge_unavailable`. */
  circle: CircleIris;
  activation: BridgeActivationGate;
  transfers: Pick<BridgeTransfers, "register" | "find"> & {
    findByHash(source: BridgeTransfer["source"], txHash: string): Promise<BridgeTransfer | null>;
    openRegistrations(privyDid: string, limit: number): Promise<number>;
  };
  eta?: BridgeEtaSeconds;
}>;

/**
 * The three bridge routes (contract section 3.3, CL-7, CL-18):
 *
 * - quote: no auth, `presale_bridge_quote` per IP; `bridge_unavailable` while
 *   the bridge is off or Circle is unavailable (429, timeout, error);
 * - register: optional Privy token, `presale_bridge_register` per IP;
 *   `bridge_unavailable` while off; 201 `{id}` when new, 200 `{id}` on a repeat.
 *   A signed-in caller holding `BRIDGE_OPEN_REGISTRATIONS_PER_ACCOUNT`
 *   unattested burns is `rate_limited` for a new one (review L6); a repeat of
 *   a burn already registered still answers its id;
 * - status: no auth; `bridge_unavailable` until the bridge was first
 *   activated, then `not_found` for an unknown id. It keeps answering after a
 *   later deactivation, so a burn in flight stays visible.
 *
 * Burns are not validated here: the source transaction may not be final yet,
 * so the relayer worker checks them.
 */
export function createPresaleBridgeRoutes(dependencies: PresaleBridgeRouteDependencies) {
  const { kit, circle, activation, transfers } = dependencies;

  async function active() {
    const state = await activation.current();
    if (!state.active) throw new PresaleRouteError("bridge_unavailable");
    return state;
  }

  return Object.freeze({
    quote: kit.route(
      { name: "GET /api/presale/bridge/quote", auth: "none", bucket: "presale_bridge_quote" },
      async (context) => {
        const { source: from, amount } = quoteParameters(context.request);
        const state = await active();
        return Promise.all([circle.fees(from), circle.fastAllowance()]).then(
          ([fees, allowanceUsdc]) => {
            const quote = bridgeQuote({
              source: from,
              amount,
              fees,
              allowanceUsdc,
              activation: state,
              eta: dependencies.eta,
            });
            // Circle lists no Standard route to Sui from this source.
            if (quote === null) throw new PresaleRouteError("bridge_unavailable");
            return context.json(quote);
          },
        );
      },
    ),
    register: kit.route(
      {
        name: "POST /api/presale/bridge/transfers",
        auth: "optional",
        bucket: "presale_bridge_register",
      },
      async (context) => {
        const input = registration(
          await readJsonBody(context.request),
          context.account?.did ?? null,
        );
        await active();
        if (
          input.privyDid !== null &&
          (await transfers.openRegistrations(
            input.privyDid,
            BRIDGE_OPEN_REGISTRATIONS_PER_ACCOUNT,
          )) >= BRIDGE_OPEN_REGISTRATIONS_PER_ACCOUNT &&
          (await transfers.findByHash(input.source, input.txHash)) === null
        ) {
          throw new PresaleRouteError("rate_limited", {
            retryAfterSeconds: BRIDGE_OPEN_REGISTRATIONS_RETRY_AFTER_SECONDS,
          });
        }
        const { id, created } = await transfers.register(input);
        return context.json({ id }, created ? 201 : 200);
      },
    ),
    status: kit.route(
      {
        name: "GET /api/presale/bridge/transfers/{id}",
        auth: "none",
        bucket: "presale_bridge_status",
      },
      async (context) => {
        const id = transferId(context.request);
        if (!(await activation.everActivated())) throw new PresaleRouteError("bridge_unavailable");
        const transfer = await transfers.find(id);
        if (!transfer) throw new PresaleRouteError("not_found");
        return context.json(bridgeTransferStatus(transfer));
      },
    ),
  });
}

export type PresaleBridgeRoutes = ReturnType<typeof createPresaleBridgeRoutes>;
