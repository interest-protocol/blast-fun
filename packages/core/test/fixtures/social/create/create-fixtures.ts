import type { CreateDraft } from "@blast/core/modules/social/contracts/create.ts";
import { blankDraft } from "@blast/core/modules/social/create/model.ts";

const hex = (tag: string) => `0x${tag.repeat(64).slice(0, 64)}`;

/** The design's sample with what a creator types first: a name, a ticker, a line and the recipients' addresses. */
export function filledSample(): CreateDraft {
  const draft = blankDraft();
  return {
    ...draft,
    venue: "bluefin",
    name: "Meridian",
    symbol: "MRDN",
    tagline: "Onchain FX for stablecoins on Sui",
    token_recipients: [
      { ...draft.token_recipients[0]!, address: hex("7a") },
      { ...draft.token_recipients[1]!, address: hex("b3") },
    ],
    raise_recipients: [{ ...draft.raise_recipients[0]!, address: hex("7a") }],
  };
}
