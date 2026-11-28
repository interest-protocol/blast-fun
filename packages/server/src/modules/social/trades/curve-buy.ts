import type { ClientAddress } from "@blast/core/lib/web-security/client-address.ts";
import {
  defineBlastDeployment,
  launchpadDeployment,
  evaluateProtocolAccess,
  observeDeploymentRuntime,
  type BlastDeploymentInput,
} from "@interest-protocol/blast-sdk/deployments";
import {
  decodeLaunchObject,
  LaunchpadTransactions,
} from "@interest-protocol/blast-sdk/launchpad";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";

import {
  CURVE_PAYMENT_PATH,
  curvePaymentRequestSchema,
  type CurvePaymentRequest,
  type CurvePaymentBuild,
  curveSponsorRequestSchema,
  type CurveSponsorRequest,
  type CurveSponsoredBuild,
} from "@blast/core/modules/launchpad-coin/curve-payment.ts";
import { configuredSigningChain } from "@blast/core/modules/launchpad-coin/signing-chain.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import {
  readSocialJson,
  type SocialRouteKit,
  type SocialCaller,
} from "@blast/server/modules/social/route-kit/route.ts";
import { socialInput } from "@blast/server/modules/social/route-kit/validation.ts";
import { blastWalletOf } from "@blast/server/modules/social/coins/runtime.ts";
import { sharedSocialRouteKit } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import { sponsorService } from "@blast/server/modules/sponsor/runtime.ts";
import type { SponsorKindRequest } from "@blast/server/modules/sponsor/service.ts";
import type { SponsorCaller } from "@blast/server/modules/sponsor/caller.ts";
import type { SponsorResponse } from "@blast/core/modules/presale/contracts/web-api.ts";
import type { TradeRouter } from "./aggregator.ts";
import type { TradeChain } from "./chain.ts";
import { openTradeQuote } from "./quote-token.ts";
import {
  socialTradeChain,
  socialTradeQuoteKey,
  socialTradeRouter,
} from "./runtime.ts";

type Dependencies = Readonly<{
  chain: TradeChain;
  router: TradeRouter;
  quoteKey: Buffer;
  manifest: BlastDeploymentInput;
  mode: "production" | "non-production";
  now: number;
  useGasCoin?: boolean;
}>;

/** Swap X into the curve's Quote and buy in one PTB; unused Quote returns to its owner. */
export async function buildRoutedCurveBuy(
  dependencies: Dependencies,
  input: CurvePaymentRequest,
  accountId: string,
  sender: string,
): Promise<CurvePaymentBuild> {
  const { chain, router, now } = dependencies;
  const quote = openTradeQuote(dependencies.quoteKey, input.quote_id);
  if (
    !quote ||
    quote.accountId !== accountId ||
    quote.sender !== sender ||
    quote.expiresAtMs <= now ||
    quote.issuedAtMs > now ||
    quote.minOut <= 0n ||
    quote.blastFeeBps !== (router.fee?.bps ?? 0)
  )
    throw new SocialRouteError("invalid_request");
  const { deployment, launch } = await liveCurve(dependencies, input.launch_id);
  if (
    launch.lifecycle !== "Live" ||
    quote.outCoin !== launch.quoteType ||
    quote.inCoin === quote.outCoin
  )
    throw new SocialRouteError("invalid_request");
  if ((await chain.balance(sender, quote.inCoin)) < quote.amountIn)
    throw new SocialRouteError("insufficient_balance");
  const tx = new Transaction();
  tx.setSender(sender);
  const payment = tx.coin({
    type: quote.inCoin,
    balance: quote.amountIn,
    useGasCoin: dependencies.useGasCoin ?? true,
  });
  const output = await router.appendSwap(
    tx,
    quote.route,
    payment,
    quote.slippageBps,
  );
  const [funding] = tx.splitCoins(output, [tx.pure.u64(quote.minOut)]);
  const sdk = new LaunchpadTransactions(launchpadDeployment(deployment));
  const bought = tx.add(
    sdk.call.buy({
      memeType: launch.memeType,
      quoteType: launch.quoteType,
      launch: {
        objectId: launch.objectId,
        initialSharedVersion: launch.initialSharedVersion,
      },
      quoteCoin: funding,
      minMemeOut: BigInt(input.min_meme_out),
    }),
  );
  tx.transferObjects([output, bought[0], bought[1]], sender);
  const kind = await tx.build({
    client: chain.client,
    onlyTransactionKind: true,
  });
  return {
    launch_id: input.launch_id,
    sender,
    quote_type: launch.quoteType,
    quote_amount: quote.minOut.toString(),
    payment_type: quote.inCoin,
    payment_amount: quote.amountIn.toString(),
    min_meme_out: input.min_meme_out,
    expires_at_ms: quote.expiresAtMs,
    transaction_kind_bytes: toBase64(kind),
  };
}

async function liveCurve(dependencies: Dependencies, launchId: string) {
  const { chain } = dependencies;
  const deployment = defineBlastDeployment(dependencies.manifest);
  if (deployment.network !== "mainnet")
    throw new SocialRouteError("service_unavailable");
  const runtime = await observeDeploymentRuntime(chain.client, deployment);
  if (
    evaluateProtocolAccess({
      manifest: deployment,
      mode: dependencies.mode,
      runtime,
    }).signing !== "enabled"
  )
    throw new SocialRouteError("service_unavailable");
  const { object } = await chain.client.core.getObject({
    objectId: launchId,
    include: { content: true },
  });
  if (object.owner.$kind !== "Shared")
    throw new SocialRouteError("invalid_request");
  const launch = decodeLaunchObject(
    {
      objectId: object.objectId,
      initialSharedVersion: object.owner.Shared.initialSharedVersion,
      mutable: true,
      type: object.type,
      content: object.content,
    },
    deployment.packages.launchpad.originalPackageId,
  );
  if (launch.lifecycle !== "Live") throw new SocialRouteError("invalid_request");
  return { deployment, launch };
}

export async function buildSponsoredCurveTrade(
  dependencies: Dependencies & { sponsor(request: SponsorKindRequest): Promise<SponsorResponse> },
  input: CurveSponsorRequest,
  accountId: string,
  sender: string,
  caller: SponsorCaller,
  ip: string,
  signal?: AbortSignal,
): Promise<CurveSponsoredBuild> {
  let kind: Uint8Array;
  let expiresAtMs = Number.POSITIVE_INFINITY;
  if (input.quote_id) {
    const routed = await buildRoutedCurveBuy({ ...dependencies, useGasCoin: false }, {
      launch_id: input.launch_id, quote_id: input.quote_id, min_meme_out: input.min_out,
    }, accountId, sender);
    if (routed.payment_amount !== input.amount) throw new SocialRouteError("invalid_request");
    kind = fromBase64(routed.transaction_kind_bytes);
    expiresAtMs = routed.expires_at_ms;
  } else {
    const { deployment, launch } = await liveCurve(dependencies, input.launch_id);
    const amount = BigInt(input.amount);
    const coinType = input.direction === "buy" ? launch.quoteType : launch.memeType;
    if (await dependencies.chain.balance(sender, coinType) < amount) throw new SocialRouteError("insufficient_balance");
    const sdk = new LaunchpadTransactions(launchpadDeployment(deployment));
    const args = {
      launch: { objectId: launch.objectId, initialSharedVersion: launch.initialSharedVersion, mutable: true as const },
      memeType: launch.memeType, quoteType: launch.quoteType, recipient: sender,
    };
    const tx = input.direction === "buy"
      ? sdk.buy({ ...args, quoteAmount: amount, minMemeOut: BigInt(input.min_out), useGasCoin: false })
      : sdk.sell({ ...args, memeAmount: amount, minQuoteOut: BigInt(input.min_out) });
    tx.setSender(sender);
    kind = await tx.build({ client: dependencies.chain.client, onlyTransactionKind: true });
  }
  // The sponsor enforces the IP request rate and open-reservation limit.
  const sponsored = await dependencies.sponsor({ caller, presaleId: null, sender, kindBytes: kind, intent: "trade", ip, signal });
  return { ...sponsored, expires_at_ms: Math.min(expiresAtMs, sponsored.expires_at_ms), transaction_kind_bytes: toBase64(kind) };
}

export function createCurveBuyRoute(
  dependencies: Readonly<{
    kit: SocialRouteKit;
    blastWallet(caller: SocialCaller): Promise<string | null>;
    build(
      input: CurvePaymentRequest,
      accountId: string,
      sender: string,
    ): Promise<CurvePaymentBuild>;
    /** Blast's gas pool pays for a Privy embedded wallet and a wallet session alike (owner ruling 2026-11-20). */
    sponsor?(input: CurveSponsorRequest, accountId: string, sender: string, caller: SocialCaller, ip: string, signal: AbortSignal): Promise<CurveSponsoredBuild>;
  }>,
) {
  return dependencies.kit.route(
    {
      name: `POST ${CURVE_PAYMENT_PATH}`,
      auth: "account",
      account: "required",
      bucket: "social_commit",
      cache: "private",
    },
    async (context) => {
      const body = await readSocialJson(context.request, ["launch_id"], ["quote_id", "min_meme_out", "sponsor", "direction", "amount", "min_out"]);
      const input = socialInput(body.sponsor === true ? curveSponsorRequestSchema : curvePaymentRequestSchema, body);
      const wallet = await dependencies.blastWallet(context.caller!);
      if (!wallet) throw new SocialRouteError("blast_wallet_missing");
      if ("sponsor" in input) {
        if (!dependencies.sponsor) throw new SocialRouteError("unauthorized");
        return context.json(await dependencies.sponsor(input, context.account!.account_id, normalizeSuiAddress(wallet), context.caller!, context.client.rateKey, context.request.signal));
      }
      const accountId = context.account!.account_id;
      return context.json(
        await dependencies.build(input, accountId, normalizeSuiAddress(wallet)),
        200,
      );
    },
  );
}

export const routedCurveBuy = (request: Request, client: ClientAddress) =>
  createCurveBuyRoute({
    kit: sharedSocialRouteKit(),
    blastWallet: blastWalletOf,
    async build(input, accountId, sender) {
      const config = configuredSigningChain();
      if (!config) throw new SocialRouteError("service_unavailable");
      return buildRoutedCurveBuy(
        {
          chain: socialTradeChain(),
          router: socialTradeRouter(),
          quoteKey: socialTradeQuoteKey(),
          manifest: config.manifest,
          mode: config.mode,
          now: Date.now(),
          useGasCoin: false,
        },
        input,
        accountId,
        sender,
      );
    },
    async sponsor(input, accountId, sender, caller, ip, signal) {
      const config = configuredSigningChain();
      if (!config) throw new SocialRouteError("service_unavailable");
      return buildSponsoredCurveTrade({
        chain: socialTradeChain(), router: socialTradeRouter(), quoteKey: socialTradeQuoteKey(),
        manifest: config.manifest, mode: config.mode, now: Date.now(),
        sponsor: request => sponsorService().sponsor(request),
      }, input, accountId, sender, caller, ip, signal);
    },
  })(request, client);
