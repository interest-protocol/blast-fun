import assert from "node:assert/strict";
import test from "node:test";
import { aclAdminFieldName, aclBcs } from "@interest-protocol/blast-admin-sdk";
import { defineBlastDeployment } from "@interest-protocol/blast-deployments-sdk";
import { bcs } from "@mysten/sui/bcs";
import { ObjectError, type ClientWithCoreApi } from "@mysten/sui/client";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { NON_PRODUCTION_MANIFEST } from "../../../test/fixtures/final-stack/non-production-deployment.ts";
import type { Provider } from "#workers/modules/worker-runtime/provider.ts";
import { vaultEventBcs } from "@interest-protocol/blast-vault-sdk/events";
import type { SuiClientTypes } from "@mysten/sui/client";
import { capRoles } from "#workers/modules/worker-runtime/admin.ts";
import { digestOutcome, isMinOutAbort } from "./chain.ts";

const deployment = defineBlastDeployment(NON_PRODUCTION_MANIFEST);
const id = normalizeSuiAddress;
const uid = (address: string) => ({ id: { bytes: id(address) } });
const capId = id("0xca");
const adminsTableId = id("0x7a");
const role = `${deployment.packages.core.originalPackageId}::blast_domain::BuybackAdmin`;
const aclId = deployment.sharedObjects.admin.acl.objectId;
const acl = { objectId: aclId, owner: { $kind: "Shared", Shared: { initialSharedVersion: "1" } }, type: `${deployment.packages.admin.originalPackageId}::blast_acl::ACL`, content: aclBcs.serialize({ id: uid(aclId), super_admin_cap_id: id("0x1"), admins: { id: uid(adminsTableId), size: 1n }, super_admin_transfer: { parent: aclId, key: null, delay_ms: 0n, pending: null } }).toBytes() };
const field = { name: aclAdminFieldName(capId), value: { type: "0x2::vec_set::VecSet<0x1::type_name::TypeName>", bcs: bcs.vector(bcs.string()).serialize([role.slice(2)]).toBytes() } };
const client = (getDynamicField: (input: unknown) => Promise<unknown>) => ({ core: { getObjects: async () => ({ objects: [acl] }), getDynamicField } }) as unknown as ClientWithCoreApi;

test("buyback roles target the Table entry inside the provider budget and preserve the signal", async () => {
  const controller = new AbortController(); let requests = 0; let requested: unknown;
  const provider: Provider = async call => { requests++; return call(controller.signal); };
  const reader = client(async input => { requested = input; return { dynamicField: field }; });
  assert.deepEqual(await capRoles(reader, deployment, capId, provider), [role]);
  assert.equal(requests, 2);
  assert.deepEqual(requested, { parentId: adminsTableId, name: aclAdminFieldName(capId), signal: controller.signal });
});

test("revocation, transport failure and malformed role bytes remain distinct", async () => {
  let providerFailures = 0;
  const provider: Provider = async call => { try { return await call(new AbortController().signal); } catch (error) { providerFailures++; throw error; } };
  const absent = client(async () => { throw new ObjectError("NOT_FOUND", "missing", { reason: "notFound" }); });
  assert.equal(await capRoles(absent, deployment, capId, provider), null);
  const failure = new Error("RPC unavailable");
  await assert.rejects(capRoles(client(async () => { throw failure; }), deployment, capId, provider), error => error === failure);
  assert.equal(providerFailures, 2);
  const malformed = client(async () => ({ dynamicField: { ...field, value: { ...field.value, bcs: new Uint8Array([255]) } } }));
  await assert.rejects(capRoles(malformed, deployment, capId, provider), (error: unknown) => error instanceof Error && "code" in error && error.code === "acl-unreadable");
  assert.equal(providerFailures, 2, "decoding errors stay outside provider accounting");
});


test("BuybackBurned is read only from the vault package and binds the vault ID", async () => {
  const vaultId=id("0xab");
  const event={eventType:`${deployment.packages.vault.originalPackageId}::blast_vault_events::BuybackBurned<0x2::sui::SUI,0x2::sui::SUI>`,
    bcs:vaultEventBcs.BuybackBurned.serialize({vault_id:vaultId,quote_spent:50n,meme_burned:20n,burn_quote_pending:15n}).toBytes()};
  let events=[event];
  const node={core:{getTransaction:async()=>({Transaction:{digest:"fixture",effects:{transactionDigest:"fixture",status:{success:true}},events}})}} as unknown as ClientWithCoreApi;
  const provider:Provider=call=>call(new AbortController().signal);
  assert.deepEqual(await digestOutcome(node,"fixture",vaultId,deployment.packages.vault.originalPackageId,provider),
    {kind:"executed",quoteSpent:50n,memeBurned:20n,quotePending:15n});
  events=[{...event,eventType:`${deployment.packages.migrators.originalPackageId}::blast_vault_events::BuybackBurned<0x2::sui::SUI,0x2::sui::SUI>`}];
  assert.deepEqual(await digestOutcome(node,"fixture",vaultId,deployment.packages.vault.originalPackageId,provider),{kind:"unreadable"});
  events=[event];
  assert.deepEqual(await digestOutcome(node,"fixture",id("0xac"),deployment.packages.vault.originalPackageId,provider),{kind:"unreadable"});
});

test("minimum-output abort recognition binds the vault lineage and exact error", () => {
  const abort=(packageId:string,code:string)=>({$kind:"MoveAbort",MoveAbort:{abortCode:code,location:{package:packageId,module:"vault",functionName:"burn_buyback"}}}) as SuiClientTypes.ExecutionError;
  const packages=[deployment.packages.vault.packageId,deployment.packages.vault.originalPackageId];
  assert.equal(isMinOutAbort(abort(packages[0]!,"8"),packages),true);
  assert.equal(isMinOutAbort(abort(packages[0]!,"7"),packages),false);
  assert.equal(isMinOutAbort(abort(deployment.packages.migrators.packageId,"8"),packages),false);
});
