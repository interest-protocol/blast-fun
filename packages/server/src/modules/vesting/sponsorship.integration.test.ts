import { testClient } from "../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";
import { createPresaleDeploymentGate } from "@blast/core/modules/presale/deployment/service.ts";
import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool } from "@blast/core/modules/database/pool.ts";
import {
  fixtureChainNode,
  SUI_MAINNET_CHAIN_IDENTIFIER,
} from "../../../../core/test/fixtures/modules/presale/deployment/fixtures.ts";
import { createSponsorService } from "@blast/server/modules/sponsor/service.ts";
import { PostgresSponsorReservations } from "@blast/server/modules/sponsor/reservations.ts";
import { PostgresSponsorExecutions } from "@blast/server/modules/sponsor/executions.ts";
import {
  executeHarness,
  executeRequest,
} from "../../../test/fixtures/modules/sponsor/execute-fixtures.ts";
import {
  CAP,
  CLOCK,
  DID,
  OTHER_DID,
  SPONSOR,
  fixtureChain,
  identity,
  MemoryLimiter,
} from "../../../test/fixtures/modules/sponsor/route-fixtures.ts";
import { VESTING_PACKAGE } from "@blast/core/modules/vesting/model.ts";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;

test(
  "vesting reservations persist, bind to immutable attempts, execute once, and reject other accounts",
  { skip: !databaseUrl },
  async () => {
    const db = createPool(databaseUrl!, { max: 1 });
    const wallet = Ed25519Keypair.generate();
    const sender = wallet.toSuiAddress();
    try {
      await migrateDatabase(db);
      // Use the deployed web role for every reservation, attempt and execution query.
      await db.query("SET ROLE blast_web");
      const limits = new MemoryLimiter();
      const sponsor = createSponsorService({
        deployment: createPresaleDeploymentGate({
          environment: identity(),
          node: async () => fixtureChainNode(SUI_MAINNET_CHAIN_IDENTIFIER),
        }),
        wallets: { require: async () => sender },
        chain: fixtureChain().chain,
        reservations: new PostgresSponsorReservations(db),
        executions: { today: async () => ({ allowed: true }) },
        limits,
        config: () => ({
          sponsorAddress: SPONSOR,
          maxGasMist: CAP,
          swapTargets: [],
          tradeFee: () => null,
        }),
        clock: () => CLOCK,
      });
      const account = randomUUID();
      await db.query(
        "INSERT INTO social_accounts(account_id,privy_did,callsign) VALUES($1,$2,$3)",
        [account, DID, "sponsortest"],
      );
      for (const action of ["create", "claim", "cancel", "close"] as const) {
        const tx = new Transaction();
        tx.moveCall({
          target: `${VESTING_PACKAGE}::blast_fun_linear_vesting::${action}`,
        });
        const reserved = await sponsor.sponsor({
          intent: "vesting",
          presaleId: null,
          caller: { kind: "privy", did: DID },
          sender,
          kindBytes: await tx.build({ onlyTransactionKind: true }),
          ip: "203.0.113.9",
        });
        const bytes = fromBase64(reserved.transaction_bytes);
        const digest = TransactionDataBuilder.getDigestFromBytes(bytes);
        const id = randomUUID();
        await db.query(
          "INSERT INTO social_transactions(tx_id,account_id,kind,digest,idempotency_key,created_at_ms) VALUES($1,$2,$3,$4,$5,$6)",
          [
            id,
            account,
            `vesting_${action}`,
            digest,
            `vesting:${id}`,
            CLOCK.getTime(),
          ],
        );
        await db.query(
          "INSERT INTO social_vesting_attempts(request_id,account_id,sender,intent,transaction_bytes,digest,gas_budget,expires_at_ms,sponsor_reservation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            id,
            account,
            sender,
            { action },
            reserved.transaction_bytes,
            digest,
            reserved.gas_budget,
            reserved.expires_at_ms,
            reserved.reservation_id,
          ],
        );
        const stored = (
          await db.query(
            "SELECT a.digest,a.sponsor_reservation_id,r.intent,r.sender FROM social_vesting_attempts a JOIN presale_sponsor_reservations r ON r.id=a.sponsor_reservation_id WHERE a.request_id=$1",
            [id],
          )
        ).rows[0];
        assert.deepEqual(stored, {
          digest,
          sponsor_reservation_id: reserved.reservation_id,
          intent: "vesting",
          sender,
        });
        await assert.rejects(
          db.query(
            "UPDATE social_vesting_attempts SET sponsor_reservation_id=NULL WHERE request_id=$1",
            [id],
          ),
          /immutable/,
        );
        const executor = executeHarness({
          executions: new PostgresSponsorExecutions(db),
        });
        const { signature } = await wallet.signTransaction(bytes);
        assert.equal(
          (
            await executor.route(
              executeRequest(
                reserved.reservation_id,
                { user_signature: signature },
                { did: OTHER_DID },
              ), testClient()
            )
          ).status,
          404,
        );
        const first = await executor.route(
          executeRequest(reserved.reservation_id, {
            user_signature: signature,
          }), testClient()
        );
        assert.equal(
          first.status,
          200,
          JSON.stringify(await first.clone().json()),
        );
        assert.equal((await first.json()).digest, digest);
        assert.equal(
          (
            await executor.route(
              executeRequest(reserved.reservation_id, {
                user_signature: signature,
              }), testClient()
            )
          ).status,
          200,
        );
        assert.equal(executor.pool.state.submissions.length, 1);
        assert.equal(executor.consumed(), 1);
        assert.equal(
          (
            await db.query(
              "SELECT state FROM presale_sponsor_reservations WHERE id=$1",
              [reserved.reservation_id],
            )
          ).rows[0].state,
          "executed",
        );
      }
    } finally {
      await db.end();
    }
  },
);
