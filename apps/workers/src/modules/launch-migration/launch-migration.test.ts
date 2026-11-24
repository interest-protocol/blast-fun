import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSuiObjectId } from "@mysten/sui/utils";
import { launchObjectFixture } from "../../../test/fixtures/final-stack/launch-object.ts";
import { NON_PRODUCTION_MANIFEST } from "../../../test/fixtures/final-stack/non-production-deployment.ts";
import { classifyLaunchObject } from "../blast-keeper/chain.ts";
import { parseMigrationIntents } from "./job.ts";

const object = launchObjectFixture("migration_ready");
const nodeObject = { ...object, owner: { $kind: "Shared" as const, Shared: { initialSharedVersion: "5" } } };
const original = NON_PRODUCTION_MANIFEST.packages.launchpad.originalPackageId;
test("fresh launch decoder binds UID and package lineage", () => {
  assert.equal(classifyLaunchObject(nodeObject, object.objectId, original).kind, "launch");
  assert.equal(classifyLaunchObject(nodeObject, object.objectId, normalizeSuiObjectId("0xdead")).kind, "foreign");
  assert.deepEqual(classifyLaunchObject(nodeObject, normalizeSuiObjectId("0xbeef"), original), {
    kind: "unreadable",
    reason: "object-mismatch",
  });
  assert.deepEqual(classifyLaunchObject({ ...nodeObject, content: new Uint8Array([1]) }, object.objectId, original), {
    kind: "unreadable",
    reason: "decode-failed",
  });
  assert.deepEqual(classifyLaunchObject({ ...nodeObject, content: undefined }, object.objectId, original), {
    kind: "unreadable",
    reason: "no-content",
  });
  assert.deepEqual(classifyLaunchObject({ ...nodeObject, type: "example-provider-data::m::M" }, object.objectId, original), {
    kind: "unreadable",
    reason: "malformed-type",
  });
});
test("durable migration intents reject old adapter-only commands", () => {
  assert.throws(() => parseMigrationIntents({ records: [{ kind: "cetus", launchId: object.objectId }] }));
  assert.throws(() => parseMigrationIntents({ records: [{ kind: "presale-settle", object: { objectId: object.objectId, initialSharedVersion: "5" }, memeType: "0x1::m::M", quoteType: "0x2::sui::SUI" }] }));
});
