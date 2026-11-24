import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { bcs } from "@mysten/sui/bcs";
import { ObjectError } from "@mysten/sui/client";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { fromHex } from "@mysten/sui/utils";

import { parsePresaleRuntimeIdentity } from "@blast/core/modules/presale/deployment/service.ts";
import { presaleIdentityFixture } from "../../../../../core/test/fixtures/modules/presale/deployment/fixtures.ts";
import { CREATE_QUOTES, CREATE_QUOTE_TYPE, CREATE_SUI_QUOTE_TYPE, CREATE_USDSUI_QUOTE_TYPE, CREATE_WAL_QUOTE_TYPE } from "@blast/core/modules/social/contracts/create.ts";
import { blankDraft } from "@blast/core/modules/social/create/model.ts";
import { readCreateCetusTiers } from "@blast/server/modules/social/create/cetus-chain.ts";
import { cetusDraftIssue, cetusTiersForQuote } from "@blast/core/modules/social/create/cetus-options.ts";

// Literal Move contents from the contracts' Cetus fork snapshot.
const configBytes = fromHex("daa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8fd00700000000000010020000000200000064000000000000000a0000000a000000f4010000000000003c0000003c000000c409000000000000c8000000c800000010270000000000001400000014000000e803000000000000dc000000dc000000204e0000000000000400000004000000c80000000000000006000000060000002c01000000000000080000000800000090010000000000001e0000001e000000dc050000000000002800000028000000d0070000000000005000000050000000b80b0000000000006400000064000000a00f00000000000078000000780000007017000000000000a0000000a0000000401f0000000000000401000004010000409c000000000000cf1897ae0793665f0e3f676d86450675bbf31842fde1aa02613b7b53f34b764c01aabf2fedcb36146db164bec930b74a47969c4df98216e049342a3c49b6d11580012891c6b8dca29a075d263c1bb21c7b88adf3ff6baddae1b8743cc00b66bd2c4706000000000000000e00000000000000");
const managerBytes = fromHex("8f61c973cac8a71b7205b81715ad39c1f4263fbf92d1443406b5f108d6aae2747b587b9329d05db877dc01a56488eaa0bbe826a8e9ed518b75b717dac3ceeaa10600000000000000456aaa15dee8d83fd90dd708713a5e79a92e3c86443455c296f4c47765cae2398e03000000000000305b1eeeec9abbbc6d5542b26483b0579683d17b9c7c966b9162702afa1ed1d78e03000000000000d446137a54beadccf9ee76eb8ef9993670e1c48feefaaa9410c866fdddbcff828e03000000000000");
const configId = `0x${Buffer.from(configBytes.subarray(0, 32)).toString("hex")}`;
const managerId = `0x${Buffer.from(managerBytes.subarray(0, 32)).toString("hex")}`;
const tableId = `0x${Buffer.from(managerBytes.subarray(32, 64)).toString("hex")}`;
const pkg = "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb";
const base = parsePresaleRuntimeIdentity(presaleIdentityFixture(), { production: false });
const identity = { ...base, venues: { cetus: { ...base.venues.cetus!, globalConfig: { objectId: configId, initialSharedVersion: "42" } } } };
const object = { objectId: configId, type: `${pkg}::config::GlobalConfig`, owner: { $kind: "Shared", Shared: { initialSharedVersion: "42" } }, content: configBytes };

function client() {
  const node = new SuiGrpcClient({ network: "mainnet", baseUrl: "https://example.invalid" });
  mock.method(node.core, "getObject", async () => ({ object }));
  mock.method(node.core, "getDynamicObjectField", async () => ({ object: { objectId: managerId, type: "0x157468379cfe5616c063ae39a889dd184ad48350d3e08f8d9b4ade22b8e3fb61::factory::PermissionPairManager", content: managerBytes } }));
  return node;
}

test("Cetus intersects registered fees with each quote's reservation spacings", async () => {
  const node = client();
  const read = mock.method(node.core, "getDynamicField", async (input: Parameters<typeof node.core.getDynamicField>[0]) => {
    assert.equal(input.parentId, tableId);
    assert.equal(input.name.type, "0x1::type_name::TypeName");
    const quote = `0x${bcs.string().parse(input.name.bcs)}`;
    if (quote !== CREATE_SUI_QUOTE_TYPE && quote !== CREATE_QUOTE_TYPE && quote !== CREATE_WAL_QUOTE_TYPE) throw new ObjectError("dynamicFieldNotFound", "No quote permission", { reason: "notFound" });
    return { dynamicField: { value: { type: "0x2::vec_set::VecSet<u32>", bcs: bcs.vector(bcs.u32()).serialize([200, 999]).toBytes() } } };
  });
  const tiers = await readCreateCetusTiers(node, identity);
  assert.ok(tiers);
  assert.deepEqual(tiers[CREATE_SUI_QUOTE_TYPE], [[200, 10_000]]);
  assert.deepEqual(tiers[CREATE_QUOTE_TYPE], [[200, 10_000]]);
  assert.deepEqual(tiers[CREATE_USDSUI_QUOTE_TYPE], []);
  assert.deepEqual(tiers[CREATE_WAL_QUOTE_TYPE], [[200, 10_000]]);
  assert.equal(read.mock.callCount(), CREATE_QUOTES.length);
});

test("Cetus distinguishes unsupported quotes from failed or malformed chain reads", async () => {
  const node = client();
  mock.method(node.core, "getDynamicField", async () => { throw new Error("RPC unavailable"); });
  assert.equal(await readCreateCetusTiers(node, identity), null);
  assert.deepEqual(await readCreateCetusTiers(node, { ...identity, venues: {} }), {});
  mock.method(node.core, "getDynamicField", async () => ({ dynamicField: { value: { type: "u32", bcs: bcs.u32().serialize(200).toBytes() } } }));
  assert.equal(await readCreateCetusTiers(node, identity), null);
  for (const malformed of [
    { ...object, type: "0x1::config::GlobalConfig" },
    { ...object, objectId: "0x1" },
    { ...object, owner: { $kind: "Shared", Shared: { initialSharedVersion: "43" } } },
    { ...object, content: configBytes.slice(0, 20) },
  ]) {
    mock.method(node.core, "getObject", async () => ({ object: malformed }));
    assert.equal(await readCreateCetusTiers(node, identity), null);
  }
});

test("Cetus rejects stale fees, unsupported quotes and unavailable configuration", () => {
  const supported = { [CREATE_QUOTE_TYPE]: [[200, 10_000], [60, 99_999], [999, 250]] } as const;
  assert.deepEqual(cetusTiersForQuote(CREATE_QUOTE_TYPE, supported), [[200, 10_000]]);
  const draft = { ...blankDraft(), venue: "cetus" } as const;
  assert.equal(cetusDraftIssue({ ...draft, pool_fee: 10_000 }, supported), null);
  assert.equal(cetusDraftIssue({ ...draft, pool_fee: 250 }, supported)?.path, "pool_fee");
  assert.equal(cetusDraftIssue({ ...draft, quote_type: CREATE_USDSUI_QUOTE_TYPE }, supported)?.path, "venue");
  assert.equal(cetusDraftIssue({ ...draft, quote_type: CREATE_WAL_QUOTE_TYPE }, supported)?.path, "venue");
  assert.match(cetusDraftIssue(draft, null)!.message, /could not be checked/);
  assert.equal(cetusDraftIssue({ ...draft, venue: "bluefin" }, null), null);
});


for (const stage of ["initial reads", "quote fanout"] as const) {
  test(`Cetus ${stage} failure keeps the null fallback pending until every sibling settles`, async () => {
    const node = client();
    const firstFailure = new Error("synthetic first provider failure");
    let rejectSibling!: (error: Error) => void;
    const sibling = new Promise<never>((_resolve, reject) => { rejectSibling = reject; });
    let started = 0;
    if (stage === "initial reads") {
      mock.method(node.core, "getObject", async () => { started++; throw firstFailure; });
      mock.method(node.core, "getDynamicObjectField", () => { started++; return sibling; });
    } else {
      mock.method(node.core, "getDynamicField", () => {
        started++;
        return started === 1 ? Promise.reject(firstFailure) : sibling;
      });
    }
    let completed = false;
    const owner = readCreateCetusTiers(node, identity).then((value) => { completed = true; return value; });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(started, stage === "initial reads" ? 2 : CREATE_QUOTES.length);
      assert.equal(completed, false, "a null fallback must not release still-running SDK siblings");
      rejectSibling(new Error("synthetic final sibling failure"));
      assert.equal(await owner, null);
      assert.equal(completed, true);
    } finally {
      rejectSibling(new Error("fixture cleanup"));
      await owner;
    }
  });
}
