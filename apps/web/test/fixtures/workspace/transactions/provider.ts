import { bcs } from "@mysten/sui/bcs";
import { TransactionDataBuilder } from "@mysten/sui/transactions";
import { normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";
import type { SponsoredSigner } from "../../../../src/components/social/sponsored-transaction.ts";
import type { SocialTrade } from "@blast/core/modules/social/contracts/trades.ts";
import { fixtureTradeQuote, fixtureWallet } from "../../social/trade/trade-fixtures.ts";
import { presaleDetail, presaleId } from "../presale-fixtures";

/** Controlled API/signer/sponsor boundaries; the production host, kits and flows are never replaced. */
export function createTransactionProvider(changed: () => void = () => {}) {
  const baseWallet = fixtureWallet();
  const wallet = {
    ...baseWallet,
    as_of_ms: Date.now(),
    coins: baseWallet.coins?.map((coin, index) => ({
      ...coin,
      presale: coin.presale ? { ...coin.presale, presale_id: `0x${String(index + 1).repeat(64)}` } : null,
    })) ?? null,
  };
  const address = normalizeSuiAddress(wallet.address!);
  const baseDetail = presaleDetail();
  const detail = {
    ...baseDetail,
    presale: {
      ...baseDetail.presale,
      target_usd: "10000.00",
      raised_usd: "123.45",
      min_commitment_usd: "10.00",
      wallet_cap_usd: "5000.00",
    },
  };
  const quotes = new Map<string, ReturnType<typeof fixtureTradeQuote>>();
  const trades = new Map<string, SocialTrade>();
  const intents: { digest: string; status: string }[] = [];
  const writes: { path: string; authorization: string | null }[] = [];
  const counts = { builds: 0, signs: 0, executes: 0, settles: 0, intents: 0, moved: 0 };
  let mode: "confirmed" | "unknown" | "cancelled" = "confirmed";
  let release: (() => void) | undefined;
  let quoteNumber = 0;
  let commitBytes: Uint8Array;
  const update = () => changed();
  const bytes = () => bcs.TransactionData.serialize({ V1: {
    kind: { ProgrammableTransaction: { inputs: [], commands: [] } }, sender: address,
    gasData: { payment: [], owner: normalizeSuiAddress("0x5b"), price: 750n, budget: BigInt(2_000_000 + counts.builds) }, expiration: { None: true },
  } }).toBytes();
  const signer: SponsoredSigner = { fee: "sponsored", address, async signTransaction() {
    counts.signs++; update();
    if (mode === "cancelled") throw new Error("User rejected signing");
    return "c2lnbmF0dXJl";
  } };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const { pathname: path, searchParams } = new URL(String(input), "https://blast.test");
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (init?.method === "POST" && !path.endsWith("/viewer") && !path.endsWith("/quote")) writes.push({ path, authorization: new Headers(init.headers).get("authorization") });
    if (path.endsWith("/wallet")) return readWallet(searchParams);
    if (path.endsWith("/viewer")) return Response.json({ presales: {}, rows: null });
    if (path === `/api/social/presales/${presaleId}`) return Response.json(detail);
    if (path === "/api/social/trades/quote") {
      const quote = { ...fixtureTradeQuote(body, { signedIn: true, fee: "blast", nowMs: Date.now(), wallet }), quote_id: `q1.lifetime_quote_${String(++quoteNumber).padStart(16, "0")}`, slippage_bps: body.slippage_bps ?? 50 };
      quotes.set(quote.quote_id, quote);
      return Response.json(quote);
    }
    if (path === "/api/social/trades") return createTrade(body);
    if (path.endsWith("/settle")) return settle(path);
    if (path === "/api/social/me/commits") return createCommit(body);
    if (path.endsWith("/execute")) return execute(path);
    if (path === "/api/presale/sponsor") return Response.json({ reservation_id: "00000000-0000-4000-8000-000000000001", transaction_bytes: toBase64(commitBytes!), expires_at_ms: Date.now() + 60_000 });
    if (path === "/api/social/intents") {
      counts.intents++; intents.push({ digest: body.tx_digest, status: "pending" }); update();
      return Response.json({ status: "recorded", why: null });
    }
    return Response.json({});
  };
  function readWallet(params: URLSearchParams) {
    if (params.get("identity") === "1") return Response.json({ ...wallet, coins: null });
    const coinType = params.get("balance_coin");
    if (coinType === null) return Response.json(wallet);
    const atoms = wallet.coins?.find((coin) => coin.coin_type === coinType)?.atoms ?? "0";
    return Response.json({ address, coin_type: coinType, atoms, as_of_ms: Date.now() });
  }
  function createTrade(body: { quote_id: string }) {
      const quote = quotes.get(body.quote_id);
      if (!quote) return Response.json({ error: { code: "quote_expired" } }, { status: 400 });
      counts.builds++;
      const full = bytes();
      const trade: SocialTrade = { trade_id: `00000000-0000-4000-8000-${String(counts.builds).padStart(12, "0")}`, status: "built", side: quote.side, in_coin: quote.in_coin, out_coin: quote.out_coin, amount_in: quote.amount_in!, amount_out: quote.amount_out!, min_out: quote.min_out!, amount_out_filled: null, route_label: quote.route_label, network_fee: { payer: "blast", label: "Paid by Blast" }, reservation_id: `00000000-0000-4000-9000-${String(counts.builds).padStart(12, "0")}`, transaction_bytes: toBase64(full), digest: TransactionDataBuilder.getDigestFromBytes(full), expires_at_ms: Date.now() + 60_000, failure_code: null, created_at_ms: Date.now(), settled_at_ms: null };
      trades.set(trade.trade_id, trade); update();
      return Response.json(trade, { status: 201 });
    }
  function settle(path: string) {
      counts.settles++;
      const trade = trades.get(path.split("/").at(-2)!)!;
      const result: SocialTrade = mode === "unknown" ? trade : { ...trade, status: "confirmed", amount_out_filled: trade.amount_out, transaction_bytes: null, settled_at_ms: Date.now() };
      trades.set(trade.trade_id, result); update();
      return Response.json(result);
    }
  function createCommit(body: { amount: string }) {
      counts.builds++; commitBytes = bytes(); update();
      const kind = bcs.TransactionKind.serialize(bcs.TransactionData.parse(commitBytes).V1!.kind).toBytes();
      return Response.json({ presale_id: presaleId, sender: address, fee: "sponsored", route: "open", quote_type: detail.presale.quote_type, amount: body.amount, transaction_kind_bytes: toBase64(kind) });
    }
  async function execute(path: string) {
      counts.executes++; update();
      await new Promise<void>((resolve) => { release = resolve; });
      release = undefined;
      if (mode === "unknown") return Response.json({ error: { code: "execution_unconfirmed" } }, { status: 503 });
      for (const intent of intents) intent.status = "confirmed";
      update();
      return Response.json({ digest: path.includes("/00000000-0000-4000-8000-000000000001/") ? TransactionDataBuilder.getDigestFromBytes(commitBytes!) : [...trades.values()].at(-1)!.digest, effects: { status: "success" } });
    }
  return {
    fetch, signer: () => signer, wallet, detail, counts, trades, intents, writes,
    finish() { release?.(); },
    setMode(next: typeof mode) { mode = next; },
    moved() { counts.moved++; update(); },
  };
}
