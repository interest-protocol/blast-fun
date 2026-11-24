import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { SuiGrpcClient } from "@mysten/sui/grpc";
import { fromHex } from "@mysten/sui/utils";

import { presaleIdentityFixture } from "../../../../../core/test/fixtures/modules/presale/deployment/fixtures.ts";
import { parsePresaleRuntimeIdentity } from "@blast/core/modules/presale/deployment/service.ts";
import { readBluefinCreateOptions } from "@blast/server/modules/social/create/bluefin-chain.ts";
import { bluefinCreationIssue, bluefinTierSupported } from "@blast/core/modules/social/create/bluefin-options.ts";

const ready = { status: "ready", min_tick: -443_636, max_tick: 443_636 } as const;

test("Bluefin admits its inclusive contract bounds without requiring a Cetus fee tier", () => {
  assert.ok(bluefinTierSupported(ready, 1, 1));
  assert.ok(bluefinTierSupported(ready, 400, 20_000));
  assert.ok(bluefinTierSupported(ready, 17, 1_234));
  assert.equal(bluefinCreationIssue(ready, 17, 1_234), null);

  for (const [spacing, fee] of [[0, 1], [401, 1], [1.5, 1], [NaN, 1], [1, 0], [1, 20_001], [1, 1.5], [1, Infinity]]) {
    assert.equal(bluefinTierSupported(ready, spacing!, fee!), false);
    assert.match(bluefinCreationIssue(ready, spacing!, fee!)!, /tick spacing and pool fee/);
  }
});

test("Bluefin refuses unreadable config and spacings with no usable full-range position", () => {
  assert.equal(bluefinTierSupported({ status: "unavailable" }, 60, 3_000), false);
  assert.match(bluefinCreationIssue({ status: "unavailable" }, 60, 3_000)!, /could not be verified/);
  assert.equal(bluefinTierSupported({ status: "ready", min_tick: -10, max_tick: 10 }, 60, 3_000), false);
  assert.ok(bluefinTierSupported({ status: "ready", min_tick: -10, max_tick: 10 }, 10, 3_000));
  assert.equal(bluefinTierSupported({ status: "ready", min_tick: 10, max_tick: -10 }, 10, 3_000), false);
});

const configId = "0x03db251ba509a8d5d8777b6338836082335d93eecbdd09a11e190a1cff51c352";
const identity = {
  ...parsePresaleRuntimeIdentity(presaleIdentityFixture(), { production: false }),
  venues: { bluefin: { globalConfig: { objectId: configId, initialSharedVersion: "42" } } },
};

// Literal Move content from the contracts fork snapshot's bluefin_global_config.bcs.
const content = fromHex("03db251ba509a8d5d8777b6338836082335d93eecbdd09a11e190a1cff51c3520c3bf9fff4c4060009000000000000000237a8d55f29e5b4bdba0cb3fe0ba51a93db8c868fe0de649e1bf36bb42ea7d959d93a8eb06f41f953b872f90008cc7fac99c6d66e77e20dad301d5d5ee6c55c14");
const object = {
  objectId: configId,
  type: "0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267::config::GlobalConfig",
  owner: { $kind: "Shared", Shared: { initialSharedVersion: "42" } },
  content,
};

test("Bluefin reads the deployed config's signed ticks and exact shared identity", async () => {
  const client = new SuiGrpcClient({ network: "mainnet", baseUrl: "https://example.invalid" });
  const read = mock.method(client.core, "getObject", async () => ({ object }));
  assert.deepEqual(await readBluefinCreateOptions(client, identity), ready);
  assert.equal(read.mock.calls[0]!.arguments[0]!.objectId, configId);
  assert.deepEqual(read.mock.calls[0]!.arguments[0]!.include, { content: true });
  assert.ok(read.mock.calls[0]!.arguments[0]!.signal instanceof AbortSignal);
});

test("Bluefin fails closed on absent deployment, RPC failures, foreign objects, or malformed BCS", async () => {
  assert.deepEqual(await readBluefinCreateOptions(null, identity), { status: "unavailable" });
  const client = new SuiGrpcClient({ network: "mainnet", baseUrl: "https://example.invalid" });
  mock.method(client.core, "getObject", async () => { throw new Error("RPC unavailable"); });
  assert.deepEqual(await readBluefinCreateOptions(client, identity), { status: "unavailable" });
  assert.deepEqual(await readBluefinCreateOptions(client, { ...identity, venues: {} }), { status: "unavailable" });

  const wrongUid = content.slice();
  wrongUid[0] = 255;
  const emptyRange = content.slice();
  emptyRange.set(emptyRange.slice(32, 36), 36);
  for (const malformed of [
    { ...object, objectId: "0x1" },
    { ...object, type: "0x1::config::GlobalConfig" },
    { ...object, owner: { $kind: "Immutable" } },
    { ...object, owner: { $kind: "Shared", Shared: { initialSharedVersion: "43" } } },
    { ...object, content: content.slice(0, 20) },
    { ...object, content: new Uint8Array([...content, 0]) },
    { ...object, content: wrongUid },
    { ...object, content: emptyRange },
  ]) {
    const node = new SuiGrpcClient({ network: "mainnet", baseUrl: "https://example.invalid" });
    mock.method(node.core, "getObject", async () => ({ object: malformed }));
    assert.deepEqual(await readBluefinCreateOptions(node, identity), { status: "unavailable" });
  }
});
