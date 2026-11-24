import assert from "node:assert/strict";
import test from "node:test";

import {
  PRESALE_CONFIG_VARIABLES,
  readPresaleConfig,
  type PresaleConfig,
  type PresaleConfigVariable,
} from "./config.ts";

const VALID = {
  BLAST_PRESALE_ENABLED: "true",
  BLAST_NETWORK: "mainnet",
  NEXT_PUBLIC_PRESALE_BRIDGE_ENABLED: "1",
  NEXT_PUBLIC_PRESALE_SOLANA_RPC_URL: "https://solana.rpc.test/key",
  NEXT_PUBLIC_PRESALE_EVM_RPC_URLS: JSON.stringify({
    base: "https://base.rpc.test/v2/key",
    arbitrum: "https://arb.rpc.test",
    ethereum: "https://eth.rpc.test",
  }),
  NEXT_PUBLIC_PRESALE_SWAP_PROVIDERS: "CETUS, AFTERMATH",
  NEXT_PUBLIC_PRESALE_SWAP_SLIPPAGE_BPS: "75",
  NEXT_PUBLIC_PRESALE_GAS_RESERVE_MIST: "60000000",
  NEXT_PUBLIC_PRESALE_DEFAULT_THEME: "dark",
  NEXT_PUBLIC_PRESALE_APPLY_URL: "https://apply.blast.test/form",
  NEXT_PUBLIC_PRESALE_NOTIFY_URL: "https://notify.blast.test",
  NEXT_PUBLIC_PRESALE_BUY_SUI_URL: "https://buy.blast.test",
  PRIVY_APP_ID: "privy-app",
} satisfies Record<PresaleConfigVariable, string>;

const BASELINE: PresaleConfig = {
  enabled: true,
  network: { status: "available", value: "mainnet" },
  bridge: {
    enabled: true,
    solanaRpcUrl: { status: "available", value: "https://solana.rpc.test/key" },
    evmRpcUrls: {
      status: "available",
      value: { base: "https://base.rpc.test/v2/key", arbitrum: "https://arb.rpc.test/", ethereum: "https://eth.rpc.test/" },
    },
  },
  swap: {
    providers: { status: "available", value: ["CETUS", "AFTERMATH"] },
    slippageBps: { status: "available", value: 75 },
  },
  gasReserveMist: { status: "available", value: "60000000" },
  defaultTheme: { status: "available", value: "dark" },
  links: {
    apply: { status: "available", value: "https://apply.blast.test/form" },
    notify: { status: "available", value: "https://notify.blast.test/" },
    buySui: { status: "available", value: "https://buy.blast.test/" },
  },
  privyAppId: { status: "available", value: "privy-app" },
};

/** The baseline with one setting, at a dotted path, replaced. */
function baselineWith(path: string, value: unknown): PresaleConfig {
  const copy = structuredClone(BASELINE) as Record<string, unknown>;
  const keys = path.split(".");
  let target = copy;
  for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
  target[keys.at(-1)!] = value;
  return copy as PresaleConfig;
}

test("a complete environment validates into the typed configuration", () => {
  assert.deepEqual(readPresaleConfig(VALID), BASELINE);
});

test("each invalid value makes only its own feature unavailable", () => {
  const cases: [PresaleConfigVariable, string, string][] = [
    ["BLAST_NETWORK", "testnet", "network"],
    ["BLAST_NETWORK", "moonnet", "network"],
    ["NEXT_PUBLIC_PRESALE_SOLANA_RPC_URL", "ftp://solana.rpc.test", "bridge.solanaRpcUrl"],
    ["NEXT_PUBLIC_PRESALE_SOLANA_RPC_URL", "https://*.rpc.test", "bridge.solanaRpcUrl"],
    ["NEXT_PUBLIC_PRESALE_SOLANA_RPC_URL", "http://localhost:8899", "bridge.solanaRpcUrl"],
    ["NEXT_PUBLIC_PRESALE_EVM_RPC_URLS", "{bad", "bridge.evmRpcUrls"],
    ["NEXT_PUBLIC_PRESALE_EVM_RPC_URLS", "{}", "bridge.evmRpcUrls"],
    ["NEXT_PUBLIC_PRESALE_EVM_RPC_URLS", JSON.stringify({ polygon: "https://p.rpc.test" }), "bridge.evmRpcUrls"],
    ["NEXT_PUBLIC_PRESALE_EVM_RPC_URLS", JSON.stringify({ base: "http://base.rpc.test" }), "bridge.evmRpcUrls"],
    ["NEXT_PUBLIC_PRESALE_EVM_RPC_URLS", JSON.stringify({ base: "http://127.0.0.1:8545" }), "bridge.evmRpcUrls"],
    ["NEXT_PUBLIC_PRESALE_EVM_RPC_URLS", JSON.stringify({ base: 7 }), "bridge.evmRpcUrls"],
    ["NEXT_PUBLIC_PRESALE_SWAP_PROVIDERS", "cetus", "swap.providers"],
    ["NEXT_PUBLIC_PRESALE_SWAP_PROVIDERS", "CETUS,,", "swap.providers"],
    ["NEXT_PUBLIC_PRESALE_SWAP_SLIPPAGE_BPS", "0", "swap.slippageBps"],
    ["NEXT_PUBLIC_PRESALE_SWAP_SLIPPAGE_BPS", "10001", "swap.slippageBps"],
    ["NEXT_PUBLIC_PRESALE_SWAP_SLIPPAGE_BPS", "1.5", "swap.slippageBps"],
    ["NEXT_PUBLIC_PRESALE_GAS_RESERVE_MIST", "-1", "gasReserveMist"],
    ["NEXT_PUBLIC_PRESALE_GAS_RESERVE_MIST", "18446744073709551616", "gasReserveMist"],
    ["NEXT_PUBLIC_PRESALE_DEFAULT_THEME", "blue", "defaultTheme"],
    ["NEXT_PUBLIC_PRESALE_APPLY_URL", "javascript:alert(1)", "links.apply"],
    ["NEXT_PUBLIC_PRESALE_NOTIFY_URL", "http://notify.blast.test", "links.notify"],
    ["NEXT_PUBLIC_PRESALE_APPLY_URL", "http://localhost", "links.apply"],
    ["NEXT_PUBLIC_PRESALE_BUY_SUI_URL", "https://buy.blast.test/#x", "links.buySui"],
  ];
  for (const [variable, value, path] of cases) {
    assert.deepEqual(
      readPresaleConfig({ ...VALID, [variable]: value }),
      baselineWith(path, { status: "unavailable", variable, reason: "invalid" }),
      `${variable}=${value}`,
    );
  }
});

test("missing values disable their feature or fall back to the documented default", () => {
  const config = readPresaleConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.bridge.enabled, false);
  for (const [setting, variable] of [
    [config.network, "BLAST_NETWORK"],
    [config.bridge.solanaRpcUrl, "NEXT_PUBLIC_PRESALE_SOLANA_RPC_URL"],
    [config.bridge.evmRpcUrls, "NEXT_PUBLIC_PRESALE_EVM_RPC_URLS"],
    [config.links.apply, "NEXT_PUBLIC_PRESALE_APPLY_URL"],
    [config.links.notify, "NEXT_PUBLIC_PRESALE_NOTIFY_URL"],
    [config.links.buySui, "NEXT_PUBLIC_PRESALE_BUY_SUI_URL"],
    [config.privyAppId, "PRIVY_APP_ID"],
  ] as const) {
    assert.deepEqual(setting, { status: "unavailable", variable, reason: "missing" }, variable);
  }
  assert.deepEqual(config.swap.providers, { status: "available", value: ["CETUS"] });
  assert.deepEqual(config.swap.slippageBps, { status: "available", value: 50 });
  assert.deepEqual(config.gasReserveMist, { status: "available", value: "50000000" });
  assert.deepEqual(config.defaultTheme, { status: "available", value: "system" });
});

test("the flags open only on their exact values", () => {
  for (const value of ["TRUE", "1", "yes", " true"]) {
    assert.equal(readPresaleConfig({ BLAST_PRESALE_ENABLED: value }).enabled, false, value);
  }
  for (const value of ["true", "yes", "0"]) {
    assert.equal(readPresaleConfig({ NEXT_PUBLIC_PRESALE_BRIDGE_ENABLED: value }).bridge.enabled, false, value);
  }
});

test("the presale configuration never names blast-infra: the browser does not reach it", () => {
  const config = readPresaleConfig({ ...VALID, BLAST_INFRA_ORIGIN: "https://infra.blast.test", NEXT_PUBLIC_BLAST_INFRA_ORIGIN: "https://infra.blast.test" });
  assert.equal("infra" in config, false);
  assert.doesNotMatch(JSON.stringify(config, (_, value) => (typeof value === "bigint" ? String(value) : value)), /infra\.blast\.test/);
  assert.equal("NEXT_PUBLIC_BLAST_INFRA_ORIGIN" in PRESALE_CONFIG_VARIABLES, false);
});

test("garbage never throws", () => {
  const garbage = ["", " ", "null", "{}", "[]", "\u0000", "http://", "https://", "0x", "999999999999999999999999"];
  for (const value of garbage) {
    const environment = Object.fromEntries(Object.keys(PRESALE_CONFIG_VARIABLES).map((name) => [name, value]));
    assert.doesNotThrow(() => readPresaleConfig(environment), JSON.stringify(value));
  }
});

test("no secret uses a NEXT_PUBLIC_ name, and the reader reads only declared names and no secret", () => {
  for (const [name, { scope, secret }] of Object.entries(PRESALE_CONFIG_VARIABLES)) {
    const looksSecret = /SECRET|PRIVATE|PASSWORD|TOKEN|API_KEY|_KEY$/.test(name);
    if (secret || looksSecret) assert.equal(scope, "server", `${name} holds a secret`);
    assert.equal(name.startsWith("NEXT_PUBLIC_"), scope === "public", `${name} is ${scope}`);
  }
  const read = new Set<string>();
  readPresaleConfig(
    new Proxy({ ...VALID }, {
      get(target, name) {
        read.add(String(name));
        return Reflect.get(target, name);
      },
    }),
  );
  assert.deepEqual([...read].sort(), Object.keys(PRESALE_CONFIG_VARIABLES).sort());
  const secrets = Object.entries(PRESALE_CONFIG_VARIABLES).filter(([, { secret }]) => secret).map(([name]) => name);
  assert.deepEqual([...read].filter((name) => secrets.includes(name)), []);
});
