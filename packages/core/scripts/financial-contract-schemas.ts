import type { z } from "zod";

import {
  socialWalletSchema,
  socialTransferRequestSchema,
  socialTransferSchema,
} from "../src/modules/social/contracts/coins.ts";
import {
  socialClaimRequestSchema,
  socialClaimSchema,
} from "../src/modules/social/contracts/claims.ts";
import {
  launchClaimRequestSchema,
  launchClaimSchema,
} from "../src/modules/social/contracts/launch-claims.ts";
import {
  socialCommitRequestSchema,
  socialCommitBuildSchema,
} from "../src/modules/social/contracts/commit.ts";
import {
  socialTradeQuoteRequestSchema,
  socialTradeQuoteSchema,
  socialTradeRequestSchema,
  socialTradeSchema,
  socialTradeCoinPageSchema,
} from "../src/modules/social/contracts/trades.ts";

export const financialContracts = {
  "wallet-coins-response": socialWalletSchema,
  "transfer-request": socialTransferRequestSchema,
  "transfer-response": socialTransferSchema,
  "claim-request": socialClaimRequestSchema,
  "claim-response": socialClaimSchema,
  "launch-claim-request": launchClaimRequestSchema,
  "launch-claim-response": launchClaimSchema,
  "commit-build-request": socialCommitRequestSchema,
  "commit-build-response": socialCommitBuildSchema,
  "trade-quote-request": socialTradeQuoteRequestSchema,
  "trade-quote-response": socialTradeQuoteSchema,
  "trade-request": socialTradeRequestSchema,
  "trade-response": socialTradeSchema,
  "trade-coin-page": socialTradeCoinPageSchema,
};

/** Preserve the published nullable/conditional layout while deriving property schemas from Zod. */
export function financialContractOverride({
  zodSchema,
  jsonSchema,
}: {
  zodSchema: z.core.$ZodType;
  jsonSchema: z.core.JSONSchema.BaseSchema;
}): void {
  const alternatives = jsonSchema.anyOf;
  if (alternatives?.length === 2 && alternatives[1]?.type === "null") {
    const value = alternatives[0]!;
    delete jsonSchema.anyOf;
    if (value.enum) {
      Object.assign(jsonSchema, value, { enum: [...value.enum, null] });
    } else {
      Object.assign(jsonSchema, value, { type: [value.type, "null"] });
    }
  }
  if (jsonSchema.enum || Object.hasOwn(jsonSchema, "const"))
    delete jsonSchema.type;

  if (zodSchema === socialWalletSchema) {
    const listing = jsonSchema.properties!
      .listing as z.core.JSONSchema.ObjectSchema;
    const extraCoins = listing.properties!
      .extra_coins as z.core.JSONSchema.ArraySchema;
    extraCoins.items = { $ref: "#/properties/coins/oneOf/1/items" };
  }
  if (
    zodSchema === socialClaimRequestSchema ||
    zodSchema === launchClaimRequestSchema
  ) {
    jsonSchema.not = {
      properties: { digest: true, failure: true },
      required: ["digest", "failure"],
    };
  }
  if (zodSchema === socialClaimRequestSchema) {
    Object.assign(jsonSchema, {
      if: { properties: { kind: { const: "claim_vesting" } } },
      then: { properties: { schedule_id: true }, required: ["schedule_id"] },
      else: {
        not: { properties: { schedule_id: true }, required: ["schedule_id"] },
      },
      allOf: [
        {
          if: {
            properties: {
              kind: {
                enum: socialClaimRequestSchema.shape.kind.options.filter(
                  (kind) =>
                    kind === "collect_fees" || kind === "claim_residuals",
                ),
              },
            },
          },
          then: { properties: { vault_id: true }, required: ["vault_id"] },
          else: {
            not: { properties: { vault_id: true }, required: ["vault_id"] },
          },
        },
      ],
    });
  }
  if (zodSchema === socialTradeQuoteRequestSchema) {
    jsonSchema.oneOf = ["amount_in", "amount_out"].map((field) => ({
      properties: { [field]: jsonSchema.properties![field] },
      required: [field],
    }));
  }
}
