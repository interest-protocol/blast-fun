import type { FeedItemActor } from "@blast/core/web/contracts/items.ts";
import type { SocialPresalePerson } from "@blast/core/web/contracts/presales.ts";

/** One person in a workspace row: a Blast account, or a wallet with no account. */
export type ActorIdentity =
  | Readonly<{ kind: "account"; callsign: string; name: string; avatarUrl: string | null; verified: boolean }>
  | Readonly<{ kind: "wallet"; address: string; short: string }>;

export type AvatarSize = 22 | 24 | 26 | 28 | 32 | 36;

export function actorIdentity(actor: FeedItemActor): ActorIdentity {
  return actor.type === "account"
    ? {
        kind: "account",
        callsign: actor.callsign,
        name: (actor.display_name ?? "").trim() || actor.callsign,
        avatarUrl: actor.avatar_url,
        verified: actor.verified,
      }
    : { kind: "wallet", address: actor.address, short: actor.short };
}

export function personIdentity(person: SocialPresalePerson): ActorIdentity {
  return {
    kind: "account",
    callsign: person.callsign,
    name: (person.display_name ?? "").trim() || person.callsign,
    avatarUrl: person.avatar_url,
    verified: person.verified,
  };
}

export function actorKey(identity: ActorIdentity): string {
  return identity.kind === "account" ? `a:${identity.callsign}` : `w:${identity.address}`;
}
