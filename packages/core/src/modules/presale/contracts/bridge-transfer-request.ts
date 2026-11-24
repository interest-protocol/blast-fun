import { z } from "zod";

import { addressSchema, uintSchema } from "./primitives.ts";

export const bridgeSourceSchema = z.enum(["solana", "base", "arbitrum", "ethereum"]);
export const positiveBridgeAtomsSchema = uintSchema
  .max(20)
  .pipe(
    z
      .string()
      .refine((value) => BigInt(value) > 0n && BigInt(value) <= 18_446_744_073_709_551_615n),
  );
export const evmTxHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export const solanaSignatureSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);

export const bridgeTransferRequestSchema = z
  .strictObject({
    source: bridgeSourceSchema,
    tx_hash: z.string().min(1).max(128),
    sui_address: addressSchema,
    amount: uintSchema,
    presale_id: addressSchema,
  })
  .meta({
    $id: "https://blast-v2.invalid/presale/contracts/bridge-transfer-request.schema.json",
    title: "Bridge transfer registration",
    description:
      "POST /api/presale/bridge/transfers; idempotent on (source, tx_hash); amount is USDC atoms.",
  });

export const bridgeTransferSubmissionSchema = bridgeTransferRequestSchema
  .extend({
    amount: positiveBridgeAtomsSchema,
  })
  .refine(
    ({ source, tx_hash }) =>
      (source === "solana" ? solanaSignatureSchema : evmTxHashSchema).safeParse(tx_hash).success,
  );

export type BridgeTransferRequest = z.infer<typeof bridgeTransferRequestSchema>;
export type BridgeSource = z.infer<typeof bridgeSourceSchema>;
