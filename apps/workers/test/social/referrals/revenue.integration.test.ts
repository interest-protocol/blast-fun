import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { USDC_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import {
  autocommitReader,
  withTransaction,
} from "@blast/core/modules/database/transaction.ts";
import {
  collectReferralRevenue,
  parseReferralAccountingProfile,
  REFERRAL_RECEIPTS_SQL,
} from "#workers/modules/social/referrals/collect.ts";
import {
  readReferralSummary,
  readReferralInvitees,
} from "@blast/server/modules/social/referrals/read.ts";
import { insertNewAccount } from "@blast/server/modules/social/accounts/creation.ts";
import { readReferralInviter } from "@blast/server/modules/social/referrals/share-read.ts";
import { ADMIN_CONSOLE_OPERATOR } from "@blast/server/modules/mission-control/operator/auth.ts";
import { readReferralMonths } from "@blast/server/modules/social/referrals/revenue.ts";
import { referralPaymentRecord } from "@blast/server/modules/social/referrals/operator.ts";
import { parseSocialOperatorInvocation, runSocialOperatorInvocation } from "@blast/server/modules/social/operator/framework.ts";
import {
  urlAs,
  FIXTURE_FINGERPRINT,
} from "../../../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import {
  presaleEvent,
  feePayment,
  launchEvent,
  profile,
  quote,
  meme,
  objectId,
  start,
} from "../../../../../packages/core/src/modules/defillama/fixtures.test.ts";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const SUI = 1_000_000_000n;

test(
  "reserved X identity → invited wallet → confirmed fees → private exact revenue and 60% earnings",
  { skip: !databaseUrl },
  async (t) => {
    assert.ok(databaseUrl);
    const admin = new Pool({ connectionString: databaseUrl, max: 1 });
    const web = new Pool({
      connectionString: urlAs(databaseUrl, "blast_web"),
      max: 1,
    });
    const watcher = new Pool({
      connectionString: urlAs(databaseUrl, "blast_watcher"),
      max: 1,
    });
    t.after(async () => {
      await web.end();
      await watcher.end();
      await admin.end();
    });
    await migrateDatabase(admin);
    const db = autocommitReader(web, "social");
    const reservations = await admin.query(
      "SELECT code,x_subject FROM social_referral_reservations ORDER BY code",
    );
    assert.equal(reservations.rows.length, 6);
    assert.equal(
      reservations.rows.find((r) => r.code === "cryptokaleo").x_subject,
      "906234475604037637",
    );
    assert.ok(
      await readReferralInviter(db, "irenezhao_"),
      "pre-signup link resolves even with trailing underscore",
    );
    async function create(
      callsign: string,
      referral: string | null,
      xSubject?: string,
    ) {
      return withTransaction(web, (tx) =>
        insertNewAccount(
          tx.forModule("social"),
          {
            privyDid: `did:privy:${callsign}`,
            callsign,
            displayName: callsign,
            referralCallsign: referral,
            x: xSubject
              ? {
                  xSubject,
                  handle: "renamed_on_x",
                  displayName: null,
                  avatarUrl: null,
                }
              : null,
          },
          { findBlockedTerm: async () => null },
        ),
      );
    }
    const recruit = await create("first_follower", "cryptokaleo");
    const impersonator = await create("fake_kaleo", null, "1111111111");
    await admin.query(
      "UPDATE social_accounts SET x_handle='CryptoKaleo' WHERE account_id=$1",
      [impersonator],
    );
    assert.equal(
      (
        await admin.query(
          "SELECT owner_account_id FROM social_referral_reservations WHERE code='cryptokaleo'",
        )
      ).rows[0].owner_account_id,
      null,
    );
    const owner = await create(
      "kaleo_on_blast",
      "cryptokaleo",
      "906234475604037637",
    );
    assert.equal(
      (
        await admin.query(
          "SELECT owner_account_id FROM social_referral_reservations WHERE code='cryptokaleo'",
        )
      ).rows[0].owner_account_id,
      owner,
    );
    assert.equal(
      (await readReferralSummary(db, owner)).invited,
      1,
      "self referral excluded",
    );
    assert.equal(
      (await readReferralSummary(db, owner)).referral_code,
      "cryptokaleo",
    );
    assert.equal(
      (await readReferralSummary(db, owner)).accounting?.as_of_ms,
      null,
      "no fabricated zero before ingestion",
    );
    await assert.rejects(create("cryptokaleo", null), /callsign is reserved/);
    await assert.rejects(
      admin.query(
        "UPDATE social_accounts SET referrer_reservation_code='tradermayne' WHERE account_id=$1",
        [recruit],
      ),
      /assigned only at creation/,
    );
    assert.equal((await readReferralSummary(db, impersonator)).invited, 0);
    const sender = objectId("a");
    await admin.query(
      "UPDATE social_accounts SET created_at=to_timestamp($2/1000.0) WHERE account_id=$1",
      [recruit, start - 1000],
    );
    await admin.query(
      "INSERT INTO social_account_wallets(address,account_id,verified_at) VALUES ($1,$2,to_timestamp($3/1000.0))",
      [sender, recruit, start - 1000],
    );
    await admin.query(
      "INSERT INTO blast_infra_fixture.coin_metadata(coin_type,name,symbol,decimals) VALUES ($1,'Sui','SUI',9),($2,'Meme','MEME',9)",
      [quote, meme],
    );
    const accountingProfile = parseReferralAccountingProfile({
      network: "mainnet",
      deployment_fingerprint: FIXTURE_FINGERPRINT,
      launchpad_original_package: profile.launchpad_original_package,
      presale_original_package: profile.presale_original_package,
      core_original_package: profile.core_original_package,
      first_checkpoint: "100",
    });
    const boundary = {
      pipeline: "presale" as const,
      checkpoint: 200,
      timestampMs: start + 10000,
      checkpointDigest: "referral-checkpoint-200",
    };
    await admin.query(
      "UPDATE watermarks SET reader_lo=100 WHERE pipeline='intake'",
    );
    for (let cp = 100; cp <= 201; cp++)
      await admin.query(
        `INSERT INTO checkpoint_journal
    (checkpoint,network,digest,epoch,timestamp_ms,total_transactions,format_version,payload,payload_hash)
    VALUES ($1,'mainnet',$2,0,$3,0,1,''::bytea,decode(repeat('00',32),'hex'))`,
        [cp, `referral-checkpoint-${cp}`, start + cp],
      );
    let index = 0;
    async function receipt(
      events: ReturnType<typeof presaleEvent>[],
      checkpoint = 110 + index,
      success = true,
      wallet = sender,
      timestampMs = start + checkpoint,
    ) {
      const digest = `referral-receipt-${String(index++).padStart(3, "0")}`;
      await admin.query(
        `INSERT INTO blast_infra_fixture.transaction_evidence VALUES ($1,$2,$3,$4,$5,
          (SELECT COALESCE(jsonb_agg(e || jsonb_build_object('bcs',encode(decode(e->>'bcs','base64'),'base64')) ORDER BY ordinal),'[]'::jsonb)
           FROM jsonb_array_elements($6::jsonb) WITH ORDINALITY AS event(e,ordinal)))`,
        [
          digest,
          checkpoint,
          timestampMs,
          wallet,
          success,
          JSON.stringify(
            events.map((e) => ({
              eventType: e.event_type,
              bcs: Buffer.from(e.bcs).toString("base64"),
            })),
          ),
        ],
      );
      return digest;
    }
    const sale = objectId("7");
    function commit(id: string, amount = 100n * SUI) {
      return presaleEvent("Committed", {
        presale_id: id,
        quote: amount,
        wallet_commitment: amount,
        total_commitments: amount,
        participants: 1n,
      });
    }
    function funded(id: string, accepted = 100n * SUI) {
      return presaleEvent("PresaleFunded", {
        presale_id: id,
        total_commitments: 100n * SUI,
        accepted_quote: accepted,
        refundable_quote: 100n * SUI - accepted,
        token_allocation: 1000n,
        end_ms: 0n,
        liquidity_deadline_ms: 0n,
      });
    }
    function paid(id: string, amount = SUI) {
      return feePayment("presale", {
        origin: id,
        quote_amount: amount,
        partner_quote_amount: 20n * SUI,
        meme_amount: 999999n,
      });
    }
    // Events the ledger does not use must not stop it, even ones the SDK decoders reject.
    await receipt([
      { ...commit(sale), event_type: `${profile.presale_original_package}::events::QuoteAllowed<${quote}>` },
      { ...commit(sale), event_type: `${profile.launchpad_original_package}::events::NotALedgerEvent<${quote}>` },
    ]);
    await receipt([commit(sale)]);
    await receipt([funded(sale), paid(sale)]);
    const collect = () =>
      withTransaction(
        watcher,
        (tx) =>
          collectReferralRevenue(
            tx.forModule("social"),
            boundary,
            accountingProfile,
          ),
        { isolationLevel: "REPEATABLE READ" },
      );
    await collect();
    const first = (await readReferralSummary(db, owner)).accounting!;
    assert.deepEqual((await readReferralMonths(db, owner)).months.find(({ month }) => month === "2026-10"), {
      month: "2026-10", revenue_atoms: "1000000000", share_bps: 6000, payment: null,
    });
    assert.deepEqual(first.assets, [
      {
        coin_type: quote,
        symbol: "SUI",
        decimals: 9,
        volume_atoms: String(100n * SUI),
        revenue_atoms: String(SUI),
        earnings_atoms: String(600_000_000n),
      },
    ]);
    assert.equal(first.as_of_ms, boundary.timestampMs);
    await collect(); // JSONB cursor roundtrip, idempotent replay.
    assert.deepEqual((await readReferralSummary(db, owner)).accounting, first);
    await assert.rejects(
      withTransaction(
        watcher,
        (tx) =>
          collectReferralRevenue(tx.forModule("social"), boundary, {
            ...accountingProfile,
            first_checkpoint: "101",
          }),
        { isolationLevel: "REPEATABLE READ" },
      ),
      /profile changed/,
    );
    assert.deepEqual(
      (await readReferralInvitees(db, owner, null)).invitees[0].accounting,
      first,
    );

    // New receipts must appear after the published cursor. A successful overfilled sale only counts accepted principal.
    const overflow = objectId("8"),
      unpaid = objectId("9"),
      cancelled = objectId("b"),
      failed = objectId("c");
    await receipt(
      [
        commit(overflow),
        funded(overflow, 80n * SUI),
        paid(overflow, 800_000_000n),
      ],
      201,
    );
    const wrongCoinPayment = paid(unpaid);
    await receipt([
      commit(unpaid),
      funded(unpaid),
      { ...wrongCoinPayment, event_type: wrongCoinPayment.event_type.replace(quote, USDC_COIN_TYPE) },
    ], 201);
    await receipt(
      [
        commit(cancelled),
        funded(cancelled),
        paid(cancelled),
        presaleEvent("PresaleCancelled", {
          presale_id: cancelled,
          total_commitments: 100n * SUI,
          refundable_quote: 100n * SUI,
        }),
      ],
      201,
    );
    await receipt([commit(failed), funded(failed), paid(failed)], 201, false);
    await receipt(
      [commit(objectId("d")), funded(objectId("d")), paid(objectId("d"))],
      201,
      true,
      objectId("f"),
    );
    const usdcSale = objectId("1");
    const usdcLaunch = objectId("2");
    await receipt(
      [
        commit(usdcSale), funded(usdcSale), paid(usdcSale),
        launchEvent("LaunchCreated", { launch_id: usdcLaunch }),
        launchEvent("Bought", { launch_id: usdcLaunch, quote_in: 10n * SUI, protocol_quote_fee: SUI }),
        feePayment("launch", { origin: usdcLaunch, quote_amount: SUI }),
      ].map((event) => ({
        ...event,
        event_type: event.event_type.replace(quote, USDC_COIN_TYPE),
      })),
      201,
    );
    await receipt(
      [
        launchEvent("LaunchTicketCreated", { ticket_id: objectId("e"), meme }),
        launchEvent("LaunchCreated", { ticket_id: objectId("e"), quote }),
        launchEvent("Bought", {
          quote_in: 10n * SUI,
          protocol_quote_fee: 100_000_000n,
          protocol_meme_fee: 200_000_000n,
          creator_quote_fee: 50_000_000n,
        }),
      ],
      201,
    );
    boundary.checkpoint = 201;
    boundary.checkpointDigest = "referral-checkpoint-201";
    boundary.timestampMs++;
    await collect();
    const next = (await readReferralSummary(db, owner)).accounting!;
    assert.equal((await readReferralMonths(db, owner)).months.find(({ month }) => month === "2026-10")?.revenue_atoms, "1800000000");
    assert.deepEqual(next.assets.map(({ coin_type }) => coin_type), [quote, USDC_COIN_TYPE]);
    assert.equal(next.assets[1].volume_atoms, String(110n * SUI)); // USDC presale 100 + buy 10
    assert.equal(next.assets[1].revenue_atoms, String(2n * SUI)); // USDC presale fee + claimed USDC swap fee
    assert.equal(next.assets[0].volume_atoms, String(290n * SUI)); // 100 + 80 + funded/unpaid100 + buy10
    assert.equal(next.assets[0].revenue_atoms, "1800000000"); // Two successful SUI presales. The trade fee is still uncollected.
    assert.equal(next.assets[0].earnings_atoms, "1080000000");
    assert.equal(next.pending_events, 2);
    assert.equal(
      (await readReferralSummary(db, impersonator)).accounting?.assets.length,
      0,
    );
    // Partner shares use actual claim splits, with event order inside a PTB. A later split must never rewrite an earlier one.
    const partnerFollower = await create("partner_follower", "martypartymusic");
    const partnerOwner = await create("marty_on_blast", null, "22506165");
    const partnerWallet = objectId("6"),
      partnerLaunch = objectId("0"),
      partnerTicket = objectId("f");
    await admin.query(
      "UPDATE social_accounts SET created_at=to_timestamp($2/1000.0) WHERE account_id=$1",
      [partnerFollower, start - 1000],
    );
    await admin.query(
      "INSERT INTO social_account_wallets(address,account_id,verified_at) VALUES ($1,$2,to_timestamp($3/1000.0))",
      [partnerWallet, partnerFollower, start - 1000],
    );
    function buy(fee: bigint) {
      return launchEvent("Bought", {
        launch_id: partnerLaunch,
        quote_in: 100n * SUI,
        protocol_quote_fee: fee,
      });
    }
    function claim(net: bigint, partner: bigint) {
      return feePayment("launch", {
        origin: partnerLaunch,
        quote_amount: net,
        partner_quote_amount: partner,
        meme_amount: 0n,
        partner_meme_amount: 0n,
      });
    }
    async function advance(cp: number, timestampMs = start + cp) {
      await admin.query(
        `INSERT INTO checkpoint_journal (checkpoint,network,digest,epoch,timestamp_ms,total_transactions,format_version,payload,payload_hash)
      VALUES ($1,'mainnet',$2,0,$3,0,1,''::bytea,decode(repeat('00',32),'hex'))`,
        [cp, `referral-checkpoint-${cp}`, timestampMs],
      );
      await admin.query(
        "INSERT INTO blast_infra_fixture.checkpoint_headers(checkpoint,digest,timestamp_ms) VALUES ($1,$2,$3)",
        [cp, `referral-checkpoint-${cp}`, timestampMs],
      );
      boundary.checkpoint = cp;
      boundary.checkpointDigest = `referral-checkpoint-${cp}`;
      boundary.timestampMs = timestampMs;
    }
    await advance(202);
    await receipt([feePayment("launch", {
      quote_amount: 100_000_000n,
      meme_amount: 200_000_000n,
      sui_amount: 2n * SUI,
    })], 202);
    await receipt(
      [
        launchEvent("LaunchTicketCreated", { ticket_id: partnerTicket, meme }),
        launchEvent("LaunchCreated", {
          launch_id: partnerLaunch,
          ticket_id: partnerTicket,
          quote,
          partner_id: objectId("6"),
        }),
        buy(10n * SUI),
        claim(8n * SUI, 2n * SUI),
      ],
      202,
      true,
      partnerWallet,
    );
    await collect();
    const collected = (await readReferralSummary(db, owner)).accounting!;
    assert.equal((await readReferralMonths(db, owner)).months.find(({ month }) => month === "2026-10")?.revenue_atoms, "1900000000");
    assert.deepEqual(collected.assets.map(({ coin_type }) => coin_type), [quote, USDC_COIN_TYPE]);
    assert.equal(collected.assets[0].revenue_atoms, "1900000000");
    assert.equal(collected.assets[0].earnings_atoms, "1140000000");
    assert.equal(collected.pending_events, 1);
    assert.equal(
      (await readReferralSummary(db, partnerOwner)).accounting!.assets[0]
        .revenue_atoms,
      String(8n * SUI),
    );
    await advance(203);
    await receipt(
      [buy(10n * SUI), claim(7n * SUI, 3n * SUI), buy(20n * SUI)],
      203,
      true,
      partnerWallet,
    );
    await advance(204);
    await receipt([claim(10n * SUI, 10n * SUI)], 204, true, partnerWallet);
    await collect();
    const partnerTotals = (await readReferralSummary(db, partnerOwner))
      .accounting!;
    assert.equal(partnerTotals.assets[0].revenue_atoms, String(25n * SUI));
    assert.equal(partnerTotals.assets[0].earnings_atoms, String(15n * SUI));
    assert.equal(partnerTotals.pending_events, 0);
    await advance(205);
    await receipt([buy(10n * SUI)], 205, true, partnerWallet);
    await receipt([claim(8n * SUI, 2n * SUI)], 205, true, partnerWallet); // Cross-digest order is unavailable in the source view.
    await advance(206);
    await receipt([buy(10n * SUI)], 206, true, partnerWallet);
    await advance(207);
    await receipt([claim(7n * SUI, 3n * SUI)], 207, true, partnerWallet);
    await collect();
    const ambiguous = (await readReferralSummary(db, partnerOwner)).accounting!;
    assert.equal(
      ambiguous.assets[0].revenue_atoms,
      String(25n * SUI),
      "an earlier trade cannot inherit a later claim's split",
    );
    assert.ok(ambiguous.pending_events > 0);
    await advance(208);
    for (let i = 0; i < 65; i++) await receipt([paid(sale)], 208, false);
    await collect();
    assert.equal(
      (await readReferralSummary(db, partnerOwner)).accounting!.as_of_ms,
      start + 207,
      "an incomplete page cannot publish newer amounts with an old date",
    );
    await collect();
    assert.equal(
      (await readReferralSummary(db, partnerOwner)).accounting!.as_of_ms,
      start + 208,
    );
    // Sparse history is scanned window by window within one pass's time budget.
    await advance(1208);
    await advance(2208);
    await advance(3000);
    await collect();
    assert.equal(
      (await readReferralSummary(db, partnerOwner)).accounting!.as_of_ms,
      start + 3000,
    );

    const standardOwner = await create("standard_owner", null);
    const specialOwner = await create("special_owner", null, "7777777777");
    const reservationCode = "special_reservation";
    const reservationSubject = "5555555555";
    await admin.query(
      "INSERT INTO social_referral_reservations(code,x_subject,x_handle,display_name) VALUES ($1,$2,'special_x','Special X')",
      [reservationCode, reservationSubject],
    );
    const standardFollower = await create("standard_follower", "standard_owner");
    const reservationFollower = await create("reservation_follower", reservationCode);
    const standardWallet = objectId("7");
    const reservationWallet = objectId("8");
    await admin.query(
      "UPDATE social_accounts SET created_at=to_timestamp($3/1000.0) WHERE account_id IN ($1,$2)",
      [standardFollower, reservationFollower, start - 1000],
    );
    await admin.query(
      `INSERT INTO social_account_wallets(address,account_id,verified_at)
       VALUES ($1,$2,to_timestamp($5/1000.0)),($3,$4,to_timestamp($5/1000.0))`,
      [standardWallet, standardFollower, reservationWallet, reservationFollower, start - 1000],
    );
    const laterSale = objectId("a");
    const laterPartnerLaunch = objectId("b");
    const laterPartnerTicket = objectId("c");
    const reservationLaunch = objectId("5");
    const unpartneredBuy = (fee: bigint, launch = objectId("4")) => [
      launchEvent("Bought", {
        launch_id: launch,
        quote_in: 10n * SUI,
        protocol_quote_fee: fee,
      }),
      feePayment("launch", { origin: launch, quote_amount: fee }),
    ];
    await advance(3001);
    await receipt([...unpartneredBuy(3n), commit(laterSale), funded(laterSale)], 3001, true, standardWallet);
    await receipt([
      launchEvent("LaunchTicketCreated", { ticket_id: laterPartnerTicket, meme }),
      launchEvent("LaunchCreated", { launch_id: laterPartnerLaunch, ticket_id: laterPartnerTicket, quote, partner_id: objectId("6") }),
      launchEvent("Bought", { launch_id: laterPartnerLaunch, quote_in: 10n * SUI, protocol_quote_fee: 5n }),
    ], 3001, true, standardWallet);
    await collect();
    const beforeRateChange = (await readReferralSummary(db, standardOwner)).accounting!;
    assert.equal(beforeRateChange.share_bps, 6000);
    assert.equal(beforeRateChange.assets[0].earnings_atoms, "1");

    await admin.query(
      "INSERT INTO social_config (key,value,updated_by) VALUES ('referral_rate_policy',$1,'test')",
      [JSON.stringify({
        effective_at_ms: start + 3002,
        special_account_ids: [specialOwner],
        special_reservation_codes: [reservationCode],
      })],
    );
    const standardBeforeSettlement = (await readReferralSummary(db, standardOwner)).accounting!;
    assert.equal(standardBeforeSettlement.share_bps, 3000);
    assert.deepEqual(standardBeforeSettlement.assets, beforeRateChange.assets);
    await advance(3002);
    await receipt([...unpartneredBuy(4n), paid(laterSale, 11n)], 3002, true, standardWallet);
    await receipt([feePayment("launch", {
      origin: laterPartnerLaunch,
      quote_amount: 3n,
      partner_quote_amount: 2n,
      meme_amount: 0n,
      partner_meme_amount: 0n,
    })], 3002, true, standardWallet);
    await receipt([
      launchEvent("LaunchCreated", { launch_id: reservationLaunch, quote }),
      ...unpartneredBuy(5n, reservationLaunch),
    ], 3002, true, reservationWallet);
    await collect();
    const standard = (await readReferralSummary(db, standardOwner)).accounting!;
    assert.deepEqual((await readReferralMonths(db, standardOwner)).months.find(({ month }) => month === "2026-10"), {
      month: "2026-10", revenue_atoms: "21", share_bps: 3429, payment: null,
    });
    assert.equal(standard.assets[0].revenue_atoms, "21");
    assert.equal(standard.assets[0].earnings_atoms, "7"); // floor(3 × .6 + (4 + 11 + 3) × .3)
    assert.deepEqual((await readReferralInvitees(db, standardOwner, null)).invitees[0].accounting, standard);
    assert.equal((await readReferralSummary(db, specialOwner)).accounting!.share_bps, 6000);

    await admin.query("UPDATE social_accounts SET x_subject=$2 WHERE account_id=$1", [standardOwner, reservationSubject]);
    await admin.query(
      "UPDATE social_referral_reservations SET claimed_at=to_timestamp($2/1000.0) WHERE code=$1",
      [reservationCode, start + 3003],
    );
    await advance(3003);
    await receipt(unpartneredBuy(5n), 3003, true, standardWallet);
    await collect();
    const claimed = (await readReferralSummary(db, standardOwner)).accounting!;
    assert.equal(claimed.share_bps, 6000);
    assert.equal(claimed.assets[0].earnings_atoms, "13"); // prior 7 + new direct 3 + pre-claim reservation 3

    const payoutRecipient = objectId("e");
    const payoutSender = objectId("1");
    const payoutDigest = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
    await admin.query(
      "INSERT INTO social_account_wallets(address,account_id,verified_at) VALUES ($1,$2,now())",
      [payoutRecipient, owner],
    );
    let balanceCoin = USDC_COIN_TYPE;
    let lookupAvailable = true;
    const command = referralPaymentRecord({
      executed: async () => lookupAvailable ? ({
        success: true,
        sender: payoutSender,
        balanceChanges: [{ address: payoutRecipient, coinType: balanceCoin, amount: "1140000000" }],
      }) : null,
    });
    const payment = (month: string, accountId = owner) => runSocialOperatorInvocation(
      parseSocialOperatorInvocation([
        "referral", "record", accountId, month, payoutSender, payoutRecipient, payoutDigest, "1140000000", "--reason", "Manual payout",
      ], [command]),
      ADMIN_CONSOLE_OPERATOR,
      (operation, options) => withTransaction(admin, operation, options),
    );
    await assert.rejects(payment("2026-10"), { code: "OPERATOR_INPUT_INVALID" });
    balanceCoin = quote;
    await assert.rejects(payment("2026-10", impersonator), { code: "OPERATOR_INPUT_INVALID" });
    const recorded = { month: "2026-10", recipient: payoutRecipient, digest: payoutDigest, amount_atoms: "1140000000" };
    assert.deepEqual((await payment("2026-10")).result, { ...recorded, recorded: true });
    lookupAvailable = false;
    assert.deepEqual((await payment("2026-10")).result, { ...recorded, recorded: false });
    lookupAvailable = true;
    await assert.rejects(payment("2026-09"), { code: "OPERATOR_CONFLICT" });
    assert.deepEqual((await readReferralMonths(db, owner)).months.find(({ month }) => month === "2026-10"), {
      month: "2026-10", revenue_atoms: "1900000000", share_bps: 6000,
      payment: { amount_atoms: "1140000000", digest: payoutDigest },
    });
    assert.ok((await readReferralMonths(db, impersonator)).months.every(({ payment }) => payment === null));
    await assert.rejects(web.query("SELECT recipient FROM social_referral_payments"), { code: "42501" });
    await assert.rejects(web.query("DELETE FROM social_referral_payments"), { code: "42501" });

    const november = Date.UTC(2026, 10, 1);
    const nextCurve = objectId("9");
    await advance(3004);
    await receipt([
      launchEvent("LaunchCreated", { launch_id: nextCurve, quote }),
      launchEvent("Bought", { launch_id: nextCurve, quote_in: SUI, protocol_quote_fee: 9n }),
    ], 3004);
    await advance(3005, november);
    await receipt([feePayment("launch", { origin: nextCurve, quote_amount: 9n })], 3005, true, sender, november);
    await collect();
    const { months } = await readReferralMonths(db, owner);
    assert.equal(months.find(({ month }) => month === "2026-10")?.revenue_atoms, "1900000000");
    assert.equal(months.find(({ month }) => month === "2026-11")?.revenue_atoms, "9");

    const migration =
      "../../../../../packages/core/src/modules/database/migrations/0143_x_referral_revenue";
    await admin.query(
      await readFile(new URL(`${migration}.down.sql`, import.meta.url), "utf8"),
    );
    assert.equal(
      (
        await admin.query(
          "SELECT 1 FROM social_worker_state WHERE name='referral-accounting'",
        )
      ).rowCount,
      0,
    );
    await admin.query(
      await readFile(new URL(`${migration}.up.sql`, import.meta.url), "utf8"),
    );
    assert.equal(
      (await readReferralSummary(db, owner)).accounting!.as_of_ms,
      null,
      "a reapply starts with unpublished accounting until receipts replay",
    );
    assert.deepEqual((await readReferralMonths(db, owner)).months.find(({ month }) => month === "2026-10"), {
      month: "2026-10", revenue_atoms: null, share_bps: null,
      payment: { amount_atoms: "1140000000", digest: payoutDigest },
    });
    // Presale-only accounting retains exact amounts without requiring market coverage.
    await admin.query("DELETE FROM watermarks WHERE pipeline='market'");
    const presaleOnly = parseReferralAccountingProfile({
      ...accountingProfile,
      launchpad_original_package: null,
    });
    const presaleBoundary = {
      ...boundary,
      checkpoint: 200,
      checkpointDigest: "referral-checkpoint-200",
      timestampMs: start + 200,
    };
    await withTransaction(
      watcher,
      (tx) =>
        collectReferralRevenue(
          tx.forModule("social"),
          presaleBoundary,
          presaleOnly,
        ),
      { isolationLevel: "REPEATABLE READ" },
    );
    assert.equal(
      (await readReferralSummary(db, owner)).accounting!.as_of_ms,
      start + 200,
    );
    assert.ok(
      (
        await admin.query(
          "SELECT 1 FROM social_referral_events WHERE kind='presale_fee' LIMIT 1",
        )
      ).rowCount,
      "presale-only profile replays collected fees after an explicit rebuild",
    );
    assert.equal(
      (
        await admin.query(
          "SELECT 1 FROM social_referral_events WHERE kind='curve' LIMIT 1",
        )
      ).rowCount,
      0,
    );
    const savedCursor = (
      await admin.query(
        "SELECT value FROM social_worker_state WHERE name='referral-accounting'",
      )
    ).rows[0].value;
    const malformed = await receipt([commit(sale)], 201);
    await admin.query(
      "UPDATE blast_infra_fixture.transaction_evidence SET events=jsonb_set(events,'{0,bcs}',to_jsonb('!' || (events->0->>'bcs'))) WHERE digest=$1",
      [malformed],
    );
    await assert.rejects(
      withTransaction(
        watcher,
        (tx) =>
          collectReferralRevenue(
            tx.forModule("social"),
            {
              ...presaleBoundary,
              checkpoint: 201,
              checkpointDigest: "referral-checkpoint-201",
              timestampMs: start + 201,
            },
            presaleOnly,
          ),
        { isolationLevel: "REPEATABLE READ" },
      ),
      /receipt is incomplete/,
    );
    assert.deepEqual(
      (
        await admin.query(
          "SELECT value FROM social_worker_state WHERE name='referral-accounting'",
        )
      ).rows[0].value,
      savedCursor,
      "malformed base64 remains rejected without advancing the published cut",
    );
    await assert.rejects(
      withTransaction(
        watcher,
        (tx) =>
          collectReferralRevenue(
            tx.forModule("social"),
            {
              ...boundary,
              checkpoint: 200,
              checkpointDigest: "referral-checkpoint-200",
              timestampMs: start + 200,
            },
            accountingProfile,
          ),
        { isolationLevel: "REPEATABLE READ" },
      ),
      /profile changed/,
    );

    // #839: the evidence view encodes every Sui transaction's events, so a long
    // catch-up range is read in short windows, each its own statement.
    await admin.query(
      "DELETE FROM social_worker_state WHERE name='referral-accounting'",
    );
    await admin.query(
      "DELETE FROM blast_infra_fixture.transaction_evidence WHERE digest=$1",
      [malformed],
    );
    await admin.query(
      `INSERT INTO checkpoint_journal
      (checkpoint,network,digest,epoch,timestamp_ms,total_transactions,format_version,payload,payload_hash)
      SELECT cp,'mainnet','referral-checkpoint-'||cp,0,$1::bigint+cp,0,1,''::bytea,decode(repeat('00',32),'hex')
      FROM generate_series(202,1300) cp ON CONFLICT DO NOTHING`,
      [start],
    );
    const late = await receipt([commit(objectId("e"))], 1250);
    const windows: [number, number][] = [];
    const cursor = async () =>
      (
        await admin.query(
          "SELECT value FROM social_worker_state WHERE name='referral-accounting'",
        )
      ).rows[0]?.value;
    // Earlier receipts fill a page or two before the scan reaches the sparse range.
    for (
      let pass = 0;
      pass < 5 && (await cursor())?.complete_checkpoint !== "1300";
      pass++
    )
      await withTransaction(
        watcher,
        (tx) => {
          const social = tx.forModule("social");
          const spy = new Proxy(social, {
            get(target, key, receiver) {
              if (key !== "read") return Reflect.get(target, key, receiver);
              return (sql: string, params?: unknown[]) => {
                if (sql === REFERRAL_RECEIPTS_SQL)
                  windows.push([Number(params![0]), Number(params![2])]);
                return target.read(sql, params);
              };
            },
          });
          return collectReferralRevenue(
            spy,
            {
              ...boundary,
              checkpoint: 1300,
              checkpointDigest: "referral-checkpoint-1300",
              timestampMs: start + 1300,
            },
            accountingProfile,
          );
        },
        { isolationLevel: "REPEATABLE READ" },
      );
    assert.ok(windows.length > 1);
    for (const [after, through] of windows)
      assert.ok(through - after <= 100, `scan window ${after}..${through}`);
    assert.equal((await cursor()).complete_checkpoint, "1300");
    assert.ok(
      (
        await admin.query(
          "SELECT 1 FROM social_referral_events WHERE digest=$1",
          [late],
        )
      ).rowCount,
    );
  },
);
