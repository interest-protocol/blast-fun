import type { Venue } from "@interest-protocol/blast-sdk/deployments";
import type { EligibilityPolicy, PresaleEventPayloads } from "@interest-protocol/blast-sdk/presale";

/**
 * How the presale contract puts SDK values on the wire (interface contract
 * rev 2, CL-11 and CL-13). A wire type takes its field types from the SDK
 * name it mirrors through `Wire`, so no SDK-named field is redefined here:
 *
 * - camelCase SDK keys become snake_case (`walletCap` → `wallet_cap`);
 * - an on-chain u64 (`bigint`) becomes an unsigned decimal string;
 * - a `*_ms` or checkpoint field is a JSON integer instead.
 */

/** An on-chain u64 (atoms, bps, counts, indexes) as a decimal string. */
export type DecimalString = `${bigint}`;
/** `0x` and 64 lowercase hex characters. */
export type Address = string;
/** A Sui object ID, in address form. */
export type ObjectId = Address;
/** A canonical coin type, `0x<64 hex>::<module>::<Name>`. */
export type CoinType = string;
/** A Sui transaction digest (base58). */
export type TransactionDigest = string;
/** 32 bytes as 64 lowercase hex characters without `0x` (allowlist and reward roots, proof entries). */
export type Hex32 = string;
/** A blast-infra event cursor, `<checkpoint>:<tx_slot>:<event_slot>:<part>` (CL-12); opaque to clients. */
export type EventCursor = string;
/** An opaque page token: the next page's `before` or `cursor`. */
export type PageCursor = string;
export type TimestampMs = number;
export type Checkpoint = number;
/** A count of off-chain things (wallets, rows, entries), as a JSON integer. */
export type Count = number;

type SnakeCase<Key extends string> = Key extends `${infer Head}${infer Tail}`
  ? `${Head extends Lowercase<Head> ? Head : `_${Lowercase<Head>}`}${SnakeCase<Tail>}`
  : Key;
type IntegerField = `${string}_ms` | `${string}checkpoint`;
type WireValue<Key, Value> = Value extends bigint
  ? Key extends IntegerField
    ? number
    : DecimalString
  : Value extends readonly bigint[]
    ? DecimalString[]
    : Value;

/** `T` as the wire carries it: snake_case keys, u64 as decimal strings, `*_ms` and checkpoints as integers. */
export type Wire<T> = {
  -readonly [Key in keyof T as Key extends string ? SnakeCase<Key> : Key]: WireValue<
    Key extends string ? SnakeCase<Key> : Key,
    T[Key]
  >;
};

/** The wire form of `fields` of an SDK type. */
export type WirePick<T, Field extends keyof T> = Wire<Pick<T, Field>>;

/** The wire form of `fields` of one decoded presale event's payload. */
export type EventFields<
  Kind extends keyof PresaleEventPayloads,
  Field extends keyof PresaleEventPayloads[Kind],
> = WirePick<PresaleEventPayloads[Kind], Field>;

/** Every field of `T` may also be null. */
export type Nullable<T> = { [Key in keyof T]: T[Key] | null };

export type PresaleId = PresaleEventPayloads["PresaleCreated"]["presale_id"];

/** The indexer's venue names, with the Aftermath DAO vendor shortened on the wire. */
export const PRESALE_VENUES = ["cetus", "bluefin", "aftermath"] as const satisfies readonly (Exclude<Venue, "aftermathDao"> | "aftermath")[];
export type PresaleVenue = (typeof PRESALE_VENUES)[number];
const everyVenueListed: [Exclude<Venue, Exclude<PresaleVenue, "aftermath"> | "aftermathDao">] extends [never] ? true : false = true;
void everyVenueListed;

/** Every SDK `EligibilityPolicy` kind, in schema order. */
export const PRESALE_ELIGIBILITY_KINDS = ["open", "allowlisted"] as const satisfies readonly EligibilityPolicy["kind"][];
// A new SDK eligibility kind fails typecheck here.
const everyEligibilityKindListed: [Exclude<EligibilityPolicy["kind"], (typeof PRESALE_ELIGIBILITY_KINDS)[number]>] extends [never]
  ? true
  : false = true;
void everyEligibilityKindListed;

/** The read path's position: every blast-infra 200 response and snapshot carries it. */
export type Freshness = { checkpoint: Checkpoint; timestamp_ms: TimestampMs; cursor: EventCursor };
