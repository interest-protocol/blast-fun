import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only")
      return { url: "data:text/javascript,export {}", shortCircuit: true };
    return next(specifier, context);
  },
});
const { bondingHeroRead } = await import("./bonding.ts");
const { handleDiscoveryRequest } = await import("@blast/server/modules/launchpad-discovery/resource.ts");
const { discoveryFixtureEngine } = await import("../../../../../packages/server/test/fixtures/modules/launchpad-discovery/fixture-engine.ts");
const { FIXTURE_TIMESTAMP_MS } = await import("../../../../../packages/server/test/fixtures/modules/launchpad-contract/fixtures.ts");

const engine = discoveryFixtureEngine({ state: () => "serving", now: () => FIXTURE_TIMESTAMP_MS });
const A = `0x${"04".repeat(32)}`;
const B = `0x${"03".repeat(32)}`;
/** The featured answer the backend serves for two operator-picked curves. */
const featured = () =>
  handleDiscoveryRequest(new Request("https://blast.test/api/launchpad/discovery?catalog=featured"), engine, async () => [A, B]);

function reads(answer: (path: string, signal: AbortSignal) => Response | Promise<Response>, deadlineMs = 1_000) {
  const seen: { relay: string; url: string; forwarded: string | null }[] = [];
  const relay = (name: string) => async (request: Request) => {
    seen.push({ relay: name, url: request.url, forwarded: request.headers.get("x-vercel-forwarded-for") });
    const url = new URL(request.url);
    return answer(url.pathname + url.search, request.signal);
  };
  const read = bondingHeroRead({
    origin: "https://frontend.test",
    headers: async () => new Headers({ "x-vercel-forwarded-for": "192.0.2.1" }),
    publicRelay: relay("public"),
    privateRelay: relay("private"),
    deadlineMs,
  });
  return { read, seen };
}

test("the Bonding hero reads the featured answer and every slide's details the browser would read", async () => {
  const tagline = { tagline: "Story", cover: { url: "https://cdn.test/a.webp", width: 1536, height: 512 }, links: [] };
  const { read, seen } = reads((path) => {
    if (path.includes("catalog=featured")) return featured();
    if (path.endsWith(A)) return Response.json({ details: tagline });
    return Response.json({ details: null });
  });
  const seed = await read();
  assert.ok(seed);
  assert.deepEqual(seed.details, { [A]: tagline, [B]: null });
  assert.deepEqual(seen.map(({ relay, url }) => [relay, url]), [
    ["public", "https://frontend.test/api/launchpad/discovery?catalog=featured"],
    ["private", `https://frontend.test/api/launchpad/launch-details/${A}`],
    ["private", `https://frontend.test/api/launchpad/launch-details/${B}`],
  ]);
  assert.ok(seen.every(({ forwarded }) => forwarded === "192.0.2.1"));
});

test("a failed details read is left for the browser; a failed featured read seeds nothing", async () => {
  const partial = await reads((path) =>
    path.includes("catalog=featured")
      ? featured()
      : path.endsWith(A)
        ? Response.json({}, { status: 503 })
        : Response.json({ details: { tagline: "", cover: null, links: [] } }),
  ).read();
  assert.deepEqual(Object.keys(partial!.details), [B]);

  const down = reads(() => Response.json({ error: { code: "unavailable" } }, { status: 503 }));
  assert.equal(await down.read(), null);
  assert.equal(down.seen.length, 1);

  // A body that breaks the contract parses to Unavailable, as in the browser, and reads no details.
  const malformed = reads(() => Response.json({ view: "near_graduation" }));
  assert.equal((await malformed.read())?.answer.section.state, "unavailable");
  assert.equal(malformed.seen.length, 1);
});

test("a slow backend leaves the hero to the browser instead of holding the page", { timeout: 5_000 }, async () => {
  // Neither stall answers the abort: the read must keep its own deadline.
  const stalled = () => new Promise<Response>(() => {});
  const stalledBody = () =>
    new Response(new ReadableStream({ start: (controller) => controller.enqueue(new TextEncoder().encode("{")) }));
  const started = Date.now();
  const slowDetails = await reads((path) => (path.includes("catalog=featured") ? featured() : stalled()), 50).read();
  assert.deepEqual(slowDetails?.details, {});
  const slowBody = await reads((path) => (path.includes("catalog=featured") ? featured() : stalledBody()), 50).read();
  assert.deepEqual(slowBody?.details, {});
  assert.equal(await reads(stalled, 50).read(), null);
  assert.equal(await reads(stalledBody, 50).read(), null);
  assert.ok(Date.now() - started < 1_000);
});
