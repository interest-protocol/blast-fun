import assert from "node:assert/strict";
import test from "node:test";

import { normalizeStructTag } from "@mysten/sui/utils";

import { BLAST_TRADE_FEE_ESTIMATE_RATE } from "@blast/core/lib/blast-trade-fee.ts";
import { findCetusRoute, type TradeRouteRequest } from "@blast/core/modules/social/trades/cetus-route.ts";

const SUI = normalizeStructTag("0x2::sui::SUI");
const USDC = normalizeStructTag("0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC");
const MID = normalizeStructTag("0xabc::mid::MID");
const mid = (index: number) => normalizeStructTag(`0xabc::mid${index}::MID`);
const POOL = `0x${"1".repeat(64)}`;
const request: TradeRouteRequest = { from: SUI, target: USDC, amount: 1_000n, byAmountIn: true };

/** A `find_routes` body whose route has `legs` legs (SUI → mid1 … → USDC), its numbers written raw so exactness shows. */
function body(legs: number, amountOut = "18446744073709551615"): string {
  const hop = (from: string, target: string) =>
    `{"id":"${POOL}","provider":"CETUS","from":"${from}","target":"${target}","direction":true,"fee_rate":"0.0025","amount_in":1000,"amount_out":${amountOut},"published_at":"${POOL}"}`;
  const paths = Array.from({ length: legs }, (_, index) => hop(index === 0 ? SUI : mid(index), index === legs - 1 ? USDC : mid(index + 1)));
  return `{"code":200,"msg":"","data":{"request_id":"r1","amount_in":1000,"amount_out":${amountOut},"deviation_ratio":"0.001","paths":[${paths.join(",")}]}}`;
}

function replay(...answers: (string | Response)[]) {
  const urls: URL[] = [];
  const fetch = (async (input: string | URL | Request) => {
    urls.push(new URL(String(input)));
    const next = answers.shift();
    assert.ok(next !== undefined, "no more answers");
    return typeof next === "string" ? new Response(next) : next;
  }) as typeof globalThis.fetch;
  return { fetch, urls };
}

test("a route keeps u64 atoms exact, takes Blast's fee from its output, and asks only the listed providers", async () => {
  const { fetch, urls } = replay(body(1, "18446744073709551615"));
  const answer = await findCetusRoute({ request, providers: ["CETUS", "BLUEFIN"], fee: BLAST_TRADE_FEE_ESTIMATE_RATE, fetch });
  assert.equal(answer.status, "route");
  if (answer.status !== "route") return;
  const fee = 18_446_744_073_709_551_615n * 3_000n / 1_000_000n;
  assert.equal(answer.route.blastFee, fee);
  assert.equal(answer.route.amountOut, 18_446_744_073_709_551_615n - fee);
  assert.equal(urls[0]!.searchParams.get("providers"), "CETUS,BLUEFIN");
  assert.equal(urls[0]!.searchParams.get("depth"), null);
});

test("a best route past eight legs is asked once more with two splits of three hops", async () => {
  const { fetch, urls } = replay(body(9), body(6));
  const answer = await findCetusRoute({ request, providers: ["CETUS"], fee: null, fetch });
  assert.equal(answer.status === "route" && answer.route.paths.length, 6);
  assert.deepEqual(urls.map((url) => [url.searchParams.get("depth"), url.searchParams.get("split_count")]), [[null, null], ["3", "2"]]);
});

test("each refusal names why: legs, provider, endpoints; aggregator no-route codes are no_route", async () => {
  const cases: [string[], string, Awaited<ReturnType<typeof findCetusRoute>>][] = [
    [[body(9), body(9)], "CETUS", { status: "unavailable", reason: "unusable_route:too_many_legs" }],
    [[body(1)], "BLUEFIN", { status: "unavailable", reason: "unusable_route:provider" }],
    [[body(1).replace(`"target":"${USDC}"`, `"target":"${MID}"`)], "CETUS", { status: "unavailable", reason: "unusable_route:endpoints" }],
    [['{"code":5001,"msg":"Not found route","data":null}'], "CETUS", { status: "no_route" }],
    [['{"code":4000,"msg":"Depth is too big","data":null}'], "CETUS", { status: "unavailable", reason: "aggregator_4000" }],
  ];
  for (const [answers, provider, expected] of cases) {
    assert.deepEqual(await findCetusRoute({ request, providers: [provider], fee: null, fetch: replay(...answers).fetch }), expected);
  }
});

test("an answer past 4 MiB, an HTTP error, and a stalled API are unavailable, never thrown", async () => {
  const huge = new Response(new ReadableStream({ pull: (controller) => controller.enqueue(new Uint8Array(1024 * 1024)) }));
  assert.deepEqual(await findCetusRoute({ request, providers: ["CETUS"], fee: null, fetch: replay(huge).fetch }), { status: "unavailable", reason: "error" });
  assert.deepEqual(
    await findCetusRoute({ request, providers: ["CETUS"], fee: null, fetch: replay(new Response("", { status: 502 })).fetch }),
    { status: "unavailable", reason: "aggregator_http_502" },
  );
  const stalled = (async (_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof globalThis.fetch;
  assert.deepEqual(await findCetusRoute({ request, providers: ["CETUS"], fee: null, fetch: stalled, timeoutMs: 20 }), { status: "unavailable", reason: "timeout" });
});
