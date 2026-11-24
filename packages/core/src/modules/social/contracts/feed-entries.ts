/**
 * The names `social_feed_entries` (migration 0055) and `social_wallet_owners`
 * (0054) publish. Creation announcements additionally use verified draft publications
 * (0110), without their private creator identity. An entry id is derived from sale or chain identity and never
 * changes, so social records keep referring to it across indexer rebuilds.
 *
 * `SHOWN_FEED_ENTRIES` in the social read model filters incomplete and hidden
 * sales inside the source, before callers page or order the union.
 */

export const FEED_ENTRY_SOURCES = ["activity", "lifecycle", "milestone"] as const;
export type FeedEntrySource = (typeof FEED_ENTRY_SOURCES)[number];

/**
 * Activity kinds blast-infra publishes today. The set is open: an activity
 * entry's kind is `chain_read_v1.activity.kind` unchanged, so readers must
 * accept a kind they do not know.
 */
export const KNOWN_ACTIVITY_KINDS = [
  "presale_commit",
  "presale_claim",
  "trade_buy",
  "trade_sell",
  "launch_buy",
  "launch_sell",
  "boost_mint",
  "boost_redeem",
] as const;

export const PRESALE_LIFECYCLE_STATES = ["created", "opened", "funded", "migrated", "cancelled"] as const;
export type PresaleLifecycleState = (typeof PRESALE_LIFECYCLE_STATES)[number];

/** A lifecycle entry's kind is `presale_<state>`. */
export const LIFECYCLE_ENTRY_KINDS = ["presale_created", "presale_opened", "presale_funded", "presale_migrated", "presale_cancelled"] as const;

export const MILESTONE_KINDS = ["participants", "raise", "holders"] as const;
export type MilestoneKind = (typeof MILESTONE_KINDS)[number];

/** A milestone entry's kind is `milestone_<kind>`. */
export const MILESTONE_ENTRY_KINDS = ["milestone_participants", "milestone_raise", "milestone_holders"] as const;

/** `a:<checkpoint>:<tx_slot>:<event_slot>:<part>`. */
export function activityEntryId(activityId: string): string {
  return `a:${activityId}`;
}

/** `l:<presale_id>:<state>`. */
export function lifecycleEntryId(presaleId: string, state: PresaleLifecycleState): string {
  return `l:${presaleId}:${state}`;
}

/** `m:<presale_id>:<kind>:<value>`, with `value` as PostgreSQL renders the numeric threshold. */
export function milestoneEntryId(presaleId: string, kind: MilestoneKind, value: string): string {
  return `m:${presaleId}:${kind}:${value}`;
}

/** Where `social_wallet_owners` found an address. */
export const WALLET_OWNER_SOURCES = ["mission_control", "presale_embedded", "social"] as const;
export type WalletOwnerSource = (typeof WALLET_OWNER_SOURCES)[number];
