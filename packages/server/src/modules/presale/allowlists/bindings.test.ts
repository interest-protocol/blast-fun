import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { allowlistedEligibility, openEligibility } from "@interest-protocol/blast-sdk/presale";
import type { ClientWithCoreApi } from "@mysten/sui/client";

import { PRESALE_ERRORS, type PresaleErrorCode } from "@blast/core/modules/presale/contracts/errors.ts";
import { PRESALE_ROUTES } from "@blast/core/modules/presale/contracts/routes.ts";
import { presaleIdentityFixture } from "../../../../../core/test/fixtures/modules/presale/deployment/fixtures.ts";
import { presaleFixtureObjectId, readPresaleDeploymentIdentity } from "@blast/core/modules/presale/deployment/service.ts";
import { PresaleRouteError } from "@blast/core/modules/presale/route-kit/errors.ts";
import { fixturePresaleId, presaleChainFixture } from "../../../../../core/test/fixtures/modules/presale/allowlists/fixtures.ts";
import { ALLOWLIST_MAX_ROWS, ALLOWLIST_BODY_LIMIT_BYTES } from "./upload.ts";
import { presaleEligibilityReader } from "./eligibility.ts";

const state = readPresaleDeploymentIdentity({ PRESALE_DEPLOYMENT_MANIFEST: JSON.stringify(presaleIdentityFixture()) });
assert.ok(state.status === "ready");
const identity = state.identity;
const ROOT = "4c".repeat(32);

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof PresaleRouteError, String(error));
    return error.code;
  }
  return "resolved";
}

test("the eligibility reader returns a sale's on-chain eligibility through the SDK's PresaleClient", async () => {
  const node = presaleChainFixture();
  const read = presaleEligibilityReader({ client: () => node });
  const allowlisted = node.createPresale("unit-allowlisted", allowlistedEligibility(ROOT, 7n));
  const open = node.createPresale("unit-open", openEligibility(10n, 5n, 1n));
  assert.deepEqual(await read(identity, allowlisted), { kind: "allowlisted", root: ROOT, leafCount: 7n });
  assert.deepEqual(await read(identity, open), { kind: "open", walletCap: 10n, maxParticipants: 5n, minCommitment: 1n });
  assert.equal(node.reads, 2);
});

test("no such presale is null: a missing object, another package's type, an owned object", async () => {
  const node = presaleChainFixture();
  const read = presaleEligibilityReader({ client: () => node });
  const sale = node.createPresale("unit-template", allowlistedEligibility(ROOT, 7n));
  const { content } = (await node.core.getObject({ objectId: sale, include: { content: true } })).object;
  const foreign = fixturePresaleId("unit-foreign");
  node.putObject(foreign, { type: `0x${"a".repeat(64)}::blast_presale::Presale<0x2::sui::SUI, 0x2::sui::SUI>`, content, shared: true });
  const policy = presaleFixtureObjectId("creation-policy");
  node.putObject(policy, { type: `${identity.presale.originalPackageId}::creation_policy::CreationPolicy`, content: new Uint8Array(), shared: true });
  const owned = fixturePresaleId("unit-owned");
  node.putObject(owned, { type: `${identity.presale.originalPackageId}::blast_presale::Presale<0x2::sui::SUI, 0x2::sui::SUI>`, content, shared: false });
  for (const objectId of [fixturePresaleId("unit-missing"), foreign, policy, owned]) {
    assert.equal(await read(identity, objectId), null, objectId);
  }
});

test("a node that is absent, failing or slow is deployment_unavailable", async () => {
  const failing = presaleChainFixture();
  failing.failing = true;
  assert.equal(await code(presaleEligibilityReader({ client: () => null })(identity, fixturePresaleId("x"))), "deployment_unavailable");
  assert.equal(await code(presaleEligibilityReader({ client: () => failing })(identity, fixturePresaleId("x"))), "deployment_unavailable");
  const hanging = { core: { getObject: () => new Promise<never>(() => undefined) } } as unknown as ClientWithCoreApi;
  const started = Date.now();
  assert.equal(await code(presaleEligibilityReader({ client: () => hanging, timeoutMs: 50 })(identity, fixturePresaleId("x"))), "deployment_unavailable");
  assert.ok(Date.now() - started < 2_000);
});

test("the agent skill documents the create, bind and proof calls, the key header, the CSV rules and every error code", () => {
  const skill = readFileSync(new URL("../../../../../../skills/presale-allowlist/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /^---\nname: presale-allowlist\ndescription: .+\n---\n/, "skill front matter");
  for (const call of [
    "POST /api/presale/allowlists",
    "POST /api/presale/allowlists/{allowlist_id}/bind",
    "GET /api/presale/presales/{presale_id}/proof?wallet=",
    "GET /api/presale/allowlists/{allowlist_id}",
  ]) {
    assert.ok(skill.includes(call), call);
  }
  assert.ok(skill.includes("X-Blast-Api-Key"));
  assert.ok(skill.includes("allowlistedEligibility(root, BigInt(leaf_count))"), "root and leaf count go to allowlistedEligibility");
  assert.equal(ALLOWLIST_MAX_ROWS, 65_536);
  assert.equal(ALLOWLIST_BODY_LIMIT_BYTES, 4 * 1_024 * 1_024);
  for (const rule of ["65,536", "4 MiB", "18446744073709551615", "wallet,cap", "row"]) assert.ok(skill.includes(rule), rule);
  const codes = new Set([
    ...PRESALE_ROUTES["POST /api/presale/allowlists"].errors,
    ...PRESALE_ROUTES["GET /api/presale/allowlists/{allowlist_id}"].errors,
    ...PRESALE_ROUTES["POST /api/presale/allowlists/{allowlist_id}/bind"].errors,
    ...PRESALE_ROUTES["GET /api/presale/presales/{presale_id}/proof"].errors,
  ]);
  // Every error-table row names a published code with its published status (Q-002, Q-003).
  const rows = [...skill.matchAll(/^\| `([a-z_]+)` \| ([0-9]{3}) \|/gm)].map(([, errorCode, status]) => ({ errorCode, status: Number(status) }));
  assert.ok(rows.length >= 36, `${rows.length} error rows`);
  for (const { errorCode, status } of rows) {
    assert.ok(Object.hasOwn(PRESALE_ERRORS, errorCode), `${errorCode} is not a published code`);
    assert.equal(status, PRESALE_ERRORS[errorCode as PresaleErrorCode].status, `${errorCode} status`);
  }
  const tabled = new Set(rows.map((row) => row.errorCode));
  for (const errorCode of codes) assert.ok(tabled.has(errorCode), `${errorCode} has no table row`);
});
