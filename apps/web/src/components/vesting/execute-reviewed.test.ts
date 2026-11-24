import assert from "node:assert/strict";
import test from "node:test";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import type { VestingAttempt } from "@blast/core/modules/vesting/model.ts";
import { executeReviewedVesting, VestingReviewRequiredError, VestingSubmissionPendingError } from "./execute-reviewed.ts";

const attempt: VestingAttempt = {
  request_id: "attempt",
  action: "create",
  state: "submitted",
  digest: "reviewed-digest",
  transaction_bytes: "AQID",
  schedule_id: null,
  gas_budget: "2000000",
  expires_at_ms: Date.now() + 60_000,
  sponsor_reservation_id: "reservation",
};

function fixture(
  options: {
    sponsored?: boolean;
    lostResponse?: boolean;
    reject?: boolean;
    expires?: boolean;
    wrongDigest?: boolean;
    refusal?: string;
  } = {},
) {
  const calls: string[] = [];
  let submitted = false;
  const reviewed = {
    ...attempt,
    sponsor_reservation_id: options.sponsored === false ? null : "reservation",
  };
  const dependencies: Parameters<typeof executeReviewedVesting>[1] = {
    async refresh() {
      calls.push("refresh");
      return submitted ? { ...reviewed, state: "confirmed" } : reviewed;
    },
    async signTransaction(bytes) {
      calls.push("sign");
      assert.deepEqual(bytes, new Uint8Array([1, 2, 3]));
      if (options.reject) throw new Error("Wallet rejected");
      if (options.expires) reviewed.expires_at_ms = 1;
      return "signature";
    },
    setPhase() {},
    api: {
      getAccessToken: async () => "privy-token",
      async fetch(path, init) {
        calls.push("sponsor");
        assert.equal(path, "/api/presale/sponsor/reservation/execute");
        assert.equal(
          new Headers(init?.headers).get("authorization"),
          "Bearer privy-token",
        );
        assert.deepEqual(JSON.parse(String(init?.body)), {
          user_signature: "signature",
        });
        if (options.lostResponse) {
          submitted = true;
          throw new Error("Lost response");
        }
        if (options.refusal) return Response.json({ error: { code: options.refusal } }, { status: options.refusal === "rate_limited" ? 429 : 410 });
        return Response.json({
          digest: options.wrongDigest ? "another-digest" : attempt.digest,
          effects: { status: "success" },
        });
      },
    },
    chain: {
      core: {
        async waitForTransaction(input: { digest: string }) {
          calls.push("wait");
          assert.equal(input.digest, attempt.digest);
          submitted = true;
        },
      },
    } as unknown as Pick<SuiGrpcClient, "core">,
  };
  return { reviewed, dependencies, calls };
}

for (const action of ["create", "claim", "cancel", "close"] as const) {
  test(`Privy ${action} signs reviewed bytes and executes through the sponsor`, async () => {
    const f = fixture();
    f.reviewed.action = action;
    const result = await executeReviewedVesting(f.reviewed, f.dependencies);
    assert.equal(result.state, "confirmed");
    assert.deepEqual(f.calls, [
      "refresh",
      "sign",
      "sponsor",
      "wait",
      "refresh",
    ]);
  });
}

test("lost sponsor response reconciles the original digest without submitting twice", async () => {
  const f = fixture({ lostResponse: true });
  assert.equal(
    (await executeReviewedVesting(f.reviewed, f.dependencies)).state,
    "confirmed",
  );
  assert.deepEqual(f.calls, ["refresh", "sign", "sponsor", "refresh"]);
});
test("wallet refusal sends nothing", async () => {
  const f = fixture({ reject: true });
  await assert.rejects(
    executeReviewedVesting(f.reviewed, f.dependencies),
    (error: unknown) => error instanceof VestingReviewRequiredError && /Wallet rejected/.test(error.message),
  );
  assert.deepEqual(f.calls, ["refresh", "sign", "refresh"]);
});
test("expired approval sends nothing", async () => {
  const f = fixture({ expires: true });
  await assert.rejects(
    executeReviewedVesting(f.reviewed, f.dependencies),
    VestingReviewRequiredError,
  );
  assert.deepEqual(f.calls, ["refresh", "sign", "refresh"]);
});
test("a historical wallet-gas review is never signed or sent", async () => {
  const f = fixture({ sponsored: false });
  await assert.rejects(
    executeReviewedVesting(f.reviewed, f.dependencies),
    VestingReviewRequiredError,
  );
  assert.deepEqual(f.calls, ["refresh", "refresh"]);
});
test("a sponsor response with a different digest cannot confirm the review", async () => {
  const f = fixture({ wrongDigest: true });
  await assert.rejects(
    executeReviewedVesting(f.reviewed, f.dependencies),
    (error: unknown) => error instanceof VestingSubmissionPendingError && /different transaction/.test(error.message),
  );
  assert.deepEqual(f.calls, ["refresh", "sign", "sponsor", "refresh"]);
});


test("a review that expires before wallet approval can safely be prepared again", async () => {
  const f = fixture();
  f.reviewed.expires_at_ms = 1;
  await assert.rejects(executeReviewedVesting(f.reviewed, f.dependencies), VestingReviewRequiredError);
  assert.deepEqual(f.calls, ["refresh", "refresh"]);
});

test("unconfirmed lost submission remains pending with the original digest", async () => {
  const f = fixture();
  f.dependencies.chain!.core.waitForTransaction = async () => { throw new Error("Timeout"); };
  await assert.rejects(executeReviewedVesting(f.reviewed, f.dependencies), VestingSubmissionPendingError);
  assert.equal(f.reviewed.digest, "reviewed-digest");
  assert.equal(f.calls.filter(call => call === "sign").length, 1);
});

test("failed preflight status read cannot be mistaken for a submission", async () => {
  const f = fixture();
  f.dependencies.refresh = async () => { throw new Error("Unavailable"); };
  await assert.rejects(executeReviewedVesting(f.reviewed, f.dependencies), VestingReviewRequiredError);
  assert.deepEqual(f.calls, []);
});

for (const code of ["reservation_expired", "invalid_signature", "rate_limited", "unauthorized", "not_found", "invalid_parameter", "invalid_request", "origin_invalid", "body_too_large"]) {
  test(`explicit sponsor ${code} permits a fresh review after checking the original attempt`, async () => {
    const f = fixture({ refusal: code });
    await assert.rejects(executeReviewedVesting(f.reviewed, f.dependencies), VestingReviewRequiredError);
    assert.deepEqual(f.calls, ["refresh", "sign", "sponsor", "refresh"]);
  });
}

test("failed sponsor authentication before fetch permits a fresh review", async () => {
  const f = fixture();
  f.dependencies.api = { ...f.dependencies.api, getAccessToken: async () => { throw new Error("Auth provider unavailable"); } };
  await assert.rejects(executeReviewedVesting(f.reviewed, f.dependencies), VestingReviewRequiredError);
  assert.deepEqual(f.calls, ["refresh", "sign", "refresh"]);
});

test("an execution_unconfirmed sponsor response retains status-only recovery", async () => {
  const f = fixture({ refusal: "execution_unconfirmed" });
  await assert.rejects(executeReviewedVesting(f.reviewed, f.dependencies), VestingSubmissionPendingError);
  assert.deepEqual(f.calls, ["refresh", "sign", "sponsor", "refresh"]);
});

test("an unexpected sponsor service failure retains status-only recovery", async () => {
  const f = fixture({ refusal: "service_unavailable" });
  await assert.rejects(executeReviewedVesting(f.reviewed, f.dependencies), VestingSubmissionPendingError);
});
