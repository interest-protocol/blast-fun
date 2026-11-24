import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { bcs } from "@mysten/sui/bcs";
import { TransactionError, type ClientWithCoreApi, type SuiClientTypes } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { deriveObjectID, fromBase64, toBase64 } from "@mysten/sui/utils";

import { EMPTY_SALE_METADATA } from "@blast/core/modules/social/contracts/sales.ts";

import { publishPresale } from "./create-publish-flow.ts";

const address = (suffix: string) => `0x${suffix.padStart(64, "0")}`;
const CREATOR = address("c0");
const COIN_TYPE = `${address("c01")}::mrdn::MRDN`;
const PRESALE_PACKAGE = {
  package_id: address("b1"),
  original_package_id: address("b0"),
  core_original_package_id: address("a0"),
};
const SEALED_TREASURY_CAP = { object_id: address("ca"), version: "12", digest: "sealed-cap-digest" };
const SHARED_CURRENCY_ID = deriveObjectID(address("c"), `0x2::coin_registry::CurrencyKey<${COIN_TYPE}>`, new Uint8Array([0]));
const STEPS = ["publish_coin", "register_currency", "create_presale"];

function fixture(context: TestContext) {
  const stored = new Map<string, string>();
  const confirmed = new Map<string, unknown>();
  const executed: number[] = [];
  const requested: Record<string, unknown>[] = [];
  const progress: string[] = [];
  let metadataAvailable = true;
  let cancelAt = 0;
  let timeoutAt = 0;
  let failedAt = 0;
  let failedError: SuiClientTypes.ExecutionError | undefined;
  let changeSignedBytes = false;
  let expiredAt = 0;
  let omitSponsorship = false;
  let buildError: Error | undefined;
  let registryObject: unknown = null;
  let registerDuringBuild = false;
  let registerDuringSubmit = false;
  let registryUnavailable = false;
  const signed: number[] = [];
  function registerExternally(type = `0x2::coin_registry::Currency<${COIN_TYPE}>`, shared = true) {
    registryObject = {
      objectId: SHARED_CURRENCY_ID,
      type,
      owner: shared ? { $kind: "Shared", Shared: { initialSharedVersion: "20" } } : { $kind: "AddressOwner", AddressOwner: address("c") },
    };
  }
  const storage = {
    getItem: (key: string) => stored.get(key) ?? null,
    removeItem: (key: string) => { stored.delete(key); },
    setItem: (key: string, value: string) => {
      stored.set(key, value);
    },
  };

  const originalBuild = Transaction.prototype.build;
  // Only the kind is ever built: the sponsor answers the whole transaction, so a zero-SUI wallet never selects gas.
  context.mock.method(Transaction.prototype, "build", async function (this: Transaction, options: { onlyTransactionKind?: boolean }) {
    if (buildError) throw buildError;
    assert.ok(options.onlyTransactionKind, "publishing never builds with the wallet's own gas");
    const pure = this.getData().inputs[0]?.Pure;
    assert.ok(pure);
    if (fromBase64(pure.bytes)[0] === 2 && registerDuringBuild) {
      registerExternally();
      throw new Error("Pending currency already consumed");
    }
    return originalBuild.call(this, { onlyTransactionKind: true });
  });
  const result = (step: number, digest: string) => {
    const objects =
      step === 1
        ? [
            { objectId: address("c01"), idOperation: "Created", outputState: "PackageWrite" },
            {
              objectId: SEALED_TREASURY_CAP.object_id,
              idOperation: "Created",
              outputVersion: SEALED_TREASURY_CAP.version,
              outputDigest: SEALED_TREASURY_CAP.digest,
              outputOwner: { $kind: "AddressOwner", AddressOwner: CREATOR },
            },
            {
              objectId: address("cc"),
              idOperation: "Created",
              outputVersion: "12",
              outputDigest: "receiving-digest",
              outputOwner: { $kind: "AddressOwner", AddressOwner: address("c") },
            },
          ]
        : step === 2
          ? [
              { objectId: address("cc"), idOperation: "Deleted" },
              {
                objectId: SHARED_CURRENCY_ID,
                idOperation: "Created",
                outputOwner: {
                  $kind: "Shared",
                  Shared: { initialSharedVersion: "13" },
                },
              },
            ]
          : [{ objectId: address("5a1e"), idOperation: "Created" }];
    const objectTypes =
      step === 1
        ? {
            [address("c01")]: "package",
            [SEALED_TREASURY_CAP.object_id]: `${PRESALE_PACKAGE.core_original_package_id}::sealed_treasury_cap::SealedTreasuryCap<${COIN_TYPE}>`,
            [address("cc")]: `0x2::coin_registry::Currency<${COIN_TYPE}>`,
          }
        : step === 2
          ? { [SHARED_CURRENCY_ID]: `0x2::coin_registry::Currency<${COIN_TYPE}>` }
          : {
              [address("5a1e")]: `${PRESALE_PACKAGE.original_package_id}::blast_presale::Presale<${COIN_TYPE},0x2::sui::SUI>`,
            };
    return {
      $kind: "Transaction",
      Transaction: {
        digest,
        effects: { status: { success: true }, changedObjects: objects },
        objectTypes,
      },
    };
  };
  const client = {
    core: {
      async getObjects({ objectIds }: { objectIds: string[] }) {
        assert.deepEqual(objectIds, [SHARED_CURRENCY_ID]);
        if (registryUnavailable) throw new Error("Registry unavailable");
        return { objects: registryObject ? [registryObject] : [] };
      },
      async getTransaction({ digest }: { digest: string }) {
        if (!confirmed.has(digest)) {
          throw new TransactionError("notFound", digest);
        }
        return confirmed.get(digest);
      },
      async waitForTransaction({ digest }: { digest: string }) {
        return confirmed.get(digest);
      },
    },
  } as unknown as ClientWithCoreApi;
  // The sponsor's execute: the step is the reservation id's last digit.
  const execute = async (url: string): Promise<Response> => {
    const step = Number(url.split("/").at(-2)?.slice(-1));
    if (step === expiredAt) { expiredAt = 0; return Response.json({ error: { code: "reservation_expired" } }, { status: 410 }); }
    const saved = JSON.parse([...stored.values()][0]!) as { transactions: Record<string, { digest: string }> };
    const digest = saved.transactions[STEPS[step - 1]!]!.digest;
    executed.push(step);
    if (step === 2 && registerDuringSubmit) registerExternally();
    confirmed.set(digest, step === failedAt ? { $kind: "FailedTransaction", FailedTransaction: { effects: { status: { success: false, error: failedError } } } } : result(step, digest));
    if (step === timeoutAt) { timeoutAt = 0; throw new Error("Network timeout after execution"); }
    return Response.json({ digest, effects: { status: step === failedAt ? "failure" : "success", gas_used: "1000" } });
  };
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (String(url).includes("/sponsor/")) return execute(String(url));
    if (String(url).endsWith("/published")) {
      return metadataAvailable
        ? Response.json({ presale_id: body.presale_id, metadata: EMPTY_SALE_METADATA, editable: true })
        : Response.json({ error: { code: "service_unavailable" } }, { status: 503 });
    }
    requested.push(body);
    const transaction = new Transaction();
    transaction.setSender(CREATOR);
    transaction.pure.u8(STEPS.indexOf(String(body.step)) + 1);
    const step = STEPS.indexOf(String(body.step)) + 1;
    const kind = await originalBuild.call(transaction, { onlyTransactionKind: true });
    const sponsoredBytes = bcs.TransactionData.serialize({ V1: { kind: bcs.TransactionKind.parse(kind), sender: CREATOR, gasData: { owner: address("5b"), price: "750", budget: "2000000", payment: [] }, expiration: { None: true } } }).toBytes();
    return Response.json({
      draft_id: "draft",
      version: 4,
      steps: [{ kind: body.step, presale_package: PRESALE_PACKAGE, transaction: await transaction.toJSON(), ...(!omitSponsorship ? { sponsorship: { reservation_id: `00000000-0000-4000-8000-00000000000${step}`, transaction_bytes: toBase64(sponsoredBytes) } } : {}) }],
    });
  };
  const input = {
    api: { getAccessToken: async () => "token", fetch },
    client,
    storage,
    draftId: "draft",
    version: 4,
    creator: CREATOR,
    fee: "sponsored" as const,
    async sign(bytes: Uint8Array) {
      const step = fromBase64(bcs.TransactionData.parse(bytes).V1!.kind.ProgrammableTransaction!.inputs[0]!.Pure!.bytes)[0];
      signed.push(step!);
      if (cancelAt && step === cancelAt) {
        throw new Error("Wallet approval cancelled");
      }
      return {
        bytes: toBase64(changeSignedBytes ? new Uint8Array([99]) : bytes),
        signature: "test-signature",
      };
    },
    progress(message: string) { progress.push(message); },
  };
  return {
    input,
    stored,
    executed,
    requested,
    progress,
    signed,
    registerExternally,
    registerOnBuild: () => { registerDuringBuild = true; },
    registerOnSubmit: () => { registerDuringSubmit = true; },
    registryUnavailable: () => { registryUnavailable = true; },
    cancel: (step: number) => {
      cancelAt = step;
    },
    timeout: (step: number) => {
      timeoutAt = step;
    },
    fail: (step: number, error?: SuiClientTypes.ExecutionError) => {
      failedAt = step;
      failedError = error;
    },
    metadata: (available: boolean) => {
      metadataAvailable = available;
    },
    expired: (step: number) => { expiredAt = step; },
    buildFail: (error: Error | undefined) => { buildError = error; },
    omitSponsor: () => { omitSponsorship = true; },
    changeBytes: () => {
      changeSignedBytes = true;
    },
  };
}

test("publishing hands the derived shared currency to the presale and resumes a cancelled approval", async (context) => {
  const flow = fixture(context);
  const confirmed = new Map<string, string>();
  const input = {
    ...flow.input,
    onConfirmed: (step: string, digest: string) => { confirmed.set(step, digest); },
  };
  flow.cancel(2);
  await assert.rejects(publishPresale(input), /cancelled/);
  assert.deepEqual(flow.executed, [1]);
  assert.deepEqual([...confirmed.keys()], ["publish_coin"]);
  flow.cancel(0);
  assert.equal(await publishPresale(input), address("5a1e"));
  assert.deepEqual([...confirmed.keys()], ["publish_coin", "register_currency", "create_presale"]);
  assert.equal(new Set(confirmed.values()).size, 3);
  assert.deepEqual(flow.executed, [1, 2, 3]);
  assert.deepEqual(flow.requested.at(-1)?.coin, {
    coin_type: COIN_TYPE,
    sealed_treasury_cap: SEALED_TREASURY_CAP,
    currency: { object_id: SHARED_CURRENCY_ID, initial_shared_version: "13" },
  });
  assert.ok(![...flow.stored.values()].some((value) => value.includes("test-signature")));
});

test("leaving after broadcast still confirms the submitted step and stops the next one", async (context) => {
  const flow = fixture(context);
  const page = new AbortController();
  const confirmed: string[] = [];
  await assert.rejects(publishPresale({
    ...flow.input,
    api: {
      ...flow.input.api,
      signal: page.signal,
      async fetch(url, init) {
        const response = await flow.input.api.fetch(url, init);
        if (String(url).includes("/sponsor/")) page.abort();
        init?.signal?.throwIfAborted();
        return response;
      },
    },
    onConfirmed: (step) => void confirmed.push(step),
  }), { name: "AbortError" });
  assert.deepEqual(flow.executed, [1]);
  assert.deepEqual(flow.signed, [1]);
  assert.deepEqual(confirmed, ["publish_coin"]);
});

test("a resumed publication reuses a currency registered by anyone without another registration approval", async (context) => {
  const flow = fixture(context);
  flow.cancel(2);
  await assert.rejects(publishPresale(flow.input), /cancelled/);
  flow.registerExternally();
  flow.cancel(0);
  assert.equal(await publishPresale(flow.input), address("5a1e"));
  assert.deepEqual(flow.executed, [1, 3]);
  assert.deepEqual(flow.signed, [1, 2, 3]);
  assert.deepEqual(flow.requested.at(-1)?.coin, {
    coin_type: COIN_TYPE,
    sealed_treasury_cap: SEALED_TREASURY_CAP,
    currency: { object_id: SHARED_CURRENCY_ID, initial_shared_version: "20" },
  });
});

test("a competing registration during transaction preparation proceeds with the shared currency", async (context) => {
  const flow = fixture(context);
  flow.registerOnBuild();
  assert.equal(await publishPresale(flow.input), address("5a1e"));
  assert.deepEqual(flow.executed, [1, 3]);
  assert.deepEqual(flow.signed, [1, 3]);
  assert.deepEqual(flow.requested.at(-1)?.coin, {
    coin_type: COIN_TYPE,
    sealed_treasury_cap: SEALED_TREASURY_CAP,
    currency: { object_id: SHARED_CURRENCY_ID, initial_shared_version: "20" },
  });
});

test("a failed registration reconciles a competing registration before creating the presale", async (context) => {
  const flow = fixture(context);
  flow.fail(2);
  flow.timeout(2);
  flow.registerOnSubmit();
  const notified: string[] = [];
  assert.equal(await publishPresale({ ...flow.input, onConfirmed: (step) => notified.push(step) }), address("5a1e"));
  assert.deepEqual(notified, ["publish_coin", "create_presale"]);
  assert.deepEqual(flow.executed, [1, 2, 3]);
  assert.deepEqual(flow.requested.at(-1)?.coin, {
    coin_type: COIN_TYPE,
    sealed_treasury_cap: SEALED_TREASURY_CAP,
    currency: { object_id: SHARED_CURRENCY_ID, initial_shared_version: "20" },
  });
});

test("a registration that lands despite a lost sponsor reply gets its own confirmation", async (context) => {
  const flow = fixture(context);
  flow.timeout(2);
  flow.registerOnSubmit();
  const notified: string[] = [];
  assert.equal(await publishPresale({ ...flow.input, onConfirmed: (step) => notified.push(step) }), address("5a1e"));
  assert.deepEqual(flow.executed, [1, 2, 3]);
  assert.deepEqual(notified, ["publish_coin", "register_currency", "create_presale"]);
});

for (const status of [null, 500, 503]) {
  const failure = status === null ? "browser network error" : `HTTP ${status}`;
  test(`a lost registration reply after leaving still confirms the submitted digest (${failure})`, async (context) => {
    const flow = fixture(context);
    const page = new AbortController();
    flow.timeout(2);
    flow.registerOnSubmit();
    const notified = new Map<string, string>();
    const lookup = context.mock.method(flow.input.client.core, "getTransaction");
    await assert.rejects(publishPresale({
      ...flow.input,
      api: {
        ...flow.input.api,
        signal: page.signal,
        async fetch(url, init) {
          if (!String(url).endsWith("000000000002/execute")) return flow.input.api.fetch(url, init);
          try {
            return await flow.input.api.fetch(url, init);
          } catch (error) {
            if (status === null) throw error;
            return Response.json(
              { error: { code: "service_unavailable" } },
              { status, headers: { "Cache-Control": "private, no-store", "Retry-After": "5" } },
            );
          } finally {
            page.abort();
          }
        },
      },
      onConfirmed: (step, digest) => { notified.set(step, digest); },
    }), { name: "AbortError" });
    const saved = JSON.parse([...flow.stored.values()][0]!);
    const digest = saved.transactions.register_currency.digest;
    assert.equal(notified.get("register_currency"), digest);
    assert.deepEqual([...notified.keys()], ["publish_coin", "register_currency"]);
    assert.deepEqual(lookup.mock.calls.map(({ arguments: [request] }) => request.digest), [digest]);
    assert.deepEqual(flow.executed, [1, 2]);
    assert.deepEqual(flow.signed, [1, 2]);
  });
}

test("publishing can continue with an unreadable registration receipt and confirm it on resume", async (context) => {
  const flow = fixture(context);
  flow.timeout(2);
  flow.registerOnSubmit();
  flow.cancel(3);
  const read = context.mock.method(flow.input.client.core, "getTransaction", async () => { throw new Error("Receipt unavailable"); });
  const notified: string[] = [];
  const input = { ...flow.input, onConfirmed: (step: string) => notified.push(step) };
  await assert.rejects(publishPresale(input), /cancelled/);
  assert.deepEqual(flow.executed, [1, 2]);
  assert.deepEqual(notified, ["publish_coin"]);

  read.mock.restore();
  flow.cancel(0);
  notified.length = 0;
  assert.equal(await publishPresale(input), address("5a1e"));
  assert.deepEqual(flow.executed, [1, 2, 3]);
  assert.deepEqual(notified, ["publish_coin", "register_currency", "create_presale"]);
});

test("registration failure without a matching shared currency stops before presale creation", async (context) => {
  const flow = fixture(context);
  flow.fail(2);
  flow.registerExternally(`0x2::coin_registry::Currency<${address("bad")}::other::OTHER>`);
  await assert.rejects(publishPresale(flow.input), /failed on-chain/);
  assert.deepEqual(flow.executed, [1, 2]);
  flow.registerExternally(undefined, false);
  await assert.rejects(publishPresale(flow.input), /failed on-chain/);
  assert.deepEqual(flow.executed, [1, 2, 2]);
  flow.fail(0);
  assert.equal(await publishPresale(flow.input), address("5a1e"));
  assert.deepEqual(flow.executed, [1, 2, 2, 2, 3]);
});

test("an unavailable registry read stops before registration approval", async (context) => {
  const flow = fixture(context);
  flow.registryUnavailable();
  await assert.rejects(publishPresale(flow.input), /Registry unavailable/);
  assert.equal(flow.progress.at(-1), "2 of 4 · Register currency");
  assert.deepEqual(flow.executed, [1]);
  assert.deepEqual(flow.signed, [1]);
});

test("a lost execution response and failed metadata save resume without publishing twice", async (context) => {
  const flow = fixture(context);
  flow.timeout(1);
  await assert.rejects(publishPresale(flow.input), /could not confirm/);
  flow.metadata(false);
  await assert.rejects(publishPresale(flow.input), /presale is on-chain/);
  assert.equal(flow.progress.at(-1), "4 of 4 · Finalizing coin");
  assert.deepEqual(flow.signed, [1, 2, 3], "finalization does not ask for another wallet approval");
  flow.metadata(true);
  assert.equal(await publishPresale(flow.input), address("5a1e"));
  assert.deepEqual(flow.executed, [1, 2, 3]);
  assert.equal(flow.stored.size, 0, "completed publish progress must not remain resumable");
});

test("sponsored publish explains its daily limit and keeps completed steps for a later retry", async (context) => {
  const flow = fixture(context);
  flow.cancel(2);
  await assert.rejects(publishPresale(flow.input), /cancelled/);
  const saved = [...flow.stored.entries()];
  const fetchPlan = flow.input.api.fetch;
  flow.input.api.fetch = async () => Response.json({ error: { code: "rate_limited", reason: "daily_limit" } }, { status: 429, headers: { "X-Request-ID": "publish-budget-reference" } });
  await assert.rejects(publishPresale(flow.input), /daily limit for Blast-paid network fees\. Try again after 00:00 UTC\. Code: rate_limited\/daily_limit\. Reference: publish-budget-reference/);
  assert.deepEqual([...flow.stored.entries()], saved);
  assert.deepEqual(flow.executed, [1]);
  flow.input.api.fetch = fetchPlan;
  flow.cancel(0);
  assert.equal(await publishPresale(flow.input), address("5a1e"));
  assert.deepEqual(flow.executed, [1, 2, 3]);
});

test("sponsored publish explains pending transactions and other sponsorship limits before signing", async (context) => {
  const flow = fixture(context);
  for (const [reason, message] of [["open_reservations", /pending sponsored transactions/], [undefined, /network fees are temporarily limited/]] as const) {
    flow.input.api.fetch = async () => Response.json({ error: { code: "rate_limited", reason } }, { status: 429 });
    await assert.rejects(publishPresale(flow.input), message);
    assert.deepEqual(flow.executed, []);
    assert.equal(flow.stored.size, 0);
  }
});

test("publish failures keep a safe code and server reference without displaying internal messages", async (context) => {
  const flow = fixture(context);
  const headers = { "X-Request-ID": "publish-failure-reference" };
  for (const response of [
    Response.json({ error: { code: "service_unavailable", message: "secret database connection string" } }, { status: 503, headers }),
    new Response("invalid upstream response", { status: 502, headers }),
  ]) {
    flow.input.api.fetch = async () => response;
    await assert.rejects(publishPresale(flow.input), (error: Error) => {
      assert.match(error.message, /Reference: publish-failure-reference/);
      assert.doesNotMatch(error.message, /secret|database|upstream/);
      return true;
    });
    assert.deepEqual(flow.executed, []);
  }
});

test("a refused publish names the coin restriction before signing", async (context) => {
  const flow = fixture(context);
  await assert.rejects(publishPresale({ ...flow.input, api: {
    ...flow.input.api,
    fetch: async () => Response.json({ error: { code: "publish_unavailable", reasons: ["creation_policy"], contract_error: "EQuoteNotAllowed" } }, { status: 409 }),
  } }), /This coin is not allowed for new presales/);
  assert.deepEqual(flow.executed, []);
  assert.equal(flow.stored.size, 0);
});

test("an empty legacy checkpoint leaves a refused raise editable and shows the server minimum", async (context) => {
  const flow = fixture(context);
  const key = `blast:create:publish:v1:${flow.input.creator}:${flow.input.draftId}`;
  flow.stored.set(key, '{"version":3,"transactions":{}}');
  flow.input.api.fetch = async () => Response.json({ error: {
    code: "draft_incomplete", reason: "minimum_raise",
    issues: [{ section: "raise", path: "target", message: "Set a target of at least 1,000 USDC." }],
  } }, { status: 422 });
  await assert.rejects(publishPresale(flow.input), /Set a target of at least 1,000 USDC/);
  assert.deepEqual(flow.signed, []);
  assert.equal(flow.stored.size, 0);
});

test("a failed presale transaction retries only that step", async (context) => {
  const flow = fixture(context);
  flow.fail(3);
  await assert.rejects(publishPresale(flow.input), /failed on-chain/);
  flow.fail(0);
  assert.equal(await publishPresale(flow.input), address("5a1e"));
  assert.deepEqual(flow.executed, [1, 2, 3, 3]);
});

test("changed terms, corrupt storage and changed wallet bytes cannot broadcast", async (context) => {
  const flow = fixture(context);
  flow.cancel(2);
  await assert.rejects(publishPresale(flow.input), /cancelled/);
  await assert.rejects(publishPresale({ ...flow.input, version: 5 }), /draft changed/);
  const key = [...flow.stored.keys()][0]!;
  flow.stored.set(key, '{"version":4,"transactions":{"publish_coin":{"bytes":null}}}');
  await assert.rejects(publishPresale(flow.input), /progress is invalid/);
  flow.stored.set(key, '{"version":4,"transactions":{"unknown_step":{}}}');
  await assert.rejects(publishPresale(flow.input), /progress is invalid/);
  flow.stored.clear();
  flow.changeBytes();
  await assert.rejects(publishPresale(flow.input), /wallet changed/);
  assert.deepEqual(flow.executed, [1]);
});

test("unavailable checkpoint storage prevents broadcasting", async (context) => {
  const flow = fixture(context);
  const storage = {
    ...flow.input.storage,
    setItem() {
      throw new Error("Storage quota exceeded");
    },
  };
  await assert.rejects(publishPresale({ ...flow.input, storage }), /Storage quota/);
  assert.deepEqual(flow.executed, []);
});

test("an invalid API plan is rejected before wallet signing", async (context) => {
  const flow = fixture(context);
  let signed = false;
  await assert.rejects(
    publishPresale({
      ...flow.input,
      api: {
        ...flow.input.api,
        fetch: async () => Response.json({ draft_id: "draft", version: 4, steps: null }),
      },
      async sign(bytes) {
        signed = true;
        return flow.input.sign(bytes);
      },
    }),
    /invalid publish plan/,
  );
  assert.equal(signed, false);
  assert.deepEqual(flow.executed, []);
});


test("a zero-SUI embedded wallet publishes all three steps through the sponsor without wallet gas selection", async (context) => {
  const flow = fixture(context);
  assert.equal(await publishPresale(flow.input), address("5a1e"));
  assert.deepEqual(flow.executed, [1, 2, 3]);
});


test("sponsored publishing recovers a lost response and expired reservation without repeating completed steps", async (context) => {
  const flow = fixture(context);
  flow.timeout(1);
  await assert.rejects(publishPresale(flow.input), /could not confirm/);
  flow.expired(2);
  await assert.rejects(publishPresale(flow.input), /could not confirm/);
  assert.equal(await publishPresale(flow.input), address("5a1e"));
  assert.deepEqual(flow.executed, [1, 2, 3]);
});

test("embedded publishing fails closed when sponsorship is missing or the wallet changes bytes", async (context) => {
  const flow = fixture(context);
  flow.changeBytes();
  await assert.rejects(publishPresale(flow.input), /wallet changed/);
  assert.deepEqual(flow.executed, []);
  flow.omitSponsor();
  await assert.rejects(publishPresale(flow.input), /did not sponsor/);
  assert.deepEqual(flow.executed, []);
});

for (const [name, message] of [
  ["EMigrationWitnessNotAllowed", /This liquidity venue is not allowed/],
  ["EInvalidWindow", /commitment.*window/i],
] as const) {
  test(`a sponsored dry-run refusal explains ${name} before signing`, async (context) => {
    const flow = fixture(context);
    await assert.rejects(publishPresale({ ...flow.input, api: {
      ...flow.input.api,
      fetch: async () => Response.json({ error: { code: "dry_run_failed", move_abort: name } }, { status: 422 }),
    } }), message);
    assert.deepEqual(flow.executed, []);
    assert.equal(flow.stored.size, 0);
  });
}

const quoteAbort = (pkg = PRESALE_PACKAGE.package_id): SuiClientTypes.ExecutionError => ({
  $kind: "MoveAbort", message: "raw abort trace",
  MoveAbort: { abortCode: "13837028994300379151", cleverError: { errorCode: 2 }, location: { package: pkg, module: "creation_policy" } },
});

test("a failed on-chain presale names the contract error and retries only that step", async (context) => {
  const flow = fixture(context);
  flow.fail(3, quoteAbort());
  await assert.rejects(publishPresale(flow.input), /This coin is not allowed for new presales/);
  flow.fail(0);
  assert.equal(await publishPresale(flow.input), address("5a1e"));
  assert.deepEqual(flow.executed, [1, 2, 3, 3]);
});

test("another package's matching module and code are never named as a Blast refusal", async (context) => {
  const flow = fixture(context);
  flow.fail(3, quoteAbort(address("dead")));
  await assert.rejects(publishPresale(flow.input), /failed on-chain/);
});
