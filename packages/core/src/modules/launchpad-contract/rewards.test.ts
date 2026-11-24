import assert from "node:assert/strict";
import test from "node:test";

import { COIN_FIXTURE } from "../../../test/fixtures/modules/launchpad-coin/fixtures.ts";
import {
  creatorClaimsBody,
  launchRewardsBody,
  pendingCreatorClaimRow,
  walletHolderRewardsBody,
  walletLaunchRewardsBody,
} from "../../../test/fixtures/modules/launchpad-coin/rewards-fixtures.ts";
import { CursorError, encodeCursor } from "./cursor.ts";
import { ContractViolation } from "./decimal.ts";
import {
  LAUNCHPAD_POLICY_PATH,
  PARTNERS_CURSOR,
  creatorClaimsCursor,
  creatorClaimsPath,
  parseCreatorClaimsPage,
  launchRewardsPath,
  partnerLaunchesCursor,
  partnerLaunchesPath,
  partnerPath,
  parseLaunchRewards,
  parseWalletHolderRewardsPage,
  parseWalletLaunchRewardsPage,
  partnersPath,
  rewardRoundsCursor,
  rewardRoundsPath,
  walletHolderRewardsPath,
  walletLaunchRewardsCursor,
  walletLaunchRewardsPath,
  walletLaunchesPath,
} from "./rewards.ts";

const LAUNCH = `0x${"1".repeat(64)}`;
const WALLET = `0x${"2".repeat(64)}`;
const PARTNER = `0x${"3".repeat(64)}`;
const POSITION = ["00000000000000000009", "00000000000000000001", "00000000000000000002"];

test("each path is its /v1 read, with the default page and the token it was given", () => {
  const launches = encodeCursor(walletLaunchRewardsCursor(WALLET), [], POSITION);
  assert.equal(launchRewardsPath(LAUNCH), `/v1/launches/${LAUNCH}/rewards`);
  assert.equal(rewardRoundsPath(LAUNCH, {}), `/v1/launches/${LAUNCH}/reward-rounds?limit=25`);
  assert.equal(
    rewardRoundsPath(LAUNCH, { limit: "3", cursor: encodeCursor(rewardRoundsCursor(LAUNCH), [], ["00000000000000000004"]) }),
    `/v1/launches/${LAUNCH}/reward-rounds?limit=3&cursor=${encodeCursor(rewardRoundsCursor(LAUNCH), [], ["00000000000000000004"])}`,
  );
  assert.equal(walletLaunchRewardsPath(WALLET, { cursor: launches }), `/v1/wallets/${WALLET}/launch-rewards?limit=25&cursor=${launches}`);
  assert.equal(walletHolderRewardsPath(WALLET, { limit: "100" }), `/v1/wallets/${WALLET}/vault-rewards?limit=100`);
  assert.equal(walletLaunchesPath(WALLET, {}), `/v1/wallets/${WALLET}/launches?limit=25`);
  assert.equal(partnersPath({ cursor: encodeCursor(PARTNERS_CURSOR, [], [PARTNER]) }), `/v1/partners?limit=25&cursor=${encodeCursor(PARTNERS_CURSOR, [], [PARTNER])}`);
  assert.equal(partnerPath(PARTNER), `/v1/partners/${PARTNER}`);
  assert.equal(partnerLaunchesPath(PARTNER, { limit: "1" }), `/v1/partners/${PARTNER}/launches?limit=1`);
  assert.equal(LAUNCHPAD_POLICY_PATH, "/v1/launchpad/policy");
});

test("a token is its own list's: another list's, another wallet's or another partner's is refused", () => {
  const walletToken = encodeCursor(walletLaunchRewardsCursor(WALLET), [], POSITION);
  assert.throws(() => walletLaunchesPath(WALLET, { cursor: walletToken }), CursorError);
  assert.throws(() => walletLaunchRewardsPath(PARTNER, { cursor: walletToken }), CursorError);
  assert.throws(() => partnerLaunchesPath(WALLET, { cursor: encodeCursor(partnerLaunchesCursor(PARTNER), [], POSITION) }), CursorError);
  assert.throws(() => rewardRoundsPath(LAUNCH, { cursor: walletToken }), CursorError);
});

test("IDs are canonical and limits are 1 to 100", () => {
  for (const build of [
    () => launchRewardsPath("0x1"),
    () => partnerPath(PARTNER.toUpperCase()),
    () => walletLaunchesPath(`${WALLET}0`, {}),
    () => walletLaunchesPath(WALLET, { limit: "0" }),
    () => partnersPath({ limit: "101" }),
    () => partnerLaunchesPath(PARTNER, { limit: "1e2" }),
  ]) {
    assert.throws(build, CursorError);
  }
});

test("a launch's rewards parse exactly: both ledgers, the partner's paid amounts, and no vault before migration", () => {
  const live = parseLaunchRewards(COIN_FIXTURE.launchId, launchRewardsBody("live", 0));
  assert.equal(live.vault, null);
  assert.deepEqual(live.creator.quote, { accrued: 410_000_000n, claimed: 0n, outstanding: 410_000_000n });
  assert.equal(live.protocol.sui.accrued, 2_000_000_000n);
  const migrated = parseLaunchRewards(COIN_FIXTURE.launchId, launchRewardsBody("migrated", 0));
  assert.equal(migrated.partner?.paidSui, 200_000_000n);
  assert.deepEqual(migrated.vault?.creator.meme, { accrued: 450_000_000n, claimed: 400_000_000n, outstanding: 50_000_000n });
  assert.deepEqual(migrated.vault?.deployed.buyback, { memeBurned: 30_000_000n, quoteSpent: 40_000_000n });
  assert.deepEqual(migrated.vault?.returned.rewards, { meme: 270_000_000n, quote: 135_000_000n });
});

test("an answer that breaks the contract is a violation, never a guess", () => {
  type Body = { launch_id: string; creator: { meme: { outstanding: string } }; protocol?: { held: { quote: string } }; vault: { collected: { gross: { meme: unknown } }; auto_lp: Record<string, unknown> } };
  const body = () => launchRewardsBody("migrated", 0) as unknown as Body;
  const broken: [string, (value: Body) => void][] = [
    ["another launch", (value) => (value.launch_id = LAUNCH)],
    ["outstanding is not accrued less claimed", (value) => (value.creator.meme.outstanding = "1")],
    ["payments plus held differ from accrued", (value) => (value.protocol!.held.quote = "1")],
    ["a number for an amount", (value) => (value.vault.collected.gross.meme = 5)],
    ["an unknown field", (value) => (value.vault.auto_lp.extra = { meme: "0", quote: "0" })],
    ["a missing ledger", (value) => delete value.protocol],
  ];
  for (const [why, change] of broken) {
    const value = body();
    change(value);
    assert.throws(() => parseLaunchRewards(COIN_FIXTURE.launchId, value), ContractViolation, why);
  }
});

test("a wallet's launch rewards parse with both ledgers, the decimals to show them, and outstanding across them", () => {
  const live = parseWalletLaunchRewardsPage(WALLET, walletLaunchRewardsBody(WALLET, "live", 0));
  assert.equal(live.launches[0]?.vault, null);
  assert.equal(live.launches[0]?.symbol, "FROGGY");
  assert.equal(live.launches[0]?.memeDecimals, 6);
  const migrated = parseWalletLaunchRewardsPage(WALLET, walletLaunchRewardsBody(WALLET, "migrated", 0)).launches[0]!;
  assert.deepEqual(migrated.outstanding, { meme: 9_800_000_000n + 50_000_000n, quote: 349_000_000n + 25_000_000n });
  const broken = walletLaunchRewardsBody(WALLET, "migrated", 0) as unknown as { launches: [{ outstanding: { meme: string } }] };
  broken.launches[0].outstanding.meme = "1";
  assert.throws(() => parseWalletLaunchRewardsPage(WALLET, broken), ContractViolation, "outstanding is both ledgers'");
  assert.throws(() => parseWalletLaunchRewardsPage(PARTNER, walletLaunchRewardsBody(WALLET, "live", 0)), ContractViolation, "another wallet's page");
});

test("a wallet's payouts parse newest first; an out-of-order page is a violation", () => {
  const page = parseWalletHolderRewardsPage(WALLET, walletHolderRewardsBody(WALLET, 0));
  assert.deepEqual(page.payouts.map((payout) => [payout.position, payout.memeAmount]), [["326200000:4:2:0", 40_000_000n], ["326150000:4:2:0", 15_000_000n]]);
  assert.equal(page.payouts[0]?.quoteDecimals, null);
  const reversed = walletHolderRewardsBody(WALLET, 0) as unknown as { payouts: unknown[] };
  reversed.payouts.reverse();
  assert.throws(() => parseWalletHolderRewardsPage(WALLET, reversed), ContractViolation);
});

const COMMITMENT = "7c".repeat(32);
const BY_WALLET = { kind: "address", address: WALLET } as const;
const BY_ACCOUNT = { kind: "account", commitment: COMMITMENT } as const;

test("LP-17: a creator-claims path names exactly one recipient, and its token is that recipient's own", () => {
  assert.equal(creatorClaimsPath(BY_WALLET, {}), `/v1/creator-claims?recipient=${WALLET}&limit=25`);
  assert.equal(creatorClaimsPath(BY_ACCOUNT, { limit: "100" }), `/v1/creator-claims?account=${COMMITMENT}&limit=100`);
  // blast-infra's scope: `creator_claims:<kind>:<named>`.
  assert.equal(creatorClaimsCursor(BY_WALLET).scope, `creator_claims:address:${WALLET}`);
  assert.equal(creatorClaimsCursor(BY_ACCOUNT).scope, `creator_claims:account:${COMMITMENT}`);
  const accountToken = encodeCursor(creatorClaimsCursor(BY_ACCOUNT), [], POSITION);
  assert.equal(creatorClaimsPath(BY_ACCOUNT, { cursor: accountToken }), `/v1/creator-claims?account=${COMMITMENT}&limit=25&cursor=${accountToken}`);
  for (const build of [
    () => creatorClaimsPath(BY_WALLET, { cursor: accountToken }),
    () => creatorClaimsPath({ kind: "account", commitment: "7d".repeat(32) }, { cursor: accountToken }),
    () => creatorClaimsPath({ kind: "account", commitment: `0x${COMMITMENT}` }, {}),
    () => creatorClaimsPath({ kind: "account", commitment: COMMITMENT.toUpperCase() }, {}),
    () => creatorClaimsPath({ kind: "address", address: "0x1" }, {}),
    () => creatorClaimsPath(BY_WALLET, { limit: "101" }),
  ]) {
    assert.throws(build, CursorError);
  }
});

test("LP-17: a recipient's pending creator claims parse from discovery rows, newest first, for both recipient kinds", () => {
  const OTHER = `0x${"a2".repeat(32)}`;
  const rows = [pendingCreatorClaimRow(OTHER, "326000000:1:1:0", "opening_round"), pendingCreatorClaimRow()];
  const page = parseCreatorClaimsPage(BY_ACCOUNT, creatorClaimsBody(BY_ACCOUNT, 0, rows));
  assert.deepEqual(page.launches.map((row) => [row.launchId, row.lifecycle, row.symbol]), [[OTHER, "opening_round", "FROGGY"], [COIN_FIXTURE.launchId, "live", "FROGGY"]]);
  assert.equal(page.launches[1]?.name, "Froggy");
  assert.equal(page.nextCursor, null);
  const wallet = parseCreatorClaimsPage(BY_WALLET, creatorClaimsBody(BY_WALLET, 0));
  assert.equal(wallet.launches[0]?.launchId, COIN_FIXTURE.launchId);
  const next = encodeCursor(creatorClaimsCursor(BY_ACCOUNT), [], ["00000000000325874009", "00000000000000000001", "00000000000000000002"]);
  assert.equal(parseCreatorClaimsPage(BY_ACCOUNT, creatorClaimsBody(BY_ACCOUNT, 0, rows, next)).nextCursor, next);
  assert.deepEqual(parseCreatorClaimsPage(BY_WALLET, creatorClaimsBody(BY_WALLET, 0, [])).launches, []);
});

test("LP-17: a creator-claims page that breaks the contract is a violation, never another recipient's list", () => {
  const OTHER = `0x${"a2".repeat(32)}`;
  const body = (launches = [pendingCreatorClaimRow()], next: string | null = null) => creatorClaimsBody(BY_ACCOUNT, 0, launches, next);
  const broken: [string, unknown][] = [
    ["another account's list", creatorClaimsBody({ kind: "account", commitment: "7d".repeat(32) }, 0)],
    ["the wallet's list for the account", { ...creatorClaimsBody(BY_WALLET, 0), recipient: COMMITMENT }],
    ["out of creation order", body([pendingCreatorClaimRow(), pendingCreatorClaimRow(OTHER, "326000000:1:1:0")])],
    ["a launch twice", body([pendingCreatorClaimRow(COIN_FIXTURE.launchId, "326000000:1:1:0"), pendingCreatorClaimRow()])],
    ["a venue pool", body([{ ...pendingCreatorClaimRow(), venue: "cetus" }])],
    ["a pool key of another launch", body([{ ...pendingCreatorClaimRow(), pool_key: `blast_curve:${OTHER}` }])],
    ["no metadata field", body([Object.fromEntries(Object.entries(pendingCreatorClaimRow()).filter(([key]) => key !== "metadata"))])],
    ["a next cursor of another list", body([pendingCreatorClaimRow()], encodeCursor(creatorClaimsCursor(BY_WALLET), [], POSITION))],
    ["a next cursor past the last row", body([pendingCreatorClaimRow()], encodeCursor(creatorClaimsCursor(BY_ACCOUNT), [], POSITION))],
    ["an unknown field", { ...body(), extra: true }],
  ];
  for (const [why, value] of broken) assert.throws(() => parseCreatorClaimsPage(BY_ACCOUNT, value), ContractViolation, why);
});
