import assert from "node:assert/strict";
import test from "node:test";
import { coinTypeIdentity, createPanelIdentities, panelIdentityLabel, panelSymbol } from "./panel-identities";
import { createWorkspaceStore } from "./model";

test("identity metadata stays isolated by network and same-symbol types remain distinguishable", () => {
  const registry = createPanelIdentities();
  registry.report("0x2::first::SAME", { symbol: "MAIN", name: null, icon: null }, "mainnet");
  registry.report("0x2::first::SAME", { symbol: "TEST", name: null, icon: null }, "testnet");
  assert.equal(registry.get("0x02::first::SAME", "mainnet")?.symbol, "MAIN");
  assert.equal(registry.get("0x2::first::SAME", "testnet")?.symbol, "TEST");
  const store = createWorkspaceStore();
  for (const id of ["first", "second"]) store.add({ panel_id: id, chain: "sui", network: "mainnet", coin_type: `0x2::${id}::SAME`, presale_id: null });
  assert.notEqual(panelIdentityLabel(store.getSnapshot().panels.first!), panelIdentityLabel(store.getSnapshot().panels.second!));
});

test("before any read, an ecosystem coin shows its curated identity and any other coin its struct name", () => {
  const hashi = "0xd30fb3f8914efdbeb7b8e85fae1d65dc584b44a1281f66737b92bb9f03a59d06::btc::BTC";
  assert.deepEqual(coinTypeIdentity(hashi), { symbol: "hashiBTC", name: "Hashi BTC", icon: "https://statics.noodles.fi/logo/7821410237963526456" });
  // suiWBTC shares the struct name `BTC`; each keeps its own curated symbol.
  assert.equal(coinTypeIdentity("0xaafb102dd0902f5055cadecd687fb5b71ca82ef0e0285d90afde828ec58ca96b::btc::BTC").symbol, "suiWBTC");
  assert.deepEqual(coinTypeIdentity("0x2::meme::MEME"), { symbol: "MEME", name: null, icon: null });
  const store = createWorkspaceStore();
  store.add({ panel_id: "hashi", chain: "sui", network: "mainnet", coin_type: hashi, presale_id: null });
  assert.equal(panelSymbol(store.getSnapshot().panels.hashi!, null), "hashiBTC");
  assert.equal(panelSymbol(store.getSnapshot().panels.hashi!, createPanelIdentities()), "hashiBTC");
});
