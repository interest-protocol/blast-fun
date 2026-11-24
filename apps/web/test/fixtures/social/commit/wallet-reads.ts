import { FIXTURE_WALLET_ADDRESS } from "../coins/coins-fixture-model.ts";

import type { SocialWallet } from "@blast/core/modules/social/contracts/coins.ts";
import type { WalletCoinView } from "#web/components/social/coins/coin-model.ts";

/**
 * A stand-in for `GET /api/social/me/wallet` for the commit suites: the wallet the You pay panel reads
 * a fresh balance from. **Tests only**: nothing outside a `*.test.ts(x)` imports this file.
 *
 * `wrap(inner)` answers wallet reads from `state.coins` and hands every other URL to `inner`. Each
 * answer carries a rising `as_of_ms`, so a test can change `state.coins` (a balance that moved while
 * the panel was open) and see the next read replace the shown balance. `state.hold` parks the next
 * reads until it resolves; `state.fail` answers 503.
 */
export const WALLET_ADDRESS = FIXTURE_WALLET_ADDRESS;

/** The viewer's access token source: the balance read signs in with it, as it does in the app. */
export const ACCESS_TOKEN = async () => "test-access-token";

type Fetch = typeof globalThis.fetch;

export type WalletReads = Readonly<{
  state: { coins: readonly WalletCoinView[]; address: string; fail: boolean; hold: Promise<void> | null; asOfMs: number; reads: string[] };
  wrap: (inner?: Fetch) => Fetch;
}>;

function wire(coin: WalletCoinView) {
  return {
    coin_type: coin.coinType,
    name: coin.name,
    symbol: coin.symbol,
    decimals: coin.decimals,
    atoms: coin.atoms.toString(),
    usd_price: coin.price === null ? null : String(coin.price),
    value_usd: "0.00",
    icon_url: coin.iconUrl,
    presale: null,
  };
}

export function walletReads(coins: readonly WalletCoinView[], address: string = WALLET_ADDRESS): WalletReads {
  const state: WalletReads["state"] = { coins, address, fail: false, hold: null, asOfMs: Date.now(), reads: [] };
  const answer = async (path: string): Promise<Response> => {
    state.reads.push(path);
    const hold = state.hold;
    if (hold) await hold;
    if (state.fail) return Response.json({}, { status: 503 });
    state.asOfMs += 1;
    const params = new URL(path, "https://blast.test").searchParams;
    const body = { address: state.address, signer: "wallet", fee: "wallet", as_of_ms: state.asOfMs };
    if (params.has("identity")) return Response.json({ ...body, coins: null });
    const coinType = params.get("balance_coin");
    if (coinType !== null) {
      const atoms = state.coins.find((coin) => coin.coinType === coinType)?.atoms ?? 0n;
      return Response.json({ address: body.address, coin_type: coinType, atoms: atoms.toString(), as_of_ms: body.as_of_ms });
    }
    // Without `page` the whole wallet answers; with it, the route's own shape: one page of matches plus the asked-for `keys` apart.
    if (!params.has("page")) return Response.json({ ...body, coins: state.coins.map(wire) });
    const search = (params.get("q") ?? "").trim().toLowerCase();
    const asked = new Set(JSON.parse(params.get("keys") ?? "[]") as string[]);
    const matches = state.coins.filter((coin) => [coin.name, coin.symbol, coin.coinType].some((text) => text.toLowerCase().includes(search)));
    const page = Number(params.get("page"));
    return Response.json({
      ...body,
      coins: matches.slice((page - 1) * 20, page * 20).map(wire),
      listing: { page, page_size: 20, total: matches.length, value_usd: "0.00", extra_coins: state.coins.filter((coin) => asked.has(coin.coinType)).map(wire) },
    });
  };
  const wrap = (inner?: Fetch): Fetch => async (input, init) => {
    const path = String(input);
    if (path.startsWith("/api/social/me/wallet")) return answer(path);
    return inner ? inner(input, init) : Response.json({}, { status: 404 });
  };
  return { state, wrap };
}

/**
 * Installs a wallet read stand-in for the whole test file (each file runs in its own process): wallet reads
 * answer from the returned `state.coins`, every other request goes on to the fetch that was there.
 */
export function installWalletReads(coins: readonly WalletCoinView[], address: string = WALLET_ADDRESS): WalletReads {
  const reads = walletReads(coins, address);
  globalThis.fetch = reads.wrap(globalThis.fetch);
  return reads;
}

/** The Blast wallet a commit read reports (`facts.wallet`): the address the fresh balance read is for. */
export const WALLET_FACTS: SocialWallet = Object.freeze({ address: WALLET_ADDRESS, signer: "wallet", fee: "wallet", coins: null, as_of_ms: 0 });
