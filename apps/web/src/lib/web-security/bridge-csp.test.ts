import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

import { takeProcessSingleton } from "@blast/core/lib/process-singleton.ts";

import { readPresaleConfig } from "#web/components/presale/config.ts";
import { bridgeConnectSources, MAYAN_ORIGINS, readBridgeConfig } from "#web/components/social/bridge/bridge-config.ts";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: "data:text/javascript,export {}", shortCircuit: true };
    return next(specifier, context);
  },
});

const RPCS = {
  NEXT_PUBLIC_PRESALE_SOLANA_RPC_URL: "https://solana.rpc.test/key",
  NEXT_PUBLIC_PRESALE_EVM_RPC_URLS: JSON.stringify({ base: "https://base.rpc.test/v2/key", ethereum: "https://eth.rpc.test" }),
};
const BRIDGE_SOURCES = [...MAYAN_ORIGINS, "https://base.rpc.test", "https://eth.rpc.test", "https://solana.rpc.test"];

function connectSources(csp: string | null): string[] {
  return csp!.split("; ").find((part) => part.startsWith("connect-src "))!.split(" ").slice(1);
}

function bridge(environment: Record<string, string>) {
  return readBridgeConfig(environment, readPresaleConfig(environment));
}

test("the flag and at least one source RPC turn the card on; its sources are Mayan and those RPCs", () => {
  assert.equal(bridge(RPCS), null);
  assert.equal(bridge({ ...RPCS, NEXT_PUBLIC_MAYAN_BRIDGE_ENABLED: "true" }), null);
  assert.equal(bridge({ NEXT_PUBLIC_MAYAN_BRIDGE_ENABLED: "1" }), null, "no RPC: no chain to bridge from");
  const on = bridge({ ...RPCS, NEXT_PUBLIC_MAYAN_BRIDGE_ENABLED: "1" });
  assert.deepEqual(on, { rpcs: { base: "https://base.rpc.test/v2/key", ethereum: "https://eth.rpc.test/", solana: "https://solana.rpc.test/key" } });
  assert.deepEqual(bridgeConnectSources(on), BRIDGE_SOURCES);
  assert.deepEqual(bridgeConnectSources(null), []);
  // A wildcard RPC is refused by configuration, so it never reaches the policy.
  assert.equal(bridge({ NEXT_PUBLIC_MAYAN_BRIDGE_ENABLED: "1", NEXT_PUBLIC_PRESALE_SOLANA_RPC_URL: "https://*.rpc.test" }), null);
});

// Both builders read the process's `webConfig()`, so each case resets it and sets the environment.
for (const enabled of [true, false]) {
  test(`proxy and partner answers carry the bridge sources only with the flag ${enabled ? "on" : "off"}`, async (t) => {
    const prior = { ...process.env };
    Object.assign(process.env, RPCS, { NEXT_PUBLIC_MAYAN_BRIDGE_ENABLED: enabled ? "1" : "0" });
    takeProcessSingleton("webConfig");
    t.after(() => {
      for (const name of Object.keys(process.env)) if (!(name in prior)) delete process.env[name];
      Object.assign(process.env, prior);
      takeProcessSingleton("webConfig");
    });
    const { NextRequest } = await import("next/server");
    const { proxy } = await import("#web/proxy.ts");
    const { applyPartnerBrowserHeaders } = await import("#web/lib/web-security/partner-response.ts");
    const page = await proxy(new NextRequest("https://www.blast.fun/portfolio"));
    const partner = applyPartnerBrowserHeaders(new Response(null), new Headers(), false);
    for (const [name, csp] of [["proxy", page.headers.get("content-security-policy")], ["partner", partner.headers.get("content-security-policy")]] as const) {
      const sources = connectSources(csp);
      for (const source of MAYAN_ORIGINS) assert.equal(sources.includes(source), enabled, `${name} ${source}`);
    }
  });
}
