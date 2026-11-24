import { CORE_COINS, coreCoin } from "@blast/core/modules/social/portfolio/core-coins.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { socialWalletSchema, type SocialWallet, type SocialWalletCoin } from "@blast/core/modules/social/contracts/coins.ts";
import { PREFERRED_COINS } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { isSmallBalance } from "@blast/core/modules/social/portfolio/small-balance.ts";
import { walletCoinList, walletListParams } from "@blast/server/modules/social/coins/coin-list.ts";

const coins: SocialWalletCoin[] = Array.from({ length: 100 }, (_, index) => ({ coin_type: `0x${String(index).padStart(64, "0")}::coin::C${index}`, name: `Coin ${index}`, symbol: `C${index}`, atoms: "1000000000", decimals: 9, value_usd: `${index}.00`, usd_price: `${index}`, icon_url: null, presale: null }));
const wallet: SocialWallet = { coins, address: null, signer: "wallet", fee: "wallet", as_of_ms: 1 };
const params = (query = "") => walletListParams(`https://blast.test/api/social/me/wallet?page=1${query}`)!;

test("wallet paging sorts all holdings, searches unseen coins, and keeps global totals", () => {
  const first = walletCoinList(wallet, params());
  assert.equal(first.coins?.length, 20);
  assert.equal(first.coins?.[0]?.symbol, "C99");
  assert.equal(first.listing?.total, 100);
  assert.equal(first.listing?.value_usd, "4950.00");
  assert.equal(walletCoinList(wallet, params("&q=Coin%203")).coins?.some(coin => coin.symbol === "C3"), true);
  const last = walletCoinList(wallet, { ...params(), page: 999 });
  assert.equal(last.listing?.page, 5);
  assert.equal(last.coins?.at(-1)?.symbol, "C0");
  assert.equal(JSON.stringify(first).length < JSON.stringify(wallet).length / 3, true);
});

test("small-balance filter uses exact per-coin decimals, keeping unknown metadata and unchanged totals", () => {
  assert.equal(isSmallBalance("999999999", 9), true);
  assert.equal(isSmallBalance("1000000000", 9), false);
  assert.equal(isSmallBalance("999999", 6), true);
  assert.equal(isSmallBalance("1000000", 6), false);
  assert.equal(isSmallBalance("1", 0), false);
  assert.equal(isSmallBalance("1", null), false);
  const dust = { ...coins[0]!, atoms: "999999999", value_usd: "5000.00" };
  const unpriced = { ...coins[1]!, atoms: "1", decimals: null, value_usd: null };
  const read = walletCoinList({ ...wallet, coins: [dust, unpriced, coins[2]!] }, params("&hide_small=true"));
  assert.deepEqual(read.coins?.map(coin => coin.symbol), ["C2", "C1"]);
  assert.equal(read.listing?.value_usd, null);
  assert.equal(walletCoinList({ ...wallet, coins: [dust, coins[2]!] }, params("&hide_small=true")).listing?.value_usd, "5002.00");
});

test("wallet parameters reject malformed limits, oversized search and invalid boolean filters before a read", () => {
  for (const query of ["page=0", "page=1.5", "page=9999999999", "page=1&hide_small=1", "page=1&mode=public", `page=1&q=${"x".repeat(201)}`, "page=1&keys=oops"]) assert.throws(() => walletListParams(`https://blast.test/wallet?${query}`));
  assert.equal(walletListParams("https://blast.test/wallet"), null);
});


test("all canonical holdings stay visible below one coin and continue across bounded pages", () => {
  const core = CORE_COINS.map((coin, index) => ({ ...coins[0]!, coin_type: coin.coinType, name: coin.symbol === "vSUI" ? "Volo Staked Sui" : coin.symbol, symbol: coin.symbol === "vSUI" ? "CERT" : coin.symbol, atoms: "1", decimals: 9, value_usd: `${index}.00` }));
  const other = { ...coins[1]!, value_usd: "1000000.00" };
  const fake = { ...other, symbol: "USDC", atoms: "1" };
  const zero = { ...core[0]!, atoms: "0" };
  const listing = { ...wallet, coins: [...core.slice(1), zero, other, fake] };
  const first = walletCoinList(listing, params("&hide_small=true"));
  const later = Array.from({ length: Math.ceil((CORE_COINS.length + 1) / 20) - 1 }, (_, index) => walletCoinList(listing, { ...params("&hide_small=true"), page: index + 2 }).coins!);
  assert.equal(first.coins?.length, 20);
  assert.equal(first.listing?.total, CORE_COINS.length + 1);
  assert.equal(first.coins?.[0]?.coin_type, other.coin_type);
  assert.ok(first.coins?.slice(1).every(coin => coreCoin(coin.coin_type)));
  assert.ok(later.flat().every(coin => coreCoin(coin.coin_type)));
  assert.equal(new Set([...first.coins!, ...later.flat()].map(coin => coin.coin_type)).size, CORE_COINS.length + 1);
  assert.equal(walletCoinList({ ...wallet, coins: core }, params("&hide_small=true&q=vsui")).coins?.[0]?.coin_type, CORE_COINS.find(coin => coin.symbol === "vSUI")?.coinType);
  assert.equal(coreCoin("0x2::sui::SUI")?.symbol, "SUI");
  assert.equal(coreCoin("0x2::sui::sui"), undefined);
  assert.equal(coreCoin(fake.coin_type), undefined);
});


test("preferred coins follow USD ordering in every wallet mode", () => {
  const preferred = ["SUI", "USDC", "USDsui"].map((symbol, index) => ({
    ...coins[0]!, coin_type: CORE_COINS.find(coin => coin.symbol === symbol)!.coinType,
    symbol, value_usd: index === 0 ? null : `${index}.00`,
  }));
  const richCore = { ...coins[0]!, coin_type: CORE_COINS.find(coin => coin.symbol === "WAL")!.coinType, symbol: "WAL", value_usd: "999999.00" };
  const mixed = { ...wallet, coins: [...coins, richCore, ...preferred.toReversed()] };
  for (const mode of ["all", "deposit", "withdraw"]) {
    const page = walletCoinList(mixed, params(`&mode=${mode}`));
    assert.deepEqual(page.coins?.slice(0, 4).map(coin => coin.symbol), ["WAL", "C99", "C98", "C97"]);
    assert.deepEqual(page.listing?.extra_coins.map(coin => coin.symbol).sort(), ["SUI", "USDC", "USDsui"].sort());
  }
  assert.deepEqual(walletCoinList(mixed, params("&q=usd")).coins?.map(coin => coin.symbol), ["USDsui", "USDC"]);
});


test("USD sorting keeps exact cents, stable ties and unpriced core coins last", () => {
  const core = { ...coins[0]!, coin_type: CORE_COINS[0]!.coinType, value_usd: null };
  const lower = { ...coins[1]!, value_usd: "9007199254740992.00" };
  const higher = { ...coins[2]!, value_usd: "9007199254740992.01" };
  const tied = { ...coins[3]!, value_usd: higher.value_usd };
  const zero = { ...coins[4]!, value_usd: "0.00" };
  const input = [core, zero, tied, lower, higher];
  const read = walletCoinList({ ...wallet, coins: input }, params());
  assert.deepEqual(read.coins?.map(coin => coin.coin_type), [higher, tied, lower, zero, core].map(coin => coin.coin_type));
  assert.deepEqual(input, [core, zero, tied, lower, higher], "sorting leaves the wallet read untouched");
});

test("equal USD values use preferred and core identity before coin type", () => {
  const identities = ["SUI", "USDC", "USDsui", "WAL"].map(symbol => ({ ...coins[0]!, coin_type: CORE_COINS.find(coin => coin.symbol === symbol)!.coinType }));
  for (const value_usd of ["10.00", "0.00", null]) {
    const expected = [...identities, coins[0]!, coins[1]!].map(coin => ({ ...coin, value_usd }));
    assert.deepEqual(walletCoinList({ ...wallet, coins: expected.toReversed() }, params()).coins, expected);
  }
});

test("the preferred coins, the open coin and five favourites all fit the wallet answer", () => {
  const preferred = PREFERRED_COINS.map((coin): SocialWalletCoin => ({ ...coins[0]!, coin_type: coin.coinType, symbol: coin.symbol, name: coin.name }));
  const keys = JSON.stringify(coins.slice(1, 6).map((coin) => coin.coin_type));
  const list = walletCoinList({ ...wallet, coins: [...preferred, ...coins.slice(1)] }, params(`&key=${encodeURIComponent(coins[6]!.coin_type)}&keys=${encodeURIComponent(keys)}`));
  assert.equal(list.listing?.extra_coins.length, 9);
  assert.equal(socialWalletSchema.safeParse(list).success, true);
});
