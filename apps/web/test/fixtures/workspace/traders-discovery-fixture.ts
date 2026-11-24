import {
  seedChainRead,
  type ChainActivityRow,
} from "../../../../../packages/core/test/fixtures/modules/database/chain-read-rows.ts";
import { advanceWatermark } from "../../../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import {
  createPresalesDiscoveryFixture,
  discoveryId,
} from "./presales-discovery-fixture.ts";

export const traderFixtureParameters = {
  accounts: 128,
  eligible: 125,
  activity: 250,
  presales: 7,
  maximum_rows_per_table: 1000,
};
const uuid = (index: number) =>
  `00000000-0000-4000-8000-${(1000 + index).toString(16).padStart(12, "0")}`;
const wallet = (index: number) => discoveryId(10000 + index);
const coinType = `${discoveryId(11)}::coin::SALE1`;

/** Real global P&L reads over <=250 rows per table in the owned disposable DB. */
export async function createTradersDiscoveryFixture(
  databaseUrl: string,
  now: number,
  prepare = true,
) {
  const fixture = await createPresalesDiscoveryFixture(
    databaseUrl,
    now,
    prepare,
  );
  if (prepare) {
    const accounts = Array.from(
      { length: traderFixtureParameters.accounts },
      (_, index) => ({
        account_id: uuid(index),
        callsign: `trader${String(index).padStart(3, "0")}`,
        display_name: `Trader ${index}`,
        wallet: wallet(index),
      }),
    );
    await fixture.admin.query(
      `INSERT INTO social_accounts (account_id, privy_did, callsign, display_name, x_subject, x_handle, privacy, sharing_since, onboarded_at, portfolio_public)
      SELECT account_id::uuid, 'did:privy:' || callsign, callsign, display_name, 'x-' || callsign, 'x' || callsign, 'public', to_timestamp($2 / 1000.0), to_timestamp($2 / 1000.0), true
      FROM jsonb_to_recordset($1::jsonb) AS r(account_id text, callsign text, display_name text)`,
      [JSON.stringify(accounts), now - 7 * 86_400_000],
    );
    await fixture.admin.query(
      `INSERT INTO social_account_wallets (account_id, address, verified_at, kind)
      SELECT account_id::uuid, wallet, to_timestamp($2 / 1000.0), 'embedded' FROM jsonb_to_recordset($1::jsonb) AS r(account_id text, wallet text)`,
      [JSON.stringify(accounts), now - 7 * 86_400_000],
    );
    await fixture.admin.query(
      `INSERT INTO blast_infra_fixture.wallet_sync(owner, timestamp_ms)
      SELECT wallet, $2 FROM jsonb_to_recordset($1::jsonb) AS r(wallet text)`,
      [JSON.stringify(accounts.filter((_, index) => index !== 126)), now],
    );
    await fixture.admin.query(
      "UPDATE social_accounts SET portfolio_public = false WHERE account_id = $1",
      [uuid(125)],
    );
    await fixture.admin.query(
      "UPDATE social_accounts SET privacy = 'private', sharing_since = NULL WHERE account_id = $1",
      [uuid(127)],
    );
    await fixture.admin.query(
      "UPDATE blast_infra_fixture.presales SET lifecycle = 'migrated', start_ms = $1, end_ms = $2 WHERE presale_id = $3",
      [now - 7 * 86_400_000, now - 6 * 86_400_000, discoveryId(11)],
    );
    const activity: ChainActivityRow[] = accounts
      .slice(0, 125)
      .flatMap((account, index) =>
        [0, 1].map((side) => ({
          checkpoint: 1000 + index * 2 + side,
          tx_slot: 0,
          event_slot: 0,
          part: 0,
          timestamp_ms:
            now - (index === 0 ? 3_600_000 : 2 * 86_400_000) + side * 1000,
          digest: `T009${index}Side${side}`.padEnd(44, "4"),
          kind: side === 0 ? "trade_buy" : "trade_sell",
          product: "market" as const,
          actor: account.wallet,
          tx_sender: account.wallet,
          presale_id: discoveryId(11),
          coin_type: coinType,
          quote_type:
            "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
          quote_amount: "1000000000",
          coin_amount: "1000000000",
          quote_refund: null,
          usd_value: side === 0 ? "1.00" : `${126 - index}.00`,
          usd_price_as_of_ms: now - 1000,
          venue: "cetus",
          participants_after: null,
          total_commitments_after: null,
        })),
      );
    await seedChainRead(fixture.admin, {
      activity,
      prices: [
        { coin_type: `${discoveryId(10)}::coin::KSTL`, usd_price: "0.50", as_of_ms: now - 600_000, source: "pool" },
        {
          coin_type: coinType,
          usd_price: "1.00",
          as_of_ms: now,
          source: "pool",
        },
      ],
      coin_balances: [
        {
          coin_type: coinType,
          owner: wallet(0),
          balance: "1",
          updated_checkpoint: 1500,
        },
        {
          coin_type: `${discoveryId(10)}::coin::KSTL`,
          owner: wallet(0),
          balance: "1234500000001",
          updated_checkpoint: 1500,
        },
      ],
    });
    await fixture.admin.query(advanceWatermark(2000, 0, "market"));
  }
  return fixture;
}
