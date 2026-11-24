import {
  CURVE_PAYMENT_PATH,
  curvePaymentBuildSchema,
  curveSponsoredBuildSchema,
  type CurveSponsorRequest,
  type CurveSponsoredBuild,
  type CurvePaymentBuild,
} from "@blast/core/modules/launchpad-coin/curve-payment.ts";
import { callSocialApi } from "#web/components/social/social-api.ts";
import type { LaunchpadSigner } from "../transaction/signer";

export async function requestCurvePayment(
  signer: LaunchpadSigner,
  launchId: string,
  quoteId: string,
  minimumMeme: bigint,
): Promise<CurvePaymentBuild> {
  const result = await callSocialApi(
    {
      getAccessToken: signer.accessToken ?? (async () => null),
      signal: AbortSignal.timeout(30_000),
    },
    CURVE_PAYMENT_PATH,
    {
      method: "POST",
      body: {
        launch_id: launchId,
        quote_id: quoteId,
        min_meme_out: minimumMeme.toString(),
      },
    },
    curvePaymentBuildSchema,
  );
  if (result.status !== "ok")
    throw new Error(
      "The payment route could not be verified. Refresh the quote and try again.",
    );
  return result.body;
}

/** The server will not sponsor this trade: the account's daily trade cap is spent. */
export class CurveSponsorshipUnavailable extends Error {
  constructor() {
    super("Blast gas sponsorship is unavailable. Nothing was signed. Try again shortly.");
    this.name = "CurveSponsorshipUnavailable";
  }
}

export async function requestCurveSponsorship(signer: LaunchpadSigner, input: CurveSponsorRequest): Promise<CurveSponsoredBuild> {
  const result = await callSocialApi({ getAccessToken: signer.accessToken ?? (async () => null), signal: AbortSignal.timeout(30_000) }, CURVE_PAYMENT_PATH,
    { method: "POST", body: input }, curveSponsoredBuildSchema);
  if (result.status === "refused" && result.code === "sponsorship_unavailable") throw new CurveSponsorshipUnavailable();
  if (result.status !== "ok") throw new Error("Blast gas sponsorship is unavailable. Nothing was signed. Try again shortly.");
  return result.body;
}
