import { presaleReceiptRoute } from "../modules/presale/receipts/runtime.ts";
import type { PrivateHandlers } from "./handler.ts";

export const PRESALE_RECEIPT_HANDLERS = {
  "presale.receipt.image": (request, { client }) => presaleReceiptRoute()(request, client),
} satisfies PrivateHandlers;
