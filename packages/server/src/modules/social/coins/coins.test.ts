import assert from "node:assert/strict";
import test from "node:test";
import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";

import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { MemoryRateLimiter } from "@blast/core/modules/web-security/route-limits.ts";
import { SOCIAL_WALLET_PATH, socialWalletCoinSchema } from "@blast/core/modules/social/contracts/coins.ts";
import { coinLabel } from "@blast/core/modules/social/contracts/financial-wire.ts";
import { socialTradeCoinSchema } from "@blast/core/modules/social/contracts/trades.ts";
import { PREFERRED_COINS } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { PORTFOLIO_COIN_TYPES } from "@blast/core/modules/social/portfolio/read.ts";
import { createSocialCoinsRoutes } from "@blast/server/modules/social/coins/route.ts";
import { transferVerdict, type TransferRow } from "@blast/server/modules/social/coins/transfers.ts";
import { readOwnerBalances, walletCoins, wireWalletCoin, type CoinsFullnode } from "@blast/server/modules/social/coins/wallet.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { wireTradeCoin } from "@blast/server/modules/social/trades/coin-list.ts";

/** Social feed UI-14: the coins sheet's pure server parts. */

const SENDER = `0x${"1a".repeat(32)}`;
const RECIPIENT = `0x${"a3".repeat(32)}`;
const USDC = PORTFOLIO_COIN_TYPES.usdc;
const QUOTE = `0x${"0".repeat(63)}3::usd::USD`;
const ROW: Pick<TransferRow, "sender" | "recipient" | "coin_type" | "amount"> = { sender: SENDER, recipient: RECIPIENT, coin_type: USDC, amount: "100000000" };

test("the authenticated exact wallet route distinguishes balance, zero and read failure without a wallet listing", async () => {
  const origin = "https://blast.fun";
  const now = 1_790_000_000_000;
  let address: string | null = SENDER;
  let value = "95240600";
  let exactReads = 0;
  let listingReads = 0;
  let metadataReads = 0;
  const started = Promise.withResolvers<void>();
  const down = () => { throw new Error("Unavailable"); };
  const routes = createSocialCoinsRoutes({
    kit: createSocialRouteKit({
      expectedOrigin: origin,
      verifyAccessToken: async () => ({ appId: "test", expiration: now + 1000, issuedAt: now, issuer: "privy.io", sessionId: "test", userId: "did:privy:wallet-test" }),
      accounts: {
        resolve: async () => ({ account_id: "00000000-0000-4000-8000-000000000001", kind: "new", callsign: "wallet_test", display_name: null, avatar_url: null, x_handle: null, verified: false, onboarding: { shown: false, completed: false }, privacy: "public", sharing_since_ms: null }),
        resolveWallet: async () => null,
      },
      limiter: new MemoryRateLimiter(),
      tradingVisible: () => true,
      primary: down,
      metricSampleRate: 0,
    }),
    blastWallet: async () => address,
    database: () => { metadataReads += 1; return down(); },
    fullnode: () => ({
      async listBalances() { listingReads += 1; return down(); },
      async getBalance(input) {
        exactReads += 1;
        assert.equal(input.owner, SENDER);
        assert.equal(input.coinType, QUOTE);
        assert.ok(input.signal);
        if (value === "offline") return down();
        if (value === "wait") {
          const { signal } = input;
          return new Promise<never>((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            started.resolve();
          });
        }
        return { balance: { balance: value } };
      },
    }),
    transactions: down,
    now: () => now,
  });
  const read = (query: string, token = "test", signal?: AbortSignal) => routes.wallet(new Request(`${origin}${SOCIAL_WALLET_PATH}?${query}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal,
  }), testClient());
  const query = `balance_coin=${encodeURIComponent(QUOTE)}`;
  assert.equal((await read(query, "")).status, 401);
  for (const bad of [`${query}&page=1`, `${query}&${query}`, "balance_coin=0x3::usd::USD", `identity=1&${query}`, "identity=2", "identity=1&page=1"]) {
    assert.equal((await read(bad)).status, 400);
  }
  const identity = await read("identity=1");
  assert.equal(identity.status, 200);
  assert.deepEqual(await identity.json(), { address: SENDER, signer: "privy", fee: "sponsored", coins: null, as_of_ms: now });
  const balance = await read(query);
  assert.equal(balance.headers.get("cache-control"), "private, no-store");
  assert.equal(balance.status, 200);
  assert.deepEqual(await balance.json(), { address: SENDER, coin_type: QUOTE, atoms: "95240600", as_of_ms: now });
  value = "0";
  assert.equal((await (await read(query)).json()).atoms, "0");
  for (value of ["offline", "bad-atoms"]) {
    const failure = await read(query);
    assert.equal(failure.status, 503);
    assert.equal((await failure.json()).error.code, "service_unavailable");
  }
  value = "wait";
  const controller = new AbortController();
  const cancelled = read(query, "test", controller.signal);
  await started.promise;
  controller.abort();
  assert.equal((await cancelled).status, 503);
  address = null;
  const missing = await read(query);
  assert.equal(missing.status, 409);
  assert.equal((await missing.json()).error.code, "blast_wallet_missing");
  assert.equal(exactReads, 5);
  assert.equal(listingReads, 0);
  assert.equal(metadataReads, 0);
});

test("a withdrawal is confirmed only when the Blast wallet sent exactly the amount of the coin to the recipient", () => {
  const changes = [
    { address: SENDER, coinType: USDC, amount: "-100000000" },
    { address: RECIPIENT, coinType: USDC, amount: "100000000" },
  ];
  assert.deepEqual(transferVerdict(ROW, { success: true, sender: SENDER, balanceChanges: changes }), { status: "confirmed" });
  // Short forms of the same address and coin type are the same.
  assert.deepEqual(
    transferVerdict(ROW, { success: true, sender: SENDER, balanceChanges: [{ address: RECIPIENT, coinType: USDC.replace(/^0x0+/, "0x"), amount: "100000000" }] }),
    { status: "confirmed" },
  );
  for (const [label, executed] of [
    ["another sender", { success: true, sender: RECIPIENT, balanceChanges: changes }],
    ["another amount", { success: true, sender: SENDER, balanceChanges: [{ address: RECIPIENT, coinType: USDC, amount: "99999999" }] }],
    ["another coin", { success: true, sender: SENDER, balanceChanges: [{ address: RECIPIENT, coinType: "0x2::sui::SUI", amount: "100000000" }] }],
    ["another recipient", { success: true, sender: SENDER, balanceChanges: [{ address: SENDER, coinType: USDC, amount: "100000000" }] }],
  ] as const) {
    assert.deepEqual(transferVerdict(ROW, executed), { status: "failed", failure: "mismatch" }, label);
  }
  assert.deepEqual(transferVerdict(ROW, { success: false, sender: SENDER, balanceChanges: [] }), { status: "failed", failure: "execution_failed" });
  // An aborted transaction from someone else is still not this withdrawal.
  assert.deepEqual(transferVerdict(ROW, { success: false, sender: RECIPIENT, balanceChanges: [] }), { status: "failed", failure: "mismatch" });
});

test("wallet listings reconcile repeated coin types against exact totals across pages", async () => {
  const pages = [
    { balances: [{ coinType: "0x2::sui::SUI", balance: "5" }, { coinType: USDC, balance: "7" }, { coinType: QUOTE, balance: "95240600" }], hasNextPage: true, cursor: "next" },
    { balances: [{ coinType: PORTFOLIO_COIN_TYPES.sui, balance: "1" }, { coinType: "not a type", balance: "3" }, { coinType: "0x3::usd::USD", balance: "110000000" }], hasNextPage: false, cursor: null },
  ];
  const seen: (string | null | undefined)[] = [];
  const exact: Record<string, string> = { [PORTFOLIO_COIN_TYPES.sui]: "6", [USDC]: "7", [QUOTE]: "95240600" };
  const fullnode: CoinsFullnode = {
    async listBalances({ cursor }) {
      seen.push(cursor);
      return pages[cursor ? 1 : 0]!;
    },
    getBalance: async ({ coinType }) => ({ balance: { balance: exact[coinType] ?? "0" } }),
  };
  const balances = await readOwnerBalances(fullnode, SENDER);
  assert.deepEqual(seen, [null, "next"]);
  assert.deepEqual([...balances.entries()], [[PORTFOLIO_COIN_TYPES.sui, 6n], [USDC, 7n], [QUOTE, 95_240_600n]]);
  // A wallet with more coin types than the pages reach: USDC still reads exactly.
  const crowded: CoinsFullnode = {
    listBalances: async () => ({ balances: [], hasNextPage: false, cursor: null }),
    getBalance: async ({ coinType }) => ({ balance: { balance: coinType === USDC ? "4235738656" : "0" } }),
  };
  assert.equal((await readOwnerBalances(crowded, SENDER)).get(USDC), 4_235_738_656n);

  const malformed: CoinsFullnode = {
    listBalances: async () => ({ balances: [{ coinType: USDC, balance: "-1" }], hasNextPage: false, cursor: null }),
    getBalance: async () => ({ balance: { balance: "0" } }),
  };
  await assert.rejects(readOwnerBalances(malformed, SENDER), /malformed/);
  const hung: CoinsFullnode = {
    listBalances: ({ signal }) => new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    getBalance: async () => ({ balance: { balance: "0" } }),
  };
  await assert.rejects(readOwnerBalances(hung, SENDER, 20), /in time/);
});

test("wallet balances include coins beyond four pages and reject a stalled cursor rather than return a partial list", async () => {
  let pages = 0;
  const deep = `0x${"9".repeat(64)}::deep::DEEP`;
  const fullnode: CoinsFullnode = {
    async listBalances() {
      pages += 1;
      return { balances: pages === 5 ? [{ coinType: deep, balance: "123456789" }] : [], hasNextPage: pages < 5, cursor: String(pages) };
    },
    getBalance: async () => ({ balance: { balance: "0" } }),
  };
  assert.equal((await readOwnerBalances(fullnode, SENDER)).get(deep), 123_456_789n);
  assert.equal(pages, 5);
  fullnode.listBalances = async () => ({ balances: [], hasNextPage: true, cursor: "same" });
  await assert.rejects(readOwnerBalances(fullnode, SENDER), /non-progressing/);
  fullnode.listBalances = async () => ({ balances: [], hasNextPage: true, cursor: null });
  await assert.rejects(readOwnerBalances(fullnode, SENDER), /non-progressing/);
});

test("wallet timeout retains ownership until every aborted balance branch settles", async () => {
  const finish: Array<() => void> = [];
  const delayedAbort = (signal?: AbortSignal) => new Promise<never>((_, reject) => {
    signal?.addEventListener("abort", () => finish.push(() => reject(new Error("aborted"))), { once: true });
  });
  const fullnode: CoinsFullnode = {
    listBalances: ({ signal }) => delayedAbort(signal),
    getBalance: ({ signal }) => delayedAbort(signal),
  };
  let settled = false;
  const result = readOwnerBalances(fullnode, SENDER, 10).finally(() => { settled = true; });
  const rejected = assert.rejects(result, /in time/);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(finish.length, 3);
  assert.equal(settled, false);
  finish[0]!(); finish[1]!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(settled, false);
  finish[2]!();
  await rejected;
  assert.equal(settled, true);
});

test("any coin metadata keeps the wallet readable: long logos dropped, text cut or replaced", async () => {
  // Many Sui memecoins store their logo inline as a data: image of 6,000-26,000 characters.
  const inline = `data:image/png;base64,${"A".repeat(20_000)}`;
  const whale = "0x0e58300249d61b62d4b0639b9992d24adb57e4164859efa17ba33b7b2020f92a::whale::WHALE";
  const wal = "0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL";
  const usdsui = PREFERRED_COINS.find((coin) => coin.symbol === "USDsui")!;
  const odd = "0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809::odd::ODD";
  const huge = "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::huge::HUGE";
  const metadata = [
    { coin_type: whale, name: "Whale", symbol: "WHALE", decimals: 9, icon_url: inline, is_presale: false },
    // Metadata is whatever the publisher wrote: empty, or thousands of emoji.
    { coin_type: odd, name: "", symbol: "", decimals: 0, icon_url: "", is_presale: false },
    { coin_type: huge, name: "🐳".repeat(5_000), symbol: "🐳".repeat(5_000), decimals: 255, icon_url: null, is_presale: false },
    { coin_type: wal, name: "Walrus", symbol: "WAL", decimals: 9, icon_url: "https://i.blast.test/wal.png", is_presale: false },
    { coin_type: usdsui.coinType, name: "USDsui", symbol: "USDsui", decimals: 6, icon_url: inline, is_presale: false },
  ];
  const db = { read: async (sql: string) => ({ rows: sql.includes("coin_metadata m") ? metadata : [] }) } as unknown as ReadableDatabase;
  const coins = await walletCoins(db, new Map([[whale, 897_191_719_172n], [wal, 69_959_136n], [usdsui.coinType, 1_000_000n], [odd, 1n], [huge, 1n]]), 0);
  for (const coin of coins) assert.equal(socialWalletCoinSchema.safeParse(coin).success, true, coin.coin_type);
  const labels = new Map(coins.map(({ coin_type, symbol, name }) => [coin_type, [symbol, name]]));
  assert.deepEqual([labels.get(odd), labels.get(huge)], [["ODD", "ODD"], ["🐳".repeat(32), "🐳".repeat(64)]]);
  assert.equal(coins.find((coin) => coin.coin_type === whale)?.icon_url, null);
  assert.equal(coins.find((coin) => coin.coin_type === wal)?.icon_url, "https://i.blast.test/wal.png");
  // A curated coin falls back to its curated logo.
  assert.equal(coins.find((coin) => coin.coin_type === usdsui.coinType)?.icon_url, usdsui.logoUrl);
});

test("a held coin type the wire cannot carry is left out instead of failing the wallet read", async () => {
  const long = `0x${"1".repeat(64)}::lp::LP<${Array.from({ length: 6 }, (_, i) => `0x${String(i).repeat(64)}::coin::COIN`).join(", ")}>`;
  const fullnode: CoinsFullnode = {
    listBalances: async () => ({ balances: [{ coinType: long, balance: "5" }], hasNextPage: false, cursor: null }),
    getBalance: async () => ({ balance: { balance: "0" } }),
  };
  assert.equal([...(await readOwnerBalances(fullnode, SENDER)).keys()].some((type) => type.includes("::lp::LP")), false);
});

test("every field the wire rejects is repaired, or the coin alone is left out, in the wallet and the swap picker", () => {
  const type = "0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809::odd::ODD";
  const wallet = { coin_type: type, symbol: "ODD", name: "Odd", decimals: 9, atoms: "1", usd_price: "1", value_usd: "0.00", icon_url: null, presale: null };
  assert.deepEqual(wireWalletCoin(wallet), wallet);
  // Decimals outside a u8 take the price with them; a price or value off the decimal format becomes none.
  assert.deepEqual(wireWalletCoin({ ...wallet, decimals: 300 }), { ...wallet, decimals: null, usd_price: null, value_usd: null });
  assert.deepEqual(wireWalletCoin({ ...wallet, usd_price: "1e-7" }), { ...wallet, usd_price: null, value_usd: null });
  assert.deepEqual(wireWalletCoin({ ...wallet, value_usd: "-1.00" }), { ...wallet, usd_price: null, value_usd: null });
  assert.deepEqual(wireWalletCoin({ ...wallet, presale: { presale_id: "0x1", venue: "v".repeat(33), trading: true, multiple: null } }), wallet);
  assert.deepEqual(wireWalletCoin({ ...wallet, icon_url: "x".repeat(2_049) }), wallet);
  // An off-format presale multiple drops alone, keeping the coin's presale link.
  const presale = { presale_id: `0x${"a".repeat(64)}`, venue: "cetus", trading: true, multiple: "1e+21" };
  assert.deepEqual(wireWalletCoin({ ...wallet, presale }), { ...wallet, presale: { ...presale, multiple: null } });
  assert.deepEqual(wireWalletCoin({ ...wallet, symbol: "   ", name: "\t" }), { ...wallet, name: "ODD" });
  // Atoms or a type the wire cannot carry: that coin is left out.
  assert.equal(wireWalletCoin({ ...wallet, atoms: "1".repeat(21) }), null);
  assert.equal(wireWalletCoin({ ...wallet, coin_type: "not a type" }), null);

  const trade = { coin_type: type, symbol: "ODD", name: "Odd", decimals: 9, icon_url: null, usd_price: "1", presale_id: null };
  assert.deepEqual(wireTradeCoin(trade), trade);
  assert.deepEqual(wireTradeCoin({ ...trade, symbol: "", name: "", icon_url: "x".repeat(2_049), usd_price: "NaN" }), { ...trade, name: "ODD", usd_price: null });
  const long = wireTradeCoin({ ...trade, symbol: "🐳".repeat(500), name: "🐳".repeat(500) });
  assert.deepEqual([long?.symbol, long?.name], ["🐳".repeat(64), "🐳".repeat(128)]);
  assert.equal(socialTradeCoinSchema.safeParse(long).success, true);
  assert.equal(wireTradeCoin({ ...trade, decimals: 256 }), null);
});

test("a coin published with an empty symbol or name still shows one on every read", () => {
  const coinType = "0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809::odd::ODD<0x2::sui::SUI>";
  assert.deepEqual(coinLabel({ coinType, symbol: "", name: "" }), { symbol: "ODD", name: "ODD" });
  assert.deepEqual(coinLabel({ coinType, symbol: "", name: "Odd" }), { symbol: "ODD", name: "Odd" });
  assert.deepEqual(coinLabel({ coinType, symbol: "OD", name: null }), { symbol: "OD", name: "OD" });
});
