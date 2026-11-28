import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import test from "node:test";

import { bcs } from "@mysten/sui/bcs";
import { TransactionDataBuilder } from "@mysten/sui/transactions";
import { fromBase64, normalizeSuiAddress, toHex } from "@mysten/sui/utils";
import type { Pool } from "pg";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { rebuildChainRead } from "../../../../../core/test/fixtures/modules/database/chain-read-rows.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { createCachedCircleWithdraw, createCircleWithdrawIris } from "@blast/server/modules/presale/bridge/circle-withdraw.ts";
import { forwardHookData, SUI_CCTP_V2_MAINNET, withdrawMintRecipient, type WithdrawDestination } from "@blast/core/modules/presale/bridge/sui-burn.ts";
import type { BridgeWithdrawState } from "@blast/server/modules/presale/bridge/withdraw-activation.ts";
import { fixtureWithdrawIris, FIXTURE_FORWARDED_MESSAGE, SUI_CCTP_V2_IDENTITY } from "../../../../../core/test/fixtures/modules/presale/bridge/withdraw-fixtures.ts";
import { fixtureChainNode, SUI_MAINNET_CHAIN_IDENTIFIER } from "../../../../../core/test/fixtures/modules/presale/deployment/fixtures.ts";
import { createPresaleDeploymentGate } from "@blast/core/modules/presale/deployment/service.ts";
import { CAP, fixtureChain, identity, SPONSOR } from "../../../../test/fixtures/modules/sponsor/route-fixtures.ts";
import { KeyedSponsorRefusal, PostgresSponsorReservations } from "@blast/server/modules/sponsor/reservations.ts";
import { createSponsorService } from "@blast/server/modules/sponsor/service.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import {
  bridgeWithdrawMaxFee,
  SOCIAL_BRIDGE_WITHDRAW_PATH,
  SOCIAL_BRIDGE_WITHDRAW_QUOTE_PATH,
  socialBridgeWithdrawSettlePath,
  type SocialBridgeWithdrawal,
} from "@blast/core/modules/social/contracts/bridge-withdraw.ts";
import { SOCIAL_WALLET_SESSION_COOKIE } from "@blast/core/modules/social/contracts/wallet-sign-in.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { balanceKey, offlineTradeChain, simulationAbort, SUI, type OfflineChainOptions } from "../../../../test/fixtures/modules/social/trades/fixtures.ts";
import type { BridgeWithdrawSponsor } from "./route.ts";
import { createSocialBridgeWithdrawRoutes, type ExecutedBurn } from "@blast/server/modules/social/bridge-withdraw/route.ts";

/**
 * Withdraw to another chain over a disposable database, running as
 * `blast_web`: the withdrawal route with Circle's recorded mainnet fees, an
 * in-memory fullnode (balances, dry runs, executed burns) and the presale
 * sponsor's real service over its fixture gas pool, under an identity naming
 * Circle's CCTP V2 packages on Sui. An embedded Blast wallet is a Privy
 * session; a wallet session is Slush's cookie. Nothing reaches a network.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const APP_ID = "social-bridge-withdraw-app";
const PEPPER = "social-bridge-withdraw-fixture-pepper-0123";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const validator = createSocialValidator();
const POOL = { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 8, statementTimeoutMs: 10_000 };
const DID = "did:privy:presale-sponsor-alice";
const EMBEDDED = normalizeSuiAddress("0xe3b");
const SESSION_WALLET = normalizeSuiAddress("0x5e55");
const SESSION_TOKEN = "s".repeat(43);
const ACCOUNT = "00000000-0000-4000-8000-0000000b1ee0";
const SESSION_ACCOUNT = "00000000-0000-4000-8000-0000000b5e55";
const USDC = SUI_CCTP_V2_MAINNET.usdcType;
const EVM = `0x${"1e".repeat(20)}`;
const SOLANA_OWNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const LIVE: BridgeWithdrawState = { active: true, recordId: "1", ids: SUI_CCTP_V2_MAINNET, live: ["base", "arbitrum", "ethereum", "solana"] };
/** A raw fullnode error: it must never reach a response. */
const RAW_CHAIN_ERROR = "MoveAbort(MoveLocation { module: ModuleId { address: 0xdead } }, 7) secret-trace-1234";

function bearer(subject: string): string {
  const now = Math.floor(Date.now() / 1_000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: now + 3_600, iat: now - 60, iss: "privy.io", sid: "s-1", sub: subject });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `Bearer ${header}.${payload}.${signature.toString("base64url")}`;
}

/** `deposit_for_burn::DepositForBurn` as `complete_burn` emits it. */
const DepositForBurn = bcs.struct("DepositForBurn", {
  burn_token: bcs.Address,
  amount: bcs.u256(),
  depositor: bcs.Address,
  mint_recipient: bcs.Address,
  destination_domain: bcs.u32(),
  destination_token_messenger: bcs.Address,
  destination_caller: bcs.Address,
  max_fee: bcs.u256(),
  min_finality_threshold: bcs.u32(),
  hook_data: bcs.vector(bcs.u8()),
});
const DOMAINS: Record<WithdrawDestination, number> = { ethereum: 0, arbitrum: 3, solana: 5, base: 6 };

/** What Sui shows for an executed burn of `withdrawal` from `sender` (its event as Circle's package emits it). */
async function burned(withdrawal: SocialBridgeWithdrawal, sender: string, override: Partial<{ amount: bigint; mintRecipient: string }> = {}): Promise<ExecutedBurn> {
  const recipient = withdrawal.recipient;
  const event = DepositForBurn.serialize({
    burn_token: normalizeSuiAddress("0x3f2e28d163e25042ac7c9543c15675af5aa5d3c27dbc656a67f37f4293a3fdef"),
    amount: override.amount ?? BigInt(withdrawal.amount),
    depositor: sender,
    mint_recipient: override.mintRecipient ?? (await withdrawMintRecipient(withdrawal.destination, recipient)),
    destination_domain: DOMAINS[withdrawal.destination],
    destination_token_messenger: normalizeSuiAddress("0x28b5a0e9c621a5badaa536219b3a228c8168cf5d"),
    destination_caller: normalizeSuiAddress("0x0"),
    max_fee: BigInt(withdrawal.max_fee),
    min_finality_threshold: 2000,
    hook_data: Array.from(forwardHookData(withdrawal.destination, recipient)),
  }).toBytes();
  return { success: true, events: [{ eventType: `${SUI_CCTP_V2_MAINNET.tokenMessengerMinter}::deposit_for_burn::DepositForBurn`, bcs: event }] };
}

type As = "embedded" | "session";
type Fixture = Readonly<{
  admin: Pool;
  chain: ReturnType<typeof offlineTradeChain>;
  iris: ReturnType<typeof fixtureWithdrawIris>;
  sponsorCalls: string[];
  sponsorBudgetCalls: string[];
  executed: Map<string, ExecutedBurn | "lookup_fails">;
  quote(as?: As): Promise<Response>;
  create(body: Readonly<Record<string, unknown>>, as?: As): Promise<Response>;
  settle(withdrawalId: string, as?: As): Promise<Response>;
  setNow(ms: number | null): void;
}>;

async function withFixture(run: (fixture: Fixture) => Promise<void>, options: { chain?: OfflineChainOptions; afterSponsor?: (result: Awaited<ReturnType<BridgeWithdrawSponsor["sponsor"]>>) => Promise<void>; refuseSponsorBudget?: boolean; afterSponsorRefusal?: () => Promise<void> } = {}): Promise<void> {
  const database = await freshTestDatabase();
  const admin = createPool(database.url, { max: 4 });
  await rebuildChainRead(admin);
  await admin.query(
    `INSERT INTO social_accounts (account_id, privy_did, callsign, onboarded_at, privacy, sharing_since) VALUES ($1, $2, 'bridge_embedded', now(), 'public', now())`,
    [ACCOUNT, DID],
  );
  await admin.query(`INSERT INTO social_accounts (account_id, sui_address, callsign) VALUES ($1, $2, 'bridge_session')`, [SESSION_ACCOUNT, SESSION_WALLET]);

  const webPool = createRuntimePool(urlAs(database.url, "blast_web"), POOL, "social-bridge-withdraw-web");
  let clock: number | null = null;
  try {
    const kit = createSocialRouteKit({
      tradingVisible: () => true,
      expectedOrigin: ORIGIN,
      verifyAccessToken: createPrivyTokenVerifier({ appId: APP_ID, verificationKey: keys.publicKey.export({ format: "pem", type: "spki" }).toString() }),
      limiter: new PostgresRateLimitEnforcer({ pool: webPool, subjectPepper: PEPPER }),
      accounts: new PostgresSocialAccounts(() => webPool),
      walletSessions: { live: async (token) => (token === SESSION_TOKEN ? { address: SESSION_WALLET } : null) },
      primary: () => webPool,
      metricSampleRate: 0,
    });
    const chain = offlineTradeChain({
      balances: {
        [balanceKey(EMBEDDED, USDC)]: 1_000_000_000n,
        [balanceKey(SESSION_WALLET, USDC)]: 1_000_000_000n,
        [balanceKey(SESSION_WALLET, SUI)]: 10n ** 12n,
      },
      ...options.chain,
    });
    const sponsorBudgetCalls: string[] = [];
    const sponsorLimiter = new PostgresRateLimitEnforcer({ pool: webPool, subjectPepper: PEPPER });
    const real = createSponsorService({
      deployment: createPresaleDeploymentGate({ environment: identity({ cctp: SUI_CCTP_V2_IDENTITY }), node: async () => fixtureChainNode(SUI_MAINNET_CHAIN_IDENTIFIER) }),
      wallets: { async require(did) { return did === DID ? EMBEDDED : `0x${"0".repeat(64)}`; } },
      chain: fixtureChain().chain,
      reservations: new PostgresSponsorReservations(webPool),
      executions: { async today() { return { allowed: true }; } },
      config: () => ({ sponsorAddress: SPONSOR, maxGasMist: CAP, swapTargets: [], tradeFee: () => null }),
      // The sponsor's short-window rate limit uses the shared table.
      limits: { async consume(bucket, subject) {
        sponsorBudgetCalls.push(bucket);
        if (options.refuseSponsorBudget && bucket === "presale_sponsor_ip") return { allowed: false, bucket, policyVersion: 1, retryAfterSeconds: 60 };
        return sponsorLimiter.consume(bucket, subject);
      } },
      clock: () => new Date(clock ?? Date.now()),
    });
    const sponsorCalls: string[] = [];
    const sponsor: BridgeWithdrawSponsor = {
      recoverBridgeWithdrawal: (request) => real.recoverBridgeWithdrawal(request),
      async sponsor(request) {
        sponsorCalls.push(request.intent);
        let response;
        try { response = await real.sponsor(request); }
        catch (error) {
          if (error instanceof KeyedSponsorRefusal) await options.afterSponsorRefusal?.();
          throw error;
        }
        await options.afterSponsor?.(response);
        return response;
      },
    };
    const iris = fixtureWithdrawIris();
    const circle = createCachedCircleWithdraw(createCircleWithdrawIris({ fetch: iris.fetch, timeoutMs: 100 }), { messageTtlMs: 0, failureTtlMs: 0 });
    const executed = new Map<string, ExecutedBurn | "lookup_fails">();
    const routes = createSocialBridgeWithdrawRoutes({
      kit,
      database: () => autocommitReader(webPool, "social"),
      gate: () => ({ current: async () => LIVE }),
      circle: () => circle,
      chain: () => chain,
      sponsor: () => sponsor,
      burnIds: () => SUI_CCTP_V2_MAINNET,
      burns: () => ({
        async executed(digest) {
          const found = executed.get(digest);
          if (found === "lookup_fails") throw new Error(RAW_CHAIN_ERROR);
          return found ?? null;
        },
      }),
      blastWallet: async (caller) => (caller.kind === "privy" ? EMBEDDED : caller.address),
      now: () => clock ?? Date.now(),
    });
    const headers = (as: As): Record<string, string> =>
      as === "embedded" ? { authorization: bearer(DID) } : { cookie: `${SOCIAL_WALLET_SESSION_COOKIE}=${SESSION_TOKEN}`, "sec-fetch-site": "same-origin" };
    await run({
      admin,
      chain,
      iris,
      sponsorCalls,
      sponsorBudgetCalls,
      executed,
      quote: (as = "embedded") => routes.quote.GET(new Request(`${ORIGIN}${SOCIAL_BRIDGE_WITHDRAW_QUOTE_PATH}`, { headers: { origin: ORIGIN, ...headers(as) } }), testClient()),
      create: (body, as = "embedded") =>
        routes.create.POST(new Request(`${ORIGIN}${SOCIAL_BRIDGE_WITHDRAW_PATH}`, {
          method: "POST",
          headers: { origin: ORIGIN, "content-type": "application/json", ...headers(as) },
          body: JSON.stringify(body),
        }), testClient()),
      settle: (withdrawalId, as = "embedded") =>
        routes.settle.POST(new Request(`${ORIGIN}${socialBridgeWithdrawSettlePath(withdrawalId)}`, { method: "POST", headers: { origin: ORIGIN, ...headers(as) } }), testClient()),
      setNow: (ms) => {
        clock = ms;
      },
    });
  } finally {
    await webPool.end();
    await admin.end();
    await database.drop();
  }
}

async function withdrawalOf(response: Response, status: number): Promise<SocialBridgeWithdrawal> {
  const text = await response.text();
  assert.doesNotMatch(text, /secret-trace|MoveAbort/, "no raw chain error reaches a response");
  const body = JSON.parse(text) as SocialBridgeWithdrawal;
  assert.equal(response.status, status, text);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const checked = validator.validate("bridge-withdraw-response", body);
  assert.ok(checked.valid, JSON.stringify(checked.errors));
  return body;
}

function requestFor(destination: WithdrawDestination, recipient: string, amount: bigint, forwardFee: bigint, extra: Record<string, unknown> = {}) {
  const body = { idempotency_key: randomUUID(), destination, recipient, amount: amount.toString(), max_fee: bridgeWithdrawMaxFee(amount, "0", forwardFee).toString(), ...extra };
  assert.ok(validator.validate("bridge-withdraw-request", body).valid);
  return body;
}

type LogRow = { tx_id: string; kind: string; state: string; digest: string | null; failure_code: string | null; coin_type: string; amount: string; usd_value: string | null };
const logRows = (admin: Pool) =>
  admin.query<LogRow>("SELECT tx_id::text, kind, state, digest, failure_code, coin_type, amount::text, usd_value::text FROM social_transactions ORDER BY created_at_ms").then((result) => result.rows);

/** The deposit call of built bytes: its pure arguments, decoded. */
function depositCall(bytes: Uint8Array) {
  const data = bcs.TransactionData.parse(bytes).V1!;
  const { inputs, commands } = data.kind.ProgrammableTransaction!;
  const calls = commands.flatMap((command) => (command.MoveCall ? [command.MoveCall] : []));
  const deposit = calls.find((call) => call.function === "deposit_for_burn")!;
  const pure = (n: number) => fromBase64(inputs[(deposit.arguments[n] as { Input: number }).Input]!.Pure!.bytes);
  return {
    data,
    targets: calls.slice(-3).map((call) => `${normalizeSuiAddress(call.package)}::${call.module}::${call.function}`),
    domain: bcs.u32().parse(pure(1)),
    mintRecipient: normalizeSuiAddress(toHex(pure(2))),
    maxFee: BigInt(bcs.u256().parse(pure(4))),
    finality: bcs.u32().parse(pure(5)),
    hook: Uint8Array.from(bcs.vector(bcs.u8()).parse(pure(6))),
  };
}

test("an embedded wallet's withdrawal to Base is built as Circle's burn, sponsored, logged, burned from Sui and delivered on Circle's word", { skip }, async () => {
  await withFixture(async ({ admin, chain, iris, sponsorCalls, executed, quote, create, settle }) => {
    const offer = await quote();
    assert.equal(offer.status, 200);
    const base = ((await offer.json()) as { destinations: { destination: string; forward_fee: string }[] }).destinations.find((option) => option.destination === "base")!;
    assert.equal(base.forward_fee, "54800");

    const body = requestFor("base", "0x1E1e1E1E1e1e1e1e1e1E1E1E1E1e1e1E1e1e1E1E", 100_000_000n, 54_800n);
    const built = await withdrawalOf(await create(body), 201);
    assert.equal(built.status, "built");
    assert.equal(built.recipient, EVM, "the recipient as recorded: lowercase");
    assert.equal(built.receive, (100_000_000n - 54_800n).toString(), "Circle keeps max_fee; the rest reaches the recipient");
    assert.deepEqual(built.network_fee, { payer: "blast", label: "Paid by Blast" });
    assert.deepEqual(sponsorCalls, ["bridge_withdraw"]);
    const bytes = fromBase64(built.transaction_bytes!);
    assert.equal(built.digest, TransactionDataBuilder.getDigestFromBytes(bytes));
    const deposit = depositCall(bytes);
    assert.equal(normalizeSuiAddress(deposit.data.sender), EMBEDDED);
    assert.equal(normalizeSuiAddress(deposit.data.gasData.owner!), SPONSOR, "Blast's gas pool pays");
    assert.deepEqual(deposit.targets, [
      `${SUI_CCTP_V2_MAINNET.tokenMessengerMinter}::deposit_for_burn::deposit_for_burn`,
      `${SUI_CCTP_V2_MAINNET.stablecoinHandler}::handler::burn`,
      `${SUI_CCTP_V2_MAINNET.tokenMessengerMinter}::deposit_for_burn::complete_burn`,
    ]);
    assert.deepEqual([deposit.domain, deposit.mintRecipient, deposit.maxFee, deposit.finality], [6, normalizeSuiAddress(EVM), 54_800n, 2000]);
    assert.deepEqual(deposit.hook, forwardHookData("base", EVM));
    assert.deepEqual(chain.log.filter((entry) => entry.kind === "execute"), [], "the server executes nothing");

    let [logged] = await logRows(admin);
    assert.deepEqual(
      [logged!.tx_id, logged!.kind, logged!.state, logged!.digest, logged!.coin_type, logged!.amount, logged!.usd_value],
      [built.withdrawal_id, "withdraw", "submitted", built.digest, USDC, "100000000", "100.00"],
    );

    // A replay answers the first; the same key for another withdrawal is a conflict with the recorded one attached.
    const replay = await withdrawalOf(await create(body), 200);
    assert.equal(replay.withdrawal_id, built.withdrawal_id);
    const conflict = await create({ ...body, amount: "100000001" });
    assert.equal(conflict.status, 409);
    const refusal = (await conflict.json()) as { error: { code: string; withdrawal: SocialBridgeWithdrawal } };
    assert.equal(refusal.error.code, "bridge_withdraw_conflict");
    assert.equal(refusal.error.withdrawal.withdrawal_id, built.withdrawal_id);
    assert.deepEqual(sponsorCalls, ["bridge_withdraw"], "nothing was built twice");

    // Not on Sui yet: still built. A fullnode outage changes nothing either.
    assert.equal((await withdrawalOf(await settle(built.withdrawal_id), 200)).status, "built");
    executed.set(built.digest!, "lookup_fails");
    assert.equal((await withdrawalOf(await settle(built.withdrawal_id), 200)).status, "built");

    // Executed as this burn: burned, and the log confirms it. Circle has not seen it yet.
    executed.set(built.digest!, await burned(built, EMBEDDED));
    const onSui = await withdrawalOf(await settle(built.withdrawal_id), 200);
    assert.equal(onSui.status, "burned");
    assert.equal(onSui.transaction_bytes, null, "nothing left to sign");
    assert.ok(onSui.burned_at_ms !== null);
    [logged] = await logRows(admin);
    assert.deepEqual([logged!.state, logged!.digest], ["confirmed", built.digest]);

    // Circle down, then attested and still forwarding: burned.
    iris.state.status = 500;
    assert.equal((await withdrawalOf(await settle(built.withdrawal_id), 200)).status, "burned");
    iris.state.status = null;
    const pending = structuredClone(FIXTURE_FORWARDED_MESSAGE) as { messages: Record<string, unknown>[] };
    pending.messages[0]!.forwardState = "PENDING";
    delete pending.messages[0]!.forwardTxHash;
    iris.state.messages[built.digest!] = pending;
    assert.equal((await withdrawalOf(await settle(built.withdrawal_id), 200)).status, "burned");

    // Circle minted on Base: delivered with that transaction's hash.
    iris.state.messages[built.digest!] = FIXTURE_FORWARDED_MESSAGE;
    const delivered = await withdrawalOf(await settle(built.withdrawal_id), 200);
    assert.equal(delivered.status, "delivered");
    assert.equal(delivered.destination_tx_hash, `0x${"d5".repeat(32)}`);
    assert.ok(delivered.delivered_at_ms! >= delivered.burned_at_ms!);
    const again = await withdrawalOf(await settle(built.withdrawal_id), 200);
    assert.deepEqual(again, delivered, "delivered is final");
    [logged] = await logRows(admin);
    assert.equal(logged!.state, "confirmed");
  });
});

test("a wallet session's withdrawal to Solana is sponsored under sui:<address> and mints to the owner's USDC account with Circle's account-setup hook", { skip }, async () => {
  await withFixture(async ({ admin, sponsorCalls, executed, create, settle }) => {
    const built = await withdrawalOf(await create(requestFor("solana", SOLANA_OWNER, 25_000_000n, 344_900n), "session"), 201);
    assert.equal(built.status, "built");
    assert.deepEqual(built.network_fee, { payer: "blast", label: "Paid by Blast" });
    assert.ok(built.reservation_id);
    assert.deepEqual(sponsorCalls, ["bridge_withdraw"], "a wallet session is sponsored like an embedded wallet");
    const reservation = await admin.query("SELECT privy_did, sender FROM presale_sponsor_reservations WHERE id = $1", [built.reservation_id]);
    assert.deepEqual(reservation.rows[0], { privy_did: `sui:${SESSION_WALLET}`, sender: SESSION_WALLET });
    const deposit = depositCall(fromBase64(built.transaction_bytes!));
    assert.equal(normalizeSuiAddress(deposit.data.sender), SESSION_WALLET);
    assert.equal(normalizeSuiAddress(deposit.data.gasData.owner!), SPONSOR, "Blast's gas pool pays");
    assert.equal(deposit.domain, 5);
    assert.equal(deposit.mintRecipient, await withdrawMintRecipient("solana", SOLANA_OWNER));
    assert.equal(deposit.hook.length, 65);
    assert.deepEqual(deposit.hook, forwardHookData("solana", SOLANA_OWNER));
    // Executed as something else (another mint recipient): mismatch, never burned.
    executed.set(built.digest!, await burned(built, SESSION_WALLET, { mintRecipient: normalizeSuiAddress("0xbad") }));
    const settled = await withdrawalOf(await settle(built.withdrawal_id, "session"), 200);
    assert.deepEqual([settled.status, settled.failure_code], ["failed", "mismatch"]);
  });
});

test("refusals are failed rows with their code and no bytes, logged: short of USDC, and a burn whose dry run aborts", { skip }, async () => {
  await withFixture(async ({ admin, sponsorCalls, create }) => {
    const short = await withdrawalOf(await create(requestFor("base", EVM, 2_000_000_000n, 54_800n)), 201);
    assert.deepEqual([short.status, short.failure_code, short.transaction_bytes, short.digest, short.network_fee], ["failed", "insufficient_balance", null, null, null]);
    assert.deepEqual(sponsorCalls, []);
    const [logged] = await logRows(admin);
    assert.deepEqual([logged!.kind, logged!.state, logged!.failure_code], ["withdraw", "failed", "insufficient_balance"]);
  });
  await withFixture(async ({ create }) => {
    const aborted = await withdrawalOf(await create(requestFor("arbitrum", EVM, 10_000_000n, 81_000n)), 201);
    assert.deepEqual([aborted.status, aborted.failure_code], ["failed", "dry_run_failed"]);
  }, { chain: { simulation: () => simulationAbort(SUI_CCTP_V2_MAINNET.tokenMessengerMinter, "deposit_for_burn", 8) } });
});

test("proven chain failures are terminal; missing burns remain reconcilable beyond signing freshness", { skip }, async () => {
  await withFixture(async ({ admin, executed, create, settle, setNow }) => {
    const aborted = await withdrawalOf(await create(requestFor("ethereum", EVM, 10_000_000n, 1_736_900n)), 201);
    executed.set(aborted.digest!, { success: false, events: [] });
    const failed = await withdrawalOf(await settle(aborted.withdrawal_id), 200);
    assert.deepEqual([failed.status, failed.failure_code], ["failed", "execution_failed"]);
    const idle = await withdrawalOf(await create(requestFor("base", EVM, 10_000_000n, 54_800n)), 201);
    for (const age of [59_000, 61_000, 86_400_000]) {
      setNow(idle.expires_at_ms! + age);
      assert.equal((await withdrawalOf(await settle(idle.withdrawal_id), 200)).status, "built");
    }
    executed.set(idle.digest!, "lookup_fails");
    assert.equal((await withdrawalOf(await settle(idle.withdrawal_id), 200)).status, "built");
    const states = (await logRows(admin)).map((row) => [row.tx_id, row.state, row.failure_code]);
    assert.deepEqual(states, [[aborted.withdrawal_id, "failed", "execution_failed"], [idle.withdrawal_id, "submitted", null]]);
    executed.set(idle.digest!, await burned(idle, EMBEDDED));
    const late = await Promise.all([settle(idle.withdrawal_id), settle(idle.withdrawal_id)]);
    for (const answer of late) assert.equal((await withdrawalOf(answer, 200)).status, "burned");
    assert.equal((await withdrawalOf(await settle(idle.withdrawal_id), 200)).status, "burned");
    assert.equal((await logRows(admin)).filter((row) => row.tx_id === idle.withdrawal_id && row.state === "confirmed").length, 1);
    const other = await settle(idle.withdrawal_id, "session");
    assert.equal(other.status, 404);
  });
});

test("a fullnode outage while building records nothing, and the same key may be sent again", { skip }, async () => {
  await withFixture(async ({ admin, create }) => {
    const response = await create(requestFor("base", EVM, 10_000_000n, 54_800n));
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /fullnode down/);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM social_bridge_withdrawals")).rows[0]!.n, 0);
  }, { chain: { down: true } });
});

test("concurrent identical creates have one durable sponsor reservation", { skip }, async () => {
  let resume!: () => void;
  let reached!: () => void;
  const held = new Promise<void>((resolve) => { resume = resolve; });
  const entered = new Promise<void>((resolve) => { reached = resolve; });
  await withFixture(async ({ admin, sponsorCalls, create }) => {
    const body = requestFor("base", EVM, 10_000_000n, 54_800n);
    const first = create(body);
    await entered;
    try {
      assert.equal((await create(body)).status, 503);
    } finally {
      resume();
    }
    const built = await withdrawalOf(await first, 201);
    const replay = await withdrawalOf(await create(body), 200);
    assert.equal(replay.withdrawal_id, built.withdrawal_id);
    assert.deepEqual(sponsorCalls, ["bridge_withdraw"]);
    const stored = await admin.query("SELECT id::text FROM presale_sponsor_reservations WHERE intent = 'bridge_withdraw'");
    assert.deepEqual(stored.rows, [{ id: built.withdrawal_id }]);
  }, { afterSponsor: async () => { reached(); await held; } });
});

test("a lost sponsorship reply recovers retained bytes even when fresh balance reads fail", { skip }, async (t) => {
  let lost = true;
  const originals: Awaited<ReturnType<BridgeWithdrawSponsor["sponsor"]>>[] = [];
  await withFixture(async ({ admin, create, chain }) => {
    const body = requestFor("base", EVM, 10_000_000n, 54_800n);
    assert.equal((await create(body)).status, 503);
    t.mock.method(chain, "balance", async () => { throw new Error("fresh balance is unavailable"); });
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM social_bridge_withdrawals")).rows[0].n, 0);
    const built = await withdrawalOf(await create(body), 201);
    assert.equal(originals.length, 1);
    assert.equal(built.transaction_bytes, originals[0]!.transaction_bytes);
    assert.equal(built.reservation_id, originals[0]!.reservation_id);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM presale_sponsor_reservations WHERE intent = 'bridge_withdraw'")).rows[0].n, 1);
  }, { afterSponsor: async (response) => {
    if (lost) { lost = false; originals.push(response); throw new Error("reply lost after durable sponsorship"); }
  } });
});

test("a stale owner cannot commit after takeover; both attempts share the first sponsor bytes", { skip }, async () => {
  let resume!: () => void;
  let reached!: () => void;
  let calls = 0;
  const held = new Promise<void>((resolve) => { resume = resolve; });
  const entered = new Promise<void>((resolve) => { reached = resolve; });
  await withFixture(async ({ admin, create, setNow }) => {
    const body = requestFor("base", EVM, 10_000_000n, 54_800n);
    const stale = create(body);
    await entered;
    setNow(Date.now() + 121_000);
    let recovered: SocialBridgeWithdrawal;
    try {
      recovered = await withdrawalOf(await create(body), 201);
    } finally {
      resume();
    }
    assert.equal((await stale).status, 503);
    assert.equal(recovered.transaction_bytes, null, "recovery keeps evidence without offering stale bytes to sign");
    assert.deepEqual([recovered.status, recovered.failure_code], ["failed", "expired"]);
    const reservations = await admin.query("SELECT id::text, digest FROM presale_sponsor_reservations WHERE intent = 'bridge_withdraw'");
    assert.deepEqual(reservations.rows, [{ id: recovered.withdrawal_id, digest: recovered.digest }]);
    assert.equal((await logRows(admin)).length, 1);
    assert.deepEqual((await logRows(admin)).map((row) => [row.state, row.failure_code]), [["failed", "expired"]]);
    assert.equal((await admin.query("SELECT state FROM presale_sponsor_reservations WHERE id=$1", [recovered.reservation_id])).rows[0].state, "expired");
  }, { afterSponsor: async () => { if (++calls === 1) { reached(); await held; } } });
});

test("definite sponsor refusal commits one failed ledger and retries without rebuilding or recounting", { skip }, async (t) => {
  let lost = true;
  await withFixture(async ({ admin, create, chain, sponsorCalls, sponsorBudgetCalls }) => {
    const body = requestFor("base", EVM, 10_000_000n, 54_800n);
    assert.equal((await create(body)).status, 503, "Lost refusal reply precedes ledger commit");
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM social_bridge_withdrawals")).rows[0].n, 0);
    t.mock.method(chain, "balance", async () => { assert.fail("Retained refusal precedes expensive rebuilding"); });
    const failed = await withdrawalOf(await create(body), 201);
    assert.deepEqual([failed.status, failed.failure_code, failed.transaction_bytes, failed.digest], ["failed", "sponsor_refused", null, null]);
    const replay = await withdrawalOf(await create(body), 200);
    assert.deepEqual(replay, failed);
    assert.deepEqual(sponsorCalls, ["bridge_withdraw"]);
    assert.deepEqual(sponsorBudgetCalls, ["presale_sponsor_ip"]);
    assert.deepEqual((await admin.query("SELECT state, refusal_reason FROM presale_sponsor_budget_attempts")).rows, [{ state: "refused", refusal_reason: "presale_sponsor_ip" }]);
    assert.deepEqual((await logRows(admin)).map((row) => [row.state, row.failure_code]), [["failed", "sponsor_refused"]]);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM presale_sponsor_reservations")).rows[0].n, 0);
  }, { refuseSponsorBudget: true, afterSponsorRefusal: async () => { if (lost) { lost = false; throw new Error("refusal response lost"); } } });
});

test(
  "withdrawal log failure rolls back sponsor expiry and the ledger together",
  { skip },
  async () => {
    let lost = true;
    await withFixture(
      async ({ admin, create, setNow, sponsorCalls, sponsorBudgetCalls }) => {
        const body = requestFor("base", EVM, 10_000_000n, 54_800n);
        assert.equal(
          (await create(body)).status,
          503,
          "Lost reply retains the original reservation",
        );
        setNow(Date.now() + 121_000);
        await admin.query(`
          CREATE FUNCTION reject_withdrawal_log() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'fixture withdrawal log failure'; END; $$;
          CREATE TRIGGER reject_withdrawal_log BEFORE INSERT ON social_transactions
          FOR EACH ROW EXECUTE FUNCTION reject_withdrawal_log();
        `);
        assert.equal((await create(body)).status, 503);
        assert.deepEqual(
          (await admin.query("SELECT state FROM presale_sponsor_reservations")).rows,
          [{ state: "reserved" }],
        );
        assert.equal(
          (await admin.query("SELECT count(*)::int AS n FROM social_bridge_withdrawals")).rows[0].n,
          0,
        );
        assert.equal((await logRows(admin)).length, 0);
        await admin.query("DROP TRIGGER reject_withdrawal_log ON social_transactions");
        const recovered = await withdrawalOf(await create(body), 201);
        assert.deepEqual([recovered.status, recovered.failure_code], ["failed", "expired"]);
        assert.deepEqual(
          (await admin.query("SELECT state FROM presale_sponsor_reservations")).rows,
          [{ state: "expired" }],
        );
        assert.deepEqual(
          (await logRows(admin)).map((row) => [row.state, row.failure_code]),
          [["failed", "expired"]],
        );
        assert.deepEqual(sponsorCalls, ["bridge_withdraw"]);
        assert.deepEqual(sponsorBudgetCalls, ["presale_sponsor_ip"]);
      },
      {
        afterSponsor: async () => {
          if (lost) {
            lost = false;
            throw new Error("reply lost");
          }
        },
      },
    );
  },
);

test("an expired retained reservation already submitted stays reconcilable even without a prior ledger", { skip }, async () => {
  let reservationId: string | undefined;
  let lost = true;
  await withFixture(async ({ admin, create, settle, setNow, executed }) => {
    const body = requestFor("base", EVM, 10_000_000n, 54_800n);
    assert.equal((await create(body)).status, 503);
    await admin.query("UPDATE presale_sponsor_reservations SET state='submitted', submitted_at=now() WHERE id=$1", [reservationId]);
    setNow(Date.now() + 121_000);
    const recovered = await withdrawalOf(await create(body), 201);
    assert.deepEqual([recovered.status, recovered.failure_code, recovered.transaction_bytes], ["built", null, null]);
    assert.equal((await admin.query("SELECT state FROM presale_sponsor_reservations WHERE id=$1", [reservationId])).rows[0].state, "submitted");
    executed.set(recovered.digest!, await burned(recovered, EMBEDDED));
    assert.equal((await withdrawalOf(await settle(recovered.withdrawal_id), 200)).status, "burned");
  }, { afterSponsor: async (result) => { reservationId = result.reservation_id; if (lost) { lost = false; throw new Error("reply lost"); } } });
});
