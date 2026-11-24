import assert from "node:assert/strict";
import test from "node:test";

import type { Provenance, RoutedRead } from "@blast/core/modules/launchpad-contract/read.ts";
import { ContractViolation, parseAtomic } from "@blast/core/modules/launchpad-contract/decimal.ts";
import { parseSection, parseSections, sectionFromRead, type Section } from "@blast/core/modules/launchpad-contract/section.ts";

const PROVENANCE: Provenance = {
  source: "blast-infra",
  network: "mainnet",
  deployment: "5d2f2a4be1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c",
  checkpoint: 326_274_009,
  timestampMs: 1_790_235_061_218,
  observedAt: 1_790_235_061_630,
  lagMs: 412,
};

type Holders = { count: number; supply: string };
const holders = (value: unknown): Holders => {
  const record = value as Record<string, unknown>;
  parseAtomic(record.supply, "supply");
  return { count: record.count as number, supply: record.supply as string };
};

test("a routed read becomes available, stale, empty or unavailable, and only the first two carry data", () => {
  const data: Holders = { count: 3, supply: "100" };
  const isEmpty = (value: Holders) => value.count === 0;
  assert.deepEqual(
    sectionFromRead<Holders>({ status: "fresh", data, provenance: PROVENANCE }, isEmpty),
    { state: "available", data, provenance: PROVENANCE },
  );
  assert.deepEqual(
    sectionFromRead<Holders>({ status: "stale", data, provenance: { ...PROVENANCE, reason: "lagging" } }, isEmpty),
    { state: "stale", data, provenance: { ...PROVENANCE, reason: "lagging" }, reason: "lagging" },
  );
  assert.deepEqual(
    sectionFromRead<Holders>({ status: "fresh", data: { count: 0, supply: "0" }, provenance: PROVENANCE }, isEmpty),
    { state: "empty", provenance: PROVENANCE },
  );
  const down: RoutedRead<Holders> = { status: "unavailable", provenance: { ...PROVENANCE, reason: "not_ready" } };
  assert.deepEqual(sectionFromRead(down, isEmpty), {
    state: "unavailable",
    reason: "not_ready",
    provenance: { ...PROVENANCE, reason: "not_ready" },
  });
});

test("a served section parses only in its own shape: no data on empty or unavailable, no zero fill", () => {
  const available = { state: "available", data: { count: 3, supply: "100" }, provenance: PROVENANCE };
  assert.deepEqual(parseSection(available, holders), available);
  assert.deepEqual(parseSection({ state: "empty", provenance: PROVENANCE }, holders), {
    state: "empty",
    provenance: PROVENANCE,
  });
  assert.deepEqual(parseSection({ state: "unavailable", reason: "not_ready", retryAfterSeconds: 1 }, holders), {
    state: "unavailable",
    reason: "not_ready",
    retryAfterSeconds: 1,
  });
  for (const bad of [
    { state: "empty", provenance: PROVENANCE, data: { count: 0, supply: "0" } },
    { state: "unavailable", reason: "not_ready", data: { count: 0, supply: "0" } },
    { state: "available", provenance: PROVENANCE },
    { state: "stale", data: { count: 3, supply: "100" }, provenance: PROVENANCE },
    { state: "available", data: { count: 3, supply: 100 }, provenance: PROVENANCE },
    { state: "available", data: { count: 3, supply: "100" } },
    { state: "loading" },
    { state: "unavailable", reason: "" },
  ]) {
    assert.throws(() => parseSection(bad, holders), ContractViolation, JSON.stringify(bad));
  }
});

test("holder, social, identity and venue sections stand alone: one broken section breaks no other", () => {
  const body = {
    holders: { state: "available", data: { count: 3, supply: "100" }, provenance: PROVENANCE },
    social: { state: "unavailable", reason: "social-store-unavailable" },
    identity: { state: "empty", provenance: PROVENANCE },
    venue: { state: "available", data: { count: 1, supply: 12 }, provenance: PROVENANCE },
  };
  const sections = parseSections(body, { holders, social: holders, identity: holders, venue: holders });
  assert.equal(sections.holders.state, "available");
  assert.deepEqual(sections.social, { state: "unavailable", reason: "social-store-unavailable" });
  assert.equal(sections.identity.state, "empty");
  const venue: Section<Holders> = sections.venue;
  assert.deepEqual(venue, { state: "unavailable", reason: "contract-violation" });

  const missing = parseSections({ holders: body.holders }, { holders, venue: holders });
  assert.deepEqual(missing.venue, { state: "unavailable", reason: "contract-violation" });
  assert.equal(missing.holders.state, "available");
});
