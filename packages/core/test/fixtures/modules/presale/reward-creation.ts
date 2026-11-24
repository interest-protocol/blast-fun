import {
  presaleEventBcs,
  presaleEventModules,
  type PresaleEventPayloads,
} from "@interest-protocol/blast-sdk/presale";

export const rewardAddress = (n: number) =>
  `0x${n.toString(16).padStart(64, "0")}`;
export const REWARD_PACKAGE = rewardAddress(900);

/** Real SDK BCS, embedded in the native transaction-evidence envelope. */
export function rewardCreationEvent(
  presaleId: string,
  coin: string,
  overrides: Partial<PresaleEventPayloads["PresaleCreated"]> = {},
) {
  const payload: PresaleEventPayloads["PresaleCreated"] = {
    presale_id: presaleId,
    presale_cap_id: rewardAddress(901),
    treasury_cap_id: rewardAddress(902),
    token_supply: 1000000n,
    token_allocation_bps: 5000n,
    participant_vesting: null,
    liquidity_token_allocation_bps: 2000n,
    recipients: [],
    recipient_bps: [],
    burnable: false,
    raise_target: 1000n,
    raise_recipients: [],
    raise_recipient_bps: [],
    duration_ms: 86400000n,
    liquidity_window_ms: 86400000n,
    eligibility: {
      kind: "open",
      walletCap: 1000n,
      maxParticipants: 1000n,
      minCommitment: 1n,
    },
    uncapped: null,
    hard_cap: null,
    venue: `${REWARD_PACKAGE}::venue::Venue`,
    fee_split: { routes: [{ destination: { kind: "HolderRewards" }, bps: 10000n }] },
    protocol_raise_bps: 0n,
    protocol_token_bps: 0n,
    protocol_lp_fee_meme_bps: 0n,
    protocol_lp_fee_quote_bps: 0n,
    protocol_quote: 0n,
    protocol_tokens: 0n,
    ...overrides,
  };
  return {
    eventType: `${REWARD_PACKAGE}::${presaleEventModules.PresaleCreated}::PresaleCreated<${coin}, ${rewardAddress(2)}::sui::SUI>`,
    bcs: Buffer.from(
      presaleEventBcs.PresaleCreated.serialize(payload).toBytes(),
    ).toString("base64"),
  };
}
