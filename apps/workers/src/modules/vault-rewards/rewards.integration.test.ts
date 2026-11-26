import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { delayedEventBcs } from "@interest-protocol/blast-admin-sdk/events";
import { treasuryDelayedKeys } from "@interest-protocol/blast-core/treasury";
import { launchpadEventBcs } from "@interest-protocol/blast-launchpad-sdk/events";
import { createWorkerAlerts } from "#workers/modules/worker-runtime/alerts.ts";
import type { Submission } from "#workers/modules/worker-runtime/runtime.ts";
import { vaultEventBcs } from "@interest-protocol/blast-vault-sdk/events";
import { withTransaction } from "@blast/core/modules/database/transaction.ts";
import { adminPool, watcherPool, freshDatabase } from "../../../test/fixtures/modules/coin-registration/testing.ts";
import { createPool } from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { assertAccountLeaves, type CheckIdentities } from "#workers/modules/reward-plan/beneficiaries.ts";
import { settlementEvidence } from "#workers/modules/reward-plan/gas-settlement.ts";
import { json, frozenSchema, planCommitment, readPlan, type Frozen } from "#workers/modules/reward-plan/plan.ts";
import { discoverPeriods, freezePeriod, fillIdentityGaps, qualifyPage, allocatePage, reservePlan, retrySkippedPeriod } from "../rewards-planner/planner.ts";
import { buildManifest, uploadManifest, type ImmutableManifestStorage } from "../rewards-planner/manifest.ts";
import { DAY_MS } from "../rewards-planner/economics.ts";
import { historicalFunds, historicalTreasury } from "../rewards-planner/history.ts";
import { prepareGasSettlements } from "../rewards-planner/main.ts";
import { rewardAction, reserveRewardBytes, assertRewardBytes, persistRewardSignature, resolveRewardAction } from "./custody.ts";
import { vaultRewardsJob, unclaimedLeaves, relayRound } from "./job.ts";
import { manifestSummary, parseRewardIntent } from "./transactions.ts";
import { deployment, fingerprint, cap, id, key, base, bytes, vault, memeType, quoteType, intents } from "../../../test/fixtures/modules/vault-rewards/rewards.ts";

const url=process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const digest=(digit:string)=>digit.repeat(32);
const cut={checkpoint:"20",digest:digest("C"),timestampMs:"86401000"};
const settings={fingerprint,gasReserveBps:0,maxAgeMs:60000,maxConfidenceBps:50,exclusions:[],noMinimumVaults:[],catchUpAtMs:null};
test("fresh vault planning, immutable manifests, exact reservations and signed custody survive local DB races",{skip:!url},async()=>{
  assert.equal(new URL(url!).hostname,"127.0.0.1");
  const database=await freshDatabase(20);
  const admin=adminPool(database.url),watcher=watcherPool(database.url),planner=createPool(urlAs(database.url,"blast_indexer"),{max:2});
  try {
    for(const [cp,stamp,dg] of [[1,0,digest("A")],[10,1000,digest("B")],[20,86401000,digest("C")]] as const){
      await admin.query("INSERT INTO checkpoint_journal(checkpoint,network,digest,epoch,timestamp_ms,total_transactions,format_version,payload,payload_hash) VALUES($1,'mainnet',$2,1,$3,1,1,''::bytea,decode(repeat('00',32),'hex'))",[cp,dg,stamp]);
      await admin.query("INSERT INTO blast_infra_fixture.checkpoint_headers VALUES($1,$2,$3)",[cp,dg,stamp]);
    }
    await admin.query("UPDATE watermarks SET reader_lo=0,checkpoint_hi_inclusive=20,timestamp_ms_hi_inclusive=86401000 WHERE pipeline IN ('market','intake')");
    await admin.query(`DROP VIEW chain_read_v1.vaults, chain_read_v1.vault_rounds CASCADE;
      CREATE TABLE reward_test_vaults(vault_id text,origin_id text,origin_kind text,meme_type text,quote_type text,pool_id text,next_round numeric,created_timestamp_ms bigint,created_checkpoint bigint);
      CREATE VIEW chain_read_v1.vaults AS SELECT * FROM reward_test_vaults;
      CREATE TABLE reward_test_collections(vault_id text,checkpoint bigint,tx_slot bigint,event_slot bigint,tx_digest text,fee_split jsonb,route_meme_amounts numeric[],route_quote_amounts numeric[]);
      CREATE VIEW chain_read_v1.vault_fee_collections AS SELECT * FROM reward_test_collections;
      CREATE TABLE reward_test_rounds(vault_id text,round_id text,number numeric,end_checkpoint bigint,published_checkpoint bigint,published_tx_slot bigint,published_event_slot bigint,published_tx_digest text,gas_settled boolean,closed boolean);
      CREATE VIEW chain_read_v1.vault_rounds AS SELECT * FROM reward_test_rounds;
      CREATE TABLE reward_test_stack(object_id text,kind text,learned_checkpoint bigint,learned_tx_slot bigint);
      CREATE VIEW chain_read_v1.stack_objects AS SELECT * FROM reward_test_stack;
      CREATE TABLE reward_test_delayed(owner_id text,key_type text,value jsonb,applied_checkpoint bigint,applied_tx_slot bigint,applied_event_slot bigint);
      CREATE VIEW chain_read_v1.delayed_values AS SELECT * FROM reward_test_delayed;
      CREATE TABLE reward_test_launch_activity(tx_digest text,event_type text,payload jsonb);
      CREATE VIEW chain_read_v1.launch_activity AS SELECT * FROM reward_test_launch_activity;
      GRANT SELECT ON chain_read_v1.launch_activity TO blast_indexer;
      CREATE TABLE reward_test_holders(owner text,weight numeric);
      CREATE TABLE reward_test_identities(address text PRIMARY KEY,kind text,proven_through bigint);
      -- Fails closed like blast-infra: a holder at or above the floor ($9, default 0) with no answer raises.
      CREATE FUNCTION chain_read_v1.reward_holder_window_since(text,text,text,bigint,bigint,text[],text,integer,numeric DEFAULT 0)
      RETURNS TABLE(owner text,weight text,start_checkpoint bigint,start_digest text,end_checkpoint bigint,end_digest text)
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_catalog AS $$ BEGIN
        IF EXISTS(SELECT FROM (SELECT h.owner,h.weight FROM reward_test_holders h WHERE ($7 IS NULL OR h.owner COLLATE "C">$7 COLLATE "C") AND NOT h.owner=ANY($6) ORDER BY h.owner COLLATE "C" LIMIT $8) p
          WHERE p.weight>=$9 AND NOT EXISTS(SELECT FROM reward_test_identities i WHERE i.address=p.owner AND (i.kind='object' OR i.proven_through>=20)))
        THEN RAISE EXCEPTION 'address identity unproven'; END IF;
        RETURN QUERY SELECT h.owner,h.weight::text,10::bigint,repeat('B',32),20::bigint,repeat('C',32) FROM reward_test_holders h WHERE ($7 IS NULL OR h.owner COLLATE "C">$7 COLLATE "C") AND NOT h.owner=ANY($6) ORDER BY h.owner COLLATE "C" LIMIT $8; END $$;
      CREATE FUNCTION chain_read_v1.reward_identity_gaps(text,text,text,bigint,bigint,text[],text,integer,numeric) RETURNS TABLE(owner text,end_checkpoint bigint)
      LANGUAGE SQL SECURITY DEFINER SET search_path=public,pg_catalog AS $$ SELECT page.owner,20::bigint FROM (SELECT h.owner,h.weight FROM reward_test_holders h WHERE ($7 IS NULL OR h.owner COLLATE "C">$7 COLLATE "C") AND NOT h.owner=ANY($6)
        AND NOT EXISTS(SELECT FROM reward_test_identities i WHERE i.address=h.owner AND i.kind='object') ORDER BY h.owner COLLATE "C" LIMIT $8) page
        WHERE page.weight>=$9 AND NOT EXISTS(SELECT FROM reward_test_identities i WHERE i.address=page.owner AND i.kind='account' AND i.proven_through>=20) ORDER BY page.owner COLLATE "C" $$;
      CREATE FUNCTION chain_read_v1.record_address_identities(jsonb) RETURNS void LANGUAGE SQL SECURITY DEFINER SET search_path=public,pg_catalog AS $$
        INSERT INTO reward_test_identities SELECT a.address,a.kind,a.proven_through FROM jsonb_to_recordset($1) AS a(address text,kind text,proven_through bigint)
        ON CONFLICT(address) DO UPDATE SET kind=excluded.kind,proven_through=excluded.proven_through $$;
      CREATE FUNCTION chain_read_v1.usd_observation(text,text,text,bigint,text,bigint,bigint,bigint,bigint,bigint) RETURNS jsonb LANGUAGE SQL AS $$ SELECT '{"available":true,"numerator":"1","denominator":"1","exponent":0}'::jsonb $$;
      GRANT SELECT ON chain_read_v1.vaults,chain_read_v1.vault_fee_collections,chain_read_v1.vault_rounds,chain_read_v1.stack_objects,chain_read_v1.delayed_values TO blast_watcher,blast_indexer;`);
    await admin.query("INSERT INTO reward_test_vaults VALUES($1,$2,'launch',$3,$4,$5,0,1000,10)",[vault.objectId,id("0xef"),memeType,quoteType,id("0xdd")]);
    const treasury=deployment.sharedObjects.core.treasury.objectId;
    const created={eventType:`${deployment.packages.admin.originalPackageId}::delayed::DelayedCreated<${deployment.packages.core.originalPackageId}::blast_treasury::DestinationKey,address>`,bcs:Buffer.from(delayedEventBcs("DelayedCreated",treasuryDelayedKeys.Destination).serialize({parent:treasury,key:null,value:base.treasury,delay_ms:1n}).toBytes()).toString("base64")};
    const longerHolder = id("0xc1"), team = id("0xd3"), quoteRecipient = id("0xd4"), objectHolder = id("0xd5");
    // A pool or Vesting schedule holding the coin: the chain proves its address is an object.
    const checked:string[]=[];
    const chain=(objects:readonly string[]):CheckIdentities=>async(addresses,roundCut)=>{assert.equal(roundCut,20n);checked.push(...addresses);return addresses.map((address)=>({address,kind:objects.includes(address)?"object" as const:"account" as const,provenThrough:25n}));};
    const launchCreated = { eventType: `${deployment.packages.launchpad.originalPackageId}::events::LaunchCreated<${memeType},${quoteType}>`, bcs: Buffer.from(launchpadEventBcs.LaunchCreated.serialize({launch_id:id("0xef"),ticket_id:id("0x77"),venue:`${id("0x88")}::venue::Witness`,lp_fee_split:{routes:[{destination:{kind:"HolderRewards"},bps:10000n}]},virtual_quote:1n,graduation_target:100n,quote_fee_bps:0n,meme_fee_bps:0n,allocation_plan:{curveMemeBps:8000n,lpMemeBps:1000n,lpQuoteBps:9000n,protocolMemeBps:0n,protocolQuoteBps:0n,recipients:[{recipient:{destination:team,vestingTerms:null},memeBps:1000n,quoteBps:0n},{recipient:{destination:quoteRecipient,vestingTerms:null},memeBps:0n,quoteBps:1000n}]},opening_round_ms:1n,creation_fee:0n,partner_id:null}).toBytes()).toString("base64") };
    await admin.query("INSERT INTO blast_infra_fixture.transaction_evidence VALUES($1,10,1000,$2,true,$3)",[digest("7"),key.toSuiAddress(),json([launchCreated])]);
    await admin.query("INSERT INTO reward_test_launch_activity VALUES($1,$2,$3)",[digest("7"),launchCreated.eventType,json({launch_id:id("0xef")})]);
    const collected={eventType:`${deployment.packages.vault.originalPackageId}::blast_vault_events::FeesCollected<${memeType},${quoteType}>`,bcs:Buffer.from(vaultEventBcs.FeesCollected.serialize({vault_id:vault.objectId,gross_meme_amount:100n,gross_quote_amount:150n,protocol_meme_amount:0n,protocol_quote_amount:0n,route_meme_amounts:[100n],route_quote_amounts:[150n]}).toBytes()).toString("base64")};
    for(const [dg,cp,events] of [[digest("4"),1,[created]],[digest("5"),20,[collected]]] as const) await admin.query("INSERT INTO blast_infra_fixture.transaction_evidence VALUES($1,$2,0,$3,true,$4)",[dg,cp,key.toSuiAddress(),json(events)]);
    await admin.query("INSERT INTO reward_test_stack VALUES($1,'treasury',1,1)",[treasury]);
    await admin.query("INSERT INTO reward_test_delayed VALUES($1,'blast_core::blast_treasury::DestinationKey',$2,1,1,0)",[treasury,json(base.treasury)]);
    await admin.query("INSERT INTO reward_test_collections VALUES($1,20,1,0,$2,$3,ARRAY[100]::numeric[],ARRAY[150]::numeric[])",[vault.objectId,digest("5"),json({routes:[{destination:{kind:"holder_rewards"}}]})]);
    for(const owner of [id("0xd1"),id("0xd2"),team,quoteRecipient,objectHolder]) await admin.query("INSERT INTO reward_test_holders VALUES($1,$2)",[owner,(5n*DAY_MS).toString()]);
    await admin.query("INSERT INTO reward_test_holders VALUES($1,$2)",[longerHolder,(10n*DAY_MS).toString()]);
    await admin.query("INSERT INTO reward_test_holders VALUES($1,1)",[id("0xd6")]);
    // Saved answers: a proven account, an account proven only before the cut, and an object the indexer's window does not skip yet.
    await admin.query("INSERT INTO reward_test_identities VALUES($1,'account',20),($2,'account',19),($3,'object',20),($4,'account',20)",[id("0xd1"),quoteRecipient,objectHolder,longerHolder]);
    await discoverPeriods(planner,settings,2);
    const period=(await admin.query("SELECT period_id FROM vault_reward_periods")).rows[0].period_id;
    const planId=await freezePeriod(planner,deployment,settings,period);
    assert.equal(await freezePeriod(planner,deployment,settings,period),planId,"restart reuses frozen inputs");
    const frozenInputs=frozenSchema.parse((await readPlan(planner,planId)).inputs);
    await admin.query("UPDATE vault_reward_plans SET inputs=inputs-'payoutPolicy' WHERE plan_id=$1",[planId]);
    await assert.rejects(freezePeriod(planner,deployment,settings,period),/reward-payout-policy-cutover/);
    await admin.query("UPDATE vault_reward_plans SET inputs=$2 WHERE plan_id=$1",[planId,json(frozenInputs)]);
    assert.ok(frozenInputs.exclusions.includes(team),"positive launch Meme allocation is excluded");
    assert.ok(!frozenInputs.exclusions.includes(quoteRecipient),"Quote-only allocation retains eligibility");
    const known=await fillIdentityGaps(planner,planId,chain([objectHolder]));
    assert.deepEqual(checked.slice(0,2),[id("0xd2"),quoteRecipient],"gaps first: only unproven holders at or above the reward floor; dust is not checked");
    assert.deepEqual(checked.slice(2).sort(),[longerHolder,id("0xd1"),objectHolder].sort(),"then the page's qualifying holders this pass has not answered");
    assert.deepEqual((await admin.query("SELECT address,kind,proven_through::text FROM reward_test_identities WHERE address=ANY($1) ORDER BY address",[[id("0xd2"),quoteRecipient]])).rows,
      [{address:id("0xd2"),kind:"account",proven_through:"25"},{address:quoteRecipient,kind:"account",proven_through:"25"}],"gap answers are saved");
    checked.length=0;
    await fillIdentityGaps(planner,planId,chain([objectHolder]));
    assert.deepEqual(checked.sort(),[longerHolder,id("0xd1"),id("0xd2"),quoteRecipient,objectHolder].sort(),"saved answers close the gaps: a new pass asks each qualifying holder once, read-only");
    await assert.rejects(qualifyPage(planner,planId,new Map()),/unanswered/,"no chain call runs under the plan lock");
    assert.equal(await qualifyPage(planner,planId,known),true); assert.equal(await allocatePage(planner,planId),true);
    const paid=(await admin.query("SELECT beneficiary,meme_amount::text AS meme,quote_amount::text AS quote FROM vault_reward_allocations ORDER BY leaf_index")).rows;
    assert.deepEqual(paid,[
      {beneficiary:longerHolder,meme:"40",quote:"60"},
      ...[id("0xd1"),id("0xd2"),quoteRecipient].map(beneficiary=>({beneficiary,meme:"20",quote:"30"})),
    ],"holders receive both fee assets in proportion to their time-weighted balances");
    await buildManifest(planner,planId);
    await assertAccountLeaves(watcher,planId,4,20n,chain([objectHolder]));
    await assert.rejects(assertAccountLeaves(watcher,planId,4,20n,chain([id("0xd2")])),/beneficiary is an object/,"checker refuses a leaf paying an object");
    const relay=await unclaimedLeaves({pool:watcher},chain([id("0xd2")]),planId,4,{claimedBitmap:[0n]} as Parameters<typeof unclaimedLeaves>[4],16,20n);
    assert.deepEqual([relay.leaves.map((l)=>l.beneficiary),relay.held.map((l)=>l.beneficiary)],[[longerHolder,id("0xd1"),quoteRecipient],[id("0xd2")]],"the relay sends both assets to accounts and holds the object claim");
    checked.length = 0;
    const sized = await unclaimedLeaves({ pool: watcher }, chain([id("0xd1")]), planId, 4,
      { claimedBitmap: [0n] } as Parameters<typeof unclaimedLeaves>[4], 16, 20n, (leaves) => Math.min(2, leaves.length));
    assert.deepEqual(sized.leaves.map((leaf) => leaf.beneficiary), [longerHolder, id("0xd2")]);
    assert.deepEqual(checked, [longerHolder, id("0xd1"), id("0xd2")], "the relay refills after a held leaf and skips proofs outside the size limit");
    const blobs=new Map<string,Uint8Array>();
    const storage:ImmutableManifestStorage={async write(path,stream){const data=new Uint8Array(await new Response(stream).arrayBuffer()); if(blobs.has(path))assert.deepEqual(blobs.get(path),data);blobs.set(path,data);return{url:path};},async read(path){return new Response(Uint8Array.from(blobs.get(path)!).buffer).body!;}};
    await uploadManifest(planner,planId,storage);
    const badStorage:ImmutableManifestStorage={write:storage.write,async read(){return new Response("corrupt").body!;}};
    await assert.rejects(uploadManifest(planner,planId,badStorage),/manifest/);
    await admin.query("UPDATE reward_test_collections SET route_quote_amounts=ARRAY[149]::numeric[]");
    await assert.rejects(reservePlan(planner,deployment,planId),/collection-identity/);
    await admin.query("UPDATE reward_test_collections SET route_quote_amounts=ARRAY[150]::numeric[]");
    await admin.query("UPDATE vault_reward_allocations SET beneficiary=$2 WHERE plan_id=$1 AND leaf_index=0", [planId, base.treasury]);
    await assert.rejects(reservePlan(planner,deployment,planId),/cannot pay a holder reward to the treasury/);
    await admin.query("UPDATE vault_reward_allocations SET beneficiary=$2 WHERE plan_id=$1 AND leaf_index=0", [planId, longerHolder]);
    await reservePlan(planner,deployment,planId);
    const reserved=await readPlan(watcher,planId); assert.equal(reserved.stage,"reserved");
    // A second plan cannot reserve the same vault while the first may publish.
    const otherPeriod=randomUUID(),otherPlan=randomUUID();
    await admin.query("INSERT INTO vault_reward_periods SELECT $1,network,deployment_fingerprint,vault_id,start_ms+86400000,end_ms+86400000,'planning',NULL FROM vault_reward_periods WHERE period_id=$2",[otherPeriod,period]);
    await admin.query("INSERT INTO vault_reward_plans SELECT $1,$2,number,'uploaded',inputs,manifest,storage_url,storage_hash,storage_verified_at,now() FROM vault_reward_plans WHERE plan_id=$3",[otherPlan,otherPeriod,planId]);
    await assert.rejects(reservePlan(planner,deployment,otherPlan),/Another reward plan/);
    const intent={...intents[0]!,planId};
    const [first,same]=await Promise.all([rewardAction(watcher,intent,3),rewardAction(watcher,intent,3)]);
    assert.equal(first!.action_id,same!.action_id,"racing attempts reuse one action");
    const raw=await bytes(intent); await reserveRewardBytes(watcher,first!,raw); await assertRewardBytes(watcher,first!.action_id,raw);
    const unsigned=await rewardAction(watcher,intent,3); assert.equal(unsigned!.state,"signing","restart fences bytes even before a signature exists");
    assert.equal(await persistRewardSignature(watcher,first!.action_id,raw,{digest:unsigned!.digest!,signature:"fixture-signature"}),true);
    await assert.rejects(admin.query("UPDATE vault_reward_actions SET transaction_bytes='other'::bytea WHERE action_id=$1",[first!.action_id]),/immutable/);
    await assert.rejects(admin.query("UPDATE vault_reward_actions SET signature='other' WHERE action_id=$1",[first!.action_id]),/immutable/);
    const other=await rewardAction(watcher,{...intent,planId:otherPlan,operation:"other-plan"},3);
    await assert.rejects(reserveRewardBytes(watcher,other!,await bytes({...intent,planId:otherPlan,operation:"other-plan"})),/may still execute/);
    await resolveRewardAction(watcher,first!.action_id,"failed");
    const retry=await rewardAction(watcher,intent,3); assert.notEqual(retry!.action_id,first!.action_id);
    assert.equal((await admin.query("SELECT signature FROM vault_reward_actions WHERE action_id=$1",[first!.action_id])).rows[0].signature,"fixture-signature");
    await reserveRewardBytes(watcher,retry!,raw); await resolveRewardAction(watcher,retry!.action_id,"executed");
    assert.equal(await rewardAction(watcher,intent,3),null,"executed action cannot be signed again");
    await assert.rejects(settlementEvidence(watcher,planId,10n),/incomplete-gas-costs/);
    // Finalized effects release custody independently; failed gas accounting retries by digest.
    const measuredIntent={...intents[0]!,planId,operation:"gas-regression",manifest:manifestSummary(reserved.manifest),storageHash:reserved.storage_hash!,reserve:"0"};
    const measured=await rewardAction(watcher,measuredIntent,3),measuredBytes=await bytes(measuredIntent);
    await reserveRewardBytes(watcher,measured!,measuredBytes);
    const measuredRow=(await rewardAction(watcher,measuredIntent,3))!;
    await persistRewardSignature(watcher,measuredRow.action_id,measuredBytes,{digest:measuredRow.digest!,signature:"finalized-fixture"});
    await admin.query("ALTER TABLE reward_test_rounds ADD COLUMN claimed_count numeric,ADD COLUMN leaf_count numeric,ADD COLUMN gas_reserve_amount numeric,ADD COLUMN claim_deadline_at_ms bigint; CREATE OR REPLACE VIEW chain_read_v1.vault_rounds AS SELECT * FROM reward_test_rounds");
    await admin.query("REVOKE INSERT ON vault_reward_gas_effects FROM blast_watcher");
    let epochReads=0;
    const raised: string[]=[];
    const alerts={raise:async(key:string)=>{raised.push(key);return "held" as const;},clear:async()=>{}};
    const context={pool:watcher,deployment,fingerprint,config:{batchSize:8},provider:<R>(fn:(signal:AbortSignal)=>Promise<R>)=>fn(new AbortController().signal),log:()=>{},client:{core:{getTransaction:async()=>({Transaction:{digest:measuredRow.digest,checkpoint:"20",timestampMs:"86401000",effects:{transactionDigest:measuredRow.digest,status:{success:true},gasUsed:{computationCost:"5",storageCost:"2",storageRebate:"1"}}}}),getCurrentSystemState:async()=>{epochReads++;return{systemState:{epoch:"2"}};}}}} as unknown as Parameters<ReturnType<typeof vaultRewardsJob>["run"]>[0];
    await vaultRewardsJob({adminCapId:cap.objectId,relayBatch:16,pricePolicy:{maxAgeMs:60000,maxConfidenceBps:50}},chain([]),alerts).run(context);
    assert.equal(epochReads,0,"finalized gas evidence failure never falls through to expiration");
    assert.equal((await admin.query("SELECT state FROM vault_reward_actions WHERE action_id=$1",[measuredRow.action_id])).rows[0].state,"executed");
    assert.ok(raised.includes(`reward_gas:${planId}`),"gas accounting raises a per-plan alert");
    assert.equal((await admin.query("SELECT count(*)::int AS count FROM vault_reward_gas_effects WHERE digest=$1",[measuredRow.digest])).rows[0].count,0);
    const unrelated=await rewardAction(watcher,{...intent,planId:otherPlan,operation:"after-known-finality"},3);
    await reserveRewardBytes(watcher,unrelated!,await bytes({...intent,planId:otherPlan,operation:"after-known-finality"}));
    await resolveRewardAction(watcher,unrelated!.action_id,"expired");
    await admin.query("GRANT INSERT ON vault_reward_gas_effects TO blast_watcher");
    await vaultRewardsJob({adminCapId:cap.objectId,relayBatch:16,pricePolicy:{maxAgeMs:60000,maxConfidenceBps:50}},chain([]),alerts).run(context);
    assert.equal((await admin.query("SELECT count(*)::int AS count FROM vault_reward_gas_effects WHERE digest=$1",[measuredRow.digest])).rows[0].count,1,"restart backfills finalized gas by digest");
    // A signed claim or publish that did not land is checked again before it is resent: a leaf now an object blocks it.
    const frozenPlan=frozenSchema.parse(reserved.inputs);
    const liveEpoch={...context,client:{core:{...context.client.core,getCurrentSystemState:async()=>({systemState:{epoch:"1"}})}}} as typeof context;
    for (const [stale,operation] of [[{...intents[2]!,leaves:relay.held},"held-claim"],[intents[1]!,"held-publish"]] as const) {
      const heldIntent={...stale,planId,operation,manifest:manifestSummary(reserved.manifest),storageHash:reserved.storage_hash!,reserve:frozenPlan.reserve,treasury:frozenPlan.treasury} as typeof intents[number];
      const heldBytes=await bytes(heldIntent);
      await reserveRewardBytes(watcher,(await rewardAction(watcher,heldIntent,3))!,heldBytes);
      const heldRow=(await rewardAction(watcher,heldIntent,3))!;
      await persistRewardSignature(watcher,heldRow.action_id,heldBytes,{digest:heldRow.digest!,signature:"held-fixture"});
      const blocked:{key:string;error?:unknown}[]=[];
      await vaultRewardsJob({adminCapId:cap.objectId,relayBatch:16,pricePolicy:{maxAgeMs:60000,maxConfidenceBps:50}},chain([id("0xd2")]),{raise:async(key:string,details?:Readonly<Record<string,string|number|boolean|null>>)=>{blocked.push({key,error:details?.error});return "held" as const;},clear:async()=>{}}).run(liveEpoch);
      assert.deepEqual(blocked.filter((alert)=>alert.key.startsWith("reward_custody:")),[{key:`reward_custody:${planId}`,error:"ObjectBeneficiary"}],`a stored ${operation} paying an object is never resent`);
      assert.equal((await admin.query("SELECT state FROM vault_reward_actions WHERE action_id=$1",[heldRow.action_id])).rows[0].state,"signed");
      await resolveRewardAction(watcher,heldRow.action_id,"expired");
    }
    const plannerAlerts=createWorkerAlerts({pool:planner,role:"rewards-planner",network:()=>"mainnet",webhookUrl:"https://example.invalid/fixture",timeoutMs:100,log:()=>{},fetcher:async()=>new Response(null,{status:204})});
    assert.equal(await plannerAlerts.raise(`reward_planning:${planId}`,{error:"fixture"}),"sent","keyless role may persist planner alerts");
    // Current-only policy and missing return cursors cannot silently become historical money.
    await admin.query("UPDATE reward_test_delayed SET applied_checkpoint=10");
    await assert.rejects(withTransaction(planner,tx=>historicalTreasury(tx,deployment,cut),{isolationLevel:"REPEATABLE READ"}),/treasury-applied-history/);
    const published={eventType:`${deployment.packages.vault.originalPackageId}::blast_vault_events::RoundPublished<${memeType},${quoteType}>`,bcs:Buffer.from(vaultEventBcs.RoundPublished.serialize({vault_id:vault.objectId,round_id:id("0xbb"),number:0n,start_checkpoint:10n,end_checkpoint:20n,claim_deadline_at_ms:999999999n,root:base.manifest.root,manifest_digest:base.manifest.manifestDigest,leaf_count:2n,meme_amount:100n,quote_amount:140n,meme_unallocated:0n,quote_unallocated:0n,treasury:base.treasury,gas_reserve_amount:10n}).toBytes()).toString("base64")};
    await admin.query("INSERT INTO blast_infra_fixture.transaction_evidence VALUES($1,20,86401000,$2,true,$3)",[digest("6"),key.toSuiAddress(),json([published])]);
    await admin.query("INSERT INTO reward_test_rounds(vault_id,round_id,number,end_checkpoint,published_checkpoint,published_tx_slot,published_event_slot,published_tx_digest,gas_settled,closed) VALUES($1,$2,0,20,20,2,0,$3,true,false)",[vault.objectId,id("0xbb"),digest("6")]);
    await assert.rejects(withTransaction(planner,tx=>historicalFunds(tx,deployment,fingerprint,vault.objectId,cut),{isolationLevel:"REPEATABLE READ"}),/gas_settled-cursor/);
    await admin.query("UPDATE reward_test_rounds SET gas_settled=false,closed=true");
    await assert.rejects(withTransaction(planner,tx=>historicalFunds(tx,deployment,fingerprint,vault.objectId,cut),{isolationLevel:"REPEATABLE READ"}),/closed-cursor/);
    // Gas is measured once relaying is done: all leaves claimed, or every open leaf held as an object.
    await admin.query("UPDATE reward_test_rounds SET closed=false,leaf_count=4,claimed_count=3,gas_reserve_amount=10");
    const legacyInputs = frozenSchema.parse({ ...frozenPlan, payoutPolicy: undefined });
    const legacyCommitment = planCommitment(legacyInputs, reserved.manifest, reserved.storage_hash);
    await admin.query("UPDATE vault_reward_plans SET stage='published',inputs=$2 WHERE plan_id=$1",
      [planId,json({ ...legacyInputs, commitment: legacyCommitment })]);
    const measuring:string[]=[], conditions={failed:async(plan:string,error:unknown)=>{measuring.push(`failed:${plan}:${String(error)}`);},clear:async(plan:string)=>{measuring.push(`measured:${plan}`);}};
    await prepareGasSettlements(planner,fingerprint,8,conditions);
    assert.deepEqual(measuring,[],"an open account leaf waits for its claim");
    // The relay holds back the leaf that is now an object and, with no account leaf left, records it.
    const publishedPlan=await readPlan(watcher,planId), f=frozenSchema.parse(publishedPlan.inputs), summary=manifestSummary(publishedPlan.manifest);
    const onChain={objectId:id("0xbb"),initialSharedVersion:"8",vaultId:f.vaultId,number:BigInt(f.number),root:summary.root,leafCount:summary.leafCount,treasury:f.treasury,memeType:f.memeType,quoteType:f.quoteType,
      claimDeadlineAtMs:10n**15n,claimedBitmap:[relay.leaves.reduce((word,leaf)=>word|(1n<<BigInt(leaf.index)),0n)],gasReserve:10n,meme:0n,quote:0n} as unknown as Parameters<typeof relayRound>[7];
    const common={planId,fingerprint:f.fingerprint,memeType:f.memeType,quoteType:f.quoteType,vault,manifest:summary,storageHash:publishedPlan.storage_hash!,treasury:f.treasury,reserve:f.reserve};
    const relayContext={...context,protocol:{paused:{vault:0}},gasEstimator:async()=>async()=>assert.fail("an empty batch never simulates")} as unknown as Parameters<typeof relayRound>[0];
    await assert.rejects(relayRound(relayContext,chain([id("0xd2")]),publishedPlan as Parameters<typeof relayRound>[2],{adminCapId:cap.objectId,relayBatch:16,pricePolicy:{maxAgeMs:60000,maxConfidenceBps:50}},f,summary,common,onChain,{checkpoint:"20",timestampMs:"86401000"} as Parameters<typeof relayRound>[8]),/beneficiary is an object/);
    const attemptedClaimCounts: number[] = [];
    const splitContext = {
      ...relayContext,
      config: { ...relayContext.config, maxAttempts: 3 },
      gasEstimator: async (ceiling) => {
        assert.equal(ceiling, 1_000_000_000n);
        return async (transaction) => {
          const count = transaction.getData().commands.length;
          attemptedClaimCounts.push(count);
          return count === 4 ? { kind: "capacity" } : { kind: "fits", budgetMist: BigInt(count) * 10_000_000n };
        };
      },
      submit: async (submission: Submission<null>) => {
        const intent = parseRewardIntent(submission.intent);
        assert.equal(intent.kind, "claim");
        assert.equal(submission.estimatedGasBudgetMist, 30_000_000n);
        assert.deepEqual(intent.leaves.map((leaf) => [leaf.index, leaf.memeAmount, leaf.quoteAmount]), [
          ["0","40","60"], ["1","20","30"], ["2","20","30"],
        ]);
        const simulatedBytes = await bytes(intent);
        await submission.inputReservation!.beforeSign(simulatedBytes);
        await submission.inputReservation!.afterSign(simulatedBytes);
        return { outcome: "not-submitted", reason: "lease-lost", digest: null, reconciled: null };
      },
    } as Parameters<typeof relayRound>[0];
    await relayRound(splitContext, chain([]), publishedPlan, { adminCapId: cap.objectId, relayBatch: 1023, pricePolicy: settings },
      f, summary, common, { ...onChain, claimedBitmap: [0n] }, cut);
    assert.deepEqual(attemptedClaimCounts, [4, 2, 3]);
    const { rows: claimCustody } = await admin.query<{ action_id: string; state: string; count: number }>(
      "SELECT action_id,state,jsonb_array_length(payload->'leaves') AS count FROM vault_reward_actions WHERE plan_id=$1 AND kind='claim' AND state<>'expired'", [planId]);
    assert.deepEqual(claimCustody.map(({ state, count }) => ({ state, count })), [{ state: "signing", count: 3 }]);
    await resolveRewardAction(watcher, claimCustody[0]!.action_id, "expired");
    assert.deepEqual((publishedPlan.inputs as {heldLeaves?:unknown}).heldLeaves,undefined);
    assert.deepEqual(((await readPlan(watcher,planId)).inputs as {heldLeaves?:unknown}).heldLeaves,relay.held.map((leaf)=>leaf.index),"the relay records the held leaves");
    // With every finalized action's gas recorded, the planner measures the refund past the held leaf.
    await admin.query(`INSERT INTO vault_reward_gas_effects SELECT a.digest,a.plan_id,20,86401000,g.net_sui_atoms,g.sui_usd,g.quote_usd FROM vault_reward_actions a CROSS JOIN (SELECT * FROM vault_reward_gas_effects WHERE digest=$2) g
      WHERE a.plan_id=$1 AND a.state IN ('executed','failed') AND a.kind IN ('schedule_round','publish_round','claim') AND NOT EXISTS (SELECT 1 FROM vault_reward_gas_effects e WHERE e.digest=a.digest) ON CONFLICT DO NOTHING`,[planId,measuredRow.digest]);
    await admin.query(`UPDATE vault_reward_gas_effects SET sui_usd='{"numerator":"1","denominator":"1"}',quote_usd='{"numerator":"1","denominator":"1"}' WHERE plan_id=$1`,[planId]);
    await prepareGasSettlements(planner,fingerprint,8,conditions);
    assert.deepEqual(measuring,[`measured:${planId}`],"held leaves no longer block the gas refund");
    assert.ok(((await readPlan(watcher,planId)).inputs as {gasSettlement?:unknown}).gasSettlement,"the gas settlement is prepared");
    await assert.rejects(planner.query("UPDATE vault_reward_actions SET state='executed'"),/permission denied/);

    const joeyVault = "0xc0d256dae91bf37c3c551bc1ed1eeeefbe56d9de6c5c44e11d76288e66403c0d";
    const joeyInputs = {
      ...frozenPlan, vaultId: joeyVault, qualifiers: 0, globalWeight: "0",
      payoutPolicy: "both-assets-to-holders" as const,
      memeType: "0xbcd73dc8d774982c2da4e07cd1c6803ec29e128821d1ade9e9a7ce4975b44944::joey::JOEY",
      quoteType: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
    };
    const seedJoeyPlan = async (offset: bigint, inputs: Partial<Frozen>, stage = "qualifying") => {
      const periodId = randomUUID(), planId = randomUUID();
      const startMs = (BigInt(joeyInputs.startMs) + offset).toString();
      const endMs = (BigInt(joeyInputs.endMs) + offset).toString();
      await admin.query("INSERT INTO vault_reward_periods(period_id,network,deployment_fingerprint,vault_id,start_ms,end_ms,status) VALUES($1,'mainnet',$2,$3,$4,$5,'planning')",
        [periodId, fingerprint, joeyVault, startMs, endMs]);
      await admin.query("INSERT INTO vault_reward_plans(plan_id,period_id,number,stage,inputs) VALUES($1,$2,0,$3,$4)",
        [planId, periodId, stage, json({ ...joeyInputs, reserve: "0", ...inputs, startMs, endMs })]);
      return planId;
    };
    const joeyPlan = async (grossMeme: string, grossQuote: string, offset: bigint, quotePrice = joeyInputs.quotePrice) => {
      const planId = await seedJoeyPlan(offset, { grossMeme, grossQuote, quotePrice });
      const known = await fillIdentityGaps(planner, planId, async () => { throw new Error("a round below the holder minimum must not read holder identities"); });
      await qualifyPage(planner, planId, known);
      return planId;
    };
    const lowSuiPlan = await joeyPlan("10000", "99", 0n);
    assert.equal((await readPlan(watcher, lowSuiPlan)).stage, "skipped", "JOEY stays in the vault while SUI is below the minimum");
    const lowQuoteOnlyPlan = await joeyPlan("0", "99", DAY_MS);
    assert.equal((await readPlan(watcher, lowQuoteOnlyPlan)).stage, "skipped");
    const noQuotePlan = await joeyPlan("10000", "0", 2n * DAY_MS, null);
    assert.equal((await readPlan(watcher, noQuotePlan)).stage, "skipped", "JOEY cannot fund a round without SUI");

    const largeCohortPlan = await seedJoeyPlan(4n * DAY_MS, {
      grossMeme: "100", grossQuote: "100", qualifiers: 65_535, globalWeight: (65_535n * 5n * DAY_MS).toString(),
    });
    assert.equal(await qualifyPage(planner, largeCohortPlan, known), true);
    const largeCohort = await readPlan(watcher, largeCohortPlan);
    assert.equal(frozenSchema.parse(largeCohort.inputs).qualifiers, 65_539);
    assert.equal(largeCohort.stage, "skipped", "a large cohort with too little SUI skips without hitting the leaf cap");

    const roundedQuotePlan = await seedJoeyPlan(5n * DAY_MS, {
      grossMeme: "10000", grossQuote: "1", qualifiers: 2, globalWeight: "2",
      quotePrice: { numerator: "100", denominator: "1", evidence: {} },
    }, "allocating");
    await admin.query("INSERT INTO vault_reward_holders VALUES($1,$2,1),($1,$3,1)", [roundedQuotePlan, id("0xd1"), id("0xd2")]);
    assert.equal(await allocatePage(planner, roundedQuotePlan), true);
    assert.equal((await readPlan(watcher, roundedQuotePlan)).stage, "skipped", "JOEY stays in the vault when all SUI allocations round to zero");

    // Skipped allocations can never become a Meme-only round, including during signed recovery.
    await admin.query("UPDATE vault_reward_plans SET stage='proofs' WHERE plan_id=$1", [roundedQuotePlan]);
    await buildManifest(planner, roundedQuotePlan);
    await uploadManifest(planner, roundedQuotePlan, storage);
    await assert.rejects(reservePlan(planner, deployment, roundedQuotePlan), { message: "Reward reservation requires a holder Quote payout." });
    const stalePlan = await readPlan(watcher, roundedQuotePlan);
    const commitment = planCommitment(frozenSchema.parse(stalePlan.inputs), stalePlan.manifest, stalePlan.storage_hash);
    await admin.query("UPDATE vault_reward_plans SET stage='scheduled',inputs=inputs||jsonb_build_object('commitment',$2::text) WHERE plan_id=$1", [roundedQuotePlan, commitment]);
    const stalePublish = {
      ...base, kind: "publish_round" as const, planId: roundedQuotePlan, operation: "stale-meme-only-publication",
      vault: { ...vault, objectId: joeyVault }, memeType: joeyInputs.memeType, quoteType: joeyInputs.quoteType,
      reserve: "0", manifest: manifestSummary(stalePlan.manifest), storageHash: stalePlan.storage_hash!,
    };
    const staleAction = (await rewardAction(watcher, stalePublish, 3))!;
    const staleBytes = await bytes(stalePublish);
    await reserveRewardBytes(watcher, staleAction, staleBytes);
    const signedAction = (await rewardAction(watcher, stalePublish, 3))!;
    await persistRewardSignature(watcher, signedAction.action_id, staleBytes, { digest: signedAction.digest!, signature: "stale-fixture" });
    let staleSends = 0;
    const staleAlerts: string[] = [];
    await vaultRewardsJob({ adminCapId: cap.objectId, relayBatch: 16, pricePolicy: settings }, chain([]), {
      raise: async (key: string) => { staleAlerts.push(key); return "held" as const; }, clear: async () => {},
    }).run({
      ...liveEpoch, config: { ...liveEpoch.config, timings: { ...liveEpoch.config.timings, providerTimeoutMs: 100, confirmTimeoutMs: 100 } },
      client: { core: { ...liveEpoch.client.core, executeTransaction: async () => { staleSends++; throw new Error("unexpected send"); } } },
    } as unknown as typeof liveEpoch);
    assert.equal(staleSends, 0, "recovery never resends a signed Meme-only publication");
    assert.ok(staleAlerts.includes(`reward_custody:${roundedQuotePlan}`));
    await resolveRewardAction(watcher, signedAction.action_id, "expired");
    await admin.query("UPDATE vault_reward_plans SET stage='skipped' WHERE plan_id=$1", [roundedQuotePlan]);

    const overCapPlan = await seedJoeyPlan(6n * DAY_MS, { grossMeme: "100", grossQuote: "100", qualifiers: 1, globalWeight: "1" }, "allocating");
    await admin.query("INSERT INTO vault_reward_holders VALUES($1,$2,1)", [overCapPlan, id("0xd1")]);
    await admin.query("INSERT INTO vault_reward_allocations(plan_id,leaf_index,beneficiary,meme_amount,quote_amount) SELECT $1,n,'0x'||lpad(to_hex(n+65536),64,'0'),0,1 FROM generate_series(0,65535) AS n", [overCapPlan]);
    await assert.rejects(allocatePage(planner, overCapPlan), { message: "Reward allocations exceed the contract leaf cap." }, "more than 65,536 holder allocations exceeds the on-chain cap");

    // A later period sees both assets because the skipped period reserved neither.
    await admin.query("UPDATE reward_test_delayed SET applied_checkpoint=1");
    await admin.query("INSERT INTO reward_test_vaults VALUES($1,$2,'launch',$3,$4,$5,1,1000,10)",[joeyVault,id("0xef"),memeType,quoteType,id("0xdd")]);
    const joeyCollected={...collected,bcs:Buffer.from(vaultEventBcs.FeesCollected.serialize({vault_id:joeyVault,gross_meme_amount:100n,gross_quote_amount:90n,protocol_meme_amount:0n,protocol_quote_amount:0n,route_meme_amounts:[100n],route_quote_amounts:[90n]}).toBytes()).toString("base64")};
    await admin.query("INSERT INTO blast_infra_fixture.transaction_evidence VALUES($1,20,86401000,$2,true,$3)",[digest("8"),key.toSuiAddress(),json([joeyCollected])]);
    await admin.query("INSERT INTO reward_test_collections SELECT $1,checkpoint,tx_slot,event_slot,$2,fee_split,route_meme_amounts,ARRAY[90]::numeric[] FROM reward_test_collections WHERE vault_id=$3",[joeyVault,digest("8"),vault.objectId]);
    const backlogPeriod=randomUUID();
    await admin.query("INSERT INTO vault_reward_periods(period_id,network,deployment_fingerprint,vault_id,start_ms,end_ms,status) VALUES($1,'mainnet',$2,$3,1001,86401000,'planning')",[backlogPeriod,fingerprint,joeyVault]);
    const backlogPlan = await freezePeriod(planner, deployment, settings, backlogPeriod);
    const backlog = frozenSchema.parse((await readPlan(watcher, backlogPlan)).inputs);
    assert.deepEqual([backlog.grossMeme, backlog.grossQuote], ["100", "90"], "both assets carry forward");
    await qualifyPage(planner, backlogPlan, known);
    await allocatePage(planner, backlogPlan);
    await buildManifest(planner, backlogPlan);
    const backlogManifest = manifestSummary((await readPlan(watcher, backlogPlan)).manifest);
    assert.deepEqual([backlogManifest.memeAmount, backlogManifest.quoteAmount], ["100", "90"], "the combined fee value qualifies below $100 in Quote");

    const pagedPeriod=randomUUID(), pagedPlan=randomUUID();
    await admin.query("INSERT INTO vault_reward_periods(period_id,network,deployment_fingerprint,vault_id,start_ms,end_ms,status) VALUES($1,'mainnet',$2,$3,1010,86401000,'planning')",[pagedPeriod,fingerprint,joeyVault]);
    await admin.query("INSERT INTO vault_reward_plans(plan_id,period_id,number,stage,inputs) VALUES($1,$2,1,'allocating',$3)",
      [pagedPlan,pagedPeriod,json({...joeyInputs,number:"1",qualifiers:513,globalWeight:"513",grossMeme:"514",grossQuote:"51300",reserve:"0"})]);
    await admin.query("INSERT INTO vault_reward_holders SELECT $1,'0x'||lpad(to_hex(n),64,'0'),1 FROM (SELECT generate_series(1,512) AS n UNION ALL SELECT 4097) holders",[pagedPlan]);
    assert.equal(await allocatePage(planner,pagedPlan),false);
    assert.equal(await allocatePage(planner,pagedPlan),true);
    await buildManifest(planner,pagedPlan);
    assert.deepEqual((await admin.query("SELECT leaf_index,beneficiary,meme_amount::text AS meme,quote_amount::text AS quote FROM vault_reward_allocations WHERE plan_id=$1 AND leaf_index>=512 ORDER BY leaf_index",[pagedPlan])).rows,[
      {leaf_index:512,beneficiary:id("0x1001"),meme:"1",quote:"100"},
    ],"both assets are paid to holders across pages in canonical address order");
    assert.equal(manifestSummary((await readPlan(watcher,pagedPlan)).manifest).memeAmount,"513",
      "one atomic unit of Meme remains unallocated after rounding");

    const retryPlan = await seedJoeyPlan(7n * DAY_MS, {
      grossMeme: "100000000", grossQuote: "416000000", qualifiers: 425, globalWeight: "425",
      memePrice: { numerator: "1", denominator: "1000000", evidence: {} },
      quotePrice: { numerator: "1", denominator: "1000000", evidence: {} },
    });
    const { period_id: retryPeriod } = await readPlan(watcher, retryPlan);
    await admin.query("UPDATE vault_reward_periods SET status='skipped',inputs=$2 WHERE period_id=$1", [retryPeriod, json({ reason: "low-budget" })]);
    await admin.query("UPDATE vault_reward_plans SET stage='skipped' WHERE plan_id=$1", [retryPlan]);
    await admin.query("INSERT INTO vault_reward_holders SELECT $1,'0x'||lpad(to_hex(n),64,'0'),1 FROM generate_series(1,425) AS n", [retryPlan]);
    await assert.rejects(retrySkippedPeriod(planner, fingerprint, vault.objectId, retryPeriod), { message: "No latest, untouched low-budget reward plan matches this period." });
    assert.equal(await retrySkippedPeriod(planner, fingerprint, joeyVault, retryPeriod), retryPlan);
    assert.equal((await readPlan(watcher, retryPlan)).stage, "allocating");
    await assert.rejects(retrySkippedPeriod(planner, fingerprint, joeyVault, retryPeriod), { message: "No latest, untouched low-budget reward plan matches this period." });
    assert.equal(await allocatePage(planner, retryPlan), true);
    assert.equal((await readPlan(watcher, retryPlan)).stage, "proofs");

    for (const [offset, grossMeme, grossQuote] of [[8n, "2", "0"], [9n, "0", "2"], [10n, "1", "1"]] as const) {
      const smallPlan = await seedJoeyPlan(offset * DAY_MS, {
        payoutPolicy: "no-minimum", grossMeme, grossQuote, quotePrice: null, qualifiers: 2, globalWeight: "2",
      }, "allocating");
      await admin.query("INSERT INTO vault_reward_holders VALUES($1,$2,1),($1,$3,1)", [smallPlan, id("0xd1"), id("0xd2")]);
      await allocatePage(planner, smallPlan);
      if (offset === 10n) {
        assert.equal((await readPlan(watcher, smallPlan)).stage, "skipped", "atomic dust carries until there is a positive allocation");
      } else {
        await buildManifest(planner, smallPlan);
        const manifest = manifestSummary((await readPlan(watcher, smallPlan)).manifest);
        assert.deepEqual([manifest.memeAmount, manifest.quoteAmount, manifest.leafCount], [grossMeme, grossQuote, 2]);
      }
    }

    const catchUpVault = id("0x3333"), defaultVault = id("0x4444");
    for (const v of [catchUpVault, defaultVault]) {
      await admin.query("INSERT INTO reward_test_vaults VALUES($1,$2,'launch',$3,$4,$5,1,0,1)", [v, id("0xef"), memeType, quoteType, id("0xdd")]);
      await admin.query(`INSERT INTO vault_reward_periods(period_id,network,deployment_fingerprint,vault_id,start_ms,end_ms,status)
        VALUES($1,'mainnet',$2,$3,0,$4,'skipped')`, [randomUUID(), fingerprint, v, DAY_MS.toString()]);
    }
    const catchUpAtMs = cut.timestampMs;
    const scopedSettings = { ...settings, noMinimumVaults: [catchUpVault], catchUpAtMs };
    await Promise.all([discoverPeriods(planner, scopedSettings, 8), discoverPeriods(planner, scopedSettings, 8)]);
    const windows = () => admin.query(`SELECT vault_id,start_ms::text,end_ms::text,status FROM vault_reward_periods
      WHERE vault_id=ANY($1) ORDER BY vault_id,start_ms`, [[catchUpVault, defaultVault]]);
    assert.deepEqual((await windows()).rows, [
      { vault_id: catchUpVault, start_ms: "0", end_ms: DAY_MS.toString(), status: "skipped" },
      { vault_id: catchUpVault, start_ms: "1000", end_ms: catchUpAtMs, status: "planning" },
      { vault_id: defaultVault, start_ms: "0", end_ms: DAY_MS.toString(), status: "skipped" },
    ], "only the opted-in vault rebases and racing discovery inserts one catch-up window");
    const nextDay = (BigInt(catchUpAtMs) + DAY_MS).toString();
    await admin.query("UPDATE vault_reward_periods SET status='funded' WHERE vault_id=$1 AND end_ms=$2", [catchUpVault, catchUpAtMs]);
    await admin.query("INSERT INTO checkpoint_journal(checkpoint,network,digest,epoch,timestamp_ms,total_transactions,format_version,payload,payload_hash) VALUES(21,'mainnet',$1,1,$2,1,1,''::bytea,decode(repeat('00',32),'hex'))", [digest("D"), nextDay]);
    await admin.query("INSERT INTO blast_infra_fixture.checkpoint_headers VALUES(21,$1,$2)", [digest("D"), nextDay]);
    await admin.query("UPDATE watermarks SET checkpoint_hi_inclusive=21,timestamp_ms_hi_inclusive=$1 WHERE pipeline IN ('market','intake')", [nextDay]);
    await discoverPeriods(planner, scopedSettings, 8);
    assert.deepEqual((await windows()).rows.filter(row => row.status === "planning"), [
      { vault_id: catchUpVault, start_ms: catchUpAtMs, end_ms: nextDay, status: "planning" },
      { vault_id: defaultVault, start_ms: DAY_MS.toString(), end_ms: (2n * DAY_MS).toString(), status: "planning" },
    ], "the catch-up anchors the next 24-hour window while other vaults keep their old cadence");
  } finally { await planner.end();await watcher.end();await admin.end();await database.drop(); }
});
