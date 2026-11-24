import type { CreatePageContext } from "@blast/core/modules/social/create/context.ts";
import { settledAll } from "@blast/server/lib/settled-all.ts";
import { presaleDeploymentGate } from "@blast/server/modules/presale/deployment/runtime.ts";
import { publishAvailability } from "./chain.ts";
import { presaleCoinTemplate } from "./coin-template.ts";
import { createFeePolicy, createQuoteOptions } from "./runtime.ts";

export async function createPageContext(): Promise<CreatePageContext> {
  const [fees, { policyUnavailable, ...quoteOptions }] = await settledAll([createFeePolicy(), createQuoteOptions()]);
  const availability = publishAvailability({ state: presaleDeploymentGate().state, template: presaleCoinTemplate, draft: null });
  const publish = availability.available && quoteOptions.quotes.length === 0
    ? { available: false, reasons: [policyUnavailable ? "creation_policy" : "quote_unavailable"] } as const
    : availability;
  return { fees, publish, ...quoteOptions };
}
