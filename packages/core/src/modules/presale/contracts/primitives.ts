import { z } from "zod";
import { COIN_TYPE_WITH_GENERICS, SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

export const uintSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .meta({
    description:
      "An on-chain u64 (atoms, bps, counts, indexes) as an unsigned decimal string (CL-11).",
  });

export const coinTypeSchema = z
  .string()
  .regex(COIN_TYPE_WITH_GENERICS)
  .meta({ description: "A canonical coin type, 0x<64 hex>::<module>::<Name>." });

export const addressSchema = z
  .string()
  .regex(SUI_OBJECT_ID_PATTERN)
  .meta({
    description: "0x and 64 lowercase hex characters.",
  });

export const digestSchema = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
  .meta({
    description: "A Sui transaction digest, base58.",
  });

export const base64Schema = z
  .string()
  .regex(/^[A-Za-z0-9+/]+={0,2}$/)
  .meta({
    description: "Standard base64.",
  });
