import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

import { SOCIAL_HAPPENING_DISCOVER_PATH } from "@blast/core/modules/social/contracts/happening.ts";

const requests: string[] = [];
let homeSections: string;
let holdPosts: Promise<void> | null = null;
let holdMarket: Promise<void> | null = null;
let holdActivity: Promise<void> | null = null;
const fixture = "blast.test.homeRequest";
const state = { requests, sections: () => homeSections, holdPosts: () => holdPosts, holdMarket: () => holdMarket, holdActivity: () => holdActivity };

function localModule(source: string) {
  return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` };
}

test("Home starts visible reads, uses the 24-hour leaderboard, and can render while posts are pending", async () => {
  Object.defineProperty(globalThis, fixture, { value: state, configurable: true });
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "next/headers") {
        return localModule(`export async function headers() { return new Headers(); }
        export async function cookies() {
          return { get: (name) => name === "blast.home" ? { value: globalThis[${JSON.stringify(fixture)}].sections() } : undefined };
        }`);
      }
      if (specifier === "next/server" && context.parentURL?.includes("/(social)/feed/")) {
        return localModule("export async function connection() {}");
      }
      if (specifier === "#web/lib/backend-api/bonding.ts") {
        return localModule("export async function readBondingHeroFromBackend() { return null; }");
      }
      if (specifier === "#web/lib/launch-flags.server.ts") {
        return localModule("export async function requestLaunchFlags() { return { trading: false }; }");
      }
      if (specifier === "./private-page-read.ts" && context.parentURL?.endsWith("/social-reads.ts")) {
        return localModule(`export async function readPrivateBackendPage(path) {
          const state = globalThis[${JSON.stringify(fixture)}];
          state.requests.push(path);
          if (path === "/api/social/feed") await state.holdPosts();
          if (path.startsWith("/api/social/happening?")) await state.holdActivity();
          if (path.startsWith("/api/social/home?")) {
            await state.holdMarket();
            return Response.json({ coins: [{ name: "Ready coin", quote: { type: "0x2::sui::SUI" } }] });
          }
          return new Response(null, { status: 404 });
        }`);
      }
      if (specifier === "#web/lib/backend-api/presales.ts") {
        return localModule("export async function readFeaturedPresalesFromBackend() { return []; }");
      }
      return next(specifier, context);
    },
  });

  try {
    const { default: Home } = await import("./page.tsx");
    const searchParams = Promise.resolve({ w: "1h" });
    homeSections = "-coins.-presales.-posts.traders";
    await Home({ searchParams });
    assert.deepEqual(requests.splice(0), ["/api/social/home/traders?window=24h&page=1&limit=5"]);

    homeSections = "-coins.presales.-posts.-traders";
    await Home({ searchParams });
    assert.deepEqual(requests.splice(0), [SOCIAL_HAPPENING_DISCOVER_PATH]);

    homeSections = "coins.-presales.-posts.-traders";
    const market = Promise.withResolvers<void>();
    const activity = Promise.withResolvers<void>();
    holdMarket = market.promise;
    holdActivity = activity.promise;
    const mixed = Home({ searchParams: Promise.resolve({}) });
    try {
      const shell = await Promise.race([
        mixed,
        new Promise<null>((resolve) => setImmediate(() => resolve(null))),
      ]);
      assert.ok(shell, "Home can return its shell before market and activity resolve");
      assert.equal(requests.some((path) => path.startsWith("/api/social/home?")), true);
      assert.equal(requests.includes(SOCIAL_HAPPENING_DISCOVER_PATH), true);
      assert.ok(shell.props.initial instanceof Promise, "the shell streams before the market is ready");
      market.resolve();
      await shell.props.initial;
      activity.resolve();
      const seed = await shell.props.mixedInitial;
      assert.equal(seed.market.coins[0].name, "Ready coin", "market rows that arrive before activity can render on the server");
    } finally {
      market.resolve();
      activity.resolve();
      holdMarket = null;
      holdActivity = null;
    }
    requests.length = 0;

    homeSections = "-coins.-presales.posts.-traders";
    const pending = Promise.withResolvers<void>();
    holdPosts = pending.promise;
    const page = Home({ searchParams });
    try {
      const painted = await Promise.race([
        page.then(() => true),
        new Promise<false>((resolve) => setImmediate(() => resolve(false))),
      ]);
      assert.deepEqual(requests, ["/api/social/feed"]);
      assert.equal(painted, true, "Home can return its shell before Posts resolves");
    } finally {
      pending.resolve();
      await page;
    }
  } finally {
    hooks.deregister();
    Reflect.deleteProperty(globalThis, fixture);
  }
});
