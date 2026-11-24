import assert from "node:assert/strict";
import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import React from "react";
import ReactDOMServer from "react-dom/server";

import { readPresaleConfig } from "../config.ts";

// Temporary trees resolve package imports from this workspace; the shared
// test loader compiles TSX and resolves their nearby extensionless imports.
const PRESALE = dirname(dirname(fileURLToPath(import.meta.url)));
// `realpathSync`: on macOS `tmpdir()` is a symlink (/var -> /private/var) and a
// module's parent URL is its real path, so the prefix test below needs the real one.
const TREES = realpathSync(mkdtempSync(join(tmpdir(), "presale-slots-")));
const TREES_URL = pathToFileURL(TREES).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { url: "data:text/javascript,export {}", shortCircuit: true };
    const bare = !/^(\.|\/|file:|node:)/.test(specifier);
    if (bare && context.parentURL?.startsWith(TREES_URL)) {
      return nextResolve(specifier, { ...context, parentURL: import.meta.url });
    }
    return nextResolve(specifier, context);
  },
});

after(() => rmSync(TREES, { recursive: true, force: true }));

/** A copy of `src/components/presale` with some slot files replaced, as a later ticket would. */
function presaleTree(replacements: Record<string, string> = {}): string {
  const root = mkdtempSync(join(TREES, "tree-"));
  cpSync(PRESALE, join(root, "presale"), { recursive: true, filter: (path) => !path.endsWith(".test.ts") });
  for (const [path, source] of Object.entries(replacements)) writeFileSync(join(root, "presale", path), source);
  return join(root, "presale");
}

function markerSlot(name: string, slotType: "provider" | "layout"): string {
  return slotType === "provider"
    ? `import type { PresaleSlotProps } from "./slot";
export function ${name}({ children }: PresaleSlotProps) {
  return <div data-slot="${name}">{children}</div>;
}
`
    : `import type { PresaleLayoutSlotProps } from "../providers/slot";
export function ${name}(_props: PresaleLayoutSlotProps) {
  return <div data-slot="${name}" />;
}
`;
}

const PROVIDER_SLOTS = [
  "ConfigProvider",
  "ClientProvider",
  "SdkProvider",
  "WalletProvider",
  "ThemeProvider",
  "SettingsSyncProvider",
];
const BROKEN = readPresaleConfig({
  BLAST_NETWORK: "moonnet",
  NEXT_PUBLIC_PRESALE_EVM_RPC_URLS: "{",
  NEXT_PUBLIC_PRESALE_SWAP_SLIPPAGE_BPS: "-5",
  NEXT_PUBLIC_PRESALE_DEFAULT_THEME: "plaid",
});

async function render(tree: string, child: React.ReactNode, config = BROKEN): Promise<string> {
  const { PresaleShell } = await import(pathToFileURL(join(tree, "layout", "PresaleShell.tsx")).href);
  return ReactDOMServer.renderToStaticMarkup(React.createElement(PresaleShell, { config, nonce: "n".repeat(32) }, child));
}

test("presale pages still render through the stub slots when every feature is unavailable", async () => {
  // The sign-in page is an async server component (it reads `next`), so it is
  // resolved before rendering.
  const signIn = { searchParams: Promise.resolve({ next: "/crew/kai" }) };
  const { SignInCard } = await import(new URL("../../sign-in/SignIn.tsx", import.meta.url).href);
  const signInCard = ReactDOMServer.renderToStaticMarkup(React.createElement(SignInCard, { returnTo: "/crew/kai" }));
  assert.match(signInCard, /Sign-in is not available right now\./);
  const pages = [
    // Social UI-09: an async server component (it reads `searchParams` while the feed is on).
    ["../../../app/(app)/presale/(sales)/page.tsx", '<main><header class="phead" data-page-head=""><div><h1>Presales</h1></div></header></main>', { searchParams: Promise.resolve({}) }],
    [
      "../../../app/(app)/sign-in/page.tsx",
      // Social UI-08: the sign-in sheet's card, as `SignInCard` renders it without a Privy session.
      `<main><h1 class="sr">Sign in</h1>${signInCard}</main>`,
      signIn,
    ],
    ["../../../app/(app)/settings/page.tsx", '<main><header class="phead" data-page-head=""><div><h1>Settings</h1></div></header></main>'],
  ] as const;
  for (const [path, markup, props] of pages) {
    const { default: Page } = await import(new URL(path, import.meta.url).href);
    // Server pages may be async (they read the request's launch flags), so call them and await
    // the element; a sync page returns its element directly.
    const page = await Page(props ?? {});
    assert.equal(await render(PRESALE, page), markup, path);
  }
});

test("the retired new-allowlist page redirects to Create", async () => {
  const { default: Page } = await import("../../../app/presale/(tools)/allowlists/new/page.tsx");
  assert.throws(() => Page(), { digest: "NEXT_REDIRECT;replace;/create;307;" });
});

test("the provider root passes public settings without RPC URL paths or queries", async () => {
  const tree = presaleTree({
    "Probe.tsx": `"use client";
import { usePresaleConfig } from "./providers/ConfigProvider";
export function Probe() {
  const config = usePresaleConfig();
  return <p>{config.network.status}:{String(config.bridge.enabled)}:{Object.keys(config.bridge).join(",")}</p>;
}
`,
  });
  const { Probe } = await import(pathToFileURL(join(tree, "Probe.tsx")).href);
  const config = readPresaleConfig({
    NEXT_PUBLIC_PRESALE_BRIDGE_ENABLED: "1",
    NEXT_PUBLIC_PRESALE_SOLANA_RPC_URL: "https://solana.rpc.test/example-path",
    NEXT_PUBLIC_PRESALE_EVM_RPC_URLS: JSON.stringify({ base: "https://base.rpc.test/?token=example-query" }),
  });
  assert.equal(await render(tree, React.createElement(Probe), config), "<p>unavailable:true:enabled</p>");
  assert.equal(
    await render(tree, React.createElement(Probe), { ...config, bridge: { ...config.bridge, enabled: false } }),
    "<p>unavailable:false:enabled</p>",
  );
});

test("the provider root composes the six slots in their fixed order", async () => {
  const tree = presaleTree(
    Object.fromEntries(PROVIDER_SLOTS.map((name) => [`providers/${name}.tsx`, markerSlot(name, "provider")])),
  );
  const nested = PROVIDER_SLOTS.reduceRight((inner, name) => `<div data-slot="${name}">${inner}</div>`, "<p>page</p>");
  assert.equal(await render(tree, React.createElement("p", null, "page")), nested);
});

test("replacing one provider stub needs no edit to the root", async () => {
  // presaleTree copies PresaleProviders.tsx and PresaleShell.tsx unchanged.
  const tree = presaleTree({ "providers/ClientProvider.tsx": markerSlot("ClientProvider", "provider") });
  assert.equal(
    await render(tree, React.createElement("p", null, "page")),
    '<div data-slot="ClientProvider"><p>page</p></div>',
  );
});

test("the presale layout renders both layout slots before the page", async () => {
  const tree = presaleTree({
    "layout/HeadSlot.tsx": markerSlot("HeadSlot", "layout"),
    "layout/HeaderSlot.tsx": markerSlot("HeaderSlot", "layout"),
  });
  assert.equal(
    await render(tree, React.createElement("p", null, "page")),
    '<div data-slot="HeadSlot"></div><div data-slot="HeaderSlot"></div><p>page</p>',
  );
});
