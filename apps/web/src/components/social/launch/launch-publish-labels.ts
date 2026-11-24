import type { LaunchPublishStepKind } from "@blast/core/web/contracts/launch.ts";

import type { SignLabel } from "../create/create-review-model.ts";

/** A launch signing step as the review list, the signing sheet and its errors write it: "Create $PIP", or the whole phrase with no ticker. */
export function launchSignLabel(step: LaunchPublishStepKind, symbol: string): SignLabel {
  const ticker = symbol.trim() || null;
  switch (step) {
    case "publish_coin": return ticker ? { text: "Create", ticker } : { text: "Create the coin", ticker: null };
    case "register_currency": return ticker ? { text: "Register", ticker } : { text: "Register the coin", ticker: null };
    case "create_launch": return { text: "Start trading", ticker: null };
  }
}
