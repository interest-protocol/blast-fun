import { groupedExact, numShortExact, atLeastPow10, type Exact } from "@blast/core/web/exact-amount.ts";
import { shortAddress } from "@blast/core/web/format.ts";
import { readablePrice } from "#web/lib/market-format.ts";
import type { SocialPresalePerson } from "@blast/core/web/contracts/presales.ts";
import { personIdentity, type ActorIdentity } from "../actor-identity";

/** A figure short enough for a row or headline: `1.25M` from a million, else two places (significant digits below one). */
export function readableExact(value: Exact, decimals: number) {
  if (atLeastPow10(value, 6)) return numShortExact(value);
  return readablePrice(groupedExact(value, decimals).replaceAll(",", ""));
}

/** A named account, or the wallet itself (short address, full one in the inspector); never an invented name. */
export function backerIdentity(account: SocialPresalePerson | null, wallet: string): ActorIdentity {
  return account ? personIdentity(account) : { kind: "wallet", address: wallet, short: shortAddress(wallet) };
}
