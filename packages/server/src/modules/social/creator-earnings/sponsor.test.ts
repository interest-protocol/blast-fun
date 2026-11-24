import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { MigratorTransactions } from "@interest-protocol/blast-sdk/migrators";
import { bcs } from "@mysten/sui/bcs";
import { toBase64 } from "@mysten/sui/utils";
import { parsePresaleRuntimeIdentity } from "@blast/core/modules/presale/deployment/service.ts";
import {
  PRESALE_ID,
  SENDER,
  SALE_TOKEN,
  QUOTE,
  VAULT_ID,
} from "../../../../../core/test/fixtures/modules/sponsor/fixtures.ts";
import {
  harness,
  identity,
  fixtureChain,
  post,
  sponsorBody,
  assertError,
} from "../../../../test/fixtures/modules/sponsor/route-fixtures.ts";

const deployment = parsePresaleRuntimeIdentity(JSON.parse(identity().PRESALE_DEPLOYMENT_MANIFEST), {
  production: false,
});
const ref = (objectId: string) => ({ objectId, initialSharedVersion: "7", mutable: true as const });
async function collection() {
  return new MigratorTransactions(deployment.presale.migrators)
    .collectCetusFees({
      memeType: SALE_TOKEN,
      quoteType: QUOTE,
      vault: ref(VAULT_ID),
      pool: ref(`0x${"ab".repeat(32)}`),
      currency: ref(`0x${"cd".repeat(32)}`),
      cetus: { config: deployment.venues.cetus!.globalConfig, burnManager: deployment.venues.cetus!.burnManager },
    })
    .build({ onlyTransactionKind: true });
}

test("sponsor accepts exactly the live SDK rebuild and refuses extra commands, altered inputs and missing authority", async () => {
  const bytes = await collection();
  const chain = fixtureChain().chain;
  const creatorKind = async (sale: string, vault: string, sender: string) =>
    sale === PRESALE_ID && vault === VAULT_ID && sender === SENDER ? bytes : null;
  const h = harness({ chain: { ...chain, creatorKind } });
  const response = await h.route(
    post(await sponsorBody({ intent: "claim", transaction_kind_bytes: toBase64(bytes) })), testClient()
  );
  assert.equal(response.status, 200, await response.text());
  const extras = bcs.TransactionKind.parse(bytes);
  extras.ProgrammableTransaction!.commands.push(extras.ProgrammableTransaction!.commands[0]!);
  const altered = bcs.TransactionKind.parse(bytes);
  altered.ProgrammableTransaction!.inputs[0]!.Object!.SharedObject!.mutable = false;
  for (const candidate of [extras, altered]) {
    const rejected = harness({ chain: { ...chain, creatorKind } });
    await assertError(
      await rejected.route(
        post(
          await sponsorBody({
            intent: "claim",
            transaction_kind_bytes: toBase64(bcs.TransactionKind.serialize(candidate).toBytes()),
          }),
        ), testClient()
      ),
      "target_not_allowed",
    );
    assert.equal(rejected.chain.state.simulated.length, 0);
    assert.equal(rejected.reservations.rows.length, 0);
  }
  const refused = harness({ chain: { ...chain, creatorKind: async () => null } });
  await assertError(
    await refused.route(
      post(await sponsorBody({ intent: "claim", transaction_kind_bytes: toBase64(bytes) })), testClient()
    ),
    "target_not_allowed",
  );
});
