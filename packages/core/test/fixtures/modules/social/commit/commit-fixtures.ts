import type { ClientWithCoreApi } from "@mysten/sui/client";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";

import type { PresaleRuntimeIdentity } from "../../../../../src/modules/presale/deployment/contracts.ts";

/**
 * The server-built commit's test doubles, for unit and integration tests only
 * — never imported by application code: a Core API client that answers the
 * three reads the commit route's chain makes (the sale's object, the wallet's
 * balance and its coins) from maps the test fills, so the route builds the
 * real SDK commit with the real `createCommitChain` and nothing reaches a
 * network. The identity is the claim's (`claimTestIdentity`: a mainnet
 * identity of fixture ids).
 */

export type StubCoin = Readonly<{ objectId: string; version: string; digest: string; balance: string }>;

import { presaleContent } from "../../presale/allowlists/fixtures.ts";
import type { EligibilityPolicy } from "@interest-protocol/blast-sdk/presale";

export type StubCommitCore = Readonly<{
  client: ClientWithCoreApi;
  /** Shared `Presale<S, Q>` objects by id, of the identity's package unless `packageId` names another; any other id is no object. */
  presales: Map<string, Readonly<{ saleToken: string; quote: string; initialSharedVersion: string; packageId?: string; eligibility?: EligibilityPolicy }>>;
  /** Owned coins by `<owner>|<coin type>` (both normalized). */
  coins: Map<string, StubCoin[]>;
  /** Address balances (Sui's per-address funds, outside any coin object) by `<owner>|<coin type>`. */
  addressBalances: Map<string, bigint>;
  /** Every node call rejects while true. */
  state: { down: boolean };
  calls: { getObjects: number; getBalance: number; listCoins: number };
}>;

const keyOf = (owner: string, coinType: string) => `${normalizeSuiAddress(owner)}|${normalizeStructTag(coinType)}`;

/** One owned coin, with an id and digest derived from `seed` (a digest is any 32 bytes in base58). */
export function stubCoin(seed: number, balance: bigint | string): StubCoin {
  return {
    objectId: normalizeSuiAddress(`0x${seed.toString(16).padStart(4, "0")}c011`),
    version: String(100 + seed),
    digest: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
    balance: String(balance),
  };
}

export function stubCommitCore(identity: PresaleRuntimeIdentity): StubCommitCore {
  const presales: StubCommitCore["presales"] = new Map();
  const coins: StubCommitCore["coins"] = new Map();
  const addressBalances: StubCommitCore["addressBalances"] = new Map();
  const state = { down: false };
  const calls = { getObjects: 0, getBalance: 0, listCoins: 0 };
  const original = normalizeSuiAddress(identity.presale.originalPackageId);
  const fail = () => {
    if (state.down) throw new Error("UNAVAILABLE");
  };
  const core = {
    async getObjects({ objectIds }: { objectIds: string[] }) {
      calls.getObjects += 1;
      fail();
      return {
        objects: objectIds.map((id) => {
          const sale = presales.get(normalizeSuiAddress(id));
          if (!sale) return new Error(`object ${id} not found`);
          return {
            objectId: normalizeSuiAddress(id),
            version: "9000",
            content: presaleContent(id, sale.eligibility ?? { kind: "open", minCommitment: 1n, maxParticipants: 100n, walletCap: 1000000n }),
            digest: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
            type: `${sale.packageId ? normalizeSuiAddress(sale.packageId) : original}::blast_presale::Presale<${normalizeStructTag(sale.saleToken)}, ${normalizeStructTag(sale.quote)}>`,
            owner: { $kind: "Shared", Shared: { initialSharedVersion: sale.initialSharedVersion } },
          };
        }),
      };
    },
    async getBalance({ owner, coinType }: { owner: string; coinType: string }) {
      calls.getBalance += 1;
      fail();
      const held = (coins.get(keyOf(owner, coinType)) ?? []).reduce((sum, coin) => sum + BigInt(coin.balance), 0n);
      const address = addressBalances.get(keyOf(owner, coinType)) ?? 0n;
      return {
        balance: { coinType: normalizeStructTag(coinType), balance: String(held + address), coinBalance: String(held), addressBalance: String(address) },
      };
    },
    async listCoins({ owner, coinType }: { owner: string; coinType: string }) {
      calls.listCoins += 1;
      fail();
      const objects = (coins.get(keyOf(owner, coinType)) ?? []).map((coin) => ({
        ...coin,
        type: `0x2::coin::Coin<${normalizeStructTag(coinType)}>`,
        owner: { $kind: "AddressOwner", AddressOwner: normalizeSuiAddress(owner) },
      }));
      return { objects, hasNextPage: false, cursor: null };
    },
  };
  return { client: { core } as unknown as ClientWithCoreApi, presales, coins, addressBalances, state, calls };
}

/** Gives `owner` an address balance of `coinType` on the stub (R3-41: SUI held outside any coin object). */
export function holdAddressBalance(core: StubCommitCore, owner: string, coinType: string, atoms: bigint): void {
  core.addressBalances.set(keyOf(owner, coinType), atoms);
}

/** Gives `owner` these coins of `coinType` on the stub. */
export function holdCoins(core: StubCommitCore, owner: string, coinType: string, held: readonly StubCoin[]): void {
  core.coins.set(keyOf(owner, coinType), [...held]);
}
