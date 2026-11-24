import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("", { url: "https://blast.test/" });
Object.assign(globalThis, { window: dom.window });
const { createDiscoveryPreview, discoveryPreviewKey } = await import("./discovery-preview");

const coin = (symbol: string, digit: string) => ({ coin_type: `0x${digit.repeat(64)}::coin::${symbol}`, presale_id: null, symbol, icon_url: null, lifecycle: "migrated" as const });

test("the collapsed rail's shortcuts outlive a reload: an owner's last marks are cached and drawn at once (audit 04)", () => {
  const key = discoveryPreviewKey({ kind: "account", account_id: "acct-1" });
  assert.equal(key, "blast.discovery-preview.acct-1");
  assert.equal(discoveryPreviewKey({ kind: "guest" }), "blast.discovery-preview.guest");
  const first = createDiscoveryPreview(key);
  first.remember("scope-a", [coin("KSTL", "a"), coin("LUMN", "b")]);
  // A new workspace lifetime (re-entry or reload) starts from the cache, before Discover mounts.
  const next = createDiscoveryPreview(key);
  assert.equal(next.getSnapshot().scope, "scope-a");
  assert.deepEqual(next.getSnapshot().coins.map((one) => one.symbol), ["KSTL", "LUMN"]);
  // Clearing the visible list keeps the cache for the next lifetime; another owner starts empty.
  next.clear();
  assert.deepEqual(createDiscoveryPreview(key).getSnapshot().coins.map((one) => one.symbol), ["KSTL", "LUMN"]);
  assert.deepEqual(createDiscoveryPreview(discoveryPreviewKey({ kind: "guest" })).getSnapshot().coins, []);
  // Without a key the preview stays in memory, as before.
  assert.deepEqual(createDiscoveryPreview().getSnapshot().coins, []);
});
