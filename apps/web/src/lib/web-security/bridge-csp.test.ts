import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

import { takeProcessSingleton } from "@blast/core/lib/process-singleton.ts";

import { BRIDGE_CHAINS, bridgeConnectSources, MAYAN_ORIGINS, mayanRpc, readBridgeEnabled } from "#web/components/social/bridge/bridge-config.ts";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: "data:text/javascript,export {}", shortCircuit: true };
    return next(specifier, context);
  },
});

function connectSources(csp: string | null): string[] {
  return csp!.split("; ").find((part) => part.startsWith("connect-src "))!.split(" ").slice(1);
}

test("only the flag set to 1 turns the card on; its sources are Mayan's hosts, RPC included", () => {
  assert.equal(readBridgeEnabled({}), false);
  assert.equal(readBridgeEnabled({ NEXT_PUBLIC_MAYAN_BRIDGE_ENABLED: "true" }), false);
  assert.equal(readBridgeEnabled({ NEXT_PUBLIC_MAYAN_BRIDGE_ENABLED: "1" }), true);
  assert.deepEqual(bridgeConnectSources(false), []);
  assert.deepEqual(bridgeConnectSources(true), [...MAYAN_ORIGINS]);
  assert.ok(MAYAN_ORIGINS.includes("https://front-rpc.mayan.finance"));
  for (const chain of BRIDGE_CHAINS) assert.ok(bridgeConnectSources(true).includes(new URL(mayanRpc(chain)).origin), chain);
});

// Both builders read the process's `webConfig()`, so each case resets it and sets the environment.
for (const enabled of [true, false]) {
  test(`proxy and partner answers carry the bridge sources only with the flag ${enabled ? "on" : "off"}`, async (t) => {
    const prior = { ...process.env };
    Object.assign(process.env, { NEXT_PUBLIC_MAYAN_BRIDGE_ENABLED: enabled ? "1" : "0" });
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
