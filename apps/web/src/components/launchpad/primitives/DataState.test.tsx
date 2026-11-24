import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { SectionState } from "./data-state";
import { DataState } from "./DataState";

const provenance = {
  network: "mainnet",
  deployment: "0x5b1a0c9e4f7d2a36b8c1e0f9a7d6c5b4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8",
  checkpoint: "182734455",
  observedAt: "2026-09-30T14:02:11.000Z",
  lagMs: 2400,
} as const;

function render(state: SectionState<number>) {
  return renderToStaticMarkup(
    <DataState state={state} subject="holders">
      {(count) => <p>Holders: {count}</p>}
    </DataState>,
  );
}

function text(html: string) {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

test("loading names its operation, is busy, and shows no facts", () => {
  const html = render({ status: "loading" });
  assert.match(html, /data-state="loading"/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /role="status"/);
  assert.equal(text(html), "Loading Fetching holders…");
  assert.doesNotMatch(html, /Holders:/);
});

test("empty says so and offers the next action instead of a zero", () => {
  const html = renderToStaticMarkup(
    <DataState state={{ status: "empty" }} subject="holders" empty="No one holds this coin yet." action={<a href="/launch">Launch a coin</a>}>
      {() => <p>Holders: 0</p>}
    </DataState>,
  );
  assert.match(html, /data-state="empty"/);
  assert.equal(text(html), "Empty No one holds this coin yet. Launch a coin");
  assert.doesNotMatch(html, /Holders: 0/);
});

test("unavailable explains how to recover without publishing the service error", () => {
  const html = render({ status: "unavailable", reason: "The holder index did not respond" });
  assert.match(html, /data-state="unavailable"/);
  assert.equal(
    text(html),
    "Unavailable Holders couldn’t load. Reload the page to try again.",
  );
  assert.doesNotMatch(html, /Holders:/);
});

test("delayed data keeps the last verified facts", () => {
  const html = render({ status: "stale", value: 1284, provenance, reason: "Not refreshed for more than 30 s" });
  assert.match(html, /data-state="stale"/);
  const content = text(html);
  assert.match(content, /^Delayed Holders may be out of date\. /);
  assert.match(content, /Holders: 1284/);
  assert.doesNotMatch(content, /Checkpoint|182,734,455|Not refreshed/);
});

test("ready shows facts without a state label", () => {
  const html = render({ status: "ready", value: 1284, provenance });
  assert.match(html, /data-state="ready"/);
  assert.doesNotMatch(html, /role="status"/);
  const content = text(html);
  assert.equal(content, "Holders: 1284");
  for (const label of ["Loading", "Empty", "Unavailable", "Stale"]) {
    assert.doesNotMatch(content, new RegExp(label));
  }
});
